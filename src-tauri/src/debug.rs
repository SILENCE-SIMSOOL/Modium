use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader as TokioBufReader};
use tokio::net::TcpStream;
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot, Mutex};
use uuid::Uuid;

use crate::lsp::{encode_lsp_json, read_lsp_message, LspManager, PendingRequests};
use crate::models::{
	DebugEvaluateResult, DebugEventPayload, DebugScope, DebugSessionInfo, DebugStackFrame,
	DebugThread, DebugVariable, SourceBreakpointGroup, VerifiedBreakpoint,
};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

fn strip_verbatim_prefix(path: PathBuf) -> PathBuf {
	#[cfg(windows)]
	{
		let s = path.to_string_lossy();
		if let Some(stripped) = s.strip_prefix(r"\\?\") {
			return PathBuf::from(stripped);
		}
	}
	path
}

fn resolve_source_path(root: &Path, file_path: &str) -> PathBuf {
	let p = Path::new(file_path);
	let joined = if p.is_absolute() {
		p.to_path_buf()
	} else {
		root.join(p)
	};
	strip_verbatim_prefix(fs::canonicalize(&joined).unwrap_or(joined))
}

fn infer_project_name(root: &Path) -> String {
	if let Ok(xml) = fs::read_to_string(root.join(".project")) {
		let mut reader = quick_xml::Reader::from_str(&xml);
		loop {
			match reader.read_event() {
				Ok(quick_xml::events::Event::Start(tag)) if tag.name().as_ref() == b"name" => {
					if let Ok(name) = reader.read_text(tag.name()) {
						if let Ok(decoded) = quick_xml::escape::unescape(name.trim()) {
							if !decoded.is_empty() { return decoded.into_owned(); }
						}
					}
					break;
				}
				Ok(quick_xml::events::Event::Eof) | Err(_) => break,
				_ => {}
			}
		}
	}
	for filename in ["settings.gradle.kts", "settings.gradle"] {
		let path = root.join(filename);
		if let Ok(content) = fs::read_to_string(&path) {
			for line in content.lines() {
				let trimmed = line.trim();
				if trimmed.starts_with("rootProject.name") {
					if let Some((_, rhs)) = trimmed.split_once('=') {
						let name = rhs.trim().trim_matches(|c| c == '"' || c == '\'');
						if !name.is_empty() {
							return name.to_string();
						}
					}
				}
			}
		}
	}
	root.file_name()
		.and_then(|n| n.to_str())
		.unwrap_or("fabric-mod")
		.to_string()
}

fn build_debug_init_gradle(jdwp_port: u16) -> String {
	include_str!("debug-init.gradle").replace("@JDWP_PORT@", &jdwp_port.to_string())
}

fn emit_debug_event(app: Option<&AppHandle>, payload: DebugEventPayload) {
	if let Some(handle) = app {
		let _ = handle.emit("debug:event", payload);
	}
}

fn emit_debug_output(app: Option<&AppHandle>, root: &Path, message: impl Into<String>) {
	emit_debug_event(
		app,
		DebugEventPayload {
			workspace: root.to_string_lossy().into_owned(),
			kind: "output".to_string(),
			thread_id: None,
			reason: None,
			file_path: None,
			line: None,
			message: Some(message.into()),
		},
	);
}

async fn kill_pid_tree(pid: u32) {
	#[cfg(windows)]
	{
		let mut cmd = Command::new("taskkill");
		cmd.args(["/F", "/T", "/PID", &pid.to_string()]);
		cmd.creation_flags(CREATE_NO_WINDOW);
		cmd.stdout(Stdio::null()).stderr(Stdio::null());
		let _ = cmd.status().await;
	}
	#[cfg(not(windows))]
	{
		let mut cmd = Command::new("kill");
		cmd.args(["-9", &pid.to_string()]);
		cmd.stdout(Stdio::null()).stderr(Stdio::null());
		let _ = cmd.status().await;
	}
}

struct DapSession {
	reload_lock: Mutex<()>,
	session_id: String,
	jdwp_port: u16,
	dap_port: u16,
	project_root: PathBuf,
	writer_tx: mpsc::Sender<Vec<u8>>,
	next_seq: AtomicI64,
	pending: PendingRequests,
	gradle_pid: std::sync::Mutex<Option<u32>>,
	init_script_path: Option<PathBuf>,
	breakpoints: Mutex<HashMap<String, Vec<u32>>>,
	last_stopped_thread_id: std::sync::Mutex<Option<i64>>,
	app: Option<AppHandle>,
	stopped_flag: Arc<AtomicBool>,
}

