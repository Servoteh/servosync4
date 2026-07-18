// Preslovljavanje srpske latinice u ćirilicu (HR dokumenti — podaci u bazi su
// latinica, dokumenti su ćirilica). Port 1.0 `src/lib/cyr.js`.
//
// Digrafi (lj, nj, dž) se obrađuju PRE pojedinačnih slova. Tekst koji već
// sadrži ćirilicu ili znakove van mape (cifre, interpunkcija, w/q/x/y) prolazi
// nepromenjen. Mehaničko 1:1 preslovljavanje.

/* Digrafi prvo — duži ključevi pre kraćih da se izbegne delimično poklapanje. */
const DIGRAPHS: [string, string][] = [
  ['DŽ', 'Џ'], ['Dž', 'Џ'], ['dž', 'џ'],
  ['LJ', 'Љ'], ['Lj', 'Љ'], ['lj', 'љ'],
  ['NJ', 'Њ'], ['Nj', 'Њ'], ['nj', 'њ'],
];

const SINGLE: Record<string, string> = {
  A: 'А', B: 'Б', V: 'В', G: 'Г', D: 'Д', Đ: 'Ђ', E: 'Е', Ž: 'Ж', Z: 'З',
  I: 'И', J: 'Ј', K: 'К', L: 'Л', M: 'М', N: 'Н', O: 'О', P: 'П', R: 'Р',
  S: 'С', T: 'Т', Ć: 'Ћ', U: 'У', F: 'Ф', H: 'Х', C: 'Ц', Č: 'Ч', Š: 'Ш',
  a: 'а', b: 'б', v: 'в', g: 'г', d: 'д', đ: 'ђ', e: 'е', ž: 'ж', z: 'з',
  i: 'и', j: 'ј', k: 'к', l: 'л', m: 'м', n: 'н', o: 'о', p: 'п', r: 'р',
  s: 'с', t: 'т', ć: 'ћ', u: 'у', f: 'ф', h: 'х', c: 'ц', č: 'ч', š: 'ш',
};

/** Latinica → ćirilica. Vraća '' za prazno; ćirilica/ostalo prolazi nepromenjeno. */
export function toCyrillic(input: string | null | undefined): string {
  if (input == null) return '';
  let s = String(input);
  for (const [lat, cyr] of DIGRAPHS) s = s.split(lat).join(cyr);
  let out = '';
  for (const ch of s) out += SINGLE[ch] ?? ch;
  return out;
}
