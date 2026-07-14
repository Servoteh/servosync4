/**
 * Port edge `montaza-izvestaj-ai` → NestJS (TALAS C, presuda C6). Identičan
 * prompt / tool-schema / limiti / model-allowlist / normalizacija kao 1.0
 * `supabase/functions/montaza-izvestaj-ai/index.ts`. Anthropic poziv ide kroz
 * `AiProviderService.extractWithTool` (BE env ključ). 1.0 edge OSTAJE živ za
 * paralelni rad do preklopa (doktrina §C).
 */

export const MONTAZA_AI_ALLOWED_MODELS = [
  "claude-opus-4-8",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
] as const;

export const MONTAZA_AI_DEFAULT_MODEL = "claude-sonnet-4-6";

/** Dozvoljeni statusi izveštaja (DB CHECK + edge STATUS_CODES). */
export const MONTAZA_STATUS_CODES = [
  "zavrseno",
  "delimicno",
  "u_toku",
  "ceka_materijal",
  "ceka_potvrdu",
  "dodatna_intervencija",
] as const;

/** Vision MIME allowlist (edge VISION_MIME). */
export const MONTAZA_VISION_MIME = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
];

/** Obavezna polja (edge REQUIRED_FIELDS) — za `nedostajuci_podaci`. */
export const MONTAZA_REQUIRED_FIELDS = [
  "datum",
  "predmet",
  "klijent",
  "lokacija",
  "pocetak_rada",
  "kraj_rada",
];

export const MONTAZA_MAX_SLIKE = 16;
export const MONTAZA_MAX_TEKST_CHARS = 20000;
export const MONTAZA_MAX_SLIKA_B64 = 4 * 1024 * 1024; // ~4MB base64 po slici

/** Verbatim edge SYSTEM_PROMPT. */
export const MONTAZA_AI_SYSTEM_PROMPT = `Ti si AI asistent za Servosync (Servoteh). Od slobodno napisanog teksta montera/servisera i priloženih fotografija praviš STRUKTURISAN servisni izveštaj.

PRAVILA:
- Ne izmišljaj podatke. Ako podatak nije potvrđen u tekstu, ostavi prazan string "".
- NIKADA ne traži niti zaključuj ime montera/servisera — to popunjava sistem iz prijavljenog korisnika. Ako u tekstu pominje da je radio sa nekim (npr. "radio sam sa Nenadom"), te osobe upiši u "dodatni_clanovi_tima".
- Naziv projekta i klijenta NE pogađaj iz teksta — sistem ih dopunjava iz baze po broju predmeta. Popuni ih samo ako su doslovno navedeni.
- Za svaku fotografiju napiši kratak opis šta se vidi; ne opisuj ono što nije vidljivo.
- Piši kratko, jasno i profesionalno, na srpskom (ekavica, latinica).

STATUS — izaberi TAČNO jedan kod:
- "zavrseno"             = završeno
- "delimicno"            = delimično završeno
- "u_toku"               = u toku
- "ceka_materijal"       = čeka materijal
- "ceka_potvrdu"         = čeka potvrdu klijenta
- "dodatna_intervencija" = potrebna dodatna intervencija
Ako status nije jasan iz teksta, koristi "u_toku".

OBAVEZNA POLJA (datum, predmet, klijent, lokacija, pocetak_rada, kraj_rada): ako neko nedostaje, dodaj njegov ključ u "nedostajuci_podaci".

Pozovi alat "izvestaj" sa izvučenim podacima. Polja koja nisu potvrđena ostavi kao prazan string "".
Format datuma: DD.MM.YYYY. Format vremena: HH:MM.`;

