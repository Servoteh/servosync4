'use client';

import { useMemo, useState } from 'react';
import { ArrowLeft, ChevronRight, RefreshCw, ExternalLink, FileSpreadsheet, FileText, ArrowLeftRight, StickyNote } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { Input } from '@/components/ui-kit/form-field';
import { Dialog } from '@/components/ui-kit/dialog';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { cn } from '@/lib/cn';
import { useCan } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { toast as showToast } from '@/lib/toast';
import { applyParentOverrides, descendantsOf } from '@/lib/pracenje-tree';
import { exportIzvestajXlsx, exportIzvestajPdf } from '@/lib/pracenje-export';
import {
  usePredmetIzvestaj,
  usePodsklopovi,
  useUpsertNapomena,
  useUpsertOverride,
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

function formatNum(v: unknown): string {
  if (v == null || v === '') return '—';
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : '—';
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

function filterRows(rows: IzvestajRow[], filter: string): IzvestajRow[] {
  if (filter === 'sve') return rows;
  return rows.filter((r) => {
    const s = r.statusi ?? {};
    switch (filter) {
      case 'nije_kompletirano':
        return !!s.nije_kompletirano;
      case 'nema_tp':
        return !!s.nema_tp;
      case 'nema_crtez':
        return !!s.nema_crtez;
      case 'nema_zavrsnu_kontrolu':
        return !!s.nema_zavrsnu_kontrolu;
      case 'kasni':
        return !!s.kasni;
      case 'ima_napomenu':
        return String(r.korisnicka_napomena || r.sistemska_napomena || '').trim().length > 0;
      default:
        return true;
    }
  });
}

function maxOpSlots(rows: IzvestajRow[]): number {
  let m = 0;
  for (const r of rows) if (Array.isArray(r.operations)) m = Math.max(m, r.operations.length);
  return m;
}

async function openDrawing(code: string | null | undefined): Promise<void> {
  if (!code) return;
  try {
    const res = await fetchCrtezSignUrl(String(code));
    if (res.data?.url) window.open(res.data.url, '_blank', 'noopener,noreferrer');
  } catch (e) {
    showToast(e instanceof Error ? e.message : 'Crtež nije dostupan.');
  }
}

/**
 * DA/NE ćelija (1.0 daNeCell — tabelaPracenjaTab.js:82): BILO KOJI ne-prazan status
 * → „DA"; zeleno ako /urađeno|zavr|gotov|100/ i NE /nije|0\//, inače žuto DA;
 * pun tekst statusa u title tooltip. Ručni override gazi auto (⚑ oznaka).
 */
function daNe(auto: string | null | undefined, ovr: boolean | null | undefined): React.ReactNode {
  if (ovr === true || ovr === false) {
    return (
      <span className={ovr ? 'text-status-success' : 'text-ink-secondary'} title="Ručno postavljeno">
        {ovr ? 'DA' : 'NE'} ⚑
      </span>
    );
  }
  const s = String(auto ?? '').trim();
  if (!s || s === '—') return <span className="text-ink-secondary">NE</span>;
  const done = /urađeno|zavr|gotov|100/i.test(s) && !/nije|0\s*\//i.test(s);
  return (
    <span className={done ? 'text-status-success' : 'text-status-warn'} title={s}>
      DA
    </span>
  );
}

/** Ekran 2 — Tabela praćenja predmeta: kontrole + puna tabela + napomena/override/reparent + izvozi. */
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

  // Kontrole izveštaja (PR-13): Opseg (root RN), Lot, Filter, Matrični prikaz.
  const [scope, setScope] = useState<string>(rootRn ?? '');
  const [lot, setLot] = useState<number>(12);
  const [filter, setFilter] = useState<string>('sve');
  const [matrix, setMatrix] = useState<boolean>(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [noteFor, setNoteFor] = useState<IzvestajRow | null>(null);
  const [reparentFor, setReparentFor] = useState<IzvestajRow | null>(null);

  const q = usePredmetIzvestaj(itemId, scope || undefined, lot);
  const podsklopovi = usePodsklopovi(itemId);
  const napomena = useUpsertNapomena();
  const override = useUpsertOverride();
  const parentOverride = useUpsertParentOverride();

  const result = useMemo(() => normalizeIzvestajResult(q.data?.data), [q.data]);
  const rowsAll = result.rows ?? [];
  const { rows: rowsEff, parentIds } = useMemo(() => applyParentOverrides(rowsAll), [rowsAll]);
  const rows = useMemo(() => filterRows(rowsEff, filter), [rowsEff, filter]);
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

  function toggleExpand(node: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(node)) next.delete(node);
      else next.add(node);
      return next;
    });
  }

  async function doExportXlsx() {
    try {
      await exportIzvestajXlsx({ result, rows, filter, lot });
      logExport({ tab: 'tabela_pracenja_excel', predmetItemId: itemId, extra: { rows: rows.length } }).catch(() => {});
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Excel izvoz nije uspeo.');
    }
  }
  async function doExportPdf() {
    try {
      await exportIzvestajPdf({ result, rows, filter, lot });
      logExport({ tab: 'tabela_pracenja_pdf', predmetItemId: itemId, extra: { rows: rows.length } }).catch(() => {});
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'PDF izvoz nije uspeo.');
    }
  }

  const colCount = 16 + (matrix ? nSlots * 2 : 1);

  return (
    <div className="space-y-4">
      {/* Zaglavlje + kontrole (PR-13) */}
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
          Opseg
          <select
            value={scope}
            onChange={(e) => {
              setScope(e.target.value);
              setExpanded(new Set());
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

        <Button variant="secondary" onClick={() => q.refetch()} disabled={q.isFetching}>
          <RefreshCw className={cn('h-4 w-4', q.isFetching && 'animate-spin')} /> Osveži
        </Button>
        <Button variant="secondary" onClick={doExportXlsx} disabled={rows.length === 0}>
          <FileSpreadsheet className="h-4 w-4" /> Izvezi Excel
        </Button>
        <Button variant="secondary" onClick={doExportPdf} disabled={rows.length === 0}>
          <FileText className="h-4 w-4" /> Izvezi PDF
        </Button>
        <label className="flex items-center gap-1.5 text-xs text-ink">
          <input type="checkbox" checked={matrix} onChange={(e) => setMatrix(e.target.checked)} />
          Matrični prikaz
        </label>
      </div>

      {/* Legenda tipova (PR-14) */}
      <div className="flex flex-wrap items-center gap-4 text-xs text-ink-secondary">
        <LegendSwatch tone="bg-accent" label="Glavni sklop" />
        <LegendSwatch tone="bg-status-info" label="Podsklop" />
        <LegendSwatch tone="bg-status-warn" label="Zav. sklop" />
        <LegendSwatch tone="bg-status-neutral" label="Pojedinačna" />
      </div>

      {q.isLoading ? (
        <div className="rounded-panel border border-line bg-surface px-4 py-10 text-center text-sm text-ink-secondary">Učitavanje…</div>
      ) : rows.length === 0 ? (
        <EmptyState title="Nema podataka praćenja za predmet" />
      ) : (
        <div className="max-h-[min(72vh,800px)] overflow-auto rounded-panel border border-line bg-surface">
          <table className="w-full min-w-[1200px] text-sm">
            <thead className="sticky top-0 z-20 bg-surface-2">
              <tr className="border-b border-line text-left text-2xs uppercase tracking-wider text-ink-secondary">
                <th className="sticky left-0 z-30 min-w-[200px] bg-surface-2 px-3 py-1.5">Pozicija</th>
                <th className="px-3 py-1.5" title="Link crteža">Crtež</th>
                <th className="px-3 py-1.5" title="Link sklopa">Sklop</th>
                <th className="px-3 py-1.5">RN</th>
                <th className="px-3 py-1.5" title="Lansirana količina">Lansirano</th>
                <th className="px-3 py-1.5" title="Završena količina (ZK)">Završeno</th>
                <th className="px-3 py-1.5" title="Potrebno za izabrani lot">Za lot</th>
                <th className="px-3 py-1.5" title="Raspoloživo / kompletirano za lot">Rasp./lot</th>
                <th className="px-3 py-1.5" title="Datum lansiranja TP">Lans. TP</th>
                <th className="px-3 py-1.5" title="Rok / datum izrade">Rok izr.</th>
                <th className="px-3 py-1.5 text-center" title="Mašinska obrada (DA/NE)">Maš.</th>
                <th className="px-3 py-1.5 text-center" title="Površinska zaštita (DA/NE)">Površ.</th>
                <th className="px-3 py-1.5">Materijal</th>
                <th className="px-3 py-1.5">Dimenzije</th>
                <th className="px-3 py-1.5 text-center">Napomena</th>
                <th className="px-3 py-1.5">Status</th>
                {matrix ? (
                  Array.from({ length: nSlots }, (_, i) => (
                    <FragTh key={i}>
                      <th className="px-3 py-1.5">Operacija {i + 1}</th>
                      <th className="px-3 py-1.5">Kol. {i + 1}</th>
                    </FragTh>
                  ))
                ) : (
                  <th className="px-3 py-1.5">Operacije</th>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const node = String(r.node_id ?? '');
                const st = r.statusi;
                const typ = rowSklopType(r, parentIds);
                const open = expanded.has(node);
                const indent = 12 + Number(r.level ?? 0) * 16;
                const hasNote = String(r.korisnicka_napomena || '').trim().length > 0;
                const hasSys = String(r.sistemska_napomena || '').trim().length > 0;
                const boldNaziv = typ === 'glavni' || typ === 'pod' || typ === 'zav';
                return (
                  <FragRow key={node}>
                    <tr className={cn('border-b border-line-soft hover:bg-surface-2', rowIsProblem(st) && 'bg-status-warn-bg/30')}>
                      <td
                        className="sticky left-0 z-10 min-w-[200px] bg-surface px-3 py-1.5"
                        style={{ paddingLeft: indent }}
                      >
                        <div className="flex items-center gap-1.5">
                          <button
                            onClick={() => toggleExpand(node)}
                            className="rounded-control p-0.5 text-ink-secondary hover:bg-surface-2"
                            title="Operacije"
                          >
                            <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-90')} />
                          </button>
                          <span className={cn('text-ink', boldNaziv && 'font-bold')}>{r.naziv_pozicije ?? r.naziv_dela ?? '—'}</span>
                          <TypBadge typ={typ} />
                          {r.has_parent_override && (
                            <span className="rounded-full bg-status-info-bg px-1.5 py-0.5 text-2xs text-status-info" title="Ručno premešteno u sklop">
                              ↪ ručno
                            </span>
                          )}
                          {canManage && (
                            <button
                              onClick={() => setReparentFor(r)}
                              className="rounded-control p-0.5 text-ink-secondary hover:bg-surface-2"
                              title="Premesti u sklop"
                            >
                              <ArrowLeftRight className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-1.5 text-xs">
                        <DrawingCell code={r.crtez_drawing_no} label={r.broj_crteza ?? r.crtez_drawing_no} hasFile={r.has_crtez_file} />
                      </td>
                      <td className="px-3 py-1.5 text-xs">
                        <DrawingCell code={r.sklop_drawing_no} label={r.broj_sklopnog_crteza ?? r.sklop_drawing_no} hasFile={r.has_skop_crtez_file} dash />
                      </td>
                      <td className="px-3 py-1.5 text-xs">
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
                      <td className="tnums px-3 py-1.5 text-xs">{formatNum(r.lansirana_kolicina)}</td>
                      <td className="tnums px-3 py-1.5 text-xs">{formatNum(r.zavrsena_kolicina)}</td>
                      <td className="tnums px-3 py-1.5 text-xs">{r.required_for_lot == null ? 'N/A' : formatNum(r.required_for_lot)}</td>
                      <td className="tnums px-3 py-1.5 text-xs">
                        {formatNum(r.raspolozivo_za_montazu)} / {formatNum(r.kompletirano_za_lot)}
                      </td>
                      <td className="px-3 py-1.5 text-xs">{r.datum_lansiranja_tp ?? '—'}</td>
                      <td className="px-3 py-1.5 text-xs">{r.datum_izrade ?? '—'}</td>
                      <td className="px-3 py-1.5 text-center text-xs">{daNe(r.masinska_obrada_status, r.masinska_done_override)}</td>
                      <td className="px-3 py-1.5 text-center text-xs">{daNe(r.povrsinska_zastita_status, r.povrsinska_done_override)}</td>
                      <td className="px-3 py-1.5 text-xs">{r.materijal ?? '—'}</td>
                      <td className="px-3 py-1.5 text-xs">{r.dimenzije ?? '—'}</td>
                      <td className="px-3 py-1.5 text-center">
                        <button
                          onClick={() => setNoteFor(r)}
                          className={cn(
                            'relative rounded-control p-1 hover:bg-surface-2',
                            hasNote ? 'text-accent' : 'text-ink-secondary',
                          )}
                          title={hasNote ? String(r.korisnicka_napomena) : canManage ? 'Dodaj napomenu' : 'Nema napomene'}
                          aria-label="Napomena"
                        >
                          <StickyNote className="h-3.5 w-3.5" />
                          {(hasNote || hasSys) && <span className="absolute -right-0 -top-0 h-1.5 w-1.5 rounded-full bg-status-warn" />}
                        </button>
                      </td>
                      <td className="px-3 py-1.5">
                        {canManage ? (
                          <select
                            value={r.status_override ?? ''}
                            onChange={(e) => override.mutate({ itemId, bigtehnRnId: node, rnId: r.rn_id ?? undefined, status: e.target.value })}
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
                        ) : r.status_override ? (
                          <span className="text-xs text-ink" title="Ručno postavljeno">
                            {STATUS_OVR_LABEL[r.status_override] ?? r.status_override} <span className="text-ink-secondary">ručno</span>
                          </span>
                        ) : (
                          <span className="text-xs text-ink-secondary">{statusBitsText(st)}</span>
                        )}
                        {canManage && <div className="mt-0.5 text-2xs text-ink-secondary">{statusBitsText(st)}</div>}
                      </td>
                      {matrix ? (
                        Array.from({ length: nSlots }, (_, i) => {
                          const o = (r.operations ?? [])[i];
                          if (!o) return <FragTh key={i}><td className="px-3 py-1.5 text-xs">—</td><td className="px-3 py-1.5 text-xs">—</td></FragTh>;
                          const label = opLabel(o);
                          const num = String(o.naziv ?? '').trim();
                          const title = num && num !== label ? `${label} (op. ${num})` : label;
                          return (
                            <FragTh key={i}>
                              <td className="px-3 py-1.5 text-xs" title={title}>{label.slice(0, 24)}{label.length > 24 ? '…' : ''}</td>
                              <td className="tnums px-3 py-1.5 text-xs">{formatNum(o.completed_qty)}/{formatNum(o.planned_qty)}</td>
                            </FragTh>
                          );
                        })
                      ) : (
                        <td className="px-3 py-1.5 text-xs">{opsSummary(r)}</td>
                      )}
                    </tr>
                    {open && Array.isArray(r.operations) && r.operations.length > 0 && (
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

      {/* Footer sumar (PR-14) */}
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
  return <span className={cn('rounded-full px-1.5 py-0.5 text-2xs', tone)}>{SKLOP_TYPE_LABEL[typ]}</span>;
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
      className="rounded-control px-1.5 py-0.5 text-accent hover:bg-surface-2 disabled:text-ink-disabled disabled:hover:bg-transparent"
      title={hasFile ? 'Otvori crtež' : 'Nema fajla u kešu'}
    >
      {label ?? code}
    </button>
  );
}

/** Podtabela SVIH operacija reda (PR-15). */
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
              <td className="px-2 py-1">{o.completed_at ? String(o.completed_at).slice(0, 10) : '—'}</td>
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

/** Modal „Premesti u sklop" (PR-17): ↩ Automatski / ⬆ Vrh / kandidati bez sebe i potomaka. */
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
      <p className="mb-3 text-xs text-ink-secondary">Izaberi sklop pod koji ide ova pozicija (ručno gazi BigTehn strukturu).</p>
      <select
        value={sel}
        onChange={(e) => setSel(e.target.value)}
        className="w-full rounded-control border border-line bg-surface px-3 py-2 text-sm text-ink"
      >
        <option value="__auto__">↩ Automatski (BigTehn struktura)</option>
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
