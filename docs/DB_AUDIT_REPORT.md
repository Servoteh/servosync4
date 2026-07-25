# Audit baze podataka ServoSync — izveštaj

**Datum:** 25.07.2026 · **Vrsta:** READ-ONLY audit (ništa nije menjano — ni šema, ni podaci, ni kod; nad živom bazom izvršavani isključivo `SELECT`/`SHOW`/katalog upiti) · **Autor:** AI audit (Claude, 6 paralelnih prolaza po oblastima + verifikacija nad produkcijskom bazom)

**Obuhvat:** `backend/prisma/schema.prisma` (glavna 3.0/4.0 šema), `backend/prisma/sy15.prisma` (legacy datasource, read-only), svih 53 migracije, ceo `backend/src/**` (upotreba baze u kodu), i živa produkcijska baza `servosync-pg` na ubuntusrv (introspekcija kataloga). Nalazi nad sy15 bazom su označeni `[SY15/legacy]` — ta baza se gasi po planu, pa se za nju ne predlažu strukturne izmene.

---

## 1. Pregled

| | |
|---|---|
| Engine | **PostgreSQL 18.4** (Docker kontejner `servosync-pg`, port 5435; nativni servis ne postoji) |
| Veličina baze | **2.408 MB**, od čega **2.102 MB (87%) drži jedna tabela — `drawing_pdfs`** (5.737 redova, PDF u `bytea`, ~370 KB po redu; korekcija 25.07 popodne — prvobitno očitanih „96 redova" bio je zastareo `pg_stat` brojač) |
| Tabele | 174 u `public` (+ zaostala šema `cutover_stash`); šema definiše **172 Prisma modela** |
| Relacije | samo **100 FK relacija** u šemi; **303 `*_id` kolone bez FK constrainta** na produ (pretežno svesne „meke" reference ka sync-keš/legacy tabelama) |
| Enum / CHECK | **0 Prisma enuma** (svesna odluka, BACKEND_RULES §2) i **0 CHECK constrainta u celoj bazi** |
| ORM | Prisma 6 (NestJS 11); drugi datasource `sy15.prisma` (147 modela, generiše se samo klijent — migracije ne postoje, read-only garantovano na nivou repoa) |
| Migracije | 53 na disku (51 primenjena na produ + `20260725100000` komitovana a još neprimenjena + `20260725120000` untracked WIP) |
| Timezone | Baza radi u **`Etc/UTC`**; Node kontejner **nema TZ** (UTC). Kolone: 157 `timestamptz` vs 117 `timestamp` (naive) vs 12 `date` — dva režima naporedo |
| RLS | **0 tabela, 0 politika** — migracija `authz_rls_ready` je samo priprema (helper funkcije), sva kontrola pristupa je aplikaciona |
| Backup | Noćni `pg_dump -Fc` (cron 02:30) pokriva i `servosync-pg` i sy15 + storage, sa proverom integriteta i retencijom 7d/28d — ali **sve kopije na istom disku; off-site = TODO u samoj skripti; restore nikad testiran; `archive_mode=off`** |

**Opšti utisak.** Jezgro sistema je zdravije nego što je tipično za port legacy ERP-a: sav raw SQL je parametrizovan ili whitelist-ovan (nijedna injection tačka nije nađena), refresh tokeni se čuvaju kao hash sa rotacijom i reuse-detekcijom, svi brojači dokumenata sem jednog koriste advisory lock, knjiženja idu kroz transakcije, seed-migracije su idempotentne, a batch-resolve obrazac (`in:` + mape) drži N+1 higijenu iznad proseka. Novi 4.0 kod dosledno koristi `Decimal(19,4)` za novac i `timestamptz` za vreme.

Drugi sloj je nasleđe QBigTehn porta i on nosi glavninu tehničkog duga: „meke" reference bez FK kao sistemski obrazac (uz `@default(0)` sentinele umesto NULL), novac kao `Float` u 70 kolona sync-keš tabela, dva timestamp režima, nekonzistentne dužine istih identifikatora, i potpuno odsustvo CHECK ograničenja — DB danas prihvata negativnu količinu, kurs 0, mesec 13 i negativno „duguje" bez ijedne greške. To je delom svesna arhitektura („validacija u servisu"), ali na finansijskim tabelama 4.0 (glavna knjiga, PDV) ta filozofija ostavlja sistem bez poslednje linije odbrane.

Najozbiljnije tačke nisu tamo gde se obično traže: (1) DB dozvoljava **brisanje knjiženih naloga glavne knjige sa kaskadnim brisanjem svih stavki** (DB-001); (2) **POPDV šifarnici su prazni na produkciji** jer seed fajlovi nisu povezani ni u jedan korak deploy-a (DB-073); (3) BigBit sync **i dalje upisuje plaintext lozinke** u produkcijsku bazu (DB-049); (4) backup nema off-site kopiju ni testiran restore (DB-074); (5) vruće proizvodne tabele (216k operacija, 99k TP) rade dnevne upite preko sekvencijalnih skanova jer Prisma ne indeksira FK kolone automatski (DB-037).

---

## 2. Mapa šeme

Glavni domeni i veze (strelica = FK ili dokumentovana meka referenca; `~` = sync-keš iz BigBit-a, piše ga samo sync):

```
ŠIFARNICI (~BigBit keš)          PDM / PLANIRANJE                PROIZVODNJA (core)
  customers ~                      drawings ──┬─ drawing_components   work_orders ─┬─ work_order_operations (216k)
  items ~  item_groups ~           (11,7k)    ├─ drawing_assemblies   (40,8k)      ├─ work_order_{machined_parts,
  salespeople ~  warehouses ~                 ├─ drawing_pdfs (2,1GB!)             │   blanks,nonstandard_parts,
  document_types ~  tax_rates ~               └─ drawing_plans/items               │   components,launches,approvals}
  projects ~ (7,6k; dual unos)     mrp_demands/items, mrp_item_stock  ├─ tech_processes (99k) ─ work_time_entries
  companies ~ (multi-firma)                                           ├─ part_locations (7,3k; živ unos)
                                   PRIMOPREDAJA                       ├─ cnc_programs
AUTH / AUDIT                        handover_drafts/items (4k)        └─ workers ─ worker_employee_map → sy15 UUID
  users ─ user_roles                drawing_handovers (3,7k)
  refresh_tokens (hash)             handover_statuses (FK šifarnik)  KVALITET / MONTAŽA
  audit_log (15,4k; samo           labels (snapshot za štampu)       nonconformity_reports, quality_documents
  praćenje+TP), app_notifications                                     montage_nonconformities/+photos,events

PRAĆENJE / PLAN (3.0-native)       ZAHTEVI (AI-PM)                  SCHEDULER
  pracenje_overrides/notes          change_requests + attachments/    scheduled_job_runs
  operativne_aktivnosti(+blokade)   ai_analyses/comments/events
  plan_proizvodnje_* (5 tabela)     decision_log_entries
  predmet_aktivacije, predmet_planeri, koop_otpremnice/stavke

ERP 4.0 (app-owned; tabele još pretežno prazne — pilot)
  accounts (1.398) ─ accounting_schemes/lines ─ journal_entries ══╗ ON DELETE CASCADE (DB-001)
  saldakonto_accounts                                             ╚═ ledger_entries ─ (reconciled par)
  purchase_requests/rfqs/orders + items      customer_rfqs
  stock_documents/items ─ stock_levels(prazna!) ─ item_valuations ─ inventory_counts ─ kepu_book_entries
  invoices/items ─ document_number_sequences ─ customer_discounts
  sef_outbox / sef_incoming_invoices / sef_status_log
  bank_statements/lines ─ payment_orders ─ compensation_orders/lines ─ exchange_rates
  vat_returns/lines ─ vat_ledger_entries ─ vat_account_map(20) ─ popdv_account_map(0!) ─ popdv_definitions(0!)
  financial_statements/lines ─ balance_formula_definitions (57)
  cash_journals/entries, interest_rates/calculations/lines, dunning_notices (WIP)

SYNC infrastruktura: bb_sync_log, bb_sync_state (kursor), goods_documents(+items) ~ (prazne, van sync-a)
[SY15/legacy] druga baza: kadrovska (employees, salary_*…), CMMS (maint_*), lokacije (loc_*), sastanci, reversi… — 147 modela, 0 relacija u sy15.prisma
```

Najveće tabele na produ (25.07.2026): `drawing_pdfs` 2.102 MB (96 redova) · `work_order_operations` 92 MB (216.000) · `items` 81 MB (92.511) · `tech_processes` 34 MB (99.063) · `work_orders` 29 MB (40.860) · `audit_log` 5,6 MB (15.397) · `projects` (7.617) · `customers` (6.251). GL/SEF tabele su prazne (4.0 pilot).

---

## 3. Nalazi

Format: **ID | ozbiljnost | naslov** → lokacija, problem + scenario štete, predlog (samo opis), rizik ispravke. Sve lokacije su verifikovane čitanjem; stavke sa nepotpunim dokazom nose oznaku **ZA PROVERU**.

### A. Integritet i konzistentnost

**DB-001 | KRITIČNO | `ON DELETE CASCADE` na stavkama glavne knjige — DB dozvoljava brisanje knjiženih naloga**
- Lokacija: `backend/prisma/schema.prisma:3020` (`ledger_entries.journal_entry_id`), migracija `20260719150000_faza2_gl_jezgro`.
- Problem: `DELETE FROM journal_entries` prolazi i za `status='posted'/'locked'` — sve knjižne stavke nestaju kaskadno, a meke reference (`invoices.journal_entry_id`, `cash_entries.journal_entry_id`, `compensation_orders.journal_entry_id`, `vat_ledger_entries.source_journal_entry_id`) ostaju viseće jer FK nemaju. Jedan pogrešan admin-delete ili bag u servisu tiho briše deo glavne knjige; računovodstveni princip je storno, nikad delete.
- Predlog: promeniti na Restrict/NoAction (brisanje samo draft naloga kroz servis koji sam briše stavke) ili DB trigger koji brani DELETE za status≠draft.
- Rizik ispravke: mala izmena constrainta, bez downtime-a; prethodno proveriti servis za brisanje draftova (danas se oslanja na kaskadu).

**DB-002 | VISOKO | CASCADE briše stavke i KNJIŽENIH dokumenata (fakture, robno, izvodi, blagajna)**
- Lokacija: `invoice_items.invoice_id` (schema:3631), `stock_document_items.document_id` (:3193), `stock_leveling_items.document_id` (:3258), `bank_statement_lines.statement_id` (:3427), `cash_entries.cash_journal_id` (:4178).
- Problem: `isLocked`/POSTED su samo aplikativne brave — DB kaskada briše stavke knjiženog računa (SEF već poslat), robnog dokumenta (retroaktivno menja as-of costing jer je izvor istine upit nad kretanjima, schema:3350–3353), i CELU blagajnu sa POSTED uplatnicama pri brisanju `cash_journals` reda.
- Predlog: Cascade zadržati samo za draft-lifecycle; za POSTED/LOCKED NoAction + servisno brisanje ili trigger-guard po statusu.
- Rizik: nizak na constraint sloju; proveriti servise koji danas brišu draftove preko kaskade.

**DB-003 | VISOKO | `vat_returns` unique za period NE RADI (NULL semantika)**
- Lokacija: schema:3861 `@@unique(period_year, period_month, period_quarter)`; migracija `20260719200000:120`.
- Problem: svaki red ima bar jedan NULL (mesečni → quarter NULL i obrnuto), a PG default je NULLS DISTINCT — constraint doslovno nikad ne odbija duplikat. Dva obračuna za isti mesec (dupli klik / trka) legalno koegzistiraju.
- Predlog: `UNIQUE ... NULLS NOT DISTINCT` ili dva parcijalna unique indeksa (ručna migracija — Prisma ne ume).
- Rizik: nizak; prvo proveriti da duplikati već ne postoje.

**DB-004 | VISOKO | `workers.card_id` bez UNIQUE — identitet kartice na kiosku**
- Lokacija: schema:1611; nijedna migracija ne pravi indeks na card_id.
- Problem: dve kartice sa istim kodom → kucanje rada se knjiži pogrešnom radniku (učinak, norma) bez ikakve greške.
- Predlog: parcijalni UNIQUE (`WHERE card_id <> ''`) posle dedup provere na produ.
- Rizik: obavezan dedup-scan pre migracije; kratka brava.

**DB-005 | VISOKO | `projects.project_number` bez UNIQUE — poslovni identitet predmeta**
- Lokacija: schema:688; baseline nema unique.
- Problem: dual unos 3.0→BigBit počiva na „isti broj u obe baze"; paritet-guard postoji u sync servisu, ali DB mreže nema. Duplikat broja raspoluti predmet (pola RN-ova na jednom id-u, pola na drugom).
- Predlog: UNIQUE(project_number), po potrebi parcijalni ako legacy uvoz ima istorijske duplikate.
- Rizik: dedup-scan legacy podataka obavezan pre migracije.

**DB-006 | VISOKO | NULA CHECK constrainta u bazi; prioritet: `ledger_entries` bez `debit/credit >= 0`**
- Lokacija: schema:2993–2994; grep svih migracija = 0 CHECK (jedini pogodak je komentar „Bez CHECK constrainta" u `20260718140000:6`).
- Problem: negativno duguje/potražuje obrće smisao stavke — bruto bilans, saldakonti i POPDV (D/P izrazi) daju pogrešne cifre bez greške. Storno se radi protiv-nalogom (schema:2951), pa negativno nema legitimnu upotrebu.
- Predlog: CHECK (debit ≥ 0 AND credit ≥ 0), opciono i „ne oba > 0"; uvesti kao NOT VALID → VALIDATE.
- Rizik: skan postojećih redova pre dodavanja (tabela danas prazna — idealan trenutak); bez downtime-a.

**DB-007 | VISOKO | `invoices.customer_id` opciono i za KNJIŽEN račun**
- Lokacija: schema:3551 (`Int?`).
- Problem: DB prihvata POSTED račun bez kupca; SEF UBL builder, saldakonti i KIF pretpostavljaju kupca — NULL znači 500 ili tiho ispuštanje iz KIF-a. Draft bez kupca je legitiman, knjižen nije.
- Predlog: ručni CHECK (status='DRAFT' OR customer_id IS NOT NULL) + servisni guard pri knjiženju.
- Rizik: proveriti postojeće redove; bez downtime-a.

**DB-008 | VISOKO | `handover_draft_items.drawing_id` bez FK ka `drawings`**
- Lokacija: schema:528; baseline:1577–1580 (FK postoji samo za main_drawing_id i draft_id).
- Problem: glavna veza stavke nacrta primopredaje na crtež nema FK, iako su obe tabele ServoSync-owned. Reimport/brisanje crteža ostavlja stavke-duhove; submit primopredaje nad orphan stavkom puca ili tiho preskače pozicije.
- Predlog: FK NoAction posle orphan-scana.
- Rizik: nizak (ADD CONSTRAINT NOT VALID → VALIDATE bez downtime-a).

**DB-009 | SREDNJE | Nedostaje CHECK paket: količine, procenti, iznosi, intervali**
- Lokacija: `invoice_items.quantity/discount_percent` (3618–3622), `stock_document_items` (3162–3168, komentar „čuva se pozitivno" — konvencija bez brave), `koop_otpremnica_stavke.vraceno_kolicina` vs `kolicina` (2546–2547), `cash_entries.amount/direction` (4167–4168), `work_time_entries.stopped_at ≥ started_at` (1763–1764), `tax_rates/interest_rates/customer_discounts` valid_from/to (135–136, 4197–4198, 3673–3674), `vat_returns.period_month/quarter` opseg+XOR (3848–3849), `dunning_notices.level` (3041), `nonconformity_reports.type/status` (2088–2094).
- Problem: negativna količina na izlazu robno stanje PODIŽE (as-of costing sabira kretanja); vraćeno > poslato; isplatnica sa negativnim iznosom = skrivena uplata; negativno trajanje sesije kvari učinak; month=13 pravi „prazan" PDV period.
- Predlog: paket ručnih CHECK-ova po tabeli (NOT VALID → VALIDATE).
- Rizik: skan podataka po tabeli; bez downtime-a.

**DB-010 | SREDNJE | „Magic zero" umesto NULL na referentnim kolonama (sistemski obrazac)**
- Lokacija: `work_orders.project_id/drawing_id/drawing_handover_id/parent_work_order_id @default(0)` (1494, 1523–1524, 1531), `tech_processes.work_order_id` (1732), `drawing_handovers.technologist_id` (580), `goods_documents.*` (1064–1113).
- Problem: sentinel 0 sprečava ikakav budući FK (id 0 ne postoji) i svaki JOIN mora da filtrira nulu — jedan zaboravljen filter daje pogrešne agregacije.
- Predlog: dugoročno migracija 0→NULL + parcijalni indeksi; kratkoročno lint-pravilo u servisima.
- Rizik: dira podatke i sve upite — samo planski, po modulu.

**DB-011 | SREDNJE | `invoices` unique bez `company_id` — multi-firma numeracija blokira legitiman broj**
- Lokacija: schema:3596 `@@unique(document_type, document_number)` vs `document_number_sequences` po (documentType, year, companyId) (:3656).
- Problem: firma B ne može da izda IFR „0001/26" ako ga firma A ima — pad na constraint pri legitimnom knjiženju.
- Predlog: proširiti unique na (company_id, document_type, document_number).
- Rizik: bezopasno (širi ključ).

**DB-012 | SREDNJE | `exchange_rates`: kursevi `@default(0)` + TIMESTAMPTZ u unique ključu**
- Lokacija: schema:3444–3448, 3455; migracija `20260724120000:8,20–21`.
- Problem: (a) red bez kursa dobija 0, resolver „poslednji ≤ datum" ga uredno vrati → devizni izvod dobije protivvrednost 0 RSD tiho; (b) jedinstvenost (rate_date, currency) važi po tačnom timestampu, ne po danu — dva EUR kursa istog dana legalno koegzistiraju, izbor zavisi od milisekundi unosa.
- Predlog: CHECK (kursevi > 0) ili ukinuti default 0; kolonu prevesti na `date` (semantika „dan važenja" je već u komentaru). **ZA PROVERU:** da li servis normalizuje na 00:00.
- Rizik: konverzija tipa trivijalna ako su upisi već na ponoć.

**DB-013 | SREDNJE | Nedostajući UNIQUE: `document_types.code`, `workers.username` (+ `salespeople.login_account`)**
- Lokacija: schema:877; 1604; 753.
- Problem: sve meke reference na vrstu dokumenta idu po `code` (price_list, stock_documents, kepu) — dupli code → lookup vraća proizvoljan red i pogrešnu šemu knjiženja. Kiosk/login identitet po username-u bez DB mreže.
- Predlog: UNIQUE posle dedup provere; document_types je BigBit keš — prvo proveriti da sync feed nema duplikate.
- Rizik: sync može pući na duplikat iz BigBit-a — obavezan scan pre.

**DB-014 | SREDNJE | Zbirovi u zaglavlju vs stavke — bez ikakvog mehanizma sinhronizacije**
- Lokacija: `invoices.net/vat/gross_total` (3563–3565), `compensation_orders.total_amount` (3505), `vat_returns.output/input_vat` (3851–3853), `interest_calculations.total_*` (4213–4214).
- Problem: zbir živi i u headeru i u stavkama; update stavke mimo servisa → SEF UBL i GK knjiže header-zbir koji ne odgovara stavkama.
- Predlog: periodični konzistencioni izveštaj (Σ stavki = header) + rerachun u istoj transakciji kao jedini put upisa; opciono trigger.
- Rizik: izveštaj bezrizičan.

**DB-015 | SREDNJE | Storno/reconciled parovi asimetrični**
- Lokacija: `journal_entries.reverses_entry_id` (FK+unique, 2951) vs `reversed_by_entry_id` (goli Int, 2952); isti obrazac `ledger_entries.reconciled_with_id/reconciled_at` (3011–3016).
- Problem: ogledalo se održava samo u servisu — izveštaj „da li je nalog storniran" po reversed_by koloni može da laže.
- Predlog: izbaciti redundantnu kolonu (izvoditi upitom) ili FK+unique i na drugu stranu.
- Rizik: nizak; popisati čitaoce pre.

**DB-016 | SREDNJE | Meke reference između owned tabela: `work_order_components.component_work_order_id`, `drawing_plans.project_id/planning_worker_id`, `mrp_demands.*`**
- Lokacija: schema:1561 (baseline:1664 — FK samo na parent strani), 318/323, 391, 414–430.
- Problem: nekonzistentno — deo grafa je FK-zaštićen, deo nije (susedna kolona istog modela FK ima). Brisanje komponentnog RN-a ostavlja viseći link u stablu sastavnice.
- Predlog: ujednačiti — FK bar ka ne-keš tabelama (workers/drawings/work_orders).
- Rizik: orphan-scan pre dodavanja.

**DB-017 | SREDNJE | Finansijski lanac 4.0: meki ref-ovi između app-owned tabela iste baze**
- Lokacija: `sef_outbox.invoice_id` (3691), `sef_status_log.outbox_id/incoming_id` (3772–3773), `cash_entries.journal_entry_id` (4174), `compensation_order_lines.ledger_entry_id` (3523), `interest_calc_lines.ledger_entry_id` (4230), `stock_documents.journal_entry_id` (3136), `invoices.journal_entry_id` (3581), `bank_statement_lines.matched_ledger_entry_id` (3413), `vat_ledger_entries.source_journal_entry_id` (3902).
- Problem: kućna politika „meki ref + validacija u servisu" primenjena i tamo gde su OBE tabele 4.0-native u istoj bazi — brisanje GK naloga ne dira SEF outbox / kompenzacije / kamatne listove koji na njega pokazuju.
- Predlog: presuda po paru — minimalno FK SetNull/NoAction na `sef_outbox.invoice_id` i `compensation_order_lines.ledger_entry_id`.
- Rizik: nizak.

**DB-018 | SREDNJE (ZA PROVERU) | Dve paralelne BOM tabele: `drawing_components` vs `drawing_assemblies`**
- Lokacija: schema:234–243 vs 364–373.
- Problem: obe modeluju parent/child crtež + količinu; ako planiranje i eksplozija sastavnice čitaju različite, količine se razilaze bez signala.
- Predlog: utvrditi koja je autoritativna u 3.0 i drugu označiti read-only/legacy.
- Rizik: samo izviđanje.

**DB-019 | SREDNJE (ZA PROVERU) | `bank_statements` unique (bank_account, statement_number) bez godine**
- Lokacija: schema:3392.
- Problem: banke tipično resetuju broj izvoda godišnje — izvod br. 15/2027 pada na unique jer 15/2026 postoji; import blokiran. Otpada ako importer upisuje godinu u broj.
- Predlog: proveriti format; po potrebi dodati godinu u ključ.
- Rizik: proširenje ključa bezopasno.

**DB-020 | NISKO | Legacy artefakti: `payment_accounts` self-FK id→id; `notifications.id` PK `@default(0)` bez autoincrementa**
- Lokacija: schema:1176–1177 (baseline:1595); schema:149 (baseline:111).
- Problem: self-FK ne štiti ništa (artefakt introspekcije); drugi insert u notifications bez id-a pada na duplikat PK 0 (tabela verovatno mrtva — mina za budućnost).
- Predlog: drop constrainta; autoincrement ili gašenje tabele. Rizik: nikakav.

**DB-021 | NISKO | FK + `@default(0)` zahteva postojanje reda id=0 (skriveni seed-preduslov)**
- Lokacija: `default_users.default_department_id/org_unit_id` (30–38), `part_locations.project_id/position_id/worker_id` (1357–1366).
- Problem: insert sa default vrednošću pada osim ako ciljna tabela ima red id=0. **ZA PROVERU:** da li id=0 redovi postoje na produ.
- Predlog: ukinuti default 0 ili dokumentovati preduslov. Rizik: nizak.

**DB-022 | NISKO | NULLS DISTINCT rupe u ostalim unique ključevima + `draft_number` bez jedinstvenosti**
- Lokacija: `pracenje_notes` (2356), `predmet_planeri` (2403 — dupli globalni planer = dupla obaveštenja o lansiranju), `plan_proizvodnje_reassign_audit.client_event_uuid` (2705), `handover_drafts.draft_number @default("")` (511).
- Predlog: parcijalni unique indeksi ručnom migracijom. Rizik: minimalan.

**DB-023 | NISKO | 23 relacije (4.0 deo) bez eksplicitnog `onUpdate` → generisan ON UPDATE CASCADE**
- Lokacija: schema:2760–4238 (potvrda u SQL-u: `fk_ledger_entries_account ... ON UPDATE CASCADE`).
- Problem: odstupanje od kućnog obrasca (stariji deo svuda NoAction/NoAction); za `accounts.code` (prirodni ključ) CASCADE je verovatno i poželjan — ali treba da bude svesna odluka.
- Predlog: eksplicitno dopisati onUpdate. Rizik: dokumentaciona ispravka.

**DB-024 | NISKO | `drawing_pdfs` vezan prirodnim ključem bez FK ka `drawings`**
- Lokacija: schema:303–311 vs `drawings @@unique(drawingNumber, revision)` :284.
- Problem: PDF sme da postoji za nepostojeći crtež/reviziju; posle izmene broja crteža prikaz ne nalazi PDF.
- Predlog: složeni FK ili konzistencioni izveštaj. Rizik: orphan-scan pre.

### B. Tipovi podataka i nelogičnosti

**DB-025 | VISOKO | `price_list_entries.price/fee` = Float u ŽIVOM cenovniku, pored Decimal kolona u istoj tabeli**
- Lokacija: schema:111–116 (`price`, `fee` Float? vs `price_without_vat`, `price_with_vat` Decimal(19,4)).
- Problem: ista vrsta podatka u dva tipa u istoj tabeli. PricingService (`backend/src/modules/sales/pricing.service.ts:158–178`) čita Decimal kolonu sa fallback-om na `items.wholesale_price` (Float) — Float kolona `price` je trenutno mrtva, ali je mamac: prva upotreba unosi binarnu grešku u fakturisanje.
- Predlog: konvertovati u Decimal(19,4) ili ukloniti ako je mrtva; lint zabrana Float za price/fee imena.
- Rizik: mala tabela, kratka brava; jednokratno zaokruživanje postojećih vrednosti.

**DB-026 | SREDNJE | 70 Float kolona (29 novčanih + 3 kursa) u legacy sync-keš tabelama — potvrđeno na produ**
- Lokacija: `items.*` (11 novčanih; schema:791–825), `goods_document_items.*` (16; :1121–1160), `goods_documents.*` kursevi/troškovi (:1078–1112), `customers/salespeople/workers.commission_percent`, `tax_rates.*` (129–133).
- Problem: kućno pravilo kaže „novac Decimal, nikad Float" — legacy keš ga krši. Ublaženo: 4.0 pandani su Decimal, konverzija na posting granici postoji (schema:2991–2993), `goods_documents` je prazna i van sync-a. Rizik ostaje: `items.wholesale_price` (Float) je ŽIV fallback cene u pricing-u.
- Predlog: pri gašenju BigBit sync-a konvertovati novčane kolone u Decimal; do tada strogo držati obrazac konverzije-na-granici.
- Rizik: konverzija tek posle cutover-a (sync bi vraćao Float).

**DB-027 | SREDNJE | Nekonzistentna preciznost istih logičkih veličina: količina 18,4 vs 19,6; cena 18,4 vs 19,4; kurs 19,4 vs 19,6 vs Float**
- Lokacija: količine — `drawing_plans/purchase_*` Decimal(18,4) (320, 2821, 2865, 2912–2913) vs `mrp_*/stock_*/invoice_items` Decimal(19,6) (403, 3162–3163, 3618); `purchase_order_items.unit_price` (18,4) vs `invoice_items.unit_price` (19,4); `projects.exchange_rate` (19,4) (715) vs svi ostali kursevi (19,6).
- Problem: 3-way match nabavka→prijem poredi 18,4 sa 19,6 — količina 0,00005 „preživi" u robnom a u narudžbenici se zaokruži; devizna vrednost predmeta iz projects kursa se ne slaže sa fakturom.
- Predlog: standard u BACKEND_RULES (npr. količina 19,6; novac 19,4; kurs 19,6; procenat 9,4) + ALTER proširenja.
- Rizik: proširenje preciznosti je bezbedno.

**DB-028 | SREDNJE | Dve konvencije statusa u ISTOM modulu: `posted` (malo) vs `POSTED` (veliko)**
- Lokacija: `journal_entries.status` = draft|posted|locked (schema:2946–2947) vs `stock_documents/invoices/bank_statements/inventory_counts` = DRAFT|POSTED|… (3134, 3572, 3382, 3275). Mešanje u istoj funkciji: `backend/src/modules/izvodi/bank-statement.service.ts` — :604–605 i :708 pišu `"POSTED"`, :698 piše `"posted"`.
- Problem: filter `status='POSTED'` nad journal_entries vraća 0 redova bez greške — tiho pogrešan izveštaj.
- Predlog: jedna konvencija (velika slova su većinska) + UPDATE podataka + grep sweep svih upita; ili bar CHECK da pogrešan case padne glasno.
- Rizik: dira podatke i upite — jedan PR, bez downtime-a.

**DB-029 | SREDNJE | Statusi kao goli Int/SmallInt bez kataloga svih vrednosti**
- Lokacija: `mrp_demands.status/source/explosion_type` (394–396), `drawing_plans.planning_status` (321), `handover_draft_items.decision_action` (540), `nonconformity_reports.type/status` (2088–2094), `invoices.level` 250/0 (3549 — BigBit magični broj prenet u novu app-owned tabelu), `customers/companies.vat_status` (189, 978).
- Problem: za razliku od String statusa (koji imaju `///` katalog), značenje ovih živi samo u servisima.
- Predlog: minimalno `///` katalozi; za invoices ukinuti redundancu level/status.
- Rizik: dokumentaciono; level→status = migracija podataka.

**DB-030 | SREDNJE | Podeljen timestamp režim: 117 naive vs 157 timestamptz kolona; poređenja naive-vs-now() u raw SQL-u — DB radi u UTC (potvrđeno)**
- Lokacija: pravilo „nove tabele Timestamptz" (BACKEND_RULES §11.5) vs legacy naive; isti poslovni događaj u dva režima: `tech_processes.entered_at/finished_at` naive (1720, 1729) vs `work_time_entries.started_at` tz (1763). Raw mešanje: `backend/src/modules/locations/loc-tp-feed.service.ts:336` (`tp.entered_at >= now() - …`).
- Problem: naive-vs-timestamptz poređenje PG rešava kroz session TimeZone — tačno samo dok je baza na UTC (jeste: `SHOW timezone` = `Etc/UTC`) I dok naive kolone stvarno nose UTC. Svaki upis lokalnog vremena u naive kolonu pomera poređenja 1–2 h.
- Predlog: (a) fiksirati i dokumentovati DB timezone=UTC u BACKEND_RULES; (b) plan konverzije legacy kolona u timestamptz posle gašenja sync-a; (c) review pravilo: naive kolona + `now()` samo uz eksplicitni AT TIME ZONE.
- Rizik: konverzija = rewrite velikih tabela (tech_processes 99k, work_order_operations 216k) — planski prozor.

**DB-031 | SREDNJE | Datum/godina se računaju po UTC: `CURRENT_DATE` default-i i `getFullYear()` numeracija — potvrđeno (DB=UTC, Node bez TZ)**
- Lokacija: `projects.opened_at` default `(CURRENT_DATE)::timestamp` (schema:690), `work_orders.external_opened_at` (1499), `default_users.default_year`/`goods_documents.year` preko EXTRACT (29, 1103); u kodu: `purchase-numbering.service.ts:33`, `fakturisanje.service.ts:158`, `bank-statement.service.ts:684`, `posting.service.ts:204`, `blagajna.service.ts:136`.
- Problem: predmet otvoren 25.07. u 00:30 po Beogradu dobija datum 24.07; dokument knjižen 1.1. u 00:30 ide u prošlogodišnju sekvencu `NNNN/god`.
- Predlog: godinu/datum izvoditi iz poslovnog datuma kroz fiksnu zonu Europe/Belgrade (kod), default-e prebaciti na izraz sa AT TIME ZONE.
- Rizik: ne dira postojeće podatke.

**DB-032 | SREDNJE | Isti identifikator, različite dužine: `drawing_number` 20 vs 50/60/100; `catalog_number` 20/50/100; `revision` 3 vs 10**
- Lokacija: `drawings.drawing_number` VarChar(20) (254) vs `drawing_pdfs` 100 (303), `work_orders` 100 (1502), `labels` 100 (652), `montage_nonconformities` 60 (2199); `items.catalog_number` 20 (774) vs `drawings` 50 (257) vs MRP kopije 100 (445, 417); `drawings.revision` 3 (255) vs `drawing_pdfs.revision` 10 (304 — deo PK!).
- Problem: master dozvoljava 20, potrošači 100 — lookup/join po broju crteža radi nad nejednakim domenima; PDF može postojati za broj koji u master ne staje.
- Predlog: ujednačiti (100 za drawing_number lanac, 3 za revision) uz proveru podataka.
- Rizik: proširenja bezbedna; skraćivanja traže proveru.

**DB-033 | NISKO | `projects.status` bez kataloga (jedina status kolona bez `///`); `drawings.pdm_status` mešan case + tihi clip na 20**
- Lokacija: schema:696; :265 + `pdm-import.service.ts:465` (`clipRequired(a["State"], 20)` — „Izmena bez revizije" = tačno 20 znakova, na ivici).
- Predlog: popisati BigBit domen; normalizovati case pri importu. Rizik: minimalan.

**DB-034 | NISKO | Proizvoljne VarChar dužine istih podataka**
- Lokacija (izbor): email 30/50/100/255 (`companies.email` VarChar(30)! — realne adrese ne staju; 924), `customers.name` 50 vs kopije 255 (166 vs 2100, 650 — izvor uži od kopija), `items.name` 50 vs MRP kopije 150–200 (778 vs 444, 418), `unit` 5/10/20/50 (779, 419, 446, 1509), username 20 vs 50 (28, 66 vs 1604 — radnik sa dužim username-om ne može u default_users), matični broj 20 vs 50 (218 vs 925), žiro račun 30 vs 50 (171–173 vs 918+), document_number 20 vs 30, IP 45 vs 100.
- Predlog: tabela standardnih dužina u BACKEND_RULES; širiti pri prvom sledećem diranju tabele. Rizik: proširenja bezbedna.

**DB-035 | NISKO | Sitne vremenske/format nelogičnosti**
- Lokacija: valuta default `"DIN"` vs `"RSD"` (1094 vs 2887, 3557), `change_requests.reward_month` VarChar(7) „YYYY-MM" (4002), `planner_entries.scheduled_date + scheduled_time` — jedan trenutak u dva timestamp polja (1023–1024), `handover_draft_items.decision_date_time` TIMESTAMP(0) jedinac (541), `refresh_tokens.expires_at` naive (1944).
- Predlog: normalizovati usput. Rizik: minimalan.

**DB-036 | NISKO | `work_orders.status` je Boolean — ime laže**
- Lokacija: schema:1512 (uz `handover_status_id` u istoj tabeli).
- Predlog: rename u `is_closed` pri prvoj velikoj migraciji work_orders. Rizik: dira sync i upite — samo uz cutover.

### C. Performanse

**DB-037 | VISOKO | 58 FK constrainta bez pokrivajućeg indeksa na produ (Prisma ih NE indeksira automatski) — vrući put proizvodnje**
- Lokacija/prioriteti (šema + potvrđeni upiti + prod veličine): **`part_locations`** — bez ijednog sekundarnog indeksa (schema:1354–1369; 7,3k redova, živ unos; upiti `part-locations.service.ts:100–124,192`, `work-orders.service.ts:487–491` — groupBy na SVAKOJ listi RN-ova); **`work_time_entries.worker_id`** (+ parcijalni `WHERE stopped_at IS NULL` — kiosk `openForWorker` `tech-processes.service.ts:699–702` i auto-close `session-auto-close.service.ts:114–126`); **`drawing_components.parent/child_drawing_id`** (13k redova; BOM BFS `tech-processes.service.ts:604–622`, PDM import `pdm-import.service.ts:321,382` — poznat kompromis od 20.07); **`work_orders.parent_work_order_id`** (40,8k redova; na svakom detalju RN-a `work-orders.service.ts:463–475`); **stavke RN-a** `work_order_machined_parts/blanks/nonstandard_parts/launches/approvals/item_components.work_order_id`; **`tech_processes.worker_id`** (99k; kiosk hot-path :709–713); **`drawing_handovers.status_id + handover_date`** (3,7k; glavna lista tehnologa `handovers.service.ts:265–274`); **`handover_drafts.project_id`**, **`handover_draft_items.draft_id/drawing_id`**; **`ledger_entries (analytical_code, reconciled_at)`** (kamata `kamata.service.ts:114–126` — postojeći open_items indeks ne pokriva upit bez account_code); `work_order_components.component_work_order_id` (BFS praćenja `pracenje.service.ts:585–588`); `machine_access.worker_id` (authz put svakog skena).
- Problem: svaka lista RN-ova, kiosk otvaranje, lista tehnologa i pretraga realizacije rade sekvencijalne skanove; degradacija je linearna sa rastom (part_locations i work_time_entries rastu svakim skeniranjem/premeštanjem).
- Predlog: paket indeksa **CREATE INDEX CONCURRENTLY ručnom migracijom van Prisma transakcije** (žive tabele!); redosled po listi gore.
- Rizik: nizak; kratko usporenje upisa tokom build-a.

**DB-038 | VISOKO | `drawing_pdfs` = 2,1 GB od 2,4 GB baze (5.737 redova; PDF kao `bytea`)**
- Lokacija: schema:302–313 (`pdfBinary Bytes?`); prod: 2.102 MB, ~370 KB po redu (broj redova potvrđen count(*)-om pri restore testu 25.07; raniji „96" je bio zastareo pg_stat brojač).
- Problem: binarni sadržaj u bazi naduvava svaki noćni pg_dump, RAM pri čitanju i buduće migracije/restore; sa rastom PDM-a (11,7k crteža, PDF postoji za 96) tabela ide na desetine GB. `cutover_stash.drawing_pdfs` (9 MB) je zaostatak.
- Predlog: odluka — premestiti PDF-ove u storage (kao sy15 storage fajlovi) ili svesno ostaviti u bazi uz izuzeće iz čestih dump-ova (poseban dump raspored za tu tabelu) i garantovano `select` bez `pdf_binary` u listama (postoji, `work-orders.service.ts:398–408` ✓).
- Rizik: seoba = jednokratna migracija sadržaja + izmena čitalaca; do odluke bar dokumentovati.

**DB-039 | VISOKO | SEF liste vraćaju cele XML/PDF blobove bez projekcije (i incoming bez paginacije)**
- Lokacija: `sef.service.ts:444–459` (GET /sef/outbox — nema `select`, red nosi `ubl_xml` + `pdf_attachment_base64`; i interna upotreba `fakturisanje.service.ts:458` — take 200 celih redova samo radi statusa), `sef-incoming.service.ts:233–239` (lista sa `raw_xml`, bez take).
- Problem: sa punjenjem outbox-a (danas 0 redova — pilot) lista postaje višedeset-MB odgovor → spor endpoint, potencijalni OOM.
- Predlog: select projekcija bez blobova u listama; pun red samo na detalju; paginacija za incoming. **ZA PROVERU:** da FE ne koristi ta polja iz liste.
- Rizik: nizak.

**DB-040 | VISOKO | PDM XML uvoz: trostruko ugnježdene petlje upita u JEDNOJ transakciji**
- Lokacija: `pdm-import.service.ts:363–429` (`for upserted` → findMany → `for edge` → findFirst + update/delete PO IVICI; isto za assemblies).
- Problem: sa neindeksiranim `child_drawing_id` svaki unutrašnji upit je seq scan → uvoz velikog sklopa = O(N×M) skanova pod otvorenom transakcijom (lokovi blokiraju druge PDM operacije).
- Predlog: batch (jedan findMany za sve, mapa u JS, updateMany/deleteMany) + indeksi iz DB-037.
- Rizik: srednji — dedup logika mora ostati ekvivalentna.

**DB-041 | SREDNJE | Kartica konta bez LIMIT-a / obaveznog perioda**
- Lokacija: `gl-read.service.ts:95–118` ($queryRaw bez LIMIT; running balance vuče sve redove u jedan JSON).
- Problem: kartica kupca posle par godina = desetine hiljada redova po zahtevu.
- Predlog: obavezan period ili server-side saldo-preneto + paginacija.
- Rizik: srednji (menja API ugovor) — uraditi dok su tabele prazne.

**DB-042 | SREDNJE | Prisma `distinct` je in-memory: PDM lookups vuku sve redove**
- Lokacija: `pdm.service.ts:880–894` (`drawing.findMany({distinct: ["material"]})` i designedBy — Prisma dedupuje u aplikaciji).
- Problem: svaki poziv lookups-a vuče kolone svih 11,7k crteža (potvrđeno na produ) — raste sa PDM-om.
- Predlog: `groupBy` (ide u SQL) ili raw SELECT DISTINCT + keš.
- Rizik: nizak.

**DB-043 | SREDNJE | Retention strategija ne postoji — jedina tabela sa čišćenjem je `refresh_tokens`**
- Lokacija: scheduler `sy15-cron-jobs.ts:90–172` — 12 poslova, nijedan cleanup; prune samo `auth.service.ts:571–576`. Rastuće bez plana: `audit_log` (globalni interceptor piše red za SVAKI POST/PUT/PATCH/DELETE sa telom do 8KB — `audit.interceptor.ts:34–79`; 15,4k redova za ~2 nedelje), `app_notifications` (brišu se samo pri brisanju radnika), `scheduled_job_runs` (~20k/god; PAŽNJA: uq (jobKey, scheduledFor) je mutex — čistiti samo DONE/FAILED van catch-up prozora), `sef_status_log`, `bb_sync_log`, `drawing_import_log`, `sef_outbox` (XML+PDF blob po svakoj fakturi zauvek).
- Predlog: dogovor o zakonskim rokovima čuvanja pa cron čišćenja/arhiviranja; za sef_outbox razmotriti NULL-ovanje blobova posle DELIVERED+rok.
- Rizik: poslovna odluka o rokovima; tehnički trivijalno.

**DB-044 | SREDNJE | Numeracija po string-prefiksu = pun skan na svakom kreiranju dokumenta**
- Lokacija: `draft-numbering.service.ts:29–39` (startsWith bez indeksa), isti obrazac `work-order-numbering.service.ts:28`, `purchase-numbering.service.ts:40/64`, `request-numbering.service.ts:30`, `stock-document-numbering.service.ts:33`, `montaza-nm-numbering.service.ts:28`.
- Problem: advisory lock je korektan (nema duplikata), ali svaki `next()` skenira tabelu.
- Predlog: indeks po koloni broja (text_pattern_ops) ili brojač tabela (obrazac `document_number_sequences` već postoji).
- Rizik: nizak.

**DB-045 | NISKO | Manja N+1 mesta**
- Lokacija: praćenje cycle-guard BFS (2 upita po čvoru; `pracenje.service.ts:568–592`), nivelacija `itemValuation.findUnique` po liniji (`nivelacija.service.ts:173–174`), kadrovska `workHours.findMany` po zaposlenom [SY15] (`kadrovska-mutations.service.ts:2566–2567`), blagajna balanceOf po dnevniku, SEF storno log upisi u petlji.
- Predlog: batch `in:` + mape gde zaboli. Rizik: nizak.

**DB-046 | NISKO | 9 redundantnih indeksa (prefiks pokriven drugim indeksom/unique-om)**
- Lokacija: `idx_woo_work_order` (schema:1697 — na tabeli od 216k redova, pokriven sa uq :1692 i idx_woo_routing :1696), `idx_user_roles_user` (1917), `idx_pracenje_notes_project` (2357), `idx_predmet_planeri_project` (2404 — od juče, može odmah), `idx_ledger_entries_account_analytical` (3025 — na budućoj najvećoj tabeli), `idx_popdv_account_map_account` (3811), `idx_vat_return_lines` (3880), `idx_financial_statement_lines` (3951), `idx_balance_formula_definitions` (3973); prod potvrda i za `idx_stock_documents_po` = ključ `uq_stock_documents_po`.
- Predlog: drop uz proveru planova. Rizik: nizak.

**DB-047 | NISKO | CREATE INDEX bez CONCURRENTLY na živim tabelama — presedan za ne-ponavljanje**
- Lokacija: `20260716140000_uq_work_order_operation_number` (unique na 216k tabeli bez CONCURRENTLY — držao share-lock upisa; već izvršeno). Ispravno su rađene `20260716120000` i `20260718090000`.
- Predlog: pravilo — svi budući indeksi na živim tabelama (uklj. paket iz DB-037) idu CONCURRENTLY van Prisma transakcije. Rizik: —

**DB-048 | NISKO | `customers_id_seq` = 1.006.063 uz 6.251 redova — sync troši sekvencu**
- Lokacija: prod `pg_sequences`; sync upsert obrazac troši ID na svakom pokušaju.
- Problem: bezopasno decenijama (int4 ~2,1 mlrd), ali signal da sync radi insert-pokušaje umesto čistih update-a.
- Predlog: samo pratiti. Rizik: —

### D. Bezbednost

**DB-049 | VISOKO | Legacy PLAINTEXT lozinke u produkcijskoj 3.0 bazi — sync ih i dalje puni**
- Lokacija: kolone `workers.password` VarChar(20) (schema:1608), `workers.worker_password` NOT NULL (1618), `salespeople.password` (754), `registered_user_apps.bb_password` (1301); sync mapiranja `sync-map.generated.ts:1647–1652` (Prodavci.Password) i `:3581–3585` (BBPassword).
- Problem: dump/backup baze ili SQL pristup otkriva stvarne lozinke radnika/prodavaca iz legacy sistema (ljudi recikliraju lozinke). Ublaženo: API ih nikad ne vraća (safe-select svuda, provereno), nijedan 3.0 auth tok ih ne koristi.
- Predlog: odmah isključiti Password/BBPassword iz sync mape (3.0 ih nigde ne koristi); po gašenju BigBit-a NULL-ovati/dropovati kolone. Uz to očistiti i prod backup tabele hash-eva (DB-056).
- Rizik: nizak — sync je jednosmeran ka 3.0, round-trip ne postoji.

**DB-050 | VISOKO (svesna odluka — arhitektonski dug) | RLS na glavnoj bazi NE POSTOJI: 0 tabela, 0 politika (potvrđeno na produ)**
- Lokacija: `20260709000000_authz_rls_ready/migration.sql` — pravi samo user_roles/overrides tabele i SECURITY DEFINER predikate (`app_current_user_id`, `app_has_role`…); header eksplicitno „NO policies, NO RLS enabling here".
- Problem: sva zaštita (radni nalozi, sati rada, finansije, audit) je isključivo aplikaciona — bilo koji SQL pristup (backup, psql, bag u raw upitu) vidi sve. Kontrast: sy15 ima ~360 politika.
- Predlog: kad se aktivira, politike vezati za postojeće `app_*` funkcije (to i jeste plan); zahteva GUC identitet po request-u i pooler-safe obrazac — ne raditi bez plana.
- Rizik: velika promena; do tada bar DB-051.

**DB-051 | SREDNJE | Aplikacija radi sa efektivno superuser privilegijama**
- Lokacija: `generic.syncer.ts:184–186` (`SET LOCAL session_replication_role='replica'` — gasi trigere/FK; zahteva superuser ili PG15+ GRANT SET); dev compose `POSTGRES_USER: servosync` = superuser klastera; nijedna migracija ne pravi role/GRANT-ove. **ZA PROVERU:** prod DATABASE_URL (runner env) — najverovatnije isti obrazac.
- Problem: SQLi/RCE u aplikaciji = potpuna kontrola baze.
- Predlog: odvojena app rola bez superuser-a + `GRANT SET ON PARAMETER session_replication_role` samo za sync.
- Rizik: sync može pući ako se privilegija ne prenese tačno — testirati na dev 5437.

**DB-052 | SREDNJE | SEF API ključ firme plaintext u `companies.einvoice_api_key` (sync mirror)**
- Lokacija: schema:980; sync `sync-map.generated.ts:2962–2963`. 3.0 SEF klijent koristi env `SEF_API_KEY`, kolona je samo mirror — ali sadrži živ MFIN ključ.
- Predlog: isključiti kolonu iz sync-a ili maskirati. Rizik: nizak (3.0 je ne koristi).

**DB-053 | SREDNJE | sy15 BYPASSRLS: zaštita kadrovske zavisi od discipline `withUserRls` — konvencija bez mehaničke brave**
- Lokacija: `sy15.service.ts:68–76` (rola `servosync2_app` je BYPASSRLS; `withUser` namerno bypass za Reversi/Lokacije, `withUserRls` radi SET LOCAL ROLE authenticated); kadrovska doktrina `sy15.prisma:2133–2137`.
- Problem: jedan budući poziv kroz `db`/`withUser` u kadrovskoj = tihi proboj maski zarada/PII.
- Predlog: lint/test pravilo za kadrovska/ai-chat module; dugoročno rola bez BYPASSRLS + eksplicitni grantovi (pažnja: Reversi/Lokacije se oslanjaju na bypass).
- Rizik: pažljivo, dvoslojni dizajn postoji s razlogom.

**DB-054 | SREDNJE (ZA PROVERU) | `assessment_raters.token` (360° magic-link) izlazi kroz API bez maskiranja**
- Lokacija: `kadrovska.service.ts:1475–1478, 1506–1509` (findMany bez select → token u JSON-u); kontrast: `sastanci.service.ts:86` rsvpToken isključen.
- Problem: primalac odgovora može predati ocenu u ime drugog ocenjivača / de-anonimizovati proces — zavisi šta token otključava u 1.0.
- Predlog: safe-select bez tokena. Rizik: proveriti da FE ne koristi token (koristi invitedAt — realno ne).

**DB-055 | SREDNJE (ZA PROVERU) | `ai_chat_sql`: LLM-generisan SQL se izvršava u sy15 bazi**
- Lokacija: `ai-chat.service.ts:701` (alat `sql_upit` → DB fn `ai_chat_sql($1)`; izvršava se pod `withUserRls`, domet = rola authenticated pod sy15 RLS-om). Telo funkcije nije u repou.
- Problem: prompt-injection kroz sadržaj koji AI čita → upit koji čita/menja sve što authenticated sme, u ime korisnika.
- Predlog: proveriti definiciju fn na sy15 (read-only? statement whitelist? timeout?).
- Rizik: izmena na sy15 strani — pažnja na regresiju AI chata.

**DB-056 | SREDNJE | Ručne tabele u produ van šeme: 2× backup hash-eva lozinki + snapshot stavki + `cutover_stash` šema**
- Lokacija (prod, potvrđeno): `users_pwhash_backup_20260713`, `_pwhash_backup_20260717`, `_backup_hdi_zahtev007_20260724` u public; šema `cutover_stash` (sa starim `drawing_pdfs`, 9 MB).
- Problem: drift prod↔šema; backup tabele sa hash-evima lozinki žive bez ikakvog vlasnika/roka; svaki dump ih raznosi dalje.
- Predlog: proveriti da su sanacije završene pa DROP-ovati (destruktivno — uz eksplicitnu potvrdu i sveži backup); pravilo da ad-hoc snapshot tabele nose rok brisanja.
- Rizik: nizak uz proveru; ne raditi automatski.

**DB-057 | NISKO | `backend/.env.dev` je u gitu suprotno sopstvenom komentaru („Van gita")**
- Lokacija: git ls-files potvrđuje; sadrži dev DB kredencijal (isti i u `docker-compose.yml:9,30`). Dev sandbox, ne prod — ali stvarna lozinka interne baze u istoriji gita.
- Predlog: `git rm --cached` + .gitignore + rotacija dev lozinke. Rizik: minimalan (CI je ne koristi).

**DB-058 | NISKO | bcrypt cost 10 (donja preporučena granica)**
- Lokacija: `auth.service.ts:266,432`, `podesavanja-users.service.ts:169,546`.
- Predlog: razmotriti cost 12. Rizik: ~4× sporiji login — zanemarljivo. (Pozitivno, bez nalaza: refresh tokeni SHA-256 hash + rotacija + reuse-revoke; JWT tajna fail-closed; operativne tajne u env-u; raw SQL bez injection tačaka — 13 `*Unsafe` poziva, svi literal/whitelist/bind.)

### E. Poslovna logika i domen

**DB-059 | VISOKO (blokira uključenje funkcije) | Batch B soft-delete: šema uvedena, kod NE piše i NE filtrira `deleted_at`**
- Lokacija: migracija `20260725120000_batch_b_softdelete_dunning` (untracked!) + schema:3188–3191, 3424–3425; u modulima robno/izvodi/gl/sales/pdv/saldakonti **0 referenci na deletedAt**; `bank-statement.service.ts:430` i dalje fizički briše; `DunningNotice` bez ijedne reference.
- Problem: čim se doda soft-delete pisac bez dopune SVIH čitalaca (posting :296, calculation, costing…), obrisana stavka nastavlja da ulazi u kalkulacije — tiho pogrešni iznosi u GK.
- Predlog: pre commit-a Batch B koda centralni filter (Prisma extension ili obavezni where) + test koji to dokazuje.
- Rizik: aditivno, ali traži sistematičan prolaz kroz čitaoce.

**DB-060 | VISOKO | `stock_levels` niko ne puni, a lager lista je čita BEZ fallback-a**
- Lokacija: `robno.service.ts:116–145` (listLager čita isključivo stockLevel); u celom src nema nijednog upisa (ni sync, ni trigger); šema:3200–3208 kaže „prazna tabela = fallback na as-of upit" — fallback ne postoji; prod: tabela prazna.
- Problem: BigBit-paritetna lager lista trajno vraća prazno iako kretanja postoje.
- Predlog: implementirati as-of fallback (CostingService.stateAsOf) ili puniti snapshot pri knjiženju; do tada ukloniti/označiti endpoint.
- Rizik: srednji (performanse as-of upita nad velikim prometom).

**DB-061 | VISOKO | Obračun kamate uzima i DRAFT naloge i dobavljačka (payable) konta**
- Lokacija: `kamata.service.ts:112–125` — bez filtera `journalEntry.status IN (posted,locked)` i bez filtera na receivable saldakonto konta; svi ostali čitaoci (open-items :117, partner-card :142, payment-preparation :90, credit-limit `fakturisanje.service.ts:517`) filter imaju.
- Problem: nacrt-nalozi i payable stavke ulaze u osnovicu zatezne kamate → pogrešan obračun prema komitentu.
- Predlog: isti JOIN/filter kao open-items. Rizik: čisto sužavanje skupa.

**DB-062 | VISOKO | Storno ZAKLJUČANOG naloga GK prolazi bez otključavanja**
- Lokacija: `gl-write.service.ts:154–166` — komentar traži „posted", kod odbija samo draft i već-storniran; `locked` NIJE blokiran (markUnlocked :117–133 postoji upravo zato).
- Problem: zaključan period se stornira mimo kontrole zaključavanja (BigBit „Zakljucano" paritet). Dupli storno jeste DB-sprečen (`reverses_entry_id` unique).
- Predlog: Conflict za locked + uputstvo da se prvo otključa. Rizik: minimalan.

**DB-063 | VISOKO | GL bez traga „ko": statusne promene naloga bez aktera; `audit_log` pokriva samo praćenje i TP**
- Lokacija: `gl-write.service.ts:62–147` (markPosted/markLocked/markUnlocked/lockOlderThan — samo Logger.warn); `JournalEntry` nema updatedBy, `LedgerEntry` nema nikakav „ko"; audit_log pišu samo pracenje (7×) i tech-processes (3×). Kontrast: nabavka, handovers i SEF uredno vode aktera.
- Problem: ne može se rekonstruisati ko je knjižio/zaključao/otključao — revizorski gap na najosetljivijem mestu.
- Predlog: actor parametar + upis u postojeći audit_log (ili kolone na JournalEntry). Rizik: aditivno.
- Srodno (statistika): 83/172 modela bez createdAt, 116/172 bez updatedAt; stavke finansijskih dokumenata (InvoiceItem, StockDocumentItem, BankStatementLine, KepuBookEntry, VatLedgerEntry) nemaju ni „kad" ni „ko".

**DB-064 | SREDNJE | GL numeracija: leksikografski MAX — blokada knjiženja posle 9999 naloga**
- Lokacija: `posting.service.ts:684–699` + identična kopija `fakturisanje.service.ts:699–714` (`orderBy number desc` je string sort: „10000" < „9999" → next=10000 ponovo → unique violation → 500 za tu firmu/vrstu/godinu).
- Problem: svi OSTALI brojači u repou ovaj obrazac eksplicitno izbegavaju; advisory lock sprečava duplikat, pa je ishod zaglavljenje, ne duplikat.
- Predlog: numerički MAX kao ostali brojači. Rizik: minimalan.

**DB-065 | SREDNJE | Carry-over PROF→IFR bez CAS-a: dva računa iz istog predračuna (različiti ciljni tipovi)**
- Lokacija: `carry-over.service.ts:55–135` (read-then-check u tx; update :129 bez `where linkedInvoiceDocId: null`; `linkedInvoiceDocId` bez unique-a, schema:3600). Za isti ciljni tip trku slučajno hvata uq placeholder broja; za IFR vs IFGP prolaze oba → dupli prihod.
- Predlog: CAS `updateMany({where:{id, linkedInvoiceDocId: null}})` + provera count-a (obrazac postoji u postInvoice). Rizik: minimalan.

**DB-066 | SREDNJE | `stornoInvoice` neatomičan (dokumentovan trade-off) + ne dira vezani robni izlaz**
- Lokacija: `fakturisanje.service.ts:398–470` (CAS→CANCELLED, GL reverse, SEF cancel = tri celine; pad između 1 i 2 ostavlja CANCELLED bez GL storna — kod dokumentuje ručnu sanaciju); `stockDocumentId` ostaje — roba ostaje razdužena bez ikakvog signala korisniku. **ZA PROVERU:** da li je ručno razduženje očekivan tok.
- Predlog: bar upozorenje u odgovoru storna kad postoji stockDocumentId; razmotriti outbox/saga za GL korak. Rizik: srednji (osetljiv tok).

**DB-067 | SREDNJE | `stock_documents`: „proknjižen" se vidi iz `journal_entry_id`, ne iz `status` — a postoje čitaoci po statusu**
- Lokacija: `posting.service.ts:399–402` (postavlja samo journalEntryId, status ostaje CALCULATED) vs NIV put `robno.service.ts:580–609` (postavlja i POSTED); čitalac po statusu npr. `robno.service.ts:669`.
- Problem: filter `status='POSTED'` promašuje sve robne (ne-NIV) proknjižene dokumente.
- Predlog: pri vezivanju naloga postaviti i status (ili zabraniti filtriranje po statusu). Rizik: nizak, proveriti čitaoce.

**DB-068 | SREDNJE | Blagajna: kontrola „ne u minus" van transakcije**
- Lokacija: `blagajna.service.ts:123–131` (balanceOf PRE $transaction; advisory lock tek unutar tx).
- Problem: dve konkurentne isplatnice obe prođu proveru → gotovina u minusu.
- Predlog: provera unutar tx posle locka. Rizik: minimalan.

**DB-069 | SREDNJE | Mrtvi modeli i „piši-a-ne-čitaj" tabele (higijena šeme)**
- Potpuno mrtvi (0 referenci): `MrpItemStockTmp`, `ProjectWorkType`, `ComboValue`, `OperationFix`, `TechProcessBackup`, `TmpFormControl`, `ItemGroup`, `ItemSubgroup`, `ItemOrigin` (rabat koristi string `Item.groupCode` direktno — `pricing.service.ts:97`), `Notification` (v. DB-020), `AppAccessLog`.
- Pripremljene bez koda: `KoopOtpremnica(+Stavka)` (F4), `DunningNotice` (WIP), `StockLevel` (DB-060).
- U ownership listi bez sync mapiranja i bez čitalaca: `DrawingPlanItem`, `DrawingHandoverPdf`, `PlannerEntry`, `PlannerUserGroup` — **ZA PROVERU** (možda jednokratno uvezena istorija).
- Sync PIŠE a 3.0 nikad ne ČITA (~15 mirror modela): DefaultUser, OrganizationalUnit, AccessRight, GlobalConfig, SystemConfig, MrpSyncStatus, WorkParameter, GoodsDocument(+Item)Mirror, CodeType, RegisteredApp*/User*, AppRevision.
- [SY15] `loc_sync` outbox — mrtav (samo health čitanje, niko ne drenira).
- Predlog: lista za odluku drop/zadržati uz komentar; pre dropa proveriti FE i skripte. Rizik: izviđanje pa odluka.

**DB-070 | NISKO | SEF send bez lokalnog CAS-a (ublaženo requestId idempotencijom na SEF strani)**
- Lokacija: `sef.service.ts:219–283` (odbija samo CANCELLED; SENT može ponovo; paralelna slanja PENDING oba zovu API pre upisa) + `sef-client.service.ts:112–114` (requestId unique = SEF dedup).
- Predlog: lokalni CAS PENDING→SENDING pre poziva. Rizik: nizak.

**DB-071 | NISKO | Izvod: invarijanta početno + Σ stavke = krajnje se nigde ne proverava**
- Lokacija: `bank-statement.service.ts:315–435` (add/update/deleteLine slobodno menjaju posle importa; postStatement knjiži Σ bez sravnjenja sa closingBalance).
- Predlog: sravnjenje pre knjiženja → 422 (pažnja na devizne E6). Rizik: nizak.

**DB-072 | NISKO | Mrtve kolone i nedostižni statusi; sitne tranzicione rupe**
- Lokacija: `journal_entries.signature/signed_at` — 0 upisa (2959–2960); `invoices` katalog `SENT|PAID` se nigde ne postavlja (3571–3572; **ZA PROVERU** da li je PAID planiran za saldakonti-uparivanje); nabavka `markOrderLocked` dozvoljava ORDERED→LOCKED preskačući SIGNED (potvrditi nameru); `positions.service.ts:66` max+1 u tx bez locka (šifarnik, nizak rizik); brisanje RN-a (`deleteWorkOrderCascade`, work-orders.service.ts:946–986) je u tx sa guard-ovima ali bez audit zapisa.
- Predlog: implementirati ili skinuti iz kataloga; audit zapis na forceRemove. Rizik: minimalan.
- (Pozitivno, bez nalaza: sva knjiženja u `$transaction`; svi brojači sem DB-064 pod advisory lock-om; CAS obrazac dosledan u zahtevi/handovers/fakturisanje/izvodi/popis/montaža-NM.)

### F. Migracije, drift i održavanje

**DB-073 | VISOKO | Seed SQL fajlovi nisu povezani ni u jedan runner — POPDV šifarnici PRAZNI NA PRODUKCIJI (potvrđeno)**
- Lokacija: `backend/prisma/seed/` (5 fajlova); nema `prisma.seed` u package.json, nema koraka u deploy/ci workflow-ima, setup.cjs ih ne zove. Prod stanje: **`popdv_definitions` = 0 redova, `popdv_account_map` = 0** (vat_account_map=20, balance_formula_definitions=57, accounts=1398 — ti su stigli kroz migracije/ručno).
- Problem: POPDV obračun i deo KIF/KUF logike tiho vraćaju prazno — i na produ danas, i na svakom svežem deploy-u. Dva ranija ista defekta već sanirana konverzijom u migracije (`20260723150000`, `20260723160000` — komentar u samoj migraciji to kaže).
- Predlog: konvertovati preostala 3 seed fajla u aditivne idempotentne migracije (ON CONFLICT DO NOTHING; GAP audit to već predlaže za vat-account-map). Postojeći fajlovi su TRUNCATE+INSERT — ne puštati ih ručno na prod bez razumevanja da GAZE izmene.
- Rizik: nizak uz guard po prirodnom ključu.

**DB-074 | VISOKO → SANIRANO 25.07 (odlukom) | Backup: restore testiran ✅, skripta verzionisana ✅, off-site pokriven noćnim klonom mašine ✅**
- Sanacija 25.07: probni restore `servosync2_2026-07-25.dump` u privremeni kontejner = USPEŠAN (1m38s, 175 tabela, brojevi redova poklapaju sa živom bazom; jedina odstupanja = 2 FK-a preskočena zbog DB-080 orphana — sanirano isto veče). Skripta `backup-nightly.sh` verzionisana u `backend/scripts/` (obrazac monitor-sy15.sh).
- **Off-site — odluka (Nenad, 25.07):** postoji noćni klon CELE Ubuntu mašine na drugu lokaciju, i on je jedini off-site sloj — klon nosi i konzistentne pg_dump fajlove iz `~/backups/` (upravo ono što se pri restore-u stvarno koristi). Poseban cloud off-site (R2/Supabase) je svesno ODLOŽEN.
- **ZA PROVERU (jedino preostalo):** da klon kreće POSLE ~02:40 (backup se završava ~02:34) — u suprotnom klon nosi dan starije dump-ove (RPO u najgorem slučaju 48h umesto 24h); i povremeno probati restore IZ KLONA, ne samo sa primarnog diska. Napomena: sirovi `pgdata` direktorijum unutar klona žive mašine nije pouzdan za vraćanje — meritorni su dump fajlovi.
- Lokacija: server cron 02:30 `~/ops/backup-nightly.sh` (pg_dump -Fc za sy15 + servosync-pg + tar sy15 storage; pg_restore --list integritetska provera; retencija 7d/28d; marker `.last_ok` — svež 25.07 02:34; monitoring `monitor-sy15.sh:59–64`). U samoj skripti: „Off-site kopija = TODO (odluka)". `archive_mode=off` (nema PITR). Playbook stavka „pgBackRest + noćni dump off-site + testiran restore" — nečekirana. Skripta nije verzionisana u repou (monitor-sy15.sh jeste — presedan postoji).
- Problem: požar/krađa/otkaz diska ubuntusrv-a = gubitak i baze i svih kopija; restore nikad proban = backup Šredingerov.
- Predlog: off-site kopija (rsync/rclone na drugu mašinu ili cloud) + probni restore u prazan kontejner (može odmah, read-only za izvor) + verzionisati skriptu u `backend/scripts/`.
- Rizik: aditivno, bez uticaja na prod.

**DB-075 | VISOKO | Untracked migracija + izmenjen `schema.prisma` u radnom stablu (Batch B WIP)**
- Lokacija: `20260725120000_batch_b_softdelete_dunning/` (git `??`) + necommitovan diff šeme (DunningNotice, deleted_at kolone).
- Problem: untracked FOLDER se lako ispusti iz commita → CI zelen (unit testovi su Prisma-mock, migracije se ne izvršavaju) → deploy prošao → runtime 500 čim modul takne tabelu koje na produ nema.
- Predlog: pri commitovanju Batch B eksplicitno git add foldera; rutina `git status --porcelain backend/prisma` pre push-a. Vezano: DB-059 (kod mora stići pre/sa migracijom), DB-077 (CI mreža).
- Rizik: git higijena.

**DB-076 | SREDNJE | Dupliran timestamp `20260723140000` — redosled na produ OBRNUT od replay redosleda (potvrđeno u `_prisma_migrations`)**
- Lokacija: folderi `..._review_fixes_guards` i `..._montaza_neusaglasenosti`; prod je primenio review 15:09 pa montažu 18:28, svež replay ide leksikografski (montaza pre review).
- Problem: ove dve su nezavisne (verifikovano) pa je šteta potencijalna, ne aktuelna — ali obrazac „recikliran timestamp" je mina: zavisne migracije bi na svežoj bazi dale drugačiji rezultat nego prod.
- Predlog: konvencija — timestamp se ne reciklira; postojeće foldere NE preimenovati (preimenovanje primenjene migracije = pending/failed state na produ).
- Rizik: nikakav (samo pravilo).

**DB-077 | SREDNJE | Nema CI provere replay-a od nule — P3009 incident od 22.07 je to već dokazao**
- Lokacija: `ci-backend.yml` radi samo `prisma generate` (:70–73), unit testovi mock; `deploy-backend.yml:149` = migrate deploy pravo na prod. Prod `_prisma_migrations` nosi 1 rolled-back zapis (`zahtevi_ai_pm_f1`, 22.07 — pao na prod, saniran resolve + ispravka fajla).
- Predlog: CI job sa `services: postgres` + `migrate deploy` na praznoj bazi (~30 s); opciono `prisma migrate diff` kao drift kapija.
- Rizik: samo CI.

**DB-078 | NISKO | Migracioni fajlovi menjani posle inicijalnog commita — 2 slučaja (oba sanirana/pre-prod)**
- Lokacija: `20260721220000_zahtevi_ai_pm_f1` (izmenjen 22.07 posle pada na produ; trenutni fajl = ono što je prod stvarno izvršio → bez drifta), `20260104120000_baseline` (prepisan 23.05, pre-prod era; prod baseline-ovan kasnijim resolve --applied).
- Predlog: formalizovati u BACKEND_RULES: primenjena migracija se ne menja (postupak = resolve --rolled-back + nova migracija). Rizik: —

**DB-079 | NISKO — ✅ REŠENO 25.07 | Migracija `20260725100000_predmet_planeri_016` je u međuvremenu primenjena na prod**
- Provereno 25.07 ~12h: `_prisma_migrations` sadrži `20260725100000_predmet_planeri_016` (finished_at 10:17 UTC) — deploy je legao između prvog snimka audita i provere. Bez daljih koraka.

**DB-080 | VISOKO → SANIRANO 25.07 | Živa baza je sadržala redove koji KRŠE sopstvene FK constrainte (upisani pod `session_replication_role='replica'`)**
- **Sanacija 25.07 (uz odobrenje):** 89 orphan redova `mrp_demand_items` OBRISANO + `handover_drafts` id 3459 (`G-0001/20`, legacy uvoz iz 2020) `main_drawing_id` → NULL; snimci pre brisanja u `ubuntusrv:~/backups/sanacije/*_2026-07-25.csv`; oba orphan brojača posle = 0. OSTAJE sistemski deo: orphan-scan posle sync prolaza (Faza 2) + DB-051.

**DB-081 | VISOKO | `items.catalog_number` bez UNIQUE — podaci sadrže 1.980 duplikat-grupa (4.298 artikala) — zahtev korisnika 25.07**
- Zahtev (Nenad, 25.07): kataloški broj artikla mora biti jedinstven — bez dupliranja artikala. BigBit od skoro BRANI unos novih duplikata, ali istorijski su ostali u podacima (i sync ih preslikava u 3.0).
- Izmereno na produ 25.07: svih 92.511 artikala IMA kataloški broj (0 praznih); **1.980 brojeva se ponavlja → 4.298 artikala u duplikat-grupama**; od toga **571 grupa sa istim nazivom** (pravi dupli artikal — kandidat za merge) i **1.409 grupa sa različitim nazivima** (kolizija/reciklaža broja — traži ručnu presudu); dodatnih 60 grupa se poklapa tek case-insensitive. Najgori: „00001"×24, „DRW-A3"×14, „1"×10, „2"×7… (placeholder vrednosti iz starog unosa).
- Problem: `items` je BigBit sync-keš (piše ga samo sync) — UNIQUE u 3.0 NE SME dok izvor (BigBit) sadrži duplikate: sync bi padao/preskakao redove i keš bi se tiho razišao od izvora. Čišćenje mora PRVO u BigBit-u (merge artikala + prevez dokumenata na preživeli artikal), pa sync, pa tek onda constraint.
- Predlog (redosled): (1) poslovno čišćenje u BigBit-u po izvezenoj listi `ubuntusrv:~/backups/sanacije/items_katbroj_duplikati_2026-07-25.csv` (4.298 redova; kolone: broj, id, external_id, naziv, JM, dobavljač, datum) — prvo 571 „laku" grupu, pa 1.409 kolizija; (2) po čišćenju parcijalni UNIQUE indeks (`WHERE btrim(catalog_number) <> ''`; odluka: i case-insensitive preko `lower()`?); (3) do tada nedeljni watchdog upit u monitoringu — broj duplikat-grupa NE SME da raste (dokaz da BigBit brana drži).
- Rizik ispravke: glavni posao je poslovno čišćenje šifarnika, ne tehnički; constraint posle toga je trivijalan (CONCURRENTLY).
- Lokacija (prod, potvrđeno restore testom 25.07): `mrp_demand_items` — **89 orphan redova** (`demand_id` pokazuje na `mrp_demands` koja je **prazna**, 0 redova; sync je demands prepisao a items ostavio); `handover_drafts.main_drawing_id = 15840` — 1 red pokazuje na nepostojeći crtež.
- Problem: sync piše kroz `SET LOCAL session_replication_role='replica'` (`generic.syncer.ts:184` — gasi FK provere; veza sa DB-051), pa FK constraint na živoj bazi NE garantuje integritet za sync-ovane tabele. Direktna posledica: `pg_restore` na svežu bazu ne može da re-kreira `fk_mrp_demand_items_demand` i `fk_handover_drafts_main_drawing` → restaurirana baza je BEZ ta 2 constrainta (drift pri restore-u), a svaki čitalac mrp_demand_items dobija stavke bez zaglavlja.
- Predlog: (1) sanacija podataka — obrisati 89 orphan stavki (mirror tabela, izvor je BigBit — sync ih ionako može ponovo doneti ispravno) i razrešiti handover_drafts red (NULL-ovati main_drawing_id ili reimport crteža); (2) u sync-u posle replica-sesije dodati orphan-scan korak za parove header/items; (3) dugoročno DB-051 (ne-superuser rola).
- Rizik ispravke: brisanje podataka — SAMO uz eksplicitnu potvrdu i uz svež backup; sanacija handover_drafts reda zahteva proveru šta FE prikazuje za taj nacrt.

---

## 4. Zbirna tabela nalaza (za praćenje)

Sortirano po ozbiljnosti. Status se ažurira ručno pri sređivanju.

| ID | Ozbiljnost | Oblast | Naslov | Status |
|---|---|---|---|---|
| DB-001 | KRITIČNO | Integritet | CASCADE brisanje stavki GK; DB dozvoljava brisanje knjiženih naloga | ✅ Faza 2 (20260725200000): trigger brana posted/locked; kaskada za draft ostaje |
| DB-002 | VISOKO | Integritet | CASCADE briše stavke knjiženih dokumenata (fakture/robno/izvodi/blagajna) | ✅ Faza 2: trigger brane na invoices/stock_documents/bank_statements/cash_entries |
| DB-003 | VISOKO | Integritet | `vat_returns` unique neefektivan (NULL semantika) | ✅ Faza 2: NULLS NOT DISTINCT + CHECK perioda |
| DB-004 | VISOKO | Integritet | `workers.card_id` bez UNIQUE (kiosk identitet) | ✅ Faza 2: parcijalni unique (0 duplikata pre) |
| DB-005 | VISOKO | Integritet | `projects.project_number` bez UNIQUE (dual unos) | ✅ Faza 2: parcijalni unique (0 duplikata pre) |
| DB-006 | VISOKO | Integritet | 0 CHECK u bazi; `ledger_entries` bez debit/credit ≥ 0 | ✅ Faza 2: chk_ledger_entries_nonnegative |
| DB-007 | VISOKO | Integritet | `invoices.customer_id` NULL i za knjižen račun | ✅ Faza 2: chk_invoices_posted_customer |
| DB-008 | VISOKO | Integritet | `handover_draft_items.drawing_id` bez FK | ✅ Faza 2: FK dodat (1 orphan saniran uz snimak) |
| DB-025 | VISOKO | Tipovi | Float cena u živom cenovniku (`price_list_entries.price/fee`) | ✅ Faza 3: konvertovano u Decimal(19,4) |
| DB-037 | VISOKO | Performanse | 58 FK bez indeksa — vrući put proizvodnje (top lista) | ✅ indeksi ŽIVI na produ 25.07; migracija u main-u (#17) |
| DB-038 | VISOKO | Performanse | `drawing_pdfs` = 87% baze (bytea PDF-ovi, 5.737 redova) | otvoreno |
| DB-039 | VISOKO | Performanse | SEF liste vraćaju XML/PDF blobove bez projekcije/paginacije | ✅ u main-u (#17) |
| DB-040 | VISOKO | Performanse | PDM import: N+1 petlje u jednoj transakciji | otvoreno |
| DB-049 | VISOKO | Bezbednost | Plaintext legacy lozinke u prod bazi — sync ih puni | ✅ Faza 3: 2 mapiranja izbačena iz sync mape + sve 4 kolone ispražnjene na produ |
| DB-050 | VISOKO | Bezbednost | RLS ne postoji na glavnoj bazi (0 politika; svesna odluka) | otvoreno (Faza 4, uz Negovana/Nesu) |
| DB-059 | VISOKO | Logika | Batch B soft-delete: šema da, kod ne (WIP gate) | ✅ zatvoreno: robno čitaoci kroz #16; izvodi pisac+čitaoci Faza 3 |
| DB-060 | VISOKO | Logika | `stock_levels` prazna a lager lista je čita bez fallback-a | ✅ Faza 3: as-of fallback nad kretanjima (ista pravila kao costing) |
| DB-061 | VISOKO | Logika | Kamata: draft nalozi + payable konta u osnovici | ✅ u main-u (#17) |
| DB-062 | VISOKO | Logika | Storno zaključanog naloga GK prolazi | ✅ u main-u (#17) |
| DB-063 | VISOKO | Logika | GL bez traga „ko" (posted/locked/unlocked bez aktera) | ✅ Faza 3: status_changed_by_user_id/at kolone + akter kroz sve statusne rute (uz postojeći globalni AuditInterceptor) |
| DB-073 | VISOKO | Održavanje | POPDV seed nepovezan — šifarnici prazni NA PRODU | ✅ u main-u (#17), migracija validirana na dev |
| DB-074 | VISOKO | Održavanje | Backup: restore ✅, skripta ✅, off-site = noćni klon mašine (odluka 25.07) | ✅ sanirano (ZA PROVERU: sat klona posle 02:40) |
| DB-075 | VISOKO | Održavanje | Untracked Batch B migracija + izmenjena šema u radnom stablu | ✅ rešeno 25.07 — Batch B komitovan i merge-ovan kao #16 (71992fa), deploy 🟢 |
| DB-080 | VISOKO | Integritet | Orphan redovi krše FK (replica sync): 89× mrp_demand_items + 1× handover_drafts | ✅ sanirano 25.07 (snimci u ~/backups/sanacije) |
| DB-081 | VISOKO | Integritet | `items.catalog_number` bez UNIQUE + 1.980 duplikat-grupa u podacima (zahtev 25.07) | ⏳ watchdog ŽIV u monitoringu (baseline 2.028 CI-grupa, ratchet); UNIQUE (case-insensitive, odluka 25.07) čim BigBit lista padne na 0 |
| DB-009 | SREDNJE | Integritet | CHECK paket: količine/procenti/iznosi/intervali | ✅ Faza 2: 11 CHECK constrainta (tax_rates preskočen — BigBit keš) |
| DB-010 | SREDNJE | Integritet | „Magic zero" umesto NULL (sistemski obrazac) | otvoreno |
| DB-011 | SREDNJE | Integritet | `invoices` unique bez company_id (multi-firma) | ✅ Faza 2: uq_invoices_company_type_number |
| DB-012 | SREDNJE | Integritet | `exchange_rates`: default 0 + timestamptz u unique ključu | delimično: CHECK ≥ 0 dodat; default 0 je namerni sentinel (resolver guard E6 već postoji); ostaje date-tip kolone |
| DB-013 | SREDNJE | Integritet | UNIQUE fali: `document_types.code`, `workers.username` | delimično: code ✅ Faza 2; username ODLOŽEN (duplikati — kadrovska presuda) |
| DB-014 | SREDNJE | Integritet | Header zbirovi vs stavke bez mehanizma | otvoreno |
| DB-015 | SREDNJE | Integritet | Storno/reconciled parovi asimetrični | otvoreno |
| DB-016 | SREDNJE | Integritet | Meke reference između owned tabela (WO komponente, planovi, MRP) | otvoreno |
| DB-017 | SREDNJE | Integritet | 4.0 finansijski meki ref-ovi (sef_outbox.invoice_id…) | otvoreno |
| DB-018 | SREDNJE | Integritet | Dve BOM tabele (components vs assemblies) — ZA PROVERU | otvoreno |
| DB-019 | SREDNJE | Integritet | `bank_statements` unique bez godine — ZA PROVERU | otvoreno |
| DB-026 | SREDNJE | Tipovi | 70 Float kolona u legacy keš tabelama (29 novčanih) | otvoreno |
| DB-027 | SREDNJE | Tipovi | Nekonzistentna Decimal preciznost (količina/cena/kurs) | delimično ✅ Faza 3: nabavni lanac 19,6/19,4 + projects.exchange_rate 19,6; ostaju drawing_plans/MRP/mirror (legacy) |
| DB-028 | SREDNJE | Tipovi | Status case: `posted` vs `POSTED` u istom modulu | ✅ Faza 3: GL statusi na VELIKA slova (sweep 16 fajlova + FE mapa + case-robustan trigger; tabela bila prazna) |
| DB-029 | SREDNJE | Tipovi | Int/SmallInt magični statusi bez kataloga | otvoreno |
| DB-030 | SREDNJE | Tipovi | Podeljen timestamp režim + naive-vs-now() poređenja | otvoreno |
| DB-031 | SREDNJE | Tipovi | Datum/godina po UTC (CURRENT_DATE default-i, getFullYear numeracija) | ✅ Faza 3: businessYear (Europe/Belgrade) na 15 numeracionih mesta; CURRENT_DATE default-i legacy keša ostaju (sync ih pregazi) |
| DB-032 | SREDNJE | Tipovi | Isti identifikator različitih dužina (drawing_number 20 vs 100…) | otvoreno |
| DB-041 | SREDNJE | Performanse | Kartica konta bez LIMIT-a/perioda | otvoreno |
| DB-042 | SREDNJE | Performanse | Prisma distinct in-memory (PDM lookups) | otvoreno |
| DB-043 | SREDNJE | Performanse | Retention ne postoji (audit_log, notifikacije, SEF blobovi…) | ✅ Faza 3: noćni job 03:30 (audit_log 24 mes., pročitane notif. 90 d, job-runovi 60 d — odluke 25.07); SEF/sync logovi namerno izuzeti |
| DB-044 | SREDNJE | Performanse | Numeracija string-prefiks = pun skan po dokumentu | otvoreno |
| DB-051 | SREDNJE | Bezbednost | App radi sa superuser privilegijama | otvoreno |
| DB-052 | SREDNJE | Bezbednost | SEF API ključ plaintext u `companies` (mirror) | otvoreno |
| DB-053 | SREDNJE | Bezbednost | sy15 BYPASSRLS — disciplina bez mehaničke brave | otvoreno |
| DB-054 | SREDNJE | Bezbednost | `assessment_raters.token` izlazi kroz API — ZA PROVERU | otvoreno |
| DB-055 | SREDNJE | Bezbednost | `ai_chat_sql` LLM SQL na sy15 — ZA PROVERU | otvoreno |
| DB-056 | SREDNJE | Bezbednost | Prod tabele van šeme (2× pwhash backup, hdi snapshot, cutover_stash) | ✅ obrisano 25.07 uz dump u ~/backups/sanacije (odluka Nenada) |
| DB-064 | SREDNJE | Logika | GL numeracija: string MAX → blokada posle 9999 | ✅ u main-u (#17) |
| DB-065 | SREDNJE | Logika | Carry-over bez CAS → dupli račun (IFR vs IFGP) | ✅ u main-u (#17) |
| DB-066 | SREDNJE | Logika | stornoInvoice neatomičan + ne dira robni izlaz | otvoreno |
| DB-067 | SREDNJE | Logika | stock_documents: status ≠ journalEntryId semantika | ✅ Faza 3: vezivanje naloga postavlja i status POSTED |
| DB-068 | SREDNJE | Logika | Blagajna: saldo provera van transakcije | ✅ u main-u (#17) |
| DB-069 | SREDNJE | Logika | Mrtvi modeli + „piši-a-ne-čitaj" mirror tabele | otvoreno |
| DB-076 | SREDNJE | Održavanje | Dupli timestamp 20260723140000; prod red ≠ replay red | otvoreno — ⚠️ 25.07 NOVI slučaj: 20260725160000 ×2 (perf_indeksi + work_order_launch_notifications; nezavisne, benigno) — konvenciju formalizovati |
| DB-077 | SREDNJE | Održavanje | Nema CI replay-od-nule (P3009 presedan) | otvoreno |
| DB-020 | NISKO | Integritet | payment_accounts self-FK; notifications PK default 0 | otvoreno |
| DB-021 | NISKO | Integritet | FK + default(0) traži red id=0 — ZA PROVERU | otvoreno |
| DB-022 | NISKO | Integritet | NULLS DISTINCT rupe u ostalim unique; draft_number | delimično: pracenje_notes + predmet_planeri ✅ Faza 2; reassign_audit i draft_number ostaju |
| DB-023 | NISKO | Integritet | 23 relacije bez eksplicitnog onUpdate (implicitni CASCADE) | otvoreno |
| DB-024 | NISKO | Integritet | drawing_pdfs bez FK para ka drawings | otvoreno |
| DB-033 | NISKO | Tipovi | projects.status bez kataloga; pdm_status case+clip | otvoreno |
| DB-034 | NISKO | Tipovi | Proizvoljne VarChar dužine (email 30, name 50 vs 255…) | otvoreno |
| DB-035 | NISKO | Tipovi | DIN vs RSD; reward_month string; planner dva timestamp polja… | otvoreno |
| DB-036 | NISKO | Tipovi | work_orders.status je Boolean | otvoreno |
| DB-045 | NISKO | Performanse | Manja N+1 mesta (cycle-guard, nivelacija, kadrovska…) | otvoreno |
| DB-046 | NISKO | Performanse | 10 redundantnih indeksa | ✅ obrisani na produ 25.07; migracija u main-u (#17) |
| DB-047 | NISKO | Performanse | CONCURRENTLY pravilo za buduće indekse | ✅ ispoštovano u perf paketu 25.07 |
| DB-048 | NISKO | Performanse | customers_id_seq 1M uz 6k redova (sync troši sekvencu) | otvoreno |
| DB-057 | NISKO | Bezbednost | .env.dev u gitu (dev kredencijal) | otvoreno |
| DB-058 | NISKO | Bezbednost | bcrypt cost 10 → razmotriti 12 | otvoreno |
| DB-070 | NISKO | Logika | SEF send bez lokalnog CAS (ublaženo requestId) | otvoreno |
| DB-071 | NISKO | Logika | Izvod: invarijanta opening+Σ=closing bez provere | otvoreno |
| DB-072 | NISKO | Logika | Mrtve kolone; nedostižni Invoice statusi; sitne rupe | otvoreno |
| DB-078 | NISKO | Održavanje | Menjani migration.sql (2 slučaja, sanirano) — pravilo | otvoreno |
| DB-079 | NISKO | Održavanje | Migracija 016 komitovana a neprimenjena | ✅ rešeno 25.07 (deploy legao 10:17 UTC) |

**Zbir: 81 nalaz — 1 KRITIČNO · 24 VISOKO · 36 SREDNJE · 20 NISKO.**
*Ažurirano 25.07 uveče (posle talasa 0): **✅ zatvoreno 13** — DB-037, 039, 046, 047, 061, 062, 064, 065, 068, 073 (merge #17, ff128a3), DB-074 (restore test + klon-odluka), DB-079, DB-080 (sanacija podataka uz snimke).*

*Ažurirano 25.07 noć (posle **Faze 2**, migracija `20260725200000_faza2_constraint_mreza`): **✅ još 10 u celosti** — DB-001 (KRITIČNO!), 002, 003, 004, 005, 006, 007, 008, 009, 011 + **3 delimično** (DB-012 CHECK≥0, DB-013 code, DB-022 dva parcijalna) + DB-081 watchdog živ + DB-075 rešen kroz #16.*

*Ažurirano posle **Faze 3** (migracija `20260725220000_faza3_paket`): **✅ još 11** — DB-025 (Float cenovnik → Decimal), DB-028 (GL statusi VELIKA slova — sweep 16 fajlova + FE + case-robustan trigger), DB-031 (businessYear Europe/Belgrade na 15 numeracionih mesta), DB-043 (retention job: audit 24 mes/notif 90 d/runs 60 d), DB-049 (lozinke van sync mape + kolone ispražnjene), DB-056 (leftover tabele obrisane uz dump), DB-059 (izvodi soft-delete kompletiran), DB-060 (lager as-of fallback), DB-063 (GL akter statusa), DB-067 (stock status uz nalog) + DB-027 delimično (nabavni lanac + kurs predmeta). **Ukupno zatvoreno: 35 od 81.** Najveći preostali: DB-038 (drawing_pdfs 87% baze), DB-040 (PDM N+1), DB-081 (čišćenje BigBit šifarnika — watchdog čuva), DB-050/051 + DB-030 (RLS, rola, TZ konsolidacija — Faza 4 uz Negovana/Nesu), DB-014/015/029/069 (konzistencija/higijena).*

---

## 5. Predlog redosleda sređivanja

**Faza 0 — odmah, bez rizika po podatke (kod/konfiguracija/operativa):**
DB-075 (commit Batch B kako treba) · DB-079 (proveriti deploy 016) · DB-073 (POPDV seed → migracije) · DB-074 (off-site backup + probni restore) · DB-049 (isključiti lozinke iz sync mape) · DB-061, DB-062, DB-064, DB-065, DB-068 (čisti fix-evi u servisima GL/kamata/blagajna) · DB-039 (select projekcije SEF listi) · DB-077 (CI replay job) · DB-057 (env higijena).

**Faza 1 — indeksi (CONCURRENTLY, bez downtime-a):**
DB-037 paket po prioritetnoj listi (part_locations → work_time_entries parcijalni → drawing_components → work_orders.parent → stavke RN → tech_processes.worker → drawing_handovers → handover_draft*) · DB-046 (drop redundantnih) · DB-044 (indeks za numeraciju). Pravilo DB-047 usvojiti pre ove faze.

**Faza 2 — constraint mreža (traži orphan/dedup scan, NOT VALID → VALIDATE, bez downtime-a):**
DB-001, DB-002 (CASCADE → NoAction/guard na knjiženim podacima — NAJVAŽNIJE u ovoj fazi) · DB-003 (NULLS NOT DISTINCT) · DB-004, DB-005, DB-011, DB-013 (UNIQUE posle dedupa) · DB-006, DB-007, DB-009, DB-012 (CHECK paket) · DB-008, DB-016, DB-017 (FK dodavanja) · DB-022 (parcijalni unique).

*Pred-scan Faze 2 izveden 25.07 na produ (svi upiti read-only) — spremnost po stavci:*

| Stavka | Scan rezultat | Spremnost |
|---|---|---|
| DB-001/002 guard knjiženih dokumenata | GL/fakture/blagajna tabele prazne (pilot) | ✅ spremno — predlog: DB trigger brani DELETE za posted/locked (kaskada za draftove ostaje, servisi se ne diraju) |
| DB-003 vat_returns NULLS NOT DISTINCT | 0 duplikata perioda | ✅ spremno |
| DB-004 workers.card_id UNIQUE | **0 duplikata** | ✅ spremno (parcijalni, `WHERE card_id <> ''`) |
| DB-005 projects.project_number UNIQUE | **0 duplikata** | ✅ spremno |
| DB-006/007 CHECK ledger + POSTED-kupac | 0 prljavih redova | ✅ spremno |
| DB-009 CHECK paket (količine/rabati/intervali/smerovi/periodi) | **0 prljavih redova u SVIH 14 provera** | ✅ spremno |
| DB-011 invoices unique + company_id | tabela mala | ✅ spremno |
| DB-008 FK handover_draft_items.drawing_id | 1 orphan red | ✅ spremno uz mini-sanaciju (1 red) ili FK NOT VALID |
| DB-013 document_types.code | 0 duplikata (3 reda) | ✅ spremno |
| DB-013 workers.username | duplikati: Nikola×4, Dule×4, Stefan×4, Aca×3, Ivan×3, Nemanja×3 + 8 parova | ⛔ ODLOŽENO — legacy višestruki radnici, traži kadrovsku presudu |
| DB-081 items.catalog_number | **1.980 duplikat-grupa / 4.298 artikala** | ⛔ BLOKIRANO podacima — čišćenje prvo u BigBit-u (lista: `~/backups/sanacije/items_katbroj_duplikati_2026-07-25.csv`); watchdog do tada |
| DB-022 parcijalni unique (pracenje_notes, predmet_planeri, reassign_audit) | male tabele | ✅ spremno |

**Faza 3 — izmene koje diraju podatke ili šire kod (planski, po modulu):**
DB-028 (normalizacija status case + sweep upita) · DB-059 (soft-delete čitaoci pre uključenja) · DB-060 (lager fallback) · DB-063 (GL audit trag) · DB-031 (godina/datum kroz Europe/Belgrade) · DB-043 (retention poslovi posle odluke o rokovima) · DB-014, DB-015, DB-067 (konzistencija header/stavke i statusa) · DB-025, DB-027 (tipovi/preciznost na app-owned tabelama) · DB-056 (DROP prod leftover tabela uz potvrdu) · DB-069 (čišćenje mrtvih modela).

**Faza 4 — arhitektonske odluke (uz Negovana/Nesu, ne raditi unapred):**
DB-050 (aktivacija RLS-a) · DB-051 (ne-superuser rola + sync privilegija) · DB-038 (strategija za drawing_pdfs) · DB-030 (konsolidacija timestamp režima — rewrite velikih tabela) · DB-010, DB-026 (magic zero i Float konverzije — tek uz/posle BigBit cutover-a) · DB-018, DB-055 i ostale ZA PROVERU stavke.

---

*Napomena o metodi: nalazi A–F potiču iz 6 nezavisnih prolaza (šema+migracije+kod), ukršteni sa introspekcijom žive produkcijske baze (pg_catalog/information_schema, isključivo SELECT/SHOW). Sve tvrdnje o produ (RLS=0, POPDV=0 redova, 58 FK bez indeksa, veličine tabela, redosled u `_prisma_migrations`, timezone, backup artefakti) su izmerene 25.07.2026, ne izvedene iz koda. Stavke „ZA PROVERU" su označene tamo gde dokaz nije potpun.*
