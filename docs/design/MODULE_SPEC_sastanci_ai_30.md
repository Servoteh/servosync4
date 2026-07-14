# Module Spec: Sastanci + AI asistent — 3.0 TALAS B

| | |
|---|---|
| **Moduli (grupa)** | 1.0 „Sastanci" (sedmični/projektni/tematski/dnevni, zapisnik, akcioni plan, PM teme, RSVP, mejl obaveštenja) + 1.0 „AI asistent" (multi-engine chat sa 18 alata) — domen **Saradnja** |
| **Verzija spec** | 1.0 (2026-07-12) |
| **Faza** | 3.0-B/C — Talas B (izvršava se posle Talasa A) |
| **Izvor** | 1.0 ŽIVI kod (9 servisa ~2.5k LOC + `src/ui/sastanci/` 7.7k + `aiAsistent/` 0.5k + mobilni `mySastanci`/`myAi` ~1k + 4 edge fn) + živi DB (snimljeno 12.07) |
| **Authz snapshot** | [`authz-snapshots/talasB-fn-defs-2026-07-12.sql`](authz-snapshots/talasB-fn-defs-2026-07-12.sql) (62 fn + 2 view-a) |
| **Doktrina** | [`MIGRACIONA_DOKTRINA_3.0.md`](MIGRACIONA_DOKTRINA_3.0.md) — VAŽI U CELOSTI |
| **Status** | NACRT — čeka Nenadov review (§7 odluke) |

> Talas-činjenice su potvrđene i PROŠIRENE merenjem: AI asistent NIJE „mali edge proxy" —
> edge `ai-chat` nosi **18 alata → 22 `ai_chat_*` RPC-a** koji čitaju Kadrovsku, Održavanje,
> PB i Plan montaže **SA JWT-om KORISNIKA** (scope presuđuje baza). To je najveći pojedinačni
> port ovog talasa. Sastanci su čist „standardni" modul (REST CRUD + 13 front RPC + trigeri).

## 0. Obim — šta se SELI, šta NE (FRONT vs POZADINA)

Od 62 fn u snapshotu front zove **13**, edge `ai-chat` (kao korisnik) **22**, ostatak (27) je
pozadina koja se NE seli.

**SELI SE (korisnička površina):**
- **Sastanci read**: liste + filteri (REST nad `sastanci`, `v_akcioni_plan`, `pm_teme`/`v_pm_teme_pregled`,
  `sastanak_*`, `presek_*`), detalj sastanka (učesnici, zapisnik-tačke, slike, odluke, arhiva, counts),
  globalna pretraga, dashboard brojke, kalendar/week view.
- **Sastanci write** (REST uz RLS kroz GUC): CRUD sastanaka/učesnika/tačaka/slika/odluka/akcija/tema/šablona;
  bulk replace učesnika; reorder (redosled tačaka, admin_rang tema); bulk status akcija; draft-teme tok.
- **Front RPC (13)**: `sast_zakljucaj_sastanak`, `sastanci_send_invites`, `sastanci_remind_unprepared`,
  `sastanci_resend_meeting_locked`, `sastanci_set_my_rsvp`, `sastanci_get_or_create_my_prefs`,
  `sast_weekly_status/pomeri/odlozi/vrati`, `get_sastanci_user_directory`, `set_sastanci_ai_model`, `ai_chat_ja`.
- **Storage**: `sastanci-arhiva` (PDF zapisnici, path `{sastanakId}/{ts}_zapisnik.pdf` — MORA ostati
  1.0-kompatibilan), `sastanak-slike` (foto uz tačke), `ai-chat-images` (vision prilozi) — sve preko
  sy15 storage-api presigned (Reversi obrazac).
- **PDF zapisnika**: klijentski jsPDF (`lib/sastanciPdf.js` 433 LOC — preview nacrta, regeneracija,
  prilog za mejl) → port na 2.0 FE.
- **AI asistent**: ceo UI (`/ai` + `/m/ai`), read istorije (RLS), **port edge `ai-chat` u NestJS**
  (ključevi u BE env; tool-use petlja u TS; 22 RPC alata se NE prepisuju — zovu se kroz GUC most
  sa identitetom korisnika) — vidi §7 P1.
- **AI rezime sastanka**: port edge `sastanci-ai-summary` u NestJS endpoint (trivijalan Claude proxy;
  model iz `sastanci_ai_settings`) — §7 P2.

**NE SELI SE (pozadina — ostaje u sy15/edge, 2.0 je ne dira):**
- **pg_cron (5 poslova)**: `sast_weekly_auto_create_a/b` (petak 6h+7h UTC → lokalni guard 08h Beograd,
  DST-otporno), `sast_action_reminders_daily` (07h), `sast_meeting_reminders_30min` (*/30),
  `sast_notify_dispatch_every_2_min` (*/2 → `pg_net` + vault secrets → edge dispatch).
- **Edge `sastanci-notify-dispatch` (+templates.ts, 8 kinds)**: Resend mejl worker — dequeue SKIP LOCKED,
  backoff 5min→6h (max 5), PDF zapisnik kao prilog, RSVP dugmad u pozivnici. Netaknut.
- **Edge `sastanci-rsvp`**: JAVNI magic-link (verify_jwt=false; token = jedina tajna; dvokoračna
  potvrda `c=1` protiv mejl skenera; HEAD ne mutira). Netaknut.
