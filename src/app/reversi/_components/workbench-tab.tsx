'use client';

import { useState } from 'react';
import { ClipboardList, Undo2, AlertTriangle, Package, ScanLine } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { formatDate, formatNumber } from '@/lib/format';
import { toast } from '@/lib/toast';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { useGlobalScanner } from '@/lib/reversi-global-scanner';
import {
  fetchOpenHandLine,
  useCuttingTools,
  useReversiDocuments,
  type BarcodeKind,
  type BarcodeResult,
  type CuttingTool,
  type ReversiDocument,
  type ReversiTool,
} from '@/api/reversi';
import { IssueDialog } from './issue-dialog';
import { QuickReturnDialog } from './quick-return-dialog';

/** Primalac dokumenta → labela (paritet 1.0 `recipientLabel`). */
function recipientLabel(d: ReversiDocument): string {
  if (d.recipientEmployeeName) return d.recipientEmployeeName;
  if (d.recipientDepartment) return d.recipientDepartment;
  if (d.recipientCompanyName) return d.recipientCompanyName;
  return '—';
}

/** Dana prekoračenja (>0) za dati rok (paritet 1.0 `daysOverdue`). */
function daysOverdue(expectedReturnDate: string | null): number {
  if (!expectedReturnDate) return 0;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const ret = new Date(expectedReturnDate);
  if (Number.isNaN(ret.getTime())) return 0;
  const diff = Math.floor((today.getTime() - ret.getTime()) / 86400000);
  return diff > 0 ? diff : 0;
}

type IssueEmployee = { id: string; name: string; department: string; isActive: boolean };

/** Rezni katalog zapis (lookups/barcode CUTTING) → `ReversiTool` za IssueDialog (barkod RZN- → CUTTING linija). */
function cuttingRecordToTool(rec: Record<string, unknown>, barcode: string): ReversiTool {
  return {
    id: String(rec.id ?? ''),
    oznaka: String(rec.oznaka ?? ''),
    naziv: String(rec.naziv ?? ''),
    serijskiBroj: null,
    barcode: String(rec.barcode ?? barcode),
    status: (rec.status as ReversiTool['status']) ?? 'active',
    isQuantity: false,
    isConsumable: false,
    totalQty: 0,
    subgroupId: (rec.subgroupId as string | null) ?? null,
    napomena: (rec.napomena as string | null) ?? null,
  };
}

interface UrgentItem {
  key: string;
  kind: 'overdue' | 'low_stock';
  title: string;
  detail: string;
}

/**
 * Reversi — „Radni sto" (workbench, paritet 1.0 `workbenchTab.js`): default ekran
 * magacionera. Tri celine:
 *   1. Hero — dva velika dugmeta „Izdaj alat" / „Vrati alat" (RA-42), manage-gejtovana.
 *   2. Urgentno — do 5 stavki: prekoračeni dokumenti pa niska stanja reznog (RA-43).
 *   3. Aktivni dokumenti — pregled 6 + „Svi dokumenti…" (navigacija na tab Zaduženja).
 * Globalni HID skener (RA-46): kartica radnika → Izdaj sa preselektovanim radnikom;
 * ručni alat sa otvorenom linijom → brzi povraćaj; inače → Izdaj sa preselektovanim
 * alatom; rezni → Izdaj; nepoznat → toast.
 */
