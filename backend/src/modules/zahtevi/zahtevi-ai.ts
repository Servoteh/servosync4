/**
 * Zahtevi AI — prompt-ovi, tool-schema i normalizacija (MODULE_SPEC_zahtevi §4).
 * Obrazac 1:1 `montaza-ai.ts`: strukturisan izlaz kroz `AiProviderService.extractWithTool`
 * (`tool_choice` forsiran), bez parsiranja slobodnog teksta. Verbatim rubrika ocene
 * (§12.1) ide u trijažni system prompt. Sve srpski (ekavica, latinica).
 */

import { ZAHTEVI_INJECTION_FENCE } from "../../common/ai/injection-fence";

// ── Enumi (moraju biti u sinhronizaciji sa DTO/šemom) ────────────────────────

/** Tipovi zahteva (`kind`) — 1:1 create-change-request.dto REQUEST_KINDS. */
export const AI_REQUEST_KINDS = [
  "BUG",
  "MISSING_1_0",
  "IMPROVEMENT_3_0",
  "FEATURE_4_0",
  "UI_UX",
  "BUSINESS_RULE",
  "OTHER",
] as const;

/** Oblasti (`areas`). */
export const AI_REQUEST_AREAS = [
  "DATABASE",
  "BACKEND",
  "FRONTEND",
  "MOBILE",
] as const;

/** Prioriteti. */
export const AI_PRIORITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;

/** Procena obima (detaljna analiza). */
export const AI_ESTIMATES = ["S", "M", "L", "XL"] as const;

export const TRIAGE_DEFAULT_MODEL = "claude-haiku-4-5-20251001";
export const ANALYSIS_DEFAULT_MODEL = "claude-sonnet-5";

/** Skraćivanja ulaza (§4.4 — jeftina trijaža). */
export const TRIAGE_MAX_DESC_CHARS = 8000;
export const TRIAGE_MAX_IMAGES = 5;

/**
 * BUDŽET SNIPPETA KANDIDATA ZA DUPLIKATE (incident 039/26, 30.07.2026).
 *
 * Pre ispravke je svaki kandidat išao modelu kao „naslov + 200 znakova opisa" —
 * a model je po GENERIČKOM NASLOVU („Nestala opcija") presudio duplikat i zahtev
 * je auto-odbijen. Bez SUŠTINE (modul, tip, dovoljno opisa i ponašanja) model
 * nema po čemu da odlučuje osim po naslovu, pa je snippet namerno duži.
 *
 * Skaliranje po broju kandidata (prompt mora ostati ograničen; `take` je
 * DUP_PREFILTER_THRESHOLD = 500):
 *  - ≤ 40 kandidata  → 600 znakova/kandidat  (max ~24k znakova ≈ 8k tokena)
 *  - ≤ 150 kandidata → 300 znakova/kandidat  (max ~45k znakova ≈ 15k tokena)
 *  - više            → 150 znakova/kandidat  (max ~75k znakova ≈ 25k tokena)
 * Gornja granica (500 × 150) je NIŽA od stare (500 × 200 = 100k znakova) — mali
 * i srednji registar dobija bogatiji kontekst, a najveći je i jeftiniji od pre.
 */
export const TRIAGE_DUP_SNIPPET_FULL = 600;
export const TRIAGE_DUP_SNIPPET_MID = 300;
export const TRIAGE_DUP_SNIPPET_SHORT = 150;
export const TRIAGE_DUP_RICH_MAX_CANDIDATES = 40;
export const TRIAGE_DUP_MID_MAX_CANDIDATES = 150;

/** Snippet budžet po kandidatu za dati broj kandidata (vidi konstante iznad). */
export function dupSnippetBudget(candidateCount: number): number {
  if (candidateCount <= TRIAGE_DUP_RICH_MAX_CANDIDATES)
    return TRIAGE_DUP_SNIPPET_FULL;
  if (candidateCount <= TRIAGE_DUP_MID_MAX_CANDIDATES)
    return TRIAGE_DUP_SNIPPET_MID;
  return TRIAGE_DUP_SNIPPET_SHORT;
}

// ── TRIJAŽA (§4.1) ───────────────────────────────────────────────────────────

