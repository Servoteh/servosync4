import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { pageMeta, parsePagination } from "../../common/pagination";
import { byId, uniqueIds } from "../../common/relations";
import type { ListCustomersQuery } from "./dto/list-customers.dto";

/**
 * Kolone komitenta za listu (šifra, naziv, mesto, PIB, vrsta šifre, prodavac).
 * Detalj vraća SVE kolone (`findUnique` bez `select`).
 */
const CUSTOMER_LIST_SELECT = {
  id: true,
  name: true,
  city: true,
  taxId: true,
  codeTypeCode: true,
  salespersonId: true,
} as const;

/** Bezbedan podskup prodavca — NIKAD `password` / `loginAccount` / `idNumber`. */
const SAFE_SALESPERSON_SELECT = {
  id: true,
  name: true,
  firstName: true,
} as const;

/** Uplatni račun (`UplatniRacuni` → `payment_accounts`) — meki ref sa `paymentAccountId`. */
const PAYMENT_ACCOUNT_SELECT = {
  id: true,
  accountNumber: true,
  bankName: true,
  bankCode: true,
  countryCode: true,
} as const;

/**
 * Read-only pregled matičnog podatka „Komitenti" (BigBit cache `customers`).
 *
 * BACKEND_RULES §3/§11.1: `customers` piše ISKLJUČIVO `customer.syncer.ts` — ovaj
 * servis NEMA mutacija (unos komitenta ostaje u BigBit formi „Unos komitenata",
 * v. `docs/migration/BIGBIT_KOMITENTI.md` §4).
 *
 * Razlika prema `modules/directory` (koji takođe čita `customers`): tamo je
 * NAMERNO sužen poslovni podskup (bez računa/rabata/limita) jer služi kao
 * šifarnik za 2.0 ekrane; ovde je matični karton 4.0 — pun slog, uključujući
 * komercijalne kolone koje BigBit prikazuje na formi komitenta.
 *
 * FK-ovi se razrešavaju BATCH upitima, ne `include`-om: legacy podaci imaju
 * „orphan" reference (`salesperson_id = 0` bez prodavca 0, `payment_account_id = 0`)
 * i required-relation JOIN bi dao `Inconsistent query result` → 500
 * (v. `common/relations.ts`).
 */
@Injectable()
export class MasterCustomersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ListCustomersQuery) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );

    const where: Prisma.CustomerWhereInput = {};
    const q = query.q?.trim();
    if (q) {
      where.OR = [
        { name: { contains: q, mode: "insensitive" } },
        { taxId: { contains: q, mode: "insensitive" } },
        { city: { contains: q, mode: "insensitive" } },
      ];
    }
    const codeTypeCode = query.codeTypeCode?.trim();
    if (codeTypeCode) where.codeTypeCode = codeTypeCode;

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.customer.findMany({
        where,
        orderBy: [{ name: "asc" }, { id: "asc" }],
        skip,
        take,
        select: CUSTOMER_LIST_SELECT,
      }),
      this.prisma.customer.count({ where }),
    ]);

    const [salespeople, codeTypes] = await Promise.all([
      this.resolveSalespeople(rows.map((r) => r.salespersonId)),
      this.resolveCodeTypes(rows.map((r) => r.codeTypeCode)),
    ]);

    const data = rows.map((r) => ({
      ...r,
      salesperson: salespeople.get(r.salespersonId ?? 0) ?? null,
      codeType: codeRef(r.codeTypeCode, codeTypes),
    }));

    return { data, meta: pageMeta(page, pageSize, total) };
  }

  /** Sva polja komitenta + razrešeni vrsta šifre / prodavac / uplatni račun. */
  async findOne(id: number) {
    const customer = await this.prisma.customer.findUnique({ where: { id } });
    if (!customer) throw new NotFoundException(`Komitent ${id} ne postoji`);

    const [salespeople, codeTypes, paymentAccount] = await Promise.all([
      this.resolveSalespeople([customer.salespersonId]),
      this.resolveCodeTypes([customer.codeTypeCode]),
      this.resolvePaymentAccount(customer.paymentAccountId),
    ]);

    // Decimal → string u JSON-u (BACKEND_RULES §6); ostale procentualne kolone su
    // u legacy portu `Float` (BigBit `Double`) i ostaju brojevi.
    const { creditLimit, manualMarkupPercent, ...rest } = customer;
    const data = {
      ...rest,
      creditLimit: creditLimit?.toString() ?? null,
      manualMarkupPercent: manualMarkupPercent?.toString() ?? null,
      salesperson: salespeople.get(customer.salespersonId ?? 0) ?? null,
      codeType: codeRef(customer.codeTypeCode, codeTypes),
      paymentAccount,
    };
    return { data };
  }

  // --- batch resolveri (orphan FK → null, nikad 500) ---

  private async resolveSalespeople(ids: (number | null | undefined)[]) {
    const uniq = uniqueIds(ids);
    if (!uniq.length) return new Map<number, never>();
    return byId(
      await this.prisma.salesperson.findMany({
        where: { id: { in: uniq } },
        select: SAFE_SALESPERSON_SELECT,
      }),
    );
  }

  private async resolveCodeTypes(codes: (string | null | undefined)[]) {
    const uniq = [
      ...new Set(
        codes.filter((c): c is string => typeof c === "string" && c !== ""),
      ),
    ];
    if (!uniq.length) return new Map<string, string | null>();
    const rows = await this.prisma.codeType.findMany({
      where: { code: { in: uniq } },
      select: { code: true, description: true },
    });
    return new Map(rows.map((r) => [r.code, r.description]));
  }

  /**
   * Meki ref: `payment_account_id` je legacy `Long` sa defaultom 0 („nije zadat"),
   * a red u `payment_accounts` može i da ne postoji — oba slučaja daju `null`.
   */
  private async resolvePaymentAccount(id: number | null | undefined) {
    if (typeof id !== "number" || id <= 0) return null;
    return (
      (await this.prisma.paymentAccount.findUnique({
        where: { id },
        select: PAYMENT_ACCOUNT_SELECT,
      })) ?? null
    );
  }
}

/** `{ code, description }`; kod bez reda u šifarniku → `description: null`. */
function codeRef(
  code: string | null | undefined,
  descriptions: Map<string, string | null>,
): { code: string; description: string | null } | null {
  if (!code) return null;
  return { code, description: descriptions.get(code) ?? null };
}
