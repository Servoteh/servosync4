import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { businessYear } from "../../common/business-date";
import { parseDateParam } from "../../common/date-params";
import { NOT_DELETED } from "../../common/soft-delete.util";
import { StockDocumentNumberingService } from "./stock-document-numbering.service";
import { RobnoService } from "./robno.service";
import { toDec } from "./decimal.util";
import { computeKepuEntries, writeKepuEntries } from "./kepu-book.util";
import { lockStockKeys, sumOpenReservations } from "./reservation.service";
import type {
  CreateTransferDto,
  CreateTransferItemDto,
  ReverseTransferDto,
} from "./dto/transfer.dto";

/**
 * PRENOS IZMEĐU MAGACINA (međuskladišnica) — jedini ispravan put.
 * =============================================================================
 * BAG KOJI OVAJ SERVIS ZATVARA (nalaz §3.2, PREGLED_DOKUMENATA_4.0):
 * `createStockDocument("PRENOS", …)` je pravio JEDAN dokument sa JEDNIM
 * `warehouseId`, a stanje se svuda računa kao Σ(±količina) po
 * `stock_document_items.warehouse_id` sa znakom iz `DocumentType.isInbound`.
 * Jedan dokument = jedan znak = jedan magacin: izvorni magacin se razduži,
 * odredišni NE DOBIJE NIŠTA (`target_warehouse_id` ne čita nijedan obračun
 * stanja — samo KEPU vrednosno). Roba tiho nestane iz lagera.
 *
 * REŠENJE: prenos je PAR dokumenata, u JEDNOJ transakciji:
 *   • PREIZ (`is_inbound = false`) na IZVORNOM magacinu   → razduženje,
 *   • PREUL (`is_inbound = true`)  na ODREDIŠNOM magacinu → zaduženje,
 * povezanih obostrano preko `transfer_pair_doc_id`. Ni jedna strana ne može da
 * nastane bez druge (ista transakcija), pa zbir po oba magacina ostaje očuvan.
 *
 * VREDNOST: kad cena nije zadata, uzima se PONDERISANA PROSEČNA cena izvornog
 * magacina na dan prenosa — ista formula koju koristi lager
 * (`Σ(±Kol × cena) / Σ(±Kol)`). Skidanje po proseku ne pomera prosek u izvoru, a
 * odredište dobija tačno onu vrednost koju je izvor izgubio → Σ vrednosti zaliha
 * firme je invarijanta prenosa.
 *
 * GLAVNA KNJIGA: prenos između sopstvenih magacina ne menja imovinu firme, pa
 * vrste PREIZ/PREUL nemaju šemu kontiranja (`posting_template = 0`) i ne knjiže se.
 * KEPU (robna evidencija po magacinu) se vodi — piše se ovde, u istoj transakciji,
 * jer prenos ne prolazi kroz `robno post`.
 *
 * STORNO: `reverse()` pravi OGLEDALNI par (izlaz iz odredišta + ulaz u izvor) i
 * upisuje `reversal_of_doc_id`. Parcijalni UNIQUE `uq_stock_documents_reversal_of`
 * garantuje da se isti dokument ne stornira dvaput (dvostruki storno bi duplo
 * zadužio izvorni magacin — isti gubitak istine, samo u drugom smeru).
 */
@Injectable()
export class TransferService {
  private readonly logger = new Logger(TransferService.name);

  /** Vrsta dokumenta za izlaznu stranu prenosa (`is_inbound = false`). */
  static readonly OUT_TYPE = "PREIZ";
  /** Vrsta dokumenta za ulaznu stranu prenosa (`is_inbound = true`). */
  static readonly IN_TYPE = "PREUL";

