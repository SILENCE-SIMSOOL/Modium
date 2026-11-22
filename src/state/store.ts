import { flushJavaDocument } from "../services/lspBridge";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { message } from "@tauri-apps/plugin-dialog";
import { useSyncExternalStore } from "react";
import { backend, type TerminalExitEvent, type TerminalOutputEvent } from "../services/backend";
import { applyMonacoTheme } from "../services/monacoSetup";
import type {
	AppLanguage,
	AppSettings,
	AppTheme,
	BuildProblem,
	DebugSessionInfo,
	FileNode,
	GradleTaskKind,
	LspDiagnostic,
	ProcessLifecycle,
	ProjectInfo,
	SourceBreakpointGroup,
	ToolStatus
} from "../types/ipc";

export type SidebarTab =
	| "explorer"
	| "search"
	| "mixins"
	| "sources"
	| "resources"
	| "debug"
	| "git";

export type BottomTab = "terminal" | "build" | "problems" | "debugConsole";

export type ActiveModal = "none" | "createProject" | "migration" | "settings" | "quickOpen" | "typeSearch" | "resourceSearch";

export interface EditorTab {
	id: string;
	title: string;
	relPath: string | null;
	uri: string;
	language: string;
	content: string;
	savedContent: string;
	external?: {disk: string | null};
	isDirty: boolean;
	readOnly?: boolean;
	revealLine?: number;
	revealColumn?: number;
	revealVersion?: number;
}

export interface ProgressTask {
	label: string;
	step: number;
	totalSteps: number;
	percent: number;
	indeterminate?: boolean;
}

export type ToastKind = "info" | "success" | "warning" | "error";

export interface ToastItem {
	id: string;
	kind: ToastKind;
	text: string;
}

export interface GradleLogLine {
	id: number;
	stream: string;
	text: string;
}

export interface DebugLogLine {
	id: number;
	kind: "output" | "eval" | "result" | "error" | "event";
	text: string;
}

export interface DebugPausedLocation {
	filePath: string;
	line: number;
	threadId: number | null;
	reason: string | null;
}

export interface StoreState {
	initialized: boolean;
	workspaceBusy: boolean;
	settings: AppSettings;
	project: ProjectInfo | null;
	fileTree: FileNode[];
	tabs: EditorTab[];
	activeTabId: string | null;
	metadataEditorOpen: boolean;
	sidebarTab: SidebarTab;
	sidebarVisible: boolean;
	sidebarWidth: number;
	bottomTab: BottomTab;
	bottomVisible: boolean;
	bottomHeight: number;
	activeModal: ActiveModal;
	progressTask: ProgressTask | null;
	toolStatus: ToolStatus | null;
	lspState: string;
	completionError: string;
	completionFailures: number;
	lspMessage: string;
	lspPercent: number | null;
	lspDiagnostics: Record<string, LspDiagnostic[]>;
	activeProcessId: string | null;
	activeGradleTask: GradleTaskKind | null;
	gradleState: ProcessLifecycle;
	gradleOutput: GradleLogLine[];
	buildProblems: BuildProblem[];
	terminalSessionId: string | null;
	terminalChunks: { id: number; stream: string; text: string }[];
	terminalExited: boolean;
	debugSession: DebugSessionInfo | null;
	debugPausedLocation: DebugPausedLocation | null;
	debugLogs: DebugLogLine[];
	breakpoints: Record<string, number[]>;
	cursorLine: number;
	cursorColumn: number;
	toasts: ToastItem[];
	fsRevision: number;
	systemPrefersDark: boolean;
}

const DEFAULT_SETTINGS: AppSettings = {
	language: "ko",
	theme: "dark",
	fontSize: 13,
	tabSize: 4,
	autoSave: true,
	autoSaveDelayMs: 1000,
	preferredJdkPath: "",
	recentProjects: [],
	lastProject: null
};

const darkMediaQuery =
	typeof window !== "undefined" && typeof window.matchMedia === "function"
		? window.matchMedia("(prefers-color-scheme: dark)")
		: null;

function resolveIsDark(theme: AppTheme, systemDark: boolean): boolean {
	if (theme === "dark") return true;
	if (theme === "light") return false;
	return systemDark;
}

function applyThemeToDocument(theme: AppTheme, systemDark: boolean): void {
	const meta = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
	const content = theme === "light" ? "light" : theme === "dark" ? "dark" : "light dark";
	if (meta) {
		meta.content = content;
	}
	try {
		if (theme === "system") {
			localStorage.removeItem("color-scheme");
		} else {
			localStorage.setItem("color-scheme", theme);
		}
	} catch {
		// Ignore storage access errors
	}
	applyMonacoTheme(resolveIsDark(theme, systemDark));
}

function pickMsg(
	lang: AppLanguage,
	ko: string,
	en: string,
	zh: string,
	ja: string
): string {
	if (lang === "ko") return ko;
	if (lang === "zh") return zh;
	if (lang === "ja") return ja;
	return en;
}

