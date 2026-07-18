# Module Spec: Lokacije delova — ServoSync 2.0

| | |
|---|---|
| **Modul** | Lokacije napravljenih delova (police) + proizvodne strukture (pozicije/objekti) |
| **Verzija spec** | 1.0 (2026-07-08) |
| **Faza** | 2.0 |
| **Izvor** | QBigTehn: [migration/08 §5](../migration/08-qbigtehn-vba-domain-map.md), UI `Izvoz/Forme` |
| **Status** | Spec spreman; ledger-write posle §11 |

> Premeštanje/trebovanje napravljenih delova po policama (**ledger model**) + matični podaci pozicija/polica.
> **⚠️ VAŽNO — postoji i 1.0 Lokacije modul koji je ŽIV i preuzima iz QBigTehn-a.** 2.0 i 1.0 su danas
> **odvojeni modeli iz RAZLIČITIH QBigTehn tabela**, ali dele isti izvorni sistem — detaljno u §8. Ovo mora
> da se uklopi (zahtev Nenada, 2026-07-08), posebno oko cutover-a QBigTehn-a.

## 1. Domenski model (Prisma)

| Tabela | Was | Uloga |
|---|---|---|
| `part_locations` | tLokacijeDelova | **LEDGER** — postavljanje i uklanjanje = odvojeni zapisi |
| `positions` | tPozicije | pozicije/police (X/Y/Z koordinate) |
| (novo) `part_location_movements` | | eksplicitan ledger pokreta (prenos/trebovanje) |
| `workers` | | ko je postavio/uklonio |

**🔴 Ključno: `part_locations` je LEDGER** — stanje = `SUM(placed) − SUM(removed)`, ne apsolutna količina.

## 2. Ekrani (iz dizajna `Izvoz/Forme`)

| Ekran | Svrha / akcije |
|---|---|
| **Lokacija napravljenih delova (zaglavlje)** (`LokacijaNapravljenihDelovaZag`) | **glavni nosilac** — prenos i trebovanje delova po policama; unos lokacija iskontrolisanih delova |
| **Kartica lokacije dela** (`KarticaLokacijaDela`) | istorija postavljanja/uklanjanja + totali (ledger prikaz) |
| **Sve lokacije po RN** (`LokacijaSvihNapravljenihDelovaPoRN`) | grid + validacija koordinata police (X/Y/Z numeričke) |
| **Unos lokacija** (`LokacijaNapravljenihDelova`) | append-only unos novih lokacija (`DataEntry`) |
| **Pregled po lokacijama** (`PregledDelovaPoLokacijama`) | globalna pretraga (server-side TVF, 12 param) |
| **Pozicije** (`frmPozicije`) | CRUD pozicija/polica |
| **Grupe/objekti** (`frmGrupe`) | CRUD objekata/hala/zona (hijerarhija) |

## 3. Poslovna pravila (🔴 = obavezan port; [08 §5](../migration/08-qbigtehn-vba-domain-map.md))

1. **🔴 Ledger:** stanje dela na lokaciji = `SUM(postavljeno) − SUM(uklonjeno)` (odvojeni zapisi, ne update količine).
2. **🔴 Prenos/trebovanje isključivi:** `KolicinaZaPrenos` i `KolicinaZaTrebovanje` **međusobno isključive** (tačno jedna ≠ 0),
   obe ≥ 0, ≤ trenutne količine, izvor ≠ cilj. Izvršenje = **transakcioni servis** (legacy SP `spIzvrsiPrenosIliCiscenjeDela`).
3. **🔴 Validacija rasporeda:** `ProveriDefinisneKolicine` — suma raspoređenih = broj iskontrolisanih delova (obavezno pre snimanja).
4. **🔴 Mapiranje kvaliteta:** `qualityType` iz flagova — **Dorada → 1, Škart → 2, inače → 0** (enum `0=OK, 1=rework, 2=scrap`).
5. **Koordinate police** `XPoz/YPoz/ZPoz` moraju biti numeričke; promena reda re-inicijalizuje parametre transfera.
6. Metapodaci dela = join `work_orders × customers × workers`.
7. **🔴 Lokacija se definiše tek POSLE ZAVRŠNE KONTROLE** (iz [zvaničnog uputstva](../migration/11-bb-tehnologija-uputstvo.md))
   — deo dobija lokaciju kad prođe završnu kontrolu, ne ranije.

## 4. RBAC ([RBAC_RLS_PREDLOG](RBAC_RLS_PREDLOG.md))

