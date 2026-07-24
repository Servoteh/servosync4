import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma, type ExchangeRate } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import {
  RATE_FIELDS,
  RATE_TYPES,
  normalizeCurrency,
  validateCopyExchangeRates,
  validateCreateExchangeRate,
  validateUpdateExchangeRate,
  type CopyExchangeRatesDto,
  type CreateExchangeRateDto,
  type ExchangeRateType,
  type UpdateExchangeRateDto,
} from "./dto/exchange-rate.dto";

const D = Prisma.Decimal;
const DEFAULT_WINDOW_DAYS = 60; // lista bez from/to → poslednjih 60 dana (O2: ~100 deviznih izvoda/god)

/** Kolona decimalne stope po tipu kursa (resolver bira jednu od tri). */
/** Srpski nazivi tipova kursa za poruke korisniku (guard nulte stope). */
const TYPE_LABEL: Record<ExchangeRateType, string> = {
  buy: "kupovnog",
  middle: "srednjeg",
  sell: "prodajnog",
};

const TYPE_TO_FIELD: Record<ExchangeRateType, (typeof RATE_FIELDS)[number]> = {
  buy: "buyRate",
  middle: "middleRate",
  sell: "sellRate",
};

/** Rezultat resolvera — izabrana stopa + rateDate koji je STVARNO upotrebljen. */
export interface ResolvedRate {
  currency: string;
  type: ExchangeRateType;
  rate: Prisma.Decimal; // izabrana stopa (buy/middle/sell)
  rateDate: Date; // datum reda koji je upotrebljen (≤ traženog dana)
  requestedOn: Date; // dan za koji je kurs tražen
  row: ExchangeRate; // ceo red (sve tri stope) — za pozivaoce kojima treba više
}

/**
 * EXCHANGE RATE SERVICE — registar kursne liste (ExchangeRate → `exchange_rates`) +
 * datumski resolver kursa za konverziju u RSD.
 * ============================================================================
 * BigBit pravila (doc 09 §banking — „KursnaListaNaDanZaNaloge"):
 *   • IZVODI / nalozi za plaćanje = PRODAJNI kurs (sellRate) — zato resolver default = "sell".
 *   • Blagajna = SREDNJI kurs (middleRate).
 *   • Vikend/praznik = poslednji RANIJI datum (najnoviji rateDate ≤ traženi dan).
 *
 * Resolver ({@link resolve}) je EXPORT-ovan kao javna metoda servisa: drugi servis u
 * istom modulu (npr. konverzija stavke izvoda: amount RSD = foreignAmount × kurs) ga
 * injektuje i množi `foreignAmount` sa `rate`. `amount` na stavci izvoda je UVEK RSD
 * protivvrednost (doc 09 §banking).
 *
 * Poslovne greške = ugrađeni NestJS exception-i (400/404/409/422), kao ostatak repoa.
 * Decimal u JSON-u = string (BACKEND_RULES §6) — serializacija toFixed(6).
 */
@Injectable()
export class ExchangeRateService {
  constructor(private readonly prisma: PrismaService) {}

  // ── Lista ─────────────────────────────────────────────────────────────────

  /**
   * Lista kurseva. Filteri: `currency` (tačna valuta), `from`/`to` (opseg rateDate).
   * Bez from/to → default poslednjih {@link DEFAULT_WINDOW_DAYS} dana (registar prozor).
   */
  async list(params: { currency?: string; from?: string; to?: string }) {
    const where: Prisma.ExchangeRateWhereInput = {};

    if (params.currency && params.currency.trim() !== "")
      where.currency = normalizeCurrency(params.currency);

    const from = this.parseDateOrThrow(params.from, "from");
    const to = this.parseDateOrThrow(params.to, "to");
    if (from || to) {
      where.rateDate = {};
      if (from) where.rateDate.gte = from;
      if (to) where.rateDate.lte = to;
    } else {
      const since = new Date();
      since.setDate(since.getDate() - DEFAULT_WINDOW_DAYS);
      where.rateDate = { gte: since };
    }

    const rows = await this.prisma.exchangeRate.findMany({
      where,
      orderBy: [{ rateDate: "desc" }, { currency: "asc" }],
    });
    return { data: rows.map((r) => this.serialize(r)), meta: { count: rows.length } };
  }

  // ── Resolver (EXPORT za druge servise) ──────────────────────────────────────

