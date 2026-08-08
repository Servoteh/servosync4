import * as fs from "node:fs";
import * as path from "node:path";

/*
 * 🔴 BRANA NAD POVRŠINOM SISTEMSKIH FUNKCIJA OUTBOX-A ODRŽAVANJA.
 *
 * `dispatchDequeue` / `dispatchMarkSent` / `dispatchMarkFailed` / `dispatchFanout`
 * u `OdrzavanjeFnService` su JAVNE metode BEZ `MaintScope` argumenta i BEZ ijedne
 * provere prava — isto kao sy15 originali, koji su `SECURITY DEFINER` bez gejta
 * jer ih pokreće cron BEZ korisnika. Danas su bezbedne isključivo zato što ih
 * zove SAMO scheduler; to je činjenica o trenutnom kodu, ne garancija.
 *
 * TypeScript tu branu ne može da drži (Nest injektuje ceo servis, a `private` bi
 * odsekao i scheduler). Zato je brana ovaj test: skenira `src/` i pada čim se
 * pojavi pozivalac van dozvoljenog kruga. Ako ti neka od njih zatreba na HTTP
 * putanji — NE dodaj fajl u spisak ispod, nego napravi metodu sa `MaintScope`
 * koja prvo prođe kroz `OdrzavanjeAuthzService`.
 */

const SRC = path.resolve(__dirname, "..", "..");

/** Metode bez gejta prava — pozivalac im sme biti samo pogon (scheduler). */
const SISTEMSKE = [
  "dispatchDequeue",
  "dispatchMarkSent",
  "dispatchMarkFailed",
  "dispatchFanout",
];

/**
 * Dozvoljeni pozivaoci, relativno na `src/` (kose crte normalizovane).
 * - scheduler = jedini POGON koji ih sme zvati,
 * - fn servis = mesto gde su definisane (`this.markFailedRaw`, interni pozivi),
 * - njihovi specovi = paritet-testovi nad tim istim funkcijama.
 */
const DOZVOLJENI = [
  "modules/scheduler/dispatch/notify-dispatch.service.ts",
  "modules/scheduler/dispatch/notify-dispatch.service.spec.ts",
  "modules/odrzavanje/odrzavanje-fn.service.ts",
  "modules/odrzavanje/odrzavanje-fn.service.spec.ts",
  "modules/odrzavanje/odrzavanje-fn.dispatch-pozivaoci.spec.ts",
];

function tsFajlovi(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) tsFajlovi(p, out);
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("outbox održavanja — sistemske fn se ne smeju zvati van scheduler-a", () => {
  const fajlovi = tsFajlovi(SRC).map((f) => ({
    rel: path.relative(SRC, f).split(path.sep).join("/"),
    txt: fs.readFileSync(f, "utf8"),
  }));

  /**
   * ⚠️ Skener gleda SAMO fajlove koji pominju `OdrzavanjeFnService`. Bez toga
   * hvata i `SastanciFnService`, koji ima metode ISTIH imena (`dispatchDequeue`
   * …) za svoj outbox — a njih ovo pravilo ne pokriva. Da bi se ove metode
   * uopšte pozvale, servis mora biti injektovan, pa mu ime u fajlu MORA stajati.
   */
  const kandidati = fajlovi.filter((f) =>
    f.txt.includes("OdrzavanjeFnService"),
  );

  it("skener uopšte vidi izvorno stablo (inače bi test bio prazan i uvek zelen)", () => {
    expect(fajlovi.length).toBeGreaterThan(200);
    expect(kandidati.length).toBeGreaterThan(0);
  });

  it.each(SISTEMSKE)(
    "🔴 `%s` zove SAMO scheduler (nema HTTP putanje bez provere prava)",
    (metoda) => {
      const re = new RegExp(`\\.${metoda}\\s*\\(`);
      const pozivaoci = kandidati
        .filter((f) => re.test(f.txt))
        .map((f) => f.rel)
        .sort();
      // Bar jedan pozivalac MORA postojati — nula bi značila da je regex
      // promašio (npr. metoda preimenovana) i da brana tiho ne radi ništa.
      expect(pozivaoci.length).toBeGreaterThan(0);
      expect(pozivaoci.filter((p) => !DOZVOLJENI.includes(p))).toEqual([]);
    },
  );
});
