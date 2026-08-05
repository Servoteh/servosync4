# Seoba reversa na 3.0 bazu — merenje, priprema i runbook (05.08.2026)

Korak 1 iz [PLAN_GASENJA_SY15_2026-08-03.md](PLAN_GASENJA_SY15_2026-08-03.md).
**Ništa od ovoga nije primenjeno na produkciji.** Sve merenje je rađeno `SELECT`-om nad
živom sy15 bazom; migracija i prenos su napisani i dokazani na *odvojenoj probnoj bazi*.

---

## 1. Merenje — brojevi se poklapaju, ali premisa ne

`count(*)` nad živom sy15 (05.08.2026). `ANALYZE` nije bio potreban: `count(*)` je egzaktan
bez obzira na statistiku, a poređenje sa `n_live_tup` pokazuje da statistika **ovde** ne laže
(za razliku od BigTehn keša — nalaz 2 u planu gašenja).

| Tabela | `count(*)` | `n_live_tup` | Slaže se sa planom |
|---|---:|---:|:--:|
| `rev_api_idempotency` | 643 | 643 | ✅ |
| `rev_tools` | 47 | 47 | ✅ |
| `rev_inventory_subgroups` | 45 | 45 | ✅ |
| `rev_document_lines` | 42 | 42 | ✅ |
| `rev_recipient_locations` | 28 | 28 | ✅ |
| `rev_documents` | 27 | 27 | ✅ |
| `rev_inventory_groups` | 3 | 3 | ✅ |
| `rev_tool_batteries` | 2 | 2 | ✅ |
| `rev_tool_stock_ledger` | 1 | 1 | ✅ |
| `rev_cutting_tool_catalog`, `rev_cutting_tool_stock`, `rev_document_cutting_assignees`, `rev_inventory_subsubgroups`, `rev_machine_heads`, `rev_tool_service_log` | 0 | 0 | ✅ |

**Poslovnih redova za prenos: 195** (bez `rev_api_idempotency`). Podataka nema — problem je drugde.

### 🔴 Nalaz 1: `rev_api_idempotency` NIJE tabela reversa

Uprkos prefiksu, to je **registar idempotencije cele aplikacije**
(`Sy15Service.runIdempotent` / `runIdempotentRls`). Od 643 reda **samo 2 su reversi**:

| Domen | Redova |
|---|---:|
| kadrovska (`kadr.*`) | 476 |
| sastanci | 56 |
| moj-profil (`profile.*`) | 60 |
| projektni biro (`pb.*`) | 31 |
| održavanje | 16 |
| **reversi** | **2** |
| smoke | 1 |

Svi ti domeni **ostaju u sy15**. Mehaničko „preseli sve `rev_*`" polomilo bi im idempotenciju
(dupli klik = duplo odobrenje odmora, dupla faktura održavanja…). **Ne seli se; kreće od nule.**
Ime je istorijsko — reversi su bili prvi modul koji je koristio registar.

### 🔴 Nalaz 2: premisa „reversi nemaju SECURITY DEFINER logiku u bazi" je netačna

Plan gašenja (§2.1) svrstava reverse u „ide preko Prisma klijenta, najlakši deo". Izmereno:

| Šta | Koliko |
|---|---:|
| `SECURITY DEFINER` funkcija u `rev_*` prostoru | **23** |
| od toga poziva ih 3.0 kod direktno | 13 |
| `v_rev_*` view-ova | **15** (kod čita 12) |
| trigera na `rev_*` | 12 |
| RLS politika na `rev_*` | 42 (na 15/15 tabela) |
| sekvenci | 2 |
| `$queryRaw` poziva u `reversi.service.ts` | **47** |
| `sy15.db.rev*` (Prisma model) poziva | 95 |
| ruta u kontroleru | 66 |

Ključno: **`rev_issue_reversal`, `rev_confirm_return`, `rev_issue_cutting_reversal`,
`rev_confirm_cutting_return` nose CELU logiku izdavanja i povraćaja u PL/pgSQL-u.**
Te 4 funkcije u TypeScript-u ne postoje — nema šta da se „prevede", mora da se **napiše**.

---

## 2. FK šavovi — ono što određuje da li je domen odvojiv

### Ka spolja (`rev_*` → van `rev_*`) — 13 FK-ova

| Cilj | FK-ova | Popunjenost | Ocena |
|---|---:|---|---|
| `auth.users` | 5 | 2 različita naloga (Nenad, Duško) | 🟢 **lako** — oba postoje u 3.0 `users` (id 2, 42) |
| `public.employees` | 3 | 21/27 dok., 20 različitih radnika | 🟡 **meka veza** — uuid se prenosi doslovno (obrazac `KadrGridDayLock`) |
| `public.loc_locations` | 3 | **27/27 i 28/28 — 100%** | 🔴 **BLOKADA** |
| `bigtehn_artikli_cache` | 2 | **0** | 🟢 mrtav šav — FK se ne prenosi |

