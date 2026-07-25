import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { PostingEngineService } from "../gl/posting/posting.service";
import { DocumentNumberSequenceService } from "./numbering.service";
import { grossToNet } from "../pdv/vat-bridge.util";
import type { AuthUser } from "../auth/jwt.strategy";
import {
  type ApplyAdvanceDto,
  type CreateAdvanceInvoiceDto,
  type MarkAdvancePaidDto,
  validateApplyAdvance,
  validateCreateAdvanceInvoice,
  validateMarkAdvancePaid,
} from "./dto/advance-invoice.dto";

/**
 * AVANSNI RAČUN — izlazni (AVR, `advanceDirection='out'`). Batch C §C1a.
 * =============================================================================
 * Poslovni tok (tri koraka, svaki svoja transakcija):
 *
 *   1) createAdvanceInvoice — iz PREDRAČUNA (PON/PROF, level 250) nastaje AVR
 *      (level 0, broj iz `DocumentNumberSequence` šifre 'AVR'). Iznos avansa je
 *      BRUTO i razbija se na osnovicu + PDV PRERAČUNATOM stopom (`grossToNet`
 *      iz pdv/vat-bridge.util — jedina tačka istine za taj račun).
 *      GL se OVDE NE DIRA (izdavanje avansnog računa nije poreski događaj).
 *
 *   2) markAdvancePaid — NAPLATA avansa. PDV obaveza po avansu nastaje
 *      NAPLATOM, ne izdavanjem (ZPDV čl. 16 t.2), pa se tek ovde knjiži:
 *          kupac 2040 (2050 izvoz)  DUG = bruto avansa
 *          primljeni avansi 4300    POT = osnovica
 *          PDV 4720 (20%) / 4730 (10%) POT = PDV
 *      Anti-dvoklik: CAS `updateMany({ advancePaidAt: null })` — druga tx
 *      dobija count 0 → 409 (bez duplog naloga).
 *
 *   3) applyAdvance — KONAČNI račun odbija avans. `grossTotal` konačnog računa
 *      se NE menja (avans umanjuje samo IZNOS ZA PLAĆANJE:
 *      `payableAmount = grossTotal − advanceAppliedAmount`). GL storno avansa:
 *          primljeni avansi 4300    DUG = osnovica avansa
 *          PDV 4720 / 4730          DUG = PDV avansa
 *          kupac 2040 (2050)        POT = bruto avansa
 *      Prihod se priznaje SAMO jednom — na konačnom računu, ne na avansu.
 *      Anti-duplo: parcijalni unique `uq_invoices_advance_applied_once` nad
 *      (advance_invoice_id) WHERE status <> 'CANCELLED' → P2002 se hvata i
 *      prevodi u 409 (jedan AVR se sme odbiti samo na JEDNOM računu).
 *
 * Konta i obrazac ručnog naloga su PREUZETI iz `fakturisanje.service.ts`
 * (ista konstanta 2040/2050, namenski PDV par 4720/4730, ista vrsta naloga 'IF', isti
 * `PostingEngineService.postManualEntry` mehanizam sa balans-kontrolom).
 * Novac je `Prisma.Decimal` svuda (BACKEND_RULES §3 — nikad Float).
 */

const D = Prisma.Decimal;
const ZERO = new D(0);

/** Konta ručnog knjiženja — identična `fakturisanje.service.ts` (doc 43 / PLAN_FAZA_5 §A). */
const ACC_CUSTOMER_DOMESTIC = "2040"; // kupci u zemlji
const ACC_CUSTOMER_EXPORT = "2050"; // kupci u inostranstvu
const ACC_ADVANCES_RECEIVED = "4300"; // primljeni avansi, depoziti i kaucije

// PDV po avansima ide na NAMENSKA konta 4720/4730 („PDV po primljenim avansima"),
// ne na 4702/4710 koja nose PDV po izdatim (konačnim) fakturama. Oba para postoje u
// kontnom planu (seed 20260723155000); razdvajanje je bitno jer se obaveza po avansu
// pri konačnom računu stornira, a obaveza po fakturi ostaje.
// TODO(potvrda Nesa): potvrditi 4720/4730 pre prve produkcijske naplate avansa.
const ACC_VAT_ADVANCE_20 = "4720"; // PDV po primljenim avansima 20%
const ACC_VAT_ADVANCE_10 = "4730"; // PDV po primljenim avansima 10%

