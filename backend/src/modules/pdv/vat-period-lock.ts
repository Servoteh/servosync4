/**
 * PERIOD-LOCK PDV (Talas 1D §D3).
 * =========================================================================
 * Kad je PDV obračun (`VatReturn`) prebačen u status `POSTED` (proknjižen /
 * predat), period koji pokriva postaje ZAKLJUČAN: KIF/KUF se više ne sme
 * reknjižiti iz GK (`buildKifKuf` deleteMany bi tiho pregazio predat obrazac),
 * POPDV se ne sme prekomputirati, a ručne KIF/KUF stavke tog perioda se ne
 * smeju menjati/brisati. Ovaj modul je zajednička brava koju dele
 * `VatLedgerService` i `PopdvService` (leaf fajl — bez cirkularnog importa).
 *
 * VatReturn pokriva:
 *   - mesečni obveznik (`periodMonth`)  → jedan mesec
 *   - kvartalni obveznik (`periodQuarter`) → tri meseca kvartala
 * pa se preklapanje računa na nivou (godina, mesec).
 *
 * ⚠️ DOPUNA 04.08.2026 — `findLockedVatPeriodForDate` (brava za GLAVNU KNJIGU).
 * Do ove dopune je brava štitila samo PDV evidencije (KIF/KUF, POPDV) i nekoliko
 * `sales` puteva: deljeni motor knjiženja `PostingEngineService` je NIJE zvao, pa
 * se posle predate prijave i dalje moglo knjižiti u taj mesec — GK i PP-PDV bi se
 * tiho razišli, a taj red potom ne bi mogao ući ni u jedan PDV obračun (i POPDV i
 * KIF/KUF su za predat mesec blokirani upravo ovim modulom). Motor sada zove
 * `findLockedVatPeriodForDate`, pa bravu naslede svi pisci GK jednim pozivom.
 */

import { ConflictException } from "@nestjs/common";
import type { PrismaService } from "../../prisma/prisma.service";

/** Status zaključanog (predatog) PDV obračuna. */
export const VAT_RETURN_POSTED = "POSTED";
/** Status obračunatog (ali još nezaključanog) PDV obračuna. */
export const VAT_RETURN_CALCULATED = "CALCULATED";

/**
 * Meseci (1..12) koje jedan VatReturn pokriva: mesečni → [m]; kvartalni →
 * tri meseca kvartala. Prazan niz ako ni mesec ni kvartal nisu popunjeni.
 */
export function vatReturnMonths(
  periodMonth: number | null,
  periodQuarter: number | null,
): number[] {
  if (periodMonth != null) return [periodMonth];
  if (periodQuarter != null) {
    const start = (periodQuarter - 1) * 3 + 1;
    return [start, start + 1, start + 2];
  }
  return [];
}

/** Ljudski čitljiva oznaka perioda POSTED obračuna (za poruku greške). */
function periodLabel(
  year: number,
  periodMonth: number | null,
  periodQuarter: number | null,
): string {
  if (periodMonth != null) {
    return `${year}-${String(periodMonth).padStart(2, "0")}`;
  }
  if (periodQuarter != null) return `${year} Q${periodQuarter}`;
  return String(year);
}

/**
 * Ljudska oznaka perioda kako je knjigovođa izgovara kad govori o PREDATOJ prijavi:
 * „03/2026" (mesečni obveznik), „Q1/2026" (kvartalni). Namerno je odvojena od
 * `periodLabel` iznad (oblik `2026-03`) — taj oblik je već u porukama PDV evidencija
 * i menjanje mu formata bi promenilo postojeće poruke bez potrebe.
 */
function humanPeriodLabel(
  year: number,
  periodMonth: number | null,
  periodQuarter: number | null,
): string {
  if (periodMonth != null)
    return `${String(periodMonth).padStart(2, "0")}/${year}`;
  if (periodQuarter != null) return `Q${periodQuarter}/${year}`;
  return String(year);
}

