'use client';

import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { fmtYmd } from '@/lib/grid-audit';

export interface SaveChange {
  empName: string;
  ymd: string;
  lines: string[];
}

const MAX_ROWS = 250;

/** Potvrda unosa pre batch save-a (staro → novo, grupisano po radniku). Port gridSaveConfirm. */
export function SaveConfirmDialog({
  open,
  monthLabel,
  monthLocked,
  warnings,
  changes,
  unchangedCount,
  totalCells,
  onConfirm,
  onClose,
}: {
  open: boolean;
  monthLabel: string;
  monthLocked: boolean;
  warnings: string[];
  changes: SaveChange[];
  unchangedCount: number;
  totalCells: number;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const empCount = new Set(changes.map((c) => c.empName)).size;
  const shown = changes.slice(0, MAX_ROWS);
  const meta: string[] = [`${totalCells} ćelija`, `${empCount} ${empCount === 1 ? 'radnik' : 'radnika'}`];
  if (unchangedCount && changes.length) meta.push(`${unchangedCount} bez stvarne promene`);

  let lastEmp = '';

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Potvrda unosa — ${monthLabel}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Nazad
          </Button>
          <Button variant={monthLocked ? 'danger' : 'primary'} onClick={onConfirm} autoFocus>
            {monthLocked ? 'Sačuvaj u zaključan mesec' : 'Potvrdi i sačuvaj'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-xs text-ink-secondary">Proveri šta će biti upisano (staro → novo). Ništa se ne snima dok ne potvrdiš.</p>

        {monthLocked && (
          <div className="rounded-control border border-status-danger/40 bg-status-danger-bg px-3 py-2 text-xs text-status-danger">
            ⚠ Mesec je zaključan (obračun isplaćen) — snimaš izmene u zaključan mesec.
          </div>
        )}

        {warnings.length > 0 && (
          <div className="rounded-control border border-status-warn/40 bg-status-warn-bg px-3 py-2 text-xs text-status-warn">
            <div className="font-semibold">{warnings.length === 1 ? '1 upozorenje' : `${warnings.length} upozorenja`}</div>
            <ul className="mt-1 space-y-0.5">
              {warnings.slice(0, 8).map((w, i) => (
                <li key={i}>• {w}</li>
              ))}
              {warnings.length > 8 && <li>… i još {warnings.length - 8}</li>}
            </ul>
          </div>
        )}

        {changes.length === 0 ? (
          <p className="rounded-control border border-dashed border-line bg-surface-2 px-3 py-4 text-center text-sm text-ink-secondary">
            Nema stvarnih promena — vrednosti su iste kao u bazi{totalCells ? ` (${totalCells} ćelija)` : ''}.
          </p>
        ) : (
          <div className="max-h-72 space-y-1 overflow-auto rounded-control border border-line-soft p-2">
            {shown.map((c, i) => {
              const showHeader = c.empName !== lastEmp;
              lastEmp = c.empName;
              return (
                <div key={i}>
                  {showHeader && <div className="mt-1.5 text-xs font-semibold text-ink">{c.empName}</div>}
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 pl-2 text-xs">
                    <span className="tabular-nums text-ink-secondary">{fmtYmd(c.ymd)}</span>
                    {c.lines.map((ln, j) => (
                      <span key={j} className="text-ink">
                        {ln}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
            {changes.length > MAX_ROWS && (
              <div className="pt-1 text-xs text-ink-secondary">… i još {changes.length - MAX_ROWS} izmena (sve će biti sačuvane)</div>
            )}
          </div>
        )}

        <p className="text-xs text-ink-secondary">{meta.join(' · ')}</p>
      </div>
    </Dialog>
  );
}
