import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "../../i18n";
import { backend } from "../../services/backend";
import { store, useStore } from "../../state/store";
import type { MixinEntry } from "../../types/ipc";
import * as Icons from "../ui/Icons";

export function MixinExplorerPanel() {
	const { tr } = useI18n();
	const project = useStore((s) => s.project);
	const [entries, setEntries] = useState<MixinEntry[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [filter, setFilter] = useState("");
	const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

	const loadMixins = useCallback(async () => {
		if (!project) {
			setEntries([]);
			setError(null);
			return;
		}
		setLoading(true);
		setError(null);
		try {
			const res = await backend.scanMixins();
			setEntries(res.entries);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setEntries([]);
		} finally {
			setLoading(false);
		}
	}, [project]);

	useEffect(() => {
		void loadMixins();
	}, [loadMixins]);

	const filteredEntries = useMemo(() => {
		const q = filter.trim().toLowerCase();
		if (!q) {
			return entries;
		}
		return entries.filter((entry) => {
			if (entry.className.toLowerCase().includes(q)) {
				return true;
			}
			if (entry.configFile.toLowerCase().includes(q)) {
				return true;
			}
			if (entry.targetClasses.some((t) => t.toLowerCase().includes(q))) {
				return true;
			}
			return entry.methods.some(
				(m) =>
					m.name.toLowerCase().includes(q) ||
					m.targetMethod.toLowerCase().includes(q) ||
					m.annotation.toLowerCase().includes(q)
			);
		});
	}, [entries, filter]);

	const totalIssues = useMemo(
		() => entries.reduce((sum, entry) => sum + entry.issues.length, 0),
		[entries]
	);

	const toggleEntry = (key: string) => {
		setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));
	};

	if (!project) {
		return (
			<div style={{ padding: 14, color: "var(--text-secondary)", fontSize: 12, lineHeight: 1.5 }}>
				{tr(
					"Mixin 구조를 분석하려면 Fabric 프로젝트를 먼저 여세요.",
					"Open a Fabric project first to inspect Mixin configurations and hooks."
				)}
			</div>
		);
	}

	return (
		<div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
			<div
				style={{
					padding: "8px 10px",
					borderBottom: "1px solid var(--border-hairline)",
					display: "flex",
					flexDirection: "column",
					gap: 6
				}}
			>
				<div style={{ display: "flex", alignItems: "center", gap: 6 }}>
					<div
						style={{
							flex: 1,
							display: "flex",
							alignItems: "center",
							gap: 6,
							height: 28,
							padding: "0 8px",
							background: "var(--bg-elevated)",
							border: "1px solid var(--border-strong)",
							borderRadius: "var(--radius-m)"
						}}
					>
						<span style={{ color: "var(--text-tertiary)", display: "flex" }}>
							<Icons.IconSearch size={12} />
						</span>
						<input
							type="text"
							value={filter}
							onChange={(e) => setFilter(e.target.value)}
							placeholder={tr("Mixin 또는 대상 클래스 필터...", "Filter Mixins or targets...")}
							aria-label={tr("Mixin 필터", "Filter Mixins")}
							style={{
								flex: 1,
								minWidth: 0,
								background: "transparent",
								border: "none",
								outline: "none",
								color: "var(--text-primary)",
								fontSize: 12
							}}
						/>
					</div>
					<button
						type="button"
						onClick={() => void loadMixins()}
						disabled={loading}
						title={tr("Mixin 다시 스캔", "Rescan Mixins")}
						aria-label={tr("Mixin 다시 스캔", "Rescan Mixins")}
						style={{
							height: 28,
							width: 28,
							display: "inline-flex",
							alignItems: "center",
							justifyContent: "center",
							background: "var(--bg-control)",
							border: "1px solid var(--border-hairline)",
							borderRadius: "var(--radius-m)",
							color: "var(--text-primary)",
							cursor: loading ? "wait" : "pointer"
						}}
					>
						<Icons.IconRefresh size={13} />
					</button>
				</div>
				<div
					style={{
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
						fontSize: 11,
						color: "var(--text-tertiary)",
						fontVariantNumeric: "tabular-nums"
					}}
				>
					<span>
						{loading
							? tr("스캔 중...", "Scanning...")
							: tr(`${entries.length}개 Mixin`, `${entries.length} Mixins`)}
					</span>
					{totalIssues > 0 && (
						<span
							style={{
								display: "inline-flex",
								alignItems: "center",
								gap: 4,
								color: "var(--status-warning)"
							}}
						>
							<Icons.IconWarning size={12} />
							{tr(`문제 ${totalIssues}건`, `${totalIssues} issues`)}
						</span>
					)}
				</div>
			</div>
			<div style={{ flex: 1, overflowY: "auto", minHeight: 0, padding: 8, display: "flex", flexDirection: "column", gap: 8 }}>
				{error && (
					<div
						style={{
							padding: "8px 10px",
							borderRadius: "var(--radius-m)",
							border: "1px solid var(--status-danger)",
							background: "rgba(240, 68, 82, 0.08)",
							color: "var(--status-danger)",
							fontSize: 11.5
						}}
					>
						{error}
					</div>
				)}
				{!loading && !error && entries.length === 0 && (
					<div style={{ padding: 8, color: "var(--text-tertiary)", fontSize: 12, lineHeight: 1.55 }}>
						<div>
							{tr(
								"fabric.mod.json에서 등록된 Mixin 설정이나 클래스를 찾지 못했어요.",
								"No Mixin configs or classes were found from fabric.mod.json."
							)}
						</div>
						<button
							type="button"
							onClick={() => void loadMixins()}
							style={{
								marginTop: 8,
								padding: "5px 10px",
								borderRadius: "var(--radius-m)",
								background: "var(--bg-control)",
								border: "1px solid var(--border-strong)",
								color: "var(--text-primary)",
								fontSize: 11.5,
								cursor: "pointer"
							}}
						>
							{tr("다시 스캔", "Rescan")}
						</button>
					</div>
				)}
				{!loading && entries.length > 0 && filteredEntries.length === 0 && (
					<div style={{ padding: 8, color: "var(--text-tertiary)", fontSize: 12 }}>
						{tr("필터와 일치하는 Mixin이 없어요.", "No Mixins match the current filter.")}
					</div>
				)}
				{filteredEntries.map((entry) => {
					const key = `${entry.configFile}:${entry.className}:${entry.relPath}`;
					const isCollapsed = Boolean(collapsed[key]);
					const hasIssues = entry.issues.length > 0;
					return (
						<div
							key={key}
							style={{
								background: "var(--bg-elevated)",
								border: `1px solid ${hasIssues ? "rgba(245, 158, 11, 0.35)" : "var(--border-hairline)"}`,
								borderRadius: "var(--radius-l)",
								overflow: "hidden"
							}}
						>
							<div
								style={{
									display: "flex",
									alignItems: "center",
									gap: 6,
									padding: "7px 8px",
									borderBottom: isCollapsed ? "none" : "1px solid var(--border-hairline)"
								}}
							>
								<button
									type="button"
									onClick={() => toggleEntry(key)}
									aria-label={tr("접기/펼치기", "Toggle details")}
									style={{
										background: "transparent",
										border: "none",
										color: "var(--text-tertiary)",
										display: "flex",
										cursor: "pointer",
										padding: 2,
										transform: isCollapsed ? "rotate(0deg)" : "rotate(90deg)"
									}}
								>
									<Icons.IconChevron size={12} />
								</button>
								<button
									type="button"
									onClick={() => {
										if (entry.relPath) {
											void store.openFileTab(entry.relPath, 1);
										}
									}}
									title={entry.relPath || entry.className}
									style={{
										flex: 1,
										minWidth: 0,
										background: "transparent",
										border: "none",
										padding: 0,
										textAlign: "left",
										cursor: entry.relPath ? "pointer" : "default",
										display: "flex",
										flexDirection: "column",
										gap: 2
									}}
								>
									<div style={{ display: "flex", alignItems: "center", gap: 6 }}>
										<span style={{ color: "var(--accent)", display: "flex", flexShrink: 0 }}>
											<Icons.IconMixin size={13} />
										</span>
										<span
											style={{
												color: "var(--text-primary)",
												fontSize: 12,
												fontWeight: 600,
												overflow: "hidden",
												textOverflow: "ellipsis",
												whiteSpace: "nowrap"
											}}
										>
											{entry.className}
										</span>
									</div>
									<div
										style={{
											fontSize: 10.5,
											color: "var(--text-tertiary)",
											fontFamily: "var(--font-mono)",
											overflow: "hidden",
											textOverflow: "ellipsis",
											whiteSpace: "nowrap"
										}}
									>
										{entry.configFile} · {entry.environment}
									</div>
								</button>
							</div>
							{!isCollapsed && (
								<div style={{ padding: "6px 8px", display: "flex", flexDirection: "column", gap: 6 }}>
									{entry.targetClasses.length > 0 && (
										<div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
											<span style={{ fontSize: 10.5, color: "var(--text-tertiary)" }}>
												{tr("대상:", "Target:")}
											</span>
											{entry.targetClasses.map((target) => (
												<span
													key={target}
													style={{
														padding: "1px 6px",
														borderRadius: 6,
														background: "var(--bg-control)",
														border: "1px solid var(--border-hairline)",
														color: "var(--text-secondary)",
														fontSize: 10.5,
														fontFamily: "var(--font-mono)"
													}}
												>
													{target}
												</span>
											))}
										</div>
									)}
									{entry.issues.length > 0 && (
										<div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
											{entry.issues.map((issue, idx) => (
												<div
													key={idx}
													style={{
														display: "flex",
														alignItems: "flex-start",
														gap: 5,
														padding: "4px 6px",
														borderRadius: "var(--radius-m)",
														background: "rgba(245, 158, 11, 0.1)",
														color: "var(--status-warning)",
														fontSize: 11,
														lineHeight: 1.4
													}}
												>
													<span style={{ display: "flex", marginTop: 1, flexShrink: 0 }}>
														<Icons.IconWarning size={12} />
													</span>
													<span>{issue}</span>
												</div>
											))}
										</div>
									)}
									{entry.methods.length === 0 ? (
										<div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
											{tr("감지된 Mixin 메서드가 없어요.", "No Mixin hooks detected.")}
										</div>
									) : (
										<div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
											{entry.methods.map((method, idx) => (
												<button
													key={`${method.name}:${method.line}:${idx}`}
													type="button"
													onClick={() => {
														if (entry.relPath) {
															void store.openFileTab(entry.relPath, method.line);
														}
													}}
													style={{
														display: "flex",
														flexDirection: "column",
														gap: 2,
														padding: "5px 7px",
														background: "var(--bg-panel)",
														border: "1px solid var(--border-hairline)",
														borderRadius: "var(--radius-m)",
														cursor: entry.relPath ? "pointer" : "default",
														textAlign: "left"
													}}
												>
													<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
														<div style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 0 }}>
															<span
																style={{
																	padding: "1px 5px",
																	borderRadius: 4,
																	background: "rgba(49, 130, 246, 0.14)",
																	color: "var(--accent)",
																	fontSize: 10,
																	fontWeight: 600,
																	fontFamily: "var(--font-mono)",
																	flexShrink: 0
																}}
															>
																@{method.annotation}
															</span>
															<span
																style={{
																	color: "var(--text-primary)",
																	fontSize: 11.5,
																	fontFamily: "var(--font-mono)",
																	overflow: "hidden",
																	textOverflow: "ellipsis",
																	whiteSpace: "nowrap"
																}}
															>
																{method.name}
															</span>
														</div>
														<span
															style={{
																fontSize: 10.5,
																color: "var(--text-tertiary)",
																fontFamily: "var(--font-mono)",
																fontVariantNumeric: "tabular-nums",
																flexShrink: 0
															}}
														>
															L{method.line}
														</span>
													</div>
													{(method.targetMethod || method.atValue) && (
														<div
															style={{
																fontSize: 10.5,
																color: "var(--text-secondary)",
																fontFamily: "var(--font-mono)",
																overflow: "hidden",
																textOverflow: "ellipsis",
																whiteSpace: "nowrap"
															}}
														>
															{method.targetMethod || "-"}
															{method.atValue ? ` @At(${method.atValue})` : ""}
														</div>
													)}
												</button>
											))}
										</div>
									)}
								</div>
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
}