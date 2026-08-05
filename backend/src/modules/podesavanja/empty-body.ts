/**
 * DIJAGNOSTIKA PRAZNOG TELA ZAHTEVA — „Nijedno polje nije prosleđeno."
 *
 * ZAŠTO POSTOJI (prijava vlasnika 05.08.2026): pri snimanju podataka firme vratio se
 * HTTP 422 sa porukom „Nijedno polje nije prosleđeno.", a iz koda se uzrok NIJE mogao
 * videti — deployirani DTO prima svih 19 polja koja ekran šalje, servis ih sve obrađuje,
 * `normalizeBankCode` razlikuje `null` od `undefined`, `apiFetch` šalje
 * `Content-Type: application/json`, a frontend ima branu koja ne šalje prazan objekat.
 * Svaka od tih provera je isključila jedan uzrok, ali nijedna nije mogla da kaže ŠTA JE
 * ZAISTA STIGLO — pa je zaključak ostao nagađanje („verovatno staro izdanje u pregledaču").
 *
 * KORENSKI PROBLEM VIDLJIVOSTI: globalni `ValidationPipe` (`main.ts`) radi sa
 * `whitelist: true` i BEZ `forbidNonWhitelisted`. Nepoznato polje se zato TIHO ODBACUJE
 * pre nego što telo stigne do servisa — servis vidi `{}` i ne može da razlikuje tri
 * bitno različita slučaja:
 *
 *   1. telo je stiglo prazno (`{}`) — ekran nije poslao ništa;
 *   2. telo je nosilo polja, ali NIJEDNO nije prepoznato (staro izdanje ekrana,
 *      preimenovano polje, pogrešna ruta) — `whitelist` ih je pojeo;
 *   3. telo je nosilo prepoznata polja, ali su sva bila `undefined`.
 *
 * Zato se OVDE gleda SIROVO telo (`req.body`) — ono koje `ValidationPipe` NE menja
 * (pipe radi nad kopijom iz `plainToInstance`; pinovano testom u `empty-body.spec.ts`).
 *
 * ⚠️ SAMO NAZIVI POLJA, NIKAD VREDNOSTI. Kroz ove rute idu PIB, matični broj i IBAN;
 * vrednost u logu bi bila trajan zapis poslovnog podatka na mestu koje niko ne čuva kao
 * takvo. Nazivi kolona (`iban`, `taxId`) nisu tajna i jedini su podatak koji je potreban
 * da bi se razlika između tri slučaja gore videla iz JEDNOG pogleda u log.
 */

/** Šta ide korisniku (srpski), a šta u log (detalj sa nazivima polja). */
export interface EmptyBodyDiagnostics {
  /** Poruka za 422 — razumljiva onome ko je pritisnuo „Snimi". */
  message: string;
  /** Red za `logger.warn` — nazivi primljenih/odbačenih polja, bez vrednosti. */
  logDetail: string;
}

/** Prazan objekat, `null`, niz ili tekst — sve što nije „objekat sa poljima". */
function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `a`, `b` i `c` — nabrajanje za srpsku poruku (bez zagrada i bez vrednosti). */
function nabroj(keys: string[]): string {
  return keys.map((k) => `„${k}"`).join(", ");
}

/**
 * Opis stanja „telo je stiglo, a nijedno polje nije upotrebljivo".
 *
 * @param raw    sirovo telo zahteva (`req.body`) — PRE `whitelist`-a; `undefined` kad
 *               pozivalac nije prosledio zahtev (servis pozvan iz koda, ne iz HTTP-a)
 * @param known  imena polja koja ruta poznaje (polja DTO-a)
 * @param what   šta se na tom ekranu snima — ulazi u poruku korisniku
 */
export function describeEmptyBody(
  raw: unknown,
  known: readonly string[],
  what: string,
): EmptyBodyDiagnostics {
  const osnov = `Nijedno polje nije prosleđeno — ${what} nije izmenjeno.`;
  const osveziRedirect =
    "Ako ste izmenu sigurno uneli, u pregledaču je najverovatnije staro izdanje ekrana: " +
    "osvežite stranu (Ctrl+F5, na Mac-u Cmd+Shift+R) i pokušajte ponovo. " +
    "Ako se ponovi, prijavite — detalj je zapisan u dnevniku servera.";

  // Servis pozvan iz koda (test, skripta) — nema sirovog tela, nema šta da se opiše.
  if (raw === undefined)
    return { message: osnov, logDetail: "sirovo telo nije prosleđeno (poziv iz koda)" };

  if (!isPlainRecord(raw)) {
    const tip = raw === null ? "null" : Array.isArray(raw) ? "niz" : typeof raw;
    return {
      message:
        `${osnov} Telo zahteva nije objekat sa poljima (stiglo je: ${tip}). ` +
        osveziRedirect,
      logDetail: `telo nije objekat: ${tip}`,
    };
  }

  const primljena = Object.keys(raw);
  if (primljena.length === 0)
    return {
      message: `${osnov} Telo zahteva je stiglo prazno (bez ijednog polja). ${osveziRedirect}`,
      logDetail: "telo prazno: {}",
    };

  const znana = new Set(known);
  const prepoznata = primljena.filter((k) => znana.has(k));
  const odbacena = primljena.filter((k) => !znana.has(k));
  const logDetail =
    `primljeno ${primljena.length} polja: ${primljena.join(", ")}` +
    ` | prepoznato ${prepoznata.length}: ${prepoznata.join(", ") || "—"}` +
    ` | ODBACIO whitelist ${odbacena.length}: ${odbacena.join(", ") || "—"}`;

  // Slučaj 2: sve pojeo `whitelist` — ovo je jedini način da se to ikad vidi.
  if (prepoznata.length === 0)
    return {
      message:
        `${osnov} Zahtev je doneo ${primljena.length} ` +
        `${primljena.length === 1 ? "polje" : "polja"}, ali ovaj ekran ne poznaje ` +
        `nijedno od njih: ${nabroj(odbacena)}. ${osveziRedirect}`,
      logDetail,
    };

  // Slučaj 3: polja su prepoznata, ali su sve vrednosti bile `undefined`.
  const message =
    `${osnov} Zahtev je doneo prepoznata polja (${nabroj(prepoznata)}), ali nijedno ` +
    "nije nosilo vrednost" +
    (odbacena.length
      ? `, a ${odbacena.length} ${odbacena.length === 1 ? "polje je" : "polja su"} ` +
        `odbačeno jer ih ekran ne poznaje: ${nabroj(odbacena)}.`
      : ".") +
    ` ${osveziRedirect}`;
  return { message, logDetail };
}
