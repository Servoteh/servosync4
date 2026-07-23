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
