/**
 * ADVANCE VAT SERVICE — avansni računi, ULAZNI smer (Batch C1b).
 * =========================================================================
 * Avansni račun se evidentira kao `Invoice` sa `documentType = 'AVR'` i
 * `advanceDirection`:
 *   'out' = mi izdajemo kupcu (KIF; gradi ga sales modul — C1a),
 *   'in'  = dobavljač nama (KUF; OVAJ servis).
 *
 * PRAVILO ULAZNOG AVANSA — PRETPOREZ PO PLAĆANJU:
 * Ulazne fakture u sistemu nemaju zasebnu tabelu — poreska evidencija je
 * `VatLedgerEntry` sa `direction = 'input'` (KUF). Kod avansa dobavljača pravo na
 * odbitak pretporeza nastaje TEK PLAĆANJEM, pa:
 *   - `recordIncomingAdvance` samo EVIDENTIRA dokument — KUF stavka se NE kreira;
 *   - `markIncomingAdvancePaid` upisuje KUF stavku, i to u poreski period po
 *     DATUMU PLAĆANJA (`paidAt`), NE po datumu dokumenta;
 *   - `linkIncomingAdvanceToFinal` pri prijemu konačnog računa STORNIRA pretporez
 *     avansa (suprotna KUF stavka), da se isti PDV ne odbije dvaput.
 *
 * Idempotencija naplate je CAS (`updateMany` sa `advancePaidAt: null` u `where`) —
 * dvostruko označavanje plaćanja pada na 409, bez duple KUF stavke.
 *
 * Novac je `Prisma.Decimal` svuda; bruto→neto ide ISKLJUČIVO kroz `vat-bridge.util`
 * (`grossToNet`) da FE i BE daju identičan rezultat. Poreski period se poštuje kroz
 * `assertVatPeriodNotLocked` (D3): u zaključan (POSTED) period se ne upisuje.
 */

import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { TaxRatesService } from "./tax-rates.service";
import { assertVatPeriodNotLocked } from "./vat-period-lock";
import { grossToNet } from "./vat-bridge.util";
import { VAT_RATE_BY_CODE } from "../gl/posting/vat-rates";
import {
  ADVANCE_DIRECTION,
  ADVANCE_DOCUMENT_TYPE,
  validateLinkIncomingAdvanceToFinal,
  validateMarkIncomingAdvancePaid,
  validateRecordIncomingAdvance,
  type LinkIncomingAdvanceToFinalDto,
  type ListAdvancesQuery,
  type MarkIncomingAdvancePaidDto,
  type RecordIncomingAdvanceDto,
} from "./dto/advance-vat.dto";
import type { AuthUser } from "../auth/jwt.strategy";
// PRAVILO „koliko je avansa odbijeno" ima JEDNU tačku istine u modulu prodaje (tamo se
// primena i upisuje i stornira); ovde se samo ČITA, za zbir iskorišćenosti na ekranu.
import {
  APPLICATION_ACTIVE,
  computeAdvanceUsageByAdvance,
  loadAdvanceLinkedInvoices,
} from "../sales/advance-deduction";

const D = Prisma.Decimal;
const ZERO = new D(0);

/** Status evidentiranog (a još nenaplaćenog) ulaznog avansa. */
const STATUS_RECORDED = "POSTED";
/** Status naplaćenog (plaćenog) avansa. */
const STATUS_PAID = "PAID";

/** KUF smer poreske evidencije (`vat_ledger_entries.direction`). */
const VAT_DIRECTION_INPUT = "input";

/**
 * Jedna PRIMENA avansa na konačnom računu (N:M). Lista vraća SVE primene, ne samo
 * prvu — ekran po njima prikazuje na koje je račune avans već odbijen.
 */
export interface AdvanceApplicationRef {
  /** `Invoice.id` konačnog računa. */
  invoiceId: number;
  documentNumber: string;
  /** BRUTO iznos ove primene. */
  appliedAmount: Prisma.Decimal;
}

