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
 *   (6) PNB koji je DATUM .......................... samo sirov trim, bez ijednog
 *        izvedenog kandidata (v. `isDateTriplet` — `12-08-26` ne sme da dâ `8/26`)
 *   (7) PNB sa PREFIKSOM SERIJE (`A-7/26`) ......... svi izvedeni kandidati NOSE prefiks
 *        (v. `SERIES_PREFIXES` — `A-7/26` ne sme da dâ `7/26`)
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
 * DVOCIFRENA godina — od odluke O-F1 naši izlazni dokumenti nose broj `657/25`
 * (v. `sales/numbering.service.ts`), pa se i uplata poziva na `657-25` / `65725`.
 * Bez ovog obrasca auto-uparivanje ne bi rekonstruisalo `657/25` i svaka uplata bi
 * padala na slabiji fallback (uparivanje po iznosu) — a to je put do pogrešnog
 * zatvaranja stavke. Opseg se ne sužava: `/GG` je za našu upotrebu uvek moguć.
 */
const YEAR2_RE = /^\d{2}$/;

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
 * PNB KOJI JE ZAPRAVO DATUM — ne sme da proizvede broj fakture.
 * ─────────────────────────────────────────────────────────────────────────────
 * SCENARIO IZ KOG JE PRAVILO DOŠLO: platilac koji nema broj fakture pri ruci u
 * poziv na broj kuca DATUM — `12-08-26`. Parser je od poslednja dva segmenta
 * pravio „broj/godina" (`08/26`), pa je korak bez vodećih nula dodavao i `8/26`.
 * Pošto od odluke O-F1 naši brojevi izgledaju baš tako, uplata je sletala na
 * TUĐU fakturu `8/26` — pogrešno zatvorena stavka kod pogrešnog kupca.
 *
 * Ranije ovo nije bilo moguće: broj je nosio slovni prefiks (`IFR0008/2026`), pa
 * nijedan komad datuma nije mogao da ga oponaša.
 *
 * ODLUKA: datumski PNB daje SAMO sirov trim (egzaktan kandidat) — nijedan izveden
 * kandidat. Uparivanje tada padne na slabiji, ali pošten fallback po iznosu, umesto
 * da samouvereno zatvori pogrešnu fakturu.
 *
 * ŠTA SE NAMERNO NE HVATA (da legitiman PNB ne strada):
 *   • `657-25`, `657/25` — dva segmenta, datum traži tačno tri;
 *   • `97 657 25` (model 97 + broj + godina) — „97" nije ispravan dan (>31);
 *   • `11 5 26` — dan/mesec bez vodeće nule uz DVOCIFRENU godinu se NE računa kao
 *     datum, jer takav zapis realno dolazi kao model+broj+godina, a ne kao datum
 *     (ljudi datum kucaju `11-05-26`). Kratak datum mora biti potpuno dopunjen.
 */
const DAY_MONTH_PADDED_RE = /^\d{2}$/;
const DAY_MONTH_RE = /^\d{1,2}$/;
const YEAR2_ONLY_RE = /^\d{2}$/;
const YEAR4_RE = /^(19|20)\d{2}$/;

/** Da li tri segmenta čine dan/mesec/godinu (ili godina/mesec/dan)? */
function isDateTriplet(a: string, b: string, c: string): boolean {
  const num = (s: string) => Number.parseInt(s, 10);
  const dayOk = (s: string) => num(s) >= 1 && num(s) <= 31;
  const monthOk = (s: string) => num(s) >= 1 && num(s) <= 12;

  // GGGG-MM-DD (ISO) — četvorocifrena godina je nedvosmislena, pa dan/mesec smeju
  // biti i jednocifreni.
  if (YEAR4_RE.test(a) && DAY_MONTH_RE.test(b) && DAY_MONTH_RE.test(c)) {
    return monthOk(b) && dayOk(c);
  }
  // DD-MM-GGGG — isto, godina razrešava dvosmislenost.
  if (DAY_MONTH_RE.test(a) && DAY_MONTH_RE.test(b) && YEAR4_RE.test(c)) {
    return dayOk(a) && monthOk(b);
  }
  // DD-MM-GG — kratak datum se priznaje SAMO potpuno dopunjen (v. komentar gore).
  if (
    DAY_MONTH_PADDED_RE.test(a) &&
    DAY_MONTH_PADDED_RE.test(b) &&
    YEAR2_ONLY_RE.test(c)
  ) {
    return dayOk(a) && monthOk(b);
  }
  return false;
}

