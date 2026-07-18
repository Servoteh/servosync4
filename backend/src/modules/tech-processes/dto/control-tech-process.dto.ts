import { BadRequestException } from "@nestjs/common";

/**
 * `POST /tech-processes/control` — ZAVRŠNA KONTROLA (MODULE_SPEC_kontrola §3.2/§5,
 * legacy BarKodUnos2024 ekrani 5–7). Kontrolor skenira nalog + operaciju (kao kod
 * prijave rada) i identifikuje se ID karticom (`workerCard` → `workers.cardId`;
 * obavezan audit ko+kada, ODLUKE #14).
 *
 * 🔴 Create-on-scan (legacy `SacuvajRNSIzUnosaBarKoda`): za završnu kontrolu red u
 * `tech_processes` obično NE postoji unapred (pravi se pri kontroli). Servis zato
 * NAĐE otvoren red ili ga OTVORI — pošto proveri da je operacija u routingu RN-a
 * (`work_order_operations`) i da je radni centar `significant_for_finishing`.
 *
 * 🔴 ProveriDefinisneKolicine (MODULE_SPEC_lokacije §3.3): zbir `locations[].quantity`
 * MORA biti jednak `pieceCount`. class-validator još nije uveden (BACKEND_RULES §6) — ručno.
 *
 * P1: DORADA/ŠKART (`qualityTypeId` 1/2) se knjiži sa tim kvalitetom, ali child RN
 * (`-D/-S`) + poruka tehnologu su P2 → odgovor nosi `childOrderPending: true`.
 */
export interface ControlLocationInput {
  /** Pozicija/polica (FK `positions`) na koju se odlaže deo. */
  positionId: number;
  /** Broj komada na toj poziciji — ceo broj ≥ 1. */
  quantity: number;
}

export interface ControlTechProcessDto {
  /** Nalog barkod: `RNZ:projectId:identNumber:variant:revision`. */
  orderBarcode: string;
  /** Operacija (završne kontrole) barkod: `S:operationNumber:workCenterCode:0:revision`. */
  operationBarcode: string;
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
  /**
   * Overshoot potvrda (K0.2): kada bi kumulativ prešao plan, FE prvo pokaže dijalog
   * pa ponovi zahtev sa `confirmOvershoot: true` — tada se dozvoljava unos preko plana
   * (strugar naparavi 1-2 viška, Nenad 15.07). Bez flag-a premašaj = 422.
   */
  confirmOvershoot?: boolean;
}

const QUALITY_VALUES = new Set([0, 1, 2]);

export function validateControl(dto: ControlTechProcessDto): void {
  const errors: string[] = [];

  if (typeof dto?.orderBarcode !== "string" || !dto.orderBarcode.trim())
    errors.push("Polje 'orderBarcode' je obavezno.");
  if (typeof dto?.operationBarcode !== "string" || !dto.operationBarcode.trim())
    errors.push("Polje 'operationBarcode' je obavezno.");

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

  if (dto?.note !== undefined && (typeof dto.note !== "string" || dto.note.trim().length > 500))
    errors.push("Polje 'note' mora biti string do 500 karaktera.");

  if (dto?.confirmOvershoot !== undefined && typeof dto.confirmOvershoot !== "boolean")
    errors.push("Polje 'confirmOvershoot' mora biti boolean.");

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
