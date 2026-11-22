import { useEffect, useRef, useState } from "react";
import { backend } from "../services/backend";
import { normalizePathSlashes, store, useStore } from "../state/store";
import { useI18n } from "../i18n";
import type { FileNode } from "../types/ipc";
import {
	IconChevron,
	IconEdit,
	IconExternal,
	IconFile,
	IconFolder,
	IconGradle,
	IconJava,
	IconJson,
	IconPalette,
	IconPlus,
	IconRefresh,
	IconTrash
} from "./ui/Icons";
import { ModalDialog } from "./ui/ModalDialog";

interface ContextMenuState {
	x: number;
	y: number;
	node: FileNode;
}

interface PendingCreate {
	kind: "file" | "dir";
	parentRel: string;
}

function renderFileIcon(name: string) {
	const lower = name.toLowerCase();
	if (lower.endsWith(".java")) {
		return <IconJava size={14} style={{ color: "#F59E0B", flexShrink: 0 }} />;
	}
	if (lower.endsWith(".json") || lower.endsWith(".mcmeta")) {
		return <IconJson size={14} style={{ color: "#60A5FA", flexShrink: 0 }} />;
	}
	if (lower.endsWith(".gradle") || lower.endsWith(".kts")) {
		return <IconGradle size={14} style={{ color: "#34D399", flexShrink: 0 }} />;
	}
	if (
		lower.endsWith(".png") ||
		lower.endsWith(".jpg") ||
		lower.endsWith(".jpeg") ||
		lower.endsWith(".webp")
	) {
		return <IconPalette size={14} style={{ color: "#C084FC", flexShrink: 0 }} />;
	}
	return <IconFile size={14} style={{ color: "var(--text-tertiary)", flexShrink: 0 }} />;
}

function parentDirOf(relPath: string): string {
	const norm = normalizePathSlashes(relPath);
	const idx = norm.lastIndexOf("/");
	return idx >= 0 ? norm.slice(0, idx) : "";
}