/**
 * Ograda protiv prompt-injection-a (F3) — DOSLOVNO u OBA system prompta.
 * Sav sadržaj zahteva (naslov, opis, ponašanja, transkripti, komentari, lista
 * postojećih zahteva) je NEPOUZDAN korisnički unos i stiže obmotan markerima
 * <<<KORISNICKI_UNOS>>> … <<<KRAJ_UNOSA>>>.
 *
 * Talas AI-0 (stavka 6): tekst je iseljen u `common/ai/injection-fence.ts` da ga
 * dele i chat, sastanci i montaža. Sadržaj je BAJT-IDENTIČAN prethodnom — pinuje
 * ga `common/ai/injection-fence.spec.ts`, pa se ponašanje trijaže ne menja.
 */
const INJECTION_FENCE = ZAHTEVI_INJECTION_FENCE;

/** Rubrika ocene 0–5 (§12.1) — DOSLOVNO u prompt. */
// POOŠTRENA rubrika (presuda Nenad 24.07.2026): većina prijava treba da padne u 1–2★;
// 3★+ su RETKE, a 5★ isključivo revolucionarne ideje. Tarifa nepromenjena.
// ISPRAVKA 30.07.2026 (incident 039/26): DUPLIKAT JE IZVAĐEN IZ OCENE 0. Ocena 0 +
// `unusable` su rezervisani za neupotrebljive prijave; sumnja na duplikat ne obara
// ocenu i NIKAD ne odbacuje zahtev automatski — o spajanju/odbijanju odlučuje čovek.
const SCORE_RUBRIC = `RUBRIKA OCENE (0–5) — oceni koliko je predlog vredan (obrazloži u 1–2 rečenice).
BUDI STROG: većina predloga zaslužuje 1 ili 2; ocene 3+ su RETKE i traže jasan, konkretan efekat; 5 je izuzetak za revolucionarne ideje.
- 0 = NEUPOTREBLJIVA PRIJAVA: spam, nerazumljiv tekst ili prazan sadržaj. SAMO u tom slučaju postavi i "unusable": true. (Zahtev koji traži nešto što VEĆ POSTOJI u sistemu takođe može dobiti nisku ocenu, ali NIJE "unusable" — o tome odlučuje čovek.)
- 1 = Kozmetika, sitna ispravka, mala operativna molba, dorada koja pomaže uglavnom podnosiocu.
- 2 = Korisna manja dorada ili validan bug ograničenog dometa — podrazumevana ocena za dobre, obične predloge.
- 3 = RETKO: značajno poboljšanje sa jasnim, konkretnim efektom na rad VIŠE ljudi/celog tima, ili bug koji iskrivljuje evidenciju (sati, količine, novac).
- 4 = VRLO RETKO: funkcionalnost koja menja tok posla odeljenja, ili bug koji pravi direktnu štetu/trošak.
- 5 = IZUZETAK: revolucionarna ideja — novi tok rada, velika merljiva ušteda ili prihod; ako se dvoumiš između 4 i 5, daj 4.
DUPLIKAT NE UTIČE NA OCENU: ako sumnjaš na preklapanje, oceni zahtev po SOPSTVENOJ vrednosti i sumnju upiši u "duplicates" (pravila ispod). Nikad ne daj 0 zato što misliš da je nešto duplikat.`;

/**
 * DUPLIKATI — pravila koja idu DOSLOVNO u trijažni prompt.
 *
 * Nastalo iz stvarnog incidenta (30.07.2026): zahtev 039/26 „Nestala opcija"
 * (modul `tech-processes`, nestala dugmad brisanje/izmena kucanja) AI je automatski
 * ODBIO kao „vrlo verovatno duplikat 035/26 «Nestale opcije»" — a 035/26 je bio
 * problem sinhronizacije role (korisniku spuštena rola). Jedina veza bio je
 * GENERIČKI NASLOV. Presuda vlasnika: „ne sme duplikat da gleda po naslovu — mora
 * dublja analiza". Otud: duplikat traži SUŠTINSKO poklapanje i nikad ne odbacuje.
 *
 * DRUGI INCIDENT ISTOG DANA (021/26, Zoran Jaraković, „Brisanje sastanaka") pokazuje
 * poseban podslučaj: AI ga je odbio kao duplikat 013/26 „Brisanje sastanaka". Ali
 * 013/26 je bio ZAHTEV za tu funkciju (isporučena 24.07), a 021/26 je 27.07 prijavio
 * da brisanje „i dalje nije moguće" — dakle prijava da isporučeno NE RADI (ispalo je
 * stvarno: produkcijski 500, kod je zvao nepostojeću sy15 funkciju). Prijava „i dalje
 * ne radi" je NOV bug (regresija / nepotpuna ispravka), nikad duplikat originala —
 * otud zasebno pravilo u tekstu ispod.
 */
