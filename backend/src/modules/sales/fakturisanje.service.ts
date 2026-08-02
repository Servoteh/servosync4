import { businessYear } from "../../common/business-date";
import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { PostingEngineService } from "../gl/posting/posting.service";
import { GlWriteService } from "../gl/gl-write.service";
import { SefService } from "./sef/sef.service";
import { ReservationService } from "../robno/reservation.service";
import { DocumentNumberSequenceService } from "./numbering.service";
import { PricingService } from "./pricing.service";
import { documentVatTotals } from "./vat-totals";
import type { AuthUser } from "../auth/jwt.strategy";
import {
  type CreateProformaDto,
  validateCreateProforma,
} from "./dto/create-proforma.dto";
import {
  type ListInvoicesQuery,
} from "./dto/list-invoices.dto";
import { computePayableAmount } from "./advance-invoice.service";
import {
  APPLICATION_ACTIVE,
  APPLICATION_REVERSED,
  computeAdvanceDeductions,
  computeAdvanceUsage,
  loadAdvanceLinkedInvoices,
} from "./advance-deduction";

/**
 * FakturisanjeService — izlazni računi (PLAN_FAZA_5 §A).
 *
 * Životni ciklus:
 *   createProforma  → PON/PROF (level 250, DRAFT, cene iz PricingService)
 *   from-proforma   → carry-over PROF → IFR/… (DocumentCarryOverService, van ovog servisa)
 *   postInvoice     → level-0 knjiženje: rezerviši broj (DocumentNumberSequence) +
 *                     nalog GK. Dva puta:
 *                       (a) AUTO-ROBNO (IFR/IFGP sa stockDocumentId) → PostingEngineService
 *                           po šemi 33/36 (auto-robno razduženje + prihod + PDV),
 *                       (b) RUČNI nalog (IFUSL/uslužni, ili kad nema robnog izlaza) →
 *                           JournalEntry + LedgerEntry direktno sa BALANS-kontrolom:
 *                             kupac 2040 (2050 izvoz) DUG  = O + P + Q
 *                             prihod 6040 (6140 usluga)    POT = O
 *                             PDV 4702 (20%) / 4710 (10%)  POT = P / Q
 *                           Izvoz: kupac 2050, bez PDV (kategorija Z / čl.24).
 *
 * Novac je Prisma.Decimal svuda. Poslovne greške = ugrađeni NestJS exception-i.
 */

const D = Prisma.Decimal;
const ZERO = new D(0);

/** Konta ručnog knjiženja (doc 43 / PLAN_FAZA_5 §A). */
const ACC_CUSTOMER_DOMESTIC = "2040"; // kupci u zemlji
const ACC_CUSTOMER_EXPORT = "2050"; // kupci u inostranstvu
const ACC_REVENUE_GOODS = "6040"; // prihod od prodaje robe
const ACC_REVENUE_SERVICE = "6140"; // prihod od usluga (IFUSL)
const ACC_VAT_OUT_20 = "4702"; // obaveza za izlazni PDV 20% (VISA)
const ACC_VAT_OUT_10 = "4710"; // obaveza za izlazni PDV 10% (NIZA)

/**
 * KONTO IZLAZNOG PDV-a PO STOPI — po PROCENTU, ne po šifri.
 *
 * ⚠️ IZMEREN KVAR (02.08.2026): ovde je stajalo `ako je šifra "2" → 4710, INAČE → 4702`.
 * Šifra "4" je POSEBNA stopa (8 %, POLJO) i padala je u „inače", pa se PDV od 8 % knjižio
 * na konto `4702 — PDV 20 % na prodate robe`. GK bi balansirala (iznos je isti sa obe
 * strane), ali bi POPDV polje 3.2 iz tog konta izvodilo osnovicu deljenjem sa 0,2 —
 * osnovica od 8 % prometa bi ušla u obrazac umanjena za 60 %.
 *
 * ⚠️ KONTA ZA IZLAZNI PDV 8 % U KONTNOM PLANU NEMA (proveren
 * `20260723155000_seed_chart_of_accounts` i `prisma/seed/vat-account-map.sql`: postoji samo
 * `4750 — PDV po osnovu SOPSTVENE POTROŠNJE 8 %`, što nije promet po izdatoj fakturi).
 * Konto se NE IZMIŠLJA — stopa bez konta se odbija sa objašnjenjem (isti obrazac kao
 * `AdvanceInvoiceService`, nalaz Batch C R5), a pitanje je zapisano u
 * `docs/PREOSTALE_FAZE.md` § „OTVORENO NA DAN 01.08.2026" i čeka knjigovođu.
 */
const VAT_OUT_ACCOUNT_BY_PERCENT: Readonly<Record<string, string>> = {
  "20": ACC_VAT_OUT_20,
  "10": ACC_VAT_OUT_10,
};

/** Vrsta naloga za ručno knjiženje računa prodaje. */
const ORDER_TYPE_SALES = "IF";

const SERVICE_TYPES = new Set(["IFUSL", "IZVUS"]);
const AUTO_STOCK_TYPES = new Set(["IFR", "IFGP", "IZVRO", "IZVGP"]);

interface LedgerLineDraft {
  accountCode: string;
  analyticalCode: number | null;
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
  description: string | null;
}

/**
 * REDOVI RUČNOG NALOGA GK ZA IZLAZNI RAČUN — čist račun, bez baze.
 *
 *   kupac (2040 / 2050 izvoz)         DUG = osnovica + Σ PDV po stopama
 *   prihod (6040 roba / 6140 usluga)  POT = osnovica
 *   PDV po stopi (4702 / 4710)        POT = `round2(osnovica_stope × stopa)`
 *
 * ⚠️ PDV PO STOPI, NE PO STAVCI (ispravka 02.08.2026): iznosi dolaze iz istog računara
 * koji puni `netTotal`/`vatTotal` na zaglavlju (`vat-totals.ts`). Do tada je knjižen
 * `Σ vatAmount` po stavkama, pa je GK umela da nosi PDV koji se od `invoice.vatTotal`
 * razlikuje za paru (izmereno: 5 stavki × 100,01 din uz 20 % → GK 100,00, faktura 100,01;
 * na 20 stavki do 0,05). Nalog bi i tada balansirao — ista pogrešna suma stoji i na
 * dugovnoj strani — ali bi kupčev dug u saldakontima odstupao od bruto iznosa fakture,
 * a POPDV osnovica (izvedena iz PDV konta deljenjem stopom) od osnovice na papiru.
 *
 * IZVUČENO IZ SERVISA da bi moglo da se meri bez transakcije, numeracije naloga i mock-a
 * cele Prisme: ovde je jedina aritmetika, a `postManualLedger` ostaje upis.
 */
