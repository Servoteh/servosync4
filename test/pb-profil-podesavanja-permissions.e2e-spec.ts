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
import { ProjektniBiroController } from "../src/modules/projektni-biro/projektni-biro.controller";
import { ProjektniBiroService } from "../src/modules/projektni-biro/projektni-biro.service";
import { MojProfilController } from "../src/modules/moj-profil/moj-profil.controller";
import { MojProfilService } from "../src/modules/moj-profil/moj-profil.service";
import { PodesavanjaController } from "../src/modules/podesavanja/podesavanja.controller";
import { PodesavanjaService } from "../src/modules/podesavanja/podesavanja.service";
import { ALL_ROLE_KEYS } from "../src/common/authz/roles";
import { roleHasPermission } from "../src/common/authz/role-permissions";
import {
  PERMISSIONS,
  type PermissionKey,
} from "../src/common/authz/permissions";

/**
 * e2e PERMISSION MATRICA — TALAS D (Projektni biro + Moj profil + Podešavanja),
 * rola × endpoint × 200/403 sa AUTHZ_ENFORCE=true (MODULE_SPEC_pb_profil_podesavanja_30.md §5 t.43).
 * JwtAuthGuard je stub (identitet iz `x-test-role`); servisi su mokovani (bez sy15 baze).
 * Row-scope (work_reports self, eng-tips draft/org-članstvo, user_roles ALL=admin, audit SELECT
 * =admin, profil email→employee) sprovodi DB RLS/DEFINER kroz GUC — to je R2 živi smoke, ne ovaj
 * rola-sloj. Liste rola se IZVODE iz ALL_ROLE_KEYS (nova/pogrešno-grantovana uloga se ne provuče).
 */
