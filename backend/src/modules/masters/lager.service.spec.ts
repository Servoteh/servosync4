import "reflect-metadata";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { LagerService } from "./lager.service";
import { ItemsController } from "./items.controller";
import { LAGER_SORT_COLUMNS } from "./dto/list-lager.dto";
import { PERMISSION_KEY_METADATA } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";

/**
 * LAGER I KARTICE ARTIKLA — ogledalo BigBit robnog.
 *
 * ⚠️ ŠTA OVAJ SPEC MOŽE, A ŠTA NE. Prisma je ovde mock, pa se ne izvršava SQL
 * nego se PINUJE NJEGOV TEKST. To je namerno i dovoljno za ono što ovde ume da
 * se pokvari ćutke: formula stanja, izvor rezervacija, dimenzija magacina i
 * sečenje po godini su JEDAN RED SQL-a svaki — izmena bilo kog od njih vraća
 * brojeve koji i dalje izgledaju kao zalihe. Da SQL uopšte radi (CTE, FULL
 * OUTER JOIN, window count, `::date` bind, `NULLS LAST`) izmereno je zasebno,
 * nad živom Postgres bazom, u transakciji koja se obara — v. izveštaj uz zadatak.
 */

/** Tekst upita iz `Prisma.sql` objekta. */
function sqlOf(call: unknown[]): string {
  return (call[0] as Prisma.Sql).sql;
}
/** Bind parametri upita — vrednosti iz zahteva NIKAD ne smeju biti u tekstu. */
function valuesOf(call: unknown[]): unknown[] {
  return (call[0] as Prisma.Sql).values;
}
/** Sav SQL koji je servis izdao u jednom pozivu. */
function allSql(prisma: ReturnType<typeof prismaMock>): string[] {
  return prisma.$queryRaw.mock.calls.map((c) => sqlOf(c));
}
/** Upit lager liste (jedini sa CTE-om); baca ako ga nema, da test ne ćuti. */
function lagerSql(prisma: ReturnType<typeof prismaMock>): string {
  const found = allSql(prisma).find((s) => s.includes("WITH stock AS"));
  if (!found) throw new Error("Lager upit nije izdat.");
  return found;
}

const ITEM = {
  id: 7,
  catalogNumber: "00412",
  name: "LIM 2mm",
  unit: "kom",
  shelf: "A-1-3",
};

/**
 * Mock Prisme koja odgovara PO SADRŽAJU UPITA — servis izdaje više različitih
 * upita u jednom pozivu (razrešenje godine, početno stanje, sama lista), pa bi
 * jedan `mockResolvedValue` za sve dao besmislene odgovore.
 */
function prismaMock(rows: Record<string, unknown[]> = {}) {
  const $queryRaw = jest.fn((sql: Prisma.Sql) => {
    const text = sql.sql;
    if (text.includes("MAX("))
      return Promise.resolve(rows.year ?? [{ year: 2026 }]);
    if (text.includes("SELECT COALESCE(SUM("))
      return Promise.resolve(rows.opening ?? [{ value: "0" }]);
    if (text.includes("WITH stock AS"))
      return Promise.resolve(rows.lager ?? []);
    if (text.includes("purchase_order_items_mirror"))
      return Promise.resolve(rows.orders ?? []);
    return Promise.resolve(rows.card ?? []);
  });
  return {
    $queryRaw,
    $executeRaw: jest.fn(),
    $executeRawUnsafe: jest.fn(),
    item: { findUnique: jest.fn().mockResolvedValue(ITEM) },
    itemGroup: { findMany: jest.fn().mockResolvedValue([]) },
  };
}

function makeService(rows?: Record<string, unknown[]>) {
  const prisma = prismaMock(rows);
  return {
    prisma,
    service: new LagerService(prisma as unknown as PrismaService),
  };
}

/** Red lager liste kakav upit vraća (sve numeričko je `::text`). */
function lagerRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    itemId: 7,
    warehouseId: 1,
    stock: "65.0000",
    reserved: "20.0000",
    free: "45.0000",
    catalogNumber: "00412",
    name: "LIM 2mm",
    unit: "kom",
    shelf: "A-1-3",
    groupCode: "10",
    // Minimalna količina (06.08.2026) — kolona koju magacioner unosi; upit je uvek
    // vraća (`it.min_quantity::numeric::text`), pa je i fixture uvek nosi.
    minQuantity: "2",
    wholesalePrice: "1250.0000",
    warehouseName: "Magacin robe",
    totalCount: 1,
    ...over,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// FORMULA
// ═══════════════════════════════════════════════════════════════════════════

