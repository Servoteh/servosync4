import {
  estimateByWorkCenter,
  estimateForDrawing,
  estimateForWorkOrder,
  isGenericDrawing,
  MALO_N,
  type RawSqlClient,
} from "./time-estimate.service";
import { CORE_TOOLS } from "../ai-chat/tools/core-tools";
import { PERMISSIONS } from "../../common/authz/permissions";

/**
 * TALAS AI-5 (+ review ispravke) — procena vremena. Mokujemo `$queryRaw` (redom
 * vraća pripremljene rezultate, pamti SQL) i proveravamo: SIMETRIČNU agregaciju
 * (plan i stvarno po NALOGU+RM), filter šuma (< 1 min, > 720 h, zero-piece,
 * is_process_finished) nad `tech_processes`, izostanak `max` u payload-u, mali n,
 * generički crtež, prazan rezultat, permisiju alata.
 */

function makeClient(results: unknown[][]) {
  const sql: string[] = [];
  let i = 0;
  const $queryRaw = jest.fn((q: { sql?: string; strings?: string[] }) => {
    sql.push(q?.sql ?? (q?.strings ?? []).join("?"));
    return Promise.resolve(results[i++] ?? []);
  });
  const prisma = { $queryRaw } as unknown as RawSqlClient;
  return { prisma, sql, $queryRaw };
}

describe("isGenericDrawing", () => {
  it("string sa < 3 alfanumerička znaka je generički (opšti nalog)", () => {
    expect(isGenericDrawing("..")).toBe(true);
    expect(isGenericDrawing(".")).toBe(true);
    expect(isGenericDrawing("…")).toBe(true);
    expect(isGenericDrawing("A1")).toBe(true);
    expect(isGenericDrawing("S000AP0000")).toBe(false);
    expect(isGenericDrawing("9400-12")).toBe(false);
  });
});

describe("estimateByWorkCenter", () => {
  const q = (n: number) => [
    { radno_mesto: "3.18", n, p25: 0.37, p50: 1.02, p75: 2.43, h_min: 0 },
  ];
  const meta = [{ naziv: "CNC Glodanje (HAAS)", prijava_ukupno: 1492, prijava_izbaceno: 214 }];

  it("happy path: h/kom kvantili + naziv + granularnost šuma; BEZ max", async () => {
    const { prisma, sql } = makeClient([q(468), meta]);
    const out = (await estimateByWorkCenter(prisma, "3.18")) as Record<string, unknown>;
    expect(out.jedinica).toBe("h/kom");
    expect(out.n).toBe(468);
    expect(out.opservacija).toBe(468);
    expect(out.p50).toBe(1.02);
    expect(out.malo_podataka).toBe(false);
    expect(out.prijava_izbaceno).toBe(214);
    expect(out.naziv_radnog_mesta).toBe("CNC Glodanje (HAAS)");
    // Max se NE vraća u payload (review [6][7]).
    expect(out).not.toHaveProperty("h_max");
    // Izvor tech_processes; simetrična agregacija; filter <1min + >720h + zero-piece.
    expect(sql[0]).toContain("tech_processes");
    expect(sql[0]).not.toContain("work_time_entries");
    expect(sql[0]).toContain("stvarno_po_nalogu");
    expect(sql[0]).toContain("percentile_cont");
    expect(sql[0]).toContain("interval '1 minute'");
    expect(sql[0]).toContain("720 hours");
    expect(sql[0]).toContain("is_process_finished");
    expect(sql[0]).toContain("prijavljeno_kom > 0");
    expect(sql[0]).toContain("piece_count");
  });

  it("napomena razdvaja n (opservacije) od prijava (redova) — review [4]", async () => {
    const { prisma } = makeClient([q(468), meta]);
    const out = (await estimateByWorkCenter(prisma, "3.18")) as { napomena: string };
    expect(out.napomena).toContain("OPSERVACIJA");
    expect(out.napomena).toContain("POJEDINAČNIH prijava");
    expect(out.napomena).toContain("amortizovanu pripremu");
  });

  it("mali n se označava kao nepouzdan (malo_podataka)", async () => {
    const { prisma } = makeClient([q(MALO_N - 1), meta]);
    const out = (await estimateByWorkCenter(prisma, "3.18")) as { malo_podataka: boolean };
    expect(out.malo_podataka).toBe(true);
  });

  it("nema opservacija: n=0, kvantili null, označen kao mali", async () => {
    const { prisma } = makeClient([[], [{ naziv: null, prijava_ukupno: 0, prijava_izbaceno: 0 }]]);
    const out = (await estimateByWorkCenter(prisma, "9.9")) as {
      n: number;
      p50: number | null;
      malo_podataka: boolean;
    };
    expect(out).toMatchObject({ n: 0, p50: null, malo_podataka: true });
  });

  it("prazan upit ne pokreće upit", async () => {
    const { prisma, $queryRaw } = makeClient([]);
    const out = await estimateByWorkCenter(prisma, "  ");
    expect(out).toMatchObject({ greska: "prazan_upit" });
    expect($queryRaw).not.toHaveBeenCalled();
  });
});

