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
import { assertVatPeriodNotLocked } from "../pdv/vat-period-lock";
import {
  APPLICATION_ACTIVE,
  computeAdvanceDeductions,
  computeAdvanceUsage,
  loadAdvanceLinkedInvoices,
} from "./advance-deduction";
import type { AuthUser } from "../auth/jwt.strategy";
import {
  type ApplyAdvanceDto,
  type CreateAdvanceInvoiceDto,
  type MarkAdvancePaidDto,
  type NormalizedCreateAdvanceInvoice,
  validateApplyAdvance,
  validateCreateAdvanceInvoice,
  validateMarkAdvancePaid,
} from "./dto/advance-invoice.dto";

/**
 * AVANSNI RAČUN — izlazni (AVR, `advanceDirection='out'`). Batch C §C1a.
 * =============================================================================
 * Poslovni tok (tri koraka, svaki svoja transakcija):
 *
 *   1) createAdvanceInvoice — AVR (level 0, broj iz `DocumentNumberSequence` šifre
 *      'AVR') nastaje NA DVA NAČINA:
 *        (a) iz PREDRAČUNA (PON/PROF, level 250) — kupac/valuta/izvoz/stopa se
 *            preuzimaju sa predračuna, uz anti-duplo „jedan AVR po predračunu";
 *        (b) BEZ IZVORA, po UGOVORU — `customerId` + `amount` + `basis` (broj
 *            ugovora / opis osnova, upisuje se u `Invoice.advanceBasis`).
 *      Razlog za (b): u BigBit produkciji 2025. dva NAJVEĆA avansa (po 535+ mil.
 *      RSD, `AVR-00001/2025` i `AVR-00017/2025`) izdata su po Ugovoru, ne po
 *      predračunu (doc BIGBIT_IZLAZNE_FAKTURE_I_AVANSI §4.1, gap G5).
 *      Iznos avansa je BRUTO i razbija se na osnovicu + PDV PRERAČUNATOM stopom
 *      (`grossToNet` iz pdv/vat-bridge.util — jedina tačka istine za taj račun).
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
 *      `payableAmount = grossTotal − Σ primena na tom računu`). GL storno avansa
 *      (po SVAKOJ primeni zaseban nalog):
 *          primljeni avansi 4300    DUG = osnovica primene
 *          PDV 4720 / 4730          DUG = PDV primene
 *          kupac 2040 (2050)        POT = bruto primene
 *      Prihod se priznaje SAMO jednom — na konačnom računu, ne na avansu.
 *
 *      VEZA JE N:M (migracija 20260726120000, tabela `invoice_advance_applications`):
 *      jedan avans se deli na više računa (BigBit `AVR-00013/2025` → `IFR 353/25`
 *      20.802 + `IFR 370/25` 17.100) i jedan račun zatvara više avansa
 *      (`IFUSL 059/25` ← 6 avansa). Kontrole:
 *        • Σ AKTIVNIH primena po avansu ≤ NAPLAĆEN iznos avansa → 422;
 *        • Σ AKTIVNIH primena po računu ≤ bruto računa → 422;
 *        • isti avans dvaput na ISTOM računu → 409 (parcijalni unique
 *          `uq_invoice_advance_app_active`, P2002 → 409);
 *        • zbirovi se čitaju pod `pg_advisory_xact_lock` (račun pa avans, uvek tim
 *          redom) — bez toga dve paralelne primene obe vide „ima još avansa".
 *      Kolone `invoices.advance_invoice_id` / `advance_applied_amount` /
 *      `advance_closing_entry_id` ostaju kao DENORMALIZACIJA (prva primena + zbir)
 *      radi SEF-a, štampe, FE-a i pdv modula.
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
/**
 * Advisory-lock namespace-i za primenu avansa. Uzimaju se UVEK istim redom
 * (prvo račun, pa avans) — obrnut redosled u drugoj sesiji bi dao deadlock.
 */
