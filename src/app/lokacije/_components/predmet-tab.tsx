'use client';

import { useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  Eye,
  FileText,
  Filter,
  Hash,
  MapPin,
  Package,
  Printer,
  RotateCcw,
  Search,
} from 'lucide-react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { Button } from '@/components/ui-kit/button';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { Dialog } from '@/components/ui-kit/dialog';
import { Can } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { apiFetch } from '@/api/client';
import { openDrawingPdf, type Drawing } from '@/api/pdm';
import { usePredmetTps, usePrintLocLabel, type PredmetTpRow } from '@/api/lokacije';
import { buildTspLabelProgram } from '@/lib/tspl2';
import { labelDate } from '@/lib/label-print';
import { TpProcedureModal } from '@/app/plan-proizvodnje/_components/tp-procedure-modal';
import { tableEmpty } from './common';
import { barcodeForRow } from './label-build';

const INPUT = 'h-9 rounded-control border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-accent';
const PAGE_SIZE_OPTIONS = [50, 100, 200, 500] as const;

type LocationFilter = 'all' | 'with' | 'without';

const toNum = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Otvori PDF crteža preko 2.0 PDM (rezolucija broja crteža → id). */
async function openDrawingByNumber(drawingNumber: string) {
  try {
    const res = await apiFetch<{ data: Drawing[] }>(
      `/v1/pdm/drawings?q=${encodeURIComponent(drawingNumber)}&pageSize=5`,
    );
    const hit = res.data.find((d) => d.drawingNumber === drawingNumber) ?? res.data[0];
    if (hit) await openDrawingPdf(hit.id);
    else alert(`Crtež ${drawingNumber} nije nađen u PDM-u.`);
  } catch {
    alert('PDF crteža trenutno nije dostupan.');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Op-status (BigTehn) — read-only iz loc_get_bigtehn_op_status (meta.opStatus)
// ═══════════════════════════════════════════════════════════════════════════

interface OpStatusOp {
  operation_code?: string | number;
  operation_name?: string;
  machine_code?: string;
  machine_name?: string;
  qty_finished?: number | string;
  qty_in_process?: number | string;
  status?: string;
  operators?: string;
  last_finished_at?: string;
  last_started_at?: string;
}
interface OpStatusResult {
  ok?: boolean;
  error?: string;
  work_order?: { ident_broj?: string; broj_crteza?: string; komada_total?: number | string; naziv_dela?: string };
  operations?: OpStatusOp[];
}

/** „pre 2h", „juče 14:32", „2026-04-12 09:00" — kompaktan format (port 1.0 formatRelativeTime). */
function relTime(iso?: string): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const diffMs = Date.now() - t;
  const diffH = diffMs / 3_600_000;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (diffH < 1) return `pre ${Math.max(0, Math.round(diffMs / 60000))} min`;
  if (diffH < 24) return `pre ${Math.round(diffH)} h`;
  const d = new Date(t);
  if (diffH < 48) return `juče ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function OpStatusDialog({
  predmetId,
  workOrderId,
  filters,
  onClose,
}: {
  predmetId: string;
  workOrderId: string;
  filters: { onlyOpen: boolean; includeAssembled: boolean };
  onClose: () => void;
}) {
  // Namenski upit (pageSize:1) — samo `meta.opStatus`, ne dira glavnu listu (drugačiji key).
  const q = usePredmetTps(predmetId, {
    onlyOpen: filters.onlyOpen,
    includeAssembled: filters.includeAssembled,
    workOrderId,
    pageSize: 1,
  });
  const res = (q.data?.meta.opStatus ?? null) as OpStatusResult | null;
  const wo = res?.work_order ?? {};
  const ops = res?.operations ?? [];
  const totalKom = toNum(wo.komada_total) ?? 0;

  return (
    <Dialog open onClose={onClose} title="Operativni status (BigTehn)" size="xl2">
      {q.isLoading ? (
        <p className="py-8 text-center text-sm text-ink-secondary">Učitavam operacije…</p>
      ) : !res || res.ok === false ? (
        <p className="py-8 text-center text-sm text-status-danger">
          Nije moguće učitati operativni status
          {res?.error ? <>: <code>{res.error}</code></> : null}
          {res?.error === 'work_order_not_found' && <><br />RN možda nije u BigTehn kešu.</>}
        </p>
      ) : (
        <div className="space-y-3">
          <div className="rounded-panel border border-line bg-surface-2 px-4 py-3">
            <div className="text-2xs uppercase tracking-wider text-ink-secondary">RN</div>
            <div className="text-md font-semibold text-ink">{wo.ident_broj || '—'}</div>
            <div className="mt-1 flex flex-wrap gap-x-5 gap-y-1 text-sm text-ink-secondary">
              {wo.broj_crteza && <span><strong className="text-ink">Crtež:</strong> {wo.broj_crteza}</span>}
              {wo.komada_total != null && <span><strong className="text-ink">Komada:</strong> {String(wo.komada_total)}</span>}
              {wo.naziv_dela && <span>{String(wo.naziv_dela).slice(0, 80)}</span>}
            </div>
          </div>
          <p className="text-xs text-ink-secondary">
            Read-only iz <code>bigtehn_tech_routing_cache</code>. „U radu" = prijave bez završetka; „Gotovo" =
            prijave sa <code>is_completed</code>. Brojevi su <em>per operacija</em>, ne TP-level total.
          </p>
          {ops.length === 0 ? (
            <p className="py-6 text-center text-sm text-ink-disabled">Nema operacija u BigTehn-u za ovaj RN (ili keš nije svež).</p>
          ) : (
            <div className="overflow-x-auto rounded-panel border border-line">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line bg-surface-2 text-left text-2xs uppercase tracking-wider text-ink-secondary">
                    <th className="px-3 py-2">Op #</th>
                    <th className="px-3 py-2">Naziv</th>
                    <th className="px-3 py-2">Mašina</th>
                    <th className="px-3 py-2 text-right">Gotovo</th>
                    <th className="px-3 py-2 text-right">U radu</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Operater(i)</th>
                    <th className="px-3 py-2">Vreme</th>
                  </tr>
                </thead>
                <tbody>
                  {ops.map((op, i) => {
                    const fin = toNum(op.qty_finished) ?? 0;
                    const inP = toNum(op.qty_in_process) ?? 0;
                    const finPct = totalKom > 0 ? Math.round((fin / totalKom) * 100) : null;
                    const st = String(op.status || '');
                    return (
                      <tr key={`${op.operation_code}-${i}`} className="border-b border-line-soft last:border-0">
                        <td className="tnums px-3 py-2">{String(op.operation_code ?? '')}</td>
                        <td className="px-3 py-2">{String(op.operation_name || '').slice(0, 40) || '—'}</td>
                        <td className="px-3 py-2">
                          {op.machine_code ? (
                            <>
                              <span className="tnums">{op.machine_code}</span>
                              {op.machine_name && <div className="text-2xs text-ink-secondary">{op.machine_name}</div>}
                            </>
                          ) : '—'}
                        </td>
                        <td className="tnums px-3 py-2 text-right">
                          {fin > 0 ? (
                            <>
                              <strong>{fin}</strong>
                              {totalKom > 0 && <span className="text-2xs text-ink-secondary"> / {totalKom}{finPct != null ? ` · ${finPct}%` : ''}</span>}
                            </>
                          ) : <span className="text-ink-disabled">0</span>}
                        </td>
                        <td className="tnums px-3 py-2 text-right">{inP > 0 ? <strong className="text-status-info">{inP}</strong> : <span className="text-ink-disabled">—</span>}</td>
                        <td className="px-3 py-2">
                          {st === 'DONE' ? <StatusBadge tone="success" label="Završeno" />
                            : st === 'IN_PROGRESS' ? <StatusBadge tone="info" label="U radu" />
                            : <StatusBadge tone="neutral" label="Nije počelo" />}
                        </td>
                        <td className="px-3 py-2 text-xs text-ink-secondary">{op.operators ? String(op.operators).slice(0, 60) : '—'}</td>
                        <td className="px-3 py-2 text-xs text-ink-secondary">
                          {op.last_finished_at ? `završeno: ${relTime(op.last_finished_at)}`
                            : op.last_started_at ? `od: ${relTime(op.last_started_at)}` : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Stat kartica
// ═══════════════════════════════════════════════════════════════════════════

function StatCard({
  icon,
  label,
  value,
  hint,
  tone = 'neutral',
  loading,
}: {
  icon: ReactNode;
  label: string;
  value: number | null;
  hint: string;
  tone?: 'neutral' | 'success' | 'warn' | 'accent';
  loading?: boolean;
}) {
  const valueColor =
    tone === 'success' ? 'text-status-success'
    : tone === 'warn' ? 'text-status-warn'
    : tone === 'accent' ? 'text-accent'
    : 'text-ink';
  return (
    <div className="rounded-panel border border-line bg-surface p-4">
      <div className="flex items-center gap-2 text-ink-secondary">
        <span aria-hidden>{icon}</span>
        <span className="text-2xs uppercase tracking-wider">{label}</span>
      </div>
      <div className={`tnums mt-1 text-2xl font-semibold ${valueColor}`}>
        {loading || value == null ? <span className="text-ink-disabled">—</span> : value}
      </div>
      <div className="mt-0.5 text-2xs text-ink-disabled">{hint}</div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Predmet tab
// ═══════════════════════════════════════════════════════════════════════════

/** Pregled predmeta — TP-ovi + placement + op-status (loc_tps_for_predmet), pun paritet 1.0. */
export function PredmetTab() {
  const [predmetInput, setPredmetInput] = useState('');
  const [predmetId, setPredmetId] = useState<string | null>(null);

  if (!predmetId) {
    return <PredmetPicker input={predmetInput} setInput={setPredmetInput} onPick={setPredmetId} />;
  }
  return <PredmetDataView predmetId={predmetId} onChange={() => { setPredmetId(null); setPredmetInput(''); }} />;
}

// ─────────────────────────────────────────────── Ekran 1 — izbor predmeta

function PredmetPicker({
  input,
  setInput,
  onPick,
}: {
  input: string;
  setInput: (v: string) => void;
  onPick: (id: string) => void;
}) {
  const trimmed = input.trim();
  const valid = /^\d+$/.test(trimmed);
  return (
    <div className="space-y-3">
      <div className="rounded-panel border border-line bg-surface p-4">
        <div className="flex items-start gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-control bg-accent-subtle text-accent">
            <Search className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-md font-semibold text-ink">Izaberi predmet</h3>
            <p className="mt-0.5 text-sm text-ink-secondary">
              Unesi ID (broj) predmeta iz BigTehn-a. Posle izbora vidiš sve njegove tehnološke postupke sa
              lokacijama, količinama i operativnim statusom.
            </p>
          </div>
        </div>
      </div>

      <form
        className="rounded-panel border border-line bg-surface p-4"
        onSubmit={(e) => { e.preventDefault(); if (valid) onPick(trimmed); }}
      >
        <label className="mb-2 block text-2xs uppercase tracking-wider text-ink-secondary">ID predmeta</label>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-56">
            <Hash className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-disabled" />
            <input
              className={`${INPUT} w-full pl-8`}
              placeholder="npr. 24187"
              value={input}
              inputMode="numeric"
              autoFocus
              onChange={(e) => setInput(e.target.value.replace(/[^\d]/g, ''))}
            />
          </div>
          <Button type="submit" disabled={!valid}>
            <Search className="h-4 w-4" /> Učitaj predmet
          </Button>
        </div>
        <p className="mt-2 text-xs text-ink-disabled">
          Prikazuju se samo radni nalozi koje je MES označio kao aktivne (nije ceo spisak RN iz BigTehn-a).
        </p>
      </form>
    </div>
  );
}

// ─────────────────────────────────────────────── Ekran 2 — podaci predmeta

function PredmetDataView({ predmetId, onChange }: { predmetId: string; onChange: () => void }) {
  // Draft (u formi) vs primenjeni filteri — „Primeni" / Enter komituje draft.
  const [draft, setDraft] = useState({ tpNo: '', drawingNo: '', locationFilter: 'all' as LocationFilter, includeAssembled: false });
  const [filters, setFilters] = useState(draft);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<number>(100);
  const [opWoId, setOpWoId] = useState<string | null>(null);
  const [tpModalWo, setTpModalWo] = useState<string | null>(null);

  const baseParams = {
    onlyOpen: true,
    includeAssembled: filters.includeAssembled,
    tpNo: filters.tpNo || undefined,
    drawingNo: filters.drawingNo || undefined,
  };

  const q = usePredmetTps(predmetId, { ...baseParams, locationFilter: filters.locationFilter, page: page + 1, pageSize });
  // Brojači za stat kartice (pageSize:1 — samo total; posebni query key-evi).
  const withQ = usePredmetTps(predmetId, { ...baseParams, locationFilter: 'with', pageSize: 1 });
  const withoutQ = usePredmetTps(predmetId, { ...baseParams, locationFilter: 'without', pageSize: 1 });

  const rows = q.data?.data.rows ?? [];
  const total = q.data?.data.total ?? 0;
  const totalWith = withQ.data?.data.total ?? null;
  const totalWithout = withoutQ.data?.data.total ?? null;
  const totalAll = totalWith != null && totalWithout != null ? totalWith + totalWithout : null;
  const pct = totalAll && totalAll > 0 && totalWith != null ? Math.round((totalWith / totalAll) * 100) : 0;

  const print = usePrintLocLabel();

  function apply() {
    setFilters(draft);
    setPage(0);
  }
  function reset() {
    const empty = { tpNo: '', drawingNo: '', locationFilter: 'all' as LocationFilter, includeAssembled: false };
    setDraft(empty);
    setFilters(empty);
    setPage(0);
  }

  async function printTp(r: PredmetTpRow) {
    const bc = barcodeForRow({
      itemRefTable: 'bigtehn_rn',
      orderNo: r.wo_ident_broj,
      itemRefId: r.tp_no,
      drawingNo: r.wo_broj_crteza,
    });
    if (!bc) return alert('Za ovaj TP nema prepoznatljivog barkoda (RNZ / kratki format).');
    const tspl2 = buildTspLabelProgram({
      fields: {
        brojPredmeta: r.wo_ident_broj,
        nazivDela: r.naziv_dela,
        brojCrteza: r.wo_broj_crteza,
        materijal: [r.materijal, r.dimenzija_materijala].filter(Boolean).join(' '),
        kolicina: r.komada_rn != null ? String(r.komada_rn) : '',
        datum: labelDate(),
      },
      barcodeValue: bc,
      copies: 1,
    });
    try {
      await print.mutateAsync({ tspl2, copies: 1 });
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Štampa nije uspela.');
    }
  }

  const columns: Column<PredmetTpRow>[] = [
    { key: 'ident', header: 'RN (Predmet/TP)', render: (r) => <span className="font-medium">{r.wo_ident_broj || '—'}</span> },
    { key: 'tp', header: 'TP #', render: (r) => <span className="tnums">{r.tp_no || '—'}</span> },
    {
      key: 'crtez',
      header: 'Crtež',
      render: (r) => (
        <span className="tnums inline-flex items-center gap-1.5">
          {r.wo_broj_crteza || '—'}
          {r.wo_broj_crteza && r.has_pdf === true && (
            <button
              onClick={(e) => { e.stopPropagation(); void openDrawingByNumber(String(r.wo_broj_crteza)); }}
              className="text-accent hover:opacity-80"
              title={`Otvori PDF crteža ${r.wo_broj_crteza}`}
              aria-label="PDF crteža"
            >
              <FileText className="h-3.5 w-3.5" />
            </button>
          )}
        </span>
      ),
    },
    { key: 'naziv', header: 'Naziv dela', render: (r) => String(r.naziv_dela ?? '').slice(0, 80) || '—' },
    { key: 'qty', header: 'Količina (lok / RN)', align: 'right', render: (r) => <QtyCell r={r} /> },
    { key: 'loc', header: 'Lokacija', render: (r) => <LocCell r={r} /> },
    {
      key: 'mat',
      header: 'Materijal',
      render: (r) => (
        <span className="text-xs">
          {r.materijal || '—'}
          {r.dimenzija_materijala && <span className="tnums text-ink-secondary"> {r.dimenzija_materijala}</span>}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (r) => (
        <div className="flex items-center justify-end gap-1.5">
          {r.work_order_id != null && (
            <button
              className="rounded-control border border-line px-2 py-1 text-xs text-ink-secondary hover:bg-surface-2"
              title="Operativni status iz BigTehn-a (mašine, komada po operaciji)"
              onClick={(e) => { e.stopPropagation(); setOpWoId(String(r.work_order_id)); }}
            >
              ⚙ Op
            </button>
          )}
          <Can permission={PERMISSIONS.LOKACIJE_LABELS}>
            <button
              className="rounded-control border border-line px-2 py-1 text-xs text-ink-secondary hover:bg-surface-2"
              title="Nalepnica TP"
              onClick={(e) => { e.stopPropagation(); void printTp(r); }}
            >
              <Printer className="h-3.5 w-3.5" />
            </button>
          </Can>
        </div>
      ),
    },
  ];

  const from = total === 0 ? 0 : page * pageSize + 1;
  const to = page * pageSize + rows.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const isLast = (page + 1) * pageSize >= total;

  const activePills: string[] = [];
  if (filters.tpNo) activePills.push(`TP: ${filters.tpNo}`);
  if (filters.drawingNo) activePills.push(`crtež: ${filters.drawingNo}`);
  if (filters.locationFilter === 'with') activePills.push('samo sa lokacijom');
  if (filters.locationFilter === 'without') activePills.push('samo BEZ lokacije');
  activePills.push('aktivni RN');
  if (filters.includeAssembled) activePills.push('+ ugrađeni');

  const statLoading = withQ.isLoading || withoutQ.isLoading;

  return (
    <div className="space-y-3">
      {/* Hero */}
      <div className="flex items-center gap-3 rounded-panel border border-line bg-surface p-4">
        <div className="grid h-11 w-11 shrink-0 place-items-center rounded-control bg-accent-subtle text-accent">
          <Hash className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-2xs uppercase tracking-wider text-ink-secondary">Izabrani predmet</div>
          <div className="truncate text-md font-semibold text-ink">
            Predmet #{predmetId}
            <StatusBadge tone="success" label="U TOKU" />
          </div>
        </div>
        <Button variant="secondary" onClick={onChange}>
          <RotateCcw className="h-4 w-4" /> Promeni predmet
        </Button>
      </div>

      {/* Stat kartice */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={<Package className="h-4 w-4" />} label="Ukupno stavki" value={totalAll} hint="aktivnih u predmetu" loading={statLoading} />
        <StatCard icon={<MapPin className="h-4 w-4" />} label="Sa lokacijom" value={totalWith} hint={`${pct}% identifikovano`} tone="success" loading={statLoading} />
        <StatCard icon={<AlertTriangle className="h-4 w-4" />} label="Bez lokacije" value={totalWithout} hint={totalWithout ? 'potrebno definisati' : 'sve sređeno'} tone={totalWithout ? 'warn' : 'neutral'} loading={statLoading} />
        <StatCard icon={<Eye className="h-4 w-4" />} label="Prikazano" value={total} hint="po trenutnim filterima" tone="accent" loading={q.isLoading} />
      </div>

      {/* Filteri */}
      <div className="rounded-panel border border-line bg-surface p-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex-1 min-w-40">
            <span className="mb-1 block text-2xs uppercase tracking-wider text-ink-secondary">Broj TP</span>
            <input
              className={`${INPUT} w-full`}
              value={draft.tpNo}
              maxLength={12}
              inputMode="numeric"
              placeholder="Prefiks ili ceo TP (npr. 20 ili 568)…"
              title="Prefiks pretraga: „20“ uključuje sve TP koji počinju sa 20 (20, 200, 201…)."
              onChange={(e) => setDraft((d) => ({ ...d, tpNo: e.target.value }))}
              onKeyDown={(e) => { if (e.key === 'Enter') apply(); }}
            />
          </label>
          <label className="flex-1 min-w-40">
            <span className="mb-1 block text-2xs uppercase tracking-wider text-ink-secondary">Broj crteža</span>
            <input
              className={`${INPUT} w-full`}
              value={draft.drawingNo}
              maxLength={40}
              placeholder="Prefiks broja crteža…"
              onChange={(e) => setDraft((d) => ({ ...d, drawingNo: e.target.value }))}
              onKeyDown={(e) => { if (e.key === 'Enter') apply(); }}
            />
          </label>
          <label className="min-w-44">
            <span className="mb-1 block text-2xs uppercase tracking-wider text-ink-secondary">Lokacija</span>
            <select
              className={`${INPUT} w-full`}
              value={draft.locationFilter}
              onChange={(e) => { const v = e.target.value as LocationFilter; setDraft((d) => ({ ...d, locationFilter: v })); setFilters((f) => ({ ...f, locationFilter: v })); setPage(0); }}
            >
              <option value="all">Svi (sa i bez lokacije)</option>
              <option value="with">Samo sa lokacijom</option>
              <option value="without">Samo BEZ lokacije</option>
            </select>
          </label>
          <label className="flex items-center gap-1.5 pb-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={draft.includeAssembled}
              onChange={(e) => { const v = e.target.checked; setDraft((d) => ({ ...d, includeAssembled: v })); setFilters((f) => ({ ...f, includeAssembled: v })); setPage(0); }}
            />
            Prikaži ugrađene / otpisane
          </label>
          <label className="flex cursor-default items-center gap-1.5 pb-2 text-sm text-ink-disabled" title="Prikazuju se samo RN koje je MES označio kao aktivne.">
            <input type="checkbox" checked disabled />
            Samo aktivni RN
          </label>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button onClick={apply}><Filter className="h-4 w-4" /> Primeni filtere</Button>
          <Button variant="secondary" onClick={reset}><RotateCcw className="h-4 w-4" /> Resetuj</Button>
        </div>
        <p className="mt-2 text-xs text-ink-disabled">
          TP i crtež se filtriraju od <strong>početka</strong> broja (prefiks). Isti crtež / RN može imati{' '}
          <strong>više redova</strong> — po jedan za svaku policu i količinu na njoj; redovi bez lokacije su još neraspoređeni.
        </p>
      </div>

      {/* Summary bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-panel border border-line bg-surface-2/50 px-3 py-2 text-sm">
        <span className="text-ink-secondary">
          Predmet <strong className="text-ink">#{predmetId}</strong> · prikazano{' '}
          <strong className="text-ink tnums">{total === 0 ? '0–0' : `${from}–${to}`}</strong> od <strong className="text-ink tnums">{total}</strong>
        </span>
        <span className="flex flex-wrap gap-1">
          {activePills.map((p) => (
            <span key={p} className="rounded-full bg-accent-subtle px-2 py-0.5 text-2xs text-accent">{p}</span>
          ))}
        </span>
      </div>

      {/* Tabela */}
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => `${r.work_order_id}|${r.tp_no}|${r.location_code ?? ''}`}
        loading={q.isLoading}
        onRowActivate={(r) => { if (r.work_order_id != null) setTpModalWo(String(r.work_order_id)); }}
        empty={tableEmpty(q.isError, 'Nema tehnoloških postupaka', 'Pokušaj sa drugačijim filterima.')}
      />

      {/* Pagination */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-1.5 text-xs text-ink-secondary">
          <span>Po stranici</span>
          <select
            className="h-8 rounded-control border border-line bg-surface px-2 text-xs text-ink outline-none focus:border-accent"
            value={pageSize}
            onChange={(e) => { setPageSize(Number(e.target.value)); setPage(0); }}
          >
            {PAGE_SIZE_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <div className="flex items-center gap-2 text-sm text-ink-secondary">
          <span className="tnums">Strana {page + 1} od {totalPages}</span>
          <Button variant="secondary" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}>Prethodna</Button>
          <Button variant="secondary" onClick={() => setPage((p) => p + 1)} disabled={isLast}>Sledeća</Button>
        </div>
      </div>

      {opWoId && (
        <OpStatusDialog
          predmetId={predmetId}
          workOrderId={opWoId}
          filters={{ onlyOpen: true, includeAssembled: filters.includeAssembled }}
          onClose={() => setOpWoId(null)}
        />
      )}
      {tpModalWo && <TpProcedureModal workOrderId={tpModalWo} onClose={() => setTpModalWo(null)} />}
    </div>
  );
}

// ─────────────────────────────────────────────── ćelije

function QtyCell({ r }: { r: PredmetTpRow }) {
  const komRn = toNum(r.komada_rn);
  const placed = toNum(r.qty_total_placed) ?? 0;
  const qtyOnLoc = toNum(r.qty_on_location);
  const allPlaced = komRn != null && placed > 0 && placed >= komRn;

  let cls = 'bg-status-neutral-bg text-status-neutral';
  let text = '—';
  if (qtyOnLoc != null) {
    if (komRn != null && qtyOnLoc >= komRn) cls = 'bg-status-success-bg text-status-success';
    else if (qtyOnLoc > 0) cls = 'bg-status-warn-bg text-status-warn';
    text = String(qtyOnLoc);
  }
  return (
    <span className="inline-flex flex-col items-end gap-0.5">
      <span>
        <span className={`tnums rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{text}</span>
        {komRn != null && <span className="tnums text-xs text-ink-secondary"> / {komRn}</span>}
      </span>
      {allPlaced && <span className="text-2xs text-status-success">✓ raspoređeno</span>}
    </span>
  );
}

function LocCell({ r }: { r: PredmetTpRow }) {
  if (!r.location_code) return <span className="text-ink-disabled">— bez lokacije —</span>;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="inline-flex items-center gap-1 rounded-full bg-accent-subtle px-2 py-0.5 text-xs text-accent">
        <MapPin className="h-3 w-3" />
        <span className="tnums">{r.location_code}</span>
      </span>
      {r.location_name && <span className="text-xs text-ink-secondary">{r.location_name}</span>}
    </span>
  );
}
