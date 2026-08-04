/**
 * Sledeći termin SEDMIČNOG sastanka — ogledalo sy15 automatike (zahtev 024/26 a).
 *
 * ZAŠTO POSTOJI: sledeći sedmični sastanak NE nastaje kad se prethodni zatvori, nego
 * ga pg_cron posao `sast-weekly-auto` kreira PETKOM u 08:00 pozivom
 * `sast_auto_create_weekly()`. Do tog trenutka u tabeli `sastanci` nema nijednog reda
 * za naredni termin, pa i pregled i lista pokazuju poslednji (zatvoreni) sastanak —
 * korisniku to izgleda kao „zaglavljen stari datum". Ova čista funkcija računa
 * termin koji će automatika NAPRAVITI, da ga UI može najaviti pre nego što red postoji.
 *
 * PARITET SA BAZOM (`talasB-fn-defs-2026-07-12.sql`):
 *   - `sast_auto_create_weekly` radi samo petkom u 08h lokalno (isodow=5, hour=8),
 *   - cilj = `sast_next_week_monday(petak)` = `d + ((8 - isodow(d)) % 7)` = petak + 3,
 *   - preskače nedelju ako u njoj VEĆ postoji sedmični sa `status <> 'otkazan'`,
 *   - konačan datum = `sast_adjust_for_holiday(ponedeljak)` (Pon..Pet, prvi dan koji
 *     nije neradni praznik iz `kadr_holidays`),
 *   - novi red dobija vreme 09:00 (`sast_create_weekly_at` default).
 *
 * NIJE POKRIVENO (svesno): tabela `sast_weekly_skip` („Odloži ovu nedelju") se ne
 * mapira u Prismi i čita se isključivo kroz RPC `sast_weekly_status()` — odlaganje
 * ostaje vidljivo u modalu „Sedmični". Najava je zato „šta automatika planira", a ne
 * garancija; UI je i formuliše tako.
 *
 * Čista fn — bez DB/HTTP, unit-testabilna (weekly-rollover.spec.ts).
 */

/** Sat (lokalno) kad pg_cron pušta `sast_auto_create_weekly`. */
export const AUTO_KREIRANJE_SAT = 8;
/** ISO dan u nedelji kad automatika radi (5 = petak). */
export const AUTO_KREIRANJE_ISODOW = 5;
/** Podrazumevano vreme novog sedmičnog (`sast_create_weekly_at` default). */
export const SEDMICNI_PODRAZUMEVANO_VREME = "09:00";

export interface SedmicniRed {
  id: string;
  /** 'YYYY-MM-DD' */
  datum: string;
  /** 'HH:MM' ili null */
  vreme: string | null;
  status: string;
}

export interface SledeciSedmicniUlaz {
  /** Danas u Europe/Belgrade ('YYYY-MM-DD'). */
  danas: string;
  /** Tekući sat u Europe/Belgrade (0..23) — guard „petak PRE 08h". */
  sat: number;
  /** Sedmični sastanci sa `datum >= danas` (bilo koji status). */
  sedmicni: SedmicniRed[];
  /** Neradni praznici ('YYYY-MM-DD', `kadr_holidays.is_workday = false`). */
  praznici: string[];
}

export interface SledeciSedmicni {
  /** Datum termina ('YYYY-MM-DD'). */
  datum: string;
  /** Vreme ('HH:MM') — postojećeg reda, ili podrazumevano 09:00 za najavu. */
  vreme: string | null;
  /** Id ako sastanak VEĆ postoji; `null` = termin je tek najava. */
  sastanakId: string | null;
  /** Petak kad ga automatika kreira ('YYYY-MM-DD'); `null` kad već postoji. */
  kreiraSeDatum: string | null;
}

const DAN_MS = 86_400_000;

function uUtc(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return Date.UTC(y, (m ?? 1) - 1, d ?? 1);
}

function izUtc(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate(),
  ).padStart(2, "0")}`;
}

/** `ymd + n` dana (čist UTC račun — bez TZ drift-a). Deli i periodicni-rollover. */
export function plusDana(ymd: string, n: number): string {
  return izUtc(uUtc(ymd) + n * DAN_MS);
}

/** ISO dan u nedelji: 1 = ponedeljak … 7 = nedelja (kao `EXTRACT(isodow)`). */
function isoDow(ymd: string): number {
  return ((new Date(uUtc(ymd)).getUTCDay() + 6) % 7) + 1;
}

/**
 * Prvi petak u kojem automatika još MOŽE da odradi posao: danas ako je petak pre 08h,
 * inače prvi naredni petak (posao za današnji petak je već prošao u 08h).
 */
function prvoKreiranje(danas: string, sat: number): string {
  const dow = isoDow(danas);
  if (dow === AUTO_KREIRANJE_ISODOW && sat < AUTO_KREIRANJE_SAT) return danas;
  const delta = ((AUTO_KREIRANJE_ISODOW - dow + 7) % 7) || 7;
  return plusDana(danas, delta);
}

/** Paritet `sast_adjust_for_holiday`: prvi dan Pon..Pet koji nije neradni praznik. */
function pomeriZaPraznik(ponedeljak: string, praznici: Set<string>): string {
  let d = ponedeljak;
  for (let i = 0; i < 5; i++) {
    if (!praznici.has(d)) return d;
    d = plusDana(d, 1);
  }
  return ponedeljak; // (nerealno) cela radna nedelja praznik
}

/**
 * Termin sledećeg sedmičnog sastanka — postojeći red ako ga ima, inače najava
 * onoga što će automatika kreirati. `null` samo ako ni u narednih 8 nedelja
 * automatika ne bi ništa napravila (svaka nedelja već ima svoj sedmični).
 */
export function sledeciSedmicniTermin(
  u: SledeciSedmicniUlaz,
): SledeciSedmicni | null {
  // 1) Već kreiran predstojeći sedmični (planiran/u toku) — on JE sledeći termin.
  const aktivni = u.sedmicni
    .filter((s) => s.status === "planiran" || s.status === "u_toku")
    .sort((a, b) => (a.datum < b.datum ? -1 : a.datum > b.datum ? 1 : 0));
  const aktivan = aktivni[0];
  if (aktivan) {
    return {
      datum: aktivan.datum,
      vreme: aktivan.vreme,
      sastanakId: aktivan.id,
      kreiraSeDatum: null,
    };
  }

  // 2) Nema ga → simuliraj `sast_auto_create_weekly` po petkovima unapred.
  const praznici = new Set(u.praznici);
  let petak = prvoKreiranje(u.danas, u.sat);
  for (let i = 0; i < 8; i++) {
    const ponedeljak = plusDana(petak, 3); // = sast_next_week_monday(petak)
    const kraj = plusDana(ponedeljak, 6);
    // Automatika preskače nedelju u kojoj sedmični već postoji (osim otkazanog).
    const zauzeta = u.sedmicni.some(
      (s) =>
        s.status !== "otkazan" && s.datum >= ponedeljak && s.datum <= kraj,
    );
    if (!zauzeta) {
      return {
        datum: pomeriZaPraznik(ponedeljak, praznici),
        vreme: SEDMICNI_PODRAZUMEVANO_VREME,
        sastanakId: null,
        kreiraSeDatum: petak,
      };
    }
    petak = plusDana(petak, 7);
  }
  return null;
}
