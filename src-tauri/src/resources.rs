use std::fs;
use std::path::{Component, Path, PathBuf};

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;

use crate::models::{ResourceCatalog, ResourceEntry, ResourceKind, ResourcePreview};

const PNG_SIGNATURE: [u8; 8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
const MAX_AUDIO_BASE64_BYTES: usize = 5 * 1024 * 1024;

/// Scans `src/*/resources/assets/` for Minecraft textures, models, blockstates, lang, and sound files.
pub fn scan_resources(root: &Path) -> Result<ResourceCatalog, String> {
	if !root.is_dir() {
		return Err(format!("Project root does not exist: {}", root.display()));
	}
	let mut entries = Vec::new();
	let src_dir = root.join("src");
	if !src_dir.is_dir() {
		return Ok(ResourceCatalog { entries });
	}
	let source_sets =
		fs::read_dir(&src_dir).map_err(|err| format!("Failed to read src directory: {}", err))?;
	for source_set in source_sets.flatten() {
		let assets_dir = source_set.path().join("resources").join("assets");
		if !assets_dir.is_dir() {
			continue;
		}
		let namespaces = match fs::read_dir(&assets_dir) {
			Ok(dir) => dir,
			Err(_) => continue,
		};
		for ns_entry in namespaces.flatten() {
			let ns_path = ns_entry.path();
			if !ns_path.is_dir() {
				continue;
			}
			let namespace = ns_entry.file_name().to_string_lossy().to_string();
			collect_namespace_resources(root, &ns_path, &ns_path, &namespace, &mut entries)?;
		}
	}
	entries.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
	Ok(ResourceCatalog { entries })
}

pub fn read_resource_preview(root: &Path, rel_path: &str) -> Result<ResourcePreview, String> {
	let abs_path = resolve_safe_path(root, rel_path)?;
	if !abs_path.is_file() {
		return Err(format!("Resource file not found: {}", rel_path));
	}
	let normalized_rel = rel_path.replace('\\', "/");
	let kind = classify_rel_path(&normalized_rel);
	let ext = abs_path
		.extension()
		.and_then(|e| e.to_str())
		.map(|e| e.to_ascii_lowercase())
		.unwrap_or_default();
	let bytes = fs::read(&abs_path)
		.map_err(|err| format!("Failed to read resource '{}': {}", normalized_rel, err))?;
	match ext.as_str() {
		"png" => {
			let (width, height) = parse_png_dimensions(&bytes)
				.map(|(w, h)| (Some(w), Some(h)))
				.unwrap_or((None, None));
			Ok(ResourcePreview {
				rel_path: normalized_rel,
				kind,
				mime_type: Some("image/png".to_string()),
				base64_data: Some(BASE64_STANDARD.encode(&bytes)),
				text_content: None,
				width,
				height,
				valid_json: None,
				json_error: None,
			})
		}
		"jpg" | "jpeg" | "webp" | "gif" => {
			let mime = match ext.as_str() {
				"jpg" | "jpeg" => "image/jpeg",
				"webp" => "image/webp",
				_ => "image/gif",
			};
			Ok(ResourcePreview {
				rel_path: normalized_rel,
				kind,
				mime_type: Some(mime.to_string()),
				base64_data: Some(BASE64_STANDARD.encode(&bytes)),
				text_content: None,
				width: None,
				height: None,
				valid_json: None,
				json_error: None,
			})
		}
		"json" | "mcmeta" => {
			let text = String::from_utf8(bytes)
				.map_err(|_| format!("Resource '{}' is not valid UTF-8", normalized_rel))?;
			let (valid_json, json_error) = match serde_json::from_str::<serde_json::Value>(&text) {
				Ok(_) => (Some(true), None),
				Err(err) => (Some(false), Some(err.to_string())),
			};
			Ok(ResourcePreview {
				rel_path: normalized_rel,
				kind,
				mime_type: Some("application/json".to_string()),
				base64_data: None,
				text_content: Some(text),
				width: None,
				height: None,
				valid_json,
				json_error,
			})
		}
		"txt" | "lang" | "properties" | "fsh" | "vsh" | "glsl" | "md" => {
			let text = String::from_utf8_lossy(&bytes).to_string();
			Ok(ResourcePreview {
				rel_path: normalized_rel,
				kind,
				mime_type: Some("text/plain".to_string()),
				base64_data: None,
				text_content: Some(text),
				width: None,
				height: None,
				valid_json: None,
				json_error: None,
			})
		}
		"ogg" | "wav" | "mp3" => {
			let mime = match ext.as_str() {
				"ogg" => "audio/ogg",
				"wav" => "audio/wav",
				_ => "audio/mpeg",
			};
			let base64_data =
				(bytes.len() <= MAX_AUDIO_BASE64_BYTES).then(|| BASE64_STANDARD.encode(&bytes));
			Ok(ResourcePreview {
				rel_path: normalized_rel,
				kind,
				mime_type: Some(mime.to_string()),
				base64_data,
				text_content: None,
				width: None,
				height: None,
				valid_json: None,
				json_error: None,
			})
		}
		_ => Ok(ResourcePreview {
			rel_path: normalized_rel,
			kind,
			mime_type: Some("application/octet-stream".to_string()),
			base64_data: None,
			text_content: None,
			width: None,
			height: None,
			valid_json: None,
			json_error: None,
		}),
	}
}

fn collect_namespace_resources(
	root: &Path,
	ns_root: &Path,
	current_dir: &Path,
	namespace: &str,
	entries: &mut Vec<ResourceEntry>,
) -> Result<(), String> {
	let dir_entries = fs::read_dir(current_dir)
		.map_err(|err| format!("Failed to read '{}': {}", current_dir.display(), err))?;
	for item in dir_entries.flatten() {
		let path = item.path();
		if path.is_dir() {
			collect_namespace_resources(root, ns_root, &path, namespace, entries)?;
		} else if path.is_file() {
			let rel_to_root = path
				.strip_prefix(root)
				.map_err(|err| err.to_string())?
				.to_string_lossy()
				.replace('\\', "/");
			let rel_to_ns = path
				.strip_prefix(ns_root)
				.map_err(|err| err.to_string())?
				.to_string_lossy()
				.replace('\\', "/");
			let (kind, name) = classify_namespace_subpath(&rel_to_ns);
			let size = item.metadata().map(|m| m.len()).unwrap_or(0);
			entries.push(ResourceEntry {
				rel_path: rel_to_root,
				kind,
				namespace: namespace.to_string(),
				name,
				size,
			});
		}
	}
	Ok(())
}

fn classify_rel_path(rel_path: &str) -> ResourceKind {
	if let Some((_, after_assets)) = rel_path.split_once("/assets/") {
		if let Some((_, subpath)) = after_assets.split_once('/') {
			return classify_namespace_subpath(subpath).0;
		}
	}
	classify_namespace_subpath(rel_path).0
}

fn classify_namespace_subpath(subpath: &str) -> (ResourceKind, String) {
	let lower = subpath.to_ascii_lowercase();
	if let Some(rest) = strip_prefix_ci(subpath, &lower, "textures/") {
		if lower.ends_with(".png")
			|| lower.ends_with(".jpg")
			|| lower.ends_with(".jpeg")
			|| lower.ends_with(".webp")
			|| lower.ends_with(".gif")
		{
			return (ResourceKind::Texture, rest.to_string());
		}
		return (ResourceKind::Other, subpath.to_string());
	}
	if let Some(rest) = strip_prefix_ci(subpath, &lower, "models/") {
		if lower.ends_with(".json") {
			return (ResourceKind::Model, rest.to_string());
		}
		return (ResourceKind::Other, subpath.to_string());
	}
	if let Some(rest) = strip_prefix_ci(subpath, &lower, "blockstates/") {
		if lower.ends_with(".json") {
			return (ResourceKind::Blockstate, rest.to_string());
		}
		return (ResourceKind::Other, subpath.to_string());
	}
	if let Some(rest) = strip_prefix_ci(subpath, &lower, "lang/") {
		if lower.ends_with(".json") || lower.ends_with(".lang") {
			return (ResourceKind::Lang, rest.to_string());
		}
		return (ResourceKind::Other, subpath.to_string());
	}
	if let Some(rest) = strip_prefix_ci(subpath, &lower, "sounds/") {
		return (ResourceKind::Sound, rest.to_string());
	}
	if lower == "sounds.json" {
		return (ResourceKind::Sound, subpath.to_string());
	}
	if lower.ends_with(".png") {
		return (ResourceKind::Texture, subpath.to_string());
	}
	(ResourceKind::Other, subpath.to_string())
}

fn strip_prefix_ci<'a>(orig: &'a str, lower: &str, prefix: &str) -> Option<&'a str> {
	lower.starts_with(prefix).then(|| &orig[prefix.len()..])
}

