import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { pageMeta, parsePagination } from "../../common/pagination";
import { parseDateParam } from "../../common/date-params";
import { parseIntParam } from "./dto/list-items.dto";
import {
  parseLagerSort,
  parseOnlyWithStock,
  parseOptionalFlag,
  parseReservationScope,
  parseYearParam,
  type GoodsCardQuery,
  type LagerSortColumn,
  type ListLagerQuery,
  type OrdersCardQuery,
  type ProformaCardQuery,
} from "./dto/list-lager.dto";

/**
 * LAGER LISTA I KARTICE ARTIKLA — READ-ONLY OGLEDALO BigBit ROBNOG.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * ZAŠTO OVO NIJE 4.0 MODUL ZALIHA
 * ═════════════════════════════════════════════════════════════════════════════
 * 4.0 native robne tabele su na produkciji PRAZNE (`stock_documents` = 0,
 * `stock_levels` = 0, `stock_reservations` = 0, `purchase_orders` = 0), a MSSQL
 * kanal koji ih je nekad punio je MRTAV od 22.07.2026. Robno se do cutover-a
 * (april 2027) vodi isključivo u BigBit-u. Ovaj servis čita `*_mirror` tabele
 * koje puni noćni `.mdb` uvoz i NE PIŠE NIŠTA — ni ovde ni bilo gde niže.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * FORMULA (BigBit paritet)
 * ═════════════════════════════════════════════════════════════════════════════
 *   stanje(artikal, magacin)      = SUM(quantity_in) − SUM(quantity_out)
 *                                   nad dokumentima `level = 0`
 *   rezervisano(artikal, magacin) = SUM(quantity) nad `is_reservation = true`
 *   slobodno                      = stanje − rezervisano
 *
 * 🔴 ZNAK KOLIČINE SE NE DIRA — NEMA `ABS()`. Međumagacinski prenos su u
 * BigBit-u DVA dokumenta i OBA nose `Ulaz = True`; odlazak je zapisan kao
 * NEGATIVNA količina (mereno: `MMPM +5.005` u magacin 2, `MMPR −5.005` iz
 * magacina 1; 87 stavki je negativno). `ABS()` bi robu UMNOŽIO svakim prenosom.
 *
 * 🔴 MAGACIN SE UZIMA SA STAVKE (`goods_document_items_mirror.warehouse_id`),
 * ne sa zaglavlja. Zamka je što se greška NE VIDI na knjiženom prometu: u
 * Level 0 se magacin stavke i zaglavlja poklapaju u svih 18.865 stavki. Ali u
 * Level 250 se razlikuju u 523 stavke — a Level 250 je baš onaj skup iz kojeg
 * se računa REZERVISANO. Grupisanje po zaglavlju bi dakle tiho pripisalo
 * rezervacije pogrešnom magacinu.
 *
 * 🔴 REZERVACIJA JE ZASTAVICA, NE VRSTA DOKUMENTA. Pored REZM (1.071) i REZR
 * (487) rezervišu i OTP (9), PON (6) i PROF (3) — filter po `Vrsta dokumenta`
 * promašio bi 18 dokumenata. Sve rezervacije su Level 250, nijedna Level 0, pa
 * su dva skupa formule disjunktna (rezervacija nikad ne ulazi u stanje).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * 🔴 SEČENJE PO POSLOVNOJ GODINI JE DEO FORMULE, NE FILTER
 * ═════════════════════════════════════════════════════════════════════════════
 * BigBit svaku godinu otvara sopstvenim „Donosom po popisu" (vrsta POPIS,
 * `Ulaz = True`, 5.437 stavki na 01.01.2026), a uvoz ništa ne briše. Posle
 * 01.01. ogledalo zato drži VIŠE godina odjednom i prost zbir bi UDVOSTRUČIO
 * stanje. Svaki upit ispod seče po godini (`year`, sa padom na godinu iz datuma
 * dokumenta), a primenjena godina i njeno poreklo idu u `meta` — da ekran nikad
 * ne prikaže „neku" godinu bez oznake koju.
 *
 * Rezervacije se podrazumevano seku istom godinom, iz merenja: 1.576
 * rezervacionih dokumenata ide od 2013. do 2026., a samo 49 ih je iz 2026.
 * (≈ 1,08 M jedinica ukupno prema ≈ 71 k u tekućoj godini). Bez odsecanja bi
 * kolona SLOBODNO pokazivala masovnu prezauzetost koja izgleda kao tačan
 * podatak. `reservationScope=all` daje pun BigBit zbir.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * ZAŠTO RAW SQL, A NE PRISMA
 * ═════════════════════════════════════════════════════════════════════════════
 * Lager je agregat nad ~182.500 stavki koji se FULL OUTER JOIN-om spaja sa
 * agregatom rezervacija, pa se onda spaja na `items` i `warehouses` da bi se po
 * NJIMA filtriralo i sortiralo. Prisma `groupBy` ne ume ni spoljni spoj dva
 * agregata ni sort po koloni pridružene tabele. Sve vrednosti iz zahteva idu
 * kao BIND parametri; jedini `Prisma.raw` je izraz sorta, i to isključivo iz
 * zatvorenog spiska (`LAGER_SORT_COLUMNS` → `SORT_EXPR`).
 */