let state: StoreState = {
	initialized: false,
	workspaceBusy: false,
	settings: DEFAULT_SETTINGS,
	project: null,
	fileTree: [],
	tabs: [],
	activeTabId: null,
	metadataEditorOpen: false,
	sidebarTab: "explorer",
	sidebarVisible: true,
	sidebarWidth: 236,
	bottomTab: "terminal",
	bottomVisible: true,
	bottomHeight: 196,
	activeModal: "none",
	progressTask: null,
	toolStatus: null,
	lspState: "idle",
	completionError: "",
	completionFailures: 0,
	lspMessage: "",
	lspPercent: null,
	lspDiagnostics: {},
	activeProcessId: null,
	activeGradleTask: null,
	gradleState: "idle",
	gradleOutput: [],
	buildProblems: [],
	terminalSessionId: null,
	terminalChunks: [],
	terminalExited: false,
	debugSession: null,
	debugPausedLocation: null,
	debugLogs: [],
	breakpoints: {},
	cursorLine: 1,
	cursorColumn: 1,
	toasts: [],
	fsRevision: 0,
	systemPrefersDark: darkMediaQuery ? darkMediaQuery.matches : true
};

const listeners = new Set<() => void>();
let initializing = false;
let eventsAttached = false;
let windowCloseAttached = false;
let nextLogId = 1;
let revealCounter = 1;
const autoSaveTimers = new Map<string, number>();
const saves = new Map<string, Promise<void>>();
let workspaceEpoch = 0;
const starting = new Set<Promise<unknown>>();
function trackStart<T>(promise: Promise<T>): Promise<T> {
	starting.add(promise);
	return promise.finally(() => starting.delete(promise));
}
const positions = new Map<string, {line: number; column: number}>();
let logBatch: GradleLogLine[] = [];
let logTimer: number | undefined;

function flushLogs(): void {
	window.clearTimeout(logTimer);
	logTimer = undefined;
	if (!logBatch.length) return;
	const lines = logBatch;
	logBatch = [];
	store.setState({ gradleOutput: state.gradleOutput.concat(lines).slice(-2500) });
}

function rememberSession(): void {
	if (!state.project) return;
	const tabs = state.tabs.flatMap(t => t.relPath ? [{path: t.relPath, ...positions.get(t.id)}] : []);
	const active = state.tabs.find(t => t.id === state.activeTabId)?.relPath;
	localStorage.setItem("modium.session:" + state.project.path, JSON.stringify({tabs, active}));
}

async function restoreSession(path: string): Promise<void> {
	try {
		const raw = localStorage.getItem("modium.session:" + path);
		if (!raw) return;
		const session = JSON.parse(raw);
		for (const tab of session.tabs) {
			if (typeof tab.path !== "string") continue;
			try {
				await store.openFileTab(tab.path, tab.line, tab.column);
				positions.set("file:" + tab.path, {line: tab.line || 1, column: tab.column || 1});
			} catch { /* The file may have been removed outside the editor. */ }
		}
		if (session.active) store.setActiveTab("file:" + session.active);
	} catch { /* Ignore sessions from incompatible storage formats. */ }
}

function clearWorkspace(): Partial<StoreState> {
	workspaceEpoch++;
	for (const timer of autoSaveTimers.values()) window.clearTimeout(timer);
	autoSaveTimers.clear();
	positions.clear();
	logBatch = [];
	flushLogs();
	return { breakpoints: {}, debugLogs: [], terminalSessionId: null, terminalChunks: [], terminalExited: false,
		activeProcessId: null, activeGradleTask: null, gradleState: "idle", cursorLine: 1, cursorColumn: 1 };
}

function scheduleAutoSave(id: string): void {
	window.clearTimeout(autoSaveTimers.get(id));
	const delay = Math.max(300, state.settings.autoSaveDelayMs || 1000);
	autoSaveTimers.set(id, window.setTimeout(() => {
		autoSaveTimers.delete(id);
		if (state.tabs.find(t => t.id === id)?.isDirty) {
			void store.saveTab(id).catch(err => store.showToast("error", String(err)));
		}
	}, delay));
}

async function confirmEdits(ids: string[]): Promise<boolean> {
	const pendingTimers = ids.filter(id => autoSaveTimers.has(id));
	for (const id of ids) {
		window.clearTimeout(autoSaveTimers.get(id));
		autoSaveTimers.delete(id);
	}
	await Promise.allSettled(ids.map(id => saves.get(id)));
	const dirty = state.tabs.filter(t => ids.includes(t.id) && t.isDirty);
	if (!dirty.length) return true;
	const lang = state.settings.language;
	const buttons = {
		yes: pickMsg(lang, "저장", "Save", "保存", "保存"),
		no: pickMsg(lang, "버리기", "Discard", "放弃", "破棄"),
		cancel: pickMsg(lang, "취소", "Cancel", "取消", "キャンセル")
	};
	const promptText = pickMsg(lang, "변경 사항을 저장할까요?", "Save changes?", "是否保存更改？", "変更を保存しますか？");
	const result = await message(promptText + "\n" + dirty.map(t => t.relPath).join("\n"), {title: "Modium", buttons});
	if (result === buttons.no) return true;
	if (result !== buttons.yes) {
		for (const id of pendingTimers) scheduleAutoSave(id);
		return false;
	}
	try {
		for (const tab of dirty) await store.saveTab(tab.id);
		return !state.tabs.some(t => ids.includes(t.id) && t.isDirty);
	} catch (err) {
		store.showToast("error", String(err));
		return false;
	}
}

async function withWorkspaceLock(action: () => Promise<void>): Promise<void> {
	if (state.workspaceBusy) return;
	store.setState({ workspaceBusy: true });
	try { await action(); }
	finally { store.setState({ workspaceBusy: false }); }
}
const toastTimers = new Map<string, number>();

function notify(): void {
	for (const listener of listeners) {
		listener();
	}
}

