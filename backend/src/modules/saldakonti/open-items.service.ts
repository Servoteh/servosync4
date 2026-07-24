/**
 * OPEN ITEMS SERVICE — otvorene stavke saldakonta (Faza 4 §A, jezgro).
 * =========================================================================
 * "Otvorene stavke se NE materijalizuju" (PLAN_FAZA_4 §Centralna ideja) —
 * izveden pogled nad `ledger_entries`:
 *   otvorena stavka = red gde je konto u SaldakontoAccount registru,
 *   pripadajući JournalEntry je proknjižen (status = 'posted'),
 *   reconciled_at IS NULL.
 *
 * Grupisanje po (account_code, analytical_code, document_number); saldo =
 * Σ(debit) − Σ(credit); HAVING saldo ≠ 0. dueDate = MIN(due_date) po grupi
 * (najranije dospeće dokumenta). Aging bucket po (danas − dueDate):
 *   0-30 / 31-60 / 61-90 / 90+.
 *
 * Raw SQL (prisma.$queryRaw) jer Prisma groupBy ne podržava HAVING nad
 * izračunatim izrazom niti join na registar; Decimal se vraća egzaktno.
 */

import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";

export interface OpenItem {
  accountCode: string;
  analyticalCode: number | null; // komitent (null = sintetika bez analitike)
  documentNumber: string | null;
  balance: Prisma.Decimal; // Σ debit − Σ credit (dugovni saldo pozitivan)
  totalDebit: Prisma.Decimal;
  totalCredit: Prisma.Decimal;
  dueDate: Date | null; // najranije dospeće u grupi
  daysOverdue: number | null; // asOf − dueDate (u danima; null ako nema dueDate)
  currency: string | null;
  side: string; // receivable | payable (iz registra)
  // Svi ledger_entries.id koji čine ovaj (grupisani) red — potrebno za
  // uparivanje (reconcile) i kompenzaciju, koje rade nad pojedinačnim
  // stavkama. Izveden pogled grupiše po dokumentu; ovde izlažemo članove grupe.
  ledgerEntryIds: number[];
}

/** Aging red po komitentu — saldo raspoređen u bucket-e po dospelosti. */
export interface AgingByPartnerRow {
  analyticalCode: number | null;
  bucket0_30: Prisma.Decimal;
  bucket31_60: Prisma.Decimal;
  bucket61_90: Prisma.Decimal;
  bucket90plus: Prisma.Decimal;
  total: Prisma.Decimal;
}

interface OpenItemRawRow {
  account_code: string;
  analytical_code: number | null;
  document_number: string | null;
  total_debit: Prisma.Decimal | null;
  total_credit: Prisma.Decimal | null;
  balance: Prisma.Decimal | null;
  due_date: Date | null;
  currency: string | null;
  side: string;
  ledger_entry_ids: number[] | null; // array_agg(le.id) — članovi grupe (Int[] → number[])
}

interface AgingRawRow {
  analytical_code: number | null;
  bucket_0_30: Prisma.Decimal | null;
  bucket_31_60: Prisma.Decimal | null;
  bucket_61_90: Prisma.Decimal | null;
  bucket_90_plus: Prisma.Decimal | null;
  total: Prisma.Decimal | null;
}