  /**
   * Isti prozor kao `createStockDocument` — unutra se čekaju advisory lock-ovi zalihe
   * (oba magacina) i DVA brojača dokumenata, pa Prisma default (5 s) pod kontencijom
   * puca sa P2028 umesto da sačeka red.
   */
  private static readonly TX = { maxWait: 10_000, timeout: 20_000 } as const;

  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: StockDocumentNumberingService,
    private readonly robno: RobnoService,
  ) {}

  // ------------------------------------------------------------------ READ

  /**
   * Detalj prenosa (bilo koja strana para) — vraća OBE strane sa stavkama i sažetak
   * „šta se desilo kom magacinu", plus podatak da li je prenos storniran.
   */
  async get(id: number) {
    const doc = await this.prisma.stockDocument.findUnique({
      where: { id },
      include: { items: { where: NOT_DELETED, orderBy: { id: "asc" } } },
    });
    if (!doc) throw new NotFoundException(`Robni dokument ${id} ne postoji.`);
    if (doc.kind !== "PRENOS")
      throw new UnprocessableEntityException(
        `Dokument ${id} nije prenos između magacina (kind=${doc.kind}).`,
      );
    if (doc.transferPairDocId == null)
      throw new ConflictException(
        `Dokument ${id} je JEDNOSTRAN prenos (bez parnog dokumenta) — nastao je pre ` +
          `ispravke od 27.07.2026. i njegova roba nije zadužena ni u jednom magacinu.`,
      );

    const pair = await this.prisma.stockDocument.findUnique({
      where: { id: doc.transferPairDocId },
      include: { items: { where: NOT_DELETED, orderBy: { id: "asc" } } },
    });
    if (!pair)
      throw new ConflictException(
        `Parni dokument ${doc.transferPairDocId} ne postoji — prenos je nepotpun.`,
      );

    const out = doc.documentTypeCode === TransferService.OUT_TYPE ? doc : pair;
    const inb = out === doc ? pair : doc;

    // Storniran = postoji dokument koji stornira bilo koju stranu ovog para.
    const reversal = await this.prisma.stockDocument.findFirst({
      where: { reversalOfDocId: { in: [out.id, inb.id] } },
      select: { id: true, documentNumber: true, documentDate: true },
    });

    return {
      data: {
        outbound: out,
        inbound: inb,
        sourceWarehouseId: out.warehouseId,
        targetWarehouseId: inb.warehouseId,
        reversed: reversal != null,
        reversalDocId: reversal?.id ?? null,
      },
    };
  }

  // ---------------------------------------------------------------- CREATE

  /**
   * Napravi prenos: PAR dokumenata (razduženje izvora + zaduženje odredišta) u JEDNOJ
   * transakciji. Odbija se (422) prenos koji bi napravio negativno stanje u izvornom
   * magacinu — od stanja se oduzimaju i tuđe otvorene rezervacije, jer obećana roba ne
   * sme da otputuje u drugi magacin.
   */
  async createTransfer(dto: CreateTransferDto, userId: number | null) {
    const items = this.validateHeader(dto);

    const documentDate =
      parseDateParam(dto.documentDate, "documentDate") ?? new Date();
    const postingDate =
      parseDateParam(dto.postingDate, "postingDate") ?? documentDate;
    const year = businessYear(documentDate);
    const companyId = 0; // jednofirmno (kao ostatak robnog) — segment numeracije

    await this.assertWarehouses(dto.sourceWarehouseId, dto.targetWarehouseId);
    await this.assertItemsExist(items.map((i) => i.itemId));
    const types = await this.loadTransferTypes();

    const created = await this.prisma.$transaction(async (tx) => {
      // Serijalizacija sa rezervacijama i izlaznim dokumentima — ISTI advisory lock
      // po (artikal, magacin) kao `createStockDocument`/`reserveLines`. Zaključavaju se
      // OBA magacina: odredište zato što se i ono menja, pa paralelni izlaz iz njega
      // ne sme da vidi zastarelo stanje.
      await lockStockKeys(tx, [
        ...items.map((it) => ({
          itemId: it.itemId,
          warehouseId: dto.sourceWarehouseId,
        })),
        ...items.map((it) => ({
          itemId: it.itemId,
          warehouseId: dto.targetWarehouseId,
        })),
      ]);

      const requests = aggregate(items, dto.sourceWarehouseId);
      const reserved = await sumOpenReservations(tx, [
        ...requests.map((r) => ({
          itemId: r.itemId,
          warehouseId: r.warehouseId,
        })),
      ]);
      await this.robno.assertStockAvailable(
        tx,
        requests,
        documentDate,
        reserved,
        "PRENOS",
      );

      const lines = await this.valuedLines(
        tx,
        items,
        dto.sourceWarehouseId,
        documentDate,
      );

      return this.writePair(tx, {
        companyId,
        year,
        documentDate,
        postingDate,
        sourceWarehouseId: dto.sourceWarehouseId,
        targetWarehouseId: dto.targetWarehouseId,
        note: dto.note ?? null,
        projectId: dto.projectId ?? null,
        workOrderId: dto.workOrderId ?? null,
        createdByUserId: userId,
        lines,
        types,
        reversalOf: null,
      });
    }, TransferService.TX);

    this.logger.log(
      `Prenos ${created.outbound.documentNumber} → ${created.inbound.documentNumber}: ` +
        `magacin ${dto.sourceWarehouseId} → ${dto.targetWarehouseId}, ${items.length} stavki.`,
    );
    return { data: created };
  }

  // ---------------------------------------------------------------- STORNO

  /**
   * Storniraj prenos (bilo koja strana para). Pravi OGLEDALNI par: izlaz iz magacina u
   * koji je roba stigla + ulaz u magacin iz kog je otišla, sa istim količinama i istim
   * vrednostima kao original (da se storno ne razlikuje od originala ni po jednom dinaru).
   *
   * Guard-ovi:
   *   • dokument mora biti prenos sa parnjakom (409 za zatečeni jednostrani),
   *   • već storniran prenos = 409 (i baza to čuva parcijalnim UNIQUE indeksom, pa ni
   *     dve paralelne sesije ne mogu da naprave dva storna),
   *   • roba mora i dalje biti u odredišnom magacinu (422 ako je u međuvremenu
   *     potrošena) — inače bi storno napravio negativno stanje.
   */
  async reverse(id: number, dto: ReverseTransferDto, userId: number | null) {
    const documentDate =
      parseDateParam(dto?.documentDate, "documentDate") ?? new Date();
    const year = businessYear(documentDate);
    const types = await this.loadTransferTypes();

    const created = await this.prisma.$transaction(async (tx) => {
      const { out, inb } = await this.loadPair(tx, id);

      const existing = await tx.stockDocument.findFirst({
        where: { reversalOfDocId: { in: [out.id, inb.id] } },
        select: { id: true, documentNumber: true },
      });
      if (existing)
        throw new ConflictException(
          `Prenos je već storniran dokumentom ${existing.documentNumber} (id ${existing.id}).`,
        );

      const source = out.warehouseId; // odakle je roba otišla
      const target = inb.warehouseId; // gde je roba sada

      // Storno vraća robu iz ODREDIŠTA — zato se zaključava i proverava odredište.
      await lockStockKeys(tx, [
        ...inb.items.map((it) => ({ itemId: it.itemId, warehouseId: target })),
        ...inb.items.map((it) => ({ itemId: it.itemId, warehouseId: source })),
      ]);

      const requests = aggregate(
        inb.items.map((it) => ({ itemId: it.itemId, quantity: it.quantity })),
        target,
      );
      const reserved = await sumOpenReservations(
        tx,
        requests.map((r) => ({
          itemId: r.itemId,
          warehouseId: r.warehouseId,
        })),
      );
      await this.robno.assertStockAvailable(
        tx,
        requests,
        documentDate,
        reserved,
        "STORNO PRENOSA",
      );

      // Vrednosti se PREPISUJU iz originala (ne preračunavaju) — storno mora da poništi
      // tačno ono što je original napravio, i količinski i vrednosno.
      const lines = inb.items.map((it, idx) => ({
        itemId: it.itemId,
        lineNo: it.lineNo || idx + 1,
        quantity: it.quantity,
        purchasePriceNet: it.purchasePriceNet,
        wholesalePrice: it.calculatedWholesalePrice,
        // I MP vrednost se PREPISUJE iz originala: storno mora da poništi tačno onaj
        // red u KEPU knjizi koji je original napravio, do na paru.
        retailPrice: it.calculatedRetailPrice,
      }));

      const reason = (dto?.reason ?? "").trim();
      // Dve paralelne sesije obe prođu proveru `existing` (radi se pre lock-a), pa
      // gubitnik trke pada na parcijalnom UNIQUE `uq_stock_documents_reversal_of`.
      // Baza tu radi svoj posao (podaci ostaju ispravni), ali sirov P2002 bi izašao
      // kao 500 „Internal server error" — korisnik mora dobiti istu srpsku poruku
      // kao u jednonitnom slučaju.
      try {
        return await this.writePair(tx, {
          companyId: out.companyId,
          year,
          documentDate,
          postingDate: documentDate,
          // Ogledalo: roba se vraća iz odredišta u izvor.
          sourceWarehouseId: target,
          targetWarehouseId: source,
          note:
            `STORNO prenosa ${out.documentNumber} / ${inb.documentNumber}` +
            (reason ? ` — ${reason}` : ""),
          projectId: out.projectId,
          workOrderId: out.workOrderId,
          createdByUserId: userId,
          lines,
          types,
          // Storno-izlaz (iz odredišta) poništava ULAZNI dokument originala i obrnuto.
          reversalOf: { outboundReverses: inb.id, inboundReverses: out.id },
        });
      } catch (e) {
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === "P2002"
        )
          throw new ConflictException(
            `Prenos ${out.documentNumber} / ${inb.documentNumber} je upravo storniran ` +
              `iz druge sesije — drugi storno nije napravljen.`,
          );
        throw e;
      }
    }, TransferService.TX);

    this.logger.log(
      `Storniran prenos (dokument ${id}) → ${created.outbound.documentNumber} / ${created.inbound.documentNumber}.`,
    );
    return { data: created };
  }

  // ------------------------------------------------------------- INTERNALS

  /** Upis para dokumenata + obostrana veza + KEPU. Isti kod za prenos i za njegov storno. */
  private async writePair(
    tx: Prisma.TransactionClient,
    p: {
      companyId: number;
      year: number;
      documentDate: Date;
      postingDate: Date;
      sourceWarehouseId: number;
      targetWarehouseId: number;
      note: string | null;
      projectId: number | null;
      workOrderId: number | null;
      createdByUserId: number | null;
      lines: ValuedLine[];
      types: TransferTypes;
      reversalOf: {
        outboundReverses: number;
        inboundReverses: number;
      } | null;
    },
  ) {
    const outNumber = await this.numbering.next(
      tx,
      p.companyId,
      TransferService.OUT_TYPE,
      p.year,
    );
    const inNumber = await this.numbering.next(
      tx,
      p.companyId,
      TransferService.IN_TYPE,
      p.year,
    );

    // `targetWarehouseId` nosi SAMO izlazna strana (prenosnica koja ide uz robu: „iz X u Y").
    // Na ulaznoj strani ostaje NULL — inače bi papir tvrdio „iz Y u Y". Odakle je roba
    // stigla vidi se preko `transferPairDocId`, koji je jedini izvor istine o paru.
    //
    // STATUS „POSTED", ne „DRAFT": prenos je završen fizički događaj, nema šta da se
    // kalkuliše ni knjiži (nema šeme kontiranja — v. blok na vrhu). DRAFT bi ga ostavio
    // otvorenim za brisanje stavki (`assertItemMutable` pušta nacrt), pa bi se jedna
    // strana para mogla isprazniti i zaliha bi opet nestala. Ispravka ide kroz storno.
    const header = (warehouseId: number, targetWarehouseId: number | null) => ({
      companyId: p.companyId,
      kind: "PRENOS",
      year: p.year,
      warehouseId,
      targetWarehouseId,
      documentDate: p.documentDate,
      postingDate: p.postingDate,
      note: p.note,
      projectId: p.projectId,
      workOrderId: p.workOrderId,
      status: "POSTED",
      isCalculated: false,
      createdByUserId: p.createdByUserId,
    });

    const itemsOf = (warehouseId: number) => ({
      create: p.lines.map((l) => ({
        itemId: l.itemId,
        warehouseId,
        lineNo: l.lineNo,
        quantity: l.quantity,
        // Vrednovanje: nabavna neto nosi punu cenu koštanja (ZT je već u njoj, prenos
        // ne dodaje zavisne troškove), KalkVP/StvarnaVP prate izvorni magacin, a
        // KalkMP/StvarnaMP nose maloprodajnu vrednost koju čita KEPU knjiga.
        purchasePriceNet: l.purchasePriceNet,
        calculatedWholesalePrice: l.wholesalePrice,
        actualWholesalePrice: l.wholesalePrice,
        calculatedRetailPrice: l.retailPrice,
        actualRetailPrice: l.retailPrice,
      })),
    });

    const outbound = await tx.stockDocument.create({
      data: {
        ...header(p.sourceWarehouseId, p.targetWarehouseId),
        documentTypeCode: TransferService.OUT_TYPE,
        documentNumber: outNumber.documentNumber,
        reversalOfDocId: p.reversalOf?.outboundReverses ?? null,
        items: itemsOf(p.sourceWarehouseId),
      },
      include: { items: { orderBy: { id: "asc" } } },
    });

    const inbound = await tx.stockDocument.create({
      data: {
        ...header(p.targetWarehouseId, null),
        documentTypeCode: TransferService.IN_TYPE,
        documentNumber: inNumber.documentNumber,
        transferPairDocId: outbound.id,
        reversalOfDocId: p.reversalOf?.inboundReverses ?? null,
        items: itemsOf(p.targetWarehouseId),
      },
      include: { items: { orderBy: { id: "asc" } } },
    });

    const linkedOut = await tx.stockDocument.update({
      where: { id: outbound.id },
      data: { transferPairDocId: inbound.id },
      include: { items: { orderBy: { id: "asc" } } },
    });

    // KEPU u ISTOJ transakciji: prenos nema šemu kontiranja pa nikad ne prođe kroz
    // `robno post` (koji inače piše knjigu). Bez ovoga bi knjiga ćutala o prenosu.
    await this.writeKepu(tx, linkedOut, p.types.out.isInbound);
    await this.writeKepu(tx, inbound, p.types.in.isInbound);

    return { outbound: linkedOut, inbound };
  }

  private async writeKepu(
    tx: Prisma.TransactionClient,
    doc: Prisma.StockDocumentGetPayload<{ include: { items: true } }>,
    isInbound: boolean,
  ): Promise<void> {
    const entries = computeKepuEntries(doc, doc.items, [], {
      kepuDefaultCharge: null,
      kepuDefaultDischarge: null,
      isInbound,
    });
    await writeKepuEntries(tx, doc.id, entries);
  }

  /** Učitaj obe strane para (iz bilo koje strane) uz stavke; jasne greške za nepotpun par. */
  private async loadPair(tx: Prisma.TransactionClient, id: number) {
    const doc = await tx.stockDocument.findUnique({
      where: { id },
      include: { items: { where: NOT_DELETED, orderBy: { id: "asc" } } },
    });
    if (!doc) throw new NotFoundException(`Robni dokument ${id} ne postoji.`);
    if (doc.kind !== "PRENOS")
      throw new UnprocessableEntityException(
        `Dokument ${id} nije prenos između magacina (kind=${doc.kind}).`,
      );
    if (doc.status === "LOCKED")
      throw new ConflictException(
        `Dokument ${id} je zaključan — storno više nije moguć.`,
      );
    // STORNO SE NE STORNIRA. Storno-par je i sam prenos sa parnjakom, pa je bez ove
    // provere lanac bio neograničen: „storno storna" ponovo seli robu A→B, a nosi
    // napomenu „STORNO prenosa …" — registar prenosa se posle toga ne može pročitati.
    // Ispravka pogrešnog storna ide NOVIM prenosom, ne stornom storna.
    if (doc.reversalOfDocId != null)
      throw new ConflictException(
        `Dokument ${id} je STORNO prenosa i ne stornira se. Ako robu treba vratiti, ` +
          `napravi nov prenos u suprotnom smeru.`,
      );
    if (doc.transferPairDocId == null)
      throw new ConflictException(
        `Dokument ${id} nema parni dokument (jednostran prenos) — nema se šta stornirati ` +
          `robno, jer zaduženja odredišnog magacina nikad nije ni bilo.`,
      );
    const pair = await tx.stockDocument.findUnique({
      where: { id: doc.transferPairDocId },
      include: { items: { where: NOT_DELETED, orderBy: { id: "asc" } } },
    });
    if (!pair)
      throw new ConflictException(
        `Parni dokument ${doc.transferPairDocId} ne postoji — prenos je nepotpun.`,
      );
    // Zaključanost se proverava na OBE strane para: guard iznad gleda samo dokument
    // čiji je id prosleđen, pa se zaključana strana ranije zaobilazila prostim
    // pozivom preko id-a parnjaka — a poruka o zaključavanju je time bila neistinita.
    if (pair.status === "LOCKED")
      throw new ConflictException(
        `Parni dokument ${pair.id} je zaključan — storno prenosa više nije moguć.`,
      );
    const out = doc.documentTypeCode === TransferService.OUT_TYPE ? doc : pair;
    const inb = out === doc ? pair : doc;
    if (out.documentTypeCode !== TransferService.OUT_TYPE)
      throw new ConflictException(
        `Par dokumenata ${doc.id}/${pair.id} nema izlaznu stranu (${TransferService.OUT_TYPE}).`,
      );
    return { out, inb };
  }

  /**
   * Vrednovanje stavki: zadate cene se poštuju, izostavljene se popunjavaju ponderisanim
   * prosekom IZVORNOG magacina na dan prenosa — istom formulom koju koristi lager
   * (`Σ(±Kol × cena) / Σ(±Kol)`), pa se prikazana i preneta vrednost ne mogu raziću.
   */
  private async valuedLines(
    tx: Prisma.TransactionClient,
    items: NormalizedItem[],
    sourceWarehouseId: number,
    asOf: Date,
  ): Promise<ValuedLine[]> {
    // MP cena se UVEK dovlači (i kad su nabavna/VP zadate): KEPU knjiga se vodi po
    // maloprodajnoj vrednosti, a nju korisnik na prenosu ne unosi. Bez nje bi knjiga
    // dobila VP fallback (prodavnica zadužena bez marže i PDV-a) ili — ako ni VP
    // nema — prenos u knjizi ne bi postojao uopšte. Nalaz revizije 27.07.2026.
    const avgById = await this.averageCosts(
      tx,
      [...new Set(items.map((i) => i.itemId))],
      sourceWarehouseId,
      asOf,
    );

    const lines = items.map((it, idx) => {
      const avg = avgById.get(it.itemId);
      return {
        itemId: it.itemId,
        lineNo: it.lineNo ?? idx + 1,
        quantity: it.quantity,
        purchasePriceNet: it.purchasePriceNet ?? avg?.nab ?? ZERO,
        wholesalePrice: it.wholesalePrice ?? avg?.vp ?? ZERO,
        retailPrice: avg?.mp ?? ZERO,
      };
    });

    // Prenos koji ne ume da se vrednuje ne sme da PROĐE NEMO: `computeKepuEntries`
    // na vrednosti 0 vraća prazan niz, pa bi red u zakonskoj knjizi tiho izostao.
    const unvalued = lines.filter(
      (l) => l.retailPrice.isZero() && l.wholesalePrice.isZero(),
    );
    if (unvalued.length)
      this.logger.warn(
        `Prenos: ${unvalued.length} stavki nema ni MP ni VP vrednost u izvornom magacinu ` +
          `${sourceWarehouseId} (artikli ${unvalued.map((l) => l.itemId).join(", ")}) — ` +
          `te stavke NEĆE dati red u KEPU knjizi. Formiraj cenu pre prenosa.`,
      );

    return lines;
  }

  /**
   * Ponderisana prosečna nabavna (A+B+C) i VP cena po artiklu u datom magacinu na dan.
   * Filtri su VERBATIM iz `CostingService.stateAsOf` / lagera (KODJ izuzet, `affects_stock`,
   * soft-delete) — jedan upit za sve artikle, bez N+1.
   */
  private async averageCosts(
    tx: Prisma.TransactionClient,
    itemIds: number[],
    warehouseId: number,
    asOf: Date,
  ): Promise<Map<number, AvgPrices>> {
    if (itemIds.length === 0) return new Map();
    const rows = await tx.$queryRaw<
      Array<{
        item_id: number;
        weight: Prisma.Decimal | null;
        weighted_nab: Prisma.Decimal | null;
        weighted_vp: Prisma.Decimal | null;
        weighted_mp: Prisma.Decimal | null;
      }>
    >(Prisma.sql`
      SELECT sdi.item_id,
             SUM(CASE WHEN dt.is_inbound THEN sdi.quantity ELSE -sdi.quantity END) AS weight,
             SUM(CASE WHEN dt.is_inbound THEN 1 ELSE -1 END * sdi.quantity *
                 (sdi.purchase_price_net + sdi.dependent_cost_own + sdi.dependent_cost_supplier)
             ) AS weighted_nab,
             SUM(CASE WHEN dt.is_inbound THEN 1 ELSE -1 END * sdi.quantity *
                 sdi.calculated_wholesale_price) AS weighted_vp,
             -- MP (maloprodajna) vrednost: KEPU knjiga se vodi po MP vrednosti robe
             -- (v. kepu-book.util.unitMpValue). Bez ovoga bi prenos u knjigu usao po
             -- VP fallback-u, a obrazac u nozi tvrdi da su svi redovi MP.
             SUM(CASE WHEN dt.is_inbound THEN 1 ELSE -1 END * sdi.quantity *
                 COALESCE(NULLIF(sdi.calculated_retail_price, 0),
                          sdi.actual_retail_price)) AS weighted_mp
      FROM stock_document_items sdi
      JOIN stock_documents sd ON sd.id = sdi.document_id
      JOIN document_types dt ON dt.code = sd.document_type_code
      WHERE sdi.item_id IN (${Prisma.join(itemIds)})
        AND sdi.warehouse_id = ${warehouseId}
        AND sd.document_date <= ${asOf}
        AND sd.document_type_code <> 'KODJ'
        AND COALESCE(dt.affects_stock, TRUE) = TRUE
        AND sdi.deleted_at IS NULL
      GROUP BY sdi.item_id
    `);

    const out = new Map<number, AvgPrices>();
    for (const r of rows) {
      const weight = new Prisma.Decimal(r.weight ?? 0);
      // Stanje 0 → prosek nije definisan; cena ostaje 0 (isto kao lager lista). Guard
      // dovoljnog stanja ionako ne pušta prenos iz praznog magacina.
      if (weight.isZero()) {
        out.set(r.item_id, { nab: ZERO, vp: ZERO, mp: ZERO });
        continue;
      }
      const avg = (v: Prisma.Decimal | null) =>
        new Prisma.Decimal(v ?? 0)
          .div(weight)
          .toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
      out.set(r.item_id, {
        nab: avg(r.weighted_nab),
        vp: avg(r.weighted_vp),
        mp: avg(r.weighted_mp),
      });
    }
    return out;
  }

  /** Zaglavlje + stavke: sve provere koje ne traže bazu. Vraća normalizovane stavke. */
  private validateHeader(dto: CreateTransferDto): NormalizedItem[] {
    const src = dto?.sourceWarehouseId;
    const dst = dto?.targetWarehouseId;
    if (!Number.isInteger(src) || src <= 0)
      throw new UnprocessableEntityException(
        "sourceWarehouseId je obavezan — pozitivan ceo broj.",
      );
    if (!Number.isInteger(dst) || dst <= 0)
      throw new UnprocessableEntityException(
        "targetWarehouseId je obavezan — pozitivan ceo broj.",
      );
    if (src === dst)
      throw new UnprocessableEntityException(
        "Izvorni i odredišni magacin ne smeju biti isti.",
      );
    if (!Array.isArray(dto?.items) || dto.items.length === 0)
      throw new UnprocessableEntityException(
        "Prenos mora imati bar jednu stavku.",
      );

    return dto.items.map((it: CreateTransferItemDto, idx: number) => {
      if (!Number.isInteger(it?.itemId) || it.itemId <= 0)
        throw new UnprocessableEntityException(
          `Stavka ${idx + 1}: itemId mora biti pozitivan ceo broj.`,
        );
      const quantity = toDec(it.quantity);
      // Negativna količina bi u paru značila „prenesi unazad" i tiho preokrenula smer —
      // odbija se, a ne tumači (obrnut smer se traži obrnutim prenosom ili stornom).
      if (!quantity.greaterThan(0))
        throw new UnprocessableEntityException(
          `Stavka ${idx + 1} (artikal ${it.itemId}): količina mora biti veća od 0.`,
        );
      // CENE: negativna cena je otrov. Ukupna vrednost bi ostala „očuvana" (obe
      // strane dobiju isti iznos), ali vrednost PO MAGACINU postaje besmislena —
      // odredište dobije negativnu vrednost zaliha uz pozitivnu količinu, izvoru
      // skoči prosek, i taj otrovan prosek dalje hrani svaki naredni prenos,
      // kalkulaciju i karticu iz tog magacina (`averageCosts` čita baš njega).
      // Nalaz revizije 27.07.2026: dokazano na dev bazi cenom „-9999".
      const price = (
        v: string | number | Prisma.Decimal | null | undefined,
        label: string,
      ): Prisma.Decimal | null => {
        if (v == null) return null;
        const d = toDec(v);
        if (d.isNegative())
          throw new UnprocessableEntityException(
            `Stavka ${idx + 1} (artikal ${it.itemId}): ${label} ne sme biti negativna.`,
          );
        return d;
      };

      return {
        itemId: it.itemId,
        lineNo: it.lineNo,
        quantity,
        purchasePriceNet: price(it.purchasePriceNet, "nabavna cena"),
        wholesalePrice: price(it.wholesalePrice, "veleprodajna cena"),
      };
    });
  }

  private async assertWarehouses(source: number, target: number) {
    const found = await this.prisma.warehouse.findMany({
      where: { id: { in: [source, target] } },
      select: { id: true },
    });
    const ids = new Set(found.map((w) => w.id));
    const missing = [source, target].filter((id) => !ids.has(id));
    if (missing.length)
      throw new UnprocessableEntityException(
        `Magacin ne postoji: ${missing.join(", ")}.`,
      );
  }

  private async assertItemsExist(itemIds: number[]) {
    const unique = [...new Set(itemIds)];
    const found = await this.prisma.item.findMany({
      where: { id: { in: unique } },
      select: { id: true },
    });
    const ids = new Set(found.map((i) => i.id));
    const missing = unique.filter((id) => !ids.has(id));
    if (missing.length)
      throw new UnprocessableEntityException(
        `Artikli ne postoje: ${missing.join(", ")}.`,
      );
  }

  /**
   * Učitaj i PROVERI vrste dokumenata para. Ovo je centralna kontrola ispravnosti:
   * ako bi izlazna vrsta imala `is_inbound = true` (ili obrnuto), par bi opet bio
   * jednostran — samo bi ovog puta roba nastajala ni iz čega. Zato se smer proverava,
   * a ne pretpostavlja.
   */
  private async loadTransferTypes(): Promise<TransferTypes> {
    const rows = await this.prisma.documentType.findMany({
      where: {
        code: { in: [TransferService.OUT_TYPE, TransferService.IN_TYPE] },
      },
      select: { code: true, isInbound: true, affectsStock: true },
    });
    const out = rows.find((r) => r.code === TransferService.OUT_TYPE);
    const inb = rows.find((r) => r.code === TransferService.IN_TYPE);
    if (!out || !inb)
      throw new UnprocessableEntityException(
        `Vrste dokumenata za prenos ne postoje u šifarniku ` +
          `(${TransferService.OUT_TYPE}/${TransferService.IN_TYPE}) — primeni migraciju ` +
          `20260727120000_prenos_izmedju_magacina.`,
      );
    if (out.isInbound !== false || inb.isInbound !== true)
      throw new UnprocessableEntityException(
        `Šifarnik vrsta dokumenata je neispravan: ${TransferService.OUT_TYPE} mora imati ` +
          `is_inbound=false, a ${TransferService.IN_TYPE} is_inbound=true. Sa pogrešnim ` +
          `smerom prenos ne bi bio dvostran.`,
      );
    if (out.affectsStock === false || inb.affectsStock === false)
      throw new UnprocessableEntityException(
        `Vrste ${TransferService.OUT_TYPE}/${TransferService.IN_TYPE} moraju uticati na ` +
          `zalihe (affects_stock=true), inače prenos ne pomera stanje.`,
      );
    return {
      out: { isInbound: false },
      in: { isInbound: true },
    };
  }
}

