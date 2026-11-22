use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::{Manager, RunEvent, WindowEvent};

pub mod commands;
pub mod debug;
pub mod fabric;
pub mod filesystem;
pub mod git;
pub mod gradle;
pub mod jdk;
pub mod lsp;
pub mod models;
pub mod process;
pub mod resources;
pub mod settings;
pub mod state;
pub mod workspace;

fn cleanup_background_resources(app_handle: &tauri::AppHandle, cleaned_up: &AtomicBool) {
	if cleaned_up.swap(true, Ordering::SeqCst) {
		return;
	}
	let state = app_handle.state::<state::AppState>();
	workspace::stop_watcher(&state);

	let debug = app_handle.state::<debug::DebugManager>();
	let lsp = app_handle.state::<lsp::LspManager>();
	let processes = app_handle.state::<process::ProcessRegistry>();

	tauri::async_runtime::block_on(async {
		let _ = tokio::time::timeout(Duration::from_secs(4), async {
			tokio::join!(
				debug.stop(),
				lsp.stop(),
				process::kill_all_processes(&processes),
			)
		})
		.await;
	});
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
	let cleaned_up = Arc::new(AtomicBool::new(false));
	let app = tauri::Builder::default()
		.plugin(tauri_plugin_dialog::init())
		.plugin(tauri_plugin_opener::init())
		.manage(state::AppState::new(settings::load_settings()))
		.manage(process::ProcessRegistry::new())
		.manage(lsp::LspManager::new())
		.manage(debug::DebugManager::new())
		.invoke_handler(tauri::generate_handler![
			commands::get_settings,
			commands::save_settings,
			commands::list_jdks,
			commands::window_minimize,
			commands::window_toggle_maximize,
			commands::window_close,
			commands::reveal_in_explorer,
			commands::open_project,
			commands::close_project,
			commands::list_directory,
			commands::list_all_files,
			commands::read_file,
			commands::write_file,
			commands::disk_content,
			commands::save_checked,
			commands::create_file,
			commands::create_dir,
			commands::rename_path,
			commands::delete_path,
			commands::search_in_workspace,
			commands::fetch_fabric_versions,
			commands::resolve_fabric_compat,
			commands::create_fabric_project,
			commands::inspect_fabric_project,
			commands::read_fabric_mod_json,
			commands::write_fabric_mod_json,
			commands::scan_mixins,
			commands::analyze_version_migration,
			commands::apply_version_migration,
			commands::scan_resources,
			commands::read_resource_preview,
			commands::run_gradle_task,
			commands::stop_process,
			commands::get_running_processes,
			commands::terminal_start,
			commands::terminal_write,
			commands::terminal_stop,
			commands::get_tool_status,
			commands::ensure_jdtls_installed,
			commands::start_language_server,
			commands::stop_language_server,
			commands::lsp_did_open,
			commands::lsp_did_change,
			commands::lsp_did_save,
			commands::lsp_did_close,
			commands::lsp_completion,
			commands::lsp_resolve_completion,
			commands::lsp_organize_imports,
			commands::lsp_hover,
			commands::lsp_search_types,
			commands::lsp_semantic_tokens,
			commands::lsp_definition,
			commands::lsp_references,
			commands::lsp_rename,
			commands::lsp_code_action,
			commands::lsp_formatting,
			commands::lsp_class_file_contents,
			commands::search_minecraft_sources,
			commands::read_minecraft_source,
			commands::start_debug_client,
			commands::stop_debug_session,
			commands::debug_set_breakpoints,
			commands::debug_continue,
			commands::debug_pause,
			commands::debug_step_over,
			commands::debug_step_into,
			commands::debug_step_out,
			commands::debug_threads,
			commands::debug_stack_trace,
			commands::debug_scopes,
			commands::debug_variables,
			commands::debug_evaluate,
			commands::git_status,
			commands::git_diff,
			commands::git_stage,
			commands::git_unstage,
			commands::git_commit,
			commands::git_init,
			commands::git_log,
		])
		.build(tauri::generate_context!())
		.expect("error while building tauri application");

	app.run(move |app_handle, event| match event {
		RunEvent::WindowEvent {
			label,
			event: WindowEvent::Destroyed,
			..
		} if label == "main" => {
			cleanup_background_resources(app_handle, &cleaned_up);
		}
		RunEvent::ExitRequested { .. } | RunEvent::Exit => {
			cleanup_background_resources(app_handle, &cleaned_up);
		}
		_ => {}
	});
}