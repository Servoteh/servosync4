# KONSOLIDOVANA OTVORENA PITANJA — talasi B–F (spec faza, 12.07.2026)

**Svrha:** Nenad presuđuje u JEDNOM prolazu. Svako pitanje ima predlog — odgovor
„**VAŽE PREDLOZI**" prihvata sve; izuzeci se navode po broju (npr. „važe osim C3, E2").
Puni kontekst svakog pitanja: §7 odgovarajućeg MODULE_SPEC-a.

**Status specova:** B, C, D, E, F ✅ gotovi (spec + authz snapshot). **G (Kadrovska)
NIJE rađen** — agent zaustavljen; sačuvani su fn-snapshot (119 fn) + radna beleška
(`authz-snapshots/talasG-pozadina-analiza-2026-07-12.md`: pozadinska infra, auth
gate-ovi, mobilna površina, UI inventar 15 tabova). Vidi G0 na dnu.

---

## H. Harmonizacija (glavna sesija — ukršteni review 6 specova)

- **H1 — kanon permission ključeva:** `modul.akcija`, moduli: `lokacije` `sastanci`
  `ai` `montaza` `pracenje` `pb` `kadrovska` `energetika` `odrzavanje` `reversi`.
  **Sudar:** D-ov override ključ `plan_montaze.write` (deny za `plan_montaze_readonly`)
  ≠ C-ov modulski `montaza.edit`. **Predlog:** override cilja ISTI ključ koji grantuje →
  `montaza.edit`=deny; ključ `plan_montaze.write` se ne uvodi.
- **H2 — `kadrovska.access` → `kadrovska.read`:** D-ov override ključ uskladiti sa
  read/edit/manage/admin kanonom; G spec (kad bude rađen) definiše pun skup, D koristi
  `kadrovska.read` (grant) i `kadrovska.contracts_read` (deny) od starta.
- **H3 — deljeni STT/AI-refine servis:** B predlaže NestJS `/ai/stt` + `/ai/refine`
  u SVOM talasu (~1 dan); C eksplicitno NE seli nego čeka B. Konzistentno — potvrditi
  da B nosi, C/D/G reuse-uju. AI pozivi (ai-chat B, sastanci-ai-summary B,
  montaza-izvestaj-ai C) dele isti BE obrazac i ANTHROPIC ključ u env.
- **H4 — `energetika.*` a ne `scada.*`** (E-P5): korisničko ime modula; potvrđeno
  i sekcija nav-a „Oprema i energija" za E i F (poklapa se sa PLAN_MODULA domenima).

## B. Sastanci + AI asistent (10)

1. Edge `ai-chat` → **port u NestJS** (22 RPC alata netaknuti kroz GUC; edge živ za 1.0 do preklopa).
2. Edge `sastanci-ai-summary` → **port u NestJS** (model iz `sastanci_ai_settings`).
3. RSVP + dispatch + pg_cron → **ostaju u sy15/edge** (pozadina; 2.0 samo čita outbox).
4. STT + ✨refine za 2.0 FE → **zajednički NestJS `media/ai` servis u talasu B** (vidi H3).
5. PDF zapisnika → **klijentski jsPDF ostaje** (port lib-a), upload kroz BE; bez server-rendera.
6. `sastanci.read` širina → **paritet 1.0 front gate-a** (operativne role ne vide modul; DB row-nivo netaknut).
7. Orphan trigeri `sast_trg_akcija_new/changed` (mejl za akcije nikad zakačen) → **NE dirati**, backlog.
8. Bulk replace učesnika (briše RSVP + regeneriše token) → **zadržati identično**.
9. `admin_rang`/`za_razmatranje` → **paritet fronta** (samo admin vidi dugmad); DB širinu ne dirati.
10. `sastanci_notification_log` INSERT → **ne izlagati kroz 2.0 API** (enqueue samo kroz DEFINER RPC).

## C. Plan montaže + Plan proizvodnje + Praćenje (11)