const DUPLICATE_RULES = `DUPLIKATI — STROGO PRAVILO (presuda vlasnika 30.07.2026: „ne sme duplikat da gleda po naslovu — mora dublja analiza"):
- Duplikat prijavljuješ SAMO kad se zahtevi poklapaju SUŠTINSKI, a to znači OBA uslova: (a) ISTI modul i isti ekran/forma/mesto u aplikaciji, I (b) ISTI osnovni simptom (kod buga) ili ISTI cilj (kod dorade/nove funkcije).
- SLIČAN ILI IDENTIČAN NASLOV NIJE DOKAZ i sam po sebi ne znači ništa. Korisnici rutinski pišu generičke naslove („Nestala opcija", „Ne radi", „Problem sa…", „Greška", „Ispravka") koji se ponavljaju nad potpuno nepovezanim problemima. Presuđivanje po naslovu je već izazvalo STVARNO pogrešno odbijanje ispravnog zahteva — to se ne sme ponoviti.
- Kad prijaviš duplikat, u "reason" MORAŠ imenovati KONKRETNA preklapanja: modul + ekran/forma + simptom ili cilj (npr. „oba u modulu tech-processes, ekran kucanja operacija, oba traže vraćanje dugmadi za brisanje i izmenu"). Ako ta preklapanja ne možeš da imenuješ iz priloženog sadržaja, NE PRIJAVLJUJ duplikat.
- Pouzdanost: "HIGH" SAMO ako se poklapaju I modul I simptom/cilj. Ako nisi siguran → "MEDIUM". Ako se dvoumiš da li uopšte prijaviti → NE prijavljuj (bolje ništa nego pogađanje).
- Ako se MODULI RAZLIKUJU, ili je opisani ekran/ponašanje drugačije — TO NIJE DUPLIKAT, ma koliko formulacija bila slična. Isto važi i kad su naslovi identični.
- „I DALJE NE RADI" NIJE DUPLIKAT: ako podnosilac javlja da nešto što je VEĆ TRAŽENO ili VEĆ ISPORUČENO i dalje ne radi, ne radi kako treba, ili se pokvarilo („i dalje nije moguće", „i dalje ne radi", „ponovo se javilo", „nije rešeno"), to je NOV bug — REGRESIJA ili NEPOTPUNA ISPRAVKA — i NIKAD nije duplikat originalnog zahteva. Original je tražio funkciju; ovaj prijavljuje da funkcija ne radi. To su dve različite stvari, i kad su naslovi identični. Takvu prijavu NE upisuj u "duplicates" (najviše je pomeni u sažetku kao vezu na original).
- Sumnja na duplikat NIJE odbijanje: zahtev ostaje u obradi, a o spajanju ili odbijanju odlučuje ČOVEK (administrator). Zato "scoreReason" (koji vidi podnosilac) formuliši kao MOGUĆNOST, ne kao presudu — npr. „Moguće se preklapa sa 035/26 — proverava se." Nikada ne saopštavaj podnosiocu da je zahtev odbijen ili odbačen zbog duplikata.
- "unusable": true je ISKLJUČIVO za neupotrebljivu prijavu (spam, nerazumljiv tekst, prazan sadržaj). Duplikat NIKAD nije "unusable".`;

