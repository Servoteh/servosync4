# Module Spec: Plan montaže + Plan proizvodnje + Praćenje proizvodnje — 3.0 TALAS C

| | |
|---|---|
| **Moduli (grupa)** | 1.0 „Montaža" (Plan montaže + AI izveštaji montera) + „Proizvodnja" shell (Planiranje = Plan proizvodnje, Praćenje = Praćenje proizvodnje, Pretraga delova) — sele se ZAJEDNO (dele predmete/TP/RN kontekst) |
| **Verzija spec** | 1.0 (2026-07-12) |
| **Faza** | 3.0 — Talas C (izvršava se posle Talasa B) |
| **Izvor** | 1.0 ŽIVI kod (UI: `src/ui/planMontaze/` 18 fajlova ~5.5k + `src/ui/planProizvodnje/` 11 fajlova ~5.7k + `src/ui/pracenjeProizvodnje/` 15 fajlova ~3k + `src/ui/proizvodnja/` shell 0.4k; servisi: `plan.js`+`projects.js` 639, `planProizvodnje.js` 1818, `pracenjeProizvodnje.js`+export/portfolio 1024, `montazaIzvestaji.js`+`montazaIzvestajAi.js` 489, `predmetPrioritet/PlanPrioritet/Aktivacija` 329, `drawings.js` 540 shared; mobilni: `myMontaza`/`myReports`/`myProdMachine`/`myPracenje`) + **živa baza kroz Management API (snimljeno 12.07)** |
| **Authz snapshot** | [`authz-snapshots/talasC-fn-defs-2026-07-12.sql`](authz-snapshots/talasC-fn-defs-2026-07-12.sql) — **131 politika + 77 fn (pune definicije) + 13 view-ova** |
| **Doktrina** | [`MIGRACIONA_DOKTRINA_3.0.md`](MIGRACIONA_DOKTRINA_3.0.md) — VAŽI U CELOSTI |
| **Status** | NACRT — čeka Nenadov review (§7 pitanja) |

> ⚠️ **Ključni nalaz o „dinamičkim format() politikama"**: strah iz playbook-a se NE potvrđuje
> u punoj težini. Politike u `production`/`core`/`pdm` šemama su generisane dinamički u
> migracijama, ali ŽIVI rezultat je uniforman: **SELECT = `true` (svi prijavljeni), sve
> write komande = `production.can_edit_pracenje(...)` ili `can_manage_predmet_aktivacija()`**
> (svaka pojedinačno popisana u snapshotu §A). Front te tabele ionako NIKAD ne piše direktno —
> sve mutacije idu kroz `production.*` SECURITY DEFINER RPC-ove sa sopstvenim proverama.
> ⚠️ Drugi nalaz: **non-public šeme NISU izložene kroz PostgREST** — front im prilazi kroz
> `public.*` bridge VIEW-ove (`radni_nalog`, `odeljenje`, `radnik`, `prijava_rada`,
> `v_operativna_aktivnost`…, svi `security_invoker=true`) i `public.*` thin-wrapper RPC-ove.
> Za 2.0 to znači: **isti obrazac kao Reversi/Lokacije** (GUC + postojeći RPC-ovi), bez
> Prisma modela za non-public šeme u v1.

## 0. Obim — šta se SELI, šta NE (FRONT vs POZADINA)

**SELI SE (korisnička površina):**

*Plan montaže (`/plan-montaze`, domen Montaža i servis):*
- Hub + 4 pogleda: **Plan** (tabela faza), **Gantt** (aktivan projekat), **Ukupan Gant** (svi projekti), **Izveštaji** (AI izveštaji montera).
- CRUD hijerarhije projekat → WP (nalog montaže, `rn_code`) → faza: REST upsert `projects`/`work_packages`/`phases` sa debounce save queue (700 ms) + status panelom (queued/inflight/greška).
- Faza: naziv, tip (mechanical/electrical), lokacija, datumi plan+stvarni (`actual_*_date`), inženjer, vođa montaže, status 0–3, %, **8 checkbox-a spremnosti** (Montažni crteži/Mašinske komponente/Gotova roba/Vijčana roba/Električni materijal/Alati·oprema/Termin potvrđen/Dostupna ekipa), blokator, napomena, opis, povezani crteži (`linked_drawings[]`); WP: glavni crtež sklopa (`assembly_drawing_no`).
- Spremnost/rizik su ČISTO KLIJENTSKE derivacije (`src/lib/phase.js: calcReadiness/calcRisk/applyBusinessRules` — status↔pct sync, end≥start) — portuju se 1:1 u 2.0 FE/BE util.
- Export/Import: JSON snapshot, XLSX, PDF (Gantt/Total Gantt preko html2canvas+jsPDF), Import JSON (replace, uz potvrdu).
- AI izveštaji montera: lista+filter+detalj (fotke, PDF preuzimanje), „Poveži predmet" (ručna korekcija `predmet_item_id`), **kreiranje** (desktop tab + mobilni `/m/izvestaj`): slobodan tekst + fotke → AI strukturira (edge `montaza-izvestaj-ai`, Claude vision, model iz `montaza_ai_settings`) → preview/dopune → idempotentno snimanje (klijentski UUID) + PDF + fotke u bucket `montaza-izvestaji`; ciljani retry fotki/PDF-a; broj izveštaja dodeljuje DB trigger (`IZV-GGGG-NNNN`, godišnji brojač).
- Mobilni `/m/montaza` (Plan kartice + Izveštaji), `/m/izvestaj` (novi izveštaj); 🎤 diktat (deljena `speechInput.js` → edge `stt-transcribe`/Whisper) + „AI doteraj" (`ai-refine`).

