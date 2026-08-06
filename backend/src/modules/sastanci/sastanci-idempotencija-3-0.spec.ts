import { ForbiddenException } from "@nestjs/common";
import { SastanciService } from "./sastanci.service";
import { SastanciSourceService } from "../../common/sy15/sastanci-source.service";
import type { Sy15Service } from "../../common/sy15/sy15.service";
import type { AiModelPolicyService } from "../../common/ai/ai-model-policy.service";

/**
 * Blokada 1 iz runbook-a: `create-sastanak` / `bulk-ucesnici` / `prenos` /
 * `instantiate` su pod `SASTANCI_IZVOR=3.0` padale sa 503 jer registra
 * idempotencije u 3.0 bazi nije bilo.
 *
 * 🔴 ŠTA OVI TESTOVI ČUVAJU:
 *   1. da te četiri rute pod `3.0` VIŠE NE DIRAJU sy15 (upis u pogrešnu bazu
 *      razišao bi dve baze, a to se ne vidi odmah),
 *   2. da SVE ČETIRI i dalje idu kroz registar — ruta koja bi „radila" bez
 *      registra tiho bi vratila duplo izvršavanje na dupli klik,
 *   3. da gejt prava stoji PRE registra (neovlašćen pokušaj ne sme da potroši
 *      korisnikov `clientEventId`),
 *   4. da se logički trigeri koje migracija namerno NE prenosi
 *      (`sast_trg_ucesnik_invite`) pozivaju eksplicitno — bez toga bi sastanak
 *      nastao bez ijedne pozivnice, tiho.
 */

const CID = "3b241101-e2bb-4255-8caf-4136c566a962";
const ID = "11111111-2222-3333-4444-555555555555";
const SRC = "99999999-8888-7777-6666-555555555555";
const JA = "ja@servoteh.com";

const aiPolicyStub = (): AiModelPolicyService =>
  ({
    resolve: jest
      .fn()
      .mockImplementation((_t: string, fb: string) =>
        Promise.resolve({ model: fb, effort: null }),
      ),
  }) as unknown as AiModelPolicyService;

function makeSvc(opts: { sme?: boolean } = {}) {
  const sme = opts.sme !== false;
  const tx = {
    sastanak: {
      create: jest.fn().mockResolvedValue({ id: ID, status: "planiran" }),
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: ID, tip: "sedmicni", datum: new Date("2026-08-10"), naslov: "S" }),
      findFirst: jest.fn().mockResolvedValue({ id: SRC, naslov: "Prošli" }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    sastanakUcesnik: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    akcionaTacka: { updateMany: jest.fn().mockResolvedValue({ count: 4 }) },
    sastanciTemplate: {
      findUnique: jest.fn().mockResolvedValue({
        id: "tpl",
        naziv: "Kolegijum",
        tip: "sedmicni",
        cadence: "weekly",
        cadenceDow: 1,
        cadenceDom: null,
        createdAt: new Date("2026-08-01"),
        vreme: null,
        mesto: null,
        vodioEmail: null,
        zapisnicarEmail: null,
        napomena: null,
      }),
    },
    sastanciTemplateUcesnik: { findMany: jest.fn().mockResolvedValue([]) },
  };
  // Registar: pušta akciju i vraća njen rezultat (sadržaj registra pokriva
  // `common/idempotency/idempotency.service.spec.ts`).
  const idem = {
    run: jest.fn(
      async (
        _e: string,
        _c: string,
        _a: string,
        fn: (t: unknown) => Promise<unknown>,
      ) => ({ idempotent: false, result: await fn(tx) }),
    ),
  };
  const authz = {
    canCreateSastanak: jest.fn().mockResolvedValue(sme),
    assertCanWriteSastanakChild: jest.fn(
      async (_email: string, _sastanakId: string | null) => {
        if (!sme) throw new ForbiddenException("nema prava");
      },
    ),
  };
  const fn = {
    ucesnikInviteTrigger: jest.fn().mockResolvedValue(1),
    ucesnikInviteCleanup: jest.fn().mockResolvedValue(undefined),
    assertNotLocked: jest.fn().mockResolvedValue(undefined),
  };
  const sy15 = {
    withUserRls: jest.fn(),
    runIdempotentRls: jest.fn(),
  };
  // Prevod predmeta: ovi testovi ga ne gađaju (DTO bez `projekatId`), pa vraća
  // `undefined` — isto što i „polje nije poslato".
  const predmet = {
    razresi: jest.fn().mockResolvedValue(undefined),
    razresiFilter: jest.fn().mockResolvedValue(undefined),
  };
  const svc = new SastanciService(
    sy15 as unknown as Sy15Service,
    {} as never,
    {} as never,
    aiPolicyStub(),
    new SastanciSourceService(),
    {} as never,
    {} as never,
    fn as never,
    authz as never,
    idem as never,
    // SastanciPredmetService — prevod predmeta uuid<->Int (blokada 5).
    predmet as never,
  );
  return { svc, tx, idem, authz, fn, sy15 };
}

