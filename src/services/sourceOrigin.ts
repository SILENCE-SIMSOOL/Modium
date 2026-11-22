import type { MinecraftClassEntry } from "../types/ipc";

export function sourceOrigin(entry: MinecraftClassEntry, tr: (ko: string, en: string) => string): string {
	const label = {
		projectMapping: tr("프로젝트 버전·매핑", "Project version and mappings"),
		projectVersion: tr("프로젝트 버전", "Project version"),
		matchingMapping: tr("동일 버전·매핑", "Matching version and mappings"),
		matchingVersion: tr("동일 버전", "Matching version"),
		projectCache: tr("프로젝트 캐시", "Project cache"),
		globalCache: tr("공용 캐시", "Shared cache")
	}[entry.sourceScope];
	return [label, entry.sourceJar.split(/[\\/]/).pop()].filter(Boolean).join(" · ");
}
