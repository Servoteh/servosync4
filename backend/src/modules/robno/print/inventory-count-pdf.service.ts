import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type {
  Content,
  TableCell,
  TDocumentDefinitions,
} from "pdfmake/interfaces";
import { PrismaService } from "../../../prisma/prisma.service";
import { PdfService } from "../../documents/pdf.service";
import {
  DEFAULT_STYLE,
  GRID_LAYOUT,
  PAGE_LANDSCAPE,
  ROBNO_STYLES,
  buildDocHeader,
  buildDocTable,
  buildEmptyNotice,
  buildFilterStrip,
  buildPageFooter,
  fmtDate,
  fmtMoney,
  fmtQty,
  loadIssuer,
  loadPrintedBy,
  safeFileName,
  type DocBadge,
} from "./robno-doc-layout";

/**
 * POPISNA LISTA (inventura) — ZAKONSKI PROPISAN OBRAZAC. Kolone i redosled se preuzimaju
 * DOSLOVNO iz BigBit obrazaca `Popisna lista` / `PopisnaLista_Prazna` (RecordSource „Lager lista"),
 * jer je to ono što knjigovođa i revizija očekuju:
 *
 *   R.Br. | Kat. broj | Bar kod | Naziv | Jed. mere | Cena
 *   | Stanje po knjigama: Količina, Iznos
 *   | Stanje po popisu:  Količina, Iznos
 *   | Višak:  Količina, Iznos
 *   | Manjak: Količina, Iznos
 *
 * Dvoredno grupisano zaglavlje (4 nadnaslova nad 8 numeričkih kolona), A4 POLOŽENO —
 * uspravno je neupotrebljivo. Potpisi: „Odgovorno lice" | „Za knjigovodstvo" |
 * „Članovi komisije za popis: 1) 2) 3)".
 *
 * Dve varijante iz JEDNOG šablona (BigBit ima tri odvojena izveštaja):
 *   - `prazna`    — za teren: bez knjigovodstvenog stanja i bez cena, sa Bar kodom i
 *                   praznim poljima za ručni upis (BigBit `PopisnaLista_Prazna`);
 *   - `popunjena` — puni obrazac sa razlikama (višak/manjak) i zbirovima.
 *
 * Naša nadgradnja se drži isključivo noge i značke (dozvoljeno kod propisanih obrazaca):
 * „strana N/M", trag štampe, statusna značka popisa, kontrolni zbir.
 */
export type InventoryPrintVariant = "prazna" | "popunjena";

export const INVENTORY_PRINT_VARIANTS: InventoryPrintVariant[] = [
  "prazna",
  "popunjena",
];

const ZERO = new Prisma.Decimal(0);

