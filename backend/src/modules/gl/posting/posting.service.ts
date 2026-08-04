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

import { businessYear } from "../../../common/business-date";
import {
  ConflictException,
  Injectable,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../../prisma/prisma.service";
import { evaluateExpression } from "./expression-parser";
import { prismaDecimalArith } from "./prisma-decimal-arith";
import {
  VAT_RATE_BY_CODE,
  RATE_VISA,
  RATE_NIZA,
  RATE_POLJO,
  unknownVatCodeMessage,
} from "./vat-rates";

const D = Prisma.Decimal;
const ZERO = new D(0);

// ─────────────────────────────────────────────────────────────────────────────
// Tipizirane domenske greške (BACKEND_RULES §7 — nikad 500 za poslovnu grešku)
// ─────────────────────────────────────────────────────────────────────────────
//
// ZAŠTO NASLEĐUJU `HttpException`, a ne goli `Error` (ispravka 04.08.2026):
//   `AllExceptionsFilter` (common/http-exception.filter.ts) propušta ISKLJUČIVO
//   `HttpException`; sve ostalo namerno postaje 500 sa generičkom porukom
//   („Neočekivana greška na serveru. Prijavi administratoru šifru greške.") da se ne
//   cure detalji šeme iz Prisma/SQL grešaka. Dok su ove tri klase nasleđivale `Error`,
//   njihove TAČNE srpske poruke nikad nisu stizale do knjigovođe — on je za
//   nebalansiran nalog dobijao „Internal server error" i šifru za administratora,
//   umesto „Nalog ne balansira: ΣDug=… ≠ ΣPot=…".
//
// OBLIK TELA: `{ message, code, details }` — isti kao kod sveže pisanih domenskih
//   grešaka u repou (`saldakonti/compensation-entry-guard.ts`, `pdv/vat-sanity.ts`).
//   `details` je mašinski čitljiv pa front može da obeleži TAČAN dokument/nalog, a ne
//   samo da ispiše tekst. Novčani iznosi u `details` idu kao string (`toFixed(4)`) —
//   nikad Float (BACKEND_RULES §2).
//
// `instanceof` OSTAJE ISPRAVAN: `year-open.service.ts` hvata
//   `LedgerNotBalancedException` i prevodi je u sopstvenu 422 sa kontekstom prenosa
//   godine (bogatija poruka za taj tok) — ta grana radi nepromenjeno.

/**
 * ΣDug ≠ ΣPot — nalog ne balansira. Cela transakcija se odbija.
 *
 * 422 (ne 400): zahtev je sintaksno besprekoran — svaka linija ima ispravan konto i
 * iznos; nevalidna je POSLOVNA celina koju čine, jer dvojno knjigovodstvo zahteva
 * ΣDug = ΣPot. Ni 409 nije tačan: ništa se nije promenilo pod nama i ponavljanje
 * istog zahteva ne pomaže — iznosi se moraju ispraviti.
 */
export class LedgerNotBalancedException extends UnprocessableEntityException {
  readonly code = "GL_NOT_BALANCED";
  constructor(
    public readonly totalDebit: Prisma.Decimal,
    public readonly totalCredit: Prisma.Decimal,
  ) {
    super({
      message: `Nalog ne balansira: ΣDug=${totalDebit.toFixed(4)} ≠ ΣPot=${totalCredit.toFixed(4)}`,
      code: "GL_NOT_BALANCED",
      details: {
        totalDebit: totalDebit.toFixed(4),
        totalCredit: totalCredit.toFixed(4),
        difference: totalDebit.minus(totalCredit).toFixed(4),
      },
    });
    this.name = "LedgerNotBalancedException";
  }
}

/**
 * Dokument nema posting šablon (postingTemplate 0/null) — nije za auto-knjiženje.
 *
 * 422: fali KONFIGURACIJA (šema kontiranja za tu vrstu dokumenta u
 * `DocumentType.postingTemplate`), pa se ispravan zahtev nad postojećim dokumentom ne
 * može obraditi dok administrator ne veže šemu. Namerno NIJE 404 — dokument JESTE tu,
 * 404 bi korisnika poslao da traži dokument koji postoji.
 */
export class NoPostingSchemeException extends UnprocessableEntityException {
  readonly code = "GL_NO_SCHEME";
  constructor(public readonly docId: number) {
    super({
      message: `Robni dokument ${docId}: DocumentType nema posting šablon (postingTemplate 0/null).`,
      code: "GL_NO_SCHEME",
      details: { docId },
    });
    this.name = "NoPostingSchemeException";
  }
}

/**
 * Dokument je već proknjižen i nalog je posted/locked — re-post nije dozvoljen.
 *
 * 409 (ne 422): ulaz je besprekoran — ne poklapa se STANJE SISTEMA sa onim što
 * pozivalac pretpostavlja (posao je već obavljen, moguće iz druge sesije; guard stoji
 * pod advisory lock-om upravo zbog paralelnih zahteva). Korisnik treba da OSVEŽI i
 * otvori postojeći nalog, ne da menja podatke — a to je tačno ono što 409 kaže.
 * `details.journalEntryId` daje frontu nalog na koji vodi link.
 */
export class AlreadyPostedException extends ConflictException {
  readonly code = "GL_ALREADY_POSTED";
  constructor(
    public readonly docId: number,
    public readonly journalEntryId: number,
  ) {
    super({
      message: `Robni dokument ${docId} je već proknjižen (nalog ${journalEntryId}, posted/locked).`,
      code: "GL_ALREADY_POSTED",
      details: { docId, journalEntryId },
    });
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

// NIV (nivelacija zaliha) — SE NE KNJIŽI U GLAVNU KNJIGU (paritet sa BigBit-om).
// Ranije je ovde stajao kontni par 1320/1329 (revalorizacija zatečenog stanja). Uklonjen je
// na osnovu studije BigBit-a nad produkcijskom bazom (BIGBIT_KONTA_I_SEME_KNJIZENJA.md §6.9),
// potvrđene i direktno u `_legacy/BigbitRaznoNenad/BB_T_25.MDB`:
//   1) `R_Vrste dokumenata` za `NIV`: Sema za kontiranje = 0, Knjiziti sintetiku = 0,
//      Knjiziti analitiku = 0, KnjizitiUPDVEvidenciju = 0, UticeNaZalihe = 1;
//   2) među 30 šema kontiranja NIJEDNA nema `Vrsta naloga = 'NIV'`;
//   3) konto `1329` uopšte ne postoji u BigBit kontnom planu (grupa 132 ima samo 132/1320/1321),
//      i nema nijednu stavku u glavnoj knjizi — bio je naša izmišljotina.
// Uz to su sva tri magacina `Magacini.ProsecneCene = 1` → zalihe se vode po PROSEČNIM nabavnim
// cenama, bez ukalkulisane razlike u ceni, pa RUC konto ovde nema ekonomskog smisla.
//
// Zašto je knjiženje bilo i suštinski pogrešno, ne samo neparitetno: nivelacija je preraspodela
// vrednosti unutar istog konta zaliha, ne nova vrednost. Primer — stanje 10 kom × 100 = 1.000,
// ulaz 10 kom × 200 = 2.000; posle ulaza GK zaliha = 3.000 (ulaz je već proknjižen svojom šemom).
// novaVP = 150, `valueAdjustment` na zatečenom stanju = 10 × (150 − 100) = +500, ali je isti taj
// iznos implicitno NEGATIVAN na novoprimljenoj količini: 10 × (150 − 200) = −500. Zbir je 0.
// Knjiženje samo `valueAdjustment`-a naduvavalo bi konto zaliha za 500 i trajno ga razilazilo sa
// stvarnom vrednošću magacina. Nivelacija zato ostaje ISKLJUČIVO robni događaj (ItemValuation +
// KEPU); u finansijsko ulazi posredno, kroz nabavnu vrednost prodate robe pri sledećoj prodaji.

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
    const year = businessYear(params.documentDate);

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
        status: "POSTED",
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
      // schema komentar). Dve paralelne tx bi obe videle null → dupli posted nalog.
      // Serijalizuj po dokumentu xact advisory
      // lock-om (namespace 4001 = „GL posting po robnom dokumentu"); druga tx čeka
      // pa u findFirst vidi postojeći nalog. Lock se pušta na kraju tx automatski.
      // ::int kastovi su OBAVEZNI: Prisma vezuje brojeve kao bigint, a Postgres
      // ima samo pg_advisory_xact_lock(bigint) i (int, int) — bez kasta dvoargumentni
      // poziv ne razrešava nijednu funkciju i baca 42883 na pravoj bazi (unit testovi
      // to ne hvataju jer ne diraju Postgres). Nađeno dev smoke-om, Batch C.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(4001::int, ${docId}::int)`;

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
        if (existing.status !== "DRAFT") {
          throw new AlreadyPostedException(docId, existing.id);
        }
        // draft → re-post: obriši stari nalog (cascade briše LedgerEntry).
        await tx.journalEntry.delete({ where: { id: existing.id } });
      }

      // NIV (nivelacija) — nema `stock_document_items` i NE ide u GK (BigBit paritet, v. blok
      // komentara iznad servisa). Grananje ostaje da NIV ne bi upao u put šeme i dobio nula-nalog
      // ili `NoPostingSchemeException`; `postNivLeveling` samo zatvori dokument.
      if (doc.kind === "NIV") {
        return this.postNivLeveling(tx, doc);
      }

      // 3) Robni put — učitaj stavke + tip dokumenta + šemu.
      // Soft-delete (Batch B): meko-obrisana stavka (deletedAt) NE ulazi u GK nalog.
      const items = await tx.stockDocumentItem.findMany({
        where: { documentId: docId, deletedAt: null },
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
      const year = doc.year ?? businessYear(doc.postingDate);
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
          status: "DRAFT",
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

      // Poveži nalog nazad na dokument + status POSTED (DB-067: „proknjižen" je do
      // sada bio izveden SAMO iz journalEntryId, pa su čitaoci koji filtriraju po
      // statusu promašivali robne proknjižene dokumente — NIV put status već postavlja).
      await tx.stockDocument.update({
        where: { id: docId },
        data: { journalEntryId: entry.id, status: "POSTED" },
      });

      return grouped;
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // NIV (nivelacija) — zatvaranje dokumenta BEZ naloga GK (BigBit paritet).
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Zatvori NIV (nivelacioni) dokument. **Ne kreira nalog GK niti ijednu stavku glavne knjige** —
   * obrazloženje i dokazi su u NIV bloku komentara na vrhu fajla (BigBit `NIV` nema šemu
   * kontiranja, konto 1329 je bio naša izmišljotina, a `valueAdjustment` se ekonomski poništava
   * sa suprotnim prilagođenjem na novoprimljenoj količini).
   *
   * Put namerno OSTAJE i namerno NE BACA: `POST /robno/documents/:id/post` nad NIV dokumentom mora
   * da prođe kao i do sada (pozivaoci: `robno.controller.post`, koji odmah posle piše KEPU). Zato:
   *   • dokument prelazi u `POSTED` (= „obrađen/zaključen"); `journalEntryId` ostaje `null`.
   *     Status MORA da izađe iz `DRAFT` — `RobnoService.rebuildKepu` uzima samo `status <> 'DRAFT'`,
   *     pa bi NIV inače nestao iz KEPU knjige pri ponovnoj izgradnji;
   *   • `stockLevelingItem.isPosted = true` = „nivelacija obrađena" (cene su već upisane u
   *     `ItemValuation` u `NivelacijaService`); polje NEMA više značenje „proknjiženo u GK";
   *   • povratna vrednost je prazan niz — kontroler prijavljuje `ledgerLines: 0`.
   * Nekadašnje 422 provere „net = 0" i „postojanje konta 1320/1329" su uklonjene: postojale su
   * samo da zaštite knjiženje kojeg više nema. Provera „nema nivelacionih stavki" je VRAĆENA —
   * ona je štitila i sam prelaz statusa: NIV bez stavki bi inače tiho prešao u POSTED (0 GK
   * linija, 0 KEPU redova, odgovor `posted: true`), postao nepromenjiv (assertItemMutable) i bez
   * ijedne dostupne akcije (revizija).
   * Idempotentno: ponovljen poziv samo ponovi ista dva update-a.
   */
  private async postNivLeveling(
    tx: Prisma.TransactionClient,
    doc: { id: number },
  ): Promise<LedgerLineDraft[]> {
    const itemCount = await tx.stockLevelingItem.count({
      where: { documentId: doc.id },
    });
    if (itemCount === 0) {
      throw new UnprocessableEntityException(
        `Nivelacija ${doc.id} nema nijednu stavku — nema šta da se obradi. ` +
          `Unesi stavke nivelacije, pa ponovi.`,
      );
    }
    await tx.stockDocument.update({
      where: { id: doc.id },
      data: { status: "POSTED" },
    });
    await tx.stockLevelingItem.updateMany({
      where: { documentId: doc.id },
      data: { isPosted: true },
    });

    return [];
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

      // ⚠️ GLASNO NA NEPOZNATOJ ŠIFRI (nalaz S3, 02.08.2026). Do ove izmene je stajalo
      // `?? ZERO` — nemo: dokument sa šifrom koju mapa ne zna (istekla tarifa „18" iz
      // BigBita, ručna ispravka u bazi) knjižio bi se BEZ IJEDNE PDV LINIJE. Nalog bi
      // pritom balansirao (D/E/P/Q/U/W su nula na obe strane), pa ga ni kontrola
      // ΣDug==ΣPot ne bi zaustavila — greška bi se videla tek u POPDV obrascu, mesecima
      // kasnije. Ovo je GLAVNA KNJIGA: bolje 422 nego nalog bez poreza.
      const rate = VAT_RATE_BY_CODE[it.goodsTaxRateCode];
      if (rate === undefined) {
        throw new UnprocessableEntityException(
          `${unknownVatCodeMessage(it.goodsTaxRateCode)} Dokument vrste ` +
            `${doc.documentTypeCode} ima stavku sa tom šifrom — ispravi tarifu ` +
            `artikla ili stavke, pa ponovi knjiženje.`,
        );
      }
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
    // Numerički MAX u JS-u (obrazac stock-document-numbering) — string orderBy je
    // leksikografski pa je '10000' < '9999' i brojač bi se zaglavio posle 9999.
    const rows = await tx.journalEntry.findMany({
      where: { companyId, orderTypeCode: orderType, year },
      select: { number: true },
    });
    let maxSeq = 0;
    for (const r of rows) {
      const n = Number.parseInt(r.number, 10);
      if (!Number.isNaN(n) && n > maxSeq) maxSeq = n;
    }
    return String(maxSeq + 1).padStart(4, "0");
  }
}
