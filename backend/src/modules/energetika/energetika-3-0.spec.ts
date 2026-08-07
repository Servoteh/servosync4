import { ScadaSourceService } from "../../common/sy15/scada-source.service";
import { EnergetikaService } from "./energetika.service";
import type { Sy15Service } from "../../common/sy15/sy15.service";
import type { PrismaService } from "../../prisma/prisma.service";
import { ScadaJobsService } from "../scheduler/scada-jobs.service";

/**
 * Unit — SCADA pod `SCADA_IZVOR=3.0` (seoba 07.08.2026, docs/SEOBA_SCADA_2026-08-07.md).
 *
 * Ovo NIJE kopija sy15 testova sa drugim mokom. Pinuje se tačno ono što preklop
 * može da pokvari a da se ne primeti dok neko ne uporedi dva ekrana:
 *   1. da 3.0 putanja UOPŠTE NE DODIRUJE sy15 (i obrnuto) — inače bi se pisalo
 *      u jednu bazu a čitalo iz druge;
 *   2. da `cancel` i pod 3.0 traži vlasništvo nad komandom (u sy15 to je radio
 *      DEFINER RPC koji ovde više ne postoji);
 *   3. da se poslovi scheduler-a registruju SAMO pod 3.0;
 *   4. da prekidač ne dodiruje tuđe domene.
 */
