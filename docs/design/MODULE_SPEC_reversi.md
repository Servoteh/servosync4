# Module Spec: Reversi (zaduženja alata) — 3.0 PILOT

| | |
|---|---|
| **Modul** | Reversi — zaduženja alata, radne odeće/LZO, kooperacione robe, rezni alat; inventar + potpisnice |
| **Verzija spec** | 1.0 (2026-07-10) |
| **Faza** | **3.0-B (PILOT)** — prvi 1.0 modul koji se seli na 2.0 stack |
| **Izvor** | 1.0 ŽIVI kod (`src/services/reversiService.js` 1623 LOC + `src/ui/reversi/` 28 fajlova) + **žive `pg_policies`/`pg_proc` (snimljeno 10.07)** |
| **Authz snapshot** | [`authz-snapshots/reversi-fn-defs-2026-07-10.sql`](authz-snapshots/reversi-fn-defs-2026-07-10.sql) (23 fn, pune definicije) |
| **Status** | Spec odobren (Nenad, 10.07) — R0 ✅ re-verifikovano na živoj sy15 (42 politike, 0 drift vs snapshot); R1 u toku |

> Pilot bira Reversi jer je samostalan i mali (žive količine 10.07: 47 alata, 26 dokumenata, 41 stavka,
> 27 recipient lokacija; rezni alat šema postoji ali još 0 podataka) — merimo tempo pre težih modula.
> ⚠️ Playbook tracker je vodio Reversi kao „bez zavisnosti" — **inventar koda pokazuje da NIJE tako**: vidi §0.

## 0. KLJUČNA ARHITEKTONSKA ODLUKA PILOTA — podaci se NE sele

**Nalaz:** `rev_issue_reversal`/`rev_confirm_return` u JEDNOJ transakciji pišu u `rev_documents` +
`rev_document_lines` + `rev_tool_stock_ledger` **+ `loc_item_placements`/`loc_create_movement` (modul
Lokacije!)**. Atomarnost postoji samo dok su rev_* i loc_* u istoj bazi. Seljenje rev_* tabela u 2.0 bazu
pre seobe Lokacija = izgubljena atomarnost ili distribuirane transakcije (ne radimo to).

