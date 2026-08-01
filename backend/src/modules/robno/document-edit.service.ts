import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { parseDateParam } from "../../common/date-params";
import { NOT_DELETED } from "../../common/soft-delete.util";
import { toDec } from "./decimal.util";
import { CalculationService } from "./calculation.service";
import { parseStockCheck } from "../../common/document-types/stock-check";
import {
  RobnoService,
  STOCK_DOCUMENT_TX_OPTIONS,
  TRANSFER_ONLY_TYPES,
  trimOrNull,
} from "./robno.service";
import {
  lockStockKeys,
  stockKeyOf,
  sumOpenReservations,
} from "./reservation.service";
import type { StockKey } from "./dto/reservation.dto";
import type {
  CreateStockDocumentItemBodyDto,
  UpdateStockDocumentDto,
  UpdateStockDocumentItemDto,
} from "./dto/update-stock-document.dto";

/**
 * IZMENA POSTOJEĆEG ROBNOG DOKUMENTA — zaglavlje + dodavanje/izmena stavke.
 * ============================================================================
 * Rupa iz `PLAN_UNOS_DOKUMENATA.md §5.7`: robni modul je do 28.07.2026. imao SAMO
 * `DELETE`/`restore` stavke i `PATCH …/shipping`. Pogrešan datum, dobavljač, magacin ili
 * količina značili su „obriši sve i ukucaj dokument ponovo" — a broj dokumenta je već
 * potrošen. Prva celina koja se gradi je ULAZ ROBE (primka): 69% svih robnih dokumenata
 * (1.281 od 1.858 u 2026), najprostije zaglavlje i najmanje sporednih posledica.
 *
 * ŠTA OVAJ SERVIS NAMERNO NE RADI:
 *   • NE računa cene. Kalkulativne kolone (`purchasePriceNet`, `calculatedWholesalePrice`,
 *     `calculatedRetailPrice`, izvedeni `markupAmount`) piše ISKLJUČIVO
 *     `CalculationService.calculate` — motor već postoji i ovde se samo poziva (opciono,
 *     v. `recalculate` u DTO-u). Druga formula za istu cenu = dve istine o nabavnoj vrednosti.
 *   • NE dira prenos između magacina. Prenos je PAR dokumenata (PREIZ+PREUL) i jednostrana
 *     izmena bi razdužila jedan magacin a drugi ne bi zadužila — zato se takav dokument ovde
 *     ODBIJA (422), ne popravlja.
 *   • NE menja broj dokumenta, vrstu (`documentTypeCode`) ni `kind`. Broj je već potrošen iz
 *     serije, a vrsta vozi znak zalihe + GK šemu + KODJ izuzeće; njihova izmena je storno +
 *     nov dokument, ne PATCH.
 */
@Injectable()
export class DocumentEditService {
  private readonly logger = new Logger(DocumentEditService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly robno: RobnoService,
    private readonly calculation: CalculationService,
  ) {}

  // ───────────────────────────────────────────────────────────── ZAGLAVLJE

