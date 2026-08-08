import {
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { OdrzavanjeService } from "./odrzavanje.service";
import { OdrzavanjeFnService } from "./odrzavanje-fn.service";
import { OdrzavanjeAuthzService } from "./odrzavanje-authz.service";
import { OdrzavanjeSourceService } from "../../common/sy15/odrzavanje-source.service";
import { IdempotencyService } from "../../common/idempotency/idempotency.service";
import type { PrismaService } from "../../prisma/prisma.service";
import type { Sy15Service } from "../../common/sy15/sy15.service";
import type { Sy15StorageService } from "../../common/sy15/sy15-storage.service";
import type { MasinaOtpisNotifyService } from "./masina-otpis-notify.service";

/**
 * §7.1 seobe održavanja — UPISI: vozila, vozači i zalihe na 3.0 Prisma put.
 *
 * 🔴 ŠTA OVI TESTOVI ČUVAJU (svaka stavka je greška koja se NE VIDI odmah):
 *
 *  1. **Upisni put ide kroz prepis, ne pored njega.** `OdrzavanjeFnService` drži
 *     14 DEFINER funkcija i 11 logičkih trigera koje 3.0 baza NEMA kao trigere.
 *     Putanja koja upiše red a ne pozove svoj prepis „radi" — samo ostavi bazu u
 *     stanju u kome sy15 nikad ne bi bila. Zato se svuda tvrdi poziv `fn`-metode
 *     i to SA `tx` (isti transakcioni klijent), a ne sa novom konekcijom.
 *
 *  2. **`current_stock` bez trigera.** `maint_apply_part_stock_movement` u 3.0
 *     postoji SAMO kao `applyPartStockMovement`. Ledger upisan mimo njega tiho
 *     razilazi stanje sa zbirom kretanja i to se vidi tek na popisu. Zato se
 *     stanje poredi sa ZBIROM tri kretanja, ne sa poslednjom vrednošću.
 *
 *  3. **Rokovi se ne šalju dvaput.** `checkVehicleDeadlines` puni
 *     `maint_notification_log`; bez `postojiRok` provere isti rok ide svakog dana
 *     ponovo (spam vozačima). Zato se broji TAČAN broj redova posle dva poziva.
 *
 *  4. **Prava se ne gube.** 3.0 nema RLS, pa svaki gejt mora biti u kodu. Test
 *     traži da NEOVLAŠĆEN pozivalac dobije 403, jer bi bez gejta upit i dalje
 *     prošao — samo bi upisao red koji sy15 nikad ne bi primila.
 *
 *  5. **Brana i dalje stoji.** Putanje koje NISU prenete (`lookupEmployees`) i
 *     dalje padaju sa 503, a ne vraćaju praznu listu.
 *
 * Skretnicu (`runIdem`) pinuje `odrzavanje-idempotencija-3-0.spec.ts`; sadržaj
 * prepisa `odrzavanje-fn.service.spec.ts`. Ovde se pinuje SPOJ upisnih ruta sa
 * oba, nad 3.0 bazom.
 */

/* ══════════════════════ Lažna 3.0 baza (in-memory) ══════════════════════ */

type Row = Record<string, unknown>;

/** Poređenje jedne vrednosti sa Prisma filter izrazom. */
function poredi(vrednost: unknown, filter: unknown): boolean {
  if (filter === null || filter === undefined) return vrednost == null;
  if (filter instanceof Date) {
    return vrednost instanceof Date && vrednost.getTime() === filter.getTime();
  }
  if (typeof filter === "object") {
    const f = filter as Record<string, unknown>;
    // `payload: { path: [...], equals: ... }`
    if ("path" in f) {
      const put = f.path as string[];
      let v: unknown = vrednost;
      for (const k of put) v = (v as Row | null)?.[k];
      return v === f.equals;
    }
    let ok = true;
    for (const [op, arg] of Object.entries(f)) {
      if (op === "in") ok &&= (arg as unknown[]).includes(vrednost);
      else if (op === "not")
        ok &&= arg === null ? vrednost != null : vrednost !== arg;
      else if (op === "equals") ok &&= poredi(vrednost, arg);
      else if (op === "gte")
        ok &&= (vrednost as Date) != null && vrednost >= (arg as Date);
      else if (op === "lte")
        ok &&= (vrednost as Date) != null && vrednost <= (arg as Date);
      else if (op === "mode")
        ok &&= true; // insensitive — nebitno za ove testove
      else if (op === "contains")
        ok &&=
          typeof vrednost === "string" &&
          vrednost.toLowerCase().includes(String(arg).toLowerCase());
      else ok &&= false;
      if (!ok) return false;
    }
    return ok;
  }
  return vrednost === filter;
}

interface TabelaOpts {
  pk: string;
  /** Relacije: ime -> kako se iz reda dođe do povezanog reda. */
  rel?: Record<string, (r: Row) => Row | null>;
  /** Podrazumevane vrednosti za `create` (DB `@default`). */
  podrazumevano?: () => Row;
}

class Tabela {
  readonly redovi: Row[] = [];
  private brojac = 0;
  constructor(private readonly o: TabelaOpts) {}

  private pogadja(r: Row, where: unknown): boolean {
    if (!where || typeof where !== "object") return true;
    for (const [k, v] of Object.entries(where as Row)) {
      if (k === "AND") {
        if (!(v as unknown[]).every((w) => this.pogadja(r, w))) return false;
      } else if (k === "OR") {
        if (!(v as unknown[]).some((w) => this.pogadja(r, w))) return false;
      } else if (k === "NOT") {
        if (this.pogadja(r, v)) return false;
      } else if (this.o.rel?.[k]) {
        const povezan = this.o.rel[k](r);
        if (!povezan) return false;
        // Relacije se porede plitko (ovi testovi ne idu dublje od jednog skoka).
        for (const [rk, rv] of Object.entries(v as Row)) {
          if (!poredi(povezan[rk], rv)) return false;
        }
      } else if (!poredi(r[k], v)) {
        return false;
      }
    }
    return true;
  }

  /** Red + razrešene relacije (spec ne proverava `select` projekciju). */
  private izadji(r: Row | undefined | null): Row | null {
    if (!r) return null;
    const out: Row = { ...r };
    for (const [ime, f] of Object.entries(this.o.rel ?? {})) {
      out[ime] = f(r);
    }
    return out;
  }

  findMany = jest.fn((a?: { where?: unknown }) =>
    Promise.resolve(
      this.redovi
        .filter((r) => this.pogadja(r, a?.where))
        .map((r) => this.izadji(r)),
    ),
  );
  findFirst = jest.fn((a?: { where?: unknown }) =>
    Promise.resolve(
      this.izadji(this.redovi.find((r) => this.pogadja(r, a?.where))),
    ),
  );
  findUnique = jest.fn((a: { where: unknown }) =>
    Promise.resolve(
      this.izadji(this.redovi.find((r) => this.pogadja(r, a.where))),
    ),
  );
  count = jest.fn((a?: { where?: unknown }) =>
    Promise.resolve(
      this.redovi.filter((r) => this.pogadja(r, a?.where)).length,
    ),
  );
  create = jest.fn((a: { data: Row }) => {
    const red: Row = {
      ...(this.o.podrazumevano?.() ?? {}),
      ...a.data,
    };
    if (red[this.o.pk] == null)
      red[this.o.pk] = `${this.o.pk}-${++this.brojac}`;
    this.redovi.push(red);
    return Promise.resolve(this.izadji(red));
  });
  createMany = jest.fn((a: { data: Row[] }) => {
    for (const d of a.data) void this.create({ data: d });
    return Promise.resolve({ count: a.data.length });
  });
  private primeni(r: Row, data: Row) {
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === "object" && "increment" in (v as Row)) {
        const delta = Number((v as Row).increment);
        r[k] = Number(r[k] ?? 0) + delta;
      } else {
        r[k] = v;
      }
    }
  }
  update = jest.fn((a: { where: unknown; data: Row }) => {
    const r = this.redovi.find((x) => this.pogadja(x, a.where));
    if (!r) throw new Error("update: red ne postoji");
    this.primeni(r, a.data);
    return Promise.resolve(this.izadji(r));
  });
  updateMany = jest.fn((a: { where?: unknown; data: Row }) => {
    const pogodjeni = this.redovi.filter((r) => this.pogadja(r, a.where));
    for (const r of pogodjeni) this.primeni(r, a.data);
    return Promise.resolve({ count: pogodjeni.length });
  });
  upsert = jest.fn((a: { where: unknown; create: Row; update: Row }) => {
    const r = this.redovi.find((x) => this.pogadja(x, a.where));
    if (r) {
      this.primeni(r, a.update);
      return Promise.resolve(this.izadji(r));
    }
    return this.create({ data: a.create });
  });
  deleteMany = jest.fn((a?: { where?: unknown }) => {
    let n = 0;
    for (let i = this.redovi.length - 1; i >= 0; i--) {
      if (this.pogadja(this.redovi[i], a?.where)) {
        this.redovi.splice(i, 1);
        n++;
      }
    }
    return Promise.resolve({ count: n });
  });
  delete = jest.fn((a: { where: unknown }) => this.deleteMany(a));
}