export function buildSalesLedgerLines(
  invoice: {
    documentType: string;
    documentNumber: string;
    customerId: number | null;
    isExport: boolean;
  },
  items: ReadonlyArray<{ vatRateCode: string; vatBase: Prisma.Decimal }>,
): LedgerLineDraft[] {
  const totals = documentVatTotals(items, { isExport: invoice.isExport });

  const lines: LedgerLineDraft[] = [
    {
      accountCode: invoice.isExport
        ? ACC_CUSTOMER_EXPORT
        : ACC_CUSTOMER_DOMESTIC,
      analyticalCode: invoice.customerId,
      // Kupac duguje BAŠ bruto iznos fakture (`netTotal + vatTotal`) — isti broj koji
      // stoji u zaglavlju, na papiru i u saldakontima.
      debit: totals.grossTotal,
      credit: ZERO,
      description: `Kupac ${invoice.documentNumber}`,
    },
    {
      accountCode: SERVICE_TYPES.has(invoice.documentType)
        ? ACC_REVENUE_SERVICE
        : ACC_REVENUE_GOODS,
      analyticalCode: null,
      debit: ZERO,
      credit: totals.netTotal,
      description: `Prihod ${invoice.documentNumber}`,
    },
  ];

  if (invoice.isExport) return lines; // kategorija Z / čl. 24 — bez PDV linije

  for (const group of totals.groups) {
    if (group.vat.isZero()) continue;
    const percent = group.ratePercent.toFixed(0);
    const account = VAT_OUT_ACCOUNT_BY_PERCENT[percent];
    // Stopa bez konta izlaznog PDV-a se do 02.08.2026. TIHO knjižila na konto stope od
    // 20 % (v. `VAT_OUT_ACCOUNT_BY_PERCENT`). Bolje odbiti sa objašnjenjem nego
    // proknjižiti porez na tuđe konto i time pokvariti POPDV.
    if (!account) {
      throw new UnprocessableEntityException(
        `Za PDV stopu ${percent}% ne postoji konto izlaznog PDV-a u kontnom planu — ` +
          `račun ${invoice.documentNumber} se ne može proknjižiti. ` +
          `Konto mora da odredi knjigovođa (v. docs/PREOSTALE_FAZE.md).`,
      );
    }
    lines.push({
      accountCode: account,
      analyticalCode: null,
      debit: ZERO,
      credit: group.vat,
      description: `PDV ${percent}% ${invoice.documentNumber}`,
    });
  }

  return lines;
}

/** Dopiši storno-razlog u napomenu fakture (čuva postojeći tekst, audit trag). */
function appendStornoNote(existing: string | null, reason: string): string {
  const stamp = `STORNO: ${reason}`;
  return existing && existing.trim().length > 0
    ? `${existing}\n${stamp}`
    : stamp;
}

@Injectable()
export class FakturisanjeService {
  private readonly logger = new Logger(FakturisanjeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pricing: PricingService,
    private readonly numbering: DocumentNumberSequenceService,
    private readonly posting: PostingEngineService,
    private readonly glWrite: GlWriteService,
    private readonly sef: SefService,
    private readonly reservation: ReservationService,
  ) {}

  // ── PREDRAČUN / PONUDA ──────────────────────────────────────────────────────

  /**
   * Kreiraj predračun/ponudu (PON/PROF, level 250, DRAFT). Cene iz PricingService.
   */
  async createProforma(dto: CreateProformaDto, actor: AuthUser) {
    validateCreateProforma(dto);

    const documentType = dto.documentType ?? "PROF";
    const companyId = dto.companyId ?? 0;
    const isExport = dto.isExport ?? false;
    const currency = dto.currency ?? (isExport ? "EUR" : "RSD");

    // Uz postojanje kupca uzimamo i dva podatka koja traži štampa (STAMPA_FAKTURA_GAP.md §3):
    //   • salespersonId → „Odgovorno lice" u potpisnom bloku (polje na Invoice je postojalo,
    //     ali ga niko nije punio, pa je ime na papiru bilo nemoguće);
    //   • paymentMethod → „Način plaćanja" u traci uslova / `Payment terms:` na ino fakturi.
    // Podrazumevaju se sa kupca; kad se napravi ekran za unos dokumenta, moći će da se pregaze
    // po dokumentu (isto kao u legacy GoodsDocument-u, koji oba nosi na zaglavlju dokumenta).
    const customer = await this.prisma.customer.findUnique({
      where: { id: dto.customerId },
      select: { id: true, salespersonId: true, paymentMethod: true },
    });
    if (!customer)
      throw new NotFoundException(`Kupac ${dto.customerId} ne postoji.`);

    // Legacy „nema komercijalistu" se piše kao 0, a ne NULL — 0 nije ID nijednog prodavca.
    const salespersonId =
      customer.salespersonId != null && customer.salespersonId > 0
        ? customer.salespersonId
        : null;
    const paymentMethod = customer.paymentMethod?.trim() || null;

    // Cena svake stavke (PricingService) — pre transakcije (čist read).
    const priced = [];
    for (const it of dto.items) {
      const p = await this.pricing.priceItem({
        customerId: dto.customerId,
        itemId: it.itemId ?? null,
        quantity: it.quantity,
        documentType,
        requestedDiscountPercent: it.discountPercent,
        cashDiscountPercent: it.cashDiscountPercent,
        overrideUnitPrice: it.unitPrice,
        vatRateCode: it.vatRateCode,
      });
      priced.push({ input: it, priced: p });
    }

    // Za izvoz PDV se ne obračunava (kategorija Z) — nula PDV bez obzira na šifru.
    const itemsData = priced.map((row, idx) => {
      const p = row.priced;
      const vatBase = p.vatBase;
      // PDV STAVKE je izvedena informacija (kolona „PDV" na papiru); porez dokumenta se
      // NE dobija njegovim sabiranjem — v. `vat-totals.ts` i `documentVatTotals` ispod.
      const vatAmount = isExport ? ZERO : p.vatAmount;
      const lineTotal = vatBase.add(vatAmount);
      return {
        lineNo: idx + 1,
        itemId: row.input.itemId ?? null,
        description: row.input.description ?? null,
        // j.m. za štampu; za artikal ostaje prazno i štampa je uzima iz Item.unit.
        unit: row.input.unit?.trim() || null,
        quantity: p.quantity,
        unitPrice: p.unitPrice,
        // Osnovica za koeficijent (§8/O1). Dokument se pravi sa koeficijentom 1,
        // pa je bazna cena jednaka cenovnoj. Bez ovog upisa kolona ostaje na
        // `DEFAULT 0`, a prvi dodir stavke bi cenu izveo iz nule.
        baseUnitPrice: p.unitPrice,
        // Cena PRE rabata — jedini trag pune cene za red „Rabat" na štampi. `baseUnitPrice`
        // to NIJE: ona je već posle rabata i kase (v. `schema.prisma`), pa se iz nje rabat
        // od 100 % ne može izvesti — cena posle takvog rabata je nula.
        unitPriceBeforeDiscount: p.unitPriceBeforeDiscount,
        discountPercent: p.discountPercent,
        cashDiscountPercent: p.cashDiscountPercent,
        vatRateCode: isExport ? "0" : p.vatRateCode,
        vatBase,
        vatAmount,
        lineTotal,
      };
    });

    // ZBIROVI DOKUMENTA — osnovica je zbir stavki, PDV je `round2(osnovica_stope × stopa)`
    // (ispravka 02.08.2026; do tada `Σ vatAmount` po stavkama, v. `vat-totals.ts`).
    // Stavke već nose šifru "0" na izvozu, ali se `isExport` prosleđuje i eksplicitno:
    // ovaj put pravi dokument iz spoljnog tela i ne sme da zavisi od tuđeg upisa.
    const { netTotal, vatTotal, grossTotal } = documentVatTotals(itemsData, {
      isExport,
    });

    // T3/A8: kreditni limit kupca — 422 i pri kreiranju predračuna/ponude ako bi
    // projektovani dug prešao limit, osim uz force (telo { force: true }).
    const force = (dto as CreateProformaDto & { force?: boolean }).force === true;
    await this.assertCreditLimit(dto.customerId, grossTotal, force);

    const year = (dto.documentDate ? new Date(dto.documentDate) : new Date()).getFullYear();
    // Draft broj (predračun) — dodeljuje se odmah po godišnjem nizu predračuna.
    const invoice = await this.prisma.$transaction(async (tx) => {
      const documentNumber = await this.numbering.next(
        tx,
        documentType,
        year,
        companyId,
      );
      return tx.invoice.create({
        data: {
          documentType,
          documentNumber,
          level: 250,
          companyId,
          customerId: dto.customerId,
          documentDate: dto.documentDate ? new Date(dto.documentDate) : new Date(),
          dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
          // DATUM PROMETA (obavezan element računa po Zakonu o PDV — nalaz N1/M1 iz
          // docs/FAKTURE_ZAKONSKA_USKLADJENOST.md): do sada ga nijedna ruta nije upisivala,
          // pa je kolona uvek bila NULL i obrasci su štampali praznu ćeliju.
          // Na PREDRAČUNU ostaje `null` kad ga korisnik ne pošalje — predračun se izdaje pre
          // prometa, pa ovde nemamo šta da podrazumevamo; podrazumevanu vrednost postavlja
          // `postInvoice` u trenutku knjiženja (vidljivo, uz WARN u logu).
          supplyDate: dto.supplyDate ? new Date(dto.supplyDate) : null,
          currency,
          isExport,
          netTotal,
          vatTotal,
          grossTotal,
          status: "DRAFT",
          poNumber: dto.poNumber?.trim() || null,
          salespersonId,
          paymentMethod,
          note: dto.note ?? null,
          createdByUserId: actor.userId,
          updatedByUserId: actor.userId,
          items: { create: itemsData },
        },
        include: { items: { orderBy: { lineNo: "asc" } } },
      });
    });

    return invoice;
  }