export function normalizePathSlashes(path: string): string {
	return path.replace(/\\/g, "/");
}

export function joinWorkspacePath(root: string, relPath: string): string {
	const cleanRoot = normalizePathSlashes(root).replace(/\/+$/, "");
	const cleanRel = normalizePathSlashes(relPath).replace(/^\/+/, "");
	return `${cleanRoot}/${cleanRel}`;
}

export function toFileUri(root: string, relPath: string): string {
	const abs = joinWorkspacePath(root, relPath);
	const withLeadingSlash = abs.startsWith("/") ? abs : `/${abs}`;
	return `file://${encodeURI(withLeadingSlash).replace(/#/g, "%23")}`;
}

export function fromFileUri(uri: string, root: string | null): string | null {
	if (!uri.startsWith("file://") || !root) return null;
	try {
		let decoded = decodeURIComponent(uri.slice("file://".length));
		if (/^\/[A-Za-z]:/.test(decoded)) {
			decoded = decoded.slice(1);
		}
		const normPath = normalizePathSlashes(decoded);
		const normRoot = normalizePathSlashes(root).replace(/\/+$/, "");
		if (normPath.toLowerCase().startsWith(`${normRoot.toLowerCase()}/`)) {
			return normPath.slice(normRoot.length + 1);
		}
		return null;
	} catch {
		return null;
	}
}

export function detectLanguage(pathOrName: string): string {
	const lower = pathOrName.toLowerCase();
	if (lower.endsWith(".java")) return "java";
	if (lower.endsWith(".json") || lower.endsWith(".mcmeta")) return "json";
	if (lower.endsWith(".kt") || lower.endsWith(".kts")) return "kotlin";
	if (lower.endsWith(".xml")) return "xml";
	if (lower.endsWith(".yml") || lower.endsWith(".yaml")) return "yaml";
	if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
	if (
		lower.endsWith(".properties") ||
		lower.endsWith(".toml") ||
		lower.endsWith(".ini") ||
		lower.endsWith(".cfg")
	) {
		return "ini";
	}
	return "plaintext";
}

function getFileTitle(relPath: string): string {
	const norm = normalizePathSlashes(relPath);
	const idx = norm.lastIndexOf("/");
	return idx >= 0 ? norm.slice(idx + 1) : norm;
}

function resolveBreakpointKey(filePath: string): string {
	const norm = normalizePathSlashes(filePath);
	const isAbs = /^[A-Za-z]:\//.test(norm) || norm.startsWith("/");
	if (!isAbs && state.project?.path) {
		return joinWorkspacePath(state.project.path, norm);
	}
	return norm;
}

