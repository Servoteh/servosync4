# Servosync Faza 2 — Arhitektonska analiza (dizajn docs vs. stvarni repo)

> Izvor: read-only multi-agent analiza (legacy-analysis workflow, 13 agenata), 2026-07-03. Kombinuje 5 kanonskih dizajn dokumenata + rudarenje legacy izvora + unakrsnu proveru trenutnog repo-a. Ništa u kodu nije menjano.

## 1. Ciljna arhitektura (iz kanonskih docs)

**Skop V1:** zamena PROIZVODNOG dela legacy QMegaTeh/QBigTehn sistema. 9 modula: PDM/Nacrti, Primopredaje, Radni nalozi, Proizvodnja, Lokacije, Proizvodne strukture, MRP/Nabavka (uvid), Komitenti (pregled). **Eksplicitno VAN skopa:** knjigovodstvo, fakturisanje, PDV/KEPU/POPDV, fiskalizacija, POS/kasa — sve to OSTAJE u BigBit-u.

**Stack/pattern:** modularni monolit (NestJS moduli po domenu), Prisma + PostgreSQL 16, dva odvojena repo-a (BE/FE). Domeni po `@Module()`: auth, users, partners, projects, workers/work-units/operations/machine-access, drawings/boms, drafts/handovers, work-orders/process-routings/operation-logs, production, locations, mrp, procurement-view, **bigbit-sync**.

**Ključna dizajn pravila (obavezna):**
- PK **UUID** svuda (`@db.Uuid`), NE auto-increment int.
- Audit polja (`created_at/updated_at/created_by/updated_by`) na svakoj ne-lookup tabeli; **soft delete** (`deleted_at`) sa Prisma middleware filterom.
- Decimal za količine/cene/težine (NIKAD float); TIMESTAMPTZ.
- `legacy_sifra`/`legacy_code` kolone kao mapping ključ ka BigBit-u; `synced_from_bigbit` + `last_synced_at` na sync-ovanim tabelama.
- Sync **jednosmeran, read-only sa BigBit strane**; BigBit polja UVEK pobeđuju (upsert/overwrite); proizvodno-specifična polja su LOKALNA i sync ih ne dira — princip **overlay-never-touch-cache**.
- Sprint 1 sync-uje **13 entiteta** (8 commercial + 5 production): customers, projects, salespeople, items, warehouses, tax_rates, item_groups, item_subgroups + work_units, worker_types, operations, workers, machine_access.
- App-owned: `users`, `refresh_tokens`, `audit_log`, `bb_sync_log`, `bb_sync_state`, `app_notifications` (Sprint 4).
- WorkOrderStatus enum (DRAFT/APPROVED/LAUNCHED/IN_PROGRESS/COMPLETED/CANCELED); Handover flow DRAFT→PENDING_APPROVAL→APPROVED→LAUNCHED/REJECTED.

## 2. Gde stvarni repo ODSTUPA od ciljne arhitekture

Trenutni `schema.prisma` (~90 modela, 1875 linija) je **skoro kompletan 1:1 plosnat engleski port CELE legacy MSSQL BigBit šeme** — a NE kanonski domenski model iz ARCHITECTURE.md.

**2.1 Skop — najveće odstupanje.** Portovano je celo knjigovodstvo/fiskal/POS koje je EKSPLICITNO van V1: `Company` (~90 kolona: galeb, fiscal_printer_name, kepu_*, pepdv, pos_*), `DocumentType` (kepu_default_*, post_in_vat_ledger, is_fiscal), `GoodsDocument`/`GoodsDocumentItem`, `PriceListEntry`, `PaymentAccount`, `TaxRate` (5 PDV stopa), `Customer` (~60 kolona: credit_limit, einvoice_*, central_invoice_registry, pantheon_id). Tehnički dug koji dizajn hoće da eliminiše, prenet u ciljnu bazu.

**2.2 PK strategija suprotna dizajnu.** Svi modeli `Int @default(autoincrement())`. Dizajn zahteva UUID. Legacy `Sifra` direktno mapiran na `id` (Komitenti.Sifra → customers.id), pa **NE postoji `legacy_sifra` mapping kolona**. Jedini legacy-reference primer je `Item.externalItemId` (= BBSifra artikla).

