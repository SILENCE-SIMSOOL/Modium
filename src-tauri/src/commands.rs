use std::path::{Path, PathBuf};

use serde_json::Value;
use tauri::{AppHandle, State, Window};
use tauri_plugin_opener::OpenerExt;

use crate::debug::DebugManager;
use crate::lsp::LspManager;
use crate::models::{
	AppSettings, CreateProjectConfig, DebugEvaluateResult, DebugScope, DebugSessionInfo,
	DebugStackFrame, DebugThread, DebugVariable, FabricCompatVersions, FabricModMetadata,
	FabricProjectMeta, FabricVersionCatalog, FileNode, GitCommitEntry, GitStatusInfo,
	GradleTaskKind, JdkInfo, LimitedResults, MigrationPlan, MigrationResult, MinecraftClassEntry,
	MixinScanResult, ProcessStatusInfo, ProjectInfo, ResourceCatalog, ResourcePreview, SearchMatch,
	SourceBreakpointGroup, ToolStatus, VerifiedBreakpoint,
};
use crate::process::ProcessRegistry;
use crate::state::AppState;
use crate::{fabric, filesystem, git, gradle, jdk, process, resources, settings, workspace};

fn strip_verbatim_prefix(path: PathBuf) -> PathBuf {
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
	path
}

pub fn require_workspace(state: &AppState) -> Result<PathBuf, String> {
	let guard = state
		.workspace_root
		.read()
		.map_err(|_| "Workspace root lock poisoned".to_string())?;
	guard
		.clone()
		.ok_or_else(|| "No workspace project is currently open".to_string())
}

fn preferred_jdk_from_state(state: &AppState) -> Option<String> {
	state
		.settings
		.read()
		.ok()
		.map(|s| s.preferred_jdk_path.trim().to_string())
		.filter(|s| !s.is_empty())
}

