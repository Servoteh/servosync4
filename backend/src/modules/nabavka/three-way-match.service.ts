/**
 * THREE-WAY MATCH SERVICE — naručeno ↔ primljeno ↔ fakturisano (Traka B §B).
 * =========================================================================
 *
 * ⚠️ POSLOVNA ODLUKA KORISNIKA (izričita): odstupanje se **PRIJAVLJUJE, ali NIKAD
 * ne blokira plaćanje.** Ovaj servis je čitalac — ne piše ništa, ne baca izuzetak
 * zbog neslaganja (jedini `throw` je 404 za nepostojeću narudžbenicu) i nijedan
 * njegov rezultat ne sme ući u guard koji zaustavlja pripremu/potpis/izvoz naloga.
 *
 * IZVORI PODATAKA (šta je stvarno povezano u šemi — provereno, ne pretpostavljeno)
 * ---------------------------------------------------------------------------
 *  1) NARUČENO   `purchase_orders` + `purchase_order_items`
 *                (`ordered_quantity`, `unit_price` — cena postoji tek na narudžbenici).
 *
 *  2) PRIMLJENO  `purchase_order_items.received_quantity` (BigBit „IsporucenaKolicina") —
 *                upisuje ga `NabavkaService.receiveOrder` pri prijemu robe.
 *
 *  3) FAKTURISANO  stavke robnog ulaza vezanog za narudžbenicu:
 *                `stock_documents.purchase_order_id = purchase_orders.id`
 *                (parcijalni unique `uq_stock_documents_po` → najviše JEDAN ulaz po
 *                narudžbenici; svejedno čitamo listom radi otpornosti) →
 *                `stock_document_items.quantity` × `invoice_price` (Fakturna cena/JM).
 *                Robni ulaz je nosilac ULAZNE FAKTURE u ovom sistemu: `UFROB` =
 *                „ulazna faktura za robu", a `invoice_price`/`discount_percent`/
 *                `cash_discount_percent` su podaci prepisani sa dobavljačeve fakture.
 *                Zato „primljeno" i „fakturisano" LEGITIMNO odstupaju: `receive`
 *                upisuje fizički prijem na narudžbenicu, a robni ulaz se posle
 *                koriguje po stvarnoj fakturi (carry-over `fromPurchaseOrder` ga uopšte
 *                pravi iz NARUČENIH količina kao DRAFT, pre prijema).
 *
 *  4) KUF (knjiga ulaznih faktura) — `vat_ledger_entries` sa `direction='input'`.
 *                DIREKTNE veze KUF ↔ narudžbenica U ŠEMI NEMA. Postoji posredna,
 *                dokument-nivo veza koju ovde i koristimo:
 *                  PO → `stock_documents.purchase_order_id`
 *                     → `stock_documents.journal_entry_id` (postavlja PostingEngine)
 *                     → `vat_ledger_entries.source_journal_entry_id`
 *                KUF nema stavke (samo osnovica + PDV po dokumentu), pa se koristi
 *                kao KONTROLA ZBIRA i izvor brojeva dokumenata za spajanje sa
 *                pripremom plaćanja — ne kao izvor količina po stavci.
 *                (`sef_incoming_invoices` je posebna evidencija ulaznih e-faktura:
 *                 vezuje se na KUF preko `matched_kuf_entry_id`, ali NEMA nikakvu
 *                 kolonu ka narudžbenici — zato ne ulazi u uparivanje.)
 *
 * UPARIVANJE STAVKI: robni dokument nema `order_item_id`, pa se stavke uparuju po
 * ARTIKLU (`article_id` ↔ `item_id`). Kad više stavki narudžbenice deli isti artikal,
 * fakturisana količina se raspoređuje redom po `line_no` (svaka stavka do svoje
 * naručene količine, ostatak na poslednju) — kod uobičajenog „jedan artikal = jedna
 * stavka" raspodela je egzaktna. Stavke bez artikla (usluge) se ne uparuju
 * (`matchable: false`) i ne dobijaju količinske nalaze.
 */

import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import {
  type MatchFinding,
  type MatchFindingCode,
  type MatchedStockDocument,
  type MatchedVatLedger,
  type MatchSummaryQueryDto,
  type PaymentMatchWarning,
  type PaymentWarningsQueryDto,
  type ThreeWayMatchLine,
  type ThreeWayMatchResult,
  type ThreeWayMatchSummaryRow,
  validateMatchSummaryQuery,
  validatePaymentWarningsQuery,
} from "./dto/three-way-match.dto";