impl DapSession {
	async fn send_request(
		&self,
		command: &str,
		arguments: Option<Value>,
		timeout_dur: Duration,
	) -> Result<Value, String> {
		let seq = self.next_seq.fetch_add(1, Ordering::SeqCst);
		let (tx, rx) = oneshot::channel();
		{
			let mut map = self
				.pending
				.lock()
				.map_err(|_| "Pending DAP map poisoned".to_string())?;
			map.insert(seq, tx);
		}

		let mut payload = json!({
			"seq": seq,
			"type": "request",
			"command": command
		});
		if let Some(args) = arguments {
			payload["arguments"] = args;
		}

		let frame = encode_lsp_json(&payload)?;
		if self.writer_tx.send(frame).await.is_err() {
			if let Ok(mut map) = self.pending.lock() {
				map.remove(&seq);
			}
			return Err("DAP connection is closed".to_string());
		}

		match tokio::time::timeout(timeout_dur, rx).await {
			Ok(Ok(res)) => res,
			Ok(Err(_)) => Err(format!("DAP socket closed while awaiting '{command}'")),
			Err(_) => {
				if let Ok(mut map) = self.pending.lock() {
					map.remove(&seq);
				}
				Err(format!("DAP request '{command}' timed out"))
			}
		}
	}

	async fn stack_trace_internal(
		&self,
		thread_id: i64,
		levels: u32,
	) -> Result<Vec<DebugStackFrame>, String> {
		let body = self
			.send_request(
				"stackTrace",
				Some(json!({
					"threadId": thread_id,
					"startFrame": 0,
					"levels": levels
				})),
				Duration::from_secs(10),
			)
			.await?;
		let frames = body
			.get("stackFrames")
			.and_then(|v| v.as_array())
			.map(|arr| {
				arr.iter()
					.map(|f| DebugStackFrame {
						id: f.get("id").and_then(|v| v.as_i64()).unwrap_or(0),
						name: f
							.get("name")
							.and_then(|v| v.as_str())
							.unwrap_or("")
							.to_string(),
						source_path: f
							.get("source")
							.and_then(|s| s.get("path"))
							.and_then(|p| p.as_str())
							.map(|s| s.to_string()),
						line: f.get("line").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
						column: f.get("column").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
					})
					.collect()
			})
			.unwrap_or_default();
		Ok(frames)
	}

	async fn set_breakpoints_internal(
		&self,
		file_path: &str,
		lines: &[u32],
	) -> Result<Vec<VerifiedBreakpoint>, String> {
		let resolved = resolve_source_path(&self.project_root, file_path);
		let resolved_str = resolved.to_string_lossy().to_string();
		let file_name = resolved
			.file_name()
			.and_then(|n| n.to_str())
			.unwrap_or("Source.java")
			.to_string();

		{
			let mut bp_map = self.breakpoints.lock().await;
			if lines.is_empty() {
				bp_map.remove(&resolved_str);
			} else {
				bp_map.insert(resolved_str.clone(), lines.to_vec());
			}
		}

		let bp_entries: Vec<Value> = lines.iter().map(|line| json!({ "line": line })).collect();
		let body = self
			.send_request(
				"setBreakpoints",
				Some(json!({
					"source": {
						"name": file_name,
						"path": resolved_str
					},
					"breakpoints": bp_entries,
					"sourceModified": false
				})),
				Duration::from_secs(10),
			)
			.await?;

		let verified = body
			.get("breakpoints")
			.and_then(|v| v.as_array())
			.map(|arr| {
				arr.iter()
					.map(|b| VerifiedBreakpoint {
						id: b.get("id").and_then(|v| v.as_i64()),
						verified: b.get("verified").and_then(|v| v.as_bool()).unwrap_or(false),
						line: b.get("line").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
						message: b
							.get("message")
							.and_then(|v| v.as_str())
							.map(|s| s.to_string()),
					})
					.collect()
			})
			.unwrap_or_default();
		Ok(verified)
	}

	async fn cleanup_resources(&self) {
		self.stopped_flag.store(true, Ordering::SeqCst);
		let _ = self
			.send_request(
				"disconnect",
				Some(json!({
					"restart": false,
					"terminateDebuggee": true
				})),
				Duration::from_secs(2),
			)
			.await;

		let pid = self.gradle_pid.lock().ok().and_then(|mut g| g.take());
		if let Some(pid) = pid {
			kill_pid_tree(pid).await;
		}
		if let Some(ref init_path) = self.init_script_path {
			let _ = tokio::fs::remove_file(init_path).await;
		}
	}
}