1. ⚠️ **tim_lider edit Plana montaže je FANTOMSKI u 1.0** (front pušta, RLS ne — izmene žive samo u localStorage!) → **predlog: u 2.0 dati PRAVI edit** (dodela `montaza.edit` + proširenje `has_edit_role()` za tim_lider; dokumentovano odstupanje „bag-by-omission").
2. `has_edit_role` širi od fronta (hr, poslovni_admin) → **paritet: DB ostaje, UI dodela bez njih**.
3. Pogon ne može da otvori PDF crteža (`can_read_production_drawings`) → **v1 strogi paritet**; follow-up odluka za `cnc_operater` (možda namerno — crteži su IP).
4. Export-log Praćenja nikad nije radio → **2.0 loguje server-side** (funkcija prvi put proradi).
5. Istorija aktivnosti: audit deo admin-only → **paritet**.
6. Edge `montaza-izvestaj-ai` → **port u NestJS odmah** (uskladiti sa B obrascem).
7. STT/ai-refine → **C ne seli, čeka B** (H3).
8. N+1 load Plana montaže (35+ upita) → **jedan BE join upit** (perf odstupanje, semantika ista).
9. `bigtehn_*` MOST → **potvrda**: v1 čita iste keš tabele iz sy15; repoint na `tech_processes` = uz QBigTehn cutover, van talasa.
10. Podešavanje predmeta + ⭐prioritet → **BE endpointi u C (`pracenje.manage`), UI ekran u D**.
11. Pretraga delova → **tab unutar `/pracenje-proizvodnje`**, stara ruta redirect.

## D. Projektni biro + Moj profil + Podešavanja/RBAC (11)

1. Nalozi tokom paralelnog rada → **2.0 postaje master** (piše u sy15 GoTrue + `user_roles` I u 2.0; smer samo 2.0→1.0).
2. Kanonski override ključevi → **`montaza.edit`=deny / `kadrovska.read`=grant / `kadrovska.contracts_read`=deny** (harmonizovano H1/H2).
3. `must_change_password` → **dodati boolean + force-change ekran u 2.0 auth**.
4. Tabovi Mašine + Održ. profili → **NE u D** — ostaju u 1.0 do Talasa F (F-2 kaže: ekran u 2.0 CMMS Podešavanjima).
5. Passkeys sekcija → **NE seliti** (mrtvi posle 1.5; ide uz 2.0 auth roadmap).
6. Moj profil → **CEO u D** (agregator kroz GUC; G kasnije nasleđuje iste objekte; uslov: G ne menja potpise deljenih RPC).
7. `pb.*` dodele za `inzenjer`/`projektant_vodja` + `hr`/`poslovni_admin` dobijaju `pb.edit` → **da, uz R1** (pravilo firme, ne sužavati).
8. Asimetrija prioriteta rola DB vs FE → **2.0 guard = UNION permisija svih uloga** (asimetrija nestaje po konstrukciji; DB fn se ne dira).
9. `predmet_aktivacija` ekran → **ekran+API u D, C konzumira flag** (⚠️ C10 kaže BE u C, UI u D — **presuda potrebna: predlog glavne sesije = C10 varijanta**, BE uz ostale pracenje endpointe, D veže UI).
10. Audit → **NE stapati**: jedan ekran, dva izvora (sy15 `audit_log` + 2.0 AuditLog); konsolidacija u finalnom 3.0.
11. Matrica „Uloge i dozvole" → **živ katalog za 2.0 module + označen legacy blok** za neseljene.

## E. Energetika/SCADA (8)

1. HMI statika → **kopija `public/scada-hmi/` u 2.0 front** (izvor istine = 1.0 repo).
2. Touch prikaz → **port odmah u v1** (parity gate traži mobilni; iframe na telefonu ne prolazi).
3. Komandni transport → **poll (paritet)**, ne SSE.
4. `serverNow` u snapshot odgovoru → **DA** (aditivno, 1.0 algoritam ostaje fallback).
5. Ključevi → **`energetika.*`** (H4).
6. `scada_notify_prefs` UI → **NE u v1**.
7. Push URL `/m/energetika` → **NE dirati** (1.0 Capacitor telefoni).
8. pg_cron/pg_net živost na sy15 (watchdog, push triger) → **obavezna R0 provera**; ako fali → infra task pre talasa.

## F. Održavanje/CMMS (8)

1. ⚠️ **Notif dispatch je MRTAV na produ** (RPC-ovi ne postoje, nema schedulera, 30 queued od aprila) → **seliti samo paritet** (log+retry+rules); oživljavanje = post-seoba zadatak.
2. Admin maint profila → **jedan ekran u 2.0 CMMS Podešavanjima**; D linkuje (poklapa se sa D4).
3. Foto na incident tiho pada za obične prijavioce → **2.0 koristi postojeći `maint_attach_incident_files` RPC** (dokumentovano odstupanje koje popravlja gubitak fotografija).
4. Storage → **BE proxy** (GUC provera prava nad meta-redom → service kredencijal; putanje 1.0-kompatibilne).
5. `maint_facility_type_lookup` ne postoji → **paritet fallback** (endpoint vraća `[]`); migraciju NE primenjivati.
6. INSERT incidenta bez SELECT vidljivosti → **BE tretira kao uspeh (201 + id)**; RLS se ne širi.
7. Operator/technician scope bez živih korisnika → **preneti netaknuto + sintetički e2e**.
8. Nav → **`odrzavanje.read`+`odrzavanje.report` za sve aktivne uloge**, sekcija „Oprema i energija".

## G0. Kadrovska — kako dalje?

Spec-agent je zaustavljen pre pisanja MODULE_SPEC-a. Sačuvano: kompletan fn snapshot
(119 fn) + radna beleška (infra/gate-ovi/mobilno/UI inventar 15 tabova) — **~70% analize
postoji**, fali sinteza u spec (politike+parity matrica+R-faze+pitanja).
**Predlog:** relansirati G spec-agenta SA sačuvanim materijalom kao ulazom (kraći posao),
tek kad krene priprema Talasa G (poslednji u redosledu) — ne blokira B–F izvršavanje.

---

## Izmerene procene (zamenjuju grube iz PROCENA_SEOBE_MODULA_3.0)

| Talas | Gruba (pre) | Izmerena (spec) | Napomena |
|---|---|---|---|
| B Sastanci+AI | 2,5–4 | **2,5–4 MN** | AI asistent veći deo nego što se mislilo (0,75–1) |
| C Planovi+Praćenje | 5–8 | **4,5–6,5 MN** | „format() politike" uniformne — sniženo |
| D PB+Profil+Podešavanja | 6–8,5 | **6–8 MN** | težište pomereno sa PB na RBAC konzolu |
| E SCADA | 2–3 | **1,5–2,5 MN** | authz minimalan; trošak = FE mehanika |
| F Održavanje | 4–6 | **5–6,5 MN** | korekcija naviše: 23 FE sekcije |
| **Σ B–F** | | **≈ 19,5–27,5 MN** | + A (Lokacije, u toku) + G (Kadrovska, spec pending) |
