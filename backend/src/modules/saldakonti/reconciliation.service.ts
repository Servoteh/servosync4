/**
 * RECONCILIATION SERVICE — uparivanje (zatvaranje) otvorenih stavki (Faza 4 §A).
 * =========================================================================
 * Zatvaranje = oznaka na samim ledger_entries redovima (reconciled_at +
 * reconciliation_group_id), NE poseban entitet (PLAN_FAZA_4 §Centralna ideja).
 *
 *   autoReconcile(entryIds) — uzme date stavke, proveri da su sve iz istog
 *     (kontrolni konto, komitent) skupa i da je Σ(debit) == Σ(credit) unutar
 *     tolerancije 0.01; ako jeste → napravi ReconciliationGroup(kind=MANUAL/AUTO)
 *     i postavi reconciled_at + reconciliation_group_id na sve. Ostatak (kursna
 *     razlika ≤ toleranciji) se NE zatvara automatski ovde — vraća se kao
 *     `residual` da ga posting (Faza 2) proknjiži kao kursnu razliku/otpis.
 *   manualReconcile(entryIds, userId) — isto, ali role-gated (bez balans-uslova
 *     osim guard-a isti konto+komitent); za ručno zatvaranje sa ostatkom.
 *   unreconcile(groupId) — razveži grupu (role-gated): obriši grupu, očisti
 *     reconciled_at + reconciliation_group_id na svim njenim redovima.
 */

import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";

const D = Prisma.Decimal;
/** Tolerancija zatvaranja (kursna razlika/zaokruženje) — PLAN_FAZA_4 §A t.3. */
const TOLERANCE = new D("0.01");

export interface ReconcileResult {
  groupId: number;
  entryIds: number[];
  totalDebit: Prisma.Decimal;
  totalCredit: Prisma.Decimal;
  residual: Prisma.Decimal; // Σdebit − Σcredit (kursna razlika/otpis; ≤ tolerancija za auto)
  balanced: boolean; // |residual| == 0
}

interface EntryRow {
  id: number;
  accountCode: string;
  analyticalCode: number | null;
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
  reconciledAt: Date | null;
  controlAccount: string | null; // iz saldakonto registra (NULL = konto van registra)
}

