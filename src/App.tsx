import { useEffect, useState } from "react";
import { ActivityBar } from "./components/ActivityBar";
import { BottomPanel } from "./components/BottomPanel";
import { EditorArea } from "./components/EditorArea";
import { Explorer } from "./components/Explorer";
import { StatusBar } from "./components/StatusBar";
import { TextContextMenu } from "./components/TextContextMenu";
import { TitleBar } from "./components/TitleBar";
import { WelcomeView } from "./components/WelcomeView";
import { CreateProjectModal } from "./components/modals/CreateProjectModal";
import { MigrationModal } from "./components/modals/MigrationModal";
import { QuickOpenModal } from "./components/modals/QuickOpenModal";
import { SettingsModal } from "./components/modals/SettingsModal";
import { DebugPanel } from "./components/panels/DebugPanel";
import { GitPanel } from "./components/panels/GitPanel";
import { MetadataEditor } from "./components/panels/MetadataEditor";
import { MinecraftSourcePanel } from "./components/panels/MinecraftSourcePanel";
import { MixinExplorerPanel } from "./components/panels/MixinExplorerPanel";
import { ResourcePreviewPanel } from "./components/panels/ResourcePreviewPanel";
import { SearchPanel } from "./components/panels/SearchPanel";
import {
	IconCheck,
	IconClose,
	IconError,
	IconInfo,
	IconWarning
} from "./components/ui/Icons";
import { useI18n } from "./i18n";
import { backend } from "./services/backend";
import { clearAllLspDocStates, clearLspDocState, registerJavaLspProviders } from "./services/lspBridge";
import { ensureMonacoSetup, monaco } from "./services/monacoSetup";
import { store, useStore, type SidebarTab, type ToastKind } from "./state/store";

async function resolveDebugThreadId(): Promise<number | null> {
	const pausedTid = store.getState().debugPausedLocation?.threadId;
	if (typeof pausedTid === "number") {
		return pausedTid;
	}
	try {
		const threads = await backend.debugThreads();
		return threads[0]?.id ?? null;
	} catch {
		return null;
	}
}

function renderToastIcon(kind: ToastKind) {
	if (kind === "success") {
		return <IconCheck size={14} style={{ color: "var(--status-success)", flexShrink: 0 }} />;
	}
	if (kind === "warning") {
		return <IconWarning size={14} style={{ color: "var(--status-warning)", flexShrink: 0 }} />;
	}
	if (kind === "error") {
		return <IconError size={14} style={{ color: "var(--status-danger)", flexShrink: 0 }} />;
	}
	return <IconInfo size={14} style={{ color: "var(--accent-weak-text)", flexShrink: 0 }} />;
}

