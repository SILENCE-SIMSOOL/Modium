use std::collections::{HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, OnceLock};

use regex::Regex;
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::Command;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::models::{
	BuildProblem, GradleOutputEvent, GradleStateEvent, GradleTaskKind, ProblemSeverity,
	ProcessLifecycle, ProcessStatusInfo,
};
use crate::process::{ProcessRegistry, CREATE_NO_WINDOW};

/// Maps a strictly typed Gradle task variant to safe wrapper CLI arguments.
pub fn gradle_args_for_task(task: GradleTaskKind) -> &'static [&'static str] {
	match task {
		GradleTaskKind::Build => &["build", "--console=plain"],
		GradleTaskKind::RunClient => &["runClient", "--console=plain"],
		GradleTaskKind::RunServer => &["runServer", "--console=plain"],
		GradleTaskKind::Clean => &["clean", "--console=plain"],
		GradleTaskKind::GenSources => &["genSources", "--console=plain"],
		GradleTaskKind::Eclipse => &["eclipse", "--console=plain"],
		GradleTaskKind::RefreshDependencies => &["--refresh-dependencies", "--console=plain"],
		GradleTaskKind::CompileJava => &["compileJava", "--console=plain"],
	}
}

pub async fn run_gradle_task(
	app: Option<tauri::AppHandle>,
	registry: &ProcessRegistry,
	workspace_root: &Path,
	task: GradleTaskKind,
	java_home: Option<&str>,
) -> Result<ProcessStatusInfo, String> {
	if !workspace_root.is_dir() {
		return Err(format!(
			"Workspace root does not exist: {}",
			workspace_root.display()
		));
	}
	let wrapper = locate_gradle_wrapper(workspace_root)?;
	let process_id = format!("gradle-{}", Uuid::new_v4());
	registry.register_gradle(&process_id, task).await?;
	emit_gradle_state(
		&app,
		&process_id,
		task,
		ProcessLifecycle::Starting,
		None,
		Vec::new(),
	);
	let mut cmd = Command::new(&wrapper);
	cmd.args(gradle_args_for_task(task))
		.current_dir(workspace_root)
		.stdout(Stdio::piped())
		.stderr(Stdio::piped())
		.kill_on_drop(false);
	apply_java_home(&mut cmd, java_home);
	#[cfg(windows)]
	cmd.creation_flags(CREATE_NO_WINDOW);
	let mut child = match cmd.spawn() {
		Ok(child) => child,
		Err(err) => {
			let _ = registry.finish_process(&process_id).await;
			emit_gradle_state(
				&app,
				&process_id,
				task,
				ProcessLifecycle::Failed,
				None,
				Vec::new(),
			);
			return Err(format!(
				"Failed to spawn Gradle wrapper '{}': {}",
				wrapper.display(),
				err
			));
		}
	};
	let pid = child.id();
	registry.set_running(&process_id, pid).await;
	emit_gradle_state(
		&app,
		&process_id,
		task,
		ProcessLifecycle::Running,
		None,
		Vec::new(),
	);
	let stdout = child.stdout.take();
	let stderr = child.stderr.take();
	let reg_clone = registry.clone();
	let root_buf = workspace_root.to_path_buf();
	let pid_str = process_id.clone();
	tokio::spawn(async move {
		let captured = Arc::new(Mutex::new(BuildDiagnostics::new(root_buf)));
		let out_task = stdout.map(|s| {
			let app_c = app.clone();
			let id_c = pid_str.clone();
			let cap_c = Arc::clone(&captured);
			tokio::spawn(
				async move { stream_gradle_lines(s, app_c, id_c, task, "stdout", cap_c).await },
			)
		});
		let err_task = stderr.map(|s| {
			let app_c = app.clone();
			let id_c = pid_str.clone();
			let cap_c = Arc::clone(&captured);
			tokio::spawn(
				async move { stream_gradle_lines(s, app_c, id_c, task, "stderr", cap_c).await },
			)
		});
		if let Some(handle) = out_task {
			let _ = handle.await;
		}
		if let Some(handle) = err_task {
			let _ = handle.await;
		}
		let status = child.wait().await.ok();
		let exit_code = status.and_then(|s| s.code());
		let stop_requested = reg_clone.finish_process(&pid_str).await;
		let final_state = if stop_requested {
			ProcessLifecycle::Stopped
		} else if status.map(|s| s.success()).unwrap_or(false) {
			ProcessLifecycle::Completed
		} else {
			ProcessLifecycle::Failed
		};
		let problems = captured.lock().await.finish();
		emit_gradle_state(&app, &pid_str, task, final_state, exit_code, problems);
	});
	Ok(ProcessStatusInfo {
		process_id,
		kind: format!("gradle:{:?}", task),
		state: ProcessLifecycle::Running,
		pid,
	})
}