async function attachBackendEvents(): Promise<void> {
	if (eventsAttached) return;
	eventsAttached = true;

	await backend.onGradleOutput((ev) => {
		if (ev.processId !== state.activeProcessId) return;
		logBatch.push({ id: nextLogId++, stream: ev.stream, text: ev.line });
		if (logBatch.length >= 2500) flushLogs();
		else if (logTimer === undefined) logTimer = window.setTimeout(flushLogs, 48);

	});

	await backend.onGradleState((ev) => {
		if ((!state.activeProcessId && state.gradleState !== "starting") || (state.activeProcessId && state.activeProcessId !== ev.processId)) return;
		flushLogs();
		const isDone =
			ev.state === "completed" || ev.state === "failed" || ev.state === "stopped";
		store.setState({
			activeProcessId: isDone ? null : ev.processId,
			activeGradleTask: isDone ? null : ev.task,
			gradleState: ev.state,
			buildProblems: ev.problems ?? state.buildProblems
		});
		if (isDone && ev.task === "genSources" && ev.state === "completed") {
			store.showToast(
				"success",
				pickMsg(
					state.settings.language,
					"마인크래프트 소스 생성이 완료됐어요.",
					"Minecraft sources generated successfully.",
					"Minecraft 源码生成完成。",
					"Minecraft ソースの生成が完了しました。"
				)
			);
		} else if (isDone && ev.state === "failed") {
			store.showToast(
				"error",
				pickMsg(
					state.settings.language,
					`Gradle 작업(${ev.task})이 실패했어요.`,
					`Gradle task (${ev.task}) failed.`,
					`Gradle 任务 (${ev.task}) 失败。`,
					`Gradle タスク (${ev.task}) が失敗しました。`
				)
			);
		}
	});

	await backend.onTerminalOutput((ev: TerminalOutputEvent) => {
		if (ev.sessionId !== state.terminalSessionId) return;
		const chunkText = ev.chunk ?? ev.data ?? ev.line ?? "";
		if (!chunkText) return;
		const id = nextLogId++;
		const nextChunks = [...state.terminalChunks, { id, stream: ev.stream, text: chunkText }];
		if (nextChunks.length > 1500) {
			nextChunks.splice(0, nextChunks.length - 1500);
		}
		store.setState({
			terminalSessionId: ev.sessionId,
			terminalChunks: nextChunks,
			terminalExited: false
		});
	});

	await backend.onTerminalExit((ev: TerminalExitEvent) => {
		const id = nextLogId++;
		if (ev.sessionId !== state.terminalSessionId) return;
		const code = ev.exitCode ?? ev.code;
		const msg = pickMsg(
			state.settings.language,
			`\n[터미널 종료: code ${code ?? "-"}]\n`,
			`\n[Terminal exited: code ${code ?? "-"}]\n`,
			`\n[终端已退出: code ${code ?? "-"}]\n`,
			`\n[ターミナル終了: code ${code ?? "-"}]\n`
		);
		store.setState({
			terminalExited: true,
			terminalChunks: [...state.terminalChunks, { id, stream: "system", text: msg }]
		});
	});

	await backend.onFsChanged(({paths}) => {
		for (const tab of state.tabs) {
			if (tab.relPath && paths.some(path => path === tab.relPath || tab.relPath?.startsWith(path + "/"))) {
				void store.refreshDocument(tab.id).catch(err => store.showToast("error", String(err)));
			}
		}
		store.setState((prev) => ({ fsRevision: prev.fsRevision + 1 }));
		void store.refreshFileTree();
	});

	await backend.onToolsProgress((ev) => {
		const done = ev.percent >= 100 && ev.step >= ev.totalSteps;
		store.setProgressTask(
			done
				? null
				: {
						label: ev.message || ev.tool,
						step: ev.step,
						totalSteps: ev.totalSteps,
						percent: ev.percent,
						indeterminate: ev.percent <= 0
					}
		);
		if (done) {
			void backend.getToolStatus().then((toolStatus) => {
				store.setState({ toolStatus });
			});
		}
	});

	await backend.onLspStatus((ev) => {
		store.setState({
			lspState: ev.state,
			lspMessage: ev.message,
			lspPercent: ev.percent
		});
	});

	await backend.onLspDiagnostics((ev) => {
		if (!fromFileUri(ev.uri, state.project?.path ?? null) || state.workspaceBusy) return;
		store.refreshDiagnostics(ev.uri, ev.diagnostics);
	});

	await backend.onDebugEvent((ev) => {
		if (ev.workspace !== state.project?.path) return;
		if (ev.kind === "hotReloadError") {
			const message = pickMsg(state.settings.language, "변경을 적용할 수 없어. 디버그 패널에서 세션을 재시작해.", "Hot reload failed. Restart the session in the Debug panel.", "无法热替换，请在调试面板重新启动。", "変更を適用できません。デバッグパネルで再起動してください。");
			store.appendDebugLog("error", message + " " + (ev.message ?? ""));
			store.showToast("warning", message);
		} else if (ev.kind === "output" && ev.message) {
			store.appendDebugLog("output", ev.message);
		} else if (ev.kind === "stopped") {
			store.setState({
				debugPausedLocation:
					ev.filePath && ev.line
						? {
								filePath: normalizePathSlashes(ev.filePath),
								line: ev.line,
								threadId: ev.threadId,
								reason: ev.reason
							}
						: null
			});
			store.appendDebugLog(
				"event",
				ev.message ?? `Stopped (${ev.reason ?? "breakpoint"})`
			);
			if (ev.filePath && ev.line && state.project?.path) {
				const normRoot = normalizePathSlashes(state.project.path).replace(/\/+$/, "");
				const normFile = normalizePathSlashes(ev.filePath);
				if (normFile.toLowerCase().startsWith(`${normRoot.toLowerCase()}/`)) {
					const rel = normFile.slice(normRoot.length + 1);
					void store.openFileTab(rel, ev.line, 1);
				}
			}
		} else if (ev.kind === "continued") {
			store.setState({ debugPausedLocation: null });
		} else if (ev.kind === "terminated" || ev.kind === "exited") {
			store.setState({
				debugSession: null,
				debugPausedLocation: null
			});
			store.appendDebugLog(
				"event",
				pickMsg(
					state.settings.language,
					"디버그 세션이 종료됐어요.",
					"Debug session ended.",
					"调试会话已结束。",
					"デバッグセッションが終了しました。"
				)
			);
		} else if (ev.message) {
			store.appendDebugLog("event", ev.message);
		}
	});
}

