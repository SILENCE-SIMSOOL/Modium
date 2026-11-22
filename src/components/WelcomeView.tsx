import appIcon from "../../src-tauri/icons/128x128.png";
import { backend } from "../services/backend";
import { store, useStore } from "../state/store";
import { useI18n } from "../i18n";
import {
	IconFolder,
	IconJdk,
	IconPlus,
	IconRefresh,
	IconRocket,
	IconSettings
} from "./ui/Icons";

export function WelcomeView() {
	const { t, tr } = useI18n();
	const recentProjects = useStore((s) => s.settings.recentProjects);
	const toolStatus = useStore((s) => s.toolStatus);

	const handleOpenFolder = async () => {
		try {
			const dir = await backend.pickDirectory();
			if (dir) {
				await store.openProjectPath(dir);
			}
		} catch (err) {
			store.showToast("error", String(err));
		}
	};

	const handleJdkCheck = async () => {
		try {
			const jdks = await backend.listJdks();
			if (jdks.length === 0) {
				store.showToast("warning", t.welcome.jdkNone);
			} else {
				const def = jdks.find((j) => j.isDefault) ?? jdks[0];
				store.showToast(
					"info",
					`${t.welcome.jdkDetected}: ${jdks.length} (Java ${def.major} · ${def.vendor})`
				);
			}
			store.setActiveModal("settings");
		} catch (err) {
			store.showToast("error", String(err));
		}
	};

	const handleMigration = async () => {
		if (store.getState().project) {
			store.setActiveModal("migration");
			return;
		}
		store.showToast("info", t.welcome.openProjectFirst);
		try {
			const dir = await backend.pickDirectory();
			if (dir) {
				await store.openProjectPath(dir);
				store.setActiveModal("migration");
			}
		} catch (err) {
			store.showToast("error", String(err));
		}
	};

	const tiles = [
		{
			id: "new",
			title: t.welcome.newMod,
			desc: t.welcome.newModDesc,
			tone: "fs-squircle--blue",
			icon: IconPlus,
			onClick: () => store.setActiveModal("createProject")
		},
		{
			id: "open",
			title: t.welcome.openProject,
			desc: t.welcome.openProjectDesc,
			tone: "fs-squircle--mint",
			icon: IconFolder,
			onClick: () => void handleOpenFolder()
		},
		{
			id: "tools",
			title: t.welcome.toolSetup,
			desc: t.welcome.toolSetupDesc,
			tone: "fs-squircle--violet",
			icon: IconRocket,
			onClick: () => void store.ensureTools()
		},
		{
			id: "jdk",
			title: t.welcome.jdkCheck,
			desc: t.welcome.jdkCheckDesc,
			tone: "fs-squircle--amber",
			icon: IconJdk,
			onClick: () => void handleJdkCheck()
		},
		{
			id: "migrate",
			title: t.welcome.migration,
			desc: t.welcome.migrationDesc,
			tone: "fs-squircle--teal",
			icon: IconRefresh,
			onClick: () => void handleMigration()
		},
		{
			id: "settings",
			title: t.welcome.settings,
			desc: t.welcome.settingsDesc,
			tone: "fs-squircle--slate",
			icon: IconSettings,
			onClick: () => store.setActiveModal("settings")
		}
	];

	return (
		<section className="fs-welcome">
			<div className="fs-welcome-inner">
				<div className="fs-welcome-hero">
					<div className="fs-welcome-brand">
						<img className="fs-welcome-logo" src={appIcon} alt="" />
						<div>
							<h1 className="fs-welcome-title">{t.welcome.title}</h1>
							<p className="fs-welcome-sub">{t.welcome.subtitle}</p>
						</div>
					</div>

					{toolStatus ? (
						<button
							type="button"
							className="fs-btn"
							onClick={() => {
								if (!toolStatus.jdtlsInstalled || !toolStatus.javaDebugInstalled) {
									void store.ensureTools();
								} else {
									store.setActiveModal("settings");
								}
							}}
						>
							<span
								className={`fs-status-dot ${
									toolStatus.jdtlsInstalled && toolStatus.javaDebugInstalled
										? "fs-status-dot--ok"
										: "fs-status-dot--warn"
								}`}
							/>
							<span>
								{toolStatus.jdtlsInstalled && toolStatus.javaDebugInstalled
									? tr("JDT LS · Debug 준비됨", "JDT LS & Debug Ready")
									: tr("Java 도구 설치 필요", "Install Java Tools")}
							</span>
						</button>
					) : null}
				</div>

				<div className="fs-tile-grid">
					{tiles.map((tile) => {
						const Icon = tile.icon;
						return (
							<button
								key={tile.id}
								type="button"
								className="fs-tile"
								onClick={tile.onClick}
							>
								<div className={`fs-squircle ${tile.tone}`}>
									<Icon size={21} />
								</div>
								<div style={{ minWidth: 0 }}>
									<div className="fs-tile-title">{tile.title}</div>
									<div className="fs-tile-desc">{tile.desc}</div>
								</div>
							</button>
						);
					})}
				</div>

				<div className="fs-recent-card">
					<div className="fs-recent-head">{t.welcome.recentProjects}</div>
					{recentProjects.length === 0 ? (
						<div className="fs-recent-empty">{t.welcome.recentEmpty}</div>
					) : (
						recentProjects.map((item) => (
							<button
								key={item.path}
								type="button"
								className="fs-recent-row"
								onClick={() => {
									void store.openProjectPath(item.path).catch((err) => {
										store.showToast("error", String(err));
									});
								}}
							>
								<div style={{ minWidth: 0 }}>
									<div
										style={{
											fontWeight: 600,
											color: "var(--text-primary)",
											overflow: "hidden",
											textOverflow: "ellipsis",
											whiteSpace: "nowrap"
										}}
									>
										{item.name}
									</div>
									<div
										style={{
											fontSize: 11.5,
											color: "var(--text-tertiary)",
											overflow: "hidden",
											textOverflow: "ellipsis",
											whiteSpace: "nowrap"
										}}
									>
										{item.path}
									</div>
								</div>
								{item.mcVersion ? (
									<span className="fs-mc-badge">MC {item.mcVersion}</span>
								) : null}
							</button>
						))
					)}
				</div>
			</div>
		</section>
	);
}