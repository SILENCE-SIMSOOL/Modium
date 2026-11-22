import { backend } from "./backend";
import { monaco } from "./monacoSetup";
import { translateByLang } from "../i18n";
import { fromFileUri, store } from "../state/store";
import type { LspDiagnostic } from "../types/ipc";

let providersRegistered = false;
interface OpenDocument {
	version: number;
	text?: string;
	queue: Promise<void>;
	timer?: number;
}
const documents = new Map<string, OpenDocument>();

interface LspPosition {
	line: number;
	character: number;
}

interface LspRange {
	start: LspPosition;
	end: LspPosition;
}

interface LspLocation {
	uri?: string;
	targetUri?: string;
	range?: LspRange;
	targetSelectionRange?: LspRange;
	targetRange?: LspRange;
}

interface LspTextEdit {
	range: LspRange;
	newText: string;
}

interface LspCompletionItem {
	label: string | { label: string };
	kind?: number;
	labelDetails?: { detail?: string; description?: string };
	detail?: string;
	documentation?: string | { value: string };
	insertText?: string;
	insertTextFormat?: number;
	sortText?: string;
	filterText?: string;
	textEdit?: LspTextEdit | { insert: LspRange; replace: LspRange; newText: string };
	additionalTextEdits?: LspTextEdit[];
}

function toMonacoRange(r: LspRange): monaco.IRange {
	return {
		startLineNumber: r.start.line + 1,
		startColumn: r.start.character + 1,
		endLineNumber: r.end.line + 1,
		endColumn: r.end.character + 1
	};
}

function toLspPosition(pos: monaco.IPosition): LspPosition {
	return {
		line: Math.max(0, pos.lineNumber - 1),
		character: Math.max(0, pos.column - 1)
	};
}

function mapCompletionKind(lspKind?: number): monaco.languages.CompletionItemKind {
	const k = monaco.languages.CompletionItemKind;
	switch (lspKind) {
		case 2:
			return k.Method;
		case 3:
			return k.Function;
		case 4:
			return k.Constructor;
		case 5:
			return k.Field;
		case 6:
			return k.Variable;
		case 7:
			return k.Class;
		case 8:
			return k.Interface;
		case 9:
			return k.Module;
		case 10:
			return k.Property;
		case 12:
			return k.Value;
		case 13:
			return k.Enum;
		case 14:
			return k.Keyword;
		case 15:
			return k.Snippet;
		case 20:
			return k.EnumMember;
		case 21:
			return k.Constant;
		case 22:
			return k.Struct;
		case 25:
			return k.TypeParameter;
		default:
			return k.Text;
	}
}

function mapCompletion(item: LspCompletionItem, fallback: monaco.languages.CompletionItem["range"]): monaco.languages.CompletionItem {
	const label = typeof item.label === "string" ? item.label : item.label.label;
	const edit = item.textEdit;
	const type = [7, 8, 13, 22].includes(item.kind ?? 0);
	const qualified = type ? item.detail?.match(/(?:[\w$]+\.)+[\w$]+/)?.[0] : undefined;
	const description = item.labelDetails?.description || qualified;
	return {
		label: {label, detail: item.labelDetails?.detail, description},
		kind: mapCompletionKind(item.kind),
		detail: item.detail,
		documentation: typeof item.documentation === "string" ? item.documentation : item.documentation?.value,
		insertText: edit?.newText ?? item.insertText ?? label,
		insertTextRules: item.insertTextFormat === 2 ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
		range: !edit ? fallback : "range" in edit ? toMonacoRange(edit.range) : {insert: toMonacoRange(edit.insert), replace: toMonacoRange(edit.replace)},
		sortText: item.sortText,
		filterText: item.filterText,
		additionalTextEdits: item.additionalTextEdits?.map(e => ({range: toMonacoRange(e.range), text: e.newText}))
	};
}

function normalizeLocations(raw: unknown): monaco.languages.Location[] {
	if (!raw) return [];
	const arr = Array.isArray(raw) ? raw : [raw];
	const out: monaco.languages.Location[] = [];
	for (const item of arr as LspLocation[]) {
		const targetUri = item.targetUri ?? item.uri;
		const targetRange = item.targetSelectionRange ?? item.targetRange ?? item.range;
		if (!targetUri || !targetRange) continue;
		out.push({
			uri: monaco.Uri.parse(targetUri),
			range: toMonacoRange(targetRange)
		});
	}
	return out;
}

