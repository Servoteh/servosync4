import { DOCUMENT_SERIES } from "../sales/numbering.service";

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
 *   (4) broj/godina obrazac ....................... segment iza kog stoji godina →
 *        „broj/godina" (kosa crta) i goli „broj"
 *   (5) varijante bez vodećih nula ................ „00123" → „123", ALI nikad do
 *        oblika NAŠEG novog broja (v. „POTPIS STAROG BROJA" niže)
 *   (6) PNB koji je DATUM .......................... samo sirov trim, bez ijednog
 *        izvedenog kandidata (v. `isDateTriplet` — `12-08-26` ne sme da dâ `8/26`)
 *   (7) PNB sa OZNAKOM SERIJE (`A-7/26`, `AVANS BR 7/26`, `XYZ-7/26`) . svi izvedeni
 *        kandidati NOSE prefiks (v. `SERIES` — `A-7/26` ne sme da dâ `7/26`); oznaka se
 *        traži BILO GDE u PNB-u i prepoznaje po ZNAČENJU (slovo serije, šifra vrste ili
 *        reč kojom je platilac imenuje), a vezuje broj koji joj neposredno sledi
 *
 * MODEL: `BankStatementLine` NEMA kolonu za model (provereno u schema.prisma), pa
 * se model NE persistuje — prosleđuje se opciono kroz `parseReference(raw, model)`
 * (koristi ga preview/parse tok). U matchovanju (persistovana stavka) model nije
 * dostupan, pa se model-97 skidanje oslanja na INLINE detekciju „97"+KK iz sirovog
 * PNB-a (drugi trigger u tački 2) — persistencijski nezavisan put.
 *
 * ⚠️ DUŽINA ULAZA: FX kolona `PozivNaBroj(169,20)` nosi **najviše 20 znakova**, a
 * `Opis(100,35)` se danas uopšte ne parsira (`bank-statement-parser.service.ts`).
 * Zato su primeri u ovom fajlu i u testovima namerno kratki: „po avansu A-1/26" (16)
 * staje, „uplata po avansu A-1/26" (24) NE staje. Reč-alijasi (`AVANS`, `PREDRAČUN`…)
 * su ipak potrebni jer 20 znakova prima i `AVANS BR 1/26` i `PREDRACUN 12/26`, a u
 * budućem parsiranju `Opis`-a postaju glavni put (v. PREOSTALE_FAZE.md, otvoreno S7).
 */

/** Rezultat parsiranja PNB-a: uređeni kandidati broja dokumenta (prvi = egzaktan). */
export interface ParsedReference {
  candidates: string[];
}

/** Godina u opsegu 19xx/20xx (segment iza broja kao godina → broj/godina obrazac). */
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
 * OBLIK NAŠEG NOVOG BROJA (O-F1): redni broj BEZ vodećih nula, kosa crta, TAČNO dve
 * cifre godine. Koristi se kao brana u koraku (5) — v. „POTPIS STAROG BROJA".
 * Prefiks serije se ovde ne gleda: u seriji se kandidati grade nad OSTATKOM PNB-a, pa
 * je provera nad golim delom ista provera (`A-` + `1/26` = `A-1/26`).
 */
const OUR_NUMBER_RE = /^[1-9]\d*\/\d{2}$/;

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
 * ⚠️ IZVOR PREFIKSA JE `DOCUMENT_SERIES` IZ NUMERACIJE — uvozi se, ne prepisuje
 * (nalaz V3, 02.08.2026). Ranije je ovde stajao ručni spisak od četiri prefiksa uz
 * obrazloženje „numeracija zna šta UPISUJE, parser zna kako se to ZOVE, to su dva
 * spiska". Dva spiska su se i razišla u trenutku kad je numeracija dobila
 * FALLBACK prefiks za neupisanu vrstu (`seriesPrefixFor` → `XYZ-`): broj `XYZ-1/26`
 * je postojao, a parser ga nije poznavao i od njega je pravio goli `1/26` — dakle
 * tačno onaj kvar zbog kog serije uopšte postoje.
 *
 * Sada se iz registra izvodi PREFIKS (jedina stvar koja mora biti identična), a
 * ovde ostaje samo ono što numeracija ne zna: kako kupac tu seriju ZOVE. Vrsta koja
 * nema svoj red u `SERIES_ALIASES` i dalje se prepoznaje — po sopstvenoj šifri iz
 * prefiksa (`REV-` → oznaka „REV").
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
 * numeracije (`A-`), tako da i `A7/26` i `a 7/26` i `AVANS BR 7/26` pogode upisani
 * broj `A-7/26`.
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
 *     `AVANS 1/26`     → ["AVANS 1/26","AVANS","AVANS1","AVANS126","1","126","26","1/26"]
 *     `AVR 1/26`       → ["AVR 1/26","AVR","AVR1","AVR126","1","126","26","1/26"]
 *     `A. 1/26`        → ["A. 1/26","A.","A.1","A.126","1","126","26","1/26"]
 *     `A) 1/26`        → ["A) 1/26","A","A1","A126","1","126","26","1/26"]
 *     `po avansu A-1/26` → [… ,"1","126","26","1/26"]
 * Svaki od njih završava golim `1/26` — brojem KONAČNE FAKTURE istog kupca. Zato se
 * oznaka od tada traži BILO GDE u PNB-u i prepoznaje po ZNAČENJU (v. `SERIES_ALIASES`).
 */
interface SeriesMarker {
  /** Kanonski prefiks — tačno onako kako ga numeracija upisuje u broj (`A-`). */
  prefix: string;
  /**
   * Regex-alternative kojima platilac imenuje seriju (case-insensitive, bez zagrada).
   * Redosled nije bitan za tačnost (regex se vraća na dužu alternativu kad kraća ne
   * uspe), ali JESTE za čitljivost: prvo reč, pa šifra, pa golo slovo.
   */
  aliases: readonly string[];
}

/**
 * Slova (ASCII + naša latinična + ĆIRILICA) — koriste se i za „reč" i za granicu reči.
 * Ćirilica je dodata jer je `АВАНС 1/26` u srpskoj praksi isto tako čest zapis kao
 * latinični, a bez nje je oznaka serije bila nevidljiva → goli `1/26` (nalaz V2).
 */
const LETTERS = "A-Za-zČĆŽŠĐčćžšđ\\u0400-\\u04FF";

/** Razdelnik: do tri NE-slovna, NE-cifrena znaka (`-`, ` `, `.`, `)`, `/`…). */
const SEP = `[^${LETTERS}0-9]{0,3}`;

/**
 * REČ-POPUNA između oznake serije i broja: „br", „broj" i ćirilični parnjaci.
 * ─────────────────────────────────────────────────────────────────────────────
 * Nalaz V2 (02.08.2026): razdelnik je primao samo NE-slovne znakove, pa je oznaka
 * padala čim se ubaci najčešći srpski oblik. IZMERENO na tadašnjem kodu — svi su
 * davali GOLI broj (dakle broj tuđe fakture):
 *     `AVANS BR 1/26` · `PREDRACUN BR. 12/26` · `PONUDA BR. 5/26` · `REVERS BR 8/26`
 * „BR"/„BROJ" ne menja NA KOJI dokument se broj odnosi, pa sme da stoji između
 * oznake i broja. Reč koja bi to promenila (`AVANS PO FAKTURI 1/26` → broj pripada
 * FAKTURI) namerno NIJE u ovom spisku i dalje raskida vezu.
 */
const FILLER = `(?:BROJ|BR|БРОЈ|БР)`;

/**
 * Razmak između oznake serije i broja: razdelnik, opciono „br/broj", pa opet razdelnik.
 * Pokriva `A-1/26`, `A 1/26`, `A. 1/26`, `A) 1/26`, `A/ 1/26`, `AVANS BR 1/26`,
 * `PREDRACUN BR. 12/26`. Više od tri znaka razdelnika nije razdelnik nego drugi
 * podatak, pa se oznaka tada ne vezuje za taj broj.
 */
const SERIES_GAP = `${SEP}(?:${FILLER}${SEP})?`;

/**
 * BROJ KOJI OZNAKA SME DA VEŽE — mora ličiti na broj dokumenta.
 * ─────────────────────────────────────────────────────────────────────────────
 * Nalaz S5 (02.08.2026): oznaka je vezivala PRVU cifru iza sebe, ma šta ona bila, pa
 * je procenat/rata pojeo ostatak PNB-a. IZMERENO na tadašnjem kodu — tačan broj
 * fakture je NESTAJAO iz kandidata:
 *     `AVANS 50% 657/25` · `AVANS 1. RATA 657/25` · `AVANS 30% PO FAKTURI 657/25`
 * U sva tri slučaja broj `657/25` pripada FAKTURI, a `50` / `1` su iznos i redni broj
 * rate. Kad oznaka ne veže ništa, PNB se parsira normalno i `657/25` preživi.
 *
 * Odbija se: cifra iza koje sledi `%` (procenat) i cifra iza koje sledi tačka pa reč
 * (redni broj — „1. rata"). Datum se ne odbija ovde nego u `isDateTriplet`.
 */
const BIND_AHEAD = `(?=\\d)(?!\\d+\\s*%)(?!\\d+\\.\\s*[${LETTERS}])`;

/**
 * REČI KOJIMA PLATILAC IMENUJE SERIJU, po šifri vrste iz `DOCUMENT_SERIES`.
 * Prefiks se NE ponavlja ovde — dolazi iz registra numeracije (v. `SERIES`).
 */
const SERIES_ALIASES: ReadonlyMap<string, readonly string[]> = new Map([
  // AVR — avansni račun (O-F6). Sve reči koje počinju sa „avans" znače isto
  // (avansu, avansa, avansni…), pa ide džoker; „avansni RAČUN" je isti dokument, pa
  // se i ta druga reč sme progutati. `AVR` i golo `A` su tačni oblici.
  [
    "AVR",
    [
      `AVANS[${LETTERS}]*(?:${SEP}RA[CČ]UN[${LETTERS}]*)?`,
      `АВАНС[${LETTERS}]*(?:${SEP}РАЧУН[${LETTERS}]*)?`,
      "AVR",
      "АВР",
      "A",
    ],
  ],
  // PROF — predračun (O-F7). Reči su NABROJANE, ne „PRO*"/„PROF*": „PROFIT 12/26" nije
  // predračun, a lažna oznaka bi pojela broj fakture. „PROFORMA" je dodata jer je u
  // praksi češća od „profakture" (nalaz V2).
  [
    "PROF",
    [
      `PREDRA[CČ]UN[${LETTERS}]*`,
      `ПРЕДРАЧУН[${LETTERS}]*`,
      `PROFAKTUR[${LETTERS}]*`,
      `ПРОФАКТУР[${LETTERS}]*`,
      `PROFORM[${LETTERS}]*`,
      `ПРОФОРМ[${LETTERS}]*`,
      "PROF",
    ],
  ],
  // PON — ponuda (O-F7). Isti razlog za nabrajanje: „PONOVO 12/26" ne sme da bude oznaka.
  ["PON", [`PONUD[${LETTERS}]*`, `ПОНУД[${LETTERS}]*`, "PON"]],
  // REV — revers (O-F7). „REVIZIJA" nije revers, pa `REV[a-z]*` ne dolazi u obzir.
  ["REV", [`REVERS[${LETTERS}]*`, `РЕВЕРС[${LETTERS}]*`, "REV"]],
]);

/** Regex-escape (prefiksi iz registra su slova + `-`, ali ne oslanjamo se na to). */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * SERIJE — izvedene IZ REGISTRA NUMERACIJE (`DOCUMENT_SERIES`), pa dopunjene rečima.
 * Vrsta bez reč-alijasa dobija bar sopstvenu šifru iz prefiksa, tako da nova serija
 * upisana samo u numeraciju NIKAD ne ostane bez čitača.
 */
const SERIES: readonly SeriesMarker[] = [...DOCUMENT_SERIES.entries()]
  .filter(([, prefix]) => prefix !== "")
  .map(([documentType, prefix]) => ({
    prefix,
    aliases: SERIES_ALIASES.get(documentType) ?? [
      escapeRegex(prefix.replace(/-+$/, "")),
    ],
  }));

/** Prefiksi serija, redosledom iz registra (izvor za branu sinhronosti sa numeracijom). */
export const SERIES_PREFIXES: readonly string[] = SERIES.map((s) => s.prefix);

/** Da li je znak slovo (granica reči — v. `matchSeriesPrefix`). */
const LETTER_RE = new RegExp(`[${LETTERS}]`);

/**
 * NEPOZNATA ŠIFRA VRSTE PRIKAČENA CRTICOM NA BROJ — `AR-00001/2025`, `XYZ-1/26`.
 * ─────────────────────────────────────────────────────────────────────────────
 * Dva izvora, isti oblik:
 *   • BigBit auto-broj je `Left(VrstaDok,3) & "-" & zeroPad(N) & "/" & GGGG`
 *     (`BIGBIT_IZLAZNE_FAKTURE_I_AVANSI.md:123`) — `AR-00001/2025`, `PRO-00002/2025`,
 *     `IFG-00025/2025`. Ti dokumenti ŽIVE u produkcijskoj glavnoj knjizi i kupci ih
 *     plaćaju paralelno sa 4.0 do cutovera (april 2027).
 *   • Naša numeracija za vrstu koja nije upisana u registar daje isti oblik
 *     (`seriesPrefixFor` → `XYZ-`), i baš zato `seriesPrefixFor` dozvoljava samo
 *     šifru od 2–5 slova — tačno ono što ovaj obrazac ume da pročita (nalaz V3/V4).
 *
 * IZMERENO pre ove izmene: `AR-00001/2025` → kandidat `1/25` (naša faktura),
 * `PRO-00002/2025` → `2/25`, `IFG-00025/2025` → `25/25`, `XYZ-1/26` → `1/26`.
 * Sa ovim pravilom svi kandidati nose šifru (`AR-1/2025`, `XYZ-1/26`) i mogu da
 * pogode SAMO dokument iste serije.
 *
 * CRTICA JE OBAVEZNA i šifra sme biti najviše 5 slova — bez toga bi `racun657/25`
 * ili `faktura657/25` bili pročitani kao serija i pojeli legitiman broj fakture.
 * Reči koje se u PNB-u realno javljaju uz crticu, a NISU šifra vrste, stoje u
 * `NOT_A_SERIES_CODE`.
 */
const GENERIC_CODE_MAX_LEN = 5;
const NOT_A_SERIES_CODE = new Set([
  "BR",
  "BROJ",
  "RN",
  "RACUN",
  "RAČUN",
  "FAKT",
  "PO",
  "ZA",
  "OD",
  "NA",
  "UZ",
  "DUG",
  "IZNOS",
  "БР",
  "БРОЈ",
  "РАЧУН",
  "ПО",
  "ЗА",
  "ОД",
  "НА",
]);

/** Oznaka serije nađena u PNB-u. */
interface MarkerHit {
  /** Kanonski prefiks iz numeracije (`A-`, `PROF-`, `XYZ-`). */
  prefix: string;
  /** Pozicija same oznake u PNB-u. */
  at: number;
  /** Prvi znak IZA oznake i razdelnika — odatle počinje broj koji oznaka veže. */
  bodyStart: number;
  /** Poznata serija iz registra (pobeđuje generičku šifru na istom mestu). */
  known: boolean;
}

/**
 * Da li je pojava oznake na poziciji `at` SAMOSTALNA i sme da veže broj?
 *
 * (1) Znak ispred ne sme biti SLOVO. Bez toga bi „fakturA 657/25" bilo pročitano kao
 *     serija (poslednje „a" + razmak + cifra) i broj fakture bi nestao iz kandidata —
 *     kvar gori od onog koji se popravlja.
 *
 * (2) Ako je znak ispred CIFRA, razdelnik do broja mora postojati. Cifra ispred je
 *     dozvoljena zbog modela/kontrolnog broja (`97A-7/26`), ali bez ovog uslova je
 *     slovo usred cifara jelo broj — IZMERENO (nalaz N2): `123A456` → samo `A-456`,
 *     `00A12345` → samo `A-12345`. Tu „A" nije serija nego deo šifre/šuma.
 */
function markerIsStandalone(raw: string, at: number, gapLen: number): boolean {
  if (at === 0) return true;
  const before = raw[at - 1];
  if (LETTER_RE.test(before)) return false;
  if (/\d/.test(before) && gapLen === 0) return false;
  return true;
}

/**
 * Nađi SVE oznake serije u PNB-u, po redu pojavljivanja i bez preklapanja.
 *
 * Uslovi su brane od lažne oznake, i svi su izmereni, ne pretpostavljeni:
 *   • oznaka je SAMOSTALNA (v. `markerIsStandalone`);
 *   • oznaka VEZUJE BROJ KOJI JOJ NEPOSREDNO SLEDI (razdelnik, opciono „br", pa CIFRA
 *     koja liči na broj dokumenta — v. `BIND_AHEAD`). Zato `ABC123` nije serija „A" sa
 *     ostatkom `BC123`, a `AVANS PO FAKTURI 1/26` ostaje faktura — tu broj pripada
 *     fakturi, pa goli `1/26` mora da preživi.
 *
 * ZAŠTO SVE, A NE SAMO PRVA (nalaz S5, 02.08.2026): PNB ume da nosi DVA dokumenta.
 * Dok se uzimala samo prva oznaka, ostatak PNB-a je pripadao njoj, pa je
 * `PROF-1/26 PROF-2/26` davao besmislen `PROF-PROF-2/26` i nijedan od dva stvarna
 * broja. Sada svaka oznaka drži svoj ODSEČAK — od svog broja do sledeće oznake.
 *
 * Na istom mestu POZNATA serija pobeđuje generičku šifru (`AVR-00001/2026` je naš
 * avans `A-`, a ne nepoznata serija „AVR-").
 *
 * Ono što je ISPRED prve oznake se ODBACUJE (model, kontrolni broj, reči). Posledica je
 * ista kao kod `A 657/25`: ako neko ispred oznake stavi pravi broj dokumenta, taj broj
 * neće biti kandidat i uparivanje pada na fallback po iznosu. To je jeftinije od rizika
 * da uplata na avans sedne na fakturu.
 */
function findSeriesMarkers(raw: string): MarkerHit[] {
  const hits: MarkerHit[] = [];

  for (const series of SERIES) {
    const re = new RegExp(
      `(${series.aliases.join("|")})${SERIES_GAP}${BIND_AHEAD}`,
      "gi",
    );
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) {
      const gapLen = m[0].length - m[1].length;
      if (!markerIsStandalone(raw, m.index, gapLen)) continue;
      hits.push({
        prefix: series.prefix,
        at: m.index,
        bodyStart: m.index + m[0].length,
        known: true,
      });
    }
  }

  // Generička šifra vrste (`AR-`, `PRO-`, `IFG-`, `XYZ-`) — v. `GENERIC_CODE_MAX_LEN`.
  const genericRe = new RegExp(
    `([${LETTERS}]{2,${GENERIC_CODE_MAX_LEN}})-${BIND_AHEAD}`,
    "gi",
  );
  let g: RegExpExecArray | null;
  while ((g = genericRe.exec(raw)) !== null) {
    if (!markerIsStandalone(raw, g.index, 1)) continue;
    const code = g[1].toUpperCase();
    if (NOT_A_SERIES_CODE.has(code)) continue;
    hits.push({
      prefix: `${code}-`,
      at: g.index,
      bodyStart: g.index + g[0].length,
      known: false,
    });
  }

  // Po poziciji; na istom mestu prvo poznata serija. Preklapanja se odbacuju — oznaka
  // koja počinje unutar tela prethodne nije nova oznaka nego deo njenog broja.
  hits.sort((a, b) =>
    a.at !== b.at ? a.at - b.at : Number(b.known) - Number(a.known),
  );

  const out: MarkerHit[] = [];
  let coveredTo = -1;
  for (const hit of hits) {
    if (hit.at < coveredTo) continue;
    out.push(hit);
    coveredTo = hit.bodyStart;
  }
  return out;
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
  return collect(raw, model, false);
}

/**
 * @param owned `true` kad se parsira OSTATAK iza oznake serije — svaki kandidat odatle
 *              dobija prefiks, pa sme šire da traži „broj/godina" (v. korak 4).
 */
function collect(
  raw: string | null | undefined,
  model: string | null | undefined,
  owned: boolean,
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

  // (1a) OZNAKA SERIJE — kandidati se izvode iz ODSEČKA koji oznaka drži (od njenog
  //      broja do sledeće oznake), pa im se prefiks vraća (v. `SERIES`). Nijedan
  //      kandidat bez prefiksa ne izlazi odavde: `A-7/26` i `AVANS 7/26` (avans) ne
  //      smeju da ponude `7/26` (faktura istog kupca).
  //
  //      Traži se samo nad sirovim PNB-om (`owned === false`): odsečak je već OGRANIČEN
  //      sledećom oznakom, pa bi ponovno traženje unutar njega samo udvajalo prefiks —
  //      izmereno, `PROF-1/26 PROF-2/26` je davao `PROF-PROF-2/26`.
  if (!owned) {
    const markers = findSeriesMarkers(rawTrim);
    if (markers.length > 0) {
      for (let k = 0; k < markers.length; k++) {
        const end =
          k + 1 < markers.length ? markers[k + 1].at : rawTrim.length;
        const body = rawTrim.slice(markers[k].bodyStart, end);
        for (const inner of collect(body, model, true).candidates) {
          push(`${markers[k].prefix}${inner}`);
        }
      }
      return { candidates: out };
    }
  }

  const segments = rawTrim.split(SEPARATORS_RE).filter((s) => s.length > 0);

  // (1b) DATUM UMESTO BROJA — stani na egzaktnom kandidatu (v. `isDateTriplet`).
  //      Ceo PNB je datum (`12-08-26`, `12.08.2026`, `2026-08-12`): svaki izveden
  //      kandidat odavde bio bi izmišljen broj fakture — uključujući `08/26` i `8/26`
  //      koje je korak (4) pravio od poslednja dva segmenta.
  if (
    segments.length === 3 &&
    isDateTriplet(segments[0], segments[1], segments[2])
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
  if (segments.length > 1) {
    const n = Math.min(segments.length, MAX_SEGMENTS);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j <= n; j++) {
        push(segments.slice(i, j).join(""));
      }
    }
  }

  // (4) BROJ/GODINA — segment iza kog stoji godina → „broj/godina" i goli „broj".
  //     (Goli „broj" je najčešće već dodat u koraku 3 kao segment, pa je `push`
  //     ovde no-op zbog dedupa — ostaje radi slučajeva kada nije.)
  //
  //     KOLIKO PAROVA SE GLEDA:
  //       • van serije — samo POSLEDNJI par. Šire traženje bi nad golim PNB-om
  //         izmišljalo brojeve: `97 12 657 25` bi pored `657/25` dalo i `97/12`, a to
  //         je uredan broj dokumenta iz 2012. godine.
  //       • u seriji (`owned`) — SVI susedni parovi. Tu svaki kandidat nosi prefiks, pa
  //         može da pogodi samo dokument iste serije; bez toga se gubio TAČAN broj kad
  //         PNB nosi dva dokumenta. IZMERENO (nalaz S5): `A-1/26 i 657/25` nije davao
  //         NIJEDAN od ta dva, `PROF-1/26 PROF-2/26` takođe nijedan.
  //
  //     DATUM NA REPU: kad tri segmenta oko para čine datum (npr. `97 12-08-26` —
  //     model ispred datuma), rekonstrukcija „broj/godina" bi opet izmislila `08/26`.
  //     Korak (1b) hvata samo PNB koji je CEO datum, pa je ova provera njegov parnjak.
  const pairInDate = (i: number): boolean =>
    (i >= 1 && isDateTriplet(segments[i - 1], segments[i], segments[i + 1])) ||
    (i + 2 < segments.length &&
      isDateTriplet(segments[i], segments[i + 1], segments[i + 2]));

  if (segments.length >= 2) {
    const first = owned ? 0 : segments.length - 2;
    for (let i = first; i + 1 < segments.length; i++) {
      if (pairInDate(i)) continue;
      const num = segments[i];
      const last = segments[i + 1];
      if (YEAR_RE.test(last)) {
        push(`${num}/${last}`); // „123/2026" — stari (zatečeni) oblik broja
        push(`${num}/${last.slice(2)}`); // „123/26" — novi oblik (O-F1), isti dokument
        push(num);
      } else if (YEAR2_RE.test(last)) {
        push(`${num}/${last}`); // „657-25" → „657/25"
        push(num);
      }
    }
  }

  // (5) VARIJANTE BEZ VODEĆIH NULA — za svakog dosad skupljenog numeričkog kandidata.
  //
  //     🔴 POTPIS STAROG BROJA (nalaz V1, 02.08.2026)
  //     ─────────────────────────────────────────────────────────────────────────
  //     Naša numeracija (O-F1) NIKAD ne izdaje broj sa vodećom nulom — `12/26`, ne
  //     `0012/26`. Vodeće nule su zato potpis TUĐEG, starog broja, a BigBit i 4.0 rade
  //     paralelno do cutovera (april 2027) i kupci plaćaju i jedne i druge dokumente.
  //     Skidanje nula je taj stari broj prevodilo u naš — IZMERENO nad stvarnim
  //     BigBit brojevima (`BIGBIT_IZLAZNE_FAKTURE_I_AVANSI.md:113-129,180-186`):
  //
  //         `0012-26`, `0016-26`, `0017-26` (AVR 2026)  → `12/26`   = naša faktura
  //         `AVR-00001/2026`                            → `A-1/26`  = naš avans
  //         `AR-00001/2025`                             → `1/25`    = naša faktura
  //         `PRO-00002/2025`                            → `2/25`    = naša faktura
  //         `IFG-00025/2025`                            → `25/25`   = naša faktura
  //         `PON-00285/2026`                            → `PON-285/26` = naša ponuda
  //
  //     PRAVILO: skinuta varijanta se odbacuje ako je u obliku NAŠEG novog broja
  //     (`OUR_NUMBER_RE`). Sve ostalo (`00123` → `123`, `9732001234` → `1234`) prolazi
  //     kao i pre — tamo nula dolazi iz banke koja pun-i polje, a rezultat ne oponaša
  //     nijedan naš broj.
  //
  //     CENA: ako kupac NAŠ broj `12/26` prekuca sa nulama (`0012-26`), uparivanje po
  //     broju promaši i uplata padne na fallback po iznosu. To je isti, svesno biran
  //     kompromis kao kod datumskog PNB-a: pošten promašaj je jeftiniji od tihog
  //     zatvaranja pogrešne stavke — a ovde je promašaj i verovatniji da bude tačan,
  //     jer `0012-26` JESTE stvaran BigBit broj iz 2026.
  for (const c of [...out]) {
    if (!/^0+\d/.test(c)) continue;
    const stripped = c.replace(/^0+/, "");
    if (OUR_NUMBER_RE.test(stripped)) continue;
    push(stripped);
  }

  return { candidates: out };
}
