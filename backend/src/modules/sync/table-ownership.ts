/**
 * ServoSync-owned production/technology tables (ODLUKE.md 2026-07-08 + BACKEND_RULES §3).
 *
 * Decision: the QBigTehn MSSQL sync was a TEMPORARY trial + one-time final import,
 * then retired. CUTOVER IZVRŠEN 2026-07-14 (runbook §17) — od prvog realnog
 * korišćenja tehnolog piše u ove tabele direktno, pa ponovni sync NE SME da
 * pregazi ručno unete podatke.
 *
 * The generic syncer therefore refuses to full-refresh (deleteMany + reinsert) any
 * of these once they already contain rows, unless the run is explicitly forced.
 * (Chain synceri koji su ih punili su obrisani na cutover-u; ova zaštita ostaje
 * za slučaj da generički syncer ikad dobije mapiranje na owned tabelu.)
 * Everything else (BigBit master data, PDM drawings, legacy reference/config) is
 * read-only cache and safe to refresh.
 */
export const OWNED_PRODUCTION_TABLES = new Set<string>([
  // radni nalozi
  "work_orders",
  "work_order_operations",
  "work_order_components",
  "work_order_item_components",
  "work_order_launches",
  "work_order_operation_images",
  // stavke RN bez generisanog mapiranja (nekad P4 §5.3 privremeni synceri,
  // obrisani na cutover-u 2026-07-14) — 2.0 ih piše nativno (approve ->
  // work_order_approvals, clone-variant -> parts), ostaju owned/zaštićene.
  "work_order_machined_parts",
  "work_order_blanks",
  "work_order_nonstandard_parts",
  "work_order_approvals",
  // tehnološki postupci
  "tech_processes",
  "tech_process_documents",
  // operacije / delovi / šifarnici proizvodnje
  "operations",
  "part_locations",
  "part_quality_types",
  "positions",
  "work_units",
  "workers",
  "worker_types",
  "machine_access",
  "production_item_groups",
  // primopredaje
  "handover_drafts",
  "handover_draft_items",
  "drawing_handovers",
  "drawing_handover_pdfs",
  // planiranje (PDM)
  "drawing_plan_items",
  // planer
  "planner_entries",
  "planner_user_groups",
  // PDM intake (P4c) — the native XML/PDF import writes these from 2026-07-14
  // (bridge live), so they are no longer a pure legacy cache. The 2.0-native id
  // sequence and the legacy MSSQL id space have already diverged and COLLIDED
  // (same ids, different drawings), so a full refresh would silently overwrite
  // native rows with wrong-id legacy copies. Any future reconciliation must key
  // on (drawing_number, revision), never on id — see
  // docs/design/PLAN_bom_rupa_cutover_stash_2026-07-14.md.
  "drawings",
  "drawing_components",
  "drawing_pdfs",
  "drawing_import_log",
  // Robni tok (Faza 3) — `goods_documents` (T_Robna dokumenta) i
  // `goods_document_items` (T_Robne stavke) postaju 2.0-owned. Na produkciji je
  // ova kopija bila MRTVA (0 redova, 0 čitalaca u kodu), pa je njeno mapiranje
  // IZBAČENO iz `sync-map.generated.ts` (ODLUKA Nenad, jul 2026) — isto kao
  // QBigTehn lanac. Ostaju ovde kao zaštita: ako se mapiranje ikad vrati u
  // generisanu mapu, generički syncer i dalje odbija destruktivan full-refresh
  // dok tabela ima redova. (NAPOMENA: `goods_documents_mirror` /
  // `goods_document_items_mirror` su ZASEBAN, lagani BigBit keš —
  // source `RobnaDokumentaMirror`/`RobneStavkeMirror` — i OSTAJU u syncu.)
  "goods_documents",
  "goods_document_items",
]);

export function isOwnedProductionTable(entity: string): boolean {
  return OWNED_PRODUCTION_TABLES.has(entity);
}

/**
 * QBigTehn chain — the TEMPORARY part of the sync (P4 spec §7.2, ODLUKE
 * "QBigTehn sync privremen / BigBit trajan").
 *
 * CUTOVER IZVRŠEN 2026-07-14 (docs/migration/17-cutover-runbook.md korak 6):
 * finalni force uvoz je odrađen, pa je ceo lanac UKLONJEN IZ REGISTRACIJE — svi
 * entiteti ispod izbačeni su iz `sync-map.generated.ts`, a §5.3 privremeni
 * synceri + handover-derivation syncer OBRISANI iz `SyncService`/`SyncModule`
 * (mrtav kod se briše, ne stoji iza prekidača). Od tada ove tabele piše
 * isključivo 2.0.
 *
 * Ovaj set se ZADRŽAVA kao dokumentacija/zaštita: `isOwnedProductionTable` +
 * generički syncer i dalje koriste `OWNED_PRODUCTION_TABLES` da odbiju
 * destruktivan re-import owned tabela; `QBIGTEHN_CHAIN_ENTITIES` je izvor
 * istine šta je nekad bilo u lancu (npr. `sync.service.spec.ts` proverava da
 * NIJEDAN chain entitet više nije registrovan).
 *
 * Everything mapped in `sync-map.generated.ts` that is NOT in this set is the
 * PERMANENT BigBit master-data sync (customers, projects, items, warehouses,
 * MRP_*, price list, goods documents, registry/CFG…) — vasa-SQL keeps feeding
 * those after the cutover.
 *
 * Derivation of the list (spec §7.2): cross-checked against
 * `sync-map.generated.ts` (29 mapped targets, izbačeni na cutover-u) + the six
 * §5.3 chain-item tables that had no generated mapping (tPDM, tPLP, tPND,
 * tSaglasanRN, PDM_PlaniranjeStavke, PrimopredajaPDFCrteza). The one-time
 * seeded production lookups (workers, worker_types, operations, …) are part of
 * the chain: after cutover they are ServoSync-owned and no longer refreshed
 * from QBigTehn.
 */
