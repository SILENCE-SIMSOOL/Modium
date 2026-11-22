use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufReader, Read};
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use flate2::read::GzDecoder;
use serde_json::{json, Value};
use tar::Archive;
use tauri::{AppHandle, Emitter};
use tokio::io::{
	AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader as TokioBufReader,
};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot, Mutex};
use url::Url;
use zip::ZipArchive;

use crate::models::{
	LspDiagnostic, LspDiagnosticsEvent, LspStatusEvent, MinecraftClassEntry, ToolStatus,
	ToolsProgressEvent,
};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;
const JDTLS_LATEST_URL: &str = "https://download.eclipse.org/jdtls/snapshots/latest.txt";
const JDTLS_BASE_URL: &str = "https://download.eclipse.org/jdtls/snapshots/";
const JAVA_DEBUG_JAR_URL: &str = "https://repo1.maven.org/maven2/com/microsoft/java/com.microsoft.java.debug.plugin/0.53.1/com.microsoft.java.debug.plugin-0.53.1.jar";
const MAX_FRAME_BYTES: usize = 64 * 1024 * 1024;
const MAX_SOURCE_RESULTS: usize = 150;

pub(crate) type PendingRequests =
	Arc<std::sync::Mutex<HashMap<i64, oneshot::Sender<Result<Value, String>>>>>;

struct DownloadSpec<'a> {
	tool: &'a str,
	step: u32,
	total_steps: u32,
	percent_start: u32,
	percent_end: u32,
	label: &'a str,
}

static INSTALL_LOCK: Mutex<()> = Mutex::const_new(());

pub fn tools_root() -> PathBuf {
	dirs::data_local_dir()
		.unwrap_or_else(std::env::temp_dir)
		.join("FabricStudio")
		.join("tools")
}

fn jdtls_config_dir_name() -> &'static str {
	#[cfg(target_os = "windows")]
	{
		"config_win"
	}
	#[cfg(target_os = "macos")]
	{
		"config_mac"
	}
	#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
	{
		"config_linux"
	}
}

fn find_equinox_launcher(jdtls_dir: &Path) -> Option<PathBuf> {
	let plugins_dir = jdtls_dir.join("plugins");
	let entries = fs::read_dir(plugins_dir).ok()?;
	for entry in entries.flatten() {
		let path = entry.path();
		if !path.is_file() {
			continue;
		}
		if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
			if name.starts_with("org.eclipse.equinox.launcher_") && name.ends_with(".jar") {
				return Some(path);
			}
		}
	}
	None
}

pub fn runtime_java_minimum() -> u32 {
	let plugins = tools_root().join("jdtls/plugins");
	let mut minimum = 21;
	let Ok(entries) = fs::read_dir(plugins) else { return minimum };
	for entry in entries.flatten() {
		let name = entry.file_name();
		let name = name.to_string_lossy();
		if !["org.eclipse.core.filesystem_", "org.eclipse.core.resources_", "org.eclipse.jdt.ls.core_"]
			.iter().any(|prefix| name.starts_with(prefix)) || !name.ends_with(".jar") { continue; }
		let Some(mut jar) = File::open(entry.path()).ok().and_then(|f| ZipArchive::new(f).ok()) else { continue };
		let Ok(mut manifest) = jar.by_name("META-INF/MANIFEST.MF") else { continue };
		let mut contents = String::new();
		if manifest.read_to_string(&mut contents).is_err() { continue; }
		for line in contents.replace("\r\n ", "").lines() {
			if let Some(envs) = line.strip_prefix("Bundle-RequiredExecutionEnvironment:") {
				if let Some(version) = envs.split(',').filter_map(|s| s.trim().strip_prefix("JavaSE-")?.parse::<u32>().ok()).min() {
					minimum = minimum.max(version);
				}
			} else if line.starts_with("Require-Capability:") && line.contains("(osgi.ee=JavaSE)") {
				if let Some((_, tail)) = line.split_once("(osgi.ee=JavaSE)(version=") {
					if let Some(version) = tail.split(')').next().and_then(|s| s.parse::<u32>().ok()) { minimum = minimum.max(version); }
				}
			}
		}
	}
	minimum
}

pub fn get_tool_status() -> ToolStatus {
	let root = tools_root();
	let jdtls_dir = root.join("jdtls");
	let config_dir = jdtls_dir.join(jdtls_config_dir_name());
	let launcher = find_equinox_launcher(&jdtls_dir);
	let jdtls_installed = launcher.is_some() && config_dir.is_dir();
	let jdtls_path = jdtls_installed.then(|| jdtls_dir.to_string_lossy().to_string());

	let java_debug_jar = root
		.join("java-debug")
		.join("com.microsoft.java.debug.plugin.jar");
	let java_debug_installed = java_debug_jar.is_file();
	let java_debug_path =
		java_debug_installed.then(|| java_debug_jar.to_string_lossy().to_string());

	ToolStatus {
		jdtls_installed,
		jdtls_path,
		java_debug_installed,
		java_debug_path,
		tools_root: root.to_string_lossy().to_string(),
	}
}

fn emit_tools_progress(
	app: Option<&AppHandle>,
	tool: &str,
	step: u32,
	total_steps: u32,
	percent: u32,
	message: impl Into<String>,
) {
	if let Some(handle) = app {
		let payload = ToolsProgressEvent {
			tool: tool.to_string(),
			step,
			total_steps,
			percent,
			message: message.into(),
		};
		let _ = handle.emit("tools:progress", payload);
	}
}

fn emit_lsp_status(
	app: Option<&AppHandle>,
	state: &str,
	message: impl Into<String>,
	percent: Option<u32>,
) {
	if let Some(handle) = app {
		let payload = LspStatusEvent {
			state: state.to_string(),
			message: message.into(),
			percent,
		};
		let _ = handle.emit("lsp:status", payload);
	}
}

async fn download_to_file(
	client: &reqwest::Client,
	url: &str,
	dest: &Path,
	app: Option<&AppHandle>,
	spec: DownloadSpec<'_>,
) -> Result<(), String> {
	if let Some(parent) = dest.parent() {
		tokio::fs::create_dir_all(parent)
			.await
			.map_err(|e| format!("Failed to create directory {}: {e}", parent.display()))?;
	}
	let mut resp = client
		.get(url)
		.send()
		.await
		.map_err(|e| format!("Failed to request {url}: {e}"))?;
	if !resp.status().is_success() {
		return Err(format!("HTTP {} while downloading {url}", resp.status()));
	}

	let total_len = resp.content_length();
	let part_path = dest.with_extension("part");
	let mut file = tokio::fs::File::create(&part_path)
		.await
		.map_err(|e| format!("Failed to create {}: {e}", part_path.display()))?;

	let mut downloaded: u64 = 0;
	let mut last_percent = spec.percent_start;
	let mut last_emit = Instant::now();

	while let Some(chunk) = resp
		.chunk()
		.await
		.map_err(|e| format!("Stream error downloading {url}: {e}"))?
	{
		file.write_all(&chunk)
			.await
			.map_err(|e| format!("Write error for {}: {e}", part_path.display()))?;
		downloaded += chunk.len() as u64;

		if let Some(total) = total_len {
			if total > 0 {
				let span = spec.percent_end.saturating_sub(spec.percent_start) as f64;
				let frac = (downloaded as f64 / total as f64).min(1.0);
				let pct = spec.percent_start + (span * frac) as u32;
				if pct >= last_percent + 3 || last_emit.elapsed() >= Duration::from_millis(250) {
					last_percent = pct;
					last_emit = Instant::now();
					let mb_done = downloaded as f64 / (1024.0 * 1024.0);
					let mb_total = total as f64 / (1024.0 * 1024.0);
					emit_tools_progress(
						app,
						spec.tool,
						spec.step,
						spec.total_steps,
						pct,
						format!("{} ({mb_done:.1} / {mb_total:.1} MB)", spec.label),
					);
				}
			}
		}
	}

	file.flush()
		.await
		.map_err(|e| format!("Flush error for {}: {e}", part_path.display()))?;
	drop(file);

	if dest.exists() {
		let _ = tokio::fs::remove_file(dest).await;
	}
	tokio::fs::rename(&part_path, dest)
		.await
		.map_err(|e| format!("Failed to finalize {}: {e}", dest.display()))?;
	Ok(())
}

