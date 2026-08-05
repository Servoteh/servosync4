import {
  BadRequestException,
  ConflictException,
} from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { SastanciService } from "./sastanci.service";
import { SastanciPeriodicniService } from "../scheduler/sastanci-periodicni.service";
import type { Sy15Service } from "../../common/sy15/sy15.service";
import { SastanciPbSourceService } from "../../common/sy15/sastanci-pb-source.service";
import type { AiModelPolicyService } from "../../common/ai/ai-model-policy.service";
import {
  CreateSastanakDto,
  UpdateSastanakDto,
} from "./dto/sastanci-mutation.dto";

/**
 * Periodični sastanci + kolona „Sledeći" (zahtev 024/26: tri predloga potvrđena
 * 28.07 + komentar 29.07 t.1). Bez žive baze: pinuje tip↔interval validaciju,
 * kapiju „sy15 skripta nije primenjena" (kolone van Prisma mape) i obogaćenje
 * liste terminom sledećeg sastanka serije.
 */
const CID = "3b241101-e2bb-4255-8caf-4136c566a962";
const ID = "11111111-2222-3333-4444-555555555555";

const KOLONE_DA = [{ n: 2 }];
const KOLONE_NE = [{ n: 0 }];

function makeSvc() {
  const tx = {
    sastanak: {
      create: jest.fn().mockResolvedValue({ id: ID, tip: "periodicni" }),
      count: jest.fn().mockResolvedValue(1),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue({ id: ID, tip: "projektni" }),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    sastanakUcesnik: {
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    kadrHoliday: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    $queryRaw: jest.fn().mockResolvedValue(KOLONE_DA),
    $executeRaw: jest.fn().mockResolvedValue(1),
  };
  const sy15 = {
    withUserRls: jest.fn((_e: string, fn: (t: unknown) => Promise<unknown>) =>
      fn(tx),
    ),
    runIdempotentRls: jest.fn(
      async (
        _e: string,
        _cid: string,
        _action: string,
        fn: (t: unknown) => Promise<unknown>,
      ) => ({ idempotent: false, result: await fn(tx) }),
    ),
  };
  const aiPolicy = {
    resolve: jest
      .fn()
      .mockImplementation((_t: string, fb: string) =>
        Promise.resolve({ model: fb, effort: null }),
      ),
  } as unknown as AiModelPolicyService;
  const svc = new SastanciService(
    sy15 as unknown as Sy15Service,
    { upload: jest.fn() } as never,
    { summarize: jest.fn() } as never,
    aiPolicy,
    // Prekidac u podrazumevanom polozaju (sy15) = brana ne radi nista.
    new SastanciPbSourceService(),
    {} as never,
  );
  return { svc, tx };
}

describe("Sastanci DTO — periodični tip (024/26 d1)", () => {
  it("create: tip 'periodicni' + intervalDays 14 prolazi validaciju", async () => {
    const dto = plainToInstance(CreateSastanakDto, {
      clientEventId: CID,
      tip: "periodicni",
      intervalDays: 14,
      naslov: "Periodični",
      datum: "2026-08-10",
    });
    expect(await validate(dto)).toHaveLength(0);
  });

  it("create: intervalDays van opsega (0 / 366) pada na validaciji", async () => {
    for (const intervalDays of [0, 366]) {
      const dto = plainToInstance(CreateSastanakDto, {
        clientEventId: CID,
        tip: "periodicni",
        intervalDays,
        naslov: "Periodični",
        datum: "2026-08-10",
      });
      expect((await validate(dto)).length).toBeGreaterThan(0);
    }
  });

  it("update: tip 'periodicni' je dozvoljena vrednost (024/26 d2 — promena tipa)", async () => {
    const dto = plainToInstance(UpdateSastanakDto, { tip: "periodicni" });
    expect(await validate(dto)).toHaveLength(0);
  });
});

describe("SastanciService — periodični create/update (024/26 d1+d2)", () => {
  it("create periodični BEZ intervala → 400 (serija bez intervala se ne nastavlja)", async () => {
    const { svc } = makeSvc();
    await expect(
      svc.createSastanak("u@servoteh.com", {
        clientEventId: CID,
        tip: "periodicni",
        naslov: "P",
        datum: "2026-08-10",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("create NE-periodični sa intervalom → 400 (interval važi samo uz periodični)", async () => {
    const { svc } = makeSvc();
    await expect(
      svc.createSastanak("u@servoteh.com", {
        clientEventId: CID,
        tip: "tematski",
        intervalDays: 7,
        naslov: "T",
        datum: "2026-08-10",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("create periodični dok sy15 skripta NIJE primenjena → 409 sa putanjom skripte", async () => {
    const { svc, tx } = makeSvc();
    tx.$queryRaw.mockResolvedValueOnce(KOLONE_NE);
    const poziv = svc.createSastanak("u@servoteh.com", {
      clientEventId: CID,
      tip: "periodicni",
      intervalDays: 7,
      naslov: "P",
      datum: "2026-08-10",
    });
    await expect(poziv).rejects.toBeInstanceOf(ConflictException);
    await expect(poziv).rejects.toThrow("sastanci-024-periodicni-2026-08-04");
  });

  it("create periodični sa kolonama: red + raw upis intervala; odgovor nosi intervalDays", async () => {
    const { svc, tx } = makeSvc();
    const res = (await svc.createSastanak("u@servoteh.com", {
      clientEventId: CID,
      tip: "periodicni",
      intervalDays: 14,
      naslov: "P",
      datum: "2026-08-10",
    })) as { data: { intervalDays?: number } };
    expect(tx.sastanak.create).toHaveBeenCalled();
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1); // UPDATE interval_days
    expect(res.data.intervalDays).toBe(14);
  });

  it("update na periodični BEZ intervala (ni zatečenog) → 400", async () => {
    const { svc, tx } = makeSvc();
    tx.$queryRaw
      .mockResolvedValueOnce(KOLONE_DA) // information_schema
      .mockResolvedValueOnce([]); // interval_days za red — nema ga
    await expect(
      svc.updateSastanak("u@servoteh.com", ID, { tip: "periodicni" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("update: intervalDays uz finalni NE-periodični tip → 400", async () => {
    const { svc } = makeSvc();
    // findUnique vraća tip 'projektni', dto ne menja tip.
    await expect(
      svc.updateSastanak("u@servoteh.com", ID, { intervalDays: 7 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("SastanciService.list — kolona Sledeći (024/26, komentar 29.07 t.1)", () => {
  const d = (ymd: string) => new Date(`${ymd}T00:00:00Z`);

  it("zatvoren red dobija termin PRVOG neotkazanog naslednika istog tipa", async () => {
    const { svc, tx } = makeSvc();
    tx.sastanak.findMany
      .mockResolvedValueOnce([
        { id: "s1", tip: "sedmicni", datum: d("2026-07-20"), vreme: null, status: "zakljucan" },
      ]) // strana liste
      .mockResolvedValueOnce([
        { id: "s2", tip: "sedmicni", datum: d("2026-08-03"), vreme: new Date("1970-01-01T09:00:00Z") },
      ]); // naslednici
    const res = (await svc.list("u@servoteh.com", {})) as {
      data: { sledeci?: { datum: string; sastanakId: string | null; najava: boolean } | null }[];
    };
    expect(res.data[0].sledeci).toEqual({
      datum: "2026-08-03",
      vreme: "09:00",
      sastanakId: "s2",
      najava: false,
    });
  });

  it("zatvoren SEDMIČNI bez naslednika → najava (isto pravilo kao traka najave)", async () => {
    const { svc, tx } = makeSvc();
    tx.sastanak.findMany
      .mockResolvedValueOnce([
        { id: "s1", tip: "sedmicni", datum: d("2026-07-20"), vreme: null, status: "zavrsen" },
      ]) // strana liste
      .mockResolvedValueOnce([]) // naslednici — nema
      .mockResolvedValueOnce([]); // sedmični redovi za najavu — nema
    const res = (await svc.list("u@servoteh.com", {})) as {
      data: { sledeci?: { sastanakId: string | null; najava: boolean } | null }[];
    };
    expect(res.data[0].sledeci).toMatchObject({ sastanakId: null, najava: true });
  });

  it("MAJOR-1: dve periodične serije — svaka vidi SVOG naslednika (po lancu, ne po tipu+datumu)", async () => {
    const { svc, tx } = makeSvc();
    tx.sastanak.findMany.mockResolvedValueOnce([
      { id: "a1", tip: "periodicni", datum: d("2026-07-20"), vreme: null, status: "zakljucan" },
      { id: "b1", tip: "periodicni", datum: d("2026-07-01"), vreme: null, status: "zakljucan" },
    ]);
    tx.$queryRaw
      .mockResolvedValueOnce(KOLONE_DA) // information_schema
      .mockResolvedValueOnce([
        // Ukršteni datumi: po tipu+datumu bi OBA reda videla 04.08 (termin
        // serije B) — po lancu svaka serija vidi svoj.
        { pret: "a1", id: "a2", datum: "2026-08-20", vreme: "09:00", status: "planiran" },
        { pret: "b1", id: "b2", datum: "2026-08-04", vreme: "10:00", status: "planiran" },
      ]); // direktni naslednici po prethodni_sastanak_id
    const res = (await svc.list("u@servoteh.com", {})) as {
      data: { id: string; sledeci?: { datum: string; sastanakId: string | null; najava: boolean } | null }[];
    };
    const poId = new Map(res.data.map((r) => [r.id, r.sledeci]));
    expect(poId.get("a1")).toEqual({
      datum: "2026-08-20",
      vreme: "09:00",
      sastanakId: "a2",
      najava: false,
    });
    expect(poId.get("b1")).toEqual({
      datum: "2026-08-04",
      vreme: "10:00",
      sastanakId: "b2",
      najava: false,
    });
    // Nijedan tip-based findMany za naslednike (nema ne-periodičnih zatvorenih).
    expect(tx.sastanak.findMany).toHaveBeenCalledTimes(1);
  });

  it("MAJOR-1: OTKAZAN naslednik → najava od otkazanog repa, iz BAZNOG ritma lanca (MAJOR-2)", async () => {
    const { svc, tx } = makeSvc();
    tx.sastanak.findMany.mockResolvedValueOnce([
      { id: "a1", tip: "periodicni", datum: d("2036-07-20"), vreme: null, status: "zakljucan" },
    ]);
    tx.$queryRaw
      .mockResolvedValueOnce(KOLONE_DA) // information_schema
      .mockResolvedValueOnce([
        { pret: "a1", id: "a2", datum: "2036-08-19", vreme: "09:00", status: "otkazan" },
      ]) // direktan naslednik — otkazan = rep serije
      .mockResolvedValueOnce([
        { id: "a2", baza: "2036-08-19", interval_days: 30 },
      ]); // bazaLancaUpit za rep
    const res = (await svc.list("u@servoteh.com", {})) as {
      data: { sledeci?: { datum: string; sastanakId: string | null; najava: boolean } | null }[];
    };
    // baza repa 19.08 + 30 = 18.09 (najava; otkazan termin NIJE „sledeći").
    expect(res.data[0].sledeci).toEqual({
      datum: "2036-09-18",
      vreme: "09:00",
      sastanakId: null,
      najava: true,
    });
  });

  it("OTVOREN (planiran) red ne dobija 'sledeci' — njegov termin JE sledeći", async () => {
    const { svc, tx } = makeSvc();
    tx.sastanak.findMany.mockResolvedValueOnce([
      { id: "s1", tip: "projektni", datum: d("2026-08-10"), vreme: null, status: "planiran" },
    ]);
    const res = (await svc.list("u@servoteh.com", {})) as {
      data: { sledeci?: unknown }[];
    };
    expect(res.data[0].sledeci).toBeUndefined();
    // bez zatvorenih redova nema ni drugog findMany poziva (naslednici)
    expect(tx.sastanak.findMany).toHaveBeenCalledTimes(1);
  });
});

describe("SastanciPeriodicniService — dnevna automatika (024/26 d1)", () => {
  function makeJob() {
    const txRaw = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: "novi-id" }]),
      $executeRaw: jest.fn().mockResolvedValue(1),
    };
    const db = {
      $queryRaw: jest.fn(),
      $transaction: jest.fn(
        (fn: (t: typeof txRaw) => Promise<unknown>): Promise<unknown> =>
          fn(txRaw),
      ),
    };
    const svc = new SastanciPeriodicniService({
      db,
    } as unknown as Sy15Service);
    return { svc, db, txRaw };
  }

  it("bez sy15 kolona → no-op sa jasnim summary-jem (deploy sme pre skripte)", async () => {
    const { svc, db } = makeJob();
    db.$queryRaw.mockResolvedValueOnce(KOLONE_NE);
    const summary = await svc.kreirajDospele();
    expect(summary).toContain("preskočeno");
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it("rep serije → INSERT novog termina (catch-up od BAZE + naslov sa novim datumom) + prenos akcija", async () => {
    const { svc, db, txRaw } = makeJob();
    db.$queryRaw
      .mockResolvedValueOnce(KOLONE_DA)
      .mockResolvedValueOnce([
        {
          id: ID,
          naslov: "Kolegijum nabavke — 01.07.2026.",
          datum: "2026-07-01",
          vreme: "09:00",
          interval_days: 7,
        },
      ]) // kandidati
      .mockResolvedValueOnce([]) // praznici
      .mockResolvedValueOnce([{ danas: "2026-08-04" }]) // danas (Beograd)
      .mockResolvedValueOnce([
        { id: ID, baza: "2026-07-01", interval_days: 7 },
      ]); // bazaLancaUpit (MAJOR-2 — ritam od baze, ne od upisanog datuma)
    const summary = await svc.kreirajDospele();
    expect(summary).toContain("kreirano 1/1");
    // INSERT parametri: naslov sa NOVIM datumom + catch-up termin 05.08.
    const insertCall = txRaw.$queryRaw.mock.calls[0] as unknown as [
      { values: unknown[] },
    ];
    expect(insertCall[0].values).toEqual(
      expect.arrayContaining(["Kolegijum nabavke — 05.08.2026.", "2026-08-05"]),
    );
    // učesnici (INSERT → invite triger) + prenos otvorenih akcija.
    expect(txRaw.$executeRaw).toHaveBeenCalledTimes(2);
  });

  it("naslednik nastao u međuvremenu (NOT EXISTS vrati 0 redova) → preskoči bez greške", async () => {
    const { svc, db, txRaw } = makeJob();
    txRaw.$queryRaw.mockResolvedValueOnce([]); // INSERT ... RETURNING → prazno
    db.$queryRaw
      .mockResolvedValueOnce(KOLONE_DA)
      .mockResolvedValueOnce([
        {
          id: ID,
          naslov: "P",
          datum: "2026-07-01",
          vreme: null,
          interval_days: 7,
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ danas: "2026-08-04" }])
      .mockResolvedValueOnce([{ id: ID, baza: "2026-07-01", interval_days: 7 }]);
    const summary = await svc.kreirajDospele();
    expect(summary).toContain("kreirano 0/1");
    expect(txRaw.$executeRaw).not.toHaveBeenCalled();
  });
});
