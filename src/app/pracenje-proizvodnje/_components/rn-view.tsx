'use client';

import { useMemo, useState } from 'react';
import {
  ArrowLeft,
  Plus,
  Lock,
  Unlock,
  CheckCircle2,
  ArrowUpRight,
  FileText,
  History,
  FileSpreadsheet,
  ArrowRight,
  AlertTriangle,
  Check,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { Tabs, type TabItem } from '@/components/ui-kit/tabs';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { Dialog } from '@/components/ui-kit/dialog';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/format';
import { ApiError } from '@/api/client';
import {
  useRn,
  useOperativniPlan,
  useCanEditRn,
  usePrijave,
  useZatvoriAktivnost,
  useBlokirajAktivnost,
  useOdblokirajAktivnost,
  useAktivnostIstorija,
  fetchCrtezSignUrl,
  AKTIVNOST_STATUS_LABELS,
  type AktivnostRow,
} from '@/api/pracenje';
import { toast } from '@/lib/toast';
import { exportRnTab1Xlsx, exportRnTab2Xlsx } from '@/lib/pracenje-export';
import { logExport } from '@/api/pracenje';
import {
  buildRnTree,
  computeOpChips,
  countLate,
  formatKkQty,
  shortName,
  type OpChip,
  type RnHeader,
  type RnOperacija,
  type RnPozicija,
  type RnSummary,
  type RnTreeNode,
} from '@/lib/pracenje-rn';
import { AktivnostModal } from './aktivnost-modal';
import { PromoteModal } from './promote-modal';

type RnTab = 'pozicije' | 'plan';
const RN_TABS: TabItem<RnTab>[] = [
  { key: 'pozicije', label: 'Pozicije' },
  { key: 'plan', label: 'Operativni plan' },
];

const STATUS_TONE: Record<string, Tone> = {
  nije_krenulo: 'neutral',
  u_toku: 'info',
  blokirano: 'danger',
  zavrseno: 'success',
};

function normalizeAktivnosti(data: unknown): AktivnostRow[] {
  if (Array.isArray(data)) return data as AktivnostRow[];
  if (data && typeof data === 'object') {
    const o = data as { aktivnosti?: unknown; odeljenja?: unknown };
    if (Array.isArray(o.aktivnosti)) return o.aktivnosti as AktivnostRow[];
    if (Array.isArray(o.odeljenja)) {
      const out: AktivnostRow[] = [];
      for (const od of o.odeljenja as Array<{ aktivnosti?: AktivnostRow[] }>) {
        if (Array.isArray(od.aktivnosti)) out.push(...od.aktivnosti);
      }
      return out;
    }
  }
  return [];
}

/** Stil čipa po statusu operacije (1.0 statusFlowClass → tokeni). */
function chipTone(status: string): { border: string; bg: string; text: string; dot: string } {
  switch (status) {
    case 'zavrseno':
      return { border: 'border-status-success', bg: 'bg-status-success-bg', text: 'text-status-success', dot: 'bg-status-success' };
    case 'u_toku':
      return { border: 'border-status-info', bg: 'bg-status-info-bg', text: 'text-status-info', dot: 'bg-status-info' };
    case 'blokirano':
      return { border: 'border-status-danger', bg: 'bg-status-danger-bg', text: 'text-status-danger', dot: 'bg-status-danger' };
    default:
      return { border: 'border-status-neutral', bg: 'bg-status-neutral-bg', text: 'text-status-neutral', dot: 'bg-status-neutral' };
  }
}

function fmtQty(v: unknown): string {
  if (v == null || v === '') return '—';
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : '—';
}

export function RnView({ rnId, onBack }: { rnId: string; onBack: () => void }) {
  const [tab, setTab] = useState<RnTab>('pozicije');
  const rn = useRn(rnId);
  const canEditQ = useCanEditRn(rnId);
  const canEdit = canEditQ.data?.data.canEdit ?? false;

  const result = rn.data?.data;
  const positions = ((result?.positions ?? result?.pozicije ?? []) as unknown as RnPozicija[]);
  const header = ((result?.header ?? result ?? {}) as unknown as RnHeader);
  const summary = ((result?.summary ?? {}) as unknown as RnSummary);
  const source = String(result?.source ?? header.source ?? 'local');

  // Aktivnosti operativnog plana za metriku „Kasni aktivnosti"/„Aktivnosti" u zaglavlju.
  const plan = useOperativniPlan(rnId);
  const aktivnosti = useMemo(() => normalizeAktivnosti(plan.data?.data), [plan.data]);
  // Ukupan broj aktivnosti: dashboard.ukupno ako postoji, inače dužina liste (1.0 pageHeader.js:31).
  const dashUkupno = useMemo(() => {
    const d = plan.data?.data as { dashboard?: { ukupno?: unknown } } | undefined;
    const u = d?.dashboard?.ukupno;
    return u == null ? null : Number(u);
  }, [plan.data]);

  function exportTab1() {
    try {
      exportRnTab1Xlsx({
        header: header as Record<string, unknown>,
        positions: positions as unknown as Array<Record<string, unknown>>,
        summary: summary as Record<string, unknown>,
      });
      logExport({ tab: 'po_pozicijama', rnId, rnBroj: header.rn_broj ? String(header.rn_broj) : undefined }).catch(() => {});
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Excel izvoz nije uspeo.');
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" /> Nazad
        </Button>
        <h2 className="text-md font-semibold text-ink">RN {String(header.rn_broj ?? result?.rn_broj ?? rnId.slice(0, 8))}</h2>
        {source && <StatusBadge tone="neutral" label={source} />}
        <div className="ml-auto">
          <Tabs tabs={RN_TABS} value={tab} onChange={setTab} ariaLabel="RN tabovi" />
        </div>
      </div>

      {/* RN zaglavlje: identifikacija + 5 metrika + KK legenda (PR-03) */}
      <RnHeaderCard header={header} summary={summary} aktivnosti={aktivnosti} dashUkupno={dashUkupno} canEdit={canEdit} />

      {tab === 'pozicije' ? (
        <PozicijeTab positions={positions} loading={rn.isLoading} source={source} onExport={exportTab1} />
      ) : (
        <OperativniPlanTab rnId={rnId} canEdit={canEdit} />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ RN zaglavlje (PR-03)

function RnHeaderCard({
  header,
  summary,
  aktivnosti,
  dashUkupno,
  canEdit,
}: {
  header: RnHeader;
  summary: RnSummary;
  aktivnosti: AktivnostRow[];
  dashUkupno: number | null;
  canEdit: boolean;
}) {
  const totalOps = Number(summary.operacija_total ?? 0);
  const doneOps = Number(summary.zavrseno ?? 0);
  const pct = totalOps > 0 ? Math.round((doneOps / totalOps) * 100) : 0;
  const late = countLate(aktivnosti);
  const kkQty = formatKkQty(summary);
  const rnBroj = String(header.rn_broj ?? 'RN nije učitan');
  const masina = String(header.masina_linija ?? header.radni_nalog_naziv ?? '');

  return (
    <section className="rounded-panel border border-line bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-2xs uppercase tracking-wider text-ink-secondary">Praćenje proizvodnje</div>
          <h3 className="mt-0.5 text-md font-semibold text-ink">
            {rnBroj}
            {masina ? <span className="text-ink-secondary"> · {masina}</span> : null}
          </h3>
          <div className="mt-1 text-xs text-ink-secondary">
            Kupac: <strong className="text-ink">{String(header.kupac ?? '—')}</strong> · Projekat:{' '}
            <strong className="text-ink">{String(header.projekat_naziv ?? header.projekat_id ?? '—')}</strong> · Isporuka:{' '}
            <strong className="text-ink">{header.datum_isporuke ? formatDate(String(header.datum_isporuke)) : '—'}</strong> ·
            Koordinator: <strong className="text-ink">{String(header.koordinator ?? '—')}</strong>
          </div>
          {header.napomena ? <div className="mt-1.5 text-xs text-ink-secondary">Napomena: {String(header.napomena)}</div> : null}
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <HeaderMetric
            label="Završena kol. (KK)"
            value={kkQty}
            sub="kom"
            title="Završena / lansirana količina — broji se ISKLJUČIVO iz završne kontrole (KK). Ovo je „stvarno gotovo komada”."
          />
          <HeaderMetric
            label="Napredak operacija"
            value={`${pct}%`}
            sub={`${doneOps}/${totalOps} op.`}
            title="Procenat završenih operacija po statusu (koliko koraka u redosledu je gotovo). NIJE isto što i gotova količina — operacija može biti „u toku”."
          />
          <HeaderMetric label="Kasni aktivnosti" value={String(late)} title="Broj aktivnosti operativnog plana koje kasne u odnosu na planirani rok." />
          <HeaderMetric label="Aktivnosti" value={String(dashUkupno ?? aktivnosti.length)} title="Ukupan broj aktivnosti operativnog plana za ovaj RN." />
          <HeaderMetric
            label="Pristup"
            value={canEdit ? 'edit' : 'read-only'}
            title={canEdit ? 'Imate prava izmene napomena.' : 'Samo pregled.'}
          />
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 border-t border-line-soft pt-2 text-2xs text-ink-secondary">
        <span>
          <strong className="text-ink">Završena kol. (KK)</strong> = stvarno gotova količina iz završne kontrole (komadi).
        </span>
        <span>
          <strong className="text-ink">Napredak operacija</strong> = % završenih koraka u redosledu (procesni napredak, ne količina).
        </span>
      </div>
    </section>
  );
}

function HeaderMetric({ label, value, sub, title }: { label: string; value: string; sub?: string; title?: string }) {
  return (
    <div className="min-w-[116px] rounded-control border border-line bg-surface-2 px-3 py-2 text-center" title={title}>
      <div className="text-lg font-bold text-ink">{value}</div>
      <div className="text-2xs uppercase tracking-wider text-ink-secondary">{label}</div>
      {sub ? <div className="mt-0.5 text-2xs text-ink-disabled">{sub}</div> : null}
    </div>
  );
}

// ------------------------------------------------------------------ Tab1 — pipeline (PR-04)

function PozicijeTab({
  positions,
  loading,
  source,
  onExport,
}: {
  positions: RnPozicija[];
  loading: boolean;
  source: string;
  onExport: () => void;
}) {
  const [sel, setSel] = useState<{ position: RnPozicija; operation: RnOperacija } | null>(null);
  const tree = useMemo(() => buildRnTree(positions), [positions]);

  if (loading) {
    return <div className="rounded-panel border border-line bg-surface px-4 py-10 text-center text-sm text-ink-secondary">Učitavanje toka proizvodnje…</div>;
  }
  if (positions.length === 0) {
    return (
      <EmptyState
        title="Nema pozicija za izabrani RN"
        hint="Kada backend vrati pozicije (Faza 2 ili BigTehn fallback), ovde se prikazuje tok proizvodnje."
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-4 rounded-panel border border-line bg-surface px-3 py-2">
        <span className="text-xs text-ink-secondary" title={source === 'bigtehn' ? 'Pozicije i prijave se čitaju direktno iz BigTehn keša (nema lokalnih Faza 2 pozicija)' : undefined}>
          Izvor: {source === 'bigtehn' ? 'BigTehn (MES) — read-only' : 'Servosync (Faza 2)'}
        </span>
        <FlowLegend />
        <Button variant="secondary" onClick={onExport} className="ml-auto">
          <FileSpreadsheet className="h-4 w-4" /> Excel export
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_340px]">
        <div className="space-y-3">
          {tree.map((node) => (
            <PositionCard key={String(node.item.id)} node={node} depth={0} onOpenOp={(operation) => setSel({ position: node.item, operation })} />
          ))}
        </div>
        <OperacijaSidePanel sel={sel} onClose={() => setSel(null)} />
      </div>
    </div>
  );
}

function FlowLegend() {
  return (
    <span className="flex flex-wrap items-center gap-3 text-2xs text-ink-secondary" aria-hidden>
      <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-status-success" />Završeno</span>
      <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-status-info" />U toku</span>
      <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-status-neutral" />Čeka</span>
      <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-status-warn" />Usko grlo</span>
      <span className="inline-flex items-center gap-1"><span className="rounded bg-accent-subtle px-1 font-semibold text-accent">ZK</span>završna kontrola</span>
    </span>
  );
}

function PositionCard({ node, depth, onOpenOp }: { node: RnTreeNode; depth: number; onOpenOp: (op: RnOperacija) => void }) {
  const p = node.item;
  const chips = useMemo(() => computeOpChips(p.operations), [p.operations]);
  const pct = Math.max(0, Math.min(100, Number(p.progress_pct ?? 0)));
  const bottleneck = chips.find((c) => c.isBottleneck);
  const indent = Math.min(depth * 22, 88);

  return (
    <>
      <article className="rounded-panel border border-line bg-surface" style={{ marginLeft: indent }}>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line-soft px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="rounded-control bg-surface-2 px-1.5 py-0.5 text-2xs font-semibold text-ink-secondary">
              {String(p.sifra_pozicije ?? p.id ?? '—')}
            </span>
            <span className="truncate text-sm font-medium text-ink">{String(p.naziv ?? '—')}</span>
            <DrawingChip p={p} />
          </div>
          <div className="flex items-center gap-3">
            <span className="text-2xs text-ink-secondary" title="Planirana količina">
              Kol. {fmtQty(p.kolicina_plan)}
            </span>
            {bottleneck ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-status-warn-bg px-2 py-0.5 text-2xs font-medium text-status-warn" title="Trenutno usko grlo">
                <AlertTriangle className="h-3 w-3" />
                {shortName(bottleneck.op.naziv ?? bottleneck.op.operacija_kod ?? '')}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full bg-status-success-bg px-2 py-0.5 text-2xs font-medium text-status-success">
                <Check className="h-3 w-3" /> sve operacije gotove
              </span>
            )}
            <div className="flex items-center gap-1.5" title={`${pct}% operacija`}>
              <div className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-2">
                <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
              </div>
              <span className="text-2xs text-ink-secondary">{pct}%</span>
            </div>
          </div>
        </div>
        {chips.length ? (
          <Pipeline chips={chips} onOpenOp={onOpenOp} />
        ) : (
          <div className="px-3 py-2 text-xs text-ink-disabled">Nema operacija za ovu poziciju.</div>
        )}
      </article>
      {node.children.map((ch) => (
        <PositionCard key={String(ch.item.id)} node={ch} depth={depth + 1} onOpenOp={onOpenOp} />
      ))}
    </>
  );
}

function Pipeline({ chips, onOpenOp }: { chips: OpChip[]; onOpenOp: (op: RnOperacija) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-3 py-2" role="list">
      {chips.map((c, i) => {
        const t = chipTone(c.status);
        const title = [
          c.op.naziv ?? c.op.operacija_kod ?? 'Operacija',
          c.op.work_center ? `RJ ${c.op.work_center}` : '',
          `${fmtQty(c.op.prijavljeno_komada)} / ${fmtQty(c.op.planirano_komada)} (${c.pct}%)`,
          c.isFinal ? 'Završna kontrola (ZK)' : '',
          c.isBottleneck ? 'Usko grlo — trenutni korak' : '',
          c.op.poslednja_prijava_at ? `Poslednja prijava: ${formatDate(String(c.op.poslednja_prijava_at))}` : '',
        ]
          .filter(Boolean)
          .join(' · ');
        return (
          <span key={String(c.op.tp_operacija_id ?? c.idx)} className="inline-flex items-center gap-1.5" role="listitem">
            {i > 0 && <ArrowRight className="h-3 w-3 shrink-0 text-ink-disabled" aria-hidden />}
            <button
              type="button"
              onClick={() => onOpenOp(c.op)}
              title={title}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-control border px-2 py-1 text-left transition-colors hover:brightness-105',
                t.border,
                t.bg,
                c.isBottleneck && 'ring-1 ring-status-warn',
              )}
            >
              <span className={cn('flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-2xs font-semibold text-surface', t.dot)}>
                {c.idx + 1}
              </span>
              <span className="flex flex-col leading-tight">
                <span className={cn('text-2xs font-medium', t.text)}>
                  {shortName(c.op.naziv ?? c.op.operacija_kod ?? '—')}
                  {c.isFinal && <span className="ml-1 rounded bg-accent-subtle px-1 text-2xs font-semibold text-accent">ZK</span>}
                </span>
                <span className="tnums text-2xs text-ink-secondary">
                  {fmtQty(c.op.prijavljeno_komada)} / {fmtQty(c.op.planirano_komada)}
                </span>
              </span>
            </button>
          </span>
        );
      })}
    </div>
  );
}

function DrawingChip({ p }: { p: RnPozicija }) {
  const no = String(p.drawing_no ?? '').trim();
  if (!no) return null;
  const hasFile = p.has_crtez_file !== false;
  async function open() {
    try {
      const res = await fetchCrtezSignUrl(no);
      if (res.data?.url) window.open(res.data.url, '_blank', 'noopener,noreferrer');
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Crtež nije dostupan.');
    }
  }
  if (!hasFile) {
    return (
      <span className="inline-flex items-center gap-1 text-2xs text-ink-disabled" title="Crtež nije u Bridge kešu">
        <FileText className="h-3 w-3" /> {no}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={open}
      className="inline-flex items-center gap-1 rounded-control px-1.5 py-0.5 text-2xs text-accent hover:bg-surface-2"
      title="Otvori crtež u novom tabu"
    >
      <FileText className="h-3 w-3" /> {no}
    </button>
  );
}

// ------------------------------------------------------------------ Side panel PO OPERACIJI (PR-05)

function OperacijaSidePanel({ sel, onClose }: { sel: { position: RnPozicija; operation: RnOperacija } | null; onClose: () => void }) {
  const op = sel?.operation;
  const isBigtehn = op?.source === 'bigtehn';
  // BigTehn izvor: workOrder+op+machine; lokalno: pozicija id (1.0 dvoizvorna grana).
  const prijave = usePrijave(
    op
      ? isBigtehn
        ? {
            workOrder: op.bigtehn_work_order_id != null ? String(op.bigtehn_work_order_id) : undefined,
            op: op.operacija_broj != null ? String(op.operacija_broj) : undefined,
            machine: op.machine_code != null ? String(op.machine_code) : undefined,
          }
        : { pozicija: sel?.position.id != null ? String(sel.position.id) : undefined }
      : {},
  );
  const rows = Array.isArray(prijave.data?.data) ? (prijave.data!.data as Array<Record<string, unknown>>) : [];

  if (!sel || !op) {
    return (
      <div className="rounded-panel border border-line bg-surface p-4 text-sm text-ink-disabled">
        Klikni na operaciju za prijave rada.
      </div>
    );
  }

  const statusTone: Tone = STATUS_TONE[String(op.status ?? 'nije_krenulo')] ?? 'neutral';
  const statusLabel = AKTIVNOST_STATUS_LABELS[String(op.status ?? '')] ?? String(op.status ?? '—');

  return (
    <div className="space-y-3 rounded-panel border border-line bg-surface p-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-ink">
            {String(op.naziv ?? op.operacija_kod ?? 'Operacija')}
            {op.work_center ? <span className="text-ink-secondary"> · {String(op.work_center)}</span> : null}
          </h3>
          <p className="truncate text-2xs text-ink-secondary">
            {String(sel.position.sifra_pozicije ?? '')} {String(sel.position.naziv ?? '')}
          </p>
        </div>
        <button onClick={onClose} className="ml-auto rounded-control p-1 text-ink-secondary hover:bg-surface-2" aria-label="Zatvori">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-control bg-surface-2 px-2 py-1 text-2xs text-ink">
          Planirano: <strong>{fmtQty(op.planirano_komada)}</strong>
        </span>
        <span className="rounded-control bg-surface-2 px-2 py-1 text-2xs text-ink">
          Prijavljeno: <strong>{fmtQty(op.prijavljeno_komada ?? 0)}</strong>
        </span>
        <StatusBadge tone={statusTone} label={statusLabel} />
        {op.is_final_control && <span className="rounded bg-accent-subtle px-1.5 py-0.5 text-2xs font-semibold text-accent">ZK</span>}
      </div>

      <div>
        <div className="mb-1 text-2xs uppercase tracking-wider text-ink-secondary">Prijave rada</div>
        {prijave.isLoading ? (
          <p className="text-xs text-ink-disabled">Učitavanje prijava…</p>
        ) : prijave.isError ? (
          <p className="text-xs text-status-danger">{prijave.error instanceof Error ? prijave.error.message : 'Greška pri učitavanju.'}</p>
        ) : rows.length === 0 ? (
          <p className="text-xs text-ink-disabled">Nema prijava za ovu operaciju.</p>
        ) : (
          <div className="overflow-x-auto rounded-control border border-line">
            <table className="w-full text-2xs">
              <thead>
                <tr className="border-b border-line bg-surface-2 text-left text-ink-secondary">
                  <th className="px-2 py-1">Datum</th>
                  <th className="px-2 py-1">Radnik</th>
                  <th className="px-2 py-1 text-right">Količina</th>
                  <th className="px-2 py-1">Smena</th>
                  <th className="px-2 py-1">Napomena</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className="border-b border-line-soft">
                    <td className="px-2 py-1">{prijavaDatum(r)}</td>
                    <td className="px-2 py-1">{String(r.radnik ?? r.worker_id ?? r.ime ?? '—')}</td>
                    <td className="tnums px-2 py-1 text-right">{String(r.kolicina ?? r.komada ?? r.prijavljeno_komada ?? '')}</td>
                    <td className="px-2 py-1">{String(r.smena ?? '—')}</td>
                    <td className="px-2 py-1">{String(r.napomena ?? '—')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function prijavaDatum(r: Record<string, unknown>): string {
  const v = r.datum ?? r.started_at ?? r.finished_at;
  return v ? formatDate(String(v)) : '—';
}

// ------------------------------------------------------------------ Tab2

function OperativniPlanTab({ rnId, canEdit }: { rnId: string; canEdit: boolean }) {
  const plan = useOperativniPlan(rnId);
  const aktivnosti = useMemo(() => normalizeAktivnosti(plan.data?.data), [plan.data]);

  function exportTab2() {
    try {
      const d = (plan.data?.data ?? {}) as Record<string, unknown>;
      exportRnTab2Xlsx({
        header: (d.header as Record<string, unknown>) ?? undefined,
        activities: aktivnosti as unknown as Array<Record<string, unknown>>,
        dashboard: (d.dashboard as Record<string, unknown>) ?? undefined,
      });
      logExport({ tab: 'operativni_plan', rnId, rnBroj: (d.header as { rn_broj?: string })?.rn_broj }).catch(() => {});
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Excel izvoz nije uspeo.');
    }
  }
  const zatvori = useZatvoriAktivnost();
  const odblokiraj = useOdblokirajAktivnost();
  const [edit, setEdit] = useState<AktivnostRow | null | 'new'>(null);
  const [blokId, setBlokId] = useState<string | null>(null);
  const [promote, setPromote] = useState(false);
  const [histId, setHistId] = useState<string | null>(null);

  const projekatId = aktivnosti.find((a) => a.projekat_id)?.projekat_id as string | undefined;

  const grouped = useMemo(() => {
    const map = new Map<string, AktivnostRow[]>();
    for (const a of aktivnosti) {
      const key = a.odeljenje_naziv ?? a.odeljenje ?? '—';
      const arr = map.get(key) ?? [];
      arr.push(a);
      map.set(key, arr);
    }
    return [...map.entries()];
  }, [aktivnosti]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-ink-secondary">{aktivnosti.length} aktivnosti</span>
        <div className="ml-auto flex gap-2">
          <Button variant="secondary" onClick={exportTab2} disabled={aktivnosti.length === 0}>
            <FileSpreadsheet className="h-4 w-4" /> Excel export
          </Button>
          {canEdit && (
            <>
              <Button variant="secondary" onClick={() => setPromote(true)}>
                <ArrowUpRight className="h-4 w-4" /> Iz Sastanaka
              </Button>
              <Button onClick={() => setEdit('new')}>
                <Plus className="h-4 w-4" /> Nova aktivnost
              </Button>
            </>
          )}
        </div>
      </div>

      {plan.isLoading ? (
        <div className="rounded-panel border border-line bg-surface px-4 py-10 text-center text-sm text-ink-secondary">Učitavanje…</div>
      ) : aktivnosti.length === 0 ? (
        <EmptyState title="Nema aktivnosti u operativnom planu" />
      ) : (
        grouped.map(([odeljenje, list]) => (
          <div key={odeljenje} className="rounded-panel border border-line bg-surface">
            <div className="border-b border-line bg-surface-2 px-3 py-1.5 text-xs font-semibold text-ink">{odeljenje}</div>
            <ul>
              {list.map((a) => (
                <li key={a.id} className={cn('flex flex-wrap items-center gap-2 border-b border-line-soft px-3 py-2', a.kasni && 'bg-status-danger-bg/30')}>
                  <StatusBadge tone={STATUS_TONE[a.status ?? 'nije_krenulo'] ?? 'neutral'} label={AKTIVNOST_STATUS_LABELS[a.status ?? ''] ?? a.status ?? '—'} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-ink">{a.naziv_aktivnosti}</div>
                    <div className="text-xs text-ink-disabled">
                      {a.odgovoran_label ?? a.odgovoran ?? '—'}
                      {a.planirani_zavrsetak ? ` · rok ${formatDate(a.planirani_zavrsetak)}` : ''}
                      {a.broj_tp ? ` · TP ${a.broj_tp}` : ''}
                    </div>
                  </div>
                  <button onClick={() => a.id && setHistId(a.id)} className="rounded-control p-1 text-ink-secondary hover:bg-surface-2" title="Istorija">
                    <History className="h-3.5 w-3.5" />
                  </button>
                  {canEdit && (
                    <div className="flex gap-1">
                      <Button variant="ghost" className="h-8 px-2 text-xs" onClick={() => setEdit(a)}>Izmeni</Button>
                      {a.status === 'blokirano' ? (
                        <Button variant="ghost" className="h-8 px-2 text-xs" onClick={() => a.id && odblokiraj.mutate({ id: a.id })}>
                          <Unlock className="h-3.5 w-3.5" /> Odblokiraj
                        </Button>
                      ) : (
                        <Button variant="ghost" className="h-8 px-2 text-xs" onClick={() => a.id && setBlokId(a.id)}>
                          <Lock className="h-3.5 w-3.5" /> Blokiraj
                        </Button>
                      )}
                      {a.status !== 'zavrseno' && (
                        <Button variant="ghost" className="h-8 px-2 text-xs" onClick={() => a.id && zatvori.mutate({ id: a.id })}>
                          <CheckCircle2 className="h-3.5 w-3.5" /> Zatvori
                        </Button>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))
      )}

      {edit !== null && (
        <AktivnostModal
          open
          onClose={() => setEdit(null)}
          rnId={rnId}
          projekatId={projekatId}
          aktivnost={edit === 'new' ? null : edit}
        />
      )}
      {blokId && <BlokModal id={blokId} onClose={() => setBlokId(null)} />}
      {promote && <PromoteModal rnId={rnId} projekat={projekatId} onClose={() => setPromote(false)} />}
      {histId && <IstorijaModal id={histId} onClose={() => setHistId(null)} />}
    </div>
  );
}

function BlokModal({ id, onClose }: { id: string; onClose: () => void }) {
  const [razlog, setRazlog] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const blokiraj = useBlokirajAktivnost();
  return (
    <Dialog
      open
      onClose={onClose}
      title="Blokiraj aktivnost"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Otkaži</Button>
          <Button
            onClick={async () => {
              if (!razlog.trim()) return setErr('Razlog je obavezan.');
              try {
                await blokiraj.mutateAsync({ id, razlog: razlog.trim() });
                onClose();
              } catch (e) {
                setErr(e instanceof ApiError ? e.message : 'Greška.');
              }
            }}
            loading={blokiraj.isPending}
          >
            Blokiraj
          </Button>
        </>
      }
    >
      <textarea
        value={razlog}
        onChange={(e) => setRazlog(e.target.value)}
        rows={3}
        placeholder="Razlog blokade (obavezno)…"
        className="w-full rounded-control border border-line bg-surface px-3 py-2 text-base text-ink"
      />
      {err && <p className="mt-2 text-sm text-status-danger">{err}</p>}
    </Dialog>
  );
}

function IstorijaModal({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useAktivnostIstorija(id);
  return (
    <Dialog open onClose={onClose} title="Istorija aktivnosti">
      {q.isLoading ? (
        <div className="py-6 text-center text-sm text-ink-secondary">Učitavanje…</div>
      ) : (
        <div className="space-y-3">
          <div>
            <div className="mb-1 text-2xs uppercase tracking-wider text-ink-secondary">Blokade</div>
            {(q.data?.data.blokade ?? []).length === 0 ? (
              <p className="text-xs text-ink-disabled">Nema blokada.</p>
            ) : (
              <ul className="space-y-1 text-xs">
                {(q.data?.data.blokade ?? []).map((b, i) => (
                  <li key={i} className="rounded-control border border-line px-2 py-1">
                    {String((b as Record<string, unknown>).razlog ?? (b as Record<string, unknown>).akcija ?? '—')}
                    {(b as Record<string, unknown>).created_at ? ` · ${formatDate(String((b as Record<string, unknown>).created_at))}` : ''}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <div className="mb-1 text-2xs uppercase tracking-wider text-ink-secondary">Audit (admin)</div>
            {(q.data?.data.audit ?? []).length === 0 ? (
              <p className="text-xs text-ink-disabled">Nema audit zapisa (ili nemate pravo).</p>
            ) : (
              <ul className="space-y-1 text-xs">
                {(q.data?.data.audit ?? []).map((a, i) => (
                  <li key={i} className="rounded-control border border-line px-2 py-1">
                    {String((a as Record<string, unknown>).action ?? '')} · {String((a as Record<string, unknown>).actor_email ?? '')}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}
