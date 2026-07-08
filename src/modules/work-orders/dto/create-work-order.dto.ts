import { BadRequestException } from "@nestjs/common";

/**
 * Ručno kreiranje RN-a (`UnosRN` → „Novi dokument"). Zaglavlje; stavke/operacije
 * se dodaju posebno. `identNumber`/`variant` generiše server (numeracioni servis).
 * Statusni prelazi (odobri/lansiraj) idu preko zasebnih endpointa, ne ovde.
 *
 * class-validator još nije uveden (BACKEND_RULES §6) — validacija je ručna dole.
 */
export interface CreateWorkOrderDto {
  /** Predmet (FK projects) — obavezno. */
  projectId: number;
  /** Komitent (BigBit cache) — obavezno. */
  externalCustomerId: number;
  /** Naziv pozicije/dela — obavezno. */
  partName: string;
  /** Broj crteža — obavezno. */
  drawingNumber: string;
  /** Materijal (tekst) — obavezno. */
  material: string;
  /** Dimenzija materijala — obavezno. */
  materialDimension: string;
  /** Količina komada — obavezno, ceo broj ≥ 1. */
  pieceCount: number;
  // --- opciono ---
  unit?: string;
  product?: string;
  note?: string;
  /** Revizija (prazno → "A"). */
  revision?: string;
  /** 0=DOBAR, 1=DORADA, 2=SKART. */
  qualityTypeId?: number;
  materialId?: number;
  /** Tehnolog autor (FK workers). */
  workerId?: number;
  /** ISO datum roka. */
  productionDeadline?: string;
  externalProjectName?: string;
}

export function validateCreateWorkOrder(dto: CreateWorkOrderDto): void {
  const errors: string[] = [];
  const reqPosInt = (v: unknown, name: string) => {
    if (typeof v !== "number" || !Number.isInteger(v) || v <= 0)
      errors.push(`${name} je obavezan.`);
  };
  const reqStr = (v: unknown, name: string) => {
    if (typeof v !== "string" || !v.trim()) errors.push(`${name} je obavezno.`);
  };
  reqPosInt(dto?.projectId, "Predmet");
  reqPosInt(dto?.externalCustomerId, "Komitent");
  reqStr(dto?.partName, "Naziv pozicije");
  reqStr(dto?.drawingNumber, "Broj crteža");
  reqStr(dto?.material, "Materijal");
  reqStr(dto?.materialDimension, "Dimenzija materijala");
  if (
    typeof dto?.pieceCount !== "number" ||
    !Number.isInteger(dto.pieceCount) ||
    dto.pieceCount < 1
  ) {
    errors.push("Količina mora biti ceo broj ≥ 1.");
  }
  if (errors.length) throw new BadRequestException(errors);
}