/** Vrsta naloga za ručno knjiženje računa prodaje (isto kao fakturisanje). */
const ORDER_TYPE_SALES = "IF";

/** Vrsta dokumenta avansnog računa + smer (šifra 'AVR' postoji u numbering.service). */
const ADVANCE_TYPE = "AVR";
const ADVANCE_DIRECTION_OUT = "out";

/** Izvorne vrste iz kojih se pravi avansni račun (predračun/ponuda, level 250). */
const PROFORMA_TYPES = new Set(["PON", "PROF"]);

/**
 * Nominalna PDV stopa (u PROCENTIMA) po `vatRateCode`. Isti katalog kao privatni
 * `VAT_RATE_BY_CODE` u `pricing.service.ts` (tamo kao koeficijent, ovde u
 * procentima jer `grossToNet` prima procenat); pricing ga ne izvozi.
 */
const VAT_PERCENT_BY_CODE: Readonly<Record<string, number>> = {
  "3": 20, // Osnovna / VISA
  "1": 20, // Osnovna (alt kod)
  "2": 10, // Zeleznica / NIZA
  "4": 8, // Posebna / POLJO
  "0": 0, // bez PDV (izvoz / oslobođeno)
};

/** Advisory-lock namespace za serijalizaciju „jedan AVR po predračunu". */
const ADVISORY_NS_ADVANCE_PER_PROFORMA = 4002;

/** Minimalni oblik stavke iz koga se čita PDV stopa dokumenta. */
interface VatRateSource {
  vatRateCode: string;
  vatBase: Prisma.Decimal;
}

/**
 * Linija ručnog naloga GK — podskup ulaza `PostingEngineService.postManualEntry`.
 * Iznosi idu kao STRING (`Decimal.toFixed(4)`) da se nigde ne provuče Float.
 */
interface ManualLine {
  accountCode: string;
  analyticalCode: number | null;
  debit: string;
  credit: string;
  description: string;
  documentNumber: string;
  dueDate: Date | null;
  currency: string;
}

/** Osnovica + PDV izvedeni iz bruto avansa. */
interface AdvanceSplit {
  net: Prisma.Decimal;
  vat: Prisma.Decimal;
  gross: Prisma.Decimal;
  vatRateCode: string;
  vatPercent: number;
}

@Injectable()
export class AdvanceInvoiceService {
  private readonly logger = new Logger(AdvanceInvoiceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: DocumentNumberSequenceService,
    private readonly posting: PostingEngineService,
  ) {}

  // ── 1) KREIRANJE AVR IZ PREDRAČUNA ──────────────────────────────────────────