fn unpack_tar_gz_safe(archive_path: &Path, target_dir: &Path) -> Result<(), String> {
	let tmp_dir = target_dir.with_file_name("jdtls-extract-tmp");
	if tmp_dir.exists() {
		fs::remove_dir_all(&tmp_dir)
			.map_err(|e| format!("Failed to clean {}: {e}", tmp_dir.display()))?;
	}
	fs::create_dir_all(&tmp_dir)
		.map_err(|e| format!("Failed to create {}: {e}", tmp_dir.display()))?;

	let file = File::open(archive_path)
		.map_err(|e| format!("Failed to open {}: {e}", archive_path.display()))?;
	let decoder = GzDecoder::new(BufReader::new(file));
	let mut archive = Archive::new(decoder);

	let entries = archive
		.entries()
		.map_err(|e| format!("Failed to read tar entries: {e}"))?;
	for entry_res in entries {
		let mut entry = entry_res.map_err(|e| format!("Corrupt tar entry: {e}"))?;
		let rel = entry
			.path()
			.map_err(|e| format!("Invalid tar entry path: {e}"))?
			.into_owned();
		for comp in rel.components() {
			if matches!(
				comp,
				Component::ParentDir | Component::RootDir | Component::Prefix(_)
			) {
				return Err(format!("Unsafe archive entry path: {}", rel.display()));
			}
		}
		if !entry
			.unpack_in(&tmp_dir)
			.map_err(|e| format!("Failed to extract {}: {e}", rel.display()))?
		{
			return Err(format!("Entry escaped target directory: {}", rel.display()));
		}
	}

	if target_dir.exists() {
		fs::remove_dir_all(target_dir)
			.map_err(|e| format!("Failed to replace {}: {e}", target_dir.display()))?;
	}
	fs::rename(&tmp_dir, target_dir).map_err(|e| {
		format!(
			"Failed to move extracted JDT LS into {}: {e}",
			target_dir.display()
		)
	})?;
	Ok(())
}

pub async fn ensure_jdtls_installed(app: Option<&AppHandle>) -> Result<ToolStatus, String> {
	let current = get_tool_status();
	if current.jdtls_installed && current.java_debug_installed {
		return Ok(current);
	}

	let _guard = INSTALL_LOCK.lock().await;
	let current = get_tool_status();
	if current.jdtls_installed && current.java_debug_installed {
		return Ok(current);
	}

	let root = tools_root();
	tokio::fs::create_dir_all(&root)
		.await
		.map_err(|e| format!("Failed to create tools directory {}: {e}", root.display()))?;

	let client = reqwest::Client::builder()
		.user_agent("Modium/0.1.0")
		.timeout(Duration::from_secs(300))
		.build()
		.map_err(|e| format!("Failed to build HTTP client: {e}"))?;

	if !current.jdtls_installed {
		emit_tools_progress(
			app,
			"jdtls",
			1,
			4,
			5,
			"Checking latest Eclipse JDT.LS snapshot...",
		);
		let latest_resp = client
			.get(JDTLS_LATEST_URL)
			.send()
			.await
			.map_err(|e| format!("Failed to fetch {JDTLS_LATEST_URL}: {e}"))?;
		if !latest_resp.status().is_success() {
			return Err(format!(
				"HTTP {} fetching JDT.LS snapshot metadata",
				latest_resp.status()
			));
		}
		let filename = latest_resp
			.text()
			.await
			.map_err(|e| format!("Failed to read latest.txt: {e}"))?
			.trim()
			.to_string();
		if filename.is_empty()
			|| !filename.ends_with(".tar.gz")
			|| filename.contains('/')
			|| filename.contains('\\')
			|| filename.contains("..")
		{
			return Err(format!("Unexpected JDT.LS snapshot filename: {filename}"));
		}

		let archive_url = format!("{JDTLS_BASE_URL}{filename}");
		let archive_path = root.join(&filename);
		emit_tools_progress(app, "jdtls", 1, 4, 8, format!("Downloading {filename}..."));
		download_to_file(
			&client,
			&archive_url,
			&archive_path,
			app,
			DownloadSpec {
				tool: "jdtls",
				step: 1,
				total_steps: 4,
				percent_start: 8,
				percent_end: 50,
				label: &format!("Downloading {filename}"),
			},
		)
		.await?;

		emit_tools_progress(app, "jdtls", 2, 4, 55, "Extracting Eclipse JDT.LS...");
		let jdtls_dir = root.join("jdtls");
		let archive_clone = archive_path.clone();
		let jdtls_clone = jdtls_dir.clone();
		let unpack_res = tokio::task::spawn_blocking(move || {
			let res = unpack_tar_gz_safe(&archive_clone, &jdtls_clone);
			let _ = fs::remove_file(&archive_clone);
			res
		})
		.await
		.map_err(|e| format!("JDT.LS unpack task panicked: {e}"))?;
		unpack_res?;
	}

	if !current.java_debug_installed {
		emit_tools_progress(
			app,
			"java-debug",
			3,
			4,
			75,
			"Downloading Microsoft Java Debug Server...",
		);
		let debug_jar_path = root
			.join("java-debug")
			.join("com.microsoft.java.debug.plugin.jar");
		download_to_file(
			&client,
			JAVA_DEBUG_JAR_URL,
			&debug_jar_path,
			app,
			DownloadSpec {
				tool: "java-debug",
				step: 3,
				total_steps: 4,
				percent_start: 75,
				percent_end: 95,
				label: "Downloading Java Debug Server",
			},
		)
		.await?;
	}

	let final_status = get_tool_status();
	if !final_status.jdtls_installed || !final_status.java_debug_installed {
		return Err("Tool installation finished, but required artifacts are still missing".into());
	}

	emit_tools_progress(
		app,
		"jdtls",
		4,
		4,
		100,
		"JDT.LS and Java Debug Server ready",
	);
	Ok(final_status)
}

pub fn encode_lsp_frame(payload: &[u8]) -> Vec<u8> {
	let header = format!("Content-Length: {}\r\n\r\n", payload.len());
	let mut frame = Vec::with_capacity(header.len() + payload.len());
	frame.extend_from_slice(header.as_bytes());
	frame.extend_from_slice(payload);
	frame
}

pub fn encode_lsp_json(value: &Value) -> Result<Vec<u8>, String> {
	let bytes = serde_json::to_vec(value)
		.map_err(|e| format!("Failed to serialize JSON-RPC message: {e}"))?;
	Ok(encode_lsp_frame(&bytes))
}

pub async fn read_lsp_message<R: AsyncBufRead + Unpin>(
	reader: &mut R,
) -> Result<Option<Value>, String> {
	let mut content_length: Option<usize> = None;
	let mut saw_header = false;

	loop {
		let mut line = String::new();
		let bytes_read = reader
			.read_line(&mut line)
			.await
			.map_err(|e| format!("Failed to read header line: {e}"))?;
		if bytes_read == 0 {
			if !saw_header {
				return Ok(None);
			}
			return Err("Unexpected EOF while reading frame headers".into());
		}

		let trimmed = line.trim_end_matches(['\r', '\n']);
		if trimmed.is_empty() {
			if saw_header {
				break;
			}
			continue;
		}
		saw_header = true;

		if let Some((name, val)) = trimmed.split_once(':') {
			if name.trim().eq_ignore_ascii_case("content-length") {
				let parsed = val
					.trim()
					.parse::<usize>()
					.map_err(|e| format!("Invalid Content-Length header '{val}': {e}"))?;
				content_length = Some(parsed);
			}
		} else {
			return Err(format!("Malformed frame header line: {trimmed}"));
		}
	}

	let len = content_length.ok_or_else(|| "Missing Content-Length header".to_string())?;
	if len == 0 || len > MAX_FRAME_BYTES {
		return Err(format!("Invalid Content-Length size: {len}"));
	}

	let mut body = vec![0u8; len];
	reader
		.read_exact(&mut body)
		.await
		.map_err(|e| format!("Unexpected EOF reading {len}-byte payload: {e}"))?;

	let value = serde_json::from_slice::<Value>(&body)
		.map_err(|e| format!("Failed to parse JSON-RPC payload: {e}"))?;
	Ok(Some(value))
}

fn fnv1a_64_hex(input: &str) -> String {
	let mut hash: u64 = 0xcbf29ce484222325;
	for byte in input.as_bytes() {
		hash ^= *byte as u64;
		hash = hash.wrapping_mul(0x100000001b3);
	}
	format!("{hash:016x}")
}

fn project_data_dir(root: &Path) -> PathBuf {
	let canon = fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
	let normalized = canon.to_string_lossy().to_lowercase();
	let hash = fnv1a_64_hex(&normalized);
	dirs::data_local_dir()
		.unwrap_or_else(std::env::temp_dir)
		.join("FabricStudio")
		.join("jdtls-data")
		.join(hash)
}