const D = Prisma.Decimal;
const ZERO = new D(0);

// ─────────────────────────────────────────────────────────────── TOLERANCIJE
//
// Jedini pragovi za prijavu odstupanja. Držati ih OVDE (konstante), ne u env-u:
// vrednosti su poslovno pravilo, ne podešavanje okruženja — nova env promenljiva
// bi tražila i red u `.env.example` i deploy da bi se promenila (BACKEND_RULES §10).

/**
 * KOLIČINA — tolerancija 0 %: svako odstupanje količine se prijavljuje.
 * Količine su celobrojne/merene i ne „zaokružuju se" kao cene; u nabavci je svaki
 * komad razlike podatak koji čovek mora da vidi.
 */
const QTY_TOLERANCE_PERCENT = new D(0);

/**
 * CENA — odstupanje se prijavljuje tek kad je prekoračen **I** procentualni **I**
 * apsolutni prag (klasična „veći od dva praga" tolerancija):
 *   • > 2 % razlike jedinične cene (naručena → fakturna), **i**
 *   • > 500 RSD razlike na nivou stavke (razlika cene × fakturisana količina).
 * Time se gasi šum od zaokruživanja i sitnih rabata na jeftinim stavkama, a
 * poslovno značajna odstupanja i dalje isplivaju. Valuta praga = valuta
 * narudžbenice (`purchase_orders.currency`; RSD je podrazumevana).
 */
const PRICE_TOLERANCE_PERCENT = new D(2);
const PRICE_TOLERANCE_AMOUNT = new D(500);

/** Gornja granica broja narudžbenica po jednom pozivu (pregled/upozorenja). */
const MATCH_BATCH_LIMIT = 200;

/** Statusi narudžbenice koji uopšte mogu imati prijem/fakturu (za pretragu upozorenja). */
const MATCHABLE_ORDER_STATUS: readonly string[] = [
  "ORDERED",
  "SIGNED",
  "LOCKED",
  "RECEIVED",
  "CLOSED",
];

// ─────────────────────────────────────────────────────────────── interni tipovi

interface OrderRow {
  id: number;
  orderNumber: string;
  supplierId: number;
  status: string;
  currency: string;
  orderedAt: Date | null;
  items: Array<{
    id: number;
    lineNo: number;
    articleId: number | null;
    description: string | null;
    unit: string | null;
    orderedQuantity: Prisma.Decimal;
    receivedQuantity: Prisma.Decimal;
    unitPrice: Prisma.Decimal | null;
  }>;
}

interface StockDocRow {
  id: number;
  purchaseOrderId: number | null;
  documentNumber: string;
  status: string;
  documentDate: Date;
  journalEntryId: number | null;
  items: Array<{
    itemId: number;
    quantity: Prisma.Decimal;
    invoicePrice: Prisma.Decimal;
  }>;
}

interface VatRow {
  id: number;
  documentNumber: string;
  vatBase: Prisma.Decimal;
  vatAmount: Prisma.Decimal;
  sourceJournalEntryId: number | null;
}

/** Agregat fakturisanog po artiklu (iz stavki robnog ulaza). */
interface InvoicedArticle {
  quantity: Prisma.Decimal;
  amount: Prisma.Decimal;
}

@Injectable()
export class ThreeWayMatchService {
  private readonly logger = new Logger(ThreeWayMatchService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ─────────────────────────────────────────── 1) poređenje jedne narudžbenice

  /**
   * Poređenje naručeno/primljeno/fakturisano po stavci za jednu narudžbenicu.
   * Jedini izuzetak je 404 (narudžbenica ne postoji) — odstupanja se vraćaju kao
   * podaci, NIKAD kao greška.
   */
  async matchOrder(orderId: number): Promise<ThreeWayMatchResult> {
    const [result] = await this.matchOrders([orderId]);
    if (!result)
      throw new NotFoundException(`Narudžbenica ${orderId} ne postoji.`);
    return result;
  }

  // ─────────────────────────────────────────── 2) pregled po više narudžbenica

