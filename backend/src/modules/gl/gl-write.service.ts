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

/** LedgerEntry.costCenter je VarChar(20) — duže odbij jasnom 400 umesto DB 500. */
const COST_CENTER_MAX = 20;

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

      // costCenter se upisuje posle knjiženja (postManualEntry ne dira PDV/robni tok).
      // postManualEntry kreira LedgerEntry 1:1 iz `lines` u istom redosledu (bez GROUP BY),
      // pa red po `id ASC` odgovara ulaznim `dto.lines` po indeksu.
      if (hasCostCenter) {
        const created = await tx.ledgerEntry.findMany({
          where: { journalEntryId: result.journalEntryId },
          orderBy: { id: "asc" },
          select: { id: true },
        });
        const n = Math.min(created.length, costCenters.length);
        for (let i = 0; i < n; i++) {
          if (costCenters[i] !== "") {
            await tx.ledgerEntry.update({
              where: { id: created[i].id },
              data: { costCenter: costCenters[i] },
            });
          }
        }
      }

      return result;
    });
  }

  /** draft → posted (proknjiži robni auto-nalog; bez ovoga kartica/bilans su prazni). */
  async markPosted(entryId: number) {
    const entry = await this.getEntryOrThrow(entryId);
    if (entry.status !== "draft")
      throw new ConflictException(
        `Nalog ${entryId} je u statusu ${entry.status}; knjiženje je moguće samo iz draft.`,
      );
    await this.prisma.journalEntry.update({
      where: { id: entryId },
      data: { status: "posted" },
    });
    return { id: entryId, status: "posted" };
  }

  /**
   * Masovno zaključavanje starih naloga (BigBit „zaključaj period"): svi `posted`
   * nalozi sa postingDate < beforeDate prelaze u `locked`. Vraća broj zaključanih.
   * Ne dira `draft` (nezavršeni) ni već `locked` — samo posted→locked.
   */
  async lockOlderThan(beforeDate: Date, opts: { dryRun?: boolean } = {}) {
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
      status: "posted",
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
      data: { status: "locked" },
    });
    this.logger.warn(
      `LOCK-OLDER: zaključano ${res.count} naloga sa postingDate < ${beforeDate.toISOString().slice(0, 10)}`,
    );
    return { count: res.count, dryRun: false };
  }

  /**
   * locked → posted (OTKLJUČAVANJE naloga; review Opus 5 — masovni lock je do sada
   * bio bez povratka). Namenjeno ispravci greške pri zaključavanju perioda: vraća
   * nalog u `posted` da bi se mogao stornirati/ispraviti. Zahteva GL_WRITE.
   */
  async markUnlocked(entryId: number) {
    const entry = await this.getEntryOrThrow(entryId);
    if (entry.status !== "locked")
      throw new ConflictException(
        `Nalog ${entryId} je u statusu ${entry.status}; otključavanje je moguće samo iz locked.`,
      );
    await this.prisma.journalEntry.update({
      where: { id: entryId },
      data: { status: "posted" },
    });
    this.logger.warn(`UNLOCK naloga ${entryId} (locked → posted)`);
    return { id: entryId, status: "posted" };
  }

  /** posted → locked (zaključaj nalog — sprečava izmene/storno bez otključavanja). */
  async markLocked(entryId: number) {
    const entry = await this.getEntryOrThrow(entryId);
    if (entry.status !== "posted")
      throw new ConflictException(
        `Nalog ${entryId} je u statusu ${entry.status}; zaključavanje je moguće samo iz posted.`,
      );
    await this.prisma.journalEntry.update({
      where: { id: entryId },
      data: { status: "locked" },
    });
    return { id: entryId, status: "locked" };
  }

  /**
   * Storno naloga (BigBit — obrni Duguje↔Potražuje). Kreira NOVI nalog sa obrnutim
   * linijama, veže reversesEntryId=izvorni, i na izvornom postavlja reversedByEntryId.
   * Izvorni mora biti posted (ne draft, ne već storniran).
   */
  async reverse(entryId: number, actorUserId?: number) {
    const source = await this.prisma.journalEntry.findUnique({
      where: { id: entryId },
      include: { lines: true },
    });
    if (!source) throw new NotFoundException(`Nalog ${entryId} ne postoji.`);
    if (source.status === "draft")
      throw new ConflictException("Nacrt naloga se ne stornira (obriši ga).");
    if (source.reversedByEntryId != null)
      throw new ConflictException(
        `Nalog ${entryId} je već storniran nalogom ${source.reversedByEntryId}.`,
      );

    return this.prisma.$transaction(async (tx) => {
      const year = source.documentDate.getFullYear();
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
          documentDate: source.documentDate,
          postingDate: new Date(),
          status: "posted",
          createdByUserId: actorUserId ?? null,
          reversesEntryId: source.id,
          lines: {
            create: source.lines.map((l) => ({
              accountCode: l.accountCode,
              analyticalCode: l.analyticalCode,
              // Storno = zameni strane.
              debit: l.credit,
              credit: l.debit,
              description: `STORNO: ${l.description ?? ""}`.trim(),
              documentNumber: l.documentNumber,
              dueDate: l.dueDate,
              currency: l.currency,
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

  private async getEntryOrThrow(id: number) {
    const entry = await this.prisma.journalEntry.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!entry) throw new NotFoundException(`Nalog ${id} ne postoji.`);
    return entry;
  }
}
