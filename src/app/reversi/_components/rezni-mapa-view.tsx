'use client';

import { useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { formatNumber } from '@/lib/format';
import {
  useCuttingByMachineAll,
  useCuttingTools,
  useReversiDocuments,
  useReversiMachines,
  type CuttingTool,
  type MachineRow,
} from '@/api/reversi';
import {
  computeAgingBuckets,
  computeLowStockTop10,
  computeMachineLoadCards,
  type AgingBuckets,
  type MachineLoadDoc,
} from '@/lib/reversi-mapa-compute';
import { MachineCardDialog } from './machine-card-dialog';

/** SVG donut „Aging zaduženja" (RA-48) — 3 segmenta (paritet 1.0 `renderDonutSvg`). */
function AgingDonut({ buckets }: { buckets: AgingBuckets }) {
  const total = buckets.total || 0;
  const r = 42;
  const c = 2 * Math.PI * r;
  const segs = [
    { n: buckets.fresh, cls: 'text-status-success' },
    { n: buckets.aging, cls: 'text-status-warn' },
    { n: buckets.overdue, cls: 'text-status-danger' },
  ];
  let offset = 0;
  return (
    <svg className="h-32 w-32 shrink-0" viewBox="0 0 100 100" role="img" aria-label="Aging zaduženja">
      <circle cx="50" cy="50" r={r} fill="none" strokeWidth="14" className="text-line" stroke="currentColor" opacity={0.25} />
      {segs.map((s, i) => {
        const len = total > 0 ? (s.n / total) * c : 0;
        const el = (
          <circle
            key={i}
            className={s.cls}
            cx="50"
            cy="50"
            r={r}
            fill="none"
            stroke="currentColor"
            strokeWidth="14"
            strokeDasharray={`${len} ${c - len}`}
            strokeDashoffset={-offset}
            transform="rotate(-90 50 50)"
          />
        );
        offset += len;
        return el;
      })}
      <text x="50" y="54" textAnchor="middle" className="fill-ink text-lg font-semibold">
        {total}
      </text>
    </svg>
  );
}

/** Kompaktan pregled rezne šifre (RA-49 klik) — magacionerski pregled iz kataloga. */
function CuttingMiniDialog({ tool, onClose }: { tool: CuttingTool; onClose: () => void }) {
  return (
    <Dialog
      open
      onClose={onClose}
      title={`${tool.oznaka} — ${tool.naziv}`}
      footer={
        <Button variant="secondary" onClick={onClose}>
          Zatvori
        </Button>
      }
    >
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
        <Field label="Status">
          <StatusBadge tone="info" label="Rezni alat" />
        </Field>
        <Field label="Barkod">{tool.barcode ?? '—'}</Field>
        <Field label="Jedinica">{tool.unit || 'kom'}</Field>
        <Field label="Min. zaliha">{formatNumber(Number(tool.minStockQty) || 0)}</Field>
        <Field label="U magacinu">
          <span className="tnums">
            {formatNumber(tool.inWarehouseQty)} {tool.unit || 'kom'}
          </span>
        </Field>
        <Field label="Na mašinama">
          <span className="tnums">{formatNumber(tool.onMachinesQty)}</span>
        </Field>
        <Field label="Ukupno">
          <span className="tnums">
            {formatNumber(tool.onHandQty)} {tool.unit || 'kom'}
          </span>
        </Field>
        <Field label="Mašine">{tool.compatibleMachineCodes.join(', ') || '—'}</Field>
        {tool.napomena && (
          <div className="col-span-2">
            <div className="text-xs text-ink-secondary">Napomena</div>
            <div className="text-ink">{tool.napomena}</div>
          </div>
        )}
      </div>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-ink-secondary">{label}</div>
      <div className="text-ink">{children}</div>
    </div>
  );
}

/**
 * Reversi rezni — pod-pogled „Mapa" (grafički pregled, paritet 1.0 `revMapaSubview.js`):
 * mreža kartica mašina sa popunjenošću (RA-47), donut „Aging zaduženja" (RA-48),
 * „Top 10 niskih stanja" (RA-49) i baner o neučitanim sekcijama (RA-50). Sva agregacija
 * je klijentska iz 4 upita (zaduženja po mašinama / dokumenti / katalog / mašine).
 */
export function RezniMapaView() {
  const cuttingByMachine = useCuttingByMachineAll();
  const docs = useReversiDocuments({ statuses: 'OPEN,PARTIALLY_RETURNED', page: 1, pageSize: 500 });
  const catalog = useCuttingTools('');
  const machines = useReversiMachines();

  const [openMachine, setOpenMachine] = useState<MachineRow | null>(null);
  const [openTool, setOpenTool] = useState<CuttingTool | null>(null);

  const cuttingRows = cuttingByMachine.data?.data ?? [];
  const docRows = docs.data?.data ?? [];
  const catalogRows = useMemo<CuttingTool[]>(() => catalog.data?.data ?? [], [catalog.data]);
  const machineRows = machines.data?.data ?? [];

  // RA-50 — ok:false ≠ prazno: prijavi koje sekcije nisu učitane umesto tihe prazne mape.
  const failedSections: string[] = [];
  if (cuttingByMachine.isError) failedSections.push('zaduženja po mašinama');
  if (docs.isError) failedSections.push('dokumenti');
  if (catalog.isError) failedSections.push('katalog');
  if (machines.isError) failedSections.push('mašine');

  const isLoading =
    cuttingByMachine.isLoading || docs.isLoading || catalog.isLoading || machines.isLoading;

  const cards = useMemo(() => {
    const machineDocs: MachineLoadDoc[] = [];
    for (const r of cuttingRows) {
      machineDocs.push({ machineCode: r.machine_code, catalogId: r.catalog_id, expectedReturnDate: null });
    }
    for (const d of docRows) {
      // Dokument nosi samo rok (overdue); šifre broji ISKLJUČIVO v_rev_cts_by_machine
      // (doc UUID kao catalogId bi duplo brojao alat) — paritet 1.0.
      if (d.docType === 'CUTTING_TOOL' && d.recipientMachineCode) {
        machineDocs.push({ machineCode: d.recipientMachineCode, expectedReturnDate: d.expectedReturnDate });
      }
    }
    return computeMachineLoadCards(machineDocs, machineRows);
  }, [cuttingRows, docRows, machineRows]);

  const aging = useMemo(
    () =>
      computeAgingBuckets(
        docRows
          .filter((d) => d.docType === 'CUTTING_TOOL' || d.docType === 'TOOL')
          .map((d) => ({ issuedAt: d.issuedAt, expectedReturnDate: d.expectedReturnDate })),
      ),
    [docRows],
  );

  const lowStock = useMemo(() => computeLowStockTop10(catalogRows), [catalogRows]);

  function openMachineCard(code: string) {
    const found = machineRows.find((m) => m.machine_code === code);
    setOpenMachine(
      found ?? {
        machine_code: code,
        name: cards.find((c) => c.machineCode === code)?.machineName ?? '',
        type: null,
        manufacturer: null,
        model: null,
        location: null,
        tracked: null,
        archived_at: null,
      },
    );
  }

  if (isLoading && failedSections.length === 0) {
    return <p className="text-sm text-ink-secondary">Učitavanje mape…</p>;
  }

  return (
    <div className="space-y-5">
      {failedSections.length > 0 && (
        <div className="flex items-start gap-2 rounded-panel border border-status-warn/40 bg-status-warn-bg px-4 py-3 text-sm text-ink">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-status-warn" aria-hidden />
          <span>
            Deo podataka nije učitan ({failedSections.join(', ')}) — prikaz je nepotpun. Osveži stranicu.
          </span>
        </div>
      )}

      {/* RA-47 — mreža kartica mašina */}
      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-ink">Mapa mašina</h3>
        {cards.length === 0 ? (
          <p className="text-sm text-ink-secondary">Nema aktivnih zaduženja po mašinama.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {cards.map((card) => (
              <article
                key={card.machineCode}
                tabIndex={0}
                role="button"
                onClick={() => openMachineCard(card.machineCode)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openMachineCard(card.machineCode);
                  }
                }}
                className="cursor-pointer rounded-panel border border-line bg-surface p-3 transition-colors hover:border-accent hover:bg-surface-2"
              >
                <div className="tnums text-sm font-semibold text-ink">{card.machineCode}</div>
                <div className="truncate text-2xs text-ink-secondary">{card.machineName || '—'}</div>
                <div className="mt-1 text-xs text-ink-secondary">{formatNumber(card.symbolCount)} šifri</div>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-2" aria-hidden>
                  <span
                    className="block h-full rounded-full bg-accent"
                    style={{ width: `${card.fillPct}%` }}
                  />
                </div>
                <div className="mt-1 flex items-center justify-between">
                  <span className="tnums text-2xs text-ink-secondary">{card.fillPct}%</span>
                  {card.overdueCount > 0 && (
                    <span className="rounded-full bg-status-danger-bg px-1.5 py-0.5 text-2xs text-status-danger">
                      + {card.overdueCount} prekoračena
                    </span>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {/* RA-48 — donut Aging zaduženja */}
      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-ink">Aging zaduženja</h3>
        <div className="flex items-center gap-5 rounded-panel border border-line bg-surface p-4">
          <AgingDonut buckets={aging} />
          <ul className="space-y-1.5 text-sm">
            <li className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full bg-status-success" aria-hidden />
              Sveže (≤7 d) — <span className="tnums font-medium">{aging.fresh}</span>
            </li>
            <li className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full bg-status-warn" aria-hidden />
              Stari (8–30 d) — <span className="tnums font-medium">{aging.aging}</span>
            </li>
            <li className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full bg-status-danger" aria-hidden />
              Prekoračeni — <span className="tnums font-medium">{aging.overdue}</span>
            </li>
          </ul>
        </div>
      </section>

      {/* RA-49 — Top 10 niskih stanja */}
      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-ink">Top 10 niskih stanja</h3>
        {lowStock.length === 0 ? (
          <p className="text-sm text-ink-secondary">Nema šifara ispod minimuma.</p>
        ) : (
          <ul className="divide-y divide-line rounded-panel border border-line bg-surface">
            {lowStock.map((row) => {
              const pct = row.min > 0 ? Math.min(100, Math.round((row.qty / row.min) * 100)) : 0;
              return (
                <li
                  key={row.id}
                  tabIndex={0}
                  role="button"
                  onClick={() => {
                    const t = catalogRows.find((c) => c.id === row.id);
                    if (t) setOpenTool(t);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      const t = catalogRows.find((c) => c.id === row.id);
                      if (t) setOpenTool(t);
                    }
                  }}
                  className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-surface-2"
                >
                  <span className="min-w-0 flex-1 truncate text-sm">
                    <span className="font-medium">{row.oznaka}</span>
                    <span className="text-ink-secondary"> — {row.naziv}</span>
                  </span>
                  <span className="hidden h-1.5 w-28 overflow-hidden rounded-full bg-surface-2 sm:block" aria-hidden>
                    <span className="block h-full rounded-full bg-status-warn" style={{ width: `${pct}%` }} />
                  </span>
                  <span className="tnums w-16 shrink-0 text-right text-sm text-ink-secondary">
                    {formatNumber(row.qty)}/{formatNumber(row.min)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <MachineCardDialog machine={openMachine} onClose={() => setOpenMachine(null)} />
      {openTool && <CuttingMiniDialog tool={openTool} onClose={() => setOpenTool(null)} />}
    </div>
  );
}
