import { useEffect, useMemo, useRef, useState } from "react";
import { backend } from "../services/backend";
import { fromFileUri, store, useStore, type BottomTab } from "../state/store";
import { useI18n } from "../i18n";
import {
	IconClose,
	IconError,
	IconInfo,
	IconRefresh,
	IconTerminal,
	IconTrash,
	IconWarning
} from "./ui/Icons";

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

interface UnifiedProblem {
	key: string;
	severity: "error" | "warning" | "info";
	message: string;
	relPath: string | null;
	displayPath: string;
	line: number;
	column: number;
}

export function BottomPanel() {
	const { t } = useI18n();
	const project = useStore((s) => s.project);
	const bottomVisible = useStore((s) => s.bottomVisible);
	const bottomTab = useStore((s) => s.bottomTab);
	const bottomHeight = useStore((s) => s.bottomHeight);
	const gradleOutput = useStore((s) => s.gradleOutput);
	const gradleState = useStore((s) => s.gradleState);
	const buildProblems = useStore((s) => s.buildProblems);
	const lspDiagnostics = useStore((s) => s.lspDiagnostics);
	const terminalSessionId = useStore((s) => s.terminalSessionId);
	const terminalChunks = useStore((s) => s.terminalChunks);
	const terminalExited = useStore((s) => s.terminalExited);
	const debugSession = useStore((s) => s.debugSession);
	const debugLogs = useStore((s) => s.debugLogs);

	const [autoScroll, setAutoScroll] = useState(true);
	const [dragging, setDragging] = useState(false);
	const [termInput, setTermInput] = useState("");
	const [termHistory, setTermHistory] = useState<string[]>([]);
	const [historyIdx, setHistoryIdx] = useState(-1);
	const [evalInput, setEvalInput] = useState("");

	const buildScrollRef = useRef<HTMLDivElement>(null);
	const termScrollRef = useRef<HTMLDivElement>(null);
	const debugScrollRef = useRef<HTMLDivElement>(null);
	const startingTermRef = useRef(false);

	const unifiedProblems = useMemo<UnifiedProblem[]>(() => {
		const out: UnifiedProblem[] = [];
		buildProblems.forEach((p, idx) => {
			out.push({
				key: `build-${idx}-${p.filePath}-${p.line}`,
				severity: p.severity,
				message: p.message,
				relPath: p.relPath,
				displayPath: p.relPath ?? p.filePath,
				line: p.line,
				column: p.column ?? 1
			});
		});
		for (const [uri, list] of Object.entries(lspDiagnostics)) {
			const relPath = fromFileUri(uri, project?.path ?? null);
			list.forEach((d, idx) => {
				out.push({
					key: `lsp-${uri}-${idx}`,
					severity:
						d.severity === 1 ? "error" : d.severity === 2 ? "warning" : "info",
					message: d.message,
					relPath,
					displayPath: relPath ?? uri,
					line: d.rangeStartLine + 1,
					column: d.rangeStartChar + 1
				});
			});
		}
		return out;
	}, [buildProblems, lspDiagnostics, project?.path]);

	useEffect(() => {
		if (!bottomVisible || bottomTab !== "terminal" || !project) return;
		if (terminalSessionId || startingTermRef.current) return;
		startingTermRef.current = true;
		void store
			.startTerminal()
			.catch((err) => {
				store.setState((prev) => ({
					terminalChunks: [
						...prev.terminalChunks,
						{ id: Date.now(), stream: "stderr", text: `${String(err)}\n` }
					]
				}));
			})
			.finally(() => {
				startingTermRef.current = false;
			});
	}, [bottomVisible, bottomTab, terminalSessionId, project]);

	useEffect(() => {
		if (!autoScroll) return;
		if (bottomTab === "build" && buildScrollRef.current) {
			buildScrollRef.current.scrollTop = buildScrollRef.current.scrollHeight;
		}
	}, [gradleOutput, bottomTab, autoScroll]);

	useEffect(() => {
		if (bottomTab === "terminal" && termScrollRef.current) {
			termScrollRef.current.scrollTop = termScrollRef.current.scrollHeight;
		}
	}, [terminalChunks, bottomTab]);

	useEffect(() => {
		if (bottomTab === "debugConsole" && debugScrollRef.current) {
			debugScrollRef.current.scrollTop = debugScrollRef.current.scrollHeight;
		}
	}, [debugLogs, bottomTab]);

	const handleResizePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
		e.preventDefault();
		const startY = e.clientY;
		const startH = bottomHeight;
		setDragging(true);

		const onMove = (ev: PointerEvent) => {
			store.setBottomHeight(startH + (startY - ev.clientY));
		};
		const onUp = () => {
			setDragging(false);
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	};

	const sendTerminalCommand = async () => {
		const cmd = termInput;
		if (!cmd.trim() && cmd === "") {
			if (terminalSessionId) {
				await backend.terminalWrite(terminalSessionId, "\n").catch(() => {});
			}
			return;
		}
		setTermInput("");
		setHistoryIdx(-1);
		setTermHistory((prev) => [cmd, ...prev.slice(0, 49)]);
		let sid = terminalSessionId;
		if (!sid) {
			try {
				sid = await store.startTerminal();
			} catch (err) {
				store.showToast("error", String(err));
				return;
			}
		}
		try {
			await backend.terminalWrite(sid, `${cmd}\n`);
		} catch (err) {
			store.showToast("error", String(err));
		}
	};

	const restartTerminal = async () => {
		if (terminalSessionId) {
			await backend.terminalStop(terminalSessionId).catch(() => {});
		}
		store.setState({ terminalSessionId: null, terminalChunks: [], terminalExited: false });
		try {
			await store.startTerminal();
		} catch (err) {
			store.showToast("error", String(err));
		}
	};

	const handleEvalSubmit = async () => {
		const expr = evalInput.trim();
		if (!expr || !debugSession) return;
		setEvalInput("");
		store.appendDebugLog("eval", `> ${expr}`);
		try {
			const res = await backend.debugEvaluate(expr);
			store.appendDebugLog(
				"result",
				res.varType ? `${res.result} (${res.varType})` : res.result
			);
		} catch (err) {
			store.appendDebugLog("error", String(err));
		}
	};

	if (!bottomVisible) return null;

	const problemTabs: Array<{ id: BottomTab; label: string; count?: number }> = [
		{ id: "terminal", label: t.bottom.terminal },
		{ id: "build", label: t.bottom.build },
		{ id: "problems", label: t.bottom.problems, count: unifiedProblems.length },
		{ id: "debugConsole", label: t.bottom.debugConsole }
	];

	return (
		<section className="fs-bottom" style={{ height: bottomHeight }}>
			<div
				className={`fs-resizer-h ${dragging ? "fs-resizer-h--dragging" : ""}`}
				onPointerDown={handleResizePointerDown}
			/>

			<div className="fs-bottom-bar">
				<div className="fs-bottom-tabs" role="tablist">
					{problemTabs.map((tab) => {
						const active = bottomTab === tab.id;
						return (
							<button
								key={tab.id}
								type="button"
								role="tab"
								aria-selected={active}
								className={`fs-bottom-tab ${active ? "fs-bottom-tab--active" : ""}`}
								onClick={() => store.setBottomTab(tab.id)}
							>
								<span>{tab.label}</span>
								{typeof tab.count === "number" && tab.count > 0 ? (
									<span className="fs-count-badge fs-count-badge--danger">
										{tab.count}
									</span>
								) : null}
							</button>
						);
					})}
				</div>

				<div style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
					{bottomTab === "build" ? (
						<>
							<span
								style={{
									fontSize: 11,
									color: "var(--text-tertiary)",
									marginRight: 4
								}}
							>
								{gradleState}
							</span>
							<button
								type="button"
								className={`fs-btn`}
								style={{
									height: 22,
									padding: "0 8px",
									fontSize: 11,
									background: autoScroll ? "var(--accent-weak-bg)" : undefined,
									color: autoScroll ? "var(--accent-weak-text)" : undefined
								}}
								onClick={() => setAutoScroll((v) => !v)}
							>
								{t.bottom.autoScroll}
							</button>
							<button
								type="button"
								className="fs-icon-btn"
								onClick={() => store.clearGradleOutput()}
								title={t.common.clear}
								aria-label={t.common.clear}
							>
								<IconTrash size={13} />
							</button>
						</>
					) : null}

					{bottomTab === "terminal" ? (
						<>
							<button
								type="button"
								className="fs-icon-btn"
								onClick={() => void restartTerminal()}
								title={t.bottom.restartTerminal}
								aria-label={t.bottom.restartTerminal}
							>
								<IconRefresh size={13} />
							</button>
							<button
								type="button"
								className="fs-icon-btn"
								onClick={() => store.setState({ terminalChunks: [] })}
								title={t.common.clear}
								aria-label={t.common.clear}
							>
								<IconTrash size={13} />
							</button>
						</>
					) : null}

					{bottomTab === "debugConsole" ? (
						<button
							type="button"
							className="fs-icon-btn"
							onClick={() => store.clearDebugLogs()}
							title={t.common.clear}
							aria-label={t.common.clear}
						>
							<IconTrash size={13} />
						</button>
					) : null}

					<button
						type="button"
						className="fs-icon-btn"
						onClick={() => store.toggleBottom()}
						title={t.common.close}
						aria-label={t.common.close}
					>
						<IconClose size={13} />
					</button>
				</div>
			</div>

			<div className="fs-bottom-body">
				{bottomTab === "terminal" ? (
					<>
						<div ref={termScrollRef} className="fs-console-scroll">
							{terminalChunks.length === 0 ? (
								<div className="fs-console-line" style={{ color: "var(--text-tertiary)" }}>
									{project ? project.path : t.status.noWorkspace}
								</div>
							) : (
								terminalChunks.map((chunk) => (
									<span
										key={chunk.id}
										className={`fs-console-line ${
											chunk.stream === "stderr" ? "fs-console-line--err" : ""
										}`}
									>
										{stripAnsi(chunk.text)}
									</span>
								))
							)}
						</div>
						<div className="fs-console-input-row">
							<IconTerminal size={13} style={{ color: "var(--accent-weak-text)" }} />
							<input
								className="fs-console-input"
								value={termInput}
								disabled={terminalExited}
								placeholder={
									terminalExited
										? t.bottom.restartTerminal
										: t.bottom.terminalPlaceholder
								}
								onChange={(e) => setTermInput(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") {
										e.preventDefault();
										void sendTerminalCommand();
									} else if (e.key === "ArrowUp") {
										e.preventDefault();
										if (termHistory.length > 0) {
											const next = Math.min(historyIdx + 1, termHistory.length - 1);
											setHistoryIdx(next);
											setTermInput(termHistory[next]);
										}
									} else if (e.key === "ArrowDown") {
										e.preventDefault();
										if (historyIdx <= 0) {
											setHistoryIdx(-1);
											setTermInput("");
										} else {
											const next = historyIdx - 1;
											setHistoryIdx(next);
											setTermInput(termHistory[next]);
										}
									}
								}}
							/>
						</div>
					</>
				) : null}

				{bottomTab === "build" ? (
					<div ref={buildScrollRef} className="fs-console-scroll">
						{gradleOutput.length === 0 ? (
							<div style={{ color: "var(--text-tertiary)" }}>
								{t.bottom.noBuildOutput}
							</div>
						) : (
							gradleOutput.map((line) => {
								const lower = line.text.toLowerCase();
								const cls =
									line.stream === "stderr" || lower.includes("error:")
										? "fs-console-line--err"
										: lower.includes("warning:")
											? "fs-console-line--warn"
											: line.stream === "info"
												? "fs-console-line--info"
												: "";
								return (
									<div key={line.id} className={`fs-console-line ${cls}`}>
										{stripAnsi(line.text)}
									</div>
								);
							})
						)}
					</div>
				) : null}

				{bottomTab === "problems" ? (
					<div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
						{unifiedProblems.length === 0 ? (
							<div
								style={{
									padding: "14px 12px",
									fontSize: 12,
									color: "var(--text-tertiary)"
								}}
							>
								{t.bottom.noProblems}
							</div>
						) : (
							unifiedProblems.map((prob) => (
								<button
									key={prob.key}
									type="button"
									className="fs-problem-row"
									onClick={() => {
										if (prob.relPath) {
											void store.openFileTab(prob.relPath, prob.line, prob.column);
										}
									}}
								>
									{prob.severity === "error" ? (
										<IconError
											size={14}
											style={{ color: "var(--status-danger)", flexShrink: 0 }}
										/>
									) : prob.severity === "warning" ? (
										<IconWarning
											size={14}
											style={{ color: "var(--status-warning)", flexShrink: 0 }}
										/>
									) : (
										<IconInfo
											size={14}
											style={{ color: "var(--accent-weak-text)", flexShrink: 0 }}
										/>
									)}
									<span
										style={{
											flex: 1,
											color: "var(--text-primary)",
											overflow: "hidden",
											textOverflow: "ellipsis",
											whiteSpace: "nowrap"
										}}
									>
										{prob.message}
									</span>
									<span
										className="tabular-nums"
										style={{
											fontSize: 11.5,
											color: "var(--text-tertiary)",
											flexShrink: 0
										}}
									>
										{prob.displayPath}:{prob.line}:{prob.column}
									</span>
								</button>
							))
						)}
					</div>
				) : null}

				{bottomTab === "debugConsole" ? (
					<>
						<div ref={debugScrollRef} className="fs-console-scroll">
							{debugLogs.length === 0 ? (
								<div style={{ color: "var(--text-tertiary)" }}>
									{t.bottom.noDebugLogs}
								</div>
							) : (
								debugLogs.map((entry) => (
									<div
										key={entry.id}
										className={`fs-console-line ${
											entry.kind === "error"
												? "fs-console-line--err"
												: entry.kind === "eval" || entry.kind === "event"
													? "fs-console-line--info"
													: ""
										}`}
									>
										{entry.text}
									</div>
								))
							)}
						</div>
						<div className="fs-console-input-row">
							<span className="fs-console-prompt">&gt;</span>
							<input
								className="fs-console-input"
								value={evalInput}
								disabled={!debugSession}
								placeholder={t.bottom.debugEvalPlaceholder}
								onChange={(e) => setEvalInput(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") {
										e.preventDefault();
										void handleEvalSubmit();
									}
								}}
							/>
						</div>
					</>
				) : null}
			</div>
		</section>
	);
}