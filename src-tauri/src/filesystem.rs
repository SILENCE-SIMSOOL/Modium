use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};

use regex::RegexBuilder;

use crate::models::{FileNode, LimitedResults, SearchMatch};

const MAX_ALL_FILES: usize = 5000;
const MAX_SEARCH_MATCHES: usize = 500;
const MAX_SEARCH_FILE_BYTES: u64 = 4 * 1024 * 1024;
const HEAVY_BUILD_DIRS: &[&str] = &[".gradle", "build", "target", "node_modules"];
const WALK_SKIP_DIRS: &[&str] = &[
	".git",
	".gradle",
	"build",
	"run",
	".idea",
	"target",
	"node_modules",
];
const BINARY_EXTENSIONS: &[&str] = &[
	"png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "ogg", "wav", "mp3", "jar", "zip", "gz",
	"tar", "7z", "class", "exe", "dll", "so", "dylib", "pdb", "nbt", "dat", "mca", "woff", "woff2",
	"ttf", "otf", "pdf",
];

fn to_rel_slash(canon_root: &Path, target: &Path) -> String {
	let Ok(rel) = target.strip_prefix(canon_root) else {
		return String::new();
	};
	rel.components()
		.filter_map(|c| match c {
			Component::Normal(s) => Some(s.to_string_lossy().to_string()),
			_ => None,
		})
		.collect::<Vec<_>>()
		.join("/")
}

pub fn resolve_workspace_path(root: &Path, rel_path: &str) -> Result<PathBuf, String> {
	let canon_root = fs::canonicalize(root).map_err(|e| format!("Invalid workspace root: {e}"))?;
	if rel_path.contains('\0') {
		return Err("Path contains NUL byte".to_string());
	}
	let trimmed = rel_path.trim();
	if trimmed.is_empty() || trimmed == "." {
		return Ok(canon_root);
	}
	if trimmed.starts_with('/') || trimmed.starts_with('\\') {
		return Err("Absolute or root-prefixed path is not allowed".to_string());
	}
	let bytes = trimmed.as_bytes();
	if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
		return Err("Drive-prefixed path is not allowed".to_string());
	}
	for comp in Path::new(trimmed).components() {
		match comp {
			Component::Normal(_) | Component::CurDir => {}
			Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
				return Err("Path traversal or root prefix is not allowed".to_string());
			}
		}
	}
	let mut candidate = canon_root.clone();
	for seg in trimmed.split(['/', '\\']) {
		if seg.is_empty() || seg == "." {
			continue;
		}
		if seg == ".." {
			return Err("Parent directory traversal ('..') is not allowed".to_string());
		}
		candidate.push(seg);
	}
	match fs::symlink_metadata(&candidate) {
		Ok(_) => {
			let canon_target =
				fs::canonicalize(&candidate).map_err(|e| format!("Failed to resolve path: {e}"))?;
			if !canon_target.starts_with(&canon_root) {
				return Err("Path escapes workspace root".to_string());
			}
			Ok(canon_target)
		}
		Err(e) if e.kind() == ErrorKind::NotFound => {
			let mut existing_ancestor: Option<&Path> = None;
			for ancestor in candidate.ancestors().skip(1) {
				if fs::symlink_metadata(ancestor).is_ok() {
					existing_ancestor = Some(ancestor);
					break;
				}
			}
			let ancestor = existing_ancestor
				.ok_or_else(|| "No existing ancestor within workspace".to_string())?;
			let canon_ancestor = fs::canonicalize(ancestor)
				.map_err(|err| format!("Failed to resolve ancestor: {err}"))?;
			if !canon_ancestor.starts_with(&canon_root) {
				return Err("Path escapes workspace root".to_string());
			}
			let suffix = candidate
				.strip_prefix(ancestor)
				.map_err(|_| "Invalid path suffix".to_string())?;
			Ok(canon_ancestor.join(suffix))
		}
		Err(e) => Err(format!("Failed to inspect path: {e}")),
	}
}

