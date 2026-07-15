'use client';

import { useMemo, useState } from 'react';
import { Check, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { ComboBox } from '@/components/ui-kit/combo-box';
import { usePositions, type Position } from '@/api/part-locations';
import { formatNumber } from '@/lib/format';
import { cn } from '@/lib/cn';

/**
 * Panel ZAVRŠNE KONTROLE (BarKodUnos2024 ekrani 5–7): broj iskontrolisanih komada +
 * kvalitet (Dobar/Dorada/Škart) + raspored po policama. 🔴 Zbir po policama MORA biti
 * jednak broju komada (ProveriDefinisneKolicine). „Završi i štampaj" zove kontrolu i
 * štampa nalepnicu (RNZ) po komadu. P1: Dorada/Škart se knjiži, child RN je P2.
 */

const QUALITY = [
  { id: 0, label: 'Dobar', cls: 'border-status-success text-status-success' },
  { id: 1, label: 'Dorada', cls: 'border-status-warn text-status-warn' },
  { id: 2, label: 'Škart', cls: 'border-status-danger text-status-danger' },
] as const;

interface LocRow {
  position: Position | null;
  quantity: number;
}

export interface ControlSubmit {
  pieceCount: number;
  qualityTypeId: number;
  locations: { positionId: number; quantity: number }[];
  note?: string;
}

export function ControlPanel({
  operationLabel,
  planned,
  busy,
  onSubmit,
}: {
  operationLabel: string;
  planned: number | null;
  busy: boolean;
  onSubmit: (input: ControlSubmit) => void;
}) {
  const [pieces, setPieces] = useState(planned && planned > 0 ? planned : 1);
  const [qualityTypeId, setQualityTypeId] = useState(0);
  const [rows, setRows] = useState<LocRow[]>([{ position: null, quantity: planned && planned > 0 ? planned : 1 }]);

  const allocated = useMemo(
    () => rows.reduce((s, r) => s + (Number.isFinite(r.quantity) ? r.quantity : 0), 0),
    [rows],
  );
  const rowsValid = rows.length > 0 && rows.every((r) => r.position && r.quantity >= 1);
  const sumMatches = allocated === pieces;
  const canSubmit = !busy && pieces >= 1 && rowsValid && sumMatches;
  const overPlan = planned != null && pieces > planned;

  const setRow = (i: number, patch: Partial<LocRow>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const addRow = () => setRows((rs) => [...rs, { position: null, quantity: Math.max(0, pieces - allocated) }]);
  const removeRow = (i: number) => setRows((rs) => (rs.length > 1 ? rs.filter((_, j) => j !== i) : rs));

  const submit = () => {
    if (!canSubmit) return;
    onSubmit({
      pieceCount: pieces,
      qualityTypeId,
      locations: rows.map((r) => ({ positionId: r.position!.id, quantity: r.quantity })),
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-panel border-2 border-accent/50 bg-accent-subtle px-5 py-4">
        <div>
          <div className="text-sm font-semibold uppercase tracking-wide text-accent">Završna kontrola</div>
          <div className="mt-0.5 text-3xl font-bold text-ink">{operationLabel}</div>
        </div>
        <div className="tnums text-lg text-ink-secondary">
          Potrebno: <span className="font-semibold text-ink">{planned != null ? formatNumber(planned) : '—'}</span> kom
        </div>
      </div>

      {/* Broj iskontrolisanih komada */}
      <div>
        <div className="mb-2 text-lg font-semibold uppercase tracking-wide text-ink-secondary">
          Broj iskontrolisanih komada
        </div>
        <input
          type="number"
          min={1}
          inputMode="numeric"
          value={pieces || ''}
          disabled={busy}
          onChange={(e) => {
            const n = Math.floor(Number(e.target.value));
            setPieces(Number.isFinite(n) && n > 0 ? n : 0);
          }}
          aria-label="Broj iskontrolisanih komada"
          className="tnums h-20 w-full rounded-panel border-2 border-line bg-surface text-center text-5xl font-bold text-ink focus-visible:border-accent focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none disabled:opacity-50"
        />
        {overPlan && (
          <p className="mt-2 text-lg font-semibold text-status-danger">
            Više od planiranog ({formatNumber(planned!)}) — kontrola neće proći.
          </p>
        )}
      </div>

      {/* Kvalitet */}
      <div>
        <div className="mb-2 text-lg font-semibold uppercase tracking-wide text-ink-secondary">Kvalitet</div>
        <div className="grid grid-cols-3 gap-3">
          {QUALITY.map((q) => (
            <button
              key={q.id}
              type="button"
              disabled={busy}
              onClick={() => setQualityTypeId(q.id)}
              aria-pressed={qualityTypeId === q.id}
              className={cn(
                'h-16 rounded-panel border-2 text-xl font-bold transition-colors disabled:opacity-50',
                qualityTypeId === q.id ? cn(q.cls, 'bg-surface') : 'border-line text-ink-secondary hover:bg-surface-2',
              )}
            >
              {q.label}
            </button>
          ))}
        </div>
        {qualityTypeId !== 0 && (
          <p className="mt-2 text-base text-ink-secondary">
            {qualityTypeId === 1 ? 'Dorada' : 'Škart'} se evidentira i knjiži na lokaciju; automatski nalog
            za {qualityTypeId === 1 ? 'doradu' : 'škart'} (−D/−S) stiže u sledećoj fazi.
          </p>
        )}
      </div>

      {/* Raspored po policama */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-lg font-semibold uppercase tracking-wide text-ink-secondary">
            Lokacija delova (police)
          </span>
          <span
            className={cn(
              'tnums rounded-full px-3 py-1 text-base font-semibold',
              sumMatches ? 'bg-status-success-bg text-status-success' : 'bg-status-warn-bg text-status-warn',
            )}
          >
            Raspoređeno {formatNumber(allocated)} / {formatNumber(pieces)}
          </span>
        </div>
        <div className="space-y-3">
          {rows.map((row, i) => (
            <div key={i} className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <ComboBox<Position>
                  value={row.position}
                  onChange={(p) => setRow(i, { position: p })}
                  useSearch={(q) => usePositions({ q })}
                  getKey={(p) => p.id}
                  getLabel={(p) => p.positionCode}
                  getSublabel={(p) => p.description ?? ''}
                  placeholder="Polica / pozicija…"
                />
              </div>
              <input
                type="number"
                min={1}
                inputMode="numeric"
                value={row.quantity || ''}
                disabled={busy}
                onChange={(e) => {
                  const n = Math.floor(Number(e.target.value));
                  setRow(i, { quantity: Number.isFinite(n) && n > 0 ? n : 0 });
                }}
                aria-label={`Količina na poziciji ${i + 1}`}
                className="tnums h-12 w-28 shrink-0 rounded-control border-2 border-line bg-surface text-center text-xl font-semibold text-ink focus-visible:border-accent focus-visible:outline-none disabled:opacity-50"
              />
              <button
                type="button"
                disabled={busy || rows.length <= 1}
                onClick={() => removeRow(i)}
                aria-label="Ukloni policu"
                className="grid h-12 w-12 shrink-0 place-items-center rounded-control border border-line text-ink-secondary hover:bg-surface-2 disabled:opacity-30"
              >
                <Trash2 className="h-5 w-5" aria-hidden />
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={addRow}
          className="mt-3 inline-flex h-11 items-center gap-2 rounded-control border border-line px-4 text-base font-semibold text-ink hover:bg-surface-2 disabled:opacity-50"
        >
          <Plus className="h-5 w-5" aria-hidden />
          Dodaj policu
        </button>
      </div>

      <Button
        variant="primary"
        loading={busy}
        disabled={!canSubmit}
        onClick={submit}
        className="h-20 w-full gap-3 text-2xl font-bold"
      >
        <Check className="h-7 w-7" aria-hidden />
        Završi kontrolu
      </Button>
      {!sumMatches && rowsValid && (
        <p className="text-center text-lg font-semibold text-status-warn">
          Zbir po policama ({formatNumber(allocated)}) mora biti jednak broju komada ({formatNumber(pieces)}).
        </p>
      )}
    </div>
  );
}
