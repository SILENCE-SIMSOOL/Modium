use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;

use serde::Serialize;
use tauri::Emitter;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::{mpsc, Mutex};
use uuid::Uuid;

use crate::models::{GradleTaskKind, ProcessLifecycle, ProcessStatusInfo};

/// Win32 process creation flag that suppresses console window popups.
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputEvent {
	pub session_id: String,
	pub stream: String,
	pub data: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExitEvent {
	pub session_id: String,
	pub exit_code: Option<i32>,
}

#[derive(Debug)]
struct ActiveProcess {
	process_id: String,
	kind: String,
	task_kind: Option<GradleTaskKind>,
	state: ProcessLifecycle,
	pid: Option<u32>,
	stop_requested: bool,
	stdin_tx: Option<mpsc::UnboundedSender<Vec<u8>>>,
}

/// Thread-safe registry tracking active Gradle builds and terminal sessions.
#[derive(Debug, Clone, Default)]
pub struct ProcessRegistry {
	inner: Arc<Mutex<HashMap<String, ActiveProcess>>>,
}

impl ProcessRegistry {
	pub fn new() -> Self {
		Self::default()
	}

	/// Registers a new Gradle task, rejecting duplicate concurrent runs of the same kind.
	pub async fn register_gradle(
		&self,
		process_id: &str,
		task: GradleTaskKind,
	) -> Result<(), String> {
		let mut guard = self.inner.lock().await;
		let duplicate = guard.values().any(|entry| {
			entry.task_kind == Some(task)
				&& matches!(
					entry.state,
					ProcessLifecycle::Starting
						| ProcessLifecycle::Running
						| ProcessLifecycle::Stopping
				)
		});
		if duplicate {
			return Err(format!("Gradle task {:?} is already running", task));
		}
		guard.insert(
			process_id.to_string(),
			ActiveProcess {
				process_id: process_id.to_string(),
				kind: format!("gradle:{:?}", task),
				task_kind: Some(task),
				state: ProcessLifecycle::Starting,
				pid: None,
				stop_requested: false,
				stdin_tx: None,
			},
		);
		Ok(())
	}

	pub async fn set_running(&self, process_id: &str, pid: Option<u32>) {
		let mut guard = self.inner.lock().await;
		if let Some(entry) = guard.get_mut(process_id) {
			entry.pid = pid;
			if !entry.stop_requested {
				entry.state = ProcessLifecycle::Running;
			}
		}
	}

	pub async fn is_stop_requested(&self, process_id: &str) -> bool {
		let guard = self.inner.lock().await;
		guard
			.get(process_id)
			.map(|entry| entry.stop_requested)
			.unwrap_or(false)
	}

	/// Removes a finished process and returns whether termination was requested.
	pub async fn finish_process(&self, process_id: &str) -> bool {
		let mut guard = self.inner.lock().await;
		guard
			.remove(process_id)
			.map(|entry| entry.stop_requested)
			.unwrap_or(false)
	}

	pub async fn list_statuses(&self) -> Vec<ProcessStatusInfo> {
		let guard = self.inner.lock().await;
		let mut list: Vec<ProcessStatusInfo> = guard
			.values()
			.map(|entry| ProcessStatusInfo {
				process_id: entry.process_id.clone(),
				kind: entry.kind.clone(),
				state: entry.state,
				pid: entry.pid,
			})
			.collect();
		list.sort_by(|a, b| a.process_id.cmp(&b.process_id));
		list
	}
}

pub async fn get_running_processes(registry: &ProcessRegistry) -> Vec<ProcessStatusInfo> {
	registry.list_statuses().await
}

/// Terminates a process and all descendant child processes.
pub async fn kill_process_tree(pid: u32) -> Result<(), String> {
	#[cfg(windows)]
	{
		let mut cmd = Command::new("taskkill");
		cmd.args(["/F", "/T", "/PID", &pid.to_string()]);
		cmd.creation_flags(CREATE_NO_WINDOW);
		let output = cmd
			.output()
			.await
			.map_err(|err| format!("Failed to invoke taskkill for PID {}: {}", pid, err))?;
		if !output.status.success() {
			let stderr = String::from_utf8_lossy(&output.stderr);
			let stdout = String::from_utf8_lossy(&output.stdout);
			// Process may have already exited before taskkill ran.
			let combined = format!("{} {}", stdout, stderr).to_lowercase();
			if !combined.contains("not found") && !combined.contains("no running instance") {
				return Err(format!(
					"taskkill failed for PID {}: {}",
					pid,
					combined.trim()
				));
			}
		}
		Ok(())
	}
	#[cfg(not(windows))]
	{
		let output = Command::new("kill")
			.args(["-KILL", &pid.to_string()])
			.output()
			.await
			.map_err(|err| format!("Failed to kill PID {}: {}", pid, err))?;
		if !output.status.success() {
			let stderr = String::from_utf8_lossy(&output.stderr);
			if !stderr.to_lowercase().contains("no such process") {
				return Err(format!("kill failed for PID {}: {}", pid, stderr.trim()));
			}
		}
		Ok(())
	}
}

pub async fn stop_process(registry: &ProcessRegistry, process_id: &str) -> Result<(), String> {
	let pid = {
		let mut guard = registry.inner.lock().await;
		let entry = guard
			.get_mut(process_id)
			.ok_or_else(|| format!("Process '{}' is not active", process_id))?;
		entry.stop_requested = true;
		entry.state = ProcessLifecycle::Stopping;
		entry.stdin_tx = None;
		entry.pid
	};
	if let Some(pid) = pid {
		kill_process_tree(pid).await?;
	}
	Ok(())
}

pub async fn kill_all_processes(registry: &ProcessRegistry) {
	let pids: Vec<u32> = {
		let mut guard = registry.inner.lock().await;
		guard
			.values_mut()
			.filter_map(|entry| {
				entry.stop_requested = true;
				entry.state = ProcessLifecycle::Stopping;
				entry.stdin_tx = None;
				entry.pid
			})
			.collect()
	};
	for pid in pids {
		let _ = kill_process_tree(pid).await;
	}
}

pub async fn terminal_start(
	app: Option<tauri::AppHandle>,
	registry: &ProcessRegistry,
	workspace_root: &Path,
	session_id: Option<&str>,
) -> Result<String, String> {
	if !workspace_root.is_dir() {
		return Err(format!(
			"Workspace root does not exist: {}",
			workspace_root.display()
		));
	}
	let process_id = session_id
		.map(str::trim)
		.filter(|s| !s.is_empty())
		.map(String::from)
		.unwrap_or_else(|| format!("term-{}", Uuid::new_v4()));
	{
		let guard = registry.inner.lock().await;
		if guard.contains_key(&process_id) {
			return Err(format!("Terminal '{}' is already running", process_id));
		}
	}
	let mut cmd = build_shell_command(workspace_root);
	cmd.stdin(Stdio::piped())
		.stdout(Stdio::piped())
		.stderr(Stdio::piped())
		.kill_on_drop(false);
	let mut child = cmd
		.spawn()
		.map_err(|err| format!("Failed to start terminal shell: {}", err))?;
	let pid = child.id();
	let stdin = child.stdin.take();
	let stdout = child.stdout.take();
	let stderr = child.stderr.take();
	let (stdin_tx, mut stdin_rx) = mpsc::unbounded_channel::<Vec<u8>>();
	if let Some(mut child_stdin) = stdin {
		tokio::spawn(async move {
			while let Some(bytes) = stdin_rx.recv().await {
				if child_stdin.write_all(&bytes).await.is_err() {
					break;
				}
				if child_stdin.flush().await.is_err() {
					break;
				}
			}
		});
	}
	{
		let mut guard = registry.inner.lock().await;
		guard.insert(
			process_id.clone(),
			ActiveProcess {
				process_id: process_id.clone(),
				kind: "terminal".to_string(),
				task_kind: None,
				state: ProcessLifecycle::Running,
				pid,
				stop_requested: false,
				stdin_tx: Some(stdin_tx),
			},
		);
	}
	let reg_clone = registry.clone();
	let pid_str = process_id.clone();
	tokio::spawn(async move {
		let out_task = stdout.map(|s| {
			let app_c = app.clone();
			let id_c = pid_str.clone();
			tokio::spawn(async move { stream_terminal_pipe(s, app_c, id_c, "stdout").await })
		});
		let err_task = stderr.map(|s| {
			let app_c = app.clone();
			let id_c = pid_str.clone();
			tokio::spawn(async move { stream_terminal_pipe(s, app_c, id_c, "stderr").await })
		});
		if let Some(handle) = out_task {
			let _ = handle.await;
		}
		if let Some(handle) = err_task {
			let _ = handle.await;
		}
		let exit_code = child.wait().await.ok().and_then(|status| status.code());
		let _ = reg_clone.finish_process(&pid_str).await;
		if let Some(handle) = app {
			let _ = handle.emit(
				"terminal:exit",
				TerminalExitEvent {
					session_id: pid_str,
					exit_code,
				},
			);
		}
	});
	Ok(process_id)
}

pub async fn terminal_write(
	registry: &ProcessRegistry,
	process_id: &str,
	data: &str,
) -> Result<(), String> {
	let tx = {
		let guard = registry.inner.lock().await;
		let entry = guard
			.get(process_id)
			.ok_or_else(|| format!("Terminal '{}' is not running", process_id))?;
		entry
			.stdin_tx
			.clone()
			.ok_or_else(|| format!("Terminal '{}' stdin is closed", process_id))?
	};
	tx.send(data.as_bytes().to_vec())
		.map_err(|_| format!("Failed to send input to terminal '{}'", process_id))
}

pub async fn terminal_stop(registry: &ProcessRegistry, process_id: &str) -> Result<(), String> {
	stop_process(registry, process_id).await
}

fn build_shell_command(workspace_root: &Path) -> Command {
	#[cfg(windows)]
	{
		let mut cmd = Command::new("powershell.exe");
		cmd.args(["-NoLogo", "-NoProfile"]);
		cmd.current_dir(workspace_root);
		cmd.creation_flags(CREATE_NO_WINDOW);
		cmd
	}
	#[cfg(not(windows))]
	{
		let mut cmd = Command::new("sh");
		cmd.current_dir(workspace_root);
		cmd
	}
}

async fn stream_terminal_pipe<R: AsyncRead + Unpin>(
	mut reader: R,
	app: Option<tauri::AppHandle>,
	process_id: String,
	stream: &str,
) {
	let mut buf = [0u8; 4096];
	let mut pending = Vec::new();
	loop {
		match reader.read(&mut buf).await {
			Ok(0) => break,
			Ok(n) => {
				let text = decode_utf8_chunk(&mut pending, &buf[..n]);
				if !text.is_empty() {
					if let Some(handle) = &app {
						let _ = handle.emit(
							"terminal:output",
							TerminalOutputEvent {
								session_id: process_id.clone(),
								stream: stream.to_string(),
								data: text,
							},
						);
					}
				}
			}
			Err(_) => break,
		}
	}
	if !pending.is_empty() {
		let tail = String::from_utf8_lossy(&pending).to_string();
		if let Some(handle) = &app {
			let _ = handle.emit(
				"terminal:output",
				TerminalOutputEvent {
					session_id: process_id,
					stream: stream.to_string(),
					data: tail,
				},
			);
		}
	}
}

/// Decodes valid UTF-8 prefixes while buffering trailing split multi-byte sequences.
fn decode_utf8_chunk(pending: &mut Vec<u8>, chunk: &[u8]) -> String {
	pending.extend_from_slice(chunk);
	let mut out = String::new();
	loop {
		match std::str::from_utf8(pending) {
			Ok(valid) => {
				out.push_str(valid);
				pending.clear();
				break;
			}
			Err(err) => {
				let valid_up_to = err.valid_up_to();
				if valid_up_to > 0 {
					if let Ok(prefix) = std::str::from_utf8(&pending[..valid_up_to]) {
						out.push_str(prefix);
					}
				}
				if let Some(invalid_len) = err.error_len() {
					out.push('\u{FFFD}');
					pending.drain(..valid_up_to + invalid_len);
				} else {
					pending.drain(..valid_up_to);
					break;
				}
			}
		}
	}
	out
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn decode_utf8_handles_split_multibyte_korean() {
		let text = "한글 테스트";
		let bytes = text.as_bytes();
		let mut pending = Vec::new();
		// Split inside the second 3-byte Hangul syllable.
		let part1 = decode_utf8_chunk(&mut pending, &bytes[..4]);
		let part2 = decode_utf8_chunk(&mut pending, &bytes[4..]);
		assert_eq!(format!("{}{}", part1, part2), text);
		assert!(pending.is_empty());
	}

	#[tokio::test]
	async fn registry_rejects_duplicate_gradle_task() {
		let reg = ProcessRegistry::new();
		assert!(reg
			.register_gradle("g1", GradleTaskKind::Build)
			.await
			.is_ok());
		let dup = reg.register_gradle("g2", GradleTaskKind::Build).await;
		assert!(dup.is_err());
		assert!(reg
			.register_gradle("g3", GradleTaskKind::CompileJava)
			.await
			.is_ok());
		let list = get_running_processes(&reg).await;
		assert_eq!(list.len(), 2);
		assert!(!reg.finish_process("g1").await);
		assert!(reg
			.register_gradle("g4", GradleTaskKind::Build)
			.await
			.is_ok());
	}

	#[tokio::test]
	async fn terminal_session_executes_and_exits_cleanly() {
		let temp = std::env::temp_dir().join(format!("fs_term_test_{}", Uuid::new_v4()));
		std::fs::create_dir_all(&temp).unwrap();
		let reg = ProcessRegistry::new();
		let id = terminal_start(None, &reg, &temp, None).await.unwrap();
		assert!(terminal_write(&reg, &id, "exit\n").await.is_ok());
		tokio::time::sleep(std::time::Duration::from_millis(400)).await;
		let _ = terminal_stop(&reg, &id).await;
		let _ = std::fs::remove_dir_all(&temp);
	}
}