  // ── LISTA / DETALJ ──────────────────────────────────────────────────────────

  async listInvoices(query: ListInvoicesQuery) {
    const where: Prisma.InvoiceWhereInput = {};
    if (query.documentType) where.documentType = query.documentType;
    if (query.status) where.status = query.status;
    if (query.level !== undefined) where.level = query.level;
    if (query.customerId !== undefined) where.customerId = query.customerId;
    if (query.companyId !== undefined) where.companyId = query.companyId;
    if (query.isExport !== undefined) where.isExport = query.isExport;

    const take = query.take && query.take > 0 ? Math.min(query.take, 200) : 50;
    const skip = query.skip && query.skip > 0 ? query.skip : 0;

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.invoice.findMany({
        where,
        orderBy: { documentDate: "desc" },
        skip,
        take,
      }),
      this.prisma.invoice.count({ where }),
    ]);

    return { data: rows, meta: { total, skip, take } };
  }

  /**
   * Detalj računa. Batch C §C1a: uz dokument se vraća i IZRAČUNATO
   * `payableAmount = grossTotal − Σ AKTIVNIH primena avansa` (avans umanjuje samo
   * iznos za plaćanje — `grossTotal` se NE menja), plus broj avansnog računa
   * (`advanceInvoiceNumber`) kad je avans odbijen, da FE/štampa ne moraju
   * dodatni upit.
   *
   * Od migracije 20260726120000 veza avans↔račun je N:M
   * (`invoice_advance_applications`), pa se vraća i pun spisak primena
   * (`advanceApplications`) — jedan račun sme zatvarati više avansa.
   *
   * ⚠️ „ODBIJENO" IDE KROZ `./advance-deduction` (ispravka 02.08.2026). Ovaj ekran je
   * do tada radio po „ILI-ILI": zbir primena, a na kolonu `advance_applied_amount` je
   * padao SAMO kad primena nema nijedne. Za račun sa zatečenom 1:1 vezom (upisuje je
   * pdv modul rutom `link-final`) I novom N:M primenom to je značilo da ekran vidi
   * SAMO N:M deo — papir je govorio „za uplatu 5.000", a ekran „8.000". Sada oba
   * računaju isto: UNIJA primena i zatečene veze (obrazloženje u `advance-deduction.ts`).
   */
  async getInvoice(id: number) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id },
      include: { items: { orderBy: { lineNo: "asc" } } },
    });
    if (!invoice) throw new NotFoundException(`Račun ${id} ne postoji.`);

    const applications = await this.prisma.invoiceAdvanceApplication.findMany({
      where: { invoiceId: id, status: APPLICATION_ACTIVE },
      orderBy: { id: "asc" },
      select: {
        id: true,
        advanceInvoiceId: true,
        appliedAmount: true,
        appliedNet: true,
        appliedVat: true,
        closingEntryId: true,
        createdAt: true,
        advance: { select: { documentNumber: true, advancePaidAt: true } },
      },
    });

    const advance =
      invoice.advanceInvoiceId != null
        ? await this.prisma.invoice.findUnique({
            where: { id: invoice.advanceInvoiceId },
            select: { documentNumber: true, advancePaidAt: true },
          })
        : null;

    const deductions = computeAdvanceDeductions({
      invoice,
      applications: applications.map((a) => ({
        advanceInvoiceId: a.advanceInvoiceId,
        appliedAmount: a.appliedAmount,
        advanceDocumentNumber: a.advance.documentNumber,
      })),
      legacyAdvanceDocumentNumber: advance?.documentNumber ?? null,
    });
    const appliedTotal = deductions.total;

    /**
     * KOMPATIBILNA POLJA „prvi avans" (`advanceInvoiceNumber` / `advanceInvoicePaidAt`)
     * SMEJU da imenuju samo avans koji je STVARNO u spisku umanjenja.
     *
     * Do 02.08.2026. su se čitala pravo iz kolone-pokazivača `advance_invoice_id`, pa
     * su bila DRUGI izvor za isti pojam. Kad je `advance_applied_amount ≤ Σ aktivnih
     * primena` (zatečena 1:1 veza pokrivena N:M primenama, storno primene, ručna
     * ispravka kolone u bazi), pravilo taj avans ne daje u `advanceDeductions` — a
     * ekran je i dalje pisao „Avans: A-1/26", dokument kojeg u spisku umanjenja nema
     * i čiji iznos nigde ne stoji. Knjigovođa tada traži 3.000 koje ne postoje.
     *
     * Sada oba polja opisuju PRVI red spiska (`deductions.lines[0]`): nema reda →
     * nema ni imena. Broj se uzima iz samog reda, a datum naplate iz izvora tog reda
     * (zatečena veza = učitan AVR iz kolone; N:M primena = AVR te primene).
     */
    const firstDeduction = deductions.lines[0] ?? null;
    const firstAdvance =
      firstDeduction == null
        ? null
        : firstDeduction.fromLegacyLink
          ? advance
          : (applications.find(
              (a) => a.advanceInvoiceId === firstDeduction.advanceInvoiceId,
            )?.advance ?? null);

    return {
      ...invoice,
      payableAmount: computePayableAmount({
        grossTotal: invoice.grossTotal,
        advanceAppliedAmount: appliedTotal,
      }),
      advanceAppliedAmount: appliedTotal,
      advanceInvoiceNumber: firstAdvance?.documentNumber ?? null,
      // Datum naplate ODBIJENOG avansa (polje `advancePaidAt` na SAMOM dokumentu
      // ostaje netaknuto — ono važi samo za AVR, ne za konačni račun).
      advanceInvoicePaidAt: firstAdvance?.advancePaidAt ?? null,
      /**
       * ODBIJENI AVANSI — isti spisak koji ide i na papir i na e-fakturu: po jedan
       * unos PO AVANSU, sa iznosom BAŠ TOG avansa. Zbir mu je uvek `advanceAppliedAmount`.
       *
       * Razlikuje se od `advanceApplications` ispod: ovde je i zatečena 1:1 veza koja
       * nema svoj red u spojnoj tabeli (`fromLegacyLink`), pa ekran ne može da prikaže
       * spisak koji ne sabira u prikazan iznos.
       */
      advanceDeductions: deductions.lines.map((l) => ({
        advanceInvoiceId: l.advanceInvoiceId,
        advanceDocumentNumber: l.advanceDocumentNumber,
        amount: l.amount,
        fromLegacyLink: l.fromLegacyLink,
      })),
      /**
       * Sve aktivne primene avansa na ovom računu (N:M, redom nastanka) — TEHNIČKI
       * spisak redova spojne tabele (id primene, razbijena osnovica/PDV, nalog
       * zatvaranja). Zatečena 1:1 veza ovde NEMA šta da traži: ona nema ni red ni
       * nalog. Za prikaz „šta je sve odbijeno" koristi `advanceDeductions`.
       */
      advanceApplications: applications.map((a) => ({
        id: a.id,
        advanceInvoiceId: a.advanceInvoiceId,
        advanceDocumentNumber: a.advance.documentNumber,
        advancePaidAt: a.advance.advancePaidAt,
        appliedAmount: a.appliedAmount,
        appliedNet: a.appliedNet,
        appliedVat: a.appliedVat,
        closingEntryId: a.closingEntryId,
        appliedAt: a.createdAt,
      })),
    };
  }

  // ── KNJIŽENJE (level 0) ──────────────────────────────────────────────────────

  /**
   * Proknjiži račun: rezerviši definitivan broj + kreiraj nalog GK. Idempotentno
   * (već-knjižen račun status ≠ DRAFT → ConflictException).
   */
  async postInvoice(id: number, actor: AuthUser, force = false) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id },
      include: { items: { orderBy: { lineNo: "asc" } } },
    });
    if (!invoice) throw new NotFoundException(`Račun ${id} ne postoji.`);

    // D8: zaključan (proknjižen) dokument se ne knjiži ponovo / ne menja bez storna.
    if (invoice.isLocked) {
      throw new ConflictException("Dokument je zaključan (proknjižen).");
    }
    if (invoice.status !== "DRAFT") {
      throw new ConflictException(
        `Račun ${id} je već proknjižen (status ${invoice.status}).`,
      );
    }
    if (invoice.customerId == null) {
      throw new UnprocessableEntityException(
        `Račun ${id} nema kupca — ne može se proknjižiti.`,
      );
    }
    if (invoice.items.length === 0) {
      throw new UnprocessableEntityException(
        `Račun ${id} nema stavke — ne može se proknjižiti.`,
      );
    }

    // T3/A8: kreditni limit kupca (Customer.creditLimit sync polje) — 422 PRE claim-a
    // ako bi projektovani dug prešao limit, osim uz force (svesno knjiženje uprkos
    // limitu; FAKTURISANJE post permisija je dovoljno ovlašćenje).
    await this.assertCreditLimit(invoice.customerId, invoice.grossTotal, force);

    const year = businessYear(invoice.documentDate);

    return this.prisma.$transaction(async (tx) => {
      // 0) ATOMSKI CLAIM (review 1D nalaz): invoice se čita findUnique VAN tx, pa su
      //    rani guardovi (isLocked/status DRAFT) nad snapshot-om — dva paralelna posta
      //    bi oba prošla i ručna grana (postManualLedger) bi kreirala DVA posted naloga
      //    (dupli prihod+PDV). CAS updateMany je JEDINI izvor ekskluzivnosti: samo jedna
      //    tx prelama DRAFT & !isLocked → POSTED & locked; ostale dobiju count 0 → 409.
      //    Rani guardovi ostaju kao fast-fail sa specifičnijim porukama (customer/stavke).
      const claimed = await tx.invoice.updateMany({
        where: { id, status: "DRAFT", isLocked: false },
        data: { status: "POSTED", isLocked: true },
      });
      if (claimed.count !== 1) {
        throw new ConflictException("Račun je već proknjižen ili zaključan.");
      }

      // 1) Rezerviši definitivan broj (level 0). Rollback numeracije ide sa tx.
      const documentNumber = await this.numbering.next(
        tx,
        invoice.documentType,
        year,
        invoice.companyId,
      );

      // 2) Auto-robno (IFR/IFGP/IZVRO/IZVGP) sa vezanim robnim izlazom → PostingEngine.
      let journalEntryId: number | null = null;
      const isAutoStock =
        AUTO_STOCK_TYPES.has(invoice.documentType) &&
        invoice.stockDocumentId != null;

      if (isAutoStock && invoice.stockDocumentId != null) {
        // Auto-robno knjiženje (razduženje + prihod + PDV) po šemi 33/36/24/47.
        // PostingEngine sam otvara $transaction; pozivamo ga van tx-a NAKON commit-a
        // ovog bloka nije moguće (broj mora biti u istoj tx). Zato: kreiramo broj,
        // pa unutar iste logičke celine markiramo — ali PostingEngine ima svoju tx.
        // Rešenje: prvo posting (svoja tx), pa tek onda rezervacija broja ovde bi
        // razbila atomiku. Zadržavamo redosled: broj u ovoj tx, posting posle commit-a.
        // (Za auto-robno, robni dokument je već proknjižen kroz Fazu 3 tok — ovde
        // preuzimamo journalEntryId ako postoji, inače ostaje null.)
        const existing = await tx.journalEntry.findFirst({
          where: { sourceGoodsDocId: invoice.stockDocumentId },
          select: { id: true, status: true },
        });
        if (existing) {
          journalEntryId = existing.id;
          // Robni auto-nalog nastaje kao `draft` (posting.service.ts:358), a kartica
          // konta / saldakonti / bilans čitaju SAMO status IN ('POSTED','LOCKED') —
          // draft nalog je nevidljiv. Zato preuzeti nalog promovišemo u `posted` u istoj
          // tx (odluka O4 default, kao izvod u PR #8). markPosted idiom = status guard:
          // CAS `where status='DRAFT'` menja SAMO draft; posted/locked ostaje netaknut
          // (idempotentno — račun čiji je robni nalog već proknjižen/zaključan se ne dira).
          if (existing.status === "DRAFT") {
            await tx.journalEntry.updateMany({
              where: { id: existing.id, status: "DRAFT" },
              data: { status: "POSTED" },
            });
          }
        } else {
          journalEntryId = null;
        }
      } else {
        // 3) RUČNI nalog (IFUSL/uslužni ili račun bez robnog izlaza) — direktan GL.
        journalEntryId = await this.postManualLedger(
          tx,
          invoice,
          year,
          actor,
        );
      }

      // 3b) DATUM PROMETA — podrazumevana vrednost, i to SAMO ovde (mera M1).
      //     Zašto uopšte podrazumevati: datum prometa je obavezan element računa po
      //     Zakonu o PDV, a knjiženje je trenutak u kome nacrt postaje izdat račun —
      //     posle njega je dokument zaključan (D8) i podatak se više ne može dodati bez
      //     storna. Proknjižen račun bez datuma prometa je zato neispravan papir.
      //     Zašto BAŠ datum izdavanja: kod prodaje robe „preko pulta"/iz magacina promet
      //     i izdavanje računa padaju na isti dan, i to je jedini datum koji sistem u tom
      //     trenutku pouzdano zna. Ostale kandidate nemamo: robni izlaz (stockDocumentId)
      //     ne mora postojati (IFUSL), a datum otpreme se nigde ne vodi.
      //     Zašto NIJE tiho: upisuje se WARN sa brojem računa, pa se u logu vidi na kojim
      //     je dokumentima datum izveden umesto unet.
      //     🔴 ZA POTVRDU KNJIGOVOĐI (§7 t.3): sme li se datum prometa uopšte izjednačiti
      //     sa datumom izdavanja i šta je datum prometa kod usluge koja traje mesecima
      //     (zakup, montaža) — dok se ne odgovori, ovo je najmanje pogrešna pretpostavka,
      //     a ne konačno pravilo.
      const supplyDate = invoice.supplyDate ?? invoice.documentDate;
      if (invoice.supplyDate == null) {
        this.logger.warn(
          `Račun ${id} (${invoice.documentType}) nema unet datum prometa — ` +
            `pri knjiženju je postavljen na datum izdavanja ` +
            `(${invoice.documentDate.toISOString().slice(0, 10)}).`,
        );
      }

      // 4) Ažuriraj račun: definitivan broj, level 0, veza na nalog. `where {id}` je
      //    bezbedan jer je CLAIM (korak 0) već obezbedio ekskluzivnost i postavio
      //    status=POSTED & isLocked=true; ovde ih samo re-afirmišemo (D8: proknjižen
      //    dokument je tehnički zaključan — mutacije/storno idu odvojenim putem).
      const posted = await tx.invoice.update({
        where: { id },
        data: {
          documentNumber,
          level: 0,
          status: "POSTED",
          journalEntryId,
          isLocked: true,
          supplyDate,
          updatedByUserId: actor.userId,
        },
        include: { items: { orderBy: { lineNo: "asc" } } },
      });

      return posted;
    });
  }

  // ── STORNO (D8: jedini dozvoljeni put za zaključan dokument) ─────────────────

  /**
   * Storno proknjižene fakture (BigBit ER paritet). Guard: dokument mora biti
   * zaključan (isLocked) i proknjižen (status ≠ DRAFT), i još ne storniran
   * (status ≠ CANCELLED). D8: storno je JEDINI put koji sme da dira zaključan
   * dokument (postInvoice/mutacije ga odbijaju). Tok, u redosledu:
   *   1) CAS claim: status → CANCELLED (ekskluzivnost — samo jedan storno prolazi),
   *      razlog se dopisuje u napomenu (audit).
   *   2) reverse GL naloga (gl-write.reverse) — obrnute strane, novi storno-nalog.
   *   3) SEF: SENT/DELIVERED → SEF cancel API; PENDING → lokalno CANCELLED (bez slanja).
   * Vraća storniranu fakturu + id storno-naloga + spiskove otkazanih SEF redova
   * (sefCancelledOutboxIds = SEF cancel; sefCancelledPendingIds = lokalno otkazani PENDING).
   */
  async stornoInvoice(id: number, reason: string, actor: AuthUser) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        isLocked: true,
        journalEntryId: true,
        note: true,
        documentNumber: true,
        documentType: true,
        advanceClosingEntryId: true,
        // Zatečena 1:1 veza nema ni red u spojnoj tabeli ni nalog zatvaranja —
        // jedini trag joj je ova kolona, pa se mora pročitati da bi se očistila.
        advanceInvoiceId: true,
      },
    });
    if (!invoice) throw new NotFoundException(`Račun ${id} ne postoji.`);

    if (invoice.status === "CANCELLED") {
      throw new ConflictException(`Račun ${id} je već storniran.`);
    }

    // AVANS koji je već odbijen na nestorniranom računu se NE stornira: njegov
    // nalog naplate je već zatvoren nalogom odbijanja, pa bi drugi storno umanjio
    // PDV obavezu drugi put, a konačni račun bi i dalje prikazivao umanjenje za
    // storniran avans (review Batch C, nalaz 2). Prvo se stornira konačni račun.
    if (invoice.documentType === "AVR") {
      // N:M: avans može biti primenjen na VIŠE računa — svaki od njih blokira storno.
      const appliedOn = await this.prisma.invoiceAdvanceApplication.findMany({
        where: { advanceInvoiceId: id, status: APPLICATION_ACTIVE },
        select: { invoice: { select: { documentNumber: true, status: true } } },
      });
      const blocking = appliedOn
        .filter((a) => a.invoice.status !== "CANCELLED")
        .map((a) => a.invoice.documentNumber);

      // ⚠️ ZATEČENA 1:1 VEZA BLOKIRA ISTO KAO PRIMENA (ispravka 02.08.2026).
      // Gornji upit vidi SAMO redove spojne tabele, a odbitak može da živi i u
      // kolonama `invoices.advance_invoice_id` + `advance_applied_amount` BEZ svog
      // reda (dokumenti knjiženi pre migracije 20260726120000, uvoz BigBit istorije,
      // ručna ispravka u bazi; ruta `POST /pdv/advances/link-final` je od Batch C
      // revizije zatvorena, pa nove ne pravi). Za takav račun je gornji spisak prazan, pa
      // je storno AVR-a prolazio — a konačni račun je i dalje ŠTAMPAO „Umanjenje za
      // primljeni avans (br. A-1/26): −3.000", slao `PrepaidAmount` 3.000 i
      // `BillingReference` na STORNIRAN poreski dokument, i kupcu prikazivao 3.000
      // manje za uplatu. Komentar iznad („prvo se stornira konačni račun") je taj
      // scenario opisivao, ali ga brana nije pokrivala.
      //
      // Meri se ISTIM pravilom kojim se iznos ispisuje na papir („kolona − Σ primena
      // tog računa", `./advance-deduction`): blokira tačno ono što se negde odbija.
      // Račun kome primene pokriju celu kolonu ovde ne daje red — njega već blokira
      // gornji spisak. Stornirani računi otpadaju u `loadAdvanceLinkedInvoices`.
      const legacyUsage = computeAdvanceUsage({
        advanceInvoiceId: id,
        // Primene su gore već obrađene; ovde se traže SAMO zatečene veze.
        applicationsOfAdvance: [],
        linkedInvoices: await loadAdvanceLinkedInvoices(this.prisma, [id]),
      });
      for (const line of legacyUsage.lines) {
        blocking.push(line.invoiceDocumentNumber ?? `#${line.invoiceId}`);
      }

      if (blocking.length) {
        throw new ConflictException(
          `Avansni račun ${invoice.documentNumber} je odbijen na računu/ima primene na: ` +
            `${blocking.join(", ")} — prvo storniraj te račune, pa onda avans.`,
        );
      }
    }
    // D8: samo zaključan (proknjižen) dokument se stornira; draft se menja/briše normalno.
    if (!invoice.isLocked || invoice.status === "DRAFT") {
      throw new ConflictException(
        `Račun ${id} nije proknjižen (zaključan) — storno nije moguć.`,
      );
    }

    // ATOMIČNOST (review Batch A F4 — svesni trade-off): koraci 1–3 NISU u jednoj
    // $transaction. CAS→CANCELLED (korak 1) je NAMERNO prvi, radi ekskluzivnosti (samo
    // jedan storno prolazi). Redosled se NE menja: obrnuti redosled (reverse pre CAS) bi
    // u trci dozvolio DVA reverse-naloga za istu fakturu. Posledica trade-off-a: pad
    // IZMEĐU koraka 1 i 2 ostavlja fakturu CANCELLED BEZ GL storna — nekonzistentnost se
    // sanira RUČNIM reverse-om izvornog naloga kroz Glavnu knjigu (GK). Učestalost
    // zanemarljiva; korak 2 dodatno loguje ERROR sa uputstvom za sanaciju.
    //
    // 1) CAS claim — snapshot status + isLocked → CANCELLED (ekskluzivno). Dopiši razlog.
    //    Isti obrazac kao postInvoice: updateMany je JEDINI izvor ekskluzivnosti; dva
    //    paralelna storna → samo jedan dobije count 1, drugi 409.
    const claimed = await this.prisma.invoice.updateMany({
      where: { id, status: invoice.status, isLocked: true },
      data: {
        status: "CANCELLED",
        note: appendStornoNote(invoice.note, reason),
        updatedByUserId: actor.userId,
      },
    });
    if (claimed.count !== 1) {
      throw new ConflictException(
        `Račun ${id} je već storniran ili se trenutno stornira.`,
      );
    }

    // 2) reverse GL nalog (ako postoji i nije nacrt / već storniran). Pošto je CAS gore
    //    obezbedio ekskluzivnost, ovde nema trke oko duplog storna naloga.
    let stornoEntryId: number | null = null;
    if (invoice.journalEntryId != null) {
      const entry = await this.prisma.journalEntry.findUnique({
        where: { id: invoice.journalEntryId },
        select: { id: true, status: true, reversedByEntryId: true },
      });
      if (entry && entry.status !== "DRAFT" && entry.reversedByEntryId == null) {
        try {
          const rev = await this.glWrite.reverse(entry.id, actor.userId);
          stornoEntryId = rev.stornoEntryId;
        } catch (err) {
          // Faktura je već (korak 1, commit-ovan CAS) označena CANCELLED, a reverse GL
          // naloga je pao → stanje: stornirana faktura BEZ GL storna (trade-off gore).
          // SANACIJA: ručno proknjižiti obrnuti nalog kroz Glavnu knjigu (GK) za nalog
          // ${entry.id}. Grešku propagiramo (pozivalac vidi da GL storno nije prošao).
          this.logger.error(
            `STORNO SANACIJA: faktura ${id} je označena CANCELLED, ali reverse GL naloga ` +
              `${entry.id} nije uspeo — ručno proknjižiti obrnuti nalog kroz Glavnu knjigu (GK). ` +
              `Uzrok: ${err instanceof Error ? err.message : String(err)}`,
            err instanceof Error ? err.stack : undefined,
          );
          throw err;
        }
      }
    }

    // 2b) NALOZI ZATVARANJA AVANSA (Batch C; N:M od migracije 20260726120000).
    //     `applyAdvance` po SVAKOJ primeni knjiži zaseban nalog (4300 DUG / PDV DUG /
    //     kupac POT) koji NIJE `invoice.journalEntryId`. Bez njihovog storna
    //     poništenje računa ostavlja obavezu po primljenom avansu i PDV po avansu
    //     zatvorene — iako je avans naplaćen i novac je u kasi. Storno reverzira
    //     naloge SVOJIH primena, označava ih REVERSED (time OSLOBAĐA te iznose —
    //     avans se odmah može ponovo iskoristiti) i čisti kompatibilne kolone.
    const advanceStornoEntryIds: number[] = [];
    let advanceStornoEntryId: number | null = null;
    const applications = await this.prisma.invoiceAdvanceApplication.findMany({
      where: { invoiceId: id, status: APPLICATION_ACTIVE },
      orderBy: { id: "asc" },
      select: { id: true, closingEntryId: true },
    });
    // Rezerva za dokumente knjižene pre N:M migracije (veza samo u koloni).
    const toReverse: Array<{
      id: number | null;
      closingEntryId: number | null;
    }> =
      applications.length === 0 && invoice.advanceClosingEntryId != null
        ? [{ id: null, closingEntryId: invoice.advanceClosingEntryId }]
        : applications;

    for (const application of toReverse) {
      let reversalEntryId: number | null = null;
      if (application.closingEntryId != null) {
        const advEntry = await this.prisma.journalEntry.findUnique({
          where: { id: application.closingEntryId },
          select: { id: true, status: true, reversedByEntryId: true },
        });
        if (
          advEntry &&
          advEntry.status !== "DRAFT" &&
          advEntry.reversedByEntryId == null
        ) {
          try {
            const rev = await this.glWrite.reverse(advEntry.id, actor.userId);
            reversalEntryId = rev.stornoEntryId;
            advanceStornoEntryIds.push(rev.stornoEntryId);
            advanceStornoEntryId ??= rev.stornoEntryId;
          } catch (err) {
            this.logger.error(
              `STORNO SANACIJA: faktura ${id} je označena CANCELLED, ali reverse naloga ` +
                `zatvaranja avansa ${advEntry.id} nije uspeo — ručno proknjižiti obrnuti ` +
                `nalog kroz Glavnu knjigu (GK). Uzrok: ` +
                `${err instanceof Error ? err.message : String(err)}`,
              err instanceof Error ? err.stack : undefined,
            );
            throw err;
          }
        }
      }
      if (application.id != null) {
        await this.prisma.invoiceAdvanceApplication.update({
          where: { id: application.id },
          data: {
            status: APPLICATION_REVERSED,
            reversalEntryId,
            reversedAt: new Date(),
          },
        });
      }
    }

    // Kolone se čiste i kad NEMA šta da se reverzira: zatečena 1:1 veza nema ni red u
    // spojnoj tabeli ni nalog zatvaranja, pa je `toReverse` za nju prazan i kolone su
    // ostajale na storniranom računu ZAUVEK. Posledica nije kozmetička: `link-final`
    // (i budući uvoznik) po toj koloni zaključuju „avans je već iskorišćen", pa se AVR
    // posle storna svog jedinog računa nije mogao odbiti nigde — ćorsokak bez izlaza
    // kroz aplikaciju. Storniran račun ništa ne duguje i ništa ne odbija.
    if (toReverse.length > 0 || invoice.advanceInvoiceId != null) {
      await this.prisma.invoice.update({
        where: { id },
        data: {
          advanceInvoiceId: null,
          advanceAppliedAmount: new D(0),
          advanceClosingEntryId: null,
        },
      });
    }

    // 2c) REZERVACIJE ZALIHA (Batch C). Storniran dokument više ništa ne obećava
    //     kupcu — rezervacije registrovane na NJEGA se oslobađaju i roba se vraća u
    //     raspoloživo. Bez ovoga bi rezervacija storniranog predračuna večno držala
    //     zalihu (nema FK ka `invoices`, pa ni kaskade). Ne sme da obori već
    //     izvršen storno: neuspeh se loguje, dokument ostaje CANCELLED.
    await this.reservation
      .release(
        {
          sourceType: "invoice",
          sourceId: id,
          reason: `storno dokumenta ${invoice.documentNumber}`,
        },
        actor.userId,
      )
      .catch((err: unknown) => {
        this.logger.warn(
          `Dokument ${invoice.documentNumber} je storniran, ali oslobađanje rezervacija ` +
            `nije uspelo — proveri /robno/rezervacije. Uzrok: ${String(err)}`,
        );
      });

    // 3) SEF outbox saniranje (review Batch A F3):
    //    (a) SENT/DELIVERED → SEF cancel API (postojeći tok, guard MozeDaSeStornira +
    //        DRY-RUN bezbedno, sa razlogom).
    //    (b) PENDING (kreiran ali NIKAD poslat) → lokalno CANCELLED bez SEF poziva
    //        (sef.cancelPendingLocally) — inače bi ostao „u redu za slanje" i mogao da
    //        ode na SEF posle storna. send() ima i defense-in-depth guard nad tim.
    const sefCancelledOutboxIds: number[] = [];
    const outboxRows = await this.sef.listOutbox({ invoiceId: id, take: 200 });
    for (const row of outboxRows) {
      if (row.status === "SENT" || row.status === "DELIVERED") {
        await this.sef.cancel(row.id, reason);
        sefCancelledOutboxIds.push(row.id);
      }
    }
    const sefCancelledPendingIds = await this.sef.cancelPendingLocally(
      id,
      reason,
      actor.userId,
    );

    const stornoed = await this.prisma.invoice.findUnique({
      where: { id },
      include: { items: { orderBy: { lineNo: "asc" } } },
    });
    if (!stornoed) throw new NotFoundException(`Račun ${id} ne postoji.`);
    return {
      ...stornoed,
      stornoEntryId,
      /** Prvi storno-nalog primene avansa (kompatibilnost sa 1:1 odgovorom). */
      advanceStornoEntryId,
      /** Svi storno-nalozi primena avansa ovog računa (N:M). */
      advanceStornoEntryIds,
      sefCancelledOutboxIds,
      sefCancelledPendingIds,
    };
  }

  /**
   * Kreditni limit kupca (BigBit paritet — Customer.creditLimit je sync polje).
   * Ako je limit > 0 i projektovani dug (otvorene receivable stavke partnera +
   * bruto ovog dokumenta) prelazi limit → UnprocessableEntity (422), OSIM ako je
   * pozvano sa force=true (svesno prekoračenje). Saldo = Σ(dug − potr) otvorenih
   * (posted, nereconciled) stavki na receivable saldakonto kontima za tog partnera
   * (isti izveden pogled kao OpenItemsService, direktan agregat da se izbegne
   * cross-modul import). Telo greške nosi structured polja (code/balance/limit) za FE.
   */
  private async assertCreditLimit(
    customerId: number,
    grossTotal: Prisma.Decimal,
    force: boolean,
  ): Promise<void> {
    if (force) return;

    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { creditLimit: true },
    });
    const limit = customer?.creditLimit ?? null;
    // Limit 0 / null = bez kontrole (kupac bez postavljenog kreditnog limita).
    if (limit == null || new D(limit).lessThanOrEqualTo(ZERO)) return;

    const rows = await this.prisma.$queryRaw<{ balance: Prisma.Decimal | null }[]>(
      Prisma.sql`
        SELECT COALESCE(SUM(le.debit) - SUM(le.credit), 0) AS balance
        FROM ledger_entries le
        JOIN journal_entries je ON je.id = le.journal_entry_id
        JOIN saldakonto_accounts sa ON sa.account = le.account_code
        -- 'LOCKED' MORA biti uključen (smoke Batch A nalaz): auto-lock starih naloga bi
        -- inače IZBRISAO dug iz obračuna limita — kupac sa zaključanim dugovanjima bi
        -- prošao guard kao da duga nema.
        WHERE je.status IN ('POSTED', 'LOCKED')
          AND le.reconciled_at IS NULL
          AND sa.tracks_open_items = TRUE
          AND sa.side = 'receivable'
          -- Vrsta partnera, ne samo strana salda: dati avansi DOBAVLJAČIMA (1520/1521/1530)
          -- su takođe 'receivable'. Bez ovog filtera bi kooperantu koji je i kupac i
          -- dobavljač plaćen avans sužavao kreditni limit i obarao legitimnu fakturu
          -- sa CREDIT_LIMIT_EXCEEDED (revizija).
          AND sa.partner_scope = 'customer'
          AND le.analytical_code = ${customerId}
      `,
    );

    const balance = new D(rows[0]?.balance ?? 0);
    const projected = balance.add(grossTotal);
    const limitD = new D(limit);
    if (projected.greaterThan(limitD)) {
      throw new UnprocessableEntityException({
        code: "CREDIT_LIMIT_EXCEEDED",
        message:
          `Kreditni limit kupca je prekoračen: dug bi bio ${projected.toFixed(2)} ` +
          `(trenutni saldo ${balance.toFixed(2)} + dokument ${grossTotal.toFixed(2)}), ` +
          `a limit je ${limitD.toFixed(2)}. Za knjiženje uprkos limitu koristi opciju ` +
          `Proknjiži uprkos limitu.`,
        balance: balance.toFixed(2),
        amount: grossTotal.toFixed(2),
        projected: projected.toFixed(2),
        limit: limitD.toFixed(2),
      });
    }
  }

  /**
   * Ručni nalog GK za račun (IFUSL/uslužni ili bez robnog izlaza). Balans-kontrola.
   *   kupac (2040 / 2050 izvoz) DUG  = osnovica + Σ PDV po stopama
   *   prihod (6040 roba / 6140 usluga) POT = osnovica
   *   PDV 4702 (20%) / 4710 (10%) POT = PDV te stope   (izvoz: bez PDV)
   *
   * ⚠️ PDV PO STOPI, NE PO STAVCI (ispravka 02.08.2026): iznosi dolaze iz
   * `documentVatTotals` — `round2(osnovica_stope × stopa)` — istog računara koji puni
   * `netTotal`/`vatTotal` na zaglavlju. Do tada je knjižen `Σ vatAmount` po stavkama, pa
   * je GK umela da nosi PDV koji se od `invoice.vatTotal` razlikuje za paru (na 20 stavki
   * i do 0,05 din). Nalog bi i tada balansirao — jer se ista pogrešna suma pojavljuje i
   * na dugovnoj strani — ali bi kupčev dug odstupao od bruto iznosa fakture, a POPDV
   * osnovica izvedena iz PDV konta od osnovice na papiru.
   */
  private async postManualLedger(
    tx: Prisma.TransactionClient,
    invoice: {
      id: number;
      documentType: string;
      documentNumber: string;
      companyId: number;
      customerId: number | null;
      documentDate: Date;
      dueDate: Date | null;
      currency: string;
      isExport: boolean;
      workOrderId: number | null;
    },
    year: number,
    actor: AuthUser,
    items?: Array<{
      vatRateCode: string;
      vatBase: Prisma.Decimal;
    }>,
  ): Promise<number> {
    const lines =
      items ??
      (await tx.invoiceItem.findMany({
        where: { invoiceId: invoice.id },
        select: { vatRateCode: true, vatBase: true },
      }));

    const draftLines = buildSalesLedgerLines(invoice, lines);

    // Odbaci nula-redove.
    const grouped = draftLines.filter(
      (l) => !(l.debit.isZero() && l.credit.isZero()),
    );

    // BALANS-KONTROLA: ΣDug == ΣPot.
    let totalDebit = ZERO;
    let totalCredit = ZERO;
    for (const l of grouped) {
      totalDebit = totalDebit.add(l.debit);
      totalCredit = totalCredit.add(l.credit);
    }
    if (!totalDebit.equals(totalCredit)) {
      throw new UnprocessableEntityException(
        `Nalog ne balansira: ΣDug=${totalDebit.toFixed(4)} ≠ ΣPot=${totalCredit.toFixed(4)}.`,
      );
    }

    const number = await this.nextJournalNumber(
      tx,
      invoice.companyId,
      ORDER_TYPE_SALES,
      year,
    );

    const entry = await tx.journalEntry.create({
      data: {
        number,
        orderTypeCode: ORDER_TYPE_SALES,
        year,
        companyId: invoice.companyId,
        documentDate: invoice.documentDate,
        postingDate: new Date(),
        // POSTED (ne draft): proknjižena faktura MORA odmah biti vidljiva saldakontima /
        // kartici konta / bilansu / open-items, koji čitaju SAMO status IN ('POSTED','LOCKED').
        // Draft nalog = proknjižen račun bez ijedne
        // otvorene stavke (kupac tiho van saldakonta). Isti obrazac kao izvod (PR #8) i
        // PostingEngine.postManualEntry (posting.service.ts:229). Odluka O4 default.
        status: "POSTED",
        createdByUserId: actor.userId,
        lines: {
          create: grouped.map((l) => ({
            accountCode: l.accountCode,
            analyticalCode: l.analyticalCode,
            debit: l.debit,
            credit: l.credit,
            description: l.description,
            documentNumber: invoice.documentNumber,
            dueDate: invoice.dueDate,
            currency: invoice.currency,
            sourceWorkOrderId: invoice.workOrderId ?? null,
          })),
        },
      },
      select: { id: true },
    });

    return entry.id;
  }

  /**
   * Numeracija naloga: 1 + MAX po (company, vrsta, godina), zero-pad 4.
   * pg_advisory_xact_lock da paralelni post ne dobiju isti broj (obrazac iz posting.service).
   */
  private async nextJournalNumber(
    tx: Prisma.TransactionClient,
    companyId: number,
    orderType: string,
    year: number,
  ): Promise<string> {
    const lockKey = `${companyId}:${orderType}:${year}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
    // Numerički MAX u JS-u (obrazac stock-document-numbering) — string orderBy je
    // leksikografski pa je '10000' < '9999' i brojač bi se zaglavio posle 9999.
    const rows = await tx.journalEntry.findMany({
      where: { companyId, orderTypeCode: orderType, year },
      select: { number: true },
    });
    let maxSeq = 0;
    for (const r of rows) {
      const n = Number.parseInt(r.number, 10);
      if (!Number.isNaN(n) && n > maxSeq) maxSeq = n;
    }
    return String(maxSeq + 1).padStart(4, "0");
  }
}
