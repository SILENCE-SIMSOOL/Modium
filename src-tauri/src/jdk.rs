use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use tokio::process::Command;

use crate::models::JdkInfo;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;
#[cfg(windows)]
const JAVA_BIN: &str = "java.exe";
#[cfg(not(windows))]
const JAVA_BIN: &str = "java";

fn clean_display_path(path: &Path) -> PathBuf {
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

fn canonical_key(path: &Path) -> String {
	let cleaned = clean_display_path(path);
	let s = cleaned.to_string_lossy().replace('\\', "/");
	let trimmed = s.trim_end_matches('/');
	#[cfg(windows)]
	{
		trimmed.to_ascii_lowercase()
	}
	#[cfg(not(windows))]
	{
		trimmed.to_string()
	}
}

pub fn parse_java_major(version: &str) -> Option<u32> {
	let trimmed = version.trim().trim_matches('"');
	if trimmed.is_empty() {
		return None;
	}
	let mut parts = trimmed
		.split(['.', '-', '+', '_'])
		.filter(|p| !p.is_empty());
	let first: u32 = parts.next()?.parse().ok()?;
	if first == 1 {
		let second: u32 = parts.next()?.parse().ok()?;
		Some(second)
	} else {
		Some(first)
	}
}

pub fn parse_release_content(content: &str) -> Option<(String, u32, String)> {
	let mut version: Option<String> = None;
	let mut vendor: Option<String> = None;
	for line in content.lines() {
		let trimmed = line.trim();
		if let Some(val) = trimmed.strip_prefix("JAVA_VERSION=") {
			let v = val.trim().trim_matches('"').to_string();
			if !v.is_empty() {
				version = Some(v);
			}
		} else if let Some(val) = trimmed.strip_prefix("IMPLEMENTOR=") {
			let imp = val.trim().trim_matches('"').to_string();
			if !imp.is_empty() {
				vendor = Some(imp);
			}
		}
	}
	let version = version?;
	let major = parse_java_major(&version)?;
	let vendor = vendor.unwrap_or_else(|| "Unknown".to_string());
	Some((version, major, vendor))
}

pub fn parse_java_version_output(output: &str) -> Option<(String, u32, String)> {
	let mut version: Option<String> = None;
	for line in output.lines() {
		if let Some(start) = line.find('"') {
			let rest = &line[start + 1..];
			if let Some(end) = rest.find('"') {
				let candidate = &rest[..end];
				if parse_java_major(candidate).is_some() {
					version = Some(candidate.to_string());
					break;
				}
			}
		}
	}
	let version = version?;
	let major = parse_java_major(&version)?;
	let lower = output.to_ascii_lowercase();
	let vendor = if lower.contains("temurin") || lower.contains("adoptium") {
		"Eclipse Adoptium".to_string()
	} else if lower.contains("microsoft") {
		"Microsoft".to_string()
	} else if lower.contains("zulu") || lower.contains("azul") {
		"Azul Systems".to_string()
	} else if lower.contains("corretto") || lower.contains("amazon") {
		"Amazon.com Inc.".to_string()
	} else if lower.contains("graalvm") {
		"GraalVM".to_string()
	} else if lower.contains("java(tm)") {
		"Oracle Corporation".to_string()
	} else if lower.contains("openjdk") {
		"OpenJDK".to_string()
	} else {
		"Unknown".to_string()
	};
	Some((version, major, vendor))
}

async fn probe_java_binary(java_exe: &Path) -> Option<(String, u32, String)> {
	let mut cmd = Command::new(java_exe);
	cmd.arg("-version");
	#[cfg(windows)]
	cmd.creation_flags(CREATE_NO_WINDOW);
	let output = cmd.output().await.ok()?;
	let stderr = String::from_utf8_lossy(&output.stderr);
	if let Some(parsed) = parse_java_version_output(&stderr) {
		return Some(parsed);
	}
	let stdout = String::from_utf8_lossy(&output.stdout);
	parse_java_version_output(&stdout)
}

async fn inspect_jdk_root(candidate: &Path) -> Option<JdkInfo> {
	let java_exe = candidate.join("bin").join(JAVA_BIN);
	if !java_exe.is_file() {
		return None;
	}
	let canon = fs::canonicalize(candidate).ok()?;
	let display = clean_display_path(&canon);
	let release_path = canon.join("release");
	if let Ok(content) = fs::read_to_string(&release_path) {
		if let Some((version, major, vendor)) = parse_release_content(&content) {
			return Some(JdkInfo {
				path: display.to_string_lossy().to_string(),
				version,
				major,
				vendor,
				is_default: false,
			});
		}
	}
	let (version, major, vendor) = probe_java_binary(&java_exe).await?;
	Some(JdkInfo {
		path: display.to_string_lossy().to_string(),
		version,
		major,
		vendor,
		is_default: false,
	})
}

fn collect_scan_candidates() -> Vec<PathBuf> {
	let mut candidates = Vec::new();
	if let Some(java_home) = std::env::var_os("JAVA_HOME") {
		if !java_home.is_empty() {
			candidates.push(PathBuf::from(java_home));
		}
	}
	if let Some(path_var) = std::env::var_os("PATH") {
		for entry in std::env::split_paths(&path_var) {
			let java_in_entry = entry.join(JAVA_BIN);
			if java_in_entry.is_file() {
				if entry.file_name().and_then(|n| n.to_str()) == Some("bin") {
					if let Some(parent) = entry.parent() {
						candidates.push(parent.to_path_buf());
					}
				}
				if let Ok(resolved) = fs::canonicalize(&java_in_entry) {
					if let Some(bin_dir) = resolved.parent() {
						if bin_dir.file_name().and_then(|n| n.to_str()) == Some("bin") {
							if let Some(root) = bin_dir.parent() {
								candidates.push(root.to_path_buf());
							}
						}
					}
				}
			}
		}
	}
	let mut containers: Vec<PathBuf> = Vec::new();
	#[cfg(windows)]
	{
		containers.push(PathBuf::from(r"C:\Program Files\Java"));
		containers.push(PathBuf::from(r"C:\Program Files\Eclipse Adoptium"));
		containers.push(PathBuf::from(r"C:\Program Files\Microsoft"));
		containers.push(PathBuf::from(r"C:\Program Files\Zulu"));
		containers.push(PathBuf::from(r"C:\Program Files\Amazon Corretto"));
		if let Some(profile) = std::env::var_os("USERPROFILE") {
			containers.push(PathBuf::from(profile).join(".jdks"));
		}
	}
	#[cfg(not(windows))]
	{
		containers.push(PathBuf::from("/usr/lib/jvm"));
	}
	if let Some(home) = dirs::home_dir() {
		containers.push(home.join(".jdks"));
	}
	for container in containers {
		if let Ok(entries) = fs::read_dir(&container) {
			for entry in entries.flatten() {
				let path = entry.path();
				if path.is_dir() {
					candidates.push(path.clone());
					let mac_home = path.join("Contents").join("Home");
					if mac_home.is_dir() {
						candidates.push(mac_home);
					}
				}
			}
		}
	}
	candidates
}

fn mark_default_jdk(jdks: &mut [JdkInfo], java_home: Option<&Path>) {
	if jdks.is_empty() {
		return;
	}
	if let Some(jh) = java_home {
		if let Ok(canon_jh) = fs::canonicalize(jh) {
			let target_key = canonical_key(&canon_jh);
			if let Some(matched) = jdks
				.iter_mut()
				.find(|j| canonical_key(Path::new(&j.path)) == target_key)
			{
				matched.is_default = true;
				return;
			}
		}
	}
	if let Some(best_modern) = jdks.iter_mut().find(|j| j.major >= 21) {
		best_modern.is_default = true;
	}
}

pub async fn list_jdks() -> Vec<JdkInfo> {
	let candidates = collect_scan_candidates();
	let mut seen = HashSet::new();
	let mut jdks = Vec::new();
	for candidate in candidates {
		let Ok(canon) = fs::canonicalize(&candidate) else {
			continue;
		};
		let key = canonical_key(&canon);
		if !seen.insert(key) {
			continue;
		}
		if let Some(info) = inspect_jdk_root(&canon).await {
			jdks.push(info);
		}
	}
	jdks.sort_by(|a, b| {
		b.major
			.cmp(&a.major)
			.then_with(|| b.version.cmp(&a.version))
			.then_with(|| a.path.cmp(&b.path))
	});
	let java_home = std::env::var_os("JAVA_HOME")
		.filter(|s| !s.is_empty())
		.map(PathBuf::from);
	mark_default_jdk(&mut jdks, java_home.as_deref());
	jdks
}

pub fn select_best_jdk(
	jdks: &[JdkInfo],
	preferred: Option<&str>,
	target_major: Option<u32>,
) -> Option<JdkInfo> {
	if let Some(pref) = preferred.map(str::trim).filter(|s| !s.is_empty()) {
		let pref_key = canonical_key(Path::new(pref));
		if let Some(found) = jdks
			.iter()
			.find(|j| canonical_key(Path::new(&j.path)) == pref_key)
		{
			return Some(found.clone());
		}
	}
	if let Some(exact) = target_major {
		if let Some(found) = jdks
			.iter()
			.filter(|j| j.major == exact)
			.max_by_key(|j| j.is_default)
		{
			return Some(found.clone());
		}
	}
	let min_major = target_major.unwrap_or(21);
	jdks.iter()
		.filter(|j| j.major >= min_major)
		.max_by(|a, b| {
			a.major
				.cmp(&b.major)
				.then_with(|| a.is_default.cmp(&b.is_default))
		})
		.cloned()
}

pub async fn find_best_jdk(preferred: Option<&str>, target_major: Option<u32>) -> Option<JdkInfo> {
	let jdks = list_jdks().await;
	if let Some(pref) = preferred.map(str::trim).filter(|s| !s.is_empty()) {
		if let Some(found) = select_best_jdk(&jdks, Some(pref), target_major) {
			return Some(found);
		}
		if let Some(direct) = inspect_jdk_root(Path::new(pref)).await {
			return Some(direct);
		}
	}
	select_best_jdk(&jdks, None, target_major)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn parses_java_major_versions() {
		assert_eq!(parse_java_major("1.8.0_441"), Some(8));
		assert_eq!(parse_java_major("1.8.0_392-b08"), Some(8));
		assert_eq!(parse_java_major("17.0.15"), Some(17));
		assert_eq!(parse_java_major("21.0.7"), Some(21));
		assert_eq!(parse_java_major("25.0.2"), Some(25));
		assert_eq!(parse_java_major("25-ea"), Some(25));
		assert_eq!(parse_java_major("21+35"), Some(21));
		assert_eq!(parse_java_major(""), None);
		assert_eq!(parse_java_major("invalid"), None);
	}

	#[test]
	fn parses_release_file_content() {
		let release_25 = r#"
IMPLEMENTOR="Oracle Corporation"
JAVA_RUNTIME_VERSION="25.0.2+10-LTS-69"
JAVA_VERSION="25.0.2"
"#;
		assert_eq!(
			parse_release_content(release_25),
			Some(("25.0.2".to_string(), 25, "Oracle Corporation".to_string()))
		);

		let release_8 = r#"
JAVA_VERSION="1.8.0_441"
OS_NAME="Windows"
"#;
		assert_eq!(
			parse_release_content(release_8),
			Some(("1.8.0_441".to_string(), 8, "Unknown".to_string()))
		);
	}

	#[test]
	fn parses_java_version_stderr_fallback() {
		let stderr_temurin = "openjdk version \"21.0.5\" 2024-10-15\nOpenJDK Runtime Environment Temurin-21.0.5+11 (build 21.0.5+11-LTS)\n";
		assert_eq!(
			parse_java_version_output(stderr_temurin),
			Some(("21.0.5".to_string(), 21, "Eclipse Adoptium".to_string()))
		);

		let stderr_java8 =
			"java version \"1.8.0_441\"\nJava(TM) SE Runtime Environment (build 1.8.0_441-b07)\n";
		assert_eq!(
			parse_java_version_output(stderr_java8),
			Some(("1.8.0_441".to_string(), 8, "Oracle Corporation".to_string()))
		);
	}

	#[test]
	fn selects_best_jdk_by_preference_and_target_major() {
		let jdks = vec![
			JdkInfo {
				path: r"C:\Program Files\Java\jdk-25".to_string(),
				version: "25.0.2".to_string(),
				major: 25,
				vendor: "Oracle Corporation".to_string(),
				is_default: true,
			},
			JdkInfo {
				path: r"C:\Program Files\Java\jdk-21".to_string(),
				version: "21.0.7".to_string(),
				major: 21,
				vendor: "Oracle Corporation".to_string(),
				is_default: false,
			},
			JdkInfo {
				path: r"C:\Program Files\Java\jdk-17".to_string(),
				version: "17.0.15".to_string(),
				major: 17,
				vendor: "Oracle Corporation".to_string(),
				is_default: false,
			},
		];

		// Exact preferred match wins
		let pref =
			select_best_jdk(&jdks, Some(r"C:\Program Files\Java\jdk-21\"), Some(25)).unwrap();
		assert_eq!(pref.major, 21);

		// Invalid preferred falls back to exact target_major
		let exact = select_best_jdk(&jdks, Some(r"C:\NonExistent\jdk"), Some(17)).unwrap();
		assert_eq!(exact.major, 17);

		// Missing exact target_major picks highest >= target_major
		let higher = select_best_jdk(&jdks, None, Some(20)).unwrap();
		assert_eq!(higher.major, 25);

		// None target_major defaults to highest >= 21
		let default_pick = select_best_jdk(&jdks, None, None).unwrap();
		assert_eq!(default_pick.major, 25);

		// Unsatisfiable target_major returns None
		assert!(select_best_jdk(&jdks, None, Some(26)).is_none());
	}

	#[tokio::test]
	async fn inspects_fake_jdk_from_release_file_and_scans_system() {
		let dir = std::env::temp_dir().join(format!("fabric_studio_jdk_{}", uuid::Uuid::new_v4()));
		let bin = dir.join("bin");
		fs::create_dir_all(&bin).unwrap();
		fs::write(bin.join(JAVA_BIN), b"").unwrap();
		fs::write(
			dir.join("release"),
			"JAVA_VERSION=\"21.0.7\"\nIMPLEMENTOR=\"Eclipse Adoptium\"\n",
		)
		.unwrap();

		let info = inspect_jdk_root(&dir).await.unwrap();
		assert_eq!(info.major, 21);
		assert_eq!(info.version, "21.0.7");
		assert_eq!(info.vendor, "Eclipse Adoptium");
		assert!(!info.path.starts_with(r"\\?\"));

		let _ = fs::remove_dir_all(&dir);

		let system_jdks = list_jdks().await;
		for pair in system_jdks.windows(2) {
			assert!(pair[0].major >= pair[1].major);
		}
		assert!(system_jdks.iter().filter(|j| j.is_default).count() <= 1);
	}
}