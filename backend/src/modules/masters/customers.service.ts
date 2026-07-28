import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { pageMeta, parsePagination } from "../../common/pagination";
import { byId, uniqueIds } from "../../common/relations";
import { alignIdSequence } from "../../common/db-sequences";
import { rejectCustomerWrite } from "../directory/bigbit-owned";
import type { AuthUser } from "../auth/jwt.strategy";
import type { ListCustomersQuery } from "./dto/list-customers.dto";
import {
  validateCreateCustomer,
  validateUpdateCustomer,
  type CustomerWriteControls,
  type CustomerWriteData,
} from "./dto/upsert-customer.dto";
import {
  assertTaxIdAcceptable,
  duplicateTaxIdWarning,
  isDriverCodeType,
  isPlaceholderTaxId,
  softValidationWarnings,
  taxIdPlaceholder,
  type ExistingTaxIdHolder,
} from "./customers.validation";

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
 * BRANA UPISA — `customers` je READ-ONLY za celu aplikaciju (odluka vlasnika
 * 26.07.2026, izvor teksta: `modules/directory/bigbit-owned.ts`).
 * =========================================================================
 * Unos/izmena komitenta je OVDE IMPLEMENTIRAN U CELOSTI, ali se ne izvršava dok
 * ovaj prekidač stoji na `false`. Tri uslova moraju biti ispunjena PRE otvaranja,
 * i nijedan nije u granicama ovog modula:
 *
 *   1. **Vlasnik povlači odluku od 26.07.2026.** Dok stoji, jedini pisac tabele je
 *      sync modul; poruka korisniku dolazi iz `bigbit-owned.ts` (jedan izvor teksta
 *      i za backend i za ekrane).
 *   2. **`customers` mora ući u `sync/table-ownership.ts`** (`NATIVE_COLUMN_TABLES`)
 *      sa testom koji to pinuje. Danas komitent nastao u 4.0 preživljava SLUČAJNO —
 *      zato što je `CustomerSyncer` bespoke i nikad ne briše; čim se on ukloni kao
 *      „duplikat generičkog", `full_refresh` radi `deleteMany({})` nad celom tabelom.
 *   3. **Sekvenca `customers_id_seq` mora biti klampovana IZNAD BigBit prostora
 *      ključeva** (migracija). `Customer.id` JESTE BigBit `Sifra` (PK se ne remapira),
 *      sync upisuje eksplicitne id-jeve i ne pomera sekvencu, pa bi prvi 4.0-native
 *      unos ili pao na 23505 ili tiho seo na tuđu šifru koju sledeći sync prebriše.
 *      `alignIdSequence` ispod uklanja SAMO trenutni 23505, ne i „squatter" scenario.
 *
 * Tip je namerno `boolean` (ne literal `false`) da provera ostane prava grana toka,
 * a ne mrtav kod za TypeScript.
 */
export const CUSTOMERS_WRITE_OPEN: boolean = false;

/** Baci 409 `BIGBIT_OWNED_READ_ONLY` dok je upis zatvoren. */
export function assertCustomerWriteAllowed(): void {
  if (!CUSTOMERS_WRITE_OPEN) rejectCustomerWrite();
}

/** Podrazumevana vrsta šifre (`Komitenti.Vrsta sifre` je NOT NULL u originalu). */
const DEFAULT_CODE_TYPE = "KUPDOB";

/**
 * `PrviUnosUser`/`PoslednjaIzmenaUser` su `VarChar(20)` — e-mail se u njih ne uklapa,
 * pa se upisuje lokalni deo (pre `@`), skraćen na 20 znakova; ako ga nema, `userId`.
 */
function auditName(user: AuthUser | undefined): string | null {
  const local = (user?.email ?? "").split("@")[0]?.trim() ?? "";
  if (local) return local.slice(0, 20);
  return user?.userId != null ? String(user.userId).slice(0, 20) : null;
}

