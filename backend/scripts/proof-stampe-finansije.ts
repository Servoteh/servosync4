/**
 * DOKAZ ŠTAMPE — grupa „Finansije i saldakonti" (dev baza).
 * =========================================================================
 * Zasejava minimalan, ali PUN skup dokumenata (firma, komitent, kontni plan,
 * saldakonto registar, nalozi GK sa stavkama, bankovni izvod sa stavkama,
 * kompenzacija sa obe strane), pa kroz STVARNE servise generiše svih 8 PDF-ova
 * grupe i ispisuje broj bajtova. Na kraju BRIŠE sve što je zasejao.
 *
 * Ne koristi HTTP i ne diže ceo AppModule — servisi se instanciraju direktno
 * (PrismaService + PdfService), pa je pokretanje nezavisno od ostalih modula.
 *
 * Pokretanje (iz backend/):
 *   npx ts-node --transpile-only scripts/proof-stampe-finansije.ts
 * Izlaz PDF-ova: `backend/reports/stampe-finansije/` (gitignored).
 */

import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

// DEV baza iz .env.dev (bez `?schema=public`) — MORA pre uvoza Prisma klijenta.
const envPath = join(__dirname, "..", ".env.dev");
const devUrl = readFileSync(envPath, "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
if (!devUrl) throw new Error("DATABASE_URL nije nađen u backend/.env.dev");
process.env.DATABASE_URL = devUrl.replace("?schema=public", "");

/* eslint-disable import/first */
import { Prisma } from "@prisma/client";
import { PrismaService } from "../src/prisma/prisma.service";
import { PdfService } from "../src/modules/documents/pdf.service";
import { JournalPrintService } from "../src/modules/gl/journal-print.service";
import { JournalBookPrintService } from "../src/modules/gl/print/journal-book-print.service";
import { AccountCardPrintService } from "../src/modules/gl/print/account-card-print.service";
import { TrialBalancePrintService } from "../src/modules/gl/print/trial-balance-print.service";
import { BankStatementPrintService } from "../src/modules/izvodi/bank-statement-print.service";
import { CompensationPdfService } from "../src/modules/saldakonti/compensation-pdf.service";
import { DunningPdfService } from "../src/modules/saldakonti/dunning-pdf.service";
import { PartnerCardService } from "../src/modules/saldakonti/partner-card.service";
import { OpenItemsService } from "../src/modules/saldakonti/open-items.service";
/* eslint-enable import/first */

const D = Prisma.Decimal;
const OUT_DIR = join(__dirname, "..", "reports", "stampe-finansije");
const YEAR = 2026;
const MARK = "ZZPROOF";

const results: Array<{ doc: string; file: string; bytes: number }> = [];

async function emit(
  doc: string,
  run: () => Promise<{ buffer: Buffer; fileName: string }>,
): Promise<void> {
  const { buffer, fileName } = await run();
  writeFileSync(join(OUT_DIR, fileName), buffer);
  results.push({ doc, file: fileName, bytes: buffer.length });
  console.log(`  OK  ${doc.padEnd(34)} ${String(buffer.length).padStart(7)} B   ${fileName}`);
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });

  const prisma = new PrismaService();
  await prisma.$connect();
  const pdf = new PdfService();

  const journalPrint = new JournalPrintService(prisma, pdf);
  const journalBook = new JournalBookPrintService(prisma, pdf);
  const accountCard = new AccountCardPrintService(prisma, pdf);
  const trialBalance = new TrialBalancePrintService(prisma, pdf);
  const statementPrint = new BankStatementPrintService(prisma, pdf);
  const compensationPdf = new CompensationPdfService(prisma, pdf);
  const dunningPdf = new DunningPdfService(prisma, pdf, new OpenItemsService(prisma));
  const partnerCard = new PartnerCardService(prisma, pdf);

  // ─────────────────────────────────────────────── zasejavanje
  const createdAccounts: string[] = [];
  const createdSaldakonto: string[] = [];
  const createdOrderTypes: string[] = [];
  let createdCompanyId: number | null = null;
  let customerId = 0;
  let statementId = 0;
  let compensationId = 0;
  let invoiceEntryId = 0;
  const journalIds: number[] = [];

  const ACCOUNTS: Array<[string, string, number, boolean]> = [
    ["2040", "Kupci u zemlji", 2, true],
    ["4350", "Dobavljači u zemlji", 4, true],
    ["2410", "Tekući račun", 2, false],
    ["5130", "Troškovi materijala", 5, false],
    ["6120", "Prihodi od prodaje robe", 6, false],
  ];

  try {
    // firma
    const company = await prisma.company.findFirst({ orderBy: { id: "asc" } });
    if (!company) {
      const created = await prisma.company.create({
        data: {
          id: 999,
          companyName: `${MARK} Servoteh d.o.o.`,
          address: "Vojvođanska 297",
          city: "Dobanovci",
          taxId: "101017443",
          registrationNumber: "17400169",
          bankAccount: "160-0000000000000-00",
          phone: "011/000-000",
          email: "office@servoteh.com",
        },
      });
      createdCompanyId = created.id;
    }

    // kontni plan + saldakonto registar
    for (const [code, name, cls, analytics] of ACCOUNTS) {
      const existing = await prisma.account.findUnique({ where: { code } });
      if (!existing) {
        await prisma.account.create({
          data: { code, name, accountClass: cls, allowsAnalytics: analytics },
        });
        createdAccounts.push(code);
      }
    }
    for (const [code, side, control, scope] of [
      ["2040", "receivable", "204", "customer"],
      ["4350", "payable", "435", "supplier"],
    ] as const) {
      const existing = await prisma.saldakontoAccount.findUnique({ where: { account: code } });
      if (!existing) {
        await prisma.saldakontoAccount.create({
          data: {
            account: code,
            side,
            controlAccount: control,
            partnerScope: scope,
            tracksOpenItems: true,
          },
        });
        createdSaldakonto.push(code);
      }
    }
    for (const [code, desc] of [
      ["PS", "Početno stanje"],
      ["IFR", "Izlazna faktura roba"],
      ["ULR", "Ulazni račun"],
      ["KMP", "Kompenzacija"],
    ] as const) {
      const existing = await prisma.orderType.findUnique({ where: { code } });
      if (!existing) {
        await prisma.orderType.create({ data: { code, description: desc } });
        createdOrderTypes.push(code);
      }
    }

    // komitent
    const customer = await prisma.customer.create({
      data: {
        name: `${MARK} Metalprodukt d.o.o.`,
        taxId: "100200300",
        registrationNumber: "20123456",
        address: "Karađorđeva 118",
        postalCode: "11000",
        city: "Beograd",
        email: "finansije@primer.rs",
        phone: "011/123-4567",
        salespersonId: null,
        driverId: null,
        paymentAccountId: null,
        codeTypeCode: null,
        bankAccount1: "205-1234567890-11",
      },
    });
    customerId = customer.id;

    const mkEntry = async (
      number: string,
      orderType: string,
      docDate: Date,
      lines: Array<{
        accountCode: string;
        analyticalCode?: number | null;
        debit?: string;
        credit?: string;
        description: string;
        documentNumber?: string | null;
        dueDate?: Date | null;
      }>,
    ) => {
      const entry = await prisma.journalEntry.create({
        data: {
          number,
          orderTypeCode: orderType,
          year: YEAR,
          companyId: 0,
          documentDate: docDate,
          postingDate: docDate,
          status: "POSTED",
          lines: {
            create: lines.map((l) => ({
              accountCode: l.accountCode,
              analyticalCode: l.analyticalCode ?? null,
              debit: new D(l.debit ?? "0"),
              credit: new D(l.credit ?? "0"),
              description: l.description,
              documentNumber: l.documentNumber ?? null,
              dueDate: l.dueDate ?? null,
            })),
          },
        },
      });
      journalIds.push(entry.id);
      return entry;
    };

    await mkEntry("9001", "PS", new Date(Date.UTC(YEAR, 0, 1)), [
      {
        accountCode: "2040",
        analyticalCode: customerId,
        debit: "250000",
        description: "Početno stanje kupca",
        documentNumber: `${MARK}-PS-2040`,
      },
      {
        accountCode: "4350",
        analyticalCode: customerId,
        credit: "250000",
        description: "Početno stanje dobavljača",
        documentNumber: `${MARK}-PS-4350`,
      },
    ]);

    const invoice = await mkEntry("9002", "IFR", new Date(Date.UTC(YEAR, 2, 14)), [
      {
        accountCode: "2040",
        analyticalCode: customerId,
        debit: "1234567.89",
        description: "Faktura za isporučenu robu",
        documentNumber: `${MARK}-IFR-0001/${YEAR}`,
        dueDate: new Date(Date.UTC(YEAR, 3, 13)),
      },
      {
        accountCode: "6120",
        credit: "1234567.89",
        description: "Prihod od prodaje robe",
        documentNumber: `${MARK}-IFR-0001/${YEAR}`,
      },
    ]);
    invoiceEntryId = invoice.id;

    await mkEntry("9003", "ULR", new Date(Date.UTC(YEAR, 3, 2)), [
      {
        accountCode: "5130",
        debit: "480000",
        description: "Nabavka materijala",
        documentNumber: `${MARK}-UF-0007`,
      },
      {
        accountCode: "4350",
        analyticalCode: customerId,
        credit: "480000",
        description: "Obaveza prema dobavljaču",
        documentNumber: `${MARK}-UF-0007`,
        dueDate: new Date(Date.UTC(YEAR, 4, 2)),
      },
    ]);

    // bankovni izvod sa stavkama
    const statement = await prisma.bankStatement.create({
      data: {
        bankAccount: "160-0000000000000-00",
        statementNumber: `${MARK}-042`,
        statementDate: new Date(Date.UTC(YEAR, 3, 15)),
        status: "IMPORTED",
        currency: "RSD",
        openingBalance: new D("1500000"),
        closingBalance: new D("2154567.89"),
        importedFileName: `${MARK}-izvod-042.txt`,
        lines: {
          create: [
            {
              lineNo: 1,
              partnerName: `${MARK} Metalprodukt d.o.o.`,
              partnerAccount: "205-1234567890-11",
              amount: new D("1234567.89"),
              direction: "CREDIT",
              referenceNumber: "97 12-3456",
              documentDate: new Date(Date.UTC(YEAR, 3, 15)),
              matchedCustomerId: customerId,
              status: "MATCHED",
            },
            {
              lineNo: 2,
              partnerName: "Elektrodistribucija",
              partnerAccount: "160-9999999999999-88",
              amount: new D("85000"),
              direction: "DEBIT",
              referenceNumber: "97 55-1122",
              documentDate: new Date(Date.UTC(YEAR, 3, 15)),
              status: "UNMATCHED",
            },
            {
              lineNo: 3,
              partnerName: "Poreska uprava",
              partnerAccount: "840-0000000000000-11",
              amount: new D("495000"),
              direction: "DEBIT",
              referenceNumber: "97 41-0001",
              documentDate: new Date(Date.UTC(YEAR, 3, 15)),
              status: "UNMATCHED",
            },
          ],
        },
      },
    });
    statementId = statement.id;

    // kompenzacija sa obe strane
    const recLine = await prisma.ledgerEntry.findFirst({
      where: { journalEntryId: invoiceEntryId, accountCode: "2040" },
      select: { id: true },
    });
    const payLine = await prisma.ledgerEntry.findFirst({
      where: { accountCode: "4350", documentNumber: `${MARK}-UF-0007` },
      select: { id: true },
    });
    const comp = await prisma.compensationOrder.create({
      data: {
        partnerId: customerId,
        compensationNumber: `${MARK}-0001/${YEAR}`,
        date: new Date(Date.UTC(YEAR, 4, 10)),
        status: "POSTED",
        totalAmount: new D("480000"),
        lines: {
          create: [
            { ledgerEntryId: recLine?.id ?? null, side: "receivable", amount: new D("480000"), lineNo: 1 },
            { ledgerEntryId: payLine?.id ?? null, side: "payable", amount: new D("480000"), lineNo: 2 },
          ],
        },
      },
    });
    compensationId = comp.id;

    // ───────────────────────────────────────────── generisanje
    console.log("\nDOKAZ — generisani PDF-ovi (grupa Finansije i saldakonti):\n");

    await emit("Nalog za knjiženje", () => journalPrint.buildJournalPdf(invoiceEntryId));
    await emit("Dnevnik knjiženja", () =>
      journalBook.buildJournalBookPdf({ year: YEAR, printedBy: "dokaz@servoteh.com" }),
    );
    await emit("Kartica konta 2040", () =>
      accountCard.buildAccountCardPdf({ accountCode: "2040", printedBy: "dokaz@servoteh.com" }),
    );
    await emit("Bruto bilans", () =>
      trialBalance.buildTrialBalancePdf({ year: YEAR, printedBy: "dokaz@servoteh.com" }),
    );
    await emit("Bankovni izvod", () =>
      statementPrint.buildStatementPdf(statementId, "dokaz@servoteh.com"),
    );
    await emit("Izjava o kompenzaciji", () =>
      compensationPdf.buildCompensationPdf(compensationId, "dokaz@servoteh.com"),
    );
    await emit("Opomena (nivo 2)", () =>
      dunningPdf.buildDunningPdf(customerId, 2, new Date(Date.UTC(YEAR, 5, 30))),
    );
    await emit("Kartica komitenta", () =>
      partnerCard.buildPartnerCardPdf(customerId, undefined, undefined, undefined),
    );

    // prazan slučaj — ne sme da pukne
    console.log("\nPRAZAN DOKUMENT (bez stavki) — ne sme da pukne:\n");
    await emit("Bruto bilans (godina bez prometa)", () =>
      trialBalance.buildTrialBalancePdf({ year: 1999 }),
    );
    await emit("Kartica konta (nepostojeći konto)", () =>
      accountCard.buildAccountCardPdf({ accountCode: "9999" }),
    );
    await emit("Dnevnik (period bez naloga)", () =>
      journalBook.buildJournalBookPdf({
        year: 1999,
        from: new Date(Date.UTC(1999, 0, 1)),
        to: new Date(Date.UTC(1999, 11, 31)),
      }),
    );
  } finally {
    // ───────────────────────────────────────────── čišćenje
    console.log("\nČišćenje zasejanih podataka…");
    if (compensationId) {
      await prisma.compensationOrder.delete({ where: { id: compensationId } }).catch(() => {});
    }
    if (statementId) {
      await prisma.bankStatement.delete({ where: { id: statementId } }).catch(() => {});
    }
    for (const id of journalIds) {
      await prisma.journalEntry.delete({ where: { id } }).catch(() => {});
    }
    if (customerId) {
      await prisma.customer.delete({ where: { id: customerId } }).catch(() => {});
    }
    for (const code of createdSaldakonto) {
      await prisma.saldakontoAccount.delete({ where: { account: code } }).catch(() => {});
    }
    for (const code of createdAccounts) {
      await prisma.account.delete({ where: { code } }).catch(() => {});
    }
    for (const code of createdOrderTypes) {
      await prisma.orderType.delete({ where: { code } }).catch(() => {});
    }
    if (createdCompanyId != null) {
      await prisma.company.delete({ where: { id: createdCompanyId } }).catch(() => {});
    }
    const leftovers = await prisma.customer.count({ where: { name: { startsWith: MARK } } });
    console.log(`Preostalo probnih komitenata: ${leftovers} (očekivano 0)`);
    await prisma.$disconnect();
  }

  console.log("\nSAŽETAK:");
  for (const r of results) console.log(`  ${r.doc}: ${r.bytes} B (${r.file})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