pub fn list_directory(
	root: &Path,
	rel_path: Option<&str>,
	show_hidden: bool,
) -> Result<Vec<FileNode>, String> {
	let rel = rel_path.unwrap_or("");
	let target = resolve_workspace_path(root, rel)?;
	if !target.is_dir() {
		return Err("Target path is not a directory".to_string());
	}
	let canon_root = fs::canonicalize(root).map_err(|e| format!("Invalid workspace root: {e}"))?;
	let in_heavy_dir = rel
		.split(['/', '\\'])
		.any(|seg| HEAVY_BUILD_DIRS.contains(&seg));

	let entries = fs::read_dir(&target).map_err(|e| format!("Failed to read directory: {e}"))?;
	let mut nodes = Vec::new();
	for entry in entries.flatten() {
		let entry_path = entry.path();
		let name = entry.file_name().to_string_lossy().to_string();
		if !show_hidden && !in_heavy_dir && HEAVY_BUILD_DIRS.contains(&name.as_str()) {
			continue;
		}
		if !show_hidden && name.starts_with('.') {
			continue;
		}
		let Ok(canon_entry) = fs::canonicalize(&entry_path) else {
			continue;
		};
		if !canon_entry.starts_with(&canon_root) {
			continue;
		}
		let Ok(meta) = fs::metadata(&canon_entry) else {
			continue;
		};
		let is_dir = meta.is_dir();
		let size = if is_dir { 0 } else { meta.len() };
		let node_rel = to_rel_slash(&canon_root, &canon_entry);
		nodes.push(FileNode {
			name,
			rel_path: node_rel,
			is_dir,
			size,
			children: None,
		});
	}
	nodes.sort_by(|a, b| {
		b.is_dir
			.cmp(&a.is_dir)
			.then_with(|| {
				a.name
					.to_ascii_lowercase()
					.cmp(&b.name.to_ascii_lowercase())
			})
			.then_with(|| a.name.cmp(&b.name))
	});
	Ok(nodes)
}

fn collect_workspace_files(
	canon_root: &Path,
	dir: &Path,
	visited: &mut HashSet<PathBuf>,
	out: &mut Vec<String>,
	limit: Option<usize>,
	query: &str,
) {
	if let Some(max) = limit {
		if out.len() >= max {
			return;
		}
	}
	let Ok(canon_dir) = fs::canonicalize(dir) else {
		return;
	};
	if !canon_dir.starts_with(canon_root) || !visited.insert(canon_dir.clone()) {
		return;
	}
	let Ok(entries) = fs::read_dir(&canon_dir) else {
		return;
	};
	let mut children: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
	children.sort();
	for child in children {
		if let Some(max) = limit {
			if out.len() >= max {
				return;
			}
		}
		let Some(name) = child.file_name().and_then(|n| n.to_str()) else {
			continue;
		};
		let Ok(symlink_meta) = fs::symlink_metadata(&child) else {
			continue;
		};
		if symlink_meta.file_type().is_symlink() {
			continue;
		}
		if symlink_meta.is_dir() {
			if WALK_SKIP_DIRS.contains(&name) {
				continue;
			}
			collect_workspace_files(canon_root, &child, visited, out, limit, query);
		} else if symlink_meta.is_file() {
			let rel = to_rel_slash(canon_root, &child);
			if !rel.is_empty() && (query.is_empty() || rel.to_lowercase().contains(query)) {
				out.push(rel);
			}
		}
	}
}

pub fn list_all_files(root: &Path, query: &str) -> Result<LimitedResults<String>, String> {
	let canon_root = fs::canonicalize(root).map_err(|e| format!("Invalid workspace root: {e}"))?;
	let mut visited = HashSet::new();
	let mut files = Vec::new();
	collect_workspace_files(
		&canon_root,
		&canon_root,
		&mut visited,
		&mut files,
		Some(MAX_ALL_FILES + 1),
		&query.to_lowercase(),
	);
	files.sort();
	Ok(LimitedResults::new(files, MAX_ALL_FILES))
}