Uz to, **bez FK-a** (polimorfna veza, `pg_constraint` je ne vidi):
`rev_tools.loc_item_ref_id` ↔ `loc_item_placements` (`item_ref_table='rev_tools'`) —
**47/47 alata ima aktivan placement**, i `rev_document_lines.issue_movement_id` /
`return_movement_id` → `loc_location_movements`.

### Ka unutra (bilo šta → `rev_*`)

**Na nivou baze: 0 FK-ova.** Reversi su listni domen — ništa ne zavisi od njih preko FK-a.

**Ali na nivou koda postoje dve povratne zavisnosti** (SQL bez FK-a, ne vide se u šemi):

- `backend/src/modules/kadrovska/kadrovska.service.ts:1959-1990` —
  `offboardingOutstandingReversi()` direktno džoinuje `rev_documents` +
  `rev_document_lines` + `rev_tools`. Ako reversi odu u drugu bazu, **ovaj upit puca.**
- `backend/src/modules/locations/locations.service.ts:189, 314-330, 1067-1073` —
  `PLACEMENT_ITEM_TABLES` sadrži `'rev_tools'`, a RLS politika `loc_placements_select`
  krije te redove kroz `rev_can_manage()`. Lokacije i reversi dele RLS pravilo.

### Zaključak o odvojivosti

**Reversi se ne mogu odvojiti sami.** `loc_*` nije „susedni domen" nego **deo transakcije**:
izdavanje alata u istoj transakciji upisuje `rev_document_lines` i `loc_location_movements`.
Podela baza ne kida džoin — kida **atomarnost**.

Redosled koji merenje nalaže:

1. **Lokacije (`loc_*`) i reversi idu ZAJEDNO**, kao jedan potez (plan to nasluti u koraku 1,
   ali ih navodi kao dve stavke). `loc_*` = 5.597 redova / 3,3 MB, uz svoj sync kanal
   (`loc_bigtehn_ingest_state`, `loc_sync_worker_heartbeat`) koji traži dogovor sa bridge-om.
2. `employees` može ostati meka veza (uuid) — kao što već radi `KadrGridDayLock`.
3. `maint_machines` (Održavanje) je meka veza po kodu mašine — ne blokira.

---

## 3. Šta je urađeno u ovoj grani (`feat/sy15-seoba-reversi`)

| Šta | Gde | Stanje |
|---|---|---|
| 14 Prisma modela | `backend/prisma/schema.prisma` | ✅ `prisma validate` čist |
| Migracija (tabele, FK, indeksi, 2 sekvence, 6 trigera, 8 CHECK) | `backend/prisma/migrations/20260805190000_reversi_seoba_sy15/` | ✅ **primenjena na probnu bazu, NE na prod** |
| Skripta prenosa | `backend/scripts/migrate-reversi-sy15.ts` | ✅ dry-run + `--apply` + `--verify-only` |
| Prekidač `REVERSI_IZVOR` | `backend/src/modules/reversi/reversi-source.service.ts` | ✅ 15 testova |
| Env red | `backend/.env.example` | ✅ |

### Dokaz izvodljivosti (izvršen, ne pretpostavljen)

Napravljena je **odvojena baza `rev_seoba_proba`** na dev serveru (192.168.64.28:5437),
primenjen ceo lanac migracija (`prisma migrate deploy`), pa je skripta pročitala **živu sy15**
(read-only, kroz SSH tunel) i upisala u probnu bazu:

```
rev_inventory_groups     sy15=  3  3.0=  3      rev_documents            sy15= 27  3.0= 27
rev_inventory_subgroups  sy15= 45  3.0= 45      rev_document_lines       sy15= 42  3.0= 42
rev_tools                sy15= 47  3.0= 47      rev_tool_batteries       sy15=  2  3.0=  2
rev_recipient_locations  sy15= 28  3.0= 28      rev_tool_stock_ledger    sy15=  1  3.0=  1
                                     … svih 14 tabela: brojevi se poklapaju
```

Drugo pokretanje `--apply`: **insert=0, update=195** — idempotencija je egzaktna
(UUID PK-ovi se zadržavaju, upsert po `id`; nema remap tabele ni duplikata).
Sekvenca barkodova pomerena na 99, tačno kao u sy15.

### Provere

| Provera | Rezultat |
|---|---|
| `npx tsc --noEmit` | ✅ nula grešaka u reversima (ostaju 3 **zatečene** greške u `handovers`/`kadrovska`/`moj-profil` **spec** fajlovima — nisu dirani, i `tsconfig.build.json` isključuje `**/*spec.ts`) |
| `npx jest` | ✅ **240 suite / 5133 testa prošlo** |
| `npm run build` | ✅ + entrypoint je `dist/main.js` (nije se pomerio na `dist/src/main.js`) |
| **boot-smoke `node dist/main`** | ✅ „Nest application successfully started" — i sa `REVERSI_IZVOR=sy15` i sa `=3.0` |