describe("blokada 1 — četiri rute pod 3.0 idu kroz 3.0 registar", () => {
  const orig = process.env.SASTANCI_IZVOR;
  beforeEach(() => {
    process.env.SASTANCI_IZVOR = "3.0";
  });
  afterEach(() => {
    if (orig === undefined) delete process.env.SASTANCI_IZVOR;
    else process.env.SASTANCI_IZVOR = orig;
  });

  const pozovi = async (svc: SastanciService, ruta: string) => {
    switch (ruta) {
      case "sastanci.create-sastanak":
        return svc.createSastanak(JA, {
          clientEventId: CID,
          naslov: "Novi",
          datum: "2026-08-10",
          ucesnici: [{ email: "Pera@Servoteh.com", label: "Pera" }],
        } as never);
      case "sastanci.bulk-ucesnici":
        return svc.bulkUcesnici(JA, ID, {
          clientEventId: CID,
          ucesnici: [{ email: "pera@servoteh.com" }],
        } as never);
      case "sastanci.prenos":
        return svc.prenos(JA, ID, { clientEventId: CID } as never);
      default:
        return svc.instantiate(JA, "tpl", { clientEventId: CID } as never);
    }
  };

  const RUTE = [
    "sastanci.create-sastanak",
    "sastanci.bulk-ucesnici",
    "sastanci.prenos",
    "sastanci.instantiate-template",
  ];

  it.each(RUTE)("%s: više ne pada sa 503 i troši registar sa ključem iz zahteva", async (ruta) => {
    const { svc, idem, sy15 } = makeSvc();
    const out = await pozovi(svc, ruta);
    expect(idem.run).toHaveBeenCalledTimes(1);
    expect(idem.run.mock.calls[0].slice(0, 3)).toEqual([JA, CID, ruta]);
    // 🔴 Nijedan od dva ulaza u sy15 se ne sme dodirnuti pod `3.0`.
    expect(sy15.runIdempotentRls).not.toHaveBeenCalled();
    expect(sy15.withUserRls).not.toHaveBeenCalled();
    expect(out).toHaveProperty("meta.idempotent", false);
  });

  it.each(RUTE)("%s: gejt prava stoji PRE registra (ne troši clientEventId)", async (ruta) => {
    const { svc, idem } = makeSvc({ sme: false });
    await expect(pozovi(svc, ruta)).rejects.toBeInstanceOf(ForbiddenException);
    expect(idem.run).not.toHaveBeenCalled();
  });

  it("create: šalje pozivnice prepisom trigera (migracija ga NE prenosi)", async () => {
    const { svc, fn, tx } = makeSvc();
    await pozovi(svc, "sastanci.create-sastanak");
    expect(tx.sastanak.create).toHaveBeenCalledTimes(1);
    expect(fn.ucesnikInviteTrigger).toHaveBeenCalledWith(tx, ID, [
      { email: "pera@servoteh.com", label: "Pera" },
    ]);
  });

  it("create: `createdByEmail` je pozivalac — time deca prolaze trio gejt", async () => {
    const { svc, tx } = makeSvc();
    await pozovi(svc, "sastanci.create-sastanak");
    expect(tx.sastanak.create.mock.calls[0][0].data.createdByEmail).toBe(JA);
  });

  it("bulk: skinutom učesniku briše nepokupljenu pozivnicu (AFTER DELETE triger)", async () => {
    const { svc, tx, fn } = makeSvc();
    tx.sastanakUcesnik.findMany.mockResolvedValue([
      { email: "stari@servoteh.com" },
    ]);
    await pozovi(svc, "sastanci.bulk-ucesnici");
    expect(fn.ucesnikInviteCleanup).toHaveBeenCalledWith(tx, ID, [
      "stari@servoteh.com",
    ]);
  });

  it("bulk/prenos: guard zaključanog sastanka se poziva (sast_check_not_locked)", async () => {
    for (const ruta of ["sastanci.bulk-ucesnici", "sastanci.prenos"]) {
      const { svc, fn } = makeSvc();
      await pozovi(svc, ruta);
      expect(fn.assertNotLocked).toHaveBeenCalled();
    }
  });

  it("🔴 prenos: gejt se traži i za IZVOR (ap_update proverava USING i WITH CHECK)", async () => {
    const { svc, authz } = makeSvc();
    await pozovi(svc, "sastanci.prenos");
    const meta = authz.assertCanWriteSastanakChild.mock.calls.map((c) => c[1]);
    expect(meta).toContain(ID); // cilj
    expect(meta).toContain(SRC); // izvor
  });

  it("prenos: bez kandidata za izvor vraća nule bez greške (paritet 1.0)", async () => {
    const { svc, tx } = makeSvc();
    tx.sastanak.findFirst.mockResolvedValue(null);
    const out = await pozovi(svc, "sastanci.prenos");
    expect(out).toHaveProperty("data", { ucesnici: 0, akcije: 0, source: null });
  });

  it("instantiate: pozivalac je uvek na listi i pozivnice se šalju", async () => {
    const { svc, fn } = makeSvc();
    await pozovi(svc, "sastanci.instantiate-template");
    const redovi = fn.ucesnikInviteTrigger.mock.calls[0][2];
    expect(redovi.map((r: { email: string }) => r.email)).toContain(JA);
  });
});

describe("pod sy15 ponašanje četiri rute je NETAKNUTO", () => {
  const orig = process.env.SASTANCI_IZVOR;
  beforeEach(() => {
    process.env.SASTANCI_IZVOR = "sy15";
  });
  afterEach(() => {
    if (orig === undefined) delete process.env.SASTANCI_IZVOR;
    else process.env.SASTANCI_IZVOR = orig;
  });

  it("create ide kroz sy15 registar, 3.0 registar se NE dodiruje", async () => {
    const { svc, idem, sy15 } = makeSvc();
    sy15.runIdempotentRls.mockResolvedValue({ idempotent: false, result: {} });
    await svc.createSastanak(JA, {
      clientEventId: CID,
      naslov: "Novi",
      datum: "2026-08-10",
    } as never);
    expect(sy15.runIdempotentRls).toHaveBeenCalledTimes(1);
    expect(idem.run).not.toHaveBeenCalled();
  });
});
