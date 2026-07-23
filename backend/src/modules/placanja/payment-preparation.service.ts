/**
 * PAYMENT PREPARATION SERVICE — priprema plaćanja / virmani (Faza 4 §C).
 * =========================================================================
 * Selektuje DOSPELE obaveze iz otvorenih stavaka GK (izveden pogled nad
 * `ledger_entries`, kao BigBit — NE materijalizovana tabela) i pretvara ih u
 * naloge za plaćanje (`PaymentOrder` / legacy `Virmani`) sa DEDUP-om koji
 * sprečava dvostruko plaćanje iste fakture istom dobavljaču.
 *
 * OTVORENA STAVKA (obaveza):
 *   red gde je `account` u `SaldakontoAccount` sa side="payable" (klasa 4),
 *   `reconciledAt IS NULL` (nezatvorena), nalog proknjižen. Saldo obaveze =
 *   Σ(credit − debit) po (konto, komitent, documentNumber). DOSPELA =
 *   `dueDate ≤ cutoff` (cutoff = danas).
 *
 * STATUS-MAŠINA (doc 21 §B, schema PaymentOrder.status):
 *   CREATED(0) → SIGNED(1) → PAID(2). `isLocked` (Zakljucano) je ortogonalno.
 *
 * POZIV NA BROJ: mod97.util (KBroj97 = 98 − ((broj×100) mod 97)).
 *
 * ⚠️ Čita SaldakontoAccount registar (ne hardkod „klase 4*") — doc PLAN §A.
 */

import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import {
  CreatePaymentOrdersDto,
  CreatePaymentOrderLineInput,
} from "./dto/create-payment-orders.dto";
import { computeReferenceNumber } from "./mod97.util";

const D = Prisma.Decimal;
const ZERO = new D(0);

/** Jedna dospela otvorena obaveza (agregat po konto+komitent+dokument). */
export interface DueLiability {
  accountCode: string;
  supplierId: number | null;
  documentNumber: string | null;
  /** otvoreni saldo obaveze = Σ(credit − debit); pozitivan = dugujemo. */
  openAmount: string; // Decimal kao string (BACKEND_RULES §6 — Decimal u JSON-u = string)
  currency: string;
  /** najranije dospeće po dokumentu (min dueDate). */
  dueDate: Date | null;
  /** dana u kašnjenju u odnosu na cutoff (>0 = dospelo/kasni). */
  daysOverdue: number;
  /** najstariji ledger_entry.id grupe — traceback ka izvornoj stavci. */
  sourceLedgerEntryId: number;
}

