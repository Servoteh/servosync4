import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
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
  PAGE_LANDSCAPE,
  ROBNO_STYLES,
  buildDocHeader,
  buildDocTable,
  buildEmptyNotice,
  buildMeta,
  buildPageFooter,
  buildParties,
  buildSignatureRow,
  fmtDate,
  fmtQty,
  loadIssuer,
  loadPrintedBy,
  safeFileName,
  sanitizeText,
  type DocColumn,
} from "./robno-doc-layout";

/**
 * ZAPISNIK O PRIJEMU ROBE (kvantitativno-kvalitativni) — BigBit
 * `V_PrijemnicaSaRazlikama` + `NalogZaPrijemRobe`.
 * =========================================================================
 * Prijemnica dokazuje ŠTA je ušlo u magacin; ovaj zapisnik dokazuje da je
 * prijem PREGLEDAN: koliko je naručeno, koliko je stvarno primljeno, kolika je
 * razlika i kakav je nalaz kontrole po stavci.
 *
 * KVANTITATIVNI DEO IMA PUN IZVOR: `purchase_order_items.orderedQuantity` (šta
 * je naručeno) naspram `stock_document_items.quantity` (šta je primljeno), preko
 * `stock_documents.purchaseOrderId`. To je isti izvor koji već hrani živu štampu
 * poređenja naručeno/primljeno/fakturisano u Nabavci — dva papira se ne mogu
 * raziću jer čitaju istu tabelu.
 *
 * PROTIV ČEGA JE OVAJ OBRAZAC PREPRAVLJEN (27.07.2026, tri nalaza revizije):
 *
 *  1. PORAVNANJE PO ARTIKLU, NE PO REDU. Ranije se naručena količina agregirala po
 *     artiklu pa PRIPISIVALA SVAKOM redu prijemnice sa tim artiklom — prijemnica sa
 *     istim artiklom na više redova (druga cena, druga serija) dobijala je naručenu
 *     količinu prepisanu na svaki red, pa je Σ naručeno bilo višestruko naduvano, a
 *     svaka stavka je dobijala crveni „manjak" koji ne postoji. Sada se OBE strane
 *     agregiraju po artiklu i porede agregat sa agregatom: JEDAN red po artiklu.
 *
 *  2. SPOJ, NE SAMO PRIJEMNICA. Telo je SPOJ (full outer) stavki narudžbenice i
 *     stavki ulaza. Naručeno a NEISPORUČENO se u robni ulaz uopšte ne upisuje
 *     (`nabavka.service.ts` filtrira `receivedQuantity > 0`), pa je baš ono zbog čega
 *     zapisnik postoji ranije bilo NEVIDLJIVO — red nije postojao, u razliku nije
 *     ulazio, i papir je tvrdio „nema odstupanja". Sada takva stavka ima svoj red sa
 *     Primljeno 0 i crvenim manjkom; primljeno a nenaručeno nosi oznaku „van
 *     narudžbenice" i crveni višak.
 *
 *  3. ČIST NALAZ SE IZRIČE SAMO KAD JE STVARNO ČIST. Ranije je odluka gledala samo
 *     `sumDiff.isZero()`, a zbir ostaje nula i kad se NIŠTA nije uporedilo (isporučen
 *     artikal koji nije naručen, narudžbenica bez `articleId`). Isporuka pogrešne robe
 *     davala je najčistiji mogući nalaz. Sada „nema odstupanja" traži da su OBA skupa
 *     potpuno pokrivena.
 *
 * KVALITATIVNI DEO NEMA IZVOR — I TO PIŠE NA PAPIRU. `stock_document_items`
 * danas nema nijedno polje za nalaz kontrole, rok trajanja ni seriju/LOT. Te tri
 * kolone se štampaju PRAZNE, kao linije za ručni upis, i u nozi je izričito
 * napisano zašto. Alternativa (prepisati bilo šta drugo u njih) bila bi tvrdnja
 * o kvalitetu robe koju niko nije uneo — na zapisniku o prijemu to je ozbiljnija
 * greška nego prazno polje.
 *
 * Kad dokument nije nastao iz narudžbenice, kolona „Naručeno" ostaje prazna
 * (nema šta da se poredi) i to je takođe ispisano — ne prepisuje se primljena
 * količina da bi razlika ispala nula.
 */

const ZERO = new Prisma.Decimal(0);

/** Kolona bez izvora u šemi — prazna linija za ručni upis. */
const MANUAL = "";

/**
 * Narudžbenica uz prijemnicu: BROJ (za papir) + naručene količine po artiklu
 * (za poređenje) + koliko stavki narudžbenice uopšte nema šifru artikla.
 */
