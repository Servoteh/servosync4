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
import { KadrovskaController } from "../src/modules/kadrovska/kadrovska.controller";
import { KadrovskaService } from "../src/modules/kadrovska/kadrovska.service";
import { ALL_ROLE_KEYS } from "../src/common/authz/roles";
import { roleHasPermission } from "../src/common/authz/role-permissions";
import { PrismaService } from "../src/prisma/prisma.service";
import {
  PERMISSIONS,
  type PermissionKey,
} from "../src/common/authz/permissions";

/**
 * e2e PERMISSION MATRICA — Kadrovska (MODULE_SPEC_kadrovska_30.md §5 t.53),
 * rola × endpoint × 200/403 sa AUTHZ_ENFORCE=true. JwtAuthGuard je stub (identitet
 * iz `x-test-role`); servis je mokovan (bez sy15 baze). Row/PII maska (svoje ∨ manages,
 * v_employees_safe, salary-immutability) sprovodi DB RLS kroz GUC — R2 živi smoke.
 *
 * KRITIČNO (§2.6): `salary` = SAMO admin; `pii` = admin ∨ poslovni_admin (HR NEMA).
 * Liste su IZVEDENE iz ALL_ROLE_KEYS (test-hardening) — nova/pogrešno-grantovana uloga
 * ne može da se provuče; tačnost skupova pinuje unit `role-permissions.kadrovska.spec`.
 */
