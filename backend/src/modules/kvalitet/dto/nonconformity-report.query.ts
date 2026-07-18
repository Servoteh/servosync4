/**
 * Query parametri za listu izveštaja o neusaglašenosti i za mini-agregat.
 * Sve stiže kao string iz URL-a (server-side filtriranje) — parsiranje/klemovanje
 * radi servis (`parsePagination`, `parseDateParam`).
 */
export interface ListNonconformityReportsQuery {
  /** '1' = dorada, '2' = škart; prazno = oba. */
  type?: string;
  /** '0' = draft, '1' = potvrđen; prazno = svi. */
  status?: string;
  /** Datum izveštaja od (ISO 8601, uključivo). */
  from?: string;
  /** Datum izveštaja do (ISO 8601, uključivo). */
  to?: string;
  /** Pretraga: ident, broj crteža, naziv pozicije, broj izveštaja. */
  q?: string;
  page?: string;
  pageSize?: string;
}

/** Query za `GET /kvalitet/summary-mini` — samo period (bedževi „na čekanju"). */
export interface SummaryMiniQuery {
  from?: string;
  to?: string;
}

/**
 * Query za `GET /kvalitet/summary` (K3.1 — izveštajni agregat nad potvrđenim
 * izveštajima, status=1). Sve stiže kao string; parsiranje/validaciju radi servis.
 */
export interface NonconformitySummaryQuery {
  /** '1' = dorada, '2' = škart; prazno = oba. */
  type?: string;
  /** Datum izveštaja od (ISO 8601, uključivo). */
  from?: string;
  /** Datum izveštaja do (ISO 8601, uključivo). */
  to?: string;
  /** day | week | month | year | worker | workUnit | cause | customer (default month). */
  groupBy?: string;
}
