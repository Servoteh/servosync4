import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';

/**
 * Sadržaj `empty` slota tabele koji razlikuje grešku učitavanja od stvarno
 * praznog skupa. Bez ovoga (uz globalni `retry:false`) neuspeo fetch izgleda kao
 * „nema podataka" — obmanjujuće (npr. „Magacin je prazan" magacioneru).
 */
export function tableEmpty(isError: boolean, title: string, hint: string) {
  if (isError) {
    return (
      <EmptyState
        title="Greška pri učitavanju"
        hint="Podaci trenutno nisu dostupni. Osveži stranicu ili pokušaj ponovo."
      />
    );
  }
  return <EmptyState title={title} hint={hint} />;
}

/**
 * Domenski statusi Reversi dokumenata/stavki → ton + srpska labela (paritet 1.0
 * `revDocStatusPillHtml`). R4-PAR-01 — tekst + ton usklađeni sa 1.0 (i sa CSV
 * `CSV_STATUS_LABEL`): OPEN='Aktivno' zeleno (rev-status-pill--ok), PARTIALLY='Delimično
 * vraćeno' žuto, RETURNED='Vraćeno' zeleno, CANCELLED='Otkazano' neutralno.
 */
const DOC_STATUS: Record<string, { tone: Tone; label: string }> = {
  OPEN: { tone: 'success', label: 'Aktivno' },
  PARTIALLY_RETURNED: { tone: 'warn', label: 'Delimično vraćeno' },
  RETURNED: { tone: 'success', label: 'Vraćeno' },
  CANCELLED: { tone: 'neutral', label: 'Otkazano' },
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
