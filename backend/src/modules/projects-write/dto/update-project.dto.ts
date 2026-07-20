import { BadRequestException } from "@nestjs/common";

/**
 * NACRT — DTO za izmenu predmeta (write-path, Traka B §A).
 * Sva polja opciona (PATCH semantika). projectNumber / salespersonId / openedAt se NE
 * menjaju kroz ovaj put (numeracija i vlasništvo su servisna odgovornost). Kod engleski,
 * poruke srpski. Obrazac: interface + ručna validate*() (BACKEND_RULES §6).
 */
export interface UpdateProjectDto {
  customerId?: number;
  workTypeId?: number; // ako se šalje, i dalje mora biti ≠ 0 (servis, 422)
  description?: string;
  projectName?: string;
  deadline?: string; // ISO datum
  memo?: string;
  nextAction?: string;
  status?: string;
  closedAt?: string; // ISO datum (zatvaranje predmeta)
}

export function validateUpdateProject(dto: UpdateProjectDto): void {
  const errors: string[] = [];

  const optPosInt = (v: unknown, name: string) => {
    if (v === undefined || v === null) return;
    if (typeof v !== "number" || !Number.isInteger(v) || v <= 0)
      errors.push(`${name} mora biti pozitivan ceo broj.`);
  };
  const optStr = (v: unknown, name: string) => {
    if (v === undefined || v === null) return;
    if (typeof v !== "string") errors.push(`${name} mora biti tekst.`);
  };
  const optDate = (v: unknown, name: string) => {
    if (v === undefined || v === null) return;
    if (typeof v !== "string" || Number.isNaN(Date.parse(v)))
      errors.push(`${name} mora biti validan datum.`);
  };

  optPosInt(dto.customerId, "Komitent");
  // workTypeId: ako je poslat, mora biti broj; ≠0 poslovni guard je u servisu (422).
  if (dto.workTypeId !== undefined) {
    if (typeof dto.workTypeId !== "number" || !Number.isInteger(dto.workTypeId))
      errors.push("Vrsta posla mora biti ceo broj.");
  }
  optStr(dto.description, "Opis");
  optStr(dto.projectName, "Naziv predmeta");
  optStr(dto.memo, "Memo");
  optStr(dto.nextAction, "Sledeća akcija");
  optStr(dto.status, "Status");
  optDate(dto.deadline, "Rok");
  optDate(dto.closedAt, "Datum zatvaranja");

  if (Object.keys(dto).length === 0)
    errors.push("Nema polja za izmenu.");

  if (errors.length) throw new BadRequestException(errors);
}
