import { store, useStore } from "../state/store";
import { LANGUAGES, useI18n } from "../i18n";
import { IconError, IconWarning } from "./ui/Icons";

export function StatusBar() {
	const { lang, setLang, t, tr } = useI18n();
	const project = useStore((s) => s.project);
	const settings = useStore((s) => s.settings);
	const lspState = useStore((s) => s.lspState);
	const lspMessage = useStore((s) => s.lspMessage);
	const completionError = useStore(s => s.completionFailures >= 2 ? s.completionError : "");
	const lspPercent = useStore((s) => s.lspPercent);
	const buildProblems = useStore((s) => s.buildProblems);
	const lspDiagnostics = useStore((s) => s.lspDiagnostics);
	const activeTabId = useStore((s) => s.activeTabId);
	const cursorLine = useStore((s) => s.cursorLine);
	const cursorColumn = useStore((s) => s.cursorColumn);

	let errorCount = 0;
	let warningCount = 0;
	for (const p of buildProblems) {
		if (p.severity === "error") errorCount++;
		else if (p.severity === "warning") warningCount++;
	}
	for (const list of Object.values(lspDiagnostics)) {
		for (const d of list) {
			if (d.severity === 1) errorCount++;
			else if (d.severity === 2) warningCount++;
		}
	}

	const meta = project?.fabricMeta;
	const dotClass =
		lspState === "ready" || lspState === "started"
			? "fs-status-dot--ok"
			: lspState === "starting" || lspState === "importing"
				? "fs-status-dot--warn"
				: lspState === "error"
					? "fs-status-dot--err"
					: "";

	const lspLabel =
		lspState === "ready" || lspState === "started"
			? t.status.lspReady
			: lspState === "error"
				? t.status.lspError
				: lspState === "idle"
					? t.status.lspIdle
					: lspMessage || t.status.lspStarting;

	return (
		<footer className="fs-statusbar">
			<div className="fs-status-group">
				{meta ? (
					<span className="fs-status-item tabular-nums">
						MC {meta.mcVersion} · Loader {meta.loaderVersion} · Loom {meta.loomVersion} ·
						Java {meta.javaVersion}
					</span>
				) : (
					<span className="fs-status-item">
						{project ? project.name : t.status.noWorkspace}
					</span>
				)}

				<button
					type="button"
					className="fs-status-btn"
					onClick={() => {
						if (project && (lspState === "idle" || lspState === "error")) {
							void store.startLspForWorkspace();
						} else {
							store.setActiveModal("settings");
						}
					}}
					title={lspMessage || lspLabel}
				>
					<span className={`fs-status-dot ${dotClass}`} />
					<span>
						{lspLabel}
						{lspPercent !== null && lspPercent < 100 ? ` (${lspPercent}%)` : ""}
					</span>
				</button>

				{completionError && <button className="fs-status-btn" title={completionError} onClick={() => window.dispatchEvent(new Event("modium:retry-completion"))}>{tr("자동완성 재시도", "Retry completion")}</button>}

				<button
					type="button"
					className="fs-status-btn tabular-nums"
					onClick={() => store.setBottomTab("problems")}
					title={t.bottom.problems}
				>
					<IconError size={12} style={{ color: errorCount > 0 ? "var(--status-danger)" : undefined }} />
					<span>{errorCount}</span>
					<IconWarning
						size={12}
						style={{
							marginLeft: 4,
							color: warningCount > 0 ? "var(--status-warning)" : undefined
						}}
					/>
					<span>{warningCount}</span>
				</button>
			</div>

			<div className="fs-status-group">
				{activeTabId ? (
					<span className="fs-status-item tabular-nums">
						{t.status.lineCol
							.replace("{line}", String(cursorLine))
							.replace("{col}", String(cursorColumn))}
					</span>
				) : null}


				<button
					type="button"
					className="fs-status-btn tabular-nums"
					onClick={() => store.setActiveModal("settings")}
				>
					{t.status.tabSize} {settings.tabSize}
				</button>

				<span className="fs-status-item">{t.status.encoding}</span>

				<button
					type="button"
					className="fs-status-btn"
					onClick={() => {
						const idx = LANGUAGES.findIndex((item) => item.code === lang);
						const next = LANGUAGES[(idx + 1) % LANGUAGES.length];
						setLang(next.code);
					}}
				>
					{LANGUAGES.find((item) => item.code === lang)?.short ?? "KO"}
				</button>
			</div>
		</footer>
	);
}