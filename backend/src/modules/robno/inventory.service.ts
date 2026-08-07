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
 * Podrazumevana vrsta robnog dokumenta za VIŠAK (doc 39 §D — ROBA): `VISAR`
 * (Sema 46 → duguje 1320 zaliha, potražuje 6740 „Viškovi materijala"). Za magacin
 * materijala klijent prosledi `VISAM` (Sema 41) u telu finalize-a.
 *
 * Višak se KORISTI i potvrđen je: u uvezenoj knjizi 2026 postoji nalog vrste `VISAK`
 * (broj 260119, 19.01.2026) — `1320` duguje 190.168,91 / `6740` potražuje 190.168,91,
 * tačno po šemi 46 (izmereno na produkciji 07.08.2026).
 *
 * ⚠️ MANJKA NEMA — v. `finalize`. Konstanta `DEFAULT_SHORTAGE_DOCUMENT_TYPE = "MANJR"`
 * je uklonjena 07.08.2026. jer dokument manjka po odluci knjigovođe ne postoji.
 */
const DEFAULT_SURPLUS_DOCUMENT_TYPE = "VISAR";

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
   * Detalj popisa (zaglavlje + stavke + id-evi dokumenata razlike).
   *
   * Stavke nose i NAZIV/ŠIFRU/JM artikla (meki ref `items.id`, jedan upit po skupu id-jeva).
   * Bez toga je glavni tab popisa prikazivao samo `#90001` — komisija je brojala robu koju
   * ekran ne imenuje (nalaz §3.10). Tab „Razlike" je to već imao; sada su oba ista.
   *
   * 🔴 `visakDocId`/`manjakDocId` — id-evi VISAK/MANJAK dokumenata koje je napravilo
   * zaključivanje. Do 07.08.2026 ih je vraćao SAMO odgovor `finalize`, a ekran ih je držao
   * u `useState` panela: povratak sa dokumenta viška remontira stranu, stanje se izgubi i
   * dugme za MANJAK nestane — popis koji je dao i višak i manjak ostavljao je magacionera
   * bez ijednog puta do drugog dokumenta. Izvor istine je baza, ne pregledač: veza
   * `stock_documents.inventory_count_id` postoji od početka (upisuje je `finalize`), pa
   * detalj samo mora da je pročita.
   *
   * Uzima se NAJVEĆI id po vrsti (`orderBy: desc` + prvi pogodak). Ne zato što
   * `finalize` ume da napravi dva — CAS na statusu (COUNTING → POSTED) to ne dopušta, a
   * pre svakog pokušaja se bezbedni dokumenti palog prethodnog pokušaja i obrišu.
   * Duplikat dolazi DRUGIM putem: veza je obično polje na dokumentu, pa je `POST
   * /robno/documents` sa `inventoryCountId` u telu (`CreateStockDocumentDto`) sme upisati
   * ručno, koliko god puta. Za takav slučaj nema „tačnog" odgovora — bira se najskoriji,
   * jer je to ono što je korisnik poslednje napravio.
   *
   * ⚠️ Indeks: `stock_documents (inventory_count_id, kind) WHERE inventory_count_id IS NOT
   * NULL` — parcijalni, SQL-only (migracija 20260807120000), kao `uq_stock_documents_po`.
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

    const razlikeDocs = await this.prisma.stockDocument.findMany({
      where: { inventoryCountId: id, kind: { in: ["VISAK", "MANJAK"] } },
      select: { id: true, kind: true },
      orderBy: { id: "desc" },
    });

    return {
      data: {
        ...count,
        // Imena po FE ugovoru (api/inventory.ts) — ista kao u odgovoru `finalize`.
        visakDocId: razlikeDocs.find((d) => d.kind === "VISAK")?.id ?? null,
        manjakDocId: razlikeDocs.find((d) => d.kind === "MANJAK")?.id ?? null,
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
   * Zaključi popis: kreiraj robni dokument VIŠKA (diff>0) kroz POSTOJEĆI
   * `RobnoService.createStockDocument`, pa CAS COUNTING → POSTED kao POSLEDNJI korak.
   * `inventoryCountId` vezuje dokument za popis. Već POSTED → 409 (idempotencija).
   *
   * 🔴 MANJAK ZAUSTAVLJA ZAKLJUČIVANJE — DOKUMENT MANJKA NE POSTOJI (07.08.2026)
   * ═══════════════════════════════════════════════════════════════════════════════
   * ODGOVOR KNJIGOVOĐE, doslovno: **„kada se utvrdi da je popisano manje nego što knjige kažu
   * onda to ne radimo kroz dokument manjak. Takav dokument ne treba da postoji"**.
   *
   * Do ove izmene je zaključivanje samo od sebe pravilo dokument vrste `MANJR`. Zašto to nije
   * bila bezopasna pogodnost, nego pogrešno knjiženje — šema 50 (`MANJR`) sa produkcije glasi:
   *     1320 potražuje A · 4700 potražuje P · 6040 potražuje A · 5010 duguje A · 5741 duguje A+P
   * Dakle manjak u starom programu NIJE prosto smanjenje zalihe: nosi i **izlazni PDV** (`4700`)
   * i rashod „Manjovi robe" (`5741`) — to je poreski tretman manjka iznad normativa (manjak se
   * oporezuje kao promet). Popisna komisija taj tretman ne sme da odluči klikom na „Zaključi";
   * to je odluka knjigovođe po svakom pojedinačnom slučaju (kalo/rastur `5112`, otpis `OTPIR`
   * šema 53, teret odgovornog lica…).
   *
   * IZMERENO NA PRODUKCIJI (07.08.2026, uvezena knjiga 2026): **nijedan manjak nije proknjižen**
   * — konta `5740` („Manjkovi materijala") i `5741` („Manjovi robe") postoje u kontnom planu ali
   * imaju NULA stavki, a među 41 vrstom naloga nema nijednog `MANJR`/`MANJM`. Višak ima tačno
   * jedan nalog. Stari program se, dakle, ponašao isto kao ova odluka.
   *
   * ZAŠTO ODBIJANJE, A NE „prođi bez ijednog dokumenta": otvoreno pitanje — šta onda spušta
   * knjigovodstveno stanje na popisano — knjigovođa NIJE odgovorio. Tiho zaključenje bi popis
   * proglasilo gotovim, a zalihe ostavilo netačnim (knjige i dalje pokazuju robu koje nema) i
   * to bez ijednog traga da nešto nije razrešeno. Odbijanje je vidljivo, ne pravi nijedan
   * pogrešan zapis i ostavlja popis u `COUNTING` da se manjak razreši (ponovno brojanje,
   * ispravka knjiženja koje ga je izazvalo, ili dokument otpisa koji knjigovođa odobri) — pa se
   * zaključivanje ponovi. Kad odgovor stigne, ovde se dodaje TAJ put; do tada se ne izmišlja.
   *
   * Redosled (retry-safe; obrazac lock-a iz posting.service 4001):
   *   (1) advisory xact lock po popisu (namespace 4002) — serijalizuje paralelne finalize;
   *   (2) status-guard čitanje (mora COUNTING);
   *   (3) BRANA MANJKA — pre ijedne izmene, da odbijen popis ne ostavi nijedan trag;
   *   (4) čišćenje orphan VISAK/MANJAK dokumenata prethodnog (palog) pokušaja — bez reuse
   *       zastarelih količina (F2): bezbedne (DRAFT, bez naloga, nekalkulisane) se BRIŠU, a
   *       nebezbedne (kalkulisane/proknjižene) → 409 (ručna sanacija). `MANJAK` ostaje u filteru
   *       zbog dokumenata koje je napravila starija verzija ovog koda;
   *   (5) kreiranje svežeg VISAK dokumenta iz TEKUĆIH razlika;
   *   (6) CAS COUNTING → POSTED kao poslednji korak.
   *
   * Pad pre koraka (6) ostavlja popis u COUNTING + eventualni DRAFT dokument; retry ga u koraku
   * (4) obriše i kreira novi iz aktuelnih količina. Zato NEMA kompenzacionog vraćanja statusa —
   * status se pomera tek kad je dokument sigurno kreiran (nema „POSTED bez/na osnovu starih dok").
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
    const shortageItems: Array<{ itemId: number; diff: Prisma.Decimal }> = [];
    for (const it of count.items) {
      const diff = it.countedQuantity.minus(it.bookQuantity);
      const price = it.price.toFixed(4);
      if (diff.greaterThan(0)) {
        surplus.push({ itemId: it.itemId, quantity: diff.toFixed(6), price });
      } else if (diff.lessThan(0)) {
        shortageItems.push({ itemId: it.itemId, diff });
      }
    }

    // (3) BRANA MANJKA — pre ijedne izmene (v. blok iznad: dokument manjka ne postoji).
    //     Poruka imenuje artikle da se manjak može razrešiti bez kopanja po tabu „Razlike";
    //     spisak je skraćen na 5 da odgovor ostane čitljiv i kad popis ima stotine stavki.
    if (shortageItems.length > 0) {
      const meta = await this.prisma.item.findMany({
        where: { id: { in: shortageItems.slice(0, 5).map((s) => s.itemId) } },
        select: { id: true, name: true, catalogNumber: true },
      });
      const imeById = new Map(meta.map((m) => [m.id, m]));
      const spisak = shortageItems
        .slice(0, 5)
        .map((s) => {
          const m = imeById.get(s.itemId);
          const ime = m
            ? `${m.catalogNumber ?? m.id} ${m.name ?? ""}`.trim()
            : `#${s.itemId}`;
          return `${ime} (manjak ${s.diff.abs().toFixed(3)})`;
        })
        .join(", ");
      const ostatak =
        shortageItems.length > 5 ? ` i još ${shortageItems.length - 5}` : "";

      throw new UnprocessableEntityException(
        `Popis ${count.countNumber} ne može da se zaključi: ${shortageItems.length} ` +
          `${shortageItems.length === 1 ? "artikal ima" : "artikala ima"} manje nego što ` +
          `knjige kažu — ${spisak}${ostatak}. Dokument manjka se NE pravi (odluka knjigovođe ` +
          `od 07.08.2026: „kada se utvrdi da je popisano manje nego što knjige kažu, onda to ` +
          `ne radimo kroz dokument manjak; takav dokument ne treba da postoji"). ` +
          `KAKO SE RAZREŠAVA: roba koja fizički nije na polici razdužuje se TREBOVANJEM na ` +
          `radni nalog (vlasnik, 07.08.2026: „mi istrebujemo na neki nalog tu robu i zato ne ` +
          `radimo [manjak]"). Napravi trebovanje za tu količinu, pa ponovi zaključenje — tada ` +
          `se knjige i popis poklapaju sami. Ako roba stvarno nedostaje a nije utrošena, način ` +
          `otpisa određuje knjigovođa. Popis ostaje otvoren (COUNTING) dok se to ne uradi. ` +
          `Višak se knjiži normalno i ne smeta zaključivanju.`,
      );
    }

    // (4) Očisti orphan dokumente prethodnog (palog) pokušaja — NE reuse-uj ih (mogu nositi
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

    // (5) Kreiraj SVEŽ dokument viška iz TEKUĆIH razlika (createStockDocument je sopstvena tx).
    //     Manjka ovde više ne može biti — brana u koraku (3) je zaustavila takav popis.
    const surplusType =
      opts.surplusDocumentTypeCode?.trim() || DEFAULT_SURPLUS_DOCUMENT_TYPE;
    const countDateIso = count.countDate.toISOString();

    let surplusDocumentId: number | null = null;
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

    // (6) CAS COUNTING → POSTED — POSLEDNJI korak (dokument je sigurno kreiran). Pad pre ovoga
    //     ostavlja COUNTING + DRAFT dokument koji sledeći pokušaj u koraku (4) počisti (retry-safe).
    const claimed = await this.prisma.inventoryCount.updateMany({
      where: { id: countId, status: "COUNTING" },
      data: { status: "POSTED" },
    });
    if (claimed.count === 0) {
      // Trka (uprkos lock-u): drugi finalize je preuzeo popis dok smo kreirali dokument. Naš
      // dokument je sad orphan, a popis više nije COUNTING pa ga retry ne bi počistio → obriši ga.
      if (surplusDocumentId != null)
        await this.prisma.stockDocument.deleteMany({
          where: { id: surplusDocumentId },
        });
      throw new ConflictException(
        `Popis ${countId} je u međuvremenu promenjen; osveži pa pokušaj ponovo.`,
      );
    }

    this.logger.log(
      `Zaključen popis ${count.countNumber}: VISAK doc=${surplusDocumentId ?? "-"} (manjka nema — brana).`,
    );
    return {
      data: {
        countId: count.id,
        status: "POSTED",
        // Imena po FE ugovoru (api/inventory.ts FinalizeResult). `manjakDocId` OSTAJE u
        // odgovoru i uvek je `null`: FE ga i dalje čita (`count-detail.tsx`), a `get()` ga
        // popunjava iz baze za popise koje je zaključila starija verzija ovog koda.
        visakDocId: surplusDocumentId,
        manjakDocId: null,
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
