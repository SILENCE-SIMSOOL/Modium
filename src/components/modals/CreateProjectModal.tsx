import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../../i18n";
import { backend } from "../../services/backend";
import { normalizePathSlashes, store, useStore } from "../../state/store";
import type {
	CreateProjectConfig,
	FabricCompatVersions,
	FabricVersionCatalog,
	JdkInfo
} from "../../types/ipc";
import * as Icons from "../ui/Icons";
import { ModalDialog } from "../ui/ModalDialog";
import { ProgressPill } from "../ui/ProgressPill";

const JAVA_KEYWORDS = new Set([
	"abstract", "assert", "boolean", "break", "byte", "case", "catch", "char", "class",
	"const", "continue", "default", "do", "double", "else", "enum", "extends", "final",
	"finally", "float", "for", "goto", "if", "implements", "import", "instanceof", "int",
	"interface", "long", "native", "new", "package", "private", "protected", "public",
	"return", "short", "static", "strictfp", "super", "switch", "synchronized", "this",
	"throw", "throws", "transient", "try", "void", "volatile", "while", "true", "false", "null"
]);

function slugifyModId(name: string): string {
	const raw = name
		.toLowerCase()
		.trim()
		.replace(/[\s-]+/g, "_")
		.replace(/[^a-z0-9_]/g, "")
		.replace(/^[^a-z]+/, "")
		.replace(/_+/g, "_")
		.slice(0, 64);
	return raw;
}

function validatePackageName(pkg: string): boolean {
	const trimmed = pkg.trim();
	if (!trimmed) {
		return false;
	}
	const parts = trimmed.split(".");
	return parts.every((seg) => /^[a-z_][a-z0-9_]*$/.test(seg) && !JAVA_KEYWORDS.has(seg));
}

function joinDir(base: string, child: string): string {
	const trimmed = base.trim();
	if (!trimmed) {
		return "";
	}
	const sep = trimmed.includes("\\") && !trimmed.includes("/") ? "\\" : "/";
	const cleanBase = trimmed.replace(/[\\/]+$/, "");
	if (!child) {
		return cleanBase;
	}
	const lastSeg = normalizePathSlashes(cleanBase).split("/").pop()?.toLowerCase();
	if (lastSeg === child.toLowerCase()) {
		return cleanBase;
	}
	return `${cleanBase}${sep}${child}`;
}

