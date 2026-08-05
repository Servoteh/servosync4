import "reflect-metadata";

import {
  ADDITIVE_REFRESH_TABLES,
  DEFAULT_SYNC_EXCLUDED,
  FROZEN_MSSQL_EXCLUDED,
  hasNativeColumns,
  hasNativeIdRange,
  isNativeRow,
  isOwnedProductionTable,
  NATIVE_COLUMN_TABLES,
  NATIVE_ID_BASE,
  NATIVE_ID_MAX,
  NATIVE_ID_RANGE_TABLES,
  nativeRowsSurviveSync,
  OWNED_PRODUCTION_TABLES,
} from "./table-ownership";
import { SYNC_MAP } from "./sync-map.generated";
import {
  assertItemWritesAllowed,
  itemsSurviveSync,
  ITEMS_ENTITY,
  ITEMS_WRITE_OPEN,
  NATIVE_ITEM_ID_BASE,
} from "../masters/items.write-policy";

/**
 * REZERVISAN OPSEG KLJUČEVA — ugovor između sync-a i matičnih podataka
 * (adversarni pregled 28.07.2026, nalazi [1] i [2]).
 *
 * Ovaj spec ne testira tok sinhronizacije (to radi `generic.syncer.spec.ts` i
 * `syncers/customer.syncer.spec.ts`), nego SAMU GRANICU: da je ista za obe
 * matične tabele, da je stvarno iznad celog BigBit prostora ključeva izmerenog
 * na produkciji, i da odluka o poreklu reda postoji na JEDNOM mestu.
 */
