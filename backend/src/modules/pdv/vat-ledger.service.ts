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
 * Izvodi se za SVAKO konto sa stopom — i za korekcije („zatvaranje/pokrivanje
 * avansa", „interni račun"), jer i one nose osnovicu, samo sa suprotnim znakom.
 * Raniji `has_base = false` je te osnovice gutao i naduvavao zbir za stotine
 * miliona (implicitna stopa KIF 02/2026 je bila 6,99% umesto 20%) — kolona je
 * ukinuta (migracija 20260727090000), a provera P5 u `vat-sanity.ts` čuva da se
 * greška ne vrati: Σ PDV mora odgovarati Σ osnovica × stopa unutar svake stope.
 *
 * TEHNIČKI NALOG ZATVARANJA PDV KONTA (vrsta `PDV`) se IZUZIMA — vidi
 * `VAT_SETTLEMENT_ORDER_TYPE` u `vat-sanity.ts` za razlog i za obrazac
 * preciznog izuzimanja (isti kao `CLOSING_ORDER_TYPE` u zavrsni/gkeval).
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
  assertVatPeriodSane,
  checkVatPeriodSanity,
  VAT_SETTLEMENT_ORDER_TYPE,
  type VatSanityReport,
} from "./vat-sanity";
import {
  type CreateManualVatEntryDto,
  type UpdateManualVatEntryDto,
  validateCreateManualVatEntry,
  validateUpdateManualVatEntry,
  VAT_RATE_CODE_NO_DEDUCTION,
  isNoDeduction,
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
  /** „Van PDV" (KUF bez prava odbitka) — izvedeno iz `vatRateCode === "VP"`. */
  noDeduction: boolean;
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
  outputBase: Prisma.Decimal; // Σ osnovica KIF (izvedena iz stope)
  inputBase: Prisma.Decimal; // Σ osnovica KUF (izvedena iz stope)
  /** Provera ispravnosti perioda (problemi + upozorenja + kontrola vs BigBit). */
  sanity: VatSanityReport;
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
   * poreski period). Uzima se SAMO proknjižen nalog (status = 'POSTED').
   *
   * ZAŠTITA: posle punjenja (u ISTOJ transakciji) radi se provera ispravnosti
   * (`vat-sanity.ts`). Ako je rezultat očigledno besmislen — stavke postoje a
   * zbir je nula, osnovica je nula uz PDV različit od nule, ili se rezultat ne
   * slaže sa BigBit-ovim nalogom zatvaranja — baca se 409 i CELO punjenje se
   * poništava (rollback), pa knjige ostaju u prethodnom stanju umesto da tiho
   * prime besmislice. `force = true` upisuje i takav period (za dijagnostiku),
   * ali izveštaj o problemima ostaje u odgovoru.
   */
  async buildKifKuf(
    year: number,
    month: number,
    opts: { force?: boolean } = {},
  ): Promise<BuildKifKufResult> {
    this.assertPeriod(year, month);

    // D3: reknjiženje zaključanog (POSTED) perioda nije dozvoljeno — inače bi
    // deleteMany tiho pregazio predat obrazac.
    await assertVatPeriodNotLocked(this.prisma, year, [month]);

    return this.prisma.$transaction(async (tx) => {
      // 1) Čist period — obriši prethodno punjenje (idempotentnost).
      //    D4: briše SAMO GK-izvedene stavke (sourceJournalEntryId != null);
      //    ručne stavke (source = null) opstaju kroz reknjiženje iz GK.
      //    B4: „van PDV" (KUF bez odbitka) su UVEK ručne (marker vatRateCode="VP",
      //    knjiže se na trošak, ne na pretporez konto 27x) → nikad ne ulaze u GK
      //    agregaciju ispod (JOIN vat_account_map daje samo numeričku vam.rate),
      //    pa je `inputVat` ovog punjenja isključuje po konstrukciji i deleteMany
      //    ih ne dira (source = null).
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
      //    dugovanjem 27x). Uzimamo neto vrednost po grupi SA ZNAKOM —
      //    negativne linije (knjižna odobrenja, korekcije: BigBit ne stornira
      //    kontra-nalogom nego negativnim iznosom na istoj strani) su legitimne
      //    i NE SMEJU se odbacivati ni filterom ni ABS()-om.
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
          -- 'LOCKED' MORA biti uključen: zaključan period (lock-older) je i dalje
          -- proknjižen — bez ovoga KIF/KUF za zaključan period ostaje prazan.
          WHERE je.status IN ('POSTED', 'LOCKED')
            AND EXTRACT(YEAR FROM je.posting_date) = ${year}
            AND EXTRACT(MONTH FROM je.posting_date) = ${month}
            -- TEHNIČKI NALOG ZATVARANJA PDV KONTA (vrsta 'PDV') — izuzet PRECIZNO.
            -- Uslov stoji UZ JOIN na vat_account_map, dakle iz tog naloga ispadaju
            -- SAMO stavke na PDV kontima (ogledalo mesečnog prometa sa suprotnim
            -- znakom — bez ovoga se ceo mesec poništi u nulu: KUF 03/2026 je imao
            -- 625 stavki i UKUPNO 0,00). Stavke istog naloga na transitnom kontu
            -- 2790/4790 i na zaokruženju 6799/5799 NAMERNO ostaju u glavnoj
            -- knjizi — to je rezultat obračuna prema PU i kontrolna tačka provere.
            -- COALESCE je obavezan: uz NULL vrstu, NULL <> 'PDV' daje NULL i red
            -- bi ispao iz WHERE (stari nalozi bez upisane vrste bi nestali).
            AND COALESCE(je.order_type_code, '') <> ${VAT_SETTLEMENT_ORDER_TYPE}
          GROUP BY
            le.journal_entry_id, le.document_number, le.analytical_code,
            je.posting_date, le.account_code, vam.direction, vam.rate
        `,
      );

      const toInsert: Prisma.VatLedgerEntryCreateManyInput[] = [];
      let outputVat = ZERO;
      let inputVat = ZERO;
      let outputBase = ZERO;
      let inputBase = ZERO;
      let kifCount = 0;
      let kufCount = 0;

      for (const r of rows) {
        const vatAmount = r.vat_amount ?? ZERO;
        // Preskoči nulte grupe (npr. dug=pot na istom kontu u istom dokumentu).
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
          outputBase = outputBase.add(vatBase);
          kifCount += 1;
        } else {
          inputVat = inputVat.add(vatAmount);
          inputBase = inputBase.add(vatBase);
          kufCount += 1;
        }
      }

      if (toInsert.length > 0) {
        await tx.vatLedgerEntry.createMany({ data: toInsert });
      }

      // 3) ZAŠTITA OD TIHE GREŠKE — čita TEK UPISANE knjige (uključujući ručne
      //    stavke) u istoj transakciji. Pad provere ⇒ throw ⇒ rollback punjenja.
      const sanity = await checkVatPeriodSanity(tx, year, [month]);
      if (!opts.force) {
        assertVatPeriodSane(sanity, `Punjenje KIF/KUF za ${sanity.periodLabel}`);
      }

      return {
        year,
        month,
        kifCount,
        kufCount,
        outputVat,
        inputVat,
        outputBase,
        inputBase,
        sanity,
      };
    });
  }

  /**
   * Provera ispravnosti perioda BEZ punjenja i bez štampe — da ekran i CSV izvoz
   * ne budu jedini put kojim neispravan period izlazi iz aplikacije bez oznake.
   * Ranije je zaštita stajala samo na PDF-u i mejlu, pa je „Izvezi CSV" (koji
   * gradi fajl iz redova već u memoriji) tiho iznosio period koji se NE SME
   * odštampati. Vezano za PODATAK, ne za format izlaza.
   */
  async checkPeriod(year: number, month: number): Promise<VatSanityReport> {
    this.assertPeriod(year, month);
    return checkVatPeriodSanity(this.prisma, year, [month]);
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

    // „Van PDV" (bez prava odbitka) → vatRateCode nosi marker "VP" umesto stope;
    // stavka ostaje u KUF listi ali izlazi iz pretporeza (popdv/sumManualVatEntries).
    const vatRateCode = dto.noDeduction === true
      ? VAT_RATE_CODE_NO_DEDUCTION
      : (dto.vatRateCode ?? null);

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
        vatRateCode,
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

    // Efektivni smer posle izmene (dto.direction ili postojeći) — „van PDV" marker
    // sme samo na ulaznom računu (KUF). DTO ne vidi postojeći smer, pa se čuva ovde.
    const effectiveDirection = dto.direction ?? existing.direction;
    // Guard gleda i DOLAZNI flag i VEĆ PERZISTIRAN marker (review Batch B): bez druge
    // provere se input+VP stavka mogla prebaciti na `output` a da marker preživi —
    // takva stavka je vidljiva u KIF-u ali ispada iz obaveze (potcenjen izlazni PDV).
    const keepsMarker =
      dto.noDeduction === true ||
      (dto.noDeduction === undefined &&
        dto.vatRateCode === undefined &&
        isNoDeduction(existing.vatRateCode));
    if (keepsMarker && effectiveDirection === "output") {
      throw new ConflictException(
        '„Bez prava odbitka" važi samo za ulazni račun (KUF), ne za KIF. ' +
          "Skini oznaku (ili zadaj stopu) pre prebacivanja stavke na izlaznu stranu.",
      );
    }

    // Razrešavanje vatRateCode uz „van PDV" marker (prioritet nad prosleđenom stopom):
    //   noDeduction=true  → "VP" (marker); noDeduction=false → prosleđena stopa/null;
    //   noDeduction izostavljen → normalna izmena vatRateCode ako je poslata.
    let vatRateCodeUpdate: string | null | undefined;
    if (dto.noDeduction === true) {
      vatRateCodeUpdate = VAT_RATE_CODE_NO_DEDUCTION;
    } else if (dto.vatRateCode !== undefined) {
      // Eksplicitna stopa (uz ili bez noDeduction=false) — direktno se upisuje.
      vatRateCodeUpdate = dto.vatRateCode ?? null;
    } else if (dto.noDeduction === false && isNoDeduction(existing.vatRateCode)) {
      // Skini marker bez zadate stope — očisti na null (bez odbitka → bez stope).
      vatRateCodeUpdate = null;
    } else {
      vatRateCodeUpdate = undefined; // nema izmene stope
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
        ...(vatRateCodeUpdate !== undefined
          ? { vatRateCode: vatRateCodeUpdate }
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
      noDeduction: isNoDeduction(r.vatRateCode),
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
      noDeduction: isNoDeduction(r.vatRateCode),
      sourceJournalEntryId: r.sourceJournalEntryId,
    }));
  }

  /**
   * Osnovica iz iznosa PDV i nominalne stope: base = vat / (rate/100). To je
   * BigBit-ov metod (POPDV_SemeKontaZaKnjizenje ima kolone tipa `D/0.2` = Σ
   * duguje / 0,2 = osnovica) i formula je tačna.
   *
   * Izvodi se za SVAKO konto sa stopom, uključujući korekcije („zatvaranje /
   * pokrivanje avansa", „interni račun") — one su promet po istoj stopi, samo sa
   * suprotnim znakom odn. na obe strane; izuzimanje im je gutalo osnovicu i
   * naduvavalo zbir (v. migraciju 20260727090000, uzrok C).
   *
   * DVA slučaja daju osnovicu 0:
   *   - `rate = null` — konto bez stope,
   *   - `rate = 0` — deljenje nulom; stopa 0 nosi promet BEZ poreza, a takav
   *     promet se u POPDV ne izvodi iz PDV konta nego iz PROMETNIH konta preko
   *     `popdv_account_map` (zato izvozni/0% konto i nije u ovom registru).
   * Oba su vidljiva: provera P5 (`vat-sanity.ts`) traži da Σ PDV odgovara
   * Σ osnovica × stopa unutar svake stope, pa nula uz PDV ≠ 0 obara period.
   *
   * ⚠️ ZAVISNOST OD PRAVILA NA IZVORU (02.08.2026): ova formula vraća BAŠ osnovicu
   * fakture samo ako je PDV na nju i obračunat — `PDV = round2(osnovica × stopa)`.
   * Dok je izlazni PDV bio ZBIR ZAOKRUŽENIH PDV-a PO STAVCI, to nije važilo: faktura sa
   * pet stavki po 100,01 din (20 %) nosila je osnovicu 500,05 uz PDV 100,00, pa je KIF
   * iz tog PDV-a izvodio 500,00 — dve pare manje nego što na računu piše. Od ispravke
   * (`sales/vat-totals.ts`) i GK i zaglavlje računaju po stopi, pa se osnovica vraća
   * tačno kad `osnovica × stopa` padne na celu paru.
   *
   * OSTATAK KOJI OVA FORMULA NE MOŽE DA POKRIJE: kad `osnovica × stopa` ima treću
   * decimalu (100,03 × 20 % = 20,006 → 20,01 → nazad 100,05), izvedena osnovica se
   * razlikuje do 0,02 (20 %) odn. 0,05 (10 %). To je granica SAMOG METODA „osnovica iz
   * PDV konta", a ne greška u obračunu — pravo rešenje je da KIF čita osnovicu sa
   * dokumenta umesto iz GK, što traži izmenu izvora KIF-a (nije u ovoj ispravci).
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
