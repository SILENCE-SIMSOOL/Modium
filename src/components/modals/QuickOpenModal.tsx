import { sourceOrigin } from "../../services/sourceOrigin";
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../i18n";
import { backend } from "../../services/backend";
import { fromFileUri, store, useStore } from "../../state/store";
import type { MinecraftClassEntry } from "../../types/ipc";
import * as Icons from "../ui/Icons";
import { ModalDialog } from "../ui/ModalDialog";

interface QuickFileItem {
	kind: "file";
	id: string;
	title: string;
	subtitle: string;
	relPath: string;
	score: number;
}

interface QuickMcItem {
	kind: "mc";
	id: string;
	title: string;
	subtitle: string;
	entry: MinecraftClassEntry;
	score: number;
}

interface TypeItem {
	kind: "type";
	id: string;
	title: string;
	subtitle: string;
	uri: string;
	line: number;
	column: number;
	score: number;
}
type QuickItem = QuickFileItem | QuickMcItem | TypeItem;

function scoreCandidate(text: string, query: string): number {
	const q = query.trim().toLowerCase();
	if (!q) {
		return 1;
	}
	const lower = text.toLowerCase();
	const fileName = lower.split("/").pop() ?? lower;
	if (fileName === q) {
		return 120;
	}
	if (fileName.startsWith(q)) {
		return 100;
	}
	if (fileName.includes(q)) {
		return 80;
	}
	if (lower.includes(q)) {
		return 60;
	}
	let qi = 0;
	let streak = 0;
	let bonus = 0;
	for (let i = 0; i < lower.length && qi < q.length; i += 1) {
		if (lower[i] === q[qi]) {
			qi += 1;
			streak += 1;
			bonus += streak;
		} else {
			streak = 0;
		}
	}
	return qi === q.length ? 20 + Math.min(35, bonus) : 0;
}

