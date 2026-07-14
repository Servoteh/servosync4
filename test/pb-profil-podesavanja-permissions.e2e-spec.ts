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
    // R2 mutacije
    "createTask",
    "updateTask",
    "bulkUpdateTasks",
    "softDeleteTask",
    "bulkSoftDeleteTasks",
    "updateProgress",
    "createComment",
    "updateComment",
    "deleteComment",
    "addDep",
    "deleteDep",
    "uploadTaskFile",
    "deleteTaskFile",
    "signTaskFile",
    "createWorkReport",
    "deleteWorkReport",
    "updateNotificationConfig",
    "saveTip",
    "toggleTipLike",
    "softDeleteTip",
    "upsertTipCategory",
    "deleteTipCategory",
    "uploadTipFile",
    "deleteTipFile",
    "signTipFile",
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
    // R2 mutacije
    "submitVacation",
    "reviseVacation",
    "cancelVacation",
    "deleteVacation",
    "submitMakeup",
    "deleteMakeup",
    "submitPaidLeave",
    "deletePaidLeave",
    "submitAttendanceCorrection",
    "ackDocument",
    "openSelfAssessment",
    "saveSelfScores",
    "saveSelfAnswers",
    "submitSelfAssessment",
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
  const send = (
    method: "post" | "patch" | "delete",
    path: string,
    role?: string,
    body?: unknown,
  ) => {
    const r = request(app.getHttpServer())[method](`/api/v1${path}`);
    if (role) r.set("x-test-role", role);
    return body ? r.send(body) : r;
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

  // ==================================================================
  // R2 MUTACIJE — rola × endpoint × 2xx/403 (AUTHZ_ENFORCE=true)
  // Guard radi PRE ValidationPipe → denied rola dobija 403 i sa validnim telom.
  // Row-odluka (edit-krug, 1h/24h prozori, draft/org-članstvo, self-scope,
  // submitted_by=email, rev_current_employee_id) sprovodi sy15 RLS/DEFINER u R4 smoke.
  // ==================================================================

  const EDIT_ROLES = rolesWith(PERMISSIONS.PB_EDIT);
  const NO_EDIT = rolesWithout(PERMISSIONS.PB_EDIT);
  const COMMENT_ROLES = rolesWith(PERMISSIONS.PB_COMMENT);
  const NO_COMMENT = rolesWithout(PERMISSIONS.PB_COMMENT);
  const PROGRESS_ROLES = rolesWith(PERMISSIONS.PB_PROGRESS);
  const NO_PROGRESS = rolesWithout(PERMISSIONS.PB_PROGRESS);
  const TIPS_WRITE_ROLES = rolesWith(PERMISSIONS.PB_TIPS_WRITE);
  const NO_TIPS_WRITE = rolesWithout(PERMISSIONS.PB_TIPS_WRITE);
  const ADMIN_ROLES = rolesWith(PERMISSIONS.PB_ADMIN);
  const NO_ADMIN = rolesWithout(PERMISSIONS.PB_ADMIN);

  describe("PB write — pb.edit (create/update/bulk/soft-delete task)", () => {
    const body = { clientEventId: UUID, naziv: "T" };
    it.each(EDIT_ROLES)("POST /pb/tasks → 201 za %s", async (role) => {
      await send("post", "/pb/tasks", role, body).expect(201);
    });
    it.each(NO_EDIT)("POST /pb/tasks → 403 za %s", async (role) => {
      await send("post", "/pb/tasks", role, body).expect(403);
    });
    it("PATCH /pb/tasks/bulk (literal pre :id) → 200 admin, 403 viewer", async () => {
      await send("patch", "/pb/tasks/bulk", "admin", {
        ids: [UUID],
        status: "U toku",
      }).expect(200);
      await send("patch", "/pb/tasks/bulk", "viewer", {
        ids: [UUID],
      }).expect(403);
    });
    it("POST /pb/tasks/soft-delete (literal) → 201 hr (pb.edit D7)", async () => {
      await send("post", "/pb/tasks/soft-delete", "hr", {
        ids: [UUID],
      }).expect(201);
    });
    it("PATCH /pb/tasks/:id → 200 pm, 403 monter", async () => {
      await send("patch", `/pb/tasks/${UUID}`, "pm", { naziv: "x" }).expect(200);
      await send("patch", `/pb/tasks/${UUID}`, "monter", {
        naziv: "x",
      }).expect(403);
    });
  });

  describe("PB progress — pb.progress (inzenjer restriktovani edit + edit-krug)", () => {
    it.each(PROGRESS_ROLES)(
      "POST /pb/tasks/:id/progress → 201 za %s",
      async (role) => {
        await send("post", `/pb/tasks/${UUID}/progress`, role, {
          status: "U toku",
          procenat: 50,
        }).expect(201);
      },
    );
    it.each(NO_PROGRESS)(
      "POST /pb/tasks/:id/progress → 403 za %s",
      async (role) => {
        await send("post", `/pb/tasks/${UUID}/progress`, role, {}).expect(403);
      },
    );
    it("progress procenat 500 → 400 (DTO, admin)", async () => {
      await send("post", `/pb/tasks/${UUID}/progress`, "admin", {
        procenat: 500,
      }).expect(400);
    });
  });

  describe("PB komentari — pb.comment (edit-krug ∪ inzenjer; 1h prozor u RLS)", () => {
    it.each(COMMENT_ROLES)(
      "POST /pb/tasks/:id/comments → 201 za %s",
      async (role) => {
        await send("post", `/pb/tasks/${UUID}/comments`, role, {
          clientEventId: UUID,
          body: "komentar",
        }).expect(201);
      },
    );
    it.each(NO_COMMENT)(
      "POST /pb/tasks/:id/comments → 403 za %s",
      async (role) => {
        await send("post", `/pb/tasks/${UUID}/comments`, role, {
          clientEventId: UUID,
          body: "k",
        }).expect(403);
      },
    );
    it("PATCH/DELETE /pb/comments/:cid → 200 admin, 403 magacioner", async () => {
      await send("patch", `/pb/comments/${UUID}`, "admin", {
        body: "x",
      }).expect(200);
      await send("delete", `/pb/comments/${UUID}`, "magacioner").expect(403);
    });
  });

  describe("PB saveti — pb.tips_write (edit-krug ∪ inzenjer/projektant_vodja)", () => {
    const body = { clientEventId: UUID, naslov: "Naslov", telo: "Telo bar 10" };
    it.each(TIPS_WRITE_ROLES)("POST /pb/tips → 201 za %s", async (role) => {
      await send("post", "/pb/tips", role, body).expect(201);
    });
    it.each(NO_TIPS_WRITE)("POST /pb/tips → 403 za %s", async (role) => {
      await send("post", "/pb/tips", role, body).expect(403);
    });
    it("POST /pb/tips/:id/like + /soft-delete → 201 viewer (pb.read; DB odlučuje autora)", async () => {
      await send("post", `/pb/tips/${UUID}/like`, "viewer").expect(201);
      await send("post", `/pb/tips/${UUID}/soft-delete`, "viewer").expect(201);
    });
  });

  describe("PB admin — pb.admin (notif config + kategorije = SAMO admin)", () => {
    it.each(ADMIN_ROLES)(
      "POST /pb/tips/categories (literal pre :id) → 201 za %s",
      async (role) => {
        await send("post", "/pb/tips/categories", role, {
          naziv: "CNC",
        }).expect(201);
      },
    );
    it.each(NO_ADMIN)(
      "PATCH /pb/notification-config → 403 za %s",
      async (role) => {
        await send("patch", "/pb/notification-config", role, {
          enabled: true,
        }).expect(403);
      },
    );
    it("PATCH /pb/notification-config → 200 admin", async () => {
      await send("patch", "/pb/notification-config", "admin", {
        enabled: false,
      }).expect(200);
    });
  });

  describe("PB work-report write — pb.reports_own (self-scope u DB)", () => {
    it("POST /pb/work-reports → 201 monter (svi imaju reports_own)", async () => {
      await send("post", "/pb/work-reports", "monter", {
        clientEventId: UUID,
        datum: "2026-08-01",
        sati: 4,
      }).expect(201);
    });
    it("POST /pb/work-reports → 403 bez identiteta", async () => {
      await send("post", "/pb/work-reports", undefined, {
        clientEventId: UUID,
        datum: "2026-08-01",
        sati: 4,
      }).expect(403);
    });
    it("POST /pb/work-reports sati=99 → 400 (DTO, admin)", async () => {
      await send("post", "/pb/work-reports", "admin", {
        clientEventId: UUID,
        datum: "2026-08-01",
        sati: 99,
      }).expect(400);
    });
  });

  // ---------------- Moj profil mutacije (profile.self = svaki prijavljen) ----------------

  describe("Profil mutacije — profile.self (svaki prijavljen; DB RLS self-scope)", () => {
    it.each(PROFILE_ROLES)(
      "POST /profile/acks → 201 za %s",
      async (role) => {
        await send("post", "/profile/acks", role, {
          clientEventId: UUID,
          refType: "pravilnik_go",
          refId: "v1",
        }).expect(201);
      },
    );
    it.each(PROFILE_NO)("POST /profile/acks → 403 za %s", async (role) => {
      await send("post", "/profile/acks", role, {
        clientEventId: UUID,
        refType: "x",
        refId: "1",
      }).expect(403);
    });
    it("POST /profile/vacation-requests → 201 monter; bez identiteta → 403", async () => {
      await send("post", "/profile/vacation-requests", "monter", {
        clientEventId: UUID,
        dateFrom: "2026-08-01",
        dateTo: "2026-08-05",
        daysCount: 5,
      }).expect(201);
      await send("post", "/profile/vacation-requests", undefined, {
        clientEventId: UUID,
        dateFrom: "2026-08-01",
        dateTo: "2026-08-05",
        daysCount: 5,
      }).expect(403);
    });
    it("POST /profile/vacation-requests/:id/cancel + DELETE :id → 201/200 (route ordering)", async () => {
      await send(
        "post",
        `/profile/vacation-requests/${UUID}/cancel`,
        "hr",
      ).expect(201);
      await send(
        "delete",
        `/profile/vacation-requests/${UUID}`,
        "hr",
      ).expect(200);
    });
    it("POST /profile/attendance/corrections → 400 kratko obrazloženje (DTO)", async () => {
      await send("post", "/profile/attendance/corrections", "admin", {
        clientEventId: UUID,
        day: "2026-08-01",
        timeIn: "08:00",
        reason: "abc",
      }).expect(400);
    });
    it("POST /profile/assessment/self/open → 201 proizvodni_radnik", async () => {
      await send(
        "post",
        "/profile/assessment/self/open",
        "proizvodni_radnik",
        {},
      ).expect(201);
    });
  });
});