export default function App() {
	const workspaceBusy = useStore(s => s.workspaceBusy);
	const { t } = useI18n();
	const project = useStore((s) => s.project);
	const sidebarTab = useStore((s) => s.sidebarTab);
	const sidebarVisible = useStore((s) => s.sidebarVisible);
	const sidebarWidth = useStore((s) => s.sidebarWidth);
	const toasts = useStore((s) => s.toasts);
	const [resizingSidebar, setResizingSidebar] = useState(false);

	useEffect(() => {
		ensureMonacoSetup();
		registerJavaLspProviders();
		void store.initApp();
		let tabs = store.getState().tabs;
		let currentProjectPath = store.getState().project?.path ?? null;
		return store.subscribe(() => {
			const snap = store.getState();
			const nextProjectPath = snap.project?.path ?? null;
			if (nextProjectPath !== currentProjectPath) {
				currentProjectPath = nextProjectPath;
				clearAllLspDocStates();
			}
			const next = snap.tabs;
			if (next === tabs) return;
			const previous = tabs;
			tabs = next;
			for (const tab of previous) {
				if (next.some(t => t.uri === tab.uri)) continue;
				clearLspDocState(tab.uri);
				monaco.editor.getModel(monaco.Uri.parse(tab.uri))?.dispose();
			}
		});
	}, []);

	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			const mod = e.ctrlKey || e.metaKey;
			const key = e.key.toLowerCase();
			const snap = store.getState();
			if (snap.workspaceBusy) return;

			if (e.key === "F5") {
				e.preventDefault();
				if (e.repeat || !snap.project || snap.activeModal !== "none") return;
				if (!snap.debugSession) {
					void store.startDebug();
				} else if (snap.debugPausedLocation) {
					void backend
						.debugContinue(snap.debugPausedLocation.threadId ?? undefined)
						.then(() => store.setState({ debugPausedLocation: null }))
						.catch((err) => store.showToast("error", String(err)));
				}
				return;
			}

			if (e.key === "F10" || e.key === "F11") {
				e.preventDefault();
				if (e.repeat || !snap.project || !snap.debugSession || snap.activeModal !== "none") {
					return;
				}
				void resolveDebugThreadId().then((tid) => {
					if (tid === null) return;
					const action =
						e.key === "F10"
							? backend.debugStepOver(tid)
							: e.shiftKey
								? backend.debugStepOut(tid)
								: backend.debugStepInto(tid);
					return action.catch((err) => store.showToast("error", String(err)));
				});
				return;
			}

			if (!mod) return;

			if (e.shiftKey && !e.altKey && (key === "t" || key === "r")) {
				e.preventDefault();
				e.stopPropagation();
				if (!e.repeat && snap.project && ["none", "quickOpen", "typeSearch", "resourceSearch"].includes(snap.activeModal)) {
					store.setActiveModal(key === "t" ? "typeSearch" : "resourceSearch");
				}
				return;
			}

			if (key === "p" && !e.shiftKey) {
				e.preventDefault();
				if (e.repeat || !snap.project) return;
				if (snap.activeModal === "quickOpen") {
					store.setActiveModal("none");
				} else if (snap.activeModal === "none") {
					store.setActiveModal("quickOpen");
				}
				return;
			}

			if (key === "s" && e.shiftKey) {
				e.preventDefault();
				if (!e.repeat && snap.project && snap.activeModal === "none") {
					void store.saveAllTabs();
				}
				return;
			}

			if (key === "s" && !e.shiftKey) {
				const insideMonaco =
					e.target instanceof Element && Boolean(e.target.closest(".monaco-editor"));
				if (!insideMonaco) {
					e.preventDefault();
					if (!e.repeat && snap.project && snap.activeModal === "none") {
						void store.saveActiveTab();
					}
				}
				return;
			}

			if (snap.activeModal !== "none" || !snap.project) return;

			if (key === "b" && !e.shiftKey) {
				e.preventDefault();
				if (!e.repeat) store.toggleSidebar();
			} else if (key === "j" && !e.shiftKey) {
				e.preventDefault();
				if (!e.repeat) store.toggleBottom();
			} else if (key === "f" && e.shiftKey) {
				e.preventDefault();
				if (!e.repeat) store.setSidebarTab("search");
			}
		};

		window.addEventListener("keydown", onKeyDown, true);
		return () => {
			window.removeEventListener("keydown", onKeyDown, true);
		};
	}, []);

	const handleSidebarResizePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
		e.preventDefault();
		const startX = e.clientX;
		const startW = sidebarWidth;
		setResizingSidebar(true);

		const onMove = (ev: PointerEvent) => {
			store.setSidebarWidth(startW + (ev.clientX - startX));
		};
		const onUp = () => {
			setResizingSidebar(false);
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	};

	const sidebarTitles: Record<SidebarTab, string> = {
		explorer: t.explorer.title,
		search: t.search.title,
		mixins: t.mixins.title,
		sources: t.sources.title,
		resources: t.resources.title,
		debug: t.debug.title,
		git: t.git.title
	};

	const renderSidebarPanel = () => {
		switch (sidebarTab) {
			case "explorer":
				return <Explorer />;
			case "search":
				return <SearchPanel />;
			case "mixins":
				return <MixinExplorerPanel />;
			case "sources":
				return <MinecraftSourcePanel />;
			case "resources":
				return <ResourcePreviewPanel />;
			case "debug":
				return <DebugPanel />;
			case "git":
				return <GitPanel />;
		}
	};

	return (
		<div className="fs-shell" inert={workspaceBusy}>
			<TitleBar />
			<TextContextMenu />

			<main className="fs-main" key={project?.path}>
				{!project ? (
					<WelcomeView />
				) : (
					<>
						<ActivityBar />

						{sidebarVisible ? (
							<>
								<aside className="fs-sidebar" style={{ width: sidebarWidth }}>
									{sidebarTab === "explorer" ? (
										<Explorer />
									) : (
										<>
											<div className="fs-panel-header">
												<span className="fs-panel-title">
													{sidebarTitles[sidebarTab]}
												</span>
											</div>
											<div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
												{renderSidebarPanel()}
											</div>
										</>
									)}
								</aside>
								<div
									className={`fs-resizer-v ${
										resizingSidebar ? "fs-resizer-v--dragging" : ""
									}`}
									onPointerDown={handleSidebarResizePointerDown}
								/>
							</>
						) : null}

						<div className="fs-center-col">
							<EditorArea renderMetadataEditor={() => <MetadataEditor />} />
							<BottomPanel />
						</div>
					</>
				)}
			</main>

			<StatusBar />

			<CreateProjectModal />
			<MigrationModal />
			<SettingsModal />
			<QuickOpenModal />

			{toasts.length > 0 ? (
				<div className="fs-toast-stack" role="status" aria-live="polite">
					{toasts.map((toast) => (
						<div key={toast.id} className={`fs-toast fs-toast--${toast.kind}`}>
							{renderToastIcon(toast.kind)}
							<span style={{ flex: 1, minWidth: 0, wordBreak: "break-word" }}>
								{toast.text}
							</span>
							<button
								type="button"
								className="fs-tab-close"
								onClick={() => store.dismissToast(toast.id)}
								aria-label={t.common.close}
							>
								<IconClose size={11} />
							</button>
						</div>
					))}
				</div>
			) : null}
		</div>
	);
}