import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "../../i18n";
import { backend } from "../../services/backend";
import { store, useStore } from "../../state/store";
import type { GitCommitEntry, GitFileChange, GitStatusInfo } from "../../types/ipc";
import * as Icons from "../ui/Icons";

interface SelectedDiff {
	relPath: string;
	staged: boolean;
	text: string;
}

export function GitPanel() {
	const { tr } = useI18n();
	const project = useStore((s) => s.project);
	const [status, setStatus] = useState<GitStatusInfo | null>(null);
	const [commits, setCommits] = useState<GitCommitEntry[]>([]);
	const [loading, setLoading] = useState(false);
	const [busyAction, setBusyAction] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [commitMsg, setCommitMsg] = useState("");
	const [selectedDiff, setSelectedDiff] = useState<SelectedDiff | null>(null);
	const [diffLoading, setDiffLoading] = useState(false);

	const refreshGit = useCallback(async () => {
		if (!project) {
			setStatus(null);
			setCommits([]);
			setSelectedDiff(null);
			return;
		}
		setLoading(true);
		setError(null);
		try {
			const nextStatus = await backend.gitStatus();
			setStatus(nextStatus);
			if (nextStatus.isRepo) {
				try {
					const logEntries = await backend.gitLog(15);
					setCommits(logEntries);
				} catch {
					setCommits([]);
				}
			} else {
				setCommits([]);
				setSelectedDiff(null);
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setStatus(null);
		} finally {
			setLoading(false);
		}
	}, [project]);

	useEffect(() => {
		setSelectedDiff(null);
		void refreshGit();
	}, [refreshGit]);

	const stagedChanges = useMemo(
		() => (status?.changes ?? []).filter((c) => c.staged),
		[status]
	);
	const unstagedChanges = useMemo(
		() => (status?.changes ?? []).filter((c) => !c.staged),
		[status]
	);

	const handleInitRepo = async () => {
		setBusyAction(true);
		try {
			await backend.gitInit();
			store.showToast("success", tr("Git 저장소를 초기화했어요.", "Initialized Git repository."));
			await refreshGit();
		} catch (err) {
			store.showToast("error", err instanceof Error ? err.message : String(err));
		} finally {
			setBusyAction(false);
		}
	};

	const handleStage = async (paths: string[]) => {
		if (paths.length === 0) {
			return;
		}
		setBusyAction(true);
		try {
			await backend.gitStage(paths);
			await refreshGit();
		} catch (err) {
			store.showToast("error", err instanceof Error ? err.message : String(err));
		} finally {
			setBusyAction(false);
		}
	};

	const handleUnstage = async (paths: string[]) => {
		if (paths.length === 0) {
			return;
		}
		setBusyAction(true);
		try {
			await backend.gitUnstage(paths);
			await refreshGit();
		} catch (err) {
			store.showToast("error", err instanceof Error ? err.message : String(err));
		} finally {
			setBusyAction(false);
		}
	};

	const handleCommit = async () => {
		const msg = commitMsg.trim();
		if (!msg) {
			return;
		}
		setBusyAction(true);
		try {
			await backend.gitCommit(msg);
			setCommitMsg("");
			setSelectedDiff(null);
			store.showToast("success", tr("변경 사항을 커밋했어요.", "Committed staged changes."));
			await refreshGit();
		} catch (err) {
			store.showToast("error", err instanceof Error ? err.message : String(err));
		} finally {
			setBusyAction(false);
		}
	};

	const openDiff = async (change: GitFileChange) => {
		if (
			selectedDiff &&
			selectedDiff.relPath === change.relPath &&
			selectedDiff.staged === change.staged
		) {
			setSelectedDiff(null);
			return;
		}
		setDiffLoading(true);
		try {
			const diffText = await backend.gitDiff(change.relPath, change.staged);
			setSelectedDiff({
				relPath: change.relPath,
				staged: change.staged,
				text: diffText
			});
		} catch (err) {
			store.showToast("error", err instanceof Error ? err.message : String(err));
		} finally {
			setDiffLoading(false);
		}
	};

	const statusBadge = (change: GitFileChange) => {
		const code = change.staged ? change.indexStatus : change.worktreeStatus;
		const label = code === "?" ? "U" : code.trim() || "M";
		const color =
			label === "A" || label === "U"
				? "var(--status-success)"
				: label === "D"
					? "var(--status-danger)"
					: "var(--status-warning)";
		return (
			<span
				style={{
					fontSize: 10.5,
					fontWeight: 700,
					fontFamily: "var(--font-mono)",
					color,
					width: 14,
					textAlign: "center",
					flexShrink: 0
				}}
			>
				{label}
			</span>
		);
	};

	const renderDiffLines = (text: string) => {
		if (!text.trim()) {
			return (
				<div style={{ fontSize: 11.5, color: "var(--text-tertiary)", padding: 8 }}>
					{tr("표시할 diff 내용이 없어요.", "No diff output.")}
				</div>
			);
		}
		return text.split(/\r?\n/).map((line, idx) => {
			let bg = "transparent";
			let color = "var(--text-secondary)";
			if (line.startsWith("+") && !line.startsWith("+++")) {
				bg = "rgba(34, 197, 94, 0.12)";
				color = "var(--status-success)";
			} else if (line.startsWith("-") && !line.startsWith("---")) {
				bg = "rgba(240, 68, 82, 0.12)";
				color = "var(--status-danger)";
			} else if (line.startsWith("@@")) {
				bg = "rgba(49, 130, 246, 0.12)";
				color = "var(--accent)";
			} else if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("+++") || line.startsWith("---")) {
				color = "var(--text-tertiary)";
			}
			return (
				<div
					key={idx}
					style={{
						background: bg,
						color,
						padding: "0 8px",
						fontFamily: "var(--font-mono)",
						fontSize: 11,
						lineHeight: 1.5,
						whiteSpace: "pre"
					}}
				>
					{line || " "}
				</div>
			);
		});
	};

	if (!project) {
		return (
			<div style={{ padding: 14, color: "var(--text-secondary)", fontSize: 12, lineHeight: 1.5 }}>
				{tr(
					"Git 상태와 변경 내역을 보려면 프로젝트를 먼저 여세요.",
					"Open a project first to inspect Git changes and commit history."
				)}
			</div>
		);
	}

	if (error) {
		return (
			<div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
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
				<button
					type="button"
					onClick={() => void refreshGit()}
					style={{
						alignSelf: "flex-start",
						padding: "5px 10px",
						borderRadius: "var(--radius-m)",
						background: "var(--bg-control)",
						border: "1px solid var(--border-hairline)",
						color: "var(--text-primary)",
						fontSize: 11.5,
						cursor: "pointer"
					}}
				>
					{tr("다시 시도", "Retry")}
				</button>
			</div>
		);
	}

	if (status && !status.isRepo) {
		return (
			<div
				style={{
					margin: 10,
					padding: 12,
					borderRadius: "var(--radius-l)",
					background: "var(--bg-elevated)",
					border: "1px solid var(--border-hairline)",
					display: "flex",
					flexDirection: "column",
					gap: 8
				}}
			>
				<div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--text-primary)", fontSize: 12.5, fontWeight: 600 }}>
					<Icons.IconGit size={14} />
					{tr("Git 저장소가 아니에요", "Not a Git repository")}
				</div>
				<div style={{ fontSize: 11.5, color: "var(--text-secondary)", lineHeight: 1.5 }}>
					{tr(
						"현재 프로젝트 폴더에서 버전 관리를 시작하려면 Git 저장소를 초기화하세요.",
						"Initialize a Git repository in this project folder to track changes and commits."
					)}
				</div>
				<button
					type="button"
					disabled={busyAction}
					onClick={() => void handleInitRepo()}
					style={{
						padding: "7px 12px",
						borderRadius: "var(--radius-m)",
						background: "var(--accent)",
						border: "none",
						color: "#FFFFFF",
						fontSize: 12,
						fontWeight: 600,
						cursor: busyAction ? "wait" : "pointer"
					}}
				>
					{tr("Git 저장소 초기화", "Initialize Git Repository")}
				</button>
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
					gap: 8
				}}
			>
				<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
					<div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
						<span style={{ color: "var(--accent)", display: "flex" }}>
							<Icons.IconBranch size={13} />
						</span>
						<span
							style={{
								fontSize: 12,
								fontWeight: 600,
								color: "var(--text-primary)",
								fontFamily: "var(--font-mono)",
								overflow: "hidden",
								textOverflow: "ellipsis",
								whiteSpace: "nowrap"
							}}
						>
							{status?.branch ?? (loading ? "..." : "HEAD")}
						</span>
						{status && (status.ahead > 0 || status.behind > 0) && (
							<span
								style={{
									padding: "1px 6px",
									borderRadius: 999,
									background: "var(--bg-control)",
									border: "1px solid var(--border-hairline)",
									color: "var(--text-secondary)",
									fontSize: 10.5,
									fontFamily: "var(--font-mono)",
									fontVariantNumeric: "tabular-nums"
								}}
							>
								↑{status.ahead} ↓{status.behind}
							</span>
						)}
					</div>
					<button
						type="button"
						onClick={() => void refreshGit()}
						disabled={loading || busyAction}
						title={tr("Git 상태 새로고침", "Refresh Git Status")}
						aria-label={tr("Git 상태 새로고침", "Refresh Git Status")}
						style={{
							height: 26,
							width: 26,
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
						<Icons.IconRefresh size={12} />
					</button>
				</div>
				<form
					onSubmit={(e) => {
						e.preventDefault();
						void handleCommit();
					}}
					style={{ display: "flex", flexDirection: "column", gap: 6 }}
				>
					<textarea
						value={commitMsg}
						onChange={(e) => setCommitMsg(e.target.value)}
						placeholder={tr("커밋 메시지 입력...", "Commit message...")}
						aria-label={tr("커밋 메시지", "Commit message")}
						rows={2}
						style={{
							width: "100%",
							boxSizing: "border-box",
							padding: "6px 8px",
							borderRadius: "var(--radius-m)",
							background: "var(--bg-elevated)",
							border: "1px solid var(--border-strong)",
							color: "var(--text-primary)",
							fontSize: 12,
							resize: "vertical",
							outline: "none"
						}}
					/>
					<button
						type="submit"
						disabled={busyAction || !commitMsg.trim() || stagedChanges.length === 0}
						style={{
							height: 29,
							borderRadius: "var(--radius-m)",
							background: "var(--accent)",
							border: "none",
							color: "#FFFFFF",
							fontSize: 12,
							fontWeight: 600,
							cursor:
								busyAction || !commitMsg.trim() || stagedChanges.length === 0
									? "not-allowed"
									: "pointer",
							opacity: busyAction || !commitMsg.trim() || stagedChanges.length === 0 ? 0.45 : 1
						}}
					>
						{tr(`커밋 (${stagedChanges.length})`, `Commit (${stagedChanges.length})`)}
					</button>
				</form>
			</div>
			<div style={{ flex: 1, overflowY: "auto", minHeight: 0, padding: "6px 0" }}>
				<div style={{ padding: "4px 10px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
					<span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums" }}>
						{tr(`스테이지됨 (${stagedChanges.length})`, `Staged (${stagedChanges.length})`)}
					</span>
					{stagedChanges.length > 0 && (
						<button
							type="button"
							disabled={busyAction}
							onClick={() => void handleUnstage(stagedChanges.map((c) => c.relPath))}
							style={{
								background: "transparent",
								border: "none",
								color: "var(--text-tertiary)",
								fontSize: 11,
								cursor: "pointer",
								padding: 0
							}}
						>
							{tr("모두 언스테이지", "Unstage All")}
						</button>
					)}
				</div>
				{stagedChanges.map((change) => {
					const active =
						selectedDiff?.relPath === change.relPath && selectedDiff.staged === change.staged;
					return (
						<div
							key={`staged:${change.relPath}`}
							style={{
								display: "flex",
								alignItems: "center",
								gap: 6,
								padding: "4px 10px",
								background: active ? "rgba(49, 130, 246, 0.14)" : "transparent"
							}}
						>
							{statusBadge(change)}
							<button
								type="button"
								onClick={() => void openDiff(change)}
								title={change.relPath}
								style={{
									flex: 1,
									minWidth: 0,
									background: "transparent",
									border: "none",
									padding: 0,
									textAlign: "left",
									color: "var(--text-primary)",
									fontSize: 11.5,
									fontFamily: "var(--font-mono)",
									overflow: "hidden",
									textOverflow: "ellipsis",
									whiteSpace: "nowrap",
									cursor: "pointer"
								}}
							>
								{change.relPath}
							</button>
							<button
								type="button"
								disabled={busyAction}
								onClick={() => void handleUnstage([change.relPath])}
								title={tr("언스테이지", "Unstage")}
								style={{
									padding: "1px 6px",
									borderRadius: 5,
									background: "var(--bg-control)",
									border: "1px solid var(--border-hairline)",
									color: "var(--text-secondary)",
									fontSize: 10.5,
									cursor: "pointer"
								}}
							>
								-
							</button>
						</div>
					);
				})}
				<div
					style={{
						padding: "8px 10px 4px",
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between"
					}}
				>
					<span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums" }}>
						{tr(`변경 사항 (${unstagedChanges.length})`, `Changes (${unstagedChanges.length})`)}
					</span>
					{unstagedChanges.length > 0 && (
						<button
							type="button"
							disabled={busyAction}
							onClick={() => void handleStage(unstagedChanges.map((c) => c.relPath))}
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
							{tr("모두 스테이지", "Stage All")}
						</button>
					)}
				</div>
				{unstagedChanges.length === 0 && stagedChanges.length === 0 && (
					<div style={{ padding: "4px 10px 8px", fontSize: 11.5, color: "var(--text-tertiary)" }}>
						{tr("작업 트리가 깨끗해요.", "Working tree is clean.")}
					</div>
				)}
				{unstagedChanges.map((change) => {
					const active =
						selectedDiff?.relPath === change.relPath && selectedDiff.staged === change.staged;
					return (
						<div
							key={`unstaged:${change.relPath}`}
							style={{
								display: "flex",
								alignItems: "center",
								gap: 6,
								padding: "4px 10px",
								background: active ? "rgba(49, 130, 246, 0.14)" : "transparent"
							}}
						>
							{statusBadge(change)}
							<button
								type="button"
								onClick={() => void openDiff(change)}
								title={change.relPath}
								style={{
									flex: 1,
									minWidth: 0,
									background: "transparent",
									border: "none",
									padding: 0,
									textAlign: "left",
									color: "var(--text-secondary)",
									fontSize: 11.5,
									fontFamily: "var(--font-mono)",
									overflow: "hidden",
									textOverflow: "ellipsis",
									whiteSpace: "nowrap",
									cursor: "pointer"
								}}
							>
								{change.relPath}
							</button>
							<button
								type="button"
								disabled={busyAction}
								onClick={() => void handleStage([change.relPath])}
								title={tr("스테이지", "Stage")}
								style={{
									padding: "1px 6px",
									borderRadius: 5,
									background: "var(--bg-control)",
									border: "1px solid var(--border-hairline)",
									color: "var(--text-primary)",
									fontSize: 10.5,
									cursor: "pointer"
								}}
							>
								+
							</button>
						</div>
					);
				})}
				{(diffLoading || selectedDiff) && (
					<div
						style={{
							margin: "8px 10px",
							borderRadius: "var(--radius-m)",
							border: "1px solid var(--border-strong)",
							background: "var(--bg-canvas)",
							overflow: "hidden"
						}}
					>
						<div
							style={{
								padding: "5px 8px",
								background: "var(--bg-elevated)",
								borderBottom: "1px solid var(--border-hairline)",
								display: "flex",
								alignItems: "center",
								justifyContent: "space-between",
								gap: 6
							}}
						>
							<span
								style={{
									fontSize: 11,
									fontFamily: "var(--font-mono)",
									color: "var(--text-primary)",
									overflow: "hidden",
									textOverflow: "ellipsis",
									whiteSpace: "nowrap"
								}}
							>
								{selectedDiff?.relPath ?? "..."}
							</span>
							<div style={{ display: "flex", alignItems: "center", gap: 4 }}>
								{selectedDiff && (
									<button
										type="button"
										onClick={() => void store.openFileTab(selectedDiff.relPath)}
										style={{
											padding: "2px 6px",
											borderRadius: 5,
											background: "var(--bg-control)",
											border: "1px solid var(--border-hairline)",
											color: "var(--text-secondary)",
											fontSize: 10.5,
											cursor: "pointer"
										}}
									>
										{tr("열기", "Open")}
									</button>
								)}
								<button
									type="button"
									onClick={() => setSelectedDiff(null)}
									aria-label={tr("Diff 닫기", "Close diff")}
									style={{
										background: "transparent",
										border: "none",
										color: "var(--text-tertiary)",
										cursor: "pointer",
										display: "flex",
										padding: 2
									}}
								>
									<Icons.IconClose size={11} />
								</button>
							</div>
						</div>
						<div style={{ maxHeight: 210, overflow: "auto", padding: "4px 0" }}>
							{diffLoading ? (
								<div style={{ padding: 8, fontSize: 11.5, color: "var(--text-tertiary)" }}>
									{tr("Diff 불러오는 중...", "Loading diff...")}
								</div>
							) : (
								selectedDiff && renderDiffLines(selectedDiff.text)
							)}
						</div>
					</div>
				)}
				<div
					style={{
						marginTop: 8,
						padding: "8px 10px 4px",
						borderTop: "1px solid var(--border-hairline)",
						fontSize: 11,
						fontWeight: 600,
						color: "var(--text-secondary)"
					}}
				>
					{tr("최근 커밋", "Recent Commits")}
				</div>
				{commits.length === 0 ? (
					<div style={{ padding: "4px 10px", fontSize: 11.5, color: "var(--text-tertiary)" }}>
						{tr("아직 커밋 이력이 없어요.", "No commits yet.")}
					</div>
				) : (
					commits.map((commit) => (
						<div
							key={commit.hash}
							title={`${commit.hash}\n${commit.author} · ${commit.date}\n${commit.message}`}
							style={{
								padding: "5px 10px",
								borderBottom: "1px solid rgba(255, 255, 255, 0.03)",
								display: "flex",
								flexDirection: "column",
								gap: 2
							}}
						>
							<div style={{ display: "flex", alignItems: "center", gap: 6 }}>
								<span
									style={{
										padding: "1px 5px",
										borderRadius: 4,
										background: "var(--bg-control)",
										color: "var(--accent)",
										fontSize: 10.5,
										fontFamily: "var(--font-mono)",
										fontVariantNumeric: "tabular-nums",
										flexShrink: 0
									}}
								>
									{commit.shortHash}
								</span>
								<span
									style={{
										fontSize: 11.5,
										color: "var(--text-primary)",
										overflow: "hidden",
										textOverflow: "ellipsis",
										whiteSpace: "nowrap"
									}}
								>
									{commit.message}
								</span>
							</div>
							<div
								style={{
									fontSize: 10.5,
									color: "var(--text-tertiary)",
									display: "flex",
									justifyContent: "space-between",
									gap: 6,
									fontVariantNumeric: "tabular-nums"
								}}
							>
								<span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
									{commit.author}
								</span>
								<span style={{ flexShrink: 0 }}>{commit.date}</span>
							</div>
						</div>
					))
				)}
			</div>
		</div>
	);
}