import { businessYear } from "../../common/business-date";
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { PostingEngineService } from "./posting/posting.service";
import {
  type CreateJournalEntryDto,
  type CreateJournalEntryLineInput,
  validateCreateJournalEntry,
} from "./dto/create-journal-entry.dto";

/** Mesto troška po liniji (B2 — salda po poslovima). Aditivno na DTO liniju; DTO se ne dira. */
type LineWithCostCenter = CreateJournalEntryLineInput & {
  costCenter?: string | null;
};

/**
 * Devizni par po liniji (C2 — devizne otvorene stavke, doc 30 §D DevDuguje/DevPotrazuje/
 * DevValuta). Aditivno na DTO liniju; DTO se ne dira (isti obrazac kao costCenter).
 * `fxCurrency` je opcion — bez njega se uzima `currency` linije.
 */
type LineWithFx = CreateJournalEntryLineInput & {
  fxDebit?: number | string | null;
  fxCredit?: number | string | null;
  fxCurrency?: string | null;
};

/** LedgerEntry.costCenter je VarChar(20) — duže odbij jasnom 400 umesto DB 500. */
const COST_CENTER_MAX = 20;

/** Domaća valuta — stavka u RSD nema devizni par (fx kolone ostaju NULL). */
const HOME_CURRENCY = "RSD";

/** Devizni iznosi jedne stavke (normalizovani); null = stavka nije devizna. */
interface LineFxAmounts {
  fxDebit: Prisma.Decimal;
  fxCredit: Prisma.Decimal;
  fxCurrency: string;
}

/**
 * GL WRITE — ručni unos naloga (temeljnice) + status-mašina naloga + storno.
 * BigBit paritet (gap-audit Talas 1): računovođa mora moći da ukuca nalog, da
 * proknjiži/zaključa automatske robne naloge (koji stoje u `draft`), i da stornira.
 *
 * Status naloga: draft → posted → locked. Ručni nalog ide odmah `posted` (kroz
 * PostingEngine.postManualEntry, balans-kontrola ΣDug=ΣPot). Robni auto-nalozi
 * nastaju kao `draft` (postFromStockDocument) i ovde se prevode u posted/locked.
 */
@Injectable()
export class GlWriteService {
  private readonly logger = new Logger(GlWriteService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly posting: PostingEngineService,
  ) {}

  /**
   * Ručni unos naloga (BigBit „Unos naloga glavne knjige"). Otvara sopstvenu
   * transakciju i delegira na PostingEngine.postManualEntry (balans-kontrola +
   * numeracija). Vraća {journalEntryId, number, lineCount}.
   */
  async createManualEntry(dto: CreateJournalEntryDto, actorUserId?: number) {
    validateCreateJournalEntry(dto);

    // Mesto troška po liniji (B2). Normalizuj + validiraj dužinu pre transakcije.
    const costCenters = dto.lines.map((l) => {
      const raw = (l as LineWithCostCenter).costCenter;
      const cc = typeof raw === "string" ? raw.trim() : "";
      if (cc.length > COST_CENTER_MAX)
        throw new BadRequestException(
          `Mesto troška može imati najviše ${COST_CENTER_MAX} znakova.`,
        );
      return cc;
    });
    const hasCostCenter = costCenters.some((cc) => cc !== "");

    // Devizni par po liniji (C2). Normalizuj + validiraj PRE transakcije; stavka bez
    // devizne valute ili bez deviznog iznosa ostaje netaknuta (fx kolone NULL) —
    // postojeći pozivi bez valute rade nepromenjeno.
    const fxAmounts = dto.lines.map((l, i) => this.normalizeLineFx(l, i));
    const hasFx = fxAmounts.some((fx) => fx !== null);

    return this.prisma.$transaction(async (tx) => {
      const result = await this.posting.postManualEntry(tx, {
        orderType: dto.orderType,
        documentDate: new Date(dto.documentDate),
        companyId: dto.companyId ?? 0,
        description: dto.description,
        createdByUserId: actorUserId,
        lines: dto.lines.map((l) => ({
          accountCode: l.accountCode,
          analyticalCode: l.analyticalCode ?? null,
          debit: l.debit ?? 0,
          credit: l.credit ?? 0,
          description: l.description,
          documentNumber: l.documentNumber ?? null,
          dueDate: l.dueDate ? new Date(l.dueDate) : null,
          currency: l.currency ?? null,
        })),
      });

      // costCenter i devizni par se upisuju posle knjiženja (postManualEntry ne dira
      // PDV/robni tok). postManualEntry kreira LedgerEntry 1:1 iz `lines` u istom
      // redosledu (bez GROUP BY), pa red po `id ASC` odgovara ulaznim `dto.lines` po indeksu.
      if (hasCostCenter || hasFx) {
        const created = await tx.ledgerEntry.findMany({
          where: { journalEntryId: result.journalEntryId },
          orderBy: { id: "asc" },
          select: { id: true },
        });
        const n = Math.min(created.length, dto.lines.length);
        for (let i = 0; i < n; i++) {
          const data: Prisma.LedgerEntryUpdateInput = {};
          if (costCenters[i] !== "") data.costCenter = costCenters[i];
          const fx = fxAmounts[i];
          if (fx) {
            data.fxDebit = fx.fxDebit;
            data.fxCredit = fx.fxCredit;
            data.fxCurrency = fx.fxCurrency;
          }
          if (Object.keys(data).length > 0) {
            await tx.ledgerEntry.update({ where: { id: created[i].id }, data });
          }
        }
      }

      return result;
    });
  }

