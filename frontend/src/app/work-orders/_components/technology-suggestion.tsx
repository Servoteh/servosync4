'use client';

import { History, Lightbulb } from 'lucide-react';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { formatNumber } from '@/lib/format';
import {
  useDrawingTechnologySuggestion,
  isSuggestion,
  type SuggestedOperation,
  type RutingVarijanta,
} from '@/api/technology-suggest';

/** sr-RS, do 3 decimale (norme Tpz/Tk). */
const fmtNum = (n: number) => n.toLocaleString('sr-RS', { maximumFractionDigits: 3 });
/** sr-RS, do 2 decimale (procena h/kom). */
const fmtH = (n: number) => n.toLocaleString('sr-RS', { maximumFractionDigits: 2 });

/**
 * TALAS AI-6 — panel „Predlog iz istorije". Kad crtež naloga ima raniju
 * tehnologiju, prikaže REPREZENTATIVAN ruting iz prošlih naloga: operacije redom,
 * radno mesto, plan (Tpz/Tk) i STVARNU procenu vremena po komadu (interval p25–p75,
 * n) iz istorije prijava rada. NIJE norma i NE upisuje se — predlog koji tehnolog
 * prihvata ili dorađuje (plan §2.2, human-in-the-loop).
 *
 * Nenametljivo: sklopljen `<details>` (otvoren kad je ruting PRAZAN — tada je
 * predlog najkorisniji). Kad crtež nema istoriju, prikaže se samo tiha napomena.
 */

/**
 * Ćelija „Slični poslovi (RM)" — isti obrazac kao AI-5 EstimateCell. Prikazuje
 * SAMO h/kom + n (review [7][9]): raniji izvedeni „za N kom ≈ X h" računao je
 * količinu REPREZENTATIVNOG istorijskog naloga (ne tekućeg), pa je bio zavaravajuć.
 */
function RmCell({ rm }: { rm: SuggestedOperation['rm_procena'] }) {
  if (!rm || rm.n === 0 || rm.p50 == null) {
    return <span className="text-ink-disabled">—</span>;
  }
  const interval = rm.n >= 3 && rm.p25 != null && rm.p75 != null;
  const title =
    `Stvarno vreme po komadu na tom radnom mestu (istorija svih naloga na RM, ne norma): ` +
    (interval
      ? `p25 ${fmtH(rm.p25!)} – medijana ${fmtH(rm.p50)} – p75 ${fmtH(rm.p75!)} h/kom`
      : `≈ ${fmtH(rm.p50)} h/kom (premalo podataka za raspon)`) +
    `, uzorak n=${rm.n}.`;
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
      <span
        className={`tnums text-2xs ${rm.malo_podataka ? 'text-status-warn' : 'text-ink-secondary'}`}
      >
        n={rm.n}
        {rm.malo_podataka && ' · malo'}
      </span>
    </span>
  );
}

/** sr-RS pluralizacija „N varijanti/e" (review [14]: paukal 2–4 vs ≥5). */
function plVarijanti(n: number): string {
  const d = n % 10;
  const dd = n % 100;
  if (d >= 2 && d <= 4 && !(dd >= 12 && dd <= 14)) return `${n} varijante`;
  return `${n} varijanti`;
}
function plPostupka(n: number): string {
  const d = n % 10;
  const dd = n % 100;
  if (d >= 2 && d <= 4 && !(dd >= 12 && dd <= 14)) return `${n} različita postupka`;
  return `${n} različitih postupaka`;
}

/**
 * Lista varijanti rutinga kad se nalozi razlikuju (nekonzistentno). Svaka nudi
 * „Prepiši ovu" (review [4]) — tehnolog prepiše BAŠ varijantu koju gleda, ne samo
 * predloženu; kopira iz njenog reprezentativnog (proizvedenog) naloga.
 */
