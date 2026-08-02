import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { PricingService } from "./pricing.service";
import { assertVatPeriodNotLocked } from "../pdv/vat-period-lock";
import type { AuthUser } from "../auth/jwt.strategy";
import {
  type CreateInvoiceItemDto,
  type UpdateInvoiceHeaderDto,
  type UpdateInvoiceItemDto,
  type ValidatedInvoiceHeaderPatch,
  validateCreateInvoiceItem,
  validateUpdateInvoiceHeader,
  validateUpdateInvoiceItem,
} from "./dto/update-invoice.dto";

/**
 * SalesService — IZMENA prodajnog dokumenta (zaglavlje + stavke).
 * =========================================================================
 * ZAŠTO POSTOJI: do sada je dokument mogao da se NAPRAVI (`FakturisanjeService.
 * createProforma`, `DocumentCarryOverService`) i da se PROKNJIŽI/STORNIRA, ali
 * nije mogao da se ISPRAVI — modul nije imao nijednu PATCH/PUT/DELETE rutu.
 * Greška u kucanju je značila „napravi nov dokument", što je u BigBitu bila
 * jedna tipka. To je bila glavna zamerka vlasnika.
 *
 * PODELA POSLA (namerno, da se ne dira tuđa granica):
 *   FakturisanjeService — kreiranje predračuna, knjiženje (level 0), storno,
 *   AdvanceInvoiceService — avansi (AVR),
 *   SalesService (ovaj)  — izmena DOK JE DOKUMENT NACRT.
 *
 * ČETIRI BRANE (nijedna nije opciona):
 *
 *  B1 — NACRT ILI NIŠTA. Proknjižen (`status ≠ DRAFT`) ili tehnički zaključan
 *       (`isLocked`) dokument se NE menja: 409 sa uputstvom ŠTA da se uradi
 *       (protivdokument / storno). Provera se ponavlja i kao CAS `updateMany`
 *       U TRANSAKCIJI — čitanje pa provera pušta paralelno knjiženje između
 *       ta dva koraka (isti obrazac kao `postInvoice` claim).
 *
 *  B2 — ZAKLJUČAN PDV PERIOD. `assertVatPeriodNotLocked` nad EFEKTIVNIM datumom
 *       dokumenta (novi ako se menja, inače postojeći). Dokument koji bi završio
 *       u periodu sa predatim PDV obračunom se ne dira.
 *
 *  B3 — ZBIROVI SE UVEK PRERAČUNAVAJU. Posle svake izmene stavke
 *       `netTotal/vatTotal/grossTotal` se čitaju IZ BAZE i sabiraju ponovo
 *       (`recalcTotals`), u istoj transakciji. Nema inkrementalnog dodavanja.
 *
 *  B4 — KOEFICIJENT JE PONOVLJIV (§8/O1). Stavka pamti `baseUnitPrice`;
 *       `unitPrice = baseUnitPrice × Invoice.priceCoefficient` je IZVEDENO i
 *       nikad se ne upisuje pomnoženo nad samim sobom. Zato dva uzastopna
 *       poziva sa istim koeficijentom daju identičan rezultat, koeficijent sme
 *       da se ispravi i sme da se vrati na 1. U BigBitu je „primeni pa upiši"
 *       nepovratno — drugi klik pomnoži već pomnoženo.
 *
 * RAČUNAR CENE JE JEDAN: `PricingService.priceItem`. Ovaj servis ne sadrži
 * nijednu svoju formulu za rabat/PDV — čak i izvođenje `base × koeficijent`
 * ide kroz `priceItem` (override cena + rabat 0 + kasa 0), da tabela poreskih
 * stopa ostane na jednom mestu. Taj poziv ne dira bazu (bez `itemId`, sa
 * override cenom i eksplicitnim rabatom nema nijednog upita), pa je bezbedan i
 * unutar transakcije.
 */

const D = Prisma.Decimal;
const ZERO = new D(0);
const ONE = new D(1);

