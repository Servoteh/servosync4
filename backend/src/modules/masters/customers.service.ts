import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { pageMeta, parsePagination } from "../../common/pagination";
import { byId, uniqueIds } from "../../common/relations";
import {
  BigBitOwnedDataException,
  rejectCustomerWrite,
} from "../directory/bigbit-owned";
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
  describeCustomer,
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
 * ovaj prekidač stoji na `false`. Tri uslova su morala biti ispunjena PRE otvaranja;
 * od 28.07.2026 su DVA TEHNIČKA REŠENA (2 i 3), pa ostaje SAMO ODLUKA VLASNIKA (1) —
 * otvaranje je od tada jedan red, bez novih otkrića:
 *
 *   1. **Vlasnik povlači odluku od 26.07.2026.** Dok stoji, jedini pisac tabele je
 *      sync modul; poruka korisniku dolazi iz `bigbit-owned.ts` (jedan izvor teksta
 *      i za backend i za ekrane).
 *   2. ~~`customers` mora ući u zaštićeni skup u `sync/table-ownership.ts`.~~
 *      **REŠENO 28.07.2026** — ali DRUGIM mehanizmom nego što je ovde pisalo.
 *      Umesto `NATIVE_COLUMN_TABLES` (koji čuva samo kolone kojih izvor NEMA, a
 *      komitent takvih nema — mapirano je 56 od 57), `customers` je upisan u
 *      `NATIVE_ID_RANGE_TABLES`. Zaštita je time na DVA nezavisna mesta:
 *        • `GenericSyncer` — full refresh briše samo `id < NATIVE_ID_BASE`, pa ni
 *          ručni `POST /sync/run` ni `force: true` ne dohvataju native prostor.
 *          Time otpada i stara zamka „čim se bespoke syncer ukloni kao duplikat
 *          generičkog, `deleteMany({})` pobriše sve".
 *        • `CustomerSyncer` — izvorni red se preskače ako mu `Sifra` upada u
 *          rezervisan opseg ILI ako 4.0 red nosi `source='NATIVE'`.
 *      Komitent nastao u 4.0 dakle više NE preživljava slučajno, nego po pravilu
 *      koje pinuju `table-ownership.spec.ts`, `generic.syncer.spec.ts` i
 *      `syncers/customer.syncer.spec.ts`.
 *   3. ~~Sekvenca `customers_id_seq` klampovana iznad BigBit prostora ključeva.~~
 *      **REŠENO migracijom `20260728170000_maticni_native_opseg_i_poreklo`**:
 *      sekvenca je pomerena na 899.999.999 (prvi `nextval` = 900.000.000), red je
 *      dobio marker porekla `source`/`bb_sifra`, a granicu čuva CHECK
 *      `chk_customers_native_id_range` (`source='NATIVE'` ⇔ `id >= 900000000`) koji
 *      važi i u `replica` režimu sync-a. Native unos ispod te granice fizički ne
 *      može da sedne, pa `CustomerSyncer.upsert({where:{id}})` više ne može da
 *      prepiše 4.0-red tuđom firmom. `create()` ispod zato dodeljuje šifru IZ
 *      NATIVE OPSEGA i upisuje `source='NATIVE'` (v. `nextNativeCustomerId`).
 *
 * Tip je namerno `boolean` (ne literal `false`) da provera ostane prava grana toka,
 * a ne mrtav kod za TypeScript.
 */
export const CUSTOMERS_WRITE_OPEN: boolean = false;

/** Baci 409 `BIGBIT_OWNED_READ_ONLY` dok je upis zatvoren. */
export function assertCustomerWriteAllowed(): void {
  if (!CUSTOMERS_WRITE_OPEN) rejectCustomerWrite();
}

