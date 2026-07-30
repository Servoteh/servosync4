'use client';

import type { VacationPeriod } from '@/api/kadrovska';
import { fmtRange } from './helpers';

/**
 * Prikaz GO raspona „od–do" na kartici/redu zaposlenog (zahtev vlasnika 30.07.2026:
 * „da imam neki prikaz tu od kad do kada ima PLANIRAN i ODOBREN odmor").
 *
 * ⚠️ Izvor je `/kadrovska/vacation/periods` — kanon je `vacation_requests`
 * (JEDAN zahtev = JEDAN neprekidan raspon). Grid (`work_hours`) ulazi tek kao
 * treći izvor i to VEĆ SPOJEN na backendu (vikendi/neradni praznici premošćeni),
 * jer bi sirov grid odmor 04.08.–17.08. prikazao kao tri komada rasečena
 * vikendima (04–07 / 10–14 / 17.08) — baš ono što je vlasnik nazvao greškom.
 *
 * ⚠️ NALAZ F2 (review 30.07.2026): ovde se NIKAD ne sme tvrditi „nema planiranog
 * odmora" ako podatak nije stigao. Pad upita (403/500/mreža/400 na godinu van
 * opsega) je do sada izgledao kao „niko nema odmor" — za SVE zaposlene, i u
 * tabeli i u Excel izvozu. Otud `error`/`loading` grane i saldo-brana ispod.
 */

const PHASE_LABEL: Record<VacationPeriod['phase'], string> = {
  planiran: 'planiran',
  u_toku: 'u toku',
  iskorisceno: 'iskorišćen',
};

/** Boja/oznaka po statusu odobravanja (5 statusa; rejected/canceled BE ne šalje). */
export function periodMeta(p: VacationPeriod): { color: string; label: string; tip: string } {
  if (p.source === 'grid')
    return {
      color: 'var(--status-neutral)',
      label: 'iz evidencije (bez zahteva)',
      tip:
        'Nema zahteva za GO ni evidencije odsustva — dani su upisani u mesečni grid ' +
        'kao „go". To je isti izvor koji broji kolone „Iskorišćeno" i „Planirano". ' +
        'Vikendi i neradni praznici unutar raspona su premošćeni.',
    };
  if (p.source === 'evidencija')
    return {
      color: 'var(--status-neutral)',
      label: 'iz evidencije',
      tip: 'Nema zahteva za GO — raspon je iz evidencije odsustava (stariji ručni HR unos).',
    };
  if (p.status === 'approved')
    return { color: 'var(--status-success)', label: 'odobren', tip: 'Zahtev za GO je finalno odobren.' };
  if (p.status === 'sef_approved')
    return {
      color: 'var(--status-warn)',
      label: 'čeka HR',
      tip: 'Šef je odobrio (1. stepen) — čeka se HR/administrator. Još NIJE odobren odmor.',
    };
  return {
    color: 'var(--status-neutral)',
    label: 'na čekanju',
    tip: 'Zahtev za GO je podnet i čeka odobrenje — odmor je samo planiran.',
  };
}

/** Tekstualni sažetak jednog raspona za `title` / listu. */
export function periodText(p: VacationPeriod): string {
  const m = periodMeta(p);
  return `${fmtRange(p.dateFrom, p.dateTo)} · ${p.daysCount} d. · ${m.label} (${PHASE_LABEL[p.phase]})`;
}

/**
 * Najrelevantniji raspon: prvi koji se još nije završio, inače poslednji prošli.
 * Fazu računa BACKEND u Europe/Belgrade — namerno se NE poredi sa klijentskim
 * datumom (`toISOString()` je UTC pa bi pre 02:00 pokazivao juče).
 */
export function pickCurrent(periods: VacationPeriod[]): VacationPeriod | null {
  if (!periods.length) return null;
  return periods.find((p) => p.phase !== 'iskorisceno') ?? periods[periods.length - 1];
}

function Badge({ p }: { p: VacationPeriod }) {
  const m = periodMeta(p);
  return (
    <span
      className="rounded border px-1 text-[0.65rem] whitespace-nowrap"
      style={{ color: m.color, borderColor: `color-mix(in srgb, ${m.color} 45%, transparent)` }}
      title={m.tip}
    >
      {m.label}
    </span>
  );
}

/**
 * Saldo istog reda — brana protiv lažne tvrdnje „nema planiranog odmora" kad
 * saldo pokazuje dane. `openingUsed` su dani PRE cutover-a (`vacation_entitlements
 * .opening_used`) koji NEMAJU datume, pa im raspon ni ne može postojati — zato
 * se za njih ispisuje „bez datuma", a ne negacija.
 */
export interface GoBalanceHint {
  used: number;
  planned: number;
  openingUsed: number;
}

