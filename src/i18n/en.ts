import type { TranslationDict } from "./ko";

export const en: TranslationDict = {
	common: {
		save: "Save",
		cancel: "Cancel",
		close: "Close",
		confirm: "Confirm",
		delete: "Delete",
		rename: "Rename",
		refresh: "Refresh",
		create: "Create",
		open: "Open",
		loading: "Loading...",
		noProject: "No project open",
		readOnly: "Read Only",
		error: "Error",
		warning: "Warning",
		info: "Info",
		clear: "Clear"
	},
	titlebar: {
		appName: "Modium",
		noProject: "Open Project",
		runClient: "Run Client",
		debugClient: "Debug",
		buildMod: "Build",
		stop: "Stop",
		syncGradle: "Sync Gradle",
		toggleSidebar: "Toggle Sidebar (Ctrl+B)",
		toggleBottom: "Toggle Bottom Panel (Ctrl+J)",
		settings: "Settings",
		minimize: "Minimize",
		maximize: "Maximize / Restore",
		close: "Close",
		closeProject: "Close Project"
	},
	welcome: {
		title: "Modium",
		subtitle: "Build, inspect, and debug Minecraft Fabric mods in one compact workspace.",
		newMod: "New Fabric Mod",
		newModDesc: "Create 26.3 or 1.21.x mod",
		openProject: "Open Project",
		openProjectDesc: "Load local mod folder",
		toolSetup: "Tool Setup",
		toolSetupDesc: "Install JDT LS & Java Debug",
		jdkCheck: "JDK Check",
		jdkCheckDesc: "Inspect Java 25/21 runtimes",
		migration: "Version Migration",
		migrationDesc: "Upgrade MC & Loom versions",
		settings: "Settings",
		settingsDesc: "Language, editor & JDK",
		recentProjects: "Recent Projects",
		recentEmpty: "No recent projects yet. Create a new Fabric mod or open an existing folder.",
		jdkDetected: "Detected JDKs",
		jdkNone: "No JDK installations found. Check your path in Settings.",
		openProjectFirst: "Select a Fabric project folder to migrate first."
	},
	explorer: {
		title: "Explorer",
		newFile: "New File",
		newFolder: "New Folder",
		collapseAll: "Collapse All",
		revealInExplorer: "Reveal in File Explorer",
		fileNamePlaceholder: "File name (e.g. MyBlock.java)",
		folderNamePlaceholder: "Folder name",
		confirmDeleteTitle: "Confirm Delete",
		confirmDeleteBody: "Delete the selected item permanently?",
		emptyDir: "Empty folder"
	},
	search: {
		title: "Search",
		placeholder: "Search across workspace...",
		caseSensitive: "Match Case",
		useRegex: "Regular Expression"
	},
	mixins: {
		title: "Mixin Explorer",
		empty: "No Mixin classes found."
	},
	sources: {
		title: "Minecraft Sources",
		placeholder: "Search classes or packages..."
	},
	metadata: {
		title: "Metadata Editor",
		visualMode: "Visual Editor",
		rawMode: "Raw JSON"
	},
	resources: {
		title: "Resources",
		empty: "No resource assets found."
	},
	debug: {
		title: "Debug",
		start: "Start Debug",
		stop: "Stop Debug"
	},
	git: {
		title: "Source Control",
		init: "Initialize Git Repository"
	},
	wizard: {
		title: "Create New Fabric Mod"
	},
	migration: {
		title: "Fabric Version Migration"
	},
	settings: {
		title: "Settings"
	},
	quickOpen: {
		title: "Quick Open"
	},
	bottom: {
		terminal: "Terminal",
		build: "Build Output",
		problems: "Problems",
		debugConsole: "Debug Console",
		autoScroll: "Auto Scroll",
		restartTerminal: "Restart Terminal",
		terminalPlaceholder: "Enter command and press Enter...",
		debugEvalPlaceholder: "Evaluate expression while paused...",
		noProblems: "No build or code problems.",
		noBuildOutput: "Gradle build and run output will appear here.",
		noDebugLogs: "Debug console output and evaluations will appear here."
	},
	status: {
		noWorkspace: "No Workspace",
		lspIdle: "LSP Idle",
		lspStarting: "LSP Starting",
		lspReady: "JDT LS Ready",
		lspError: "LSP Error",
		encoding: "UTF-8",
		tabSize: "Tab",
		lineCol: "Ln {line}, Col {col}"
	},
	editor: {
		emptyHint: "Select a file from Explorer or use Quick Open.",
		quickOpenShortcut: "Quick Open",
		toggleSidebarShortcut: "Toggle Sidebar",
		toggleBottomShortcut: "Toggle Panel",
		saveShortcut: "Save File",
		unsavedChanges: "Unsaved changes",
		visualEditorBtn: "Mod Metadata UI",
		rawJsonBtn: "Raw JSON"
	}
};