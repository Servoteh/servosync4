import {
  jeUuid,
  klasifikujPredmet,
  legacyPredmetIds,
  predmetIdIzUuid,
  predmetIzlaz,
  predmetUuid,
  predmetUuidIzracunaj,
  saPredmetom,
} from "./sastanci-predmet";
import { SastanciPredmetService } from "./sastanci-predmet.service";
import type { PrismaService } from "../../prisma/prisma.service";

/**
 * Blokada 5 — prevod predmeta uuid <-> Int.
 *
 * 🔴 ZAŠTO POSTOJI: uuid je u 3.0 postao `Int`. Ako prevod promaši, predmet se
 * TIHO gubi (akcija/sastanak bez RN-a) — kvar koji se vidi tek kad neko otvori
 * listu i primeti da je kolona prazna.
 */

/**
 * KONTROLNI SKUP — pročitan sa ŽIVE sy15 06.08.2026:
 *   SELECT id, bigtehn_item_id FROM public.projects WHERE bigtehn_item_id IS NOT NULL
 * Sve 22 vrednosti; prve dve su IZUZECI (uuid nije izveden).
 */
const ZIVI_PAROVI: [number, string][] = [
  [9068, "bc09f06f-81f8-4601-a4c9-5bfba27423b4"], // 🔴 izuzetak (šifra 7701)
  [9470, "a60c610f-9ac1-4fe0-b9c4-fda481e04c58"], // 🔴 izuzetak (šifra 9000)
  [9426, "a4f633c3-208e-551e-85f5-330234920edf"],
  [9427, "83704bb7-ae7d-557d-84bf-35b474b8e66b"],
  [9466, "efc31977-a8f0-5258-86ae-068a802c77c9"],
  [9480, "cabbd4fd-c896-5e30-8033-9d21f6bbd524"],
  [9509, "fb16f17b-94f9-56e7-8ec6-aa03030cc490"],
  [9510, "3cd25601-3568-50c3-8a49-bb9d275681c9"],
  [9833, "d9b658ff-1fa0-5b0f-8356-e3d3c48bf90a"],
  [10255, "44770260-d706-53a4-847a-77a4ae057e37"],
  [10301, "4174460e-e66f-572f-8557-41a69f2e6846"],
  [10302, "30be6dfb-8032-5439-85c0-dd5d9e274c7c"],
  [10303, "4284d2c9-b7c9-5050-811d-fb8e84702b47"],
  [10304, "fbb6bac2-7d1b-52c6-85ba-2f2fd498d1a8"],
  [10305, "9ce5830d-72e0-519d-86bd-5befc557040c"],
  [10306, "dc190c0a-a1aa-58f6-8360-ef60fbba17a7"],
  [10348, "e3b1e87f-026e-5056-83bb-171b67436f25"],
  [10349, "de6e7d4d-c208-5d8f-819b-4e3f9a3c5d7d"],
  [10350, "fb371d21-e998-54d4-8734-1a5819714198"],
  [10353, "ee3661b4-9301-55fd-837b-68c3bfb0a13c"],
  [10354, "41f898c4-0be4-59e7-824f-61c1b0bda22e"],
  [10355, "392c2082-cc68-50b6-85ee-5647811803e2"],
];

const IZUZECI = ZIVI_PAROVI.slice(0, 2);
const IZVEDENI = ZIVI_PAROVI.slice(2);

describe("predmetUuidIzracunaj — paritet sy15 pb_predmet_project_uuid()", () => {
  it("daje ISTI uuid kao PostgreSQL za svih 20 izvedenih živih predmeta", () => {
    for (const [id, uuid] of IZVEDENI) {
      expect(predmetUuidIzracunaj(id)).toBe(uuid);
    }
  });

  it("🔴 preskače znakove 16 i 20 (mesto za verziju 5 i varijantu 8)", () => {
    const u = predmetUuidIzracunaj(9426);
    // Bez preskakanja bi ovo bili drugi znakovi — provera brani doslovnost prepisa.
    expect(u[14 + 1]).toBeDefined();
    expect(u.split("-")[2][0]).toBe("5");
    expect(u.split("-")[3][0]).toBe("8");
  });

  it("izlaz je uvek ispravan uuid oblik", () => {
    for (const id of [1, 42, 9426, 999999]) {
      expect(jeUuid(predmetUuidIzracunaj(id))).toBe(true);
    }
  });
});

describe("🔴 izmereni izuzeci — račun ih NE pogađa", () => {
  it("dva živa predmeta imaju uuid koji formula ne daje", () => {
    for (const [id, uuid] of IZUZECI) {
      expect(predmetUuidIzracunaj(id)).not.toBe(uuid);
      // …a `predmetUuid` mora vratiti ZATEČENI, ne izračunati.
      expect(predmetUuid(id)).toBe(uuid);
    }
  });

  it("oba izuzetka su u skupu kandidata i bez baze", () => {
    expect(legacyPredmetIds().sort()).toEqual([9068, 9470]);
  });

  it("obrnut prevod radi za izuzetke i bez ijednog kandidata", () => {
    for (const [id, uuid] of IZUZECI) {
      expect(predmetIdIzUuid(uuid, [])).toBe(id);
    }
  });
});

