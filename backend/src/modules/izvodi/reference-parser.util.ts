/**
 * PARSER POZIVA NA BROJ (PNB) → kandidati broja dokumenta.
 * =========================================================================
 * Čist port DUHA legacy funkcije `FX_OdrediBrojDokumenta` (BigBit, `:35-56`),
 * dokumentovan i u doc 21 §A (`backend/docs/migration/21-...md:37`).
 *
 * LEGACY PONAŠANJE: `FX_OdrediBrojDokumenta` iz sirovog PNB-a vadi „broj
 * dokumenta" tako što traži obrazac `(brojDok)/` i parsira ga po separatorima
 * `(`, `)`, `\`. Tj. uplata nosi broj fakture „umotan" u model/kontrolni broj i
 * pomoćne razdelnike, a auto-uparivanje mora da izoluje goli broj dokumenta.
 *
 * ZAŠTO KANDIDATI (a ne jedan rezultat): BigBit je imao JEDAN kanon (FX export
 * banke), mi primamo više realnih varijanti PNB-a (model 97 prefiks, kontrolni
 * broj, godina, crtice/kose crte/parove). Umesto pogađanja jednog obrasca,
 * `parseReference` vraća UREĐENU listu kandidata (prvi = sirov trim = egzaktan),
 * a matcher (`bank-statement.service.matchOpenItem`) proba redom — prvi pogodak,
 * i dalje uslovljen komitentom. Time egzaktan pogodak OSTAJE prvi (nema regresije),
 * a fuzzy varijante hvataju BigBit-nivo uparivanja.
 *
 * MAPIRANJE na zahtev (doc 21 §A auto-match, plan §1 #31 / §3 1E-E4):
 *   (1) sirov trim ................................ uvek prvi kandidat (egzaktan)
 *   (2) bez modela 97 kontrolnog broja ............ inline „97KK" prefiks (4 znaka),
 *        ili razdvojen model=97 (FX kolona Model(167,2)) → skini 2 kontrolne cifre
 *   (3) segmentacija po `(` `)` `\` `/` `-` razmak . svaki segment + kombinacije susednih
 *   (4) varijante bez vodećih nula ................ „00123" → „123"
 *   (5) broj/godina obrazac ....................... poslednji segment = godina 20xx →
 *        „broj/godina" (kosa crta) i goli „broj"
 *
 * MODEL: `BankStatementLine` NEMA kolonu za model (provereno u schema.prisma), pa
 * se model NE persistuje — prosleđuje se opciono kroz `parseReference(raw, model)`
 * (koristi ga preview/parse tok). U matchovanju (persistovana stavka) model nije
 * dostupan, pa se model-97 skidanje oslanja na INLINE detekciju „97"+KK iz sirovog
 * PNB-a (drugi trigger u tački 2) — persistencijski nezavisan put.
 */

/** Rezultat parsiranja PNB-a: uređeni kandidati broja dokumenta (prvi = egzaktan). */
export interface ParsedReference {
  candidates: string[];
}

/** Godina u opsegu 19xx/20xx (poslednji segment kao godina → broj/godina obrazac). */
const YEAR_RE = /^(19|20)\d{2}$/;

/**
 * Separatori za segmentaciju (FX_OdrediBrojDokumenta: `(`, `)`, `\`; prošireno na
 * `/`, `-` i razmak — realne varijante PNB-a). `\s` hvata i tabove/više razmaka.
 */
const SEPARATORS_RE = /[()\\\/\s-]+/;

/** Kandidat je predugačak da bi bio broj dokumenta (documentNumber je VarChar(30)). */
const MAX_CANDIDATE_LEN = 40;

/** Najviše segmenata koje kombinujemo (zaštita od kvadratne eksplozije kandidata). */
const MAX_SEGMENTS = 8;

/**
 * Parsira sirov poziv na broj u uređenu listu kandidata broja dokumenta.
 *
 * @param raw   sirov PNB (FX PozivNaBroj(169,20), trimovan)
 * @param model opcioni PNB model (FX Model(167,2): „97" | „11" | „99"); kad je „97"
 *              a PNB nosi samo „KK"+osnovu, skida se 2-cifreni kontrolni prefiks
 * @returns `{ candidates }` — prvi element je uvek sirov trim (egzaktan pogodak);
 *          prazan niz kad PNB nema upotrebljivu vrednost
 */
export function parseReference(
  raw: string | null | undefined,
  model?: string | null,
): ParsedReference {
  const rawTrim = (raw ?? "").trim();
  const out: string[] = [];

  const push = (value: string | null | undefined): void => {
    if (value == null) return;
    const v = value.trim();
    if (v.length === 0 || v.length > MAX_CANDIDATE_LEN) return;
    if (!out.includes(v)) out.push(v);
  };

  if (rawTrim.length === 0) return { candidates: [] };

  // (1) EGZAKTAN — sirov trim je UVEK prvi kandidat (očuvanje postojećeg egzaktnog match-a).
  push(rawTrim);

  const modelNorm = (model ?? "").trim();

  // (2) MODEL 97 — skini kontrolni broj.
  //   a) inline: PNB počinje „97" + 2 kontrolne cifre → skini 4 znaka („97KK").
  if (/^97\d{2}/.test(rawTrim)) push(rawTrim.slice(4));
  //   b) razdvojen: FX kolona Model=97, PNB nosi samo „KK"+osnovu → skini 2 kontrolne cifre.
  if (modelNorm === "97" && /^\d{2}/.test(rawTrim)) push(rawTrim.slice(2));

  // (3) SEGMENTACIJA po separatorima + kombinacije susednih (contiguous join).
  const segments = rawTrim.split(SEPARATORS_RE).filter((s) => s.length > 0);
  if (segments.length > 1) {
    const n = Math.min(segments.length, MAX_SEGMENTS);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j <= n; j++) {
        push(segments.slice(i, j).join(""));
      }
    }
  }

  // (4) BROJ/GODINA — poslednji segment kao godina 20xx → „broj/godina" i goli „broj".
  if (segments.length >= 2 && YEAR_RE.test(segments[segments.length - 1])) {
    const year = segments[segments.length - 1];
    const num = segments[segments.length - 2];
    push(`${num}/${year}`);
    push(num);
  }

  // (5) VARIJANTE BEZ VODEĆIH NULA — za svakog dosad skupljenog numeričkog kandidata.
  for (const c of [...out]) {
    if (/^0+\d/.test(c)) push(c.replace(/^0+/, ""));
  }

  return { candidates: out };
}
