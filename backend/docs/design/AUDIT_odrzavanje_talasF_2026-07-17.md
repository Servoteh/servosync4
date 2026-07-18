# AUDIT: Održavanje (CMMS) — Talas F, zero-loss revizija 1.0 ↔ 2.0 — 2026-07-17

| | |
|---|---|
| **Svrha** | Dubinski zero-loss audit (obrazac Kadrovska/Lokacije) + živa verifikacija, kao ulaz za FIX→CUTOVER |
| **Spec** | [`MODULE_SPEC_odrzavanje_30.md`](MODULE_SPEC_odrzavanje_30.md) (presuđen 12.07) + [`MIGRACIONA_DOKTRINA_3.0.md`](MIGRACIONA_DOKTRINA_3.0.md) |
| **Auditovano** | 1.0 `origin/main` `d3b6ddd` (18.336 linija maint koda) ↔ 2.0 BE `origin/main` `33bf7d5` (`src/modules/odrzavanje`, 5.860 linija) ↔ 2.0 FE `integration/r3-fe` == FE `main` (23 fajla; **ŽIVO** na `servosync2.servoteh.com/odrzavanje` = 200) |
| **Metod** | 49 agenata: 8 domenskih popisa (svaki 1.0 fajl u celosti) → adversarna verifikacija SVAKOG gapa (skeptik pokušava da obori) → živa sy15 DB re-verifikacija → kritičar kompletnosti |
| **Rezultat** | **104 gapa** (87 CONFIRMED posle adversarne provere: **24 HIGH / 44 MEDIUM / 19 LOW**; 12 PARTIAL; 1 REFUTED; 4 UNVERIFIED) |
| **Presuda** | **NO-GO za cutover danas.** Put do GO = plan F2 (§6): ≈7 MN u 7 paketa, Opus multiagenti |

---

## 1. Rezime — gde je Talas F stvarno

- BE R1 (read) + R2 (write) su **na 2.0 main-u i deployovani** (2 adversarna review-a prošla: `831249c`, `c175ce6`).
- FE R3 je **na FE main-u i živ**, ali je **tanak skelet**: jedna stranica + 22 tab/dialog komponente,
  ~3.000 linija naspram 14.882 linija 1.0 UI-ja. Nikad nije prošao zero-loss review — tracker ocena
  „~78%" je bila optimistična; realno stanje po matrici: **4 OK / 40 PARTIAL / 3 MISSING / 1 UNKNOWN** (od 48).
- **Ključni obrazac (dobra vest):** gubitak je pretežno FE. BE endpointi i api-klijent hook-ovi za
  veliki deo funkcija POSTOJE ali ih FE ne poziva (0 upotreba): `usePatchVehicleCore`, `useRestoreVehicle`,
  `useUpdateDriver/useArchiveDriver/useRestoreDriver`, `useLinkPartToVehicle/useUnlinkPartFromVehicle`,
  `usePatchItAssetCore/useUpsertItDetails/usePatchFacilityCore/useUpsertFacilityDetails/useRestoreAsset`,
  `useUpdateAssetServicePlan`, `useUpdatePart`, `useUploadDocument/useUpdateDocument`,
  `useCreateNotificationRule`, `useUpdateLocation`, `assignableUsers`+`PATCH assignedTo`… → FIX je
  pretežno „žičenje" FE-a, ne gradnja BE-a.
- Stvarno nedostajući BE (uži spisak, §6 F2-P0): maint-profili CRUD, `lookups/employees`, WO↔sredstvo join,
  filteri (mašine/WO/zalihe), computed „due" kolone servisnih planova, pečatiranje `started_at/completed_at`,
  WO-deo→kretanje zalihe, `clientEventId` na event rutama, `cadastral_parcels` u Prisma modelu.

## 2. Živa verifikacija

### 2.1 sy15 DB re-verify (doktrina A5/R0) — snapshot 12.07 uglavnom TAČAN, ali 2 premise pale

