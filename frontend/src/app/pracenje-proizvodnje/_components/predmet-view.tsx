'use client';

import { useMemo, useState } from 'react';
import {
  ArrowLeft,
  ChevronRight,
  RefreshCw,
  ExternalLink,
  FileSpreadsheet,
  FileText,
  ArrowLeftRight,
  StickyNote,
  Search,
  ListTree,
} from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { Input } from '@/components/ui-kit/form-field';
import { Textarea } from '@/components/ui-kit/textarea';
import { Dialog } from '@/components/ui-kit/dialog';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { cn } from '@/lib/cn';
import { useCan } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { toast as showToast } from '@/lib/toast';
import {
  applyParentOverrides,
  descendantsOf,
  computeRollups,
  collectAncestors,
  visibleRows,
} from '@/lib/pracenje-tree';
import { exportIzvestajXlsx, exportIzvestajPdf } from '@/lib/pracenje-export';
import { openPracenjeDrawingPdf } from '@/lib/pracenje-pdf';
import { useOverrideUpsert, buildOverridePayload, rowManualQty } from './predmet-override';
import {
  usePredmetIzvestaj,
  usePodsklopovi,
  useUpsertNapomena,
  useUpsertParentOverride,
  fetchCrtezSignUrl,
  normalizeIzvestajResult,
  normalizePodsklopovi,
  logExport,
  type IzvestajRow,
  type PracenjeStatusi,
} from '@/api/pracenje';

const STATUS_OVR = [
  { v: '', label: 'Auto' },
  { v: 'u_radu', label: 'U radu' },
  { v: 'kompletirano', label: 'Kompletirano' },
  { v: 'nije_zapoceto', label: 'Nije započeto' },
] as const;

const FILTER_OPTS = [
  { v: 'sve', label: 'Sve' },
  { v: 'nije_kompletirano', label: 'Nije kompletirano' },
  { v: 'nema_tp', label: 'Nema TP' },
  { v: 'nema_crtez', label: 'Nema crtež' },
  { v: 'nema_zavrsnu_kontrolu', label: 'Nema završnu kontrolu' },
  { v: 'kasni', label: 'Kasni' },
  { v: 'ima_napomenu', label: 'Ima napomenu' },
] as const;

const DA_NE_OPTS = [
  { v: 'sve', label: 'Sve' },
  { v: 'da', label: 'DA' },
  { v: 'ne', label: 'NE' },
] as const;

const SKLOP_TYPE_LABEL: Record<string, string> = {
  glavni: 'Glavni sklop',
  pod: 'Podsklop',
  zav: 'Zav. sklop',
  poj: 'Pojedinačna',
};

const STATUS_OVR_LABEL: Record<string, string> = {
  u_radu: 'U radu',
  kompletirano: 'Kompletirano',
  nije_zapoceto: 'Nije započeto',
};

/**
 * Sticky (freeze) leve kolone (docx §5): pozicija/crtež/sklop/RN ostaju pri
 * horizontalnom skrolu — i u običnom i u matričnom prikazu. Fiksne širine → kumulativni
 * `left` offset-i (bez preklapanja — bug sa slike 5). Svaka zamrznuta ćelija nosi
 * NEPROVIDNU pozadinu reda (bojenje po tipu, docx §3) da skrolovan sadržaj ne probija.
 */
const FCOL = {
  poz: { left: 0, w: 248 },
  crt: { left: 248, w: 92 },
  skl: { left: 340, w: 92 },
  rn: { left: 432, w: 84 },
} as const;

function formatNum(v: unknown): string {
  if (v == null || v === '') return '—';
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : '—';
}

