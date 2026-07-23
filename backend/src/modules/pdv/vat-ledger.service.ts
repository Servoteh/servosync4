/**
 * VAT LEDGER SERVICE — KIF/KUF punjenje (Faza 6 §A).
 * =========================================================================
 * KIF = knjiga izlaznih faktura (izlazni / output PDV — obaveza).
 * KUF = knjiga ulaznih faktura (ulazni / input PDV — pretporez).
 *
 * Izvor istine je GLAVNA KNJIGA (`ledger_entries`) — PDV se NE vodi u zasebnoj
 * evidenciji nego se IZVODI iz knjiženih PDV konta (VatAccountMap registar):
 *   direction = 'output' → KIF (npr. 4700/4702/4710 — obaveza za izlazni PDV)
 *   direction = 'input'  → KUF (npr. 2700/2710 — pretporez za ulazni PDV)
 * (doc 18 §3.2: `PDV_UknjiziIzRobnog_IF/UF` LEFT JOIN idempotentni obrazac —
 * ovde je idempotencija u punjenju: obriši period pa reknjiži iz GK.)
 *
 * `buildKifKuf(year, month)` grupiše proknjižene GK stavke po dokumentu i
 * partneru (analitika), za PDV konta iz registra, i puni `vat_ledger_entries`.
 * `listKif`/`listKuf` vraćaju popunjenu evidenciju za period.
 *
 * Osnovica (vat_base) po dokumentu se ne vodi na PDV kontu — PDV konto nosi samo
 * iznos poreza. Osnovicu izvodimo iz nominalne stope registra (rate):
 *   osnovica = iznosPDV / (rate/100). Konto bez stope (transit/uplatni) → 0.
 *
 * Raw SQL (`$queryRaw`) jer grupišemo Σ po (dokument, partner, konto) uz JOIN na
 * registar PDV konta — Decimal se vraća egzaktno (BACKEND_RULES §2: nikad Float).
 */

import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { assertVatPeriodNotLocked } from "./vat-period-lock";
import {
  type CreateManualVatEntryDto,
  type UpdateManualVatEntryDto,
  validateCreateManualVatEntry,
  validateUpdateManualVatEntry,
} from "./dto/manual-vat-entry.dto";

const D = Prisma.Decimal;
const ZERO = new D(0);

/** Jedan red KIF/KUF evidencije (vraćeno u list metode / izveštaj). */
export interface VatLedgerRow {
  id: number;
  direction: string; // input (KUF) | output (KIF)
  documentNumber: string;
  partnerId: number | null;
  documentDate: Date;
  taxPeriodYear: number;
  taxPeriodMonth: number;
  vatBase: Prisma.Decimal;
  vatAmount: Prisma.Decimal;
  vatRateCode: string | null;
  sourceJournalEntryId: number | null;
}

/** Rezultat punjenja jednog perioda (za oba smera). */
export interface BuildKifKufResult {
  year: number;
  month: number;
  kifCount: number; // broj upisanih izlaznih redova
  kufCount: number; // broj upisanih ulaznih redova
  outputVat: Prisma.Decimal; // Σ izlazni PDV (KIF)
  inputVat: Prisma.Decimal; // Σ ulazni PDV (KUF)
}

/** Agregat po (dokument, partner, konto) iz glavne knjige za PDV konta. */
interface VatAggregateRow {
  journal_entry_id: number;
  document_number: string | null;
  analytical_code: number | null;
  document_date: Date;
  account_code: string;
  direction: string;
  rate: number | null;
  vat_amount: Prisma.Decimal | null;
}