pub fn read_file(root: &Path, rel_path: &str) -> Result<String, String> {
	let path = resolve_workspace_path(root, rel_path)?;
	if !path.is_file() {
		return Err("Target path is not a file".to_string());
	}
	fs::read_to_string(&path).map_err(|e| format!("Failed to read file: {e}"))
}

pub fn write_file(root: &Path, rel_path: &str, content: &str) -> Result<(), String> {
	let path = resolve_workspace_path(root, rel_path)?;
	if path.is_dir() {
		return Err("Cannot write to a directory".to_string());
	}
	if let Some(parent) = path.parent() {
		fs::create_dir_all(parent)
			.map_err(|e| format!("Failed to create parent directories: {e}"))?;
	}
	fs::write(&path, content).map_err(|e| format!("Failed to write file: {e}"))
}

pub fn disk_content(root: &Path, rel: &str) -> Result<Option<String>, String> {
	let path = resolve_workspace_path(root, rel)?;
	match fs::read_to_string(path) {
		Ok(text) => Ok(Some(text)),
		Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
		Err(e) => Err(e.to_string()),
	}
}

pub fn save_checked(root: &Path, rel: &str, expected: Option<&str>, content: &str) -> Result<serde_json::Value, String> {
	use std::io::Write;
	let current = disk_content(root, rel)?;
	if current.as_deref() == Some(content) { return Ok(serde_json::Value::Null); }
	if current.as_deref() != expected { return Ok(serde_json::json!({"disk":current})); }
	let path = resolve_workspace_path(root, rel)?;
	let parent = path.parent().ok_or("Invalid file path")?;
	fs::create_dir_all(parent).map_err(|e| e.to_string())?;
	let mut staged = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
	staged.write_all(content.as_bytes()).map_err(|e| e.to_string())?;
	if let Ok(meta) = path.metadata() {
		if meta.permissions().readonly() { return Err("File is read-only".into()); }
		staged.as_file().set_permissions(meta.permissions()).map_err(|e| e.to_string())?;
	}
	let latest = disk_content(root, rel)?;
	if latest.as_deref() != expected { return Ok(serde_json::json!({"disk":latest})); }
	if expected.is_none() { staged.persist_noclobber(path) } else { staged.persist(path) }.map_err(|e| e.to_string())?;
	Ok(serde_json::Value::Null)
}

pub fn create_file(root: &Path, rel_path: &str) -> Result<(), String> {
	let path = resolve_workspace_path(root, rel_path)?;
	if fs::symlink_metadata(&path).is_ok() {
		return Err("File already exists".to_string());
	}
	if let Some(parent) = path.parent() {
		fs::create_dir_all(parent)
			.map_err(|e| format!("Failed to create parent directories: {e}"))?;
	}
	OpenOptions::new()
		.write(true)
		.create_new(true)
		.open(&path)
		.map_err(|e| format!("Failed to create file: {e}"))?;
	Ok(())
}

pub fn create_dir(root: &Path, rel_path: &str) -> Result<(), String> {
	let path = resolve_workspace_path(root, rel_path)?;
	if fs::symlink_metadata(&path).is_ok() {
		return Err("Path already exists".to_string());
	}
	fs::create_dir_all(&path).map_err(|e| format!("Failed to create directory: {e}"))
}

fn is_same_case_only_rename(old_path: &Path, new_path: &Path) -> bool {
	#[cfg(windows)]
	{
		old_path
			.to_string_lossy()
			.eq_ignore_ascii_case(&new_path.to_string_lossy())
	}
	#[cfg(not(windows))]
	{
		let _ = (old_path, new_path);
		false
	}
}

