/**
 * FX REVALUATION SERVICE — revalorizacija deviznih otvorenih stavki (C2).
 * =========================================================================
 * ZAKONSKA OBAVEZA na dan bilansa (31.12.): devizna potraživanja i obaveze se
 * preračunavaju po kursu na taj dan, a razlika između knjigovodstvene i nove
 * protivvrednosti se knjiži kao prihod ili rashod perioda:
 *
 *   razlika = (devizni saldo × kurs na dan) − knjigovodstvena protivvrednost
 *     razlika > 0 → POZITIVNA kursna razlika → prihod, konto 663
 *     razlika < 0 → NEGATIVNA kursna razlika → rashod, konto 563
 *
 * Predznak radi za obe strane bez posebne logike: potraživanje ima dugovni
 * (pozitivan) saldo pa rast kursa daje dobitak; obaveza ima potražni (negativan)
 * saldo pa isti rast kursa daje gubitak.
 *
 * PROTIVSTAVKA je konto SAME otvorene stavke (2040/2050 kupci, 4350/4360
 * dobavljači…) — ne bira se ovde nikakva mapa konta: konto, komitent i broj
 * dokumenta se preuzimaju iz otvorene stavke (OpenItemsService), pa razlika pada
 * u ISTU open-items grupu i podiže/spušta protivvrednost te grupe. Isti obrazac
 * koji kompenzacija koristi za svoju protivstavku (compensation.service.ts).
 *
 * IDEMPOTENCIJA: parcijalni unique `uq_fx_revaluation_runs_active` na
 * (as_of_date, currency, company_id) WHERE status <> 'REVERSED'. Drugi obračun
 * istog preseka → P2002 → 409. Storno oslobađa slot.
 *
 * ČITANJE NALOGA ide preko OpenItemsService koji filtrira `je.status IN
 * ('posted','locked')` — zaključan period je i dalje proknjižen i MORA ući u
 * revalorizaciju (ponovljen bag u ovom repou: filter samo na 'posted').
 *
 * NOVAC: Prisma.Decimal svuda, NIKAD Float.
 */

import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { PostingEngineService } from "../gl/posting/posting.service";
import { GlWriteService } from "../gl/gl-write.service";
import { ExchangeRateService } from "../izvodi/exchange-rate.service";
import { OpenItemsService } from "./open-items.service";
import {
  normalizeFxCurrency,
  parseAsOfDate,
  parseExpectedDecimal,
  validateFxRevaluationReverse,
  validateFxRevaluationRun,
  type FxRevaluationReverseDto,
  type FxRevaluationRunDto,
} from "./dto/fx-revaluation.dto";

const D = Prisma.Decimal;
const ZERO = new D(0);

/** Konto prihoda od pozitivnih kursnih razlika (klasa 6). */
export const FX_GAIN_ACCOUNT = "663";
/** Konto rashoda po osnovu negativnih kursnih razlika (klasa 5). */
export const FX_LOSS_ACCOUNT = "563";
/** Vrsta naloga kursnih razlika (JournalEntry.orderTypeCode je VarChar(5)). */
export const FX_ORDER_TYPE = "KR";

/**
 * Tip kursa za revalorizaciju = SREDNJI (`middleRate`) — tako je i dokumentovano na
 * koloni `fx_revaluation_runs.rate_used`. Prodajni kurs je za izvode/naloge za
 * plaćanje (v. ExchangeRateService), ne za bilansni presek.
 */
const FX_RATE_TYPE = "middle";

/** Zaokruživanje protivvrednosti na paru (Decimal(19,4) kolona, novac = 2 decimale). */
const MONEY_SCALE = 2;

/** Zaokruživanje kursa (rate_used je Decimal(19,6)) — poređenje sa pregledom. */
const RATE_SCALE = 6;

/**
 * Prag saglasnosti knjigovodstvene i devizne strane grupe (review C2 §5). Implicitna
 * stopa grupe = dinarski saldo / devizni saldo; ako odstupa od kursa na dan preseka
 * više od ovoga, grupa NIJE ispravan devizni par (tipično: delimično plaćanje knjiženo
 * samo u RSD, bez deviznog para) i razlika bi bila red veličine celog plaćanja umesto
 * kursne razlike. 30% je namerno široko — EUR/RSD se godinama kreće u par procenata,
 * pa prag hvata grube greške knjiženja, a ne normalan pomeraj kursa. Knjigovođa može
 * svesno da uključi takve grupe kroz `force`.
 */