/**
 * PREFIKSI SERIJA BROJEVA — moraju se poklapati sa `sales/numbering.service.ts`
 * (`SERIES_PREFIX`, odluka O-F6). Sinhronost čuva test „prefiks serije je isti kao u
 * numeraciji" u `reference-parser.util.spec.ts` (uvoz `seriesPrefixFor`).
 *
 * ZAŠTO PARSER UOPŠTE ZNA ZA SERIJE (nalaz adversarnog pregleda 02.08.2026)
 * ─────────────────────────────────────────────────────────────────────────────
 * Prefiks `A-` je uveden baš zato što avansni račun i faktura završavaju na ISTOM
 * kupčevom kontu, a `ledger_entries` nema kolonu vrste dokumenta — pa se otvorene
 * stavke grupišu SAMO po broju. Parser je taj prefiks na kraju skidao: iz
 * `A-7/26` je pravio i kandidata `7/26`, dakle broj KONAČNE FAKTURE.
 *
 * SCENARIO (izmereno): kupac plati avans i u PNB upiše `A-7/26`. Dok je avansna
 * stavka otvorena, egzaktan kandidat je prvi i sve radi. Čim se avans zatvori
 * (naplaćen, netiran), egzaktan kandidat nema pogodak, a `7/26` ima — uplata
 * pozvana na avans sedne na fakturu `7/26` i zatvori tuđu obavezu. Razdvajanje
 * serija u numeraciji time biva poništeno na poslednjem koraku.
 *
 * PRAVILO: PNB koji nosi prefiks serije daje ISKLJUČIVO kandidate sa tim prefiksom.
 * Kandidati se grade nad ostatkom PNB-a (ista pravila: model 97, segmentacija,
 * broj/godina, datumska brana) pa im se prefiks vraća u KANONSKOM obliku iz
 * numeracije (`A-`), tako da i `A7/26` i `a 7/26` pogode upisani broj `A-7/26`.
 *
 * SVESNO ODSTUPANJE: ako neko slovo „A" upiše kao šum ispred broja fakture
 * (`A 657/25`), uparivanje po broju neće uspeti i uplata pada na fallback po iznosu.
 * To je namerno isti izbor kao kod datumskog PNB-a — pošten fallback je jeftiniji od
 * samouverenog zatvaranja pogrešne stavke.
 */
export const SERIES_PREFIXES: readonly string[] = ["A-"];

/**
 * Prepoznaj prefiks serije na početku PNB-a: slova serije, pa OPCIONO jedan
 * razdelnik (crtica/razmak/kosa crta), pa obavezno CIFRA.
 *
 * Zahtev da odmah sledi cifra je brana od lažnog pogotka: `ABC123` nije serija „A"
 * sa ostatkom `BC123`, a goli `A-` bez broja nije poziv na broj.
 *
 * @returns `{ prefix, rest }` u kanonskom obliku (`prefix` uvek kao u numeraciji), ili
 *          `null` kad PNB ne nosi seriju.
 */
