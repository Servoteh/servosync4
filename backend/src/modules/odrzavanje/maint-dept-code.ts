/**
 * Prepis sy15 `public.maint_machine_dept_code(text)` — čist račun, bez baze.
 *
 * Izvor: `pg_get_functiondef` sa ŽIVE sy15, 06.08.2026. Funkcija je tamo
 * `IMMUTABLE` i ne dodiruje nijednu tabelu — mapira šifru mašine u šifru „hale"
 * (`loc_locations.location_code`) po fiksnim spiskovima i prefiksima.
 *
 * ZAŠTO JE OVDE, A NE U MIGRACIJI: jedini potrošač je most ka Lokacijama
 * (`maint_machines_sync_to_loc`, v. `odrzavanje-lokacije-most.service.ts`), a taj
 * most pod `3.0` mora da RAČUNA šifru hale u aplikaciji — mašine su tada u 3.0
 * bazi, a `loc_locations` (i ova funkcija) su još u sy15. Prepis mora biti
 * DOSLOVAN: promašena hala znači da mašina tiho izostane iz stabla lokacija.
 *
 * 🔴 Redosled uslova je deo pravila. `CASE` u PostgreSQL-u uzima PRVI tačan
 * uslov, pa npr. `6.8` mora da padne kroz granu brušenja (ona ga izričito
 * izuzima) na `M.OST`, a `21.x` ne sme da uđe u struganje. Prepis koji bi
 * uslove preuredio dao bi druge hale za granične šifre.
 */

/** Sečenje i savijanje. */
const M_SEC = new Set([
  "1.10",
  "1.2",
  "1.30",
  "1.40",
  "1.50",
  "1.60",
  "1.71",
  "1.72",
]);
/** Bravarsko. */
const M_BRA = new Set(["4.1", "4.11", "4.12", "4.2", "4.3", "4.4"]);
/** Farbanje (5.1–5.8 + 5.11) — 5.9 i 5.10 NAMERNO idu u „Ostalo". */
const M_FAR = new Set([
  "5.1",
  "5.2",
  "5.3",
  "5.4",
  "5.5",
  "5.6",
  "5.7",
  "5.8",
  "5.11",
]);
/** CAM. */
const M_CAM = new Set(["17.0", "17.1"]);
/** Erodiranje. */
const M_ERO = new Set(["10.1", "10.2", "10.3", "10.4", "10.5"]);

/** Šifra hale (`loc_locations.location_code`) za datu šifru mašine. */
export function maintMachineDeptCode(machineCode: string | null | undefined): string {
  const c = machineCode ?? "";
  if (c.trim().length === 0) return "M.OST";
  if (M_SEC.has(c)) return "M.SEC";
  if (M_BRA.has(c)) return "M.BRA";
  if (M_FAR.has(c)) return "M.FAR";
  if (M_CAM.has(c)) return "M.CAM";
  // Ažistiranje — SAMO 8.2 (ne ceo prefiks 8).
  if (c === "8.2") return "M.AZI";
  if (M_ERO.has(c)) return "M.ERO";
  // Brušenje: prefiks 6 osim 6.8.
  if (c.startsWith("6.") && c !== "6.8") return "M.BRU";
  if (c === "6") return "M.BRU";
  // Glodanje: prefiks 3.
  if (c.startsWith("3.") || c === "3") return "M.GLO";
  // Struganje: prefiks 2 osim 21.x (3D štampa).
  if (
    (c.startsWith("2.") || c === "2") &&
    !c.startsWith("21.") &&
    c !== "21"
  ) {
    return "M.STR";
  }
  return "M.OST";
}
