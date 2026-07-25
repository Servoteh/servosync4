/**
 * Batch C dev smoke — stvarni tokovi kroz Nest DI kontekst na dev bazi.
 * Ne koristi HTTP: instancira servise i vozi poslovne tokove end-to-end.
 */
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { AdvanceInvoiceService } from "../src/modules/sales/advance-invoice.service";
import { ReservationService } from "../src/modules/robno/reservation.service";
import { FxRevaluationService } from "../src/modules/saldakonti/fx-revaluation.service";
import { ThreeWayMatchService } from "../src/modules/nabavka/three-way-match.service";
import { AdvanceVatService } from "../src/modules/pdv/advance-vat.service";
import { PaymentPreparationService } from "../src/modules/placanja/payment-preparation.service";
import { FakturisanjeService } from "../src/modules/sales/fakturisanje.service";

/* eslint-disable @typescript-eslint/no-explicit-any */

let pass = 0;
let fail = 0;
const results: string[] = [];

function ok(name: string, detail = "") {
  pass += 1;
  results.push(`  OK   ${name}${detail ? " — " + detail : ""}`);
}
function bad(name: string, err: unknown) {
  fail += 1;
  results.push(`  FAIL ${name} — ${String(err)}`);
}
async function step(name: string, fn: () => Promise<string | void>) {
  try {
    const d = await fn();
    ok(name, typeof d === "string" ? d : "");
  } catch (e) {
    bad(name, e);
  }
}
/** Očekuje da poziv padne sa datim HTTP statusom (guard test). */
async function expectStatus(name: string, status: number, fn: () => Promise<unknown>) {
  try {
    await fn();
    bad(name, `očekivan ${status}, prošlo bez greške`);
  } catch (e: any) {
    const s = e?.status ?? e?.getStatus?.();
    if (s === status) ok(name, `${status}`);
    else bad(name, `očekivan ${status}, dobijen ${s}: ${e?.message}`);
  }
}

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ["error"],
  });

  const prisma: any = app.get(PrismaService);


  const advance: any = app.get(AdvanceInvoiceService);
  const reservation: any = app.get(ReservationService);
  const fx: any = app.get(FxRevaluationService);
  const match: any = app.get(ThreeWayMatchService);
  const advanceVat: any = app.get(AdvanceVatService);

  const actor = { userId: 1, email: "smoke@servoteh.com", role: "ADMIN" } as any;
  const stamp = Date.now();

  // ── priprema: kupac + artikal + magacin ─────────────────────────────────────
  let customerId = 0;
  let itemId = 0;
  const warehouseId = 1;

  await step("priprema: kupac", async () => {
    const c = await prisma.customer.findFirst({ select: { id: true } });
    if (!c) throw new Error("nema nijednog kupca na dev bazi");
    customerId = c.id;
    return `customerId=${customerId}`;
  });
  await step("priprema: artikal sa zalihom (ili je zaseje)", async () => {
    const lvl = await prisma.stockLevel.findFirst({
      where: { warehouseId, onHand: { gt: 0 } },
      select: { itemId: true, onHand: true },
    });
    if (lvl) {
      itemId = lvl.itemId;
      return `itemId=${itemId} onHand=${lvl.onHand}`;
    }
    const i = await prisma.item.findFirst({ select: { id: true } });
    if (!i) throw new Error("nema nijednog artikla");
    itemId = i.id;
    await prisma.stockLevel.upsert({
      where: { itemId_warehouseId: { itemId, warehouseId } },
      create: { itemId, warehouseId, onHand: "12", asOf: new Date() },
      update: { onHand: "12" },
    });
    return `itemId=${itemId} onHand=12 (smoke seed)`;
  });

  await step("priprema: kursna lista EUR (ako fali)", async () => {
    const day = new Date("2026-07-01T00:00:00.000Z");
    await prisma.exchangeRate.upsert({
      where: { rateDate_currency: { rateDate: day, currency: "EUR" } },
      create: {
        rateDate: day,
        currency: "EUR",
        buyRate: "116.5",
        middleRate: "117",
        sellRate: "117.5",
        source: "RUCNO",
        note: "smoke",
      },
      update: {},
    });
    return "EUR 01.07.2026 = 117 (srednji)";
  });

  // ── C1: AVR izlazni ─────────────────────────────────────────────────────────
  let proformaId = 0;
  let avrId = 0;

  await step("C1 priprema: predračun 12.000 bruto (10.000 + 20% PDV)", async () => {
    const p = await prisma.invoice.create({
      data: {
        documentType: "PROF",
        documentNumber: `SMOKE-PROF-${stamp}`,
        level: 250,
        companyId: 0,
        customerId,
        documentDate: new Date(),
        currency: "RSD",
        netTotal: "10000",
        vatTotal: "2000",
        grossTotal: "12000",
        status: "DRAFT",
        items: {
          create: [
            {
              lineNo: 1,
              itemId,
              quantity: "1",
              unitPrice: "10000",
              vatRateCode: "3",
              vatBase: "10000",
              vatAmount: "2000",
              lineTotal: "12000",
            },
          ],
        },
      },
    });
    proformaId = p.id;
    return `id=${proformaId}`;
  });

  await step("C1 AVR iz predračuna → osnovica 10.000 / PDV 2.000", async () => {
    const r = await advance.createAdvanceInvoice({ proformaId }, actor);
    const inv = r?.data ?? r;
    avrId = inv.id;
    const net = String(inv.netTotal);
    const vat = String(inv.vatTotal);
    if (Number(net) !== 10000 || Number(vat) !== 2000)
      throw new Error(`osnovica/PDV = ${net}/${vat}, očekivano 10000/2000`);
    return `${inv.documentNumber} net=${net} pdv=${vat}`;
  });

  await expectStatus("C1 drugi AVR iz istog predračuna → 409", 409, () =>
    advance.createAdvanceInvoice({ proformaId }, actor),
  );

  await step("C1 naplata avansa → GL nalog (2040 DUG / 4300 + 4720 POT)", async () => {
    const r = await advance.markAdvancePaid(
      { advanceInvoiceId: avrId, paidAt: new Date().toISOString().slice(0, 10), amount: "12000" },
      actor,
    );
    const d = r?.data ?? r;
    const entryId = d.journalEntryId ?? d.entryId;
    if (!entryId) throw new Error("nema journalEntryId u odgovoru");
    const lines = await prisma.ledgerEntry.findMany({
      where: { journalEntryId: entryId },
      select: { accountCode: true, debit: true, credit: true },
    });
    const byAcc = new Map(lines.map((l: any) => [l.accountCode, l]));
    if (!byAcc.has("4300")) throw new Error("nema stavke na 4300");
    if (!byAcc.has("4720")) throw new Error(`PDV avansa nije na 4720 (konta: ${[...byAcc.keys()].join(",")})`);
    const sumD = lines.reduce((a: number, l: any) => a + Number(l.debit), 0);
    const sumC = lines.reduce((a: number, l: any) => a + Number(l.credit), 0);
    if (Math.abs(sumD - sumC) > 0.0001) throw new Error(`nalog nije u balansu: ${sumD} vs ${sumC}`);
    return `nalog ${entryId}, balans ${sumD.toFixed(2)}`;
  });

  await expectStatus("C1 dvostruka naplata istog AVR → 409", 409, () =>
    advance.markAdvancePaid(
      { advanceInvoiceId: avrId, paidAt: new Date().toISOString().slice(0, 10), amount: "12000" },
      actor,
    ),
  );

  let finalId = 0;
  await step("C1 konačni račun 12.000 → odbitak avansa → za uplatu 0", async () => {
    const f = await prisma.invoice.create({
      data: {
        documentType: "IFR",
        documentNumber: `SMOKE-IFR-${stamp}`,
        level: 0,
        companyId: 0,
        customerId,
        documentDate: new Date(),
        currency: "RSD",
        netTotal: "10000",
        vatTotal: "2000",
        grossTotal: "12000",
        status: "POSTED",
      },
    });
    finalId = f.id;
    const r = await advance.applyAdvance({ invoiceId: finalId, advanceInvoiceId: avrId }, actor);
    const d = r?.data ?? r;
    const payable = Number(d.payableAmount);
    if (payable !== 0) throw new Error(`za uplatu = ${payable}, očekivano 0`);
    const after = await prisma.invoice.findUnique({ where: { id: finalId } });
    if (Number(after.grossTotal) !== 12000)
      throw new Error(`grossTotal promenjen na ${after.grossTotal} — avans NE sme da menja ukupno`);
    return `payable=0, grossTotal netaknut`;
  });

  await expectStatus("C1 isti AVR na drugom računu → 409 (parcijalni unique)", 409, async () => {
    const f2 = await prisma.invoice.create({
      data: {
        documentType: "IFR",
        documentNumber: `SMOKE-IFR2-${stamp}`,
        level: 0,
        companyId: 0,
        customerId,
        documentDate: new Date(),
        currency: "RSD",
        netTotal: "10000",
        vatTotal: "2000",
        grossTotal: "12000",
        status: "POSTED",
      },
    });
    return advance.applyAdvance({ invoiceId: f2.id, advanceInvoiceId: avrId }, actor);
  });

  // ── C1 review: storno konačnog računa mora da reverzira i nalog avansa ──────
  await step("C1 storno konačnog računa reverzira i nalog zatvaranja avansa", async () => {
    const before = await prisma.invoice.findUnique({ where: { id: finalId } });
    if (before.advanceClosingEntryId == null)
      throw new Error("nalog zatvaranja avansa nije upisan na fakturu");
    const closingId = before.advanceClosingEntryId;

    await prisma.invoice.update({
      where: { id: finalId },
      data: { isLocked: true, status: "POSTED" },
    });
    const fakt: any = app.get(FakturisanjeService);
    await fakt.stornoInvoice(finalId, "smoke storno", actor);

    const closing = await prisma.journalEntry.findUnique({
      where: { id: closingId },
      select: { reversedByEntryId: true },
    });
    if (closing?.reversedByEntryId == null)
      throw new Error("nalog zatvaranja avansa NIJE storniran — 4300 i PDV ostaju pogrešni");
    const after = await prisma.invoice.findUnique({ where: { id: finalId } });
    if (after.advanceInvoiceId != null)
      throw new Error("veza na avans nije očišćena — avans se ne može ponovo iskoristiti");
    return `nalog ${closingId} storniran, veza očišćena`;
  });

  await expectStatus("C1 storno već odbijenog AVR → 409 (prvo račun)", 409, async () => {
    const fakt: any = app.get(FakturisanjeService);
    // Napravi svež par: AVR naplaćen i odbijen na proknjiženom računu.
    const prof = await prisma.invoice.create({
      data: {
        documentType: "PROF", documentNumber: `SMOKE-PROF2-${stamp}`, level: 250,
        companyId: 0, customerId, documentDate: new Date(), currency: "RSD",
        netTotal: "10000", vatTotal: "2000", grossTotal: "12000", status: "DRAFT",
        items: { create: [{ lineNo: 1, itemId, quantity: "1", unitPrice: "10000",
          vatRateCode: "3", vatBase: "10000", vatAmount: "2000", lineTotal: "12000" }] },
      },
    });
    const avr = await advance.createAdvanceInvoice({ proformaId: prof.id }, actor);
    const avrId2 = (avr?.data ?? avr).id;
    await advance.markAdvancePaid(
      { advanceInvoiceId: avrId2, paidAt: new Date().toISOString().slice(0, 10), amount: "12000" },
      actor,
    );
    const fin = await prisma.invoice.create({
      data: {
        documentType: "IFR", documentNumber: `SMOKE-IFR3-${stamp}`, level: 0,
        companyId: 0, customerId, documentDate: new Date(), currency: "RSD",
        netTotal: "10000", vatTotal: "2000", grossTotal: "12000",
        status: "POSTED", isLocked: true,
      },
    });
    await advance.applyAdvance({ invoiceId: fin.id, advanceInvoiceId: avrId2 }, actor);
    return fakt.stornoInvoice(avrId2, "smoke storno avansa", actor);
  });

  // ── C1 review: kumulativna (delimična) naplata avansa ───────────────────────
  await step("C1 delimična naplata 5.000 + 7.000 na avans od 12.000", async () => {
    const prof = await prisma.invoice.create({
      data: {
        documentType: "PROF", documentNumber: `SMOKE-PROF3-${stamp}`, level: 250,
        companyId: 0, customerId, documentDate: new Date(), currency: "RSD",
        netTotal: "10000", vatTotal: "2000", grossTotal: "12000", status: "DRAFT",
        items: { create: [{ lineNo: 1, itemId, quantity: "1", unitPrice: "10000",
          vatRateCode: "3", vatBase: "10000", vatAmount: "2000", lineTotal: "12000" }] },
      },
    });
    const avr = await advance.createAdvanceInvoice({ proformaId: prof.id }, actor);
    const id = (avr?.data ?? avr).id;
    const today = new Date().toISOString().slice(0, 10);
    await advance.markAdvancePaid({ advanceInvoiceId: id, paidAt: today, amount: "5000" }, actor);
    await advance.markAdvancePaid({ advanceInvoiceId: id, paidAt: today, amount: "7000" }, actor);
    const row = await prisma.invoice.findUnique({ where: { id } });
    if (Number(row.advancePaidAmount) !== 12000)
      throw new Error(`naplaćeno ${row.advancePaidAmount}, očekivano 12000`);
    if (row.status !== "PAID")
      throw new Error(`status ${row.status}, očekivano PAID tek po punoj naplati`);
    return `naplaćeno 12000 u dve rate, status PAID`;
  });

  await expectStatus("C1 naplata preko iznosa avansa → 422", 422, async () => {
    const prof = await prisma.invoice.create({
      data: {
        documentType: "PROF", documentNumber: `SMOKE-PROF4-${stamp}`, level: 250,
        companyId: 0, customerId, documentDate: new Date(), currency: "RSD",
        netTotal: "10000", vatTotal: "2000", grossTotal: "12000", status: "DRAFT",
        items: { create: [{ lineNo: 1, itemId, quantity: "1", unitPrice: "10000",
          vatRateCode: "3", vatBase: "10000", vatAmount: "2000", lineTotal: "12000" }] },
      },
    });
    const avr = await advance.createAdvanceInvoice({ proformaId: prof.id }, actor);
    const id = (avr?.data ?? avr).id;
    const today = new Date().toISOString().slice(0, 10);
    await advance.markAdvancePaid({ advanceInvoiceId: id, paidAt: today, amount: "10000" }, actor);
    return advance.markAdvancePaid({ advanceInvoiceId: id, paidAt: today, amount: "5000" }, actor);
  });

  // ── C1b: ulazni avans (pretporez po plaćanju) ───────────────────────────────
  let inAdvanceId = 0;
  await step("C1b ulazni avans bez plaćanja → NEMA KUF stavke", async () => {
    const r = await advanceVat.recordIncomingAdvance(
      {
        partnerId: customerId,
        documentNumber: `SMOKE-AVDOB-${stamp}`,
        documentDate: new Date().toISOString().slice(0, 10),
        grossAmount: 6000,
        vatRateCode: "3",
      },
      actor,
    );
    const d = r?.data ?? r;
    inAdvanceId = d.id ?? d.invoiceId;
    const kuf = await prisma.vatLedgerEntry.count({
      where: { documentNumber: `SMOKE-AVDOB-${stamp}`, direction: "input" },
    });
    if (kuf !== 0) throw new Error(`KUF stavki ${kuf}, očekivano 0 pre plaćanja`);
    return `avans ${inAdvanceId}, KUF 0`;
  });

  await step("C1b plaćanje → KUF stavka u periodu PLAĆANJA", async () => {
    await advanceVat.markIncomingAdvancePaid(
      { id: inAdvanceId, paidAt: "2026-09-15", amount: 6000 },
      actor,
    );
    const rows = await prisma.vatLedgerEntry.findMany({
      where: { documentNumber: `SMOKE-AVDOB-${stamp}`, direction: "input" },
      select: { taxPeriodYear: true, taxPeriodMonth: true, vatAmount: true },
    });
    if (rows.length !== 1) throw new Error(`KUF stavki ${rows.length}, očekivano 1`);
    if (rows[0].taxPeriodMonth !== 9) throw new Error(`period mesec ${rows[0].taxPeriodMonth}, očekivano 9`);
    return `KUF 1 kom, period 2026-09, PDV ${rows[0].vatAmount}`;
  });

  // ── C3: rezervacija zaliha ──────────────────────────────────────────────────
  await step("C3 raspoloživo pre rezervacije", async () => {
    const r = await reservation.availability({ itemId, warehouseId });
    const d = r?.data ?? r;
    return `onHand=${d.onHand} reserved=${d.reserved} available=${d.available}`;
  });

  await step("C3 rezervacija iz predračuna (idempotentno)", async () => {
    const r1 = await reservation.reserveForProforma({ invoiceId: proformaId, warehouseId }, 1);
    const r2 = await reservation.reserveForProforma({ invoiceId: proformaId, warehouseId }, 1);
    const d1 = r1?.data ?? r1;
    const d2 = r2?.data ?? r2;
    const created2 = d2.created ?? (Array.isArray(d2) ? d2.length : 0);
    if (created2 !== 0) throw new Error(`ponovni poziv napravio ${created2} rezervacija — nije idempotentan`);
    return `1. poziv created=${d1.created ?? "?"}, 2. poziv created=0`;
  });

  await step("C3 raspoloživo je umanjeno za rezervisano", async () => {
    const r = await reservation.availability({ itemId, warehouseId });
    const d = r?.data ?? r;
    if (Number(d.reserved) < 1) throw new Error(`reserved=${d.reserved}, očekivano ≥ 1`);
    if (Number(d.available) !== Number(d.onHand) - Number(d.reserved))
      throw new Error(`available ${d.available} ≠ onHand ${d.onHand} − reserved ${d.reserved}`);
    return `onHand=${d.onHand} reserved=${d.reserved} available=${d.available}`;
  });

  await step("C3 oslobađanje vraća u raspoloživo", async () => {
    await reservation.release(
      { sourceType: "invoice", sourceId: proformaId, reason: "smoke" },
      1,
    );
    const r = await reservation.availability({ itemId, warehouseId });
    const d = r?.data ?? r;
    if (Number(d.reserved) !== 0) throw new Error(`reserved=${d.reserved} posle oslobađanja, očekivano 0`);
    return `reserved=0, available=${d.available}`;
  });

  // ── C2: kursne razlike ──────────────────────────────────────────────────────
  await step("C2 preview revalorizacije (bez upisa)", async () => {
    const rate = await prisma.exchangeRate.findFirst({
      where: { currency: "EUR" },
      orderBy: { rateDate: "desc" },
    });
    if (!rate) return "preskočeno — nema kursne liste za EUR na dev bazi";
    const r = await fx.preview({
      asOfDate: rate.rateDate,
      currency: "EUR",
    });
    const d = r?.data ?? r;
    const n = d.items?.length ?? d.rows?.length ?? 0;
    const before = await prisma.fxRevaluationRun.count();
    if (before !== 0) throw new Error("preview je nešto upisao — mora biti čist read");
    return `stavki=${n}, kurs=${d.rateUsed ?? rate.middleRate} (bez upisa)`;
  });

  await expectStatus("C2 presek u budućnosti → odbijen", 409, () =>
    fx.run({ asOfDate: "2099-12-31", currency: "EUR" }, { userId: 1 }),
  );

  // ── C4: 3-way match (upozorenje, ne blokada) ────────────────────────────────
  await step("C4 match nad postojećom narudžbenicom", async () => {
    const po = await prisma.purchaseOrder.findFirst({ select: { id: true } });
    if (!po) return "preskočeno — nema narudžbenica na dev bazi";
    const r = await match.matchOrder(po.id);
    const d = r?.data ?? r;
    const findings = d.findings?.length ?? 0;
    return `PO ${po.id}: stavki=${d.items?.length ?? 0}, nalaza=${findings}`;
  });

  await step("C4 priprema plaćanja PROLAZI (upozorenja ne blokiraju)", async () => {
    const prep: any = app.get(PaymentPreparationService);
    const r = await prep.selectDue();
    const d = r?.data ?? r;
    const arr = Array.isArray(d) ? d : (d.items ?? []);
    return `dospelih=${arr.length}, hasMatchWarnings=${r?.hasMatchWarnings ?? d?.hasMatchWarnings ?? "n/a"}`;
  });

  // ── čišćenje smoke podataka ─────────────────────────────────────────────────
  await step("čišćenje", async () => {
    await prisma.stockReservation.deleteMany({
      where: { sourceType: "invoice", sourceId: proformaId },
    });
    await prisma.vatLedgerEntry.deleteMany({
      where: { documentNumber: { startsWith: `SMOKE-AVDOB-${stamp}` } },
    });
    await prisma.invoiceItem.deleteMany({
      where: { invoice: { documentNumber: { contains: `SMOKE-` } } },
    });
    const del = await prisma.invoice.deleteMany({
      where: { documentNumber: { contains: `SMOKE-` } },
    });
    return `obrisano ${del.count} smoke dokumenata`;
  });

  await app.close();

  console.log("\n═══════════ BATCH C DEV SMOKE ═══════════");
  console.log(results.join("\n"));
  console.log(`\n  ${pass} prošlo, ${fail} palo\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("SMOKE PAO:", e);
  process.exit(1);
});
