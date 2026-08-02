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
  // PDV tarife (Nenad, 26.07.2026): registar se od sada vodi ISKLJUČIVO u 4.0
  // (`POST/PATCH /api/v1/pdv/tax-rates` → `TaxRatesService`), pa je mapiranje
  // `R_Tarife` IZBAČENO iz `sync-map.generated.ts` — isto kao `goods_documents`.
  // Ostaje ovde kao zaštita: vrati li se mapiranje ikad, generički syncer odbija
  // destruktivan full-refresh dok tabela ima redova. (`price_list_entries` ima
  // tvrd FK na `tax_rates.code` — vidi SOURCE_FK_FILTERS ispod.)
  "tax_rates",
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
 *
 * ⚠️ OTVORENO (review 26.07.2026, nalaz [4]) — DVA GOSPODARA NAD ISTIM KOLONAMA:
 * `PATCH /api/v1/projects/:id` (`ProjectsWriteService.updateProject`, živ u
 * app.module) piše `description/projectName/memo/nextAction/status/deadline/
 * closedAt/customerId/workTypeId` i nad BigBit-origin predmetima. Mapiranje
 * `Predmeti` je ISCRPNO (38 kolona = sve skalarne kolone modela), pa NEMA
 * „app-owned" kolone koja bi se sačuvala pri reinsert-u — reč je o istim
 * kolonama. Dok se ne presudi ko pobeđuje, važi dokumentovano stanje: 3.0-native
 * redovi (id van izvora) su zaštićeni u celosti, a BigBit-origin redove BigBit
 * osvežava (§ „mora nastaviti da AŽURIRA postojeće"). Rizik je danas latentan:
 * frontend NE zove taj PATCH (samo GET `/v1/directory/projects/:id`). Uslov za
 * odluku: pre nego što FE izloži izmenu BigBit-origin predmeta.
 * (Checkbox-i „AKTIVAN"/„PROJ&MONT" iz Podešavanja predmeta NISU u ovoj tabeli —
 * idu RPC-om u sy15, `PodesavanjaService.setPredmetAktivacija` → `withUserRls`.)
 *
 * `document_types` (review 26.07.2026, nalaz [0]): 4.0 popis je migracijom
 * 20260724160000 SEED-ovao `VISAR`/`MANJR`/`NIV` (bez njih `createStockDocument`
 * baca 422 i finalizacija popisa stoji), a BigBit `R_Vrste dokumenata` te šifre
 * ne poznaje. Klasičan full refresh (`deleteMany({})`) bi ih obrisao na PRVOM
 * sync-u — i ručnom i noćnom. Zato i ova tabela prelazi na aditivni refresh:
 * BigBit i dalje ažurira SVOJE vrste dokumenata, a 4.0-seedovane preživljavaju.
 */
export const ADDITIVE_REFRESH_TABLES = new Set<string>([
  "projects",
  "document_types",
]);

export function isAdditiveRefreshTable(entity: string): boolean {
  return ADDITIVE_REFRESH_TABLES.has(entity);
}

/**
 * TABELE SA 3.0-NATIVE KOLONAMA KOJE IZVOR NE ZNA (Nenad, 27.07.2026).
 *
 * Full refresh je `deleteMany({}) + createMany(mapirane kolone)`. Za tabelu koja
 * pored mapiranih kolona nosi i kolone kojih u BigBit-u NEMA, to znači TIHI
 * GUBITAK: red se obriše i vrati bez njih, bez ijedne greške u logu.
 *
 * Konkretan povod: `companies.iban` i `companies.swift` (dodate 27.07.2026, unose
 * se kroz Podešavanja → Podaci firme, štampaju se na ino fakturi i idu u UBL
 * `cac:PaymentMeans`). BigBit te kolone nema, pa ih mapa ne pokriva — jedno
 * pokretanje sinhronizacije bez ove zaštite obrisalo bi ih, a strani kupac bi
 * dobio račun bez podataka za uplatu.
 *
 * Za ove tabele syncer NIKAD ne briše red: radi UPSERT samo nad MAPIRANIM
 * kolonama (`update` bez nemapiranih polja ih ostavlja netaknutim). Tabele su
 * male (šifarnik firme), pa je red-po-red upsert jeftin.
 *
 * Razlika prema `OWNED_PRODUCTION_TABLES`: tamo 3.0 vlasnik CELE tabele pa se
 * sync preskače; ovde izvor i dalje vlada SVOJIM kolonama i sme da ih osvežava —
 * štiti se samo ono što u izvoru ne postoji.
 *
 * `payment_accounts` (dopuna 02.08.2026): migracija `20260801100000_stampa_faktura_polja`
 * je dodala `iban`, `swift`, `bank_address` i `currency` — blok „Beneficiary Customer /
 * Bank of beneficiary" na izvoznoj fakturi. Sync mapa (`UplatniRacuni`) pokriva samo osam
 * BigBit kolona i tabela nema `watermark`, dakle vozi FULL REFRESH: bez ovog upisa prvi
 * noćni sync posle unosa obrisao bi IBAN bez traga u logu, a izvozna faktura bi opet
 * izašla bez podataka za uplatu — isti kvar, samo sa nedelju dana zakašnjenja.
 */
export const NATIVE_COLUMN_TABLES = new Set<string>([
  "companies",
  "payment_accounts",
]);

export function hasNativeColumns(entity: string): boolean {
  return NATIVE_COLUMN_TABLES.has(entity);
}

/**
 * PARITET BROJA za aditivne tabele (Nenad, 22.07.2026): u prelaznom periodu
 * predmeti se otvaraju RUČNO U OBA sistema — prvo u 3.0 (koji dodeljuje broj),
 * pa se ISTI broj prekuca u BigBit (BigBit ostaje nosilac fakturisanja do F5).
 * BigBit kopija tako stiže na sync sa SVOJIM id-jem ali istim brojem —
 * `project_number` NEMA unique constraint, pa bi slepi insert napravio DUPLI
 * predmet (dva reda, isti broj; RN-ovi/aktivacije pokazuju na 3.0-native id).
 *
 * Guard u `GenericSyncer` (aditivna grana): izvorni red čija vrednost ovog
 * polja već postoji na redu čiji id izvor NE vraća (= 3.0-native red) se
 * PRESKAČE uz upozorenje u sync logu. Ako je kopija ranije već ušla (id joj
 * je u izvornom skupu — obrisan pa ne-reinsertovan), sync je time i počisti.
 */
export const ADDITIVE_DEDUP_FIELDS: Record<string, string> = {
  projects: "projectNumber",
  // `document_types.code` je nosilac svih mekih referenci (price_list,
  // stock_documents, kepu) i od 25.07 ima tvrd `uq_document_types_code`. BigBit
  // red sa šifrom koja već stoji na 4.0-seedovanom redu se PRESKAČE — inače bi
  // `createMany` pao na uniq indeksu i oborio ceo tok.
  document_types: "code",
};

export function additiveDedupFieldFor(entity: string): string | null {
  return ADDITIVE_DEDUP_FIELDS[entity] ?? null;
}

/**
 * JEDINSTVENOST UNUTAR IZVORNOG SKUPA (Nenad, 25.07.2026 — DB audit DB-081):
 * kataloški broj artikla mora biti jedinstven; BigBit je od skoro brani, ali
 * istorijski duplikati postoje (1.980 grupa / 4.298 artikala izmereno 25.07).
 *
 * `items` se sinhronizuje kao FULL REFRESH (obriši sve + bulk `createMany` u
 * chunk-ovima, pod `session_replication_role='replica'`). Tvrd UNIQUE indeks bi
 * u tom režimu i dalje važio (indeksi nisu trigeri) i jedan duplikat iz izvora
 * bi oborio CEO chunk → sync artikala pada → MRP/nabavka bez šifarnika.
 *
 * Zato guard radi PRE upisa: iz izvornog skupa se zadržava PRVI red po ključu
 * (case-insensitive, trimovan), ostali se PRESKAČU i uđu u sync log. Time 3.0
 * nikad ne dobije duplikat, a sync nikad ne padne zbog njega.
 *
 * Vrednost = ime polja u Prisma modelu; poređenje je `lower(btrim(...))`.
 *
 * ZADRŽAVA SE PRVI RED PO KLJUČU, a „prvi" mora biti STABILAN između prolaza —
 * zato syncer za ove tabele sortira izvor po izvornom PK (`ORDER BY`), inače
 * MSSQL sme da vrati drugačiji redosled i sledeći sync bi izabrao DRUGI red kao
 * pobednika (isti kataloški broj, drugi `id` → sve meke reference pokazuju na
 * pogrešan artikal). Review 26.07.2026, nalaz [1].
 *
 * `projects` i `document_types` (review 26.07, nalaz [2]): oba imaju uniq indeks
 * iz 25.07 (`uq_projects_project_number` parcijalni, `uq_document_types_code`),
 * pa bi jedan duplikat U SAMOM BIGBIT IZVORU oborio ceo `createMany` chunk.
 * Dedup se KOMPONUJE sa aditivnim skip-om: prvo otpadnu BigBit kopije brojeva
 * koji već stoje na 3.0/4.0-native redovima, pa tek onda duplikati unutar izvora.
 */
export const SOURCE_UNIQUE_FIELDS: Record<string, string> = {
  items: "catalogNumber",
  projects: "projectNumber",
  document_types: "code",
};

export function sourceUniqueFieldFor(entity: string): string | null {
  return SOURCE_UNIQUE_FIELDS[entity] ?? null;
}

/**
 * FK PRE-FILTER (review 26.07.2026, nalaz [3]) — izvorni red čija OBAVEZNA strana
 * referenca nema par u 3.0 se PRESKAČE pre upisa.
 *
 * Full refresh ide pod `session_replication_role='replica'`, gde FK trigeri NE
 * RADE — prekršilac se tiho upiše i ostane kao siroče (isti mehanizam je već
 * napravio 2 nerestorabilna FK-a u backup-u, v. backup-nightly.sh zaglavlje).
 * Do 26.07 je `price_list_entries.tax_rate_code` uvek imao par jer se `tax_rates`
 * sinhronizovao u istom prolazu; izbacivanjem `R_Tarife` iz mape taj oslonac je
 * nestao, pa cenovnik mora sam da proveri šifru tarife.
 *
 * `refDelegate` = ime Prisma delegata ciljne tabele, `refField` = polje na koje
 * FK pokazuje (poređenje je tačno, bez normalizacije — FK je tvrd).
 */
export interface SourceFkFilter {
  field: string;
  refDelegate: string;
  refField: string;
  /** Kratko objašnjenje koje ide u sync log uz preskočeni red. */
  reason: string;
}

export const SOURCE_FK_FILTERS: Record<string, SourceFkFilter[]> = {
  price_list_entries: [
    {
      field: "taxRateCode",
      refDelegate: "taxRate",
      refField: "code",
      reason:
        "šifra poreske tarife ne postoji u tax_rates (registar je od 26.07 4.0-owned, više ne stiže iz BigBit-a)",
    },
  ],
};

export function sourceFkFiltersFor(entity: string): SourceFkFilter[] {
  return SOURCE_FK_FILTERS[entity] ?? [];
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * REZERVISAN OPSEG KLJUČEVA ZA 4.0-NATIVE REDOVE (adversarni pregled 28.07.2026)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Matične tabele `items` i `customers` dele PK prostor sa BigBit-om: `Item.id`
 * je BigBit `Sifra artikla`, a `Customer.id` je BigBit `Sifra` (PK se NE
 * remapira — BIGBIT_KOMITENTI.md §5.1). Zato red nastao u 4.0 mora da sedne
 * IZNAD celog BigBit prostora, inače se dva sistema sretnu na istom broju:
 *
 *   - nalaz [1] (komitenti): `alignIdSequence` postavlja sekvencu na `MAX(id)`,
 *     pa prvi 4.0-native komitent uzme `MAX+1` = tačno broj koji BigBit sledeći
 *     dodeljuje. Kad ta šifra stigne na sync, `upsert({ where: { id } })`
 *     prepiše svih 56 kolona TUĐOM firmom — bez greške i bez traga.
 *   - nalaz [2] (artikli): `items` je full refresh (`watermark: null`), pa
 *     `deleteMany({})` OBRIŠE 4.0-native artikal, a `price_list_entries` i
 *     `work_order_item_components` ostanu siročad (brisanje ide pod
 *     `session_replication_role='replica'`, gde FK trigeri ćute).
 *
 * GRANICA = 900.000.000 za OBE tabele, ista vrednost namerno (jedan broj, jedno
 * pravilo). Izmereno na produkciji 28.07.2026: `items` MAX(id)=93.513,
 * `customers` MAX(id)=1.006.067 → ostaje ~899,87M BigBit headroom-a i
 * 1.247.483.647 native ključeva ispod `int4` plafona.
 *
 * Migracija `20260728170000_maticni_native_opseg_i_poreklo` istu granicu ukiva u
 * bazu kao CHECK (`chk_items_native_id_range`, `chk_customers_native_id_range`:
 * `source='NATIVE' ⇔ id >= 900000000`) i pomera sekvence na 899.999.999. CHECK
 * važi i pod `session_replication_role='replica'`, gde trigeri ne rade — zato
 * native red FIZIČKI ne može da sedne u BigBit prostor.
 *
 * OVDE je odluka za sync stranu — jedno mesto koje čita i sync (brisanje/upsert)
 * i masters (dodela id-a, provera porekla), da granica ne bi postala konvencija
 * prepisana na dva mesta. `masters/items.write-policy.ts` drži svoju kopiju
 * (`NATIVE_ITEM_ID_BASE`) jer je nastala pre ovog fajla; jednakost te dve
 * vrednosti PINUJE test (`table-ownership.spec.ts`), pa razilaženje pada glasno.
 */
export const NATIVE_ID_BASE = 900_000_000;

/** `Int` kolona je PG `integer` — gornja granica rezervisanog opsega. */
export const NATIVE_ID_MAX = 2_147_483_647;

/**
 * Tabele u kojima 4.0-native red živi IZNAD `NATIVE_ID_BASE`, a BigBit ispod.
 * Za njih syncer NIKAD ne briše ceo skup (`deleteMany({})` → `id < BASE`) i
 * NIKAD ne upisuje izvorni red čiji `id` upada u native opseg.
 *
 * ⚠️ NIJE prekidač za otvaranje unosa. `CUSTOMERS_WRITE_OPEN` i
 * `assertItemWritesAllowed()` i dalje vraćaju 409 — ovaj skup samo garantuje da
 * unos, KAD SE OTVORI, ne može tiho da nestane. Cilj: otvaranje = jedan
 * prekidač, bez ijednog novog otkrića u tom trenutku.
 */
export const NATIVE_ID_RANGE_TABLES = new Set<string>(["items", "customers"]);

export function hasNativeIdRange(entity: string): boolean {
  return NATIVE_ID_RANGE_TABLES.has(entity);
}

/**
 * Da li je `id` u tabeli `entity` red nastao u 4.0 (a ne BigBit matični podatak).
 *
 * JEDINO mesto na kome se ta odluka donosi — i sync i masters treba da pitaju
 * ovde, umesto da svako svoje poređenje piše ručno. Za tabelu koja nema
 * rezervisan opseg vraća `false` (tamo poreklo ne postoji kao pojam).
 */
export function isNativeRow(
  entity: string,
  id: number | bigint | null | undefined,
): boolean {
  if (!NATIVE_ID_RANGE_TABLES.has(entity)) return false;
  if (id === null || id === undefined) return false;
  const value = typeof id === "bigint" ? Number(id) : Number(id);
  return Number.isFinite(value) && value >= NATIVE_ID_BASE;
}

/** Vrednost markera porekla iz šeme (`items.source` / `customers.source`). */
export const NATIVE_SOURCE_MARKER = "NATIVE";
export const BIGBIT_SOURCE_MARKER = "BIGBIT";

/**
 * Da li 4.0-native red u ovoj tabeli PREŽIVLJAVA sync — bilo kojim mehanizmom.
 *
 * Jedna funkcija umesto četiri odvojena pitanja: tabela je zaštićena ako je
 * ServoSync-owned (sync je preskače), aditivna (briše samo izvorne id-jeve),
 * ima nemapirane native kolone (upsert bez brisanja) ili ima rezervisan opseg
 * ključeva (brisanje ne dohvata native prostor).
 *
 * ⚠️ `masters/items.write-policy.ts::itemsSurviveSync()` je stariji, UŽI oblik
 * ovog pitanja (ne zna za rezervisan opseg) i namerno NIJE menjan u ovom talasu
 * — on je prekidač koji otvara unos artikala, a ovaj talas unos ne otvara.
 */
export function nativeRowsSurviveSync(entity: string): boolean {
  return (
    isOwnedProductionTable(entity) ||
    isAdditiveRefreshTable(entity) ||
    hasNativeColumns(entity) ||
    hasNativeIdRange(entity)
  );
}
