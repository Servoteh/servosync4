/**
 * Query za `GET /kvalitet/docs` (K4-UPLOAD — lista QC dokumenata BEZ sadržaja).
 * Sve stiže kao string iz URL-a; parsiranje/klemovanje radi servis
 * (`parsePagination`, `parseDateParam`, `parseOptId`).
 */
export interface ListQualityDocsQuery {
  /** Filter po vezanom izveštaju (nonconformity_reports.id). */
  reportId?: string;
  /** Filter po vezanom tehnološkom postupku (tech_processes.id, meki). */
  techProcessId?: string;
  /** Filter po ident broju RN-a (tačno poklapanje). */
  identNumber?: string;
  /** Pretraga: ime fajla ILI ident broj (ILIKE). */
  q?: string;
  /** Datum uploada od (ISO 8601, uključivo). */
  from?: string;
  /** Datum uploada do (ISO 8601, uključivo). */
  to?: string;
  page?: string;
  pageSize?: string;
}
