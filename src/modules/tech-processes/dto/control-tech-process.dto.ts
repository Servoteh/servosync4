import { BadRequestException } from "@nestjs/common";

/**
 * `POST /tech-processes/:id/control` — ZAVRŠNA KONTROLA (MODULE_SPEC_kontrola §3.2/§5,
 * legacy BarKodUnos2024 ekrani 5–7). Kontrolor se identifikuje ID karticom
 * (`workerCard` → `workers.cardId`; obavezan audit ko+kada, ODLUKE #14), unosi broj
 * iskontrolisanih (dobrih) komada, kvalitet, i **raspoređuje** komade po policama
 * (`part_locations`, MODULE_SPEC_lokacije §3.7 — lokacija tek posle završne kontrole).
 *
 * 🔴 ProveriDefinisneKolicine (MODULE_SPEC_lokacije §3.3): zbir `locations[].quantity`
 * MORA biti jednak `pieceCount` — bez toga se kontrola ne snima.
 *
 * P1: DORADA/ŠKART (`qualityTypeId` 1/2) se prihvata i knjiži sa tim kvalitetom, ali
 * kreiranje child RN-a (`-D/-S`) + poruka tehnologu je P2 (TODO) — odgovor tada nosi
 * `childOrderPending: true`. class-validator još nije uveden (BACKEND_RULES §6) — ručno.
 */
export interface ControlLocationInput {
  /** Pozicija/polica (FK `positions`) na koju se odlaže deo. */
  positionId: number;
  /** Broj komada na toj poziciji — ceo broj ≥ 1. */
  quantity: number;
}

export interface ControlTechProcessDto {
  /** ID kartica kontrolora (`workers.cardId`) — obavezno (audit: ko + kada, ODLUKE #14). */
  workerCard: string;
  /** Ukupan broj iskontrolisanih komada — ceo broj ≥ 1 (= zbir `locations[].quantity`). */
  pieceCount: number;
  /** Vrsta kvaliteta: 0=dobar (P1), 1=dorada, 2=škart. */
  qualityTypeId: number;
  /** Raspored po policama; 🔴 zbir `quantity` MORA = `pieceCount` (ProveriDefinisneKolicine). */
  locations: ControlLocationInput[];
  /** Napomena kontrolora (opciono). */
  note?: string;
}

const QUALITY_VALUES = new Set([0, 1, 2]);

export function validateControl(dto: ControlTechProcessDto): void {
  const errors: string[] = [];

  if (typeof dto?.workerCard !== "string" || !dto.workerCard.trim())
    errors.push("Polje 'workerCard' (ID kartica kontrolora) je obavezno.");

  if (
    typeof dto?.pieceCount !== "number" ||
    !Number.isInteger(dto.pieceCount) ||
    dto.pieceCount < 1
  )
    errors.push("Polje 'pieceCount' mora biti ceo broj ≥ 1.");

  if (typeof dto?.qualityTypeId !== "number" || !QUALITY_VALUES.has(dto.qualityTypeId))
    errors.push("Polje 'qualityTypeId' mora biti 0 (dobar), 1 (dorada) ili 2 (škart).");

  if (!Array.isArray(dto?.locations) || dto.locations.length === 0) {
    errors.push("Polje 'locations' mora imati bar jedan raspored (pozicija + količina).");
  } else {
    dto.locations.forEach((loc, i) => {
      if (
        typeof loc?.positionId !== "number" ||
        !Number.isInteger(loc.positionId) ||
        loc.positionId < 1
      )
        errors.push(`locations[${i}].positionId mora biti ceo broj ≥ 1.`);
      if (
        typeof loc?.quantity !== "number" ||
        !Number.isInteger(loc.quantity) ||
        loc.quantity < 1
      )
        errors.push(`locations[${i}].quantity mora biti ceo broj ≥ 1.`);
    });
    // 🔴 ProveriDefinisneKolicine: zbir raspoređenih = ukupno iskontrolisano.
    const sum = dto.locations.reduce(
      (s, l) => s + (Number.isInteger(l?.quantity) ? l.quantity : 0),
      0,
    );
    if (Number.isInteger(dto?.pieceCount) && sum !== dto.pieceCount)
      errors.push(
        `Zbir raspoređenih po policama (${sum}) mora biti jednak broju iskontrolisanih komada (${dto.pieceCount}).`,
      );
  }

  if (errors.length) throw new BadRequestException(errors);
}