  /**
   * Napravi avansni račun (AVR) iz predračuna. Bez knjiženja — GL nastaje tek
   * naplatom (`markAdvancePaid`).
   *
   * @throws NotFoundException predračun ne postoji
   * @throws UnprocessableEntityException izvor nije predračun / iznos van opsega
   * @throws ConflictException za predračun već postoji nestorniran AVR
   */
  async createAdvanceInvoice(dto: CreateAdvanceInvoiceDto, actor: AuthUser) {
    const input = validateCreateAdvanceInvoice(dto);

    return this.prisma.$transaction(async (tx) => {
      // Serijalizuj po predračunu: guard „već postoji AVR" je read-then-write i
      // dve paralelne tx bi obe videle „nema AVR-a" → dva avansna računa za isti
      // predračun (nema DB constrainta koji to hvata). Isti idiom kao
      // posting.service (pg_advisory_xact_lock nad izvornim dokumentom).
      // ::int kastovi obavezni — v. isti komentar u posting.service (Prisma vezuje
      // brojeve kao bigint, a Postgres nema pg_advisory_xact_lock(bigint, bigint)).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADVISORY_NS_ADVANCE_PER_PROFORMA}::int, ${input.proformaId}::int)`;

      const proforma = await tx.invoice.findUnique({
        where: { id: input.proformaId },
        include: { items: { orderBy: { lineNo: "asc" } } },
      });
      if (!proforma) {
        throw new NotFoundException(
          `Predračun ${input.proformaId} ne postoji.`,
        );
      }
      if (
        !PROFORMA_TYPES.has(proforma.documentType) ||
        proforma.level !== 250
      ) {
        throw new UnprocessableEntityException(
          `Dokument ${input.proformaId} nije predračun/ponuda (vrsta ` +
            `${proforma.documentType}, level ${proforma.level}) — avansni račun ` +
            `se izdaje samo po predračunu.`,
        );
      }
      if (proforma.status === "CANCELLED") {
        throw new UnprocessableEntityException(
          `Predračun ${proforma.documentNumber} je storniran — avansni račun se ne izdaje.`,
        );
      }
      if (proforma.customerId == null) {
        throw new UnprocessableEntityException(
          `Predračun ${proforma.documentNumber} nema kupca — avansni račun se ne može izdati.`,
        );
      }
      if (!proforma.grossTotal.greaterThan(ZERO)) {
        throw new UnprocessableEntityException(
          `Predračun ${proforma.documentNumber} ima bruto iznos 0 — nema šta da se avansira.`,
        );
      }

      // Iznos avansa je BRUTO: default = ceo bruto predračuna, mora biti > 0 i ≤ bruto.
      const amount =
        input.amount !== null ? new D(input.amount) : proforma.grossTotal;
      if (!amount.greaterThan(ZERO)) {
        throw new UnprocessableEntityException(
          "Iznos avansa mora biti veći od 0.",
        );
      }
      if (amount.greaterThan(proforma.grossTotal)) {
        throw new UnprocessableEntityException(
          `Iznos avansa (${amount.toFixed(2)}) je veći od bruto iznosa predračuna ` +
            `(${proforma.grossTotal.toFixed(2)}).`,
        );
      }

      // ANTI-DUPLO: jedan nestorniran AVR po predračunu.
      const existing = await tx.invoice.findFirst({
        where: {
          documentType: ADVANCE_TYPE,
          copiedFromDocId: proforma.id,
          status: { not: "CANCELLED" },
        },
        select: { id: true, documentNumber: true },
      });
      if (existing) {
        throw new ConflictException(
          `Za predračun ${proforma.documentNumber} već postoji avansni račun ` +
            `${existing.documentNumber} — storniraj ga pa izdaj novi.`,
        );
      }

      // Bruto → osnovica + PDV preračunatom stopom (jedina tačka istine: grossToNet).
      const split = this.splitAdvance(
        amount,
        proforma.items,
        proforma.isExport,
      );

      const documentDate = input.documentDate ?? new Date();
      const year = documentDate.getFullYear();
      const documentNumber = await this.numbering.next(
        tx,
        ADVANCE_TYPE,
        year,
        proforma.companyId,
      );

      // AVR je izdat dokument sa definitivnim brojem (level 0, POSTED + isLocked):
      // knjiženje mu ide kroz markAdvancePaid, a izmena/storno kroz standardni
      // storno put (D8 — zaključan dokument menja samo storno).
      return tx.invoice.create({
        data: {
          documentType: ADVANCE_TYPE,
          documentNumber,
          level: 0,
          companyId: proforma.companyId,
          customerId: proforma.customerId,
          documentDate,
          dueDate: proforma.dueDate,
          currency: proforma.currency,
          exchangeRate: proforma.exchangeRate,
          accountingExchangeRate: proforma.accountingExchangeRate,
          isExport: proforma.isExport,
          netTotal: split.net,
          vatTotal: split.vat,
          grossTotal: split.gross,
          copiedFromDocId: proforma.id,
          advanceDirection: ADVANCE_DIRECTION_OUT,
          status: "POSTED",
          isLocked: true,
          poNumber: proforma.poNumber,
          salespersonId: proforma.salespersonId,
          createdByUserId: actor.userId,
          updatedByUserId: actor.userId,
          // Jedna stavka: SEF/UBL i štampa iteriraju po stavkama — AVR bez stavke
          // bi dao prazan UBL i „Račun nema stavki." na PDF-u.
          items: {
            create: [
              {
                lineNo: 1,
                itemId: null,
                description: `Avans po predračunu ${proforma.documentNumber}`,
                quantity: new D(1),
                unitPrice: split.net,
                vatRateCode: split.vatRateCode,
                vatBase: split.net,
                vatAmount: split.vat,
                lineTotal: split.gross,
              },
            ],
          },
        },
        include: { items: { orderBy: { lineNo: "asc" } } },
      });
    });
  }

