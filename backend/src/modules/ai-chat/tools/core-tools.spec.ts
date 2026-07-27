import { CORE_TOOLS, unaccentLike } from "./core-tools";
import { PERMISSIONS } from "../../../common/authz/permissions";
import type { AiTool, ToolCtx } from "./tool-registry";

/**
 * TALAS AI-1, tačka 3 — alati nad glavnom bazom. Mokujemo `PrismaService`
 * ($queryRaw) i `KadrovskaService`: proveravamo OBLIK rezultata koji ide modelu
 * (kompaktan, na srpskom), prazan rezultat i to da SVAKI upit ide kroz
 * indeksirani izraz `immutable_unaccent(lower(...))` sa `ORDER BY` pre `LIMIT`-a
 * — bez toga planer bira Seq Scan (mereno: 159 ms vs 1,9 ms na 30k redova).
 */

function tool(name: string): AiTool {
  const t = CORE_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`nema alata ${name}`);
  return t;
}

/** `$queryRaw` vraća redom pripremljene rezultate; pamti izvršeni SQL tekst. */
function makeCtx(
  results: unknown[][],
  attendance: unknown[] = [],
  permissions: ReadonlySet<string> | undefined = new Set([
    PERMISSIONS.RN_READ,
    PERMISSIONS.TEHNOLOGIJA_READ,
    PERMISSIONS.ROBNO_READ,
    PERMISSIONS.DIRECTORY_READ,
    PERMISSIONS.KADROVSKA_ATTENDANCE,
  ]),
) {
  const sql: string[] = [];
  let i = 0;
  const $queryRaw = jest.fn((q: { strings?: string[]; sql?: string }) => {
    sql.push(q?.sql ?? (q?.strings ?? []).join("?"));
    return Promise.resolve(results[i++] ?? []);
  });
  const kadrovska = {
    attendanceNow: jest.fn().mockResolvedValue({ data: attendance }),
  };
  const ctx = {
    email: "u@servoteh.com",
    permissions,
    deps: {
      prisma: { $queryRaw },
      kadrovska,
      sy15: {},
      ai: {},
    },
  } as unknown as ToolCtx;
  return { ctx, sql, $queryRaw, kadrovska };
}

describe("nadji_radni_nalog", () => {
  it("happy path: vraća naloge + broj pogodaka", async () => {
    const { ctx, sql } = makeCtx([
      [
        {
          ident: "9400-12",
          naziv_dela: "Prirubnica",
          status: "u radu",
          rok: "31.08.2026",
          predmet: "9400/7",
        },
      ],
    ]);
    const out = (await tool("nadji_radni_nalog").execute(
      { upit: "prirubnica" },
      ctx,
    )) as { nadjeno: number; nalozi: unknown[] };
    expect(out.nadjeno).toBe(1);
    expect(out.nalozi).toHaveLength(1);
    // Pretraga mora ići kroz indeksirani izraz + ORDER BY pre LIMIT-a.
    expect(sql[0]).toContain("immutable_unaccent(lower(");
    expect(sql[0]).toContain("ORDER BY");
    // LIMIT je parametrizovan (limit+1 sentinel), pa se proverava sam kljucni zbor.
    expect(sql[0]).toContain("LIMIT");
  });

  it("prazan rezultat: nadjeno = 0, bez izmišljanja", async () => {
    const { ctx } = makeCtx([[]]);
    const out = (await tool("nadji_radni_nalog").execute(
      { upit: "nepostojeci" },
      ctx,
    )) as { nadjeno: number; nalozi: unknown[]; ima_jos: boolean };
    expect(out).toMatchObject({ nadjeno: 0, ima_jos: false, nalozi: [] });
  });

  it("prazan upit ne povlači celu tabelu", async () => {
    const { ctx, $queryRaw } = makeCtx([[]]);
    const out = await tool("nadji_radni_nalog").execute({ upit: "  " }, ctx);
    expect(out).toMatchObject({ greska: "prazan_upit" });
    expect($queryRaw).not.toHaveBeenCalled();
  });

  // Nalaz 17: ispod 3 znaka pg_trgm ne može da koristi indeks → Seq Scan 40k.
  it("pojam kraći od 3 znaka se odbija PRE upita", async () => {
    const { ctx, $queryRaw } = makeCtx([[]]);
    const out = await tool("nadji_radni_nalog").execute({ upit: "ab" }, ctx);
    expect(out).toMatchObject({ greska: "prekratak_upit" });
    expect($queryRaw).not.toHaveBeenCalled();
  });

  // Nalaz 21: na kapi model NE sme da čuje tačan broj.
  it("LIMIT sentinel: 16 redova daje 15 prikazanih + oznaku da ima jos", async () => {
    const many = Array.from({ length: 16 }, (_, i) => ({ ident: `RN-${i}` }));
    const { ctx, sql } = makeCtx([many]);
    const out = (await tool("nadji_radni_nalog").execute(
      { upit: "prirubnica" },
      ctx,
    )) as { nadjeno: string; ima_jos: boolean; nalozi: unknown[] };
    expect(out.nalozi).toHaveLength(15);
    expect(out.nadjeno).toBe(">= 15");
    expect(out.ima_jos).toBe(true);
    // LIMIT+1 sentinel, NE count(*) OVER () (ubija top-N plan).
    expect(sql[0]).not.toContain("OVER");
  });

  it("tacno 15 redova NIJE ima_jos (sentinel red nije stigao)", async () => {
    const exact = Array.from({ length: 15 }, (_, i) => ({ ident: `RN-${i}` }));
    const { ctx } = makeCtx([exact]);
    const out = (await tool("nadji_radni_nalog").execute(
      { upit: "prirubnica" },
      ctx,
    )) as { nadjeno: number; ima_jos: boolean };
    expect(out).toMatchObject({ nadjeno: 15, ima_jos: false });
  });
});