function parseJdtClassTitle(uri: string): string {
	const match = uri.match(/\/([^/]+?)\.class/);
	if (match?.[1]) return `${match[1]}.java`;
	const lastSlash = uri.lastIndexOf("/");
	return lastSlash >= 0 ? uri.slice(lastSlash + 1) : "ClassFile.java";
}

function toWorkspaceEdit(raw: unknown): monaco.languages.WorkspaceEdit | null {
	if (!raw || typeof raw !== "object") return null;
	const editObj = raw as {
		changes?: Record<string, LspTextEdit[]>;
		documentChanges?: Array<{
			textDocument?: { uri: string };
			edits?: LspTextEdit[];
		}>;
	};
	const edits: monaco.languages.IWorkspaceTextEdit[] = [];

	if (editObj.changes) {
		for (const [uriStr, list] of Object.entries(editObj.changes)) {
			const resource = monaco.Uri.parse(uriStr);
			for (const te of list) {
				edits.push({
					resource,
					versionId: undefined,
					textEdit: { range: toMonacoRange(te.range), text: te.newText }
				});
			}
		}
	}

	if (Array.isArray(editObj.documentChanges)) {
		for (const dc of editObj.documentChanges) {
			if (!dc.textDocument?.uri || !Array.isArray(dc.edits)) return null;
			const resource = monaco.Uri.parse(dc.textDocument.uri);
			for (const te of dc.edits) {
				edits.push({
					resource,
					versionId: undefined,
					textEdit: { range: toMonacoRange(te.range), text: te.newText }
				});
			}
		}
	}

	return { edits };
}

function isLspActive(): boolean {
	const s = store.getState();
	return Boolean(s.project && s.lspState !== "idle" && s.lspState !== "error");
}

