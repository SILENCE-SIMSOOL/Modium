use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use flate2::write::ZlibEncoder;
use flate2::Compression;
use quick_xml::events::Event;
use quick_xml::Reader;
use regex::Regex;
use serde::Deserialize;
use serde_json::{Map, Value};

use crate::models::{
	CreateProjectConfig, FabricCompatVersions, FabricModMetadata, FabricProjectMeta,
	FabricVersionCatalog, LoaderVersionEntry, McVersionEntry, MigrationChange, MigrationPlan,
	MigrationResult, MixinEntry, MixinScanResult, MixinTargetMethod, ProjectInfo,
};
use crate::state::AppState;

const FABRIC_GAME_VERSIONS_URL: &str = "https://meta.fabricmc.net/v2/versions/game";
const FABRIC_LOADER_VERSIONS_URL: &str = "https://meta.fabricmc.net/v2/versions/loader";
const FABRIC_YARN_VERSIONS_URL: &str = "https://meta.fabricmc.net/v2/versions/yarn";
const FABRIC_LOOM_METADATA_URL: &str =
	"https://maven.fabricmc.net/net/fabricmc/fabric-loom/maven-metadata.xml";
const FABRIC_API_METADATA_URL: &str =
	"https://maven.fabricmc.net/net/fabricmc/fabric-api/fabric-api/maven-metadata.xml";

const EXAMPLE_MOD_WRAPPER_JAR_URL: &str =
	"https://raw.githubusercontent.com/FabricMC/fabric-example-mod/26.3/gradle/wrapper/gradle-wrapper.jar";
const EXAMPLE_MOD_GRADLEW_URL: &str =
	"https://raw.githubusercontent.com/FabricMC/fabric-example-mod/26.3/gradlew";
const EXAMPLE_MOD_GRADLEW_BAT_URL: &str =
	"https://raw.githubusercontent.com/FabricMC/fabric-example-mod/26.3/gradlew.bat";

const DEFAULT_GRADLE_VERSION: &str = "9.8.2";
const DEFAULT_LOADER_VERSION: &str = "0.20.1";
const DEFAULT_LOOM_VERSION: &str = "1.19.4";
const DEFAULT_API_26_3: &str = "0.166.2+26.3";
const DEFAULT_API_1_21_11: &str = "0.141.6+1.21.11";
const DEFAULT_YARN_1_21_11: &str = "1.21.11+build.6";
const CATALOG_CACHE_TTL: Duration = Duration::from_secs(600);

const JAVA_RESERVED_KEYWORDS: &[&str] = &[
	"abstract",
	"assert",
	"boolean",
	"break",
	"byte",
	"case",
	"catch",
	"char",
	"class",
	"const",
	"continue",
	"default",
	"do",
	"double",
	"else",
	"enum",
	"extends",
	"final",
	"finally",
	"float",
	"for",
	"goto",
	"if",
	"implements",
	"import",
	"instanceof",
	"int",
	"interface",
	"long",
	"native",
	"new",
	"package",
	"private",
	"protected",
	"public",
	"return",
	"short",
	"static",
	"strictfp",
	"super",
	"switch",
	"synchronized",
	"this",
	"throw",
	"throws",
	"transient",
	"try",
	"void",
	"volatile",
	"while",
	"true",
	"false",
	"null",
	"var",
	"record",
	"sealed",
	"permits",
	"yield",
];

#[derive(Debug, Deserialize)]
struct YarnApiEntry {
	version: String,
	#[serde(default)]
	stable: bool,
}

/// Returns `true` for Minecraft `26.1`+ unobfuscated releases/snapshots (`26.x`, `27.x`, `26w...`).
pub fn is_modern_unobfuscated_mc(mc: &str) -> bool {
	let trimmed = mc.trim();
	let digits: String = trimmed.chars().take_while(|c| c.is_ascii_digit()).collect();
	digits
		.parse::<u32>()
		.map(|major| major >= 26)
		.unwrap_or(false)
}

pub fn recommended_java_for_mc(mc: &str) -> u32 {
	if is_modern_unobfuscated_mc(mc) {
		return 25;
	}
	let trimmed = mc.trim();
	if let Some(week_idx) = trimmed.find('w') {
		if let Ok(year) = trimmed[..week_idx].parse::<u32>() {
			return if year >= 24 { 21 } else { 17 };
		}
	}
	let clean = trimmed.split(['-', ' ']).next().unwrap_or(trimmed);
	let mut parts = clean.split('.');
	let major = parts
		.next()
		.and_then(|p| p.parse::<u32>().ok())
		.unwrap_or(1);
	if major >= 26 {
		return 25;
	}
	let minor = parts
		.next()
		.and_then(|p| p.parse::<u32>().ok())
		.unwrap_or(21);
	let patch = parts
		.next()
		.and_then(|p| p.parse::<u32>().ok())
		.unwrap_or(0);
	if minor > 20 || (minor == 20 && patch >= 5) {
		21
	} else if minor >= 18 {
		17
	} else if minor == 17 {
		16
	} else {
		8
	}
}

pub fn fallback_fabric_catalog() -> FabricVersionCatalog {
	let mut api_by_mc = HashMap::new();
	api_by_mc.insert("26.3".to_string(), vec![DEFAULT_API_26_3.to_string()]);
	api_by_mc.insert("1.21.11".to_string(), vec![DEFAULT_API_1_21_11.to_string()]);
	FabricVersionCatalog {
		game_versions: vec![
			McVersionEntry {
				version: "26.3".to_string(),
				stable: true,
			},
			McVersionEntry {
				version: "1.21.11".to_string(),
				stable: true,
			},
		],
		loader_versions: vec![LoaderVersionEntry {
			version: DEFAULT_LOADER_VERSION.to_string(),
			stable: true,
		}],
		loom_versions: vec![DEFAULT_LOOM_VERSION.to_string()],
		api_by_mc,
	}
}

pub async fn fetch_fabric_versions(
	state: &AppState,
	force_refresh: bool,
) -> Result<FabricVersionCatalog, String> {
	if !force_refresh {
		if let Ok(guard) = state.fabric_cache.lock() {
			if let Some((fetched_at, cached)) = guard.as_ref() {
				if fetched_at.elapsed() < CATALOG_CACHE_TTL {
					return Ok(cached.clone());
				}
			}
		}
	}
	let catalog = fetch_fabric_versions_uncached().await;
	if let Ok(mut guard) = state.fabric_cache.lock() {
		*guard = Some((Instant::now(), catalog.clone()));
	}
	Ok(catalog)
}

pub async fn fetch_fabric_versions_uncached() -> FabricVersionCatalog {
	let client = match reqwest::Client::builder()
		.timeout(Duration::from_secs(10))
		.user_agent("Modium/0.1")
		.build()
	{
		Ok(c) => c,
		Err(_) => return fallback_fabric_catalog(),
	};
	let (game_res, loader_res, loom_res, api_res) = tokio::join!(
		fetch_json_list::<McVersionEntry>(&client, FABRIC_GAME_VERSIONS_URL),
		fetch_json_list::<LoaderVersionEntry>(&client, FABRIC_LOADER_VERSIONS_URL),
		fetch_text(&client, FABRIC_LOOM_METADATA_URL),
		fetch_text(&client, FABRIC_API_METADATA_URL),
	);
	let fallback = fallback_fabric_catalog();
	let game_versions = game_res
		.filter(|v| !v.is_empty())
		.unwrap_or(fallback.game_versions);
	let loader_versions = loader_res
		.filter(|v| !v.is_empty())
		.unwrap_or(fallback.loader_versions);
	let loom_versions = loom_res
		.as_deref()
		.map(parse_loom_metadata_xml)
		.filter(|v| !v.is_empty())
		.unwrap_or(fallback.loom_versions);
	let mut api_by_mc = api_res
		.as_deref()
		.map(parse_fabric_api_metadata_xml)
		.filter(|m| !m.is_empty())
		.unwrap_or_default();
	for (mc, versions) in fallback.api_by_mc {
		api_by_mc.entry(mc).or_insert(versions);
	}
	FabricVersionCatalog {
		game_versions,
		loader_versions,
		loom_versions,
		api_by_mc,
	}
}

pub async fn resolve_fabric_compat(
	mc_version: &str,
	catalog: &FabricVersionCatalog,
) -> FabricCompatVersions {
	let mut compat = resolve_fabric_compat_sync(mc_version, catalog);
	if !compat.is_modern_unobfuscated {
		compat.yarn_version = fetch_latest_yarn_version(mc_version).await;
	}
	compat
}

pub fn resolve_fabric_compat_sync(
	mc_version: &str,
	catalog: &FabricVersionCatalog,
) -> FabricCompatVersions {
	let is_modern = is_modern_unobfuscated_mc(mc_version);
	let recommended_java = recommended_java_for_mc(mc_version);
	let loader_version = catalog
		.loader_versions
		.iter()
		.find(|e| e.stable)
		.or_else(|| catalog.loader_versions.first())
		.map(|e| e.version.clone())
		.unwrap_or_else(|| DEFAULT_LOADER_VERSION.to_string());
	let loom_version = catalog
		.loom_versions
		.iter()
		.find(|v| {
			let lower = v.to_ascii_lowercase();
			!lower.contains("alpha") && !lower.contains("snapshot") && !lower.contains("rc")
		})
		.or_else(|| catalog.loom_versions.first())
		.cloned()
		.unwrap_or_else(|| DEFAULT_LOOM_VERSION.to_string());
	let fabric_api_version = pick_api_for_mc(mc_version, &catalog.api_by_mc);
	let yarn_version =
		(!is_modern && mc_version == "1.21.11").then(|| DEFAULT_YARN_1_21_11.to_string());
	FabricCompatVersions {
		mc_version: mc_version.to_string(),
		loader_version,
		loom_version,
		fabric_api_version,
		recommended_java,
		gradle_version: DEFAULT_GRADLE_VERSION.to_string(),
		is_modern_unobfuscated: is_modern,
		yarn_version,
	}
}

fn pick_api_for_mc(mc_version: &str, api_by_mc: &HashMap<String, Vec<String>>) -> String {
	if let Some(list) = api_by_mc.get(mc_version) {
		if let Some(first) = list.first() {
			return first.clone();
		}
	}
	// Try matching base version if snapshot/rc suffix is present (e.g. `26.3-rc1` -> `26.3`).
	let base = mc_version.split('-').next().unwrap_or(mc_version);
	if let Some(list) = api_by_mc.get(base) {
		if let Some(first) = list.first() {
			return first.clone();
		}
	}
	if is_modern_unobfuscated_mc(mc_version) {
		DEFAULT_API_26_3.to_string()
	} else {
		DEFAULT_API_1_21_11.to_string()
	}
}

async fn fetch_json_list<T: for<'de> Deserialize<'de>>(
	client: &reqwest::Client,
	url: &str,
) -> Option<Vec<T>> {
	let resp = client.get(url).send().await.ok()?;
	if !resp.status().is_success() {
		return None;
	}
	resp.json::<Vec<T>>().await.ok()
}

async fn fetch_text(client: &reqwest::Client, url: &str) -> Option<String> {
	let resp = client.get(url).send().await.ok()?;
	if !resp.status().is_success() {
		return None;
	}
	resp.text().await.ok()
}

async fn fetch_latest_yarn_version(mc_version: &str) -> Option<String> {
	let client = reqwest::Client::builder()
		.timeout(Duration::from_secs(5))
		.user_agent("Modium/0.1")
		.build()
		.ok()?;
	let url = format!("{}/{}", FABRIC_YARN_VERSIONS_URL, mc_version);
	if let Some(entries) = fetch_json_list::<YarnApiEntry>(&client, &url).await {
		if let Some(entry) = entries
			.iter()
			.find(|e| e.stable)
			.or_else(|| entries.first())
		{
			return Some(entry.version.clone());
		}
	}
	(mc_version == "1.21.11").then(|| DEFAULT_YARN_1_21_11.to_string())
}

/// Parses Fabric Loom versions from Maven `maven-metadata.xml` (newest first).
pub fn parse_loom_metadata_xml(xml: &str) -> Vec<String> {
	let mut versions = parse_maven_versions(xml);
	versions.reverse();
	versions
}

/// Parses Fabric API versions from Maven `maven-metadata.xml`, grouped by `+mc` suffix (newest first).
pub fn parse_fabric_api_metadata_xml(xml: &str) -> HashMap<String, Vec<String>> {
	let versions = parse_maven_versions(xml);
	let mut grouped: HashMap<String, Vec<String>> = HashMap::new();
	for version in versions.into_iter().rev() {
		if let Some((_, mc_suffix)) = version.split_once('+') {
			grouped
				.entry(mc_suffix.to_string())
				.or_default()
				.push(version);
		}
	}
	grouped
}

fn parse_maven_versions(xml: &str) -> Vec<String> {
	let mut reader = Reader::from_str(xml);
	reader.config_mut().trim_text(true);
	let mut buf = Vec::new();
	let mut in_version = false;
	let mut versions = Vec::new();
	loop {
		match reader.read_event_into(&mut buf) {
			Ok(Event::Start(e)) if e.name().as_ref() == b"version" => {
				in_version = true;
			}
			Ok(Event::End(e)) if e.name().as_ref() == b"version" => {
				in_version = false;
			}
			Ok(Event::Text(e)) if in_version => {
				if let Ok(text) = e.unescape() {
					let trimmed = text.trim();
					if !trimmed.is_empty() {
						versions.push(trimmed.to_string());
					}
				}
			}
			Ok(Event::Eof) | Err(_) => break,
			_ => {}
		}
		buf.clear();
	}
	versions
}

pub async fn create_fabric_project(config: &CreateProjectConfig) -> Result<ProjectInfo, String> {
	validate_create_config(config)?;
	let is_modern = is_modern_unobfuscated_mc(&config.mc_version);
	let yarn_version = if !is_modern && config.use_yarn_mappings {
		fetch_latest_yarn_version(&config.mc_version).await
	} else {
		None
	};
	let root = PathBuf::from(config.project_dir.trim());
	fs::create_dir_all(&root).map_err(|e| e.to_string())?;
	let stage = tempfile::Builder::new()
		.prefix(".modium-create-")
		.tempdir_in(&root)
		.map_err(|e| format!("Cannot stage project: {e}"))?;
	let mut staged = config.clone();
	staged.project_dir = stage.path().to_string_lossy().into_owned();
	let meta = generate_fabric_project_files(&staged, yarn_version.as_deref())?;
	ensure_gradle_wrapper(stage.path(), DEFAULT_GRADLE_VERSION)
		.await
		.map_err(|e| format!("Gradle Wrapper: {e}"))?;
	publish_project(stage.path(), &root)?;
	Ok(ProjectInfo {
		name: config.mod_name.trim().to_string(),
		path: root.to_string_lossy().to_string(),
		is_fabric: true,
		fabric_meta: Some(meta),
	})
}

