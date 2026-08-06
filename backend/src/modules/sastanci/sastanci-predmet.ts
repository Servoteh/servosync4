import { createHash } from "node:crypto";

/**
 * Prevod PREDMETA (`projekat_id`) između sy15 uuid-a i 3.0 `Int`-a — blokada 5
 * iz docs/SEOBA_SASTANCI_PB_2026-08-05.md §7c.
 *
 * ZAŠTO POSTOJI: kolona `projekat_id` je u sy15 bila `uuid` (FK na sy15
 * `public.projects`), a u 3.0 je `Int` (FK na 3.0 `projects.id`) — prenosna
 * odluka 2. FE danas šalje sy15 uuid (`?projekatId=…`), pa dok se on ne uskladi
 * backend mora da razume OBA oblika. Bez toga `create-sastanak` pod `3.0` ćutke
 * ispušta predmet (rep zabeležen u runbook-u §7e).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 🔴 NALAZ KOJI OBARA „SAMO IZRAČUNAJ" PRISTUP
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * sy15 ima funkciju `pb_predmet_project_uuid(p_item_id integer)` koja uuid
 * IZVODI iz 3.0 id-a (uuid5-oblik nad `md5('servoteh_pb_predmet:v1:'||id)`).
 * Runbook (§2) je iz nje zaključio da je „`projects.id = uuid5(bigtehn_item_id)`",
 * pa bi se prevod mogao raditi ČISTIM RAČUNOM, bez ijedne tabele.
 *
 * **Izmereno nad ŽIVOM sy15 (06.08.2026) — to NE VAŽI za sve redove:**
 *
 * ```sql
 * SELECT count(*)                                                    -- 23 ukupno
 *      , count(bigtehn_item_id)                                      -- 22
 *      , count(*) FILTER (WHERE id = pb_predmet_project_uuid(bigtehn_item_id))
 *   FROM public.projects;                                            -- 20  🔴
 * ```
 *
 * **20 od 22 se poklapa; DVA reda imaju uuid koji NIJE izveden** (v4-nasumični
 * — nastali pre nego što je funkcija uvedena):
 *
 * | 3.0 `projects.id` | šifra | uuid u sy15 | uuid koji bi RAČUN dao |
 * |---|---|---|---|
 * | 9068 | 7701 | `bc09f06f-81f8-4601-…` | `aeba8c00-bdf6-5083-…` |
 * | 9470 | 9000 | `a60c610f-9ac1-4fe0-…` | `02b694d1-7bcf-5e7a-…` |
 *
 * A ta dva NISU mrtvi redovi: domen koristi **15 različitih predmeta i 2 od tih
 * 15 su baš ova dva** (mereno nad `akcioni_plan`/`sastanci`/`pm_teme`). Čist
 * račun bi ih tiho promašio — isti obrazac kao zamka BigBit artikala
 * (uparivanje po `items.id` = 0/92.511). Zato ovde stoje OBA puta: izvedeni
 * (za 20, i za svaki budući red koji funkcija napravi) i **izmerena tabela
 * izuzetaka** za ta dva.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * BEZBEDAN SMER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Neprepoznat uuid **NE postaje `null`** nego 422. Tiho ispuštanje predmeta je
 * tačno kvar koji ovaj modul zatvara — nevidljiv je dok neko ne primeti da
 * akcija nema RN. Bolje je odbiti zahtev sa porukom.
 *
 * ŽIVOTNI VEK: prevod je PRELAZNI most. Kad FE počne da šalje `Int` (i da čita
 * `projekatId` kao broj), uuid grana i ova tabela izuzetaka se brišu — a sve
 * dotad odgovor nosi OBA oblika (`projekatId` + `projekatUuid`) da stari i novi
 * klijent rade istovremeno.
 */

/** Prefiks koji sy15 `pb_predmet_project_uuid` koristi kao „namespace". */
const PREDMET_NAMESPACE = "servoteh_pb_predmet:v1:";