@Injectable()
export class VatLedgerService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Napuni KIF/KUF (`vat_ledger_entries`) za period (godina, mesec) iz glavne
   * knjige. Idempotentno: prvo obriše postojeće redove perioda pa reknjiži
   * (kao legacy `reversePeriod` + reknjiži — čist period, doc 18 §3.2).
   *
   * Period se određuje po `journal_entries.posting_date` (datum knjiženja =
   * poreski period). Uzima se SAMO proknjižen nalog (status = 'posted').
   */
  async buildKifKuf(year: number, month: number): Promise<BuildKifKufResult> {
    this.assertPeriod(year, month);

    // D3: reknjiženje zaključanog (POSTED) perioda nije dozvoljeno — inače bi
    // deleteMany tiho pregazio predat obrazac.
    await assertVatPeriodNotLocked(this.prisma, year, [month]);

    return this.prisma.$transaction(async (tx) => {
      // 1) Čist period — obriši prethodno punjenje (idempotentnost).
      //    D4: briše SAMO GK-izvedene stavke (sourceJournalEntryId != null);
      //    ručne stavke (source = null) opstaju kroz reknjiženje iz GK.
      await tx.vatLedgerEntry.deleteMany({
        where: {
          taxPeriodYear: year,
          taxPeriodMonth: month,
          sourceJournalEntryId: { not: null },
        },
      });

      // 2) Agregacija PDV konta iz GK po (nalog, partner, konto) za period.
      //    Sabira iznos PDV po smeru: output = kredit − debit (obaveza raste
      //    potraživanjem 47x), input = debit − credit (pretporez raste
      //    dugovanjem 27x). Uzimamo apsolutnu neto vrednost po grupi.
      const rows = await tx.$queryRaw<VatAggregateRow[]>(
        Prisma.sql`
          SELECT
            le.journal_entry_id AS journal_entry_id,
            le.document_number AS document_number,
            le.analytical_code AS analytical_code,
            je.posting_date AS document_date,
            le.account_code AS account_code,
            vam.direction AS direction,
            vam.rate AS rate,
            CASE
              WHEN vam.direction = 'output'
                THEN COALESCE(SUM(le.credit) - SUM(le.debit), 0)
              ELSE COALESCE(SUM(le.debit) - SUM(le.credit), 0)
            END AS vat_amount
          FROM ledger_entries le
          JOIN journal_entries je ON je.id = le.journal_entry_id
          JOIN vat_account_map vam ON vam.account = le.account_code
          WHERE je.status = 'posted'
            AND EXTRACT(YEAR FROM je.posting_date) = ${year}
            AND EXTRACT(MONTH FROM je.posting_date) = ${month}
          GROUP BY
            le.journal_entry_id, le.document_number, le.analytical_code,
            je.posting_date, le.account_code, vam.direction, vam.rate
        `,
      );

      const toInsert: Prisma.VatLedgerEntryCreateManyInput[] = [];
      let outputVat = ZERO;
      let inputVat = ZERO;
      let kifCount = 0;
      let kufCount = 0;

      for (const r of rows) {
        const vatAmount = r.vat_amount ?? ZERO;
        // Preskoči nulte grupe (npr. dug=pot na tranzitnom kontu).
        if (new D(vatAmount).isZero()) continue;

        const rate = r.rate ?? null;
        const vatBase = this.deriveBase(new D(vatAmount), rate);

        toInsert.push({
          direction: r.direction,
          documentNumber: r.document_number ?? String(r.journal_entry_id),
          partnerId: r.analytical_code,
          documentDate: r.document_date,
          taxPeriodYear: year,
          taxPeriodMonth: month,
          vatBase,
          vatAmount: new D(vatAmount),
          vatRateCode: rate != null ? String(rate) : null,
          sourceJournalEntryId: r.journal_entry_id,
        });

        if (r.direction === "output") {
          outputVat = outputVat.add(vatAmount);
          kifCount += 1;
        } else {
          inputVat = inputVat.add(vatAmount);
          kufCount += 1;
        }
      }

      if (toInsert.length > 0) {
        await tx.vatLedgerEntry.createMany({ data: toInsert });
      }

      return { year, month, kifCount, kufCount, outputVat, inputVat };
    });
  }

  /** KIF (izlazne fakture) za period — proknjižena evidencija. */
  async listKif(year: number, month: number): Promise<VatLedgerRow[]> {
    return this.list("output", year, month);
  }

  /** KUF (ulazne fakture) za period — proknjižena evidencija. */
  async listKuf(year: number, month: number): Promise<VatLedgerRow[]> {
    return this.list("input", year, month);
  }

  // ── ručne KIF/KUF stavke (D4) ────────────────────────────────────────────

  /**
   * Kreiraj RUČNU KIF/KUF stavku (`sourceJournalEntryId = null` — poreklo
   * „manual"). Poštuje D3 period-lock: ne sme se dodavati u zaključan period.
   */
  async createManualEntry(dto: CreateManualVatEntryDto): Promise<VatLedgerRow> {
    validateCreateManualVatEntry(dto);
    await assertVatPeriodNotLocked(this.prisma, dto.taxPeriodYear, [
      dto.taxPeriodMonth,
    ]);

    const created = await this.prisma.vatLedgerEntry.create({
      data: {
        direction: dto.direction,
        documentNumber: dto.documentNumber.trim(),
        partnerId: dto.partnerId ?? null,
        documentDate: new Date(dto.documentDate),
        taxPeriodYear: dto.taxPeriodYear,
        taxPeriodMonth: dto.taxPeriodMonth,
        vatBase: new D(dto.vatBase),
        vatAmount: new D(dto.vatAmount),
        vatRateCode: dto.vatRateCode ?? null,
        sourceJournalEntryId: null, // marker ručne stavke
      },
    });
    return this.toRow(created);
  }

  /**
   * Izmeni RUČNU KIF/KUF stavku. Odbija GK-izvedene (`sourceJournalEntryId != null`)
   * — one se menjaju samo reknjiženjem iz GK. Poštuje D3 lock za STARI i NOVI
   * period (premeštanje stavke iz/u zaključan period nije dozvoljeno).
   */
  async updateManualEntry(
    id: number,
    dto: UpdateManualVatEntryDto,
  ): Promise<VatLedgerRow> {
    validateUpdateManualVatEntry(dto);
    const existing = await this.loadManualOrThrow(id);

    const newYear = dto.taxPeriodYear ?? existing.taxPeriodYear;
    const newMonth = dto.taxPeriodMonth ?? existing.taxPeriodMonth;
    // Lock provera za sve pogođene periode (stari i novi).
    await assertVatPeriodNotLocked(this.prisma, existing.taxPeriodYear, [
      existing.taxPeriodMonth,
    ]);
    if (newYear !== existing.taxPeriodYear || newMonth !== existing.taxPeriodMonth) {
      await assertVatPeriodNotLocked(this.prisma, newYear, [newMonth]);
    }

    const updated = await this.prisma.vatLedgerEntry.update({
      where: { id },
      data: {
        ...(dto.direction !== undefined ? { direction: dto.direction } : {}),
        ...(dto.documentNumber !== undefined
          ? { documentNumber: dto.documentNumber.trim() }
          : {}),
        ...(dto.partnerId !== undefined ? { partnerId: dto.partnerId ?? null } : {}),
        ...(dto.documentDate !== undefined
          ? { documentDate: new Date(dto.documentDate) }
          : {}),
        ...(dto.taxPeriodYear !== undefined ? { taxPeriodYear: dto.taxPeriodYear } : {}),
        ...(dto.taxPeriodMonth !== undefined
          ? { taxPeriodMonth: dto.taxPeriodMonth }
          : {}),
        ...(dto.vatBase !== undefined ? { vatBase: new D(dto.vatBase) } : {}),
        ...(dto.vatAmount !== undefined ? { vatAmount: new D(dto.vatAmount) } : {}),
        ...(dto.vatRateCode !== undefined
          ? { vatRateCode: dto.vatRateCode ?? null }
          : {}),
      },
    });
    return this.toRow(updated);
  }

  /**
   * Obriši RUČNU KIF/KUF stavku. Odbija GK-izvedene i zaključan (POSTED) period.
   */
  async deleteManualEntry(id: number): Promise<{ id: number }> {
    const existing = await this.loadManualOrThrow(id);
    await assertVatPeriodNotLocked(this.prisma, existing.taxPeriodYear, [
      existing.taxPeriodMonth,
    ]);
    await this.prisma.vatLedgerEntry.delete({ where: { id } });
    return { id };
  }

  // ── interno ────────────────────────────────────────────────────────────────

  /**
   * Učitaj stavku i potvrdi da je RUČNA (source = null). GK-izvedene stavke
   * (`sourceJournalEntryId != null`) su read-only kroz ovaj put.
   */
  private async loadManualOrThrow(id: number) {
    const entry = await this.prisma.vatLedgerEntry.findUnique({ where: { id } });
    if (!entry) {
      throw new NotFoundException(`KIF/KUF stavka #${id} ne postoji.`);
    }
    if (entry.sourceJournalEntryId != null) {
      throw new ConflictException(
        `KIF/KUF stavka #${id} je izvedena iz glavne knjige (nalog #${entry.sourceJournalEntryId}) ` +
          `i ne može se ručno menjati ni brisati; izmeni izvorni nalog pa reknjiži period.`,
      );
    }
    return entry;
  }

  /** Prisma red → VatLedgerRow (isti oblik kao list metode). */
  private toRow(r: {
    id: number;
    direction: string;
    documentNumber: string;
    partnerId: number | null;
    documentDate: Date;
    taxPeriodYear: number;
    taxPeriodMonth: number;
    vatBase: Prisma.Decimal;
    vatAmount: Prisma.Decimal;
    vatRateCode: string | null;
    sourceJournalEntryId: number | null;
  }): VatLedgerRow {
    return {
      id: r.id,
      direction: r.direction,
      documentNumber: r.documentNumber,
      partnerId: r.partnerId,
      documentDate: r.documentDate,
      taxPeriodYear: r.taxPeriodYear,
      taxPeriodMonth: r.taxPeriodMonth,
      vatBase: r.vatBase,
      vatAmount: r.vatAmount,
      vatRateCode: r.vatRateCode,
      sourceJournalEntryId: r.sourceJournalEntryId,
    };
  }

  private async list(
    direction: "input" | "output",
    year: number,
    month: number,
  ): Promise<VatLedgerRow[]> {
    this.assertPeriod(year, month);
    const rows = await this.prisma.vatLedgerEntry.findMany({
      where: {
        direction,
        taxPeriodYear: year,
        taxPeriodMonth: month,
      },
      orderBy: [{ documentDate: "asc" }, { id: "asc" }],
    });
    return rows.map((r) => ({
      id: r.id,
      direction: r.direction,
      documentNumber: r.documentNumber,
      partnerId: r.partnerId,
      documentDate: r.documentDate,
      taxPeriodYear: r.taxPeriodYear,
      taxPeriodMonth: r.taxPeriodMonth,
      vatBase: r.vatBase,
      vatAmount: r.vatAmount,
      vatRateCode: r.vatRateCode,
      sourceJournalEntryId: r.sourceJournalEntryId,
    }));
  }

  /**
   * Osnovica iz iznosa PDV i nominalne stope: base = vat / (rate/100).
   * Konto bez stope (transit/uplatni 2790/4790) → osnovica 0 (nosi samo PDV).
   */
  private deriveBase(
    vatAmount: Prisma.Decimal,
    rate: number | null,
  ): Prisma.Decimal {
    if (rate == null || rate === 0) return ZERO;
    return vatAmount.div(new D(rate).div(100));
  }

  private assertPeriod(year: number, month: number): void {
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new InvalidVatPeriodException(year, month);
    }
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      throw new InvalidVatPeriodException(year, month);
    }
  }
}

/** Nevalidan poreski period (godina/mesec van opsega). */
export class InvalidVatPeriodException extends Error {
  readonly code = "PDV_INVALID_PERIOD";
  constructor(
    public readonly year: number,
    public readonly month: number,
  ) {
    super(`Nevalidan PDV period: godina=${year}, mesec=${month}.`);
    this.name = "InvalidVatPeriodException";
  }
}