/** Skala novčanih kolona (`Decimal(19,4)`) — zaokruženje na granici upisa. */
const MONEY_SCALE = 4;
const ROUND_HALF_UP = Prisma.Decimal.ROUND_HALF_UP;

/** Status u kome je dokument NACRT (jedini u kome se sme menjati). */
const STATUS_DRAFT = "DRAFT";
const STATUS_CANCELLED = "CANCELLED";

/** Zaglavlje koje brane čitaju (bez stavki — one se čitaju posebno). */
interface EditableInvoice {
  id: number;
  documentType: string;
  documentNumber: string;
  status: string;
  isLocked: boolean;
  level: number;
  customerId: number | null;
  documentDate: Date;
  isExport: boolean;
  priceCoefficient: Prisma.Decimal;
}

/** Sve što jedna stavka nosi kao rezultat računa (spremno za upis). */
interface ComputedLine {
  baseUnitPrice: Prisma.Decimal;
  /**
   * Cena PRE rabata (v. `schema.prisma`) — nosi se kroz SVAKI upis stavke, i onaj koji
   * cenu ne preračunava. Kad bi je izostavila samo jedna grana (npr. izmena količine),
   * ta izmena bi je obrisala i papir bi opet ostao bez pune cene.
   */
  unitPriceBeforeDiscount: Prisma.Decimal | null;
  unitPrice: Prisma.Decimal;
  discountPercent: Prisma.Decimal;
  cashDiscountPercent: Prisma.Decimal;
  vatRateCode: string;
  vatBase: Prisma.Decimal;
  vatAmount: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
}

/** Zaokruži na skalu novčane kolone (upis u DB bi to ionako uradio). */
function money(value: Prisma.Decimal): Prisma.Decimal {
  return value.toDecimalPlaces(MONEY_SCALE, ROUND_HALF_UP);
}

/**
 * OSNOVICA ZA KOEFICIJENT — `baseUnitPrice` ako postoji, inače zatečena `unitPrice`.
 *
 * ZAŠTO REZERVA POSTOJI (nalaz adversarnog pregleda 28.07.2026, KRITIČNO)
 * ─────────────────────────────────────────────────────────────────────────
 * `base_unit_price` ima `DEFAULT 0`, a migracija je backfill-ovala samo redove
 * zatečene U TRENUTKU primene. Svaki dokument koji posle toga napravi neki DRUGI
 * pisac (`createProforma`, prepis dokumenta) dobija `unitPrice` = stvarna cena i
 * `baseUnitPrice` = 0. Da izvođenje slepo veruje koloni, prvi dodir takve stavke
 * — obična izmena količine ili primena koeficijenta — spustio bi cenu i zbirove
 * na NULU. Nije teorija: pregled je to izvršio nad pravim dokumentom.
 *
 * Backfill i dopuna svih pisaca (urađeni su i jedno i drugo) rešavaju ZATEČENO
 * stanje i DANAŠNJE pisce. Ova rezerva rešava SVAKOG BUDUĆEG pisca koji zaboravi
 * na kolonu — invarijanta se drži na mestu gde se čita, ne na svakom mestu gde se
 * piše. Cena dokumenta je previše skupa da visi o disciplini.
 *
 * Zašto je poređenje sa nulom, a ne `null`: kolona je `NOT NULL DEFAULT 0`, pa
 * „nije upisano" i „upisano je nula" izgledaju isto. Stavka sa stvarnom cenom 0
 * kroz rezervu daje opet 0 — ishod je tačan u oba čitanja, pa dvosmislenost ne
 * škodi.
 */
export function resolveBaseUnitPrice(
  baseUnitPrice: Prisma.Decimal | null | undefined,
  currentUnitPrice?: Prisma.Decimal | null,
): Prisma.Decimal {
  if (baseUnitPrice && baseUnitPrice.greaterThan(ZERO)) return money(baseUnitPrice);
  if (currentUnitPrice && currentUnitPrice.greaterThan(ZERO)) {
    return money(currentUnitPrice);
  }
  return ZERO;
}

