import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import type {
	AppSettings,
	CreateProjectConfig,
	DebugEvaluateResult,
	DebugEventPayload,
	DebugScope,
	DebugSessionInfo,
	DebugStackFrame,
	DebugThread,
	DebugVariable,
	FabricCompatVersions,
	FabricModMetadata,
	FabricProjectMeta,
	FabricVersionCatalog,
	FileNode,
	GitCommitEntry,
	GitStatusInfo,
	GradleOutputEvent,
	GradleStateEvent,
	GradleTaskKind,
	JdkInfo,
	LspDiagnostic,
	LspDiagnosticsEvent,
	LspStatusEvent,
	MigrationPlan,
	LimitedResults,
	MigrationResult,
	MinecraftClassEntry,
	MixinScanResult,
	ProcessStatusInfo,
	ProjectInfo,
	ResourceCatalog,
	ResourcePreview,
	SearchMatch,
	SourceBreakpointGroup,
	ToolStatus,
	ToolsProgressEvent,
	VerifiedBreakpoint
} from "../types/ipc";

export interface TerminalOutputEvent {
	sessionId: string;
	stream: string;
	data?: string;
	chunk?: string;
	line?: string;
}

export interface TerminalExitEvent {
	sessionId: string;
	exitCode?: number | null;
	code?: number | null;
}

export interface FsChangedEvent {
	paths: string[];
}

function subscribe<T>(eventName: string, handler: (payload: T) => void): Promise<UnlistenFn> {
	if (!isTauri()) {
		return Promise.resolve(() => {});
	}
	return listen<T>(eventName, (event) => {
		handler(event.payload);
	});
}

export function getSettings(): Promise<AppSettings> {
	return invoke<AppSettings>("get_settings");
}

export function saveSettings(settings: AppSettings): Promise<void> {
	return invoke<void>("save_settings", { settings });
}

export function listJdks(): Promise<JdkInfo[]> {
	return invoke<JdkInfo[]>("list_jdks");
}

export async function windowMinimize(): Promise<void> {
	if (!isTauri()) return;
	try {
		await invoke<void>("window_minimize");
	} catch {
		await getCurrentWindow().minimize();
	}
}

export async function windowToggleMaximize(): Promise<void> {
	if (!isTauri()) return;
	try {
		await invoke<void>("window_toggle_maximize");
	} catch {
		await getCurrentWindow().toggleMaximize();
	}
}

export async function windowClose(): Promise<void> {
	if (!isTauri()) return;
	try {
		await invoke<void>("window_close");
	} catch {
		await getCurrentWindow().close();
	}
}

export function revealInExplorer(relPath: string): Promise<void> {
	return invoke<void>("reveal_in_explorer", { relPath });
}

export function openProject(path: string): Promise<ProjectInfo> {
	return invoke<ProjectInfo>("open_project", { path });
}

export function closeProject(): Promise<void> {
	return invoke<void>("close_project");
}

export function listDirectory(relPath?: string | null, showHidden = false): Promise<FileNode[]> {
	return invoke<FileNode[]>("list_directory", {
		relPath: relPath ?? null,
		showHidden
	});
}

export function listAllFiles(query = ""): Promise<LimitedResults<string>> {
	return invoke<LimitedResults<string>>("list_all_files", { query });
}

export function readFile(relPath: string): Promise<string> {
	return invoke<string>("read_file", { relPath });
}

export function writeFile(relPath: string, content: string, expected?: string | null): Promise<void | {disk: string | null}> {
	if (expected !== undefined) return invoke("save_checked", {relPath, content, expected});
	return invoke<void>("write_file", { relPath, content });
}

export function createFile(relPath: string, content = ""): Promise<void> {
	return invoke<void>("create_file", { relPath, content });
}

export function createDir(relPath: string): Promise<void> {
	return invoke<void>("create_dir", { relPath });
}

export function renamePath(oldRelPath: string, newRelPath: string): Promise<void> {
	return invoke<void>("rename_path", { oldRelPath, newRelPath });
}

export function deletePath(relPath: string): Promise<void> {
	return invoke<void>("delete_path", { relPath });
}

export function searchInWorkspace(
	query: string,
	caseSensitive = false,
	useRegex = false
): Promise<LimitedResults<SearchMatch>> {
	return invoke<LimitedResults<SearchMatch>>("search_in_workspace", {
		query,
		caseSensitive,
		useRegex
	});
}