- **MAGACIONER:** write (prenos/trebovanje/unos lokacija).
- ŠEF/ADMIN: pun rad; TEHNOLOG/KONTROLOR/RADNIK: R.
- Ledger zapisi su append-only (ne brišu se; korekcija = kontra-zapis).

## 5. API (predlog, `/api/v1/part-locations/*`)

| Endpoint | Metod | Opis | Faza |
|---|---|---|---|
| `/part-locations` | GET | pregled/pretraga (po RN/lokaciji/delu) | read-only ✅ |
| `/part-locations/card/:partId` | GET | kartica dela (ledger istorija + stanje) | read-only ✅ |
| `/positions` | GET/POST/PUT | pozicije/police | read ✅ / write MAGACIONER+ |
| `/part-locations` | POST | unos lokacije (iskontrolisani delovi) | posle §11 |
| `/part-locations/transfer` | POST | prenos (transakcija, ledger) | posle §11 |
| `/part-locations/requisition` | POST | trebovanje (transakcija, ledger) | posle §11 |

## 6. Zamke (NE prenositi)

- Ručni PK `DMax('IDPozicije')+1` (race) → identity/sekvenca.
- Bez transakcije za prenos/trebovanje → DB transakcija.
- `tObjekti` lokalna Access lookup hijerarhija — **potvrditi sa Nešom** model lokacija (parent/child).
- Error handler koji skače na FindRecord (legacy bug) — ne portovati.

## 7. Otvorena pitanja

1. **§11.1** — ledger-write (mutacije).
2. Hijerarhija lokacija (`positions` parent/child, objekti/hale/zone) — potvrda Neša/Negovan. **Napomena:** 1.0
   već ima bogatiju hijerarhiju (`loc_locations` HALA→POLICA + MACHINE + CAGE) — razmotriti kao 3.0 cilj (§8).

---

## 8. Odnos sa ServoSync 1.0 „Lokacije delova" (`loc_*`) — VAŽNO

> Analiza 1.0 modula (`servoteh-plan-montaze`, 2026-07-08). **Zaključak: 2.0 i 1.0 su danas DVA ODVOJENA
> modela koja crpe iz RAZLIČITIH QBigTehn tabela.** Konceptualno prate istu stvar (koji deo je gde, u kojoj
> količini, sa istorijom), ali izvor i orijentacija su različiti.

### 8.1 Šta 1.0 radi (i zašto nije isto što i 2.0)
- **Izvor 1.0:** sopstvene Supabase `loc_*` tabele; auto-„ingest" izvlači gde je deo **iz `tTehPostupak`**
  (prijave operacija na mašinama — gde je deo *fizički na proizvodnji*), preko `bigtehn_tech_routing_cache`
  (puni ga `bridge/` servis iz QBigTehn-a svakih 15 min) i RPC `loc_bigtehn_ingest_run` + `loc_bigtehn_parse_ident`.
- **Izvor 2.0:** direktan port **`tLokacijeDelova`** (magacinski ledger po policama, `@map("part_locations")`).
- **Kritično:** to su **različite QBigTehn tabele**. Bridge JESTE sinhronizovao `tLokacijeDelova` u
  `bigtehn_part_movements_cache`, ali **1.0 `loc_*` to NE koristi** — dakle preklapanja podataka nema, samo
  konceptualnog domena.

### 8.2 1.0 model (bogatiji od 2.0)
| Aspekt | 1.0 (`loc_*`) | 2.0 (`part_locations`) |
|---|---|---|
| Lokacije | `loc_locations` — hijerarhija HALA→POLICA + **MACHINE + CAGE**, `path_cached`, UUID, anti-ciklus guard | `positions` (`tPozicije`) sa `XPoz/YPoz/ZPoz`, integer |
| Stanje | ledger (`loc_location_movements`) **+ mutabilno** `loc_item_placements.quantity` (trigger) | **čist ledger** (stanje = `SUM(post.)−SUM(ukl.)`) |
| Ključ dela | tekst: `item_ref_id=TP`, `order_no=predmet`, `drawing_no` | integer FK: `work_order_id`, `project_id`, `position_id`, `quality_type_id` |
| Auto-signal | gde je deo na **mašini** (tTehPostupak) | — (ručni unos iskontrolisanih delova) |
| Barkod skeniranje | ✅ (scanModal, mobilni `myLokacije`) | (kroz tehnologiju barkod) |
| Smer ka QBigTehn | **DVOSMERNO** — ručni pokreti se šalju nazad (`loc_sync_outbound_events` → MSSQL `dbo.sp_ApplyLocationEvent`) | čita; write posle §11 (legacy SP `spIzvrsiPrenosIliCiscenjeDela`) |
| Health/monitoring | worker heartbeat + alert outbox + pg_cron | — |

