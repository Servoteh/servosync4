import { BadRequestException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

/**
 * DTO za unos/izmenu komitenta (`POST /api/v1/komitenti`, `PATCH /api/v1/komitenti/:id`).
 *
 * Obrazac je isti kao u susednim modulima (`izvodi/dto/exchange-rate.dto.ts`,
 * `pdv/dto/tax-rates.dto.ts`): interface + ručne `validate*()` funkcije, poruke na
 * srpskom, kod na engleskom. VAŽNO: globalni `ValidationPipe({ whitelist: true })`
 * PRESKAČE handlere čiji je tip parametra interface (v. `main.ts:64-67`), pa telo
 * stiže SIROVO — whitelisting radi `normalizeCustomerInput` ispod (prepisuje samo
 * poznata polja; `id`, `createdAt`, `updatedAt`… se ignorišu, ne mogu se podmetnuti).
 *
 * POKRIVENOST POLJA (izvor: `docs/migration/BIGBIT_KOMITENTI.md` §1 — 57 kolona
 * originalne tabele `Komitenti`, forma „Unos komitenata"):
 *   • 50 poslovnih kolona forme → pišu se ovim DTO-om (spiskovi ispod).
 *   • 5 kolona vodi server, ne klijent: `id` (`Sifra`, IDENTITY), `createdAt`
 *     (`PrviUnos`), `updatedAt` (`PoslednjaIzmena` — ujedno sync watermark!),
 *     `createdBy` (`PrviUnosUser`), `updatedBy` (`PoslednjaIzmenaUser`).
 *   • `recordCreatedAt` (`DatumIVremeKom`) — kolona sa `DEFAULT now()`; namena
 *     razlike prema `PrviUnos` je NEPOZNATA (`BIGBIT_KOMITENTI.md` §8 pitanje 6),
 *     pa se NE izlaže dok se ne razjasni — baza je popunjava.
 *   • `KoristiPNBZadModel` — kolona POSTOJI u BigBit-u, a u 4.0 šemi JE NEMA
 *     (jedina rupa 56/57, `BIGBIT_KOMITENTI.md` §1 + §7 red 3). Traži migraciju,
 *     ne DTO.
 */

// ─── skupovi kolona po tipu (jedan izvor istine za normalizaciju i validaciju) ───

/**
 * Tekstualne kolone → maksimalne dužine. Vrednosti su `VarChar(n)` iz baseline
 * migracije (`20260104120000_baseline/migration.sql`, tabela `customers`); prekoračenje
 * bi u PG-u dalo 22001 („value too long"), pa se hvata ovde kao čitljiva srpska greška.
 * `note`/`balanceNote` su u PG-u `TEXT` (bez granice) — granica 255 je BigBit-ova
 * (`Memo(255)`), da 4.0 ne primi vrednost koju BigBit ne može da vrati.
 */
export const CUSTOMER_TEXT_LIMITS = {
  name: 50, // Naziv (NOT NULL)
  branch: 50, // Poslovnica
  city: 30, // Mesto
  address: 50, // Adresa
  postalCode: 20, // Postanski broj
  bankAccount1: 30, // Ziro racun_1
  bankAccount2: 30, // Ziro racun_2
  bankAccount3: 30, // Ziro racun_3
  phone: 20, // Telefon
  fax: 20, // Fax
  contact: 50, // Kontakt (JEDAN string — prava 1:N tabela nije u šemi, v. §2.1)
  note: 255, // Napomena (Memo 255)
  country: 30, // Drzava
  codeTypeCode: 10, // Vrsta sifre → FK code_types
  email: 50, // Email
  mobile: 20, // Mobilni
  webAddress: 50, // Web adresa
  buyerProtectionCode: 50, // ZastKodKupca
  taxId: 20, // PIB (NOT NULL u 4.0 — v. §3.1/§5.1)
  externalCode: 10, // MSifra
  priceListCode: 5, // Cenovnik
  paymentMethod: 50, // KomitentiNacinPlacanja (⚠ zaključano polje — v. §4)
  signature: 50, // PotpisKom
  shortName: 30, // SkraceniNaziv
  pantheonId: 30, // IDPantheon
  gln: 30, // GLN
  balanceNote: 255, // NapomenaZaSalda (Memo 255)
  publicSectorId: 10, // JBKJS
  registrationNumber: 20, // MaticniBroj
} as const;
export type CustomerTextField = keyof typeof CUSTOMER_TEXT_LIMITS;

/** Celobrojne kolone. `paymentTermDays` je `SmallInt`, ostale `Integer`. */
export const CUSTOMER_INT_FIELDS = [
  "region", // Region
  "salespersonId", // Sifra prodavca → FK salespeople
  "vatStatus", // PDVStatus
  "paymentTermDays", // Odlozeno (SmallInt)
  "routeId", // IDRuta (FK bez tabele u 4.0)
  "driverId", // IDVozac → self-FK customers
  "paymentAccountId", // IDUplatniRacun (meki ref na payment_accounts)
] as const;
export type CustomerIntField = (typeof CUSTOMER_INT_FIELDS)[number];

/**
 * Procentualne kolone — u BigBit-u `Double`, u 4.0 šemi `Float`. NISU novac
 * (BACKEND_RULES §6 traži `Decimal` za novac), pa ostaju brojevi kakvi jesu;
 * `customers.service.ts` ih i na čitanju vraća kao brojeve.
 */
export const CUSTOMER_FLOAT_FIELDS = [
  "customerDiscount", // RabatKomitenta
  "commissionPercent", // ProcenatProvizije
  "fictitiousDiscount", // FiktRabatKomitenta
] as const;
export type CustomerFloatField = (typeof CUSTOMER_FLOAT_FIELDS)[number];

/**
 * NOVAC → `Prisma.Decimal`, nikad float (BACKEND_RULES §6). Obe kolone su
 * `Decimal(19,4)`: `KreditLimit` (Currency) i `KLRucProc` (Currency).
 */
export const CUSTOMER_DECIMAL_FIELDS = [
  "creditLimit", // KreditLimit
  "manualMarkupPercent", // KLRucProc
] as const;
export type CustomerDecimalField = (typeof CUSTOMER_DECIMAL_FIELDS)[number];

export const CUSTOMER_BOOL_FIELDS = [
  "invoicePerDeliveryAddress", // FakturisanjePoMestimaIsporuke (⚠ sama mesta nisu u šemi)
  "checkDebt", // ProveraDuga
  "skipTaxIdValidation", // NeProveravajPIB — eksplicitan bypass PIB validacije
  "newsletter", // NewsLetter
  "mailToDifferentAddress", // PostaNaDruguAdresu
  "hideInOverview", // NePrikazatiUPregledu
  "einvoiceXmlPerItemDiscount", // ER_XMLSaPopustomPoArtiklu
  "centralInvoiceRegistry", // CRF
] as const;
export type CustomerBoolField = (typeof CUSTOMER_BOOL_FIELDS)[number];

export const CUSTOMER_DATE_FIELDS = ["birthDate"] as const; // Datum rodjenja
export type CustomerDateField = (typeof CUSTOMER_DATE_FIELDS)[number];

// ─── telo zahteva ───────────────────────────────────────────────────────────────

/** Sva polja forme „Unos komitenata" koja klijent sme da pošalje (sva opciona). */
export interface CustomerWritableDto {
  // tekst
  name?: string | null;
  branch?: string | null;
  city?: string | null;
  address?: string | null;
  postalCode?: string | null;
  bankAccount1?: string | null;
  bankAccount2?: string | null;
  bankAccount3?: string | null;
  phone?: string | null;
  fax?: string | null;
  contact?: string | null;
  note?: string | null;
  country?: string | null;
  codeTypeCode?: string | null;
  email?: string | null;
  mobile?: string | null;
  webAddress?: string | null;
  buyerProtectionCode?: string | null;
  taxId?: string | null;
  externalCode?: string | null;
  priceListCode?: string | null;
  paymentMethod?: string | null;
  signature?: string | null;
  shortName?: string | null;
  pantheonId?: string | null;
  gln?: string | null;
  balanceNote?: string | null;
  publicSectorId?: string | null;
  registrationNumber?: string | null;
  // celobrojno
  region?: number | null;
  salespersonId?: number | null;
  vatStatus?: number | null;
  paymentTermDays?: number | null;
  routeId?: number | null;
  driverId?: number | null;
  paymentAccountId?: number | null;
  // procenti (Float)
  customerDiscount?: number | null;
  commissionPercent?: number | null;
  fictitiousDiscount?: number | null;
  // novac (Decimal) — string je preporučen oblik, broj se prihvata i odmah pretvara
  creditLimit?: string | number | null;
  manualMarkupPercent?: string | number | null;
  // logičke
  invoicePerDeliveryAddress?: boolean | null;
  checkDebt?: boolean | null;
  skipTaxIdValidation?: boolean | null;
  newsletter?: boolean | null;
  mailToDifferentAddress?: boolean | null;
  hideInOverview?: boolean | null;
  einvoiceXmlPerItemDiscount?: boolean | null;
  centralInvoiceRegistry?: boolean | null;
  // datum
  birthDate?: string | null;
}

/**
 * Kontrolni flag koji NIJE kolona: replika BigBit dijaloga „PIB nije dobar!!! Da li
 * nastavljate unos?" (`Form_BeforeUpdate`, default odgovor **No** →
 * `BIGBIT_KOMITENTI.md` §3.1). Prvi zahtev sa lošim PIB-om se odbija sa
 * `code: "PIB_NIJE_DOBAR"`; klijent ga ponovi sa `confirmInvalidTaxId: true` i time
 * odigra „Yes" preko podrazumevanog „No". Brana je zato POLU-TVRDA, kao u BigBit-u —
 * ne strožija.
 */
export interface CustomerWriteControls {
  confirmInvalidTaxId?: boolean;
}

/** Unos: `name` je jedino tvrdo obavezno polje (`Komitenti.Naziv` NOT NULL). */
export interface CreateCustomerDto
  extends CustomerWritableDto,
    CustomerWriteControls {
  name: string;
}

/** Izmena: sva polja opciona; prazan objekat je greška (nema šta da se promeni). */
export type UpdateCustomerDto = CustomerWritableDto & CustomerWriteControls;

// ─── normalizacija ──────────────────────────────────────────────────────────────

/**
 * Normalizovano telo — samo prepoznata polja, već u tipovima koje Prisma očekuje.
 * `undefined` = „nije poslato" (PATCH ga ne dira); `null` = „obriši vrednost".
 */
export type CustomerWriteData = Partial<
  Record<CustomerTextField, string | null> &
    Record<CustomerIntField, number | null> &
    Record<CustomerFloatField, number | null> &
    Record<CustomerDecimalField, Prisma.Decimal | null> &
    Record<CustomerBoolField, boolean | null> &
    Record<CustomerDateField, Date | null>
>;

/** Sva pisiva polja u jednom nizu — koristi se i za „PATCH bez ijednog polja". */
export const CUSTOMER_WRITABLE_FIELDS: readonly string[] = [
  ...(Object.keys(CUSTOMER_TEXT_LIMITS) as CustomerTextField[]),
  ...CUSTOMER_INT_FIELDS,
  ...CUSTOMER_FLOAT_FIELDS,
  ...CUSTOMER_DECIMAL_FIELDS,
  ...CUSTOMER_BOOL_FIELDS,
  ...CUSTOMER_DATE_FIELDS,
];

const INT32_MAX = 2147483647;
const INT16_MAX = 32767;
/** `Decimal(19,4)` → najviše 15 cifara ispred zareza. */
const DECIMAL_ABS_MAX = new Prisma.Decimal("1e15");

/**
 * Pretvori sirovo telo u `CustomerWriteData` + spisak grešaka.
 *
 * Pravila (ista za POST i PATCH):
 *   • nepoznati ključevi se TIHO odbacuju (whitelisting — pipe ovde ne radi);
 *   • string se trimuje; prazan string → `null` („obriši"), osim `name` gde je to
 *     greška, i `taxId` gde prazno ima poseban tok (v. `customers.validation.ts`);
 *   • broj mora biti konačan; `Decimal` se pravi iz STRING oblika (nikad iz float
 *     aritmetike);
 *   • datum mora biti parsabilan ISO string.
 */
export function normalizeCustomerInput(body: unknown): {
  data: CustomerWriteData;
  errors: string[];
} {
  const errors: string[] = [];
  const acc: Record<string, unknown> = {};
  const src = (body ?? {}) as Record<string, unknown>;

  for (const [field, limit] of Object.entries(CUSTOMER_TEXT_LIMITS)) {
    if (!(field in src)) continue;
    const raw = src[field];
    if (raw === null) {
      acc[field] = null;
      continue;
    }
    if (typeof raw !== "string") {
      errors.push(`Polje „${field}" mora biti tekst.`);
      continue;
    }
    const value = raw.trim();
    if (value.length > limit) {
      errors.push(
        `Polje „${field}" sme imati najviše ${limit} znakova (uneto: ${value.length}).`,
      );
      continue;
    }
    acc[field] = value === "" ? null : value;
  }

  for (const field of CUSTOMER_INT_FIELDS) {
    if (!(field in src)) continue;
    const raw = src[field];
    if (raw === null) {
      acc[field] = null;
      continue;
    }
    if (typeof raw !== "number" || !Number.isInteger(raw)) {
      errors.push(`Polje „${field}" mora biti ceo broj.`);
      continue;
    }
    const max = field === "paymentTermDays" ? INT16_MAX : INT32_MAX;
    if (raw < -max - 1 || raw > max) {
      errors.push(`Polje „${field}" je van dozvoljenog opsega (±${max}).`);
      continue;
    }
    acc[field] = raw;
  }

  for (const field of CUSTOMER_FLOAT_FIELDS) {
    if (!(field in src)) continue;
    const raw = src[field];
    if (raw === null) {
      acc[field] = null;
      continue;
    }
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      errors.push(`Polje „${field}" mora biti broj.`);
      continue;
    }
    acc[field] = raw;
  }

  for (const field of CUSTOMER_DECIMAL_FIELDS) {
    if (!(field in src)) continue;
    const raw = src[field];
    if (raw === null) {
      acc[field] = null;
      continue;
    }
    if (typeof raw !== "string" && typeof raw !== "number") {
      errors.push(`Polje „${field}" mora biti iznos (broj ili tekst).`);
      continue;
    }
    if (typeof raw === "number" && !Number.isFinite(raw)) {
      errors.push(`Polje „${field}" mora biti konačan iznos.`);
      continue;
    }
    const text = typeof raw === "number" ? raw.toString() : raw.trim();
    if (text === "") {
      acc[field] = null;
      continue;
    }
    let dec: Prisma.Decimal;
    try {
      dec = new Prisma.Decimal(text);
    } catch {
      errors.push(`Polje „${field}" nije ispravan iznos: „${text}".`);
      continue;
    }
    if (!dec.isFinite() || dec.abs().greaterThanOrEqualTo(DECIMAL_ABS_MAX)) {
      errors.push(`Polje „${field}" je van dozvoljenog opsega iznosa.`);
      continue;
    }
    // Decimal(19,4) — višak decimala se odseca kao u bazi, ali svesno i vidljivo.
    acc[field] = dec.toDecimalPlaces(4);
  }

  for (const field of CUSTOMER_BOOL_FIELDS) {
    if (!(field in src)) continue;
    const raw = src[field];
    if (raw === null) {
      acc[field] = null;
      continue;
    }
    if (typeof raw !== "boolean") {
      errors.push(`Polje „${field}" mora biti true/false.`);
      continue;
    }
    acc[field] = raw;
  }

  for (const field of CUSTOMER_DATE_FIELDS) {
    if (!(field in src)) continue;
    const raw = src[field];
    if (raw === null) {
      acc[field] = null;
      continue;
    }
    if (typeof raw !== "string" || Number.isNaN(Date.parse(raw))) {
      errors.push(`Polje „${field}" mora biti datum u ISO obliku.`);
      continue;
    }
    acc[field] = new Date(raw);
  }

  return { data: acc as CustomerWriteData, errors };
}

