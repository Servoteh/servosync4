# CUTOVER — Održavanje (CMMS): mapa deep-linkova 1.0 → 2.0

**Paket:** Talas F / F2-P5b (QR deep-link code→id resolver)
**Namena:** referenca za 1.0 SPA router u **Fazi 3** cutover-a (`MIGRACIJA_3.0_PLAYBOOK`).
Kad se modul Održavanje preseli u 2.0 iframe, 1.0 router presreće sve `/maintenance/*`
putanje i prevodi ih u 2.0 iframe subPath prema tabeli ispod.

## Zašto po `asset_code` (šifri), ne po `id` (UUID)

Odštampane QR nalepnice (IT + Objekti u 1.0) i sve interne 1.0 rute ključaju sredstvo
**po `asset_code`** (npr. `8.3`, `BG3088TK`), NIKAD po UUID-u. Šifra preživljava re-seed
baze; UUID ne. Zato:

- 2.0 kartoni renderuju QR sa `?code=<asset_code>` (ne `?id=<uuid>`) — nalepnica
  odštampana iz 2.0 poklapa 1.0 format i radi i posle re-seed-a.
- 2.0 rute kartona (`vozila`, `sredstva`) prihvataju **i `?code=`** pored `?id=`.
  Resolver (`VoziloKartonByCode` / `SredstvoKartonByCode`) razrešava
  `code → asset_id` preko `GET /maintenance/assets` (match `asset_code`
  case-insensitive, filtriran po tipu; uključuje i arhivirana sredstva), pa čisti URL
  na `?id=` uz očuvan `?tab=`.
- Mašina je oduvek ključana po `machine_code` (PK) — `/odrzavanje/masine?code=` (P1).

## Host

Odštampane nalepnice trajno enkodiraju host sa kojeg su štampane
(`window.location.origin`), tj. **`servosync.servoteh.com`**. Taj host MORA ostati živ
posle seobe — 1.0 SPA na njemu presreće `/maintenance/*` i radi prevod. Nalepnice ne
enkodiraju 2.0 tehnički host (`servosync2…`) i ne smeju se preštampavati po šifri.

## Mapa — kartoni sredstava (deep-link po šifri)

| 1.0 URL (nalepnica / ruta)                     | 2.0 iframe subPath                                  |
|------------------------------------------------|-----------------------------------------------------|
| `/maintenance/machines/<code>` `[?tab=…]`      | `/odrzavanje/masine?code=<code>` `[&tab=…]`         |
| `/maintenance/assets/vehicles/<code>`          | `/odrzavanje/vozila?code=<code>`                    |
| `/maintenance/assets/it/<code>`                | `/odrzavanje/sredstva?code=<code>&kind=it`          |
| `/maintenance/assets/facilities/<code>`        | `/odrzavanje/sredstva?code=<code>&kind=facility`    |

- `<code>` se prosleđuje `encodeURIComponent`-ovan (šifre sadrže `.`, `/`, razmake).
- `?tab=` sa mašine (npr. `checks`/`history`) prosleđuje se dalje; karton mašine ga
  čita. Vozilo/IT/objekat karton takođe podržavaju `?tab=` (pregled/servis/…), pa 1.0
  može dodati `&tab=` ako zatreba.

## Mapa — sekcije modula (iz `appPaths.js` `pathnameToRoute`)

2.0 glavna strana (`/odrzavanje`) čita `?tab=<key>` na učitavanju (H23), pa sekcijski
link/bookmark sleće na tačan tab. `?machine=<code>` i dalje redirektuje na karton mašine.

| 1.0 URL                                   | 1.0 `section`         | 2.0 iframe subPath                    |
|-------------------------------------------|-----------------------|---------------------------------------|
| `/maintenance`                            | `dashboard`           | `/odrzavanje`  (tab „Pregled")        |
| `/maintenance/board`                      | `board`               | `/odrzavanje?tab=board`               |
| `/maintenance/work-orders`                | `workorders`          | `/odrzavanje?tab=nalozi`              |
| `/maintenance/machines`                   | `machines`            | `/odrzavanje?tab=masine`              |
| `/maintenance/catalog`                    | `catalog`             | `/odrzavanje?tab=masine`              |
| `/maintenance/katalog`                    | `assetsMachines` (→)  | `/odrzavanje?tab=masine`              |
| `/maintenance/assets`                     | `dashboard` (→)       | `/odrzavanje`                         |
| `/maintenance/assets/machines`            | `assetsMachines`      | `/odrzavanje?tab=masine`              |
| `/maintenance/assets/vehicles`            | `assetsVehicles`      | `/odrzavanje?tab=vozila`              |
| `/maintenance/assets/it`                  | `assetsIt`            | `/odrzavanje?tab=it`                  |
| `/maintenance/assets/facilities`          | `assetsFacilities`    | `/odrzavanje?tab=objekti`             |
| `/maintenance/drivers`                    | `drivers`             | `/odrzavanje?tab=vozaci`              |
| `/maintenance/drivers/<id>`               | `driverCard`          | `/odrzavanje?tab=vozaci`  (v. napomenu) |
| `/maintenance/preventive`                 | `preventive`          | `/odrzavanje?tab=preventiva`          |
| `/maintenance/rokovi`                     | `preventive` (→)      | `/odrzavanje?tab=preventiva`          |
| `/maintenance/calendar`                   | `calendar`            | `/odrzavanje?tab=kalendar`            |
| `/maintenance/inventory`                  | `inventory`           | `/odrzavanje?tab=zalihe`              |
| `/maintenance/locations`                  | `locations`           | `/odrzavanje?tab=zalihe`              |
| `/maintenance/documents`                  | `documents`           | `/odrzavanje?tab=dokumenta`           |
| `/maintenance/documents/vehicles`         | `documentsVehicles`   | `/odrzavanje?tab=dokumenta`           |
| `/maintenance/reports`                    | `reports`             | `/odrzavanje?tab=izvestaji`           |
| `/maintenance/notifications`              | `notifications`       | `/odrzavanje?tab=notifikacije`        |
| `/maintenance/settings`                   | `settings`            | `/odrzavanje?tab=podesavanja`         |

(→) = 1.0 već interno redirektuje tu sekciju (v. `pathnameToRoute` `redirectTo`).

## Napomene / poznata ograničenja

- **Karton vozača** (`/maintenance/drivers/<id>`) u 2.0 još nema zasebnu rutu kartona —
  vozači su tab (`vozaci`). Deep-link vodi na tab „Vozači". Ako karton vozača dobije
  rutu, dopuniti mapu (`/odrzavanje/vozaci?id=<id>`).
- **`?tab=` filteri** (npr. 1.0 `?status=`, `?deadline=`, `?open=` na listama) NISU
  preslikani — sleće se na tab bez pretpodešenog filtera. Nije cutover-blokada
  (funkcija dostupna, samo bez pred-filtera). Kandidat za kasniju doradu ako zatreba.
- **`kind` je obavezan** na `/odrzavanje/sredstva` — bez validnog `kind` (`it`/`facility`)
  ruta vraća na `/odrzavanje`. 1.0 router UVEK zna tip iz putanje (`it` vs `facilities`),
  pa mora postaviti odgovarajući `kind`.
- **Sredstvo nije nađeno** (šifra obrisana/preimenovana): resolver prikazuje jasnu
  poruku „Nije pronađeno …" + link na listu — nikad prazna strana.
