import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { ZERO } from "./decimal.util";
import {
  V_STOCK_MOVEMENTS,
  stockKeyOf,
  type StockKey,
} from "./stock-movements";

/** Klijent koji ume raw upit — `PrismaService` ili `tx` iz `$transaction`. */
type CostingDb = Pick<PrismaService, "$queryRaw"> | Prisma.TransactionClient;

/**
 * CostingService — ponderisani prosek "u letu" (AS-OF) iz kretanja.
 *
 * Izvor formule: `backend/docs/migration/39-robno-inventory-kalkulacija.md` §C
 * (`KLProsecnaVPCenaZalihaNaDan1Korak.sql`), VERBATIM:
 *
 *   ProsecnaKalkVPCena = Σ(±Kol * KalkVP)                / Σ(±Kol)
 *   ProsecnaNabCena    = Σ(±Kol * (NabNeto + ZTsop + ZTdob)) / Σ(±Kol)
 *
 * IZVOR PODATAKA: pogled `v_stock_movements` (`stock-movements.ts`) — on nosi predikat
 * kretanja (KODJ izuzet, `affects_stock`, soft-delete) i znak `±Kol` (`signed_quantity`,
 * iz `DocumentType.isInbound`). Ovde se ti uslovi NE PREPISUJU; do 04.08.2026. jesu, u
 * tri upita ovog fajla i sedam drugde, a doslednost je držao samo komentar.
 *
 * NE FIFO, NE LIFO. NEMA perzistentne tabele stanja — izvor istine je AS-OF upit nad
 * kretanjima (doc 39 §C, odluka Nenad 18.07). `StockLevel` je samo opcioni keš, ne koristi se.
 *
 * NAPOMENA: `goods_documents` je PRAZNA i izbačena iz sync-a → costing čita samo
 * 2.0-native robne tabele (NEMA UNION-a).
 */