// ─── tvrde provere oblika (422) ─────────────────────────────────────────────────

/**
 * Unos: `name` mora postojati i biti neprazan (`Komitenti.Naziv` NOT NULL).
 * Ostalo je isto kao kod izmene — BigBit na ostalim poljima nema CHECK-ove
 * (`BIGBIT_KOMITENTI.md` §1, zaključak) pa ni mi ne izmišljamo nove.
 */
export function validateCreateCustomer(body: unknown): CustomerWriteData {
  const { data, errors } = normalizeCustomerInput(body);

  if (data.name === undefined || data.name === null) {
    errors.push("Naziv komitenta je obavezan.");
  }

  if (errors.length) throw new BadRequestException(errors);
  return data;
}

/** Izmena: prazno telo je greška; `name` se sme menjati ali ne sme obrisati. */
export function validateUpdateCustomer(body: unknown): CustomerWriteData {
  const { data, errors } = normalizeCustomerInput(body);

  if (Object.keys(data).length === 0) {
    errors.push(
      "Nije poslato nijedno polje za izmenu (dozvoljena polja: " +
        `${CUSTOMER_WRITABLE_FIELDS.join(", ")}).`,
    );
  }
  if (data.name === null) {
    errors.push("Naziv komitenta se ne može obrisati.");
  }

  if (errors.length) throw new BadRequestException(errors);
  return data;
}