  /**
   * Devizni iznosi jedne stavke naloga (C2). Vraća `null` kad stavka nije devizna —
   * tada fx kolone ostaju NULL i ponašanje je identično dosadašnjem.
   *
   * Pravila:
   *   • valuta = `fxCurrency` ako je dat, inače `currency` stavke; prazno ili RSD → nije devizna;
   *   • bez ijednog deviznog iznosa (fxDebit/fxCredit) → nije devizna (stara knjiženja koja
   *     su nosila samo `currency`, bez deviznog iznosa, ostaju netaknuta — inače bi ušla u
   *     revalorizaciju sa deviznim saldom 0 i „obrisala" celu protivvrednost);
   *   • devizni iznos mora biti na ISTOJ strani kao dinarski (dug↔dug, pot↔pot).
   */
  private normalizeLineFx(
    line: CreateJournalEntryLineInput,
    index: number,
  ): LineFxAmounts | null {
    const l = line as LineWithFx;
    const rawCurrency =
      typeof l.fxCurrency === "string" && l.fxCurrency.trim() !== ""
        ? l.fxCurrency
        : (l.currency ?? "");
    const currency =
      typeof rawCurrency === "string" ? rawCurrency.trim().toUpperCase() : "";
    if (currency === "" || currency === HOME_CURRENCY) return null;

    const label = `Stavka ${index + 1}`;
    if (currency.length !== 3)
      throw new BadRequestException(
        `${label}: valuta mora imati tačno tri znaka (npr. EUR).`,
      );

    const fxDebit = this.parseFxAmount(l.fxDebit, `${label}: devizno duguje`);
    const fxCredit = this.parseFxAmount(
      l.fxCredit,
      `${label}: devizno potražuje`,
    );
    if (fxDebit.isZero() && fxCredit.isZero()) return null;

    if (!fxDebit.isZero() && !fxCredit.isZero())
      throw new BadRequestException(
        `${label}: devizna stavka ne može imati i duguje i potražuje.`,
      );

    // Devizni iznos mora pratiti stranu dinarskog iznosa — obrnuto bi devizni saldo
    // otvorene stavke dobio suprotan predznak od dinarskog (revalorizacija bi dala
    // dvostruku razliku umesto ispravke protivvrednosti).
    const debit = new Prisma.Decimal(line.debit ?? 0);
    const credit = new Prisma.Decimal(line.credit ?? 0);
    if (
      (debit.greaterThan(0) && !fxCredit.isZero()) ||
      (credit.greaterThan(0) && !fxDebit.isZero())
    )
      throw new BadRequestException(
        `${label}: devizni iznos mora biti na istoj strani kao dinarski (duguje/potražuje).`,
      );

    return { fxDebit, fxCredit, fxCurrency: currency };
  }

  /** Devizni iznos → Decimal; prazno = 0. Negativan/neispravan → 400. NIKAD Float. */
  private parseFxAmount(
    value: number | string | null | undefined,
    label: string,
  ): Prisma.Decimal {
    if (value === undefined || value === null || value === "")
      return new Prisma.Decimal(0);
    let parsed: Prisma.Decimal;
    try {
      parsed = new Prisma.Decimal(value);
    } catch {
      throw new BadRequestException(`${label} mora biti broj.`);
    }
    if (!parsed.isFinite() || parsed.isNegative())
      throw new BadRequestException(`${label} mora biti nenegativan broj.`);
    return parsed;
  }