const IMPLIED_RATE_TOLERANCE = new D("0.30");

/** Jedna revalorizovana otvorena stavka. */
export interface FxRevaluationItem {
  accountCode: string;
  analyticalCode: number | null; // komitent
  documentNumber: string | null;
  side: string; // receivable | payable (iz saldakonto registra)
  /** Devizni saldo grupe (+ potraživanje, − obaveza). */
  fxAmount: Prisma.Decimal;
  /** Knjigovodstvena protivvrednost (Σ duguje − Σ potražuje) u RSD. */
  bookedAmount: Prisma.Decimal;
  /** Nova protivvrednost = fxAmount × kurs na dan preseka. */
  revaluedAmount: Prisma.Decimal;
  /** revaluedAmount − bookedAmount (+ dobitak / − gubitak). */
  difference: Prisma.Decimal;
  ledgerEntryIds: number[];
}

/**
 * Grupa koju obračun NE knjiži (ili knjiži samo uz `force`) — greška podataka koja
 * mora da stigne do korisnika, a ne da tiho ispadne iz bilansa.
 *   MIXED_CURRENCY  — grupa nosi više deviznih valuta (nema jedinstven devizni saldo);
 *   NO_FX_PAIR      — dinarski saldo bez deviznog salda (devizni par nije knjižen);
 *   FX_SIGN_MISMATCH— devizni i dinarski saldo suprotnog predznaka;
 *   RATE_MISMATCH   — implicitna knjigovodstvena stopa daleko od kursa na dan.
 */
export interface FxRevaluationFlaggedItem {
  accountCode: string;
  analyticalCode: number | null;
  documentNumber: string | null;
  code: string;
  /** Srpska poruka za korisnika (šta je zatečeno i šta da uradi). */
  message: string;
  /** Devizni saldo grupe (null kad ga nema). */
  fxAmount: Prisma.Decimal | null;
  /** Dinarski (knjigovodstveni) saldo grupe. */
  bookedAmount: Prisma.Decimal;
  /** bookedAmount / fxAmount — knjigovodstvena stopa grupe (null kad se ne može izračunati). */
  impliedRate: Prisma.Decimal | null;
  /** Valute zatečene u grupi (samo MIXED_CURRENCY). */
  currencies?: string[];
  /** Da li je grupa ipak uključena u obračun (samo uz `force`). */
  included: boolean;
}

/** Rezultat `preview` — bez ijednog upisa. */
export interface FxRevaluationPreview {
  asOfDate: Date;
  currency: string;
  companyId: number;
  /** Kurs upotrebljen za preračun (srednji na dan preseka). */
  rate: Prisma.Decimal;
  /** Datum kursne liste koja je STVARNO upotrebljena (vikend/praznik → raniji dan). */
  rateDate: Date;
  /** true kad `rateDate` nije dan preseka (obračun po zastarelom kursu, uz `allowStaleRate`). */
  staleRate: boolean;
  rateType: string;
  items: FxRevaluationItem[];
  itemsCount: number;
  /** Σ pozitivnih razlika (prihod 663). */
  gainTotal: Prisma.Decimal;
  /** Σ apsolutnih negativnih razlika (rashod 563). */
  lossTotal: Prisma.Decimal;
  /** gainTotal − lossTotal (neto efekat na rezultat). */
  netAmount: Prisma.Decimal;
  /** Grupe sa više valuta — ISKLJUČENE iz obračuna (greška podataka). */
  mixedCurrencyGroups: FxRevaluationFlaggedItem[];
  /** Sporne grupe (nesaglasan devizni/dinarski saldo) — knjiže se samo uz `force`. */
  flagged: FxRevaluationFlaggedItem[];
  /** Da li su sporne grupe uključene u `items`/zbirove (prosleđen `force`). */
  forced: boolean;
}

/** Rezultat `run` — obračun + broj naloga kursnih razlika. */
export interface FxRevaluationRunResult {
  runId: number;
  asOfDate: Date;
  currency: string;
  companyId: number;
  rateUsed: Prisma.Decimal;
  /** Dan kursne liste koja je upotrebljena (revizorski trag). */
  rateDate: Date | null;
  gainAmount: Prisma.Decimal;
  lossAmount: Prisma.Decimal;
  itemsCount: number;
  journalEntryId: number;
  journalNumber: string;
  status: string;
  /** Grupe isključene zbog više valuta u istoj grupi (nisu obračunate). */
  mixedCurrencyGroups: FxRevaluationFlaggedItem[];
  /** Sporne grupe — uključene samo ako je prosleđen `force`. */
  flagged: FxRevaluationFlaggedItem[];
}