fn handle_dap_event(session: &Arc<DapSession>, event_name: &str, body: &Value) {
	let app = session.app.clone();
	match event_name {
		"hotcodereplace" => {
			#[cfg(test)]
			eprintln!("HCR event: {body}");
			if body["changeType"] == "BUILD_COMPLETE" {
				let session = Arc::clone(session);
				tokio::spawn(async move {
					let _guard = session.reload_lock.lock().await;
					match session.send_request("redefineClasses", Some(json!({})), Duration::from_secs(20)).await {
						Ok(reply) => {
							#[cfg(test)]
							eprintln!("Redefine: {reply}");
							if let Some(classes) = reply.get("changedClasses").and_then(Value::as_array).filter(|v| !v.is_empty()) {
								emit_debug_output(session.app.as_ref(), &session.project_root, format!("Hot reload: {}", json!(classes)));
							}
						}
						Err(err) => emit_debug_output(session.app.as_ref(), &session.project_root, format!("Hot reload: {err}")),
					}
				});
			} else if body["changeType"] == "ERROR" {
				emit_debug_event(app.as_ref(), DebugEventPayload {
					workspace: session.project_root.to_string_lossy().into_owned(),
					kind: "hotReloadError".into(), message: body["message"].as_str().map(str::to_owned),
					thread_id: None, reason: None, file_path: None, line: None,
				});
			} else if let Some(message) = body["message"].as_str().filter(|s| !s.is_empty()) {
				emit_debug_output(app.as_ref(), &session.project_root, format!("Hot reload: {message}"));
			}
		}
		"stopped" => {
			let thread_id = body.get("threadId").and_then(|v| v.as_i64());
			if let Some(tid) = thread_id {
				if let Ok(mut guard) = session.last_stopped_thread_id.lock() {
					*guard = Some(tid);
				}
			}
			let reason = body
				.get("reason")
				.and_then(|v| v.as_str())
				.map(|s| s.to_string());
			let message = body
				.get("description")
				.or_else(|| body.get("text"))
				.and_then(|v| v.as_str())
				.map(|s| s.to_string());

			let sess_clone = Arc::clone(session);
			tokio::spawn(async move {
				let (file_path, line) = if let Some(tid) = thread_id {
					match tokio::time::timeout(
						Duration::from_secs(3),
						sess_clone.stack_trace_internal(tid, 1),
					)
					.await
					{
						Ok(Ok(frames)) => frames
							.into_iter()
							.next()
							.map(|f| (f.source_path, Some(f.line)))
							.unwrap_or((None, None)),
						_ => (None, None),
					}
				} else {
					(None, None)
				};

				emit_debug_event(
					app.as_ref(),
					DebugEventPayload {
						workspace: sess_clone.project_root.to_string_lossy().into_owned(),
						kind: "stopped".to_string(),
						thread_id,
						reason,
						file_path,
						line,
						message,
					},
				);
			});
		}
		"continued" => {
			if let Ok(mut guard) = session.last_stopped_thread_id.lock() {
				*guard = None;
			}
			emit_debug_event(
				app.as_ref(),
				DebugEventPayload {
					workspace: session.project_root.to_string_lossy().into_owned(),
					kind: "continued".to_string(),
					thread_id: body.get("threadId").and_then(|v| v.as_i64()),
					reason: None,
					file_path: None,
					line: None,
					message: None,
				},
			);
		}
		"terminated" => {
			emit_debug_event(
				app.as_ref(),
				DebugEventPayload {
					workspace: session.project_root.to_string_lossy().into_owned(),
					kind: "terminated".to_string(),
					thread_id: None,
					reason: None,
					file_path: None,
					line: None,
					message: None,
				},
			);
		}
		"exited" => {
			let code = body.get("exitCode").and_then(|v| v.as_i64());
			emit_debug_event(
				app.as_ref(),
				DebugEventPayload {
					workspace: session.project_root.to_string_lossy().into_owned(),
					kind: "exited".to_string(),
					thread_id: None,
					reason: None,
					file_path: None,
					line: None,
					message: code.map(|c| format!("Target exited with code {c}")),
				},
			);
		}
		"output" => {
			if let Some(out) = body.get("output").and_then(|v| v.as_str()) {
				emit_debug_output(
					app.as_ref(),
					&session.project_root,
					out.trim_end_matches(['\r', '\n']),
				);
			}
		}
		"breakpoint" => {
			let bp = body.get("breakpoint").unwrap_or(&Value::Null);
			emit_debug_event(
				app.as_ref(),
				DebugEventPayload {
					workspace: session.project_root.to_string_lossy().into_owned(),
					kind: "breakpoint".to_string(),
					thread_id: None,
					reason: body
						.get("reason")
						.and_then(|v| v.as_str())
						.map(|s| s.to_string()),
					file_path: bp
						.get("source")
						.and_then(|s| s.get("path"))
						.and_then(|p| p.as_str())
						.map(|s| s.to_string()),
					line: bp.get("line").and_then(|v| v.as_u64()).map(|l| l as u32),
					message: bp
						.get("message")
						.and_then(|v| v.as_str())
						.map(|s| s.to_string()),
				},
			);
		}
		_ => {}
	}
}

