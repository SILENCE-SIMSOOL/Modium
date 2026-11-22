import { store, useStore, type SidebarTab } from "../state/store";
import { useI18n } from "../i18n";
import {
	IconCube,
	IconDebug,
	IconFolder,
	IconGit,
	IconMixin,
	IconPalette,
	IconRocket,
	IconSearch,
	IconSettings
} from "./ui/Icons";

export function ActivityBar() {
	const { t } = useI18n();
	const sidebarTab = useStore((s) => s.sidebarTab);
	const sidebarVisible = useStore((s) => s.sidebarVisible);
	const project = useStore((s) => s.project);

	const items: Array<{ id: SidebarTab; label: string; icon: typeof IconFolder }> = [
		{ id: "explorer", label: t.explorer.title, icon: IconFolder },
		{ id: "search", label: t.search.title, icon: IconSearch },
		{ id: "mixins", label: t.mixins.title, icon: IconMixin },
		{ id: "sources", label: t.sources.title, icon: IconCube },
		{ id: "resources", label: t.resources.title, icon: IconPalette },
		{ id: "debug", label: t.debug.title, icon: IconDebug },
		{ id: "git", label: t.git.title, icon: IconGit }
	];

	const handleSelect = (id: SidebarTab) => {
		if (sidebarTab === id && sidebarVisible) {
			store.toggleSidebar();
		} else {
			store.setSidebarTab(id);
		}
	};

	return (
		<nav className="fs-activitybar" aria-label="Primary Views">
			<div className="fs-activity-group">
				{items.map((item) => {
					const Icon = item.icon;
					const active = sidebarVisible && sidebarTab === item.id;
					return (
						<button
							key={item.id}
							type="button"
							className={`fs-activity-btn ${active ? "fs-activity-btn--active" : ""}`}
							onClick={() => handleSelect(item.id)}
							title={item.label}
							aria-label={item.label}
							aria-pressed={active}
						>
							<Icon size={18} />
						</button>
					);
				})}
			</div>

			<div className="fs-activity-group">
				<button
					type="button"
					className="fs-activity-btn"
					disabled={!project}
					onClick={() => store.setActiveModal("migration")}
					title={t.migration.title}
					aria-label={t.migration.title}
				>
					<IconRocket size={17} />
				</button>
				<button
					type="button"
					className="fs-activity-btn"
					onClick={() => store.setActiveModal("settings")}
					title={t.settings.title}
					aria-label={t.settings.title}
				>
					<IconSettings size={17} />
				</button>
			</div>
		</nav>
	);
}