- **Edge `ai-embed-backfill`**: embedding worker za `ai_uputstva`. Netaknut.
- **Service-role RPC**: `sastanci_dispatch_dequeue/mark_sent/mark_failed`, `sastanci_enqueue_*`,
  `sast_auto_create_weekly`, `sast_create_weekly_at`, `sast_enqueue_cancel`, `sastanci_pulse_notify_dispatch`
  (grant SAMO service_role — izmereno).
- **Trigeri (ostaju u bazi)**: `sast_check_not_locked` (lock-guard na 7 tabela), `sast_notif_ucesnik_invite`
  (+cleanup), `sast_notif_meeting_locked`, `akcioni_plan_istorija_trg`, `sast_pm_teme_draft_status_guard`,
  `update_updated_at`.

**GRANIČNO / deljeno sa drugim modulima (popisano, odluka u §7):**
- Edge **`stt-transcribe`** (🎤 Whisper diktiranje — zapisnik, AI chat i JOŠ ~10 modula) i **`ai-refine`**
  (✨ doterivanje teksta) — presečna infra; 2.0 FE ne nosi 1.0 GoTrue JWT pa ih ne može zvati → §7 P4.
- `ai_masina_docs` (2 reda; RLS bez politika = service-role only) i maint/kadrovska/PB objekti koje
  alati čitaju — pripadaju talasima F/G/D; ovaj talas ih dira ISKLJUČIVO kroz postojeće DEFINER RPC-ove.
- `has_edit_role`, `current_user_is_management`, `current_user_is_hr_or_admin` — globalni helperi
  (koriste ih i drugi moduli) — ostaju u bazi, netaknuti.

## 1. Živi podaci i model (12.07)

| Tabela | Redova | Prisma model? | Napomena |
|---|---:|---|---|
| `sastanci` | 10 | ✅ | tip sedmicni/projektni/tematski/dnevni; status planiran/u_toku/zavrsen/zakljucan; organizator-trio kolone (vodio/zapisnicar/created_by su EMAIL + label SNAPSHOT imena); `pozivnice_poslate_at` |
| `sastanak_ucesnici` | 49 | ✅ | PK (sastanak_id,email); prisutan/pozvan/pripremljen/priprema; **`rsvp_token` uuid UNIQUE (tajna magic-linka — NE izlagati kroz API!)** + rsvp_status/rsvp_at |
| `presek_aktivnosti` | 7 | ✅ | tačke zapisnika; rb + redosled; `sadrzaj_html/text` (contenteditable + STT); `tema_id` = most teme→zapisnik (dedup) |
| `presek_slike` | 0 | ✅ | meta slika (storage `sastanak-slike`), caption, redosled |
| `sastanak_arhiva` | 5 | ✅ | UNIQUE(sastanak_id); JSONB snapshot (schemaVersion 2) + `zapisnik_storage_path/size/generated_at` |
| `sastanak_odluke` | 0 | ✅ | ⚖️ odluke; status na_snazi/opozvana; veza_tema_id/veza_akcija_id |
| `akcioni_plan` | 47 | ✅ | glavna tabela zadataka; odgovoran_email (kanon) + label (snapshot) + text (slobodno); zatvoren_* snapshot |
| `akcioni_plan_istorija` | 405 | ✅ (read) | AFTER UPDATE trigger piše diff po polju |
| `pm_teme` | 0 | ✅ | životni ciklus predlog→usvojeno/odbijeno/odlozeno/zatvoreno + `draft` tok; hitno/za_razmatranje/admin_rang |
| `sastanci_templates` + `_ucesnici` | 1+1 | ✅ | šabloni + cadence (none/daily/weekly/biweekly/monthly); instanciranje je KLIJENTSKA logika (`nextOccurrence`) → port u BE servis |
| `sastanci_notification_prefs` | 2 | ✅ | per-user opt-in/out po kind-u (email PK) |
| `sastanci_notification_log` | 58 | ✅ (read) | OUTBOX — piše ga pozadina; 2.0 samo čita (svoje / mgmt) |
| `sastanci_ai_settings` | 1 | — ($queryRaw) | singleton id=1; model za AI rezime; write SAMO kroz RPC |
| `sast_weekly_movers` / `sast_weekly_skip` | 2/0 | — ($queryRaw read) | ko sme da pomera sedmični (EMAIL lista!) / odložene nedelje |
| `ai_chat_conversations` | 26 | ✅ | scope personal/project; `project_ref` = projects.project_code; user_id = auth.users.id |
| `ai_chat_messages` | 117 | ✅ | role user/assistant; author_name; image_path; tokens_in/out, model |
| `ai_uputstva` | 173 | — (RPC-only) | baza uputstava (FTS + pgvector embedding); vidljivost svi/admin_hr |
| `ai_project_notes` | 0 | — (RPC-only) | beleške tima po projektu (alat dodaj_belesku) |
| `ai_masina_docs` | 2 | — | CMMS domen (talas F); ovde samo kroz DEFINER alat |

**Views (2)**: `v_akcioni_plan` (dodaje `effective_status` — 'kasni' ako rok prošao a otvoren/u_toku —
i `dana_do_roka`; UI čita ISKLJUČIVO view, piše u tabelu) i `v_pm_teme_pregled` (`visual_tag`).
Ostaju u bazi; 2.0 GET-ovi ih čitaju.
**PK = uuid, zadržava se.** Modeli se DODAJU u `prisma/sy15.prisma`. `embedding` (pgvector) kolone
se NE mapiraju u Prisma (RPC-only pristup).