export function registerJavaLspProviders(): void {
	if (providersRegistered) return;
	providersRegistered = true;

	monaco.editor.registerEditorOpener({
		async openCodeEditor(_source, resource, selectionOrPosition) {
			const uriStr = resource.toString();
			const line =
				selectionOrPosition && "startLineNumber" in selectionOrPosition
					? selectionOrPosition.startLineNumber
					: selectionOrPosition?.lineNumber;
			const col =
				selectionOrPosition && "startColumn" in selectionOrPosition
					? selectionOrPosition.startColumn
					: selectionOrPosition?.column;

			if (uriStr.startsWith("jdt://")) {
				try {
					const content = await backend.lspClassFileContents(uriStr);
					store.openVirtualTab(parseJdtClassTitle(uriStr), uriStr, "java", content, line);
					return true;
				} catch {
					return false;
				}
			}

			const relPath = fromFileUri(uriStr, store.getState().project?.path ?? null);
			if (relPath) {
				await store.openFileTab(relPath, line, col);
				return true;
			}
			return false;
		}
	});

	const semanticTypes = ["namespace","class","interface","enum","enumMember","type","typeParameter","method","property","variable","parameter","modifier","keyword","decorator","annotationMember","record","recordComponent"];
	monaco.languages.registerDocumentSemanticTokensProvider("java", {
		getLegend: () => ({tokenTypes: semanticTypes, tokenModifiers: []}),
		onDidChange: notify => {
			let previous = store.getState().lspState;
			const dispose = store.subscribe(() => {
				const next = store.getState().lspState;
				if (next === previous) return;
				previous = next;
				if (next === "ready") notify();
			});
			return {dispose};
		},
		async provideDocumentSemanticTokens(model, _last, token) {
			if (!isLspActive() || model.uri.scheme !== "file") return null;
			const version = model.getVersionId();
			const uri = model.uri.toString();
			try {
				await flushJavaDocument(uri, model.getValue());
				if (token.isCancellationRequested) return null;
				const reply = await backend.lspSemanticTokens(uri);
				if (!reply?.data || token.isCancellationRequested || model.isDisposed() || version !== model.getVersionId()) return null;
				const indices = reply.types.map(type => semanticTypes.indexOf(type));
				const data = Uint32Array.from(reply.data);
				for (let i = 3; i < data.length; i += 5) {
					data[i] = Math.max(0, indices[data[i]] ?? 0);
					data[i+1] = 0;
				}
				return {data};
			} catch { return null; }
		},
		releaseDocumentSemanticTokens() {}
	});
	const originals = new WeakMap<monaco.languages.CompletionItem, LspCompletionItem>();
	monaco.languages.registerCompletionItemProvider("java", {
		triggerCharacters: [".", "@", ":"],
		async provideCompletionItems(model, position, _context, token) {
			if (!isLspActive() || model.uri.scheme !== "file") return { suggestions: [] };
			const version = model.getVersionId();
			const project = store.getState().project;
			const uri = model.uri.toString();
			const word = model.getWordUntilPosition(position);
			const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
			try {
				await flushJavaDocument(uri, model.getValue());
				if (token.isCancellationRequested || model.getVersionId() !== version) return { suggestions: [] };
				const raw = await backend.lspCompletion(uri, position.lineNumber - 1, position.column - 1);
				if (token.isCancellationRequested || model.getVersionId() !== version) return { suggestions: [] };
				if (project !== store.getState().project) return { suggestions: [] };
				if (store.getState().completionFailures) store.setState({completionFailures: 0, completionError: ""});
				const list = raw as { items?: LspCompletionItem[]; isIncomplete?: boolean } | null;
				const items: LspCompletionItem[] = Array.isArray(raw) ? raw : list?.items ?? [];
				return {
					incomplete: list?.isIncomplete,
					suggestions: items.map(item => {
						const suggestion = mapCompletion(item, range);
						originals.set(suggestion, item);
						return suggestion;
					})
				};
			} catch (error) {
				if (!token.isCancellationRequested && !model.isDisposed() && model.getVersionId() === version && project === store.getState().project && !/cancel(?:led|ed)|-3280[012]/i.test(String(error))) {
					store.setState(prev => ({completionFailures: prev.completionFailures + 1, completionError: String(error)}));
				}
				return { suggestions: [] };
			}
		},
		async resolveCompletionItem(suggestion, token) {
			const item = originals.get(suggestion);
			if (!item || token.isCancellationRequested) return suggestion;
			try {
				const resolved = await backend.lspResolveCompletion(item) as LspCompletionItem;
				if (resolved && !token.isCancellationRequested) Object.assign(suggestion, mapCompletion({...item, ...resolved}, suggestion.range));
			} catch { /* The original proposal can still be accepted. */ }
			return suggestion;
		}
	});

	monaco.languages.registerHoverProvider("java", {
		async provideHover(model, position) {
			if (!isLspActive()) return null;
			const uri = model.uri.toString();
			const pos = toLspPosition(position);
			try {
				const raw = (await backend.lspHover(uri, pos.line, pos.character)) as {
					contents?: unknown;
					range?: LspRange;
				} | null;
				if (!raw || !raw.contents) return null;
				const parts = Array.isArray(raw.contents) ? raw.contents : [raw.contents];
				const contents: monaco.IMarkdownString[] = parts
					.map((entry) => {
						if (typeof entry === "string") return { value: entry };
						if (entry && typeof entry === "object" && "value" in entry) {
							const obj = entry as { language?: string; value: string };
							if (obj.language) {
								return { value: `\`\`\`${obj.language}\n${obj.value}\n\`\`\`` };
							}
							return { value: obj.value };
						}
						return null;
					})
					.filter((v): v is monaco.IMarkdownString => v !== null);
				if (contents.length === 0) return null;
				return {
					contents,
					range: raw.range ? toMonacoRange(raw.range) : undefined
				};
			} catch {
				return null;
			}
		}
	});

	monaco.languages.registerDefinitionProvider("java", {
		async provideDefinition(model, position) {
			if (!isLspActive()) return [];
			const pos = toLspPosition(position);
			try {
				const raw = await backend.lspDefinition(
					model.uri.toString(),
					pos.line,
					pos.character
				);
				return normalizeLocations(raw);
			} catch {
				return [];
			}
		}
	});

	monaco.languages.registerReferenceProvider("java", {
		async provideReferences(model, position, context) {
			if (!isLspActive()) return [];
			const pos = toLspPosition(position);
			try {
				const raw = await backend.lspReferences(
					model.uri.toString(),
					pos.line,
					pos.character,
					context.includeDeclaration
				);
				return normalizeLocations(raw);
			} catch {
				return [];
			}
		}
	});

	monaco.languages.registerRenameProvider("java", {
		async provideRenameEdits(model, position, newName) {
			if (!isLspActive()) return null;
			const pos = toLspPosition(position);
			try {
				const raw = await backend.lspRename(
					model.uri.toString(),
					pos.line,
					pos.character,
					newName
				);
				return toWorkspaceEdit(raw);
			} catch {
				return null;
			}
		}
	});

	monaco.languages.registerCodeActionProvider("java", {
		async provideCodeActions(model, range, context) {
			if (!isLspActive() || model.uri.scheme !== "file") return { actions: [], dispose: () => {} };
			const uri = model.uri.toString();
			const diagnostics: LspDiagnostic[] = context.markers.map((m) => ({
				rangeStartLine: m.startLineNumber - 1,
				rangeStartChar: m.startColumn - 1,
				rangeEndLine: m.endLineNumber - 1,
				rangeEndChar: m.endColumn - 1,
				severity:
					m.severity === monaco.MarkerSeverity.Error
						? 1
						: m.severity === monaco.MarkerSeverity.Warning
							? 2
							: 3,
				code: typeof m.code === "string" ? m.code : m.code?.value ?? null,
				source: m.source ?? null,
				message: m.message
			}));
			try {
				const raw = await backend.lspCodeAction(
					uri,
					range.startLineNumber - 1,
					range.startColumn - 1,
					range.endLineNumber - 1,
					range.endColumn - 1,
					diagnostics
				);
				if (!Array.isArray(raw)) return { actions: [], dispose: () => {} };
				const actions: monaco.languages.CodeAction[] = [];
				for (const item of raw) {
					if (!item?.title || item.disabled) continue;
					const command = typeof item.command === "string" ? item : item.command;
					if (command && command.command !== "java.apply.workspaceEdit") continue;
					const edit = toWorkspaceEdit(item.edit ?? command?.arguments?.[0]);
					const root = store.getState().project?.path ?? null;
					const file = fromFileUri(uri, root);
					if (!file || !edit?.edits.length || !edit.edits.every(e => "textEdit" in e && fromFileUri(e.resource.toString(), root) === file)) continue;
					actions.push({title: item.title, kind: item.kind, edit: {edits: edit.edits.map(e => ({...e, resource: model.uri}))}});
				}
				return { actions, dispose: () => {} };
			} catch {
				return { actions: [], dispose: () => {} };
			}
		}
	});

	monaco.languages.registerDocumentFormattingEditProvider("java", {
		async provideDocumentFormattingEdits(model, options) {
			if (!isLspActive()) return [];
			try {
				const raw = await backend.lspFormatting(
					model.uri.toString(),
					options.tabSize,
					options.insertSpaces
				);
				if (!Array.isArray(raw)) return [];
				return (raw as LspTextEdit[]).map((te) => ({
					range: toMonacoRange(te.range),
					text: te.newText
				}));
			} catch {
				return [];
			}
		}
	});
}