**2.3 Nema overlay/cache separacije (kršenje overlay-never-touch-cache).** Sve (BigBit polja + potencijalna lokalna) je u JEDNOJ plosnatoj tabeli. Nema `synced_from_bigbit`, `last_synced_at`.

**2.4 Nema soft delete.** Nijedan model nema `deleted_at`.

**2.5 Nekonzistentan audit.** Deo tabela ima created_at/updated_at, ali mnoge proizvodne (WorkOrderComponent, MachineAccess, Position, WorkUnit) nemaju created_by/updated_by.

**2.6 Legacy ULS/CFG/registry portovan umesto zamenjen.** `AccessRight` (BBPravaPristupa), `DefaultUser`, `GlobalConfig`/`SystemConfig`, `Journal`, `AppAccessLog`/`RegisteredApp*`. Dizajn kaže: zameniti RBAC-om + Postgres RLS, NE portovati Access model 1:1.

**2.7 WorkOrder status ne prati dizajn.** `status` je **Boolean** (legacy StatusRN) + `handoverStatusId Int FK` default 3. Nema WorkOrderStatus enum-a.

**2.8 Nedostaje `app_notifications`.** MODULE_SPEC_nacrti_primopredaje zahteva novu AppNotification tabelu (in-app push, polling 30s) — NE postoji. Postoji samo legacy `Notification` (Info) koja je baš ono što NE treba.

**2.9 Mirror tabele portovane iako su legacy verovatno mrtav kod.** `GoodsDocumentMirror`/`GoodsDocumentItemMirror` — legacy `modSyncMirrorTabele` nema aktivnog pozivaoca.

**2.10 Šta JE ispravno (poklapa se sa dizajnom).** App-owned sloj: `User` (email + password_hash + role), `RefreshToken` (rotacija), `AuditLog` (SetNull + denormalizovan actor_username, indeksi), `BbSyncLog` + `BbSyncState` (JSON opaque cursor) — tačno po BIGBIT_SYNC spec-u. Handover/draft modeli strukturno usklađeni.

**2.11 Sync modul — samo skelet.** `src/modules/sync/` ima MssqlClient, generički SyncService (registry, bb_sync_log/state, in-process lock, health) i **samo `CustomerSyncer`**. Od 13 Sprint-1 entiteta implementiran 1. Nema cron-a, email alerta, batching-a, per-entity strategija.

## 3. Sync — legacy pravila vs. šta Servosync MORA da replicira/popravi

**3.1 Legacy `PreuzmiIzBB` je INSERT-ONLY.** `DodajNove*IzBigBita` koriste anti-join (`EXT_X LEFT JOIN X ON kljuc WHERE X.kljuc IS NULL`) — samo NOVE slogove, **postojeći se NIKAD ne ažuriraju**. Redosled (abort-on-fail): Vrste sifara → Prodavci → Komitenti → Predmeti → R_Artikli. → **Servosync radi UPSERT** (namerna promena, BigBit-wins), ali je promena ponašanja — POTVRDITI. **Delete-propagacija NE postoji** ni u legacy-ju ni u repo-u — nerešeno.

**3.2 PIB placeholder — BUG.** Legacy: `PIB = IIf(Nz(PIB,'')='', 'XX_' & Sifra, PIB)`. `CustomerSyncer.mapRow` radi `taxId: String(r['PIB'])` bez placeholder-a; kolona NON-NULL → komitent bez PIB-a se **skipuje**. MORA: replicirati `XX_<Sifra>` + flag, tax_id nullable/bez UNIQUE.

**3.3 R_Artikli sync ključ.** Sync-key za artikle je **`externalItemId` (BBSifra artikla), NE `id`**. ItemSyncer MORA upsert po externalItemId, inače dupliranje.

**3.4 Prodavci default lozinka.** Legacy: `Password = IIf(IsNull(Password), [Sifra prodavca], Password)` — plaintext. MORA: NE migrirati kao lozinku; auth ide kroz users.password_hash.

**3.5 Hardkodovane vrednosti.** Legacy setuje `[Sifra prodavca]=0` novom komitentu. Syncer ispravno null-uje FK — potvrditi da li 0 = „nedodeljen".

