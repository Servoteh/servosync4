import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import type { AuthUser } from "../auth/jwt.strategy";
import {
  BankStatementParserService,
  type ParsedStatementLine,
} from "./bank-statement-parser.service";
import {
  type ImportStatementDto,
  validateImportStatement,
} from "./dto/import-statement.dto";
import {
  type PostStatementDto,
  validatePostStatement,
} from "./dto/post-statement.dto";

const D = Prisma.Decimal;
const ZERO = new D(0);

/**
 * BANK STATEMENT SERVICE — uvoz + uparivanje + auto-knjiženje izvoda (Faza 4 §B).
 * =============================================================================
 * Tok (doc 21 §A): import TXT (parser fiksne kolone) → BankStatement(IMPORTED) + linije →
 *   matchLines (žiro komitenta → analitika; otvorena stavka po PNB/iznosu) →
 *   postStatement (dvojno knjiženje banka↔analitika pod JEDNIM nalogom) → status POSTED.
 *
 * Izvod se NE knjiži kroz "Šemu za kontiranje" (to je za fakture) — direktno banka↔analitika
 * (doc 21 §A). Zato ovaj servis kreira JournalEntry+LedgerEntry direktno (ne preko
 * PostingEngineService.postFromStockDocument, koji je vezan za robni dokument).
 *
 * Poslovne greške = NestJS ugrađeni exception-i (404/409/422), kao ostatak repoa.
 */
@Injectable()
export class BankStatementService {
  private readonly logger = new Logger(BankStatementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly parser: BankStatementParserService,
  ) {}

  // ── UVOZ ────────────────────────────────────────────────────────────────