describe("table-ownership — rezervisan opseg 4.0-native ključeva", () => {
  it("granica je ista u syncu i u masters modulu (jedan broj, jedno pravilo)", () => {
    // `masters/items.write-policy.ts` je svoju kopiju dobio pre ovog fajla.
    // Razilaženje bi značilo da sync štiti jedan opseg, a masters dodeljuje
    // id-jeve iz drugog — najgori mogući tihi kvar. Zato tvrd znak jednakosti.
    expect(NATIVE_ID_BASE).toBe(900_000_000);
    expect(NATIVE_ITEM_ID_BASE).toBe(NATIVE_ID_BASE);
  });

  it("granica NIJE nijedan realan BigBit id (izmereno na produkciji 28.07.2026)", () => {
    // items: MAX(id) = 93.513 (MAX(external_item_id) = 127.584)
    // customers: MAX(id) = 1.006.067, sekvenca 1.006.063
    const BIGBIT_MAX_ITEM_ID = 93_513;
    const BIGBIT_MAX_EXTERNAL_ITEM_ID = 127_584;
    const BIGBIT_MAX_CUSTOMER_ID = 1_006_067;

    expect(isNativeRow("items", BIGBIT_MAX_ITEM_ID)).toBe(false);
    expect(isNativeRow("items", BIGBIT_MAX_EXTERNAL_ITEM_ID)).toBe(false);
    expect(isNativeRow("customers", BIGBIT_MAX_CUSTOMER_ID)).toBe(false);
    // I sledeći broj koji BigBit dodeljuje (MAX+1) je i dalje BigBit prostor —
    // baš taj broj je u nalazu [1] uzimao prvi 4.0-native komitent.
    expect(isNativeRow("customers", BIGBIT_MAX_CUSTOMER_ID + 1)).toBe(false);

    // Rezerva ISPOD granice mora ostati ogromna: BigBit je svoj prostor već
    // jednom rebazirao naviše (770 komitenata < 100k, NIJEDAN u [100k, 1M),
    // 5.481 ≥ 1M), pa granica mora da preživi i rebazu na 10M ili 100M.
    expect(NATIVE_ID_BASE - BIGBIT_MAX_CUSTOMER_ID).toBeGreaterThan(
      100_000_000,
    );
    // …a IZNAD granice mora ostati dovoljno ključeva do `int4` plafona.
    expect(NATIVE_ID_MAX - NATIVE_ID_BASE).toBeGreaterThan(1_000_000_000);
    expect(NATIVE_ID_MAX).toBe(2_147_483_647);
  });

  it("isNativeRow: tačna granica, bez „skoro”", () => {
    expect(isNativeRow("items", NATIVE_ID_BASE - 1)).toBe(false);
    expect(isNativeRow("items", NATIVE_ID_BASE)).toBe(true);
    expect(isNativeRow("customers", NATIVE_ID_BASE - 1)).toBe(false);
    expect(isNativeRow("customers", NATIVE_ID_BASE)).toBe(true);
    expect(isNativeRow("customers", NATIVE_ID_MAX)).toBe(true);
  });

  it("isNativeRow: tabela bez rezervisanog opsega nema pojam porekla", () => {
    // Da `projects` (aditivna) ili bilo koja druga tabela ne bi „slučajno"
    // dobila poreklo po opsegu — tamo native red čuva drugi mehanizam.
    expect(isNativeRow("projects", NATIVE_ID_BASE + 5)).toBe(false);
    expect(isNativeRow("warehouses", NATIVE_ID_BASE + 5)).toBe(false);
  });

  it("isNativeRow: null/undefined/NaN nikad nije native (fail-safe smer)", () => {
    expect(isNativeRow("items", null)).toBe(false);
    expect(isNativeRow("items", undefined)).toBe(false);
    expect(isNativeRow("items", Number.NaN)).toBe(false);
    // BigInt iz raw upita se prihvata (Prisma zna da vrati bigint za count/id).
    expect(isNativeRow("items", BigInt(NATIVE_ID_BASE))).toBe(true);
    expect(isNativeRow("items", BigInt(NATIVE_ID_BASE - 1))).toBe(false);
  });

  it("obe matične tabele su registrovane (artikli I komitenti, ne samo artikli)", () => {
    // Nalaz [1]: artikli su sudar ključeva rešili opsegom, komitenti nisu imali
    // ništa. Od 28.07 važi isto pravilo za obe tabele.
    expect(hasNativeIdRange("items")).toBe(true);
    expect(hasNativeIdRange("customers")).toBe(true);
    // 05.08.2026: `payment_accounts` je treća — devizni račun se od tada unosi iz
    // aplikacije (`POST /admin/firma/racuni`), pa native red mora imati svoj opseg.
    expect(hasNativeIdRange("payment_accounts")).toBe(true);
    expect([...NATIVE_ID_RANGE_TABLES].sort()).toEqual([
      "customers",
      "items",
      "payment_accounts",
    ]);
  });

  it("payment_accounts: opseg je iznad svega što BigBit šalje, a native red se poznaje po id-u", () => {
    // `payment_accounts` NEMA kolonu `source` (za razliku od items/customers), pa je
    // opseg `id`-a JEDINI nosilac porekla — granica zato mora da bude tvrda.
    expect(isNativeRow("payment_accounts", NATIVE_ID_BASE - 1)).toBe(false);
    expect(isNativeRow("payment_accounts", NATIVE_ID_BASE)).toBe(true);
    expect(isNativeRow("payment_accounts", NATIVE_ID_MAX)).toBe(true);
    // Šifarnik uplatnih računa je sitan (produkcija: 0 redova, izmereno 05.08.2026),
    // pa BigBit id nikad i ne priđe granici.
    expect(isNativeRow("payment_accounts", 5)).toBe(false);
  });

  it("nativeRowsSurviveSync: jedno pitanje umesto četiri skupa", () => {
    expect(nativeRowsSurviveSync("items")).toBe(true); // rezervisan opseg
    expect(nativeRowsSurviveSync("customers")).toBe(true); // rezervisan opseg
    expect(nativeRowsSurviveSync("projects")).toBe(true); // aditivna
    expect(nativeRowsSurviveSync("companies")).toBe(true); // native kolone
    expect(nativeRowsSurviveSync("tech_processes")).toBe(true); // owned
    expect(nativeRowsSurviveSync("warehouses")).toBe(false); // čist BigBit keš
    // Devizni račun: native kolone (upsert bez brisanja) I rezervisan opseg.
    expect(nativeRowsSurviveSync("payment_accounts")).toBe(true);
    expect(hasNativeColumns("payment_accounts")).toBe(true);
  });
});

/**
 * PREKIDAČI OSTAJU NA `false` — cilj ovog talasa NIJE otvaranje unosa.
 *
 * Zaštita sync-a i dozvola za unos su NAMERNO odvojene: sync od 28.07 garantuje
 * da 4.0-native red preživi, ali ekrani i dalje vraćaju 409 dok vlasnik ne
 * odluči. Ovaj test pada ako neko „usput" otvori unos kroz sync stranu.
 */
