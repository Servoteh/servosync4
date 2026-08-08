/* eslint-disable @typescript-eslint/no-unsafe-assignment,
                  @typescript-eslint/no-unsafe-member-access,
                  @typescript-eslint/no-unsafe-return,
                  @typescript-eslint/no-unsafe-argument,
                  @typescript-eslint/no-unsafe-call,
                  @typescript-eslint/require-await --
   „Lažna 3.0 baza" ispod je ručno pisan mini-ORM nad `Record<string, any>`:
   glumi Prisma klijent za 24 modela, a Prisma tipovi se ne mogu ni reprodukovati
   ni uvesti bez generisanog klijenta u testu. Netipiziranost je OVDE namerna i
   ograničena na taj sloj — sve tvrdnje ispod idu preko pravih servisa. */
import {
  ForbiddenException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { OdrzavanjeService } from "./odrzavanje.service";
import { OdrzavanjeAuthzService } from "./odrzavanje-authz.service";
import { OdrzavanjeFnService } from "./odrzavanje-fn.service";
import { OdrzavanjeSourceService } from "../../common/sy15/odrzavanje-source.service";
import { IdempotencyService } from "../../common/idempotency/idempotency.service";
import type { PrismaService } from "../../prisma/prisma.service";
import type { Sy15Service } from "../../common/sy15/sy15.service";
import type { Sy15StorageService } from "../../common/sy15/sy15-storage.service";
import type { MasinaOtpisNotifyService } from "./masina-otpis-notify.service";
import type { OdrzavanjeLokacijeMostService } from "./odrzavanje-lokacije-most.service";

/**
 * §7.1 seobe održavanja — UPISI: mašine · override · napomene · fajlovi ·
 * preventiva · incidenti · radni nalozi, pod `ODRZAVANJE_IZVOR=3.0`.
 *
 * 🔴 ŠTA OVAJ FAJL ČUVA (svaka stavka je kvar koji NIŠTA NE OBORI):
 *
 *  1. **Zaobiđen `OdrzavanjeFnService`.** U sy15 je posao radila baza — DEFINER
 *     funkcije i 11 logičkih trigera. U 3.0 ih NEMA: `maint_wo_events` trag,
 *     auto-nalog iz kritičnog kvara, `current_stock += delta` i trag brisanja
 *     mašine postoje SAMO u tom servisu. Ruta koja ih preskoči i dalje vraća 200
 *     i upiše svoj red — nedostaje samo posledica. Zato grupa (a) za SVAKI takav
 *     put tvrdi da je metoda pozvana, a grupa (b) da je posledica stvarno tu.
 *
 *  2. **Poziv BEZ `tx`.** Svaka `fn` metoda prima `tx` da bi ušla u transakciju
 *     pozivaoca (u sy15 su DEFINER fn radile u ISTOJ transakciji). Prosleđen
 *     `undefined` radi savršeno u srećnom slučaju — i tiho razdvaja „obriši
 *     mašinu" od „upiši trag" na prvoj grešci. Zato se `mock.calls[0][0]`
 *     poredi sa BAŠ tim transakcionim klijentom, ne samo „nije undefined".
 *
 *  3. **Most ka `loc_locations` unutar transakcije.** To je DRUGA baza; unutar
 *     `$transaction` bi 3.0 upis visio na sy15 latenciji. Grupa (c) pinuje da
 *     se most zove TEK POSLE commit-a — i da ga `renameMachine` NE zove uopšte.
 *
 *  4. **Gejtovi.** RLS više ne postoji; 3.0 gejt je jedina brana. Grupa (d)
 *     proverava izraze prepisane sa `pg_policies` žive sy15.
 *
 *  5. **Pod `sy15` se 3.0 sloj ne sme dodirnuti** (grupa (e)) — inače bi se dve
 *     baze tiho razišle.
 */

const CID = () => randomUUID();
const SEF_MEJL = "sef@servoteh.com";
const OPERATER_MEJL = "operater@servoteh.com";

/* ══════════════════════ Lažna 3.0 baza (mini-ORM nad Map-ama) ══════════════════════ */

type Red = Record<string, any>;

/** Poređenje jednog `where` uslova — pokriva oblike koje modul stvarno koristi. */
function pogadja(vrednost: any, uslov: any): boolean {
  if (uslov === null || typeof uslov !== "object" || uslov instanceof Date) {
    return vrednost instanceof Date && uslov instanceof Date
      ? vrednost.getTime() === uslov.getTime()
      : vrednost === uslov;
  }
  if ("in" in uslov) return (uslov.in as any[]).includes(vrednost);
  if ("notIn" in uslov) return !(uslov.notIn as any[]).includes(vrednost);
  if ("not" in uslov) return !pogadja(vrednost, uslov.not);
  if ("equals" in uslov) {
    return uslov.mode === "insensitive"
      ? String(vrednost).toLowerCase() === String(uslov.equals).toLowerCase()
      : pogadja(vrednost, uslov.equals);
  }
  return false;
}

function gde(red: Red, where?: Red): boolean {
  if (!where) return true;
  for (const [k, v] of Object.entries(where)) {
    if (k === "OR") {
      if (!(v as Red[]).some((w) => gde(red, w))) return false;
      continue;
    }
    if (k === "AND") {
      if (!(v as Red[]).every((w) => gde(red, w))) return false;
      continue;
    }
    if (!pogadja(red[k], v)) return false;
  }
  return true;
}

/** Relacije koje modul zaista džoinuje (`select: { asset: { select: … } }`). */
const RELACIJE: Record<
  string,
  Record<string, (r: Red, db: LaznaBaza) => Red | null>
> = {
  maintWorkOrder: {
    asset: (r, db) =>
      db.tabele.maintAsset.find((a) => a.assetId === r.assetId) ?? null,
  },
  maintIncident: {
    asset: (r, db) =>
      db.tabele.maintAsset.find((a) => a.assetId === r.assetId) ?? null,
  },
  maintAsset: {
    machine: (r, db) =>
      db.tabele.maintMachine.find((m) => m.assetId === r.assetId) ?? null,
  },
  maintMachine: {
    asset: (r, db) =>
      db.tabele.maintAsset.find((a) => a.assetId === r.assetId) ?? null,
  },
};

const PK: Record<string, string> = {
  maintMachine: "machineCode",
  maintAsset: "assetId",
  maintWorkOrder: "woId",
  maintIncident: "id",
  maintIncidentEvent: "id",
  maintWoEvent: "id",
  maintWoLabor: "id",
  maintWoPart: "id",
  maintPart: "partId",
  maintPartStockMovement: "movementId",
  maintTask: "id",
  maintCheck: "id",
  maintMachineNote: "id",
  maintMachineFile: "id",
  maintMachineStatusOverride: "machineCode",
  maintMachineDeletionLog: "id",
  maintNotificationLog: "id",
  maintNotificationRule: "ruleId",
  maintSettings: "id",
  maintUserProfile: "userId",
  maintVehicleServicePlan: "planId",
  maintAssetServicePlan: "planId",
  user: "id",
  userRole: "id",
};

class LaznaBaza {
  tabele: Record<string, Red[]> = {};
  /** Redosled poteza — dokaz da most ide POSLE commit-a. */
  trag: string[] = [];
  private idem = new Map<string, Red>();

  constructor() {
    for (const m of Object.keys(PK)) this.tabele[m] = [];
    for (const m of Object.keys(PK)) (this as any)[m] = this.model(m);
  }

  private prosiri(model: string, red: Red, select?: Red): Red {
    if (!select) return { ...red };
    const out: Red = { ...red };
    for (const [k, v] of Object.entries(select)) {
      const rel = RELACIJE[model]?.[k];
      if (rel && v) {
        const vezan = rel(red, this);
        out[k] = vezan
          ? this.prosiri(
              k === "machine" ? "maintMachine" : "maintAsset",
              vezan,
              typeof v === "object" ? (v as Red).select : undefined,
            )
          : null;
      }
    }
    return out;
  }

  private model(ime: string) {
    const pk = PK[ime];
    const t = () => this.tabele[ime];
    const sada = () => new Date();
    return {
      findUnique: async ({ where, select }: Red) =>
        t()
          .filter((r) => gde(r, where))
          .map((r) => this.prosiri(ime, r, select))[0] ?? null,
      findFirst: async ({ where, select, orderBy }: Red = {}) => {
        let redovi = t().filter((r) => gde(r, where));
        if (orderBy) redovi = sortiraj(redovi, orderBy);
        return redovi.map((r) => this.prosiri(ime, r, select))[0] ?? null;
      },
      findMany: async ({ where, select, orderBy, take }: Red = {}) => {
        let redovi = t().filter((r) => gde(r, where));
        if (orderBy) redovi = sortiraj(redovi, orderBy);
        if (take != null) redovi = redovi.slice(0, take);
        return redovi.map((r) => this.prosiri(ime, r, select));
      },
      count: async ({ where }: Red = {}) =>
        t().filter((r) => gde(r, where)).length,
      create: async ({ data, select }: Red) => {
        const red: Red = {
          createdAt: sada(),
          updatedAt: sada(),
          at: sada(),
          uploadedAt: sada(),
          reportedAt: sada(),
          performedAt: sada(),
          setAt: sada(),
          deletedAt: null,
          assignedTo: null,
          workOrderId: null,
          woNumber: `WO-2026-${String(t().length + 1).padStart(5, "0")}`,
          ...data,
        };
        if (red[pk] === undefined) red[pk] = randomUUID();
        t().push(red);
        this.trag.push(`create:${ime}`);
        return this.prosiri(ime, red, select);
      },
      update: async ({ where, data, select }: Red) => {
        const red = t().find((r) => gde(r, where));
        if (!red) throw Object.assign(new Error("P2025"), { code: "P2025" });
        primeni(red, data);
        this.trag.push(`update:${ime}`);
        return this.prosiri(ime, red, select);
      },
      updateMany: async ({ where, data }: Red) => {
        const redovi = t().filter((r) => gde(r, where));
        for (const r of redovi) primeni(r, data);
        if (redovi.length) this.trag.push(`updateMany:${ime}`);
        return { count: redovi.length };
      },
      upsert: async ({ where, create, update }: Red) => {
        const red = t().find((r) => gde(r, where));
        if (red) {
          primeni(red, update);
          return { ...red };
        }
        const nov: Red = { setAt: sada(), ...create };
        if (nov[pk] === undefined) nov[pk] = randomUUID();
        t().push(nov);
        return { ...nov };
      },
      delete: async ({ where }: Red) => {
        const i = t().findIndex((r) => gde(r, where));
        if (i < 0) throw Object.assign(new Error("P2025"), { code: "P2025" });
        const [red] = t().splice(i, 1);
        this.trag.push(`delete:${ime}`);
        return red;
      },
      deleteMany: async ({ where }: Red = {}) => {
        const ostaje = t().filter((r) => !gde(r, where));
        const n = t().length - ostaje.length;
        this.tabele[ime] = ostaje;
        return { count: n };
      },
    };
  }

  /** `api_idempotency` — isti ugovor kao prava tabela (INSERT … DO NOTHING). */
  $executeRaw = jest.fn((strings: TemplateStringsArray, ...v: unknown[]) => {
    const sql = strings.join(" ? ");
    if (sql.includes("INSERT INTO api_idempotency")) {
      const [cid, action, actor] = v as [string, string, string];
      if (this.idem.has(cid)) return 0;
      this.idem.set(cid, { action, actor_email: actor, result: null });
      return 1;
    }
    const [json, cid] = v as [string, string];
    const red = this.idem.get(cid);
    if (red) red.result = JSON.parse(json);
    return red ? 1 : 0;
  });

  $queryRaw = jest.fn((_s: TemplateStringsArray, ...v: unknown[]) => {
    const red = this.idem.get(v[0] as string);
    return red ? [red] : [];
  });

  $transaction = jest.fn(async (cb: (t: unknown) => Promise<unknown>) => {
    const out = await cb(this);
    this.trag.push("COMMIT");
    return out;
  });
}

function sortiraj(redovi: Red[], orderBy: Red | Red[]): Red[] {
  const pravila = Array.isArray(orderBy) ? orderBy : [orderBy];
  return [...redovi].sort((a, b) => {
    for (const p of pravila) {
      const [k, smer] = Object.entries(p)[0] as [string, string];
      const va = a[k] instanceof Date ? a[k].getTime() : a[k];
      const vb = b[k] instanceof Date ? b[k].getTime() : b[k];
      if (va === vb) continue;
      return (va > vb ? 1 : -1) * (smer === "desc" ? -1 : 1);
    }
    return 0;
  });
}

function primeni(red: Red, data: Red): void {
  for (const [k, v] of Object.entries(data)) {
    if (
      v &&
      typeof v === "object" &&
      !(v instanceof Date) &&
      "increment" in v
    ) {
      red[k] = Number(red[k] ?? 0) + Number((v as Red).increment);
      continue;
    }
    red[k] = v;
  }
}

/* ══════════════════════ Sklop servisa ══════════════════════ */

interface Sklop {
  svc: OdrzavanjeService;
  db: LaznaBaza;
  fn: OdrzavanjeFnService;
  most: { aktivan: jest.Mock; syncMachineToLoc: jest.Mock };
  sy15Tx: Red;
  withUserRls: jest.Mock;
  runIdempotentRls: jest.Mock;
  storage: { upload: jest.Mock; remove: jest.Mock; signUrl: jest.Mock };
}

/**
 * PREVOD IDENTITETA — sy15 uuid-i naloga iz seed-a.
 *
 * 🔴 Šef je PRVI red u `users`, a prevode se uuid-i OSTALIH: tako prevodilac koji
 * bi ignorisao `sy15_user_id` i vratio „prvi nalog" pada, umesto da slučajno
 * pogodi tačan broj. TREĆI nalog namerno NEMA sy15 parnjaka (10 od 71 3.0 naloga
 * na produkciji je takvo — nullable kolona je izmereno stanje, ne kvar).
 */
const UUID_SEF = "11111111-1111-4111-8111-111111111111";
const UUID_OPERATER = "22222222-2222-4222-8222-222222222222";
/** Postoji u sy15, NEMA 3.0 parnjaka (u produkciji: `bigtehn-worker@system.local`). */
const UUID_BEZ_PARNJAKA = "99999999-9999-4999-8999-999999999999";
const TEHNICAR_MEJL = "tehnicar@servoteh.com";

/** Šef proizvodnje (chief) = pun katalog-write; operater = najuži profil. */
function seed(db: LaznaBaza): void {
  db.tabele.user.push(
    {
      id: 1,
      email: SEF_MEJL,
      role: "user",
      active: true,
      sy15UserId: UUID_SEF,
    },
    {
      id: 2,
      email: OPERATER_MEJL,
      role: "user",
      active: true,
      sy15UserId: UUID_OPERATER,
    },
    // Nalog BEZ sy15 parnjaka — ispravno stanje, ne kvar.
    {
      id: 3,
      email: TEHNICAR_MEJL,
      role: "user",
      active: true,
      sy15UserId: null,
    },
  );
  db.tabele.maintUserProfile.push(
    { userId: 1, role: "chief", active: true, assignedMachineCodes: [] },
    {
      userId: 2,
      role: "operator",
      active: true,
      assignedMachineCodes: ["3.12"],
    },
  );
  db.tabele.maintAsset.push({
    assetId: "a-312",
    assetCode: "3.12",
    assetType: "machine",
    name: "Presa 3.12",
    active: true,
    archivedAt: null,
  });
  db.tabele.maintMachine.push({
    machineCode: "3.12",
    name: "Presa 3.12",
    assetId: "a-312",
    tracked: true,
    archivedAt: null,
    source: "manual",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  });
}

function napravi(izvor: "sy15" | "3.0"): Sklop {
  process.env.ODRZAVANJE_IZVOR = izvor;
  const db = new LaznaBaza();
  seed(db);
  const prisma = db as unknown as PrismaService;
  const authz = new OdrzavanjeAuthzService(prisma);
  const fn = new OdrzavanjeFnService(prisma, authz);
  const most = {
    aktivan: jest.fn(() => izvor === "3.0"),
    syncMachineToLoc: jest.fn(async () => {
      db.trag.push("MOST");
      return { ok: true, akcija: "update" as const };
    }),
  };
  const storage = {
    upload: jest.fn(async () => undefined),
    remove: jest.fn(async () => undefined),
    signUrl: jest.fn(async () => "https://sy15/potpis"),
  };
  const sy15Tx: Red = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    $executeRaw: jest.fn().mockResolvedValue(1),
    maintMachine: { findUnique: jest.fn().mockResolvedValue(null) },
    maintMachineFile: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const withUserRls = jest.fn(
    (_e: string, f: (t: unknown) => Promise<unknown>) => f(sy15Tx),
  );
  const runIdempotentRls = jest.fn(
    async (
      _e: string,
      _c: string,
      _a: string,
      f: (t: unknown) => Promise<unknown>,
    ) => ({
      result: await f(sy15Tx),
      idempotent: false,
    }),
  );
  const svc = new OdrzavanjeService(
    { withUserRls, runIdempotentRls } as unknown as Sy15Service,
    storage as unknown as Sy15StorageService,
    {
      notifyOtpis: jest.fn().mockResolvedValue(undefined),
    } as unknown as MasinaOtpisNotifyService,
    undefined,
    undefined,
    prisma,
    new OdrzavanjeSourceService(),
    new IdempotencyService(prisma),
    authz,
    fn,
    most as unknown as OdrzavanjeLokacijeMostService,
  );
  return { svc, db, fn, most, sy15Tx, withUserRls, runIdempotentRls, storage };
}

const izvorniIzvor = process.env.ODRZAVANJE_IZVOR;
afterEach(() => {
  if (izvorniIzvor === undefined) delete process.env.ODRZAVANJE_IZVOR;
  else process.env.ODRZAVANJE_IZVOR = izvorniIzvor;
});

/* ══════════════════════ (a) Nijedan upis ne zaobilazi OdrzavanjeFnService ══════════════════════ */

describe("(a) svaki upisni put zove svoju `OdrzavanjeFnService` metodu — i to SA `tx`", () => {
  /**
   * 🔴 Prvi argument SVAKE `fn` metode je transakcioni klijent. Ovde se poredi
   * IDENTITET sa lažnom bazom (koja u testu glumi i klijent i `tx`), pa
   * `undefined` ili „neki drugi klijent" pada — a baš to je razlika između
   * „jedan potez" i „dva nezavisna upisa".
   */
  function saTx(spy: jest.SpyInstance, db: LaznaBaza): void {
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls[0][0]).toBe(db);
    expect(spy.mock.calls[0][0]).not.toBeUndefined();
  }

  it("createMachine → machineEnsureAsset (BEFORE INSERT; `asset_id` je NOT NULL)", async () => {
    const s = napravi("3.0");
    const spy = jest.spyOn(s.fn, "machineEnsureAsset");
    await s.svc.createMachine(SEF_MEJL, {
      clientEventId: CID(),
      machineCode: "9.1",
      name: "Nova presa",
    });
    saTx(spy, s.db);
    expect(
      s.db.tabele.maintMachine.find((m) => m.machineCode === "9.1")?.assetId,
    ).toBeDefined();
  });

  it("renameMachine / otpisMachine / restoreMachine → machineRename (3 mesta)", async () => {
    for (const potez of ["rename", "otpis", "restore"] as const) {
      const s = napravi("3.0");
      if (potez === "restore") {
        s.db.tabele.maintMachine[0].machineCode = "3.12#ARH-20260730";
        s.db.tabele.maintMachine[0].archivedAt = new Date();
      }
      const spy = jest.spyOn(s.fn, "machineRename");
      if (potez === "rename")
        await s.svc.renameMachine(SEF_MEJL, "3.12", "3.13");
      if (potez === "otpis")
        await s.svc.otpisMachine(SEF_MEJL, "3.12", "rashodovana");
      if (potez === "restore")
        await s.svc.restoreMachine(SEF_MEJL, "3.12#ARH-20260730");
      saTx(spy, s.db);
    }
  });

  it("deleteMachineHard → machineDeleteHard (gejt, razlog ≥5 i trag su unutra)", async () => {
    const s = napravi("3.0");
    const spy = jest.spyOn(s.fn, "machineDeleteHard");
    await s.svc.deleteMachineHard(SEF_MEJL, "3.12", "duplikat u katalogu");
    saTx(spy, s.db);
    // Mejl je 4. argument — trag brisanja mora da preživi i gašenje naloga.
    expect(spy.mock.calls[0][2]).toBe(SEF_MEJL);
  });

  it("importMachines → importFromCacheNijePreneto (GLASNO pada, ne 'uvezeno 0')", async () => {
    const s = napravi("3.0");
    const spy = jest.spyOn(s.fn, "importFromCacheNijePreneto");
    await expect(
      s.svc.importMachines(SEF_MEJL, ["3.12"]),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(spy).toHaveBeenCalled();
  });

  it("createPreventiveWorkOrder → createPreventiveWorkOrder (anti-duplikat je unutra)", async () => {
    const s = napravi("3.0");
    s.db.tabele.maintTask.push({
      id: "t-1",
      machineCode: "3.12",
      title: "Podmazivanje",
      instructions: "Po uputstvu",
      active: true,
      assetId: null,
    });
    const spy = jest.spyOn(s.fn, "createPreventiveWorkOrder");
    await s.svc.createPreventiveWorkOrder(SEF_MEJL, "t-1");
    saTx(spy, s.db);
  });

  it("🔴 reportIncident → sva ČETIRI trigera nad `maint_incidents`, redom", async () => {
    const s = napravi("3.0");
    const setFields = jest.spyOn(s.fn, "incidentSetAssetFields");
    const log = jest.spyOn(s.fn, "incidentLogChanges");
    const autoWo = jest.spyOn(s.fn, "incidentAutocreateWorkOrder");
    const notify = jest.spyOn(s.fn, "incidentEnqueueNotify");

    await s.svc.reportIncident(OPERATER_MEJL, {
      clientEventId: CID(),
      machineCode: "3.12",
      title: "Curi ulje",
      severity: "critical",
    });

    for (const spy of [setFields, log, autoWo, notify]) saTx(spy, s.db);
    expect(log.mock.calls[0][1].op).toBe("INSERT");
  });

  it("updateIncident → incidentLogChanges (AFTER UPDATE; status/dodela u trag)", async () => {
    const s = napravi("3.0");
    s.db.tabele.maintIncident.push({
      id: "i-1",
      machineCode: "3.12",
      assetId: "a-312",
      status: "open",
      assignedTo: null,
      reportedBy: 2,
      severity: "major",
    });
    const spy = jest.spyOn(s.fn, "incidentLogChanges");
    await s.svc.updateIncident(SEF_MEJL, "i-1", { status: "in_progress" });
    saTx(spy, s.db);
    expect(spy.mock.calls[0][1].op).toBe("UPDATE");
  });

  it("attachIncidentFiles → attachIncidentFiles (pravilo 'samo prijavilac' je unutra)", async () => {
    const s = napravi("3.0");
    s.db.tabele.maintIncident.push({
      id: "i-2",
      machineCode: "3.12",
      reportedBy: 2,
      attachmentUrls: [],
    });
    const spy = jest.spyOn(s.fn, "attachIncidentFiles");
    await s.svc.attachIncidentFiles(OPERATER_MEJL, "i-2", [
      {
        originalname: "kvar.png",
        mimetype: "image/png",
        buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      } as Express.Multer.File,
    ]);
    saTx(spy, s.db);
  });

  it("🔴 updateWorkOrder → woLogFieldChanges + oba `service_plan_completion`", async () => {
    const s = napravi("3.0");
    s.db.tabele.maintWorkOrder.push({
      woId: "w-1",
      assetId: "a-312",
      assetType: "machine",
      status: "novi",
      priority: "p3_manje",
      assignedTo: null,
      reportedBy: 1,
      startedAt: null,
      completedAt: null,
      servicePlanId: null,
      assetServicePlanId: null,
      odometerKmAtService: null,
    });
    const log = jest.spyOn(s.fn, "woLogFieldChanges");
    const vozilo = jest.spyOn(s.fn, "woVehicleServicePlanCompletion");
    const sredstvo = jest.spyOn(s.fn, "woAssetServicePlanCompletion");
    await s.svc.updateWorkOrder(SEF_MEJL, "w-1", { status: "u_radu" });
    for (const spy of [log, vozilo, sredstvo]) saTx(spy, s.db);
  });

  it("🔴 createWoPart → applyPartStockMovement (`current_stock` NEMA trigger u 3.0)", async () => {
    const s = napravi("3.0");
    s.db.tabele.maintWorkOrder.push({
      woId: "w-2",
      assetId: "a-312",
      assetType: "machine",
      status: "u_radu",
      priority: "p3_manje",
      assignedTo: null,
      reportedBy: 1,
      woNumber: "WO-2026-00007",
    });
    s.db.tabele.maintPart.push({
      partId: "p-1",
      partCode: "L-10",
      name: "Ležaj 10",
      unit: "kom",
      unitCost: 500,
      currentStock: 8,
    });
    const spy = jest.spyOn(s.fn, "applyPartStockMovement");
    await s.svc.createWoPart(SEF_MEJL, "w-2", {
      clientEventId: CID(),
      partName: "Ležaj 10",
      partId: "p-1",
      quantity: 3,
    });
    saTx(spy, s.db);
  });
});

/* ══════════════════════ (b) Ponašajne probe — posledica, ne samo poziv ══════════════════════ */

describe("(b) ponašajne probe: posledica u bazi, ne samo da je metoda pozvana", () => {
  it("🔴 `critical` kvar pravi auto-nalog sa rokom 8 h I red u `maint_notification_log`", async () => {
    const s = napravi("3.0");
    const pre = Date.now();
    await s.svc.reportIncident(OPERATER_MEJL, {
      clientEventId: CID(),
      machineCode: "3.12",
      title: "Zaustavljena presa",
      severity: "critical",
    });

    const nalozi = s.db.tabele.maintWorkOrder;
    expect(nalozi).toHaveLength(1);
    expect(nalozi[0].type).toBe("incident");
    expect(nalozi[0].priority).toBe("p1_zastoj");
    expect(nalozi[0].status).toBe("potvrden");
    // 8 h je `criticalWoDueHours` iz fallback podešavanja (`maint_settings` prazna).
    const sati = (nalozi[0].dueAt.getTime() - pre) / 3_600_000;
    expect(sati).toBeGreaterThan(7.9);
    expect(sati).toBeLessThan(8.1);
    // Povratna veza incident → nalog (izvor je piše u istoj funkciji).
    expect(s.db.tabele.maintIncident[0].workOrderId).toBe(nalozi[0].woId);
    // Bez ijednog pravila i dalje JEDAN `in_app` red — inače kvar prođe nemo.
    expect(s.db.tabele.maintNotificationLog).toHaveLength(1);
    expect(s.db.tabele.maintNotificationLog[0].channel).toBe("in_app");
    expect(s.db.tabele.maintNotificationLog[0].relatedEntityId).toBe(
      s.db.tabele.maintIncident[0].id,
    );
    // Trag prijave: TAČNO jedan `created` red (ne i `status_change`).
    expect(s.db.tabele.maintIncidentEvent.map((e) => e.eventType)).toEqual([
      "created",
    ]);
  });

  it("`minor` kvar NE pravi ni nalog ni obaveštenje (tihi izlazi se čuvaju)", async () => {
    const s = napravi("3.0");
    await s.svc.reportIncident(OPERATER_MEJL, {
      clientEventId: CID(),
      machineCode: "3.12",
      title: "Škripi",
      severity: "minor",
    });
    expect(s.db.tabele.maintWorkOrder).toHaveLength(0);
    expect(s.db.tabele.maintNotificationLog).toHaveLength(0);
  });

  it("🔴 izmena statusa naloga upisuje red u `maint_wo_events`", async () => {
    const s = napravi("3.0");
    s.db.tabele.maintWorkOrder.push({
      woId: "w-3",
      assetId: "a-312",
      assetType: "machine",
      status: "novi",
      priority: "p3_manje",
      assignedTo: null,
      reportedBy: 1,
      startedAt: null,
      completedAt: null,
      servicePlanId: null,
      assetServicePlanId: null,
    });
    await s.svc.updateWorkOrder(SEF_MEJL, "w-3", {
      status: "u_radu",
      priority: "p1_zastoj",
    });
    const tragovi = s.db.tabele.maintWoEvent;
    expect(tragovi.map((e) => e.eventType).sort()).toEqual([
      "priority_change",
      "status_change",
    ]);
    const st = tragovi.find((e) => e.eventType === "status_change")!;
    expect([st.fromValue, st.toValue]).toEqual(["novi", "u_radu"]);
    // Pečat početka rada (1.0 ga je stavljao KLIJENT).
    expect(s.db.tabele.maintWorkOrder[0].startedAt).toBeInstanceOf(Date);
  });

  it("🔴 machineRename menja šifru u `maint_machines` I NE dira `loc_locations`", async () => {
    const s = napravi("3.0");
    await s.svc.renameMachine(SEF_MEJL, "3.12", "3.13");
    expect(s.db.tabele.maintMachine.map((m) => m.machineCode)).toEqual([
      "3.13",
    ]);
    // Sredstvo prati mašinu (bez toga bi izgubila naloge i dokumenta).
    expect(s.db.tabele.maintAsset[0].assetCode).toBe("3.13");
    // 🔴 Lokacije se pri preimenovanju NE diraju (skriveno pravilo §2.5.14).
    expect(s.most.syncMachineToLoc).not.toHaveBeenCalled();
  });

  it("🔴 machineDeleteHard upisuje red u `maint_machines_deletion_log`", async () => {
    const s = napravi("3.0");
    s.db.tabele.maintMachineNote.push({
      id: "n-1",
      machineCode: "3.12",
      author: 1,
      content: "x",
    });
    await s.svc.deleteMachineHard(SEF_MEJL, "3.12", "duplikat u katalogu");
    const log = s.db.tabele.maintMachineDeletionLog;
    expect(log).toHaveLength(1);
    expect(log[0].machineCode).toBe("3.12");
    expect(log[0].reason).toBe("duplikat u katalogu");
    expect(log[0].deletedByEmail).toBe(SEF_MEJL);
    expect(log[0].relatedCounts.notes).toBe(1);
    // Mašina i njena deca su otišli, trag je ostao.
    expect(s.db.tabele.maintMachine).toHaveLength(0);
    expect(s.db.tabele.maintMachineNote).toHaveLength(0);
  });

  it("createWoPart skida zalihu (`current_stock -= qty`) i piše `user_note`", async () => {
    const s = napravi("3.0");
    s.db.tabele.maintWorkOrder.push({
      woId: "w-4",
      assetId: "a-312",
      assetType: "machine",
      status: "u_radu",
      priority: "p3_manje",
      assignedTo: null,
      reportedBy: 1,
      woNumber: "WO-2026-00009",
    });
    s.db.tabele.maintPart.push({
      partId: "p-2",
      name: "Ležaj 20",
      unit: "kom",
      unitCost: 500,
      currentStock: 8,
    });
    await s.svc.createWoPart(SEF_MEJL, "w-4", {
      clientEventId: CID(),
      partName: "pogrešno ime iz FE",
      partId: "p-2",
      quantity: 3,
    });
    expect(Number(s.db.tabele.maintPart[0].currentStock)).toBe(5);
    expect(s.db.tabele.maintPartStockMovement[0].movementType).toBe("out");
    // Katalog je autoritativan za naziv i cenu, ne DTO.
    expect(s.db.tabele.maintWoPart[0].partName).toBe("Ležaj 20");
    expect(s.db.tabele.maintWoEvent[0].eventType).toBe("user_note");
  });

  it("otpis mašine oslobađa šifru (`#ARH-`) i gasi ogledalo u `maint_assets`", async () => {
    const s = napravi("3.0");
    const out = await s.svc.otpisMachine(SEF_MEJL, "3.12", "rashodovana");
    expect(out.data.machineCode).toMatch(/^3\.12#ARH-\d{8}$/);
    expect(s.db.tabele.maintAsset[0].active).toBe(false);
    expect(s.db.tabele.maintAsset[0].archiveReason).toBe("rashodovana");
    expect(s.db.tabele.maintAsset[0].archivedBy).toBe(1);
  });
});

/* ══════════════════════ (c) Most ka loc_locations — POSLE commit-a ══════════════════════ */

describe("(c) most ka `loc_locations` (druga baza) ide TEK POSLE commit-a", () => {
  it("🔴 createMachine: `MOST` je u tragu POSLE `COMMIT`, nikad unutar transakcije", async () => {
    const s = napravi("3.0");
    await s.svc.createMachine(SEF_MEJL, {
      clientEventId: CID(),
      machineCode: "9.2",
      name: "Nova presa",
    });
    expect(s.db.trag.indexOf("MOST")).toBeGreaterThan(
      s.db.trag.indexOf("COMMIT"),
    );
    expect(s.most.syncMachineToLoc.mock.calls[0][1]).toBe("INSERT");
  });

  it("updateMachine šalje `UPDATE` sa stanjem posle izmene", async () => {
    const s = napravi("3.0");
    await s.svc.updateMachine(SEF_MEJL, "3.12", { name: "Presa 3.12 (nova)" });
    const [m, op] = s.most.syncMachineToLoc.mock.calls[0];
    expect(op).toBe("UPDATE");
    expect(m).toMatchObject({ machineCode: "3.12", name: "Presa 3.12 (nova)" });
  });

  it("🔴 otpis šalje IZVORNU šifru — u lokacijama red i dalje stoji pod njom", async () => {
    const s = napravi("3.0");
    await s.svc.otpisMachine(SEF_MEJL, "3.12", "rashodovana");
    const [m] = s.most.syncMachineToLoc.mock.calls[0];
    expect(m.machineCode).toBe("3.12");
    expect(m.tracked).toBe(false);
    expect(m.archivedAt).toBeInstanceOf(Date);
  });
});

/* ══════════════════════ (d) Gejtovi ══════════════════════ */

describe("(d) gejtovi — jedina brana kad RLS-a više nema", () => {
  it("operater NE sme u katalog mašina (`maint_machines_insert`: erp_admin ∨ chief/admin)", async () => {
    const s = napravi("3.0");
    await expect(
      s.svc.createMachine(OPERATER_MEJL, {
        clientEventId: CID(),
        machineCode: "9.3",
        name: "Nova",
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(s.db.tabele.maintMachine).toHaveLength(1); // ništa nije upisano
  });

  it("operater SME da prijavi kvar — prijava je NAMERNO opšte pravo (§2.5.4)", async () => {
    const s = napravi("3.0");
    await s.svc.reportIncident(OPERATER_MEJL, {
      clientEventId: CID(),
      machineCode: "3.12",
      title: "Curi ulje",
      severity: "minor",
    });
    expect(s.db.tabele.maintIncident).toHaveLength(1);
    expect(s.db.tabele.maintIncident[0].reportedBy).toBe(2);
  });

  it("operater NE sme da menja tuđi kvar (`maint_incidents_update` = tehničar naviše)", async () => {
    const s = napravi("3.0");
    s.db.tabele.maintIncident.push({
      id: "i-3",
      machineCode: "3.12",
      assetId: "a-312",
      status: "open",
      assignedTo: null,
      reportedBy: 2,
      severity: "major",
    });
    await expect(
      s.svc.updateIncident(OPERATER_MEJL, "i-3", { status: "resolved" }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("🔴 pravilo '24 sata': autor-operater menja svoju napomenu, ali ne posle 24 h", async () => {
    const s = napravi("3.0");
    s.db.tabele.maintMachineNote.push(
      {
        id: "n-sveza",
        machineCode: "3.12",
        author: 2,
        content: "sveza",
        createdAt: new Date(Date.now() - 3_600_000),
      },
      {
        id: "n-stara",
        machineCode: "3.12",
        author: 2,
        content: "stara",
        createdAt: new Date(Date.now() - 30 * 3_600_000),
      },
    );
    await s.svc.updateNote(OPERATER_MEJL, "n-sveza", {
      content: "ispravljeno",
    });
    expect(s.db.tabele.maintMachineNote[0].content).toBe("ispravljeno");
    await expect(
      s.svc.updateNote(OPERATER_MEJL, "n-stara", { content: "kasno" }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(s.db.tabele.maintMachineNote[1].content).toBe("stara");
  });

  it("🔴 operater NE otvara nalog nad mašinom koja mu NIJE dodeljena (`maint_asset_visible`)", async () => {
    const s = napravi("3.0");
    // Druga mašina — operater ima dodeljenu samo `3.12`.
    s.db.tabele.maintAsset.push({
      assetId: "a-81",
      assetCode: "8.1",
      assetType: "machine",
      name: "Strug 8.1",
      active: true,
      archivedAt: null,
    });
    s.db.tabele.maintMachine.push({
      machineCode: "8.1",
      name: "Strug 8.1",
      assetId: "a-81",
      tracked: true,
      archivedAt: null,
    });
    await expect(
      s.svc.createWorkOrder(OPERATER_MEJL, {
        clientEventId: CID(),
        type: "kvar",
        assetId: "a-81",
        assetType: "machine",
        title: "Ne radi",
        priority: "p2_smetnja",
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(s.db.tabele.maintWorkOrder).toHaveLength(0);

    // …ali nad SVOJOM mašinom sme (`maint_wo_insert` pušta i operatera).
    await s.svc.createWorkOrder(OPERATER_MEJL, {
      clientEventId: CID(),
      type: "kvar",
      assetId: "a-312",
      assetType: "machine",
      title: "Ne radi",
      priority: "p2_smetnja",
    });
    expect(s.db.tabele.maintWorkOrder).toHaveLength(1);
    expect(s.db.tabele.maintWorkOrder[0].reportedBy).toBe(2);
  });

  it("🔴 deca naloga (part/labor/event) traže tehničara naviše — operater ne prolazi ni na SVOM nalogu", async () => {
    const s = napravi("3.0");
    // Nalog koji je operater SAM prijavio: `maint_wo_row_visible` ga pušta
    // („moj nalog je uvek moj"), ali CHECK na deci traži i rolu — dva različita
    // uslova koja se lako spoje u jedan i time tiho otvore upis.
    s.db.tabele.maintWorkOrder.push({
      woId: "w-moj",
      assetId: "a-312",
      assetType: "machine",
      status: "u_radu",
      priority: "p3_manje",
      assignedTo: null,
      reportedBy: 2,
      woNumber: "WO-2026-00011",
    });
    s.db.tabele.maintPart.push({
      partId: "p-9",
      name: "Ležaj 9",
      unit: "kom",
      unitCost: 100,
      currentStock: 5,
    });
    await expect(
      s.svc.createWoPart(OPERATER_MEJL, "w-moj", {
        clientEventId: CID(),
        partName: "Ležaj 9",
        partId: "p-9",
        quantity: 2,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      s.svc.createWoLabor(OPERATER_MEJL, "w-moj", {
        clientEventId: CID(),
        minutes: 30,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      s.svc.createWoEvent(OPERATER_MEJL, "w-moj", {
        clientEventId: CID(),
        eventType: "user_note",
        comment: "gotovo",
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    // Ništa nije upisano — ni deo, ni ledger, ni zaliha.
    expect(s.db.tabele.maintWoPart).toHaveLength(0);
    expect(s.db.tabele.maintWoLabor).toHaveLength(0);
    expect(s.db.tabele.maintWoEvent).toHaveLength(0);
    expect(s.db.tabele.maintPartStockMovement).toHaveLength(0);
    expect(Number(s.db.tabele.maintPart[0].currentStock)).toBe(5);
  });

  it("otpisano sredstvo ne prima NOVE naloge (zahtev 037/26), ni kroz deep-link", async () => {
    const s = napravi("3.0");
    s.db.tabele.maintAsset[0].archivedAt = new Date();
    await expect(
      s.svc.createWorkOrder(SEF_MEJL, {
        clientEventId: CID(),
        type: "kvar",
        assetId: "a-312",
        assetType: "machine",
        title: "Ne radi",
        priority: "p2_smetnja",
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it("bez ubrizganog 3.0 sloja putanja pada sa 503 — nikad tih upis u sy15", async () => {
    process.env.ODRZAVANJE_IZVOR = "3.0";
    const db = new LaznaBaza();
    seed(db);
    const runIdempotentRls = jest.fn();
    const withUserRls = jest.fn();
    const svc = new OdrzavanjeService(
      { withUserRls, runIdempotentRls } as unknown as Sy15Service,
      {} as unknown as Sy15StorageService,
      { notifyOtpis: jest.fn() } as unknown as MasinaOtpisNotifyService,
      undefined,
      undefined,
      db as unknown as PrismaService,
      new OdrzavanjeSourceService(),
      new IdempotencyService(db as unknown as PrismaService),
      // authz/fn/most NAMERNO izostavljeni
    );
    await expect(
      svc.createMachine(SEF_MEJL, {
        clientEventId: CID(),
        machineCode: "9.4",
        name: "Nova",
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(runIdempotentRls).not.toHaveBeenCalled();
    expect(withUserRls).not.toHaveBeenCalled();
  });
});

/* ══════════════════════ (h) PREVOD IDENTITETA sy15 -> 3.0 ══════════════════════ */

/**
 * 🔴 ŠTA OVA GRUPA ČUVA
 *
 * `responsibleUserId` i `assignedTo` su u DTO-u `@IsUUID()` — to je sy15
 * `auth.users.id`. U 3.0 je ista kolona `Int` (`users.id`). Do migracije
 * `20260808100000_users_sy15_user_id_prevod_identiteta` 3.0 `users` NIJE imao
 * nijednu kolonu sa sy15 uuid-om, pa je prevod bio NEMOGUĆ i modul je pod
 * `ODRZAVANJE_IZVOR=3.0` padao sa 422 na 5 mesta — tj. dodela naloga čoveku i
 * postavljanje odgovornog za mašinu NISU RADILI.
 *
 * Sada prevod postoji (`users.sy15_user_id`), ali ima tačno dva ishoda i oba se
 * ovde pinuju:
 *
 *  1. **Ima parnjaka → TAČAN `users.id`.** Ne „neki broj": seed je namešten tako
 *     da prevodilac koji ignoriše kolonu i uzme prvi red vrati 1 umesto 2. Test
 *     koji tvrdi samo „nije null" tu grešku ne bi video.
 *  2. **Nema parnjaka → GLASAN pad, sa imenovanim uuid-om.** `null` bi prošao
 *     kroz Prisma sloj bez ijedne greške i upisao red sa PRAZNOM dodelom: nalog
 *     sačuvan, čovek nestao. Zato se uz izuzetak tvrdi i da je red NETAKNUT.
 *
 * Nepromenjeno ponašanje (takođe pinovano): broj prolazi kao broj, izostavljeno
 * polje se ne dira, a pod `sy15` se prevodilac NE ZOVE uopšte.
 */
describe("(h) prevod identiteta: sy15 uuid -> 3.0 `users.id`", () => {
  /** Radni nalog bez dodele — polazna tačka za sve tvrdnje o `assignedTo`. */
  function saNalogom(s: Sklop): void {
    s.db.tabele.maintWorkOrder.push({
      woId: "w-5",
      assetId: "a-312",
      assetType: "machine",
      status: "novi",
      priority: "p3_manje",
      assignedTo: null,
      reportedBy: 1,
      startedAt: null,
      completedAt: null,
      servicePlanId: null,
      assetServicePlanId: null,
    });
  }

  it("🔴 `assignedTo` = uuid SA parnjakom → TAČAN `users.id` (2, ne prvi nalog)", async () => {
    const s = napravi("3.0");
    saNalogom(s);
    await s.svc.updateWorkOrder(SEF_MEJL, "w-5", {
      assignedTo: UUID_OPERATER,
    });
    // 🔴 Baš 2. Prevodilac koji vrati „prvi red iz `users`" dao bi 1 i prošao
    // svaki test koji samo pita „je li dodeljeno".
    expect(s.db.tabele.maintWorkOrder[0].assignedTo).toBe(2);
  });

  it("🔴 `assignedTo` = uuid BEZ parnjaka → pad sa IMENOVANIM uuid-om, red netaknut", async () => {
    const s = napravi("3.0");
    saNalogom(s);
    const poziv = s.svc.updateWorkOrder(SEF_MEJL, "w-5", {
      assignedTo: UUID_BEZ_PARNJAKA,
    });
    await expect(poziv).rejects.toBeInstanceOf(UnprocessableEntityException);
    // Poruka mora da imenuje uuid — bez toga se na produkciji ne zna KOJI nalog
    // treba povezati, pa 422 postaje neupotrebljiv.
    await expect(poziv).rejects.toThrow(UUID_BEZ_PARNJAKA);
    // 🔴 Dodela NIJE tiho ispražnjena.
    expect(s.db.tabele.maintWorkOrder[0].assignedTo).toBeNull();
  });

  it("🔴 numerička vrednost prolazi kao danas (bez upita u `users`)", async () => {
    const s = napravi("3.0");
    saNalogom(s);
    await s.svc.updateWorkOrder(SEF_MEJL, "w-5", { assignedTo: "2" });
    expect(s.db.tabele.maintWorkOrder[0].assignedTo).toBe(2);
  });

  it("izostavljen `assignedTo` (`undefined`) prolazi netaknut — dodela se ne dira", async () => {
    const s = napravi("3.0");
    saNalogom(s);
    s.db.tabele.maintWorkOrder[0].assignedTo = 2;
    await s.svc.updateWorkOrder(SEF_MEJL, "w-5", { status: "u_radu" });
    expect(s.db.tabele.maintWorkOrder[0].assignedTo).toBe(2);
    expect(s.db.tabele.maintWorkOrder[0].status).toBe("u_radu");
  });

  it("🔴 `createMachine`: uuid odgovornog stiže PREVEDEN i u mašinu I u `maint_assets` ogledalo", async () => {
    const s = napravi("3.0");
    await s.svc.createMachine(SEF_MEJL, {
      clientEventId: CID(),
      machineCode: "9.7",
      name: "Presa 9.7",
      responsibleUserId: UUID_OPERATER,
    });
    const m = s.db.tabele.maintMachine.find((x) => x.machineCode === "9.7");
    expect(m?.responsibleUserId).toBe(2);
    // Ogledalo u `maint_assets` mora dobiti ISTU vrednost — dva prevoda koja se
    // raziđu bila bi nevidljiva u UI-u, a vidljiva tek u izveštajima.
    const a = s.db.tabele.maintAsset.find((x) => x.assetId === m?.assetId);
    expect(a?.responsibleUserId).toBe(2);
  });

  it("🔴 `createMachine` sa uuid-om BEZ parnjaka ne ostavlja ni mašinu ni sredstvo", async () => {
    const s = napravi("3.0");
    const preAssets = s.db.tabele.maintAsset.length;
    await expect(
      s.svc.createMachine(SEF_MEJL, {
        clientEventId: CID(),
        machineCode: "9.8",
        name: "Presa 9.8",
        responsibleUserId: UUID_BEZ_PARNJAKA,
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(
      s.db.tabele.maintMachine.find((x) => x.machineCode === "9.8"),
    ).toBeUndefined();
    expect(s.db.tabele.maintAsset.length).toBe(preAssets);
  });

  it("`updateMachine`: uuid odgovornog → `users.id`; `null` i dalje raskida vezu", async () => {
    const s = napravi("3.0");
    await s.svc.updateMachine(SEF_MEJL, "3.12", {
      responsibleUserId: UUID_SEF,
    });
    expect(s.db.tabele.maintMachine[0].responsibleUserId).toBe(1);
    await s.svc.updateMachine(SEF_MEJL, "3.12", {
      responsibleUserId: null as unknown as string,
    });
    expect(s.db.tabele.maintMachine[0].responsibleUserId).toBeNull();
  });

  it("`updateIncident`: uuid dodeljenog → `users.id`", async () => {
    const s = napravi("3.0");
    s.db.tabele.maintIncident.push({
      id: "inc-9",
      machineCode: "3.12",
      assetId: "a-312",
      status: "prijavljen",
      severity: "minor",
      assignedTo: null,
      reportedBy: 2,
    });
    await s.svc.updateIncident(SEF_MEJL, "inc-9", {
      assignedTo: UUID_OPERATER,
    });
    expect(s.db.tabele.maintIncident[0].assignedTo).toBe(2);
  });

  it("vrednost koja nije ni broj ni uuid pada sa 422 (ne prolazi do baze)", async () => {
    const s = napravi("3.0");
    saNalogom(s);
    await expect(
      s.svc.updateWorkOrder(SEF_MEJL, "w-5", {
        assignedTo: "pera-peric",
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(s.db.tabele.maintWorkOrder[0].assignedTo).toBeNull();
  });

  it("🔴 pod `sy15` prevodilac se NE ZOVE — uuid ide u sy15 nepromenjen", async () => {
    const s = napravi("sy15");
    const prevod = jest.spyOn(
      s.svc as unknown as {
        id30: (...a: unknown[]) => Promise<unknown>;
      },
      "id30",
    );
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    s.sy15Tx.maintWorkOrder = {
      findUnique: jest
        .fn()
        .mockResolvedValue({ startedAt: null, completedAt: null }),
      updateMany,
    };
    await s.svc.updateWorkOrder(SEF_MEJL, "w-5", {
      assignedTo: UUID_OPERATER,
    });
    expect(prevod).not.toHaveBeenCalled();
    expect(s.withUserRls).toHaveBeenCalled();
    // 🔴 U sy15 se upisuje SIROV uuid — ponašanje produkcije je nepromenjeno.
    expect(updateMany.mock.calls[0][0].data.assignedTo).toBe(UUID_OPERATER);
  });
});

/* ══════════════ (f) Skladište: bajtovi se ne diraju pre gejta ══════════════ */

/**
 * 🔴 ZAŠTO OVA GRUPA BROJI POZIVE KA SKLADIŠTU, A NE ISHOD RUTE:
 *
 * `Sy15StorageService.remove` ide servisnim ključem — zaobilazi prava bucketa i
 * briše STVARNO. Ruta `DELETE /maintenance/machines/:code` na kraju svakako
 * vrati 403 uskoj roli, pa test koji gleda samo izuzetak prolazi i onda kad su
 * bajtovi već otišli. Pod sy15 je tu stajao RLS `mmf_select`
 * (`maint_machine_visible`) i vraćao 0 redova; pod 3.0 RLS-a nema. Zato se
 * ovde tvrdi `storage.remove` = 0 POZIVA, i to i za mašinu koju rola VIDI
 * (samo scope bez gejta ne bi bio dovoljan — gejt mora biti PRE bajtova).
 */
describe("(f) trajno brisanje mašine ne dira bajtove pre gejta", () => {
  /** Druga mašina (`8.1`, nije dodeljena operateru) + fajlovi obe mašine. */
  function saFajlovima(s: Sklop): void {
    s.db.tabele.maintAsset.push({
      assetId: "a-81",
      assetCode: "8.1",
      assetType: "machine",
      name: "Strug 8.1",
      active: true,
      archivedAt: null,
    });
    s.db.tabele.maintMachine.push({
      machineCode: "8.1",
      name: "Strug 8.1",
      assetId: "a-81",
      tracked: true,
      archivedAt: null,
    });
    s.db.tabele.maintMachineFile.push(
      {
        id: "f-1",
        machineCode: "8.1",
        storagePath: "8.1/uputstvo.pdf",
        uploadedBy: 1,
        deletedAt: null,
      },
      {
        id: "f-2",
        machineCode: "8.1",
        storagePath: "8.1/sema.png",
        uploadedBy: 1,
        deletedAt: null,
      },
      {
        id: "f-3",
        machineCode: "3.12",
        storagePath: "3.12/uputstvo.pdf",
        uploadedBy: 1,
        deletedAt: null,
      },
    );
  }

  it("🔴 operater ne obriše NIJEDAN bajt TUĐE mašine — 0 poziva ka skladištu, pa 403", async () => {
    const s = napravi("3.0");
    saFajlovima(s);
    await expect(
      s.svc.deleteMachineHard(OPERATER_MEJL, "8.1", "hocu da probam"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(s.storage.remove).not.toHaveBeenCalled();
    // Ni meta-redovi ni mašina nisu dirnuti — odbijeno pre svakog poteza.
    expect(s.db.tabele.maintMachineFile).toHaveLength(3);
    expect(s.db.tabele.maintMachine.map((m) => m.machineCode).sort()).toEqual([
      "3.12",
      "8.1",
    ]);
    expect(s.db.tabele.maintMachineDeletionLog).toHaveLength(0);
  });

  it("🔴 ni bajtove SVOJE, dodeljene mašine — gejt je PRE bajtova, ne posle", async () => {
    const s = napravi("3.0");
    saFajlovima(s);
    // `3.12` JESTE vidljiva operateru (`maint_machine_visible` = true), pa sam
    // scope ovde ne bi zaustavio brisanje — zaustavlja ga jedino gejt.
    await expect(
      s.svc.deleteMachineHard(OPERATER_MEJL, "3.12", "hocu da probam"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(s.storage.remove).not.toHaveBeenCalled();
    expect(s.db.tabele.maintMachineFile).toHaveLength(3);
  });

  it("šef i dalje briše bajtove PRE RPC-a (paritet sa sy15 nije pokvaren)", async () => {
    const s = napravi("3.0");
    saFajlovima(s);
    await s.svc.deleteMachineHard(SEF_MEJL, "8.1", "duplikat u katalogu");
    expect(s.storage.remove.mock.calls.map((c) => c[1]).sort()).toEqual([
      "8.1/sema.png",
      "8.1/uputstvo.pdf",
    ]);
    // Fajl druge mašine ostaje i u bucketu i u meta tabeli.
    expect(s.db.tabele.maintMachineFile.map((f) => f.machineCode)).toEqual([
      "3.12",
    ]);
    expect(s.db.tabele.maintMachineDeletionLog).toHaveLength(1);
  });
});

/* ══════════ (g) Raspored bajtova i kod greške ostaju kao pod sy15 ══════════ */

describe("(g) sitna odstupanja 3.0 ↔ sy15 koja se lako previde", () => {
  /** Najmanji ispravan PNG po magic bytes (`assertAttachments` sudi po sadržaju). */
  const foto = () => [
    {
      originalname: "kvar.png",
      buffer: Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
      ]),
    } as unknown as Express.Multer.File,
  ];

  it("🔴 prijavilac koji svoj kvar NE VIDI: fotografije idu pod `incident/<id>/…`", async () => {
    const s = napravi("3.0");
    // Kvar na mašini koja operateru NIJE dodeljena — pod sy15 mu ga RLS krije
    // (F6), pa putanja pada na `incident/<id>`. Bez scope-a bi 3.0 vratio pravu
    // šifru i isti kvar bi u bucketu završio na DRUGOM mestu.
    s.db.tabele.maintIncident.push({
      id: "i-nevidljiv",
      machineCode: "8.1",
      assetId: null,
      status: "open",
      severity: "minor",
      reportedBy: 2,
      attachmentUrls: [],
    });
    await s.svc.attachIncidentFiles(OPERATER_MEJL, "i-nevidljiv", foto());
    expect(s.storage.upload.mock.calls[0][1]).toMatch(
      /^incident\/i-nevidljiv\/[0-9a-f]{12}_kvar\.png$/,
    );

    // Kontrola: svoj kvar na SVOJOJ mašini vidi — putanja je 1.0-kompatibilna.
    s.db.tabele.maintIncident.push({
      id: "i-vidljiv",
      machineCode: "3.12",
      assetId: null,
      status: "open",
      severity: "minor",
      reportedBy: 2,
      attachmentUrls: [],
    });
    await s.svc.attachIncidentFiles(OPERATER_MEJL, "i-vidljiv", foto());
    expect(s.storage.upload.mock.calls[1][1]).toMatch(/^3\.12\//);
  });

  it("nepostojeći `assetId` je 422 (nema sredstva), ne 403 (nemaš pravo)", async () => {
    const s = napravi("3.0");
    await expect(
      s.svc.createWorkOrder(SEF_MEJL, {
        clientEventId: CID(),
        type: "kvar",
        assetId: "00000000-0000-4000-8000-000000000000",
        assetType: "machine",
        title: "Ne radi",
        priority: "p2_smetnja",
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(s.db.tabele.maintWorkOrder).toHaveLength(0);
  });
});

/* ══════════════════════ (e) Pod sy15 se 3.0 sloj ne dodiruje ══════════════════════ */

describe("(e) pod `ODRZAVANJE_IZVOR=sy15` 3.0 sloj ostaje netaknut", () => {
  it("createMachine ide kroz sy15 registar; ni `fn`, ni most, ni 3.0 tabele", async () => {
    const s = napravi("sy15");
    const spy = jest.spyOn(s.fn, "machineEnsureAsset");
    await s.svc.createMachine(SEF_MEJL, {
      clientEventId: CID(),
      machineCode: "9.5",
      name: "Nova",
    });
    expect(s.runIdempotentRls).toHaveBeenCalledTimes(1);
    expect(s.runIdempotentRls.mock.calls[0][2]).toBe(
      "odrzavanje.create-machine",
    );
    expect(spy).not.toHaveBeenCalled();
    expect(s.most.syncMachineToLoc).not.toHaveBeenCalled();
    expect(s.db.tabele.maintMachine).toHaveLength(1); // samo seed
  });

  it("updateWorkOrder ide kroz `withUserRls`, a `woLogFieldChanges` se NE zove (piše ga DB triger)", async () => {
    const s = napravi("sy15");
    const spy = jest.spyOn(s.fn, "woLogFieldChanges");
    s.sy15Tx.maintWorkOrder = {
      findUnique: jest
        .fn()
        .mockResolvedValue({ startedAt: null, completedAt: null }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    };
    await s.svc.updateWorkOrder(SEF_MEJL, "w-9", { status: "u_radu" });
    expect(s.withUserRls).toHaveBeenCalledTimes(1);
    expect(spy).not.toHaveBeenCalled();
  });

  it("🔴 korak 1 hard-delete-a ostaje NEPROMENJEN: putanje iz RLS SELECT-a, bez 3.0 gejta", async () => {
    // Produkcija danas radi ovako (prekidač je `sy15`): brisanje bajtova sudi
    // RLS, ne aplikacija. Gejt uveden zbog 3.0 ne sme da se prelije ovamo —
    // inače bi popravka jedne grane tiho promenila ponašanje druge.
    const s = napravi("sy15");
    s.sy15Tx.maintMachineFile = {
      findMany: jest
        .fn()
        .mockResolvedValue([{ storagePath: "8.1/uputstvo.pdf" }]),
    };
    await s.svc.deleteMachineHard(OPERATER_MEJL, "8.1", "duplikat u katalogu");
    expect(s.storage.remove).toHaveBeenCalledWith(
      "maint-machine-files",
      "8.1/uputstvo.pdf",
    );
  });

  it("deleteMachineHard i dalje zove sy15 RPC, ne `machineDeleteHard`", async () => {
    const s = napravi("sy15");
    const spy = jest.spyOn(s.fn, "machineDeleteHard");
    await s.svc.deleteMachineHard(SEF_MEJL, "3.12", "duplikat u katalogu");
    expect(spy).not.toHaveBeenCalled();
    expect(s.sy15Tx.$queryRaw).toHaveBeenCalled();
    expect(s.db.tabele.maintMachineDeletionLog).toHaveLength(0);
  });
});
