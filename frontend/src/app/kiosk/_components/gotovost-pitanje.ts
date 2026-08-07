/**
 * Pitanje „Da li je operacija gotova?" — GEJT i OBLIK, na jednom mestu.
 *
 * Kiosk ga postavlja na DVA ekrana: „Moji otvoreni" (`my-open-panel.tsx`) i
 * barkod radni panel (`work-panel.tsx`). Uslov je do sada bio doslovno prepisan
 * u oba fajla; kad se 07.08.2026. menjao oblik dijaloga, to je značilo dve
 * identične izmene i dve prilike da se raziđu. Zato je ovde — čiste funkcije bez
 * React-a, pa su i pokrivene testom (`gotovost-pitanje.spec.ts`; frontend nema
 * jest, testovi idu pod `node --test` nad `*.spec.ts`).
 *
 * 🔴 NULA KOMADA (odluka Nenad 07.08.2026): kad kumulativ POSLE prijave nije
 * veći od nule, dijalog i dalje iskače, ali menja lice — „Da — gotova je" se
 * UOPŠTE NE NUDI. Mereno na produkciji 07.08.: od uvođenja pitanja (05.08.)
 * operacija je 16 puta zatvorena sa nula komada (9 radnika), a od zahteva 069/26
 * plan računa gotovost po DOBRIM komadima — takva operacija nikad ne dobije
 * kvačicu u planu, samo nestane sa liste otvorenih. Za pogrešno otvoren red
 * postoji „Odustani", koji zastavicu izričito ne diže.
 */

/** Koji oblik dijaloga se prikazuje kad je pitanje odlučeno (`trebaPitatiZaGotovost`). */
export type GotovostOblik = 'nula' | 'ispod-plana';

/**
 * Da li se pitanje o gotovosti UOPŠTE postavlja.
 *
 * @param withoutProcess OPŠTI NALOG (RC bez postupka) — nema svoj plan (`plan` je
 *   plan celog RN-a, npr. 4521/0000.0 nosi 100.000), pa bi pitanje iskakalo na
 *   svaki „Kraj rada". Server takav red gasi svojom granom (čišćenje reda).
 * @param plan Plan RN-a; `null` ili 0 = plan nije poznat (18 RN na produ ima 0).
 * @param ukupno Kumulativ CELE operacije POSLE ove prijave (svi kvaliteti).
 */
export function trebaPitatiZaGotovost(
  withoutProcess: boolean,
  plan: number | null,
  ukupno: number,
): boolean {
  if (withoutProcess) return false;
  const planPoznat = plan != null && plan > 0;
  // Plan dostignut → nema pitanja, server gasi sam.
  return !planPoznat || ukupno < plan;
}

/** Plan koji se prikazuje u pitanju; 0 i null su isto — „nije poznat". */
export function planZaPitanje(plan: number | null): number | null {
  return plan != null && plan > 0 ? plan : null;
}

/**
 * Oblik dijaloga. `<= 0`, ne `=== 0`: storno upisuje kontra-red sa negativnim
 * brojem komada, pa kumulativ ume da padne ispod nule (danas na produ nema
 * nijedne takve operacije, ali je matematički moguće).
 */
export function oblikPitanja(ukupno: number): GotovostOblik {
  return ukupno <= 0 ? 'nula' : 'ispod-plana';
}

/**
 * Tekstovi dijaloga — deljeni, da oba ekrana kažu radniku DOSLOVNO isto.
 *
 * 🔴 STRANA DUGMADI: primary je UVEK DESNO i u oba oblika ima ISTU posledicu —
 * operacija OSTAJE OTVORENA („Ne — nastavlja se" / „Upiši samo vreme"). Naučen
 * pokret radnika tako ostaje tačan i kad dijalog promeni lice, a „Da — gotova je"
 * u nula-obliku fizički NESTANE sa ekrana (disabled dugme na dodirnom ekranu
 * radnik tapka i misli da ekran ne radi).
 */
export const TEKST_GOTOVOST = {
  'ispod-plana': {
    naslov: 'Da li je operacija gotova?',
    /** secondary, levo — jedino mesto koje šalje `operacijaGotova = true`. */
    levo: 'Da — gotova je',
    /** primary, desno — `operacijaGotova = false`. */
    desno: 'Ne — nastavlja se',
    objasnjenje:
      '„Ne" upisuje tvoj rad i vreme, a operacija ostaje otvorena za nastavak. „Da" je zatvara iako količina nije puna.',
  },
  nula: {
    naslov: 'Nisi otkucao nijedan komad',
    /** secondary, levo — samo zatvara dijalog, ništa se ne šalje. */
    levo: 'Vrati me — upisujem količinu',
    /** primary, desno — `operacijaGotova = false` (upisuje se samo vreme rada). */
    desno: 'Upiši samo vreme',
    objasnjenje:
      'Kraj rada bez komada upisuje SAMO tvoje vreme rada — operacija OSTAJE OTVORENA. Operacija sa nula komada ne može biti označena kao gotova.',
    /** Dopuna samo u „Moji otvoreni" — tamo dugme „Odustani" i postoji. */
    odustani: 'Ako si red otvorio greškom, skloni ga dugmetom „Odustani".',
  },
} as const;
