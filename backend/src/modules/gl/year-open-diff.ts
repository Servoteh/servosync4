import { Prisma } from "@prisma/client";

/**
 * IZVEŠTAJ RAZLIKE OSNOVE ZA PRENOS GODINE (`dryRun`).
 * =========================================================================
 * Po kontu daje STARU (kumulativnu) i NOVU (prozor po godini) osnovu i razliku između njih.
 * Ništa ne upisuje.
 *
 * ZAŠTO POSTOJI: ispravka prozora (v. `YearOpenService.accountBalances`) menja početno
 * stanje na svakom prenosu POSLE prvog. Odluka vlasnika (04.08.2026) je „popravi kod +
 * izveštaj, BEZ automatskog backfill-a" — ovo je taj izveštaj: knjigovođa vidi TAČNO koji
 * konto je bio naduvan i za koliko, pa sam odlučuje šta se ispravlja u knjigama.
 *
 * ZAŠTO JE U SVOM FAJLU: `year-open.service.ts` je sa ovim kodom prešao 600 linija i
 * oborio `audit:check` (`size` 87 → 88). Prag nije dignut — izdvojeno je, jer dijagnostika
 * i transakcija prenoса i nisu ista odgovornost: prenos se menja retko i opasno, izveštaj
 * se menja kad knjigovođa traži drugu kolonu. (Isti obrazac kao
 * `saldakonti/compensation-entry-guard.ts`, izdvojen istog dana iz istog razloga.)
 */

const D = Prisma.Decimal;
const ZERO = new D(0);

/** Saldo po kontu — oblik koji obe osnove vraćaju. */
export interface YearOpenBalance {
  accountCode: string;
  accountClass: number;
  /** Saldo = ΣDuguje − ΣPotražuje (+ = dugovni, − = potražni). */
  net: Prisma.Decimal;
}

/** Jedan red izveštaja razlike — koliko je stara osnova pogrešno brojala. */
export interface YearOpenDiffRow {
  accountCode: string;
  accountClass: number;
  /** Stara osnova: kumulativ od početka knjiga do 31.12. `fromYear` (dvaput brojala PS). */
  cumulative: string;
  /** Nova osnova: samo `je.year = fromYear` (PS te godine + promet te godine). */
  windowed: string;
  /** `cumulative − windowed` — koliko bi početno stanje bilo naduvano po starom. */
  difference: string;
}

/**
 * STARA osnova — kumulativ od početka knjiga do `cutoff`. Postoji ISKLJUČIVO za ovaj
 * izveštaj; prenos je NE koristi (v. `YearOpenService.accountBalances`). Ne brisati je bez
 * brisanja izveštaja — inače se gubi jedini način da se vidi šta je zatečeno naduvano.
 */
export async function loadCumulativeBalances(
  tx: Prisma.TransactionClient,
  companyId: number,
  cutoff: Date,
): Promise<YearOpenBalance[]> {
  const rows = await tx.$queryRaw<
    Array<{
      accountCode: string;
      accountClass: number;
      debit: Prisma.Decimal;
      credit: Prisma.Decimal;
    }>
  >(Prisma.sql`
    SELECT le.account_code AS "accountCode",
           a.account_class AS "accountClass",
           COALESCE(SUM(le.debit), 0) AS debit,
           COALESCE(SUM(le.credit), 0) AS credit
    FROM ledger_entries le
    JOIN journal_entries je ON je.id = le.journal_entry_id
    JOIN accounts a ON a.code = le.account_code
    WHERE je.status IN ('POSTED', 'LOCKED')
      AND je.company_id = ${companyId}
      AND je.document_date < ${cutoff}
    GROUP BY le.account_code, a.account_class
    HAVING COALESCE(SUM(le.debit), 0) <> COALESCE(SUM(le.credit), 0)
    ORDER BY le.account_code ASC
  `);
  return rows.map((r) => ({
    accountCode: r.accountCode,
    accountClass: Number(r.accountClass),
    net: new D(r.debit).minus(new D(r.credit)),
  }));
}

/**
 * Sastavi izveštaj razlike iz dve već izračunate osnove — čista funkcija, bez baze, pa je
 * testabilna bez ijednog mock-a.
 *
 * Vraćaju se SAMO konta gde se osnove razlikuju: na prvom prenosu (nema starijih godina)
 * lista je prazna, i to je samo po sebi dokaz da je prvi prenos bio ispravan i po starom
 * kodu.
 */
export function buildYearOpenDiff(
  windowed: readonly YearOpenBalance[],
  cumulative: readonly YearOpenBalance[],
): YearOpenDiffRow[] {
  const byCode = new Map(windowed.map((b) => [b.accountCode, b]));
  const rows: YearOpenDiffRow[] = [];

  for (const c of cumulative) {
    const wNet = byCode.get(c.accountCode)?.net ?? ZERO;
    const diff = c.net.minus(wNet);
    if (diff.isZero()) continue;
    rows.push({
      accountCode: c.accountCode,
      accountClass: c.accountClass,
      cumulative: c.net.toFixed(4),
      windowed: wNet.toFixed(4),
      difference: diff.toFixed(4),
    });
  }

  // Konto koji postoji SAMO u prozoru (promet te godine, a kumulativ mu je nula) — ne može
  // da nastane u praksi, ali se ne preskače tiho: izveštaj mora da bude potpun.
  const cumulativeCodes = new Set(cumulative.map((c) => c.accountCode));
  for (const w of windowed) {
    if (cumulativeCodes.has(w.accountCode)) continue;
    rows.push({
      accountCode: w.accountCode,
      accountClass: w.accountClass,
      cumulative: ZERO.toFixed(4),
      windowed: w.net.toFixed(4),
      difference: ZERO.minus(w.net).toFixed(4),
    });
  }

  rows.sort((a, b) => a.accountCode.localeCompare(b.accountCode));
  return rows;
}
