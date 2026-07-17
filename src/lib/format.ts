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

/** dd.MM.yyyy. (bez vremena) */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}.`;
}

/** 1.234.567 (srpsko grupisanje) */
export function formatNumber(n: number): string {
  return nf.format(n);
}

/** „pre 2 h", „pre 3 min", „pre 4 dana" — relativna starost (paritet 1.0 formatRelativeAge). */
export function formatRelativeAge(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (sec < 60) return `pre ${sec} s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `pre ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `pre ${h} h`;
  const d = Math.round(h / 24);
  return `pre ${d} dan${d === 1 ? '' : 'a'}`;
}

/** Trajanje između dva trenutka, npr. "3 min 12 s". */
export function formatDuration(start: string, end: string | null): string {
  if (!end) return '—';
  const s = Math.round((new Date(end).getTime() - new Date(start).getTime()) / 1000);
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${s % 60} s`;
}
