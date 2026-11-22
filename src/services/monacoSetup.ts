/// <reference types="vite/client" />
import * as monaco from "monaco-editor/editor/editor.api";
import "monaco-editor/editor/browser/widget/codeEditor/codeEditorWidget";
import "monaco-editor/editor/browser/coreCommands";
import "monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens";
import "monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching";
import "monaco-editor/editor/contrib/clipboard/browser/clipboard";
import "monaco-editor/editor/contrib/codeAction/browser/codeActionContributions";
import "monaco-editor/editor/contrib/comment/browser/comment";
import "monaco-editor/editor/contrib/contextmenu/browser/contextmenu";
import "monaco-editor/editor/contrib/find/browser/findController";
import "monaco-editor/features/find/register";
import "monaco-editor/editor/contrib/folding/browser/folding";
import "monaco-editor/editor/contrib/format/browser/formatActions";
import "monaco-editor/editor/contrib/gotoError/browser/gotoError";
import "monaco-editor/editor/contrib/gotoSymbol/browser/goToCommands";
import "monaco-editor/editor/contrib/gotoSymbol/browser/link/goToDefinitionAtPosition";
import "monaco-editor/editor/contrib/hover/browser/hoverContribution";
import "monaco-editor/editor/contrib/indentation/browser/indentation";
import "monaco-editor/editor/contrib/linesOperations/browser/linesOperations";
import "monaco-editor/editor/contrib/multicursor/browser/multicursor";
import "monaco-editor/editor/contrib/parameterHints/browser/parameterHints";
import "monaco-editor/editor/contrib/rename/browser/rename";
import "monaco-editor/editor/contrib/snippet/browser/snippetController2";
import "monaco-editor/editor/contrib/suggest/browser/suggestController";
import "monaco-editor/editor/contrib/wordHighlighter/browser/wordHighlighter";
import "monaco-editor/editor/standalone/browser/quickAccess/standaloneGotoLineQuickAccess";
import "monaco-editor/editor/standalone/browser/referenceSearch/standaloneReferenceSearch";
import "monaco-editor/languages/definitions/java/register";
import "monaco-editor/languages/definitions/kotlin/register";
import "monaco-editor/languages/definitions/xml/register";
import "monaco-editor/languages/definitions/yaml/register";
import "monaco-editor/languages/definitions/markdown/register";
import "monaco-editor/languages/definitions/ini/register";
import { jsonDefaults } from "monaco-editor/languages/features/json/register";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";

let initialized = false;

