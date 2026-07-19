# Praćenje proizvodnje — analiza + osnova za 2.0-native modul (jul 2026)

Izvor zahteva: [docs/zahtevi/Predlozi za pracenje proizvodnje.docx](zahtevi/Predlozi%20za%20pracenje%20proizvodnje.docx)
(tekst + 12 screenshot-ova). Autoritativni spec postojećeg (portovanog) modula:
[MODULE_SPEC_planovi_pracenje_30.md](../backend/docs/design/MODULE_SPEC_planovi_pracenje_30.md).
Status: **POTVRĐEN — odluke O1–O8 presuđene 19.07.2026 (Nenad, §6). Izvođenje F1 u toku.**

---

## 1. Zašto ovaj dokument

Modul „Praćenje proizvodnje" (`/pracenje-proizvodnje`) je u 2.0 **prenet iz 1.0 kao paritet**
(Talas C, R1/R2 gotovi na BE). Paritet je značio: zadržati 1.0 pozadinu — sy15 bazu, njene
DEFINER RPC-ove i `bigtehn_*` keš tabele (odluka spec §7-P9: „repoint na 2.0 tabele = zaseban
most, ne deo seobe").

**Taj „zaseban most" je ovaj posao.** Odluka korisnika (Nenad, 19.07.2026): sync/bridge lanac
se **ukida potpuno** — praćenje mora da sedi direktno na originalnim 2.0 PostgreSQL tabelama
(`work_orders`, `tech_processes`, …), koje su od cutover-a 14.07.2026 **vlasništvo ServoSync-a**
(BACKEND_RULES §3 „Vlasništvo tabela"; `table-ownership.ts` `OWNED_PRODUCTION_TABLES`).
Istovremeno se ugrađuju dopune korisnika iz docx-a (§4).

## 2. Zatečeno stanje — kuda podaci danas putuju

```
   2.0 PostgreSQL (IZVOR ISTINE od 14.07.)
   work_orders / work_order_operations / tech_processes / work_time_entries
        │
        │  loc-tp-feed.service.ts  (backend/src/modules/locations/)
        │  "B1 loc-most repoint" — watermark loc_tp_feed_state
        ▼
   sy15 (1.0 baza)  bigtehn_work_orders_cache / bigtehn_work_order_lines_cache /
                    bigtehn_tech_routing_cache   (+ bridge_sync_log za monitoring)
        │
        │  pg_cron u sy15 → loc_bigtehn_ingest_run()
        ▼
   sy15 production.* šema + DEFINER RPC-ovi
   get_pracenje_portfolio / get_aktivni_predmeti / get_podsklopovi_predmeta /
   get_predmet_pracenje_izvestaj / get_pracenje_rn / get_operativni_plan / …
        │
        │  PracenjeService ($queryRaw kroz DRUGI Prisma klijent @prisma-sy15,
        │  withUserRls — GUC + RLS odluke u sy15)
        ▼
   2.0 backend /api/v1/pracenje/*  →  frontend /pracenje-proizvodnje
```

Dakle: podatak nastane u 2.0 bazi, otputuje u 1.0 bazu, tamo ga RPC-ovi prerade, pa ga 2.0
backend čita nazad. Tri skoka, dva watermarka, pg_cron u tuđoj bazi — i svaki ekran praćenja
zavisi od zdravlja mosta. UI to i priznaje: „Izvor: BigTehn (MES) — read-only".

### 2.1 Šta je u sy15 KEŠ (umire sa mostom), a šta APLIKATIVNI PODATAK (mora da se preseli)

| sy15 objekat | Priroda | Sudbina |
|---|---|---|
| `bigtehn_work_orders_cache`, `bigtehn_work_order_lines_cache`, `bigtehn_tech_routing_cache`, `bigtehn_items_cache`, `bigtehn_drawings_cache`… | **keš** (kopija 2.0 / legacy podataka) | umire — čita se original u 2.0 |
| view lanac `v_production_operations*`, `v_active_bigtehn_work_orders`, RPC-ovi `get_pracenje_*` | **izvedena logika nad kešom** | logika se **prepisuje u 2.0 servis/SQL** (semantika se čuva, popisana u spec §2 „skrivena pravila") |
| `production.pracenje_manual_overrides` (6), `pracenje_parent_override` (0), `pracenje_proizvodnje_napomene` (1) | **aplikativni podatak** (ručni override-i/napomene) | **migrira se** u 2.0 app-owned tabele |
| `production.operativna_aktivnost` (+pozicija, blok_istorija) | **aplikativni podatak** (operativni plan Tab2) | **migrira se** u 2.0 |
| `production.predmet_aktivacija`, `predmet_prioritet`, `predmet_plan_prioritet` (+audit) | **aplikativni podatak** (aktivni predmeti, ↑↓ redosled, ⭐ top-lista) | **migrira se** u 2.0 |
| `core.odeljenje`, `core.radnik` | šifarnici Faze 2 (1.0) | mapira se na 2.0 `workers`/`users` + novi šifarnik odeljenja (odluka §6-O3) |
| `production.radni_nalog` („Faza 2" lokalni RN, uuid) + `ensure_radni_nalog_iz_bigtehn` | 1.0 hibridna konstrukcija | **ne prenosi se** — 2.0 ima prave RN (`work_orders`); veze aktivnosti se remapiraju (§6-O4) |
| `audit_log` (istorija izvoza/aktivnosti) | aplikativni log | novi zapisi idu u 2.0 `audit_log`; istorija po potrebi jednokratni uvoz |

Napomena o količinama (docx zahtev „ručne količine"): kolone tipa `lansirano`/`završeno` su
izvedene iz kucanja — ručna korekcija ide kroz override tabelu (§3.2), ne u izvorne tabele.

### 2.2 Šta se gasi u kodu

- `loc-tp-feed.service.ts` produkcijski feed (tech_routing/work_orders/lines) + pg_cron
  `loc_bigtehn_ingest_run()` u sy15 + `loc_tp_feed_state` watermark — **gasi se** kad praćenje
  (i Lokacije, koje su prvobitni potrošač feed-a — RUNBOOK_LOC_MOST_REPOINT.md) pređu na 2.0 čitanja.
- `PracenjeService` zavisnost od `Sy15Service`/`@prisma-sy15` — **uklanja se** (modul prelazi na
  `PrismaService` / 2.0 SQL).
- `bigtehn_drawings_cache` + bucket `bigtehn-drawings` za PDF crteža — zamenjuje ih 2.0 PDM
  (`drawings`/`drawing_pdfs`, endpoint već postoji: `tech-processes` `GET drawings/:id/pdf/content`).
- **Ne dira se**: `bigbit-sync` (BigBit matični podaci — `customers`, `items`, `projects`… ostaju
  read-only keš do 4.0, BACKEND_RULES §3); Plan proizvodnje (`plan-proizvodnje` modul) ima ISTU
  sy15 zavisnost, ali se repoint-uje kao poseban korak na istoj novoj osnovi (§5, F5).

## 3. Ciljna osnova — praćenje nad originalnim 2.0 tabelama

### 3.1 Mapiranje pojmova ekrana na 2.0 šemu

| Pojam u praćenju | 2.0 izvor istine |
|---|---|
| **Predmet/projekat** (9400 Presa…) | `projects` (BigBit keš, read-only referenca) + `work_orders.project_id` |
| **RN / pozicija** (9400/1/131) | `work_orders` — poslovni identitet **(project_id, ident_number, variant)**; rok = `production_deadline`; završen = `status`; zaključan = `is_locked` |
| **Hijerarhija sklop → podsklop → pozicija** | primarno `work_order_components` (RN→RN veze, Was: tRNKomponente) + PDM BOM `drawing_assemblies`/`drawing_components` kao auto-izvor; ručna korekcija kroz override (§3.2) |
| **Tip reda** (glavni sklop / podsklop / zav. sklop / pojedinačna) | izvedeno iz hijerarhije + naziva/crteža; ručni override (§3.2) |
| **Operacije (TP)** | `work_order_operations` (routing po RN: broj operacije, radni centar, vremena, prioritet) |
| **Kucanja / urađene količine** | `tech_processes` (akumulirani `piece_count` po trojci+operaciji, `is_process_finished`) + `work_time_entries` (START/STOP sesije — daje i **datum završetka operacije**) |
| **Završna / međufazna kontrola** | `tech_processes` kucanja na kontrolnim radnim centrima (`POST /tech-processes/control` već postoji) |
| **Mašinska obrada / površ. zaštita DA-NE** | izvedeno iz routing-a (klase radnih centara u `operations`) + ručni override (§3.2) |
| **Crtež + PDF na klik** | `drawings` / `drawing_pdfs` (PDM); RN → `drawing_id` / `drawing_number` |
| **Dokument primopredaje** | `drawing_handovers` / `handover_status_id` na RN-u (`work_orders.drawing_handover_id`) |
| **Dorada / škart** | `work_orders.parent_work_order_id` (rework lanac, ODLUKE #35) |
| **Prijave rada (side panel)** | `work_time_entries` po RN + operaciji |

### 3.2 Nove app-owned tabele (2.0, Prisma migracije; `Timestamptz(6)`, statusi String)

1. **`pracenje_overrides`** — po RN-u: ručni status (`u_radu`/`kompletirano`/`nije_zapoceto`/null=auto),
   ručna mašinska/površinska (bool|null), ručna „urađena količina" (+razlog, ko, kada).
   Zamena za sy15 `pracenje_manual_overrides` (podaci se migriraju).
2. **`pracenje_structure_overrides`** — ručno re-parent pozicije/podsklopa (RN → parent RN,
   `clear` vraća na auto). Zamena za `pracenje_parent_override`.
3. **`pracenje_notes`** — korisničke napomene po predmetu/RN-u (zamena za `pracenje_proizvodnje_napomene`).
4. **`predmet_aktivacije`** — aktivan predmet + prioritet liste + ⭐ plan-prioritet (spaja
   `predmet_aktivacija`/`predmet_prioritet`/`predmet_plan_prioritet`; audit kroz 2.0 `audit_log`).
5. **`operativne_aktivnosti`** (+ `operativne_aktivnosti_blokade`) — Tab2 operativni plan
   (aktivnosti po odeljenjima, zavisnosti, blokade sa razlogom). Migracija iz sy15 uz remap
   RN veza (§6-O4).
6. **`odeljenja`** — šifarnik odeljenja (kod, naziv, boja, vođa) — §6-O3.
7. **Kooperacija** (novo — docx §4.11): `koop_otpremnice` (kooperant=`customers` ref, vrsta:
   `galvanska`/`termicka`/`masinska`, datum slanja, kilaža, napomena, status vraćeno+datum) +
   `koop_otpremnica_stavke` (RN/pozicija, crtež, količina, tip presvlake, jedinstven broj).
   Auto-„vraćeno" kad se kuca međufazna kontrola za taj RN (§6-O6).

### 3.3 Novi read sloj (zamena za sy15 RPC-ove)

`PracenjeService` prelazi na 2.0 SQL (Prisma + `$queryRaw` gde treba rekurzija):

- `portfolio()` / `predmeti()` — rollup po aktivnom predmetu iz `predmet_aktivacije` ⋈
  `work_orders` ⋈ kucanja. Bez kolone „usko grlo" (docx 4.6).
- `izvestaj(predmet)` — **stablo**: `WITH RECURSIVE` po `work_order_components`
  (+ structure override-i) — **obavezan anti-ciklus guard** (BACKEND_RULES §11.4: PG visi na
  cikličnoj sastavnici!) — sa procentima gotovosti po poziciji → podsklopu → sklopu (§6-O5).
- `rn(rnId)` — pozicije + operacije + kucanja + prijave, bez `local/bigtehn` fallback-a
  (postoji samo jedan izvor).
- `operativniPlan(rnId)` — nad novim `operativne_aktivnosti`.
- Permisije, envelope `{data, meta}`, `withUser` GUC audit — ostaju kao danas (`pracenje.read/edit/manage/prioritet`).

Semantička pravila iz 1.0 koja se čuvaju pri prepisu (spec §2 „skrivena pravila"): kanon
otvorene operacije, sort kanon, edit matrica (Tab2 `pracenje.edit`, override-i `pracenje.manage`,
prioritet admin), sanitizacija broja crteža, C3 gate za PDF (pogon ne vidi crteže — §6-O7).

## 4. Dopune korisnika iz docx-a → gde se rešavaju

| # | Zahtev | Sloj | Oslonac u osnovi |
|---|---|---|---|
| 1 | Sklopovi u tabeli + filter po sklopu u „opsegu" | BE+FE | stablo §3.3; filter po čvoru stabla |
| 2 | Vidljiva pripadnost pozicija sklopu (auto; ručno ako ne može) | BE+FE | `work_order_components`/BOM + `pracenje_structure_overrides` |
| 3 | Boja celog reda po tipu (podsklop zelena, zav. sklop žuta…) | FE | tip reda iz §3.1; boje kroz tokene/StatusBadge mapu (DESIGN_SYSTEM §7) |
| 4 | Jasno stablo po projektu + **% gotovosti** po poziciji/podsklopu/sklopu + % mašinske obrade | BE+FE | rollup u `izvestaj()`; definicija % = §6-O5 |
| 5 | Freeze levih kolona pri horizontalnom skrolu (sad se preklapaju) | FE | sticky kolone u kit tabeli (popraviti i za matrični prikaz) |
| 6 | Ručni unos količina („fizički urađeno a nije otkucano") | BE+FE | `pracenje_overrides.manual_qty` + razlog; jasno označeno da je ručno |
| 7 | Status „Kompletirano" auto-postavlja mašinsku+površinsku na DA i 100% | BE | pravilo u override servisu (jedan izvor istine, ne FE trik) |
| 8 | Izbaciti kolonu „usko grlo" sa kontrolne table | FE | brisanje kolone (BE polje prestaje da se računa) |
| 9 | Ispod količine datum završetka operacije (informativno) | BE+FE | `work_time_entries.stopped_at` / `tech_processes.finished_at` |
| 10 | U RN pogledu: − „rok izrade", + „dokument primopredaje (ako postoji)"; klik nazad u tabelu praćenja; filteri maš. obrada / površ. zaštita / pozicija | BE+FE | `drawing_handovers`; navigacija + filteri FE |
| 11 | Statusi: U radu / Kompletirano / Nije započeto (+Auto) | BE | String status u `pracenje_overrides` (postojeća semantika, bez Prisma enuma) |
| 12 | Klik na crtež otvara PDF | FE | PDM `drawing_pdfs` (+ C3 gate odluka §6-O7) |
| 13 | **Kooperacija**: 3 vrste (galvanska/termička/mašinska), tabela pored praćenja (kooperant, RN, br. crteža, datum slanja, količina, tip presvlake, naziv, jedinstven broj, napomena, kilaža); označavanje vraćeno+datum; auto-vraćeno posle međufazne kontrole; **otpremnice se kucaju kroz aplikaciju** (Word šablon kao uzor) i pune tabelu | BE+FE | nove tabele §3.2-7; štampa otpremnice po obrascu `work-order-print` servisa |

## 5. Redosled izvođenja (faze — svaka isporučiva zasebno)

| Faza | Šta | Zavisi od |
|---|---|---|
| **F0** | ✅ Odluke §6 potvrđene (19.07.2026, Nenad) | — |
| **F1 — osnova** | ✅ **BE GOTOVO 19.07.2026** (2 multi-agent kruga + popravke po adversarnom review-u: 11/11 nalaza FIXED; build zelen, 90 unit + 347 e2e prolazi). Nove tabele (§3.2, +`legacy_sy15_id` za egzaktnu idempotentnost uvoza) + `pracenje-read.service.ts`/prepisan mutacioni sloj na 2.0 tabelama + `scripts/migrate-pracenje-sy15.ts` (dry-run default). **SQL smoke prošao 19.07. na živom PG-u** (4.0 sandbox 192.168.64.28:5437 — prazna baza sa punom šemom uklj. F1 tabele; `scripts/smoke-pracenje-read.ts`: svih 17 read putanja, 0 SQL grešaka). **Ostaje uz bazu SA PODACIMA** (dev Docker 5435 ili pravi klon prod-a): primena migracije `20260719120000_pracenje_native_f1`, dry-run migracionog skripta (traži i `SY15_DATABASE_URL` — nije u dev `.env`!) → pregled nerazrešenih veza → `--apply`, pa smoke ekrana sa stvarnim brojevima. sy15 karantin: samo `akcione-tacke` lookup (`pracenje-akcije-sy15.service.ts`, TODO dok se Sastanci ne presele); `promote` = 501 do tada. | F0 |
| **F2 — preklop** | ✅ **ŽIVO NA PRODU 19.07.2026 u 16:44** — deploy `32b986b`+`b2e5916` (boot fix: `scripts/` van nest build-a, incident ~30 min crash-loop), migracija primenjena kroz deploy, uvoz iz stare baze izvršen (`--apply`: 7 odeljenja, 12 override-a, 2 napomene, 7602 aktivacije, 4 aktivnosti (test podaci, RN null), 51 audit — 0 preskočeno). Ekran čita glavnu bazu; `Sy15Service` van modula (karantin samo akcione-tacke). Ostaje: vizuelni parity check korisnika + redirect 1.0 ekrana (O8, izmena u 1.0 repou). | F1 |
| **F3 — dopune tabele** | Stablo + % gotovosti + boje + freeze kolona + ručne količine + auto-pravila statusa + datum operacije + čišćenje kolona (usko grlo, rok izrade→primopredaja) + filteri + PDF klik. | F2 |
| **F4 — kooperacija** | Tabele + ekran pored praćenja + otpremnica kroz aplikaciju + auto-vraćeno. | F1 (nezavisno od F3) |
| **F5 — gašenje mosta** | Repoint Plan proizvodnje + Lokacija na istu osnovu → gašenje `loc-tp-feed`, pg_cron ingest-a i `bigtehn_*` keša u sy15. | F2 + zaseban plan za PP |

## 6. Odluke — ✅ SVE PRESUĐENE 19.07.2026 (Nenad)

1. **O1 — Predmet u 2.0 = `projects` red** (BigBit keš, read-only) identifikovan kroz
   `work_orders.project_id`; `predmet_aktivacije` referencira `project_id` (Int, bez FK na keš).
2. **O2 — Migracija: živi podaci + jednokratni uvoz audita** u 2.0 `audit_log` (append-only) —
   ništa se ne gubi.
3. **O3 — Odeljenja: novi šifarnik `odeljenja`** u 2.0 (7 redova prenosi se iz sy15
   `core.odeljenje`; nose boju/vođu — semantika drugačija od radnih jedinica).
4. **O4 — Remap aktivnosti: preko `legacy_idrn`/RN broja** na 2.0 `work_orders.id`;
   nerazrešive veze se null-uju + izveštaj (isti obrazac kao sync-eri).
5. **O5 — % gotovosti po komadima završne kontrole, ponderisano**: pozicija = kucano ZK /
   lansirano; sklop = prosek pozicija ponderisan količinom; % mašinske obrade = isti princip
   samo nad mašinskim operacijama (poklapa se sa Excel primerom iz docx-a).
6. **O6 — Auto-„vraćeno sa kooperacije": međufazna kontrola, delimično** — prvo kucanje MK za
   taj RN posle datuma slanja označava vraćeno + datum; količina sa kucanja puni „vraćeno kom"
   (delimična količina = delimično vraćeno); ručna korekcija uvek moguća.
7. **O7 — PDF crteža: SVI prijavljeni vide PDF u praćenju** — C3 gate se za modul praćenja
   UKIDA (Nenadova presuda, svesno šira od predloga „strogi paritet"; rizik IP izložen i
   prihvaćen). Gate u drugim modulima (Plan proizvodnje skice/bigtehn) se ovde ne dira.
8. **O8 — 1.0 ekran praćenja: redirect na 2.0 odmah po F2** — nema paralelnog rada, nema
   duplog unosa override-a.

## 7. Veza sa postojećim planovima

- ROADMAP t.6b (izdvajanje „Praćenje i planiranje proizvodnje" kao MES modula) ostaje 3.0
  reorg tema — ovaj plan mu **ne protivreči**: gradi ispravnu pozadinu koju će reorg samo
  premestiti u navigaciji.
- MIGRACIJA_3.0_PLAYBOOK §4.2 („repoint keša na 2.0") se ovim planom **izvršava i zatvara**
  za praćenje; za Plan proizvodnje i Lokacije važi F5.
- BACKEND_RULES §4/§11: BigBit matični sync NIJE predmet ovog plana i ostaje do 4.0.