@Injectable()
export class ReconciliationService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Auto-uparivanje: zahteva balans u granici tolerancije. Guard: sve stavke
   * isti (kontrolni konto, komitent), sve otvorene, sve u saldakonto registru.
   */
  async autoReconcile(
    entryIds: number[],
    userId?: number,
    note?: string,
  ): Promise<ReconcileResult> {
    return this.prisma.$transaction(async (tx) => {
      const entries = await this.loadEntries(tx, entryIds);
      this.assertSamePartnerScope(entries);

      const { totalDebit, totalCredit, residual } = this.sum(entries);
      if (residual.abs().greaterThan(TOLERANCE)) {
        throw new UnprocessableEntityException(
          `Stavke ne balansiraju u granici tolerancije: ostatak=${residual.toFixed(2)} > ${TOLERANCE.toFixed(2)}. ` +
            `Za ručno zatvaranje sa ostatkom koristi manualReconcile.`,
        );
      }

      const groupId = await this.closeGroup(
        tx,
        entries,
        "AUTO_STATEMENT",
        userId,
        note,
      );
      return {
        groupId,
        entryIds: entries.map((e) => e.id),
        totalDebit,
        totalCredit,
        residual,
        balanced: residual.isZero(),
      };
    });
  }

  /**
   * Ručno uparivanje (role-gated na kontroleru): zatvara date stavke bez
   * balans-uslova; residual (ostatak) se samo prijavljuje pozivaocu. Guard isti
   * konto+komitent i dalje važi (sprečava krivo uparivanje tuđih stavki).
   */
  async manualReconcile(
    entryIds: number[],
    userId?: number,
    note?: string,
  ): Promise<ReconcileResult> {
    return this.prisma.$transaction(async (tx) => {
      const entries = await this.loadEntries(tx, entryIds);
      this.assertSamePartnerScope(entries);

      const { totalDebit, totalCredit, residual } = this.sum(entries);
      const groupId = await this.closeGroup(
        tx,
        entries,
        "MANUAL",
        userId,
        note,
      );
      return {
        groupId,
        entryIds: entries.map((e) => e.id),
        totalDebit,
        totalCredit,
        residual,
        balanced: residual.isZero(),
      };
    });
  }

  /**
   * Razvezivanje grupe (role-gated): obriši ReconciliationGroup i očisti
   * reconciled_at + reconciliation_group_id na svim njenim redovima (ponovo
   * otvorene stavke). Grupa mora postojati.
   */
  async unreconcile(groupId: number): Promise<{ groupId: number; reopened: number }> {
    return this.prisma.$transaction(async (tx) => {
      const group = await tx.reconciliationGroup.findUnique({
        where: { id: groupId },
      });
      if (!group) {
        throw new NotFoundException(`Grupa uparivanja ${groupId} ne postoji.`);
      }
      const reopened = await tx.ledgerEntry.updateMany({
        where: { reconciliationGroupId: groupId },
        data: { reconciledAt: null, reconciliationGroupId: null },
      });
      await tx.reconciliationGroup.delete({ where: { id: groupId } });
      return { groupId, reopened: reopened.count };
    });
  }

  /**
   * Balans-helper: |Σdebit − Σcredit| == 0. Koristi ga i kompenzacija (§C)
   * pre knjiženja.
   */
  validateBalanced(entries: Array<{ debit: Prisma.Decimal; credit: Prisma.Decimal }>): {
    balanced: boolean;
    residual: Prisma.Decimal;
  } {
    let totalDebit = new D(0);
    let totalCredit = new D(0);
    for (const e of entries) {
      totalDebit = totalDebit.add(e.debit);
      totalCredit = totalCredit.add(e.credit);
    }
    const residual = totalDebit.sub(totalCredit);
    return { balanced: residual.isZero(), residual };
  }

  // ── privatni helperi ──────────────────────────────────────────────────────

  private async loadEntries(
    tx: Prisma.TransactionClient,
    entryIds: number[],
  ): Promise<EntryRow[]> {
    const rows = await tx.$queryRaw<
      Array<{
        id: number;
        account_code: string;
        analytical_code: number | null;
        debit: Prisma.Decimal;
        credit: Prisma.Decimal;
        reconciled_at: Date | null;
        control_account: string | null;
        status: string;
      }>
    >(
      Prisma.sql`
        SELECT le.id, le.account_code, le.analytical_code, le.debit, le.credit,
               le.reconciled_at, sa.control_account, je.status
        FROM ledger_entries le
        JOIN journal_entries je ON je.id = le.journal_entry_id
        LEFT JOIN saldakonto_accounts sa ON sa.account = le.account_code
        WHERE le.id IN (${Prisma.join(entryIds)})
      `,
    );

    if (rows.length !== entryIds.length) {
      const found = new Set(rows.map((r) => r.id));
      const missing = entryIds.filter((id) => !found.has(id));
      throw new NotFoundException(
        `Stavke glavne knjige ne postoje: ${missing.join(", ")}.`,
      );
    }
    for (const r of rows) {
      if (r.control_account == null) {
        throw new UnprocessableEntityException(
          `Stavka ${r.id}: konto ${r.account_code} nije u saldakonto registru.`,
        );
      }
      if (r.status !== "posted") {
        throw new UnprocessableEntityException(
          `Stavka ${r.id}: nalog nije proknjižen (status ${r.status}).`,
        );
      }
      if (r.reconciled_at != null) {
        throw new UnprocessableEntityException(
          `Stavka ${r.id} je već zatvorena (uparena).`,
        );
      }
    }
    return rows.map((r) => ({
      id: r.id,
      accountCode: r.account_code,
      analyticalCode: r.analytical_code,
      debit: new D(r.debit),
      credit: new D(r.credit),
      reconciledAt: r.reconciled_at,
      controlAccount: r.control_account,
    }));
  }

  /** Guard: sve stavke isti (kontrolni konto, komitent). */
  private assertSamePartnerScope(entries: EntryRow[]): void {
    const first = entries[0];
    for (const e of entries) {
      if (e.controlAccount !== first.controlAccount) {
        throw new UnprocessableEntityException(
          "Sve stavke moraju pripadati istom kontrolnom kontu.",
        );
      }
      if (e.analyticalCode !== first.analyticalCode) {
        throw new UnprocessableEntityException(
          "Sve stavke moraju pripadati istom komitentu.",
        );
      }
    }
  }

  private sum(entries: EntryRow[]): {
    totalDebit: Prisma.Decimal;
    totalCredit: Prisma.Decimal;
    residual: Prisma.Decimal;
  } {
    let totalDebit = new D(0);
    let totalCredit = new D(0);
    for (const e of entries) {
      totalDebit = totalDebit.add(e.debit);
      totalCredit = totalCredit.add(e.credit);
    }
    return { totalDebit, totalCredit, residual: totalDebit.sub(totalCredit) };
  }

  private async closeGroup(
    tx: Prisma.TransactionClient,
    entries: EntryRow[],
    kind: "AUTO_STATEMENT" | "MANUAL" | "COMPENSATION",
    userId?: number,
    note?: string,
  ): Promise<number> {
    const group = await tx.reconciliationGroup.create({
      data: { kind, createdByUserId: userId ?? null, note: note ?? null },
    });
    const now = new Date();
    await tx.ledgerEntry.updateMany({
      where: { id: { in: entries.map((e) => e.id) } },
      data: { reconciledAt: now, reconciliationGroupId: group.id },
    });
    return group.id;
  }
}