describe("Talas D permission matrica (e2e, AUTHZ_ENFORCE=true)", () => {
  let app: INestApplication;
  const UUID = "3b241101-e2bb-4255-8caf-4136c566a962";

  const mkMock = (methods: string[]): Record<string, jest.Mock> => {
    const m: Record<string, jest.Mock> = {};
    for (const name of methods)
      m[name] = jest.fn().mockResolvedValue({ data: { ok: true } });
    return m;
  };
  const pbMock = mkMock([
    "listProjects",
    "listEngineers",
    "listTasks",
    "loadStats",
    "teamLoadStats",
    "listWorkReports",
    "workReportSummary",
    "listTips",
    "listTipCategories",
    "findTip",
    "notificationConfig",
    "findTask",
    "listComments",
    "listDeps",
    "listFiles",
  ]);
  const profilMock = mkMock([
    "me",
    "summary",
    "vacation",
    "makeupAndPaidLeave",
    "attendance",
    "talks",
    "expectations",
    "position",
    "companyValues",
    "colleaguesOnLeave",
  ]);
  const settingsMock = mkMock([
    "listUsers",
    "rolesCatalog",
    "permissionsMatrix",
    "gridEditors",
    "orgStructure",
    "holidays",
    "companyProfile",
    "expectations",
    "competenceFramework",
    "predmetAktivacija",
    "auditLog",
    "aiModels",
    "findUser",
  ]);

  beforeAll(async () => {
    process.env.AUTHZ_ENFORCE = "true";
    const moduleRef = await Test.createTestingModule({
      controllers: [
        ProjektniBiroController,
        MojProfilController,
        PodesavanjaController,
      ],
      providers: [
        { provide: ProjektniBiroService, useValue: pbMock },
        { provide: MojProfilService, useValue: profilMock },
        { provide: PodesavanjaService, useValue: settingsMock },
      ],
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

  const PB_READ_ROLES = rolesWith(PERMISSIONS.PB_READ);
  const PB_NO_READ = rolesWithout(PERMISSIONS.PB_READ);
  const REPORTS_OWN_ROLES = rolesWith(PERMISSIONS.PB_REPORTS_OWN);
  const REPORTS_OWN_NO = rolesWithout(PERMISSIONS.PB_REPORTS_OWN);
  const PROFILE_ROLES = rolesWith(PERMISSIONS.PROFILE_SELF);
  const PROFILE_NO = rolesWithout(PERMISSIONS.PROFILE_SELF);
  const USERS_ROLES = rolesWith(PERMISSIONS.SETTINGS_USERS);
  const USERS_NO = rolesWithout(PERMISSIONS.SETTINGS_USERS);
  const ORG_ROLES = rolesWith(PERMISSIONS.SETTINGS_ORG_PROFILE);
  const ORG_NO = rolesWithout(PERMISSIONS.SETTINGS_ORG_PROFILE);
  const PREDMET_ROLES = rolesWith(PERMISSIONS.SETTINGS_PREDMET_AKTIVACIJA);
  const PREDMET_NO = rolesWithout(PERMISSIONS.SETTINGS_PREDMET_AKTIVACIJA);
  const AUDIT_ROLES = rolesWith(PERMISSIONS.SETTINGS_AUDIT);
  const AUDIT_NO = rolesWithout(PERMISSIONS.SETTINGS_AUDIT);
  const SYSTEM_ROLES = rolesWith(PERMISSIONS.SETTINGS_SYSTEM);

  // ---------------- Projektni biro (pb.read) ----------------

  describe("PB read — pb.read (SELECT `true` paritet)", () => {
    it.each(PB_READ_ROLES)("GET /pb/tasks → 200 za %s", async (role) => {
      await get("/pb/tasks", role).expect(200);
    });
    it.each(PB_NO_READ)(
      "GET /pb/tasks → 403 za %s (deferred/nepoznata)",
      async (role) => {
        await get("/pb/tasks", role).expect(403);
      },
    );
    it("bez identiteta → 403 (JwtAuthGuard stub)", async () => {
      await get("/pb/tasks").expect(403);
    });
    it("GET /pb/projects·engineers·tips·notification-config → 200 za viewer", async () => {
      await get("/pb/projects", "viewer").expect(200);
      await get("/pb/engineers", "viewer").expect(200);
      await get("/pb/tips", "viewer").expect(200);
      await get("/pb/notification-config", "viewer").expect(200);
    });
  });

  describe("PB route ordering (literali pre :id)", () => {
    it("GET /pb/tips/categories → 200 (ne uhvaćeno kao /tips/:id) za admin", async () => {
      await get("/pb/tips/categories", "admin").expect(200);
    });
    it("GET /pb/tips/:id → 200 uuid, 400 ne-uuid (magacioner ima pb.read)", async () => {
      await get(`/pb/tips/${UUID}`, "magacioner").expect(200);
      await get("/pb/tips/nije-uuid", "magacioner").expect(400);
    });
    it("GET /pb/tasks/:id + /comments + /deps + /files → 200 pm (uuid)", async () => {
      await get(`/pb/tasks/${UUID}`, "pm").expect(200);
      await get(`/pb/tasks/${UUID}/comments`, "pm").expect(200);
      await get(`/pb/tasks/${UUID}/deps`, "pm").expect(200);
      await get(`/pb/tasks/${UUID}/files`, "pm").expect(200);
    });
    it("GET /pb/tasks/nije-uuid → 400", async () => {
      await get("/pb/tasks/nije-uuid", "pm").expect(400);
    });
  });

  describe("PB query DTO validacija (nevalidan uuid/datum → 400)", () => {
    it("GET /pb/tasks?projectId=nije-uuid → 400; validan → 200", async () => {
      await get("/pb/tasks?projectId=nije-uuid", "admin").expect(400);
      await get(`/pb/tasks?projectId=${UUID}`, "admin").expect(200);
    });
    it("GET /pb/work-reports/summary?from=nije-datum → 400", async () => {
      await get(
        "/pb/work-reports/summary?from=nije-datum&to=2026-07-31",
        "admin",
      ).expect(400);
    });
  });

  describe("PB work-reports — pb.reports_own (self-scope u DB)", () => {
    it.each(REPORTS_OWN_ROLES)(
      "GET /pb/work-reports → 200 za %s",
      async (role) => {
        await get("/pb/work-reports", role).expect(200);
      },
    );
    it.each(REPORTS_OWN_NO)(
      "GET /pb/work-reports → 403 za %s",
      async (role) => {
        await get("/pb/work-reports", role).expect(403);
      },
    );
  });

  // ---------------- Moj profil (profile.self) ----------------

  describe("Moj profil — profile.self (SVAKI prijavljen)", () => {
    it.each(PROFILE_ROLES)("GET /profile/me → 200 za %s", async (role) => {
      await get("/profile/me", role).expect(200);
    });
    it.each(PROFILE_NO)("GET /profile/me → 403 za %s", async (role) => {
      await get("/profile/me", role).expect(403);
    });
    it("GET /profile/summary·vacation·attendance·company-values → 200 za monter", async () => {
      await get("/profile/summary", "monter").expect(200);
      await get("/profile/vacation", "monter").expect(200);
      await get("/profile/attendance", "monter").expect(200);
      await get("/profile/company-values", "monter").expect(200);
    });
    it("GET /profile/attendance?from=nije-datum → 400", async () => {
      await get("/profile/attendance?from=nije-datum", "admin").expect(400);
    });
    it("bez identiteta → 403", async () => {
      await get("/profile/me").expect(403);
    });
  });

  // ---------------- Podešavanja ----------------

  describe("Podešavanja korisnici/matrica — settings.users (SAMO admin)", () => {
    it.each(USERS_ROLES)("GET /admin/users → 200 za %s", async (role) => {
      await get("/admin/users", role).expect(200);
    });
    it.each(USERS_NO)("GET /admin/users → 403 za %s", async (role) => {
      await get("/admin/users", role).expect(403);
    });
    it("GET /admin/roles/catalog + /permissions/matrix → 200 admin", async () => {
      await get("/admin/roles/catalog", "admin").expect(200);
      await get("/admin/permissions/matrix", "admin").expect(200);
    });
    it("GET /admin/roles/catalog → 403 za menadzment (nije admin)", async () => {
      await get("/admin/roles/catalog", "menadzment").expect(403);
    });
    it("GET /admin/users/:id → 200 admin (uuid), 400 ne-uuid", async () => {
      await get(`/admin/users/${UUID}`, "admin").expect(200);
      await get("/admin/users/nije-uuid", "admin").expect(400);
    });
  });

  describe("Podešavanja org_profile — settings.org_profile", () => {
    it.each(ORG_ROLES)(
      "GET /admin/company-profile → 200 za %s",
      async (role) => {
        await get("/admin/company-profile", role).expect(200);
      },
    );
    it.each(ORG_NO)("GET /admin/company-profile → 403 za %s", async (role) => {
      await get("/admin/company-profile", role).expect(403);
    });
    it("GET /admin/expectations + /competence-framework → 200 pm, 403 hr", async () => {
      await get("/admin/expectations", "pm").expect(200);
      await get("/admin/competence-framework", "pm").expect(200);
      await get("/admin/expectations", "hr").expect(403);
    });
  });

  describe("Podešavanja predmet/audit/system", () => {
    it.each(PREDMET_ROLES)(
      "GET /admin/predmet-aktivacija → 200 za %s",
      async (role) => {
        await get("/admin/predmet-aktivacija", role).expect(200);
      },
    );
    it.each(PREDMET_NO)(
      "GET /admin/predmet-aktivacija → 403 za %s",
      async (role) => {
        await get("/admin/predmet-aktivacija", role).expect(403);
      },
    );
    it.each(AUDIT_ROLES)("GET /admin/audit-log → 200 za %s", async (role) => {
      await get("/admin/audit-log", role).expect(200);
    });
    it.each(AUDIT_NO)("GET /admin/audit-log → 403 za %s", async (role) => {
      await get("/admin/audit-log", role).expect(403);
    });
    it.each(SYSTEM_ROLES)(
      "GET /admin/system/ai-models → 200 za %s",
      async (role) => {
        await get("/admin/system/ai-models", role).expect(200);
      },
    );
    it("GET /admin/system/ai-models → 403 za menadzment", async () => {
      await get("/admin/system/ai-models", "menadzment").expect(403);
    });
  });
});
