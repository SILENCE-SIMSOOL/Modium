use std::collections::BTreeSet;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::thread;
use std::time::{Duration, Instant};

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::Emitter;

use crate::state::AppState;

const IGNORED_DIRS: &[&str] = &[".git", ".gradle", "build", "run"];
const DEBOUNCE_MS: u64 = 250;
const MAX_BATCH_MS: u64 = 1000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FsChangedPayload {
	paths: Vec<String>,
}

enum WatcherMsg {
	Paths(Vec<String>),
	Stop,
}

struct WorkspaceWatcher {
	watcher: Option<RecommendedWatcher>,
	tx: Sender<WatcherMsg>,
}

impl Drop for WorkspaceWatcher {
	fn drop(&mut self) {
		self.watcher.take();
		let _ = self.tx.send(WatcherMsg::Stop);
	}
}

fn strip_verbatim_prefix(path: &Path) -> PathBuf {
	#[cfg(windows)]
	{
		let s = path.to_string_lossy();
		if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
			return PathBuf::from(format!(r"\\{rest}"));
		}
		if let Some(rest) = s.strip_prefix(r"\\?\") {
			return PathBuf::from(rest);
		}
	}
	path.to_path_buf()
}

fn normalize_rel_path(root: &Path, canon_root: &Path, event_path: &Path) -> Option<String> {
	let clean_event = strip_verbatim_prefix(event_path);
	let rel = clean_event
		.strip_prefix(canon_root)
		.or_else(|_| clean_event.strip_prefix(root))
		.ok()
		.map(|p| p.to_path_buf())
		.or_else(|| {
			#[cfg(windows)]
			{
				let ev_str = clean_event.to_string_lossy();
				let root_str = canon_root.to_string_lossy();
				if ev_str.len() > root_str.len()
					&& ev_str[..root_str.len()].eq_ignore_ascii_case(&root_str)
				{
					let tail = ev_str[root_str.len()..].trim_start_matches(['\\', '/']);
					return Some(PathBuf::from(tail));
				}
			}
			None
		})?;

	let mut parts = Vec::new();
	for comp in rel.components() {
		if let Component::Normal(seg) = comp {
			let s = seg.to_string_lossy();
			if IGNORED_DIRS.contains(&s.as_ref()) {
				return None;
			}
			parts.push(s.into_owned());
		}
	}
	if parts.is_empty() {
		return None;
	}
	Some(parts.join("/"))
}

pub fn start_watcher(
	app: tauri::AppHandle,
	root: PathBuf,
) -> Result<Box<dyn std::any::Any + Send>, String> {
	let canon_root = fs::canonicalize(&root)
		.map(|p| strip_verbatim_prefix(&p))
		.map_err(|e| format!("Invalid workspace root for watcher: {e}"))?;
	let raw_root = strip_verbatim_prefix(&root);
	if !canon_root.is_dir() {
		return Err("Workspace root is not a directory".to_string());
	}

	let (tx, rx) = mpsc::channel::<WatcherMsg>();
	let worker_tx = tx.clone();
	let watch_raw = raw_root.clone();
	let watch_canon = canon_root.clone();

	let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
		let Ok(event) = res else {
			return;
		};
		if matches!(event.kind, EventKind::Access(_)) {
			return;
		}
		let filtered: Vec<String> = event
			.paths
			.iter()
			.filter_map(|p| normalize_rel_path(&watch_raw, &watch_canon, p))
			.collect();
		if !filtered.is_empty() {
			let _ = worker_tx.send(WatcherMsg::Paths(filtered));
		}
	})
	.map_err(|e| format!("Failed to create filesystem watcher: {e}"))?;

	watcher
		.watch(&canon_root, RecursiveMode::Recursive)
		.map_err(|e| format!("Failed to watch workspace directory: {e}"))?;

	thread::Builder::new()
		.name("fabric-studio-watcher".to_string())
		.spawn(move || {
			let debounce = Duration::from_millis(DEBOUNCE_MS);
			let max_batch = Duration::from_millis(MAX_BATCH_MS);
			while let Ok(msg) = rx.recv() {
				let initial = match msg {
					WatcherMsg::Paths(paths) => paths,
					WatcherMsg::Stop => break,
				};
				let mut batch: BTreeSet<String> = initial.into_iter().collect();
				let mut last_event = Instant::now();
				let batch_start = last_event;
				loop {
					let since_last = last_event.elapsed();
					let total = batch_start.elapsed();
					if since_last >= debounce || total >= max_batch {
						break;
					}
					let wait = (debounce - since_last).min(max_batch - total);
					match rx.recv_timeout(wait) {
						Ok(WatcherMsg::Paths(more)) => {
							batch.extend(more);
							last_event = Instant::now();
						}
						Ok(WatcherMsg::Stop) | Err(RecvTimeoutError::Disconnected) => return,
						Err(RecvTimeoutError::Timeout) => break,
					}
				}
				if !batch.is_empty() {
					let payload = FsChangedPayload {
						paths: batch.into_iter().collect(),
					};
					let _ = app.emit("fs:changed", payload);
				}
			}
		})
		.map_err(|e| format!("Failed to spawn watcher debounce thread: {e}"))?;

	Ok(Box::new(WorkspaceWatcher {
		watcher: Some(watcher),
		tx,
	}))
}

pub fn update_watcher(
	state: &AppState,
	app: &tauri::AppHandle,
	root: PathBuf,
) -> Result<(), String> {
	let handle = start_watcher(app.clone(), root)?;
	let mut guard = state
		.watcher_handle
		.lock()
		.unwrap_or_else(|e| e.into_inner());
	*guard = Some(handle);
	Ok(())
}

pub fn stop_watcher(state: &AppState) {
	let mut guard = state
		.watcher_handle
		.lock()
		.unwrap_or_else(|e| e.into_inner());
	*guard = None;
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn filters_ignored_directories_and_normalizes_paths() {
		let root = PathBuf::from(r"D:\Mods\Example");
		let canon = PathBuf::from(r"D:\Mods\Example");

		assert_eq!(
			normalize_rel_path(
				&root,
				&canon,
				Path::new(r"D:\Mods\Example\src\main\Main.java")
			),
			Some("src/main/Main.java".to_string())
		);
		assert_eq!(
			normalize_rel_path(&root, &canon, Path::new(r"D:\Mods\Example\.git\index")),
			None
		);
		assert_eq!(
			normalize_rel_path(&root, &canon, Path::new(r"D:\Mods\Example\.gradle\cache\x")),
			None
		);
		assert_eq!(
			normalize_rel_path(
				&root,
				&canon,
				Path::new(r"D:\Mods\Example\build\libs\mod.jar")
			),
			None
		);
		assert_eq!(
			normalize_rel_path(
				&root,
				&canon,
				Path::new(r"D:\Mods\Example\run\logs\latest.log")
			),
			None
		);
		assert_eq!(
			normalize_rel_path(
				&root,
				&canon,
				Path::new(r"\\?\D:\Mods\Example\src\Mod.java")
			),
			Some("src/Mod.java".to_string())
		);
		assert_eq!(
			strip_verbatim_prefix(Path::new(r"\\?\UNC\server\share\mod")),
			PathBuf::from(r"\\server\share\mod")
		);
	}
}
