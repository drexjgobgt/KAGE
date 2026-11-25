import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

/**
 * Geometric diagonal blade/shutter K monogram for KAGE Studio.
 * Matches the FigCraft kage-logo.svg geometry on a 32x32 viewBox.
 */
export function KageLogo({ className = "w-7 h-7", ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
      {...props}
    >
      <rect width="32" height="32" rx="7" fill="#12100E" />
      <rect x="0.75" y="0.75" width="30.5" height="30.5" rx="6.25" stroke="#282320" strokeWidth="1.5" />
      {/* Vertical spine */}
      <path d="M8.5 7.5H12.5V24.5H8.5V7.5Z" fill="#F3ECE4" />
      {/* Upper diagonal blade */}
      <path d="M12.5 16L21.5 7.5H25L15 17.5L12.5 16Z" fill="#E6C29F" />
      {/* Lower diagonal blade */}
      <path d="M14.2 15.8L25 24.5H20.8L12.5 17.5L14.2 15.8Z" fill="#E6C29F" />
      {/* Crimson REC shutter dot */}
      <circle cx="24" cy="16" r="2.2" fill="#E5484D" />
    </svg>
  );
}

export function IconStudio({ className = "w-4 h-4", ...props }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true" {...props}>
      <circle cx="10" cy="10" r="7" />
      <circle cx="10" cy="10" r="2.5" fill="currentColor" stroke="none" />
      <path d="M10 3v2M10 15v2M3 10h2M15 10h2" />
    </svg>
  );
}

export function IconLibrary({ className = "w-4 h-4", ...props }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true" {...props}>
      <rect x="3" y="4" width="6" height="5" rx="1" />
      <rect x="11" y="4" width="6" height="5" rx="1" />
      <rect x="3" y="11" width="6" height="5" rx="1" />
      <rect x="11" y="11" width="6" height="5" rx="1" />
    </svg>
  );
}

export function IconProfiles({ className = "w-4 h-4", ...props }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true" {...props}>
      <path d="M4 6h12M4 10h12M4 14h12" />
      <circle cx="7" cy="6" r="1.5" fill="currentColor" />
      <circle cx="13" cy="10" r="1.5" fill="currentColor" />
      <circle cx="8" cy="14" r="1.5" fill="currentColor" />
    </svg>
  );
}

export function IconTelemetry({ className = "w-4 h-4", ...props }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true" {...props}>
      <path d="M3 11.5h3l2-5.5 3.2 8.5 2.3-4.5H17" />
    </svg>
  );
}

export function IconSettings({ className = "w-4 h-4", ...props }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true" {...props}>
      <circle cx="10" cy="10" r="2.75" />
      <path d="M10 3v1.8M10 15.2V17M3 10h1.8M15.2 10H17M5.05 5.05l1.27 1.27M13.68 13.68l1.27 1.27M14.95 5.05l-1.27 1.27M6.32 13.68l-1.27 1.27" />
    </svg>
  );
}

export function IconFolder({ className = "w-4 h-4", ...props }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true" {...props}>
      <path d="M3 6a1.5 1.5 0 0 1 1.5-1.5h3.2l1.6 1.8h6.2A1.5 1.5 0 0 1 17 7.8v6.7a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5V6Z" />
    </svg>
  );
}

export function IconSave({ className = "w-4 h-4", ...props }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true" {...props}>
      <path d="M10 3.5v8.5m0 0-3-3m3 3 3-3" />
      <path d="M4 13.5v1.8A1.2 1.2 0 0 0 5.2 16.5h9.6a1.2 1.2 0 0 0 1.2-1.2v-1.8" />
    </svg>
  );
}

export function IconRecordDot({ className = "w-3.5 h-3.5", ...props }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true" {...props}>
      <circle cx="8" cy="8" r="5" fill="currentColor" />
    </svg>
  );
}

export function IconStopSquare({ className = "w-3.5 h-3.5", ...props }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true" {...props}>
      <rect x="4" y="4" width="8" height="8" rx="1.2" fill="currentColor" />
    </svg>
  );
}

export function IconPlay({ className = "w-4 h-4", ...props }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true" {...props}>
      <path d="M6.5 4.8 15.2 10l-8.7 5.2V4.8Z" fill="currentColor" />
    </svg>
  );
}

export function IconPause({ className = "w-4 h-4", ...props }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true" {...props}>
      <rect x="5.5" y="4.5" width="3" height="11" rx="0.8" fill="currentColor" />
      <rect x="11.5" y="4.5" width="3" height="11" rx="0.8" fill="currentColor" />
    </svg>
  );
}

export function IconScissors({ className = "w-4 h-4", ...props }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true" {...props}>
      <circle cx="6" cy="6" r="2.2" />
      <circle cx="6" cy="14" r="2.2" />
      <path d="M7.8 7.5 16 14M16 6l-8.2 6.5" />
    </svg>
  );
}

export function IconCopy({ className = "w-4 h-4", ...props }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true" {...props}>
      <rect x="7" y="7" width="9" height="9" rx="1.5" />
      <path d="M13 7V5.5A1.5 1.5 0 0 0 11.5 4h-6A1.5 1.5 0 0 0 4 5.5v6A1.5 1.5 0 0 0 5.5 13H7" />
    </svg>
  );
}