// ══════════════════════════════════════════════════════════════════════════════
// POREKLO REDA — ko sme da menja kog komitenta
// ══════════════════════════════════════════════════════════════════════════════
/**
 * BigBit-origin komitent se u 4.0 NE MENJA. Ekvivalent `assertItemIsNative`
 * (`items.write-policy.ts`), ali za komitente odluku donosi MARKER, ne opseg id-a:
 * migracija `20260728170000` je uvela `customers.source` (`BIGBIT` | `NATIVE`,
 * NOT NULL DEFAULT `'BIGBIT'`) i `customers.bb_sifra`.
 *
 * ZAŠTO JE PROVERA OBAVEZNA: `CustomerSyncer` radi `upsert({ where: { id },
 * update: <svih 56 kolona> })` — svaka izmena BigBit-reda urađena ovde preživi
 * tačno do sledećeg uvoza, pa nestane bez greške i bez traga. To je najgori oblik
 * kvara: ispravljen žiro račun „radi" nedeljama, a plaćanje ode na stari račun.
 */

/** Dozvoljene vrednosti `customers.source` (CHECK `chk_customers_source`). */
export const CUSTOMER_SOURCE_BIGBIT = "BIGBIT";
export const CUSTOMER_SOURCE_NATIVE = "NATIVE";

/**
 * Prva šifra rezervisana za komitenta nastalog u 4.0. ISTA vrednost kao
 * `NATIVE_ITEM_ID_BASE` za artikle — jedan broj, jedno pravilo (spec pinuje
 * jednakost). Granicu ne čuva konvencija nego CHECK `chk_customers_native_id_range`.
 */
export const NATIVE_CUSTOMER_ID_BASE = 900_000_000;

/** `customers.id` je PG `integer` — gornja granica opsega. */
export const NATIVE_CUSTOMER_ID_MAX = 2_147_483_647;

/** Podskup kolona po kojima se određuje poreklo reda. */
export interface CustomerOrigin {
  id: number;
  name?: string | null;
  source?: string | null;
  bbSifra?: number | null;
}

/**
 * Da li je red nastao u 4.0.
 *
 * Merodavan je MARKER (`source`); opseg id-a je REZERVNI kriterijum i koristi se
 * samo kad marker nije pročitan (stari `select` bez kolone, fixture u testu). Ta
 * rezerva je namerno konzervativna — „ne znam" znači BigBit, nikad native: kolona je
 * u bazi NOT NULL sa `DEFAULT 'BIGBIT'`, pa bi suprotan izbor tiho otvorio izmenu
 * svega što neko zaboravi da selektuje.
 */
export function isNativeCustomer(customer: CustomerOrigin): boolean {
  const marker = customer.source?.trim().toUpperCase();
  if (marker === CUSTOMER_SOURCE_NATIVE) return true;
  if (marker === CUSTOMER_SOURCE_BIGBIT) return false;
  return customer.id >= NATIVE_CUSTOMER_ID_BASE;
}

/**
 * Šifra pod kojom korisnik traži komitenta u BigBit-u.
 *
 * ⚠️ `??`, nikad `||`: `customers.id = 0` je **Servoteh d.o.o.** (sentinel na koji
 * pokazuju svi legacy `*_id = 0`), pa mu je `bbSifra = 0` — falsy vrednost koja je
 * ispravna šifra.
 */
export function bigBitSifraOf(customer: CustomerOrigin): number {
  return customer.bbSifra ?? customer.id;
}

/** Poruka koja IMENUJE komitenta i kaže gde se ispravlja (u BigBit-u, ne ovde). */
export function customerBigBitOriginMessage(customer: CustomerOrigin): string {
  const sifra = bigBitSifraOf(customer);
  const name = customer.name?.trim();
  const who = name ? `Komitent „${name}" (šifra ${sifra})` : `Komitent ${sifra}`;
  return (
    `${who} vodi se u BigBit-u i ovde se ne menja. Izmena bi ostala samo do ` +
    "sledećeg uvoza: BigBit ponovo upisuje sva polja tog komitenta, pa bi tiho " +
    "nestala (ispravljen žiro račun bi se vratio na stari, a plaćanje otišlo na " +
    `pogrešan račun). Ispravite komitenta u BigBit-u — „Unos komitenata", šifra ` +
    `${sifra} — pa javite administratoru da pokrene uvoz (Sinhronizacije → ` +
    "Pokreni sync); izmena se tada vidi i ovde."
  );
}