*Plan proizvodnje (`/plan-proizvodnje` → `/proizvodnja?p=planiranje`, domen Proizvodnja→Planiranje):*
- 5 tabova: **Po mašini** (izbor mašine/odeljenja → red otvorenih operacija, drag-drop redosled, status pill waiting/in_progress/blocked, napomena, HITNO, REASSIGN, pin-to-top), **Po crtežu** (pretraga svih operacija po crtežu/RN + bulk premeštanje), **Zauzetost mašina** (agregat), **Pregled svih** (matrica mašina × 5 radnih dana), **Kooperacija** (auto grupe + ručno slanje/vraćanje).
- Sve READ ide iz view lanca `v_production_operations_effective` → `v_production_operations` → `v_production_operations_pre_g4` (bigtehn_* keš + overlay + urgency + auto-koop + spremnost + G4 dorada/škart; **filter: predmet aktivan ∧ završna kontrola NIJE kucana**) — view-ovi ostaju u bazi, 2.0 čita.
- Mutacije: `production_overlays` UPSERT (status/napomena/redosled/`assigned_machine_code`/`cam_ready`/`ready_override`/kooperacija — „TP-sidra + ručni SPREMNO override"), bulk reorder, `production_urgency_overrides` upsert, RPC `reassign_production_line`/`bulk_reassign_production_lines` (⚠️ **idempotencija VEĆ postoji**: `p_client_event_uuid`, audit `ON CONFLICT (client_event_uuid, line_id) DO NOTHING`), skice `production_drawings` + bucket `production-drawings` (upload/soft-delete/signed URL).
- TP procedura modal (ceo tehnološki postupak RN-a iz `bigtehn_tech_routing_cache`), PDF crteža iz keša (`bigtehn_drawings_cache` + bucket `bigtehn-drawings`, signed URL), bridge sync banner (`bridge_sync_log`: RN/linije TP/prijave operatera), „Zašto usko grlo" modal.
- Mobilni `/m/proizvodnja` (operater bira mašinu → red operacija; status/ready override za editore).

*Praćenje proizvodnje (`/pracenje-proizvodnje` → `/proizvodnja?p=pracenje`, domen Proizvodnja→Praćenje):*
- Ekran 0 **Kontrolna tabla** (portfolio rollup po aktivnom predmetu: `get_pracenje_portfolio`), ekran 1 **Aktivni predmeti** (`get_aktivni_predmeti`; ↑↓ prioritet admin), ekran 2 **Stablo podsklopova** (`get_podsklopovi_predmeta`) + **Tabela praćenja** (`get_predmet_pracenje_izvestaj`: statusi nije_kompletirano/nema_tp/nema_crtez/nema_zavrsnu_kontrolu/kasni; korisnička napomena; ručni override statusa/mašinska/površinska; parent override; Excel/PDF izvoz), ekran 3 **RN** (`?rn=`, `get_pracenje_rn`, source `local`|`bigtehn` fallback): Tab1 Pozicije (side panel: prijave rada + crteži), Tab2 **Operativni plan** (aktivnosti po odeljenjima: upsert/zatvori/blokiraj+razlog/odblokiraj, zavisnosti, status_mode auto/manual, **promocija akcione tačke iz Sastanaka** u aktivnost).
- „Realtime" = **POLLING na 30 s** (`subscribePracenjeRn` nad `v_operativna_aktivnost`) — NIJE Supabase websocket; 2.0 v1 zadržava polling (trivijalno).
- Mobilni `/m/pracenje` (aktivni predmeti → pozicije sa punim ručnim override-om statusa).

*Deljeno u talasu:* ⭐ **plan-prioritet predmeta** (`predmet_plan_prioritet`, do 50 slotova, audit snapshot na svaku izmenu; redosled projekata u Plan montaže/PB/Lokacije/Praćenje), `drawings.js` (sanitizacija broja crteža + exists-check + signed URL — deli i Lokacije), **Pretraga delova** (`search_proizvodnja_delovi` RPC), Proizvodnja shell navigacija (`?p=`).

**NE SELI SE (pozadina — ostaje u sy15/bridge, umire ili se repointuje uz QBigTehn cutover):**
- `bridge/` Node servis (MSSQL→`bigtehn_*_cache` + `production_active_work_orders` sync: syncWorkOrders/syncProduction/syncTechRouting/drawings) — netaknut. **⚠️ `bigtehn_*` keš umire sa QBigTehn cutover-om → repoint na 2.0 `tech_processes` je MOST (playbook §4.2), NE deo ove seobe: v1 čita iste cache tabele (ista odluka kao Lokacije #1).**
- pg_cron `po_cleanup_orphaned_machines` (02:30, čisti overlay-e ka nestalim mašinama) — netaknut.
- SVI trigeri ostaju u bazi: `montaza_assign_izvestaj_broj` (brojač), `production_overlays_audit_history` + `pp_force_audit_columns`, `audit_row_change` (production.* audit), `tg_predmet_pb_project_sync` → `sync_pb_project_from_predmet` (⚠️ aktivacija predmeta AUTO-KREIRA `public.projects` red — izvor liste Plan montaže!), `tg_predmet_aktivacija_default`, `trg_ppp_snapshot`, `touch_updated_at`.
- View lanac `v_production_operations*`, bridge view-ovi nad production šemom, `v_active_bigtehn_work_orders` — ostaju u bazi ($queryRaw).
- Edge `stt-transcribe` (Whisper) i `ai-refine` — deljena infra (koristi ih i Sastanci/talas B); talas C ih samo POZIVA (v. §7-P7).
- UI za **Podešavanje predmeta** (aktivacija/`je_projektovanje_montaza`/⭐ max) živi u modulu Podešavanja → talas D; DB objekti i BE endpointi su OVDE (v. §7-P10).

## 1. Živi podaci i model (12.07, cloud=restore-izvor; re-verifikovati na sy15)

| Tabela | Redova | Prisma model? | Napomena |
|---|---:|---|---|
| `projects` / `work_packages` / `phases` | 23 / 11 / 58 | ✅ `PmProject`/`PmWorkPackage`/`PmPhase` | uuid PK; phases: `checks jsonb` (8×bool), `linked_drawings text[]`, `phase_type`, `actual_*_date`; **lista projekata = `pb_list_projects()`** (projects ⋈ predmet_aktivacija je_aktivan ∧ je_projektovanje_montaza; 22 predmeta sa flagom) |
| `projekt_bigtehn_rn` | 0 | — ($queryRaw) | veza projekat↔BigTehn RN; živi ali prazna |
| `montaza_izvestaji` / `montaza_izvestaj_fotke` / `montaza_izvestaj_brojaci` / `montaza_ai_settings` | 0 / 0 / 0 / 1 | ✅ / ✅ / — / — | izveštaji: klijentski UUID id (idempotencija VEĆ postoji), `ai_json`, `pdf_path`; brojač puni trigger; ai_settings singleton (id=1) |
| `production_overlays` (+`_history` 112) | 741 | ✅ `PpOverlay` | UNIQUE (work_order_id, line_id); history = append-only trigger, no-client-write |
| `production_urgency_overrides` | 9 | ✅ | UNIQUE work_order_id; DELETE nikad (false) — samo set/clear |
| `production_reassign_audit` | 0 | — ($queryRaw) | no-client-write; SELECT samo `can_force_plan_reassign()`; UNIQUE (client_event_uuid, line_id) |
| `production_drawings` | 0 | ✅ | soft-delete (`deleted_at`); bucket `production-drawings` |
| `production_auto_cooperation_groups` | 3 | — ($queryRaw) | admin upravlja; DELETE nikad |
| `production_active_work_orders` | 9412 | — | puni BRIDGE (MES whitelist aktivnih RN) — ne dirati |
| `bigtehn_*_cache` (items 7602, work_orders 40681, lines 185970, tech_routing 76358, drawings 5427, machines 90, customers 6244, rework_scrap 40) | — | — ($queryRaw READ) | keš, puni bridge; grants za `servosync2_app` potrebni |
| `production.predmet_aktivacija` | 7602 (86 aktivnih) | — (RPC) | trigger auto-red za svaki novi predmet; sync ka projects |
| `production.predmet_prioritet` / `predmet_plan_prioritet` (+audit 161) | 54 / 9 | — (RPC) | redosled praćenja (admin) / ⭐ top-lista (max podesiv, ceiling 50) |
| `production.radni_nalog` (+pozicija 3, lansiranje 0, saglasnost 0) / `tp_operacija` / `prijava_rada` | 47 / 5 / 7 | — (RPC/$queryRaw kroz public view-ove) | „Faza 2" lokalni RN; glavnina RN prikaza ide iz bigtehn fallback-a |
| `production.operativna_aktivnost` (+pozicija 4, blok_istorija 0) | 4 | — (RPC) | operativni plan Tab2; audit + blok istorija trigeri |
| `production.pracenje_manual_overrides` / `pracenje_parent_override` / `pracenje_proizvodnje_napomene` | 6 / 0 / 1 | — (RPC) | override-i tabele praćenja |
| `core.odeljenje` / `core.radnik` (+alias) / `core.work_center` / `pdm.drawing` | 7 / 3 / 5 / 3 | — ($queryRaw kroz public view-ove) | šifarnici Faze 2 |

**Odluka (paritet Reversi/Lokacije):** Prisma modeli u `prisma/sy15.prisma` SAMO za public
tabele koje BE piše direktno (projects/WP/phases, montaza_*, production_overlays/urgency/drawings).
**Non-public šeme se NE introspektuju u v1** — sve mutacije idu kroz postojeće `public.*`
wrapper RPC-ove (jsonb ulaz/izlaz) kroz GUC; čitanja kroz public bridge view-ove ($queryRaw).
Storage: 3 privatna bucketa (`montaza-izvestaji`, `production-drawings`, `bigtehn-drawings`) —
pristup preko sy15 storage-api presigned obrasca iz Reversi pilota; putanje fajlova ostaju
1.0-kompatibilne (paralelni rad, doktrina §C).

## 2. Žive politike + authz mapa (snapshot 12.07 — 131 politika; RE-VERIFIKOVATI na sy15 pre R1)

Obrasci (svaka politika pojedinačno u snapshotu §A):

| Obrazac | Gde | → 2.0 permisija |
|---|---|---|
| SELECT `true` (svi prijavljeni) | SVE talас-C tabele osim `production_reassign_audit` | `montaza.read` / `plan_proizvodnje.read` / `pracenje.read` |
| write `has_edit_role(project_id)` + legacy `current_user_can_edit()` (pm/leadpm) | projects, work_packages, phases, projekt_bigtehn_rn | `montaza.edit` (row-odluka OSTAJE u DB kroz GUC) |
| write `can_edit_plan_proizvodnje()` = admin/pm/menadzment | production_overlays, urgency (INSERT/UPDATE, DELETE nikad), drawings, active_work_orders | `plan_proizvodnje.edit` |
| SELECT `can_force_plan_reassign()` = admin/menadzment | production_reassign_audit | `plan_proizvodnje.force` |
| write `current_user_is_admin()` | production_auto_cooperation_groups (DELETE nikad), production.predmet_prioritet | `plan_proizvodnje.koop_admin` / `pracenje.prioritet` |
| write `can_manage_predmet_aktivacija()` = admin/menadzment | predmet_aktivacija, pracenje_manual_overrides, parent_override, napomene; RPC ⭐ plan-prioritet | `pracenje.manage` |
| write `production.can_edit_pracenje(projekat,rn)` = `has_edit_role(projekat)` ∨ admin/pm/menadzment (±project scope) | production.* RN/aktivnosti/prijave + core/pdm šifarnici | `pracenje.edit` (row-odluka u DB kroz GUC) |
| izveštaji: INSERT `autor_user_id = auth.uid()`; UPDATE/DELETE autor ∨ management ∨ admin | montaza_izvestaji (+fotke preko EXISTS) | `montaza.izvestaji` (create=svi; manage tuđih=admin/menadzment) |
| no-client-write (`false`) | overlays_history, reassign_audit, audit_log | — (samo GET) |
| storage: mizv_* (SELECT svi; INSERT autor reda; DELETE mgmt/admin) · pd_*/bd_* (SELECT `can_read_production_drawings()`, write `can_edit_plan_proizvodnje()`) | storage.objects (9 politika) | presigned na BE sa istim proverama |

**Dodele u `role-permissions.ts` (predlog):** `*.read` → sve aktivne uloge (kao danas — svaki
prijavljen); `montaza.edit` → admin, menadzment, pm, leadpm (+`tim_lider` → §7-P1);
`montaza.izvestaji` → sve aktivne uloge (autor-scope u DB), manage-tuđih → admin, menadzment;
`montaza.ai_admin` → admin; `plan_proizvodnje.edit` → admin, pm, menadzment;
`plan_proizvodnje.force` → admin, menadzment; `plan_proizvodnje.koop_admin` → admin;
`pracenje.edit` → admin, pm, menadzment (+has_edit_role širina u DB); `pracenje.manage` →
admin, menadzment; `pracenje.prioritet` → admin. ⚠️ Mutacije koje diraju `auth.uid()`
(izveštaji, prioritet updated_by) → GUC **sa `sub`** obavezan (doktrina A2).

**Skrivena pravila firme (doktrina §C — NE gubiti):**
1. **`has_edit_role()` je ŠIRI od front gate-a**: globalno uključuje i `hr` i `poslovni_admin` (front `canEdit()` = admin/leadpm/pm/menadzment) + **project-scope**: `user_roles.project_id = proj_id` daje pm/leadpm edit SAMO na tom projektu. Širina ostaje u DB (GUC); UI dodela po §2.
2. **`tim_lider` diskrepanca**: front `canEditPlanMontaze()` pušta tim_lider-a, ali save sloj (`services/plan.js`/`projects.js` koriste STROGI `canEdit()`) NIKAD ne šalje njegove izmene u bazu, a i RLS (`has_edit_role`) bi ih odbio — **izmene tim_lidera danas žive samo u localStorage njegovog browsera** (migracioni komentar to i kaže: „nema DB RLS parnjaka"). → §7-P1.
3. **Per-user override `plan_montaze_readonly`** (`user_roles.plan_montaze_readonly` → front `moduleOverrides.planMontazeReadonly`): rukovodilac sa edit rolom može biti zaključan na read-only SAMO u Plan montaži. 2.0: `user_permission_overrides` deny za `montaza.edit`.
4. **Lista projekata Plan montaže = izvedena iz Podešavanja predmeta**: `pb_list_projects()` INNER JOIN `predmet_aktivacija` (je_aktivan ∧ je_projektovanje_montaza); projekte AUTO-KREIRA trigger pri aktivaciji predmeta (spajanje sa legacy redom po normalizovanom project_code). Deli se sa PB (talas D) — isti RPC.
5. **`can_read_production_drawings()`** (storage gate za `production-drawings` I `bigtehn-drawings`): admin/menadzment/pm/leadpm/inzenjer/projektant_vodja/magacioner/poslovni_admin — **pogon (cnc_operater, tim_lider, proizvodni_radnik, monter) i hr/viewer NE mogu da otvore PDF crteža** iako vide module. → §7-P3.
6. **Kanon otvorene operacije** (svi tabovi PP): `is_done_in_bigtehn=false ∧ rn_zavrsen=false ∧ (local_status IS NULL ∨ ≠'completed') ∧ overlay_archived_at IS NULL ∧ is_cooperation_effective=false` (Kooperacija tab: =true); view dodatno krije predmet neaktivan i `plan_rn_final_control_done` (završna kontrola 8.3 kucana u BigTehn ⇒ operacija nestaje iz plana). `local_status` ciklus klika: waiting→in_progress→blocked→waiting (completed se NE piše ručno — dolazi iz BigTehn-a).
7. **Sort kanon PP**: `shift_sort_order` (ručni/pin) UVEK pre `auto_sort_bucket` (DB spremnost/hitnost) → `rok_izrade` → `prioritet_bigtehn` → RN/op tie-break. Pin-to-top = min(ručnih)−1; bulk reorder upisuje 1..n.
8. **Reassign idempotencija + force**: bez `p_force` RPC odbija ako operacija ima uslove; `p_force` traži razlog i SELECT audita je ograničen na admin/menadzment. Bulk deli JEDAN client_event_uuid za sve parove.
9. **Izveštaji montera**: broj dodeljuje BEFORE INSERT trigger iz godišnjeg brojača (`IZV-GGGG-NNNN`), ručno prosleđen broj se POŠTUJE; AI ne sme da odredi autora/datum/broj (sistemska polja iz sesije); obavezna polja pre finalizacije: datum, predmet, klijent, lokacija, početak, kraj; max 16 fotki; statusi = DB CHECK (zavrseno/delimicno/u_toku/ceka_materijal/ceka_potvrdu/dodatna_intervencija); model allowlist u DB fn + edge (opus-4-8/sonnet-4-6/haiku-4-5).
10. **Praćenje edit matrica**: Operativni plan (Tab2) = `can_edit_pracenje` (admin/**pm**/menadzment + has_edit_role širina); napomene/override-i/aktivacija = `can_manage_predmet_aktivacija` (admin/menadzment, **ne pm**); prioritet liste (↑↓) = SAMO admin; Tab1 je read-only.
11. **`logPracenjeExport` je danas MRTAV**: piše u `audit_log` koji ima no-client-write RLS → tihi fail (funkcija guta). „Istorija" u modalu aktivnosti čita `audit_log` (SELECT admin-only) → ne-admin vidi samo blok-istoriju. → §7-P4/P5.
12. **Overlay UPSERT semantika**: merge-duplicates (polja van patch-a netaknuta); `updated_by`/`created_by` = email (trigger `pp_force_audit_columns` ih forsira); history trigger snima svaku promenu.
13. **Plan montaže save**: debounce 700 ms, last-write-wins (BEZ optimistic lock-a), identitet faze se hvata u trenutku izmene (D-4 lekcija); schema-fallback za opcione kolone je LEGACY (kolone su žive na produ) — u 2.0 se NE prenosi.
14. **BigTehn data-quality**: `sanitizeDrawingNo` (trailing/pure tačke → null), revizija fallback `{broj}_A/B` pri exists-check; dash/slash duplikati (slash je kanon — memorija). Portovati util 1:1.
15. **⭐ plan-prioritet**: set briše CELU listu pa upisuje (audit trigger snima snapshot sa email-om iz GUC claims-a); validacije: max (podesivo 1..50), bez duplikata, svi id-jevi postoje u kešu; „Vrati prethodnu" čita audit.

## 3. API (predlog, tri kontrolera pod `/api/v1/`)

Konvencije: envelope `{data, meta}`, Decimal string, GUC `withUser` na SVIM pozivima (BACKEND_RULES §5; sub obavezan).

**`/montaza/*`** (Plan montaže + izveštaji)

| Endpoint | Metod | Permisija | 1.0 poreklo |
|---|---|---|---|
| `/montaza/projects?include=tree` | GET | read | `pb_list_projects()` kroz GUC + WP + faze (⚠️ 1.0 radi N+1 po projektu/WP-u; 2.0 vraća stablo JEDNIM upitom — čisto perf, semantика ista) |
| `/montaza/projects` / `/:id` | POST/PATCH/DELETE | edit | saveProjectToDb (upsert paritet; RLS has_edit_role kroz GUC) |
| `/montaza/work-packages` / `/:id` | POST/PATCH/DELETE | edit | saveWorkPackageToDb (uklj. `assembly_drawing_no`, `rn_order`/`sort_order`) |
| `/montaza/phases` / `/:id` (+`/bulk`) | POST/PATCH/DELETE | edit | savePhaseToDb / saveAllCurrentPhases (upsert po id = prirodno idempotentno; `updated_by` na BE) |
| `/montaza/reports` | GET | read | listIzvestaji (filter status + q pretraga po 6 polja) |
| `/montaza/reports` | POST | izvestaji | sacuvajIzvestaj — **klijentski UUID id = idempotencija (postojeći mehanizam, doktrina A4)**; INSERT autor=jwt sub |
| `/montaza/reports/:id` (+`/photos`) | GET | read | detalj + fotke (signed URL-ovi) |
| `/montaza/reports/:id/predmet` | PATCH | izvestaji (autor∨manage) | poveziPredmet (RLS paritet) |
| `/montaza/reports/:id/pdf` / `/photos` | POST | izvestaji | upload PDF-a/fotki (presigned ili proxy; ciljani retry = ponovi samo neuspele) |
| `/montaza/reports/ai-generate` | POST | izvestaji | **port edge `montaza-izvestaj-ai` u NestJS** (Anthropic vision sa BE; limiti: 20k teksta, 16 slika ×4MB b64; obogaćivanje predmeta iz `bigtehn_items_cache`) — §7-P6 |
| `/montaza/ai-model` | GET/PUT | read / ai_admin | montaza_ai_settings + `set_montaza_ai_model` (allowlist) |
| `/montaza/lookups/predmeti?q=` | GET | read | searchBigtehnItems (deli sa Lokacijama — reuse ako Talas A već ima) |
| `/montaza/lookups/drawings?codes=` | GET | read | exists-check + signed URL (`bigtehn-drawings`; gate §2-5) |

**`/plan-proizvodnje/*`**

| Endpoint | Metod | Permisija | 1.0 poreklo |
|---|---|---|---|
| `/plan-proizvodnje/machines` | GET | read | bigtehn_machines_cache |
| `/plan-proizvodnje/operations?machine=` | GET | read | RPC `plan_pp_open_ops_for_machine` (paginacija po RN, limit 100) |
| `/plan-proizvodnje/operations?dept=` | GET | read | loadOperationsForDept — dept definicije (10 tabova: sve/glodanje/struganje/brušenje/erodiranje/ažistiranje/sečenje/bravarsko/farbanje/CAM/ostalo) prevesti u BE upit; „ostalo" fallback filter na BE |
| `/plan-proizvodnje/operations/all` | GET | read | loadAllOpenOperations (min kolone, count+truncated na 10k) |
| `/plan-proizvodnje/operations/search?q=` | GET | read | po crtežu/RN (escape ilike paritet) |
| `/plan-proizvodnje/cooperation` (+`/groups`) | GET | read | listForCooperation / auto grupe |
| `/plan-proizvodnje/cooperation/groups` | POST/PATCH | koop_admin | admin upravlja auto grupama (DELETE ne postoji — paritet) |
| **`/plan-proizvodnje/overlays`** | **POST** | **edit** | upsertOverlay patch (status/note/machine/pin/cam_ready/ready_override/koop) — merge semantика |
| `/plan-proizvodnje/overlays/reorder` | POST | edit | bulk reorder (niz → shift_sort_order 1..n) |
| `/plan-proizvodnje/urgency/:workOrderId` | PUT/DELETE | edit | setUrgent/clearUrgent (DELETE = clear flag, ne red) |
| **`/plan-proizvodnje/reassign`** (+`/bulk`) | POST | edit (+force → `force` permisija) | RPC kroz GUC; **clientEventId obavezan** (postojeći mehanizam) |
| `/plan-proizvodnje/reassign/audit` | GET | force | production_reassign_audit |
| `/plan-proizvodnje/drawings` (+`/:id`) | GET/POST/DELETE | read (gate §2-5) / edit | production_drawings + presigned; soft-delete |
| `/plan-proizvodnje/tech-procedure/:workOrderId` | GET | read | loadFullTechProcedure (routing keš) |
| `/plan-proizvodnje/bridge-status` | GET | read | fetchPpBridgeSyncStatus (3 job-а iz bridge_sync_log) |
| `/plan-proizvodnje/lookups/op-snapshot` / `/tp-options` | GET | read | fetchBigtehnOpSnapshotByRnAndTp / fetchTpOptionsForPredmetOrder (dele se sa Lokacijama) |

**`/pracenje/*`**

| Endpoint | Metod | Permisija | 1.0 poreklo (svi RPC kroz GUC) |
|---|---|---|---|
| `/pracenje/portfolio` | GET | read | get_pracenje_portfolio(p_lot_qty) |
| `/pracenje/predmeti` | GET | read | get_aktivni_predmeti |
| `/pracenje/predmeti/:itemId/podsklopovi` | GET | read | get_podsklopovi_predmeta |
| `/pracenje/predmeti/:itemId/izvestaj` | GET | read | get_predmet_pracenje_izvestaj (+root_rn, lot) |
| `/pracenje/predmeti/:itemId/napomena` | PUT | manage | upsert_pracenje_proizvodnje_napomena |
| `/pracenje/predmeti/:itemId/override` | PUT | manage | upsert_pracenje_manual_override (status/mašinska/površinska) |
| `/pracenje/predmeti/:itemId/parent-override` | PUT | manage | upsert_pracenje_parent_override |
| `/pracenje/predmeti/:itemId/prioritet` | PUT | prioritet | set/shift_predmet_prioritet (admin; RPC sam štiti) |
| `/pracenje/rn/resolve` | GET | read | resolveRnId (broj/legacy_idrn/uuid → uuid) |
| `/pracenje/rn/ensure-from-bigtehn` | POST | read* | ensure_radni_nalog_iz_bigtehn (*RPC je DEFINER i danas ga zove svaki korisnik pri drill-down-u — zadržati) |
| `/pracenje/rn/:rnId` | GET | read | get_pracenje_rn (source local/bigtehn) |
| `/pracenje/rn/:rnId/operativni-plan` | GET | read | get_operativni_plan (+ po projektu) |
| `/pracenje/rn/:rnId/can-edit` | GET | read | can_edit_pracenje (FE gate paritet; ili flag u odgovoru) |
| **`/pracenje/aktivnosti`** | **POST** | **edit** | upsert_operativna_aktivnost (24 param; p_id klijentski UUID = idempotencija) |
| `/pracenje/aktivnosti/:id/zatvori` / `/blokiraj` / `/odblokiraj` | POST | edit | zatvori_aktivnost / set_blokirano(razlog!) / skini_blokadu |
| `/pracenje/aktivnosti/promote` | POST | edit | promovisi_akcionu_tacku (most iz Sastanaka — v_akcioni_plan) |
| `/pracenje/aktivnosti/:id/istorija` | GET | read (audit deo: admin) | blok_istorija + audit_log (§2-11) |
| `/pracenje/prijave?pozicija=&op=` (+bigtehn varijanta) | GET | read | prijava_rada view / get_bigtehn_prijave_za_operaciju |
| `/pracenje/lookups/odeljenja` / `/radnici` / `/akcione-tacke?projekat=` | GET | read | bridge view-ovi (odeljenje/radnik/v_akcioni_plan+sastanci meta) |
| `/pracenje/search-delovi?q=` | GET | read | search_proizvodnja_delovi (Pretraga delova tab) |
| `/pracenje/export-log` | POST | read | logPracenjeExport — **server-side insert (prvi put PRORADI, §7-P4)** |

## 4. FE (Next) — dva domena po PLAN_MODULA_MES_3.0

- **🔧 Montaža i servis** → nova sekcija u 2.0 sidebar-u: `/montaza` (hub + 4 pogleda kao 1.0: Plan/Gantt/Ukupan Gant/Izveštaji; deep-link `?view=`). Gantt/Total-Gantt = custom render (drag levo/desno/resize, scroll-dock, lokacijske boje, today-marker) — **najveći FE rizik talasa**, portuje se namenski (bez novih biblioteka bez potrebe; doktrina §C).
- **🏭 Proizvodnja** (sekcija postoji od Koraka 1): stavke **Planiranje** (`/plan-proizvodnje`: 5 tabova iz §0), **Praćenje** (`/pracenje-proizvodnje`: ekrani 0→1→2→3, deep-link `?predmet=`/`?rn=`/`#tab=` paritet), **Pretraga delova** (može kao tab Praćenja ili svoja ruta — paritet: pod-meni Proizvodnje). Redirect starih 1.0 ruta (`/proizvodnja?p=…`).
- Modali (paritet): PP — REASSIGN (single/bulk + force razlog), TP procedura, skice (upload/galerija), „Zašto usko grlo", kooperacija (partner/rok); PM — meta projekta/WP-a, opis faze, povezani crteži, glavni crtež sklopa, model faza, export/import; Praćenje — aktivnost (24 polja + zavisnosti), blokada, promocija akcione tačke, istorija.
- Izvozi klijentski kao 1.0: XLSX (SheetJS), PDF (jsPDF/html2canvas za Gantt; tabela praćenja PDF sa filterima). PDF izveštaja montera se generiše na FE pa šalje na BE (paritet putanja u bucket-u).
- **Mobilno**: 4 ekrana (`/m/montaza`, `/m/izvestaj`, `/m/proizvodnja`, `/m/pracenje`) = isti 2.0 ekrani responsive (DESIGN_SYSTEM v0.2); 🎤 diktat i „AI doteraj" = deljene komponente koje zovu postojeće edge fn (§7-P7).
- ⚠️ **Plan montaže localStorage offline keš se NE prenosi u v1** (2.0 online-only kao Reversi/Lokacije; offline = mobilni šav finalnog 3.0). Debounce save (700 ms) + status panel (queued/inflight/greška) SE prenose — to je UX ugovor modula.
- Polling refresh Praćenja (30 s) i PP bridge banner — prenose se 1:1.

## 5. Parity matrica (doktrina B — puni se TOKOM rada)

| # | Funkcija | Status |
|---|---|---|
| **Plan montaže** | | |
| 1 | Hub + 4 pogleda + deep-link `?view=` | NOT_STARTED |
| 2 | Lista projekata (pb_list_projects ⋈ aktivacija) + ⭐ redosled | NOT_STARTED |
| 3 | Plan tabela: faze CRUD + 8 checks + statusi/pct + business rules (status↔pct, end≥start) | NOT_STARTED |
| 4 | Filteri (search/lokacija/status/vođa/spremnost/datumi/rizik) + sakrij završene | NOT_STARTED |
| 5 | Debounce save + status panel + identitet-po-izmeni (D-4) | NOT_STARTED |
| 6 | Meta modali projekat/WP (rok, PM/leadPM mejlovi, rn_code/rn_order, lokacije) | NOT_STARTED |
| 7 | Gantt (drag/resize, boje lokacija) + Ukupan Gant (svi projekti, drag preko WP granica) | NOT_STARTED |
| 8 | Opis faze + povezani crteži + glavni crtež sklopa (PDF exists-check + signed URL) | NOT_STARTED |
| 9 | Export JSON/XLSX/PDF (Gantt+Total) + Import JSON | NOT_STARTED |
| 10 | Per-user override plan_montaze_readonly (deny montaza.edit) | NOT_STARTED |
| 11 | AI izveštaji: lista + filter + detalj (fotke, PDF) + poveži predmet | NOT_STARTED |
| 12 | AI izveštaji: kreiranje (tekst+fotke → AI → preview → idempotentno snimanje + retry fotki/PDF) | NOT_STARTED |
| 13 | AI generisanje na BE (port edge; model allowlist + admin izbor) | NOT_STARTED |
| 14 | Mobilni /m/montaza + /m/izvestaj (responsive) + 🎤 diktat | NOT_STARTED |
| **Plan proizvodnje** | | |
| 15 | Po mašini: izbor mašine/odeljenja + red operacija (RPC paginacija po RN) | NOT_STARTED |
| 16 | Status pill ciklus + napomena + drag-drop reorder + pin-to-top | NOT_STARTED |
| 17 | HITNO set/clear (+razlog) | NOT_STARTED |
| 18 | REASSIGN single/bulk + force (+razlog) + idempotencija clientEventId | NOT_STARTED |
| 19 | CAM ready + ready_override (TP-sidra ručni SPREMNO) | NOT_STARTED |
| 20 | Po crtežu: pretraga + bulk premeštanje | NOT_STARTED |
| 21 | Zauzetost mašina (agregat) + Pregled svih (matrica 5 radnih dana, praznici) | NOT_STARTED |
| 22 | Kooperacija: auto grupe (admin CRUD bez DELETE) + ručno slanje/vraćanje (partner/rok) | NOT_STARTED |
| 23 | Skice: upload/galerija/soft-delete + signed URL (gate can_read_production_drawings) | NOT_STARTED |
| 24 | TP procedura modal + PDF crteža iz keša | NOT_STARTED |
| 25 | Bridge sync banner (3 job-а) | NOT_STARTED |
| 26 | Mobilni /m/proizvodnja (red po mašini; edit za editore) | NOT_STARTED |
| **Praćenje proizvodnje** | | |
| 27 | Kontrolna tabla (portfolio: status/napredak/filteri/sort) | NOT_STARTED |
| 28 | Aktivni predmeti (lista + ↑↓ prioritet admin) | NOT_STARTED |
| 29 | Stablo podsklopova + drill-down (ensure_radni_nalog_iz_bigtehn) | NOT_STARTED |
| 30 | Tabela praćenja: izveštaj + statusi + filteri + napomena + manual/parent override | NOT_STARTED |
| 31 | Excel/PDF izvoz tabele + Tab1 Excel (+ export-log koji RADI, server-side) | NOT_STARTED |
| 32 | RN ekran Tab1: pozicije local/bigtehn fallback + side panel (prijave + crteži) | NOT_STARTED |
| 33 | RN ekran Tab2: operativni plan CRUD + zatvori/blokada/odblokiraj + zavisnosti + auto/manual status | NOT_STARTED |
| 34 | Promocija akcione tačke (Sastanci most) + istorija (blokade svi, audit admin) | NOT_STARTED |
| 35 | Polling refresh 30 s + deep-link ruter (predmet/rn/#tab, popstate) | NOT_STARTED |
| 36 | Pretraga delova (search_proizvodnja_delovi → otvara RN) | NOT_STARTED |
| 37 | Mobilni /m/pracenje (predmeti → pozicije + override) | NOT_STARTED |
| **Presečno** | | |
| 38 | e2e permission matrica (read/edit/manage/force/koop_admin/prioritet/ai_admin × uloge × 200/403; row asercije autor-scope izveštaja i project-scope pm) | NOT_STARTED |
| 39 | GUC sub claim na svim mutacijama (auth.uid() putevi: izveštaji, prioritet, aktivnosti) | NOT_STARTED |
| 40 | Grants za `servosync2_app` (write na 9 public tabela, EXECUTE na ~35 front RPC, SELECT na bigtehn keš + bridge view-ove + 3 bucketa) — migracija u 1.0 repo, primena kao supabase_admin | NOT_STARTED |

## 6. Redosled izvođenja (R-faze za CEO talas)

| Faza | Šta | Gate |
|---|---|---|
| R0 | Nenadov review spec-a (§7) + re-verifikacija snapshot-a na ŽIVOJ sy15 (cloud je restore-izvor; naročito montaza_izvestaji count i politike) + grants migracija | odobreno |
| R1 | BE read: Prisma modeli (public) + SVI GET endpointi (3 kontrolera) + permisije `montaza.*`/`plan_proizvodnje.*`/`pracenje.*` + e2e read matrica | read paritet |
| R2 | BE mutacije: PM CRUD (GUC/has_edit_role) + izveštaji (idempotentni POST + storage + AI port) + PP overlays/urgency/reassign/drawings + Praćenje RPC-ovi + e2e full matrica | write paritet |
| R3 | FE: /montaza (4 pogleda, Gantt port!) + /plan-proizvodnje (5 tabova) + /pracenje-proizvodnje (4 ekrana) + modali + izvozi + 4 mobilna ekrana responsive | UI paritet |
| R4 | Živi smoke (pun ciklus: aktiviraj predmet → projekat se pojavi u PM → faza edit → PP reassign+status → Praćenje override+aktivnost → izveštaj montera sa fotkama/PDF) + Playwright happy-path + paralelni rad → hub preklop (3 kartice) | parity gate (doktrina D) |
| R5 | Retrospektiva tempa → PROCENA_SEOBE update (četvrta merna tačka) | kalibracija |

Interni redosled unutar talasa (najmanji rizik → najveći): Praćenje (čist RPC sloj) →
Plan proizvodnje (view čitanja + overlay write) → Plan montaže (Gantt FE + AI port).

## 7. Otvorena pitanja (Nenad presuđuje; svako sa predlogom)

> ✅ **PRESUĐENO 12.07.2026 (Nenad): „VAŽE PREDLOZI" — sva pitanja + H1–H4 usvojeni bez izuzetaka.**

1. **`tim_lider` edit Plana montaže je danas fantomski** (§2-2): front dozvoljava, ali izmene ne stižu u bazu (save sloj `canEdit()` + RLS bez tim_lider-a) — žive samo u localStorage tog browsera i nestaju na reload sa DB-a. **Predlog:** u 2.0 dati tim_lider-u PRAVI edit — dodela `montaza.edit` u role-permissions + proširiti `has_edit_role()` (ili GUC poziv sa dopunom) za tim_lider; eksplicitno odstupanje od 1.0 sa razlogom „1.0 ponašanje je bag-by-omission".
2. **`has_edit_role` širina (hr, poslovni_admin)**: DB dozvoljava edit PM tabela i za hr/poslovni_admin, front ih ne pušta. **Predlog:** paritet — DB širina ostaje (GUC), UI dodela `montaza.edit` BEZ hr/poslovni_admin (kao danas); zabeleženo kao pravilo firme, ne dirati fn.
3. **Pogon ne može da otvori PDF crteža** (`can_read_production_drawings` bez cnc_operater/tim_lider/proizvodni_radnik/monter) iako vidi Plan proizvodnje/Praćenje. **Predlog:** v1 = strogi paritet (isti gate na presigned); odmah otvoriti follow-up odluku da se doda bar `cnc_operater` (izgleda kao propust, ali je možda namerno — crteži su IP).
4. **Export-log Praćenja nikad nije radio** (audit_log no-client-write). **Predlog:** 2.0 loguje izvoz server-side na BE (INSERT kao servisni nalog u audit_log ili nova mala tabela) — funkcija prvi put proradi; alternativа: izbaciti logovanje.
5. **Istorija aktivnosti — audit deo admin-only** (RLS na audit_log). **Predlog:** paritet (BE vraća audit sekciju samo adminu, blokade svima); ne širiti.
6. **Edge `montaza-izvestaj-ai` → NestJS port odmah?** **Predlog:** DA — Anthropic poziv sa BE (ključ u env), identičan prompt/tool-schema/limiti/model-allowlist; 1.0 edge ostaje živ za paralelni rad do preklopa. (Obrazac se poklapa sa AI asistentom iz Talasa B — uskladiti implementacije.)
7. **STT (`stt-transcribe`) + `ai-refine`**: deljena infra sa Sastancima (Talas B). **Predlog:** Talas C ih NE seli — 2.0 FE zove postojeće edge funkcije (isti URL/JWT) dok ih Talas B/pozadinska konsolidacija ne portuje; samo omotati u deljenu FE komponentu.
8. **N+1 load Plana montaže** (po projektu WP-ovi, po WP-u faze — 23 projekta ≈ 35+ upita). **Predlog:** 2.0 GET vraća celo stablo jednim upitom (BE join); čisto perf poboljšanje, semantika/redosled isti — dozvoljeno odstupanje uz zabelešku.
9. **`bigtehn_*` MOST — potvrda obima**: v1 čita ISTE keš tabele iz sy15 (kao Lokacije odluka #1); repoint Plan proizvodnje/Praćenja na 2.0 `tech_processes` = zaseban most uz QBigTehn cutover (playbook §4.2), NE deo ovog talasa. **Predlog:** potvrditi (bridge, `production_active_work_orders`, view lanac i pg_cron ostaju netaknuti).
10. **Podešavanje predmeta + ⭐ plan-prioritet**: DB objekti su talас-C domen, a admin UI živi u Podešavanjima (Talas D). **Predlog:** BE endpointi za `list/set_predmet_aktivacija` + `get/set_predmet_plan_prioritet(_max/_prev)` idu u Talas C (`pracenje.manage` permisija), UI ekran ostaje u Talasu D i samo se veže na gotove endpointe.
11. **Pretraga delova** — mesto u 2.0 navigaciji: 1.0 je treći pod-meni „Proizvodnje". **Predlog:** tab unutar `/pracenje-proizvodnje` (otvara RN drill-down), bez svoje rute; stara ruta redirect.

**Procena:** Plan montaže **1,5–2 MN** (Gantt port + AI izveštaji; authz lak), Plan proizvodnje
**1,5–2 MN** (čitanja su view-ovi, mutacije tanke, idempotencija već postoji; niže od ranije
procene jer nema RPC prepisivanja), Praćenje **1,5–2,5 MN** (politike se pokazale uniformnim;
19 RPC-ova ali svi jsonb kroz GUC; FE ekrani 4 nivoa). **Talas C ukupno: ~4,5–6,5 MN**
(ranija gruba procena 5–8 MN — snižena po nalazu da su „format() politike" uniformne i da
front nikad ne piše non-public šeme direktno).
