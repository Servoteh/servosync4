/**
 * Filteri liste komitenata (`GET /api/v1/komitenti`). Query stiže kao stringovi —
 * servis ih parsira kroz `parsePagination`; ostatak su čisti `contains` filteri.
 */
export interface ListCustomersQuery {
  page?: string;
  pageSize?: string;
  /** Pretraga: naziv / PIB / mesto (case-insensitive `contains`). */
  q?: string;
  /** Vrsta šifre (`Vrste sifara.Vrsta sifre` → `customers.code_type_code`). */
  codeTypeCode?: string;
}