describe("predmetIdIzUuid — obrnut prevod nad skupom kandidata", () => {
  const kandidati = ZIVI_PAROVI.map(([id]) => id);

  it("razrešava svih 22 živa predmeta", () => {
    for (const [id, uuid] of ZIVI_PAROVI) {
      expect(predmetIdIzUuid(uuid, kandidati)).toBe(id);
    }
  });

  it("neosetljiv na veličinu slova i razmake", () => {
    const [id, uuid] = IZVEDENI[0];
    expect(predmetIdIzUuid(`  ${uuid.toUpperCase()}  `, kandidati)).toBe(id);
  });

  it("nepoznat uuid → null (pozivalac pretvara u 422, NIKAD u tiho null polje)", () => {
    expect(
      predmetIdIzUuid("00000000-0000-5000-8000-000000000000", kandidati),
    ).toBeNull();
  });
});

describe("klasifikujPredmet — oblik ulaza", () => {
  it("undefined = polje nije poslato; null/'' = obriši vezu", () => {
    expect(klasifikujPredmet(undefined)).toEqual({ vrsta: "nedirano" });
    expect(klasifikujPredmet(null)).toEqual({ vrsta: "obrisi" });
    expect(klasifikujPredmet("")).toEqual({ vrsta: "obrisi" });
  });

  it("broj i numerički string idu direktno kao Int (bez upita)", () => {
    expect(klasifikujPredmet(9426)).toEqual({ vrsta: "id", id: 9426 });
    expect(klasifikujPredmet("9426")).toEqual({ vrsta: "id", id: 9426 });
  });

  it("uuid se prepoznaje i spušta na mala slova", () => {
    expect(klasifikujPredmet(IZVEDENI[0][1].toUpperCase())).toEqual({
      vrsta: "uuid",
      uuid: IZVEDENI[0][1],
    });
  });

  it("smeće i nepozitivan broj su greška, ne tiho null", () => {
    expect(() => klasifikujPredmet("abc")).toThrow();
    expect(() => klasifikujPredmet(0)).toThrow();
    expect(() => klasifikujPredmet(-5)).toThrow();
    expect(() => klasifikujPredmet(1.5)).toThrow();
  });
});

describe("predmetIzlaz / saPredmetom — ugovor odgovora", () => {
  it("🔴 red iz 3.0 zadržava ime `projekatId` (ne `projectId`) i dobija uuid", () => {
    // Bez ovoga bi sam prelazak na 3.0 preimenovao polje i FE bi svuda video
    // „bez predmeta" — kvar bez ijedne greške u logu.
    const out = saPredmetom({ id: "a", naslov: "X", projectId: 9426 });
    expect(out).toEqual({
      id: "a",
      naslov: "X",
      projekatId: 9426,
      projekatUuid: IZVEDENI[0][1],
    });
    expect("projectId" in out).toBe(false);
  });

  it("izuzetak vraća ZATEČENI uuid, da stari klijent i dalje poklopi predmet", () => {
    expect(predmetIzlaz(9068)).toEqual({
      projekatId: 9068,
      projekatUuid: IZUZECI[0][1],
    });
  });

  it("bez predmeta → oba polja null", () => {
    expect(predmetIzlaz(null)).toEqual({ projekatId: null, projekatUuid: null });
    expect(saPredmetom({ id: "a", projectId: null })).toEqual({
      id: "a",
      projekatId: null,
      projekatUuid: null,
    });
  });
});

describe("SastanciPredmetService — keš i bezbedan smer", () => {
  const prismaStub = (ids: number[]) => {
    const findMany = jest.fn().mockResolvedValue(ids.map((id) => ({ id })));
    return {
      prisma: { project: { findMany } } as unknown as PrismaService,
      findMany,
    };
  };

  it("Int put ne dira bazu uopšte", async () => {
    const { prisma, findMany } = prismaStub([]);
    const s = new SastanciPredmetService(prisma);
    expect(await s.razresi(9426)).toBe(9426);
    expect(await s.razresi("9426")).toBe(9426);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("uuid put razrešava kroz kandidate i kešira (jedan upit za dva prevoda)", async () => {
    const { prisma, findMany } = prismaStub(ZIVI_PAROVI.map(([id]) => id));
    const s = new SastanciPredmetService(prisma);
    expect(await s.razresi(IZVEDENI[0][1])).toBe(IZVEDENI[0][0]);
    expect(await s.razresi(IZVEDENI[1][1])).toBe(IZVEDENI[1][0]);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("promašaj osvežava keš JEDNOM pa tek onda odustaje", async () => {
    const findMany = jest
      .fn()
      .mockResolvedValueOnce([]) // prvo punjenje — predmeta još nema
      .mockResolvedValue([{ id: 9426 }]); // posle osvežavanja — pojavio se
    const s = new SastanciPredmetService({
      project: { findMany },
    } as unknown as PrismaService);
    expect(await s.razresi(IZVEDENI[0][1])).toBe(9426);
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it("🔴 nerazrešiv uuid je 422, NIKAD tiho null (predmet se ne sme izgubiti)", async () => {
    const { prisma } = prismaStub([1, 2, 3]);
    const s = new SastanciPredmetService(prisma);
    await expect(
      s.razresi("00000000-0000-5000-8000-000000000000"),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("null briše vezu, undefined ne dira polje", async () => {
    const { prisma } = prismaStub([]);
    const s = new SastanciPredmetService(prisma);
    expect(await s.razresi(null)).toBeNull();
    expect(await s.razresi(undefined)).toBeUndefined();
  });

  it("razresiFilter: prazno = bez filtera, a ne „predmet je NULL“", async () => {
    const { prisma } = prismaStub([]);
    const s = new SastanciPredmetService(prisma);
    expect(await s.razresiFilter(undefined)).toBeUndefined();
    expect(await s.razresiFilter(null)).toBeUndefined();
    expect(await s.razresiFilter("")).toBeUndefined();
    expect(await s.razresiFilter(9426)).toBe(9426);
  });
});