/** Neutralna poruka „nije učitano" — NIKAD tvrdnja da odmora nema (F2). */
function NotLoaded({ what }: { what: string }) {
  return (
    <span
      className="whitespace-nowrap text-xs text-status-warn"
      title={`Podatak o rasponima GO nije učitan (${what}). Prikaz NE znači da zaposleni nema odmor — osveži stranicu ili proveri godinu.`}
    >
      ⚠ podatak nije učitan
    </span>
  );
}

/**
 * Ćelija kolone „Odmor (od–do)". Klik širi red i pokazuje SVE raspone godine
 * (bez ulaska u rešenje ili 📜 modal — to je bila vlasnikova zamerka).
 */
export function GoPeriodCell({
  periods,
  loading,
  error,
  balance,
  year,
  expanded,
  onToggle,
}: {
  periods: VacationPeriod[];
  loading?: boolean;
  error?: boolean;
  balance?: GoBalanceHint;
  year: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  // Redosled je bitan: greška pre praznog stanja, inače pad upita izgleda
  // kao „niko nema odmor" (F2).
  if (error) return <NotLoaded what="upit nije uspeo" />;
  if (loading) return <span className="text-xs text-ink-disabled">…</span>;

  const cur = pickCurrent(periods);
  if (!cur) {
    // Brana konzistentnosti: saldo i ova ćelija čitaju ISTE `work_hours` redove,
    // pa „nema odmora" uz saldo > 0 ne sme da se desi. Ako se ipak desi (dani
    // bez datuma iz `opening_used`), kaže se ŠTA se zna, ne što se ne zna.
    const saldoDana = (balance?.used ?? 0) + (balance?.planned ?? 0);
    if (saldoDana > 0)
      return (
        <span
          className="whitespace-nowrap text-xs text-ink-secondary"
          title={
            `U saldu za ${year}. stoji ${saldoDana} d. (iskorišćeno ${balance?.used ?? 0}, planirano ${balance?.planned ?? 0}), ` +
            `ali bez datuma — ${balance?.openingUsed ? `${balance.openingUsed} d. je preneseno stanje pre cutover-a (bez datuma u sistemu)` : 'raspon nije evidentiran ni kao zahtev, ni kao odsustvo, ni u gridu'}.`
          }
        >
          {saldoDana} d. bez datuma
        </span>
      );
    return (
      <span
        className="text-xs text-ink-disabled"
        title={`Nema zahteva, odsustva ni GO dana u gridu za ${year}. Napomena: prikazuju se samo zaposleni iz vašeg opsega.`}
      >
        nema planiranog odmora
      </span>
    );
  }

  const rest = periods.length - 1;
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex flex-wrap items-center gap-1.5 rounded-control px-1 py-0.5 text-left hover:bg-surface-2 focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
      title={periods.map(periodText).join('\n')}
      aria-expanded={expanded}
    >
      <span className="whitespace-nowrap text-ink">{fmtRange(cur.dateFrom, cur.dateTo)}</span>
      <span className="whitespace-nowrap text-xs text-ink-secondary tnums">{cur.daysCount} d.</span>
      <Badge p={cur} />
      {rest > 0 && (
        <span className="text-xs text-ink-secondary" title={`Još ${rest} u ${year}. — klik za sve`}>
          +{rest}
        </span>
      )}
    </button>
  );
}

/** Prošireni red — svi GO raspani zaposlenog u godini, sortirani po datumu. */
export function GoPeriodList({
  periods,
  employeeName,
  year,
  loading,
  error,
}: {
  periods: VacationPeriod[];
  employeeName: string;
  year: number;
  loading?: boolean;
  error?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <div className="text-2xs uppercase tracking-[0.08em] text-ink-secondary">
        Godišnji odmor {year} — {employeeName || '—'}
      </div>
      {error ? (
        // F2: ne tvrdi da odmora nema kad upit nije prošao.
        <div className="text-xs text-status-warn">
          ⚠ Podatak o rasponima GO nije učitan — osveži stranicu ili proveri godinu.
        </div>
      ) : loading ? (
        <div className="text-xs text-ink-disabled">Učitavanje…</div>
      ) : periods.length === 0 ? (
        <div className="text-xs text-ink-disabled">
          Nema zahteva, odsustva ni GO dana u gridu za {year}.
        </div>
      ) : (
        <ul className="space-y-1">
          {periods.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="min-w-[9.5rem] text-ink">{fmtRange(p.dateFrom, p.dateTo)}</span>
              <span className="tnums text-xs text-ink-secondary">{p.daysCount} d.</span>
              <Badge p={p} />
              <span className="text-xs text-ink-secondary">{PHASE_LABEL[p.phase]}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
