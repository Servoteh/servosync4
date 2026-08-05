import { Injectable, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { parseDateParam } from "../../common/date-params";
import { CostingService } from "./costing.service";
import { sumOpenReservations } from "./reservation.service";
import {
  V_STOCK_MOVEMENTS,
  stockKeyOf,
  type StockMovementRow,
} from "./stock-movements";

/**
 * LagerQueryService — IZVEŠTAJNO čitanje zaliha (lager lista + kartica artikla).
 *
 * ZAŠTO JE ODVOJEN OD `RobnoService` (04.08.2026): to su dve stvari koje se menjaju iz
 * različitih razloga i različitom brzinom. Izveštaji se menjaju kad računovođa nešto
 * zatraži — često i bezopasno. Transakciono kreiranje dokumenta (`RobnoService`) menja
 * se retko i opasno, jer drži advisory lock-ove i piše u knjige. Dok su bili u istoj
 * klasi od 1300 linija, delili su isti fajl, iste testove i isti merge konflikt, a
 * čitalac je morao da drži oba modela u glavi.
 *
 * Ovaj servis SAMO ČITA — nema `$transaction`, nema upisa, nema lock-ova. Ako se ovde
 * pojavi upis, znak je da je nešto na pogrešnom mestu.
 *
 * Izvor podataka je pogled `v_stock_movements` (`stock-movements.ts`) — isti koji koristi
 * `CostingService`, pa se lager, kartica i guard izlaza ne mogu razići.
 */
@Injectable()
export class LagerQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly costing: CostingService,
  ) {}

  /**
   * Lager lista (BigBit paritet — stanje zaliha po magacinu + prosečne cene).
   *
   * IZVOR STANJA (review A, 25.07): agregat kretanja — ISTI izvor i isti filtri kao
   * `CostingService.stateAsOf` i kao raspoloživo u rezervacijama. Ranije se čitao
   * `stock_levels` snapshot, koji NIJEDAN kod ne upisuje (nema pisca u `src/`), pa je
   * lager lista bila trajno PRAZNA — a upravo su joj C3 dodali kolone
   * „Rezervisano"/„Raspoloživo". Prosečne cene se računaju istom ponderisanom formulom
   * kao costing (§C):
   *   avgPurchaseNet = Σ(±Kol*(Nab+ZTsop+ZTdob)) / Σ(±Kol),  avgWholesale = Σ(±Kol*KalkVP) / Σ(±Kol).
   *
   * REZERVISANO (C3): `reserved` je AGREGAT otvorenih redova `stock_reservations`
   * (`status='OPEN'`), NE denormalizovana kolona `StockLevel.reserved` — ta kolona je mrtav
   * legacy snapshot koji niko ne upisuje (uvek 0) i namerno se ne dira. Polje
   * `available = onHand − reserved` je ono što se sme obećati kupcu. Jedan agregatni upit
   * po strani (`groupBy`), bez N+1.
   */
  async listLager(query: {
    warehouseId?: number;
    onlyInStock?: boolean;
    q?: string;
    skip?: number;
    take?: number;
  }) {
    const take = Math.min(query.take ?? 100, 500);
    const skip = query.skip ?? 0;

    const warehouseFilter =
      query.warehouseId != null
        ? Prisma.sql`AND m.warehouse_id = ${query.warehouseId}`
        : Prisma.empty;
    // „Samo sa stanjem" se filtrira NAD AGREGATOM (HAVING), da paginacija broji iste redove.
    const havingInStock = query.onlyInStock
      ? Prisma.sql`HAVING SUM(m.signed_quantity) > 0`
      : Prisma.empty;
    // Pretraga MORA u SQL, pre LIMIT/OFFSET: post-filter nad već izvučenom stranom
    // pravi prazne međustrane (pogoci na 3. strani se izgube) i ostavlja `total`
    // nefiltriran, pa i ekran i štampa tiho gube redove.
    const term = query.q?.trim();
    const itemFilter =
      term && term !== ""
        ? Prisma.sql`AND m.item_id IN (
            SELECT i.id FROM items i
            WHERE lower(i.name) LIKE ${`%${term.toLowerCase()}%`}
               OR lower(i.catalog_number) LIKE ${`%${term.toLowerCase()}%`}
          )`
        : Prisma.empty;
    const aggregate = Prisma.sql`
      SELECT m.item_id,
             m.warehouse_id,
             SUM(m.signed_quantity)                        AS on_hand,
             SUM(m.signed_quantity * m.unit_purchase_net)  AS weighted_nab,
             SUM(m.signed_quantity * m.unit_wholesale)     AS weighted_vp
      FROM ${V_STOCK_MOVEMENTS} m
      WHERE TRUE
        ${warehouseFilter}
        ${itemFilter}
      GROUP BY m.item_id, m.warehouse_id
      ${havingInStock}
    `;

    const [rows, totalRows] = await Promise.all([
      this.prisma.$queryRaw<
        Array<{
          item_id: number;
          warehouse_id: number;
          on_hand: Prisma.Decimal | null;
          weighted_nab: Prisma.Decimal | null;
          weighted_vp: Prisma.Decimal | null;
        }>
      >(Prisma.sql`
        WITH agg AS (${aggregate})
        SELECT * FROM agg
        ORDER BY warehouse_id ASC, item_id ASC
        LIMIT ${take} OFFSET ${skip}
      `),
      this.prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
        WITH agg AS (${aggregate})
        SELECT COUNT(*)::bigint AS count FROM agg
      `),
    ]);
    const total = Number(totalRows[0]?.count ?? 0);

    const levels = rows.map((r) => {
      const onHand = new Prisma.Decimal(r.on_hand ?? 0);
      // Stanje 0 → prosek se ne može podeliti; cena ostaje 0 (fallback „poslednja cena" je
      // stvar kartice/kalkulacije, ne lager liste).
      const avg = (weighted: Prisma.Decimal | null) =>
        onHand.isZero()
          ? new Prisma.Decimal(0)
          : new Prisma.Decimal(weighted ?? 0).div(onHand);
      return {
        itemId: r.item_id,
        warehouseId: r.warehouse_id,
        onHand,
        avgPurchaseNet: avg(r.weighted_nab),
        avgWholesalePrice: avg(r.weighted_vp),
      };
    });

    // Pridruži naziv/šifru artikla (meki ref items.id) — jedan upit po skupu id-jeva.
    const itemIds = [...new Set(levels.map((l) => l.itemId))];
    const items = itemIds.length
      ? await this.prisma.item.findMany({
          where: { id: { in: itemIds } },
          select: { id: true, name: true, catalogNumber: true, unit: true },
        })
      : [];
    const itemById = new Map(items.map((i) => [i.id, i]));

    // Rezervisano = Σ OPEN rezervacija po (artikal, magacin) — jedan groupBy za celu stranu.
    const reservedByKey = await sumOpenReservations(
      this.prisma,
      levels.map((l) => ({ itemId: l.itemId, warehouseId: l.warehouseId })),
    );

    const data = levels.map((l) => {
      const it = itemById.get(l.itemId);
      const reserved =
        reservedByKey.get(stockKeyOf(l.itemId, l.warehouseId)) ??
        new Prisma.Decimal(0);
      return {
        itemId: l.itemId,
        warehouseId: l.warehouseId,
        itemName: it?.name ?? null,
        itemCode: it?.catalogNumber ?? null,
        unit: it?.unit ?? null,
        onHand: l.onHand.toFixed(3),
        reserved: reserved.toFixed(3),
        /** Raspoloživo za obećanje kupcu = stanje − otvorene rezervacije (može biti < 0). */
        available: l.onHand.sub(reserved).toFixed(3),
        avgPurchaseNet: l.avgPurchaseNet.toFixed(2),
        avgWholesalePrice: l.avgWholesalePrice.toFixed(2),
        // Vrednost iz ISTE zaokružene cene koja se prikazuje (review NIZAK) — da ručna
        // kontrola „stanje × cena = vrednost" štima; puna preciznost pravila lažne razlike.
        stockValue: l.onHand.mul(l.avgPurchaseNet.toDecimalPlaces(2)).toFixed(2),
      };
    });

    // Pretraga je već primenjena u agregatu (`itemFilter`), pa je `total` filtriran
    // i strane se ne mogu razići sa prikazom.
    return { data, meta: { total, skip, take } };
  }

  /**
   * Kartica artikla (BigBit paritet — hronološka kartica kretanja po magacinu). Vraća redove
   * kretanja za (artikal, magacin) do gornje granice `to` (ili „danas"), hronološki, sa
   * kolonama datum/dokument/vrsta/ulaz/izlaz/running-stanje. Početno stanje pre `from` =
   * `openingBalance`.
   *
   * DOSLEDNOST SA COSTING-om: i kartica i `CostingService.stateAsOf` čitaju ISTI pogled
   * `v_stock_movements`, pa je `closingBalance == stateAsOf` (smoke §2) posledica
   * konstrukcije, a ne obećanje u komentaru. `from`/`to` samo seku prozor prikaza.
   */
  async getItemCard(params: {
    itemId: number;
    warehouseId: number;
    from?: string;
    to?: string;
  }) {
    const { itemId, warehouseId } = params;
    if (!Number.isInteger(itemId) || itemId <= 0)
      throw new UnprocessableEntityException(
        "itemId je obavezan — pozitivan ceo broj.",
      );
    if (!Number.isInteger(warehouseId) || warehouseId <= 0)
      throw new UnprocessableEntityException(
        "warehouseId je obavezan — pozitivan ceo broj.",
      );

    const from = parseDateParam(params.from, "from");
    const to = parseDateParam(params.to, "to");
    // Gornja granica prikaza/obračuna = `to` ili „sada" (stanje na dan danas kad `to` nije zadat).
    const effectiveTo = to ?? new Date();

    const rows = await this.prisma.$queryRaw<
      Array<
        Pick<
          StockMovementRow,
          | "item_line_id"
          | "document_id"
          | "document_number"
          | "kind"
          | "document_type_code"
          | "document_date"
          | "quantity"
          | "signed_quantity"
          | "is_inbound"
        >
      >
    >(
      Prisma.sql`
        SELECT m.item_line_id, m.document_id, m.document_number,
               m.kind, m.document_type_code, m.document_date,
               m.quantity, m.signed_quantity, m.is_inbound
        FROM ${V_STOCK_MOVEMENTS} m
        WHERE m.item_id = ${itemId}
          AND m.warehouse_id = ${warehouseId}
          AND m.document_date <= ${effectiveTo}
        ORDER BY m.document_date ASC, m.document_id ASC, m.item_line_id ASC
      `,
    );

    let running = new Prisma.Decimal(0);
    let opening = new Prisma.Decimal(0);
    let totalIn = new Prisma.Decimal(0);
    let totalOut = new Prisma.Decimal(0);
    const lines: Array<{
      itemLineId: number;
      documentId: number;
      documentNumber: string;
      kind: string;
      documentTypeCode: string;
      documentDate: string;
      direction: "IN" | "OUT";
      in: string;
      out: string;
      balance: string;
    }> = [];

    for (const r of rows) {
      // Znak dolazi iz pogleda (`signed_quantity`) — ne izvodi se ponovo iz `is_inbound`,
      // da postoji jedno jedino mesto koje odlučuje šta je ulaz a šta izlaz.
      running = running.add(r.signed_quantity);
      // Redovi pre `from` ne ulaze u prikaz — zbir do njih je početno stanje.
      if (from && r.document_date < from) {
        opening = running;
        continue;
      }
      if (r.is_inbound) totalIn = totalIn.add(r.quantity);
      else totalOut = totalOut.add(r.quantity);
      lines.push({
        itemLineId: r.item_line_id,
        documentId: r.document_id,
        documentNumber: r.document_number,
        kind: r.kind,
        documentTypeCode: r.document_type_code,
        documentDate: r.document_date.toISOString(),
        direction: r.is_inbound ? "IN" : "OUT",
        in: r.is_inbound ? r.quantity.toFixed(6) : "0.000000",
        out: r.is_inbound ? "0.000000" : r.quantity.toFixed(6),
        balance: running.toFixed(6),
      });
    }
    const closing = running;

    // Nezavisna provera stanja kroz costing (mora == closing; smoke §2). Meki ref naziva artikla.
    const [stateAsOf, item] = await Promise.all([
      this.costing.stateAsOf(itemId, warehouseId, effectiveTo),
      this.prisma.item.findUnique({
        where: { id: itemId },
        select: { id: true, name: true, catalogNumber: true, unit: true },
      }),
    ]);

    return {
      data: {
        itemId,
        warehouseId,
        from: from ? from.toISOString() : null,
        to: effectiveTo.toISOString(),
        item: item
          ? {
              id: item.id,
              name: item.name,
              code: item.catalogNumber,
              unit: item.unit,
            }
          : null,
        openingBalance: opening.toFixed(6),
        closingBalance: closing.toFixed(6),
        stateAsOf: stateAsOf.toFixed(6),
        totalIn: totalIn.toFixed(6),
        totalOut: totalOut.toFixed(6),
        lines,
      },
    };
  }
}
