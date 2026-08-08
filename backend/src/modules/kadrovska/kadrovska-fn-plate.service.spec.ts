import {
  ForbiddenException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { PrismaService } from "../../prisma/prisma.service";
import {
  KadrovskaFnPlateService,
  racunajDnevnoPrisustvo,
  type PunchEvent,
} from "./kadrovska-fn-plate.service";

/**
 * Paritet-testovi prepisa sy15 `SECURITY DEFINER` funkcija oblasti PLATE i
 * PRISUSTVO (`kadrovska-fn-plate.service.ts`).
 *
 * ŠTA OVI TESTOVI ČUVAJU: ne „da kod radi" nego da PONAŠANJE ostane isto kao u
 * PL/pgSQL izvoru pročitanom sa žive sy15 (`pg_get_functiondef`, 08.08.2026).
 * Zato svaki test imenuje PRAVILO koje pinuje, a ne metodu koju zove.
 *
 * ── 🔴 JEZGRO: TABELA ISTINITOSTI BRAVE NAD PLATAMA ──────────────────────────
 * U sy15 zarade ne čuva rola nego allowlist `kadr_salary_viewer_allowlist`
 * (2 reda na produkciji). 3.0 nema RLS, pa je servisni sloj JEDINA brana.
 * Tabela ispod je izvršna specifikacija — svaki red je test, ne komentar:
 *
 * | identitet                        | contract salary | contract bruto | payroll list | init | upsert | unlock | set contract |
 * |----------------------------------|-----------------|----------------|--------------|------|--------|--------|--------------|
 * | NA SPISKU (nevena@)              | vidi            | vidi           | vidi         | DA   | DA     | DA     | DA           |
 * | VAN SPISKA, bez role             | null            | null           | [] (0)       | 403  | 403    | 403    | 403          |
 * | 🔴 ADMIN, van spiska             | null            | null           | [] (0)       | 403  | 403    | 403    | 403          |
 * | 🔴 HR, van spiska                | null            | null           | [] (0)       | 403  | 403    | 403    | 403          |
 * | 🔴 POSLOVNI_ADMIN, van spiska    | null            | **vidi**       | [] (0)       | 403  | 403    | 403    | **DA**       |
 * | prazan / nepoznat mejl           | null            | null           | [] (0)       | 403  | 403    | 403    | 403          |
 *
 * Dva `poslovni_admin` polja NISU greška u testu nego IZMERENO stanje izvora:
 * `kadr_get_contract_bruto` i `kadr_set_contract_salary` imaju granu
 * `OR public.current_user_is_poslovni_admin()`. Da test to nije pinovao, prvi
 * „doslednosti radi" refaktor bi ILI zatvorio pravo koje poslovni admin danas
 * ima, ILI ga proširio na sve puteve.
 *
 * ── 🔴 MUTACIONA PROBA (izvršena, ne pretpostavljena) ────────────────────────
 * Zelen test ne dokazuje ništa dok se ne dokaže da ume da padne. Uvedeno je
 * 8 namernih kvarenja u servis; svako mora da obori NAVEDENI test:
 *
 *  M1 `canViewSalary` -> `return true`                  ubija „van spiska ne vidi"
 *  M2 `canViewSalary` -> gleda rolu `admin` uz allowlist ubija „admin van spiska"
 *  M3 `getContractBruto` -> samo `canViewSalary`         ubija „poslovni_admin vidi bruto"
 *  M4 `setContractSalary` -> samo `canViewSalary`        ubija „poslovni_admin menja ugovor"
 *  M5 `listPayrollMonth` -> bez gejta                    ubija „TAČAN broj redova = 0"
 *  M6 `upsertSalaryPayroll` -> bez `status='paid'` grane ubija „zaključan mesec"
 *  M7 dedup u `racunajDnevnoPrisustvo` -> prema zadnjem  ubija „tri otkucaja u sekundi"
 *  M8 `payrollUnlock` -> bez `set_config`                ubija „GUC ide u transakciji"
 *
 * Ishod probe je zapisan u PR opisu; test koji mutaciju NE obori je test koji
 * ne vredi (pouka „Mutaciona proba = jedini dokaz da test vredi").
 */

// ══════════════════════════════════════════════════════════════════════════════
// Minimalna in-memory zamena za Prisma klijenta
// ══════════════════════════════════════════════════════════════════════════════

type Row = Record<string, unknown>;

interface Seed {
  salaryViewers?: string[];
  gridEditors?: string[];
  users?: Row[];
  userRoles?: Row[];
  employees?: Row[];
  salaryTerms?: Row[];
  salaryPayroll?: Row[];
  workHours?: Row[];
  attendanceEvents?: Row[];
  attendanceCorrections?: Row[];
  attendanceNotifyExtra?: Row[];
  kadrNotificationLog?: Row[];
  employeeBadges?: Row[];
  auditLog?: Row[];
}

/** Mali matcher — podržava SAMO oblike `where`-a koje servis stvarno koristi. */
function match(row: Row, where: Row | undefined, store: Store): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (key === "OR") {
      const grane = cond as Row[];
      if (!grane.some((g) => match(row, g, store))) return false;
      continue;
    }
    if (key === "NOT") {
      if (match(row, cond as Row, store)) return false;
      continue;
    }
    if (key === "employee") {
      const emp = store.employees.find((e) => e.id === row.employeeId);
      if (!emp || !match(emp, cond as Row, store)) return false;
      continue;
    }
    const v = row[key];
    if (cond === null) {
      if (v !== null && v !== undefined) return false;
      continue;
    }
    if (typeof cond !== "object" || cond instanceof Date) {
      if (cond instanceof Date) {
        if (!(v instanceof Date) || v.getTime() !== cond.getTime())
          return false;
      } else if (v !== cond) {
        return false;
      }
      continue;
    }
    const c = cond as Row;
    if ("equals" in c && !("path" in c)) {
      const target = c.equals;
      if (c.mode === "insensitive") {
        const levo = typeof v === "string" ? v : "";
        const desno = typeof target === "string" ? target : "";
        if (levo.toLowerCase() !== desno.toLowerCase()) return false;
      } else if (target instanceof Date) {
        if (!(v instanceof Date) || v.getTime() !== target.getTime()) {
          return false;
        }
      } else if (v !== target) {
        return false;
      }
      continue;
    }
    if ("path" in c) {
      const path = c.path as string[];
      let cur: unknown = v;
      for (const p of path) cur = (cur as Row | null)?.[p];
      if (cur !== c.equals) return false;
      continue;
    }
    if ("in" in c) {
      const list = c.in as unknown[];
      if (!list.some((x) => (x instanceof Date ? false : x === v)))
        return false;
      continue;
    }
    if ("has" in c) {
      const arr = (v ?? []) as unknown[];
      if (!arr.includes(c.has)) return false;
      continue;
    }
    if ("not" in c) {
      if (c.not === null) {
        if (v === null || v === undefined) return false;
      } else if (v === c.not) {
        return false;
      }
      continue;
    }
    for (const op of ["gte", "gt", "lte", "lt"] as const) {
      if (!(op in c)) continue;
      const a = v instanceof Date ? v.getTime() : Number(v);
      const bRaw = c[op];
      const b = bRaw instanceof Date ? bRaw.getTime() : Number(bRaw);
      if (op === "gte" && !(a >= b)) return false;
      if (op === "gt" && !(a > b)) return false;
      if (op === "lte" && !(a <= b)) return false;
      if (op === "lt" && !(a < b)) return false;
    }
  }
  return true;
}

interface Store {
  employees: Row[];
  [k: string]: Row[];
}

