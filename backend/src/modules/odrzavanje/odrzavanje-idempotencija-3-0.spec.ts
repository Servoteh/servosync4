import { ServiceUnavailableException } from "@nestjs/common";
import { OdrzavanjeService } from "./odrzavanje.service";
import { OdrzavanjeSourceService } from "../../common/sy15/odrzavanje-source.service";
import { IdempotencyService } from "../../common/idempotency/idempotency.service";
import type { PrismaService } from "../../prisma/prisma.service";
import type { Sy15Service } from "../../common/sy15/sy15.service";
import type { Sy15StorageService } from "../../common/sy15/sy15-storage.service";
import type { MasinaOtpisNotifyService } from "./masina-otpis-notify.service";

/**
 * §7.5 runbook-a (SEOBA_ODRZAVANJA_2026-08-06.md): `runIdem` više ne zna samo za sy15
 * registar `rev_api_idempotency` — pod `ODRZAVANJE_IZVOR=3.0` koristi generički
 * `IdempotencyService` nad 3.0 tabelom `api_idempotency`.
 *
 * 🔴 ŠTA OVI TESTOVI ČUVAJU (svaka stavka je greška koja se NE VIDI odmah):
 *
 *  1. Pod `sy15` se 3.0 registar NE dodiruje. Kad bi se dodirnuo, ključ bi se
 *     upisivao u bazu koja u tom položaju nije izvor istine — a ponovljeni zahtev
 *     bi i dalje prolazio kroz sy15, pa se to ne bi videlo dok se registri ne
 *     raziđu.
 *
 *  2. Pod `3.0` se sy15 registar NE dodiruje. Upis u pogrešnu bazu razilazi dve
 *     baze tiho (nema greške, nema loga) — vidi se tek kad se brojevi raziđu.
 *
 *  3. 🔴 Brana `assertPorted` stoji IZNAD registra. Da je ispod, neprenета putanja
 *     bi prvo POTROŠILA korisnikov `clientEventId`, pa tek onda vratila 503.
 *     Korisnik ponovi akciju (503 zvuči kao „probaj opet") i dobije 409 „ključ već
 *     upotrebljen" — poruku koja nema nikakve veze sa uzrokom.
 *
 *  4. Registar STVARNO štedi izvršavanje: drugi zahtev sa istim `clientEventId`
 *     vraća sačuvan odgovor i telo akcije se NE izvršava drugi put. Ruta koja bi
 *     „radila" bez toga tiho bi napravila dva reda na dupli klik.
 *
 * Sadržaj samog registra (zauzimanje ključa, čekanje konkurenta, 409 na drugu
 * akciju/drugog korisnika) pokriva `common/idempotency/idempotency.service.spec.ts`;
 * ovde se pinuje SPOJ modula sa njim.
 */

const CID = "3b241101-e2bb-4255-8caf-4136c566a962";
const CID2 = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const JA = "monter@servoteh.com";

/** Storage/notify se u ovom sloju ne dodiruju — nemi stubovi. */
const storageStub = {} as unknown as Sy15StorageService;
const notifyStub = () =>
  ({ notifyOtpis: jest.fn() }) as unknown as MasinaOtpisNotifyService;

/**
 * Lažna `api_idempotency` tabela nad mock Prisma klijentom: `IdempotencyService`
 * ide isključivo kroz `$executeRaw`/`$queryRaw` tagged template, pa je dovoljno
 * razlikovati INSERT / SELECT / UPDATE po tekstu upita. `ON CONFLICT DO NOTHING`
 * se ponaša kao u bazi — vraća 0 kad ključ već postoji.
 */
function makeIdemDb() {
  const rows = new Map<
    string,
    { action: string; actor_email: string; result: unknown }
  >();
  const tx = {
    $executeRaw: jest.fn((strings: TemplateStringsArray, ...v: unknown[]) => {
      const sql = strings.join(" ? ");
      if (sql.includes("INSERT INTO api_idempotency")) {
        const [cid, action, actor] = v as [string, string, string];
        if (rows.has(cid)) return 0;
        rows.set(cid, { action, actor_email: actor, result: null });
        return 1;
      }
      // UPDATE api_idempotency SET result = $1 WHERE client_event_id = $2
      const [json, cid] = v as [string, string];
      const red = rows.get(cid);
      if (red) red.result = JSON.parse(json);
      return red ? 1 : 0;
    }),
    $queryRaw: jest.fn((_s: TemplateStringsArray, ...v: unknown[]) => {
      const red = rows.get(v[0] as string);
      return red ? [red] : [];
    }),
  };
  const prisma: { $transaction: jest.Mock } = {
    $transaction: jest.fn(
      async (cb: (t: unknown) => Promise<unknown>) => await cb(tx),
    ),
  };
  return {
    rows,
    prisma: prisma as unknown as PrismaService,
    prismaMock: prisma,
    tx,
  };
}

