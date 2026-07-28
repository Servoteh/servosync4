/**
 * Prikaz prisustva (kucanje ulaz/izlaz) — h:mm format + pravilo zaokruživanja.
 * Zahtev 032/26 („čudno sabiranje sati"): korisnik je video „Izlaz 15:58 − Ulaz 07:48
 * = 8.17 sati" i mislio da je račun pogrešan. Račun je bio TAČAN — 8,17 su decimalni
 * sati (8h 10min), ali decimalni prikaz zbunjuje, pa se prisustvo prikazuje kao „8:10".
 *
 * PRESUDA (Nenad, 28.07.2026) — pravilo zaokruživanja dnevnog zbira prisustva:
 *   - prekovremeno ispod 30 minuta se NE prikazuje → [8:00, 8:30) se piše kao „8:00";
 *   - ispod 8:00 → stvarno vreme (npr. 7:45);
 *   - 8:30 i više → stvarno vreme (npr. 9:05).
 * Mesečna suma je suma OVAKO zaokruženih dnevnih vrednosti, da se poklopi sa onim
 * što korisnik vidi po danima.
 *
 * OGRANIČENJE: ovo je isključivo PRIKAZ prisustva (Moj profil / Moj tim). Obračun
 * zarada i kadrovska mreža (`work_hours`) se ovim ne diraju — oni čitaju sirove sate.
 */

/** Puna smena u minutima. */
const FULL_SHIFT_MIN = 8 * 60;
/** Prekovremeno kraće od ovoga se ne prikazuje (piše se kao puna smena). */
const OVERTIME_TOLERANCE_MIN = 30;

/** Decimalni sati (Decimal/string/number iz baze) → celi minuti; null ako nije broj. */
export function presenceMinutes(hours: unknown): number | null {
  if (hours == null) return null;
  const n =
    typeof hours === "object" && hours !== null && "toNumber" in hours
      ? (hours as { toNumber(): number }).toNumber()
      : Number(hours);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 60);
}

/**
 * Pravilo 032/26 nad minutima: [480, 510) → 480. Sve ostalo ostaje kako jeste.
 * Namerno se NE generalizuje na ostale sate (9:20 ostaje 9:20) — tako je presuđeno.
 */
export function roundPresenceMinutes(minutes: number | null): number | null {
  if (minutes == null) return null;
  return minutes >= FULL_SHIFT_MIN &&
    minutes < FULL_SHIFT_MIN + OVERTIME_TOLERANCE_MIN
    ? FULL_SHIFT_MIN
    : minutes;
}

/** Minuti → „H:MM" (490 → „8:10"). */
export function formatHm(minutes: number | null): string | null {
  if (minutes == null) return null;
  const sign = minutes < 0 ? "-" : "";
  const abs = Math.abs(minutes);
  return `${sign}${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, "0")}`;
}

/** Sirovi decimalni sati → zaokruženi minuti (jedno mesto gde pravilo živi). */
export function presenceRoundedMinutes(hours: unknown): number | null {
  return roundPresenceMinutes(presenceMinutes(hours));
}

/** Sirovi decimalni sati → prikaz „8:00" (pravilo primenjeno). */
export function formatPresenceHm(hours: unknown): string | null {
  return formatHm(presenceRoundedMinutes(hours));
}

/** Dnevni red iz `v_attendance_daily` + izvedena polja za prikaz (sirovo ostaje netaknuto). */
export function withPresenceDisplay<T extends Record<string, unknown>>(
  rows: T[],
): (T & { presence_minutes: number | null; presence_hm: string | null })[] {
  return rows.map((r) => {
    const minutes = presenceRoundedMinutes(r.presence_hours);
    return { ...r, presence_minutes: minutes, presence_hm: formatHm(minutes) };
  });
}

/** Mesečni zbir = suma ZAOKRUŽENIH dnevnih vrednosti (minuti + h:mm + decimalni sati). */
export function sumPresence(rowsOrHours: (Record<string, unknown> | unknown)[]): {
  minutes: number;
  hm: string;
  hours: number;
} {
  const minutes = rowsOrHours.reduce<number>((acc, r) => {
    const raw =
      r !== null && typeof r === "object" && "presence_hours" in r
        ? (r as Record<string, unknown>).presence_hours
        : r;
    return acc + (presenceRoundedMinutes(raw) ?? 0);
  }, 0);
  return {
    minutes,
    hm: formatHm(minutes) as string,
    // decimalni sati zadržani zbog postojećih potrošača (mob presek, mini-stat)
    hours: Math.round((minutes / 60) * 100) / 100,
  };
}
