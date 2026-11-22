use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum AppLanguage {
	#[default]
	Ko,
	En,
	Zh,
	Ja,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum AppTheme {
	System,
	#[default]
	Dark,
	Light,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
	pub name: String,
	pub path: String,
	pub mc_version: String,
	pub last_opened: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
	pub language: AppLanguage,
	pub theme: AppTheme,
	pub font_size: u32,
	pub tab_size: u32,
	pub auto_save: bool,
	pub auto_save_delay_ms: u64,
	pub preferred_jdk_path: String,
	pub recent_projects: Vec<RecentProject>,
	pub last_project: Option<String>,
}

impl Default for AppSettings {
	fn default() -> Self {
		Self {
			language: AppLanguage::Ko,
			theme: AppTheme::Dark,
			font_size: 14,
			tab_size: 4,
			auto_save: true,
			auto_save_delay_ms: 1000,
			preferred_jdk_path: String::new(),
			recent_projects: Vec::new(),
			last_project: None,
		}
	}
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JdkInfo {
	pub path: String,
	pub version: String,
	pub major: u32,
	pub vendor: String,
	pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileNode {
	pub name: String,
	pub rel_path: String,
	pub is_dir: bool,
	pub size: u64,
	pub children: Option<Vec<FileNode>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FabricProjectMeta {
	pub mod_id: String,
	pub mod_name: String,
	pub version: String,
	pub mc_version: String,
	pub loader_version: String,
	pub loom_version: String,
	pub fabric_api_version: String,
	pub java_version: u32,
	pub is_modern_unobfuscated: bool,
	pub has_client_source_set: bool,
	pub has_mixins: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
	pub name: String,
	pub path: String,
	pub is_fabric: bool,
	pub fabric_meta: Option<FabricProjectMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitedResults<T> {
	pub items: Vec<T>,
	pub truncated: bool,
}

impl<T> LimitedResults<T> {
	pub fn new(mut items: Vec<T>, limit: usize) -> Self {
		let truncated = items.len() > limit;
		items.truncate(limit);
		Self { items, truncated }
	}
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
	pub end_column: u32,
	pub preview_column: u32,
	pub rel_path: String,
	pub line: u32,
	pub column: u32,
	pub line_text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McVersionEntry {
	pub version: String,
	pub stable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoaderVersionEntry {
	pub version: String,
	pub stable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FabricVersionCatalog {
	pub game_versions: Vec<McVersionEntry>,
	pub loader_versions: Vec<LoaderVersionEntry>,
	pub loom_versions: Vec<String>,
	pub api_by_mc: HashMap<String, Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FabricCompatVersions {
	pub mc_version: String,
	pub loader_version: String,
	pub loom_version: String,
	pub fabric_api_version: String,
	pub recommended_java: u32,
	pub gradle_version: String,
	pub is_modern_unobfuscated: bool,
	pub yarn_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectConfig {
	pub project_dir: String,
	pub mod_name: String,
	pub mod_id: String,
	pub package_name: String,
	pub mc_version: String,
	pub loader_version: String,
	pub loom_version: String,
	pub fabric_api_version: String,
	pub jdk_path: Option<String>,
	pub generate_client_entrypoint: bool,
	pub enable_mixin: bool,
	pub use_yarn_mappings: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FabricModMetadata {
	pub schema_version: u32,
	pub id: String,
	pub version: String,
	pub name: String,
	pub description: String,
	pub authors: Vec<String>,
	pub license: String,
	pub environment: String,
	pub entrypoints: HashMap<String, Vec<String>>,
	pub mixins: Vec<serde_json::Value>,
	pub depends: HashMap<String, String>,
	pub raw_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MixinTargetMethod {
	pub name: String,
	pub annotation: String,
	pub line: u32,
	pub target_method: String,
	pub at_value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MixinEntry {
	pub config_file: String,
	pub environment: String,
	pub package_name: String,
	pub class_name: String,
	pub rel_path: String,
	pub target_classes: Vec<String>,
	pub methods: Vec<MixinTargetMethod>,
	pub issues: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MixinScanResult {
	pub entries: Vec<MixinEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationChange {
	pub file: String,
	pub description: String,
	pub before: String,
	pub after: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationPlan {
	pub revision: String,
	pub from_mc: String,
	pub to_mc: String,
	pub target_loader: String,
	pub target_loom: String,
	pub target_api: String,
	pub target_java: u32,
	pub breaking_notes: Vec<String>,
	pub changes: Vec<MigrationChange>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationResult {
	pub applied_files: Vec<String>,
	pub notes: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum ResourceKind {
	Texture,
	Model,
	Blockstate,
	Lang,
	Sound,
	#[default]
	Other,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceEntry {
	pub rel_path: String,
	pub kind: ResourceKind,
	pub namespace: String,
	pub name: String,
	pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceCatalog {
	pub entries: Vec<ResourceEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourcePreview {
	pub rel_path: String,
	pub kind: ResourceKind,
	pub mime_type: Option<String>,
	pub base64_data: Option<String>,
	pub text_content: Option<String>,
	pub width: Option<u32>,
	pub height: Option<u32>,
	pub valid_json: Option<bool>,
	pub json_error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GradleTaskKind {
	Build,
	RunClient,
	RunServer,
	Clean,
	GenSources,
	Eclipse,
	RefreshDependencies,
	CompileJava,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum ProcessLifecycle {
	#[default]
	Idle,
	Starting,
	Running,
	Completed,
	Failed,
	Stopping,
	Stopped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum ProblemSeverity {
	#[default]
	Error,
	Warning,
	Info,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildProblem {
	pub severity: ProblemSeverity,
	pub file_path: String,
	pub rel_path: Option<String>,
	pub line: u32,
	pub column: Option<u32>,
	pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessStatusInfo {
	pub process_id: String,
	pub kind: String,
	pub state: ProcessLifecycle,
	pub pid: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GradleOutputEvent {
	pub process_id: String,
	pub task: GradleTaskKind,
	pub stream: String,
	pub line: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GradleStateEvent {
	pub process_id: String,
	pub task: GradleTaskKind,
	pub state: ProcessLifecycle,
	pub exit_code: Option<i32>,
	pub problems: Vec<BuildProblem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
	pub jdtls_installed: bool,
	pub jdtls_path: Option<String>,
	pub java_debug_installed: bool,
	pub java_debug_path: Option<String>,
	pub tools_root: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolsProgressEvent {
	pub tool: String,
	pub step: u32,
	pub total_steps: u32,
	pub percent: u32,
	pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspStatusEvent {
	pub state: String,
	pub message: String,
	pub percent: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspDiagnostic {
	pub range_start_line: u32,
	pub range_start_char: u32,
	pub range_end_line: u32,
	pub range_end_char: u32,
	pub severity: u32,
	pub code: Option<String>,
	pub source: Option<String>,
	pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspDiagnosticsEvent {
	pub uri: String,
	pub diagnostics: Vec<LspDiagnostic>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MinecraftClassEntry {
	pub class_name: String,
	pub package_name: String,
	pub source_jar: String,
	pub source_scope: String,
	pub entry_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceBreakpointGroup {
	pub file_path: String,
	pub lines: Vec<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedBreakpoint {
	pub id: Option<i64>,
	pub verified: bool,
	pub line: u32,
	pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugSessionInfo {
	pub session_id: String,
	pub jdwp_port: u16,
	pub dap_port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugThread {
	pub id: i64,
	pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugStackFrame {
	pub id: i64,
	pub name: String,
	pub source_path: Option<String>,
	pub line: u32,
	pub column: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugScope {
	pub name: String,
	pub variables_reference: i64,
	pub expensive: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugVariable {
	pub name: String,
	pub value: String,
	pub var_type: Option<String>,
	pub variables_reference: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugEvaluateResult {
	pub result: String,
	pub var_type: Option<String>,
	pub variables_reference: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugEventPayload {
	pub workspace: String,
	pub kind: String,
	pub thread_id: Option<i64>,
	pub reason: Option<String>,
	pub file_path: Option<String>,
	pub line: Option<u32>,
	pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileChange {
	pub rel_path: String,
	pub index_status: String,
	pub worktree_status: String,
	pub staged: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusInfo {
	pub is_repo: bool,
	pub branch: Option<String>,
	pub ahead: u32,
	pub behind: u32,
	pub changes: Vec<GitFileChange>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitEntry {
	pub hash: String,
	pub short_hash: String,
	pub author: String,
	pub date: String,
	pub message: String,
}

// Link Tauri's compiled Windows resource (ComCtl32 v6 manifest) into `--lib` unit test binaries only.
#[cfg(all(test, windows))]
#[link(name = "resource")]
extern "C" {}