  /** DRAFT → POSTED (proknjiži robni auto-nalog; bez ovoga kartica/bilans su prazni). */
  async markPosted(entryId: number, actorUserId?: number) {
    const entry = await this.getEntryOrThrow(entryId);
    if (entry.status !== "DRAFT")
      throw new ConflictException(
        `Nalog ${entryId} je u statusu ${entry.status}; knjiženje je moguće samo iz DRAFT.`,
      );
    await this.prisma.journalEntry.update({
      where: { id: entryId },
      data: {
        status: "POSTED",
        statusChangedByUserId: actorUserId ?? null,
        statusChangedAt: new Date(),
      },
    });
    return { id: entryId, status: "POSTED" };
  }

  /**
   * Masovno zaključavanje starih naloga (BigBit „zaključaj period"): svi `posted`
   * nalozi sa postingDate < beforeDate prelaze u `locked`. Vraća broj zaključanih.
   * Ne dira `draft` (nezavršeni) ni već `locked` — samo posted→locked.
   */
  async lockOlderThan(
    beforeDate: Date,
    opts: { dryRun?: boolean } = {},
    actorUserId?: number,
  ) {
    if (!(beforeDate instanceof Date) || Number.isNaN(beforeDate.getTime()))
      throw new ConflictException("Neispravan datum praga (beforeDate).");

    // GUARD (review Opus 5): masovno zaključavanje je nepovratno po nalogu (undo je
    // pojedinačan `unlock`). Prag u BUDUĆNOSTI bi zaključao CELU glavnu knjigu —
    // uključujući tekući period koji se još knjiži. Zato: prag mora biti <= danas.
    const now = new Date();
    if (beforeDate.getTime() > now.getTime())
      throw new ConflictException(
        `Datum praga (${beforeDate.toISOString().slice(0, 10)}) je u budućnosti — ` +
          `zaključavanje bi obuhvatilo i tekući period. Izaberi datum do danas.`,
      );

    const where: Prisma.JournalEntryWhereInput = {
      status: "POSTED",
      postingDate: { lt: beforeDate },
    };

    // DRY-RUN: prikaži koliko bi naloga bilo zaključano PRE nego što se izvrši
    // (FE zove prvo dry-run pa traži potvrdu — „zaključavam N naloga do datuma X").
    if (opts.dryRun) {
      const count = await this.prisma.journalEntry.count({ where });
      return { count, dryRun: true };
    }

    const res = await this.prisma.journalEntry.updateMany({
      where,
      data: {
        status: "LOCKED",
        statusChangedByUserId: actorUserId ?? null,
        statusChangedAt: new Date(),
      },
    });
    this.logger.warn(
      `LOCK-OLDER: zaključano ${res.count} naloga sa postingDate < ${beforeDate.toISOString().slice(0, 10)} (user ${actorUserId ?? "?"})`,
    );
    return { count: res.count, dryRun: false };
  }

  /**
   * locked → posted (OTKLJUČAVANJE naloga; review Opus 5 — masovni lock je do sada
   * bio bez povratka). Namenjeno ispravci greške pri zaključavanju perioda: vraća
   * nalog u `posted` da bi se mogao stornirati/ispraviti. Zahteva GL_WRITE.
   */
  async markUnlocked(entryId: number, actorUserId?: number) {
    const entry = await this.getEntryOrThrow(entryId);
    if (entry.status !== "LOCKED")
      throw new ConflictException(
        `Nalog ${entryId} je u statusu ${entry.status}; otključavanje je moguće samo iz LOCKED.`,
      );
    await this.prisma.journalEntry.update({
      where: { id: entryId },
      data: {
        status: "POSTED",
        statusChangedByUserId: actorUserId ?? null,
        statusChangedAt: new Date(),
      },
    });
    this.logger.warn(
      `UNLOCK naloga ${entryId} (LOCKED → POSTED, user ${actorUserId ?? "?"})`,
    );
    return { id: entryId, status: "POSTED" };
  }

  /** POSTED → LOCKED (zaključaj nalog — sprečava izmene/storno bez otključavanja). */
  async markLocked(entryId: number, actorUserId?: number) {
    const entry = await this.getEntryOrThrow(entryId);
    if (entry.status !== "POSTED")
      throw new ConflictException(
        `Nalog ${entryId} je u statusu ${entry.status}; zaključavanje je moguće samo iz POSTED.`,
      );
    await this.prisma.journalEntry.update({
      where: { id: entryId },
      data: {
        status: "LOCKED",
        statusChangedByUserId: actorUserId ?? null,
        statusChangedAt: new Date(),
      },
    });
    return { id: entryId, status: "LOCKED" };
  }

