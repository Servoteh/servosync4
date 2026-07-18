# Integracija 1.0 ↔ 2.0 — analiza preklapanja i strategija za 3.0

> **Status: ANALIZA ZA PLANIRANJE, nije odluka.** Podloga za dogovor (Negovan/Nesa/Luka).
> Otvorene arhitektonske odluke ne implementirati unapred (BACKEND_RULES §11).
> Podaci iz živih upita 2026-07-08; spisak tabela: [../infra/BAZE-UPOREDNI-PREGLED.md](../infra/BAZE-UPOREDNI-PREGLED.md).

## 1. Šta se stvarno preklapa

Od 198 (1.0) + 88 (2.0) tabela, domenski se preklapaju **samo dve stvari** — i baš njih je Nenad označio
kao prioritet: **lokacije** i **zaposleni**. Ostalo je ili jedinstveno za jednu aplikaciju, ili je isti
BigTehn izvor koji obe kešititaju (1.0 u `bigtehn_*_cache`, 2.0 u sync tabelama — v. uporedni pregled).

| Domen | 1.0 | 2.0 | Priroda preklapanja |
|---|---|---|---|
| **Zaposleni** | `employees` (38 kol, čist HR) | `workers` (16 kol, QBigTehn operater/login) | isti ljudi, različit fokus — treba spajanje |
| **Lokacije** | `loc_*` (fizičke lokacije, hijerarhija, kretanja) | `part_locations` (QBigTehn praćenje delova) | ista reč, **različit pojam** — v. §3 |
| BigTehn master | `bigtehn_*_cache` (23, read-only) | sync tabele (customers, items…) | isti izvor, 2.0 modeluje dublje |

## 2. ZAPOSLENI — spajanje (1.0 = izvor istine)

**Nalaz: 1.0 `employees` je jedini pravi HR zapis i mora ostati izvor istine.**

| | 1.0 `employees` | 2.0 `workers` |
|---|---|---|
| Redova | 155 aktivnih (157 ukupno) | 169 |
| Kolone | **38** — matični, datum rođenja, adresa, banka, obrazovanje, lekarski, kontakt za hitne, tim… | 16 — username, password, card_id, work_unit_code, tip, „defines_approval/launch" |
| Ključ (`id`) | `uuid` | `integer` (legacy QBigTehn id) |
| Uloga | kadrovski master (osoba) | proizvodni operater / login (ko radi/potpisuje/lansira RN) |

**Problem spajanja — nema zajedničkog stabilnog ključa** (mereno 2026-07-08):

