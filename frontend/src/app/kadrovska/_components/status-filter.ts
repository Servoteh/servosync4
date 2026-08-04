// ============================================================================
// Dvostepeni tok odluke (GO / nadoknada / plaćeno odsustvo) — filter statusa.
// ČISTE FUNKCIJE, bez React-a i bez ijednog importa: jedno mesto istine za sve
// tri liste (Odmori → Zahtevi, Odsustva → Nadoknada, Odsustva → Plaćeno).
//
// ZAHTEV 068/26 (Nenad, 04.08.2026): „mogu da odobrim ja ili Nevena ili Zoran
// kao admini, samo je potrebno da imamo u zahtevima za odobravanje!"
// KOREN (izmereno na produ): sve tri liste su se otvarale sa filterom `pending`
// i tvrdim poređenjem `r.status !== statusF`, pa je zahtev koji je šef PROSLEDIO
// (`sef_approved`) ispadao iz tabele. Patologija je svuda ista — „brojka se vidi,
// sadržaj ne": badž taba „Zahtevi (5)" broji oba stepena, čip „Čeka kadrovsku"
// pokazuje brojku, a tabela ispod piše „Nema zahteva".
// ============================================================================

/** Statusi koji čekaju odluku: 1. nivo (šef) i 2. nivo (kadrovska/HR). */
export const OPEN_DECISION_STATUSES: readonly string[] = ['pending', 'sef_approved'];

/** Vrednost pseudo-filtera „čeka odluku" (NIJE status u bazi). */
export const STATUS_FILTER_OPEN = 'open';

/**
 * Prazan filter = svi; `open` = oba stepena koja čekaju; inače tačan status.
 * Ručno provereno (nema FE test-runnera): '' → sve, 'open' → pending+sef_approved,
 * 'pending' → samo pending, 'sef_approved' → samo drugi stepen, 'approved'/
 * 'rejected'/'completed'/'storniran'/'canceled' → tačan status, nepoznat status
 * → prazno (ne pušta pogrešan red).
 */
export function matchesStatusFilter(status: string, filter: string): boolean {
  if (!filter) return true;
  if (filter === STATUS_FILTER_OPEN) return OPEN_DECISION_STATUSES.includes(status);
  return status === filter;
}