describe("Lager — formula stanja/rezervisano/slobodno", () => {
  it("stanje = SUM(ulaz) − SUM(izlaz) nad dokumentima LEVEL 0", async () => {
    const { prisma, service } = makeService();
    await service.lager({});
    const sql = lagerSql(prisma);
    expect(sql).toContain("SUM(gi.quantity_in - gi.quantity_out)");
    expect(sql).toContain("gd.level = 0");
  });

  it("🔴 NEMA `ABS()` NAD KOLIČINOM — prenos između magacina bi umnožio robu", async () => {
    // Međumagacinski prenos su u BigBit-u DVA dokumenta i OBA nose `Ulaz = True`;
    // odlazak je zapisan kao NEGATIVNA količina (mereno: MMPM +5.005 u magacin 2,
    // MMPR −5.005 iz magacina 1; 87 stavki je negativno). `ABS()` bi obe strane
    // prenosa pretvorio u ulaz, pa bi svaki prenos POVEĆAO ukupnu zalihu — i to
    // za tačno onoliko koliko je preneto, što izgleda kao normalan promet.
    const { prisma, service } = makeService();
    await service.lager({});
    expect(lagerSql(prisma)).not.toMatch(/\bABS\s*\(/i);
  });

  it("rezervisano ide iz ZASTAVICE `is_reservation`, ne iz vrste dokumenta", async () => {
    // Pored REZM (1.071) i REZR (487) rezervišu i OTP (9), PON (6) i PROF (3) —
    // spisak vrsta bi promašio 18 dokumenata, a nova vrsta u BigBit-u nastaje
    // bez pitanja i ne bi se nikad pojavila u koloni REZERVISANO.
    const { prisma, service } = makeService();
    await service.lager({});
    const sql = lagerSql(prisma);
    expect(sql).toContain("WHERE gd.is_reservation");
    expect(sql).not.toContain("REZM");
    expect(sql).not.toContain("REZR");
    expect(sql).not.toMatch(/document_type\s+IN/i);
  });

  it("rezervisano sabira SIROVU količinu sa znakom (zbir in+out, ne razlika)", async () => {
    // Uvoz sirovu `Kolicina` smešta u tačno jednu od dve kolone (druga je 0), pa
    // zbir rekonstruiše original ZAJEDNO SA ZNAKOM. Razlika bi rezervaciji na
    // IZLAZNOM dokumentu okrenula znak — negativna rezervacija bi lažno
    // POVEĆALA slobodnu količinu, tačno na artiklima koji su najviše traženi.
    const { prisma, service } = makeService();
    await service.lager({});
    const sql = lagerSql(prisma);
    expect(sql).toContain(
      "SUM(COALESCE(gi.quantity, gi.quantity_in + gi.quantity_out))",
    );
    expect(sql).not.toContain("gi.quantity_in - gi.quantity_out))");
  });

  it("slobodno = stanje − rezervisano", async () => {
    const { prisma, service } = makeService();
    await service.lager({});
    expect(lagerSql(prisma)).toContain(
      "COALESCE(s.qty, 0) - COALESCE(r.qty, 0)  AS free",
    );
  });

  it("stanje i rezervacije su DISJUNKTNI skupovi (Level 0 vs `is_reservation`)", async () => {
    // Sve rezervacije su Level 250, nijedna Level 0 — rezervacija nikad ne sme
    // da uđe u stanje, inače bi se ista količina brojala dvaput.
    const { prisma, service } = makeService();
    await service.lager({});
    const sql = lagerSql(prisma);
    const stock = sql.slice(
      sql.indexOf("WITH stock AS"),
      sql.indexOf("reserved AS"),
    );
    expect(stock).toContain("gd.level = 0");
    expect(stock).not.toContain("is_reservation");
  });

  it("🔴 MAGACIN SE GRUPIŠE PO STAVCI (`gi`), NIKAD PO ZAGLAVLJU (`gd`)", async () => {
    // Zamka: u Level 0 se magacin stavke i zaglavlja poklapaju u SVIH 18.865
    // stavki, pa bi pogrešan izbor prošao neprimećeno kroz knjižen promet. Ali u
    // Level 250 se razlikuju u 523 stavke — a Level 250 daje baš kolonu
    // REZERVISANO, koja bi tiho sela na pogrešan magacin.
    const { prisma, service } = makeService();
    await service.lager({});
    const sql = lagerSql(prisma);
    expect(sql.match(/GROUP BY gi\.item_id, gi\.warehouse_id/g)).toHaveLength(
      2,
    );
    expect(sql).not.toContain("gd.warehouse_id");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// POSLOVNA GODINA
// ═══════════════════════════════════════════════════════════════════════════

describe("Lager — sečenje po poslovnoj godini", () => {
  it("🔴 SEČE I STANJE I REZERVACIJE — bez toga se stanje UDVOSTRUČI posle 01.01.", async () => {
    // BigBit svaku godinu otvara sopstvenim „Donosom po popisu" (5.437 stavki na
    // 01.01.2026), a uvoz ništa ne briše: ogledalo posle Nove godine drži obe
    // godine, pa prost zbir daje dupli lager koji izgleda savršeno normalno.
    const { prisma, service } = makeService();
    await service.lager({});
    const sql = lagerSql(prisma);
    expect(
      sql.match(
        /COALESCE\(gd\.year, EXTRACT\(YEAR FROM gd\.document_date\)::int\) = \?/g,
      ),
    ).toHaveLength(2);
  });

  it("`reservationScope=all` skida godinu SAMO sa rezervacija, stanje ostaje sečeno", async () => {
    const { prisma, service } = makeService();
    const res = await service.lager({ reservationScope: "all" });
    const sql = lagerSql(prisma);
    expect(sql.match(/COALESCE\(gd\.year, EXTRACT/g)).toHaveLength(1);
    expect(sql.slice(sql.indexOf("reserved AS"))).not.toContain("gd.year");
    expect(res.meta.reservationScope).toBe("all");
  });

  it("zadata godina se poštuje i NE traži se poslednja zatečena", async () => {
    const { prisma, service } = makeService();
    const res = await service.lager({ year: "2024" });
    expect(res.meta).toMatchObject({ year: 2024, yearSource: "query" });
    expect(allSql(prisma).some((s) => s.includes("MAX("))).toBe(false);
  });

  it("bez zadate godine uzima POSLEDNJU ZATEČENU, ne kalendarsku", async () => {
    // 05.01. nova godina u BigBit-u često još nema „Donos po popisu" —
    // kalendarska godina bi tada prikazala prazan lager za pun magacin.
    const { service } = makeService({ year: [{ year: 2025 }] });
    const res = await service.lager({});
    expect(res.meta).toMatchObject({ year: 2025, yearSource: "latest" });
  });

  it("prazno ogledalo → kalendarska godina, označena kao `fallback`", async () => {
    const { service } = makeService({ year: [{ year: null }] });
    const res = await service.lager({});
    expect(res.meta).toMatchObject({
      year: new Date().getFullYear(),
      yearSource: "fallback",
    });
  });

  it("podrazumevana godina je ograničena na kalendarsku — omaška `Godina = 2062` ne gasi ekran", async () => {
    const { prisma, service } = makeService();
    await service.lager({});
    const call = prisma.$queryRaw.mock.calls.find((c) =>
      sqlOf(c).includes("MAX("),
    );
    expect(valuesOf(call!)).toContain(new Date().getFullYear());
  });

  it("`year` van opsega je 400, ne tiho prazna lista", async () => {
    const { service } = makeService();
    await expect(service.lager({ year: "0" })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.lager({ year: "dve hiljade" })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("`reservationScope` van spiska je 400 — razlika je cela kolona SLOBODNO", async () => {
    // ≈ 1,08 M jedinica rezervisano kroz sve godine prema ≈ 71 k u tekućoj.
    const { service } = makeService();
    await expect(
      service.lager({ reservationScope: "sve" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// FILTERI
// ═══════════════════════════════════════════════════════════════════════════

describe("Lager — filteri", () => {
  it("`samo sa stanjem` je PODRAZUMEVANO uključen", async () => {
    // Bez njega ekran nudi 92.511 redova od kojih 7.143 ima stanje — lista bi
    // bila neupotrebljiva, a prvih 50 redova praznih.
    const { prisma, service } = makeService();
    const res = await service.lager({});
    expect(lagerSql(prisma)).toContain("l.stock <> 0");
    expect(res.meta.onlyWithStock).toBe(true);
  });

  it("`onlyWithStock=false` prikazuje i redove bez stanja (npr. samo rezervisane)", async () => {
    const { prisma, service } = makeService();
    const res = await service.lager({ onlyWithStock: "false" });
    expect(lagerSql(prisma)).not.toContain("l.stock <> 0");
    expect(res.meta.onlyWithStock).toBe(false);
  });

  it("`onlyNegative` se SLAŽE sa `samo sa stanjem`, ne zamenjuje ga", async () => {
    const { prisma, service } = makeService();
    await service.lager({ onlyNegative: "true" });
    const sql = lagerSql(prisma);
    expect(sql).toContain("l.stock < 0");
    expect(sql).toContain("l.stock <> 0");
  });

  it("magacin, grupa i pretraga idu kao BIND parametri, ne u tekst upita", async () => {
    const { prisma, service } = makeService();
    await service.lager({ warehouseId: "2", groupCode: "10", q: "lim" });
    const call = prisma.$queryRaw.mock.calls.find((c) =>
      sqlOf(c).includes("WITH stock AS"),
    );
    expect(sqlOf(call!)).toContain("l.warehouse_id = ?");
    expect(sqlOf(call!)).toContain("it.group_code = ?");
    expect(sqlOf(call!)).toContain("it.catalog_number ILIKE ?");
    expect(valuesOf(call!)).toEqual(expect.arrayContaining([2, "10", "%lim%"]));
  });

  it("pretraga hvata i kataloški broj i naziv", async () => {
    const { prisma, service } = makeService();
    await service.lager({ q: "lim" });
    expect(lagerSql(prisma)).toContain(
      "(it.catalog_number ILIKE ? OR it.name ILIKE ?)",
    );
  });

  it("nevalidan boolean je 400, ne tiho `false`", async () => {
    const { service } = makeService();
    await expect(service.lager({ onlyWithStock: "da" })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("`warehouseId` koji nije broj je 400 — `NaN` bi vratio praznu listu", async () => {
    const { service } = makeService();
    await expect(
      service.lager({ warehouseId: "magacin" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SORT I PAGINACIJA
// ═══════════════════════════════════════════════════════════════════════════

describe("Lager — sortiranje (isti obrazac kao /artikli)", () => {
  it("bez sorta = kataloški broj rastuće + tie-break", async () => {
    const { prisma, service } = makeService();
    await service.lager({});
    expect(lagerSql(prisma)).toContain(
      "ORDER BY it.catalog_number ASC NULLS LAST, l.item_id ASC, l.warehouse_id ASC",
    );
  });

  it.each(LAGER_SORT_COLUMNS)(
    "sort po '%s' ima NULLS LAST u OBA smera i tie-break",
    async (column) => {
      for (const dir of ["asc", "desc"]) {
        const { prisma, service } = makeService();
        await service.lager({ sort: column, dir });
        const sql = lagerSql(prisma);
        // Postgres podrazumeva ASC = NULLS LAST, ali DESC = NULLS FIRST — bez
        // izričitog NULLS LAST drugi klik na zaglavlje donese na vrh redove bez
        // vrednosti, a korisnik pomisli da je lista pokvarena.
        expect(sql).toContain(`${dir === "desc" ? "DESC" : "ASC"} NULLS LAST`);
        expect(sql).toContain("l.item_id ASC, l.warehouse_id ASC");
      }
    },
  );

  it("🔴 TIE-BREAK JE PAR (artikal, magacin) — `item_id` sam NIJE jedinstven", async () => {
    // Isti artikal stoji u više magacina. Bez oba ključa Postgres sme da promeni
    // redosled jednakih vrednosti između dva LIMIT/OFFSET upita, a ekran skroluje
    // nadovezivanjem strana: isti red se pojavi dvaput, drugi se izgubi.
    const { prisma, service } = makeService();
    await service.lager({ sort: "stock", dir: "desc" });
    expect(lagerSql(prisma)).toMatch(
      /ORDER BY l\.stock DESC NULLS LAST, l\.item_id ASC, l\.warehouse_id ASC/,
    );
  });

  it("kolona van spiska je 400 SA SPISKOM dozvoljenih", async () => {
    const { service } = makeService();
    await expect(service.lager({ sort: "cena" })).rejects.toThrow(
      /Dozvoljene kolone: catalogNumber, name/,
    );
  });

  it("nijedan tekst iz zahteva ne završi u ORDER BY", async () => {
    const { service } = makeService();
    await expect(
      service.lager({ sort: "l.stock; DROP TABLE items" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("`dir` van `asc|desc` je 400", async () => {
    const { service } = makeService();
    await expect(
      service.lager({ sort: "stock", dir: "nagore" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("ukupan broj dolazi iz window count-a, ne iz drugog upita", async () => {
    const { prisma, service } = makeService({
      lager: [lagerRow({ totalCount: 7143 })],
    });
    const res = await service.lager({});
    expect(lagerSql(prisma)).toContain("COUNT(*) OVER ()::int");
    expect(res.meta.pagination.total).toBe(7143);
    // Jedan agregat nad ~182.500 stavki, ne dva.
    expect(
      allSql(prisma).filter((s) => s.includes("WITH stock AS")),
    ).toHaveLength(1);
  });

  it("prazna strana daje total 0, a ne pad", async () => {
    const { service } = makeService({ lager: [] });
    const res = await service.lager({ page: "99" });
    expect(res.data).toEqual([]);
    expect(res.meta.pagination.total).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// OBLIK ODGOVORA
// ═══════════════════════════════════════════════════════════════════════════

describe("Lager — oblik odgovora", () => {
  it("količine i cene su STRINGOVI, normalizovani (BACKEND_RULES §6)", async () => {
    const { service } = makeService({ lager: [lagerRow()] });
    const [row] = (await service.lager({})).data;
    expect(row.stock).toBe("65");
    expect(row.reserved).toBe("20");
    expect(row.free).toBe("45");
    expect(row.wholesalePrice).toBe("1250");
  });

  it("negativno stanje zadržava znak", async () => {
    const { service } = makeService({
      lager: [lagerRow({ stock: "-12.5000", free: "-32.5000" })],
    });
    const [row] = (await service.lager({})).data;
    expect(row.stock).toBe("-12.5");
    expect(row.free).toBe("-32.5");
  });

  it("prazna cena ostaje prazna — `null` ne postaje „0“", async () => {
    const { service } = makeService({
      lager: [lagerRow({ wholesalePrice: null })],
    });
    const [row] = (await service.lager({})).data;
    expect(row.wholesalePrice).toBeNull();
  });

  it("magacin se vraća KAO NAZIV, uz pad na „Magacin N“", async () => {
    // BigBit magacini (1, 2, 44) nisu isti skup kao 4.0 `warehouses`: magacin
    // koji u 4.0 nije zaveden ostao bi prazna ćelija u kojoj se ne vidi ni o kom
    // je magacinu reč, a zaliha na njemu postoji.
    const { service } = makeService({
      lager: [
        lagerRow(),
        lagerRow({ warehouseId: 44, warehouseName: null, totalCount: 2 }),
      ],
    });
    const rows = (await service.lager({})).data;
    expect(rows[0].warehouse).toEqual({ id: 1, name: "Magacin robe" });
    expect(rows[1].warehouse).toEqual({ id: 44, name: "Magacin 44" });
  });

  it("minimalna količina je u odgovoru, normalizovana kao i ostale količine", async () => {
    // Kolona je `double precision` u šemi, pa upit ide kroz `::numeric::text` —
    // bez toga bi 0.3 umelo da stigne kao „0.30000000000000004" i magacioner bi
    // video sopstveni unos izobličen.
    const { service } = makeService({ lager: [lagerRow({ minQuantity: "2.500" })] });
    const [row] = (await service.lager({})).data;
    expect(row.minQuantity).toBe("2.5");
  });

  it("🔴 prazna minimalna OSTAJE prazna — `null` nije `0`", async () => {
    // „Prag nije postavljen" i „prag je nula" nisu isto: mereno 06.08.2026 na
    // produkciji, 92.460 artikala ima 0, a 3 imaju prazno. Kad bi se prazno
    // prikazalo kao 0, spisak „ispod minimalne" bi ta tri reda tretirao kao
    // praćene artikle sa pragom nula.
    const { service } = makeService({ lager: [lagerRow({ minQuantity: null })] });
    const [row] = (await service.lager({})).data;
    expect(row.minQuantity).toBeNull();
  });

  it("grupa se razrešava batch-om i preživljava PRAZAN šifarnik", async () => {
    // `item_groups` je danas prazan (syncer za `R_Grupa` ne postoji) — obavezan
    // JOIN bi ovde vratio 500 umesto liste zaliha.
    const { prisma, service } = makeService({ lager: [lagerRow()] });
    const [row] = (await service.lager({})).data;
    expect(row.group).toEqual({ code: "10", description: null });
    expect(prisma.itemGroup.findMany).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// KARTICA ROBNOG KRETANJA
// ═══════════════════════════════════════════════════════════════════════════

/** Red kartice kakav upit vraća. */
function cardRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    documentId: 10,
    documentNumber: "1/26",
    documentType: "UFROB",
    documentDate: "2026-01-01",
    postingDate: "2026-01-01",
    isInflow: true,
    customerId: null,
    customerName: null,
    projectId: null,
    warehouseId: 1,
    warehouseName: "Magacin robe",
    quantityIn: "100.0000",
    quantityOut: "0.0000",
    purchasePriceNet: null,
    actualWholesalePrice: null,
    description: null,
    ...over,
  };
}

describe("Kartica robnog kretanja", () => {
  it("gleda SAMO knjižen promet (Level 0) — mora da se slaže sa kolonom STANJE", async () => {
    const { prisma, service } = makeService();
    await service.goodsCard(7, {});
    const sql = allSql(prisma).find((s) =>
      s.includes("goods_document_items_mirror"),
    )!;
    expect(sql).toContain("gd.level = 0");
    expect(sql).not.toContain("level >= 250");
  });

  it("tekuće stanje se sabira po redovima (ulaz − izlaz)", async () => {
    const { service } = makeService({
      card: [
        cardRow({ id: 1, quantityIn: "100.0000", quantityOut: "0.0000" }),
        cardRow({ id: 2, quantityIn: "0.0000", quantityOut: "30.0000" }),
        cardRow({ id: 3, quantityIn: "-5.0000", quantityOut: "0.0000" }),
      ],
    });
    const res = await service.goodsCard(7, {});
    expect(res.data.map((r) => r.balance)).toEqual(["100", "70", "65"]);
    expect(res.meta).toMatchObject({
      openingBalance: "0",
      totalIn: "95",
      totalOut: "30",
      closingBalance: "65",
      count: 3,
    });
  });

  it("🔴 PERIOD NE POČINJE OD NULE — `from` povlači početno stanje", async () => {
    // Bez toga bi kartica za mart pokazala „stanje 12" za artikal kojeg u
    // magacinu ima 137, i to bez ijednog znaka da nešto fali.
    const { prisma, service } = makeService({
      opening: [{ value: "125.0000" }],
      card: [cardRow({ quantityIn: "10.0000" })],
    });
    const res = await service.goodsCard(7, { from: "2026-03-01" });
    expect(res.meta.openingBalance).toBe("125");
    expect(res.data[0].balance).toBe("135");
    const opening = allSql(prisma).find((s) =>
      s.includes("SELECT COALESCE(SUM("),
    )!;
    expect(opening).toContain("< ?");
    expect(opening).toContain("gd.level = 0");
  });

  it("bez `from` se početno stanje uopšte ne traži (donos je već u podacima)", async () => {
    const { prisma, service } = makeService();
    await service.goodsCard(7, {});
    expect(allSql(prisma).some((s) => s.includes("SELECT COALESCE(SUM("))).toBe(
      false,
    );
  });

  it("period se seče po datumu KNJIŽENJA, sa padom na datum isprave", async () => {
    const { prisma, service } = makeService();
    await service.goodsCard(7, { from: "2026-01-01", to: "2026-12-31" });
    const sql = allSql(prisma).find((s) => s.includes("ORDER BY COALESCE"))!;
    expect(sql).toContain("COALESCE(gd.posting_date, gd.document_date) >= ?");
    expect(sql).toContain("COALESCE(gd.posting_date, gd.document_date) <= ?");
  });

  it("datumi se vezuju kao `YYYY-MM-DD` sa `::date` — zona ne ulazi u igru", async () => {
    const { prisma, service } = makeService();
    await service.goodsCard(7, { from: "2026-03-01" });
    const call = prisma.$queryRaw.mock.calls.find((c) =>
      sqlOf(c).includes("ORDER BY COALESCE"),
    )!;
    expect(sqlOf(call)).toContain("::date");
    expect(valuesOf(call)).toContain("2026-03-01");
  });

  it("filter magacina gađa magacin STAVKE", async () => {
    const { prisma, service } = makeService();
    await service.goodsCard(7, { warehouseId: "2" });
    const sql = allSql(prisma).find((s) => s.includes("ORDER BY COALESCE"))!;
    expect(sql).toContain("gi.warehouse_id = ?");
  });

  it("nevalidan datum je 400", async () => {
    const { service } = makeService();
    await expect(service.goodsCard(7, { from: "juče" })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("odsečena kartica to i KAŽE (`truncated`), ne ćuti", async () => {
    const { service } = makeService({
      card: Array.from({ length: 5001 }, (_, i) => cardRow({ id: i })),
    });
    const res = await service.goodsCard(7, {});
    expect(res.data).toHaveLength(5000);
    expect(res.meta).toMatchObject({ truncated: true, limit: 5000 });
  });

  it("kartica nepostojećeg artikla je 404, ne prazna kartica", async () => {
    // Artikal bez ijednog robnog dokumenta i artikal koji ne postoji daju
    // IDENTIČNU praznu karticu — greška u linku bi izgledala kao podatak.
    const { prisma, service } = makeService();
    prisma.item.findUnique.mockResolvedValueOnce(null);
    await expect(service.goodsCard(999, {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(allSql(prisma).some((s) => s.includes("goods_document_items"))).toBe(
      false,
    );
  });

  it("zaglavlje kartice nosi artikal (ekran ne mora u drugi poziv)", async () => {
    const { service } = makeService();
    const res = await service.goodsCard(7, {});
    expect(res.meta.item).toEqual(ITEM);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// KARTICA NARUDŽBINA
// ═══════════════════════════════════════════════════════════════════════════

describe("Kartica narudžbina (BigBit trebovanja)", () => {
  it("čita OGLEDALO, ne 4.0-native `purchase_orders` (koji je prazan)", async () => {
    const { prisma, service } = makeService();
    await service.ordersCard(7, {});
    const sql = allSql(prisma).find((s) =>
      s.includes("purchase_order_items_mirror"),
    )!;
    expect(sql).toContain("purchase_orders_mirror po");
    expect(sql).not.toMatch(/FROM purchase_orders\s/);
  });

  it("ostatak isporuke nikad nije negativan (višak isporuke = 0)", async () => {
    const { service } = makeService({
      orders: [
        {
          id: 1,
          orderId: 1,
          orderNumber: "TR-1",
          orderDate: "2026-02-10",
          supplierId: null,
          supplierName: null,
          projectId: null,
          level: 0,
          isOrdered: true,
          year: 2026,
          note: null,
          orderedQuantity: "40.000000",
          receivedQuantity: "55.000000",
          unitPrice: null,
          discountPercent: null,
          description: null,
          expectedDeliveryDate: null,
          actualDeliveryDate: null,
          isDelivered: true,
          totalCount: 1,
        },
      ],
    });
    const [row] = (await service.ordersCard(7, {})).data;
    expect(row.remainingQuantity).toBe("0");
    expect(row.orderedQuantity).toBe("40");
    expect(row.receivedQuantity).toBe("55");
  });

  it("`onlyOpen` traži neisporučene stavke", async () => {
    const { prisma, service } = makeService();
    await service.ordersCard(7, { onlyOpen: "true" });
    expect(
      allSql(prisma).find((s) => s.includes("purchase_order_items_mirror")),
    ).toContain("poi.is_delivered = false");
  });

  it("NE seče se po godini podrazumevano — decembarska narudžbina stiže u januaru", async () => {
    const { prisma, service } = makeService();
    const res = await service.ordersCard(7, {});
    expect(
      allSql(prisma).find((s) => s.includes("purchase_order_items_mirror")),
    ).not.toContain("COALESCE(po.year,");
    expect(res.meta.year).toBeNull();
  });

  it("godina je i dalje dostupna kao izričit filter", async () => {
    const { prisma, service } = makeService();
    await service.ordersCard(7, { year: "2025" });
    expect(
      allSql(prisma).find((s) => s.includes("purchase_order_items_mirror")),
    ).toContain("COALESCE(po.year,");
  });

  it("najnovije prvo (kartica odgovara na „šta je poslednje poručeno“)", async () => {
    const { prisma, service } = makeService();
    await service.ordersCard(7, {});
    expect(
      allSql(prisma).find((s) => s.includes("purchase_order_items_mirror")),
    ).toContain(
      "ORDER BY po.order_date DESC NULLS LAST, po.id DESC, poi.id DESC",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// KARTICA PROFAKTURA
// ═══════════════════════════════════════════════════════════════════════════

describe("Kartica profaktura", () => {
  it("🔴 „Profakture“ JE UPIT `Level >= 250`, ne tabela i ne spisak vrsta", async () => {
    // Isti skup nosi ponude, predračune, rezervacije i otpremnice (25.810
    // dokumenata / 163.674 stavke). Spisak vrsta bi propustio svaku novu vrstu
    // radnog dokumenta koju BigBit dobije bez pitanja.
    const { prisma, service } = makeService();
    await service.proformaCard(7, {});
    const sql = allSql(prisma).find((s) => s.includes("gd.level >= 250"))!;
    expect(sql).toContain("gd.level >= 250");
    expect(sql).not.toContain("gd.level = 250");
    expect(sql).not.toContain("PROF");
  });

  it("`isReservation` je zasebna kolona — jedini podatak koji vezuje red za SLOBODNO", async () => {
    const { service } = makeService({
      card: [
        {
          id: 1,
          documentId: 5,
          documentNumber: "P-1",
          documentType: "REZM",
          documentDate: "2026-04-01",
          postingDate: null,
          level: 250,
          isReservation: true,
          isInflow: false,
          customerId: null,
          customerName: null,
          projectId: null,
          year: 2026,
          warehouseId: 1,
          warehouseName: "Magacin robe",
          quantity: "20.0000",
          actualWholesalePrice: null,
          discountPercent: null,
          description: null,
          totalCount: 1,
        },
      ],
    });
    const [row] = (await service.proformaCard(7, {})).data;
    expect(row.isReservation).toBe(true);
    expect(row.quantity).toBe("20");
    expect(row.warehouse).toEqual({ id: 1, name: "Magacin robe" });
  });

  it("količina je SIROVA, sa znakom (isti izraz kao rezervisano u lageru)", async () => {
    const { prisma, service } = makeService();
    await service.proformaCard(7, {});
    expect(allSql(prisma).find((s) => s.includes("gd.level >= 250"))).toContain(
      "COALESCE(gi.quantity, gi.quantity_in + gi.quantity_out)::text",
    );
  });

  it("`onlyReservations` i vrsta dokumenta su opcioni filteri", async () => {
    const { prisma, service } = makeService();
    await service.proformaCard(7, {
      onlyReservations: "true",
      documentType: "PON",
    });
    const call = prisma.$queryRaw.mock.calls.find((c) =>
      sqlOf(c).includes("gd.level >= 250"),
    )!;
    expect(sqlOf(call)).toContain("gd.is_reservation");
    expect(sqlOf(call)).toContain("gd.document_type = ?");
    expect(valuesOf(call)).toContain("PON");
  });

  it("godina je OPCIONA — višegodišnja istorija ponuda nije greška", async () => {
    const { prisma, service } = makeService();
    const res = await service.proformaCard(7, {});
    expect(
      allSql(prisma).find((s) => s.includes("gd.level >= 250")),
    ).not.toContain("gd.year, EXTRACT");
    expect(res.meta.year).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// READ-ONLY
// ═══════════════════════════════════════════════════════════════════════════

describe("Ogledalo je READ-ONLY", () => {
  it("nijedan poziv ne izdaje upis, ni kroz raw SQL", async () => {
    // BigBit je vlasnik robnog do cutover-a (april 2027). Upis odavde bi nestao
    // pri prvom noćnom uvozu — isti razlog zbog kojeg je unos artikla zatvoren.
    const { prisma, service } = makeService({ lager: [lagerRow()] });
    await service.lager({});
    await service.goodsCard(7, { from: "2026-01-01" });
    await service.ordersCard(7, {});
    await service.proformaCard(7, {});
    for (const sql of allSql(prisma))
      expect(sql).not.toMatch(
        /\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER)\b/i,
      );
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// RUTE I PERMISIJE
// ═══════════════════════════════════════════════════════════════════════════

describe("ItemsController — lager i kartice", () => {
  const ROUTES = ["lager", "goodsCard", "ordersCard", "proformaCard"];

  it("sve tri kartice i lager nasleđuju KLASNI `directory.read`", () => {
    // Odluka, ne previd: ovo je read-only ogledalo BigBit-a — isti podatak koji
    // magacioner ionako vidi u BigBit-u. Zaseban `robno.*` ključ bi značio da
    // „drugi pregled artikala" nestane polovini kruga koji vidi prvi pregled.
    expect(Reflect.getMetadata(PERMISSION_KEY_METADATA, ItemsController)).toBe(
      PERMISSIONS.DIRECTORY_READ,
    );
    for (const name of ROUTES) {
      const handler = Object.getOwnPropertyDescriptor(
        ItemsController.prototype,
        name,
      )?.value as object;
      expect(handler).toBeDefined();
      expect(
        Reflect.getMetadata(PERMISSION_KEY_METADATA, handler),
      ).toBeUndefined();
    }
  });

  it("🔴 izmena minimalne traži SVOJ ključ, ne klasni `directory.read`", () => {
    // `directory.read` ima skoro svaka rola (VIEWER_READ_BASELINE). Da metoda ne
    // nosi svoj `@RequirePermission`, nasledila bi klasni ključ i minimalne
    // količine bi mogao da menja svako ko vidi šifarnik — umesto troje imenovanih.
    const handler = Object.getOwnPropertyDescriptor(
      ItemsController.prototype,
      "setMinQuantity",
    )?.value as object;
    expect(handler).toBeDefined();
    expect(Reflect.getMetadata(PERMISSION_KEY_METADATA, handler)).toBe(
      PERMISSIONS.MASTERS_MIN_QUANTITY,
    );
    // I NE `masters.write`: taj kišobran nosi ceo šifarnik (artikli + komitenti).
    expect(Reflect.getMetadata(PERMISSION_KEY_METADATA, handler)).not.toBe(
      PERMISSIONS.MASTERS_WRITE,
    );
  });

  it("🔴 SORT_EXPR i LAGER_SORT_COLUMNS se ne smeju razići — allowlist je jedina brana", async () => {
    // Izraz sorta ide kroz `Prisma.raw`. Kolona koja je u DTO spisku a nije u
    // `SORT_EXPR` dala bi `undefined` u ORDER BY (500 ili, gore, `Prisma.raw` nad
    // nedefinisanim); obrnut smer ostavlja mrtav izraz. Provera je posredna, jer je
    // `SORT_EXPR` privatan: svaka kolona iz spiska mora da proizvede ORDER BY sa
    // stvarnim SQL izrazom, nikad sa imenom iz zahteva.
    for (const column of LAGER_SORT_COLUMNS) {
      const { prisma, service } = makeService();
      await service.lager({ sort: column });
      const sql = lagerSql(prisma);
      const orderBy = sql.slice(sql.indexOf("ORDER BY"));
      expect(orderBy).not.toContain("undefined");
      // Ime kolone iz zahteva (camelCase) ne sme da procuri u SQL — u ORDER BY
      // stoji izraz nad tabelom (`it.min_quantity`, `l.stock`, `w.name`…).
      expect(orderBy).toMatch(/ORDER BY (it|l|w)\.[a-z_]+ (ASC|DESC) NULLS LAST/);
    }
  });

  it("🔴 `/lager` je DEKLARISAN pre `/:id` — inače ga guta ParseIntPipe sa 400", () => {
    // Nest mapira rute redom kojim su metode deklarisane u klasi. Ispod `:id` bi
    // „lager" upalo u `findOne`, a `ParseIntPipe` bi na tekst vratio 400
    // („numeric string is expected") — ekran zaliha bi bio mrtav, uz poruku koja
    // ni ne pominje rutu. Ista zamka je već jednom pogodila `/lookups`.
    const methods = Object.getOwnPropertyNames(ItemsController.prototype);
    expect(methods.indexOf("lager")).toBeGreaterThan(-1);
    expect(methods.indexOf("lager")).toBeLessThan(methods.indexOf("findOne"));
  });
});