const ZERO = new Prisma.Decimal(0);

interface NormalizedItem {
  itemId: number;
  lineNo?: number;
  quantity: Prisma.Decimal;
  purchasePriceNet: Prisma.Decimal | null;
  wholesalePrice: Prisma.Decimal | null;
}

interface ValuedLine {
  itemId: number;
  lineNo: number;
  quantity: Prisma.Decimal;
  purchasePriceNet: Prisma.Decimal;
  wholesalePrice: Prisma.Decimal;
  /** Maloprodajna vrednost — po njoj se vodi KEPU knjiga (v. `valuedLines`). */
  retailPrice: Prisma.Decimal;
}

/** Ponderisani proseci izvornog magacina: nabavna, veleprodajna, maloprodajna. */
interface AvgPrices {
  nab: Prisma.Decimal;
  vp: Prisma.Decimal;
  mp: Prisma.Decimal;
}

interface TransferTypes {
  out: { isInbound: boolean };
  in: { isInbound: boolean };
}

/**
 * Agregiraj traženu količinu po (artikal, magacin) — više stavki istog artikla u jednom
 * prenosu mora da se SABERE pre provere stanja, inače dve stavke po 6 komada prođu nad
 * stanjem od 10 (svaka pojedinačno „staje").
 */
function aggregate(
  items: ReadonlyArray<{ itemId: number; quantity: Prisma.Decimal }>,
  warehouseId: number,
): Array<{ itemId: number; warehouseId: number; qty: Prisma.Decimal }> {
  const byItem = new Map<
    number,
    { itemId: number; warehouseId: number; qty: Prisma.Decimal }
  >();
  for (const it of items) {
    const cur = byItem.get(it.itemId);
    if (cur) cur.qty = cur.qty.add(it.quantity.abs());
    else
      byItem.set(it.itemId, {
        itemId: it.itemId,
        warehouseId,
        qty: it.quantity.abs(),
      });
  }
  return [...byItem.values()];
}