  // ── 2) NAPLATA AVANSA (PDV obaveza nastaje NAPLATOM) ────────────────────────

  /**
   * Zabeleži naplatu avansa i proknjiži PDV obavezu po avansu.
   * Idempotentno kroz CAS nad `advancePaidAt` — dvoklik NE knjiži dva puta.
   *
   * @throws NotFoundException AVR ne postoji
   * @throws UnprocessableEntityException dokument nije AVR / iznos van opsega
   * @throws ConflictException avans je već naplaćen (ili storniran)
   */
  async markAdvancePaid(dto: MarkAdvancePaidDto, actor: AuthUser) {
    const input = validateMarkAdvancePaid(dto);

    const advance = await this.prisma.invoice.findUnique({
      where: { id: input.advanceInvoiceId },
      include: { items: { orderBy: { lineNo: "asc" } } },
    });
    if (!advance) {
      throw new NotFoundException(
        `Avansni račun ${input.advanceInvoiceId} ne postoji.`,
      );
    }
    if (advance.documentType !== ADVANCE_TYPE) {
      throw new UnprocessableEntityException(
        `Dokument ${advance.documentNumber} nije avansni račun (vrsta ${advance.documentType}).`,
      );
    }
    if (advance.status === "CANCELLED") {
      throw new ConflictException(
        `Avansni račun ${advance.documentNumber} je storniran — naplata se ne knjiži.`,
      );
    }
    if (advance.advancePaidAt != null) {
      throw new ConflictException(
        `Avansni račun ${advance.documentNumber} je već naplaćen ` +
          `(${advance.advancePaidAt.toISOString().slice(0, 10)}).`,
      );
    }
    if (advance.customerId == null) {
      throw new UnprocessableEntityException(
        `Avansni račun ${advance.documentNumber} nema kupca — naplata se ne može proknjižiti.`,
      );
    }

    const amount = new D(input.amount);
    if (!amount.greaterThan(ZERO)) {
      throw new UnprocessableEntityException(
        "Naplaćen iznos avansa mora biti veći od 0.",
      );
    }
    if (amount.greaterThan(advance.grossTotal)) {
      throw new UnprocessableEntityException(
        `Naplaćen iznos (${amount.toFixed(2)}) je veći od iznosa avansnog računa ` +
          `(${advance.grossTotal.toFixed(2)}).`,
      );
    }

    const split = this.splitAdvance(amount, advance.items, advance.isExport);
    const customerId = advance.customerId;

    return this.prisma.$transaction(async (tx) => {
      // CAS: samo prelaz „nenaplaćen → naplaćen" prolazi. Dvoklik/paralelni poziv
      // dobija count 0 → 409, pa nalog GK nastaje TAČNO jednom.
      const claimed = await tx.invoice.updateMany({
        where: {
          id: advance.id,
          advancePaidAt: null,
          status: { not: "CANCELLED" },
        },
        data: {
          advancePaidAt: input.paidAt,
          advancePaidAmount: amount,
          // POSTED → PAID; ne gazi SEF-om postavljen status (SENT/…).
          ...(advance.status === "POSTED" ? { status: "PAID" } : {}),
          updatedByUserId: actor.userId,
        },
      });
      if (claimed.count !== 1) {
        throw new ConflictException(
          `Avansni račun ${advance.documentNumber} je u međuvremenu naplaćen ili storniran.`,
        );
      }

      const customerAcc = advance.isExport
        ? ACC_CUSTOMER_EXPORT
        : ACC_CUSTOMER_DOMESTIC;

      // kupac DUG = bruto; primljeni avansi POT = osnovica; PDV POT = PDV.
      const lines: ManualLine[] = [
        {
          accountCode: customerAcc,
          analyticalCode: customerId,
          debit: split.gross.toFixed(4),
          credit: "0",
          description: `Kupac — avans ${advance.documentNumber}`,
          documentNumber: advance.documentNumber,
          dueDate: advance.dueDate,
          currency: advance.currency,
        },
        {
          accountCode: ACC_ADVANCES_RECEIVED,
          analyticalCode: customerId,
          debit: "0",
          credit: split.net.toFixed(4),
          description: `Primljeni avans ${advance.documentNumber}`,
          documentNumber: advance.documentNumber,
          dueDate: null,
          currency: advance.currency,
        },
      ];
      const vatAccount = this.vatAccountFor(split.vatPercent);
      if (split.vat.greaterThan(ZERO) && vatAccount) {
        lines.push({
          accountCode: vatAccount,
          analyticalCode: null,
          debit: "0",
          credit: split.vat.toFixed(4),
          description: `PDV ${split.vatPercent}% po avansu ${advance.documentNumber}`,
          documentNumber: advance.documentNumber,
          dueDate: null,
          currency: advance.currency,
        });
      }

      const entry = await this.posting.postManualEntry(tx, {
        orderType: ORDER_TYPE_SALES,
        documentDate: input.paidAt,
        companyId: advance.companyId,
        description: `Naplata avansa ${advance.documentNumber}`,
        createdByUserId: actor.userId,
        lines,
      });

      const updated = await tx.invoice.update({
        where: { id: advance.id },
        data: { journalEntryId: entry.journalEntryId },
        include: { items: { orderBy: { lineNo: "asc" } } },
      });

      this.logger.log(
        `Avans ${advance.documentNumber} naplaćen ${input.paidAt
          .toISOString()
          .slice(0, 10)}: bruto ${split.gross.toFixed(2)} (osnovica ` +
          `${split.net.toFixed(2)} + PDV ${split.vat.toFixed(2)}), nalog ${entry.number}.`,
      );

      return {
        ...updated,
        journalEntryId: entry.journalEntryId,
        journalEntryNumber: entry.number,
        netAmount: split.net,
        vatAmount: split.vat,
      };
    });
  }