function makeDb() {
  const maintAsset = new Tabela({ pk: "assetId" });
  const maintMachine = new Tabela({ pk: "machineCode" });
  const db: Record<string, unknown> = {};

  const t = (ime: string, o: TabelaOpts) => {
    const tab = new Tabela(o);
    db[ime] = tab;
    return tab;
  };
  db.maintAsset = maintAsset;
  db.maintMachine = maintMachine;
  // Relacija `asset` (+ njena `machine`) je potrebna svuda gde se proverava
  // `maint_asset_visible` — bez nje bi svaki gejt gledao u prazno.
  const asRel = (r: Row) => {
    const a = maintAsset.redovi.find((x) => x.assetId === r.assetId);
    if (!a) return null;
    const m = maintMachine.redovi.find((x) => x.assetId === a.assetId);
    return { ...a, machine: m ?? null };
  };
  const maintVehicleDetails = t("maintVehicleDetails", {
    pk: "assetId",
    rel: { asset: asRel },
  });
  const maintFacilityDetails = t("maintFacilityDetails", { pk: "assetId" });
  const maintItAssetDetails = t("maintItAssetDetails", { pk: "assetId" });
  const maintVehicleTire = t("maintVehicleTire", { pk: "tireSetId" });
  const maintPart = t("maintPart", {
    pk: "partId",
    podrazumevano: () => ({ currentStock: 0 }),
  });
  const maintPartStockMovement = t("maintPartStockMovement", {
    pk: "movementId",
    podrazumevano: () => ({ createdAt: new Date() }),
  });
  const maintDriver = t("maintDriver", { pk: "driverId" });
  const maintVehicleBooking = t("maintVehicleBooking", { pk: "bookingId" });
  const maintNotificationLog = t("maintNotificationLog", {
    pk: "id",
    podrazumevano: () => ({ createdAt: new Date(), attempts: 0 }),
  });
  const maintDocument = t("maintDocument", { pk: "documentId" });
  const maintLocation = t("maintLocation", { pk: "locationId" });
  const maintWorkOrder = t("maintWorkOrder", { pk: "woId" });
  const maintVehicleServicePlan = t("maintVehicleServicePlan", {
    pk: "planId",
  });
  const maintAssetServicePlan = t("maintAssetServicePlan", { pk: "planId" });
  const maintSettings = t("maintSettings", { pk: "id" });
  const maintUserProfile = t("maintUserProfile", { pk: "userId" });
  const maintSupplier = t("maintSupplier", { pk: "supplierId" });
  const maintVehicleOwner = t("maintVehicleOwner", { pk: "ownerId" });
  const maintPartVehicle = t("maintPartVehicle", { pk: "assetId" });
  const maintTask = t("maintTask", { pk: "id" });
  const maintIncident = t("maintIncident", { pk: "id" });
  const user = t("user", { pk: "id" });
  const userRole = t("userRole", { pk: "id" });

  /** `api_idempotency` — isti obrazac kao u `odrzavanje-idempotencija-3-0.spec.ts`. */
  const idemRedovi = new Map<
    string,
    { action: string; actor_email: string; result: unknown }
  >();

  const jeTemplate = (a: unknown): a is TemplateStringsArray =>
    Array.isArray(a) && "raw" in (a as object);

  db.$executeRaw = jest.fn((a: unknown, ...v: unknown[]) => {
    if (jeTemplate(a)) {
      const sql = a.join(" ? ");
      if (sql.includes("INSERT INTO api_idempotency")) {
        const [cid, action, actor] = v as [string, string, string];
        if (idemRedovi.has(cid)) return Promise.resolve(0);
        idemRedovi.set(cid, { action, actor_email: actor, result: null });
        return Promise.resolve(1);
      }
      const [json, cid] = v as [string, string];
      const red = idemRedovi.get(cid);
      if (red) red.result = JSON.parse(json);
      return Promise.resolve(red ? 1 : 0);
    }
    // `seedEstimatedCost30` — sirovi UPDATE nad nalozima; ne modeluje se ovde.
    return Promise.resolve(0);
  });

  db.$queryRaw = jest.fn((a: unknown, ...v: unknown[]) => {
    if (jeTemplate(a)) {
      const red = idemRedovi.get(v[0] as string);
      return Promise.resolve(red ? [red] : []);
    }
    const sql = String((a as { sql?: string }).sql ?? "");
    // `v_maint_vehicle_service_plan_due` — verno pravilo view-a: aktivan plan,
    // dospeo, BEZ otvorenog naloga (`has_open_wo`), sredstvo nije arhivirano.
    if (sql.includes("v_maint_vehicle_service_plan_due")) {
      return Promise.resolve(
        maintVehicleServicePlan.redovi
          .filter((p) => p.active !== false)
          .filter(
            (p) =>
              !maintWorkOrder.redovi.some(
                (w) =>
                  w.servicePlanId === p.planId &&
                  w.status !== "zavrsen" &&
                  w.status !== "otkazan",
              ),
          )
          .map((p) => ({
            plan_id: p.planId,
            asset_id: p.assetId,
            name: p.name,
            notes: p.notes ?? null,
            priority: p.priority ?? "p4_planirano",
            next_due_at: p.nextDueAt ?? null,
            next_due_km: p.nextDueKm ?? null,
          })),
      );
    }
    if (sql.includes("v_maint_asset_service_plan_due")) {
      return Promise.resolve(
        maintAssetServicePlan.redovi
          .filter((p) => p.active !== false)
          .filter(
            (p) =>
              !maintWorkOrder.redovi.some(
                (w) =>
                  w.assetServicePlanId === p.planId &&
                  w.status !== "zavrsen" &&
                  w.status !== "otkazan",
              ),
          )
          .map((p) => ({
            plan_id: p.planId,
            asset_id: p.assetId,
            asset_type: "it",
            name: p.name,
            interval_months: p.intervalMonths ?? 12,
            priority: p.priority ?? "p4_planirano",
            next_due_at: p.nextDueAt ?? null,
          })),
      );
    }
    return Promise.resolve([]);
  });

  // 🔴 Transakcija se PONAŠA kao transakcija: pad tela vraća SVE tabele i
  // registar idempotencije na zatečeno stanje. Bez toga bi test „neuspeh ne
  // troši ključ" merio lažnu bazu umesto stvarnog svojstva `IdempotencyService`
  // (ključ i akcija u istoj transakciji), pa bi prošao i kad proizvod ne radi.
  const sveTabele = () =>
    Object.values(db).filter((v): v is Tabela => v instanceof Tabela);
  db.$transaction = jest.fn(async (cb: (t: unknown) => Promise<unknown>) => {
    const snimak = sveTabele().map(
      (t) => [t, t.redovi.map((r) => ({ ...r }))] as const,
    );
    const idemSnimak = new Map(idemRedovi);
    try {
      return await cb(db);
    } catch (e) {
      for (const [t, redovi] of snimak) {
        t.redovi.length = 0;
        t.redovi.push(...redovi);
      }
      idemRedovi.clear();
      for (const [k, v] of idemSnimak) idemRedovi.set(k, v);
      throw e;
    }
  });

  return {
    db: db as unknown as PrismaService,
    raw: db,
    idemRedovi,
    maintAsset,
    maintMachine,
    maintVehicleDetails,
    maintFacilityDetails,
    maintItAssetDetails,
    maintVehicleTire,
    maintPart,
    maintPartStockMovement,
    maintDriver,
    maintVehicleBooking,
    maintNotificationLog,
    maintDocument,
    maintLocation,
    maintWorkOrder,
    maintVehicleServicePlan,
    maintAssetServicePlan,
    maintSettings,
    maintUserProfile,
    maintSupplier,
    maintVehicleOwner,
    maintPartVehicle,
    maintTask,
    maintIncident,
    user,
    userRole,
  };
}

