import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";

/**
 * CostingService — ponderisani prosek "u letu" (AS-OF) iz kretanja.
 *
 * Izvor formule: `backend/docs/migration/39-robno-inventory-kalkulacija.md` §C
 * (`KLProsecnaVPCenaZalihaNaDan1Korak.sql`), VERBATIM:
 *
 *   ProsecnaKalkVPCena = Σ(±Kol * KalkVP)                / Σ(±Kol)
 *   ProsecnaNabCena    = Σ(±Kol * (NabNeto + ZTsop + ZTdob)) / Σ(±Kol)
 *
 * Filtri (doc 39 §C): `Datum <= [dan]` (documentDate <= asOf), `IDMagacin`
 * (warehouseId), `Vrsta <> "KODJ"` (documentTypeCode <> 'KODJ' izuzet).
 *
 * Znak `±Kol` (doc 39 §C / PLAN_FAZA_3_IMPL §b): `+` za ulaz, `−` za izlaz —
 * izvodi se iz `DocumentType.isInbound`. Samo dokumenti koji utiču na zalihe
 * (`DocumentType.affectsStock`) ulaze u obračun (legacy `UticeNaZalihe`).
 *
 * NE FIFO, NE LIFO. NEMA perzistentne tabele stanja — izvor istine je ovaj
 * AS-OF upit nad `stock_documents` + `stock_document_items` (doc 39 §C, odluka
 * Nenad 18.07). `StockLevel` je samo opcioni keš, ovde se NE koristi.
 *
 * NAPOMENA (schema.prisma:3046–3049): `goods_documents` je PRAZNA i izbačena iz
 * sync-a → costing čita SAMO native `stock_documents` (NEMA UNION sa
 * `goods_documents`).
 */