function model(store: Store, name: string, compound?: string) {
  const rows = () => store[name];
  const sortiraj = (arr: Row[], orderBy: unknown): Row[] => {
    if (!orderBy) return arr;
    const kriterijumi = Array.isArray(orderBy) ? orderBy : [orderBy];
    return [...arr].sort((a, b) => {
      for (const k of kriterijumi as Row[]) {
        let [polje, smer] = Object.entries(k)[0];
        let ra: Row = a;
        let rb: Row = b;
        // `orderBy: { employee: { fullName: 'asc' } }` — ugnježdeni redosled
        // kroz relaciju (hidratisanu u `hidratiraj`).
        while (typeof smer === "object" && smer !== null) {
          ra = (ra[polje] ?? {}) as Row;
          rb = (rb[polje] ?? {}) as Row;
          [polje, smer] = Object.entries(smer as Row)[0];
        }
        const av = ra[polje];
        const bv = rb[polje];
        const an = av instanceof Date ? av.getTime() : av;
        const bn = bv instanceof Date ? bv.getTime() : bv;
        if (an === bn || an === undefined || bn === undefined) continue;
        const cmp =
          typeof an === "string" && typeof bn === "string"
            ? an.localeCompare(bn)
            : Number(an) - Number(bn);
        if (cmp !== 0) return smer === "desc" ? -cmp : cmp;
      }
      return 0;
    });
  };
  const razresiWhere = (where: Row | undefined): Row | undefined => {
    if (where && compound && where[compound]) {
      return where[compound] as Row;
    }
    return where;
  };
  /**
   * `select`/`include` sa relacijom (`employee`, `user`) — bez ovoga bi svi
   * upiti koji čitaju ime zaposlenog ili mejl naloga vraćali `undefined`, a
   * test bi „prošao" jer se ništa ne uporedi.
   */
  const hidratiraj = (red: Row | null, proj: unknown): Row | null => {
    if (!red || !proj || typeof proj !== "object") return red;
    const p = proj as Row;
    const out: Row = { ...red };
    if ("employee" in p) {
      out.employee = store.employees.find((e) => e.id === red.employeeId);
    }
    if ("user" in p) {
      out.user = store.users.find((u) => u.id === red.userId);
    }
    return out;
  };
  const projekcija = (args: { select?: unknown; include?: unknown }) =>
    args.select ?? args.include;
  return {
    count: jest.fn(
      ({ where }: { where?: Row } = {}) =>
        rows().filter((r) => match(r, razresiWhere(where), store)).length,
    ),
    findMany: jest.fn(
      (
        args: {
          where?: Row;
          orderBy?: unknown;
          take?: number;
          select?: unknown;
          include?: unknown;
        } = {},
      ) => {
        const hid = rows()
          .filter((r) => match(r, razresiWhere(args.where), store))
          .map((r) => hidratiraj(r, projekcija(args)) as Row);
        const f = sortiraj(hid, args.orderBy);
        return args.take ? f.slice(0, args.take) : f;
      },
    ),
    findFirst: jest.fn(
      (
        args: {
          where?: Row;
          orderBy?: unknown;
          select?: unknown;
          include?: unknown;
        } = {},
      ) =>
        hidratiraj(
          sortiraj(
            rows().filter((r) => match(r, razresiWhere(args.where), store)),
            args.orderBy,
          )[0] ?? null,
          projekcija(args),
        ),
    ),
    findUnique: jest.fn(
      (args: { where: Row; select?: unknown; include?: unknown }) => {
        const w = razresiWhere(args.where) as Row;
        return hidratiraj(
          rows().find((r) => match(r, w, store)) ?? null,
          projekcija(args),
        );
      },
    ),
    create: jest.fn(({ data }: { data: Row }) => {
      const red: Row = { id: data.id ?? `gen-${rows().length + 1}`, ...data };
      rows().push(red);
      return red;
    }),
    update: jest.fn(({ where, data }: { where: Row; data: Row }) => {
      const red = rows().find((r) =>
        match(r, razresiWhere(where) as Row, store),
      );
      if (!red) throw new Error("not found");
      Object.assign(red, data);
      return red;
    }),
    updateMany: jest.fn(({ where, data }: { where?: Row; data: Row }) => {
      const izabrani = rows().filter((r) =>
        match(r, razresiWhere(where), store),
      );
      for (const r of izabrani) Object.assign(r, data);
      return { count: izabrani.length };
    }),
    deleteMany: jest.fn(({ where }: { where?: Row } = {}) => {
      const ostaju = rows().filter(
        (r) => !match(r, razresiWhere(where), store),
      );
      const n = rows().length - ostaju.length;
      store[name] = ostaju;
      return { count: n };
    }),
    upsert: jest.fn(
      ({ where, create, update }: { where: Row; create: Row; update: Row }) => {
        const w = razresiWhere(where) as Row;
        const red = rows().find((r) => match(r, w, store));
        if (red) {
          Object.assign(red, update);
          return red;
        }
        const nov: Row = { id: `gen-${rows().length + 1}`, ...create };
        rows().push(nov);
        return nov;
      },
    ),
  };
}

type ModelMock = ReturnType<typeof model>;

interface FakePrisma {
  __store: Store;
  __gucevi: string[];
  user: ModelMock;
  userRole: ModelMock;
  employee: ModelMock;
  kadrSalaryViewerAllowlist: ModelMock;
  kadrGridEditorAllowlist: ModelMock;
  salaryTerm: ModelMock;
  salaryPayroll: ModelMock;
  workHour: ModelMock;
  attendanceEvent: ModelMock;
  attendanceCorrection: ModelMock;
  attendanceNotifyExtra: ModelMock;
  kadrNotificationLog: ModelMock;
  employeeBadge: ModelMock;
  auditLog: ModelMock;
  $queryRaw: jest.Mock;
  $transaction: jest.Mock;
}

function fakePrisma(seed: Seed = {}): FakePrisma {
  const store: Store = {
    employees: seed.employees ?? [],
    users: seed.users ?? [],
    userRoles: seed.userRoles ?? [],
    kadrSalaryViewerAllowlist: (seed.salaryViewers ?? []).map((email) => ({
      email,
    })),
    kadrGridEditorAllowlist: (seed.gridEditors ?? []).map((email) => ({
      email,
    })),
    salaryTerms: seed.salaryTerms ?? [],
    salaryPayroll: seed.salaryPayroll ?? [],
    workHours: seed.workHours ?? [],
    attendanceEvents: seed.attendanceEvents ?? [],
    attendanceCorrections: seed.attendanceCorrections ?? [],
    attendanceNotifyExtra: seed.attendanceNotifyExtra ?? [],
    kadrNotificationLog: seed.kadrNotificationLog ?? [],
    employeeBadges: seed.employeeBadges ?? [],
    auditLog: seed.auditLog ?? [],
  };
  const gucevi: string[] = [];
  // Eksplicitna anotacija je OBAVEZNA: `$transaction` u inicijalizatoru
  // referiše `client`, pa bez tipa TS pada na TS7022 (implicitni `any`).
  const client: FakePrisma = {
    __store: store,
    __gucevi: gucevi,
    user: model(store, "users"),
    userRole: model(store, "userRoles"),
    employee: model(store, "employees"),
    kadrSalaryViewerAllowlist: model(store, "kadrSalaryViewerAllowlist"),
    kadrGridEditorAllowlist: model(store, "kadrGridEditorAllowlist"),
    salaryTerm: model(store, "salaryTerms"),
    salaryPayroll: model(
      store,
      "salaryPayroll",
      "employeeId_periodYear_periodMonth",
    ),
    workHour: model(store, "workHours", "employeeId_workDate"),
    attendanceEvent: model(store, "attendanceEvents"),
    attendanceCorrection: model(store, "attendanceCorrections"),
    attendanceNotifyExtra: model(store, "attendanceNotifyExtra"),
    kadrNotificationLog: model(store, "kadrNotificationLog"),
    employeeBadge: model(store, "employeeBadges"),
    auditLog: model(store, "auditLog"),
    // Prisma tagged template: prvi argument JE `TemplateStringsArray`.
    $queryRaw: jest.fn((q: unknown) => {
      const tekst = Array.isArray(q) ? (q as string[]).join("") : String(q);
      if (tekst.includes("set_config")) {
        gucevi.push("payroll.unlock_ok=on");
        return [];
      }
      return [{ max: 0n }];
    }),
    $transaction: jest.fn((cb: (tx: unknown) => Promise<unknown>) =>
      cb(client),
    ),
  };
  return client;
}

function svc(seed: Seed = {}) {
  const prisma = fakePrisma(seed);
  return {
    s: new KadrovskaFnPlateService(prisma as unknown as PrismaService),
    prisma,
  };
}

const D = (v: number | string) => new Prisma.Decimal(v);
const dan = (v: string) => new Date(`${v}T00:00:00Z`);

// ── Identiteti iz tabele istinitosti ────────────────────────────────────────
const NA_SPISKU = "nevena.knezevic@servoteh.com";
const VAN_SPISKA = "radnik@servoteh.com";
const ADMIN_VAN_SPISKA = "admin@servoteh.com";
const HR_VAN_SPISKA = "hr@servoteh.com";
const POSLOVNI_VAN_SPISKA = "poslovni@servoteh.com";

const EMP = "11111111-1111-1111-1111-111111111111";
const EMP2 = "22222222-2222-2222-2222-222222222222";