/**
 * Izmena je dozvoljena SAMO nad 4.0-native redom (isti obrazac kao
 * `assertItemIsNative`). 409, ne 403 — nije stvar prava korisnika nego vlasništva
 * nad podatkom; `code` je isti stabilan `BIGBIT_OWNED_READ_ONLY` koji frontend već
 * razume, samo je tekst konkretniji (imenuje komitenta).
 */
export function assertCustomerIsNative(customer: CustomerOrigin): void {
  if (!isNativeCustomer(customer))
    throw new BigBitOwnedDataException(customerBigBitOriginMessage(customer));
}

/**
 * Isti PIB već postoji na BigBit-redu → 409 koji UPUĆUJE NA POSTOJEĆEG komitenta.
 *
 * Ovo je jedino odstupanje od BigBit-ove tolerancije duplog PIB-a (§3.3, gde je
 * duplikat samo upozorenje) i namerno je uže: BigBit duplikat unutar SVOG šifarnika
 * bar vidi i ima izveštaj `00_FirmeSaDuplimPIBovima`, dok komitent otvoren ovde
 * BigBit NIKAD ne vidi — promet i plaćanja bi se trajno razdvojili na dve šifre u
 * dva sistema koja niko ne spaja. Duplikat prema drugom 4.0-native komitentu ostaje
 * UPOZORENJE (oba reda su ovde, mogu se spojiti).
 */
