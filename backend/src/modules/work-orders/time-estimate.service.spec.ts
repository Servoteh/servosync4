import {
  estimateByWorkCenter,
  estimateForDrawing,
  estimateForWorkOrder,
  MALO_N,
  type RawSqlClient,
} from "./time-estimate.service";
import { CORE_TOOLS } from "../ai-chat/tools/core-tools";
import { PERMISSIONS } from "../../common/authz/permissions";

/**
 * TALAS AI-5 — procena vremena. Mokujemo `$queryRaw` (redom vraća pripremljene
 * rezultate, pamti SQL) i proveravamo: (1) SIMETRIČNU agregaciju (plan i stvarno
 * se oba prvo zbir-uju po NALOGU+RM, pa raspon po RM — review nalaz 19 iz AI-1),
 * (2) filter šuma (< 1 min + is_process_finished) nad `tech_processes` (NE
 * `work_time_entries`, koji je na produ prazan), (3) mali n označen, (4) prazan
 * rezultat, (5) permisiju alata.
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

describe("estimateByWorkCenter", () => {
  const q = (n: number) => [
    { radno_mesto: "3.18", n, p25: 0.367, p50: 1.019, p75: 2.499, h_min: 0, h_max: 410 },
  ];
  const meta = [{ naziv: "CNC Glodanje (HAAS)", prijava_ukupno: 1200, prijava_izbaceno: 560 }];

  it("happy path: h/kom kvantili + naziv + transparentnost šuma", async () => {
    const { prisma, sql } = makeClient([q(551), meta]);
    const out = (await estimateByWorkCenter(prisma, "3.18")) as {
      jedinica: string;
      n: number;
      p50: number;
      malo_podataka: boolean;
      prijava_izbaceno: number;
      naziv_radnog_mesta: string;
    };
    expect(out.jedinica).toBe("h/kom");
    expect(out.n).toBe(551);
    expect(out.p50).toBe(1.019);
    expect(out.malo_podataka).toBe(false);
    expect(out.prijava_izbaceno).toBe(560);
    expect(out.naziv_radnog_mesta).toBe("CNC Glodanje (HAAS)");
    // Stvarni izvor je tech_processes; simetrična agregacija po nalogu+RM; filter šuma.
    expect(sql[0]).toContain("tech_processes");
    expect(sql[0]).not.toContain("work_time_entries");
    expect(sql[0]).toContain("stvarno_po_nalogu");
    expect(sql[0]).toContain("percentile_cont");
    expect(sql[0]).toContain("interval '1 minute'");
    expect(sql[0]).toContain("is_process_finished");
    // h/kom = stvarni sati / količina naloga.
    expect(sql[0]).toContain("piece_count");
  });

  it("mali n se označava kao nepouzdan (malo_podataka)", async () => {
    const { prisma } = makeClient([q(MALO_N - 1), meta]);
    const out = (await estimateByWorkCenter(prisma, "3.18")) as {
      malo_podataka: boolean;
      napomena: string;
    };
    expect(out.malo_podataka).toBe(true);
    expect(out.napomena).toContain("MALI");
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
  it("simetrična agregacija (plan i stvarno po nalogu+RM) nad tech_processes", async () => {
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
      prijava_izbaceno: number;
      po_radnom_mestu: unknown[];
      napomena: string;
    };
    expect(out.crtez).toBe("S000AP0000");
    expect(out.broj_naloga).toBe(31);
    expect(out.prijava_izbaceno).toBe(30);
    expect(out.po_radnom_mestu).toHaveLength(1);
    expect(out.napomena).toContain("SATIMA");
    const agg = sql[2];
    // Obe strane se prvo agregiraju po nalogu+RM (nikakav avg direktno nad rutingom).
    expect(agg).toContain("plan_po_nalogu");
    expect(agg).toContain("stvarno_po_nalogu");
    expect(agg).not.toMatch(/avg\(\s*COALESCE\(woo\.setup_time/);
    // Stvarni izvor + filter šuma.
    expect(agg).toContain("tech_processes");
    expect(agg).toContain("interval '1 minute'");
    expect(agg).toContain("is_process_finished");
    // Egzaktno poklapanje crteža ide preko lower() (idx_work_orders_drawing_number_lower).
    expect(agg).toContain("lower(");
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
  it("po operaciji spaja plan + procenu RM (h/kom) + istoriju crteža", async () => {
    const { prisma } = makeClient([
      [{ id: 1294, ident: "2249/2", varijanta: 0, crtez: "S000AP0000", kolicina: 1, naziv_dela: "Ploča" }],
      [
        { rb: 10, radno_mesto: "3.18", naziv_radnog_mesta: "CNC Glodanje (HAAS)", opis: "glodanje", plan_h: 1.5 },
        { rb: 20, radno_mesto: "8.3", naziv_radnog_mesta: "Završna Kontrola", opis: "kontrola", plan_h: 0 },
      ],
      [
        { radno_mesto: "3.18", n: 551, p25: 0.37, p50: 1.02, p75: 2.5, h_min: 0, h_max: 410 },
        { radno_mesto: "8.3", n: 804, p25: 0.005, p50: 0.016, p75: 0.027, h_min: 0, h_max: 8212 },
      ],
      // estimateForDrawing pod-upiti:
      [], // poIdentu
      [{ ident: "2249/2" }], // nalozi
      [{ radno_mesto: "3.18", naziv_radnog_mesta: "CNC Glodanje (HAAS)", naloga_sa_prijavom: 13, stvarno_h_p50: 1.34, stvarno_h_min: 0.51, stvarno_h_max: 7.19 }],
      [{ broj_naloga: 31, prijava_ukupno: 80, prijava_izbaceno: 30 }],
    ]);
    const out = (await estimateForWorkOrder(prisma, 1294)) as {
      nalog: { ident: string };
      crtez_istorija: { broj_naloga: number; drugi_nalozi: number };
      operacije: {
        rb: number;
        rm_procena: { n: number; p50: number; malo_podataka: boolean } | null;
        crtez_procena: { n_naloga: number; stvarno_h_p50: number } | null;
        plan_h: number | null;
      }[];
    };
    expect(out.nalog.ident).toBe("2249/2");
    expect(out.crtez_istorija).toEqual({ broj_naloga: 31, drugi_nalozi: 30 });
    expect(out.operacije).toHaveLength(2);
    const op10 = out.operacije[0];
    expect(op10.plan_h).toBe(1.5);
    expect(op10.rm_procena).toMatchObject({ n: 551, p50: 1.02, malo_podataka: false });
    expect(op10.crtez_procena).toMatchObject({ n_naloga: 13, stvarno_h_p50: 1.34 });
    // 8.3 ima istoriju RM ali NEMA istoriju baš ovog crteža → crtez_procena null.
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

  it("crtež ima prioritet nad radnim mestom; prazno → greška bez upita", async () => {
    const { prisma, $queryRaw } = makeClient([[], []]);
    const ctx = { deps: { prisma } } as never;
    const prazno = await tool!.execute({}, ctx);
    expect(prazno).toMatchObject({ greska: "prazan_upit" });
    expect($queryRaw).not.toHaveBeenCalled();
  });
});