/** ISO/datum → `dd.MM.yyyy.` (DESIGN_SYSTEM §5). Prazno → ''. */
function formatDate(v: unknown): string {
  const s = String(v ?? '').trim();
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s.slice(0, 10);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.${d.getFullYear()}.`;
}

/** Dijakritika-neosetljiv normalizator za pretragu po poziciji (docx §8). */
function norm(s: unknown): string {
  const str = String(s ?? '').normalize('NFD');
  let out = '';
  for (const ch of str) {
    const c = ch.codePointAt(0) ?? 0;
    if (c >= 0x300 && c <= 0x36f) continue; // kombinujuće dijakritike
    out += ch;
  }
  return out.toLowerCase().trim();
}

/** Čitljivo ime operacije: o.masina, fallback o.naziv (1.0 opLabel). */
function opLabel(o: { masina?: string | null; naziv?: string | null }): string {
  return String(o.masina ?? '').trim() || String(o.naziv ?? '').trim() || '';
}

/** Sumar operacija reda (1.0 opsSummary): „N operacija · završna X/Y". */
function opsSummary(row: IzvestajRow): string {
  const ops = row.operations;
  if (!Array.isArray(ops) || !ops.length) return '—';
  const fin = ops.filter((o) => o.is_final_control);
  const lastFin = fin.length ? fin[fin.length - 1] : null;
  const tail = lastFin ? ` · završna ${formatNum(lastFin.completed_qty)}/${formatNum(lastFin.planned_qty)}` : '';
  return `${ops.length} operacija${tail}`;
}

/** Tip čvora u stablu za bojenje/grupisanje (1.0 rowSklopType). */
function rowSklopType(r: IzvestajRow, parentIds: Set<string>): string {
  const naziv = String(r.naziv_pozicije ?? '');
  const hasChildren = parentIds.has(String(r.node_id));
  if (/zavar|zavaren|zav\.?\s*sklop/i.test(naziv)) return 'zav';
  if (hasChildren) return Number(r.level || 0) === 0 ? 'glavni' : 'pod';
  return 'poj';
}

/** Suptilna pozadina celog reda po tipu (docx §3) — samo tokeni. Podsklop (plava)
 *  vs zavaren podsklop (žuta) su jasno različiti; pojedinačna = neutralna površina. */
function rowBgClass(typ: string): string {
  switch (typ) {
    case 'glavni':
      return 'bg-accent-subtle';
    case 'pod':
      return 'bg-status-info-bg';
    case 'zav':
      return 'bg-status-warn-bg';
    default:
      return 'bg-surface';
  }
}

function statusBitsText(st: PracenjeStatusi | undefined): string {
  const s = st ?? {};
  return (
    [
      s.kasni && 'Kasni',
      s.nema_tp && 'Nema TP',
      s.nema_crtez && 'Nema crtež',
      s.nema_zavrsnu_kontrolu && 'Nema ZK',
      s.nije_kompletirano && 'Nije kompl.',
      s.nema_rn && 'Nema RN',
    ]
      .filter(Boolean)
      .join(', ') || 'OK'
  );
}

function rowIsProblem(st: PracenjeStatusi | undefined): boolean {
  const s = st ?? {};
  return !!(s.kasni || s.nema_tp || s.nema_crtez || s.nema_zavrsnu_kontrolu || s.nije_kompletirano || s.nema_rn);
}

function maxOpSlots(rows: IzvestajRow[]): number {
  let m = 0;
  for (const r of rows) if (Array.isArray(r.operations)) m = Math.max(m, r.operations.length);
  return m;
}

/**
 * Klik na broj crteža → PDF (docx §12, odluka O7). BE ne daje numerički drawing id uz
 * red praćenja (samo broj crteža) — razrešava se kroz `crtez/sign` (vraća content rutu
 * sa id-jem), pa se PDF povlači kroz `openPracenjeDrawingPdf` (Authorization bearer +
 * blob; `window.open` na golu rutu bi vratio 401). Greške → postojeći toast obrazac.
 */
async function openDrawing(code: string | null | undefined): Promise<void> {
  if (!code) return;
  try {
    const res = await fetchCrtezSignUrl(String(code));
    const url = res.data?.url ?? '';
    const m = url.match(/\/crtez\/(\d+)\/pdf/);
    if (m) {
      await openPracenjeDrawingPdf(Number(m[1]));
    } else if (url) {
      window.open(url, '_blank', 'noopener,noreferrer');
    } else {
      showToast('Crtež nije dostupan.');
    }
  } catch (e) {
    showToast(e instanceof Error ? e.message : 'Crtež nije dostupan.');
  }
}

/** Razrešeno DA/NE stanje mašinske/površinske (docx §4.7/§4.9): eksplicitni override ⚑
 *  gazi sve; „kompletirano" → efektivno DA; inače auto tekst iz routing-a. */
interface DaNeState {
  da: boolean;
  manual: boolean;
  fromComplete: boolean;
  autoText: string;
}
function attrState(ovr: boolean | null | undefined, eff: unknown, autoText: string | null | undefined): DaNeState {
  const s = String(autoText ?? '').trim();
  if (ovr === true || ovr === false) return { da: ovr, manual: true, fromComplete: false, autoText: s };
  if (eff === true) return { da: true, manual: false, fromComplete: true, autoText: s };
  const da = s !== '' && s !== '—';
  return { da, manual: false, fromComplete: false, autoText: s };
}
function machiningState(r: IzvestajRow): DaNeState {
  return attrState(r.masinska_done_override, r.masinska_done_efektivno, r.masinska_obrada_status);
}
function surfaceState(r: IzvestajRow): DaNeState {
  return attrState(r.povrsinska_done_override, r.povrsinska_done_efektivno, r.povrsinska_zastita_status);
}

function daNeInner(st: DaNeState): React.ReactNode {
  if (st.manual) {
    return (
      <span className={st.da ? 'text-status-success' : 'text-ink-secondary'} title="Ručno postavljeno">
        {st.da ? 'DA' : 'NE'} ⚑
      </span>
    );
  }
  if (st.fromComplete) {
    return (
      <span className="text-status-success" title="Automatski DA (status: Kompletirano)">
        DA
      </span>
    );
  }
  if (!st.da) return <span className="text-ink-secondary">NE</span>;
  const done = /urađeno|zavr|gotov|100/i.test(st.autoText) && !/nije|0\s*\//i.test(st.autoText);
  return (
    <span className={done ? 'text-status-success' : 'text-status-warn'} title={st.autoText}>
      DA
    </span>
  );
}

/** Sledeći eksplicitni override u ciklusu auto → DA → NE → auto (1.0 daNeManualCell). */
function nextOverride(ovr: boolean | null): boolean | null {
  if (ovr === true) return false; // DA → NE
  if (ovr === false) return null; // NE → auto
  return true; // auto → DA
}

/** DA/NE ćelija (docx §4.7). Sa pravom izmene = dugme koje cikliše override; bez = prikaz. */
function DaNeCell({
  st,
  canManage,
  onCycle,
}: {
  st: DaNeState;
  canManage: boolean;
  onCycle: (next: boolean | null) => void;
}): React.ReactNode {
  if (!canManage) return daNeInner(st);
  const explicit = st.manual ? st.da : null;
  return (
    <button
      type="button"
      onClick={() => onCycle(nextOverride(explicit))}
      className="rounded-control px-1 py-0.5 hover:bg-surface-2"
      title="Klik: auto → DA → NE → auto"
    >
      {daNeInner(st)}
    </button>
  );
}

/** % gotovosti / % mašinske (docx §4.4) — bar (dinamička širina) + broj; null → „—". */
function PctCell({ pct, muted }: { pct: number | null; muted?: boolean }): React.ReactNode {
  if (pct == null) return <span className="text-ink-secondary">—</span>;
  const clamped = Math.max(0, Math.min(100, pct));
  const tone = clamped >= 100 ? 'bg-status-success' : clamped > 0 ? (muted ? 'bg-status-neutral' : 'bg-status-info') : 'bg-status-neutral';
  return (
    <div className="flex items-center gap-1.5">
      <div className="h-1.5 w-10 shrink-0 overflow-hidden rounded-full bg-line">
        <div className={cn('h-full rounded-full', tone)} style={{ width: `${clamped}%` }} />
      </div>
      <span className="tnums text-2xs text-ink-secondary">{clamped}%</span>
    </div>
  );
}

/** Ekran 2 — Tabela praćenja predmeta: stablo + kontrole + izvozi (docx §4, F3). */
export function PredmetView({
  itemId,
  rootRn,
  onBack,
  onOpenRnBigtehn,
}: {
  itemId: number;
  rootRn?: string;
  onBack: () => void;
  onOpenRnBigtehn: (bigtehnRnId: string) => void;
}) {
  const can = useCan();
  const canManage = can(PERMISSIONS.PRACENJE_MANAGE);

  // Kontrole: Opseg (root RN = filter po sklopu, docx §1), Lot, Filter, pretraga +
  // maš./površ. filteri (docx §8), Matrični prikaz.
  const [scope, setScope] = useState<string>(rootRn ?? '');
  const [lot, setLot] = useState<number>(12);
  const [filter, setFilter] = useState<string>('sve');
  const [masFilter, setMasFilter] = useState<string>('sve');
  const [povrsFilter, setPovrsFilter] = useState<string>('sve');
  const [search, setSearch] = useState<string>('');
  const [matrix, setMatrix] = useState<boolean>(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set()); // sklopljeni sklopovi
  const [opsFor, setOpsFor] = useState<Set<string>>(new Set()); // redovi sa otvorenom podtabelom operacija
  const [noteFor, setNoteFor] = useState<IzvestajRow | null>(null);
  const [reparentFor, setReparentFor] = useState<IzvestajRow | null>(null);
  const [qtyFor, setQtyFor] = useState<IzvestajRow | null>(null);

  const q = usePredmetIzvestaj(itemId, scope || undefined, lot);
  const podsklopovi = usePodsklopovi(itemId);
  const napomena = useUpsertNapomena();
  const override = useOverrideUpsert();
  const parentOverride = useUpsertParentOverride();

  const result = useMemo(() => normalizeIzvestajResult(q.data?.data), [q.data]);
  const rowsAll = result.rows ?? [];
  const { rows: rowsEff, parentIds } = useMemo(() => applyParentOverrides(rowsAll), [rowsAll]);
  const rollups = useMemo(() => computeRollups(rowsEff), [rowsEff]);

  const filterActive =
    filter !== 'sve' || masFilter !== 'sve' || povrsFilter !== 'sve' || search.trim() !== '';

  const passRow = useMemo(() => {
    const qq = norm(search);
    return (r: IzvestajRow): boolean => {
      const s = r.statusi ?? {};
      let ok = true;
      switch (filter) {
        case 'nije_kompletirano':
          ok = !!s.nije_kompletirano;
          break;
        case 'nema_tp':
          ok = !!s.nema_tp;
          break;
        case 'nema_crtez':
          ok = !!s.nema_crtez;
          break;
        case 'nema_zavrsnu_kontrolu':
          ok = !!s.nema_zavrsnu_kontrolu;
          break;
        case 'kasni':
          ok = !!s.kasni;
          break;
        case 'ima_napomenu':
          ok = String(r.korisnicka_napomena || r.sistemska_napomena || '').trim().length > 0;
          break;
        default:
          ok = true;
      }
      if (!ok) return false;
      if (masFilter !== 'sve' && (masFilter === 'da') !== machiningState(r).da) return false;
      if (povrsFilter !== 'sve' && (povrsFilter === 'da') !== surfaceState(r).da) return false;
      if (qq) {
        const hay = norm(`${r.naziv_pozicije ?? ''} ${r.naziv_dela ?? ''} ${r.rn_broj ?? ''} ${r.broj_crteza ?? ''} ${r.ident_broj ?? ''}`);
        if (!hay.includes(qq)) return false;
      }
      return true;
    };
  }, [filter, masFilter, povrsFilter, search]);

  // Vidljivi (ekran) i izvozni redovi: filter zadržava predke sklopa radi konteksta;
  // bez filtera se poštuje sklapanje (izvoz ignoriše sklapanje = puno stablo).
  const { rows, exportRows } = useMemo(() => {
    if (filterActive) {
      const matched = rowsEff.filter(passRow);
      const matchedIds = new Set(matched.map((r) => String(r.node_id)));
      const anc = collectAncestors(rowsEff, matchedIds);
      const keep = (r: IzvestajRow) => matchedIds.has(String(r.node_id)) || anc.has(String(r.node_id));
      const visible = rowsEff.filter(keep);
      return { rows: visible, exportRows: visible };
    }
    return { rows: visibleRows(rowsEff, collapsed), exportRows: rowsEff };
  }, [filterActive, rowsEff, passRow, collapsed]);

  const nSlots = matrix ? maxOpSlots(rows) : 0;

  const flat = useMemo(() => normalizePodsklopovi(podsklopovi.data?.data), [podsklopovi.data]);
  const scopeOptions = useMemo(
    () => [
      { v: '', t: 'Ceo predmet' },
      ...flat.map((r) => ({
        v: String(r.rn_id),
        t: `${r.ident_broj ?? r.rn_id} — ${String(r.naziv_dela ?? '').slice(0, 80)}`,
      })),
    ],
    [flat],
  );

  const pred = result.predmet ?? {};
  const titleBroj = String(pred.broj_predmeta ?? '');
  const titleNaz = String(pred.naziv_predmeta ?? 'Predmet');

  function toggleCollapse(node: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(node)) next.delete(node);
      else next.add(node);
      return next;
    });
  }
  function toggleOps(node: string) {
    setOpsFor((prev) => {
      const next = new Set(prev);
      if (next.has(node)) next.delete(node);
      else next.add(node);
      return next;
    });
  }

  async function doExportXlsx() {
    try {
      await exportIzvestajXlsx({ result, rows: exportRows, rollups, filter, lot });
      logExport({ tab: 'tabela_pracenja_excel', predmetItemId: itemId, extra: { rows: exportRows.length } }).catch(() => {});
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Excel izvoz nije uspeo.');
    }
  }
  async function doExportPdf() {
    try {
      await exportIzvestajPdf({ result, rows: exportRows, rollups, filter, lot });
      logExport({ tab: 'tabela_pracenja_pdf', predmetItemId: itemId, extra: { rows: exportRows.length } }).catch(() => {});
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'PDF izvoz nije uspeo.');
    }
  }

  // 18 fiksnih kolona (uklj. % gotov. + % maš.) + operacije/matrični slotovi.
  const colCount = 18 + (matrix ? nSlots * 2 : 1);

  return (
    <div className="space-y-4">
      {/* Zaglavlje + kontrole */}
      <div className="flex flex-wrap items-end gap-3">
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" /> Nazad
        </Button>
        <div>
          <div className="text-2xs uppercase tracking-wider text-ink-secondary">Izveštaj</div>
          <h2 className="text-md font-semibold text-ink">
            Praćenje proizvodnje — {titleBroj} {titleNaz}
          </h2>
          {result.root?.naziv && <div className="text-xs text-ink-secondary">Opseg: {result.root.naziv}</div>}
        </div>

        <label className="flex flex-col gap-1 text-2xs uppercase tracking-wider text-ink-secondary">
          Opseg (sklop)
          <select
            value={scope}
            onChange={(e) => {
              setScope(e.target.value);
              setCollapsed(new Set());
              setOpsFor(new Set());
            }}
            className="h-8 rounded-control border border-line bg-surface px-2 text-sm normal-case tracking-normal text-ink"
          >
            {scopeOptions.map((o) => (
              <option key={o.v} value={o.v}>
                {o.t}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-2xs uppercase tracking-wider text-ink-secondary">
          Lot
          <Input
            type="number"
            min={1}
            max={100000}
            step={1}
            value={lot}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v) && v >= 1 && v <= 100000) setLot(v);
            }}
            className="h-8 w-24"
          />
        </label>

        <label className="flex flex-col gap-1 text-2xs uppercase tracking-wider text-ink-secondary">
          Filter
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="h-8 rounded-control border border-line bg-surface px-2 text-sm normal-case tracking-normal text-ink"
          >
            {FILTER_OPTS.map((o) => (
              <option key={o.v} value={o.v}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-2xs uppercase tracking-wider text-ink-secondary">
          Maš. obrada
          <select
            value={masFilter}
            onChange={(e) => setMasFilter(e.target.value)}
            className="h-8 rounded-control border border-line bg-surface px-2 text-sm normal-case tracking-normal text-ink"
          >
            {DA_NE_OPTS.map((o) => (
              <option key={o.v} value={o.v}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-2xs uppercase tracking-wider text-ink-secondary">
          Površ. zaštita
          <select
            value={povrsFilter}
            onChange={(e) => setPovrsFilter(e.target.value)}
            className="h-8 rounded-control border border-line bg-surface px-2 text-sm normal-case tracking-normal text-ink"
          >
            {DA_NE_OPTS.map((o) => (
              <option key={o.v} value={o.v}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-2xs uppercase tracking-wider text-ink-secondary">
          Pretraga
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-secondary" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Po poziciji…"
              className="h-8 w-44 pl-7 normal-case tracking-normal"
            />
          </div>
        </label>

        <Button variant="secondary" onClick={() => q.refetch()} disabled={q.isFetching}>
          <RefreshCw className={cn('h-4 w-4', q.isFetching && 'animate-spin')} /> Osveži
        </Button>
        <Button variant="secondary" onClick={doExportXlsx} disabled={exportRows.length === 0}>
          <FileSpreadsheet className="h-4 w-4" /> Izvezi Excel
        </Button>
        <Button variant="secondary" onClick={doExportPdf} disabled={exportRows.length === 0}>
          <FileText className="h-4 w-4" /> Izvezi PDF
        </Button>
        <label className="flex items-center gap-1.5 text-xs text-ink">
          <input type="checkbox" checked={matrix} onChange={(e) => setMatrix(e.target.checked)} />
          Matrični prikaz
        </label>
      </div>

      {/* Legenda tipova (bojenje redova) */}
      <div className="flex flex-wrap items-center gap-4 text-xs text-ink-secondary">
        <LegendSwatch tone="bg-accent-subtle" label="Glavni sklop" />
        <LegendSwatch tone="bg-status-info-bg" label="Podsklop" />
        <LegendSwatch tone="bg-status-warn-bg" label="Zav. sklop" />
        <LegendSwatch tone="bg-surface border border-line" label="Pojedinačna" />
      </div>

      {q.isLoading ? (
        <div className="rounded-panel border border-line bg-surface px-4 py-10 text-center text-sm text-ink-secondary">Učitavanje…</div>
      ) : rows.length === 0 ? (
        <EmptyState title="Nema podataka praćenja za predmet" />
      ) : (
        <div className="max-h-[min(72vh,800px)] overflow-auto rounded-panel border border-line bg-surface">
          <table className="w-full min-w-[1320px] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-2xs uppercase tracking-wider text-ink-secondary">
                <th
                  style={{ left: FCOL.poz.left, width: FCOL.poz.w, minWidth: FCOL.poz.w }}
                  className="sticky top-0 z-40 bg-surface-2 px-3 py-1.5"
                >
                  Pozicija
                </th>
                <th
                  style={{ left: FCOL.crt.left, width: FCOL.crt.w, minWidth: FCOL.crt.w }}
                  className="sticky top-0 z-40 bg-surface-2 px-3 py-1.5"
                  title="Link crteža (klik → PDF)"
                >
                  Crtež
                </th>
                <th
                  style={{ left: FCOL.skl.left, width: FCOL.skl.w, minWidth: FCOL.skl.w }}
                  className="sticky top-0 z-40 bg-surface-2 px-3 py-1.5"
                  title="Link sklopnog crteža"
                >
                  Sklop
                </th>
                <th
                  style={{ left: FCOL.rn.left, width: FCOL.rn.w, minWidth: FCOL.rn.w }}
                  className="sticky top-0 z-40 bg-surface-2 px-3 py-1.5"
                >
                  RN
                </th>
                <th className="sticky top-0 z-20 bg-surface-2 px-3 py-1.5" title="Lansirana količina">Lansirano</th>
                <th className="sticky top-0 z-20 bg-surface-2 px-3 py-1.5" title="Završena količina (efektivno, uklj. ručno)">Završeno</th>
                <th className="sticky top-0 z-20 bg-surface-2 px-3 py-1.5" title="% gotovosti (rollup po sklopu)">% gotov.</th>
                <th className="sticky top-0 z-20 bg-surface-2 px-3 py-1.5" title="Potrebno za izabrani lot">Za lot</th>
                <th className="sticky top-0 z-20 bg-surface-2 px-3 py-1.5" title="Raspoloživo / kompletirano za lot">Rasp./lot</th>
                <th className="sticky top-0 z-20 bg-surface-2 px-3 py-1.5" title="Datum lansiranja TP">Lans. TP</th>
                <th className="sticky top-0 z-20 bg-surface-2 px-3 py-1.5" title="Rok / datum izrade">Rok izr.</th>
                <th className="sticky top-0 z-20 bg-surface-2 px-3 py-1.5 text-center" title="Mašinska obrada (DA/NE)">Maš.</th>
                <th className="sticky top-0 z-20 bg-surface-2 px-3 py-1.5" title="% mašinske obrade (rollup)">% maš.</th>
                <th className="sticky top-0 z-20 bg-surface-2 px-3 py-1.5 text-center" title="Površinska zaštita (DA/NE)">Površ.</th>
                <th className="sticky top-0 z-20 bg-surface-2 px-3 py-1.5">Materijal</th>
                <th className="sticky top-0 z-20 bg-surface-2 px-3 py-1.5">Dimenzije</th>
                <th className="sticky top-0 z-20 bg-surface-2 px-3 py-1.5 text-center">Napomena</th>
                <th className="sticky top-0 z-20 bg-surface-2 px-3 py-1.5">Status</th>
                {matrix ? (
                  Array.from({ length: nSlots }, (_, i) => (
                    <FragTh key={i}>
                      <th className="sticky top-0 z-20 bg-surface-2 px-3 py-1.5">Operacija {i + 1}</th>
                      <th className="sticky top-0 z-20 bg-surface-2 px-3 py-1.5">Kol. {i + 1}</th>
                    </FragTh>
                  ))
                ) : (
                  <th className="sticky top-0 z-20 bg-surface-2 px-3 py-1.5">Operacije</th>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const node = String(r.node_id ?? '');
                const st = r.statusi;
                const typ = rowSklopType(r, parentIds);
                const bg = rowBgClass(typ);
                const hasChildren = parentIds.has(node);
                const isCollapsed = collapsed.has(node);
                const opsOpen = opsFor.has(node);
                const indent = Number(r.level ?? 0) * 16;
                const hasNote = String(r.korisnicka_napomena || '').trim().length > 0;
                const hasSys = String(r.sistemska_napomena || '').trim().length > 0;
                const boldNaziv = typ === 'glavni' || typ === 'pod' || typ === 'zav';
                const problem = rowIsProblem(st);
                const roll = rollups.get(node);
                const masSt = machiningState(r);
                const povSt = surfaceState(r);
                const mqty = rowManualQty(r);
                return (
                  <FragRow key={node}>
                    <tr className={cn('group border-b border-line-soft', bg, 'hover:bg-surface-2')}>
                      {/* Zamrznute leve kolone (docx §5) */}
                      <td
                        style={{ left: FCOL.poz.left, width: FCOL.poz.w, minWidth: FCOL.poz.w, maxWidth: FCOL.poz.w }}
                        className={cn(
                          'sticky z-30 overflow-hidden px-3 py-1.5 group-hover:bg-surface-2',
                          bg,
                          problem && 'border-l-2 border-status-danger',
                        )}
                      >
                        <div className="flex items-center gap-1" style={{ paddingLeft: indent }}>
                          {hasChildren ? (
                            <button
                              onClick={() => toggleCollapse(node)}
                              className="shrink-0 rounded-control p-0.5 text-ink-secondary hover:bg-surface"
                              title={isCollapsed ? 'Rasklopi sklop' : 'Sklopi sklop'}
                            >
                              <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', !isCollapsed && 'rotate-90')} />
                            </button>
                          ) : (
                            <span className="inline-block w-[18px] shrink-0" aria-hidden />
                          )}
                          <span className={cn('min-w-0 flex-1 truncate text-ink', boldNaziv && 'font-semibold')} title={String(r.naziv_pozicije ?? r.naziv_dela ?? '')}>
                            {r.naziv_pozicije ?? r.naziv_dela ?? '—'}
                          </span>
                          <TypBadge typ={typ} />
                          {r.has_parent_override && (
                            <span className="shrink-0 rounded-full bg-status-info-bg px-1 py-0.5 text-2xs text-status-info" title="Ručno premešteno u sklop">
                              ↪
                            </span>
                          )}
                          {canManage && (
                            <button
                              onClick={() => setReparentFor(r)}
                              className="shrink-0 rounded-control p-0.5 text-ink-secondary hover:bg-surface"
                              title="Premesti u sklop"
                            >
                              <ArrowLeftRight className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                      <td
                        style={{ left: FCOL.crt.left, width: FCOL.crt.w, minWidth: FCOL.crt.w, maxWidth: FCOL.crt.w }}
                        className={cn('sticky z-30 overflow-hidden px-3 py-1.5 text-xs group-hover:bg-surface-2', bg)}
                      >
                        <DrawingCell code={r.crtez_drawing_no} label={r.broj_crteza ?? r.crtez_drawing_no} hasFile={r.has_crtez_file} />
                      </td>
                      <td
                        style={{ left: FCOL.skl.left, width: FCOL.skl.w, minWidth: FCOL.skl.w, maxWidth: FCOL.skl.w }}
                        className={cn('sticky z-30 overflow-hidden px-3 py-1.5 text-xs group-hover:bg-surface-2', bg)}
                      >
                        <DrawingCell code={r.sklop_drawing_no} label={r.broj_sklopnog_crteza ?? r.sklop_drawing_no} hasFile={r.has_skop_crtez_file} dash />
                      </td>
                      <td
                        style={{ left: FCOL.rn.left, width: FCOL.rn.w, minWidth: FCOL.rn.w, maxWidth: FCOL.rn.w }}
                        className={cn('sticky z-30 overflow-hidden px-3 py-1.5 text-xs group-hover:bg-surface-2', bg)}
                      >
                        {r.rn_broj ? (
                          <button
                            onClick={() => onOpenRnBigtehn(node)}
                            className="inline-flex items-center gap-1 text-accent hover:underline"
                            title="Otvori RN"
                          >
                            {r.rn_broj} <ExternalLink className="h-3 w-3" />
                          </button>
                        ) : (
                          '—'
                        )}
                      </td>
                      {/* Skrolabilne kolone */}
                      <td className="tnums px-3 py-1.5 text-xs">{formatNum(r.lansirana_kolicina)}</td>
                      <td className="tnums px-3 py-1.5 text-xs">
                        {formatNum(r.zavrsena_kolicina)}
                        {mqty != null && (
                          <span className="ml-1 text-status-warn" title={`Ručno uneto: ${mqty} kom`}>
                            ⚑
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-1.5">
                        <PctCell pct={roll?.pct ?? null} />
                      </td>
                      <td className="tnums px-3 py-1.5 text-xs">{r.required_for_lot == null ? 'N/A' : formatNum(r.required_for_lot)}</td>
                      <td className="tnums px-3 py-1.5 text-xs">
                        {formatNum(r.raspolozivo_za_montazu)} / {formatNum(r.kompletirano_za_lot)}
                      </td>
                      <td className="px-3 py-1.5 text-xs">{r.datum_lansiranja_tp ?? '—'}</td>
                      <td className="px-3 py-1.5 text-xs">{r.datum_izrade ?? '—'}</td>
                      <td className="px-3 py-1.5 text-center text-xs">
                        <DaNeCell
                          st={masSt}
                          canManage={canManage}
                          onCycle={(next) => override.mutate(buildOverridePayload(itemId, r, { masinska: next }))}
                        />
                      </td>
                      <td className="px-3 py-1.5">
                        <PctCell pct={roll?.masPct ?? null} muted />
                      </td>
                      <td className="px-3 py-1.5 text-center text-xs">
                        <DaNeCell
                          st={povSt}
                          canManage={canManage}
                          onCycle={(next) => override.mutate(buildOverridePayload(itemId, r, { povrsinska: next }))}
                        />
                      </td>
                      <td className="px-3 py-1.5 text-xs">{r.materijal ?? '—'}</td>
                      <td className="px-3 py-1.5 text-xs">{r.dimenzije ?? '—'}</td>
                      <td className="px-3 py-1.5 text-center">
                        <button
                          onClick={() => setNoteFor(r)}
                          className={cn('relative rounded-control p-1 hover:bg-surface', hasNote ? 'text-accent' : 'text-ink-secondary')}
                          title={hasNote ? String(r.korisnicka_napomena) : canManage ? 'Dodaj napomenu' : 'Nema napomene'}
                          aria-label="Napomena"
                        >
                          <StickyNote className="h-3.5 w-3.5" />
                          {(hasNote || hasSys) && <span className="absolute -right-0 -top-0 h-1.5 w-1.5 rounded-full bg-status-warn" />}
                        </button>
                      </td>
                      <td className="px-3 py-1.5">
                        {canManage ? (
                          <div className="flex flex-col gap-0.5">
                            <select
                              value={r.status_override ?? ''}
                              onChange={(e) => override.mutate(buildOverridePayload(itemId, r, { status: e.target.value }))}
                              className={cn(
                                'h-7 rounded-control border bg-surface px-1.5 text-xs text-ink',
                                r.status_override ? 'border-accent' : 'border-line',
                              )}
                              title="Ručni status"
                            >
                              {STATUS_OVR.map((o) => (
                                <option key={o.v} value={o.v}>
                                  {o.label}
                                </option>
                              ))}
                            </select>
                            <button
                              onClick={() => setQtyFor(r)}
                              className={cn('text-left text-2xs hover:underline', mqty != null ? 'text-status-warn' : 'text-accent')}
                              title="Ručna količina — fizički urađeno a nije otkucano (docx §6)"
                            >
                              {mqty != null ? `Ručno: ${mqty} kom ✎` : 'Ručna kol.'}
                            </button>
                            <div className="text-2xs text-ink-secondary">{statusBitsText(st)}</div>
                          </div>
                        ) : r.status_override ? (
                          <span className="text-xs text-ink" title="Ručno postavljeno">
                            {STATUS_OVR_LABEL[r.status_override] ?? r.status_override} <span className="text-ink-secondary">ručno</span>
                            {mqty != null && <span className="ml-1 text-status-warn" title={`Ručno uneto: ${mqty} kom`}>⚑</span>}
                          </span>
                        ) : (
                          <span className="text-xs text-ink-secondary">
                            {statusBitsText(st)}
                            {mqty != null && <span className="ml-1 text-status-warn" title={`Ručno uneto: ${mqty} kom`}>⚑</span>}
                          </span>
                        )}
                      </td>
                      {matrix ? (
                        Array.from({ length: nSlots }, (_, i) => {
                          const o = (r.operations ?? [])[i];
                          if (!o)
                            return (
                              <FragTh key={i}>
                                <td className="px-3 py-1.5 text-xs">—</td>
                                <td className="px-3 py-1.5 text-xs">—</td>
                              </FragTh>
                            );
                          const label = opLabel(o);
                          const numTxt = String(o.naziv ?? '').trim();
                          const title = numTxt && numTxt !== label ? `${label} (op. ${numTxt})` : label;
                          const dat = formatDate(o.completed_at);
                          return (
                            <FragTh key={i}>
                              <td className="px-3 py-1.5 text-xs" title={title}>
                                {label.slice(0, 24)}
                                {label.length > 24 ? '…' : ''}
                              </td>
                              <td className="tnums px-3 py-1.5 text-xs">
                                <div>
                                  {formatNum(o.completed_qty)}/{formatNum(o.planned_qty)}
                                </div>
                                {dat && <div className="text-2xs text-ink-secondary" title="Datum završetka operacije">{dat}</div>}
                              </td>
                            </FragTh>
                          );
                        })
                      ) : (
                        <td className="px-3 py-1.5 text-xs">
                          <div className="flex items-center gap-1.5">
                            <button
                              onClick={() => toggleOps(node)}
                              className="shrink-0 rounded-control p-0.5 text-ink-secondary hover:bg-surface"
                              title="Prikaži operacije"
                            >
                              <ListTree className={cn('h-3.5 w-3.5', opsOpen && 'text-accent')} />
                            </button>
                            <span>{opsSummary(r)}</span>
                          </div>
                        </td>
                      )}
                    </tr>
                    {opsOpen && Array.isArray(r.operations) && r.operations.length > 0 && (
                      <tr className="border-b border-line-soft bg-surface-2/50">
                        <td colSpan={colCount} className="px-4 py-3">
                          <OperacijeSubtable ops={r.operations} />
                        </td>
                      </tr>
                    )}
                  </FragRow>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Footer sumar */}
      {result.summary && rows.length > 0 && (
        <p className="text-xs text-ink-secondary">
          Redova: {result.summary.total_rows ?? rows.length} · Lansirano: {formatNum(result.summary.total_lansirano)} · Završeno:{' '}
          {formatNum(result.summary.total_zavrseno)} · Lot: {lot}
        </p>
      )}

      {noteFor && (
        <NapomenaModal
          row={noteFor}
          canManage={canManage}
          onClose={() => setNoteFor(null)}
          onSave={(note) => {
            const node = String(noteFor.node_id ?? '');
            napomena.mutate(
              { itemId, bigtehnRnId: node, note, rnId: noteFor.rn_id ?? undefined },
              { onSuccess: () => showToast('Napomena sačuvana'), onError: (e) => showToast(e instanceof Error ? e.message : 'Greška.') },
            );
            setNoteFor(null);
          }}
        />
      )}

      {qtyFor && (
        <ManualQtyModal
          row={qtyFor}
          onClose={() => setQtyFor(null)}
          onSave={(manualQty, reason) => {
            override.mutate(buildOverridePayload(itemId, qtyFor, { manualQty, reason }), {
              onSuccess: () => showToast(manualQty == null ? 'Ručna količina uklonjena' : 'Ručna količina sačuvana'),
              onError: (e) => showToast(e instanceof Error ? e.message : 'Greška.'),
            });
            setQtyFor(null);
          }}
        />
      )}

      {reparentFor && (
        <ReparentModal
          row={reparentFor}
          rowsAll={rowsAll}
          onClose={() => setReparentFor(null)}
          onSave={(payload) => {
            const node = String(reparentFor.node_id ?? '');
            parentOverride.mutate(
              { itemId, bigtehnRnId: node, ...payload },
              { onSuccess: () => showToast('Sklop ažuriran'), onError: (e) => showToast(e instanceof Error ? e.message : 'Greška.') },
            );
            setReparentFor(null);
          }}
        />
      )}
    </div>
  );
}

function FragRow({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
function FragTh({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

function LegendSwatch({ tone, label }: { tone: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn('h-2.5 w-2.5 rounded-sm', tone)} aria-hidden />
      {label}
    </span>
  );
}

function TypBadge({ typ }: { typ: string }) {
  const tone =
    typ === 'glavni'
      ? 'bg-accent-subtle text-accent'
      : typ === 'pod'
        ? 'bg-status-info-bg text-status-info'
        : typ === 'zav'
          ? 'bg-status-warn-bg text-status-warn'
          : 'bg-status-neutral-bg text-status-neutral';
  return <span className={cn('shrink-0 rounded-full px-1.5 py-0.5 text-2xs', tone)}>{SKLOP_TYPE_LABEL[typ]}</span>;
}

function DrawingCell({
  code,
  label,
  hasFile,
  dash,
}: {
  code: string | null | undefined;
  label: string | null | undefined;
  hasFile: boolean | null | undefined;
  dash?: boolean;
}) {
  if (!code) return <span className="text-ink-secondary">{dash ? '—' : 'Nema'}</span>;
  return (
    <button
      onClick={() => hasFile && openDrawing(code)}
      disabled={!hasFile}
      className="truncate rounded-control px-1.5 py-0.5 text-accent hover:bg-surface disabled:text-ink-disabled disabled:hover:bg-transparent"
      title={hasFile ? 'Otvori crtež (PDF)' : 'Nema PDF-a crteža'}
    >
      {label ?? code}
    </button>
  );
}

/** Podtabela SVIH operacija reda (uklj. datum završetka operacije, docx §9). */
function OperacijeSubtable({ ops }: { ops: IzvestajRow['operations'] }) {
  const list = ops ?? [];
  return (
    <div className="overflow-x-auto rounded-control border border-line bg-surface">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-line bg-surface-2 text-left text-ink-secondary">
            <th className="px-2 py-1">Rb</th>
            <th className="px-2 py-1">Operacija</th>
            <th className="px-2 py-1">Mašina</th>
            <th className="px-2 py-1">Opis postupka</th>
            <th className="px-2 py-1">Alat / pribor</th>
            <th className="px-2 py-1">Plan</th>
            <th className="px-2 py-1">Urađeno</th>
            <th className="px-2 py-1">Datum</th>
            <th className="px-2 py-1">Kontrola</th>
          </tr>
        </thead>
        <tbody>
          {list.map((o, i) => (
            <tr key={i} className="border-b border-line-soft">
              <td className="px-2 py-1">{String(o.redosled ?? '')}</td>
              <td className="px-2 py-1">{opLabel(o)}</td>
              <td className="px-2 py-1">{String(o.masina ?? '')}</td>
              <td className="max-w-[320px] whitespace-pre-wrap px-2 py-1">{String(o.opis_rada || '—')}</td>
              <td className="max-w-[200px] whitespace-pre-wrap px-2 py-1">{String(o.alat_pribor || '—')}</td>
              <td className="tnums px-2 py-1">{formatNum(o.planned_qty)}</td>
              <td className="tnums px-2 py-1">{formatNum(o.completed_qty)}</td>
              <td className="px-2 py-1">{formatDate(o.completed_at) || '—'}</td>
              <td className="px-2 py-1">{String(o.kontrola_status ?? '')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NapomenaModal({
  row,
  canManage,
  onClose,
  onSave,
}: {
  row: IzvestajRow;
  canManage: boolean;
  onClose: () => void;
  onSave: (note: string) => void;
}) {
  const [note, setNote] = useState(row.korisnicka_napomena ?? '');
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Napomena — ${row.naziv_pozicije ?? ''}`}
      footer={
        canManage ? (
          <>
            <Button variant="secondary" onClick={onClose}>
              Zatvori
            </Button>
            <Button onClick={() => onSave(note)}>Sačuvaj</Button>
          </>
        ) : (
          <Button variant="secondary" onClick={onClose}>
            Zatvori
          </Button>
        )
      }
    >
      {row.sistemska_napomena && (
        <p className="mb-3 text-xs text-ink-secondary">
          <strong>Sistemska:</strong> {row.sistemska_napomena}
        </p>
      )}
      {canManage ? (
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={6}
          placeholder="Unesi napomenu…"
          className="w-full rounded-control border border-line bg-surface px-3 py-2 text-base text-ink"
        />
      ) : (
        <p className="whitespace-pre-wrap text-sm text-ink">{note || '—'}</p>
      )}
    </Dialog>
  );
}

