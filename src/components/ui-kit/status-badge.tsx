import { cn } from '@/lib/cn';

/**
 * Kanonska mapa statusa (DESIGN_SYSTEM.md §7). Nova vrsta statusa prvo ulazi
 * ovde, pa tek onda u ekran. Pilula = tačka + tekst, semantička boja iz tokena.
 */
type StatusKey = 'success' | 'partial' | 'failed' | 'running' | 'neutral';

const MAP: Record<StatusKey, { label: string; dot: string; text: string; bg: string }> = {
  success: { label: 'Uspešno', dot: 'bg-status-success', text: 'text-status-success', bg: 'bg-status-success-bg' },
  running: { label: 'U toku', dot: 'bg-status-info', text: 'text-status-info', bg: 'bg-status-info-bg' },
  partial: { label: 'Delimično', dot: 'bg-status-warn', text: 'text-status-warn', bg: 'bg-status-warn-bg' },
  failed: { label: 'Greška', dot: 'bg-status-danger', text: 'text-status-danger', bg: 'bg-status-danger-bg' },
  neutral: { label: 'U pripremi', dot: 'bg-status-neutral', text: 'text-status-neutral', bg: 'bg-status-neutral-bg' },
};

function resolve(status: string): StatusKey {
  return (['success', 'partial', 'failed', 'running'] as const).find((k) => k === status) ?? 'neutral';
}

export function StatusBadge({ status }: { status: string }) {
  const s = MAP[resolve(status)];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium',
        s.bg,
        s.text,
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', s.dot)} aria-hidden />
      {s.label}
    </span>
  );
}
