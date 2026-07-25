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

/** Rezultat `preview` — bez ijednog upisa. */
export interface FxRevaluationPreview {
  asOfDate: Date;
  currency: string;
  companyId: number;
  /** Kurs upotrebljen za preračun (srednji na dan preseka). */
  rate: Prisma.Decimal;
  /** Datum kursne liste koja je STVARNO upotrebljena (vikend/praznik → raniji dan). */
  rateDate: Date;
  rateType: string;
  items: FxRevaluationItem[];
  itemsCount: number;
  /** Σ pozitivnih razlika (prihod 663). */
  gainTotal: Prisma.Decimal;
  /** Σ apsolutnih negativnih razlika (rashod 563). */
  lossTotal: Prisma.Decimal;
  /** gainTotal − lossTotal (neto efekat na rezultat). */
  netAmount: Prisma.Decimal;
}

/** Rezultat `run` — obračun + broj naloga kursnih razlika. */
export interface FxRevaluationRunResult {
  runId: number;
  asOfDate: Date;
  currency: string;
  companyId: number;
  rateUsed: Prisma.Decimal;
  gainAmount: Prisma.Decimal;
  lossAmount: Prisma.Decimal;
  itemsCount: number;
  journalEntryId: number;
  journalNumber: string;
  status: string;
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
   */
  async preview(params: {
    asOfDate: string | Date;
    currency: string;
    companyId?: number;
  }): Promise<FxRevaluationPreview> {
    const asOfDate =
      params.asOfDate instanceof Date
        ? this.assertNotFuture(params.asOfDate)
        : parseAsOfDate(params.asOfDate);
    const currency = normalizeFxCurrency(params.currency);
    const companyId = params.companyId ?? 0;

    // Kurs na dan preseka (404 sa srpskom porukom ako kursne liste nema).
    const resolved = await this.exchangeRates.resolve(
      currency,
      asOfDate,
      FX_RATE_TYPE,
    );

    // Otvorene stavke: presek na dan + samo grupe u traženoj valuti. Filter
    // 'posted'+'locked' i uparivanje na dan preseka su u OpenItemsService.
    const openItems = await this.openItems.listOpenItems(
      undefined,
      undefined,
      asOfDate,
      { fxCurrency: currency, companyId: params.companyId },
    );

    let gainTotal = ZERO;
    let lossTotal = ZERO;
    const items: FxRevaluationItem[] = [];

    for (const oi of openItems) {
      const fxAmount = oi.fxAmount ?? ZERO;
      const bookedAmount = oi.balance;
      const revaluedAmount = fxAmount
        .mul(resolved.rate)
        .toDecimalPlaces(MONEY_SCALE);
      const difference = revaluedAmount.sub(bookedAmount);

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
      rateType: resolved.type,
      items,
      itemsCount: items.length,
      gainTotal,
      lossTotal,
      netAmount: gainTotal.sub(lossTotal),
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
    });

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
        `nalog ${FX_ORDER_TYPE}-${result.journalNumber}`,
    );

    return {
      runId: result.run.id,
      asOfDate: result.run.asOfDate,
      currency: result.run.currency,
      companyId: result.run.companyId,
      rateUsed: result.run.rateUsed,
      gainAmount: result.run.gainAmount,
      lossAmount: result.run.lossAmount,
      itemsCount: result.run.itemsCount,
      journalEntryId: result.run.journalEntryId as number,
      journalNumber: result.journalNumber,
      status: result.run.status,
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
