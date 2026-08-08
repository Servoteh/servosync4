# Seoba kadrovske (HR) na 3.0 bazu — merenje, priprema i runbook (07–08.08.2026)

**Korak 4** iz [PLAN_GASENJA_SY15_2026-08-03.md](PLAN_GASENJA_SY15_2026-08-03.md), posle
koraka 1 (sastanci + PB, [SEOBA_SASTANCI_PB_2026-08-05.md](SEOBA_SASTANCI_PB_2026-08-05.md))
i koraka 2 (održavanje, [SEOBA_ODRZAVANJA_2026-08-06.md](SEOBA_ODRZAVANJA_2026-08-06.md)).
**Ovo je najveći preostali domen.**

**Ništa od ovoga nije primenjeno na produkciji.** Sve merenje je rađeno `SELECT`-om nad živom
sy15 bazom; migracija i prenos su napisani i dokazani na *odvojenoj probnoj bazi*
(`kadr_proba`, napravljena i obrisana u toku rada). Prekidač ostaje `sy15`.

> ⚠️ **MODUL KADROVSKA JE ZAMRZNUT** ([OTVORENI_POSLOVI.md §K](OTVORENI_POSLOVI.md)) —
> odluka vlasnika. Zamrznute su **funkcionalne izmene i popravke**; **sama seoba je ono
> što zamrzavanje ukida** i jeste dozvoljena. U ovom radu **nijedan zatečen kvar nije
> popravljen** — svi su popisani u §8.

> **Nijedan broj ovde ne dolazi iz `pg_stat`** — sve je `count(*)`, `pg_constraint`,
> `pg_indexes`, `pg_trigger`, `pg_policy`, `pg_proc`, `pg_get_functiondef`, `pg_attrdef`,
> `information_schema`. (Pouka: `n_live_tup` nije broj redova.)

---

## 1. Merenje — 64 tabele, 510.455 redova, 152 MB

`count(*)` nad živom sy15, 07.08.2026.

| Tabela | redova | | Tabela | redova |
|---|---:|---|---|---:|
| **`attendance_events`** | **491.206** | | `contracts` | 17 |
| `work_hours` | 8.354 | | `assessment_raters` | 17 |
| **`vacation_go_days`** | **5.269** | | `competence_profiles` | 16 |
| `kadr_notification_log` | 1.340 | | `departments` | 13 |
| `kadr_audit_log` | 1.239 | | `assessments` | 11 |
| `competence_levels` | 570 | | `makeup_requests` | 9 |
| `vacation_history` | 447 | | `kadr_document_ack` | 8 |
| `employee_badges` | 263 | | `attendance_notify_extra` | 6 |
| `katze_employee_map` | 163 | | `kadr_grid_editor_allowlist` | 5 |
| `employees` | 157 | | `kadr_vacation_editor_allowlist` | 4 |
| `salary_terms` | 143 | | `work_hours_remarks` · `vacation_bonus_days` | 3 |
| `vacation_requests` · `absences` | 134 | | `employee_foreign_docs` · `kadr_salary_viewer_allowlist` | 2 |
| `vacation_entitlements` | 132 | | `paid_leave_requests` · `assessment_cycles` · `kadr_notification_config` | 1 |
| `employee_documents` | 119 | | 21 tabela sa **0** redova: `assessment_answers/results/scores/targets` · `corrective_measures/plans` · `development_checkins/plans` · `employee_bank_cards/expectations/talks` · `kadr_certificates` · `kadr_medical_exams` · `kadr_onboarding_runs/tasks/template_items/templates` · `nop_requests` · `salary_payroll` · `vacation_change_requests` | 0 |
| `worker_employee_map` · `competences` | 95 | | | |
| `competence_questions` | 90 | | | |
| `job_positions` · `employee_personal_docs` (28) · `profile_positions` (78) · `profile_groups` (64) · `kadr_holidays` (36) · `sub_departments` (32) · `attendance_corrections` (28) · `employee_children` (22) · `competence_groups` (20) | 78… | | | |

### Obim logike (mereno, ne procenjeno)

| Šta | Koliko |
|---|---:|
| tabele | **64** |
| redova | **510.455** |
| veličina | **152 MB** (od čega `attendance_events` 140 MB) |
| kolona | **744** |
| FK ka `auth.users` | **5** ← *održavanje ih je imalo 46* |
| FK unutar domena | **72** |
| 🔴 **inbound FK spolja ka domenu** | **7** (Projektni biro 4 + Reversi 3) |
| CHECK ograničenja | **110** |
| indeksi | **199** |
| trigeri | **59** (36 mehanika + 23 logika) |
| RLS politike | **167** na 63 od 64 tabele — **najviše u celoj sy15 bazi** |
| view-ovi koji čitaju domen | **19** (15 `security_invoker` + 4 DEFINER) |
| **PG enum tipova** | **0** ← *održavanje ih je imalo 23* |
| funkcije koje domen dodiruju | **116** (63 `SECURITY DEFINER`) |
| od toga **BEZ prefiksa domena** | **54** |
| `withUser*` poziva u kodu | **96** u modulu + 25 van njega |
| pg_cron poslova u sy15 za domen | **1**, i taj je **ugašen** (`kadr_pulse_notify_dispatch`, `active=false`) |
| živ spoljni pisac | **Katze most** (`bridge`, svakih 10 min) |

### 🔴 Nalaz 1: 64 tabele, ali u 3.0 nastaje 63 — dva sudara imena

Domen je popisan po **katalogu baze + FK grafu + pozivima iz koda**, ne po prefiksu
(pouka koraka 2). Rezultat: 64 tabele. Ali dve od njih **ne mogu doslovno u 3.0**:

| # | Tabela | Šta je izmereno | Odluka |
|---|---|---|---|
| **a** | `departments` | 3.0 **već ima** tabelu `departments` — BigBit `BBOdeljenja` (`model Department`, kolone `id/code/description`, izmereno **1 red**: `id=0, code='0', description='0'`). sy15 kadrovska `departments` je **nešto drugo** (`id/name/created_at`, 13 redova, roditelj `sub_departments` i `job_positions`) | u 3.0 se zove **`kadr_departments`** — jedina preimenovana tabela domena |
| **b** | `worker_employee_map` | 3.0 **već ima** istoimenu tabelu (`model WorkerEmployeeMap`, 79 redova) sa **istom logičkom vezom** (3.0 radnik → sy15 `employees.id`), samo drugim imenom ključa (`worker_id` vs `bigtehn_worker_id`) | **ne pravi se druga** — sy15 kopija se **spaja** u postojeću |

Preklop dve kopije `worker_employee_map` je **izmeren pre odluke**:

| Provera | Rezultat |
|---|---:|
| sy15 redova | 95 |
| 3.0 redova | 79 |
| zajedničkih ključeva | 71 |
| **različit `employee_id` na preseku** | **0** |
| samo u sy15 | 24 |
| samo u 3.0 | 8 |
| **unija** | **103** |

Dakle **nijedna kopija nije potpuna**, ali se ne sukobljavaju — spajanje je bezbedno i daje
uniju. 🔴 Da se ovo nije izmerilo, „prenos po spisku" bi napravio **treću** kopiju istog
podatka. (Klasa greške „dva izvora istog podatka".)

### 🔴 Nalaz 2: funkcija je 116, a samo 62 nosi prefiks domena

Upit po prefiksu (`kadr_`, `vacation_`, `absence_`, `assessment_`…) daje **62**. Upit po
**telu** (`prosrc` pominje neku od 64 tabele) nalazi još **54**:

- **`hr_*` (11)** — `hr_update_employee`, `hr_upsert_salary_payroll` (9.186 znakova!),
  `hr_upsert_work_hours_batch`, `hr_vacreq_approve`, `hr_rollover_year`,
  `hr_correct_vacation_balance`, `hr_revise/reschedule/reject/cancel/delete_vacation_request`
- **`ai_chat_*` (12)** — `ai_chat_go_saldo`, `ai_chat_go_pregled`, `ai_chat_go_zahtevi`,
  `ai_chat_odsustva`, `ai_chat_sati`, `ai_chat_moj_tim`, `ai_chat_ja`,
  `ai_chat_employee_lookup`, `ai_chat_opis_pozicije`, `ai_chat_inzenjering`,
  `ai_chat_dodaj_belesku`, `ai_chat_dodaj_uputstvo`
- **`pb_*` (9)** — v. §4c
- **gejtovi (7)** — `current_user_can_view_salary`, `current_user_is_admin/is_hr`,
  `current_user_manages_employee`, `current_user_employee_id`, `can_edit_kadrovska_grid`,
  `can_edit_vacation_balance`, `has_edit_role`
- **ostalo** — `makeup_approve/complete/reject`, `paid_leave_approve/reject/delete`,
  `talk_share/unshare/acknowledge`, `approve_nop_request`, `reject_nop_request`,
  `go_ledger`, `kiosk_record_punch`, `rev_current_employee_id`,
  `sync_qbigtehn_operator_cards`, `loc_can_create_movement`, `empdoc_object_is_contract`

**Pouka je identična koraku 2, samo veća:** spisak po prefiksu promaši **skoro polovinu**
domena. Ovde je to presudno jer među promašenima su i **gejtovi zarada**.

---

## 2. Mapa identiteta — 🔴 potpuno drugačija od svih prethodnih koraka

### 2.1 `employees` NEMA `user_id` — veza sa nalogom je MEJL

Održavanje je imalo **46** FK kolona ka `auth.users`. Kadrovska ima **5**. Razlog je
izmeren: **tabela `employees` nema kolonu `user_id`** (38 kolona, nijedna nije nalog).

Sve što povezuje zaposlenog sa nalogom radi ovo:

```sql
-- public.current_user_employee_id() i public.pb_current_employee_id(), doslovno:
SELECT id FROM employees
 WHERE lower(trim(coalesce(email,''))) = lower(trim(coalesce(auth.jwt() ->> 'email','')))
```

Izmereno na produkciji 07.08.2026:

| Provera | Rezultat |
|---|---:|
| `employees` ukupno | **157** |
| aktivnih | 152 |
| **sa mejlom** | **48** |
| **bez mejla** (nemaju nalog — proizvodni radnici) | **109** |
| od tih 48, ima red u sy15 `auth.users` | **48 / 48** |
| **od tih 48, ima parnjaka u 3.0 `users` po mejlu** | **48 / 48** ✅ |

🔴 **Posledica za preklop:** 109 od 157 zaposlenih **nema nalog uopšte**. Oni postoje samo
kao redovi u `employees` (grid sati, GO, kapija) i nikada se ne prijavljuju. Nema šta da im
se mapira i to je ISPRAVNO — ali svako rešenje koje pretpostavi „zaposleni = korisnik"
izgubilo bi 70% ljudi.

### 2.2 Šest uuid kolona koje JESU nalog

| Kolona | FK? | različitih vrednosti | razrešeno u 3.0 |
|---|---|---:|---:|
| `absences.archived_by` | ✅ SET NULL | 0 | — |
| `contracts.archived_by` | ✅ SET NULL | 0 | — |
| `employee_documents.uploaded_by` | ✅ SET NULL | 2 | 2/2 |
| `kadr_certificates.created_by` | ✅ NO ACTION | 0 | — |
| `kadr_medical_exams.created_by` | ✅ NO ACTION | 0 | — |
| `kadr_audit_log.actor_user_id` | ❌ **nema FK** | 35 | **35/35** ✅ |

Ukupno domen koristi **35 različitih naloga, i svih 35 ima parnjaka u 3.0** (izmereno).

### 2.3 🔴 Zamka koju je merenje sprečilo: 48 TEKSTUALNIH `*_by` kolona

Domen ima **48 kolona** čije ime zvuči kao nalog (`submitted_by`, `reviewed_by`,
`created_by`, `approved_by`, `level1_by`, `conducted_by`, `acked_by`, `storno_by`,
`decided_by`, `added_by`, `last_edited_by`, `resolved_by`, `advance_approved_by`,
`author_email`, `rater_email`, `actor_email`, `profile_updated_by`…) — a **sve su `text`
i drže MEJL**, ne uuid.

Uzorak sa produkcije: `salary_terms.created_by = 'nenad.jarakovic@servoteh.com'`, ali i
`'import-jun-2026'` — dakle ni mejl nije uvek mejl.

Da je mapiranje rađeno „po imenu kolone" (kao što je iskušenje kod 48 kolona), sve bi ih
pokvarilo. Spisak od 6 uuid kolona je izveden iz `pg_constraint` + `information_schema`,
i skripta ima kontrolu koja pada ako se DMMF i spisak raziđu.

---

## 3. FK šavovi

### Ka spolja (domen → van domena)

| Cilj | FK-ova | Ocena |
|---|---:|---|
| `auth.users` | **5** | 🟢 rešeno — Int FK na `users.id`, 3 × SET NULL / 2 × NO ACTION |
| bilo šta drugo | **0** | — |

### 🔴 Ka unutra (van domena → domen) — 7 FK-ova, i to je razlika prema koraku 2

Održavanje je imalo **0** inbound FK-ova. Kadrovska ih ima **7**, svih 7 ka `employees`:

| Izvor | Kolona | ON DELETE | Domen |
|---|---|---|---|
| `pb_tasks` | `employee_id` | SET NULL | Projektni biro |
| `pb_work_reports` | `employee_id` | SET NULL | Projektni biro |
| `pb_eng_tips` | `author_id` | SET NULL | Projektni biro |
| `pb_notification_log` | `related_employee_id` | SET NULL | Projektni biro |
| `rev_documents` | `issued_to_employee_id` | NO ACTION | Reversi |
| `rev_documents` | `recipient_employee_id` | NO ACTION | Reversi |
| `rev_document_cutting_assignees` | `employee_id` | **RESTRICT** | Reversi |

**To znači da `employees` ne može da napusti sy15 dok PB i Reversi ne pređu** — ili se ti
FK-ovi moraju ukloniti u sy15 pre preklopa. Ovo je glavna razlika prema koraku 2 i razlog
zašto se kadrovska seli **posle** PB-a i Reversa u redosledu, iako je odluka o redosledu
vlasnikova (§8).

### Kolone koje LIČE na vezu a nisu

| Kolona | Šta je stvarno |
|---|---|
| `employees.department`, `employees.position`, `employees.team` | **TEKST** (denormalizovan naziv), pored `department_id`/`position_id` koji jesu FK |
| `job_positions.reports_to_line` | **TEKST** — naziv nadređene pozicije, ne FK. Sistematizacija se prati po IMENU |
| `katze_employee_map.katze_id` | tekst iz Katze MSSQL-a, PK ove tabele |
| 48 `*_by` kolona | mejl kao tekst (§2.3) |

---

## 4. 🔴 Nalaz 3: pet šavova ka drugim domenima koje FK graf ne pokazuje sve

| # | Šav | Kako je nađen | Zašto je opasan |
|---|---|---|---|
| **a** | **„Moj profil" PIŠE u iste tabele** — 121 dodir domena u `moj-profil.service.ts` (GO, odsustva, nadoknade, plaćeno odsustvo, razgovori, procene, sati, kapija) | `grep` nad `backend/src` | To NIJE „drugi modul koji čita", nego **drugi pisac**. Bez njega pod prekidačem, samousluga bi pisala u sy15 a kadrovska čitala 3.0 → **dve istine o godišnjem odmoru** |
| **b** | **Podešavanja drže PRAVA domena** — `podesavanja-users.service.ts` čita `kadr_grid_editor_allowlist` i `kadr_vacation_editor_allowlist` i iz njih **izvodi** `kadrovska.grid_edit` / `kadrovska.vacation_edit` | `grep` | Ako allowlist tabele odu u 3.0 a Podešavanja čitaju sy15, prava se tiho raziđu |
| **c** | 🔴 **Projektni biro** — 9 `pb_*` funkcija pominje `employees`, a `pb_current_employee_id()` je **ulaz u SVA PB prava** | `pg_get_functiondef` | PB **čeka** kadrovsku (v. §4c niže) |
| **d** | **`audit_log` je zajednički** — 4 trigera domena (`absences`, `employee_children`, `employees`, `work_hours`) pišu u `public.audit_log` (14.627 redova) koji deli **cela** sy15 baza | `pg_trigger` + telo | Ta tabela **nije** ovaj domen. 3.0 ima svoj `audit_log`. Spajanje dva različita audit traga je odluka, ne prenos |
| **e** | **Auto-zatvaranje sesija (tehnološki procesi)** čita `attendance_events`, `employees`, `job_positions` i `worker_employee_map` — da bi našlo šefa iz sistematizacije | `grep` | Kapija je izvor istine za zatvaranje sesija; razilaženje bi zaustavilo obračun rada |

### 4c. Šav ka Projektnom birou — detaljno

Devet `pb_*` funkcija referencira `employees`:
`pb_current_employee_id` · `pb_engineering_lead_by_subdept` · `pb_enqueue_notifications` ·
`pb_get_eng_tip` · `pb_get_load_stats` · `pb_get_mechanical_projecting_engineers` ·
`pb_get_team_load_stats` · `pb_get_work_report_summary` · `pb_list_eng_tips`

Uz njih idu i **4 inbound FK-a** (§3). `pb_current_employee_id()` je gejt kroz koji prolazi
svako PB pravo — a on radi `SELECT id FROM employees WHERE lower(email) = jwt.email`.

**Presuda:** PB je već preseljen po tabelama (korak 1) ali pod `PB_IZVOR=3.0` **pada sa 503**
upravo zato što `employees` nije u 3.0. Kad kadrovska pređe, PB dobija tabelu koju čeka —
ali **to je preklop PB-a, ne ovog domena**, i radi se zasebno (`PB_IZVOR`). Ovaj korak ga
samo odblokira.

---

## 5. 🔴 Plate, Katze most i 491k redova kapije

### 5.1 Plate — ko sme da vidi zarade

Mehanizam je **allowlist tabela, ne rola**. Izmereno doslovno:

```sql
CREATE FUNCTION public.current_user_can_view_salary() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (SELECT 1 FROM public.kadr_salary_viewer_allowlist a
                  WHERE lower(a.email) = lower(coalesce(public.current_user_email(), '')));
$$;
```

Sve 4 RLS politike na `salary_payroll` i sve 4 na `salary_terms` su **samo**
`current_user_can_view_salary()` — bez ijedne role, bez `is_admin`, bez `is_hr`.

**Sadržaj allowlist tabele (2 reda, izmereno):**

| mejl | napomena |
|---|---|
| `nenad.jarakovic@servoteh.com` | vlasnik — pun pristup platama |
| `nevena.knezevic@servoteh.com` | obračun zarada |

Dve srodne allowlist tabele rade isto za druga prava:

| tabela | redova | daje pravo |
|---|---:|---|
| `kadr_grid_editor_allowlist` | 5 | `can_edit_kadrovska_grid()` → `kadrovska.grid_edit` |
| `kadr_vacation_editor_allowlist` | 4 | `can_edit_vacation_balance()` → `kadrovska.vacation_edit` |

🔴 **Posledica za seobu:** te tri tabele su **PRAVA, ne šifarnik**. Ako se ne prenesu (ili se
prenesu prazne), posle preklopa **zarade ne vidi NIKO** — i to ne kao greška nego kao prazna
lista. Prenosna skripta ih prenosi sa sadržajem i ima **eksplicitnu verifikaciju** koja pada
ako je `kadr_salary_viewer_allowlist` prazna.

Uz to, `salary_payroll` ima brave koje se prenose kao mehanika:
- `trg_0_salary_payroll_immutability` — zaključan mesec (`status='paid'`) se ne menja;
  otključavanje ide isključivo kroz `kadr_payroll_unlock` koji postavlja
  `payroll.unlock_ok='on'` u svojoj transakciji. **Ime trigera počinje `trg_0_` namerno** —
  PostgreSQL okida trigere po abecedi, pa brana mora pre računanja zbirova.
- `trg_salary_payroll_totals` — `total_rsd`, `total_eur`, `second_part_rsd`.

Zatečena nedoslednost (**ne popravlja se, modul je zamrznut**): `salary_payroll` ima **0
redova** na produkciji, iako `salary_terms` ima 143. Obračun zarada se još ne vodi u ovom
modulu (v. [ODLUKE_O_ZARADAMA.md](ODLUKE_O_ZARADAMA.md), koji je merodavan, ne kod).

### 5.2 🔴 `vacation_go_days` — 5.269 redova bez RLS-a i bez grant-a aplikaciji

Izmereno dvaput, jer je iznenađujuće:

| Provera | Rezultat |
|---|---|
| `relrowsecurity` | **`false`** — jedina tabela domena bez RLS-a (ostalih 63 ga ima) |
| RLS politika | **0** |
| `has_table_privilege('servosync2_app', …, 'SELECT')` | **`false`** — **jedina tabela domena** koju aplikativna rola ne sme da čita |
| ko sme `SELECT` | samo `postgres`, `service_role`, `supabase_admin` |
| redova | **5.269** |

Znači: 3.0 backend **nikad** nije direktno čitao ovu tabelu — do nje stiže samo kroz
`SECURITY DEFINER` funkcije (`go_ledger`, `kadr_grid_set_go`, `kadr_grant_bonus_go`…).

**Posledica za runbook:** prenosna skripta **mora da se pokrene pod rolom koja sme da čita**
(`supabase_admin`), ne pod `servosync2_app`. To je izmereno **na probnoj bazi** — prvi
pokušaj pod aplikativnom rolom pao je sa `42501 permission denied for table vacation_go_days`.

### 5.3 🔴 Katze most — piše `attendance_events`, i NIJE pod prekidačem

| Šta | Izmereno |
|---|---|
| gde živi | `bridge/src/jobs/syncKatze.js`, systemd `servoteh-bridge` na ubuntusrv |
| upaljen? | **da** — `ENABLE_JOB_KATZE=true`, `KATZE_SQL_SERVER=192.168.64.10` |
| ritam | svakih **10 minuta** (`SCHEDULE_KATZE_CRON`) |
| izvor | Katze MSSQL `dbo.tblReg` (+ `Terminal`), inkrementalno po `IDReg` |
| watermark | RPC `attendance_katze_max_idreg()` = `MAX(external_id::bigint)` nad `attendance_events` |
| upis | Supabase REST `upsert('attendance_events', …, 'source,external_id')` |
| dodatno čita | `employee_badges` (mapiranje kartica) |
| poslednji prolazi | `bridge_sync_log`: uspešni, na svakih 10 min (22:00, 22:10, 22:20, 22:30…) |

🔴 **Zašto ovo nije pod `KADROVSKA_IZVOR`:** most je **odvojen proces van ovog repo-a** i
prekidač ga fizički ne dodiruje. Pod `KADROVSKA_IZVOR=3.0` most bi i dalje pisao u sy15, a
aplikacija čitala 3.0 — **kapija bi se tiho zaledila na dan preklopa**. Nema greške u logu,
nema 503; samo prestanu nova kucanja, a to se primeti tek kad neko pogleda grid.

**Kako se preusmerava (i kada):** most piše preko Supabase REST-a (`SUPABASE_URL`), a 3.0
nema PostgREST sloj. Zato preusmeravanje **nije promena jedne env promenljive** nego posao
za sebe — mostu treba direktan PG upis u 3.0 (`pg` klijent + `DATABASE_URL`) ili novi
endpoint u 3.0 backendu. Procena: **1–2 dana** (§7, blokada 8). Izvodi se **istog dana kad i
korak 7 runbook-a**, ne ranije (inače bi 3.0 dobio kucanja koja sy15 nema, pa bi povratak
tražio ručno prenošenje).

Watermark je `MAX(external_id)` nad ciljnom tabelom, pa je most **samooporavljiv**: čim
proradi nad 3.0, pokupiće sve što je propustio — pod uslovom da je istorija preneta (§5.4).

### 5.4 🔴 491.206 redova `attendance_events` — seli se sve ili se seče?

Izmereno 07.08.2026 (`count(*)`, raspon `1999-12-31` → `2026-08-07 19:55`):

| godina | redova | | godina | redova |
|---|---:|---|---|---:|
| ≤2014 | 67 | | 2021 | 42.621 |
| 2015 | 4.245 | | 2022 | 74.818 |
| 2017 | 4.925 | | 2023 | 74.661 |
| 2018 | 16.807 | | 2024 | 66.583 |
| 2019 | 17.760 | | 2025 | 93.524 |
| 2020 | 15.115 | | **2026** | **80.080** |

Zaposlenih u tabeli: **138**. Veličina: **140 MB od 152 MB celog domena**.

**Skripta podrazumevano prenosi SVE** — nema tihog gubitka istorije. Postoji prekidač
`--attendance-from=YYYY-MM-DD` koji seče, ali:

> 🔴 **REZ JE ODLUKA VLASNIKA, NE TEHNIČKA.** Kapija je dokazni materijal za obračun zarada i
> radnog vremena. Ako se seče, mora se znati **do kad se čuva original u sy15** i **ko sme da
> mu priđe posle gašenja**. Pitanje je prosleđeno u §8, nije odlučeno ovde.
>
> Za orijentaciju: rez na 2021-01-01 ostavlja **432.287** redova (uklanja 58.919, ~12%) — to
> nije ušteda koja opravdava gubitak. Rez na 2024-01-01 ostavlja **240.187** (uklanja 51%).

---

## 6. Prekidač `KADROVSKA_IZVOR` — dizajn koji prati POZIVAOCE

### 6.1 Merenje pre uvođenja (obavezno, po pouci incidenta 06.08.)

`grep` za 64 imena tabela domena nad **celim** `backend/src` daje **osam** mesta koja
stvarno dodiruju domen:

| # | Gde | Šta | Pod prekidačem? |
|---|---|---|---|
| 1 | `modules/kadrovska/*` | 80 `withUserMapped` (čitanje) + 16 u mutacijama + grid-autofill | ✅ da |
| 2 | 🔴 `modules/moj-profil/*` | **121 dodir** — samousluga PIŠE u iste tabele (§4a) | ✅ da |
| 3 | `modules/podesavanja/*` | org. struktura, kompetencije, praznici, **2 allowlist tabele iz kojih se izvode prava** (§4b) | ✅ da |
| 4 | `modules/scheduler/sy15-cron-jobs.ts` | 6 poslova: `kadr-hr-reminders`, `kadr-corrective-reminders`, `kadr-onboarding-reminders`, `kadr-attendance-alerts`, `kadr-attendance-digest`, `kadr-weekly-risk` | ✅ da |
| 5 | `modules/scheduler/dispatch/notify-dispatch.service.ts` | **samo** `dispatchKadr()` | ✅ da |
| 6 | `modules/scheduler/daily-brief.service.ts` | ko je danas odsutan (`absences` + `work_hours` + `v_employees_safe`) | ✅ da |
| 7 | 🔴 `modules/tech-processes/session-auto-close.service.ts` | kapija + sistematizacija (§4e) | ✅ da |
| 8 | `modules/ai-chat/*` | 12 `ai_chat_*` alata nad domenom | ✅ da |

### 6.2 🔴 Šta prekidač NAMERNO NE dodiruje — i zašto je to jezgro pouke

`employees` je **jedina tabela u sy15 koju čita pola aplikacije**. Stavljanje SVIH njenih
čitalaca pod ovaj prekidač oborilo bi četiri tuđa modula istog trenutka — tačno ono što je
bio incident 06.08. Zato su namerno **izvan**:

| Modul | Šta čita | Zašto ostaje izvan |
|---|---|---|
| `projektni-biro` | `employees` (join u `pb_tasks`), `pb_current_employee_id()` | ima svoj `PB_IZVOR`; pod `3.0` ionako pada sa 503 |
| `reversi` | `employees` (pretraga, barkod kartice, odeljenje primaoca) + 3 inbound FK | korak 3, svoj `REVERSI_IZVOR` |
| `sastanci` | `kadr_holidays` (kalendar praznika) | čita sy15 **i pod `SASTANCI_IZVOR=3.0`**, namerno i read-only |
| `odrzavanje` | jedan uski `SELECT` nad `employees` (auto-detekcija vozača) | već preseljeno; ne zavisi od kadrovske |

Ta četiri mesta su **šav, ne propust**. Oni čitaju sy15 kopiju koja ostaje netaknuta dok
sy15 živi.

Isto važi i unutar `notify-dispatch.service.ts`: pod ovaj prekidač ide **isključivo**
`dispatchKadr()`; `dispatchMaint()` i `dispatchPb()` se ne diraju.

### 6.3 Ponašanje

`KADROVSKA_IZVOR=sy15` (**podrazumevano, i za svaku neprepoznatu vrednost**) = kao do sada.

`KADROVSKA_IZVOR=3.0` = sve gorenavedeno vraća **503 sa imenom putanje** i uputstvom za
povratak. Logika još nije prepisana (§7), pa je to **brana, ne radno stanje**.

Zajedničko telo je postojeći `backend/src/common/sy15/izvor-prekidac.ts` — nije pisano
iznova. `KadrovskaSourceService` **ne čita** zastareli `SASTANCI_PB_IZVOR`.

---

## 7. Šta je urađeno u ovoj grani

| Šta | Gde | Stanje |
|---|---|---|
| 63 Prisma modela (736 kolona) | `backend/prisma/schema.prisma` | ✅ `prisma validate` čist |
| Migracija (63 tabele, 5+72 FK, 109 CHECK, 111 indeksa, 36 trigera, 45 DB default-a) | `backend/prisma/migrations/20260808120000_kadrovska_seoba_sy15/` | ✅ **primenjena na probnu bazu, NE na prod** |
| Skripta prenosa | `backend/scripts/migrate-kadrovska-sy15.ts` | ✅ dry-run + `--apply` + `--verify-only` + `--show-columns` + `--attendance-from` |
| Prekidač `KADROVSKA_IZVOR` | `backend/src/common/sy15/kadrovska-source.service.ts` | ✅ nezavisan, bez alias-a, brana u 4 getera |
| Env red | `backend/.env.example` | ✅ |
| Testovi prekidača | `backend/src/common/sy15/izvor-prekidaci.spec.ts` | ✅ 53 testa (+10) |
| Zajednički helper identiteta | `backend/scripts/lib/sy15-identity.ts` | ✅ **ponovo iskorišćen, nije menjan** |

### Prenosne odluke (sve izmerene)

1. **UUID PK-ovi se zadržavaju** → prenos je egzaktno idempotentan (upsert po ključu).
2. **6 uuid kolona `auth.users` → `users.id`** (Int), FK-ovi SQL-only. Ostalih 48 `*_by`
   kolona su **tekst/mejl** i prenose se doslovno (§2.3).
3. **0 PG enuma** — sve vrednosti statusa drži 110 CHECK ograničenja, prepisanih doslovno.
4. **72 unutrašnja FK-a ostaju prave Prisma relacije**; **samoreferentnih i kružnih FK-ova
   NEMA** (izmereno: 0), pa nema ni drugog prolaza kao kod održavanja.
5. **RLS se ne prenosi** (167 politika) → `KadrovskaAuthzService` (još ne postoji, §7 blok. 1).
6. **Trigeri se dele:** 36 mehanika se prenosi, 23 logika se prepisuje (spisak u migraciji §6b).
7. **`departments` → `kadr_departments`**, `worker_employee_map` se **spaja** (§1, nalaz 1).
8. **11 `serial` sekvenci + `attendance_events` identity se posle prenosa POMERAJU** na
   `max(id)` — inače prvi novi red pada na duplikat PK-a (pouka „Incident sekvence 27.07").
9. **Fajlovi ostaju u sy15 storage-u** — prenose se samo putanje.

### 🔴 Nalaz 4: `attendance_events` je `GENERATED ALWAYS AS IDENTITY`

U sy15 je `id` **`GENERATED ALWAYS`**, što blokira eksplicitan `INSERT` bez
`OVERRIDING SYSTEM VALUE`. U 3.0 je namerno **`BY DEFAULT`** (Prisma `@default(autoincrement())`),
da prenos može da upiše postojećih 491.206 id-jeva. Sekvenca se posle pomera (odluka 8).

### 🔴 Nalaz 5: triger kapije ide OBRNUTO od očekivanog

`attendance_fill_event_ts()` u sy15 računa **`event_ts` IZ `event_ts_local`**, ne obrnuto:

```sql
IF NEW.event_ts_local IS NOT NULL THEN
  NEW.event_ts := NEW.event_ts_local AT TIME ZONE 'Europe/Belgrade';
END IF;
```

Prva verzija ovde je bila napisana „po logici" (local iz ts) i **pomerila bi svaki događaj za
1–2 sata**. Uhvaćeno tako što je telo pročitano sa žive baze, a ne pretpostavljeno.
(Ista klasa kao pouka „Vremena u bazi su UTC bez zone".)

### 🔴 Nalaz 6: `full_name` je „PREZIME IME", ne „ime prezime"

`employees_sync_full_name()` radi `concat_ws(' ', v_last, v_first)`. Pretpostavka bi tiho
preokrenula **sva imena** pri prvom upisu. Dokazano na probnoj bazi:
unos `first='Petar', last='Petrovic'` → `full_name = 'Petrovic Petar'`.

### 🔴 Nalaz 7: `btree_gist` — 3.0 ga do sada nije tražio

`absences_no_overlap_per_employee` je GiST indeks nad `(employee_id uuid, daterange(...))`.
Bez ekstenzije `btree_gist` PostgreSQL javi `42704 uuid has no default operator class for
gist`. sy15 je ima; 3.0 nije. Migracija sada radi `CREATE EXTENSION IF NOT EXISTS btree_gist`.
**Uhvaćeno na probnoj bazi, nije pretpostavljeno.**

### 🔴 Nalaz 8: prenos ne sme pod aplikativnom rolom

Prvi `--apply` pod `servosync2_app` pao je sa `42501 permission denied for table
vacation_go_days` (§5.2). Prenos ide pod `supabase_admin`. To je sada u runbook-u, korak 3.

### Dokaz izvodljivosti (izvršen, ne pretpostavljen)

Napravljena je **odvojena baza `kadr_proba`** (servosync-pg kluster), primenjen **ceo lanac
migracija** (121 migracija, `migrate status` → „Database schema is up to date!", bez drift-a),
učitani FK ciljevi (`users` 71, `workers` 174, `worker_employee_map` 79 — kopija sa
produkcije), pa je skripta pročitala **živu sy15** (samo SELECT) i upisala.

| Provera | Rezultat |
|---|---|
| struktura | **63 tabele · 736 kolona · 63 PK · 76 FK · 109 CHECK · 198 indeksa · 36 trigera** |
| mapa identiteta (nalozi) | **35/35**, sekcija BLOKADE prazna |
| mapa identiteta (zaposleni) | **48/48** po mejlu; 109 bez mejla (ispravno) |
| dry-run | prošao bez blokada |
| `--apply` | v. §7 „stanje" |

Uz to **13 ponašajnih proba** na istoj bazi (sve prošle):

| # | Proba | Rezultat |
|---|---|---|
| P1 | `full_name` iz first+last | `Petrovic Petar` (PREZIME IME) ✅ |
| P2 | DB default `gen_random_uuid()` | id dodeljen bez Prisma klijenta ✅ |
| P3 | `updated_at` triger | pomeren ✅ |
| P4 | CHECK odbija nevalidan tip odsustva | `23514` ✅ |
| P5 | GiST indeks preklapanja odsustva | postoji ✅ |
| P6 | `event_ts` iz `event_ts_local` (zona) | tačno ✅ |
| P7 | `attendance_events` identity | id > 0 ✅ |
| P8 | preklapanje zahteva za GO | `23P01` ✅ |
| P9 | zbir zarade (100.000 + 5.000 prevoz) | `total_rsd=105000.00`, `second_part=105000.00` ✅ |
| P10 | brava zaključanog meseca | `42501` ✅ |
| P11 | otključavanje kroz `payroll.unlock_ok='on'` | prolazi ✅ |
| P12 | zatvaranje prethodnih uslova rada | `effective_to = 2026-05-31` ✅ |
| P13 | UQ `source+external_id` na kapiji | `23505` ✅ |

**Probna baza se posle dokaza briše.**

### Provere

| Provera | Rezultat |
|---|---|
| `npx prisma validate` | ✅ čist |
| 🔴 `npx tsc -p tsconfig.build.json --noEmit` | ✅ **nula grešaka** (obavezan prevod — `ts-jest` maskira `@Body()` DTO klasu grešaka) |
| `npx tsc --noEmit` (sa spec fajlovima) | ✅ **nula NOVIH.** Ostaju 4 **zatečene** grupe u spec fajlovima (`handovers/handover-draft-print`, `kadrovska.zahtev-026`, `kamata`, `moj-profil.zahtev-026`) — iste kao 06.08., nijedan od njih nije u diff-u ove grane |
| `npx jest izvor-prekidaci` | ✅ **53 testa** (+10 novih za `KADROVSKA_IZVOR`) |
| ceo lanac migracija | ✅ 121 migracija, `migrate status` čist, bez drift-a |

---

## 8. 🔴 ŠTA OSTAJE ZA PREKLOP (pun spisak)

Šema, migracija, prekidač i prenos su gotovi. Modul pod `3.0` **nije prepisan** — rangirano
po tome šta zaustavlja preklop.

| # | Blokada | Obim (mereno) | Procena |
|---|---|---|---:|
| **1** | 🔴 **167 RLS politika → `KadrovskaAuthzService`** (ne postoji). Ovo je najveći pojedinačni posao u celoj seobi sy15 — više politika nego u bilo kom domenu do sada. Gejtova koje politike zovu: 7 | 63 tabele | **5–8 dana** |
| **2** | **116 funkcija koje kod dodiruje**, od kojih **54 nema prefiks domena** (§1 nalaz 2). Najveće: `kadr_schedule_hr_reminders` (**39.357 znakova**), `hr_upsert_salary_payroll` (9.186), `kadr_queue_vacation_notification` (9.884), `kadr_queue_weekly_risk_summary` (9.197), `hr_vacreq_approve` (8.749) | 63 `SECURITY DEFINER` | **6–9 dana** |
| **3** | **121 poziv kroz branjene getere** (`withUserMapped` 80 + mutacije 16 + „Moj profil" 25) treba prevesti na 3.0 Prisma put | ~150 REST ruta | **4–6 dana** |
| **4** | **19 view-ova** (§1). **15 je `security_invoker = true`** — RLS se primenjivao I KROZ VIEW, pa scope MORA eksplicitno u upit. `v_employees_safe` uz to **maskira PII** (`personal_id`, `bank_account`, `address`…) kroz `current_user_can_manage_employee_pii()` — bez tog maskiranja JMBG-ovi bi procurili | + 4 `v_rev_*` (Reversi) | **2–3 dana** |
| **5** | **23 „logika" trigera** — 10 × `kadr_audit_log_trigger`, 4 × `audit_row_change` (u tuđi `audit_log`), guard PII kolona, guard sistematizacije, 2 guarda samoocene, sync lekarskih pregleda, web-push, 2 × `set_created_by` | v. migracija §6b | **2 dana** |
| **6** | 🔴 **7 INBOUND FK-ova** (§3): `employees` ne može da napusti sy15 dok PB (4 FK) i Reversi (3 FK) ne pređu, ili dok se ti FK-ovi ne uklone u sy15 | 7 constraint-a | **odluka + korak 3** |
| **7** | 🔴 **Šav ka „Moj profil"** (§4a): 121 dodir, i to UPISI. Mora se prepisati zajedno sa kadrovskom, ne posle | | uračunato u 3 |
| **8** | 🔴 **KATZE MOST** (§5.3): mostu treba direktan PG upis u 3.0 umesto Supabase REST-a | `bridge/src/jobs/syncKatze.js` | **1–2 dana** |
| **9** | **Registar idempotencije**: `runIdempotentRls` pozivi pišu u sy15 `rev_api_idempotency`; 3.0 već ima generički `api_idempotency` + `IdempotencyService` — treba samo zameniti poziv | | **~3 h** |
| **10** | **12 AI alata** (§1) — brana postavljena; prepis `ai_chat_*` nad 3.0 bazom | `dodaj_belesku` i `dodaj_uputstvo` su upisi | **1–2 dana** |
| **11** | **`audit_log` je zajednički** (§4d) — spajanje sy15 i 3.0 audit traga je odluka o proizvodu | 14.627 redova | **odluka** |
| **12** | **Fajlovi u sy15 storage-u** (dokumenti zaposlenih, ugovori, sertifikati) — putanje prenete, URL-ovi važe | | **posebno** |

**Zbir: ~22–33 dana** do punog rada pod `3.0` (bez odluka iz 6 i 11). Sam prenos podataka
je **~10–20 minuta** (491k redova kapije nosi najviše).

> 📏 Poređenja radi: održavanje je bilo ~10–14 dana. Kadrovska je **2–2,5× veći posao** —
> 167 politika prema 102, 116 funkcija prema 59, 19 view-ova prema 13, i **7 inbound FK-ova
> prema 0**.

### Šta pod `3.0` RADI od 08.08.

Ništa iz modula — i to je namerno. Ovaj korak isporučuje **šemu, prenos, prekidač i merenje**;
`3.0` je zasad položaj u kome sve pada sa 503 i imenuje putanju.

---

## 9. 🔴 Odluke koje čekaju Nenada (ne kod)

1. **Rez istorije kapije** (§5.4). 491.206 redova / 140 MB. Seli se sve ili se seče? Ako se
   seče — do kad se čuva original u sy15 i ko mu sme prići posle gašenja? *Preporuka: preneti
   SVE; rez na 2021 uklanja samo 12% a trajno gubi dokazni materijal.*
2. **Redosled seobe** (§3, blokada 6). `employees` ima 7 inbound FK-ova iz PB-a i Reversa.
   Ili kadrovska ide **posle** koraka 3 (reversi+lokacije), ili se ti FK-ovi uklone u sy15
   pre preklopa. *Preporuka: kadrovska posle Reversa — FK-ovi su tada suvišni sami od sebe.*
3. **`audit_log`** (§4d, blokada 11). sy15 ima 14.627 redova zajedničkog audit traga koji
   deli cela baza; 3.0 ima svoj. Spajaju se, ili sy15 ostaje zamrznut kao arhiva?
4. **Katze most** (§5.3, blokada 8). Ko i kada radi preusmeravanje — i da li se most u
   međuvremenu gasi na sat vremena preklopa (nula gubitka, jer je watermark samooporavljiv)?
5. **`vacation_go_days` bez RLS-a** (§5.2). 5.269 redova, nema nijednu politiku, aplikacija
   je ne sme čitati. Zatečeno stanje — **nije popravljano jer je modul zamrznut**. Da li se
   pri preklopu dodaje scope u `KadrovskaAuthzService` ili se ostavlja kao DEFINER-only?
6. **Termin preklopa** i **odmrzavanje modula** — seoba ukida zamrzavanje §K; kada?

### Zatečeni kvarovi (POPISANI, NE POPRAVLJENI — modul je zamrznut)

| # | Šta je zatečeno | Kako je nađeno |
|---|---|---|
| K1 | `vacation_go_days`: 5.269 redova, **0 RLS politika**, aplikativna rola nema `SELECT`. Pristup samo kroz DEFINER funkcije | `pg_class.relrowsecurity` + `has_table_privilege` |
| K2 | `salary_payroll` ima **0 redova** iako `salary_terms` ima 143 — obračun zarada se ne vodi u modulu | `count(*)` |
| K3 | `worker_employee_map` postoji u **dve baze** sa različitim popunjenostima (95 vs 79, unija 103) — nijedna nije potpuna | poređenje obe tabele |
| K4 | `kadr_grid_editor_allowlist` i `kadr_vacation_editor_allowlist` sadrže **legacy nalog sa greškom u domenu**: `nevena.knezevic@sevroteh.com` (sevroteh, ne servoteh) | čitanje sadržaja |
| K5 | `salary_terms.created_by` sadrži i vrednosti koje nisu mejl (`'import-jun-2026'`) | uzorak |
| K6 | `kadr_pulse_notify_dispatch` pg_cron posao postoji ali je **`active=false`** — dispečer se pogoni iz 3.0 schedulera | `cron.job` |

---

## 10. Runbook — šta uraditi na produkciji kad odluka padne

⚠️ Koraci 0–7 prenose **podatke** i **bezbedni su**: `KADROVSKA_IZVOR` ostaje `sy15`, pa modul
ceo taj period radi normalno nad sy15. Prenos se sme uraditi i **danima pre** preklopa
(i ponoviti — idempotentan je).

| # | Korak | Trajanje | Povratak |
|---|---|---|---|
| 0 | `ssh ubuntusrv` + noćni klon 3.0 baze (postojeći backup) | 5 min | — |
| 1 | `npm run migrate:prod` (`prisma migrate deploy`) — kreira 63 prazne tabele + `btree_gist` | ~30 s | tabele su nove i prazne → `DROP` je bezbedan |
| 2 | `migrate status` mora biti čist (bez drift-a) | 5 s | — |
| 3 | 🔴 **Pripremi konekciju pod `supabase_admin`** (ne `servosync2_app`) — `vacation_go_days` je bez grant-a (§5.2, nalaz 8) | 1 min | — |
| 4 | `... migrate-kadrovska-sy15.ts --show-columns` — revizija mape (736 kolona, 6/6 user kolona) | 5 s | ništa se ne čita ni ne piše |
| 5 | `... ` (**dry-run**) — sekcija „BLOKADE" mora biti prazna; mapa naloga **35/35**, mapa zaposlenih **48/48** | ~2 min | ništa se ne piše |
| 6 | `... --apply` — 510.455 redova + spajanje `worker_employee_map` + pomeranje 12 sekvenci | **~10–20 min** | `TRUNCATE` 63 tabele + ponovi (sy15 je i dalje netaknut izvor) |
| 7 | `... --verify-only` — svih 63 reda `OK`, **plus 3 kontrole koje `count(*)` ne hvata**: allowlist zarada (2 reda, ne sme biti prazna), `worker_employee_map` ≥ 95, `employees` sa mejlom = 48 | ~2 min | — |
| **8** | **`KADROVSKA_IZVOR=3.0`** u `backend.env` + `docker compose up -d` 🔴 (**NE `docker restart`** — env se peče pri CREATE; potvrdi sa `printenv`). `SASTANCI_IZVOR`, `PB_IZVOR`, `ODRZAVANJE_IZVOR`, `SCADA_IZVOR` se **NE diraju** | ~3 min | **`KADROVSKA_IZVOR=sy15` + recreate = ~3 min** |
| **9** | 🔴 **Preusmeri Katze most** (§5.3) — bez ovoga kapija tiho staje | v. blokada 8 | vrati stari `bridge` |
| 10 | `ssh ubuntusrv 'bash -s' < backend/scripts/post-deploy-verify.sh` — mora 🟢 EXIT 0 | ~1 min | — |
| 11 | Ručna proba: otvori grid meseca, podnesi zahtev za GO iz „Mog profila", proveri da se zaraditelj vidi na `/kadrovska/plate` | 10 min | v. korak 8 |

⚠️ **Koraci 8–9 se NE izvode dok blokade 1–5 iz §8 nisu zatvorene** — pod `3.0` ceo modul
sada pada sa 503. Koraci 0–7 se izvode kad se hoće.

### Povratak (rollback)

Jedan potez, bez deploy-a koda: **`KADROVSKA_IZVOR=sy15` + `docker compose up -d` (~3 min).**
sy15 se tokom seobe ne dira, pa je u svakom trenutku važeći izvor. Prenete 3.0 tabele ostaju
kao mrtav teret dok se ne pokuša ponovo — ne smetaju.

### ⚠️ Tačke bez povratka

1. Čim se pod `KADROVSKA_IZVOR=3.0` upiše **prvi** zahtev za GO, sat u gridu ili odsustvo,
   3.0 ima podatak koji sy15 nema. Od tada povratak traži ručno prenošenje nazad.
2. 🔴 **Specifično za ovaj domen — KAPIJA.** Ako je most preusmeren (korak 9), sva nova
   kucanja idu u 3.0. Povratak posle toga znači da sy15 **fali ceo period** — i to se ne
   vidi kao greška nego kao rupa u gridu. Zato: ili most preusmeriti **istovremeno** sa
   korakom 8, ili ga **zaustaviti** za vreme probe (watermark je samooporavljiv, pa nadoknadi).
3. **Sekvence.** Ako se pod `3.0` doda odeljenje/kompetencija/pozicija, a onda vrati na sy15,
   sy15 sekvenca je iza — sledeći sy15 red dobija isti id. Pri povratku posle upisa MORA se
   ručno podići sy15 sekvenca.

### 🔴 Provera koju ne treba preskočiti (pouka incidenta 06.08.)

Posle koraka 8 proveriti u dnevniku (`scheduled_job_runs`) da **poslovi tuđih domena rade**:
`sast-action-reminders`, `sast-meeting-reminders`, `sast-weekly-auto`, `pb-enqueue`,
`pb-notify-dispatch`, `maint-deadlines`, `maint-notify-dispatch`. Nijedan nije ovaj domen i
**nijedan ne sme da padne**. To je pinovano testovima (`izvor-prekidaci.spec.ts` — 5 prekidača,
sve kombinacije), ali proveriti i na produkciji.

Očekivano je da padnu, i to samo ovih sedam: `kadr-hr-reminders`, `kadr-corrective-reminders`,
`kadr-onboarding-reminders`, `kadr-attendance-alerts`, `kadr-attendance-digest`,
`kadr-weekly-risk`, `kadr-notify-dispatch`. To je brana, ne kvar.

🔴 **I još jedna, specifična:** proveri da `sast-weekly-auto` i dalje čita `kadr_holidays`
uspešno. Sastanci to rade **read-only iz sy15 i pod `SASTANCI_IZVOR=3.0`**, namerno (§6.2) —
ako ta putanja padne, sedmični sastanci prestaju da se pomeraju sa praznika, tiho.

---

## 11. Preporuka

**Kadrovska je najteži rez u celoj seobi sy15 — i jedini koji drugi domeni ČEKAJU.**

- 🔴 **Teži nego sve pre:** 167 RLS politika (najviše u bazi), 116 funkcija od kojih 54 nema
  prefiks domena, 19 view-ova od kojih 15 `security_invoker`, i **7 inbound FK-ova** (svi
  prethodni domeni su ih imali 0).
- 🔴 **Ima živog spoljnog pisca** (Katze most) — jedini domen do sada kod koga preklop
  aplikacije nije dovoljan.
- 🟡 **Nosi PII i NOVAC** — JMBG, brojevi računa, adrese, zarade. Sloj prava se ovde ne sme
  „prepisati po analogiji"; svaka politika mora da se izmeri (pouka „Mutaciona proba je
  jedini dokaz da test vredi": traži TAČAN BROJ REDOVA za usku rolu, nikad „> 0").
- 🟢 **Lakše nego što izgleda u dva pogleda:** **0 PG enuma** (održavanje ih je imalo 23) i
  **0 kružnih FK veza** (održavanje je imalo jednu, koja je tražila drugi prolaz). Identitet
  je 48/48 i 35/35.

Predlog za sledeći potez:

1. **Doneti odluke 1, 2 i 4 iz §9 pre bilo kakvog koda** — naročito redosled (kadrovska posle
   Reversa) i sudbinu Katze mosta.
2. **Izvesti korake 0–7 runbook-a kad god** (prenos je bezbedan i ponovljiv) — time se rizik
   deli i podaci se već zateknu u 3.0.
3. **Prepisati modul po blokadama, redosledom koji je radio kod sastanaka i održavanja:**
   prvo **read-scope** (blokada 1+4 — bez njega blokada 3 postaje bezbednosni propust, a
   ovde bi to značilo procurenje JMBG-ova), pa registar idempotencije (9), pa CRUD (3), pa
   DEFINER logika (2+5).
4. **Katze most (8) raditi paralelno** — nije u istom kodu i ne blokira ostalo.

Ono što je ovde napisano važi u svakom slučaju: šema, migracija, skripta prenosa, prekidač i
merenje su gotovi i dokazani, a helper `sy15-identity.ts` je i dalje zajednički za sve
preostale korake — nije menjan.