pub struct DebugManager {
	session: Mutex<Option<Arc<DapSession>>>,
}

impl Default for DebugManager {
	fn default() -> Self {
		Self::new()
	}
}

impl DebugManager {
	pub fn new() -> Self {
		Self {
			session: Mutex::new(None),
		}
	}

	async fn active_session(&self) -> Result<Arc<DapSession>, String> {
		self.session
			.lock()
			.await
			.as_ref()
			.cloned()
			.ok_or_else(|| "No active debug session".to_string())
	}

	pub async fn active_session_info(&self) -> Option<DebugSessionInfo> {
		let guard = self.session.lock().await;
		guard.as_ref().map(|s| DebugSessionInfo {
			session_id: s.session_id.clone(),
			jdwp_port: s.jdwp_port,
			dap_port: s.dap_port,
		})
	}

	pub async fn start_debug_client(
		&self,
		app: Option<AppHandle>,
		lsp: &LspManager,
		root: PathBuf,
		java_home: Option<PathBuf>,
		breakpoints: Vec<SourceBreakpointGroup>,
	) -> Result<DebugSessionInfo, String> {
		let _ = self.stop().await;

		if !lsp.is_running().await {
			return Err("Language server (JDT.LS) must be running before starting debugger".into());
		}

		lsp.build_for_debug().await?;
		let listener = std::net::TcpListener::bind("127.0.0.1:0")
			.map_err(|e| format!("Failed to reserve ephemeral JDWP port: {e}"))?;
		let jdwp_port = listener
			.local_addr()
			.map_err(|e| format!("Failed to inspect reserved JDWP port: {e}"))?
			.port();
		drop(listener);

		let init_script_path =
			std::env::temp_dir().join(format!("fabric-studio-debug-{}.gradle", Uuid::new_v4()));
		let init_script_content = build_debug_init_gradle(jdwp_port);
		tokio::fs::write(&init_script_path, init_script_content)
			.await
			.map_err(|e| format!("Failed to write temp Gradle init script: {e}"))?;

		let gradlew = root.join(if cfg!(windows) {
			"gradlew.bat"
		} else {
			"gradlew"
		});
		if !gradlew.is_file() {
			let _ = tokio::fs::remove_file(&init_script_path).await;
			return Err(format!("Gradle wrapper not found at {}", gradlew.display()));
		}

		let mut cmd = Command::new(&gradlew);
		cmd.arg("runClient")
			.arg("--console=plain")
			.arg("--no-configuration-cache")
			.arg("-I")
			.arg(&init_script_path)
			.current_dir(&root)
			.stdin(Stdio::null())
			.stdout(Stdio::piped())
			.stderr(Stdio::piped());
		if let Some(ref jh) = java_home {
			cmd.env("JAVA_HOME", jh);
			let bin_dir = jh.join("bin");
			let current_path = std::env::var_os("PATH").unwrap_or_default();
			let mut paths = vec![bin_dir];
			paths.extend(std::env::split_paths(&current_path));
			if let Ok(joined_path) = std::env::join_paths(paths) {
				cmd.env("PATH", joined_path);
			}
		}
		#[cfg(windows)]
		cmd.creation_flags(CREATE_NO_WINDOW);

		let mut child = match cmd.spawn() {
			Ok(c) => c,
			Err(e) => {
				let _ = tokio::fs::remove_file(&init_script_path).await;
				return Err(format!("Failed to launch Gradle runClient: {e}"));
			}
		};
		let child_pid = child.id();
		let stdout = child.stdout.take();
		let stderr = child.stderr.take();

		let (jdwp_ready_tx, mut jdwp_ready_rx) = mpsc::channel::<()>(2);

		if let Some(out) = stdout {
			let app_out = app.clone();
			let output_root = root.clone();
			let ready_tx = jdwp_ready_tx.clone();
			tokio::spawn(async move {
				let mut reader = TokioBufReader::new(out);
				let mut line = String::new();
				let mut signaled = false;
				loop {
					line.clear();
					match reader.read_line(&mut line).await {
						Ok(0) | Err(_) => break,
						Ok(_) => {
							let clean = line.trim_end_matches(['\r', '\n']);
							if !signaled && clean.contains("Listening for transport dt_socket") {
								signaled = true;
								let _ = ready_tx.try_send(());
							}
							emit_debug_output(app_out.as_ref(), &output_root, clean);
						}
					}
				}
			});
		}

		if let Some(err) = stderr {
			let app_err = app.clone();
			let output_root = root.clone();
			let ready_tx = jdwp_ready_tx;
			tokio::spawn(async move {
				let mut reader = TokioBufReader::new(err);
				let mut line = String::new();
				let mut signaled = false;
				loop {
					line.clear();
					match reader.read_line(&mut line).await {
						Ok(0) | Err(_) => break,
						Ok(_) => {
							let clean = line.trim_end_matches(['\r', '\n']);
							if !signaled && clean.contains("Listening for transport dt_socket") {
								signaled = true;
								let _ = ready_tx.try_send(());
							}
							emit_debug_output(app_err.as_ref(), &output_root, clean);
						}
					}
				}
			});
		}

		let wait_result = tokio::select! {
			recv = jdwp_ready_rx.recv() => {
				if recv.is_some() {
					Ok(())
				} else {
					Err("Gradle output stream closed before JDWP listener started".to_string())
				}
			}
			status = child.wait() => {
				match status {
					Ok(s) => Err(format!("Gradle runClient exited early ({s}) before JDWP started")),
					Err(e) => Err(format!("Failed waiting on Gradle runClient: {e}")),
				}
			}
			_ = tokio::time::sleep(Duration::from_secs(120)) => {
				Err("Timed out after 120s waiting for JDWP socket listener".to_string())
			}
		};

		if let Err(err) = wait_result {
			if let Some(pid) = child_pid {
				kill_pid_tree(pid).await;
			}
			let _ = child.kill().await;
			let _ = tokio::fs::remove_file(&init_script_path).await;
			return Err(err);
		}

		let dap_port = match lsp.request_debug_port().await {
			Ok(port) => port,
			Err(err) => {
				if let Some(pid) = child_pid {
					kill_pid_tree(pid).await;
				}
				let _ = child.kill().await;
				let _ = tokio::fs::remove_file(&init_script_path).await;
				return Err(format!(
					"Failed to start Java Debug Adapter via JDT.LS: {err}"
				));
			}
		};

		let mut tcp_stream = None;
		let mut last_conn_err = String::new();
		for _ in 0..10 {
			match TcpStream::connect(("127.0.0.1", dap_port)).await {
				Ok(s) => {
					tcp_stream = Some(s);
					break;
				}
				Err(e) => {
					last_conn_err = e.to_string();
					tokio::time::sleep(Duration::from_millis(100)).await;
				}
			}
		}
		let stream = match tcp_stream {
			Some(s) => s,
			None => {
				if let Some(pid) = child_pid {
					kill_pid_tree(pid).await;
				}
				let _ = child.kill().await;
				let _ = tokio::fs::remove_file(&init_script_path).await;
				return Err(format!(
					"Failed to connect to DAP server on port {dap_port}: {last_conn_err}"
				));
			}
		};

		let (read_half, mut write_half) = stream.into_split();
		let (writer_tx, mut writer_rx) = mpsc::channel::<Vec<u8>>(128);
		tokio::spawn(async move {
			while let Some(bytes) = writer_rx.recv().await {
				if write_half.write_all(&bytes).await.is_err() {
					break;
				}
				if write_half.flush().await.is_err() {
					break;
				}
			}
		});

		let session_id = Uuid::new_v4().to_string();
		let pending: PendingRequests = Arc::new(std::sync::Mutex::new(HashMap::new()));
		let stopped_flag = Arc::new(AtomicBool::new(false));

		let session = Arc::new(DapSession {
			reload_lock: Mutex::new(()),
			session_id: session_id.clone(),
			jdwp_port,
			dap_port,
			project_root: root.clone(),
			writer_tx,
			next_seq: AtomicI64::new(1),
			pending: Arc::clone(&pending),
			gradle_pid: std::sync::Mutex::new(child_pid),
			init_script_path: Some(init_script_path.clone()),
			breakpoints: Mutex::new(HashMap::new()),
			last_stopped_thread_id: std::sync::Mutex::new(None),
			app: app.clone(),
			stopped_flag: Arc::clone(&stopped_flag),
		});

		let reader_session = Arc::clone(&session);
		tokio::spawn(async move {
			let mut buf_reader = TokioBufReader::new(read_half);
			loop {
				match read_lsp_message(&mut buf_reader).await {
					Ok(Some(msg)) => {
						let msg_type = msg.get("type").and_then(|t| t.as_str()).unwrap_or("");
						match msg_type {
							"response" => {
								if let Some(req_seq) =
									msg.get("request_seq").and_then(|v| v.as_i64())
								{
									let sender = reader_session
										.pending
										.lock()
										.ok()
										.and_then(|mut map| map.remove(&req_seq));
									if let Some(tx) = sender {
										let ok = msg
											.get("success")
											.and_then(|v| v.as_bool())
											.unwrap_or(false);
										if ok {
											let body =
												msg.get("body").cloned().unwrap_or(Value::Null);
											let _ = tx.send(Ok(body));
										} else {
											let err_msg = msg
												.get("message")
												.and_then(|v| v.as_str())
												.unwrap_or("DAP request failed")
												.to_string();
											let _ = tx.send(Err(err_msg));
										}
									}
								}
							}
							"event" => {
								if let Some(ev_name) = msg.get("event").and_then(|e| e.as_str()) {
									let body = msg.get("body").unwrap_or(&Value::Null);
									handle_dap_event(&reader_session, ev_name, body);
								}
							}
							_ => {}
						}
					}
					Ok(None) | Err(_) => {
						if let Ok(mut map) = reader_session.pending.lock() {
							for (_, tx) in map.drain() {
								let _ = tx.send(Err("DAP stream closed".to_string()));
							}
						}
						break;
					}
				}
			}
		});

		let exit_app = app.clone();
		let exit_flag = Arc::clone(&stopped_flag);
		let exit_init = init_script_path.clone();
		let exit_session_pid = Arc::clone(&session);
		tokio::spawn(async move {
			let status = child.wait().await;
			if let Ok(mut guard) = exit_session_pid.gradle_pid.lock() {
				*guard = None;
			}
			let _ = tokio::fs::remove_file(&exit_init).await;
			if !exit_flag.swap(true, Ordering::SeqCst) {
				let msg = match status {
					Ok(s) => format!("Client process exited ({s})"),
					Err(e) => format!("Client process wait error: {e}"),
				};
				emit_debug_event(
					exit_app.as_ref(),
					DebugEventPayload {
						workspace: exit_session_pid.project_root.to_string_lossy().into_owned(),
						kind: "terminated".to_string(),
						thread_id: None,
						reason: None,
						file_path: None,
						line: None,
						message: Some(msg),
					},
				);
			}
		});

		let project_name = infer_project_name(&root);
		let handshake = async {
			session
				.send_request(
					"initialize",
					Some(json!({
						"clientID": "fabric-studio",
						"clientName": "Modium",
						"adapterID": "java",
						"linesStartAt1": true,
						"columnsStartAt1": true,
						"pathFormat": "path",
						"supportsVariableType": true,
						"supportsVariablePaging": false
					})),
					Duration::from_secs(15),
				)
				.await?;

			session
				.send_request(
					"attach",
					Some(json!({
						"hostName": "127.0.0.1",
						"port": jdwp_port,
						"projectName": project_name
					})),
					Duration::from_secs(20),
				)
				.await?;

			for group in &breakpoints {
				if !group.lines.is_empty() {
					let _ = session
						.set_breakpoints_internal(&group.file_path, &group.lines)
						.await?;
				}
			}

			session
				.send_request(
					"configurationDone",
					Some(json!({})),
					Duration::from_secs(15),
				)
				.await?;
			Ok::<(), String>(())
		}
		.await;

		if let Err(err) = handshake {
			session.cleanup_resources().await;
			return Err(format!("DAP handshake failed: {err}"));
		}

		{
			let mut slot = self.session.lock().await;
			*slot = Some(session);
		}

		Ok(DebugSessionInfo {
			session_id,
			jdwp_port,
			dap_port,
		})
	}