fn locate_gradle_wrapper(workspace_root: &Path) -> Result<PathBuf, String> {
	#[cfg(windows)]
	let candidate = workspace_root.join("gradlew.bat");
	#[cfg(not(windows))]
	let candidate = workspace_root.join("gradlew");
	if !candidate.is_file() {
		return Err(format!(
			"Gradle wrapper not found at {}",
			candidate.display()
		));
	}
	#[cfg(unix)]
	{
		use std::os::unix::fs::PermissionsExt;
		if let Ok(meta) = std::fs::metadata(&candidate) {
			let mut perms = meta.permissions();
			if perms.mode() & 0o111 == 0 {
				perms.set_mode(perms.mode() | 0o755);
				let _ = std::fs::set_permissions(&candidate, perms);
			}
		}
	}
	Ok(candidate)
}

fn apply_java_home(cmd: &mut Command, java_home: Option<&str>) {
	let Some(raw) = java_home.map(str::trim).filter(|s| !s.is_empty()) else {
		return;
	};
	let home = PathBuf::from(raw);
	let bin_dir = home.join("bin");
	cmd.env("JAVA_HOME", &home);
	let mut paths = vec![bin_dir];
	if let Some(existing) = std::env::var_os("PATH") {
		paths.extend(std::env::split_paths(&existing));
	}
	if let Ok(joined) = std::env::join_paths(paths) {
		cmd.env("PATH", joined);
	}
}

fn emit_gradle_state(
	app: &Option<tauri::AppHandle>,
	process_id: &str,
	task: GradleTaskKind,
	state: ProcessLifecycle,
	exit_code: Option<i32>,
	problems: Vec<BuildProblem>,
) {
	if let Some(handle) = app {
		let _ = handle.emit(
			"gradle:state",
			GradleStateEvent {
				process_id: process_id.to_string(),
				task,
				state,
				exit_code,
				problems,
			},
		);
	}
}

async fn stream_gradle_lines<R: AsyncRead + Unpin>(
	reader: R,
	app: Option<tauri::AppHandle>,
	process_id: String,
	task: GradleTaskKind,
	stream: &str,
	captured: Arc<Mutex<BuildDiagnostics>>,
) {
	let mut lines = BufReader::new(reader).lines();
	while let Ok(Some(line)) = lines.next_line().await {
		{
			let mut guard = captured.lock().await;
			guard.push(&line);
		}
		if let Some(handle) = &app {
			let _ = handle.emit(
				"gradle:output",
				GradleOutputEvent {
					process_id: process_id.clone(),
					task,
					stream: stream.to_string(),
					line,
				},
			);
		}
	}
}

struct BuildDiagnostics {
	root: PathBuf,
	pending: VecDeque<Option<BuildProblem>>,
	seen: HashSet<(ProblemSeverity, String, u32, Option<u32>, String)>,
	problems: Vec<BuildProblem>,
}

impl BuildDiagnostics {
	fn new(root: PathBuf) -> Self {
		Self {
			root,
			pending: VecDeque::new(),
			seen: HashSet::new(),
			problems: Vec::new(),
		}
	}

	fn push(&mut self, line: &str) {
		if self.pending.len() == 2 {
			self.flush_one(line);
		}
		self.pending
			.push_back(parse_build_problem_line(line, Some(&self.root)));
	}

	fn flush_one(&mut self, caret: &str) {
		if let Some(Some(mut problem)) = self.pending.pop_front() {
			let text = caret.trim_end();
			if problem.column.is_none()
				&& text.ends_with('^')
				&& text.chars().all(|c| matches!(c, ' ' | '\t' | '^'))
			{
				problem.column = text.find('^').map(|n| n as u32 + 1);
			}
			let key = (
				problem.severity,
				problem.file_path.clone(),
				problem.line,
				problem.column,
				problem.message.clone(),
			);
			if self.seen.insert(key) {
				self.problems.push(problem);
			}
		}
	}

