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

/**
 * GRUPA = JEDAN DOKUMENT (osnovica kamate). Ključ je BROJ DOKUMENTA, a ne (broj +
 * vrsta) — i to je namerno, ne propust.
 * ─────────────────────────────────────────────────────────────────────────────
 * KVAR KOJI JE OVDE POSTOJAO (i zašto je popravljen drugde): kupac sa nenaplaćenim
 * avansnim računom `7/26` (12.000, dospeće 10.02) i fakturom `7/26` (12.000,
 * dospeće 30.06) davao je JEDNU stavku od 24.000 sa RANIJIM dospećem — obračun
 * kamate na duplo veći iznos, mesecima predugo. Dugovna strana avansa ide na isti
 * kupčev konto kao faktura, pa ih ništa nije razdvajalo.
 *
 * Do prelaska na kratak broj (O-F1) to nije bilo moguće: broj je nosio slovni
 * prefiks vrste (`AVR0007/2026` vs `IFR0007/2026`). Odluka O-F6 tu zaštitu vraća
 * na jedinom mestu na kom sme — u NUMERACIJI: avansni račun ima sopstvenu seriju
 * `A-7/26` (v. `sales/numbering.service.ts`), pa se dva dokumenta više ne mogu
 * naći pod istim ključem.
 *
 * ZAŠTO VRSTA NE SME U KLJUČ: `ledger_entries` nema kolonu vrste dokumenta, a i da
 * je dobije, uvođenje vrste u ključ bi RASKINULO netiranje. Uplata sa izvoda
 * (`izvodi/bank-statement.service.ts` upisuje poziv na broj kao `document_number`),
 * ručna korekcija knjigovođe (`gl-write`) i uvezeni BigBit red nose broj dokumenta
 * ALI NE i vrstu — faktura bi ostala u svojoj grupi, a njena uplata u drugoj, i
 * kamata bi se opet računala na već plaćeni deo fakture. Tačno nalaz VISOK zbog
 * kog je netiranje i uvedeno. Ključ zato ostaje broj; razdvajanje vrsta je posao
 * numeracije.
 *
 * @param documentNumber broj dokumenta iz GK stavke (null = stavka bez dokumenta)
 * @param ledgerEntryId  fallback kad broja nema — svaka takva stavka je svoja grupa
 *                       (bez ovoga bi se SVE stavke partnera bez broja netovale u
 *                       jednu, pa bi npr. uplata bez poziva na broj pojela osnovicu)
 */
export function documentGroupKey(
  documentNumber: string | null,
  ledgerEntryId: number,
): string {
  return documentNumber ?? `__id:${ledgerEntryId}`;
}

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

    // Samo receivable saldakonto konta iz registra (obrazac payment-preparation za
    // payable stranu) — bez ovoga u osnovicu ulaze i dobavljačke (payable) stavke
    // istog komitenta i stavke sa ne-saldakonto konta.
    //
    // ✅ ZATVOREN NALAZ K-1 (05.08.2026) — uz `side` ide i `partnerScope: "customer"`.
    //
    // Sam `side: "receivable"` hvata PET konta, ne dva (izmereno nad registrom na
    // produkciji): pored kupaca 2040/2050 i **1520/1521/1530 = avansi koje smo MI PLATILI
    // DOBAVLJAČU** (`partner_scope = 'supplier'`). Otvorena stavka
    // `1520 / komitent 77 / AV-3/26 / 500.000,00 / dospeće 01.03.2026` ulazila je u kamatni
    // list kao glavnica 500.000,00 / 154 dana / kamata 20.041,10 (stopa 9,50 %).
    //
    // IZMERENO NAD CELIM SKUPOM (05.08.2026): 522 nezatvorene stavke; posle netiranja po
    // dokumentu u obračun bi ušlo **46.689.255,50 RSD** na 64 dokumenta → kamata po 9,5 %
    // iznosila bi **2.492.005 RSD koje bismo poslali sopstvenim dobavljačima**.
    //
    // Zašto se sad sme suziti: knjigovođa je na pitanje 15 („zatezna kamata i na avanse
    // koje smo MI platili dobavljaču") odgovorio **„Nemamo za sada"**. Dati avans jeste
    // potraživanje, ali za ISPORUKU ROBE — ne dospelo novčano potraživanje po kome teče
    // zatezna kamata.
    //
    // ⚠️ Kvar je bio LATENTAN samo zato što je tabela stopa prazna — budi ga prvi unos
    // stope. Zato ovo ulazi PRE seed-a registra stopa, ne posle.
    // Brana: `kamata.service.spec.ts` → „osnovica ne uzima avanse dobavljačima".
    const receivableAccounts = await this.prisma.saldakontoAccount.findMany({
      where: {
        side: "receivable",
        partnerScope: "customer",
        tracksOpenItems: true,
      },
      select: { account: true },
    });
    const accountCodes = receivableAccounts.map((a) => a.account);

    // Otvorene stavke komitenta (nezatvorene). Uzimamo SVE redove (i uplate bez dueDate)
    // da bismo NETIRALI osnovicu po dokumentu — inače se kamata računa na već plaćeni deo
    // fakture (review VISOK). Grupišemo po document_number kao open-items.service.
    // Samo proknjiženi/zaključani nalozi — nacrt ne sme u osnovicu kamate.
    //
    // ⚠️ NA ČEMU POČIVA GRUPISANJE PO BROJU (v. `documentGroupKey` ispod).
    const entries =
      accountCodes.length === 0
        ? []
        : await this.prisma.ledgerEntry.findMany({
            where: {
              analyticalCode: dto.partnerId,
              reconciledAt: null,
              accountCode: { in: accountCodes },
              journalEntry: { status: { in: ["POSTED", "LOCKED"] } },
            },
            select: {
              id: true,
              documentNumber: true,
              debit: true,
              credit: true,
              dueDate: true,
            },
          });

    // Neto saldo + najranije dospeće po dokumentu (grupa = document_number; null → svoj ključ po id).
    const groups = new Map<
      string,
      { principal: Prisma.Decimal; dueDate: Date | null; anyLedgerId: number; docNo: string | null }
    >();
    for (const e of entries) {
      const key = documentGroupKey(e.documentNumber, e.id);
      const g = groups.get(key) ?? {
        principal: ZERO,
        dueDate: null,
        anyLedgerId: e.id,
        docNo: e.documentNumber,
      };
      g.principal = g.principal.add(e.debit).sub(e.credit);
      if (e.dueDate && (!g.dueDate || e.dueDate < g.dueDate)) g.dueDate = e.dueDate;
      groups.set(key, g);
    }

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

    for (const g of groups.values()) {
      // Osnovica = NETO otvoreni saldo dokumenta (Σduguje − Σpotražuje); samo dospelo pozitivno.
      if (g.principal.lte(0) || !g.dueDate || g.dueDate >= calcDate) continue;

      const days = Math.floor(
        (calcDate.getTime() - g.dueDate.getTime()) / 86_400_000,
      );
      if (days <= 0) continue;

      let interest: Prisma.Decimal;
      if (method === "konformni") {
        const factor = Math.pow(1 + rateFraction.toNumber(), days / 365) - 1;
        interest = g.principal.mul(new D(factor));
      } else {
        interest = g.principal.mul(days).mul(rateFraction).div(365);
      }
      interest = interest.toDecimalPlaces(4);

      totalPrincipal = totalPrincipal.add(g.principal);
      totalInterest = totalInterest.add(interest);
      lines.push({
        ledgerEntryId: g.anyLedgerId,
        documentNumber: g.docNo,
        principal: g.principal,
        dueDate: g.dueDate,
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
