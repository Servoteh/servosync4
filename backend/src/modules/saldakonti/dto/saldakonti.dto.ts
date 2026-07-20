import { BadRequestException } from "@nestjs/common";

/**
 * DTO-i modula Saldakonti (Faza 4 §A). Obrazac: interface + ručna validate*()
 * (kao nabavka/robno/handovers — class-validator još nije uveden, BACKEND_RULES §6).
 * Vrednosti/poruke na srpskom; kod na engleskom. Novac se prima kao string
 * (Decimal u JSON-u = string, BACKEND_RULES §6) i parsira na granici servisa.
 */

// ── Query DTO-i (GET) ─────────────────────────────────────────────────────────

/** GET /saldakonti/open-items — filteri otvorenih stavki. */
export interface ListOpenItemsQuery {
  accountCode?: string; // konto iz saldakonto registra (opciono; podrazumeva sve)
  partnerId?: string; // analitička = komitent (string iz query-ja → parsira se)
  asOf?: string; // presek na dan (ISO datum; default = danas)
}

/** GET /saldakonti/aging — aging bucketi po komitentu za dati kontrolni/analitički konto. */
export interface AgingQuery {
  accountCode?: string; // konto (opciono)
  asOf?: string; // presek na dan (ISO datum; default = danas)
}

// ── POST DTO-i ────────────────────────────────────────────────────────────────

/** POST /saldakonti/reconcile — uparivanje otvorenih stavki. */
export interface ReconcileDto {
  /** ID-jevi LedgerEntry redova koji se uparuju. */
  entryIds: number[];
  /** auto | manual (default auto). auto zahteva balans; manual je role-gated. */
  mode?: "auto" | "manual";
  note?: string;
}

export function validateReconcileDto(dto: ReconcileDto): void {
  const errors: string[] = [];
  if (!Array.isArray(dto.entryIds) || dto.entryIds.length < 2) {
    errors.push("Za uparivanje su potrebne bar dve stavke.");
  } else if (
    !dto.entryIds.every((v) => typeof v === "number" && Number.isInteger(v) && v > 0)
  ) {
    errors.push("Svi ID-jevi stavki moraju biti pozitivni celi brojevi.");
  } else if (new Set(dto.entryIds).size !== dto.entryIds.length) {
    errors.push("Lista stavki sadrži duplikate.");
  }
  if (dto.mode !== undefined && dto.mode !== "auto" && dto.mode !== "manual") {
    errors.push('Mode mora biti "auto" ili "manual".');
  }
  if (errors.length) throw new BadRequestException(errors);
}

/** POST /saldakonti/reconcile/unreconcile — razvezivanje grupe (role-gated). */
export interface UnreconcileDto {
  groupId: number;
}

export function validateUnreconcileDto(dto: UnreconcileDto): void {
  if (
    typeof dto?.groupId !== "number" ||
    !Number.isInteger(dto.groupId) ||
    dto.groupId <= 0
  ) {
    throw new BadRequestException("groupId mora biti pozitivan ceo broj.");
  }
}

// ── Kompenzacija ───────────────────────────────────────────────────────────────

export interface CompensationLineInput {
  ledgerEntryId: number; // otvorena stavka koja se prebija
  side: "receivable" | "payable"; // strana koja se zatvara
  amount: string; // prebijeni iznos (Decimal string; ≤ otvoreni saldo)
}

/** POST /saldakonti/compensation — kreiranje kompenzacije. */
export interface CreateCompensationDto {
  partnerId: number; // druga strana prebijanja (meki ref customers.id)
  compensationNumber?: string; // ako nije dat, generiše server
  date?: string; // ISO datum; default = danas
  lines: CompensationLineInput[];
  note?: string;
  /** knjiži odmah preko PostingEngine (KMP nalog) — default false (ostaje DRAFT). */
  post?: boolean;
}

export function validateCreateCompensationDto(dto: CreateCompensationDto): void {
  const errors: string[] = [];
  if (
    typeof dto?.partnerId !== "number" ||
    !Number.isInteger(dto.partnerId) ||
    dto.partnerId <= 0
  ) {
    errors.push("Partner (komitent) je obavezan.");
  }
  if (!Array.isArray(dto.lines) || dto.lines.length < 2) {
    errors.push("Kompenzacija mora imati bar dve stavke (obe strane).");
  } else {
    dto.lines.forEach((l, i) => {
      if (
        typeof l.ledgerEntryId !== "number" ||
        !Number.isInteger(l.ledgerEntryId) ||
        l.ledgerEntryId <= 0
      ) {
        errors.push(`Stavka ${i + 1}: neispravan ledgerEntryId.`);
      }
      if (l.side !== "receivable" && l.side !== "payable") {
        errors.push(`Stavka ${i + 1}: strana mora biti receivable ili payable.`);
      }
      if (!isPositiveDecimalString(l.amount)) {
        errors.push(`Stavka ${i + 1}: iznos mora biti pozitivan broj.`);
      }
    });
    const hasR = dto.lines.some((l) => l.side === "receivable");
    const hasP = dto.lines.some((l) => l.side === "payable");
    if (!hasR || !hasP) {
      errors.push("Kompenzacija mora imati obe strane (potraživanje i obavezu).");
    }
  }
  if (errors.length) throw new BadRequestException(errors);
}

function isPositiveDecimalString(v: unknown): boolean {
  if (typeof v !== "string" || v.trim() === "") return false;
  if (!/^-?\d+(\.\d+)?$/.test(v.trim())) return false;
  return Number(v) > 0;
}
