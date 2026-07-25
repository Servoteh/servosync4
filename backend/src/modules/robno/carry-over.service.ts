import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { RobnoService } from "./robno.service";
import { ReservationService } from "./reservation.service";
import type { CreateStockDocumentItemDto } from "./dto/create-stock-document.dto";

/** Opcije prepisa (carry-over) — magacin i vrsta dokumenta se mogu preklopiti sa podrazumevanih. */
export interface CarryOverOptions {
  /** Magacin ulaza/izlaza (meki ref). Podrazumevano 1 (kao nabavka.receiveOrder). */
  warehouseId?: number;
  /** `DocumentType.code`. Podrazumevano UFROB (prijem) / IFR (izdatnica). */
  documentTypeCode?: string;
}

/** Statusi narudžbenice iz kojih je prijem dozvoljen (nabavka status-mašina). */
const RECEIVABLE_ORDER_STATUS: ReadonlySet<string> = new Set([
  "ORDERED",
  "SIGNED",
  "LOCKED",
]);

/**
 * Dokle se prati lanac prepisa (`copiedFromDocId`) pri traženju rezervacija. Realan lanac je
 * predračun → račun (dubina 1); granica je čuvar od ciklusa/pokvarenih podataka.
 */
const RESERVATION_SOURCE_DEPTH = 3;

/**
 * Carry-over (prepis) dokumenata u robno (Batch B, Talas 2):
 *   • Narudžbenica (PurchaseOrder) → Primka (robni ulaz UL)
 *   • Predračun / faktura (Invoice) → Izdatnica (robni izlaz IZ)
 *
 * Oba puta samo PREPISUJU stavke u novi robni dokument kroz postojeći
 * `RobnoService.createStockDocument` (DRAFT) — kalkulacija/knjiženje ostaju na
 * detalju dokumenta. Anti-duplo:
 *   • PO: partial unique `uq_stock_documents_po` (jedna narudžbenica = max 1 ulaz)
 *     + eksplicitna provera radi lepše poruke (P2002 hvatamo kao fallback na trku).
 *   • Invoice: `Invoice.stockDocumentId != null` → 409; po uspehu se upisuje veza.
 *
 * IZ prolazi kroz `assertSufficientStock` guard iz `createStockDocument` (nedovoljno
 * stanje = 422 sa listom) — to je ISPRAVNO ponašanje i NE zaobilazi se.
 */
@Injectable()
export class CarryOverService {
  private readonly logger = new Logger(CarryOverService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly robno: RobnoService,
    private readonly reservation: ReservationService,
  ) {}

  // ─────────────────────────────────── PO → Primka (robni ulaz UL)

