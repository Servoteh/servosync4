// Fuzzy pretraga za Ctrl+K komandnu paletu (F3 SIDEBAR_HUB). Bez biblioteka —
// jednostavno i čitljivo. Srpska latinica: dijakritika se skida OBOSTRANO (i na
// upitu i na meti) da bi „skart" našao „Škart", a „crtez" → „Crteži". Rangiranje:
// tačan substring UVEK pobeđuje subsequence; kod substringa raniji pogodak (pa
// kraća meta) je bolji — „substring pozicija pa dužina" (spec F3).

/** Dijakritika srpske latinice → ASCII. toLowerCase prvo svede Š→š itd. */
const DIACRITICS: Record<string, string> = { š: 's', đ: 'd', č: 'c', ć: 'c', ž: 'z' };

/** Kanonski oblik za poređenje: lowercase + skinuta dijakritika. */
export function normalize(s: string): string {
  return s.toLowerCase().replace(/[šđčćž]/g, (ch) => DIACRITICS[ch] ?? ch);
}

/**
 * Raspon subsequence-a: sva slova upita se pojavljuju redom u meti (ne nužno
 * spojena). Vraća razmak od prvog do poslednjeg pogođenog slova (0 = spojeno =
 * najbolje), ili null ako upit nije podniz. Greedy (prvi pogodak s leva) — dovoljno
 * za rangiranje, bez skupog traženja najtešnjeg raspona.
 */
function subsequenceSpan(q: string, m: string): number | null {
  let qi = 0;
  let first = -1;
  let last = -1;
  for (let mi = 0; mi < m.length && qi < q.length; mi++) {
    if (m[mi] === q[qi]) {
      if (first === -1) first = mi;
      last = mi;
      qi++;
    }
  }
  if (qi < q.length) return null; // nisu sva slova upita nađena redom
  return last - first;
}

// Substring skorovi žive u zasebnom, uvek višem opsegu od subsequence-a: čak i
// najgori substring (pozan pogodak, duga meta) nadmaši svaki subsequence.
const SUBSTRING_TIER = 1_000_000;

/**
 * Skor pogotka upita nad metom (label + naslov domena + keywords, spojeni razmakom).
 * Veći skor = relevantnije; null = nema pogotka. Prazan upit → 0 (pozivalac ionako
 * ne filtrira po skoru kad je upit prazan).
 */
export function fuzzyScore(query: string, meta: string): number | null {
  const q = normalize(query.trim());
  if (!q) return 0;
  const m = normalize(meta);

  const idx = m.indexOf(q);
  if (idx !== -1) {
    // Pozicija je primarni kriterijum (velika težina, 1000 >> dužina bilo koje mete),
    // dužina mete sekundarni — raniji i kraći pogodak pobeđuje.
    return SUBSTRING_TIER - idx * 1000 - m.length;
  }

  const span = subsequenceSpan(q, m);
  if (span === null) return null;
  // Uvek slabije od svakog substringa; kompaktniji raspon = bolji.
  return -span;
}
