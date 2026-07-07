# ServoSync — master plan modula (2.0 → 4.0)

> Kompletan katalog svih modula ka jedinstvenoj ERP/MES platformi, sa izvorom, zavisnostima i „šta
> pripremiti sada". Cilj: da svaki modul koji gradimo danas bude spreman da primi ono što dolazi kasnije.
> Izvor procena: [ROADMAP.md](../ROADMAP.md), [migration/00–07](../migration/), reverse-eng BigBit-a
> (SEF: [07](../migration/07-bigbit-sef-efaktura.md)). Presuda o sadržaju modula: Negovan/Nesa (§11).

## 0. Kako čitati

- **Faza:** kad modul realno nastaje (2.0 proizvodnja → 3.0 operativa iz 1.0 → 4.0 BigBit komercijala).
- **Izvor:** odakle dolazi logika/podaci (QBigTehn / ServoSync-native / 1.0 Supabase / BigBit).
- **Vlasništvo:** da li ServoSync piše (owner) ili samo čita (cache — [BACKEND_RULES §3](../BACKEND_RULES.md)).
- **Pripremiti sada:** šta u temelju (šema, auth, sync, common sloj) mora da postoji da modul kasnije „legne".

---

## 1. Presečni (cross-cutting) — temelj za sve module

Ovo nisu domenski moduli nego infrastruktura koju SVAKI modul koristi. Gradi se rano, jednom.

| Modul | Faza | Status | Pripremiti sada |
|---|---|---|---|
| **Auth (JWT)** | 2.0 | ✅ login + guard | refresh rotacija (§7); zatvoreno |
| **RBAC** (role, permisije, scope) | 2.0→V2 | 🟡 no-op guard | katalog permisija iz [RBAC_RLS_PREDLOG](RBAC_RLS_PREDLOG.md); aktivacija kad 2–3 modula žive |
| **API konvencije** (`/api/v1`, envelope, greške) | 2.0 | 🟡 | `enableVersioning` PRE prvog domenskog endpointa |
| **Audit log** (interceptor) | 2.0 | ⬜ | tabela postoji; interceptor uz prvi domenski modul |
| **Sync framework** (`SourceConnector`, log/state) | 2.0 | ✅ generički | dodati konektore: BigBit, PDM (vidi §5) |
| **Notifikacije/outbox** (email, kasnije push) | 3.0 | ⬜ | 1.0 ima obrazac (12 edge fn); NestJS scheduler + outbox tabela |
| **Storage** (fajlovi/PDF) | 2.0 | ⬜ | MinIO/S3; PDM crteži i RN prilozi ga traže prvi |
| **Izveštaji** (PDF/print engine) | 2.0 | ⬜ | RN, TP, primopredaje traže štampu; jedan servis za sve |

---

## 2. Faza 2.0 — proizvodni core (QBigTehn → ServoSync, u toku)

Sve su **ServoSync vlasništvo** (QBigTehn MSSQL sync je privremen seed, pa se gasi).

| Modul | Ključne tabele | Zavisi od | Napomena / pripremiti |
|---|---|---|---|
| **Tehnologija (TP)** ⭐ pilot | `tech_processes`, `tech_process_documents`, `work_order_operations`, `operations`, `machine_access` | Auth, RBAC, Strukture | Read-only prvo (bez §11 blokade); mutacije po RBAC predlogu; razmotriti `cnc_programs` tabelu |
| **Radni nalozi (RN)** | `work_orders` + komponente, `work_order_launches`, `work_order_approvals` | TP, PDM, Strukture | lansiranje/odobravanje = rola × `Worker.definesLaunch/Approval` |
| **PDM / Crteži / BOM** | `drawings`, `drawing_components`, `drawing_assemblies`, `drawing_pdfs`, `drawing_import_log` | Storage, Sync-C (PDM) | BOM = adjacency list; XML uvoz iz SolidWorks (vidi §5) |
| **Nacrti** | `handover_drafts` + stavke/statusi | PDM, Strukture | projektant kreira; veže crtež ↔ predmet |
| **Primopredaje** | `drawing_handovers`, `handover_statuses` | Nacrti, RBAC | kvalitet/kontrola tok |
| **Lokacije delova** | `part_locations`, `positions` | Strukture | 1.0 ima svoju verziju (Lokacije) — uskladiti u 3.0 |
| **Proizvodne strukture** | `workers`, `worker_types`, `operations`, `work_units`, `machine_access` | Auth (`User.workerId` FK) | temelj RBAC-a proizvodnje; seed iz QBigTehn |
| **MRP / Nabavka (uvid)** | `mrp_*` | BOM, artikli (BigBit) | **§11.3**: BOM/MRP procedure → `WITH RECURSIVE` + anti-ciklus guard |
| **Komitenti / Predmeti (pregled)** | `customers`, `projects` | Sync-B (BigBit) | read-only cache; puni ih `bigbit-sync` |

