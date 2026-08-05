/**
 * Čitanje računa iz servisa (Održavanje → trošak popravke).
 *
 * ZAŠTO: cena servisa se do sada nije unosila jer traži ručno prekucavanje sa papira —
 * merenje 03.08.2026 pokazalo je 0 stavki „Delovi" na 134 naloga. Račun se, međutim,
 * slika u dve sekunde. Model iz slike/PDF-a izvlači iznos, servisera, datum i stavke;
 * upis u nalog radi ČOVEK potvrdom (ova ruta ništa ne piše u bazu).
 *
 * Obrazac je isti kao `montaza-ai.ts`: `AiProviderService.extractWithTool` sa obaveznim
 * alatom (`tool_choice`) → strukturisan izlaz bez parsiranja slobodnog teksta.
 */

export const RACUN_AI_ALLOWED_MODELS = [
  "claude-opus-4-8",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
] as const;

/** Račun je gust dokument sa brojevima — podrazumevano ide jači model od haiku. */
export const RACUN_AI_DEFAULT_MODEL = "claude-sonnet-4-6";

/** Vision MIME allowlist (slike telefonom) + PDF (Anthropic `document` blok). */
export const RACUN_VISION_MIME = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
];
export const RACUN_PDF_MIME = "application/pdf";

export const RACUN_MAX_FAJLOVA = 8;
/** ~4 MB base64 po fajlu (isti prag kao montaža — Anthropic limit po bloku). */
export const RACUN_MAX_FAJL_B64 = 4 * 1024 * 1024;

export const RACUN_AI_SYSTEM_PROMPT = `Ti si AI asistent za Servosync (Servoteh). Sa fotografije ili PDF-a računa iz auto-servisa / servisne radionice izvlačiš podatke o trošku popravke.

PRAVILA:
- Ne izmišljaj podatke. Ako podatak nije JASNO čitljiv na računu, ostavi prazan string "" (odnosno null za brojeve).
- Iznose vraćaj kao BROJ, bez valute i bez razdelnika hiljada. Decimalni znak je tačka. Primer: "42.800,00 RSD" → 42800.00
- Srpski računi pišu hiljade tačkom, a decimale zarezom — ne pomešaj ih. "1.250,50" je hiljadudvestapedeset, ne 1,25.
- "ukupan_iznos" je iznos koji se PLAĆA (sa PDV-om, posle svih popusta) — na računu obično „ZA UPLATU", „UKUPNO ZA PLAĆANJE" ili „TOTAL".
- Ako na računu piše kilometraža vozila (km stanje, „pređeno"), upiši je u "kilometraza".
- Stavke prepiši onako kako pišu na računu. Ako stavki ima previše, uzmi one sa najvećim iznosom.
- Ne zaključuj koje je vozilo u pitanju osim ako registarska oznaka doslovno piše na računu.
- Piši na srpskom (ekavica, latinica).

Pozovi alat "racun" sa izvučenim podacima.
Format datuma: DD.MM.YYYY.`;

export const RACUN_AI_TOOL = {
  name: "racun",
  description:
    "Podaci sa računa servisne radionice izvučeni sa fotografije ili PDF-a.",
  input_schema: {
    type: "object",
    properties: {
      ukupan_iznos: {
        type: ["number", "null"],
        description: "iznos za uplatu sa PDV-om; null ako nije čitljiv",
      },
      iznos_bez_pdv: { type: ["number", "null"] },
      valuta: {
        type: "string",
        description: "RSD, EUR… prazno ako nije navedena",
      },
      datum: { type: "string", description: "DD.MM.YYYY, prazno ako nema" },
      serviser: {
        type: "string",
        description: "naziv radionice/firme koja je izdala račun",
      },
      broj_racuna: { type: "string" },
      kilometraza: {
        type: ["integer", "null"],
        description: "stanje kilometar-sata ako piše na računu",
      },
      registracija: {
        type: "string",
        description: "registarska oznaka SAMO ako doslovno piše na računu",
      },
      opis_radova: {
        type: "string",
        description: "kratak rezime šta je rađeno (1-2 rečenice)",
      },
      stavke: {
        type: "array",
        description: "pojedinačne stavke računa (delovi i usluge)",
        items: {
          type: "object",
          properties: {
            naziv: { type: "string" },
            kolicina: { type: ["number", "null"] },
            jedinica: { type: "string" },
            jedinicna_cena: { type: ["number", "null"] },
            iznos: { type: ["number", "null"] },
          },
          required: ["naziv"],
        },
      },
      necitljivo: {
        type: "array",
        items: { type: "string" },
        description:
          "ključevi polja koja nisu bila čitljiva (npr. „ukupan_iznos\")",
      },
    },
    required: ["ukupan_iznos", "datum", "serviser", "stavke"],
  } as Record<string, unknown>,
};

const asStr = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
/** Broj iz modela: prihvata i string („42800.00") jer JSON schema nije garancija. */
function asNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(",", "."));
  return Number.isFinite(n) && n >= 0 ? n : null;
}
function asInt(v: unknown): number | null {
  const n = asNum(v);
  return n == null ? null : Math.round(n);
}

export interface RacunStavka {
  naziv: string;
  kolicina: number | null;
  jedinica: string;
  jedinicnaCena: number | null;
  iznos: number | null;
}

export interface RacunAiOut {
  ukupanIznos: number | null;
  iznosBezPdv: number | null;
  valuta: string;
  datum: string;
  serviser: string;
  brojRacuna: string;
  kilometraza: number | null;
  registracija: string;
  opisRadova: string;
  stavke: RacunStavka[];
  necitljivo: string[];
}

/** Polja bez kojih predlog nije upotrebljiv — računamo ih sami, ne verujemo modelu. */
const OBAVEZNA: Array<[keyof RacunAiOut, string]> = [
  ["ukupanIznos", "ukupan_iznos"],
  ["datum", "datum"],
  ["serviser", "serviser"],
];

/** Normalizacija tool izlaza — camelCase + brojevi + server-side `necitljivo`. */
export function normalizeRacunOut(raw: Record<string, unknown>): RacunAiOut {
  const out: RacunAiOut = {
    ukupanIznos: asNum(raw.ukupan_iznos),
    iznosBezPdv: asNum(raw.iznos_bez_pdv),
    valuta: asStr(raw.valuta).toUpperCase() || "RSD",
    datum: asStr(raw.datum),
    serviser: asStr(raw.serviser),
    brojRacuna: asStr(raw.broj_racuna),
    kilometraza: asInt(raw.kilometraza),
    registracija: asStr(raw.registracija).toUpperCase(),
    opisRadova: asStr(raw.opis_radova),
    stavke: Array.isArray(raw.stavke)
      ? raw.stavke
          .map((s) => {
            const o = (s ?? {}) as Record<string, unknown>;
            return {
              naziv: asStr(o.naziv),
              kolicina: asNum(o.kolicina),
              jedinica: asStr(o.jedinica),
              jedinicnaCena: asNum(o.jedinicna_cena),
              iznos: asNum(o.iznos),
            };
          })
          .filter((s) => s.naziv)
      : [],
    necitljivo: [],
  };
  // Ako je model dao samo iznos bez PDV-a, ne računamo PDV sami (stopa varira i
  // pogrešna pretpostavka bi tiho ušla u trošak) — samo prijavimo da fali.
  out.necitljivo = OBAVEZNA.filter(([k]) => {
    const v = out[k];
    return v === null || v === "";
  }).map(([, label]) => label);
  return out;
}