	pub async fn set_breakpoints(
		&self,
		file_path: String,
		lines: Vec<u32>,
	) -> Result<Vec<VerifiedBreakpoint>, String> {
		let session = self.active_session().await?;
		session.set_breakpoints_internal(&file_path, &lines).await
	}

	async fn resolve_target_thread_id(&self, session: &DapSession, thread_id: Option<i64>) -> i64 {
		if let Some(tid) = thread_id {
			return tid;
		}
		if let Ok(guard) = session.last_stopped_thread_id.lock() {
			if let Some(tid) = *guard {
				return tid;
			}
		}
		if let Ok(list) = self.threads().await {
			if let Some(preferred) = list
				.iter()
				.find(|t| t.name.eq_ignore_ascii_case("Render thread") || t.name == "main")
				.or_else(|| list.first())
			{
				return preferred.id;
			}
		}
		1
	}

	pub async fn continue_exec(&self, thread_id: Option<i64>) -> Result<(), String> {
		let session = self.active_session().await?;
		let tid = self.resolve_target_thread_id(&session, thread_id).await;
		session
			.send_request(
				"continue",
				Some(json!({ "threadId": tid })),
				Duration::from_secs(10),
			)
			.await?;
		Ok(())
	}

	pub async fn pause_exec(&self, thread_id: Option<i64>) -> Result<(), String> {
		let session = self.active_session().await?;
		let tid = self.resolve_target_thread_id(&session, thread_id).await;
		session
			.send_request(
				"pause",
				Some(json!({ "threadId": tid })),
				Duration::from_secs(10),
			)
			.await?;
		Ok(())
	}

