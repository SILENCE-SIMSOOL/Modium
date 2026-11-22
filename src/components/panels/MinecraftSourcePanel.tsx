import { sourceOrigin } from "../../services/sourceOrigin";
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n";
import { backend } from "../../services/backend";
import { store, useStore } from "../../state/store";
import type { MinecraftClassEntry } from "../../types/ipc";
import * as Icons from "../ui/Icons";

export function MinecraftSourcePanel() {
	const { tr } = useI18n();
	const project = useStore((s) => s.project);
	const [query, setQuery] = useState("");
	const [entries, setEntries] = useState<MinecraftClassEntry[]>([]);
	const [loading, setLoading] = useState(false);
	const [openingKey, setOpeningKey] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const reqSeq = useRef(0);

	const runQuery = useCallback(
		async (q: string) => {
			if (!project) {
				setEntries([]);
				setError(null);
				return;
			}
			const seq = ++reqSeq.current;
			setLoading(true);
			setError(null);
			try {
				const list = await backend.searchMinecraftSources(q.trim());
				if (seq !== reqSeq.current) {
					return;
				}
				setEntries(list);
			} catch (err) {
				if (seq !== reqSeq.current) {
					return;
				}
				setEntries([]);
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				if (seq === reqSeq.current) {
					setLoading(false);
				}
			}
		},
		[project]
	);

	useEffect(() => {
		if (!project) {
			setEntries([]);
			setError(null);
			return;
		}
		const timer = window.setTimeout(() => {
			void runQuery(query);
		}, 240);
		return () => window.clearTimeout(timer);
	}, [query, project, runQuery]);

	const handleOpenClass = async (entry: MinecraftClassEntry) => {
		const key = `${entry.sourceJar}:${entry.entryPath}`;
		setOpeningKey(key);
		try {
			const content = await backend.readMinecraftSource(entry.sourceJar, entry.entryPath);
			const uri = `mc-source://${encodeURIComponent(entry.sourceJar)}/${entry.entryPath}`;
			store.openVirtualTab(`${entry.className}.java`, uri, "java", content);
		} catch (err) {
			store.showToast("error", err instanceof Error ? err.message : String(err));
		} finally {
			setOpeningKey(null);
		}
	};

	const jarBaseName = (jarPath: string) => {
		const parts = jarPath.replace(/\\/g, "/").split("/");
		return parts[parts.length - 1] || jarPath;
	};

	if (!project) {
		return (
			<div style={{ padding: 14, color: "var(--text-secondary)", fontSize: 12, lineHeight: 1.5 }}>
				{tr(
					"Minecraft 소스를 탐색하려면 프로젝트를 먼저 여세요.",
					"Open a Fabric project first to browse Loom Minecraft sources."
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
				<form
					onSubmit={(e) => {
						e.preventDefault();
						void runQuery(query);
					}}
					style={{ display: "flex", alignItems: "center", gap: 6 }}
				>
					<div
						style={{
							flex: 1,
							display: "flex",
							alignItems: "center",
							gap: 6,
							height: 30,
							padding: "0 8px",
							background: "var(--bg-elevated)",
							border: "1px solid var(--border-strong)",
							borderRadius: "var(--radius-m)"
						}}
					>
						<span style={{ color: "var(--text-tertiary)", display: "flex" }}>
							<Icons.IconCube size={13} />
						</span>
						<input
							type="text"
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							placeholder={tr("Minecraft 클래스 검색 (예: MinecraftServer)", "Search MC class (e.g. MinecraftServer)")}
							aria-label={tr("Minecraft 클래스 검색", "Search Minecraft classes")}
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
						{query && (
							<button
								type="button"
								onClick={() => setQuery("")}
								aria-label={tr("지우기", "Clear")}
								style={{
									background: "transparent",
									border: "none",
									color: "var(--text-tertiary)",
									cursor: "pointer",
									display: "flex",
									padding: 2
								}}
							>
								<Icons.IconClose size={12} />
							</button>
						)}
					</div>
					<button
						type="button"
						onClick={() => void runQuery(query)}
						disabled={loading}
						title={tr("새로고침", "Refresh")}
						aria-label={tr("새로고침", "Refresh")}
						style={{
							height: 30,
							width: 30,
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
				</form>
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
							? tr("소스 JAR 검색 중...", "Searching source JARs...")
							: tr(`${entries.length}개 클래스`, `${entries.length} classes`)}
					</span>
					<button
						type="button"
						onClick={() => void store.runGradle("genSources")}
						style={{
							background: "transparent",
							border: "none",
							color: "var(--accent)",
							fontSize: 11,
							fontWeight: 600,
							cursor: "pointer",
							padding: 0
						}}
					>
						GenSources
					</button>
				</div>
			</div>
			<div style={{ flex: 1, overflowY: "auto", minHeight: 0, padding: "6px 0" }}>
				{error && (
					<div
						style={{
							margin: "6px 10px",
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
					<div
						style={{
							margin: 10,
							padding: 12,
							background: "var(--bg-elevated)",
							border: "1px solid var(--border-hairline)",
							borderRadius: "var(--radius-l)",
							display: "flex",
							flexDirection: "column",
							gap: 8
						}}
					>
						<div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)" }}>
							{query.trim()
								? tr("일치하는 클래스를 찾지 못했어요", "No matching Minecraft classes found")
								: tr("Loom 소스 JAR가 아직 생성되지 않았어요", "No Loom source JARs cached yet")}
						</div>
						<div style={{ fontSize: 11.5, color: "var(--text-secondary)", lineHeight: 1.5 }}>
							{query.trim()
								? tr(
										"다른 클래스 이름으로 검색하거나 GenSources를 실행해 디컴파일 소스를 생성하세요.",
										"Try another class name or run GenSources to generate Loom sources."
									)
								: tr(
										"Gradle genSources 작업을 실행하면 Minecraft와 Fabric API 소스를 읽기 전용 탭으로 바로 열 수 있어요.",
										"Run the Gradle genSources task to extract Minecraft and Fabric API sources into Loom cache."
									)}
						</div>
						<div style={{ display: "flex", gap: 6 }}>
							<button
								type="button"
								onClick={() => void store.runGradle("genSources")}
								style={{
									padding: "6px 12px",
									borderRadius: "var(--radius-m)",
									background: "var(--accent)",
									border: "none",
									color: "#FFFFFF",
									fontSize: 11.5,
									fontWeight: 600,
									cursor: "pointer"
								}}
							>
								{tr("GenSources 실행", "Run GenSources")}
							</button>
							<button
								type="button"
								onClick={() => void runQuery(query)}
								style={{
									padding: "6px 10px",
									borderRadius: "var(--radius-m)",
									background: "var(--bg-control)",
									border: "1px solid var(--border-hairline)",
									color: "var(--text-primary)",
									fontSize: 11.5,
									cursor: "pointer"
								}}
							>
								{tr("다시 확인", "Retry")}
							</button>
						</div>
					</div>
				)}
				{entries.map((entry) => {
					const key = `${entry.sourceJar}:${entry.entryPath}`;
					const isOpening = openingKey === key;
					return (
						<button
							key={key}
							type="button"
							disabled={isOpening}
							onClick={() => void handleOpenClass(entry)}
							title={`${entry.packageName}.${entry.className} (${jarBaseName(entry.sourceJar)})`}
							style={{
								width: "100%",
								display: "flex",
								flexDirection: "column",
								gap: 2,
								padding: "6px 10px",
								background: isOpening ? "var(--bg-elevated)" : "transparent",
								border: "none",
								borderBottom: "1px solid rgba(255, 255, 255, 0.03)",
								cursor: isOpening ? "wait" : "pointer",
								textAlign: "left"
							}}
						>
							<div style={{ display: "flex", alignItems: "center", gap: 6 }}>
								<span style={{ color: "var(--accent)", display: "flex", flexShrink: 0 }}>
									<Icons.IconJava size={13} />
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
									display: "flex",
									alignItems: "center",
									justifyContent: "space-between",
									gap: 6,
									paddingLeft: 19
								}}
							>
								<span
									style={{
										fontSize: 10.5,
										color: "var(--text-tertiary)",
										fontFamily: "var(--font-mono)",
										overflow: "hidden",
										textOverflow: "ellipsis",
										whiteSpace: "nowrap"
									}}
								>
									{entry.packageName || tr("(기본 패키지)", "(default)")}
								</span>
								<span
									style={{
										fontSize: 10,
										color: "var(--text-tertiary)",
										flexShrink: 0,
										maxWidth: 96,
										overflow: "hidden",
										textOverflow: "ellipsis",
										whiteSpace: "nowrap"
									}}
								>
									{sourceOrigin(entry, tr)}
								</span>
							</div>
						</button>
					);
				})}
			</div>
		</div>
	);
}