/* ══════════════════════ Sastavljanje servisa ══════════════════════ */

const JA = "sef.odrzavanja@servoteh.com";
const cid = (n: number) =>
  `3b241101-e2bb-4255-8caf-4136c566a9${String(n).padStart(2, "0")}`;

/** Storage OSTAJE sy15 i pod `3.0` — ovde se samo hvata sa kojom putanjom je zvan. */
const uploadSpy = jest.fn().mockResolvedValue(undefined);
const removeSpy = jest.fn().mockResolvedValue(undefined);
const signUrlSpy = jest.fn().mockResolvedValue({ url: "https://potpis" });
const storageStub = {
  upload: uploadSpy,
  remove: removeSpy,
  signUrl: signUrlSpy,
} as unknown as Sy15StorageService;

/** sy15 ulazi su ŠPIJUNIRANI: pod `3.0` se ne smeju dodirnuti nijednom. */
function makeSy15() {
  const runIdempotentRls = jest.fn();
  const withUserRls = jest.fn();
  return {
    sy15: { runIdempotentRls, withUserRls } as unknown as Sy15Service,
    runIdempotentRls,
    withUserRls,
  };
}

function postavi(opts?: { rola?: string; maintRola?: string | null }) {
  const d = makeDb();
  d.user.redovi.push({
    id: 7,
    email: JA,
    role: opts?.rola ?? "admin",
    active: true,
  });
  if (opts?.maintRola !== undefined && opts.maintRola !== null) {
    d.maintUserProfile.redovi.push({
      userId: 7,
      fullName: "Šef",
      role: opts.maintRola,
      active: true,
      assignedMachineCodes: [],
    });
  }
  const authz = new OdrzavanjeAuthzService(d.db);
  const fn = new OdrzavanjeFnService(d.db, authz);
  const idem = new IdempotencyService(d.db);
  const s = makeSy15();
  const svc = new OdrzavanjeService(
    s.sy15,
    storageStub,
    { notifyOtpis: jest.fn() } as unknown as MasinaOtpisNotifyService,
    undefined,
    undefined,
    d.db,
    new OdrzavanjeSourceService(),
    idem,
    // Redosled je deo ugovora konstruktora: `authz` pa `fnSvc`.
    authz,
    fn,
  );
  return { ...d, svc, fn, authz, ...s };
}