  /**
   * Prepiši narudžbenicu u robni ulaz (UL). Uzima stavke sa artiklom (`articleId`) i
   * količinom > 0, količina = naručena (`orderedQuantity`), cena = `unitPrice` (ako postoji),
   * veže `purchaseOrderId`. Nacrt (DRAFT) narudžbenica ne može u prijem (422). Ponovni
   * prepis iste narudžbenice = 409.
   */
  async fromPurchaseOrder(
    orderId: number,
    opts: CarryOverOptions,
    actorUserId?: number,
  ) {
    const order = await this.prisma.purchaseOrder.findUnique({
      where: { id: orderId },
      include: { items: { orderBy: [{ lineNo: "asc" }, { id: "asc" }] } },
    });
    if (!order)
      throw new NotFoundException(`Narudžbenica ${orderId} ne postoji.`);

    // Anti-duplo (eksplicitno, radi lepše poruke — DB partial unique je krajnji čuvar).
    const existing = await this.prisma.stockDocument.findFirst({
      where: { purchaseOrderId: orderId },
      select: { id: true, documentNumber: true },
    });
    if (existing)
      throw new ConflictException(
        `Narudžbenica je već preneta u prijem broj ${existing.documentNumber}.`,
      );

    // Status guard — prijem je moguć samo iz poručene narudžbenice (Nacrt → 422).
    if (!RECEIVABLE_ORDER_STATUS.has(order.status))
      throw new UnprocessableEntityException(
        `Narudžbenica je u statusu ${order.status}; prenos u prijem je moguć samo iz poručene narudžbenice (ORDERED/SIGNED/LOCKED).`,
      );

    const warehouseId = this.resolveWarehouseId(opts.warehouseId);
    const documentTypeCode = opts.documentTypeCode?.trim() || "UFROB";

    // Samo robne stavke (artikal + količina > 0). Usluge / prazne stavke se preskaču.
    const goodsLines = order.items.filter(
      (it) => it.articleId != null && it.orderedQuantity.gt(0),
    );
    if (goodsLines.length === 0)
      throw new UnprocessableEntityException(
        "Narudžbenica nema robnih stavki za prenos u prijem.",
      );

    const items: CreateStockDocumentItemDto[] = goodsLines.map((it, idx) => ({
      itemId: it.articleId as number,
      warehouseId,
      quantity: it.orderedQuantity.toString(),
      invoicePrice: it.unitPrice != null ? it.unitPrice.toString() : 0,
      lineNo: it.lineNo || idx + 1,
    }));

    try {
      const created = await this.robno.createStockDocument("UL", {
        documentTypeCode,
        warehouseId,
        supplierId: order.supplierId,
        purchaseOrderId: orderId,
        projectId: order.projectId ?? undefined,
        createdByUserId: actorUserId,
        items,
      });
      this.logger.log(
        `Prepis narudžbenice ${order.orderNumber} → prijem ${created.data.documentNumber} (${items.length} stavki).`,
      );
      return created;
    } catch (e) {
      // Trka: dva paralelna prepisa iste narudžbenice — DB partial unique (uq_stock_documents_po)
      // je uhvatio drugi. Poruku vraćamo samo ako ulaz za ovu narudžbenicu stvarno postoji;
      // svaki drugi P2002 se prosleđuje netaknut (ne prikrivamo tuđi konflikt).
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === "P2002"
      ) {
        const dup = await this.prisma.stockDocument.findFirst({
          where: { purchaseOrderId: orderId },
          select: { documentNumber: true },
        });
        if (dup)
          throw new ConflictException(
            `Narudžbenica je već preneta u prijem broj ${dup.documentNumber}.`,
          );
      }
      throw e;
    }
  }

  // ─────────────────────────────────── Predračun/faktura → Izdatnica (robni izlaz IZ)

  /**
   * Prepiši predračun/fakturu (Invoice) u izdatnicu (robni izlaz IZ). Uzima stavke sa
   * artiklom (`itemId`) i količinom > 0 (uslužne stavke bez artikla se preskaču). IZ prolazi
   * kroz `assertSufficientStock` (nedovoljno stanje = 422 sa listom). Anti-duplo:
   * `Invoice.stockDocumentId != null` → 409; po uspehu se veza upisuje na fakturu.
   *
   * REZERVACIJE: izuzimaju se i troše za CEO lanac prepisa (račun + predračun iz koga je
   * nastao — v. `resolveReservationSources`), i to u istoj transakciji sa upisom izdatnice.
   * U trci dva paralelna prepisa gubitnik briše svoju izdatnicu, a rezervacije ostaju
   * CONSUMED — ispravno, jer izdatnica pobednika stvarno razdužuje istu robu.
   */
  async fromInvoice(
    invoiceId: number,
    opts: CarryOverOptions,
    actorUserId?: number,
  ) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { items: { orderBy: [{ lineNo: "asc" }, { id: "asc" }] } },
    });
    if (!invoice)
      throw new NotFoundException(
        `Dokument (faktura) ${invoiceId} ne postoji.`,
      );

    // Anti-duplo — faktura je već razdužena kroz izdatnicu.
    if (invoice.stockDocumentId != null) {
      const linked = await this.prisma.stockDocument.findUnique({
        where: { id: invoice.stockDocumentId },
        select: { documentNumber: true },
      });
      throw new ConflictException(
        `Ovaj dokument je već prenet u izdatnicu broj ${linked?.documentNumber ?? invoice.stockDocumentId}.`,
      );
    }

    const warehouseId = this.resolveWarehouseId(opts.warehouseId);
    const documentTypeCode = opts.documentTypeCode?.trim() || "IFR";

    // Samo robne stavke (artikal + količina > 0). Uslužne stavke (bez itemId) ne razdužuju zalihu.
    const goodsLines = invoice.items.filter(
      (it) => it.itemId != null && it.quantity.gt(0),
    );
    if (goodsLines.length === 0)
      throw new UnprocessableEntityException(
        "Dokument nema robnih stavki za izdatnicu (samo uslužne stavke bez artikla).",
      );

    const items: CreateStockDocumentItemDto[] = goodsLines.map((it, idx) => ({
      itemId: it.itemId as number,
      warehouseId,
      quantity: it.quantity.toString(),
      invoicePrice: it.unitPrice != null ? it.unitPrice.toString() : 0,
      lineNo: it.lineNo || idx + 1,
    }));

    // IZ → assertSufficientStock guard u createStockDocument (nedovoljno stanje = 422).
    // Batch C: guard gleda RASPOLOŽIVO (stanje − rezervisano), pa izdatnica mora da
    // izuzme rezervacije SAMOG tog predračuna — inače bi predračun koji drži robu
    // blokirao sopstvenu izdatnicu.
    const reservationSources = await this.resolveReservationSources(invoice);
    const consumeReason = (documentNumber: string) =>
      `izdatnica ${documentNumber}`;

    const created = await this.robno.createStockDocument(
      "IZ",
      {
        documentTypeCode,
        warehouseId,
        customerId: invoice.customerId ?? undefined,
        createdByUserId: actorUserId,
        items,
      },
      {
        reservationSource: reservationSources,
        // Rezervacije se zatvaraju U ISTOJ TRANSAKCIJI sa upisom izdatnice (review B):
        // roba je otišla → CONSUMED (ne RELEASED, jer se ne vraća u raspoloživo). Kad izvor
        // nema rezervacija (najčešći slučaj — niko nije kliknuo „Rezerviši"), `consumeWithin`
        // vraća `noop` umesto 404, pa nema lažnog upozorenja u logu na svakom prepisu.
        afterCreate: async (tx, doc) => {
          for (const source of reservationSources) {
            await this.reservation.consumeWithin(
              tx,
              { ...source, reason: consumeReason(doc.documentNumber) },
              actorUserId,
            );
          }
        },
      },
    );

    // Upiši vezu na fakturu — CAS (review Batch B): `stockDocumentId` nema DB unique,
    // pa bi dva istovremena poziva oba prošla rani anti-duplo guard i napravila DVE
    // izdatnice (dvostruko razduženje zaliha). Uslov `stockDocumentId: null` propušta
    // tačno jednog; gubitnik briše svoju upravo kreiranu izdatnicu i vraća 409.
    const claimed = await this.prisma.invoice.updateMany({
      where: { id: invoiceId, stockDocumentId: null },
      data: { stockDocumentId: created.data.id },
    });
    if (claimed.count !== 1) {
      await this.prisma.stockDocumentItem.deleteMany({
        where: { documentId: created.data.id },
      });
      await this.prisma.stockDocument
        .delete({ where: { id: created.data.id } })
        .catch(() => undefined);
      throw new ConflictException(
        `Dokument ${invoice.documentNumber} je u međuvremenu prenet u izdatnicu ` +
          `(paralelni zahtev) — ponovi pregled fakture.`,
      );
    }
    this.logger.log(
      `Prepis fakture ${invoice.documentNumber} → izdatnica ${created.data.documentNumber} ` +
        `(${items.length} stavki, izvori rezervacija: ${reservationSources
          .map((s) => s.sourceId)
          .join(", ")}).`,
    );
    return created;
  }

  /**
   * Izvori rezervacija koje OVA izdatnica troši: sam dokument + lanac dokumenata iz kojih je
   * prepisan (`copiedFromDocId`).
   *
   * ZAŠTO (review R1): „Rezerviši robu" upisuje rezervacije na PREDRAČUN (`sourceId` =
   * predračun), a `DocumentCarryOverService.createInvoiceFromProforma` pravi NOV level-0 račun
   * i rezervacije OSTAVLJA na predračunu. Izdatnica se pravi iz konačnog računa, pa bi izvor
   * `{invoice, račun}` promašio svaki red: guard bi rezervisanu količinu oduzeo od stanja
   * (422 „nedovoljno stanje" na robi koja fizički stoji), a rezervacije bi ostale OPEN zauvek.
   *
   * Alternativa je bila da `sales/carry-over` PREBACI rezervacije na novi račun; odbačena je jer
   * bi (a) rezervacija izgubila vezu sa dokumentom na kome je korisnik kliknuo „Rezerviši",
   * (b) otkazivanje predračuna prestalo da oslobađa robu, i (c) izdatnica napravljena direktno
   * iz predračuna (podržan tok) opet promašila izvor. Razrešavanje lanca pokriva oba toka.
   */
  private async resolveReservationSources(invoice: {
    id: number;
    copiedFromDocId: number | null;
  }): Promise<Array<{ sourceType: "invoice"; sourceId: number }>> {
    const ids: number[] = [invoice.id];
    const seen = new Set<number>([invoice.id]);
    let parentId = invoice.copiedFromDocId;
    for (let depth = 0; depth < RESERVATION_SOURCE_DEPTH; depth++) {
      if (parentId == null || parentId <= 0 || seen.has(parentId)) break;
      seen.add(parentId);
      ids.push(parentId);
      const parent = await this.prisma.invoice.findUnique({
        where: { id: parentId },
        select: { copiedFromDocId: true },
      });
      if (!parent) break;
      parentId = parent.copiedFromDocId;
    }
    return ids.map((id) => ({ sourceType: "invoice" as const, sourceId: id }));
  }

  /** Magacin iz opcija (pozitivan ceo broj) ili podrazumevani 1 (kao nabavka.receiveOrder). */
  private resolveWarehouseId(warehouseId?: number): number {
    return Number.isInteger(warehouseId) && (warehouseId as number) > 0
      ? (warehouseId as number)
      : 1;
  }
}
