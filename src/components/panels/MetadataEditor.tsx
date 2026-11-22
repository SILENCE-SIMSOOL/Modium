import { useCallback, useEffect, useState } from "react";
import { useI18n } from "../../i18n";
import { store, useStore } from "../../state/store";
import type { FabricModMetadata } from "../../types/ipc";
import * as Icons from "../ui/Icons";

const CORE_ENTRYPOINT_KEYS = ["main", "client", "server"] as const;
const CORE_DEPEND_KEYS = ["fabricloader", "minecraft", "java", "fabric-api"] as const;
const LICENSE_PRESETS = ["MIT", "Apache-2.0", "LGPL-3.0-only", "GPL-3.0-only", "CC0-1.0", "ARR"];

function buildMergedRawJson(meta: FabricModMetadata): string {
	let base: Record<string, unknown> = {};
	try {
		const parsed = JSON.parse(meta.rawJson);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			base = { ...(parsed as Record<string, unknown>) };
		}
	} catch {
		base = {};
	}
	base.schemaVersion = meta.schemaVersion || 1;
	base.id = meta.id;
	base.version = meta.version;
	base.name = meta.name;
	base.description = meta.description;
	base.authors = meta.authors.filter((a) => a.trim().length > 0);
	base.license = meta.license;
	base.environment = meta.environment || "*";

	const cleanEntrypoints: Record<string, string[]> = {};
	for (const [k, list] of Object.entries(meta.entrypoints)) {
		const cleaned = list.map((v) => v.trim()).filter(Boolean);
		if (cleaned.length > 0) {
			cleanEntrypoints[k] = cleaned;
		}
	}
	base.entrypoints = cleanEntrypoints;
	if (meta.mixins.length > 0) {
		base.mixins = meta.mixins;
	} else {
		delete base.mixins;
	}

	const cleanDepends: Record<string, string> = {};
	for (const [k, v] of Object.entries(meta.depends)) {
		const key = k.trim();
		const val = v.trim();
		if (key && val) {
			cleanDepends[key] = val;
		}
	}
	base.depends = cleanDepends;
	return JSON.stringify(base, null, "\t");
}

function parseRawJsonToMetadata(rawText: string, objectErrorMsg: string): FabricModMetadata {
	const parsed = JSON.parse(rawText) as Record<string, unknown>;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(objectErrorMsg);
	}
	const authorsRaw = Array.isArray(parsed.authors) ? parsed.authors : [];
	const authors = authorsRaw
		.map((item) => {
			if (typeof item === "string") {
				return item;
			}
			if (item && typeof item === "object" && "name" in item) {
				return String((item as { name: unknown }).name ?? "");
			}
			return "";
		})
		.filter((s) => s.length > 0);

	const entrypoints: Record<string, string[]> = {};
	if (parsed.entrypoints && typeof parsed.entrypoints === "object" && !Array.isArray(parsed.entrypoints)) {
		for (const [k, val] of Object.entries(parsed.entrypoints as Record<string, unknown>)) {
			if (Array.isArray(val)) {
				entrypoints[k] = val.map((item) =>
					typeof item === "string"
						? item
						: item && typeof item === "object" && "value" in item
							? String((item as { value: unknown }).value ?? "")
							: String(item ?? "")
				);
			}
		}
	}

	const depends: Record<string, string> = {};
	if (parsed.depends && typeof parsed.depends === "object" && !Array.isArray(parsed.depends)) {
		for (const [k, val] of Object.entries(parsed.depends as Record<string, unknown>)) {
			depends[k] = String(val ?? "");
		}
	}

	return {
		schemaVersion: typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : 1,
		id: typeof parsed.id === "string" ? parsed.id : "",
		version: typeof parsed.version === "string" ? parsed.version : "",
		name: typeof parsed.name === "string" ? parsed.name : "",
		description: typeof parsed.description === "string" ? parsed.description : "",
		authors,
		license:
			typeof parsed.license === "string"
				? parsed.license
				: Array.isArray(parsed.license)
					? parsed.license.map(String).join(", ")
					: "",
		environment: typeof parsed.environment === "string" ? parsed.environment : "*",
		entrypoints,
		mixins: Array.isArray(parsed.mixins) ? parsed.mixins : [],
		depends,
		rawJson: rawText
	};
}

