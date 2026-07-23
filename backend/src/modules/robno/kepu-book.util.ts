import { Prisma } from "@prisma/client";

/**
 * KEPU (Knjiga evidencije prometa robe u maloprodaji) — PUNJENJE iz robnog toka (doc 39 §E, task D5be).
 * =============================================================================================
 * Do sada `kepu_book_entries` niko nije punio (kepu.service samo REKAPITULIRA praznu tabelu).
 * Ovaj util je jedini pisač: računa red(ove) iz StockDocument-a i idempotentno ih upisuje.
 *
 * SMEROVI (doc 39 §E):
 *   • zaduženje (`charge` = MagUlaz)      → UL (kalkulacija), VISAK, nivelacija „+"
 *   • razduženje (`discharge` = MagStvarniIzlaz) → IZ/prodaja, MANJAK, nivelacija „−"
 *   • PRENOS → dva reda: izvorni magacin razdužuje, odredišni zadužuje (interni transfer)
 * Smer se prvo čita iz `DocumentType.kepuDefaultCharge/kepuDefaultDischarge` (default po tipu
 * dokumenta); ako oba/nijedan nisu postavljeni → smer po prirodi dokumenta (`kind`).
 *
 * VREDNOST (izbor — dokumentovano):
 *   Knjiga je MALOPRODAJNA → vodi PRODAJNU (MP) vrednost robe, ne veleprodajnu.
 *   Jedinična vrednost = KalkMP (calculatedRetailPrice, iz UL kalkulacije) ako postoji,
 *   pa StvarnaMP (actualRetailPrice, IZ/prodaja), pa fallback na VP (KalkVP → StvarnaVP).
 *   NAPOMENA: ovo NAMERNO odstupa od schema-komentara „MagUlaz=Kol*(KalkVP+Taksa)" — KalkMP
 *   već sadrži Taksu + FiksniPorez + PDV (ΣStopa), tj. punu maloprodajnu (prodajnu) vrednost,
 *   što je ono što KEPU maloprodaja po zakonu evidentira. (task D5be: „MP vrednost … dokumentuj izbor".)
 *
 * IDEMPOTENCIJA: `writeKepuEntries` briše sve prethodne redove po `documentId` pa upisuje sveže,
 * pa ponovni calculate/post/rebuild NE duplira knjigu.
 */

const D = Prisma.Decimal;
const ZERO = new D(0);

/** Minimalno zaglavlje robnog dokumenta potrebno za KEPU red. */
export interface KepuSourceDoc {
  id: number;
  companyId: number;
  kind: string;
  documentTypeCode: string;
  documentNumber: string;
  warehouseId: number;
  targetWarehouseId: number | null;
  documentDate: Date;
}

/** Cenovna polja stavke (StockDocumentItem) korišćena za MP/VP vrednost. */
export interface KepuSourceItem {
  quantity: Prisma.Decimal;
  calculatedRetailPrice: Prisma.Decimal; // KalkMP
  actualRetailPrice: Prisma.Decimal; // StvarnaMP
  calculatedWholesalePrice: Prisma.Decimal; // KalkVP
  actualWholesalePrice: Prisma.Decimal; // StvarnaVP
}

/** Nivelaciona stavka (StockLevelingItem) — za NIV predznak/vrednost. */
export interface KepuSourceLeveling {
  quantityRevalued: Prisma.Decimal;
  oldWholesalePrice: Prisma.Decimal;
  newWholesalePrice: Prisma.Decimal;
  oldRetailPrice: Prisma.Decimal;
  newRetailPrice: Prisma.Decimal;
  valueAdjustment: Prisma.Decimal;
}

/** Default smer po tipu dokumenta (DocumentType.kepuDefault*). */
export interface KepuDocTypeFlags {
  kepuDefaultCharge: string | null;
  kepuDefaultDischarge: string | null;
}

type KepuDirection = "charge" | "discharge" | "signed" | "transfer" | "skip";

/** Da li je `kepuDefault*` string postavljen na „aktivnu" vrednost (ne prazno / 0 / false / ne). */
function flagSet(value: string | null | undefined): boolean {
  if (value == null) return false;
  const t = value.trim().toLowerCase();
  return t !== "" && t !== "0" && t !== "false" && t !== "ne";
}

/** MP (maloprodajna) jedinična vrednost stavke sa fallback lancem na VP. */
function unitMpValue(it: KepuSourceItem): Prisma.Decimal {
  if (it.calculatedRetailPrice.gt(ZERO)) return it.calculatedRetailPrice; // KalkMP (UL)
  if (it.actualRetailPrice.gt(ZERO)) return it.actualRetailPrice; // StvarnaMP (IZ/prodaja)
  if (it.calculatedWholesalePrice.gt(ZERO)) return it.calculatedWholesalePrice; // KalkVP fallback
  return it.actualWholesalePrice; // StvarnaVP (poslednji fallback)
}