export function WorkbenchTab({ onNavigate }: { onNavigate: (tab: 'dokumenti') => void }) {
  const { can } = useAuth();
  const manage = can(PERMISSIONS.REVERSI_MANAGE);

  const [issueOpen, setIssueOpen] = useState(false);
  const [issueTool, setIssueTool] = useState<ReversiTool | null>(null);
  const [issueEmployee, setIssueEmployee] = useState<IssueEmployee | null>(null);
  const [returnOpen, setReturnOpen] = useState(false);
  const [returnCode, setReturnCode] = useState<string | undefined>(undefined);
  const [returnKind, setReturnKind] = useState<BarcodeKind | undefined>(undefined);

  const overdue = useReversiDocuments({ overdue: true, page: 1, pageSize: 10 });
  const active = useReversiDocuments({ statuses: 'OPEN,PARTIALLY_RETURNED', page: 1, pageSize: 6 });
  const cutting = useCuttingTools('');

  function openIssue(opts?: { tool?: ReversiTool | null; employee?: IssueEmployee | null }) {
    setIssueTool(opts?.tool ?? null);
    setIssueEmployee(opts?.employee ?? null);
    setReturnOpen(false);
    setIssueOpen(true);
  }
  function openReturn(code?: string, kind?: BarcodeKind) {
    setReturnCode(code);
    setReturnKind(kind);
    setIssueOpen(false);
    setReturnOpen(true);
  }

  // RA-46 — globalni skener rutira po tipu barkoda (enable dok je manage; shouldIgnore
  // u hooku ćuti dok je otvoren bilo koji modal, uklj. dijaloge koje sam otvori).
  useGlobalScanner({
    enabled: manage,
    onEmployee: (r: BarcodeResult) => {
      const rec = r.record as { id?: string; full_name?: string; department?: string | null } | null;
      if (!rec?.id) {
        toast('Kartica nije prepoznata');
        return;
      }
      openIssue({
        employee: { id: rec.id, name: rec.full_name ?? '', department: rec.department ?? '', isActive: true },
      });
    },
    onHand: async (r: BarcodeResult) => {
      const rec = r.record as ReversiTool | null;
      if (!rec?.id) {
        toast(`Alat ${r.barcode} nije pronađen`);
        return;
      }
      try {
        const { data } = await fetchOpenHandLine(r.barcode);
        if (data) {
          toast(`${r.barcode} je zadužen — potvrdi povraćaj`);
          openReturn(r.barcode, 'HAND');
          return;
        }
      } catch {
        /* provera nedostupna — padni na izdavanje */
      }
      openIssue({ tool: rec });
    },
    onCutting: (r: BarcodeResult) => {
      const rec = r.record as Record<string, unknown> | null;
      if (!rec?.id) {
        toast(`Rezni alat ${r.barcode} nije pronađen`);
        return;
      }
      openIssue({ tool: cuttingRecordToTool(rec, r.barcode) });
    },
    onUnknown: (r: BarcodeResult) => toast(`Nepoznat barkod: ${r.barcode}`),
  });

  // RA-43 — Urgentno: prvo prekoračeni dokumenti, pa niska stanja reznog, ukupno do 5.
  const overdueRows = overdue.data?.data ?? [];
  const lowStock = (cutting.data?.data ?? []).filter((c: CuttingTool) => {
    const min = Number(c.minStockQty) || 0;
    const qty = Number(c.inWarehouseQty) || 0;
    return c.status === 'active' && min > 0 && qty < min;
  });

  const urgent: UrgentItem[] = [];
  for (const d of overdueRows) {
    urgent.push({
      key: `o-${d.id}`,
      kind: 'overdue',
      title: `${recipientLabel(d)} — ${formatNumber(d.lineCount)} stavki`,
      detail: `Br. ${d.docNumber} · rok ${formatDate(d.expectedReturnDate)} · prekoračeno ${daysOverdue(d.expectedReturnDate)}d`,
    });
    if (urgent.length >= 5) break;
  }
  if (urgent.length < 5) {
    for (const c of lowStock) {
      urgent.push({
        key: `l-${c.id}`,
        kind: 'low_stock',
        title: c.naziv || c.oznaka || '—',
        detail: `Stanje ${formatNumber(Number(c.inWarehouseQty) || 0)} / min ${formatNumber(Number(c.minStockQty) || 0)} · ${c.oznaka}`,
      });
      if (urgent.length >= 5) break;
    }
  }

  const activeRows = active.data?.data ?? [];
  const activeTotal = active.data?.meta.pagination.total ?? activeRows.length;

  return (
    <div className="space-y-4">
      {/* RA-42 — hero dugmad */}
      <section className="grid gap-3 sm:grid-cols-2">
        <button
          type="button"
          disabled={!manage}
          onClick={() => openIssue()}
          className="flex flex-col items-start gap-1 rounded-panel border border-line bg-surface p-5 text-left transition-colors hover:border-accent hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className="grid h-11 w-11 place-items-center rounded-control bg-accent/15 text-accent">
            <ClipboardList className="h-6 w-6" aria-hidden />
          </span>
          <span className="mt-1 text-lg font-semibold text-ink">Izdaj alat</span>
          <span className="text-xs text-ink-secondary">Skener ili ručno · ALAT-… / RZN-…</span>
        </button>
        <button
          type="button"
          disabled={!manage}
          onClick={() => openReturn()}
          className="flex flex-col items-start gap-1 rounded-panel border border-line bg-surface p-5 text-left transition-colors hover:border-accent hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className="grid h-11 w-11 place-items-center rounded-control bg-status-success-bg text-status-success">
            <Undo2 className="h-6 w-6" aria-hidden />
          </span>
          <span className="mt-1 text-lg font-semibold text-ink">Vrati alat</span>
          <span className="text-xs text-ink-secondary">Skener · pronalazi otvoreni revers</span>
        </button>
      </section>

      {/* RA-43 — Urgentno */}
      <section className="rounded-panel border border-line bg-surface p-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink">Urgentno</h2>
          <span className="tnums text-xs text-ink-secondary">{urgent.length}</span>
        </div>
        {overdue.isLoading || cutting.isLoading ? (
          <p className="text-sm text-ink-secondary">Učitavanje…</p>
        ) : urgent.length === 0 ? (
          <p className="text-sm text-ink-secondary">
            Sve je u redu — nema prekoračenih rokova ni niskih zaliha.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {urgent.map((it) => (
              <li key={it.key} className="flex items-start gap-2 rounded-control border border-line bg-surface-2 px-3 py-2">
                <span
                  className={
                    it.kind === 'overdue'
                      ? 'mt-0.5 text-status-danger'
                      : 'mt-0.5 text-status-warn'
                  }
                  aria-hidden
                >
                  {it.kind === 'overdue' ? <AlertTriangle className="h-4 w-4" /> : <Package className="h-4 w-4" />}
                </span>
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-ink">{it.title}</div>
                  <div className="truncate text-2xs text-ink-secondary">{it.detail}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Aktivni dokumenti — pregled + „Svi dokumenti…" */}
      <section className="rounded-panel border border-line bg-surface p-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink">Aktivni dokumenti</h2>
          <Button variant="secondary" onClick={() => onNavigate('dokumenti')}>
            Svi dokumenti…
          </Button>
        </div>
        {active.isLoading ? (
          <p className="text-sm text-ink-secondary">Učitavanje…</p>
        ) : activeRows.length === 0 ? (
          <p className="text-sm text-ink-secondary">Nema otvorenih dokumenata.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-2xs uppercase tracking-wider text-ink-secondary">
                  <th className="py-1.5 pr-3 font-medium">Br.</th>
                  <th className="py-1.5 pr-3 font-medium">Primalac</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Stavki</th>
                  <th className="py-1.5 font-medium">Rok</th>
                </tr>
              </thead>
              <tbody>
                {activeRows.map((d) => (
                  <tr
                    key={d.id}
                    tabIndex={0}
                    role="button"
                    onClick={() => onNavigate('dokumenti')}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onNavigate('dokumenti');
                      }
                    }}
                    className="cursor-pointer border-b border-line/60 last:border-0 hover:bg-surface-2"
                  >
                    <td className="tnums py-1.5 pr-3 font-medium">{d.docNumber}</td>
                    <td className="py-1.5 pr-3">{recipientLabel(d)}</td>
                    <td className="tnums py-1.5 pr-3 text-right text-ink-secondary">{formatNumber(d.lineCount)}</td>
                    <td className="tnums py-1.5 text-ink-secondary">{formatDate(d.expectedReturnDate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {activeTotal > activeRows.length && (
              <p className="mt-2 text-2xs text-ink-secondary">
                Još {formatNumber(activeTotal - activeRows.length)} dokumenata u listi „Svi dokumenti…"
              </p>
            )}
          </div>
        )}
      </section>

      {/* RA-46 — bedž aktivnog skenera */}
      {manage && (
        <div
          aria-live="polite"
          className="inline-flex items-center gap-2 rounded-full border border-line bg-surface-2 px-3 py-1 text-2xs text-ink-secondary"
        >
          <ScanLine className="h-3.5 w-3.5 text-status-success" aria-hidden />
          Skener aktivan — skeniraj karticu ili alat
        </div>
      )}

      {manage && (
        <IssueDialog
          open={issueOpen}
          onClose={() => setIssueOpen(false)}
          initialTool={issueTool}
          initialEmployee={issueEmployee}
          defaultMode="scanner"
        />
      )}
      {returnOpen && (
        <QuickReturnDialog
          onClose={() => setReturnOpen(false)}
          initialCode={returnCode}
          initialKind={returnKind}
        />
      )}
    </div>
  );
}
