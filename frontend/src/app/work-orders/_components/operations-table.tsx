'use client';

import { Pencil, Trash2 } from 'lucide-react';
import { formatNumber } from '@/lib/format';
import type { WorkOrderOperation } from '@/api/work-orders';
import type { OperationEstimate, CrtezIstorija, DrawingOrderRow } from '@/api/time-estimate';

/** sr-RS format za norme/ukupno (do 3 decimale, decimalni zarez). */
const fmtNum = (n: number) => n.toLocaleString('sr-RS', { maximumFractionDigits: 3 });
/** Kompaktan h (do 2 decimale) za kolonu procene. */
const fmtH = (n: number) => n.toLocaleString('sr-RS', { maximumFractionDigits: 2 });

/**
 * Ćelija „Slični poslovi (RM)" (TALAS AI-5): koliko slični poslovi STVARNO traju
 * PO KOMADU na tom radnom mestu, iz istorije prijava rada — interval p25–p75 sa
 * medijanom i brojem opservacija (n). NIJE norma i NE menja Tpz/Tk: samo uvid.
 *
 * Review ispravke: (16) za n < 3 se NE crta interval koji sugeriše raspodelu koje
 * nema — prikaže se samo pojedinačna vrednost (median). (8) uz h/kom se daje i
 * „≈ h/nalog" (median × količina) da bude uporedivo sa kolonom „Ukupno" (po nalogu).
 * Mali uzorak (malo_podataka) se vizuelno označi.
 */
function EstimateCell({ est, pieceCount }: { est: OperationEstimate | undefined; pieceCount: number }) {
  const rm = est?.rm_procena;
  if (!rm || rm.n === 0 || rm.p50 == null) {
    return <span className="text-ink-disabled">—</span>;
  }
  const cr = est?.crtez_procena;
  const interval = rm.n >= 3 && rm.p25 != null && rm.p75 != null;
  const perNalog = rm.p50 * pieceCount;
  const title =
    `Stvarno vreme po komadu na ovom radnom mestu (istorija, ne norma): ` +
    (interval
      ? `p25 ${fmtH(rm.p25!)} – medijana ${fmtH(rm.p50)} – p75 ${fmtH(rm.p75!)} h/kom`
      : `≈ ${fmtH(rm.p50)} h/kom (premalo podataka za raspon)`) +
    `, uzorak n=${rm.n}. Za ovaj nalog (${formatNumber(pieceCount)} kom) ≈ ${fmtH(perNalog)} h. ` +
    `Uključuje pripremu, zavisi od veličine serije.` +
    (cr && cr.stvarno_h_p50 != null
      ? ` Baš ovaj crtež ranije: medijana ${fmtH(cr.stvarno_h_p50)} h/nalog (n=${cr.n_naloga}).`
      : '');
  return (
    <span className="inline-flex flex-col items-end leading-tight" title={title}>
      <span className="tnums text-ink">
        {rm.malo_podataka && <span aria-hidden>≈ </span>}
        {interval ? (
          <>
            {fmtH(rm.p25!)}
            <span className="text-ink-disabled">–</span>
            {fmtH(rm.p75!)}
          </>
        ) : (
          fmtH(rm.p50)
        )}
        <span className="ml-1 text-2xs text-ink-secondary">h/kom</span>
      </span>
      <span className={`tnums text-2xs ${rm.malo_podataka ? 'text-status-warn' : 'text-ink-secondary'}`}>
        ≈ {fmtH(perNalog)} h/nalog · n={rm.n}
        {rm.malo_podataka && ' · malo'}
      </span>
    </span>
  );
}