/**
 * Doslovan prepis sy15 `pb_predmet_project_uuid(integer)`:
 *
 * ```sql
 * substr(m,1,8) ||'-'|| substr(m,9,4) ||'-'|| '5'||substr(m,13,3)
 *               ||'-'|| '8'||substr(m,17,3) ||'-'|| substr(m,21,12)
 *   FROM (SELECT md5('servoteh_pb_predmet:v1:' || p_item_id::text) AS m) s
 * ```
 *
 * ⚠️ Znakovi na pozicijama 16 i 20 (1-indeksirano) se NAMERNO PRESKAČU — tako
 * izvor pravi mesto za oznaku verzije `5` i varijante `8`. Prepis mora da ih
 * preskoči isto, inače bi svih 20 izvedenih uuid-a bilo pogrešno.
 * (Provereno: TS i PG daju identičan rezultat za sva 22 živa reda.)
 */
export function predmetUuidIzracunaj(id: number): string {
  const m = createHash("md5")
    .update(`${PREDMET_NAMESPACE}${String(id)}`)
    .digest("hex");
  return (
    `${m.slice(0, 8)}-${m.slice(8, 12)}-5${m.slice(12, 15)}` +
    `-8${m.slice(16, 19)}-${m.slice(20, 32)}`
  );
}

/**
 * IZMERENI izuzeci: sy15 `projects` redovi čiji uuid NIJE izveden računom.
 * Popunjeno iz žive sy15 06.08.2026 (`SELECT id, bigtehn_item_id FROM projects
 * WHERE id <> pb_predmet_project_uuid(bigtehn_item_id)`), NE iz dokumentacije.
 *
 * Tabela je namerno MALA i doslovna: to su dva zatečena reda, ne pravilo. Kad
 * FE pređe na `Int`, ceo modul (pa i ova tabela) nestaje.
 */
const LEGACY_UUID_PO_ID = new Map<number, string>([
  // šifra 7701 — „Linije za termičku obradu otkovaka…"
  [9068, "bc09f06f-81f8-4601-a4c9-5bfba27423b4"],
  // šifra 9000 — „Perun - automatski punjač"
  [9470, "a60c610f-9ac1-4fe0-b9c4-fda481e04c58"],
]);

/** Obrnut smer izmerenih izuzetaka (uuid -> Int), sračunat jednom. */
const LEGACY_ID_PO_UUID = new Map<string, number>(
  [...LEGACY_UUID_PO_ID].map(([id, uuid]) => [uuid, id]),
);

/**
 * 3.0 `projects.id` -> uuid koji je taj predmet imao u sy15.
 * Izmereni izuzetak ima prednost nad računom — inače bi stari FE, koji predmet
 * poredi sa svojom keširanom listom, za ta dva predmeta dobio uuid koji nigde
 * ne postoji.
 */
export function predmetUuid(id: number): string {
  return LEGACY_UUID_PO_ID.get(id) ?? predmetUuidIzracunaj(id);
}

/** Da li string liči na uuid (bez provere verzije — izuzeci su v4). */
export function jeUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    v.trim(),
  );
}

/**
 * Ulaz iz DTO-a (uuid string, ceo broj, ili numerički string) sveden na jedan
 * od tri oblika. `null` je EKSPLICITNO brisanje veze (FE šalje `null` da skine
 * predmet), `undefined` je „polje nije poslato".
 */
export type PredmetUlaz = string | number | null | undefined;

export type PredmetRazresen =
  | { vrsta: "nedirano" }
  | { vrsta: "obrisi" }
  | { vrsta: "id"; id: number }
  | { vrsta: "uuid"; uuid: string };

/**
 * Klasifikacija ulaza BEZ dodira baze. Odvojeno od razrešavanja jer se `Int`
 * put (koji će posle FE deploy-a biti jedini) ne sme naplatiti upitom.
 */
