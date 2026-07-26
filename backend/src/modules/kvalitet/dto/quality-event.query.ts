/**
 * Query parametri za listu i Pareto evidencije škarta/dorade
 * (MODULE_SPEC_kvalitet_skart_dorada §4). Svi su string (dolaze iz URL-a); servis
 * ih parsira/whitelist-uje (parseDateParam, Number).
 */
export interface ListQualityEventsQuery {
  /** SKART | DORADA (ostalo se ignoriše). */
  type?: string;
  /** PRIJAVLJEN | POTVRDJEN | ODBACEN (ostalo se ignoriše). */
  status?: string;
  /** RN (work_orders.id). */
  workOrderId?: string;
  /** Radna jedinica / mašina (RC kod — ILIKE po work_unit_code). */
  machine?: string;
  /** Razlog (quality_reason_codes.id). */
  reasonCodeId?: string;
  /** ISO datum (yyyy-mm-dd) — period od/do po reported_at. */
  from?: string;
  to?: string;
  page?: string;
  pageSize?: string;
}

/** Pareto agregat (samo POTVRDJEN) — zbir po razlogu i po mašini, procenti. */
export interface QualityParetoQuery {
  /** SKART | DORADA (izostavljen = oba). */
  type?: string;
  /** ISO datum (yyyy-mm-dd) — period od/do po reported_at. */
  from?: string;
  to?: string;
}