| Ključ | 2.0 workers | 1.0 employees | Može li JOIN? |
|---|---|---|---|
| Matični broj | 0/169 popunjeno | 99/155 popunjeno | ❌ (2.0 strana prazna) |
| Kartica | card_id 169/169 | card_barcode 0/155 | ❌ (1.0 strana prazna) |
| Ime i prezime | — | — | ⚠️ samo fuzzy: 100/169 po imenu (redosled nebitan); ostatak = sistemski nalozi („Korisnik", „Kontrola", „Student 1/2") + varijacije u pisanju |

**Predlog:** person-master = `employees` (1.0). QBigTehn `workers` postaje „operater profil" vezan za osobu
preko **mapping tabele sa potvrdom** — isti obrazac koji 1.0 već ima za prisustvo (`katze_employee_map`:
`match_method`, `confirmed_by`, `confirmed_at`). Novi `worker_employee_map` (ili proširiti postojeći):
seed fuzzy po imenu → čovek potvrdi. Uz to: popuniti `card_id`↔`card_barcode` ili matični na jednoj strani
da se dobije tvrd ključ za ubuduće.

**Otvoreno pitanje (Nesa/kadrovska):** da li se `card_id` iz QBigTehn-a i `card_barcode` iz 1.0 odnose na
istu fizičku karticu? Ako da → to je najbrži tvrd ključ za spajanje.

## 3. LOKACIJE — pažljivo, dva različita pojma pod istim imenom

**Nalaz: „lokacije" u 1.0 i 2.0 NISU ista stvar** — treba ih razdvojiti pre nego što se „objedine".

| | 1.0 `loc_*` | 2.0 `part_locations` |
|---|---|---|
| Šta je | **Fizičke lokacije** — magacin/police/zone | QBigTehn „lokacije delova" |
| Model | `loc_locations` (hijerarhija: `parent_id`, `path_cached`, `depth`, `location_type`), `loc_item_placements` (gde je šta sad), `loc_location_movements` (dnevnik kretanja, odobrenja, offline `client_event_uuid`) | jedna tabela: `work_order_id, project_id, quality_type_id, position_id, worker_id, record_date, quantity` |
| Redova | loc_locations 1.561 · placements 856 · movements 1.121 | 7.003 |
| Priroda | zreo sistem fizičkih lokacija + kretanja | izgleda kao **praćenje proizvodnje** (koliko komada RN/pozicije je na kom kvalitetu/koraku), NE fizička polica |
| BigTehn veza | `bigtehn_locations_cache` = **prazan** → 1.0 NE koristi QBigTehn lokacije; `loc_bigtehn_ingest_state` → 1.0 ingestuje BigTehn *signale* i vodi svoje lokacije | direktan port QBigTehn `tLokacijeDelova` |

**Predlog:** fizičke lokacije = `loc_*` model iz 1.0 (jasno napredniji) postaje jedinstven sistem lokacija
u 3.0. `part_locations` iz 2.0 tretirati kao **praćenje proizvodnje**, ne kao fizičke lokacije — verovatno
se mapira na `loc_location_movements`/placements ili na proizvodni status, ne na `loc_locations`.

**Otvoreno pitanje (Negovan):** šta tačno QBigTehn `tLokacijeDelova` beleži — fizičku poziciju dela ili
status u proizvodnom toku? Od toga zavisi da li se uopšte spaja sa `loc_*` ili je zaseban domen.

## 4. Ostala preklapanja imena — za 3.0 (usaglasiti)

| Ime | 2.0 | 1.0 | Napomena |
|---|---|---|---|
| `projects` | Predmeti iz QBigTehn (7.602) | interni projekti (23) | **različit pojam** — ne stapati naslepo |
| `departments` | 1 (QBigTehn) | 13 (uredno) | 1.0 = izvor istine |
| `audit_log` | prazan | 10.379 | dve app-audit šeme → objediniti |
| `user_roles` / auth | nema (auth 0%) | 54 role + ~360 RLS | 1.0 model + RBAC predlog 2.0 = polazna tačka |
| crteži | `drawings` (11.286) | `production_drawings` (0), `bigtehn_drawings_cache` (5.421) | 2.0 ima pun PDM; 1.0 samo referencira |

## 5. Strategija — „sync sve u novi PG pa modul-po-modul, pa ugasi syncove"

Nenadova ideja je **u suštini tačna** i poklapa se sa roadmap-om (1.5 međukorak + 3.0 strangler-fig).
Tri precizacije da ne upadnemo u zamku:

**5.1 „Sync" vs jednokratna seoba — kritična razlika.**
Trajni dvosmerni sync 198 tabela između 1.0 i 2.0 dok se sve prepravlja = najskuplji i najlomljiviji put
(konflikti, dupli izvori istine — protiv pravila „jedan izvor po tabeli"). Umesto toga:
**jednokratni lift-and-shift** 1.0 baze na on-prem PG (Supabase → self-host, kod netaknut = roadmap 1.5),
pa strangler-fig nad tom bazom. Nije „sync", nego seoba + presek.

**5.2 Jedna PG mašina, ali odvojene baze/šeme na početku.**
Ne spajati 88 (2.0) u 198 (1.0) prvog dana. Obe žive na **istom PG serveru** kao zasebne baze/šeme; spajanje
u zajedničke tabele ide **po domenu, tek kad se taj modul prepravlja**. Tako nema velikog „big-bang" merge-a.

**5.3 Dva synca umiru u različito vreme.**
- Supabase→on-prem „sync" = zapravo jednokratna seoba → gasi se odmah po 1.5.
- QBigTehn `bridge_reader` sync = ostaje dok 2.0 proizvodni core ne postane izvor istine za te podatke
  (posle cutover-a 2.0), pa onda umire. (Već zapisano: sync je privremen, BigBit ostaje do 4.0.)

**Preporučeni redosled:**
1. **1.5** — 1.0 Supabase → on-prem PG (isti server kao 2.0), kod 1.0 nepromenjen. Gasi se Supabase sync.
2. **3.0 start** — auth/RBAC paritet (najteži deo: ~360 RLS → NestJS guardovi).
3. **Pilot modul** sa malim rizikom (predlog: Lokacije ili Reversi — samostalni, jasan domen).
4. **Prioritetni spojevi** (Nenadovi): Zaposleni (employees = izvor istine + mapping) i Lokacije
   (`loc_*` = model), svaki kad mu dođe red kao modul.
5. Ostali moduli 1.0 modul-po-modul; front repointuje sa PostgREST na NestJS.
6. Kad poslednji modul pređe → gase se PostgREST/GoTrue; po 2.0 cutover-u → gasi se QBigTehn sync.

## 6. Otvorena pitanja (za Negovan/Nesa/Luka)

1. **Negovan:** šta beleži QBigTehn `tLokacijeDelova` (`part_locations`) — fizička pozicija ili proizvodni status? (§3)
2. **Nesa/kadrovska:** da li je `card_id` (QBigTehn) ista fizička kartica kao `card_barcode`/`katze` u 1.0? (§2)
3. **Luka/arh.:** potvrda 5.1–5.2 — jednokratna seoba + odvojene šeme na istom serveru (ne trajni sync, ne big-bang merge)?
4. Koje su matične tabele „deljene" od prvog dana 3.0 (employees, departments, lokacije, auth), a koje ostaju po modulu?
