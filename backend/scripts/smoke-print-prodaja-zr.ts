/**
 * DOKAZ ŠTAMPE — grupa „Prodaja i završni račun".
 * =============================================================================
 * Zasejava probne dokumente NA DEV BAZI, renderuje PDF kroz STVARNE servise
 * (`InvoicePdfService`, `StatementPdfService`) i ispisuje broj bajtova svakog
 * izlaza, pa briše sve što je napravio.
 *
 * Pokretanje (iz backend/):
 *   npx ts-node -r tsconfig-paths/register scripts/smoke-print-prodaja-zr.ts
 * uz DATABASE_URL iz .env.dev.
 */
import { NestFactory } from "@nestjs/core";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Prisma } from "@prisma/client";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { InvoicePdfService } from "../src/modules/sales/print/invoice-pdf.service";
import { StatementPdfService } from "../src/modules/zavrsni/statement-pdf.service";
import { BalanceSheetService } from "../src/modules/zavrsni/balance-sheet.service";

/* eslint-disable @typescript-eslint/no-explicit-any */

const D = Prisma.Decimal;
/** Kratak žig — `invoices.document_number` je VarChar(30). */
const STAMP = `PS${Date.now() % 1_000_000}`;
/** Godina probnog obračuna — van realnog opsega da ne dira postojeće bilanse. */
const TEST_YEAR = 2035;
const OUT_DIR = join(__dirname, "..", "reports", "print-smoke");