/** Jedan red liste avansa (oba smera) — Decimal polja idu u JSON kao string. */
export interface AdvanceRow {
  id: number;
  documentNumber: string;
  documentDate: Date;
  /** 'out' = izdat kupcu (KIF), 'in' = primljen od dobavljača (KUF). */
  direction: string | null;
  /** Komitent (kupac ili dobavljač) — meki ref `customers.id`. */
  partnerId: number | null;
  partnerName: string | null;
  currency: string;
  netTotal: Prisma.Decimal;
  vatTotal: Prisma.Decimal;
  grossTotal: Prisma.Decimal;
  /** Datum naplate avansa (null = još nenaplaćen → nema poreske obaveze/pretporeza). */
  paidAt: Date | null;
  paidAmount: Prisma.Decimal;
  status: string;
  /**
   * NENAPLAĆEN deo = `grossTotal − paidAmount`. > 0 → naplata se još može upisati
   * (izlazni avans se naplaćuje u RATAMA — `advance-invoice.markAdvancePaid`).
   * Ulazni avans se plaća jednokratno (drugi poziv → 409), pa se za njega gleda
   * `paidAt`, ne ovo polje.
   */
  unpaidAmount: Prisma.Decimal;
  /** ISKORIŠĆENO = Σ AKTIVNIH primena avansa na konačnim računima. */
  appliedAmount: Prisma.Decimal;
  /**
   * OSTATAK = `paidAmount − appliedAmount`. > 0 → avans se još može odbiti na
   * konačnom računu. Isti račun koji `applyAdvance` radi pod bravom (tamo je
   * merodavan), ovde samo za prikaz i za uslov prikaza dugmeta.
   */
  remainingAmount: Prisma.Decimal;
  /** SVE primene avansa (N:M) — prazan niz = avans još nije iskorišćen. */
  applications: AdvanceApplicationRef[];
  /**
   * PRVA primena — zadržano zbog kompatibilnosti (kolona „Vezan za"). NIJE uslov
   * za dugme „Veži na konačni račun": popunjava se već pri PRVOJ primeni, pa je
   * ekran po njemu sakrivao vezivanje ostatka (nalaz K2 nezavisnog pregleda).
   */
  linkedFinalInvoiceId: number | null;
  linkedFinalDocumentNumber: string | null;
  note: string | null;
}

/** Rezultat evidencije ulaznog avansa. */
export interface RecordIncomingAdvanceResult {
  id: number;
  documentNumber: string;
  netTotal: Prisma.Decimal;
  vatTotal: Prisma.Decimal;
  grossTotal: Prisma.Decimal;
  paidAt: Date | null;
  /** Id upisane KUF stavke (null dok avans nije plaćen — pretporez po plaćanju). */
  vatLedgerEntryId: number | null;
}

/** Rezultat označavanja naplate ulaznog avansa. */
export interface MarkIncomingAdvancePaidResult {
  id: number;
  paidAt: Date;
  paidAmount: Prisma.Decimal;
  /** Poreski period KUF stavke — po `paidAt`, NE po datumu dokumenta. */
  taxPeriodYear: number;
  taxPeriodMonth: number;
  vatBase: Prisma.Decimal;
  vatAmount: Prisma.Decimal;
  vatLedgerEntryId: number;
}

/** Rezultat vezivanja avansa na konačni ulazni račun. */
export interface LinkIncomingAdvanceResult {
  advanceId: number;
  finalInvoiceId: number;
  /** Bruto iznos avansa odbijen na konačnom računu. */
  appliedAmount: Prisma.Decimal;
  /** Id storno KUF stavke (null ako avans nije bio plaćen — nije ni odbijen). */
  reversalEntryId: number | null;
}

@Injectable()
export class AdvanceVatService {
  private readonly logger = new Logger(AdvanceVatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly taxRates: TaxRatesService,
  ) {}