export function flushJavaDocument(rawUri: string, text: string): Promise<void> {
	const uri = monaco.Uri.parse(rawUri).toString();
	let doc = documents.get(uri);
	if (!doc) {
		doc = {version: 0, queue: Promise.resolve()};
		documents.set(uri, doc);
	}
	const current = doc;
	window.clearTimeout(current.timer);
	current.queue = current.queue.catch(() => {}).then(async () => {
		if (documents.get(uri) !== current || current.text === text) return;
		if (!current.version) await backend.lspDidOpen(uri, "java", 1, text);
		else await backend.lspDidChange(uri, current.version + 1, text);
		current.version++;
		current.text = text;
	});
	return current.queue;
}

export function syncLspOpen(uri: string, language: string, text: string): void {
	if (language === "java" && uri.startsWith("file:")) void flushJavaDocument(uri, text).catch(() => {});
}

export function syncLspChange(uri: string, language: string, text: string): void {
	if (language !== "java" || !uri.startsWith("file:") || !isLspActive()) return;
	const doc = documents.get(monaco.Uri.parse(uri).toString());
	if (!doc) { syncLspOpen(uri, language, text); return; }
	window.clearTimeout(doc.timer);
	doc.timer = window.setTimeout(() => syncLspOpen(uri, language, text), 150);
}

export function clearLspDocState(rawUri: string): boolean {
	const uri = monaco.Uri.parse(rawUri).toString();
	window.clearTimeout(documents.get(uri)?.timer);
	return documents.delete(uri);
}

export function clearAllLspDocStates(): void {
	for (const doc of documents.values()) {
		window.clearTimeout(doc.timer);
	}
	documents.clear();
}

export function syncLspClose(uri: string): void {
	if (clearLspDocState(uri)) void backend.lspDidClose(uri).catch(() => {});
}

export async function retryJavaCompletion(editor: monaco.editor.IStandaloneCodeEditor): Promise<void> {
	const model = editor.getModel();
	const position = editor.getPosition();
	if (!model || !position || model.getLanguageId() !== "java" || model.uri.scheme !== "file") return;
	const uri = model.uri.toString();
	const version = model.getVersionId();
	editor.focus();
	try {
		await flushJavaDocument(uri, model.getValue());
		await backend.lspCompletion(uri, position.lineNumber - 1, position.column - 1);
		if (editor.getModel() !== model || model.getVersionId() !== version) return;
		store.setState({completionFailures: 0, completionError: ""});
		editor.trigger("modium", "editor.action.triggerSuggest", {});
	} catch (error) {
		if (editor.getModel() === model && model.getVersionId() === version) store.setState({completionError: String(error)});
	}
}