  /**
   * `PATCH /v1/robno/documents/:id` — zaglavlje robnog dokumenta.
   *
   * GUARD JE PODELJEN PO POSLEDICI, ne po ruti:
   *   • TVRDA polja (`documentDate`, `postingDate`, `warehouseId`, `supplierId`, `customerId`)
   *     ulaze u obračun zaliha/costinga → dozvoljena su SAMO na nacrtu (v. `assertEditable`);
   *   • MEKA polja (`shippingMethod`, `note`) su prateći podaci koje magacin saznaje kasnije →
   *     dozvoljena su i posle knjiženja, tačno kao na `PATCH …/shipping`. Da im je nametnut
   *     tvrdi guard, ova ruta bi bila strožija od već postojeće i magacin bi izgubio jedini
   *     način da dopiše način otpreme na proknjižen dokument.
   */
  async updateHeader(
    id: number,
    dto: UpdateStockDocumentDto,
    userId: number | null,
  ) {
    // Polja kojih šema NEMA — 422 sa uputstvom umesto tihog gubitka (v. DTO).
    assertNoMissingColumn(dto);

    const touchesHard =
      dto.documentDate !== undefined ||
      dto.postingDate !== undefined ||
      dto.warehouseId !== undefined ||
      dto.supplierId !== undefined ||
      dto.customerId !== undefined;

    return this.prisma.$transaction(async (tx) => {
      const doc = await this.assertEditable(tx, id, {
        // Meka polja (način otpreme / napomena) se dopisuju i na proknjižen dokument —
        // zaključan je izuzet i tamo (isti izuzetak kao `RobnoService.updateShipping`).
        softFieldsOnly: !touchesHard,
      });

      const data: Prisma.StockDocumentUpdateInput = {};
      const changed: string[] = [];
      let newDocumentDate: Date | undefined;
      let newWarehouseId: number | undefined;

      if (dto.documentDate !== undefined) {
        const d = parseDateParam(dto.documentDate, "documentDate");
        if (!d)
          throw new UnprocessableEntityException(
            "Datum dokumenta ne može biti prazan — pošalji ISO datum.",
          );
        newDocumentDate = d;
        data.documentDate = d;
        changed.push("documentDate");
      }
      if (dto.postingDate !== undefined) {
        const d = parseDateParam(dto.postingDate, "postingDate");
        if (!d)
          throw new UnprocessableEntityException(
            "Datum knjiženja ne može biti prazan — pošalji ISO datum.",
          );
        data.postingDate = d;
        changed.push("postingDate");
      }
      if (dto.supplierId !== undefined) {
        if (dto.supplierId !== null)
          await this.assertPartnerExists(tx, dto.supplierId, "Dobavljač");
        data.supplierId = dto.supplierId;
        changed.push("supplierId");
      }
      if (dto.customerId !== undefined) {
        if (dto.customerId !== null)
          await this.assertPartnerExists(tx, dto.customerId, "Kupac");
        data.customerId = dto.customerId;
        changed.push("customerId");
      }
      if (dto.shippingMethod !== undefined) {
        data.shippingMethod = trimOrNull(dto.shippingMethod);
        changed.push("shippingMethod");
      }
      if (dto.note !== undefined) {
        data.note = trimOrNull(dto.note);
        changed.push("note");
      }

      // ── Magacin: promena MORA da povuče i stavke ──────────────────────────
      // Stanje se svuda računa po `stock_document_items.warehouse_id`, a zaglavlje je samo
      // podrazumevana vrednost. Da se promeni samo zaglavlje, papir bi pisao nov magacin a
      // zaliha bi se i dalje knjižila u stari (isti oblik greške kao jednostrani prenos).
      let movedLines = 0;
      if (
        dto.warehouseId !== undefined &&
        dto.warehouseId !== doc.warehouseId
      ) {
        const target = await tx.warehouse.findUnique({
          where: { id: dto.warehouseId },
          select: { id: true },
        });
        if (!target)
          throw new UnprocessableEntityException(
            `Magacin ${dto.warehouseId} ne postoji.`,
          );
        newWarehouseId = dto.warehouseId;
        data.warehouseId = dto.warehouseId;
        changed.push("warehouseId");
        movedLines = doc.items.filter(
          (l) => l.warehouseId === doc.warehouseId,
        ).length;
      }

      if (changed.length === 0)
        throw new UnprocessableEntityException(
          "Nijedno polje zaglavlja nije prosleđeno.",
        );

      // Stavke koje su „pratile" zaglavlje idu za njim; red kome je magacin ručno
      // postavljen na nešto treće ostaje gde jeste (isti izbor kao pri kreiranju).
      const nextLines = doc.items.map((l) =>
        newWarehouseId !== undefined && l.warehouseId === doc.warehouseId
          ? { ...l, warehouseId: newWarehouseId }
          : l,
      );

      const warnings = await this.assertStockForChange(tx, doc, nextLines, {
        effectiveDate: newDocumentDate ?? doc.documentDate,
        // Promena datuma pomera as-of osnovu obračuna, pa se proveravaju SVI redovi,
        // ne samo oni kojima je potražnja porasla.
        recheckAll: newDocumentDate !== undefined,
      });

      if (newWarehouseId !== undefined)
        await tx.stockDocumentItem.updateMany({
          where: {
            documentId: doc.id,
            warehouseId: doc.warehouseId,
            ...NOT_DELETED,
          },
          data: { warehouseId: newWarehouseId },
        });

      data.updatedByUserId = userId ?? null;
      const updated = await tx.stockDocument.update({
        where: { id: doc.id },
        data,
        include: { items: { where: NOT_DELETED, orderBy: { id: "asc" } } },
      });

      this.logger.log(
        `Izmena zaglavlja robnog dokumenta ${doc.documentNumber} (id=${doc.id}): ` +
          `${changed.join(", ")}${movedLines ? `; premešteno ${movedLines} stavki u magacin ${newWarehouseId}` : ""}.`,
      );
      return {
        data: updated,
        meta: {
          changed,
          movedLines,
          warnings,
          calculation: calculationHint(updated.status),
        },
      };
    }, STOCK_DOCUMENT_TX_OPTIONS);
  }

