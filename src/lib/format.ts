// Srpski formati — DESIGN_SYSTEM.md §5/§6: datum dd.MM.yyyy., broj 1.234,56.

const nf = new Intl.NumberFormat('sr-RS');

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** dd.MM.yyyy. HH:mm */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}. ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 1.234.567 (srpsko grupisanje) */
export function formatNumber(n: number): string {
  return nf.format(n);
}

/** Trajanje između dva trenutka, npr. "3 min 12 s". */
export function formatDuration(start: string, end: string | null): string {
  if (!end) return '—';
  const s = Math.round((new Date(end).getTime() - new Date(start).getTime()) / 1000);
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${s % 60} s`;
}