@Injectable()
export class PaymentPreparationService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Selektuj dospele obaveze na dan `cutoff` (default danas).
   * Grupiše otvorene potražne stavke sa payable konta po (konto, komitent,
   * dokument), sabira Σ(credit − debit), zadržava grupe sa saldom > 0 čije je
   * najranije dospeće `≤ cutoff`.
   */
  async selectDue(cutoff: Date = new Date()): Promise<DueLiability[]> {
    // 1) payable konta iz registra (NE hardkod klase 4* — doc PLAN §A).
    const payableAccounts = await this.prisma.saldakontoAccount.findMany({
      where: { side: "payable" },
      select: { account: true },
    });
    const accountCodes = payableAccounts.map((a) => a.account);
    if (accountCodes.length === 0) return [];

    // 2) otvorene stavke na tim kontima (reconciledAt IS NULL), proknjižen nalog.
    //    Grupišemo u memoriji po (konto, komitent, dokument) — groupBy ne daje
    //    lako „min(dueDate) + min(id)", pa radimo determinističku agregaciju.
    const rows = await this.prisma.ledgerEntry.findMany({
      where: {
        accountCode: { in: accountCodes },
        reconciledAt: null,
        journalEntry: { status: { in: ["posted", "locked"] } },
      },
      select: {
        id: true,
        accountCode: true,
        analyticalCode: true,
        documentNumber: true,
        debit: true,
        credit: true,
        dueDate: true,
        currency: true,
      },
      orderBy: { id: "asc" },
    });

    interface Acc {
      accountCode: string;
      supplierId: number | null;
      documentNumber: string | null;
      balance: Prisma.Decimal;
      currency: string;
      dueDate: Date | null;
      firstId: number;
    }
    const groups = new Map<string, Acc>();
    for (const r of rows) {
      const key = `${r.accountCode}|${r.analyticalCode ?? ""}|${r.documentNumber ?? ""}`;
      const delta = r.credit.sub(r.debit); // payable saldo = Σ(credit − debit)
      const cur = groups.get(key);
      if (cur) {
        cur.balance = cur.balance.add(delta);
        if (r.dueDate && (!cur.dueDate || r.dueDate < cur.dueDate)) {
          cur.dueDate = r.dueDate;
        }
      } else {
        groups.set(key, {
          accountCode: r.accountCode,
          supplierId: r.analyticalCode ?? null,
          documentNumber: r.documentNumber ?? null,
          balance: delta,
          currency: r.currency ?? "RSD",
          dueDate: r.dueDate ?? null,
          firstId: r.id,
        });
      }
    }

    // 3) zadrži samo grupe sa pozitivnim saldom obaveze i dospećem ≤ cutoff.
    const cutMs = cutoff.getTime();
    const result: DueLiability[] = [];
    for (const g of groups.values()) {
      if (g.balance.lessThanOrEqualTo(ZERO)) continue; // nema obaveze
      // Bez dueDate → tretiramo kao dospelo (BigBit: prazna valuta = odmah).
      const dueMs = g.dueDate ? g.dueDate.getTime() : 0;
      if (dueMs > cutMs) continue; // nije dospelo
      const daysOverdue = g.dueDate
        ? Math.floor((cutMs - dueMs) / 86_400_000)
        : 0;
      result.push({
        accountCode: g.accountCode,
        supplierId: g.supplierId,
        documentNumber: g.documentNumber,
        openAmount: g.balance.toFixed(4),
        currency: g.currency,
        dueDate: g.dueDate,
        daysOverdue,
        sourceLedgerEntryId: g.firstId,
      });
    }
    // najduže kašnjenje prvo (naplata/plaćanje prioritet).
    result.sort((a, b) => b.daysOverdue - a.daysOverdue);
    return result;
  }

  /**
   * Kreiraj naloge za plaćanje iz selekcije. Po stavci jedan `PaymentOrder`.
   * DEDUP: (referenceNumberCredit, supplierId) je @@unique u schemi
   * (`uq_payment_orders_dedup`) — hvatamo P2002 kao ConflictException da bi
   * pokušaj dvostrukog plaćanja iste fakture bio odbijen, ne 500.
   *
   * @returns kreirani nalozi (već postojeći duplikat baca ConflictException).
   */
  async createPaymentOrders(
    dto: CreatePaymentOrdersDto,
    actorUserId?: number,
  ): Promise<
    Array<{
      id: number;
      orderNumber: string;
      supplierId: number;
      amount: string;
      referenceNumberCredit: string | null;
      status: string;
    }>
  > {
    const created: Array<{
      id: number;
      orderNumber: string;
      supplierId: number;
      amount: string;
      referenceNumberCredit: string | null;
      status: string;
    }> = [];

    const debitModel = dto.referenceModelDebit ?? "99";

    // Ceo batch je ATOMIČAN (review VISOK): ako bilo koji nalog padne (npr. dedup P2002),
    // cela transakcija se rollback-uje — nema parcijalno kreiranih naloga koji bi pri
    // retry-u obarali na već-postojeće A/B. Sve-ili-ništa.
    await this.prisma.$transaction(async (tx) => {
      for (let i = 0; i < dto.lines.length; i++) {
        const line = dto.lines[i];
        const referenceNumberCredit = this.buildCreditReference(line);
        const referenceNumberDebit = line.documentNumber
          ? computeReferenceNumber(debitModel, line.documentNumber)
          : null;

        const orderNumber =
          dto.seriesNumber && dto.lines.length === 1
            ? dto.seriesNumber
            : `${dto.seriesNumber ?? "AUTO"}-${i + 1}`;

        // Dedup po IZVORNOJ otvorenoj stavci (review VISOK): @@unique(referenceNumberCredit,
        // supplierId) ne hvata dvostruko plaćanje kad je PNB prazan (PG tretira NULL kao
        // različit). Prava zaštita — ista otvorena stavka (sourceLedgerEntryId) sme dati
        // najviše JEDAN aktivan nalog. Radi i bez PNB-a.
        if (line.sourceLedgerEntryId != null) {
          const dup = await tx.paymentOrder.findFirst({
            where: { sourceLedgerEntryId: line.sourceLedgerEntryId },
            select: { id: true, orderNumber: true },
          });
          if (dup) {
            throw new ConflictException(
              `Otvorena stavka je već u nalogu ${dup.orderNumber} — dvostruko plaćanje odbijeno.`,
            );
          }
        }

        try {
          const order = await tx.paymentOrder.create({
          data: {
            orderNumber,
            supplierId: line.supplierId,
            supplierAccount: line.supplierAccount ?? null,
            amount: new D(line.amount),
            currency: line.currency ?? "RSD",
            referenceNumberDebit,
            referenceNumberCredit,
            purpose: line.purpose ?? "UPLATA ZA ROBU",
            dueDate: line.dueDate ? new Date(line.dueDate) : null,
            status: "CREATED",
            isLocked: false,
            sourceLedgerEntryId: line.sourceLedgerEntryId ?? null,
            createdByUserId: actorUserId ?? null,
            updatedByUserId: actorUserId ?? null,
          },
          select: {
            id: true,
            orderNumber: true,
            supplierId: true,
            amount: true,
            referenceNumberCredit: true,
            status: true,
          },
        });
        created.push({
          id: order.id,
          orderNumber: order.orderNumber,
          supplierId: order.supplierId,
          amount: order.amount.toFixed(4),
          referenceNumberCredit: order.referenceNumberCredit,
          status: order.status,
        });
      } catch (e) {
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === "P2002"
        ) {
          // @@unique(referenceNumberCredit, supplierId) → nalog za istu fakturu
          // i istog dobavljača već postoji (sprečeno dvostruko plaćanje, doc 21 §C).
          throw new ConflictException(
            `Nalog za plaćanje za dobavljača ${line.supplierId} i poziv na broj ` +
              `${referenceNumberCredit ?? "(prazan)"} već postoji — dvostruko plaćanje odbijeno.`,
          );
        }
          throw e;
        }
      }
    });
    return created;
  }

  /** CREATED → SIGNED (potpisan). */
  async markSigned(orderId: number, actorUserId?: number): Promise<void> {
    await this.transition(orderId, "CREATED", "SIGNED", actorUserId);
  }

  /** SIGNED → PAID (plaćen). */
  async markPaid(orderId: number, actorUserId?: number): Promise<void> {
    await this.transition(orderId, "SIGNED", "PAID", actorUserId);
  }

  /**
   * Masovni potpis (BigBit PotpisiVirmane je grupna akcija) — CREATED→SIGNED za više naloga.
   * Skip-ne-abort po nalogu: nalog koji nije u CREATED / zaključan se preskače uz razlog,
   * ostali prolaze. Vraća broj potpisanih + listu preskočenih.
   */
  async markSignedBatch(
    orderIds: number[],
    actorUserId?: number,
  ): Promise<{ signed: number; skipped: { id: number; reason: string }[] }> {
    const skipped: { id: number; reason: string }[] = [];
    let signed = 0;
    for (const id of orderIds) {
      try {
        await this.transition(id, "CREATED", "SIGNED", actorUserId);
        signed += 1;
      } catch (e) {
        skipped.push({
          id,
          reason: e instanceof Error ? e.message : "nepoznata greška",
        });
      }
    }
    return { signed, skipped };
  }

  /**
   * Pregled naloga za plaćanje (BigBit paritet — bez ovoga refresh gubi naloge).
   * Filteri: status, supplierId, exported (null/not-null), period po createdAt. Paginacija.
   * Envelope { data, meta } (BACKEND_RULES §6). Decimal → string u JSON-u.
   */
  async listOrders(params: {
    status?: string;
    supplierId?: number;
    exported?: boolean;
    dateFrom?: string;
    dateTo?: string;
    skip?: number;
    take?: number;
  }) {
    const where: Prisma.PaymentOrderWhereInput = {};
    if (params.status) where.status = params.status;
    if (params.supplierId != null) where.supplierId = params.supplierId;
    if (params.exported === true) where.exportedAt = { not: null };
    if (params.exported === false) where.exportedAt = null;
    if (params.dateFrom || params.dateTo) {
      where.createdAt = {};
      if (params.dateFrom) where.createdAt.gte = new Date(params.dateFrom);
      if (params.dateTo) where.createdAt.lte = new Date(params.dateTo);
    }

    const take = Math.min(params.take ?? 50, 200);
    const skip = params.skip ?? 0;
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.paymentOrder.findMany({
        where,
        orderBy: [{ status: "asc" }, { createdAt: "desc" }],
        skip,
        take,
      }),
      this.prisma.paymentOrder.count({ where }),
    ]);

    return {
      data: rows.map((o) => ({
        id: o.id,
        orderNumber: o.orderNumber,
        supplierId: o.supplierId,
        supplierAccount: o.supplierAccount,
        amount: o.amount.toFixed(2),
        currency: o.currency,
        referenceNumberCredit: o.referenceNumberCredit,
        purpose: o.purpose,
        dueDate: o.dueDate,
        status: o.status,
        isLocked: o.isLocked,
        exportedAt: o.exportedAt,
      })),
      meta: { total, skip, take },
    };
  }

  // ───────────────────────────────────────────────────────────────────────────

  /** Poziv na broj u korist (primalac) — PNBOdobBroj + kontrolni sufiks. */
  private buildCreditReference(
    line: CreatePaymentOrderLineInput,
  ): string | null {
    const model = line.referenceModelCredit ?? "97";
    const base = line.referenceBaseCredit ?? line.documentNumber ?? "";
    if (base.trim() === "") return null;
    return computeReferenceNumber(model, base);
  }

  private async transition(
    orderId: number,
    from: string,
    to: string,
    actorUserId?: number,
  ): Promise<void> {
    const order = await this.prisma.paymentOrder.findUnique({
      where: { id: orderId },
      select: { id: true, status: true, isLocked: true },
    });
    if (!order) {
      throw new NotFoundException(`Nalog za plaćanje ${orderId} ne postoji.`);
    }
    if (order.isLocked) {
      throw new ConflictException(
        `Nalog ${orderId} je zaključan (Zakljucano) — promena statusa nije dozvoljena.`,
      );
    }
    if (order.status !== from) {
      throw new ConflictException(
        `Nalog ${orderId} je u statusu ${order.status}; očekivano ${from} za prelaz u ${to}.`,
      );
    }
    // Compare-and-swap: prelaz uspeva SAMO ako je status i dalje `from` i nalog nije
    // zaključan (review SREDNJI — sprečava izgubljeni update / prelaz iz pogrešnog stanja
    // pri konkurenciji, jer findUnique→update nije atomičan).
    const swapped = await this.prisma.paymentOrder.updateMany({
      where: { id: orderId, status: from, isLocked: false },
      data: { status: to, updatedByUserId: actorUserId ?? null },
    });
    if (swapped.count !== 1) {
      throw new ConflictException(
        `Nalog ${orderId} je u međuvremenu promenjen — prelaz ${from}→${to} nije izvršen. Osveži i pokušaj ponovo.`,
      );
    }
  }
}