  // ───────────────────────────────────────────────────────────────── STAVKE

  /** `POST /v1/robno/documents/:id/items` — dodaj stavku na nacrt dokumenta. */
  async addItem(
    docId: number,
    dto: CreateStockDocumentItemBodyDto,
    userId: number | null,
  ) {
    const quantity = toDec(dto.quantity);
    if (quantity.isZero())
      throw new UnprocessableEntityException(
        "Stavka mora imati količinu različitu od 0.",
      );
    if (quantity.isNegative())
      throw new UnprocessableEntityException(
        "Količina se unosi kao pozitivan broj — smer (ulaz/izlaz) se izvodi iz vrste dokumenta.",
      );

    const created = await this.prisma.$transaction(async (tx) => {
      const doc = await this.assertEditable(tx, docId);
      await this.assertItemExists(tx, dto.itemId);
      const warehouseId = await this.resolveLineWarehouse(
        tx,
        dto.warehouseId,
        doc.warehouseId,
      );

      const lineNo =
        dto.lineNo ??
        doc.items.reduce((max, l) => Math.max(max, l.lineNo), 0) + 1;

      const nextLines = [
        ...doc.items,
        { id: -1, itemId: dto.itemId, warehouseId, lineNo, quantity },
      ];
      const warnings = await this.assertStockForChange(tx, doc, nextLines, {
        effectiveDate: doc.documentDate,
      });

      const item = await tx.stockDocumentItem.create({
        data: {
          documentId: doc.id,
          itemId: dto.itemId,
          warehouseId,
          lineNo,
          quantity,
          ...itemAmountData(dto),
          goodsTaxRateCode: dto.goodsTaxRateCode ?? "3",
        },
      });
      await tx.stockDocument.update({
        where: { id: doc.id },
        data: { updatedByUserId: userId ?? null },
      });

      this.logger.log(
        `Dodata stavka ${item.id} (artikal ${dto.itemId}, magacin ${warehouseId}, ` +
          `kol ${quantity.toString()}) na dokument ${doc.documentNumber} (id=${doc.id}).`,
      );
      return { item, warnings, status: doc.status };
    }, STOCK_DOCUMENT_TX_OPTIONS);

    return this.finish(docId, created, dto.recalculate === true);
  }

