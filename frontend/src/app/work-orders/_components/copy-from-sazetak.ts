/**
 * Sažetak potvrde za „Kopiraj iz naloga" — čiste funkcije, bez React-a.
 *
 * 🔴 ZAŠTO POSTOJI (incident 07.08.2026, prijavili Jovica/Aca/Dragan):
 * tehnolozi su prijavljivali da se tehnološki postupak „sam pojavi" na novom
 * nalogu iz primopredaje. Merenjem je utvrđeno da ga upisuje čovek, klikom na
 * „Kopiraj iz naloga" — samo iz POGREŠNOG izvora. Kad se u biraču otkuca prefiks
 * `9811-2/12`, lista ponudi `…/124`, `…/123`, `…/122`, `…/121`, `…/120`: pet
 * natpisa koji se razlikuju u POSLEDNJEM znaku, redovi visoki 44 px, a izbor se
 * potvrđuje PRVIM dodirom (`onMouseDown`, bez drugog klika). U padajućoj listi
 * naziv pozicije se vidi, ali čim se red izabere `ComboBox` se skupi na dugme sa
 * golim ident brojem — pa u trenutku pritiska na „Kopiraj" na ekranu nema ničega
 * što odaje da je izabrano „…-zavarivanje" umesto „…-obrada". Opoziva nema:
 * povratak je ručno brisanje operacija jednu po jednu.
 *
 * Zato potvrda mora da IMENUJE obe strane i da kaže KOLIKO se stavki prepisuje.
 * Isti lek je 052/26 već primenjen na birač crteža (`getValueLabel`, v.
 * `handovers/_components/drafts-tab.tsx`) — ovde se samo dosledno ponavlja.
 */

/** Onoliko polja koliko potvrdi treba — namerno uži od punog `WorkOrder`. */
export interface NalogZaSazetak {
  identNumber: string;
  partName?: string | null;
  drawingNumber?: string | null;
}

/** Broj stavki koje `cloneItems` stvarno prepisuje (četiri tabele, ne samo operacije). */
export interface BrojStavki {
  operacije: number;
  obradjeniDelovi: number;
  nestandardniDelovi: number;
  pripremci: number;
}

/**
 * Natpis naloga: ident + naziv pozicije, pa crtež.
 *
 * Ident se NIKAD ne izostavlja (po njemu ljudi pričaju), ali sam ne razlikuje
 * susedne naloge — zato uz njega ide naziv. Crtež je treći jer je najduži, a
 * najređe se po njemu prepoznaje pozicija.
 */
export function natpisNaloga(n: NalogZaSazetak | null | undefined): string {
  if (!n) return '';
  const naziv = n.partName?.trim();
  const crtez = n.drawingNumber?.trim();
  return [n.identNumber, naziv || null, crtez ? `crtež ${crtez}` : null]
    .filter(Boolean)
    .join(' · ');
}

/** Natpis za skupljeni `ComboBox` — bez crteža, jer dugme je usko i seče tekst. */
export function natpisIzbora(n: NalogZaSazetak | null | undefined): string {
  if (!n) return '';
  const naziv = n.partName?.trim();
  return naziv ? `${n.identNumber} · ${naziv}` : n.identNumber;
}

export function ukupnoStavki(b: BrojStavki): number {
  return (
    b.operacije + b.obradjeniDelovi + b.nestandardniDelovi + b.pripremci
  );
}

/**
 * Rečenica potvrde. Operacije se broje ODVOJENO od ostalog jer je tehnološki
 * postupak ono zbog čega se kopira — ostale stavke su prateće.
 *
 * Množina je srpska (1 operacija · 2–4 operacije · 5+ operacija), jer „6 operacija"
 * naspram „6 operacije" je razlika koju čovek u pogonu primeti i izgubi poverenje.
 */
export function recenicaPotvrde(
  izvor: NalogZaSazetak,
  cilj: NalogZaSazetak,
  b: BrojStavki,
): string {
  const ostalo = ukupnoStavki(b) - b.operacije;
  const delovi = [
    `Prepisuje se ${mnozina(b.operacije, 'operacija', 'operacije', 'operacija')}`,
  ];
  if (ostalo > 0)
    delovi.push(
      ` i još ${mnozina(ostalo, 'stavka', 'stavke', 'stavki')} (pripremci i delovi)`,
    );
  delovi.push(` iz naloga ${natpisNaloga(izvor)} u nalog ${natpisNaloga(cilj)}.`);
  return delovi.join('');
}

/**
 * Srpska množina po poslednjoj cifri: 1 → jednina, 2–4 → mala množina,
 * ostalo → velika. Izuzetak je 11–14, koji uprkos poslednjoj cifri idu u veliku.
 */
export function mnozina(
  n: number,
  jedan: string,
  dvaTriCetiri: string,
  ostalo: string,
): string {
  const posl = Math.abs(n) % 10;
  const posl2 = Math.abs(n) % 100;
  if (posl2 >= 11 && posl2 <= 14) return `${n} ${ostalo}`;
  if (posl === 1) return `${n} ${jedan}`;
  if (posl >= 2 && posl <= 4) return `${n} ${dvaTriCetiri}`;
  return `${n} ${ostalo}`;
}