export const store = {
	getState(): StoreState {
		return state;
	},

	setState(
		patch: Partial<StoreState> | ((prev: StoreState) => Partial<StoreState>)
	): void {
		const nextPatch = typeof patch === "function" ? patch(state) : patch;
		state = { ...state, ...nextPatch };
		notify();
	},

	subscribe(listener: () => void): () => void {
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	},

	async initApp(): Promise<void> {
		if (state.initialized || initializing) return;
		initializing = true;
		await attachBackendEvents();
		if (isTauri() && !windowCloseAttached) {
			windowCloseAttached = true;
			await getCurrentWindow().onCloseRequested(async event => {
				event.preventDefault();
				await withWorkspaceLock(async () => {
					if (!await confirmEdits(state.tabs.map(t => t.id))) return;
					rememberSession();
					await getCurrentWindow().destroy();
				}).catch(err => store.showToast("error", String(err)));
			});
		}
		if (darkMediaQuery) {
			darkMediaQuery.addEventListener("change", (ev) => {
				store.setState({ systemPrefersDark: ev.matches });
				if (state.settings.theme === "system") {
					applyMonacoTheme(ev.matches);
				}
			});
		}
		window.addEventListener("storage", (ev) => {
			if (ev.key !== "color-scheme") return;
			const nextTheme: AppTheme =
				ev.newValue === "light" || ev.newValue === "dark" ? ev.newValue : "system";
			if (nextTheme !== state.settings.theme) {
				applyThemeToDocument(nextTheme, state.systemPrefersDark);
				store.setState({ settings: { ...state.settings, theme: nextTheme } });
			}
		});
		try {
			const settings = await backend.getSettings();
			const mergedSettings: AppSettings = { ...DEFAULT_SETTINGS, ...settings };
			document.documentElement.lang = mergedSettings.language;
			applyThemeToDocument(mergedSettings.theme, state.systemPrefersDark);
			store.setState({ settings: mergedSettings, initialized: true });
		} catch {
			applyThemeToDocument(state.settings.theme, state.systemPrefersDark);
			store.setState({ initialized: true });
		}
		try {
			const toolStatus = await backend.getToolStatus();
			store.setState({ toolStatus });
		} catch {
			// Running without Tauri backend or tools unconfigured
		}
		const lastProject = state.settings.lastProject;
		if (lastProject) {
			try {
				await store.openProjectPath(lastProject);
			} catch {
				// Ignore stale last project path
			}
		}
	},

	async openProjectPath(path: string): Promise<void> {
		await withWorkspaceLock(async () => {
			if (!await confirmEdits(state.tabs.map(t => t.id))) return;
			rememberSession();
			await Promise.allSettled(starting);
			const project = await backend.openProject(path);
			const reset = clearWorkspace();
			const fileTree = await backend.listDirectory(null, false).catch(() => [] as FileNode[]);
			let settings = state.settings;
			try {
				settings = await backend.getSettings();
			} catch {
				// Keep existing settings on failure
			}
			store.setState({
				...reset,
				project,
				fileTree,
				settings,
				tabs: [],
				activeTabId: null,
				metadataEditorOpen: false,
				buildProblems: [],
				lspDiagnostics: {},
				gradleOutput: [],
				activeProcessId: null,
				activeGradleTask: null,
				gradleState: "idle",
				lspState: "idle",
				completionError: "",
				completionFailures: 0,
				lspMessage: "",
				lspPercent: null,
				debugSession: null,
				debugPausedLocation: null
			});
			await restoreSession(project.path);
			if (state.toolStatus?.jdtlsInstalled) {
				void store.startLspForWorkspace();
			}
		});
	},

	async closeCurrentProject(): Promise<void> {
		await withWorkspaceLock(async () => {
			if (!await confirmEdits(state.tabs.map(t => t.id))) return;
			rememberSession();
			await Promise.allSettled(starting);
			await backend.closeProject();
			store.setState({
				...clearWorkspace(),
				project: null,
				fileTree: [],
				tabs: [],
				activeTabId: null,
				metadataEditorOpen: false,
				buildProblems: [],
				lspDiagnostics: {},
				gradleOutput: [],
				debugSession: null,
				debugPausedLocation: null,
				lspState: "idle",
				completionError: "",
				completionFailures: 0,
				lspMessage: "",
				lspPercent: null
			});
		});
	},

	async refreshFileTree(): Promise<void> {
		if (!state.project) return;
		try {
			const epoch = workspaceEpoch;
			const fileTree = await backend.listDirectory(null, false);
			if (epoch !== workspaceEpoch) return;
			store.setState({ fileTree });
		} catch {
			// Ignore transient fs errors
		}
	},

	async openFileTab(relPath: string, line?: number, column?: number): Promise<void> {
		const cleanRel = normalizePathSlashes(relPath).replace(/^\/+/, "");
		const existing = state.tabs.find((t) => t.relPath === cleanRel);
		const rev = revealCounter++;
		if (existing) {
			store.setState({
				activeTabId: existing.id,
				tabs: state.tabs.map((t) =>
					t.id === existing.id
						? {
								...t,
								revealLine: line,
								revealColumn: column,
								revealVersion: line ? rev : t.revealVersion
							}
						: t
				)
			});
			return;
		}
		const epoch = workspaceEpoch;
		const content = await backend.readFile(cleanRel);
		if (epoch !== workspaceEpoch || state.tabs.some(t => t.relPath === cleanRel)) return;
		const uri = state.project
			? toFileUri(state.project.path, cleanRel)
			: `file:///${cleanRel}`;
		const tab: EditorTab = {
			id: `file:${cleanRel}`,
			title: getFileTitle(cleanRel),
			relPath: cleanRel,
			uri,
			language: detectLanguage(cleanRel),
			content,
			savedContent: content,
			isDirty: false,
			readOnly: false,
			revealLine: line,
			revealColumn: column,
			revealVersion: line ? rev : undefined
		};
		store.setState({
			tabs: [...state.tabs, tab],
			activeTabId: tab.id,
			metadataEditorOpen: false
		});
	},

	openVirtualTab(
		title: string,
		uri: string,
		language: string,
		content: string,
		line?: number
	): void {
		const existing = state.tabs.find((t) => t.uri === uri);
		const rev = revealCounter++;
		if (existing) {
			store.setState({
				activeTabId: existing.id,
				tabs: state.tabs.map((t) =>
					t.id === existing.id
						? {
								...t,
								content,
								savedContent: content,
								revealLine: line,
								revealColumn: 1,
								revealVersion: line ? rev : t.revealVersion
							}
						: t
				)
			});
			return;
		}
		const tab: EditorTab = {
			id: `virtual:${uri}`,
			title,
			relPath: null,
			uri,
			language,
			content,
			savedContent: content,
			isDirty: false,
			readOnly: true,
			revealLine: line,
			revealColumn: 1,
			revealVersion: line ? rev : undefined
		};
		store.setState({
			tabs: [...state.tabs, tab],
			activeTabId: tab.id,
			metadataEditorOpen: false
		});
	},

	confirmEdits,
	withWorkspaceLock,
	async waitForWrites(): Promise<void> { await Promise.allSettled(saves.values()); },

	async requestCloseTab(tabId: string): Promise<boolean> {
		let closed = false;
		await withWorkspaceLock(async () => {
			if (!await confirmEdits([tabId])) return;
			store.closeTab(tabId);
			closed = true;
		});
		return closed;
	},

	closeTab(tabId: string): void {
		window.clearTimeout(autoSaveTimers.get(tabId));
		autoSaveTimers.delete(tabId);
		positions.delete(tabId);
		const idx = state.tabs.findIndex((t) => t.id === tabId);
		if (idx < 0) return;
		const closing = state.tabs[idx];
		const nextTabs = state.tabs.filter((t) => t.id !== tabId);
		let nextActive = state.activeTabId;
		if (state.activeTabId === tabId) {
			if (nextTabs.length === 0) {
				nextActive = null;
			} else {
				const fallback = nextTabs[Math.min(idx, nextTabs.length - 1)];
				nextActive = fallback.id;
			}
		}
		store.setState({
			tabs: nextTabs,
			activeTabId: nextActive
		});
		if (closing.language === "java" && !closing.readOnly) {
			void backend.lspDidClose(closing.uri).catch(() => {});
		}
	},

	setActiveTab(tabId: string): void {
		if (!state.tabs.some((t) => t.id === tabId)) return;
		const pos = positions.get(tabId);
		store.setState({ activeTabId: tabId, tabs: pos ? state.tabs.map(t => t.id === tabId
			? {...t, revealLine: pos.line, revealColumn: pos.column, revealVersion: revealCounter++} : t) : state.tabs });

	},

	updateTabContent(tabId: string, content: string, autoSave = true): void {
		const target = state.tabs.find((t) => t.id === tabId);
		if (state.workspaceBusy || !target || target.readOnly) return;
		store.setState({
			tabs: state.tabs.map((t) =>
				t.id === tabId
					? { ...t, content, isDirty: Boolean(t.external) || content !== t.savedContent }
					: t
			)
		});
		if (autoSave && !target.external && state.settings.autoSave && target.relPath) {
			scheduleAutoSave(tabId);
		}
	},

	async refreshDocument(tabId: string): Promise<void> {
		await saves.get(tabId)?.catch(() => {});
		const tab = state.tabs.find(t => t.id === tabId);
		if (!tab?.relPath) return;
		const disk = await backend.diskContent(tab.relPath);
		if (!state.tabs.includes(tab)) {
			if (state.tabs.some(t => t.uri === tab.uri)) await store.refreshDocument(tabId);
			return;
		}
		if (saves.has(tabId)) { await store.refreshDocument(tabId); return; }
		if (disk === tab.savedContent && !tab.external) return;
		const updated = disk !== null && (!tab.isDirty || disk === tab.content || disk === tab.savedContent)
			? (tab.isDirty && disk === tab.savedContent ? {...tab, external: undefined} : {...tab, savedContent: disk, content: disk, isDirty: false, external: undefined})
			: {...tab, external: {disk}, isDirty: true};
		if (updated.external) window.clearTimeout(autoSaveTimers.get(tabId));
		else if (updated.isDirty && state.settings.autoSave) scheduleAutoSave(tabId);
		store.setState({tabs: state.tabs.map(t => t === tab ? updated : t)});
	},

	useDisk(tabId: string): void {
		const tab = state.tabs.find(t => t.id === tabId);
		if (!tab?.external) return;
		const disk = tab.external.disk;
		if (disk === null) { store.closeTab(tabId); return; }
		store.setState({tabs: state.tabs.map(t => t === tab ? {...t, content: disk, savedContent: disk, external: undefined, isDirty: false} : t)});
	},

	async saveTab(tabId: string, reviewed?: {disk: string | null}): Promise<void> {
		const tab = state.tabs.find((t) => t.id === tabId);
		if (!tab || !tab.relPath || tab.readOnly) return;
		const epoch = workspaceEpoch;
		const path = tab.relPath;
		const previous = saves.get(tabId);
		const write = (async () => {
			await previous?.catch(() => {});
			if (epoch !== workspaceEpoch) return;
			const current = state.tabs.find(t => t.uri === tab.uri);
			if (!current) return;
			const warning = state.settings.language === "ko" ? "디스크 변경 내용을 먼저 확인해 주세요." : "Review the changes on disk first.";
			if (reviewed ? current.external !== reviewed : Boolean(current.external)) throw Error(warning);
			const expected = reviewed ? reviewed.disk : current.savedContent;
			const result = await backend.writeFile(path, tab.content, expected);
			if (result) {
				window.clearTimeout(autoSaveTimers.get(tabId));
				store.setState({tabs: state.tabs.map(t => t.uri === tab.uri ? {...t, external: result, isDirty: true} : t)});
				throw Error(warning);
			}
			store.setState({
				tabs: state.tabs.map((t) =>
					t.id === tabId ? { ...t, external: undefined, savedContent: tab.content, isDirty: t.content !== tab.content } : t
				)
			});
			if (tab.language === "java") {
				if (state.lspState !== "idle" && state.lspState !== "error") {
					try {
						if (epoch !== workspaceEpoch) return;
						await flushJavaDocument(tab.uri, tab.content);
						await backend.lspDidSave(tab.uri, tab.content);
					} catch (err) {
						if (state.debugSession) store.appendDebugLog("event", String(err));
					}
				}
			}
			if (
				path.endsWith("fabric.mod.json") ||
				tab.relPath === "gradle.properties"
			) {
				try {
					const fabricMeta = await backend.inspectFabricProject();
					if (epoch === workspaceEpoch && state.project) {
						store.setState({ project: { ...state.project, fabricMeta } });
					}
				} catch {
					// Ignore metadata inspection error
				}
			}
		})();
		saves.set(tabId, write);
		try { await write; } finally { if (saves.get(tabId) === write) saves.delete(tabId); }
	},

	async saveActiveTab(): Promise<void> {
		if (!state.activeTabId) return;
		await store.saveTab(state.activeTabId);
	},

	async saveAllTabs(): Promise<void> {
		const dirtyTabs = state.tabs.filter((t) => t.isDirty && t.relPath && !t.readOnly);
		for (const tab of dirtyTabs) {
			await store.saveTab(tab.id);
		}
	},

	toggleBreakpoint(filePath: string, line: number): void {
		const key = resolveBreakpointKey(filePath);
		const current = state.breakpoints[key] ?? [];
		const exists = current.includes(line);
		const updated = exists
			? current.filter((l) => l !== line)
			: [...current, line].sort((a, b) => a - b);
		const nextMap = { ...state.breakpoints };
		if (updated.length === 0) {
			delete nextMap[key];
		} else {
			nextMap[key] = updated;
		}
		store.setState({ breakpoints: nextMap });
		if (state.debugSession) {
			void backend.debugSetBreakpoints(key, updated).catch((err) => {
				store.showToast("error", String(err));
			});
		}
	},

	setSidebarTab(tab: SidebarTab): void {
		store.setState({ sidebarTab: tab, sidebarVisible: true });
	},

	toggleSidebar(): void {
		store.setState((prev) => ({ sidebarVisible: !prev.sidebarVisible }));
	},

	setSidebarWidth(width: number): void {
		const clamped = Math.max(180, Math.min(420, Math.round(width)));
		store.setState({ sidebarWidth: clamped });
	},

	setBottomTab(tab: BottomTab): void {
		store.setState({ bottomTab: tab, bottomVisible: true });
	},

	toggleBottom(): void {
		store.setState((prev) => ({ bottomVisible: !prev.bottomVisible }));
	},

	setBottomHeight(height: number): void {
		const clamped = Math.max(120, Math.min(420, Math.round(height)));
		store.setState({ bottomHeight: clamped });
	},

	setActiveModal(modal: ActiveModal): void {
		store.setState({ activeModal: modal });
	},

	setMetadataEditorOpen(open: boolean): void {
		store.setState({ metadataEditorOpen: open });
	},

	async runGradle(task: GradleTaskKind): Promise<void> {
		if (!state.project || state.workspaceBusy || state.activeGradleTask) return;
		const epoch = workspaceEpoch;
		await store.saveAllTabs();
		if (workspaceEpoch !== epoch || state.workspaceBusy) return;
		const id = nextLogId++;
		store.setState({
			bottomVisible: true,
			bottomTab: "build",
			gradleState: "starting",
			activeGradleTask: task,
			buildProblems: [],
			gradleOutput: [
				...state.gradleOutput,
				{ id, stream: "info", text: `> gradlew ${task}` }
			]
		});
		try {
			const status = await trackStart(backend.runGradleTask(task));
			if (
				workspaceEpoch !== epoch ||
				state.activeGradleTask !== task ||
				(state.gradleState !== "starting" && state.gradleState !== "running")
			) {
				return;
			}
			store.setState({
				activeProcessId: status.processId,
				gradleState: status.state
			});
		} catch (err) {
			if (epoch !== workspaceEpoch) return;
			store.setState({ gradleState: "failed", activeGradleTask: null });
			store.showToast("error", String(err));
		}
	},

	async startTerminal(): Promise<string> {
		const id = "term-" + crypto.randomUUID();
		store.setState({ terminalSessionId: id, terminalExited: false });
		try {
			await trackStart(backend.terminalStart(id));
			return id;
		} catch (err) {
			if (state.terminalSessionId === id) store.setState({ terminalSessionId: null });
			throw err;
		}
	},

	async stopActiveGradle(): Promise<void> {
		if (!state.activeProcessId) return;
		await backend.stopProcess(state.activeProcessId);
	},

	async startDebug(): Promise<void> {
		if (!state.project || state.workspaceBusy) return;
		const epoch = workspaceEpoch;
		await store.saveAllTabs();
		if (workspaceEpoch !== epoch || state.workspaceBusy) return;
		const groups: SourceBreakpointGroup[] = Object.entries(state.breakpoints).map(
			([filePath, lines]) => ({ filePath, lines })
		);
		store.setState({
			sidebarTab: "debug",
			sidebarVisible: true,
			bottomTab: "debugConsole",
			bottomVisible: true,
			debugLogs: [],
			debugPausedLocation: null
		});
		store.appendDebugLog(
			"event",
			pickMsg(
				state.settings.language,
				"디버그 클라이언트 시작 중...",
				"Starting debug client...",
				"正在启动调试客户端...",
				"デバッグクライアントを起動中..."
			)
		);
		try {
			const session = await trackStart(backend.startDebugClient(groups));
			if (epoch !== workspaceEpoch) return;
			store.setState({ debugSession: session });
			store.appendDebugLog(
				"event",
				`JDWP :${session.jdwpPort} · DAP :${session.dapPort}`
			);
		} catch (err) {
			if (epoch !== workspaceEpoch) return;
			store.appendDebugLog("error", String(err));
			store.showToast("error", String(err));
		}
	},

	async stopDebug(): Promise<void> {
		await backend.stopDebugSession();
		store.setState({ debugSession: null, debugPausedLocation: null });
	},

	appendDebugLog(kind: DebugLogLine["kind"], text: string): void {
		const id = nextLogId++;
		const next = [...state.debugLogs, { id, kind, text }];
		if (next.length > 1000) {
			next.splice(0, next.length - 1000);
		}
		store.setState({ debugLogs: next });
	},

	showToast(kind: ToastKind, text: string): void {
		const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
		store.setState((prev) => ({
			toasts: [...prev.toasts.slice(-3), { id, kind, text }]
		}));
		const timer = window.setTimeout(() => {
			toastTimers.delete(id);
			store.dismissToast(id);
		}, 4200);
		toastTimers.set(id, timer);
	},

	dismissToast(id: string): void {
		const timer = toastTimers.get(id);
		if (timer !== undefined) {
			window.clearTimeout(timer);
			toastTimers.delete(id);
		}
		store.setState((prev) => ({
			toasts: prev.toasts.filter((t) => t.id !== id)
		}));
	},

	async setLanguage(language: AppLanguage): Promise<void> {
		await store.updateSettings({ language });
	},

	async setTheme(theme: AppTheme): Promise<void> {
		await store.updateSettings({ theme });
	},

	async toggleTheme(): Promise<void> {
		const currentlyDark = resolveIsDark(state.settings.theme, state.systemPrefersDark);
		const targetScheme: "light" | "dark" = currentlyDark ? "light" : "dark";
		const systemScheme: "light" | "dark" = state.systemPrefersDark ? "dark" : "light";
		const nextTheme: AppTheme = targetScheme === systemScheme ? "system" : targetScheme;
		await store.updateSettings({ theme: nextTheme });
	},

	async updateSettings(patch: Partial<AppSettings>): Promise<void> {
		const next: AppSettings = { ...state.settings, ...patch };
		document.documentElement.lang = next.language;
		applyThemeToDocument(next.theme, state.systemPrefersDark);
		store.setState({ settings: next });
		try {
			await backend.saveSettings(next);
		} catch (err) {
			store.showToast("error", String(err));
		}
	},

	setProgressTask(progressTask: ProgressTask | null): void {
		store.setState({ progressTask });
	},

	refreshDiagnostics(uri: string, diagnostics: LspDiagnostic[]): void {
		const next = { ...state.lspDiagnostics };
		if (diagnostics.length === 0) {
			delete next[uri];
		} else {
			next[uri] = diagnostics;
		}
		store.setState({ lspDiagnostics: next });
	},

	async startLspForWorkspace(): Promise<void> {
		if (!state.project || state.lspState === "starting") return;
		const epoch = workspaceEpoch;
		store.setState({
			lspState: "starting",
			lspMessage: pickMsg(
				state.settings.language,
				"Java 언어 서버 시작 중...",
				"Starting Java language server...",
				"正在启动 Java 语言服务器...",
				"Java 言語サーバーを起動中..."
			),
			lspPercent: null
		});
		try {
			await trackStart(backend.startLanguageServer());
			if (epoch !== workspaceEpoch) return;
			const toolStatus = await backend.getToolStatus();
			if (epoch !== workspaceEpoch) return;
			store.setState({ toolStatus });
		} catch (err) {
			if (epoch !== workspaceEpoch) return;
			store.setState({
				lspState: "error",
				lspMessage: String(err),
				lspPercent: null
			});
		}
	},

	async ensureTools(): Promise<void> {
		store.setProgressTask({
			label: pickMsg(
				state.settings.language,
				"JDT LS 및 Java Debug 설치 확인 중...",
				"Preparing JDT LS and Java Debug...",
				"正在准备 JDT LS 与 Java Debug...",
				"JDT LS と Java Debug を準備中..."
			),
			step: 1,
			totalSteps: 4,
			percent: 0,
			indeterminate: true
		});
		try {
			const toolStatus = await backend.ensureJdtlsInstalled();
			store.setState({ toolStatus });
			store.setProgressTask(null);
			store.showToast(
				"success",
				pickMsg(
					state.settings.language,
					"Java 개발 도구 준비가 완료됐어요.",
					"Java developer tools are ready.",
					"Java 开发工具已准备就绪。",
					"Java 開発ツールの準備が完了しました。"
				)
			);
			if (state.project) {
				await store.startLspForWorkspace();
			}
		} catch (err) {
			store.setProgressTask(null);
			store.showToast("error", String(err));
		}
	},

	setCursorPosition(cursorLine: number, cursorColumn: number): void {
		if (state.activeTabId) positions.set(state.activeTabId, {line: cursorLine, column: cursorColumn});
		store.setState({ cursorLine, cursorColumn });
	},

	clearGradleOutput(): void {
		logBatch = [];
		store.setState({ gradleOutput: [] });
	},

	clearDebugLogs(): void {
		store.setState({ debugLogs: [] });
	}
};

export function useStore<T>(selector: (s: StoreState) => T): T {
	return useSyncExternalStore(
		store.subscribe,
		() => selector(store.getState()),
		() => selector(store.getState())
	);
}