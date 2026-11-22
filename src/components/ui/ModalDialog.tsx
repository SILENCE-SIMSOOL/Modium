import { useEffect, useId, useRef, type ReactNode } from "react";
import { IconClose } from "./Icons";

export interface ModalDialogProps {
	open: boolean;
	onClose: () => void;
	title: string;
	subtitle?: string;
	icon?: ReactNode;
	width?: number;
	children: ReactNode;
	footer?: ReactNode;
}

export function ModalDialog({
	open,
	onClose,
	title,
	subtitle,
	icon,
	width = 560,
	children,
	footer
}: ModalDialogProps) {
	const dialogRef = useRef<HTMLDialogElement>(null);
	const titleId = useId();
	const pointerDownOutsideRef = useRef(false);

	useEffect(() => {
		const dialog = dialogRef.current;
		if (!dialog) return;
		if (open) {
			if (!dialog.open) {
				dialog.showModal();
			}
		} else if (dialog.open) {
			dialog.returnValue = "";
			dialog.close();
		}
	}, [open]);

	useEffect(() => {
		const dialog = dialogRef.current;
		if (!dialog) return;

		const handleNativeClose = () => {
			dialog.returnValue = "";
			if (open) {
				onClose();
			}
		};

		dialog.addEventListener("close", handleNativeClose);
		return () => {
			dialog.removeEventListener("close", handleNativeClose);
		};
	}, [open, onClose]);

	useEffect(() => {
		const dialog = dialogRef.current;
		if (!dialog || "closedBy" in HTMLDialogElement.prototype) return;

		const isOutsideRect = (e: PointerEvent) => {
			const rect = dialog.getBoundingClientRect();
			return (
				e.clientX < rect.left ||
				e.clientX > rect.right ||
				e.clientY < rect.top ||
				e.clientY > rect.bottom
			);
		};

		const onPointerDown = (e: PointerEvent) => {
			pointerDownOutsideRef.current = e.target === dialog && isOutsideRect(e);
		};

		const onPointerUp = (e: PointerEvent) => {
			if (pointerDownOutsideRef.current && e.target === dialog && isOutsideRect(e)) {
				dialog.returnValue = "";
				dialog.close();
			}
			pointerDownOutsideRef.current = false;
		};

		dialog.addEventListener("pointerdown", onPointerDown);
		dialog.addEventListener("pointerup", onPointerUp);
		return () => {
			dialog.removeEventListener("pointerdown", onPointerDown);
			dialog.removeEventListener("pointerup", onPointerUp);
		};
	}, []);

	const dialogExtraProps = { closedby: "any" } as Record<string, string>;

	return (
		<dialog
			ref={dialogRef}
			className="fs-dialog"
			style={{ width: `${width}px` }}
			aria-labelledby={titleId}
			{...dialogExtraProps}
		>
			<div className="fs-dialog-head">
				<div className="fs-dialog-title-wrap">
					{icon ? <div className="fs-dialog-icon">{icon}</div> : null}
					<div style={{ minWidth: 0 }}>
						<h2 id={titleId} className="fs-dialog-title">
							{title}
						</h2>
						{subtitle ? <p className="fs-dialog-subtitle">{subtitle}</p> : null}
					</div>
				</div>
				<button
					type="button"
					className="fs-icon-btn"
					onClick={() => {
						const dialog = dialogRef.current;
						if (dialog?.open) {
							dialog.returnValue = "";
							dialog.close();
						} else {
							onClose();
						}
					}}
					aria-label="Close"
				>
					<IconClose size={15} />
				</button>
			</div>
			<div className="fs-dialog-body">{children}</div>
			{footer ? <div className="fs-dialog-foot">{footer}</div> : null}
		</dialog>
	);
}