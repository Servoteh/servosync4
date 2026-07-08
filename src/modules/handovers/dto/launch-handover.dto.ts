/**
 * Lansiranje primopredaje → kreira `work_orders` red (§6.4). Oba polja
 * opciona; obavezni podaci za RN (predmet/crtež/količina) dolaze iz povezane
 * `handover_draft_items` stavke, ne iz ovog tela zahteva.
 */
export interface LaunchHandoverDto {
  comment?: string;
  /** ISO datum roka za novi RN (`work_orders.production_deadline`). */
  dueDate?: string;
}