/**
 * Read-only pregled matičnog podatka „Komitenti" (BigBit cache `customers`).
 *
 * BACKEND_RULES §3/§11.1: `customers` danas piše ISKLJUČIVO `customer.syncer.ts`.
 * `create`/`update` ispod su pun port forme „Unos komitenata"
 * (`docs/migration/BIGBIT_KOMITENTI.md` §1/§3/§4), ali stoje iza brane
 * `assertCustomerWriteAllowed()` — v. `CUSTOMERS_WRITE_OPEN` iznad.
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

  // ══════════════════════════════════════════════════════════════════════════
  // UNOS / IZMENA — port forme „Unos komitenata" (BIGBIT_KOMITENTI.md §1/§3/§4)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Unos novog komitenta. Redosled je namerno ovakav:
   *   1. oblik/dužine/tipovi        → 400 (odmah, bez ijednog upita)
   *   2. zaključano polje `paymentMethod` → 403
   *   3. PIB polu-tvrda brana       → 422 `PIB_NIJE_DOBAR` (BigBit dijalog)
   *   4. FK provere                 → 422 sa imenovanom vrednošću
   *   5. meka upozorenja (GLN/računi/dupli PIB) — ne obaraju zahtev
   *   6. **BRANA UPISA**            → 409 `BIGBIT_OWNED_READ_ONLY` (danas uvek)
   *   7. upis u transakciji
   *
   * Provere idu PRE brane da bi klijent koji sprema podatak dobio tačnu grešku
   * (npr. „PIB nije dobar") umesto da mu se tek u BigBit-u ispostavi da je pogrešan.
   */
  async create(body: unknown, user?: AuthUser) {
    const data = validateCreateCustomer(body);
    assertPaymentMethodNotWritten(data);

    // `Vrsta sifre` je NOT NULL u originalu; ako nije poslata, koristi se isti
    // default koji nosi kolona — ali EKSPLICITNO, da FK provera ispod gleda baš
    // vrednost koja će biti upisana.
    if (data.codeTypeCode === undefined) data.codeTypeCode = DEFAULT_CODE_TYPE;

    // Legacy sentinel `0` („nije zadat") NE SME u bazu app putem: `fk_customers_salespeople`
    // i `fk_customers_driver` su prava FK ograničenja (baseline migracija :1529, :1532), a
    // zatečeni redovi sa `salesperson_id = 0` postoje samo zato što ih sync upisuje pod
    // `session_replication_role='replica'` gde FK trigeri ne rade. Za native red = NULL.
    normalizeLegacyZeroFks(data);
    if (data.salespersonId === undefined) data.salespersonId = null;
    if (data.driverId === undefined) data.driverId = null;

    assertTaxIdAcceptable({
      taxId: data.taxId ?? null,
      skipTaxIdValidation: data.skipTaxIdValidation === true,
      confirmInvalidTaxId: readConfirmFlag(body),
    });

    await this.assertReferences(data);

    const upozorenja = [
      ...softValidationWarnings(data),
      ...(await this.duplicateTaxIdWarnings(data.taxId ?? null, null)),
    ];

    assertCustomerWriteAllowed(); // ← 409 dok stoji odluka od 26.07.2026

    const who = auditName(user);
    const now = new Date();
    // Prazan PIB ide privremeno kao "" (kolona je NOT NULL), pa se odmah u istoj
    // transakciji zamenjuje sa `XX_<id>` — id je poznat tek posle insert-a.
    const needsPlaceholder = !data.taxId;

    const id = await this.prisma.$transaction(async (tx) => {
      // Sync upisuje eksplicitne id-jeve i ne pomera sekvencu → poravnaj je pre
      // insert-a, inače `nextval` vraća zauzetu šifru (23505). NAPOMENA: ovo NE
      // rešava „squatter" scenario (v. `CUSTOMERS_WRITE_OPEN`, uslov 3).
      await alignIdSequence(tx, "customers");

      const row = await tx.customer.create({
        data: {
          ...(data as Prisma.CustomerUncheckedCreateInput),
          name: data.name as string,
          taxId: data.taxId ?? "",
          createdAt: now,
          updatedAt: now,
          createdBy: who,
          updatedBy: who,
        },
        select: { id: true, driverId: true },
      });

      const patch: Prisma.CustomerUncheckedUpdateInput = {};
      if (needsPlaceholder) patch.taxId = taxIdPlaceholder(row.id);
      // BigBit automatika vozača (§4 :212-219) — komitent-vozač referiše sam sebe.
      if (isDriverCodeType(data.codeTypeCode) && !row.driverId) {
        patch.driverId = row.id;
      }
      if (Object.keys(patch).length) {
        await tx.customer.update({ where: { id: row.id }, data: patch });
      }
      return row.id;
    });

    const { data: created } = await this.findOne(id);
    return { data: created, meta: { upozorenja } };
  }

  /**
   * Izmena komitenta. PATCH semantika: proverava se SAMO ono što je poslato
   * (`undefined` = nije dirano), jer zatečeni legacy redovi imaju orphan FK-ove i
   * prazna polja koja korisnik nije uneo — retroaktivna strogost bi zaključala
   * izmenu telefona zbog računa koji je stigao iz BigBit-a.
   *
   * PIB odluka se donosi nad SPOJENIM stanjem (staro + novo), da isključivanje
   * `skipTaxIdValidation` na već upisanom lošem PIB-u ne prođe nemo.
   */
  async update(id: number, body: unknown, user?: AuthUser) {
    const data = validateUpdateCustomer(body);
    assertPaymentMethodNotWritten(data);
    normalizeLegacyZeroFks(data);

    const current = await this.prisma.customer.findUnique({
      where: { id },
      select: {
        id: true,
        taxId: true,
        skipTaxIdValidation: true,
        codeTypeCode: true,
        driverId: true,
      },
    });
    if (!current) throw new NotFoundException(`Komitent ${id} ne postoji`);

    const mergedTaxId =
      data.taxId !== undefined ? data.taxId : (current.taxId ?? null);
    const mergedSkip =
      data.skipTaxIdValidation !== undefined
        ? data.skipTaxIdValidation === true
        : current.skipTaxIdValidation === true;
    const mergedCodeType =
      data.codeTypeCode !== undefined ? data.codeTypeCode : current.codeTypeCode;

    assertTaxIdAcceptable({
      taxId: mergedTaxId,
      skipTaxIdValidation: mergedSkip,
      confirmInvalidTaxId: readConfirmFlag(body),
    });

    await this.assertReferences(data);

    const upozorenja = [
      ...softValidationWarnings(data),
      ...(await this.duplicateTaxIdWarnings(mergedTaxId, id)),
    ];

    assertCustomerWriteAllowed(); // ← 409 dok stoji odluka od 26.07.2026

    const patch: Prisma.CustomerUncheckedUpdateInput = {
      ...(data as Prisma.CustomerUncheckedUpdateInput),
      updatedAt: new Date(),
      updatedBy: auditName(user),
    };
    // Brisanje PIB-a na postojećem komitentu → isti `XX_<Sifra>` placeholder koji
    // upisuje sam BigBit transfer (§5.1); kolona je NOT NULL i prazan string bi
    // ostao kao lažan „PIB".
    if (data.taxId !== undefined && !data.taxId) {
      patch.taxId = taxIdPlaceholder(id);
    }
    if (isDriverCodeType(mergedCodeType)) {
      const driver = data.driverId !== undefined ? data.driverId : current.driverId;
      if (!driver) patch.driverId = id;
    }

    await this.prisma.customer.update({ where: { id }, data: patch });

    const { data: updated } = await this.findOne(id);
    return { data: updated, meta: { upozorenja } };
  }

  // --- provere referenci i duplikata (upis) ---

  /**
   * FK provere za POSLATA polja. Vrednost koja ne postoji je 422 sa IMENOVANOM
   * vrednošću — nikad gola 23503 iz baze.
   *
   * `region` i `routeId` se NE proveravaju: u 4.0 ne postoje tabele iza njih
   * (`IDRuta` je „FK bez tabele", `BIGBIT_KOMITENTI.md` §1) — nema šta da se pita.
   */
  private async assertReferences(data: CustomerWriteData): Promise<void> {
    const errors: string[] = [];

    if (data.codeTypeCode) {
      const exists = await this.prisma.codeType.findUnique({
        where: { code: data.codeTypeCode },
        select: { code: true },
      });
      if (!exists) {
        errors.push(
          `Vrsta šifre „${data.codeTypeCode}" ne postoji u šifarniku vrsta šifara.`,
        );
      }
    }

    if (typeof data.salespersonId === "number") {
      const exists = await this.prisma.salesperson.findUnique({
        where: { id: data.salespersonId },
        select: { id: true },
      });
      if (!exists) errors.push(`Prodavac ${data.salespersonId} ne postoji.`);
    }

    if (typeof data.driverId === "number") {
      const exists = await this.prisma.customer.findUnique({
        where: { id: data.driverId },
        select: { id: true },
      });
      if (!exists) {
        errors.push(`Vozač (komitent) ${data.driverId} ne postoji.`);
      }
    }

    // `payment_account_id` NEMA FK u bazi (meki ref) — utoliko pre se proverava ovde,
    // jer baza neće uhvatiti grešku. `0` je legacy „nije zadat" i prolazi.
    if (typeof data.paymentAccountId === "number" && data.paymentAccountId > 0) {
      const exists = await this.prisma.paymentAccount.findUnique({
        where: { id: data.paymentAccountId },
        select: { id: true },
      });
      if (!exists) {
        errors.push(`Uplatni račun ${data.paymentAccountId} ne postoji.`);
      }
    }

    if (errors.length) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        error: "Unprocessable Entity",
        code: "NEPOSTOJECA_REFERENCA",
        message: errors,
      });
    }
  }

  /** Dupli PIB → UPOZORENJE koje imenuje zatečene komitente (§3.3 — nije brana). */
  private async duplicateTaxIdWarnings(
    taxId: string | null,
    excludeId: number | null,
  ): Promise<string[]> {
    const value = (taxId ?? "").trim();
    if (value === "" || isPlaceholderTaxId(value)) return [];

    const others: ExistingTaxIdHolder[] = await this.prisma.customer.findMany({
      where: {
        taxId: value,
        ...(excludeId !== null ? { id: { not: excludeId } } : {}),
      },
      select: { id: true, name: true, city: true },
      orderBy: { id: "asc" },
      take: 10,
    });

    const warning = duplicateTaxIdWarning(value, others);
    return warning ? [warning] : [];
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

/** Pročitaj kontrolni flag „odgovorio sam Yes na BigBit pitanje o PIB-u". */
function readConfirmFlag(body: unknown): boolean {
  return (body as CustomerWriteControls | null)?.confirmInvalidTaxId === true;
}

/**
 * ZAKLJUČANO POLJE `paymentMethod` (`KomitentiNacinPlacanja`).
 *
 * Prava BigBit forma drži ovo polje zaključanim i otključava ga SAMO korisniku u
 * Access grupi `KomAvPlacanje` (`Form_Unos komitenata` :186-196, §4) — način
 * plaćanja (avansno i sl.) sme da menja isključivo ovlašćena grupa.
 *
 * U 4.0 ekvivalentna permisija NE POSTOJI: `common/authz/permissions.ts` nema
 * ključ za nju, a taj fajl je VAN granica ovog modula. Dok se ključ ne uvede i ne
 * dodeli, polje ostaje zaključano za sve — što je tačno stanje u BigBit-u za
 * korisnika van grupe, dakle ne strože nego izvor.
 */
function assertPaymentMethodNotWritten(data: CustomerWriteData): void {
  if (data.paymentMethod === undefined) return;
  throw new ForbiddenException({
    statusCode: 403,
    error: "Forbidden",
    code: "POLJE_ZAKLJUCANO",
    message:
      "Način plaćanja komitenta menja samo ovlašćena grupa (u BigBit-u grupa " +
      "KomAvPlacanje). U ServoSync-u ta dozvola još nije uvedena, pa se polje " +
      "ne može menjati — promenu zatražite od administratora.",
    field: "paymentMethod",
  });
}

/**
 * Legacy sentinel `0` („nije zadat") → `null` za kolone koje IMAJU pravo FK
 * ograničenje (`fk_customers_salespeople`, `fk_customers_driver`).
 *
 * Zatečeni redovi sa nulom postoje samo zato što ih sync upisuje pod
 * `session_replication_role='replica'`, gde FK trigeri ne rade; app put te trigere
 * pokreće, pa bi `0` dao 23503. `paymentAccountId` se NE dira — nema FK i `0` je
 * tamo legitimna „nije zadat" vrednost koju čitanje već razume.
 */
function normalizeLegacyZeroFks(data: CustomerWriteData): void {
  if (data.salespersonId === 0) data.salespersonId = null;
  if (data.driverId === 0) data.driverId = null;
}