export function IconTrash({ className = "w-4 h-4", ...props }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true" {...props}>
      <path d="M4.5 6h11M8 6V4.2h4V6m-5.5 0 .7 9.6a1.2 1.2 0 0 0 1.2 1.1h3.2a1.2 1.2 0 0 0 1.2-1.1L13.5 6" />
    </svg>
  );
}

export function IconStar({ filled = false, className = "w-4 h-4", ...props }: IconProps & { filled?: boolean }) {
  return (
    <svg viewBox="0 0 20 20" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true" {...props}>
      <path d="m10 3.2 2.1 4.26 4.7.68-3.4 3.31.8 4.68L10 13.9l-4.2 2.23.8-4.68-3.4-3.31 4.7-.68L10 3.2Z" />
    </svg>
  );
}

export function IconVolume({ muted = false, className = "w-4 h-4", ...props }: IconProps & { muted?: boolean }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true" {...props}>
      <path d="M4 8.2v3.6h3l3.8 3.2V5L7 8.2H4Z" />
      {muted ? (
        <path d="m13.5 8 3 4m0-4-3 4" />
      ) : (
        <path d="M13.5 7.4a4.2 4.2 0 0 1 0 5.2M15.6 5.5a6.8 6.8 0 0 1 0 9" />
      )}
    </svg>
  );
}

export function IconMic({ muted = false, className = "w-4 h-4", ...props }: IconProps & { muted?: boolean }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true" {...props}>
      <rect x="7.5" y="3.2" width="5" height="8.5" rx="2.5" />
      <path d="M5 10a5 5 0 0 0 10 0M10 15v2" />
      {muted && <path d="m4.5 4.5 11 11" />}
    </svg>
  );
}

export function IconSearch({ className = "w-4 h-4", ...props }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true" {...props}>
      <circle cx="9" cy="9" r="5.2" />
      <path d="m13 13 3.8 3.8" />
    </svg>
  );
}

export function IconClose({ className = "w-4 h-4", ...props }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true" {...props}>
      <path d="m5.5 5.5 9 9m0-9-9 9" />
    </svg>
  );
}

export function IconMinimize({ className = "w-3.5 h-3.5", ...props }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className={className} aria-hidden="true" {...props}>
      <path d="M3.5 8.5h9" />
    </svg>
  );
}

export function IconMaximize({ className = "w-3.5 h-3.5", ...props }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" className={className} aria-hidden="true" {...props}>
      <rect x="3.5" y="3.5" width="9" height="9" rx="1" />
    </svg>
  );
}

export function IconCamera({ className = "w-4 h-4", ...props }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true" {...props}>
      <path d="M4 6.5h2.2l1.2-1.8h5.2l1.2 1.8H16A1.5 1.5 0 0 1 17.5 8v6.5A1.5 1.5 0 0 1 16 16H4a1.5 1.5 0 0 1-1.5-1.5V8A1.5 1.5 0 0 1 4 6.5Z" />
      <circle cx="10" cy="11" r="2.6" />
    </svg>
  );
}

export function IconExternal({ className = "w-4 h-4", ...props }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true" {...props}>
      <path d="M11 4h5v5M16 4l-7 7M8.5 5.5H5.5A1.5 1.5 0 0 0 4 7v7.5A1.5 1.5 0 0 0 5.5 16H13a1.5 1.5 0 0 0 1.5-1.5v-3" />
    </svg>
  );
}

export function IconCheck({ className = "w-3.5 h-3.5", ...props }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true" {...props}>
      <path d="M3.5 8.2 6.5 11.2 12.5 4.8" />
    </svg>
  );
}

export function IconPlus({ className = "w-4 h-4", ...props }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" className={className} aria-hidden="true" {...props}>
      <path d="M10 4.5v11M4.5 10h11" />
    </svg>
  );
}

export function IconTag({ className = "w-4 h-4", ...props }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true" {...props}>
      <path d="M3.5 10.2V4.8A1.3 1.3 0 0 1 4.8 3.5h5.4l6.3 6.3a1.5 1.5 0 0 1 0 2.1l-4.6 4.6a1.5 1.5 0 0 1-2.1 0l-6.3-6.3Z" />
      <circle cx="7" cy="7" r="1" fill="currentColor" />
    </svg>
  );
}

export function IconRefresh({ className = "w-4 h-4", ...props }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true" {...props}>
      <path d="M16 10a6 6 0 1 1-1.76-4.24L16 7.5" />
      <path d="M16 3.5v4h-4" />
    </svg>
  );
}

export function IconShield({ className = "w-4 h-4", ...props }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true" {...props}>
      <path d="M10 3.2 4.5 5.4v4.4c0 3.7 2.4 6.2 5.5 7 3.1-.8 5.5-3.3 5.5-7V5.4L10 3.2Z" />
    </svg>
  );
}

export function IconMonitor({ className = "w-4 h-4", ...props }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true" {...props}>
      <rect x="3" y="4" width="14" height="9.5" rx="1.4" />
      <path d="M7.5 16.5h5M10 13.5v3" />
    </svg>
  );
}