export function QuickOpenModal() {
	const { tr } = useI18n();
	const activeModal = useStore((s) => s.activeModal);
	const project = useStore((s) => s.project);
	const types = activeModal === "typeSearch";
	const resources = activeModal === "resourceSearch";
	const open = activeModal === "quickOpen" || types || resources;
	const title = types ? tr("클래스 검색", "Open Type") : resources ? tr("리소스 검색", "Open Resource") : tr("빠른 열기", "Quick Open");
	const [symbols, setSymbols] = useState<TypeItem[]>([]);

	const [query, setQuery] = useState("");
	const [files, setFiles] = useState<string[]>([]);
	const [limited, setLimited] = useState(false);
	const [extraFiles, setExtraFiles] = useState<string[]>([]);
	const [mcClasses, setMcClasses] = useState<MinecraftClassEntry[]>([]);
	const [loadingFiles, setLoadingFiles] = useState(false);
	const [opening, setOpening] = useState(false);
	const [selectedIndex, setSelectedIndex] = useState(0);

	const inputRef = useRef<HTMLInputElement | null>(null);
	const listRef = useRef<HTMLDivElement | null>(null);
	const mcReqSeq = useRef(0);

	useEffect(() => {
		if (!open) {
			return;
		}
		let active = true;
		setFiles([]);
		setLimited(false);
		setQuery("");
		setSelectedIndex(0);
		setMcClasses([]);
		const timer = window.setTimeout(() => {
			inputRef.current?.focus();
		}, 20);
		if (project) {
			setLoadingFiles(true);
			void backend
				.listAllFiles()
				.then((list) => { if (active) { setFiles(list.items); setLimited(list.truncated); } })
				.catch(() => { if (active) setFiles([]); })
				.finally(() => { if (active) setLoadingFiles(false); });
		} else {
			setFiles([]);
		}
		return () => { active = false; window.clearTimeout(timer); };
	}, [activeModal, open, project?.path]);

	useEffect(() => {
		let active = true;
		setExtraFiles([]);
		if (!open || !limited || !query.trim()) return;
		const timer = window.setTimeout(() => {
			void backend.listAllFiles(query.trim()).then(result => {
				if (active) setExtraFiles(result.items);
			}).catch(err => { if (active) store.showToast("error", String(err)); });
		}, 150);
		return () => { active = false; window.clearTimeout(timer); };
	}, [open, limited, project?.path, query]);

	useEffect(() => {
		if (!open || !project || resources) {
			return;
		}
		const trimmed = query.trim();
		if (trimmed.length < 2) {
			mcReqSeq.current += 1;
			setMcClasses([]);
			return;
		}
		const seq = ++mcReqSeq.current;
		const timer = window.setTimeout(() => {
			void backend
				.searchMinecraftSources(trimmed)
				.then((res) => {
					if (seq === mcReqSeq.current) {
						setMcClasses(res.slice(0, 30));
					}
				})
				.catch(() => {
					if (seq === mcReqSeq.current) {
						setMcClasses([]);
					}
				});
		}, 180);
		return () => { window.clearTimeout(timer); mcReqSeq.current++; };
	}, [open, project?.path, query, resources]);

	useEffect(() => {
		let active = true;
		setSymbols([]);
		if (!types || !project || !query.trim()) return;
		const timer = window.setTimeout(async () => {
			try {
				const list = await backend.lspSearchTypes(query.trim());
				if (active) setSymbols((list ?? []).filter(s => [5, 10, 11, 23].includes(s.kind) && s.location?.uri).map(s => ({
					kind: "type", id: s.location.uri + "#" + s.name, title: s.name, subtitle: s.containerName ?? "",
					uri: s.location.uri, line: (s.location.range?.start.line ?? 0) + 1,
					column: (s.location.range?.start.character ?? 0) + 1, score: scoreCandidate(s.name, query)
				})).filter(s => s.uri.startsWith("jdt:") || fromFileUri(s.uri, project.path)) as TypeItem[]);
			} catch { /* File and Loom source results remain available during indexing. */ }
		}, 150);
		return () => { active = false; window.clearTimeout(timer); };
	}, [types, query, project?.path]);

	const items = useMemo<QuickItem[]>(() => {
		const trimmed = query.trim();
		const fileItems: QuickItem[] = [];
		for (const relPath of new Set([...files, ...extraFiles])) {
			if (types && !relPath.endsWith(".java")) continue;
			const score = scoreCandidate(relPath, trimmed);
			if (score > 0) {
				const parts = relPath.split("/");
				const title = parts[parts.length - 1] || relPath;
				const subtitle = parts.slice(0, -1).join("/");
				fileItems.push({
					kind: "file",
					id: `file:${relPath}`,
					title,
					subtitle,
					relPath,
					score
				});
			}
		}
		fileItems.sort((a, b) => b.score - a.score || Number(b.kind === "file" && b.relPath.startsWith("src/")) - Number(a.kind === "file" && a.relPath.startsWith("src/")) || a.title.localeCompare(b.title));

		const mcItems: QuickItem[] = mcClasses.map((entry) => ({
			kind: "mc",
			id: `mc:${entry.sourceJar}:${entry.entryPath}`,
			title: `${entry.className}.java`,
			subtitle: [entry.packageName, sourceOrigin(entry, tr)].filter(Boolean).join(" · "),
			entry,
			score: scoreCandidate(`${entry.packageName}.${entry.className}`, trimmed)
		}));

		if (types) {
			const merged = new Map<string, QuickItem>();
			for (const item of [...symbols, ...fileItems, ...mcItems]) {
				const key = item.kind === "type" ? (fromFileUri(item.uri, project?.path ?? null) ?? item.uri) + "#" + item.title : item.kind === "file" ? item.relPath + "#" + item.title.replace(/\.java$/, "") : item.id;
				if (!merged.has(key)) merged.set(key, item);
			}
			return [...merged.values()].sort((a,b) => b.score - a.score).slice(0,100);
		}
		return [...fileItems.slice(0, 60), ...(resources ? [] : mcItems.slice(0, 30))];
	}, [files, extraFiles, mcClasses, query, symbols, types, resources, project?.path]);

	useEffect(() => {
		setSelectedIndex(0);
	}, [query]);

	useEffect(() => {
		if (!listRef.current) {
			return;
		}
		const activeEl = listRef.current.querySelector<HTMLElement>("[data-selected='true']");
		activeEl?.scrollIntoView({ block: "nearest" });
	}, [selectedIndex, items]);

	const close = () => {
		store.setActiveModal("none");
	};

	const openItem = async (item: QuickItem) => {
		if (opening) {
			return;
		}
		setOpening(true);
		try {
			if (item.kind === "type") {
				const rel = fromFileUri(item.uri, project?.path ?? null);
				if (rel) await store.openFileTab(rel, item.line, item.column);
				else {
					const content = await backend.lspClassFileContents(item.uri);
					if (!content) throw Error(tr("클래스 소스를 열 수 없어.", "Class source unavailable."));
					store.openVirtualTab(item.title + ".java", item.uri, "java", content, item.line);
				}
			} else if (item.kind === "file") {
				if (/\.(png|jpe?g|gif|webp)$/i.test(item.relPath)) {
					const preview = await backend.readResourcePreview(item.relPath);
					if (!preview.base64Data || !preview.mimeType) throw Error(tr("이미지 미리보기를 열 수 없어.", "Image preview unavailable."));
					store.openVirtualTab(item.title, "modium-image://" + encodeURIComponent(item.relPath), "image", "data:" + preview.mimeType + ";base64," + preview.base64Data);
				} else {
					await store.openFileTab(item.relPath);
				}
			} else {
				const content = await backend.readMinecraftSource(
					item.entry.sourceJar,
					item.entry.entryPath
				);
				const uri = `mc-source://${encodeURIComponent(item.entry.sourceJar)}/${item.entry.entryPath}`;
				store.openVirtualTab(item.title, uri, "java", content);
			}
			close();
		} catch (err) {
			store.showToast("error", err instanceof Error ? err.message : String(err));
		} finally {
			setOpening(false);
		}
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (items.length === 0) {
			return;
		}
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setSelectedIndex((prev) => (prev + 1) % items.length);
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			setSelectedIndex((prev) => (prev - 1 + items.length) % items.length);
		} else if (e.key === "Enter") {
			e.preventDefault();
			const target = items[selectedIndex] ?? items[0];
			if (target) {
				void openItem(target);
			}
		}
	};

	return (
		<ModalDialog
			open={open}
			onClose={close}
			title={title}
			subtitle={types ? tr("프로젝트와 Java 의존성의 타입 선언 찾기", "Find type declarations in the project and dependencies") : resources ? tr("프로젝트 파일을 이름이나 경로로 찾기", "Find project resources by name or path") : tr(
				"워크스페이스 파일과 Minecraft 소스 클래스를 빠르게 검색해 열어요",
				"Search workspace files and Minecraft source classes"
			)}
			icon={<Icons.IconSearch size={16} />}
			width={580}
		>
			<div onKeyDown={handleKeyDown} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
				<div
					style={{
						display: "flex",
						alignItems: "center",
						gap: 8,
						height: 36,
						padding: "0 10px",
						borderRadius: "var(--radius-m)",
						background: "var(--bg-elevated)",
						border: "1.5px solid var(--accent)"
					}}
				>
					<span style={{ color: "var(--text-tertiary)", display: "flex" }}>
						<Icons.IconSearch size={14} />
					</span>
					<input
						ref={inputRef}
						type="text"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder={types ? tr("클래스 이름", "Type name") : resources ? tr("파일 이름 또는 경로", "File name or path") : tr(
							"파일명 또는 Minecraft 클래스명 입력...",
							"Type a file path or Minecraft class name..."
						)}
						aria-label={tr("빠른 열기 검색어", "Quick open filter")}
						style={{
							flex: 1,
							minWidth: 0,
							background: "transparent",
							border: "none",
							outline: "none",
							color: "var(--text-primary)",
							fontSize: 13
						}}
					/>
					<span className="fs-kbd">↑↓</span>
					<span className="fs-kbd">Enter</span>
				</div>
				{limited && <small>{tr("처음 5,000개 파일을 표시해. 이름을 입력하면 전체에서 찾아.", "Showing the first 5,000 files. Type a name to search all files.")}</small>}
				<div
					ref={listRef}
					style={{
						maxHeight: 340,
						minHeight: 160,
						overflowY: "auto",
						borderRadius: "var(--radius-m)",
						border: "1px solid var(--border-hairline)",
						background: "var(--bg-canvas)"
					}}
				>
					{!project ? (
						<div style={{ padding: 16, fontSize: 12.5, color: "var(--text-secondary)" }}>
							{tr(
								"파일을 검색하려면 프로젝트를 먼저 여세요.",
								"Open a Fabric project first to browse files."
							)}
						</div>
					) : loadingFiles ? (
						<div style={{ padding: 16, fontSize: 12.5, color: "var(--text-tertiary)" }}>
							{tr("파일 목록 불러오는 중...", "Loading workspace files...")}
						</div>
					) : items.length === 0 ? (
						<div style={{ padding: 16, fontSize: 12.5, color: "var(--text-tertiary)" }}>
							{tr("일치하는 파일이나 클래스가 없어요.", "No matching files or Minecraft classes.")}
						</div>
					) : (
						items.map((item, idx) => {
							const selected = idx === selectedIndex;
							return (
								<button
									key={item.id}
									type="button"
									data-selected={selected}
									onMouseEnter={() => setSelectedIndex(idx)}
									onClick={() => void openItem(item)}
									style={{
										width: "100%",
										display: "flex",
										alignItems: "center",
										justifyContent: "space-between",
										gap: 10,
										padding: "7px 10px",
										background: selected ? "var(--accent-weak-bg)" : "transparent",
										borderBottom: "1px solid rgba(255, 255, 255, 0.03)",
										textAlign: "left"
									}}
								>
									<div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, flex: 1 }}>
										<span
											style={{
												color: item.kind === "mc" ? "var(--accent-weak-text)" : "var(--text-secondary)",
												display: "flex",
												flexShrink: 0
											}}
										>
											{item.kind === "mc" ? (
												<Icons.IconCube size={14} />
											) : item.title.endsWith(".java") ? (
												<Icons.IconJava size={14} />
											) : item.title.endsWith(".json") ? (
												<Icons.IconJson size={14} />
											) : (
												<Icons.IconFile size={14} />
											)}
										</span>
										<div style={{ minWidth: 0, flex: 1 }}>
											<div
												style={{
													fontSize: 12.5,
													fontWeight: selected ? 600 : 500,
													color: "var(--text-primary)",
													overflow: "hidden",
													textOverflow: "ellipsis",
													whiteSpace: "nowrap"
												}}
											>
												{item.title}
											</div>
											{item.subtitle && (
												<div
													style={{
														fontSize: 11,
														color: "var(--text-tertiary)",
														fontFamily: "var(--font-mono)",
														overflow: "hidden",
														textOverflow: "ellipsis",
														whiteSpace: "nowrap"
													}}
												>
													{item.subtitle}
												</div>
											)}
										</div>
									</div>
									<span
										style={{
											padding: "1px 7px",
											borderRadius: 999,
											background:
												item.kind === "mc"
													? "rgba(49, 130, 246, 0.14)"
													: "var(--bg-control)",
											color:
												item.kind === "mc"
													? "var(--accent-weak-text)"
													: "var(--text-tertiary)",
											fontSize: 10.5,
											fontWeight: 600,
											flexShrink: 0
										}}
									>
										{item.kind === "mc"
											? tr("MC 소스", "MC Source")
											: item.kind === "type" ? tr("타입", "Type") : tr("파일", "File")}
									</span>
								</button>
							);
						})
					)}
				</div>
			</div>
		</ModalDialog>
	);
}