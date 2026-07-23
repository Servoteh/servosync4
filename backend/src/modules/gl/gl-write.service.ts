import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { PostingEngineService } from "./posting/posting.service";
import {
  type CreateJournalEntryDto,
  validateCreateJournalEntry,
} from "./dto/create-journal-entry.dto";

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
    return this.prisma.$transaction((tx) =>
      this.posting.postManualEntry(tx, {
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
      }),
    );
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