export function klasifikujPredmet(v: PredmetUlaz): PredmetRazresen {
  if (v === undefined) return { vrsta: "nedirano" };
  if (v === null || v === "") return { vrsta: "obrisi" };
  if (typeof v === "number") {
    if (!Number.isInteger(v) || v <= 0) {
      throw new Error(`Predmet (projekatId) nije ispravan: ${v}`);
    }
    return { vrsta: "id", id: v };
  }
  const s = v.trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (!Number.isSafeInteger(n) || n <= 0) {
      throw new Error(`Predmet (projekatId) nije ispravan: ${s}`);
    }
    return { vrsta: "id", id: n };
  }
  if (jeUuid(s)) return { vrsta: "uuid", uuid: s.toLowerCase() };
  throw new Error(`Predmet (projekatId) nije ni broj ni uuid: ${s}`);
}

/**
 * Razrešavanje uuid-a u `Int` nad DATIM skupom kandidata (3.0 `projects.id`).
 *
 * Zašto skup kandidata a ne obrnuta formula: md5 je jednosmeran, pa se uuid ne
 * može „vratiti" u broj — jedini put je izračunati uuid za svaki poznat id i
 * uporediti. Zato ova funkcija prima ID-jeve, a pozivalac (servis) ih čita iz
 * baze i kešira.
 *
 * Izmereni izuzeci se proveravaju PRVI — njihov uuid račun nikad ne bi pogodio.
 */
export function predmetIdIzUuid(
  uuid: string,
  kandidati: Iterable<number>,
): number | null {
  const key = uuid.trim().toLowerCase();
  const legacy = LEGACY_ID_PO_UUID.get(key);
  if (legacy !== undefined) return legacy;
  for (const id of kandidati) {
    if (predmetUuidIzracunaj(id) === key) return id;
  }
  return null;
}

/** ID-jevi izmerenih izuzetaka — servis ih mora imati u skupu kandidata. */
export function legacyPredmetIds(): number[] {
  return [...LEGACY_UUID_PO_ID.keys()];
}

/**
 * Vrednost predmeta za **sy15 granu** (kolona je tamo i dalje `uuid`).
 *
 * Pod `SASTANCI_IZVOR=sy15` ponašanje mora ostati bajt-za-bajt isto: uuid iz
 * zahteva prolazi NEPROMENJEN (osim spuštanja na mala slova, što Postgres
 * `uuid` tip ionako radi). Grana za `Int` postoji samo zato što DTO od sada
 * prima i taj oblik — dok FE ne pređe, ona se u praksi ne poziva.
 */
export function predmetZaSy15(v: PredmetUlaz): string | null | undefined {
  const k = klasifikujPredmet(v);
  switch (k.vrsta) {
    case "nedirano":
      return undefined;
    case "obrisi":
      return null;
    case "uuid":
      return k.uuid;
    case "id":
      return predmetUuid(k.id);
  }
}

/**
 * Izlazni oblik predmeta uz svaki red koji ga nosi.
 *
 * 🔴 ZAŠTO OBA POLJA: 3.0 Prisma model kolonu `projekat_id` zove `projectId`, a
 * sy15 model ju je zvao `projekatId` — sam prelazak na 3.0 bi, bez ovoga, tiho
 * PREIMENOVAO polje u svakom odgovoru i FE bi svuda video „bez predmeta".
 * Zato izlaz zadržava ime `projekatId` (sad `Int`) i DODAJE `projekatUuid` za
 * klijente koji još porede po uuid-u. Posle FE deploy-a `projekatUuid` odlazi.
 */
export interface PredmetIzlaz {
  projekatId: number | null;
  projekatUuid: string | null;
}

export function predmetIzlaz(id: number | null | undefined): PredmetIzlaz {
  if (id == null) return { projekatId: null, projekatUuid: null };
  return { projekatId: id, projekatUuid: predmetUuid(id) };
}

/**
 * Red iz 3.0 baze -> red za klijenta: `projectId` se zamenjuje parom
 * `projekatId`/`projekatUuid`. Ostala polja se ne diraju.
 */
export function saPredmetom<T extends { projectId?: number | null }>(
  row: T,
): Omit<T, "projectId"> & PredmetIzlaz {
  const { projectId, ...ostalo } = row;
  return { ...ostalo, ...predmetIzlaz(projectId) } as Omit<T, "projectId"> &
    PredmetIzlaz;
}
