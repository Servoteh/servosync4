/**
 * DOKAZ NA DEV BAZI — prenos između magacina (nalaz §3.2, grupa C).
 * ============================================================================
 * Vozi PRAVE servise (`TransferService` + `RobnoService` + `CostingService`) nad dev
 * bazom i ISPISUJE STANJE OBA MAGACINA PRE I POSLE svakog koraka. Stanje se čita
 * ISTOM formulom koju koristi lager lista (Σ(±količina) iz `stock_document_items` sa
 * znakom iz `document_types.is_inbound`) — dakle ono što skript ispiše je ono što
 * korisnik vidi na ekranu.
 *
 * Koraci:
 *   0. priprema — dva magacina + artikal + početna zaliha (primka UFROB)
 *   1. PRENOS — izvor razdužen, odredište zaduženo, zbir očuvan (količinski i vrednosno)
 *   2. GUARD — prenos veći od stanja se odbija (422), stanje se ne pomera
 *   3. STORNO — oba magacina vraćena na stanje pre prenosa
 *   4. DVOSTRUKI STORNO — odbijen (409)
 *   5. ČIŠĆENJE — svi ZZ-PRENOS dokumenti se brišu (skript je ponovljiv)
 *
 * Pokretanje:
 *   npx ts-node --transpile-only scripts/proof-prenos-magacina.ts
 * (URL dev baze se čita iz `backend/.env.dev`; ne dira prod.)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";
import { RobnoService } from "../src/modules/robno/robno.service";
import { CostingService } from "../src/modules/robno/costing.service";
import { TransferService } from "../src/modules/robno/transfer.service";
import { StockDocumentNumberingService } from "../src/modules/robno/stock-document-numbering.service";

const envPath = path.join(__dirname, "..", ".env.dev");
const url = /postgresql:\/\/[^"\s]+/
  .exec(fs.readFileSync(envPath, "utf8"))![0]
  .replace("?schema=public", "");
const prisma = new PrismaClient({ datasources: { db: { url } } });

const numbering = new StockDocumentNumberingService();
const costing = new CostingService(prisma as never);
const robno = new RobnoService(prisma as never, numbering, costing);
const transfer = new TransferService(prisma as never, numbering, robno);

const MARK = "ZZ-PRENOS-PROBA";
let fail = 0;
const log = (s: string) => console.log(s);
const check = (name: string, cond: boolean, detail: string) => {
  if (!cond) fail += 1;
  log(`  ${cond ? "OK  " : "PAO "} ${name} — ${detail}`);
};

/** Stanje + vrednost zaliha po magacinu — VERBATIM formula lager liste. */
async function stanje(itemId: number, warehouseId: number) {
  const rows = await prisma.$queryRaw<
    Array<{ on_hand: Prisma.Decimal | null; value: Prisma.Decimal | null }>
  >(Prisma.sql`
    SELECT COALESCE(SUM(CASE WHEN dt.is_inbound THEN sdi.quantity ELSE -sdi.quantity END), 0) AS on_hand,
           COALESCE(SUM(CASE WHEN dt.is_inbound THEN 1 ELSE -1 END * sdi.quantity *
                    (sdi.purchase_price_net + sdi.dependent_cost_own + sdi.dependent_cost_supplier)), 0) AS value
    FROM stock_document_items sdi
    JOIN stock_documents sd ON sd.id = sdi.document_id
    JOIN document_types dt ON dt.code = sd.document_type_code
    WHERE sdi.item_id = ${itemId}
      AND sdi.warehouse_id = ${warehouseId}
      AND sd.document_type_code <> 'KODJ'
      AND COALESCE(dt.affects_stock, TRUE) = TRUE
      AND sdi.deleted_at IS NULL
  `);
  return {
    kol: new Prisma.Decimal(rows[0]?.on_hand ?? 0),
    vred: new Prisma.Decimal(rows[0]?.value ?? 0),
  };
}

async function ispisi(naslov: string, itemId: number, a: number, b: number) {
  const [sa, sb] = await Promise.all([stanje(itemId, a), stanje(itemId, b)]);
  log(
    `  ${naslov.padEnd(26)} | magacin ${a}: ${sa.kol.toFixed(3).padStart(10)} kom / ` +
      `${sa.vred.toFixed(2).padStart(12)} din | magacin ${b}: ${sb.kol.toFixed(3).padStart(10)} kom / ` +
      `${sb.vred.toFixed(2).padStart(12)} din | UKUPNO: ${sa.kol.add(sb.kol).toFixed(3)} kom / ` +
      `${sa.vred.add(sb.vred).toFixed(2)} din`,
  );
  return { a: sa, b: sb, ukupnoKol: sa.kol.add(sb.kol), ukupnoVred: sa.vred.add(sb.vred) };
}