// Nalaz 24: bez eskejpa „50%" znači „50 + bilo šta", „a_b" poklapa „axb".
describe("unaccentLike — escape LIKE meta-znakova", () => {
  const params = (term: string) =>
    (
      unaccentLike(
        { strings: ["x"], values: [] } as never,
        term,
      ) as unknown as {
        values: unknown[];
      }
    ).values;

  it("%, _ i \\ se eskejpuju u parametru", () => {
    expect(params("50%")).toContain("50\\%");
    expect(params("a_b")).toContain("a\\_b");
    expect(params("c\\d")).toContain("c\\\\d");
  });

  it("običan pojam ostaje netaknut", () => {
    expect(params("zaptivač")).toContain("zaptivač");
  });
});

// Od AI-5 review-a [5] istorija_crteza DELEGIRA na deljeni estimateForDrawing:
// razreši ident → crtež (poIdentu), pa estimateForDrawing(skipIdentResolve) čita
// tech_processes (NE work_time_entries) sa istim filterom kao alat procena_vremena.
describe("istorija_crteza (delegira na estimateForDrawing — review [5])", () => {
  it("po identu RN-a razreši crtež, pa delegira agregat po radnom mestu (tech_processes)", async () => {
    const { ctx, sql } = makeCtx([
      [{ crtez: "CRT-100" }], // istorijin poIdentu (identMatch)
      [{ ident: "9400-12", varijanta: 0, kolicina: 4 }], // estimateForDrawing: nalozi
      [
        {
          radno_mesto: "G1",
          naziv_radnog_mesta: "Glodalica",
          plan_h_prosek: 2.5,
          stvarno_h_p50: 2.6,
          naloga_sa_prijavom: 12,
        },
      ],
      [{ broj_naloga: 7, prijava_ukupno: 20, prijava_izbaceno: 8 }],
    ]);
    const out = (await tool("istorija_crteza").execute(
      { crtez: "9400-12" },
      ctx,
    )) as {
      crtez: string;
      broj_naloga: number;
      po_radnom_mestu: unknown[];
      napomena: string;
    };
    expect(out.crtez).toBe("CRT-100");
    expect(out.broj_naloga).toBe(7);
    expect(out.po_radnom_mestu).toHaveLength(1);
    expect(out.napomena).toContain("SATIMA");
    // Stvarni izvor je sada tech_processes (NE work_time_entries), isti kao AI-5.
    expect(sql[2]).toContain("setup_time");
    expect(sql[2]).toContain("tech_processes");
    expect(sql[2]).not.toContain("work_time_entries");
    expect(sql[2]).not.toContain("auto_closed");
  });

  /** SIMETRIJA (nalaz 19) + filter šuma: < 1 min, > 720 h, is_process_finished. */
  it("plan i stvarno po (nalog, radno mesto); filter < 1 min + > 720 h", async () => {
    const { ctx, sql } = makeCtx([
      [{ crtez: "CRT-100" }],
      [{ ident: "9400-12" }],
      [],
      [{ broj_naloga: 3, prijava_ukupno: 20, prijava_izbaceno: 9 }],
    ]);
    const out = (await tool("istorija_crteza").execute(
      { crtez: "CRT-100" },
      ctx,
    )) as { napomena: string; prijava_izbaceno: number };
    const agregat = sql[2];
    expect(agregat).toContain("plan_po_nalogu");
    expect(agregat).toContain("stvarno_po_nalogu");
    expect(agregat).not.toMatch(/avg\(\s*COALESCE\(woo\.setup_time/);
    expect(agregat).toContain("interval '1 minute'");
    expect(agregat).toContain("720 hours");
    expect(agregat).toContain("is_process_finished");
    expect(out.prijava_izbaceno).toBe(9);
    expect(out.napomena).toContain("9 od 20");
    expect(out.napomena).toContain("filtriran");
  });

  it("crtež bez ijednog naloga: 0 naloga, prazne liste + predlog", async () => {
    const { ctx } = makeCtx([[], []]);
    const out = (await tool("istorija_crteza").execute(
      { crtez: "NEMA" },
      ctx,
    )) as {
      broj_naloga: number;
      po_radnom_mestu: unknown[];
      poslednji_nalozi: unknown[];
      predlog: string;
    };
    // Nalaz 24: isti ključ (`poslednji_nalozi`) i kad je prazno i kad nije.
    expect(out).toMatchObject({
      broj_naloga: 0,
      po_radnom_mestu: [],
      poslednji_nalozi: [],
    });
    expect(out.predlog).toContain("crteža");
  });
});

describe("nadji_artikal", () => {
  it("vraća artikle sa zalihom i napomenom o izvoru", async () => {
    const { ctx, sql } = makeCtx([
      [
        {
          naziv: "Zaptivač gumeni",
          kataloski_broj: "KAT-1",
          jm: "kom",
          stanje_mrp: 12,
        },
      ],
    ]);
    const out = (await tool("nadji_artikal").execute(
      { upit: "zaptivac" },
      ctx,
    )) as { nadjeno: number; artikli: unknown[] };
    expect(out.nadjeno).toBe(1);
    // Dijakritika: upit „zaptivac" mora ići kroz unaccent i na nazivu i na katbroju.
    expect(
      sql[0].match(/immutable_unaccent\(lower\(/g)?.length,
    ).toBeGreaterThan(2);
  });

  it("nema pogotka → prazna lista", async () => {
    const { ctx } = makeCtx([[]]);
    const out = (await tool("nadji_artikal").execute(
      { upit: "nepostojeci" },
      ctx,
    )) as { nadjeno: number; artikli: unknown[] };
    expect(out).toMatchObject({ nadjeno: 0, artikli: [] });
  });
});

describe("stanje_predmeta", () => {
  it("predmet + zbir naloga + otvoreni nalozi", async () => {
    const { ctx, $queryRaw } = makeCtx([
      [{ id: 5, predmet: "9400/7", opis: "Pumpna stanica" }],
      [{ project_id: 5, naloga_ukupno: 12, zavrseno: 8, u_radu: 4 }],
      [{ project_id: 5, ident: "9400-12", rok: "31.08.2026" }],
    ]);
    const out = (await tool("stanje_predmeta").execute(
      { broj_predmeta: "9400/7" },
      ctx,
    )) as {
      nadjeno: number;
      nalozi_zbir: unknown[];
      otvoreni_nalozi: unknown[];
    };
    expect(out.nadjeno).toBe(1);
    expect(out.nalozi_zbir).toHaveLength(1);
    expect(out.otvoreni_nalozi).toHaveLength(1);
    expect($queryRaw).toHaveBeenCalledTimes(3);
  });

  /**
   * Nalaz 0 — PER-SEKCIJA PERMISIJA. Ulazna permisija alata je `directory.read`,
   * ali lista radnih naloga je RN domen. Bez ove provere bi „šta je sa predmetom
   * X" bilo zaobilaznica za korisnika kome je `rn.read` izričito ODUZET.
   */
  it("bez rn.read: predmet DA, nalozi NE — i ti SELECT-i se ne pokreću", async () => {
    const { ctx, $queryRaw } = makeCtx(
      [[{ id: 5, predmet: "9400/7", opis: "Pumpna stanica" }]],
      [],
      new Set([PERMISSIONS.DIRECTORY_READ]), // ima predmete, nema naloge
    );
    const out = (await tool("stanje_predmeta").execute(
      { broj_predmeta: "9400/7" },
      ctx,
    )) as {
      nadjeno: number;
      predmeti: unknown[];
      napomena: string;
      otvoreni_nalozi?: unknown[];
      nalozi_zbir?: unknown[];
    };
    expect(out.predmeti).toHaveLength(1);
    expect(out.otvoreni_nalozi).toBeUndefined();
    expect(out.nalozi_zbir).toBeUndefined();
    expect(out.napomena).toContain("Nalozi izostavljeni");
    expect($queryRaw).toHaveBeenCalledTimes(1); // samo predmet, bez RN upita
  });

  it("nepoznat predmet: ne traži naloge uopšte + uputa na nadji_radni_nalog", async () => {
    const { ctx, $queryRaw } = makeCtx([[]]);
    const out = (await tool("stanje_predmeta").execute(
      { broj_predmeta: "0000/0" },
      ctx,
    )) as { nadjeno: number; predlog: string };
    expect(out).toMatchObject({ nadjeno: 0, predmeti: [] });
    expect(out.predlog).toContain("nadji_radni_nalog");
    expect($queryRaw).toHaveBeenCalledTimes(1);
  });

  it("kratak broj predmeta radi (tačno poklapanje), ali BEZ trigrama po opisu", async () => {
    const { ctx, sql } = makeCtx([[]]);
    await tool("stanje_predmeta").execute({ broj_predmeta: "77" }, ctx);
    expect(sql[0]).toContain("btrim(p.project_number)");
    // Trigram grana (po opisu) je izostavljena — na <3 znaka nema indeksa.
    expect(sql[0]).not.toContain("immutable_unaccent");
  });
});

describe("tehnoloski_postupak_naloga", () => {
  it("operacije sa planom, prijavama i stvarnim satima", async () => {
    const { ctx, sql } = makeCtx([
      [{ id: 42, ident: "9400-12", kolicina: 4 }],
      [
        {
          rb: 10,
          radno_mesto: "G1",
          plan_h: 3.2,
          prijava: 2,
          zavrsena: true,
          stvarno_h: 2.8,
        },
      ],
    ]);
    const out = (await tool("tehnoloski_postupak_naloga").execute(
      { ident: "9400-12" },
      ctx,
    )) as { operacije: unknown[]; napomena: string };
    expect(out.operacije).toHaveLength(1);
    expect(out.napomena).toContain("SATIMA");
    expect(sql[1]).toContain("tech_processes");
    expect(sql[1]).toContain("work_time_entries");
    // Nalaz 20: isti filter šuma i ovde, uz brojanje izbačenih po operaciji.
    expect(sql[1]).toContain("interval '1 minute'");
    expect(sql[1]).toContain("auto_closed");
    expect(sql[1]).toContain("prijava_izbaceno");
    expect(out.napomena).toContain("prijava_izbaceno");
  });

  it("nepostojeći ident → nadjeno 0, bez drugog upita + uputa na pretragu", async () => {
    const { ctx, $queryRaw } = makeCtx([[]]);
    const out = (await tool("tehnoloski_postupak_naloga").execute(
      { ident: "NEMA" },
      ctx,
    )) as { nadjeno: number; predlog: string };
    expect(out).toMatchObject({ nadjeno: 0, operacije: [] });
    expect(out.predlog).toContain("nadji_radni_nalog");
    expect($queryRaw).toHaveBeenCalledTimes(1);
  });
});

describe("prisustvo_danas", () => {
  it("zove POSTOJEĆI servis kadrovske i sabira statuse", async () => {
    const { ctx, kadrovska, $queryRaw } = makeCtx(
      [],
      [
        { status: "prisutan", department: "Proizvodnja" },
        { status: "prisutan", department: "Proizvodnja" },
        { status: "pauza", department: "Montaza" },
        { status: "odsutan", department: null },
      ],
    );
    const out = (await tool("prisustvo_danas").execute({}, ctx)) as {
      prisutno: number;
      pauza: number;
      odsutno: number;
      ukupno_sa_prolazom_24h: number;
      po_odeljenju: { odeljenje: string; prisutno: number }[];
    };
    expect(kadrovska.attendanceNow).toHaveBeenCalledWith("u@servoteh.com");
    // Ne piše svoj upit nad v_attendance_now (plan §2.4).
    expect($queryRaw).not.toHaveBeenCalled();
    expect(out).toMatchObject({
      prisutno: 2,
      pauza: 1,
      odsutno: 1,
      ukupno_sa_prolazom_24h: 4,
    });
    expect(out.po_odeljenju).toHaveLength(3);
    expect(out.po_odeljenju).toContainEqual({
      odeljenje: "Proizvodnja",
      prisutno: 2,
      pauza: 0,
      odsutno: 0,
    });
    // Zaposleni bez odeljenja ne ispada iz brojanja — ide u „—".
    expect(out.po_odeljenju.map((o) => o.odeljenje)).toContain("—");
  });

  it("prazna kapija: sve nule, bez pada", async () => {
    const { ctx } = makeCtx([], []);
    const out = await tool("prisustvo_danas").execute({}, ctx);
    expect(out).toMatchObject({
      prisutno: 0,
      pauza: 0,
      odsutno: 0,
      ukupno_sa_prolazom_24h: 0,
      po_odeljenju: [],
    });
  });
});
