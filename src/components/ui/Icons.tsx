import type { SVGProps } from "react";

export interface IconProps extends SVGProps<SVGSVGElement> {
	size?: number;
}

function baseProps(size: number, props: IconProps): SVGProps<SVGSVGElement> {
	const { size: _ignored, ...rest } = props;
	return {
		width: size,
		height: size,
		viewBox: "0 0 24 24",
		fill: "none",
		stroke: "currentColor",
		strokeWidth: 1.75,
		strokeLinecap: "round",
		strokeLinejoin: "round",
		"aria-hidden": true,
		...rest
	};
}

export function IconFolder({
	size = 16,
	open = false,
	...props
}: IconProps & { open?: boolean }) {
	return open ? (
		<svg {...baseProps(size, props)}>
			<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.4l1.9 2H19.5A1.5 1.5 0 0 1 21 8.5V10H5.8a1.5 1.5 0 0 0-1.45 1.12L2.7 17.5A1.5 1.5 0 0 0 4.15 19H18.4a1.5 1.5 0 0 0 1.46-1.14l1.36-5.6A1.5 1.5 0 0 0 19.76 10.5H6" />
		</svg>
	) : (
		<svg {...baseProps(size, props)}>
			<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.4l1.9 2h8.7A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z" />
		</svg>
	);
}

export function IconFile({ size = 16, ...props }: IconProps) {
	return (
		<svg {...baseProps(size, props)}>
			<path d="M6 3h8l4 4v14H6z" />
			<path d="M14 3v4h4" />
		</svg>
	);
}

export function IconJava({ size = 16, ...props }: IconProps) {
	return (
		<svg {...baseProps(size, props)}>
			<path d="M6 10h10v4a5 5 0 0 1-10 0z" />
			<path d="M16 11h1.5a2 2 0 0 1 0 4H16" />
			<path d="M9 5c.8-1 .8-2 0-3" />
			<path d="M13 5c.8-1 .8-2 0-3" />
			<path d="M5 20h12" />
		</svg>
	);
}

export function IconJson({ size = 16, ...props }: IconProps) {
	return (
		<svg {...baseProps(size, props)}>
			<path d="M9 4c-1.5 0-2 .8-2 2v3.5c0 1.2-.8 2-2 2.5 1.2.5 2 1.3 2 2.5V18c0 1.2.5 2 2 2" />
			<path d="M15 4c1.5 0 2 .8 2 2v3.5c0 1.2.8 2 2 2.5-1.2.5-2 1.3-2 2.5V18c0 1.2-.5 2-2 2" />
		</svg>
	);
}

export function IconGradle({ size = 16, ...props }: IconProps) {
	return (
		<svg {...baseProps(size, props)}>
			<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
			<path d="M12 12v9" />
			<path d="M4 7.5L12 12l8-4.5" />
		</svg>
	);
}

export function IconPlay({ size = 16, ...props }: IconProps) {
	return (
		<svg {...baseProps(size, props)}>
			<polygon points="7,5 19,12 7,19" fill="currentColor" stroke="none" />
		</svg>
	);
}

export function IconDebug({ size = 16, ...props }: IconProps) {
	return (
		<svg {...baseProps(size, props)}>
			<rect x="7" y="8" width="10" height="11" rx="5" />
			<path d="M9 8V6a3 3 0 0 1 6 0v2" />
			<path d="M4 11h3" />
			<path d="M17 11h3" />
			<path d="M4.5 16l2.8-1" />
			<path d="M19.5 16l-2.8-1" />
			<path d="M12 8v11" />
		</svg>
	);
}

export function IconBuild({ size = 16, ...props }: IconProps) {
	return (
		<svg {...baseProps(size, props)}>
			<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l2.8-2.8a5.2 5.2 0 0 1-6.9 6.9l-6.4 6.4a1.8 1.8 0 0 1-2.5-2.5l6.4-6.4a5.2 5.2 0 0 1 6.9-6.9z" />
		</svg>
	);
}

export function IconStop({ size = 16, ...props }: IconProps) {
	return (
		<svg {...baseProps(size, props)}>
			<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />
		</svg>
	);
}

export function IconSync({ size = 16, ...props }: IconProps) {
	return (
		<svg {...baseProps(size, props)}>
			<path d="M20 7v5h-5" />
			<path d="M4 17v-5h5" />
			<path d="M19 12a7 7 0 0 0-12.4-4.4L4 10" />
			<path d="M5 12a7 7 0 0 0 12.4 4.4L20 14" />
		</svg>
	);
}

export function IconSearch({ size = 16, ...props }: IconProps) {
	return (
		<svg {...baseProps(size, props)}>
			<circle cx="11" cy="11" r="6.5" />
			<path d="M16 16l4.5 4.5" />
		</svg>
	);
}

export function IconMixin({ size = 16, ...props }: IconProps) {
	return (
		<svg {...baseProps(size, props)}>
			<circle cx="8" cy="8" r="3" />
			<circle cx="16" cy="16" r="3" />
			<path d="M11 8h4a2 2 0 0 1 2 2v3" />
			<path d="M8 11v4a2 2 0 0 0 2 2h3" />
		</svg>
	);
}