fn publish_project(stage: &Path, root: &Path) -> Result<(), String> {
	fn collect(
		dir: &Path,
		dest: &Path,
		entries: &mut Vec<(PathBuf, PathBuf, bool)>,
	) -> std::io::Result<()> {
		for entry in fs::read_dir(dir)? {
			let entry = entry?;
			let target = dest.join(entry.file_name());
			let directory = entry.file_type()?.is_dir();
			match fs::symlink_metadata(&target) {
				Ok(meta) if directory && meta.file_type().is_dir() => (),
				Ok(_) => {
					return Err(std::io::Error::new(
						std::io::ErrorKind::AlreadyExists,
						target.display().to_string(),
					))
				}
				Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
					entries.push((entry.path(), target.clone(), directory))
				}
				Err(e) => return Err(e),
			}
			if directory {
				collect(&entry.path(), &target, entries)?;
			}
		}
		Ok(())
	}
	let mut entries = Vec::new();
	collect(stage, root, &mut entries).map_err(|e| format!("Project file conflict: {e}"))?;
	for (index, (source, target, directory)) in entries.iter().enumerate() {
		let result = if *directory {
			fs::create_dir(target)
		} else {
			(|| {
				let mut input = fs::File::open(source)?;
				let mut output = fs::File::create_new(target)?;
				let copied = std::io::copy(&mut input, &mut output)
					.and_then(|_| output.set_permissions(input.metadata()?.permissions()));
				drop(output);
				if copied.is_err() {
					fs::remove_file(target)?;
				}
				copied
			})()
		};
		if let Err(e) = result {
			let mut errors = vec![format!("Cannot create {}: {e}", target.display())];
			for (_, created, dir) in entries[..index].iter().rev() {
				let undo = if *dir {
					fs::remove_dir(created)
				} else {
					fs::remove_file(created)
				};
				if let Err(err) = undo {
					errors.push(format!("{}: {err}", created.display()));
				}
			}
			return Err(errors.join("\n"));
		}
	}
	Ok(())
}

pub fn validate_create_config(config: &CreateProjectConfig) -> Result<(), String> {
	static MOD_ID_RE: OnceLock<Regex> = OnceLock::new();
	let mod_id_re =
		MOD_ID_RE.get_or_init(|| Regex::new(r"^[a-z][a-z0-9_]{1,63}$").expect("valid regex"));
	if !mod_id_re.is_match(&config.mod_id) {
		return Err(
			"Invalid modId: must be 2..64 chars, start with a-z, and contain only lowercase letters, digits, or '_'"
				.to_string(),
		);
	}
	if !is_valid_java_package(&config.package_name) {
		return Err(format!(
			"Invalid Java package name: '{}'",
			config.package_name
		));
	}
	if config.mod_name.trim().is_empty() {
		return Err("Mod name cannot be empty".to_string());
	}
	let dir = config.project_dir.trim();
	if dir.is_empty() {
		return Err("Project directory cannot be empty".to_string());
	}
	let root = Path::new(dir);
	if root.exists()
		&& (root.join("build.gradle.kts").exists()
			|| root.join("build.gradle").exists()
			|| root.join("src").exists())
	{
		return Err(format!(
			"Target directory already contains an existing project: {}",
			root.display()
		));
	}
	Ok(())
}

fn is_valid_java_package(pkg: &str) -> bool {
	if pkg.is_empty() {
		return false;
	}
	static SEG_RE: OnceLock<Regex> = OnceLock::new();
	let seg_re =
		SEG_RE.get_or_init(|| Regex::new(r"^[a-zA-Z_][a-zA-Z0-9_]*$").expect("valid seg regex"));
	pkg.split('.')
		.all(|seg| seg_re.is_match(seg) && !JAVA_RESERVED_KEYWORDS.contains(&seg))
}

/// Generates all Fabric project files, templates, and the minimal 16x16 PNG icon on disk.
pub fn generate_fabric_project_files(
	config: &CreateProjectConfig,
	yarn_version: Option<&str>,
) -> Result<FabricProjectMeta, String> {
	validate_create_config(config)?;
	let root = PathBuf::from(config.project_dir.trim());
	fs::create_dir_all(&root)
		.map_err(|err| format!("Failed to create project directory: {}", err))?;

	let is_modern = is_modern_unobfuscated_mc(&config.mc_version);
	let java_ver = recommended_java_for_mc(&config.mc_version);
	let main_class = derive_main_class_name(&config.mod_id);
	let client_class = format!("{}Client", main_class);
	let pkg_rel = config.package_name.replace('.', "/");
	let use_yarn = !is_modern && config.use_yarn_mappings && yarn_version.is_some();

	let settings_kts = render_settings_gradle_kts(&config.mod_id, is_modern);
	let build_kts = render_build_gradle_kts(config, is_modern, java_ver, use_yarn);
	let props = render_gradle_properties(config, yarn_version);
	let mod_json = render_fabric_mod_json(config, &main_class, &client_class, java_ver);

	write_project_file(&root.join("settings.gradle.kts"), &settings_kts)?;
	write_project_file(&root.join("build.gradle.kts"), &build_kts)?;
	write_project_file(&root.join("gradle.properties"), &props)?;
	let license = include_str!("../../LICENSE").replace("2026 Modium contributors", &format!("{} {} contributors", chrono::Utc::now().format("%Y"), config.mod_name));
	write_project_file(&root.join("LICENSE"), &license)?;
	write_project_file(&root.join(".gitignore"), render_gitignore())?;
	write_project_file(&root.join("src/main/resources/fabric.mod.json"), &mod_json)?;

	let main_java_path = root.join(format!("src/main/java/{}/{}.java", pkg_rel, main_class));
	write_project_file(
		&main_java_path,
		&render_main_java(config, &main_class, is_modern),
	)?;

	let icon_path = root.join(format!(
		"src/main/resources/assets/{}/icon.png",
		config.mod_id
	));
	if let Some(parent) = icon_path.parent() {
		fs::create_dir_all(parent).map_err(|e| e.to_string())?;
	}
	fs::write(&icon_path, build_minimal_icon_png())
		.map_err(|err| format!("Failed to write mod icon: {}", err))?;

	if config.enable_mixin {
		let mixins_json_path =
			root.join(format!("src/main/resources/{}.mixins.json", config.mod_id));
		write_project_file(
			&mixins_json_path,
			&render_main_mixins_json(&config.package_name, java_ver),
		)?;
		let mixin_java_path =
			root.join(format!("src/main/java/{}/mixin/ExampleMixin.java", pkg_rel));
		write_project_file(
			&mixin_java_path,
			&render_example_mixin_java(&config.package_name),
		)?;
	}

	if config.generate_client_entrypoint {
		let client_java_path = root.join(format!(
			"src/client/java/{}/client/{}.java",
			pkg_rel, client_class
		));
		write_project_file(
			&client_java_path,
			&render_client_java(&config.package_name, &client_class),
		)?;
		if config.enable_mixin {
			let client_mixins_json_path = root.join(format!(
				"src/client/resources/{}.client.mixins.json",
				config.mod_id
			));
			write_project_file(
				&client_mixins_json_path,
				&render_client_mixins_json(&config.package_name, java_ver),
			)?;
			let client_mixin_java_path = root.join(format!(
				"src/client/java/{}/client/mixin/ExampleClientMixin.java",
				pkg_rel
			));
			write_project_file(
				&client_mixin_java_path,
				&render_example_client_mixin_java(&config.package_name),
			)?;
		}
	}

	Ok(FabricProjectMeta {
		mod_id: config.mod_id.clone(),
		mod_name: config.mod_name.trim().to_string(),
		version: "1.0.0".to_string(),
		mc_version: config.mc_version.clone(),
		loader_version: config.loader_version.clone(),
		loom_version: config.loom_version.clone(),
		fabric_api_version: config.fabric_api_version.clone(),
		java_version: java_ver,
		is_modern_unobfuscated: is_modern,
		has_client_source_set: config.generate_client_entrypoint,
		has_mixins: config.enable_mixin,
	})
}

fn write_project_file(path: &Path, content: &str) -> Result<(), String> {
	if let Some(parent) = path.parent() {
		fs::create_dir_all(parent)
			.map_err(|err| format!("Failed to create directory '{}': {}", parent.display(), err))?;
	}
	fs::write(path, content).map_err(|err| format!("Failed to write '{}': {}", path.display(), err))
}

fn derive_main_class_name(mod_id: &str) -> String {
	let mut pascal = String::new();
	for part in mod_id.split('_').filter(|p| !p.is_empty()) {
		let mut chars = part.chars();
		if let Some(first) = chars.next() {
			pascal.push(first.to_ascii_uppercase());
			pascal.extend(chars);
		}
	}
	if pascal.is_empty() {
		return "ExampleMod".to_string();
	}
	if pascal.ends_with("Mod") {
		pascal
	} else {
		format!("{}Mod", pascal)
	}
}

fn render_settings_gradle_kts(mod_id: &str, is_modern: bool) -> String {
	let plugin_id = if is_modern {
		"net.fabricmc.fabric-loom"
	} else {
		"net.fabricmc.fabric-loom-remap"
	};
	format!(
		"pluginManagement {{\n\trepositories {{\n\t\tmaven {{\n\t\t\tname = \"Fabric\"\n\t\t\turl = uri(\"https://maven.fabricmc.net/\")\n\t\t}}\n\t\tmavenCentral()\n\t\tgradlePluginPortal()\n\t}}\n\tval loom_version: String by settings\n\tplugins {{\n\t\tid(\"{plugin_id}\") version loom_version\n\t}}\n}}\n\nrootProject.name = \"{mod_id}\""
	)
}

fn render_build_gradle_kts(
	config: &CreateProjectConfig,
	is_modern: bool,
	java_ver: u32,
	use_yarn: bool,
) -> String {
	let plugin_id = if is_modern {
		"net.fabricmc.fabric-loom"
	} else {
		"net.fabricmc.fabric-loom-remap"
	};
	let loom_block = if config.generate_client_entrypoint {
		format!(
			"loom {{\n\tsplitEnvironmentSourceSets()\n\n\tmods {{\n\t\tcreate(\"{}\") {{\n\t\t\tsourceSet(sourceSets[\"main\"])\n\t\t\tsourceSet(sourceSets[\"client\"])\n\t\t}}\n\t}}\n}}",
			config.mod_id
		)
	} else {
		format!(
			"loom {{\n\tmods {{\n\t\tcreate(\"{}\") {{\n\t\t\tsourceSet(sourceSets[\"main\"])\n\t\t}}\n\t}}\n}}",
			config.mod_id
		)
	};
	let deps_block = if is_modern {
		"dependencies {\n\tminecraft(\"com.mojang:minecraft:${project.property(\"minecraft_version\")}\")\n\timplementation(\"net.fabricmc:fabric-loader:${project.property(\"loader_version\")}\")\n\timplementation(\"net.fabricmc.fabric-api:fabric-api:${project.property(\"fabric_api_version\")}\")\n}"
	} else if use_yarn {
		"dependencies {\n\tminecraft(\"com.mojang:minecraft:${project.property(\"minecraft_version\")}\")\n\tmappings(\"net.fabricmc:yarn:${project.property(\"yarn_mappings\")}:v2\")\n\tmodImplementation(\"net.fabricmc:fabric-loader:${project.property(\"loader_version\")}\")\n\tmodImplementation(\"net.fabricmc.fabric-api:fabric-api:${project.property(\"fabric_api_version\")}\")\n}"
	} else {
		"dependencies {\n\tminecraft(\"com.mojang:minecraft:${project.property(\"minecraft_version\")}\")\n\tmappings(loom.officialMojangMappings())\n\tmodImplementation(\"net.fabricmc:fabric-loader:${project.property(\"loader_version\")}\")\n\tmodImplementation(\"net.fabricmc.fabric-api:fabric-api:${project.property(\"fabric_api_version\")}\")\n}"
	};
	let java_enum = format!("JavaVersion.VERSION_{}", java_ver);
	format!(
		"plugins {{\n\tid(\"{plugin_id}\")\n\tid(\"maven-publish\")\n}}\n\nversion = project.property(\"version\") as String\ngroup = project.property(\"group\") as String\n\nbase {{\n\tarchivesName.set(project.property(\"archives_base_name\") as String)\n}}\n\nrepositories {{\n}}\n\n{loom_block}\n\n{deps_block}\n\ntasks.processResources {{\n\tval modVersion = project.version.toString()\n\tinputs.property(\"version\", modVersion)\n\n\tfilesMatching(\"fabric.mod.json\") {{\n\t\texpand(\"version\" to modVersion)\n\t}}\n}}\n\ntasks.withType<JavaCompile>().configureEach {{\n\toptions.release.set({java_ver})\n}}\n\njava {{\n\twithSourcesJar()\n\n\tsourceCompatibility = {java_enum}\n\ttargetCompatibility = {java_enum}\n}}\n\ntasks.jar {{\n\tval archiveName = base.archivesName.get()\n\tinputs.property(\"archivesName\", archiveName)\n\n\tfrom(\"LICENSE\") {{\n\t\trename {{ \"${{it}}_$archiveName\" }}\n\t}}\n}}\n\npublishing {{\n\tpublications {{\n\t\tcreate<MavenPublication>(\"mavenJava\") {{\n\t\t\tfrom(components[\"java\"])\n\t\t}}\n\t}}\n}}"
	)
}

fn render_gradle_properties(config: &CreateProjectConfig, yarn_version: Option<&str>) -> String {
	let mut lines = vec![
		"org.gradle.jvmargs=-Xmx1G".to_string(),
		"org.gradle.parallel=true".to_string(),
		"org.gradle.configuration-cache=true".to_string(),
		String::new(),
		format!("minecraft_version={}", config.mc_version),
		format!("loader_version={}", config.loader_version),
		format!("loom_version={}", config.loom_version),
	];
	if let Some(yarn) = yarn_version {
		lines.push(format!("yarn_mappings={}", yarn));
	}
	lines.extend([
		String::new(),
		"version=1.0.0".to_string(),
		format!("group={}", config.package_name),
		format!("archives_base_name={}", config.mod_id),
		String::new(),
		format!("fabric_api_version={}", config.fabric_api_version),
	]);
	lines.join("\n")
}

fn render_gitignore() -> &'static str {
	".gradle/\nbuild/\nrun/\nout/\n.idea/\n*.iml\n.classpath\n.project\n.settings/"
}