pub fn rename_path(root: &Path, old_rel: &str, new_rel: &str) -> Result<(), String> {
	let canon_root = fs::canonicalize(root).map_err(|e| format!("Invalid workspace root: {e}"))?;
	let old_path = resolve_workspace_path(root, old_rel)?;
	let new_path = resolve_workspace_path(root, new_rel)?;
	if old_path == canon_root || new_path == canon_root {
		return Err("Cannot rename workspace root".to_string());
	}
	if fs::symlink_metadata(&old_path).is_err() {
		return Err("Source path does not exist".to_string());
	}
	if fs::symlink_metadata(&new_path).is_ok() && !is_same_case_only_rename(&old_path, &new_path) {
		return Err("Destination path already exists".to_string());
	}
	if let Some(parent) = new_path.parent() {
		fs::create_dir_all(parent)
			.map_err(|e| format!("Failed to create destination directory: {e}"))?;
	}
	fs::rename(&old_path, &new_path).map_err(|e| format!("Failed to rename path: {e}"))
}

pub fn delete_path(root: &Path, rel_path: &str) -> Result<(), String> {
	let canon_root = fs::canonicalize(root).map_err(|e| format!("Invalid workspace root: {e}"))?;
	let path = resolve_workspace_path(root, rel_path)?;
	if path == canon_root {
		return Err("Cannot delete workspace root".to_string());
	}
	let meta =
		fs::symlink_metadata(&path).map_err(|e| format!("Target path does not exist: {e}"))?;
	if meta.file_type().is_symlink() {
		if meta.file_type().is_dir() {
			fs::remove_dir(&path).map_err(|e| format!("Failed to delete symlink directory: {e}"))
		} else {
			fs::remove_file(&path).map_err(|e| format!("Failed to delete symlink: {e}"))
		}
	} else if meta.file_type().is_dir() {
		fs::remove_dir_all(&path).map_err(|e| format!("Failed to delete directory: {e}"))
	} else {
		fs::remove_file(&path).map_err(|e| format!("Failed to delete file: {e}"))
	}
}

fn is_probably_binary_path(path: &Path) -> bool {
	let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
		return false;
	};
	BINARY_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str())
}

pub fn search_in_workspace(
	root: &Path,
	query: &str,
	case_sensitive: bool,
	use_regex: bool,
) -> Result<LimitedResults<SearchMatch>, String> {
	if query.is_empty() {
		return Ok(LimitedResults::new(vec![], MAX_SEARCH_MATCHES));
	}
	let pattern = if use_regex {
		query.to_string()
	} else {
		regex::escape(query)
	};
	let re = RegexBuilder::new(&pattern)
		.case_insensitive(!case_sensitive)
		.build()
		.map_err(|e| format!("Invalid search pattern: {e}"))?;

	let canon_root = fs::canonicalize(root).map_err(|e| format!("Invalid workspace root: {e}"))?;
	let mut visited = HashSet::new();
	let mut files = Vec::new();
	collect_workspace_files(&canon_root, &canon_root, &mut visited, &mut files, None, "");

	let mut matches = Vec::new();
	for rel_path in files {
		if matches.len() > MAX_SEARCH_MATCHES {
			break;
		}
		let full_path = canon_root.join(&rel_path);
		if is_probably_binary_path(&full_path) {
			continue;
		}
		let Ok(meta) = fs::metadata(&full_path) else {
			continue;
		};
		if meta.len() > MAX_SEARCH_FILE_BYTES {
			continue;
		}
		let Ok(bytes) = fs::read(&full_path) else {
			continue;
		};
		let sample_len = bytes.len().min(8192);
		if bytes[..sample_len].contains(&0) {
			continue;
		}
		let Ok(text) = std::str::from_utf8(&bytes) else {
			continue;
		};
		for (idx, line) in text.lines().enumerate() {
			for m in re.find_iter(line) {
				let prefix = &line[..m.start()];
				let col = prefix.encode_utf16().count() as u32 + 1;
				let start = prefix.char_indices().rev().nth(79).map_or(0, |(i, _)| i);
				let preview: String = line[start..].chars().take(500).collect();
				matches.push(SearchMatch {
					rel_path: rel_path.clone(),
					line: idx as u32 + 1,
					column: col,
					end_column: col + m.as_str().encode_utf16().count() as u32,
					preview_column: col - line[start..m.start()].encode_utf16().count() as u32,
					line_text: preview,
				});
				if matches.len() > MAX_SEARCH_MATCHES {
					break;
				}
			}
			if matches.len() > MAX_SEARCH_MATCHES {
				break;
			}
		}
	}
	Ok(LimitedResults::new(matches, MAX_SEARCH_MATCHES))
}

