import { businessYear } from "../../common/business-date";
import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { pageMeta, parsePagination } from "../../common/pagination";
import { parseDateParam } from "../../common/date-params";
import {
  KNOWN_VAT_CODES,
  unknownVatCodeMessage,
} from "../gl/posting/vat-rates";
import { StockDocumentNumberingService } from "./stock-document-numbering.service";
import { CostingService } from "./costing.service";
import { toDec, ZERO } from "./decimal.util";
import {
  V_STOCK_MOVEMENTS,
  stockKeyOf,
  type StockMovementRow,
} from "./stock-movements";
import {
  CreateStockDocumentDto,
  CreateStockDocumentItemDto,
  STOCK_DOCUMENT_KINDS,
  UpdateStockDocumentShippingDto,
  type StockDocumentKind,
} from "./dto/create-stock-document.dto";
import { ListStockDocumentsQuery } from "./dto/list-stock-documents.dto";
import { computeKepuEntries, writeKepuEntries } from "./kepu-book.util";
import { lockStockKeys, sumOpenReservations } from "./reservation.service";
import type { ReservationSourceRef, StockKey } from "./dto/reservation.dto";
import {
  NOT_DELETED,
  UNDO_WINDOW_MS,
  restore,
  softDelete,
} from "../../common/soft-delete.util";

// `StockDocumentKind` je definisan uz DTO (`dto/create-stock-document.dto.ts`), gde ga
// `@IsIn(STOCK_DOCUMENT_KINDS)` i koristi — jedan spisak vrsta za tip i za validaciju.
// Re-eksport stoji zbog postojećih `import { StockDocumentKind } from "./robno.service"`.
export type { StockDocumentKind } from "./dto/create-stock-document.dto";

/**
 * Prozor transakcije kreiranja robnog dokumenta: unutra se čekaju DVA advisory lock-a
 * (zaliha po artiklu + numeracija), pa Prisma default (maxWait 2 s / timeout 5 s) pod
 * kontencijom vraća P2028 umesto da sačeka red.
 */
export const STOCK_DOCUMENT_TX_OPTIONS = {
  maxWait: 10_000,
  timeout: 20_000,
} as const;

const VALID_KINDS: readonly StockDocumentKind[] = STOCK_DOCUMENT_KINDS;

/**
 * Vrste dokumenata REZERVISANE za `TransferService` (obe strane međuskladišnice).
 * Ručno napravljen dokument sa ovom vrstom bio bi po konstrukciji polovina
 * transakcije — v. guard u `createStockDocument`.
 */
export const TRANSFER_ONLY_TYPES = new Set<string>(["PREIZ", "PREUL"]);

/** Vrste dokumenta koje ZADUŽUJU magacin (`document_types.is_inbound = true`). */
const INBOUND_KINDS = new Set<StockDocumentKind>(["UL", "VISAK"]);

/**
 * Tekstualno polje → očišćena vrednost ili `null`. Prazan/beli string je ISTO što i „nije
 * uneto": ako bi se sačuvao kao `""`, štampa bi videla „podatak postoji" i prestala bi da
 * crta liniju za ručni upis — papir bi ostao bez mesta za dopunu.
 */
export function trimOrNull(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t === "" ? null : t;
}

/**
 * Glavni robni servis (`stock_documents` + `stock_document_items`, 2.0-native, sve Decimal).
 *
 * Obrazac iz `handovers`/`nabavka`: read (list/get) + kreiranje kroz `$transaction` sa advisory-lock
 * numeracijom (`NNNN/god`, `StockDocumentNumberingService`). Kalkulaciju (landed cost) vodi
 * `CalculationService` (poziva se posle kreiranja UL/UVOZ dokumenta — ovaj servis samo kreira DRAFT).
 *
 * Meki ref-ovi (itemId/warehouseId/supplierId/…): postojanje se validira u servisu (BACKEND_RULES §4/§6).
 * Poslovne greške = ugrađeni NestJS exception-i (§7). Iznosi ulaze kao string/number → `Prisma.Decimal`.
 *
 * NAPOMENA (doc 39 / PLAN_FAZA_3): costing čita SAMO `stock_documents` — `goods_documents` je prazna i
 * izbačena iz sync-a (NEMA UNION-a sa njom).
 */
@Injectable()
export class RobnoService {
  private readonly logger = new Logger(RobnoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: StockDocumentNumberingService,
    private readonly costing: CostingService,
  ) {}

  // ---------------------------------------------------------------- READ