fn render_fabric_mod_json(
	config: &CreateProjectConfig,
	main_class: &str,
	client_class: &str,
	java_ver: u32,
) -> String {
	let mut entrypoints = Map::new();
	entrypoints.insert(
		"main".to_string(),
		Value::Array(vec![Value::String(format!(
			"{}.{}",
			config.package_name, main_class
		))]),
	);
	if config.generate_client_entrypoint {
		entrypoints.insert(
			"client".to_string(),
			Value::Array(vec![Value::String(format!(
				"{}.client.{}",
				config.package_name, client_class
			))]),
		);
	}
	let mut mixins = Vec::new();
	if config.enable_mixin {
		mixins.push(Value::String(format!("{}.mixins.json", config.mod_id)));
		if config.generate_client_entrypoint {
			let mut client_entry = Map::new();
			client_entry.insert(
				"config".to_string(),
				Value::String(format!("{}.client.mixins.json", config.mod_id)),
			);
			client_entry.insert(
				"environment".to_string(),
				Value::String("client".to_string()),
			);
			mixins.push(Value::Object(client_entry));
		}
	}
	let mut depends = Map::new();
	depends.insert(
		"fabricloader".to_string(),
		Value::String(format!(">={}", config.loader_version)),
	);
	depends.insert(
		"minecraft".to_string(),
		Value::String(format!("~{}", config.mc_version)),
	);
	depends.insert("java".to_string(), Value::String(format!(">={}", java_ver)));
	depends.insert("fabric-api".to_string(), Value::String("*".to_string()));

	let mut root = Map::new();
	root.insert("schemaVersion".to_string(), Value::Number(1.into()));
	root.insert("id".to_string(), Value::String(config.mod_id.clone()));
	root.insert(
		"version".to_string(),
		Value::String("${version}".to_string()),
	);
	root.insert(
		"name".to_string(),
		Value::String(config.mod_name.trim().to_string()),
	);
	root.insert(
		"description".to_string(),
		Value::String("A Fabric mod created with Modium.".to_string()),
	);
	root.insert(
		"authors".to_string(),
		Value::Array(vec![Value::String("Developer".to_string())]),
	);
	root.insert("license".to_string(), Value::String("MIT".to_string()));
	root.insert(
		"icon".to_string(),
		Value::String(format!("assets/{}/icon.png", config.mod_id)),
	);
	root.insert("environment".to_string(), Value::String("*".to_string()));
	root.insert("entrypoints".to_string(), Value::Object(entrypoints));
	root.insert("mixins".to_string(), Value::Array(mixins));
	root.insert("depends".to_string(), Value::Object(depends));
	to_tab_pretty_json(&Value::Object(root)).unwrap_or_default()
}

fn render_main_java(config: &CreateProjectConfig, main_class: &str, is_modern: bool) -> String {
	if is_modern {
		format!(
			"package {pkg};\n\nimport net.fabricmc.api.ModInitializer;\nimport net.minecraft.resources.Identifier;\nimport org.slf4j.Logger;\nimport org.slf4j.LoggerFactory;\n\npublic class {cls} implements ModInitializer {{\n\tpublic static final String MOD_ID = \"{id}\";\n\tpublic static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);\n\n\t@Override\n\tpublic void onInitialize() {{\n\t\tLOGGER.info(\"Initialized {{}}\", MOD_ID);\n\t}}\n\n\tpublic static Identifier id(String path) {{\n\t\treturn Identifier.fromNamespaceAndPath(MOD_ID, path);\n\t}}\n}}",
			pkg = config.package_name,
			cls = main_class,
			id = config.mod_id
		)
	} else {
		format!(
			"package {pkg};\n\nimport net.fabricmc.api.ModInitializer;\nimport net.minecraft.resources.ResourceLocation;\nimport org.slf4j.Logger;\nimport org.slf4j.LoggerFactory;\n\npublic class {cls} implements ModInitializer {{\n\tpublic static final String MOD_ID = \"{id}\";\n\tpublic static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);\n\n\t@Override\n\tpublic void onInitialize() {{\n\t\tLOGGER.info(\"Initialized {{}}\", MOD_ID);\n\t}}\n\n\tpublic static ResourceLocation id(String path) {{\n\t\treturn ResourceLocation.fromNamespaceAndPath(MOD_ID, path);\n\t}}\n}}",
			pkg = config.package_name,
			cls = main_class,
			id = config.mod_id
		)
	}
}

fn render_client_java(package_name: &str, client_class: &str) -> String {
	format!(
		"package {package_name}.client;\n\nimport net.fabricmc.api.ClientModInitializer;\n\npublic class {client_class} implements ClientModInitializer {{\n\t@Override\n\tpublic void onInitializeClient() {{\n\t}}\n}}"
	)
}

fn render_main_mixins_json(package_name: &str, java_ver: u32) -> String {
	format!(
		"{{\n\t\"required\": true,\n\t\"package\": \"{package_name}.mixin\",\n\t\"compatibilityLevel\": \"JAVA_{java_ver}\",\n\t\"mixins\": [\n\t\t\"ExampleMixin\"\n\t],\n\t\"injectors\": {{\n\t\t\"defaultRequire\": 1\n\t}}\n}}"
	)
}

fn render_client_mixins_json(package_name: &str, java_ver: u32) -> String {
	format!(
		"{{\n\t\"required\": true,\n\t\"package\": \"{package_name}.client.mixin\",\n\t\"compatibilityLevel\": \"JAVA_{java_ver}\",\n\t\"client\": [\n\t\t\"ExampleClientMixin\"\n\t],\n\t\"injectors\": {{\n\t\t\"defaultRequire\": 1\n\t}}\n}}"
	)
}

fn render_example_mixin_java(package_name: &str) -> String {
	format!(
		"package {package_name}.mixin;\n\nimport net.minecraft.server.MinecraftServer;\nimport org.spongepowered.asm.mixin.Mixin;\nimport org.spongepowered.asm.mixin.injection.At;\nimport org.spongepowered.asm.mixin.injection.Inject;\nimport org.spongepowered.asm.mixin.injection.callback.CallbackInfo;\n\n@Mixin(MinecraftServer.class)\npublic class ExampleMixin {{\n\t@Inject(at = @At(\"HEAD\"), method = \"loadLevel\")\n\tprivate void init(CallbackInfo info) {{\n\t}}\n}}"
	)
}

fn render_example_client_mixin_java(package_name: &str) -> String {
	format!(
		"package {package_name}.client.mixin;\n\nimport net.minecraft.client.Minecraft;\nimport org.spongepowered.asm.mixin.Mixin;\nimport org.spongepowered.asm.mixin.injection.At;\nimport org.spongepowered.asm.mixin.injection.Inject;\nimport org.spongepowered.asm.mixin.injection.callback.CallbackInfo;\n\n@Mixin(Minecraft.class)\npublic class ExampleClientMixin {{\n\t@Inject(at = @At(\"HEAD\"), method = \"run\")\n\tprivate void init(CallbackInfo info) {{\n\t}}\n}}"
	)
}