function chooseImports(groups: string[][], lang: Parameters<typeof translateByLang>[0]): Promise<string[] | null> {
	const dialog = document.createElement("dialog");
	dialog.className = "fs-import-dialog";
	const title = document.createElement("h3");
	title.textContent = translateByLang(lang, "가져올 패키지 선택", "Choose imports");
	dialog.setAttribute("aria-label", title.textContent);
	dialog.append(title);
	const selects = groups.map(names => {
		const label = document.createElement("label");
		label.textContent = names[0]?.split(".").pop() ?? "";
		const select = document.createElement("select");
		select.add(new Option(translateByLang(lang, "패키지 선택", "Select package"), ""));
		for (const name of names) select.add(new Option(name, name));
		label.append(select);
		dialog.append(label);
		return select;
	});
	const cancel = document.createElement("button");
	cancel.textContent = translateByLang(lang, "취소", "Cancel");
	cancel.className = "fs-btn";
	cancel.onclick = () => dialog.close();
	const apply = document.createElement("button");
	apply.textContent = translateByLang(lang, "적용", "Apply");
	apply.className = "fs-btn fs-btn--primary";
	apply.disabled = true;
	dialog.onchange = () => { apply.disabled = selects.some(select => !select.value); };
	apply.onclick = () => dialog.close("apply");
	dialog.append(cancel, apply);
	document.body.append(dialog);
	return new Promise(resolve => {
		dialog.onclose = () => {
			dialog.remove();
			resolve(dialog.returnValue === "apply" ? selects.map(select => select.value) : null);
		};
		dialog.showModal();
	});
}

export async function organizeJavaImports(editor: monaco.editor.IStandaloneCodeEditor): Promise<void> {
	const model = editor.getModel();
	if (!model || model.getLanguageId() !== "java" || model.uri.scheme !== "file") return;
	const lang = store.getState().settings.language;
	if (!isLspActive()) throw new Error(translateByLang(lang, "상태 표시줄에서 Java 언어 서버를 시작해 주세요.", "Start the Java language server from the status bar."));
	const version = model.getVersionId();
	const uri = model.uri.toString();
	await flushJavaDocument(uri, model.getValue());
	let reply = await backend.lspOrganizeImports(uri);
	while (reply.groups?.length) {
		if (editor.getModel() !== model || model.getVersionId() !== version) return;
		const selected = await chooseImports(reply.groups, lang);
		if (!selected || editor.getModel() !== model || model.getVersionId() !== version) return;
		reply = await backend.lspOrganizeImports(uri, selected);
	}
	const changes = toWorkspaceEdit(reply.edit);
	if (editor.getModel() !== model || model.getVersionId() !== version) return;
	const root = store.getState().project?.path ?? null;
	const file = fromFileUri(uri, root);
	const edits = (changes?.edits ?? []).flatMap(edit =>
		"textEdit" in edit && file && fromFileUri(edit.resource.toString(), root) === file
			? [{range: edit.textEdit.range, text: edit.textEdit.text}] : []);
	if (!edits.length) return;
	editor.pushUndoStop();
	editor.executeEdits("modium.organizeImports", edits);
	editor.pushUndoStop();
}

export function applyLspDiagnosticsToModels(
	diagnosticsMap: Record<string, LspDiagnostic[]>
): void {
	for (const model of monaco.editor.getModels()) {
		const uriStr = model.uri.toString();
		const list = diagnosticsMap[uriStr] ?? [];
		const markers: monaco.editor.IMarkerData[] = list.map((d) => ({
			severity:
				d.severity === 1
					? monaco.MarkerSeverity.Error
					: d.severity === 2
						? monaco.MarkerSeverity.Warning
						: d.severity === 3
							? monaco.MarkerSeverity.Info
							: monaco.MarkerSeverity.Hint,
			startLineNumber: d.rangeStartLine + 1,
			startColumn: d.rangeStartChar + 1,
			endLineNumber: d.rangeEndLine + 1,
			endColumn: d.rangeEndChar + 1,
			message: d.message,
			code: d.code ?? undefined,
			source: d.source ?? "jdtls"
		}));
		monaco.editor.setModelMarkers(model, "jdtls", markers);
	}
}