@Injectable()
export class FxRevaluationService {
  private readonly logger = new Logger(FxRevaluationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly openItems: OpenItemsService,
    private readonly exchangeRates: ExchangeRateService,
    private readonly posting: PostingEngineService,
    private readonly glWrite: GlWriteService,
  ) {}

  // ── Pregled (bez upisa) ─────────────────────────────────────────────────────

  /**
   * Pregled revalorizacije na dan: otvorene devizne stavke date valute, kurs na dan
   * (ExchangeRateService.resolve — poslednji ≤ presek), knjigovodstvena protivvrednost
   * vs. nova protivvrednost, razlika po stavci i zbirno. NIŠTA ne upisuje.
   *
   * KURS MORA BITI SA DANA PRESEKA (review C2 §6): resolver vraća poslednji kurs ≤
   * preseka, pa bi obračun 31.12. tiho prošao po kursu od 20.12. ako lista nije uneta.
   * Takav pregled se ODBIJA sa porukom koja imenuje zatečeni kurs i njegov datum;
   * `allowStaleRate` je svesno odstupanje (i ostaje zapisano u `rateDate` obračuna).
   *
   * SPORNE GRUPE (review C2 §5) se izdvajaju u `flagged` i NE ulaze u zbirove, osim uz
   * `force`; grupe sa više valuta (review C2 §3) su isključene već u OpenItemsService i
   * ovde se samo prijavljuju u `mixedCurrencyGroups`.
   */
  async preview(params: {
    asOfDate: string | Date;
    currency: string;
    companyId?: number;
    allowStaleRate?: boolean;
    force?: boolean;
  }): Promise<FxRevaluationPreview> {
    const asOfDate =
      params.asOfDate instanceof Date
        ? this.assertNotFuture(params.asOfDate)
        : parseAsOfDate(params.asOfDate);
    const currency = normalizeFxCurrency(params.currency);
    const companyId = params.companyId ?? 0;
    const force = params.force === true;

    // Kurs na dan preseka (404 sa srpskom porukom ako kursne liste nema).
    const resolved = await this.exchangeRates.resolve(
      currency,
      asOfDate,
      FX_RATE_TYPE,
    );

    const staleRate = fmtIso(resolved.rateDate) !== fmtIso(asOfDate);
    if (staleRate && params.allowStaleRate !== true)
      throw new ConflictException(
        `Za ${currency} nije uneta kursna lista na dan ${fmtDate(asOfDate)} — ` +
          `zatečen je srednji kurs ${resolved.rate.toFixed(RATE_SCALE)} od ` +
          `${fmtDate(resolved.rateDate)}. Unesi kursnu listu za dan preseka, ` +
          `ili svesno potvrdi obračun po zatečenom kursu (allowStaleRate).`,
      );

    // Otvorene stavke: presek na dan + samo grupe u traženoj valuti. Filter
    // 'posted'+'locked' i uparivanje na dan preseka su u OpenItemsService.
    const openItems = await this.openItems.listOpenItems(
      undefined,
      undefined,
      asOfDate,
      { fxCurrency: currency, companyId: params.companyId },
    );

    // Grupe sa više valuta — isključene iz `openItems`, ali se MORAJU prijaviti.
    const mixed = await this.openItems.listMixedFxCurrencyGroups(asOfDate, {
      fxCurrency: currency,
      companyId: params.companyId,
    });
    const mixedCurrencyGroups: FxRevaluationFlaggedItem[] = mixed.map((g) => ({
      accountCode: g.accountCode,
      analyticalCode: g.analyticalCode,
      documentNumber: g.documentNumber,
      code: "MIXED_CURRENCY",
      message:
        `Grupa (konto ${g.accountCode}, komitent ${g.analyticalCode ?? "—"}, ` +
        `dokument ${g.documentNumber ?? "bez broja"}) nosi više valuta ` +
        `(${g.currencies.join(", ")}) pa nema jedinstven devizni saldo — ` +
        `nije obračunata. Razdvoj stavke po broju dokumenta pa ponovi obračun.`,
      fxAmount: null,
      bookedAmount: g.balance,
      impliedRate: null,
      currencies: g.currencies,
      included: false,
    }));

    let gainTotal = ZERO;
    let lossTotal = ZERO;
    const items: FxRevaluationItem[] = [];
    const flagged: FxRevaluationFlaggedItem[] = [];

    for (const oi of openItems) {
      const fxAmount = oi.fxAmount ?? ZERO;
      const bookedAmount = oi.balance;

      const problem = this.checkFxPair(fxAmount, bookedAmount, resolved.rate);
      if (problem) {
        flagged.push({
          accountCode: oi.accountCode,
          analyticalCode: oi.analyticalCode,
          documentNumber: oi.documentNumber,
          code: problem.code,
          message: problem.message,
          fxAmount,
          bookedAmount,
          impliedRate: problem.impliedRate,
          included: force,
        });
        if (!force) continue;
      }

      const revaluedAmount = fxAmount
        .mul(resolved.rate)
        .toDecimalPlaces(MONEY_SCALE);
      // ZAOKRUŽI PRE SABIRANJA (review C2 §4): linija naloga se knjiži zaokružena na
      // paru, pa zbirna protivstavka (663/563) mora da se gradi od ISTIH zaokruženih
      // vrednosti. Inače ΣDug ≠ ΣPot i knjiženje pukne LedgerNotBalancedException-om,
      // koji nije HttpException → goli 500 na zatvaranju godine.
      const difference = revaluedAmount
        .sub(bookedAmount)
        .toDecimalPlaces(MONEY_SCALE);

      if (difference.greaterThan(0)) gainTotal = gainTotal.add(difference);
      else if (difference.lessThan(0))
        lossTotal = lossTotal.add(difference.abs());

      items.push({
        accountCode: oi.accountCode,
        analyticalCode: oi.analyticalCode,
        documentNumber: oi.documentNumber,
        side: oi.side,
        fxAmount,
        bookedAmount,
        revaluedAmount,
        difference,
        ledgerEntryIds: oi.ledgerEntryIds,
      });
    }

    return {
      asOfDate,
      currency,
      companyId,
      rate: resolved.rate,
      rateDate: resolved.rateDate,
      staleRate,
      rateType: resolved.type,
      items,
      itemsCount: items.length,
      gainTotal,
      lossTotal,
      netAmount: gainTotal.sub(lossTotal),
      mixedCurrencyGroups,
      flagged,
      forced: force,
    };
  }