export function IconCube({ size = 16, ...props }: IconProps) {
	return (
		<svg {...baseProps(size, props)}>
			<path d="M12 2.5l8 4.5v10l-8 4.5-8-4.5V7z" />
			<path d="M4 7l8 4.5L20 7" />
			<path d="M12 11.5v10" />
		</svg>
	);
}

export function IconPalette({ size = 16, ...props }: IconProps) {
	return (
		<svg {...baseProps(size, props)}>
			<rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
			<circle cx="8.5" cy="9.5" r="1.5" />
			<path d="M4 17l5.5-5 4 3.5 2.5-2.5 4.5 4" />
		</svg>
	);
}

export function IconGit({ size = 16, ...props }: IconProps) {
	return (
		<svg {...baseProps(size, props)}>
			<circle cx="6" cy="6" r="2.5" />
			<circle cx="18" cy="8" r="2.5" />
			<circle cx="6" cy="18" r="2.5" />
			<path d="M6 8.5v7" />
			<path d="M18 10.5v.5a4 4 0 0 1-4 4H8.5" />
		</svg>
	);
}

export function IconTerminal({ size = 16, ...props }: IconProps) {
	return (
		<svg {...baseProps(size, props)}>
			<rect x="3" y="4" width="18" height="16" rx="2.5" />
			<path d="M7 9l3.5 3L7 15" />
			<path d="M12.5 15h4.5" />
		</svg>
	);
}

export function IconWarning({ size = 16, ...props }: IconProps) {
	return (
		<svg {...baseProps(size, props)}>
			<path d="M12 3.5L2.8 19.5h18.4z" />
			<path d="M12 9.5v4.5" />
			<circle cx="12" cy="16.8" r=".7" fill="currentColor" stroke="none" />
		</svg>
	);
}

export function IconError({ size = 16, ...props }: IconProps) {
	return (
		<svg {...baseProps(size, props)}>
			<circle cx="12" cy="12" r="9" />
			<path d="M9.5 9.5l5 5" />
			<path d="M14.5 9.5l-5 5" />
		</svg>
	);
}

export function IconCheck({ size = 16, ...props }: IconProps) {
	return (
		<svg {...baseProps(size, props)}>
			<path d="M5 12.5l4.5 4.5L19 7.5" />
		</svg>
	);
}

export function IconClose({ size = 16, ...props }: IconProps) {
	return (
		<svg {...baseProps(size, props)}>
			<path d="M6.5 6.5l11 11" />
			<path d="M17.5 6.5l-11 11" />
		</svg>
	);
}

export function IconPlus({ size = 16, ...props }: IconProps) {
	return (
		<svg {...baseProps(size, props)}>
			<path d="M12 5v14" />
			<path d="M5 12h14" />
		</svg>
	);
}

export function IconSettings({ size = 16, ...props }: IconProps) {
	return (
		<svg {...baseProps(size, props)}>
			<circle cx="12" cy="12" r="3" />
			<path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 0 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.2a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.2a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3h.1a1.6 1.6 0 0 0 .9-1.5V3a2 2 0 0 1 4 0v.2a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8v.1a1.6 1.6 0 0 0 1.5.9H21a2 2 0 0 1 0 4h-.2a1.6 1.6 0 0 0-1.4 1z" />
		</svg>
	);
}

export function IconRocket({ size = 16, ...props }: IconProps) {
	return (
		<svg {...baseProps(size, props)}>
			<path d="M5 19l4-1 9.5-9.5a2.8 2.8 0 0 0-4-4L5 14z" />
			<path d="M13 6l5 5" />
			<path d="M9 18l-3 3" />
		</svg>
	);
}

export function IconJdk({ size = 16, ...props }: IconProps) {
	return (
		<svg {...baseProps(size, props)}>
			<rect x="6" y="6" width="12" height="12" rx="2" />
			<rect x="9.5" y="9.5" width="5" height="5" rx="1" />
			<path d="M9 3v3" />
			<path d="M15 3v3" />
			<path d="M9 18v3" />
			<path d="M15 18v3" />
			<path d="M3 9h3" />
			<path d="M3 15h3" />
			<path d="M18 9h3" />
			<path d="M18 15h3" />
		</svg>
	);
}

export function IconBranch({ size = 16, ...props }: IconProps) {
	return (
		<svg {...baseProps(size, props)}>
			<circle cx="7" cy="6" r="2" />
			<circle cx="17" cy="8" r="2" />
			<circle cx="7" cy="18" r="2" />
			<path d="M7 8v8" />
			<path d="M17 10a5 5 0 0 1-5 5H7" />
		</svg>
	);
}

export function IconRefresh({ size = 16, ...props }: IconProps) {
	return (
		<svg {...baseProps(size, props)}>
			<path d="M20 5v5h-5" />
			<path d="M19.3 14.5A7.5 7.5 0 1 1 17 6.7L20 10" />
		</svg>
	);
}

