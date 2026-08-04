import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import {
  LedgerNotBalancedException,
  PostingEngineService,
} from "./posting/posting.service";
import { buildYearOpenDiff, loadCumulativeBalances } from "./year-open-diff";

/**
 * POČETNO STANJE / carry-over godine (BigBit „Prenos u novu godinu", Batch B / B2).
 * =============================================================================
 * Jedan poslovni potez u JEDNOJ transakciji, kroz POSTOJEĆI PostingEngine.postManualEntry
 * (balans-kontrola ΣDug=ΣPot; ne balansira → 422 sa razlikom):
 *
 *   a) SALDO po kontu na 31.12. fromYear — isti filter kao kartica konta
 *      (`je.status IN (posted, locked)`), u PROZORU `je.year = fromYear` (PS te godine +
 *      promet te godine). Do 04.08.2026. je ovde stajao kumulativ `document_date <
 *      01.01.(fromYear+1)`, koji je na svakom prenosu POSLE prvog brojao klase 0–4 dvaput —
 *      v. obrazloženje nad `accountBalances`.
 *   b) ZATVARANJE klase 5 (rashodi) i 6 (prihodi) kontra-stavkama; razlika (rezultat)
 *      ide na „konto rezultata" (klasa 3, nađen po prefiksu — DOKUMENTOVANO u `notes`).
 *      Zaključni nalog (orderType ZAK) datiran 31.12. fromYear.
 *   c) PS NALOG za toYear — klase 0/1/2/3/4 sa saldom ≠ 0 (posle zatvaranja, pa je
 *      rezultat već u klasi 3) kao početno stanje; orderType PS, datum 01.01. toYear
 *      (ili prosleđen `postingDate`).
 *
 * IDEMPOTENCIJA: ako PS nalog za (company, toYear) već postoji → 409 (traži storno pre
 * ponovnog prenosa). Serijalizacija paralelnih poziva advisory lock-om po (company, toYear).
 *
 * ⚠️ OBIM (task ugovor): zatvaraju se SAMO klase 5 i 6, otvaraju SAMO 0–4. Ako u glavnoj
 * knjizi postoje neponišteni saldi klasa 7/8/9, PS neće balansirati i vraća se 422 sa
 * razlikom (namerna zaštita — knjigovođa mora ručno da razreši te saldе).
 */

const D = Prisma.Decimal;
const ZERO = new D(0);

/** Vrsta zaključnog naloga (zatvaranje klasa 5/6). Soft-ref (OrderType nema hard FK). */
const CLOSING_ORDER_TYPE = "ZAK";
/** Vrsta naloga početnog stanja (prenos klasa 0–4). */
const OPENING_ORDER_TYPE = "PS";

export interface YearOpenDto {
  /** Izvorna godina (saldo sa 31.12. ove godine). */
  fromYear: number;
  /** Ciljna godina (PS nalog). */
  toYear: number;
  /** Datum PS naloga (ISO); podrazumevano 01.01. toYear. */
  postingDate?: string;
  /** Konto rezultata (opciono, override); podrazumevano auto po prefiksu (klasa 3). */
  resultAccount?: string;
  /** Kompanija (podrazumevano 0 — isti podrazumevani kao ručni nalog). */
  companyId?: number;
  /**
   * Samo IZVEŠTAJ, bez upisa: vrati po kontu staru (kumulativnu) i novu (prozor po godini)
   * osnovu i razliku. Obrazac je isti kao `lockOlder` u ovom modulu — FE ga koristi da
   * korisnik VIDI šta se menja pre nego što se nalog napravi.
   */
  dryRun?: boolean;
}

// `YearOpenDiffRow` živi u `year-open-diff.ts`, uz sam izveštaj koji ga proizvodi.
// Re-eksport stoji da postojeći `import { YearOpenDiffRow } from "./year-open.service"`
// nastavi da radi — tip je javni oblik odgovora rute.
export type { YearOpenDiffRow } from "./year-open-diff";

interface AccountBalance {
  accountCode: string;
  accountClass: number;
  /** Saldo = ΣDuguje − ΣPotražuje (+ = dugovni, − = potražni). */
  net: Prisma.Decimal;
}

interface ManualLine {
  accountCode: string;
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
  description: string;
}