| Nalaz | Težina |
|---|---|
| **Dispatch pipeline više NIJE mrtav**: `maint_dispatch_dequeue/mark_sent/mark_failed` POSTOJE na živoj sy15 i outbox je ISPRAŽNJEN (40/40 `sent`, 0 `queued`). Spec §0/§2.6/§7.1 („pipeline mrtav; oživljavanje = zasebna odluka") je zastareo — najverovatnije posledica cutover-a 1.5 (aktivacija schedulera + edge fn na sy15, 10.07). | **HIGH** (spec ispravka) |
| `servosync2_app` je **BYPASSRLS**: za 2.0 promet 102 RLS politike važe SAMO kroz `withUserRls` (SET LOCAL ROLE authenticated). BE authz-agent je potvrdio da sve mutacije/čitanja idu kroz `withUserRls` — ali ovo mora ostati zapisano kao invarijanta. | MEDIUM (dokumentovati) |
| Bez drifta: **102 politike, 34 trigera, 16 view-ova svi `security_invoker=true`, cron job 15 aktivan (07:00), bucket privatan + 4 politike, `maint_attach_incident_files` postoji, `maint_facility_type_lookup` ne postoji** (paritet §7.5 važi). Redovi: samo živi rast (incidenti 12→15, WO 132→134…). | INFO |

### 2.2 Živi BE probe (playbook Faza 1.1–1.2, read-only) — **BE u celosti živ**

- Login 201 (admin nalog); **31/31 literalnih GET ruta = 200**; **20/20 parametrizovanih (realni id) = 200**;
  write-probe: `{}` → 400 sa preciznim class-validator porukama; lažni UUID → 404; ParseUUIDPipe → 400. Nula 5xx.
- **[MEDIUM] `GET /documents/:id/url` → 422 za SVE dokumente (2/2)**: „Potpisivanje URL-a nije uspelo (storage 404)"
  — ruta živa, ali storage OBJEKTI ne postoje u bucket-u (`documents/asset/...`, `documents/work_order/...`).
  **Gap seobe storage sadržaja** (maint objekti nisu u on-prem bucket-u) → provera/migracija u F2-P6.
- **[ŽIVI DOKAZ za gap `canManageMaintTasks`]**: `/me` za ERP admina vraća `canManageMaintTasks:false`
  (sve ostale kapije true) — potvrda da je 2.0 gate uži od 1.0 (v. §5, F2-P1).
- 6 `:id` ruta preskočeno jer su tabele na produ prazne (tasks/checks/it-assets/facilities/parts/suppliers/locations
  = 0 redova) — nema koda za sumnju, ali te rute nisu pozitivno potvrđene (pokriće ih P6 smoke sa test podacima).

### 2.3 Rupe pokrivanja koje je našao kritičar (ugrađene u F2 plan)

1. **`servosync2_app` BYPASSRLS + neproverena SET-ROLE disciplina**: niko nije sistematski dokazao da SVAKA
   mutacija ide kroz `withUserRls` (jedan propust = zaobiđene sve 102 politike) → F2-P0 uvodi lint/test pravilo
   + P6 e2e nad živim RLS (ne mock).
2. **Kontradikcija §2.5.4 (prijava kvara = opšte pravo)**: snapshot sadrži `fix_maint_incidents_insert_policy`
   koja traži floor-read/profil — spec tvrdnja „samo `reported_by=auth.uid()`" verovatno NE važi na živoj bazi
   → razrešiti u F2-P0 (pg_policies čitanje + presuda, utiče na `odrzavanje.report` dodelu) — §8 P5.
3. **§2.5.14 `maint_machines_sync_to_loc`** (most ka Talasu A) i **§2.5.11–13, 16, 18, 20** verifikovani samo
   čitanjem/komentarima — runtime dokaz ide u P6 smoke (uklj. da 2.0 upis mašine okida sync, zaliha sme u minus,
   `updated_by`, deadline-check dedupe).
4. **`maintFormatters.js`** (jedini nepokriven fajl): status labele Radi/Smetnje/Zastoj/Održavanje + badge klase —
   label-paritet u P1; `vehicle_owners` kao zaseban šifarnik-ekran u P3.
5. **Prazna/loading stanja, responsive prelom desktop tabova, dark tema bedževa** — niko nije ocenio → deo
   P1–P5 DoD-a + P6 klik-testa.
6. **Dispatch živ** menja i ponašanje: 2.0 upis incidenta danas realno okida slanje (major/critical) —
   P6 smoke mora potvrditi da nema duplih/neočekivanih notifikacija.

## 3. Matrica 48 — zbirno stanje po stavkama

- **OK (4):** #4 potvrda kontrole · #12 auto-WO/notify trigeri kroz 2.0 upis · #18 rename RPC · #43 foto incidenta kroz `maint_attach_incident_files` (presuda §7.3 ispravno primenjena)
- **MISSING (3):** #33 Board · #36 Dokumenta globalno (upload ne postoji → modul mrtav) · #40 Profili održavanja (ni BE ni FE)
- **PARTIAL (40):** sve ostalo — jezgro toka radi, ali polja/filteri/akcije/kartice sistematski osiromašeni (detalji §4–§5)
- **UNKNOWN (1):** #48 živi smoke pun ciklus — izvodi se u F2-P6

## 4. HIGH nalazi — 24 potvrđena (svaki preživeo adversarnu proveru)

| # | Domen | Gap | Ključni dokaz |
|---|---|---|---|
| H1 | jezgro | **Mašina: pun edit nemoguć** — karton menja SAMO `name`, create ima 6 od ~13 polja | `masina-card-dialog.tsx:173-184` vs `maintCatalogTab.js:764-1027` |
| H2 | jezgro | **QR preko eksternog `api.qrserver.com`** — curi šifre sredstava na internet, pada na LAN/on-prem, nije inline QR | `masina-card-dialog.tsx:152-156` vs lokalni canvas `maintAssetQr.js:6-11` |
| H3 | jezgro | **Incident bez DODELE** — BE ima `assignableUsers`+`PATCH assignedTo`, FE nema UI | `incident-detail-dialog.tsx` vs `maintIncidentDialog.js:109-118` |
| H4 | RN | **WO ne prikazuje sredstvo** (kanban+detalj) niti linkove „Otvori mašinu/incident" — na tabli od 134 naloga ne zna se za koju mašinu je koji | BE `service.ts:585-666` ne džoinuje `maint_assets` |
| H5 | RN | **Dodavanje dela na WO više ne skida zalihu** — 1.0 auto-kreira `out` kretanje + vezuje `part_id`; 2.0 upisuje samo `wo_part` red → potrošnja delova prestaje da utiče na stanje | `wo-detail-dialog.tsx:139-154` vs `maintWorkOrdersPanel.js:677-705` |
| H6 | vozila | **Vozilo: master podaci neunosivi/neizmenjivi** (osim km) — `usePatchVehicleCore/TollTag/Shelf` postoje, 0 upotreba | `vozilo-card-dialog.tsx:68-101` |
| H7 | vozila | **Primarni vozač nedodeljiv** → veza vozač↔vozilo mrtva (kolona „Vozač", tab „Vozila") | vs `maintVehiclesPanel.js:446-455` |
| H8 | vozila | **Restore arhiviranog vozila ne postoji u UI** (BE ruta postoji) — arhiva je slepa ulica | `useRestoreVehicle` 0 upotreba |
| H9 | vozila | **Vozač: izmena/arhiva/vraćanje/brisanje ne postoje u UI** | `useUpdate/Archive/RestoreDriver` 0 upotreba |
| H10 | vozila | **Vozač create gubi većinu polja** (JMBG, lekarski, LK, adresa, tip interni/spoljni, ERP-nalog) + employees auto-detect | `vozaci-tab.tsx:86-122` vs `maintDriversPanel.js:108-207` |
| H11 | vozila | **Delovi po vozilu: link/unlink/qty_min/shelf-kartica** — samo read-only lista | `useLink/UnlinkPartToVehicle` 0 upotreba |
| H12 | IT/obj | **IT i objekti: detalji potpuno neunosivi** — create hvata samo šifru+naziv (1.0: `device_type`/`facility_type` OBAVEZNI + puni details) | `sredstva-tab.tsx:138-163` |
| H13 | IT/obj | **Arhivirana IT/objekti nevidljivi + restore nemoguć** — hard filter bez toggle-a | `sredstva-tab.tsx:42` |
| H14 | IT/obj | **Servisni plan IT/obj: edit nemoguć** + create gubi prioritet/last-done/notes/active | `sredstva-tab.tsx:118` |
| H15 | zalihe | **Deo (part): izmena nemoguća** — `useUpdatePart` 0 upotreba | `zalihe-tab.tsx:52-59` |
| H16 | zalihe | **Deo create gubi polja** (dobavljač/cena/početno stanje/proizvođač/model/opis) | vs `maintInventoryPanel.js:68-127` |
| H17 | dok | **Upload dokumenta (`maint_documents`) potpuno izostavljen** — nijedan dokument se ne može kreirati kroz 2.0 (18 kategorija, važi-do, 25MB) | `dokumenta-tab.tsx:22-53` |
| H18 | podeš | **Podešavanja: default WO prioritet, kanali, notes, dodavanje pravila** — ne mogu se podesiti (BE DTO prima) | `podesavanja-tab.tsx` vs `maintSettingsPanel.js` |
| H19 | profili | **Profili održavanja: ekran nikad izgrađen** (presuda §7.2 kaže da MORA u CMMS Podešavanja) — ni BE ruta ni FE | controller ima samo `GET /me` |
| H20 | API | **BE nema maint-profile list/CRUD endpointe** → i picker „Odgovoran" nema izvor (BE strana H19) | `odrzavanje.controller.ts` |
| H21 | mobil | **Mobilni QR sken izostavljen** (1.0: native sken → karton/prijava) — ScanOverlay postoji u 2.0, nije upotrebljen | `m/odrzavanje/page.tsx` vs `myMaintenance.js:363-373` |
| H22 | mobil | **⚠️ CUTOVER RIZIK: odštampane QR nalepnice (IT+Objekti) neće raditi** — enkodiraju `https://servosync.servoteh.com/maintenance/assets/it|facilities/<code>`; 2.0 nema te rute (jedini deep-link je `/odrzavanje?machine=`) | `appPaths.js:374-384` |
| H23 | mobil | **Mobilna (i desktop) prijava kvara samo na MAŠINE** — vozila/IT/objekti nemogući (1.0 šalje `asset_id`+`asset_type` za sva 4 tipa; BE podržava) | `prijava-kvara-dialog.tsx` |
| H24 | mobil | **Mobilni hub: kategorije Objekti i IT potpuno izostavljene** (2 od 4 tile-a) | `m/odrzavanje/page.tsx:76-96` |

## 5. MEDIUM/LOW — grupisano (44+19 potvrđenih; pun spisak u digest-u audita)

- **Jezgro:** dashboard bez klik-KPI/attention/rokova/mini-listi; lista mašina bez filtera (status/rok/lokacija) i prioritet-sorta; istorija nespojena/neklikabilna; napomene bez izmene; dokumenta mašine bez kategorije/opisa/24h-pravila i suženo na chief/admin (1.0: operator+); šabloni bez opisa/uputstva/severity/required_role/grace + bez edita i deaktivacije; override bez `valid_until`; uvoz bez no_procedure toggle-a/filtera/selektuj-sve; lokacije bez hijerarhije/tipa/edita; karton = modal bez URL taba (1.0: ruta `?tab=`); hard-delete UX; `canManageMaintTasks` UŽI (1.0 uključuje ERP admin/mgmt/magacioner — spec §2.4 je tu netačan, 1.0 kod ga IMA).
- **RN/preventiva:** kanban bez pretrage/„Samo otvoreni"(default ON)/overdue filtera; kartica bez quick-dugmadi (Započni/Čeka deo/Završi); `started_at/completed_at` se više ne pečatiraju; rad bez `notes`; bez audit eventa za deo/rad; preventiva bez KPI kofica/filtera/naziva mašine + anti-duplikat bez ikakvog feedback-a (RPC tiho dedupe-uje); kalendar = ravne liste umesto mesečnog grida sa linkovima; per-sredstvo WO lista na kartonima vozila/IT/objekata uklonjena; timeline sirovi event tipovi. _(REFUTED: spajanje „Kontrola" kolone u „Čeka" — eksplicitna spec presuda §4.3.)_
- **Vozila/vozači:** foto vozila; liste bez 5 filtera/KPI/rokovi-chips; carpool bez izmene/brisanja/vozač-pickera (+bez gate-a); servisni plan bez edita/status kolona; gume bez edita + create gubi polja; TAG read-only.
- **IT/obj:** liste bez kolona Licenca/Garancija/Backup odn. Kritičnost/Inspekcija/PP + KPI + „Samo pažnja" + CSV; karton bez tabova RN/Dokumenta/„Prijavi kvar"/QR; `facility_type` se ne postavlja; **BE ispušta `cadastral_parcels`** (latentni gubitak polja).
- **Zalihe/dok/izveštaji:** kretanje bez cene; bez KPI/„Vrednost zaliha"/vozilo-filtera/CSV; dobavljači bez izmene + `active:true` hardkodovan (neaktivni zauvek nevidljivi); dokumenta bez izmene meta + „Dokumenta vozila" ekran ne postoji; izveštaji bez oba CSV-a i bez analitike (top mašine/downtime/trošak po sredstvu).
- **Notifikacije/API:** bez filtera po mašini/incidentu, osiromašene kolone; servisni planovi čitaju sirove tabele umesto `v_*_due` view-ova; `UpdateDriverDto` bez `authUserId`; event rute bez `clientEventId` (dupli-klik = dupli komentar); sign fajlova ŠIRI od 1.0 storage RLS (meta-red umesto floor-read) — svesno odstupanje, zapisati (§8 P2).

### 5.1 Nova skrivena pravila firme (dopuna spec §2.5 — audit našao ~20, spec ih NEMA)

1. „Čeka deo" badge = `openIncidents>0` ∧ `override_reason` matchuje `/deo|part/i` (`index.js:886`).
2. Prijava kvara sa „Sredstvo u zastoju" (samo mašine) ODMAH postavlja override `down`, reason=`Kvar: <naslov>` (`maintDialogs.js:327-335`).
3. Reopen incidenta poništava `resolved_at`/`closed_at` (`maintIncidentDialog.js:239-243`).
4. Prioritet-rang liste: down∨otvoren kvar ⇒ Zastoj → degraded → maintenance → overdue → danas → ≤7d → running (`index.js:120-168`).
5. Board: override-pauzirane mašine na dno kolone, dim + „PAUZA", brojač „live (+N pauza)".
6. BigTehn uvoz default SAKRIVA `no_procedure=true` (Kontrola/Kooperacija… nisu mašine).
7. Dodavanje kataloškog dela na WO auto-kreira `out` kretanje zaliha (sprega WO↔zalihe) — klijentski.
8. WO kanban default skriva završene/otkazane („Samo otvoreni" ON).
9. `started_at/completed_at` pečatira KLIJENT pri prelazu statusa (ne DB).
10. Preventiva „Kreiraj WO" uz postojeći otvoren nalog → confirm sa ponudom otvaranja postojećeg; RPC dedupe gleda `status<>'otkazan'` (vraća i ZAVRŠEN nalog!).
11. Spoljni vozač NE sme imati `auth_user_id` (DB CHECK; 1.0 auto-prazni polje).
12. Auto-detect vozač↔zaposleni: JS normalizacija MORA pratiti `maint_normalize_name` (dj→d, kvačice).
13. Objedinjene napomene (vozila/IT/objekti): piše se UVEK `details.notes`; legacy `asset.notes` se čuva samo dok je novo polje prazno.
14. Legacy servisna polja vozila zamrznuta u korist „Plan servisa" (modal upozorava).
15. Polica delova vozila = fiksni enum V1–V6 / U1–U6.
16. `facility.last_inspection_at` je read-only — postavlja ga zatvaranje WO tipa „Inspekcija".
17. `FACILITY_TYPES_HIDE_TECH` (hala/zgrada/magacin/ostalo) skriva proizvođač/model/serijski.
18. Backup „stale" prag = 7 dana; garancija fallback na legacy `asset.warranty_until`.
19. „Odgovorni" (upravlja, RLS) ≠ „Zadužen" (koristi) — tooltip-dokumentovano.
20. Prag isteka dokumenata: <danas crveno, ≤30d narandžasto; brisanje dokumenata podleže 24h pravilu i za operator/technician.
21. CMMS profil `management` se namerno više NE dodeljuje (ide preko globalne `menadzment` role).
22. Kreiranje profila mora imati eksplicitnu duplikat-proveru (`sbReq` POST = merge-duplicates → tihi overwrite).
23. `assigned_machine_codes` = rj_code šifre; `machine_code == rj_code`.
24. Incidenti SVIH tipova sredstava ključaju se po `asset_code` u koloni `machine_code` (+`asset_id`/`asset_type`).
25. Foto prijave: prvo upload u bucket (kategorija `incident-foto`), pa `maint_attach_incident_files` RPC.
26. QR URL se gradi iz `window.location.origin` → odštampana nalepnica trajno enkodira host štampanja.
27. `maint_assignable_users` vraća samo operator/technician/chief/admin (management NIJE dodeljiv).
28. `maint_notification_retry` NE resetuje attempts (LEAST(attempts,7)).
29. Vozač-dokumenta vidljiva i `operator` profilu + samom vozaču po `auth_user_id`.
30. PATCH ugovor: `return=representation` koji vrati `[]` = NEUSPEH (ne „nema promene") — 2.0 replicira.

## 6. FIX plan „F2" — 7 paketa za Opus multiagente (ukupno ≈ 7 MN)

> Redosled: P0 prvi (BE koje FE čeka), zatim P1–P5 paralelizabilno po parovima, P6 poslednji.
> Svaki paket: doktrina §C na snazi (nula redizajna), parity matrica u spec-u se ažurira po stavci,
> adversarni review na kraju paketa (obrazac R1/R2 review-a). Radne grane: 2.0 BE `f2/pN-*`, FE `f2/pN-*`.

| Paket | Sadržaj (šta zatvara) | Obim |
|---|---|---|
| **F2-P0 BE temelji** | maint-profili list+CRUD (SoD: mutacije SAMO erp-admin; trigger guard ostaje jedina granica) + `lookups/employees` (uski select) → H19/H20; WO list/detalj join sredstva (assetCode/assetName) → H4; WO deo: `part_id`/unit/supplier + transakciono `out` kretanje → H5; pečatiranje `started_at/completed_at` u `updateWorkOrder`; filteri: machines status/deadline/lokacija, WO q/openOnly/overdue, parts lowStock/inactive, suppliers active param, importable `no_procedure` param, notifications machine/incident filter; servisni planovi čitaju `v_maint_vehicle_service_plan_due`/`v_maint_asset_service_plan_due`; `clientEventId` na event rutama; `cadastral_parcels` u Prisma+DTO; `UpdateDriverDto.authUserId`; board podaci (proširenje dashboard endpointa); **SET-ROLE disciplina**: test/lint da nijedna odrzavanje metoda ne koristi BYPASSRLS put (§2.3.1); **razrešenje incidents INSERT politike** sa žive `pg_policies` (§2.3.2) | ≈ 1 MN |
| **F2-P1 Jezgro FE** | H1, H2 (lokalni `qrcode` render — NIKAD eksterni servis), H3; dashboard paritet (klik-KPI, attention, unified deadlines, mini-liste); lista filteri+sort+„Sledeći rok"; Board tab (#33); karton mašine → **RUTA** `/odrzavanje/masine/[code]?tab=` (deep-link + back, §8 P3); istorija merged+klik; napomene izmena; dokumenta: operator+ upload, kategorija/opis/24h; šabloni puna polja+edit+deaktivacija; override `valid_until`+edit; prijava kvara: SVA sredstva + zastoj-checkbox + auto-WO modal → H23-desktop; uvoz kontrole; lokacije pun CRUD; deletion log detalji; `canManageMaintTasks` = 1.0 krug (ERP uklj.) | ≈ 1,5 MN |
| **F2-P2 RN+preventiva FE** | kanban: sredstvo na kartici, quick-dugmad, pretraga/„Samo otvoreni"/overdue, tabela ispod; WO detalj: sredstvo+linkovi, delovi katalog-picker (→P0), rad notes, event labels, audit eventi; preventiva: KPI kofice, filteri, nazivi, anti-dup UX (confirm/toast/nav); kalendar: mesečni grid + linkovi na kartone; per-sredstvo WO tab (vozilo/IT/objekat) | ≈ 0,75 MN |
| **F2-P3 Vozila+vozači+IT+objekti FE** | H6–H14: pun edit modal vozila (+vlasnik „+Novi", primarni vozač, rokovi, TAG, foto, shelf); restore/arhiva toggle svuda; vozač pun CRUD + auto-detect + dokumenta + karton „Vozila"; delovi po vozilu (picker/link/unlink/qty_min); gume edit; carpool edit/delete+gate; IT/objekti: pune create/edit forme (device_type/facility_type obavezni, details, fallback lista tipova), liste kolone+KPI+„Samo pažnja"+CSV, kartoni sa RN/Dokumenta/„Prijavi kvar"/QR (lokalni render); servisni planovi edit + due kolone | ≈ 1,25 MN |
| **F2-P4 Zalihe+dok+izveštaji+podešavanja FE** | H15–H18: part create/edit puna polja; kretanje sa cenom; KPI+„Vrednost zaliha"+filteri+CSV; dobavljači edit+neaktivni; dokumenta upload (18 kategorija, važi-do)+izmena meta+„Dokumenta vozila"; izveštaji analitika + 2 CSV-a; podešavanja puna forma + „Dodaj pravilo"; notifikacije filteri+kolone; **Profili održavanja ekran** (na P0 rute) → H19 | ≈ 1 MN |
| **F2-P5 Mobilni + QR deep-link** | H21–H24: mobilni hub 4 kategorije + globalna pretraga + brojači; karton vozila/IT/objekta klikabilan (rokovi/kvarovi); prijava kvara sva sredstva + foto; QR sken (reuse ScanOverlay / native most); FE rute za kartone svih tipova + **legacy URL most**: 2.0 prihvata i 1.0 formate putanja (vidi §7 cutover — nalepnice!) | ≈ 0,75 MN |
| **F2-P6 Verifikacija (parity gate)** | e2e permission matrica NAD ŽIVIM RLS-om, ne mock (sintetički operator nalog, chief-bez-role, magacioner — #45/#46); Playwright happy-path; klik-test 1v2 (obrazac Kadrovska R4, test@servoteh read-only); **živi smoke #48**: QR sken → prijava → auto-WO → dodela → delovi/rad (zaliha se smanji!) → završen → izveštaj + runtime provere §2.5.11–20 (sync_to_loc, zaliha u minus, updated_by, deadline dedupe) + **bez duplih notifikacija** (dispatch živ!); **storage sadržaj**: popis maint objekata u bucket-u vs meta redovi + migracija nedostajućih (§2.2 nalaz 422); paritet labela (`maintFormatters.js`), praznih stanja, responsive, dark tema; re-run ovog audita kao playbook **Faza 1 GO/NO-GO** | ≈ 0,75 MN |

**Napomena o proceni:** spec je predviđao 5–6,5 MN za ceo talas; R1+R2+R3-skelet su potrošili ≈3;
zero-loss je otkrio da je FE bogatiji nego što je R3 pretpostavio — realni ostatak je ≈7 MN.
Posle P6 ažurirati `PROCENA_SEOBE_MODULA_3.0.md` (doktrina R5).

## 7. CUTOVER — koraci po playbook-u (IZVODI SE TEK POSLE F2-P6 = GO)

1. **Faza 1 (ponovo, kao dokaz):** BE-live sweep + write-probe + WRITE-PROOF (reverzibilan: napomena
   create→delete; NE incident — troši auto-WO broj!) + klik-test → upis u `CUTOVER_AUDIT_odrzavanje_<datum>.md`.
2. **Faza 2:** `servosync2.servoteh.com/odrzavanje` 200 (već važi) + `api.servosync2` rute žive.
3. **Faza 3 (1.0 `main`, worktree u `C:\Users\nenad.jarakovic\wt\`, NIKAD `cutover/front-repoint`):**
   - `router.js`: grana `odrzavanje-masina` → `renderTehnologijaModule(mountEl, { subPath: '/odrzavanje', titleText: 'Održavanje', titleSub: 'ServoSync 2.0' })`; teardown + body-class po obrascu.
   - **⚠️ QR nalepnice (H22):** 1.0 deep-link parser (`appPaths.js` maintenance rute — `/maintenance/machines/:code`, `/maintenance/assets/it|facilities/:code`, `?tab=`) NE SME da se obriše — mapira se na iframe `subPath` ka odgovarajućoj 2.0 ruti kartona (F2-P5 rute). Odštampane nalepnice enkodiraju `servosync.servoteh.com/...` → taj host MORA nastaviti da razrešava kartone.
   - **Mobilni `/m/odrzavanje` OSTAJE 1.0** do zasebne mobilne seobe (deli `services/maintenance.js` → fajlovi se NE brišu, samo desktop dead-path).
   - Hub pločica `odrzavanje-masina` + `v2: true` čip (`moduleHub.js`, mehanizam `be0cca5`).
4. **Faza 4:** push → CF Pages; klik-test kraj-do-kraja; red u playbook registar; LAN fallback rebuild po potrebi.
5. **Rollback:** revert cutover commita (ista sy15 baza — podaci netaknuti).

## 8. Odluke za Nenada (svaka sa predlogom — „važe predlozi" dovoljno)

> ✅ **PRESUĐENO 17.07.2026 (Nenad): sve 4 preporuke usvojene** — (1) dispatch ostaje sy15 pozadina;
> (2) storage sign zadržava 2.0 ponašanje (svesno odstupanje); (3) karton postaje RUTA (F2-P1/P5);
> (5) prijava kvara: baza je istina — F2-P0 usklađuje spec/role-permissions sa živom politikom, politika se NE dira.

1. **Dispatch pipeline (živ na sy15).** Outbox se prazni; isporuka radi kao 1.5 pozadina. **Predlog:**
   ostaje sy15 pozadina (ništa se ne seli ni ne duplira u 2.0); spec §0/§2.6/§7.1 ispraviti da ne piše
   „mrtav"; 2.0 zadržava samo čitanje+retry+rules (već tako izvedeno).
2. **Storage sign širi od 1.0.** 2.0 autorizuje download preko meta-reda (machine_visible), 1.0 storage
   RLS traži floor-read (pa maint-profil bez ERP role u 1.0 NE može da čita — anomalija). **Predlog:**
   zadržati 2.0 ponašanje kao svesno, dokumentovano odstupanje (upisati u spec §2.3 + §7 kao presudu H-nivoa).
3. **Karton mašine kao RUTA (ne modal).** Zbog QR nalepnica, browser back-a i `?tab=` deep-linka.
   **Predlog:** F2-P1 prevodi karton u rutu; dijalozi ostaju za brze radnje (potvrda kontrole itd.).
4. **Kanban „Kontrola" kolona.** Audit potvrdio da je 4-grupe eksplicitna spec presuda — ništa se ne menja
   (zapisano da ne ispliva ponovo).
5. **Prijava kvara — stvarno pravo na živoj bazi.** Snapshot sadrži `fix_maint_incidents_insert_policy`
   (floor-read/profil), što protivreči spec §2.5.4 „opšte pravo svih prijavljenih". **Predlog:** F2-P0 čita
   živu politiku sa `pg_policies`; ako je suženo — spec §2.5.4/§7.6/§7.8 i `odrzavanje.report` dodela u
   `role-permissions.ts` se usklađuju sa BAZOM (baza je istina, doktrina A5), bez menjanja same politike.

## 9. Ažuriranja koja prate ovaj audit

- [x] Spec §0/§2.6/§7.1 — ispravka „dispatch mrtav" → „dispatch ŽIV od cutover-a 1.5" (uz ovaj audit).
- [x] Spec §5 — banner: statusi po stavci = ovaj dokument §3–§5; ažurira se tokom F2.
- [x] Spec §2.5 — dopuna skrivenih pravila (§5.1 ovde, stavke 21–30 su authz-nivoa).
- [ ] Tracker (`docs/MIGRACIJA_3.0_PLAYBOOK.md` §5 u 1.0 repou) — Održavanje: „~78% Build-review" →
  „**~60–65% stvarno, Dubinski (104 gapa, 24 HIGH)** — F2 plan u toku" (ažurirati pri prvom F2 commitu).
- [ ] `PROCENA_SEOBE_MODULA_3.0.md` — posle F2-P6 (R5 retrospektiva).

---
*Audit izveden 17.07.2026 (Fable sinteza; 49 agenata: 8×popis + 31×adversarna verifikacija + DB re-verify + probe + kritičar; ukupno ~5,2M tokena). Digest sa punim dokazima: sesija `7d4b2420` scratchpad.*