/** Zajednički seed: 2 zaposlena, 1 uslov zarade, 2 reda obračuna, 5 identiteta. */
function seedPlate(): Seed {
  return {
    salaryViewers: [NA_SPISKU],
    users: [
      { id: 1, email: NA_SPISKU, role: "hr", active: true },
      { id: 2, email: VAN_SPISKA, role: "proizvodni_radnik", active: true },
      { id: 3, email: ADMIN_VAN_SPISKA, role: "admin", active: true },
      { id: 4, email: HR_VAN_SPISKA, role: "hr", active: true },
      {
        id: 5,
        email: POSLOVNI_VAN_SPISKA,
        role: "poslovni_admin",
        active: true,
      },
    ],
    userRoles: [],
    employees: [
      {
        id: EMP,
        fullName: "Petrovic Petar",
        email: "petar@servoteh.com",
        isActive: true,
        subDepartmentId: 7,
        position: "Bravar",
        department: "Montaza",
        workType: "ugovor",
        hireDate: dan("2020-01-01"),
        phone: "",
      },
      {
        id: EMP2,
        fullName: "Ilic Ilija",
        email: "ilija@servoteh.com",
        isActive: true,
        subDepartmentId: 7,
        position: "Varilac",
        department: "Montaza",
        workType: "ugovor",
        hireDate: dan("2021-01-01"),
        phone: "",
      },
    ],
    salaryTerms: [
      {
        id: "t-1",
        employeeId: EMP,
        salaryType: "ugovor",
        compensationModel: "fiksno",
        effectiveFrom: dan("2026-01-01"),
        effectiveTo: null,
        amount: D(100000),
        amountType: "neto",
        currency: "RSD",
        netoRsd: D(100000),
        brutoRsd: D(140000),
        approvedBy: "nenad",
        approvedAt: dan("2026-01-01"),
        createdAt: new Date("2026-01-01T00:00:00Z"),
        transportAllowanceRsd: D(3000),
        perDiemRsd: D(0),
        perDiemEur: D(0),
        hourlyRate: null,
        fixedAmount: D(0),
        fixedTransportComponent: D(0),
        fixedExtraHourRate: D(0),
        firstPartAmount: D(0),
        splitHourRate: D(0),
        splitTransportAmount: D(0),
        hourlyTransportAmount: D(0),
        terrainDomesticRate: D(0),
        terrainForeignRate: D(0),
        contractRef: null,
      },
    ],
    salaryPayroll: [
      {
        id: "p-1",
        employeeId: EMP,
        periodYear: 2026,
        periodMonth: 7,
        status: "draft",
        updatedAt: new Date("2026-08-01T10:00:00Z"),
        totalRsd: D(100000),
        ukupnaZarada: D(0),
        salaryType: "ugovor",
        compensationModel: "fiksno",
        advanceAmount: D(0),
        advancePaidOn: dan("2026-07-20"),
        advanceNote: "",
        fixedSalary: D(100000),
        hoursWorked: D(0),
        hourlyRate: D(0),
        transportRsd: D(3000),
        domesticDays: 0,
        perDiemRsd: D(0),
        foreignDays: 0,
        perDiemEur: D(0),
        finalPaidOn: dan("2026-08-05"),
        note: "",
        fondSatiMeseca: D(0),
        redovanRadSati: D(0),
        prekovremeniSati: D(0),
        praznikPlaceniSati: D(0),
        praznikRadSati: D(0),
        godisnjiSati: D(0),
        slobodniDaniSati: D(0),
        bolovanje65Sati: D(0),
        bolovanje100Sati: D(0),
        dveMasineSati: D(0),
        terenUZemljiCount: 0,
        terenUInostranstvuCount: 0,
        payableHours: D(0),
        prviDeo: D(0),
        preostaloZaIsplatu: D(0),
        warnings: [],
      },
      {
        id: "p-2",
        employeeId: EMP2,
        periodYear: 2026,
        periodMonth: 7,
        status: "paid",
        updatedAt: new Date("2026-08-02T10:00:00Z"),
        totalRsd: D(90000),
        ukupnaZarada: D(0),
        salaryType: "ugovor",
        compensationModel: "fiksno",
        advanceAmount: D(0),
        advancePaidOn: null,
        advanceNote: "",
        fixedSalary: D(90000),
        hoursWorked: D(0),
        hourlyRate: D(0),
        transportRsd: D(0),
        domesticDays: 0,
        perDiemRsd: D(0),
        foreignDays: 0,
        perDiemEur: D(0),
        finalPaidOn: null,
        note: "",
        fondSatiMeseca: D(0),
        redovanRadSati: D(0),
        prekovremeniSati: D(0),
        praznikPlaceniSati: D(0),
        praznikRadSati: D(0),
        godisnjiSati: D(0),
        slobodniDaniSati: D(0),
        bolovanje65Sati: D(0),
        bolovanje100Sati: D(0),
        dveMasineSati: D(0),
        terenUZemljiCount: 0,
        terenUInostranstvuCount: 0,
        payableHours: D(0),
        prviDeo: D(0),
        preostaloZaIsplatu: D(0),
        warnings: [],
      },
    ],
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// 🔴 1. TABELA ISTINITOSTI — brava nad platama
// ══════════════════════════════════════════════════════════════════════════════

describe("🔴 brava nad platama = kadr_salary_viewer_allowlist (tabela istinitosti)", () => {
  interface Ocekivano {
    ime: string;
    email: string | null | undefined;
    contractSalary: "vidi" | "null";
    contractBruto: "vidi" | "null";
    payrollRedova: number;
    mutacijeDozvoljene: boolean;
    setContractDozvoljen: boolean;
  }

  const TABELA: Ocekivano[] = [
    {
      ime: "NA SPISKU",
      email: NA_SPISKU,
      contractSalary: "vidi",
      contractBruto: "vidi",
      payrollRedova: 2,
      mutacijeDozvoljene: true,
      setContractDozvoljen: true,
    },
    {
      ime: "VAN SPISKA, bez role",
      email: VAN_SPISKA,
      contractSalary: "null",
      contractBruto: "null",
      payrollRedova: 0,
      mutacijeDozvoljene: false,
      setContractDozvoljen: false,
    },
    {
      ime: "🔴 ADMIN van spiska",
      email: ADMIN_VAN_SPISKA,
      contractSalary: "null",
      contractBruto: "null",
      payrollRedova: 0,
      mutacijeDozvoljene: false,
      setContractDozvoljen: false,
    },
    {
      ime: "🔴 HR van spiska",
      email: HR_VAN_SPISKA,
      contractSalary: "null",
      contractBruto: "null",
      payrollRedova: 0,
      mutacijeDozvoljene: false,
      setContractDozvoljen: false,
    },
    {
      ime: "🔴 POSLOVNI_ADMIN van spiska",
      email: POSLOVNI_VAN_SPISKA,
      contractSalary: "null",
      // IZMERENA grana `OR current_user_is_poslovni_admin()`.
      contractBruto: "vidi",
      payrollRedova: 0,
      mutacijeDozvoljene: false,
      setContractDozvoljen: true,
    },
    {
      ime: "prazan mejl",
      email: "",
      contractSalary: "null",
      contractBruto: "null",
      payrollRedova: 0,
      mutacijeDozvoljene: false,
      setContractDozvoljen: false,
    },
    {
      ime: "nepoznat mejl",
      email: "nikonijenaspisku@servoteh.com",
      contractSalary: "null",
      contractBruto: "null",
      payrollRedova: 0,
      mutacijeDozvoljene: false,
      setContractDozvoljen: false,
    },
  ];

  for (const red of TABELA) {
    describe(red.ime, () => {
      it(`kadr_get_contract_salary -> ${red.contractSalary}`, async () => {
        const { s } = svc(seedPlate());
        const r = await s.getContractSalary(red.email, EMP);
        if (red.contractSalary === "vidi") {
          expect(r).not.toBeNull();
          expect(r?.neto_rsd).toEqual(D(100000));
        } else {
          expect(r).toBeNull();
        }
      });

      it(`kadr_get_contract_bruto -> ${red.contractBruto}`, async () => {
        const { s } = svc(seedPlate());
        const r = await s.getContractBruto(red.email, EMP);
        if (red.contractBruto === "vidi") {
          expect(r).toEqual(D(140000));
        } else {
          expect(r).toBeNull();
        }
      });

      // 🔴 TAČAN BROJ REDOVA, nikad „> 0" (pouka mutacione probe od 08.08.).
      it(`v_salary_payroll_month -> TAČNO ${red.payrollRedova} reda`, async () => {
        const { s } = svc(seedPlate());
        const r = await s.listPayrollMonth(red.email, 2026, 7);
        expect(r).toHaveLength(red.payrollRedova);
      });

      it(
        red.mutacijeDozvoljene
          ? "init/upsert/unlock prolaze"
          : "init/upsert/unlock su 403 (permission_denied)",
        async () => {
          const { s, prisma } = svc(seedPlate());
          const pre = prisma.__store.salaryPayroll.length;
          if (red.mutacijeDozvoljene) {
            await expect(
              s.payrollInitMonth(red.email, 2026, 8),
            ).resolves.toBeGreaterThan(0);
            await expect(
              s.payrollUnlock(red.email, "p-2"),
            ).resolves.toMatchObject({ status: "unlocked" });
          } else {
            await expect(
              s.payrollInitMonth(red.email, 2026, 8),
            ).rejects.toThrow(ForbiddenException);
            await expect(
              s.upsertSalaryPayroll(red.email, { id: "p-1" }),
            ).rejects.toThrow(ForbiddenException);
            await expect(s.payrollUnlock(red.email, "p-2")).rejects.toThrow(
              ForbiddenException,
            );
            // Nijedan red se nije pomerio — brana je pre svakog upisa.
            expect(prisma.__store.salaryPayroll).toHaveLength(pre);
            expect(
              prisma.__store.salaryPayroll.find((r) => r.id === "p-2")?.status,
            ).toBe("paid");
          }
        },
      );

      it(
        red.setContractDozvoljen
          ? "kadr_set_contract_salary prolazi"
          : "kadr_set_contract_salary je 403 (not_allowed)",
        async () => {
          const { s, prisma } = svc(seedPlate());
          const poziv = s.setContractSalary(red.email, {
            employeeId: EMP,
            neto: 111000,
            bruto: 150000,
            effectiveFrom: "2026-09-01",
          });
          if (red.setContractDozvoljen) {
            await expect(poziv).resolves.toMatchObject({ status: "created" });
            expect(prisma.__store.salaryTerms).toHaveLength(2);
          } else {
            await expect(poziv).rejects.toThrow(ForbiddenException);
            expect(prisma.__store.salaryTerms).toHaveLength(1);
          }
        },
      );
    });
  }

  it("brava ne gleda NIJEDNU rolu — allowlist bez ijedne role je dovoljan", async () => {
    const { s } = svc({
      salaryViewers: ["samo.allowlist@servoteh.com"],
      users: [],
      employees: [{ id: EMP, isActive: true }],
      salaryTerms: [],
    });
    // Nema `users` reda -> nema ni jedne role, a brava ipak pušta.
    await expect(s.canViewSalary("samo.allowlist@servoteh.com")).resolves.toBe(
      true,
    );
    await expect(s.isAdmin("samo.allowlist@servoteh.com")).resolves.toBe(false);
  });

  it("poređenje mejla je case-insensitive na OBE strane (lower(...) = lower(...))", async () => {
    const { s } = svc({ salaryViewers: ["Nevena.Knezevic@Servoteh.com"] });
    await expect(s.canViewSalary("nevena.knezevic@SERVOTEH.com")).resolves.toBe(
      true,
    );
  });

  it("prazan/nedostajući mejl je FALSE — nikad 'nije nađen red pa pusti'", async () => {
    const { s } = svc({ salaryViewers: [NA_SPISKU] });
    await expect(s.canViewSalary("")).resolves.toBe(false);
    await expect(s.canViewSalary(null)).resolves.toBe(false);
    await expect(s.canViewSalary(undefined)).resolves.toBe(false);
    await expect(s.canViewSalary("   ")).resolves.toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. hr_upsert_salary_payroll — zaključavanje i optimistička provera
// ══════════════════════════════════════════════════════════════════════════════

describe("hr_upsert_salary_payroll — paritet ishoda", () => {
  it("status='paid' -> {applied:false, reason:'locked'} i NIJEDNA kolona se ne menja", async () => {
    const { s, prisma } = svc(seedPlate());
    const r = await s.upsertSalaryPayroll(NA_SPISKU, {
      id: "p-2",
      expected_updated_at: "2026-08-02T10:00:00Z",
      fixed_salary: 999999,
    });
    expect(r).toMatchObject({ applied: false, reason: "locked" });
    const red = prisma.__store.salaryPayroll.find((x) => x.id === "p-2");
    expect(red?.fixedSalary).toEqual(D(90000));
  });

  it("bez expected_updated_at -> 'stale' (NULL NIJE 'preskoči proveru')", async () => {
    const { s } = svc(seedPlate());
    const r = await s.upsertSalaryPayroll(NA_SPISKU, {
      id: "p-1",
      fixed_salary: 5,
    });
    expect(r).toMatchObject({ applied: false, reason: "stale" });
  });

  it("pogrešan expected_updated_at -> 'stale'", async () => {
    const { s } = svc(seedPlate());
    const r = await s.upsertSalaryPayroll(NA_SPISKU, {
      id: "p-1",
      expected_updated_at: "2020-01-01T00:00:00Z",
    });
    expect(r).toMatchObject({ applied: false, reason: "stale" });
  });

  it("tačan expected_updated_at -> applied:true", async () => {
    const { s, prisma } = svc(seedPlate());
    const r = await s.upsertSalaryPayroll(NA_SPISKU, {
      id: "p-1",
      expected_updated_at: "2026-08-01T10:00:00Z",
      note: "ispravka",
    });
    expect(r).toMatchObject({ applied: true, id: "p-1" });
    expect(prisma.__store.salaryPayroll.find((x) => x.id === "p-1")?.note).toBe(
      "ispravka",
    );
  });

  it("INSERT na postojeći (employee, year, month) -> 'row_exists' sa postojećim id-om", async () => {
    const { s } = svc(seedPlate());
    const r = await s.upsertSalaryPayroll(NA_SPISKU, {
      employee_id: EMP,
      period_year: 2026,
      period_month: 7,
    });
    expect(r).toMatchObject({
      applied: false,
      reason: "row_exists",
      existing_id: "p-1",
    });
  });

  it("UPDATE nepostojećeg id-a -> 422 salary_payroll_row_missing", async () => {
    const { s } = svc(seedPlate());
    await expect(
      s.upsertSalaryPayroll(NA_SPISKU, {
        id: "33333333-3333-3333-3333-333333333333",
        expected_updated_at: "2026-08-01T10:00:00Z",
      }),
    ).rejects.toThrow(UnprocessableEntityException);
  });

  it("🔴 ZATEČENO: delimičan upis BRIŠE advance_paid_on i final_paid_on", async () => {
    const { s, prisma } = svc(seedPlate());
    await s.upsertSalaryPayroll(NA_SPISKU, {
      id: "p-1",
      expected_updated_at: "2026-08-01T10:00:00Z",
      note: "samo napomena",
    });
    const red = prisma.__store.salaryPayroll.find((x) => x.id === "p-1");
    // Nije popravljeno namerno — modul je zamrznut (§K). Test pinuje ZATEČENO
    // ponašanje da se ne izgubi u prepisu i da se vidi kad ga neko promeni.
    expect(red?.advancePaidOn).toBeNull();
    expect(red?.finalPaidOn).toBeNull();
    // Sve OSTALO je sačuvano (COALESCE), pa je razlika stvarno u tim dvema.
    expect(red?.fixedSalary).toEqual(D(100000));
    expect(red?.transportRsd).toEqual(D(3000));
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. kadr_payroll_unlock — GUC mora ići U TRANSAKCIJI
// ══════════════════════════════════════════════════════════════════════════════

describe("kadr_payroll_unlock", () => {
  it("paid -> finalized, uz set_config('payroll.unlock_ok') U ISTOJ transakciji", async () => {
    const { s, prisma } = svc(seedPlate());
    const r = await s.payrollUnlock(NA_SPISKU, "p-2");
    expect(r).toMatchObject({ status: "unlocked", new_status: "finalized" });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // Bez GUC-a brana `trg_0_salary_payroll_immutability` odbija upis.
    expect(prisma.__gucevi).toContain("payroll.unlock_ok=on");
  });

  it("red koji nije 'paid' -> noop (idempotentno, bez greške)", async () => {
    const { s } = svc(seedPlate());
    await expect(s.payrollUnlock(NA_SPISKU, "p-1")).resolves.toMatchObject({
      status: "noop",
      reason: "not_paid_or_missing",
    });
  });

  it("nepostojeći red -> noop, ne 404", async () => {
    const { s } = svc(seedPlate());
    await expect(s.payrollUnlock(NA_SPISKU, "nema")).resolves.toMatchObject({
      status: "noop",
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. kadr_set_contract_salary — četiri ishoda
// ══════════════════════════════════════════════════════════════════════════════

describe("kadr_set_contract_salary", () => {
  it("isti neto i bruto -> 'unchanged', istorija se NE dira", async () => {
    const { s, prisma } = svc(seedPlate());
    const r = await s.setContractSalary(NA_SPISKU, {
      employeeId: EMP,
      neto: 100000,
      bruto: 140000,
      effectiveFrom: "2026-08-01",
    });
    expect(r).toEqual({ status: "unchanged", term_id: "t-1" });
    expect(prisma.__store.salaryTerms).toHaveLength(1);
  });

  it("isti 'važi od' -> 'updated' (ispravka U MESTU, bez novog reda)", async () => {
    const { s, prisma } = svc(seedPlate());
    const r = await s.setContractSalary(NA_SPISKU, {
      employeeId: EMP,
      neto: 105000,
      bruto: 145000,
      effectiveFrom: "2026-01-01",
    });
    expect(r).toEqual({ status: "updated", term_id: "t-1" });
    expect(prisma.__store.salaryTerms).toHaveLength(1);
    expect(prisma.__store.salaryTerms[0].netoRsd).toEqual(D(105000));
  });

  it("novi 'važi od' -> 'created' i parametri obračuna se PRENOSE sa prethodnog", async () => {
    const { s, prisma } = svc(seedPlate());
    await s.setContractSalary(NA_SPISKU, {
      employeeId: EMP,
      neto: 120000,
      bruto: 165000,
      effectiveFrom: "2026-09-01",
    });
    const nov = prisma.__store.salaryTerms[1];
    expect(nov.transportAllowanceRsd).toEqual(D(3000));
    expect(nov.compensationModel).toBe("fiksno");
    expect(nov.note).toBe("Izmena ugovorne zarade (forma zaposlenog)");
    // `v_touch_amount`: ugovor + RSD -> amount se prepisuje netom.
    expect(nov.amount).toEqual(D(120000));
    expect(nov.amountType).toBe("neto");
  });

  it("satnica/devize: `amount` se NE prepisuje netom (druga semantika)", async () => {
    const seed = seedPlate();
    seed.salaryTerms = [
      {
        ...(seed.salaryTerms as Row[])[0],
        salaryType: "satnica",
        amount: D(450),
        amountType: "neto",
      },
    ];
    const { s, prisma } = svc(seed);
    await s.setContractSalary(NA_SPISKU, {
      employeeId: EMP,
      neto: 120000,
      bruto: 165000,
      effectiveFrom: "2026-09-01",
    });
    expect(prisma.__store.salaryTerms[1].amount).toEqual(D(450));
  });

  it("prvi unos (nema prethodnog) -> ugovor + model 'fiksno'", async () => {
    const seed = seedPlate();
    seed.salaryTerms = [];
    const { s, prisma } = svc(seed);
    const r = await s.setContractSalary(NA_SPISKU, {
      employeeId: EMP,
      neto: 90000,
      bruto: 125000,
    });
    expect(r.status).toBe("created");
    expect(prisma.__store.salaryTerms[0].salaryType).toBe("ugovor");
    expect(prisma.__store.salaryTerms[0].compensationModel).toBe("fiksno");
  });

  it("bruto < neto ili nula -> 422 invalid_amount", async () => {
    const { s } = svc(seedPlate());
    await expect(
      s.setContractSalary(NA_SPISKU, { employeeId: EMP, neto: 100, bruto: 50 }),
    ).rejects.toThrow(UnprocessableEntityException);
    await expect(
      s.setContractSalary(NA_SPISKU, { employeeId: EMP, neto: 0, bruto: 10 }),
    ).rejects.toThrow(UnprocessableEntityException);
  });

  it("nepoznat zaposleni -> 422 employee_not_found", async () => {
    const { s } = svc(seedPlate());
    await expect(
      s.setContractSalary(NA_SPISKU, {
        employeeId: "44444444-4444-4444-4444-444444444444",
        neto: 100,
        bruto: 200,
      }),
    ).rejects.toThrow(UnprocessableEntityException);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 5. kadr_payroll_init_month
// ══════════════════════════════════════════════════════════════════════════════

describe("kadr_payroll_init_month", () => {
  it("otvara TAČNO onoliko redova koliko aktivnih zaposlenih nema red", async () => {
    const { s, prisma } = svc(seedPlate());
    // Za 2026/7 oba zaposlena već imaju red -> 0 novih.
    await expect(s.payrollInitMonth(NA_SPISKU, 2026, 7)).resolves.toBe(0);
    // Za 2026/8 nijedan -> tačno 2.
    await expect(s.payrollInitMonth(NA_SPISKU, 2026, 8)).resolves.toBe(2);
    expect(
      prisma.__store.salaryPayroll.filter((r) => r.periodMonth === 8),
    ).toHaveLength(2);
  });

  it("warnings: bez uslova zarade -> no_salary_terms; bez modela -> no_compensation_model", async () => {
    const seed = seedPlate();
    (seed.salaryTerms as Row[])[0].compensationModel = null;
    const { s, prisma } = svc(seed);
    await s.payrollInitMonth(NA_SPISKU, 2026, 8);
    const zaEmp = prisma.__store.salaryPayroll.find(
      (r) => r.periodMonth === 8 && r.employeeId === EMP,
    );
    const zaEmp2 = prisma.__store.salaryPayroll.find(
      (r) => r.periodMonth === 8 && r.employeeId === EMP2,
    );
    expect((zaEmp?.warnings as Row[])[0].code).toBe("no_compensation_model");
    expect((zaEmp2?.warnings as Row[])[0].code).toBe("no_salary_terms");
  });

  it("mesec van 1..12 -> 422", async () => {
    const { s } = svc(seedPlate());
    await expect(s.payrollInitMonth(NA_SPISKU, 2026, 13)).rejects.toThrow(
      UnprocessableEntityException,
    );
  });

  it("neaktivan zaposleni se PRESKAČE", async () => {
    const seed = seedPlate();
    (seed.employees as Row[])[1].isActive = false;
    const { s } = svc(seed);
    await expect(s.payrollInitMonth(NA_SPISKU, 2026, 8)).resolves.toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 6. 🔴 kadr_queue_payroll_notifications — funkcija koja NIKAD nije proradila
// ══════════════════════════════════════════════════════════════════════════════

describe("🔴 kadr_queue_payroll_notifications (zatečeno: 23502)", () => {
  const seedSati = (): Seed => {
    const s = seedPlate();
    (s.employees as Row[])[0].email = "petar@servoteh.com";
    s.workHours = [
      {
        id: "w-1",
        employeeId: EMP,
        workDate: dan("2026-07-01"),
        hours: D(8),
        overtimeHours: D(2),
        fieldHours: D(0),
        twoMachineHours: D(0),
        absenceCode: null,
      },
    ];
    return s;
  };

  it("pada sa payroll_notifications_not_null_violation i NE upisuje nijednu poruku", async () => {
    const { s, prisma } = svc(seedSati());
    await expect(s.queuePayrollNotifications(2026, 7)).rejects.toThrow(
      UnprocessableEntityException,
    );
    // Dokaz iz produkcije: 17 tipova u `kadr_notification_log`, `payroll_statement` 0.
    expect(prisma.__store.kadrNotificationLog).toHaveLength(0);
  });

  it("bez ijednog reda sati ne pada — nema šta da upiše (paritet praznog LOOP-a)", async () => {
    const seed = seedSati();
    seed.workHours = [];
    const { s } = svc(seed);
    await expect(s.queuePayrollNotifications(2026, 7)).resolves.toBe(0);
  });

  it("zaposleni bez mejla i bez telefona se preskače (nema INSERT-a, nema greške)", async () => {
    const seed = seedSati();
    (seed.employees as Row[])[0].email = "";
    (seed.employees as Row[])[0].phone = "";
    const { s } = svc(seed);
    await expect(s.queuePayrollNotifications(2026, 7)).resolves.toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 7. PRISUSTVO — hr_upsert_work_hours_batch
// ══════════════════════════════════════════════════════════════════════════════

describe("hr_upsert_work_hours_batch", () => {
  const seedGrid = (): Seed => ({
    gridEditors: ["nevena.knezevic@servoteh.com"],
    users: [
      { id: 3, email: ADMIN_VAN_SPISKA, role: "admin", active: true },
      { id: 2, email: VAN_SPISKA, role: "proizvodni_radnik", active: true },
    ],
    employees: [{ id: EMP, fullName: "Petrovic Petar", isActive: true }],
    workHours: [],
  });

  it("🔴 gejt je ALLOWLIST, ne rola: admin van spiska dobija 403 i NE upisuje", async () => {
    const { s, prisma } = svc(seedGrid());
    await expect(
      s.upsertWorkHoursBatch(ADMIN_VAN_SPISKA, [
        { employee_id: EMP, work_date: "2026-08-03", hours: 8 },
      ]),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.__store.workHours).toHaveLength(0);
  });

  it("na spisku: upisuje TAČNO onoliko redova koliko je poslato", async () => {
    const { s, prisma } = svc(seedGrid());
    const r = await s.upsertWorkHoursBatch("nevena.knezevic@servoteh.com", [
      { employee_id: EMP, work_date: "2026-08-03", hours: 8 },
      { employee_id: EMP, work_date: "2026-08-04", hours: 7.5 },
    ]);
    expect(r.applied).toBe(2);
    expect(prisma.__store.workHours).toHaveLength(2);
    expect(prisma.__store.workHours[0].lastEditedBy).toBe(
      "nevena.knezevic@servoteh.com",
    );
  });

  it("ON CONFLICT DO UPDATE: drugi upis istog dana MENJA red, ne dodaje", async () => {
    const { s, prisma } = svc(seedGrid());
    await s.upsertWorkHoursBatch("nevena.knezevic@servoteh.com", [
      { employee_id: EMP, work_date: "2026-08-03", hours: 8 },
    ]);
    await s.upsertWorkHoursBatch("nevena.knezevic@servoteh.com", [
      { employee_id: EMP, work_date: "2026-08-03", hours: 4 },
    ]);
    expect(prisma.__store.workHours).toHaveLength(1);
    expect(prisma.__store.workHours[0].hours).toEqual(D(4));
  });

  it("field_subtype van {domestic, foreign} se TIHO baca na NULL", async () => {
    const { s, prisma } = svc(seedGrid());
    await s.upsertWorkHoursBatch("nevena.knezevic@servoteh.com", [
      {
        employee_id: EMP,
        work_date: "2026-08-03",
        field_subtype: "izmisljeno",
      },
    ]);
    expect(prisma.__store.workHours[0].fieldSubtype).toBeNull();
  });

  it("prazan absence_code/subtype -> NULL (NULLIF(...,''))", async () => {
    const { s, prisma } = svc(seedGrid());
    await s.upsertWorkHoursBatch("nevena.knezevic@servoteh.com", [
      {
        employee_id: EMP,
        work_date: "2026-08-03",
        absence_code: "",
        absence_subtype: "",
      },
    ]);
    expect(prisma.__store.workHours[0].absenceCode).toBeNull();
    expect(prisma.__store.workHours[0].absenceSubtype).toBeNull();
  });

  it("🔴 ZATEČENO: `conflicts` je uvek prazan — funkcija ne detektuje sudare", async () => {
    const { s } = svc(seedGrid());
    const r = await s.upsertWorkHoursBatch("nevena.knezevic@servoteh.com", [
      { employee_id: EMP, work_date: "2026-08-03", hours: 8 },
    ]);
    expect(r.conflicts).toEqual([]);
  });

  it("ne-array ulaz -> 422 invalid_payload", async () => {
    const { s } = svc(seedGrid());
    await expect(
      s.upsertWorkHoursBatch(
        "nevena.knezevic@servoteh.com",
        {} as unknown as never,
      ),
    ).rejects.toThrow(UnprocessableEntityException);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 8. kadr_work_hours_audit — gejt + prazan izvor
// ══════════════════════════════════════════════════════════════════════════════

describe("kadr_work_hours_audit", () => {
  const seedAudit = (): Seed => ({
    gridEditors: ["nevena.knezevic@servoteh.com"],
    users: [
      { id: 3, email: ADMIN_VAN_SPISKA, role: "admin", active: true },
      { id: 2, email: VAN_SPISKA, role: "proizvodni_radnik", active: true },
    ],
    auditLog: [],
  });

  it("gejt je `grid_edit ILI admin` — obični korisnik dobija 403", async () => {
    const { s } = svc(seedAudit());
    await expect(s.workHoursAudit(VAN_SPISKA)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it("admin PROLAZI i bez allowlist-a (druga grana gejta)", async () => {
    const { s } = svc(seedAudit());
    await expect(s.workHoursAudit(ADMIN_VAN_SPISKA)).resolves.toMatchObject({
      auditIzvorPrenet: false,
      rows: [],
    });
  });

  it("🔴 prazan izvor je NAZNAČEN (`auditIzvorPrenet:false`), ne tiha nula", async () => {
    const { s } = svc(seedAudit());
    const r = await s.workHoursAudit("nevena.knezevic@servoteh.com");
    expect(r.auditIzvorPrenet).toBe(false);
    expect(r.rows).toHaveLength(0);
  });

  it("kad izvor postoji: filtri po zaposlenom i opsegu datuma rade, diff_keys se izvodi", async () => {
    const seed = seedAudit();
    seed.auditLog = [
      {
        id: 1,
        entityType: "work_hours",
        action: "UPDATE",
        actorUsername: "nevena.knezevic@servoteh.com",
        createdAt: new Date("2026-08-03T09:00:00Z"),
        beforeData: { employee_id: EMP, work_date: "2026-08-01", hours: "8" },
        afterData: { employee_id: EMP, work_date: "2026-08-01", hours: "4" },
      },
      {
        id: 2,
        entityType: "work_hours",
        action: "UPDATE",
        actorUsername: "nevena.knezevic@servoteh.com",
        createdAt: new Date("2026-08-04T09:00:00Z"),
        beforeData: { employee_id: EMP2, work_date: "2026-07-01", hours: "8" },
        afterData: { employee_id: EMP2, work_date: "2026-07-01", hours: "6" },
      },
    ];
    const { s } = svc(seed);
    const svi = await s.workHoursAudit("nevena.knezevic@servoteh.com");
    expect(svi.auditIzvorPrenet).toBe(true);
    expect(svi.rows).toHaveLength(2);
    expect(svi.rows[0].diffKeys).toEqual(["hours"]);

    const zaEmp = await s.workHoursAudit("nevena.knezevic@servoteh.com", {
      employeeId: EMP,
    });
    expect(zaEmp.rows).toHaveLength(1);

    const uAvgustu = await s.workHoursAudit("nevena.knezevic@servoteh.com", {
      dateFrom: "2026-08-01",
    });
    expect(uAvgustu.rows).toHaveLength(1);
  });

  it("limit se steže na [1, 1000] (least/greatest iz izvora)", async () => {
    const seed = seedAudit();
    seed.auditLog = Array.from({ length: 5 }, (_, i) => ({
      id: i + 1,
      entityType: "work_hours",
      action: "UPDATE",
      actorUsername: "x",
      createdAt: new Date(`2026-08-0${i + 1}T09:00:00Z`),
      beforeData: null,
      afterData: null,
    }));
    const { s, prisma } = svc(seed);
    await s.workHoursAudit("nevena.knezevic@servoteh.com", { limit: -5 });
    expect(prisma.auditLog.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ take: 1 }),
    );
    await s.workHoursAudit("nevena.knezevic@servoteh.com", { limit: 99999 });
    expect(prisma.auditLog.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ take: 1000 }),
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 9. v_attendance_daily — dedup i uparivanje (prelazni režim Katze mosta)
// ══════════════════════════════════════════════════════════════════════════════

describe("v_attendance_daily (racunajDnevnoPrisustvo)", () => {
  const ev = (
    id: number,
    ts: string,
    direction: string,
    employeeId = EMP,
  ): PunchEvent => ({
    id: BigInt(id),
    employeeId,
    eventTsLocal: new Date(`${ts}Z`),
    direction,
  });

  it("🔴 tri ista otkucaja u istoj sekundi ostaju JEDAN (dedup <= 1 min)", () => {
    const m = racunajDnevnoPrisustvo([
      ev(1, "2026-08-03T07:00:00", "in"),
      ev(2, "2026-08-03T07:00:00", "in"),
      ev(3, "2026-08-03T07:00:00", "in"),
      ev(4, "2026-08-03T15:00:00", "out"),
    ]);
    const r = m.get(`${EMP}|2026-08-03`);
    expect(r?.eventsCnt).toBe(2);
    expect(r?.presenceHours).toBe(8);
    expect(r?.openIntervals).toBe(0);
  });

  it("🔴 lanac istog smera: SVAKI je < 1 min od PRETHODNOG (i odbačenog) -> ostaje JEDAN", () => {
    // Ovo je jedini test koji razlikuje `lag()` nad CELIM nizom od poređenja sa
    // „zadnjim zadržanim". PG gleda prethodni RED (i kad je odbačen), pa ceo
    // lanac 07:00:00 → 07:00:50 → 07:01:40 pada na jedan događaj, iako je prvi
    // i poslednji razdvojeno 100 s. Poređenje sa zadnjim ZADRŽANIM dalo bi dva.
    const m = racunajDnevnoPrisustvo([
      ev(1, "2026-08-03T07:00:00", "in"),
      ev(2, "2026-08-03T07:00:50", "in"),
      ev(3, "2026-08-03T07:01:40", "in"),
    ]);
    const r = m.get(`${EMP}|2026-08-03`);
    expect(r?.eventsCnt).toBe(1);
    expect(r?.openIntervals).toBe(1);
    expect(r?.doubleInCnt).toBe(0);
  });

  it("isti smer posle VIŠE od minuta se ZADRŽAVA (granica je strogo > 1 min)", () => {
    const m = racunajDnevnoPrisustvo([
      ev(1, "2026-08-03T07:00:00", "in"),
      ev(2, "2026-08-03T07:01:01", "in"),
    ]);
    expect(m.get(`${EMP}|2026-08-03`)?.eventsCnt).toBe(2);
    // Tačno 60 s NIJE dovoljno (`> interval '1 minute'`).
    const m2 = racunajDnevnoPrisustvo([
      ev(1, "2026-08-03T07:00:00", "in"),
      ev(2, "2026-08-03T07:01:00", "in"),
    ]);
    expect(m2.get(`${EMP}|2026-08-03`)?.eventsCnt).toBe(1);
  });

  it("ulaz bez izlaza -> open_intervals = 1, presence_hours = NULL", () => {
    const m = racunajDnevnoPrisustvo([ev(1, "2026-08-03T07:00:00", "in")]);
    const r = m.get(`${EMP}|2026-08-03`);
    expect(r?.openIntervals).toBe(1);
    expect(r?.presenceHours).toBeNull();
    expect(r?.firstIn).toBe("07:00");
    expect(r?.lastOut).toBeNull();
  });

  it("dva ulaza bez izlaza između -> double_in_cnt = 1", () => {
    const m = racunajDnevnoPrisustvo([
      ev(1, "2026-08-03T07:00:00", "in"),
      ev(2, "2026-08-03T09:00:00", "in"),
    ]);
    expect(m.get(`${EMP}|2026-08-03`)?.doubleInCnt).toBe(1);
  });

  it("official_out OTVARA interval i kandidat je za last_out (oba istovremeno)", () => {
    const m = racunajDnevnoPrisustvo([
      ev(1, "2026-08-03T07:00:00", "in"),
      ev(2, "2026-08-03T12:00:00", "official_out"),
      ev(3, "2026-08-03T15:00:00", "out"),
    ]);
    const r = m.get(`${EMP}|2026-08-03`);
    expect(r?.presenceHours).toBe(8);
    expect(r?.lastOut).toBe("15:00");
  });

  it("`unknown` se ISKLJUČUJE (WHERE direction <> 'unknown')", () => {
    const m = racunajDnevnoPrisustvo([
      ev(1, "2026-08-03T07:00:00", "unknown"),
      ev(2, "2026-08-03T07:30:00", "in"),
    ]);
    expect(m.get(`${EMP}|2026-08-03`)?.eventsCnt).toBe(1);
  });

  it("dir_prio: 'in' pre 'out' kad je vreme ISTO", () => {
    const m = racunajDnevnoPrisustvo([
      ev(2, "2026-08-03T07:00:00", "out"),
      ev(1, "2026-08-03T07:00:00", "in"),
    ]);
    const r = m.get(`${EMP}|2026-08-03`);
    // Poredak (in, out) -> interval 0h zatvoren, ne otvoren.
    expect(r?.openIntervals).toBe(0);
    expect(r?.presenceHours).toBe(0);
  });

  it("grupisanje je po (zaposleni, dan) — dva radnika se ne mešaju", () => {
    const m = racunajDnevnoPrisustvo([
      ev(1, "2026-08-03T07:00:00", "in", EMP),
      ev(2, "2026-08-03T07:00:00", "in", EMP2),
    ]);
    expect(m.size).toBe(2);
  });

  it("prazan dan NE daje red (nije nula, nego odsustvo reda)", () => {
    expect(racunajDnevnoPrisustvo([]).size).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 10. attendance_submit_correction / _cancel_
// ══════════════════════════════════════════════════════════════════════════════

describe("attendance_submit_correction — redosled provera", () => {
  const NOW = new Date("2026-08-08T09:00:00Z"); // 11:00 po Beogradu
  const seedKor = (): Seed => ({
    gridEditors: [],
    users: [
      { id: 3, email: ADMIN_VAN_SPISKA, role: "admin", active: true },
      {
        id: 2,
        email: "petar@servoteh.com",
        role: "proizvodni_radnik",
        active: true,
      },
      { id: 9, email: "sef@servoteh.com", role: "menadzment", active: true },
    ],
    userRoles: [
      {
        userId: 9,
        role: "menadzment",
        isActive: true,
        scopeType: "global",
        managedSubDepartmentIds: [7],
      },
    ],
    employees: [
      {
        id: EMP,
        fullName: "Petrovic Petar",
        email: "petar@servoteh.com",
        isActive: true,
        subDepartmentId: 7,
      },
    ],
    attendanceEvents: [],
    attendanceCorrections: [],
    attendanceNotifyExtra: [],
    kadrNotificationLog: [],
  });

  it("obrazloženje < 5 znakova -> obrazlozenje_obavezno (prva provera)", async () => {
    const { s } = svc(seedKor());
    await expect(
      s.submitAttendanceCorrection(
        "petar@servoteh.com",
        { employeeId: EMP, day: "2026-08-07", in: "07:00", reason: "ab" },
        NOW,
      ),
    ).resolves.toEqual({ ok: false, error: "obrazlozenje_obavezno" });
  });

  it("ni ulaz ni izlaz -> nema_vremena", async () => {
    const { s } = svc(seedKor());
    await expect(
      s.submitAttendanceCorrection(
        "petar@servoteh.com",
        { employeeId: EMP, day: "2026-08-07", reason: "zaboravio sam" },
        NOW,
      ),
    ).resolves.toEqual({ ok: false, error: "nema_vremena" });
  });

  it("ulaz >= izlaz -> ulaz_posle_izlaza", async () => {
    const { s } = svc(seedKor());
    await expect(
      s.submitAttendanceCorrection(
        "petar@servoteh.com",
        {
          employeeId: EMP,
          day: "2026-08-07",
          in: "15:00",
          out: "07:00",
          reason: "zaboravio sam",
        },
        NOW,
      ),
    ).resolves.toEqual({ ok: false, error: "ulaz_posle_izlaza" });
  });

  it("tuđi red bez prava -> nema_prava", async () => {
    const { s } = svc(seedKor());
    await expect(
      s.submitAttendanceCorrection(
        "neko.drugi@servoteh.com",
        {
          employeeId: EMP,
          day: "2026-08-07",
          in: "07:00",
          reason: "zaboravio sam",
        },
        NOW,
      ),
    ).resolves.toEqual({ ok: false, error: "nema_prava" });
  });

  it("dan u budućnosti -> buducnost", async () => {
    const { s } = svc(seedKor());
    await expect(
      s.submitAttendanceCorrection(
        "petar@servoteh.com",
        {
          employeeId: EMP,
          day: "2026-08-09",
          in: "07:00",
          reason: "zaboravio sam",
        },
        NOW,
      ),
    ).resolves.toEqual({ ok: false, error: "buducnost" });
  });

  it("ne-HR i dan stariji od 3 dana -> prekasno; HR PROLAZI isti dan", async () => {
    const { s } = svc(seedKor());
    await expect(
      s.submitAttendanceCorrection(
        "petar@servoteh.com",
        {
          employeeId: EMP,
          day: "2026-08-01",
          in: "07:00",
          reason: "zaboravio sam",
        },
        NOW,
      ),
    ).resolves.toEqual({ ok: false, error: "prekasno" });

    const { s: s2 } = svc(seedKor());
    await expect(
      s2.submitAttendanceCorrection(
        ADMIN_VAN_SPISKA,
        {
          employeeId: EMP,
          day: "2026-08-01",
          in: "07:00",
          reason: "zaboravio sam",
        },
        NOW,
      ),
    ).resolves.toMatchObject({ ok: true });
  });

  it("uspeh: upisuje 2 događaja (source='manual'), korekciju i mejl šefu (bez unosioca)", async () => {
    const { s, prisma } = svc(seedKor());
    const r = await s.submitAttendanceCorrection(
      "petar@servoteh.com",
      {
        employeeId: EMP,
        day: "2026-08-07",
        in: "07:00",
        out: "15:00",
        reason: "zaboravio sam karticu",
      },
      NOW,
    );
    expect(r).toMatchObject({ ok: true, employee_name: "Petrovic Petar" });
    expect(prisma.__store.attendanceEvents).toHaveLength(2);
    expect(prisma.__store.attendanceEvents[0].source).toBe("manual");
    expect(prisma.__store.attendanceEvents[0].terminalName).toBe("Korekcija");
    expect(prisma.__store.attendanceCorrections).toHaveLength(1);
    expect(prisma.__store.attendanceCorrections[0].createdForSelf).toBe(true);
    // Šef iz sistematizacije dobija mejl; radnik (unosilac) NE.
    expect(prisma.__store.kadrNotificationLog).toHaveLength(1);
    expect(prisma.__store.kadrNotificationLog[0].recipient).toBe(
      "sef@servoteh.com",
    );
  });

  it("već postoji `active` korekcija za taj dan -> vec_korigovano", async () => {
    const seed = seedKor();
    seed.attendanceCorrections = [
      {
        id: "c-1",
        employeeId: EMP,
        day: dan("2026-08-07"),
        status: "active",
        eventIds: [],
      },
    ];
    const { s } = svc(seed);
    await expect(
      s.submitAttendanceCorrection(
        "petar@servoteh.com",
        {
          employeeId: EMP,
          day: "2026-08-07",
          in: "07:00",
          reason: "zaboravio sam",
        },
        NOW,
      ),
    ).resolves.toEqual({ ok: false, error: "vec_korigovano" });
  });

  it("ulaz već postoji tog dana -> ulaz_postoji (sirov EXISTS, bez dedup-a)", async () => {
    const seed = seedKor();
    seed.attendanceEvents = [
      {
        id: 1n,
        employeeId: EMP,
        direction: "in",
        eventTs: new Date("2026-08-07T05:00:00Z"),
        eventTsLocal: new Date("2026-08-07T07:00:00Z"),
        source: "katze",
      },
    ];
    const { s } = svc(seed);
    await expect(
      s.submitAttendanceCorrection(
        "petar@servoteh.com",
        {
          employeeId: EMP,
          day: "2026-08-07",
          in: "07:30",
          reason: "zaboravio sam",
        },
        NOW,
      ),
    ).resolves.toEqual({ ok: false, error: "ulaz_postoji" });
  });

  it("izlaz kad je dan već zatvoren -> izlaz_postoji", async () => {
    const seed = seedKor();
    seed.attendanceEvents = [
      {
        id: 1n,
        employeeId: EMP,
        direction: "in",
        eventTs: new Date("2026-08-07T05:00:00Z"),
        eventTsLocal: new Date("2026-08-07T07:00:00Z"),
        source: "katze",
      },
      {
        id: 2n,
        employeeId: EMP,
        direction: "out",
        eventTs: new Date("2026-08-07T13:00:00Z"),
        eventTsLocal: new Date("2026-08-07T15:00:00Z"),
        source: "katze",
      },
    ];
    const { s } = svc(seed);
    await expect(
      s.submitAttendanceCorrection(
        "petar@servoteh.com",
        {
          employeeId: EMP,
          day: "2026-08-07",
          out: "16:00",
          reason: "zaboravio sam",
        },
        NOW,
      ),
    ).resolves.toEqual({ ok: false, error: "izlaz_postoji" });
  });
});

describe("attendance_cancel_correction", () => {
  const seedCancel = (): Seed => ({
    users: [
      { id: 3, email: ADMIN_VAN_SPISKA, role: "admin", active: true },
      {
        id: 2,
        email: "petar@servoteh.com",
        role: "proizvodni_radnik",
        active: true,
      },
    ],
    employees: [
      {
        id: EMP,
        fullName: "Petrovic Petar",
        email: "petar@servoteh.com",
        isActive: true,
        subDepartmentId: 7,
      },
    ],
    attendanceCorrections: [
      {
        id: "c-1",
        employeeId: EMP,
        day: dan("2026-08-07"),
        status: "active",
        eventIds: [10n, 11n],
      },
    ],
    attendanceEvents: [
      { id: 10n, employeeId: EMP, direction: "in", source: "manual" },
      { id: 11n, employeeId: EMP, direction: "out", source: "manual" },
      { id: 12n, employeeId: EMP, direction: "in", source: "katze" },
    ],
  });

  it("nepoznata korekcija -> nepoznata_korekcija", async () => {
    const { s } = svc(seedCancel());
    await expect(
      s.cancelAttendanceCorrection(ADMIN_VAN_SPISKA, "nema"),
    ).resolves.toEqual({ ok: false, error: "nepoznata_korekcija" });
  });

  it("već poništena -> vec_ponistena", async () => {
    const seed = seedCancel();
    (seed.attendanceCorrections as Row[])[0].status = "cancelled";
    const { s } = svc(seed);
    await expect(
      s.cancelAttendanceCorrection(ADMIN_VAN_SPISKA, "c-1"),
    ).resolves.toEqual({ ok: false, error: "vec_ponistena" });
  });

  it("🔴 RADNIK NE MOŽE da poništi SVOJU korekciju (gejt nema `self` granu)", async () => {
    const { s, prisma } = svc(seedCancel());
    await expect(
      s.cancelAttendanceCorrection("petar@servoteh.com", "c-1"),
    ).resolves.toEqual({ ok: false, error: "nema_prava" });
    expect(prisma.__store.attendanceEvents).toHaveLength(3);
  });

  it("HR/admin: briše TAČNO svoje događaje (2 od 3) i označava cancelled", async () => {
    const { s, prisma } = svc(seedCancel());
    await expect(
      s.cancelAttendanceCorrection(ADMIN_VAN_SPISKA, "c-1"),
    ).resolves.toEqual({ ok: true });
    expect(prisma.__store.attendanceEvents).toHaveLength(1);
    expect(prisma.__store.attendanceEvents[0].id).toBe(12n);
    expect(prisma.__store.attendanceCorrections[0].status).toBe("cancelled");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 11. kiosk_record_punch — DRUGI živi pisac `attendance_events`
// ══════════════════════════════════════════════════════════════════════════════

describe("kiosk_record_punch", () => {
  const NOW = new Date("2026-08-08T09:00:00Z"); // 11:00 po Beogradu
  const seedKiosk = (): Seed => ({
    employees: [{ id: EMP, fullName: "Petrovic Petar", isActive: true }],
    employeeBadges: [
      {
        id: "b-1",
        employeeId: EMP,
        badgeType: "qr",
        code: "QR-12345",
        isActive: true,
        validTo: null,
      },
    ],
    attendanceEvents: [],
  });

  it("token < 4 znaka -> prazan_token", async () => {
    const { s } = svc(seedKiosk());
    await expect(s.kioskRecordPunch("ab", null, NOW)).resolves.toEqual({
      ok: false,
      error: "prazan_token",
    });
  });

  it("nepoznat QR -> nepoznat_qr", async () => {
    const { s } = svc(seedKiosk());
    await expect(s.kioskRecordPunch("QR-NEMA", null, NOW)).resolves.toEqual({
      ok: false,
      error: "nepoznat_qr",
    });
  });

  it("prvi prolaz u danu je 'in' (NULL pada u ELSE granu CASE-a)", async () => {
    const { s, prisma } = svc(seedKiosk());
    const r = await s.kioskRecordPunch("QR-12345", null, NOW);
    expect(r).toMatchObject({ ok: true, direction: "in", time: "11:00" });
    expect(prisma.__store.attendanceEvents).toHaveLength(1);
    expect(prisma.__store.attendanceEvents[0].source).toBe("kiosk");
    expect(prisma.__store.attendanceEvents[0].terminalName).toBe(
      "Kiosk kapija",
    );
  });

  it("posle 'in' sledeći je 'out'", async () => {
    const seed = seedKiosk();
    seed.attendanceEvents = [
      {
        id: 1n,
        employeeId: EMP,
        direction: "in",
        eventTs: new Date("2026-08-08T05:00:00Z"),
        eventTsLocal: new Date("2026-08-08T07:00:00Z"),
        source: "kiosk",
      },
    ];
    const { s } = svc(seed);
    await expect(
      s.kioskRecordPunch("QR-12345", null, NOW),
    ).resolves.toMatchObject({ direction: "out" });
  });

  it("🔴 DEDUP: isti čovek u < 30 s -> {duplicate:true} i NIJEDAN nov red", async () => {
    const seed = seedKiosk();
    seed.attendanceEvents = [
      {
        id: 1n,
        employeeId: EMP,
        direction: "in",
        eventTs: new Date("2026-08-08T08:59:50Z"),
        eventTsLocal: new Date("2026-08-08T10:59:50Z"),
        source: "kiosk",
      },
    ];
    const { s, prisma } = svc(seed);
    const r = await s.kioskRecordPunch("QR-12345", null, NOW);
    expect(r).toMatchObject({ ok: true, duplicate: true, direction: "in" });
    expect(prisma.__store.attendanceEvents).toHaveLength(1);
  });

  it("ručni override smera ima prednost nad auto-logikom", async () => {
    const { s } = svc(seedKiosk());
    await expect(
      s.kioskRecordPunch("QR-12345", "out", NOW),
    ).resolves.toMatchObject({ direction: "out" });
  });

  it("neaktivan zaposleni -> neaktivan_zaposleni", async () => {
    const seed = seedKiosk();
    (seed.employees as Row[])[0].isActive = false;
    const { s } = svc(seed);
    await expect(s.kioskRecordPunch("QR-12345", null, NOW)).resolves.toEqual({
      ok: false,
      error: "neaktivan_zaposleni",
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 12. Scheduler poslovi — SAT-GEJT je deo funkcije, ne rasporeda
// ══════════════════════════════════════════════════════════════════════════════

describe("kadr_schedule_attendance_alerts", () => {
  const seedAlarm = (): Seed => ({
    users: [
      { id: 9, email: "sef@servoteh.com", role: "menadzment", active: true },
    ],
    userRoles: [
      {
        userId: 9,
        role: "menadzment",
        isActive: true,
        scopeType: "global",
        managedSubDepartmentIds: [7],
      },
    ],
    employees: [
      {
        id: EMP,
        fullName: "Petrovic Petar",
        email: "petar@servoteh.com",
        isActive: true,
        subDepartmentId: 7,
      },
    ],
    attendanceEvents: [
      // Juče (2026-08-07) ulaz bez izlaza -> otvoren interval.
      {
        id: 1n,
        employeeId: EMP,
        direction: "in",
        eventTs: new Date("2026-08-07T05:00:00Z"),
        eventTsLocal: new Date("2026-08-07T07:00:00Z"),
        source: "katze",
      },
    ],
    workHours: [],
    attendanceNotifyExtra: [],
    kadrNotificationLog: [],
  });

  it("🔴 van 6h po Beogradu NE RADI NIŠTA (gejt je u funkciji)", async () => {
    const { s, prisma } = svc(seedAlarm());
    const u10 = new Date("2026-08-08T08:00:00Z"); // 10:00 Beograd
    await expect(s.scheduleAttendanceAlerts(u10)).resolves.toBe(0);
    expect(prisma.__store.kadrNotificationLog).toHaveLength(0);
  });

  it("u 6h: otvoren interval juče -> alarm šefu I radniku (2 reda)", async () => {
    const { s, prisma } = svc(seedAlarm());
    const u6 = new Date("2026-08-08T04:00:00Z"); // 06:00 Beograd
    await expect(s.scheduleAttendanceAlerts(u6)).resolves.toBe(2);
    const primaoci = prisma.__store.kadrNotificationLog
      .map((r) => r.recipient)
      .sort();
    expect(primaoci).toEqual(["petar@servoteh.com", "sef@servoteh.com"]);
    expect(prisma.__store.kadrNotificationLog[0].notificationType).toBe(
      "attendance_missing_punch",
    );
    expect(
      (prisma.__store.kadrNotificationLog[0].payload as Row).work_date,
    ).toBe("2026-08-07");
  });

  it("odsustvo u gridu gasi granu 'nema_izlaz'", async () => {
    const seed = seedAlarm();
    seed.workHours = [
      {
        id: "w-1",
        employeeId: EMP,
        workDate: dan("2026-08-07"),
        hours: D(0),
        fieldHours: D(0),
        absenceCode: "GO",
      },
    ];
    const { s } = svc(seed);
    await expect(
      s.scheduleAttendanceAlerts(new Date("2026-08-08T04:00:00Z")),
    ).resolves.toBe(0);
  });

  it("dedup: drugi prolaz istog dana ne dodaje nove redove", async () => {
    const { s, prisma } = svc(seedAlarm());
    const u6 = new Date("2026-08-08T04:00:00Z");
    await s.scheduleAttendanceAlerts(u6);
    await expect(s.scheduleAttendanceAlerts(u6)).resolves.toBe(0);
    expect(prisma.__store.kadrNotificationLog).toHaveLength(2);
  });

  it("grana 'nema_prolaza': sati u gridu, nula prolaza juče, ali prolaz u prethodnih 7 dana", async () => {
    const seed = seedAlarm();
    seed.attendanceEvents = [
      {
        id: 1n,
        employeeId: EMP,
        direction: "in",
        eventTs: new Date("2026-08-04T05:00:00Z"),
        eventTsLocal: new Date("2026-08-04T07:00:00Z"),
        source: "katze",
      },
    ];
    seed.workHours = [
      {
        id: "w-1",
        employeeId: EMP,
        workDate: dan("2026-08-07"),
        hours: D(8),
        fieldHours: D(0),
        absenceCode: null,
      },
    ];
    const { s, prisma } = svc(seed);
    await expect(
      s.scheduleAttendanceAlerts(new Date("2026-08-08T04:00:00Z")),
    ).resolves.toBe(2);
    expect((prisma.__store.kadrNotificationLog[0].payload as Row).problem).toBe(
      "nema_prolaza",
    );
  });

  it("mrtva kartica (nema prolaza NI u prethodnih 7 dana) NE ide u dnevni alarm", async () => {
    const seed = seedAlarm();
    seed.attendanceEvents = [];
    seed.workHours = [
      {
        id: "w-1",
        employeeId: EMP,
        workDate: dan("2026-08-07"),
        hours: D(8),
        fieldHours: D(0),
        absenceCode: null,
      },
    ];
    const { s } = svc(seed);
    await expect(
      s.scheduleAttendanceAlerts(new Date("2026-08-08T04:00:00Z")),
    ).resolves.toBe(0);
  });
});

describe("kadr_schedule_attendance_weekly_digest", () => {
  const seedDigest = (): Seed => ({
    users: [{ id: 3, email: ADMIN_VAN_SPISKA, role: "admin", active: true }],
    userRoles: [
      { userId: 3, role: "admin", isActive: true, scopeType: "global" },
    ],
    employees: [
      {
        id: EMP,
        fullName: "Petrovic Petar",
        isActive: true,
        subDepartmentId: 7,
      },
    ],
    kadrNotificationLog: [
      {
        id: "n-1",
        notificationType: "attendance_missing_punch",
        employeeId: EMP,
        recipient: "sef@servoteh.com",
        payload: { work_date: "2026-08-05" },
      },
    ],
    workHours: [],
    attendanceEvents: [],
  });

  it("🔴 DVOSTRUKI GEJT: nije ponedeljak -> 0", async () => {
    const { s } = svc(seedDigest());
    // 2026-08-11 je utorak.
    await expect(
      s.scheduleAttendanceWeeklyDigest(new Date("2026-08-11T04:00:00Z")),
    ).resolves.toBe(0);
  });

  it("ponedeljak ali nije 6h -> 0", async () => {
    const { s } = svc(seedDigest());
    // 2026-08-10 je ponedeljak; 08:00 UTC = 10:00 Beograd.
    await expect(
      s.scheduleAttendanceWeeklyDigest(new Date("2026-08-10T08:00:00Z")),
    ).resolves.toBe(0);
  });

  it("ponedeljak u 6h: šalje TAČNO jednom po adminu", async () => {
    const { s, prisma } = svc(seedDigest());
    const pon6 = new Date("2026-08-10T04:00:00Z");
    await expect(s.scheduleAttendanceWeeklyDigest(pon6)).resolves.toBe(1);
    const digest = prisma.__store.kadrNotificationLog.filter(
      (r) => r.notificationType === "attendance_weekly_digest",
    );
    expect(digest).toHaveLength(1);
    expect(digest[0].recipient).toBe(ADMIN_VAN_SPISKA);
    expect((digest[0].payload as Row).week_start).toBe("2026-08-03");
    // Ponovni poziv je dedup-ovan.
    await expect(s.scheduleAttendanceWeeklyDigest(pon6)).resolves.toBe(0);
  });

  it("nema ni alarma ni mrtvih kartica -> ne šalje ništa", async () => {
    const seed = seedDigest();
    seed.kadrNotificationLog = [];
    const { s } = svc(seed);
    await expect(
      s.scheduleAttendanceWeeklyDigest(new Date("2026-08-10T04:00:00Z")),
    ).resolves.toBe(0);
  });

  it("mrtva kartica ulazi u 'strukturni problem' i sama pokreće izveštaj", async () => {
    const seed = seedDigest();
    seed.kadrNotificationLog = [];
    seed.workHours = [
      {
        id: "w-1",
        employeeId: EMP,
        workDate: dan("2026-08-05"),
        hours: D(8),
        fieldHours: D(0),
        absenceCode: null,
      },
    ];
    const { s, prisma } = svc(seed);
    await expect(
      s.scheduleAttendanceWeeklyDigest(new Date("2026-08-10T04:00:00Z")),
    ).resolves.toBe(1);
    expect(prisma.__store.kadrNotificationLog[0].body).toContain(
      "Strukturni problem",
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 13. Katze vodeni žig (prelazni režim)
// ══════════════════════════════════════════════════════════════════════════════

describe("attendance_katze_max_idreg", () => {
  it("vraća MAX(external_id) samo za katze izvore (vodeni žig mosta)", async () => {
    const { s, prisma } = svc({});
    prisma.$queryRaw.mockResolvedValueOnce([{ max: 4711n }]);
    await expect(s.katzeMaxIdreg()).resolves.toBe(4711n);
    const pozivi = prisma.$queryRaw.mock.calls as unknown[][];
    const tekst = (pozivi[0][0] as string[]).join("");
    expect(tekst).toContain("katze_manual");
    expect(tekst).toContain("MAX(external_id::bigint)");
  });

  it("prazna tabela -> 0 (COALESCE), da most ne krene od NULL-a", async () => {
    const { s, prisma } = svc({});
    prisma.$queryRaw.mockResolvedValueOnce([{ max: null }]);
    await expect(s.katzeMaxIdreg()).resolves.toBe(0n);
  });
});