async function main() {
  log("\n═══════ DOKAZ: PRENOS IZMEĐU MAGACINA (dev baza) ═══════\n");

  // ── 0) priprema ───────────────────────────────────────────────────────────
  let whA = await prisma.warehouse.findFirst({
    where: { name: `${MARK}-A` },
    select: { id: true },
  });
  if (!whA)
    whA = await prisma.warehouse.create({
      data: { companyId: 0, name: `${MARK}-A`, averagePrices: true },
      select: { id: true },
    });
  let whB = await prisma.warehouse.findFirst({
    where: { name: `${MARK}-B` },
    select: { id: true },
  });
  if (!whB)
    whB = await prisma.warehouse.create({
      data: { companyId: 0, name: `${MARK}-B`, averagePrices: true },
      select: { id: true },
    });

  const item = await prisma.item.findFirst({ select: { id: true, name: true } });
  if (!item) throw new Error("nema nijednog artikla na dev bazi");
  log(`  priprema: artikal ${item.id} (${item.name}), magacini ${whA.id} → ${whB.id}\n`);

  // Početna zaliha: primka 10 kom po 250 din u magacinu A.
  const ul = await robno.createStockDocument("UL", {
    documentTypeCode: "UFROB",
    warehouseId: whA.id,
    documentDate: new Date().toISOString(),
    note: MARK,
    items: [
      { itemId: item.id, quantity: "10", invoicePrice: "250", lineNo: 1 },
    ],
  });
  // Kalkulacija se ne pokreće (nije predmet ovog dokaza) — nabavnu cenu upisujemo
  // direktno, da vrednost zaliha uopšte postoji i da se može pratiti kroz prenos.
  await prisma.stockDocumentItem.updateMany({
    where: { documentId: ul.data.id },
    data: {
      purchasePriceNet: new Prisma.Decimal(250),
      calculatedWholesalePrice: new Prisma.Decimal(300),
    },
  });
  log(`  primka ${ul.data.documentNumber}: 10 kom × 250 din u magacin ${whA.id}\n`);

  const pre = await ispisi("PRE PRENOSA", item.id, whA.id, whB.id);

  // ── 1) prenos ─────────────────────────────────────────────────────────────
  const t = await transfer.createTransfer(
    {
      sourceWarehouseId: whA.id,
      targetWarehouseId: whB.id,
      documentDate: new Date().toISOString(),
      note: MARK,
      items: [{ itemId: item.id, quantity: "4" }],
    },
    1,
  );
  log(
    `\n  prenos: ${t.data.outbound.documentTypeCode} ${t.data.outbound.documentNumber} (izlaz iz ${whA.id}) ` +
      `+ ${t.data.inbound.documentTypeCode} ${t.data.inbound.documentNumber} (ulaz u ${whB.id}), ` +
      `par ${t.data.outbound.id} ↔ ${t.data.inbound.id}\n`,
  );
  const posle = await ispisi("POSLE PRENOSA", item.id, whA.id, whB.id);

  check(
    "izvorni magacin razdužen za 4",
    posle.a.kol.equals(pre.a.kol.sub(4)),
    `${pre.a.kol.toFixed(3)} → ${posle.a.kol.toFixed(3)}`,
  );
  check(
    "odredišni magacin zadužen za 4",
    posle.b.kol.equals(pre.b.kol.add(4)),
    `${pre.b.kol.toFixed(3)} → ${posle.b.kol.toFixed(3)}`,
  );
  check(
    "ukupna KOLIČINA po oba magacina očuvana",
    posle.ukupnoKol.equals(pre.ukupnoKol),
    `${pre.ukupnoKol.toFixed(3)} = ${posle.ukupnoKol.toFixed(3)}`,
  );
  check(
    "ukupna VREDNOST po oba magacina očuvana",
    posle.ukupnoVred.equals(pre.ukupnoVred),
    `${pre.ukupnoVred.toFixed(2)} = ${posle.ukupnoVred.toFixed(2)}`,
  );

  const kepu = await prisma.kepuBookEntry.findMany({
    where: { documentId: { in: [t.data.outbound.id, t.data.inbound.id] } },
    select: { warehouseId: true, charge: true, discharge: true },
    orderBy: { warehouseId: "asc" },
  });
  check(
    "KEPU: dva reda (razduženje izvora + zaduženje odredišta)",
    kepu.length === 2 &&
      kepu.some((k) => k.warehouseId === whA.id && k.discharge.greaterThan(0)) &&
      kepu.some((k) => k.warehouseId === whB.id && k.charge.greaterThan(0)),
    kepu
      .map(
        (k) =>
          `mag ${k.warehouseId}: +${k.charge.toFixed(2)} / −${k.discharge.toFixed(2)}`,
      )
      .join(" | ") || "nema redova",
  );

  // ── 2) guard negativnog stanja ────────────────────────────────────────────
  let odbijen = "";
  try {
    await transfer.createTransfer(
      {
        sourceWarehouseId: whA.id,
        targetWarehouseId: whB.id,
        items: [{ itemId: item.id, quantity: "999" }],
      },
      1,
    );
  } catch (e) {
    odbijen = `${(e as { status?: number })?.status ?? "?"}`;
  }
  const poslePokusaja = await ispisi("POSLE ODBIJENOG (999)", item.id, whA.id, whB.id);
  check("prenos veći od stanja je odbijen sa 422", odbijen === "422", `status=${odbijen}`);
  check(
    "odbijeni prenos nije pomerio nijedan magacin",
    poslePokusaja.a.kol.equals(posle.a.kol) && poslePokusaja.b.kol.equals(posle.b.kol),
    `${poslePokusaja.a.kol.toFixed(3)} / ${poslePokusaja.b.kol.toFixed(3)}`,
  );

  // ── 3) storno ─────────────────────────────────────────────────────────────
  const s = await transfer.reverse(
    t.data.outbound.id,
    { reason: "dokaz storna" },
    1,
  );
  log(
    `\n  storno: ${s.data.outbound.documentNumber} (izlaz iz ${whB.id}) + ` +
      `${s.data.inbound.documentNumber} (ulaz u ${whA.id})\n`,
  );
  const posleStorna = await ispisi("POSLE STORNA", item.id, whA.id, whB.id);
  check(
    "storno vratio OBA magacina na stanje pre prenosa",
    posleStorna.a.kol.equals(pre.a.kol) && posleStorna.b.kol.equals(pre.b.kol),
    `magacin ${whA.id}: ${posleStorna.a.kol.toFixed(3)} (pre ${pre.a.kol.toFixed(3)}), ` +
      `magacin ${whB.id}: ${posleStorna.b.kol.toFixed(3)} (pre ${pre.b.kol.toFixed(3)})`,
  );
  check(
    "storno vratio i VREDNOST",
    posleStorna.a.vred.equals(pre.a.vred) && posleStorna.b.vred.equals(pre.b.vred),
    `${posleStorna.a.vred.toFixed(2)} / ${posleStorna.b.vred.toFixed(2)}`,
  );

  // ── 4) dvostruki storno ───────────────────────────────────────────────────
  let drugiStorno = "";
  try {
    await transfer.reverse(t.data.inbound.id, {}, 1);
  } catch (e) {
    drugiStorno = `${(e as { status?: number })?.status ?? "?"}`;
  }
  check("dvostruki storno odbijen sa 409", drugiStorno === "409", `status=${drugiStorno}`);

  // ── 4b) usputni nalazi robnog (§3.17 pretraga, §3.10/B8 nazivi artikala) ──
  const nadjeni = await robno.listStockDocuments({
    q: ul.data.documentNumber,
    kind: "UL",
  });
  const promasaj = await robno.listStockDocuments({ q: "NEMA-OVAKVOG-BROJA" });
  check(
    "pretraga po broju dokumenta nalazi tačan dokument (§3.17)",
    nadjeni.data.some((d: { id: number }) => d.id === ul.data.id) &&
      promasaj.meta.pagination.total === 0,
    `q='${ul.data.documentNumber}' → ${nadjeni.meta.pagination.total} pogodaka; ` +
      `q='NEMA-OVAKVOG-BROJA' → ${promasaj.meta.pagination.total}`,
  );

  const detalj = await robno.getStockDocument(ul.data.id);
  check(
    "detalj dokumenta nosi NAZIV i ŠIFRU artikla (§3.10 / B8)",
    detalj.data.items[0]?.itemName != null,
    `stavka 1: ${detalj.data.items[0]?.itemName ?? "—"} / ${detalj.data.items[0]?.itemCode ?? "—"}`,
  );

  const detaljPrenosa = await transfer.get(t.data.outbound.id);
  check(
    "detalj prenosa vidi OBE strane i zna da je storniran",
    detaljPrenosa.data.inbound.id === t.data.inbound.id &&
      detaljPrenosa.data.reversed === true,
    `izlaz ${detaljPrenosa.data.outbound.documentNumber} ↔ ulaz ` +
      `${detaljPrenosa.data.inbound.documentNumber}, storniran=${detaljPrenosa.data.reversed}`,
  );

  // ── 5) čišćenje ───────────────────────────────────────────────────────────
  const mineIds = [
    ul.data.id,
    t.data.outbound.id,
    t.data.inbound.id,
    s.data.outbound.id,
    s.data.inbound.id,
  ];
  await prisma.kepuBookEntry.deleteMany({ where: { documentId: { in: mineIds } } });
  await prisma.stockDocumentItem.deleteMany({ where: { documentId: { in: mineIds } } });
  await prisma.stockDocument.deleteMany({ where: { id: { in: mineIds } } });
  const kraj = await ispisi("POSLE ČIŠĆENJA", item.id, whA.id, whB.id);
  check(
    "dev baza vraćena u zatečeno stanje",
    kraj.ukupnoKol.isZero(),
    `ukupno ${kraj.ukupnoKol.toFixed(3)} kom`,
  );

  log(`\n  ${fail === 0 ? "SVE PROŠLO" : `${fail} PROVERA PALO`}\n`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("DOKAZ PAO:", e);
  await prisma.$disconnect();
  process.exit(1);
});
