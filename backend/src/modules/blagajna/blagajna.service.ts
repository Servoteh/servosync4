import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { PostingEngineService } from "../gl/posting/posting.service";
import type { AuthUser } from "../auth/jwt.strategy";
import {
  type CreateCashJournalDto,
  type CreateCashEntryDto,
  validateCreateCashJournal,
  validateCreateCashEntry,
} from "./dto/blagajna.dto";

const D = Prisma.Decimal;
const ZERO = new D(0);

/**
 * BLAGAJNA (gotovinski dnevnik) — XL modul (SAP Cash Journal, BigBit KASE).
 * ============================================================================
 * Uplatnica (IN) = uplata gotovine U blagajnu: konto blagajne DUGUJE, protivkonto POTRAŽUJE.
 * Isplatnica (OUT) = isplata gotovine IZ blagajne: konto blagajne POTRAŽUJE, protivkonto DUGUJE.
 * Auto-knjiženje kroz PostingEngine.postManualEntry (balans ΣDug=ΣPot, vrsta „BLG").
 * Stanje blagajne = Σ(IN) − Σ(OUT) as-of (računato iz cash_entries, ne materijalizovano).
 * Poslovne greške = NestJS ugrađeni exception-i (404/409).
 */
@Injectable()
export class BlagajnaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posting: PostingEngineService,
  ) {}

  // ── Blagajne (registri) ────────────────────────────────────────────────

  async listJournals() {
    const rows = await this.prisma.cashJournal.findMany({
      orderBy: [{ companyId: "asc" }, { id: "asc" }],
    });
    // Priloži tekući saldo po blagajni (Σ IN − Σ OUT proknjiženih+draft stavki).
    const withBalance = await Promise.all(
      rows.map(async (j) => ({
        ...j,
        balance: (await this.balanceOf(j.id)).toFixed(2),
      })),
    );
    return { data: withBalance };
  }

  async createJournal(dto: CreateCashJournalDto) {
    validateCreateCashJournal(dto);
    return this.prisma.cashJournal.create({
      data: {
        name: dto.name.trim(),
        accountCode: dto.accountCode.trim(),
        currency: dto.currency ?? "RSD",
        companyId: dto.companyId ?? 0,
      },
    });
  }

  // ── Stavke (uplatnice/isplatnice) ───────────────────────────────────────

  /** Stanje blagajne = Σ(IN.amount) − Σ(OUT.amount) do (uklj.) datuma (default sve). */
  async balanceOf(journalId: number, asOf?: Date): Promise<Prisma.Decimal> {
    const where: Prisma.CashEntryWhereInput = { cashJournalId: journalId };
    if (asOf) where.entryDate = { lte: asOf };
    const entries = await this.prisma.cashEntry.findMany({
      where,
      select: { direction: true, amount: true },
    });
    let bal = ZERO;
    for (const e of entries) {
      bal = e.direction === "IN" ? bal.add(e.amount) : bal.sub(e.amount);
    }
    return bal;
  }

  async listEntries(journalId: number, params: { skip?: number; take?: number }) {
    await this.getJournalOrThrow(journalId);
    const take = Math.min(params.take ?? 100, 500);
    const skip = params.skip ?? 0;
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.cashEntry.findMany({
        where: { cashJournalId: journalId },
        orderBy: [{ entryDate: "desc" }, { id: "desc" }],
        skip,
        take,
      }),
      this.prisma.cashEntry.count({ where: { cashJournalId: journalId } }),
    ]);
    return {
      data: rows.map((e) => ({
        id: e.id,
        entryNumber: e.entryNumber,
        direction: e.direction,
        amount: e.amount.toFixed(2),
        entryDate: e.entryDate,
        partnerId: e.partnerId,
        contraAccount: e.contraAccount,
        description: e.description,
        status: e.status,
        journalEntryId: e.journalEntryId,
      })),
      meta: { total, skip, take },
    };
  }

  /**
   * Kreiraj uplatnicu/isplatnicu. Ako `post` (default true) → auto-knjiži u GK
   * (blagajna ↔ protivkonto) i veže journalEntryId, status POSTED. OUT ne sme
   * da odvede blagajnu u minus (gotovina ne može biti negativna).
   */
  async createEntry(journalId: number, dto: CreateCashEntryDto, actor?: AuthUser) {
    validateCreateCashEntry(dto);
    const journal = await this.getJournalOrThrow(journalId);

    const amount = new D(dto.amount);
    const entryDate = dto.entryDate ? new Date(dto.entryDate) : new Date();

    if (dto.direction === "OUT") {
      const bal = await this.balanceOf(journalId);
      if (bal.lt(amount))
        throw new ConflictException(
          `Nedovoljno gotovine u blagajni (stanje ${bal.toFixed(2)}, isplata ${amount.toFixed(2)}).`,
        );
    }

    return this.prisma.$transaction(async (tx) => {
      const entryNumber = await this.nextEntryNumber(
        tx,
        journalId,
        dto.direction,
        entryDate.getFullYear(),
      );

      let journalEntryId: number | null = null;
      const shouldPost = dto.post ?? true;
      if (shouldPost) {
        // Uplatnica IN: blagajna DUGUJE, protivkonto POTRAŽUJE. OUT: obrnuto.
        const cashDebit = dto.direction === "IN";
        const posted = await this.posting.postManualEntry(tx, {
          orderType: "BLG",
          documentDate: entryDate,
          companyId: journal.companyId,
          description:
            `Blagajna ${journal.name} — ${dto.direction === "IN" ? "uplatnica" : "isplatnica"} ${entryNumber}`.trim(),
          createdByUserId: actor?.userId,
          lines: [
            {
              accountCode: journal.accountCode,
              analyticalCode: dto.partnerId ?? null,
              debit: cashDebit ? dto.amount : 0,
              credit: cashDebit ? 0 : dto.amount,
              description: dto.description ?? undefined,
            },
            {
              accountCode: dto.contraAccount.trim(),
              analyticalCode: dto.partnerId ?? null,
              debit: cashDebit ? 0 : dto.amount,
              credit: cashDebit ? dto.amount : 0,
              description: dto.description ?? undefined,
            },
          ],
        });
        journalEntryId = posted.journalEntryId;
      }

      const entry = await tx.cashEntry.create({
        data: {
          cashJournalId: journalId,
          entryNumber,
          direction: dto.direction,
          amount,
          entryDate,
          partnerId: dto.partnerId ?? null,
          contraAccount: dto.contraAccount.trim(),
          description: dto.description ?? null,
          status: shouldPost ? "POSTED" : "DRAFT",
          journalEntryId,
          createdByUserId: actor?.userId ?? null,
        },
      });
      return {
        id: entry.id,
        entryNumber,
        direction: entry.direction,
        amount: entry.amount.toFixed(2),
        status: entry.status,
        journalEntryId,
      };
    });
  }

  // ── Helperi ─────────────────────────────────────────────────────────────

  private async getJournalOrThrow(id: number) {
    const j = await this.prisma.cashJournal.findUnique({ where: { id } });
    if (!j) throw new NotFoundException(`Blagajna ${id} ne postoji.`);
    return j;
  }

  /** NNNN/god po (blagajna, smer), numerički MAX + advisory lock. */
  private async nextEntryNumber(
    tx: Prisma.TransactionClient,
    journalId: number,
    direction: string,
    year: number,
  ): Promise<string> {
    const suffix = `/${year}`;
    const lockKey = `blagajna:${journalId}:${direction}:${year}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
    const rows = await tx.cashEntry.findMany({
      where: { cashJournalId: journalId, direction, entryNumber: { endsWith: suffix } },
      select: { entryNumber: true },
    });
    let max = 0;
    for (const r of rows) {
      const n = Number.parseInt(r.entryNumber.slice(0, -suffix.length), 10);
      if (!Number.isNaN(n) && n > max) max = n;
    }
    return `${String(max + 1).padStart(4, "0")}${suffix}`;
  }
}