  // ── evidencija ulaznog avansa ──────────────────────────────────────────────

  /**
   * Evidentiraj ULAZNI avansni račun dobavljača (`Invoice` AVR + jedna stavka).
   * KUF stavka se NE kreira ovde — pretporez nastaje plaćanjem. Ako je `paidAt`
   * prosleđen (avans već plaćen pri unosu), odmah se poziva `markIncomingAdvancePaid`.
   */
  async recordIncomingAdvance(
    dto: RecordIncomingAdvanceDto,
    actor: AuthUser,
  ): Promise<RecordIncomingAdvanceResult> {
    validateRecordIncomingAdvance(dto);

    const documentNumber = dto.documentNumber.trim();
    const vatRateCode = dto.vatRateCode.trim();
    const documentDate = new Date(dto.documentDate);
    const ratePct = await this.resolveRatePct(vatRateCode, documentDate);
    const { net, vat } = grossToNet(dto.grossAmount, ratePct);
    const gross = net.add(vat);

    const created = await this.createAdvanceInvoice({
      partnerId: dto.partnerId,
      documentNumber,
      documentDate,
      vatRateCode,
      net,
      vat,
      gross,
      note: dto.note?.trim() ? dto.note.trim() : null,
      actorUserId: actor.userId,
    });

    // Avans plaćen već pri unosu → odmah upiši pretporez u period po `paidAt`.
    if (dto.paidAt) {
      const paid = await this.markIncomingAdvancePaid(
        { id: created.id, paidAt: dto.paidAt, amount: gross.toNumber() },
        actor,
      );
      return {
        id: created.id,
        documentNumber,
        netTotal: net,
        vatTotal: vat,
        grossTotal: gross,
        paidAt: paid.paidAt,
        vatLedgerEntryId: paid.vatLedgerEntryId,
      };
    }

    return {
      id: created.id,
      documentNumber,
      netTotal: net,
      vatTotal: vat,
      grossTotal: gross,
      paidAt: null,
      vatLedgerEntryId: null,
    };
  }

  // ── naplata (plaćanje) ulaznog avansa → pretporez ──────────────────────────

