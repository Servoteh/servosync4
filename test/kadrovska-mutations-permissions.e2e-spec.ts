import {
  ExecutionContext,
  ValidationPipe,
  VERSION_NEUTRAL,
  VersioningType,
} from "@nestjs/common";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { JwtAuthGuard } from "../src/modules/auth/jwt-auth.guard";
import { KadrovskaMutationsController } from "../src/modules/kadrovska/kadrovska-mutations.controller";
import { KadrovskaMutationsService } from "../src/modules/kadrovska/kadrovska-mutations.service";
import { ALL_ROLE_KEYS } from "../src/common/authz/roles";
import { roleHasPermission } from "../src/common/authz/role-permissions";
import { PERMISSIONS, type PermissionKey } from "../src/common/authz/permissions";
import { PrismaService } from "../src/prisma/prisma.service";

/**
 * e2e PERMISSION MATRICA — Kadrovska R2 MUTACIJE (MODULE_SPEC §5 t.53).
 * rola × mutacioni endpoint × 2xx/403 sa AUTHZ_ENFORCE=true. Guard trči PRE
 * ValidationPipe (403 pre 400). Row/PII/immutability maska = DB RLS (živi smoke).
 * KRITIČNO: salary=SAMO admin; pii=admin∨poslovni_admin (HR NEMA); nop=admin.
 */
