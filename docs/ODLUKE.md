# Registar odluka — ServoSync

> Donete odluke (ko/kada), da se §11 „otvorena pitanja" postepeno zatvaraju. Odluka postaje pravilo
> tek kad je ovde + primenjena u relevantnom docu ([BACKEND_RULES §11](BACKEND_RULES.md) / [RBAC_RLS_PREDLOG](design/RBAC_RLS_PREDLOG.md)).

## Sesija 2026-07-08 (Nenad)

| # | Pitanje | ODLUKA | Napomena / gde primenjeno |
|---|---|---|---|
| 1 | BigBit izvor posle gašenja QBigTehn-a | **Export (XML/CSV)** iz BigBit-a → ServoSync uvozi | Ne SQL Server. [BACKEND_RULES §11.2a](BACKEND_RULES.md), [MODULE_SPEC_bigbit_sync](design/MODULE_SPEC_bigbit_sync.md) |
| 2 | BigBit sync semantika (update/delete) | **Insert-only (kao legacy)** — samo novi redovi | Ne UPSERT. Napomena: promene adrese/PIB-a iz BigBit-a se NE propagiraju (svesno). §11.2b |
| 3 | PDM sync mehanizam | **Direktan SQL** (čitanje PDM MS SQL-a) | ✅ Potvrđeno 8.7 (#12): „PDM MS SQL" = Servoteh-ov međusloj (SQL baza kojom mi upravljamo), ne sirov SolidWorks. §11.3 |
| 4 | Cache/overlay | **Potvrđeno** — BigBit matične = read-only cache; proizvodne = ServoSync vlasništvo | §11.1 zatvoreno |
| 5 | Timestamp politika | **ODLOŽENO** — Luka/Nesa odlučuju (tehnička sitnica) | Preporuka: `Timestamptz` za nove tabele. §11.4 ostaje otvoreno |
| 6 | Obim role ŠEF | **Pun rad + odobravanje** (RN/primopredaje/lokacije) + pregled ostalog | Jedan ŠEF (ne per-modul). [RBAC §7.1] |
| 7 | Ko potpisuje/završava TP | **Tehnolog (autor) + ŠEF + CNC programer** | CNC programer SME da potpiše/završi TP. [RBAC §7.2] |
| 8 | Tabela `cnc_programs` | **DA — uvodi se** (zasebna app-owned tabela) | CNC programer vlasnik write-a. [RBAC §7.3], [MODULE_SPEC_tehnologija] |
| 9 | MENADZMENT prava | **Uvid + write** (paritet sa 1.0) | Ne samo read. [RBAC §7.5] |
| 10 | PostgreSQL RLS | **Ne sada — samo NestJS guardovi + query-scoping** | Pravi PG RLS tek u 3.0 ako zatreba. [RBAC §7.4] |
| 11 | Konvencija imena rola | **lowercase snake_case** (`admin`/`sef`/`cnc_programer`) u oba repoa | Prevaziđeno UPPERCASE; paritet sa 1.0 prod. [BACKEND_RULES §2.2], [AUTHZ_UNIFIED](design/AUTHZ_UNIFIED.md) |
| 12 | Nativni PG RLS pravac | **„RLS-ready sada, nativni RLS u 3.0"** | Temelji (GUC `app.user_id`, `user_roles`, `worker_id`/`created_by_id` FK, predikat-funkcije) da 3.0 bude flip-a-switch. Skelet: [sql/authz_rls_ready.skeleton.sql](design/sql/authz_rls_ready.skeleton.sql) |
| 13 | Katalog rola — objedinjavanje | **Jedan katalog za 1.0+2.0+3.0** ([AUTHZ_UNIFIED](design/AUTHZ_UNIFIED.md), `roles.ts`) | `tim_lider`≠`sef`; `proizvodni_radnik`=`radnik`; `cnc_operater`≠`cnc_programer`; dodati `monter`/`tim_lider`/`proizvodni_radnik` |

## Sesija 2026-07-08 (nastavak) — potvrde Negovan Vasić („Vasa" = ista osoba)

| # | Pitanje | ODLUKA / POTVRDA | Primenjeno |
|---|---|---|---|
| 11 | BigBit export — format i obim | **XML**, i to **CEO katalog artikala** (ne samo korišćeni) | zatvara „potvrditi kod Vase" iz §11.2a; red #1 |
| 12 | PDM izvor | ✅ **Servoteh-ov međusloj — SQL baza kojom MI upravljamo**, NE sirov SolidWorks → **direktan SQL je siguran** | zatvara §11.3 caveat; red #3 |
| 13 | Prazne tabele iz sync-a (`tax_rates`/`warehouses`/`price_list_entries`/`goods_documents`…) | ✅ **Očekivano — prazne u samom izvoru.** Vasa je za QBigTehn koristio prilagođenu „BigBit-na-SQL" verziju, maskom sakrio forme koje ne treba da vidimo i adaptirao je na ono što nam treba → te tabele su **nepotrebne** (NIJE propuštena `EXT_` veza) | zatvara proveru A.3 |
| 14 | Ko validira/završava TP | Uz Tehnolog(autor)+ŠEF+CNC: **KONTROLOR finalnom kontrolom validira da je TP završen** — i ako sve operacije nisu otkucane („ako on kaže da je dobro, dobro je"); **isto mogu svi iz `MENADZMENT`**. **Obavezan audit: ime+prezime + kada.** | RBAC §7.2 prošireno, §3.1 |
| 15 | Nikola Ninković | **`MENADZMENT`** — šef CELE mašinske obrade; nema poseban scope (nije sporno) | RBAC §2.1 ispravljeno |
| 16 | BOM/MRP/RN **logika izračuna** | **Nema gotove legacy procedure** — u fazi razrade u Tehnologiji, **ne koristi se trenutno**; **ServoSync 2.0 je DIZAJNIRA** (Nenad+Luka), ne reverse-eng. Anti-ciklus guard obavezan kad se gradi. **Ne blokira** (nije u upotrebi) | reframe §11.4; migration/15 tačke se gledaju kroz ovu prizmu |

> Napomena: „Negovan" i „Vasa" u svim dokumentima = **Negovan Vasić, jedna osoba** (server `vasa-SQL` nazvan po njemu).

## Sesija 2026-07-09 (Nenad) — Kontrola/Kucanje + gap analiza + skop

| # | Pitanje | ODLUKA | Primenjeno |
|---|---|---|---|
| 17 | Nalepnica barkod | **RNZ** (`RNZ:projectId:identNumber:variant:revision`) — kiosk/telefon dekodabilan | [MODULE_SPEC_kontrola §6/§10], [MODULE_SPEC_stampa §3.1] |
| 18 | Mobilni UNOS sa telefona | **Faza 2** (priprema od P1: čist REST/JWT + telefon-čitljiv RNZ); ne gradi se u pilotu | [MODULE_SPEC_kontrola §8] |
| 19 | Gap QBigTehn→2.0 | **Gradimo sve što je bilo (i bolje)** — propust je iz nepotpunih uputstava, ne namere | [migration/16], backlog Tier A–D |
| 20 | Redosled gradnje | **Tier A prvo** (proizvodni core: TP authoring, RN izmena/stavke/brisanje, ispravke kucanja) | [migration/16 §4] |
| 21 | Start/stop evidencija vremena rada | **DA — dva skena** (start+stop po operaciji → stvarno utrošeno vreme); veći zahvat u kucanje model | Tier A-4; preduslov za vreme-analitike |
| 22 | MRP/nabavka obim | **Za sad read-only** (write/planning stack odložen) | [migration/16 §4 Tier D], §11.3 |
| 23 | Matični podaci (komitenti/predmeti/materijali) | **Read-only iz BigBit-a** — uređuju se u BigBit-u; 2.0 samo prikazuje (bez ekrana za izmenu) | [migration/16 §3.7] |
| 24 | A-4 zatvaranje zaboravljenih sesija | **Odjava-driven** (radnik se kuca na izlazu → `stopped_at = odjava`; Supabase/prisustvo integracija). `POST /work/auto-close` (>N h) je samo interim i **namerno NIJE na cron-u** | Nesa 2026-07-09 |
| 25 | A-5 ko sme završnu kontrolu | **5 imenovanih kontrolora** (worker tip „Kontrola" = `additional_privileges`): B. Krstić, M. Mutić, N. Petrović, D. Uzelac, M. Cvetković (deljeni nalog `kontrola@servoteh.com`). Autorizacija = login svojim nalogom (rola `kontrolor`) **ILI** ID kartica — bilo koji put dovoljan. (Ninković/Nikodijević/Jaraković su šefovi, ne kontrolori) | Nesa 2026-07-09; `users` id 4–8 |
| 26 | A-5 razdvajanje dužnosti | Operater **ne sme** završnu kontrolu nad delom na kom je evidentirao proizvodni rad. **Kontrolne operacije (npr. 8.4 Međufazna) se NE računaju** kao proizvodni rad — inače 422/1190 kontrola u 90d lažno okida | Nesa 2026-07-09; `selfControlViolation` |
| 27 | AUTHZ_ENFORCE | **`true` na produkciji od 2026-07-09** (Nesa odobrio; podloga: 0/161 machine-access rupa u 30d, kontrole 90d isključivo tip „Kontrola", 0 shadow-deny u logovima). Rollback: obriši `AUTHZ_ENFORCE` red u `backend.env` na serveru + `docker compose up -d` | verifikovana 403/200 matrica |
| 28 | Završna kontrola potvrđuje neotkucane operacije | Kontrola zatvara SVE otvorene ne-kontrolne operacije naloga (komadi/radnik se NE diraju — bez izmišljene evidencije) + ceo RN silazi s prioriteta (255). Druge završne operacije se NE potvrđuju implicitno. **Bez legacy presedana** (provereno u BBTehn_Module) — proširuje #14 | Nesa 2026-07-10; e2e verifikovano |
| 29 | Create-on-scan za SVE operacije | RN kreiran u 2.0 nema unapred `tech_processes` redove (legacy = iz sync-a) → red se otvara pri PRVOM skenu bilo koje operacije, uz validaciju protiv routinga (`work_order_operations`). Kiosk validira preko routing-a iz decode-a | Nesa 2026-07-10 (pogon: 8.4 „nije u nalogu"); e2e verifikovano |
| 30 | Kiosk identifikacija | Lični nalog (users.worker_id vezan) → kartica se PRESKAČE (auto-prijava, `GET /worker/me`, sveže DB čitanje); deljeni terminal-nalozi (`kontrola@`, `tehnologija@` — bez worker_id) → kartica OBAVEZNA. `kontrolor` rola dobila `report_work` (kontrolori kucaju prijem kooperacije/cinkovanja) | Nesa 2026-07-10 |
| 31 | Štampa nalepnica = KROZ BACKEND | `POST /tech-processes/labels/print`: server šalje RAW TSPL2 direktno štampaču (TCP 9100; `LABEL_PRINTER_HOST/PORT`, default 192.168.70.20:9100). Razlog: Chrome „Local Network Access" blokira HTTPS→localhost pa je per-PC proxy nepouzdan (pogon: proxy up + health ok, a „Failed to fetch"). Radi sa svakog uređaja, bez podešavanja terminala; lokalni proxy (`frontend/tools/label-proxy`) ostaje samo fallback. **Doštampavanje**: sken već završene kontrole nudi SAMO štampu (ReprintPanel; evidencija se ne dira) | Nesa 2026-07-10; verifikovano (422 guard + 2 test nalepnice) |
| 32 | PRIVREMENI test nalog | `jovica.milosevic@servoteh.com` (worker 74, vezan) sme SVE na kiosku — env `AUTHZ_TEST_WORKER_IDS=74` preskače machine-access/kontrolor-auth/SoD SERVISNE provere (guard/permisije ostaju). **UKINUTI posle testova**: obriši red iz `backend.env` + `docker compose up -d` (+ po želji deaktiviraj nalog) | Nesa 2026-07-10 |
| 33 | Primopredaje approve → tehnolog + menadžment | `primopredaje.approve` dodat rolama `tehnolog` (Miljan/Jovica odobravaju, dodeljuju tehnologa i lansiraju — paritet QBigTehn „Jovica i Miljan") i `menadzment` (**PRIVREMENO** — pun uvid u Nacrte+Primopredaje dok se tok ne ustali, **UKINUTI kasnije**; vraća se per-user `finalni_potpisnik`/SEF). UI: Nacrti (`/nacrti`, gate `primopredaje.write` — projektanti) i Primopredaje (`/handovers`, gate `primopredaje.approve` — tehnolozi) razdvojeni u zasebne ekrane; kontrolor/CNC/magacioner gube samo NAV stavku Primopredaje (read ostaje) | Nenad 2026-07-12 |
| 34 | Paket A (Miljanovi komentari t.1/3/6a/9/10) | (a) **Prod data:** tehnolozi vezani na radnike — `users.worker_id`: Miljan→13, Nikola→43, Aleksandar→77 (aktivni, NE 39), Stefan→181, Dragan→2226 (rollback: `SET worker_id=NULL`); time auto-tehnolog po loginu (već u kodu), take-over i notifikacije rade i za njih. (b) **HITNO**: `drawing_handovers.is_urgent` (migracija 20260712180000), postavlja se pri approve (checkbox), briše return-to-pending; badge u listama/detalju/TP kartici + crveni „HITNO" na RN štampi (menja fizičke nalepnice). (c) Realizacija: kolona „Tehnolog" je prikazivala radnika koji je kucao — preimenovana u „Radnik" + prava kolona Tehnolog (RN `worker_id`, batch-resolve). (d) PDF crteža direktno iz detalja primopredaje. (e) Tab „Na pisanju" + `GET /handovers/writing-stats` (brojači po tehnologu/predmetu). Trijaža: [design/KOMENTARI_TEHNOLOGIJA_2026-07-12_TRIJAZA.md](design/KOMENTARI_TEHNOLOGIJA_2026-07-12_TRIJAZA.md) | Nenad 2026-07-12 |
| 35 | Paket B (Miljanovi komentari t.2/5/7) | (t.2) **Poreklo dorada/škart RN-a:** `work_orders.parent_work_order_id` (migracija 20260712200000) — `rework()` upisuje izvorni RN; enrich vraća `parentWorkOrder` + `reworkChildren`; filter `?reworkOnly=true`. Role NEPROMENJENE (kontrola inicira kvalitet na kiosku, tehnolozi lansiraju rework iza `rn.write`) — dodata samo strukturisana sledljivost („tok od sečenja"). (t.5) **Lokacija u završenim:** `list()` vraća `locations[{positionCode,quantity}]` (neto iz `part_locations` ledgera, SUM po poziciji) → kolona na /completed-orders. (t.7) **CAM modul:** nova tabela `cnc_programs` (migracija 20260712210000, ODLUKE #8) + modul `cnc-programs` (`GET` lista pozicija sa `operations.usesPriority=true` na nezavršenom RN-u; `PATCH /:workOrderId` čekiraj „CAM završen" sa auditom `completedBy/At` iz JWT-a). Gate read=`tehnologija.read`, write=`tehnologija.write` (rola `cnc_programer` ih ima, `rn.write` NE). Signal „potreban CAM" = `usesPriority` (ne novi flag). | Nenad 2026-07-12 |
| 36 | Proba runda 2 (živa proba primopredaje/kiosk/CAM) | (t.4) **Grupno odobravanje CELE primopredaje:** `POST /handovers/approve-batch` + `reject-batch` (eksplicitna lista `handoverIds` — `drawing_handovers` nema draft FK, FE grupiše po `draftContext.draftNumber`); best-effort `updateMany` sa istim `transition` guardom, vraća `{approved, skipped[]}`. Legacy paritet `spPromeniStatusPrimopredaje` (statusi 0/1/2 grupno). **LANSIRANJE OSTAJE POJEDINAČNO** (legacy per-RN, odluka Nenad). (t.3) **Kiosk „Moji otvoreni":** `GET /tech-processes/worker/open?card=` (kartica ili JWT worker) — otvoreni postupci radnika + `hasOpenSession`; zatvaranje iz liste kroz POSTOJEĆI `POST /:id/finish` (bez ponovnog skeniranja). (t.5) **CAM lista pročišćena:** izbacuju se pozicije čija je trojka otkucala **CNC glodanje/struganje** (RC naziv počinje „CNC" — CAM prethodi tim operacijama pa je implicitno urađen; glavni signal 271/549) **ili završnu kontrolu** (`significantForFinishing`); univerzalno glodanje/struganje (ručne mašine) izuzeti. Smanjuje 549→~270. (t.2) **Dimenzija materijala u RN štampi** (`materialDimension` u info tabeli — poboljšanje vs legacy rRN spec). (t.1) **Kvalitet polje** na RN kartici: prikaz „Dorada/Škart" samo za `qualityTypeId∈{1,2}` (mapiranje bez lookup tabele), „Redovan" za 0. | Nenad 2026-07-13 |

> Kontrola/Kucanje P1 (kiosk create-on-scan + nalepnica) je **na produkciji i verifikovan** (2026-07-09).
> A-4 start/stop + A-5 kontrolor autorizacija su **na produkciji, enforcement UKLJUČEN** (2026-07-09).

## Zadaci koje je Nenad tražio (u toku)

- **Role/imenovanje (§6 RBAC):** iz sistematizacije — Miljan Nikodijević = *Rukovodilac proizvodnih operacija i
  tehnologije*; Nikola Ninković = *Šef mašinske obrade*; Milorad Jerotić = *Gl. mašinski inž. + Rukovodilac
  inženjeringa; finalni potpisnik*. **Predlog mapiranja** u [RBAC_RLS_PREDLOG §2/§6](design/RBAC_RLS_PREDLOG.md).
  U 1.0 su svi „menadzment" — može tako i da ostane u V1, pa se granulira u V2.
- **BOM/MRP logika (§11.3 dubinski):** ✅ **URAĐENO 2026-07-08** — 5-agent analiza ukrstila SQL tela sa VBA
  pozivima → [migration/15](migration/15-bom-mrp-odluka-bez-negovana.md). **13 od ~40 „POTVRDITI" tačaka
  razrešeno iz koda** (odlučujemo sami); ostaje samo 5 za Negovana (vidi ispod).

## Ostaje za sastanak / kasnije (SKRAĆENO)

**Za Nesu/Luku (tehnički):**
- Timestamp politika (`Timestamptz` preporuka). ~~potvrda PDM izvora~~ ✅ potvrđeno 8.7 (Servoteh međusloj).
- **BOM/MRP/RN logika izračuna = 2.0 dizajnira** (odluka #16) — nije reverse-eng iz legacy-ja; deo „5 tačaka za Negovana" ispod time postaje NAŠA odluka, a ne pitanje za Vasu.

**Za Negovana (poslovna/podatkovna semantika — 5 tačaka, [15 §6](migration/15-bom-mrp-odluka-bez-negovana.md)):**
1. Magacin `IDMagacin`/`VrstaMag` → tip (gotova roba / poluproizvod / sirovina).
2. Ciklus u sastavnici = **tvrda greška unosa** (preporuka) ili samo prekid eksplozije?
3. 23h auto-close — vrednost `komada` + KPI flag (nema u kodu, nov zahtev).
4. Šta je **predmet 4521** (i da li je 0 sentinel) → migrira se u flag `excludeFromReworkScrap`.
5. BB robne konvencije (`Level 0/250`, `Vrsta='KODJ'`) + domen `Revizija` (slovna / numerička ≥10).

**Ostalo (nije BOM/MRP):** TP vreme/„utrošeno", primopredaja status-matrica, lokacije — „POTVRDITI" tačke iz
[05 §4/§5/§6](migration/05-qbigtehn-sqlserver-logic.md) · 8 AMBIGUOUS granica scope-a iz [02](migration/02-qbigtehn-scope-triage.md).
