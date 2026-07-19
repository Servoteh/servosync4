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
  type Primopredaja,
} from '@/api/pracenje';
import { toast } from '@/lib/toast';
import { openPracenjeDrawingPdf } from '@/lib/pracenje-pdf';
import { exportRnTab1Xlsx, exportRnTab2Xlsx } from '@/lib/pracenje-export';
import { logExport } from '@/api/pracenje';
import {
  buildRnTree,
  computeOpChips,
  countLate,
  filterRnPositions,
  formatKkQty,
  isPozicijeFilterActive,
  shortName,
  EMPTY_POZICIJE_FILTER,
  type OpChip,
  type PozicijeDaNe,
  type PozicijeFilter,
  type RnHeader,
  type RnOperacija,
  type RnPozicija,
  type RnSummary,
  type RnTreeNode,
} from '@/lib/pracenje-rn';
import { AktivnostModal } from './aktivnost-modal';
import { PromoteModal } from './promote-modal';
import { useOperativniFilters, filterActivities, activeFilterChips } from './operativni-filters';

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

/** Prikaz dokumenta primopredaje (docx §4.10): „oznaka · status" ili „—" ako ga nema. */
function formatPrimopredaja(pp: Primopredaja | null | undefined): string {
  if (!pp) return '—';
  const parts = [pp.oznaka, pp.status].filter((s): s is string => s != null && String(s).trim() !== '');
  return parts.length ? parts.join(' · ') : '—';
}

/**
 * Otvori PDF crteža pozicije (docx §4.12, odluka O7 — svi prijavljeni vide crtež). get_pracenje_rn
 * nosi BROJ crteža (`drawing_no`), a stream ruta traži numerički `drawing.id`, pa se broj prvo
 * razreši kroz `crtez/sign` (vraća auth-gated content URL sa id-om), pa se bajtovi povuku deljenim
 * `openPracenjeDrawingPdf` (nosi JWT — `window.open` na tu rutu bi pao bez Authorization header-a).
 */