/**
 * Modal „Ručna količina" (docx §6): fizički urađeno a nije otkucano. Unos količine +
 * razlog → override; prazno / „Ukloni" vraća na automatski obračun. BE klampuje na
 * lansirano i sam postavlja efektivno „završeno".
 */
function ManualQtyModal({
  row,
  onClose,
  onSave,
}: {
  row: IzvestajRow;
  onClose: () => void;
  onSave: (manualQty: number | null, reason: string) => void;
}) {
  const current = rowManualQty(row);
  const [qty, setQty] = useState<string>(current != null ? String(current) : '');
  const [reason, setReason] = useState('');
  const lansirano = row.lansirana_kolicina;

  function submit() {
    const t = qty.trim();
    if (t === '') {
      onSave(null, '');
      return;
    }
    const n = Math.floor(Number(t));
    if (!Number.isFinite(n) || n < 0) {
      showToast('Količina mora biti ceo broj ≥ 0.');
      return;
    }
    onSave(n, reason);
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Ručna količina — ${row.naziv_pozicije ?? row.rn_broj ?? ''}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Zatvori
          </Button>
          {current != null && (
            <Button variant="secondary" onClick={() => onSave(null, '')}>
              Ukloni ručno
            </Button>
          )}
          <Button onClick={submit}>Sačuvaj</Button>
        </>
      }
    >
      <p className="mb-3 text-xs text-ink-secondary">
        Unesi fizički urađenu količinu koja nije evidentirana kucanjem. Zamenjuje izračunato „završeno"
        {lansirano != null ? ` (lansirano: ${formatNum(lansirano)} kom)` : ''}. Prazno polje = automatski obračun.
      </p>
      <label className="mb-3 block">
        <span className="mb-1 block text-2xs uppercase tracking-wider text-ink-secondary">Ručna količina (kom)</span>
        <Input
          type="number"
          min={0}
          step={1}
          value={qty}
          autoFocus
          onChange={(e) => setQty(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="npr. 12"
          className="w-40"
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-2xs uppercase tracking-wider text-ink-secondary">Razlog</span>
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder="Zašto se količina unosi ručno…" />
      </label>
    </Dialog>
  );
}

/** Modal „Premesti u sklop": ↩ Automatski / ⬆ Vrh / kandidati bez sebe i potomaka. */
function ReparentModal({
  row,
  rowsAll,
  onClose,
  onSave,
}: {
  row: IzvestajRow;
  rowsAll: IzvestajRow[];
  onClose: () => void;
  onSave: (payload: { parentRnId?: string | null; clear?: boolean }) => void;
}) {
  const self = String(row.node_id ?? '');
  const desc = useMemo(() => descendantsOf(rowsAll, self), [rowsAll, self]);
  const candidates = useMemo(
    () =>
      rowsAll
        .filter((r) => String(r.node_id) !== self && !desc.has(String(r.node_id)))
        .map((r) => ({
          id: String(r.node_id),
          label: `${r.naziv_pozicije ?? r.rn_broj ?? r.node_id}${r.rn_broj ? ` (${r.rn_broj})` : ''}`,
        }))
        .sort((a, b) => a.label.localeCompare(b.label, 'sr')),
    [rowsAll, self, desc],
  );

  const initial = row.has_parent_override
    ? row.parent_override_rn_id != null
      ? String(row.parent_override_rn_id)
      : '__root__'
    : '__auto__';
  const [sel, setSel] = useState(initial);

  function submit() {
    if (sel === '__auto__') onSave({ clear: true });
    else if (sel === '__root__') onSave({ parentRnId: null, clear: false });
    else onSave({ parentRnId: sel, clear: false });
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Premesti u sklop — ${row.naziv_pozicije ?? ''}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Zatvori
          </Button>
          <Button onClick={submit}>Sačuvaj</Button>
        </>
      }
    >
      <p className="mb-3 text-xs text-ink-secondary">Izaberi sklop pod koji ide ova pozicija (ručno gazi automatsku strukturu).</p>
      <select
        value={sel}
        onChange={(e) => setSel(e.target.value)}
        className="w-full rounded-control border border-line bg-surface px-3 py-2 text-sm text-ink"
      >
        <option value="__auto__">↩ Automatski (struktura sastavnice)</option>
        <option value="__root__">⬆ Vrh — bez sklopa</option>
        {candidates.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label}
          </option>
        ))}
      </select>
    </Dialog>
  );
}
