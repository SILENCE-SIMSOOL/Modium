import { useEffect, useRef } from "react";
import { translateByLang } from "../i18n";
import {
	applyLspDiagnosticsToModels,
	clearLspDocState,
	registerJavaLspProviders,
	organizeJavaImports,
	retryJavaCompletion,
	syncLspChange,
	syncLspOpen
} from "../services/lspBridge";
import { ensureMonacoSetup, monaco } from "../services/monacoSetup";
import {
	joinWorkspacePath,
	normalizePathSlashes,
	store,
	useStore,
	type EditorTab
} from "../state/store";

export interface MonacoEditorProps {
	tab: EditorTab;
}

export function MonacoEditor({ tab }: MonacoEditorProps) {
	const hostRef = useRef<HTMLDivElement>(null);
	const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
	const decorationsRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
	const tabRef = useRef<EditorTab>(tab);
	const lastEditorText = useRef<string | null>(null);
	const syncingPropRef = useRef(false);

	tabRef.current = tab;

	const project = useStore((s) => s.project);
	const fontSize = useStore((s) => s.settings.fontSize);
	const tabSize = useStore((s) => s.settings.tabSize);
	const breakpoints = useStore((s) => s.breakpoints);
	const debugPausedLocation = useStore((s) => s.debugPausedLocation);
	const lspState = useStore(s => s.lspState);
	const lspDiagnostics = useStore((s) => s.lspDiagnostics);

	useEffect(() => {
		const container = hostRef.current;
		if (!container) return;

		ensureMonacoSetup();
		registerJavaLspProviders();

		const editor = monaco.editor.create(container, {
			automaticLayout: true,
			"semanticHighlighting.enabled": true,
			glyphMargin: true,
			minimap: { enabled: false },
			scrollBeyondLastLine: false,
			smoothScrolling: true,
			cursorSmoothCaretAnimation: "on",
			fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
			fontLigatures: true,
			fontSize,
			tabSize,
			detectIndentation: true,
			renderWhitespace: "selection",
			lineNumbersMinChars: 4,
			padding: { top: 8, bottom: 8 },
			readOnly: Boolean(tab.readOnly)
		});

		editor.addAction({
			id: "modium.organizeImports",
			label: translateByLang(store.getState().settings.language, "import 정리", "Organize Imports"),
			precondition: "editorLangId == java && !editorReadonly",
			keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyO],
			contextMenuGroupId: "1_modification",
			run: () => organizeJavaImports(editor).catch(err => store.showToast("error", String(err)))
		});
		const retryCompletion = () => void retryJavaCompletion(editor);
		window.addEventListener("modium:retry-completion", retryCompletion);
		editorRef.current = editor;
		decorationsRef.current = editor.createDecorationsCollection([]);

		editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
			void store.saveActiveTab();
		});

		const contentSub = editor.onDidChangeModelContent(() => {
			if (syncingPropRef.current) return;
			const active = tabRef.current;
			if (active.readOnly) return;
			const model = editor.getModel();
			if (!model) return;
			const nextVal = model.getValue();
			lastEditorText.current = nextVal;
			store.updateTabContent(active.id, nextVal);
			syncLspChange(active.uri, active.language, nextVal);
		});

		const cursorSub = editor.onDidChangeCursorPosition((e) => {
			store.setCursorPosition(e.position.lineNumber, e.position.column);
		});

		const mouseSub = editor.onMouseDown((e) => {
			const active = tabRef.current;
			if (!active.relPath || active.readOnly) return;
			const t = e.target.type;
			if (
				t === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN ||
				t === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS
			) {
				const line = e.target.position?.lineNumber;
				if (line) {
					store.toggleBreakpoint(active.relPath, line);
				}
			}
		});

		return () => {
			window.removeEventListener("modium:retry-completion", retryCompletion);
			contentSub.dispose();
			cursorSub.dispose();
			mouseSub.dispose();
			decorationsRef.current?.clear();
			editor.dispose();
			editorRef.current = null;
			decorationsRef.current = null;
		};
	}, []);

	useEffect(() => {
		const editor = editorRef.current;
		if (!editor) return;

		const uri = monaco.Uri.parse(tab.uri);
		let model = monaco.editor.getModel(uri);
		if (!model) {
			model = monaco.editor.createModel(tab.content, tab.language, uri);
		} else {
			if (model.getLanguageId() !== tab.language) {
				monaco.editor.setModelLanguage(model, tab.language);
			}
			if (model.getValue() !== tab.content) {
				syncingPropRef.current = true;
				model.setValue(tab.content);
				syncingPropRef.current = false;
			}
		}

		if (editor.getModel() !== model) {
			editor.setModel(model);
		}
		editor.updateOptions({
			wordBasedSuggestions: tab.language === "java" ? "off" : "matchingDocuments",
			readOnly: Boolean(tab.readOnly),
			fontSize,
			tabSize
		});
		applyLspDiagnosticsToModels(store.getState().lspDiagnostics);
	}, [tab.id, tab.uri, tab.language, tab.readOnly]);

	useEffect(() => {
		const model = editorRef.current?.getModel();
		if (!model || lastEditorText.current === tab.content) return;
		lastEditorText.current = tab.content;
		if (model.getValue() === tab.content) return;
		syncingPropRef.current = true;
		try { model.setValue(tab.content); }
		finally { syncingPropRef.current = false; }
		if (!tab.readOnly) syncLspChange(tab.uri, tab.language, tab.content);
	}, [tab.uri, tab.content, tab.language, tab.readOnly]);

	useEffect(() => {
		if (tab.readOnly || tab.language !== "java") return;
		if (lspState === "idle" || lspState === "starting") clearLspDocState(tab.uri);
		else if (lspState === "ready" || lspState === "indexing") syncLspOpen(tab.uri, tab.language, tabRef.current.content);
	}, [tab.uri, tab.readOnly, tab.language, lspState]);

	useEffect(() => {
		const editor = editorRef.current;
		if (!editor) return;
		editor.updateOptions({ fontSize, tabSize });
	}, [fontSize, tabSize]);

	useEffect(() => {
		applyLspDiagnosticsToModels(lspDiagnostics);
	}, [lspDiagnostics]);

	useEffect(() => {
		const editor = editorRef.current;
		if (!editor || !tab.revealLine) return;
		const line = Math.max(1, tab.revealLine);
		const col = Math.max(1, tab.revealColumn ?? 1);
		editor.setPosition({ lineNumber: line, column: col });
		editor.revealPositionInCenter({ lineNumber: line, column: col });
		editor.focus();
	}, [tab.id, tab.revealLine, tab.revealColumn, tab.revealVersion]);

	useEffect(() => {
		const collection = decorationsRef.current;
		if (!collection) return;

		const absPath =
			tab.relPath && project?.path
				? joinWorkspacePath(project.path, tab.relPath)
				: null;
		const normAbs = absPath ? normalizePathSlashes(absPath).toLowerCase() : null;

		const nextDecorations: monaco.editor.IModelDeltaDecoration[] = [];

		if (normAbs) {
			for (const [bpFile, lines] of Object.entries(breakpoints)) {
				if (normalizePathSlashes(bpFile).toLowerCase() === normAbs) {
					for (const line of lines) {
						nextDecorations.push({
							range: new monaco.Range(line, 1, line, 1),
							options: {
								isWholeLine: false,
								glyphMarginClassName: "fs-bp-glyph"
							}
						});
					}
				}
			}

			if (
				debugPausedLocation &&
				normalizePathSlashes(debugPausedLocation.filePath).toLowerCase() === normAbs
			) {
				nextDecorations.push({
					range: new monaco.Range(
						debugPausedLocation.line,
						1,
						debugPausedLocation.line,
						1
					),
					options: {
						isWholeLine: true,
						className: "fs-debug-line",
						glyphMarginClassName: "fs-debug-glyph"
					}
				});
			}
		}

		collection.set(nextDecorations);
	}, [tab.id, tab.relPath, project?.path, breakpoints, debugPausedLocation]);

	return <div ref={hostRef} className="fs-monaco-host" />;
}