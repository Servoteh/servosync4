# Odluka N3 — predmeti: 2.0 master vs BigBit sync (tehnički rizik za dual-run)

> **Datum:** 2026-07-19. Blokira aktivaciju `projects-write` modula (Predmeti write-path + RFQ kupca).
> Traži Nenad/Negovan potvrdu **baš ovog rizika**, ne samo načelnog „2.0 = master".

## ✅ PRESUĐENO 22.07.2026 (Nenad) — varijanta C′ „dual unos sa paritetom brojeva"

Prelazni režim do gašenja BigBit fakturisanja (faza 5):

1. **Nov predmet se otvara PRVO u 3.0** (`POST /api/v1/projects` / „Napravi predmet iz
   zahteva"; 3.0 dodeljuje broj — trenutno od 10001 naviše). Otvara komercijala/menadžment
   (role sa `projects.write`: NABAVKA, MENADZMENT, admin).
2. **Isti broj se RUČNO prekuca u BigBit** (BigBit ostaje nosilac fakturisanja) — paritet
   brojeva se održava disciplinom, redosled „prvo 3.0" je obavezan da dva sistema ne bi
   nezavisno dodelila isti broj različitim predmetima.
3. **Sync guard** (implementiran 22.07, `generic.syncer.ts` + `ADDITIVE_DEDUP_FIELDS` u
   `table-ownership.ts`): BigBit kopija predmeta (svoj id, isti `project_number`) se pri
   sync-u PRESKAČE uz upozorenje u sync logu — 3.0-native red je istina u 3.0 (RN-ovi i
   aktivacije pokazuju na njega). Ranije ušla kopija se na sledećem sync-u počisti (self-heal).
   Aditivni refresh iz ranije odluke ostaje (BigBit ažurira svojih ~7.600, ne dira native).
4. **Komitenti nepromenjeno**: otvaraju se SAMO u BigBit-u (ODLUKE #23), u 3.0 stižu ručnim
   pokretanjem sync-a (`/syncs` stranica, admin).

Tekst ispod je istorijat analize (19.07) — zadržan radi konteksta.

## Šta je nađeno u kodu

- `Project`/`projects` je **aktivno sync-ovana** iz BigBit-a: `sync-map.generated.ts:1302` (`source: "Predmeti"`).
- **Strategija = `full_refresh`** (jer `watermark: null` → `generic.syncer.ts:36`): svaki sync ciklus radi
  **`deleteMany` + `createMany`** (`generic.syncer.ts:20`) — **BRIŠE ceo `projects` i ponovo ubaci iz BigBit-a**.
- `table-ownership.ts:88-91`: `projects` je NAMERNO van `OWNED_PRODUCTION_TABLES` — „PERMANENT BigBit
  master-data sync … vasa-SQL keeps feeding after cutover".
- **~25 modela FK-uje na `IDPredmet`** (work_orders, tech_processes, part_locations imaju pravi FK).

## Problem za dual-run

Ako 2.0 (`projects-write`) INSERT-uje nov predmet, **sledeći sync ciklus ga OBRIŠE** (`full_refresh` wipe).
Nema UPDATE-only režima u ovom syncer-u (samo `incremental` sa watermark-om ili `full_refresh`).
Dakle „ručno duplo unositi i u BigBit i u 2.0" NE pomaže — 2.0 predmet se svejedno briše pri svakom sync-u,
osim ako je i u BigBit-u (pa dolazi kroz refresh, ali sa BigBit id-em, ne 2.0 id-em → FK lanac se lomi).

## Opcije (traži odluku)

| Opcija | Posledica |
|---|---|
| **A. Isključi Predmeti syncer** (izbaci iz SYNC_MAP + dodaj `projects` u OWNED) | 2.0 = jedini pisac. Ali **novi predmeti napravljeni u BigBit-u NE dolaze u 2.0** dok syncer ne radi. OK samo ako se SVI novi predmeti od sada prave u 2.0. |
| **B. Ostavi syncer, projects-write čeka cutover** | Bezbedno, ali predmeti write-path (RFQ→predmet lanac) se ne aktivira do cutover-a. |
| **C. Prepravi syncer na incremental/UPSERT** (bez delete) | 2.0 i BigBit oba pišu, bez brisanja. Traži watermark na Predmeti (IDPredmet ili izmena-timestamp) + UPSERT umesto delete+create. Najviše posla, ali jedini pravi dual-run. |

**Preporuka:** ako Servoteh od sada SVE nove predmete pravi u 2.0 (a BigBit predmeti su „zamrznuti" istorijski) →
**Opcija A**. Ako se predmeti i dalje prave u BigBit-u paralelno → **Opcija C** (ili sačekati cutover, Opcija B).

**Do odluke:** `projects-write` ostaje kao `.nacrt` (napisan, verifikovan, ne aktiviran). Modul Nabavka
NE zavisi od ovoga (radi sa postojećim predmetima kroz meki ref).