export function MetadataEditor() {
	const { tr } = useI18n();
	const project = useStore((s) => s.project);
	const tabId = useStore(s => s.activeTabId);
	const currentTab = () => store.getState().tabs.find(t => t.id === tabId);
	const [meta, setMeta] = useState<FabricModMetadata | null>(null);
	const [rawMode, setRawMode] = useState(false);
	const [rawText, setRawText] = useState("");
	const [rawError, setRawError] = useState<string | null>(null);
	const savedContent = useStore(s => s.tabs.find(t => t.id === tabId)?.savedContent);
	const [loading, setLoading] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const dirty = useStore(s => s.tabs.find(t => t.id === tabId)?.isDirty ?? false);
	const [newAuthor, setNewAuthor] = useState("");
	const [newDepKey, setNewDepKey] = useState("");
	const [newDepVer, setNewDepVer] = useState("");

	const loadMetadata = useCallback(async () => {
		if (!project) {
			setMeta(null);
			setRawText("");
			return;
		}
		setLoading(true);
		setError(null);
		setRawError(null);
		try {
			const tab = currentTab();
			if (!tab) return;
			setRawText(tab.content);
			try {
				setMeta(parseRawJsonToMetadata(tab.content, tr("JSON 객체가 필요해.", "Expected a JSON object.")));
			} catch (err) {
				setRawMode(true);
				setRawError(String(err));
				setMeta(parseRawJsonToMetadata("{}", ""));
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setMeta(null);
		} finally {
			setLoading(false);
		}
	}, [project?.path, tabId, savedContent]);

	useEffect(() => {
		void loadMetadata();
	}, [loadMetadata]);

	const updateMeta = (updater: (prev: FabricModMetadata) => FabricModMetadata) => {
		if (!meta || !tabId) return;
		const next = updater(meta);
		setMeta(next);
		store.updateTabContent(tabId, buildMergedRawJson(next), false);
	};

	const rootObjErr = tr("최상위 JSON 값은 객체여야 해요.", "Root JSON value must be an object.");

	const handleToggleRaw = () => {
		if (!meta) {
			return;
		}
		if (!rawMode) {
			setRawText(buildMergedRawJson(meta));
			setRawError(null);
			setRawMode(true);
			return;
		}
		try {
			const parsed = parseRawJsonToMetadata(rawText, rootObjErr);
			setMeta(parsed);
			setRawError(null);
			setRawMode(false);
		} catch (err) {
			setRawError(err instanceof Error ? err.message : String(err));
		}
	};

	const handleSave = async () => {
		if (!meta) {
			return;
		}
		let payload: FabricModMetadata;
		if (rawMode) {
			try {
				payload = parseRawJsonToMetadata(rawText, rootObjErr);
				setRawError(null);
			} catch (err) {
				setRawError(err instanceof Error ? err.message : String(err));
				return;
			}
		} else {
			const cleanEntrypoints: Record<string, string[]> = {};
			for (const [k, list] of Object.entries(meta.entrypoints)) {
				const cleaned = list.map((v) => v.trim()).filter(Boolean);
				if (cleaned.length > 0) {
					cleanEntrypoints[k] = cleaned;
				}
			}
			const cleanDepends: Record<string, string> = {};
			for (const [k, v] of Object.entries(meta.depends)) {
				const key = k.trim();
				const val = v.trim();
				if (key && val) {
					cleanDepends[key] = val;
				}
			}
			const mergedRaw = buildMergedRawJson(meta);
			payload = {
				...meta,
				authors: meta.authors.map((a) => a.trim()).filter(Boolean),
				entrypoints: cleanEntrypoints,
				depends: cleanDepends,
				rawJson: mergedRaw
			};
		}
		setSaving(true);
		setError(null);
		try {
			if (!tabId) return;
			const content = rawMode ? rawText : buildMergedRawJson(payload);
			store.updateTabContent(tabId, content, false);
			await store.saveTab(tabId);
			store.showToast("success", tr("fabric.mod.json을 저장했어요.", "Saved fabric.mod.json."));

		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			setError(msg);
			store.showToast("error", msg);
		} finally {
			setSaving(false);
		}
	};

	const idValid = !meta || /^[a-z][a-z0-9_]{1,63}$/.test(meta.id.trim());

	const inputStyle: React.CSSProperties = {
		width: "100%",
		boxSizing: "border-box",
		height: 32,
		padding: "0 10px",
		borderRadius: "var(--radius-m)",
		border: "1px solid var(--border-strong)",
		background: "var(--bg-elevated)",
		color: "var(--text-primary)",
		fontSize: 12.5,
		outline: "none"
	};

	const sectionStyle: React.CSSProperties = {
		background: "var(--bg-panel)",
		border: "1px solid var(--border-hairline)",
		borderRadius: "var(--radius-l)",
		padding: 14,
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

	if (!project) {
		return (
			<div style={{ padding: 24, color: "var(--text-secondary)", fontSize: 13 }}>
				{tr("프로젝트를 열면 fabric.mod.json을 구조화된 폼으로 편집할 수 있어요.", "Open a Fabric project to edit fabric.mod.json.")}
			</div>
		);
	}

	const extraEntrypointKeys = meta
		? Object.keys(meta.entrypoints).filter((k) => !(CORE_ENTRYPOINT_KEYS as readonly string[]).includes(k))
		: [];
	const allEntrypointKeys = [...CORE_ENTRYPOINT_KEYS, ...extraEntrypointKeys];

	const extraDependKeys = meta
		? Object.keys(meta.depends).filter((k) => !(CORE_DEPEND_KEYS as readonly string[]).includes(k))
		: [];

	return (
		<div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, background: "var(--bg-canvas)" }}>
			<div
				style={{
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
					gap: 12,
					padding: "10px 16px",
					borderBottom: "1px solid var(--border-hairline)",
					background: "var(--bg-panel)"
				}}
			>
				<div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
					<span style={{ color: "var(--accent)", display: "flex" }}>
						<Icons.IconMetadata size={16} />
					</span>
					<div style={{ minWidth: 0 }}>
						<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
							<span style={{ fontSize: 13.5, fontWeight: 700, color: "var(--text-primary)" }}>
								fabric.mod.json
							</span>
							{dirty && (
								<span
									style={{
										padding: "1px 7px",
										borderRadius: 999,
										background: "rgba(245, 158, 11, 0.14)",
										color: "var(--status-warning)",
										fontSize: 10.5,
										fontWeight: 600
									}}
								>
									{tr("수정됨", "Modified")}
								</span>
							)}
						</div>
						{meta && (
							<div style={{ fontSize: 11, color: "var(--text-tertiary)", fontFamily: "var(--font-mono)" }}>
								{meta.id || "-"} · {meta.version || "-"}
							</div>
						)}
					</div>
				</div>
				<div style={{ display: "flex", alignItems: "center", gap: 6 }}>
					<button
						type="button"
						onClick={() => void loadMetadata()}
						disabled={loading || saving}
						style={{
							height: 30,
							padding: "0 10px",
							borderRadius: "var(--radius-m)",
							background: "var(--bg-control)",
							border: "1px solid var(--border-hairline)",
							color: "var(--text-primary)",
							fontSize: 12,
							fontWeight: 500,
							cursor: "pointer",
							display: "inline-flex",
							alignItems: "center",
							gap: 5
						}}
					>
						<Icons.IconRefresh size={13} />
						{tr("새로고침", "Reload")}
					</button>
					<button
						type="button"
						onClick={handleToggleRaw}
						disabled={!meta}
						style={{
							height: 30,
							padding: "0 10px",
							borderRadius: "var(--radius-m)",
							background: rawMode ? "rgba(49, 130, 246, 0.16)" : "var(--bg-control)",
							border: `1px solid ${rawMode ? "var(--accent)" : "var(--border-hairline)"}`,
							color: rawMode ? "var(--accent)" : "var(--text-primary)",
							fontSize: 12,
							fontWeight: 500,
							cursor: meta ? "pointer" : "not-allowed",
							display: "inline-flex",
							alignItems: "center",
							gap: 5
						}}
					>
						<Icons.IconJson size={13} />
						{rawMode ? tr("폼 편집기", "Form View") : tr("원본 JSON", "Raw JSON")}
					</button>
					<button
						type="button"
						onClick={() => void handleSave()}
						disabled={!meta || saving || (!rawMode && !idValid) || Boolean(rawError)}
						style={{
							height: 30,
							padding: "0 14px",
							borderRadius: "var(--radius-m)",
							background: "var(--accent)",
							border: "none",
							color: "#FFFFFF",
							fontSize: 12,
							fontWeight: 600,
							cursor: !meta || saving ? "not-allowed" : "pointer",
							opacity: !meta || saving || (!rawMode && !idValid) || Boolean(rawError) ? 0.5 : 1,
							display: "inline-flex",
							alignItems: "center",
							gap: 5
						}}
					>
						<Icons.IconCheck size={13} />
						{saving ? tr("저장 중...", "Saving...") : tr("저장", "Save")}
					</button>
				</div>
			</div>
			<div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
				<div style={{ maxWidth: 780, margin: "0 auto", display: "flex", flexDirection: "column", gap: 12 }}>
					{error && (
						<div
							style={{
								padding: "10px 12px",
								borderRadius: "var(--radius-m)",
								border: "1px solid var(--status-danger)",
								background: "rgba(240, 68, 82, 0.08)",
								color: "var(--status-danger)",
								fontSize: 12
							}}
						>
							{error}
						</div>
					)}
					{rawError && (
						<div
							style={{
								padding: "10px 12px",
								borderRadius: "var(--radius-m)",
								border: "1px solid var(--status-danger)",
								background: "rgba(240, 68, 82, 0.08)",
								color: "var(--status-danger)",
								fontSize: 12,
								fontFamily: "var(--font-mono)"
							}}
						>
							{rawError}
						</div>
					)}
					{loading && (
						<div style={{ color: "var(--text-tertiary)", fontSize: 12.5 }}>
							{tr("fabric.mod.json 불러오는 중...", "Loading fabric.mod.json...")}
						</div>
					)}
					{!loading && meta && rawMode && (
						<div style={sectionStyle}>
							<label htmlFor="fabric-mod-raw-json" style={labelStyle}>
								{tr("원본 JSON 내용", "Raw JSON Content")}
							</label>
							<textarea
								id="fabric-mod-raw-json"
								value={rawText}
								onChange={(e) => {
									const next = e.target.value;
									setRawText(next);
									if (tabId) store.updateTabContent(tabId, next, false);
									try {
										JSON.parse(next);
										setRawError(null);
									} catch (err) {
										setRawError(err instanceof Error ? err.message : String(err));
									}
								}}
								spellCheck={false}
								style={{
									width: "100%",
									minHeight: 420,
									boxSizing: "border-box",
									padding: 12,
									borderRadius: "var(--radius-m)",
									border: `1px solid ${rawError ? "var(--status-danger)" : "var(--border-strong)"}`,
									background: "var(--bg-canvas)",
									color: "var(--text-primary)",
									fontFamily: "var(--font-mono)",
									fontSize: 12,
									lineHeight: 1.55,
									resize: "vertical",
									outline: "none"
								}}
							/>
						</div>
					)}
					{!loading && meta && !rawMode && (
						<>
							<div style={sectionStyle}>
								<div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)" }}>
									{tr("기본 정보", "Basic Information")}
								</div>
								<div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
									<div>
										<label htmlFor="meta-mod-id" style={labelStyle}>
											{tr("모드 ID", "Mod ID")}
										</label>
										<input
											id="meta-mod-id"
											type="text"
											value={meta.id}
											onChange={(e) => updateMeta((m) => ({ ...m, id: e.target.value }))}
											style={{
												...inputStyle,
												fontFamily: "var(--font-mono)",
												borderColor: idValid ? "var(--border-strong)" : "var(--status-danger)"
											}}
										/>
										{!idValid && (
											<div style={{ marginTop: 3, fontSize: 11, color: "var(--status-danger)" }}>
												{tr(
													"소문자 알파벳으로 시작하고 소문자/숫자/밑줄만 사용할 수 있어요 (2~64자).",
													"Must match ^[a-z][a-z0-9_]{1,63}$."
												)}
											</div>
										)}
									</div>
									<div>
										<label htmlFor="meta-mod-version" style={labelStyle}>
											{tr("버전", "Version")}
										</label>
										<input
											id="meta-mod-version"
											type="text"
											value={meta.version}
											onChange={(e) => updateMeta((m) => ({ ...m, version: e.target.value }))}
											style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
										/>
									</div>
									<div>
										<label htmlFor="meta-mod-name" style={labelStyle}>
											{tr("모드 이름", "Mod Name")}
										</label>
										<input
											id="meta-mod-name"
											type="text"
											value={meta.name}
											onChange={(e) => updateMeta((m) => ({ ...m, name: e.target.value }))}
											style={inputStyle}
										/>
									</div>
									<div>
										<label htmlFor="meta-mod-license" style={labelStyle}>
											{tr("라이선스", "License")}
										</label>
										<input
											id="meta-mod-license"
											list="fabric-license-presets"
											type="text"
											value={meta.license}
											onChange={(e) => updateMeta((m) => ({ ...m, license: e.target.value }))}
											style={inputStyle}
										/>
										<datalist id="fabric-license-presets">
											{LICENSE_PRESETS.map((lic) => (
												<option key={lic} value={lic} />
											))}
										</datalist>
									</div>
								</div>
								<div>
									<label htmlFor="meta-mod-description" style={labelStyle}>
										{tr("설명", "Description")}
									</label>
									<textarea
										id="meta-mod-description"
										value={meta.description}
										onChange={(e) => updateMeta((m) => ({ ...m, description: e.target.value }))}
										rows={2}
										style={{
											...inputStyle,
											height: "auto",
											padding: "8px 10px",
											resize: "vertical",
											lineHeight: 1.45
										}}
									/>
								</div>
								<div>
									<span style={labelStyle}>{tr("실행 환경", "Environment")}</span>
									<div style={{ display: "inline-flex", gap: 6 }}>
										{[
											{ value: "*", label: tr("공통 (*)", "Both (*)") },
											{ value: "client", label: tr("클라이언트 (client)", "Client (client)") },
											{ value: "server", label: tr("서버 (server)", "Server (server)") }
										].map((opt) => {
											const active = (meta.environment || "*") === opt.value;
											return (
												<button
													key={opt.value}
													type="button"
													onClick={() => updateMeta((m) => ({ ...m, environment: opt.value }))}
													style={{
														padding: "5px 10px",
														borderRadius: "var(--radius-m)",
														border: `1px solid ${active ? "var(--accent)" : "var(--border-hairline)"}`,
														background: active ? "rgba(49, 130, 246, 0.16)" : "var(--bg-elevated)",
														color: active ? "var(--accent)" : "var(--text-secondary)",
														fontSize: 12,
														fontWeight: active ? 600 : 500,
														cursor: "pointer"
													}}
												>
													{opt.label}
												</button>
											);
										})}
									</div>
								</div>
							</div>
							<div style={sectionStyle}>
								<div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)" }}>
									{tr("제작자", "Authors")}
								</div>
								<div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
									{meta.authors.map((author, idx) => (
										<div
											key={`${author}-${idx}`}
											style={{
												display: "inline-flex",
												alignItems: "center",
												gap: 6,
												padding: "4px 8px",
												borderRadius: 999,
												background: "var(--bg-elevated)",
												border: "1px solid var(--border-hairline)",
												fontSize: 12,
												color: "var(--text-primary)"
											}}
										>
											<span>{author}</span>
											<button
												type="button"
												onClick={() =>
													updateMeta((m) => ({
														...m,
														authors: m.authors.filter((_, i) => i !== idx)
													}))
												}
												aria-label={tr("제작자 삭제", "Remove author")}
												style={{
													background: "transparent",
													border: "none",
													color: "var(--text-tertiary)",
													cursor: "pointer",
													display: "flex",
													padding: 0
												}}
											>
												<Icons.IconClose size={11} />
											</button>
										</div>
									))}
									{meta.authors.length === 0 && (
										<span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
											{tr("등록된 제작자가 없어요.", "No authors listed.")}
										</span>
									)}
								</div>
								<form
									onSubmit={(e) => {
										e.preventDefault();
										const trimmed = newAuthor.trim();
										if (!trimmed) {
											return;
										}
										updateMeta((m) => ({ ...m, authors: [...m.authors, trimmed] }));
										setNewAuthor("");
									}}
									style={{ display: "flex", gap: 6 }}
								>
									<input
										type="text"
										value={newAuthor}
										onChange={(e) => setNewAuthor(e.target.value)}
										placeholder={tr("제작자 이름 입력...", "Add author name...")}
										aria-label={tr("새 제작자 이름", "New author name")}
										style={{ ...inputStyle, flex: 1 }}
									/>
									<button
										type="submit"
										disabled={!newAuthor.trim()}
										style={{
											height: 32,
											padding: "0 12px",
											borderRadius: "var(--radius-m)",
											background: "var(--bg-control)",
											border: "1px solid var(--border-strong)",
											color: "var(--text-primary)",
											fontSize: 12,
											cursor: newAuthor.trim() ? "pointer" : "not-allowed",
											display: "inline-flex",
											alignItems: "center",
											gap: 4
										}}
									>
										<Icons.IconPlus size={12} />
										{tr("추가", "Add")}
									</button>
								</form>
							</div>
							<div style={sectionStyle}>
								<div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)" }}>
									{tr("엔트리포인트 (Entrypoints)", "Entrypoints")}
								</div>
								{allEntrypointKeys.map((epKey) => {
									const values = meta.entrypoints[epKey] ?? [];
									return (
										<div
											key={epKey}
											style={{
												padding: 10,
												borderRadius: "var(--radius-m)",
												background: "var(--bg-canvas)",
												border: "1px solid var(--border-hairline)",
												display: "flex",
												flexDirection: "column",
												gap: 6
											}}
										>
											<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
												<span
													style={{
														fontSize: 12,
														fontWeight: 600,
														color: "var(--text-primary)",
														fontFamily: "var(--font-mono)"
													}}
												>
													{epKey}
												</span>
												<button
													type="button"
													onClick={() =>
														updateMeta((m) => ({
															...m,
															entrypoints: {
																...m.entrypoints,
																[epKey]: [...(m.entrypoints[epKey] ?? []), ""]
															}
														}))
													}
													style={{
														padding: "3px 8px",
														borderRadius: "var(--radius-m)",
														background: "var(--bg-control)",
														border: "1px solid var(--border-hairline)",
														color: "var(--text-secondary)",
														fontSize: 11,
														cursor: "pointer",
														display: "inline-flex",
														alignItems: "center",
														gap: 4
													}}
												>
													<Icons.IconPlus size={11} />
													{tr("클래스 추가", "Add Class")}
												</button>
											</div>
											{values.length === 0 ? (
												<div style={{ fontSize: 11.5, color: "var(--text-tertiary)" }}>
													{tr("지정된 엔트리포인트가 없어요.", "No classes configured.")}
												</div>
											) : (
												values.map((cls, idx) => (
													<div key={`${epKey}-${idx}`} style={{ display: "flex", gap: 6, alignItems: "center" }}>
														<input
															type="text"
															value={cls}
															placeholder="com.example.ExampleMod"
															onChange={(e) => {
																const val = e.target.value;
																updateMeta((m) => {
																	const list = [...(m.entrypoints[epKey] ?? [])];
																	list[idx] = val;
																	return {
																		...m,
																		entrypoints: { ...m.entrypoints, [epKey]: list }
																	};
																});
															}}
															style={{ ...inputStyle, flex: 1, fontFamily: "var(--font-mono)" }}
														/>
														<button
															type="button"
															onClick={() =>
																updateMeta((m) => ({
																	...m,
																	entrypoints: {
																		...m.entrypoints,
																		[epKey]: (m.entrypoints[epKey] ?? []).filter((_, i) => i !== idx)
																	}
																}))
															}
															aria-label={tr("엔트리포인트 삭제", "Remove entrypoint")}
															style={{
																height: 32,
																width: 32,
																borderRadius: "var(--radius-m)",
																background: "var(--bg-control)",
																border: "1px solid var(--border-hairline)",
																color: "var(--text-tertiary)",
																cursor: "pointer",
																display: "inline-flex",
																alignItems: "center",
																justifyContent: "center"
															}}
														>
															<Icons.IconClose size={12} />
														</button>
													</div>
												))
											)}
										</div>
									);
								})}
							</div>
							<div style={sectionStyle}>
								<div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)" }}>
									{tr("의존성 (Depends)", "Dependencies")}
								</div>
								<div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
									{CORE_DEPEND_KEYS.map((depKey) => (
										<div key={depKey}>
											<label
												htmlFor={`dep-${depKey}`}
												style={{ ...labelStyle, fontFamily: "var(--font-mono)" }}
											>
												{depKey}
											</label>
											<input
												id={`dep-${depKey}`}
												type="text"
												value={meta.depends[depKey] ?? ""}
												placeholder={depKey === "java" ? ">=25" : "*"}
												onChange={(e) => {
													const val = e.target.value;
													updateMeta((m) => ({
														...m,
														depends: { ...m.depends, [depKey]: val }
													}));
												}}
												style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
											/>
										</div>
									))}
								</div>
								{extraDependKeys.length > 0 && (
									<div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
										{extraDependKeys.map((depKey) => (
											<div key={depKey} style={{ display: "flex", gap: 6, alignItems: "center" }}>
												<span
													style={{
														width: 150,
														fontSize: 12,
														fontFamily: "var(--font-mono)",
														color: "var(--text-secondary)",
														overflow: "hidden",
														textOverflow: "ellipsis"
													}}
												>
													{depKey}
												</span>
												<input
													type="text"
													value={meta.depends[depKey] ?? ""}
													onChange={(e) => {
														const val = e.target.value;
														updateMeta((m) => ({
															...m,
															depends: { ...m.depends, [depKey]: val }
														}));
													}}
													style={{ ...inputStyle, flex: 1, fontFamily: "var(--font-mono)" }}
												/>
												<button
													type="button"
													onClick={() =>
														updateMeta((m) => {
															const next = { ...m.depends };
															delete next[depKey];
															return { ...m, depends: next };
														})
													}
													aria-label={tr("의존성 삭제", "Remove dependency")}
													style={{
														height: 32,
														width: 32,
														borderRadius: "var(--radius-m)",
														background: "var(--bg-control)",
														border: "1px solid var(--border-hairline)",
														color: "var(--text-tertiary)",
														cursor: "pointer",
														display: "inline-flex",
														alignItems: "center",
														justifyContent: "center"
													}}
												>
													<Icons.IconClose size={12} />
												</button>
											</div>
										))}
									</div>
								)}
								<form
									onSubmit={(e) => {
										e.preventDefault();
										const k = newDepKey.trim();
										const v = newDepVer.trim() || "*";
										if (!k) {
											return;
										}
										updateMeta((m) => ({
											...m,
											depends: { ...m.depends, [k]: v }
										}));
										setNewDepKey("");
										setNewDepVer("");
									}}
									style={{ display: "flex", gap: 6, marginTop: 4 }}
								>
									<input
										type="text"
										value={newDepKey}
										onChange={(e) => setNewDepKey(e.target.value)}
										placeholder={tr("모드 ID (예: modmenu)", "Mod ID (e.g. modmenu)")}
										aria-label={tr("추가 의존성 ID", "Extra dependency ID")}
										style={{ ...inputStyle, flex: 1, fontFamily: "var(--font-mono)" }}
									/>
									<input
										type="text"
										value={newDepVer}
										onChange={(e) => setNewDepVer(e.target.value)}
										placeholder=">=1.0.0"
										aria-label={tr("추가 의존성 버전 범위", "Extra dependency version")}
										style={{ ...inputStyle, width: 140, fontFamily: "var(--font-mono)" }}
									/>
									<button
										type="submit"
										disabled={!newDepKey.trim()}
										style={{
											height: 32,
											padding: "0 12px",
											borderRadius: "var(--radius-m)",
											background: "var(--bg-control)",
											border: "1px solid var(--border-strong)",
											color: "var(--text-primary)",
											fontSize: 12,
											cursor: newDepKey.trim() ? "pointer" : "not-allowed",
											display: "inline-flex",
											alignItems: "center",
											gap: 4
										}}
									>
										<Icons.IconPlus size={12} />
										{tr("추가", "Add")}
									</button>
								</form>
							</div>
						</>
					)}
				</div>
			</div>
		</div>
	);
}