	fn finish(&mut self) -> Vec<BuildProblem> {
		while !self.pending.is_empty() {
			self.flush_one("");
		}
		std::mem::take(&mut self.problems)
	}
}

#[cfg(test)]
fn parse_build_problems(lines: &[String], root: Option<&Path>) -> Vec<BuildProblem> {
	let mut diagnostics = BuildDiagnostics::new(root.unwrap_or(Path::new("")).to_owned());
	for line in lines {
		diagnostics.push(line);
	}
	diagnostics.finish()
}

pub fn parse_build_problem_line(line: &str, workspace_root: Option<&Path>) -> Option<BuildProblem> {
	let trimmed = line.trim();
	if trimmed.is_empty() {
		return None;
	}
	if let Some(problem) = parse_kotlin_dsl_problem(trimmed, workspace_root) {
		return Some(problem);
	}
	parse_javac_problem(trimmed, workspace_root)
}

fn parse_kotlin_dsl_problem(line: &str, workspace_root: Option<&Path>) -> Option<BuildProblem> {
	static RE: OnceLock<Regex> = OnceLock::new();
	let re = RE.get_or_init(|| {
		Regex::new(r"^([ewv]):\s+(?:file://)?((?:/?[A-Za-z]:)?[^:\r\n]+):(\d+):(\d+):?\s+(.+)$")
			.expect("valid kotlin diagnostic regex")
	});
	let caps = re.captures(line)?;
	let severity = match &caps[1] {
		"e" => ProblemSeverity::Error,
		"w" => ProblemSeverity::Warning,
		_ => ProblemSeverity::Info,
	};
	let file_path = normalize_file_uri_path(&caps[2]);
	let line_num = caps[3].parse::<u32>().ok()?;
	let col_num = caps[4].parse::<u32>().ok();
	let message = caps[5].trim().to_string();
	let rel_path = workspace_root.and_then(|root| compute_rel_path(&file_path, root));
	Some(BuildProblem {
		severity,
		file_path,
		rel_path,
		line: line_num,
		column: col_num,
		message,
	})
}

fn parse_javac_problem(line: &str, workspace_root: Option<&Path>) -> Option<BuildProblem> {
	static RE: OnceLock<Regex> = OnceLock::new();
	let re = RE.get_or_init(|| {
		Regex::new(r"^((?:[A-Za-z]:)?[^:\r\n]+):(\d+)(?::(\d+))?:\s+(error|warning|note):\s+(.+)$")
			.expect("valid javac diagnostic regex")
	});
	let caps = re.captures(line)?;
	let file_path = caps[1].trim().to_string();
	// Ignore URLs such as `https://...` matched accidentally before a port/line number.
	if file_path.starts_with("http") {
		return None;
	}
	let line_num = caps[2].parse::<u32>().ok()?;
	let col_num = caps.get(3).and_then(|m| m.as_str().parse::<u32>().ok());
	let severity = match &caps[4] {
		"error" => ProblemSeverity::Error,
		"warning" => ProblemSeverity::Warning,
		_ => ProblemSeverity::Info,
	};
	let message = caps[5].trim().to_string();
	let rel_path = workspace_root.and_then(|root| compute_rel_path(&file_path, root));
	Some(BuildProblem {
		severity,
		file_path,
		rel_path,
		line: line_num,
		column: col_num,
		message,
	})
}

fn normalize_file_uri_path(raw: &str) -> String {
	let bytes = raw.as_bytes();
	if bytes.len() >= 3 && bytes[0] == b'/' && bytes[1].is_ascii_alphabetic() && bytes[2] == b':' {
		raw[1..].to_string()
	} else {
		raw.to_string()
	}
}