  /**
   * Najnoviji kurs za `currency` na dan `on` (default danas), tip `type` (default "sell"
   * = izvodi/nalozi). Pravilo: najnoviji `rateDate` ≤ `on` (vikend/praznik → poslednji
   * raniji dan). Nema nijednog reda → 404 sa srpskom porukom.
   *
   * Javna, INJEKTABILNA metoda — drugi servis u modulu je zove za konverziju stavke u RSD.
   * Pozivni oblik prati bank-statement.service.ts (pozicioni argumenti; `on` prima i Date):
   *   `const { rate, rateDate } = await exchangeRates.resolve(currency, statementDate, "sell");`
   *   `const amountRsd = foreignAmount.mul(rate);`
   */
  async resolve(
    currency: string,
    on?: string | Date,
    type?: string,
  ): Promise<ResolvedRate> {
    const cur =
      typeof currency === "string" ? normalizeCurrency(currency) : "";
    if (cur === "")
      throw new UnprocessableEntityException("Parametar currency je obavezan.");

    const requestedOn = on instanceof Date ? on : this.asOf(on);
    const resolvedType = this.parseType(type);

    // Guard nulte stope (review E6 VISOK ×2): red sa neunetom TRAŽENOM kolonom (0) se
    // preskače kao da ne postoji — inače bi devizna stavka tiho dobila amount = 0 RSD
    // (100 EUR × 0 = 0, balans 0=0 prolazi, GK dobija nulu umesto protivvrednosti).
    // Filter po koloni > 0 pokriva i vikend-fallback: traži se poslednji dan koji IMA taj tip kursa.
    const rateField = TYPE_TO_FIELD[resolvedType];
    const row = await this.prisma.exchangeRate.findFirst({
      where: {
        currency: cur,
        rateDate: { lte: requestedOn },
        [rateField]: { gt: 0 },
      },
      orderBy: { rateDate: "desc" },
    });
    if (!row)
      throw new NotFoundException(
        `Nema ${TYPE_LABEL[resolvedType]} kursa za ${cur} na dan ${this.fmt(requestedOn)} — unesi kursnu listu (kolona ${TYPE_LABEL[resolvedType]} mora biti popunjena).`,
      );

    const rate = new D(row[rateField] as Prisma.Decimal);
    return {
      currency: cur,
      type: resolvedType,
      rate,
      rateDate: row.rateDate,
      requestedOn,
      row,
    };
  }

  /** HTTP omotač resolvera — vraća `{ data }` envelope (Decimal → string) za kontroler. */
  async resolveEnvelope(currency?: string, on?: string, type?: string) {
    if (typeof currency !== "string" || currency.trim() === "")
      throw new UnprocessableEntityException("Parametar currency je obavezan.");

    const r = await this.resolve(currency, on, type);
    return {
      data: {
        currency: r.currency,
        type: r.type,
        rate: r.rate.toFixed(6),
        rateDate: r.rateDate,
        requestedOn: this.fmt(r.requestedOn),
        // Ceo red (sve tri stope) — pozivaocu koji hoće i ostale kurseve.
        buyRate: r.row.buyRate.toFixed(6),
        middleRate: r.row.middleRate.toFixed(6),
        sellRate: r.row.sellRate.toFixed(6),
        source: r.row.source,
      },
    };
  }

  // ── Unos / izmena ───────────────────────────────────────────────────────────

  /** Nova kursna stavka. Duplikat (rateDate,currency) → P2002 → 409 sa porukom. */
  async create(dto: CreateExchangeRateDto) {
    validateCreateExchangeRate(dto);
    const currency = normalizeCurrency(dto.currency);
    const rateDate = new Date(dto.rateDate);

    try {
      const row = await this.prisma.exchangeRate.create({
        data: {
          rateDate,
          currency,
          buyRate: dto.buyRate ?? 0,
          middleRate: dto.middleRate ?? 0,
          sellRate: dto.sellRate ?? 0,
          source: dto.source ?? "RUCNO",
          note: dto.note ?? null,
        },
      });
      return { data: this.serialize(row) };
    } catch (e) {
      this.rethrowDuplicate(e, currency, rateDate);
    }
  }

