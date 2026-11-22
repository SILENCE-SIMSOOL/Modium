import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { monaco } from "../services/monacoSetup";
import { store, type EditorTab } from "../state/store";
import { ModalDialog } from "./ui/ModalDialog";

export function ExternalChange({tab}: {tab: EditorTab}) {
	const {tr} = useI18n();
	const [open, setOpen] = useState(false);
	const host = useRef<HTMLDivElement>(null);
	const conflict = tab.external;
	useEffect(() => {
		if (!open || !host.current || !conflict) return;
		const editor = monaco.editor.createDiffEditor(host.current, {readOnly: true, automaticLayout: true, minimap: {enabled: false}});
		const original = monaco.editor.createModel(conflict.disk ?? "", tab.language);
		const modified = monaco.editor.createModel(tab.content, tab.language);
		editor.setModel({original, modified});
		return () => { editor.setModel(null); editor.dispose(); original.dispose(); modified.dispose(); };
	}, [open, conflict, tab.content, tab.language]);
	if (!conflict) return null;
	return <>
		<div className="fs-conflict" role="status">{conflict.disk === null ? tr("디스크에서 파일이 삭제됐어요.", "File deleted on disk.") : tr("디스크의 파일이 변경됐어요.", "File changed on disk.")}
			<button className="fs-btn" onClick={() => setOpen(true)}>{tr("변경 비교", "Compare changes")}</button>
		</div>
		<ModalDialog open={open} onClose={() => setOpen(false)} width={900} title={tab.title}
			subtitle={tr("왼쪽은 디스크, 오른쪽은 편집 중인 내용이에요.", "Disk on the left, editor on the right.")}
			footer={<>
				<button className="fs-btn" onClick={() => setOpen(false)}>{tr("취소", "Cancel")}</button>
				<button className="fs-btn" onClick={() => store.useDisk(tab.id)}>{conflict.disk === null ? tr("삭제 반영", "Accept deletion") : tr("디스크 내용 사용", "Use disk version")}</button>
				<button className="fs-btn fs-btn--primary" onClick={() => void store.saveTab(tab.id, conflict).catch(err => store.showToast("error", String(err)))}>{tr("편집본 저장", "Save editor version")}</button>
			</>}>
			<div ref={host} style={{height: "48vh"}} />
		</ModalDialog>
	</>;
}