@Injectable()
export class InventoryCountPdfService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pdf: PdfService,
  ) {}

  async buildPdf(
    countId: number,
    variant: InventoryPrintVariant = "popunjena",
    userId?: number | null,
  ): Promise<{ buffer: Buffer; fileName: string }> {
    const count = await this.prisma.inventoryCount.findUnique({
      where: { id: countId },
      include: { items: { orderBy: { id: "asc" } } },
    });
    if (!count) throw new NotFoundException(`Popis ${countId} ne postoji.`);

    const itemIds = [...new Set(count.items.map((i) => i.itemId))];
    const [issuer, printedBy, items, warehouse] = await Promise.all([
      loadIssuer(this.prisma, count.companyId),
      loadPrintedBy(this.prisma, userId),
      itemIds.length
        ? this.prisma.item.findMany({
            where: { id: { in: itemIds } },
            select: {
              id: true,
              name: true,
              catalogNumber: true,
              barCode: true,
              unit: true,
            },
          })
        : Promise.resolve([]),
      count.warehouseId > 0
        ? this.prisma.warehouse.findUnique({
            where: { id: count.warehouseId },
            select: { name: true, street: true, city: true },
          })
        : Promise.resolve(null),
    ]);
    const itemById = new Map(items.map((i) => [i.id, i]));

    // Artikli se štampaju azbučno po nazivu — popisna komisija ide po nazivu, ne po id-u.
    const sorted = [...count.items].sort((a, b) => {
      const an = itemById.get(a.itemId)?.name ?? "";
      const bn = itemById.get(b.itemId)?.name ?? "";
      return an.localeCompare(bn, "sr");
    });

    const docDefinition = this.buildDocDefinition({
      count,
      rowsSource: sorted,
      itemById,
      issuer,
      printedBy,
      warehouseName: warehouse?.name ?? `Magacin #${count.warehouseId}`,
      warehouseAddress:
        [warehouse?.street, warehouse?.city].filter(Boolean).join(", ") || null,
      variant,
    });

    const buffer = await this.pdf.render(docDefinition);
    return {
      buffer,
      fileName: `POPIS-${safeFileName(count.countNumber)}-${variant}.pdf`,
    };
  }

  private buildDocDefinition(args: {
    count: Prisma.InventoryCountGetPayload<{ include: { items: true } }>;
    rowsSource: Prisma.InventoryCountItemGetPayload<object>[];
    itemById: Map<
      number,
      {
        id: number;
        name: string;
        catalogNumber: string;
        barCode: string | null;
        unit: string | null;
      }
    >;
    issuer: Awaited<ReturnType<typeof loadIssuer>>;
    printedBy: string | null;
    warehouseName: string;
    warehouseAddress: string | null;
    variant: InventoryPrintVariant;
  }): TDocumentDefinitions {
    const { count, rowsSource, itemById, issuer, printedBy, variant } = args;

    const header = buildDocHeader({
      issuer,
      title: "POPISNA LISTA",
      subtitle:
        variant === "prazna"
          ? "sa stanjem na dan ______________________"
          : `sa stanjem na dan ${fmtDate(count.countDate)}`,
      formCode: "Obrazac — popisna lista",
      badge: statusBadge(count.status, variant),
      compact: true,
    });

    const filters = buildFilterStrip([
      ["Broj popisa", count.countNumber],
      ["Godina", String(count.year)],
      ["Magacin", args.warehouseName],
      ["Adresa magacina", args.warehouseAddress ?? "—"],
      ["Datum popisa", fmtDate(count.countDate)],
      [
        "Varijanta",
        variant === "prazna" ? "prazna (za teren)" : "popunjena (sa razlikama)",
      ],
    ]);

    const orgUnit: Content = {
      margin: [0, 0, 0, 8],
      columns: [
        {
          width: "*",
          text: "Organizaciona jedinica: ______________________________________",
          style: "note",
        },
        {
          width: "*",
          text: "Popisna lista broj: __________  ·  list ______ od ______",
          style: "note",
          alignment: "right",
        },
      ],
    };

    const body: Content[] = rowsSource.length
      ? variant === "prazna"
        ? this.buildBlankTable(rowsSource, itemById)
        : this.buildFullTable(rowsSource, itemById)
      : [
          buildEmptyNotice(
            "Popis nema stavki",
            "Stavke popisa se predpunjavaju knjigovodstvenim stanjem magacina pri kreiranju popisa. " +
              "Obrazac je odštampan sa zaglavljem i potpisima da ostane upotrebljiv za ručni popis.",
          ),
        ];

    return {
      ...PAGE_LANDSCAPE,
      content: [header, filters, orgUnit, ...body, this.buildSignatures()],
      styles: ROBNO_STYLES,
      defaultStyle: DEFAULT_STYLE,
      footer: buildPageFooter(
        `Popisna lista br. ${count.countNumber}/${count.year}`,
        printedBy,
        24,
      ),
    };
  }

  /**
   * Terenska („prazna") varijanta — bez knjigovodstvenog stanja i cena, sa Bar kodom i
   * praznim ćelijama za ručni upis. Komisija upisuje količinu na licu mesta.
   */
  private buildBlankTable(
    rows: Prisma.InventoryCountItemGetPayload<object>[],
    itemById: Map<
      number,
      {
        name: string;
        catalogNumber: string;
        barCode: string | null;
        unit: string | null;
      }
    >,
  ): Content[] {
    const columns = [
      { header: "R.Br.", width: 26, numeric: true },
      { header: "Bar kod", width: 90 },
      { header: "Kat. broj", width: 80 },
      { header: "Naziv artikla", width: "*" },
      { header: "Jed. mere", width: 44 },
      { header: "Popisana količina", width: 110, numeric: true },
      { header: "Napomena", width: 150 },
    ];
    const bodyRows: TableCell[][] = rows.map((r, i) => {
      const meta = itemById.get(r.itemId);
      return [
        { text: String(i + 1), style: "tdNum" },
        { text: meta?.barCode ?? "", style: "td" },
        { text: meta?.catalogNumber ?? "—", style: "td" },
        { text: meta?.name ?? `Artikal #${r.itemId}`, style: "td" },
        { text: meta?.unit ?? "", style: "td" },
        { text: " ", style: "tdNum" },
        { text: " ", style: "td" },
      ];
    });
    return [
      buildDocTable({ columns, rows: bodyRows, layout: GRID_LAYOUT }),
      {
        margin: [0, 8, 0, 0],
        style: "note",
        text: `Ukupno artikala na listi: ${rows.length}. Popisane količine upisuje komisija na licu mesta, hemijskom olovkom, bez ispravki.`,
      },
    ];
  }

  /** Puni („popunjena") obrazac — 4 grupe po 2 numeričke kolone + zbirovi. */
  private buildFullTable(
    rows: Prisma.InventoryCountItemGetPayload<object>[],
    itemById: Map<
      number,
      {
        name: string;
        catalogNumber: string;
        barCode: string | null;
        unit: string | null;
      }
    >,
  ): Content[] {
    const columns = [
      { header: "R.Br.", width: 22, numeric: true },
      { header: "Kat. broj", width: 62 },
      { header: "Bar kod", width: 66 },
      { header: "Naziv artikla", width: "*" },
      { header: "Jed. mere", width: 34 },
      { header: "Cena", width: 52, numeric: true },
      { header: "Količina", width: 52, numeric: true },
      { header: "Iznos", width: 62, numeric: true },
      { header: "Količina", width: 52, numeric: true },
      { header: "Iznos", width: 62, numeric: true },
      { header: "Količina", width: 46, numeric: true },
      { header: "Iznos", width: 58, numeric: true },
      { header: "Količina", width: 46, numeric: true },
      { header: "Iznos", width: 58, numeric: true },
    ];

    // Nadnaslovi grupa (propisano dvoredno zaglavlje): prvih 6 kolona ide preko oba reda.
    const spanCell = (text: string): TableCell => ({
      text,
      rowSpan: 2,
      style: "th",
      alignment: "center",
    });
    const groupHeader: TableCell[] = [
      spanCell("R.Br."),
      spanCell("Kat. broj"),
      spanCell("Bar kod"),
      spanCell("Naziv artikla"),
      spanCell("Jed. mere"),
      spanCell("Cena"),
      {
        text: "Stanje po knjigama",
        colSpan: 2,
        style: "th",
        alignment: "center",
      },
      {},
      {
        text: "Stanje po popisu",
        colSpan: 2,
        style: "th",
        alignment: "center",
      },
      {},
      { text: "Višak", colSpan: 2, style: "th", alignment: "center" },
      {},
      { text: "Manjak", colSpan: 2, style: "th", alignment: "center" },
      {},
    ];
    // Drugi red zaglavlja: prvih 6 su „progutane" rowSpan-om (prazni objekti).
    const subHeader: TableCell[] = [
      {},
      {},
      {},
      {},
      {},
      {},
      ...[
        "Količina",
        "Iznos",
        "Količina",
        "Iznos",
        "Količina",
        "Iznos",
        "Količina",
        "Iznos",
      ].map((t) => ({ text: t, style: "thNum" })),
    ];

    let sBookQty = ZERO;
    let sBookVal = ZERO;
    let sCountQty = ZERO;
    let sCountVal = ZERO;
    let sSurQty = ZERO;
    let sSurVal = ZERO;
    let sShoQty = ZERO;
    let sShoVal = ZERO;

    const bodyRows: TableCell[][] = rows.map((r, i) => {
      const meta = itemById.get(r.itemId);
      const bookVal = r.bookQuantity.mul(r.price).toDecimalPlaces(2);
      const countVal = r.countedQuantity.mul(r.price).toDecimalPlaces(2);
      const diff = r.countedQuantity.minus(r.bookQuantity);
      const surQty = diff.gt(0) ? diff : ZERO;
      const shoQty = diff.lt(0) ? diff.abs() : ZERO;
      const surVal = surQty.mul(r.price).toDecimalPlaces(2);
      const shoVal = shoQty.mul(r.price).toDecimalPlaces(2);

      sBookQty = sBookQty.add(r.bookQuantity);
      sBookVal = sBookVal.add(bookVal);
      sCountQty = sCountQty.add(r.countedQuantity);
      sCountVal = sCountVal.add(countVal);
      sSurQty = sSurQty.add(surQty);
      sSurVal = sSurVal.add(surVal);
      sShoQty = sShoQty.add(shoQty);
      sShoVal = sShoVal.add(shoVal);

      return [
        { text: String(i + 1), style: "tdNum" },
        { text: meta?.catalogNumber ?? "—", style: "td" },
        { text: meta?.barCode ?? "", style: "td" },
        { text: meta?.name ?? `Artikal #${r.itemId}`, style: "td" },
        { text: meta?.unit ?? "", style: "td" },
        { text: fmtMoney(r.price), style: "tdNum" },
        { text: fmtQty(r.bookQuantity), style: "tdNum" },
        { text: fmtMoney(bookVal), style: "tdNum" },
        { text: fmtQty(r.countedQuantity), style: "tdNum" },
        { text: fmtMoney(countVal), style: "tdNum" },
        { text: surQty.isZero() ? "" : fmtQty(surQty), style: "tdNum" },
        { text: surVal.isZero() ? "" : fmtMoney(surVal), style: "tdNum" },
        { text: shoQty.isZero() ? "" : fmtQty(shoQty), style: "tdNum" },
        { text: shoVal.isZero() ? "" : fmtMoney(shoVal), style: "tdNum" },
      ];
    });

    const totals: TableCell[][] = [
      [
        { text: "S V E G A", colSpan: 6, style: "totLbl" },
        {},
        {},
        {},
        {},
        {},
        { text: fmtQty(sBookQty), style: "totVal" },
        { text: fmtMoney(sBookVal), style: "totVal" },
        { text: fmtQty(sCountQty), style: "totVal" },
        { text: fmtMoney(sCountVal), style: "totVal" },
        { text: fmtQty(sSurQty), style: "totVal" },
        { text: fmtMoney(sSurVal), style: "totVal" },
        { text: fmtQty(sShoQty), style: "totVal" },
        { text: fmtMoney(sShoVal), style: "totVal" },
      ],
    ];

    const net = sSurVal.minus(sShoVal);
    // `buildDocTable` gradi telo [groupHeader, naslovi kolona, …redovi]; drugi red
    // zamenjujemo propisanim podnaslovima grupa (Količina/Iznos ×4).
    const table = this.injectSubHeader(
      buildDocTable({
        columns,
        rows: bodyRows,
        totals,
        groupHeader,
        layout: GRID_LAYOUT,
      }),
      subHeader,
    );
    return [
      table,
      {
        margin: [0, 8, 0, 0],
        style: "note",
        text:
          `Kontrola: stavki ${rows.length}   ·   Σ višak ${fmtMoney(sSurVal)}   ·   ` +
          `Σ manjak ${fmtMoney(sShoVal)}   ·   neto razlika ${fmtMoney(net)}`,
      },
    ];
  }

  /**
   * Ubacuje drugi red zaglavlja (podnaslovi grupa) odmah iza nadnaslova i podiže
   * `headerRows` na 2, da se OBA reda ponove na svakoj strani.
   */
  private injectSubHeader(table: Content, subHeader: TableCell[]): Content {
    const t = table as { table?: { body: TableCell[][]; headerRows?: number } };
    if (!t.table) return table;
    // buildDocTable je već ubacio: [groupHeader, headerCells, ...rows]. Zamenjujemo
    // automatski generisani red naslova kolona propisanim podnaslovima grupa.
    t.table.body[1] = subHeader;
    t.table.headerRows = 2;
    return table;
  }

  /** Potpisni blok popisne liste — natpisi doslovno iz BigBit obrasca. */
  private buildSignatures(): Content {
    const line = (label: string): Content => ({
      stack: [
        {
          canvas: [
            {
              type: "line",
              x1: 0,
              y1: 0,
              x2: 190,
              y2: 0,
              lineWidth: 0.6,
              lineColor: "#666666",
            },
          ],
        },
        { text: label, style: "signLbl", margin: [0, 3, 0, 0] },
      ],
    });
    return {
      unbreakable: true,
      margin: [0, 26, 0, 0],
      columns: [
        line("Odgovorno lice"),
        line("Za knjigovodstvo"),
        {
          width: "*",
          stack: [
            { text: "Članovi komisije za popis:", style: "sectionLbl" },
            {
              text: "1) ______________________________",
              style: "note",
              margin: [0, 6, 0, 0],
            },
            {
              text: "2) ______________________________",
              style: "note",
              margin: [0, 6, 0, 0],
            },
            {
              text: "3) ______________________________",
              style: "note",
              margin: [0, 6, 0, 0],
            },
          ],
        },
      ],
      columnGap: 24,
    };
  }
}

function statusBadge(status: string, variant: InventoryPrintVariant): DocBadge {
  if (variant === "prazna") return { text: "ZA POPIS NA TERENU", tone: "info" };
  switch (status) {
    case "DRAFT":
      return { text: "NACRT", tone: "neutral" };
    case "COUNTING":
      return { text: "POPISIVANJE U TOKU", tone: "info" };
    case "POSTED":
      return { text: "ZAKLJUČEN POPIS", tone: "success" };
    default:
      return { text: status, tone: "neutral" };
  }
}