## 2. Žive politike + authz model (55 public + 8 storage; snimljeno 12.07 — RE-VERIFIKOVATI na sy15 pre R1)

Obrazac je konzistentan (46 politika na 14 sast tabela + 2 weekly + 7 ai):

| Obrazac | Tabele | → 2.0 |
|---|---|---|
| SELECT `true` (svi prijavljeni) | sastanci, ucesnici, presek_*, arhiva, odluke, akcioni_plan (+istorija), templates (+ucesnici), weekly_movers/skip, ai_settings | `sastanci.read` |
| **Standardni write-scope**: `has_edit_role() AND (is_sastanak_ucesnik(sastanak_id) OR current_user_is_management() OR organizator-trio po email-u)` | ucesnici, presek_aktivnosti, presek_slike, arhiva I/U/D; akcioni_plan + pm_teme (uz: `sastanak_id IS NULL` → SAMO management) | `sastanci.edit` (guard) + **row-odluka OSTAJE u bazi kroz GUC** |
| sastanci INSERT `has_edit_role()`; UPDATE/DELETE `mgmt OR organizator-trio` (⚠️ bez has_edit_role!) | sastanci | edit + GUC |
| pm_teme SELECT **NIJE javan**: predlagač OR mgmt OR učesnik sastanka OR (draft ∧ has_edit_role) | pm_teme | GUC (row) |
| draft tok: INSERT draft (edit); UPDATE draft→usvojeno/odbijeno (edit∨mgmt) + trigger guard | pm_teme | GUC |
| odluke/templates write `has_edit_role()` (bez scope-a) | sastanak_odluke, sastanci_templates+ucesnici | `sastanci.edit` |
| prefs svoje po email claim-u (+mgmt read/update); log SELECT svoje∨mgmt, UPDATE/DELETE mgmt | notification_prefs, notification_log | edit/read + GUC |
| ai_chat: SELECT own (`auth.uid()`) + project-scope SVI; DELETE own conv; **INSERT/UPDATE NIKO** (samo service role) | ai_chat_conversations/messages | `ai.chat` — upis SAMO kroz BE chat servis |
| ai_uputstva SELECT `aktivno ∧ (vidljivost='svi' ∨ hr_or_admin)`; notes SELECT true; masina_docs bez politika | ai_* znanje | RPC-only |
| storage: `sastanci-arhiva` SELECT mgmt ∨ `is_sastanak_ucesnik(folder)`, INSERT edit, DELETE mgmt; `sastanak-slike` read svi/write edit; `ai-chat-images` SELECT vlasnik conv ∨ project | storage.objects | BE presigned + ista provera u servisu |

**Ključne guard fn** (pune def. u snapshotu): `is_sastanak_ucesnik()` (email claim → učesnik),
`has_edit_role()` = `admin/hr/menadzment/pm/leadpm/poslovni_admin` globalno (+ pm/leadpm per-projekat),
`current_user_is_management()` = `admin/menadzment`, `sast_user_can_move_weekly()` = **email u tabeli
`sast_weekly_movers`** (danas Nenad+Zoran — NIJE rola!), `current_user_is_hr_or_admin()` = admin/hr/menadzment.

**Predlog permisija (`permissions.ts`)**: `sastanci.read` (uloge 1.0 gate-a: admin, menadzment, hr,
pm, leadpm, viewer — §7 P6), `sastanci.edit` (admin, menadzment, hr, pm, leadpm, poslovni_admin =
has_edit_role paritet), `sastanci.manage` (admin, menadzment), `sastanci.weekly_move` (guard u DB
tabeli — 2.0 samo prosleđuje kroz GUC), `sastanci.ai_model` (admin), `ai.chat` (SVE aktivne uloge).
⚠️ RPC-ovi koriste i `auth.uid()` (`set_sastanci_ai_model`, ai_chat_*) → GUC `sub` claim OBAVEZAN.

**Skrivena pravila firme (doktrina C — NE gubiti):**
1. `meeting_locked` mejl je **OBAVEZAN za sve učesnike** — ignoriše opt-out (zvanična distribucija zapisnika).
2. **Zaključan sastanak je immutable** za sve osim admin/menadzment — trigger `sast_check_not_locked`
   na 7 tabela (ERRCODE 23514); reopen = mgmt-only front akcija.
3. Sedmični pomeraju SAMO email-ovi iz `sast_weekly_movers` — authz po TABELI, ne roli.
4. Auto-kreiranje sedmičnog: 2 UTC cron termina + lokalni guard „petak 08h Beograd" (DST-otporno) +
   pomeranje za praznik (`sast_adjust_for_holiday`) + skip-tabela; `sast_weekly_pomeri` briše skip,
   šalje NOVE pozivnice i formatira naslov `Sedmični sastanak — DD.MM.YYYY.`.
5. Pozivnica se auto-šalje na INSERT učesnika SAMO dok je sastanak `planiran` (trigger) uz dedup
   po (kind, primalac, sastanak, queued/sent); DELETE učesnika čisti queued pozivnice.
6. `saveUcesnici` = bulk **DELETE pa INSERT** — regeneriše `rsvp_token` i briše RSVP odgovore.
   Poznato 1.0 ponašanje — zadržati (uz §7 P8).