### Prekidač — šta stvarno radi danas

`REVERSI_IZVOR=sy15` (podrazumevano, i za svaku neprepoznatu vrednost) = **ponašanje kao i do sada**.

`REVERSI_IZVOR=3.0`:
- `GET /inventory-tree` i `GET /inventory-classification-usage` čitaju **3.0 bazu**
  (jedine putanje bez ijedne zavisnosti van `rev_*` — oblik odgovora identičan),
- **sve ostale rute vraćaju 503** sa porukom koja kaže i kako se vraća.

Zašto 503 a ne tiho čitanje sy15: pod prekidačem u položaju „3.0" upis koji bi ipak otišao u
sy15 razišao bi dve baze, a to se ne vidi odmah — otkrilo bi se tek kad se brojevi ne poklope.
Zato je jedini ulaz u sy15 iz `ReversiService` (112 poziva) sveden na jedan geter sa branom.

---

## 4. Šta uraditi na produkciji kad odluka padne

⚠️ **Preduslov koji nije ispunjen:** koraci ispod prenose *podatke*. Modul će raditi na 3.0
tek kad se napiše i ono što danas živi u bazi — 4 funkcije izdavanja/povraćaja, 12 view-ova i
Lokacije. **Procena tog posla: 5–8 dana**, i ide PRE ovog runbook-a. Sam prenos je 15 minuta.

### Redosled

| # | Korak | Trajanje | Povratak |
|---|---|---|---|
| 0 | `ssh ubuntusrv` + noćni klon 3.0 baze (postojeći backup) | 5 min | — |
| 1 | Zamrzni upis u reverse: `REVERSI_IZVOR` ostaje `sy15`, ali se javi magacioneru da ne izdaje/vraća ~20 min | 1 min | — |
| 2 | `npm run migrate:prod` (`prisma migrate deploy`) — kreira 14 praznih tabela | ~10 s | tabele su nove i prazne → `DROP` je bezbedan |
| 3 | `migrate status` mora biti čist (bez drift-a) | 5 s | — |
| 4 | `npx ts-node --transpile-only backend/scripts/migrate-reversi-sy15.ts` (**dry-run**) — pročitati izveštaj, sekcija „BLOKADE" mora biti prazna | ~30 s | ništa se ne piše |
| 5 | `... --apply` — 195 redova | ~1 min | `TRUNCATE` 14 tabela + ponovi (sy15 je i dalje netaknut izvor) |
| 6 | `... --verify-only` — svih 14 redova mora reći `OK` | ~10 s | — |
| 7 | `REVERSI_IZVOR=3.0` u `backend.env` + `systemctl restart` / redeploy kontejnera | ~2 min | **`REVERSI_IZVOR=sy15` + restart = ~2 min** |
| 8 | `ssh ubuntusrv 'bash -s' < backend/scripts/post-deploy-verify.sh` — mora 🟢 EXIT 0 | ~1 min | — |
| 9 | Ručna proba: otvori `/reversi`, izdaj i vrati jedan alat | 5 min | v. korak 7 |

**Ukupno: ~15 minuta rada + 5 minuta probe.**

### Povratak (rollback)

Jedan potez, bez deploy-a koda: **`REVERSI_IZVOR=sy15` + restart (~2 min).** sy15 se tokom
seobe ne dira, pa je u svakom trenutku važeći izvor. Prenete 3.0 tabele ostaju kao mrtav
teret dok se ne pokuša ponovo — ne smetaju.

⚠️ **Tačka bez povratka:** čim se pod `REVERSI_IZVOR=3.0` izda **prvi** revers, 3.0 ima
podatak koji sy15 nema. Od tada povratak traži ručno prenošenje tih redova nazad.
Zato korak 9 (proba) treba raditi odmah i sa jednim alatom.

### Šta se NE radi

- `rev_api_idempotency` se ne dira (nalaz 1) — ostaje u sy15 dok tamo ima ijedan modul.
- sy15 `rev_*` tabele se **ne brišu** ni posle uspešne seobe. Tek posle 2–3 nedelje mirnog
  rada, i to zasebnom odlukom.
- RLS politike se ne prenose — 3.0 koristi guardove (`PermissionsGuard`), ne RLS.

---

## 5. Preporuka

**Reversi nisu najlakši prvi domen — plan ih je potcenio.** Ako je cilj brz i dokaziv prvi
rez, bolji kandidati su **sastanci** ili **projektni biro** (korak 2 plana): manji su, nemaju
šav ka Lokacijama, i njihova DEFINER logika (`sastanci_set_my_rsvp`) je jedan samouslužni
upis umesto četiri transakcije nad dva domena.

Ako se ipak ide na reverse, **onda kao „reversi + Lokacije" u jednom potezu** — jer su
transakciono jedno.

Ono što je ovde napisano važi u oba slučaja: šema, migracija i skripta prenosa su gotove i
dokazane, a prekidač je obrazac koji će zatrebati svakom sledećem domenu.