  /** Izmena kursne stavke (PATCH). Promena (rateDate,currency) koja udari @@unique → 409. */
  async update(id: number, dto: UpdateExchangeRateDto) {
    validateUpdateExchangeRate(dto);
    const current = await this.prisma.exchangeRate.findUnique({ where: { id } });
    if (!current) throw new NotFoundException(`Kurs ${id} ne postoji.`);

    const data: Prisma.ExchangeRateUpdateInput = {};
    if (dto.rateDate !== undefined) data.rateDate = new Date(dto.rateDate);
    if (dto.currency !== undefined) data.currency = normalizeCurrency(dto.currency);
    if (dto.buyRate !== undefined) data.buyRate = dto.buyRate;
    if (dto.middleRate !== undefined) data.middleRate = dto.middleRate;
    if (dto.sellRate !== undefined) data.sellRate = dto.sellRate;
    if (dto.source !== undefined) data.source = dto.source;
    if (dto.note !== undefined) data.note = dto.note;

    const currency =
      dto.currency !== undefined ? normalizeCurrency(dto.currency) : current.currency;
    const rateDate = dto.rateDate !== undefined ? new Date(dto.rateDate) : current.rateDate;

    try {
      const row = await this.prisma.exchangeRate.update({ where: { id }, data });
      return { data: this.serialize(row) };
    } catch (e) {
      this.rethrowDuplicate(e, currency, rateDate);
    }
  }

  // ── Prepiši od datuma za datum (BigBit „Formiraj iz datuma za datum") ─────────

  /**
   * Kopira SVE valute sa `fromDate` na `toDate` (source='PREPIS'), preskačući postojeće
   * (toDate,valuta) parove. Vraća koliko je kopirano/preskočeno. Za vikend/praznik kad NBS
   * ne objavljuje kurs — prepiše se poslednji radni dan.
   */
  async copyFrom(dto: CopyExchangeRatesDto) {
    validateCopyExchangeRates(dto);
    const from = new Date(dto.fromDate);
    const to = new Date(dto.toDate);

    const sources = await this.prisma.exchangeRate.findMany({
      where: { rateDate: from },
    });
    if (sources.length === 0)
      throw new UnprocessableEntityException(
        `Nema kursne liste za dan ${this.fmt(from)} — nema šta da se prepiše.`,
      );

    const targets = await this.prisma.exchangeRate.findMany({
      where: { rateDate: to },
      select: { currency: true },
    });
    const existing = new Set(targets.map((t) => t.currency));

    const toCreate = sources.filter((s) => !existing.has(s.currency));
    const skipped = sources.length - toCreate.length;

    if (toCreate.length > 0) {
      await this.prisma.exchangeRate.createMany({
        data: toCreate.map((s) => ({
          rateDate: to,
          currency: s.currency,
          buyRate: s.buyRate,
          middleRate: s.middleRate,
          sellRate: s.sellRate,
          source: "PREPIS",
          note: s.note,
        })),
        skipDuplicates: true, // dodatna zaštita od trke sa paralelnim unosom
      });
    }

    return {
      data: {
        copied: toCreate.length,
        skipped,
        fromDate: this.fmt(from),
        toDate: this.fmt(to),
      },
    };
  }

  // ── Interni helpers ───────────────────────────────────────────────────────

  /** P2002 (unique rateDate+currency) → 409 sa jasnom porukom; ostale greške propuštamo. */
  private rethrowDuplicate(e: unknown, currency: string, rateDate: Date): never {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")
      throw new ConflictException(
        `Kurs za ${currency} na dan ${this.fmt(rateDate)} već postoji — izmeni postojeći red.`,
      );
    throw e as Error;
  }

  private parseType(type?: string): ExchangeRateType {
    if (type === undefined || type === "") return "sell";
    if ((RATE_TYPES as readonly string[]).includes(type))
      return type as ExchangeRateType;
    throw new UnprocessableEntityException(
      "Parametar type mora biti buy, middle ili sell.",
    );
  }

  private parseDateOrThrow(v: string | undefined, name: string): Date | null {
    if (v === undefined || v === "") return null;
    const d = new Date(v);
    if (Number.isNaN(d.getTime()))
      throw new UnprocessableEntityException(
        `Parametar ${name} mora biti validan datum (YYYY-MM-DD).`,
      );
    return d;
  }

  private asOf(on?: string): Date {
    if (on === undefined || on === "") return new Date();
    const d = new Date(on);
    if (Number.isNaN(d.getTime()))
      throw new UnprocessableEntityException(
        "Parametar on mora biti validan datum (YYYY-MM-DD).",
      );
    return d;
  }

  private fmt(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  private serialize(r: ExchangeRate) {
    return {
      id: r.id,
      rateDate: r.rateDate,
      currency: r.currency,
      buyRate: r.buyRate.toFixed(6),
      middleRate: r.middleRate.toFixed(6),
      sellRate: r.sellRate.toFixed(6),
      source: r.source,
      note: r.note,
    };
  }
}