function Variants({
  varijante,
  drawingNumber,
  onApply,
}: {
  varijante: RutingVarijanta[];
  drawingNumber: string;
  onApply?: (source: { id: number; ident: string; drawingNumber: string }) => void;
}) {
  if (varijante.length <= 1) return null;
  return (
    <details className="mt-2 text-xs">
      <summary className="cursor-pointer text-ink-secondary hover:text-ink">
        Postupci se razlikuju — prikaži {plVarijanti(varijante.length)}
      </summary>
      <ul className="mt-1.5 space-y-1.5">
        {varijante.map((v, i) => (
          <li
            key={i}
            className={`rounded-control border px-2.5 py-1.5 ${
              v.izabran ? 'border-accent/40 bg-accent/5' : 'border-line-soft'
            }`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="tnums font-semibold text-ink">
                {formatNumber(v.broj_naloga)} {v.broj_naloga === 1 ? 'nalog' : 'naloga'}
              </span>
              {v.izabran && <StatusBadge tone="info" label="predloženo" />}
              <span className="text-2xs text-ink-disabled">
                {v.operacija} op. · najskoriji RN {v.najskoriji_ident}
                {v.najskoriji_otvoren ? ` (${v.najskoriji_otvoren})` : ''}
              </span>
              {onApply && (
                <button
                  onClick={() =>
                    onApply({
                      id: v.kopiraj_id,
                      ident: v.kopiraj_ident,
                      drawingNumber,
                    })
                  }
                  className="ml-auto rounded-control border border-line px-2 py-0.5 text-2xs font-semibold text-ink-secondary hover:bg-surface-2"
                >
                  Prepiši ovu (RN {v.kopiraj_ident})
                </button>
              )}
            </div>
            <p className="tnums mt-0.5 break-words text-2xs text-ink-secondary">
              {v.radna_mesta.join(' › ')}
            </p>
          </li>
        ))}
      </ul>
    </details>
  );
}

export function TechnologySuggestionPanel({
  drawingNumber,
  workOrderId,
  routingEmpty,
  onApply,
}: {
  /** Broj crteža naloga (bez njega se predlog ne traži). */
  drawingNumber: string | null | undefined;
  /** Tekući RN — izuzima se iz osnove predloga. */
  workOrderId: number;
  /** Ruting je prazan → panel otvoren i nudi „Prepiši". */
  routingEmpty: boolean;
  /**
   * „Prepiši ovaj postupak" — otvara POSTOJEĆI tok „Kopiraj iz naloga" sa
   * reprezentativnim nalogom kao izvorom. `undefined` (npr. RN nije prazan/nema
   * prava) → dugme se ne prikazuje. Predlog se NE upisuje sam.
   */
  onApply?: (source: { id: number; ident: string; drawingNumber: string }) => void;
}) {
  const crtez = (drawingNumber ?? '').trim();
  // review [12]: teška agregacija (deli je AI-5) se pali SAMO kad je ruting prazan
  // — panel se ionako otvara i predlaže samo tada; popunjen RN ne okida upit.
  const q = useDrawingTechnologySuggestion(crtez || null, workOrderId, routingEmpty);

  if (!crtez || !routingEmpty) return null;
  if (q.isLoading) {
    return (
      <p className="flex items-center gap-1.5 text-2xs text-ink-disabled">
        <History className="h-3.5 w-3.5" aria-hidden />
        Proveravam istoriju crteža…
      </p>
    );
  }
  if (q.error || !q.data) return null;

  // Nema istorije: tiha napomena (jasno razdvojeno od „nema operacija").
  if (!isSuggestion(q.data)) {
    return (
      <p className="flex items-center gap-1.5 text-2xs text-ink-disabled">
        <History className="h-3.5 w-3.5" aria-hidden />
        {q.data.poruka}
      </p>
    );
  }

  const s = q.data;
  const rep = s.reprezentativan_nalog;

  return (
    <details
      open={routingEmpty}
      className="rounded-panel border border-accent/30 bg-accent/[0.03]"
    >
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2">
        <Lightbulb className="h-4 w-4 text-accent" aria-hidden />
        <span className="text-sm font-semibold text-ink">Predlog iz istorije</span>
        <span className="text-2xs text-ink-secondary">
          crtež {s.crtez} · {formatNumber(s.osnov_naloga)}{' '}
          {s.osnov_naloga === 1 ? 'raniji nalog' : 'ranijih naloga'}
        </span>
        {s.konzistentno ? (
          <StatusBadge tone="success" label="isti postupak" />
        ) : (
          <StatusBadge tone="warn" label={plPostupka(s.broj_varijanti)} />
        )}
      </summary>

      <div className="space-y-2 border-t border-line-soft px-3 py-2.5">
        <p className="text-2xs text-ink-secondary">
          Predloženi ruting je iz RN{' '}
          <span className="tnums font-semibold text-ink">{rep.ident}</span>
          {rep.otvoren ? ` (otvoren ${rep.otvoren})` : ''} ·{' '}
          {formatNumber(rep.kolicina)} kom
          {rep.proizveden ? ' · postupak je izveden do kraja' : ' · nije potvrđena proizvodnja'}.
          {!s.konzistentno &&
            ' Nalozi ovog crteža imaju različit postupak — predložen je proizveden/najčešći; proveri koji odgovara (vidi varijante ispod).'}
        </p>

        <div className="overflow-x-auto rounded-panel border border-line bg-surface">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-surface-2 text-left text-2xs uppercase tracking-[0.08em] text-ink-secondary">
                <th className="px-3 py-2 font-semibold">Op.</th>
                <th className="px-3 py-2 font-semibold">RC</th>
                <th className="px-3 py-2 font-semibold">Opis</th>
                <th className="px-3 py-2 text-right font-semibold">Tpz</th>
                <th className="px-3 py-2 text-right font-semibold">Tk</th>
                <th
                  className="px-3 py-2 text-right font-semibold"
                  title="Stvarno vreme po komadu na tom radnom mestu iz istorije prijava rada (interval p25–p75, n). Nije norma."
                >
                  Slični poslovi (RM)
                </th>
              </tr>
            </thead>
            <tbody>
              {s.operacije.map((op) => (
                <tr key={op.rb} className="border-b border-line-soft last:border-0">
                  <td className="tnums px-3 py-1.5 text-ink-secondary">{op.rb}</td>
                  <td className="px-3 py-1.5 text-ink">
                    {op.naziv_radnog_mesta ?? op.radno_mesto}
                  </td>
                  <td className="px-3 py-1.5 text-ink">{op.opis ?? '—'}</td>
                  <td className="tnums px-3 py-1.5 text-right text-ink-secondary">
                    {op.plan_tpz != null ? fmtNum(op.plan_tpz) : '—'}
                  </td>
                  <td className="tnums px-3 py-1.5 text-right text-ink-secondary">
                    {op.plan_tk != null ? fmtNum(op.plan_tk) : '—'}
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    <RmCell rm={op.rm_procena} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <Variants varijante={s.varijante} drawingNumber={s.crtez} onApply={onApply} />

        <p className="text-2xs text-ink-secondary">
          Tpz/Tk su norme iz ranijeg naloga (u satima); „Slični poslovi (RM)" = koliko slični
          poslovi STVARNO traju po komadu na tom radnom mestu (istorija prijava rada, interval
          p25–p75, „malo" = mali uzorak). Predlog je informativan — proveri ga i dopuni; ništa
          se ne upisuje automatski.
        </p>

        {onApply && (
          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            <button
              onClick={() =>
                onApply({ id: rep.id, ident: rep.ident, drawingNumber: s.crtez })
              }
              className="rounded-control bg-accent px-3 py-1.5 text-xs font-semibold text-accent-fg"
            >
              Prepiši ovaj postupak
            </button>
            <span className="text-2xs text-ink-disabled">
              Otvara „Kopiraj iz naloga" sa RN {rep.ident} kao izvorom — kopira CEO nalog
              (operacije, materijal, pripremci, obrađeni/nestandardni delovi), ne samo operacije.
              Ti potvrđuješ.
            </span>
          </div>
        )}
      </div>
    </details>
  );
}
