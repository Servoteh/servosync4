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
import { parseDateParam } from "../../common/date-params";
import { CostingService } from "./costing.service";
import { RobnoService } from "./robno.service";
import { toDec } from "./decimal.util";
import type {
  CreateInventoryCountDto,
  FinalizeInventoryCountDto,
} from "./dto/inventory.dto";

/** Jednofirmno (kao ostatak robnog modula) — segment numeracije popisa. */
const COMPANY_ID = 0;

/**
 * Podrazumevane vrste robnog dokumenta za knjiženje razlike popisa (doc 39 §D — ROBA):
 *   VISAR (Sema 46 → duguje 1320 zaliha, potražuje 6740 višak prihod),
 *   MANJR (Sema 50 → potražuje 1320 zaliha, duguje 5741 manjak rashod).
 * Za magacin materijala klijent prosledi VISAM / MANJM u telu finalize-a.
 */
const DEFAULT_SURPLUS_DOCUMENT_TYPE = "VISAR";
const DEFAULT_SHORTAGE_DOCUMENT_TYPE = "MANJR";

/**
 * PopisService (inventura, doc 39 §D) — predpunjenje → unos KolPop → razlika → knjiženje VISAK/MANJAK.
 *
 * Predpunjenje (`POPIS_DopisiKolKNG`): za sve artikle sa prometom u magacinu na datum popisa upisuje
 * `bookQuantity` = knjigovodstveno stanje (`CostingService.stateAsOf`, AS-OF, KODJ izuzet) i `price` =
 * prosečna nabavna (`CostingService.averageAsOf`). Stavke su odmah spremne za unos (status COUNTING).
 *
 * Zaključivanje kreira DVA robna dokumenta kroz POSTOJEĆI `RobnoService.createStockDocument` (VISAK za
 * `diff > 0`, MANJAK za `diff < 0` — u dokumentu POZITIVNA količina, znak izlaza vozi `kind`/DocumentType,
 * pa važi guard nedovoljnog stanja). Cena razlike ide u `invoicePrice` — kasnija kalkulacija/knjiženje
 * (POSTOJEĆE rute `/documents/:id/calculate` + `/post`) je pretvaraju u `purchasePriceNet` → GK vrednost.
 *
 * Konvencije: envelope `{ data }`, tipizirane exceptions sa srpskim porukama (BACKEND_RULES §7), sve
 * `Prisma.Decimal` (§2), CAS za status prelaze (COUNTING → POSTED, updateMany + count guard).
 */
