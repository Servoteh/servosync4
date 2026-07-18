import { BadRequestException } from "@nestjs/common";

/**
 * Bulk-clone svih (ili izabranih) radnih naloga jednog predmeta u novi predmet
 * (`spKreirajSveStavkeRNZaNoviIDPredmet`, MODULE_SPEC_radni_nalozi §3.5 /
 * migration/05 §DOMEN). Koeficijent množi `Komada` (pieceCount zaglavlja i
 * količine PND/PDM/PLP stavki); OPERACIJE se prenose 1:1 (norme se NE skaliraju).
 * Legacy dvofazni staging („Kreirati" checkbox po redu) → `workOrderIds` filter.
 *
 * class-validator još nije uveden (BACKEND_RULES §6) — validacija je ručna dole.
 */
export interface BulkCloneWorkOrdersDto {
  /** Ciljni (novi) predmet — mora postojati i biti PRAZAN (bez naloga). */
  targetProjectId: number;
  /** Množilac količina (`Komada`) — broj > 0. */
  coefficient: number;
  /**
   * Opciono: kloniraj samo izabrane naloge izvornog predmeta (legacy „Kreirati"
   * checkbox). Izostavljeno/prazno → kloniraju se SVI nalozi predmeta.
   */
  workOrderIds?: number[];
}

export function validateBulkCloneWorkOrders(dto: BulkCloneWorkOrdersDto): void {
  const errors: string[] = [];
  if (
    typeof dto?.targetProjectId !== "number" ||
    !Number.isInteger(dto.targetProjectId) ||
    dto.targetProjectId <= 0
  ) {
    errors.push("targetProjectId je obavezan (pozitivan ceo broj).");
  }
  if (
    typeof dto?.coefficient !== "number" ||
    !Number.isFinite(dto.coefficient) ||
    dto.coefficient <= 0
  ) {
    errors.push("coefficient mora biti broj > 0.");
  }
  if (dto?.workOrderIds !== undefined) {
    if (
      !Array.isArray(dto.workOrderIds) ||
      dto.workOrderIds.some(
        (n) => typeof n !== "number" || !Number.isInteger(n) || n <= 0,
      )
    ) {
      errors.push("workOrderIds mora biti niz pozitivnih celih brojeva.");
    }
  }
  if (errors.length) throw new BadRequestException(errors);
}