  /** `PATCH /v1/robno/documents/:id/items/:lineId` — izmeni postojeću stavku. */
  async updateItem(
    docId: number,
    lineId: number,
    dto: UpdateStockDocumentItemDto,
    userId: number | null,
  ) {
    const updated = await this.prisma.$transaction(async (tx) => {
      const doc = await this.assertEditable(tx, docId);
      const line = doc.items.find((l) => l.id === lineId);
      if (!line) {
        // Razlikuj „nema je" od „meko je obrisana" — druga poruka nosi izlaz iz situacije.
        const deleted = await tx.stockDocumentItem.findFirst({
          where: { id: lineId, documentId: docId },
          select: { id: true },
        });
        if (deleted)
          throw new ConflictException(
            `Stavka ${lineId} je obrisana — poništi brisanje („Poništi") pa je onda menjaj.`,
          );
        throw new NotFoundException(
          `Stavka ${lineId} ne postoji u dokumentu ${docId}.`,
        );
      }

      const data: Prisma.StockDocumentItemUpdateInput = {};
      const changed: string[] = [];

      if (dto.itemId !== undefined) {
        await this.assertItemExists(tx, dto.itemId);
        data.itemId = dto.itemId;
        changed.push("itemId");
      }
      if (dto.warehouseId !== undefined) {
        await this.resolveLineWarehouse(tx, dto.warehouseId, doc.warehouseId);
        data.warehouseId = dto.warehouseId;
        changed.push("warehouseId");
      }
      if (dto.quantity !== undefined) {
        const q = toDec(dto.quantity);
        if (q.isZero())
          throw new UnprocessableEntityException(
            "Stavka mora imati količinu različitu od 0. Ako red ne treba, obriši ga.",
          );
        if (q.isNegative())
          throw new UnprocessableEntityException(
            "Količina se unosi kao pozitivan broj — smer (ulaz/izlaz) se izvodi iz vrste dokumenta.",
          );
        data.quantity = q;
        changed.push("quantity");
      }
      if (dto.lineNo !== undefined) {
        data.lineNo = dto.lineNo;
        changed.push("lineNo");
      }
      if (dto.goodsTaxRateCode !== undefined) {
        data.goodsTaxRateCode = dto.goodsTaxRateCode;
        changed.push("goodsTaxRateCode");
      }
      const amounts = itemAmountData(dto);
      for (const [key, value] of Object.entries(amounts)) {
        (data as Record<string, unknown>)[key] = value;
        changed.push(key);
      }

      if (changed.length === 0)
        throw new UnprocessableEntityException(
          "Nijedno polje stavke nije prosleđeno.",
        );

      const nextLines = doc.items.map((l) =>
        l.id === lineId
          ? {
              ...l,
              itemId: dto.itemId ?? l.itemId,
              warehouseId: dto.warehouseId ?? l.warehouseId,
              quantity:
                dto.quantity !== undefined ? toDec(dto.quantity) : l.quantity,
            }
          : l,
      );
      const warnings = await this.assertStockForChange(tx, doc, nextLines, {
        effectiveDate: doc.documentDate,
      });

      const item = await tx.stockDocumentItem.update({
        where: { id: lineId },
        data,
      });
      await tx.stockDocument.update({
        where: { id: doc.id },
        data: { updatedByUserId: userId ?? null },
      });

      this.logger.log(
        `Izmenjena stavka ${lineId} dokumenta ${doc.documentNumber} (id=${doc.id}): ${changed.join(", ")}.`,
      );
      return { item, warnings, status: doc.status, changed };
    }, STOCK_DOCUMENT_TX_OPTIONS);

    return this.finish(docId, updated, dto.recalculate === true);
  }

  // ────────────────────────────────────────────────────────────────── GUARDS

