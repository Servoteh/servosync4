'use client';

import { useMemo, useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { Input, FormField } from '@/components/ui-kit/form-field';
import { usePredmetiLookup } from '@/api/plan-montaze';
import { gridIsoToday, type GridDay } from '@/lib/grid-utils';
import { pushRecentPredmet, type PredmetPick } from './predmet-picker';
import type { GridEmployee } from './grid-table';

export interface TerenEntry {
  empId: string;
  ymd: string;
  hours: number;
  sub: 'domestic' | 'foreign';
  predmetBroj: string | null;
  predmetNaziv: string | null;
}

/** Grupni unos terena (tura za ekipu). Port openGridTerenDialog. */
export function TerenGroupDialog({
  open,
  monthLabel,
  days,
  holidaySet,
  employees,
  preselectEmpId,
  onApply,
  onClose,
}: {
  open: boolean;
  monthLabel: string;
  days: GridDay[];
  holidaySet: Set<string>;
  employees: GridEmployee[];
  preselectEmpId: string | null;
  onApply: (entries: TerenEntry[]) => void;
  onClose: () => void;
}) {
  const minYmd = days[0]?.ymd || '';
  const maxYmd = days[days.length - 1]?.ymd || '';
  const today = gridIsoToday();
  const defYmd = today >= minYmd && today <= maxYmd ? today : minYmd;

  const [selPredmet, setSelPredmet] = useState<PredmetPick | null>(null);
  const [pq, setPq] = useState('');
  const [from, setFrom] = useState(defYmd);
  const [to, setTo] = useState(defYmd);
  const [hours, setHours] = useState('10');
  const [sub, setSub] = useState<'domestic' | 'foreign'>('domestic');
  const [skipWknd, setSkipWknd] = useState(true);
  const [empFilter, setEmpFilter] = useState('');
  const [checked, setChecked] = useState<Set<string>>(() => new Set(preselectEmpId ? [preselectEmpId] : []));

  const search = usePredmetiLookup(pq, true);
  const results = pq ? search.data?.data ?? [] : [];

  const visibleEmployees = useMemo(() => {
    const q = empFilter.trim().toLowerCase();
    return q ? employees.filter((e) => e.name.toLowerCase().includes(q)) : employees;
  }, [employees, empFilter]);

  function toggle(id: string) {
    setChecked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  function apply() {
    const h = parseFloat(hours.replace(',', '.'));
    if (!from || !to || from > to) return alert('⚠ Proveri period (Od ≤ Do).');
    if (from < minYmd || to > maxYmd) return alert('⚠ Period mora biti unutar izabranog meseca.');
    if (!isFinite(h) || h <= 0 || h > 24) return alert('⚠ Sati/dan mora biti 0–24.');
    const empIds = [...checked];
    if (empIds.length === 0) return alert('⚠ Izaberi bar jednog radnika.');

    const broj = selPredmet?.broj || pq.trim() || null;
    const naziv = selPredmet?.naziv || null;
    if (!broj) {
      if (!window.confirm('Teren bez vezanog predmeta — trošak se neće moći pratiti po projektu. Nastaviti?')) return;
    } else if (!selPredmet) {
      pushRecentPredmet({ broj, naziv: naziv || '' });
    }

    const inRange = days.filter((d) => d.ymd >= from && d.ymd <= to && !(skipWknd && (d.isWeekend || holidaySet.has(d.ymd))));
    if (inRange.length === 0) return alert('⚠ Nema dana u izabranom periodu (filter vikenda?).');

    const entries: TerenEntry[] = [];
    for (const id of empIds) for (const d of inRange) entries.push({ empId: id, ymd: d.ymd, hours: h, sub, predmetBroj: broj, predmetNaziv: naziv });
    onApply(entries);
    onClose();
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`🚐 Grupni unos terena — ${monthLabel}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Otkaži
          </Button>
          <Button variant="primary" onClick={apply}>
            Upiši u grid
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-xs text-ink-secondary">Upisuje u Teren red grida; snima se tek na „Sačuvaj izmene". Dani sa odsustvom se preskaču.</p>

        <FormField label="Predmet (kucaj broj/naziv — može i ručno)">
          {selPredmet ? (
            <div className="flex items-center gap-2 rounded-control border border-line bg-surface-2 px-2 py-1.5 text-sm">
              <code className="rounded bg-surface px-1 text-ink">{selPredmet.broj}</code>
              <span className="truncate text-ink">{selPredmet.naziv}</span>
              <button type="button" className="ml-auto text-ink-secondary hover:text-status-danger" onClick={() => setSelPredmet(null)}>
                ✕
              </button>
            </div>
          ) : (
            <>
              <Input value={pq} onChange={(e) => setPq(e.target.value)} placeholder="Broj ili naziv predmeta…" />
              {results.length > 0 && (
                <div className="mt-1 max-h-40 overflow-auto rounded-control border border-line-soft">
                  {results.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      className="flex w-full items-baseline gap-2 px-3 py-1.5 text-left hover:bg-surface-2"
                      onClick={() => {
                        setSelPredmet({ broj: r.broj_predmeta, naziv: r.naziv_predmeta || '' });
                        setPq('');
                      }}
                    >
                      <code className="rounded bg-surface-2 px-1 text-xs text-ink">{r.broj_predmeta}</code>
                      <span className="truncate text-sm text-ink">{r.naziv_predmeta}</span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </FormField>

        <div className="grid grid-cols-2 gap-3">
          <FormField label="Od">
            <Input type="date" value={from} min={minYmd} max={maxYmd} onChange={(e) => setFrom(e.target.value)} />
          </FormField>
          <FormField label="Do">
            <Input type="date" value={to} min={minYmd} max={maxYmd} onChange={(e) => setTo(e.target.value)} />
          </FormField>
          <FormField label="Sati/dan">
            <Input type="number" min={0.5} max={24} step={0.5} value={hours} onChange={(e) => setHours(e.target.value)} />
          </FormField>
          <FormField label="Tip">
            <select
              value={sub}
              onChange={(e) => setSub(e.target.value as 'domestic' | 'foreign')}
              className="h-9 w-full rounded-control border border-line bg-surface px-3 text-base text-ink"
            >
              <option value="domestic">D — domaći</option>
              <option value="foreign">I — inostrani</option>
            </select>
          </FormField>
        </div>

        <label className="flex items-center gap-2 text-sm text-ink">
          <input type="checkbox" checked={skipWknd} onChange={(e) => setSkipWknd(e.target.checked)} /> Preskoči vikend/praznik
        </label>

        <div>
          <div className="mb-1 flex items-center gap-2">
            <Input value={empFilter} onChange={(e) => setEmpFilter(e.target.value)} placeholder="Filtriraj radnike…" className="h-8" />
            <Button variant="secondary" className="h-8 px-2 text-xs" onClick={() => setChecked(new Set(visibleEmployees.map((e) => e.id)))}>
              Svi
            </Button>
            <Button variant="secondary" className="h-8 px-2 text-xs" onClick={() => setChecked(new Set())}>
              Nijedan
            </Button>
            <span className="ml-auto text-2xs text-ink-secondary">{checked.size} izabrano</span>
          </div>
          <div className="max-h-48 space-y-0.5 overflow-auto rounded-control border border-line-soft p-1">
            {visibleEmployees.map((e) => (
              <label key={e.id} className="flex items-center gap-2 rounded px-1.5 py-0.5 text-sm hover:bg-surface-2">
                <input type="checkbox" checked={checked.has(e.id)} onChange={() => toggle(e.id)} />
                <span className="text-ink">{e.name}</span>
                {e.deptSub && <em className="ml-auto text-2xs not-italic text-ink-disabled">{e.deptSub}</em>}
              </label>
            ))}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
