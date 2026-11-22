import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "../../i18n";
import { backend } from "../../services/backend";
import { normalizePathSlashes, store, useStore } from "../../state/store";
import type {
	DebugEvaluateResult,
	DebugScope,
	DebugStackFrame,
	DebugThread,
	DebugVariable
} from "../../types/ipc";
import * as Icons from "../ui/Icons";

interface WatchEntry {
	id: number;
	expression: string;
	result: DebugEvaluateResult | null;
	error: string | null;
	loading: boolean;
}

function toWorkspaceRelPath(filePath: string, rootPath: string | null): string | null {
	const normFile = normalizePathSlashes(filePath);
	if (!rootPath) {
		return null;
	}
	const normRoot = normalizePathSlashes(rootPath).replace(/\/+$/, "");
	if (normFile.toLowerCase().startsWith(`${normRoot.toLowerCase()}/`)) {
		return normFile.slice(normRoot.length + 1);
	}
	if (!/^[A-Za-z]:\//.test(normFile) && !normFile.startsWith("/")) {
		return normFile.replace(/^\/+/, "");
	}
	return null;
}

export function DebugPanel() {
	const { tr } = useI18n();
	const project = useStore((s) => s.project);
	const debugSession = useStore((s) => s.debugSession);
	const debugPausedLocation = useStore((s) => s.debugPausedLocation);
	const breakpoints = useStore((s) => s.breakpoints);

	const [restarting, setRestarting] = useState(false);
	const [paused, setPaused] = useState(false);
	const [threads, setThreads] = useState<DebugThread[]>([]);
	const [selectedThreadId, setSelectedThreadId] = useState<number | null>(null);
	const [frames, setFrames] = useState<DebugStackFrame[]>([]);
	const [selectedFrameId, setSelectedFrameId] = useState<number | null>(null);
	const [scopes, setScopes] = useState<DebugScope[]>([]);
	const [expandedScopes, setExpandedScopes] = useState<Record<number, boolean>>({});
	const [expandedVars, setExpandedVars] = useState<Record<number, boolean>>({});
	const [varsByRef, setVarsByRef] = useState<Record<number, DebugVariable[]>>({});
	const [loadingRef, setLoadingRef] = useState<Record<number, boolean>>({});

	const [watchInput, setWatchInput] = useState("");
	const [watches, setWatches] = useState<WatchEntry[]>([]);
	const [nextWatchId, setNextWatchId] = useState(1);

	const loadScopeVariables = useCallback(async (refId: number) => {
		if (refId <= 0) {
			return;
		}
		setLoadingRef((prev) => ({ ...prev, [refId]: true }));
		try {
			const list = await backend.debugVariables(refId);
			setVarsByRef((prev) => ({ ...prev, [refId]: list }));
		} catch (err) {
			store.showToast("error", err instanceof Error ? err.message : String(err));
		} finally {
			setLoadingRef((prev) => ({ ...prev, [refId]: false }));
		}
	}, []);

	const loadFrameDetails = useCallback(
		async (frameId: number) => {
			setSelectedFrameId(frameId);
			setScopes([]);
			setVarsByRef({});
			setExpandedVars({});
			try {
				const scopeList = await backend.debugScopes(frameId);
				setScopes(scopeList);
				const initialExpanded: Record<number, boolean> = {};
				for (const sc of scopeList) {
					if (!sc.expensive && sc.variablesReference > 0) {
						initialExpanded[sc.variablesReference] = true;
						void loadScopeVariables(sc.variablesReference);
					}
				}
				setExpandedScopes(initialExpanded);
			} catch (err) {
				store.showToast("error", err instanceof Error ? err.message : String(err));
			}
		},
		[loadScopeVariables]
	);

	const loadThreadStack = useCallback(
		async (threadId: number) => {
			setSelectedThreadId(threadId);
			setFrames([]);
			setSelectedFrameId(null);
			setScopes([]);
			try {
				const stack = await backend.debugStackTrace(threadId);
				setFrames(stack);
				if (stack.length > 0) {
					await loadFrameDetails(stack[0].id);
				}
			} catch (err) {
				store.showToast("error", err instanceof Error ? err.message : String(err));
			}
		},
		[loadFrameDetails]
	);

	const refreshStoppedState = useCallback(
		async (preferredThreadId?: number | null) => {
			try {
				const list = await backend.debugThreads();
				setThreads(list);
				const targetId =
					preferredThreadId && list.some((t) => t.id === preferredThreadId)
						? preferredThreadId
						: list[0]?.id ?? null;
				if (targetId !== null) {
					await loadThreadStack(targetId);
				} else {
					setSelectedThreadId(null);
					setFrames([]);
					setScopes([]);
				}
			} catch (err) {
				store.showToast("error", err instanceof Error ? err.message : String(err));
			}
		},
		[loadThreadStack]
	);

	useEffect(() => {
		if (!debugSession) {
			setPaused(false);
			setThreads([]);
			setSelectedThreadId(null);
			setFrames([]);
			setSelectedFrameId(null);
			setScopes([]);
			setVarsByRef({});
		}
	}, [debugSession]);

	useEffect(() => {
		if (debugPausedLocation) {
			setPaused(true);
			void refreshStoppedState(debugPausedLocation.threadId);
		}
	}, [debugPausedLocation, refreshStoppedState]);

	useEffect(() => {
		let unlisten: (() => void) | null = null;
		void backend
			.onDebugEvent((ev) => {
				if (ev.kind === "stopped") {
					setPaused(true);
					if (!ev.filePath || !ev.line) {
						void refreshStoppedState(ev.threadId);
					}
				} else if (ev.kind === "continued") {
					setPaused(false);
					setFrames([]);
					setScopes([]);
				} else if (ev.kind === "terminated" || ev.kind === "exited") {
					setPaused(false);
					setThreads([]);
					setFrames([]);
					setScopes([]);
				}
			})
			.then((fn) => {
				unlisten = fn;
			});
		return () => {
			if (unlisten) {
				unlisten();
			}
		};
	}, [refreshStoppedState]);

	const evaluateSingleWatch = useCallback(
		async (entryId: number, expression: string, frameId: number | null) => {
			setWatches((prev) =>
				prev.map((w) => (w.id === entryId ? { ...w, loading: true, error: null } : w))
			);
			try {
				const result = await backend.debugEvaluate(expression, frameId ?? undefined);
				setWatches((prev) =>
					prev.map((w) =>
						w.id === entryId ? { ...w, loading: false, result, error: null } : w
					)
				);
			} catch (err) {
				setWatches((prev) =>
					prev.map((w) =>
						w.id === entryId
							? {
									...w,
									loading: false,
									result: null,
									error: err instanceof Error ? err.message : String(err)
								}
							: w
					)
				);
			}
		},
		[]
	);

	useEffect(() => {
		if (!paused || selectedFrameId === null || watches.length === 0) {
			return;
		}
		for (const w of watches) {
			void evaluateSingleWatch(w.id, w.expression, selectedFrameId);
		}
	}, [paused, selectedFrameId]);

	const handleStartOrResume = async () => {
		if (!debugSession) {
			await store.startDebug();
			return;
		}
		try {
			await backend.debugContinue(selectedThreadId ?? undefined);
			setPaused(false);
			store.setState({ debugPausedLocation: null });
		} catch (err) {
			store.showToast("error", err instanceof Error ? err.message : String(err));
		}
	};

	const handlePause = async () => {
		if (!debugSession) {
			return;
		}
		try {
			await backend.debugPause(selectedThreadId ?? undefined);
		} catch (err) {
			store.showToast("error", err instanceof Error ? err.message : String(err));
		}
	};

	const handleStep = async (kind: "over" | "into" | "out") => {
		if (!debugSession || selectedThreadId === null) {
			return;
		}
		try {
			if (kind === "over") {
				await backend.debugStepOver(selectedThreadId);
			} else if (kind === "into") {
				await backend.debugStepInto(selectedThreadId);
			} else {
				await backend.debugStepOut(selectedThreadId);
			}
		} catch (err) {
			store.showToast("error", err instanceof Error ? err.message : String(err));
		}
	};

	const toggleScope = (refId: number) => {
		const nextOpen = !expandedScopes[refId];
		setExpandedScopes((prev) => ({ ...prev, [refId]: nextOpen }));
		if (nextOpen && !varsByRef[refId] && !loadingRef[refId]) {
			void loadScopeVariables(refId);
		}
	};

	const toggleVariable = (refId: number) => {
		if (refId <= 0) {
			return;
		}
		const nextOpen = !expandedVars[refId];
		setExpandedVars((prev) => ({ ...prev, [refId]: nextOpen }));
		if (nextOpen && !varsByRef[refId] && !loadingRef[refId]) {
			void loadScopeVariables(refId);
		}
	};

	const renderVariableTree = (vars: DebugVariable[], depth: number): React.ReactNode => {
		return vars.map((v, idx) => {
			const hasChildren = v.variablesReference > 0;
			const isExpanded = Boolean(expandedVars[v.variablesReference]);
			const children = varsByRef[v.variablesReference] ?? [];
			return (
				<div key={`${v.name}:${v.variablesReference}:${idx}`}>
					<div
						style={{
							display: "flex",
							alignItems: "baseline",
							gap: 4,
							padding: `3px 8px 3px ${8 + depth * 12}px`,
							fontSize: 11.5,
							fontFamily: "var(--font-mono)"
						}}
					>
						{hasChildren ? (
							<button
								type="button"
								onClick={() => toggleVariable(v.variablesReference)}
								aria-label={tr("변수 펼치기", "Expand variable")}
								style={{
									background: "transparent",
									border: "none",
									color: "var(--text-tertiary)",
									display: "inline-flex",
									padding: 1,
									cursor: "pointer",
									transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)"
								}}
							>
								<Icons.IconChevron size={10} />
							</button>
						) : (
							<span style={{ width: 12, flexShrink: 0 }} />
						)}
						<span style={{ color: "var(--accent-weak-text)", flexShrink: 0 }}>{v.name}:</span>
						<span
							title={v.varType ? `${v.varType}: ${v.value}` : v.value}
							style={{
								color: "var(--text-primary)",
								overflow: "hidden",
								textOverflow: "ellipsis",
								whiteSpace: "nowrap",
								flex: 1,
								minWidth: 0
							}}
						>
							{v.value}
						</span>
						{v.varType && (
							<span
								style={{
									fontSize: 10,
									color: "var(--text-tertiary)",
									maxWidth: 90,
									overflow: "hidden",
									textOverflow: "ellipsis",
									whiteSpace: "nowrap"
								}}
							>
								{v.varType.split(".").pop()}
							</span>
						)}
					</div>
					{hasChildren && isExpanded && (
						<div>
							{loadingRef[v.variablesReference] && children.length === 0 ? (
								<div
									style={{
										padding: `2px 8px 2px ${20 + depth * 12}px`,
										fontSize: 11,
										color: "var(--text-tertiary)"
									}}
								>
									{tr("불러오는 중...", "Loading...")}
								</div>
							) : (
								renderVariableTree(children, depth + 1)
							)}
						</div>
					)}
				</div>
			);
		});
	};

	const flatBreakpoints = useMemo(() => {
		const rows: { fullPath: string; relPath: string | null; displayPath: string; line: number }[] = [];
		const rootPath = project?.path ?? null;
		for (const [filePath, lines] of Object.entries(breakpoints)) {
			const rel = toWorkspaceRelPath(filePath, rootPath);
			const displayPath = rel ?? filePath.replace(/\\/g, "/").split("/").pop() ?? filePath;
			for (const line of lines) {
				rows.push({ fullPath: filePath, relPath: rel, displayPath, line });
			}
		}
		return rows.sort((a, b) => a.displayPath.localeCompare(b.displayPath) || a.line - b.line);
	}, [breakpoints, project?.path]);

	const handleAddWatch = (e: React.FormEvent) => {
		e.preventDefault();
		const expr = watchInput.trim();
		if (!expr) {
			return;
		}
		const id = nextWatchId;
		setNextWatchId((n) => n + 1);
		setWatchInput("");
		setWatches((prev) => [
			...prev,
			{ id, expression: expr, result: null, error: null, loading: false }
		]);
		if (debugSession && paused) {
			void evaluateSingleWatch(id, expr, selectedFrameId);
		}
	};

	const sectionHeaderStyle: React.CSSProperties = {
		padding: "6px 10px",
		borderTop: "1px solid var(--border-hairline)",
		borderBottom: "1px solid var(--border-hairline)",
		background: "var(--bg-canvas)",
		fontSize: 11,
		fontWeight: 600,
		color: "var(--text-secondary)",
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between"
	};

	if (!project) {
		return (
			<div style={{ padding: 14, color: "var(--text-secondary)", fontSize: 12, lineHeight: 1.5 }}>
				{tr(
					"Minecraft 클라이언트를 디버그하려면 프로젝트를 먼저 여세요.",
					"Open a Fabric project first to launch and inspect a debug session."
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
				<div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
					<button
						type="button"
						onClick={() => void handleStartOrResume()}
						disabled={Boolean(debugSession) && !paused}
						title={
							!debugSession
								? tr("디버그 시작", "Start Debug")
								: tr("계속 실행", "Resume")
						}
						aria-label={
							!debugSession
								? tr("디버그 시작", "Start Debug")
								: tr("계속 실행", "Resume")
						}
						style={{
							height: 28,
							padding: debugSession ? "0 8px" : "0 10px",
							borderRadius: "var(--radius-s)",
							background: !debugSession || paused ? "var(--accent)" : "var(--bg-control)",
							border: "1px solid transparent",
							color: "#FFFFFF",
							fontSize: 11.5,
							fontWeight: 600,
							display: "inline-flex",
							alignItems: "center",
							gap: 4
						}}
					>
						<Icons.IconPlay size={12} />
						{!debugSession && <span>{tr("시작", "Start")}</span>}
					</button>
					<button
						type="button"
						className="fs-icon-btn"
						onClick={() => void handlePause()}
						disabled={!debugSession || paused}
						title={tr("일시정지", "Pause")}
						aria-label={tr("일시정지", "Pause")}
					>
						<Icons.IconPause size={13} />
					</button>
					<button
						type="button"
						className="fs-icon-btn"
						onClick={() => void handleStep("over")}
						disabled={!debugSession || !paused || selectedThreadId === null}
						title={tr("한 단계 건너뛰기 (Step Over)", "Step Over")}
						aria-label={tr("한 단계 건너뛰기", "Step Over")}
					>
						<Icons.IconStepOver size={13} />
					</button>
					<button
						type="button"
						className="fs-icon-btn"
						onClick={() => void handleStep("into")}
						disabled={!debugSession || !paused || selectedThreadId === null}
						title={tr("안으로 들어가기 (Step Into)", "Step Into")}
						aria-label={tr("안으로 들어가기", "Step Into")}
					>
						<Icons.IconStepInto size={13} />
					</button>
					<button
						type="button"
						className="fs-icon-btn"
						onClick={() => void handleStep("out")}
						disabled={!debugSession || !paused || selectedThreadId === null}
						title={tr("밖으로 나오기 (Step Out)", "Step Out")}
						aria-label={tr("밖으로 나오기", "Step Out")}
					>
						<Icons.IconStepOut size={13} />
					</button>
					<button type="button" className="fs-icon-btn" disabled={!debugSession || restarting}
						title={tr("디버그 재시작", "Restart debugging")} aria-label={tr("디버그 재시작", "Restart debugging")}
						onClick={async () => {
							setRestarting(true);
							try {
								await store.saveAllTabs();
								await store.stopDebug();
								await store.startDebug();
							} catch (err) { store.showToast("error", String(err)); }
							finally { setRestarting(false); }
						}}><Icons.IconRefresh size={13} /></button>
					<button
						type="button"
						className="fs-icon-btn"
						onClick={() => void store.stopDebug()}
						disabled={!debugSession}
						title={tr("디버그 중지", "Stop Debug")}
						aria-label={tr("디버그 중지", "Stop Debug")}
						style={{ color: debugSession ? "var(--status-danger)" : undefined }}
					>
						<Icons.IconStop size={13} />
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
						{!debugSession
							? tr("세션 대기 중", "Idle")
							: paused
								? tr("중단됨", "Paused")
								: tr("실행 중", "Running")}
					</span>
					{debugSession && (
						<span style={{ fontFamily: "var(--font-mono)" }}>
							JDWP :{debugSession.jdwpPort}
						</span>
					)}
				</div>
				{debugSession && threads.length > 0 && (
					<select
						className="fs-select"
						value={selectedThreadId ?? ""}
						onChange={(e) => {
							const id = Number(e.target.value);
							if (!Number.isNaN(id)) {
								void loadThreadStack(id);
							}
						}}
						aria-label={tr("스레드 선택", "Select thread")}
						style={{ width: "100%", height: 28, fontSize: 11.5 }}
					>
						{threads.map((th) => (
							<option key={th.id} value={th.id}>
								{th.name} (#{th.id})
							</option>
						))}
					</select>
				)}
			</div>
			<div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
				<div style={sectionHeaderStyle}>
					<span>{tr("호출 스택", "Call Stack")}</span>
					<span className="tabular-nums" style={{ color: "var(--text-tertiary)" }}>
						{frames.length}
					</span>
				</div>
				{frames.length === 0 ? (
					<div style={{ padding: "8px 10px", fontSize: 11.5, color: "var(--text-tertiary)" }}>
						{debugSession
							? paused
								? tr("스택 프레임이 비어 있어요.", "No stack frames.")
								: tr("중단점 또는 일시정지를 기다리는 중...", "Waiting for breakpoint or pause...")
							: tr("디버그를 시작하면 호출 스택이 표시돼요.", "Start debugging to inspect call stack.")}
					</div>
				) : (
					frames.map((frame) => {
						const active = frame.id === selectedFrameId;
						const rel = frame.sourcePath
							? toWorkspaceRelPath(frame.sourcePath, project.path)
							: null;
						const shortSource = frame.sourcePath
							? frame.sourcePath.replace(/\\/g, "/").split("/").pop()
							: null;
						return (
							<button
								key={frame.id}
								type="button"
								onClick={() => {
									void loadFrameDetails(frame.id);
									if (rel) {
										void store.openFileTab(rel, frame.line, frame.column || 1);
									}
								}}
								style={{
									width: "100%",
									display: "flex",
									alignItems: "center",
									justifyContent: "space-between",
									gap: 6,
									padding: "5px 10px",
									background: active ? "var(--accent-weak-bg)" : "transparent",
									textAlign: "left"
								}}
							>
								<span
									style={{
										fontSize: 11.5,
										fontFamily: "var(--font-mono)",
										color: active ? "var(--text-primary)" : "var(--text-secondary)",
										overflow: "hidden",
										textOverflow: "ellipsis",
										whiteSpace: "nowrap"
									}}
								>
									{frame.name}
								</span>
								{shortSource && (
									<span
										className="tabular-nums"
										style={{
											fontSize: 10.5,
											fontFamily: "var(--font-mono)",
											color: "var(--text-tertiary)",
											flexShrink: 0
										}}
									>
										{shortSource}:{frame.line}
									</span>
								)}
							</button>
						);
					})
				)}
				<div style={sectionHeaderStyle}>
					<span>{tr("변수", "Variables")}</span>
					<span className="tabular-nums" style={{ color: "var(--text-tertiary)" }}>
						{scopes.length}
					</span>
				</div>
				{scopes.length === 0 ? (
					<div style={{ padding: "8px 10px", fontSize: 11.5, color: "var(--text-tertiary)" }}>
						{tr("스택 프레임을 선택하면 변수를 볼 수 있어요.", "Select a stack frame to inspect variables.")}
					</div>
				) : (
					scopes.map((sc) => {
						const isExpanded = Boolean(expandedScopes[sc.variablesReference]);
						const vars = varsByRef[sc.variablesReference] ?? [];
						return (
							<div key={`${sc.name}:${sc.variablesReference}`}>
								<button
									type="button"
									onClick={() => toggleScope(sc.variablesReference)}
									style={{
										width: "100%",
										display: "flex",
										alignItems: "center",
										gap: 5,
										padding: "5px 8px",
										textAlign: "left",
										fontSize: 11.5,
										fontWeight: 600,
										color: "var(--text-primary)"
									}}
								>
									<span
										style={{
											display: "inline-flex",
											color: "var(--text-tertiary)",
											transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)"
										}}
									>
										<Icons.IconChevron size={11} />
									</span>
									<span>{sc.name}</span>
								</button>
								{isExpanded && (
									<div>
										{loadingRef[sc.variablesReference] && vars.length === 0 ? (
											<div style={{ padding: "3px 18px", fontSize: 11, color: "var(--text-tertiary)" }}>
												{tr("불러오는 중...", "Loading...")}
											</div>
										) : vars.length === 0 ? (
											<div style={{ padding: "3px 18px", fontSize: 11, color: "var(--text-tertiary)" }}>
												{tr("항목 없음", "Empty")}
											</div>
										) : (
											renderVariableTree(vars, 1)
										)}
									</div>
								)}
							</div>
						);
					})
				)}
				<div style={sectionHeaderStyle}>
					<span>{tr("감시 표현식", "Watch")}</span>
				</div>
				<div style={{ padding: "6px 8px", display: "flex", flexDirection: "column", gap: 6 }}>
					<form onSubmit={handleAddWatch} style={{ display: "flex", gap: 4 }}>
						<input
							type="text"
							className="fs-input"
							value={watchInput}
							onChange={(e) => setWatchInput(e.target.value)}
							placeholder={tr("표현식 평가 (예: player.getName())", "Evaluate expression...")}
							aria-label={tr("표현식 입력", "Watch expression")}
							style={{ flex: 1, minWidth: 0, height: 27, fontSize: 11.5, fontFamily: "var(--font-mono)" }}
						/>
						<button
							type="submit"
							className="fs-btn"
							disabled={!watchInput.trim()}
							style={{ height: 27, padding: "0 8px", fontSize: 11 }}
						>
							{tr("추가", "Add")}
						</button>
					</form>
					{watches.map((w) => (
						<div
							key={w.id}
							style={{
								padding: "5px 7px",
								borderRadius: "var(--radius-s)",
								background: "var(--bg-elevated)",
								border: "1px solid var(--border-hairline)",
								display: "flex",
								flexDirection: "column",
								gap: 2
							}}
						>
							<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 4 }}>
								<span
									style={{
										fontSize: 11.5,
										fontFamily: "var(--font-mono)",
										color: "var(--accent-weak-text)",
										overflow: "hidden",
										textOverflow: "ellipsis",
										whiteSpace: "nowrap"
									}}
								>
									{w.expression}
								</span>
								<div style={{ display: "flex", alignItems: "center", gap: 2 }}>
									<button
										type="button"
										onClick={() => {
											if (debugSession && paused) {
												void evaluateSingleWatch(w.id, w.expression, selectedFrameId);
											}
										}}
										disabled={!debugSession || !paused || w.loading}
										title={tr("다시 평가", "Re-evaluate")}
										style={{ color: "var(--text-tertiary)", padding: 2, display: "flex" }}
									>
										<Icons.IconRefresh size={11} />
									</button>
									<button
										type="button"
										onClick={() => setWatches((prev) => prev.filter((item) => item.id !== w.id))}
										title={tr("삭제", "Remove")}
										style={{ color: "var(--text-tertiary)", padding: 2, display: "flex" }}
									>
										<Icons.IconClose size={11} />
									</button>
								</div>
							</div>
							<div
								style={{
									fontSize: 11,
									fontFamily: "var(--font-mono)",
									color: w.error ? "var(--status-danger)" : "var(--text-secondary)",
									wordBreak: "break-word"
								}}
							>
								{w.loading
									? tr("평가 중...", "Evaluating...")
									: w.error
										? w.error
										: w.result
											? `${w.result.result}${w.result.varType ? ` (${w.result.varType})` : ""}`
											: tr("중단 상태에서 평가 가능", "Evaluate when paused")}
							</div>
						</div>
					))}
				</div>
				<div style={sectionHeaderStyle}>
					<span>{tr("중단점", "Breakpoints")}</span>
					<span className="tabular-nums" style={{ color: "var(--text-tertiary)" }}>
						{flatBreakpoints.length}
					</span>
				</div>
				{flatBreakpoints.length === 0 ? (
					<div style={{ padding: "8px 10px", fontSize: 11.5, color: "var(--text-tertiary)" }}>
						{tr(
							"에디터 줄 번호 왼쪽 여백을 클릭해 중단점을 추가하세요.",
							"Click the editor gutter to toggle breakpoints."
						)}
					</div>
				) : (
					flatBreakpoints.map((bp) => (
						<div
							key={`${bp.fullPath}:${bp.line}`}
							style={{
								display: "flex",
								alignItems: "center",
								justifyContent: "space-between",
								gap: 6,
								padding: "4px 10px"
							}}
						>
							<button
								type="button"
								onClick={() => {
									if (bp.relPath) {
										void store.openFileTab(bp.relPath, bp.line);
									}
								}}
								style={{
									flex: 1,
									minWidth: 0,
									display: "flex",
									alignItems: "center",
									gap: 6,
									textAlign: "left",
									fontSize: 11.5,
									fontFamily: "var(--font-mono)",
									color: "var(--text-secondary)"
								}}
							>
								<span
									style={{
										width: 7,
										height: 7,
										borderRadius: "50%",
										background: "var(--status-danger)",
										flexShrink: 0
									}}
								/>
								<span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
									{bp.displayPath}
								</span>
								<span className="tabular-nums" style={{ color: "var(--text-tertiary)", flexShrink: 0 }}>
									:{bp.line}
								</span>
							</button>
							<button
								type="button"
								onClick={() => store.toggleBreakpoint(bp.fullPath, bp.line)}
								aria-label={tr("중단점 제거", "Remove breakpoint")}
								title={tr("중단점 제거", "Remove breakpoint")}
								style={{ color: "var(--text-tertiary)", display: "flex", padding: 2 }}
							>
								<Icons.IconClose size={11} />
							</button>
						</div>
					))
				)}
			</div>
		</div>
	);
}