	pub async fn step_over(&self, thread_id: i64) -> Result<(), String> {
		let session = self.active_session().await?;
		session
			.send_request(
				"next",
				Some(json!({ "threadId": thread_id })),
				Duration::from_secs(10),
			)
			.await?;
		Ok(())
	}

	pub async fn step_into(&self, thread_id: i64) -> Result<(), String> {
		let session = self.active_session().await?;
		session
			.send_request(
				"stepIn",
				Some(json!({ "threadId": thread_id })),
				Duration::from_secs(10),
			)
			.await?;
		Ok(())
	}

	pub async fn step_out(&self, thread_id: i64) -> Result<(), String> {
		let session = self.active_session().await?;
		session
			.send_request(
				"stepOut",
				Some(json!({ "threadId": thread_id })),
				Duration::from_secs(10),
			)
			.await?;
		Ok(())
	}

	pub async fn threads(&self) -> Result<Vec<DebugThread>, String> {
		let session = self.active_session().await?;
		let body = session
			.send_request("threads", Some(json!({})), Duration::from_secs(10))
			.await?;
		let threads = body
			.get("threads")
			.and_then(|v| v.as_array())
			.map(|arr| {
				arr.iter()
					.map(|t| DebugThread {
						id: t.get("id").and_then(|v| v.as_i64()).unwrap_or(0),
						name: t
							.get("name")
							.and_then(|v| v.as_str())
							.unwrap_or("Thread")
							.to_string(),
					})
					.collect()
			})
			.unwrap_or_default();
		Ok(threads)
	}

