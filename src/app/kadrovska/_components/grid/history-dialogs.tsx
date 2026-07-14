'use client';

import { useEffect, useMemo, useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { SearchBox } from '@/components/ui-kit/search-box';
import { formatDateTime } from '@/lib/format';
import { fetchGridAudit, type GridAuditRow } from '@/api/kadrovska';
import { describeWorkHoursAuditRow, workHoursAuditValues, fmtYmd, type WhAuditValues } from '@/lib/grid-audit';

function ChangeLines({ row }: { row: GridAuditRow }) {
  const lines = describeWorkHoursAuditRow(row);
  if (!lines.length) return <em className="text-xs text-ink-disabled">bez vidljivih promena</em>;
  return (
    <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-xs text-ink">
      {lines.map((l, i) => (
        <span key={i}>{l}</span>
      ))}
    </div>
  );
}

/** Istorija ćelije (jedan dan) + ↩ Vrati verziju. Port gridHistory.openCellHistoryModal. */
export function CellHistoryDialog({
  open,
  employeeId,
  ymd,
  employeeName,
  editable,
  onRestore,
  onClose,
}: {
  open: boolean;
  employeeId: string;
  ymd: string;
  employeeName: string;
  editable: boolean;
  onRestore: (vals: WhAuditValues) => void;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<GridAuditRow[] | null | undefined>(undefined);

  useEffect(() => {
    if (!open) return;
    setRows(undefined);
    let alive = true;
    fetchGridAudit({ employeeId, from: ymd, to: ymd }).then((r) => alive && setRows(r));
    return () => {
      alive = false;
    };
  }, [open, employeeId, ymd]);

  return (
    <Dialog open={open} onClose={onClose} title={`🕘 Istorija — ${employeeName} · ${fmtYmd(ymd)}`}>
      {rows === undefined ? (
        <p className="py-6 text-center text-sm text-ink-disabled">Učitavanje…</p>
      ) : rows === null ? (
        <p className="py-6 text-center text-sm text-ink-secondary">⚠ Istorija nije dostupna (dozvola/mreža).</p>
      ) : rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-ink-secondary">Nema sačuvanih izmena za ovaj dan.</p>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => (
            <div key={r.id} className="rounded-control border border-line-soft px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <div className="text-2xs text-ink-secondary">
                  <span className="tabular-nums">{formatDateTime(r.changedAt)}</span>
                  <span className="mx-1">·</span>
                  <span>{r.actorEmail || '—'}</span>
                </div>
                {editable && r.action !== 'DELETE' && (
                  <button
                    type="button"
                    className="rounded border border-line px-1.5 py-0.5 text-2xs text-ink-secondary hover:bg-surface-2"
                    title="Vrati vrednosti ove verzije u ćeliju"
                    onClick={() => {
                      onRestore(workHoursAuditValues(r.newData));
                      onClose();
                    }}
                  >
                    ↩ Vrati
                  </button>
                )}
              </div>
              <div className="mt-1">
                <ChangeLines row={r} />
              </div>
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}

/** Istorija meseca (sve izmene, filter po imenu/mejlu). Port gridHistory.openMonthHistoryModal. */
export function MonthHistoryDialog({
  open,
  year,
  month,
  monthLabel,
  nameById,
  onClose,
}: {
  open: boolean;
  year: number;
  month: number;
  monthLabel: string;
  nameById: (empId: string) => string;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<GridAuditRow[] | null | undefined>(undefined);
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');

  useEffect(() => {
    if (!open) return;
    setRows(undefined);
    setQ('');
    setDq('');
    const from = `${year}-${String(month).padStart(2, '0')}-01`;
    const to = `${year}-${String(month).padStart(2, '0')}-${String(new Date(year, month, 0).getDate()).padStart(2, '0')}`;
    let alive = true;
    fetchGridAudit({ from, to }).then((r) => alive && setRows(r));
    return () => {
      alive = false;
    };
  }, [open, year, month]);

  useEffect(() => {
    const t = setTimeout(() => setDq(q.trim().toLowerCase()), 150);
    return () => clearTimeout(t);
  }, [q]);

  const enriched = useMemo(() => (rows || []).map((r) => ({ r, name: nameById(r.employeeId) || '(nepoznat)' })), [rows, nameById]);
  const filtered = useMemo(() => {
    if (!dq) return enriched;
    return enriched.filter((x) => x.name.toLowerCase().includes(dq) || (x.r.actorEmail || '').toLowerCase().includes(dq));
  }, [enriched, dq]);

  return (
    <Dialog open={open} onClose={onClose} title={`🕘 Istorija izmena sati — ${monthLabel}`}>
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <SearchBox value={q} onChange={setQ} placeholder="Filtriraj po radniku ili mejlu…" />
          <span className="text-2xs text-ink-secondary">{filtered.length} stavki</span>
        </div>
        {rows === undefined ? (
          <p className="py-6 text-center text-sm text-ink-disabled">Učitavanje…</p>
        ) : rows === null ? (
          <p className="py-6 text-center text-sm text-ink-secondary">⚠ Istorija nije dostupna (dozvola/mreža).</p>
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-ink-secondary">Nema izmena za ovaj mesec.</p>
        ) : filtered.length === 0 ? (
          <p className="py-6 text-center text-sm text-ink-secondary">Nema stavki za ovaj filter.</p>
        ) : (
          <div className="space-y-1.5">
            {filtered.map(({ r, name }) => (
              <div key={r.id} className="rounded-control border border-line-soft px-3 py-1.5">
                <div className="flex flex-wrap items-center gap-x-2 text-2xs text-ink-secondary">
                  <span className="tabular-nums">{formatDateTime(r.changedAt)}</span>
                  <strong className="text-ink">{name}</strong>
                  <span className="tabular-nums">{r.workDate ? fmtYmd(r.workDate) : '—'}</span>
                  <span>{r.actorEmail || '—'}</span>
                </div>
                <div className="mt-0.5">
                  <ChangeLines row={r} />
                </div>
              </div>
            ))}
            {rows.length >= 300 && <div className="pt-1 text-2xs text-ink-secondary">Prikazano poslednjih 300 izmena — suzi filter po potrebi.</div>}
          </div>
        )}
      </div>
    </Dialog>
  );
}