describe("table-ownership — zaštita ne otvara unos", () => {
  it("`items` NIJE upisan u tri stara skupa — zaštita dolazi SAMO iz opsega", () => {
    expect(ADDITIVE_REFRESH_TABLES.has(ITEMS_ENTITY)).toBe(false);
    expect(NATIVE_COLUMN_TABLES.has(ITEMS_ENTITY)).toBe(false);
    expect(OWNED_PRODUCTION_TABLES.has(ITEMS_ENTITY)).toBe(false);
    // …ali rezervisan opseg JESTE zaštita, pa je činjenica „native red preživljava"
    // od 28.07 `true`. Do integracije je `itemsSurviveSync()` čitao samo tri stara
    // skupa i vraćao `false` — istovremeno činjenica i prekidač, pa bi onaj ko
    // ispravi činjenicu usput otvorio unos.
    expect(hasNativeIdRange(ITEMS_ENTITY)).toBe(true);
    expect(itemsSurviveSync()).toBe(true);
  });

  it("preživljavanje sync-a NE otvara unos — 409 drži zaseban prekidač", () => {
    // Ovo je brana koja zamenjuje staru: unos artikala je zatvoren ODLUKOM
    // (`ITEMS_WRITE_OPEN`), ne nedostatkom zaštite. Test pada ako neko otvori unos
    // kroz sync stranu ili prevrne prekidač bez odluke vlasnika.
    expect(ITEMS_WRITE_OPEN).toBe(false);
    expect(() => assertItemWritesAllowed()).toThrow();
  });

  it("`customers` nije postao ServoSync-owned (sync i dalje osvežava BigBit redove)", () => {
    // Rezervisan opseg NIJE isto što i vlasništvo: BigBit i dalje vlada svojim
    // komitentima i sme da ih ažurira — štiti se samo 4.0-native prostor.
    expect(isOwnedProductionTable("customers")).toBe(false);
    expect(hasNativeColumns("customers")).toBe(false);
    expect(isOwnedProductionTable("items")).toBe(false);
  });
});

/**
 * ZAMRZNUTI MSSQL TOKOVI — reopen 061/26 (04.08.2026). Pinuje se sadržaj skupa
 * (odluka, ne implementacioni detalj) i higijena: svaki isključeni tok mora
 * POSTOJATI u mapi — isključenje nepostojećeg imena je mrtvo slovo koje tiho
 * preživi preimenovanje entiteta.
 */
describe("table-ownership — zamrznuti MSSQL tokovi (reopen 061/26)", () => {
  it("skup je tačno: tri mastera koje vozi .mdb kanal + šest praznih izvora", () => {
    expect([...FROZEN_MSSQL_EXCLUDED].sort()).toEqual([
      "access_rights",
      "customers",
      "goods_documents_mirror",
      "items",
      "journal",
      "notifications",
      "price_list_entries",
      "projects",
      "warehouses",
    ]);
  });

  /*
   * `items` je ovde, a NE u nekom „privremeno, do čišćenja kataloga" skupu.
   * Razlog je merenje 04.08.2026: `items` vozi noćni .mdb kanal (uvoz 03.08:
   * +17 novih / ~7 izmenjenih), a MSSQL izvor mu je zamrznut kao i ostalima —
   * uz to je FULL REFRESH nad 92.592 artikla. Staro uputstvo („kad nestanu
   * duplikati, vrati tok u default") bi posle čišćenja ponovo naoružalo isti
   * kvar, 12× većeg obima. Uslov za povratak je OŽIVLJEN IZVOR, ne čist katalog.
   */
  it("`items` je isključen zbog MRTVOG IZVORA (ne zbog duplikata katbroja)", () => {
    expect(FROZEN_MSSQL_EXCLUDED.has("items")).toBe(true);
    expect(DEFAULT_SYNC_EXCLUDED.has("items")).toBe(true);
  });

  it("default prolaz = zamrznuti tokovi — jedan izvor za ručni i noćni put", () => {
    expect([...DEFAULT_SYNC_EXCLUDED].sort()).toEqual(
      [...FROZEN_MSSQL_EXCLUDED].sort(),
    );
    expect(DEFAULT_SYNC_EXCLUDED.has("projects")).toBe(true);
    // Prazan skup = „ništa nije isključeno" → ceo kvar se tiho vraća.
    expect(DEFAULT_SYNC_EXCLUDED.size).toBeGreaterThan(0);
    // `document_types` i dalje ide u default prolaz (izvor mu nije zamrznut).
    expect(DEFAULT_SYNC_EXCLUDED.has("document_types")).toBe(false);
  });

  it("svaki isključeni tok postoji u sync mapi (nema isključenja duha)", () => {
    const mapped = new Set(SYNC_MAP.map((m) => m.targetDb));
    for (const entity of FROZEN_MSSQL_EXCLUDED) {
      expect({ entity, mapped: mapped.has(entity) }).toEqual({
        entity,
        mapped: true,
      });
    }
  });
});