  // ── Obračun + knjiženje ─────────────────────────────────────────────────────

  /**
   * Obračun kursnih razlika na dan preseka: upisuje `FxRevaluationRun` i knjiži
   * GK nalog vrste KR. Nalog je BALANSIRAN po konstrukciji:
   *   Σ dug = Σ (pozitivne razlike na kontima stavki) + lossTotal (563)
   *   Σ pot = Σ (negativne razlike na kontima stavki) + gainTotal (663)
   * a kako je Σ pozitivnih razlika == gainTotal i Σ negativnih == lossTotal,
   * obe strane su gainTotal + lossTotal.
   *
   * Ponovni obračun istog (presek, valuta, firma) → 409 (parcijalni unique);
   * storno oslobađa slot.
   *
   * FIRMA: bez prosleđenog `companyId` obračun obuhvata SVE firme (isto kao ostatak
   * saldakonta koji ne filtrira po firmi), a nalog i zapis obračuna idu na
   * podrazumevanu firmu 0 — što je tačno dok je instalacija jednofirmska. Za rad sa
   * više firmi `companyId` se prosleđuje eksplicitno i tada se i čitanje filtrira.
   */
  async run(
    dto: FxRevaluationRunDto,
    actor?: { userId?: number },
  ): Promise<FxRevaluationRunResult> {
    validateFxRevaluationRun(dto);
    const asOfDate = parseAsOfDate(dto.asOfDate);
    const currency = normalizeFxCurrency(dto.currency);
    const companyId = dto.companyId ?? 0;

    const preview = await this.preview({
      asOfDate,
      currency,
      companyId: dto.companyId,
      allowStaleRate: dto.allowStaleRate,
      force: dto.force,
    });

    // ODOBRENO == PROKNJIŽENO (review C2 §7): `run` iznova računa pregled, pa bi
    // ispravka kursne liste ili novo devizno knjiženje između „Proveri" i „Obračunaj"
    // proknjižili iznos koji korisnik nikad nije video. Kad FE pošalje vrednosti iz
    // pregleda, svako odstupanje je 409 sa zahtevom da se pregled ponovi.
    this.assertMatchesPreview(dto, preview);

    const postable = preview.items.filter((i) => !i.difference.isZero());
    if (postable.length === 0) {
      throw new UnprocessableEntityException(
        `Nema kursnih razlika za ${currency} na dan ${fmtDate(asOfDate)} — ` +
          `nijedna otvorena devizna stavka ne menja protivvrednost po kursu ` +
          `${preview.rate.toFixed(6)}.`,
      );
    }

    await this.assertResultAccountsExist(preview.gainTotal, preview.lossTotal);

    const description =
      `Kursne razlike ${currency} na dan ${fmtDate(asOfDate)}` +
      (dto.note ? ` — ${dto.note}` : "");

    const result = await this.prisma.$transaction(async (tx) => {
      // Brava idempotencije PRE knjiženja: P2002 ovde ruši celu transakciju, pa
      // nalog kursnih razlika ne može nastati dva puta za isti presek.
      let runRow;
      try {
        runRow = await tx.fxRevaluationRun.create({
          data: {
            asOfDate,
            currency,
            companyId,
            rateUsed: preview.rate,
            // Revizorski trag: sa kog je DANA kurs stvarno uzet (≠ presek kad je
            // obračun svesno pušten uz `allowStaleRate`).
            rateDate: preview.rateDate,
            gainAmount: preview.gainTotal,
            lossAmount: preview.lossTotal,
            itemsCount: postable.length,
            status: "POSTED",
            note: dto.note ?? null,
            createdByUserId: actor?.userId ?? null,
          },
        });
      } catch (e) {
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === "P2002"
        )
          throw new ConflictException(
            `Kursne razlike za ${currency} na dan ${fmtDate(asOfDate)} su već obračunate — ` +
              `storniraj postojeći obračun pa ponovi.`,
          );
        throw e as Error;
      }

      const lines = this.buildJournalLines(preview, postable, description);
      const posted = await this.posting.postManualEntry(tx, {
        orderType: FX_ORDER_TYPE,
        documentDate: asOfDate,
        companyId,
        description,
        createdByUserId: actor?.userId,
        lines,
      });

      const updated = await tx.fxRevaluationRun.update({
        where: { id: runRow.id },
        data: { journalEntryId: posted.journalEntryId },
      });

      return { run: updated, journalNumber: posted.number };
    });