const lines: string[] = [];
function report(name: string, buf: Buffer, fileName: string) {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, fileName), buf);
  lines.push(`  ${name.padEnd(42)} ${String(buf.length).padStart(8)} B   ${fileName}`);
}

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ["error"],
  });
  const prisma: any = app.get(PrismaService);
  const invoicePdf = app.get(InvoicePdfService);
  const statementPdf = app.get(StatementPdfService);
  const balanceSheet = app.get(BalanceSheetService);

  const createdInvoiceIds: number[] = [];
  const createdStatementIds: number[] = [];
  let createdCustomerId: number | null = null;

  try {
    // ── firma izdavalac ────────────────────────────────────────────────────
    let company = await prisma.company.findFirst({ orderBy: { id: "asc" } });
    if (!company) {
      company = await prisma.company.create({
        data: {
          id: 1,
          companyName: "Servoteh d.o.o. Dobanovci",
          city: "Dobanovci",
          address: "Ugrinovački put 163",
          taxId: "101017443",
          registrationNumber: "17400169",
          businessActivityCode: "3320",
          bankAccount: "160-0000000123456-78",
          phone: "011/8470-000",
          email: "office@servoteh.com",
        },
      });
      lines.push("  (napravljena probna firma izdavalac)");
    }

    // ── kupac ──────────────────────────────────────────────────────────────
    let customer = await prisma.customer.findFirst({ orderBy: { id: "asc" } });
    if (!customer) {
      customer = await prisma.customer.create({
        data: {
          name: `${STAMP} Kupac d.o.o.`,
          city: "Beograd",
          address: "Bulevar oslobođenja 12",
          postalCode: "11000",
          country: "Srbija",
          taxId: "100000001",
          registrationNumber: "20000001",
        },
      });
      createdCustomerId = customer.id;
    }

    // ── pomoćni: dokument sa stavkama ──────────────────────────────────────
    const makeInvoice = async (
      documentType: string,
      documentNumber: string,
      items: Array<{ desc: string; qty: string; price: string; vatPct: number }>,
      extra: Record<string, unknown> = {},
    ) => {
      let net = new D(0);
      let vat = new D(0);
      const itemRows = items.map((it, idx) => {
        const base = new D(it.qty).mul(new D(it.price)).toDecimalPlaces(4);
        const vatAmount = base.mul(it.vatPct).div(100).toDecimalPlaces(4);
        net = net.add(base);
        vat = vat.add(vatAmount);
        return {
          lineNo: idx + 1,
          description: it.desc,
          quantity: new D(it.qty),
          unitPrice: new D(it.price),
          vatRateCode: it.vatPct === 20 ? "3" : it.vatPct === 10 ? "2" : "0",
          vatBase: base,
          vatAmount,
          lineTotal: base.add(vatAmount),
        };
      });
      const inv = await prisma.invoice.create({
        data: {
          documentType,
          documentNumber,
          level: 0,
          companyId: company.id,
          customerId: customer.id,
          documentDate: new Date(),
          dueDate: new Date(Date.now() + 15 * 864e5),
          currency: "RSD",
          netTotal: net,
          vatTotal: vat,
          grossTotal: net.add(vat),
          status: "POSTED",
          isLocked: true,
          ...extra,
          items: { create: itemRows },
        },
      });
      createdInvoiceIds.push(inv.id);
      return inv;
    };

    // 1) KNJIŽNO ODOBRENJE — vrednosni dokument, dve poreske stope
    const ko = await makeInvoice(
      "IFUSL",
      `${STAMP}-KO`,
      [
        { desc: "Umanjenje po reklamaciji — servo motor SM-400", qty: "1", price: "128450.00", vatPct: 20 },
        { desc: "Naknadno odobren rabat na isporuku 07/2026", qty: "1", price: "45990.50", vatPct: 20 },
        { desc: "Odobrenje za povraćaj ambalaže (niža stopa)", qty: "1", price: "12000.00", vatPct: 10 },
      ],
      { note: "Odobrenje po reklamaciji br. 44/26 od 14.07.2026." },
    );
    let r = await invoicePdf.buildCreditNotePdf(ko.id, "nenad.jarakovic@servoteh.com");
    report("Knjižno odobrenje (3 stavke, 2 stope)", r.buffer, r.fileName);

    // 2) KNJIŽNO ZADUŽENJE
    const kz = await makeInvoice("IFUSL", `${STAMP}-KZ`, [
      { desc: "Naknadno zaduženje — razlika u kursu po ugovoru 12/26", qty: "1", price: "83120.75", vatPct: 20 },
      { desc: "Troškovi vanrednog transporta", qty: "2", price: "19500.00", vatPct: 20 },
    ]);
    r = await invoicePdf.buildDebitNotePdf(kz.id, "nenad.jarakovic@servoteh.com");
    report("Knjižno zaduženje (2 stavke)", r.buffer, r.fileName);

    // 3) AVANSNI RAČUN — naplaćen, sa osnovom avansa
    const avr = await makeInvoice(
      "AVR",
      `${STAMP}-AVR`,
      [{ desc: "Avansna uplata po ugovoru 118/2026", qty: "1", price: "1250000.00", vatPct: 20 }],
      {
        advanceDirection: "out",
        advanceBasis: "Ugovor br. 118/2026 od 01.07.2026.",
        advancePaidAt: new Date(),
        advancePaidAmount: new D("1500000.00"),
      },
    );
    r = await invoicePdf.buildInvoicePdf(avr.id, undefined, "nenad.jarakovic@servoteh.com");
    report("Avansni račun (auto-varijanta iz AVR)", r.buffer, r.fileName);

    // 4) NENAPLAĆEN AVANS — druga grana napomene
    const avr2 = await makeInvoice(
      "AVR",
      `${STAMP}-AVR2`,
      [{ desc: "Avans po predračunu PROF0042/2026", qty: "1", price: "420000.00", vatPct: 20 }],
      { advanceDirection: "out", advanceBasis: "Predračun PROF0042/2026" },
    );
    r = await invoicePdf.buildAdvanceInvoicePdf(avr2.id);
    report("Avansni račun — nenaplaćen", r.buffer, r.fileName);

    // 5) REGRESIJA: običan račun i otpremnica (isti šablon, ne sme da pukne)
    const inv = await makeInvoice("IFR", `${STAMP}-IFR`, [
      { desc: "Reduktor R-125, isporuka po porudžbini 8891", qty: "4", price: "78900.00", vatPct: 20 },
      { desc: "Montaža i puštanje u rad", qty: "16", price: "4500.00", vatPct: 20 },
      { desc: "Rezervni delovi — komplet", qty: "1", price: "26400.00", vatPct: 10 },
    ]);
    r = await invoicePdf.buildInvoicePdf(inv.id, undefined, "nenad.jarakovic@servoteh.com");
    report("Račun (regresija — rekapitulacija PDV)", r.buffer, r.fileName);
    r = await invoicePdf.buildDeliveryNotePdf(inv.id);
    report("Otpremnica (regresija — 3 potpisa)", r.buffer, r.fileName);

    // 6) PRAZAN DOKUMENT — ne sme da pukne
    const empty = await prisma.invoice.create({
      data: {
        documentType: "IFUSL",
        documentNumber: `${STAMP}-PRAZAN`,
        level: 0,
        companyId: company.id,
        customerId: customer.id,
        documentDate: new Date(),
        currency: "RSD",
        status: "CANCELLED",
      },
    });
    createdInvoiceIds.push(empty.id);
    r = await invoicePdf.buildCreditNotePdf(empty.id);
    report("KO bez stavki + značka STORNIRANO", r.buffer, r.fileName);

    // ── BILANSI ────────────────────────────────────────────────────────────
    const bs = await balanceSheet.computeBalanceSheet(TEST_YEAR);
    const bu = await balanceSheet.computeIncomeStatement(TEST_YEAR);
    createdStatementIds.push(bs.id, bu.id);

    // Bez GL istorije za probnu godinu svi iznosi su 0 — to ne dokazuje prelom ni
    // formatiranje hiljada. Zato se probne vrednosti UPISUJU u linije (baza je za
    // resetovanje) i brišu zajedno sa obračunom na kraju.
    for (const st of [bs, bu]) {
      const rows = await prisma.financialStatementLine.findMany({
        where: { statementId: st.id },
        select: { id: true, ordinal: true },
      });
      for (const row of rows) {
        const v = new D(row.ordinal + 1).mul("734512.37").toDecimalPlaces(2);
        await prisma.financialStatementLine.update({
          where: { id: row.id },
          data: { amount: v, amount2: v.mul("0.87"), amount3: v.mul("0.74") },
        });
      }
      lines.push(`  (obračun ${st.statementType}: ${rows.length} AOP pozicija)`);
    }

    r = await statementPdf.buildStatementPdf(bs.id, {
      printedBy: "nenad.jarakovic@servoteh.com",
    });
    report("Bilans stanja (hiljade, 7 kolona)", r.buffer, r.fileName);
    r = await statementPdf.buildStatementPdf(bs.id, { unit: "dinari" });
    report("Bilans stanja (dinari)", r.buffer, `BS-dinari.pdf`);
    r = await statementPdf.buildStatementPdf(bu.id, {
      printedBy: "nenad.jarakovic@servoteh.com",
    });
    report("Bilans uspeha (hiljade, 6 kolona)", r.buffer, r.fileName);
  } finally {
    // ── čišćenje ───────────────────────────────────────────────────────────
    for (const id of createdStatementIds) {
      await prisma.financialStatementLine.deleteMany({ where: { statementId: id } });
      await prisma.financialStatement.delete({ where: { id } }).catch(() => undefined);
    }
    if (createdInvoiceIds.length) {
      await prisma.invoiceItem.deleteMany({
        where: { invoiceId: { in: createdInvoiceIds } },
      });
      await prisma.invoice.deleteMany({ where: { id: { in: createdInvoiceIds } } });
    }
    if (createdCustomerId != null) {
      await prisma.customer.delete({ where: { id: createdCustomerId } }).catch(() => undefined);
    }
    await app.close();
  }

  console.log("\n═══════════ DOKAZ ŠTAMPE: PRODAJA + ZAVRŠNI RAČUN ═══════════");
  console.log(lines.join("\n"));
  console.log(`\n  PDF-ovi: ${OUT_DIR}\n`);
}

main().catch((e) => {
  console.error("SMOKE PAO:", e);
  process.exit(1);
});
