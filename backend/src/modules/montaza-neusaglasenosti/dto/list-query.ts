/**
 * Query parametri liste `GET /montaza/neusaglasenosti`
 * (MODULE_SPEC_montaza_neusaglasenosti §3). Svi su string (dolaze iz URL-a);
 * servis ih parsira/whitelist-uje.
 */
export interface ListNonconformityQuery {
  /** CEKA_ANALIZU | U_TOKU | ZAVRSENO (ostalo se ignoriše). */
  status?: string;
  /** MALA | SREDNJA | VISOKA. */
  severity?: string;
  /** Pretraga po opisu / predmetu / RN / odeljenju (ILIKE). */
  q?: string;
  /** ISO datum (yyyy-mm-dd) — period od/do po createdAt. */
  from?: string;
  to?: string;
  page?: string;
  pageSize?: string;
}
