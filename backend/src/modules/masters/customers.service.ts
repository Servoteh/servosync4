import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { pageMeta, parsePagination } from "../../common/pagination";
import { byId, uniqueIds } from "../../common/relations";
import type { ListCustomersQuery } from "./dto/list-customers.dto";
import { canReadCommercial, type MastersActor } from "./masters-access";

/**
 * Kolone komitenta za listu (šifra, naziv, mesto, PIB, vrsta šifre, prodavac).
 * Ništa komercijalno — lista je ista za oba sloja pristupa (v. `findOne`).
 */
const CUSTOMER_LIST_SELECT = {
  id: true,
  name: true,
  city: true,
  taxId: true,
  codeTypeCode: true,
  salespersonId: true,
} as const;

/**
 * BAZNI SLOJ kartona komitenta — ono što vidi svako sa `directory.read`.
 * Skup je NAMERNO identičan `CUSTOMER_BUSINESS_SELECT` iz `directory.service.ts`
 * (isti podatak, ista širina — jedan izvor istine o tome šta je „bezbedno").
 *
 * NEMA ga ovde (traži `masters.read`, v. `masters-access.ts`): žiro računi
 * (bankAccount1-3) i uplatni račun, rabati (customerDiscount, fictitiousDiscount),
 * provizija, ručna marža, kreditni limit, cenovnik, valuta/način plaćanja, provera
 * duga, PDV/GLN/JBKJS/CRF, eksterne šifre, ruta/vozač, napomena za salda i audit
 * kolone. Podela je na nivou `select`-a: nova kolona u šemi ne može da procuri u
 * bazni sloj dok je neko svesno ne doda ovde (fail-closed).
 */
const CUSTOMER_BASE_SELECT = {
  id: true,
  name: true,
  shortName: true,
  branch: true,
  city: true,
  address: true,
  postalCode: true,
  country: true,
  taxId: true,
  registrationNumber: true,
  phone: true,
  mobile: true,
  fax: true,
  email: true,
  webAddress: true,
  contact: true,
  note: true,
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
 * DVA SLOJA ODGOVORA (odluka Nenad 29.07.2026, v. `masters-access.ts`) — time je
 * zatvorena ranija razlika prema `modules/directory`: ruta i dalje stoji na
 * `directory.read` (svako je vidi), ali sa SAMO tim ključem karton vraća isti
 * bezbedan podskup koji `directory` namerno prikazuje. Komercijalne kolone (računi,
 * rabati, limit, provizija, marža) izlaze tek uz `masters.read`. Redakcija je u
 * backendu; `meta.restricted` samo javlja FE-u koji je sloj stigao.
 *
 * FK-ovi se razrešavaju BATCH upitima, ne `include`-om: legacy podaci imaju
 * „orphan" reference (`salesperson_id = 0` bez prodavca 0, `payment_account_id = 0`)
 * i required-relation JOIN bi dao `Inconsistent query result` → 500
 * (v. `common/relations.ts`).
 */
@Injectable()
export class MasterCustomersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ListCustomersQuery, actor?: MastersActor) {
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

    const [salespeople, codeTypes, commercial] = await Promise.all([
      this.resolveSalespeople(rows.map((r) => r.salespersonId)),
      this.resolveCodeTypes(rows.map((r) => r.codeTypeCode)),
      canReadCommercial(this.prisma, actor),
    ]);

    const data = rows.map((r) => ({
      ...r,
      salesperson: salespeople.get(r.salespersonId ?? 0) ?? null,
      codeType: codeRef(r.codeTypeCode, codeTypes),
    }));

    // Lista ne nosi komercijalne kolone, ali `restricted` ide i ovde — FE po njemu
    // označava ekran („ograničen prikaz") pre nego što se otvori ijedan karton.
    return {
      data,
      meta: { ...pageMeta(page, pageSize, total), restricted: !commercial },
    };
  }

  /**
   * Karton komitenta + razrešeni prodavac (oba sloja) i vrsta šifre / uplatni
   * račun (samo pun karton). Skup kolona zavisi od `masters.read`.
   */
  async findOne(id: number, actor?: MastersActor) {
    const commercial = await canReadCommercial(this.prisma, actor);
    return commercial ? this.findOneFull(id) : this.findOneBase(id);
  }

  /** Pun karton (`masters.read`): sve kolone + vrsta šifre + uplatni račun. */
  private async findOneFull(id: number) {
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
    return { data, meta: { restricted: false } };
  }

  /**
   * Bazni karton (samo `directory.read`): isti podskup koji vraća `directory`.
   * Uplatni račun se i NE ČITA — bez `masters.read` nema šta da se prikaže.
   */
  private async findOneBase(id: number) {
    const customer = await this.prisma.customer.findUnique({
      where: { id },
      select: CUSTOMER_BASE_SELECT,
    });
    if (!customer) throw new NotFoundException(`Komitent ${id} ne postoji`);

    const salespeople = await this.resolveSalespeople([customer.salespersonId]);
    const data = {
      ...customer,
      salesperson: salespeople.get(customer.salespersonId ?? 0) ?? null,
    };
    return { data, meta: { restricted: true } };
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