#[cfg(test)]
mod tests {
	use super::*;
	use uuid::Uuid;

	fn temp_workspace(name: &str) -> PathBuf {
		let dir = std::env::temp_dir().join(format!("fabric_studio_fs_{name}_{}", Uuid::new_v4()));
		fs::create_dir_all(&dir).unwrap();
		dir
	}

	#[test]
	fn search_ranges_and_limit_use_editor_coordinates() {
		let dir = tempfile::tempdir().unwrap();
		let file = dir.path().join("a.txt");
		let prefix = "a".repeat(501);
		fs::write(&file, format!("{prefix}😀한글 한글")).unwrap();
		let hits = search_in_workspace(dir.path(), "한.", false, true).unwrap();
		assert_eq!(hits.items.len(), 2);
		for (hit, expected) in hits.items.iter().zip([504, 507]) {
			assert_eq!((hit.column, hit.end_column), (expected, expected + 2));
			let units: Vec<_> = hit.line_text.encode_utf16().collect();
			let start = (hit.column - hit.preview_column) as usize;
			assert_eq!(
				String::from_utf16(&units[start..start + 2]).unwrap(),
				"한글"
			);
		}
		for count in [500, 501] {
			fs::write(&file, "x\n".repeat(count)).unwrap();
			let result = search_in_workspace(dir.path(), "x", true, false).unwrap();
			assert_eq!(result.items.len(), 500);
			assert_eq!(result.truncated, count > 500);
		}
	}

	#[test]
	fn filename_query_finds_entries_beyond_initial_page() {
		let dir = tempfile::tempdir().unwrap();
		for i in 0..=MAX_ALL_FILES {
			fs::File::create(dir.path().join(format!("file{i:05}"))).unwrap();
		}
		let first = list_all_files(dir.path(), "").unwrap();
		assert!(first.truncated);
		assert!(!first.items.iter().any(|s| s == "file05000"));
		assert_eq!(
			list_all_files(dir.path(), "FILE05000").unwrap().items,
			["file05000"]
		);
	}

