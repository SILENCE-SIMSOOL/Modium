import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../i18n";
import { backend } from "../../services/backend";
import { store, useStore } from "../../state/store";
import type { SearchMatch } from "../../types/ipc";
import * as Icons from "../ui/Icons";

interface GroupedMatches {
	relPath: string;
	matches: SearchMatch[];
}

export function SearchPanel() {
	const { tr } = useI18n();
	const project = useStore((s) => s.project);
	const [query, setQuery] = useState("");
	const [caseSensitive, setCaseSensitive] = useState(false);
	const [useRegex, setUseRegex] = useState(false);
	const [matches, setMatches] = useState<SearchMatch[]>([]);
	const [truncated, setTruncated] = useState(false);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [hasSearched, setHasSearched] = useState(false);
	const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
	const reqSeq = useRef(0);

	const runSearch = useCallback(
		async (q: string, cs: boolean, rx: boolean) => {
			const trimmed = q.trim();
			if (!project || !trimmed) {
				reqSeq.current += 1;
				setMatches([]);
				setError(null);
				setHasSearched(false);
				setLoading(false);
				return;
			}
			const seq = ++reqSeq.current;
			setLoading(true);
			setError(null);
			try {
				const res = await backend.searchInWorkspace(trimmed, cs, rx);
				if (seq !== reqSeq.current) {
					return;
				}
				setMatches(res.items);
				setTruncated(res.truncated);
				setHasSearched(true);
				setCollapsed({});
			} catch (err) {
				if (seq !== reqSeq.current) {
					return;
				}
				setMatches([]);
				setHasSearched(true);
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
		setMatches([]);
		setError(null);
		setHasSearched(false);
	}, [project?.path]);

	useEffect(() => {
		if (!project) {
			return;
		}
		if (!query.trim()) {
			reqSeq.current += 1;
			setMatches([]);
			setError(null);
			setHasSearched(false);
			return;
		}
		const timer = window.setTimeout(() => {
			void runSearch(query, caseSensitive, useRegex);
		}, 260);
		return () => { window.clearTimeout(timer); reqSeq.current += 1; };
	}, [query, caseSensitive, useRegex, project, runSearch]);

	const grouped = useMemo<GroupedMatches[]>(() => {
		const map = new Map<string, SearchMatch[]>();
		for (const item of matches) {
			const list = map.get(item.relPath);
			if (list) {
				list.push(item);
			} else {
				map.set(item.relPath, [item]);
			}
		}
		return Array.from(map.entries()).map(([relPath, list]) => ({
			relPath,
			matches: list
		}));
	}, [matches]);

	const toggleGroup = (relPath: string) => {
		setCollapsed((prev) => ({ ...prev, [relPath]: !prev[relPath] }));
	};

	const renderHighlightedLine = (match: SearchMatch) => {
		const start = match.column - match.previewColumn;
		const end = match.endColumn - match.previewColumn;
		return <>{match.lineText.slice(0, start)}<mark>{match.lineText.slice(start, end)}</mark>{match.lineText.slice(end)}</>;
	};

	if (!project) {
		return (
			<div style={{ padding: 14, color: "var(--text-secondary)", fontSize: 12, lineHeight: 1.5 }}>
				{tr(
					"워크스페이스 검색을 사용하려면 프로젝트를 먼저 여세요.",
					"Open a Fabric project first to search across workspace files."
				)}
			</div>
		);
	}

	return (
		<div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
			<div
				style={{
					padding: "10px 10px 8px",
					borderBottom: "1px solid var(--border-hairline)",
					display: "flex",
					flexDirection: "column",
					gap: 6
				}}
			>
				<form
					onSubmit={(e) => {
						e.preventDefault();
						void runSearch(query, caseSensitive, useRegex);
					}}
					style={{ display: "flex", alignItems: "center", gap: 4 }}
				>
					<div
						style={{
							position: "relative",
							flex: 1,
							display: "flex",
							alignItems: "center",
							background: "var(--bg-elevated)",
							border: "1px solid var(--border-strong)",
							borderRadius: "var(--radius-m)",
							padding: "0 6px 0 8px",
							height: 30
						}}
					>
						<span style={{ color: "var(--text-tertiary)", display: "flex", marginRight: 6 }}>
							<Icons.IconSearch size={13} />
						</span>
						<input
							type="text"
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							placeholder={tr("파일 내용 검색...", "Search in workspace...")}
							aria-label={tr("검색어", "Search query")}
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
								title={tr("지우기", "Clear")}
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
						onClick={() => setCaseSensitive((v) => !v)}
						title={tr("대소문자 구분", "Match Case")}
						aria-label={tr("대소문자 구분", "Match Case")}
						aria-pressed={caseSensitive}
						style={{
							height: 30,
							minWidth: 28,
							padding: "0 6px",
							borderRadius: "var(--radius-m)",
							border: `1px solid ${caseSensitive ? "var(--accent)" : "var(--border-hairline)"}`,
							background: caseSensitive ? "rgba(49, 130, 246, 0.16)" : "var(--bg-elevated)",
							color: caseSensitive ? "var(--accent)" : "var(--text-secondary)",
							fontSize: 11,
							fontWeight: 600,
							fontFamily: "var(--font-mono)",
							cursor: "pointer"
						}}
					>
						Aa
					</button>
					<button
						type="button"
						onClick={() => setUseRegex((v) => !v)}
						title={tr("정규식 사용", "Use Regular Expression")}
						aria-label={tr("정규식 사용", "Use Regular Expression")}
						aria-pressed={useRegex}
						style={{
							height: 30,
							minWidth: 28,
							padding: "0 6px",
							borderRadius: "var(--radius-m)",
							border: `1px solid ${useRegex ? "var(--accent)" : "var(--border-hairline)"}`,
							background: useRegex ? "rgba(49, 130, 246, 0.16)" : "var(--bg-elevated)",
							color: useRegex ? "var(--accent)" : "var(--text-secondary)",
							fontSize: 11,
							fontWeight: 600,
							fontFamily: "var(--font-mono)",
							cursor: "pointer"
						}}
					>
						.*
					</button>
				</form>
				{hasSearched && !error && (
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
								? tr("검색 중...", "Searching...")
								: tr(
										`${grouped.length}개 파일에서 ${matches.length}건 일치`,
										`${matches.length} results in ${grouped.length} files`
									)}
						</span>
						{truncated && matches.length > 0 && (
							<span style={{ color: "var(--status-warning)" }}>
								{tr("최대 500건 표시", "Capped at 500")}
							</span>
						)}
					</div>
				)}
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
							fontSize: 11,
							lineHeight: 1.4,
							display: "flex",
							alignItems: "flex-start",
							gap: 6
						}}
					>
						<Icons.IconError size={14} />
						<span style={{ wordBreak: "break-word" }}>{error}</span>
					</div>
				)}
				{!hasSearched && !loading && !error && (
					<div style={{ padding: "12px 12px", color: "var(--text-tertiary)", fontSize: 12, lineHeight: 1.5 }}>
						{tr(
							"검색어를 입력하면 워크스페이스 전체에서 일치하는 코드를 찾아요.",
							"Enter text or a pattern to search across project source files."
						)}
					</div>
				)}
				{hasSearched && !loading && !error && grouped.length === 0 && (
					<div style={{ padding: "12px 12px", color: "var(--text-tertiary)", fontSize: 12, lineHeight: 1.5 }}>
						{tr(
							"일치하는 결과를 찾지 못했어요. 대소문자 구분이나 정규식 옵션을 확인해 보세요.",
							"No matches found. Check Case Sensitive or Regex toggles and try again."
						)}
					</div>
				)}
				{grouped.map((group) => {
					const isCollapsed = Boolean(collapsed[group.relPath]);
					const fileName = group.relPath.split("/").pop() ?? group.relPath;
					const dirName = group.relPath.includes("/")
						? group.relPath.slice(0, group.relPath.lastIndexOf("/"))
						: "";
					return (
						<div key={group.relPath} style={{ marginBottom: 2 }}>
							<button
								type="button"
								onClick={() => toggleGroup(group.relPath)}
								style={{
									width: "100%",
									display: "flex",
									alignItems: "center",
									gap: 6,
									padding: "5px 10px",
									background: "transparent",
									border: "none",
									color: "var(--text-primary)",
									cursor: "pointer",
									textAlign: "left",
									fontSize: 12
								}}
							>
								<span
									style={{
										display: "flex",
										color: "var(--text-tertiary)",
										transform: isCollapsed ? "rotate(0deg)" : "rotate(90deg)",
										transition: "transform 120ms ease"
									}}
								>
									<Icons.IconChevron size={12} />
								</span>
								<span style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
									{fileName}
								</span>
								{dirName && (
									<span
										style={{
											flex: 1,
											minWidth: 0,
											fontSize: 11,
											color: "var(--text-tertiary)",
											overflow: "hidden",
											textOverflow: "ellipsis",
											whiteSpace: "nowrap"
										}}
									>
										{dirName}
									</span>
								)}
								<span
									style={{
										marginLeft: "auto",
										padding: "1px 6px",
										borderRadius: 999,
										background: "var(--bg-control)",
										color: "var(--text-secondary)",
										fontSize: 10,
										fontVariantNumeric: "tabular-nums"
									}}
								>
									{group.matches.length}
								</span>
							</button>
							{!isCollapsed &&
								group.matches.map((m, idx) => (
									<button
										key={`${m.relPath}:${m.line}:${m.column}:${idx}`}
										type="button"
										onClick={() => void store.openFileTab(m.relPath, m.line)}
										title={`${m.relPath}:${m.line} — ${m.lineText}`}
										style={{
											width: "100%",
											display: "flex",
											alignItems: "baseline",
											gap: 8,
											padding: "3px 10px 3px 26px",
											background: "transparent",
											border: "none",
											cursor: "pointer",
											textAlign: "left",
											color: "var(--text-secondary)",
											fontSize: 11.5
										}}
									>
										<span
											style={{
												flexShrink: 0,
												minWidth: 28,
												color: "var(--text-tertiary)",
												fontFamily: "var(--font-mono)",
												fontVariantNumeric: "tabular-nums",
												textAlign: "right"
											}}
										>
											{m.line}
										</span>
										<span
											style={{
												flex: 1,
												minWidth: 0,
												fontFamily: "var(--font-mono)",
												whiteSpace: "nowrap",
												overflow: "hidden",
												textOverflow: "ellipsis"
											}}
										>
											{renderHighlightedLine(m)}
										</span>
									</button>
								))}
						</div>
					);
				})}
			</div>
		</div>
	);
}