# Seoba sy15 → 3.0, korak 3: REVERSI + LOKACIJE

**Datum merenja:** 07.08.2026, nad produkcijskim `sy15-db` i `servosync-pg`.
**Status:** temelj postavljen (šema, migracija, prenos, prekidači). **Ništa nije preklopljeno.**
Nastavak plana: [PLAN_GASENJA_SY15_2026-08-03.md](PLAN_GASENJA_SY15_2026-08-03.md).
Presedani: [SEOBA_SASTANCI_PB](SEOBA_SASTANCI_PB_2026-08-05.md) (korak 1),
[SEOBA_ODRZAVANJA](SEOBA_ODRZAVANJA_2026-08-06.md) (korak 2).

---

## 0. Zašto je ovo hitno

**Lokacije su JEDINI domen u kome korisnici UŽIVO pišu u sy15.** Izmereno nad
`loc_location_movements`, poslednjih 14 dana:

| dan | 27.07 | 28.07 | 29.07 | 30.07 | 31.07 | 03.08 | 04.08 | 05.08 | 06.08 | 07.08 |
|---|---|---|---|---|---|---|---|---|---|---|
| upisa | 6 | 28 | 21 | 2 | 8 | 20 | 7 | 14 | 3 | 13 |

Upisi dolaze sa mobilne i sa skenera. Svi ostali domeni koji čekaju seobu su ili
zamrznuti (kadrovska) ili se pišu retko. Ovde svaki dan odlaganja znači dan u kome
postoje dva izvora istine o tome gde se šta fizički nalazi.

---

## 1. Merenje — obim

### 1.1 Tabele i redovi (`ANALYZE` pa `count(*)`, ne `n_live_tup`)

| tabela | redova | RLS politika | tabela | redova | RLS |
|---|---:|---:|---|---:|---:|
| `loc_locations` | 1.562 | 3 | `rev_tools` | 47 | 3 |
| `loc_location_movements` | 1.446 | 1 | `rev_inventory_subgroups` | 45 | 4 |
| `loc_item_placements` | 1.049 | 1 | `rev_document_lines` | 42 | 3 |
| `loc_sync_outbound_events` | 1.575 | 1 | `rev_recipient_locations` | 28 | 2 |
| `loc_sync_alerts_outbox` | 25 | 1 | `rev_documents` | 27 | 3 |
| `loc_sync_worker_heartbeat` | 1 | 1 | `rev_inventory_groups` | 3 | 4 |
| `loc_bigtehn_ingest_state` | 1 | 1 | `rev_tool_batteries` | 2 | 4 |
| | | | `rev_tool_stock_ledger` | 1 | 1 |
| | | | `rev_cutting_tool_catalog` | 0 | 3 |
| | | | `rev_cutting_tool_stock` | 0 | 1 |
| | | | `rev_document_cutting_assignees` | 0 | 2 |
| | | | `rev_inventory_subsubgroups` | 0 | 4 |
| | | | `rev_machine_heads` | 0 | 4 |
| | | | `rev_tool_service_log` | 0 | 4 |

**Ukupno 21 tabela / 5.659 redova / 51 RLS politika.**
Uz to: 59 funkcija (48 `SECURITY DEFINER`), 20 trigera, 16 view-ova
(15 `v_rev_*` + `v_loc_tp_operation_slots`), 4 PG enum tipa.

### 1.2 🔴 Ispravka zadatog obima: 21, a ne 22 tabele

Zadatak je nabrojao **15 rev tabela / 871 red**. Petnaesta je `rev_api_idempotency`
i **ne pripada ovom domenu — prefiks laže.** Izmereno, po domenu iz kolone `action`:

| domen | redova | domen | redova |
|---|---:|---|---:|
| `kadr.*` | 480 | `odrzavanje.*` | 20 |
| `profile.*` | 72 | **`reversi.*`** | **2** |
| `sastanci.*` | 57 | **`loc*`** | **0** |
| `pb.*` | 31 | | |

To je registar `Sy15Service.runIdempotent()` — infrastruktura CELE sy15 veze.
Da se prenese, domeni koji OSTAJU u sy15 izgubili bi idempotenciju: dupli klik na
„odobri godišnji" postao bi dva odobrenja. **Ostaje u sy15 do poslednjeg koraka.**
Isti zaključak su nezavisno doneli i koraci 1 i 2 (v. `migrate-odrzavanje-sy15.ts`).

Bez nje: reversi = **14 tabela / 195 redova**, lokacije = **7 tabela / 5.464 reda**.

### 1.3 🔴 Zašto dva domena idu ZAJEDNO (transakciona sprega)

Izmereno na produkciji:

| šav | mera |
|---|---|
| `rev_issue_reversal` → `loc_create_movement` u istom commit-u | u telu funkcije, po stavci |
| `rev_confirm_return` → `loc_create_movement` u istom commit-u | u telu funkcije, po stavci |
| `rev_document_lines.issue_movement_id` → `loc_location_movements` | **40** redova |
| `rev_document_lines.return_movement_id` → `loc_location_movements` | **1** red |
| `rev_tools.loc_item_ref_id` ↔ `loc_item_placements` | **47 / 47** |
| `rev_documents.recipient_loc_id` → `loc_locations` | **27 / 27** (0 NULL) |
| `rev_cutting_tool_stock.location_id` → `loc_locations` | FK (tabela prazna) |

FK u suprotnom smeru **nema nijedan**: nijedna tabela van `rev_*`/`loc_*` ne pokazuje
na njih. Rez je čist prema ostatku baze, ali ne i između ova dva domena.

### 1.4 Mapa identiteta

| šta | mereno | rezultat |
|---|---|---|
| `auth.users` uuid u `rev_*`/`loc_*` | 13 različitih naloga | **13/13** razrešeno u 3.0 `users` po mejlu |
| `employees` uuid (`rev_documents`, assignees) | 20 radnika | **13/20** ima red u `worker_employee_map` |

Nalozi: `nenad.jarakovic`, `zoran.jarakovic`, `dusko.kostic`, `ljubisa.simovic`,
`strahinja.petrovic`, `dijana.kastratovic`, `nikola.mrkajic`, `kontrola`,
`stevan.birovljev`, `stamenic4`, `cveticmarko47`, `mladenandjic02`, `nebojsajancic747`.