  // ── 3) KONAČNI RAČUN ODBIJA AVANS ───────────────────────────────────────────

  /**
   * Odbij naplaćen avans na konačnom računu. `grossTotal` konačnog računa se NE
   * menja — avans umanjuje samo IZNOS ZA PLAĆANJE (`payableAmount`).
   *
   * @throws NotFoundException račun / AVR ne postoji
   * @throws UnprocessableEntityException avans nije naplaćen, drugi kupac,
   *         iznos veći od računa, račun je draft/storniran
   * @throws ConflictException avans je već odbijen (na ovom ili drugom računu)
   */
  async applyAdvance(dto: ApplyAdvanceDto, actor: AuthUser) {
    const input = validateApplyAdvance(dto);

    const [invoice, advance] = await Promise.all([
      this.prisma.invoice.findUnique({ where: { id: input.invoiceId } }),
      this.prisma.invoice.findUnique({
        where: { id: input.advanceInvoiceId },
        include: { items: { orderBy: { lineNo: "asc" } } },
      }),
    ]);
    if (!invoice) {
      throw new NotFoundException(`Račun ${input.invoiceId} ne postoji.`);
    }
    if (!advance) {
      throw new NotFoundException(
        `Avansni račun ${input.advanceInvoiceId} ne postoji.`,
      );
    }
    if (advance.documentType !== ADVANCE_TYPE) {
      throw new UnprocessableEntityException(
        `Dokument ${advance.documentNumber} nije avansni račun (vrsta ${advance.documentType}).`,
      );
    }
    if (invoice.documentType === ADVANCE_TYPE) {
      throw new UnprocessableEntityException(
        "Avans se ne može odbiti na drugom avansnom računu.",
      );
    }
    if (invoice.status === "CANCELLED" || advance.status === "CANCELLED") {
      throw new UnprocessableEntityException(
        "Storniran dokument ne učestvuje u odbijanju avansa.",
      );
    }
    // GL storno avansa se knjiži odmah, pa konačni račun mora biti proknjižen
    // (draft nema definitivan broj ni nalog — avans bi zatvarao „ništa").
    if (invoice.status === "DRAFT" || invoice.level !== 0) {
      throw new UnprocessableEntityException(
        `Račun ${invoice.documentNumber} nije proknjižen — avans se odbija tek na ` +
          `proknjiženom (konačnom) računu.`,
      );
    }
    // PDV obaveza po avansu nastaje NAPLATOM: nenaplaćen avans nema šta da se stornira.
    if (advance.advancePaidAt == null) {
      throw new UnprocessableEntityException(
        `Avansni račun ${advance.documentNumber} nije naplaćen — nenaplaćen avans se ` +
          `ne može odbiti na računu.`,
      );
    }
    if (
      invoice.customerId == null ||
      advance.customerId == null ||
      invoice.customerId !== advance.customerId
    ) {
      throw new UnprocessableEntityException(
        `Avansni račun ${advance.documentNumber} glasi na drugog kupca — avans se ` +
          `odbija samo na računu istog kupca.`,
      );
    }
    if (invoice.advanceInvoiceId != null) {
      throw new ConflictException(
        `Na računu ${invoice.documentNumber} je već odbijen avans ` +
          `(dokument ${invoice.advanceInvoiceId}).`,
      );
    }

    const applied = advance.advancePaidAmount;
    if (!applied.greaterThan(ZERO)) {
      throw new UnprocessableEntityException(
        `Avansni račun ${advance.documentNumber} nema naplaćen iznos.`,
      );
    }
    if (applied.greaterThan(invoice.grossTotal)) {
      throw new UnprocessableEntityException(
        `Naplaćen avans (${applied.toFixed(2)}) je veći od iznosa računa ` +
          `(${invoice.grossTotal.toFixed(2)}) — avans se ne može odbiti u celosti.`,
      );
    }

    // Osnovica/PDV avansa se IZVODE isto kao pri naplati (ista funkcija, isti ulaz)
    // → storno pogađa cent u cent iznose iz naloga naplate.
    const split = this.splitAdvance(applied, advance.items, advance.isExport);
    const customerId = invoice.customerId;

    return this.prisma.$transaction(async (tx) => {
      // CAS + parcijalni unique `uq_invoices_advance_applied_once`: jedan AVR sme
      // biti odbijen na TAČNO JEDNOM nestorniranom računu.
      let claimedCount: number;
      try {
        const claimed = await tx.invoice.updateMany({
          where: {
            id: invoice.id,
            advanceInvoiceId: null,
            status: { not: "CANCELLED" },
          },
          data: {
            advanceInvoiceId: advance.id,
            advanceAppliedAmount: applied,
            updatedByUserId: actor.userId,
          },
        });
        claimedCount = claimed.count;
      } catch (err) {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === "P2002"
        ) {
          throw new ConflictException(
            `Avansni račun ${advance.documentNumber} je već odbijen na drugom računu.`,
          );
        }
        throw err;
      }
      if (claimedCount !== 1) {
        throw new ConflictException(
          `Na računu ${invoice.documentNumber} je u međuvremenu već odbijen avans.`,
        );
      }

      const customerAcc = advance.isExport
        ? ACC_CUSTOMER_EXPORT
        : ACC_CUSTOMER_DOMESTIC;

      // Storno avansa: 4300 DUG = osnovica, PDV DUG = PDV, kupac POT = bruto.
      // (Prihod se priznaje SAMO na konačnom računu — ovde se prihod ne dira.)
      const lines: ManualLine[] = [
        {
          accountCode: ACC_ADVANCES_RECEIVED,
          analyticalCode: customerId,
          debit: split.net.toFixed(4),
          credit: "0",
          description: `Zatvaranje avansa ${advance.documentNumber}`,
          documentNumber: invoice.documentNumber,
          dueDate: null,
          currency: invoice.currency,
        },
        {
          accountCode: customerAcc,
          analyticalCode: customerId,
          debit: "0",
          credit: split.gross.toFixed(4),
          description: `Kupac — odbijen avans ${advance.documentNumber}`,
          documentNumber: invoice.documentNumber,
          dueDate: invoice.dueDate,
          currency: invoice.currency,
        },
      ];
      const vatAccount = this.vatAccountFor(split.vatPercent);
      if (split.vat.greaterThan(ZERO) && vatAccount) {
        lines.push({
          accountCode: vatAccount,
          analyticalCode: null,
          debit: split.vat.toFixed(4),
          credit: "0",
          description: `Storno PDV ${split.vatPercent}% po avansu ${advance.documentNumber}`,
          documentNumber: invoice.documentNumber,
          dueDate: null,
          currency: invoice.currency,
        });
      }

      const entry = await this.posting.postManualEntry(tx, {
        orderType: ORDER_TYPE_SALES,
        documentDate: invoice.documentDate,
        companyId: invoice.companyId,
        description: `Odbijanje avansa ${advance.documentNumber} na računu ${invoice.documentNumber}`,
        createdByUserId: actor.userId,
        lines,
      });

      const updated = await tx.invoice.findUnique({
        where: { id: invoice.id },
        include: { items: { orderBy: { lineNo: "asc" } } },
      });
      if (!updated) {
        throw new NotFoundException(`Račun ${invoice.id} ne postoji.`);
      }

      this.logger.log(
        `Avans ${advance.documentNumber} (${applied.toFixed(2)}) odbijen na računu ` +
          `${invoice.documentNumber}; za uplatu ostaje ` +
          `${invoice.grossTotal.sub(applied).toFixed(2)}; storno-nalog ${entry.number}.`,
      );

      return {
        ...updated,
        advanceInvoiceNumber: advance.documentNumber,
        payableAmount: computePayableAmount(updated),
        advanceClosingEntryId: entry.journalEntryId,
        advanceClosingEntryNumber: entry.number,
      };
    });
  }

  // ── pomoćno ─────────────────────────────────────────────────────────────────

  /**
   * BRUTO avans → osnovica + PDV preračunatom stopom. Stopa se izvodi iz stavki
   * izvornog dokumenta (dominantna po osnovici); izvoz je uvek 0% (kategorija Z).
   * Račun ide isključivo kroz `grossToNet` (pdv/vat-bridge.util) — zbir uvek
   * zatvara (osnovica + PDV === bruto do na cent).
   */
  private splitAdvance(
    gross: Prisma.Decimal,
    items: VatRateSource[],
    isExport: boolean,
  ): AdvanceSplit {
    const vatRateCode = isExport ? "0" : this.resolveVatRateCode(items);
    const vatPercent = VAT_PERCENT_BY_CODE[vatRateCode] ?? 20;
    const { net, vat } = grossToNet(gross, vatPercent);
    return { net, vat, gross: net.add(vat), vatRateCode, vatPercent };
  }

  /**
   * Dominantna PDV šifra dokumenta = šifra sa najvećom zbirnom osnovicom.
   * Mešovit dokument (20% + 10%) se loguje jer avans nosi JEDNU stopu — ostatak
   * se poravnava na konačnom računu.
   */
  private resolveVatRateCode(items: VatRateSource[]): string {
    if (!items.length) return "3";
    const byCode = new Map<string, Prisma.Decimal>();
    for (const it of items) {
      const code = it.vatRateCode || "3";
      byCode.set(code, (byCode.get(code) ?? ZERO).add(it.vatBase));
    }
    if (byCode.size > 1) {
      this.logger.warn(
        `Dokument ima stavke sa više PDV stopa (${[...byCode.keys()].join(", ")}) — ` +
          `avans se obračunava po dominantnoj stopi.`,
      );
    }
    let best = "3";
    let bestBase: Prisma.Decimal | null = null;
    for (const [code, base] of byCode) {
      if (bestBase === null || base.greaterThan(bestBase)) {
        best = code;
        bestBase = base;
      }
    }
    return best;
  }

  /** Konto PDV-a po primljenom avansu (namenski par, ne konta konačnih faktura). */
  private vatAccountFor(vatPercent: number): string | null {
    if (vatPercent === 20) return ACC_VAT_ADVANCE_20;
    if (vatPercent === 10) return ACC_VAT_ADVANCE_10;
    return null; // 0% (izvoz/oslobođeno) — bez PDV linije
  }
}

/**
 * IZNOS ZA PLAĆANJE = bruto računa − odbijen avans. `grossTotal` ostaje netaknut
 * (avans ne menja ni prihod ni PDV konačnog računa — samo obavezu za uplatu).
 * Izvezeno da isti račun koriste i detalj fakture i štampa.
 */
export function computePayableAmount(invoice: {
  grossTotal: Prisma.Decimal;
  advanceAppliedAmount: Prisma.Decimal;
}): Prisma.Decimal {
  const payable = invoice.grossTotal.sub(invoice.advanceAppliedAmount);
  return payable.greaterThan(ZERO) ? payable : ZERO;
}