describe("Energetika pod SCADA_IZVOR=3.0", () => {
  const OLD_ENV = { ...process.env };
  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  /** sy15 mok koji PUCA ako ga iko dodirne — brana da 3.0 putanja ne sklizne nazad. */
  function sy15MustNotBeTouched(): Sy15Service {
    return {
      withUserRls: jest.fn(() => {
        throw new Error("sy15 dodirnut pod SCADA_IZVOR=3.0");
      }),
    } as unknown as Sy15Service;
  }

  /**
   * `prisma` je namerno `unknown`: mokuju se samo delegati koje test dodiruje, a
   * `PrismaService` je preširok da bi se delimično implementirao bez šuma.
   */
  function makeService(prisma: unknown) {
    process.env.SCADA_IZVOR = "3.0";
    return new EnergetikaService(
      sy15MustNotBeTouched(),
      prisma as PrismaService,
      new ScadaSourceService(),
    );
  }

  it("sites/snapshots/alarmi/komande čitaju 3.0 Prisma klijent, sy15 se NE dodiruje", async () => {
    const now = new Date("2026-08-07T09:00:00.000Z");
    const prisma = {
      scadaSite: { findMany: jest.fn(async () => [{ key: "kot1" }]) },
      scadaSnapshot: { findMany: jest.fn(async () => [{ siteKey: "kot1" }]) },
      scadaAlarm: {
        findMany: jest.fn(async () => [{ id: 7n, code: "X" }]),
      },
      scadaCommand: { findMany: jest.fn(async () => [{ id: "u" }]) },
      $queryRaw: jest.fn(async () => [{ now }]),
    };
    const s = makeService(prisma);

    expect(await s.sites("a@b.com")).toEqual({ data: [{ key: "kot1" }] });

    const snap = (await s.snapshots("a@b.com")) as {
      meta: { serverNow: Date };
    };
    // serverNow MORA doći iz 3.0 baze (ista koja piše updated_at) — v. servis.
    expect(snap.meta.serverNow).toBe(now);

    // bigint id → Number pre JSON-a (inače `JSON.stringify` baca).
    const al = (await s.activeAlarms("a@b.com")) as { data: { id: number }[] };
    expect(al.data[0].id).toBe(7);
    expect(typeof al.data[0].id).toBe("number");

    expect(await s.recentCommands("a@b.com")).toEqual({ data: [{ id: "u" }] });
  });

  it("history gradi predikat i čita 3.0; nepoznat sistem ne dira bazu", async () => {
    const ts = new Date("2026-08-07T09:00:00.000Z");
    const $queryRaw = jest.fn(async () => [{ metric: "T_SUDA", ts, value: 21 }]);
    const s = makeService({ $queryRaw });

    const out = (await s.history("a@b.com", "kot1", "24")) as {
      data: unknown[];
      meta: { metrics: unknown[] };
    };
    expect($queryRaw).toHaveBeenCalledTimes(1);
    expect(out.data).toHaveLength(1);
    expect(out.meta.metrics).toHaveLength(14); // pun spisak tagova, kao i pod sy15

    // Nepoznat sistem: nema predikata → nema upita uopšte (ne „prazan WHERE").
    $queryRaw.mockClear();
    const empty = (await s.history("a@b.com", "nepostoji")) as {
      data: unknown[];
    };
    expect($queryRaw).not.toHaveBeenCalled();
    expect(empty.data).toEqual([]);
  });

  it("🔴 cancel i pod 3.0 traži VLASNIŠTVO nad komandom (prepis DEFINER uslova)", async () => {
    // Argument je tipiziran da bi `mock.calls[0][0].where` uopšte postojao u tipu.
    const updateMany = jest.fn(
      async (_a: { where: Record<string, unknown> }) => ({ count: 1 }),
    );
    const findUnique = jest.fn(async () => ({ status: "expired" }));
    const tx = { scadaCommand: { updateMany, findUnique } };
    const prisma = {
      $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    const s = makeService(prisma);

    const out = await s.cancel("Nenad.Jarakovic@Servoteh.com", "id-1");
    expect(out).toEqual({ status: "expired" });

    // Bez ovog uslova bi svaki menadžer mogao da otkaže TUĐU komandu — sy15 RPC
    // to nikad nije dozvoljavao (`requested_by = lower(auth.jwt()->>'email')`).
    const where = updateMany.mock.calls[0][0].where;
    expect(where).toEqual({
      id: "id-1",
      status: "pending",
      requestedBy: "nenad.jarakovic@servoteh.com",
    });
  });

  it("cancel na nepostojeći red vraća 'missing' (NE 404 — nije greška toka)", async () => {
    const tx = {
      scadaCommand: {
        updateMany: jest.fn(async () => ({ count: 0 })),
        findUnique: jest.fn(async () => null),
      },
    };
    const s = makeService({
      $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    });
    expect(await s.cancel("a@b.com", "nema")).toEqual({ status: "missing" });
  });

  it("create postavlja requestedBy iz claims-a, ne iz DTO-a (RLS WITH CHECK paritet)", async () => {
    const create = jest.fn(async ({ data }: { data: Record<string, unknown> }) => data);
    const s = makeService({
      scadaCommand: { create },
    });

    await s.create("Nenad@Servoteh.com", {
      siteKey: "kot1",
      target: "SP_CNC",
      value: { v: 22 },
    });
    const data = create.mock.calls[0][0].data;
    expect(data.requestedBy).toBe("nenad@servoteh.com");
    // status/result/claimed_at/applied_at se NE šalju — pod sy15 ih je forsirala
    // RLS politika, pod 3.0 ih drži ovaj kod (Prisma @default).
    expect(data.status).toBeUndefined();
    expect(data.result).toBeUndefined();
    expect(data.claimedAt).toBeUndefined();
    expect(data.appliedAt).toBeUndefined();
  });
});

describe("ScadaJobsService — registracija poslova prati prekidač", () => {
  const OLD_ENV = { ...process.env };
  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  const make = () =>
    new ScadaJobsService({} as never, new ScadaSourceService());

  it("pod sy15 (podrazumevano) NE registruje nijedan posao", () => {
    delete process.env.SCADA_IZVOR;
    expect(make().buildJobs()).toEqual([]);
  });

  it("🔴 pod sy15 watchdog ćuti — inače bi digao BRIDGE_STALE za svih 5 sistema", () => {
    // 3.0 snapshotovi su prazni dok je izvor sy15; bezuslovna registracija bi
    // odmah po deploy-u alarmirala sve sisteme na ekranu koji gleda u sy15.
    process.env.SCADA_IZVOR = "sy15";
    expect(make().buildJobs()).toHaveLength(0);
  });

  it("pod 3.0 registruje watchdog (5 min) i retenciju (dnevno)", () => {
    process.env.SCADA_IZVOR = "3.0";
    const jobs = make().buildJobs();
    expect(jobs.map((j) => j.key).sort()).toEqual([
      "scada-retention",
      "scada-watchdog",
    ]);
    const wd = jobs.find((j) => j.key === "scada-watchdog")!;
    expect(wd.schedule).toEqual({ kind: "everyMinutes", minutes: 5 });
    const ret = jobs.find((j) => j.key === "scada-retention")!;
    expect(ret.schedule).toEqual({ kind: "daily", at: "03:40" });
    // Prvi rez briše ~3,2 mil. redova — sa podrazumevanih 10 min scheduler bi
    // posao smatrao zaglavljenim i pokrenuo ga DRUGI PUT preko prvog.
    expect(ret.staleAfterMinutes).toBe(60);
  });

  it("neprepoznata vrednost ne sme da se protumači kao 3.0", () => {
    process.env.SCADA_IZVOR = "3,0";
    expect(make().buildJobs()).toEqual([]);
  });
});
