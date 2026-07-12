# Komentari tehnologije na 2.0 — trijaža + status (2026-07-12)

Izvor: `Komentari tehnologija V2.0.pdf` (Miljan — „meni i Jovici" u t.10; PDF u ovom folderu).
Trijaža ukrštena sa stanjem koda na dan 12.07.2026 (posle ODLUKE #33 — razdvajanje
Nacrti `/nacrti` / Primopredaje `/handovers` + `primopredaje.approve` za tehnolog/menadžment).

> **STATUS 12.07.2026:** Paket A (t.1/3/6a/9/10) i Paket B (t.2/5/7) **ISPORUČENI i verifikovani
> na produkciji** (ODLUKE #34/#35). **Paket C (t.4, t.6b, t.8) je NAMERNO ODLOŽEN za posle 3.0
> migracije** — sve tri tačke se preklapaju sa 3.0 preraspodelom modula / integracijom lokacija /
> mobilnom aplikacijom, pa bi rad sada stvorio konflikte sa 3.0 rewrite-om. Opis u
> [ROADMAP.md §3.0](../ROADMAP.md). Ovaj dokument je izvor istine statusa Miljanovog feedback-a.

Status legenda: ✅ već postoji · 🐛 potvrđen bug · 🔧 mali zahvat · 🏗️ srednji · 📐 arhitektura/3.0.
Realizacija: **A** = isporučeno (Paket A) · **B** = isporučeno (Paket B) · **⏸ 3.0** = odloženo za 3.0.

| # | Komentar | Trijaža | Status | Nalaz / šta je urađeno |
|---|---|---|---|---|
| 1 | Ne upisuje tehnologa pri novom RN („može po loginu") | ✅ + **data fix** | **✅ A** | Backend je VEĆ default-ovao na login; uzrok je bio nevezan `users.worker_id`. **Urađeno:** vezani na produ (Miljan→13, Nikola→43, Aleksandar→77, Stefan→181, Dragan→2226; ODLUKE #34). Odblokiralo i „Preuzmi izradu" + notifikacije. |
| 2 | Dorada/škart inicira SAMO kontrola; tehnolozi (svi) lansiraju novi RN po doradi/škartu | 🏗️ | **✅ B** | Role su bile ispravne (kontrola inicira kvalitet na kiosku, tehnolozi lansiraju rework iza `rn.write`). **Urađeno (ODLUKE #35):** strukturisano poreklo `work_orders.parent_work_order_id` — `rework()` upisuje izvorni RN; kartica prikazuje izvor + dorada/škart decu; filter „Samo dorada/škart". Workflow role NEPROMENJENE. |
| 3 | U primopredaji uvid u crtež (PDF) | 🔧 | **✅ A** | **Urađeno:** dugme „PDF crteža" u detalju primopredaje (reuse `GET /pdm/drawings/:id/pdf/content` kroz autentifikovani blob). |
| 4 | Statusi pozicije kroz ceo tok (U PROJEKTOVANJU → … → ZAVRŠEN NA LOKACIJI, 8 koraka) | 📐 | **⏸ 3.0** | Jedinstvena IZVEDENA statusna mapa preko postojećih izvora (drawing State → nacrt → primopredaja 0/1/2/3 → RN/TP → kucanja → lokacija). **ODLOŽENO za 3.0** — preseca ceo lifecycle kroz module (PB/projektovanje → tehnologija → proizvodnja → lokacije) i integraciju lokacija koja je 3.0 tema; radeći sada bi se kosilo sa 3.0 rewrite-om. Detalj: [ROADMAP §3.0](../ROADMAP.md). |
| 5 | Završene pozicije: dodati lokaciju | 🏗️ | **✅ B** | **Urađeno:** kolona „Lokacija" na /completed-orders (neto iz `part_locations` ledgera, SUM po poziciji, batch-resolve u work-orders list). |
| 6a | Realizacija: kolona „Tehnolog" pogrešna | 🐛 | **✅ A** | **Urađeno:** kolona koja je prikazivala radnika koji je kucao preimenovana u „Radnik" + prava kolona „Tehnolog" (RN `worker_id`, batch-resolve). |
| 6b | „Praćenje i planiranje proizvodnje" kao modul u PROIZVODNJA; izbaciti Realizaciju iz tehnologije | 📐 | **⏸ 3.0** | NOVI modul planiranja + preraspodela ekrana. **ODLOŽENO za 3.0** — ceo 2.0 postaje modul „Tehnologija" u 3.0 i tada se moduli preraspodeljuju; raditi sada = dupli posao + konflikt sa 3.0 reorg. Detalj: [ROADMAP §3.0](../ROADMAP.md). |
| 7 | CAM Programiranje modul (lista pozicija za CAM + cekiranje „završen" sa auditom po loginu) | 🏗️ | **✅ B** | **Urađeno (ODLUKE #35):** nova tabela `cnc_programs` + modul `cnc-programs`, ekran „CAM programiranje" (pozicije sa `operations.usesPriority=true`), inline checkbox „CAM završen" sa auditom ko/kada iz JWT-a; gate `tehnologija.read/write`. |
| 8 | Evidencija RN mobilni modul za radnike; izbaciti kucanje/kontrola (pogon) iz tehnologije | 📐 | **⏸ 3.0 (delom ✅)** | Pogonski ekrani su VEĆ premešteni u 1.0 HUB (ODLUKE #33 nastavak — pločice „Kucanje/Kontrola (pogon)", sidebar stavke uklonjene). **Mobilni „Evidencija RN" za radnike ODLOŽEN za 3.0** — mobilna aplikacija (Capacitor) se prerađuje u 3.0 (ODLUKE #18, Faza 2); priprema postoji (čist REST/JWT + telefon-čitljiv RNZ). Detalj: [ROADMAP §3.0](../ROADMAP.md). |
| 9 | Pod Primopredaje: pregled crteža „na pisanju tehnologije" + filter/brojači po tehnologu i predmetu | 🔧/🏗️ | **✅ A** | **Urađeno:** tab „Na pisanju" na /handovers + `GET /handovers/writing-stats` (brojači po tehnologu / po predmetu). |
| 10 | Status HITNO pri slanju tehnolozima, vidljiv i na TP (danas crvene nalepnice) | 🔧 | **✅ A** | **Urađeno (ODLUKE #34):** `drawing_handovers.is_urgent`, checkbox pri approve, badge u listama/detalju/TP kartici + crveni „HITNO" na RN štampi (menja fizičke nalepnice). |

## Status realizacije (12.07.2026)

- **Paket A — ISPORUČEN** (ODLUKE #34, backend `33d86df` + frontend `af0632e`): t.1 (worker_id vezani),
  t.6a (Radnik/Tehnolog kolone), t.3 (PDF uvid), t.10 (HITNO), t.9 (tab „Na pisanju" + writing-stats).
- **Paket B — ISPORUČEN** (ODLUKE #35, backend `4760bd5` + frontend `c239310`): t.2 (poreklo dorada/škart
  RN-a `parent_work_order_id`), t.5 (lokacija u završenim), t.7 (CAM modul `cnc_programs`).
- **Paket C — ODLOŽEN ZA POSLE 3.0 MIGRACIJE** (odluka Nenad 12.07 — izbeći konflikte sa 3.0 rewrite-om):
  t.4 (izvedena statusna mapa pozicije kroz ceo lifecycle), t.6b (modul „Praćenje i planiranje" +
  preraspodela ekrana), t.8-mobilni (Evidencija RN mobilni). Opisani kao 3.0 zahtevi u
  [ROADMAP.md §3.0 „Zahtevi tehnologije (Miljan) za 3.0"](../ROADMAP.md). **Ne implementirati u 2.0.**

Odluke se, kad padnu, upisuju u [ODLUKE.md](../ODLUKE.md).