### 8.3 🔴 Posledica za cutover QBigTehn-a (mora se rešiti pre gašenja MSSQL-a)
1.0 loc modul **zavisi od žive QBigTehn baze u OBA smera**:
- **Prima** iz `tTehPostupak` (preko bridge cache) — kad QBigTehn nestane ([BACKEND_RULES §3](../BACKEND_RULES.md):
  MSSQL sync se gasi posle cutover-a), **1.0 gubi auto-signal gde je deo na mašini**.
- **Šalje** ručne pokrete u QBigTehn (`sp_ApplyLocationEvent`) — kad QBigTehn nestane, **taj write target nestaje**.

⇒ **Pravilo:** pošto 2.0 preuzima proizvodnju kao vlasnik, **`tTehPostupak` postaje `tech_processes` u ServoSync-u**.
Kad se QBigTehn ugasi, 1.0 loc ingest se mora **repointovati sa QBigTehn cache-a na ServoSync `tech_processes`**
(iste prijave sa mašina, novi izvor), a outbound (`sp_ApplyLocationEvent`) se gasi (nema više MSSQL cilja) ili
preusmerava na 2.0. Ovo je jedan od **mostova iz „Sync tokom tranzicije"** ([ROADMAP](../ROADMAP.md)) — sunset kad 3.0 objedini.

> **Status 18.07.2026 — B1 kod sletio.** Repoint je izveden kao **zamena hranilice, ne motora**:
> `LocTpFeedService` (2.0 backend, oba datasource-a) puni ISTE `bigtehn_*_cache` tabele iz
> `tech_processes`/`work_orders`/`work_order_operations`, pa `loc_bigtehn_ingest_run`, parser,
> placement trigger i watermark ostaju netaknuti — 1.0 potrošači (uklj. mobilni `/m/*`) ne vide
> promenu. Outbound enqueue grana se uklanja (queue ostaje kao zamrznuta istorija do B3).
> Sekvenca, rizici i rollback: **[RUNBOOK_LOC_MOST_REPOINT.md](../RUNBOOK_LOC_MOST_REPOINT.md)**.

### 8.4 Predlog za 3.0 unifikaciju (jedan model)
Kad se 1.0 i 2.0 spoje u 3.0, **preporuka: 1.0 `loc_*` model je 3.0 cilj** (bogatiji: hijerarhija, MACHINE/CAGE,
barkod, health), a 2.0 doprinosi:
- **`tLokacijeDelova` istorija** kao dodatni izvor placement-a (magacinske police koje 1.0 danas ne pokriva);
- **`quality_type` (dorada/škart)** kao prvorazredni atribut (1.0 to radi preko `location_type=SCRAPPED`/CAGE);
- **`tPozicije` X/Y/Z koordinate** ako se koristi precizno pozicioniranje na polici.
Jedinstveni model: `loc_locations` (hijerarhija) + `loc_location_movements` (čist ledger, bez mutabilnog stanja —
uzeti 2.0 pravilo `SUM(post.)−SUM(ukl.)`) + `loc_item_placements` kao materijalizovan pogled. Auto-ingest iz
ServoSync `tech_processes` (bivši `tTehPostupak`).

### 8.5 Šta ovo znači za 2.0 build SADA
- 2.0 `part_locations` gradi se kako je opisano (§1–§6), **ali** imenovanje/enume uskladiti sa 1.0 gde je bez cene:
  `quality_type {0=OK,1=rework,2=scrap}` ↔ 1.0 SCRAPPED; `movement_type` pojmove pozajmiti iz 1.0
  (`TRANSFER, ASSIGN_TO_PROJECT, SCRAP, CORRECTION, INVENTORY_ADJUSTMENT`).
- Ne graditi 2.0 loc kao slepu ulicu — **ledger je zajednički jezik** oba modela; držati `part_location_movements`
  kao čist append-only ledger (kao 1.0) da 3.0 merge bude spajanje ledgera, ne prepisivanje.
- **Blokada za sastanak:** potvrditi sa Nešom (1.0 autor) i Negovanom da li 3.0 cilj = 1.0 model + 2.0 dopune,
  i ko je vlasnik `tTehPostupak→tech_processes` signala posle cutover-a.