async fn resolve_project_java_home(
	state: &AppState,
	root: &Path,
) -> Result<Option<String>, String> {
	let target_java = fabric::inspect_fabric_project(root)?
		.map(|meta| meta.java_version)
		.filter(|&v| v > 0);
	let preferred = preferred_jdk_from_state(state);
	Ok(jdk::find_best_jdk(preferred.as_deref(), target_java)
		.await
		.map(|info| info.path))
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Result<AppSettings, String> {
	let guard = state
		.settings
		.read()
		.map_err(|_| "Settings lock poisoned".to_string())?;
	Ok(guard.clone())
}

#[tauri::command]
pub fn save_settings(state: State<'_, AppState>, settings: AppSettings) -> Result<(), String> {
	settings::save_settings_file(&settings)?;
	let mut guard = state
		.settings
		.write()
		.map_err(|_| "Settings lock poisoned".to_string())?;
	*guard = settings;
	Ok(())
}

#[tauri::command]
pub async fn list_jdks() -> Result<Vec<JdkInfo>, String> {
	Ok(jdk::list_jdks().await)
}

#[tauri::command]
pub fn window_minimize(window: Window) -> Result<(), String> {
	window.minimize().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn window_toggle_maximize(window: Window) -> Result<(), String> {
	let maximized = window.is_maximized().map_err(|e| e.to_string())?;
	if maximized {
		window.unmaximize().map_err(|e| e.to_string())
	} else {
		window.maximize().map_err(|e| e.to_string())
	}
}

#[tauri::command]
pub fn window_close(window: Window) -> Result<(), String> {
	window.close().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn reveal_in_explorer(
	app: AppHandle,
	state: State<'_, AppState>,
	rel_path: String,
) -> Result<(), String> {
	let root = require_workspace(&state)?;
	let resolved = filesystem::resolve_workspace_path(&root, &rel_path)?;
	let abs_path = strip_verbatim_prefix(resolved);
	app.opener()
		.reveal_item_in_dir(abs_path)
		.map_err(|e| format!("Failed to reveal item in explorer: {e}"))
}

#[tauri::command]
pub async fn open_project(
	app: AppHandle,
	state: State<'_, AppState>,
	lsp: State<'_, LspManager>,
	debug: State<'_, DebugManager>,
	processes: State<'_, ProcessRegistry>,
	path: String,
) -> Result<ProjectInfo, String> {
	let trimmed = path.trim();
	if trimmed.is_empty() {
		return Err("Project path cannot be empty".to_string());
	}
	let raw_dir = PathBuf::from(trimmed);
	if !raw_dir.is_dir() {
		return Err(format!(
			"Project directory does not exist: {}",
			raw_dir.display()
		));
	}
	let canon_dir = strip_verbatim_prefix(std::fs::canonicalize(&raw_dir).map_err(|e| {
		format!(
			"Failed to open project directory '{}': {e}",
			raw_dir.display()
		)
	})?);
	let fabric_meta = fabric::inspect_fabric_project(&canon_dir)?;
	workspace::update_watcher(&state, &app, canon_dir.clone())?;
	let _ = debug.stop().await;
	lsp.stop().await;
	process::kill_all_processes(&processes).await;
	*state
		.workspace_root
		.write()
		.map_err(|_| "Workspace root lock poisoned")? = Some(canon_dir.clone());
	let fallback_name = canon_dir
		.file_name()
		.and_then(|n| n.to_str())
		.unwrap_or("Project")
		.to_string();
	let name = fabric_meta
		.as_ref()
		.map(|meta| meta.mod_name.trim().to_string())
		.filter(|s| !s.is_empty())
		.unwrap_or(fallback_name);
	let mc_version = fabric_meta
		.as_ref()
		.map(|meta| meta.mc_version.clone())
		.unwrap_or_default();
	let path_str = canon_dir.to_string_lossy().to_string();
	let snapshot = {
		let mut guard = state
			.settings
			.write()
			.map_err(|_| "Settings lock poisoned".to_string())?;
		settings::record_recent_project(&mut guard, &name, &path_str, &mc_version);
		guard.clone()
	};
	if let Err(err) = settings::save_settings_file(&snapshot) {
		eprintln!("{err}");
	}
	Ok(ProjectInfo {
		name,
		path: path_str,
		is_fabric: fabric_meta.is_some(),
		fabric_meta,
	})
}

#[tauri::command]
pub async fn close_project(
	processes: State<'_, ProcessRegistry>,
	state: State<'_, AppState>,
	lsp: State<'_, LspManager>,
	debug: State<'_, DebugManager>,
) -> Result<(), String> {
	let _ = debug.stop().await;
	lsp.stop().await;
	process::kill_all_processes(&processes).await;
	workspace::stop_watcher(&state);
	{
		let mut guard = state
			.workspace_root
			.write()
			.map_err(|_| "Workspace root lock poisoned".to_string())?;
		*guard = None;
	}
	let snapshot = {
		let mut guard = state
			.settings
			.write()
			.map_err(|_| "Settings lock poisoned".to_string())?;
		guard.last_project = None;
		guard.clone()
	};
	if let Err(err) = settings::save_settings_file(&snapshot) {
		eprintln!("{err}");
	}
	Ok(())
}

#[tauri::command]
pub fn list_directory(
	state: State<'_, AppState>,
	rel_path: Option<String>,
	show_hidden: Option<bool>,
) -> Result<Vec<FileNode>, String> {
	let root = require_workspace(&state)?;
	filesystem::list_directory(&root, rel_path.as_deref(), show_hidden.unwrap_or(false))
}

#[tauri::command]
pub fn list_all_files(
	state: State<'_, AppState>,
	query: Option<String>,
) -> Result<LimitedResults<String>, String> {
	let root = require_workspace(&state)?;
	filesystem::list_all_files(&root, query.as_deref().unwrap_or(""))
}

#[tauri::command]
pub fn read_file(state: State<'_, AppState>, rel_path: String) -> Result<String, String> {
	let root = require_workspace(&state)?;
	filesystem::read_file(&root, &rel_path)
}

#[tauri::command]
pub fn write_file(
	state: State<'_, AppState>,
	rel_path: String,
	content: String,
) -> Result<(), String> {
	let root = require_workspace(&state)?;
	filesystem::write_file(&root, &rel_path, &content)
}

#[tauri::command]
pub fn disk_content(state: State<'_, AppState>, rel_path: String) -> Result<Option<String>, String> {
	filesystem::disk_content(&require_workspace(&state)?, &rel_path)
}

#[tauri::command]
pub fn save_checked(state: State<'_, AppState>, rel_path: String, expected: Option<String>, content: String) -> Result<Value, String> {
	filesystem::save_checked(&require_workspace(&state)?, &rel_path, expected.as_deref(), &content)
}

#[tauri::command]
pub fn create_file(
	state: State<'_, AppState>,
	rel_path: String,
	content: Option<String>,
) -> Result<(), String> {
	let root = require_workspace(&state)?;
	filesystem::create_file(&root, &rel_path)?;
	if let Some(text) = content {
		if !text.is_empty() {
			filesystem::write_file(&root, &rel_path, &text)?;
		}
	}
	Ok(())
}

#[tauri::command]
pub fn create_dir(state: State<'_, AppState>, rel_path: String) -> Result<(), String> {
	let root = require_workspace(&state)?;
	filesystem::create_dir(&root, &rel_path)
}

#[tauri::command]
pub fn rename_path(
	state: State<'_, AppState>,
	old_rel_path: String,
	new_rel_path: String,
) -> Result<(), String> {
	let root = require_workspace(&state)?;
	filesystem::rename_path(&root, &old_rel_path, &new_rel_path)
}

#[tauri::command]
pub fn delete_path(state: State<'_, AppState>, rel_path: String) -> Result<(), String> {
	let root = require_workspace(&state)?;
	filesystem::delete_path(&root, &rel_path)
}

#[tauri::command]
pub fn search_in_workspace(
	state: State<'_, AppState>,
	query: String,
	case_sensitive: Option<bool>,
	use_regex: Option<bool>,
) -> Result<LimitedResults<SearchMatch>, String> {
	let root = require_workspace(&state)?;
	filesystem::search_in_workspace(
		&root,
		&query,
		case_sensitive.unwrap_or(false),
		use_regex.unwrap_or(false),
	)
}

#[tauri::command]
pub async fn fetch_fabric_versions(
	state: State<'_, AppState>,
	force_refresh: Option<bool>,
) -> Result<FabricVersionCatalog, String> {
	fabric::fetch_fabric_versions(&state, force_refresh.unwrap_or(false)).await
}

#[tauri::command]
pub async fn resolve_fabric_compat(
	state: State<'_, AppState>,
	mc_version: String,
) -> Result<FabricCompatVersions, String> {
	let catalog = fabric::fetch_fabric_versions(&state, false).await?;
	Ok(fabric::resolve_fabric_compat(&mc_version, &catalog).await)
}

#[tauri::command]
pub async fn create_fabric_project(config: CreateProjectConfig) -> Result<ProjectInfo, String> {
	fabric::create_fabric_project(&config).await
}

#[tauri::command]
pub fn inspect_fabric_project(
	state: State<'_, AppState>,
) -> Result<Option<FabricProjectMeta>, String> {
	let root = require_workspace(&state)?;
	fabric::inspect_fabric_project(&root)
}

#[tauri::command]
pub fn read_fabric_mod_json(state: State<'_, AppState>) -> Result<FabricModMetadata, String> {
	let root = require_workspace(&state)?;
	fabric::read_fabric_mod_json(&root)
}

#[tauri::command]
pub fn write_fabric_mod_json(
	state: State<'_, AppState>,
	metadata: FabricModMetadata,
) -> Result<(), String> {
	let root = require_workspace(&state)?;
	fabric::write_fabric_mod_json(&root, &metadata)
}

#[tauri::command]
pub fn scan_mixins(state: State<'_, AppState>) -> Result<MixinScanResult, String> {
	let root = require_workspace(&state)?;
	fabric::scan_mixins(&root)
}

#[tauri::command]
pub async fn analyze_version_migration(
	state: State<'_, AppState>,
	target_mc: String,
) -> Result<MigrationPlan, String> {
	let root = require_workspace(&state)?;
	let catalog = fabric::fetch_fabric_versions(&state, false).await?;
	fabric::analyze_version_migration(&root, &target_mc, &catalog)
}

#[tauri::command]
pub async fn apply_version_migration(
	revision: String,
	state: State<'_, AppState>,
	target_mc: String,
) -> Result<MigrationResult, String> {
	let root = require_workspace(&state)?;
	let catalog = fabric::fetch_fabric_versions(&state, false).await?;
	fabric::apply_version_migration(&root, &target_mc, &catalog, &revision)
}

#[tauri::command]
pub fn scan_resources(state: State<'_, AppState>) -> Result<ResourceCatalog, String> {
	let root = require_workspace(&state)?;
	resources::scan_resources(&root)
}

#[tauri::command]
pub fn read_resource_preview(
	state: State<'_, AppState>,
	rel_path: String,
) -> Result<ResourcePreview, String> {
	let root = require_workspace(&state)?;
	resources::read_resource_preview(&root, &rel_path)
}

#[tauri::command]
pub async fn run_gradle_task(
	app: AppHandle,
	state: State<'_, AppState>,
	processes: State<'_, ProcessRegistry>,
	task: GradleTaskKind,
) -> Result<ProcessStatusInfo, String> {
	let root = require_workspace(&state)?;
	let java_home = resolve_project_java_home(&state, &root).await?;
	gradle::run_gradle_task(Some(app), &processes, &root, task, java_home.as_deref()).await
}

#[tauri::command]
pub async fn stop_process(
	processes: State<'_, ProcessRegistry>,
	process_id: String,
) -> Result<(), String> {
	process::stop_process(&processes, &process_id).await
}

#[tauri::command]
pub async fn get_running_processes(
	processes: State<'_, ProcessRegistry>,
) -> Result<Vec<ProcessStatusInfo>, String> {
	Ok(process::get_running_processes(&processes).await)
}

#[tauri::command]
pub async fn terminal_start(
	app: AppHandle,
	state: State<'_, AppState>,
	processes: State<'_, ProcessRegistry>,
	session_id: Option<String>,
) -> Result<String, String> {
	let root = require_workspace(&state)?;
	process::terminal_start(Some(app), &processes, &root, session_id.as_deref()).await
}

#[tauri::command]
pub async fn terminal_write(
	processes: State<'_, ProcessRegistry>,
	session_id: String,
	input: String,
) -> Result<(), String> {
	process::terminal_write(&processes, &session_id, &input).await
}

#[tauri::command]
pub async fn terminal_stop(
	processes: State<'_, ProcessRegistry>,
	session_id: String,
) -> Result<(), String> {
	process::terminal_stop(&processes, &session_id).await
}

#[tauri::command]
pub fn get_tool_status() -> ToolStatus {
	LspManager::get_tool_status()
}

#[tauri::command]
pub async fn ensure_jdtls_installed(app: AppHandle) -> Result<ToolStatus, String> {
	LspManager::ensure_jdtls_installed(Some(&app)).await
}

#[tauri::command]
pub async fn start_language_server(
	app: AppHandle,
	state: State<'_, AppState>,
	lsp: State<'_, LspManager>,
) -> Result<(), String> {
	let root = require_workspace(&state)?;
	let preferred = preferred_jdk_from_state(&state);
	LspManager::ensure_jdtls_installed(Some(&app)).await?;
	let minimum = crate::lsp::runtime_java_minimum();
	let runtime_jdk = match jdk::find_best_jdk(preferred.as_deref(), Some(minimum)).await {
		Some(info) if info.major >= minimum => Some(info),
		_ => jdk::find_best_jdk(None, Some(minimum)).await.filter(|info| info.major >= minimum),
	}.ok_or_else(|| format!("The installed Eclipse Java language server requires JDK {minimum} or newer."))?;
	let project_java_home = resolve_project_java_home(&state, &root)
		.await?
		.map(PathBuf::from);
	lsp.start_language_server(
		Some(app),
		root,
		PathBuf::from(runtime_jdk.path),
		project_java_home,
	)
	.await
}

#[tauri::command]
pub async fn stop_language_server(lsp: State<'_, LspManager>) -> Result<(), String> {
	lsp.stop().await;
	Ok(())
}

#[tauri::command]
pub async fn lsp_did_open(
	lsp: State<'_, LspManager>,
	uri: String,
	language_id: String,
	version: i32,
	text: String,
) -> Result<(), String> {
	lsp.did_open(uri, language_id, version, text).await
}

#[tauri::command]
pub async fn lsp_did_change(
	lsp: State<'_, LspManager>,
	uri: String,
	version: i32,
	text: String,
) -> Result<(), String> {
	lsp.did_change(uri, version, text).await
}

#[tauri::command]
pub async fn lsp_did_save(
	lsp: State<'_, LspManager>,
	uri: String,
	text: Option<String>,
) -> Result<(), String> {
	lsp.did_save(uri, text).await
}

#[tauri::command]
pub async fn lsp_did_close(lsp: State<'_, LspManager>, uri: String) -> Result<(), String> {
	lsp.did_close(uri).await
}

#[tauri::command]
pub async fn lsp_completion(
	lsp: State<'_, LspManager>,
	uri: String,
	line: u32,
	character: u32,
) -> Result<Value, String> {
	lsp.completion(uri, line, character).await
}

#[tauri::command]
pub async fn lsp_resolve_completion(lsp: State<'_, LspManager>, item: Value) -> Result<Value, String> {
	lsp.resolve_completion(item).await
}

#[tauri::command]
pub async fn lsp_organize_imports(lsp: State<'_, LspManager>, uri: String, selected: Vec<String>) -> Result<Value, String> {
	lsp.organize_imports(uri, selected).await
}

#[tauri::command]
pub async fn lsp_semantic_tokens(lsp: State<'_, LspManager>, uri: String) -> Result<Value, String> {
	lsp.semantic_tokens(uri).await
}

#[tauri::command]
pub async fn lsp_search_types(lsp: State<'_, LspManager>, query: String) -> Result<Value, String> {
	lsp.search_types(query).await
}

#[tauri::command]
pub async fn lsp_hover(
	lsp: State<'_, LspManager>,
	uri: String,
	line: u32,
	character: u32,
) -> Result<Value, String> {
	lsp.hover(uri, line, character).await
}

#[tauri::command]
pub async fn lsp_definition(
	lsp: State<'_, LspManager>,
	uri: String,
	line: u32,
	character: u32,
) -> Result<Value, String> {
	lsp.definition(uri, line, character).await
}

#[tauri::command]
pub async fn lsp_references(
	lsp: State<'_, LspManager>,
	uri: String,
	line: u32,
	character: u32,
	include_declaration: Option<bool>,
) -> Result<Value, String> {
	lsp.references(uri, line, character, include_declaration.unwrap_or(true))
		.await
}

#[tauri::command]
pub async fn lsp_rename(
	lsp: State<'_, LspManager>,
	uri: String,
	line: u32,
	character: u32,
	new_name: String,
) -> Result<Value, String> {
	lsp.rename(uri, line, character, new_name).await
}

#[tauri::command]
pub async fn lsp_code_action(
	lsp: State<'_, LspManager>,
	uri: String,
	start_line: u32,
	start_char: u32,
	end_line: u32,
	end_char: u32,
	diagnostics: Option<Vec<Value>>,
) -> Result<Value, String> {
	lsp.code_action(uri, start_line, start_char, end_line, end_char, diagnostics)
		.await
}

#[tauri::command]
pub async fn lsp_formatting(
	lsp: State<'_, LspManager>,
	uri: String,
	tab_size: u32,
	insert_spaces: bool,
) -> Result<Value, String> {
	lsp.formatting(uri, tab_size, insert_spaces).await
}

#[tauri::command]
pub async fn lsp_class_file_contents(
	lsp: State<'_, LspManager>,
	uri: String,
) -> Result<String, String> {
	lsp.class_file_contents(uri).await
}

#[tauri::command]
pub async fn search_minecraft_sources(
	state: State<'_, AppState>,
	query: String,
) -> Result<Vec<MinecraftClassEntry>, String> {
	let root = require_workspace(&state)?;
	crate::lsp::search_minecraft_sources(root, query).await
}

#[tauri::command]
pub async fn read_minecraft_source(
	source_jar: String,
	entry_path: String,
) -> Result<String, String> {
	crate::lsp::read_minecraft_source(source_jar, entry_path).await
}

#[tauri::command]
pub async fn start_debug_client(
	app: AppHandle,
	state: State<'_, AppState>,
	lsp: State<'_, LspManager>,
	debug: State<'_, DebugManager>,
	breakpoints: Vec<SourceBreakpointGroup>,
) -> Result<DebugSessionInfo, String> {
	let root = require_workspace(&state)?;
	let project_java_home = resolve_project_java_home(&state, &root)
		.await?
		.map(PathBuf::from);
	debug
		.start_debug_client(Some(app), &lsp, root, project_java_home, breakpoints)
		.await
}

#[tauri::command]
pub async fn stop_debug_session(debug: State<'_, DebugManager>) -> Result<(), String> {
	debug.stop().await
}

#[tauri::command]
pub async fn debug_set_breakpoints(
	debug: State<'_, DebugManager>,
	file_path: String,
	lines: Vec<u32>,
) -> Result<Vec<VerifiedBreakpoint>, String> {
	debug.set_breakpoints(file_path, lines).await
}

#[tauri::command]
pub async fn debug_continue(
	debug: State<'_, DebugManager>,
	thread_id: Option<i64>,
) -> Result<(), String> {
	debug.continue_exec(thread_id).await
}

#[tauri::command]
pub async fn debug_pause(
	debug: State<'_, DebugManager>,
	thread_id: Option<i64>,
) -> Result<(), String> {
	debug.pause_exec(thread_id).await
}

#[tauri::command]
pub async fn debug_step_over(debug: State<'_, DebugManager>, thread_id: i64) -> Result<(), String> {
	debug.step_over(thread_id).await
}

#[tauri::command]
pub async fn debug_step_into(debug: State<'_, DebugManager>, thread_id: i64) -> Result<(), String> {
	debug.step_into(thread_id).await
}

#[tauri::command]
pub async fn debug_step_out(debug: State<'_, DebugManager>, thread_id: i64) -> Result<(), String> {
	debug.step_out(thread_id).await
}

#[tauri::command]
pub async fn debug_threads(debug: State<'_, DebugManager>) -> Result<Vec<DebugThread>, String> {
	debug.threads().await
}

#[tauri::command]
pub async fn debug_stack_trace(
	debug: State<'_, DebugManager>,
	thread_id: i64,
) -> Result<Vec<DebugStackFrame>, String> {
	debug.stack_trace(thread_id).await
}

#[tauri::command]
pub async fn debug_scopes(
	debug: State<'_, DebugManager>,
	frame_id: i64,
) -> Result<Vec<DebugScope>, String> {
	debug.scopes(frame_id).await
}

#[tauri::command]
pub async fn debug_variables(
	debug: State<'_, DebugManager>,
	variables_reference: i64,
) -> Result<Vec<DebugVariable>, String> {
	debug.variables(variables_reference).await
}

#[tauri::command]
pub async fn debug_evaluate(
	debug: State<'_, DebugManager>,
	expression: String,
	frame_id: Option<i64>,
) -> Result<DebugEvaluateResult, String> {
	debug.evaluate(expression, frame_id, None).await
}

#[tauri::command]
pub async fn git_status(state: State<'_, AppState>) -> Result<GitStatusInfo, String> {
	let root = require_workspace(&state)?;
	git::git_status(&root).await
}

#[tauri::command]
pub async fn git_diff(
	state: State<'_, AppState>,
	rel_path: String,
	staged: Option<bool>,
) -> Result<String, String> {
	let root = require_workspace(&state)?;
	git::git_diff(&root, &rel_path, staged.unwrap_or(false)).await
}

#[tauri::command]
pub async fn git_stage(state: State<'_, AppState>, rel_paths: Vec<String>) -> Result<(), String> {
	let root = require_workspace(&state)?;
	git::git_stage(&root, &rel_paths).await
}

#[tauri::command]
pub async fn git_unstage(state: State<'_, AppState>, rel_paths: Vec<String>) -> Result<(), String> {
	let root = require_workspace(&state)?;
	git::git_unstage(&root, &rel_paths).await
}

#[tauri::command]
pub async fn git_commit(state: State<'_, AppState>, message: String) -> Result<String, String> {
	let root = require_workspace(&state)?;
	git::git_commit(&root, &message).await
}

#[tauri::command]
pub async fn git_init(state: State<'_, AppState>) -> Result<(), String> {
	let root = require_workspace(&state)?;
	git::git_init(&root).await
}

#[tauri::command]
pub async fn git_log(
	state: State<'_, AppState>,
	limit: Option<u32>,
) -> Result<Vec<GitCommitEntry>, String> {
	let root = require_workspace(&state)?;
	git::git_log(&root, limit.unwrap_or(20)).await
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn require_workspace_errors_when_unopened_and_returns_path_when_set() {
		let state = AppState::default();
		assert!(require_workspace(&state).is_err());
		let expected = PathBuf::from(r"D:\Mods\TestMod");
		{
			let mut guard = state.workspace_root.write().unwrap();
			*guard = Some(expected.clone());
		}
		assert_eq!(require_workspace(&state).unwrap(), expected);
	}

	#[test]
	fn strips_windows_verbatim_prefix_cleanly() {
		#[cfg(windows)]
		{
			assert_eq!(
				strip_verbatim_prefix(PathBuf::from(r"\\?\D:\Mods\Fabric")),
				PathBuf::from(r"D:\Mods\Fabric")
			);
			assert_eq!(
				strip_verbatim_prefix(PathBuf::from(r"\\?\UNC\server\share\mod")),
				PathBuf::from(r"\\server\share\mod")
			);
		}
		assert_eq!(
			strip_verbatim_prefix(PathBuf::from("relative/path")),
			PathBuf::from("relative/path")
		);
	}
}