/** sy15 stub: oba ulaza su špijunirana da se dokaže da ih 3.0 grana NE dira. */
function makeSy15() {
  const sy15Tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    $executeRaw: jest.fn().mockResolvedValue(1),
    maintMachine: { findUnique: jest.fn().mockResolvedValue(null) },
  };
  const runIdempotentRls = jest.fn(
    async (
      _e: string,
      _c: string,
      _a: string,
      fn: (t: unknown) => Promise<unknown>,
    ) => ({ result: await fn(sy15Tx), idempotent: false }),
  );
  const withUserRls = jest.fn(
    (_e: string, fn: (t: unknown) => Promise<unknown>) => fn(sy15Tx),
  );
  const sy15 = { runIdempotentRls, withUserRls } as unknown as Sy15Service;
  return { sy15, runIdempotentRls, withUserRls, sy15Tx };
}

/** Potpis privatnog `runIdem` — testira se direktno jer tela `fn30` po rutama
 *  pišu delovi 3 i 4 seobe; ovaj korak isporučuje SAMO skretnicu. */
type RunIdem = (
  email: string,
  clientEventId: string,
  action: string,
  fn: (tx: unknown) => Promise<unknown>,
  opts?: {
    fn30?: (tx: unknown) => Promise<unknown>;
    timeoutMs?: number;
  },
) => Promise<{ data: unknown; meta: { idempotent: boolean } }>;

function makeSvc(idem?: IdempotencyService) {
  const s = makeSy15();
  const svc = new OdrzavanjeService(
    s.sy15,
    storageStub,
    notifyStub(),
    undefined, // ai
    undefined, // policy
    undefined, // prisma (glavna baza — koristi ga samo otpis-notify put)
    new OdrzavanjeSourceService(),
    idem,
  );
  const runIdem = (svc as unknown as { runIdem: RunIdem }).runIdem.bind(svc);
  return { svc, runIdem, ...s };
}

function withIzvor(v: "sy15" | "3.0") {
  const orig = process.env.ODRZAVANJE_IZVOR;
  beforeEach(() => {
    process.env.ODRZAVANJE_IZVOR = v;
  });
  afterEach(() => {
    if (orig === undefined) delete process.env.ODRZAVANJE_IZVOR;
    else process.env.ODRZAVANJE_IZVOR = orig;
  });
}

describe("runIdem pod ODRZAVANJE_IZVOR=sy15 (podrazumevano) — netaknuto", () => {
  withIzvor("sy15");

  it("(a) ide kroz sy15 registar, 3.0 registar se NE dodiruje NIJEDNOM", async () => {
    const db = makeIdemDb();
    const idem = new IdempotencyService(db.prisma);
    const run = jest.spyOn(idem, "run");
    const { runIdem, runIdempotentRls } = makeSvc(idem);

    const out = await runIdem(JA, CID, "odrzavanje.create-machine", () =>
      Promise.resolve({ ok: "sy15" }),
    );

    expect(runIdempotentRls).toHaveBeenCalledTimes(1);
    expect(runIdempotentRls.mock.calls[0].slice(0, 3)).toEqual([
      JA,
      CID,
      "odrzavanje.create-machine",
    ]);
    expect(run).not.toHaveBeenCalled();
    expect(db.prismaMock.$transaction).not.toHaveBeenCalled();
    expect(out).toEqual({ data: { ok: "sy15" }, meta: { idempotent: false } });
  });

  it("(a2) `fn30` postoji, ali pod `sy15` se NE izvršava — prekidač presuđuje, ne prisustvo tela", async () => {
    const db = makeIdemDb();
    const idem = new IdempotencyService(db.prisma);
    const run = jest.spyOn(idem, "run");
    const { runIdem, runIdempotentRls } = makeSvc(idem);
    const fn30 = jest.fn().mockResolvedValue({ ok: "3.0" });

    const out = await runIdem(
      JA,
      CID,
      "odrzavanje.create-part",
      () => Promise.resolve({ ok: "sy15" }),
      { fn30 },
    );

    expect(runIdempotentRls).toHaveBeenCalledTimes(1);
    expect(fn30).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(out.data).toEqual({ ok: "sy15" });
  });

  it("prava ruta (createMachine) i dalje ide kroz sy15 registar sa svojim `action`-om", async () => {
    const { svc, runIdempotentRls, sy15Tx } = makeSvc();
    sy15Tx.maintMachine.findUnique
      .mockResolvedValueOnce(null) // provera zauzete šifre
      .mockResolvedValueOnce({ machineCode: "M-1", name: "Presa" }); // read-back

    await svc.createMachine(JA, {
      clientEventId: CID,
      machineCode: "M-1",
      name: "Presa",
    });

    expect(runIdempotentRls).toHaveBeenCalledTimes(1);
    expect(runIdempotentRls.mock.calls[0][2]).toBe("odrzavanje.create-machine");
  });
});