@Injectable()
export class CostingService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Stanje na dan za VIŠE (artikal, magacin) parova odjednom — JEDAN upit bez obzira na
   * broj parova. Vraća mapu `stockKeyOf(itemId, warehouseId) → Σ(±Kol)`; par bez ijednog
   * kretanja se u mapi NE pojavljuje (pozivalac uzima 0).
   *
   * ZAŠTO POSTOJI (review 04.08): guard dovoljnog stanja je zvao `stateAsOf` u petlji, po
   * jedan upit za svaku stavku — i to UNUTAR transakcije koja već drži advisory lock na
   * svim tim ključevima. Izdatnica sa 60 stavki = 60 uzastopnih upita dok 60 ključeva
   * stoji zaključano, pa svaki drugi izlaz za te artikle čeka. Rezervacije su isti posao
   * već radile jednim agregatom (`computeOnHand`); stanje sada radi isto.
   */
  async stateAsOfMany(
    keys: readonly StockKey[],
    asOf: Date,
    opts?: { excludeDocId?: number; tx?: Prisma.TransactionClient },
  ): Promise<Map<string, Prisma.Decimal>> {
    const out = new Map<string, Prisma.Decimal>();
    if (keys.length === 0) return out;

    // Tačan par (artikal, magacin), ne kartezijanski proizvod dve `IN` liste — inače bi se
    // agregiralo i po parovima koje niko nije tražio (bezopasno po rezultat, ali skuplje).
    const uniquePairs = [
      ...new Map(
        keys.map((k) => [stockKeyOf(k.itemId, k.warehouseId), k]),
      ).values(),
    ];
    const pairs = Prisma.join(
      uniquePairs.map((k) => Prisma.sql`(${k.itemId}, ${k.warehouseId})`),
    );
    const exclude =
      opts?.excludeDocId != null
        ? Prisma.sql`AND m.document_id <> ${opts.excludeDocId}`
        : Prisma.empty;

    const client: CostingDb = opts?.tx ?? this.prisma;
    const rows = await client.$queryRaw<
      Array<{ item_id: number; warehouse_id: number; state: Prisma.Decimal }>
    >(Prisma.sql`
      SELECT m.item_id, m.warehouse_id, COALESCE(SUM(m.signed_quantity), 0) AS state
      FROM ${V_STOCK_MOVEMENTS} m
      WHERE (m.item_id, m.warehouse_id) IN (${pairs})
        AND m.document_date <= ${asOf}
        ${exclude}
      GROUP BY m.item_id, m.warehouse_id
    `);
    for (const r of rows)
      out.set(
        stockKeyOf(r.item_id, r.warehouse_id),
        new Prisma.Decimal(r.state ?? 0),
      );
    return out;
  }

  /**
   * Stanje na dan: Σ(±Kol) za (artikal, magacin) do `asOf` uključivo.
   *
   * Vraća `Prisma.Decimal` (može biti negativno — negativne zalihe su moguće, doc 39 §C
   * `NZ_NegativneZalihe.sql`).
   *
   * `excludeDocId`: stanje PRE tekućeg ulaza. Nivelacija računa zatečeno stanje pre nego
   * što ovaj UL zaduži magacin; bez toga bi `document_date <= asOf` uračunao i sam tekući
   * (već upisan) dokument → lažno stanje → pogrešna nivelacija (INIT umesto LEVELED).
   * `tx`: čitaj kroz istu transakciju kao pisac.
   *
   * Za više parova koristi `stateAsOfMany` — ova metoda je tanak omotač nad njom, da
   * jedan te isti upit postoji na jednom mestu.
   */
  async stateAsOf(
    itemId: number,
    warehouseId: number,
    asOf: Date,
    opts?: { excludeDocId?: number; tx?: Prisma.TransactionClient },
  ): Promise<Prisma.Decimal> {
    const byKey = await this.stateAsOfMany(
      [{ itemId, warehouseId }],
      asOf,
      opts,
    );
    return byKey.get(stockKeyOf(itemId, warehouseId)) ?? ZERO;
  }

  /**
   * Ponderisana prosečna nabavna i VP cena na dan (doc 39 §C, VERBATIM):
   *
   *   avgPurchaseNet = Σ(±Kol * (A+B+C)) / Σ(±Kol)
   *   avgWholesale   = Σ(±Kol * KalkVP)  / Σ(±Kol)
   *
   * Gde A+B+C = `unit_purchase_net`, KalkVP = `unit_wholesale` (kolone pogleda).
   *
   * Fallback (doc 39 §C: "Stanje 0 → fallback poslednja cena"): kada `Σ(±Kol) = 0`,
   * vraća se cena sa poslednjeg ULAZA.
   *
   * Prekidač `Warehouse.averagePrices = false` (doc 39 §C: `Magacini.ProsecneCene`):
   * magacin bira POSLEDNJU KalkVP/Nab umesto proseka. NULL → tretira se kao false
   * (`@default(false)`) → poslednja cena.
   */
  async averageAsOf(
    itemId: number,
    warehouseId: number,
    asOf: Date,
  ): Promise<{ avgPurchaseNet: Prisma.Decimal; avgWholesale: Prisma.Decimal }> {
    const warehouse = await this.prisma.warehouse.findUnique({
      where: { id: warehouseId },
      select: { averagePrices: true },
    });
    if (warehouse?.averagePrices !== true) {
      // Magacin ne uprosečava → poslednja cena (poslednji ulaz).
      return this.lastPrice(itemId, warehouseId, asOf);
    }

    const rows = await this.prisma.$queryRaw<
      Array<{
        weight: Prisma.Decimal | null;
        weighted_nab: Prisma.Decimal | null;
        weighted_vp: Prisma.Decimal | null;
      }>
    >(Prisma.sql`
      SELECT
        COALESCE(SUM(m.signed_quantity), 0)                          AS weight,
        COALESCE(SUM(m.signed_quantity * m.unit_purchase_net), 0)    AS weighted_nab,
        COALESCE(SUM(m.signed_quantity * m.unit_wholesale), 0)       AS weighted_vp
      FROM ${V_STOCK_MOVEMENTS} m
      WHERE m.item_id = ${itemId}
        AND m.warehouse_id = ${warehouseId}
        AND m.document_date <= ${asOf}
    `);

    const weight = new Prisma.Decimal(rows[0]?.weight ?? 0);
    // Stanje 0 → prosek nije definisan → fallback poslednja cena (doc 39 §C).
    if (weight.isZero()) return this.lastPrice(itemId, warehouseId, asOf);

    return {
      avgPurchaseNet: new Prisma.Decimal(rows[0]?.weighted_nab ?? 0).div(weight),
      avgWholesale: new Prisma.Decimal(rows[0]?.weighted_vp ?? 0).div(weight),
    };
  }

  /**
   * Poslednja cena — fallback (doc 39 §C: "Stanje 0 → fallback poslednja cena") i put kada
   * `Warehouse.averagePrices = false`. Bira poslednji ULAZ (`is_inbound`) po
   * (document_date, document_id, item_line_id) opadajuće.
   *
   * Ako nema nijednog ulaza → 0/0 (nema podataka o ceni).
   */
  private async lastPrice(
    itemId: number,
    warehouseId: number,
    asOf: Date,
  ): Promise<{ avgPurchaseNet: Prisma.Decimal; avgWholesale: Prisma.Decimal }> {
    const rows = await this.prisma.$queryRaw<
      Array<{ last_nab: Prisma.Decimal | null; last_vp: Prisma.Decimal | null }>
    >(Prisma.sql`
      SELECT m.unit_purchase_net AS last_nab,
             m.unit_wholesale    AS last_vp
      FROM ${V_STOCK_MOVEMENTS} m
      WHERE m.item_id = ${itemId}
        AND m.warehouse_id = ${warehouseId}
        AND m.document_date <= ${asOf}
        AND m.is_inbound = TRUE
      ORDER BY m.document_date DESC, m.document_id DESC, m.item_line_id DESC
      LIMIT 1
    `);
    return {
      avgPurchaseNet: new Prisma.Decimal(rows[0]?.last_nab ?? 0),
      avgWholesale: new Prisma.Decimal(rows[0]?.last_vp ?? 0),
    };
  }
}