/// Reads PNG width and height directly from the mandatory IHDR chunk.
pub fn parse_png_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
	if bytes.len() < 24 {
		return None;
	}
	if bytes[0..8] != PNG_SIGNATURE {
		return None;
	}
	if &bytes[12..16] != b"IHDR" {
		return None;
	}
	let width = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
	let height = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
	Some((width, height))
}

fn resolve_safe_path(root: &Path, rel_path: &str) -> Result<PathBuf, String> {
	let rel = Path::new(rel_path);
	for comp in rel.components() {
		match comp {
			Component::Normal(_) | Component::CurDir => {}
			Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
				return Err(format!("Unsafe resource path rejected: {}", rel_path));
			}
		}
	}
	let canon_root = root
		.canonicalize()
		.map_err(|err| format!("Failed to canonicalize root: {}", err))?;
	let joined = canon_root.join(rel);
	let canon_target = joined
		.canonicalize()
		.map_err(|err| format!("Resource '{}' does not exist: {}", rel_path, err))?;
	if !canon_target.starts_with(&canon_root) {
		return Err(format!("Path escapes project root: {}", rel_path));
	}
	Ok(canon_target)
}

#[cfg(test)]
mod tests {
	use super::*;
	use uuid::Uuid;

	fn sample_png_bytes(width: u32, height: u32) -> Vec<u8> {
		let mut out = Vec::with_capacity(33);
		out.extend_from_slice(&PNG_SIGNATURE);
		out.extend_from_slice(&13u32.to_be_bytes());
		out.extend_from_slice(b"IHDR");
		out.extend_from_slice(&width.to_be_bytes());
		out.extend_from_slice(&height.to_be_bytes());
		out.extend_from_slice(&[8, 6, 0, 0, 0]);
		out.extend_from_slice(&[0, 0, 0, 0]);
		out
	}