async function openPositionDrawing(drawingNo: string | null | undefined): Promise<void> {
  const clean = String(drawingNo ?? '').trim();
  if (!clean) return;
  try {
    const res = await fetchCrtezSignUrl(clean);
    const m = /\/crtez\/(\d+)\/pdf/.exec(res.data?.url ?? '');
    if (!m) throw new ApiError(404, `Crtež ${clean} nije pronađen.`);
    await openPracenjeDrawingPdf(Number(m[1]));
  } catch (e) {
    toast(e instanceof Error ? e.message : 'Crtež nije dostupan.');
  }
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

  // „Nazad" u tabelu praćenja predmeta (docx §4.10). RN header nosi projekat_id (== `?predmet=`
  // itemId, O1). Vraćamo se na tabelu predmeta istim SPA ruter obrascem kao page.tsx openPredmet
  // (pushState `?predmet=` + popstate koji page.tsx presreće) — čime se očuva deep-link kontekst.
  // Ako RN nema predmet (direktan ulaz), fallback na prosleđeni onBack (lista aktivnih predmeta).
  const predmetId =
    header.projekat_id != null && String(header.projekat_id).trim() !== '' ? String(header.projekat_id) : null;
  const predmetNaziv = header.projekat_naziv ? String(header.projekat_naziv) : null;
  function handleBack() {
    if (predmetId) {
      window.history.pushState(null, '', `/pracenje-proizvodnje?predmet=${encodeURIComponent(predmetId)}`);
      window.dispatchEvent(new PopStateEvent('popstate'));
    } else {
      onBack();
    }
  }

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
        <Button
          variant="secondary"
          onClick={handleBack}
          title={
            predmetId
              ? `Nazad na tabelu praćenja${predmetNaziv ? `: ${predmetNaziv}` : ''}`
              : 'Nazad na aktivne predmete'
          }
        >
          <ArrowLeft className="h-4 w-4" /> {predmetId ? 'Nazad na tabelu praćenja' : 'Nazad'}
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
            <strong className="text-ink">{String(header.projekat_naziv ?? header.projekat_id ?? '—')}</strong> ·{' '}
            {/* docx §4.10: „rok izrade" izbačen iz RN zaglavlja → dokument primopredaje (ako postoji). */}
            Primopredaja: <strong className="text-ink">{formatPrimopredaja(header.primopredaja)}</strong> · Koordinator:{' '}
            <strong className="text-ink">{String(header.koordinator ?? '—')}</strong>
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
  const [pf, setPf] = useState<PozicijeFilter>(EMPTY_POZICIJE_FILTER);
  const filtered = useMemo(() => filterRnPositions(positions, pf), [positions, pf]);
  const tree = useMemo(() => buildRnTree(filtered), [filtered]);
  const filterActive = isPozicijeFilterActive(pf);

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

      {/* Filteri pozicija (docx §4.10): pretraga · mašinska obrada · površinska zaštita. */}
      <div className="flex flex-wrap items-center gap-2 rounded-panel border border-line bg-surface px-3 py-2">
        <input
          type="search"
          value={pf.search}
          onChange={(e) => setPf((s) => ({ ...s, search: e.target.value }))}
          placeholder="Pretraga pozicije (šifra / naziv / crtež)…"
          className="h-8 w-64 rounded-control border border-line bg-surface px-2 text-sm text-ink placeholder:text-ink-disabled"
        />
        <DaNeFilter label="Maš. obrada" value={pf.masinska} onChange={(v) => setPf((s) => ({ ...s, masinska: v }))} />
        <DaNeFilter label="Površ. zaštita" value={pf.povrsinska} onChange={(v) => setPf((s) => ({ ...s, povrsinska: v }))} />
        {filterActive && (
          <>
            <span className="tnums text-2xs text-ink-secondary">
              {filtered.length} / {positions.length} pozicija
            </span>
            <button
              type="button"
              onClick={() => setPf(EMPTY_POZICIJE_FILTER)}
              className="inline-flex h-8 items-center rounded-control border border-line px-2 text-xs text-ink-secondary hover:bg-surface-2"
            >
              Reset
            </button>
          </>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_340px]">
        <div className="space-y-3">
          {tree.length === 0 ? (
            <EmptyState title="Nema pozicija za izabrane filtere" hint="Ublaži pretragu ili DA/NE filtere." />
          ) : (
            tree.map((node) => (
              <PositionCard key={String(node.item.id)} node={node} depth={0} onOpenOp={(operation) => setSel({ position: node.item, operation })} />
            ))
          )}
        </div>
        <OperacijaSidePanel sel={sel} onClose={() => setSel(null)} />
      </div>
    </div>
  );
}