@Injectable()
export class YearOpenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posting: PostingEngineService,
  ) {}

  /**
   * Prenos salda u novu godinu (zatvaranje 5/6 → rezultat, otvaranje 0–4 kao PS).
   * @returns { closingEntryId, openingEntryId, lines, ... } (id-evi + broj linija za FE).
   */
  async createYearOpen(dto: YearOpenDto, actorUserId?: number) {
    const fromYear = Number(dto.fromYear);
    const toYear = Number(dto.toYear);
    const companyId = dto.companyId ?? 0;

    if (!Number.isInteger(fromYear) || fromYear < 2000 || fromYear > 2100)
      throw new BadRequestException(
        "Parametar fromYear mora biti godina (2000–2100).",
      );
    if (!Number.isInteger(toYear) || toYear < 2000 || toYear > 2100)
      throw new BadRequestException(
        "Parametar toYear mora biti godina (2000–2100).",
      );
    if (toYear <= fromYear)
      throw new BadRequestException(
        "Ciljna godina (toYear) mora biti posle izvorne godine (fromYear).",
      );

    // PS datum: prosleđen `postingDate` ili 01.01. toYear (UTC, dan-granularnost).
    let psDate: Date;
    if (dto.postingDate != null && String(dto.postingDate).trim() !== "") {
      psDate = new Date(dto.postingDate);
      if (Number.isNaN(psDate.getTime()))
        throw new BadRequestException("Parametar postingDate nije ispravan datum.");
    } else {
      psDate = new Date(Date.UTC(toYear, 0, 1));
    }

    // Kumulativ zaključno sa 31.12. fromYear = sve pre 01.01. (fromYear+1).
    const cutoff = new Date(Date.UTC(fromYear + 1, 0, 1));
    const closingDate = new Date(Date.UTC(fromYear, 11, 31));

    return this.prisma.$transaction(async (tx) => {
      // Serijalizuj paralelne prenose po (company, toYear) — inače dupli PS (TOCTOU).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`gl-year-open:${companyId}:${toYear}`}))`;

      // IDEMPOTENCIJA: PS nalog za toYear već postoji → 409.
      // VAŽNO (review Batch B): storniran PS se NE računa, inače bi 409 ostao zauvek —
      // reverse() pravi kontra-nalog sa ISTIM orderTypeCode/year, pa je ranije i posle
      // storna (koji sama poruka preporučuje) ponovni prenos bio nemoguć bez ručne
      // intervencije u bazi. Preskačemo: (a) originale koji su stornirani
      // (reversedByEntryId != null) i (b) same storno kontra-naloge (reversesEntryId != null).
      const existingPs = await tx.journalEntry.findFirst({
        where: {
          orderTypeCode: OPENING_ORDER_TYPE,
          year: toYear,
          companyId,
          reversedByEntryId: null,
          reversesEntryId: null,
        },
        select: { id: true, number: true },
      });
      if (existingPs)
        throw new ConflictException(
          `Početno stanje za ${toYear} već postoji (nalog PS ${existingPs.number}). ` +
            `Storniraj postojeći PS nalog pa ponovi prenos.`,
        );

      // IZVEŠTAJ RAZLIKE (dryRun) — ništa se ne upisuje. Pokazuje po kontu staru
      // (kumulativnu) i novu (prozor po godini) osnovu, pa se pre prenosa vidi da li je
      // zatečeno početno stanje bilo naduvano i za koliko. Odluka vlasnika 04.08.2026:
      // popravka koda + izveštaj, BEZ automatskog backfill-a zatečenih godina.
      // FAIL-SAFE ČITANJE `dryRun`: telo ove rute NIJE validirano (`YearOpenDto` je
      // interfejs, pa ga globalni `ValidationPipe` preskače — jedna od 164 takve rute,
      // v. `test/body-validation-coverage.e2e-spec.ts`). Da je provera bila `=== true`,
      // klijent koji pošalje `"true"` kao STRING dobio bi PRAVI prenos umesto izveštaja —
      // dakle upis u knjige na osnovu neprepoznate vrednosti. Zato je pravilo obrnuto:
      // prenos se izvršava samo kad je `dryRun` ODSUTAN ili izričito neistina.
      const wantsDryRun =
        dto.dryRun !== undefined &&
        dto.dryRun !== null &&
        String(dto.dryRun).trim().toLowerCase() !== "false" &&
        String(dto.dryRun).trim() !== "";
      if (wantsDryRun) {
        return {
          data: {
            dryRun: true as const,
            fromYear,
            toYear,
            companyId,
            rows: buildYearOpenDiff(
              await this.accountBalances(tx, companyId, fromYear),
              await loadCumulativeBalances(tx, companyId, cutoff),
            ),
          },
        };
      }

      // BRANA KOJU PROZOR PO GODINI ZAHTEVA (v. `accountBalances`): ako knjige sadrže
      // godine PRE `fromYear`, a `fromYear` NEMA svoj PS nalog, prozor izostavlja zatečeni
      // saldo i početno stanje bi izašlo PREMALO. Tiho manje početno stanje je kvar gori od
      // dvostrukog brojanja koje se ovde ispravlja, pa se prenos ODBIJA sa uputstvom.
      const earliest = await tx.journalEntry.aggregate({
        _min: { year: true },
        where: { companyId, status: { in: ["POSTED", "LOCKED"] } },
      });
      const earliestYear = earliest._min.year;
      if (earliestYear != null && earliestYear < fromYear) {
        const psForFromYear = await tx.journalEntry.findFirst({
          where: {
            orderTypeCode: OPENING_ORDER_TYPE,
            year: fromYear,
            companyId,
            reversedByEntryId: null,
            reversesEntryId: null,
          },
          select: { id: true },
        });
        if (!psForFromYear)
          throw new ConflictException(
            `Prenos nije moguć: knjige sadrže godine od ${earliestYear}, a ${fromYear} nema ` +
              `svoj PS (početno stanje) nalog — saldo zatečen pre ${fromYear} ne bi ušao u ` +
              `prenos i početno stanje za ${toYear} bilo bi premalo. Napravi PS za ${fromYear} ` +
              `(prenos ${fromYear - 1} → ${fromYear}) pa ponovi. Za pregled razlike pozovi ` +
              `istu rutu sa "dryRun": true.`,
          );
      }

      // (a) + (b) ZATVARANJE klasa 5/6 → rezultat na konto rezultata.
      const balances = await this.accountBalances(tx, companyId, fromYear);
      const closing = await this.closeIncomeStatement(tx, balances, {
        fromYear,
        companyId,
        closingDate,
        actorUserId,
        resultAccount: dto.resultAccount,
      });

      // (c) PS NALOG za toYear (recompute klasa 0–4 — sad uključuje rezultat iz zaključnog).
      const opening = await this.openBalanceSheet(tx, companyId, fromYear, {
        fromYear,
        toYear,
        psDate,
        actorUserId,
      });

      return {
        closingEntryId: closing.closingEntryId,
        openingEntryId: opening.journalEntryId,
        lines: closing.closingLineCount + opening.openingLineCount,
        closingLines: closing.closingLineCount,
        openingLines: opening.openingLineCount,
        resultAccount: closing.resultAccount,
        notes: closing.resultNote,
      };
    });
  }


  // ───────────────────────────────────────────────────────────────────────────
  // (a) Saldo po kontu za GODINU `fromYear` — filter kao kartica: posted+locked.
  // ───────────────────────────────────────────────────────────────────────────
  /**
   * PROZOR JE `je.year = fromYear`, NE kumulativ od početka knjiga (ispravka 04.08.2026).
   *
   * ŠTA SE DEŠAVALO PRE: uslov je bio `je.document_date < cutoff`, gde je `cutoff` =
   * 01.01.(fromYear+1) — dakle SVE godine od početka knjiga, kumulativno. Na PRVOM prenosu
   * to je slučajno tačno (nema starijih godina). Na DRUGOM je pogrešno: PS nalog godine
   * `fromYear` (koji je napravio prethodni prenos i koji SAŽIMA saldo godine fromYear−1)
   * sabira se ZAJEDNO sa prometom te iste fromYear−1 — pa se klase 0–4 broje DVAPUT.
   * Kvar sazreva tek na drugom prenosu, dakle prvi put boli u januaru 2028, kad je već u
   * knjigama. Za klase 5/6 isti propust sabira prihod svih ranijih godina u rezultat.
   *
   * Dvostruko brojanje se NE izbegava izuzimanjem PS naloga (BigBit ga uračunava:
   * `ZR_BrutoStanje.Duguje = UkPrometDuguje`), nego time što ranija godina UOPŠTE NIJE u
   * prozoru — identično kako se `zavrsni/gkeval.service.ts:36-48` brani od istog kvara, i
   * kolona je ista: `je.year` (verbatim iz BigBit uvoza), ne `posting_date`/`document_date`.
   *
   * PREDUSLOV koji ovaj prozor uvodi: `fromYear` MORA imati svoj PS nalog kad knjige sadrže
   * ranije godine — inače prozor izostavi zatečeni saldo i početno stanje izađe PREMALO.
   * Taj slučaj hvata brana u `createYearOpen` (odbija sa uputstvom na `dryRun` izveštaj);
   * tiho manje početno stanje bilo bi kvar gori od onog koji se ovde ispravlja.
   */
  private async accountBalances(
    tx: Prisma.TransactionClient,
    companyId: number,
    fromYear: number,
  ): Promise<AccountBalance[]> {
    const rows = await tx.$queryRaw<
      Array<{
        accountCode: string;
        accountClass: number;
        debit: Prisma.Decimal;
        credit: Prisma.Decimal;
      }>
    >(Prisma.sql`
      SELECT le.account_code AS "accountCode",
             a.account_class AS "accountClass",
             COALESCE(SUM(le.debit), 0) AS debit,
             COALESCE(SUM(le.credit), 0) AS credit
      FROM ledger_entries le
      JOIN journal_entries je ON je.id = le.journal_entry_id
      JOIN accounts a ON a.code = le.account_code
      WHERE je.status IN ('POSTED', 'LOCKED')
        AND je.company_id = ${companyId}
        AND je.year = ${fromYear}
      GROUP BY le.account_code, a.account_class
      HAVING COALESCE(SUM(le.debit), 0) <> COALESCE(SUM(le.credit), 0)
      ORDER BY le.account_code ASC
    `);
    return rows.map((r) => ({
      accountCode: r.accountCode,
      accountClass: Number(r.accountClass),
      net: new D(r.debit).minus(new D(r.credit)),
    }));
  }

  // ───────────────────────────────────────────────────────────────────────────
  // (b) Zatvaranje klasa 5 (rashodi) i 6 (prihodi) → rezultat na konto rezultata.
  // ───────────────────────────────────────────────────────────────────────────
  private async closeIncomeStatement(
    tx: Prisma.TransactionClient,
    balances: AccountBalance[],
    opts: {
      fromYear: number;
      companyId: number;
      closingDate: Date;
      actorUserId?: number;
      resultAccount?: string;
    },
  ): Promise<{
    closingEntryId: number | null;
    closingLineCount: number;
    resultAccount: string | null;
    resultNote: string;
  }> {
    const closingLines: ManualLine[] = [];
    let zeroDebit = ZERO; // Σ kontra-dugovanja (zatvaranje klase 6 = prihodi)
    let zeroCredit = ZERO; // Σ kontra-potraživanja (zatvaranje klase 5 = rashodi)

    for (const b of balances) {
      if (b.accountClass !== 5 && b.accountClass !== 6) continue;
      if (b.net.isZero()) continue;
      const desc = `Zatvaranje konta ${b.accountCode} (klasa ${b.accountClass}) za ${opts.fromYear}`;
      if (b.net.gt(0)) {
        // Dugovni saldo (tipično rashodi) → potražna kontra-stavka.
        closingLines.push({
          accountCode: b.accountCode,
          debit: ZERO,
          credit: b.net,
          description: desc,
        });
        zeroCredit = zeroCredit.plus(b.net);
      } else {
        // Potražni saldo (tipično prihodi) → dugovna kontra-stavka.
        const amt = b.net.abs();
        closingLines.push({
          accountCode: b.accountCode,
          debit: amt,
          credit: ZERO,
          description: desc,
        });
        zeroDebit = zeroDebit.plus(amt);
      }
    }

    if (closingLines.length === 0) {
      return {
        closingEntryId: null,
        closingLineCount: 0,
        resultAccount: null,
        resultNote: `Nema salda klasa 5/6 na 31.12.${opts.fromYear} — zatvaranje nije bilo potrebno.`,
      };
    }

    // Rezultat = razlika koja balansira zaključni nalog. diff > 0 → gubitak (dugovni na
    // konto rezultata); diff < 0 → dobitak (potražni). diff == 0 → rashodi = prihodi.
    const diff = zeroCredit.minus(zeroDebit);
    let resultAccount: string | null = null;
    let resultNote: string;

    if (diff.isZero()) {
      resultNote =
        `Rashodi = prihodi za ${opts.fromYear} (rezultat 0) — bez stavke rezultata.`;
    } else {
      const resolved = await this.resolveResultAccount(
        tx,
        opts.resultAccount,
        diff.gt(0), // diff > 0 = rashodi veći od prihoda = gubitak
      );
      resultAccount = resolved.code;
      resultNote = resolved.note;
      if (diff.gt(0)) {
        closingLines.push({
          accountCode: resultAccount,
          debit: diff,
          credit: ZERO,
          description: resultNote,
        });
      } else {
        closingLines.push({
          accountCode: resultAccount,
          debit: ZERO,
          credit: diff.abs(),
          description: resultNote,
        });
      }
    }

    const closing = await this.postBalanced(tx, {
      orderType: CLOSING_ORDER_TYPE,
      documentDate: opts.closingDate,
      companyId: opts.companyId,
      description: `Zatvaranje klasa 5 i 6 za ${opts.fromYear}`,
      createdByUserId: opts.actorUserId,
      // Brava predatog PDV perioda se OVDE svesno preskače (v. `postBalanced`):
      // zaključni nalog je po zakonu datiran 31.12., a decembarska prijava je do
      // trenutka prenosa gotovo uvek predata. Zatvaraju se ISKLJUČIVO klase 5 i 6
      // (rashodi/prihodi) — nijedno PDV konto (27x/47x), pa PDV obračun tog meseca
      // ostaje netaknut. Alternativa (datirati u tekući period) bila bi pogrešna.
      forceReason: `Zaključni nalog ${CLOSING_ORDER_TYPE} 31.12.${opts.fromYear} — zatvaranje klasa 5/6 pri prenosu godine (bez PDV konta)`,
      lines: closingLines,
    });

    return {
      closingEntryId: closing.journalEntryId,
      closingLineCount: closing.lineCount,
      resultAccount,
      resultNote,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // (c) PS nalog za toYear — klase 0–4 sa saldom (recompute posle zatvaranja).
  // ───────────────────────────────────────────────────────────────────────────
  private async openBalanceSheet(
    tx: Prisma.TransactionClient,
    companyId: number,
    fromYear: number,
    opts: { fromYear: number; toYear: number; psDate: Date; actorUserId?: number },
  ): Promise<{ journalEntryId: number; openingLineCount: number }> {
    // Recompute: zaključni nalog (ZAK) je datiran 31.12. `fromYear`, a `postManualEntry`
    // izvodi `year = businessYear(documentDate)` — dakle ZAK JE u prozoru `je.year = fromYear`
    // i rezultat (klasa 3) je sada u saldu. Time PS klasa 0–4 balansira samo od sebe.
    // (PS nalog je datiran 01.01. `toYear`, pa dobija `year = toYear` i u prozor NE ulazi —
    // to je i uslov da se sopstveni PS ne uračuna u osnovu iz koje se pravi.)
    const balances = await this.accountBalances(tx, companyId, fromYear);
    const psLines: ManualLine[] = [];
    for (const b of balances) {
      if (b.accountClass < 0 || b.accountClass > 4) continue;
      if (b.net.isZero()) continue;
      const desc = `Početno stanje ${opts.toYear} (prenos sa ${opts.fromYear})`;
      if (b.net.gt(0)) {
        psLines.push({
          accountCode: b.accountCode,
          debit: b.net,
          credit: ZERO,
          description: desc,
        });
      } else {
        psLines.push({
          accountCode: b.accountCode,
          debit: ZERO,
          credit: b.net.abs(),
          description: desc,
        });
      }
    }

    if (psLines.length === 0)
      throw new UnprocessableEntityException(
        `Nema salda klasa 0–4 na 31.12.${opts.fromYear} — nema početnog stanja za prenos u ${opts.toYear}.`,
      );

    const opening = await this.postBalanced(tx, {
      orderType: OPENING_ORDER_TYPE,
      documentDate: opts.psDate,
      companyId,
      description: `Početno stanje ${opts.toYear} (prenos sa ${opts.fromYear})`,
      createdByUserId: opts.actorUserId,
      // Brava se preskače i za PS: prenos se u praksi radi tek u toku naredne godine,
      // pa je januar `toYear` (datum PS naloga) tada već predat. PS je jedno jedino
      // knjiženje po godini i ne sme da se pomeri u „tekući period" — inače saldi
      // klasa 0–4 nedostaju svim čitaocima od 01.01. do datuma prenosa.
      forceReason: `Nalog početnog stanja ${OPENING_ORDER_TYPE} za ${opts.toYear} — prenos salda klasa 0–4 sa ${opts.fromYear}`,
      lines: psLines,
    });
    return {
      journalEntryId: opening.journalEntryId,
      openingLineCount: opening.lineCount,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Konto rezultata — prosleđen (override) ili auto po prefiksu (klasa 3 zbog balansa).
  // ───────────────────────────────────────────────────────────────────────────
  private async resolveResultAccount(
    tx: Prisma.TransactionClient,
    preferred: string | undefined,
    /** true = rashodi > prihodi (gubitak) → drugo konto nego kod dobitka. */
    isLoss: boolean,
  ): Promise<{ code: string; note: string }> {
    if (preferred != null && preferred.trim() !== "") {
      const code = preferred.trim();
      const acc = await tx.account.findUnique({
        where: { code },
        select: { code: true, name: true, accountClass: true },
      });
      if (!acc)
        throw new UnprocessableEntityException(
          `Konto rezultata ${code} ne postoji u kontnom planu.`,
        );
      // Rezultat MORA biti klasa 0–4 (equity/stanje), inače PS klasa 0–4 ne balansira.
      if (acc.accountClass > 4)
        throw new UnprocessableEntityException(
          `Konto rezultata ${code} (klasa ${acc.accountClass}) mora biti iz klasa 0–4 ` +
            `da bi početno stanje balansiralo (rezultat pripada kapitalu, klasa 3).`,
        );
      return {
        code: acc.code,
        note: `Rezultat poslovanja prenet na konto ${acc.code} — ${acc.name} (izbor: ručno prosleđen).`,
      };
    }

    // Auto: neraspoređeni rezultat (klasa 3) — ali DOBITAK i GUBITAK idu na RAZLIČITA
    // konta (review Batch B: ranije je i gubitak završavao na 340 „neraspoređeni dobitak").
    //   dobitak → 341/340/34 (neraspoređeni dobitak tekuće/ranijih godina)
    //   gubitak → 351/350/35 (gubitak tekuće/ranijih godina)
    const prefixes = isLoss
      ? ["351", "350", "35"]
      : ["341", "340", "34"];
    for (const p of prefixes) {
      const acc = await tx.account.findFirst({
        where: { code: { startsWith: p }, accountClass: 3 },
        orderBy: { code: "asc" },
        select: { code: true, name: true },
      });
      if (acc)
        return {
          code: acc.code,
          note: `Rezultat poslovanja prenet na konto ${acc.code} — ${acc.name} (izbor: auto po prefiksu ${p}, klasa 3).`,
        };
    }

    throw new UnprocessableEntityException(
      `Nije pronađen konto rezultata (klasa 3, prefiks 34x/35x) u kontnom planu. ` +
        `Prosledi resultAccount u zahtevu (mora biti iz klasa 0–4).`,
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Knjiži balansiran nalog kroz PostingEngine; ne balansira → 422 sa razlikom.
  // ───────────────────────────────────────────────────────────────────────────
  /**
   * `forceReason` — PRENOS GODINE MORA da knjiži u predat PDV period po dizajnu.
   * Od 04.08.2026 motor (`postManualEntry`) odbija knjiženje u mesec za koji je PDV
   * prijava predata; oba naloga prenosa su datirana fiksno (ZAK 31.12. `fromYear`,
   * PS 01.01. `toYear`) i ne mogu se pomeriti u tekući period, pa im se brava
   * eksplicitno preskače uz obrazloženje. Brava se NE gasi tiho: obrazloženje ide u
   * opis naloga i u `audit_log`, pa se u dnevniku vidi ko je i zašto forsirao.
   */
  private async postBalanced(
    tx: Prisma.TransactionClient,
    params: {
      orderType: string;
      documentDate: Date;
      companyId: number;
      description: string;
      createdByUserId?: number;
      forceReason: string;
      lines: ManualLine[];
    },
  ): Promise<{ journalEntryId: number; number: string; lineCount: number }> {
    try {
      return await this.posting.postManualEntry(tx, {
        orderType: params.orderType,
        documentDate: params.documentDate,
        companyId: params.companyId,
        description: params.description,
        createdByUserId: params.createdByUserId,
        force: {
          reason: params.forceReason,
          actorUserId: params.createdByUserId,
        },
        lines: params.lines.map((l) => ({
          accountCode: l.accountCode,
          debit: l.debit.toFixed(4),
          credit: l.credit.toFixed(4),
          description: l.description,
        })),
      });
    } catch (e) {
      if (e instanceof LedgerNotBalancedException) {
        const razlika = e.totalDebit.minus(e.totalCredit).toFixed(4);
        throw new UnprocessableEntityException(
          `Nalog (${params.orderType}) ne balansira: ΣDuguje=${e.totalDebit.toFixed(4)}, ` +
            `ΣPotražuje=${e.totalCredit.toFixed(4)}, razlika=${razlika}. ` +
            `Proveri neponištene saldе klasa 7/8/9 pre prenosa.`,
        );
      }
      throw e;
    }
  }
}
