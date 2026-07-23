import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import type { AuthUser } from "../auth/jwt.strategy";

const D = Prisma.Decimal;
const ZERO = new D(0);

export interface CreateRateDto {
  kind: string; // zatezna | ugovorna | eskontna
  ratePct: number; // godišnja stopa u %
  validFrom: string; // ISO
  validTo?: string | null;
  note?: string | null;
}

export interface ComputeInterestDto {
  partnerId: number;
  kind?: string; // default zatezna
  method?: string; // proporcionalni (default) | konformni
  calcDate?: string; // ISO; default danas
  post?: boolean; // knjiži kamatu u GK (default false)
}

/**
 * KAMATA — obračun zatezne kamate (XL, SAP interest calc, BigBit Kamate.bas).
 * ============================================================================
 * Registar stopa (effective-dated) + obračun nad otvorenim DOSPELIM stavkama
 * (LedgerEntry: reconciledAt IS NULL, dueDate < calcDate, saldo potraživanja > 0).
 * Metod:
 *   proporcionalni: kamata = osnovica × dani × (stopa%/100) / 365
 *   konformni:      kamata = osnovica × ((1 + stopa%/100)^(dani/365) − 1)
 * Rezultat = InterestCalculation (kamatni list) + linije po stavci.
 */
@Injectable()
export class KamataService {
  constructor(private readonly prisma: PrismaService) {}

  // ── Registar stopa ──────────────────────────────────────────────────────