@Injectable()
export class LagerService {
  constructor(private readonly prisma: PrismaService) {}

  // ───────────────────────────────────────────────────────────────────────────
  // 1) LAGER LISTA — GET /api/v1/artikli/lager
  // ───────────────────────────────────────────────────────────────────────────

  async lager(query: ListLagerQuery) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );
    // Sve 400-ke padaju PRE ijednog dodira baze (isto pravilo kao `ItemsService`:
    // neispravan zahtev ne plaća skupu agregaciju nad 182.500 stavki).
    const sort = parseLagerSort(query.sort, query.dir);
    const requestedYear = parseYearParam(query.year);
    const reservationScope = parseReservationScope(query.reservationScope);
    const onlyWithStock = parseOnlyWithStock(query.onlyWithStock);
    const onlyNegative = parseOptionalFlag(query.onlyNegative, "onlyNegative");
    const warehouseId = parseIntParam(query.warehouseId, "warehouseId");
    const groupCode = query.groupCode?.trim();
    const q = query.q?.trim();

    const { year, yearSource } = await this.resolveYear(requestedYear);

    const filters: Prisma.Sql[] = [];
    // `onlyNegative` implicira `stanje <> 0`, pa se dva uslova ne sudaraju:
    // negativno stanje je podskup nenultog. Oba idu u `AND`, ne jedan umesto
    // drugog — „samo negativno" uz isključen „samo sa stanjem" i dalje znači
    // negativno, a ne „sve".
    if (onlyWithStock) filters.push(Prisma.sql`l.stock <> 0`);
    if (onlyNegative) filters.push(Prisma.sql`l.stock < 0`);
    if (warehouseId !== undefined)
      filters.push(Prisma.sql`l.warehouse_id = ${warehouseId}`);
    if (groupCode) filters.push(Prisma.sql`it.group_code = ${groupCode}`);
    if (q)
      filters.push(
        Prisma.sql`(it.catalog_number ILIKE ${`%${q}%`} OR it.name ILIKE ${`%${q}%`})`,
      );

    const rows = await this.prisma.$queryRaw<LagerRow[]>(Prisma.sql`
      WITH stock AS (
        SELECT gi.item_id, gi.warehouse_id,
               SUM(gi.quantity_in - gi.quantity_out) AS qty
          FROM goods_document_items_mirror gi
          JOIN goods_documents_mirror gd ON gd.id = gi.document_id
         WHERE gd.level = 0
           AND ${YEAR_EXPR} = ${year}
         GROUP BY gi.item_id, gi.warehouse_id
      ),
      reserved AS (
        SELECT gi.item_id, gi.warehouse_id,
               SUM(${RESERVED_QTY_EXPR}) AS qty
          FROM goods_document_items_mirror gi
          JOIN goods_documents_mirror gd ON gd.id = gi.document_id
         WHERE gd.is_reservation
           -- level > 0 je BRANA, ne filter. Stanje se racuna iz level = 0, pa bi
           -- rezervacioni dokument na nivou 0 usao U OBA zbira i tiho umanjio SLOBODNO
           -- (isti red i kao zaliha i kao rezervacija). Danas su skupovi disjunktni --
           -- mereno u BigBitu: svih 1.576 rezervacija je Level 250, nijedna 0 -- ali
           -- to je osobina podataka, a ne pravilo koje BigBit sprovodi.
           AND gd.level > 0
           ${reservationScope === "year" ? Prisma.sql`AND ${YEAR_EXPR} = ${year}` : Prisma.empty}
         GROUP BY gi.item_id, gi.warehouse_id
      ),
      l AS (
        SELECT COALESCE(s.item_id, r.item_id)           AS item_id,
               COALESCE(s.warehouse_id, r.warehouse_id) AS warehouse_id,
               COALESCE(s.qty, 0)                       AS stock,
               COALESCE(r.qty, 0)                       AS reserved,
               COALESCE(s.qty, 0) - COALESCE(r.qty, 0)  AS free
          FROM stock s
          FULL OUTER JOIN reserved r
            ON r.item_id = s.item_id AND r.warehouse_id = s.warehouse_id
      )
      SELECT l.item_id                     AS "itemId",
             l.warehouse_id                AS "warehouseId",
             l.stock::text                 AS "stock",
             l.reserved::text              AS "reserved",
             l.free::text                  AS "free",
             it.catalog_number             AS "catalogNumber",
             it.name                       AS "name",
             it.unit                       AS "unit",
             it.shelf                      AS "shelf",
             it.group_code                 AS "groupCode",
             -- MINIMALNA KOLIČINA — 4.0-owned kolona (unose je magacioneri, 06.08.2026).
             -- ::numeric::text, a ne golo ::text: kolona je double precision, pa bi
             -- direktan ::text umeo da ispiše 1e-05 ili 0.30000000000000004. Prolaz
             -- kroz numeric daje tačan decimalni zapis, isti oblik kao ostale
             -- količine na ovom ekranu.
             it.min_quantity::numeric::text AS "minQuantity",
             it.wholesale_price::text      AS "wholesalePrice",
             w.name                        AS "warehouseName",
             COUNT(*) OVER ()::int         AS "totalCount"
        FROM l
        LEFT JOIN items      it ON it.id = l.item_id
        LEFT JOIN warehouses w  ON w.id = l.warehouse_id
       ${whereClause(filters)}
       ORDER BY ${orderByClause(sort)}
       LIMIT ${take} OFFSET ${skip}
    `);

    const total = rows[0]?.totalCount ?? 0;
    const groups = await this.resolveGroups(rows.map((r) => r.groupCode));

    return {
      data: rows.map((r) => ({
        itemId: r.itemId,
        catalogNumber: r.catalogNumber,
        name: r.name,
        unit: r.unit,
        shelf: r.shelf,
        groupCode: r.groupCode,
        group: r.groupCode
          ? { code: r.groupCode, description: groups.get(r.groupCode) ?? null }
          : null,
        warehouse: warehouseRef(r.warehouseId, r.warehouseName),
        stock: decText(r.stock),
        reserved: decText(r.reserved),
        free: decText(r.free),
        // PRAZNO OSTAJE PRAZNO: `null` znači „prag nije postavljen", a `0` znači
        // „prag je nula". Razlika je stvarna i mora da preživi do ekrana — mereno na
        // produkciji 06.08.2026: 162 artikla imaju prag > 0, 92.460 nulu, 3 prazno.
        minQuantity: decText(r.minQuantity),
        wholesalePrice: decText(r.wholesalePrice),
      })),
      meta: {
        ...pageMeta(page, pageSize, total),
        ...yearMeta(year, yearSource),
        reservationScope,
        onlyWithStock,
        onlyNegative,
      },
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 2) KARTICA ROBNOG KRETANJA — GET /api/v1/artikli/:id/kartica-robno
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Hronološko kretanje jednog artikla sa TEKUĆIM STANJEM (running balance).
   *
   * Samo `level = 0` — kartica mora da se slaže sa kolonom STANJE u lageru, a
   * ponude/rezervacije (Level 250) u stanje ne ulaze; one imaju svoju karticu
   * (`kartica-profakture`).
   *
   * PERIOD NE POČINJE OD NULE. Kad je `from` zadat, red pre njega nije nestao —
   * njegov zbir stoji u `meta.openingBalance` i running kreće od tog broja.
   * Bez toga bi kartica za mart pokazala „stanje 12" za artikal kojeg u
   * magacinu ima 137, i to bez ijednog znaka da nešto fali.
   *
   * NIJE PAGINIRANA, nego odsečena na `GOODS_CARD_MAX_ROWS`: running balance
   * ima smisla samo nad celim nizom (druga strana bi počinjala od nule). Kad
   * odsecanje stvarno nastupi, `meta.truncated` je `true` — odsečena kartica
   * sme da postoji, ali ne sme da ćuti o tome.
   */
  async goodsCard(itemId: number, query: GoodsCardQuery) {
    const requestedYear = parseYearParam(query.year);
    const warehouseId = parseIntParam(query.warehouseId, "warehouseId");
    const from = parseDateParam(query.from, "from");
    const to = parseDateParam(query.to, "to");

    const item = await this.requireItem(itemId);
    const { year, yearSource } = await this.resolveYear(requestedYear);

    const scope: Prisma.Sql[] = [
      Prisma.sql`gi.item_id = ${itemId}`,
      Prisma.sql`gd.level = 0`,
      Prisma.sql`${YEAR_EXPR} = ${year}`,
    ];
    if (warehouseId !== undefined)
      scope.push(Prisma.sql`gi.warehouse_id = ${warehouseId}`);

    // Početno stanje = sve iz ISTE godine PRE `from`. Bez `from` je nula, jer
    // je početak godine već u podacima („Donos po popisu").
    const opening = from
      ? await this.scalarQuantity(Prisma.sql`
          SELECT COALESCE(SUM(gi.quantity_in - gi.quantity_out), 0)::text AS value
            FROM goods_document_items_mirror gi
            JOIN goods_documents_mirror gd ON gd.id = gi.document_id
           ${whereClause([...scope, Prisma.sql`${DATE_EXPR} < ${isoDate(from)}::date`])}
        `)
      : new Prisma.Decimal(0);

    const period: Prisma.Sql[] = [...scope];
    if (from) period.push(Prisma.sql`${DATE_EXPR} >= ${isoDate(from)}::date`);
    if (to) period.push(Prisma.sql`${DATE_EXPR} <= ${isoDate(to)}::date`);

    const rows = await this.prisma.$queryRaw<GoodsCardRow[]>(Prisma.sql`
      SELECT gi.id                                    AS "id",
             gd.id                                    AS "documentId",
             gd.document_number                       AS "documentNumber",
             gd.document_type                         AS "documentType",
             to_char(gd.document_date, 'YYYY-MM-DD')  AS "documentDate",
             to_char(gd.posting_date, 'YYYY-MM-DD')   AS "postingDate",
             gd.is_inflow                             AS "isInflow",
             gd.customer_id                           AS "customerId",
             c.name                                   AS "customerName",
             gd.project_id                            AS "projectId",
             gi.warehouse_id                          AS "warehouseId",
             w.name                                   AS "warehouseName",
             gi.quantity_in::text                     AS "quantityIn",
             gi.quantity_out::text                    AS "quantityOut",
             gi.purchase_price_net::text              AS "purchasePriceNet",
             gi.actual_wholesale_price::text          AS "actualWholesalePrice",
             gi.item_description                      AS "description"
        FROM goods_document_items_mirror gi
        JOIN goods_documents_mirror gd ON gd.id = gi.document_id
        LEFT JOIN customers  c ON c.id = gd.customer_id
        LEFT JOIN warehouses w ON w.id = gi.warehouse_id
       ${whereClause(period)}
       ORDER BY ${DATE_EXPR} ASC, gd.id ASC, gi.id ASC
       LIMIT ${GOODS_CARD_MAX_ROWS + 1}
    `);

    const truncated = rows.length > GOODS_CARD_MAX_ROWS;
    const page = truncated ? rows.slice(0, GOODS_CARD_MAX_ROWS) : rows;

    let running = opening;
    let totalIn = new Prisma.Decimal(0);
    let totalOut = new Prisma.Decimal(0);
    const data = page.map((r) => {
      const qtyIn = dec(r.quantityIn);
      const qtyOut = dec(r.quantityOut);
      running = running.plus(qtyIn).minus(qtyOut);
      totalIn = totalIn.plus(qtyIn);
      totalOut = totalOut.plus(qtyOut);
      return {
        id: r.id,
        documentId: r.documentId,
        documentNumber: r.documentNumber,
        documentType: r.documentType,
        documentDate: r.documentDate,
        postingDate: r.postingDate,
        isInflow: r.isInflow,
        customerId: r.customerId,
        customerName: r.customerName,
        projectId: r.projectId,
        warehouse: warehouseRef(r.warehouseId, r.warehouseName),
        quantityIn: qtyIn.toString(),
        quantityOut: qtyOut.toString(),
        balance: running.toString(),
        purchasePriceNet: decText(r.purchasePriceNet),
        actualWholesalePrice: decText(r.actualWholesalePrice),
        description: r.description,
      };
    });

    return {
      data,
      meta: {
        item,
        ...yearMeta(year, yearSource),
        warehouseId: warehouseId ?? null,
        from: from ? isoDate(from) : null,
        to: to ? isoDate(to) : null,
        openingBalance: opening.toString(),
        totalIn: totalIn.toString(),
        totalOut: totalOut.toString(),
        closingBalance: running.toString(),
        count: data.length,
        truncated,
        limit: GOODS_CARD_MAX_ROWS,
      },
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 3) KARTICA NARUDŽBINA — GET /api/v1/artikli/:id/kartica-narudzbine
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Trebovanja (BigBit `T_Trebovanja`, 22.931 dokument) koja sadrže artikal.
   *
   * Čita `purchase_orders_mirror`, a NE 4.0 native `purchase_orders` — taj model
   * je status-mašina sopstvene numeracije i na produkciji je prazan.
   *
   * Za razliku od robne kartice OVDE PAGINACIJA SME: nema tekućeg stanja koje bi
   * druga strana pokvarila. Redosled je od najnovijeg — trebovanje se gleda da
   * bi se videlo „šta je poslednje poručeno i da li je stiglo".
   */
  async ordersCard(itemId: number, query: OrdersCardQuery) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );
    const requestedYear = parseYearParam(query.year);
    const from = parseDateParam(query.from, "from");
    const to = parseDateParam(query.to, "to");
    const onlyOpen = parseOptionalFlag(query.onlyOpen, "onlyOpen");

    const item = await this.requireItem(itemId);

    // Trebovanja se NE seku po godini podrazumevano: narudžbina iz decembra
    // koja stiže u januaru je i dalje otvorena narudžbina, a kartica odgovara
    // na pitanje „šta je poručeno", ne „koliko robe imam". Godina ostaje
    // dostupna kao izričit filter.
    const filters: Prisma.Sql[] = [Prisma.sql`poi.item_id = ${itemId}`];
    if (requestedYear !== undefined)
      filters.push(
        Prisma.sql`COALESCE(po.year, EXTRACT(YEAR FROM po.order_date)::int) = ${requestedYear}`,
      );
    if (from) filters.push(Prisma.sql`po.order_date >= ${isoDate(from)}::date`);
    if (to) filters.push(Prisma.sql`po.order_date <= ${isoDate(to)}::date`);
    if (onlyOpen) filters.push(Prisma.sql`poi.is_delivered = false`);

    const rows = await this.prisma.$queryRaw<OrderCardRow[]>(Prisma.sql`
      SELECT poi.id                                            AS "id",
             po.id                                             AS "orderId",
             po.order_number                                   AS "orderNumber",
             to_char(po.order_date, 'YYYY-MM-DD')              AS "orderDate",
             po.supplier_id                                    AS "supplierId",
             c.name                                            AS "supplierName",
             po.project_id                                     AS "projectId",
             po.level                                          AS "level",
             po.is_ordered                                     AS "isOrdered",
             po.year                                           AS "year",
             po.note                                           AS "note",
             poi.ordered_quantity::text                        AS "orderedQuantity",
             poi.received_quantity::text                       AS "receivedQuantity",
             poi.unit_price::text                              AS "unitPrice",
             poi.discount_percent::text                        AS "discountPercent",
             poi.description                                   AS "description",
             to_char(poi.expected_delivery_date, 'YYYY-MM-DD') AS "expectedDeliveryDate",
             to_char(poi.actual_delivery_date, 'YYYY-MM-DD')          AS "actualDeliveryDate",
             poi.is_delivered                                  AS "isDelivered",
             COUNT(*) OVER ()::int                             AS "totalCount"
        FROM purchase_order_items_mirror poi
        JOIN purchase_orders_mirror po ON po.id = poi.order_id
        LEFT JOIN customers c ON c.id = po.supplier_id
       ${whereClause(filters)}
       ORDER BY po.order_date DESC NULLS LAST, po.id DESC, poi.id DESC
       LIMIT ${take} OFFSET ${skip}
    `);

    return {
      data: rows.map((r) => {
        const ordered = dec(r.orderedQuantity);
        const received = dec(r.receivedQuantity);
        return {
          id: r.id,
          orderId: r.orderId,
          orderNumber: r.orderNumber,
          orderDate: r.orderDate,
          supplierId: r.supplierId,
          supplierName: r.supplierName,
          projectId: r.projectId,
          level: r.level,
          isOrdered: r.isOrdered,
          year: r.year,
          note: r.note,
          orderedQuantity: decText(r.orderedQuantity),
          receivedQuantity: decText(r.receivedQuantity),
          /** Ostatak isporuke; nikad negativan (višak isporuke = 0, ne minus). */
          remainingQuantity: Prisma.Decimal.max(
            ordered.minus(received),
            0,
          ).toString(),
          unitPrice: decText(r.unitPrice),
          discountPercent: decText(r.discountPercent),
          description: r.description,
          expectedDeliveryDate: r.expectedDeliveryDate,
          actualDeliveryDate: r.actualDeliveryDate,
          isDelivered: r.isDelivered,
        };
      }),
      meta: {
        ...pageMeta(page, pageSize, rows[0]?.totalCount ?? 0),
        item,
        year: requestedYear ?? null,
        from: from ? isoDate(from) : null,
        to: to ? isoDate(to) : null,
        onlyOpen,
      },
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 4) KARTICA PROFAKTURA — GET /api/v1/artikli/:id/kartica-profakture
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * 🔴 „PROFAKTURE" U BigBit-u NISU TABELA NEGO UPIT: `T_Robna dokumenta`
   * `WHERE Level >= 250`. Isti skup nosi ponude, predračune, rezervacije i
   * otpremnice (25.810 dokumenata / 163.674 stavke) — sve što je zapisano, a
   * nije proknjiženo u stanje. Zato ovde stoji `level >= 250`, a ne spisak
   * vrsta dokumenata: novu vrstu radnog dokumenta BigBit dobija bez pitanja,
   * i ona mora sama da se pojavi na kartici.
   *
   * `isReservation` je zasebna kolona odgovora, jer je to jedini podatak koji
   * kaže da li red iz ove kartice UMANJUJE SLOBODNO u lager listi.
   */
  async proformaCard(itemId: number, query: ProformaCardQuery) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );
    const requestedYear = parseYearParam(query.year);
    const warehouseId = parseIntParam(query.warehouseId, "warehouseId");
    const from = parseDateParam(query.from, "from");
    const to = parseDateParam(query.to, "to");
    const onlyReservations = parseOptionalFlag(
      query.onlyReservations,
      "onlyReservations",
    );
    const documentType = query.documentType?.trim();

    const item = await this.requireItem(itemId);

    // Godina je OPCIONA (za razliku od lagera): ovde se ništa ne sabira u
    // stanje, pa višegodišnji pregled ponuda nije greška nego istorija.
    const filters: Prisma.Sql[] = [
      Prisma.sql`gi.item_id = ${itemId}`,
      Prisma.sql`gd.level >= 250`,
    ];
    if (requestedYear !== undefined)
      filters.push(Prisma.sql`${YEAR_EXPR} = ${requestedYear}`);
    if (warehouseId !== undefined)
      filters.push(Prisma.sql`gi.warehouse_id = ${warehouseId}`);
    if (onlyReservations) filters.push(Prisma.sql`gd.is_reservation`);
    if (documentType)
      filters.push(Prisma.sql`gd.document_type = ${documentType}`);
    if (from) filters.push(Prisma.sql`${DATE_EXPR} >= ${isoDate(from)}::date`);
    if (to) filters.push(Prisma.sql`${DATE_EXPR} <= ${isoDate(to)}::date`);

    const rows = await this.prisma.$queryRaw<ProformaCardRow[]>(Prisma.sql`
      SELECT gi.id                                    AS "id",
             gd.id                                    AS "documentId",
             gd.document_number                       AS "documentNumber",
             gd.document_type                         AS "documentType",
             to_char(gd.document_date, 'YYYY-MM-DD')  AS "documentDate",
             to_char(gd.posting_date, 'YYYY-MM-DD')   AS "postingDate",
             gd.level                                 AS "level",
             gd.is_reservation                        AS "isReservation",
             gd.is_inflow                             AS "isInflow",
             gd.customer_id                           AS "customerId",
             c.name                                   AS "customerName",
             gd.project_id                            AS "projectId",
             gd.year                                  AS "year",
             gi.warehouse_id                          AS "warehouseId",
             w.name                                   AS "warehouseName",
             ${RESERVED_QTY_EXPR}::text               AS "quantity",
             gi.actual_wholesale_price::text          AS "actualWholesalePrice",
             gi.discount_percent::text                AS "discountPercent",
             gi.item_description                      AS "description",
             COUNT(*) OVER ()::int                    AS "totalCount"
        FROM goods_document_items_mirror gi
        JOIN goods_documents_mirror gd ON gd.id = gi.document_id
        LEFT JOIN customers  c ON c.id = gd.customer_id
        LEFT JOIN warehouses w ON w.id = gi.warehouse_id
       ${whereClause(filters)}
       ORDER BY ${DATE_EXPR} DESC, gd.id DESC, gi.id DESC
       LIMIT ${take} OFFSET ${skip}
    `);

    return {
      data: rows.map((r) => ({
        id: r.id,
        documentId: r.documentId,
        documentNumber: r.documentNumber,
        documentType: r.documentType,
        documentDate: r.documentDate,
        postingDate: r.postingDate,
        level: r.level,
        isReservation: r.isReservation,
        isInflow: r.isInflow,
        customerId: r.customerId,
        customerName: r.customerName,
        projectId: r.projectId,
        year: r.year,
        warehouse: warehouseRef(r.warehouseId, r.warehouseName),
        quantity: decText(r.quantity),
        actualWholesalePrice: decText(r.actualWholesalePrice),
        discountPercent: decText(r.discountPercent),
        description: r.description,
      })),
      meta: {
        ...pageMeta(page, pageSize, rows[0]?.totalCount ?? 0),
        item,
        year: requestedYear ?? null,
        warehouseId: warehouseId ?? null,
        from: from ? isoDate(from) : null,
        to: to ? isoDate(to) : null,
        onlyReservations,
        documentType: documentType ?? null,
      },
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Zajedničko
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * POSLOVNA GODINA KOJA SE STVARNO PRIMENJUJE.
   *
   * Zadata (`?year=`) se poštuje bez pogovora — i kad u njoj nema ničega, jer
   * „2019. nema prometa" JESTE tačan odgovor, a tihi skok na drugu godinu ne bi
   * bio.
   *
   * Bez nje se uzima POSLEDNJA ZATEČENA godina knjiženog prometa (`level = 0`),
   * a ne kalendarska: 05.01. nova godina u BigBit-u često još nema „Donos po
   * popisu", pa bi kalendarska godina prikazala prazan lager za magacin pun
   * robe. Poslednja zatečena se sama pomeri onog dana kad donos stigne.
   *
   * ⚠️ GORNJA GRANICA JE KALENDARSKA GODINA. Jedna omaška u BigBit-u
   * (`Godina = 2062`) bi inače postala podrazumevana godina celog ekrana i
   * pokazala prazan lager svima. Godina iz budućnosti se i dalje može tražiti
   * izričito preko `?year=`.
   */
  private async resolveYear(
    requested: number | undefined,
  ): Promise<{ year: number; yearSource: YearSource }> {
    if (requested !== undefined)
      return { year: requested, yearSource: "query" };

    const currentYear = new Date().getFullYear();
    const rows = await this.prisma.$queryRaw<{ year: number | null }[]>(
      Prisma.sql`
        SELECT MAX(${YEAR_EXPR})::int AS year
          FROM goods_documents_mirror gd
         WHERE gd.level = 0
           AND ${YEAR_EXPR} <= ${currentYear}`,
    );
    const latest = rows[0]?.year ?? null;
    return latest === null
      ? { year: currentYear, yearSource: "fallback" }
      : { year: latest, yearSource: "latest" };
  }

  /**
   * Zaglavlje kartice + provera da artikal uopšte postoji.
   *
   * 404 pre upita nad ogledalom je namerno: artikal bez ijednog robnog
   * dokumenta i artikal koji ne postoji daju IDENTIČNU praznu karticu, pa bi
   * bez ove provere greška u linku („kartica za obrisan artikal") izgledala kao
   * podatak („ovaj artikal se nikad nije kretao").
   */
  private async requireItem(itemId: number) {
    const item = await this.prisma.item.findUnique({
      where: { id: itemId },
      select: {
        id: true,
        catalogNumber: true,
        name: true,
        unit: true,
        shelf: true,
      },
    });
    if (!item) throw new NotFoundException(`Artikal ${itemId} ne postoji.`);
    return item;
  }

  /** Jedan `numeric` iz upita → `Decimal`; prazan rezultat je nula, ne greška. */
  private async scalarQuantity(sql: Prisma.Sql): Promise<Prisma.Decimal> {
    const rows = await this.prisma.$queryRaw<{ value: string | null }[]>(sql);
    return dec(rows[0]?.value ?? null);
  }

  /**
   * Opisi grupa artikala za prikazane redove — batch, jedan upit po strani.
   * Šifarnik `item_groups` je danas PRAZAN (BIGBIT_ARTIKLI.md §2.1: syncer za
   * `R_Grupa` ne postoji), pa `description` pada na `null` umesto da JOIN obori
   * upit — isti stav kao `ItemsService.resolveGroups`.
   */
  private async resolveGroups(codes: (string | null)[]) {
    const uniq = [
      ...new Set(
        codes.filter((c): c is string => typeof c === "string" && c !== ""),
      ),
    ];
    if (!uniq.length) return new Map<string, string>();
    const rows = await this.prisma.itemGroup.findMany({
      where: { code: { in: uniq } },
      select: { code: true, description: true },
    });
    return new Map(rows.map((r) => [r.code, r.description]));
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// SQL izrazi i pomoćne funkcije
// ═════════════════════════════════════════════════════════════════════════════

/**
 * POSLOVNA GODINA DOKUMENTA. `gd.year` je BigBit `Godina` i merodavan je, ali je
 * u ogledalu nullable (kolona je dodata 05.08.2026, a `sync-map.generated.ts` je
 * i dalje deklariše sa tri kolone). Pad na godinu datuma dokumenta znači da red
 * bez `Godina` upadne u svoju kalendarsku godinu umesto da nestane iz lagera —
 * a nestala roba je gora greška od robe u pogrešnoj godini.
 */
const YEAR_EXPR = Prisma.sql`COALESCE(gd.year, EXTRACT(YEAR FROM gd.document_date)::int)`;

/**
 * DATUM PO KOJEM SE SEČE PERIOD I RANGIRA KARTICA. `Datum knjizenja` je
 * merodavan (tako i šema kaže), ali je nullable — pad na datum isprave.
 */
const DATE_EXPR = Prisma.sql`COALESCE(gd.posting_date, gd.document_date)`;

/**
 * REZERVISANA KOLIČINA JEDNE STAVKE — SIROVA `Kolicina` SA ZNAKOM.
 *
 * `quantity` je sirova BigBit kolona i primarni izvor. Pad je `quantity_in +
 * quantity_out`, i to je ZBIR, NE RAZLIKA: uvoz sirovu količinu smešta u tačno
 * jednu od dve kolone (druga je 0), pa zbir rekonstruiše original ZAJEDNO SA
 * ZNAKOM. Razlika bi rezervaciji na izlaznom dokumentu okrenula znak i pretvorila
 * je u negativnu rezervaciju, tj. lažno POVEĆALA slobodnu količinu.
 */
const RESERVED_QTY_EXPR = Prisma.sql`COALESCE(gi.quantity, gi.quantity_in + gi.quantity_out)`;

/**
 * Kartica se ne pagira (running balance), pa mora imati tvrdu kapu. 5.000 je
 * red veličine iznad najprometnijeg artikla (18.865 stavki na 7.143 artikla sa
 * stanjem u celoj godini), a čuva od jednog artikla koji povuče celu tabelu.
 */
const GOODS_CARD_MAX_ROWS = 5000;

type YearSource = "query" | "latest" | "fallback";

interface LagerRow {
  itemId: number;
  warehouseId: number;
  stock: string;
  reserved: string;
  free: string;
  catalogNumber: string | null;
  name: string | null;
  unit: string | null;
  shelf: string | null;
  groupCode: string | null;
  minQuantity: string | null;
  wholesalePrice: string | null;
  warehouseName: string | null;
  totalCount: number;
}

interface GoodsCardRow {
  id: number;
  documentId: number;
  documentNumber: string | null;
  documentType: string;
  documentDate: string | null;
  postingDate: string | null;
  isInflow: boolean;
  customerId: number | null;
  customerName: string | null;
  projectId: number | null;
  warehouseId: number;
  warehouseName: string | null;
  quantityIn: string | null;
  quantityOut: string | null;
  purchasePriceNet: string | null;
  actualWholesalePrice: string | null;
  description: string | null;
}

interface OrderCardRow {
  id: number;
  orderId: number;
  orderNumber: string | null;
  orderDate: string | null;
  supplierId: number | null;
  supplierName: string | null;
  projectId: number | null;
  level: number;
  isOrdered: boolean;
  year: number | null;
  note: string | null;
  orderedQuantity: string | null;
  receivedQuantity: string | null;
  unitPrice: string | null;
  discountPercent: string | null;
  description: string | null;
  expectedDeliveryDate: string | null;
  actualDeliveryDate: string | null;
  isDelivered: boolean;
  totalCount: number;
}

interface ProformaCardRow {
  id: number;
  documentId: number;
  documentNumber: string | null;
  documentType: string;
  documentDate: string | null;
  postingDate: string | null;
  level: number;
  isReservation: boolean;
  isInflow: boolean;
  customerId: number | null;
  customerName: string | null;
  projectId: number | null;
  year: number | null;
  warehouseId: number;
  warehouseName: string | null;
  quantity: string | null;
  actualWholesalePrice: string | null;
  discountPercent: string | null;
  description: string | null;
  totalCount: number;
}

/**
 * SORT → SQL IZRAZ. Mapa je potpuna po `LagerSortColumn` (nedostajući ključ je
 * greška na kompilaciji), pa `Prisma.raw` ispod nikad ne vidi tekst iz zahteva —
 * samo jednu od ovih deset konstanti.
 */
const SORT_EXPR: Record<LagerSortColumn, string> = {
  catalogNumber: "it.catalog_number",
  name: "it.name",
  unit: "it.unit",
  shelf: "it.shelf",
  groupCode: "it.group_code",
  warehouse: "w.name",
  stock: "l.stock",
  reserved: "l.reserved",
  free: "l.free",
  minQuantity: "it.min_quantity",
  wholesalePrice: "it.wholesale_price",
};

/**
 * TIE-BREAK JE `(item_id, warehouse_id)` — JEDINSTVEN KLJUČ REDA U LAGERU.
 *
 * Isti artikal stoji u više magacina, pa `item_id` sam nije jedinstven. Bez oba
 * ključa Postgres sme da promeni redosled jednakih vrednosti između dva
 * `LIMIT/OFFSET` upita, a ekran skroluje nadovezivanjem strana: isti red bi se
 * pojavio dvaput, a drugi bi se izgubio (ista pouka kao `ITEM_ORDER_TIE_BREAK`).
 */
const LAGER_TIE_BREAK = "l.item_id ASC, l.warehouse_id ASC";

/**
 * `ORDER BY` lagera. Bez sorta = kataloški broj rastuće (BigBit redosled
 * pregleda zaliha), pa tie-break.
 *
 * ⚠️ `NULLS LAST` U OBA SMERA. Postgres podrazumeva ASC = NULLS LAST, ali
 * DESC = NULLS FIRST — bez ovoga bi drugi klik na „Polica" ili „Naziv" doneo
 * na vrh redove čiji artikal ne postoji u `items` (LEFT JOIN), a korisnik bi
 * video stranu praznih ćelija i pomislio da je lista pokvarena.
 */
function orderByClause(
  sort: { column: LagerSortColumn; direction: "asc" | "desc" } | undefined,
): Prisma.Sql {
  if (!sort)
    return Prisma.raw(`it.catalog_number ASC NULLS LAST, ${LAGER_TIE_BREAK}`);
  const dir = sort.direction === "desc" ? "DESC" : "ASC";
  return Prisma.raw(
    `${SORT_EXPR[sort.column]} ${dir} NULLS LAST, ${LAGER_TIE_BREAK}`,
  );
}

/** `WHERE a AND b AND …`; prazan spisak → `Prisma.empty` (nema golog `WHERE`). */
function whereClause(filters: Prisma.Sql[]): Prisma.Sql {
  return filters.length
    ? Prisma.sql`WHERE ${Prisma.join(filters, " AND ")}`
    : Prisma.empty;
}

/**
 * Magacin kakav se VIDI NA EKRANU. Zahtev je izričit: naziv, ne broj.
 *
 * Pad na „Magacin N" postoji jer BigBit magacini (1, 2, 44) nisu isti skup kao
 * 4.0 `warehouses` — magacin koji u 4.0 nije zaveden bi kao `null` ostavio
 * praznu ćeliju u kojoj se ne vidi ni o kom je magacinu reč, a zaliha na njemu
 * postoji i mora da se prepozna.
 */
function warehouseRef(id: number, name: string | null) {
  return { id, name: name ?? `Magacin ${id}` };
}

/** `numeric::text` → `Decimal`; prazno je nula (kolone su nullable u ogledalu). */
function dec(value: string | null): Prisma.Decimal {
  return value === null ? new Prisma.Decimal(0) : new Prisma.Decimal(value);
}

/**
 * `numeric::text` → normalizovan string (BACKEND_RULES §6: novac i količine
 * NIKAD kao JS `number`). Prolaz kroz `Decimal` skida repove nula koje Postgres
 * ispisuje po skali kolone („125.0000" → „125"), da bi se kolona čitala isto
 * kao na listi artikala. PRAZNO OSTAJE PRAZNO — `null` ne postaje „0", jer
 * „nema cene" i „cena je nula" nisu isto.
 */
function decText(value: string | null): string | null {
  return value === null ? null : new Prisma.Decimal(value).toString();
}

/** `YYYY-MM-DD` za `::date` bind — kolone su `date`, pa zona ne sme da uđe u igru. */
function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** Primenjena poslovna godina + odakle je došla (ekran je ispisuje u zaglavlju). */
function yearMeta(year: number, yearSource: YearSource) {
  return { year, yearSource };
}
