import { UnprocessableEntityException } from "@nestjs/common";

/**
 * Intervali servisnog plana (zahtev 073/26 — „ne mogu da sačuvam servisni plan").
 *
 * Servis automobila se u praksi vodi po kilometraži, po vremenu, ili po oba
 * („mali servis: 15.000 km ili 12 meseci, šta pre dođe"). Ekran je to tražio kao
 * dva odvojena polja bez oznake šta je obavezno, a validacija je odbijala `0` —
 * a `0` je upravo ono što korisnik ukuca kad hoće da kaže „ovaj servis se NE vodi
 * po mesecima". Zato je 0 ovde sinonim za „nije zadato" (NULL), a ne greška.
 *
 * Semantika (ista za create i za PATCH):
 *   `undefined` → ne diraj postojeću vrednost (PATCH izostavljen ključ)
 *   `null` / `0` → obriši / nije zadato
 *   `> 0`        → vrednost
 *   `< 0` / decimala → 422 sa porukom koja kaže ŠTA da se uradi
 *
 * Jedino tvrdo pravilo koje ostaje je ono koje i baza čuva
 * (`maint_vsp_at_least_one_interval`): plan bez ijednog intervala nema po čemu da
 * dospe, pa bi bio nem zapis koji nikad ne napravi radni nalog. Ne uklanja se —
 * ali se poruka menja tako da kaže kako da se ispravi.
 */

/** Ljudsko ime polja u poruci — isto kao labela na ekranu. */
export const INTERVAL_LABEL = {
  km: "Interval — km",
  months: "Interval — meseci",
} as const;

export type IntervalKind = keyof typeof INTERVAL_LABEL;

const EXAMPLE: Record<IntervalKind, string> = {
  km: "15000",
  months: "12",
};
const NOT_TRACKED: Record<IntervalKind, string> = {
  km: "ako se servis ne vodi po kilometraži",
  months: "ako se servis ne vodi po mesecima",
};

/**
 * Jedan interval → `null` (nije zadato) / broj > 0 / `undefined` (ne diraj).
 * Baca 422 samo za vrednost koja ne može ništa da znači (negativna / decimalna).
 */
export function normalizeInterval(
  value: number | null | undefined,
  kind: IntervalKind,
): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new UnprocessableEntityException(
      `${INTERVAL_LABEL[kind]}: unesi ceo broj (npr. ${EXAMPLE[kind]}) ili ostavi prazno ${NOT_TRACKED[kind]}.`,
    );
  }
  if (value === 0) return null; // „0" = korisnikov način da kaže „nema"
  if (value < 0) {
    throw new UnprocessableEntityException(
      `${INTERVAL_LABEL[kind]}: ne može biti negativan — unesi broj veći od 0 (npr. ${EXAMPLE[kind]}) ili ostavi prazno ${NOT_TRACKED[kind]}.`,
    );
  }
  return value;
}

/** Poruka „bar jedan interval" — jedini izvor teksta (koristi je i FE gejt). */
export const AT_LEAST_ONE_INTERVAL_MSG =
  "Servisni plan mora imati bar jedan interval: Interval — km (npr. 15000) ili " +
  "Interval — meseci (npr. 12), može i oba. Po tome sistem računa kada servis dospeva.";

/**
 * Efektivno stanje posle patch-a (`undefined` = zadrži staro) mora imati bar jedan
 * interval. Za create se `current` izostavlja (nema starog stanja).
 */
export function assertAtLeastOneInterval(
  next: {
    intervalKm?: number | null;
    intervalMonths?: number | null;
  },
  current: { intervalKm?: number | null; intervalMonths?: number | null } = {},
): void {
  const km =
    next.intervalKm === undefined
      ? (current.intervalKm ?? null)
      : next.intervalKm;
  const months =
    next.intervalMonths === undefined
      ? (current.intervalMonths ?? null)
      : next.intervalMonths;
  if (km == null && months == null) {
    throw new UnprocessableEntityException(AT_LEAST_ONE_INTERVAL_MSG);
  }
}

/**
 * IT oprema / objekti (`maint_asset_service_plan`): tamo `interval_months` je
 * NOT NULL + CHECK > 0 u bazi — nema kilometraže po kojoj bi plan mogao da dospe,
 * pa meseci ostaju obavezni. Bez ove brane prazan/`0` unos je udarao u NOT NULL
 * kao sirova Prisma greška (500) umesto u poruku koja kaže šta da se uradi.
 */
export const ASSET_INTERVAL_REQUIRED_MSG =
  "Interval — meseci je obavezan za IT opremu i objekte — unesi ceo broj meseci " +
  "veći od 0 (npr. 12). Kilometraža ovde ne postoji, pa se plan vodi samo po vremenu.";

export function normalizeAssetIntervalMonths(
  value: number | null | undefined,
  { required }: { required: boolean },
): number | undefined {
  if (value === undefined) {
    if (required)
      throw new UnprocessableEntityException(ASSET_INTERVAL_REQUIRED_MSG);
    return undefined;
  }
  if (value === null || !Number.isInteger(value) || value <= 0) {
    throw new UnprocessableEntityException(ASSET_INTERVAL_REQUIRED_MSG);
  }
  return value;
}