7. Organizator-trio (vodio/zapisnicar/created_by) ima edit nad SVOJIM sastankom i bez mgmt role;
   na samoj `sastanci` UPDATE/DELETE čak i bez `has_edit_role` (viewer-trio teoretski može).
8. `sast_zakljucaj_sastanak` prima PDF path da ga upiše u arhivu PRE nego što trigger `meeting_locked`
   okine dispatch → mejl nađe prilog bez race-a. Redosled očuvati.
9. `sast_trg_akcija_new/changed` fn POSTOJE ali **nisu zakačene ni na jedan trigger** (orphan) —
   `akcija_new`/`akcija_changed` mejlovi se danas NE šalju automatski iako templates postoje. NE
   „popravljati" tokom seobe (§7 P7).
10. AI: upis istorije ISKLJUČIVO server-side; dnevni limit 50 poruka/korisnik broji se od **UTC**
    ponoći (ne Beograd) — zadržati; limit se meri COUNT-om `role='user'` poruka.
11. Projektna AI nit: JEDNA po projektu (reuse najstarije); u deljenoj niti LIČNI alati (GO/sati/
    zaposleni/SQL) su ISKLJUČENI (poruke vide svi); poruke se modelu prefiksuju imenom autora;
    autor se rešava iz `employees` kartona po email-u.
12. `ai_chat_sql`: SAMO admin/HR; jedan SELECT/WITH bez `;` i komentara; keyword blocklist;
    LIMIT 200; statement_timeout 4s; **nije DEFINER** → RLS pozivaoca važi.
13. `ai_chat_prijavi_kvar`: nije DEFINER — INSERT u `maint_incidents` prolazi kroz maint RLS
    (insufficient_privilege → uredan `nema_prava`); id se generiše unapred jer prijavilac nema
    SELECT-vidljivost svog kvara; WO auto-kreira maint trigger za major/critical/safety.
14. `ai_uputstva.vidljivost='admin_hr'` krije red od običnih korisnika; `dodaj_uputstvo` = upsert
    po naslovu, SAMO admin/HR; embedding backfill je best-effort (bez njega radi FTS).
15. Allowlist AI modela za rezime (`claude-opus-4-8/sonnet-4-6/haiku-4-5`) mora biti sinhronizovan
    na 3 mesta: front konstanta, edge/BE, RPC CHECK.
16. Auto-naslov nove lične niti generiše gpt-4o-mini (2–5 reči, srpski latinica); pad ne ruši slanje.
17. Vision: max ~6MB base64, JPG/PNG/WEBP/GIF, klijentski resize na 1568px (GIF bez resize-a).
18. Whatsapp kanal u outbox-u = permanent fail (nikad implementiran) — ne brisati kind.

## 3. API (predlog, `/api/v1/sastanci/*` + `/api/v1/ai/*`)

| Endpoint | Metod | Permisija | 1.0 poreklo |
|---|---|---|---|
| `/sastanci` (+`/:id`, `/next-weekly`, `/search?q=`) | GET | read | loadSastanci/loadNextPlaniran/searchSastanciGlobal |
| `/sastanci` / `/:id` | POST / PATCH / DELETE | edit (row=GUC) | saveSastanak/updateStatus/deleteSastanak |
| `/sastanci/:id/full` | GET | read | getSastanakFull + overview counts |
| `/sastanci/:id/lock` | POST | edit (trio/mgmt u RPC) | `sast_zakljucaj_sastanak(p_pdf_storage_path)` |
| `/sastanci/:id/reopen` | POST | manage | otvojiPonovo (PATCH status) |
| `/sastanci/:id/invites` · `/remind-unprepared` · `/resend-locked` | POST | manage | `sastanci_send_invites` (+stamp `pozivnice_poslate_at`) / `_remind_unprepared` / `_resend_meeting_locked` |
| `/sastanci/:id/rsvp` | POST | read | `sastanci_set_my_rsvp` (svako svoj) |
| `/sastanci/:id/ucesnici` (bulk PUT) + `/:email` PATCH/POST/DELETE + `/mark-prisutni` | * | edit | saveUcesnici, update pozvan/prisutan/pripremljen/priprema, markPozvaniPrisutni. ⚠️ `rsvp_token` se NIKAD ne vraća |
| `/sastanci/:id/aktivnosti` CRUD + `/reorder` + `/seed-from-teme` | * | edit | presek_aktivnosti + most teme→zapisnik (dedup po tema_id, BE tx) |
| `/sastanci/:id/slike` CRUD + presigned upload/sign | * | edit / read | presek_slike + bucket `sastanak-slike` |
| `/sastanci/:id/odluke` CRUD | * | edit | sastanak_odluke |
| `/sastanci/akcije` GET (v_akcioni_plan, filteri) + POST/PATCH/DELETE + `/bulk-status` + `/:id/istorija` + `/weekly-diff` | * | read / edit | loadAkcije/saveAkcija/patchAkcija/updateAkcijeStatusBulk/loadAkcijaIstorija/loadWeeklyDiffStats |
| `/sastanci/teme` CRUD + draft tok + `/reorder-rang` + hitno/za-razmatranje/dodeli | * | edit (admin za rang — §7 P9) | pmTeme.js ceo |
| `/sastanci/templates` CRUD + `/:id/instantiate` | * | edit | sastanciTemplates (port `nextOccurrence` u BE) |
| `/sastanci/prefs` | GET / PATCH | read (svoje) | `sastanci_get_or_create_my_prefs` + PATCH |
| `/sastanci/notifications` | GET | read (svoje/mgmt) | log pregled |
| `/sastanci/weekly` GET status · POST `/pomeri` `/odlozi` `/vrati` | * | read / weekly_move (DB gate) | `sast_weekly_*` |
| `/sastanci/arhive` GET + `/:id/pdf` POST (upload) / GET (signed) | * | edit / read | sastanciArhiva + bucket `sastanci-arhiva` (path paritet!) |
| `/sastanci/:id/ai-summary` | POST | read | **port edge `sastanci-ai-summary`** (Claude; model iz `sastanci_ai_settings`) |
| `/sastanci/ai-model` | GET / PUT | read / **admin** | getAiModel / `set_sastanci_ai_model` |
| `/sastanci/user-directory` · `/dashboard-stats` | GET | read | `get_sastanci_user_directory` / loadDashboardStats |
| `/ai/conversations` (+`/:id/messages`) | GET | ai.chat | fetchAiConversations/Messages (RLS paritet: svoje + project) |
| `/ai/conversations/:id` | DELETE | ai.chat | deleteAiConversation (samo svoje lične) |
| **`/ai/chat`** | POST | ai.chat | **port edge `ai-chat`**: 4 engine-a, 18 alata (RPC kroz GUC SA identitetom korisnika), vision upload, limit 50/dan (UTC), auto-naslov, projektne niti |
| `/ai/me` · `/ai/projects` · `/ai/images/sign` | GET | ai.chat | `ai_chat_ja` / fetchAiProjects / signAiImage |

