import type { ReactNode } from "react";
import { store, useStore, type EditorTab } from "../state/store";
import { useI18n } from "../i18n";
import { ExternalChange } from "./ExternalChange";
import { MonacoEditor } from "./MonacoEditor";
import {
	IconChevron,
	IconClose,
	IconError,
	IconFile,
	IconGradle,
	IconJava,
	IconJson,
	IconMetadata,
	IconWarning
} from "./ui/Icons";

export interface EditorAreaProps {
	renderMetadataEditor?: () => ReactNode;
}

function tabIcon(tab: EditorTab) {
	const name = tab.title.toLowerCase();
	if (name.endsWith(".java")) {
		return <IconJava size={13} style={{ color: "#F59E0B", flexShrink: 0 }} />;
	}
	if (name.endsWith(".json") || name.endsWith(".mcmeta")) {
		return <IconJson size={13} style={{ color: "#60A5FA", flexShrink: 0 }} />;
	}
	if (name.endsWith(".gradle") || name.endsWith(".kts")) {
		return <IconGradle size={13} style={{ color: "#34D399", flexShrink: 0 }} />;
	}
	return <IconFile size={13} style={{ color: "var(--text-tertiary)", flexShrink: 0 }} />;
}

export function EditorArea({ renderMetadataEditor }: EditorAreaProps) {
	const { t } = useI18n();
	const tabs = useStore((s) => s.tabs);
	const activeTabId = useStore((s) => s.activeTabId);
	const metadataEditorOpen = useStore((s) => s.metadataEditorOpen);
	const lspDiagnostics = useStore((s) => s.lspDiagnostics);

	const activeTab = tabs.find((tb) => tb.id === activeTabId) ?? null;

	const handleCloseTab = (tab: EditorTab) => {
		void store.requestCloseTab(tab.id).catch(err => store.showToast("error", String(err)));
	};

	if (!activeTab) {
		return (
			<section className="fs-editor-empty">
				<div style={{ fontSize: 13, color: "var(--text-secondary)" }}>
					{t.editor.emptyHint}
				</div>
				<div className="fs-shortcut-grid">
					<span>{t.editor.quickOpenShortcut}</span>
					<span className="fs-kbd">Ctrl + P</span>
					<span>{t.editor.toggleSidebarShortcut}</span>
					<span className="fs-kbd">Ctrl + B</span>
					<span>{t.editor.toggleBottomShortcut}</span>
					<span className="fs-kbd">Ctrl + J</span>
					<span>{t.editor.saveShortcut}</span>
					<span className="fs-kbd">Ctrl + S</span>
				</div>
			</section>
		);
	}

	const isFabricModJson =
		activeTab.relPath?.endsWith("fabric.mod.json") ||
		activeTab.title === "fabric.mod.json";
	const showVisualMetadata =
		Boolean(isFabricModJson && metadataEditorOpen && renderMetadataEditor);

	const activeDiags = lspDiagnostics[activeTab.uri] ?? [];
	let fileErrors = 0;
	let fileWarnings = 0;
	for (const d of activeDiags) {
		if (d.severity === 1) fileErrors++;
		else if (d.severity === 2) fileWarnings++;
	}

	const segments = activeTab.relPath
		? activeTab.relPath.split("/").filter(Boolean)
		: [activeTab.title];

	return (
		<section className="fs-editor-area">
			<div className="fs-tabbar">
				<div className="fs-tabbar-scroll" role="tablist">
					{tabs.map((tab) => {
						const active = tab.id === activeTab.id;
						return (
							<div
								key={tab.id}
								role="tab"
								aria-selected={active}
								tabIndex={0}
								className={`fs-tab ${active ? "fs-tab--active" : ""}`}
								onClick={() => store.setActiveTab(tab.id)}
								onMouseDown={(e) => {
									if (e.button === 1) {
										e.preventDefault();
										handleCloseTab(tab);
									}
								}}
								onKeyDown={(e) => {
									if (e.key === "Enter" || e.key === " ") {
										e.preventDefault();
										store.setActiveTab(tab.id);
									}
								}}
								title={tab.relPath ?? tab.uri}
							>
								{tabIcon(tab)}
								<span className="fs-tab-title">{tab.title}</span>
								{tab.isDirty ? (
									<span
										className="fs-tab-dirty"
										title={t.editor.unsavedChanges}
									/>
								) : null}
								<button
									type="button"
									className="fs-tab-close"
									onClick={(e) => {
										e.stopPropagation();
										handleCloseTab(tab);
									}}
									aria-label={`${t.common.close} ${tab.title}`}
								>
									<IconClose size={11} />
								</button>
							</div>
						);
					})}
				</div>

				<div className="fs-tabbar-actions">
					{isFabricModJson && renderMetadataEditor ? (
						<button
							type="button"
							className={`fs-mode-pill ${metadataEditorOpen ? "fs-mode-pill--active" : ""}`}
							onClick={() => store.setMetadataEditorOpen(!metadataEditorOpen)}
						>
							{metadataEditorOpen ? (
								<>
									<IconJson size={12} />
									<span>{t.editor.rawJsonBtn}</span>
								</>
							) : (
								<>
									<IconMetadata size={12} />
									<span>{t.editor.visualEditorBtn}</span>
								</>
							)}
						</button>
					) : null}

					{activeTab.isDirty && !activeTab.readOnly ? (
						<button
							type="button"
							className="fs-btn"
							style={{ height: 22, padding: "0 8px", fontSize: 11 }}
							onClick={() => void store.saveActiveTab()}
						>
							{t.common.save}
						</button>
					) : null}
				</div>
			</div>

			<div className="fs-breadcrumb">
				<div className="fs-breadcrumb-path">
					{segments.map((seg, idx) => (
						<span
							key={`${seg}-${idx}`}
							style={{ display: "inline-flex", alignItems: "center", gap: 4, minWidth: 0 }}
						>
							{idx > 0 ? <IconChevron size={11} /> : null}
							<span
								className={`fs-breadcrumb-seg ${
									idx === segments.length - 1 ? "fs-breadcrumb-seg--last" : ""
								}`}
							>
								{seg}
							</span>
						</span>
					))}
				</div>

				<div style={{ display: "inline-flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
					{activeTab.readOnly ? (
						<span style={{ color: "var(--accent-weak-text)", fontSize: 10.5 }}>
							{t.common.readOnly}
						</span>
					) : null}
					{fileErrors > 0 ? (
						<span
							className="tabular-nums"
							style={{
								display: "inline-flex",
								alignItems: "center",
								gap: 3,
								color: "var(--status-danger)"
							}}
						>
							<IconError size={11} />
							{fileErrors}
						</span>
					) : null}
					{fileWarnings > 0 ? (
						<span
							className="tabular-nums"
							style={{
								display: "inline-flex",
								alignItems: "center",
								gap: 3,
								color: "var(--status-warning)"
							}}
						>
							<IconWarning size={11} />
							{fileWarnings}
						</span>
					) : null}
				</div>
			</div>

			{activeTab.external && <ExternalChange key={activeTab.uri} tab={activeTab} />}
			{activeTab.language === "image" && activeTab.uri.startsWith("modium-image://") ? (
				<div style={{flex:1,minHeight:0,display:"grid",placeItems:"center",overflow:"auto"}}><img src={activeTab.content} alt={activeTab.title} style={{maxWidth:"100%",maxHeight:"100%"}} /></div>
			) : showVisualMetadata ? (
				<div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
					{renderMetadataEditor?.()}
				</div>
			) : (
				<MonacoEditor tab={activeTab} />
			)}
		</section>
	);
}