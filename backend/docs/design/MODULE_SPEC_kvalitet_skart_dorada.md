# Kvalitet: evidencija škarta i dorade — specifikacija toka unosa

**Status:** PRESUĐENO 26.07.2026 (§5) · **Poreklo:** plan AI OS
(docs/PLAN_AI_OS_2026-07.md, Pruga P; presuda 26.07: „kvalitet ide u modul, pogon dobija obavezu unosa")

## 1. Zašto

Celokupna evidencija kvaliteta firme danas: 40 NM zapisa (montaža) + 2 Excel fajla (100 škart +
50 dorada redova). AI za kvalitet (vizija §4.13) je nemoguć bez podataka; podaci počinju da se
gomilaju tek od dana kad unos postane deo procesa. Cilj V1: **svaki škart i svaka dorada u bazi,
sa razlogom, operacijom i mašinom** — ništa više.

## 2. Model (glavna baza, app-owned)

`quality_events`
- id, type ('SKART' | 'DORADA')
- work_order_id (FK, obavezno) + tech_process_id (FK, nullable — konkretna operacija ako postoji)
- qty numeric (obavezno, >0), unit (default 'kom')
- reason_code_id (FK na `quality_reason_codes`, obavezno) + note text (opciono)
- machine_id / work_unit_code (iz operacije ako je vezana; ručno ako nije)
- reported_by_worker_id (obavezno), reported_at
- confirmed_by_user_id, confirmed_at (nullable — vidi presudu P2)
- photo storage path (opciono, postojeći storage obrazac)
- audit polja po konvenciji

`quality_reason_codes` — šifarnik razloga (seed iz kategorija postojeća 2 Excel fajla + „ostalo");
održava se u Podešavanjima (admin/menadzment), soft-delete.

Jednokratni uvoz: 150 postojećih Excel redova mapirati u `quality_events` (posebna skripta,
proba na dev bazi, van migracije).

## 3. Tok unosa — PO PRESUDI P1+P2

**Kanonski unos: kontrolor u modulu Kvalitet** (desktop, novi tab „Škart i dorada"): sva polja
iz §2, kontrolorov unos nastaje u statusu **POTVRDJEN** (on je autoritet).

**Kiosk (radnik): SAMO prijava-signal.** Radnik uz operaciju može da tapne „Prijavi škart/doradu"
(tip + količina + opciono razlog/slika) → zapis u statusu **PRIJAVLJEN**. Ne ulazi ni u jedan
izveštaj dok ga kontrolor u modulu ne **potvrdi** (dopuni razlog/količinu/operaciju) ili
**odbaci** (uz razlog — i odbacivanje je podatak). Kontrolor vidi red čekanja prijava sa
brojačem u tabu.

*Tumačenje spregnutih presuda (P1 „samo kontrolor unosi" + P2 „dva statusa"): kontrolor je
jedini čiji unos VAŽI; radnička prijava postoji samo kao signal koji kontrolora zove da
evidentira. Ako se želi i stroža varijanta (potpuno bez kioska), kiosk dugme se gasi flagom.*

## 4. Prikaz i obaveštenja

- Novi tab „Škart i dorada" u /kvalitet: lista + filteri (period, RN, mašina, razlog, tip) +
  zbirevi po razlogu/mašini (Pareto već u V1 — jeftino, tabela + procenti, bez grafike u V1).
- Zvonce menadžmentu iznad praga (env, default: pojedinačan događaj qty ≥ 5 ili ≥ 3 događaja
  istog razloga u 7 dana) — isti mehanizam kao montaza-neusaglasenosti.
- AI kasnije (vizija §4.13) čita ovu tabelu — ništa AI-specifično se ne gradi sada.

## 5. Presude — DONETE 26.07.2026 (Nenad)

**P1: b) Samo kontrolor unosi** — kanonski unos u modulu Kvalitet; radnik na kiosku ima samo
laganu prijavu-signal (vidi §3). ✅
**P2: b) Dva statusa** — PRIJAVLJEN → POTVRDJEN/ODBACEN; u izveštaje ulazi samo POTVRDJEN. ✅

Povezana presuda istog dana (BigBit sync): **PDV tarife se IZBACUJU iz sync mape** — registar
tarifa se od sada vodi isključivo u 4.0 (kao goods_documents ranije).

## 6. Van obima V1

Merna izveštavanja/kontrolni planovi, CAPA/5-why tokovi, vezivanje na reklamacije kupaca,
AI analiza uzroka — sve tek kad V1 skupi ≥ nekoliko meseci podataka.