export function Explorer() {
	const { t, tr } = useI18n();
	const project = useStore((s) => s.project);
	const fileTree = useStore((s) => s.fileTree);
	const tabs = useStore((s) => s.tabs);
	const activeTabId = useStore((s) => s.activeTabId);
	const fsRevision = useStore((s) => s.fsRevision);

	const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set());
	const [childrenCache, setChildrenCache] = useState<Record<string, FileNode[]>>({});
	const [selectedPath, setSelectedPath] = useState<string>("");
	const [selectedIsDir, setSelectedIsDir] = useState<boolean>(false);
	const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(null);
	const [createValue, setCreateValue] = useState<string>("");
	const [renameTarget, setRenameTarget] = useState<string | null>(null);
	const [renameValue, setRenameValue] = useState<string>("");
	const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
	const [deleteTarget, setDeleteTarget] = useState<FileNode | null>(null);

	const createInputRef = useRef<HTMLInputElement>(null);
	const renameInputRef = useRef<HTMLInputElement>(null);

	const activeTabRel = tabs.find((tb) => tb.id === activeTabId)?.relPath ?? "";

	useEffect(() => {
		if (!project) {
			setExpandedDirs(new Set());
			setChildrenCache({});
			setSelectedPath("");
			return;
		}
		if (expandedDirs.size === 0) return;
		const dirs = Array.from(expandedDirs);
		void Promise.all(
			dirs.map(async (dir) => {
				try {
					const children = await backend.listDirectory(dir, false);
					return [dir, children] as const;
				} catch {
					return null;
				}
			})
		).then((results) => {
			setChildrenCache((prev) => {
				const next = { ...prev };
				for (const entry of results) {
					if (entry) next[entry[0]] = entry[1];
				}
				return next;
			});
		});
	}, [fsRevision, project]);

	useEffect(() => {
		if (!contextMenu) return;
		const closeMenu = () => setContextMenu(null);
		window.addEventListener("pointerdown", closeMenu);
		window.addEventListener("blur", closeMenu);
		return () => {
			window.removeEventListener("pointerdown", closeMenu);
			window.removeEventListener("blur", closeMenu);
		};
	}, [contextMenu]);

	useEffect(() => {
		if (pendingCreate) {
			createInputRef.current?.focus();
		}
	}, [pendingCreate]);

	useEffect(() => {
		if (renameTarget) {
			renameInputRef.current?.focus();
			const dot = renameValue.lastIndexOf(".");
			renameInputRef.current?.setSelectionRange(0, dot > 0 ? dot : renameValue.length);
		}
	}, [renameTarget]);

	const loadDir = async (relPath: string) => {
		try {
			const list = await backend.listDirectory(relPath, false);
			setChildrenCache((prev) => ({ ...prev, [relPath]: list }));
		} catch (err) {
			store.showToast("error", String(err));
		}
	};

	const toggleDir = async (node: FileNode) => {
		setSelectedPath(node.relPath);
		setSelectedIsDir(true);
		const isOpen = expandedDirs.has(node.relPath);
		if (isOpen) {
			setExpandedDirs((prev) => {
				const next = new Set(prev);
				next.delete(node.relPath);
				return next;
			});
			return;
		}
		setExpandedDirs((prev) => new Set(prev).add(node.relPath));
		if (node.children === null && !childrenCache[node.relPath]) {
			await loadDir(node.relPath);
		}
	};

	const targetParentDir = (): string => {
		if (!selectedPath) return "";
		return selectedIsDir ? selectedPath : parentDirOf(selectedPath);
	};

	const beginCreate = (kind: "file" | "dir", explicitParent?: string) => {
		const parentRel = explicitParent ?? targetParentDir();
		if (parentRel) {
			setExpandedDirs((prev) => new Set(prev).add(parentRel));
			if (!childrenCache[parentRel]) {
				void loadDir(parentRel);
			}
		}
		setPendingCreate({ kind, parentRel });
		setCreateValue("");
		setContextMenu(null);
	};

	const commitCreate = async () => {
		if (!pendingCreate) return;
		const name = createValue.trim();
		const kind = pendingCreate.kind;
		const parentRel = pendingCreate.parentRel;
		setPendingCreate(null);
		setCreateValue("");
		if (!name) return;

		const relPath = parentRel ? `${parentRel}/${name}` : name;
		try {
			if (kind === "file") {
				await backend.createFile(relPath, "");
				await store.refreshFileTree();
				if (parentRel) await loadDir(parentRel);
				await store.openFileTab(relPath);
			} else {
				await backend.createDir(relPath);
				await store.refreshFileTree();
				if (parentRel) await loadDir(parentRel);
				setExpandedDirs((prev) => new Set(prev).add(relPath));
			}
		} catch (err) {
			store.showToast("error", String(err));
		}
	};

	const beginRename = (node: FileNode) => {
		setRenameTarget(node.relPath);
		setRenameValue(node.name);
		setContextMenu(null);
	};

	const commitRename = async () => {
		if (!renameTarget) return;
		const oldRel = renameTarget;
		const nextName = renameValue.trim();
		setRenameTarget(null);
		if (!nextName) return;

		const parent = parentDirOf(oldRel);
		const newRel = parent ? `${parent}/${nextName}` : nextName;
		if (newRel === oldRel) return;

		try {
			const affected = store.getState().tabs.filter(t => t.relPath === oldRel || t.relPath?.startsWith(oldRel + "/"));
			if (!await store.confirmEdits(affected.map(t => t.id))) return;
			await backend.renamePath(oldRel, newRel);
			await store.refreshFileTree();
			if (parent) await loadDir(parent);
			for (const tab of affected) {
				store.closeTab(tab.id);
				await store.openFileTab(newRel + tab.relPath!.slice(oldRel.length));
			}
		} catch (err) {
			store.showToast("error", String(err));
		}
	};

	const confirmDelete = async () => {
		if (!deleteTarget) return;
		const target = deleteTarget;
		setDeleteTarget(null);
		try {
			const openTabs = store
				.getState()
				.tabs.filter(
					(tb) =>
						tb.relPath === target.relPath ||
						(target.isDir && tb.relPath?.startsWith(`${target.relPath}/`))
				);
			if (!await store.confirmEdits(openTabs.map(t => t.id))) return;
			await backend.deletePath(target.relPath);
			for (const tb of openTabs) {
				store.closeTab(tb.id);
			}
			await store.refreshFileTree();
			const parent = parentDirOf(target.relPath);
			if (parent) await loadDir(parent);
		} catch (err) {
			store.showToast("error", String(err));
		}
	};

	const handleRefresh = async () => {
		await store.refreshFileTree();
		for (const dir of expandedDirs) {
			await loadDir(dir);
		}
	};

	const renderCreateRow = (depth: number) => {
		if (!pendingCreate) return null;
		return (
			<div
				className="fs-tree-row"
				style={{ paddingLeft: 10 + depth * 14 }}
			>
				<span className="fs-tree-chevron" />
				{pendingCreate.kind === "dir" ? (
					<IconFolder size={14} style={{ color: "var(--accent-weak-text)" }} />
				) : (
					<IconFile size={14} style={{ color: "var(--text-secondary)" }} />
				)}
				<input
					ref={createInputRef}
					className="fs-inline-input"
					value={createValue}
					placeholder={
						pendingCreate.kind === "file"
							? t.explorer.fileNamePlaceholder
							: t.explorer.folderNamePlaceholder
					}
					onChange={(e) => setCreateValue(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							void commitCreate();
						} else if (e.key === "Escape") {
							setPendingCreate(null);
						}
					}}
					onBlur={() => void commitCreate()}
				/>
			</div>
		);
	};

	const renderNodes = (nodes: FileNode[], depth: number) => {
		return nodes.map((node) => {
			const isExpanded = node.isDir && expandedDirs.has(node.relPath);
			const isSelected =
				selectedPath === node.relPath || (!node.isDir && activeTabRel === node.relPath);
			const isRenaming = renameTarget === node.relPath;
			const children = node.children ?? childrenCache[node.relPath] ?? [];

			return (
				<div key={node.relPath}>
					<div
						className={`fs-tree-row ${isSelected ? "fs-tree-row--selected" : ""}`}
						style={{ paddingLeft: 10 + depth * 14 }}
						onClick={() => {
							if (isRenaming) return;
							if (node.isDir) {
								void toggleDir(node);
							} else {
								setSelectedPath(node.relPath);
								setSelectedIsDir(false);
								void store.openFileTab(node.relPath).catch((err) => {
									store.showToast("error", String(err));
								});
							}
						}}
						onContextMenu={(e) => {
							e.preventDefault();
							setSelectedPath(node.relPath);
							setSelectedIsDir(node.isDir);
							const x = Math.min(e.clientX, window.innerWidth - 188);
							const y = Math.min(e.clientY, window.innerHeight - 190);
							setContextMenu({ x, y, node });
						}}
					>
						<span className="fs-tree-chevron">
							{node.isDir ? <IconChevron size={12} expanded={isExpanded} /> : null}
						</span>
						{node.isDir ? (
							<IconFolder
								size={14}
								open={isExpanded}
								style={{ color: "#7DB4FF", flexShrink: 0 }}
							/>
						) : (
							renderFileIcon(node.name)
						)}

						{isRenaming ? (
							<input
								ref={renameInputRef}
								className="fs-inline-input"
								value={renameValue}
								onClick={(e) => e.stopPropagation()}
								onChange={(e) => setRenameValue(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") {
										e.preventDefault();
										void commitRename();
									} else if (e.key === "Escape") {
										setRenameTarget(null);
									}
								}}
								onBlur={() => void commitRename()}
							/>
						) : (
							<span className="fs-tree-name">{node.name}</span>
						)}
					</div>

					{isExpanded ? (
						<div>
							{pendingCreate && pendingCreate.parentRel === node.relPath
								? renderCreateRow(depth + 1)
								: null}
							{children.length === 0 &&
							!(pendingCreate && pendingCreate.parentRel === node.relPath) ? (
								<div
									style={{
										paddingLeft: 28 + (depth + 1) * 14,
										fontSize: 11.5,
										color: "var(--text-tertiary)",
										height: 22,
										display: "flex",
										alignItems: "center"
									}}
								>
									{t.explorer.emptyDir}
								</div>
							) : (
								renderNodes(children, depth + 1)
							)}
						</div>
					) : null}
				</div>
			);
		});
	};

	if (!project) {
		return (
			<div style={{ padding: 14, fontSize: 12, color: "var(--text-tertiary)" }}>
				{t.common.noProject}
			</div>
		);
	}

	return (
		<div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
			<div className="fs-panel-header">
				<span className="fs-panel-title">{project.name}</span>
				<div className="fs-panel-actions">
					<button
						type="button"
						className="fs-icon-btn"
						onClick={() => beginCreate("file")}
						title={t.explorer.newFile}
						aria-label={t.explorer.newFile}
					>
						<IconPlus size={14} />
					</button>
					<button
						type="button"
						className="fs-icon-btn"
						onClick={() => beginCreate("dir")}
						title={t.explorer.newFolder}
						aria-label={t.explorer.newFolder}
					>
						<IconFolder size={14} />
					</button>
					<button
						type="button"
						className="fs-icon-btn"
						onClick={() => void handleRefresh()}
						title={t.common.refresh}
						aria-label={t.common.refresh}
					>
						<IconRefresh size={13} />
					</button>
					<button
						type="button"
						className="fs-icon-btn"
						onClick={() => setExpandedDirs(new Set())}
						title={t.explorer.collapseAll}
						aria-label={t.explorer.collapseAll}
					>
						<IconChevron size={13} direction="up" />
					</button>
				</div>
			</div>

			<div
				className="fs-tree"
				onClick={(e) => {
					if (e.target === e.currentTarget) {
						setSelectedPath("");
						setSelectedIsDir(false);
					}
				}}
			>
				{pendingCreate && pendingCreate.parentRel === "" ? renderCreateRow(0) : null}
				{renderNodes(fileTree, 0)}
			</div>

			{contextMenu ? (
				<div
					className="fs-context-menu"
					style={{ left: contextMenu.x, top: contextMenu.y }}
					onPointerDown={(e) => e.stopPropagation()}
				>
					<button
						type="button"
						className="fs-context-item"
						onClick={() =>
							beginCreate(
								"file",
								contextMenu.node.isDir
									? contextMenu.node.relPath
									: parentDirOf(contextMenu.node.relPath)
							)
						}
					>
						<IconPlus size={14} />
						<span>{t.explorer.newFile}</span>
					</button>
					<button
						type="button"
						className="fs-context-item"
						onClick={() =>
							beginCreate(
								"dir",
								contextMenu.node.isDir
									? contextMenu.node.relPath
									: parentDirOf(contextMenu.node.relPath)
							)
						}
					>
						<IconFolder size={14} />
						<span>{t.explorer.newFolder}</span>
					</button>
					<div className="fs-context-sep" />
					<button
						type="button"
						className="fs-context-item"
						onClick={() => beginRename(contextMenu.node)}
					>
						<IconEdit size={14} />
						<span>{t.common.rename}</span>
					</button>
					<button
						type="button"
						className="fs-context-item"
						onClick={() => {
							const rel = contextMenu.node.relPath;
							setContextMenu(null);
							void backend.revealInExplorer(rel).catch((err) => {
								store.showToast("error", String(err));
							});
						}}
					>
						<IconExternal size={14} />
						<span>{t.explorer.revealInExplorer}</span>
					</button>
					<div className="fs-context-sep" />
					<button
						type="button"
						className="fs-context-item fs-context-item--danger"
						onClick={() => {
							setDeleteTarget(contextMenu.node);
							setContextMenu(null);
						}}
					>
						<IconTrash size={14} />
						<span>{t.common.delete}</span>
					</button>
				</div>
			) : null}

			<ModalDialog
				open={deleteTarget !== null}
				onClose={() => setDeleteTarget(null)}
				title={t.explorer.confirmDeleteTitle}
				subtitle={deleteTarget?.relPath}
				width={400}
				footer={
					<>
						<button
							type="button"
							className="fs-btn"
							onClick={() => setDeleteTarget(null)}
						>
							{t.common.cancel}
						</button>
						<button
							type="button"
							className="fs-btn fs-btn--danger"
							onClick={() => void confirmDelete()}
						>
							{t.common.delete}
						</button>
					</>
				}
			>
				<p style={{ margin: 0, color: "var(--text-secondary)" }}>
					{tr(
						`"${deleteTarget?.name ?? ""}" 항목을 영구적으로 삭제할까요?`,
						`Delete "${deleteTarget?.name ?? ""}" permanently?`
					)}
				</p>
			</ModalDialog>
		</div>
	);
}