export function ensureMonacoSetup(): void {
	if (initialized) return;
	initialized = true;

	self.MonacoEnvironment = {
		getWorker(_workerId: string, label: string): Worker {
			if (label === "json") {
				return new JsonWorker();
			}
			return new EditorWorker();
		}
	};

	jsonDefaults.setDiagnosticsOptions({
		validate: true,
		allowComments: true,
		trailingCommas: "error"
	});

	monaco.editor.defineTheme("fabric-dark", {
		base: "vs-dark",
		inherit: true,
		rules: [
			{ token: "property", foreground: "57E5DC" },
			{ token: "recordComponent", foreground: "57E5DC" },
			{ token: "variable", foreground: "FFD76A" },
			{ token: "parameter", foreground: "FFB582" },
			{ token: "method", foreground: "B5AAFF" },
			{ token: "annotationMember", foreground: "B5AAFF" },
			{ token: "class", foreground: "82C9FF" },
			{ token: "interface", foreground: "82C9FF" },
			{ token: "enum", foreground: "82C9FF" },
			{ token: "typeParameter", foreground: "82C9FF" },
			{ token: "record", foreground: "82C9FF" },
			{ token: "enumMember", foreground: "F6A6DA" },
			{ token: "modifier", foreground: "7DB4FF" },
			{ token: "decorator", foreground: "D4AAFF" },
			{ token: "comment", foreground: "6C768D", fontStyle: "italic" },
			{ token: "keyword", foreground: "7DB4FF" },
			{ token: "string", foreground: "7EE787" },
			{ token: "number", foreground: "FBBF49" },
			{ token: "type", foreground: "A5D6FF" },
			{ token: "annotation", foreground: "C4B5FD" },
			{ token: "delimiter", foreground: "8E9AB3" }
		],
		colors: {
			"editor.background": "#0D0F14",
			"editor.foreground": "#E6EAF2",
			"editorLineNumber.foreground": "#4D566B",
			"editorLineNumber.activeForeground": "#A4AEC4",
			"editor.lineHighlightBackground": "#141822",
			"editor.selectionBackground": "#3182F638",
			"editor.inactiveSelectionBackground": "#3182F620",
			"editorCursor.foreground": "#3182F6",
			"editorWhitespace.foreground": "#252B3B",
			"editorIndentGuide.background1": "#1D2230",
			"editorIndentGuide.activeBackground1": "#2E364B",
			"editorWidget.background": "#141822",
			"editorWidget.border": "#2B3245",
			"editorHoverWidget.background": "#1B202E",
			"editorHoverWidget.border": "#2B3245",
			"menu.background": "#181C25",
			"menu.foreground": "#E6EAF2",
			"menu.selectionBackground": "#28364D",
			"menu.separatorBackground": "#303746",
			"menu.border": "#343B49",
			"editorSuggestWidget.background": "#141822",
			"editorSuggestWidget.border": "#2B3245",
			"editorSuggestWidget.selectedBackground": "#3182F62E",
			"input.background": "#1B202E",
			"input.border": "#2E364B",
			"focusBorder": "#3182F6",
			"scrollbarSlider.background": "#FFFFFF24",
			"scrollbarSlider.hoverBackground": "#FFFFFF3D"
		}
	});

	monaco.editor.defineTheme("fabric-light", {
		base: "vs",
		inherit: true,
		rules: [
			{ token: "property", foreground: "006D72" },
			{ token: "recordComponent", foreground: "006D72" },
			{ token: "variable", foreground: "855B00" },
			{ token: "parameter", foreground: "954910" },
			{ token: "method", foreground: "6441A6" },
			{ token: "annotationMember", foreground: "6441A6" },
			{ token: "class", foreground: "075C96" },
			{ token: "interface", foreground: "075C96" },
			{ token: "enum", foreground: "075C96" },
			{ token: "typeParameter", foreground: "075C96" },
			{ token: "record", foreground: "075C96" },
			{ token: "enumMember", foreground: "993A74" },
			{ token: "modifier", foreground: "1B64DA" },
			{ token: "decorator", foreground: "6D28D9" },
			{ token: "comment", foreground: "8B95A1", fontStyle: "italic" },
			{ token: "keyword", foreground: "1B64DA" },
			{ token: "string", foreground: "15803D" },
			{ token: "number", foreground: "B45309" },
			{ token: "type", foreground: "0369A1" },
			{ token: "annotation", foreground: "6D28D9" },
			{ token: "delimiter", foreground: "4E5968" }
		],
		colors: {
			"editor.background": "#FFFFFF",
			"editor.foreground": "#191F28",
			"editorLineNumber.foreground": "#B0B8C1",
			"editorLineNumber.activeForeground": "#4E5968",
			"editor.lineHighlightBackground": "#F6F7FA",
			"editor.selectionBackground": "#3182F629",
			"editor.inactiveSelectionBackground": "#3182F616",
			"editorCursor.foreground": "#3182F6",
			"editorWhitespace.foreground": "#D1D6DB",
			"editorIndentGuide.background1": "#E5E8EB",
			"editorIndentGuide.activeBackground1": "#B0B8C1",
			"editorWidget.background": "#FFFFFF",
			"editorWidget.border": "#D1D6DB",
			"editorHoverWidget.background": "#FFFFFF",
			"editorHoverWidget.border": "#D1D6DB",
			"menu.background": "#FFFFFF",
			"menu.foreground": "#191F28",
			"menu.selectionBackground": "#E8F3FF",
			"menu.separatorBackground": "#E5E8EB",
			"menu.border": "#D1D6DB",
			"editorSuggestWidget.background": "#FFFFFF",
			"editorSuggestWidget.border": "#D1D6DB",
			"editorSuggestWidget.selectedBackground": "#E8F3FF",
			"input.background": "#F2F4F6",
			"input.border": "#D1D6DB",
			"focusBorder": "#3182F6",
			"scrollbarSlider.background": "#191F2826",
			"scrollbarSlider.hoverBackground": "#191F2845"
		}
	});

	monaco.editor.setTheme(currentMonacoTheme);
}

let currentMonacoTheme: "fabric-dark" | "fabric-light" = "fabric-dark";

export function applyMonacoTheme(isDark: boolean): void {
	currentMonacoTheme = isDark ? "fabric-dark" : "fabric-light";
	if (initialized) {
		monaco.editor.setTheme(currentMonacoTheme);
	}
}

export { monaco };