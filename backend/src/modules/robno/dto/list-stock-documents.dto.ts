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
}