/// Builds a valid 16x16 RGBA PNG mod icon without external image crates.
pub fn build_minimal_icon_png() -> Vec<u8> {
	let width = 16u32;
	let height = 16u32;
	let mut raw = Vec::with_capacity((16 * 4 + 1) * 16);
	for y in 0..height {
		raw.push(0);
		for x in 0..width {
			let in_frame = (3..=12).contains(&x) && (3..=12).contains(&y);
			let in_core = (5..=10).contains(&x) && (5..=10).contains(&y);
			let rgba: [u8; 4] = if in_core {
				[0x6B, 0xA6, 0xFF, 0xFF]
			} else if in_frame {
				[0x31, 0x82, 0xF6, 0xFF]
			} else {
				[0x0D, 0x0F, 0x14, 0xFF]
			};
			raw.extend_from_slice(&rgba);
		}
	}
	let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
	let _ = encoder.write_all(&raw);
	let idat = encoder.finish().unwrap_or_default();
	let mut png = Vec::new();
	png.extend_from_slice(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
	let mut ihdr = Vec::with_capacity(13);
	ihdr.extend_from_slice(&width.to_be_bytes());
	ihdr.extend_from_slice(&height.to_be_bytes());
	ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
	append_png_chunk(&mut png, b"IHDR", &ihdr);
	append_png_chunk(&mut png, b"IDAT", &idat);
	append_png_chunk(&mut png, b"IEND", &[]);
	png
}

fn append_png_chunk(out: &mut Vec<u8>, chunk_type: &[u8; 4], data: &[u8]) {
	out.extend_from_slice(&(data.len() as u32).to_be_bytes());
	out.extend_from_slice(chunk_type);
	out.extend_from_slice(data);
	let mut crc_input = Vec::with_capacity(4 + data.len());
	crc_input.extend_from_slice(chunk_type);
	crc_input.extend_from_slice(data);
	out.extend_from_slice(&crc32_ieee(&crc_input).to_be_bytes());
}

fn crc32_ieee(bytes: &[u8]) -> u32 {
	let mut crc = 0xFFFF_FFFFu32;
	for &b in bytes {
		crc ^= b as u32;
		for _ in 0..8 {
			let mask = (crc & 1).wrapping_neg();
			crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
		}
	}
	!crc
}

pub fn gradle_wrapper_cache_dir(gradle_version: &str) -> PathBuf {
	dirs::data_local_dir()
		.unwrap_or_else(std::env::temp_dir)
		.join("FabricStudio")
		.join("cache")
		.join("gradle-wrapper")
		.join(gradle_version)
}

pub async fn ensure_gradle_wrapper(root: &Path, gradle_version: &str) -> Result<(), String> {
	let cache_dir = gradle_wrapper_cache_dir(gradle_version);
	let cached_jar = cache_dir.join("gradle-wrapper.jar");
	let cached_gradlew = cache_dir.join("gradlew");
	let cached_gradlew_bat = cache_dir.join("gradlew.bat");

	if !is_valid_zip_file(&cached_jar) || !cached_gradlew.is_file() || !cached_gradlew_bat.is_file()
	{
		populate_wrapper_cache(&cache_dir, gradle_version).await?;
	}
	copy_wrapper_from_cache(&cache_dir, root, gradle_version)
}

pub fn copy_wrapper_from_cache(
	cache_dir: &Path,
	root: &Path,
	gradle_version: &str,
) -> Result<(), String> {
	let wrapper_dir = root.join("gradle/wrapper");
	fs::create_dir_all(&wrapper_dir)
		.map_err(|err| format!("Failed to create gradle/wrapper dir: {}", err))?;
	let props = format!(
		"distributionBase=GRADLE_USER_HOME\ndistributionPath=wrapper/dists\ndistributionUrl=https\\://services.gradle.org/distributions/gradle-{}-bin.zip\nnetworkTimeout=10000\nretries=0\nretryBackOffMs=500\nvalidateDistributionUrl=true\nzipStoreBase=GRADLE_USER_HOME\nzipStorePath=wrapper/dists",
		gradle_version
	);
	fs::write(wrapper_dir.join("gradle-wrapper.properties"), props)
		.map_err(|err| format!("Failed to write gradle-wrapper.properties: {}", err))?;
	fs::copy(
		cache_dir.join("gradle-wrapper.jar"),
		wrapper_dir.join("gradle-wrapper.jar"),
	)
	.map_err(|err| format!("Failed to copy gradle-wrapper.jar: {}", err))?;
	fs::copy(cache_dir.join("gradlew"), root.join("gradlew"))
		.map_err(|err| format!("Failed to copy gradlew: {}", err))?;
	fs::copy(cache_dir.join("gradlew.bat"), root.join("gradlew.bat"))
		.map_err(|err| format!("Failed to copy gradlew.bat: {}", err))?;
	#[cfg(unix)]
	{
		use std::os::unix::fs::PermissionsExt;
		if let Ok(meta) = fs::metadata(root.join("gradlew")) {
			let mut perms = meta.permissions();
			perms.set_mode(perms.mode() | 0o755);
			let _ = fs::set_permissions(root.join("gradlew"), perms);
		}
	}
	Ok(())
}

async fn populate_wrapper_cache(cache_dir: &Path, gradle_version: &str) -> Result<(), String> {
	fs::create_dir_all(cache_dir)
		.map_err(|err| format!("Failed to create wrapper cache dir: {}", err))?;
	let client = reqwest::Client::builder()
		.timeout(Duration::from_secs(30))
		.user_agent("Modium/0.1")
		.build()
		.map_err(|err| format!("HTTP client error: {}", err))?;

	let jar_ok = download_to_file(
		&client,
		EXAMPLE_MOD_WRAPPER_JAR_URL,
		&cache_dir.join("gradle-wrapper.jar"),
	)
	.await
	.is_ok()
		&& is_valid_zip_file(&cache_dir.join("gradle-wrapper.jar"));
	if !jar_ok {
		extract_wrapper_jar_from_dist(&client, cache_dir, gradle_version).await?;
	}
	if !cache_dir.join("gradlew").is_file() {
		let _ =
			download_to_file(&client, EXAMPLE_MOD_GRADLEW_URL, &cache_dir.join("gradlew")).await;
	}
	if !cache_dir.join("gradlew.bat").is_file() {
		let _ = download_to_file(
			&client,
			EXAMPLE_MOD_GRADLEW_BAT_URL,
			&cache_dir.join("gradlew.bat"),
		)
		.await;
	}
	if !is_valid_zip_file(&cache_dir.join("gradle-wrapper.jar"))
		|| !cache_dir.join("gradlew").is_file()
		|| !cache_dir.join("gradlew.bat").is_file()
	{
		return Err("Failed to download Gradle wrapper assets".to_string());
	}
	Ok(())
}

async fn download_to_file(client: &reqwest::Client, url: &str, dest: &Path) -> Result<(), String> {
	let resp = client
		.get(url)
		.send()
		.await
		.map_err(|err| format!("Request failed for {}: {}", url, err))?;
	if !resp.status().is_success() {
		return Err(format!("HTTP {} for {}", resp.status(), url));
	}
	let bytes = resp
		.bytes()
		.await
		.map_err(|err| format!("Failed reading body for {}: {}", url, err))?;
	fs::write(dest, &bytes).map_err(|err| format!("Failed writing {}: {}", dest.display(), err))
}

async fn extract_wrapper_jar_from_dist(
	client: &reqwest::Client,
	cache_dir: &Path,
	gradle_version: &str,
) -> Result<(), String> {
	let url = format!(
		"https://services.gradle.org/distributions/gradle-{}-bin.zip",
		gradle_version
	);
	let resp = client
		.get(&url)
		.send()
		.await
		.map_err(|err| format!("Failed downloading {}: {}", url, err))?;
	if !resp.status().is_success() {
		return Err(format!("HTTP {} downloading {}", resp.status(), url));
	}
	let bytes = resp
		.bytes()
		.await
		.map_err(|err| format!("Failed reading {}: {}", url, err))?
		.to_vec();
	let dest = cache_dir.join("gradle-wrapper.jar");
	tokio::task::spawn_blocking(move || {
		let reader = Cursor::new(bytes);
		let mut archive = zip::ZipArchive::new(reader)
			.map_err(|err| format!("Invalid Gradle distribution zip: {}", err))?;
		for idx in 0..archive.len() {
			let mut file = archive.by_index(idx).map_err(|e| e.to_string())?;
			let name = file.name().to_string();
			if name.contains("gradle-wrapper") && name.ends_with(".jar") {
				let mut jar_bytes = Vec::new();
				file.read_to_end(&mut jar_bytes)
					.map_err(|e| e.to_string())?;
				fs::write(&dest, jar_bytes).map_err(|e| e.to_string())?;
				return Ok(());
			}
		}
		Err("gradle-wrapper jar not found inside Gradle distribution zip".to_string())
	})
	.await
	.map_err(|e| e.to_string())?
}

fn is_valid_zip_file(path: &Path) -> bool {
	let Ok(mut file) = fs::File::open(path) else {
		return false;
	};
	let Ok(meta) = file.metadata() else {
		return false;
	};
	if meta.len() < 1024 {
		return false;
	}
	let mut header = [0u8; 4];
	file.read_exact(&mut header).is_ok() && header[0..2] == [0x50, 0x4B]
}

pub fn inspect_fabric_project(root: &Path) -> Result<Option<FabricProjectMeta>, String> {
	let mod_json_path = find_fabric_mod_json(root);
	let build_path = find_build_gradle(root);
	if mod_json_path.is_none() && build_path.is_none() {
		return Ok(None);
	}
	let props = read_gradle_properties(root);
	let build_text = build_path
		.as_ref()
		.and_then(|p| fs::read_to_string(p).ok())
		.unwrap_or_default();
	let settings_text = find_settings_gradle(root)
		.and_then(|p| fs::read_to_string(p).ok())
		.unwrap_or_default();

	let mod_meta = mod_json_path
		.as_ref()
		.and_then(|_| read_fabric_mod_json(root).ok());

	let mc_version = props
		.get("minecraft_version")
		.cloned()
		.or_else(|| {
			mod_meta
				.as_ref()
				.and_then(|m| extract_mc_from_depends(&m.depends))
		})
		.unwrap_or_default();
	let loader_version = props.get("loader_version").cloned().unwrap_or_default();
	let loom_version = props
		.get("loom_version")
		.cloned()
		.or_else(|| extract_loom_version_from_gradle(&build_text))
		.unwrap_or_default();
	let fabric_api_version = props
		.get("fabric_api_version")
		.or_else(|| props.get("fabric_version"))
		.cloned()
		.unwrap_or_default();
	let mod_id = mod_meta
		.as_ref()
		.map(|m| m.id.clone())
		.filter(|s| !s.is_empty())
		.or_else(|| props.get("archives_base_name").cloned())
		.unwrap_or_else(|| {
			root.file_name()
				.map(|n| n.to_string_lossy().to_string())
				.unwrap_or_else(|| "modid".to_string())
		});
	let mod_name = mod_meta
		.as_ref()
		.map(|m| m.name.clone())
		.filter(|s| !s.is_empty())
		.unwrap_or_else(|| mod_id.clone());
	let raw_version = mod_meta
		.as_ref()
		.map(|m| m.version.clone())
		.unwrap_or_default();
	let version = if raw_version.is_empty() || raw_version == "${version}" {
		props
			.get("mod_version")
			.or_else(|| props.get("version"))
			.cloned()
			.unwrap_or_else(|| "1.0.0".to_string())
	} else {
		raw_version
	};
	let java_version = extract_java_version_from_gradle(&build_text)
		.or_else(|| {
			mod_meta
				.as_ref()
				.and_then(|m| extract_java_from_depends(&m.depends))
		})
		.unwrap_or_else(|| recommended_java_for_mc(&mc_version));
	let is_modern_unobfuscated = if !mc_version.is_empty() {
		is_modern_unobfuscated_mc(&mc_version)
	} else {
		!build_text.contains("fabric-loom-remap") && !settings_text.contains("fabric-loom-remap")
	};
	let has_client_source_set =
		root.join("src/client").is_dir() || build_text.contains("splitEnvironmentSourceSets");
	let has_mixins = mod_meta
		.as_ref()
		.map(|m| !m.mixins.is_empty())
		.unwrap_or(false)
		|| has_any_mixin_json(root);

	Ok(Some(FabricProjectMeta {
		mod_id,
		mod_name,
		version,
		mc_version,
		loader_version,
		loom_version,
		fabric_api_version,
		java_version,
		is_modern_unobfuscated,
		has_client_source_set,
		has_mixins,
	}))
}

pub fn read_fabric_mod_json(root: &Path) -> Result<FabricModMetadata, String> {
	let path = find_fabric_mod_json(root)
		.ok_or_else(|| "fabric.mod.json not found in project".to_string())?;
	let raw_json = fs::read_to_string(&path)
		.map_err(|err| format!("Failed to read '{}': {}", path.display(), err))?;
	let val: Value = serde_json::from_str(&raw_json)
		.map_err(|err| format!("Invalid JSON in fabric.mod.json: {}", err))?;
	let obj = val
		.as_object()
		.ok_or_else(|| "fabric.mod.json root must be a JSON object".to_string())?;

	let schema_version = obj
		.get("schemaVersion")
		.and_then(|v| v.as_u64())
		.unwrap_or(1) as u32;
	let id = json_str(obj.get("id"));
	let version = json_str(obj.get("version"));
	let name = json_str(obj.get("name"));
	let description = json_str(obj.get("description"));
	let environment = obj
		.get("environment")
		.and_then(|v| v.as_str())
		.unwrap_or("*")
		.to_string();
	let license = match obj.get("license") {
		Some(Value::String(s)) => s.clone(),
		Some(Value::Array(arr)) => arr
			.iter()
			.filter_map(|v| v.as_str())
			.collect::<Vec<_>>()
			.join(", "),
		_ => String::new(),
	};
	let authors = obj
		.get("authors")
		.and_then(|v| v.as_array())
		.map(|arr| {
			arr.iter()
				.filter_map(|item| match item {
					Value::String(s) => Some(s.clone()),
					Value::Object(m) => m.get("name").and_then(|n| n.as_str()).map(String::from),
					_ => None,
				})
				.collect()
		})
		.unwrap_or_default();

	let mut entrypoints = HashMap::new();
	if let Some(ep_obj) = obj.get("entrypoints").and_then(|v| v.as_object()) {
		for (k, v) in ep_obj {
			if let Some(arr) = v.as_array() {
				let values = arr
					.iter()
					.filter_map(|item| match item {
						Value::String(s) => Some(s.clone()),
						Value::Object(m) => m
							.get("value")
							.and_then(|val| val.as_str())
							.map(String::from),
						_ => None,
					})
					.collect();
				entrypoints.insert(k.clone(), values);
			}
		}
	}

	let mixins = obj
		.get("mixins")
		.and_then(|v| v.as_array())
		.cloned()
		.unwrap_or_default();

	let mut depends = HashMap::new();
	if let Some(dep_obj) = obj.get("depends").and_then(|v| v.as_object()) {
		for (k, v) in dep_obj {
			let text = match v {
				Value::String(s) => s.clone(),
				Value::Array(arr) => arr
					.iter()
					.filter_map(|x| x.as_str())
					.collect::<Vec<_>>()
					.join(" "),
				other => other.to_string(),
			};
			depends.insert(k.clone(), text);
		}
	}

	Ok(FabricModMetadata {
		schema_version,
		id,
		version,
		name,
		description,
		authors,
		license,
		environment,
		entrypoints,
		mixins,
		depends,
		raw_json,
	})
}

pub fn write_fabric_mod_json(root: &Path, meta: &FabricModMetadata) -> Result<(), String> {
	let path = find_fabric_mod_json(root)
		.unwrap_or_else(|| root.join("src/main/resources/fabric.mod.json"));
	let mut obj = if !meta.raw_json.trim().is_empty() {
		serde_json::from_str::<Value>(&meta.raw_json)
			.ok()
			.and_then(|v| v.as_object().cloned())
			.unwrap_or_default()
	} else if path.is_file() {
		fs::read_to_string(&path)
			.ok()
			.and_then(|s| serde_json::from_str::<Value>(&s).ok())
			.and_then(|v| v.as_object().cloned())
			.unwrap_or_default()
	} else {
		Map::new()
	};

	obj.insert(
		"schemaVersion".to_string(),
		Value::Number(meta.schema_version.into()),
	);
	obj.insert("id".to_string(), Value::String(meta.id.clone()));
	obj.insert("version".to_string(), Value::String(meta.version.clone()));
	obj.insert("name".to_string(), Value::String(meta.name.clone()));
	obj.insert(
		"description".to_string(),
		Value::String(meta.description.clone()),
	);
	obj.insert(
		"authors".to_string(),
		Value::Array(meta.authors.iter().cloned().map(Value::String).collect()),
	);
	obj.insert("license".to_string(), Value::String(meta.license.clone()));
	obj.insert(
		"environment".to_string(),
		Value::String(meta.environment.clone()),
	);

	let mut ep_map = Map::new();
	let mut ep_keys: Vec<_> = meta.entrypoints.keys().cloned().collect();
	ep_keys.sort();
	for key in ep_keys {
		if let Some(vals) = meta.entrypoints.get(&key) {
			ep_map.insert(
				key,
				Value::Array(vals.iter().cloned().map(Value::String).collect()),
			);
		}
	}
	obj.insert("entrypoints".to_string(), Value::Object(ep_map));
	obj.insert("mixins".to_string(), Value::Array(meta.mixins.clone()));

	let mut dep_map = Map::new();
	let mut dep_keys: Vec<_> = meta.depends.keys().cloned().collect();
	dep_keys.sort();
	for key in dep_keys {
		if let Some(val) = meta.depends.get(&key) {
			dep_map.insert(key, Value::String(val.clone()));
		}
	}
	obj.insert("depends".to_string(), Value::Object(dep_map));

	let formatted = to_tab_pretty_json(&Value::Object(obj))?;
	write_project_file(&path, &formatted)
}

pub fn scan_mixins(root: &Path) -> Result<MixinScanResult, String> {
	let mod_meta = read_fabric_mod_json(root)?;
	let project_java = inspect_fabric_project(root)?
		.map(|m| m.java_version)
		.unwrap_or(25);
	let mut entries = Vec::new();

	for mixin_ref in &mod_meta.mixins {
		let (config_name, default_env) = match mixin_ref {
			Value::String(s) => (s.clone(), "*".to_string()),
			Value::Object(map) => {
				let cfg = map
					.get("config")
					.and_then(|v| v.as_str())
					.unwrap_or_default()
					.to_string();
				let env = map
					.get("environment")
					.and_then(|v| v.as_str())
					.unwrap_or("*")
					.to_string();
				(cfg, env)
			}
			_ => continue,
		};
		if config_name.is_empty() {
			continue;
		}
		let Some(config_path) = find_resource_file(root, &config_name) else {
			entries.push(MixinEntry {
				config_file: config_name.clone(),
				environment: default_env,
				package_name: String::new(),
				class_name: String::new(),
				rel_path: String::new(),
				target_classes: Vec::new(),
				methods: Vec::new(),
				issues: vec![format!("Mixin config file not found: {}", config_name)],
			});
			continue;
		};
		let config_rel = config_path
			.strip_prefix(root)
			.unwrap_or(&config_path)
			.to_string_lossy()
			.replace('\\', "/");
		let raw_cfg = match fs::read_to_string(&config_path) {
			Ok(s) => s,
			Err(err) => {
				entries.push(MixinEntry {
					config_file: config_rel,
					environment: default_env,
					package_name: String::new(),
					class_name: String::new(),
					rel_path: String::new(),
					target_classes: Vec::new(),
					methods: Vec::new(),
					issues: vec![format!("Failed to read mixin config: {}", err)],
				});
				continue;
			}
		};
		let cfg_val: Value = match serde_json::from_str(&raw_cfg) {
			Ok(v) => v,
			Err(err) => {
				entries.push(MixinEntry {
					config_file: config_rel,
					environment: default_env,
					package_name: String::new(),
					class_name: String::new(),
					rel_path: String::new(),
					target_classes: Vec::new(),
					methods: Vec::new(),
					issues: vec![format!("Invalid JSON in {}: {}", config_name, err)],
				});
				continue;
			}
		};
		let package_name = cfg_val
			.get("package")
			.and_then(|v| v.as_str())
			.unwrap_or_default()
			.to_string();
		let compat_issue = check_compat_level(
			cfg_val.get("compatibilityLevel").and_then(|v| v.as_str()),
			project_java,
		);

		let buckets = [
			("mixins", default_env.as_str()),
			("client", "client"),
			("server", "server"),
		];
		for (field, env) in buckets {
			let Some(arr) = cfg_val.get(field).and_then(|v| v.as_array()) else {
				continue;
			};
			for class_val in arr {
				let Some(class_name) = class_val.as_str() else {
					continue;
				};
				let mut issues = Vec::new();
				if let Some(issue) = &compat_issue {
					issues.push(issue.clone());
				}
				let java_subpath = format!(
					"{}/{}.java",
					package_name.replace('.', "/"),
					class_name.replace('.', "/")
				);
				let java_file = find_java_source_file(root, &java_subpath, env);
				let expected_rel = if env == "client" {
					format!("src/client/java/{}", java_subpath)
				} else {
					format!("src/main/java/{}", java_subpath)
				};
				match java_file {
					Some(path) => {
						let rel_path = path
							.strip_prefix(root)
							.unwrap_or(&path)
							.to_string_lossy()
							.replace('\\', "/");
						let source = fs::read_to_string(&path).unwrap_or_default();
						let target_classes = extract_mixin_targets(&source);
						if target_classes.is_empty() {
							issues.push(format!("Missing @Mixin annotation in {}", class_name));
						}
						let methods = extract_mixin_methods(&source);
						for m in &methods {
							if matches!(
								m.annotation.as_str(),
								"Inject" | "Redirect" | "ModifyArg" | "ModifyVariable"
							) && m.target_method.is_empty()
							{
								issues.push(format!(
									"@{} on '{}' (line {}) has no target method",
									m.annotation, m.name, m.line
								));
							}
						}
						entries.push(MixinEntry {
							config_file: config_rel.clone(),
							environment: env.to_string(),
							package_name: package_name.clone(),
							class_name: class_name.to_string(),
							rel_path,
							target_classes,
							methods,
							issues,
						});
					}
					None => {
						issues.push(format!(
							"Mixin Java source file not found: {}",
							expected_rel
						));
						entries.push(MixinEntry {
							config_file: config_rel.clone(),
							environment: env.to_string(),
							package_name: package_name.clone(),
							class_name: class_name.to_string(),
							rel_path: expected_rel,
							target_classes: Vec::new(),
							methods: Vec::new(),
							issues,
						});
					}
				}
			}
		}
	}
	Ok(MixinScanResult { entries })
}

fn check_compat_level(level: Option<&str>, project_java: u32) -> Option<String> {
	let expected = format!("JAVA_{}", project_java);
	match level {
		Some(lvl) if lvl == expected => None,
		Some(lvl) => Some(format!(
			"compatibilityLevel '{}' does not match project Java {} (expected {})",
			lvl, project_java, expected
		)),
		None => Some(format!(
			"Missing compatibilityLevel (expected {})",
			expected
		)),
	}
}

/// Extracts `@Mixin(...)` target classes from a Java source file.
pub fn extract_mixin_targets(source: &str) -> Vec<String> {
	let cleaned = strip_java_comments_keep_lines(source);
	static MIXIN_RE: OnceLock<Regex> = OnceLock::new();
	let re = MIXIN_RE.get_or_init(|| Regex::new(r"@Mixin\s*\(").expect("valid @Mixin regex"));
	let Some(mat) = re.find(&cleaned) else {
		return Vec::new();
	};
	let Some((body, _)) = extract_paren_body(&cleaned, mat.end() - 1) else {
		return Vec::new();
	};
	static CLASS_RE: OnceLock<Regex> = OnceLock::new();
	let class_re =
		CLASS_RE.get_or_init(|| Regex::new(r"([A-Za-z_][A-Za-z0-9_$.]*)\.class").expect("valid"));
	let mut targets: Vec<String> = class_re
		.captures_iter(&body)
		.map(|c| c[1].to_string())
		.collect();
	static STR_RE: OnceLock<Regex> = OnceLock::new();
	let str_re = STR_RE.get_or_init(|| Regex::new(r#""([^"]+)""#).expect("valid str"));
	if body.contains("targets") {
		for cap in str_re.captures_iter(&body) {
			let s = cap[1].to_string();
			if !targets.contains(&s) {
				targets.push(s);
			}
		}
	}
	targets
}

/// Extracts Mixin handler annotations (`@Inject`, `@Redirect`, `@Shadow`, etc.) and method names.
pub fn extract_mixin_methods(source: &str) -> Vec<MixinTargetMethod> {
	let cleaned = strip_java_comments_keep_lines(source);
	static ANN_RE: OnceLock<Regex> = OnceLock::new();
	let ann_re = ANN_RE.get_or_init(|| {
		Regex::new(
			r"@(Inject|Redirect|ModifyArg|ModifyVariable|ModifyExpressionValue|WrapOperation|Overwrite|Shadow|Accessor|Invoker)\b",
		)
		.expect("valid mixin annotation regex")
	});
	static METHOD_ATTR_RE: OnceLock<Regex> = OnceLock::new();
	let method_attr_re = METHOD_ATTR_RE
		.get_or_init(|| Regex::new(r#"method\s*=\s*(?:\{\s*)?"([^"]+)""#).expect("valid"));
	static VALUE_ATTR_RE: OnceLock<Regex> = OnceLock::new();
	let value_attr_re = VALUE_ATTR_RE
		.get_or_init(|| Regex::new(r#"^(?:\s*value\s*=\s*)?"([^"]+)""#).expect("valid"));
	static AT_RE: OnceLock<Regex> = OnceLock::new();
	let at_re = AT_RE.get_or_init(|| Regex::new(r"@At\s*\(").expect("valid"));
	static AT_VALUE_RE: OnceLock<Regex> = OnceLock::new();
	let at_value_re =
		AT_VALUE_RE.get_or_init(|| Regex::new(r#"(?:value\s*=\s*)?"([^"]+)""#).expect("valid"));
	static AT_TARGET_RE: OnceLock<Regex> = OnceLock::new();
	let at_target_re =
		AT_TARGET_RE.get_or_init(|| Regex::new(r#"target\s*=\s*"([^"]+)""#).expect("valid"));
	static DECL_NAME_RE: OnceLock<Regex> = OnceLock::new();
	let decl_name_re = DECL_NAME_RE
		.get_or_init(|| Regex::new(r"([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(|;|=)").expect("valid"));

	let mut methods = Vec::new();
	for mat in ann_re.captures_iter(&cleaned) {
		let full = mat.get(0).unwrap();
		let annotation = mat[1].to_string();
		let line = (cleaned[..full.start()]
			.bytes()
			.filter(|&b| b == b'\n')
			.count() + 1) as u32;
		let after_name = cleaned[full.end()..].trim_start();
		let offset_ws = cleaned.len() - full.end() - after_name.len();
		let paren_pos = full.end() + offset_ws;

		let (body, after_idx) = if cleaned.as_bytes().get(paren_pos) == Some(&b'(') {
			extract_paren_body(&cleaned, paren_pos).unwrap_or((String::new(), full.end()))
		} else {
			(String::new(), full.end())
		};

		let target_method = method_attr_re
			.captures(&body)
			.map(|c| c[1].to_string())
			.or_else(|| {
				matches!(annotation.as_str(), "Accessor" | "Invoker")
					.then(|| value_attr_re.captures(&body).map(|c| c[1].to_string()))
					.flatten()
			})
			.unwrap_or_default();

		let at_value = if let Some(at_mat) = at_re.find(&body) {
			if let Some((at_body, _)) = extract_paren_body(&body, at_mat.end() - 1) {
				let val = at_value_re
					.captures(&at_body)
					.map(|c| c[1].to_string())
					.unwrap_or_default();
				let target = at_target_re.captures(&at_body).map(|c| c[1].to_string());
				match (val.is_empty(), target) {
					(false, Some(t)) => format!("{} ({})", val, t),
					(false, None) => val,
					_ => at_body.trim().to_string(),
				}
			} else {
				String::new()
			}
		} else {
			String::new()
		};

		let rest = &cleaned[after_idx..];
		let decl_snippet = skip_leading_annotations(rest);
		let name = decl_name_re
			.captures(decl_snippet)
			.map(|c| c[1].to_string())
			.unwrap_or_else(|| annotation.clone());

		methods.push(MixinTargetMethod {
			name,
			annotation,
			line,
			target_method,
			at_value,
		});
	}
	methods
}

fn skip_leading_annotations(mut s: &str) -> &str {
	loop {
		s = s.trim_start();
		if !s.starts_with('@') {
			return s;
		}
		let mut idx = 1;
		let bytes = s.as_bytes();
		while idx < bytes.len()
			&& (bytes[idx].is_ascii_alphanumeric() || bytes[idx] == b'_' || bytes[idx] == b'.')
		{
			idx += 1;
		}
		while idx < bytes.len() && bytes[idx].is_ascii_whitespace() {
			idx += 1;
		}
		if bytes.get(idx) == Some(&b'(') {
			if let Some((_, next_idx)) = extract_paren_body(s, idx) {
				s = &s[next_idx..];
				continue;
			}
		}
		s = &s[idx..];
	}
}

fn extract_paren_body(s: &str, open_idx: usize) -> Option<(String, usize)> {
	let bytes = s.as_bytes();
	if bytes.get(open_idx) != Some(&b'(') {
		return None;
	}
	let mut depth = 0usize;
	let mut in_string = false;
	let mut escaped = false;
	for (offset, &b) in bytes[open_idx..].iter().enumerate() {
		if in_string {
			if escaped {
				escaped = false;
			} else if b == b'\\' {
				escaped = true;
			} else if b == b'"' {
				in_string = false;
			}
			continue;
		}
		match b {
			b'"' => in_string = true,
			b'(' => depth += 1,
			b')' => {
				depth -= 1;
				if depth == 0 {
					return Some((
						s[open_idx + 1..open_idx + offset].to_string(),
						open_idx + offset + 1,
					));
				}
			}
			_ => {}
		}
	}
	None
}

fn strip_java_comments_keep_lines(source: &str) -> String {
	let bytes = source.as_bytes();
	let mut out = String::with_capacity(source.len());
	let mut i = 0;
	let mut in_str = false;
	let mut in_char = false;
	let mut esc = false;
	while i < bytes.len() {
		let b = bytes[i];
		if in_str {
			out.push(b as char);
			if esc {
				esc = false;
			} else if b == b'\\' {
				esc = true;
			} else if b == b'"' {
				in_str = false;
			}
			i += 1;
			continue;
		}
		if in_char {
			out.push(b as char);
			if esc {
				esc = false;
			} else if b == b'\\' {
				esc = true;
			} else if b == b'\'' {
				in_char = false;
			}
			i += 1;
			continue;
		}
		if b == b'/' && bytes.get(i + 1) == Some(&b'/') {
			while i < bytes.len() && bytes[i] != b'\n' {
				out.push(' ');
				i += 1;
			}
			continue;
		}
		if b == b'/' && bytes.get(i + 1) == Some(&b'*') {
			out.push_str("  ");
			i += 2;
			while i < bytes.len() {
				if bytes[i] == b'*' && bytes.get(i + 1) == Some(&b'/') {
					out.push_str("  ");
					i += 2;
					break;
				}
				out.push(if bytes[i] == b'\n' { '\n' } else { ' ' });
				i += 1;
			}
			continue;
		}
		if b == b'"' {
			in_str = true;
		} else if b == b'\'' {
			in_char = true;
		}
		out.push(b as char);
		i += 1;
	}
	out
}

pub fn analyze_version_migration(
	root: &Path,
	target_mc: &str,
	catalog: &FabricVersionCatalog,
) -> Result<MigrationPlan, String> {
	let computed = compute_migration(root, target_mc, catalog)?;
	Ok(computed.plan)
}

pub fn apply_version_migration(
	root: &Path,
	target_mc: &str,
	catalog: &FabricVersionCatalog,
	revision: &str,
) -> Result<MigrationResult, String> {
	let computed = compute_migration(root, target_mc, catalog)?;
	if revision != computed.plan.revision {
		return Err("Files changed since preview. Analyze the migration again.".into());
	}
	let applied_files = commit_migration(root, &computed.writes)?;
	Ok(MigrationResult {
		applied_files,
		notes: computed.plan.breaking_notes,
	})
}

fn commit_migration(
	root: &Path,
	writes: &[(String, String, String)],
) -> Result<Vec<String>, String> {
	let backups = tempfile::Builder::new()
		.prefix(".modium-backup-")
		.tempdir_in(root)
		.map_err(|e| e.to_string())?;
	let mut prepared = Vec::new();
	for (i, (rel, before, after)) in writes.iter().enumerate() {
		let path = crate::filesystem::resolve_workspace_path(root, rel)?;
		if fs::read_to_string(&path).map_err(|e| e.to_string())? != *before {
			return Err(format!("{rel} changed. Analyze again."));
		}
		fs::copy(&path, backups.path().join(i.to_string())).map_err(|e| e.to_string())?;
		let tmp =
			tempfile::NamedTempFile::new_in(path.parent().unwrap()).map_err(|e| e.to_string())?;
		fs::write(tmp.path(), after).map_err(|e| e.to_string())?;
		fs::set_permissions(
			tmp.path(),
			fs::metadata(&path)
				.map_err(|e| e.to_string())?
				.permissions(),
		)
		.map_err(|e| e.to_string())?;
		prepared.push((path, tmp));
	}
	for (i, (path, tmp)) in prepared.into_iter().enumerate() {
		let result = fs::read_to_string(&path).and_then(|text| {
			if text != writes[i].1 {
				return Err(std::io::Error::other("File changed during migration"));
			}
			tmp.persist(&path).map(|_| ()).map_err(|e| e.error)
		});
		if let Err(e) = result {
			let mut error = format!("{}: {e}", path.display());
			let mut incomplete = false;
			for j in (0..i).rev() {
				let original = backups.path().join(j.to_string());
				let target = root.join(&writes[j].0);
				if let Err(err) = fs::rename(&original, &target) {
					incomplete = true;
					error.push_str(&format!(
						"\nRestore {} from {}: {err}",
						target.display(),
						original.display()
					));
				}
			}
			if incomplete {
				let _ = backups.keep();
			}
			return Err(error);
		}
	}
	Ok(writes.iter().map(|w| w.0.clone()).collect())
}

struct ComputedMigration {
	plan: MigrationPlan,
	writes: Vec<(String, String, String)>,
}

fn compute_migration(
	root: &Path,
	target_mc: &str,
	catalog: &FabricVersionCatalog,
) -> Result<ComputedMigration, String> {
	let meta = inspect_fabric_project(root)?
		.ok_or_else(|| "Workspace is not a valid Fabric project".to_string())?;
	let compat = resolve_fabric_compat_sync(target_mc, catalog);
	let from_modern = meta.is_modern_unobfuscated;
	let to_modern = compat.is_modern_unobfuscated;

	let mut changes = Vec::new();
	let mut writes = Vec::new();
	let mut breaking_notes = Vec::new();

	// 1. gradle.properties
	let props_path = root.join("gradle.properties");
	if props_path.is_file() {
		let before = fs::read_to_string(&props_path)
			.map_err(|err| format!("Failed to read gradle.properties: {}", err))?;
		let after = transform_gradle_properties(&before, &compat);
		if before != after {
			changes.push(MigrationChange {
				file: "gradle.properties".to_string(),
				description: "Update Minecraft, Loader, Loom, and Fabric API versions".to_string(),
				before: summarize_diff_lines(&before, &after).0,
				after: summarize_diff_lines(&before, &after).1,
			});
			writes.push(("gradle.properties".to_string(), before, after));
		}
	}

	// 2. settings.gradle(.kts)
	if let Some(settings_path) = find_settings_gradle(root) {
		let rel = settings_path
			.strip_prefix(root)
			.unwrap_or(&settings_path)
			.to_string_lossy()
			.replace('\\', "/");
		let before = fs::read_to_string(&settings_path)
			.map_err(|err| format!("Failed to read {}: {}", rel, err))?;
		let after = transform_settings_gradle(&before, to_modern, &compat.loom_version);
		if before != after {
			let (b_sum, a_sum) = summarize_diff_lines(&before, &after);
			changes.push(MigrationChange {
				file: rel.clone(),
				description: "Update Loom plugin identifier in settings".to_string(),
				before: b_sum,
				after: a_sum,
			});
			writes.push((rel, before, after));
		}
	}

	// 3. build.gradle(.kts)
	if let Some(build_path) = find_build_gradle(root) {
		let rel = build_path
			.strip_prefix(root)
			.unwrap_or(&build_path)
			.to_string_lossy()
			.replace('\\', "/");
		let is_kts = rel.ends_with(".kts");
		let before = fs::read_to_string(&build_path)
			.map_err(|err| format!("Failed to read {}: {}", rel, err))?;
		let after = transform_build_gradle(
			&before,
			is_kts,
			to_modern,
			compat.recommended_java,
			&compat.loom_version,
		);
		if before != after {
			let (b_sum, a_sum) = summarize_diff_lines(&before, &after);
			changes.push(MigrationChange {
				file: rel.clone(),
				description: if to_modern {
					"Migrate build script to unobfuscated fabric-loom and Java 25".to_string()
				} else {
					format!(
						"Migrate build script to fabric-loom-remap and Java {}",
						compat.recommended_java
					)
				},
				before: b_sum,
				after: a_sum,
			});
			writes.push((rel, before, after));
		}
	}

	// 4. fabric.mod.json
	if let Some(mod_json_path) = find_fabric_mod_json(root) {
		let rel = mod_json_path
			.strip_prefix(root)
			.unwrap_or(&mod_json_path)
			.to_string_lossy()
			.replace('\\', "/");
		let before = fs::read_to_string(&mod_json_path)
			.map_err(|err| format!("Failed to read {}: {}", rel, err))?;
		if let Ok(after) = transform_fabric_mod_json(&before, &compat) {
			if before != after {
				let (b_sum, a_sum) = summarize_diff_lines(&before, &after);
				changes.push(MigrationChange {
					file: rel.clone(),
					description: "Update depends.minecraft, depends.java, and depends.fabricloader"
						.to_string(),
					before: b_sum,
					after: a_sum,
				});
				writes.push((rel, before, after));
			}
		}
	}

	// 5. *.mixins.json
	for mixin_cfg in collect_all_mixin_configs(root) {
		let rel = mixin_cfg
			.strip_prefix(root)
			.unwrap_or(&mixin_cfg)
			.to_string_lossy()
			.replace('\\', "/");
		if let Ok(before) = fs::read_to_string(&mixin_cfg) {
			if let Ok(after) = transform_mixin_json_compat(&before, compat.recommended_java) {
				if before != after {
					let (b_sum, a_sum) = summarize_diff_lines(&before, &after);
					changes.push(MigrationChange {
						file: rel.clone(),
						description: format!(
							"Update Mixin compatibilityLevel to JAVA_{}",
							compat.recommended_java
						),
						before: b_sum,
						after: a_sum,
					});
					writes.push((rel, before, after));
				}
			}
		}
	}

	// 6. Breaking notes
	if !from_modern && to_modern {
		breaking_notes.push(
			"Unobfuscated Minecraft 26.1+: switched net.fabricmc.fabric-loom-remap -> net.fabricmc.fabric-loom, removed mappings(...), and replaced modImplementation -> implementation."
				.to_string(),
		);
		breaking_notes.push(
			"ResourceLocation -> Identifier: rename net.minecraft.resources.ResourceLocation usages to net.minecraft.resources.Identifier."
				.to_string(),
		);
		let rl_hits = find_java_token_hits(root, "ResourceLocation");
		if !rl_hits.is_empty() {
			breaking_notes.push(format!(
				"Files referencing ResourceLocation: {}",
				rl_hits.join(", ")
			));
		}
	} else if from_modern && !to_modern {
		breaking_notes.push(
			"Remapped Minecraft <26.1: switched net.fabricmc.fabric-loom -> net.fabricmc.fabric-loom-remap, restored mappings(loom.officialMojangMappings()), and replaced implementation -> modImplementation."
				.to_string(),
		);
		breaking_notes.push(
			"Identifier -> ResourceLocation: check net.minecraft.resources.Identifier usages when targeting legacy versions."
				.to_string(),
		);
		let id_hits = find_java_token_hits(root, "net.minecraft.resources.Identifier");
		if !id_hits.is_empty() {
			breaking_notes.push(format!(
				"Files referencing Identifier: {}",
				id_hits.join(", ")
			));
		}
	}
	if meta.java_version != compat.recommended_java {
		breaking_notes.push(format!(
			"Java {} -> {}: updated Java compilation target and Mixin compatibilityLevel.",
			meta.java_version, compat.recommended_java
		));
	}

	let mut signature = Sha256::new();
	signature.update(root.as_os_str().as_encoded_bytes());
	let mut ordered = writes.iter().collect::<Vec<_>>();
	ordered.sort_by_key(|w| &w.0);
	for (path, before, after) in ordered {
		for field in [path, before, after] {
			signature.update(field.len().to_le_bytes());
			signature.update(field.as_bytes());
		}
	}
	Ok(ComputedMigration {
		plan: MigrationPlan {
			revision: format!("{:x}", signature.finalize()),
			from_mc: meta.mc_version,
			to_mc: compat.mc_version,
			target_loader: compat.loader_version,
			target_loom: compat.loom_version,
			target_api: compat.fabric_api_version,
			target_java: compat.recommended_java,
			breaking_notes,
			changes,
		},
		writes,
	})
}

fn transform_gradle_properties(raw: &str, compat: &FabricCompatVersions) -> String {
	let mut out = Vec::new();
	let mut seen_mc = false;
	let mut seen_loader = false;
	let mut seen_loom = false;
	let mut seen_api = false;
	for line in raw.lines() {
		let trimmed = line.trim();
		if let Some((key, _)) = trimmed.split_once('=') {
			let k = key.trim();
			match k {
				"minecraft_version" => {
					seen_mc = true;
					out.push(format!("minecraft_version={}", compat.mc_version));
					continue;
				}
				"loader_version" => {
					seen_loader = true;
					out.push(format!("loader_version={}", compat.loader_version));
					continue;
				}
				"loom_version" => {
					seen_loom = true;
					out.push(format!("loom_version={}", compat.loom_version));
					continue;
				}
				"fabric_api_version" | "fabric_version" => {
					seen_api = true;
					out.push(format!("{}={}", k, compat.fabric_api_version));
					continue;
				}
				"yarn_mappings" if compat.is_modern_unobfuscated => {
					continue;
				}
				_ => {}
			}
		}
		out.push(line.to_string());
	}
	if !seen_mc {
		out.push(format!("minecraft_version={}", compat.mc_version));
	}
	if !seen_loader {
		out.push(format!("loader_version={}", compat.loader_version));
	}
	if !seen_loom {
		out.push(format!("loom_version={}", compat.loom_version));
	}
	if !seen_api {
		out.push(format!("fabric_api_version={}", compat.fabric_api_version));
	}
	out.join("\n")
}

fn transform_settings_gradle(raw: &str, to_modern: bool, loom_version: &str) -> String {
	let mut text = if to_modern {
		raw.replace("net.fabricmc.fabric-loom-remap", "net.fabricmc.fabric-loom")
	} else {
		raw.replace("net.fabricmc.fabric-loom-remap", "__LOOM_REMAP__")
			.replace("net.fabricmc.fabric-loom", "net.fabricmc.fabric-loom-remap")
			.replace("__LOOM_REMAP__", "net.fabricmc.fabric-loom-remap")
	};
	static VER_RE: OnceLock<Regex> = OnceLock::new();
	let ver_re = VER_RE.get_or_init(|| {
		Regex::new(r#"(id\s*\(\s*["']net\.fabricmc\.fabric-loom(?:-remap)?["']\s*\)\s+version\s+["'])([^"']+)(["'])"#)
			.expect("valid")
	});
	text = ver_re
		.replace_all(&text, |caps: &regex::Captures| {
			if caps[2].contains('$') {
				caps[0].to_string()
			} else {
				format!("{}{}{}", &caps[1], loom_version, &caps[3])
			}
		})
		.to_string();
	text
}

fn transform_build_gradle(
	raw: &str,
	is_kts: bool,
	to_modern: bool,
	target_java: u32,
	loom_version: &str,
) -> String {
	let mut text = if to_modern {
		raw.replace("net.fabricmc.fabric-loom-remap", "net.fabricmc.fabric-loom")
	} else {
		raw.replace("net.fabricmc.fabric-loom-remap", "__LOOM_REMAP__")
			.replace("net.fabricmc.fabric-loom", "net.fabricmc.fabric-loom-remap")
			.replace("__LOOM_REMAP__", "net.fabricmc.fabric-loom-remap")
	};
	static LITERAL_LOOM_RE: OnceLock<Regex> = OnceLock::new();
	let loom_re = LITERAL_LOOM_RE.get_or_init(|| {
		Regex::new(r#"(id\s*[\(\s]+["']net\.fabricmc\.fabric-loom(?:-remap)?["']\)?\s+version\s+["'])([^"']+)(["'])"#)
			.expect("valid")
	});
	text = loom_re
		.replace_all(&text, |caps: &regex::Captures| {
			if caps[2].contains('$') {
				caps[0].to_string()
			} else {
				format!("{}{}{}", &caps[1], loom_version, &caps[3])
			}
		})
		.to_string();

	static JAVA_VER_RE: OnceLock<Regex> = OnceLock::new();
	let jv_re = JAVA_VER_RE.get_or_init(|| Regex::new(r"JavaVersion\.VERSION_\d+").expect("valid"));
	text = jv_re
		.replace_all(&text, format!("JavaVersion.VERSION_{}", target_java))
		.to_string();

	static REL_SET_RE: OnceLock<Regex> = OnceLock::new();
	let rel_set_re =
		REL_SET_RE.get_or_init(|| Regex::new(r"(options\.release\.set\()\d+(\))").expect("valid"));
	text = rel_set_re
		.replace_all(&text, format!("${{1}}{}${{2}}", target_java))
		.to_string();

	static REL_EQ_RE: OnceLock<Regex> = OnceLock::new();
	let rel_eq_re =
		REL_EQ_RE.get_or_init(|| Regex::new(r"(options\.release\s*=\s*)\d+").expect("valid"));
	text = rel_eq_re
		.replace_all(&text, format!("${{1}}{}", target_java))
		.to_string();

	let mut lines: Vec<String> = text.lines().map(String::from).collect();
	if to_modern {
		lines.retain(|line| {
			let trimmed = line.trim();
			!trimmed.starts_with("mappings(") && !trimmed.starts_with("mappings ")
		});
		for line in &mut lines {
			*line = replace_mod_configs_to_standard(line);
		}
	} else {
		let has_mappings = lines.iter().any(|l| {
			let t = l.trim();
			t.starts_with("mappings(") || t.starts_with("mappings ")
		});
		let mut updated = Vec::with_capacity(lines.len() + 1);
		for line in lines {
			let converted = replace_standard_fabric_deps_to_mod(&line);
			let is_mc_dep = {
				let t = converted.trim();
				t.starts_with("minecraft(") || t.starts_with("minecraft ")
			};
			updated.push(converted);
			if !has_mappings && is_mc_dep {
				let indent: String = line
					.chars()
					.take_while(|c| *c == '\t' || *c == ' ')
					.collect();
				if is_kts {
					updated.push(format!("{}mappings(loom.officialMojangMappings())", indent));
				} else {
					updated.push(format!("{}mappings loom.officialMojangMappings()", indent));
				}
			}
		}
		lines = updated;
	}
	lines.join("\n")
}

fn replace_mod_configs_to_standard(line: &str) -> String {
	static RE: OnceLock<Regex> = OnceLock::new();
	let re = RE.get_or_init(|| {
		Regex::new(r"^(\s*)mod(Implementation|Api|CompileOnly|RuntimeOnly)(\b.*)$").expect("valid")
	});
	if let Some(caps) = re.captures(line) {
		let lower_first = match &caps[2] {
			"Implementation" => "implementation",
			"Api" => "api",
			"CompileOnly" => "compileOnly",
			_ => "runtimeOnly",
		};
		format!("{}{}{}", &caps[1], lower_first, &caps[3])
	} else {
		line.to_string()
	}
}

fn replace_standard_fabric_deps_to_mod(line: &str) -> String {
	static RE: OnceLock<Regex> = OnceLock::new();
	let re = RE.get_or_init(|| {
		Regex::new(r"^(\s*)(implementation|api|compileOnly|runtimeOnly)(\b.*net\.fabricmc.*)$")
			.expect("valid")
	});
	if let Some(caps) = re.captures(line) {
		let capitalized = match &caps[2] {
			"implementation" => "modImplementation",
			"api" => "modApi",
			"compileOnly" => "modCompileOnly",
			_ => "modRuntimeOnly",
		};
		format!("{}{}{}", &caps[1], capitalized, &caps[3])
	} else {
		line.to_string()
	}
}

fn transform_fabric_mod_json(raw: &str, compat: &FabricCompatVersions) -> Result<String, String> {
	let mut val: Value = serde_json::from_str(raw).map_err(|e| e.to_string())?;
	if let Some(obj) = val.as_object_mut() {
		let depends = obj
			.entry("depends")
			.or_insert_with(|| Value::Object(Map::new()));
		if let Some(dep_obj) = depends.as_object_mut() {
			dep_obj.insert(
				"minecraft".to_string(),
				Value::String(format!("~{}", compat.mc_version)),
			);
			dep_obj.insert(
				"java".to_string(),
				Value::String(format!(">={}", compat.recommended_java)),
			);
			dep_obj.insert(
				"fabricloader".to_string(),
				Value::String(format!(">={}", compat.loader_version)),
			);
		}
	}
	to_tab_pretty_json(&val)
}

fn transform_mixin_json_compat(raw: &str, target_java: u32) -> Result<String, String> {
	let mut val: Value = serde_json::from_str(raw).map_err(|e| e.to_string())?;
	if let Some(obj) = val.as_object_mut() {
		obj.insert(
			"compatibilityLevel".to_string(),
			Value::String(format!("JAVA_{}", target_java)),
		);
	}
	to_tab_pretty_json(&val)
}

fn summarize_diff_lines(before: &str, after: &str) -> (String, String) {
	let before_lines: Vec<&str> = before.lines().collect();
	let after_lines: Vec<&str> = after.lines().collect();
	let mut removed = Vec::new();
	let mut added = Vec::new();
	for line in &before_lines {
		if !after_lines.contains(line) && !line.trim().is_empty() {
			removed.push(line.trim());
		}
	}
	for line in &after_lines {
		if !before_lines.contains(line) && !line.trim().is_empty() {
			added.push(line.trim());
		}
	}
	(removed.join("\n"), added.join("\n"))
}

fn find_java_token_hits(root: &Path, token: &str) -> Vec<String> {
	let mut hits = Vec::new();
	let src = root.join("src");
	if !src.is_dir() {
		return hits;
	}
	let mut stack = vec![src];
	while let Some(dir) = stack.pop() {
		let Ok(entries) = fs::read_dir(&dir) else {
			continue;
		};
		for entry in entries.flatten() {
			let path = entry.path();
			if path.is_dir() {
				stack.push(path);
			} else if path.extension().and_then(|e| e.to_str()) == Some("java") {
				if let Ok(content) = fs::read_to_string(&path) {
					if content.contains(token) {
						let rel = path
							.strip_prefix(root)
							.unwrap_or(&path)
							.to_string_lossy()
							.replace('\\', "/");
						hits.push(rel);
					}
				}
			}
		}
	}
	hits.sort();
	hits
}

fn collect_all_mixin_configs(root: &Path) -> Vec<PathBuf> {
	let mut configs = Vec::new();
	let src = root.join("src");
	if !src.is_dir() {
		return configs;
	}
	let Ok(source_sets) = fs::read_dir(&src) else {
		return configs;
	};
	for ss in source_sets.flatten() {
		let res = ss.path().join("resources");
		if let Ok(files) = fs::read_dir(&res) {
			for file in files.flatten() {
				let path = file.path();
				if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
					if name.ends_with(".mixins.json") && path.is_file() {
						configs.push(path);
					}
				}
			}
		}
	}
	configs.sort();
	configs
}

fn find_fabric_mod_json(root: &Path) -> Option<PathBuf> {
	let candidates = [
		root.join("src/main/resources/fabric.mod.json"),
		root.join("src/fabric.mod.json"),
		root.join("fabric.mod.json"),
	];
	candidates.into_iter().find(|p| p.is_file())
}

fn find_build_gradle(root: &Path) -> Option<PathBuf> {
	let candidates = [root.join("build.gradle.kts"), root.join("build.gradle")];
	candidates.into_iter().find(|p| p.is_file())
}

fn find_settings_gradle(root: &Path) -> Option<PathBuf> {
	let candidates = [
		root.join("settings.gradle.kts"),
		root.join("settings.gradle"),
	];
	candidates.into_iter().find(|p| p.is_file())
}

fn find_resource_file(root: &Path, filename: &str) -> Option<PathBuf> {
	let direct = root.join("src/main/resources").join(filename);
	if direct.is_file() {
		return Some(direct);
	}
	let src = root.join("src");
	let entries = fs::read_dir(src).ok()?;
	for entry in entries.flatten() {
		let candidate = entry.path().join("resources").join(filename);
		if candidate.is_file() {
			return Some(candidate);
		}
	}
	None
}

fn find_java_source_file(root: &Path, subpath: &str, env: &str) -> Option<PathBuf> {
	let preferred = if env == "client" {
		root.join("src/client/java").join(subpath)
	} else {
		root.join("src/main/java").join(subpath)
	};
	if preferred.is_file() {
		return Some(preferred);
	}
	let src = root.join("src");
	let entries = fs::read_dir(src).ok()?;
	for entry in entries.flatten() {
		let candidate = entry.path().join("java").join(subpath);
		if candidate.is_file() {
			return Some(candidate);
		}
	}
	None
}

fn has_any_mixin_json(root: &Path) -> bool {
	!collect_all_mixin_configs(root).is_empty()
}

fn read_gradle_properties(root: &Path) -> HashMap<String, String> {
	let mut map = HashMap::new();
	let Ok(content) = fs::read_to_string(root.join("gradle.properties")) else {
		return map;
	};
	for line in content.lines() {
		let trimmed = line.trim();
		if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with('!') {
			continue;
		}
		if let Some((k, v)) = trimmed.split_once('=') {
			map.insert(k.trim().to_string(), v.trim().to_string());
		}
	}
	map
}

fn extract_loom_version_from_gradle(build_text: &str) -> Option<String> {
	static RE: OnceLock<Regex> = OnceLock::new();
	let re = RE.get_or_init(|| {
		Regex::new(
			r#"id\s*[\(\s]+["']net\.fabricmc\.fabric-loom(?:-remap)?["']\)?\s+version\s+["']([^"']+)["']"#,
		)
		.expect("valid")
	});
	let caps = re.captures(build_text)?;
	let ver = caps[1].trim();
	(!ver.contains('$')).then(|| ver.to_string())
}

fn extract_java_version_from_gradle(build_text: &str) -> Option<u32> {
	static JV_RE: OnceLock<Regex> = OnceLock::new();
	let jv_re = JV_RE.get_or_init(|| Regex::new(r"JavaVersion\.VERSION_(\d+)").expect("valid"));
	if let Some(caps) = jv_re.captures(build_text) {
		if let Ok(v) = caps[1].parse::<u32>() {
			return Some(v);
		}
	}
	static REL_RE: OnceLock<Regex> = OnceLock::new();
	let rel_re = REL_RE
		.get_or_init(|| Regex::new(r"options\.release(?:\.set)?\s*[\(=]\s*(\d+)").expect("valid"));
	rel_re
		.captures(build_text)
		.and_then(|c| c[1].parse::<u32>().ok())
}

fn extract_mc_from_depends(depends: &HashMap<String, String>) -> Option<String> {
	let raw = depends.get("minecraft")?;
	let cleaned = raw
		.trim()
		.trim_start_matches(['~', '^', '>', '<', '='])
		.trim();
	(!cleaned.is_empty()).then(|| cleaned.to_string())
}

fn extract_java_from_depends(depends: &HashMap<String, String>) -> Option<u32> {
	let raw = depends.get("java")?;
	let digits: String = raw.chars().filter(|c| c.is_ascii_digit()).collect();
	digits.parse::<u32>().ok()
}

fn json_str(val: Option<&Value>) -> String {
	val.and_then(|v| v.as_str()).unwrap_or_default().to_string()
}

fn to_tab_pretty_json(val: &Value) -> Result<String, String> {
	let mut buf = Vec::new();
	let formatter = serde_json::ser::PrettyFormatter::with_indent(b"\t");
	let mut ser = serde_json::Serializer::with_formatter(&mut buf, formatter);
	serde::Serialize::serialize(val, &mut ser).map_err(|e| e.to_string())?;
	String::from_utf8(buf).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
	use super::*;
	use uuid::Uuid;

	fn base_config(dir: &Path, mc: &str, api: &str) -> CreateProjectConfig {
		CreateProjectConfig {
			project_dir: dir.to_string_lossy().to_string(),
			mod_name: "Example Studio Mod".to_string(),
			mod_id: "example_mod".to_string(),
			package_name: "com.example.mod".to_string(),
			mc_version: mc.to_string(),
			loader_version: DEFAULT_LOADER_VERSION.to_string(),
			loom_version: DEFAULT_LOOM_VERSION.to_string(),
			fabric_api_version: api.to_string(),
			jdk_path: None,
			generate_client_entrypoint: true,
			enable_mixin: true,
			use_yarn_mappings: false,
		}
	}

	#[tokio::test]
	#[ignore = "requires JDT LS, Java debug adapter, JDK 25 and Gradle"]
	async fn debug_save_changes_running_method() {
		let temp = tempfile::tempdir().unwrap();
		let root = temp.path();
		create_fabric_project(&base_config(root, "26.3", DEFAULT_API_26_3)).await.unwrap();
		let client_dir = root.join("src/client/java/com/example/mod/client");
		let path = fs::read_dir(client_dir).unwrap().flatten().map(|f| f.path()).find(|p| p.extension().is_some_and(|s| s == "java")).unwrap();
		let original = fs::read_to_string(&path).unwrap();
		let source = original.replace("@Override\n\tpublic void onInitializeClient() {", r#"static String value() { return "before"; }
	@Override
	public void onInitializeClient() {
		Thread.startVirtualThread(() -> {
			try {
				for (;;) {
					java.nio.file.Files.writeString(java.nio.file.Path.of("observed.txt"), value());
					Thread.sleep(100);
				}
			} catch (Exception e) { throw new RuntimeException(e); }
		});"#);
		fs::write(&path, &source).unwrap();
		let uri = url::Url::from_file_path(&path).unwrap().to_string();
		let jdk = PathBuf::from(std::env::var_os("JAVA_HOME").unwrap());
		let server = crate::lsp::LspManager::new();
		let debug = crate::debug::DebugManager::new();
		server.start_language_server(None, root.into(), jdk.clone(), Some(jdk.clone())).await.unwrap();
		let result: Result<(), String> = async {
			server.did_open(uri.clone(), "java".into(), 1, source.clone()).await?;
			for _ in 0..5 {
				if server.search_types(path.file_stem().unwrap().to_string_lossy().into_owned()).await.is_ok_and(|v| v.to_string().contains(".java")) { break; }
				tokio::time::sleep(std::time::Duration::from_secs(1)).await;
			}
			debug.start_debug_client(None, &server, root.into(), Some(jdk), vec![]).await?;
			let wait = |expected: &'static str| async move {
				for _ in 0..500 {
					if fs::read_to_string(root.join("run/observed.txt")).unwrap_or_default() == expected { return Ok(()); }
					tokio::time::sleep(std::time::Duration::from_millis(150)).await;
				}
				Err(format!("Running JVM did not return {expected}"))
			};
			wait("before").await?;
			let changed = source.replace("before", "after");
			server.did_change(uri.clone(), 2, changed.clone()).await?;
			fs::write(&path, &changed).unwrap();
			server.did_save(uri.clone(), Some(changed)).await?;
			wait("after").await
		}.await;
		let _ = debug.stop().await;
		server.stop().await;
		result.unwrap();
	}

	#[tokio::test]
	#[ignore = "requires JDT LS, JDK 25 and the Fabric 26.3 Gradle dependencies"]
	async fn java_client_completion_and_imports() {
		let dir = tempfile::tempdir().unwrap();
		create_fabric_project(&base_config(dir.path(), "26.3", DEFAULT_API_26_3)).await.unwrap();
		let file = dir.path().join("src/client/java/com/example/mod/client/Probe.java");
		let source = "package com.example.mod.client;\nclass Probe { void run() {\nMinec\n} }";
		fs::write(&file, source).unwrap();
		let uri = url::Url::from_file_path(&file).unwrap().to_string();
		let server = crate::lsp::LspManager::new();
		let jdk = PathBuf::from(std::env::var_os("JAVA_HOME").unwrap());
		server.start_language_server(None, dir.path().to_owned(), jdk.clone(), Some(jdk)).await.unwrap();
		let result: Result<(), String> = async {
			server.did_open(uri.clone(), "java".into(), 1, source.into()).await?;
			let mut found = None;
			for _ in 0..24 {
				let raw = match server.completion(uri.clone(), 2, 5).await {
					Ok(raw) => raw,
					Err(message) if message.contains("timed out") => continue,
					Err(message) => return Err(message),
				};
				if let Some(items) = raw["items"].as_array().or_else(|| raw.as_array()) {
					if let Some(item) = items.iter().find(|v| v["label"].as_str().is_some_and(|l| l.split([' ', '(']).next() == Some("Minecraft"))) {
						found = Some(server.resolve_completion(item.clone()).await?);
						break;
					}
				}
				tokio::time::sleep(std::time::Duration::from_secs(2)).await;
			}
			let item = found.ok_or("Minecraft missing from client source set")?;
			assert!(item.to_string().contains("net.minecraft.client.Minecraft"), "{item}");
			let imported = "package com.example.mod.client;\nimport net.minecraft.client.Minecraft;\nclass Probe { void run() {\nMinecraft.\n} }";
			server.did_change(uri.clone(), 2, imported.into()).await?;
			let methods = server.completion(uri.clone(), 3, 10).await?;
			if !methods.to_string().contains("getInstance") {return Err("getInstance missing".into());}
			let unordered = "package com.example.mod.client;\nimport java.io.File;\nimport nonexistent.InvalidType;\nclass Probe { Minecraft game; ArrayList<String> names; }";
			server.did_change(uri.clone(), 3, unordered.into()).await?;
			let reply = server.organize_imports(uri.clone(), vec![]).await?;
			let edit = &reply["edit"];
			eprintln!("Organize result: {edit}");
			let changes = edit["changes"].as_object().and_then(|m| m.values().next()).and_then(|v| v.as_array()).ok_or("No import edits")?;
			let mut actual = unordered.to_string();
			for patch in changes.iter().rev() {
				let offset = |pos: &Value| -> usize {
					unordered.split_inclusive('\n').take(pos["line"].as_u64().unwrap() as usize).map(str::len).sum::<usize>() + pos["character"].as_u64().unwrap() as usize
				};
				actual.replace_range(offset(&patch["range"]["start"])..offset(&patch["range"]["end"]), patch["newText"].as_str().unwrap());
			}
			if !actual.contains("import net.minecraft.client.Minecraft;") || !actual.contains("import java.util.ArrayList;") || actual.contains("java.io.File") || actual.contains("nonexistent.InvalidType") { return Err(actual); }
			server.did_change(uri.clone(), 4, "package com.example.mod.client;\nclass Probe { Date date; }".into()).await?;
			let choices = server.organize_imports(uri.clone(), vec![]).await?;
			if !choices["groups"].to_string().contains("java.sql.Date") || !choices["groups"].to_string().contains("java.util.Date") { return Err(format!("Missing Date candidates: {choices}")); }
			let selected = server.organize_imports(uri.clone(), vec!["java.util.Date".into()]).await?;
			if !selected["edit"].to_string().contains("import java.util.Date;") { return Err(format!("Missing selected import: {selected}")); }
			Ok(())
		}.await;
		server.stop().await;
		result.unwrap();
	}

	#[tokio::test]
	#[ignore = "requires a local Gradle distribution, JDK and cached Fabric dependencies"]
	async fn generated_project_lists_gradle_tasks() {
		let dir = tempfile::tempdir().unwrap();
		let cfg = base_config(dir.path(), "26.3", DEFAULT_API_26_3);
		let project = create_fabric_project(&cfg).await.unwrap();
		assert_eq!(project.name, cfg.mod_name);
		let wrapper = dir.path().join(if cfg!(windows) {
			"gradlew.bat"
		} else {
			"gradlew"
		});
		let output = std::process::Command::new(wrapper)
			.current_dir(dir.path())
			.args(["tasks", "--offline", "--no-daemon", "--console=plain"])
			.output()
			.unwrap();
		assert!(
			output.status.success(),
			"{}",
			String::from_utf8_lossy(&output.stderr)
		);
		assert!(String::from_utf8_lossy(&output.stdout).contains("runClient"));
	}

	#[test]
	fn publish_rejects_collisions_and_preserves_existing_files_on_retry() {
		let root = tempfile::tempdir().unwrap();
		let stage = tempfile::tempdir().unwrap();
		fs::write(root.path().join(".gitignore"), "mine").unwrap();
		fs::write(root.path().join("notes"), "keep").unwrap();
		fs::write(stage.path().join(".gitignore"), "template").unwrap();
		fs::write(stage.path().join("gradlew"), "wrapper").unwrap();
		assert!(publish_project(stage.path(), root.path()).is_err());
		assert!(!root.path().join("gradlew").exists());
		assert_eq!(fs::read(root.path().join(".gitignore")).unwrap(), b"mine");
		fs::remove_file(stage.path().join(".gitignore")).unwrap();
		publish_project(stage.path(), root.path()).unwrap();
		assert_eq!(fs::read(root.path().join("notes")).unwrap(), b"keep");
	}

	#[test]
	fn migration_checks_preview_and_rolls_back_partial_writes() {
		let root = tempfile::tempdir().unwrap();
		let cfg = base_config(root.path(), "26.3", DEFAULT_API_26_3);
		generate_fabric_project_files(&cfg, None).unwrap();
		let catalog = fallback_fabric_catalog();
		let plan = analyze_version_migration(root.path(), "1.21.11", &catalog).unwrap();
		let props = root.path().join("gradle.properties");
		let modified = format!("{}\n# user edit\n", fs::read_to_string(&props).unwrap());
		fs::write(&props, &modified).unwrap();
		assert!(apply_version_migration(root.path(), "1.21.11", &catalog, &plan.revision).is_err());
		assert_eq!(fs::read_to_string(&props).unwrap(), modified);

		// A second prepared write with the original precondition fails after the first replacement.
		let writes = vec![
			("gradle.properties".into(), modified.clone(), "first".into()),
			(
				"gradle.properties".into(),
				modified.clone(),
				"second".into(),
			),
		];
		assert!(commit_migration(root.path(), &writes).is_err());
		assert_eq!(fs::read_to_string(&props).unwrap(), modified);
	}

	#[test]
	fn detects_modern_unobfuscated_and_java_versions() {
		assert!(is_modern_unobfuscated_mc("26.1"));
		assert!(is_modern_unobfuscated_mc("26.3"));
		assert!(is_modern_unobfuscated_mc("26.4-snapshot-10"));
		assert!(is_modern_unobfuscated_mc("26w03a"));
		assert!(is_modern_unobfuscated_mc("27.0"));
		assert!(!is_modern_unobfuscated_mc("1.21.11"));
		assert!(!is_modern_unobfuscated_mc("1.20.4"));
		assert!(!is_modern_unobfuscated_mc("25w45a"));

		assert_eq!(recommended_java_for_mc("26.3"), 25);
		assert_eq!(recommended_java_for_mc("1.21.11"), 21);
		assert_eq!(recommended_java_for_mc("1.20.5"), 21);
		assert_eq!(recommended_java_for_mc("1.20.4"), 17);
		assert_eq!(recommended_java_for_mc("1.17.1"), 16);
	}

	#[test]
	fn parses_maven_xml_metadata() {
		let loom_xml = r#"<metadata><versioning><versions>
			<version>1.18.1</version>
			<version>1.19.4</version>
			<version>1.20.0-alpha.31</version>
		</versions></versioning></metadata>"#;
		let looms = parse_loom_metadata_xml(loom_xml);
		assert_eq!(looms, vec!["1.20.0-alpha.31", "1.19.4", "1.18.1"]);

		let api_xml = r#"<metadata><versioning><versions>
			<version>0.141.5+1.21.11</version>
			<version>0.141.6+1.21.11</version>
			<version>0.166.2+26.3</version>
		</versions></versioning></metadata>"#;
		let apis = parse_fabric_api_metadata_xml(api_xml);
		assert_eq!(
			apis.get("1.21.11").unwrap(),
			&vec!["0.141.6+1.21.11".to_string(), "0.141.5+1.21.11".to_string()]
		);
		assert_eq!(apis.get("26.3").unwrap(), &vec!["0.166.2+26.3".to_string()]);
	}

	#[test]
	fn generates_modern_26_3_project_and_inspects_and_scans_mixins() {
		let dir = std::env::temp_dir().join(format!("fs_mod_263_{}", Uuid::new_v4()));
		let cfg = base_config(&dir, "26.3", DEFAULT_API_26_3);
		let meta = generate_fabric_project_files(&cfg, None).unwrap();
		assert!(meta.is_modern_unobfuscated);
		assert_eq!(meta.java_version, 25);

		let settings = fs::read_to_string(dir.join("settings.gradle.kts")).unwrap();
		assert!(settings.contains("val loom_version: String by settings"));
		assert!(settings.contains("id(\"net.fabricmc.fabric-loom\") version loom_version"));

		let build = fs::read_to_string(dir.join("build.gradle.kts")).unwrap();
		assert!(build.contains("id(\"net.fabricmc.fabric-loom\")"));
		assert!(!build.contains("fabric-loom-remap"));
		assert!(!build.contains("mappings("));
		assert!(build.contains("implementation(\"net.fabricmc:fabric-loader:"));
		assert!(build.contains("JavaVersion.VERSION_25"));
		assert!(build.contains("options.release.set(25)"));

		let main_java =
			fs::read_to_string(dir.join("src/main/java/com/example/mod/ExampleMod.java")).unwrap();
		assert!(main_java.contains("net.minecraft.resources.Identifier"));
		assert!(main_java.contains("Identifier.fromNamespaceAndPath(MOD_ID, path)"));
		for rel in [
			"settings.gradle.kts",
			"build.gradle.kts",
			"src/main/resources/fabric.mod.json",
			"src/main/resources/example_mod.mixins.json",
			"src/client/resources/example_mod.client.mixins.json",
			"src/main/java/com/example/mod/ExampleMod.java",
			"src/main/java/com/example/mod/mixin/ExampleMixin.java",
			"src/client/java/com/example/mod/client/ExampleModClient.java",
			"src/client/java/com/example/mod/client/mixin/ExampleClientMixin.java",
		] {
			let txt = fs::read_to_string(dir.join(rel)).unwrap();
			assert!(
				!txt.ends_with('\n'),
				"{} should not have trailing newline",
				rel
			);
			assert!(
				!txt.lines().any(|l| l.starts_with(' ')),
				"{} should use tabs only",
				rel
			);
		}

		let icon_bytes =
			fs::read(dir.join("src/main/resources/assets/example_mod/icon.png")).unwrap();
		assert_eq!(
			&icon_bytes[0..8],
			&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
		);
		assert_eq!(
			u32::from_be_bytes([
				icon_bytes[16],
				icon_bytes[17],
				icon_bytes[18],
				icon_bytes[19]
			]),
			16
		);

		let inspected = inspect_fabric_project(&dir).unwrap().unwrap();
		assert_eq!(inspected.mod_id, "example_mod");
		assert_eq!(inspected.mc_version, "26.3");
		assert_eq!(inspected.java_version, 25);
		assert!(inspected.has_client_source_set);
		assert!(inspected.has_mixins);

		let scan = scan_mixins(&dir).unwrap();
		assert_eq!(scan.entries.len(), 2);
		assert!(scan.entries.iter().all(|e| e.issues.is_empty()));
		assert!(scan
			.entries
			.iter()
			.any(|e| e.class_name == "ExampleMixin" && e.target_classes == vec!["MinecraftServer"]));
		assert!(scan
			.entries
			.iter()
			.any(|e| e.class_name == "ExampleClientMixin" && e.target_classes == vec!["Minecraft"]));

		let _ = fs::remove_dir_all(&dir);
	}

	#[test]
	fn generates_legacy_1_21_11_and_migrates_to_26_3() {
		let dir = std::env::temp_dir().join(format!("fs_mod_121_{}", Uuid::new_v4()));
		let mut cfg = base_config(&dir, "1.21.11", DEFAULT_API_1_21_11);
		cfg.use_yarn_mappings = true;
		let meta = generate_fabric_project_files(&cfg, Some(DEFAULT_YARN_1_21_11)).unwrap();
		assert!(!meta.is_modern_unobfuscated);
		assert_eq!(meta.java_version, 21);

		let build = fs::read_to_string(dir.join("build.gradle.kts")).unwrap();
		assert!(build.contains("id(\"net.fabricmc.fabric-loom-remap\")"));
		assert!(build.contains("mappings(\"net.fabricmc:yarn:"));
		assert!(build.contains("modImplementation(\"net.fabricmc:fabric-loader:"));
		assert!(build.contains("JavaVersion.VERSION_21"));

		let catalog = fallback_fabric_catalog();
		let plan = analyze_version_migration(&dir, "26.3", &catalog).unwrap();
		assert_eq!(plan.from_mc, "1.21.11");
		assert_eq!(plan.to_mc, "26.3");
		assert_eq!(plan.target_java, 25);
		assert!(!plan.breaking_notes.is_empty());
		assert!(plan.changes.iter().any(|c| c.file == "gradle.properties"));
		assert!(plan.changes.iter().any(|c| c.file == "build.gradle.kts"));
		assert!(plan
			.changes
			.iter()
			.any(|c| c.file.ends_with("fabric.mod.json")));

		let res = apply_version_migration(
			&dir,
			"26.3",
			&catalog,
			&analyze_version_migration(&dir, "26.3", &catalog)
				.unwrap()
				.revision,
		)
		.unwrap();
		assert!(res.applied_files.contains(&"build.gradle.kts".to_string()));
		assert!(res.applied_files.contains(&"gradle.properties".to_string()));

		let migrated_build = fs::read_to_string(dir.join("build.gradle.kts")).unwrap();
		assert!(migrated_build.contains("id(\"net.fabricmc.fabric-loom\")"));
		assert!(!migrated_build.contains("fabric-loom-remap"));
		assert!(!migrated_build.contains("mappings("));
		assert!(!migrated_build.contains("modImplementation"));
		assert!(migrated_build.contains("implementation(\"net.fabricmc:fabric-loader:"));
		assert!(migrated_build.contains("JavaVersion.VERSION_25"));

		let scan = scan_mixins(&dir).unwrap();
		assert!(scan.entries.iter().all(|e| e.issues.is_empty()));

		let _ = fs::remove_dir_all(&dir);
	}

	#[test]
	fn flags_mixin_issues_on_missing_file_and_wrong_compat() {
		let dir = std::env::temp_dir().join(format!("fs_mixin_err_{}", Uuid::new_v4()));
		let cfg = base_config(&dir, "26.3", DEFAULT_API_26_3);
		generate_fabric_project_files(&cfg, None).unwrap();

		fs::write(
			dir.join("src/main/resources/example_mod.mixins.json"),
			"{\n\t\"required\": true,\n\t\"package\": \"com.example.mod.mixin\",\n\t\"compatibilityLevel\": \"JAVA_17\",\n\t\"mixins\": [\"ExampleMixin\", \"GhostMixin\"]\n}",
		)
		.unwrap();
		let scan = scan_mixins(&dir).unwrap();
		let example = scan
			.entries
			.iter()
			.find(|e| e.class_name == "ExampleMixin")
			.unwrap();
		assert!(example.issues.iter().any(|i| i.contains("JAVA_17")));
		let ghost = scan
			.entries
			.iter()
			.find(|e| e.class_name == "GhostMixin")
			.unwrap();
		assert!(ghost.issues.iter().any(|i| i.contains("not found")));

		let _ = fs::remove_dir_all(&dir);
	}

	#[test]
	fn reads_and_writes_fabric_mod_json_preserving_extra_fields() {
		let dir = std::env::temp_dir().join(format!("fs_modjson_{}", Uuid::new_v4()));
		let cfg = base_config(&dir, "26.3", DEFAULT_API_26_3);
		generate_fabric_project_files(&cfg, None).unwrap();

		let mut meta = read_fabric_mod_json(&dir).unwrap();
		assert_eq!(meta.id, "example_mod");
		meta.description = "Updated description".to_string();
		meta.authors.push("SecondAuthor".to_string());
		write_fabric_mod_json(&dir, &meta).unwrap();

		let reread = read_fabric_mod_json(&dir).unwrap();
		assert_eq!(reread.description, "Updated description");
		assert_eq!(reread.authors, vec!["Developer", "SecondAuthor"]);
		assert!(reread
			.raw_json
			.contains("\"icon\": \"assets/example_mod/icon.png\""));

		let _ = fs::remove_dir_all(&dir);
	}

	#[test]
	fn validates_mod_id_and_package_and_migrates_modern_to_legacy() {
		let dir = std::env::temp_dir().join(format!("fs_rev_mig_{}", Uuid::new_v4()));
		let mut bad = base_config(&dir, "26.3", DEFAULT_API_26_3);
		bad.mod_id = "Invalid-Mod".to_string();
		assert!(validate_create_config(&bad).is_err());
		bad.mod_id = "valid_mod".to_string();
		bad.package_name = "com.example.class.mod".to_string();
		assert!(validate_create_config(&bad).is_err());

		let cfg = base_config(&dir, "26.3", DEFAULT_API_26_3);
		generate_fabric_project_files(&cfg, None).unwrap();

		let cache = std::env::temp_dir().join(format!("fs_wrap_cache_{}", Uuid::new_v4()));
		fs::create_dir_all(&cache).unwrap();
		let mut fake_zip = vec![0x50, 0x4B, 0x03, 0x04];
		fake_zip.resize(2048, 0);
		fs::write(cache.join("gradle-wrapper.jar"), &fake_zip).unwrap();
		fs::write(cache.join("gradlew"), "#!/bin/sh\n").unwrap();
		fs::write(cache.join("gradlew.bat"), "@echo off\r\n").unwrap();
		copy_wrapper_from_cache(&cache, &dir, DEFAULT_GRADLE_VERSION).unwrap();
		assert!(dir
			.join("gradle/wrapper/gradle-wrapper.properties")
			.is_file());
		assert!(dir.join("gradlew.bat").is_file());

		let catalog = fallback_fabric_catalog();
		let res = apply_version_migration(
			&dir,
			"1.21.11",
			&catalog,
			&analyze_version_migration(&dir, "1.21.11", &catalog)
				.unwrap()
				.revision,
		)
		.unwrap();
		assert!(res.applied_files.contains(&"build.gradle.kts".to_string()));
		let downgraded = fs::read_to_string(dir.join("build.gradle.kts")).unwrap();
		assert!(downgraded.contains("id(\"net.fabricmc.fabric-loom-remap\")"));
		assert!(downgraded.contains("mappings(loom.officialMojangMappings())"));
		assert!(downgraded.contains("modImplementation(\"net.fabricmc:fabric-loader:"));
		assert!(downgraded.contains("JavaVersion.VERSION_21"));

		let _ = fs::remove_dir_all(&dir);
		let _ = fs::remove_dir_all(&cache);
	}
}