const ADVISORY_NS_APPLY_ON_INVOICE = 4003;
const ADVISORY_NS_APPLY_OF_ADVANCE = 4004;

// Status primene avansa (`invoice_advance_applications.status`) živi uz PRAVILO o
// odbijenom avansu — `./advance-deduction`. Ovde se samo uvozi i koristi.

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

/** Red spojne tabele koji učestvuje u zbirovima primena. */
interface AppliedRow {
  id: number;
  invoiceId: number;
  advanceInvoiceId: number;
  appliedAmount: Prisma.Decimal;
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
   * Napravi avansni račun (AVR) — iz predračuna ili po ugovoru (bez izvora).
   * Bez knjiženja — GL nastaje tek naplatom (`markAdvancePaid`).
   *
   * @throws NotFoundException predračun ne postoji
   * @throws UnprocessableEntityException izvor nije predračun / iznos van opsega /
   *         kupac ne postoji / nepoznata PDV stopa
   * @throws ConflictException za predračun već postoji nestorniran AVR
   */
  async createAdvanceInvoice(dto: CreateAdvanceInvoiceDto, actor: AuthUser) {
    const input = validateCreateAdvanceInvoice(dto);

    // Avans BEZ izvornog dokumenta (po ugovoru): nema predračuna iz koga bi se
    // izveli kupac/iznos, pa ni anti-duplo guard-a — osnov je obavezan tekst.
    if (input.proformaId === null) {
      return this.createAdvanceWithoutSource(input, actor);
    }
    const proformaId = input.proformaId;

    return this.prisma.$transaction(async (tx) => {
      // Serijalizuj po predračunu: guard „već postoji AVR" je read-then-write i
      // dve paralelne tx bi obe videle „nema AVR-a" → dva avansna računa za isti
      // predračun (nema DB constrainta koji to hvata). Isti idiom kao
      // posting.service (pg_advisory_xact_lock nad izvornim dokumentom).
      // ::int kastovi obavezni — v. isti komentar u posting.service (Prisma vezuje
      // brojeve kao bigint, a Postgres nema pg_advisory_xact_lock(bigint, bigint)).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADVISORY_NS_ADVANCE_PER_PROFORMA}::int, ${proformaId}::int)`;

      const proforma = await tx.invoice.findUnique({
        where: { id: proformaId },
        include: { items: { orderBy: { lineNo: "asc" } } },
      });
      if (!proforma) {
        throw new NotFoundException(`Predračun ${proformaId} ne postoji.`);
      }
      if (
        !PROFORMA_TYPES.has(proforma.documentType) ||
        proforma.level !== 250
      ) {
        throw new UnprocessableEntityException(
          `Dokument ${proformaId} nije predračun/ponuda (vrsta ` +
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
          // Osnov se upisuje i kad postoji predračun — izveštaji i štampa avansa
          // traže jedno polje sa osnovom, bez obzira odakle je avans nastao.
          advanceBasis:
            input.basis ?? `Predračun ${proforma.documentNumber}`.slice(0, 255),
          note: input.note,
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

  /**
   * AVR bez izvornog dokumenta — avans po UGOVORU/dogovoru (BigBit gap G5).
   * Kupac, bruto iznos i OSNOV (broj ugovora / opis) su obavezni; PDV stopa se
   * uzima iz `vatRateCode` (default 20%), izvoz nosi 0%.
   *
   * Anti-duplo zaštita ovde NE postoji — nema izvornog dokumenta za koji bi se
   * avans vezao. To je svesna posledica: BigBit je istog kupca po istom ugovoru
   * avansirao u više rata, svaka rata = svoj AVR (doc §4.5 „delimična naplata
   * jednog AVR-a ne postoji, rate su više avansnih računa").
   */
  private async createAdvanceWithoutSource(
    input: NormalizedCreateAdvanceInvoice,
    actor: AuthUser,
  ) {
    // DTO garantuje da su prisutni (validateCreateAdvanceInvoice), ali TS to ne zna.
    const customerId = input.customerId;
    const rawAmount = input.amount;
    if (customerId === null || rawAmount === null || input.basis === null) {
      throw new UnprocessableEntityException(
        "Za avansni račun bez predračuna obavezni su kupac, iznos i osnov.",
      );
    }

    const amount = new D(rawAmount);
    if (!amount.greaterThan(ZERO)) {
      throw new UnprocessableEntityException(
        "Iznos avansa mora biti veći od 0.",
      );
    }

    const isExport = input.isExport ?? false;
    const vatRateCode = isExport ? "0" : (input.vatRateCode ?? "3");
    if (VAT_PERCENT_BY_CODE[vatRateCode] === undefined) {
      throw new UnprocessableEntityException(
        `Nepoznata šifra PDV stope „${vatRateCode}" — dozvoljene su ` +
          `${Object.keys(VAT_PERCENT_BY_CODE).join(", ")}.`,
      );
    }

    const companyId = input.companyId ?? 0;
    const documentDate = input.documentDate ?? new Date();
    const exchangeRate = new D(input.exchangeRate ?? 1);
    const split = this.splitAdvance(
      amount,
      [{ vatRateCode, vatBase: amount }],
      isExport,
    );

    return this.prisma.$transaction(async (tx) => {
      const customer = await tx.customer.findUnique({
        where: { id: customerId },
        select: { id: true, name: true },
      });
      if (!customer) {
        throw new UnprocessableEntityException(
          `Kupac ${customerId} ne postoji u šifarniku komitenata.`,
        );
      }

      const documentNumber = await this.numbering.next(
        tx,
        ADVANCE_TYPE,
        documentDate.getFullYear(),
        companyId,
      );

      return tx.invoice.create({
        data: {
          documentType: ADVANCE_TYPE,
          documentNumber,
          level: 0,
          companyId,
          customerId,
          documentDate,
          currency: input.currency ?? "RSD",
          exchangeRate,
          accountingExchangeRate: exchangeRate,
          isExport,
          netTotal: split.net,
          vatTotal: split.vat,
          grossTotal: split.gross,
          advanceDirection: ADVANCE_DIRECTION_OUT,
          advanceBasis: input.basis,
          note: input.note,
          status: "POSTED",
          isLocked: true,
          createdByUserId: actor.userId,
          updatedByUserId: actor.userId,
          items: {
            create: [
              {
                lineNo: 1,
                itemId: null,
                description: `Avans po osnovu: ${input.basis}`.slice(0, 255),
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
    if (advance.advancePaidAmount.greaterThanOrEqualTo(advance.grossTotal)) {
      throw new ConflictException(
        `Avansni račun ${advance.documentNumber} je već naplaćen u celosti ` +
          `(${advance.advancePaidAmount.toFixed(2)}).`,
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
    // Naplata je KUMULATIVNA: avans se sme platiti u više rata (5.000 pa 7.000 na
    // avans od 12.000). Zbir svih uplata ne sme preći iznos avansnog računa; svaka
    // rata knjiži SVOJ PDV, jer obaveza nastaje naplatom (review Batch C, nalaz 7 —
    // ranije je prva uplata trajno zaključavala avans i ostatak PDV-a nije imao
    // gde da se proknjiži).
    const alreadyPaid = advance.advancePaidAmount;
    if (alreadyPaid.add(amount).greaterThan(advance.grossTotal)) {
      throw new UnprocessableEntityException(
        `Zbir naplata (${alreadyPaid.add(amount).toFixed(2)}) prelazi iznos avansnog ` +
          `računa (${advance.grossTotal.toFixed(2)}). Već naplaćeno: ` +
          `${alreadyPaid.toFixed(2)}, preostalo: ` +
          `${advance.grossTotal.sub(alreadyPaid).toFixed(2)}.`,
      );
    }

    const split = this.splitAdvance(amount, advance.items, advance.isExport);
    const customerId = advance.customerId;

    return this.prisma.$transaction(async (tx) => {
      // PDV obaveza po avansu pada u period NAPLATE, a `paidAt` je slobodan unos.
      // Bez ove provere naplata sa datumom iz već obračunatog perioda uđe u GK, ali
      // je KIF tog perioda zaključan — pa PDV ne uđe ni u jednu prijavu. Ulazni smer
      // je ovu bravu imao od početka; izlazni je nije (review Batch C, nalaz 6).
      await assertVatPeriodNotLocked(tx, input.paidAt.getFullYear(), [
        input.paidAt.getMonth() + 1,
      ]);

      // CAS nad ZATEČENIM zbirom naplata: uslov `advancePaidAmount: alreadyPaid`
      // propušta tačno jednog od paralelnih poziva (dvoklik dobija count 0 → 409),
      // a i dalje dozvoljava sledeću RATU jer se uslov pomera sa svakom uplatom.
      const paidTotal = alreadyPaid.add(amount);
      const fullyPaid = paidTotal.greaterThanOrEqualTo(advance.grossTotal);
      const claimed = await tx.invoice.updateMany({
        where: {
          id: advance.id,
          advancePaidAmount: alreadyPaid,
          status: { not: "CANCELLED" },
        },
        data: {
          // Datum PRVE naplate ostaje — to je dan nastanka PDV obaveze po avansu.
          ...(advance.advancePaidAt == null
            ? { advancePaidAt: input.paidAt }
            : {}),
          advancePaidAmount: paidTotal,
          // POSTED → PAID tek kad je avans naplaćen U CELOSTI; ne gazi SEF status.
          ...(fullyPaid && advance.status === "POSTED"
            ? { status: "PAID" }
            : {}),
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
      // Stopa bez namenskog konta avansnog PDV-a (u kontnom planu postoje samo
      // 4720/20% i 4730/10%) bi tiho izbacila PDV liniju i napravila NEURAVNOTEŽEN
      // nalog — korisnik bi dobio goli 500 umesto objašnjenja (review Batch C, R5).
      if (split.vat.greaterThan(ZERO) && !vatAccount) {
        throw new UnprocessableEntityException(
          `Za PDV stopu ${split.vatPercent}% ne postoji konto avansnog PDV-a — ` +
            `avansni račun je moguć samo po stopi 20% ili 10%.`,
        );
      }
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
   * Odbij (deo) naplaćenog avansa na konačnom računu — JEDNA PRIMENA u tabeli
   * `invoice_advance_applications`. `grossTotal` konačnog računa se NE menja —
   * avans umanjuje samo IZNOS ZA PLAĆANJE (`payableAmount`).
   *
   * Bez `amount` odbija se ceo PREOSTALI (još neiskorišćen) naplaćen iznos avansa,
   * pa se ponašanje 1:1 slučaja ne menja. Sa `amount` se avans deli na više računa
   * (BigBit `AVR-00013/2025` → 20.802 + 17.100).
   *
   * @throws NotFoundException račun / AVR ne postoji
   * @throws UnprocessableEntityException avans nije naplaćen, drugi kupac,
   *         iznos veći od preostalog avansa ili od neodbijenog dela računa,
   *         račun je draft/storniran
   * @throws ConflictException isti avans je već aktivno primenjen na ovom računu
   */
  async applyAdvance(dto: ApplyAdvanceDto, actor: AuthUser) {
    const input = validateApplyAdvance(dto);

    return this.prisma.$transaction(async (tx) => {
      // Zbirovi primena se čitaju pa upisuju (read-then-write) — bez brave dve
      // paralelne primene istog avansa obe vide isti „preostatak" i zajedno ga
      // prekorače. Redosled brava je UVEK račun → avans (obrnut redosled u drugoj
      // sesiji = deadlock). ::int kastovi obavezni (Prisma vezuje bigint).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADVISORY_NS_APPLY_ON_INVOICE}::int, ${input.invoiceId}::int)`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADVISORY_NS_APPLY_OF_ADVANCE}::int, ${input.advanceInvoiceId}::int)`;

      const [invoice, advance] = await Promise.all([
        tx.invoice.findUnique({ where: { id: input.invoiceId } }),
        tx.invoice.findUnique({
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
      // Smer MORA biti izlazni. Ulazni avans (dobavljačev) nikad nije proknjižen u
      // našoj GK kao obaveza po primljenom avansu — njegov storno bi gurnuo 4300 i
      // PDV konto u dugovni saldo i umanjio izlazni PDV bez osnova. Za partnera koji
      // je i kupac i dobavljač ovo je jedan pogrešan klik (review Batch C, nalaz 5).
      if (advance.advanceDirection !== ADVANCE_DIRECTION_OUT) {
        throw new UnprocessableEntityException(
          `Avans ${advance.documentNumber} je PRIMLJEN od dobavljača (ulazni) — ` +
            `na izlaznom računu se odbijaju samo avansi koje smo mi izdali kupcu.`,
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
      if (!advance.advancePaidAmount.greaterThan(ZERO)) {
        throw new UnprocessableEntityException(
          `Avansni račun ${advance.documentNumber} nema naplaćen iznos.`,
        );
      }

      // ── N:M kontrola iznosa ────────────────────────────────────────────────
      // Preostatak avansa = NAPLAĆENO − iskorišćeno (BigBit ovu proveru NEMA — ni
      // constraint ni VBA — pa se avans tamo može prekoračiti; doc §4.5).
      //
      // OBE strane (avans i račun) računa `./advance-deduction` — JEDINO mesto na kome
      // pravilo „Σ aktivnih primena + zatečena 1:1 veza bez svog reda" postoji. Ranije
      // je isti račun stajao ovde prepisan, pa se razišao sa ekranom, štampom i SEF-om
      // (v. zaglavlje `advance-deduction.ts`).
      const advanceApps = await this.activeApplications(tx, {
        advanceInvoiceId: advance.id,
      });
      const invoiceApps = await this.activeApplications(tx, {
        invoiceId: invoice.id,
      });

      // Strana AVANSA: primene ovog avansa + zatečene veze računa koji na njega
      // pokazuju kolonom. Iznos zatečenog dela je `kolona − Σ primena TOG računa`, pa
      // se moraju učitati i tuđe primene tih računa (zato poseban upit, ne kolona).
      const linkedInvoices = await loadAdvanceLinkedInvoices(tx, [advance.id]);
      const advanceUsed = computeAdvanceUsage({
        advanceInvoiceId: advance.id,
        applicationsOfAdvance: advanceApps,
        linkedInvoices,
      }).total;

      // Strana RAČUNA: isto pravilo nad ovim računom.
      const invoiceUsed = computeAdvanceDeductions({
        invoice,
        applications: invoiceApps,
      }).total;

      // Isti avans dvaput na ISTOM računu — gleda se VEZA, ne iznos: zatečena veza
      // čiji je iznos već pokriven primenama ne daje red u `lines`, ali i dalje znači
      // da je taj avans na ovom računu jednom odbijen.
      const duplicatePair =
        invoiceApps.some((a) => a.advanceInvoiceId === advance.id) ||
        invoice.advanceInvoiceId === advance.id;

      const advanceRemaining = advance.advancePaidAmount.sub(advanceUsed);
      const invoiceRemaining = invoice.grossTotal.sub(invoiceUsed);

      // Isti avans dvaput na ISTOM računu = greška unosa (za veći odbitak se
      // stornira postojeća primena). DB to hvata parcijalnim unique-om; ovde je
      // jasna poruka umesto P2002.
      if (duplicatePair) {
        throw new ConflictException(
          `Avansni račun ${advance.documentNumber} je već odbijen na računu ` +
            `${invoice.documentNumber}.`,
        );
      }

      if (!advanceRemaining.greaterThan(ZERO)) {
        throw new UnprocessableEntityException(
          `Avansni račun ${advance.documentNumber} je već iskorišćen u celosti ` +
            `(naplaćeno ${advance.advancePaidAmount.toFixed(2)}, primenjeno ` +
            `${advanceUsed.toFixed(2)}).`,
        );
      }

      const requested =
        input.amount !== null ? new D(input.amount) : advanceRemaining;
      if (!requested.greaterThan(ZERO)) {
        throw new UnprocessableEntityException(
          "Iznos odbitka avansa mora biti veći od 0.",
        );
      }
      if (requested.greaterThan(advanceRemaining)) {
        throw new UnprocessableEntityException(
          `Zbir primena avansa ${advance.documentNumber} bi prešao naplaćeni iznos: ` +
            `traženo ${requested.toFixed(2)}, već primenjeno ${advanceUsed.toFixed(2)} ` +
            `od ${advance.advancePaidAmount.toFixed(2)} — preostalo ` +
            `${advanceRemaining.toFixed(2)}.`,
        );
      }
      if (requested.greaterThan(invoiceRemaining)) {
        throw new UnprocessableEntityException(
          `Iznos odbitka (${requested.toFixed(2)}) je veći od neodbijenog dela računa ` +
            `${invoice.documentNumber} (${invoiceRemaining.toFixed(2)} od ` +
            `${invoice.grossTotal.toFixed(2)}) — odbij manji iznos.`,
        );
      }

      // Osnovica/PDV primene se IZVODE isto kao pri naplati (ista funkcija, isti
      // ulaz) → storno pogađa cent u cent iznose iz naloga naplate. `split.gross`
      // (a ne sirovi `requested`) je merodavan iznos primene, da se zbir u bazi i
      // zbir u GK ne raziđu za zaokruženje.
      const split = this.splitAdvance(
        requested,
        advance.items,
        advance.isExport,
      );
      const applied = split.gross;
      const customerId = invoice.customerId;

      // Storno PDV-a po avansu pada u period konačnog računa — isti razlog kao u
      // `markAdvancePaid` (review Batch C, nalaz 6).
      await assertVatPeriodNotLocked(tx, invoice.documentDate.getFullYear(), [
        invoice.documentDate.getMonth() + 1,
      ]);

      // Primena = red spojne tabele. Parcijalni unique `uq_invoice_advance_app_active`
      // (invoice_id, advance_invoice_id) WHERE status='ACTIVE' hvata dupli klik istog
      // avansa na istom računu; različiti računi su dozvoljeni (to je ceo cilj N:M).
      let application: { id: number };
      try {
        application = await tx.invoiceAdvanceApplication.create({
          data: {
            invoiceId: invoice.id,
            advanceInvoiceId: advance.id,
            appliedAmount: applied,
            appliedNet: split.net,
            appliedVat: split.vat,
            vatRateCode: split.vatRateCode,
            status: APPLICATION_ACTIVE,
            createdByUserId: actor.userId,
          },
          select: { id: true },
        });
      } catch (err) {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === "P2002"
        ) {
          throw new ConflictException(
            `Avansni račun ${advance.documentNumber} je već odbijen na računu ` +
              `${invoice.documentNumber}.`,
          );
        }
        throw err;
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
      // Stopa bez namenskog konta avansnog PDV-a (u kontnom planu postoje samo
      // 4720/20% i 4730/10%) bi tiho izbacila PDV liniju i napravila NEURAVNOTEŽEN
      // nalog — korisnik bi dobio goli 500 umesto objašnjenja (review Batch C, R5).
      if (split.vat.greaterThan(ZERO) && !vatAccount) {
        throw new UnprocessableEntityException(
          `Za PDV stopu ${split.vatPercent}% ne postoji konto avansnog PDV-a — ` +
            `avansni račun je moguć samo po stopi 20% ili 10%.`,
        );
      }
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

      // Nalog zatvaranja se pamti NA PRIMENI — storno konačnog računa reverzira
      // nalog SVAKE svoje primene. Bez toga bi poništenje računa ostavilo obavezu
      // po primljenom avansu (4300) i PDV po avansu zatvorene, iako je novac u kasi
      // (adversarial review Batch C, nalaz 1).
      await tx.invoiceAdvanceApplication.update({
        where: { id: application.id },
        data: { closingEntryId: entry.journalEntryId },
      });

      // KOMPATIBILNOST: `advance_applied_amount` = UKUPNO odbijeno na ovom računu, a
      // `advance_invoice_id` / `advance_closing_entry_id` pokazuju na PRVU primenu
      // (SEF BillingReference, štampa, pdv modul čitaju te kolone).
      //
      // ⚠️ `invoiceUsed` je UNIJA (primene + zatečena veza), pa se kolona i posle
      // vezivanja preko pdv modula upisuje TAČNO. Dok se ovde sabirala cela kolona,
      // svaka sledeća primena je N:M deo brojala dvaput i kolona je rasla u prazno —
      // baš onu invariantu („kolona = ukupno odbijeno") na kojoj štampa i ekran izvode
      // iznos zatečenog reda kao `kolona − Σ primena`.
      const totalApplied = invoiceUsed.add(applied);
      const isFirstApplication = !invoiceUsed.greaterThan(ZERO);
      await tx.invoice.update({
        where: { id: invoice.id },
        data: {
          advanceAppliedAmount: totalApplied,
          ...(isFirstApplication
            ? {
                advanceInvoiceId: advance.id,
                advanceClosingEntryId: entry.journalEntryId,
              }
            : {}),
          updatedByUserId: actor.userId,
        },
      });

      const updated = await tx.invoice.findUnique({
        where: { id: invoice.id },
        include: { items: { orderBy: { lineNo: "asc" } } },
      });
      if (!updated) {
        throw new NotFoundException(`Račun ${invoice.id} ne postoji.`);
      }

      const payableAmount = computePayableAmount({
        grossTotal: invoice.grossTotal,
        advanceAppliedAmount: totalApplied,
      });

      this.logger.log(
        `Avans ${advance.documentNumber} (${applied.toFixed(2)}) odbijen na računu ` +
          `${invoice.documentNumber}; ukupno odbijeno ${totalApplied.toFixed(2)}, ` +
          `za uplatu ostaje ${payableAmount.toFixed(2)}; preostatak avansa ` +
          `${advanceRemaining.sub(applied).toFixed(2)}; storno-nalog ${entry.number}.`,
      );

      return {
        ...updated,
        advanceInvoiceNumber: advance.documentNumber,
        payableAmount,
        // Zbir SVIH aktivnih primena na ovom računu (ne samo ove) — FE prikazuje njega.
        advanceAppliedAmount: totalApplied,
        advanceClosingEntryId: entry.journalEntryId,
        advanceClosingEntryNumber: entry.number,
        // — N:M dopune —
        applicationId: application.id,
        appliedAmount: applied,
        appliedNet: split.net,
        appliedVat: split.vat,
        advanceRemainingAmount: advanceRemaining.sub(applied),
      };
    });
  }

  /**
   * AKTIVNE primene — po avansu (`advanceInvoiceId`) ili po računu (`invoiceId`).
   * Storniran (`REVERSED`) red se ne vraća, pa storno računa automatski oslobađa
   * taj deo avansa za novu primenu.
   */
  private async activeApplications(
    tx: Prisma.TransactionClient,
    where: { invoiceId?: number; advanceInvoiceId?: number },
  ): Promise<AppliedRow[]> {
    return tx.invoiceAdvanceApplication.findMany({
      where: { ...where, status: APPLICATION_ACTIVE },
      select: {
        id: true,
        invoiceId: true,
        advanceInvoiceId: true,
        appliedAmount: true,
      },
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