fn compute_rel_path(file_path: &str, workspace_root: &Path) -> Option<String> {
	let norm_file = file_path.replace('\\', "/");
	let norm_root = workspace_root
		.to_string_lossy()
		.replace('\\', "/")
		.trim_end_matches('/')
		.to_string();
	#[cfg(windows)]
	let matches = norm_file
		.to_ascii_lowercase()
		.starts_with(&format!("{}/", norm_root.to_ascii_lowercase()));
	#[cfg(not(windows))]
	let matches = norm_file.starts_with(&format!("{}/", norm_root));
	if matches {
		Some(norm_file[norm_root.len() + 1..].to_string())
	} else {
		None
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn hundred_thousand_log_lines_preserve_final_diagnostic() {
		let mut diagnostics = BuildDiagnostics::new(PathBuf::from("workspace"));
		let mut buffered = Vec::new();
		let baseline = std::env::var_os("MODIUM_BENCH_BUFFER_LOG").is_some();
		for i in 0..100_000 {
			let line = if i == 99_999 {
				"Main.java:42: error: final diagnostic".into()
			} else {
				format!("Gradle worker {i:06} {}", ".".repeat(160))
			};
			if baseline {
				buffered.push(line);
			} else {
				diagnostics.push(&line);
			}
		}
		for line in &buffered {
			diagnostics.push(line);
		}
		let problems = diagnostics.finish();
		assert_eq!(problems.len(), 1);
		assert_eq!(problems[0].line, 42);
	}

	#[test]
	fn maps_all_gradle_tasks_without_shell_injection() {
		assert_eq!(
			gradle_args_for_task(GradleTaskKind::Build),
			["build", "--console=plain"]
		);
		assert_eq!(
			gradle_args_for_task(GradleTaskKind::RunClient),
			["runClient", "--console=plain"]
		);
		assert_eq!(
			gradle_args_for_task(GradleTaskKind::RunServer),
			["runServer", "--console=plain"]
		);
		assert_eq!(
			gradle_args_for_task(GradleTaskKind::Clean),
			["clean", "--console=plain"]
		);
		assert_eq!(
			gradle_args_for_task(GradleTaskKind::GenSources),
			["genSources", "--console=plain"]
		);
		assert_eq!(
			gradle_args_for_task(GradleTaskKind::Eclipse),
			["eclipse", "--console=plain"]
		);
		assert_eq!(
			gradle_args_for_task(GradleTaskKind::RefreshDependencies),
			["--refresh-dependencies", "--console=plain"]
		);
		assert_eq!(
			gradle_args_for_task(GradleTaskKind::CompileJava),
			["compileJava", "--console=plain"]
		);
	}

	#[test]
	fn parses_javac_and_kotlin_dsl_problems() {
		let root = PathBuf::from(r"D:\Mods\ExampleMod");
		let lines = vec![
			r"D:\Mods\ExampleMod\src\main\java\com\example\ExampleMod.java:18: error: cannot find symbol".to_string(),
			"        Identifier.missing();".to_string(),
			"                  ^".to_string(),
			r"D:\Mods\ExampleMod\src\main\java\com\example\Old.java:9: warning: [deprecation] foo in Bar has been deprecated".to_string(),
			"e: file:///D:/Mods/ExampleMod/build.gradle.kts:24:5: Unresolved reference: modImplementation".to_string(),
			"e: file:///D:/Mods/ExampleMod/settings.gradle.kts:10:2 Expecting an element".to_string(),
			"w: file:///D:/Mods/ExampleMod/build.gradle.kts:41:9: Parameter 'it' is never used".to_string(),
		];
		let problems = parse_build_problems(&lines, Some(&root));
		assert_eq!(problems.len(), 5);
		assert_eq!(problems[0].severity, ProblemSeverity::Error);
		assert_eq!(problems[0].line, 18);
		assert_eq!(problems[0].column, Some(19));
		assert_eq!(
			problems[0].rel_path.as_deref(),
			Some("src/main/java/com/example/ExampleMod.java")
		);
		assert_eq!(problems[1].severity, ProblemSeverity::Warning);
		assert_eq!(problems[2].severity, ProblemSeverity::Error);
		assert_eq!(problems[2].line, 24);
		assert_eq!(problems[2].column, Some(5));
		assert_eq!(problems[2].rel_path.as_deref(), Some("build.gradle.kts"));
		assert_eq!(problems[3].line, 10);
		assert_eq!(problems[3].column, Some(2));
		assert_eq!(problems[3].message, "Expecting an element");
		assert_eq!(problems[4].severity, ProblemSeverity::Warning);
	}

	#[tokio::test]
	async fn rejects_missing_gradle_wrapper() {
		let dir = std::env::temp_dir().join(format!("fs_gradle_missing_{}", uuid::Uuid::new_v4()));
		std::fs::create_dir_all(&dir).unwrap();
		let reg = ProcessRegistry::new();
		let err = run_gradle_task(None, &reg, &dir, GradleTaskKind::Build, None)
			.await
			.unwrap_err();
		assert!(err.contains("Gradle wrapper not found"));
		let _ = std::fs::remove_dir_all(&dir);
	}
}