Idempotencija: modul nema svoj mehanizam → `rev_api_idempotency` obrazac (`clientEventId`) na
mutacijama sa nus-efektima (lock, invites, remind, resend, rsvp, instantiate, bulk replace učesnika,
ai/chat). Mejl RPC-ovi su već „delete-pa-enqueue" (re-send semantika) — očuvati.

## 4. FE (Next) — nav sekcija **Saradnja** (`/sastanci`, `/ai`)

**Sastanci** — paritet 1.0: 4 glavna taba (**Pregled** KPI+predstojeći+moje akcije · **Sastanci**
lista/kalendar/week-view + „Sedmični (pomeri/odloži)" modal (vidljiv po `can_move`) + Novi sastanak
modal · **Moj rad** (moje akcije + moje pripreme + moj RSVP) · **Akcioni plan** tabela+kanban+bulk+
istorija) + 6 admin tabova iza ⚙ (PM teme · Po projektu (reorder rang) · Draft teme · Šabloni ·
Arhiva · Podešavanja notifikacija) + **komandna paleta Ctrl/⌘+K** (pretraga sastanaka/zadataka + komande).
**Detalj sastanka** (`/sastanci/:id`): header sa statusnim tokom (▶ Počni = auto-prisutni pozvani →
Završi → 🔒 Zaključaj sa PDF; reopen mgmt) + tabovi Zapisnik (tačke: rich text + 🎤 STT + slike +
„Uvezi teme" + ✨ AI rezime + PDF preview/regeneriši) · Akcije · Priprema (checkbox + tekst + RSVP
pregled + podsetnik) · Odluke · Arhiva (snapshot + PDF download).
**AI asistent** (`/ai`): sidebar istorija (Projekti + Moji razgovori) + chat (Markdown-lite render,
vision prilog, engine prekidač ChatGPT/Claude/Gemini/Kimi — localStorage, vokativ pozdrav).
**Mobilno**: 2.0 responsive pokriva `/m/sastanci` paritet (lista→detalj read + 3 laka write-a: moj
RSVP, status akcije, ✓ obrađeno na tački; deep-link `?open=<id>`) i `/m/ai` (nova sesija posle 6h,
sheet istorije, ＋ lična/projektna nit). Desktop-only ostaje: kreiranje/zaključavanje, uređivanje
zapisnika, pozivnice, PDF — kao u 1.0.
⚠️ STT (🎤) i ✨ ai-refine zavise od §7 P4; bez toga zapisnik gubi diktiranje (regresija pariteta).

## 5. Parity matrica (doktrina B — puni se TOKOM rada)