  /**
   * Uvezi izvod iz TXT sadržaja: parsiraj → kreiraj BankStatement(IMPORTED) + linije.
   * Idempotencija: (bankAccount, statementNumber) je unique — ponovni uvoz istog izvoda → 409.
   */
  async importStatement(dto: ImportStatementDto, actor?: AuthUser) {
    validateImportStatement(dto);

    const parsed = this.parser.parse(dto.txtContent);
    if (parsed.length === 0) {
      throw new UnprocessableEntityException(
        "Izvod ne sadrži nijednu parsabilnu stavku (proverite format/kolone).",
      );
    }

    const existing = await this.prisma.bankStatement.findUnique({
      where: {
        bankAccount_statementNumber: {
          bankAccount: dto.bankAccount,
          statementNumber: dto.statementNumber,
        },
      },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException(
        `Izvod ${dto.statementNumber} za račun ${dto.bankAccount} je već uvezen (id ${existing.id}).`,
      );
    }

    return this.prisma.bankStatement.create({
      data: {
        bankAccount: dto.bankAccount,
        statementNumber: dto.statementNumber,
        statementDate: new Date(dto.statementDate),
        importedFileName: dto.fileName ?? null,
        status: "IMPORTED",
        openingBalance:
          dto.openingBalance !== undefined ? new D(dto.openingBalance) : ZERO,
        closingBalance:
          dto.closingBalance !== undefined ? new D(dto.closingBalance) : ZERO,
        currency: dto.currency ?? "RSD",
        createdByUserId: actor?.userId ?? null,
        lines: {
          create: parsed.map((l: ParsedStatementLine) => ({
            lineNo: l.lineNo,
            partnerAccount: l.partnerAccount,
            partnerName: l.partnerName,
            amount: l.amount,
            direction: l.direction,
            referenceNumber: l.referenceNumber,
            documentDate: l.documentDate,
            status: "UNMATCHED",
          })),
        },
      },
      include: { lines: { orderBy: { lineNo: "asc" } } },
    });
  }

  /**
   * Preview: parsiraj TXT bez upisa (dry-run) — za ekran pregleda pre uvoza.
   * Vraća stavke sa iznosom kao string (Decimal u JSON-u = string, BACKEND_RULES §6).
   */
  previewParse(txtContent: string) {
    const parsed = this.parser.parse(txtContent);
    return {
      count: parsed.length,
      lines: parsed.map((l) => ({
        lineNo: l.lineNo,
        partnerAccount: l.partnerAccount,
        partnerName: l.partnerName,
        amount: l.amount.toFixed(2),
        direction: l.direction,
        referenceNumber: l.referenceNumber,
        documentDate: l.documentDate,
      })),
    };
  }

  // ── UPARIVANJE ────────────────────────────────────────────────────────────

  /**
   * Za svaku UNMATCHED liniju: (1) upari komitenta po žiro računu (Customer.bankAccount1/2/3),
   * meki fallback po nazivu; (2) upari otvorenu stavku (LedgerEntry, reconciledAt IS NULL) po
   * (komitent, referenceNumber == documentNumber) → fallback po iznosu. Update matchedCustomerId
   * / matchedLedgerEntryId / status=MATCHED.
   */
  async matchLines(statementId: number) {
    const statement = await this.getStatementOrThrow(statementId);
    if (statement.status === "POSTED") {
      throw new ConflictException(
        `Izvod ${statementId} je već proknjižen — uparivanje nije dozvoljeno.`,
      );
    }

    let matched = 0;
    for (const line of statement.lines) {
      if (line.status === "POSTED") continue;

      const customerId = await this.matchCustomer(
        line.partnerAccount,
        line.partnerName,
      );
      const ledgerEntryId =
        customerId != null
          ? await this.matchOpenItem(customerId, line.referenceNumber, line.amount)
          : null;

      const newStatus = customerId != null ? "MATCHED" : "UNMATCHED";
      if (customerId != null) matched += 1;

      await this.prisma.bankStatementLine.update({
        where: { id: line.id },
        data: {
          matchedCustomerId: customerId,
          matchedLedgerEntryId: ledgerEntryId,
          status: newStatus,
        },
      });
    }

    return this.getStatement(statementId).then((s) => ({
      ...s,
      matchedCount: matched,
    }));
  }

  /**
   * Uparivanje komitenta po žiro računu. Customer nema jednu "žiro" kolonu nego TRI:
   * `bankAccount1`, `bankAccount2`, `bankAccount3` (mapirano na bank_account_1/2/3).
   * Poredimo po ciframa (izbacimo razmake/crte). Ako nema pogotka → meki fallback po nazivu
   * (case-insensitive contains) uz TODO (naziv nije pouzdan ključ).
   */
  private async matchCustomer(
    partnerAccount: string | null,
    partnerName: string | null,
  ): Promise<number | null> {
    if (partnerAccount) {
      const normalized = partnerAccount.replace(/\D/gu, "");
      if (normalized.length > 0) {
        // Prisma nema "normalizovan po ciframa" upit → povučemo kandidate po sirovom
        // prefiksu i uporedimo u aplikaciji. Sirovi zapisi u BigBit-u imaju crte/razmake.
        const candidates = await this.prisma.customer.findMany({
          where: {
            OR: [
              { bankAccount1: { contains: normalized.slice(0, 6) } },
              { bankAccount2: { contains: normalized.slice(0, 6) } },
              { bankAccount3: { contains: normalized.slice(0, 6) } },
            ],
          },
          select: {
            id: true,
            bankAccount1: true,
            bankAccount2: true,
            bankAccount3: true,
          },
          take: 50,
        });
        const hit = candidates.find((c) =>
          [c.bankAccount1, c.bankAccount2, c.bankAccount3].some(
            (a) => a != null && a.replace(/\D/gu, "") === normalized,
          ),
        );
        if (hit) return hit.id;
      }
    }

    // TODO(uparivanje): naziv nije pouzdan ključ (duplikati/skraćenice) — meki fallback,
    // uparuje samo kad je JEDINSTVEN pogodak.
    if (partnerName && partnerName.trim().length >= 3) {
      const byName = await this.prisma.customer.findMany({
        where: { name: { contains: partnerName.trim(), mode: "insensitive" } },
        select: { id: true },
        take: 2,
      });
      if (byName.length === 1) return byName[0].id;
    }

    return null;
  }

  /**
   * Uparivanje otvorene stavke (LedgerEntry): analitika = komitent, reconciledAt IS NULL,
   * nalog proknjižen (journalEntry.status posted/locked). Prvo po documentNumber == PozivNaBroj
   * (uplata nosi broj fakture, doc 21 §A / PLAN §A ReconciliationService), fallback po iznosu.
   */
  private async matchOpenItem(
    customerId: number,
    referenceNumber: string | null,
    amount: Prisma.Decimal,
  ): Promise<number | null> {
    const baseWhere: Prisma.LedgerEntryWhereInput = {
      analyticalCode: customerId,
      reconciledAt: null,
      journalEntry: { is: { status: { in: ["posted", "locked"] } } },
    };

    if (referenceNumber && referenceNumber.trim().length > 0) {
      const byRef = await this.prisma.ledgerEntry.findFirst({
        where: { ...baseWhere, documentNumber: referenceNumber.trim() },
        select: { id: true },
      });
      if (byRef) return byRef.id;
    }

    // Fallback: otvorena stavka sa tačno jednakim iznosom (dug ili pot).
    const byAmount = await this.prisma.ledgerEntry.findFirst({
      where: {
        ...baseWhere,
        OR: [{ debit: amount }, { credit: amount }],
      },
      select: { id: true },
    });
    return byAmount?.id ?? null;
  }

  // ── AUTO-KNJIŽENJE ──────────────────────────────────────────────────────

  /**
   * Auto-knjiženje izvoda (doc 21 §A): jedan JournalEntry sa dvojnim stavkama —
   *   (1) komitentska strana (analitika po matchedCustomerId), i
   *   (2) protivstavka na kontu banke (Σ svih stavki).
   * Priliv (CREDIT smer izvoda) zatvara potraživanje: banka DUGUJE, komitent POTRAŽUJE.
   * Odliv (DEBIT): banka POTRAŽUJE, komitent DUGUJE. Sve pod jednim nalogom, balans ΣDug=ΣPot.
   *
   * Posle knjiženja → hook za uparivanje uplate sa fakturom (ReconciliationService cross-modul,
   * PLAN §A) — ostavljen kao TODO jer taj servis nije dostupan iz ovog modula.
   */
  async postStatement(
    statementId: number,
    dto: PostStatementDto,
    actor?: AuthUser,
  ) {
    validatePostStatement(dto);
    const statement = await this.getStatementOrThrow(statementId);

    if (statement.status === "POSTED") {
      throw new ConflictException(`Izvod ${statementId} je već proknjižen.`);
    }

    const bankAccountCode = await this.resolveBankAccount(
      statement.bankAccount,
      dto.bankAccountCode,
    );

    // Konto komitentske strane (analitika saldakonta). ⏳ Konačan izvor konta kupca/dobavljača
    // = SaldakontoAccount registar po smeru; do potvrde (doc 21 §D t.3) koristimo default 2040
    // (kupci) za priliv i 4350 (dobavljači) za odliv. TODO(saldakonti): izvesti iz registra.
    const RECEIVABLE_ACCOUNT = "2040"; // kupci u zemlji
    const PAYABLE_ACCOUNT = "4350"; // dobavljači u zemlji

    return this.prisma.$transaction(async (tx) => {
      const lines = statement.lines;

      let bankDebitTotal = ZERO; // Σ priliva (banka duguje)
      let bankCreditTotal = ZERO; // Σ odliva (banka potražuje)

      // Draft linije glavne knjige (isti oblik kao posting.service nested create):
      // accountCode je FK-skalar dostupan u nested JournalEntry.lines.create.
      interface LedgerLineDraft {
        accountCode: string;
        analyticalCode: number | null;
        debit: Prisma.Decimal;
        credit: Prisma.Decimal;
        description: string;
        documentNumber: string | null;
      }
      const ledgerLines: LedgerLineDraft[] = [];

      for (const line of lines) {
        const isInflow = line.direction === "CREDIT"; // priliv
        const partnerAccount = isInflow ? RECEIVABLE_ACCOUNT : PAYABLE_ACCOUNT;

        if (isInflow) {
          bankDebitTotal = bankDebitTotal.add(line.amount);
          // Priliv zatvara potraživanje: komitent POTRAŽUJE (credit).
          ledgerLines.push({
            accountCode: partnerAccount,
            analyticalCode: line.matchedCustomerId ?? null,
            debit: ZERO,
            credit: line.amount,
            description:
              `Izvod ${statement.statementNumber} — priliv ${line.partnerName ?? ""}`.trim(),
            documentNumber: line.referenceNumber ?? null,
          });
        } else {
          bankCreditTotal = bankCreditTotal.add(line.amount);
          // Odliv: komitent DUGUJE (debit).
          ledgerLines.push({
            accountCode: partnerAccount,
            analyticalCode: line.matchedCustomerId ?? null,
            debit: line.amount,
            credit: ZERO,
            description:
              `Izvod ${statement.statementNumber} — odliv ${line.partnerName ?? ""}`.trim(),
            documentNumber: line.referenceNumber ?? null,
          });
        }
      }

      // Protivstavka konto banke: DUGUJE za Σ priliva, POTRAŽUJE za Σ odliva.
      ledgerLines.push({
        accountCode: bankAccountCode,
        analyticalCode: null,
        debit: bankDebitTotal,
        credit: bankCreditTotal,
        description: `Izvod ${statement.statementNumber} — promet banke`,
        documentNumber: statement.statementNumber,
      });

      // Balans-kontrola (Decimal egzaktan → tolerancija 0).
      let totalDebit = ZERO;
      let totalCredit = ZERO;
      for (const l of ledgerLines) {
        totalDebit = totalDebit.add(l.debit);
        totalCredit = totalCredit.add(l.credit);
      }
      if (!totalDebit.equals(totalCredit)) {
        throw new UnprocessableEntityException(
          `Nalog ne balansira: ΣDug=${totalDebit.toFixed(4)} ≠ ΣPot=${totalCredit.toFixed(4)}.`,
        );
      }

      const year = statement.statementDate.getFullYear();
      const number = await this.nextJournalNumber(tx, 0, "IZV", year);

      const entry = await tx.journalEntry.create({
        data: {
          number,
          orderTypeCode: "IZV",
          year,
          companyId: 0,
          documentDate: statement.statementDate,
          postingDate: statement.statementDate,
          status: "draft",
          createdByUserId: actor?.userId ?? null,
          lines: { create: ledgerLines },
        },
        include: { lines: true },
      });

      await tx.bankStatement.update({
        where: { id: statementId },
        data: { status: "POSTED" },
      });
      await tx.bankStatementLine.updateMany({
        where: { statementId },
        data: { status: "POSTED" },
      });

      // TODO(reconcile): posle knjiženja pozvati ReconciliationService da upari uplatu sa
      // fakturom (LedgerEntry.reconciledAt/reconciliationGroupId). Servis je u modulu
      // saldakonti (cross-modul) — integrator ga uvezuje; ovde ostavljamo hook.

      return {
        journalEntryId: entry.id,
        journalNumber: entry.number,
        lineCount: entry.lines.length,
        totalDebit: totalDebit.toFixed(2),
        totalCredit: totalCredit.toFixed(2),
      };
    });
  }

  /**
   * Konto banke za protivstavku. Prioritet: eksplicitni override → PaymentAccount.bankCode
   * (naš žiro → konto banke). ⏳ Konačan izvor (doc 21 §D t.3: UplatniRacuni/parametar) čeka Nesu.
   */
  private async resolveBankAccount(
    bankAccount: string,
    override?: string,
  ): Promise<string> {
    if (override && override.trim().length > 0) return override.trim();

    const normalized = bankAccount.replace(/\D/gu, "");
    const pa = await this.prisma.paymentAccount.findFirst({
      where: { accountNumber: bankAccount },
      select: { bankCode: true },
    });
    if (pa?.bankCode && pa.bankCode.trim().length > 0) return pa.bankCode.trim();

    // Fallback: probaj po normalizovanom broju (crte/razmaci).
    if (normalized.length > 0) {
      const all = await this.prisma.paymentAccount.findMany({
        select: { accountNumber: true, bankCode: true },
      });
      const hit = all.find(
        (a) => a.accountNumber.replace(/\D/gu, "") === normalized,
      );
      if (hit?.bankCode && hit.bankCode.trim().length > 0)
        return hit.bankCode.trim();
    }

    throw new UnprocessableEntityException(
      `Konto banke za žiro račun ${bankAccount} nije definisan (PaymentAccount.bankCode prazan) — prosledite bankAccountCode.`,
    );
  }

  // ── PREGLED ───────────────────────────────────────────────────────────────

  async listStatements(params: {
    status?: string;
    bankAccount?: string;
    skip?: number;
    take?: number;
  }) {
    const where: Prisma.BankStatementWhereInput = {};
    if (params.status) where.status = params.status;
    if (params.bankAccount) where.bankAccount = params.bankAccount;

    const take = Math.min(params.take ?? 50, 200);
    const [data, total] = await this.prisma.$transaction([
      this.prisma.bankStatement.findMany({
        where,
        orderBy: { statementDate: "desc" },
        skip: params.skip ?? 0,
        take,
        include: { _count: { select: { lines: true } } },
      }),
      this.prisma.bankStatement.count({ where }),
    ]);

    return { data, meta: { total, skip: params.skip ?? 0, take } };
  }

  async getStatement(id: number) {
    return this.getStatementOrThrow(id);
  }

  private async getStatementOrThrow(id: number) {
    const statement = await this.prisma.bankStatement.findUnique({
      where: { id },
      include: { lines: { orderBy: { lineNo: "asc" } } },
    });
    if (!statement) throw new NotFoundException(`Izvod ${id} ne postoji.`);
    return statement;
  }

  // ── NUMERACIJA NALOGA (banka↔analitika, vrsta "IZV") ──────────────────────

  /** 1 + MAX po (company, vrsta, godina), zero-pad 4; advisory lock protiv trke. */
  private async nextJournalNumber(
    tx: Prisma.TransactionClient,
    companyId: number,
    orderType: string,
    year: number,
  ): Promise<string> {
    const lockKey = `${companyId}:${orderType}:${year}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
    const last = await tx.journalEntry.findFirst({
      where: { companyId, orderTypeCode: orderType, year },
      orderBy: { number: "desc" },
      select: { number: true },
    });
    const next = (last ? parseInt(last.number, 10) : 0) + 1;
    return String(next).padStart(4, "0");
  }
}