fn parse_java_major_from_release(jdk_home: &Path) -> Option<u32> {
	let content = fs::read_to_string(jdk_home.join("release")).ok()?;
	for line in content.lines() {
		if let Some(raw) = line.strip_prefix("JAVA_VERSION=") {
			let ver = raw.trim().trim_matches('"');
			let first = ver.split(['.', '-', '_', '+']).next()?;
			let major = first.parse::<u32>().ok()?;
			if major == 1 {
				let second = ver.split(['.', '-', '_', '+']).nth(1)?;
				return second.parse::<u32>().ok();
			}
			return Some(major);
		}
	}
	None
}

fn runtime_entry_name(major: u32) -> String {
	if major <= 8 {
		"JavaSE-1.8".to_string()
	} else {
		format!("JavaSE-{major}")
	}
}

fn collect_jdk_candidates() -> Vec<PathBuf> {
	let mut dirs = Vec::new();
	if let Some(java_home) = std::env::var_os("JAVA_HOME") {
		dirs.push(PathBuf::from(java_home));
	}
	#[cfg(windows)]
	{
		let roots = [
			r"C:\Program Files\Java",
			r"C:\Program Files\Eclipse Adoptium",
			r"C:\Program Files\Microsoft",
			r"C:\Program Files\Zulu",
			r"C:\Program Files\Amazon Corretto",
		];
		for root in roots {
			if let Ok(entries) = fs::read_dir(root) {
				for entry in entries.flatten() {
					if entry.path().is_dir() {
						dirs.push(entry.path());
					}
				}
			}
		}
	}
	#[cfg(not(windows))]
	{
		if let Ok(entries) = fs::read_dir("/usr/lib/jvm") {
			for entry in entries.flatten() {
				if entry.path().is_dir() {
					dirs.push(entry.path());
				}
			}
		}
	}
	if let Some(home) = dirs::home_dir() {
		let jdks = home.join(".jdks");
		if let Ok(entries) = fs::read_dir(jdks) {
			for entry in entries.flatten() {
				if entry.path().is_dir() {
					dirs.push(entry.path());
				}
			}
		}
	}
	dirs
}

fn build_java_runtimes(runtime_java_home: &Path, project_java_home: Option<&Path>) -> Vec<Value> {
	let default_jdk = project_java_home.unwrap_or(runtime_java_home);
	let mut seen_names = HashSet::new();
	let mut runtimes = Vec::new();

	let default_major = parse_java_major_from_release(default_jdk).unwrap_or(21);
	let default_name = runtime_entry_name(default_major);
	seen_names.insert(default_name.clone());
	runtimes.push(json!({
		"name": default_name,
		"path": default_jdk.to_string_lossy(),
		"default": true
	}));

	let mut extra_candidates = vec![runtime_java_home.to_path_buf()];
	extra_candidates.extend(collect_jdk_candidates());
	for candidate in extra_candidates {
		if candidate == default_jdk {
			continue;
		}
		if let Some(major) = parse_java_major_from_release(&candidate) {
			let name = runtime_entry_name(major);
			if seen_names.insert(name.clone()) {
				runtimes.push(json!({
					"name": name,
					"path": candidate.to_string_lossy(),
					"default": false
				}));
			}
		}
	}

	runtimes
}

fn canonical_path_key(uri_or_path: &str) -> Option<String> {
	let path = if uri_or_path.starts_with("file://") {
		Url::parse(uri_or_path).ok()?.to_file_path().ok()?
	} else if uri_or_path.contains("://") {
		return None;
	} else {
		PathBuf::from(uri_or_path)
	};
	let mut s = path.to_string_lossy().replace('\\', "/");
	if let Some(stripped) = s.strip_prefix("//?/") {
		s = stripped.to_string();
	}
	#[cfg(windows)]
	{
		s = s.to_lowercase();
	}
	Some(s)
}

fn normalize_lsp_uri(uri_or_path: &str) -> Result<String, String> {
	if uri_or_path.starts_with("file://") {
		if let Ok(url) = Url::parse(uri_or_path) {
			if let Ok(path) = url.to_file_path() {
				if let Ok(clean) = Url::from_file_path(path) {
					return Ok(clean.to_string());
				}
			}
		}
		return Ok(uri_or_path.to_string());
	}
	if uri_or_path.contains("://") {
		return Ok(uri_or_path.to_string());
	}
	let path = Path::new(uri_or_path);
	Url::from_file_path(path)
		.map(|u| u.to_string())
		.map_err(|_| format!("Invalid file path for LSP URI: {uri_or_path}"))
}

fn parse_diagnostics_event(
	params: &Value,
	uri_aliases: &std::sync::Mutex<HashMap<String, String>>,
) -> Option<LspDiagnosticsEvent> {
	let server_uri = params.get("uri")?.as_str()?;
	let uri = canonical_path_key(server_uri)
		.and_then(|key| uri_aliases.lock().ok().and_then(|m| m.get(&key).cloned()))
		.unwrap_or_else(|| server_uri.to_string());
	let arr = params.get("diagnostics")?.as_array()?;
	let mut diagnostics = Vec::with_capacity(arr.len());

	for item in arr {
		let range = item.get("range")?;
		let start = range.get("start")?;
		let end = range.get("end")?;
		let code = match item.get("code") {
			Some(Value::String(s)) => Some(s.clone()),
			Some(Value::Number(n)) => Some(n.to_string()),
			_ => None,
		};
		diagnostics.push(LspDiagnostic {
			range_start_line: start.get("line").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
			range_start_char: start.get("character").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
			range_end_line: end.get("line").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
			range_end_char: end.get("character").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
			severity: item.get("severity").and_then(|v| v.as_u64()).unwrap_or(1) as u32,
			code,
			source: item
				.get("source")
				.and_then(|v| v.as_str())
				.map(|s| s.to_string()),
			message: item
				.get("message")
				.and_then(|v| v.as_str())
				.unwrap_or("")
				.to_string(),
		});
	}

	Some(LspDiagnosticsEvent { uri, diagnostics })
}

fn normalize_code_action_diagnostic(item: Value) -> Value {
	if item.get("range").is_some() {
		return item;
	}
	if item.get("rangeStartLine").is_some() {
		let mut out = json!({
			"range": {
				"start": {
					"line": item.get("rangeStartLine").and_then(|v| v.as_u64()).unwrap_or(0),
					"character": item.get("rangeStartChar").and_then(|v| v.as_u64()).unwrap_or(0)
				},
				"end": {
					"line": item.get("rangeEndLine").and_then(|v| v.as_u64()).unwrap_or(0),
					"character": item.get("rangeEndChar").and_then(|v| v.as_u64()).unwrap_or(0)
				}
			},
			"severity": item.get("severity").and_then(|v| v.as_u64()).unwrap_or(1),
			"message": item.get("message").and_then(|v| v.as_str()).unwrap_or("")
		});
		if let Some(code) = item.get("code").filter(|v| !v.is_null()) {
			out["code"] = code.clone();
		}
		if let Some(src) = item.get("source").filter(|v| !v.is_null()) {
			out["source"] = src.clone();
		}
		return out;
	}
	item
}

#[derive(Default)]
struct ImportChoices {
	uri: String,
	selected: Vec<String>,
	groups: Vec<Vec<String>>,
}
impl ImportChoices {
	fn reply(&mut self, args: &Value) -> Value {
		if self.uri.is_empty() || args[0].as_str().and_then(canonical_path_key) != canonical_path_key(&self.uri) { return Value::Null; }
		let Some(groups) = args[1].as_array() else { return Value::Null };
		let mut answers = Vec::new();
		self.groups.clear();
		for (i, group) in groups.iter().enumerate() {
			let Some(candidates) = group["candidates"].as_array() else { return Value::Null };
			self.groups.push(candidates.iter().filter_map(|c| c["fullyQualifiedName"].as_str().map(str::to_owned)).collect());
			if let Some(choice) = self.selected.get(i) {
				if let Some(candidate) = candidates.iter().find(|c| c["fullyQualifiedName"].as_str() == Some(choice.as_str())) { answers.push(candidate.clone()); }
			}
		}
		if answers.len() == groups.len() { self.groups.clear(); json!(answers) } else { Value::Null }
	}
}

struct LspClient {
	semantic_legend: std::sync::OnceLock<Value>,
	import_lock: Mutex<()>,
	import_choices: Arc<std::sync::Mutex<ImportChoices>>,
	writer_tx: mpsc::Sender<Vec<u8>>,
	next_id: AtomicI64,
	pending: PendingRequests,
	uri_aliases: Arc<std::sync::Mutex<HashMap<String, String>>>,
	child: Mutex<Option<Child>>,
	pid: Option<u32>,
	app: Option<AppHandle>,
}