    this.logger.log(
      `FX revalorizacija ${currency} ${fmtDate(asOfDate)}: ${postable.length} stavki, ` +
        `dobitak ${preview.gainTotal.toFixed(2)} / gubitak ${preview.lossTotal.toFixed(2)}, ` +
        `nalog ${FX_ORDER_TYPE}-${result.journalNumber}` +
        (preview.staleRate ? ` (kurs od ${fmtDate(preview.rateDate)})` : ""),
    );
    if (preview.mixedCurrencyGroups.length || preview.flagged.length)
      this.logger.warn(
        `FX revalorizacija ${currency} ${fmtDate(asOfDate)}: ` +
          `${preview.mixedCurrencyGroups.length} grupa sa više valuta, ` +
          `${preview.flagged.length} spornih grupa ` +
          `(${preview.forced ? "uključene uz force" : "NISU obračunate"}).`,
      );

    return {
      runId: result.run.id,
      asOfDate: result.run.asOfDate,
      currency: result.run.currency,
      companyId: result.run.companyId,
      rateUsed: result.run.rateUsed,
      rateDate: result.run.rateDate ?? null,
      gainAmount: result.run.gainAmount,
      lossAmount: result.run.lossAmount,
      itemsCount: result.run.itemsCount,
      journalEntryId: result.run.journalEntryId as number,
      journalNumber: result.journalNumber,
      status: result.run.status,
      mixedCurrencyGroups: preview.mixedCurrencyGroups,
      flagged: preview.flagged,
    };
  }

  // ── Storno ──────────────────────────────────────────────────────────────────

  /**
   * Storno obračuna: stornira nalog kursnih razlika kroz POSTOJEĆI mehanizam
   * (`GlWriteService.reverse` — protiv-nalog + `reversesEntryId`/`reversedByEntryId`)
   * i prevodi obračun u 'REVERSED', čime se (presek, valuta, firma) slot oslobađa
   * za ponovni obračun.
   *
   * Zaključan nalog: `GlWriteService.reverse` traži prethodno otključavanje (409) —
   * ta kontrola se namerno NE zaobilazi.
   *
   * DATUM STORNA = PRESEK IZVORNOG OBRAČUNA (review C2 §1), ne današnji dan: otvorene
   * stavke se čitaju presekom (`je.posting_date <= presek`), pa bi storno naloga za
   * 31.12. sa današnjim datumom knjiženja bio NEVIDLJIV na taj presek — ponovni obračun
   * bi video original bez storna i knjižio pogrešan iznos i pogrešan predznak.
   *
   * Redosled: prvo storno naloga, pa status obračuna (da prekid ne ostavi obračun
   * REVERSED sa živim nalogom). Ponovljen poziv je bezbedan — već storniran nalog se
   * preskače i samo se dovrši status.
   */
  async reverse(
    dto: FxRevaluationReverseDto,
    actor?: { userId?: number },
  ): Promise<{ runId: number; status: string; stornoEntryId: number | null }> {
    validateFxRevaluationReverse(dto);

    const run = await this.prisma.fxRevaluationRun.findUnique({
      where: { id: dto.runId },
    });
    if (!run)
      throw new NotFoundException(
        `Obračun kursnih razlika ${dto.runId} ne postoji.`,
      );
    if (run.status === "REVERSED")
      throw new ConflictException(`Obračun ${dto.runId} je već storniran.`);

    let stornoEntryId: number | null = null;
    if (run.journalEntryId != null) {
      const entry = await this.prisma.journalEntry.findUnique({
        where: { id: run.journalEntryId },
        select: { id: true, reversedByEntryId: true },
      });
      if (entry?.reversedByEntryId != null) {
        // Nalog je već storniran (prekinut raniji pokušaj) — dovršavamo samo status.
        stornoEntryId = entry.reversedByEntryId;
      } else if (entry) {
        const res = await this.glWrite.reverse(
          run.journalEntryId,
          actor?.userId,
          { postingDate: run.asOfDate, documentDate: run.asOfDate },
        );
        stornoEntryId = res.stornoEntryId;
      }
    }

    const note = [run.note, dto.reason ? `STORNO: ${dto.reason}` : "STORNO"]
      .filter((s) => s != null && s !== "")
      .join(" · ");

    const updated = await this.prisma.fxRevaluationRun.update({
      where: { id: run.id },
      data: { status: "REVERSED", note },
    });

    this.logger.warn(
      `STORNO FX revalorizacije ${run.id} (${run.currency} ${fmtDate(run.asOfDate)}) — ` +
        `nalog ${run.journalEntryId ?? "—"} → storno ${stornoEntryId ?? "—"}`,
    );

    return { runId: updated.id, status: updated.status, stornoEntryId };
  }

  // ── Lista ranijih obračuna ──────────────────────────────────────────────────

  /** Lista obračuna (najnoviji presek prvi); filteri godina / valuta. */
  async list(params: { year?: number; currency?: string } = {}) {
    const where: Prisma.FxRevaluationRunWhereInput = {};
    if (params.currency && params.currency.trim() !== "")
      where.currency = params.currency.trim().toUpperCase();
    if (params.year != null) {
      where.asOfDate = {
        gte: new Date(Date.UTC(params.year, 0, 1)),
        lt: new Date(Date.UTC(params.year + 1, 0, 1)),
      };
    }
    const rows = await this.prisma.fxRevaluationRun.findMany({
      where,
      orderBy: [{ asOfDate: "desc" }, { id: "desc" }],
      take: 200,
    });
    return rows;
  }

  // ── Interni helpers ─────────────────────────────────────────────────────────

  /**
   * Linije naloga kursnih razlika. Po stavci ide razlika na KONTO SAME OTVORENE
   * STAVKE (konto + komitent + broj dokumenta iz otvorene stavke → pada u istu
   * open-items grupu i menja njenu protivvrednost), a zbirna protivstavka ide na
   * 663 (dobitak) odnosno 563 (gubitak).
   *
   * Devizni par se na ove linije NE upisuje: kursna razlika menja isključivo
   * dinarsku protivvrednost, devizni saldo grupe ostaje isti. `currency` se upisuje
   * radi čitljivosti kartice.
   */
  private buildJournalLines(
    preview: FxRevaluationPreview,
    postable: FxRevaluationItem[],
    description: string,
  ) {
    const lines: Array<{
      accountCode: string;
      analyticalCode?: number | null;
      debit?: string;
      credit?: string;
      description?: string;
      documentNumber?: string | null;
      currency?: string | null;
    }> = [];

    for (const item of postable) {
      const positive = item.difference.greaterThan(0);
      const abs = item.difference.abs().toFixed(MONEY_SCALE);
      lines.push({
        accountCode: item.accountCode,
        analyticalCode: item.analyticalCode,
        debit: positive ? abs : "0",
        credit: positive ? "0" : abs,
        description: truncate(
          `Kursna razlika ${preview.currency} ${fmtDate(preview.asOfDate)}` +
            (item.documentNumber ? ` — ${item.documentNumber}` : ""),
        ),
        documentNumber: item.documentNumber,
        currency: preview.currency,
      });
    }

    // Zbirne protivstavke rezultata (jedna po pravcu; nula se ne knjiži).
    if (preview.gainTotal.greaterThan(0)) {
      lines.push({
        accountCode: FX_GAIN_ACCOUNT,
        analyticalCode: null,
        debit: "0",
        credit: preview.gainTotal.toFixed(MONEY_SCALE),
        description: truncate(`Pozitivne kursne razlike — ${description}`),
      });
    }
    if (preview.lossTotal.greaterThan(0)) {
      lines.push({
        accountCode: FX_LOSS_ACCOUNT,
        analyticalCode: null,
        debit: preview.lossTotal.toFixed(MONEY_SCALE),
        credit: "0",
        description: truncate(`Negativne kursne razlike — ${description}`),
      });
    }

    return lines;
  }

  /**
   * Saglasnost deviznog i dinarskog salda grupe (review C2 §5). Vraća `null` kad je
   * grupa ispravan devizni par, inače opis problema.
   *
   * Zašto je potrebno: faktura 1.000 EUR / 117.000 RSD delimično zatvorena uplatom od
   * 58.500 RSD BEZ deviznog para ostaje sa deviznim saldom 1.000 EUR i dinarskim
   * saldom 58.500 → „razlika" 61.500 umesto ~1.500. To NIJE kursna razlika nego
   * neproknjižen devizni par, i takva grupa se ne sme tiho proknjižiti na 663/563.
   *
   * Mera je IMPLICITNA KNJIGOVODSTVENA STOPA = dinarski saldo / devizni saldo. Poredi
   * se sa kursom na dan preseka; odstupanje preko {@link IMPLIED_RATE_TOLERANCE} je
   * sporno. Suprotan predznak i devizni saldo 0 uz nenulti dinarski su isti rod greške.
   */
  private checkFxPair(
    fxAmount: Prisma.Decimal,
    bookedAmount: Prisma.Decimal,
    rate: Prisma.Decimal,
  ): {
    code: string;
    message: string;
    impliedRate: Prisma.Decimal | null;
  } | null {
    if (fxAmount.isZero()) {
      if (bookedAmount.isZero()) return null;
      return {
        code: "NO_FX_PAIR",
        impliedRate: null,
        message:
          `Grupa ima dinarski saldo ${bookedAmount.toFixed(MONEY_SCALE)} bez deviznog ` +
          `salda — devizni par nije knjižen. Ispravi knjiženje (devizno duguje/potražuje) ` +
          `pa ponovi obračun.`,
      };
    }

    const impliedRate = bookedAmount.div(fxAmount);
    if (impliedRate.lessThanOrEqualTo(0))
      return {
        code: "FX_SIGN_MISMATCH",
        impliedRate,
        message:
          `Devizni saldo (${fxAmount.toFixed(MONEY_SCALE)}) i dinarski saldo ` +
          `(${bookedAmount.toFixed(MONEY_SCALE)}) su suprotnog predznaka — ` +
          `devizni iznos je knjižen na pogrešnu stranu. Grupa nije obračunata.`,
      };

    const deviation = impliedRate.sub(rate).abs().div(rate);
    if (deviation.greaterThan(IMPLIED_RATE_TOLERANCE))
      return {
        code: "RATE_MISMATCH",
        impliedRate,
        message:
          `Knjigovodstvena stopa grupe je ${impliedRate.toFixed(RATE_SCALE)} ` +
          `(${bookedAmount.toFixed(MONEY_SCALE)} RSD / ${fxAmount.toFixed(MONEY_SCALE)}), ` +
          `a kurs na dan preseka je ${rate.toFixed(RATE_SCALE)} — odstupanje ` +
          `${deviation.mul(100).toFixed(1)}%. Najčešći uzrok je delimično zatvaranje ` +
          `knjiženo samo u dinarima (bez deviznog para). Grupa nije obračunata; ` +
          `uključi je svesno opcijom „uključi sporne stavke" ako je knjiženje ispravno.`,
      };

    return null;
  }

  /**
   * Poređenje sa odobrenim pregledom (review C2 §7). Vrednosti su opcione — pozivalac
   * koji ih ne pošalje (skripta, stari klijent) radi kao do sada; kad ih pošalje, moraju
   * da se poklope, inače 409 i ponovni pregled.
   */
  private assertMatchesPreview(
    dto: FxRevaluationRunDto,
    preview: FxRevaluationPreview,
  ): void {
    const expectedRate = parseExpectedDecimal(dto.expectedRate, "expectedRate");
    if (
      expectedRate != null &&
      !expectedRate
        .toDecimalPlaces(RATE_SCALE)
        .equals(preview.rate.toDecimalPlaces(RATE_SCALE))
    )
      throw new ConflictException(
        `Kurs se promenio od pregleda: pregled je bio po ` +
          `${expectedRate.toFixed(RATE_SCALE)}, a sada važi ` +
          `${preview.rate.toFixed(RATE_SCALE)}. Ponovi pregled pa potvrdi obračun.`,
      );

    const expectedNet = parseExpectedDecimal(
      dto.expectedNetAmount,
      "expectedNetAmount",
    );
    if (
      expectedNet != null &&
      !expectedNet
        .toDecimalPlaces(MONEY_SCALE)
        .equals(preview.netAmount.toDecimalPlaces(MONEY_SCALE))
    )
      throw new ConflictException(
        `Podaci su se promenili od pregleda: neto efekat je bio ` +
          `${expectedNet.toFixed(MONEY_SCALE)}, a sada je ` +
          `${preview.netAmount.toFixed(MONEY_SCALE)}. Ponovi pregled pa potvrdi obračun.`,
      );
  }

  /**
   * Konta rezultata moraju postojati u kontnom planu (LedgerEntry ima FK na Account) —
   * jasna 422 umesto opaque FK 500 (isti obrazac kao NIV knjiženje u posting.service.ts).
   * Proverava se samo konto koji se stvarno knjiži.
   */
  private async assertResultAccountsExist(
    gainTotal: Prisma.Decimal,
    lossTotal: Prisma.Decimal,
  ): Promise<void> {
    const needed: string[] = [];
    if (gainTotal.greaterThan(0)) needed.push(FX_GAIN_ACCOUNT);
    if (lossTotal.greaterThan(0)) needed.push(FX_LOSS_ACCOUNT);
    if (needed.length === 0) return;

    const present = await this.prisma.account.findMany({
      where: { code: { in: needed } },
      select: { code: true },
    });
    const codes = new Set(present.map((a) => a.code));
    const missing = needed.filter((c) => !codes.has(c));
    if (missing.length)
      throw new UnprocessableEntityException(
        `Konta za knjiženje kursnih razlika nisu u kontnom planu: ${missing.join(", ")}. ` +
          `Definiši konta pre obračuna.`,
      );
  }

  /** Presek u budućnosti nije dozvoljen ni kad datum stigne kao Date (interni poziv). */
  private assertNotFuture(d: Date): Date {
    if (Number.isNaN(d.getTime()))
      throw new ConflictException("Neispravan datum preseka.");
    if (d.getTime() > Date.now())
      throw new ConflictException(
        `Datum preseka (${fmtIso(d)}) je u budućnosti — kurs za taj dan ne postoji.`,
      );
    return d;
  }
}

// ─────────────────────────────────────────────────────────────── formatiranje

/** Datum dd.MM.yyyy. (srpski — ide u opis stavke naloga i poruke). */
function fmtDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}.`;
}

function fmtIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** LedgerEntry.description je VarChar(255) — duži opis se seče, ne ruši upis. */
function truncate(text: string, max = 255): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