  /**
   * Označi ULAZNI avans plaćenim i priznaj pretporez: CAS upis datuma plaćanja
   * (`advancePaidAt: null` u `where` — dvostruko označavanje pada na 409), pa upis
   * KUF stavke (`VatLedgerEntry direction='input'`) u poreski period po `paidAt`.
   *
   * Period se NE uzima iz datuma dokumenta: pravo na odbitak nastaje plaćanjem, pa
   * avans plaćen u avgustu ulazi u avgustovski KUF i kad je račun iz jula.
   */
  async markIncomingAdvancePaid(
    dto: MarkIncomingAdvancePaidDto,
    actor: AuthUser,
  ): Promise<MarkIncomingAdvancePaidResult> {
    validateMarkIncomingAdvancePaid(dto);

    const advance = await this.loadIncomingAdvanceOrThrow(dto.id);
    if (advance.advancePaidAt != null) {
      throw new ConflictException(
        `Avansni račun ${advance.documentNumber} je već označen kao plaćen ` +
          `(${advance.advancePaidAt.toISOString().slice(0, 10)}). Pretporez je već ` +
          `priznat — ponovno označavanje bi ga odbilo dvaput.`,
      );
    }

    const paidAt = new Date(dto.paidAt);
    const amount = new D(dto.amount);
    if (amount.greaterThan(advance.grossTotal)) {
      throw new UnprocessableEntityException(
        `Plaćen iznos (${amount.toFixed(2)}) je veći od bruto iznosa avansa ` +
          `(${advance.grossTotal.toFixed(2)}) na računu ${advance.documentNumber}.`,
      );
    }

    const vatRateCode = advance.items[0]?.vatRateCode ?? null;
    if (!vatRateCode) {
      throw new UnprocessableEntityException(
        `Avansni račun ${advance.documentNumber} nema poresku stopu na stavci — ` +
          `pretporez se ne može obračunati. Ispravi dokument pa pokušaj ponovo.`,
      );
    }
    const ratePct = await this.resolveRatePct(
      vatRateCode,
      advance.documentDate,
    );
    const { net, vat } = grossToNet(amount, ratePct);

    const { year, month } = taxPeriodOf(paidAt);

    return this.prisma.$transaction(async (tx) => {
      // D3: pretporez se ne sme ubaciti u zaključan (predat) poreski period.
      await assertVatPeriodNotLocked(tx, year, [month]);

      // CAS: samo prelaz „nije plaćen" → „plaćen" prolazi; paralelni drugi poziv
      // vidi count = 0 i dobija 409 (bez druge KUF stavke).
      const claimed = await tx.invoice.updateMany({
        where: {
          id: advance.id,
          documentType: ADVANCE_DOCUMENT_TYPE,
          advanceDirection: ADVANCE_DIRECTION.IN,
          advancePaidAt: null,
        },
        data: {
          advancePaidAt: paidAt,
          advancePaidAmount: amount,
          status: STATUS_PAID,
          updatedByUserId: actor.userId,
        },
      });
      if (claimed.count !== 1) {
        throw new ConflictException(
          `Avansni račun ${advance.documentNumber} je u međuvremenu već označen kao ` +
            `plaćen. Osveži listu — pretporez je priznat samo jednom.`,
        );
      }

      const entry = await tx.vatLedgerEntry.create({
        data: {
          direction: VAT_DIRECTION_INPUT, // KUF — pretporez
          documentNumber: advance.documentNumber,
          partnerId: advance.customerId,
          documentDate: advance.documentDate,
          taxPeriodYear: year, // period po PLAĆANJU (ne po datumu dokumenta)
          taxPeriodMonth: month,
          vatBase: net,
          vatAmount: vat,
          vatRateCode,
          sourceJournalEntryId: null, // evidencija avansa, ne GK-izvedena stavka
        },
      });

      this.logger.log(
        `Ulazni avans #${advance.id} (${advance.documentNumber}) plaćen ` +
          `${paidAt.toISOString().slice(0, 10)} — pretporez ${vat.toFixed(2)} u periodu ${year}-${String(month).padStart(2, "0")}.`,
      );

      return {
        id: advance.id,
        paidAt,
        paidAmount: amount,
        taxPeriodYear: year,
        taxPeriodMonth: month,
        vatBase: net,
        vatAmount: vat,
        vatLedgerEntryId: entry.id,
      };
    });
  }

  // ── vezivanje na konačni ulazni račun ──────────────────────────────────────

