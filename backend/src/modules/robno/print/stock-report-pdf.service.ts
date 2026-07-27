import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type {
  Content,
  TableCell,
  TDocumentDefinitions,
} from "pdfmake/interfaces";
import { PrismaService } from "../../../prisma/prisma.service";
import { PdfService } from "../../documents/pdf.service";
import { RobnoService } from "../robno.service";
import {
  DEFAULT_STYLE,
  PAGE_LANDSCAPE,
  PAGE_PORTRAIT,
  ROBNO_STYLES,
  buildControlSum,
  buildDocHeader,
  buildDocTable,
  buildEmptyNotice,
  buildFilterStrip,
  buildPageFooter,
  buildSignatureRow,
  fmtDate,
  fmtMoney,
  fmtQty,
  loadIssuer,
  loadPrintedBy,
  safeFileName,
  type DocColumn,
} from "./robno-doc-layout";

/**
 * Izveštajne štampe robnog modula: LAGER LISTA (stanje zaliha) i KARTICA ARTIKLA
 * (hronološko kretanje po magacinu) — BigBit `Lager lista` i `Kartica artikla`.
 *
 * Podaci se čitaju kroz POSTOJEĆI `RobnoService` (`listLager`, `getItemCard`), pa je
 * štampa uvek 1:1 sa ekranom — nema drugog izvora istine i nema drugog obračuna.
 *
 * Nadgradnja u odnosu na BigBit:
 *   - traka primenjenih filtera (magacin, pretraga, period) — bez nje izveštaj nije dokaziv;
 *   - „strana N/M" i trag štampe (BigBit ima samo `[Page]`, bez ukupnog broja strana);
 *   - kontrolni zbir u nozi (broj redova + Σ vrednosti);
 *   - kartica artikla ispisuje i nezavisno izračunato stanje (`stateAsOf`) kao kontrolu —
 *     ako se ne poklapa sa krajnjim saldom, dokument to KAŽE umesto da tiho prikaže broj.
 */