/** Verbatim edge TOOL (input_schema). */
export const MONTAZA_AI_TOOL = {
  name: "izvestaj",
  description:
    "Strukturisan servisni izveštaj montera/servisera izvučen iz slobodnog teksta i fotografija.",
  input_schema: {
    type: "object",
    properties: {
      datum: { type: "string", description: "DD.MM.YYYY, prazno ako nije navedeno" },
      predmet: { type: "string", description: "broj predmeta, npr. 9400/2" },
      naziv_projekta: {
        type: "string",
        description: "samo ako je doslovno naveden",
      },
      klijent: { type: "string", description: "samo ako je doslovno naveden" },
      lokacija: { type: "string" },
      pocetak_rada: { type: "string", description: "HH:MM" },
      kraj_rada: { type: "string", description: "HH:MM" },
      opis_radova: { type: "string" },
      problemi: { type: "string" },
      otvorene_stavke: { type: "string" },
      status: { type: "string", enum: [...MONTAZA_STATUS_CODES] },
      dodatni_clanovi_tima: {
        type: "array",
        items: { type: "string" },
        description: "imena saradnika — NIKADA ime samog autora",
      },
      fotodokumentacija: {
        type: "array",
        items: {
          type: "object",
          properties: {
            redni_broj: { type: "integer" },
            opis: { type: "string" },
          },
          required: ["redni_broj", "opis"],
        },
      },
      nedostajuci_podaci: {
        type: "array",
        items: { type: "string" },
        description: "ključevi obaveznih polja koja nedostaju",
      },
    },
    required: [
      "datum",
      "predmet",
      "naziv_projekta",
      "klijent",
      "lokacija",
      "pocetak_rada",
      "kraj_rada",
      "opis_radova",
      "problemi",
      "otvorene_stavke",
      "status",
    ],
  } as Record<string, unknown>,
};

const asStr = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export interface MontazaAiOut {
  datum: string;
  predmet: string;
  naziv_projekta: string;
  klijent: string;
  lokacija: string;
  pocetak_rada: string;
  kraj_rada: string;
  opis_radova: string;
  problemi: string;
  otvorene_stavke: string;
  status: string;
  dodatni_clanovi_tima: string[];
  fotodokumentacija: Array<{ redni_broj: number; opis: string }>;
  predmet_item_id: number | null;
  nedostajuci_podaci: string[];
}

/** Normalizacija tool izlaza (edge normalize; status→allowlist, nedostajuci server-side). */
export function normalizeMontazaOut(
  raw: Record<string, unknown>,
): MontazaAiOut {
  const status = asStr(raw.status);
  const out: MontazaAiOut = {
    datum: asStr(raw.datum),
    predmet: asStr(raw.predmet),
    naziv_projekta: asStr(raw.naziv_projekta),
    klijent: asStr(raw.klijent),
    lokacija: asStr(raw.lokacija),
    pocetak_rada: asStr(raw.pocetak_rada),
    kraj_rada: asStr(raw.kraj_rada),
    opis_radova: asStr(raw.opis_radova),
    problemi: asStr(raw.problemi),
    otvorene_stavke: asStr(raw.otvorene_stavke),
    status: (MONTAZA_STATUS_CODES as readonly string[]).includes(status)
      ? status
      : "u_toku",
    dodatni_clanovi_tima: Array.isArray(raw.dodatni_clanovi_tima)
      ? raw.dodatni_clanovi_tima.map((v) => asStr(v)).filter(Boolean)
      : [],
    fotodokumentacija: Array.isArray(raw.fotodokumentacija)
      ? raw.fotodokumentacija
          .map((f) => {
            const o = (f ?? {}) as Record<string, unknown>;
            return { redni_broj: Number(o.redni_broj) || 0, opis: asStr(o.opis) };
          })
          .filter((f) => f.redni_broj > 0)
      : [],
    predmet_item_id: null,
    nedostajuci_podaci: [],
  };
  // `nedostajuci_podaci` se računa server-side (edge): predmet je zadovoljen ako
  // je predmet ILI naziv_projekta prisutan.
  out.nedostajuci_podaci = MONTAZA_REQUIRED_FIELDS.filter((f) => {
    if (f === "predmet") return !out.predmet && !out.naziv_projekta;
    return !asStr((out as unknown as Record<string, unknown>)[f]);
  });
  return out;
}