	pub async fn stack_trace(&self, thread_id: i64) -> Result<Vec<DebugStackFrame>, String> {
		let session = self.active_session().await?;
		session.stack_trace_internal(thread_id, 50).await
	}

	pub async fn scopes(&self, frame_id: i64) -> Result<Vec<DebugScope>, String> {
		let session = self.active_session().await?;
		let body = session
			.send_request(
				"scopes",
				Some(json!({ "frameId": frame_id })),
				Duration::from_secs(10),
			)
			.await?;
		let scopes = body
			.get("scopes")
			.and_then(|v| v.as_array())
			.map(|arr| {
				arr.iter()
					.map(|s| DebugScope {
						name: s
							.get("name")
							.and_then(|v| v.as_str())
							.unwrap_or("Scope")
							.to_string(),
						variables_reference: s
							.get("variablesReference")
							.and_then(|v| v.as_i64())
							.unwrap_or(0),
						expensive: s
							.get("expensive")
							.and_then(|v| v.as_bool())
							.unwrap_or(false),
					})
					.collect()
			})
			.unwrap_or_default();
		Ok(scopes)
	}

	pub async fn variables(&self, variables_reference: i64) -> Result<Vec<DebugVariable>, String> {
		let session = self.active_session().await?;
		let body = session
			.send_request(
				"variables",
				Some(json!({ "variablesReference": variables_reference })),
				Duration::from_secs(10),
			)
			.await?;
		let vars = body
			.get("variables")
			.and_then(|v| v.as_array())
			.map(|arr| {
				arr.iter()
					.map(|v| DebugVariable {
						name: v
							.get("name")
							.and_then(|n| n.as_str())
							.unwrap_or("")
							.to_string(),
						value: v
							.get("value")
							.and_then(|val| val.as_str())
							.unwrap_or("")
							.to_string(),
						var_type: v
							.get("type")
							.and_then(|t| t.as_str())
							.map(|s| s.to_string()),
						variables_reference: v
							.get("variablesReference")
							.and_then(|r| r.as_i64())
							.unwrap_or(0),
					})
					.collect()
			})
			.unwrap_or_default();
		Ok(vars)
	}

