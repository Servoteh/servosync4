import {
  Injectable,
  NotFoundException,
  ConflictException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { PostingEngineService } from "../gl/posting/posting.service";
import { DocumentNumberSequenceService } from "./numbering.service";
import { PricingService } from "./pricing.service";
import type { AuthUser } from "../auth/jwt.strategy";
import {
  type CreateProformaDto,
  validateCreateProforma,
} from "./dto/create-proforma.dto";
import {
  type ListInvoicesQuery,
} from "./dto/list-invoices.dto";

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

@Injectable()
export class FakturisanjeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pricing: PricingService,
    private readonly numbering: DocumentNumberSequenceService,
    private readonly posting: PostingEngineService,
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

    const customer = await this.prisma.customer.findUnique({
      where: { id: dto.customerId },
      select: { id: true },
    });
    if (!customer)
      throw new NotFoundException(`Kupac ${dto.customerId} ne postoji.`);

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
    let netTotal = ZERO;
    let vatTotal = ZERO;
    let grossTotal = ZERO;
    const itemsData = priced.map((row, idx) => {
      const p = row.priced;
      const vatBase = p.vatBase;
      const vatAmount = isExport ? ZERO : p.vatAmount;
      const lineTotal = vatBase.add(vatAmount);
      netTotal = netTotal.add(vatBase);
      vatTotal = vatTotal.add(vatAmount);
      grossTotal = grossTotal.add(lineTotal);
      return {
        lineNo: idx + 1,
        itemId: row.input.itemId ?? null,
        description: row.input.description ?? null,
        quantity: p.quantity,
        unitPrice: p.unitPrice,
        discountPercent: p.discountPercent,
        cashDiscountPercent: p.cashDiscountPercent,
        vatRateCode: isExport ? "0" : p.vatRateCode,
        vatBase,
        vatAmount,
        lineTotal,
      };
    });

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
          currency,
          isExport,
          netTotal,
          vatTotal,
          grossTotal,
          status: "DRAFT",
          poNumber: dto.poNumber?.trim() || null,
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

  async getInvoice(id: number) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id },
      include: { items: { orderBy: { lineNo: "asc" } } },
    });
    if (!invoice) throw new NotFoundException(`Račun ${id} ne postoji.`);
    return invoice;
  }

  // ── KNJIŽENJE (level 0) ──────────────────────────────────────────────────────

  /**
   * Proknjiži račun: rezerviši definitivan broj + kreiraj nalog GK. Idempotentno
   * (već-knjižen račun status ≠ DRAFT → ConflictException).
   */
  async postInvoice(id: number, actor: AuthUser) {
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

    const year = invoice.documentDate.getFullYear();

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
          // konta / saldakonti / bilans čitaju SAMO status IN ('posted','locked') —
          // draft nalog je nevidljiv. Zato preuzeti nalog promovišemo u `posted` u istoj
          // tx (odluka O4 default, kao izvod u PR #8). markPosted idiom = status guard:
          // CAS `where status='draft'` menja SAMO draft; posted/locked ostaje netaknut
          // (idempotentno — račun čiji je robni nalog već proknjižen/zaključan se ne dira).
          if (existing.status === "draft") {
            await tx.journalEntry.updateMany({
              where: { id: existing.id, status: "draft" },
              data: { status: "posted" },
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
          updatedByUserId: actor.userId,
        },
        include: { items: { orderBy: { lineNo: "asc" } } },
      });

      return posted;
    });
  }

  /**
   * Ručni nalog GK za račun (IFUSL/uslužni ili bez robnog izlaza). Balans-kontrola.
   *   kupac (2040 / 2050 izvoz) DUG  = O + P + Q
   *   prihod (6040 roba / 6140 usluga) POT = O
   *   PDV 4702 (20%) / 4710 (10%) POT = P / Q   (izvoz: bez PDV)
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
      vatAmount: Prisma.Decimal;
    }>,
  ): Promise<number> {
    // Agregati O (osnovica), P (PDV 20%), Q (PDV 10%) po stavkama.
    const lines =
      items ??
      (await tx.invoiceItem.findMany({
        where: { invoiceId: invoice.id },
        select: { vatRateCode: true, vatBase: true, vatAmount: true },
      }));

    let baseO = ZERO; // Σ osnovica
    let vatP = ZERO; // Σ PDV 20%
    let vatQ = ZERO; // Σ PDV 10%
    for (const l of lines) {
      baseO = baseO.add(l.vatBase);
      if (invoice.isExport) continue; // izvoz bez PDV
      if (l.vatRateCode === "2") vatQ = vatQ.add(l.vatAmount);
      else vatP = vatP.add(l.vatAmount); // 20% default (kod "3"/"1")
    }

    const customerAcc = invoice.isExport
      ? ACC_CUSTOMER_EXPORT
      : ACC_CUSTOMER_DOMESTIC;
    const revenueAcc = SERVICE_TYPES.has(invoice.documentType)
      ? ACC_REVENUE_SERVICE
      : ACC_REVENUE_GOODS;

    const customerDebit = baseO.add(vatP).add(vatQ);
    const analyticalCode = invoice.customerId;

    const draftLines: LedgerLineDraft[] = [
      {
        accountCode: customerAcc,
        analyticalCode,
        debit: customerDebit,
        credit: ZERO,
        description: `Kupac ${invoice.documentNumber}`,
      },
      {
        accountCode: revenueAcc,
        analyticalCode: null,
        debit: ZERO,
        credit: baseO,
        description: `Prihod ${invoice.documentNumber}`,
      },
    ];
    if (!invoice.isExport) {
      if (!vatP.isZero())
        draftLines.push({
          accountCode: ACC_VAT_OUT_20,
          analyticalCode: null,
          debit: ZERO,
          credit: vatP,
          description: `PDV 20% ${invoice.documentNumber}`,
        });
      if (!vatQ.isZero())
        draftLines.push({
          accountCode: ACC_VAT_OUT_10,
          analyticalCode: null,
          debit: ZERO,
          credit: vatQ,
          description: `PDV 10% ${invoice.documentNumber}`,
        });
    }

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
        // kartici konta / bilansu, koji čitaju SAMO status IN ('posted','locked') (kartica)
        // odn. status = 'posted' (open-items). Draft nalog = proknjižen račun bez ijedne
        // otvorene stavke (kupac tiho van saldakonta). Isti obrazac kao izvod (PR #8) i
        // PostingEngine.postManualEntry (posting.service.ts:229). Odluka O4 default.
        status: "posted",
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
    const last = await tx.journalEntry.findFirst({
      where: { companyId, orderTypeCode: orderType, year },
      orderBy: { number: "desc" },
      select: { number: true },
    });
    const next = (last ? parseInt(last.number, 10) : 0) + 1;
    return String(next).padStart(4, "0");
  }
}