  /**
   * Veži ULAZNI avans na konačni ulazni račun. Pri vezivanju se pretporez avansa
   * STORNIRA suprotnom KUF stavkom (negativna osnovica/PDV) — inače bi isti PDV
   * bio odbijen dvaput (jednom po avansu, jednom po konačnom računu).
   *
   * Storno ide u poreski period konačnog računa (tada avans prestaje da važi kao
   * samostalan osnov odbitka). Avans koji nikad nije plaćen nema šta da storniram —
   * veza se samo upisuje.
   */
  async linkIncomingAdvanceToFinal(
    dto: LinkIncomingAdvanceToFinalDto,
  ): Promise<LinkIncomingAdvanceResult> {
    validateLinkIncomingAdvanceToFinal(dto);

    const advance = await this.loadIncomingAdvanceOrThrow(dto.advanceId);
    const final = await this.prisma.invoice.findUnique({
      where: { id: dto.finalInvoiceId },
    });
    if (!final) {
      throw new NotFoundException(
        `Konačni račun #${dto.finalInvoiceId} ne postoji.`,
      );
    }
    if (final.documentType === ADVANCE_DOCUMENT_TYPE) {
      throw new UnprocessableEntityException(
        `Dokument #${final.id} je avansni račun — avans se veže na KONAČNI račun, ne na drugi avans.`,
      );
    }
    // Tabela `invoices` sadrži ISKLJUČIVO naša IZLAZNA dokumenta. Ulazni avans
    // dobavljača vezan na naš izlazni račun postavio bi `advanceAppliedAmount` na
    // taj račun, pa bi na SEF otišao umanjen `PayableAmount` i `PrepaidAmount` za
    // avans koji smo MI platili dobavljaču — kupac bi dobio račun na kome piše da
    // duguje manje (review Batch C, nalaz 4). Dok konačni ULAZNI račun ne postoji
    // kao zaseban zapis, ova veza nema ispravan cilj i mora biti odbijena.
    if (advance.advanceDirection === ADVANCE_DIRECTION.IN) {
      throw new UnprocessableEntityException(
        `Ulazni (dobavljačev) avans ${advance.documentNumber} ne može da se veže na ` +
          `račun ${final.documentNumber} — to je NAŠ izlazni račun kupcu. Veza ulaznog ` +
          `avansa na konačni ulazni račun čeka evidenciju ulaznih faktura.`,
      );
    }
    if (final.customerId !== advance.customerId) {
      throw new UnprocessableEntityException(
        `Avans i konačni račun nisu istog komitenta (avans: ${advance.customerId ?? "—"}, ` +
          `račun: ${final.customerId ?? "—"}).`,
      );
    }
    if (final.advanceInvoiceId != null) {
      throw new ConflictException(
        `Račun ${final.documentNumber} već ima vezan avans (#${final.advanceInvoiceId}).`,
      );
    }

    // Isti avans ne sme da se odbije na dva konačna računa.
    const alreadyUsed = await this.prisma.invoice.findFirst({
      where: { advanceInvoiceId: advance.id },
      select: { id: true, documentNumber: true },
    });
    if (alreadyUsed) {
      throw new ConflictException(
        `Avans ${advance.documentNumber} je već odbijen na računu ${alreadyUsed.documentNumber} ` +
          `(#${alreadyUsed.id}) — ne može se iskoristiti dvaput.`,
      );
    }

    // Odbija se ono što je stvarno plaćeno (pretporez je priznat po tom iznosu);
    // nenaplaćen avans nosi ceo bruto kao umanjenje, bez poreskog efekta.
    const applied = advance.advancePaidAt
      ? advance.advancePaidAmount
      : advance.grossTotal;

    const isPaid = advance.advancePaidAt != null;
    const { year, month } = taxPeriodOf(final.documentDate);
    const vatRateCode = advance.items[0]?.vatRateCode ?? null;
    const ratePct =
      isPaid && vatRateCode
        ? await this.resolveRatePct(vatRateCode, advance.documentDate)
        : null;

    return this.prisma.$transaction(async (tx) => {
      if (isPaid) {
        await assertVatPeriodNotLocked(tx, year, [month]);
      }

      const claimed = await tx.invoice.updateMany({
        where: { id: final.id, advanceInvoiceId: null },
        data: {
          advanceInvoiceId: advance.id,
          advanceAppliedAmount: applied,
        },
      });
      if (claimed.count !== 1) {
        throw new ConflictException(
          `Račun ${final.documentNumber} je u međuvremenu već dobio vezan avans. Osveži prikaz.`,
        );
      }

      let reversalEntryId: number | null = null;
      if (isPaid && ratePct != null && vatRateCode) {
        const { net, vat } = grossToNet(applied, ratePct);
        const reversal = await tx.vatLedgerEntry.create({
          data: {
            direction: VAT_DIRECTION_INPUT,
            documentNumber: advance.documentNumber,
            partnerId: advance.customerId,
            documentDate: final.documentDate,
            taxPeriodYear: year,
            taxPeriodMonth: month,
            // Suprotan predznak = storno pretporeza avansa (da se ne odbije dvaput).
            vatBase: ZERO.sub(net),
            vatAmount: ZERO.sub(vat),
            vatRateCode,
            sourceJournalEntryId: null,
          },
        });
        reversalEntryId = reversal.id;
      }

      this.logger.log(
        `Ulazni avans #${advance.id} vezan na konačni račun #${final.id} ` +
          `(umanjenje ${applied.toFixed(2)}${reversalEntryId ? `, storno pretporeza #${reversalEntryId}` : ""}).`,
      );

      return {
        advanceId: advance.id,
        finalInvoiceId: final.id,
        appliedAmount: applied,
        reversalEntryId,
      };
    });
  }

