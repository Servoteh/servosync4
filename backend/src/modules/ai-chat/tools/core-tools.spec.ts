import { CORE_TOOLS } from "./core-tools";
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
function makeCtx(results: unknown[][], attendance: unknown[] = []) {
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
    expect(sql[0]).toContain("LIMIT 15");
  });

  it("prazan rezultat: nadjeno = 0, bez izmišljanja", async () => {
    const { ctx } = makeCtx([[]]);
    const out = (await tool("nadji_radni_nalog").execute(
      { upit: "nepostojeci" },
      ctx,
    )) as { nadjeno: number; nalozi: unknown[] };
    expect(out).toMatchObject({ nadjeno: 0, nalozi: [] });
  });

  it("prazan upit ne povlači celu tabelu", async () => {
    const { ctx, $queryRaw } = makeCtx([[]]);
    const out = await tool("nadji_radni_nalog").execute({ upit: "  " }, ctx);
    expect(out).toMatchObject({ greska: "prazan_upit" });
    expect($queryRaw).not.toHaveBeenCalled();
  });
});

describe("istorija_crteza", () => {
  it("po identu RN-a razreši crtež, pa vrati agregat po radnom mestu", async () => {
    const { ctx, sql } = makeCtx([
      [{ crtez: "CRT-100" }], // razrešenje identa → crtež
      [{ ident: "9400-12", varijanta: 0, kolicina: 4 }], // poslednji nalozi
      [
        {
          radno_mesto: "G1",
          naziv_radnog_mesta: "Glodalica",
          plan_h_prosek: 2.5,
          stvarno_h_min: 2.1,
          stvarno_h_max: 3.4,
          naloga_sa_prijavom: 12,
        },
      ],
      [{ broj: 7 }],
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
    // Plan (Tpz + Tk × kom) i stvarno (prijave rada) u istom upitu.
    expect(sql[2]).toContain("setup_time");
    expect(sql[2]).toContain("work_time_entries");
  });

  it("crtež bez ijednog naloga: 0 naloga, prazne liste", async () => {
    const { ctx } = makeCtx([[], []]);
    const out = (await tool("istorija_crteza").execute(
      { crtez: "NEMA" },
      ctx,
    )) as { broj_naloga: number; po_radnom_mestu: unknown[] };
    expect(out).toMatchObject({ broj_naloga: 0, po_radnom_mestu: [] });
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

  it("nepoznat predmet: ne traži naloge uopšte", async () => {
    const { ctx, $queryRaw } = makeCtx([[]]);
    const out = (await tool("stanje_predmeta").execute(
      { broj_predmeta: "0000/0" },
      ctx,
    )) as { nadjeno: number };
    expect(out).toMatchObject({ nadjeno: 0, predmeti: [] });
    expect($queryRaw).toHaveBeenCalledTimes(1);
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
  });

  it("nepostojeći ident → nadjeno 0, bez drugog upita", async () => {
    const { ctx, $queryRaw } = makeCtx([[]]);
    const out = (await tool("tehnoloski_postupak_naloga").execute(
      { ident: "NEMA" },
      ctx,
    )) as { nadjeno: number };
    expect(out).toMatchObject({ nadjeno: 0, operacije: [] });
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