  /**
   * Storno naloga (BigBit — obrni Duguje↔Potražuje). Kreira NOVI nalog sa obrnutim
   * linijama, veže reversesEntryId=izvorni, i na izvornom postavlja reversedByEntryId.
   * Izvorni mora biti posted (ne draft, ne već storniran).
   *
   * DATUMI (`opts`) — PODRAZUMEVANO PONAŠANJE SE NE MENJA: bez `opts` storno ide sa
   * `postingDate = danas` i `documentDate` izvornog naloga, tačno kao do sada (storno
   * fakture i ostali pozivaoci). `opts.postingDate` postoji zbog naloga koji se čitaju
   * PRESEKOM NA DAN (revalorizacija deviznih stavki — open-items filtrira
   * `je.posting_date <= presek`): storno naloga za 31.12. sa današnjim datumom knjiženja
   * pada u naredni period, pa bi original ušao u ponovni obračun a storno ne — pogrešan
   * iznos I pogrešan predznak kursne razlike. Takav pozivalac prosleđuje presek izvornog
   * obračuna. `opts.documentDate` prati isti razlog (i određuje godinu numeracije).
   */
  async reverse(
    entryId: number,
    actorUserId?: number,
    opts?: { postingDate?: Date; documentDate?: Date },
  ) {
    const overrideDocumentDate = this.parseOptionalDate(
      opts?.documentDate,
      "documentDate",
    );
    const overridePostingDate = this.parseOptionalDate(
      opts?.postingDate,
      "postingDate",
    );
    const source = await this.prisma.journalEntry.findUnique({
      where: { id: entryId },
      include: { lines: true },
    });
    if (!source) throw new NotFoundException(`Nalog ${entryId} ne postoji.`);
    if (source.status === "DRAFT")
      throw new ConflictException("Nacrt naloga se ne stornira (obriši ga).");
    if (source.status === "LOCKED")
      throw new ConflictException(
        `Nalog ${entryId} je zaključan — prvo ga otključaj (unlock) pa storniraj; ` +
          `storno mimo otključavanja bi zaobišao kontrolu zaključanog perioda.`,
      );
    if (source.reversedByEntryId != null)
      throw new ConflictException(
        `Nalog ${entryId} je već storniran nalogom ${source.reversedByEntryId}.`,
      );

    const documentDate = overrideDocumentDate ?? source.documentDate;
    const postingDate = overridePostingDate ?? new Date();

    return this.prisma.$transaction(async (tx) => {
      // Godina se izvodi iz EFEKTIVNOG datuma dokumenta (može biti preklopljen —
      // revalorizacija stornira u sopstveni presek), kroz `businessYear` helper.
      const year = businessYear(documentDate);
      const number = await this.posting.nextJournalNumber(
        tx,
        source.companyId,
        source.orderTypeCode,
        year,
      );
      const storno = await tx.journalEntry.create({
        data: {
          number,
          orderTypeCode: source.orderTypeCode,
          year,
          companyId: source.companyId,
          documentDate,
          postingDate,
          status: "POSTED",
          createdByUserId: actorUserId ?? null,
          reversesEntryId: source.id,
          lines: {
            create: source.lines.map((l) => ({
              accountCode: l.accountCode,
              analyticalCode: l.analyticalCode,
              // Storno = zameni strane.
              debit: l.credit,
              credit: l.debit,
              // DEVIZNI par se ogleda ISTO kao dinarski (review C2): bez ovoga se
              // dinarska strana poništi a devizna ostane, pa devizni saldo otvorene
              // stavke ostane udvostručen i revalorizacija knjiži ogroman lažan iznos.
              fxDebit: l.fxCredit,
              fxCredit: l.fxDebit,
              fxCurrency: l.fxCurrency,
              description: `STORNO: ${l.description ?? ""}`.trim(),
              documentNumber: l.documentNumber,
              dueDate: l.dueDate,
              currency: l.currency,
              // Mesto troška prati stavku — inače storno „prebaci" trošak sa pozicije
              // na sintetiku i saldo po poslovima (B2) ostane zaglavljen.
              costCenter: l.costCenter,
            })),
          },
        },
      });
      await tx.journalEntry.update({
        where: { id: source.id },
        data: { reversedByEntryId: storno.id },
      });
      return { stornoEntryId: storno.id, number, reversedEntryId: source.id };
    });
  }

  /** Opcioni datum iz `opts` — nevalidan Date je programska greška pozivaoca → 400. */
  private parseOptionalDate(
    value: Date | undefined,
    label: string,
  ): Date | undefined {
    if (value === undefined || value === null) return undefined;
    if (!(value instanceof Date) || Number.isNaN(value.getTime()))
      throw new BadRequestException(`Neispravan datum storna (${label}).`);
    return value;
  }

  private async getEntryOrThrow(id: number) {
    const entry = await this.prisma.journalEntry.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!entry) throw new NotFoundException(`Nalog ${id} ne postoji.`);
    return entry;
  }
}
