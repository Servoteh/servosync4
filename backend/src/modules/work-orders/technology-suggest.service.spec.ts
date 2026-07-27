import {
  suggestForDrawing,
  type TechnologySuggestion,
  type NemaTehnologije,
} from "./technology-suggest.service";
import type { RawSqlClient } from "./time-estimate.service";
import { CORE_TOOLS } from "../ai-chat/tools/core-tools";
import { PERMISSIONS } from "../../common/authz/permissions";

/**
 * TALAS AI-6 — predlog tehnologije iz istorije crteža. Mokujemo `$queryRaw`
 * (redom vraća pripremljene rezultate, pamti SQL). Proveravamo: reprezentativan
 * ruting iz prošlih naloga, PRIJAVU nekonzistentnih rutinga (najčešći predložen),
 * prednost proizvedenom nalogu, REUSE AI-5 filtera/izraza (tech_processes,
 * TP_VALIDNA, drawingMatch), jasnu poruku za nov/generički crtež, i permisiju.
 *
 * Redosled upita kad je ulaz broj crteža (ne ident): estimateForDrawing pravi
 * [poIdentu, nalozi, poRadnomMestu, zbir], pa AI-6 dodaje [kandidati, operacije,
 * wcQuantiles].
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

// Rezultati estimateForDrawing (AI-5) za crtež sa istorijom — 4 upita.
const DRAW_OK = (brojNaloga: number) => [
  [], // poIdentu — ulaz nije ident
  [{ ident: "8035/52", varijanta: 0, kolicina: 2, naziv_dela: "Deo", otvoren: "12.11.2024", predmet: "8035" }],
  [
    {
      radno_mesto: "3.40",
      naziv_radnog_mesta: "CNC Glodanje (MAHO 700)",
      naloga_sa_planom: 5,
      plan_h_min: 1,
      plan_h_prosek: 2,
      naloga_sa_prijavom: 5,
      stvarno_h_min: 1.2,
      stvarno_h_p50: 2.1,
    },
  ],
  [{ broj_naloga: brojNaloga, prijava_ukupno: 200, prijava_izbaceno: 30 }],
];

const OPERACIJE = [
  { rb: 5, radno_mesto: "1.10", naziv_radnog_mesta: "Sečenje", opis: "seci", plan_tpz: 0, plan_tk: 0.1 },
  { rb: 20, radno_mesto: "3.40", naziv_radnog_mesta: "CNC Glodanje (MAHO 700)", opis: "glodaj", plan_tpz: 0.5, plan_tk: 0.5 },
  { rb: 85, radno_mesto: "8.3", naziv_radnog_mesta: "Završna Kontrola", opis: "kontrola", plan_tpz: 0, plan_tk: 0 },
];

const WCQ = [
  { radno_mesto: "1.10", n: 40, p25: 0.004, p50: 0.015, p75: 0.041, h_min: 0 },
  { radno_mesto: "3.40", n: 1703, p25: 0.42, p50: 1.05, p75: 2.14, h_min: 0 },
  // 8.3 nema kvantile (kontrola se ne štancuje) → rm_procena null.
];

describe("suggestForDrawing — happy path (konzistentan ruting)", () => {
  const kandidati = [
    { id: 34115, ident: "8035/52", varijanta: 0, kolicina: 2, otvoren: "12.11.2024", operacija: 3, potpis: "1.10>3.40>8.3", proizveden: true },
    { id: 34123, ident: "8034/80", varijanta: 0, kolicina: 2, otvoren: "12.11.2024", operacija: 3, potpis: "1.10>3.40>8.3", proizveden: true },
  ];

  it("vraća reprezentativan ruting + plan + stvarnu procenu po RM sa n", async () => {
    const { prisma } = makeClient([...DRAW_OK(6), kandidati, OPERACIJE, WCQ]);
    const out = (await suggestForDrawing(prisma, "1052059")) as TechnologySuggestion;

    expect(out.ima_istoriju).toBe(true);
    expect(out.crtez).toBe("1052059");
    expect(out.osnov_naloga).toBe(2);
    expect(out.ukupno_naloga).toBe(6);
    expect(out.konzistentno).toBe(true);
    expect(out.broj_varijanti).toBe(1);
    expect(out.reprezentativan_nalog.ident).toBe("8035/52");
    expect(out.reprezentativan_nalog.proizveden).toBe(true);
    expect(out.operacije).toHaveLength(3);

    const op0 = out.operacije[0]; // 1.10 Sečenje
    expect(op0.rb).toBe(5);
    expect(op0.plan_tk).toBe(0.1);
    expect(op0.rm_procena).toMatchObject({ n: 40, p50: 0.015, malo_podataka: false });

    const op1 = out.operacije[1]; // 3.40 — ima i procenu RM i istoriju baš ovog crteža
    expect(op1.rm_procena).toMatchObject({ n: 1703, p50: 1.05 });
    expect(op1.crtez_procena).toMatchObject({ n_naloga: 5, stvarno_h_p50: 2.1 });

    const op2 = out.operacije[2]; // 8.3 — nema validnih prijava
    expect(op2.rm_procena).toBeNull();
    expect(op2.crtez_procena).toBeNull();
  });

  it("REUSE AI-5: kandidati koriste string_agg potpis, tech_processes + TP_VALIDNA i lower() match", async () => {
    const { prisma, sql } = makeClient([...DRAW_OK(6), kandidati, OPERACIJE, WCQ]);
    await suggestForDrawing(prisma, "1052059");
    const kand = sql[4]; // 5. upit = kandidati
    expect(kand).toContain("string_agg");
    expect(kand).toContain("work_order_operations");
    expect(kand).toContain("tech_processes");
    expect(kand).toContain("interval '1 minute'");
    expect(kand).toContain("720 hours");
    expect(kand).toContain("is_process_finished");
    expect(kand).toContain("lower("); // drawingMatch — isti indeksirani izraz kao AI-5
    // wcQuantiles (7. upit) je isti AI-5 izvor.
    expect(sql[6]).toContain("percentile_cont");
    expect(sql[6]).toContain("prijavljeno_kom > 0");
  });
});

describe("suggestForDrawing — nekonzistentni rutinzi", () => {
  it("prijavljuje varijante i predlaže NAJČEŠĆI (uz najskoriji kao tie-break)", async () => {
    const kandidati = [
      { id: 1, ident: "A", varijanta: 0, kolicina: 2, otvoren: "12.11.2024", operacija: 3, potpis: "1.10>3.40>8.3", proizveden: true },
      { id: 2, ident: "B", varijanta: 0, kolicina: 2, otvoren: "01.10.2024", operacija: 3, potpis: "1.10>3.40>8.3", proizveden: true },
      { id: 3, ident: "C", varijanta: 0, kolicina: 2, otvoren: "01.01.2023", operacija: 2, potpis: "1.10>3.40", proizveden: true },
    ];
    const { prisma } = makeClient([...DRAW_OK(3), kandidati, OPERACIJE, WCQ]);
    const out = (await suggestForDrawing(prisma, "1052059")) as TechnologySuggestion;

    expect(out.konzistentno).toBe(false);
    expect(out.broj_varijanti).toBe(2);
    expect(out.osnov_naloga).toBe(3);
    expect(out.reprezentativan_nalog.ident).toBe("A"); // najčešća varijanta, najskoriji
    // Varijante sortirane po broju naloga; izabrana je najčešća.
    expect(out.varijante[0]).toMatchObject({ broj_naloga: 2, izabran: true });
    expect(out.varijante[1]).toMatchObject({ broj_naloga: 1, izabran: false });
    expect(out.napomena).toContain("razlikuju");
    expect(out.napomena).toContain("2 različit");
  });

  it("bira NAJSKORIJI PROIZVEDEN nalog varijante (preskače najskoriji neproizveden)", async () => {
    const kandidati = [
      { id: 10, ident: "NOV", varijanta: 0, kolicina: 2, otvoren: "20.07.2026", operacija: 3, potpis: "1.10>3.40>8.3", proizveden: false },
      { id: 11, ident: "STAR", varijanta: 0, kolicina: 2, otvoren: "01.01.2024", operacija: 3, potpis: "1.10>3.40>8.3", proizveden: true },
    ];
    const { prisma } = makeClient([...DRAW_OK(2), kandidati, OPERACIJE, WCQ]);
    const out = (await suggestForDrawing(prisma, "1052059")) as TechnologySuggestion;
    expect(out.reprezentativan_nalog.ident).toBe("STAR");
    expect(out.reprezentativan_nalog.proizveden).toBe(true);
  });
});

describe("suggestForDrawing — nema istorije", () => {
  it("nov crtež (nijedan nalog) → ima_istoriju:false, jasna poruka „prvi put“", async () => {
    // estimateForDrawing: poIdentu[], nalozi[] → vrati broj_naloga 0 (2 upita); pa kandidati[].
    const { prisma } = makeClient([[], [], []]);
    const out = (await suggestForDrawing(prisma, "NEMANEMA")) as NemaTehnologije;
    expect(out.ima_istoriju).toBe(false);
    expect(out.genericki).toBe(false);
    expect(out.poruka).toContain("prvi put");
  });

  it("nalozi postoje ali bez rutinga → poruka „nema unet tehnološki postupak“", async () => {
    const { prisma } = makeClient([...DRAW_OK(4), []]); // kandidati prazni
    const out = (await suggestForDrawing(prisma, "1052059")) as NemaTehnologije;
    expect(out.ima_istoriju).toBe(false);
    expect(out.poruka).toContain("tehnološki postupak");
  });

  it("generički/„opšti“ crtež se NE agregira — bez ijednog upita", async () => {
    const { prisma, $queryRaw } = makeClient([]);
    const out = (await suggestForDrawing(prisma, "..")) as NemaTehnologije;
    expect(out.ima_istoriju).toBe(false);
    expect(out.genericki).toBe(true);
    expect($queryRaw).not.toHaveBeenCalled();
  });

  it("prazan upit → greška, bez upita", async () => {
    const { prisma, $queryRaw } = makeClient([]);
    const out = await suggestForDrawing(prisma, "   ");
    expect(out).toMatchObject({ greska: "prazan_upit" });
    expect($queryRaw).not.toHaveBeenCalled();
  });
});

describe("predlozi_tehnologiju (alat asistenta)", () => {
  const tool = CORE_TOOLS.find((t) => t.name === "predlozi_tehnologiju");

  it("postoji, read-only, iza tehnologija.read", () => {
    expect(tool).toBeDefined();
    expect(tool?.kind).toBe("read");
    expect(tool?.requiredPermission).toBe(PERMISSIONS.TEHNOLOGIJA_READ);
  });

  it("prekratak pojam → greška bez upita", async () => {
    const { prisma, $queryRaw } = makeClient([]);
    const ctx = { deps: { prisma } } as never;
    const out = await tool!.execute({ crtez: "ab" }, ctx);
    expect(out).toMatchObject({ greska: "prekratak_upit" });
    expect($queryRaw).not.toHaveBeenCalled();
  });

  it("kompaktuje operacije (median h/kom + n), zadržava konzistenciju", async () => {
    const kandidati = [
      { id: 1, ident: "A", varijanta: 0, kolicina: 2, otvoren: "12.11.2024", operacija: 3, potpis: "1.10>3.40>8.3", proizveden: true },
    ];
    const { prisma } = makeClient([...DRAW_OK(2), kandidati, OPERACIJE, WCQ]);
    const ctx = { deps: { prisma } } as never;
    const out = (await tool!.execute({ crtez: "1052059" }, ctx)) as {
      ima_istoriju: boolean;
      operacije: { rb: number; stvarno_h_kom_med: number | null; n: number }[];
    };
    expect(out.ima_istoriju).toBe(true);
    expect(out.operacije[1]).toMatchObject({ rb: 20, stvarno_h_kom_med: 1.05, n: 1703 });
    // Kompaktan payload ne nosi pune kvantile ni dokaze.
    expect(out.operacije[0]).not.toHaveProperty("crtez_procena");
  });
});