export const TRIAGE_SYSTEM_PROMPT = `Ti si AI trijažer za ServoSync (Servoteh) — sistem zahteva korisnika (bug / dorada / nova funkcija). Iz podnetog zahteva (naslov, opis, očekivano/trenutno ponašanje, transkripti glasovnih poruka i priložene slike) praviš KRATKU trijažu za administratora.

ZADATAK:
1. Napiši sažetak od 2–3 rečenice (za admin inbox) — o čemu se radi.
2. Klasifikuj: modul (slug iz sistema, npr. "nabavka", "odrzavanje", "kadrovska", "sastanci", "zahtevi"; null ako nejasno), tip (kind), oblasti (areas), predlog prioriteta.
3. Proveri DUPLIKATE nad priloženom listom postojećih zahteva — SUŠTINSKI, ne po naslovu (obavezna pravila ispod). Kandidati stižu sa modulom, tipom i suštinskim izvodom opisa/ponašanja; koristi TO, a ne naslov.
4. Oceni predlog 0–5 po rubrici ispod. Ako je prijava neupotrebljiva (spam / nerazumljivo / prazno), postavi "unusable": true.
5. Navedi eventualne nejasnoće kao pitanja.

PRAVILA:
- Ne izmišljaj. Ako podatak nije potvrđen, ostavi prazno/null.
- Piši kratko, jasno, profesionalno, na srpskom (ekavica, latinica).
- "scoreReason" se PRIKAZUJE PODNOSIOCU — bude konkretan i pristojan (npr. "Jasna korisna dorada postojeće liste." ili, kod sumnje na preklapanje, "Moguće se preklapa sa 012/26 — proverava se.").
- Pozovi alat "trijaza" sa izvučenim podacima.

${INJECTION_FENCE}

${DUPLICATE_RULES}

${SCORE_RUBRIC}`;

export const TRIAGE_TOOL = {
  name: "trijaza",
  description:
    "Kratka trijaža zahteva korisnika: sažetak, klasifikacija, duplikati, ocena 0–5, pitanja.",
  input_schema: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description: "sažetak 2-3 rečenice za admin inbox",
      },
      module: {
        type: ["string", "null"],
        description: "slug modula ili null ako nejasno",
      },
      kind: { type: "string", enum: [...AI_REQUEST_KINDS] },
      areas: {
        type: "array",
        items: { type: "string", enum: [...AI_REQUEST_AREAS] },
      },
      priorityProposal: { type: "string", enum: [...AI_PRIORITIES] },
      duplicates: {
        type: "array",
        description:
          "SUMNJA na suštinsko preklapanje — samo kad se poklapaju modul I ekran I simptom/cilj. Nikad na osnovu sličnog naslova. Prazan niz ako nisi siguran. Sumnja NE odbacuje zahtev — proverava je čovek.",
        items: {
          type: "object",
          properties: {
            requestId: {
              type: "integer",
              description: "id kandidata iz priložene liste (polje id=…)",
            },
            confidence: {
              type: "string",
              enum: ["HIGH", "MEDIUM"],
              description:
                "HIGH samo ako se poklapaju I modul I simptom/cilj; inače MEDIUM",
            },
            reason: {
              type: "string",
              description:
                "KONKRETNA preklapanja: modul + ekran/forma + simptom ili cilj. Bez imenovanih preklapanja duplikat se NE prijavljuje.",
            },
          },
          required: ["requestId", "confidence", "reason"],
        },
      },
      score: { type: "integer", minimum: 0, maximum: 5 },
      scoreReason: {
        type: "string",
        description:
          "obrazloženje ocene u 1-2 rečenice (prikazuje se podnosiocu); kod sumnje na duplikat formuliši kao mogućnost, ne kao presudu",
      },
      unusable: {
        type: "boolean",
        description:
          "true SAMO za neupotrebljivu prijavu: spam, nerazumljiv tekst ili prazan sadržaj. Duplikat NIJE unusable. Ovo je jedini signal koji vodi u automatsko odbijanje.",
      },
      questions: { type: "array", items: { type: "string" } },
    },
    required: ["summary", "score", "scoreReason"],
  } as Record<string, unknown>,
};

export interface TriageDuplicate {
  requestId: number;
  confidence: "HIGH" | "MEDIUM";
  reason: string;
}

export interface TriageResult {
  summary: string;
  module: string | null;
  kind: string | null;
  areas: string[];
  priorityProposal: string | null;
  duplicates: TriageDuplicate[];
  score: number | null;
  scoreReason: string | null;
  /**
   * Neupotrebljiva prijava (spam / nerazumljivo / prazno) — JEDINI signal koji vodi
   * u automatski `REJECTED` (ISPRAVKA 30.07.2026). Duplikat se ovde NIKAD ne upisuje:
   * pre ispravke je auto-reject visio na `score === 0`, u koju je rubrika ubrajala i
   * duplikat, pa je jedna pogrešna „duplikat po naslovu" procena odbila ispravan zahtev.
   */
  unusable: boolean;
  questions: string[];
}