  // ── lista avansa (oba smera) ───────────────────────────────────────────────

  /**
   * Lista avansnih računa (`Invoice` sa `documentType = 'AVR'`) za OBA smera.
   * Filteri: smer, komitent, „samo nenaplaćeni". Server-side paginacija.
   *
   * Uz svaki red idu naziv komitenta i STANJE AVANSA — naplaćeno / iskorišćeno /
   * ostatak + sve primene. Ekran po `remainingAmount > 0` nudi „Veži na konačni
   * račun", a po `unpaidAmount > 0` (izlazni smer) „Označi naplatu". Ranije je red
   * nosio samo PRVU vezu, pa je ekran posle prve primene trajno sakrivao vezivanje
   * i ostatak naplaćenog avansa nije mogao da se odbije nigde (nalaz K2).
   */
  async listAdvances(query: ListAdvancesQuery): Promise<{
    data: AdvanceRow[];
    meta: { total: number; page: number; pageSize: number };
  }> {
    const page = query.page && query.page > 0 ? query.page : 1;
    const pageSize = query.pageSize && query.pageSize > 0 ? query.pageSize : 50;

    const where: Prisma.InvoiceWhereInput = {
      documentType: ADVANCE_DOCUMENT_TYPE,
      ...(query.direction ? { advanceDirection: query.direction } : {}),
      ...(query.partnerId ? { customerId: query.partnerId } : {}),
      // „Samo nenaplaćeni" = ima NENAPLAĆEN DEO, ne „nikad naplaćen". Naplata je
      // namerno kumulativna (rate), pa je stari filter `advancePaidAt: null` sakrivao
      // baš avanse zbog kojih su rate i uvedene: avans od 45.000 sa uplaćenih 30.000
      // nije se pojavljivao u listi nenaplaćenih. Poređenje kolona ide kroz Prisma
      // field reference (`invoice.fields.grossTotal`), bez sirovog SQL-a.
      ...(query.unpaidOnly
        ? {
            advancePaidAmount: { lt: this.prisma.invoice.fields.grossTotal },
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.invoice.count({ where }),
      this.prisma.invoice.findMany({
        where,
        orderBy: [{ documentDate: "desc" }, { id: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    const partnerIds = [
      ...new Set(
        rows.map((r) => r.customerId).filter((v): v is number => v != null),
      ),
    ];
    const advanceIds = rows.map((r) => r.id);

    const [partners, applicationRows, linkedInvoices] = await Promise.all([
      partnerIds.length
        ? this.prisma.customer.findMany({
            where: { id: { in: partnerIds } },
            select: { id: true, name: true },
          })
        : Promise.resolve([] as { id: number; name: string }[]),
      // N:M primene (`invoice_advance_applications`) — pravi izvor iskorišćenosti.
      advanceIds.length
        ? this.prisma.invoiceAdvanceApplication.findMany({
            where: {
              advanceInvoiceId: { in: advanceIds },
              status: APPLICATION_ACTIVE,
            },
            orderBy: { id: "asc" },
            select: {
              advanceInvoiceId: true,
              invoiceId: true,
              appliedAmount: true,
              invoice: { select: { documentNumber: true } },
            },
          })
        : Promise.resolve(
            [] as {
              advanceInvoiceId: number;
              invoiceId: number;
              appliedAmount: Prisma.Decimal;
              invoice: { documentNumber: string };
            }[],
          ),
      // LEGACY / CROSS-MODUL veze: pre N:M migracije i kroz `linkIncomingAdvanceToFinal`
      // (ulazni smer) veza živi SAMO u denormalizovanim `invoices.advance_*` kolonama,
      // bez reda u spojnoj tabeli. Uz svaki takav račun idu i NJEGOVE aktivne primene —
      // iznos zatečene veze je `kolona − Σ primena TOG računa`, a kolona je zbir po SVIM
      // avansima (v. `advance-deduction.ts`).
      loadAdvanceLinkedInvoices(this.prisma, advanceIds),
    ]);

    const partnerName = new Map(partners.map((p) => [p.id, p.name]));

    // JEDNO PRAVILO ZA CEO SISTEM (`sales/advance-deduction.ts`): UNIJA aktivnih primena
    // i onih zatečenih 1:1 veza koje u spojnoj tabeli nemaju svoj red. Do 02.08.2026. je
    // isti račun stajao prepisan ovde; „ili-ili" varijanta je posle prve N:M primene
    // gubila legacy deo, pa je ekran nudio ostatak koji avans nema — a server ga je
    // odbijao. Ekran i server sada dele funkciju, ne opis.
    const usageByAdvance = computeAdvanceUsageByAdvance({
      advanceInvoiceIds: advanceIds,
      applicationsOfAdvances: applicationRows.map((a) => ({
        advanceInvoiceId: a.advanceInvoiceId,
        invoiceId: a.invoiceId,
        appliedAmount: a.appliedAmount,
        invoiceDocumentNumber: a.invoice.documentNumber,
      })),
      linkedInvoices,
    });

    const data: AdvanceRow[] = rows.map((r) => {
      const usage = usageByAdvance.get(r.id);
      const applications: AdvanceApplicationRef[] = (usage?.lines ?? []).map(
        (l) => ({
          invoiceId: l.invoiceId,
          documentNumber: l.invoiceDocumentNumber ?? "",
          appliedAmount: l.amount,
        }),
      );
      const appliedAmount = usage?.total ?? ZERO;
      const first = applications[0] ?? null;
      return {
        id: r.id,
        documentNumber: r.documentNumber,
        documentDate: r.documentDate,
        direction: r.advanceDirection,
        partnerId: r.customerId,
        partnerName:
          r.customerId != null ? (partnerName.get(r.customerId) ?? null) : null,
        currency: r.currency,
        netTotal: r.netTotal,
        vatTotal: r.vatTotal,
        grossTotal: r.grossTotal,
        paidAt: r.advancePaidAt,
        paidAmount: r.advancePaidAmount,
        status: r.status,
        unpaidAmount: r.grossTotal.sub(r.advancePaidAmount),
        appliedAmount,
        remainingAmount: r.advancePaidAmount.sub(appliedAmount),
        applications,
        linkedFinalInvoiceId: first?.invoiceId ?? null,
        linkedFinalDocumentNumber: first?.documentNumber ?? null,
        note: r.note,
      };
    });

    return { data, meta: { total, page, pageSize } };
  }

  // ── interno ────────────────────────────────────────────────────────────────

  /** Upis AVR zaglavlja + jedne stavke; koliziju broja (uq type+number) → 409. */
  private async createAdvanceInvoice(input: {
    partnerId: number;
    documentNumber: string;
    documentDate: Date;
    vatRateCode: string;
    net: Prisma.Decimal;
    vat: Prisma.Decimal;
    gross: Prisma.Decimal;
    note: string | null;
    actorUserId: number;
  }): Promise<{ id: number }> {
    try {
      return await this.prisma.invoice.create({
        data: {
          documentType: ADVANCE_DOCUMENT_TYPE,
          documentNumber: input.documentNumber,
          level: 0, // dokument dobavljača — nije naš draft
          customerId: input.partnerId, // šifarnik komitenata je zajednički (KUPDOB)
          documentDate: input.documentDate,
          netTotal: input.net,
          vatTotal: input.vat,
          grossTotal: input.gross,
          advanceDirection: ADVANCE_DIRECTION.IN,
          advancePaidAmount: ZERO,
          status: STATUS_RECORDED,
          note: input.note,
          createdByUserId: input.actorUserId,
          updatedByUserId: input.actorUserId,
          items: {
            create: [
              {
                lineNo: 1,
                description: `Avansna uplata po računu ${input.documentNumber}`,
                quantity: new D(1),
                unitPrice: input.net,
                vatRateCode: input.vatRateCode,
                vatBase: input.net,
                vatAmount: input.vat,
                lineTotal: input.gross,
              },
            ],
          },
        },
        select: { id: true },
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === "P2002"
      ) {
        throw new ConflictException(
          `Avansni račun sa brojem ${input.documentNumber} već postoji. ` +
            `Broj avansnog računa mora biti jedinstven — dopuni broj oznakom dobavljača.`,
        );
      }
      throw e;
    }
  }

  /** Učitaj ULAZNI avans (AVR + direction 'in') sa stavkama; inače 404/422. */
  private async loadIncomingAdvanceOrThrow(id: number) {
    const advance = await this.prisma.invoice.findUnique({
      where: { id },
      include: { items: { orderBy: { lineNo: "asc" } } },
    });
    if (!advance) {
      throw new NotFoundException(`Avansni račun #${id} ne postoji.`);
    }
    if (advance.documentType !== ADVANCE_DOCUMENT_TYPE) {
      throw new UnprocessableEntityException(
        `Dokument #${id} nije avansni račun (vrsta ${advance.documentType}).`,
      );
    }
    if (advance.advanceDirection !== ADVANCE_DIRECTION.IN) {
      throw new UnprocessableEntityException(
        `Avansni račun #${id} nije ULAZNI (smer ${advance.advanceDirection ?? "—"}). ` +
          `Izlazni avans se obrađuje kroz modul prodaje.`,
      );
    }
    return advance;
  }

  /**
   * Efektivna stopa (procenat, npr. 20) za šifru na dan — kroz postojeći
   * `TaxRatesService.resolve` (jedan resolver za ceo sistem, doc 39 §A).
   */
  private async resolveRatePct(
    code: string,
    on: Date,
  ): Promise<Prisma.Decimal> {
    // Registar tarifa prvo; ako je prazan (a na dev/produ jeste — TaxRate se još
    // ne popunjava), padni na deljenu mapu stopa. Isti dvostepeni obrazac kao
    // robno/calculation.service §fallback — bez njega ceo tok avansa puca sa 404
    // „Nema važeće poreske stope" na svakoj bazi bez tarifa (nađeno dev smoke-om).
    try {
      const resolved = await this.taxRates.resolve(
        code,
        on.toISOString().slice(0, 10),
      );
      return new D(resolved.data.ratePct);
    } catch {
      const fraction = VAT_RATE_BY_CODE[code];
      if (fraction === undefined) {
        throw new UnprocessableEntityException(
          `Nepoznata šifra PDV stope „${code}" — dozvoljene: ` +
            `${Object.keys(VAT_RATE_BY_CODE).join(", ")}.`,
        );
      }
      const ratePct = new D(fraction).mul(100);
      this.logger.warn(
        `Registar poreskih tarifa nema šifru ${code} na dan ` +
          `${on.toISOString().slice(0, 10)} — korišćena podrazumevana stopa ${ratePct.toFixed(0)}%.`,
      );
      return ratePct;
    }
  }
}

/**
 * Poreski period (godina, mesec) iz datuma. UTC namerno: `paidAt` stiže kao
 * `YYYY-MM-DD` (parsira se u UTC ponoć), pa lokalni getteri na serveru istočno/
 * zapadno od UTC mogu odvući stavku u susedni mesec.
 */
function taxPeriodOf(d: Date): { year: number; month: number } {
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}
