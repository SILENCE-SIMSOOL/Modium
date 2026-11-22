export interface ProgressPillProps {
	label: string;
	step: number;
	totalSteps: number;
	percent: number;
	indeterminate?: boolean;
}

export function ProgressPill({
	label,
	step,
	totalSteps,
	percent,
	indeterminate = false
}: ProgressPillProps) {
	const safePercent = Math.max(0, Math.min(100, Math.round(percent)));
	const stepLabel = totalSteps > 0 ? `${step}/${totalSteps}` : "";

	return (
		<div className="fs-progress-pill" title={label}>
			<span className="fs-progress-label">{label}</span>
			<progress
				className="fs-progress-bar"
				max={100}
				value={indeterminate ? undefined : safePercent}
			/>
			<span className="fs-progress-meta tabular-nums">
				{indeterminate ? stepLabel || "..." : stepLabel ? `${stepLabel} · ${safePercent}%` : `${safePercent}%`}
			</span>
		</div>
	);
}