export function CreateProjectModal() {
	const { tr } = useI18n();
	const activeModal = useStore((s) => s.activeModal);
	const settings = useStore((s) => s.settings);
	const open = activeModal === "createProject";

	const [modName, setModName] = useState("");
	const [modId, setModId] = useState("");
	const [modIdManual, setModIdManual] = useState(false);
	const [baseDir, setBaseDir] = useState("");
	const [packageName, setPackageName] = useState("com.example.example_mod");
	const [packageManual, setPackageManual] = useState(false);

	const [catalog, setCatalog] = useState<FabricVersionCatalog | null>(null);
	const [catalogLoading, setCatalogLoading] = useState(false);
	const [mcVersion, setMcVersion] = useState("26.3");
	const [showSnapshots, setShowSnapshots] = useState(false);
	const [compat, setCompat] = useState<FabricCompatVersions | null>(null);
	const [compatLoading, setCompatLoading] = useState(false);

	const [jdks, setJdks] = useState<JdkInfo[]>([]);
	const [selectedJdkPath, setSelectedJdkPath] = useState<string>("");
	const [generateClientEntrypoint, setGenerateClientEntrypoint] = useState(true);
	const [enableMixin, setEnableMixin] = useState(true);
	const [useYarnMappings, setUseYarnMappings] = useState(false);

	const [creating, setCreating] = useState(false);
	const [submitError, setSubmitError] = useState<string | null>(null);

	useEffect(() => {
		if (!open) {
			return;
		}
		setSubmitError(null);
		setCreating(false);
		setCatalogLoading(true);
		void backend
			.fetchFabricVersions(false)
			.then((res) => {
				setCatalog(res);
				const has263 = res.gameVersions.some((v) => v.version === "26.3");
				if (!has263) {
					const firstStable = res.gameVersions.find((v) => v.stable)?.version;
					if (firstStable) {
						setMcVersion(firstStable);
					}
				}
			})
			.catch(() => {
				setCatalog(null);
			})
			.finally(() => setCatalogLoading(false));

		void backend
			.listJdks()
			.then((list) => {
				setJdks(list);
			})
			.catch(() => setJdks([]));
	}, [open]);

	useEffect(() => {
		if (!open || !mcVersion) {
			return;
		}
		let cancelled = false;
		setCompatLoading(true);
		void backend
			.resolveFabricCompat(mcVersion)
			.then((res) => {
				if (cancelled) {
					return;
				}
				setCompat(res);
				if (res.isModernUnobfuscated) {
					setUseYarnMappings(false);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setCompat(null);
				}
			})
			.finally(() => {
				if (!cancelled) {
					setCompatLoading(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [open, mcVersion]);

	useEffect(() => {
		if (jdks.length === 0) {
			return;
		}
		const recJava = compat?.recommendedJava ?? 25;
		const preferred = settings.preferredJdkPath
			? jdks.find((j) => j.path === settings.preferredJdkPath && j.major >= recJava)
			: undefined;
		const exact = jdks.find((j) => j.major === recJava);
		const compatible = jdks.find((j) => j.major >= recJava);
		const best = preferred ?? exact ?? compatible ?? jdks[0];
		if (best) {
			setSelectedJdkPath(best.path);
		}
	}, [jdks, compat?.recommendedJava, settings.preferredJdkPath]);

	const versionOptions = useMemo(() => {
		const raw = catalog?.gameVersions ?? [
			{ version: "26.3", stable: true },
			{ version: "1.21.11", stable: true }
		];
		const filtered = raw.filter((v) => showSnapshots || v.stable || v.version === mcVersion);
		return filtered.slice(0, 80);
	}, [catalog, showSnapshots, mcVersion]);

	const resolvedProjectDir = useMemo(
		() => joinDir(baseDir, modId.trim()),
		[baseDir, modId]
	);

	const configPayload = useMemo<CreateProjectConfig>(() => {
		const isModern = compat?.isModernUnobfuscated ?? !mcVersion.startsWith("1.");
		return {
			projectDir: resolvedProjectDir,
			modName: modName.trim(),
			modId: modId.trim(),
			packageName: packageName.trim(),
			mcVersion,
			loaderVersion: compat?.loaderVersion ?? "0.20.1",
			loomVersion: compat?.loomVersion ?? "1.19.4",
			fabricApiVersion: compat?.fabricApiVersion ?? "",
			jdkPath: selectedJdkPath || null,
			generateClientEntrypoint,
			enableMixin,
			useYarnMappings: isModern ? false : useYarnMappings
		};
	}, [
		resolvedProjectDir,
		modName,
		modId,
		packageName,
		mcVersion,
		compat,
		selectedJdkPath,
		generateClientEntrypoint,
		enableMixin,
		useYarnMappings
	]);

	const validationErrors = useMemo(() => {
		const errs: string[] = [];
		if (!modName.trim()) {
			errs.push(tr("모드 이름을 입력하세요.", "Mod Name is required."));
		}
		if (!/^[a-z][a-z0-9_]{1,63}$/.test(modId.trim())) {
			errs.push(
				tr(
					"모드 ID는 소문자로 시작하는 2~64자의 소문자/숫자/밑줄(_)이어야 해요.",
					"Mod ID must match ^[a-z][a-z0-9_]{1,63}$."
				)
			);
		}
		if (!baseDir.trim()) {
			errs.push(tr("프로젝트 저장 위치를 선택하세요.", "Project Location is required."));
		}
		if (!validatePackageName(packageName)) {
			errs.push(tr("올바른 Java 패키지명을 입력하세요.", "Enter a valid Java package name."));
		}
		return errs;
	}, [modName, modId, baseDir, packageName, tr]);

	const selectedJdk = useMemo(
		() => jdks.find((j) => j.path === selectedJdkPath) ?? null,
		[jdks, selectedJdkPath]
	);

	const jdkMismatchWarning = useMemo(() => {
		if (!compat || !selectedJdk) {
			return null;
		}
		if (selectedJdk.major < compat.recommendedJava) {
			return tr(
				`선택한 JDK(${selectedJdk.major})가 권장 Java ${compat.recommendedJava}보다 낮아요.`,
				`Selected JDK ${selectedJdk.major} is below recommended Java ${compat.recommendedJava}.`
			);
		}
		return null;
	}, [compat, selectedJdk, tr]);

	const handleModNameChange = (val: string) => {
		setModName(val);
		if (!modIdManual) {
			const slug = slugifyModId(val);
			setModId(slug);
			if (!packageManual) {
				setPackageName(`com.example.${slug || "example_mod"}`);
			}
		}
	};

	const handleModIdChange = (val: string) => {
		setModIdManual(true);
		const cleaned = val.toLowerCase();
		setModId(cleaned);
		if (!packageManual) {
			setPackageName(`com.example.${cleaned || "example_mod"}`);
		}
	};

	const handlePickLocation = async () => {
		const picked = await backend.pickDirectory(baseDir || undefined);
		if (picked) {
			setBaseDir(picked);
		}
	};

	const handleCopyConfig = async () => {
		try {
			await navigator.clipboard.writeText(JSON.stringify(configPayload, null, "\t"));
			store.showToast(
				"success",
				tr("프로젝트 설정 JSON을 클립보드에 복사했어요.", "Copied project configuration JSON.")
			);
		} catch (err) {
			store.showToast("error", err instanceof Error ? err.message : String(err));
		}
	};

	const handleCreate = async () => {
		if (validationErrors.length > 0 || creating) {
			return;
		}
		setCreating(true);
		setSubmitError(null);
		try {
			const created = await backend.createFabricProject(configPayload);
			store.setActiveModal("none");
			await store.openProjectPath(created.path);
			store.showToast(
				"success",
				tr(`${created.name} 프로젝트를 생성했어요.`, `Created ${created.name}.`)
			);
		} catch (err) {
			setSubmitError(err instanceof Error ? err.message : String(err));
		} finally {
			setCreating(false);
		}
	};

	const close = () => {
		if (!creating) {
			store.setActiveModal("none");
		}
	};

	const labelStyle: React.CSSProperties = {
		display: "block",
		fontSize: 11.5,
		fontWeight: 600,
		color: "var(--text-secondary)",
		marginBottom: 4
	};

	const isModern = compat?.isModernUnobfuscated ?? !mcVersion.startsWith("1.");

	return (
		<ModalDialog
			open={open}
			onClose={close}
			title={tr("새 Fabric 모드 프로젝트", "Create New Fabric Mod")}
			subtitle={tr(
				"Minecraft 버전과 호환되는 Loader · Loom · API 버전을 자동으로 구성해요",
				"Automatically resolves Loader, Loom, Fabric API, and JDK versions"
			)}
			icon={<Icons.IconRocket size={16} />}
			width={620}
			footer={
				<div style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
					<button
						type="button"
						className="fs-btn"
						onClick={() => void handleCopyConfig()}
						disabled={creating}
					>
						<Icons.IconCopy size={13} />
						{tr("프로젝트 설정 복사", "Copy Project Configuration")}
					</button>
					<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
						<button type="button" className="fs-btn" onClick={close} disabled={creating}>
							{tr("취소", "Cancel")}
						</button>
						<button
							type="button"
							className="fs-btn fs-btn--primary"
							onClick={() => void handleCreate()}
							disabled={creating || validationErrors.length > 0 || compatLoading}
						>
							<Icons.IconPlus size={13} />
							{creating
								? tr("생성 중...", "Creating...")
								: submitError ? tr("다시 시도", "Retry") : tr("프로젝트 만들기", "Create Project")}
						</button>
					</div>
				</div>
			}
		>
			<div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
				<div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
					<div>
						<label htmlFor="cp-mod-name" style={labelStyle}>
							{tr("모드 이름", "Mod Name")}
						</label>
						<input
							id="cp-mod-name"
							className="fs-input"
							type="text"
							value={modName}
							onChange={(e) => handleModNameChange(e.target.value)}
							placeholder={tr("예: My Emerald Mod", "e.g. My Emerald Mod")}
							style={{ width: "100%" }}
						/>
					</div>
					<div>
						<label htmlFor="cp-mod-id" style={labelStyle}>
							{tr("모드 ID", "Mod ID")}
						</label>
						<input
							id="cp-mod-id"
							className="fs-input"
							type="text"
							value={modId}
							onChange={(e) => handleModIdChange(e.target.value)}
							placeholder="my_emerald_mod"
							style={{ width: "100%", fontFamily: "var(--font-mono)" }}
						/>
					</div>
				</div>
				<div>
					<label htmlFor="cp-location" style={labelStyle}>
						{tr("프로젝트 위치", "Project Location")}
					</label>
					<div style={{ display: "flex", gap: 6 }}>
						<input
							id="cp-location"
							className="fs-input"
							type="text"
							value={baseDir}
							onChange={(e) => setBaseDir(e.target.value)}
							placeholder={tr("프로젝트를 생성할 상위 폴더 선택", "Select parent folder for the project")}
							style={{ flex: 1, minWidth: 0, fontFamily: "var(--font-mono)" }}
						/>
						<button type="button" className="fs-btn" onClick={() => void handlePickLocation()}>
							<Icons.IconFolder size={13} />
							{tr("찾아보기", "Browse")}
						</button>
					</div>
					{resolvedProjectDir && (
						<div
							style={{
								marginTop: 4,
								fontSize: 11,
								color: "var(--text-tertiary)",
								fontFamily: "var(--font-mono)",
								wordBreak: "break-all"
							}}
						>
							{tr("생성 경로:", "Target:")} {resolvedProjectDir}
						</div>
					)}
				</div>
				<div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, alignItems: "end" }}>
					<div>
						<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
							<label htmlFor="cp-mc-version" style={{ ...labelStyle, marginBottom: 0 }}>
								{tr("Minecraft 버전", "Minecraft Version")}
							</label>
							<label
								style={{
									display: "inline-flex",
									alignItems: "center",
									gap: 4,
									fontSize: 11,
									color: "var(--text-secondary)",
									cursor: "pointer"
								}}
							>
								<input
									type="checkbox"
									checked={showSnapshots}
									onChange={(e) => setShowSnapshots(e.target.checked)}
								/>
								{tr("스냅샷 표시", "Show Snapshots")}
							</label>
						</div>
						<select
							id="cp-mc-version"
							className="fs-select"
							value={mcVersion}
							onChange={(e) => setMcVersion(e.target.value)}
							style={{ width: "100%", fontFamily: "var(--font-mono)" }}
						>
							{versionOptions.map((entry) => (
								<option key={entry.version} value={entry.version}>
									{entry.version} {entry.stable ? "" : tr("(스냅샷)", "(Snapshot)")}
								</option>
							))}
						</select>
					</div>
					<div>
						<label htmlFor="cp-package" style={labelStyle}>
							{tr("Java 패키지", "Java Package")}
						</label>
						<input
							id="cp-package"
							className="fs-input"
							type="text"
							value={packageName}
							onChange={(e) => {
								setPackageManual(true);
								setPackageName(e.target.value);
							}}
							placeholder="com.example.my_mod"
							style={{ width: "100%", fontFamily: "var(--font-mono)" }}
						/>
					</div>
				</div>
				<div
					style={{
						padding: "10px 12px",
						borderRadius: "var(--radius-l)",
						background: "var(--bg-canvas)",
						border: "1px solid var(--border-hairline)",
						display: "flex",
						flexDirection: "column",
						gap: 8
					}}
				>
					<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
						<span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--text-secondary)" }}>
							{catalogLoading || compatLoading
								? tr("호환 버전 계산 중...", "Resolving Fabric compatibility...")
								: tr("자동 해석된 Fabric 스택", "Auto-Resolved Fabric Stack")}
						</span>
						<span
							style={{
								padding: "2px 8px",
								borderRadius: 999,
								background: isModern ? "var(--accent-weak-bg)" : "var(--bg-control)",
								color: isModern ? "var(--accent-weak-text)" : "var(--text-secondary)",
								fontSize: 10.5,
								fontWeight: 600
							}}
						>
							{isModern
								? tr("최신 언오브퍼스케이트", "Modern Unobfuscated")
								: tr("레거시 리맵", "Legacy Remapped")}
						</span>
					</div>
					<div
						className="tabular-nums"
						style={{
							display: "grid",
							gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
							gap: 8,
							fontSize: 11.5
						}}
					>
						<div>
							<div style={{ color: "var(--text-tertiary)", fontSize: 10.5 }}>Loader</div>
							<div style={{ color: "var(--text-primary)", fontFamily: "var(--font-mono)", fontWeight: 600 }}>
								{compat?.loaderVersion ?? "-"}
							</div>
						</div>
						<div>
							<div style={{ color: "var(--text-tertiary)", fontSize: 10.5 }}>Loom</div>
							<div style={{ color: "var(--text-primary)", fontFamily: "var(--font-mono)", fontWeight: 600 }}>
								{compat?.loomVersion ?? "-"}
							</div>
						</div>
						<div>
							<div style={{ color: "var(--text-tertiary)", fontSize: 10.5 }}>Fabric API</div>
							<div
								style={{
									color: "var(--text-primary)",
									fontFamily: "var(--font-mono)",
									fontWeight: 600,
									overflow: "hidden",
									textOverflow: "ellipsis",
									whiteSpace: "nowrap"
								}}
								title={compat?.fabricApiVersion ?? ""}
							>
								{compat?.fabricApiVersion || "-"}
							</div>
						</div>
						<div>
							<div style={{ color: "var(--text-tertiary)", fontSize: 10.5 }}>
								{tr("권장 Java", "Rec. Java")}
							</div>
							<div style={{ color: "var(--text-primary)", fontFamily: "var(--font-mono)", fontWeight: 600 }}>
								Java {compat?.recommendedJava ?? 25}
							</div>
						</div>
					</div>
				</div>
				<div>
					<label htmlFor="cp-jdk" style={labelStyle}>
						{tr("프로젝트 JDK", "Project JDK")}
					</label>
					<select
						id="cp-jdk"
						className="fs-select"
						value={selectedJdkPath}
						onChange={(e) => setSelectedJdkPath(e.target.value)}
						style={{ width: "100%" }}
					>
						{jdks.length === 0 ? (
							<option value="">{tr("감지된 JDK 없음 (시스템 기본값 사용)", "No JDK detected (use system default)")}</option>
						) : (
							jdks.map((jdk) => (
								<option key={jdk.path} value={jdk.path}>
									Java {jdk.major} · {jdk.vendor} ({jdk.version}) — {jdk.path}
								</option>
							))
						)}
					</select>
					{jdkMismatchWarning && (
						<div style={{ marginTop: 4, fontSize: 11, color: "var(--status-warning)", display: "flex", alignItems: "center", gap: 4 }}>
							<Icons.IconWarning size={12} />
							<span>{jdkMismatchWarning}</span>
						</div>
					)}
				</div>
				<div
					style={{
						display: "flex",
						flexWrap: "wrap",
						gap: 14,
						padding: "8px 10px",
						borderRadius: "var(--radius-m)",
						background: "var(--bg-elevated)",
						border: "1px solid var(--border-hairline)"
					}}
				>
					<label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer" }}>
						<input
							type="checkbox"
							checked={generateClientEntrypoint}
							onChange={(e) => setGenerateClientEntrypoint(e.target.checked)}
						/>
						{tr("클라이언트 엔트리포인트 생성", "Generate Client Entrypoint")}
					</label>
					<label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer" }}>
						<input
							type="checkbox"
							checked={enableMixin}
							onChange={(e) => setEnableMixin(e.target.checked)}
						/>
						{tr("Mixin 활성화", "Enable Mixin")}
					</label>
					{!isModern && (
						<label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer" }}>
							<input
								type="checkbox"
								checked={useYarnMappings}
								onChange={(e) => setUseYarnMappings(e.target.checked)}
							/>
							{tr("Yarn 매핑 사용", "Use Yarn Mappings")}
						</label>
					)}
				</div>
				{validationErrors.length > 0 && (
					<div
						style={{
							padding: "8px 10px",
							borderRadius: "var(--radius-m)",
							background: "var(--status-warning-bg)",
							border: "1px solid rgba(245, 158, 11, 0.35)",
							color: "var(--status-warning)",
							fontSize: 11.5,
							display: "flex",
							flexDirection: "column",
							gap: 2
						}}
					>
						{validationErrors.map((err, idx) => (
							<div key={idx}>{err}</div>
						))}
					</div>
				)}
				{submitError && (
					<div
						style={{
							padding: "8px 10px",
							borderRadius: "var(--radius-m)",
							background: "var(--status-danger-bg)",
							border: "1px solid rgba(239, 68, 68, 0.4)",
							color: "var(--status-danger)",
							fontSize: 11.5
						}}
					>
						{submitError}
					</div>
				)}
				{creating && (
					<ProgressPill
						label={tr("Fabric 프로젝트 파일 및 Gradle 래퍼 생성 중...", "Generating Fabric template and Gradle wrapper...")}
						step={1}
						totalSteps={1}
						percent={50}
						indeterminate
					/>
				)}
			</div>
		</ModalDialog>
	);
}