impl LspClient {
	fn remember_uri_alias(&self, raw_uri: &str) {
		if let Some(key) = canonical_path_key(raw_uri) {
			if let Ok(mut map) = self.uri_aliases.lock() {
				map.insert(key, raw_uri.to_string());
			}
		}
	}

	fn forget_uri_alias(&self, raw_uri: &str) {
		if let Some(key) = canonical_path_key(raw_uri) {
			if let Ok(mut map) = self.uri_aliases.lock() {
				map.remove(&key);
			}
		}
	}
	async fn send_raw(&self, value: &Value) -> Result<(), String> {
		let frame = encode_lsp_json(value)?;
		self.writer_tx
			.send(frame)
			.await
			.map_err(|_| "Language server stdin channel is closed".to_string())
	}

	async fn request(
		&self,
		method: &str,
		params: Value,
		timeout_dur: Duration,
	) -> Result<Value, String> {
		let id = self.next_id.fetch_add(1, Ordering::SeqCst);
		let (tx, rx) = oneshot::channel();
		{
			let mut map = self
				.pending
				.lock()
				.map_err(|_| "Pending LSP map poisoned".to_string())?;
			map.insert(id, tx);
		}

		let payload = json!({
			"jsonrpc": "2.0",
			"id": id,
			"method": method,
			"params": params
		});
		if let Err(err) = self.send_raw(&payload).await {
			if let Ok(mut map) = self.pending.lock() {
				map.remove(&id);
			}
			return Err(err);
		}

		match tokio::time::timeout(timeout_dur, rx).await {
			Ok(Ok(res)) => res,
			Ok(Err(_)) => Err(format!("LSP server closed while awaiting '{method}'")),
			Err(_) => {
				if let Ok(mut map) = self.pending.lock() {
					map.remove(&id);
				}
				Err(format!("LSP request '{method}' timed out"))
			}
		}
	}

	async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
		let payload = json!({
			"jsonrpc": "2.0",
			"method": method,
			"params": params
		});
		self.send_raw(&payload).await
	}

	async fn shutdown_and_kill(&self) {
		let _ = self
			.request("shutdown", Value::Null, Duration::from_secs(2))
			.await;
		let _ = self.notify("exit", json!({})).await;

		let mut child_guard = self.child.lock().await;
		if let Some(mut child) = child_guard.take() {
			let waited = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
			if waited.is_err() {
				if let Some(pid) = self.pid {
					kill_pid_tree(pid).await;
				}
				let _ = child.kill().await;
			}
		} else if let Some(pid) = self.pid {
			kill_pid_tree(pid).await;
		}
		emit_lsp_status(
			self.app.as_ref(),
			"stopped",
			"Language server stopped",
			None,
		);
	}
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

fn handle_server_notification(
	app: Option<&AppHandle>,
	method: &str,
	params: &Value,
	uri_aliases: &std::sync::Mutex<HashMap<String, String>>,
	ready_seen: &AtomicBool,
) {
	match method {
		"textDocument/publishDiagnostics" => {
			if let (Some(handle), Some(ev)) = (app, parse_diagnostics_event(params, uri_aliases)) {
				let _ = handle.emit("lsp:diagnostics", ev);
			}
		}
		"language/status" => {
			let kind = params
				.get("type")
				.and_then(|v| v.as_str())
				.unwrap_or("Message");
			let msg = params.get("message").and_then(|v| v.as_str()).unwrap_or("");
			let (state, percent) = match kind {
				"Started" => {
					ready_seen.store(true, Ordering::SeqCst);
					("ready", Some(100))
				}
				"Starting" => ("indexing", None),
				"Error" => ("error", None),
				_ => ("info", None),
			};
			emit_lsp_status(app, state, msg, percent);
		}
		"$/progress" => {
			if let Some(val) = params.get("value") {
				let kind = val.get("kind").and_then(|v| v.as_str()).unwrap_or("");
				let title = val.get("title").and_then(|v| v.as_str()).unwrap_or("");
				let detail = val.get("message").and_then(|v| v.as_str()).unwrap_or("");
				let msg = match (title.is_empty(), detail.is_empty()) {
					(false, false) => format!("{title}: {detail}"),
					(false, true) => title.to_string(),
					(true, false) => detail.to_string(),
					(true, true) => "Indexing project...".to_string(),
				};
				let pct = val
					.get("percentage")
					.and_then(|v| v.as_u64())
					.map(|p| p.min(100) as u32);
				match kind {
					"begin" => emit_lsp_status(app, "indexing", msg, pct.or(Some(0))),
					"report" => emit_lsp_status(app, "indexing", msg, pct),
					"end" => emit_lsp_status(app, "ready", msg, Some(100)),
					_ => {}
				}
			}
		}
		_ => {}
	}
}

fn build_server_request_reply(method: &str, params: &Value, java_settings: &Value) -> Value {
	match method {
		"workspace/configuration" => {
			let items = params
				.get("items")
				.and_then(|v| v.as_array())
				.map(|arr| {
					arr.iter()
						.map(|item| {
							let section =
								item.get("section").and_then(|s| s.as_str()).unwrap_or("");
							if section == "java" {
								java_settings.clone()
							} else if let Some(sub) = section.strip_prefix("java.") {
								let mut cur = java_settings;
								for seg in sub.split('.') {
									match cur.get(seg) {
										Some(next) => cur = next,
										None => return Value::Null,
									}
								}
								cur.clone()
							} else {
								Value::Null
							}
						})
						.collect::<Vec<Value>>()
				})
				.unwrap_or_default();
			Value::Array(items)
		}
		"workspace/applyEdit" => json!({ "applied": false }),
		_ => Value::Null,
	}
}

pub struct LspManager {
	client: Mutex<Option<Arc<LspClient>>>,
}

impl Default for LspManager {
	fn default() -> Self {
		Self::new()
	}
}

impl LspManager {
	pub fn new() -> Self {
		Self {
			client: Mutex::new(None),
		}
	}

	pub fn get_tool_status() -> ToolStatus {
		get_tool_status()
	}

	pub async fn ensure_jdtls_installed(app: Option<&AppHandle>) -> Result<ToolStatus, String> {
		ensure_jdtls_installed(app).await
	}

	async fn active_client(&self) -> Result<Arc<LspClient>, String> {
		let guard = self.client.lock().await;
		guard
			.as_ref()
			.cloned()
			.ok_or_else(|| "Language server is not running".to_string())
	}

	pub async fn is_running(&self) -> bool {
		self.client.lock().await.is_some()
	}

