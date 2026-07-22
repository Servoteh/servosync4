import { BadRequestException } from "@nestjs/common";

/**
 * Telo za PUT /zahtevi/nagrade/tarife (MODULE_SPEC §12.2) — izmena tarife nagrada.
 * Uvek se šalje svih 5 iznosa (ocena 1–5). Upis = NOVI redovi sa validFrom = danas
 * (stari se NE menjaju — istorija se čuva, raniji obračuni ostaju tačni).
 */
export interface TariffPutDto {
  /** Iznos po oceni: { "1": 500, "2": 1000, ... "5": 3000 }. */
  amounts: Record<string, number>;
}

export const TARIFF_SCORES = [1, 2, 3, 4, 5] as const;

export function validateTariffPut(dto: TariffPutDto): void {
  const errors: string[] = [];
  if (!dto || typeof dto.amounts !== "object" || dto.amounts === null) {
    throw new BadRequestException("Nedostaju iznosi tarife (amounts).");
  }
  for (const score of TARIFF_SCORES) {
    const raw = dto.amounts[String(score)];
    if (raw === undefined || raw === null)
      errors.push(`Nedostaje iznos za ocenu ${score}.`);
    else if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0)
      errors.push(`Iznos za ocenu ${score} mora biti broj ≥ 0.`);
    else if (raw > 99999999)
      errors.push(`Iznos za ocenu ${score} je prevelik.`);
  }
  if (errors.length) throw new BadRequestException(errors);
}
