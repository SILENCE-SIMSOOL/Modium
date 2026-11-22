import appIcon from "../../src-tauri/icons/128x128.png";
import { backend } from "../services/backend";
import { store, useStore } from "../state/store";
import { LANGUAGES, useI18n } from "../i18n";
import type { AppLanguage } from "../types/ipc";
import {
	IconBottomDock,
	IconBuild,
	IconClose,
	IconDebug,
	IconFolder,
	IconMaximize,
	IconMinimize,
	IconMoon,
	IconPlay,
	IconSidebar,
	IconSettings,
	IconStop,
	IconSun,
	IconSync
} from "./ui/Icons";
import { ProgressPill } from "./ui/ProgressPill";

export function TitleBar() {
	const { lang, setLang, t, tr } = useI18n();
	const project = useStore((s) => s.project);
	const theme = useStore((s) => s.settings.theme);
	const systemPrefersDark = useStore((s) => s.systemPrefersDark);
	const isDark = theme === "dark" || (theme === "system" && systemPrefersDark);
	const activeGradleTask = useStore((s) => s.activeGradleTask);
	const gradleState = useStore((s) => s.gradleState);
	const debugSession = useStore((s) => s.debugSession);
	const progressTask = useStore((s) => s.progressTask);
	const sidebarVisible = useStore((s) => s.sidebarVisible);
	const bottomVisible = useStore((s) => s.bottomVisible);

	const isGradleRunning =
		gradleState === "starting" || gradleState === "running" || gradleState === "stopping";
	const hasRunningTask = isGradleRunning || debugSession !== null;
	const mcVersion = project?.fabricMeta?.mcVersion ?? null;

	const handleOpenProject = async () => {
		try {
			const dir = await backend.pickDirectory();
			if (dir) {
				await store.openProjectPath(dir);
			}
		} catch (err) {
			store.showToast("error", String(err));
		}
	};

	return (
		<header
			className="fs-titlebar"
			data-tauri-drag-region=""
			onDoubleClick={(e) => {
				if (e.target === e.currentTarget) {
					void backend.windowToggleMaximize();
				}
			}}
		>
			<div className="fs-titlebar-left" data-tauri-drag-region="">
				<img className="fs-brand-mark" src={appIcon} alt="" />
				<span className="fs-brand-title" data-tauri-drag-region="">
					{t.titlebar.appName}
				</span>

				{project ? (
					<div className="fs-project-pill" data-tauri-drag-region="false">
						<button
							type="button"
							style={{
								display: "inline-flex",
								alignItems: "center",
								gap: 6,
								minWidth: 0
							}}
							onClick={() => store.setActiveModal("quickOpen")}
							title={`${project.path} (Ctrl+P)`}
						>
							<span className="fs-project-name">{project.name}</span>
							{mcVersion ? (
								<span className="fs-mc-badge">MC {mcVersion}</span>
							) : null}
						</button>
						<button
							type="button"
							className="fs-tab-close"
							onClick={() => void store.closeCurrentProject()}
							title={t.titlebar.closeProject}
							aria-label={t.titlebar.closeProject}
						>
							<IconClose size={11} />
						</button>
					</div>
				) : (
					<button
						type="button"
						className="fs-project-pill"
						data-tauri-drag-region="false"
						onClick={() => void handleOpenProject()}
					>
						<IconFolder size={12} />
						<span>{t.titlebar.noProject}</span>
					</button>
				)}
			</div>

			<div className="fs-floating-pill" data-tauri-drag-region="false">
				<button
					type="button"
					className={`fs-pill-btn ${
						activeGradleTask === "runClient" ? "fs-pill-btn--primary" : ""
					}`}
					disabled={!project || hasRunningTask}
					onClick={() => void store.runGradle("runClient")}
					title={t.titlebar.runClient}
				>
					<IconPlay size={13} />
					<span>{t.titlebar.runClient}</span>
				</button>

				<button
					type="button"
					className={`fs-pill-btn ${debugSession ? "fs-pill-btn--active" : ""}`}
					disabled={!project || hasRunningTask}
					onClick={() => void store.startDebug()}
					title={t.titlebar.debugClient}
				>
					<IconDebug size={13} />
					<span>{t.titlebar.debugClient}</span>
				</button>

				<button
					type="button"
					className={`fs-pill-btn ${
						activeGradleTask === "build" ? "fs-pill-btn--active" : ""
					}`}
					disabled={!project || isGradleRunning}
					onClick={() => void store.runGradle("build")}
					title={t.titlebar.buildMod}
				>
					<IconBuild size={13} />
					<span>{t.titlebar.buildMod}</span>
				</button>

				<button
					type="button"
					className={`fs-pill-btn ${hasRunningTask ? "fs-pill-btn--danger" : ""}`}
					disabled={!hasRunningTask}
					onClick={() => {
						if (debugSession) {
							void store.stopDebug();
						} else {
							void store.stopActiveGradle();
						}
					}}
					title={t.titlebar.stop}
				>
					<IconStop size={12} />
					<span>{t.titlebar.stop}</span>
				</button>

				<div className="fs-pill-divider" />

				<button
					type="button"
					className={`fs-pill-btn ${
						activeGradleTask === "refreshDependencies" ? "fs-pill-btn--active" : ""
					}`}
					disabled={!project || isGradleRunning}
					onClick={() => void store.runGradle("refreshDependencies")}
					title={t.titlebar.syncGradle}
				>
					<IconSync size={13} />
					<span>{t.titlebar.syncGradle}</span>
				</button>
			</div>

			<div className="fs-titlebar-right" data-tauri-drag-region="">
				{progressTask ? (
					<div data-tauri-drag-region="false">
						<ProgressPill
							label={progressTask.label}
							step={progressTask.step}
							totalSteps={progressTask.totalSteps}
							percent={progressTask.percent}
							indeterminate={progressTask.indeterminate}
						/>
					</div>
				) : null}

				<div
					style={{ display: "inline-flex", alignItems: "center", gap: 3 }}
					data-tauri-drag-region="false"
				>
					<button
						type="button"
						className={`fs-icon-btn ${sidebarVisible ? "fs-icon-btn--active" : ""}`}
						onClick={() => store.toggleSidebar()}
						title={t.titlebar.toggleSidebar}
						aria-label={t.titlebar.toggleSidebar}
					>
						<IconSidebar size={15} />
					</button>
					<button
						type="button"
						className={`fs-icon-btn ${bottomVisible ? "fs-icon-btn--active" : ""}`}
						onClick={() => store.toggleBottom()}
						title={t.titlebar.toggleBottom}
						aria-label={t.titlebar.toggleBottom}
					>
						<IconBottomDock size={15} />
					</button>

					<button
						type="button"
						className="fs-icon-btn"
						onClick={() => void store.toggleTheme()}
						title={
							isDark
								? tr("라이트 테마로 전환", "Switch to light theme")
								: tr("다크 테마로 전환", "Switch to dark theme")
						}
						aria-label={
							isDark
								? tr("라이트 테마로 전환", "Switch to light theme")
								: tr("다크 테마로 전환", "Switch to dark theme")
						}
					>
						{isDark ? <IconSun size={14} /> : <IconMoon size={14} />}
					</button>

					<select
						className="fs-lang-select"
						value={lang}
						onChange={(e) => setLang(e.target.value as AppLanguage)}
						aria-label="Language"
					>
						{LANGUAGES.map((item) => (
							<option key={item.code} value={item.code}>
								{item.short}
							</option>
						))}
					</select>

					<button
						type="button"
						className="fs-icon-btn"
						onClick={() => store.setActiveModal("settings")}
						title={t.titlebar.settings}
						aria-label={t.titlebar.settings}
					>
						<IconSettings size={15} />
					</button>
				</div>

				<div className="fs-win-controls" data-tauri-drag-region="false">
					<button
						type="button"
						className="fs-win-btn"
						onClick={() => void backend.windowMinimize()}
						title={t.titlebar.minimize}
						aria-label={t.titlebar.minimize}
					>
						<IconMinimize size={13} />
					</button>
					<button
						type="button"
						className="fs-win-btn"
						onClick={() => void backend.windowToggleMaximize()}
						title={t.titlebar.maximize}
						aria-label={t.titlebar.maximize}
					>
						<IconMaximize size={12} />
					</button>
					<button
						type="button"
						className="fs-win-btn fs-win-btn--close"
						onClick={() => void backend.windowClose()}
						title={t.titlebar.close}
						aria-label={t.titlebar.close}
					>
						<IconClose size={13} />
					</button>
				</div>
			</div>
		</header>
	);
}