	pub async fn start_language_server(
		&self,
		app: Option<AppHandle>,
		root: PathBuf,
		runtime_java_home: PathBuf,
		project_java_home: Option<PathBuf>,
	) -> Result<(), String> {
		self.stop().await;

		let status = ensure_jdtls_installed(app.as_ref()).await?;
		let tools = tools_root();
		let jdtls_dir = tools.join("jdtls");
		let launcher = find_equinox_launcher(&jdtls_dir).ok_or_else(|| {
			"Eclipse Equinox launcher JAR not found in JDT.LS plugins".to_string()
		})?;
		let config_dir = jdtls_dir.join(jdtls_config_dir_name());
		if !config_dir.is_dir() {
			return Err(format!(
				"JDT.LS config directory missing: {}",
				config_dir.display()
			));
		}

		let java_bin =
			runtime_java_home
				.join("bin")
				.join(if cfg!(windows) { "java.exe" } else { "java" });
		if !java_bin.is_file() {
			return Err(format!(
				"Java executable not found at {}",
				java_bin.display()
			));
		}

		let data_dir = project_data_dir(&root);
		tokio::fs::create_dir_all(&data_dir)
			.await
			.map_err(|e| format!("Failed to create JDT.LS workspace data dir: {e}"))?;

		emit_lsp_status(
			app.as_ref(),
			"starting",
			"Starting Eclipse JDT.LS...",
			Some(10),
		);

		let mut cmd = Command::new(&java_bin);
		cmd.args([
			"-Declipse.application=org.eclipse.jdt.ls.core.id1",
			"-Dosgi.bundles.defaultStartLevel=4",
			"-Declipse.product=org.eclipse.jdt.ls.core.product",
			"-Dlog.level=ALL",
			"-Xmx1G",
			"--add-modules=ALL-SYSTEM",
			"--add-opens",
			"java.base/java.util=ALL-UNNAMED",
			"--add-opens",
			"java.base/java.lang=ALL-UNNAMED",
			"-jar",
		]);
		cmd.arg(&launcher);
		cmd.arg("-configuration");
		cmd.arg(&config_dir);
		cmd.arg("-data");
		cmd.arg(&data_dir);
		cmd.current_dir(&root);
		cmd.stdin(Stdio::piped())
			.stdout(Stdio::piped())
			.stderr(Stdio::piped());
		#[cfg(windows)]
		cmd.creation_flags(CREATE_NO_WINDOW);

		let mut child = cmd
			.spawn()
			.map_err(|e| format!("Failed to launch JDT.LS process: {e}"))?;
		let pid = child.id();
		let mut stdin = child
			.stdin
			.take()
			.ok_or_else(|| "Failed to attach JDT.LS stdin".to_string())?;
		let stdout = child
			.stdout
			.take()
			.ok_or_else(|| "Failed to attach JDT.LS stdout".to_string())?;
		let stderr = child
			.stderr
			.take()
			.ok_or_else(|| "Failed to attach JDT.LS stderr".to_string())?;

		let (writer_tx, mut writer_rx) = mpsc::channel::<Vec<u8>>(128);
		tokio::spawn(async move {
			while let Some(bytes) = writer_rx.recv().await {
				if stdin.write_all(&bytes).await.is_err() {
					break;
				}
				if stdin.flush().await.is_err() {
					break;
				}
			}
		});

		tokio::spawn(async move {
			let mut err_reader = TokioBufReader::new(stderr);
			let mut line = String::new();
			loop {
				line.clear();
				match err_reader.read_line(&mut line).await {
					Ok(0) | Err(_) => break,
					Ok(_) => {}
				}
			}
		});

		let project_jdk = project_java_home
			.as_deref()
			.unwrap_or(runtime_java_home.as_path());
		let runtimes = build_java_runtimes(&runtime_java_home, project_java_home.as_deref());
		let java_settings = json!({
			"home": project_jdk.to_string_lossy(),
			"import": {
				"gradle": {
					"enabled": true,
					"wrapper": { "enabled": true },
					"java": { "home": project_jdk.to_string_lossy() }
				}
			},
			"eclipse": { "downloadSources": true },
			"autobuild": { "enabled": true },
			"configuration": {
				"runtimes": runtimes
			}
		});

		let pending: PendingRequests = Arc::new(std::sync::Mutex::new(HashMap::new()));
		let uri_aliases: Arc<std::sync::Mutex<HashMap<String, String>>> =
			Arc::new(std::sync::Mutex::new(HashMap::new()));
		let ready_seen = Arc::new(AtomicBool::new(false));

		let reader_pending = Arc::clone(&pending);
		let reader_aliases = Arc::clone(&uri_aliases);
		let reader_ready = Arc::clone(&ready_seen);
		let reader_tx = writer_tx.clone();
		let import_choices = Arc::new(std::sync::Mutex::new(ImportChoices::default()));
		let reader_choices = import_choices.clone();
		let reader_app = app.clone();
		let reader_settings = java_settings.clone();
		tokio::spawn(async move {
			let mut buf_reader = TokioBufReader::new(stdout);
			loop {
				match read_lsp_message(&mut buf_reader).await {
					Ok(Some(msg)) => {
						let id_val = msg.get("id").cloned();
						let method = msg.get("method").and_then(|m| m.as_str());

						match (id_val, method) {
							(Some(id), Some(req_method)) => {
								let params = msg.get("params").unwrap_or(&Value::Null);
								let result = if req_method == "workspace/executeClientCommand" && params["command"] == "java.action.organizeImports.chooseImports" {
									reader_choices.lock().unwrap().reply(&params["arguments"])
								} else { build_server_request_reply(req_method, params, &reader_settings) };
								let reply = json!({
									"jsonrpc": "2.0",
									"id": id,
									"result": result
								});
								if let Ok(frame) = encode_lsp_json(&reply) {
									let _ = reader_tx.send(frame).await;
								}
							}
							(Some(id), None) => {
								if let Some(num_id) = id.as_i64() {
									let sender = reader_pending
										.lock()
										.ok()
										.and_then(|mut map| map.remove(&num_id));
									if let Some(tx) = sender {
										if let Some(err) = msg.get("error").filter(|v| !v.is_null())
										{
											let _ = tx.send(Err(err.to_string()));
										} else {
											let res =
												msg.get("result").cloned().unwrap_or(Value::Null);
											let _ = tx.send(Ok(res));
										}
									}
								}
							}
							(None, Some(notif_method)) => {
								let params = msg.get("params").unwrap_or(&Value::Null);
								handle_server_notification(
									reader_app.as_ref(),
									notif_method,
									params,
									&reader_aliases,
									&reader_ready,
								);
							}
							(None, None) => {}
						}
					}
					Ok(None) | Err(_) => {
						if let Ok(mut map) = reader_pending.lock() {
							for (_, tx) in map.drain() {
								let _ = tx.send(Err("JDT.LS stdout stream closed".to_string()));
							}
						}
						break;
					}
				}
			}
		});

		let client = Arc::new(LspClient {
			semantic_legend: Default::default(),
			import_choices,
			import_lock: Mutex::new(()),
			writer_tx,
			next_id: AtomicI64::new(1),
			pending,
			uri_aliases,
			child: Mutex::new(Some(child)),
			pid,
			app: app.clone(),
		});

		let root_uri = Url::from_file_path(&root)
			.map_err(|_| format!("Invalid workspace path: {}", root.display()))?
			.to_string();
		let root_name = root
			.file_name()
			.and_then(|n| n.to_str())
			.unwrap_or("workspace")
			.to_string();

		let bundles: Vec<String> = status.java_debug_path.into_iter().collect();

		let init_params = json!({
			"processId": std::process::id(),
			"rootUri": root_uri,
			"workspaceFolders": [{
				"uri": root_uri,
				"name": root_name
			}],
			"capabilities": {
				"textDocument": {
					"synchronization": {
						"dynamicRegistration": false,
						"willSave": false,
						"willSaveWaitUntil": false,
						"didSave": true
					},
					"completion": {
						"dynamicRegistration": false,
						"completionItem": {
							"snippetSupport": true,
							"commitCharactersSupport": true,
							"documentationFormat": ["markdown", "plaintext"],
							"deprecatedSupport": true,
							"preselectSupport": true,
							"labelDetailsSupport": true
						},
						"contextSupport": true
					},
					"hover": {
						"dynamicRegistration": false,
						"contentFormat": ["markdown", "plaintext"]
					},
					"definition": {
						"dynamicRegistration": false,
						"linkSupport": true
					},
					"references": { "dynamicRegistration": false },
					"rename": {
						"dynamicRegistration": false,
						"prepareSupport": false
					},
					"codeAction": {
						"dynamicRegistration": false,
						"codeActionLiteralSupport": {
							"codeActionKind": {
								"valueSet": [
									"quickfix",
									"refactor",
									"refactor.extract",
									"refactor.inline",
									"refactor.rewrite",
									"source",
									"source.organizeImports"
								]
							}
						}
					},
					"semanticTokens": {
						"requests": {"full": true}, "formats": ["relative"],
						"tokenTypes": ["namespace","class","interface","enum","type","typeParameter","method","property","enumMember","parameter","variable","modifier","keyword","decorator","annotationMember","record","recordComponent"],
						"tokenModifiers": ["declaration","static","readonly","deprecated","abstract","modification"]
					},
					"formatting": { "dynamicRegistration": false },
					"publishDiagnostics": {
						"relatedInformation": true,
						"versionSupport": true
					}
				},
				"workspace": {
					"executeCommand": { "dynamicRegistration": false },
					"applyEdit": false,
					"configuration": true,
					"workspaceFolders": true
				},
				"window": {
					"workDoneProgress": true
				}
			},
			"initializationOptions": {
				"extendedClientCapabilities": {"executeClientCommandSupport": true, "classFileContentsSupport": true},
				"bundles": bundles,
				"settings": {
					"java": java_settings
				}
			}
		});

		match client.request("initialize", init_params, Duration::from_secs(60)).await {
			Ok(reply) => {
				if let Some(legend) = reply.pointer("/capabilities/semanticTokensProvider/legend") {
					let _ = client.semantic_legend.set(legend.clone());
				}
			}
			Err(err) => {
				client.shutdown_and_kill().await;
				emit_lsp_status(app.as_ref(), "error", format!("LSP init failed: {err}"), None);
				return Err(err);
			}
		}

		if let Err(err) = client.notify("initialized", json!({})).await {
			client.shutdown_and_kill().await;
			return Err(err);
		}

		{
			let mut slot = self.client.lock().await;
			*slot = Some(client);
		}

		if !ready_seen.load(Ordering::SeqCst) {
			emit_lsp_status(
				app.as_ref(),
				"indexing",
				"Importing Gradle & Java workspace...",
				Some(40),
			);
		}
		Ok(())
	}

