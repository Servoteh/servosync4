'use client';

import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { useGanttOverlay, type GanttRow } from '@/api/plan-proizvodnje';
import { Button } from '@/components/ui-kit/button';
import { Dialog } from '@/components/ui-kit/dialog';
import { formatDate } from '@/lib/format';
import { effectiveMinutes, isoDay, toIsoAtWorkStart } from './gant-utils';

/**
 * „Dodaj na plan" (zahtev 046/26) — iz liste operacija KOJE NISU na gantu postavi se
 * planirani početak; kraj se izvodi iz trajanja (override ili TPZ + TK × kom). Tek time
 * stavka dobija bar na osi (`planned_start_at IS NOT NULL`).
 *
 * Ne dira ručni redosled smene (`shift_sort_order`) — gant je paralelan pogled.
 */
export function DodajNaPlanDialog({
  open,
  onClose,
  rows,
  defaultDay,
}: {
  open: boolean;
  onClose: () => void;
  rows: GanttRow[];
  defaultDay: Date;
}) {
  const save = useGanttOverlay();
  const [day, setDay] = useState(() => isoDay(defaultDay));
  const [q, setQ] = useState('');
  const [added, setAdded] = useState<Set<string>>(new Set());

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    const base = t
      ? rows.filter((r) =>
          [r.rn_ident_broj, r.broj_crteza, r.naziv_dela, r.effective_machine_code]
            .some((v) => String(v ?? '').toLowerCase().includes(t)),
        )
      : rows;
    return base.slice(0, 300);
  }, [rows, q]);

  function add(r: GanttRow) {
    const startIso = toIsoAtWorkStart(day);
    const min = effectiveMinutes(r);
    save.mutate(
      {
        workOrderId: r.work_order_id,
        lineId: r.line_id,
        plannedStartAt: startIso,
        plannedEndAt: new Date(new Date(startIso).getTime() + (min > 0 ? min : 24 * 60) * 60_000).toISOString(),
      },
      { onSuccess: () => setAdded((s) => new Set(s).add(`${r.work_order_id}:${r.line_id}`)) },
    );
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Dodaj stavke na plan"
      size="xl"
      footer={
        <div className="ml-auto">
          <Button onClick={onClose}>Gotovo</Button>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs text-ink-secondary">Termin (početak)</label>
          <input
            type="date"
            value={day}
            onChange={(e) => setDay(e.target.value)}
            className="h-9 rounded-control border border-line bg-surface px-2 text-sm text-ink"
          />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Traži po RN / crtežu / nazivu / mašini"
            aria-label="Pretraga stavki"
            className="h-9 flex-1 rounded-control border border-line bg-surface px-2 text-sm text-ink placeholder:text-ink-disabled"
          />
        </div>

        <div className="max-h-[55vh] overflow-auto rounded-panel border border-line">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-surface-2 text-2xs uppercase tracking-wider text-ink-secondary">
              <tr>
                <th className="px-3 py-1.5 text-left">RN</th>
                <th className="px-3 py-1.5 text-left">Pozicija</th>
                <th className="px-3 py-1.5 text-left">Operacija</th>
                <th className="px-3 py-1.5 text-left">Mašina</th>
                <th className="px-3 py-1.5 text-right">Kom</th>
                <th className="px-3 py-1.5 text-right">Trajanje</th>
                <th className="px-3 py-1.5 text-left">Rok</th>
                <th className="px-3 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const key = `${r.work_order_id}:${r.line_id}`;
                const min = effectiveMinutes(r);
                return (
                  <tr key={key} className="border-b border-line-soft">
                    <td className="tnums px-3 py-1.5">{r.rn_ident_broj ?? '—'}</td>
                    <td className="max-w-[16rem] truncate px-3 py-1.5" title={r.naziv_dela ?? ''}>
                      {r.naziv_dela ?? r.broj_crteza ?? '—'}
                    </td>
                    <td className="px-3 py-1.5">
                      {String(r.operacija ?? '—')} · {r.opis_rada ?? '—'}
                    </td>
                    <td className="px-3 py-1.5">{r.effective_machine_code ?? '—'}</td>
                    <td className="tnums px-3 py-1.5 text-right">{r.komada_total ?? 0}</td>
                    <td className="tnums px-3 py-1.5 text-right">{min} min</td>
                    <td className="px-3 py-1.5">{r.rok_izrade ? formatDate(r.rok_izrade) : '—'}</td>
                    <td className="px-3 py-1.5 text-right">
                      {added.has(key) ? (
                        <span className="text-2xs text-status-success">✓ na planu</span>
                      ) : (
                        <Button variant="secondary" className="h-7 px-2 text-xs" onClick={() => add(r)}>
                          <Plus className="h-3.5 w-3.5" aria-hidden /> Dodaj
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-3 py-8 text-center text-sm text-ink-disabled">
                    Sve stavke su već na planu (ili filter ne daje rezultat).
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <p className="text-2xs text-ink-disabled">
          Prikazano najviše 300 stavki — suzi pretragu ako tražena pozicija nije u listi.
        </p>
      </div>
    </Dialog>
  );
}
