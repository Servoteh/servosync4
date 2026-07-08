import { cn } from '@/lib/cn';

/**
 * Kanonska mapa statusa (DESIGN_SYSTEM.md §7). Pilula = tačka + tekst, semantička
 * boja iz tokena. Koristi se na dva načina:
 *   <StatusBadge status="success" />           — sync statusi (string iz backenda)
 *   <StatusBadge tone="success" label="…" />   — domenski statusi (Završen, Zaključan…)
 */
export type Tone = 'success' | 'info' | 'warn' | 'danger' | 'neutral';

const TONE: Record<Tone, { dot: string; text: string; bg: string }> = {
  success: { dot: 'bg-status-success', text: 'text-status-success', bg: 'bg-status-success-bg' },
  info: { dot: 'bg-status-info', text: 'text-status-info', bg: 'bg-status-info-bg' },
  warn: { dot: 'bg-status-warn', text: 'text-status-warn', bg: 'bg-status-warn-bg' },
  danger: { dot: 'bg-status-danger', text: 'text-status-danger', bg: 'bg-status-danger-bg' },
  neutral: { dot: 'bg-status-neutral', text: 'text-status-neutral', bg: 'bg-status-neutral-bg' },
};

/** Sync run statusi (string iz `bb_sync_log`) → ton + srpski labela. */
const SYNC: Record<string, { tone: Tone; label: string }> = {
  success: { tone: 'success', label: 'Uspešno' },
  running: { tone: 'info', label: 'U toku' },
  partial: { tone: 'warn', label: 'Delimično' },
  failed: { tone: 'danger', label: 'Greška' },
};

type StatusBadgeProps = { status: string } | { tone: Tone; label: string };

export function StatusBadge(props: StatusBadgeProps) {
  const { tone, label } =
    'status' in props
      ? (SYNC[props.status] ?? { tone: 'neutral' as Tone, label: 'U pripremi' })
      : props;
  const t = TONE[tone];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium',
        t.bg,
        t.text,
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', t.dot)} aria-hidden />
      {label}
    </span>
  );
}
