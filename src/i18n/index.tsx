import { store, useStore } from "../state/store";
import type { AppLanguage } from "../types/ipc";
import { en } from "./en";
import { ja } from "./ja";
import { ko, type TranslationDict } from "./ko";
import { JA_PHRASES, ZH_PHRASES } from "./phrases";
import { zh } from "./zh";

export type { TranslationDict };

export const LANGUAGES: ReadonlyArray<{ code: AppLanguage; short: string; label: string }> = [
	{ code: "ko", short: "KO", label: "한국어" },
	{ code: "en", short: "EN", label: "English" },
	{ code: "zh", short: "中文", label: "中文" },
	{ code: "ja", short: "日本語", label: "日本語" }
];

const DICTS: Record<AppLanguage, TranslationDict> = {
	ko,
	en,
	zh,
	ja
};

export function translateByLang(
	lang: AppLanguage,
	koText: string,
	enText: string,
	zhText?: string,
	jaText?: string
): string {
	if (lang === "ko") return koText;
	if (lang === "zh") return zhText ?? ZH_PHRASES[enText] ?? enText;
	if (lang === "ja") return jaText ?? JA_PHRASES[enText] ?? enText;
	return enText;
}

export function useI18n(): {
	lang: AppLanguage;
	setLang: (lang: AppLanguage) => void;
	t: TranslationDict;
	tr: (koText: string, enText: string, zhText?: string, jaText?: string) => string;
} {
	const lang = useStore((s) => s.settings.language);
	const t = DICTS[lang] ?? ko;
	const setLang = (next: AppLanguage) => {
		void store.setLanguage(next);
	};
	const tr = (koText: string, enText: string, zhText?: string, jaText?: string) =>
		translateByLang(lang, koText, enText, zhText, jaText);
	return { lang, setLang, t, tr };
}