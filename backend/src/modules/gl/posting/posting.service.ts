/**
 * POSTING SERVICE — GL auto-kontiranje ROBNOG dokumenta u nalog (Faza 2/3).
 * =========================================================================
 * Aktivirano iz `posting.service.ts.nacrt`. Modeli JournalEntry/LedgerEntry i
 * StockDocument/StockDocumentItem su ŽIVI u schema.prisma (migrirani na dev).
 * Koristi ŽIVI `evaluateExpression` (safe parser) + ŽIVI `prismaDecimalArith`
 * (Arith<Prisma.Decimal>) + seed-ovane AccountingScheme/AccountingSchemeLine.
 *
 * ⚠️ IZVOR PODATAKA: ISKLJUČIVO `stock_documents` / `stock_document_items`.
 *   `goods_documents` je izbačena iz sync-a (PRAZNA) — NEMA UNION-a. Costing i
 *   posting čitaju samo robne (2.0-native) tabele.
 *
 * TOK (doc 43 §0, doc 18 §2.2, doc 30 §B):
 *   StockDocument.documentTypeCode  ──►  DocumentType.postingTemplate (=IDSeme)
 *     ──►  AccountingScheme (orderType)  ──►  AccountingSchemeLine[] (Konto + DefDug/DefPot nad A–Z)
 *       ──►  za svaku liniju: evaluateExpression(defDebit/defCredit, varMap, prismaDecimalArith)
 *              varMap = agregati A–Z sa StockDocumentItem[] (doc 43 §1, AUTORITATIVNO)
 *         ──►  GROUP BY (konto + komitent), Σ, odbaci nula-redove (legacy 2Korak)
 *           ──►  BALANS: ΣDug == ΣPot, inače LedgerNotBalancedException (rollback)
 *             ──►  INSERT JournalEntry(draft) + LedgerEntry[] (NSK_ProknjiziStavkeIzRobnog)
 *
 * IDEMPOTENCIJA (doc 18 §2.2 t.5: „proknjižen = IZVEDEN, ne flag"):
 *   pre knjiženja proveri postoji li JournalEntry sa sourceGoodsDocId=docId
 *   (kolona-ključ traceback-a ka robnom dokumentu). posted/locked → NE diraj
 *   (AlreadyPostedException). draft → obriši i re-post (cascade briše LedgerEntry).
 */