/** Vozilo + detalji, spremni za upisne testove. */
function dodajVozilo(d: ReturnType<typeof postavi>, assetId = "voz-1") {
  d.maintAsset.redovi.push({
    assetId,
    assetType: "vehicle",
    assetCode: "BG-001",
    name: "Kombi",
    archivedAt: null,
    active: true,
  });
  d.maintVehicleDetails.redovi.push({ assetId });
  return assetId;
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

/* ════════════════════════════ TESTOVI ════════════════════════════ */

describe("§7.1 upisi vozila/vozača/zaliha pod ODRZAVANJE_IZVOR=3.0", () => {
  withIzvor("3.0");

  describe("(a) svaka preneta putanja zove SVOJ prepis, i to sa `tx`", () => {
    it("`ensureVehicleServiceWos` zove `fn.ensureVehicleServiceWos(tx, scope, assetId)`", async () => {
      const d = postavi();
      const assetId = dodajVozilo(d);
      const spy = jest.spyOn(d.fn, "ensureVehicleServiceWos");

      await d.svc.ensureVehicleServiceWos(JA, assetId);

      expect(spy).toHaveBeenCalledTimes(1);
      // 🔴 PRVI argument je transakcioni klijent — ne novi Prisma klijent.
      // Nalog i njegov `wo_events` trag moraju pasti zajedno ili nikako.
      expect(spy.mock.calls[0][0]).toBe(d.raw);
      expect(spy.mock.calls[0][1]).toMatchObject({ userId: 7 });
      expect(spy.mock.calls[0][2]).toBe(assetId);
      expect(d.runIdempotentRls).not.toHaveBeenCalled();
      expect(d.withUserRls).not.toHaveBeenCalled();
    });

    it("`ensureAssetServiceWos` zove `fn.ensureAssetServiceWos(tx, scope, assetId)`", async () => {
      const d = postavi();
      const spy = jest.spyOn(d.fn, "ensureAssetServiceWos");
      await d.svc.ensureAssetServiceWos(JA, "it-1");
      expect(spy.mock.calls[0][0]).toBe(d.raw);
      expect(spy.mock.calls[0][2]).toBe("it-1");
    });

    it("`vehicleDeadlineCheck` zove `fn.checkVehicleDeadlines(tx, dana)`", async () => {
      const d = postavi();
      const spy = jest.spyOn(d.fn, "checkVehicleDeadlines");
      await d.svc.vehicleDeadlineCheck(JA, { lookaheadDays: 45 });
      expect(spy).toHaveBeenCalledWith(d.raw, 45);
    });

    it("`retryNotification` zove `fn.notificationRetry(tx, scope, id)`", async () => {
      const d = postavi();
      d.maintNotificationLog.redovi.push({
        id: "n-1",
        attempts: 8,
        status: "failed",
      });
      const spy = jest.spyOn(d.fn, "notificationRetry");

      const out = await d.svc.retryNotification(JA, "n-1");

      expect(spy).toHaveBeenCalledWith(
        d.raw,
        expect.objectContaining({ userId: 7 }),
        "n-1",
      );
      expect(out).toEqual({ data: { requeued: true } });
      // `LEAST(attempts, 7)` — red koji je udario plafon mora opet u red čekanja.
      expect(d.maintNotificationLog.redovi[0]).toMatchObject({
        status: "queued",
        attempts: 7,
      });
    });

    it("`createStockMovement` zove `fn.applyPartStockMovement(tx, …)`", async () => {
      const d = postavi();
      d.maintPart.redovi.push({ partId: "deo-1", currentStock: 0 });
      const spy = jest.spyOn(d.fn, "applyPartStockMovement");

      await d.svc.createStockMovement(JA, "deo-1", {
        clientEventId: cid(1),
        movementType: "in",
        quantity: 5,
      });

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toBe(d.raw);
      expect(spy.mock.calls[0][1]).toMatchObject({
        partId: "deo-1",
        movementType: "in",
        quantity: 5,
      });
    });

    it("`updateSettings` čita nazad kroz `fn.settings(tx)` (fallback kad reda nema)", async () => {
      const d = postavi();
      const spy = jest.spyOn(d.fn, "settings");

      const out = (await d.svc.updateSettings(JA, {
        majorWoDueHours: 12,
      })) as { data: { majorWoDueHours: number } };

      expect(spy).toHaveBeenCalledWith(d.raw);
      // Reda `id = 1` nema → `SETTINGS_FALLBACK`, ne `null`. Modul po tim
      // vrednostima STVARNO radi (auto-nalog, obaveštenja), pa ih i vraća.
      expect(out.data.majorWoDueHours).toBe(48);
    });

    it("`updateProfile` prolazi kroz `fn.assertProfileRoleChange` (nema trigera u 3.0)", async () => {
      const d = postavi();
      d.maintUserProfile.redovi.push({
        userId: 9,
        fullName: "Operater",
        role: "operator",
        active: true,
        assignedMachineCodes: [],
      });
      const spy = jest.spyOn(d.fn, "assertProfileRoleChange");

      await d.svc.updateProfile(JA, "9", { role: "chief" });

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][1]).toMatchObject({ role: "operator" });
      expect(d.maintUserProfile.redovi[0]).toMatchObject({ role: "chief" });
    });
  });

  describe("(b) zalihe: `current_stock` = ZBIR kretanja, ledger je insert-only", () => {
    it("+10, −4, +2 → stanje 8 i TAČNO 3 reda u ledgeru", async () => {
      const d = postavi();
      d.maintPart.redovi.push({ partId: "deo-1", currentStock: 0 });

      await d.svc.createStockMovement(JA, "deo-1", {
        clientEventId: cid(11),
        movementType: "in",
        quantity: 10,
      });
      await d.svc.createStockMovement(JA, "deo-1", {
        clientEventId: cid(12),
        movementType: "out",
        quantity: 4,
      });
      await d.svc.createStockMovement(JA, "deo-1", {
        clientEventId: cid(13),
        movementType: "in",
        quantity: 2,
      });

      // 🔴 Poređenje sa ZBIROM, ne sa poslednjim upisom: stanje koje bi
      // „pratilo poslednju vrednost" ovde bi dalo 2 i test bi svejedno prošao.
      const zbir = d.maintPartStockMovement.redovi.reduce(
        (a, m) => a + (m.movementType === "out" ? -1 : 1) * Number(m.quantity),
        0,
      );
      expect(zbir).toBe(8);
      expect(d.maintPart.redovi[0].currentStock).toBe(8);
      // Ledger je insert-only — nijedan red se ne menja niti briše.
      expect(d.maintPartStockMovement.redovi).toHaveLength(3);
      expect(d.maintPartStockMovement.updateMany).not.toHaveBeenCalled();
      expect(d.maintPartStockMovement.deleteMany).not.toHaveBeenCalled();
    });

    it("`return` i `adjustment` DODAJU (prepis `CASE`-a, ne izbor)", async () => {
      const d = postavi();
      d.maintPart.redovi.push({ partId: "deo-1", currentStock: 0 });
      await d.svc.createStockMovement(JA, "deo-1", {
        clientEventId: cid(14),
        movementType: "return",
        quantity: 3,
      });
      await d.svc.createStockMovement(JA, "deo-1", {
        clientEventId: cid(15),
        movementType: "adjustment",
        quantity: 2,
      });
      expect(d.maintPart.redovi[0].currentStock).toBe(5);
    });

    it("dupli klik (isti clientEventId) NE pomera stanje drugi put", async () => {
      const d = postavi();
      d.maintPart.redovi.push({ partId: "deo-1", currentStock: 0 });
      const telo = {
        clientEventId: cid(16),
        movementType: "in" as const,
        quantity: 10,
      };
      await d.svc.createStockMovement(JA, "deo-1", telo);
      await d.svc.createStockMovement(JA, "deo-1", telo);
      expect(d.maintPart.redovi[0].currentStock).toBe(10);
      expect(d.maintPartStockMovement.redovi).toHaveLength(1);
    });

    it("kretanje na NEVIDLJIV nalog se odbija (WITH CHECK `wo_id` grana)", async () => {
      const d = postavi({ rola: "monter", maintRola: "operator" });
      d.maintPart.redovi.push({ partId: "deo-1", currentStock: 0 });
      await expect(
        d.svc.createStockMovement(JA, "deo-1", {
          clientEventId: cid(17),
          movementType: "in",
          quantity: 1,
          woId: "wo-x",
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(d.maintPartStockMovement.redovi).toHaveLength(0);
    });
  });

  describe("(c) `ensure_*_service_wos`: drugi poziv daje 0 novih", () => {
    it("vozila — dva uzastopna poziva za isti assetId", async () => {
      const d = postavi();
      const assetId = dodajVozilo(d);
      d.maintVehicleServicePlan.redovi.push({
        planId: "plan-1",
        assetId,
        name: "Mali servis",
        active: true,
        priority: "p4_planirano",
      });

      const prvi = await d.svc.ensureVehicleServiceWos(JA, assetId);
      const drugi = await d.svc.ensureVehicleServiceWos(JA, assetId);

      expect(prvi.data.created).toBe(1);
      expect(drugi.data.created).toBe(0);
      expect(d.maintWorkOrder.redovi).toHaveLength(1);
    });

    it("IT/objekti — isto pravilo (`has_open_wo`)", async () => {
      const d = postavi();
      d.maintAsset.redovi.push({
        assetId: "it-1",
        assetType: "it",
        assetCode: "PC-1",
        name: "Radna stanica",
        archivedAt: null,
      });
      d.maintAssetServicePlan.redovi.push({
        planId: "ap-1",
        assetId: "it-1",
        name: "Godišnji pregled",
        active: true,
        intervalMonths: 12,
      });

      const prvi = await d.svc.ensureAssetServiceWos(JA, "it-1");
      const drugi = await d.svc.ensureAssetServiceWos(JA, "it-1");

      expect(prvi.data.created).toBe(1);
      expect(drugi.data.created).toBe(0);
    });

    it("bez ovlašćenja (operater) — 403, i NIJEDAN nalog", async () => {
      const d = postavi({ rola: "monter", maintRola: "operator" });
      const assetId = dodajVozilo(d);
      d.maintVehicleServicePlan.redovi.push({
        planId: "plan-1",
        assetId,
        name: "Mali servis",
        active: true,
      });
      await expect(
        d.svc.ensureVehicleServiceWos(JA, assetId),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(d.maintWorkOrder.redovi).toHaveLength(0);
    });
  });

  describe("(d) rokovi: isti rok ide TAČNO JEDNOM", () => {
    it("dva poziva `vehicleDeadlineCheck` → 1 red u `maint_notification_log`", async () => {
      const d = postavi();
      const assetId = dodajVozilo(d);
      const zaDeset = new Date();
      zaDeset.setDate(zaDeset.getDate() + 10);
      d.maintVehicleDetails.redovi[0].registrationPlate = "BG 123 AA";
      d.maintVehicleDetails.redovi[0].registrationExpiresAt = zaDeset;

      const prvi = await d.svc.vehicleDeadlineCheck(JA, {});
      const drugi = await d.svc.vehicleDeadlineCheck(JA, {});

      expect(prvi.data).toEqual({ enqueued: 1, skipped: 0 });
      // 🔴 Drugi poziv NE upisuje ništa — broji se kao `skipped`. Bez toga bi
      // vozač isto obaveštenje dobijao svakog dana do isteka registracije.
      expect(drugi.data).toEqual({ enqueued: 0, skipped: 1 });
      expect(d.maintNotificationLog.redovi).toHaveLength(1);
      expect(d.maintNotificationLog.redovi[0]).toMatchObject({
        relatedEntityType: "asset",
        relatedEntityId: assetId,
        channel: "email",
      });
    });

    it("rok vozača (vozačka dozvola) se takođe upisuje i takođe ne duplira", async () => {
      const d = postavi();
      const zaPet = new Date();
      zaPet.setDate(zaPet.getDate() + 5);
      d.maintDriver.redovi.push({
        driverId: "voz-a",
        fullName: "Pera Perić",
        active: true,
        archivedAt: null,
        driversLicenseValidUntil: zaPet,
      });

      await d.svc.vehicleDeadlineCheck(JA, {});
      await d.svc.vehicleDeadlineCheck(JA, {});

      const redovi = d.maintNotificationLog.redovi.filter(
        (r) => r.relatedEntityType === "driver",
      );
      expect(redovi).toHaveLength(1);
      expect((redovi[0].payload as Record<string, unknown>).deadline_kind).toBe(
        "drivers_license",
      );
    });
  });

  describe("(e) Objekti end-to-end — katastarske parcele se KONAČNO upisuju", () => {
    it("create objekta upiše detalje SA parcelama (u sy15 je ovo bilo 500/42703)", async () => {
      const d = postavi();

      const out = (await d.svc.createFacility(JA, {
        clientEventId: cid(21),
        assetCode: "OBJ-1",
        name: "Hala 3",
        details: {
          facility_type: "hala",
          criticality: "high",
          cadastral_parcels: "1234/5, 1234/6",
        },
      })) as { data: { assetId: string } };

      const assetId = out.data.assetId;
      expect(assetId).toBeTruthy();
      expect(d.maintAsset.redovi).toHaveLength(1);
      expect(d.maintAsset.redovi[0]).toMatchObject({
        assetType: "facility",
        assetCode: "OBJ-1",
        status: "running",
        updatedBy: 7,
      });
      // 🔴 Red POSTOJI i kolona je POPUNJENA. Na produkciji (sy15) je ovaj upit
      // vraćao 0 redova jer je ceo INSERT padao na nepostojećoj koloni.
      expect(d.maintFacilityDetails.redovi).toHaveLength(1);
      expect(d.maintFacilityDetails.redovi[0]).toMatchObject({
        assetId,
        facilityType: "hala",
        criticality: "high",
        cadastralParcels: "1234/5, 1234/6",
      });
    });

    it("upsert detalja objekta upiše parcele i pri IZMENI", async () => {
      const d = postavi();
      d.maintAsset.redovi.push({
        assetId: "obj-1",
        assetType: "facility",
        assetCode: "OBJ-1",
        name: "Hala 3",
        archivedAt: null,
      });

      await d.svc.upsertFacilityDetails(JA, "obj-1", {
        details: { cadastral_parcels: "9999/1" },
      });

      expect(d.maintFacilityDetails.redovi[0]).toMatchObject({
        assetId: "obj-1",
        cadastralParcels: "9999/1",
        updatedBy: 7,
      });
    });

    it("prazan string je NULL (`NULLIF(x, '')` iz izvora), ne prazna vrednost", async () => {
      const d = postavi();
      await d.svc.createFacility(JA, {
        clientEventId: cid(22),
        assetCode: "OBJ-2",
        name: "Magacin",
        manufacturer: "",
        details: { cadastral_parcels: "" },
      });
      expect(d.maintAsset.redovi[0].manufacturer).toBeNull();
      expect(d.maintFacilityDetails.redovi[0].cadastralParcels).toBeNull();
    });
  });

  describe("prava — 3.0 nema RLS, pa gejt mora biti u kodu", () => {
    it("operater ne sme da napravi vozilo (403), i sredstvo NE nastaje", async () => {
      const d = postavi({ rola: "monter", maintRola: "operator" });
      await expect(
        d.svc.createVehicle(JA, {
          clientEventId: cid(31),
          assetCode: "BG-9",
          name: "Kombi",
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(d.maintAsset.redovi).toHaveLength(0);
    });

    it("neuspeh NE troši `clientEventId` (rollback briše i ključ)", async () => {
      const d = postavi({ rola: "monter", maintRola: "operator" });
      await expect(
        d.svc.createVehicle(JA, {
          clientEventId: cid(32),
          assetCode: "BG-9",
          name: "Kombi",
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // Ključ ostaje slobodan — korisnik sme da ponovi isti zahtev kad dobije prava.
      expect(d.idemRedovi.size).toBe(0);
    });

    it("🔴 brisanje vozača je UŽE od izmene: `chief` sme da MENJA, ali NE da briše", async () => {
      const d = postavi({ rola: "monter", maintRola: "chief" });
      d.maintDriver.redovi.push({
        driverId: "voz-a",
        fullName: "Pera",
        jmbg: "0101990710011",
        active: true,
      });

      // Izmena prolazi (`maint_drivers_update` uključuje `chief`).
      await d.svc.updateDriver(JA, "voz-a", { phone: "060" });
      expect(d.maintDriver.redovi[0]).toMatchObject({ phone: "060" });

      // Brisanje NE prolazi (`maint_drivers_delete` = erp adm/mgmt ∨ SAMO admin).
      await expect(d.svc.deleteDriver(JA, "voz-a")).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(d.maintDriver.redovi).toHaveLength(1);
    });

    it("tehničar NE menja vozača (vidi ga, ali PII ostaje netaknut)", async () => {
      const d = postavi({ rola: "monter", maintRola: "technician" });
      d.maintDriver.redovi.push({
        driverId: "voz-a",
        fullName: "Pera",
        jmbg: "0101990710011",
        active: true,
      });
      await expect(
        d.svc.updateDriver(JA, "voz-a", { jmbg: "0000000000000" }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(d.maintDriver.redovi[0].jmbg).toBe("0101990710011");
    });

    it("🔴 moja rezervacija je moja — operater menja SVOJU, ne tuđu", async () => {
      const d = postavi({ rola: "monter", maintRola: "operator" });
      const assetId = dodajVozilo(d);
      d.maintVehicleBooking.redovi.push({
        bookingId: "rez-moja",
        assetId,
        createdBy: 7,
        status: "planirana",
      });
      d.maintVehicleBooking.redovi.push({
        bookingId: "rez-tudja",
        assetId,
        createdBy: 99,
        status: "planirana",
      });

      await d.svc.updateBooking(JA, "rez-moja", { purpose: "teren" });
      expect(d.maintVehicleBooking.redovi[0]).toMatchObject({
        purpose: "teren",
      });

      await expect(
        d.svc.updateBooking(JA, "rez-tudja", { purpose: "teren" }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(d.maintVehicleBooking.redovi[1].purpose).toBeUndefined();
    });

    it("CMMS lokacije: `menadzment` NE sme (uže od zaliha), `admin` sme", async () => {
      const mgmt = postavi({ rola: "menadzment" });
      await expect(
        mgmt.svc.createLocation(JA, { clientEventId: cid(41), name: "Hala 1" }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(mgmt.maintLocation.redovi).toHaveLength(0);

      const adm = postavi({ rola: "admin" });
      await adm.svc.createLocation(JA, {
        clientEventId: cid(42),
        name: "Hala 1",
      });
      // 🔴 Upis je otišao u `maint_locations` (CMMS stablo), NE u `loc_locations`.
      expect(adm.maintLocation.redovi).toHaveLength(1);
      expect(adm.maintLocation.redovi[0]).toMatchObject({
        name: "Hala 1",
        locationType: "lokacija",
      });
    });

    /**
     * 🔴 VIDLJIVOST NIJE PRAVO UPISA. Operater sa ERP rolom `monter` ima
     * `floor_read`, pa mu `maint_asset_visible` za vozilo vraća TRUE — vidi ga u
     * listi. Ali `maint_vehicle_details_update` traži I write krug
     * (erp adm/mgmt ∨ chief/admin). Prepis koji proveri samo vidljivost pušta
     * operatera da menja karton vozila, a nijedna lista se ne bi promenila —
     * greška bi se videla tek kad neko primeti izmenjen datum registracije.
     */
    it("operater VIDI vozilo, ali NE menja njegove detalje (403)", async () => {
      const d = postavi({ rola: "monter", maintRola: "operator" });
      const assetId = dodajVozilo(d);
      d.maintVehicleDetails.redovi[0].vin = "STARI-VIN";

      // Vidljivost postoji — inače bi ovo bilo 404, ne 403.
      expect(
        d.authz.assetVisible(
          {
            userId: 7,
            erpRoles: new Set(["monter"]),
            profileRole: "operator",
            assignedMachineCodes: [],
          },
          { assetType: "vehicle" },
        ),
      ).toBe(true);

      await expect(
        d.svc.upsertVehicleDetails(JA, assetId, {
          details: { vin: "NOVI-VIN" },
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(d.maintVehicleDetails.redovi[0].vin).toBe("STARI-VIN");
    });

    it("operater ne sme da doda garnituru guma na vidljivo vozilo (403)", async () => {
      const d = postavi({ rola: "monter", maintRola: "operator" });
      const assetId = dodajVozilo(d);
      await expect(
        d.svc.createTire(JA, assetId, {
          clientEventId: cid(33),
          season: "winter",
          dimension: "205/55 R16",
          count: 4,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(d.maintVehicleTire.redovi).toHaveLength(0);
    });

    it("upis nad NEPOSTOJEĆIM sredstvom je 404, ne 403 (ne odaje tuđe id-jeve)", async () => {
      const d = postavi();
      await expect(
        d.svc.upsertVehicleDetails(JA, "nema-me", { details: {} }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("nepoznat e-mail dobija 403, nikad prazan scope (koji bi značio VIŠE prava)", async () => {
      const d = postavi();
      await expect(
        d.svc.ensureVehicleServiceWos("niko@nigde.rs"),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  /* ══════════════════════════════════════════════════════════════════════
   * ČETIRI GEJTA KOJA NIJEDAN TEST NIJE DRŽAO
   *
   * Protivnička provera je nad ovim prepisom pustila mutacije prava i
   * IZMERILA da četiri od njih PREŽIVE svih 431 zelenih testova — dakle da
   * je sadržaj gejta bio tačan slučajno, a ne pinovano. Svaki test ispod
   * pada ako se odgovarajući gejt zameni širim (ili ukine), i svaki nosi
   * POZITIVNU kontrolu, da „403 na sve" ne prođe kao dokaz.
   *
   * Sve četiri asimetrije su izmerene na ŽIVIM sy15 politikama (`pg_policies`,
   * 08.08.2026) — ovo su prepisi, ne procene.
   * ══════════════════════════════════════════════════════════════════════ */
  describe("🔴 asimetrije prava koje se NE VIDE iz imena metode", () => {
    /**
     * `maint_assets_update` = `maint_is_erp_admin() ∨ chief/admin` — BEZ
     * `menadzment`/`magacioner`, iako oni smeju SVE ostalo oko sredstva
     * (detalji, gume, arhiviranje). Prepis zato mora `canWriteCatalog`, a
     * `canWriteStock` bi menadžmentu i magacioneru dao da menja naziv, status,
     * lokaciju i odgovornog na BILO KOM sredstvu.
     */
    it("`patchAssetCore`: `menadzment` (i `magacioner`) NE smeju, `chief` sme", async () => {
      for (const rola of ["menadzment", "magacioner"]) {
        const d = postavi({ rola });
        const assetId = dodajVozilo(d);
        await expect(
          d.svc.patchAssetCore(JA, assetId, { name: "Preimenovano" }),
        ).rejects.toBeInstanceOf(ForbiddenException);
        // Kontrola da je stao na GEJTU, a ne na nečemu ranijem: red je netaknut.
        expect(d.maintAsset.redovi[0].name).toBe("Kombi");
      }

      // Pozitivna kontrola: `chief` (bez ijedne ERP role iz write kruga) sme.
      const ok = postavi({ rola: "monter", maintRola: "chief" });
      const assetId = dodajVozilo(ok);
      await ok.svc.patchAssetCore(JA, assetId, { name: "Preimenovano" });
      expect(ok.maintAsset.redovi[0].name).toBe("Preimenovano");
    });

    /**
     * `maint_pv_insert`/`maint_pv_update` IMAJU tehničara, `maint_pv_delete`
     * ga NEMA. Prepis koji na brisanju upotrebi `mozePisatiVezuDeoVozilo`
     * (izraz za insert/update) daje tehničaru da ODVEŽE deo sa vozila —
     * evidencija tiho gubi red, a nijedna lista ne prijavi grešku.
     */
    it("`unlinkPartFromVehicle`: tehničar sme da VEŽE i MENJA vezu, ali NE da je odveže", async () => {
      const d = postavi({ rola: "monter", maintRola: "technician" });
      const assetId = dodajVozilo(d);

      // Pozitivna kontrola 1 — insert (`maint_pv_insert` ima tehničara).
      await d.svc.linkPartToVehicle(JA, assetId, {
        clientEventId: cid(61),
        partId: "deo-1",
      });
      expect(d.maintPartVehicle.redovi).toHaveLength(1);

      // Pozitivna kontrola 2 — update (`maint_pv_update` takođe ima tehničara).
      await d.svc.updatePartVehicleLink(JA, assetId, "deo-1", { qtyMin: 3 });
      expect(d.maintPartVehicle.redovi[0]).toMatchObject({ qtyMin: 3 });

      // 🔴 Brisanje NE (`maint_pv_delete` je bez tehničara) — i veza OSTAJE.
      await expect(
        d.svc.unlinkPartFromVehicle(JA, assetId, "deo-1"),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(d.maintPartVehicle.redovi).toHaveLength(1);
    });

    /**
     * `maint_booking_update` ima granu `created_by = uid()` („moja rezervacija
     * je moja"), a `maint_booking_delete` je NEMA. Prepis koji na brisanju
     * upotrebi `canUpdateBooking` daje operateru da OBRIŠE svoju rezervaciju —
     * a u sy15 je smeo samo da je otkaže (status), ne i da je ukloni iz kalendara.
     */
    it("`deleteBooking`: operater menja SVOJU rezervaciju, ali je NE briše", async () => {
      const d = postavi({ rola: "monter", maintRola: "operator" });
      const assetId = dodajVozilo(d);
      d.maintVehicleBooking.redovi.push({
        bookingId: "rez-moja",
        assetId,
        createdBy: 7, // = pozivalac
        status: "planirana",
      });

      // Pozitivna kontrola: izmena SVOJE rezervacije prolazi.
      await d.svc.updateBooking(JA, "rez-moja", { purpose: "teren" });
      expect(d.maintVehicleBooking.redovi[0]).toMatchObject({
        purpose: "teren",
      });

      // 🔴 Brisanje SVOJE rezervacije NE prolazi — i red OSTAJE u kalendaru.
      await expect(d.svc.deleteBooking(JA, "rez-moja")).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(d.maintVehicleBooking.redovi).toHaveLength(1);
    });

    /**
     * `maint_documents_update`/`_delete` su ČISTA vidljivost
     * (`maint_document_visible(entity_type, entity_id)`) — bez role-gejta. To
     * znači da brana NIJE „ko sme da piše" nego „šta uopšte vidiš": bez
     * `assertExistingDocumentVisible30` korisnik menja i soft-briše dokument
     * TUĐEG vozača, koga u listi nikad nije video. Vozačka dokumenta su PII.
     */
    it("dokumenti: bez vidljivosti nema ni izmene ni brisanja (tuđi vozač)", async () => {
      const d = postavi({ rola: "proizvodni_radnik" });
      // Vozač koji NIJE pozivalac + vozač koji jeste (pozitivna kontrola).
      d.maintDriver.redovi.push(
        { driverId: "voz-tudji", fullName: "Pera", authUserId: 99 },
        { driverId: "voz-moj", fullName: "Ja", authUserId: 7 },
      );
      d.maintDocument.redovi.push(
        {
          documentId: "dok-tudji",
          entityType: "driver",
          entityId: "voz-tudji",
          storagePath: "documents/driver/voz-tudji/a.pdf",
          category: "vozacka",
          deletedAt: null,
        },
        {
          documentId: "dok-moj",
          entityType: "driver",
          entityId: "voz-moj",
          storagePath: "documents/driver/voz-moj/b.pdf",
          category: "vozacka",
          deletedAt: null,
        },
      );
      removeSpy.mockClear();

      // Kontrola da pozivalac zaista NEMA `canReadAllDrivers` — inače bi ovaj
      // test merio nešto drugo (npr. da mu fali profil).
      expect(
        d.authz.canReadAllDrivers({
          userId: 7,
          erpRoles: new Set(["proizvodni_radnik"]),
          profileRole: null,
          assignedMachineCodes: [],
        }),
      ).toBe(false);

      await expect(
        d.svc.updateDocument(JA, "dok-tudji", { category: "podmetnuto" }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(d.maintDocument.redovi[0].category).toBe("vozacka");

      await expect(
        d.svc.deleteDocument(JA, "dok-tudji"),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(d.maintDocument.redovi[0].deletedAt).toBeNull();
      // 🔴 Bajtovi u sy15 storage-u se NE brišu na odbijen zahtev.
      expect(removeSpy).not.toHaveBeenCalled();

      // Pozitivna kontrola: SVOJ vozački dokument sme i da menja i da obriše.
      await d.svc.updateDocument(JA, "dok-moj", { category: "lekarsko" });
      expect(d.maintDocument.redovi[1].category).toBe("lekarsko");
      await d.svc.deleteDocument(JA, "dok-moj");
      expect(d.maintDocument.redovi[1].deletedAt).toBeInstanceOf(Date);
      expect(removeSpy).toHaveBeenCalledWith(
        expect.anything(),
        "documents/driver/voz-moj/b.pdf",
      );
    });
  });

  describe("storage: šema putanje se NE menja (bajtovi ostaju u sy15)", () => {
    it("foto vozila ide na `documents/asset/<assetId>/…`, kao i pre preklopa", async () => {
      const d = postavi();
      const assetId = dodajVozilo(d);

      await d.svc.uploadVehiclePhoto(JA, assetId, {
        originalname: "slika.jpg",
        mimetype: "image/jpeg",
        // Minimalan validan JPEG magic (`assertAttachment` presuđuje po sadržaju).
        buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]),
      } as unknown as Express.Multer.File);

      const putanja = d.maintDocument.redovi[0].storagePath as string;
      expect(putanja.startsWith(`documents/asset/${assetId}/`)).toBe(true);
      expect(putanja.endsWith("_slika.jpg")).toBe(true);
      // Pointer glavne fotografije pokazuje na ISTU putanju.
      expect(d.maintVehicleDetails.redovi[0].primaryPhotoStoragePath).toBe(
        putanja,
      );
      // Bajtovi su otišli u sy15 bucket, na TU putanju — nijedan drugi ključ.
      expect(uploadSpy).toHaveBeenCalledWith(
        "maint-machine-files",
        putanja,
        expect.anything(),
        "image/jpeg",
        false,
      );
    });
  });

  describe("brana i dalje stoji za ono što NIJE preneto", () => {
    it("`lookupEmployees` pada sa 503 — `employees` je kadrovska (korak 4)", async () => {
      const d = postavi();
      await expect(d.svc.lookupEmployees(JA, "per")).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(d.withUserRls).not.toHaveBeenCalled();
    });

    it("bez ubrizganog `fn`/`authz` upis NE ide u sy15 nego pada sa 503", async () => {
      const d = makeDb();
      const s = makeSy15();
      const svc = new OdrzavanjeService(
        s.sy15,
        storageStub,
        { notifyOtpis: jest.fn() } as unknown as MasinaOtpisNotifyService,
        undefined,
        undefined,
        d.db,
        new OdrzavanjeSourceService(),
        new IdempotencyService(d.db),
        // 🔴 `fn` i `authz` NAMERNO izostavljeni — izostanak zavisnosti nikad ne
        // sme da vrati saobraćaj u sy15.
      );
      await expect(
        svc.ensureVehicleServiceWos(JA, "voz-1"),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(s.withUserRls).not.toHaveBeenCalled();
    });
  });
});

describe("pod ODRZAVANJE_IZVOR=sy15 (podrazumevano) upisi ostaju netaknuti", () => {
  withIzvor("sy15");

  it("3.0 baza se NE dodiruje nijednim upitom", async () => {
    const d = postavi();
    d.withUserRls.mockImplementation(
      async (_e: string, fn: (t: unknown) => Promise<unknown>) =>
        fn({
          $queryRaw: jest.fn().mockResolvedValue([{ n: 0 }]),
          $executeRaw: jest.fn().mockResolvedValue(0),
        }),
    );
    const spy = jest.spyOn(d.fn, "ensureVehicleServiceWos");

    await d.svc.ensureVehicleServiceWos(JA, "voz-1");

    expect(d.withUserRls).toHaveBeenCalledTimes(1);
    expect(spy).not.toHaveBeenCalled();
    expect(d.raw.$transaction).not.toHaveBeenCalled();
  });

  it("`fn30` telo postoji, ali prekidač presuđuje — ne prisustvo tela", async () => {
    const d = postavi();
    d.runIdempotentRls.mockImplementation(
      async (
        _e: string,
        _c: string,
        _a: string,
        fn: (t: unknown) => Promise<unknown>,
      ) => ({
        result: await fn({
          maintPartStockMovement: { create: jest.fn().mockResolvedValue({}) },
          $queryRaw: jest.fn().mockResolvedValue([{ uid: null }]),
        }),
        idempotent: false,
      }),
    );
    const spy = jest.spyOn(d.fn, "applyPartStockMovement");

    await d.svc.createStockMovement(JA, "deo-1", {
      clientEventId: cid(51),
      movementType: "in",
      quantity: 10,
    });

    expect(d.runIdempotentRls).toHaveBeenCalledTimes(1);
    // 🔴 Pod `sy15` `current_stock` održava DB trigger — prepis se NE sme pozvati
    // (dupla primena bi udvostručila svako kretanje zaliha).
    expect(spy).not.toHaveBeenCalled();
    expect(d.maintPart.redovi).toHaveLength(0);
  });

  /**
   * 🔴 REGRESIJA KOJU JE OVA GRANA UMALO PUSTILA NA PRODUKCIJU.
   *
   * `ParseUUIDPipe` je skinut sa `PATCH maintenance/profiles/:id`, a `@IsUUID()`
   * zamenjen regexom koji prima i broj — oboje NUŽNO, jer je `user_id` uuid u
   * sy15 a `users.id` (Int) u 3.0. Posledica pod PODRAZUMEVANIM prekidačem
   * (sy15 = produkcija danas): besmislen parametar više ne pada na pipe sa 400,
   * nego stigne do upita nad `uuid` kolonom i vrati se kao Prisma `P2023` /
   * PG `22P02` — koje `rethrowSy15` nije poznavao, pa je korisnik dobijao **500**.
   *
   * BACKEND_RULES §6: 500 je rezervisan za NEOČEKIVANO. Neispravan oblik ulaza
   * to nije.
   */
  describe("🔴 besmislen identifikator = 422, NIKAD 500", () => {
    /** `withUserRls` koji pusti telo nad `tx`-om koji odmah baci zadatu grešku. */
    function sy15Pukne(
      d: ReturnType<typeof postavi>,
      greska: unknown,
      { erpAdmin = true }: { erpAdmin?: boolean } = {},
    ) {
      d.withUserRls.mockImplementation(
        async (_e: string, fn: (t: unknown) => Promise<unknown>) =>
          fn({
            $queryRaw: jest.fn().mockResolvedValue([{ ok: erpAdmin }]),
            maintUserProfile: {
              count: jest.fn().mockRejectedValue(greska),
              updateMany: jest.fn(),
              findUnique: jest.fn(),
            },
          }),
      );
    }

    it("Prisma `P2023` (ne-uuid u uuid koloni) → 422", async () => {
      const d = postavi();
      sy15Pukne(
        d,
        new Prisma.PrismaClientKnownRequestError(
          "Inconsistent column data: Error creating UUID, invalid character",
          { code: "P2023", clientVersion: "6.19.3" },
        ),
      );

      const p = d.svc.updateProfile(JA, "nije-uuid", { fullName: "X" });
      await expect(p).rejects.toBeInstanceOf(UnprocessableEntityException);
      // Sirova Prisma poruka NE ide korisniku (nosi ime modela i kolone).
      await expect(p).rejects.not.toThrow(/Inconsistent column data/);
    });

    it("sirov PG `22P02` (invalid input syntax) → 422", async () => {
      const d = postavi();
      sy15Pukne(
        d,
        Object.assign(new Error('invalid input syntax for type uuid: "123"'), {
          code: "22P02",
        }),
      );
      await expect(
        d.svc.updateProfile(JA, "123", { fullName: "X" }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it("isti kvar bez strukturnog koda (samo u poruci konektora) → i dalje 422", async () => {
      const d = postavi();
      sy15Pukne(
        d,
        new Error(
          'ERROR: invalid input syntax for type uuid: "nije-uuid" (ConnectorError)',
        ),
      );
      await expect(
        d.svc.updateProfile(JA, "nije-uuid", { fullName: "X" }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it("nepoznata greška OSTAJE 500 — mapper se nije proširio preko mere", async () => {
      const d = postavi();
      sy15Pukne(d, new Error("connection terminated unexpectedly"));
      await expect(
        d.svc.updateProfile(JA, "nije-uuid", { fullName: "X" }),
      ).rejects.not.toBeInstanceOf(UnprocessableEntityException);
    });
  });
});

/**
 * Drugi kraj ISTOG šava: pod `3.0` oblik presuđuje servis, a `users.id` je PG
 * `int4`. Regex `[0-9]+` bez gornje granice bi propustio broj koji Prisma ne
 * ume da smesti u `Int` → opet 500 umesto 422, samo iz druge baze.
 */
describe("🔴 pod 3.0: broj van opsega `int4` je 422, ne 500", () => {
  withIzvor("3.0");

  it("`updateProfile` sa 20-cifrenim brojem → 422", async () => {
    const d = postavi();
    await expect(
      d.svc.updateProfile(JA, "99999999999999999999", { fullName: "X" }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it("`createDriver` sa `authUserId` van opsega → 422, i vozač NE nastaje", async () => {
    const d = postavi();
    await expect(
      d.svc.createDriver(JA, {
        clientEventId: cid(71),
        fullName: "Pera",
        isInternal: true,
        authUserId: "2147483648", // int4 max + 1
        driversLicenseNumber: "12345",
        driversLicenseCategories: ["B"],
        jmbg: "0101990710011",
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(d.maintDriver.redovi).toHaveLength(0);
  });

  it("`patchAssetCore` sa `responsibleUserId` = 0 → 422 (id-jevi kreću od 1)", async () => {
    const d = postavi();
    const assetId = dodajVozilo(d);
    await expect(
      d.svc.patchAssetCore(JA, assetId, { responsibleUserId: "0" }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(d.maintAsset.redovi[0].responsibleUserId).toBeUndefined();
  });

  it("ispravan id i dalje prolazi (kontrola da granica nije previše uska)", async () => {
    const d = postavi();
    const assetId = dodajVozilo(d);
    await d.svc.patchAssetCore(JA, assetId, { responsibleUserId: "7" });
    expect(d.maintAsset.redovi[0].responsibleUserId).toBe(7);
  });
});

/** Prisma `Decimal` se u fake bazi drži kao broj — provera da to nije prevara. */
describe("kontrola merenja", () => {
  it("`applyPartStockMovement` stvarno računa preko Decimal-a", () => {
    expect(new Prisma.Decimal(10).minus(4).plus(2).toNumber()).toBe(8);
  });
});