@Injectable()
export class CostingService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Stanje na dan: Σ(±Kol) za (artikal, magacin) do `asOf` uključivo.
   *
   * Doc 39 §C: `Vrsta <> "KODJ"` izuzet, znak iz smera dokumenta (UL/+, IZ/−).
   * Vraća `Prisma.Decimal` (može biti negativno — negativne zalihe su moguće,
   * doc 39 §C `NZ_NegativneZalihe.sql`).
   */
  async stateAsOf(
    itemId: number,
    warehouseId: number,
    asOf: Date,
  ): Promise<Prisma.Decimal> {
    const rows = await this.prisma.$queryRaw<{ state: Prisma.Decimal | null }[]>(
      Prisma.sql`
        SELECT COALESCE(SUM(
                 CASE WHEN dt.is_inbound THEN sdi.quantity ELSE -sdi.quantity END
               ), 0) AS state
        FROM stock_document_items sdi
        JOIN stock_documents sd ON sd.id = sdi.document_id
        JOIN document_types dt ON dt.code = sd.document_type_code
        WHERE sdi.item_id = ${itemId}
          AND sdi.warehouse_id = ${warehouseId}
          AND sd.document_date <= ${asOf}
          AND sd.document_type_code <> 'KODJ'
          AND COALESCE(dt.affects_stock, TRUE) = TRUE
      `,
    );
    return new Prisma.Decimal(rows[0]?.state ?? 0);
  }

  /**
   * Ponderisana prosečna nabavna i VP cena na dan (doc 39 §C, VERBATIM):
   *
   *   avgPurchaseNet = Σ(±Kol * (A+B+C)) / Σ(±Kol)
   *   avgWholesale   = Σ(±Kol * KalkVP)  / Σ(±Kol)
   *
   * Gde A=purchasePriceNet, B=dependentCostOwn, C=dependentCostSupplier,
   * KalkVP=calculatedWholesalePrice.
   *
   * Fallback (doc 39 §C: "Stanje 0 → fallback poslednja cena"): kada
   * `Σ(±Kol) = 0`, vraća se cena sa poslednjeg ULAZA (`is_inbound`), sortiranog
   * po (document_date, id) opadajuće.
   *
   * Prekidač `Warehouse.averagePrices = false` (doc 39 §C: `Magacini.ProsecneCene`):
   * magacin bira POSLEDNJU KalkVP/Nab umesto proseka. Ako je magacin nepoznat ili
   * `averagePrices` NULL → tretira se kao FALSE (nije prosečan) samo ako je
   * eksplicitno false; NULL default (`@default(false)`) → poslednja cena. V. dole.
   */
  async averageAsOf(
    itemId: number,
    warehouseId: number,
    asOf: Date,
  ): Promise<{ avgPurchaseNet: Prisma.Decimal; avgWholesale: Prisma.Decimal }> {
    // Prekidač magacina: Warehouse.averagePrices. Kolona POSTOJI u schema.prisma
    // (Boolean? @default(false) @map("average_prices")). Kad je TRUE → prosek;
    // kad je FALSE/NULL → poslednja KalkVP/Nab (magacin ne uprosečava, doc 39 §C).
    const warehouse = await this.prisma.warehouse.findUnique({
      where: { id: warehouseId },
      select: { averagePrices: true },
    });
    const usesAverage = warehouse?.averagePrices === true;

    if (!usesAverage) {
      // Magacin ne uprosečava → poslednja cena (poslednji ulaz).
      return this.lastPrice(itemId, warehouseId, asOf);
    }

    const rows = await this.prisma.$queryRaw<
      {
        weight: Prisma.Decimal | null;
        weighted_nab: Prisma.Decimal | null;
        weighted_vp: Prisma.Decimal | null;
      }[]
    >(
      Prisma.sql`
        SELECT
          COALESCE(SUM(sgn * sdi.quantity), 0) AS weight,
          COALESCE(SUM(sgn * sdi.quantity *
            (sdi.purchase_price_net + sdi.dependent_cost_own + sdi.dependent_cost_supplier)
          ), 0) AS weighted_nab,
          COALESCE(SUM(sgn * sdi.quantity * sdi.calculated_wholesale_price), 0) AS weighted_vp
        FROM stock_document_items sdi
        JOIN stock_documents sd ON sd.id = sdi.document_id
        JOIN document_types dt ON dt.code = sd.document_type_code
        CROSS JOIN LATERAL (
          SELECT CASE WHEN dt.is_inbound THEN 1 ELSE -1 END AS sgn
        ) s
        WHERE sdi.item_id = ${itemId}
          AND sdi.warehouse_id = ${warehouseId}
          AND sd.document_date <= ${asOf}
          AND sd.document_type_code <> 'KODJ'
          AND COALESCE(dt.affects_stock, TRUE) = TRUE
      `,
    );

    const weight = new Prisma.Decimal(rows[0]?.weight ?? 0);

    // Stanje 0 → fallback poslednja cena (doc 39 §C).
    if (weight.isZero()) {
      return this.lastPrice(itemId, warehouseId, asOf);
    }

    const weightedNab = new Prisma.Decimal(rows[0]?.weighted_nab ?? 0);
    const weightedVp = new Prisma.Decimal(rows[0]?.weighted_vp ?? 0);

    return {
      avgPurchaseNet: weightedNab.div(weight),
      avgWholesale: weightedVp.div(weight),
    };
  }

  /**
   * Poslednja cena — fallback (doc 39 §C: "Stanje 0 → fallback poslednja cena")
   * i put kada `Warehouse.averagePrices = false`. Bira poslednji ULAZ
   * (`is_inbound`) po (document_date, id) opadajuće; KODJ izuzet.
   *
   * Ako nema ni jednog ulaza → 0/0 (nema podataka o ceni).
   */
  private async lastPrice(
    itemId: number,
    warehouseId: number,
    asOf: Date,
  ): Promise<{ avgPurchaseNet: Prisma.Decimal; avgWholesale: Prisma.Decimal }> {
    const rows = await this.prisma.$queryRaw<
      {
        last_nab: Prisma.Decimal | null;
        last_vp: Prisma.Decimal | null;
      }[]
    >(
      Prisma.sql`
        SELECT
          (sdi.purchase_price_net + sdi.dependent_cost_own + sdi.dependent_cost_supplier) AS last_nab,
          sdi.calculated_wholesale_price AS last_vp
        FROM stock_document_items sdi
        JOIN stock_documents sd ON sd.id = sdi.document_id
        JOIN document_types dt ON dt.code = sd.document_type_code
        WHERE sdi.item_id = ${itemId}
          AND sdi.warehouse_id = ${warehouseId}
          AND sd.document_date <= ${asOf}
          AND sd.document_type_code <> 'KODJ'
          AND COALESCE(dt.affects_stock, TRUE) = TRUE
          AND dt.is_inbound = TRUE
        ORDER BY sd.document_date DESC, sd.id DESC, sdi.id DESC
        LIMIT 1
      `,
    );
    return {
      avgPurchaseNet: new Prisma.Decimal(rows[0]?.last_nab ?? 0),
      avgWholesale: new Prisma.Decimal(rows[0]?.last_vp ?? 0),
    };
  }
}