---

## 3. Faza 3.0 — operativni moduli (iz ServoSync 1.0 / Supabase)

Prelaze sa Supabase na NestJS+Next, modul po modul (strangler-fig). **Autorizacija je najteži deo**
(293+ RLS → guardovi). UI uglavnom preživljava; menja se data-access sloj.

| Modul | 1.0 obim | Vlasništvo | Napomena / pripremiti |
|---|---|---|---|
| **Kadrovska (HR)** | najveći, PII, zarade | owner | scope po pododeljenju; PII guard; zarade samo ADMIN; `zaposleni` = izvor istine (sync ka 2.0 `workers`) |
| **Održavanje (CMMS)** | radni nalozi mašina, incidenti, vozila, IT | owner | **odvojen role sistem** (operator/technician/chief) → mapirati u RBAC katalog |
| **Reversi** | alati, sečiva, izdavanje/vraćanje | owner | transakcioni RPC (inventar) → NestJS servis u transakciji |
| **Sastanci** | zapisnici, akcioni plan, teme | owner | participant-scoped RLS; storage (arhiva PDF) |
| **Plan montaže** | projekti, faze, work packages | owner | per-projekat scope (`has_edit_role`) |
| **Plan proizvodnje** | overlay nad proizvodnjom | owner | veže se na 2.0 RN/proizvodnju |
| **Praćenje proizvodnje** | uživo unos rada (realtime) | owner | ⚠️ nije u RBAC_MATRIX — dinamičke politike; realtime → WS/LISTEN-NOTIFY |
| **Projektni biro (PB)** | zadaci, izveštaji rada, saveti | owner | role `inzenjer`/`projektant_vodja` |
| **Štampa nalepnica** | `labels` | owner | veže se na Izveštaje/print servis |
| **SCADA / Energetika** | očitavanja, PLC komande | owner | ⚠️ nije u RBAC_MATRIX; safety sloj za komande; specifičan hardware |
| **Moj profil / Podešavanja** | RBAC admin, org profil | owner | mesto gde se admin-ira RBAC iz §1 |

---

## 4. Faza 4.0 — BigBit komercijala / kompletan ERP

**Tempo: trigger-based, bez roka** (PDV/knjigovodstvo rizik — [ROADMAP 4.0](../ROADMAP.md)). Do tada
BigBit ostaje živ (na SQL-u — varijanta B). Domeni koji se rebuild-uju iz BigBit-a:

| Modul | BigBit izvor | Kritičnost | Napomena / pripremiti |
|---|---|---|---|
| **Komitenti / Artikli (master)** | `Komitenti`, `R_Artikli` | temelj | do 4.0 su cache (Sync-B); u 4.0 postaju **vlasništvo** — prelaz je preimenovanje vlasnika, ne migracija |
| **Cenovnik** | `Cenovnik`, `R_Tarife` | srednja | veže artikle |
| **Magacin / Robna dokumenta** | `T_Robna dokumenta/stavke` | visoka | kartice, nivelacija, popis, KEPU; mirror mehanizam ([06](../migration/06-bigbit-preuzmi-iz-bb.md)) |
| **Fakturisanje (izlazne)** | fakture, avansi | visoka | UBL builder (vidi SEF) |
| **SEF eFaktura** ⭐ | `OnLine_BigBit_APL` | **regulatorno** | endpointi + UBL mapiranje već rekonstruisani ([07](../migration/07-bigbit-sef-efaktura.md)); `sef_outbox`/`sef_inbox`, statusi, polling cron |
| **Glavna knjiga (GK)** | kontni plan, nalozi | **kritični put** | dvojno knjigovodstvo; jedan koherentan domen, jedan vlasnik; automatska knjiženja iz magacina/faktura |
| **PDV / POPDV** | evidencije, obračun | **regulatorno** | zavisi od faktura + GK |
| **Banke / izvodi** | izvodi, kompenzacije | srednja | uvoz izvoda (formati banaka) |
| **Obračun poreza / avansi** | `Obracun poreza`, avansi | visoka | UBL avansne reference (`BillingReference`) |
| **Kasa / POS / fiskalizacija** | `StartKasa` | **uslovna** | ⚠️ SAMO ako se koristi — LPFR/ESIR sertifikacija; potvrditi scope! |
| **Finansijski izveštaji** | 496 izveštaja BigBit + 2.412 upita | visoka | **trijaža na top ~30**, ne svi |
| **BEX otprema** | `api.bex.rs` | niska | kurirska integracija; zaseban mali modul |

---

## 5. Integracioni konektori (sync) — poseban trak

Tri izvora, tri konektora nad istim framework-om ([BACKEND_RULES §3, §11.2](../BACKEND_RULES.md)):

| Konektor | Izvor | Trajanje | Mehanizam | Status |
|---|---|---|---|---|
| **QBigTehn** | MSSQL `vasa-SQL:5765` | privremen (do cutover-a) | postojeći `mssql` klijent, full/incremental | ✅ 62 entiteta |
| **BigBit** | Access `.MDB` → (preferirano) SQL Server | do 4.0 | var. B: `mssql` + inkrementalno · var. A: XML/CSV export + UPSERT | ⬜ pripremiti; mapiranje kolona u [06](../migration/06-bigbit-preuzmi-iz-bb.md) |
| **PDM** | SolidWorks MS SQL | trajan | XML ugovor (`PDMXMLParser` model) + automatizacija | ⬜ šema spremna (`drawing_import_log`) |

---

## 6. Redosled pripreme (šta raditi kada)

1. **Sada (temelj):** dovršiti Auth (refresh), `/api/v1`, no-op RBAC guardove + katalog permisija,
   audit interceptor, Storage i Izveštaj servis (jer PDM/RN prvi traže). → sve iz §1.
2. **Pilot 2.0:** Tehnologija read-only → RN read-only → pa mutacije po RBAC odluci.
3. **Ostatak 2.0** po zavisnostima (§2), paralelno `bigbit-sync` (var. B čim BigBit pređe na SQL).
4. **3.0** strangler-fig: prvo auth/RBAC paritet, pa pilot modul (Reversi ili Lokacije), pa ostali (§3).
5. **4.0** kad trigeri sazru: GK je kritični put, SEF je regulatorni, POS samo ako treba (§4).

## 7. Za sastanak (šta blokira pripremu)

- **§11 odluke** (Negovan/Nesa): cache/overlay obim, BigBit izvor (var. A/B/C), BOM/MRP procedure, PDM XML/SQL.
- **RBAC 6 pitanja** (obim ŠEF, CNC potpis, `cnc_programs`, RLS, MENADZMENT, imenovanje).
- **4.0 scope potvrde:** da li se POS/fiskalizacija uopšte koristi; koliko izveštaja je stvarno kritično;
  ceo katalog artikala ili samo korišćeni.
- Agenda: [AGENDA-sastanak-odluke.html](AGENDA-sastanak-odluke.html).