  async listRates(kind?: string) {
    const where: Prisma.InterestRateWhereInput = {};
    if (kind) where.kind = kind;
    const rows = await this.prisma.interestRate.findMany({
      where,
      orderBy: [{ kind: "asc" }, { validFrom: "desc" }],
    });
    return {
      data: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        ratePct: r.ratePct.toFixed(4),
        validFrom: r.validFrom,
        validTo: r.validTo,
        note: r.note,
      })),
    };
  }

  async createRate(dto: CreateRateDto) {
    if (typeof dto.kind !== "string" || dto.kind.trim() === "")
      throw new BadRequestException("Vrsta stope je obavezna.");
    if (typeof dto.ratePct !== "number" || Number.isNaN(dto.ratePct) || dto.ratePct < 0)
      throw new BadRequestException("Stopa mora biti nenegativan broj.");
    if (Number.isNaN(Date.parse(dto.validFrom)))
      throw new BadRequestException("Datum pocetka vazenja mora biti validan.");
    return this.prisma.interestRate.create({
      data: {
        kind: dto.kind.trim(),
        ratePct: new D(dto.ratePct),
        validFrom: new Date(dto.validFrom),
        validTo: dto.validTo ? new Date(dto.validTo) : null,
        note: dto.note ?? null,
      },
    });
  }

  /** Stopa `kind` koja važi na dan `on` (najnovija validFrom ≤ on, validTo null/≥ on). */
  private async rateOn(kind: string, on: Date): Promise<Prisma.Decimal | null> {
    const r = await this.prisma.interestRate.findFirst({
      where: {
        kind,
        validFrom: { lte: on },
        OR: [{ validTo: null }, { validTo: { gte: on } }],
      },
      orderBy: { validFrom: "desc" },
      select: { ratePct: true },
    });
    return r?.ratePct ?? null;
  }

  // ── Obračun ─────────────────────────────────────────────────────────────

  async compute(dto: ComputeInterestDto, actor?: AuthUser) {
    if (!Number.isInteger(dto.partnerId) || dto.partnerId <= 0)
      throw new BadRequestException("Komitent (partnerId) je obavezan.");
    const kind = dto.kind?.trim() || "zatezna";
    const method = dto.method === "konformni" ? "konformni" : "proporcionalni";
    const calcDate = dto.calcDate ? new Date(dto.calcDate) : new Date();

    const ratePct = await this.rateOn(kind, calcDate);
    if (ratePct == null)
      throw new BadRequestException(
        `Nema definisane ${kind} stope na dan ${calcDate.toISOString().slice(0, 10)} (dodaj stopu u registar).`,
      );

    // Otvorene DOSPELE stavke komitenta: nezatvorene, sa dospećem pre dana obračuna.
    const entries = await this.prisma.ledgerEntry.findMany({
      where: {
        analyticalCode: dto.partnerId,
        reconciledAt: null,
        dueDate: { not: null, lt: calcDate },
      },
      select: {
        id: true,
        documentNumber: true,
        debit: true,
        credit: true,
        dueDate: true,
      },
    });

    const rateFraction = ratePct.div(100);
    const lines: {
      ledgerEntryId: number;
      documentNumber: string | null;
      principal: Prisma.Decimal;
      dueDate: Date;
      daysOverdue: number;
      ratePct: Prisma.Decimal;
      interest: Prisma.Decimal;
    }[] = [];

    let totalPrincipal = ZERO;
    let totalInterest = ZERO;

    for (const e of entries) {
      // Osnovica = otvoreni saldo potraživanja (duguje − potražuje); samo pozitivan.
      const principal = e.debit.sub(e.credit);
      if (principal.lte(0) || !e.dueDate) continue;

      const days = Math.floor(
        (calcDate.getTime() - e.dueDate.getTime()) / 86_400_000,
      );
      if (days <= 0) continue;

      let interest: Prisma.Decimal;
      if (method === "konformni") {
        // osnovica × ((1 + r)^(dani/365) − 1)
        const factor =
          Math.pow(1 + rateFraction.toNumber(), days / 365) - 1;
        interest = principal.mul(new D(factor));
      } else {
        // osnovica × dani × r / 365
        interest = principal.mul(days).mul(rateFraction).div(365);
      }
      interest = interest.toDecimalPlaces(4);

      totalPrincipal = totalPrincipal.add(principal);
      totalInterest = totalInterest.add(interest);
      lines.push({
        ledgerEntryId: e.id,
        documentNumber: e.documentNumber,
        principal,
        dueDate: e.dueDate,
        daysOverdue: days,
        ratePct,
        interest,
      });
    }

    if (lines.length === 0)
      throw new BadRequestException(
        "Nema otvorenih dospelih stavki za obračun kamate za tog komitenta na taj dan.",
      );

    const calc = await this.prisma.interestCalculation.create({
      data: {
        partnerId: dto.partnerId,
        kind,
        method,
        calcDate,
        totalPrincipal,
        totalInterest,
        status: "DRAFT",
        createdByUserId: actor?.userId ?? null,
        lines: { create: lines },
      },
      include: { lines: { orderBy: { id: "asc" } } },
    });

    return this.serializeCalc(calc);
  }

  async listCalculations(partnerId?: number) {
    const where: Prisma.InterestCalculationWhereInput = {};
    if (partnerId != null) where.partnerId = partnerId;
    const rows = await this.prisma.interestCalculation.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return {
      data: rows.map((c) => ({
        id: c.id,
        partnerId: c.partnerId,
        kind: c.kind,
        method: c.method,
        calcDate: c.calcDate,
        totalPrincipal: c.totalPrincipal.toFixed(2),
        totalInterest: c.totalInterest.toFixed(2),
        status: c.status,
      })),
    };
  }

  async getCalculation(id: number) {
    const calc = await this.prisma.interestCalculation.findUnique({
      where: { id },
      include: { lines: { orderBy: { id: "asc" } } },
    });
    if (!calc) throw new NotFoundException(`Obračun kamate ${id} ne postoji.`);
    return this.serializeCalc(calc);
  }

  private serializeCalc(
    c: Prisma.InterestCalculationGetPayload<{ include: { lines: true } }>,
  ) {
    return {
      id: c.id,
      partnerId: c.partnerId,
      kind: c.kind,
      method: c.method,
      calcDate: c.calcDate,
      totalPrincipal: c.totalPrincipal.toFixed(2),
      totalInterest: c.totalInterest.toFixed(2),
      status: c.status,
      journalEntryId: c.journalEntryId,
      lines: c.lines.map((l) => ({
        id: l.id,
        ledgerEntryId: l.ledgerEntryId,
        documentNumber: l.documentNumber,
        principal: l.principal.toFixed(2),
        dueDate: l.dueDate,
        daysOverdue: l.daysOverdue,
        ratePct: l.ratePct.toFixed(4),
        interest: l.interest.toFixed(2),
      })),
    };
  }
}