	pub async fn stop(&self) {
		let prev = {
			let mut guard = self.client.lock().await;
			guard.take()
		};
		if let Some(client) = prev {
			client.shutdown_and_kill().await;
		}
	}

	pub async fn did_open(
		&self,
		uri: String,
		language_id: String,
		version: i32,
		text: String,
	) -> Result<(), String> {
		let client = self.active_client().await?;
		client.remember_uri_alias(&uri);
		let uri = normalize_lsp_uri(&uri)?;
		client
			.notify(
				"textDocument/didOpen",
				json!({
					"textDocument": {
						"uri": uri,
						"languageId": language_id,
						"version": version,
						"text": text
					}
				}),
			)
			.await
	}

	pub async fn did_change(&self, uri: String, version: i32, text: String) -> Result<(), String> {
		let client = self.active_client().await?;
		client.remember_uri_alias(&uri);
		let uri = normalize_lsp_uri(&uri)?;
		client
			.notify(
				"textDocument/didChange",
				json!({
					"textDocument": {
						"uri": uri,
						"version": version
					},
					"contentChanges": [{ "text": text }]
				}),
			)
			.await
	}

	pub async fn did_save(&self, uri: String, text: Option<String>) -> Result<(), String> {
		let client = self.active_client().await?;
		client.remember_uri_alias(&uri);
		let uri = normalize_lsp_uri(&uri)?;
		let params = match text {
			Some(t) => json!({ "textDocument": { "uri": uri }, "text": t }),
			None => json!({ "textDocument": { "uri": uri } }),
		};
		client.notify("textDocument/didSave", params).await
	}

	pub async fn did_close(&self, uri: String) -> Result<(), String> {
		let client = self.active_client().await?;
		client.forget_uri_alias(&uri);
		let uri = normalize_lsp_uri(&uri)?;
		client
			.notify(
				"textDocument/didClose",
				json!({ "textDocument": { "uri": uri } }),
			)
			.await
	}

	pub async fn completion(
		&self,
		uri: String,
		line: u32,
		character: u32,
	) -> Result<Value, String> {
		let client = self.active_client().await?;
		let uri = normalize_lsp_uri(&uri)?;
		client
			.request(
				"textDocument/completion",
				json!({
					"textDocument": { "uri": uri },
					"position": { "line": line, "character": character }
				}),
				Duration::from_secs(15),
			)
			.await
	}

	pub async fn resolve_completion(&self, item: Value) -> Result<Value, String> {
		self.active_client().await?.request("completionItem/resolve", item, Duration::from_secs(15)).await
	}

	pub async fn organize_imports(&self, uri: String, selected: Vec<String>) -> Result<Value, String> {
		let uri = normalize_lsp_uri(&uri)?;
		let client = self.active_client().await?;
		let _guard = client.import_lock.lock().await;
		*client.import_choices.lock().unwrap() = ImportChoices { uri: uri.clone(), selected, groups: vec![] };
		let pos = json!({"line":0,"character":0});
		let result = client.request("java/organizeImports", json!({"textDocument":{"uri":uri},"range":{"start":pos,"end":pos},"context":{"diagnostics":[]}}), Duration::from_secs(30)).await;
		let choices = std::mem::take(&mut *client.import_choices.lock().unwrap());
		if !choices.groups.is_empty() { return Ok(json!({"groups": choices.groups})); }
		Ok(json!({"edit": result?}))
	}

	pub async fn hover(&self, uri: String, line: u32, character: u32) -> Result<Value, String> {
		let client = self.active_client().await?;
		let uri = normalize_lsp_uri(&uri)?;
		client
			.request(
				"textDocument/hover",
				json!({
					"textDocument": { "uri": uri },
					"position": { "line": line, "character": character }
				}),
				Duration::from_secs(10),
			)
			.await
	}

	pub async fn definition(
		&self,
		uri: String,
		line: u32,
		character: u32,
	) -> Result<Value, String> {
		let client = self.active_client().await?;
		let uri = normalize_lsp_uri(&uri)?;
		client
			.request(
				"textDocument/definition",
				json!({
					"textDocument": { "uri": uri },
					"position": { "line": line, "character": character }
				}),
				Duration::from_secs(15),
			)
			.await
	}

	pub async fn references(
		&self,
		uri: String,
		line: u32,
		character: u32,
		include_declaration: bool,
	) -> Result<Value, String> {
		let client = self.active_client().await?;
		let uri = normalize_lsp_uri(&uri)?;
		client
			.request(
				"textDocument/references",
				json!({
					"textDocument": { "uri": uri },
					"position": { "line": line, "character": character },
					"context": { "includeDeclaration": include_declaration }
				}),
				Duration::from_secs(15),
			)
			.await
	}

	pub async fn rename(
		&self,
		uri: String,
		line: u32,
		character: u32,
		new_name: String,
	) -> Result<Value, String> {
		let client = self.active_client().await?;
		let uri = normalize_lsp_uri(&uri)?;
		client
			.request(
				"textDocument/rename",
				json!({
					"textDocument": { "uri": uri },
					"position": { "line": line, "character": character },
					"newName": new_name
				}),
				Duration::from_secs(15),
			)
			.await
	}

	pub async fn code_action(
		&self,
		uri: String,
		start_line: u32,
		start_char: u32,
		end_line: u32,
		end_char: u32,
		diagnostics: Option<Vec<Value>>,
	) -> Result<Value, String> {
		let client = self.active_client().await?;
		let uri = normalize_lsp_uri(&uri)?;
		let normalized_diags: Vec<Value> = diagnostics
			.unwrap_or_default()
			.into_iter()
			.map(normalize_code_action_diagnostic)
			.collect();
		client
			.request(
				"textDocument/codeAction",
				json!({
					"textDocument": { "uri": uri },
					"range": {
						"start": { "line": start_line, "character": start_char },
						"end": { "line": end_line, "character": end_char }
					},
					"context": {
						"diagnostics": normalized_diags
					}
				}),
				Duration::from_secs(15),
			)
			.await
	}

	pub async fn formatting(
		&self,
		uri: String,
		tab_size: u32,
		insert_spaces: bool,
	) -> Result<Value, String> {
		let client = self.active_client().await?;
		let uri = normalize_lsp_uri(&uri)?;
		client
			.request(
				"textDocument/formatting",
				json!({
					"textDocument": { "uri": uri },
					"options": {
						"tabSize": tab_size,
						"insertSpaces": insert_spaces
					}
				}),
				Duration::from_secs(15),
			)
			.await
	}

	pub async fn semantic_tokens(&self, uri: String) -> Result<Value, String> {
		let client = self.active_client().await?;
		let Some(legend) = client.semantic_legend.get() else { return Ok(Value::Null) };
		let tokens = client.request("textDocument/semanticTokens/full", json!({"textDocument":{"uri":normalize_lsp_uri(&uri)?}}), Duration::from_secs(12)).await?;
		Ok(json!({"types":legend["tokenTypes"],"data":tokens["data"]}))
	}

	pub async fn search_types(&self, query: String) -> Result<Value, String> {
		let client = self.active_client().await?;
		client.request("workspace/symbol", json!({"query":query}), Duration::from_secs(15)).await
	}

	pub async fn class_file_contents(&self, uri: String) -> Result<String, String> {
		let client = self.active_client().await?;
		let res = client
			.request(
				"java/classFileContents",
				json!({ "uri": uri }),
				Duration::from_secs(15),
			)
			.await?;
		match res {
			Value::String(s) => Ok(s),
			Value::Null => Ok(String::new()),
			other => Ok(other.to_string()),
		}
	}

	pub async fn execute_command(
		&self,
		command: String,
		arguments: Vec<Value>,
	) -> Result<Value, String> {
		let client = self.active_client().await?;
		client
			.request(
				"workspace/executeCommand",
				json!({
					"command": command,
					"arguments": arguments
				}),
				Duration::from_secs(20),
			)
			.await
	}

	pub async fn build_for_debug(&self) -> Result<(), String> {
		let status = self.active_client().await?.request("java/buildWorkspace", json!(false), Duration::from_secs(120)).await?;
		match status.as_str() {
			Some("SUCCEED") => Ok(()),
			_ if status == 1 => Ok(()),
			_ => Err(format!("Java debug build failed ({status}). Check the Problems panel.")),
		}
	}

