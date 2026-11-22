import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "../../i18n";
import { backend } from "../../services/backend";
import { store, useStore } from "../../state/store";
import type { ResourceEntry, ResourceKind, ResourcePreview } from "../../types/ipc";
import * as Icons from "../ui/Icons";

type FilterKind = "all" | "texture" | "model" | "blockstate" | "lang";

const ZOOM_LEVELS = [1, 2, 4, 8] as const;

export function ResourcePreviewPanel() {
	const { tr } = useI18n();
	const project = useStore((s) => s.project);
	const [entries, setEntries] = useState<ResourceEntry[]>([]);
	const [kindFilter, setKindFilter] = useState<FilterKind>("all");
	const [search, setSearch] = useState("");
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [selectedRelPath, setSelectedRelPath] = useState<string | null>(null);
	const [preview, setPreview] = useState<ResourcePreview | null>(null);
	const [previewLoading, setPreviewLoading] = useState(false);
	const [previewError, setPreviewError] = useState<string | null>(null);
	const [zoom, setZoom] = useState<number>(4);

	const loadCatalog = useCallback(async () => {
		if (!project) {
			setEntries([]);
			setSelectedRelPath(null);
			setPreview(null);
			return;
		}
		setLoading(true);
		setError(null);
		try {
			const catalog = await backend.scanResources();
			setEntries(catalog.entries);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setEntries([]);
		} finally {
			setLoading(false);
		}
	}, [project]);

	useEffect(() => {
		setSelectedRelPath(null);
		setPreview(null);
		setPreviewError(null);
		void loadCatalog();
	}, [loadCatalog]);

	const openPreview = async (entry: ResourceEntry) => {
		setSelectedRelPath(entry.relPath);
		setPreviewLoading(true);
		setPreviewError(null);
		try {
			const data = await backend.readResourcePreview(entry.relPath);
			setPreview(data);
		} catch (err) {
			setPreview(null);
			setPreviewError(err instanceof Error ? err.message : String(err));
		} finally {
			setPreviewLoading(false);
		}
	};

	const counts = useMemo(() => {
		const map: Record<FilterKind, number> = {
			all: entries.length,
			texture: 0,
			model: 0,
			blockstate: 0,
			lang: 0
		};
		for (const e of entries) {
			if (e.kind === "texture" || e.kind === "model" || e.kind === "blockstate" || e.kind === "lang") {
				map[e.kind] += 1;
			}
		}
		return map;
	}, [entries]);

	const filtered = useMemo(() => {
		const q = search.trim().toLowerCase();
		return entries.filter((e) => {
			if (kindFilter !== "all" && e.kind !== kindFilter) {
				return false;
			}
			if (!q) {
				return true;
			}
			return (
				e.name.toLowerCase().includes(q) ||
				e.namespace.toLowerCase().includes(q) ||
				e.relPath.toLowerCase().includes(q)
			);
		});
	}, [entries, kindFilter, search]);

	const formatBytes = (size: number) => {
		if (size < 1024) {
			return `${size} B`;
		}
		return `${(size / 1024).toFixed(1)} KB`;
	};

	const formattedText = useMemo(() => {
		if (!preview?.textContent) {
			return "";
		}
		if (preview.validJson) {
			try {
				return JSON.stringify(JSON.parse(preview.textContent), null, 2);
			} catch {
				return preview.textContent;
			}
		}
		return preview.textContent;
	}, [preview]);

	const kindLabel = (kind: ResourceKind) => {
		switch (kind) {
			case "texture":
				return tr("텍스처", "Texture");
			case "model":
				return tr("모델", "Model");
			case "blockstate":
				return tr("블록상태", "Blockstate");
			case "lang":
				return tr("언어", "Lang");
			case "sound":
				return tr("사운드", "Sound");
			default:
				return tr("기타", "Other");
		}
	};

	const chips: { id: FilterKind; label: string }[] = [
		{ id: "all", label: tr("전체", "All") },
		{ id: "texture", label: tr("텍스처", "Texture") },
		{ id: "model", label: tr("모델", "Model") },
		{ id: "blockstate", label: tr("블록상태", "Blockstate") },
		{ id: "lang", label: tr("언어", "Lang") }
	];

	if (!project) {
		return (
			<div style={{ padding: 14, color: "var(--text-secondary)", fontSize: 12, lineHeight: 1.5 }}>
				{tr(
					"리소스 자산을 미리 보려면 프로젝트를 먼저 여세요.",
					"Open a Fabric project first to preview textures, models, and JSON assets."
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
							<Icons.IconPalette size={12} />
						</span>
						<input
							type="text"
							value={search}
							onChange={(e) => setSearch(e.target.value)}
							placeholder={tr("리소스 필터...", "Filter assets...")}
							aria-label={tr("리소스 필터", "Filter assets")}
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
						onClick={() => void loadCatalog()}
						disabled={loading}
						title={tr("리소스 다시 스캔", "Rescan Resources")}
						aria-label={tr("리소스 다시 스캔", "Rescan Resources")}
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
				<div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
					{chips.map((chip) => {
						const active = kindFilter === chip.id;
						return (
							<button
								key={chip.id}
								type="button"
								onClick={() => setKindFilter(chip.id)}
								style={{
									padding: "3px 8px",
									borderRadius: 999,
									border: `1px solid ${active ? "var(--accent)" : "var(--border-hairline)"}`,
									background: active ? "rgba(49, 130, 246, 0.16)" : "var(--bg-elevated)",
									color: active ? "var(--accent)" : "var(--text-secondary)",
									fontSize: 11,
									fontWeight: active ? 600 : 500,
									fontVariantNumeric: "tabular-nums",
									cursor: "pointer"
								}}
							>
								{chip.label} ({counts[chip.id]})
							</button>
						);
					})}
				</div>
			</div>
			<div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
				<div style={{ flex: preview || previewLoading || previewError ? "0 0 46%" : 1, overflowY: "auto", minHeight: 0 }}>
					{error && (
						<div style={{ margin: 8, padding: 8, color: "var(--status-danger)", fontSize: 11.5 }}>{error}</div>
					)}
					{!loading && !error && entries.length === 0 && (
						<div style={{ padding: 12, color: "var(--text-tertiary)", fontSize: 12, lineHeight: 1.5 }}>
							{tr(
								"src/*/resources/assets 경로에서 리소스를 찾지 못했어요.",
								"No assets found under src/*/resources/assets."
							)}
						</div>
					)}
					{!loading && entries.length > 0 && filtered.length === 0 && (
						<div style={{ padding: 12, color: "var(--text-tertiary)", fontSize: 12 }}>
							{tr("선택한 조건에 맞는 리소스가 없어요.", "No assets match the active filter.")}
						</div>
					)}
					{filtered.map((entry) => {
						const active = selectedRelPath === entry.relPath;
						return (
							<button
								key={entry.relPath}
								type="button"
								onClick={() => void openPreview(entry)}
								title={entry.relPath}
								style={{
									width: "100%",
									display: "flex",
									alignItems: "center",
									justifyContent: "space-between",
									gap: 6,
									padding: "6px 10px",
									background: active ? "rgba(49, 130, 246, 0.14)" : "transparent",
									border: "none",
									borderBottom: "1px solid rgba(255, 255, 255, 0.03)",
									cursor: "pointer",
									textAlign: "left"
								}}
							>
								<div style={{ minWidth: 0, flex: 1 }}>
									<div
										style={{
											fontSize: 12,
											fontWeight: active ? 600 : 500,
											color: active ? "var(--text-primary)" : "var(--text-secondary)",
											overflow: "hidden",
											textOverflow: "ellipsis",
											whiteSpace: "nowrap"
										}}
									>
										{entry.name}
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
										{entry.namespace} · {kindLabel(entry.kind)}
									</div>
								</div>
								<span
									style={{
										fontSize: 10.5,
										color: "var(--text-tertiary)",
										fontVariantNumeric: "tabular-nums",
										flexShrink: 0
									}}
								>
									{formatBytes(entry.size)}
								</span>
							</button>
						);
					})}
				</div>
				{(previewLoading || previewError || preview) && (
					<div
						style={{
							flex: 1,
							minHeight: 0,
							borderTop: "1px solid var(--border-strong)",
							background: "var(--bg-canvas)",
							display: "flex",
							flexDirection: "column"
						}}
					>
						<div
							style={{
								padding: "6px 10px",
								borderBottom: "1px solid var(--border-hairline)",
								background: "var(--bg-panel)",
								display: "flex",
								alignItems: "center",
								justifyContent: "space-between",
								gap: 6
							}}
						>
							<span
								style={{
									fontSize: 11,
									color: "var(--text-secondary)",
									fontFamily: "var(--font-mono)",
									overflow: "hidden",
									textOverflow: "ellipsis",
									whiteSpace: "nowrap"
								}}
								title={selectedRelPath ?? undefined}
							>
								{selectedRelPath?.split("/").pop()}
							</span>
							{preview && (
								<button
									type="button"
									onClick={() => void store.openFileTab(preview.relPath)}
									style={{
										padding: "3px 8px",
										borderRadius: "var(--radius-m)",
										background: "var(--bg-control)",
										border: "1px solid var(--border-hairline)",
										color: "var(--text-primary)",
										fontSize: 11,
										fontWeight: 500,
										cursor: "pointer",
										flexShrink: 0
									}}
								>
									{tr("에디터에서 열기", "Open in Editor")}
								</button>
							)}
						</div>
						<div style={{ flex: 1, overflow: "auto", padding: 10 }}>
							{previewLoading && (
								<div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
									{tr("미리보기 불러오는 중...", "Loading preview...")}
								</div>
							)}
							{previewError && (
								<div style={{ fontSize: 11.5, color: "var(--status-danger)" }}>{previewError}</div>
							)}
							{!previewLoading && preview && preview.base64Data && (
								<div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
									<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
										<span
											style={{
												padding: "2px 7px",
												borderRadius: 6,
												background: "var(--bg-elevated)",
												border: "1px solid var(--border-hairline)",
												color: "var(--text-secondary)",
												fontSize: 11,
												fontFamily: "var(--font-mono)",
												fontVariantNumeric: "tabular-nums"
											}}
										>
											{preview.width ?? "?"} × {preview.height ?? "?"}
										</span>
										<div style={{ display: "flex", gap: 3 }}>
											{ZOOM_LEVELS.map((z) => (
												<button
													key={z}
													type="button"
													onClick={() => setZoom(z)}
													style={{
														padding: "2px 6px",
														borderRadius: 5,
														border: `1px solid ${zoom === z ? "var(--accent)" : "var(--border-hairline)"}`,
														background: zoom === z ? "rgba(49, 130, 246, 0.16)" : "var(--bg-control)",
														color: zoom === z ? "var(--accent)" : "var(--text-secondary)",
														fontSize: 10.5,
														fontVariantNumeric: "tabular-nums",
														cursor: "pointer"
													}}
												>
													{z}x
												</button>
											))}
										</div>
									</div>
									<div
										style={{
											minHeight: 120,
											padding: 12,
											borderRadius: "var(--radius-l)",
											border: "1px solid var(--border-hairline)",
											display: "flex",
											alignItems: "center",
											justifyContent: "center",
											overflow: "auto",
											backgroundImage:
												"repeating-conic-gradient(#1b202e 0% 25%, #12151e 0% 50%)",
											backgroundSize: "12px 12px"
										}}
									>
										<img
											src={`data:${preview.mimeType ?? "image/png"};base64,${preview.base64Data}`}
											alt={preview.relPath}
											style={{
												width: preview.width ? preview.width * zoom : undefined,
												height: preview.height ? preview.height * zoom : undefined,
												maxWidth: preview.width ? undefined : "100%",
												imageRendering: "pixelated",
												display: "block"
											}}
										/>
									</div>
								</div>
							)}
							{!previewLoading && preview && !preview.base64Data && preview.textContent !== null && (
								<div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
									{preview.validJson !== null && (
										<div style={{ display: "flex", alignItems: "center", gap: 6 }}>
											<span
												style={{
													display: "inline-flex",
													alignItems: "center",
													gap: 4,
													padding: "2px 7px",
													borderRadius: 6,
													background: preview.validJson
														? "rgba(34, 197, 94, 0.14)"
														: "rgba(240, 68, 82, 0.14)",
													color: preview.validJson
														? "var(--status-success)"
														: "var(--status-danger)",
													fontSize: 11,
													fontWeight: 600
												}}
											>
												{preview.validJson ? <Icons.IconCheck size={12} /> : <Icons.IconError size={12} />}
												{preview.validJson
													? tr("유효한 JSON", "Valid JSON")
													: tr("JSON 구문 오류", "Invalid JSON")}
											</span>
										</div>
									)}
									{preview.jsonError && (
										<div
											style={{
												padding: "6px 8px",
												borderRadius: "var(--radius-m)",
												background: "rgba(240, 68, 82, 0.1)",
												color: "var(--status-danger)",
												fontSize: 11,
												fontFamily: "var(--font-mono)"
											}}
										>
											{preview.jsonError}
										</div>
									)}
									<pre
										style={{
											margin: 0,
											padding: 10,
											borderRadius: "var(--radius-m)",
											background: "var(--bg-panel)",
											border: "1px solid var(--border-hairline)",
											color: "var(--text-primary)",
											fontSize: 11,
											lineHeight: 1.5,
											fontFamily: "var(--font-mono)",
											overflow: "auto",
											whiteSpace: "pre"
										}}
									>
										{formattedText}
									</pre>
								</div>
							)}
						</div>
					</div>
				)}
			</div>
		</div>
	);
}