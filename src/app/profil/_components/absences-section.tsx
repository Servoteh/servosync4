'use client';

import { CalendarDays } from 'lucide-react';
import { formatDate } from '@/lib/format';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { useAbsences } from '@/api/moj-profil';
import { Section } from './section';

/**
 * Moja odsustva — paritet 1.0 `_absencesTableHtml` (mojProfil/index.js).
 * Tabela odsustava tekuće godine (tip badge / Od / Do / Dana / Napomena). Read-only.
 */

const ABS_TYPE_LABELS: Record<string, string> = {
  godisnji: 'Godišnji odmor',
  bolovanje: 'Bolovanje',
  sluzbeno: 'Službeni put',
  slava: 'Krsna slava',
  placeno: 'Plaćeno odsustvo',
  neplaceno: 'Neplaćeno odsustvo',
  slobodan: 'Slobodan dan',
  ostalo: 'Ostalo',
};

const ABS_TYPE_TONE: Record<string, Tone> = {
  godisnji: 'success',
  bolovanje: 'danger',
  sluzbeno: 'info',
  slava: 'warn',
  placeno: 'info',
  neplaceno: 'neutral',
  slobodan: 'neutral',
  ostalo: 'neutral',
};

function daysInclusive(from: string, to: string): number {
  const a = new Date(`${from.slice(0, 10)}T00:00:00`);
  const b = new Date(`${to.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0;
  return Math.round((b.getTime() - a.getTime()) / 86400000) + 1;
}

export function AbsencesSection() {
  const q = useAbsences();
  const rows = q.data?.data ?? [];
  const year = new Date().getFullYear();

  return (
    <Section icon={<CalendarDays className="h-4 w-4 text-ink-secondary" />} title="Moja odsustva">
      {q.isLoading ? (
        <p className="text-sm text-ink-disabled">Učitavanje…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-ink-disabled">Nema odsustava za {year}. godinu.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-2xs uppercase text-ink-secondary">
                <th className="py-1.5">Tip</th>
                <th className="py-1.5">Od</th>
                <th className="py-1.5">Do</th>
                <th className="py-1.5">Dana</th>
                <th className="py-1.5">Napomena</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a, i) => {
                const days = a.days_count != null ? a.days_count : daysInclusive(a.date_from, a.date_to);
                return (
                  <tr key={i} className="border-b border-line-soft">
                    <td className="py-1.5">
                      <StatusBadge tone={ABS_TYPE_TONE[a.type] ?? 'neutral'} label={ABS_TYPE_LABELS[a.type] ?? a.type} />
                    </td>
                    <td className="py-1.5 tnums">{a.date_from ? formatDate(a.date_from) : '—'}</td>
                    <td className="py-1.5 tnums">{a.date_to ? formatDate(a.date_to) : '—'}</td>
                    <td className="py-1.5 tnums font-semibold">{days}</td>
                    <td className="py-1.5 text-ink-secondary">{a.note || '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}