/**
 * Godina iz repa broja dokumenta (`PROF0001/2026` → 2026). `null` za nacrte iz
 * prepisa (`DRAFT-12`) koji još nemaju definitivan broj.
 */
function yearFromDocumentNumber(documentNumber: string): number | null {
  const match = /\/(\d{2,4})\s*$/.exec(documentNumber);
  if (!match) return null;
  const raw = Number.parseInt(match[1], 10);
  if (Number.isNaN(raw)) return null;
  return raw < 100 ? 2000 + raw : raw;
}

@Injectable()
export class SalesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pricing: PricingService,
  ) {}

  // ── ZAGLAVLJE ──────────────────────────────────────────────────────────────

  /**
   * Izmena zaglavlja nacrta: datum, komitent, valuta, kursevi, rok plaćanja,
   * datum prometa, napomena, broj narudžbenice, poziv na broj, profil stavki i
   * KOEFICIJENT CENE.
   *
   * Kad telo nosi `priceCoefficient`, SVE stavke se prevode na
   * `unitPrice = baseUnitPrice × koeficijent` (B4) i zbirovi se preračunavaju.
   * Ponovljivo: isti koeficijent poslat dva puta daje isti dokument.
   */
  async updateHeader(id: number, dto: UpdateInvoiceHeaderDto, actor: AuthUser) {
    const patch = validateUpdateInvoiceHeader(dto ?? {});
    const invoice = await this.loadEditable(id);

    // B2 — brava PDV perioda nad EFEKTIVNIM datumom (novi ako se menja).
    const effectiveDate = patch.documentDate ?? invoice.documentDate;
    await this.assertVatPeriodOpen(effectiveDate);

    // Datum ne sme da preskoči u drugu godinu na dokumentu koji VEĆ nosi broj
    // iz godišnjeg niza — broj i datum bi se razišli (`PROF0001/2026` sa datumom
    // 2027), a numeracija je po (vrsta, godina, firma).
    if (patch.documentDate) {
      const numberYear = yearFromDocumentNumber(invoice.documentNumber);
      const newYear = patch.documentDate.getFullYear();
      if (numberYear != null && numberYear !== newYear) {
        throw new ConflictException(
          `Dokument ${invoice.documentNumber} nosi broj iz niza za ${numberYear}. ` +
            `godinu — datum se ne sme prebaciti u ${newYear}. Napravi nov dokument ` +
            `u toj godini.`,
        );
      }
    }

    if (patch.customerId !== undefined) {
      const customer = await this.prisma.customer.findUnique({
        where: { id: patch.customerId },
        select: { id: true },
      });
      if (!customer) {
        throw new NotFoundException(`Kupac ${patch.customerId} ne postoji.`);
      }
    }

    const coefficient = patch.priceCoefficient;

    return this.prisma.$transaction(async (tx) => {
      // B1 (CAS) — izmena i provera „još je nacrt" su JEDNA operacija.
      const claimed = await tx.invoice.updateMany({
        where: { id, status: STATUS_DRAFT, isLocked: false },
        data: this.headerUpdateData(patch, coefficient, actor),
      });
      if (claimed.count !== 1) {
        throw new ConflictException(
          `Dokument ${invoice.documentNumber} je u međuvremenu proknjižen ili ` +
            `zaključan — izmena nije sačuvana.`,
        );
      }

      // B4 — koeficijent se PRIMENJUJE na stavke (izvedeno iz baseUnitPrice).
      if (coefficient) {
        await this.applyCoefficient(tx, id, coefficient, invoice.isExport);
      }

      // B3 — zbirovi uvek iz stavki.
      await this.recalcTotals(tx, id);
      return this.loadWithItems(tx, id);
    });
  }

  // ── STAVKE ─────────────────────────────────────────────────────────────────

  /** Dodaj stavku na nacrt. `lineNo` = sledeći slobodan redni broj. */
  async addItem(id: number, dto: CreateInvoiceItemDto, actor: AuthUser) {
    const input = validateCreateInvoiceItem(
      dto ?? ({} as CreateInvoiceItemDto),
    );
    const invoice = await this.loadEditable(id);
    await this.assertVatPeriodOpen(invoice.documentDate);

    if (input.itemId != null) await this.assertItemExists(input.itemId);

    // Cena se računa VAN transakcije (PricingService čita cenovnik/rabate) —
    // isti obrazac kao `createProforma`.
    const line = await this.computeLine({
      invoice,
      itemId: input.itemId,
      quantity: input.quantity,
      basePriceOverride: input.basePriceOverride,
      discountPercent: input.discountPercent,
      cashDiscountPercent: input.cashDiscountPercent,
      vatRateCode: input.vatRateCode,
    });

    return this.prisma.$transaction(async (tx) => {
      await this.claimDraft(tx, invoice, actor);

      const last = await tx.invoiceItem.findFirst({
        where: { invoiceId: id },
        orderBy: { lineNo: "desc" },
        select: { lineNo: true },
      });

      await tx.invoiceItem.create({
        data: {
          invoiceId: id,
          lineNo: (last?.lineNo ?? 0) + 1,
          itemId: input.itemId,
          description: input.description,
          quantity: input.quantity,
          ...line,
        },
      });

      await this.recalcTotals(tx, id);
      return this.loadWithItems(tx, id);
    });
  }

  /**
   * Izmena stavke nacrta.
   *
   * CENA SE PRERAČUNAVA SAMO KAD JE TRAŽENA (`repriceRequested`): telo koje nosi
   * artikal, cenu, rabat, kasu ili PDV šifru ide ponovo kroz `PricingService`.
   * Telo koje menja samo količinu/opis ZADRŽAVA zapamćenu `baseUnitPrice` —
   * inače bi ispravka količine tiho pregazila dogovorenu cenu današnjim
   * cenovnikom.
   */
  async updateItem(
    id: number,
    lineId: number,
    dto: UpdateInvoiceItemDto,
    actor: AuthUser,
  ) {
    const patch = validateUpdateInvoiceItem(dto ?? {});
    const invoice = await this.loadEditable(id);
    await this.assertVatPeriodOpen(invoice.documentDate);

    const existing = await this.loadItem(id, lineId);
    const itemId = patch.itemId !== undefined ? patch.itemId : existing.itemId;
    if (patch.itemId != null) await this.assertItemExists(patch.itemId);

    const quantity = patch.quantity ?? existing.quantity;

    let line: ComputedLine;
    if (patch.repriceRequested) {
      // Slobodna (uslužna) stavka nema cenovnik: preračun rabata bez zadate cene
      // bi joj oborio cenu na 0. Bolje odbiti nego tiho obrisati novac.
      if (itemId == null && patch.basePriceOverride === undefined) {
        throw new UnprocessableEntityException(
          `Stavka ${lineId} nema artikal iz šifarnika, pa nema ni cenovnik — uz ` +
            `izmenu rabata/kase/PDV šifre pošalji i cenu (polje unitPrice).`,
        );
      }
      line = await this.computeLine({
        invoice,
        itemId,
        quantity,
        basePriceOverride: patch.basePriceOverride,
        discountPercent: patch.discountPercent ?? existing.discountPercent,
        cashDiscountPercent:
          patch.cashDiscountPercent ?? existing.cashDiscountPercent,
        vatRateCode: patch.vatRateCode ?? existing.vatRateCode,
      });
    } else {
      // Cena ostaje ista (bazna!), menjaju se samo izvedeni iznosi za novu količinu.
      line = await this.deriveFromBase({
        baseUnitPrice: existing.baseUnitPrice,
        currentUnitPrice: existing.unitPrice,
        // Cena se ne preračunava → puna cena se PRENOSI sa zatečene stavke. Bez ovoga
        // bi ispravka količine obrisala jedini trag cene pre rabata.
        unitPriceBeforeDiscount: existing.unitPriceBeforeDiscount,
        quantity,
        vatRateCode: existing.vatRateCode,
        discountPercent: existing.discountPercent,
        cashDiscountPercent: existing.cashDiscountPercent,
        coefficient: invoice.priceCoefficient,
        isExport: invoice.isExport,
      });
    }

    return this.prisma.$transaction(async (tx) => {
      await this.claimDraft(tx, invoice, actor);

      await tx.invoiceItem.update({
        where: { id: lineId },
        data: {
          ...(patch.itemId !== undefined ? { itemId: patch.itemId } : {}),
          ...(patch.description !== undefined
            ? { description: patch.description }
            : {}),
          quantity,
          ...line,
        },
      });

      await this.recalcTotals(tx, id);
      return this.loadWithItems(tx, id);
    });
  }

  /**
   * Obriši stavku nacrta. Preostale stavke se prenumerišu (1..n) da štampa ne
   * bi imala rupe u rednom broju; `copiedFromItemId` (dedup carry-over) ide po
   * id-u, ne po `lineNo`, pa prenumeracija ništa ne kvari.
   */
  async removeItem(id: number, lineId: number, actor: AuthUser) {
    const invoice = await this.loadEditable(id);
    await this.assertVatPeriodOpen(invoice.documentDate);
    await this.loadItem(id, lineId);

    return this.prisma.$transaction(async (tx) => {
      await this.claimDraft(tx, invoice, actor);

      await tx.invoiceItem.delete({ where: { id: lineId } });

      const rest = await tx.invoiceItem.findMany({
        where: { invoiceId: id },
        orderBy: { lineNo: "asc" },
        select: { id: true, lineNo: true },
      });
      for (let i = 0; i < rest.length; i += 1) {
        if (rest[i].lineNo !== i + 1) {
          await tx.invoiceItem.update({
            where: { id: rest[i].id },
            data: { lineNo: i + 1 },
          });
        }
      }

      await this.recalcTotals(tx, id);
      return this.loadWithItems(tx, id);
    });
  }

  // ── BRANE ──────────────────────────────────────────────────────────────────

  /** Učitaj dokument i primeni B1 (nacrt ili ništa). */
  private async loadEditable(id: number): Promise<EditableInvoice> {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id },
      select: {
        id: true,
        documentType: true,
        documentNumber: true,
        status: true,
        isLocked: true,
        level: true,
        customerId: true,
        documentDate: true,
        isExport: true,
        priceCoefficient: true,
      },
    });
    if (!invoice) throw new NotFoundException(`Dokument ${id} ne postoji.`);
    this.assertEditable(invoice);
    return invoice;
  }

  /**
   * B1 — dokument mora biti NACRT. Poruka ne kaže samo „ne može", nego ŠTA da se
   * uradi: proknjižen se ispravlja protivdokumentom (knjižno odobrenje/zaduženje)
   * ili stornom pa novim dokumentom; storniran se ne oživljava.
   */
  private assertEditable(invoice: EditableInvoice): void {
    if (invoice.status === STATUS_CANCELLED) {
      throw new ConflictException(
        `Dokument ${invoice.documentNumber} je storniran — izmena nije moguća. ` +
          `Napravi nov dokument.`,
      );
    }
    if (invoice.status !== STATUS_DRAFT) {
      throw new ConflictException(
        `Dokument ${invoice.documentNumber} je proknjižen (status ${invoice.status}) — ` +
          `ispravka ide protivdokumentom: knjižno odobrenje (umanjenje) ili knjižno ` +
          `zaduženje (uvećanje). Poništenje u celini ide stornom ` +
          `(POST /v1/sales/invoices/${invoice.id}/storno), pa novim dokumentom.`,
      );
    }
    if (invoice.isLocked) {
      throw new ConflictException(
        `Dokument ${invoice.documentNumber} je zaključan — izmena nije moguća. ` +
          `Otključavanje ide stornom (POST /v1/sales/invoices/${invoice.id}/storno), ` +
          `pa novim dokumentom.`,
      );
    }
  }

  /**
   * B1 u transakciji (CAS). Čitanje pa provera (`loadEditable`) je snapshot —
   * paralelno knjiženje između čitanja i upisa bi promenilo proknjižen dokument.
   * `updateMany` sa uslovom u WHERE je jedini izvor ekskluzivnosti; usput
   * upisuje i trag ko je menjao.
   */
  private async claimDraft(
    tx: Prisma.TransactionClient,
    invoice: EditableInvoice,
    actor: AuthUser,
  ): Promise<void> {
    const claimed = await tx.invoice.updateMany({
      where: { id: invoice.id, status: STATUS_DRAFT, isLocked: false },
      data: { updatedByUserId: actor?.userId ?? null },
    });
    if (claimed.count !== 1) {
      throw new ConflictException(
        `Dokument ${invoice.documentNumber} je u međuvremenu proknjižen ili ` +
          `zaključan — izmena nije sačuvana.`,
      );
    }
  }

  /** B2 — u zaključan (predat) PDV period se ne dira. */
  private async assertVatPeriodOpen(date: Date): Promise<void> {
    await assertVatPeriodNotLocked(this.prisma, date.getFullYear(), [
      date.getMonth() + 1,
    ]);
  }

  private async assertItemExists(itemId: number): Promise<void> {
    const item = await this.prisma.item.findUnique({
      where: { id: itemId },
      select: { id: true },
    });
    if (!item) throw new NotFoundException(`Artikal ${itemId} ne postoji.`);
  }

  /** Stavka mora postojati I pripadati baš ovom dokumentu (IDOR brana). */
  private async loadItem(invoiceId: number, lineId: number) {
    const item = await this.prisma.invoiceItem.findUnique({
      where: { id: lineId },
      select: {
        id: true,
        invoiceId: true,
        itemId: true,
        quantity: true,
        baseUnitPrice: true,
        unitPriceBeforeDiscount: true,
        unitPrice: true,
        discountPercent: true,
        cashDiscountPercent: true,
        vatRateCode: true,
      },
    });
    if (!item || item.invoiceId !== invoiceId) {
      throw new NotFoundException(
        `Stavka ${lineId} ne postoji na dokumentu ${invoiceId}.`,
      );
    }
    return item;
  }

  // ── RAČUN ──────────────────────────────────────────────────────────────────

  /**
   * Puna cena stavke: cenovnik/override → rabat → kap → kasa (sve u
   * `PricingService`), pa koeficijent dokumenta (B4).
   */
  private async computeLine(params: {
    invoice: EditableInvoice;
    itemId: number | null;
    quantity: Prisma.Decimal;
    basePriceOverride?: Prisma.Decimal;
    discountPercent?: Prisma.Decimal;
    cashDiscountPercent?: Prisma.Decimal;
    vatRateCode?: string;
  }): Promise<ComputedLine> {
    const priced = await this.pricing.priceItem({
      customerId: params.invoice.customerId,
      itemId: params.itemId,
      quantity: params.quantity,
      documentType: params.invoice.documentType,
      requestedDiscountPercent: params.discountPercent,
      cashDiscountPercent: params.cashDiscountPercent,
      overrideUnitPrice: params.basePriceOverride,
      vatRateCode: params.vatRateCode,
    });

    // §8/O1: ono što je došlo iz cenovnika / prekucao operater (posle rabata i
    // kase) je BAZNA cena stavke — koeficijent se na nju množi tek u izvođenju.
    return this.deriveFromBase({
      baseUnitPrice: priced.unitPrice,
      // Cena PRE rabata ide u bazu SAMO odavde — `deriveFromBase` je ne izvodi (iz cene
      // posle rabata se ne može izvesti kad je rabat 100 %), nego je prosleđuje dalje.
      unitPriceBeforeDiscount: priced.unitPriceBeforeDiscount,
      quantity: params.quantity,
      vatRateCode: priced.vatRateCode,
      discountPercent: priced.discountPercent,
      cashDiscountPercent: priced.cashDiscountPercent,
      coefficient: params.invoice.priceCoefficient,
      isExport: params.invoice.isExport,
    });
  }

  /**
   * IZVOĐENJE (B4): `unitPrice = baseUnitPrice × koeficijent`, pa osnovica i PDV
   * kroz isti `PricingService` (override cena, rabat 0, kasa 0 — jer je rabat već
   * sadržan u baznoj ceni). Ovaj poziv NE dira bazu, pa sme i unutar transakcije.
   *
   * Izvoz: PDV se ne obračunava (kategorija Z / čl. 24) — šifra stope pada na "0",
   * kao u `createProforma`.
   */
  private async deriveFromBase(params: {
    baseUnitPrice: Prisma.Decimal;
    /**
     * Zatečena `unitPrice` iste stavke — REZERVNA osnovica kad `baseUnitPrice`
     * nije upisana (v. `resolveBaseUnitPrice`). Izostavlja se samo kad se stavka
     * tek pravi, jer tada zatečene cene ni nema.
     */
    currentUnitPrice?: Prisma.Decimal | null;
    /**
     * Cena PRE rabata — PROLAZI kroz izvođenje nedirnuta. Ona je, kao i `baseUnitPrice`,
     * na nivou PRE koeficijenta, pa je koeficijent ne menja; štampa je množi koeficijentom
     * dokumenta isto kao što se i `unitPrice` izvodi. `null` = stavka starija od kolone.
     */
    unitPriceBeforeDiscount?: Prisma.Decimal | null;
    quantity: Prisma.Decimal;
    vatRateCode: string;
    discountPercent: Prisma.Decimal;
    cashDiscountPercent: Prisma.Decimal;
    coefficient: Prisma.Decimal;
    isExport: boolean;
  }): Promise<ComputedLine> {
    const baseUnitPrice = resolveBaseUnitPrice(
      params.baseUnitPrice,
      params.currentUnitPrice,
    );
    const coefficient = params.coefficient ?? ONE;
    const unitPrice = money(baseUnitPrice.mul(coefficient));
    const vatRateCode = params.isExport ? "0" : params.vatRateCode;

    const derived = await this.pricing.priceItem({
      quantity: params.quantity,
      overrideUnitPrice: unitPrice,
      requestedDiscountPercent: ZERO,
      cashDiscountPercent: ZERO,
      vatRateCode,
    });

    const vatBase = money(derived.vatBase);
    const vatAmount = money(derived.vatAmount);
    return {
      baseUnitPrice,
      unitPriceBeforeDiscount: params.unitPriceBeforeDiscount ?? null,
      unitPrice,
      discountPercent: params.discountPercent,
      cashDiscountPercent: params.cashDiscountPercent,
      vatRateCode,
      vatBase,
      vatAmount,
      lineTotal: vatBase.add(vatAmount),
    };
  }

  /**
   * B4 — prevedi SVE stavke na novi koeficijent. Idempotentno: polazi uvek od
   * `baseUnitPrice` (koja se ne menja), nikad od tekuće `unitPrice`.
   */
  private async applyCoefficient(
    tx: Prisma.TransactionClient,
    invoiceId: number,
    coefficient: Prisma.Decimal,
    isExport: boolean,
  ): Promise<void> {
    const items = await tx.invoiceItem.findMany({
      where: { invoiceId },
      orderBy: { lineNo: "asc" },
      select: {
        id: true,
        quantity: true,
        baseUnitPrice: true,
        unitPriceBeforeDiscount: true,
        unitPrice: true,
        discountPercent: true,
        cashDiscountPercent: true,
        vatRateCode: true,
      },
    });

    for (const item of items) {
      const line = await this.deriveFromBase({
        baseUnitPrice: item.baseUnitPrice,
        currentUnitPrice: item.unitPrice,
        // Koeficijent ne dira punu cenu (obe su na nivou PRE koeficijenta) — zato se
        // prenosi nedirnuta i primena koeficijenta ostaje ponovljiva (B4).
        unitPriceBeforeDiscount: item.unitPriceBeforeDiscount,
        quantity: item.quantity,
        vatRateCode: item.vatRateCode,
        discountPercent: item.discountPercent,
        cashDiscountPercent: item.cashDiscountPercent,
        coefficient,
        isExport,
      });
      await tx.invoiceItem.update({ where: { id: item.id }, data: line });
    }
  }

  /**
   * B3 — zbirovi dokumenta iz STAVKI U BAZI (posle upisa, u istoj transakciji).
   * Nikad inkrementalno: jedan promašen put ostavio bi zaglavlje i stavke da se
   * ne slažu, a to je greška koja se vidi tek na štampi/knjiženju.
   */
  private async recalcTotals(
    tx: Prisma.TransactionClient,
    invoiceId: number,
  ): Promise<void> {
    const items = await tx.invoiceItem.findMany({
      where: { invoiceId },
      select: { vatBase: true, vatAmount: true, lineTotal: true },
    });

    let netTotal = ZERO;
    let vatTotal = ZERO;
    let grossTotal = ZERO;
    for (const item of items) {
      netTotal = netTotal.add(item.vatBase);
      vatTotal = vatTotal.add(item.vatAmount);
      grossTotal = grossTotal.add(item.lineTotal);
    }

    await tx.invoice.update({
      where: { id: invoiceId },
      data: { netTotal, vatTotal, grossTotal },
    });
  }

  // ── POMOĆNO ────────────────────────────────────────────────────────────────

  /** Polja zaglavlja spremna za `update` (samo ono što je telo poslalo). */
  private headerUpdateData(
    patch: ValidatedInvoiceHeaderPatch,
    coefficient: Prisma.Decimal | undefined,
    actor: AuthUser,
  ): Prisma.InvoiceUpdateManyMutationInput {
    const data: Prisma.InvoiceUpdateManyMutationInput = {
      updatedByUserId: actor?.userId ?? null,
    };
    if (patch.documentDate !== undefined)
      data.documentDate = patch.documentDate;
    if (patch.dueDate !== undefined) data.dueDate = patch.dueDate;
    if (patch.supplyDate !== undefined) data.supplyDate = patch.supplyDate;
    if (patch.customerId !== undefined) data.customerId = patch.customerId;
    if (patch.currency !== undefined) data.currency = patch.currency;
    if (patch.exchangeRate !== undefined)
      data.exchangeRate = patch.exchangeRate;
    if (patch.accountingExchangeRate !== undefined) {
      data.accountingExchangeRate = patch.accountingExchangeRate;
    }
    if (patch.note !== undefined) data.note = patch.note;
    if (patch.poNumber !== undefined) data.poNumber = patch.poNumber;
    if (patch.paymentReference !== undefined) {
      data.paymentReference = patch.paymentReference;
    }
    if (patch.lineProfile !== undefined) data.lineProfile = patch.lineProfile;
    if (coefficient) {
      data.priceCoefficient = coefficient;
      data.priceCoefficientAppliedAt = new Date();
      data.priceCoefficientAppliedBy = actor?.userId ?? null;
    }
    return data;
  }

  private async loadWithItems(tx: Prisma.TransactionClient, id: number) {
    const invoice = await tx.invoice.findUnique({
      where: { id },
      include: { items: { orderBy: { lineNo: "asc" } } },
    });
    if (!invoice) throw new NotFoundException(`Dokument ${id} ne postoji.`);
    return invoice;
  }
}