@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly costing: CostingService,
    private readonly robno: RobnoService,
  ) {}

  // ---------------------------------------------------------------- READ

  /** Lista popisa (najnoviji prvo), opcioni filter po godini. */
  async list(year?: number) {
    const where: Prisma.InventoryCountWhereInput = {};
    if (year != null && Number.isInteger(year)) where.year = year;

    const rows = await this.prisma.inventoryCount.findMany({
      where,
      orderBy: [{ year: "desc" }, { id: "desc" }],
    });
    return { data: rows };
  }

  /**
   * Detalj popisa (zaglavlje + stavke).
   *
   * Stavke nose i NAZIV/ŠIFRU/JM artikla (meki ref `items.id`, jedan upit po skupu id-jeva).
   * Bez toga je glavni tab popisa prikazivao samo `#90001` — komisija je brojala robu koju
   * ekran ne imenuje (nalaz §3.10). Tab „Razlike" je to već imao; sada su oba ista.
   */
  async get(id: number) {
    const count = await this.prisma.inventoryCount.findUnique({
      where: { id },
      include: { items: { orderBy: { id: "asc" } } },
    });
    if (!count) throw new NotFoundException(`Popis ${id} ne postoji.`);

    const itemIds = [...new Set(count.items.map((i) => i.itemId))];
    const meta = itemIds.length
      ? await this.prisma.item.findMany({
          where: { id: { in: itemIds } },
          select: { id: true, name: true, catalogNumber: true, unit: true },
        })
      : [];
    const byId = new Map(meta.map((m) => [m.id, m]));

    return {
      data: {
        ...count,
        items: count.items.map((it) => ({
          ...it,
          itemName: byId.get(it.itemId)?.name ?? null,
          itemCode: byId.get(it.itemId)?.catalogNumber ?? null,
          unit: byId.get(it.itemId)?.unit ?? null,
        })),
      },
    };
  }

  /**
   * Razlika po stavci (`RazlikaKol = KolPop − KolKng`, doc 39 §D) + zbirovi višak/manjak.
   * `diffValue = diff * price` (prosečna nabavna) — vrednost razlike koja ide u GK po knjiženju.
   */
  async differences(countId: number) {
    const count = await this.prisma.inventoryCount.findUnique({
      where: { id: countId },
      include: { items: { orderBy: { id: "asc" } } },
    });
    if (!count) throw new NotFoundException(`Popis ${countId} ne postoji.`);

    // Nazivi/šifre artikala za čitljivu listu (meki ref items.id) — jedan upit po skupu id-jeva.
    const itemIds = [...new Set(count.items.map((i) => i.itemId))];
    const items = itemIds.length
      ? await this.prisma.item.findMany({
          where: { id: { in: itemIds } },
          select: { id: true, name: true, catalogNumber: true, unit: true },
        })
      : [];
    const itemById = new Map(items.map((i) => [i.id, i]));

    let surplusValue = new Prisma.Decimal(0);
    let shortageValue = new Prisma.Decimal(0);
    let surplusCount = 0;
    let shortageCount = 0;

    const rows = count.items.map((it) => {
      const diff = it.countedQuantity.minus(it.bookQuantity);
      const diffValue = diff.mul(it.price).toDecimalPlaces(4);
      if (diff.greaterThan(0)) {
        surplusValue = surplusValue.add(diffValue);
        surplusCount += 1;
      } else if (diff.lessThan(0)) {
        shortageValue = shortageValue.add(diffValue);
        shortageCount += 1;
      }
      const meta = itemById.get(it.itemId);
      return {
        itemId: it.itemId,
        naziv: meta?.name ?? null,
        itemCode: meta?.catalogNumber ?? null,
        unit: meta?.unit ?? null,
        book: it.bookQuantity.toFixed(6),
        counted: it.countedQuantity.toFixed(6),
        diff: diff.toFixed(6),
        price: it.price.toFixed(4),
        diffValue: diffValue.toFixed(4),
      };
    });

    return {
      data: {
        countId: count.id,
        status: count.status,
        items: rows,
        summary: {
          surplusValue: surplusValue.toFixed(4),
          shortageValue: shortageValue.toFixed(4),
          surplusCount,
          shortageCount,
        },
      },
    };
  }

  // -------------------------------------------------------------- CREATE

  /**
   * Kreiraj popis i PREDPUNI stavke (doc 39 §D `POPIS_DopisiKolKNG`). Za sve artikle sa prometom u
   * magacinu do `countDate`: `bookQuantity` = stanje na dan (`stateAsOf`), `price` = prosečna nabavna
   * (`averageAsOf`). Costing čita istorijske (nepromenljive u ovoj operaciji) podatke → van kratke
   * transakcije koja upisuje popis; numeracija `NNNN/god` je pod advisory lock-om u toj transakciji.
   * Status: DRAFT → COUNTING odmah (stavke spremne za unos KolPop).
   */
  async createCount(dto: CreateInventoryCountDto, userId?: number) {
    if (!Number.isInteger(dto?.warehouseId) || dto.warehouseId <= 0)
      throw new UnprocessableEntityException(
        "warehouseId je obavezan — pozitivan ceo broj.",
      );

    const warehouse = await this.prisma.warehouse.findUnique({
      where: { id: dto.warehouseId },
      select: { id: true },
    });
    if (!warehouse)
      throw new UnprocessableEntityException(
        `Magacin ${dto.warehouseId} ne postoji.`,
      );

    const countDate = parseDateParam(dto.countDate, "countDate") ?? new Date();
    const year = businessYear(countDate);

    // Kandidati = artikli sa prometom u magacinu do datuma popisa (preskaču se artikli bez prometa I
    // stanja 0, doc 39 §D). Artikal sa prometom ostaje i ako mu je stanje 0 (operater potvrđuje 0).
    const itemIds = await this.candidateItemIds(dto.warehouseId, countDate);

    const prefilled: Array<{
      itemId: number;
      bookQuantity: Prisma.Decimal;
      price: Prisma.Decimal;
    }> = [];
    for (const itemId of itemIds) {
      const bookQuantity = await this.costing.stateAsOf(
        itemId,
        dto.warehouseId,
        countDate,
      );
      const { avgPurchaseNet } = await this.costing.averageAsOf(
        itemId,
        dto.warehouseId,
        countDate,
      );
      prefilled.push({
        itemId,
        bookQuantity,
        price: avgPurchaseNet.toDecimalPlaces(4),
      });
    }

    const created = await this.prisma.$transaction(async (tx) => {
      const countNumber = await this.nextCountNumber(tx, year);
      return tx.inventoryCount.create({
        data: {
          companyId: COMPANY_ID,
          warehouseId: dto.warehouseId,
          countNumber,
          year,
          countDate,
          status: "COUNTING",
          note: dto.note ?? null,
          createdByUserId: userId ?? null,
          items: {
            create: prefilled.map((p) => ({
              itemId: p.itemId,
              bookQuantity: p.bookQuantity,
              countedQuantity: new Prisma.Decimal(0),
              price: p.price,
            })),
          },
        },
        include: { items: { orderBy: { id: "asc" } } },
      });
    });

    this.logger.log(
      `Kreiran popis ${created.countNumber} (magacin ${created.warehouseId}, ${created.items.length} stavki, COUNTING).`,
    );
    return { data: created };
  }

  /**
   * Unos popisane količine (`KolPop`) za jednu stavku. Guard: popis mora biti u statusu COUNTING.
   * Guard i upis su ATOMSKI — `updateMany` sa relacionim filterom `count.status = COUNTING` (nema
   * TOCTOU prozora između čitanja statusa i upisa). `count === 0` → razlikuj 404 (stavka ne postoji)
   * od 409 (popis nije COUNTING) dodatnim čitanjem. Nenegativna količina.
   */
  async updateItem(
    countId: number,
    itemId: number,
    countedQuantity: string | number,
  ) {
    const qty = toDec(countedQuantity);
    if (qty.isNegative())
      throw new UnprocessableEntityException(
        "Popisana količina ne sme biti negativna.",
      );

    // Atomski: pogađa stavku SAMO ako je njen popis još u COUNTING (relacioni guard).
    const res = await this.prisma.inventoryCountItem.updateMany({
      where: { countId, itemId, count: { status: "COUNTING" } },
      data: { countedQuantity: qty },
    });
    if (res.count === 0) {
      // Ništa nije pogođeno: ili popis nije u COUNTING (409) ili stavka ne postoji (404).
      const count = await this.prisma.inventoryCount.findUnique({
        where: { id: countId },
        select: { status: true },
      });
      if (!count) throw new NotFoundException(`Popis ${countId} ne postoji.`);
      if (count.status !== "COUNTING")
        throw new ConflictException(
          `Unos količine je moguć samo u statusu COUNTING (trenutno: ${count.status}).`,
        );
      throw new NotFoundException(
        `Artikal ${itemId} nije u popisu ${countId}.`,
      );
    }

    return { data: { countId, itemId, countedQuantity: qty.toFixed(6) } };
  }

  /**
   * Zaključi popis: kreiraj robne dokumente VISAK (diff>0) i MANJAK (diff<0) kroz POSTOJEĆI
   * `RobnoService.createStockDocument`, pa CAS COUNTING → POSTED kao POSLEDNJI korak. Prazan
   * dokument (bez stavki) se preskače; `inventoryCountId` vezuje dokumente za popis. Već POSTED
   * → 409 (idempotencija).
   *
   * Redosled (retry-safe; obrazac lock-a iz posting.service 4001):
   *   (1) advisory xact lock po popisu (namespace 4002) — serijalizuje paralelne finalize;
   *   (2) status-guard čitanje (mora COUNTING);
   *   (3) čišćenje orphan VISAK/MANJAK dokumenata prethodnog (palog) pokušaja — bez reuse
   *       zastarelih količina (F2): bezbedne (DRAFT, bez naloga, nekalkulisane) se BRIŠU, a
   *       nebezbedne (kalkulisane/proknjižene) → 409 (ručna sanacija);
   *   (4) kreiranje sveže VISAK pa MANJAK dokumenata iz TEKUĆIH razlika;
   *   (5) CAS COUNTING → POSTED kao poslednji korak.
   *
   * Pad pre koraka (5) ostavlja popis u COUNTING + eventualne DRAFT dokumente; retry ih u koraku
   * (3) obriše i kreira nove iz aktuelnih količina. Zato NEMA kompenzacionog vraćanja statusa —
   * status se pomera tek kad su dokumenti sigurno kreirani (nema „POSTED bez/na osnovu starih dok").
   */
  async finalize(
    countId: number,
    userId?: number,
    opts: FinalizeInventoryCountDto = {},
  ) {
    // (1) Konkurentnost: xact advisory lock ovde NE POMAŽE — poziv van transakcije je
    //     autocommit (lock se pusti istog trenutka), a createStockDocument otvara sopstvene
    //     transakcije pa se lock ne može držati kroz ceo tok bez rizičnog refaktora (NIZAK
    //     nalaz). Autoritativni guard od dvostrukog POSTED je CAS na kraju (korak 6) —
    //     gubitnik CAS-a briše dokumente koje je upravo kreirao, pa nema procurelih orphana.

    // (2) Status-guard čitanje.
    const count = await this.prisma.inventoryCount.findUnique({
      where: { id: countId },
      include: { items: { orderBy: { id: "asc" } } },
    });
    if (!count) throw new NotFoundException(`Popis ${countId} ne postoji.`);
    if (count.status === "POSTED")
      throw new ConflictException(
        `Popis ${countId} je već zaključen (POSTED).`,
      );
    if (count.status !== "COUNTING")
      throw new ConflictException(
        `Zaključivanje je moguće samo iz statusa COUNTING (trenutno: ${count.status}).`,
      );

    // Razlika po stavci: RazlikaKol = KolPop − KolKng (doc 39 §D). >0 višak, <0 manjak.
    const surplus: Array<{ itemId: number; quantity: string; price: string }> =
      [];
    const shortage: Array<{ itemId: number; quantity: string; price: string }> =
      [];
    for (const it of count.items) {
      const diff = it.countedQuantity.minus(it.bookQuantity);
      const price = it.price.toFixed(4);
      if (diff.greaterThan(0)) {
        surplus.push({ itemId: it.itemId, quantity: diff.toFixed(6), price });
      } else if (diff.lessThan(0)) {
        // Manjak: u robnom dokumentu ide POZITIVNA količina (znak izlaza vozi kind=MANJAK /
        // DocumentType). Legacy je INSERT-ovao negativnu; 2.0 čuva pozitivno + kind, pa važi
        // guard nedovoljnog stanja (MANJAK smanjuje stanje, doc 39 §D + §C).
        shortage.push({
          itemId: it.itemId,
          quantity: diff.abs().toFixed(6),
          price,
        });
      }
    }

    // (3) Očisti orphan dokumente prethodnog (palog) pokušaja — NE reuse-uj ih (mogu nositi
    //     zastarele količine posle re-brojanja, F2). Bezbedno za brisanje = vezan za OVAJ popis,
    //     kind VISAK/MANJAK, status DRAFT, bez journalEntryId i nekalkulisan (delete kaskadira na
    //     stavke — schema onDelete: Cascade). Nebezbedan (kalkulisan/proknjižen/vezan za nalog)
    //     → 409 (ne diramo automatski; traži ručnu sanaciju).
    const priorDocs = await this.prisma.stockDocument.findMany({
      where: { inventoryCountId: countId, kind: { in: ["VISAK", "MANJAK"] } },
      select: {
        id: true,
        kind: true,
        status: true,
        isCalculated: true,
        journalEntryId: true,
      },
    });
    const unsafe = priorDocs.filter(
      (d) => d.status !== "DRAFT" || d.isCalculated || d.journalEntryId != null,
    );
    if (unsafe.length)
      throw new ConflictException(
        `Popis ${countId} ima dokumente razlike koji su već kalkulisani/proknjiženi ` +
          `(${unsafe.map((d) => `${d.kind} #${d.id}`).join(", ")}); ` +
          `ručno ih storniraj pre ponovnog zaključivanja.`,
      );
    if (priorDocs.length)
      await this.prisma.stockDocument.deleteMany({
        where: { id: { in: priorDocs.map((d) => d.id) } },
      });

    // (4) Kreiraj SVEŽE dokumente iz TEKUĆIH razlika (svaki createStockDocument je sopstvena tx).
    const surplusType =
      opts.surplusDocumentTypeCode?.trim() || DEFAULT_SURPLUS_DOCUMENT_TYPE;
    const shortageType =
      opts.shortageDocumentTypeCode?.trim() || DEFAULT_SHORTAGE_DOCUMENT_TYPE;
    const countDateIso = count.countDate.toISOString();

    let surplusDocumentId: number | null = null;
    let shortageDocumentId: number | null = null;
    if (surplus.length > 0) {
      const doc = await this.robno.createStockDocument("VISAK", {
        documentTypeCode: surplusType,
        warehouseId: count.warehouseId,
        documentDate: countDateIso,
        inventoryCountId: count.id,
        createdByUserId: userId ?? undefined,
        items: surplus.map((s) => ({
          itemId: s.itemId,
          quantity: s.quantity,
          invoicePrice: s.price,
        })),
      });
      surplusDocumentId = doc.data.id;
    }
    if (shortage.length > 0) {
      const doc = await this.robno.createStockDocument("MANJAK", {
        documentTypeCode: shortageType,
        warehouseId: count.warehouseId,
        documentDate: countDateIso,
        inventoryCountId: count.id,
        createdByUserId: userId ?? undefined,
        items: shortage.map((s) => ({
          itemId: s.itemId,
          quantity: s.quantity,
          invoicePrice: s.price,
        })),
      });
      shortageDocumentId = doc.data.id;
    }

    // (5) CAS COUNTING → POSTED — POSLEDNJI korak (dokumenti su sigurno kreirani). Pad pre ovoga
    //     ostavlja COUNTING + DRAFT dokumente koje sledeći pokušaj u koraku (3) počisti (retry-safe).
    const claimed = await this.prisma.inventoryCount.updateMany({
      where: { id: countId, status: "COUNTING" },
      data: { status: "POSTED" },
    });
    if (claimed.count === 0) {
      // Trka (uprkos lock-u): drugi finalize je preuzeo popis dok smo kreirali dokumente. Naši
      // dokumenti su sad orphani, a popis više nije COUNTING pa ih retry ne bi počistio → obriši ih.
      const createdIds = [surplusDocumentId, shortageDocumentId].filter(
        (id): id is number => id != null,
      );
      if (createdIds.length)
        await this.prisma.stockDocument.deleteMany({
          where: { id: { in: createdIds } },
        });
      throw new ConflictException(
        `Popis ${countId} je u međuvremenu promenjen; osveži pa pokušaj ponovo.`,
      );
    }

    this.logger.log(
      `Zaključen popis ${count.countNumber}: VISAK doc=${surplusDocumentId ?? "-"}, MANJAK doc=${shortageDocumentId ?? "-"}.`,
    );
    return {
      data: {
        countId: count.id,
        status: "POSTED",
        // Imena po FE ugovoru (api/inventory.ts FinalizeResult) — visak/manjak dokumenti.
        visakDocId: surplusDocumentId,
        manjakDocId: shortageDocumentId,
      },
    };
  }

  // --------------------------------------------------------------- interno

  /**
   * Artikli sa prometom u magacinu do `asOf` (doc 39 §D predpunjenje) — distinct `item_id` iz
   * `stock_document_items` (KODJ izuzet, `affects_stock`, isti filtri kao costing §C). Sortirano po id.
   */
  private async candidateItemIds(
    warehouseId: number,
    asOf: Date,
  ): Promise<number[]> {
    const rows = await this.prisma.$queryRaw<{ item_id: number }[]>(
      Prisma.sql`
        SELECT DISTINCT sdi.item_id
        FROM stock_document_items sdi
        JOIN stock_documents sd ON sd.id = sdi.document_id
        JOIN document_types dt ON dt.code = sd.document_type_code
        WHERE sdi.warehouse_id = ${warehouseId}
          AND sdi.deleted_at IS NULL -- meko obrisana stavka nije promet (review Batch B)
          AND sd.document_date <= ${asOf}
          AND sd.document_type_code <> 'KODJ'
          AND COALESCE(dt.affects_stock, TRUE) = TRUE
        ORDER BY sdi.item_id
      `,
    );
    return rows.map((r) => r.item_id);
  }

  /**
   * Sledeći broj popisa `NNNN/god` (obrazac `nivelacija.service.nextNivNumber`): advisory-xact lock po
   * (companyId, godina), numerički MAX u JS-u (ne string sort — '999' < '1000'), pad na 4 cifre.
   * Segment = unique ključ `uq_inventory_counts_number` (companyId, year, countNumber).
   */
  private async nextCountNumber(
    tx: Prisma.TransactionClient,
    year: number,
  ): Promise<string> {
    const suffix = `/${year}`;
    const lockKey = `robno:inventory:${COMPANY_ID}:${year}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

    const rows = await tx.inventoryCount.findMany({
      where: { companyId: COMPANY_ID, year, countNumber: { endsWith: suffix } },
      select: { countNumber: true },
    });
    let maxSeq = 0;
    for (const r of rows) {
      const raw = r.countNumber.slice(0, -suffix.length);
      const n = Number.parseInt(raw, 10);
      if (!Number.isNaN(n) && n > maxSeq) maxSeq = n;
    }
    return `${String(maxSeq + 1).padStart(4, "0")}${suffix}`;
  }
}