  /**
   * Pregled 3-way match-a po više narudžbenica (lista/izveštaj). Filteri: period
   * (`from`/`to` po `ordered_at`, fallback `created_at`), dobavljač, i
   * `onlyWithFindings` (samo narudžbenice sa nalazom).
   *
   * `meta.total` je broj narudžbenica koje prolaze DB filter (pre `onlyWithFindings`),
   * `meta.returned` je broj vraćenih redova — filtriranje po nalazima je izvedeno
   * (nalazi se računaju, ne čuvaju), pa se ne može gurnuti u SQL.
   */
  async matchSummary(params: MatchSummaryQueryDto = {}): Promise<{
    data: ThreeWayMatchSummaryRow[];
    meta: {
      total: number;
      returned: number;
      skip: number;
      take: number;
      withFindings: number;
      withWarnings: number;
    };
  }> {
    validateMatchSummaryQuery(params);

    const take = Math.min(params.take ?? 50, MATCH_BATCH_LIMIT);
    const skip = params.skip ?? 0;

    const where: Prisma.PurchaseOrderWhereInput = {};
    if (params.supplierId != null) where.supplierId = params.supplierId;
    const period = this.buildPeriodFilter(params.from, params.to);
    if (period) {
      // `orderedAt` je nullabilan (DRAFT nije poručen) — period hvata i po `createdAt`.
      where.OR = [
        { orderedAt: period },
        { orderedAt: null, createdAt: period },
      ];
    }

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.purchaseOrder.findMany({
        where,
        orderBy: [{ orderedAt: "desc" }, { id: "desc" }],
        skip,
        take,
        select: { id: true },
      }),
      this.prisma.purchaseOrder.count({ where }),
    ]);

    const matches = await this.matchOrders(rows.map((r) => r.id));
    const summaries = matches.map((m) => this.toSummaryRow(m));
    const withFindings = summaries.filter((s) => s.findingCount > 0).length;
    const withWarnings = summaries.filter((s) => s.hasWarnings).length;
    const data =
      params.onlyWithFindings === true
        ? summaries.filter((s) => s.findingCount > 0)
        : summaries;

    return {
      data,
      meta: {
        total,
        returned: data.length,
        skip,
        take,
        withFindings,
        withWarnings,
      },
    };
  }

  // ─────────────────────────────────────────── 3) upozorenja za pripremu plaćanja

  /**
   * Upozorenja vezana za dokumente koji ulaze u pripremu plaćanja.
   *
   * Priprema plaćanja identifikuje otvorenu stavku kao (komitent, broj dokumenta),
   * pa se ovde traži isto: narudžbenice tog dobavljača i/ili narudžbenice do kojih
   * se stiže preko broja dokumenta (broj narudžbenice ILI broj robnog ulaza).
   * Bez ijednog filtera vraća prazan niz — puni skener nabavke nije svrha ovog poziva.
   *
   * ⚠️ Rezultat je ISKLJUČIVO informativan: pozivalac ga prikazuje uz stavku i
   * NE sme na osnovu njega da odbije kreiranje/potpis/izvoz naloga.
   */
  async warningsForPayment(
    params: PaymentWarningsQueryDto = {},
  ): Promise<PaymentMatchWarning[]> {
    validatePaymentWarningsQuery(params);

    const documentNumbers = (params.documentNumbers ?? [])
      .map((n) => n.trim())
      .filter((n) => n !== "");
    if (params.partnerId == null && documentNumbers.length === 0) return [];

    const orderIds = new Set<number>();

    if (documentNumbers.length > 0) {
      const [byOrderNumber, byStockDoc] = await this.prisma.$transaction([
        this.prisma.purchaseOrder.findMany({
          where: { orderNumber: { in: documentNumbers } },
          select: { id: true },
          take: MATCH_BATCH_LIMIT,
        }),
        this.prisma.stockDocument.findMany({
          where: {
            documentNumber: { in: documentNumbers },
            purchaseOrderId: { not: null },
          },
          select: { purchaseOrderId: true },
          take: MATCH_BATCH_LIMIT,
        }),
      ]);
      for (const o of byOrderNumber) orderIds.add(o.id);
      for (const d of byStockDoc)
        if (d.purchaseOrderId != null) orderIds.add(d.purchaseOrderId);
    }

    if (params.partnerId != null) {
      const bySupplier = await this.prisma.purchaseOrder.findMany({
        where: {
          supplierId: params.partnerId,
          status: { in: [...MATCHABLE_ORDER_STATUS] },
        },
        orderBy: [{ orderedAt: "desc" }, { id: "desc" }],
        select: { id: true },
        take: MATCH_BATCH_LIMIT,
      });
      for (const o of bySupplier) orderIds.add(o.id);
    }

    if (orderIds.size === 0) return [];
    if (orderIds.size > MATCH_BATCH_LIMIT) {
      this.logger.warn(
        `warningsForPayment: ${orderIds.size} narudžbenica prelazi granicu ` +
          `${MATCH_BATCH_LIMIT} — poređenje je odsečeno (upozorenja su informativna).`,
      );
    }

    const matches = await this.matchOrders(
      [...orderIds].slice(0, MATCH_BATCH_LIMIT),
    );

    const warnings: PaymentMatchWarning[] = [];
    for (const m of matches) {
      if (!m.hasFindings) continue;
      const docNumbers = [
        m.orderNumber,
        ...m.stockDocuments.map((d) => d.documentNumber),
        ...(m.vatLedger?.documentNumbers ?? []),
      ].filter((n): n is string => typeof n === "string" && n !== "");
      const unique = [...new Set(docNumbers)];
      for (const f of m.findings) {
        warnings.push({
          code: f.code,
          level: f.level,
          message: f.message,
          orderId: m.orderId,
          orderNumber: m.orderNumber,
          supplierId: m.supplierId,
          lineNo: f.lineNo,
          documentNumbers: unique,
        });
      }
    }
    return warnings;
  }

  // ─────────────────────────────────────────── batch učitavanje + računanje

  /**
   * Batch poređenje (bez N+1): 4 upita bez obzira na broj narudžbenica —
   * narudžbenice+stavke, robni ulazi+stavke, KUF stavke, nazivi dobavljača.
   */
  async matchOrders(orderIds: number[]): Promise<ThreeWayMatchResult[]> {
    const ids = [...new Set(orderIds)].filter((id) => Number.isInteger(id));
    if (ids.length === 0) return [];

    const orders = (await this.prisma.purchaseOrder.findMany({
      where: { id: { in: ids } },
      orderBy: { id: "asc" },
      select: {
        id: true,
        orderNumber: true,
        supplierId: true,
        status: true,
        currency: true,
        orderedAt: true,
        items: {
          orderBy: [{ lineNo: "asc" }, { id: "asc" }],
          select: {
            id: true,
            lineNo: true,
            articleId: true,
            description: true,
            unit: true,
            orderedQuantity: true,
            receivedQuantity: true,
            unitPrice: true,
          },
        },
      },
    })) as OrderRow[];
    if (orders.length === 0) return [];

    // Robni ulazi vezani za ove narudžbenice; meko obrisane stavke se preskaču
    // (soft-delete Batch B: čitaoci MORAJU filtrirati `deletedAt: null`).
    const stockDocs = (await this.prisma.stockDocument.findMany({
      where: { purchaseOrderId: { in: ids } },
      orderBy: { id: "asc" },
      select: {
        id: true,
        purchaseOrderId: true,
        documentNumber: true,
        status: true,
        documentDate: true,
        journalEntryId: true,
        items: {
          where: { deletedAt: null },
          select: { itemId: true, quantity: true, invoicePrice: true },
        },
      },
    })) as StockDocRow[];

    // KUF (ulazna faktura) preko GL naloga robnog ulaza — jedina veza koja u šemi postoji.
    const journalIds = stockDocs
      .map((d) => d.journalEntryId)
      .filter((j): j is number => j != null);
    const vatRows: VatRow[] = journalIds.length
      ? await this.prisma.vatLedgerEntry.findMany({
          where: {
            direction: "input",
            sourceJournalEntryId: { in: journalIds },
          },
          select: {
            id: true,
            documentNumber: true,
            vatBase: true,
            vatAmount: true,
            sourceJournalEntryId: true,
          },
        })
      : [];

    // Naziv dobavljača — meki ref na sync-keš komitenata (bez JOIN-a).
    const supplierIds = [...new Set(orders.map((o) => o.supplierId))];
    const suppliers = supplierIds.length
      ? await this.prisma.customer.findMany({
          where: { id: { in: supplierIds } },
          select: { id: true, name: true },
        })
      : [];
    const supplierName = new Map(suppliers.map((s) => [s.id, s.name]));

    const docsByOrder = new Map<number, StockDocRow[]>();
    for (const d of stockDocs) {
      if (d.purchaseOrderId == null) continue;
      const list = docsByOrder.get(d.purchaseOrderId) ?? [];
      list.push(d);
      docsByOrder.set(d.purchaseOrderId, list);
    }
    const vatByJournal = new Map<number, VatRow[]>();
    for (const v of vatRows) {
      if (v.sourceJournalEntryId == null) continue;
      const list = vatByJournal.get(v.sourceJournalEntryId) ?? [];
      list.push(v);
      vatByJournal.set(v.sourceJournalEntryId, list);
    }

    return orders.map((order) =>
      this.buildMatch(
        order,
        docsByOrder.get(order.id) ?? [],
        vatByJournal,
        supplierName.get(order.supplierId) ?? null,
      ),
    );
  }

  /** Čisto računanje jednog poređenja (bez baze) — srce servisa. */
  private buildMatch(
    order: OrderRow,
    docs: StockDocRow[],
    vatByJournal: Map<number, VatRow[]>,
    supplierName: string | null,
  ): ThreeWayMatchResult {
    // 1) Fakturisano po artiklu (Σ količina, Σ iznos) iz stavki robnog ulaza.
    const invoicedByArticle = new Map<number, InvoicedArticle>();
    for (const doc of docs) {
      for (const it of doc.items) {
        const cur = invoicedByArticle.get(it.itemId) ?? {
          quantity: ZERO,
          amount: ZERO,
        };
        invoicedByArticle.set(it.itemId, {
          quantity: cur.quantity.add(it.quantity),
          amount: cur.amount.add(it.quantity.mul(it.invoicePrice)),
        });
      }
    }

    // 2) Raspodela fakturisanog po stavkama (isti artikal na više stavki → redom).
    const remaining = new Map<number, InvoicedArticle>();
    for (const [articleId, agg] of invoicedByArticle)
      remaining.set(articleId, { ...agg });
    const lastLineIdByArticle = new Map<number, number>();
    for (const it of order.items)
      if (it.articleId != null) lastLineIdByArticle.set(it.articleId, it.id);

    const currency = order.currency || "RSD";
    const lines: ThreeWayMatchLine[] = [];
    let totalOrdered = ZERO;
    let totalInvoiced = ZERO;

    for (const item of order.items) {
      const orderedQty = item.orderedQuantity;
      const receivedQty = item.receivedQuantity;
      const orderedPrice = item.unitPrice;
      const orderedAmount = orderedQty.mul(orderedPrice ?? ZERO);

      let invoicedQty = ZERO;
      let invoicedAmount = ZERO;
      let invoicedPrice: Prisma.Decimal | null = null;

      const matchable = item.articleId != null;
      if (matchable) {
        const pool = remaining.get(item.articleId as number);
        if (pool && pool.quantity.gt(ZERO)) {
          // Ponderisana prosečna fakturna cena artikla (Σiznos / Σkoličina).
          const avgPrice = pool.amount.div(pool.quantity);
          const isLastLine =
            lastLineIdByArticle.get(item.articleId as number) === item.id;
          // Svaka stavka uzima do svoje naručene količine; poslednja stavka tog
          // artikla nosi i eventualni višak (inače bi višak nestao iz poređenja).
          invoicedQty =
            isLastLine || pool.quantity.lessThanOrEqualTo(orderedQty)
              ? pool.quantity
              : orderedQty;
          invoicedAmount = invoicedQty.mul(avgPrice);
          invoicedPrice = avgPrice;
          remaining.set(item.articleId as number, {
            quantity: pool.quantity.sub(invoicedQty),
            amount: pool.amount.sub(invoicedAmount),
          });
        }
      }

      const findings = this.findingsForLine({
        item,
        orderedQty,
        receivedQty,
        invoicedQty,
        orderedPrice,
        invoicedPrice,
        matchable,
        currency,
      });

      totalOrdered = totalOrdered.add(orderedAmount);
      totalInvoiced = totalInvoiced.add(invoicedAmount);

      lines.push({
        orderItemId: item.id,
        lineNo: item.lineNo,
        articleId: item.articleId,
        description: item.description,
        unit: item.unit,
        orderedQty: orderedQty.toFixed(4),
        receivedQty: receivedQty.toFixed(4),
        invoicedQty: invoicedQty.toFixed(4),
        orderedUnitPrice: orderedPrice != null ? orderedPrice.toFixed(4) : null,
        invoicedUnitPrice:
          invoicedPrice != null ? invoicedPrice.toFixed(4) : null,
        orderedAmount: orderedAmount.toFixed(4),
        invoicedAmount: invoicedAmount.toFixed(4),
        varianceAmount: invoicedAmount.sub(orderedAmount).toFixed(4),
        matchable,
        findings,
      });
    }

    // 3) KUF trag (kontrola zbira + brojevi dokumenata za spajanje sa plaćanjima).
    const vatEntries: VatRow[] = [];
    for (const doc of docs) {
      if (doc.journalEntryId == null) continue;
      vatEntries.push(...(vatByJournal.get(doc.journalEntryId) ?? []));
    }
    let vatLedger: MatchedVatLedger | null = null;
    if (vatEntries.length > 0) {
      let base = ZERO;
      let vat = ZERO;
      for (const v of vatEntries) {
        base = base.add(v.vatBase);
        vat = vat.add(v.vatAmount);
      }
      vatLedger = {
        entryIds: vatEntries.map((v) => v.id),
        documentNumbers: [
          ...new Set(vatEntries.map((v) => v.documentNumber).filter(Boolean)),
        ],
        vatBase: base.toFixed(4),
        vatAmount: vat.toFixed(4),
      };
    }

    const stockDocuments: MatchedStockDocument[] = docs.map((d) => ({
      id: d.id,
      documentNumber: d.documentNumber,
      status: d.status,
      documentDate: d.documentDate.toISOString(),
      journalEntryId: d.journalEntryId,
    }));

    const findings = lines.flatMap((l) => l.findings);

    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      supplierId: order.supplierId,
      supplierName,
      status: order.status,
      currency,
      orderedAt: order.orderedAt ? order.orderedAt.toISOString() : null,
      stockDocuments,
      vatLedger,
      totals: {
        orderedAmount: totalOrdered.toFixed(4),
        invoicedAmount: totalInvoiced.toFixed(4),
        varianceAmount: totalInvoiced.sub(totalOrdered).toFixed(4),
      },
      lines,
      findings,
      hasFindings: findings.length > 0,
      hasWarnings: findings.some((f) => f.level === "WARNING"),
    };
  }

  /** Nalazi za jednu stavku — jedino mesto gde se primenjuju tolerancije. */
  private findingsForLine(input: {
    item: OrderRow["items"][number];
    orderedQty: Prisma.Decimal;
    receivedQty: Prisma.Decimal;
    invoicedQty: Prisma.Decimal;
    orderedPrice: Prisma.Decimal | null;
    invoicedPrice: Prisma.Decimal | null;
    matchable: boolean;
    currency: string;
  }): MatchFinding[] {
    const {
      item,
      orderedQty,
      receivedQty,
      invoicedQty,
      orderedPrice,
      invoicedPrice,
      matchable,
      currency,
    } = input;
    const findings: MatchFinding[] = [];
    if (!matchable) return findings; // usluga/slobodan opis — nema šta da se uparuje
    const unit = item.unit ? ` ${item.unit}` : "";
    const push = (
      code: MatchFindingCode,
      level: MatchFinding["level"],
      message: string,
    ): void => {
      findings.push({
        code,
        level,
        message,
        orderItemId: item.id,
        lineNo: item.lineNo,
      });
    };

    // a) primljeno vs naručeno — samo VIŠAK prijema je nalaz (tolerancija 0 %).
    //    Manjak (primljeno < naručeno) je normalna delimična isporuka i nema svoj
    //    kod u katalogu odstupanja — ne prijavljuje se.
    const overOrder = receivedQty.sub(orderedQty);
    if (overOrder.gt(ZERO) && this.exceedsQtyTolerance(overOrder, orderedQty)) {
      push(
        "QTY_OVER_ORDER",
        "WARNING",
        `Primljeno ${fmt(receivedQty)}${unit}, a naručeno ${fmt(orderedQty)}${unit} — ` +
          `primljeno više nego naručeno (višak ${fmt(overOrder)}${unit}).`,
      );
    }

    // b) fakturisano vs primljeno.
    const overReceipt = invoicedQty.sub(receivedQty);
    if (invoicedQty.gt(ZERO) && receivedQty.lessThanOrEqualTo(ZERO)) {
      push(
        "NO_RECEIPT",
        "WARNING",
        `Fakturisano ${fmt(invoicedQty)}${unit} bez evidentiranog prijema — ` +
          `proveri prijem robe po ovoj narudžbenici.`,
      );
    } else if (this.exceedsQtyTolerance(overReceipt, receivedQty)) {
      if (overReceipt.gt(ZERO)) {
        push(
          "QTY_OVER_RECEIPT",
          "WARNING",
          `Fakturisano ${fmt(invoicedQty)}${unit}, a primljeno ${fmt(receivedQty)}${unit} — ` +
            `fakturisano više nego primljeno (razlika ${fmt(overReceipt)}${unit}).`,
        );
      } else {
        push(
          "QTY_UNDER_RECEIPT",
          "INFO",
          `Primljeno ${fmt(receivedQty)}${unit}, a fakturisano ${fmt(invoicedQty)}${unit} — ` +
            `faktura još nije stigla u celosti (razlika ${fmt(overReceipt.abs())}${unit}).`,
        );
      }
    }

    // c) cena — prag je prekoračen tek kad su prekoračena OBA praga (§TOLERANCIJE).
    if (
      orderedPrice != null &&
      orderedPrice.gt(ZERO) &&
      invoicedPrice != null &&
      invoicedQty.gt(ZERO)
    ) {
      const diff = invoicedPrice.sub(orderedPrice);
      const percent = diff.abs().div(orderedPrice).mul(100);
      const amount = diff.abs().mul(invoicedQty);
      if (
        percent.gt(PRICE_TOLERANCE_PERCENT) &&
        amount.gt(PRICE_TOLERANCE_AMOUNT)
      ) {
        const smer = diff.gt(ZERO) ? "viša" : "niža";
        push(
          "PRICE_VARIANCE",
          "WARNING",
          `Jedinična cena na fakturi ${fmt(invoicedPrice, 2)} je ${smer} od naručene ` +
            `${fmt(orderedPrice, 2)} za ${fmt(percent, 2)} % (${fmt(amount, 2)} ${currency}).`,
        );
      }
    }

    return findings;
  }

  /**
   * Da li razlika količine prelazi toleranciju. Pri 0 % (podrazumevano) svaka
   * razlika različita od nule je nalaz; procenat se meri prema referentnoj količini.
   */
  private exceedsQtyTolerance(
    diff: Prisma.Decimal,
    reference: Prisma.Decimal,
  ): boolean {
    if (diff.isZero()) return false;
    if (QTY_TOLERANCE_PERCENT.lessThanOrEqualTo(ZERO)) return true;
    const allowed = reference.abs().mul(QTY_TOLERANCE_PERCENT).div(100);
    return diff.abs().gt(allowed);
  }

  private toSummaryRow(m: ThreeWayMatchResult): ThreeWayMatchSummaryRow {
    return {
      orderId: m.orderId,
      orderNumber: m.orderNumber,
      supplierId: m.supplierId,
      supplierName: m.supplierName,
      status: m.status,
      currency: m.currency,
      orderedAt: m.orderedAt,
      orderedAmount: m.totals.orderedAmount,
      invoicedAmount: m.totals.invoicedAmount,
      varianceAmount: m.totals.varianceAmount,
      findingCount: m.findings.length,
      warningCount: m.findings.filter((f) => f.level === "WARNING").length,
      hasWarnings: m.hasWarnings,
      codes: [...new Set(m.findings.map((f) => f.code))],
    };
  }

  /** Period filter (`from`/`to`); `to` je uključivo do kraja dana. */
  private buildPeriodFilter(
    from?: string,
    to?: string,
  ): Prisma.DateTimeFilter | null {
    if (!from && !to) return null;
    const filter: Prisma.DateTimeFilter = {};
    if (from) filter.gte = new Date(from);
    if (to) {
      const end = new Date(to);
      end.setHours(23, 59, 59, 999);
      filter.lte = end;
    }
    return filter;
  }
}

/** Broj u srpskom zapisu (decimalni zarez) za poruke ka korisniku. */
function fmt(value: Prisma.Decimal, scale = 4): string {
  return value.toFixed(scale).replace(".", ",");
}