**Odluka o radnicima:** `employees` OSTAJE u sy15 (kadrovska je zamrznuta do seobe,
registar §K), pa `recipient_employee_id` / `issued_to_employee_id` / `employee_id`
ostaju MEKI uuid bez FK. Denormalizovano ime (`recipient_employee_name`) već postoji
u tabeli, pa prikaz ne zavisi od sy15. Kad kadrovska pređe, isti uuid postaje 3.0
ključ — bez ijedne izmene podataka.

### 1.5 Funkcije koje kod STVARNO zove

`grep` po `backend/src` i `frontend/src` (07.08.2026), ne po spisku iz baze:

| funkcija | pojava u BE | funkcija | pojava u BE |
|---|---:|---|---:|
| `rev_can_manage` | 15 | `loc_create_movement` | 14 |
| `rev_current_employee_id` | 14 | `loc_can_manage_locations` | 12 |
| `rev_confirm_cutting_return` | 7 | `loc_tps_for_predmet` | 6 |
| `rev_hand_tool_apply_delta` | 6 | `loc_move_cage` | 6 |
| `rev_issue_reversal` | 5 | `loc_is_admin` | 6 |
| `rev_add_inventory_subgroup` | 5 | `loc_can_create_movement` | 5 |
| `rev_issue_cutting_reversal` | 4 | `loc_locations_audit` | 4 |
| `rev_confirm_return` | 4 | `loc_bigtehn_ingest_arm` / `run_now` | 4 + 4 |
| `rev_cutting_tool_seed_stock` | 3 | `loc_report_parts_by_locations` | 3 |
| `rev_write_off_tool` / `rev_restore_tool` | 2 + 2 | `loc_get_bigtehn_op_status` | 3 |

Od 59 funkcija u bazi, kod zove **~28**. Ostatak su interne pomoćne (trigerske,
`*_touch_updated_at`, `*_check_*` čuvari) — one se ne „prevode", već nestaju zajedno
sa trigerima kad logika pređe u servis.

### 1.6 🔴 Potvrda olakšice: `bigtehn_work_orders_cache` je mrtav

| mera | vrednost |
|---|---|
| redova | 40.758 |
| `max(synced_at)` | **2026-07-14 11:30 UTC** (24 dana star) |
| `loc_sync_outbound_events` | **1.575 redova, SVI `PENDING`**, nijedan nikad isporučen |

Potvrđeno. **Keš se NE prenosi.** Nezavisna provera pokrivenosti ključeva:
od 702 različita `item_ref_id` sa `item_ref_table='bigtehn_rn'`,

- u mrtvom kešu postoji **302**,
- u 3.0 `work_orders` (41.173 reda) postoji **302** — isti broj.

3.0 je dakle pun nadskup onoga što keš još nosi, i živ most nije potreban.
Preostalih 400 ključeva ne postoji **nigde** — to su nalozi obrisani iz BigTehn-a.
Zato `item_ref_id` u 3.0 ostaje **meki TEXT bez FK**: pravi FK bi tih 400 redova
istorije ili odbio ili obrisao.

---

## 2. Odluka: JEDAN prekidač ili DVA?

**Odluka: dva imena, jedna vrednost, brana koja to sprovodi.**

Pravilo iz incidenta 06.08.2026 (`SASTANCI_PB_IZVOR` oborio Projektni biro) glasi
„jedan prekidač = jedan domen". Ono je nastalo iz slučaja u kome su **nepovezani**
domeni delili prekidač, pa je spreman obarao nespreman — kvar u DOSTUPNOSTI.

Ovde je slučaj suprotan. Da su prekidači nezavisni, `REVERSI_IZVOR=3.0` +
`LOKACIJE_IZVOR=sy15` značilo bi da izdavanje alata upiše dokument u 3.0, a kretanje
u sy15 — **jedna transakcija presečena na dve baze, bez ijedne poruke o grešci**.
To je kvar u TAČNOSTI, a on se ne vidi dok se brojevi ne raziđu.

Rešenje uzima obe pouke:

| zahtev | kako je ispunjen |
|---|---|
| svaki domen se imenuje sobom (pouka 06.08) | `REVERSI_IZVOR` i `LOKACIJE_IZVOR` su odvojene promenljive; 503 poruke i uputstvo za povratak nose ime domena koji je zapeo |
| transakcija se ne sme preseći | `assertSpojeniIzvori()` u `onModuleInit` — **backend se ne podiže** ako se vrednosti razlikuju |
| razdvajanje ipak moguće (merenje) | samo uz izričito `REVERSI_LOKACIJE_RAZDVOJENO=true`, uz upozorenje u logu |