	pub async fn request_debug_port(&self) -> Result<u16, String> {
		let res = self
			.execute_command("vscode.java.startDebugSession".to_string(), Vec::new())
			.await?;
		match res {
			Value::Number(n) => n
				.as_u64()
				.and_then(|v| u16::try_from(v).ok())
				.ok_or_else(|| format!("Invalid debug port returned: {n}")),
			Value::String(s) => s
				.trim()
				.parse::<u16>()
				.map_err(|_| format!("Invalid debug port string returned: {s}")),
			other => Err(format!("Unexpected startDebugSession response: {other}")),
		}
	}
}

fn collect_source_jars_in_dir(
	dir: &Path,
	depth: usize,
	seen: &mut HashSet<PathBuf>,
	out: &mut Vec<PathBuf>,
) {
	if depth > 8 || !dir.is_dir() {
		return;
	}
	let Ok(entries) = fs::read_dir(dir) else {
		return;
	};
	for entry in entries.flatten() {
		let path = entry.path();
		if path.is_dir() {
			collect_source_jars_in_dir(&path, depth + 1, seen, out);
		} else if path.is_file() {
			let is_sources = path
				.file_name()
				.and_then(|n| n.to_str())
				.map(|n| n.to_ascii_lowercase().ends_with("-sources.jar"))
				.unwrap_or(false);
			if is_sources {
				let canon = fs::canonicalize(&path).unwrap_or(path);
				if seen.insert(canon.clone()) {
					out.push(canon);
				}
			}
		}
	}
}

fn find_loom_source_jars(root: &Path) -> Vec<PathBuf> {
	let mut seen = HashSet::new();
	let mut jars = Vec::new();
	collect_source_jars_in_dir(
		&root.join(".gradle").join("loom-cache"),
		0,
		&mut seen,
		&mut jars,
	);
	if let Some(home) = std::env::var_os("GRADLE_USER_HOME").map(PathBuf::from).or_else(|| dirs::home_dir().map(|p| p.join(".gradle"))) {
		collect_source_jars_in_dir(
			&home.join("caches").join("fabric-loom"),
			0,
			&mut seen,
			&mut jars,
		);
	}
	jars
}

fn split_java_entry(entry_path: &str) -> Option<(String, String)> {
	let trimmed = entry_path.strip_suffix(".java")?;
	if trimmed.is_empty() || trimmed.starts_with("META-INF/") {
		return None;
	}
	if let Some((pkg_slash, cls)) = trimmed.rsplit_once('/') {
		if cls.is_empty() || cls == "package-info" {
			return None;
		}
		Some((pkg_slash.replace('/', "."), cls.to_string()))
	} else {
		if trimmed == "package-info" {
			return None;
		}
		Some((String::new(), trimmed.to_string()))
	}
}

struct JarNames {
	path: PathBuf,
	modified: std::time::SystemTime,
	size: u64,
	names: Arc<Vec<String>>,
}

fn source_entry_names(path: &Path) -> Option<Arc<Vec<String>>> {
	static CACHE: std::sync::Mutex<Vec<JarNames>> = std::sync::Mutex::new(Vec::new());
	let file = File::open(path).ok()?;
	let metadata = file.metadata().ok()?;
	let modified = metadata.modified().ok()?;
	let size = metadata.len();
	{
		let cache = CACHE.lock().ok()?;
		if let Some(hit) = cache.iter().find(|e| e.path == path && e.modified == modified && e.size == size) {
			return Some(hit.names.clone());
		}
	}
	let archive = ZipArchive::new(BufReader::new(file)).ok()?;
	let names: Arc<Vec<String>> = Arc::new(archive.file_names().filter(|n| n.ends_with(".java")).map(str::to_owned).collect());
	if names.iter().map(|n| n.len() + std::mem::size_of::<String>()).sum::<usize>() <= 4 * 1024 * 1024 {
		let mut cache = CACHE.lock().ok()?;
		cache.retain(|e| e.path != path);
		if cache.len() == 4 { cache.remove(0); }
		cache.push(JarNames { path: path.into(), modified, size, names: names.clone() });
	}
	Some(names)
}

fn search_sources_in_jars(
	root: &Path,
	jars: &[PathBuf],
	query: &str,
) -> Result<Vec<MinecraftClassEntry>, String> {
	let q = query.trim().to_lowercase();
	let project_cache = fs::canonicalize(root.join(".gradle/loom-cache")).ok();
	let version = crate::fabric::inspect_fabric_project(root).ok().flatten().map(|m| m.mc_version).unwrap_or_default();
	let properties = fs::read_to_string(root.join("gradle.properties")).unwrap_or_default();
	let yarn = properties.lines().filter_map(|s| s.split_once('=')).find(|(k,_)| matches!(k.trim(), "yarn_mappings" | "yarn_version")).map(|(_,v)| v.trim()).filter(|v| !v.is_empty());
	let mut scored = Vec::new();

	for jar_path in jars {
		let Some(names) = source_entry_names(jar_path) else {
			continue;
		};
		let jar_str = jar_path.to_string_lossy().to_string();

		let in_project = project_cache.as_ref().is_some_and(|p| jar_path.starts_with(p));
		let matches_version = !version.is_empty() && jar_str.split(|c: char| !(c.is_ascii_alphanumeric() || c == '.')).any(|part| part == version);
		let mapping = yarn.is_some_and(|v| jar_str.contains(v) || jar_str.contains(&v.replace('+', ".")));
		let (rank, scope) = match (in_project, matches_version, mapping) {
			(true, true, true) => (0, "projectMapping"),
			(true, true, _) => (1, "projectVersion"),
			(false, true, true) => (2, "matchingMapping"),
			(false, true, _) => (3, "matchingVersion"),
			(true, _, _) => (4, "projectCache"),
			_ => (5, "globalCache"),
		};
		for name in names.iter() {
			let Some((package_name, class_name)) = split_java_entry(name) else {
				continue;
			};
			let cls_lower = class_name.to_lowercase();
			let score = if q.is_empty() {
				if package_name.starts_with("net.minecraft") {
					0
				} else {
					1
				}
			} else if cls_lower == q {
				0
			} else if cls_lower.starts_with(&q) {
				1
			} else if cls_lower.contains(&q) {
				2
			} else {
				let fq = if package_name.is_empty() {
					cls_lower.clone()
				} else {
					format!("{}.{}", package_name.to_lowercase(), cls_lower)
				};
				if fq.contains(&q) {
					3
				} else {
					continue;
				}
			};

			scored.push((
				(score, rank),
				class_name.len(),
				MinecraftClassEntry {
					class_name,
					package_name,
					source_jar: jar_str.clone(),
					source_scope: scope.to_owned(),
					entry_path: name.to_string(),
				},
			));
		}
	}

	scored.sort_by(|a, b| {
		a.0.cmp(&b.0)
			.then_with(|| a.1.cmp(&b.1))
			.then_with(|| {
				a.2.class_name
					.to_lowercase()
					.cmp(&b.2.class_name.to_lowercase())
			})
			.then_with(|| a.2.package_name.cmp(&b.2.package_name))
			.then_with(|| a.2.source_jar.cmp(&b.2.source_jar))
	});
	scored.truncate(MAX_SOURCE_RESULTS);
	Ok(scored.into_iter().map(|(_, _, entry)| entry).collect())
}

pub async fn search_minecraft_sources(
	root: PathBuf,
	query: String,
) -> Result<Vec<MinecraftClassEntry>, String> {
	tokio::task::spawn_blocking(move || {
		let jars = find_loom_source_jars(&root);
		search_sources_in_jars(&root, &jars, &query)
	})
	.await
	.map_err(|e| format!("Source search task panicked: {e}"))?
}