/** Σ |Kol| × jedinična MP vrednost (količina se čuva pozitivno; abs za svaki slučaj). */
function sumMpValue(items: KepuSourceItem[]): Prisma.Decimal {
  let total = ZERO;
  for (const it of items) {
    total = total.add(it.quantity.abs().mul(unitMpValue(it)));
  }
  return total.toDecimalPlaces(4, D.ROUND_HALF_UP);
}

/**
 * NIV — signed vrednost revalorizacije: Σ Kol × (novaMP − staraMP); ako je MP razlika 0
 * (nema retail cena u paru), fallback na `valueAdjustment` (VP razlika, doc 39 §F).
 * Pozitivno → zaduženje (nivelacija „+"), negativno → razduženje (nivelacija „−").
 */
function nivSignedValue(levelingItems: KepuSourceLeveling[]): Prisma.Decimal {
  let total = ZERO;
  for (const li of levelingItems) {
    const retailDelta = li.newRetailPrice.sub(li.oldRetailPrice);
    if (!retailDelta.isZero()) {
      total = total.add(li.quantityRevalued.mul(retailDelta));
    } else {
      total = total.add(li.valueAdjustment);
    }
  }
  return total.toDecimalPlaces(4, D.ROUND_HALF_UP);
}

/** Smer knjiženja: prvo DocumentType default flag, pa priroda dokumenta (`kind`). */
function resolveDirection(
  kind: string,
  flags?: KepuDocTypeFlags | null,
): KepuDirection {
  const charge = flagSet(flags?.kepuDefaultCharge);
  const discharge = flagSet(flags?.kepuDefaultDischarge);
  if (charge && !discharge) return "charge";
  if (discharge && !charge) return "discharge";
  // oba ili nijedan flag → smer po prirodi dokumenta
  switch (kind) {
    case "UL":
    case "VISAK":
      return "charge";
    case "IZ":
    case "MANJAK":
      return "discharge";
    case "NIV":
      return "signed";
    case "PRENOS":
      return "transfer";
    default:
      return "skip";
  }
}

function entry(
  doc: KepuSourceDoc,
  warehouseId: number,
  charge: Prisma.Decimal,
  discharge: Prisma.Decimal,
  descriptionSuffix?: string,
): Prisma.KepuBookEntryCreateManyInput {
  const base = `${doc.documentTypeCode} ${doc.documentNumber}`;
  return {
    companyId: doc.companyId,
    warehouseId,
    documentId: doc.id,
    entryDate: doc.documentDate,
    charge,
    discharge,
    description: descriptionSuffix ? `${base} ${descriptionSuffix}` : base,
  };
}

/**
 * Izračunaj KEPU red(ove) za dokument. Prazan niz kad nema šta da se knjiži
 * (nepoznat smer, vrednost 0, PRENOS bez odredišnog magacina).
 */
export function computeKepuEntries(
  doc: KepuSourceDoc,
  items: KepuSourceItem[],
  levelingItems: KepuSourceLeveling[],
  flags?: KepuDocTypeFlags | null,
): Prisma.KepuBookEntryCreateManyInput[] {
  const dir = resolveDirection(doc.kind, flags);
  if (dir === "skip") return [];

  if (dir === "signed") {
    const net = nivSignedValue(levelingItems);
    if (net.isZero()) return [];
    const abs = net.abs();
    return [
      net.isPositive()
        ? entry(doc, doc.warehouseId, abs, ZERO, "(nivelacija)")
        : entry(doc, doc.warehouseId, ZERO, abs, "(nivelacija)"),
    ];
  }

  const value = sumMpValue(items);
  if (value.isZero()) return [];

  if (dir === "transfer") {
    const entries = [
      entry(doc, doc.warehouseId, ZERO, value, "(prenos izlaz)"),
    ];
    if (doc.targetWarehouseId != null) {
      entries.push(
        entry(doc, doc.targetWarehouseId, value, ZERO, "(prenos ulaz)"),
      );
    }
    return entries;
  }

  return [
    dir === "charge"
      ? entry(doc, doc.warehouseId, value, ZERO)
      : entry(doc, doc.warehouseId, ZERO, value),
  ];
}

/**
 * Idempotentno upiši KEPU red(ove) za dokument: obriši sve po `documentId` pa upiši sveže.
 * Poziva se UNUTAR postojeće `$transaction` (prima `tx`). Vraća broj upisanih redova.
 */
export async function writeKepuEntries(
  tx: Prisma.TransactionClient,
  documentId: number,
  entries: Prisma.KepuBookEntryCreateManyInput[],
): Promise<number> {
  await tx.kepuBookEntry.deleteMany({ where: { documentId } });
  if (entries.length === 0) return 0;
  await tx.kepuBookEntry.createMany({ data: entries });
  return entries.length;
}