  /**
   * Jedini guard izmene — vraća dokument sa NEobrisanim stavkama ili baca poslovnu grešku.
   *
   * Odbija (409/422) sve što izmena ne sme da dotakne:
   *   1. PROKNJIŽEN / ZAKLJUČAN (`journalEntryId != null`, POSTED, LOCKED) — GK i KEPU su već
   *      napisani; naknadna izmena bi ih tiho razišla sa dokumentom.
   *   2. KALKULISAN (CALCULATED) — kalkulacija je izvela trajne podatke (KEPU red, uprosečena
   *      valuacija, NIV dokument razlike) koje izmena stavke ne poništava.
   *   3. PRENOS između magacina (kind PRENOS, vrsta PREIZ/PREUL, ili postoji par) — dokument
   *      je polovina para; jednostrana izmena razdužuje jedan magacin a drugi ne zadužuje.
   *   4. STORNO drugog dokumenta — mora ostati verna ogledalna slika originala.
   *   5. Dokument iz POPISA (VISAK/MANJAK) — količine dolaze iz prebrojanog stanja; ručna
   *      izmena bi razišla dokument sa popisnom listom.
   *
   * `softFieldsOnly` popušta uslove (1) i (2) — i SAMO njih — kad zahtev dira isključivo
   * prateće podatke (način otpreme, napomena) koji ne ulaze ni u zalihu ni u GK. Uslov (2)
   * mora da popusti zajedno sa (1): robni `post` NE menja status, pa proknjižen dokument
   * ostaje u statusu CALCULATED — da guard (2) ostane tvrd, napomena se na proknjižen
   * dokument ne bi mogla dopisati uopšte.
   */
  private async assertEditable(
    tx: Prisma.TransactionClient,
    id: number,
    opts: { softFieldsOnly?: boolean } = {},
  ): Promise<EditableDoc> {
    const doc = await tx.stockDocument.findUnique({
      where: { id },
      select: {
        id: true,
        kind: true,
        documentTypeCode: true,
        documentNumber: true,
        status: true,
        journalEntryId: true,
        warehouseId: true,
        documentDate: true,
        transferPairDocId: true,
        reversalOfDocId: true,
        inventoryCountId: true,
        items: {
          where: NOT_DELETED,
          orderBy: { id: "asc" },
          select: {
            id: true,
            itemId: true,
            warehouseId: true,
            lineNo: true,
            quantity: true,
          },
        },
      },
    });
    if (!doc) throw new NotFoundException(`Robni dokument ${id} ne postoji.`);

    if (
      doc.kind === "PRENOS" ||
      TRANSFER_ONLY_TYPES.has(doc.documentTypeCode) ||
      doc.transferPairDocId != null
    )
      throw new UnprocessableEntityException(
        `Dokument ${doc.documentNumber} je jedna strana prenosa između magacina (par ` +
          `razduženje+zaduženje). Pojedinačna izmena bi razdužila jedan magacin, a drugi ` +
          `ostavila nezadužen. Storniraj prenos radnjom „Prenos u drugi magacin” pa napravi nov.`,
      );

    if (doc.reversalOfDocId != null)
      throw new ConflictException(
        `Dokument ${doc.documentNumber} je storno drugog dokumenta i mora ostati njegova ` +
          `verna ogledalna slika — ne menja se. Ispravi original, pa storniraj ponovo.`,
      );

    if (doc.inventoryCountId != null)
      throw new ConflictException(
        `Dokument ${doc.documentNumber} je nastao zaključivanjem popisa i njegove količine ` +
          `dolaze iz prebrojanog stanja. Ispravka ide kroz popis (unos popisane količine), ` +
          `ne kroz izmenu dokumenta.`,
      );

    // Zaključan je zatvoren i za meka polja (isto pravilo kao `RobnoService.updateShipping`):
    // lock znači „papir je predat", posle njega se na dokument ništa ne dopisuje.
    if (doc.status === "LOCKED")
      throw new ConflictException(
        `Dokument ${doc.documentNumber} je zaključan — na njega se više ništa ne dopisuje. ` +
          `Ispravka ide storniranjem pa unosom novog dokumenta.`,
      );

    if (opts.softFieldsOnly !== true) {
      if (doc.journalEntryId != null || doc.status === "POSTED")
        throw new ConflictException(
          `Dokument ${doc.documentNumber} je proknjižen i više se ne menja — glavna knjiga i ` +
            `KEPU su već upisani. Ispravka ide storniranjem pa unosom novog dokumenta.`,
        );
      if (doc.status === "CALCULATED")
        throw new ConflictException(
          `Dokument ${doc.documentNumber} je kalkulisan (KEPU i valuacija su već izvedeni) — ` +
            `izmena nije moguća. Poništi kalkulaciju pa ponovi izmenu.`,
        );
    }

    return doc;
  }

