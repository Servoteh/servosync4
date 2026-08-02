import {
  Injectable,
  Logger,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import {
  VAT_RATE_BY_CODE,
  unknownVatCodeMessage,
} from "../gl/posting/vat-rates";
import { computeAvailability, stockKeyOf } from "../robno/reservation.service";
import {
  ITEM_LOOKUP_DEFAULT_KEY,
  ITEM_LOOKUP_DEFAULT_LIMIT,
  ITEM_LOOKUP_KEYS,
  ITEM_LOOKUP_MAX_LIMIT,
  ITEM_LOOKUP_MIN_QUERY,
  type ItemLookupKey,
  type ItemLookupQuery,
  type ItemLookupResult,
  type ItemLookupRow,
  type ItemLookupStock,
} from "./dto/item-lookup.dto";

/** Kolona po ključu pretrage — STATIČKI `Prisma.sql` fragmenti. */
const COLUMN_BY_KEY: Readonly<
  Record<Exclude<ItemLookupKey, "PLU">, Prisma.Sql>
> = {
  CATALOG: Prisma.sql`i.catalog_number`,
  BARCODE: Prisma.sql`i.bar_code`,
  EXT: Prisma.sql`i.external_code`,
  NAME: Prisma.sql`i.name`,
};

/** Kako se ključ zove korisniku (poruke greške su na srpskom). */
const KEY_LABEL: Readonly<Record<ItemLookupKey, string>> = {
  CATALOG: "kataloški broj",
  BARCODE: "barkod",
  EXT: "eksterna šifra",
  NAME: "naziv",
  PLU: "PLU",
};

const STOCK_SOURCE =
  "agregat kretanja (stock_document_items) − otvorene rezervacije";

/** Jedan red sirovog upita nad `items`. */
interface ItemSearchRow {
  id: number;
  catalog_number: string;
  bar_code: string | null;
  external_code: string | null;
  plu: number | null;
  name: string;
  unit: string | null;
  active: boolean | null;
  not_stock_tracked: boolean | null;
  goods_tax_rate_code: string | null;
  service_tax_rate_code: string | null;
}

/**
 * Pretraga artikala za `CodeCombo` (PLAN_UNOS_DOKUMENATA.md §2.4/§3.3/§5.7).
 *
 * `GET /v1/lookups/items?q=&key=&warehouseId=&limit=&includeInactive=`
 *
 * ZAŠTO SIROV SQL, a ne `findMany`:
 *   1. **Redosled po relevantnosti.** BigBit navika iz §2.4 je „tačna šifra + Enter
 *      bira bez otvaranja liste" — tačno poklapanje MORA biti prvi red. Prisma
 *      `orderBy` ne ume `CASE`, pa bi tačan pogodak tonuo ispod delimičnih.
 *   2. **Bekslež nad džokerima.** Prisma `contains` ubacuje korisnički tekst u
 *      `LIKE` parametar BEZ ekraniranja, pa `q=%` vrati CEO šifarnik — baš ono što
 *      zadatak zabranjuje. Ovde se `% _ \` ekraniraju pre slanja.
 *   3. **Trigram indeks.** `ILIKE '%q%'` nad kolonom (ne nad `lower(col)`) je jedini
 *      oblik koji `gin_trgm_ops` indeks može da iskoristi — v. napomenu o indeksu
 *      ispod.
 *
 * ⚠️ INDEKS KOJI NEDOSTAJE (nije u mojoj granici — `prisma/migrations/` je tuđe
 * vlasništvo): pretraga po sredini reči nad `items` danas ide SEQ SCAN-om, jer
 * tabela ima samo `pk_items` i `idx_items_catalog_lower` (funkcionalni indeks za
 * TAČNO poklapanje, beskoristan za `%q%`). Potrebna migracija je opisana u
 * izveštaju; do tada je ovo ~92k redova po pritisku tastera.
 */
@Injectable()
export class ItemLookupService {
  private readonly logger = new Logger(ItemLookupService.name);

  constructor(private readonly prisma: PrismaService) {}

  async search(query: ItemLookupQuery): Promise<ItemLookupResult> {
    const key = parseKey(query.key);
    const limit = parseLimit(query.limit);
    const warehouseId = parseWarehouseId(query.warehouseId);
    const includeInactive = query.includeInactive === "true";
    const term = (query.q ?? "").trim();

    // BRANA 1: kratak upit NE otvara šifarnik. Vraća se prazna lista sa razlogom,
    // ne 422 — korisnik samo još nije dovoljno otkucao, to nije greška.
    if (term.length < ITEM_LOOKUP_MIN_QUERY)
      return empty(
        key,
        term,
        limit,
        warehouseId,
        `Unesite bar ${ITEM_LOOKUP_MIN_QUERY} znaka za pretragu.`,
      );

    // BRANA 2: PLU je celobrojna šifra — slovo u upitu nema šta da nađe.
    const pluValue = key === "PLU" ? parsePlu(term) : null;
    if (key === "PLU" && pluValue === null)
      return empty(
        key,
        term,
        limit,
        warehouseId,
        "PLU je broj — unesite samo cifre.",
      );

    // BRANA 3: nepostojeći magacin bi vratio zalihu 0 za SVE artikle, a to se na
    // ekranu čita kao „nema robe". Greška u parametru mora da vrišti, ne da laže.
    if (warehouseId !== null) await this.assertWarehouseExists(warehouseId);

    const rows = await this.findItems(
      key,
      term,
      pluValue,
      limit,
      includeInactive,
    );
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const [vatByCode, stockByItem] = await Promise.all([
      this.resolveVatPercents(page),
      this.resolveStock(page, warehouseId),
    ]);

    const data: ItemLookupRow[] = page.map((r) => {
      const stockTracked = r.not_stock_tracked !== true;
      const goodsCode = r.goods_tax_rate_code ?? "3";
      const serviceCode = r.service_tax_rate_code ?? "1";
      return {
        id: r.id,
        catalogNumber: r.catalog_number,
        barCode: r.bar_code,
        externalCode: r.external_code,
        plu: r.plu === 0 ? null : r.plu,
        name: r.name,
        unit: r.unit,
        active: r.active !== false,
        stockTracked,
        goodsTaxRateCode: goodsCode,
        serviceTaxRateCode: serviceCode,
        goodsVatRatePercent: (vatByCode.get(goodsCode) ?? ZERO).toFixed(2),
        serviceVatRatePercent: (vatByCode.get(serviceCode) ?? ZERO).toFixed(2),
        stock: stockTracked ? (stockByItem.get(r.id) ?? null) : null,
      };
    });

    return {
      data,
      meta: {
        key,
        q: term,
        limit,
        count: data.length,
        hasMore,
        warehouseId,
        stockSource: warehouseId === null ? null : STOCK_SOURCE,
        stockNote: stockNoteFor(warehouseId, data),
        note: hasMore
          ? `Prikazano prvih ${limit} — suzite pretragu (${KEY_LABEL[key]}).`
          : null,
      },
    };
  }

  // ----------------------------------------------------------------- PRETRAGA

  private async findItems(
    key: ItemLookupKey,
    term: string,
    pluValue: number | null,
    limit: number,
    includeInactive: boolean,
  ): Promise<ItemSearchRow[]> {
    const escaped = escapeLike(term);
    const contains = `%${escaped}%`;
    const startsWith = `${escaped}%`;

    // `ESCAPE` se ne navodi: podrazumevani znak za ekraniranje u LIKE/ILIKE je
    // baš `\`, pa je klauzula suvišna (a u JS šablonu i lomljiva).
    const match =
      key === "PLU"
        ? Prisma.sql`i.plu = ${pluValue}`
        : Prisma.sql`${COLUMN_BY_KEY[key]} ILIKE ${contains}`;

    // Relevantnost: tačno poklapanje → prefiks → sredina reči (§2.4 „tačna šifra
    // + Enter bira bez otvaranja liste").
    // PLU nema rangiranje (traži se tačna jednakost) i NE sme da dobije konstantu
    // u `ORDER BY`: Postgres goli ceo broj tamo čita kao REDNI BROJ kolone, pa bi
    // `ORDER BY 0` oborio upit („position 0 is not in select list").
    const orderBy =
      key === "PLU"
        ? Prisma.sql`ORDER BY i.name ASC, i.id ASC`
        : Prisma.sql`ORDER BY CASE
             WHEN lower(${COLUMN_BY_KEY[key]}) = lower(${term}) THEN 0
             WHEN ${COLUMN_BY_KEY[key]} ILIKE ${startsWith} THEN 1
             ELSE 2 END ASC, i.name ASC, i.id ASC`;

    // „Obrisan" (`to_delete`) se ne prikazuje NIKAD; „neaktivan" samo na izričit
    // zahtev. `COALESCE` jer su obe kolone nullable u legacy sync-kešu — bez njega
    // bi red sa `NULL` ispao iz rezultata (NULL = FALSE nije TRUE).
    const activeFilter = includeInactive
      ? Prisma.empty
      : Prisma.sql`AND COALESCE(i.active, TRUE) = TRUE`;

    // limit + 1 → `hasMore` bez zasebnog COUNT-a (typeahead ne sme dva upita).
    return this.prisma.$queryRaw<ItemSearchRow[]>(Prisma.sql`
      SELECT i.id, i.catalog_number, i.bar_code, i.external_code, i.plu,
             i.name, i.unit, i.active, i.not_stock_tracked,
             i.goods_tax_rate_code, i.service_tax_rate_code
      FROM items i
      WHERE ${match}
        AND COALESCE(i.to_delete, FALSE) = FALSE
        ${activeFilter}
      ${orderBy}
      LIMIT ${limit + 1}
    `);
  }

  // ------------------------------------------------------------------- ZALIHE

  /**
   * Zalihe po artiklu za traženi magacin.
   *
   * IZVOR: `computeAvailability` iz `robno/reservation.service` — ISTI račun koji
   * koriste lager lista i brana izlaza. Tabela `stock_levels` se NE čita: taj
   * snapshot nema nijednog pisca u `src/` (review 25.07), pa bi svaki artikal
   * dobio `onHand = 0` i ekran bi tvrdio da robe nema. Jedna istina o zalihama.
   */
  private async resolveStock(
    rows: readonly ItemSearchRow[],
    warehouseId: number | null,
  ): Promise<Map<number, ItemLookupStock>> {
    const out = new Map<number, ItemLookupStock>();
    if (warehouseId === null || rows.length === 0) return out;

    // Artikli koji se ne vode na zalihama (usluge) se ne pitaju — njihova nula
    // nije podatak nego šum.
    const keys = rows
      .filter((r) => r.not_stock_tracked !== true)
      .map((r) => ({ itemId: r.id, warehouseId }));
    if (keys.length === 0) return out;

    const availability = await computeAvailability(this.prisma, keys);
    const byKey = new Map(
      availability.map((a) => [stockKeyOf(a.itemId, a.warehouseId), a]),
    );
    for (const k of keys) {
      const row = byKey.get(stockKeyOf(k.itemId, k.warehouseId));
      if (row)
        out.set(k.itemId, {
          warehouseId,
          onHand: row.onHand,
          reserved: row.reserved,
          available: row.available,
        });
    }
    return out;
  }

  // -------------------------------------------------------------- PDV TARIFE

  /**
   * ΣStopa (%) po šifri tarife na DANAŠNJI dan — jedan upit za celu stranu.
   *
   * Semantika je namerno identična `CalculationService.taxRateOf`
   * (`robno/calculation.service.ts`): red iz `tax_rates` čiji opseg važenja hvata
   * datum, ΣStopa = osnovna + železnička + gradska + ratna + posebna, a kad reda
   * nema — deljena mapa `VAT_RATE_BY_CODE` (razlomak × 100).
   *
   * ⚠️ Duplikat od desetak linija: `taxRateOf` je `private` u robnom modulu, a
   * izvlačenje u zajednički resolver (plan D1) je izmena TUĐEG fajla — prijavljeno
   * u izveštaju, nije urađeno ovde.
   */
  private async resolveVatPercents(
    rows: readonly ItemSearchRow[],
  ): Promise<Map<string, Prisma.Decimal>> {
    const out = new Map<string, Prisma.Decimal>();
    const codes = [
      ...new Set(
        rows.flatMap((r) => [
          r.goods_tax_rate_code ?? "3",
          r.service_tax_rate_code ?? "1",
        ]),
      ),
    ];
    if (codes.length === 0) return out;

    const asOf = new Date();
    const found = await this.prisma.taxRate.findMany({
      where: {
        code: { in: codes },
        OR: [{ validFrom: null }, { validFrom: { lte: asOf } }],
        AND: [{ OR: [{ validTo: null }, { validTo: { gte: asOf } }] }],
      },
      orderBy: [{ validFrom: "desc" }],
    });
    // Prvi red po šifri pobeđuje (isti `orderBy` kao `findFirst` u kalkulaciji).
    for (const r of found) {
      if (out.has(r.code)) continue;
      out.set(
        r.code,
        new Prisma.Decimal(r.baseRate ?? 0)
          .add(r.railwayRate ?? 0)
          .add(r.cityRate ?? 0)
          .add(r.warRate ?? 0)
          .add(r.specialRate ?? 0),
      );
    }
    for (const code of codes) {
      if (out.has(code)) continue;
      const fraction = VAT_RATE_BY_CODE[code];
      if (fraction === undefined) {
        // ⚠️ JEDINO MESTO GDE TIHA NULA OSTAJE (odluka uz nalaz S3, 02.08.2026), ali
        // više nije tiha — ide u log. Ovo je PRIKAZ: pretraga artikala vraća listu i
        // jedan artikal sa pokvarenom tarifom ne sme da obori ceo picker (operater
        // tada ne može ni da pronađe artikal da bi ga ispravio). Novac se ovde ne
        // računa — čim isti artikal krene u dokument, `PricingService`,
        // `CalculationService` i `PostingEngine` ga odbijaju sa 400/422.
        this.logger.warn(
          `${unknownVatCodeMessage(code)} Artikal iz pretrage nosi tu šifru — ` +
            `u listi je prikazan kao 0 %, a u dokument ne može da uđe.`,
        );
      }
      out.set(code, (fraction ?? ZERO).mul(100));
    }
    return out;
  }

  private async assertWarehouseExists(warehouseId: number): Promise<void> {
    const found = await this.prisma.warehouse.findUnique({
      where: { id: warehouseId },
      select: { id: true },
    });
    if (!found)
      throw new UnprocessableEntityException(
        `Magacin ${warehouseId} ne postoji.`,
      );
  }
}

// --------------------------------------------------------------------- POMOĆNO

const ZERO = new Prisma.Decimal(0);

/**
 * Ekraniranje LIKE džokera. Bez ovoga `q=%` vraća ceo šifarnik, a `q=_` svaki
 * dvoznakovni artikal — pretraga bi postala „izlistaj sve" kroz zadnja vrata.
 * Redosled je bitan: `\` prvi, inače bi se ekranirao sopstveni bekslež.
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function parseKey(raw?: string): ItemLookupKey {
  if (raw === undefined || raw === null || raw.trim() === "")
    return ITEM_LOOKUP_DEFAULT_KEY;
  const upper = raw.trim().toUpperCase();
  const found = ITEM_LOOKUP_KEYS.find((k) => k === upper);
  if (!found)
    throw new UnprocessableEntityException(
      `Nepoznat ključ pretrage „${raw}". Dozvoljeno: ${ITEM_LOOKUP_KEYS.join(", ")}.`,
    );
  return found;
}

/** Podrazumevano 20, tvrdo ograničeno na 50 (bez greške — kao `parsePagination`). */
function parseLimit(raw?: string): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed)) return ITEM_LOOKUP_DEFAULT_LIMIT;
  return Math.min(ITEM_LOOKUP_MAX_LIMIT, Math.max(1, parsed));
}

function parseWarehouseId(raw?: string): number | null {
  if (raw === undefined || raw === null || raw.trim() === "") return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new UnprocessableEntityException(
      "warehouseId mora biti pozitivan ceo broj.",
    );
  return parsed;
}

/** PLU je ceo broj; sve ostalo (razmak, slovo, minus) nije PLU. */
function parsePlu(term: string): number | null {
  if (!/^\d+$/.test(term)) return null;
  const parsed = Number.parseInt(term, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function stockNoteFor(
  warehouseId: number | null,
  data: readonly ItemLookupRow[],
): string | null {
  if (warehouseId === null)
    return "Zalihe nisu tražene — prosledite warehouseId (bez njega je `stock` null, ne nula).";
  if (data.some((r) => !r.stockTracked))
    return "Artikli koji se ne vode na zalihama imaju `stock: null` — to nije stanje 0.";
  return null;
}

function empty(
  key: ItemLookupKey,
  q: string,
  limit: number,
  warehouseId: number | null,
  note: string,
): ItemLookupResult {
  return {
    data: [],
    meta: {
      key,
      q,
      limit,
      count: 0,
      hasMore: false,
      warehouseId,
      stockSource: null,
      stockNote: null,
      note,
    },
  };
}