export function IconChevron({
	size = 14,
	direction = "right",
	expanded,
	...props
}: IconProps & {
	direction?: "right" | "down" | "left" | "up";
	expanded?: boolean;
}) {
	const resolved = expanded !== undefined ? (expanded ? "down" : "right") : direction;
	const deg =
		resolved === "down" ? 90 : resolved === "left" ? 180 : resolved === "up" ? 270 : 0;
	return (
		<svg
			{...baseProps(size, props)}
			style={{
				transform: deg ? `rotate(${deg}deg)` : undefined,
				transition: "transform 120ms ease",
				...props.style
			}}
		>
			<path d="M9 6l6 6-6 6" />
		</svg>
	);
}

export function IconSidebar({ size = 16, ...props }: IconProps) {
	return (
		<svg {...baseProps(size, props)}>
			<rect x="3" y="4" width="18" height="16" rx="2.5" />
			<path d="M9 4v16" />
		</svg>
	);
}

export function IconBottomDock({ size = 16, ...props }: IconProps) {
	return (
		<svg {...baseProps(size, props)}>
			<rect x="3" y="4" width="18" height="16" rx="2.5" />
			<path d="M3 15h18" />
		</svg>
	);
}

export function IconMinimize({ size = 14, ...props }: IconProps) {
	return (
		<svg {...baseProps(size, props)}>
			<path d="M5 12h14" />
		</svg>
	);
}

export function IconMaximize({ size = 14, ...props }: IconProps) {
	return (
		<svg {...baseProps(size, props)}>
			<rect x="5" y="5" width="14" height="14" rx="1.5" />
		</svg>
	);
}

export function IconExternal({ size = 16, ...props }: IconProps) {
	return (
		<svg {...baseProps(size, props)}>
			<path d="M14 5h5v5" />
			<path d="M19 5l-9 9" />
			<path d="M19 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4" />
		</svg>
	);
}

export function IconCopy({ size = 16, ...props }: IconProps) {
	return (
		<svg {...baseProps(size, props)}>
			<rect x="9" y="9" width="11" height="11" rx="2" />
			<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
		</svg>
	);
}

export function IconMetadata({ size = 16, ...props }: IconProps) {
	return (
		<svg {...baseProps(size, props)}>
			<rect x="4" y="4" width="16" height="16" rx="2.5" />
			<path d="M8 9h8" />
			<path d="M8 13h5" />
			<path d="M8 17h3" />
		</svg>
	);
}

export function IconInfo({ size = 16, ...props }: IconProps) {
	return (
		<svg {...baseProps(size, props)}>
			<circle cx="12" cy="12" r="9" />
			<path d="M12 11v5" />
			<circle cx="12" cy="8" r=".7" fill="currentColor" stroke="none" />
		</svg>
	);
}

export function IconStepOver({ size = 16, ...props }: IconProps) {
	return (
		<svg {...baseProps(size, props)}>
			<path d="M4 13a8 8 0 0 1 15-3" />
			<path d="M16 7l3 3-3 3" />
			<circle cx="12" cy="18" r="2" />
		</svg>
	);
}

export function IconStepInto({ size = 16, ...props }: IconProps) {
	return (
		<svg {...baseProps(size, props)}>
			<path d="M12 4v10" />
			<path d="M8.5 10.5L12 14l3.5-3.5" />
			<circle cx="12" cy="19" r="2" />
		</svg>
	);
}

export function IconStepOut({ size = 16, ...props }: IconProps) {
	return (
		<svg {...baseProps(size, props)}>
			<path d="M12 14V4" />
			<path d="M8.5 7.5L12 4l3.5 3.5" />
			<circle cx="12" cy="19" r="2" />
		</svg>
	);
}

export function IconPause({ size = 16, ...props }: IconProps) {
	return (
		<svg {...baseProps(size, props)}>
			<rect x="7" y="5" width="3.5" height="14" rx="1" fill="currentColor" stroke="none" />
			<rect x="13.5" y="5" width="3.5" height="14" rx="1" fill="currentColor" stroke="none" />
		</svg>
	);
}

export function IconTrash({ size = 16, ...props }: IconProps) {
	return (
		<svg {...baseProps(size, props)}>
			<path d="M4 7h16" />
			<path d="M9 7V4h6v3" />
			<path d="M6 7l1 13h10l1-13" />
		</svg>
	);
}

export function IconEdit({ size = 16, ...props }: IconProps) {
	return (
		<svg {...baseProps(size, props)}>
			<path d="M14 5l5 5-10 10H4v-5z" />
		</svg>
	);
}

export function IconSun({ size = 16, ...props }: IconProps) {
	return (
		<svg {...baseProps(size, props)}>
			<circle cx="12" cy="12" r="4" />
			<path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
		</svg>
	);
}

export function IconMoon({ size = 16, ...props }: IconProps) {
	return (
		<svg {...baseProps(size, props)}>
			<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
		</svg>
	);
}