  /**
   * PROVERA ZALIHA — vezana za MAGACIN, ne za vrstu dokumenta (`PLAN_UNOS_DOKUMENATA §2.7`).
   *
   * U BigBitu je provera `F_ProveraZalihaMag()` i uslov je KONJUNKCIJA: blokira se ako magacin
   * vodi zalihe I registar vrste kaže „blokira". Zato se ovde mod čita PO MAGACINU reda
   * (`resolveStockCheckMode`), a ne jednom za ceo dokument.
   *
   * Provera se pokreće samo za redove kojima je potražnja PORASLA (ili za sve, kad se pomeri
   * datum dokumenta). Bez tog uslova bi se ispravka NANIŽE (npr. „ukucao sam 100 umesto 10")
   * odbijala na dokumentu koji je već u minusu — a to je upravo ispravka koja minus gasi.
   *
   * Poređenje ide kroz postojeći `RobnoService.assertStockAvailable` uz `excludeDocId`: stavke
   * ovog dokumenta su VEĆ u stanju (`stateAsOf` ne gleda status), pa bi se bez izbacivanja
   * sopstvena potražnja oduzela dvaput.
   *
   * Vraća listu MEKIH upozorenja (mod `WARN`); tvrdi mod (`BLOCK`) baca 422.
   */
  private async assertStockForChange(
    tx: Prisma.TransactionClient,
    doc: EditableDoc,
    nextLines: readonly DemandLine[],
    opts: { effectiveDate: Date; recheckAll?: boolean },
  ): Promise<string[]> {
    // Ulazni dokument (UL/VISAK) ne troši zalihu — nema šta da nedostaje.
    if (doc.kind !== "IZ" && doc.kind !== "MANJAK") return [];

    const before = demandByKey(doc.items);
    const after = demandByKey(nextLines);

    const grown = [...after.values()].filter((d) => {
      if (opts.recheckAll === true) return true;
      const prev = before.get(stockKeyOf(d.itemId, d.warehouseId));
      return prev === undefined || d.qty.greaterThan(prev.qty);
    });
    if (grown.length === 0) return [];

    // Serijalizacija sa rezervisanjem — isti advisory lock kao `reserveLines` /
    // `createStockDocument`; uzima se za SVE ključeve (i stare i nove), da paralelna
    // rezervacija ne prođe kroz prozor između provere i upisa.
    const keys: StockKey[] = [...before.values(), ...after.values()].map(
      (d) => ({ itemId: d.itemId, warehouseId: d.warehouseId }),
    );
    await lockStockKeys(tx, keys);

    // Rezervacije se oduzimaju samo za IZ. MANJAK (popis) se ne sme blokirati tuđom
    // rezervacijom — roba fizički nedostaje i mora da se otpiše (nalaz R3, 25.07.2026).
    const reserved =
      doc.kind === "IZ"
        ? await sumOpenReservations(
            tx,
            grown.map((d) => ({
              itemId: d.itemId,
              warehouseId: d.warehouseId,
            })),
          )
        : new Map<string, Prisma.Decimal>();

    const modeByWarehouse = new Map<number, StockCheckMode>();
    for (const d of grown) {
      if (!modeByWarehouse.has(d.warehouseId))
        modeByWarehouse.set(
          d.warehouseId,
          await this.resolveStockCheckMode(
            tx,
            doc.documentTypeCode,
            d.warehouseId,
          ),
        );
    }

    const blocking = grown.filter(
      (d) => modeByWarehouse.get(d.warehouseId) === "BLOCK",
    );
    const warning = grown.filter(
      (d) => modeByWarehouse.get(d.warehouseId) === "WARN",
    );

    if (blocking.length)
      await this.robno.assertStockAvailable(
        tx,
        blocking,
        opts.effectiveDate,
        reserved,
        doc.kind,
        { excludeDocId: doc.id },
      );

    const warnings: string[] = [];
    for (const d of warning) {
      try {
        await this.robno.assertStockAvailable(
          tx,
          [d],
          opts.effectiveDate,
          reserved,
          doc.kind,
          { excludeDocId: doc.id },
        );
      } catch (e) {
        if (!(e instanceof UnprocessableEntityException)) throw e;
        const res = e.getResponse() as { message?: string };
        warnings.push(
          typeof res?.message === "string" ? res.message : e.message,
        );
      }
    }
    return warnings;
  }

  /**
   * Nivo provere zaliha za (vrsta dokumenta, magacin).
   *
   * ⚠ MAGACINSKA POLOVINA USLOVA SE JOŠ NE MOŽE PROČITATI: `PLAN_UNOS_DOKUMENATA §2.7` traži
   * `warehouses.vodi_zalihe` (BigBit `F_ProveraZalihaMag`), a `Warehouse` u šemi ima samo
   * `averagePrices`/`warehouseType` — kolone `keeps_stock` NEMA (v. §5.2 plana, nije dodata).
   * Dok se ne doda, magacin se tretira kao „vodi zalihe": radije blokiraj nego tiho pusti
   * negativnu zalihu. Kad kolona stigne, menja se SAMO ovaj metod.
   *
   * Registarska polovina se čita iz `document_types.stock_check` (BLOCK | WARN | OFF).
   * NULL (vrsta koju niko nije konfigurisao) = BLOCK, da se ponašanje zatečenih vrsta ne
   * promeni tiho — pad na OFF bi bez ijedne poruke otvorio negativne zalihe.
   */
  private async resolveStockCheckMode(
    tx: Prisma.TransactionClient,
    documentTypeCode: string,
    warehouseId: number,
  ): Promise<StockCheckMode> {
    const warehouse = await tx.warehouse.findUnique({
      where: { id: warehouseId },
      select: { id: true },
    });
    // Nepoznat magacin: ne popuštaj — stavka sa nepostojećim magacinom je greška unosa,
    // a ne dozvola da se preskoči provera.
    if (!warehouse) return "BLOCK";

    const type = await tx.documentType.findFirst({
      where: { code: documentTypeCode },
      select: { stockCheck: true },
    });
    // Nepopunjena/nepoznata vrednost → `DEFAULT_STOCK_CHECK` iz zajedničkog izvora,
    // ISTOG koji čita registar vrsta. Ranije je ovde stajao sopstveni fallback na
    // BLOCK dok je registar padao na OFF, pa je ekran korisniku javljao „ova vrsta ne
    // proverava zalihe" a ova ruta isti unos odbijala sa 422.
    return parseStockCheck(type?.stockCheck);
  }