/** Tri-stanje DA/NE filter (Sve / DA / NE) — docx §4.10 filteri pozicija. */
function DaNeFilter({ label, value, onChange }: { label: string; value: PozicijeDaNe; onChange: (v: PozicijeDaNe) => void }) {
  return (
    <label className="flex items-center gap-1.5 text-2xs uppercase tracking-wider text-ink-secondary">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as PozicijeDaNe)}
        className="h-8 rounded-control border border-line bg-surface px-1.5 text-xs normal-case tracking-normal text-ink"
      >
        <option value="all">Sve</option>
        <option value="da">DA</option>
        <option value="ne">NE</option>
      </select>
    </label>
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
          c.op.completed_at ? `Datum završetka: ${formatDate(String(c.op.completed_at))}` : '',
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
                {/* docx §4.9: datum završetka operacije uz količinu. */}
                {c.op.completed_at ? (
                  <span className="tnums text-2xs text-ink-disabled">{formatDate(String(c.op.completed_at))}</span>
                ) : null}
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
  if (!hasFile) {
    return (
      <span className="inline-flex items-center gap-1 text-2xs text-ink-disabled" title="PDF crteža nije dostupan">
        <FileText className="h-3 w-3" /> {no}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => openPositionDrawing(no)}
      className="inline-flex items-center gap-1 rounded-control px-1.5 py-0.5 text-2xs text-accent hover:bg-surface-2"
      title="Otvori crtež (PDF) u novom tabu"
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
  const drawingNo = String(sel.position.drawing_no ?? '').trim();
  const hasFile = sel.position.has_crtez_file !== false;

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

      {/* docx §4.12: PDF crteža na klik u side panelu (odluka O7 — svi prijavljeni vide crtež). */}
      {drawingNo ? (
        <button
          type="button"
          onClick={() => openPositionDrawing(drawingNo)}
          disabled={!hasFile}
          className="inline-flex items-center gap-1.5 rounded-control border border-line px-2 py-1 text-2xs text-accent hover:bg-surface-2 disabled:cursor-not-allowed disabled:text-ink-disabled disabled:hover:bg-transparent"
          title={hasFile ? 'Otvori crtež (PDF) u novom tabu' : 'PDF crteža nije dostupan'}
        >
          <FileText className="h-3.5 w-3.5" /> Crtež {drawingNo}
        </button>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-control bg-surface-2 px-2 py-1 text-2xs text-ink">
          Planirano: <strong>{fmtQty(op.planirano_komada)}</strong>
        </span>
        <span className="rounded-control bg-surface-2 px-2 py-1 text-2xs text-ink">
          Prijavljeno: <strong>{fmtQty(op.prijavljeno_komada ?? 0)}</strong>
        </span>
        {/* docx §4.9: datum završetka operacije uz količinu. */}
        {op.completed_at ? (
          <span className="rounded-control bg-surface-2 px-2 py-1 text-2xs text-ink">
            Završeno: <strong>{formatDate(String(op.completed_at))}</strong>
          </span>
        ) : null}
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

// ------------------------------------------------------------------ Tab2 (PR-07/08/09/22/24/26)

const PRIORITET_TONE: Record<string, Tone> = { nizak: 'neutral', srednji: 'info', visok: 'danger' };
const PRIORITET_LABEL: Record<string, string> = { nizak: 'Nizak', srednji: 'Srednji', visok: 'Visok' };

interface DashboardData {
  total?: {
    ukupno?: number;
    zavrseno?: number;
    u_toku?: number;
    blokirano?: number;
    nije_krenulo?: number;
    najkasniji_planirani_zavrsetak?: string | null;
  };
  po_odeljenjima?: Array<{
    odeljenje?: string;
    ukupno?: number;
    zavrseno?: number;
    u_toku?: number;
    blokirano?: number;
    najkasniji_planirani_zavrsetak?: string | null;
  }>;
}

function OperativniPlanTab({ rnId, canEdit }: { rnId: string; canEdit: boolean }) {
  const plan = useOperativniPlan(rnId);
  const allAktivnosti = useMemo(() => normalizeAktivnosti(plan.data?.data), [plan.data]);
  const dashboard = ((plan.data?.data as { dashboard?: DashboardData } | undefined)?.dashboard ?? {}) as DashboardData;

  const { filters, set, reset, toggleQuick } = useOperativniFilters(rnId);
  const aktivnosti = useMemo(() => filterActivities(allAktivnosti, filters), [allAktivnosti, filters]);
  const chips = activeFilterChips(filters);

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
  const [zatvoriAkt, setZatvoriAkt] = useState<AktivnostRow | null>(null);
  const [odblokAkt, setOdblokAkt] = useState<AktivnostRow | null>(null);
  const [promote, setPromote] = useState(false);
  const [histId, setHistId] = useState<string | null>(null);
  // GAP-PR-24 — highlight nove/izmenjene aktivnosti 2s po skoku iz sastanka/promote.
  const [highlightId, setHighlightId] = useState<string | null>(null);

  const projekatId = allAktivnosti.find((a) => a.projekat_id)?.projekat_id as string | undefined;

  // Kolekcija naziva odeljenja za multi-select (odeljenja iz lookup-a + iz aktivnosti).
  const deptNames = useMemo(() => {
    const s = new Set<string>();
    for (const a of allAktivnosti) {
      const n = a.odeljenje ?? a.odeljenje_naziv;
      if (n) s.add(String(n));
    }
    return [...s].sort((x, y) => x.localeCompare(y, 'sr'));
  }, [allAktivnosti]);

  const eff = (a: AktivnostRow) => String((a.efektivni_status as string | undefined) || a.status || '');

  return (
    <div className="space-y-3">
      {/* Filter toolbar (PR-07) */}
      <div className="space-y-2 rounded-panel border border-line bg-surface p-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
          <FilterLabel text="Pretraga">
            <input
              type="search"
              value={filters.search}
              onChange={(e) => set('search', e.target.value)}
              placeholder="Naziv, TP, odgovoran…"
              className="h-8 w-full rounded-control border border-line bg-surface px-2 text-sm text-ink"
            />
          </FilterLabel>
          <FilterLabel text="Odeljenja">
            <MultiSelect
              value={filters.odeljenja}
              onChange={(v) => set('odeljenja', v)}
              options={deptNames.map((n) => ({ v: n, label: n }))}
            />
          </FilterLabel>
          <FilterLabel text="Statusi">
            <MultiSelect
              value={filters.statusi}
              onChange={(v) => set('statusi', v)}
              options={Object.entries(AKTIVNOST_STATUS_LABELS).map(([v, label]) => ({ v, label }))}
            />
          </FilterLabel>
          <FilterLabel text="Prioritet">
            <MultiSelect
              value={filters.prioriteti}
              onChange={(v) => set('prioriteti', v)}
              options={[{ v: 'nizak', label: 'Nizak' }, { v: 'srednji', label: 'Srednji' }, { v: 'visok', label: 'Visok' }]}
            />
          </FilterLabel>
          <FilterLabel text="Odgovoran">
            <input
              type="search"
              value={filters.odgovoran}
              onChange={(e) => set('odgovoran', e.target.value)}
              placeholder="Ime…"
              className="h-8 w-full rounded-control border border-line bg-surface px-2 text-sm text-ink"
            />
          </FilterLabel>
          <div className="flex gap-1">
            <FilterLabel text="Rok od">
              <input type="date" value={filters.dateFrom} onChange={(e) => set('dateFrom', e.target.value)} className="h-8 w-full rounded-control border border-line bg-surface px-1 text-2xs text-ink" />
            </FilterLabel>
            <FilterLabel text="Rok do">
              <input type="date" value={filters.dateTo} onChange={(e) => set('dateTo', e.target.value)} className="h-8 w-full rounded-control border border-line bg-surface px-1 text-2xs text-ink" />
            </FilterLabel>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Checkbox label="Samo kasni" checked={filters.onlyLate} onChange={(v) => set('onlyLate', v)} />
          <Checkbox label="Samo blokirano" checked={filters.onlyBlocked} onChange={(v) => set('onlyBlocked', v)} />
          <Checkbox label="Sakrij zatvorene" checked={filters.hideClosed} onChange={(v) => set('hideClosed', v)} />
          <span className="ml-2 text-2xs text-ink-secondary">Quick:</span>
          <QuickChip active={filters.quick === 'visok'} onClick={() => toggleQuick('visok')}>Visok prioritet</QuickChip>
          <QuickChip active={filters.quick === 'kasni7'} onClick={() => toggleQuick('kasni7')}>Kasni &gt; 7 dana</QuickChip>
          <QuickChip active={filters.quick === 'bez_odgovornog'} onClick={() => toggleQuick('bez_odgovornog')}>Bez odgovornog</QuickChip>
          <button type="button" onClick={reset} className="ml-auto inline-flex h-8 items-center rounded-control border border-line px-2 text-xs text-ink-secondary hover:bg-surface-2">
            Reset
          </button>
        </div>
        {chips.length > 0 && (
          <div className="flex flex-wrap gap-1 text-2xs text-ink-secondary">
            {chips.map((c) => (
              <span key={c} className="rounded-full bg-surface-2 px-2 py-0.5">{c}</span>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-ink-secondary">
          {aktivnosti.length}{allAktivnosti.length !== aktivnosti.length ? ` / ${allAktivnosti.length}` : ''} aktivnosti
        </span>
        {!canEdit && (
          <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-2xs text-ink-secondary" title="Nemate pravo izmene">
            <Lock className="h-3 w-3" /> read-only
          </span>
        )}
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
        <EmptyState title={allAktivnosti.length > 0 ? 'Nema rezultata za filtere' : 'Nema aktivnosti u operativnom planu'} />
      ) : (
        <div className="overflow-x-auto rounded-panel border border-line bg-surface">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-surface-2 text-left text-2xs uppercase tracking-wider text-ink-secondary">
                <th className="px-2 py-1.5">RB</th>
                <th className="px-2 py-1.5">Odeljenje</th>
                <th className="px-2 py-1.5">Aktivnost</th>
                <th className="px-2 py-1.5">Br. TP</th>
                <th className="px-2 py-1.5">Količina</th>
                <th className="px-2 py-1.5">Plan. početak</th>
                <th className="px-2 py-1.5">Plan. završetak</th>
                <th className="px-2 py-1.5">Odgovoran</th>
                <th className="px-2 py-1.5">Zavisi od</th>
                <th className="px-2 py-1.5">Status</th>
                <th className="px-2 py-1.5">Prioritet</th>
                <th className="px-2 py-1.5">Rizik</th>
                <th className="px-2 py-1.5 text-right">Rezerva</th>
                <th className="px-2 py-1.5">Kasni</th>
                <th className="px-2 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {aktivnosti.map((a) => (
                <tr
                  key={a.id}
                  className={cn(
                    'border-b border-line-soft align-top hover:bg-surface-2',
                    a.kasni && 'bg-status-danger-bg/20',
                    highlightId && a.id === highlightId && 'ring-2 ring-inset ring-accent',
                  )}
                >
                  <td className="tnums px-2 py-1.5">{a.rb ?? ''}</td>
                  <td className="px-2 py-1.5 text-xs">{a.odeljenje ?? a.odeljenje_naziv ?? '—'}</td>
                  <td className="px-2 py-1.5">
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium text-ink">{a.naziv_aktivnosti ?? '—'}</span>
                      {a.izvor === 'iz_sastanka' && a.izvor_akcioni_plan_id ? (
                        <button
                          type="button"
                          onClick={() => jumpToSastanak(String(a.izvor_akcioni_plan_id))}
                          className="inline-flex items-center gap-0.5 rounded-full bg-accent-subtle px-1.5 py-0.5 text-2xs font-medium text-accent hover:underline"
                          title="Otvori akcionu tačku u Sastancima"
                        >
                          ↔ Iz sastanka
                        </button>
                      ) : null}
                    </div>
                    {a.opis ? <div className="text-2xs text-ink-disabled">{a.opis}</div> : null}
                  </td>
                  <td className="px-2 py-1.5 text-xs">{a.broj_tp ?? '—'}</td>
                  <td className="px-2 py-1.5 text-xs">{a.kolicina_text ?? '—'}</td>
                  <td className="px-2 py-1.5 text-xs">{a.planirani_pocetak ? formatDate(a.planirani_pocetak) : '—'}</td>
                  <td className="px-2 py-1.5 text-xs">{a.planirani_zavrsetak ? formatDate(a.planirani_zavrsetak) : '—'}</td>
                  <td className="px-2 py-1.5 text-xs">{a.odgovoran ?? a.odgovoran_label ?? '—'}</td>
                  <td className="px-2 py-1.5 text-xs">{a.zavisi_od ?? a.zavisi_od_text ?? '—'}</td>
                  <td className="px-2 py-1.5">
                    <StatusBadge tone={STATUS_TONE[eff(a)] ?? 'neutral'} label={AKTIVNOST_STATUS_LABELS[eff(a)] ?? eff(a) ?? '—'} />
                  </td>
                  <td className="px-2 py-1.5">
                    {a.prioritet ? <StatusBadge tone={PRIORITET_TONE[a.prioritet] ?? 'neutral'} label={PRIORITET_LABEL[a.prioritet] ?? a.prioritet} /> : '—'}
                  </td>
                  <td className="max-w-[140px] truncate px-2 py-1.5 text-xs text-ink-secondary" title={a.rizik_napomena ?? ''}>{a.rizik_napomena ?? '—'}</td>
                  <td className="tnums px-2 py-1.5 text-right text-xs">{a.rezerva_dani ?? '—'}</td>
                  <td className="px-2 py-1.5 text-xs">
                    {a.kasni ? <span className="text-status-danger">Da</span> : <span className="text-status-success">Ne</span>}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-right">
                    <div className="flex items-center justify-end gap-0.5">
                      {/* Detalji (read-only prikaz) dostupan svima (PR-26). */}
                      <Button variant="ghost" className="h-8 px-2 text-xs" onClick={() => setEdit(a)}>
                        {canEdit ? 'Izmeni' : 'Detalji'}
                      </Button>
                      <button onClick={() => a.id && setHistId(a.id)} className="rounded-control p-1 text-ink-secondary hover:bg-surface-2" title="Istorija">
                        <History className="h-3.5 w-3.5" />
                      </button>
                      {canEdit && eff(a) === 'blokirano' && (
                        <button onClick={() => setOdblokAkt(a)} className="rounded-control p-1 text-ink-secondary hover:bg-surface-2" title="Odblokiraj">
                          <Unlock className="h-3.5 w-3.5" />
                        </button>
                      )}
                      {canEdit && eff(a) !== 'blokirano' && (
                        <button onClick={() => a.id && setBlokId(a.id)} className="rounded-control p-1 text-ink-secondary hover:bg-surface-2" title="Blokiraj">
                          <Lock className="h-3.5 w-3.5" />
                        </button>
                      )}
                      {canEdit && eff(a) !== 'zavrseno' && (
                        <button onClick={() => setZatvoriAkt(a)} className="rounded-control p-1 text-ink-secondary hover:bg-surface-2" title="Zatvori aktivnost">
                          <CheckCircle2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Dashboard footer (PR-09) */}
      {allAktivnosti.length > 0 && <DashboardFooter dashboard={dashboard} activities={allAktivnosti} />}

      {edit !== null && (
        <AktivnostModal
          open
          onClose={() => setEdit(null)}
          rnId={rnId}
          projekatId={projekatId}
          aktivnost={edit === 'new' ? null : edit}
          activities={allAktivnosti}
          canEdit={canEdit}
          onZatvori={(a) => { setEdit(null); setZatvoriAkt(a); }}
          onBlokiraj={(a) => { setEdit(null); if (a.id) setBlokId(a.id); }}
          onOdblokiraj={(a) => { setEdit(null); setOdblokAkt(a); }}
        />
      )}
      {blokId && <BlokModal id={blokId} onClose={() => setBlokId(null)} />}
      {zatvoriAkt && (
        <NapomenaModal
          title="Zatvori aktivnost"
          confirmLabel="Zatvori"
          onClose={() => setZatvoriAkt(null)}
          onSubmit={(napomena) => {
            if (zatvoriAkt.id) zatvori.mutate({ id: zatvoriAkt.id, napomena });
            setZatvoriAkt(null);
          }}
        />
      )}
      {odblokAkt && (
        <NapomenaModal
          title="Skini blokadu"
          confirmLabel="Odblokiraj"
          onClose={() => setOdblokAkt(null)}
          onSubmit={(napomena) => {
            if (odblokAkt.id) odblokiraj.mutate({ id: odblokAkt.id, napomena });
            setOdblokAkt(null);
          }}
        />
      )}
      {promote && (
        <PromoteModal
          rnId={rnId}
          projekat={projekatId}
          onClose={() => setPromote(false)}
          onPromoted={(id) => {
            if (id) {
              setHighlightId(id);
              setTimeout(() => setHighlightId(null), 2000);
            }
          }}
        />
      )}
      {histId && <IstorijaModal id={histId} onClose={() => setHistId(null)} />}
    </div>
  );
}

/** Skok na akcionu tačku u Sastancima (SPA client navigacija) — paritet 1.0 oaMeetingLink. */
function jumpToSastanak(akcijaId: string) {
  const path = `/sastanci?akcija=${encodeURIComponent(akcijaId)}`;
  // 1.0 (aktivnostModal.js:161) radi ČIST meki SPA prelaz: pushState + popstate.
  // Next App Router presreće popstate i mekano rutira — bez reload-a.
  window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
  // Fallback SAMO ako meki prelaz ne uhvati modul (URL i dalje van /sastanci) —
  // uslovno, tek po sledećem ticku, da ne obara SPA prelaz bezuslovnim reload-om.
  window.setTimeout(() => {
    if (!window.location.pathname.startsWith('/sastanci')) {
      window.location.assign(path);
    }
  }, 0);
}

function FilterLabel({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-2xs uppercase tracking-wider text-ink-secondary">{text}</span>
      {children}
    </label>
  );
}

function MultiSelect({ value, onChange, options }: { value: string[]; onChange: (v: string[]) => void; options: { v: string; label: string }[] }) {
  return (
    <select
      multiple
      size={3}
      value={value}
      onChange={(e) => onChange(Array.from(e.target.selectedOptions).map((o) => o.value))}
      className="w-full rounded-control border border-line bg-surface px-1 py-1 text-2xs text-ink"
    >
      {options.map((o) => (
        <option key={o.v} value={o.v}>{o.label}</option>
      ))}
    </select>
  );
}

function Checkbox({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-ink">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /> {label}
    </label>
  );
}

function QuickChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn('h-7 rounded-control border px-2 text-2xs transition-colors', active ? 'border-accent bg-accent text-accent-fg' : 'border-line bg-surface text-ink-secondary hover:bg-surface-2')}
    >
      {children}
    </button>
  );
}

/** Dashboard footer: 6 metrika + tabela po odeljenjima + Top-5 kašnjenja (PR-09). */
function DashboardFooter({ dashboard, activities }: { dashboard: DashboardData; activities: AktivnostRow[] }) {
  const total = dashboard.total ?? {};
  const poOdeljenjima = dashboard.po_odeljenjima ?? [];
  const topLate = useMemo(
    () =>
      [...activities]
        .filter((a) => a.kasni)
        .sort((a, b) => Number(a.rezerva_dani ?? 99999) - Number(b.rezerva_dani ?? 99999))
        .slice(0, 5),
    [activities],
  );

  return (
    <section className="rounded-panel border border-line bg-surface p-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-secondary">Pregled operativnog plana</div>
      <div className="mb-3 flex flex-wrap gap-2">
        <Metric label="Ukupno" value={total.ukupno ?? 0} />
        <Metric label="Završeno" value={total.zavrseno ?? 0} />
        <Metric label="U toku" value={total.u_toku ?? 0} />
        <Metric label="Blokirano" value={total.blokirano ?? 0} />
        <Metric label="Nije krenulo" value={total.nije_krenulo ?? 0} />
        <Metric label="Najkasniji plan" value={total.najkasniji_planirani_zavrsetak ? formatDate(String(total.najkasniji_planirani_zavrsetak)) : '—'} />
      </div>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <div className="overflow-x-auto rounded-control border border-line">
          <table className="w-full text-2xs">
            <thead>
              <tr className="border-b border-line bg-surface-2 text-left text-ink-secondary">
                <th className="px-2 py-1">Odeljenje</th>
                <th className="px-2 py-1 text-right">Ukupno</th>
                <th className="px-2 py-1 text-right">Završeno</th>
                <th className="px-2 py-1 text-right">U toku</th>
                <th className="px-2 py-1 text-right">Blokirano</th>
                <th className="px-2 py-1">Najkasnije</th>
              </tr>
            </thead>
            <tbody>
              {poOdeljenjima.length === 0 ? (
                <tr><td colSpan={6} className="px-2 py-2 text-center text-ink-disabled">Nema aktivnosti po odeljenjima.</td></tr>
              ) : (
                poOdeljenjima.map((r, i) => (
                  <tr key={i} className="border-b border-line-soft">
                    <td className="px-2 py-1 font-medium text-ink">{r.odeljenje ?? '—'}</td>
                    <td className="tnums px-2 py-1 text-right">{r.ukupno ?? 0}</td>
                    <td className="tnums px-2 py-1 text-right">{r.zavrseno ?? 0}</td>
                    <td className="tnums px-2 py-1 text-right">{r.u_toku ?? 0}</td>
                    <td className="tnums px-2 py-1 text-right">{r.blokirano ?? 0}</td>
                    <td className="px-2 py-1">{r.najkasniji_planirani_zavrsetak ? formatDate(String(r.najkasniji_planirani_zavrsetak)) : '—'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="overflow-x-auto rounded-control border border-line">
          <table className="w-full text-2xs">
            <thead>
              <tr className="border-b border-line bg-surface-2 text-left text-ink-secondary">
                <th className="px-2 py-1">Top kašnjenja</th>
                <th className="px-2 py-1">Status</th>
                <th className="px-2 py-1 text-right">Rezerva</th>
              </tr>
            </thead>
            <tbody>
              {topLate.length === 0 ? (
                <tr><td colSpan={3} className="px-2 py-2 text-center text-ink-disabled">Nema aktivnosti koje kasne.</td></tr>
              ) : (
                topLate.map((a) => (
                  <tr key={a.id} className="border-b border-line-soft">
                    <td className="px-2 py-1">{a.naziv_aktivnosti ?? '—'}</td>
                    <td className="px-2 py-1">
                      <StatusBadge tone={STATUS_TONE[String(a.efektivni_status || a.status || '')] ?? 'neutral'} label={AKTIVNOST_STATUS_LABELS[String(a.efektivni_status || a.status || '')] ?? '—'} />
                    </td>
                    <td className="tnums px-2 py-1 text-right">{a.rezerva_dani ?? '—'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-control border border-line bg-surface-2 px-3 py-1.5">
      <span className="text-sm font-bold text-ink">{value}</span>
      <span className="ml-1.5 text-2xs text-ink-secondary">{label}</span>
    </div>
  );
}

/** Napomena prompt modal (zatvaranje / odblokada aktivnosti) — PR-22. */
function NapomenaModal({
  title,
  confirmLabel,
  onClose,
  onSubmit,
}: {
  title: string;
  confirmLabel: string;
  onClose: () => void;
  onSubmit: (napomena: string) => void;
}) {
  const [napomena, setNapomena] = useState('');
  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Otkaži</Button>
          <Button onClick={() => onSubmit(napomena.trim())}>{confirmLabel}</Button>
        </>
      }
    >
      <textarea
        value={napomena}
        onChange={(e) => setNapomena(e.target.value)}
        rows={3}
        placeholder="Napomena (opciono)…"
        className="w-full rounded-control border border-line bg-surface px-3 py-2 text-base text-ink"
      />
    </Dialog>
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

/** Istorija aktivnosti (PR-23): dve tabele Kada/Ko/Šta/Napomena — blokade + audit diff staro→novo. */
function IstorijaModal({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useAktivnostIstorija(id);
  const blokade = q.data?.data.blokade ?? [];
  const audit = q.data?.data.audit ?? [];

  const dt = (v: unknown) => (v ? new Date(String(v)).toLocaleString('sr-RS') : '—');

  const blokadeRows = blokade.map((raw) => {
    const r = raw as Record<string, unknown>;
    return {
      kada: dt(r.created_at),
      ko: String(r.changed_by_email ?? r.changed_by ?? '—'),
      sta: `blokada: ${String(r.old_manual_override_status ?? '—')} → ${String(r.new_manual_override_status ?? '—')}`,
      napomena: String(r.new_blokirano_razlog ?? r.napomena ?? ''),
    };
  });

  const auditRows = audit.map((raw) => {
    const r = raw as Record<string, unknown>;
    const keys = (r.diff_keys as string[] | undefined) ?? [];
    const old = (r.old_data as Record<string, unknown> | undefined) ?? {};
    const nw = (r.new_data as Record<string, unknown> | undefined) ?? {};
    return {
      kada: dt(r.changed_at),
      ko: String(r.actor_email ?? r.actor_uid ?? '—'),
      sta: `${String(r.action ?? '')}: ${keys.join(', ')}`,
      napomena: keys.map((k) => `${k}: ${old[k] ?? '—'} → ${nw[k] ?? '—'}`).join('; '),
    };
  });

  return (
    <Dialog open onClose={onClose} title="Istorija aktivnosti">
      {q.isLoading ? (
        <div className="py-6 text-center text-sm text-ink-secondary">Učitavanje…</div>
      ) : (
        <div className="space-y-4">
          <HistorySection title="Istorija blokada" rows={blokadeRows} empty="Nema zapisa blokade." />
          <HistorySection title="Audit izmene (admin)" rows={auditRows} empty="Audit log nije dostupan ili nema zapisa." />
        </div>
      )}
    </Dialog>
  );
}

function HistorySection({
  title,
  rows,
  empty,
}: {
  title: string;
  rows: { kada: string; ko: string; sta: string; napomena: string }[];
  empty: string;
}) {
  return (
    <div>
      <div className="mb-1 text-2xs uppercase tracking-wider text-ink-secondary">{title}</div>
      {rows.length === 0 ? (
        <p className="text-xs text-ink-disabled">{empty}</p>
      ) : (
        <div className="overflow-x-auto rounded-control border border-line">
          <table className="w-full text-2xs">
            <thead>
              <tr className="border-b border-line bg-surface-2 text-left text-ink-secondary">
                <th className="px-2 py-1">Kada</th>
                <th className="px-2 py-1">Ko</th>
                <th className="px-2 py-1">Šta</th>
                <th className="px-2 py-1">Napomena</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-b border-line-soft">
                  <td className="px-2 py-1">{r.kada}</td>
                  <td className="px-2 py-1">{r.ko}</td>
                  <td className="px-2 py-1">{r.sta}</td>
                  <td className="px-2 py-1">{r.napomena}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
