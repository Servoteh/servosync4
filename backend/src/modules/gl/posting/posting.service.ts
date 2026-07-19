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

import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../../prisma/prisma.service";
import { evaluateExpression } from "./expression-parser";
import { prismaDecimalArith } from "./prisma-decimal-arith";

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

/**
 * Stope PDV po `goodsTaxRateCode` (doc 43 §4 R_Tarife: Osnovna=20%/VISA,
 * Zeleznica=10%/NIZA, Posebna=8%/POLJO). Legacy default kod stavke je "3".
 * Efektivna stopa = zbir kolona; ovde sažeto po kodu → 0.20 / 0.10 / 0.08.
 * Nepoznat kod → stopa 0 (PDV linija za taj artikal se ne knjiži) — doc 43 §5
 * disciplina: bez izmišljenih brojki.
 */
const VAT_RATE_BY_CODE: Readonly<Record<string, Prisma.Decimal>> = {
  "3": new D("0.20"), // Osnovna / VISA (20%) — default stavke (doc 43 §4)
  "1": new D("0.20"), // Osnovna (alt kod)
  "2": new D("0.10"), // Zeleznica / NIZA (10%)
  "4": new D("0.08"), // Posebna / POLJO (8%)
  "0": ZERO, // bez PDV (izvoz/oslobođeno)
};

const RATE_VISA = new D("0.20");
const RATE_NIZA = new D("0.10");
const RATE_POLJO = new D("0.08");

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
   * Proknjiži jedan ROBNI dokument (StockDocument) u nalog GK. In-transaction,
   * idempotentno. @returns kreirane LedgerEntry linije (Dnevnik / Kartica konta).
   */
  async postFromStockDocument(docId: number): Promise<LedgerLineDraft[]> {
    return this.prisma.$transaction(async (tx) => {
      // 1) Učitaj robni dokument + stavke + tip dokumenta
      const doc = await tx.stockDocument.findUniqueOrThrow({
        where: { id: docId },
      });
      const items = await tx.stockDocumentItem.findMany({
        where: { documentId: docId },
      });
      const docType = await tx.documentType.findFirstOrThrow({
        where: { code: doc.documentTypeCode },
      });

      // schemeId = postingTemplate (=legacy IDSeme). 0/null → nije za auto-knjiženje.
      const schemeId = docType.postingTemplate ?? 0;
      if (schemeId === 0) throw new NoPostingSchemeException(docId);

      // 2) IDEMPOTENCIJA — status „proknjižen" je IZVEDEN (doc 18 §2.2 t.5).
      //    sourceGoodsDocId je traceback-kolona ka izvornom robnom dokumentu.
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

      // 3) Učitaj šemu (AccountingScheme + linije). id = postingTemplate.
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
  private async nextJournalNumber(
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
