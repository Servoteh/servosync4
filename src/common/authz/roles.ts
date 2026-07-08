/**
 * Jedinstveni katalog RBAC uloga — IZVOR ISTINE za ServoSync 2.0 i 3.0.
 * Objedinjuje 1.0 taksonomiju (servoteh-plan-montaze/docs/servosync2_role_taxonomy.md)
 * i 2.0 predlog (docs/design/RBAC_RLS_PREDLOG.md) → docs/design/AUTHZ_UNIFIED.md.
 *
 * Konvencija (odluka 2026-07-08, BACKEND_RULES §2.2): ključ role = **lowercase snake_case**
 * (kao 1.0 prod CHECK `user_roles_role_allowed`). Ne UPPERCASE.
 *
 * Princip (1.0 taxonomy §1): **uloga ≠ radno mesto**. Uloga je profil pristupa; titula
 * (bravar/zavarivač/monter/tim lider) živi u sistematizaciji/`job_positions`, ne ovde.
 * Nova uloga se uvodi SAMO kad ima drukčiji profil pristupa I postoji modul koji je štiti;
 * imena se smeju REZERVISATI unapred (da 3.0 nema koliziju), ali rezervacija ≠ aktivacija.
 *
 * V1: `PermissionsGuard` je NO-OP (svi ulogovani = ADMIN). Ovaj katalog je pripremljen za V2
 * aktivaciju (uključivanje logike u guardu + seed `user_roles`), bez prepravke kontrolera.
 */

/** Faza aktivacije uloge. */
export type RoleTier =
  | "v1" // aktivno odmah (samo `admin`)
  | "v2" // aktivira se sa modulima 2.0 (proizvodni core / Tehnologija)
  | "3.0" // ime rezervisano; aktivira se pri objedinjavanju 1.0 na 2.0 stack
  | "deferred" // aktivira se TEK sa svojim modulom (Nabavka/Kvalitet/CRM/Finansije)
  | "prelazno"; // postoji u šemi, migrira se u drugu ulogu

export interface RoleMeta {
  key: string;
  label: string;
  /** 1.0 | 2.0 | oba — odakle uloga potiče. */
  origin: "1.0" | "2.0" | "oba";
  /** Modul koji je uvodi (princip „uloga se uvodi sa modulom"). */
  module: string;
  tier: RoleTier;
  note?: string;
}

/**
 * Kanonski ključevi uloga. Koristi ove konstante umesto string-literala.
 */
export const ROLES = {
  ADMIN: "admin",
  MENADZMENT: "menadzment",
  SEF: "sef",
  TEHNOLOG: "tehnolog",
  CNC_PROGRAMER: "cnc_programer",
  KONTROLOR: "kontrolor",
  MAGACIONER: "magacioner",
  PROIZVODNI_RADNIK: "proizvodni_radnik",
  NABAVKA_VIEW: "nabavka_view",
  // Rezervisano za 3.0 (imena zaključana da spajanje 1.0 ne dobije koliziju)
  TIM_LIDER: "tim_lider",
  MONTER: "monter",
  CNC_OPERATER: "cnc_operater",
  PM: "pm",
  LEADPM: "leadpm",
  HR: "hr",
  POSLOVNI_ADMIN: "poslovni_admin",
  PROJEKTANT_VODJA: "projektant_vodja",
  INZENJER: "inzenjer",
  TEHNICAR_ODRZAVANJA: "tehnicar_odrzavanja",
  VIEWER: "viewer",
  // Deferred (aktivira se sa svojim modulom)
  NABAVKA: "nabavka",
  KVALITET: "kvalitet",
  PRODAJA: "prodaja",
  FINANSIJE: "finansije",
  // Prelazno
  USER: "user",
} as const;

export type RoleKey = (typeof ROLES)[keyof typeof ROLES];

/**
 * Metapodaci po ulozi. Redosled = prioritetni (viši = jači) za `effectiveRole`
 * izbor kad korisnik ima više dodela (paralela 1.0 `effectiveRoleFromMatches`).
 */
