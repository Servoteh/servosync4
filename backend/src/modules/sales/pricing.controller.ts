import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Post,
  UseGuards,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import { PricingService } from "./pricing.service";

/**
 * Pregled cene stavke — `POST /api/v1/sales/price-preview` (PLAN_UNOS_DOKUMENATA §5.7).
 *
 * `PricingService` je postojao i radio, ali NIJE imao rutu: cenovni motor je bio mrtav iz
 * korisničkog interfejsa (ekran je morao sam da računa cenu, pa se razilazio sa knjiženjem).
 * Ovo je ČIST READ — bez ijednog upisa; POST je samo zato što ulaz ima telo (stavka + kupac
 * + magacin), pa je odgovor 200, ne 201.
 *
 * Zaseban kontroler (ne `sales.controller.ts`) da granice paketa ostanu čiste; putanja je
 * ista (`sales`), jer je cena deo prodajnog domena.
 *
 * ⚠️ AUDIT: `AuditInterceptor` je globalan i piše red u `audit_log` za SVAKI POST. Ova ruta
 * je čist read koji ekran zove pri svakoj promeni količine/cene — bez izuzetka u
 * interceptoru (`@SkipAudit()` ili allowlist putanja) `audit_log` dobija desetine hiljada
 * praznih redova godišnje i svaka provera cene plaća jedan upis u bazu. Izuzetak se pravi u
 * `common/audit/audit.interceptor.ts` — tuđi fajl, v. izveštaj paketa.
 *
 * PREKUCANA CENA IMA DVA KANALA (§8/O2) i to je jedina zaštita od dvostrukog umanjenja:
 *   `overrideUnitPrice` — cena PRE rabata (rabat kupca OSTAJE, odluka vlasnika),
 *   `netUnitPrice`      — dogovorena KRAJNJA cena („pade na 85") — rabat se izvodi unazad.
 * Oba zajedno, ili neto uz rabat → 400 sa porukom na srpskom.
 */

/** Telo zahteva. Obrazac: interface + ručna `validate*()` (kao ostatak `sales/dto`). */
export interface PricePreviewDto {
  /** artikal iz šifarnika; bez njega je stavka slobodna (usluga) i cena mora doći iz unosa. */
  itemId?: number | null;
  customerId?: number | null;
  quantity: number | string;
  /** magacin — bez njega nema nabavne ni RUC-a u odgovoru. */
  warehouseId?: number | null;
  /** šifra cenovnika (prioritet nad `documentType`). */
  priceListCode?: string | null;
  /** vrsta dokumenta (npr. IFR) — fallback ključ cenovnika. */
  documentType?: string | null;
  /** kanal „CENA": prekucana cena PRE rabata. */
  overrideUnitPrice?: number | string | null;
  /** kanal „NETO": prekucana cena POSLE rabata i kase. */
  netUnitPrice?: number | string | null;
  /** eksplicitan rabat % (bez njega važi rabatna politika kupca). */
  discountPercent?: number | string | null;
  cashDiscountPercent?: number | string | null;
  vatRateCode?: string | null;
}

const MONEY_DP = 4;
const PCT_DP = 4;
const QTY_DP = 6;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * NOVAC I KOLIČINA ULAZE KAO TEKST ILI BROJ, NIKAD KROZ FLOAT.
 *
 * Ranije je ovde stajalo `typeof v === "number"`, pa je ruta odbijala
 * `"1234.5678"` — a susedna ruta istog modula (`POST /sales/documents/:id/items`)
 * tekst prima. Ista forma na ekranu nije mogla istim telom da pita za cenu i da
 * upiše stavku. Broj koji prođe kroz `Number` uz to gubi cifre pre nego što
 * stigne do `Decimal` (`12345678901234.5678` → `12345678901234.568`), što je
 * direktno protiv BACKEND_RULES §3/§6.
 */
function parseDecimal(
  v: unknown,
  label: string,
  errors: string[],
): Prisma.Decimal | null {
  if (typeof v !== "string" && typeof v !== "number") {
    errors.push(`${label} mora biti broj.`);
    return null;
  }
  if (typeof v === "number" && !Number.isFinite(v)) {
    errors.push(`${label} mora biti broj.`);
    return null;
  }
  try {
    const dec = new Prisma.Decimal(v);
    if (!dec.isFinite()) {
      errors.push(`${label} mora biti broj.`);
      return null;
    }
    return dec;
  } catch {
    errors.push(`${label} mora biti broj.`);
    return null;
  }
}

function optionalId(
  v: unknown,
  label: string,
  errors: string[],
): number | null {
  if (v === undefined || v === null) return null;
  if (!isFiniteNumber(v) || !Number.isInteger(v) || v < 0) {
    errors.push(`${label} mora biti ceo broj.`);
    return null;
  }
  return v;
}

function optionalPercent(
  v: unknown,
  label: string,
  errors: string[],
): Prisma.Decimal | null {
  if (v === undefined || v === null) return null;
  const dec = parseDecimal(v, label, errors);
  if (dec === null) return null;
  if (dec.isNegative() || dec.greaterThan(100)) {
    errors.push(`${label} mora biti između 0 i 100.`);
    return null;
  }
  return dec;
}

function optionalMoney(
  v: unknown,
  label: string,
  errors: string[],
): Prisma.Decimal | null {
  if (v === undefined || v === null) return null;
  const dec = parseDecimal(v, label, errors);
  if (dec === null) return null;
  if (dec.isNegative()) {
    errors.push(`${label} ne sme biti negativna.`);
    return null;
  }
  return dec;
}

