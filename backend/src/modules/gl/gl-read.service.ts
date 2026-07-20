import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";

/**
 * Glavna knjiga — READ sloj (Faza 2). Nalozi (dnevnik), kartica konta, saldo.
 * Knjiženje radi PostingEngineService; ovaj servis samo čita ledger_entries /
 * journal_entries. Sve iznose vraća kao Decimal-string (BACKEND_RULES §6).
 */
@Injectable()
export class GlReadService {
  constructor(private readonly prisma: PrismaService) {}

  /** Dnevnik: lista naloga (paginirano, filter po vrsti/godini/statusu). */
  async listJournalEntries(query: {
    orderType?: string;
    year?: number;
    status?: string;
    skip?: number;
    take?: number;
  }) {
    const where: Prisma.JournalEntryWhereInput = {
      ...(query.orderType ? { orderTypeCode: query.orderType } : {}),
      ...(query.year ? { year: query.year } : {}),
      ...(query.status ? { status: query.status } : {}),
    };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.journalEntry.findMany({
        where,
        orderBy: [{ year: "desc" }, { number: "desc" }],
        skip: query.skip ?? 0,
        take: query.take ?? 50,
      }),
      this.prisma.journalEntry.count({ where }),
    ]);
    return { data, meta: { total } };
  }

  /** Jedan nalog sa stavkama (dnevnik detalj). */
  async getJournalEntry(id: number) {
    const entry = await this.prisma.journalEntry.findUnique({
      where: { id },
      include: { lines: true },
    });
    if (!entry) throw new NotFoundException(`Nalog ${id} ne postoji.`);
    return { data: entry };
  }

  /**
   * Kartica konta (analitička/sintetička) — sve stavke jednog konta hronološki,
   * sa tekućim saldom (running balance). Filter po komitentu i periodu.
   */
  async accountCard(query: {
    accountCode: string;
    analyticalCode?: number;
    from?: Date;
    to?: Date;
  }) {
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: number;
        journalNumber: string;
        documentDate: Date;
        documentNumber: string | null;
        analyticalCode: number | null;
        description: string | null;
        debit: Prisma.Decimal;
        credit: Prisma.Decimal;
      }>
    >(Prisma.sql`
      SELECT le.id, je.number AS "journalNumber", je.document_date AS "documentDate",
             le.document_number AS "documentNumber", le.analytical_code AS "analyticalCode",
             le.description, le.debit, le.credit
      FROM ledger_entries le
      JOIN journal_entries je ON je.id = le.journal_entry_id
      WHERE le.account_code = ${query.accountCode}
        AND je.status IN ('posted', 'locked')
        ${query.analyticalCode != null ? Prisma.sql`AND le.analytical_code = ${query.analyticalCode}` : Prisma.empty}
        ${query.from ? Prisma.sql`AND je.document_date >= ${query.from}` : Prisma.empty}
        ${query.to ? Prisma.sql`AND je.document_date <= ${query.to}` : Prisma.empty}
      ORDER BY je.document_date ASC, le.id ASC
    `);

    // Running saldo (Decimal) + zbirovi.
    const D = Prisma.Decimal;
    let running = new D(0);
    let totalDebit = new D(0);
    let totalCredit = new D(0);
    const lines = rows.map((r) => {
      running = running.plus(r.debit).minus(r.credit);
      totalDebit = totalDebit.plus(r.debit);
      totalCredit = totalCredit.plus(r.credit);
      return { ...r, balance: running };
    });
    return {
      data: lines,
      meta: {
        accountCode: query.accountCode,
        totalDebit,
        totalCredit,
        balance: running,
        count: lines.length,
      },
    };
  }
}