Zašto pucanje pri podizanju, a ne upozorenje: pouka 07.08.2026 („docker restart ne
čita env") je da tiho pogrešan prekidač ume da radi **15 minuta neprimećeno**.
Bolje da backend ne krene nego da toliko dugo piše u dve baze.

Kod: `backend/src/common/sy15/{reversi,lokacije}-source.service.ts`,
`spojeni-izvori.ts`, `reversi-lokacije-izvor.module.ts`. Testovi (18, svi zeleni):
`reversi-lokacije-izvor.spec.ts` — uključujući oba smera neslaganja.

### 2.1 🔴 Gde brana STVARNO stoji (ispravka 08.08.2026)

Prva verzija ovog koraka je prekidače samo **provajdovala** — `ReversiSourceService` i
`LokacijeSourceService` nisu bili injektovani ni u jedan servis, a `assertPorted()` se u
ovim domenima nigde nije zvao. Protivnička provera je to izmerila: pod `REVERSI_IZVOR=3.0`
backend bi se podigao, log bi ispisao „3.0", `assertSpojeniIzvori` ne bi pukao,
`post-deploy-verify.sh` bi dao 🟢 — a **svaki** zahtev bi i dalje čitao i pisao sy15.
Tj. dokument je opisivao branu koje nema, i to baš onu po kojoj se planira preklop.

Sada je brana ožičena, i to **ne po ulaznim metodama** (66 ruta — lako je zaboraviti
jednu) nego po **pristupu sy15 podacima**. Oba servisa dodiruju sy15 na tačno tri načina
i sva tri imaju parnjaka sa branom:

| domen | pristupi sy15 | parnjak sa branom |
|---|---|---|
| Reversi | `sy15.db` (95×), `sy15.withUser` (15×), `sy15.runIdempotent` (2×) | `this.db`, `withSy15User`, `runSy15Idempotent` |
| Lokacije | `sy15.db` (15×), `sy15.withUser` (15×), `sy15.withUserRls` (2×) | `this.db`, `withSy15User`, `withSy15UserRls` |

Da neko sutra doda metodu koja zaobilazi kapiju, obara je statička provera u
`reversi-lokacije-ozicenje.spec.ts` (obrazac iz `odrzavanje.set-role-discipline.spec.ts`).

**Posledica za §6:** pod `3.0` ceo modul danas vraća 503 — to je stanje kvara, ne radno
stanje. Preklop (§6 korak 5) se izvodi TEK po završetku P1–P6. Ranije je to bila samo
rečenica u dokumentu; sada je sprovedeno kodom.

`LocTpFeedService` (`loc-tp-feed.service.ts`) NIJE iza brane — on dodiruje isključivo
`bigtehn_*_cache` i `loc_tp_feed_state`, koje nisu među 21 prenetom tabelom, a i sam je
podrazumevano isključen (`LOC_TP_FEED_ENABLED`). `LocationsService.lookupDrawing` čita 3.0
`work_orders` kroz `this.prisma` — to je 3.0 izvor i namerno nije iza brane.

---

### 2.2 🔴 Ispravka br. 2 (08.08.2026, treći krug): brana je imala TREĆU i ČETVRTU rupu

Tabela u §2.1 popisuje **dva** fajla — i to je bila sva istina koju je test proveravao.
Detektor discipline u `reversi-lokacije-ozicenje.spec.ts` imao je spisak od dva fajla
**zakucan u kodu testa**, i nijedan test nije dokazivao da je taj spisak potpun. Nije bio.
Obilazak celog `backend/src` (fajl koji ima `this.sy15.` **i** pominje neku od 21 prenete
tabele, van komentara) daje **četiri** dodirne tačke:

| # | fajl | šta dodiruje | stanje posle 08.08.2026 |
|---|---|---|---|
| 1 | `modules/reversi/reversi.service.ts` | 14 `rev_*` + `loc_location_movements` | 🟢 iza `assertPorted` (§2.1) |
| 2 | `modules/locations/locations.service.ts` | `loc_*` + `rev_tools` | 🟢 iza `assertPorted` (§2.1) |
| 3 | `modules/odrzavanje/odrzavanje-lokacije-most.service.ts` | **piše** `loc_locations` | 🟢 **NALAZ C — ožičeno sada** |
| 4 | `modules/kadrovska/kadrovska.service.ts` | čita `rev_documents` / `rev_document_lines` / `rev_tools` | 🟠 **NALAZ E — otvoreno, P8** |

**NALAZ C — most `maint_machines` → `loc_locations`.** Taj most (obrazloženje mu je u
zaglavlju servisa) bio je uslovljen **isključivo** `ODRZAVANJE_IZVOR=3.0`, bez ijedne
`LOKACIJE_IZVOR` kapije, a `loc_locations` **jeste** među 21 prenetom tabelom
(`scripts/migrate-reversi-lokacije-sy15.ts`). Posledica pod `ODRZAVANJE_IZVOR=3.0` +
`LOKACIJE_IZVOR=3.0`: lokacija svake nove/izmenjene mašine odlazi u **napuštenu sy15
bazu** — i to **tiho**, jer je most fail-soft (`WARN` + `{ok:false}`). Zaglavlje mosta je
samo reklo „kad ovo umire: sa korakom 3", a korak 3 je ovaj PR — pa most nije ni ugašen ni
preusmeren. `assertSpojeniIzvori` to ne hvata: on spreže REVERSI↔LOKACIJE, ne ODRZAVANJE.

**Odluka: most PRATI `LOKACIJE_IZVOR`, a pod `3.0` se GASI — glasno.**

- `LOKACIJE_IZVOR=sy15` (podrazumevano, i danas na produkciji: prekidač nije postavljen) —
  ponašanje **nepromenjeno**, red u red.
- `LOKACIJE_IZVOR=3.0` — most ne dodiruje sy15 (0 upita), vraća `{ok:false, akcija:"brana"}`
  i loguje **`ERROR`** (most je inače tih, pa `WARN` ne bi bio dovoljan), i to **na startu
  aplikacije** i na svakom pozivu. Fail-soft ugovor („nikad ne baca") ostaje: brana vraća.

Zašto **gašenje**, a ne „piši u 3.0" (odbačeno, i to iz merenih razloga):
1. `loc_locations` u 3.0 nema prepisan `loc_locations_guard_and_path` — to je **P1** (§7).
   Bez njega red dobija `path_cached=''` i `depth=0`: red **postoji**, a u stablu je
   pogrešan. To je gore od reda kog nema — pogrešan red se ne primeti, nedostatak se traži.
2. 3.0 `loc_locations.id` nema DB default (`"id" UUID NOT NULL` u migraciji; `@default(uuid(4))`
   je klijentski), pa sirov `INSERT` bez `id` pada.
3. Format `path_cached` u sy15 nije izmeren (bez VPN-a) — pogađanje formata je izmišljanje
   ponašanja, a ne prepis.

**Cena odluke, izričito:** dok je `LOKACIJE_IZVOR=3.0` a P1 nije gotov, nova mašina **ne
dobija** red u stablu lokacija. To je isto stanje kao ostatak domena pod `3.0` (503 svuda,
§2.1) — dakle stanje kvara, ne radno stanje; upravo zato korak 6 §6 ide TEK posle P1–P6.
Da prekidač ne bi bio mrtav, `OdrzavanjeModule` sada **uvozi** `ReversiLokacijeIzvorModule`
(bez uvoza `@Optional()` prekidač u mostu ostaje `undefined` — kvar iz prvog kruga).

**NALAZ E — kadrovska čita `rev_*` (otvoreno).** `KadrovskaService.offboardingOutstandingReversi`
(panel „Zaduženja za vraćanje" pri odlasku radnika) čita `rev_documents`, `rev_document_lines`
i `rev_tools` kroz `this.sy15.withUserRls`. **Nije ožičeno** i namerno nije dirano: kadrovska
je zamrznuta do svoje seobe (§1.4, §3 red 3). Pod `REVERSI_IZVOR=3.0` taj panel bi prikazao
**zamrznut sy15 snimak** — radnik bi otišao sa alatom koji u 3.0 stoji kao izdat. Upisano
kao **P8** (§7) i kao preduslov koraka 6 (§6). Traži odluku vlasnika: gate + 503, čitanje iz
3.0, ili izričito prihvatanje razilaženja u prozoru.

**Šta sada čuva potpunost spiska:** `reversi-lokacije-ozicenje.spec.ts` odeljak 6 spisak
više ne dobija, nego ga **izvodi** — tabele iz skripta prenosa, sy15 modele iz `@@map` u
`prisma/sy15.prisma`, fajlove obilaskom celog `backend/src`. Svaka dodirna tačka mora biti
upisana u `POZNATE_DODIRNE_TACKE` sa obrazloženjem; nova, neupisana **obara test**. Doda li
neko 22. tabelu u seobu, detektor se širi sam. Komentari se preskaču — bez toga bi
`odrzavanje.service.ts` („CMMS interna hijerarhija lokacija (≠ `loc_locations`)") bio lažan
pogodak, a lažni pogoci ubiju detektor brže od promašaja.

---

## 3. Šema u 3.0 — odluke o tipovima

| # | odluka | obrazloženje (mereno) |
|---|---|---|
| 1 | **uuid PK ostaje uuid** | Nisu legacy BigTehn tabele iz BACKEND_RULES §2 — nastale su u sy15 kao uuid-native. Čuvanje id-jeva održava unakrsne rev↔loc veze, `client_event_uuid` idempotenciju sa mobilne i `loc_sync_outbound_events.id = movements.id`. Prenos time postaje egzaktno idempotentan (upsert po ključu, bez remap tabele). |
| 2 | **`auth.users` uuid → `users.id` (Int)** | 13/13 razrešeno po mejlu. NOT NULL kolone (`rev_documents.issued_by`, `loc_location_movements.moved_by`) uz nerazrešen nalog = **BLOKADA**, red se ne upisuje. Nema tihog podmetanja tuđeg naloga. |
| 3 | **`employees` uuid ostaje meki, bez FK** | Kadrovska zamrznuta; v. §1.4. |
| 4 | **PG enum → String + CHECK** | BACKEND_RULES §2. Vrednosti prepisane 1:1 iz `pg_enum` (4 tipa, 38 vrednosti). |
| 5 | **`bigtehn_sifra_artikla` bez FK** | U sy15 gađa `bigtehn_artikli_cache` kojeg u 3.0 nema; izmereno **0/47** popunjenih. |
| 6 | **`rev_document_lines.work_order_id` → `work_order_ref_id`** | U sy15 uuid bez FK, izmereno **0/42** popunjenih. Preimenovano da ga niko ne pomeša sa pravim FK-om na 3.0 `work_orders` (Int). |
| 7 | **Novčane/količinske kolone `Decimal`** | `numeric(12,3)` za količine, `numeric(12,2)` za `trosak`/`nabavna_vrednost` — precizno kao u izvoru, nikad Float. |

Migracija: `backend/prisma/migrations/20260808100000_seoba_reversi_lokacije/`.
Generisana **offline** (`prisma migrate diff` datamodel→datamodel, BACKEND_RULES §12),
plus ručni SQL rep: **38** CHECK-ova, 13 izraznih/parcijalnih indeksa i jedan
`SET NOT NULL` koje Prisma ne ume
(najvažniji: `uq_loc_locations_scope_code_ci` — šifra lokacije jedinstvena u okviru
roditelja i bez obzira na veličinu slova, i parcijalni UNIQUE nad `client_event_uuid`).

**Dokaz:** migracija je primenjena na kopiju **produkcijske 3.0 šeme**
(`pg_dump --schema-only` → `proba_seoba_rl_wf5` na `servosync-dev`), `ON_ERROR_STOP=1`,
izlaz 0, 21 tabela nastala.

---

## 4. 🔴 NAJTEŽA STAVKA: `rev_issue_reversal` i `rev_confirm_return`

Ovo je razlog zbog kog domen ne može da pređe „prekidačem". Cela poslovna logika
izdavanja i povraćaja živi u PL/pgSQL-u; **u TypeScript-u je NEMA.** Ne prevodi se
mehanički — piše se iznova, uz testove.

### 4.1 `rev_issue_reversal(p_payload jsonb)` — izdavanje

Telo (SECURITY DEFINER, `search_path=public,pg_temp`), korak po korak:

1. **Pravo:** `IF NOT rev_can_manage() THEN RAISE 42501`.
2. **Validacija ulaza:** `doc_type` i `recipient_type` obavezni; `lines` mora imati ≥ 1 stavku.
3. **Idempotencija masovnog uvoza:** ako je poslat `bulk_import_legacy_key`, traži se
   postojeći `rev_documents` po tom ključu → ako postoji, vraća se
   `{success, idempotent:true, doc_id, doc_number}` **bez ikakvog upisa**.
   (U bazi to čuva parcijalni UNIQUE indeks.)
4. **Izvođenje ključa primaoca** (`CASE recipient_type`):
   - `EMPLOYEE` → ključ = `recipient_employee_id`, natpis = `recipient_employee_name`
     ili „Nepoznat radnik";
   - `DEPARTMENT` → ključ = `lower(regexp_replace(odeljenje,'[^a-z0-9]','-','g'))`;
   - `EXTERNAL_COMPANY` → isto pravilo nad nazivom firme;
   - inače → `RAISE`. Prazan ključ = `RAISE`.
   ⚠️ `MACHINE` je dozvoljen u CHECK-u tabele, ali ovde **nije obrađen** — prepis mora
   odlučiti da li je to propust ili namera (v. §7, otvoreno pitanje O-1).
5. **Broj dokumenta:** `rev_next_doc_number(doc_type)` (brojač po tipu i godini).
6. **Ciljna lokacija:** `rev_get_or_create_recipient_location(tip, ključ, natpis)` —
   nalazi ili PRAVI `loc_locations` red za primaoca i upisuje `rev_recipient_locations`.
   **Ovo je prvi upis u domen Lokacija unutar iste transakcije.**
7. **INSERT `rev_documents`** (`issued_by = auth.uid()`), `RETURNING id`.
8. **Petlja po stavkama** (`jsonb_array_elements(lines)`):
   - **`line_type='TOOL'`:**
     - `tool_id` obavezan; alat se učitava (`NOT FOUND` → `RAISE`);
     - **ako je `is_quantity`:** `qty = GREATEST(quantity, 1)`;
       - **ako je i `is_consumable`:** INSERT stavke sa `line_status='CONSUMED'`, pa
         `rev_hand_tool_apply_delta(tool, -qty, 'ISSUE', …)` (knjiga stanja) — **i to je
         sve; NEMA kretanja lokacije** (potrošni materijal se ne prati po polici);
       - inače: INSERT stavke, bez kretanja lokacije;
       - `CONTINUE` — količinski alat nikad ne dira Lokacije.
     - **inače (komadni alat):** `item_ref_table='rev_tools'`,
       `item_ref_id = tool.loc_item_ref_id`, a **`from_location_id` se čita iz
       `loc_item_placements`** (`ORDER BY placed_at DESC LIMIT 1`).
   - **inače (`PRODUCTION_PART` / kooperacija):**
     `item_ref_table='bigtehn_drawings_cache'`,
     `item_ref_id = drawing_no` ili `part_name` ili `'UNKNOWN'`; `from_location_id = NULL`.
   - **INSERT `rev_document_lines`** `RETURNING id`.
   - **`loc_create_movement(...)`** sa `movement_type='REVERSAL_ISSUE'`,
     `to_location_id` = lokacija primaoca, `movement_reason='Reversal: <broj>'`.
     Ako vrati `ok=false` → `RAISE` (cela transakcija pada — dokument se NE kreira).
   - `UPDATE rev_document_lines SET issue_movement_id = <id kretanja>`.
9. **Ako nijedna stavka nije ostala `ISSUED`** (sve potrošno) → dokument se odmah
   zatvara: `status='RETURNED'`, `return_confirmed_by=auth.uid()`.
10. Vraća `{success, doc_id, doc_number}`.

### 4.2 `rev_confirm_return(p_payload jsonb)` — povraćaj

1. **Pravo:** `rev_can_manage()`.
2. `SELECT … FROM rev_documents WHERE id=… **FOR UPDATE**` — brava nad dokumentom.
   `NOT FOUND` → `P0002`. Status već `RETURNED`/`CANCELLED` → `P0001`.
3. **Petlja po `returned_lines`:**
   - stavka se učitava po `line_id` **i** `document_id` (tuđa stavka se preskače);
   - **preskače se sve što nije `ISSUED`** — `CONSUMED`/`RETURNED`/`LOST`/`SCRAPPED`
     se ne vraćaju (to je pravilo, ne propust);
   - `returned_quantity <= 0` → preskok;
   - **ako je alat `is_quantity`:** samo se uveća `returned_quantity` i prestili
     `line_status` (`RETURNED` kad `vraćeno ≥ količina`) — **bez kretanja lokacije**;
   - inače: `item_ref_id = tool.loc_item_ref_id`
     (`NULL` → `RAISE 'Alat nema loc_item_ref_id'`, tj. tvrda greška);
     za ne-alat: `item_ref_table='bigtehn_drawings_cache'`, `item_ref_id = drawing_no`;
   - **`loc_create_movement(...)`** sa `movement_type='REVERSAL_RETURN'`,
     `from` = lokacija primaoca iz dokumenta, `to` = `return_to_location_id` iz zahteva.
     `ok=false` → `RAISE`;
   - `UPDATE` stavke: `returned_quantity += …`, `return_movement_id`, `line_status`.
4. **Zaključivanje:** ako više nema nijedne `ISSUED` stavke → `status='RETURNED'`,
   inače `'PARTIALLY_RETURNED'`; upisuje se `return_confirmed_by/at`, `return_notes`.
5. Vraća `{success, all_returned, doc_id}`.

### 4.3 Šta se uz njih MORA prepisati (inače ne rade)

| funkcija | šta nosi | zašto se ne može zaobići |
|---|---|---|
| `loc_create_movement` | ~230 linija: provera prava, idempotencija po `client_event_uuid`, provera da je ciljna lokacija aktivna I da joj **nijedan predak nije neaktivan** (rekurzivni CTE), `pg_advisory_xact_lock` po ključu stavke, izvođenje `from` lokacije kad nije poslata (0 → `no_current_placement`, >1 → `from_ambiguous`), provera raspoložive količine | Obe gornje funkcije ga zovu za SVAKU stavku |
| `loc_after_movement_insert` (triger) | upsert `loc_item_placements` na `to` lokaciji (`ON CONFLICT … quantity + EXCLUDED.quantity`), oduzimanje sa `from` lokacije (`<=0` → brisanje reda), izvlačenje `Crtež:NNN` iz napomene kad `drawing_no` nije poslat, upis u izlazni red (osim za `source='bigtehn'`) | Bez njega stanje po lokacijama prestaje da se održava |
| `rev_next_doc_number` | brojač po tipu dokumenta i godini | Numeracija bi krenula od 1 i sudarila se sa `uq_rev_documents_doc_number` |
| `rev_get_or_create_recipient_location` | nalazi/pravi lokaciju primaoca | Prvi upis u Lokacije unutar transakcije izdavanja |
| `rev_hand_tool_apply_delta` | knjiga stanja količinskog alata (`rev_tool_stock_ledger` + `total_qty`) | Potrošni alat |
| `rev_can_manage`, `loc_can_create_movement`, `loc_can_manage_locations`, `loc_is_admin` | prava | U 3.0 se ne prepisuju doslovno — preslikavaju se u `PermissionsGuard` (§7, O-2). `loc_can_create_movement` je poseban: pored role gleda i `employees.department_id IN (2,3)` / `sub_departments.name='Magacin i logistika'` — to je pravilo koje 3.0 katalog dozvola trenutno NEMA |
| `loc_locations_guard_and_path` + `loc_locations_after_path_change` (trigeri) | računaju `path_cached` i `depth`, brane cikluse | Bez njih hijerarhija lokacija tiho puca |
| `rev_issue_cutting_reversal` / `rev_confirm_cutting_return` | ista priča za REZNI alat (~200 + ~110 linija), preko `rev_cts_apply_delta` | Tabele su danas prazne, ali kod ih zove (7 + 4 mesta) |

**Procena:** 5–8 radnih dana za `rev_issue_reversal` + `rev_confirm_return` +
`loc_create_movement` + triger logiku, sa testovima. Rezni alat +2–3 dana.

---

## 5. Prenos podataka

Skripta: `backend/scripts/migrate-reversi-lokacije-sy15.ts`
(obrazac: `migrate-odrzavanje-sy15.ts`).

```bash
npx ts-node --transpile-only backend/scripts/migrate-reversi-lokacije-sy15.ts               # dry-run (podrazumevano)
npx ts-node --transpile-only backend/scripts/migrate-reversi-lokacije-sy15.ts --show-columns # revizija mape kolona
npx ts-node --transpile-only backend/scripts/migrate-reversi-lokacije-sy15.ts --apply        # plan prolaz + upis
npx ts-node --transpile-only backend/scripts/migrate-reversi-lokacije-sy15.ts --verify-only  # brojevi + otisak ključeva
```

Osobine:

- **idempotentna** — `INSERT … ON CONFLICT (ključ) DO UPDATE`, uuid-ovi se čuvaju;
- **sve ide kroz `::text`** na čitanju i uz eksplicitan `::<tip>` cast na upisu, da
  `numeric` ne prođe kroz JS `number` i `timestamptz` kroz `Date`;
- **grupni upis (200 redova po naredbi)** — nije optimizacija nego pouzdanost:
  red-po-red je 5.700 round-trip-ova preko VPN-a, i **pao je na 171. redu od 1.562**
  (`P1017`, „Server has closed the connection") pre nego što je uveden;
- **dva prolaza** za `loc_location_movements` (`correction_of_movement_id` je FK na
  samu sebe): prvi upisuje sve sa `NULL`, drugi ga `UPDATE`-uje.
  `loc_locations.parent_id` je rešen sortiranjem po `depth` (roditelj uvek pre deteta);
- **`barcode` i `loc_item_ref_id` se prenose eksplicitno** — u sy15 ih kuju trigeri
  kojih u 3.0 nema; bez toga bi veza 47/47 sa Lokacijama pukla;
- NOT NULL kolone identiteta uz nerazrešen nalog = **BLOKADA sa spiskom**, red se ne
  upisuje (ne izmišlja se nalog i ne gubi se red u tišini);
- 🔴 **`--apply` UVEK prvo izvede plan prolaz** (čita, razrešava identitet, ne piše).
  Ako ima ijedne blokade, upis se **ne pokreće** i odredište ostaje netaknuto
  (izlazni kod 1). Ranije se blokada otkrivala TOKOM pisanja: blokiran `rev_documents`
  red obarao je sledeći batch na FK i ostavljao delimično popunjenu bazu (ispravka
  08.08.2026);
- 🔴 **sve tri komande vraćaju izlazni kod ≠ 0 kad nešto ne valja** — runbook korak se
  izvodi iz skripte i ne sme da prođe tiho ako operater ne gleda u ekran.

### 5.1 🔴 Šta `--verify-only` dokazuje, a šta ne (ispravka 08.08.2026)

Prva verzija je poredila **samo `count(*)`** po tabeli + 4 šava. To NIJE dokaz, jer je
skripta čist UPSERT — **nikad ne briše** — a `loc_item_placements` se u sy15 **briše**
kad količina padne na 0 (triger `loc_after_movement_insert`, §4.3). Znači: jedno
premeštanje između dva `--apply` (nestane red A, nastane red B) ostavlja u 3.0 fantomski
red A, **brojevi se savršeno poklope, i verify javi 🟢**.

Sada uz broj ide i **otisak skupa ključeva** (`md5` nad sortiranim ključevima), koji taj
slučaj hvata i prikazuje ga posebnim znakom:

| znak | značenje |
|---|---|
| 🟢 | broj redova I skup ključeva se poklapaju |
| 🟠 | **isti broj, drugi ključevi** — fantomski ili nedostajući red (tihi slučaj gore) |
| 🔴 | broj redova se ne poklapa (ili tabele nema) |

⚠️ **Šta i dalje NIJE dokazano:** poklapanje sadržaja neključnih kolona. Otisak preko
svih kolona nije moguć jer se kolone identiteta (`auth.users` uuid → `users.id` Int) po
definiciji razlikuju između baza. Sadržaj se dokazuje ciljanim zbirovima iz §5.2
(`sum(quantity)`, `max(moved_at)`), koje treba ponoviti i na produkciji.

### 5.2 🟢 Dokaz na probnoj bazi (NE na produkciji)

Probna baza: `proba_seoba_rl_wf5` na `servosync-dev` (port 5437) — kopija
**produkcijske 3.0 šeme** + `workers`/`users` podaci (71 nalog), pa migracija koraka 3.

| provera | rezultat |
|---|---|
| broj redova, svih 21 tabela | 🟢 **21/21 se poklapa** (5.659 redova) |
| šav `rev_tools.loc_item_ref_id` ↔ `loc_item_placements` | 🟢 47 → 47 |
| šav `issue_movement_id` → `loc_location_movements` | 🟢 40 → 40 |
| šav `return_movement_id` → `loc_location_movements` | 🟢 1 → 1 |
| šav `rev_documents.recipient_loc_id` → `loc_locations` | 🟢 27 → 27 |
| blokade | 🟢 **nema** (13/13 naloga razrešeno) |
| **idempotencija: drugi uzastopni `--apply`** | 🟢 **isti brojevi, bez duplikata** |
| `sum(quantity)` kretanja | 🟢 175.384,000 = 175.384,000 |
| `sum(quantity)` stanja | 🟢 99.824,000 = 99.824,000 |
| `max(moved_at)` (do mikrosekunde) | 🟢 `2026-08-07 11:56:35.383878+00` identično |
| `count(DISTINCT movement_type)` | 🟢 5 = 5 |
| `moved_by` NULL | 🟢 0 = 0 |

⚠️ **Nije dokazano:** drugi prolaz (`correction_of_movement_id`) — na produkciji
je **0 redova** sa popunjenom tom kolonom, pa ga stvarni podaci nisu ni okinuli.
Pre `--apply` na produkciji proveriti da je i dalje 0; ako nije, prvo ga isprobati
na probnoj bazi.

---

## 6. Preklop — redosled (kad logika bude prepisana)

**Ovo se NE izvodi sada.** Ovde je zapisano da se ne bi improvizovalo kasnije.

🔴 **DRUGI PREDUSLOV (v. §2.2):** dve dodirne tačke stoje IZVAN dva domenska servisa.
**P1** mora biti gotov da bi most `maint_machines` → `loc_locations` opet upisivao
lokaciju (pod `LOKACIJE_IZVOR=3.0` on je UGAŠEN, pa nova mašina ne dobija red u stablu),
a **P8** da panel „Zaduženja za vraćanje" u kadrovskoj ne bi čitao zamrznut sy15 snimak.

🔴 **PREDUSLOV KOJI SADA SPROVODI KOD (v. §2.1):** korak 5 postavlja prekidače na `3.0`,
a brana je od 08.08.2026 stvarno ožičena — dok P1–P6 nisu gotovi, `3.0` znači da **ceo
modul vraća 503**, ne „radi po starom". Koraci 6–10 se dakle izvode isključivo posle
P1–P6. Do tada se izvode najviše koraci 1–5 (prenos podataka), i to je bezbedno:
prenos ne dira prekidače.

1. Objaviti prozor. **Lokacije se pišu uživo** (§0) — bez prozora se izgube kretanja
   nastala između `--apply` i preklopa.
2. Zaustaviti upise: `LOKACIJE_IZVOR` i `REVERSI_IZVOR` ostaju `sy15`, ali se u sy15
   privremeno oduzme `INSERT` pravo nad `loc_location_movements` roli `servosync2_app`
   (mobilna dobija grešku, ne tihi gubitak).
3. **Dry-run** (bez zastavica) → plan prolaz mora dati „🟢 Nema blokada". Ako ima
   blokada, `--apply` bi ih ionako odbio — reši ih pre prozora, ne u prozoru.
4. `--verify-only` → zabeležiti brojeve i otiske PRE.
5. `--apply` → mora dati 🟢 na svih 21 tabelu i sva 4 šava, **bez ijednog 🟠**
   (🟠 = isti broj, drugi ključevi → fantomski red iz ranijeg prolaza, v. §5.1) i
   izlazni kod 0.
6. `REVERSI_IZVOR=3.0` **i** `LOKACIJE_IZVOR=3.0`, pa
   **`docker compose up -d`** (ne `restart` — pouka 07.08.2026: `restart` NE čita
   novi env, kontejner ostaje zdrav i radi po starom prekidaču).
7. Potvrditi u logu: `REVERSI_IZVOR=3.0 — …` i `LOKACIJE_IZVOR=3.0 — …`, i da
   `assertSpojeniIzvori` NIJE pukao.
8. `backend/scripts/post-deploy-verify.sh` — bez 🟢 se ne kaže „radi".
9. 🔴 **Dimni test uživo — jedini korak koji dokazuje da preklop radi.** Koraci 7 i 8
   daju 🟢 i kad modul ne radi ništa: oni mere da se backend podigao, ne da podaci idu
   u pravu bazu. Jedno premeštanje sa mobilne, jedno izdavanje alata, jedan povraćaj —
   pa proveriti da su **oba** upisa (dokument i kretanje) u 3.0, i da u sy15 nije
   nastao nijedan nov red.
10. 🔴 **Provera dve dodirne tačke iz §2.2 — MERI, ne čitaj odsustvo poruke.**

    ⚠️ Ranija verzija ovog koraka je govorila „u logu NE SME stajati *most … je UGAŠEN*",
    dakle **odsustvo** poruke je značilo uspeh. To je bilo **lažno zeleno**: poruka je
    tada bila uslovljena i sa `ODRZAVANJE_IZVOR=3.0`, a korak 6 taj prekidač ne dira —
    pa je u stvarnom stanju posle preklopa (`ODRZAVANJE=sy15 + LOKACIJE=3.0`) poruke
    nije ni moglo biti, a kvar je bio u toku.

    Poruka sada stiže kad god je `LOKACIJE_IZVOR=3.0`, i **kaže ko je pisac**:
    - „…pisac je sy15 TRIGER `trg_maint_machines_loc_sync`…" → mašine su još u sy15,
      pa **sy15 triger** puni napuštenu sy15 `loc_locations`. Kod to ne može da
      zaustavi. Dok korak 2 (Održavanje) ne pređe, nove mašine **ne ulaze u stablo
      lokacija u 3.0**. To je poznato prelazno stanje — ne blokira preklop, ali mora
      biti svesno i zapisano.
    - poruka bez tog repa → pisac bi bio aplikativni most i brana ga hvata.

    🔴 **Pravi dokaz je merenje, ne log.** Napravi jednu mašinu, pa uporedi:
    ```bash
    # nova baza — mora dobiti red
    docker exec servosync-pg psql -U servosync -d servosync -c \
      "SELECT count(*) FROM loc_locations WHERE code = '<sifra>';"
    # stara baza — ne sme dobiti nov red
    docker exec sy15-db psql -U supabase_admin -d postgres -c \
      "SELECT count(*) FROM public.loc_locations WHERE code = '<sifra>';"
    ```
    Ako nov red padne u STARU bazu, pisac je sy15 triger i to je gornje prelazno stanje.

    Offboarding panel kadrovske mora davati iste brojeve kao Reversi u 3.0 (P8) —
    inače radnik odlazi sa alatom koji u 3.0 stoji kao izdat.
11. Vratiti `INSERT` pravo u sy15 (za slučaj povratka), ali NE oglašavati stari UI.

**Povratak (~2 min):** obe promenljive na `sy15` + `docker compose up -d`.
Podaci upisani u 3.0 posle preklopa se time ne vraćaju u sy15 — zato korak 9 mora
biti čist pre nego što se korisnicima kaže da rade.

---

## 7. Šta OSTAJE (procena u danima)

| # | posao | procena | napomena |
|---|---|---:|---|
| **P1** | Prepis `rev_issue_reversal` + `rev_confirm_return` + `loc_create_movement` + trigerska logika (`loc_after_movement_insert`, `loc_locations_guard_and_path`) u NestJS, u jednoj Prisma transakciji, sa testovima | **5–8** | §4; ovo je kritični put |
| **P2** | Prepis rezni-alat grane (`rev_issue_cutting_reversal`, `rev_confirm_cutting_return`, `rev_cts_apply_delta`) | 2–3 | tabele prazne, ali kod ih zove |
| **P3** | 16 view-ova (15 `v_rev_*` + `v_loc_tp_operation_slots`) → Prisma upiti / SQL view-ovi u 3.0 | 3–4 | `v_rev_machines` NIJE ovde — on prati `ODRZAVANJE_IZVOR` |
| **P4** | 51 RLS politika → dozvole u `PermissionsGuard` (AUTHZ_UNIFIED) | 2–3 | uključuje pravilo iz `loc_can_create_movement` koje gleda `department_id IN (2,3)` / „Magacin i logistika" — 3.0 katalog to danas NEMA |
| **P5** | Preostale pomoćne funkcije koje kod zove (`loc_move_cage`, `loc_report_parts_by_locations`, `loc_tps_for_predmet`, `loc_locations_audit`, `rev_add_inventory_*`, `rev_write_off_tool`/`rev_restore_tool`, `loc_bigtehn_ingest_*`) | 3–5 | ~14 funkcija |
| **P6** | Idempotencija mutacija reversa/lokacija u 3.0 sloju (zamena za `rev_api_idempotency`, §1.2) | 1 | mobilna šalje `client_event_uuid` — parcijalni UNIQUE već postoji u migraciji |
| **P8** | 🔴 Dve dodirne tačke izvan domenskih servisa (§2.2): **(a)** most `maint_machines` → `loc_locations` prepisati na upis u 3.0, i to u ISTOJ transakciji kao mašina — ide uz `loc_locations_guard_and_path` iz P1, čime odstupanje „fail-soft posle commit-a" nestaje; **(b)** `KadrovskaService.offboardingOutstandingReversi` čita `rev_documents`/`rev_document_lines`/`rev_tools` iz sy15, a kadrovska je zamrznuta | 1–1,5 | (b) traži odluku — O-4 |
| **P7** | Prenos + preklop po §6, uz prozor zabrane upisa | 0,5 | posle P1–P6 **i P8** |
| | **UKUPNO** | **17,5–26 dana** | ~4–5,5 nedelja jednog čoveka |

### Otvorena pitanja (ne rešavati u kodu pre potvrde)

- **O-1:** `rev_issue_reversal` ne obrađuje `recipient_type='MACHINE'`, iako ga CHECK
  tabele dozvoljava, a `rev_documents.recipient_machine_code` i `v_rev_cts_by_machine`
  postoje. Propust ili namera? Prepis ne sme da „popravi" ovo bez odluke.
- **O-2:** `loc_can_create_movement` daje pravo i po odeljenju (`department_id IN (2,3)`,
  `sub_departments.name='Magacin i logistika'`), a ne samo po roli. To je pravilo koje
  živi u kadrovskoj — dok ona ne pređe, 3.0 ga može reprodukovati samo čitanjem sy15
  ili tvrdo kodiranom listom. Traži odluku.
- **O-4 (NOVO, 08.08.2026):** kadrovska čita `rev_*` (§2.2, NALAZ E), a zamrznuta je do
  svoje seobe. Tri izlaza: **(a)** brana + 503 na tom jednom panelu, **(b)** čitanje iz
  3.0 uz jednu izmenu u zamrznutom modulu, **(c)** izričito prihvatanje razilaženja dok
  kadrovska ne pređe. Ne dirati bez odluke — taj panel odlučuje da li radnik odlazi sa
  nevraćenim alatom.
- **O-3:** 400 od 702 `item_ref_id` (`bigtehn_rn`) ne postoji ni u 3.0 ni u mrtvom kešu.
  Prenosi se kao istorija (bez FK). Da li ih uopšte prikazivati u izveštajima?

---

## 8. Sudbina grane `feat/sy15-seoba-reversi` — ODBAČENA

Grana od 05.08.2026 (`29509e49`), **128 commit-a iza `main`-a**. Sadržaj: 14 Prisma
modela, migracija od 572 linije, prenosna skripta od 799 linija, `ReversiSourceService`,
`docs/SEOBA_REVERSA_2026-08-05.md`.

**Odluka: preuzeti ideje, odbaciti kod.** Razlozi, po težini:

1. **Pokriva samo pola posla.** 14 rev modela, **nijedan `loc_*`** — a §1.3 pokazuje
   da se domeni ne mogu razdvojiti. Njena migracija bi napravila `rev_document_lines`
   sa `issue_movement_id` koji ne pokazuje nigde.
2. **`ReversiSourceService` je pisan pre nego što je `IzvorPrekidac` postojao** —
   dupla implementacija istog prekidača, bez zajedničke brane, bez `zastareliAlias`
   logike i bez sprege iz §2.
3. **`reversi.service.ts` je tamo izmenjen +304/−120 nad verzijom od pre 128 commit-a.**
   Danas taj fajl ima 3.190 linija i druge putanje; merge bi bio prepisivanje.
4. Njena skripta ne rešava `correction_of_movement_id`, `loc_locations.parent_id`
   redosled ni grupni upis — sve tri stvari su se ovde pokazale kao neophodne.

**Šta je preuzeto:** odluka o čuvanju uuid PK-ova, obrazac mapiranja identiteta po
mejlu, pravilo „NOT NULL nerazrešen = blokada, ne tiho preskakanje", i — najvrednije —
**zaključak da `rev_api_idempotency` ne pripada domenu** (§1.2), koji je ta grana prva
izmerila i koji ovde potvrđujemo nezavisnim merenjem.

Grana se **ne briše** (istorijat merenja), ali se **ne merge-uje**.

---

## 9. Šta je isporučeno ovim korakom

| stavka | put |
|---|---|
| Prisma šema, 21 model + 14 back-relacija na `User` | `backend/prisma/schema.prisma` |
| Offline migracija (21 tabela, **38** CHECK-ova, 13 izraznih indeksa, 1 `SET NOT NULL`) | `backend/prisma/migrations/20260808100000_seoba_reversi_lokacije/` |
| Prekidači + brana sprege | `backend/src/common/sy15/{reversi,lokacije}-source.service.ts`, `spojeni-izvori.ts`, `reversi-lokacije-izvor.module.ts` |
| **Ožičenje brane u domenske servise** (`assertPorted` nad svakim pristupom sy15) | `backend/src/modules/reversi/reversi.service.ts`, `backend/src/modules/locations/locations.service.ts` |
| Testovi prekidača (18) | `backend/src/common/sy15/reversi-lokacije-izvor.spec.ts` |
| Testovi OŽIČENJA (podizanje modula, uvoz, injekcija, 503, disciplina) | `backend/src/common/sy15/reversi-lokacije-ozicenje.spec.ts` |
| **Detektor dodirnih tačaka** — sam obilazi `src`, obim čita iz skripta prenosa (§2.2) | isti fajl, odeljak 6 |
| **NALAZ C:** most `maint_machines` → `loc_locations` prati `LOKACIJE_IZVOR` | `backend/src/modules/odrzavanje/odrzavanje-lokacije-most.service.ts`, `odrzavanje.module.ts` |
| Prenosna skripta (idempotentna, plan prolaz pre upisa, izlazni kodovi) | `backend/scripts/migrate-reversi-lokacije-sy15.ts` |
| Otisak skupa ključeva (izdvojen da bi bio testabilan) | `backend/scripts/lib/keyset-checksum.ts` |
| Testovi provere prenosa (otisak + brane `--apply`) | `backend/src/common/sy15/reversi-lokacije-prenos.spec.ts` |
| Promenljive okruženja | `backend/.env.example` |
| Ovaj runbook | `docs/SEOBA_REVERSI_LOKACIJE_2026-08-07.md` |

**Na produkciji nije promenjeno ništa.** Oba prekidača su `sy15`; migracija nije
primenjena na `servosync-pg`; prenos je pokretan isključivo nad probnom bazom
`proba_seoba_rl_wf5`.