interface OrderedInfo {
  orderNumber: string | null;
  orderedAt: Date | null;
  byArticle: Map<number, Prisma.Decimal>;
  linesWithoutArticle: number;
}

interface ReceiptItemMeta {
  name: string;
  catalogNumber: string;
  unit: string | null;
  barCode: string | null;
}

@Injectable()
export class GoodsReceiptReportPdfService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pdf: PdfService,
  ) {}

  /**
   * PDF zapisnika o prijemu za ULAZNI robni dokument. Vraća `{ buffer, fileName }`.
   * Dokument bez stavki ne puca — štampa se obrazac sa napomenom.
   */
  async buildPdf(
    documentId: number,
    userId?: number | null,
  ): Promise<{ buffer: Buffer; fileName: string }> {
    const doc = await this.prisma.stockDocument.findUnique({
      where: { id: documentId },
      include: {
        items: {
          where: { deletedAt: null },
          orderBy: [{ lineNo: "asc" }, { id: "asc" }],
        },
      },
    });
    if (!doc) {
      throw new NotFoundException(`Robni dokument ${documentId} ne postoji.`);
    }
    if (doc.kind !== "UL") {
      throw new BadRequestException(
        `Zapisnik o prijemu se izdaje samo uz ULAZNI dokument (UL); dokument ${doc.documentNumber} je vrste ${doc.kind}.`,
      );
    }

    const [issuer, printedBy, warehouse, supplier, ordered] = await Promise.all(
      [
        loadIssuer(this.prisma, doc.companyId),
        loadPrintedBy(this.prisma, userId),
        this.loadWarehouse(doc.warehouseId),
        this.loadSupplier(doc.supplierId),
        this.loadOrderedQuantities(doc.purchaseOrderId),
      ],
    );

    // Nazivi se učitavaju za SPOJ artikala (prijemnica + narudžbenica), ne samo za
    // stavke prijemnice: naručen a neisporučen artikal dobija svoj red i mora imati
    // naziv i kataloški broj, inače bi manjak bio prijavljen kao „Artikal #123".
    const itemsById = await this.loadItems([
      ...doc.items.map((i) => i.itemId),
      ...(ordered ? [...ordered.byArticle.keys()] : []),
    ]);

    const docDefinition = this.buildDoc({
      doc,
      issuer,
      printedBy,
      itemsById,
      warehouseName: warehouse,
      supplierName: supplier,
      ordered,
    });

    const buffer = await this.pdf.render(docDefinition);
    return {
      buffer,
      fileName: `ZAPISNIK-PRIJEM-${safeFileName(doc.documentNumber)}.pdf`,
    };
  }

  // ───────────────────────────────────────────────── učitavanje (meki ref-ovi)

  private async loadItems(
    ids: number[],
  ): Promise<Map<number, ReceiptItemMeta>> {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map();
    const rows = await this.prisma.item.findMany({
      where: { id: { in: unique } },
      select: {
        id: true,
        name: true,
        catalogNumber: true,
        unit: true,
        barCode: true,
      },
    });
    return new Map(
      rows.map((r) => [
        r.id,
        {
          name: sanitizeText(r.name),
          catalogNumber: r.catalogNumber,
          unit: r.unit,
          barCode: r.barCode,
        },
      ]),
    );
  }

  private async loadWarehouse(id: number): Promise<string> {
    const w = await this.prisma.warehouse.findUnique({
      where: { id },
      select: { name: true },
    });
    return w?.name ?? `Magacin #${id}`;
  }

  private async loadSupplier(id: number | null): Promise<string | null> {
    if (id == null || id <= 0) return null;
    const c = await this.prisma.customer.findUnique({
      where: { id },
      select: { name: true },
    });
    return c?.name ?? null;
  }

  /**
   * Narudžbenica: BROJ (ne interni id!) + naručena količina po artiklu.
   * `null` = dokument nije nastao iz narudžbenice → kolona „Naručeno" ostaje
   * prazna umesto da se prepiše primljena količina.
   *
   * Agregira se po artiklu jer druga strana poređenja (prijemnica) isto može imati
   * isti artikal na više redova — poređenje red-na-red bez eksplicitne veze stavka
   * ulaza → stavka narudžbenice nije moguće, a pripisivanje agregata svakom redu je
   * baš bag koji je ovaj obrazac oborio na reviziji.
   *
   * `linesWithoutArticle` se broji da bi papir mogao da prizna da deo narudžbenice
   * (slobodan tekst bez `articleId`) UOPŠTE nije ušao u poređenje.
   */
  private async loadOrderedQuantities(
    purchaseOrderId: number | null,
  ): Promise<OrderedInfo | null> {
    if (purchaseOrderId == null || purchaseOrderId <= 0) return null;
    const [order, rows] = await Promise.all([
      this.prisma.purchaseOrder.findUnique({
        where: { id: purchaseOrderId },
        select: { orderNumber: true, orderedAt: true },
      }),
      this.prisma.purchaseOrderItem.findMany({
        where: { orderId: purchaseOrderId },
        select: { articleId: true, orderedQuantity: true },
      }),
    ]);
    const byArticle = new Map<number, Prisma.Decimal>();
    let linesWithoutArticle = 0;
    for (const r of rows) {
      if (r.articleId == null) {
        linesWithoutArticle += 1;
        continue;
      }
      const prev = byArticle.get(r.articleId) ?? ZERO;
      byArticle.set(r.articleId, prev.add(r.orderedQuantity));
    }
    return {
      orderNumber: order?.orderNumber ?? null,
      orderedAt: order?.orderedAt ?? null,
      byArticle,
      linesWithoutArticle,
    };
  }

  // ─────────────────────────────────────────────────── definicija dokumenta

  private buildDoc(args: {
    doc: Prisma.StockDocumentGetPayload<{ include: { items: true } }>;
    issuer: Awaited<ReturnType<typeof loadIssuer>>;
    printedBy: string | null;
    itemsById: Map<number, ReceiptItemMeta>;
    warehouseName: string;
    supplierName: string | null;
    ordered: OrderedInfo | null;
  }): TDocumentDefinitions {
    const { doc, issuer, printedBy, warehouseName, supplierName, ordered } =
      args;

    const header = buildDocHeader({
      issuer,
      title: "ZAPISNIK O PRIJEMU ROBE",
      subtitle: `uz prijemnicu br. ${doc.documentNumber}   ·   ${fmtDate(doc.documentDate)}`,
      formCode: "kvantitativno-kvalitativni prijem",
      compact: true,
    });

    const parties = buildParties(
      {
        label: "Isporučilac (dobavljač)",
        name: supplierName ?? "—",
        lines: [],
      },
      {
        label: "Magacin prijema",
        name: warehouseName,
        lines: [],
      },
    );

    // BROJ narudžbenice, ne interni id reda: papir ide dobavljaču i komisiji, a id
    // ne stoji ni na jednom drugom dokumentu. Kad je narudžbenica obrisana, broja
    // nema — piše se da veza postoji, uz id, umesto tihe zamene.
    const orderLabel =
      ordered?.orderNumber != null
        ? ordered.orderNumber +
          (ordered.orderedAt ? ` od ${fmtDate(ordered.orderedAt)}` : "")
        : doc.purchaseOrderId != null
          ? `(narudžbenica #${doc.purchaseOrderId} nije pronađena)`
          : "—";

    const meta = buildMeta([
      ["Broj prijemnice", doc.documentNumber],
      ["Datum prijema", fmtDate(doc.documentDate)],
      ["Narudžbenica", orderLabel],
      ["Datum knjiženja", fmtDate(doc.postingDate)],
    ]);

    const content: Content[] = [header, parties, meta, ...this.buildBody(args)];
    content.push(
      buildSignatureRow(
        ["Robu isporučio", "Robu primio (magacioner)", "Kontrolu izvršio"],
        { stampOn: [2] },
      ),
    );

    return {
      ...PAGE_LANDSCAPE,
      watermark:
        doc.status === "DRAFT"
          ? {
              text: "NACRT — nije knjiženo",
              opacity: 0.07,
              bold: true,
              angle: -30,
            }
          : undefined,
      content,
      styles: ROBNO_STYLES,
      defaultStyle: DEFAULT_STYLE,
      footer: buildPageFooter(
        `Zapisnik o prijemu robe uz prijemnicu br. ${doc.documentNumber}`,
        printedBy,
        24,
      ),
      // `ordered == null` se u nozi objašnjava — v. `buildBody`.
    };
  }

  private buildBody(args: {
    doc: Prisma.StockDocumentGetPayload<{ include: { items: true } }>;
    itemsById: Map<number, ReceiptItemMeta>;
    ordered: OrderedInfo | null;
  }): Content[] {
    const { doc, itemsById, ordered } = args;
    if (!doc.items.length) {
      return [
        buildEmptyNotice(
          "Prijemnica nema stavki",
          "Zapisnik se izdaje uz prijemnicu sa stavkama. Zaglavlje i potpisna mesta " +
            "su odštampani da obrazac ostane upotrebljiv.",
        ),
      ];
    }

    const columns: DocColumn[] = [
      { header: "R.br.", width: 24, numeric: true },
      { header: "Kat. broj", width: 58 },
      { header: "Naziv artikla", width: "*" },
      { header: "J.m.", width: 26 },
      { header: "Naručeno", width: 56, numeric: true },
      { header: "Primljeno", width: 56, numeric: true },
      { header: "Višak /\nmanjak", width: 56, numeric: true },
      { header: "Rok trajanja", width: 62 },
      { header: "Serija / LOT", width: 62 },
      { header: "Nalaz kontrole", width: 110 },
    ];

    // ── SPOJ (full outer) narudžbenice i prijemnice, agregirano PO ARTIKLU ──────
    // Jedan red po artiklu: naručeno vs primljeno. Artikal koji je naručen a nije
    // stigao ovde DOBIJA red (u `doc.items` ga nema — v. blok na vrhu fajla).
    const receivedByArticle = new Map<number, Prisma.Decimal>();
    const firstLineOf = new Map<number, number>();
    doc.items.forEach((it, idx) => {
      const prev = receivedByArticle.get(it.itemId) ?? ZERO;
      receivedByArticle.set(it.itemId, prev.add(it.quantity));
      if (!firstLineOf.has(it.itemId)) {
        firstLineOf.set(it.itemId, it.lineNo || idx + 1);
      }
    });

    const orderedByArticle = ordered?.byArticle ?? null;
    // Redosled: prvo artikli po redosledu na prijemnici, pa naručeni-a-nestigli.
    const articleIds: number[] = [...receivedByArticle.keys()].sort(
      (a, b) => (firstLineOf.get(a) ?? 0) - (firstLineOf.get(b) ?? 0),
    );
    if (orderedByArticle) {
      for (const id of orderedByArticle.keys()) {
        if (!receivedByArticle.has(id)) articleIds.push(id);
      }
    }

    let sumOrdered = ZERO;
    let sumReceived = ZERO;
    let sumDiff = ZERO;
    let comparedArticles = 0; // ima i naručeno i primljeno
    let missingArticles = 0; // naručeno, nije stiglo
    let unorderedArticles = 0; // stiglo, nije naručeno

    const rows: TableCell[][] = articleIds.map((articleId, idx) => {
      const meta = itemsById.get(articleId);
      const ord = orderedByArticle?.get(articleId) ?? null;
      const rec = receivedByArticle.get(articleId) ?? null;
      const received = rec ?? ZERO;
      const diff = ord != null ? received.sub(ord) : null;

      if (ord != null) sumOrdered = sumOrdered.add(ord);
      if (rec != null) sumReceived = sumReceived.add(received);
      if (diff != null) sumDiff = sumDiff.add(diff);

      if (ord != null && rec != null) comparedArticles += 1;
      else if (ord != null) missingArticles += 1;
      else if (orderedByArticle) unorderedArticles += 1;

      // Napomena uz naziv: red koji nije uparen mora sam da kaže zašto.
      const name = meta?.name ?? `Artikal #${articleId}`;
      const nameCell: TableCell =
        orderedByArticle && ord == null
          ? {
              text: `${name}  (van narudžbenice)`,
              style: "td",
              color: "#b00020",
            }
          : orderedByArticle && rec == null
            ? {
                text: `${name}  (nije isporučeno)`,
                style: "td",
                color: "#b00020",
              }
            : { text: name, style: "td" };

      return [
        { text: String(firstLineOf.get(articleId) ?? idx + 1), style: "tdNum" },
        { text: meta?.catalogNumber ?? "—", style: "td" },
        nameCell,
        { text: meta?.unit ?? "", style: "td" },
        { text: ord != null ? fmtQty(ord) : "", style: "tdNum" },
        // Naručeno a neisporučeno: PRIMLJENO je stvarna nula, ne prazno polje —
        // nula je ovde tvrdnja koju zapisnik SME i MORA da iznese.
        { text: fmtQty(received), style: "tdNum" },
        // Odstupanje je razlog zbog kog zapisnik postoji — mora da bode oči.
        diff != null && !diff.isZero()
          ? {
              text: fmtQty(diff),
              style: "tdNum",
              color: "#b00020",
              bold: true,
            }
          : { text: "", style: "tdNum" },
        // Tri kolone bez izvora u šemi — prazne linije za ručni upis komisije.
        { text: MANUAL, style: "td" },
        { text: MANUAL, style: "td" },
        { text: MANUAL, style: "td" },
      ];
    });

    const comparableRows = comparedArticles + missingArticles;

    const totals: TableCell[][] = [
      [
        { text: "UKUPNO", colSpan: 4, style: "totLbl" },
        { text: "" },
        { text: "" },
        { text: "" },
        { text: comparableRows ? fmtQty(sumOrdered) : "", style: "totVal" },
        { text: fmtQty(sumReceived), style: "totVal" },
        { text: comparableRows ? fmtQty(sumDiff) : "", style: "totVal" },
        { text: "" },
        { text: "" },
        { text: "" },
      ],
    ];

    const out: Content[] = [buildDocTable({ columns, rows, totals })];

    // ── NALAZ ───────────────────────────────────────────────────────────────────
    // „Nema odstupanja" se izriče SAMO kad su oba skupa potpuno pokrivena i zbir
    // razlike je nula. Nula sama po sebi ne dokazuje ništa: ostaje nula i kad se
    // nijedna stavka nije uparila (v. blok na vrhu fajla, nalaz 3).
    if (ordered == null) {
      out.push({
        margin: [0, 8, 0, 0],
        style: "noteWarn",
        text:
          'Prijemnica nije vezana za narudžbenicu — kolona „Naručeno" nema izvor i ostaje ' +
          "prazna. Kvantitativna kontrola se u tom slučaju radi prema otpremnici dobavljača.",
      });
    } else if (
      // NIJEDAN artikal se ne pojavljuje na obe strane → poređenja nije ni bilo.
      comparedArticles === 0 &&
      (missingArticles > 0 || unorderedArticles > 0)
    ) {
      out.push({
        margin: [0, 8, 0, 0],
        style: "warn",
        text:
          "NIJEDNA STAVKA NIJE UPOREĐENA SA NARUDŽBENICOM — kvantitativni nalaz NIJE izveden. " +
          `Primljeno je ${unorderedArticles} artikala kojih na narudžbenici nema, a ` +
          `${missingArticles} naručenih artikala nije stiglo. Pre potpisa utvrditi da li je ` +
          "isporučena pogrešna roba ili je uz prijem vezana pogrešna narudžbenica.",
      });
    } else if (
      !sumDiff.isZero() ||
      missingArticles > 0 ||
      unorderedArticles > 0
    ) {
      const parts: string[] = [];
      if (!sumDiff.isZero()) parts.push(`Σ razlika ${fmtQty(sumDiff)}`);
      if (missingArticles > 0)
        parts.push(`naručeno a NIJE isporučeno: ${missingArticles} artikala`);
      if (unorderedArticles > 0)
        parts.push(
          `isporučeno van narudžbenice: ${unorderedArticles} artikala`,
        );
      out.push({
        margin: [0, 8, 0, 0],
        style: "warn",
        text:
          `ODSTUPANJE OD NARUDŽBENICE — ${parts.join("   ·   ")}. ` +
          "Zapisnik je osnov za reklamaciju dobavljaču.",
      });
    } else {
      out.push({
        margin: [0, 8, 0, 0],
        style: "note",
        text: "Kvantitativni nalaz: primljene količine odgovaraju naručenim (nema odstupanja).",
      });
    }

    // Deo narudžbenice bez šifre artikla (slobodan tekst) se NE MOŽE uporediti —
    // to mora da piše, inače „upoređeno" ćuti o tome što je ispalo iz poređenja.
    if (ordered != null && ordered.linesWithoutArticle > 0) {
      out.push({
        margin: [0, 6, 0, 0],
        style: "noteWarn",
        text:
          `Narudžbenica ima ${ordered.linesWithoutArticle} stavki bez šifre artikla ` +
          "(slobodan tekst) — one nisu ušle u poređenje i proveravaju se ručno.",
      });
    }

    out.push({
      margin: [0, 6, 0, 0],
      style: "note",
      text:
        `Kontrola: stavki na prijemnici ${doc.items.length}   ·   artikala u poređenju ${rows.length}   ·   ` +
        `upoređeno sa narudžbenicom ${comparedArticles}   ·   Σ primljeno ${fmtQty(sumReceived)}`,
    });
    out.push({
      margin: [0, 2, 0, 0],
      style: "note",
      text:
        "Poređenje je po ARTIKLU (obe strane sabrane), jer veza stavka prijemnice → stavka " +
        "narudžbenice ne postoji u evidenciji. Isti artikal na više redova prijemnice zato " +
        "čini jedan red ovog zapisnika.",
    });
    out.push({
      margin: [0, 6, 0, 0],
      style: "note",
      text:
        'Kolone „Rok trajanja", „Serija / LOT" i „Nalaz kontrole" popunjava komisija ručno — ' +
        "evidencija za njih još nema polja po stavci, pa se ne štampaju nikakve pretpostavljene " +
        "vrednosti.",
    });
    return out;
  }
}