	#[test]
	fn checked_save_preserves_external_edits_and_requires_review_after_deletion() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path();
		let file = root.join("document");
		fs::write(&file, "external").unwrap();
		assert_eq!(save_checked(root, "document", Some("base"), "editor").unwrap()["disk"], "external");
		assert_eq!(fs::read_to_string(&file).unwrap(), "external");
		assert!(save_checked(root, "document", Some("external"), "editor").unwrap().is_null());
		fs::remove_file(&file).unwrap();
		assert_eq!(save_checked(root, "document", Some("editor"), "next").unwrap(), serde_json::json!({"disk":null}));
		assert!(!file.exists());
		assert!(save_checked(root, "document", None, "restored").unwrap().is_null());
		assert_eq!(fs::read_to_string(file).unwrap(), "restored");
	}

	#[test]
	fn rejects_path_traversal_and_root_prefixes() {
		let root = temp_workspace("traversal");
		let sub = root.join("src");
		fs::create_dir_all(&sub).unwrap();

		assert!(resolve_workspace_path(&root, "../secret.txt").is_err());
		assert!(resolve_workspace_path(&root, "src/../../outside.txt").is_err());
		assert!(resolve_workspace_path(&root, r"..\outside.txt").is_err());
		assert!(resolve_workspace_path(&root, "/etc/passwd").is_err());
		assert!(resolve_workspace_path(&root, r"\Windows\System32").is_err());
		assert!(resolve_workspace_path(&root, r"C:\Windows\win.ini").is_err());
		assert!(resolve_workspace_path(&root, "src/\0bad").is_err());

		// Non-existent nested file under workspace resolves cleanly
		let valid_new = resolve_workspace_path(&root, "src/main/java/Mod.java").unwrap();
		assert!(valid_new.starts_with(fs::canonicalize(&root).unwrap()));
		assert!(valid_new.ends_with(Path::new("src").join("main").join("java").join("Mod.java")));

		let _ = fs::remove_dir_all(&root);
	}

	#[test]
	fn crud_and_directory_listing_work() {
		let root = temp_workspace("crud");
		create_dir(&root, "src/main").unwrap();
		create_file(&root, "src/main/App.java").unwrap();
		write_file(&root, "src/main/App.java", "public class App {}").unwrap();
		assert_eq!(
			read_file(&root, "src/main/App.java").unwrap(),
			"public class App {}"
		);

		create_dir(&root, "build/classes").unwrap();
		write_file(&root, "build/classes/App.class", "bin").unwrap();
		write_file(&root, ".gitignore", "build/\n").unwrap();
		write_file(&root, "zebra.txt", "z").unwrap();
		write_file(&root, "Alpha.txt", "a").unwrap();

		// Heavy build dirs & hidden files skipped at root when show_hidden=false
		let top = list_directory(&root, None, false).unwrap();
		let names: Vec<_> = top.iter().map(|n| n.name.as_str()).collect();
		assert_eq!(names, vec!["src", "Alpha.txt", "zebra.txt"]);
		assert!(top[0].is_dir);
		assert!(!top[1].is_dir);

		// Explicit expansion of build shows its children
		let build_entries = list_directory(&root, Some("build"), false).unwrap();
		assert_eq!(build_entries.len(), 1);
		assert_eq!(build_entries[0].name, "classes");

		// show_hidden=true reveals .gitignore and build
		let all_top = list_directory(&root, None, true).unwrap();
		let all_names: Vec<_> = all_top.iter().map(|n| n.name.as_str()).collect();
		assert!(all_names.contains(&".gitignore"));
		assert!(all_names.contains(&"build"));

		// list_all_files skips build/
		let flat = list_all_files(&root, "").unwrap().items;
		assert!(flat.contains(&"src/main/App.java".to_string()));
		assert!(!flat.iter().any(|p| p.starts_with("build/")));

		// rename & delete
		rename_path(&root, "zebra.txt", "Beta.txt").unwrap();
		assert_eq!(read_file(&root, "Beta.txt").unwrap(), "z");
		delete_path(&root, "Beta.txt").unwrap();
		assert!(read_file(&root, "Beta.txt").is_err());

		let _ = fs::remove_dir_all(&root);
	}

	#[test]
	fn search_skips_binary_and_reports_one_based_positions() {
		let root = temp_workspace("search");
		write_file(
			&root,
			"src/Example.java",
			"package mod;\n// Hello Fabric\nint x = 1;",
		)
		.unwrap();
		write_file(&root, "build/Ignore.java", "// Hello Build").unwrap();
		let binary_path = root.join("assets").join("icon.dat");
		fs::create_dir_all(binary_path.parent().unwrap()).unwrap();
		fs::write(&binary_path, b"Hello\x00Binary").unwrap();

		let plain = search_in_workspace(&root, "hello", false, false)
			.unwrap()
			.items;
		assert_eq!(plain.len(), 1);
		assert_eq!(plain[0].rel_path, "src/Example.java");
		assert_eq!(plain[0].line, 2);
		assert_eq!(plain[0].column, 4);

		// Case-sensitive miss
		let miss = search_in_workspace(&root, "hello", true, false)
			.unwrap()
			.items;
		assert!(miss.is_empty());

		// Regex match
		let re_hits = search_in_workspace(&root, r"int\s+\w+\s*=\s*\d+", true, true)
			.unwrap()
			.items;
		assert_eq!(re_hits.len(), 1);
		assert_eq!(re_hits[0].line, 3);
		assert_eq!(re_hits[0].column, 1);

		let _ = fs::remove_dir_all(&root);
	}
}