/** Drill-down dokaza (review [13]): koji raniji nalozi čine uzorak istorije crteža. */
function DrawingEvidence({
  history,
  nalozi,
}: {
  history: CrtezIstorija | null | undefined;
  nalozi: DrawingOrderRow[] | undefined;
}) {
  if (!history) return null;
  if (history.genericki) {
    return (
      <span> Opšti/generički broj crteža — istorija se ne prikazuje.</span>
    );
  }
  if (history.drugi_nalozi <= 0) {
    return <span> Nov crtež — nema ranije istorije.</span>;
  }
  const list = (nalozi ?? []).filter((n) => n);
  return (
    <>
      {' '}
      Isti crtež je ranije rađen na {formatNumber(history.drugi_nalozi)}{' '}
      {history.drugi_nalozi === 1 ? 'nalogu' : 'naloga'}.
      {list.length > 0 && (
        <details className="mt-1">
          <summary className="cursor-pointer text-ink-secondary hover:text-ink">
            Prikaži naloge (dokazi)
          </summary>
          <ul className="mt-1 space-y-0.5">
            {list.map((n) => (
              <li key={`${n.ident}-${n.varijanta}`} className="tnums text-ink-secondary">
                RN {n.ident}
                {n.varijanta > 0 ? `/${n.varijanta}` : ''} · {formatNumber(n.kolicina)} kom
                {n.otvoren ? ` · ${n.otvoren}` : ''}
                {n.predmet ? ` · predmet ${n.predmet}` : ''}
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

/**
 * Read-only / editabilna tabela operacija TP-a (Op., RC, Opis, Tpz, Tk, Ukupno
 * + tfoot Ukupno). Markup izvučen iz `work-orders/page.tsx` (RN detalj) da bi ga
 * delili RN detalj (canEdit) i CAM detalj (read-only). Akcije (izmeni/obriši) se
 * prikazuju SAMO uz `canEdit`; tfoot „Ukupno" je uvek prisutan.
 *
 * `estimates` (TALAS AI-5, opciono) → dodaje nenametljivu kolonu „Slični poslovi
 * (RM)" sa statističkom procenom h/kom; kad izostane, kolone nema (npr. CAM ekran).
 */
export function OperationsTable({
  operations,
  pieceCount,
  canEdit,
  onEdit,
  onDelete,
  deleteDisabled,
  estimates,
  drawingHistory,
  drawingNalozi,
}: {
  operations: WorkOrderOperation[];
  pieceCount: number;
  canEdit?: boolean;
  onEdit?: (op: WorkOrderOperation) => void;
  onDelete?: (op: WorkOrderOperation) => void;
  /** Blokira dugme „Obriši" dok traje neka mutacija na RN-u. */
  deleteDisabled?: boolean;
  /** operationNumber → procena (TALAS AI-5). Prisutno → prikazuje se kolona. */
  estimates?: Map<number, OperationEstimate>;
  /** Sažetak istorije istog crteža — natpis ispod tabele. */
  drawingHistory?: CrtezIstorija | null;
  /** Raniji nalozi istog crteža — dokazi za drill-down (review [13]). */
  drawingNalozi?: DrawingOrderRow[];
}) {
  const opTotal = operations.reduce(
    (sum, op) => sum + (op.setupTime ?? 0) + (op.cycleTime ?? 0) * pieceCount,
    0,
  );
  const showEstimates = estimates != null;

  return (
    <div className="overflow-x-auto rounded-panel border border-line bg-surface">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line bg-surface-2 text-left text-2xs uppercase tracking-[0.08em] text-ink-secondary">
            <th className="px-3 py-2 font-semibold">Op.</th>
            <th className="px-3 py-2 font-semibold">RC</th>
            <th className="px-3 py-2 font-semibold">Opis</th>
            <th className="px-3 py-2 text-right font-semibold">Tpz</th>
            <th className="px-3 py-2 text-right font-semibold">Tk</th>
            <th className="px-3 py-2 text-right font-semibold">Ukupno</th>
            {showEstimates && (
              <th
                className="px-3 py-2 text-right font-semibold"
                title="Statistička procena iz istorije: koliko slični poslovi STVARNO traju po komadu na ovom radnom mestu (interval p25–p75, medijana, n) i ≈ koliko za ovaj nalog. Nije norma — ne menja Tpz/Tk."
              >
                Slični poslovi (RM)
              </th>
            )}
            {canEdit && <th className="px-3 py-2 text-right font-semibold">Akcije</th>}
          </tr>
        </thead>
        <tbody>
          {operations.map((op) => {
            const uk = (op.setupTime ?? 0) + (op.cycleTime ?? 0) * pieceCount;
            return (
              <tr key={op.id} className="border-b border-line-soft last:border-0">
                <td className="tnums px-3 py-1.5 text-ink-secondary">{op.operationNumber}</td>
                <td className="px-3 py-1.5 text-ink">
                  {op.operation?.workCenterName ?? op.workCenterCode}
                </td>
                {/* Opis rada je višelinijski (009/26) — prelomi reda koje je
                    korisnik otkucao moraju da se vide i u tabeli, ne da se
                    skupe u jedan red (podrazumevano `white-space: normal`). */}
                <td className="whitespace-pre-line px-3 py-1.5 text-ink">{op.workDescription}</td>
                <td className="tnums px-3 py-1.5 text-right text-ink-secondary">
                  {op.setupTime != null ? fmtNum(op.setupTime) : '—'}
                </td>
                <td className="tnums px-3 py-1.5 text-right text-ink-secondary">
                  {op.cycleTime != null ? fmtNum(op.cycleTime) : '—'}
                </td>
                <td className="tnums px-3 py-1.5 text-right text-ink">{fmtNum(uk)}</td>
                {showEstimates && (
                  <td className="px-3 py-1.5 text-right">
                    <EstimateCell est={estimates.get(op.operationNumber)} pieceCount={pieceCount} />
                  </td>
                )}
                {canEdit && (
                  <td className="px-3 py-1.5 text-right">
                    <div className="inline-flex gap-1">
                      <button
                        onClick={() => onEdit?.(op)}
                        aria-label="Izmeni operaciju"
                        className="rounded-control border border-line px-2 py-1 text-ink-secondary hover:bg-surface-2"
                      >
                        <Pencil className="h-3.5 w-3.5" aria-hidden />
                      </button>
                      <button
                        disabled={deleteDisabled}
                        onClick={() => onDelete?.(op)}
                        aria-label="Obriši operaciju"
                        className="rounded-control border border-line px-2 py-1 text-status-danger hover:bg-status-danger-bg disabled:opacity-40"
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden />
                      </button>
                    </div>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="border-t border-line bg-surface-2 text-2xs uppercase tracking-[0.08em] text-ink-secondary">
            <td className="px-3 py-2 font-semibold" colSpan={5}>
              Ukupno (Tpz + Tk × {formatNumber(pieceCount)} kom)
            </td>
            <td className="tnums px-3 py-2 text-right font-semibold text-ink">{fmtNum(opTotal)}</td>
            {showEstimates && <td />}
            {canEdit && <td />}
          </tr>
        </tfoot>
      </table>
      {showEstimates && (
        <p className="border-t border-line-soft px-3 py-2 text-2xs text-ink-secondary">
          „Slični poslovi (RM)" = koliko slični poslovi STVARNO traju po komadu na tom radnom mestu
          (istorija prijava rada, interval p25–p75 sa medijanom; „≈ h/nalog" je median × količina, za
          poređenje sa „Ukupno"). Uključuje pripremu, zavisi od serije; „malo" = mali uzorak.
          Informativno — ne menja normativ.
          <DrawingEvidence history={drawingHistory} nalozi={drawingNalozi} />
        </p>
      )}
    </div>
  );
}