describe("estimateForDrawing", () => {
  it("simetrična agregacija nad tech_processes + zero-piece filter; BEZ max", async () => {
    const { prisma, sql } = makeClient([
      [], // poIdentu — nije ident
      [{ ident: "2249/2", varijanta: 0, kolicina: 1 }], // nalozi
      [
        {
          radno_mesto: "3.18",
          naziv_radnog_mesta: "CNC Glodanje (HAAS)",
          naloga_sa_planom: 21,
          plan_h_prosek: 1.5,
          naloga_sa_prijavom: 13,
          stvarno_h_p50: 1.34,
        },
      ],
      [{ broj_naloga: 31, prijava_ukupno: 80, prijava_izbaceno: 30 }],
    ]);
    const out = (await estimateForDrawing(prisma, "S000AP0000")) as {
      crtez: string;
      broj_naloga: number;
      po_radnom_mestu: unknown[];
      napomena: string;
    };
    expect(out.crtez).toBe("S000AP0000");
    expect(out.broj_naloga).toBe(31);
    expect(out.po_radnom_mestu).toHaveLength(1);
    expect(out.napomena).toContain("SATIMA");
    const agg = sql[2];
    expect(agg).toContain("plan_po_nalogu");
    expect(agg).toContain("stvarno_po_nalogu");
    expect(agg).not.toMatch(/avg\(\s*COALESCE\(woo\.setup_time/);
    expect(agg).toContain("tech_processes");
    expect(agg).toContain("interval '1 minute'");
    expect(agg).toContain("720 hours");
    expect(agg).toContain("is_process_finished");
    expect(agg).toContain("prijavljeno_kom > 0");
    expect(agg).not.toContain("max(h)"); // review [6][7] — bez max u payload-u
    expect(agg).toContain("lower(");
  });

  it("generički crtež (dve tačke) se NE agregira — bez ijednog upita (review [9])", async () => {
    const { prisma, $queryRaw } = makeClient([]);
    const out = (await estimateForDrawing(prisma, "..")) as {
      genericki: boolean;
      broj_naloga: number;
      po_radnom_mestu: unknown[];
    };
    expect(out.genericki).toBe(true);
    expect(out.broj_naloga).toBe(0);
    expect(out.po_radnom_mestu).toEqual([]);
    expect($queryRaw).not.toHaveBeenCalled();
  });

  it("skipIdentResolve preskače poIdentu Seq Scan (review [11])", async () => {
    const { prisma, sql } = makeClient([
      [{ ident: "2249/2" }], // nalozi (PRVI upit — nema poIdentu)
      [{ radno_mesto: "3.18", naloga_sa_prijavom: 13, stvarno_h_p50: 1.34 }],
      [{ broj_naloga: 31, prijava_ukupno: 80, prijava_izbaceno: 30 }],
    ]);
    await estimateForDrawing(prisma, "S000AP0000", { skipIdentResolve: true });
    // Prvi upit je odmah `nalozi` (SELECT ... ident_number AS ident), ne ident lookup.
    expect(sql[0]).toContain("ident_number AS ident");
    expect(sql).toHaveLength(3);
  });

  it("crtež bez naloga: 0 naloga + prazne liste", async () => {
    const { prisma } = makeClient([[], []]);
    const out = (await estimateForDrawing(prisma, "NEMA")) as {
      broj_naloga: number;
      po_radnom_mestu: unknown[];
      poslednji_nalozi: unknown[];
      predlog: string;
    };
    expect(out).toMatchObject({ broj_naloga: 0, po_radnom_mestu: [], poslednji_nalozi: [] });
    expect(out.predlog).toContain("crteža");
  });

  it("prazan upit ne pokreće upit", async () => {
    const { prisma, $queryRaw } = makeClient([]);
    const out = await estimateForDrawing(prisma, "");
    expect(out).toMatchObject({ greska: "prazan_upit" });
    expect($queryRaw).not.toHaveBeenCalled();
  });
});

describe("estimateForWorkOrder", () => {
  it("po operaciji spaja plan + procenu RM (h/kom) + istoriju crteža + dokaze", async () => {
    const { prisma } = makeClient([
      [{ id: 1294, ident: "2249/2", varijanta: 0, crtez: "S000AP0000", kolicina: 1, naziv_dela: "Ploča" }],
      [
        { rb: 10, radno_mesto: "3.18", naziv_radnog_mesta: "CNC Glodanje (HAAS)", opis: "glodanje", plan_h: 1.5 },
        { rb: 20, radno_mesto: "8.3", naziv_radnog_mesta: "Završna Kontrola", opis: "kontrola", plan_h: 0 },
      ],
      [
        { radno_mesto: "3.18", n: 468, p25: 0.37, p50: 1.02, p75: 2.43, h_min: 0 },
        { radno_mesto: "8.3", n: 739, p25: 0.005, p50: 0.014, p75: 0.025, h_min: 0 },
      ],
      // estimateForDrawing(skipIdentResolve:true) → nalozi, poRadnomMestu, zbir (BEZ poIdentu):
      [{ ident: "2249/2", varijanta: 0, kolicina: 1, otvoren: "01.01.2024", predmet: "2249" }],
      [{ radno_mesto: "3.18", naziv_radnog_mesta: "CNC Glodanje (HAAS)", naloga_sa_prijavom: 13, stvarno_h_p50: 1.34, stvarno_h_min: 0.51 }],
      [{ broj_naloga: 31, prijava_ukupno: 80, prijava_izbaceno: 30 }],
    ]);
    const out = (await estimateForWorkOrder(prisma, 1294)) as {
      nalog: { ident: string };
      crtez_istorija: { broj_naloga: number; drugi_nalozi: number; genericki: boolean };
      crtez_nalozi: unknown[];
      operacije: {
        rb: number;
        rm_procena: { n: number; p50: number; malo_podataka: boolean } | null;
        crtez_procena: { n_naloga: number; stvarno_h_p50: number } | null;
        plan_h: number | null;
      }[];
    };
    expect(out.nalog.ident).toBe("2249/2");
    expect(out.crtez_istorija).toEqual({ broj_naloga: 31, drugi_nalozi: 30, genericki: false });
    expect(out.crtez_nalozi).toHaveLength(1); // dokazi (review [13])
    expect(out.operacije).toHaveLength(2);
    const op10 = out.operacije[0];
    expect(op10.plan_h).toBe(1.5);
    expect(op10.rm_procena).toMatchObject({ n: 468, p50: 1.02, malo_podataka: false });
    expect(op10.crtez_procena).toMatchObject({ n_naloga: 13, stvarno_h_p50: 1.34 });
    // crtez_procena više ne nosi max (review [6][7]).
    expect(op10.crtez_procena).not.toHaveProperty("stvarno_h_max");
    // 8.3 ima RM istoriju ali NEMA istoriju baš ovog crteža → crtez_procena null.
    expect(out.operacije[1].crtez_procena).toBeNull();
  });

  it("nepostojeći nalog → greška, bez daljih upita", async () => {
    const { prisma, $queryRaw } = makeClient([[]]);
    const out = await estimateForWorkOrder(prisma, 999999);
    expect(out).toMatchObject({ greska: "nema_naloga" });
    expect($queryRaw).toHaveBeenCalledTimes(1);
  });
});

describe("procena_vremena (alat asistenta)", () => {
  const tool = CORE_TOOLS.find((t) => t.name === "procena_vremena");

  it("postoji, read-only, iza tehnologija.read", () => {
    expect(tool).toBeDefined();
    expect(tool?.kind).toBe("read");
    expect(tool?.requiredPermission).toBe(PERMISSIONS.TEHNOLOGIJA_READ);
  });

  it("prazno → greška bez upita", async () => {
    const { prisma, $queryRaw } = makeClient([]);
    const ctx = { deps: { prisma } } as never;
    const prazno = await tool!.execute({}, ctx);
    expect(prazno).toMatchObject({ greska: "prazan_upit" });
    expect($queryRaw).not.toHaveBeenCalled();
  });
});