pub async fn read_minecraft_source(
	source_jar: String,
	entry_path: String,
) -> Result<String, String> {
	let jar_path = PathBuf::from(&source_jar);
	if !jar_path.is_file()
		|| !source_jar.to_ascii_lowercase().ends_with(".jar")
		|| !entry_path.ends_with(".java")
		|| entry_path.contains("..")
	{
		return Err("Invalid source JAR or Java entry path".into());
	}

	tokio::task::spawn_blocking(move || {
		let file = File::open(&jar_path)
			.map_err(|e| format!("Failed to open {}: {e}", jar_path.display()))?;
		let mut archive = ZipArchive::new(BufReader::new(file))
			.map_err(|e| format!("Failed to open ZIP archive {}: {e}", jar_path.display()))?;
		let mut entry = archive
			.by_name(&entry_path)
			.map_err(|e| format!("Source entry '{entry_path}' not found: {e}"))?;
		let mut buf = Vec::new();
		entry
			.read_to_end(&mut buf)
			.map_err(|e| format!("Failed to read entry '{entry_path}': {e}"))?;
		Ok(String::from_utf8_lossy(&buf).into_owned())
	})
	.await
	.map_err(|e| format!("Read source task panicked: {e}"))?
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::io::Write;
	use tokio::io::BufReader as TokioBufReader;
	use zip::write::SimpleFileOptions;
	use zip::ZipWriter;

	#[tokio::test]
	async fn frame_roundtrip_ascii_and_korean_utf8() {
		let msg1 = json!({
			"jsonrpc": "2.0",
			"id": 1,
			"method": "textDocument/hover",
			"params": { "text": "안녕하세요 패브릭 스튜디오!" }
		});
		let msg2 = json!({
			"jsonrpc": "2.0",
			"method": "language/status",
			"params": { "type": "Started", "message": "준비 완료 🚀" }
		});

		let mut wire = encode_lsp_json(&msg1).expect("encode msg1");
		wire.extend_from_slice(&encode_lsp_json(&msg2).expect("encode msg2"));

		// Verify byte-length header (not char count) for multibyte Korean payload
		let raw1 = serde_json::to_vec(&msg1).unwrap();
		let expected_hdr = format!("Content-Length: {}\r\n\r\n", raw1.len());
		assert!(wire.starts_with(expected_hdr.as_bytes()));
		assert!(raw1.len() > serde_json::to_string(&msg1).unwrap().chars().count());

		let mut reader = TokioBufReader::new(std::io::Cursor::new(wire));
		let decoded1 = read_lsp_message(&mut reader).await.unwrap().unwrap();
		let decoded2 = read_lsp_message(&mut reader).await.unwrap().unwrap();
		let eof = read_lsp_message(&mut reader).await.unwrap();

		assert_eq!(decoded1, msg1);
		assert_eq!(decoded2, msg2);
		assert!(eof.is_none());
	}

	#[tokio::test]
	async fn frame_handles_extra_headers_and_lf_only() {
		let body = r#"{"jsonrpc":"2.0","id":7,"result":{"한국어":true}}"#;
		let raw = format!(
			"Content-Type: application/vscode-jsonrpc; charset=utf-8\nContent-Length: {}\n\n{}",
			body.len(),
			body
		);
		let mut reader = TokioBufReader::new(std::io::Cursor::new(raw.into_bytes()));
		let decoded = read_lsp_message(&mut reader).await.unwrap().unwrap();
		assert_eq!(decoded["id"], 7);
		assert_eq!(decoded["result"]["한국어"], true);
	}

	#[tokio::test]
	async fn scan_and_read_loom_source_jar() {
		let temp_dir =
			std::env::temp_dir().join(format!("fabric-studio-lsp-test-{}", uuid::Uuid::new_v4()));
		let cache_dir = temp_dir.join(".gradle").join("loom-cache").join("26.3");
		fs::create_dir_all(&cache_dir).unwrap();
		let jar_path = cache_dir.join("minecraft-26.3-sources.jar");

		{
			let file = File::create(&jar_path).unwrap();
			let mut zip = ZipWriter::new(file);
			let opts = SimpleFileOptions::default();

			zip.start_file("net/minecraft/resources/Identifier.java", opts)
				.unwrap();
			zip.write_all(b"package net.minecraft.resources;\npublic class Identifier {}\n")
				.unwrap();

			zip.start_file("net/minecraft/world/entity/player/Player.java", opts)
				.unwrap();
			zip.write_all(b"package net.minecraft.world.entity.player;\npublic class Player {}\n")
				.unwrap();

			zip.start_file("META-INF/MANIFEST.MF", opts).unwrap();
			zip.write_all(b"Manifest-Version: 1.0\n").unwrap();
			zip.finish().unwrap();
		}

		let found = search_minecraft_sources(temp_dir.clone(), "Identifier".to_string())
			.await
			.unwrap();
		assert_eq!(found.len(), 1);
		assert_eq!(found[0].class_name, "Identifier");
		let other = temp_dir.join("other-sources.jar");
		fs::copy(&jar_path, &other).unwrap();
		let ranked = search_sources_in_jars(&temp_dir, &[other, fs::canonicalize(&jar_path).unwrap()], "Identifier").unwrap();
		assert_eq!(ranked[0].source_scope, "projectCache");
		assert_eq!(ranked[1].source_scope, "globalCache");
		assert_eq!(found[0].package_name, "net.minecraft.resources");
		assert_eq!(
			found[0].entry_path,
			"net/minecraft/resources/Identifier.java"
		);

		let source =
			read_minecraft_source(found[0].source_jar.clone(), found[0].entry_path.clone())
				.await
				.unwrap();
		assert!(source.contains("public class Identifier"));

		let cached = source_entry_names(&jar_path).unwrap();
		assert!(Arc::ptr_eq(&cached, &source_entry_names(&jar_path).unwrap()));
		let mut zip = ZipWriter::new(File::create(&jar_path).unwrap());
		zip.start_file("replacement.java", SimpleFileOptions::default()).unwrap();
		zip.finish().unwrap();
		assert_eq!(source_entry_names(&jar_path).unwrap().as_slice(), &["replacement.java"]);
		let _ = fs::remove_dir_all(&temp_dir);
	}

	#[test]
	#[ignore = "manual source-search timing comparison"]
	fn benchmark_source_search_cache() {
		let dir = tempfile::tempdir().unwrap();
		let jars: Vec<_> = (0..6).map(|i| dir.path().join(format!("{i}-sources.jar"))).collect();
		let mut zip = ZipWriter::new(File::create(&jars[0]).unwrap());
		for i in 0..10_000 {
			zip.start_file(format!("net/minecraft/client/Type{i}.java"), SimpleFileOptions::default()).unwrap();
		}
		zip.finish().unwrap();
		for jar in &jars[1..] { fs::copy(&jars[0], jar).unwrap(); }
		for cached in [false, true] {
			let mut timings = Vec::new();
			for i in 0..13 {
				let jar = &jars[if cached {0} else {i % jars.len()}];
				let start = Instant::now();
				let found = search_sources_in_jars(dir.path(), std::slice::from_ref(jar), "Type9999").unwrap();
				assert_eq!(found[0].class_name, "Type9999");
				if i > 0 { timings.push(start.elapsed()); }
			}
			timings.sort();
			eprintln!("JAR index cached={cached}, 12 searches, median {:?}", (timings[5] + timings[6]) / 2);
		}
	}

	#[test]
	fn diagnostics_alias_restores_monaco_encoded_uri() {
		let aliases = std::sync::Mutex::new(HashMap::new());
		if let Some(key) = canonical_path_key("file:///d%3A/Mods/Test/src/Main.java") {
			aliases
				.lock()
				.unwrap()
				.insert(key, "file:///d%3A/Mods/Test/src/Main.java".to_string());
		}

		let params = json!({
			"uri": "file:///D:/Mods/Test/src/Main.java",
			"diagnostics": [{
				"range": {
					"start": { "line": 4, "character": 2 },
					"end": { "line": 4, "character": 10 }
				},
				"severity": 1,
				"code": 16777218,
				"source": "Java",
				"message": "Cannot resolve symbol"
			}]
		});
		let ev = parse_diagnostics_event(&params, &aliases).unwrap();
		assert_eq!(ev.uri, "file:///d%3A/Mods/Test/src/Main.java");
		assert_eq!(ev.diagnostics.len(), 1);
		assert_eq!(ev.diagnostics[0].code.as_deref(), Some("16777218"));
		assert_eq!(ev.diagnostics[0].range_start_line, 4);
	}

	#[test]
	fn server_request_reply_handles_configuration_and_progress() {
		let settings = json!({ "autobuild": { "enabled": true } });
		let cfg_reply = build_server_request_reply(
			"workspace/configuration",
			&json!({
				"items": [
					{ "section": "java" },
					{ "section": "java.autobuild" },
					{ "section": "other" }
				]
			}),
			&settings,
		);
		assert_eq!(cfg_reply[0]["autobuild"]["enabled"], true);
		assert_eq!(cfg_reply[1]["enabled"], true);
		assert!(cfg_reply[2].is_null());

		let progress_reply =
			build_server_request_reply("window/workDoneProgress/create", &json!({}), &settings);
		assert!(progress_reply.is_null());
	}

	#[test]
	fn code_action_diagnostic_conversion_supports_dto_and_lsp() {
		let dto = json!({
			"rangeStartLine": 2,
			"rangeStartChar": 4,
			"rangeEndLine": 2,
			"rangeEndChar": 9,
			"severity": 1,
			"code": "compiler.err",
			"source": "jdtls",
			"message": "err"
		});
		let converted = normalize_code_action_diagnostic(dto);
		assert_eq!(converted["range"]["start"]["line"], 2);
		assert_eq!(converted["range"]["end"]["character"], 9);
		assert_eq!(converted["code"], "compiler.err");
	}
}