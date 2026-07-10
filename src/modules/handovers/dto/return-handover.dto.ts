/**
 * "Vrati na čekanje" — undo odobravanja (SAGLASAN → U OBRADI). `reason` je
 * opcion; upisuje se u postojeće `status_change_comment` polje. Blokirano ako
 * za primopredaju već postoji RN (odluka o storniranju RN-a je otvorena).
 */
export interface ReturnHandoverDto {
  reason?: string;
}