	#[test]
	fn scans_and_previews_png_and_json_resources() {
		let root = std::env::temp_dir().join(format!("fs_res_test_{}", Uuid::new_v4()));
		let tex_dir = root.join("src/main/resources/assets/examplemod/textures/item");
		let lang_dir = root.join("src/main/resources/assets/examplemod/lang");
		let model_dir = root.join("src/client/resources/assets/examplemod/models/item");
		fs::create_dir_all(&tex_dir).unwrap();
		fs::create_dir_all(&lang_dir).unwrap();
		fs::create_dir_all(&model_dir).unwrap();
		fs::write(tex_dir.join("ruby.png"), sample_png_bytes(16, 32)).unwrap();
		fs::write(
			lang_dir.join("en_us.json"),
			r#"{"item.examplemod.ruby":"Ruby"}"#,
		)
		.unwrap();
		fs::write(model_dir.join("broken.json"), r#"{"parent": }"#).unwrap();

		let catalog = scan_resources(&root).unwrap();
		assert_eq!(catalog.entries.len(), 3);
		assert!(catalog
			.entries
			.iter()
			.any(|e| e.kind == ResourceKind::Texture && e.name == "item/ruby.png"));
		assert!(catalog
			.entries
			.iter()
			.any(|e| e.kind == ResourceKind::Lang && e.name == "en_us.json"));
		assert!(catalog
			.entries
			.iter()
			.any(|e| e.kind == ResourceKind::Model && e.name == "item/broken.json"));

		let png_preview = read_resource_preview(
			&root,
			"src/main/resources/assets/examplemod/textures/item/ruby.png",
		)
		.unwrap();
		assert_eq!(png_preview.width, Some(16));
		assert_eq!(png_preview.height, Some(32));
		assert_eq!(png_preview.mime_type.as_deref(), Some("image/png"));
		assert!(png_preview.base64_data.is_some());

		let valid_json = read_resource_preview(
			&root,
			"src/main/resources/assets/examplemod/lang/en_us.json",
		)
		.unwrap();
		assert_eq!(valid_json.valid_json, Some(true));
		assert!(valid_json.json_error.is_none());

		let bad_json = read_resource_preview(
			&root,
			"src/client/resources/assets/examplemod/models/item/broken.json",
		)
		.unwrap();
		assert_eq!(bad_json.valid_json, Some(false));
		assert!(bad_json.json_error.is_some());

		assert!(read_resource_preview(&root, "../secret.txt").is_err());
		let _ = fs::remove_dir_all(&root);
	}
}