  // ─────────────────────────────────────────────────────────────── POMOĆNO

  /** Meki ref `items.id` — postojanje se validira u servisu (BACKEND_RULES §4/§6). */
  private async assertItemExists(
    tx: Prisma.TransactionClient,
    itemId: number,
  ): Promise<void> {
    const item = await tx.item.findUnique({
      where: { id: itemId },
      select: { id: true },
    });
    if (!item)
      throw new UnprocessableEntityException(`Artikal ${itemId} ne postoji.`);
  }

  /** Magacin stavke: prosleđeni (uz proveru postojanja) ili magacin zaglavlja. */
  private async resolveLineWarehouse(
    tx: Prisma.TransactionClient,
    lineWarehouseId: number | undefined,
    headerWarehouseId: number,
  ): Promise<number> {
    if (lineWarehouseId === undefined) return headerWarehouseId;
    const wh = await tx.warehouse.findUnique({
      where: { id: lineWarehouseId },
      select: { id: true },
    });
    if (!wh)
      throw new UnprocessableEntityException(
        `Magacin ${lineWarehouseId} ne postoji.`,
      );
    return lineWarehouseId;
  }

  /** Komitent (dobavljač/kupac) — meki ref `customers.id`. */
  private async assertPartnerExists(
    tx: Prisma.TransactionClient,
    id: number,
    label: string,
  ): Promise<void> {
    const row = await tx.customer.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!row)
      throw new UnprocessableEntityException(`${label} ${id} ne postoji.`);
  }

  /**
   * Zajednički rep obe rute nad stavkama: opciona kalkulacija POSLE zatvorene transakcije
   * (`CalculationService.calculate` otvara SVOJU `$transaction`; poziv iznutra bi bio ugnežden
   * i sedeo bi na advisory lock-ovima koje ova transakcija drži) i jedinstven `{ data, meta }`.
   */
  private async finish(
    docId: number,
    result: {
      item: unknown;
      warnings: string[];
      status: string;
      changed?: string[];
    },
    recalculate: boolean,
  ) {
    if (!recalculate)
      return {
        data: result.item,
        meta: {
          changed: result.changed ?? null,
          warnings: result.warnings,
          calculation: calculationHint(result.status),
          document: null,
        },
      };

    const document = await this.calculation.calculate(docId);
    return {
      data: result.item,
      meta: {
        changed: result.changed ?? null,
        warnings: result.warnings,
        calculation: {
          stale: false,
          status: document.status,
          hint:
            "Dokument je kalkulisan — stavke se više ne menjaju. Poništi kalkulaciju " +
            "ako treba još ispravki.",
        },
        document,
      },
    };
  }
}

/** Dokument u obliku u kom ga guard vraća (samo polja koja izmena zaista gleda). */
interface EditableDoc {
  id: number;
  kind: string;
  documentTypeCode: string;
  documentNumber: string;
  status: string;
  journalEntryId: number | null;
  warehouseId: number;
  documentDate: Date;
  transferPairDocId: number | null;
  reversalOfDocId: number | null;
  inventoryCountId: number | null;
  items: DemandLine[];
}

/** Minimum reda potreban za obračun potražnje po (artikal, magacin). */
interface DemandLine {
  id: number;
  itemId: number;
  warehouseId: number;
  lineNo: number;
  quantity: Prisma.Decimal;
}

