/*
 * Europe/Belgrade vreme BEZ zavisnosti (Intl API) — za scheduler (Talas A).
 * Poslovi se zakazuju u LOKALNOM pogonskom vremenu („korektivne 07:30",
 * „sedmični sastanak petak 08:00") pa DST mora biti tačan: 1.0 je to rešavao
 * duplim UTC cron-ovima + guardom („kreiraj samo kad je LOKALNO 08h"); ovde
 * računamo lokalno vreme direktno, pa je guard nepotreban.
 */

export interface BelgradeParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number;
  minute: number;
  second: number;
  /** 1 = ponedeljak … 7 = nedelja (ISO). */
  isoDow: number;
}

const PARTS_FMT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Belgrade",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  weekday: "short",
  hour12: false,
});

const DOW: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

/** Rastavi UTC trenutak na Europe/Belgrade lokalne delove. */
export function belgradeParts(at: Date): BelgradeParts {
  const parts = PARTS_FMT.formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    // Intl ume da vrati "24" za ponoć na nekim runtime-ovima — normalizuj.
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    second: Number(get("second")),
    isoDow: DOW[get("weekday")] ?? 0,
  };
}

/** Ofset Beograda prema UTC u ms u datom trenutku (+1h zimi, +2h leti). */
function belgradeOffsetMs(at: Date): number {
  const p = belgradeParts(at);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // Zaokruži na sekund (formatToParts nema ms) — dovoljno za minutne poslove.
  return asIfUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * UTC trenutak za zadato Europe/Belgrade lokalno vreme. Dve iteracije rešavaju
 * DST prelaze (ofset zavisi od rezultata). Nepostojeće vreme u prolećnom
 * preskoku (02:00→03:00) mapira se na sat kasnije — posao se izvrši, ne preskače.
 */
export function belgradeTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = new Date(targetAsUtc - 3600_000); // CET pretpostavka
  for (let i = 0; i < 2; i++) {
    guess = new Date(targetAsUtc - belgradeOffsetMs(guess));
  }
  return guess;
}

/** Lokalni datum pomeren za `days` dana (kalendarski, preko UTC podneva — DST-safe). */
export function shiftBelgradeDate(
  p: { year: number; month: number; day: number },
  days: number,
): { year: number; month: number; day: number } {
  const noon = new Date(Date.UTC(p.year, p.month - 1, p.day, 12, 0, 0));
  noon.setUTCDate(noon.getUTCDate() + days);
  return { year: noon.getUTCFullYear(), month: noon.getUTCMonth() + 1, day: noon.getUTCDate() };
}