@Injectable()
export class OpenItemsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Lista otvorenih stavki (izveden pogled nad ledger_entries). Filteri su
   * opcioni; bez filtera vraća sve otvorene stavke svih saldakonto konta.
   * @param accountCode — tačan konto (opciono)
   * @param partnerId   — analitička = komitent (opciono)
   * @param asOf        — presek na dan za daysOverdue (default danas)
   */
  async listOpenItems(
    accountCode?: string,
    partnerId?: number,
    asOf?: Date,
  ): Promise<OpenItem[]> {
    const cutoff = asOf ?? new Date();
    const accountFilter = accountCode
      ? Prisma.sql`AND le.account_code = ${accountCode}`
      : Prisma.empty;
    const partnerFilter =
      partnerId != null
        ? Prisma.sql`AND le.analytical_code = ${partnerId}`
        : Prisma.empty;

    const rows = await this.prisma.$queryRaw<OpenItemRawRow[]>(
      Prisma.sql`
        SELECT
          le.account_code AS account_code,
          le.analytical_code AS analytical_code,
          le.document_number AS document_number,
          COALESCE(SUM(le.debit), 0) AS total_debit,
          COALESCE(SUM(le.credit), 0) AS total_credit,
          COALESCE(SUM(le.debit) - SUM(le.credit), 0) AS balance,
          MIN(le.due_date) AS due_date,
          MAX(le.currency) AS currency,
          array_agg(le.id ORDER BY le.id) AS ledger_entry_ids,
          sa.side AS side
        FROM ledger_entries le
        JOIN journal_entries je ON je.id = le.journal_entry_id
        JOIN saldakonto_accounts sa ON sa.account = le.account_code
        WHERE je.status = 'posted'
          -- Presek NA DAN (review 1E): stavka je „otvorena na dan" ako je proknjižena
          -- do preseka I nije bila uparena do preseka (uparivanje POSLE preseka je
          -- nevidljivo za istorijski IOS — godišnje usaglašavanje 31.12).
          AND je.posting_date <= ${cutoff}
          AND (le.reconciled_at IS NULL OR le.reconciled_at > ${cutoff})
          AND sa.tracks_open_items = TRUE
          ${accountFilter}
          ${partnerFilter}
        GROUP BY le.account_code, le.analytical_code, le.document_number, sa.side
        HAVING COALESCE(SUM(le.debit) - SUM(le.credit), 0) <> 0
        ORDER BY le.account_code, le.analytical_code, le.document_number
      `,
    );

    return rows.map((r) => this.mapRow(r, cutoff));
  }

  /**
   * Aging po komitentu za dati konto (default svi saldakonto konti). Za svaku
   * analitiku (komitent) raspoređuje saldo dokumenta u bucket po dospelosti
   * (asOf − dueDate): 0-30 / 31-60 / 61-90 / 90+. Bez dueDate → bucket 0-30
   * (nedospelo / nepoznato dospeće se tretira kao tekuće).
   */
  async agingByPartner(
    accountCode?: string,
    asOf?: Date,
  ): Promise<AgingByPartnerRow[]> {
    const cutoff = asOf ?? new Date();
    const accountFilter = accountCode
      ? Prisma.sql`AND le.account_code = ${accountCode}`
      : Prisma.empty;

    // Dvostepeno: prvo saldo + daysOverdue po (konto, komitent, dokument);
    // zatim raspoređivanje u bucket-e i Σ po komitentu. `cutoff` ulazi kao
    // parametar da je aging deterministički za dati presek.
    const rows = await this.prisma.$queryRaw<AgingRawRow[]>(
      Prisma.sql`
        WITH doc_saldo AS (
          SELECT
            le.analytical_code AS analytical_code,
            COALESCE(SUM(le.debit) - SUM(le.credit), 0) AS balance,
            (${cutoff}::date - MIN(le.due_date)::date) AS days_overdue
          FROM ledger_entries le
          JOIN journal_entries je ON je.id = le.journal_entry_id
          JOIN saldakonto_accounts sa ON sa.account = le.account_code
          WHERE je.status = 'posted'
            AND le.reconciled_at IS NULL
            AND sa.tracks_open_items = TRUE
            ${accountFilter}
          GROUP BY le.account_code, le.analytical_code, le.document_number
          HAVING COALESCE(SUM(le.debit) - SUM(le.credit), 0) <> 0
        )
        SELECT
          analytical_code,
          COALESCE(SUM(CASE WHEN days_overdue IS NULL OR days_overdue <= 30 THEN balance ELSE 0 END), 0) AS bucket_0_30,
          COALESCE(SUM(CASE WHEN days_overdue BETWEEN 31 AND 60 THEN balance ELSE 0 END), 0) AS bucket_31_60,
          COALESCE(SUM(CASE WHEN days_overdue BETWEEN 61 AND 90 THEN balance ELSE 0 END), 0) AS bucket_61_90,
          COALESCE(SUM(CASE WHEN days_overdue > 90 THEN balance ELSE 0 END), 0) AS bucket_90_plus,
          COALESCE(SUM(balance), 0) AS total
        FROM doc_saldo
        GROUP BY analytical_code
        ORDER BY analytical_code
      `,
    );

    return rows.map((r) => ({
      analyticalCode: r.analytical_code,
      bucket0_30: new Prisma.Decimal(r.bucket_0_30 ?? 0),
      bucket31_60: new Prisma.Decimal(r.bucket_31_60 ?? 0),
      bucket61_90: new Prisma.Decimal(r.bucket_61_90 ?? 0),
      bucket90plus: new Prisma.Decimal(r.bucket_90_plus ?? 0),
      total: new Prisma.Decimal(r.total ?? 0),
    }));
  }

  private mapRow(r: OpenItemRawRow, cutoff: Date): OpenItem {
    const dueDate = r.due_date ?? null;
    const daysOverdue =
      dueDate != null
        ? Math.floor(
            (cutoff.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24),
          )
        : null;
    return {
      accountCode: r.account_code,
      analyticalCode: r.analytical_code,
      documentNumber: r.document_number,
      balance: new Prisma.Decimal(r.balance ?? 0),
      totalDebit: new Prisma.Decimal(r.total_debit ?? 0),
      totalCredit: new Prisma.Decimal(r.total_credit ?? 0),
      dueDate,
      daysOverdue,
      currency: r.currency,
      side: r.side,
      ledgerEntryIds: r.ledger_entry_ids ?? [],
    };
  }
}