describe("Kadrovska permission matrica (e2e, AUTHZ_ENFORCE=true)", () => {
  let app: INestApplication;
  const VALID_UUID = "3b241101-e2bb-4255-8caf-4136c566a962";

  const svcMock: Record<string, jest.Mock> = {};
  for (const m of [
    "me",
    "dashboard",
    "report",
    "notifications",
    "notificationConfig",
    "vacationBalance",
    "vacationHistory",
    "vacationEntitlements",
    "requests",
    "absentNow",
    "absences",
    "grid",
    "workHours",
    "attendanceNow",
    "attendanceShadow",
    "attendanceVsGrid",
    "attendanceDaily",
    "attendanceCorrections",
    "attendanceExtraRecipients",
    "employees",
    "employeeChildren",
    "employeeBankCards",
    "employeeForeignDocs",
    "employeePersonalDocs",
    "employeeDocuments",
    "employee",
    "medicalExams",
    "certificates",
    "contracts",
    "directory",
    "onboardingTemplates",
    "onboarding",
    "devPlanCheckins",
    "devPlans",
    "expectations",
    "talks",
    "assessmentScope",
    "assessments",
    "salaryTerms",
    "salaryCurrent",
    "salaryPayroll",
  ]) {
    svcMock[m] = jest.fn().mockResolvedValue({ data: { ok: true } });
  }

  beforeAll(async () => {
    process.env.AUTHZ_ENFORCE = "true"; // pre instanciranja PermissionsGuard-a
    const moduleRef = await Test.createTestingModule({
      controllers: [KadrovskaController],
      providers: [
        { provide: PrismaService, useValue: { userPermissionOverride: { findUnique: async () => null } } },
        { provide: KadrovskaService, useValue: svcMock }],
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
    app.enableVersioning({
      type: VersioningType.URI,
      defaultVersion: VERSION_NEUTRAL,
    });
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.AUTHZ_ENFORCE;
  });

  const get = (path: string, role?: string) => {
    const r = request(app.getHttpServer()).get(`/api/v1${path}`);
    return role ? r.set("x-test-role", role) : r;
  };
  const rolesWith = (perm: PermissionKey) =>
    ALL_ROLE_KEYS.filter((r) => roleHasPermission(r, perm));
  const rolesWithout = (perm: PermissionKey) =>
    ALL_ROLE_KEYS.filter((r) => !roleHasPermission(r, perm));

  // Endpoint → permisija koju traži (za matricu). Reprezentativan po hub-grupi.
  const CASES: Array<{ path: string; perm: PermissionKey; label: string }> = [
    { path: "/kadrovska/me", perm: PERMISSIONS.KADROVSKA_READ, label: "me" },
    {
      path: "/kadrovska/dashboard",
      perm: PERMISSIONS.KADROVSKA_READ,
      label: "dashboard",
    },
    {
      path: "/kadrovska/vacation/balance",
      perm: PERMISSIONS.KADROVSKA_READ,
      label: "vacation/balance",
    },
    {
      path: "/kadrovska/grid",
      perm: PERMISSIONS.KADROVSKA_READ,
      label: "grid",
    },
    {
      path: "/kadrovska/employees",
      perm: PERMISSIONS.KADROVSKA_READ,
      label: "employees",
    },
    {
      path: "/kadrovska/directory",
      perm: PERMISSIONS.KADROVSKA_READ,
      label: "directory",
    },
    {
      path: "/kadrovska/notifications",
      perm: PERMISSIONS.KADROVSKA_MANAGE,
      label: "notifications",
    },
    {
      path: "/kadrovska/medical-exams",
      perm: PERMISSIONS.KADROVSKA_MANAGE,
      label: "medical-exams",
    },
    {
      path: "/kadrovska/onboarding",
      perm: PERMISSIONS.KADROVSKA_MANAGE,
      label: "onboarding",
    },
    {
      path: "/kadrovska/requests",
      perm: PERMISSIONS.KADROVSKA_VACREQ_MANAGE,
      label: "requests",
    },
    {
      path: "/kadrovska/contracts",
      perm: PERMISSIONS.KADROVSKA_CONTRACTS_READ,
      label: "contracts",
    },
    {
      path: "/kadrovska/attendance/now",
      perm: PERMISSIONS.KADROVSKA_ATTENDANCE,
      label: "attendance/now",
    },
    {
      path: "/kadrovska/attendance/shadow",
      perm: PERMISSIONS.KADROVSKA_ATTENDANCE_SHADOW,
      label: "attendance/shadow",
    },
    {
      path: "/kadrovska/dev-plans",
      perm: PERMISSIONS.KADROVSKA_DEV_MANAGE,
      label: "dev-plans",
    },
    {
      path: "/kadrovska/talks",
      perm: PERMISSIONS.KADROVSKA_DEV_MANAGE,
      label: "talks",
    },
    {
      path: `/kadrovska/employees/${VALID_UUID}/children`,
      perm: PERMISSIONS.KADROVSKA_PII,
      label: "employees/:id/children (PII)",
    },
    {
      path: `/kadrovska/employees/${VALID_UUID}/documents`,
      perm: PERMISSIONS.KADROVSKA_PII,
      label: "employees/:id/documents (PII)",
    },
    {
      path: "/kadrovska/salary/terms",
      perm: PERMISSIONS.KADROVSKA_SALARY,
      label: "salary/terms",
    },
    {
      path: "/kadrovska/salary/payroll",
      perm: PERMISSIONS.KADROVSKA_SALARY,
      label: "salary/payroll",
    },
    // Izveštaji nad NON-INVOKER view-ovima (adversarni review CRITICAL) — guard je
    // JEDINA zaštita jer view radi kao postgres (BYPASSRLS). Bazna politika replicirana:
    {
      path: "/kadrovska/reports/audit",
      perm: PERMISSIONS.KADROVSKA_ADMIN,
      label: "reports/audit (non-invoker → admin)",
    },
    {
      path: "/kadrovska/reports/medical",
      perm: PERMISSIONS.KADROVSKA_MANAGE,
      label: "reports/medical (non-invoker → manage)",
    },
    {
      path: "/kadrovska/reports/certs",
      perm: PERMISSIONS.KADROVSKA_MANAGE,
      label: "reports/certs (non-invoker → manage)",
    },
  ];

  describe("rola × endpoint × 200/403 (izvedeno iz ALL_ROLE_KEYS)", () => {
    for (const c of CASES) {
      it(`${c.label}: 200 za role sa ${c.perm}`, async () => {
        for (const role of rolesWith(c.perm)) {
          await get(c.path, role).expect(200);
        }
      });
      it(`${c.label}: 403 za role bez ${c.perm}`, async () => {
        for (const role of rolesWithout(c.perm)) {
          await get(c.path, role).expect(403);
        }
      });
    }
  });

  describe("KRITIČNO — zarade SAMO admin, PII admin+poslovni_admin (HR NEMA)", () => {
    it("salary/terms + salary/payroll: 200 admin, 403 hr/menadzment/poslovni_admin", async () => {
      for (const p of [
        "/kadrovska/salary/terms",
        "/kadrovska/salary/payroll",
      ]) {
        await get(p, "admin").expect(200);
        for (const role of ["hr", "menadzment", "poslovni_admin", "pm"]) {
          await get(p, role).expect(403);
        }
      }
    });
    it("PII (children): 200 admin+poslovni_admin, 403 hr+menadzment", async () => {
      const p = `/kadrovska/employees/${VALID_UUID}/children`;
      await get(p, "admin").expect(200);
      await get(p, "poslovni_admin").expect(200);
      await get(p, "hr").expect(403); // ⚠️ HR NEMA PII
      await get(p, "menadzment").expect(403);
    });
  });

  describe("CRITICAL — non-invoker view izveštaji NISU pod (preširokim) kadrovska.read", () => {
    it("reports/audit: 200 admin; 403 read-role bez admin (HR/menadzment/poslovni_admin/projektant_vodja)", async () => {
      await get("/kadrovska/reports/audit", "admin").expect(200);
      // Sve ove IMAJU kadrovska.read (pre fix-a bi curilo salary_terms before/after + PII izmene):
      for (const role of [
        "hr",
        "menadzment",
        "poslovni_admin",
        "projektant_vodja",
      ]) {
        await get("/kadrovska/reports/audit", role).expect(403);
      }
    });
    it("reports/medical + reports/certs: 200 manage (admin/hr/poslovni_admin); 403 read-ali-ne-manage (menadzment/projektant_vodja)", async () => {
      for (const p of [
        "/kadrovska/reports/medical",
        "/kadrovska/reports/certs",
      ]) {
        for (const role of ["admin", "hr", "poslovni_admin"]) {
          await get(p, role).expect(200);
        }
        for (const role of ["menadzment", "projektant_vodja"]) {
          await get(p, role).expect(403);
        }
      }
    });
    it("reports/audit|medical|certs kroz namenske rute (literal pre :kind); generički kind read-ok", async () => {
      // Generički R2 kind (vacation) je pod kadrovska.read — read-role prolazi guard
      // (servis bi vratio 501 uživo; mok vraća 200 → dokaz da ruta NIJE 403-guardovana).
      await get("/kadrovska/reports/vacation", "projektant_vodja").expect(200);
    });
  });

  describe("Route ordering + DTO validacija (400 pre servisa, ne 500)", () => {
    it("GET /kadrovska/employees/:id → 200 uuid (admin), 400 ne-uuid", async () => {
      await get(`/kadrovska/employees/${VALID_UUID}`, "admin").expect(200);
      await get("/kadrovska/employees/nije-uuid", "admin").expect(400);
    });
    it("GET /kadrovska/reports/:kind → 200 (string param nije uhvaćen kao uuid)", async () => {
      await get("/kadrovska/reports/medical", "hr").expect(200);
    });
    it("GET /kadrovska/dashboard?year=nije-broj → 400", async () => {
      await get("/kadrovska/dashboard?year=abc", "admin").expect(400);
      await get("/kadrovska/dashboard?year=2026&month=7", "admin").expect(200);
    });
    it("GET /kadrovska/vacation/balance?employeeId=nije-uuid → 400", async () => {
      await get(
        "/kadrovska/vacation/balance?employeeId=nije-uuid",
        "hr",
      ).expect(400);
    });
    it("GET /kadrovska/dashboard?month=13 → 400 (van 1..12)", async () => {
      await get("/kadrovska/dashboard?month=13", "admin").expect(400);
    });
  });

  describe("Bez identiteta / default-deny", () => {
    it("bez x-test-role → 403 (JwtAuthGuard stub)", async () => {
      await get("/kadrovska/me").expect(403);
      await get("/kadrovska/employees").expect(403);
    });
    it.each(["user", "nepoznata_rola"])(
      "GET /kadrovska/me → 403 za %s (default deny)",
      async (role) => {
        await get("/kadrovska/me", role).expect(403);
      },
    );
  });
});