**3.6 Mirror.** Legacy per-sesija scratch (delete-then-insert po SessionID), verovatno WIP. Mirror tabele u repo-u verovatno nepotrebne za V1.

**3.7 Escaping/tiho sečenje (NE replicirati).** Legacy `Replace(val,"'"," ")` (korupcija) i `Left(val,Size)` (tiho sečenje). Servosync koristi parametrizovan Prisma upsert — zadržati.

**3.8 Level/IDFirma.** Legacy multi-tier/multi-firma. Servosync V1 single-tenant — potvrditi da ostaje.

## 4. Prioritetni migracioni backlog za Fazu 2

**P0 — Odluka o šemi (blokira sve).** 1:1-vs-hibrid-vs-kanonski (vidi §5). POTVRDITI sa Negovanom.

**P1 — Sync foundation (Sprint 1), 13 entiteta.** Popraviti PIB placeholder; dodati synced_from_bigbit + last_synced_at; implementirati preostale syncere (items po externalItemId, itd.); cron 02:00, batching 1000, email alert, per-entity strategije. POTVRDITI: upsert vs insert-only; timestamp kolone; **rotacija BigBit lozinke (kredencijali u `.env`, ne u repo)**.

**P2 — Production Structures (Sprint 2).** CRUD workers/work_units/operations/worker_types/machine_access, PermissionValidator, AccessCheckerService, users.worker_id FK.

**P3 — PDM & BOM (Sprint 3).** XML import (PDMXMLParser rekonstrukcija), rekurzivni BOM CTE (legacy ftBOM* TVF-ovi NISU u izvozu — izvući sa SQL Servera).

**P4 — Drafts & Handovers (Sprint 4).** Dodati app_notifications, event-driven flow.

**P5 — Work Orders (Sprint 5).** Uskladiti status model (enum vs legacy). POTVRDITI: set IDStatusPrimopredaje; barkod format; dorada/skart -D/-S; tela SP/UDF.

**P6 — Production overview / Locations (Sprint 6-7).**

**P7 — MRP + Procurement-view (Sprint 8).** POTVRDITI: kanonski tok (MrpDemand vs DrawingPlan); Level=0/250 semantika; tela ftMRP_*/spPDM_* (nisu u izvozu).

## 5. Preporuka za odluku o šemi

**HIBRID — legacy-cache (read-only) + Servosync overlay, uz orezivanje van-skop domena.** NE čist 1:1, NE potpuni kanonski rewrite.

*Zašto ne 1:1:* uvlači knjigovodstveno-fiskalni domen van V1; krši overlay-never-touch-cache; Int PK umesto UUID, nema synced/deleted kolona.
*Zašto ne kanonski rewrite:* odbacio bi tačan legacy→EN mapping (schema-rename-map.md) i funkcionalan app-owned sloj.

**Konkretna strategija:**
1. **Cache sloj (BigBit masters):** customers, projects, salespeople, items, warehouses, tax_rates, groups + production masters → plosnate READ-ONLY „cache" tabele. Dodati synced_from_bigbit, last_synced_at, legacy_sifra. Sync overwrite-uje SAMO ove.
2. **Overlay sloj (Servosync-owned):** proizvodno-specifična polja u odvojene overlay tabele/kolone koje sync NE dira.
3. **Orezati van-skop:** knjigovodstvo/fiskal/POS/cenovnik/robna-dokumenta/mirror u zaseban `legacy` namespace ili ukloniti iz aktivne šeme.
4. **Zameniti legacy CFG/ULS:** AccessRight/DefaultUser/GlobalConfig/_Reg*/Journal NE koristiti runtime; auth kroz users+RBAC.
5. **Postepeno ka kanonu:** UUID i soft-delete po modulu (produkcioni moduli odmah; cache masters zadržavaju Int PK dok se ne odluči).

**POTVRDITI sa Negovanom pre P1:** (a) BigBit-wins upsert vs insert-only; (b) single-tenant (ignorisati IDFirma/Level); (c) knjigovodstveni domen ostaje potpuno u BigBit-u.

---
Relevantni fajlovi: `backend/prisma/schema.prisma` (1875 linija), `backend/docs/schema-rename-map.md`, `backend/src/modules/sync/` (samo CustomerSyncer; PIB placeholder logika nedostaje u `customer.syncer.ts:149`).
