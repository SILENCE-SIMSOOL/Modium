import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "../services/lspBridge") return {url: "data:text/javascript,export async function flushJavaDocument(){}", shortCircuit: true};
		if (specifier === "../services/monacoSetup") return {url: "data:text/javascript,export function applyMonacoTheme(){}", shortCircuit: true};
		if (specifier === "../services/backend") specifier += ".ts";
		return next(specifier, context);
	}
});

let choice = "Cancel";
globalThis.window = {
	setTimeout, clearTimeout, addEventListener() {},
	__TAURI_INTERNALS__: { invoke: async () => choice }
};
const sessions = new Map();
globalThis.localStorage = {
	getItem: key => sessions.get(key),
	setItem: (key, value) => sessions.set(key, value)
};
const { store } = await import("../src/state/store.ts");
const { backend } = await import("../src/services/backend.ts");
const files = new Map([["A/main", "old"], ["B/main", "other"]]);
let root;
Object.assign(backend, {
	openProject: async path => {
		if (path === "missing") throw Error("Missing project");
		root = path;
		return { path, name: path };
	},
	listDirectory: async () => [],
	getSettings: async () => ({ ...store.getState().settings, language: "en", autoSave: false }),
	readFile: async path => {
		const key = root + "/" + path;
		if (!files.has(key)) throw Error("Missing file");
		return files.get(key);
	}
});

test("save ordering, close decisions, project isolation and session restoration", async () => {
	await store.openProjectPath("A");
	await store.openFileTab("main");
	let release;
	const started = [];
	backend.writeFile = (path, content) => new Promise(resolve => {
		started.push(content);
		release = () => { files.set(root + "/" + path, content); resolve(); };
	});
	const id = "file:main";
	const tab = () => store.getState().tabs.find(t => t.id === id);
	store.updateTabContent(id, "A");
	const first = store.saveTab(id);
	await new Promise(setImmediate);
	store.updateTabContent(id, "B");
	const second = store.saveTab(id);
	assert.deepEqual(started, ["A"]);
	release();
	await first;
	assert.equal(files.get("A/main"), "A");
	assert.equal(tab().isDirty, true);
	await new Promise(setImmediate);
	assert.deepEqual(started, ["A", "B"]);
	release();
	await second;
	assert.equal(tab().isDirty, false);

	store.updateTabContent(id, "draft");
	assert.equal(await store.requestCloseTab(id), false);
	choice = "Save";
	backend.writeFile = async () => { throw Error("Read only"); };
	assert.equal(await store.requestCloseTab(id), false);
	assert.equal(tab().content, "draft");
	choice = "Discard";
	await assert.rejects(store.openProjectPath("missing"));
	assert.equal(store.getState().project.path, "A");
	assert.equal(tab().isDirty, true);

	files.set("A/removed", "");
	await store.openFileTab("removed");
	store.setActiveTab(id);
	store.setCursorPosition(12, 3);
	store.toggleBreakpoint("main", 12);
	await store.openProjectPath("B");
	assert.deepEqual(store.getState().breakpoints, {});
	assert.equal(store.getState().tabs.length, 0);
	await store.openFileTab("main");
	assert.equal(tab().content, "other");
	files.delete("A/removed");
	await store.openProjectPath("A");
	assert.deepEqual(store.getState().tabs.map(t => t.relPath), ["main"]);
	assert.equal(store.getState().activeTabId, id);
	assert.equal(tab().content, "B");
	assert.deepEqual([tab().revealLine, tab().revealColumn], [12, 3]);
});

test("100,000 Gradle lines flush before completion and late process events are ignored", async () => {
	const events = {};
	for (const key of Object.keys(backend).filter(key => key.startsWith("on"))) {
		backend[key] = async handler => { events[key] = handler; };
	}
	globalThis.document = { documentElement: {}, querySelector: () => null };
	backend.getToolStatus = async () => ({ jdtlsInstalled: false });
	await store.initApp();
	store.setState({ gradleState: "starting", activeGradleTask: "build", activeProcessId: null });
	const event = { processId: "a", task: "build", problems: [] };
	events.onGradleState({ ...event, state: "running" });
	let updates = 0;
	let previous = store.getState().gradleOutput;
	const unsubscribe = store.subscribe(() => {
		const lines = store.getState().gradleOutput;
		if (lines !== previous) updates++;
		previous = lines;
	});
	for (let i = 0; i < 100_000; i++) {
		events.onGradleOutput({ ...event, line: String(i), stream: "stdout" });
	}
	events.onGradleState({ ...event, state: "completed" });
	events.onGradleOutput({ ...event, line: "late", stream: "stdout" });
	unsubscribe();
	assert.equal(updates, 40);
	assert.equal(previous.length, 2500);
	assert.equal(previous.at(-1).text, "99999");
	assert.equal(store.getState().gradleState, "completed");
});

test("independent autosaves finish before a switch and late file reads stay in their workspace", async () => {
	await store.openProjectPath("A");
	await store.openFileTab("main");
	files.set("A/second", "initial");
	await store.openFileTab("second");
	store.setState({ settings: { ...store.getState().settings, autoSave: true, autoSaveDelayMs: 300 } });
	backend.writeFile = async (path, value) => { files.set(root + "/" + path, value); };
	store.updateTabContent("file:main", "autosave one");
	store.updateTabContent("file:second", "autosave two");
	await new Promise(resolve => setTimeout(resolve, 400));
	assert.equal(files.get("A/main"), "autosave one");
	assert.equal(files.get("A/second"), "autosave two");
	const read = backend.readFile;
	let complete;
	backend.readFile = path => path === "late"
		? new Promise(resolve => { complete = resolve; })
		: read(path);
	const pending = store.openFileTab("late");
	await store.openProjectPath("B");
	complete("from A");
	await pending;
	assert.ok(!store.getState().tabs.some(t => t.relPath === "late"));
});

test("external writes and deletion preserve unsaved edits until reviewed", async () => {
	await store.openProjectPath("A");
	files.set("A/conflict", "base");
	await store.openFileTab("conflict");
	const id = "file:conflict";
	const current = () => store.getState().tabs.find(tab => tab.id === id);
	backend.diskContent = async path => files.get(root + "/" + path) ?? null;
	backend.writeFile = async (path, value, expected) => {
		const disk = await backend.diskContent(path);
		if (disk !== expected) return {disk};
		files.set(root + "/" + path, value);
	};
	files.set("A/conflict", "external");
	await store.refreshDocument(id);
	assert.equal(current().content, "external");
	store.updateTabContent(id, "editor", false);
	files.set("A/conflict", "another");
	await assert.rejects(store.saveTab(id));
	assert.equal(current().content, "editor");
	assert.equal(files.get("A/conflict"), "another");
	const reviewed = current().external;
	files.delete("A/conflict");
	await assert.rejects(store.saveTab(id, reviewed));
	assert.equal(current().external.disk, null);
	await store.saveTab(id, current().external);
	assert.equal(files.get("A/conflict"), "editor");
	assert.equal(current().isDirty, false);
	files.delete("A/conflict");
	await store.refreshDocument(id);
	store.useDisk(id);
	assert.equal(current(), undefined);
});