export function fetchFabricVersions(forceRefresh = false): Promise<FabricVersionCatalog> {
	return invoke<FabricVersionCatalog>("fetch_fabric_versions", { forceRefresh });
}

export function resolveFabricCompat(mcVersion: string): Promise<FabricCompatVersions> {
	return invoke<FabricCompatVersions>("resolve_fabric_compat", { mcVersion });
}

export function createFabricProject(config: CreateProjectConfig): Promise<ProjectInfo> {
	return invoke<ProjectInfo>("create_fabric_project", { config });
}

export function inspectFabricProject(): Promise<FabricProjectMeta | null> {
	return invoke<FabricProjectMeta | null>("inspect_fabric_project");
}

export function readFabricModJson(): Promise<FabricModMetadata> {
	return invoke<FabricModMetadata>("read_fabric_mod_json");
}

export function writeFabricModJson(metadata: FabricModMetadata): Promise<void> {
	return invoke<void>("write_fabric_mod_json", { metadata });
}

export function scanMixins(): Promise<MixinScanResult> {
	return invoke<MixinScanResult>("scan_mixins");
}

export function analyzeVersionMigration(targetMc: string): Promise<MigrationPlan> {
	return invoke<MigrationPlan>("analyze_version_migration", { targetMc });
}

export function applyVersionMigration(targetMc: string, revision: string): Promise<MigrationResult> {
	return invoke<MigrationResult>("apply_version_migration", { targetMc, revision });
}

export function scanResources(): Promise<ResourceCatalog> {
	return invoke<ResourceCatalog>("scan_resources");
}

export function readResourcePreview(relPath: string): Promise<ResourcePreview> {
	return invoke<ResourcePreview>("read_resource_preview", { relPath });
}

export function runGradleTask(task: GradleTaskKind): Promise<ProcessStatusInfo> {
	return invoke<ProcessStatusInfo>("run_gradle_task", { task });
}

export function stopProcess(processId: string): Promise<void> {
	return invoke<void>("stop_process", { processId });
}

export function getRunningProcesses(): Promise<ProcessStatusInfo[]> {
	return invoke<ProcessStatusInfo[]>("get_running_processes");
}

export function terminalStart(sessionId?: string): Promise<string> {
	return invoke<string>("terminal_start", { sessionId: sessionId ?? null });
}

export function terminalWrite(sessionId: string, input: string): Promise<void> {
	return invoke<void>("terminal_write", { sessionId, input });
}

export function terminalStop(sessionId: string): Promise<void> {
	return invoke<void>("terminal_stop", { sessionId });
}

export function getToolStatus(): Promise<ToolStatus> {
	return invoke<ToolStatus>("get_tool_status");
}

export function ensureJdtlsInstalled(): Promise<ToolStatus> {
	return invoke<ToolStatus>("ensure_jdtls_installed");
}

export function startLanguageServer(): Promise<void> {
	return invoke<void>("start_language_server");
}

export function stopLanguageServer(): Promise<void> {
	return invoke<void>("stop_language_server");
}

export function lspDidOpen(
	uri: string,
	languageId: string,
	version: number,
	text: string
): Promise<void> {
	return invoke<void>("lsp_did_open", { uri, languageId, version, text });
}

export function lspDidChange(uri: string, version: number, text: string): Promise<void> {
	return invoke<void>("lsp_did_change", { uri, version, text });
}

export function lspDidSave(uri: string, text?: string): Promise<void> {
	return invoke<void>("lsp_did_save", { uri, text: text ?? null });
}

export function lspDidClose(uri: string): Promise<void> {
	return invoke<void>("lsp_did_close", { uri });
}

export function lspCompletion(uri: string, line: number, character: number): Promise<unknown> {
	return invoke<unknown>("lsp_completion", { uri, line, character });
}

export function lspHover(uri: string, line: number, character: number): Promise<unknown> {
	return invoke<unknown>("lsp_hover", { uri, line, character });
}

export function lspDefinition(uri: string, line: number, character: number): Promise<unknown> {
	return invoke<unknown>("lsp_definition", { uri, line, character });
}

export function lspReferences(
	uri: string,
	line: number,
	character: number,
	includeDeclaration = true
): Promise<unknown> {
	return invoke<unknown>("lsp_references", {
		uri,
		line,
		character,
		includeDeclaration
	});
}

export function lspRename(
	uri: string,
	line: number,
	character: number,
	newName: string
): Promise<unknown> {
	return invoke<unknown>("lsp_rename", { uri, line, character, newName });
}