**Odluka (predlog, po ROADMAP §3 „NestJS se u 3.0 kači na istu bazu"):**
- rev_* tabele **OSTAJU u sy15 (1.0) bazi**. 2.0 backend dobija **drugi datasource** ka sy15 bazi
  (ista mašina, `ubuntusrv`): zaseban Prisma schema fajl (`prisma/sy15.prisma`, poseban client output) ili
  pg Pool. U pilotu se seli **kod i authz**, ne podaci.
- Posledice (sve pozitivne za pilot):
  1. **Nema initial load / delta resync / tombstones** — ceo §4 playbook-a za ovaj modul otpada.
  2. **Paralelni rad je trivijalan i bezbedan** — 1.0 UI i novi 2.0 UI rade nad ISTIM podacima;
     „cutover" modula = čist UI preklop (hub kartica → 2.0 ruta), sa 1.0 UI kao instant-fallback.
  3. Transakcije sa loc_* ostaju atomarne (ista baza).
- Da li rev_* IKAD fizički seli u 2.0 bazu → odlučuje se pri seobi Lokacija (§9 P2), ne sada.

## 1. Domenski model (14 tabela — Prisma introspect nad sy15, uuid PK se ZADRŽAVA)

| Tabela | Redova (10.07) | Uloga |
|---|---:|---|
| `rev_tools` | 47 | jedinica ručnog alata/opreme/LZO; `is_quantity`/`is_consumable` + `total_qty`; status active/scrapped/lost |
| `rev_documents` | 26 | revers zaglavlje; `doc_type` TOOL/COOPERATION_GOODS/CUTTING_TOOL; status OPEN/PARTIALLY_RETURNED/RETURNED; primalac EMPLOYEE/DEPARTMENT/EXTERNAL_COMPANY; `bulk_import_legacy_key` (idempotencija); `pdf_storage_path` |
| `rev_document_lines` | 41 | stavke; `line_type` TOOL/PRODUCTION_PART; `line_status` ISSUED/RETURNED/CONSUMED; `returned_quantity`; `issue_movement_id` (→loc) |
| `rev_tool_stock_ledger` | 1 | pokreti količinskog/potrošnog: RECEIPT/RETURN/ADJUST/WRITE_OFF/ISSUE (append-only) |
| `rev_recipient_locations` | 27 | sintetičke loc lokacije primalaca |
| `rev_cutting_tool_catalog` / `rev_cutting_tool_stock` / `rev_document_cutting_assignees` | 0 | rezni alat (šema živa, podaci tek stižu) |
| `rev_inventory_groups` / `subgroups` / `subsubgroups` | 3/45/0 | klasifikacija; `is_seeded` štiti DELETE |
| `rev_machine_heads` / `rev_tool_batteries` / `rev_tool_service_log` | 0/2/0 | kartica mašine (glave) i kartica alata (baterije, servisi) |

**Trigeri koji se moraju očuvati/portovati** (žive na sy15): `rev_tools_set_barcode`/`set_item_ref` (BEFORE INSERT),
`rev_check_tools_subgroup_group`/`subsubgroup`/`cutting_subgroup_group` (guard klasifikacije), `touch_updated_at`.
Pošto tabele ostaju u sy15 bazi → trigeri OSTAJU u bazi, ništa se ne portuje u pilotu.

**Views (13 koje front zove):** `v_rev_my_issued_tools`, `v_rev_my_consumed`, `v_rev_my_issued_cutting_tools`,
`v_rev_my_machines_cutting_tools`, `v_rev_stock_ledger_detail`, `v_rev_cts_machine_stock`, `v_rev_cts_by_machine`,
`v_rev_cts_by_employee`, `v_rev_warehouse_unified`, `v_rev_inventory_all_locations`, `v_rev_inventory_with_groups`,
`v_rev_machines` (nad `maint_machines`; REVOKE anon), `v_rev_otpisani_alat`. → u 2.0: GET endpoints koji čitaju
view-ove ($queryRaw) — view-ovi ostaju u bazi (jeftino, paritet 1:1). „Moje" view-ovi zavise od
`rev_current_employee_id()` (email→employees) → vidi GUC u §3.

## 2. Žive politike (pg_policies snapshot 10.07) — obrazac

Izmereno: **42 politike na 14 tabela**, čist obrazac (izuzeci eksplicitno):

| Obrazac | Tabele | 2.0 prevod |
|---|---|---|
| SELECT `true` (svi authenticated) | sve OSIM `rev_tool_stock_ledger` | `@RequirePermission('reversi.read')` |
| INSERT/UPDATE (+ALL) `rev_can_manage()` | sve write tabele | `@RequirePermission('reversi.manage')` |
| DELETE `rev_can_manage() AND NOT is_seeded` | inventory_groups/subgroups/subsubgroups | servisna provera `isSeeded` → 409 |
| DELETE `rev_can_manage()` | machine_heads, tool_batteries, tool_service_log | `reversi.manage` |
| INSERT line samo u OPEN dokument | rev_document_lines (`d.status='OPEN'`) | servisna provera → 409 |
| SELECT `rev_can_manage()` (JEDINI ne-javni read) | **rev_tool_stock_ledger** | ledger GET = `reversi.manage` |

**`rev_can_manage()`** (DEFINER): `user_roles.role IN ('admin','menadzment','pm','leadpm','magacioner')`
po `lower(email)` + `is_active`. Front paritet: `canManageReversi()` — iste role.
**`rev_current_employee_id()`**: `employees.id` po emailu (aktivan). **Team scope:** `get_team_issued_tools()`
→ `current_user_manages_employee` (TL/šef vidi zaduženja svog tima) — NIJE u frontu, samo DB.

## 3. Authz u 2.0 (paritet §7 playbook-a)

- **Permission ključevi (novo u `permissions.ts`):** `reversi.read`, `reversi.manage`, `reversi.team_read`.
- **Dodela po katalogu uloga (AUTHZ_UNIFIED):** `read` → sve aktivne uloge (kao danas: svaki prijavljen);
  `manage` → `admin`, `menadzment`, `magacioner` odmah + `pm`/`leadpm` pri aktivaciji tih uloga u 3.0
  (⚠️ pm/leadpm su u 2.0 katalogu rezervisane — dodela ide u `role-permissions.ts` čim se uloge aktiviraju);
  `team_read` → `tim_lider`, `sef` + manage uloge.
- **GUC most (ključni trik pilota):** transakcioni RPC-ovi i „moje/tim" view-ovi u bazi čitaju
  `auth.jwt()->>'email'`. NestJS sy15-adapter u SVAKOJ transakciji radi
  `set_config('request.jwt.claims', '{"email":"<user.email>","role":"authenticated"}', true)`
  → postojeće DB funkcije (rev_can_manage, rev_current_employee_id, current_user_manages_employee) rade
  netaknute. Isti obrazac koji već koristimo u Management API skriptama.
- **Faza A (pilot):** NestJS guard (coarse) + poziv POSTOJEĆIH DB funkcija kroz GUC (row/mutacije) — nula
  prepisivanja poslovne logike, paritet po konstrukciji. **Faza B (posle pilota, opciono):** port tela
  funkcija u TS servise; tek tada nativni RLS flip (AUTHZ_UNIFIED mehanizam).

## 4. API (predlog, `/api/v1/reversi/*`)

| Endpoint | Metod | Permisija | Napomena |
|---|---|---|---|
| `/reversi/documents` (+`/:id`) | GET | read | filteri: status, doc_type, primalac; +count |
| `/reversi/documents/:id/pdf-meta` | PATCH | manage | `pdf_storage_path`, `pdf_generated_at` |
| `/reversi/tools` (+`/:id`) | GET/POST/PATCH | read / manage | filteri = FETCH_TOOLS_SORTABLE allowlist iz 1.0 |
| `/reversi/cutting-tools` (+stock, +`/:id`) | GET/POST/PATCH | read / manage | katalog + stanje po lokaciji |
| `/reversi/inventory-groups[/sub…]` | GET/POST/PATCH/DELETE | read / manage | DELETE guard `is_seeded` → 409 |
| `/reversi/machine-heads`, `/tool-batteries`, `/tool-services` | CRUD | read / manage | kartica mašine/alata |
| `/reversi/ledger` | GET | **manage** | jedini ne-javni read (paritet politike) |
| **`/reversi/issue`** | POST | manage | tx: dokument+stavke+loc pokret+ledger; **`clientEventId` obavezan** |
| **`/reversi/return`** | POST | manage | tx povraćaj (ručni/kooperacija) |
| **`/reversi/cutting-issue`**, **`/cutting-return`** | POST | manage | tx rezni (na mašinu / u magacin) |
| `/reversi/tools/:id/stock-delta` | POST | manage | `rev_hand_tool_apply_delta` |
| `/reversi/cutting-tools/:id/seed-stock` | POST | manage | `rev_cutting_tool_seed_stock` |
| `/reversi/tools/:id/write-off`, `/restore` | POST | manage | otpis / vraćanje |
| `/reversi/bulk-import` | POST | manage | ⚠️ NOVO NA BACKENDU — 1.0 to radi klijentski (§6) |
| `/reversi/reports/my-issued`, `/my-consumed`, `/my-machines-cutting`, `/warehouse`, `/by-machine`, `/by-employee`, `/scrapped`, `/machines` | GET | read | čitaju postojeće view-ove |
| `/reversi/reports/team-issued` | GET | team_read | `get_team_issued_tools()` kroz GUC |
| `/reversi/documents/:id/signature-pdf` | POST/GET | manage / read | presigned upload/download, bucket `reversal-pdf` (§7) |

Konvencije: envelope `{data, meta}`, cursor paginacija, Decimal string — po BACKEND_RULES §5.

## 5. Transakcione akcije — port

Faza A: servisna metoda = `sy15.$transaction` → `set_config(GUC)` → `SELECT rev_issue_reversal($1::jsonb)`
(itd.) — telo ostaje u bazi. **Novo (obavezno): idempotency sloj** — `clientEventId uuid` u payload-u svih
6 transakcionih akcija; unique index (nova kolona `client_event_id` na `rev_documents` + na ledger za delte);
ponovljen ključ → vrati postojeći rezultat (200, `idempotent:true`). Danas idempotenciju ima SAMO bulk import
(`bulk_import_legacy_key`) — ručni `issueDialog`/`quickReturnModal` dupli klik = dupli dokument (poznat rizik).

## 6. FE (Next) — ekrani

Pet tabova (paritet 1.0): **Izdavanje i povraćaj** (workbench: hero Izdaj/Vrati, urgentno, aktivni dokumenti,
HID skener) · **Stanje magacina** (unified warehouse + prijem/seed + CSV) · **Mašine** (katalog + kartica:
rezni na mašini, glave, istorija) · **Moji alati** (self-service; + „moj tim" za TL/šefa) · **Otpisan alat**
(manage-only). Modali: Izdaj (skener/ručno; radnik/odeljenje/firma/kooperacija), Brzi povraćaj (skener),
detalj dokumenta + potpisnica PDF, bulk import, štampa nalepnica (TSPL2 → mrežni proxy — zajednički print
servis sa modulom Štampa, tracker §5), kamera skener (BarcodeDetector + fallback). **Responsive V1**
(DESIGN_SYSTEM v0.2) — pokriva i današnji `/m/reversi` (mobilni = isti ekrani).

## 7. Storage

Bucket `reversal-pdf` (potpisnice; klijentski jsPDF → upload). 2.0: presigned URL (MinIO/S3 presečni sloj,
MODULI-MASTER-PLAN §1); upload prestaje da bude fire-and-forget (1.0 guta grešku → dokument bez PDF-a):
POST vraća 201 tek po potvrdi upload-a, retry na FE.

## 8. e2e permission matrica (dokaz pariteta — bez ovoga nema „gotovo")

Uloge × endpointi: `admin`/`menadzment`/`magacioner` (+`pm`/`leadpm` kad se aktiviraju) → 200 na manage;
`monter`/`proizvodni_radnik`/`cnc_operater`/`viewer` → 200 read + **403 na SVE manage** + `/ledger` 403;
`tim_lider`/`sef` → team-issued 200 sa row asercijom (samo SVOJ tim); „moje" rute vraćaju isključivo redove
ulogovanog (row asercija po email→employee). DELETE seeded grupe → 409. Stavka u ne-OPEN dokument → 409.
Ponovljen `clientEventId` → 200 idempotent, bez novog reda.

## 9. Redosled izvođenja (pilot)

| Korak | Šta | Izlaz |
|---|---|---|
| R0 | **Review ovog spec-a (Nenad)** + re-verifikacija snapshot-a na ŽIVOJ sy15 (ssh je 10.07 bio nedostupan; snapshot je sa zamrznutog clouda = restore-izvor) | odobren spec |
| R1 | BE: sy15 datasource + GUC adapter; `reversi.*` permisije; read endpoints (tabele+view-ovi); e2e read matrica | read paritet |
| R2 | BE: 6 tx akcija (Faza A kroz DB fn) + idempotency + bulk-import endpoint + storage presigned; e2e full matrica | write paritet |
| R3 | FE: 5 tabova + modali + skener; responsive | UI paritet |
| R4 | Paralelni rad (ista baza!) → hub kartica Reversi pokazuje 2.0 rutu (obrazac „iframe→ruta", sekcija „Oprema i energija") → 1.0 UI fallback ~1 ned → gašenje 1.0 Reversi koda | modul u 3.0 |
| R5 | Retrospektiva tempa → kalibracija tracker-a §5 za ostale module | izmeren tempo |

## 10. Otvorena pitanja

1. **pm/leadpm** — rezervisane u 2.0 katalogu, a u `rev_can_manage()` su danas manage: aktivirati ih u 3.0
   katalogu odmah uz pilot, ili ih privremeno mapirati na `menadzment`? (predlog: aktivirati — trivijalno)
2. **Fizičko seljenje rev_* u 2.0 bazu** — odluka se donosi tek uz seobu Lokacija (P2); do tada sy15 = operativna baza modula.
3. **Print proxy (TSPL2)** — ostaje mrežni proxy iz browsera ili zajednički print servis (modul Štampa)? Pilot: ostaje kao danas.
4. **`onboarding.js` čita `rev_document_lines`** (offboarding checklist u 1.0 Kadrovskoj) — potrošač van modula;
   pošto tabele ostaju u sy15 bazi, ništa se ne lomi — zabeležiti za seobu Kadrovske.