	pub async fn evaluate(
		&self,
		expression: String,
		frame_id: Option<i64>,
		context: Option<String>,
	) -> Result<DebugEvaluateResult, String> {
		let session = self.active_session().await?;
		let mut args = json!({
			"expression": expression,
			"context": context.unwrap_or_else(|| "repl".to_string())
		});
		if let Some(fid) = frame_id {
			args["frameId"] = json!(fid);
		}
		let body = session
			.send_request("evaluate", Some(args), Duration::from_secs(10))
			.await?;
		Ok(DebugEvaluateResult {
			result: body
				.get("result")
				.and_then(|v| v.as_str())
				.unwrap_or("")
				.to_string(),
			var_type: body
				.get("type")
				.and_then(|v| v.as_str())
				.map(|s| s.to_string()),
			variables_reference: body
				.get("variablesReference")
				.and_then(|v| v.as_i64())
				.unwrap_or(0),
		})
	}

	pub async fn stop(&self) -> Result<(), String> {
		let prev = {
			let mut guard = self.session.lock().await;
			guard.take()
		};
		if let Some(session) = prev {
			let app = session.app.clone();
			session.cleanup_resources().await;
			emit_debug_event(
				app.as_ref(),
				DebugEventPayload {
					workspace: session.project_root.to_string_lossy().into_owned(),
					kind: "terminated".to_string(),
					thread_id: None,
					reason: None,
					file_path: None,
					line: None,
					message: Some("Debug session stopped".to_string()),
				},
			);
		}
		Ok(())
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use tokio::io::BufReader as TokioBufReader;

	#[tokio::test]
	async fn dap_frame_encoding_and_multibyte_korean_parsing() {
		let req = json!({
			"seq": 1,
			"type": "request",
			"command": "evaluate",
			"arguments": {
				"expression": "\"테스트 메시지\"",
				"frameId": 1001,
				"context": "watch"
			}
		});
		let ev = json!({
			"seq": 2,
			"type": "event",
			"event": "stopped",
			"body": {
				"reason": "breakpoint",
				"threadId": 1,
				"description": "중단점 도달"
			}
		});

		let mut bytes = encode_lsp_json(&req).unwrap();
		bytes.extend_from_slice(&encode_lsp_json(&ev).unwrap());

		let mut reader = TokioBufReader::new(std::io::Cursor::new(bytes));
		let decoded_req = read_lsp_message(&mut reader).await.unwrap().unwrap();
		let decoded_ev = read_lsp_message(&mut reader).await.unwrap().unwrap();
		assert!(read_lsp_message(&mut reader).await.unwrap().is_none());

		assert_eq!(decoded_req, req);
		assert_eq!(decoded_ev, ev);
		assert_eq!(decoded_ev["body"]["description"], "중단점 도달");
	}

	#[test]
	fn debug_init_gradle_contains_client_jdwp_hook() {
		let script = build_debug_init_gradle(5005);
		assert!(script.contains("JavaExec"));
		assert!(script.contains("contains(\"client\")"));
		assert!(script.contains("address=127.0.0.1:5005"));
		assert!(script.contains("suspend=y"));
	}

	#[test]
	fn infer_project_name_reads_settings_gradle_kts() {
		let dir = std::env::temp_dir().join(format!("fs-dbg-test-{}", Uuid::new_v4()));
		fs::create_dir_all(&dir).unwrap();
		fs::write(
			dir.join("settings.gradle.kts"),
			"pluginManagement {}\nrootProject.name = \"cool-fabric-mod\"\n",
		)
		.unwrap();
		assert_eq!(infer_project_name(&dir), "cool-fabric-mod");
		let _ = fs::remove_dir_all(&dir);
	}
}
