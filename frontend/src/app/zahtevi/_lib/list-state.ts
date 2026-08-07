/**
 * KLJUČEVI STANJA RADNE LISTE ZAHTEVA — jedan izvor za `AdminView` i za tabove koji
 * imaju sopstveno stanje (Nagrade, Odluke).
 *
 * 🔴 ZAMKA ZBOG KOJE OVAJ FAJL POSTOJI: `useListQueryState.setValues` serijalizuje SAMO
 * ključeve iz svog `defaults` i to upisuje kroz `router.replace`. Tab koji navede samo
 * svoje ključeve obrisao bi `tab` iz adrese — administrator bi posle prve promene meseca
 * ispao na Inbox. Zato svaki tab širi OVU konstantu svojim ključevima.
 *
 * 🔴 `tab` ovde OSTAJE `'inbox'` i u tabovima: podrazumevana vrednost se ne piše u URL,
 * pa bi tab sa `defaults.tab = 'nagrade'` izbacio `tab=nagrade` iz adrese i vratio
 * korisnika na Inbox pri prvoj izmeni sopstvenog filtera.
 */
export const STANJE_LISTE_ZAHTEVA = {
  tab: 'inbox',
  strana: '1',
  status: '',
  modul: '',
  tip: '',
  trazi: '',
  podnosilac: '',
};

/**
 * Svi filteri liste u praznom stanju + povratak na prvu stranu, za JEDAN upis.
 * Dva uzastopna `setValues` bila bi dva `router.replace` i dva zapisa u `sessionStorage`,
 * pa bi Nazad pregledača prolazio kroz međustanje.
 */
export const PRAZNI_FILTERI_ZAHTEVA = {
  status: '',
  modul: '',
  tip: '',
  trazi: '',
  podnosilac: '',
  strana: '1',
};