export const QBIGTEHN_CHAIN_ENTITIES = new Set<string>([
  // PDM crteži / BOM / intake log / PDF-ovi / planiranje
  "drawings",
  "drawing_components",
  "drawing_assemblies",
  "drawing_import_log",
  "drawing_pdfs",
  "drawing_plans",
  "drawing_plan_items", // §5.3 (PDM_PlaniranjeStavke)
  // nacrti i primopredaje
  "handover_drafts",
  "handover_draft_items",
  "drawing_handovers", // nekad derivacija iz tRN (handover-derivation.syncer.ts, obrisan na cutover-u)
  "drawing_handover_pdfs", // §5.3 (PrimopredajaPDFCrteza)
  // radni nalozi + stavke
  "work_orders",
  "work_order_operations",
  "work_order_operation_images",
  "work_order_launches",
  "work_order_approvals", // §5.3 (tSaglasanRN)
  "work_order_machined_parts", // §5.3 (tPDM)
  "work_order_blanks", // §5.3 (tPLP)
  "work_order_nonstandard_parts", // §5.3 (tPND)
  "work_order_components",
  "work_order_item_components",
  // tehnološki postupci
  "tech_processes",
  "tech_process_documents",
  // nalepnice / lokacije delova
  "labels",
  "part_locations",
  // jednokratno seed-ovani šifarnici proizvodnje
  "workers",
  "worker_types",
  "operations",
  "work_units",
  "positions",
  "part_quality_types",
  "machine_access",
  "production_item_groups",
  // planer
  "planner_entries",
  "planner_user_groups",
]);

export function isQbigtehnChainEntity(entity: string): boolean {
  return QBIGTEHN_CHAIN_ENTITIES.has(entity);
}

/**
 * ADITIVNI full-refresh — tabele koje BigBit i dalje puni, ali 2.0 sada
 * pravi i SVOJE, native redove u istoj tabeli (mešani vlasnik).
 *
 * ODLUKA (Nenad, jul 2026) za `projects` (Predmeti): BigBit na produkciji
 * aktivno puni ~7.600 predmeta i mora nastaviti da AŽURIRA postojeće; od sada
 * 2.0 pravi NOVE predmete koje BigBit ne poznaje. Klasičan full_refresh radi
 * `deleteMany({})` (BRIŠE SVE) + `createMany`, pa bi na svakom sync-u obrisao
 * svaki 2.0-native predmet — to je zabranjeno.
 *
 * Zašto NE incremental (upsert po watermark-u): izvorna tabela `Predmeti` NEMA
 * `PoslednjaIzmena` (ni bilo koju „last modified" kolonu — samo datume
 * otvaranja/zaključenja/ugovora/narudžbenice), pa se watermark-driven
 * incremental ne može aktivirati. Zato mapiranje ostaje `watermark: null`
 * (default `full_refresh`), a ovde menjamo SAMO korak brisanja.
 *
 * Ponašanje za ove tabele (vidi `GenericSyncer`): umesto `deleteMany({})`,
 * full-refresh briše SAMO redove čiji `id` izvor vraća u ovom prolazu
 * (`deleteMany({ where: { id: { in: sourceIds } } })`), pa reinsertuje te iste
 * izvorne redove. Efekat = upsert celog BigBit skupa (postojeći se ažuriraju,
 * novi ubacuju) BEZ diranja 2.0-native redova (id koji izvor ne vraća).
 *
 * NAPOMENA: pošto `id` koji izvor ne vraća nikad ne diramo, red obrisan u
 * BigBit-u ostaje kao siroče u 2.0 (svesno — bezbednije je zadržati predmet
 * nego rizikovati brisanje 2.0-native reda; predmeti se u praksi ne brišu).
 * Zahtev: PK mora biti jednostavan `id` (proverava se u syncer-u).
 */
export const ADDITIVE_REFRESH_TABLES = new Set<string>(["projects"]);

export function isAdditiveRefreshTable(entity: string): boolean {
  return ADDITIVE_REFRESH_TABLES.has(entity);
}