| # | Funkcija | Status |
|---|---|---|
| 1 | Lista sastanaka + filteri + kalendar/week view | R1 read (GET /sastanci + filteri, /my, /next-weekly = paritet loadNextPlaniranSastanak: bilo koji tip, Beograd-datum — korigovano u review-u 12.07): IMPLEMENTED · **kreiranje: R2 IMPLEMENTED+TESTED** (v. #2) · kalendar/week-view (FE): R3 |
| 2 | Novi sastanak (modal) + izmena + brisanje (RLS paritet trio/mgmt) | **R2 IMPLEMENTED+TESTED** (POST /sastanci kroz runIdempotentRls; PATCH/DELETE /:id kroz withUserRls — RLS UPDATE/DELETE = mgmt∨trio; assertAffected 403 vs 404; unit + e2e edit-matrica). Row-ishod trio čeka R4 živi smoke · modal (FE) R3 |
| 3 | Detalj: učesnici (add/remove/bulk, pozvan/prisutan, autocomplete iz directory-ja) | R1 read IMPLEMENTED · **R2 write IMPLEMENTED+TESTED**: PUT /:id/ucesnici (bulk delete+insert, regen rsvp_token — B8), POST/PATCH/DELETE /:id/ucesnici/:email, POST /:id/mark-prisutni (unit + e2e) |
| 4 | Status tok: Počni (auto-prisutni) → Završi → Zaključaj → Reopen (mgmt) | **R2 IMPLEMENTED+TESTED** (PATCH status; mark-prisutni; POST /:id/lock RPC; POST /:id/reopen = manage; e2e manage-matrica). Row-ishod (trio-lock) R4 smoke · jsPDF render (FE) R3 |
| 5 | Zaključavanje sa PDF-om (jsPDF port + upload + `sast_zakljucaj_sastanak`) | **R2 IMPLEMENTED+TESTED** (POST /:id/lock = sast_zakljucaj_sastanak sa pdfStoragePath PRE meeting_locked trigera — §2 p.8; PDF upload R2.2; unit lock-dispatch). jsPDF render + tok (FE) R3 · živi mejl-prilog R4 |
| 6 | Zapisnik: tačke CRUD + reorder + rich text + slike (upload/sign/delete) | R1 read IMPLEMENTED · **R2 IMPLEMENTED+TESTED**: aktivnosti CRUD (max+1 rb; status default **'planiran'** — R2-review #4, 1.0 gazi DB default 'u_toku') + POST /:id/aktivnosti/reorder + slike upload/sign/delete (R2.2; meta-pre-upload; **fileSize cap 20MB** — R2-review #3). rich text (FE) R3 |
| 7 | Most teme→zapisnik (seed, dedup po tema_id) | **R2 IMPLEMENTED+TESTED** (POST /:id/aktivnosti/seed-from-teme; BE tx dedup po tema_id; **R2-review #6: orderBy prioritet.desc/admin_rang.asc/created_at + pod_rn iz koda projekta + status 'planiran'** = pun paritet seedZapisnikFromTeme; e2e edit + unit) |
| 8 | AI rezime „Sažmi zapisnik" (BE endpoint + izbor modela admin) | **R2.3 IMPLEMENTED+TESTED** (POST /:id/ai-summary — port edge; model iz sastanci_ai_settings fallback SAST_AI_MODEL→opus; Anthropic one-shot; e2e read + DTO 400). Živi Claude poziv R4 |
| 9 | Akcioni plan: tabela + kanban + inline patch + bulk status + istorija + weekly diff | R1 read IMPLEMENTED · **R2 IMPLEMENTED+TESTED**: POST /akcije, PATCH /akcije/:id (zavrsen→snapshot zatvoren_*; reopen→očisti), DELETE, POST /akcije/bulk-status (STVARNI broj — RLS deo). kanban (FE) R3 |
| 10 | PM teme: ceo životni ciklus + hitno/za_razmatranje/admin_rang + reorder po projektu | R1 read IMPLEMENTED · **R2 IMPLEMENTED+TESTED**: POST/PATCH/DELETE /teme, /teme/:id/hitno · /za-razmatranje · /admin-rang · /dodeli, POST /teme/reorder-rang (admin FE-gate; DB=has_edit_role). **R2-review #5: updateTema ČUVA postojeću resio_* atribuciju** (čita red pre upisa; B ne preotima ko je A rešio — paritet buildTemaPayload; unit) |
| 11 | Draft teme tok (predlog iz projekta → pregled → usvajanje/uvoz na sastanak) | **R2 IMPLEMENTED+TESTED** (POST /teme/draft, GET /teme/draft, POST /teme/:id/draft-review [WHERE status=draft], /teme/:id/uvedi [WHERE status=usvojeno]) |
| 12 | Šabloni + instanciranje (nextOccurrence port u BE) | **R2 IMPLEMENTED+TESTED** (POST/PATCH/DELETE /templates + ucesnici; POST /templates/:id/instantiate — `templates-cadence.nextOccurrence` port 1:1, pozivalac uvek u listi) |
| 13 | Pozivnice: send (mgmt) + stamp + auto-invite na add učesnika (trigger — samo proveriti) | **R2 IMPLEMENTED+TESTED** (POST /:id/invites = sastanci_send_invites + stamp pozivnice_poslate_at; e2e manage). Auto-invite trigger NETAKNUT (pozadina) · živi mejl R4 |
| 14 | Priprema: pripremljen/priprema + podsetnik nepripremljenima | **R2 IMPLEMENTED+TESTED** (PATCH /:id/ucesnici/:email pripremljen/priprema; POST /:id/remind-unprepared = RPC mgmt) |
| 15 | RSVP: in-app (moj odgovor) + prikaz statusa; magic-link tok NETAKNUT (samo e2e provera) | **R2 IMPLEMENTED+TESTED** (POST /:id/rsvp = sastanci_set_my_rsvp; e2e read-nivo + DTO status 400). Magic-link edge NETAKNUT · živi smoke R4 |
| 16 | Resend zapisnika (meeting_locked) | **R2 IMPLEMENTED+TESTED** (POST /:id/resend-locked = RPC mgmt; e2e manage) |
| 17 | Sedmični: status + pomeri/odloži/vrati (DB gate movers) | R1 read IMPLEMENTED · **R2 IMPLEMENTED+TESTED**: POST /weekly/pomeri·odlozi·vrati kroz withUserRls (movers gate u DB fn; e2e weekly_move matrica) |
| 18 | Podešavanja notifikacija (prefs) + pregled log-a (svoje/mgmt) | R1 read IMPLEMENTED · **R2 IMPLEMENTED+TESTED**: PATCH /prefs (get_or_create pa PATCH svog reda po email claim; e2e read-nivo). Log INSERT NIJE izložen (B10) |
| 19 | Odluke tab CRUD | R1 read IMPLEMENTED · **R2 IMPLEMENTED+TESTED**: POST /:id/odluke, PATCH/DELETE /:id/odluke/:odlId |
| 20 | Arhiva: lista svih + snapshot pregled + PDF download/regeneriši/preview nacrta | R1 read IMPLEMENTED · **R2.2 IMPLEMENTED+TESTED**: POST /:id/arhiva/pdf (put `{id}/{ts}_zapisnik.pdf` = 1.0) + GET signed (mgmt∨učesnik provera kroz withUserRls; unit path+403; e2e). jsPDF preview nacrta (FE) R3 |
| 21 | Dashboard (KPI brojke) + globalna pretraga + komandna paleta | R1 read IMPLEMENTED · komandna paleta (FE): R3 |
| 22 | Mobilni sastanci tok (read + 3 laka write-a + deep-link) — responsive | NOT_STARTED (FE R3) |
| 23 | AI: istorija (lične+projektne) + brisanje svoje niti | R1 read IMPLEMENTED · **R2.3 DELETE IMPLEMENTED+TESTED** (DELETE /ai/conversations/:id kroz withUserRls — RLS delete_own, bez ownership WHERE; 0 redova→404; unit + e2e) |
| 24 | AI: `/ai/chat` port — 4 engine-a + tool-use petlja (18 alata kroz GUC) + limit 50/dan UTC | **R2.3 IMPLEMENTED+TESTED** (POST /ai/chat: AiProviderService 4 engine-a; tool-loop skeleton — mokovani engine, oba puta; execTool dispatch 18 alata → ai_chat_* kroz withUserRls; limit UTC; upis istorije withUser+auth.uid(); e2e ai.chat + DTO engine 400). **R2-review: #1 SYSTEM_PROMPT/DATE_LINE/opisi alata VRAĆENI VERBATIM iz 1.0 (bio §C prekršaj — skraćen; sada anti-truncation guard test); #7 odgovor nosi remaining/limit; #8 greška engine-a nosi conversationId (upstream_error/unreachable 502) — retry ne pravi orphan nit.** Živi engine/scope alata R4 smoke (traži ključeve) |
| 25 | AI: projektne niti (jedna po projektu, bez ličnih alata, ime autora) | **R2.3 IMPLEMENTED** (resolveConversation reuse najstarije po project_ref; toolsForScope isključuje lične alate; prefiks imena autora; **R2-review #1: projektni extraSystem VERBATIM** — spisak alata + „belešku ISKLJUČIVO na izričit zahtev"). TESTED preko chatWithTools+toolsForScope · živi smoke R4 |
| 26 | AI: vision (resize + upload + sign) + auto-naslov niti | **R2.3 IMPLEMENTED** (multipart `image` → parseImage 6MB/mime → ai-chat-images bucket; **fileSize cap 12MB** — R2-review #3; generateTitle nove lične niti; GET /ai/images/sign — **R2-review #2: striktna `{convId-uuid}/{ime}` validacija + potpis rekonstruisane putanje** protiv path-traversal). Klijentski resize (FE) R3 · živi upload R4 |
| 27 | AI: pretraga uputstava sa embedding-om (embed poziv u BE) + dodaj_uputstvo/belešku + backfill | **R2.3 IMPLEMENTED+TESTED** (execTool: embed pre pretrazi_uputstva/masina_uputstvo; backfill embedinga posle dodaj_uputstvo/belesku — withUser best-effort; unit embedding-dispatch). Živi OpenAI embed R4 |
| 28 | AI mobilni `/m/ai` (sesija 6h, sheet istorije) — responsive | NOT_STARTED (FE R3) |
| 29 | 🎤 STT + ✨ refine na 2.0 (zapisnik + chat) — po odluci P4 | **R2.4 IMPLEMENTED+TESTED** (media-ai modul: POST /ai/stt Whisper + POST /ai/refine — AiProviderService; profili refine-a; **fileSize cap 25MB audio** — R2-review #3; unit + e2e ai.chat). FE dugmad (🎤/✨) R3 · živi Whisper/OpenAI R4 |
| 30 | e2e permission matrica (read/edit/manage/weekly_move/ai_model/ai.chat + row asercije: učesnik-scope, pm_teme vidljivost, ai svoje-niti, zaključan=409) | **R2 PROŠIRENA — TESTED**: e2e `sastanci-ai-permissions.e2e` **213** (rola×endpoint×200/403; **R2-review hardening: liste IZVEDENE iz ALL_ROLE_KEYS** — svaka katalog-rola pokrivena, pogrešan budući grant obara test; boundary asserti remind-unprepared/resend-locked/weekly odlozi/vrati; storage; AI chat/rezime/media; DTO 400; route-ordering); unit **401** (`sy15.service` runIdempotentRls redosled+replay+konflikt; `sastanci.mutations` assertAffected/idempotency/storage/planiran/resio/seed; `ai-tools` VERBATIM anti-truncation guard; `ai-provider` tool-loop mokovani engine; `ai-chat` execTool dispatch + signImage traversal + chat remaining/limit + upstream conversationId; `role-permissions.sastanci-ai` **kompletnost nad ALL_ROLE_KEYS** (wrong-grant tripwire); `media-ai`). Row-asercije (učesnik/pm_teme/ai-niti/zaključan=409) → R4 živi smoke |

## 6. Redosled izvođenja (R-faze za CEO talas)

| Faza | Šta | Gate |
|---|---|---|
| R0 | Nenadov review + presude §7 + re-verifikacija snapshot-a na živoj sy15 + **grants v2 (12.07): jedini DB korak = `GRANT authenticated TO servosync2_app`** — izmereno da je servosync2_app BYPASSRLS bez članstava, pa BE koristi `withUserRls` (GUC + SET LOCAL ROLE authenticated) i nasleđuje privilegije/RLS od `authenticated`; direktni table/fn grantovi iz v1 POVUČENI (talasB-R0-grants-DRAFT.sql) | odobreno |
| R1 | BE read: Prisma modeli u sy15.prisma + svi GET (uklj. view-ove) + `sastanci.*`/`ai.*` permisije + e2e read matrica | read paritet |
| R2 | BE write: REST mutacije kroz GUC + 13 front RPC + storage presigned + idempotency; **`/ai/chat` port** (engine-i, alati, vision, limit) + `/sastanci/:id/ai-summary`; e2e full | write paritet |
| R3 | FE: 4+6 tabova + detalj (5 tabova) + modali + paleta + `/ai` + mobilni tokovi; jsPDF port; STT/refine po P4 | UI paritet |
| R4 | Živi smoke (pun ciklus: kreiraj → pozovi → RSVP → zapisnik+slika → akcije → zaključaj sa PDF → mejl stiže sa prilogom → AI pitanje sa alatom) + Playwright happy-path + paralelni rad → hub preklop (Sastanci + AI kartice) | parity gate (doktrina D) |
| R5 | Retrospektiva tempa → ažurirati PROCENA_SEOBE | kalibracija |

## 7. Otvorena pitanja (Nenad presuđuje — svako sa predlogom)

> ✅ **PRESUĐENO 12.07.2026 (Nenad): „VAŽE PREDLOZI" — sva pitanja + H1–H4 usvojeni bez izuzetaka.**

1. **Edge `ai-chat` → NestJS port?** 2.0 FE nema 1.0 GoTrue JWT pa edge ne može da ga autentifikuje.
   **Predlog: DA — port u NestJS** (ključevi u BE env; tool-use petlja u TS; 22 RPC alata NETAKNUTA
   kroz GUC most sa identitetom 2.0 korisnika; upis istorije BE rolom = ekvivalent service role).
   Edge ostaje živ za 1.0 do preklopa (paralelni rad, ista baza — bez sudara jer je limit u DB count-u).
2. **Edge `sastanci-ai-summary`** — isti razlog. **Predlog: port u NestJS** (60 linija proxy-ja;
   model iz `sastanci_ai_settings`; deli ANTHROPIC_API_KEY sa `/ai/chat`).
3. **RSVP + dispatch + pg_cron ostaju netaknuti u sy15/edge?** **Predlog: DA** — čista pozadina;
   2.0 samo čita outbox log. Magic-link URL-ovi i dalje pokazuju na 1.0 gateway (radi za obe strane).
4. **STT (`stt-transcribe`) i ✨ (`ai-refine`) za 2.0 FE** — presečna infra (koristi je ~12 modula).
   **Predlog: mali zajednički NestJS `media/ai` servis u OVOM talasu** (`/ai/stt`, `/ai/refine` —
   Whisper + refine proxy, ~1 dan), jer bez toga zapisnik i chat gube diktiranje; ostali moduli ga
   kasnije samo reuse-uju.
5. **PDF zapisnika**: **Predlog: zadržati klijentski jsPDF** (port `lib/sastanciPdf.js` na 2.0 FE,
   ćirilica/fontovi već rešeni u 1.0), upload kroz BE presigned na isti bucket/path format —
   server-side render NE raditi sada (doktrina C).
6. **`sastanci.read` širina**: DB SELECT je `true` za sve authenticated, ali 1.0 front gate
   (`canAccessSastanci`) pušta samo admin/leadpm/pm/menadzment/hr/viewer (monter/tim_lider/
   proizvodni_radnik NE vide modul). **Predlog: paritet 1.0 front gate-a** u `role-permissions.ts`
   (vidljivost menija), row-nivo ionako ostaje u bazi; širenje na operativne role = svesna odluka kasnije.
7. **Orphan `sast_trg_akcija_new/changed`** (mejl za novu/izmenjenu akciju postoji ali trigeri nisu
   zakačeni — verovatno namerno isključeno). **Predlog: NE dirati** u seobi; zabeležiti u backlog
   „aktivirati po želji" posle preklopa.
8. **Bulk replace učesnika briše RSVP odgovore + regeneriše token** (1.0 ponašanje). **Predlog:
   zadržati identično** (paritet); eventualni „diff umesto delete+insert" = poseban predlog posle preklopa.
9. **`admin_rang`/`za_razmatranje` gate**: DB pušta `has_edit_role` (uz scope), front samo admin
   (`canPrioritizeTeme`). **Predlog: paritet fronta** — dugmad vidljiva samo admin-u; DB širinu ne dirati.
10. **`sastanci_notification_log` INSERT politika (`has_edit_role`)** je mrtva površina (front nikad
    ne INSERT-uje direktno). **Predlog: ne izlagati INSERT kroz 2.0 API** (enqueue ide isključivo kroz
    postojeće DEFINER RPC-ove/trigere); politiku u bazi NE dirati.