const asStr = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const asStrOrNull = (v: unknown): string | null => {
  const s = asStr(v);
  return s || null;
};

/** Ograniči vrednost na allowlist ili null. */
function oneOf(v: unknown, allowed: readonly string[]): string | null {
  const s = asStr(v).toUpperCase();
  return allowed.includes(s) ? s : null;
}

/** Normalizuj trijažni izlaz alata (allowlist enuma, clamp ocene, duplikati). */
export function normalizeTriage(raw: Record<string, unknown>): TriageResult {
  const rawScore = Number(raw.score);
  const score = Number.isFinite(rawScore)
    ? Math.min(5, Math.max(0, Math.round(rawScore)))
    : null;
  return {
    summary: asStr(raw.summary),
    module: asStrOrNull(raw.module),
    kind: oneOf(raw.kind, AI_REQUEST_KINDS),
    areas: Array.isArray(raw.areas)
      ? raw.areas
          .map((v) => oneOf(v, AI_REQUEST_AREAS))
          .filter((v): v is string => v !== null)
      : [],
    priorityProposal: oneOf(raw.priorityProposal, AI_PRIORITIES),
    duplicates: Array.isArray(raw.duplicates)
      ? raw.duplicates
          .map((d) => {
            const o = (d ?? {}) as Record<string, unknown>;
            const requestId = Number(o.requestId);
            const confidence = oneOf(o.confidence, ["HIGH", "MEDIUM"]);
            return {
              requestId,
              confidence: (confidence ?? "MEDIUM") as "HIGH" | "MEDIUM",
              reason: asStr(o.reason),
            };
          })
          .filter((d) => Number.isInteger(d.requestId) && d.requestId > 0)
      : [],
    score,
    scoreReason: asStrOrNull(raw.scoreReason),
    // STROGO: samo eksplicitno `true` (ili tekstualno "true") vodi u auto-reject.
    // Nedostatak polja = NIJE neupotrebljivo → zahtev ostaje čoveku (fail-safe).
    unusable:
      raw.unusable === true || asStr(raw.unusable).toLowerCase() === "true",
    questions: Array.isArray(raw.questions)
      ? raw.questions.map((v) => asStr(v)).filter(Boolean)
      : [],
  };
}

// ── DETALJNA ANALIZA (§4.2) ──────────────────────────────────────────────────

export const ANALYSIS_SYSTEM_PROMPT = `Ti si AI product manager / tehnički analitičar za ServoSync (Servoteh). Administrator je ODOBRIO detaljnu analizu ovog zahteva. Na osnovu zahteva, priloga, komentara, trijaže i priloženog sistemskog konteksta, uradi DETALJNU analizu i pripremi "Claude paket" (prompt-dokument za Claude Code koji će raditi implementaciju).

URADI:
- understanding: šta korisnik ZAPRAVO traži, tvojim rečima (bez izmišljanja).
- affectedModules: koji su moduli/oblasti pogođeni (iz sistemskog konteksta).
- impact: procena uticaja (obim izmena, ko je pogođen, DB/BE/FE/mobilno).
- risks: rizici izmene.
- conflicts: mogući sukobi sa postojećim ponašanjem/funkcijama.
- openQuestions: pitanja za podnosioca/admina (ono što nije potvrđeno).
- acceptanceCriteria: konkretni, proverljivi AC.
- testScenarios: test scenariji (kako se proverava).
- estimate: S | M | L | XL.
- priorityProposal: predlog prioriteta.
- claudePackage: KOMPLETAN markdown paket po šablonu ispod (popuni sve sekcije).

CLAUDE PAKET — šablon (markdown, popuni realnim sadržajem, zadrži naslove):
# Zahtev Z-<reqNo>: <naslov>
## Kontekst
<modul, poslovni kontekst, veza sa postojećim funkcijama>
## Zahtev
<original korisnika (citat) + AI strukturisano razumevanje>
## Acceptance kriterijumi
- [ ] ...
## Ograničenja
- Pročitaj i poštuj CLAUDE.md + backend/docs/BACKEND_RULES.md repoa.
- NE menjaj ponašanje postojećih modula van navedenog obima.
- Migracije kroz \`npm run migrate:dev\`; boot-smoke pre push-a; post-deploy verify.
## Test scenariji
1. ...
## Definicija gotovog
Testovi prolaze, lint čist, spec ažuriran, zahtev Z-<reqNo> → SPREMNO ZA TEST.

PRAVILA:
- Ne izmišljaj module/funkcije kojih nema u sistemskom kontekstu — ako nisi siguran, navedi kao otvoreno pitanje.
- Piši na srpskom (ekavica, latinica); kod/komande ostaju kako jesu.
- Pozovi alat "analiza" sa svim poljima.

${INJECTION_FENCE}`;