export function lspCodeAction(
	uri: string,
	startLine: number,
	startChar: number,
	endLine: number,
	endChar: number,
	diagnostics: LspDiagnostic[] = []
): Promise<unknown> {
	return invoke<unknown>("lsp_code_action", {
		uri,
		startLine,
		startChar,
		endLine,
		endChar,
		diagnostics
	});
}

export function lspFormatting(
	uri: string,
	tabSize: number,
	insertSpaces: boolean
): Promise<unknown> {
	return invoke<unknown>("lsp_formatting", { uri, tabSize, insertSpaces });
}

export function lspClassFileContents(uri: string): Promise<string> {
	return invoke<string>("lsp_class_file_contents", { uri });
}

export function searchMinecraftSources(query: string): Promise<MinecraftClassEntry[]> {
	return invoke<MinecraftClassEntry[]>("search_minecraft_sources", { query });
}

export function readMinecraftSource(sourceJar: string, entryPath: string): Promise<string> {
	return invoke<string>("read_minecraft_source", { sourceJar, entryPath });
}

export function startDebugClient(
	breakpoints: SourceBreakpointGroup[]
): Promise<DebugSessionInfo> {
	return invoke<DebugSessionInfo>("start_debug_client", { breakpoints });
}

export function stopDebugSession(): Promise<void> {
	return invoke<void>("stop_debug_session");
}

export function debugSetBreakpoints(
	filePath: string,
	lines: number[]
): Promise<VerifiedBreakpoint[]> {
	return invoke<VerifiedBreakpoint[]>("debug_set_breakpoints", { filePath, lines });
}

export function debugContinue(threadId?: number): Promise<void> {
	return invoke<void>("debug_continue", { threadId: threadId ?? null });
}

export function debugPause(threadId?: number): Promise<void> {
	return invoke<void>("debug_pause", { threadId: threadId ?? null });
}

export function debugStepOver(threadId: number): Promise<void> {
	return invoke<void>("debug_step_over", { threadId });
}

export function debugStepInto(threadId: number): Promise<void> {
	return invoke<void>("debug_step_into", { threadId });
}

export function debugStepOut(threadId: number): Promise<void> {
	return invoke<void>("debug_step_out", { threadId });
}

export function debugThreads(): Promise<DebugThread[]> {
	return invoke<DebugThread[]>("debug_threads");
}

export function debugStackTrace(threadId: number): Promise<DebugStackFrame[]> {
	return invoke<DebugStackFrame[]>("debug_stack_trace", { threadId });
}

export function debugScopes(frameId: number): Promise<DebugScope[]> {
	return invoke<DebugScope[]>("debug_scopes", { frameId });
}

export function debugVariables(variablesReference: number): Promise<DebugVariable[]> {
	return invoke<DebugVariable[]>("debug_variables", { variablesReference });
}

export function debugEvaluate(
	expression: string,
	frameId?: number
): Promise<DebugEvaluateResult> {
	return invoke<DebugEvaluateResult>("debug_evaluate", {
		expression,
		frameId: frameId ?? null
	});
}

export function gitStatus(): Promise<GitStatusInfo> {
	return invoke<GitStatusInfo>("git_status");
}

export function gitDiff(relPath: string, staged = false): Promise<string> {
	return invoke<string>("git_diff", { relPath, staged });
}

export function gitStage(relPaths: string[]): Promise<void> {
	return invoke<void>("git_stage", { relPaths });
}

export function gitUnstage(relPaths: string[]): Promise<void> {
	return invoke<void>("git_unstage", { relPaths });
}

export function gitCommit(message: string): Promise<string> {
	return invoke<string>("git_commit", { message });
}

export function gitInit(): Promise<void> {
	return invoke<void>("git_init");
}

export function gitLog(limit = 20): Promise<GitCommitEntry[]> {
	return invoke<GitCommitEntry[]>("git_log", { limit });
}

export async function pickDirectory(defaultPath?: string): Promise<string | null> {
	if (!isTauri()) return null;
	const selected = await openDialog({
		directory: true,
		multiple: false,
		defaultPath
	});
	if (typeof selected === "string") return selected;
	return null;
}

export async function openExternal(urlOrPath: string): Promise<void> {
	if (!isTauri()) {
		if (/^https?:\/\//i.test(urlOrPath)) {
			window.open(urlOrPath, "_blank", "noopener,noreferrer");
		}
		return;
	}
	if (/^https?:\/\//i.test(urlOrPath)) {
		await openUrl(urlOrPath);
	} else {
		await openPath(urlOrPath);
	}
}