  async listStockDocuments(query: ListStockDocumentsQuery) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );

    const where: Prisma.StockDocumentWhereInput = {};
    if (query.kind && VALID_KINDS.includes(query.kind as StockDocumentKind))
      where.kind = query.kind;
    if (query.documentTypeCode) where.documentTypeCode = query.documentTypeCode;
    if (query.status) where.status = query.status;

    const intEq = (v: string | undefined) => {
      const n = Number.parseInt(v ?? "", 10);
      return Number.isNaN(n) ? undefined : n;
    };
    const warehouseId = intEq(query.warehouseId);
    if (warehouseId !== undefined) where.warehouseId = warehouseId;
    const supplierId = intEq(query.supplierId);
    if (supplierId !== undefined) where.supplierId = supplierId;
    const year = intEq(query.year);
    if (year !== undefined) where.year = year;

    const from = parseDateParam(query.from, "from");
    const to = parseDateParam(query.to, "to");
    if (from || to) {
      const range: Prisma.DateTimeFilter = {};
      if (from) range.gte = from;
      if (to) range.lte = to;
      where.documentDate = range;
    }

    // Pretraga po broju dokumenta (§3.17): do 27.07.2026. su se `q`/`documentNumber`
    // tiho ignorisali — lista je vraćala SVE dokumente i konkretna primka se nije mogla
    // naći. Filter ide u `where` (dakle u SQL, pre paginacije), pa je i `meta.total`
    // filtriran i strane se ne mogu raziću sa prikazom.
    const term = (query.q ?? query.documentNumber ?? "").trim();
    if (term !== "")
      where.documentNumber = { contains: term, mode: "insensitive" };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.stockDocument.findMany({
        where,
        orderBy: [{ documentDate: "desc" }, { id: "desc" }],
        skip,
        take,
      }),
      this.prisma.stockDocument.count({ where }),
    ]);

    return { data: rows, meta: pageMeta(page, pageSize, total) };
  }

  /**
   * Detalj robnog dokumenta.
   *
   * Stavke nose i NAZIV/ŠIFRU/JM artikla (meki ref `items.id`, jedan upit po skupu id-jeva).
   * Bez toga je detalj prikazivao samo `#90001` i korisnik nije video ŠTA je na dokumentu
   * (isti nalaz kao na popisu, §3.10). Sirova polja ostaju netaknuta — ovo je dopuna.
   *
   * `transferPair` (kad postoji) je parni dokument prenosa: prenos je PAR dokumenata
   * (izlaz iz izvornog + ulaz u odredišni magacin), pa detalj jedne strane bez druge
   * ne govori celu istinu o tome gde je roba otišla.
   */
  async getStockDocument(id: number) {
    const doc = await this.prisma.stockDocument.findUnique({
      where: { id },
      include: {
        // Soft-delete (Batch B): meko-obrisane stavke se NE prikazuju na detalju.
        items: { where: NOT_DELETED, orderBy: { id: "asc" } },
        stockLevelingItems: { orderBy: { id: "asc" } },
      },
    });
    if (!doc) throw new NotFoundException(`Robni dokument ${id} ne postoji.`);

    const itemIds = [
      ...new Set([
        ...doc.items.map((i) => i.itemId),
        ...doc.stockLevelingItems.map((i) => i.itemId),
      ]),
    ];
    const meta = itemIds.length
      ? await this.prisma.item.findMany({
          where: { id: { in: itemIds } },
          select: { id: true, name: true, catalogNumber: true, unit: true },
        })
      : [];
    const byId = new Map(meta.map((m) => [m.id, m]));
    const decorate = <T extends { itemId: number }>(row: T) => ({
      ...row,
      itemName: byId.get(row.itemId)?.name ?? null,
      itemCode: byId.get(row.itemId)?.catalogNumber ?? null,
      unit: byId.get(row.itemId)?.unit ?? null,
    });

    const transferPair =
      doc.transferPairDocId != null
        ? await this.prisma.stockDocument.findUnique({
            where: { id: doc.transferPairDocId },
            select: {
              id: true,
              documentTypeCode: true,
              documentNumber: true,
              warehouseId: true,
              documentDate: true,
            },
          })
        : null;

    return {
      data: {
        ...doc,
        items: doc.items.map(decorate),
        stockLevelingItems: doc.stockLevelingItems.map(decorate),
        transferPair,
      },
    };
  }

  // -------------------------------------------------------------- CREATE

  /**
   * Kreiraj robni dokument (`kind` = UL/IZ/NIV/PRENOS/VISAK/MANJAK) u statusu DRAFT.
   * Numeracija `NNNN/god` (advisory lock po companyId+tip+godina) je u istoj transakciji.
   * NE pokreće kalkulaciju — pozivalac (ruta) posle poziva `CalculationService.calculate(docId)`
   * za UL/UVOZ. Iznosi se čuvaju sirovi (invoicePrice/rabat/kasa…); landed polja popunjava kalkulacija.
   *
   * `opts.reservationSource` (C3): izvor(i) rezervacije koje OVAJ dokument troši — izdatnica
   * napravljena iz predračuna koji drži tu robu ne sme sama sebe da blokira, pa se te
   * rezervacije izuzimaju iz obračuna raspoloživog u guardu. Može biti VIŠE izvora (izdatnica
   * iz konačnog računa troši i rezervacije predračuna iz koga je račun prepisan — R1).
   * Izostavljeno = dokument nije potrošač nijedne rezervacije.
   *
   * `opts.afterCreate`: kuka koja se izvršava U ISTOJ TRANSAKCIJI, posle upisa dokumenta
   * (zatvaranje rezervacija izdatnicom) — pad kuke poništava i dokument, pa nema izdatnice
   * sa zauvek otvorenim rezervacijama.
   */
  async createStockDocument(
    kind: StockDocumentKind,
    dto: CreateStockDocumentDto,
    opts?: {
      reservationSource?:
        | ReservationSourceRef
        | readonly ReservationSourceRef[];
      afterCreate?: (
        tx: Prisma.TransactionClient,
        created: { id: number; documentNumber: string },
      ) => Promise<void>;
    },
  ) {
    if (!VALID_KINDS.includes(kind))
      throw new UnprocessableEntityException(
        `Nepoznat tip robnog dokumenta '${kind}'.`,
      );
    if (!dto?.documentTypeCode?.trim())
      throw new UnprocessableEntityException("documentTypeCode je obavezan.");
    if (!Number.isInteger(dto?.warehouseId) || dto.warehouseId <= 0)
      throw new UnprocessableEntityException(
        "warehouseId je obavezan — pozitivan ceo broj.",
      );
    if (!Array.isArray(dto?.items) || dto.items.length === 0)
      throw new UnprocessableEntityException(
        "Dokument mora imati bar jednu stavku.",
      );
    // PRENOS se NE PRAVI ovuda (27.07.2026, grupa C). Ovaj put pravi JEDAN dokument sa
    // JEDNIM `warehouseId`, a stanje se svuda računa kao Σ(±količina) po
    // `stock_document_items.warehouse_id` — dakle razdužio bi izvorni magacin i NIGDE ne
    // zadužio odredišni (`target_warehouse_id` ne čita nijedan obračun stanja). Roba bi
    // tiho nestala iz lagera. Prenos ide isključivo kroz `TransferService`, koji u jednoj
    // transakciji pravi PAR dokumenata (PREIZ izlaz + PREUL ulaz) i povezuje ih.
    if (kind === "PRENOS")
      throw new UnprocessableEntityException(
        "Prenos između magacina se ne pravi ovim putem — napravio bi jednostran " +
          "dokument i roba bi nestala iz lagera. Koristi radnju „Prenos u drugi magacin”.",
      );

    // Meki ref-ovi (validacija postojanja pre upisa — BACKEND_RULES §4/§6).
    const documentType = await this.prisma.documentType.findFirst({
      where: { code: dto.documentTypeCode },
      select: { id: true, code: true, isInbound: true },
    });
    if (!documentType)
      throw new UnprocessableEntityException(
        `Tip dokumenta '${dto.documentTypeCode}' ne postoji (document_types.code).`,
      );

    // ZATVARANJE PRENOSA NA DRUGA VRATA (nalaz revizije 27.07.2026).
    // Guard iznad gleda samo `kind`, a `documentTypeCode` je slobodan tekst — pa se
    // isti bag pravio sa `kind=IZ, documentTypeCode=PREIZ` (razduži izvor, odredište
    // nikad ne zaduži) ili `kind=UL, documentTypeCode=PREUL` (roba nastane ni iz čega,
    // jer UL ne prolazi kroz guard dovoljnog stanja). Vrste para su REZERVISANE za
    // `TransferService`, koji jedini piše obe strane u jednoj transakciji.
    if (TRANSFER_ONLY_TYPES.has(documentType.code))
      throw new UnprocessableEntityException(
        `Vrsta dokumenta '${documentType.code}' pripada prenosu između magacina i ne sme ` +
          `se koristiti ručno — takav dokument bi bio jednostran (razdužen jedan magacin, ` +
          `drugi nezadužen). Koristi radnju „Prenos u drugi magacin”.`,
      );

    // SMER MORA DA ODGOVARA VRSTI: `is_inbound` je jedini izvor znaka u svim
    // obračunima stanja. Ulazni dokument sa izlaznom vrstom (ili obrnuto) tiho
    // pomera zalihu u pogrešnom smeru i ne prolazi kroz odgovarajući guard.
    const expectInbound = INBOUND_KINDS.has(kind);
    if (
      documentType.isInbound != null &&
      documentType.isInbound !== expectInbound
    )
      throw new UnprocessableEntityException(
        `Vrsta '${documentType.code}' je ${documentType.isInbound ? "ULAZNA" : "IZLAZNA"}, ` +
          `a dokument je ${expectInbound ? "ulazni" : "izlazni"} (${kind}). Zaliha bi se ` +
          `pomerila u pogrešnom smeru — izaberi vrstu koja odgovara dokumentu.`,
      );

    const warehouse = await this.prisma.warehouse.findUnique({
      where: { id: dto.warehouseId },
      select: { id: true },
    });
    if (!warehouse)
      throw new UnprocessableEntityException(
        `Magacin ${dto.warehouseId} ne postoji.`,
      );
    if (dto.targetWarehouseId) {
      const target = await this.prisma.warehouse.findUnique({
        where: { id: dto.targetWarehouseId },
        select: { id: true },
      });
      if (!target)
        throw new UnprocessableEntityException(
          `Odredišni magacin ${dto.targetWarehouseId} ne postoji.`,
        );
    }

    // Validacija artikala (svi u jednom upitu; nepostojeći → 422 sa spiskom).
    const itemIds = [...new Set(dto.items.map((i) => i.itemId))];
    if (itemIds.some((id) => !Number.isInteger(id) || id <= 0))
      throw new UnprocessableEntityException(
        "Svaka stavka mora imati validan itemId (pozitivan ceo broj).",
      );
    const existingItems = await this.prisma.item.findMany({
      where: { id: { in: itemIds } },
      select: { id: true },
    });
    const existingItemIds = new Set(existingItems.map((i) => i.id));
    const missingItems = itemIds.filter((id) => !existingItemIds.has(id));
    if (missingItems.length)
      throw new UnprocessableEntityException(
        `Artikli ne postoje: ${missingItems.join(", ")}.`,
      );

    for (const it of dto.items) {
      if (toDec(it.quantity).isZero())
        throw new UnprocessableEntityException(
          `Stavka (itemId ${it.itemId}) mora imati količinu različitu od 0.`,
        );
    }

    const documentDate =
      parseDateParam(dto.documentDate, "documentDate") ?? new Date();
    const postingDate =
      parseDateParam(dto.postingDate, "postingDate") ?? documentDate;
    const companyId = 0; // jednofirmno (kao ostatak 2.0); segment numeracije
    const year = businessYear(documentDate);

    const created = await this.prisma.$transaction(async (tx) => {
      // Serijalizacija sa rezervisanjem (review C): izlazni dokument uzima ISTI advisory lock
      // po (artikal, magacin) kao `ReservationService.reserveLines`. Bez toga bi paralelno
      // „rezerviši 10" i „izdaj 10" oba videli isto slobodno stanje i oba prošla (raspoloživo −10).
      if (kind === "IZ" || kind === "MANJAK")
        await lockStockKeys(
          tx,
          dto.items.map((it) => ({
            itemId: it.itemId,
            warehouseId: it.warehouseId ?? dto.warehouseId,
          })),
        );

      // Guard raspoloživog stanja za IZLAZ (IZ/MANJAK) — nedovoljno stanje → 422 (doc 39 §C).
      // Costing (stateAsOf) namerno dozvoljava negativno interno; provera je ovde, na granici upisa.
      // C3: od stanja se oduzimaju i OTVORENE rezervacije (osim onih koje ovaj dokument troši).
      const reservedByKey = await this.loadOpenReserved(
        tx,
        kind,
        dto,
        opts?.reservationSource,
      );
      await this.assertSufficientStock(
        tx,
        kind,
        dto,
        documentDate,
        reservedByKey,
      );

      const { documentNumber } = await this.numbering.next(
        tx,
        companyId,
        dto.documentTypeCode,
        year,
      );

      const doc = await tx.stockDocument.create({
        data: {
          companyId,
          kind,
          documentTypeCode: dto.documentTypeCode,
          documentNumber,
          year,
          warehouseId: dto.warehouseId,
          targetWarehouseId: dto.targetWarehouseId ?? null,
          supplierId: dto.supplierId ?? null,
          customerId: dto.customerId ?? null,
          documentDate,
          postingDate,
          isImport: dto.isImport === true,
          customsExchangeRate: toDec(dto.customsExchangeRate ?? 1),
          accountingExchangeRate: toDec(dto.accountingExchangeRate ?? 1),
          fxInvoiceValue: toDec(dto.fxInvoiceValue),
          customs: toDec(dto.customs),
          forwarding: toDec(dto.forwarding),
          otherDependentCosts: toDec(dto.otherDependentCosts),
          customsRefundBase: toDec(dto.customsRefundBase),
          // Uslovi otpreme — čuva se ISKLJUČIVO ono što je uneto. `shippingDate` NIKAD
          // ne pada na `documentDate`: time bi se laž ugradila u bazu, a ne samo u papir.
          fco: trimOrNull(dto.fco),
          shippingMethod: trimOrNull(dto.shippingMethod),
          shippingDate:
            parseDateParam(dto.shippingDate, "shippingDate") ?? null,
          deliveryPlace: trimOrNull(dto.deliveryPlace),
          route: trimOrNull(dto.route),
          customerOrderRef: trimOrNull(dto.customerOrderRef),
          note: trimOrNull(dto.note),
          purchaseOrderId: dto.purchaseOrderId ?? null,
          projectId: dto.projectId ?? null,
          workOrderId: dto.workOrderId ?? null,
          linkedInboundDocId: dto.linkedInboundDocId ?? null,
          inventoryCountId: dto.inventoryCountId ?? null,
          status: "DRAFT",
          isCalculated: false,
          createdByUserId: dto.createdByUserId ?? null,
          items: {
            create: dto.items.map((it, idx) =>
              this.buildItemData(it, dto.warehouseId, idx),
            ),
          },
        },
        include: { items: { orderBy: { id: "asc" } } },
      });

      // Zatvaranje rezervacija (i sve što mora da deli sudbinu dokumenta) — ista transakcija.
      if (opts?.afterCreate) await opts.afterCreate(tx, doc);
      return doc;
    }, STOCK_DOCUMENT_TX_OPTIONS);

    this.logger.log(
      `Kreiran robni dokument ${created.documentNumber} (kind=${kind}, id=${created.id}, ${created.items.length} stavki).`,
    );
    return { data: created };
  }

  /**
   * Otvorene rezervacije za (artikal, magacin) parove iz izlaznog dokumenta (C3) — jedan
   * agregatni upit; prazna mapa za sve osim IZ.
   *
   * ZAŠTO NE I MANJAK (review R3): MANJAK utvrđen popisom NIJE obećanje kupcu — roba fizički
   * NEDOSTAJE i mora da se otpiše bez obzira na to što je preostalo stanje rezervisano. Sa
   * rezervacijom u guardu popis se nije mogao zaključiti (stanje 10, rezervisano 10, brojanje
   * nađe 8 → MANJAK 2 vs raspoloživo 0 → 422). Provera od GOLOG stanja (`stateAsOf`) ostaje
   * i za MANJAK — otpisati se ne može više nego što knjigovodstveno postoji.
   *
   * `reservationSource` = izvor(i) koje OVAJ dokument troši (predračun čija se izdatnica pravi,
   * i račun prepisan iz tog predračuna) — te rezervacije se izuzimaju, jer bi inače dokument
   * blokirao sam sebe.
   */
  private async loadOpenReserved(
    tx: Prisma.TransactionClient,
    kind: StockDocumentKind,
    dto: CreateStockDocumentDto,
    reservationSource?: ReservationSourceRef | readonly ReservationSourceRef[],
  ): Promise<Map<string, Prisma.Decimal>> {
    if (kind !== "IZ") return new Map();
    const keys: StockKey[] = dto.items.map((it) => ({
      itemId: it.itemId,
      warehouseId: it.warehouseId ?? dto.warehouseId,
    }));
    const refs: readonly ReservationSourceRef[] = !reservationSource
      ? []
      : Array.isArray(reservationSource)
        ? (reservationSource as readonly ReservationSourceRef[])
        : [reservationSource as ReservationSourceRef];
    return sumOpenReservations(
      tx,
      keys,
      refs.map((s) => ({ sourceType: s.sourceType, sourceId: s.sourceId })),
    );
  }

  /**
   * Guard negativnog stanja pri IZLAZU (kind IZ/MANJAK) — C11 (doc 39 §C / #21).
   *
   * Za svaku (artikal, magacin) kombinaciju agregira traženu količinu iz stavki i poredi je sa
   * RASPOLOŽIVIM = `CostingService.stateAsOf(itemId, warehouseId, documentDate)` (as-of do datuma
   * dokumenta, KODJ izuzet) **umanjeno za otvorene rezervacije** (`reservedByKey`, C3). Ako je
   * traženo > raspoloživo → `UnprocessableEntityException` sa listom (artikal, traženo,
   * raspoloživo). Čita kroz istu `tx` (dosledno sa upisom).
   *
   * `reservedByKey` puni `loadOpenReserved` i ono već IZUZIMA rezervacije koje ovaj dokument
   * troši — izdatnica koja razdužuje sopstveni predračun ne sme sama sebe da blokira. Prazna
   * mapa (podrazumevano, i UVEK za MANJAK — v. `loadOpenReserved`) = golo `stateAsOf`.
   *
   * NE dira `CostingService` (namerno dozvoljava negativno interno) — guard je isključivo na
   * granici kreiranja izlaznog dokumenta. UL/UVOZ/NIV/PRENOS/VISAK ne prolaze kroz guard.
   */
  private async assertSufficientStock(
    tx: Prisma.TransactionClient,
    kind: StockDocumentKind,
    dto: CreateStockDocumentDto,
    documentDate: Date,
    reservedByKey: ReadonlyMap<string, Prisma.Decimal> = new Map(),
  ): Promise<void> {
    if (kind !== "IZ" && kind !== "MANJAK") return;

    // Agregiraj traženu (pozitivnu) količinu po (artikal, magacin) — više stavki istog artikla se sabira.
    const requested = new Map<
      string,
      { itemId: number; warehouseId: number; qty: Prisma.Decimal }
    >();
    for (const it of dto.items) {
      const warehouseId = it.warehouseId ?? dto.warehouseId;
      // `stockKeyOf`, ne ručni template — ključ mape mora imati JEDNU definiciju,
      // inače se mape tiho prestanu poklapati čim se format promeni.
      const key = stockKeyOf(it.itemId, warehouseId);
      const qty = toDec(it.quantity).abs();
      const cur = requested.get(key);
      if (cur) cur.qty = cur.qty.add(qty);
      else requested.set(key, { itemId: it.itemId, warehouseId, qty });
    }

    await this.assertStockAvailable(
      tx,
      [...requested.values()],
      documentDate,
      reservedByKey,
      kind,
    );
  }

  /**
   * Jezgro guarda negativnog stanja, nad VEĆ AGREGIRANOM listom zahteva
   * `{ itemId, warehouseId, qty }` (qty pozitivna). Izdvojeno iz `assertSufficientStock`
   * da bi ISTU proveru mogao da koristi i PRENOS (izlazna strana međuskladišnice) —
   * `TransferService` inače ne prolazi kroz `createStockDocument`, pa bi bez ovoga
   * postojale dve različite provere „ima li robe" i jedna bi pre ili kasnije popustila.
   *
   * `label` ulazi u poruku (`IZ`, `MANJAK`, `PRENOS`, `STORNO PRENOSA`) da korisnik zna
   * koja ga radnja odbija.
   *
   * `opts.excludeDocId` izbacuje JEDAN dokument iz obračuna stanja. Treba ga IZMENI postojećeg
   * dokumenta (`DocumentEditService`): `stateAsOf` ne gleda status, pa su stavke tog dokumenta
   * VEĆ uračunate u stanje — bez izbacivanja bi se sopstvena potražnja oduzela dvaput i
   * ispravka izdatnice bi padala na sopstvenoj robi. Kreiranje ga ne prosleđuje (dokument
   * još ne postoji), pa se zatečeno ponašanje ne menja.
   */
  async assertStockAvailable(
    tx: Prisma.TransactionClient,
    requests: ReadonlyArray<{
      itemId: number;
      warehouseId: number;
      qty: Prisma.Decimal;
    }>,
    documentDate: Date,
    reservedByKey: ReadonlyMap<string, Prisma.Decimal> = new Map(),
    label = "IZ",
    opts: { excludeDocId?: number } = {},
  ): Promise<void> {
    const shortages: Array<{
      itemId: number;
      warehouseId: number;
      requested: Prisma.Decimal;
      available: Prisma.Decimal;
      reserved: Prisma.Decimal;
    }> = [];
    // Datum unazad ne sme da otvori rupu: `stateAsOf(documentDate)` vidi stanje
    // koje je TADA postojalo, pa bi izlaz datiran u prošlost prošao i napravio
    // negativno stanje DANAS (kod prenosa i gore — fantomska, prodajiva zaliha u
    // drugom magacinu). Zato se gleda i SADA i uzima MANJE raspoloživo.
    // (nalaz revizije 27.07.2026; `documentDate` dolazi iz zahteva bez granice)
    const now = new Date();
    const checkNowToo = documentDate.getTime() < now.getTime();

    // Stanje za SVE tražene parove u dva upita (as-of + „sada"), ne dva PO STAVCI.
    // Ranije je ovo bila petlja sa `stateAsOf` po stavci — do 2 uzastopna upita za svaku
    // stavku, i to UNUTAR transakcije koja već drži advisory lock na svim tim ključevima:
    // izdatnica sa 60 stavki = do 120 serijskih upita dok 60 (artikal, magacin) ključeva
    // stoji zaključano, pa svaki drugi izlaz tih artikala čeka. Rezervacije su isti posao
    // odavno radile jednim agregatom; sada i stanje.
    // Redom, ne `Promise.all`: oba upita idu kroz isti `tx` klijent (jedna konekcija).
    const stateOpts = { tx, excludeDocId: opts.excludeDocId };
    const keys = requests.map((r) => ({
      itemId: r.itemId,
      warehouseId: r.warehouseId,
    }));
    const asOfByKey = await this.costing.stateAsOfMany(
      keys,
      documentDate,
      stateOpts,
    );
    const nowByKey = checkNowToo
      ? await this.costing.stateAsOfMany(keys, now, stateOpts)
      : null;

    for (const r of requests) {
      const key = stockKeyOf(r.itemId, r.warehouseId);
      const onHandAsOf = asOfByKey.get(key) ?? ZERO;
      const onHand = nowByKey
        ? minDec(onHandAsOf, nowByKey.get(key) ?? ZERO)
        : onHandAsOf;
      // Raspoloživo = stanje − tuđe otvorene rezervacije (C3); rezervacije ovog dokumenta
      // su već izuzete u `loadOpenReserved`, pa potrošač ne blokira sam sebe.
      const reserved = reservedByKey.get(key) ?? ZERO;
      const available = onHand.sub(reserved);
      if (available.lessThan(r.qty)) {
        shortages.push({
          itemId: r.itemId,
          warehouseId: r.warehouseId,
          requested: r.qty,
          available,
          reserved,
        });
      }
    }
    if (shortages.length === 0) return;

    // Nazivi artikala za čitljivu poruku (meki ref items.id).
    const items = await tx.item.findMany({
      where: { id: { in: shortages.map((s) => s.itemId) } },
      select: { id: true, name: true, catalogNumber: true },
    });
    const itemById = new Map(items.map((i) => [i.id, i]));

    const detail = shortages.map((s) => {
      const it = itemById.get(s.itemId);
      const label = it
        ? `${it.name}${it.catalogNumber ? ` (${it.catalogNumber})` : ""}`
        : `artikal ${s.itemId}`;
      return {
        itemId: s.itemId,
        itemName: it?.name ?? null,
        itemCode: it?.catalogNumber ?? null,
        warehouseId: s.warehouseId,
        requested: s.requested.toFixed(3),
        available: s.available.toFixed(3),
        /** Od toga zauzeto tuđim otvorenim rezervacijama (C3) — 0 kad rezervacija nema. */
        reserved: s.reserved.toFixed(3),
        label,
      };
    });
    const human = detail
      .map(
        (d) =>
          `${d.label} — traženo ${d.requested}, raspoloživo ${d.available}` +
          (Number(d.reserved) > 0 ? ` (rezervisano ${d.reserved})` : ""),
      )
      .join("; ");

    throw new UnprocessableEntityException({
      code: "STOCK_INSUFFICIENT",
      message: `Nedovoljno stanje za izlaz (${label}): ${human}.`,
      shortages: detail,
    });
  }

  // ------------------------------------------------------- ZAKLJUČAVANJE (lock)

  /**
   * Zaključaj proknjižen robni dokument → status LOCKED (Faza-0 lock; StockDocument nema `isLocked`
   * kolonu, lock je terminalna vrednost `status` — schema:3088 `DRAFT | CALCULATED | POSTED | LOCKED`).
   *
   * Preduslov = dokument je OBRAĐEN kroz `post`: regularni robni dokument time dobija
   * `journalEntryId` (status ostaje CALCULATED), a NIV od migracije 20260726110000 dobija SAMO
   * `status=POSTED` bez naloga (nivelacija se ne knjiži u GK — v. NIV blok u posting.service).
   * Zato uslov pokriva OBA oblika: `journalEntryId != null` ILI `status='POSTED'`. Da se gleda
   * samo nalog, NIV se ne bi mogao zaključati NIKAD (ekran bi ostao bez ijedne akcije).
   *
   * CAS (updateMany + count guard, obrazac kao GK lock / izvodi): pomeri na LOCKED SAMO ako je
   * dokument proknjižen i još nije LOCKED. `count === 0` → razlikuj 404 / 409 (već zaključan /
   * nije proknjižen) dodatnim čitanjem.
   */
  async lockDocument(id: number) {
    const res = await this.prisma.stockDocument.updateMany({
      where: {
        id,
        status: { not: "LOCKED" },
        OR: [{ journalEntryId: { not: null } }, { status: "POSTED" }],
      },
      data: { status: "LOCKED" },
    });
    if (res.count === 0) {
      const doc = await this.prisma.stockDocument.findUnique({
        where: { id },
        select: { status: true, journalEntryId: true },
      });
      if (!doc) throw new NotFoundException(`Robni dokument ${id} ne postoji.`);
      if (doc.status === "LOCKED")
        throw new ConflictException(`Dokument ${id} je već zaključan.`);
      throw new ConflictException(
        `Zaključavanje je moguće tek pošto je dokument proknjižen/obrađen ` +
          `(dokument ${id}, trenutni status: ${doc.status}).`,
      );
    }
    this.logger.log(`Zaključan robni dokument ${id} (status → LOCKED).`);
    return { data: { id, status: "LOCKED" as const, isLocked: true } };
  }

  // ------------------------------------------------------- USLOVI OTPREME

  /**
   * Izmena uslova otpreme i napomene (`fco`, način/datum otpreme, mesto isporuke, ruta,
   * „po porudžbini od", napomena) na postojećem dokumentu.
   *
   * ZAŠTO JE DOZVOLJENO I NA PROKNJIŽENOM DOKUMENTU: ova polja NE ULAZE ni u kalkulaciju,
   * ni u zalihu, ni u glavnu knjigu — to su podaci prateće isprave koji se u praksi
   * saznaju posle knjiženja (vozač, ruta, stvarni dan otpreme). Da se traži nacrt,
   * magacin ih ne bi imao gde uneti i otpremnica bi zauvek izlazila sa praznim linijama.
   * ZAKLJUČAN dokument je izuzet (409) — lock je terminalno stanje i znači „papir je
   * predat"; posle njega se ništa na dokumentu više ne dopisuje.
   *
   * `undefined` polje se ne dira; `null`/prazan string briše vrednost (v. DTO).
   */
  async updateShipping(id: number, dto: UpdateStockDocumentShippingDto) {
    const existing = await this.prisma.stockDocument.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!existing)
      throw new NotFoundException(`Robni dokument ${id} ne postoji.`);
    if (existing.status === "LOCKED")
      throw new ConflictException(
        "Dokument je zaključan — uslovi otpreme se više ne menjaju.",
      );

    const data: Prisma.StockDocumentUpdateInput = {};
    if (dto.fco !== undefined) data.fco = trimOrNull(dto.fco);
    if (dto.shippingMethod !== undefined)
      data.shippingMethod = trimOrNull(dto.shippingMethod);
    if (dto.shippingDate !== undefined)
      data.shippingDate = trimOrNull(dto.shippingDate)
        ? parseDateParam(dto.shippingDate ?? undefined, "shippingDate")
        : null;
    if (dto.deliveryPlace !== undefined)
      data.deliveryPlace = trimOrNull(dto.deliveryPlace);
    if (dto.route !== undefined) data.route = trimOrNull(dto.route);
    if (dto.customerOrderRef !== undefined)
      data.customerOrderRef = trimOrNull(dto.customerOrderRef);
    if (dto.note !== undefined) data.note = trimOrNull(dto.note);

    if (Object.keys(data).length === 0)
      throw new UnprocessableEntityException(
        "Nijedno polje uslova otpreme nije prosleđeno.",
      );

    const updated = await this.prisma.stockDocument.update({
      where: { id },
      data,
    });
    this.logger.log(
      `Ažurirani uslovi otpreme na robnom dokumentu ${id} (${Object.keys(data).join(", ")}).`,
    );
    return { data: updated };
  }

  /**
   * Guard: mutacija zaključanog dokumenta se odbija (409). Poziva se iz svih mutacija dokumenta
   * (calculate/post rute) pre poziva odgovarajućeg servisa — zaključan dokument je immutable.
   * Čita samo status (PK lookup). NotFound se prepušta pozivaocu (postojeći servis vraća jasnu 404).
   */
  async assertNotLocked(id: number): Promise<void> {
    const doc = await this.prisma.stockDocument.findUnique({
      where: { id },
      select: { status: true },
    });
    if (doc?.status === "LOCKED")
      throw new ConflictException("Dokument je zaključan.");
  }

  // ------------------------------------------------------- STAVKE (soft-delete)

  /**
   * Guard za mutaciju stavke: brisanje/poništavanje je dozvoljeno SAMO dok dokument
   * nije proknjižen u GK ni zaključan. „Proknjižen" se izvodi iz `journalEntryId`
   * (robni `post` postavlja SAMO njega, status ostaje CALCULATED — v. `lockDocument`),
   * pa se guard oslanja na `journalEntryId != null` ILI status POSTED/LOCKED. Time
   * obrisana stavka NIKAD ne može da izmeni već proknjižen GK/KEPU (najvažniji uslov).
   */
  private async assertItemMutable(
    tx: Prisma.TransactionClient,
    docId: number,
  ): Promise<void> {
    const doc = await tx.stockDocument.findUnique({
      where: { id: docId },
      select: { status: true, journalEntryId: true },
    });
    if (!doc)
      throw new NotFoundException(`Robni dokument ${docId} ne postoji.`);
    if (
      doc.journalEntryId != null ||
      doc.status === "POSTED" ||
      doc.status === "LOCKED"
    )
      throw new ConflictException(
        `Izmena stavki nije moguća — dokument ${docId} je proknjižen ili zaključan.`,
      );
    // CALCULATED je takođe zatvoren za izmenu stavki (review Batch B): kalkulacija je
    // već napisala IZVEDENE, perzistentne podatke koje brisanje stavke NE poništava —
    // KEPU redove i (za UL) uprosečenu nabavnu cenu u ItemValuation + NIV dokument.
    // Brisanje posle kalkulacije bi trajno razišlo knjigu i valuaciju sa stvarnim
    // stavkama. Ispravan tok: poništi kalkulaciju (ili storniraj dokument) pa menjaj.
    if (doc.status === "CALCULATED")
      throw new ConflictException(
        `Izmena stavki nije moguća — dokument ${docId} je kalkulisan ` +
          `(KEPU i valuacija su već izvedeni). Poništi kalkulaciju pa ponovi izmenu.`,
      );
  }

  /**
   * Meko obriši (soft-delete) jednu stavku robnog dokumenta — poništivo („Undo") u
   * `UNDO_WINDOW_MS`. Guard: dokument nije proknjižen/zaključan (409). Obrisana stavka
   * nestaje iz liste i NE utiče na zalihe/kalkulaciju/GK (svi čitaoci filtriraju
   * `deletedAt: null`). Ostavlja trag (`deletedByUserId`, `deletedAt`).
   */
  async deleteItem(docId: number, itemLineId: number, userId: number | null) {
    return this.prisma.$transaction(async (tx) => {
      await this.assertItemMutable(tx, docId);
      const item = await tx.stockDocumentItem.findFirst({
        where: { id: itemLineId, documentId: docId },
        select: { id: true, deletedAt: true },
      });
      if (!item)
        throw new NotFoundException(
          `Stavka ${itemLineId} ne postoji u dokumentu ${docId}.`,
        );
      if (item.deletedAt != null)
        throw new ConflictException(`Stavka ${itemLineId} je već obrisana.`);

      await softDelete(tx, tx.stockDocumentItem, itemLineId, userId);
      this.logger.log(
        `Soft-delete stavke ${itemLineId} (dokument ${docId}, korisnik ${userId ?? "?"}).`,
      );
      return {
        data: {
          docId,
          itemLineId,
          deleted: true,
          undoWindowMs: UNDO_WINDOW_MS,
        },
      };
    });
  }

  /**
   * Poništi (undo) brisanje stavke — SAMO unutar `UNDO_WINDOW_MS` (posle: 409 rok
   * istekao). Guard: dokument i dalje nije proknjižen/zaključan. Vraća stavku u listu.
   */
  async restoreItem(docId: number, itemLineId: number) {
    return this.prisma.$transaction(async (tx) => {
      await this.assertItemMutable(tx, docId);
      const item = await tx.stockDocumentItem.findFirst({
        where: { id: itemLineId, documentId: docId },
        select: { id: true },
      });
      if (!item)
        throw new NotFoundException(
          `Stavka ${itemLineId} ne postoji u dokumentu ${docId}.`,
        );

      await restore(tx, tx.stockDocumentItem, itemLineId);
      this.logger.log(
        `Undo brisanja stavke ${itemLineId} (dokument ${docId}).`,
      );
      return { data: { docId, itemLineId, restored: true } };
    });
  }

  /**
   * Mapiraj DTO stavku → Prisma create input (sirovi iznosi; landed popunjava kalkulacija).
   *
   * ⚠️ OVDE JE ULAZNA BRANA ZA PORESKU ŠIFRU (nalaz S3, 02.08.2026). Šifra koju mapa poreskih
   * stopa ne zna ćuti na dva mesta koja rade novac: `CalculationService.taxRateOf`
   * (maloprodajna cena bez PDV-a) i `PostingEngine.aggregateDocAmounts` (nalog bez PDV linije).
   * Zato pada ovde, na unosu, dok je dokument još prazan — a ne na knjiženju, kad je već sve
   * upisano. (Put IZMENE ima svoju branu: `@IsIn` u `update-stock-document.dto.ts`.)
   *
   * NAPOMENA (04.08.2026): `CreateStockDocumentItemDto` je od tada KLASA sa `class-validator`
   * dekoratorima, pa HTTP put sada validira i `ValidationPipe`. Ova provera OSTAJE, jer
   * interni pozivaoci (`CarryOverService`, `TransferService`, `InventoryService.finalize`)
   * grade DTO u kodu i zovu servis direktno — kroz njih pipe uopšte ne prolazi.
   */
  private buildItemData(
    it: CreateStockDocumentItemDto,
    headerWarehouseId: number,
    idx: number,
  ): Prisma.StockDocumentItemCreateWithoutDocumentInput {
    const taxCode = it.goodsTaxRateCode ?? "3";
    if (!KNOWN_VAT_CODES.has(taxCode)) {
      throw new UnprocessableEntityException(
        `Stavka ${it.lineNo ?? idx + 1} (artikal ${it.itemId}): ` +
          unknownVatCodeMessage(taxCode),
      );
    }
    return {
      itemId: it.itemId,
      warehouseId: it.warehouseId ?? headerWarehouseId,
      lineNo: it.lineNo ?? idx + 1,
      quantity: toDec(it.quantity),
      kgQuantity: toDec(it.kgQuantity),
      invoicePrice: toDec(it.invoicePrice),
      discountPercent: toDec(it.discountPercent),
      cashDiscountPercent: toDec(it.cashDiscountPercent),
      dependentCostOwn: toDec(it.dependentCostOwn),
      dependentCostSupplier: toDec(it.dependentCostSupplier),
      actualWholesalePrice: toDec(it.actualWholesalePrice),
      actualRetailPrice: toDec(it.actualRetailPrice),
      markupAmount: toDec(it.markupAmount),
      excise: toDec(it.excise),
      fee: toDec(it.fee),
      fixedTax: toDec(it.fixedTax),
      fxPurchasePrice: toDec(it.fxPurchasePrice),
      customsRate: toDec(it.customsRate),
      goodsTaxRateCode: taxCode,
    };
  }
}

/**
 * Manji od dva stanja — koristi se u `assertStockAvailable` da datum unazad ne
 * može da „pozajmi" zalihu koja u međuvremenu više ne postoji.
 */
function minDec(a: Prisma.Decimal, b: Prisma.Decimal): Prisma.Decimal {
  return a.lessThan(b) ? a : b;
}
