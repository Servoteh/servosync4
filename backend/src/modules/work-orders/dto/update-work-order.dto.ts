import { BadRequestException } from "@nestjs/common";

/**
 * Izmena zaglavlja RN-a (`UnosRN` edit mode) — sva polja opciona, primenjuje se samo
 * ono što je poslato. Identitet (`projectId`/`identNumber`/`variant`) se NE menja ovde;
 * statusni prelazi (odobri/lansiraj/zaključaj) idu preko zasebnih endpointa.
 * Guard u servisu: zaključan RN se ne menja.
 *
 * class-validator još nije uveden (BACKEND_RULES §6) — ručna validacija.
 */
export interface UpdateWorkOrderDto {
  partName?: string;
  drawingNumber?: string;
  material?: string;
  materialDimension?: string;
  pieceCount?: number;
  unit?: string;
  product?: string;
  note?: string;
  revision?: string;
  qualityTypeId?: number;
  materialId?: number;
  workerId?: number;
  /** ISO datum, ili `null` da se obriše rok. */
  productionDeadline?: string | null;
  externalProjectName?: string;
  externalCustomerId?: number;
}

export function validateUpdateWorkOrder(dto: UpdateWorkOrderDto): void {
  const errors: string[] = [];
  // Obavezna (NOT NULL) tekst polja: ako su poslata, ne smeju biti prazna.
  const reqStrIfPresent = (v: unknown, name: string) => {
    if (v !== undefined && (typeof v !== "string" || !v.trim()))
      errors.push(`${name} ne sme biti prazno.`);
  };
  const optStr = (v: unknown, name: string) => {
    if (v !== undefined && v !== null && typeof v !== "string")
      errors.push(`${name} mora biti tekst.`);
  };
  const optPosInt = (v: unknown, name: string) => {
    if (v !== undefined && (typeof v !== "number" || !Number.isInteger(v) || v <= 0))
      errors.push(`${name} mora biti ceo broj ≥ 1.`);
  };
  const optNonNegInt = (v: unknown, name: string) => {
    if (v !== undefined && (typeof v !== "number" || !Number.isInteger(v) || v < 0))
      errors.push(`${name} mora biti ceo broj ≥ 0.`);
  };

  reqStrIfPresent(dto?.partName, "Naziv pozicije");
  reqStrIfPresent(dto?.drawingNumber, "Broj crteža");
  reqStrIfPresent(dto?.material, "Materijal");
  reqStrIfPresent(dto?.materialDimension, "Dimenzija materijala");
  optStr(dto?.unit, "Jedinica");
  optStr(dto?.product, "Proizvod");
  optStr(dto?.note, "Napomena");
  optStr(dto?.revision, "Revizija");
  optStr(dto?.externalProjectName, "Naziv predmeta");
  optPosInt(dto?.pieceCount, "Količina");
  optNonNegInt(dto?.qualityTypeId, "Vrsta kvaliteta");
  optNonNegInt(dto?.materialId, "Materijal ID");
  optNonNegInt(dto?.workerId, "Radnik");
  optPosInt(dto?.externalCustomerId, "Komitent");
  if (
    dto?.productionDeadline !== undefined &&
    dto.productionDeadline !== null &&
    (typeof dto.productionDeadline !== "string" ||
      Number.isNaN(new Date(dto.productionDeadline).getTime()))
  )
    errors.push("Rok izrade mora biti ISO datum ili null.");

  if (errors.length) throw new BadRequestException(errors);
}