@Injectable()
export class StockReportPdfService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pdf: PdfService,
    private readonly robno: RobnoService,
  ) {}

  // ───────────────────────────────────────────────────────────── lager lista

  /** Lager lista (A4 položeno). Povlači SVE strane iz `listLager` (do `maxRows`). */
  async buildLagerPdf(
    query: { warehouseId?: number; onlyInStock?: boolean; q?: string },
    userId?: number | null,
    maxRows = 5000,
  ): Promise<{ buffer: Buffer; fileName: string }> {
    const rows: LagerRow[] = [];
    let skip = 0;
    let total = 0;
    // Paginirani servis se prolazi do kraja — štampa ne sme da preseče listu na 100 redova.
    for (;;) {
      const page = (await this.robno.listLager({
        ...query,
        skip,
        take: 500,
      })) as { data: LagerRow[]; meta: { total: number } };
      total = page.meta.total;
      rows.push(...page.data);
      skip += 500;
      // Prekid ISKLJUČIVO po `skip >= total` ili kapi: prazna strana nije kraj
      // liste (bila bi to samo da se filtriranje radi posle paginacije), pa bi
      // prekid na njoj tiho odsekao izveštaj i potpisao ga kao potpun.
      if (skip >= total || rows.length >= maxRows) break;
    }

    const warehouseIds = [...new Set(rows.map((r) => r.warehouseId))];
    const [issuer, printedBy, warehouses] = await Promise.all([
      loadIssuer(this.prisma, null),
      loadPrintedBy(this.prisma, userId),
      warehouseIds.length
        ? this.prisma.warehouse.findMany({
            where: { id: { in: warehouseIds } },
            select: { id: true, name: true },
          })
        : Promise.resolve([]),
    ]);
    const whById = new Map(warehouses.map((w) => [w.id, w.name]));

    const columns: DocColumn[] = [
      { header: "R.Br.", width: 26, numeric: true },
      { header: "Kat. broj", width: 80 },
      { header: "Naziv artikla", width: "*" },
      { header: "J.m.", width: 32 },
      { header: "Magacin", width: 96 },
      { header: "Stanje", width: 60, numeric: true },
      { header: "Rezervisano", width: 62, numeric: true },
      { header: "Raspoloživo", width: 62, numeric: true },
      { header: "Pros. nabavna", width: 66, numeric: true },
      { header: "Pros. VP", width: 62, numeric: true },
      { header: "Vrednost zaliha", width: 80, numeric: true },
    ];

    let sQty = new Prisma.Decimal(0);
    let sValue = new Prisma.Decimal(0);
    const body: TableCell[][] = rows.map((r, i) => {
      sQty = sQty.add(new Prisma.Decimal(r.onHand));
      sValue = sValue.add(new Prisma.Decimal(r.stockValue));
      const available = new Prisma.Decimal(r.available);
      return [
        { text: String(i + 1), style: "tdNum" },
        { text: r.itemCode ?? "—", style: "td" },
        { text: r.itemName ?? `Artikal #${r.itemId}`, style: "td" },
        { text: r.unit ?? "", style: "td" },
        { text: whById.get(r.warehouseId) ?? `#${r.warehouseId}`, style: "td" },
        { text: fmtQty(r.onHand), style: "tdNum" },
        {
          text: new Prisma.Decimal(r.reserved).isZero()
            ? ""
            : fmtQty(r.reserved),
          style: "tdNum",
        },
        {
          text: fmtQty(available),
          style: "tdNum",
          // Raspoloživo ≤ 0 je crveno — roba je već obećana, ne sme se obećati ponovo.
          color: available.lte(0) ? "#c00000" : undefined,
          bold: available.lte(0),
        },
        { text: fmtMoney(r.avgPurchaseNet), style: "tdNum" },
        { text: fmtMoney(r.avgWholesalePrice), style: "tdNum" },
        { text: fmtMoney(r.stockValue), style: "tdNum" },
      ];
    });

    const totals: TableCell[][] = [
      [
        { text: "S V E G A", colSpan: 5, style: "totLbl" },
        {},
        {},
        {},
        {},
        { text: fmtQty(sQty), style: "totVal" },
        {},
        {},
        {},
        {},
        { text: fmtMoney(sValue), style: "totVal" },
      ],
    ];

    const header = buildDocHeader({
      issuer,
      title: "LAGER LISTA",
      subtitle: `stanje zaliha na dan ${fmtDate(new Date())}`,
      compact: true,
    });
    const filters = buildFilterStrip([
      [
        "Magacin",
        query.warehouseId != null
          ? (whById.get(query.warehouseId) ?? `#${query.warehouseId}`)
          : "svi magacini",
      ],
      ["Pretraga", query.q?.trim() ? query.q.trim() : "—"],
      ["Prikaz", query.onlyInStock ? "samo artikli sa stanjem" : "svi artikli"],
      ["Redova u izveštaju", `${rows.length} od ${total}`],
    ]);

    const content: Content[] = [header, filters];
    if (rows.length) {
      content.push(buildDocTable({ columns, rows: body, totals }));
      content.push(
        buildControlSum([
          ["Redova", String(rows.length)],
          ["Σ količina", fmtQty(sQty)],
          ["Σ vrednost zaliha", fmtMoney(sValue)],
        ]),
      );
      if (rows.length >= maxRows && total > rows.length) {
        content.push({
          margin: [0, 6, 0, 0],
          style: "warn",
          text: `NEPOTPUNO — izveštaj je odsečen na ${maxRows} redova (ukupno ${total}). Suzi filter i ponovi štampu.`,
        });
      }
    } else {
      content.push(
        buildEmptyNotice(
          "Nema stavki za zadate uslove",
          "Lager se puni knjiženjem robnih dokumenata (ulaz/izlaz). Isključi filter " +
            "„samo sa stanjem“ ili promeni magacin, pa ponovi štampu.",
        ),
      );
    }
    content.push(
      buildSignatureRow(["Sastavio", "Odgovorno lice"], { stampOn: [1] }),
    );

    const docDefinition: TDocumentDefinitions = {
      ...PAGE_LANDSCAPE,
      content,
      styles: ROBNO_STYLES,
      defaultStyle: DEFAULT_STYLE,
      footer: buildPageFooter("Lager lista", printedBy, 24),
    };

    const buffer = await this.pdf.render(docDefinition);
    return {
      buffer,
      fileName: `LAGER-${new Date().toISOString().slice(0, 10)}.pdf`,
    };
  }

  // ───────────────────────────────────────────────────────── kartica artikla

  /** Kartica artikla (A4 uspravno) — hronološko kretanje sa running stanjem. */
  async buildItemCardPdf(
    params: { itemId: number; warehouseId: number; from?: string; to?: string },
    userId?: number | null,
  ): Promise<{ buffer: Buffer; fileName: string }> {
    const card = (await this.robno.getItemCard(params)) as { data: ItemCard };
    const data = card.data;

    const [issuer, printedBy, warehouse] = await Promise.all([
      loadIssuer(this.prisma, null),
      loadPrintedBy(this.prisma, userId),
      this.prisma.warehouse.findUnique({
        where: { id: params.warehouseId },
        select: { name: true },
      }),
    ]);

    const columns: DocColumn[] = [
      { header: "R.Br.", width: 24, numeric: true },
      { header: "Datum dok.", width: 60 },
      { header: "Broj dokumenta", width: 84 },
      { header: "Vrsta", width: 56 },
      { header: "Ulaz", width: 62, numeric: true },
      { header: "Izlaz", width: 62, numeric: true },
      { header: "Stanje", width: 68, numeric: true },
    ];

    // Prvi red kartice je uvek PRENOS (početno stanje pre `from`) — bez njega
    // running saldo na drugoj strani izgleda kao da je knjiga počela od nule.
    const openingRow: TableCell[] = [
      { text: "", style: "td" },
      { text: data.from ? fmtDate(data.from) : "", style: "td" },
      { text: "Početno stanje (donos)", style: "td", bold: true, colSpan: 2 },
      {},
      { text: "", style: "tdNum" },
      { text: "", style: "tdNum" },
      { text: fmtQty(data.openingBalance), style: "tdNum", bold: true },
    ];

    const body: TableCell[][] = data.lines.map((l, i) => [
      { text: String(i + 1), style: "tdNum" },
      { text: fmtDate(l.documentDate), style: "td" },
      { text: l.documentNumber, style: "td" },
      { text: `${l.kind} · ${l.documentTypeCode}`, style: "tdMuted" },
      {
        text: l.direction === "IN" ? fmtQty(l.in) : "",
        style: "tdNum",
      },
      {
        text: l.direction === "OUT" ? fmtQty(l.out) : "",
        style: "tdNum",
      },
      { text: fmtQty(l.balance), style: "tdNum" },
    ]);

    const totals: TableCell[][] = [
      [
        { text: "UKUPNO", colSpan: 4, style: "totLbl" },
        {},
        {},
        {},
        { text: fmtQty(data.totalIn), style: "totVal" },
        { text: fmtQty(data.totalOut), style: "totVal" },
        { text: fmtQty(data.closingBalance), style: "totVal" },
      ],
    ];

    const itemLabel = data.item
      ? `${data.item.name ?? `Artikal #${data.itemId}`}${
          data.item.code ? `  ·  kat. br. ${data.item.code}` : ""
        }`
      : `Artikal #${data.itemId}`;

    const header = buildDocHeader({
      issuer,
      title: "KARTICA ARTIKLA",
      subtitle: itemLabel,
    });
    const filters = buildFilterStrip([
      ["Artikal", itemLabel],
      ["Jedinica mere", data.item?.unit ?? "—"],
      [
        "Magacin",
        warehouse?.name
          ? `${warehouse.name} (#${params.warehouseId})`
          : `#${params.warehouseId}`,
      ],
      ["Od datuma", data.from ? fmtDate(data.from) : "od početka"],
      ["Do datuma", fmtDate(data.to)],
    ]);

    const mismatch = new Prisma.Decimal(data.closingBalance)
      .minus(new Prisma.Decimal(data.stateAsOf))
      .abs()
      .gt(0.000001);

    const content: Content[] = [header, filters];
    if (data.lines.length) {
      content.push(
        buildDocTable({ columns, rows: [openingRow, ...body], totals }),
      );
      content.push(
        buildControlSum([
          ["Redova", String(data.lines.length)],
          ["Početno stanje", fmtQty(data.openingBalance)],
          ["Σ ulaz", fmtQty(data.totalIn)],
          ["Σ izlaz", fmtQty(data.totalOut)],
          ["Krajnje stanje", fmtQty(data.closingBalance)],
          ["Kontrolno stanje (costing)", fmtQty(data.stateAsOf)],
        ]),
      );
      if (mismatch) {
        content.push({
          margin: [0, 6, 0, 0],
          style: "warn",
          text: "NEUSKLAĐENO — krajnje stanje kartice se ne poklapa sa nezavisno izračunatim stanjem. Javi administratoru pre upotrebe dokumenta.",
        });
      }
    } else {
      content.push(
        buildEmptyNotice(
          "Nema kretanja za zadate uslove",
          "U izabranom periodu nema robnih dokumenata za ovaj artikal i magacin. " +
            `Stanje na dan ${fmtDate(data.to)}: ${fmtQty(data.stateAsOf)}.`,
        ),
      );
    }
    content.push(
      buildSignatureRow(["Sastavio", "Odgovorno lice"], { stampOn: [1] }),
    );

    const docDefinition: TDocumentDefinitions = {
      ...PAGE_PORTRAIT,
      content,
      styles: ROBNO_STYLES,
      defaultStyle: DEFAULT_STYLE,
      footer: buildPageFooter(
        `Kartica artikla · ${safeFileName(data.item?.code ?? String(data.itemId))}`,
        printedBy,
      ),
    };

    const buffer = await this.pdf.render(docDefinition);
    return {
      buffer,
      fileName: `KARTICA-${safeFileName(
        data.item?.code ?? String(data.itemId),
      )}-MAG${params.warehouseId}.pdf`,
    };
  }
}

// ─────────────────────────────────── tipovi odgovora RobnoService (Decimal → string)

interface LagerRow {
  itemId: number;
  warehouseId: number;
  itemName: string | null;
  itemCode: string | null;
  unit: string | null;
  onHand: string;
  reserved: string;
  available: string;
  avgPurchaseNet: string;
  avgWholesalePrice: string;
  stockValue: string;
}

interface ItemCard {
  itemId: number;
  warehouseId: number;
  from: string | null;
  to: string;
  item: {
    id: number;
    name: string | null;
    code: string | null;
    unit: string | null;
  } | null;
  openingBalance: string;
  closingBalance: string;
  stateAsOf: string;
  totalIn: string;
  totalOut: string;
  lines: Array<{
    documentNumber: string;
    kind: string;
    documentTypeCode: string;
    documentDate: string;
    direction: "IN" | "OUT";
    in: string;
    out: string;
    balance: string;
  }>;
}
