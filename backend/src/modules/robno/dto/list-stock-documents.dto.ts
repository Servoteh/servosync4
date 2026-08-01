/** Filteri liste robnih dokumenata (`GET /stock-documents`). */
export interface ListStockDocumentsQuery {
  page?: string;
  pageSize?: string;
  /** UL | IZ | NIV | PRENOS | VISAK | MANJAK */
  kind?: string;
  documentTypeCode?: string;
  warehouseId?: string;
  supplierId?: string;
  status?: string; // DRAFT | CALCULATED | POSTED | LOCKED
  year?: string;
  /** Opseg po `documentDate` (ISO). */
  from?: string;
  to?: string;
  /**
   * Pretraga po BROJU DOKUMENTA (`documentNumber`, npr. „0001/2026" ili samo „0001").
   * Do 27.07.2026. su se `q`/`documentNumber`/`search` tiho ignorisali i lista je vraćala
   * sve — konkretna primka se nije mogla naći (nalaz §3.17). Podnizom i bez obzira na
   * veličinu slova; pretraga ide U SQL (pre paginacije), pa je i `meta.total` filtriran.
   */
  q?: string;
  /** Alias za `q` (isti smisao) — FE ga je slao pod ovim imenom. */
  documentNumber?: string;
}