function matchSeriesPrefix(
  raw: string,
): { prefix: string; rest: string } | null {
  for (const prefix of SERIES_PREFIXES) {
    const letters = prefix.replace(/[^A-Za-z]/g, "");
    if (letters.length === 0) continue;
    const re = new RegExp(`^${letters}[-\\s/]?(?=\\d)`, "i");
    const m = re.exec(raw);
    if (m) return { prefix, rest: raw.slice(m[0].length) };
  }
  return null;
}

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

  // (1a) PREFIKS SERIJE — kandidati se izvode iz OSTATKA, pa im se prefiks vraća
  //      (v. `SERIES_PREFIXES`). Nijedan kandidat bez prefiksa ne izlazi odavde:
  //      `A-7/26` (avans) ne sme da ponudi `7/26` (faktura istog kupca).
  const series = matchSeriesPrefix(rawTrim);
  if (series) {
    for (const inner of parseReference(series.rest, model).candidates) {
      push(`${series.prefix}${inner}`);
    }
    return { candidates: out };
  }

  const segmentsAll = rawTrim.split(SEPARATORS_RE).filter((s) => s.length > 0);

  // (1b) DATUM UMESTO BROJA — stani na egzaktnom kandidatu (v. `isDateTriplet`).
  //      Ceo PNB je datum (`12-08-26`, `12.08.2026`, `2026-08-12`): svaki izveden
  //      kandidat odavde bio bi izmišljen broj fakture — uključujući `08/26` i `8/26`
  //      koje je korak (4) pravio od poslednja dva segmenta.
  if (
    segmentsAll.length === 3 &&
    isDateTriplet(segmentsAll[0], segmentsAll[1], segmentsAll[2])
  ) {
    return { candidates: out };
  }

  const modelNorm = (model ?? "").trim();

  // (2) MODEL 97 — skini kontrolni broj.
  //   a) inline: PNB počinje „97" + 2 kontrolne cifre → skini 4 znaka („97KK").
  if (/^97\d{2}/.test(rawTrim)) push(rawTrim.slice(4));
  //   b) razdvojen: FX kolona Model=97, PNB nosi samo „KK"+osnovu → skini 2 kontrolne cifre.
  if (modelNorm === "97" && /^\d{2}/.test(rawTrim)) push(rawTrim.slice(2));

  // (3) SEGMENTACIJA po separatorima + kombinacije susednih (contiguous join).
  const segments = segmentsAll;
  if (segments.length > 1) {
    const n = Math.min(segments.length, MAX_SEGMENTS);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j <= n; j++) {
        push(segments.slice(i, j).join(""));
      }
    }
  }

  // (4) BROJ/GODINA — poslednji segment kao godina → „broj/godina" i goli „broj".
  //     (Goli „broj" je najčešće već dodat u koraku 3 kao segment, pa je `push`
  //     ovde no-op zbog dedupa — ostaje radi slučajeva kada nije.)
  //
  //     DATUM NA REPU: kad poslednja TRI segmenta čine datum (npr. `97 12-08-26` —
  //     model ispred datuma), rekonstrukcija „broj/godina" bi opet izmislila `08/26`.
  //     Korak (1b) hvata samo PNB koji je CEO datum, pa je ova provera njegov parnjak.
  const dateAtTail =
    segments.length >= 3 &&
    isDateTriplet(
      segments[segments.length - 3],
      segments[segments.length - 2],
      segments[segments.length - 1],
    );
  if (segments.length >= 2 && !dateAtTail) {
    const last = segments[segments.length - 1];
    const num = segments[segments.length - 2];
    if (YEAR_RE.test(last)) {
      push(`${num}/${last}`); // „123/2026" — stari (zatečeni) oblik broja
      push(`${num}/${last.slice(2)}`); // „123/26" — novi oblik (O-F1), isti dokument
      push(num);
    } else if (YEAR2_RE.test(last)) {
      push(`${num}/${last}`); // „657-25" → „657/25"
      push(num);
    }
  }

  // (5) VARIJANTE BEZ VODEĆIH NULA — za svakog dosad skupljenog numeričkog kandidata.
  for (const c of [...out]) {
    if (/^0+\d/.test(c)) push(c.replace(/^0+/, ""));
  }

  return { candidates: out };
}
