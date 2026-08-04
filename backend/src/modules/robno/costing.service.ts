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
    const byKey = await this.averageAsOfMany([{ itemId, warehouseId }], asOf);
    return (
      byKey.get(stockKeyOf(itemId, warehouseId)) ?? {
        avgPurchaseNet: ZERO,
        avgWholesale: ZERO,
      }
    );
  }

  /**
   * Prosečne cene za VIŠE (artikal, magacin) parova — TRI upita bez obzira na broj parova
   * (prekidači magacina + ponderisani agregat + fallback poslednja cena).
   *
   * ZAŠTO POSTOJI (nalaz domenskog pregleda 04.08): `InventoryService.createCount` je zvao
   * `stateAsOf` + `averageAsOf` U PETLJI po artiklu, a `averageAsOf` je usput radio i lookup
   * magacina — dakle 3–4 upita po artiklu. Predpunjenje popisa magacina sa 5.000 artikala u
   * prometu bilo je preko 15.000 serijskih upita na jednoj sinhronoj ruti. Guard dovoljnog
   * stanja je istu petlju izgubio ranije istog dana; ovo je isto pravilo primenjeno do kraja.
   *
   * Prekidač `Warehouse.averagePrices` se poštuje PO MAGACINU (kao i u pojedinačnoj verziji):
   * magacin koji ne uprosečava ide na poslednju cenu, kao i par čiji je ponder 0.
   */
  async averageAsOfMany(
    keys: readonly StockKey[],
    asOf: Date,
  ): Promise<
    Map<string, { avgPurchaseNet: Prisma.Decimal; avgWholesale: Prisma.Decimal }>
  > {
    const out = new Map<
      string,
      { avgPurchaseNet: Prisma.Decimal; avgWholesale: Prisma.Decimal }
    >();
    if (keys.length === 0) return out;

    const uniquePairs = [
      ...new Map(
        keys.map((k) => [stockKeyOf(k.itemId, k.warehouseId), k]),
      ).values(),
    ];

    // 1) Prekidač po magacinu — jedan upit za sve magacine u skupu.
    const warehouseIds = [...new Set(uniquePairs.map((k) => k.warehouseId))];
    const warehouses = await this.prisma.warehouse.findMany({
      where: { id: { in: warehouseIds } },
      select: { id: true, averagePrices: true },
    });
    const usesAverage = new Set(
      warehouses.filter((w) => w.averagePrices === true).map((w) => w.id),
    );

    const avgPairs = uniquePairs.filter((k) => usesAverage.has(k.warehouseId));
    // Magacin koji ne uprosečava (ili ga nema u tabeli) ide direktno na poslednju cenu.
    const lastPairs = uniquePairs.filter((k) => !usesAverage.has(k.warehouseId));

    // 2) Ponderisani agregat za magacine koji uprosečavaju.
    if (avgPairs.length) {
      const pairs = Prisma.join(
        avgPairs.map((k) => Prisma.sql`(${k.itemId}, ${k.warehouseId})`),
      );
      const rows = await this.prisma.$queryRaw<
        Array<{
          item_id: number;
          warehouse_id: number;
          weight: Prisma.Decimal;
          weighted_nab: Prisma.Decimal;
          weighted_vp: Prisma.Decimal;
        }>
      >(Prisma.sql`
        SELECT m.item_id, m.warehouse_id,
               COALESCE(SUM(m.signed_quantity), 0)                       AS weight,
               COALESCE(SUM(m.signed_quantity * m.unit_purchase_net), 0) AS weighted_nab,
               COALESCE(SUM(m.signed_quantity * m.unit_wholesale), 0)    AS weighted_vp
        FROM ${V_STOCK_MOVEMENTS} m
        WHERE (m.item_id, m.warehouse_id) IN (${pairs})
          AND m.document_date <= ${asOf}
        GROUP BY m.item_id, m.warehouse_id
      `);
      const seen = new Set<string>();
      for (const r of rows) {
        const k = stockKeyOf(r.item_id, r.warehouse_id);
        seen.add(k);
        const weight = new Prisma.Decimal(r.weight ?? 0);
        // Ponder 0 → prosek nije definisan → fallback poslednja cena (doc 39 §C).
        if (weight.isZero()) continue;
        out.set(k, {
          avgPurchaseNet: new Prisma.Decimal(r.weighted_nab ?? 0).div(weight),
          avgWholesale: new Prisma.Decimal(r.weighted_vp ?? 0).div(weight),
        });
      }
      // Par bez ijednog kretanja ILI sa ponderom 0 pada na poslednju cenu.
      for (const k of avgPairs)
        if (!out.has(stockKeyOf(k.itemId, k.warehouseId))) lastPairs.push(k);
    }

    // 3) Poslednja cena (poslednji ULAZ) za ostatak — jedan `DISTINCT ON` upit.
    if (lastPairs.length) {
      const pairs = Prisma.join(
        lastPairs.map((k) => Prisma.sql`(${k.itemId}, ${k.warehouseId})`),
      );
      const rows = await this.prisma.$queryRaw<
        Array<{
          item_id: number;
          warehouse_id: number;
          last_nab: Prisma.Decimal | null;
          last_vp: Prisma.Decimal | null;
        }>
      >(Prisma.sql`
        SELECT DISTINCT ON (m.item_id, m.warehouse_id)
               m.item_id, m.warehouse_id,
               m.unit_purchase_net AS last_nab,
               m.unit_wholesale    AS last_vp
        FROM ${V_STOCK_MOVEMENTS} m
        WHERE (m.item_id, m.warehouse_id) IN (${pairs})
          AND m.document_date <= ${asOf}
          AND m.is_inbound = TRUE
        ORDER BY m.item_id, m.warehouse_id,
                 m.document_date DESC, m.document_id DESC, m.item_line_id DESC
      `);
      for (const r of rows)
        out.set(stockKeyOf(r.item_id, r.warehouse_id), {
          avgPurchaseNet: new Prisma.Decimal(r.last_nab ?? 0),
          avgWholesale: new Prisma.Decimal(r.last_vp ?? 0),
        });
      // Par bez ijednog ulaza → 0/0 (nema podataka o ceni), kao i u pojedinačnoj verziji.
      for (const k of lastPairs) {
        const key = stockKeyOf(k.itemId, k.warehouseId);
        if (!out.has(key))
          out.set(key, { avgPurchaseNet: ZERO, avgWholesale: ZERO });
      }
    }

    return out;
  }

  // NAPOMENA: privatni `lastPrice` (jedan par, `LIMIT 1`) je obrisan 04.08.2026. kad je
  // `averageAsOfMany` preuzeo i fallback granu grupnim `DISTINCT ON` upitom. Ostavljen bi bio
  // MRTVA KOPIJA žive logike — obrazac zbog kojeg je istog dana obrisan `listLagerAsOf`
  // (110 linija, divergentna kopija koju bi neko „popravio" bez efekta). Doc 39 §C fallback
  // („stanje 0 → poslednja cena") živi u `averageAsOfMany`, koraci 2 i 3.
}
