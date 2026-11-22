import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import { store } from "../state/store";

type Field = HTMLInputElement | HTMLTextAreaElement;

export function TextContextMenu() {
	const { tr } = useI18n();
	const [target, setTarget] = useState<{field: Field; x: number; y: number} | null>(null);
	const menu = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const open = (event: MouseEvent) => {
			const field = event.target;
			const handled = event.defaultPrevented;
			event.preventDefault();
			if (handled || !(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)
				|| field.disabled || field.closest(".monaco-editor") || field.selectionStart === null) {
				setTarget(null);
				return;
			}
			field.focus();
			const bounds = field.getBoundingClientRect();
			setTarget({field, x: event.clientX || bounds.left, y: event.clientY || bounds.bottom});
		};
		const dismiss = (event: PointerEvent) => {
			if (!menu.current?.contains(event.target as Node)) setTarget(null);
		};
		const close = () => setTarget(null);
		document.addEventListener("contextmenu", open);
		document.addEventListener("pointerdown", dismiss, true);
		window.addEventListener("blur", close);
		return () => {
			document.removeEventListener("contextmenu", open);
			document.removeEventListener("pointerdown", dismiss, true);
			window.removeEventListener("blur", close);
		};
	}, []);

	useLayoutEffect(() => {
		const el = menu.current;
		if (!el || !target) return;
		el.style.left = Math.max(4, Math.min(target.x, innerWidth - el.offsetWidth - 4)) + "px";
		el.style.top = Math.max(4, Math.min(target.y, innerHeight - el.offsetHeight - 4)) + "px";
		el.querySelector<HTMLButtonElement>("button:enabled")?.focus();
	}, [target]);

	if (!target) return null;
	const { field } = target;
	const selected = field.selectionStart !== field.selectionEnd && field.type !== "password";
	const run = async (action: string) => {
		setTarget(null);
		field.focus();
		const start = field.selectionStart ?? 0;
		const end = field.selectionEnd ?? start;
		if (action === "selectAll") { field.select(); return; }
		try {
			if (action === "paste") {
				const original = field.value;
				const text = await navigator.clipboard.readText();
				if (document.activeElement === field && field.value === original && field.selectionStart === start && field.selectionEnd === end) {
					document.execCommand("insertText", false, text);
				}
			} else {
				await navigator.clipboard.writeText(field.value.slice(start, end));
				if (action === "cut" && document.activeElement === field && field.selectionStart === start && field.selectionEnd === end) document.execCommand("delete");
			}
		} catch {
			store.showToast("error", tr("클립보드에 접근할 수 없어요. 키보드 단축키를 사용해 주세요.", "Clipboard unavailable. Use the keyboard shortcut."));
		}
	};
	const actions = [
		{ id: "cut", label: tr("잘라내기", "Cut"), key: "X", disabled: field.readOnly || !selected },
		{ id: "copy", label: tr("복사", "Copy"), key: "C", disabled: !selected },
		{ id: "paste", label: tr("붙여넣기", "Paste"), key: "V", disabled: field.readOnly },
		{ id: "selectAll", label: tr("전체 선택", "Select All"), key: "A", disabled: !field.value }
	];
	return createPortal(<div ref={menu} className="fs-context-menu fs-text-menu" role="menu"
		onKeyDown={event => {
			if (event.key === "Escape" || event.key === "Tab") { setTarget(null); field.focus(); return; }
			if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
			event.preventDefault();
			const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:enabled"));
			const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
			buttons[(index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
		}}>
		{actions.map(a => <button key={a.id} role="menuitem" className="fs-context-item" type="button"
			disabled={a.disabled} onClick={() => void run(a.id)}>{a.label}<kbd>{/Mac/.test(navigator.platform) ? "⌘" : "Ctrl+"}{a.key}</kbd></button>)}
	</div>, field.closest("dialog") ?? document.body);
}
