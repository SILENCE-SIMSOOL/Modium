use std::fs;
use std::path::{Path, PathBuf};

use chrono::Utc;

use crate::models::{AppSettings, RecentProject};

const MAX_RECENT_PROJECTS: usize = 10;

pub fn settings_file_path() -> PathBuf {
	dirs::config_dir()
		.unwrap_or_else(std::env::temp_dir)
		.join("FabricStudio")
		.join("settings.toml")
}

pub fn load_settings_from(path: &Path) -> AppSettings {
	let Ok(raw) = fs::read_to_string(path) else {
		return AppSettings::default();
	};
	toml::from_str::<AppSettings>(&raw).unwrap_or_default()
}

pub fn save_settings_to(path: &Path, settings: &AppSettings) -> Result<(), String> {
	if let Some(parent) = path.parent() {
		fs::create_dir_all(parent)
			.map_err(|e| format!("Failed to create settings directory: {e}"))?;
	}
	let serialized = toml::to_string_pretty(settings)
		.map_err(|e| format!("Failed to serialize settings: {e}"))?;
	fs::write(path, serialized).map_err(|e| format!("Failed to write settings file: {e}"))
}

pub fn load_settings() -> AppSettings {
	load_settings_from(&settings_file_path())
}

pub fn save_settings_file(settings: &AppSettings) -> Result<(), String> {
	save_settings_to(&settings_file_path(), settings)
}

fn same_project_path(a: &str, b: &str) -> bool {
	let norm = |s: &str| {
		let trimmed = s.replace('\\', "/");
		trimmed.trim_end_matches('/').to_string()
	};
	let na = norm(a);
	let nb = norm(b);
	#[cfg(windows)]
	{
		na.eq_ignore_ascii_case(&nb)
	}
	#[cfg(not(windows))]
	{
		na == nb
	}
}

pub fn record_recent_project(settings: &mut AppSettings, name: &str, path: &str, mc_version: &str) {
	settings
		.recent_projects
		.retain(|entry| !same_project_path(&entry.path, path));
	settings.recent_projects.insert(
		0,
		RecentProject {
			name: name.to_string(),
			path: path.to_string(),
			mc_version: mc_version.to_string(),
			last_opened: Utc::now().to_rfc3339(),
		},
	);
	settings.recent_projects.truncate(MAX_RECENT_PROJECTS);
	settings.last_project = Some(path.to_string());
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::models::AppLanguage;
	use uuid::Uuid;

	fn temp_dir(name: &str) -> PathBuf {
		let dir =
			std::env::temp_dir().join(format!("fabric_studio_settings_{name}_{}", Uuid::new_v4()));
		fs::create_dir_all(&dir).unwrap();
		dir
	}

	#[test]
	fn toml_roundtrip_preserves_settings() {
		let dir = temp_dir("roundtrip");
		let file = dir.join("nested").join("settings.toml");
		let mut settings = AppSettings {
			language: AppLanguage::Zh,
			theme: crate::models::AppTheme::Light,
			font_size: 16,
			tab_size: 2,
			auto_save: false,
			auto_save_delay_ms: 2500,
			preferred_jdk_path: "C:\\Program Files\\Java\\jdk-25".to_string(),
			recent_projects: Vec::new(),
			last_project: None,
		};
		record_recent_project(&mut settings, "TestMod", "D:\\Mods\\TestMod", "26.3");

		save_settings_to(&file, &settings).unwrap();
		let loaded = load_settings_from(&file);

		assert_eq!(loaded.language, AppLanguage::Zh);
		assert_eq!(loaded.theme, crate::models::AppTheme::Light);
		assert_eq!(loaded.font_size, 16);
		assert_eq!(loaded.tab_size, 2);
		assert!(!loaded.auto_save);
		assert_eq!(loaded.auto_save_delay_ms, 2500);
		assert_eq!(loaded.preferred_jdk_path, "C:\\Program Files\\Java\\jdk-25");
		assert_eq!(loaded.last_project.as_deref(), Some("D:\\Mods\\TestMod"));
		assert_eq!(loaded.recent_projects.len(), 1);
		assert_eq!(loaded.recent_projects[0].name, "TestMod");
		assert_eq!(loaded.recent_projects[0].mc_version, "26.3");

		let _ = fs::remove_dir_all(&dir);
	}

	#[test]
	fn missing_or_corrupt_toml_falls_back_to_default() {
		let dir = temp_dir("fallback");
		let missing = dir.join("missing.toml");
		let default_settings = load_settings_from(&missing);
		assert_eq!(default_settings.language, AppLanguage::Ko);
		assert_eq!(default_settings.font_size, 14);
		assert!(default_settings.last_project.is_none());

		let corrupt = dir.join("corrupt.toml");
		fs::write(&corrupt, "language = [not valid toml").unwrap();
		let recovered = load_settings_from(&corrupt);
		assert_eq!(recovered.language, AppLanguage::Ko);
		assert_eq!(recovered.tab_size, 4);

		let _ = fs::remove_dir_all(&dir);
	}

	#[test]
	fn record_recent_project_dedupes_and_caps_at_ten() {
		let mut settings = AppSettings::default();
		for i in 0..12 {
			let path = format!("D:\\Mods\\Mod{i}");
			record_recent_project(&mut settings, &format!("Mod{i}"), &path, "26.3");
		}
		assert_eq!(settings.recent_projects.len(), 10);
		assert_eq!(settings.recent_projects[0].path, "D:\\Mods\\Mod11");
		assert_eq!(settings.last_project.as_deref(), Some("D:\\Mods\\Mod11"));
		assert!(
			chrono::DateTime::parse_from_rfc3339(&settings.recent_projects[0].last_opened).is_ok()
		);

		// Re-opening an older project moves it to index 0 without duplicating
		record_recent_project(&mut settings, "Mod5 Updated", "D:\\Mods\\Mod5\\", "1.21.11");
		assert_eq!(settings.recent_projects.len(), 10);
		assert_eq!(settings.recent_projects[0].name, "Mod5 Updated");
		assert_eq!(settings.recent_projects[0].mc_version, "1.21.11");
		assert_eq!(settings.last_project.as_deref(), Some("D:\\Mods\\Mod5\\"));
	}
}