/** Zaključan (predat) PDV period u koji je neko pokušao da knjiži. */
export interface LockedVatPeriod {
  /** `VatReturn.id` predatog obračuna koji drži bravu. */
  vatReturnId: number;
  /** Godina i mesec DATUMA koji je pao u zaključan period (ne samog obračuna). */
  year: number;
  month: number;
  /** Oznaka za poruku korisniku: „03/2026" / „Q1/2026". */
  label: string;
}

/**
 * Da li `date` pada u period nekog `POSTED` (predatog) PDV obračuna?
 * Vraća opis zaključanog perioda, ili `null` kad je period otvoren.
 *
 * Ovo je BRAVA ZA PISCE GLAVNE KNJIGE (v. dopunu u zaglavlju): ne baca sama, nego
 * vraća nalaz — pozivalac (motor knjiženja) bira poruku i escape hatch, jer se
 * njegov tekst („knjiži u tekući period ili otključaj prijavu") razlikuje od
 * teksta za reknjiženje PDV evidencija u `assertVatPeriodNotLocked`.
 *
 * ⚠️ OSA DATUMA = `journal_entries.posting_date`. Pozivalac MORA proslediti datum
 * knjiženja naloga, jer PDV obračun kupi stavke po njemu:
 * `VatLedgerService.buildKifKuf` i `PopdvService.sumVatAccounts` filtriraju
 * `EXTRACT(YEAR/MONTH FROM je.posting_date)`. Merenje po `document_date` bi
 * puštalo redove koji ipak ulaze u predat obračun (razilaženje te dve ose je
 * zaseban, već zabeležen nalaz — ovde se samo prati ono što PDV zaista čita).
 *
 * (godina, mesec) se čitaju UTC getterima — ista konvencija kao
 * `advance-vat.service.ts#taxPeriodOf` i kao Postgres `EXTRACT(...)` nad
 * `timestamptz` kolonom (prod baza i Node kontejner rade u UTC, DB-031).
 * Lokalni getteri bi nalog knjižen 01.03. u 00:30 odvukli u februar i brava bi
 * promašila period.
 */
export async function findLockedVatPeriodForDate(
  prisma: Pick<PrismaService, "vatReturn">,
  date: Date,
): Promise<LockedVatPeriod | null> {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const posted = await prisma.vatReturn.findMany({
    where: { periodYear: year, status: VAT_RETURN_POSTED },
    select: { id: true, periodMonth: true, periodQuarter: true },
  });
  for (const r of posted) {
    if (vatReturnMonths(r.periodMonth, r.periodQuarter).includes(month)) {
      return {
        vatReturnId: r.id,
        year,
        month,
        label: humanPeriodLabel(year, r.periodMonth, r.periodQuarter),
      };
    }
  }
  return null;
}

/**
 * Baci `ConflictException` ako neki `POSTED` VatReturn za `year` preklapa bilo
 * koji od `months`. Poruka navodi koji je period zaključan i broj obračuna.
 * Prihvata i `PrismaService` i transakcioni klijent (`tx`) — koristi samo
 * `vatReturn.findMany`.
 */
export async function assertVatPeriodNotLocked(
  prisma: Pick<PrismaService, "vatReturn">,
  year: number,
  months: number[],
): Promise<void> {
  if (months.length === 0) return;
  const posted = await prisma.vatReturn.findMany({
    where: { periodYear: year, status: VAT_RETURN_POSTED },
    select: { id: true, periodMonth: true, periodQuarter: true },
  });
  if (posted.length === 0) return;

  const wanted = new Set(months);
  for (const r of posted) {
    const covered = vatReturnMonths(r.periodMonth, r.periodQuarter);
    if (covered.some((m) => wanted.has(m))) {
      const label = periodLabel(year, r.periodMonth, r.periodQuarter);
      throw new ConflictException(
        `PDV period ${label} je zaključan (obračun #${r.id} je proknjižen, ` +
          `status ${VAT_RETURN_POSTED}). Reknjiženje, prekomputiranje i izmena ` +
          `stavki tog perioda nisu dozvoljeni.`,
      );
    }
  }
}