describe("runIdem pod ODRZAVANJE_IZVOR=3.0", () => {
  withIzvor("3.0");

  it("(b) preneta putanja ide kroz 3.0 registar, sy15 se NE dodiruje NIJEDNOM", async () => {
    const db = makeIdemDb();
    const idem = new IdempotencyService(db.prisma);
    const run = jest.spyOn(idem, "run");
    const { runIdem, runIdempotentRls, withUserRls } = makeSvc(idem);
    const fnSy15 = jest.fn();

    const out = await runIdem(
      JA,
      CID,
      "odrzavanje.create-machine",
      fnSy15 as never,
      { fn30: () => Promise.resolve({ ok: "3.0" }) },
    );

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0].slice(0, 3)).toEqual([
      JA,
      CID,
      "odrzavanje.create-machine",
    ]);
    // 🔴 Nijedan ulaz u sy15 se ne sme dodirnuti — ni registar, ni RLS put.
    expect(runIdempotentRls).not.toHaveBeenCalled();
    expect(withUserRls).not.toHaveBeenCalled();
    expect(fnSy15).not.toHaveBeenCalled();
    expect(out).toEqual({ data: { ok: "3.0" }, meta: { idempotent: false } });
  });

  it("(c) NEPRENETA putanja: 503 iz `assertPorted`, a ključ NIJE potrošen (registar netaknut)", async () => {
    const db = makeIdemDb();
    const idem = new IdempotencyService(db.prisma);
    const run = jest.spyOn(idem, "run");
    const { runIdem, runIdempotentRls } = makeSvc(idem);

    await expect(
      runIdem(JA, CID, "odrzavanje.create-work-order", () =>
        Promise.resolve({}),
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    // Brana je IZNAD registra: ni 3.0 ni sy15 registar nisu ni pipnuti,
    // pa isti `clientEventId` posle prenosa putanje i dalje vredi.
    expect(run).not.toHaveBeenCalled();
    expect(runIdempotentRls).not.toHaveBeenCalled();
    expect(db.rows.size).toBe(0);
  });

  it("(c2) prava ruta koja JOŠ NIJE preneta (createMachine) i dalje pada sa 503", async () => {
    const db = makeIdemDb();
    const { svc, runIdempotentRls } = makeSvc(
      new IdempotencyService(db.prisma),
    );
    await expect(
      svc.createMachine(JA, {
        clientEventId: CID,
        machineCode: "M-1",
        name: "Presa",
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(runIdempotentRls).not.toHaveBeenCalled();
    expect(db.rows.size).toBe(0);
  });

  it("(c3) bez ubrizganog registra putanja pada sa 503 — NIKAD tih upis u sy15", async () => {
    const { runIdem, runIdempotentRls } = makeSvc(undefined);
    await expect(
      runIdem(JA, CID, "odrzavanje.create-part", () => Promise.resolve({}), {
        fn30: () => Promise.resolve({}),
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(runIdempotentRls).not.toHaveBeenCalled();
  });

  it("(d) drugi poziv sa ISTIM clientEventId: `idempotent: true`, telo se izvrši SAMO jednom", async () => {
    const db = makeIdemDb();
    const { runIdem } = makeSvc(new IdempotencyService(db.prisma));
    const fn30 = jest.fn().mockResolvedValue({ id: "wo-1" });

    const prvi = await runIdem(JA, CID, "odrzavanje.create-tire", jest.fn(), {
      fn30,
    });
    const drugi = await runIdem(JA, CID, "odrzavanje.create-tire", jest.fn(), {
      fn30,
    });

    expect(fn30).toHaveBeenCalledTimes(1); // 🔴 brojač poziva = 1
    expect(prvi).toEqual({ data: { id: "wo-1" }, meta: { idempotent: false } });
    expect(drugi).toEqual({ data: { id: "wo-1" }, meta: { idempotent: true } });

    // Drugi ključ je nov zahtev — telo se izvršava ponovo.
    await runIdem(JA, CID2, "odrzavanje.create-tire", jest.fn(), { fn30 });
    expect(fn30).toHaveBeenCalledTimes(2);
  });

  it("bulk akcija prosleđuje `timeoutMs` 3.0 transakciji (5 s podrazumevano ne stiže)", async () => {
    const db = makeIdemDb();
    const idem = new IdempotencyService(db.prisma);
    const run = jest.spyOn(idem, "run");
    const { runIdem } = makeSvc(idem);

    await runIdem(JA, CID, "odrzavanje.import-parts", jest.fn(), {
      fn30: () => Promise.resolve({ uvezeno: 900 }),
      timeoutMs: 60_000,
    });

    expect(run.mock.calls[0][4]).toEqual({ timeoutMs: 60_000 });
    const [, txOpts] = db.prismaMock.$transaction.mock.calls[0] as unknown[];
    expect(txOpts).toEqual({ timeout: 60_000 });
  });

  it("bez `timeoutMs` se Prismi NE prosleđuje opcija (ostaje njen podrazumevani prozor)", async () => {
    const db = makeIdemDb();
    const { runIdem } = makeSvc(new IdempotencyService(db.prisma));
    await runIdem(JA, CID, "odrzavanje.create-note", jest.fn(), {
      fn30: () => Promise.resolve({}),
    });
    const [, txOpts] = db.prismaMock.$transaction.mock.calls[0] as unknown[];
    expect(txOpts).toBeUndefined();
  });
});