/** BLOCK = tvrda brana (422) · WARN = meko upozorenje · OFF = bez provere. */
type StockCheckMode = "BLOCK" | "WARN" | "OFF";

/**
 * Σ količina po (artikal, magacin) — više redova istog artikla se sabira, isto kao u
 * `RobnoService.assertSufficientStock` (inače bi dva reda po 6 prošla na stanju 10).
 */
export function demandByKey(
  lines: readonly DemandLine[],
): Map<string, { itemId: number; warehouseId: number; qty: Prisma.Decimal }> {
  const out = new Map<
    string,
    { itemId: number; warehouseId: number; qty: Prisma.Decimal }
  >();
  for (const l of lines) {
    const key = stockKeyOf(l.itemId, l.warehouseId);
    const qty = l.quantity.abs();
    const cur = out.get(key);
    if (cur) cur.qty = cur.qty.add(qty);
    else out.set(key, { itemId: l.itemId, warehouseId: l.warehouseId, qty });
  }
  return out;
}

/**
 * Iznosi stavke iz DTO-a → Prisma `data` (samo prosleđena polja; `undefined` se ne dira).
 * SIROVI iznosi — izvedene kalkulativne kolone piše samo `CalculationService`.
 */
function itemAmountData(dto: {
  kgQuantity?: string | number;
  invoicePrice?: string | number;
  discountPercent?: string | number;
  cashDiscountPercent?: string | number;
  dependentCostOwn?: string | number;
  dependentCostSupplier?: string | number;
  actualWholesalePrice?: string | number;
  actualRetailPrice?: string | number;
  markupAmount?: string | number;
  excise?: string | number;
  fee?: string | number;
  fixedTax?: string | number;
  fxPurchasePrice?: string | number;
  customsRate?: string | number;
}): Record<string, Prisma.Decimal> {
  const fields = [
    "kgQuantity",
    "invoicePrice",
    "discountPercent",
    "cashDiscountPercent",
    "dependentCostOwn",
    "dependentCostSupplier",
    "actualWholesalePrice",
    "actualRetailPrice",
    "markupAmount",
    "excise",
    "fee",
    "fixedTax",
    "fxPurchasePrice",
    "customsRate",
  ] as const;
  const out: Record<string, Prisma.Decimal> = {};
  for (const f of fields) {
    const v = dto[f];
    if (v !== undefined) out[f] = toDec(v);
  }
  return out;
}

/**
 * Polja koja korisnik očekuje na primci, a kolone u `stock_documents` NEMA. Umesto tihog
 * gubitka (`whitelist: true` bi ih obrisao iz tela) — 422 koji kaže i šta nedostaje i šta
 * korisnik može odmah da uradi. V. izveštaj: obe kolone traže dopunu šeme.
 */
function assertNoMissingColumn(dto: UpdateStockDocumentDto): void {
  if (dto.deliveryNoteNumber !== undefined)
    throw new UnprocessableEntityException(
      "Broj otpremnice dobavljača se još ne čuva — kolona za njega ne postoji u evidenciji " +
        "robnih dokumenata. Do dopune upiši ga u napomenu (polje 'note').",
    );
  if (dto.paymentTerms !== undefined)
    throw new UnprocessableEntityException(
      "Uslovi plaćanja se još ne čuvaju na robnom dokumentu — kolone za njih nema. " +
        "Do dopune upiši ih u napomenu (polje 'note').",
    );
}

/**
 * Stanje kalkulacije posle izmene — dokument u nacrtu ima ZASTARELE kalkulativne kolone dok
 * se „Kalkuliši" ne pokrene. Vraća se u `meta` da UI to ne mora da nagađa (i da se ne desi
 * tiho: dokument izgleda ispravno, a nabavna cena je od pre izmene).
 */
function calculationHint(status: string): {
  stale: boolean;
  status: string;
  hint: string;
} {
  return {
    stale: status === "DRAFT",
    status,
    hint:
      status === "DRAFT"
        ? "Kalkulacija nije izvedena za tekuće stavke — pokreni „Kalkuliši” " +
          "(POST /v1/robno/documents/:id/calculate) kad završiš unos."
        : "Dokument je već kalkulisan.",
  };
}
