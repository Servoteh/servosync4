import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';

/** Domenski statusi Reversi dokumenata/stavki → ton + srpska labela (paritet 1.0). */
const DOC_STATUS: Record<string, { tone: Tone; label: string }> = {
  OPEN: { tone: 'info', label: 'Otvoren' },
  PARTIALLY_RETURNED: { tone: 'warn', label: 'Delimično vraćen' },
  RETURNED: { tone: 'success', label: 'Vraćen' },
};

const LINE_STATUS: Record<string, { tone: Tone; label: string }> = {
  ISSUED: { tone: 'info', label: 'Zaduženo' },
  RETURNED: { tone: 'success', label: 'Vraćeno' },
  CONSUMED: { tone: 'neutral', label: 'Potrošeno' },
};

export const DOC_TYPE_LABEL: Record<string, string> = {
  TOOL: 'Alat',
  COOPERATION_GOODS: 'Kooperacija',
  CUTTING_TOOL: 'Rezni alat',
};

export function DocStatusBadge({ status }: { status: string }) {
  const s = DOC_STATUS[status] ?? { tone: 'neutral' as Tone, label: status };
  return <StatusBadge tone={s.tone} label={s.label} />;
}

export function LineStatusBadge({ status }: { status: string }) {
  const s = LINE_STATUS[status] ?? { tone: 'neutral' as Tone, label: status };
  return <StatusBadge tone={s.tone} label={s.label} />;
}