describe("Kadrovska R2 mutacije — permission matrica (e2e)", () => {
  let app: INestApplication;
  const U = "3b241101-e2bb-4255-8caf-4136c566a962";

  // ⚠️ 'then'/simboli MORAJU vratiti undefined — inače Nest vidi thenable i `await`
  // nad provajderom visi (beforeAll timeout). Ostalo → jest.fn koji vrati {ok}.
  const svcMock = new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === "then" || typeof prop === "symbol") return undefined;
        return jest.fn().mockResolvedValue({ data: { ok: true } });
      },
    },
  );

  beforeAll(async () => {
    process.env.AUTHZ_ENFORCE = "true";
    const moduleRef = await Test.createTestingModule({
      controllers: [KadrovskaMutationsController],
      providers: [
        { provide: PrismaService, useValue: { userPermissionOverride: { findUnique: async () => null } } },
        { provide: KadrovskaMutationsService, useValue: svcMock }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate(ctx: ExecutionContext) {
          const req = ctx.switchToHttp().getRequest<{
            headers: Record<string, string>;
            user?: unknown;
          }>();
          const role = req.headers["x-test-role"];
          if (!role) return false;
          req.user = { userId: 1, email: "test@servoteh.com", role };
          return true;
        },
      })
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("api");
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: VERSION_NEUTRAL });
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.AUTHZ_ENFORCE;
  });

  const send = (method: "post" | "patch" | "delete", path: string, role?: string, body?: object) => {
    const r = request(app.getHttpServer())[method](`/api/v1${path}`);
    if (role) r.set("x-test-role", role);
    if (body) r.send(body);
    return r;
  };
  const rolesWith = (p: PermissionKey) => ALL_ROLE_KEYS.filter((r) => roleHasPermission(r, p));
  const rolesWithout = (p: PermissionKey) => ALL_ROLE_KEYS.filter((r) => !roleHasPermission(r, p));

  // method, path, perm, valid body (za 2xx putanju), success status.
  const CASES: Array<{
    method: "post" | "patch" | "delete";
    path: string;
    perm: PermissionKey;
    body?: object;
    ok: number;
    label: string;
  }> = [
    { method: "post", path: "/kadrovska/salary/terms", perm: PERMISSIONS.KADROVSKA_SALARY, body: { clientEventId: U, employeeId: U, salaryType: "ugovor", effectiveFrom: "2026-07-01" }, ok: 201, label: "salary/terms create (admin)" },
    { method: "post", path: "/kadrovska/salary/payroll/init", perm: PERMISSIONS.KADROVSKA_SALARY, body: { year: 2026, month: 7 }, ok: 201, label: "payroll/init (admin)" },
    { method: "post", path: "/kadrovska/salary/payroll/recompute", perm: PERMISSIONS.KADROVSKA_SALARY, body: { year: 2026, month: 7 }, ok: 201, label: "payroll/recompute (admin)" },
    { method: "post", path: "/kadrovska/vacation/entitlements", perm: PERMISSIONS.KADROVSKA_VACATION_EDIT, body: { clientEventId: U, employeeId: U, year: 2026, daysTotal: 20 }, ok: 201, label: "entitlement save (vacation_edit)" },
    { method: "post", path: `/kadrovska/requests/vacation/${U}/approve`, perm: PERMISSIONS.KADROVSKA_VACREQ_MANAGE, body: {}, ok: 201, label: "vacation approve (vacreq)" },
    { method: "post", path: "/kadrovska/vacation/bonus", perm: PERMISSIONS.KADROVSKA_VACREQ_MANAGE, body: { clientEventId: U, employeeId: U, workDate: "2026-07-01" }, ok: 201, label: "bonus GO (vacreq)" },
    // self ∨ manager rute — coarse-superset guard `profile.self` (sve aktivne uloge;
    // RPC/RLS presuđuje red). Review fix 14.07: pre je klasni KADROVSKA_READ 403-ovao
    // pm/leadpm (menadžer-podnos) i operativne uloge (self talk-ack/samoprocena).
    { method: "post", path: "/kadrovska/requests/vacation", perm: PERMISSIONS.PROFILE_SELF, body: { clientEventId: U, year: 2026, dateFrom: "2026-07-01", dateTo: "2026-07-05", daysCount: 5 }, ok: 201, label: "submit vacation (self/mgr)" },
    { method: "post", path: "/kadrovska/attendance/corrections", perm: PERMISSIONS.PROFILE_SELF, body: { employeeId: U, day: "2026-07-01" }, ok: 201, label: "submit correction (self/mgr)" },
    { method: "post", path: `/kadrovska/attendance/corrections/${U}/cancel`, perm: PERMISSIONS.PROFILE_SELF, body: {}, ok: 201, label: "cancel correction (self/mgr)" },
    { method: "post", path: `/kadrovska/talks/${U}/acknowledge`, perm: PERMISSIONS.PROFILE_SELF, body: {}, ok: 201, label: "talk ack (self)" },
    { method: "post", path: "/kadrovska/assessments/self", perm: PERMISSIONS.PROFILE_SELF, body: { clientEventId: U }, ok: 201, label: "self-assessment open (self)" },
    { method: "post", path: `/kadrovska/assessments/${U}/self-submit`, perm: PERMISSIONS.PROFILE_SELF, body: {}, ok: 201, label: "self-assessment submit (self)" },
    { method: "post", path: `/kadrovska/requests/nop/${U}/approve`, perm: PERMISSIONS.KADROVSKA_ADMIN, body: {}, ok: 201, label: "nop approve (admin)" },
    { method: "post", path: "/kadrovska/grid/batch", perm: PERMISSIONS.KADROVSKA_GRID_EDIT, body: { rows: [{ employeeId: U, workDate: "2026-07-01", hours: 8 }] }, ok: 201, label: "grid/batch (grid_edit)" },
    { method: "post", path: "/kadrovska/grid/go/set", perm: PERMISSIONS.KADROVSKA_GRID_EDIT, body: { employeeId: U, dateFrom: "2026-07-01", dateTo: "2026-07-05" }, ok: 201, label: "grid GO set (grid_edit)" },
    { method: "post", path: "/kadrovska/employees", perm: PERMISSIONS.KADROVSKA_EDIT, body: { clientEventId: U, fullName: "X Y", workType: "ugovor" }, ok: 201, label: "employee create (edit)" },
    { method: "post", path: "/kadrovska/absences", perm: PERMISSIONS.KADROVSKA_EDIT, body: { clientEventId: U, employeeId: U, type: "godisnji", dateFrom: "2026-07-01", dateTo: "2026-07-02" }, ok: 201, label: "absence create (edit)" },
    { method: "post", path: `/kadrovska/employees/${U}/children`, perm: PERMISSIONS.KADROVSKA_PII, body: { clientEventId: U, firstName: "Ana" }, ok: 201, label: "child create (PII)" },
    { method: "post", path: `/kadrovska/employees/${U}/bank-cards`, perm: PERMISSIONS.KADROVSKA_PII, body: { clientEventId: U, bank: "OTP" }, ok: 201, label: "bank card create (PII)" },
    { method: "post", path: `/kadrovska/employees/${U}/medical-exams`, perm: PERMISSIONS.KADROVSKA_MANAGE, body: { clientEventId: U, examDate: "2026-07-01", examType: "sistematski" }, ok: 201, label: "medical create (manage)" },
    { method: "post", path: "/kadrovska/onboarding/start", perm: PERMISSIONS.KADROVSKA_MANAGE, body: { clientEventId: U, employeeId: U, templateId: U }, ok: 201, label: "onboarding start (manage)" },
    { method: "post", path: "/kadrovska/assessments/360", perm: PERMISSIONS.KADROVSKA_DEV_MANAGE, body: { clientEventId: U, employeeId: U }, ok: 201, label: "assessment 360 (dev_manage)" },
    { method: "post", path: "/kadrovska/talks", perm: PERMISSIONS.KADROVSKA_DEV_MANAGE, body: { clientEventId: U, employeeId: U, talkType: "godisnji" }, ok: 201, label: "talk create (dev_manage)" },
    { method: "patch", path: "/kadrovska/notification-config", perm: PERMISSIONS.KADROVSKA_MANAGE, body: { enabled: true }, ok: 200, label: "notif config (manage)" },
    { method: "post", path: "/kadrovska/notifications/hr-reminders/run", perm: PERMISSIONS.KADROVSKA_MANAGE, body: {}, ok: 201, label: "hr-reminders run (manage)" },
    { method: "post", path: `/kadrovska/employees/${U}/contract-salary`, perm: PERMISSIONS.KADROVSKA_SALARY, body: { neto: 100000, bruto: 130000 }, ok: 201, label: "contract-salary (admin)" },
  ];

  describe("rola × endpoint × 2xx/403 (izvedeno iz ALL_ROLE_KEYS)", () => {
    for (const c of CASES) {
      it(`${c.label}: 2xx za role sa ${c.perm}`, async () => {
        for (const role of rolesWith(c.perm)) {
          await send(c.method, c.path, role, c.body).expect(c.ok);
        }
      });
      it(`${c.label}: 403 za role bez ${c.perm}`, async () => {
        for (const role of rolesWithout(c.perm)) {
          await send(c.method, c.path, role, c.body).expect(403);
        }
      });
    }
  });

  describe("KRITIČNO — zarade SAMO admin; PII admin+poslovni_admin (HR NEMA); nop admin", () => {
    it("salary/terms create: 201 admin; 403 hr/menadzment/poslovni_admin/pm", async () => {
      const body = { clientEventId: U, employeeId: U, salaryType: "ugovor", effectiveFrom: "2026-07-01" };
      await send("post", "/kadrovska/salary/terms", "admin", body).expect(201);
      for (const r of ["hr", "menadzment", "poslovni_admin", "pm"]) {
        await send("post", "/kadrovska/salary/terms", r, body).expect(403);
      }
    });
    it("PII child create: 201 admin+poslovni_admin; 403 hr+menadzment", async () => {
      const p = `/kadrovska/employees/${U}/children`;
      const body = { clientEventId: U, firstName: "Ana" };
      await send("post", p, "admin", body).expect(201);
      await send("post", p, "poslovni_admin", body).expect(201);
      await send("post", p, "hr", body).expect(403);
      await send("post", p, "menadzment", body).expect(403);
    });
    it("nop approve: 201 admin; 403 hr/menadzment (neplaćeno = samo admin)", async () => {
      const p = `/kadrovska/requests/nop/${U}/approve`;
      await send("post", p, "admin", {}).expect(201);
      await send("post", p, "hr", {}).expect(403);
      await send("post", p, "menadzment", {}).expect(403);
    });
  });

  describe("DTO validacija (400 posle guard-a, ne 500)", () => {
    it("create bez obaveznog clientEventId → 400 (admin prošao guard)", async () => {
      await send("post", "/kadrovska/salary/terms", "admin", {
        employeeId: U,
        salaryType: "ugovor",
        effectiveFrom: "2026-07-01",
      }).expect(400);
    });
    it("clientEventId koji nije uuid → 400", async () => {
      await send("post", "/kadrovska/salary/terms", "admin", {
        clientEventId: "nije-uuid",
        employeeId: U,
        salaryType: "ugovor",
        effectiveFrom: "2026-07-01",
      }).expect(400);
    });
    it("param koji nije uuid → 400 (ParseUUIDPipe)", async () => {
      await send("post", "/kadrovska/requests/vacation/nije-uuid/approve", "admin", {}).expect(400);
    });
    it("bez identiteta → 403 (JwtAuthGuard stub)", async () => {
      await send("post", "/kadrovska/salary/payroll/init", undefined, { year: 2026, month: 7 }).expect(403);
    });
  });
});
