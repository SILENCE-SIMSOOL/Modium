export type AppLanguage = "ko" | "en" | "zh" | "ja";

export type AppTheme = "system" | "dark" | "light";

export interface RecentProject {
	name: string;
	path: string;
	mcVersion: string;
	lastOpened: string;
}

export interface AppSettings {
	language: AppLanguage;
	theme: AppTheme;
	fontSize: number;
	tabSize: number;
	autoSave: boolean;
	autoSaveDelayMs: number;
	preferredJdkPath: string;
	recentProjects: RecentProject[];
	lastProject: string | null;
}

export interface JdkInfo {
	path: string;
	version: string;
	major: number;
	vendor: string;
	isDefault: boolean;
}

export interface FileNode {
	name: string;
	relPath: string;
	isDir: boolean;
	size: number;
	children: FileNode[] | null;
}

export interface FabricProjectMeta {
	modId: string;
	modName: string;
	version: string;
	mcVersion: string;
	loaderVersion: string;
	loomVersion: string;
	fabricApiVersion: string;
	javaVersion: number;
	isModernUnobfuscated: boolean;
	hasClientSourceSet: boolean;
	hasMixins: boolean;
}

export interface ProjectInfo {
	name: string;
	path: string;
	isFabric: boolean;
	fabricMeta: FabricProjectMeta | null;
}

export interface LimitedResults<T> {
	items: T[];
	truncated: boolean;
}

export interface SearchMatch {
	endColumn: number;
	previewColumn: number;
	relPath: string;
	line: number;
	column: number;
	lineText: string;
}

export interface McVersionEntry {
	version: string;
	stable: boolean;
}

export interface LoaderVersionEntry {
	version: string;
	stable: boolean;
}

export interface FabricVersionCatalog {
	gameVersions: McVersionEntry[];
	loaderVersions: LoaderVersionEntry[];
	loomVersions: string[];
	apiByMc: Record<string, string[]>;
}

export interface FabricCompatVersions {
	mcVersion: string;
	loaderVersion: string;
	loomVersion: string;
	fabricApiVersion: string;
	recommendedJava: number;
	gradleVersion: string;
	isModernUnobfuscated: boolean;
	yarnVersion: string | null;
}

export interface CreateProjectConfig {
	projectDir: string;
	modName: string;
	modId: string;
	packageName: string;
	mcVersion: string;
	loaderVersion: string;
	loomVersion: string;
	fabricApiVersion: string;
	jdkPath: string | null;
	generateClientEntrypoint: boolean;
	enableMixin: boolean;
	useYarnMappings: boolean;
}

export interface FabricModMetadata {
	schemaVersion: number;
	id: string;
	version: string;
	name: string;
	description: string;
	authors: string[];
	license: string;
	environment: string;
	entrypoints: Record<string, string[]>;
	mixins: unknown[];
	depends: Record<string, string>;
	rawJson: string;
}

export interface MixinTargetMethod {
	name: string;
	annotation: string;
	line: number;
	targetMethod: string;
	atValue: string;
}

export interface MixinEntry {
	configFile: string;
	environment: string;
	packageName: string;
	className: string;
	relPath: string;
	targetClasses: string[];
	methods: MixinTargetMethod[];
	issues: string[];
}

export interface MixinScanResult {
	entries: MixinEntry[];
}

export interface MigrationChange {
	file: string;
	description: string;
	before: string;
	after: string;
}

export interface MigrationPlan {
	revision: string;
	fromMc: string;
	toMc: string;
	targetLoader: string;
	targetLoom: string;
	targetApi: string;
	targetJava: number;
	breakingNotes: string[];
	changes: MigrationChange[];
}

export interface MigrationResult {
	appliedFiles: string[];
	notes: string[];
}

export type ResourceKind = "texture" | "model" | "blockstate" | "lang" | "sound" | "other";

export interface ResourceEntry {
	relPath: string;
	kind: ResourceKind;
	namespace: string;
	name: string;
	size: number;
}

export interface ResourceCatalog {
	entries: ResourceEntry[];
}

export interface ResourcePreview {
	relPath: string;
	kind: ResourceKind;
	mimeType: string | null;
	base64Data: string | null;
	textContent: string | null;
	width: number | null;
	height: number | null;
	validJson: boolean | null;
	jsonError: string | null;
}

export type GradleTaskKind =
	| "build"
	| "runClient"
	| "runServer"
	| "clean"
	| "genSources"
	| "eclipse"
	| "refreshDependencies"
	| "compileJava";

export type ProcessLifecycle =
	| "idle"
	| "starting"
	| "running"
	| "completed"
	| "failed"
	| "stopping"
	| "stopped";

export type ProblemSeverity = "error" | "warning" | "info";

export interface BuildProblem {
	severity: ProblemSeverity;
	filePath: string;
	relPath: string | null;
	line: number;
	column: number | null;
	message: string;
}

export interface ProcessStatusInfo {
	processId: string;
	kind: string;
	state: ProcessLifecycle;
	pid: number | null;
}

export interface GradleOutputEvent {
	processId: string;
	task: GradleTaskKind;
	stream: string;
	line: string;
}

export interface GradleStateEvent {
	processId: string;
	task: GradleTaskKind;
	state: ProcessLifecycle;
	exitCode: number | null;
	problems: BuildProblem[];
}

export interface ToolStatus {
	jdtlsInstalled: boolean;
	jdtlsPath: string | null;
	javaDebugInstalled: boolean;
	javaDebugPath: string | null;
	toolsRoot: string;
}

export interface ToolsProgressEvent {
	tool: string;
	step: number;
	totalSteps: number;
	percent: number;
	message: string;
}

export interface LspStatusEvent {
	state: string;
	message: string;
	percent: number | null;
}

export interface LspDiagnostic {
	rangeStartLine: number;
	rangeStartChar: number;
	rangeEndLine: number;
	rangeEndChar: number;
	severity: number;
	code: string | null;
	source: string | null;
	message: string;
}

export interface LspDiagnosticsEvent {
	uri: string;
	diagnostics: LspDiagnostic[];
}

export interface MinecraftClassEntry {
	className: string;
	packageName: string;
	sourceJar: string;
	sourceScope: string;
	entryPath: string;
}

export interface SourceBreakpointGroup {
	filePath: string;
	lines: number[];
}

export interface VerifiedBreakpoint {
	id: number | null;
	verified: boolean;
	line: number;
	message: string | null;
}

export interface DebugSessionInfo {
	sessionId: string;
	jdwpPort: number;
	dapPort: number;
}

export interface DebugThread {
	id: number;
	name: string;
}

export interface DebugStackFrame {
	id: number;
	name: string;
	sourcePath: string | null;
	line: number;
	column: number;
}

export interface DebugScope {
	name: string;
	variablesReference: number;
	expensive: boolean;
}

export interface DebugVariable {
	name: string;
	value: string;
	varType: string | null;
	variablesReference: number;
}

export interface DebugEvaluateResult {
	result: string;
	varType: string | null;
	variablesReference: number;
}

export interface DebugEventPayload {
	workspace: string;
	kind: string;
	threadId: number | null;
	reason: string | null;
	filePath: string | null;
	line: number | null;
	message: string | null;
}

export interface GitFileChange {
	relPath: string;
	indexStatus: string;
	worktreeStatus: string;
	staged: boolean;
}

export interface GitStatusInfo {
	isRepo: boolean;
	branch: string | null;
	ahead: number;
	behind: number;
	changes: GitFileChange[];
}

export interface GitCommitEntry {
	hash: string;
	shortHash: string;
	author: string;
	date: string;
	message: string;
}