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
 *   (7) PNB sa OZNAKOM SERIJE (`A-7/26`, `AVANS 7/26`) . svi izvedeni kandidati NOSE
 *        prefiks (v. `SERIES` — `A-7/26` ne sme da dâ `7/26`); oznaka se traži BILO GDE
 *        u PNB-u i prepoznaje po ZNAČENJU (slovo serije, šifra vrste ili reč kojom je
 *        platilac imenuje), a vezuje broj koji joj neposredno sledi
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
 * SERIJE BROJEVA + REČI KOJIMA IH PLATILAC IMENUJE.
 * ─────────────────────────────────────────────────────────────────────────────
 * `prefix` mora da se poklapa sa registrom u `sales/numbering.service.ts`
 * (`DOCUMENT_SERIES`, odluke O-F6/O-F7). Sinhronost čuva test „parser poznaje SVE
 * prefikse iz registra numeracije" u `reference-parser.util.spec.ts` — kad se serija
 * doda samo tamo, ovaj test pada. Registar se namerno NE uvozi: numeracija zna šta
 * UPISUJE (`A-`), a ovde stoji i ono što ona ne zna — kako kupac tu istu seriju ZOVE
 * (`AVANS`, `AVR`, `predračun`…). To su dva različita posla i dva različita spiska.
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
 * PRAVILO: PNB koji nosi oznaku serije daje ISKLJUČIVO kandidate sa tim prefiksom.
 * Kandidati se grade nad ostatkom PNB-a (ista pravila: model 97, segmentacija,
 * broj/godina, datumska brana) pa im se prefiks vraća u KANONSKOM obliku iz
 * numeracije (`A-`), tako da i `A7/26` i `a 7/26` i `AVANS 7/26` pogode upisani broj
 * `A-7/26`.
 *
 * ZAŠTO SE REČ (`AVANS 1/26`) SME DA PREVEDE U `A-1/26`: kandidat sa prefiksom može
 * da pogodi ISKLJUČIVO stavku avansne serije — nijedan drugi dokument u glavnoj knjizi
 * ne počinje sa `A-`. Dodavanje takvog kandidata dakle ne može da zatvori pogrešnu
 * stavku, može samo da zatvori pravu. Da smo umesto toga pustili goli `1/26`, promašaj
 * bi bio tih i skup (zatvorena tuđa faktura). Rizik je asimetričan, pa je i pravilo.
 *
 * SVESNO ODSTUPANJE: ako neko slovo „A" upiše kao šum ispred broja fakture
 * (`A 657/25`), uparivanje po broju neće uspeti i uplata pada na fallback po iznosu.
 * To je namerno isti izbor kao kod datumskog PNB-a — pošten fallback je jeftiniji od
 * samouverenog zatvaranja pogrešne stavke.
 *
 * DOPUNA (treći krug pregleda, 02.08.2026): brana je gledala samo POČETAK sirovog
 * PNB-a, pa ju je jedan model ispred serije potpuno gasio — izmereno, `97 A-7/26` je
 * i dalje davao `7/26`.
 *
 * DOPUNA (nalaz N11/N10, 02.08.2026): brana je i posle toga bila SINTAKSNA — tražila je
 * oznaku samo na dva mesta u nizu znakova, pa je svaki drugi oblik šuma probijao.
 * IZMERENO na tadašnjem kodu:
 *     `AVANS 1/26`              → ["AVANS 1/26","AVANS","AVANS1","AVANS126","1","126","26","1/26"]
 *     `AVR 1/26`                → ["AVR 1/26","AVR","AVR1","AVR126","1","126","26","1/26"]
 *     `A. 1/26`                 → ["A. 1/26","A.","A.1","A.126","1","126","26","1/26"]
 *     `A) 1/26`                 → ["A) 1/26","A","A1","A126","1","126","26","1/26"]
 *     `uplata po avansu A-1/26` → [… ,"1","126","26","1/26"]
 * Svaki od njih završava golim `1/26` — brojem KONAČNE FAKTURE istog kupca. Zato se
 * oznaka od tada traži BILO GDE u PNB-u i prepoznaje po ZNAČENJU (v. `aliases`).
 */
interface SeriesMarker {
  /** Kanonski prefiks — tačno onako kako ga numeracija upisuje u broj (`A-`). */
  prefix: string;
  /**
   * Regex-alternative kojima platilac imenuje seriju (case-insensitive, bez zagrada).
   * Redosled nije bitan za tačnost (unutar serije se bira duža alternativa jer stoji
   * prva), ali JESTE za čitljivost: prvo reč, pa šifra, pa golo slovo.
   */
  aliases: readonly string[];
}

/** Slova (ASCII + naša) — koriste se i za „reč" i za granicu reči. */
const LETTERS = "A-Za-zČĆŽŠĐčćžšđ";

/**
 * Razmak između oznake serije i broja: do tri NE-slovna, NE-cifrena znaka.
 * Pokriva `A-1/26`, `A 1/26`, `A. 1/26`, `A) 1/26`, `A/ 1/26`. Više od tri znaka nije
 * razdelnik nego drugi podatak, pa se oznaka tada ne vezuje za taj broj.
 */
