import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../../i18n";
import { backend } from "../../services/backend";
import { store, useStore } from "../../state/store";
import type { FabricVersionCatalog, MigrationPlan } from "../../types/ipc";
import * as Icons from "../ui/Icons";
import { ModalDialog } from "../ui/ModalDialog";

export function MigrationModal() {
	const { tr } = useI18n();
	const activeModal = useStore((s) => s.activeModal);
	const project = useStore((s) => s.project);
	const open = activeModal === "migration";

	const [catalog, setCatalog] = useState<FabricVersionCatalog | null>(null);
	const [showSnapshots, setShowSnapshots] = useState(false);
	const [targetMc, setTargetMc] = useState("26.3");
	const [analyzing, setAnalyzing] = useState(false);
	const [applying, setApplying] = useState(false);
	const [plan, setPlan] = useState<MigrationPlan | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!open) {
			return;
		}
		setPlan(null);
		setError(null);
		void backend
			.fetchFabricVersions(false)
			.then((res) => {
				setCatalog(res);
				const currentMc = project?.fabricMeta?.mcVersion;
				const candidate =
					res.gameVersions.find((v) => v.stable && v.version !== currentMc)?.version ??
					res.gameVersions[0]?.version ??
					"26.3";
				setTargetMc(candidate);
			})
			.catch(() => setCatalog(null));
	}, [open, project?.fabricMeta?.mcVersion]);

	const versionOptions = useMemo(() => {
		const raw = catalog?.gameVersions ?? [
			{ version: "26.3", stable: true },
			{ version: "1.21.11", stable: true }
		];
		return raw.filter((v) => showSnapshots || v.stable || v.version === targetMc).slice(0, 80);
	}, [catalog, showSnapshots, targetMc]);

	const close = () => {
		if (!applying) {
			store.setActiveModal("none");
		}
	};

	const handleAnalyze = async () => {
		if (!project || !targetMc) {
			return;
		}
		setAnalyzing(true);
		setError(null);
		setPlan(null);
		try {
			const result = await backend.analyzeVersionMigration(targetMc);
			setPlan(result);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setAnalyzing(false);
		}
	};

	const handleApply = async () => {
		if (!project || !plan || plan.toMc !== targetMc) {
			return;
		}
		setApplying(true);
		setError(null);
		try {
			await store.withWorkspaceLock(async () => {
				await store.waitForWrites();
				const dirty = store.getState().tabs.find(tab => tab.isDirty && plan.changes.some(change => change.file === tab.relPath));
				if (dirty) throw new Error(tr(`${dirty.title}을 저장한 뒤 다시 분석해 줘.`, `Save ${dirty.title} and analyze again.`));
				const res = await backend.applyVersionMigration(plan.toMc, plan.revision);
				for (const path of res.appliedFiles) {
					const tab = store.getState().tabs.find(t => t.relPath === path);
					if (tab && !tab.isDirty) {
						const content = await backend.readFile(path);
						store.setState(prev => ({tabs: prev.tabs.map(t => t === tab ? {...t, content, savedContent: content} : t)}));
					}
				}
				const fabricMeta = await backend.inspectFabricProject();
				if (store.getState().project?.path === project.path) store.setState({project: {...project, fabricMeta}});
				await store.refreshFileTree();
				store.showToast(
					"success",
					tr(
						`${res.appliedFiles.length}개 파일을 MC ${plan.toMc} 기준으로 마이그레이션했어요.`,
						`Migrated ${res.appliedFiles.length} files to MC ${plan.toMc}.`
					)
				);
				store.setActiveModal("none");
			});
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setApplying(false);
		}
	};

	return (
		<ModalDialog
			open={open}
			onClose={close}
			title={tr("Fabric 버전 마이그레이션", "Fabric Version Migration")}
			subtitle={tr(
				"대상 Minecraft 버전을 분석하고 build.gradle.kts · gradle.properties · fabric.mod.json 변경 내역을 미리 확인해요",
				"Analyze target Minecraft version compatibility and preview file diffs before applying"
			)}
			icon={<Icons.IconSync size={16} />}
			width={680}
			footer={
				<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
					<button type="button" className="fs-btn" onClick={close} disabled={applying}>
						{tr("닫기", "Close")}
					</button>
					<button
						type="button"
						className="fs-btn fs-btn--primary"
						disabled={!project || !plan || plan.toMc !== targetMc || applying || analyzing}
						onClick={() => void handleApply()}
					>
						<Icons.IconCheck size={13} />
						{applying ? tr("적용 중...", "Applying...") : tr("마이그레이션 적용", "Apply Migration")}
					</button>
				</div>
			}
		>
			{!project ? (
				<div style={{ fontSize: 12.5, color: "var(--text-secondary)" }}>
					{tr(
						"버전 마이그레이션을 분석하려면 Fabric 프로젝트를 먼저 여세요.",
						"Open a Fabric project first to analyze version migration."
					)}
				</div>
			) : (
				<div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
					<div
						style={{
							padding: "10px 12px",
							borderRadius: "var(--radius-l)",
							background: "var(--bg-canvas)",
							border: "1px solid var(--border-hairline)",
							display: "flex",
							alignItems: "center",
							justifyContent: "space-between",
							gap: 10
						}}
					>
						<div>
							<div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)" }}>
								{project.name}
							</div>
							<div
								className="tabular-nums"
								style={{ fontSize: 11.5, color: "var(--text-tertiary)", fontFamily: "var(--font-mono)" }}
							>
								MC {project.fabricMeta?.mcVersion ?? "?"} · Loader {project.fabricMeta?.loaderVersion ?? "?"} · Loom{" "}
								{project.fabricMeta?.loomVersion ?? "?"} · Java {project.fabricMeta?.javaVersion ?? "?"}
							</div>
						</div>
					</div>
					<div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
						<div style={{ flex: 1 }}>
							<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
								<label htmlFor="mig-target-mc" style={{ fontSize: 11.5, fontWeight: 600, color: "var(--text-secondary)" }}>
									{tr("대상 Minecraft 버전", "Target Minecraft Version")}
								</label>
								<label style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--text-secondary)", cursor: "pointer" }}>
									<input
										type="checkbox"
										checked={showSnapshots}
										onChange={(e) => setShowSnapshots(e.target.checked)}
									/>
									{tr("스냅샷 표시", "Show Snapshots")}
								</label>
							</div>
							<select
								id="mig-target-mc"
								className="fs-select"
								value={targetMc}
								onChange={(e) => {
									setTargetMc(e.target.value);
									setPlan(null);
								}}
								style={{ width: "100%", fontFamily: "var(--font-mono)" }}
							>
								{versionOptions.map((v) => (
									<option key={v.version} value={v.version}>
										{v.version} {v.stable ? "" : tr("(스냅샷)", "(Snapshot)")}
									</option>
								))}
							</select>
						</div>
						<button
							type="button"
							className="fs-btn fs-btn--primary"
							disabled={analyzing || applying}
							onClick={() => void handleAnalyze()}
							style={{ height: 32 }}
						>
							<Icons.IconSearch size={13} />
							{analyzing ? tr("분석 중...", "Analyzing...") : tr("변경 내역 분석", "Analyze")}
						</button>
					</div>
					{error && (
						<div
							style={{
								padding: "8px 10px",
								borderRadius: "var(--radius-m)",
								background: "var(--status-danger-bg)",
								border: "1px solid rgba(239, 68, 68, 0.4)",
								color: "var(--status-danger)",
								fontSize: 12
							}}
						>
							{error}
						</div>
					)}
					{plan && (
						<div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
							<div
								className="tabular-nums"
								style={{
									padding: "10px 12px",
									borderRadius: "var(--radius-l)",
									background: "var(--bg-elevated)",
									border: "1px solid var(--border-strong)",
									display: "grid",
									gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
									gap: 8,
									fontSize: 11.5
								}}
							>
								<div>
									<div style={{ color: "var(--text-tertiary)", fontSize: 10.5 }}>Minecraft</div>
									<div style={{ fontFamily: "var(--font-mono)", fontWeight: 600 }}>
										{plan.fromMc} → {plan.toMc}
									</div>
								</div>
								<div>
									<div style={{ color: "var(--text-tertiary)", fontSize: 10.5 }}>Loader / Loom</div>
									<div style={{ fontFamily: "var(--font-mono)", fontWeight: 600 }}>
										{plan.targetLoader} / {plan.targetLoom}
									</div>
								</div>
								<div>
									<div style={{ color: "var(--text-tertiary)", fontSize: 10.5 }}>Fabric API</div>
									<div
										style={{
											fontFamily: "var(--font-mono)",
											fontWeight: 600,
											overflow: "hidden",
											textOverflow: "ellipsis",
											whiteSpace: "nowrap"
										}}
										title={plan.targetApi}
									>
										{plan.targetApi || "-"}
									</div>
								</div>
								<div>
									<div style={{ color: "var(--text-tertiary)", fontSize: 10.5 }}>
										{tr("대상 Java", "Target Java")}
									</div>
									<div style={{ fontFamily: "var(--font-mono)", fontWeight: 600 }}>
										Java {plan.targetJava}
									</div>
								</div>
							</div>
							{plan.breakingNotes.length > 0 && (
								<div
									style={{
										padding: "9px 11px",
										borderRadius: "var(--radius-m)",
										background: "var(--status-warning-bg)",
										border: "1px solid rgba(245, 158, 11, 0.35)",
										display: "flex",
										flexDirection: "column",
										gap: 4
									}}
								>
									<div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, color: "var(--status-warning)" }}>
										<Icons.IconWarning size={13} />
										{tr("주의할 호환성 변경 사항", "Breaking Compatibility Notes")}
									</div>
									{plan.breakingNotes.map((note, idx) => (
										<div key={idx} style={{ fontSize: 11.5, color: "var(--text-primary)", lineHeight: 1.45 }}>
											• {note}
										</div>
									))}
								</div>
							)}
							<div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
								<div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)" }}>
									{tr(`파일 변경 미리보기 (${plan.changes.length})`, `File Change Preview (${plan.changes.length})`)}
								</div>
								{plan.changes.length === 0 ? (
									<div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
										{tr("수정할 설정 파일 변경이 없어요.", "No file changes needed.")}
									</div>
								) : (
									plan.changes.map((ch, idx) => (
										<div
											key={`${ch.file}:${idx}`}
											style={{
												borderRadius: "var(--radius-m)",
												border: "1px solid var(--border-hairline)",
												background: "var(--bg-canvas)",
												overflow: "hidden"
											}}
										>
											<div
												style={{
													padding: "6px 10px",
													background: "var(--bg-elevated)",
													borderBottom: "1px solid var(--border-hairline)",
													display: "flex",
													alignItems: "center",
													justifyContent: "space-between",
													gap: 8
												}}
											>
												<span style={{ fontSize: 11.5, fontFamily: "var(--font-mono)", fontWeight: 600, color: "var(--text-primary)" }}>
													{ch.file}
												</span>
												<span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
													{ch.description}
												</span>
											</div>
											<div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", borderTop: "1px solid var(--border-hairline)" }}>
												<pre
													style={{
														margin: 0,
														padding: 8,
														fontSize: 11,
														fontFamily: "var(--font-mono)",
														color: "#FCA5A5",
														background: "rgba(239, 68, 68, 0.06)",
														borderRight: "1px solid var(--border-hairline)",
														overflow: "auto",
														maxHeight: 150,
														whiteSpace: "pre-wrap"
													}}
												>
													{ch.before}
												</pre>
												<pre
													style={{
														margin: 0,
														padding: 8,
														fontSize: 11,
														fontFamily: "var(--font-mono)",
														color: "#86EFAC",
														background: "rgba(46, 204, 113, 0.06)",
														overflow: "auto",
														maxHeight: 150,
														whiteSpace: "pre-wrap"
													}}
												>
													{ch.after}
												</pre>
											</div>
										</div>
									))
								)}
							</div>
						</div>
					)}
				</div>
			)}
		</ModalDialog>
	);
}