/** Normalizuje i TVRDO validira ulaz (§4.2: rabat i kasa < 100, količina > 0). */
export function validatePricePreview(dto: PricePreviewDto) {
  const errors: string[] = [];

  // Količina kao Decimal — kolona je Decimal(19,6) i preciznost se ne sme izgubiti
  // na ulazu (npr. 1234567890123.456789 kroz Number postaje …3.4568).
  const quantity = parseDecimal(dto?.quantity, "Količina", errors);
  if (quantity !== null && !quantity.greaterThan(0)) {
    errors.push("Količina mora biti veća od 0.");
  }

  const itemId = optionalId(dto?.itemId, "Artikal", errors);
  const customerId = optionalId(dto?.customerId, "Kupac", errors);
  const warehouseId = optionalId(dto?.warehouseId, "Magacin", errors);
  const overrideUnitPrice = optionalMoney(
    dto?.overrideUnitPrice,
    "Cena",
    errors,
  );
  const netUnitPrice = optionalMoney(dto?.netUnitPrice, "Neto cena", errors);
  const discountPercent = optionalPercent(dto?.discountPercent, "Rabat", errors);
  const cashDiscountPercent = optionalPercent(
    dto?.cashDiscountPercent,
    "Kasa-skonto",
    errors,
  );

  // Ista dva pravila kao u servisu — ovde da poruka stigne pre ijednog upita u bazu.
  if (overrideUnitPrice !== null && netUnitPrice !== null) {
    errors.push(
      "Pošaljite ili cenu (pre rabata) ili neto cenu (posle rabata), ne obe.",
    );
  }
  if (netUnitPrice !== null && discountPercent !== null) {
    errors.push("Neto cena sama određuje rabat — ne šaljite i rabat uz nju.");
  }

  // Bez artikla cena ne može nastati sama (nema cenovnika ni VP sa kartona).
  if (itemId === null && overrideUnitPrice === null && netUnitPrice === null) {
    errors.push("Za stavku bez artikla cena mora biti uneta ručno.");
  }

  const str = (v: unknown, max: number, label: string): string | null => {
    if (v === undefined || v === null || v === "") return null;
    if (typeof v !== "string") {
      errors.push(`${label} mora biti tekst.`);
      return null;
    }
    const t = v.trim();
    if (t.length > max) {
      errors.push(`${label} sme imati najviše ${max} karaktera.`);
      return null;
    }
    return t;
  };
  const priceListCode = str(dto?.priceListCode, 20, "Šifra cenovnika");
  const documentType = str(dto?.documentType, 5, "Vrsta dokumenta");
  const vatRateCode = str(dto?.vatRateCode, 5, "Poreska šifra");

  if (errors.length) throw new BadRequestException(errors);

  return {
    itemId,
    customerId,
    warehouseId,
    quantity: quantity as Prisma.Decimal,
    priceListCode,
    documentType: documentType ?? undefined,
    overrideUnitPrice,
    netUnitPrice,
    requestedDiscountPercent: discountPercent,
    cashDiscountPercent,
    vatRateCode: vatRateCode ?? undefined,
  };
}

const dec = (v: Prisma.Decimal, dp: number) => v.toFixed(dp);

@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.SALES_READ)
@Controller({ path: "sales", version: "1" })
export class PricingController {
  constructor(private readonly pricing: PricingService) {}

  /**
   * Cena stavke pre unosa: cena, rabat, kasa, PDV, kap rabata, poreklo cene,
   * nabavna neto i RUC (poslednja dva samo uz `warehouseId`).
   *
   * Novac izlazi kao STRING (`Decimal.toFixed`) — nijedan iznos ne prolazi kroz Float.
   */
  @Post("price-preview")
  @HttpCode(200)
  async pricePreview(@Body() dto: PricePreviewDto) {
    const args = validatePricePreview(dto ?? ({} as PricePreviewDto));
    const p = await this.pricing.priceItem(args);

    return {
      data: {
        quantity: dec(p.quantity, QTY_DP),
        /** fakturna cena — ono što ide u kolonu „CENA" na ekranu (pre rabata). */
        basePrice: dec(p.basePrice, MONEY_DP),
        /** neto cena — ono što ide u kolonu „NETO" (posle rabata i kase). */
        unitPrice: dec(p.unitPrice, MONEY_DP),
        discountPercent: dec(p.discountPercent, PCT_DP),
        cashDiscountPercent: dec(p.cashDiscountPercent, PCT_DP),
        maxDiscountPercent: dec(p.maxDiscountPercent, PCT_DP),
        discountCapped: p.discountCapped,
        vatRateCode: p.vatRateCode,
        vatRatePercent: dec(p.vatRatePercent, 2),
        vatBase: dec(p.vatBase, MONEY_DP),
        vatAmount: dec(p.vatAmount, MONEY_DP),
        lineTotal: dec(p.lineTotal, MONEY_DP),
        priceSource: p.priceSource,
        priceOverridden: p.priceOverridden,
        purchasePriceNet:
          p.purchasePriceNet === null ? null : dec(p.purchasePriceNet, MONEY_DP),
        markupPercent:
          p.markupPercent === null ? null : dec(p.markupPercent, PCT_DP),
        warnings: p.warnings,
      },
      // Ugovor sa ekranom (§8/O2): `basePrice` se vraća u kanal `overrideUnitPrice`, a
      // `unitPrice` u kanal `netUnitPrice`. Ponovljen poziv sa tim vrednostima daje ISTI
      // rezultat — rabat se ne primenjuje drugi put (v. pricing.service.spec.ts).
      meta: {
        itemId: args.itemId,
        customerId: args.customerId,
        warehouseId: args.warehouseId,
        priceListCode: args.priceListCode,
        calculatedAt: new Date().toISOString(),
      },
    };
  }
}