export function onGradleOutput(cb: (ev: GradleOutputEvent) => void): Promise<UnlistenFn> {
	return subscribe<GradleOutputEvent>("gradle:output", cb);
}

export function onGradleState(cb: (ev: GradleStateEvent) => void): Promise<UnlistenFn> {
	return subscribe<GradleStateEvent>("gradle:state", cb);
}

export function onTerminalOutput(cb: (ev: TerminalOutputEvent) => void): Promise<UnlistenFn> {
	return subscribe<TerminalOutputEvent>("terminal:output", cb);
}

export function onTerminalExit(cb: (ev: TerminalExitEvent) => void): Promise<UnlistenFn> {
	return subscribe<TerminalExitEvent>("terminal:exit", cb);
}

export function onFsChanged(cb: (ev: FsChangedEvent) => void): Promise<UnlistenFn> {
	return subscribe<FsChangedEvent>("fs:changed", cb);
}

export function onToolsProgress(cb: (ev: ToolsProgressEvent) => void): Promise<UnlistenFn> {
	return subscribe<ToolsProgressEvent>("tools:progress", cb);
}

export function onLspStatus(cb: (ev: LspStatusEvent) => void): Promise<UnlistenFn> {
	return subscribe<LspStatusEvent>("lsp:status", cb);
}

export function onLspDiagnostics(cb: (ev: LspDiagnosticsEvent) => void): Promise<UnlistenFn> {
	return subscribe<LspDiagnosticsEvent>("lsp:diagnostics", cb);
}

export function onDebugEvent(cb: (ev: DebugEventPayload) => void): Promise<UnlistenFn> {
	return subscribe<DebugEventPayload>("debug:event", cb);
}

export const backend = {
	getSettings,
	saveSettings,
	listJdks,
	windowMinimize,
	windowToggleMaximize,
	windowClose,
	revealInExplorer,
	openProject,
	closeProject,
	listDirectory,
	listAllFiles,
	readFile,
	writeFile,
	diskContent: (relPath: string) => invoke<string | null>("disk_content", {relPath}),
	createFile,
	createDir,
	renamePath,
	deletePath,
	searchInWorkspace,
	fetchFabricVersions,
	resolveFabricCompat,
	createFabricProject,
	inspectFabricProject,
	readFabricModJson,
	writeFabricModJson,
	scanMixins,
	analyzeVersionMigration,
	applyVersionMigration,
	scanResources,
	readResourcePreview,
	runGradleTask,
	stopProcess,
	getRunningProcesses,
	terminalStart,
	terminalWrite,
	terminalStop,
	getToolStatus,
	ensureJdtlsInstalled,
	startLanguageServer,
	stopLanguageServer,
	lspDidOpen,
	lspDidChange,
	lspDidSave,
	lspDidClose,
	lspCompletion,
	lspResolveCompletion: (item: unknown) => invoke<unknown>("lsp_resolve_completion", {item}),
	lspSearchTypes: (query: string) => invoke<Array<{name: string; kind: number; containerName?: string; location: {uri: string; range?: {start:{line:number;character:number}}}}>>("lsp_search_types", {query}),
	lspSemanticTokens: (uri: string) => invoke<{types: string[]; data: number[] | null} | null>("lsp_semantic_tokens", {uri}),
	lspOrganizeImports: (uri: string, selected: string[] = []) => invoke<{edit?: unknown; groups?: string[][]}>("lsp_organize_imports", {uri, selected}),
	lspHover,
	lspDefinition,
	lspReferences,
	lspRename,
	lspCodeAction,
	lspFormatting,
	lspClassFileContents,
	searchMinecraftSources,
	readMinecraftSource,
	startDebugClient,
	stopDebugSession,
	debugSetBreakpoints,
	debugContinue,
	debugPause,
	debugStepOver,
	debugStepInto,
	debugStepOut,
	debugThreads,
	debugStackTrace,
	debugScopes,
	debugVariables,
	debugEvaluate,
	gitStatus,
	gitDiff,
	gitStage,
	gitUnstage,
	gitCommit,
	gitInit,
	gitLog,
	pickDirectory,
	openExternal,
	onGradleOutput,
	onGradleState,
	onTerminalOutput,
	onTerminalExit,
	onFsChanged,
	onToolsProgress,
	onLspStatus,
	onLspDiagnostics,
	onDebugEvent
};