export const ANALYSIS_TOOL = {
  name: "analiza",
  description:
    "Detaljna analiza zahteva + generisan Claude paket (markdown) za implementaciju.",
  input_schema: {
    type: "object",
    properties: {
      understanding: { type: "string" },
      affectedModules: { type: "array", items: { type: "string" } },
      impact: { type: "string" },
      risks: { type: "array", items: { type: "string" } },
      conflicts: { type: "array", items: { type: "string" } },
      openQuestions: { type: "array", items: { type: "string" } },
      acceptanceCriteria: { type: "array", items: { type: "string" } },
      testScenarios: { type: "array", items: { type: "string" } },
      estimate: { type: "string", enum: [...AI_ESTIMATES] },
      priorityProposal: { type: "string", enum: [...AI_PRIORITIES] },
      claudePackage: {
        type: "string",
        description: "kompletan markdown paket po šablonu",
      },
    },
    required: [
      "understanding",
      "impact",
      "acceptanceCriteria",
      "testScenarios",
      "estimate",
      "claudePackage",
    ],
  } as Record<string, unknown>,
};

export interface AnalysisResult {
  understanding: string;
  affectedModules: string[];
  impact: string;
  risks: string[];
  conflicts: string[];
  openQuestions: string[];
  acceptanceCriteria: string[];
  testScenarios: string[];
  estimate: string | null;
  priorityProposal: string | null;
  claudePackage: string;
}

const strArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => asStr(x)).filter(Boolean) : [];

/** Normalizuj izlaz detaljne analize; claudePackage se izdvaja posebno. */
export function normalizeAnalysis(
  raw: Record<string, unknown>,
): AnalysisResult {
  return {
    understanding: asStr(raw.understanding),
    affectedModules: strArray(raw.affectedModules),
    impact: asStr(raw.impact),
    risks: strArray(raw.risks),
    conflicts: strArray(raw.conflicts),
    openQuestions: strArray(raw.openQuestions),
    acceptanceCriteria: strArray(raw.acceptanceCriteria),
    testScenarios: strArray(raw.testScenarios),
    estimate: oneOf(raw.estimate, AI_ESTIMATES),
    priorityProposal: oneOf(raw.priorityProposal, AI_PRIORITIES),
    claudePackage: asStr(raw.claudePackage),
  };
}

// ── Tokeni (Anthropic usage) ─────────────────────────────────────────────────

/** Izvuci input/output tokene iz `usage` bloka (Anthropic: input_tokens/output_tokens). */
export function usageTokens(usage: unknown): {
  tokensIn: number | null;
  tokensOut: number | null;
} {
  const u = (usage ?? {}) as Record<string, unknown>;
  const tin = Number(u.input_tokens);
  const tout = Number(u.output_tokens);
  return {
    tokensIn: Number.isFinite(tin) ? tin : null,
    tokensOut: Number.isFinite(tout) ? tout : null,
  };
}

/** Klasifikuj AI grešku u errorCode za red analize (§4.4). */
export function classifyAiError(err: unknown): string {
  const msg = (err as { message?: string })?.message ?? "";
  const name = (err as { name?: string })?.name ?? "";
  if (
    name === "ServiceUnavailableException" ||
    /nije postavljen|not_configured/i.test(msg)
  )
    return "not_configured";
  if (/refuse|odbio|max_tokens|predugačak/i.test(msg)) return "refusal";
  if (/parse/i.test(msg)) return "parse_failed";
  if (/unreachable/i.test(msg)) return "upstream_unreachable";
  return "upstream_error";
}