import { Injectable, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../../prisma/prisma.service";
import { evaluateExpression } from "./expression-parser";
import { prismaDecimalArith } from "./prisma-decimal-arith";
import {
  VAT_RATE_BY_CODE,
  RATE_VISA,
  RATE_NIZA,
  RATE_POLJO,
} from "./vat-rates";

const D = Prisma.Decimal;
const ZERO = new D(0);

// ─────────────────────────────────────────────────────────────────────────────
// Tipizirane domenske greške (BACKEND_RULES §7 — nikad 500 za poslovnu grešku)
// ─────────────────────────────────────────────────────────────────────────────

/** ΣDug ≠ ΣPot — nalog ne balansira. Cela transakcija se odbija. */
export class LedgerNotBalancedException extends Error {
  readonly code = "GL_NOT_BALANCED";
  constructor(
    public readonly totalDebit: Prisma.Decimal,
    public readonly totalCredit: Prisma.Decimal,
  ) {
    super(
      `Nalog ne balansira: ΣDug=${totalDebit.toFixed(4)} ≠ ΣPot=${totalCredit.toFixed(4)}`,
    );
    this.name = "LedgerNotBalancedException";
  }
}

/** Dokument nema posting šablon (postingTemplate 0/null) — nije za auto-knjiženje. */
export class NoPostingSchemeException extends Error {
  readonly code = "GL_NO_SCHEME";
  constructor(public readonly docId: number) {
    super(
      `Robni dokument ${docId}: DocumentType nema posting šablon (postingTemplate 0/null).`,
    );
    this.name = "NoPostingSchemeException";
  }
}

/** Dokument je već proknjižen i nalog je posted/locked — re-post nije dozvoljen. */
export class AlreadyPostedException extends Error {
  readonly code = "GL_ALREADY_POSTED";
  constructor(
    public readonly docId: number,
    public readonly journalEntryId: number,
  ) {
    super(
      `Robni dokument ${docId} je već proknjižen (nalog ${journalEntryId}, posted/locked).`,
    );
    this.name = "AlreadyPostedException";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// A–Z mapiranje (26 kolona) — AUTORITATIVNO iz doc 43 §1 (SK*/USL_*/NSK_* upiti)
// ─────────────────────────────────────────────────────────────────────────────
//
// Redosled (doc 43 §1): NabNetoVred, ZTS, ZTD, PPDOsn, PPDZel, PPDGrad, PPDRat,
//   RZC, KalkVP, RobaOsn, RobaZel, RobaGrad, RobaRat, Taks, StvarnaVP, StRobaOsn,
//   StRobaZel, StRobaGrad, StRobaRat, NivProd, PPDPos, RobaPos, StRobaPos,
//   AvansUkupno, AvansPDVVisa, AvansPDVNiza.
//
//   A NabNetoVred = Σ Kol × nabavna neto cena (ULAZ)                 ← StockDocumentItem
//   B ZTS         = zavisni trošak sopstveni (neoporeziv)
//   C ZTD         = zavisni trošak dobavljača (oporeziv)
//   D PPDOsn      = ULAZNI PDV 20% (pretporez, VISA)
//   E PPDZel      = ULAZNI PDV 10% (NIZA)
//   F,G PPDGrad/Rat = 0 (nasleđe)
//   H RZC         = Σ Kol × (KalkVP − ZTD − ZTS − NabNeto)  (razlika u ceni / RuC)
//   I KalkVP      = Σ Kol × kalkulativna VP cena
//   J,K RobaOsn/Zel = PDV na kalk. VP 20% / 10%
//   L,M RobaGrad/Rat = 0
//   N Taks        = Σ Kol × taksa
//   O StvarnaVP   = neto fakturna vrednost = Fakturna − Rabat − Kasa (IZLAZ)
//   P StRobaOsn   = IZLAZNI PDV 20% (VISA)
//   Q StRobaZel   = IZLAZNI PDV 10% (NIZA)
//   R,S StRobaGrad/Rat = 0
//   T NivProd     = Σ Kol × (StvarnaVP − KalkVP)  (nivelacija)
//   U PPDPos      = ULAZNI PDV 8% (POLJO, posebna)
//   V RobaPos     = PDV na kalk. VP 8%
//   W StRobaPos   = IZLAZNI PDV 8%
//   X AvansUkupno = iskorišćeni avans sa PDV (rupa: nijedna šema, doc 43 §5 → 0)
//   Y AvansPDVVisa= PDV 20% iz avansa (0)
//   Z AvansPDVNiza= PDV 10% iz avansa (0)
//
// Sve su AGREGATI po dokumentu (Σ preko stavki), ne per-item. Slova koja šema
// ne referiše ostaju 0 (parser baca SAMO ako ih izraz referiše — punimo ceo A–Z).

// Stope PDV po `goodsTaxRateCode` (VAT_RATE_BY_CODE, RATE_VISA/NIZA/POLJO) izdvojene u
// `./vat-rates` (C8) — jedan izvor deljen sa robnom kalkulacijom (CalculationService.taxRateOf).

// NIV (nivelacija zaliha) knjiženje — kontni par za revalorizaciju zatečenog stanja (doc 39 §F).
// NIV DocumentType NEMA `postingTemplate` (nula-šema) pa se knjiži ručno preko `postManualEntry`:
//   valueAdjustment > 0 (nova > stara → vrednost zaliha raste): 1320 Duguje, 1329 Potražuje.
//   valueAdjustment < 0 (vrednost pada): obrnuto.
// `NIV_STOCK_ACCOUNT` = konto zaliha robe (isti kao UFROB/IFR/UVOZ šeme, doc 39 §E).
// `NIV_REVALUATION_ACCOUNT` = razlika u ceni robe (protivstavka revalorizacije).
// ⏳ Protivstavka (1329) je predlog — Nesa da potvrdi konto pre produkcije (kao izvod bankAccountCode).
// Postojanje oba konta se proverava pre upisa (jasna 422 umesto opaque FK 500).
const NIV_STOCK_ACCOUNT = "1320";
const NIV_REVALUATION_ACCOUNT = "1329";

type DocVarMap = Record<string, Prisma.Decimal>;

/** Agregati A–Z (Decimal) — doc 43 §1. Slova bez izvora ostaju ZERO. */
interface DocAmounts {
  A: Prisma.Decimal; // NabNetoVred
  B: Prisma.Decimal; // ZTS
  C: Prisma.Decimal; // ZTD
  D: Prisma.Decimal; // PPDOsn (ulazni 20%)
  E: Prisma.Decimal; // PPDZel (ulazni 10%)
  H: Prisma.Decimal; // RZC
  I: Prisma.Decimal; // KalkVP
  J: Prisma.Decimal; // RobaOsn (PDV na kalk VP 20%)
  K: Prisma.Decimal; // RobaZel (PDV na kalk VP 10%)
  N: Prisma.Decimal; // Taks
  O: Prisma.Decimal; // StvarnaVP
  P: Prisma.Decimal; // StRobaOsn (izlazni 20%)
  Q: Prisma.Decimal; // StRobaZel (izlazni 10%)
  T: Prisma.Decimal; // NivProd
  U: Prisma.Decimal; // PPDPos (ulazni 8%)
  V: Prisma.Decimal; // RobaPos (PDV kalk VP 8%)
  W: Prisma.Decimal; // StRobaPos (izlazni 8%)
}

// ─────────────────────────────────────────────────────────────────────────────
// Servis
// ─────────────────────────────────────────────────────────────────────────────

interface LedgerLineDraft {
  accountCode: string;
  analyticalCode: number | null;
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
  description: string | null;
}

@Injectable()
export class PostingEngineService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Generički ručni nalog GK iz proizvoljnih linija (konto/komitent/dug/pot).
   * Za tokove koji NE prolaze kroz šemu za kontiranje: kompenzacija (KMP), izvodi,
   * ručna knjiženja. Balans-kontrola ΣDug=ΣPot (baca `LedgerNotBalancedException`).
   * Poziva se UNUTAR postojeće `$transaction` (prima `tx`) da se veže za izvorni entitet.
   */
  async postManualEntry(
    tx: Prisma.TransactionClient,
    params: {
      orderType: string;
      documentDate: Date;
      companyId?: number;
      description?: string;
      createdByUserId?: number;
      /** Traceback ka izvornom robnom dokumentu (idempotencija za NIV/robno). */
      sourceGoodsDocId?: number;
      lines: Array<{
        accountCode: string;
        analyticalCode?: number | null;
        debit?: number | string;
        credit?: number | string;
        description?: string;
        documentNumber?: string | null;
        dueDate?: Date | null;
        currency?: string | null;
      }>;
    },
  ): Promise<{ journalEntryId: number; number: string; lineCount: number }> {
    const D = Prisma.Decimal;
    const companyId = params.companyId ?? 0;
    const year = params.documentDate.getFullYear();

    // Balans-kontrola (Decimal je egzaktan → tolerancija 0).
    let totalDebit = new D(0);
    let totalCredit = new D(0);
    for (const l of params.lines) {
      totalDebit = totalDebit.plus(new D(l.debit ?? 0));
      totalCredit = totalCredit.plus(new D(l.credit ?? 0));
    }
    if (!totalDebit.equals(totalCredit)) {
      throw new LedgerNotBalancedException(totalDebit, totalCredit);
    }

    const number = await this.nextJournalNumber(
      tx,
      companyId,
      params.orderType,
      year,
    );

    const journal = await tx.journalEntry.create({
      data: {
        number,
        orderTypeCode: params.orderType,
        year,
        companyId,
        documentDate: params.documentDate,
        postingDate: params.documentDate,
        status: "posted",
        sourceGoodsDocId: params.sourceGoodsDocId ?? null,
        createdByUserId: params.createdByUserId ?? null,
        lines: {
          create: params.lines.map((l) => ({
            accountCode: l.accountCode,
            analyticalCode: l.analyticalCode ?? null,
            debit: new D(l.debit ?? 0),
            credit: new D(l.credit ?? 0),
            description: l.description ?? params.description ?? null,
            documentNumber: l.documentNumber ?? null,
            dueDate: l.dueDate ?? null,
            currency: l.currency ?? null,
            sourceGoodsDocId: params.sourceGoodsDocId ?? null,
          })),
        },
      },
    });
    return {
      journalEntryId: journal.id,
      number,
      lineCount: params.lines.length,
    };
  }

  /**
   * Proknjiži jedan ROBNI dokument (StockDocument) u nalog GK. In-transaction,
   * idempotentno. @returns kreirane LedgerEntry linije (Dnevnik / Kartica konta).
   */
  async postFromStockDocument(docId: number): Promise<LedgerLineDraft[]> {
    return this.prisma.$transaction(async (tx) => {
      // TOCTOU: idempotencija je read-then-write (findFirst po sourceGoodsDocId
      // bez unique constrainta — parcijalni unique se ne može izraziti Prismom,
      // schema komentar). Dve paralelne tx bi obe videle null → dupli posted nalog
      // (za NIV = dupla revalorizacija). Serijalizuj po dokumentu xact advisory
      // lock-om (namespace 4001 = „GL posting po robnom dokumentu"); druga tx čeka
      // pa u findFirst vidi postojeći nalog. Lock se pušta na kraju tx automatski.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(4001, ${docId})`;

      // 1) Učitaj robni dokument.
      const doc = await tx.stockDocument.findUniqueOrThrow({
        where: { id: docId },
      });

      // 2) IDEMPOTENCIJA (zajednička za robni i NIV put) — status „proknjižen" je IZVEDEN
      //    (doc 18 §2.2 t.5). sourceGoodsDocId je traceback ka izvornom robnom dokumentu.
      const existing = await tx.journalEntry.findFirst({
        where: { sourceGoodsDocId: docId },
      });
      if (existing) {
        if (existing.status !== "draft") {
          throw new AlreadyPostedException(docId, existing.id);
        }
        // draft → re-post: obriši stari nalog (cascade briše LedgerEntry).
        await tx.journalEntry.delete({ where: { id: existing.id } });
      }

      // NIV (nivelacija) — nema `stock_document_items`; razlika se knjiži iz `stockLevelingItems`
      // (doc 39 §F). Bez ovog grananja NIV bi dobio nula-nalog (defekt B2, C9).
      if (doc.kind === "NIV") {
        return this.postNivLeveling(tx, doc);
      }

      // 3) Robni put — učitaj stavke + tip dokumenta + šemu.
      const items = await tx.stockDocumentItem.findMany({
        where: { documentId: docId },
      });
      const docType = await tx.documentType.findFirstOrThrow({
        where: { code: doc.documentTypeCode },
      });

      // schemeId = postingTemplate (=legacy IDSeme). 0/null → nije za auto-knjiženje.
      const schemeId = docType.postingTemplate ?? 0;
      if (schemeId === 0) throw new NoPostingSchemeException(docId);

      // Učitaj šemu (AccountingScheme + linije). id = postingTemplate.
      const scheme = await tx.accountingScheme.findUniqueOrThrow({
        where: { id: schemeId },
        include: { lines: { orderBy: { lineNo: "asc" } } },
      });

      // 4) varMap A–Z iz agregata robnih stavki (doc 43 §1). Sve već Decimal.
      const amounts = this.aggregateDocAmounts(
        doc,
        items,
        docType.isInbound ?? false,
      );
      const varMap = this.buildDocVarMap(amounts);

      // 5) Za svaku liniju šeme evaluiraj DefDug/DefPot ŽIVIM parserom (Decimal).
      const analyticalCode = doc.supplierId ?? doc.customerId ?? null; // komitent
      const rawLines: LedgerLineDraft[] = [];
      for (const line of scheme.lines) {
        const debit = line.defDebit
          ? evaluateExpression<Prisma.Decimal>(
              line.defDebit,
              varMap,
              prismaDecimalArith,
            )
          : ZERO;
        const credit = line.defCredit
          ? evaluateExpression<Prisma.Decimal>(
              line.defCredit,
              varMap,
              prismaDecimalArith,
            )
          : ZERO;

        rawLines.push({
          accountCode: line.accountCode,
          analyticalCode: line.postsAnalytics ? analyticalCode : null,
          debit,
          credit,
          description: line.description ?? null,
        });
      }

      // 6) GROUP BY (konto + komitent), Σ, odbaci nula-redove (legacy 2Korak).
      const grouped = this.groupByAccountAndPartner(rawLines);

      // 7) BALANS-KONTROLA: ΣDug == ΣPot (Decimal je egzaktan → tolerancija 0).
      let totalDebit = ZERO;
      let totalCredit = ZERO;
      for (const l of grouped) {
        totalDebit = totalDebit.add(l.debit);
        totalCredit = totalCredit.add(l.credit);
      }
      if (!totalDebit.equals(totalCredit)) {
        throw new LedgerNotBalancedException(totalDebit, totalCredit); // rollback tx
      }

      // 8) Kreiraj JournalEntry(draft) + LedgerEntry[] (NSK_ProknjiziStavkeIzRobnog).
      const year = doc.year ?? doc.postingDate.getFullYear();
      const number = await this.nextJournalNumber(
        tx,
        doc.companyId,
        scheme.orderType,
        year,
      );
      const entry = await tx.journalEntry.create({
        data: {
          number,
          orderTypeCode: scheme.orderType,
          year,
          companyId: doc.companyId,
          documentDate: doc.documentDate,
          postingDate: doc.postingDate,
          status: "draft",
          postingSchemeId: scheme.id,
          sourceGoodsDocId: docId,
          lines: {
            create: grouped.map((l) => ({
              accountCode: l.accountCode,
              analyticalCode: l.analyticalCode,
              debit: l.debit,
              credit: l.credit,
              description: l.description,
              sourceGoodsDocId: docId,
              sourceWorkOrderId: doc.workOrderId ?? null,
              sourceProjectId: doc.projectId ?? null,
            })),
          },
        },
        include: { lines: true },
      });

      // Poveži nalog nazad na dokument (meki ref journalEntryId na StockDocument).
      await tx.stockDocument.update({
        where: { id: docId },
        data: { journalEntryId: entry.id },
      });

      return grouped;
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // NIV (nivelacija) knjiženje — iz stockLevelingItems, ne stock_document_items.
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Proknjiži NIV (nivelacioni) dokument u GK (doc 39 §F). NIV nema `stock_document_items`
   * (revalorizuje zatečeno stanje, ne kreira kretanje) — izvor iznosa je `StockLevelingItem`:
   *   `valueAdjustment = quantityRevalued × (newWholesalePrice − oldWholesalePrice)`.
   *
   * NIV `DocumentType` nema `postingTemplate` (nula-šema) → knjiži se ručno preko
   * `postManualEntry` sa kontnim parom zaliha/revalorizacija (v. `NIV_STOCK_ACCOUNT` /
   * `NIV_REVALUATION_ACCOUNT`). Zbir po predznaku daje jednu balansiranu razliku:
   *   Σ valueAdjustment > 0 → 1320 Duguje / 1329 Potražuje (vrednost zaliha raste),
   *   Σ valueAdjustment < 0 → obrnuto.
   *
   * Nalog je odmah `posted` (kao izvod/blagajna) — razlika MORA da stigne u karticu konta/bilans
   * (ne ostaje `draft` nevidljiv, review VISOK). Dokument prelazi u POSTED, stavke `isPosted=true`.
   * Idempotencija je već rešena u pozivaocu (guard po `sourceGoodsDocId`).
   */
  private async postNivLeveling(
    tx: Prisma.TransactionClient,
    doc: {
      id: number;
      companyId: number;
      documentDate: Date;
      createdByUserId: number | null;
    },
  ): Promise<LedgerLineDraft[]> {
    const levelingItems = await tx.stockLevelingItem.findMany({
      where: { documentId: doc.id },
    });
    if (levelingItems.length === 0) {
      throw new UnprocessableEntityException(
        `NIV dokument ${doc.id} nema nivelacionih stavki — nema šta da se knjiži.`,
      );
    }

    // Σ valueAdjustment po predznaku (revalorizacija zatečenog stanja, doc 39 §F).
    let net = ZERO;
    for (const li of levelingItems) net = net.add(li.valueAdjustment);
    if (net.isZero()) {
      throw new UnprocessableEntityException(
        `NIV dokument ${doc.id}: zbir nivelacionih razlika je 0 — nema šta da se knjiži.`,
      );
    }

    // Provera da konta postoje u kontnom planu (jasna 422 umesto opaque FK 500 — izvod obrazac).
    const accountCodes = [NIV_STOCK_ACCOUNT, NIV_REVALUATION_ACCOUNT];
    const present = await tx.account.findMany({
      where: { code: { in: accountCodes } },
      select: { code: true },
    });
    const presentCodes = new Set(present.map((a) => a.code));
    const missing = accountCodes.filter((c) => !presentCodes.has(c));
    if (missing.length) {
      throw new UnprocessableEntityException(
        `Konta za NIV knjiženje nisu u kontnom planu: ${missing.join(", ")}. ` +
          `Definiši konta pre knjiženja nivelacije.`,
      );
    }

    // Balansiran par (apsolutni iznos na odgovarajućoj strani po predznaku razlike).
    const abs = net.abs();
    const stockDebit = net.isPositive() ? abs : ZERO;
    const stockCredit = net.isPositive() ? ZERO : abs;
    const revalDebit = net.isPositive() ? ZERO : abs;
    const revalCredit = net.isPositive() ? abs : ZERO;

    const draftLines: LedgerLineDraft[] = [
      {
        accountCode: NIV_STOCK_ACCOUNT,
        analyticalCode: null,
        debit: stockDebit,
        credit: stockCredit,
        description: "Nivelacija — revalorizacija zaliha",
      },
      {
        accountCode: NIV_REVALUATION_ACCOUNT,
        analyticalCode: null,
        debit: revalDebit,
        credit: revalCredit,
        description: "Nivelacija — razlika u ceni",
      },
    ];

    const posted = await this.postManualEntry(tx, {
      orderType: "NIV",
      documentDate: doc.documentDate,
      companyId: doc.companyId,
      createdByUserId: doc.createdByUserId ?? undefined,
      sourceGoodsDocId: doc.id,
      description: `Nivelacija zaliha (NIV dok. ${doc.id})`,
      lines: draftLines.map((l) => ({
        accountCode: l.accountCode,
        analyticalCode: l.analyticalCode,
        debit: l.debit.toFixed(4),
        credit: l.credit.toFixed(4),
        description: l.description ?? undefined,
      })),
    });

    // Nalog → dokument + status POSTED + isPosted na stavkama (razlika stigla u GK).
    await tx.stockDocument.update({
      where: { id: doc.id },
      data: { journalEntryId: posted.journalEntryId, status: "POSTED" },
    });
    await tx.stockLevelingItem.updateMany({
      where: { documentId: doc.id },
      data: { isPosted: true },
    });

    return draftLines;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // A–Z agregacija sa StockDocumentItem[] (doc 43 §1) — sve Decimal od starta.
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Agregira robne stavke u iznose A–Z (doc 43 §1). StockDocumentItem su Decimal
   * (za razliku od legacy Float goods_document_items) — nema konverzije na granici.
   *
   * Per-JM cene (purchasePriceNet, dependentCostOwn/Supplier, calculatedWholesale,
   * actualWholesale, fee) množe se količinom (Σ Kol × cena) — isti obrazac kao
   * legacy A/H/I/N/O/T formule iz doc 43 §1 (H = Σ Kol × (KalkVP−ZTD−ZTS−Nab)).
   *
   * PDV (D/E/U ulazni, P/Q/W izlazni) = osnovica × stopa po `goodsTaxRateCode`
   * (doc 43 §4). Ulaz/izlaz se bira po DocumentType.isInbound (doc 43 §1: A=ULAZ,
   * O=IZLAZ). J/K/V = PDV na kalk. VP (RobaOsn/Zel/Pos) po istoj stopi.
   */
  private aggregateDocAmounts(
    doc: { isImport: boolean; documentTypeCode: string },
    items: Array<{
      quantity: Prisma.Decimal;
      purchasePriceNet: Prisma.Decimal;
      dependentCostOwn: Prisma.Decimal;
      dependentCostSupplier: Prisma.Decimal;
      calculatedWholesalePrice: Prisma.Decimal;
      actualWholesalePrice: Prisma.Decimal;
      fee: Prisma.Decimal;
      goodsTaxRateCode: string;
    }>,
    isInbound: boolean,
  ): DocAmounts {
    let A = ZERO; // NabNetoVred = Σ Kol × purchasePriceNet
    let B = ZERO; // ZTS        = Σ Kol × dependentCostOwn
    let C = ZERO; // ZTD        = Σ Kol × dependentCostSupplier
    let H = ZERO; // RZC        = Σ Kol × (KalkVP − ZTD − ZTS − NabNeto)
    let I = ZERO; // KalkVP     = Σ Kol × calculatedWholesalePrice
    let N = ZERO; // Taks       = Σ Kol × fee
    let O = ZERO; // StvarnaVP  = Σ Kol × actualWholesalePrice
    let T = ZERO; // NivProd    = Σ Kol × (actualWholesalePrice − calculatedWholesalePrice)

    let D_ = ZERO; // ulazni PDV 20% (osnovica = A+B+C, doc 43 §2 UFROB: D nad A+B+C)
    let E = ZERO; // ulazni PDV 10%
    let U = ZERO; // ulazni PDV 8%
    let P = ZERO; // izlazni PDV 20% (osnovica = O)
    let Q = ZERO; // izlazni PDV 10%
    let W = ZERO; // izlazni PDV 8%
    let J = ZERO; // PDV na kalk. VP 20%
    let K = ZERO; // PDV na kalk. VP 10%
    let V = ZERO; // PDV na kalk. VP 8%

    for (const it of items) {
      const qty = it.quantity;
      const nab = qty.mul(it.purchasePriceNet); // A-part
      const zts = qty.mul(it.dependentCostOwn); // B-part
      const ztd = qty.mul(it.dependentCostSupplier); // C-part
      const kalkVp = qty.mul(it.calculatedWholesalePrice); // I-part
      const stvarnaVp = qty.mul(it.actualWholesalePrice); // O-part
      const taks = qty.mul(it.fee); // N-part

      A = A.add(nab);
      B = B.add(zts);
      C = C.add(ztd);
      I = I.add(kalkVp);
      O = O.add(stvarnaVp);
      N = N.add(taks);
      // H = Σ Kol × (KalkVP − ZTD − ZTS − NabNeto) = kalkVp − ztd − zts − nab
      H = H.add(kalkVp.sub(ztd).sub(zts).sub(nab));
      // T = Σ Kol × (StvarnaVP − KalkVP)
      T = T.add(stvarnaVp.sub(kalkVp));

      const rate = VAT_RATE_BY_CODE[it.goodsTaxRateCode] ?? ZERO;
      // Osnovica ulaza po legacy šemi = nabavna + zavisni (A+B+C dela ove stavke).
      const inBase = nab.add(zts).add(ztd);
      const inVat = inBase.mul(rate);
      const outVat = stvarnaVp.mul(rate);
      const kalkVat = kalkVp.mul(rate);
      if (rate.equals(RATE_VISA)) {
        D_ = D_.add(inVat);
        P = P.add(outVat);
        J = J.add(kalkVat);
      } else if (rate.equals(RATE_NIZA)) {
        E = E.add(inVat);
        Q = Q.add(outVat);
        K = K.add(kalkVat);
      } else if (rate.equals(RATE_POLJO)) {
        U = U.add(inVat);
        W = W.add(outVat);
        V = V.add(kalkVat);
      }
      // rate 0 (izvoz/oslobođeno) → bez PDV komponente (doc 43 §2 IZVRO/IZVGP).
    }

    // Za čisto ULAZNE dokumente izlazni PDV nema smisla i obratno; legacy šeme
    // ionako referišu samo relevantna slova (UFROB → D/E, IFR → O/P/Q), pa
    // nekorišćena strana ostaje neupotrebljena u izrazu. Zadržavamo obe računate
    // vrednosti — parser uzima samo ono što DefDug/DefPot referišu.
    void isInbound;

    return { A, B, C, D: D_, E, H, I, J, K, N, O, P, Q, T, U, V, W };
  }

  /** Mapiraj agregate A–Z u varMap; slova bez izvora = ZERO (doc 43 §1/§5). */
  private buildDocVarMap(a: DocAmounts): DocVarMap {
    return {
      A: a.A,
      B: a.B,
      C: a.C,
      D: a.D,
      E: a.E,
      F: ZERO, // PPDGrad (nasleđe, 0)
      G: ZERO, // PPDRat  (nasleđe, 0)
      H: a.H,
      I: a.I,
      J: a.J,
      K: a.K,
      L: ZERO, // RobaGrad (0)
      M: ZERO, // RobaRat  (0)
      N: a.N,
      O: a.O,
      P: a.P,
      Q: a.Q,
      R: ZERO, // StRobaGrad (0)
      S: ZERO, // StRobaRat  (0)
      T: a.T,
      U: a.U,
      V: a.V,
      W: a.W,
      // Avans (X/Y/Z) — nijedna šema ne koristi (doc 43 §5), ide preko posebnih
      // PDV_Obracun_*_ZaAvansneRacune upita. Do dovlačenja tela → 0.
      X: ZERO,
      Y: ZERO,
      Z: ZERO,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // GROUP BY (konto + komitent) → Σ, odbaci nula-redove (legacy 2Korak, doc 43).
  // ───────────────────────────────────────────────────────────────────────────
  private groupByAccountAndPartner(
    lines: LedgerLineDraft[],
  ): LedgerLineDraft[] {
    const map = new Map<string, LedgerLineDraft>();
    for (const l of lines) {
      const key = `${l.accountCode}|${l.analyticalCode ?? ""}`;
      const cur = map.get(key);
      if (cur) {
        cur.debit = cur.debit.add(l.debit);
        cur.credit = cur.credit.add(l.credit);
      } else {
        map.set(key, { ...l });
      }
    }
    // odbaci redove gde su i dug i pot nula (legacy „odbaci nula-redove")
    return [...map.values()].filter(
      (l) => !(l.debit.isZero() && l.credit.isZero()),
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Numeracija naloga: 1 + MAX po (company, vrsta, godina), zero-pad 4.
  // pg_advisory_xact_lock da paralelni post ne dobiju isti broj (doc 30 §D).
  // ───────────────────────────────────────────────────────────────────────────
  /** Sledeći broj naloga (company, vrsta, godina) — public za GlWriteService (storno). */
  async nextJournalNumber(
    tx: Prisma.TransactionClient,
    companyId: number,
    orderType: string,
    year: number,
  ): Promise<string> {
    const lockKey = `${companyId}:${orderType}:${year}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
    const last = await tx.journalEntry.findFirst({
      where: { companyId, orderTypeCode: orderType, year },
      orderBy: { number: "desc" },
      select: { number: true },
    });
    const next = (last ? parseInt(last.number, 10) : 0) + 1;
    return String(next).padStart(4, "0");
  }
}
