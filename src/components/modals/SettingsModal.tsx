import { useEffect, useState } from "react";
import { LANGUAGES, useI18n } from "../../i18n";
import { backend } from "../../services/backend";
import { store, useStore } from "../../state/store";
import type { AppLanguage, AppSettings, AppTheme, JdkInfo } from "../../types/ipc";
import * as Icons from "../ui/Icons";
import { ModalDialog } from "../ui/ModalDialog";
import { ProgressPill } from "../ui/ProgressPill";

export function SettingsModal() {
	const { tr } = useI18n();
	const activeModal = useStore((s) => s.activeModal);
	const settings = useStore((s) => s.settings);
	const project = useStore((s) => s.project);
	const toolStatus = useStore((s) => s.toolStatus);
	const progressTask = useStore((s) => s.progressTask);
	const lspState = useStore((s) => s.lspState);
	const lspMessage = useStore((s) => s.lspMessage);
	const systemPrefersDark = useStore((s) => s.systemPrefersDark);

	const open = activeModal === "settings";
	const [page, setPage] = useState<"general" | "keys">("general");
	const [draft, setDraft] = useState<AppSettings>(settings);
	const [jdks, setJdks] = useState<JdkInfo[]>([]);
	const [saving, setSaving] = useState(false);
	const [restartingLsp, setRestartingLsp] = useState(false);

	useEffect(() => {
		if (!open) {
			return;
		}
		setDraft(settings);
		void backend
			.listJdks()
			.then((list) => setJdks(list))
			.catch(() => setJdks([]));
		void backend
			.getToolStatus()
			.then((st) => store.setState({ toolStatus: st }))
			.catch(() => {});
	}, [open]);

	const close = () => {
		store.setActiveModal("none");
	};

	const handleLanguageChange = (lang: AppLanguage) => {
		setDraft((prev) => ({ ...prev, language: lang }));
		void store.setLanguage(lang);
	};

	const handleThemeChange = (theme: AppTheme) => {
		setDraft((prev) => ({ ...prev, theme }));
		void store.setTheme(theme);
	};

	const handleSave = async () => {
		setSaving(true);
		try {
			await store.updateSettings({
				language: draft.language,
				theme: draft.theme,
				fontSize: Math.max(11, Math.min(22, draft.fontSize)),
				tabSize: draft.tabSize === 2 ? 2 : 4,
				autoSave: draft.autoSave,
				autoSaveDelayMs: Math.max(300, Math.min(10000, draft.autoSaveDelayMs)),
				preferredJdkPath: draft.preferredJdkPath
			});
			store.showToast("success", tr("설정을 저장했어요.", "Settings saved."));
			close();
		} finally {
			setSaving(false);
		}
	};

	const handleRestartLsp = async () => {
		if (!project) {
			return;
		}
		setRestartingLsp(true);
		try {
			await backend.stopLanguageServer().catch(() => {});
			await store.startLspForWorkspace();
			store.showToast("success", tr("언어 서버를 다시 시작했어요.", "Language server restarted."));
		} finally {
			setRestartingLsp(false);
		}
	};

	const sectionStyle: React.CSSProperties = {
		padding: 12,
		borderRadius: "var(--radius-l)",
		background: "var(--bg-canvas)",
		border: "1px solid var(--border-hairline)",
		display: "flex",
		flexDirection: "column",
		gap: 10
	};

	const labelStyle: React.CSSProperties = {
		display: "block",
		fontSize: 11.5,
		fontWeight: 600,
		color: "var(--text-secondary)",
		marginBottom: 4
	};

	return (
		<ModalDialog
			open={open}
			onClose={close}
			title={tr("환경설정", "Settings")}
			subtitle={tr(
				"에디터 표시, JDK 우선순위, JDT LS 및 디버그 도구를 관리해요",
				"Configure UI language, editor formatting, preferred JDK, and Java tools"
			)}
			icon={<Icons.IconSettings size={16} />}
			width={580}
			footer={
				<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
					<button type="button" className="fs-btn" onClick={close}>
						{tr("취소", "Cancel")}
					</button>
					<button
						type="button"
						className="fs-btn fs-btn--primary"
						onClick={() => void handleSave()}
						disabled={saving}
					>
						<Icons.IconCheck size={13} />
						{saving ? tr("저장 중...", "Saving...") : tr("저장", "Save")}
					</button>
				</div>
			}
		>
			<nav aria-label={tr("설정 페이지", "Settings pages")} style={{display:"flex",gap:8,marginBottom:12}}>
				<button className="fs-btn" aria-pressed={page === "general"} onClick={() => setPage("general")}>{tr("일반", "General")}</button>
				<button className="fs-btn" aria-pressed={page === "keys"} onClick={() => setPage("keys")}>{tr("단축키", "Keyboard shortcuts")}</button>
			</nav>
			{page === "keys" ? <div style={sectionStyle}>
				{[
					["Ctrl+Shift+T","클래스 검색","Open Type"], ["Ctrl+Shift+R","리소스 검색","Open Resource"],
					["Ctrl+P","빠른 열기","Quick Open"], ["Ctrl+Shift+F","프로젝트 텍스트 검색","Search in files"],
					["Ctrl+Shift+O","Java import 정리","Organize Java imports"], ["Ctrl+Space","자동완성","Suggest"],
					["Ctrl+S","저장","Save"], ["Ctrl+Shift+S","모두 저장","Save all"], ["Ctrl+F","파일 안에서 찾기","Find"],
					["F12","정의로 이동","Go to definition"], ["Ctrl+/","줄 주석 전환","Toggle line comment"],
					["Ctrl+H","파일 안에서 바꾸기","Replace"], ["Ctrl+G","줄로 이동","Go to line"],
					["Ctrl+B","사이드바 전환","Toggle sidebar"], ["Ctrl+J","하단 패널 전환","Toggle bottom panel"],
					["F5","디버그 시작 / 계속","Start / continue debugging"], ["F10","다음 줄","Step over"],
					["F11","함수 안으로","Step into"], ["Shift+F11","함수 밖으로","Step out"]
				].map(([key, ko, en]) => <div key={key} style={{display:"flex",justifyContent:"space-between"}}><span>{tr(ko,en)}</span><kbd className="fs-kbd">{key}</kbd></div>)}
			</div> : <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
				<div style={sectionStyle}>
					<div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text-primary)" }}>
						{tr("일반 및 에디터", "General & Editor")}
					</div>
					<div>
						<span style={labelStyle}>{tr("언어 (Language)", "Language")}</span>
						<div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6 }}>
							{LANGUAGES.map((opt) => {
								const active = draft.language === opt.code;
								return (
									<button
										key={opt.code}
										type="button"
										onClick={() => handleLanguageChange(opt.code)}
										style={{
											height: 32,
											borderRadius: "var(--radius-s)",
											border: `1px solid ${active ? "var(--accent)" : "var(--border-hairline)"}`,
											background: active ? "var(--accent-weak-bg)" : "var(--bg-elevated)",
											color: active ? "var(--accent-weak-text)" : "var(--text-secondary)",
											fontSize: 12,
											fontWeight: active ? 600 : 500
										}}
									>
										{opt.label}
									</button>
								);
							})}
						</div>
					</div>
					<div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 10 }}>
						<div>
							<span style={labelStyle}>{tr("테마", "Theme")}</span>
							<div style={{ display: "flex", gap: 6 }}>
								{(
									[
										{
											code: "system" as const,
											label: `${tr("시스템", "System")} (${systemPrefersDark ? tr("다크", "Dark") : tr("라이트", "Light")})`
										},
										{ code: "light" as const, label: tr("라이트", "Light") },
										{ code: "dark" as const, label: tr("다크", "Dark") }
									] as const
								).map((opt) => {
									const active = draft.theme === opt.code;
									return (
										<button
											key={opt.code}
											type="button"
											onClick={() => handleThemeChange(opt.code)}
											style={{
												flex: opt.code === "system" ? 1.5 : 1,
												height: 32,
												padding: "0 6px",
												borderRadius: "var(--radius-s)",
												border: `1px solid ${active ? "var(--accent)" : "var(--border-hairline)"}`,
												background: active ? "var(--accent-weak-bg)" : "var(--bg-elevated)",
												color: active ? "var(--accent-weak-text)" : "var(--text-secondary)",
												fontSize: 11.5,
												fontWeight: active ? 600 : 500,
												whiteSpace: "nowrap"
											}}
										>
											{opt.label}
										</button>
									);
								})}
							</div>
						</div>
						<div>
							<span style={labelStyle}>{tr("들여쓰기 크기", "Tab Size")}</span>
							<div style={{ display: "flex", gap: 6 }}>
								{[2, 4].map((size) => {
									const active = draft.tabSize === size;
									return (
										<button
											key={size}
											type="button"
											onClick={() => setDraft((p) => ({ ...p, tabSize: size }))}
											className="tabular-nums"
											style={{
												flex: 1,
												height: 32,
												borderRadius: "var(--radius-s)",
												border: `1px solid ${active ? "var(--accent)" : "var(--border-hairline)"}`,
												background: active ? "var(--accent-weak-bg)" : "var(--bg-elevated)",
												color: active ? "var(--accent-weak-text)" : "var(--text-secondary)",
												fontSize: 12,
												fontWeight: active ? 600 : 500
											}}
										>
											{size} {tr("칸", "spaces")}
										</button>
									);
								})}
							</div>
						</div>
					</div>
					<div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, alignItems: "center" }}>
						<div>
							<div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
								<label htmlFor="st-font-size" style={{ ...labelStyle, marginBottom: 0 }}>
									{tr("에디터 글꼴 크기", "Editor Font Size")}
								</label>
								<span className="tabular-nums" style={{ fontSize: 11.5, color: "var(--text-primary)", fontFamily: "var(--font-mono)" }}>
									{draft.fontSize}px
								</span>
							</div>
							<input
								id="st-font-size"
								type="range"
								min={11}
								max={22}
								step={1}
								value={draft.fontSize}
								onChange={(e) => setDraft((p) => ({ ...p, fontSize: Number(e.target.value) }))}
								style={{ width: "100%", accentColor: "var(--accent)" }}
							/>
						</div>
						<div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
							<label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer" }}>
								<input
									type="checkbox"
									checked={draft.autoSave}
									onChange={(e) => setDraft((p) => ({ ...p, autoSave: e.target.checked }))}
								/>
								{tr("자동 저장 사용", "Enable Auto Save")}
							</label>
							{draft.autoSave && (
								<div style={{ display: "flex", alignItems: "center", gap: 6 }}>
									<label htmlFor="st-autosave-delay" style={{ fontSize: 11.5, color: "var(--text-tertiary)" }}>
										{tr("지연 시간 (ms)", "Delay (ms)")}
									</label>
									<input
										id="st-autosave-delay"
										className="fs-input tabular-nums"
										type="number"
										min={300}
										max={10000}
										step={100}
										value={draft.autoSaveDelayMs}
										onChange={(e) =>
											setDraft((p) => ({
												...p,
												autoSaveDelayMs: Number(e.target.value) || 1000
											}))
										}
										style={{ width: 92, height: 28, fontFamily: "var(--font-mono)" }}
									/>
								</div>
							)}
						</div>
					</div>
				</div>
				<div style={sectionStyle}>
					<div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text-primary)" }}>
						{tr("기본 JDK 선택", "Preferred JDK")}
					</div>
					<div>
						<label htmlFor="st-jdk" style={labelStyle}>
							{tr("감지된 Java 런타임", "Detected JDK Installations")}
						</label>
						<select
							id="st-jdk"
							className="fs-select"
							value={draft.preferredJdkPath}
							onChange={(e) => setDraft((p) => ({ ...p, preferredJdkPath: e.target.value }))}
							style={{ width: "100%" }}
						>
							<option value="">{tr("자동 선택 (프로젝트 Java 버전에 맞춤)", "Auto (match project Java version)")}</option>
							{jdks.map((jdk) => (
								<option key={jdk.path} value={jdk.path}>
									Java {jdk.major} · {jdk.vendor} ({jdk.version}) — {jdk.path}
								</option>
							))}
						</select>
					</div>
				</div>
				<div style={sectionStyle}>
					<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
						<span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text-primary)" }}>
							{tr("JDT LS 및 Java 디버그 도구 상태", "JDT LS & Java Debug Tool Status")}
						</span>
						<span
							style={{
								fontSize: 11,
								fontFamily: "var(--font-mono)",
								color: lspState === "error" ? "var(--status-danger)" : "var(--text-tertiary)"
							}}
						>
							{tr("언어 서버", "LSP")}: {lspState}
						</span>
					</div>
					<div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
						<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
							<span style={{ color: "var(--text-secondary)" }}>Eclipse JDT Language Server</span>
							<span
								style={{
									display: "inline-flex",
									alignItems: "center",
									gap: 4,
									padding: "2px 8px",
									borderRadius: 999,
									background: toolStatus?.jdtlsInstalled
										? "var(--status-success-bg)"
										: "var(--status-warning-bg)",
									color: toolStatus?.jdtlsInstalled
										? "var(--status-success)"
										: "var(--status-warning)",
									fontSize: 11,
									fontWeight: 600
								}}
							>
								{toolStatus?.jdtlsInstalled ? <Icons.IconCheck size={11} /> : <Icons.IconWarning size={11} />}
								{toolStatus?.jdtlsInstalled ? tr("설치됨", "Installed") : tr("미설치", "Not Installed")}
							</span>
						</div>
						<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
							<span style={{ color: "var(--text-secondary)" }}>Microsoft Java Debug Server</span>
							<span
								style={{
									display: "inline-flex",
									alignItems: "center",
									gap: 4,
									padding: "2px 8px",
									borderRadius: 999,
									background: toolStatus?.javaDebugInstalled
										? "var(--status-success-bg)"
										: "var(--status-warning-bg)",
									color: toolStatus?.javaDebugInstalled
										? "var(--status-success)"
										: "var(--status-warning)",
									fontSize: 11,
									fontWeight: 600
								}}
							>
								{toolStatus?.javaDebugInstalled ? <Icons.IconCheck size={11} /> : <Icons.IconWarning size={11} />}
								{toolStatus?.javaDebugInstalled ? tr("설치됨", "Installed") : tr("미설치", "Not Installed")}
							</span>
						</div>
						{toolStatus?.toolsRoot && (
							<div
								style={{
									fontSize: 11,
									color: "var(--text-tertiary)",
									fontFamily: "var(--font-mono)",
									wordBreak: "break-all"
								}}
							>
								{toolStatus.toolsRoot}
							</div>
						)}
						{lspMessage && (
							<div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>{lspMessage}</div>
						)}
					</div>
					{progressTask && (
						<ProgressPill
							label={progressTask.label}
							step={progressTask.step}
							totalSteps={progressTask.totalSteps}
							percent={progressTask.percent}
							indeterminate={progressTask.indeterminate}
						/>
					)}
					<div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
						<button
							type="button"
							className="fs-btn fs-btn--primary"
							onClick={() => void store.ensureTools()}
							disabled={Boolean(progressTask)}
						>
							<Icons.IconJdk size={13} />
							{toolStatus?.jdtlsInstalled && toolStatus?.javaDebugInstalled
								? tr("도구 재확인 / 업데이트", "Verify / Update Tools")
								: tr("도구 설치", "Install Tools")}
						</button>
						<button
							type="button"
							className="fs-btn"
							onClick={() => void handleRestartLsp()}
							disabled={!project || restartingLsp}
						>
							<Icons.IconRefresh size={13} />
							{restartingLsp
								? tr("재시작 중...", "Restarting...")
								: tr("언어 서버 재시작", "Restart Language Server")}
						</button>
					</div>
				</div>
				<small>Modium · MIT License</small>
			</div>}
		</ModalDialog>
	);
}