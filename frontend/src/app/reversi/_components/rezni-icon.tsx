/**
 * RB-61 — ikonica „Rezni alat" (silueta glodala / obradnog tela, mašinska obrada —
 * namerno NIJE makaze). Paritet 1.0 `revMachiningIcon.js#ICON_REZNI_MACHINING`.
 * Koristi `currentColor`; veličina preko `className`/`size`.
 */
export function RezniAlatIcon({
  className,
  size = 16,
}: {
  className?: string;
  size?: number;
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="12" y1="3" x2="12" y2="10" />
      <path d="M8.5 10.5h7a1.5 1.5 0 011.2 2.4l-3.2 9.6a1.5 1.5 0 01-2.8 0l-3.2-9.6a1.5 1.5 0 011.1-2.4z" />
      <path d="M10.5 14.5h3M11 18h2" opacity="0.45" />
    </svg>
  );
}