export function bigBitTwinException(
  taxId: string,
  twins: ExistingTaxIdHolder[],
): ConflictException {
  const shown = twins.slice(0, 3).map(describeCustomer).join("; ");
  return new ConflictException({
    statusCode: 409,
    error: "Conflict",
    code: "KOMITENT_VEC_POSTOJI",
    message:
      `PIB ${taxId} već vodi komitent iz BigBit-a: ${shown}. Otvorite postojećeg ` +
      "komitenta umesto unosa novog — dupla šifra bi razdvojila promet i plaćanja " +
      "na dva mesta, a BigBit ih ne bi spojio. Ako je ovo stvarno drugo pravno lice " +
      "sa istim PIB-om, unesite ga u BigBit-u pa javite administratoru da pokrene " +
      "uvoz (Sinhronizacije → Pokreni sync).",
    taxId,
  });
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
  /**
   * Grupe komitenata sa ISTIM PIB-om (O-7). Placeholder `XX_<Sifra>` (prazan PIB
   * iz starog transfera) i prazno se NE broje — to nisu duplikati nego odsustvo
   * podatka; ino kupci legitimno nemaju PIB. Sortirano po veličini grupe pa PIB-u,
   * da najveći problemi stoje na vrhu i da redosled bude stabilan iz dana u dan.
   */
  async duplicateTaxIds() {
    const rows = await this.prisma.$queryRaw<
      {
        tax_id: string;
        id: number;
        name: string;
        city: string | null;
        source: string;
      }[]
    >`
      WITH d AS (
        SELECT tax_id FROM customers
        WHERE tax_id IS NOT NULL AND btrim(tax_id) <> '' AND tax_id !~ '^XX_'
        GROUP BY tax_id HAVING count(*) > 1
      )
      SELECT c.tax_id, c.id, c.name, c.city, c.source
      FROM customers c JOIN d ON d.tax_id = c.tax_id
      ORDER BY (SELECT count(*) FROM customers x WHERE x.tax_id = c.tax_id) DESC,
               c.tax_id, c.id`;

    const groups = new Map<
      string,
      { taxId: string; customers: { id: number; name: string; city: string | null; source: string }[] }
    >();
    for (const r of rows) {
      if (!groups.has(r.tax_id)) groups.set(r.tax_id, { taxId: r.tax_id, customers: [] });
      groups.get(r.tax_id)!.customers.push({
        id: r.id,
        name: r.name,
        city: r.city,
        source: r.source,
      });
    }

    return {
      data: [...groups.values()],
      meta: {
        groups: groups.size,
        customers: rows.length,
        /** Ugovor sa vlasnikom: broj treba da PADA; na nuli sme tvrda brana. */
        note:
          groups.size === 0
            ? "Nema duplih PIB-ova — sme se razmotriti tvrda brana."
            : "Duplikati se rešavaju u BigBitu (vlasnik podatka do prelaza); ovaj broj treba da pada.",
      },
    };
  }

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
   *   5. PIB već postoji na BigBit-redu → 409 `KOMITENT_VEC_POSTOJI` (imenuje ga)
   *   6. meka upozorenja (GLN/računi/dupli native PIB) — ne obaraju zahtev
   *   7. **BRANA UPISA**            → 409 `BIGBIT_OWNED_READ_ONLY` (danas uvek)
   *   8. upis u transakciji, šifra iz NATIVE opsega + `source='NATIVE'`
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
    await this.assertNoBigBitTwin(data.taxId ?? null, null);

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
      // Šifra IZ REZERVISANOG OPSEGA + `source='NATIVE'` — jedini oblik reda koji
      // CHECK `chk_customers_native_id_range` propušta i koji `CustomerSyncer`
      // (upsert po `id` iz BigBit prostora) ne može da pogodi. `bb_sifra` se NE
      // upisuje: trigger `trg_customers_bb_sifra` ga za native red drži na NULL.
      const nextId = await nextNativeCustomerId(tx);

      const row = await tx.customer.create({
        data: {
          ...(data as Prisma.CustomerUncheckedCreateInput),
          id: nextId,
          source: CUSTOMER_SOURCE_NATIVE,
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
   *
   * BigBit-origin red se odbija sa 409 (`assertCustomerIsNative`) — bez toga bi
   * izmena „radila" do sledećeg uvoza pa nestala. Provera stoji POSLE provera
   * korisnikovog podatka (400/422) a PRE svega što se tiče upisa: ovaj modul
   * namerno prvo objašnjava podatak („PIB nije dobar") pa tek onda stanje sistema
   * — isti redosled pinuje `customers.service.spec.ts`, van ove granice.
   */
  async update(id: number, body: unknown, user?: AuthUser) {
    const data = validateUpdateCustomer(body);
    assertPaymentMethodNotWritten(data);
    normalizeLegacyZeroFks(data);

    const current = await this.prisma.customer.findUnique({
      where: { id },
      select: {
        id: true,
        // `name`/`source`/`bbSifra` NISU za upis nego za PORUKU i odluku o poreklu:
        // bez njih bi provera pala na opseg id-a, a poruka ne bi imenovala komitenta.
        name: true,
        source: true,
        bbSifra: true,
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

    // Poreklo PRE svega ostalog što se tiče upisa: za BigBit-ov red nema smisla
    // raspravljati o duplikatu PIB-a — taj red se ovde uopšte ne menja.
    assertCustomerIsNative(current); // ← 409 za red koji je došao iz BigBit-a

    // Samo kad se PIB STVARNO menja: zatečeni duplikat ne sme da zaključa izmenu
    // telefona (isti razlog zbog kojeg je cela PATCH semantika „proveri poslato").
    if (data.taxId !== undefined) {
      await this.assertNoBigBitTwin(mergedTaxId, id);
    }

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

  /**
   * PIB koji već postoji na BigBit-redu → 409 sa imenom postojećeg komitenta.
   *
   * Namerno ODVOJEN upit od `duplicateTaxIdWarnings`: to su dva različita pitanja
   * („ko još ima ovaj PIB" vs. „da li ga BigBit već vodi"), a oblik upita upozorenja
   * pinuje spec izvan ove granice, pa mu se `select` ne proširuje.
   *
   * Poreklo se filtrira i u bazi i u kodu (`isNativeCustomer`): filter u `where`
   * je za performanse, odluku donosi ista funkcija koja je donosi i za izmenu —
   * jedno pravilo, jedno mesto.
   */
  private async assertNoBigBitTwin(
    taxId: string | null,
    excludeId: number | null,
  ): Promise<void> {
    const value = (taxId ?? "").trim();
    // Placeholder `XX_<šifra>` je po definiciji jedinstven po šifri, a prazan PIB
    // nije podatak — ni jedno ni drugo nije duplikat.
    if (value === "" || isPlaceholderTaxId(value)) return;

    const rows = await this.prisma.customer.findMany({
      where: {
        taxId: value,
        source: CUSTOMER_SOURCE_BIGBIT,
        ...(excludeId !== null ? { id: { not: excludeId } } : {}),
      },
      select: { id: true, name: true, city: true, source: true, bbSifra: true },
      orderBy: { id: "asc" },
      take: 10,
    });

    const twins = rows.filter((row) => !isNativeCustomer(row));
    if (!twins.length) return;

    throw bigBitTwinException(
      value,
      // Poruka pokazuje BigBit šifru (`bb_sifra`), jer nju korisnik kuca u BigBit-u;
      // za BigBit redove je jednaka `id`, ali `bb_sifra` je izvor te istine.
      twins.map((twin) => ({
        id: bigBitSifraOf(twin),
        name: twin.name,
        city: twin.city,
      })),
    );
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

/**
 * Sledeća šifra iz NATIVE opsega — `MAX(id) + 1` UNUTAR opsega, pod
 * `pg_advisory_xact_lock` (bez brave dve paralelne transakcije dobiju isti broj;
 * isti obrazac kao `nextNativeItemId` za artikle).
 *
 * ZAŠTO NE `nextval`: migracija `20260728170000` jeste pomerila `customers_id_seq`
 * na 899.999.999, ali sekvenca nije otporna na restore/`setval` iz nekog drugog
 * posla, a `alignIdSequence` (koji je ovde ranije stajao) bi je VRATIO na
 * `MAX(id)` ≈ 1.006.067 — pravo u BigBit prostor. Računica iz opsega ne zavisi ni
 * od jednog takvog stanja, a CHECK u bazi ostaje poslednja odbrana.
 *
 * `::int` kastovi su obavezni: bez njih Prisma vezuje JS broj kao `bigint`, pa
 * izraz pređe u `bigint` i vrati `BigInt` (isto kao kod artikala).
 */
async function nextNativeCustomerId(
  tx: Prisma.TransactionClient,
): Promise<number> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('customers_native_id'))`;
  const rows = await tx.$queryRaw<{ next_id: number | bigint }[]>`
    SELECT COALESCE(MAX(id), ${NATIVE_CUSTOMER_ID_BASE - 1}::int) + 1 AS next_id
    FROM customers
    WHERE id >= ${NATIVE_CUSTOMER_ID_BASE}::int`;

  const next = Number(rows[0]?.next_id ?? NATIVE_CUSTOMER_ID_BASE);
  if (!Number.isInteger(next) || next < NATIVE_CUSTOMER_ID_BASE)
    throw new Error(`Neispravna šifra iz native opsega: ${String(next)}`);
  if (next > NATIVE_CUSTOMER_ID_MAX)
    throw new UnprocessableEntityException({
      statusCode: 422,
      error: "Unprocessable Entity",
      code: "OPSEG_SIFARA_POPUNJEN",
      message:
        "Opseg šifara za komitente unete u ServoSync-u je popunjen — javite administratoru.",
    });
  return next;
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
