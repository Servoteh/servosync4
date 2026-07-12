# Komentari tehnologije na 2.0 — trijaža (2026-07-12)

Izvor: `Komentari tehnologija V2.0.pdf` (Miljan — „meni i Jovici" u t.10; PDF u ovom folderu).
Trijaža ukrštena sa stanjem koda na dan 12.07.2026 (posle ODLUKE #33 — razdvajanje
Nacrti `/nacrti` / Primopredaje `/handovers` + `primopredaje.approve` za tehnolog/menadžment).

Status legenda: ✅ već postoji · 🐛 potvrđen bug · 🔧 mali zahvat · 🏗️ srednji · 📐 arhitektura/3.0.

| # | Komentar | Trijaža | Nalaz / predlog |
|---|---|---|---|
| 1 | Ne upisuje tehnologa pri novom RN („može po loginu") | ✅ + **data fix** | Backend VEĆ default-uje na login: `workerId: dto.workerId ?? actor?.workerId ?? 0` (work-orders.service.ts create). Stvarni uzrok: **`users.worker_id` NIJE vezan** za tehnologe u prod bazi (miljan id11, nikola id12, aleksandar id14, stefan id15, dragan id16 — svi NULL; jedino jovica id13→74). Fix = UPDATE users na produ (mapiranje po imenu iz `workers`, uz potvrdu) — isti fix odblokira i „Preuzmi izradu" (traži vezanog radnika) i notifikacije (inbox po worker_id). |
| 2 | Dorada/škart inicira SAMO kontrola; tehnolozi (svi) lansiraju novi RN po doradi/škartu | 🏗️ | Dugme „Dorada/Škart" na RN kartici danas nije ograničeno na kontrolore. Predlog: gate akcije na kontrolor-put (paritet A-5 finalne kontrole), a za tehnologe tok „novi RN po doradi/škartu" (klon sa vezom na izvorni RN — postoji `Prepiši isti postupak`/clone-variant kao osnova; dodati referencu porekla radi praćenja od sečenja). Traži kratku spec odluku o statusima izvornog RN-a. |
| 3 | U primopredaji uvid u crtež (PDF) | 🔧 | Backend već ima `GET /pdm/drawings/:id/pdf/content` i print-bundle. Dodati pregled PDF-a po stavci u handover-detail (i na nacrtu) — dugme/inline viewer, bez novih endpointa. |
| 4 | Statusi pozicije kroz ceo tok (U PROJEKTOVANJU → … → ZAVRŠEN NA LOKACIJI, 8 koraka) | 📐 | Jedinstvena IZVEDENA statusna mapa preko postojećih izvora: drawing State → nacrt status → primopredaja 0/1/2/3 → RN/TP → kucanja → lokacija. NE uvoditi novu status kolonu — derived view + jedan ekran „Tok pozicije". Preseca se sa integracijom lokacija (3.0) i P5 cutover-om; zaseban spec pre gradnje. Trenutni bedževi (PREDAT/ODOBRENO/ZA PRIMOPREDAJU/U OBRADI/LANSIRAN/SAGLASAN) ostaju kao sirovi statusi ispod mape. |
| 5 | Završene pozicije: dodati lokaciju | 🏗️ | Kolona „Lokacija" u Završeni nalozi — join na lokacije delova (part-locations postoji read-only). Zavisi od kvaliteta legacy lokacijskih podataka; malo ako su podaci upotrebljivi. |
| 6a | Realizacija: kolona „Tehnolog" pogrešna | 🐛 | POTVRĐENO: frontend `tech-processes/page.tsx` header „Tehnolog" renderuje `r.worker` = radnik koji je KUCAO red (tech_processes.worker_id), ne autora TP-a. Fix: preimenovati kolonu u „Radnik" + dodati pravu kolonu Tehnolog iz `work_orders.worker_id` (batch-resolve u list endpointu). |
| 6b | „Praćenje i planiranje proizvodnje" kao modul u PROIZVODNJA; izbaciti Realizaciju iz tehnologije | 📐 | Nav sekcija „Proizvodnja" već postoji (Realizacija je u njoj); NOVI modul planiranja = 3.0 tema (2.0 ceo postaje modul „Tehnologija" u 3.0 — preraspodela modula se radi tamo). Zabeležiti kao 3.0 zahtev. |
| 7 | CAM Programiranje modul (lista pozicija za CAM + cekiranje „završen" sa auditom po loginu) | 🏗️ | Osnova postoji: CAM prioritet inline endpoint + odluka o `cnc_programs` tabeli (ODLUKE #8). Novi ekran „CAM lista" + polje završeno/ko/kada (JWT workerId). Kandidat za sledeći talas. |
| 8 | Evidencija RN mobilni modul za radnike; izbaciti kucanje/kontrola (pogon) iz tehnologije | 📐 | Mobilni unos = Faza 2 (ODLUKE #18; priprema urađena: čist REST/JWT + telefon-čitljiv RNZ). Preraspodela pogonskih ekrana = 3.0 modul struktura, uz 6b. |
| 9 | Pod Primopredaje: pregled crteža „na pisanju tehnologije" + filter/brojači po tehnologu i predmetu | 🔧/🏗️ | Direktno nadovezivanje na razdvojeni `/handovers`: `technologistId` filter već postoji (P0/P1); dodati tab/pregled „Na pisanju" (SAGLASAN sa dodeljenim tehnologom, pre lansiranja) + agregat broj crteža po tehnologu / po predmetu. |
| 10 | Status HITNO pri slanju tehnolozima, vidljiv i na TP (danas crvene nalepnice) | 🔧 | Polje `is_urgent` na `drawing_handovers`, postavlja se pri approve (Miljan/Jovica od 12.07 imaju `primopredaje.approve` — poklapa se sa tokom), badge u Primopredaje + TP kartici + RN štampi. Migracija + DTO + UI bedž. |

## Predlog paketa (za potvrdu pre rada)

- **Paket A — quick winovi:** 1 (data fix `users.worker_id` na produ), 6a (kolona Radnik/Tehnolog),
  3 (PDF uvid u primopredaji), 10 (HITNO), 9 (pregled „Na pisanju" + brojači).
- **Paket B — sledeći talas:** 2 (dorada/škart tok sa poreklom RN-a), 5 (lokacija u završenim), 7 (CAM ekran).
- **Paket C — spec/3.0:** 4 (izvedena statusna mapa pozicije — zaseban spec), 6b + 8 (reorganizacija
  modula Proizvodnja + mobilni).

Odluke se, kad padnu, upisuju u [ODLUKE.md](../ODLUKE.md).