export const ROLE_CATALOG: RoleMeta[] = [
  { key: ROLES.ADMIN, label: "Admin", origin: "oba", module: "Core/Auth", tier: "v1", note: "Sve (korisnici, sync, audit, kasnije zarade)." },
  { key: ROLES.MENADZMENT, label: "Menadžment", origin: "oba", module: "Cross", tier: "v2", note: "Uvid + write u operativi; Kadrovska scoped po managed_sub_department_ids; bez zarada. Može validirati završen TP (audit)." },
  { key: ROLES.SEF, label: "Šef proizvodnje", origin: "2.0", module: "Tehnologija + RN", tier: "v2", note: "Pun TEHNOLOGIJA + approve/launch RN + write strukture + plan proizvodnje. Apsorbuje CMMS chief. ≠ tim_lider." },
  { key: ROLES.TEHNOLOG, label: "Tehnolog", origin: "2.0", module: "Tehnologija", tier: "v2", note: "Pun modul TEHNOLOGIJA (TP/operacije/dokumentacija/šifarnici). Autor + potpis TP." },
  { key: ROLES.CNC_PROGRAMER, label: "CNC programer", origin: "2.0", module: "Tehnologija — CNC", tier: "v2", note: "Pun TEHNOLOGIJA, fokus CNC programi (tabela cnc_programs). Potpisuje TP. PAZI: ≠ cnc_operater." },
  { key: ROLES.KONTROLOR, label: "Kontrolor", origin: "2.0", module: "Tehnologija — Kvalitet", tier: "v2", note: "Uža aktivacija 1.0 'kvalitet' unutar Tehnologije: primopredaje/dorada/škart. Validira završen TP finalnom kontrolom (audit)." },
  { key: ROLES.MAGACIONER, label: "Magacioner", origin: "oba", module: "Lokacije delova", tier: "v2", note: "Lokacije delova write. 3.0: + reversi, CMMS magacin." },
  { key: ROLES.PROIZVODNI_RADNIK, label: "Proizvodni radnik", origin: "oba", module: "RN / Proizvodnja", tier: "v2", note: "Objedinjuje 1.0 proizvodni_radnik + 2.0 draft 'radnik'. Vidi svoje RN/operacije po machine_access; unos rada (barkod)." },
  { key: ROLES.NABAVKA_VIEW, label: "Nabavka (uvid)", origin: "2.0", module: "MRP / Nabavka", tier: "v2", note: "SAMO uvid — read podskup 1.0-deferred 'nabavka'. Puna nabavka čeka modul Nabavka." },

  { key: ROLES.TIM_LIDER, label: "Tim lider", origin: "1.0", module: "Plan montaže / Proizvodnja", tier: "3.0", note: "Pogonski šef BEZ Kadrovske (edit svog pododeljenja). NE mapirati u sef." },
  { key: ROLES.MONTER, label: "Monter", origin: "1.0", module: "Montaža / Servis", tier: "3.0", note: "Mašinski/elektro monter + serviser. Ulazi u 3.0 sa modulom Montaža. Titula 'monter' ≠ ova uloga." },
  { key: ROLES.CNC_OPERATER, label: "CNC operater", origin: "oba", module: "Proizvodnja — pregled+štampa", tier: "3.0", note: "Nizak nivo: pregled proizvodnje + štampa nalepnica. Držati ODVOJENO od cnc_programer." },
  { key: ROLES.PM, label: "Projekt menadžer", origin: "oba", module: "Projekti / PB", tier: "3.0", note: "Per-projekat dodela (scopeType='project')." },
  { key: ROLES.LEADPM, label: "Lead PM", origin: "oba", module: "Projekti / PB", tier: "3.0", note: "Per-projekat dodela." },
  { key: ROLES.HR, label: "HR", origin: "oba", module: "Kadrovska", tier: "3.0", note: "Kadrovska bez zarada." },
  { key: ROLES.POSLOVNI_ADMIN, label: "Poslovni administrator", origin: "oba", module: "Kadrovska (bez ugovora/zarada)", tier: "3.0", note: "Operativa; PII dokumenti; bez ugovora/zarada." },
  { key: ROLES.PROJEKTANT_VODJA, label: "Projektant (vođa)", origin: "oba", module: "Projektni biro", tier: "3.0", note: "Zamenjuje draft PROJEKTNI_BIRO. Uz flag `finalni_potpisnik` (per-user override, ne uloga)." },
  { key: ROLES.INZENJER, label: "Inženjer", origin: "oba", module: "Projektni biro", tier: "3.0", note: "Ograničen edit: status/završenost/komentari." },
  { key: ROLES.TEHNICAR_ODRZAVANJA, label: "Tehničar održavanja", origin: "2.0", module: "Održavanje / CMMS", tier: "3.0", note: "Iz CMMS 'technician'. 1.0 ekvivalent živi u maint_user_profiles.role (paralelni sistem)." },
  { key: ROLES.VIEWER, label: "Viewer", origin: "oba", module: "—", tier: "3.0", note: "Read-only / eksterni. Fallback uloga." },

  { key: ROLES.NABAVKA, label: "Nabavka (puna)", origin: "1.0", module: "🔮 Nabavka", tier: "deferred", note: "Tim lider + admin nabavke (read+write). Aktivira se sa modulom Nabavka." },
  { key: ROLES.KVALITET, label: "Kvalitet (pun)", origin: "1.0", module: "🔮 Kvalitet", tier: "deferred", note: "Širi od kontrolor (koji pokriva samo primopredaje u Tehnologiji)." },
  { key: ROLES.PRODAJA, label: "Prodaja", origin: "1.0", module: "🔮 CRM / Ponude", tier: "deferred" },
  { key: ROLES.FINANSIJE, label: "Finansije", origin: "1.0", module: "🔮 Finansije", tier: "deferred", note: "Sad admin-only." },

  { key: ROLES.USER, label: "(prelazno)", origin: "2.0", module: "—", tier: "prelazno", note: "Šema default 'USER'. Posle V2 se mapira u viewer. Legacy 1.0 'user' se poklapa." },
];

/** Uloge aktivne u 2.0 (v1 + v2). */
export const ACTIVE_2_0_ROLES = ROLE_CATALOG.filter((r) => r.tier === "v1" || r.tier === "v2").map((r) => r.key);

/** Sve poznate uloge (za DB CHECK / validaciju dodele). */
export const ALL_ROLE_KEYS = ROLE_CATALOG.map((r) => r.key);

const CATALOG_BY_KEY = new Map(ROLE_CATALOG.map((r) => [r.key, r]));
export const getRoleMeta = (key: string): RoleMeta | undefined => CATALOG_BY_KEY.get(key);
export const isKnownRole = (key: string): key is RoleKey => CATALOG_BY_KEY.has(key);