const SERIES_GAP = `[^${LETTERS}0-9]{0,3}`;

const SERIES: readonly SeriesMarker[] = [
  // AVR — avansni račun (O-F6). Sve reči koje počinju sa „avans" znače isto
  // (avansu, avansa, avansni…), pa ide džoker; `AVR` i golo `A` su tačni oblici.
  { prefix: "A-", aliases: [`AVANS[${LETTERS}]*`, "AVR", "A"] },
  // PROF — predračun (O-F7). Reči su NABROJANE, ne „PRO*"/„PROF*": „PROFIT 12/26" nije
  // predračun, a lažna oznaka bi pojela broj fakture.
  {
    prefix: "PROF-",
    aliases: [`PREDRA[CČ]UN[${LETTERS}]*`, `PROFAKTUR[${LETTERS}]*`, "PROF"],
  },
  // PON — ponuda (O-F7). Isti razlog za nabrajanje: „PONOVO 12/26" ne sme da bude oznaka.
  { prefix: "PON-", aliases: [`PONUD[${LETTERS}]*`, "PON"] },
  // REV — revers (O-F7). „REVIZIJA" nije revers, pa `REV[a-z]*` ne dolazi u obzir.
  { prefix: "REV-", aliases: [`REVERS[${LETTERS}]*`, "REV"] },
];

/** Prefiksi serija, redosledom iz `SERIES` (izvor za branu sinhronosti sa numeracijom). */
export const SERIES_PREFIXES: readonly string[] = SERIES.map((s) => s.prefix);

/** Da li je znak slovo (granica reči — v. `matchSeriesPrefix`). */
const LETTER_RE = new RegExp(`[${LETTERS}]`);

/**
 * Nađi oznaku serije BILO GDE u PNB-u i vrati kanonski prefiks + deo PNB-a iza nje.
 *
 * DVA USLOVA — oba su brane od lažne oznake, i oba su izmerena, ne pretpostavljena:
 *
 *   1) OZNAKA JE SAMOSTALNA: znak ispred nje ne sme biti slovo. Bez toga bi „fakturA
 *      657/25" bilo pročitano kao serija (poslednje „a" + razmak + cifra) i broj fakture
 *      bi nestao iz kandidata — kvar gori od onog koji se popravlja. Cifra ili razdelnik
 *      ispred oznake su u redu, jer tako izgleda model/kontrolni broj (`97A-7/26`).
 *
 *   2) OZNAKA VEZUJE BROJ KOJI JOJ NEPOSREDNO SLEDI (do tri razdelnika, pa CIFRA).
 *      Zato `ABC123` nije serija „A" sa ostatkom `BC123`, a `AVANS PO FAKTURI 1/26`
 *      ostaje faktura — tu broj pripada fakturi, ne avansu, pa goli `1/26` mora da
 *      preživi. Pravilo „reč avans bilo gde u PNB-u" bi taj legitiman poziv na broj
 *      pojelo (izmereno na primeru „avansno placanje po fakturi 657/25").
 *
 * Uzima se NAJRANIJA samostalna pojava bilo koje serije; na istom mestu pobeđuje serija
 * koja je prva u `SERIES` (do toga u praksi ne dolazi — alijasi se ne preklapaju).
 *
 * Ono što je ISPRED oznake se ODBACUJE (model, kontrolni broj, reči). Posledica je ista
 * kao kod `A 657/25`: ako neko ispred oznake stavi pravi broj dokumenta, taj broj neće
 * biti kandidat i uparivanje pada na fallback po iznosu. To je jeftinije od rizika da
 * uplata na avans sedne na fakturu.
 *
 * @returns `{ prefix, rest }` u kanonskom obliku (`prefix` uvek kao u numeraciji), ili
 *          `null` kad PNB ne nosi oznaku serije.
 */
function matchSeriesPrefix(
  raw: string,
): { prefix: string; rest: string } | null {
  let best: { prefix: string; rest: string; at: number } | null = null;

  for (const series of SERIES) {
    const re = new RegExp(
      `(?:${series.aliases.join("|")})${SERIES_GAP}(?=\\d)`,
      "gi",
    );
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) {
      // (1) samostalna oznaka — slovo ispred znači da je to sredina reči, ne serija.
      if (m.index > 0 && LETTER_RE.test(raw[m.index - 1])) continue;
      if (best == null || m.index < best.at) {
        best = {
          prefix: series.prefix,
          rest: raw.slice(m.index + m[0].length),
          at: m.index,
        };
      }
      break; // prva samostalna pojava ove serije je merodavna
    }
  }

  return best ? { prefix: best.prefix, rest: best.rest } : null;
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

  // (1a) OZNAKA SERIJE — kandidati se izvode iz OSTATKA, pa im se prefiks vraća
  //      (v. `SERIES`). Nijedan kandidat bez prefiksa ne izlazi odavde:
  //      `A-7/26` i `AVANS 7/26` (avans) ne smeju da ponude `7/26` (faktura istog kupca).
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
