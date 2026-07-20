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
import { PlanMontazeController } from "../src/modules/plan-montaze/plan-montaze.controller";
import { PlanMontazeService } from "../src/modules/plan-montaze/plan-montaze.service";
import { PlanProizvodnjeController } from "../src/modules/plan-proizvodnje/plan-proizvodnje.controller";
import { PlanProizvodnjeService } from "../src/modules/plan-proizvodnje/plan-proizvodnje.service";
import { PracenjeController } from "../src/modules/pracenje/pracenje.controller";
import { PracenjeService } from "../src/modules/pracenje/pracenje.service";
import { PracenjeReadService } from "../src/modules/pracenje/pracenje-read.service";
import { PracenjeAkcijeSy15Service } from "../src/modules/pracenje/pracenje-akcije-sy15.service";
import { PracenjePdfService } from "../src/modules/pracenje/pracenje-pdf.service";
import { ALL_ROLE_KEYS } from "../src/common/authz/roles";
import { roleHasPermission } from "../src/common/authz/role-permissions";
import { PrismaService } from "../src/prisma/prisma.service";
import {
  PERMISSIONS,
  type PermissionKey,
} from "../src/common/authz/permissions";

/**
 * e2e PERMISSION MATRICA — TALAS C (MODULE_SPEC_planovi_pracenje_30.md §5 t.38),
 * rola × endpoint × 200/403 sa AUTHZ_ENFORCE=true (realno V2 ponašanje). JwtAuthGuard je
 * stub (identitet iz `x-test-role`); servisi mokovani (bez sy15 baze). Row-scope
 * (has_edit_role project-scope, autor-scope izveštaja, can_edit_pracenje) sprovodi DB kroz
 * GUC — to je R2 živi smoke, ne ovaj rola-sloj. Liste rola izvedene iz ALL_ROLE_KEYS
 * (test-hardening: nova/pogrešno-grantovana uloga se NE provlači).
 */
describe("Talas C permission matrica (e2e, AUTHZ_ENFORCE=true)", () => {
  let app: INestApplication;
  const UUID = "3b241101-e2bb-4255-8caf-4136c566a962";

  const mk = (methods: string[]): Record<string, jest.Mock> => {
    const o: Record<string, jest.Mock> = {};
    for (const m of methods) o[m] = jest.fn().mockResolvedValue({ data: {} });
    return o;
  };
  const montazaMock = mk([
    "projectsTree",
    "listReports",
    "reportDetail",
    "reportPhotos",
    "aiModel",
    "lookupPredmeti",
    "lookupDrawings",
    // R2 mutacije
    "upsertProject",
    "updateProject",
    "deleteProject",
    "upsertWorkPackage",
    "updateWorkPackage",
    "deleteWorkPackage",
    "upsertPhase",
    "updatePhase",
    "deletePhase",
    "createReport",
    "linkPredmet",
    "uploadPhotos",
    "uploadPdf",
    "reportPdfUrl",
    "photoUrl",
    "aiGenerate",
    "setAiModel",
  ]);
  const ppMock = mk([
    "machines",
    "operations",
    "operationsAll",
    "operationsSearch",
    "cooperation",
    "cooperationGroups",
    "reassignAudit",
    "drawings",
    "techProcedure",
    "bridgeStatus",
    // R2 mutacije
    "upsertOverlay",
    "reorderOverlays",
    "setUrgent",
    "clearUrgent",
    "reassign",
    "bulkReassign",
    "upsertCooperationGroup",
    "patchCooperationGroup",
    "uploadDrawing",
    "deleteDrawing",
    "drawingSignUrl",
    "bigtehnDrawingSignUrl",
  ]);
  // READ sloj (F1) — 2.0 tabele, `PracenjeReadService`.
  const pracenjeReadMock = mk([
    "portfolio",
    "predmeti",
    "podsklopovi",
    "izvestaj",
    "rnResolve",
    "rn",
    "operativniPlan",
    "canEdit",
    "aktivnostIstorija",
    "prijave",
    "odeljenja",
    "radnici",
    "searchDelovi",
    "planPrioritet",
    "ensureRnFromBigtehn",
    "crtezSignUrl",
  ]);
  // Izolovani sy15 lookup (akcione-tacke) — `PracenjeAkcijeSy15Service`.
  const pracenjeAkcijeMock = mk(["akcioneTacke"]);
  // MUTACIJE (F1) — 2.0 tabele, `PracenjeService` (sy15-free).
  const pracenjeMock = mk([
    "upsertAktivnost",
    "zatvoriAktivnost",
    "blokirajAktivnost",
    "odblokirajAktivnost",
    "promoteAkcionaTacka",
    "upsertNapomena",
    "upsertManualOverride",
    "upsertParentOverride",
    "shiftPrioritet",
    "logExport",
  ]);

  beforeAll(async () => {
    process.env.AUTHZ_ENFORCE = "true"; // pre instanciranja PermissionsGuard-a
    const moduleRef = await Test.createTestingModule({
      controllers: [
        PlanMontazeController,
        PlanProizvodnjeController,
        PracenjeController,
      ],
      providers: [
        { provide: PrismaService, useValue: { userPermissionOverride: { findUnique: async () => null } } },
        
        { provide: PlanMontazeService, useValue: montazaMock },
        { provide: PlanProizvodnjeService, useValue: ppMock },
        { provide: PracenjeService, useValue: pracenjeMock },
        { provide: PracenjeReadService, useValue: pracenjeReadMock },
        { provide: PracenjeAkcijeSy15Service, useValue: pracenjeAkcijeMock },
        // PDF strim ruta (crtez/:drawingId/pdf/content) gejtuje samo pracenje.read
        // (odluka O7) — nije zasebno asertovana ovde; prazan stub zadovoljava DI.
        { provide: PracenjePdfService, useValue: {} },
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
    method: "post" | "put" | "patch" | "delete",
    path: string,
    role?: string,
    body?: object,
  ) => {
    let r = request(app.getHttpServer())[method](`/api/v1${path}`);
    if (role) r = r.set("x-test-role", role);
    return body ? r.send(body) : r;
  };

  const rolesWith = (perm: PermissionKey) =>
    ALL_ROLE_KEYS.filter((r) => roleHasPermission(r, perm));
  const rolesWithout = (perm: PermissionKey) =>
    ALL_ROLE_KEYS.filter((r) => !roleHasPermission(r, perm));

  const MONTAZA_READ = rolesWith(PERMISSIONS.MONTAZA_READ);
  const MONTAZA_NO_READ = rolesWithout(PERMISSIONS.MONTAZA_READ);
  const PP_READ = rolesWith(PERMISSIONS.PLAN_PROIZVODNJE_READ);
  const PP_NO_READ = rolesWithout(PERMISSIONS.PLAN_PROIZVODNJE_READ);
  const PP_FORCE = rolesWith(PERMISSIONS.PLAN_PROIZVODNJE_FORCE);
  const PP_NO_FORCE = rolesWithout(PERMISSIONS.PLAN_PROIZVODNJE_FORCE);
  const PRACENJE_READ = rolesWith(PERMISSIONS.PRACENJE_READ);
  const PRACENJE_NO_READ = rolesWithout(PERMISSIONS.PRACENJE_READ);

  // ---------- Plan montaže — montaza.read (modul ungated) ----------

  describe("Plan montaže read — montaza.read (svi prijavljeni)", () => {
    it.each(MONTAZA_READ)("GET /montaza/projects → 200 za %s", async (role) => {
      await get("/montaza/projects", role).expect(200);
    });
    it.each(MONTAZA_NO_READ)(
      "GET /montaza/projects → 403 za %s (deferred/prelazno rola)",
      async (role) => {
        await get("/montaza/projects", role).expect(403);
      },
    );
    it.each(["user", "nepoznata_rola"])(
      "GET /montaza/projects → 403 za %s (default deny)",
      async (role) => {
        await get("/montaza/projects", role).expect(403);
      },
    );
    it("bez identiteta → 403 (JwtAuthGuard stub)", async () => {
      await get("/montaza/projects").expect(403);
    });
  });

  describe("Plan montaže route ordering (literali/`:id` uuid-pipe)", () => {
    it("GET /montaza/ai-model → 200 za sef (literal, ne uhvaćen kao reports/:id)", async () => {
      await get("/montaza/ai-model", "sef").expect(200);
    });
    it("GET /montaza/lookups/predmeti → 200 za monter", async () => {
      await get("/montaza/lookups/predmeti?q=abc", "monter").expect(200);
    });
    it("GET /montaza/reports/:id → 200 uuid, 400 ne-uuid (magacioner ima montaza.read)", async () => {
      await get(`/montaza/reports/${UUID}`, "magacioner").expect(200);
      await get("/montaza/reports/nije-uuid", "magacioner").expect(400);
    });
    it("GET /montaza/lookups/drawings bez `codes` → 400 (admin)", async () => {
      await get("/montaza/lookups/drawings", "admin").expect(400);
      await get("/montaza/lookups/drawings?codes=A-1", "admin").expect(200);
    });
  });

  // ---------- Plan proizvodnje — plan_proizvodnje.read (gated) ----------

  describe("Plan proizvodnje read — plan_proizvodnje.read (canAccessPlanProizvodnje)", () => {
    it.each(PP_READ)("GET /plan-proizvodnje/machines → 200 za %s", async (role) => {
      await get("/plan-proizvodnje/machines", role).expect(200);
    });
    it.each(PP_NO_READ)(
      "GET /plan-proizvodnje/machines → 403 za %s",
      async (role) => {
        await get("/plan-proizvodnje/machines", role).expect(403);
      },
    );
    it("modul gated: sef/tehnolog/magacioner (imaju montaza.read) → 403 na proizvodnju", async () => {
      for (const role of ["sef", "tehnolog", "magacioner"]) {
        await get("/montaza/projects", role).expect(200);
        await get("/plan-proizvodnje/machines", role).expect(403);
      }
    });
    it("GET /plan-proizvodnje/operations/all → 200 cnc_operater; /operations/search literal → 200 hr", async () => {
      await get("/plan-proizvodnje/operations/all", "cnc_operater").expect(200);
      await get("/plan-proizvodnje/operations/search?q=xy", "hr").expect(200);
    });
  });

  describe("Reassign audit — plan_proizvodnje.force (admin/menadzment)", () => {
    it.each(PP_FORCE)(
      "GET /plan-proizvodnje/reassign/audit → 200 za %s",
      async (role) => {
        await get("/plan-proizvodnje/reassign/audit", role).expect(200);
      },
    );
    it.each(PP_NO_FORCE)(
      "GET /plan-proizvodnje/reassign/audit → 403 za %s (read ali ne force)",
      async (role) => {
        await get("/plan-proizvodnje/reassign/audit", role).expect(403);
      },
    );
    it("pm ima plan_proizvodnje.read ali NE force → audit 403, machines 200", async () => {
      await get("/plan-proizvodnje/machines", "pm").expect(200);
      await get("/plan-proizvodnje/reassign/audit", "pm").expect(403);
    });
    it("GET /plan-proizvodnje/tech-procedure/:workOrderId → 200 int, 400 ne-int (viewer)", async () => {
      await get("/plan-proizvodnje/tech-procedure/40681", "viewer").expect(200);
      await get("/plan-proizvodnje/tech-procedure/abc", "viewer").expect(400);
    });
  });

  // ---------- Praćenje — pracenje.read (gated) ----------

  describe("Praćenje read — pracenje.read (canAccessPlanProizvodnje)", () => {
    it.each(PRACENJE_READ)("GET /pracenje/portfolio → 200 za %s", async (role) => {
      await get("/pracenje/portfolio", role).expect(200);
    });
    it.each(PRACENJE_NO_READ)(
      "GET /pracenje/portfolio → 403 za %s",
      async (role) => {
        await get("/pracenje/portfolio", role).expect(403);
      },
    );
    it("route ordering: /pracenje/rn/resolve literal (200) NIJE rn/:rnId int-pipe", async () => {
      await get("/pracenje/rn/resolve?ref=RN-1", "admin").expect(200);
      // 2.0: rn/:rnId je Int (work_orders.id) — validan int 200, uuid/tekst 400.
      await get("/pracenje/rn/40681", "admin").expect(200);
      await get(`/pracenje/rn/${UUID}`, "admin").expect(400);
      await get("/pracenje/rn/nije-uuid", "admin").expect(400);
    });
    it("GET /pracenje/predmeti/:itemId/podsklopovi → 200 int, 400 ne-int (viewer)", async () => {
      await get("/pracenje/predmeti/7602/podsklopovi", "viewer").expect(200);
      await get("/pracenje/predmeti/abc/podsklopovi", "viewer").expect(400);
    });
    it("GET /pracenje/rn/resolve bez `ref` → 400 (admin)", async () => {
      await get("/pracenje/rn/resolve", "admin").expect(400);
    });
    it("GET /pracenje/predmeti/:itemId/izvestaj?rootRn=nije-broj → 400", async () => {
      await get(
        "/pracenje/predmeti/7602/izvestaj?rootRn=nije-broj",
        "admin",
      ).expect(400);
      await get("/pracenje/predmeti/7602/izvestaj?rootRn=123", "admin").expect(
        200,
      );
    });
  });

  it("presek: proizvodnja read = pracenje read (isti gate) — magacioner nema nijedan", async () => {
    await get("/plan-proizvodnje/machines", "magacioner").expect(403);
    await get("/pracenje/portfolio", "magacioner").expect(403);
  });

  // ---------- Adversarni review R1 (regresija) ----------

  describe("Review nalaz #1 — rnResolve numerički ref (grana legacy_idrn::int)", () => {
    // Ranije e2e je gađao samo ne-numerički `?ref=RN-1` pa legacy_idrn grana nije bila
    // dohvaćena. Čisto-numerički ref (npr. „9400" kojim počinju SVI RN brojevi) MORA proći
    // do servisa (200 kroz mock). SQL ispravnost (`legacy_idrn = $1::int` umesto
    // `integer = text` → 42883) verifikovana na živoj sy15 (read-only).
    it("GET /pracenje/rn/resolve?ref=9400 → 200 (admin)", async () => {
      await get("/pracenje/rn/resolve?ref=9400", "admin").expect(200);
    });
    it("GET /pracenje/rn/resolve?ref=45767 → 200 (legacy_idrn numerik)", async () => {
      await get("/pracenje/rn/resolve?ref=45767", "admin").expect(200);
    });
  });

  describe("Review nalaz #2 — decimalni broj u BigInt/::int polju → 400 (ne 500)", () => {
    // `@IsNumberString` je primao „1.5" pa je `BigInt("1.5")` bacao SyntaxError PRE
    // try/catch-a → 500. `@Matches(/^\d+$/)` odbija decimale u pipe-u → 400.
    it("GET /plan-proizvodnje/drawings?workOrder=1.5&line=1 → 400 (admin)", async () => {
      await get(
        "/plan-proizvodnje/drawings?workOrder=1.5&line=1",
        "admin",
      ).expect(400);
    });
    it("GET /plan-proizvodnje/drawings?workOrder=40681&line=1 → 200 (validno)", async () => {
      await get(
        "/plan-proizvodnje/drawings?workOrder=40681&line=1",
        "admin",
      ).expect(200);
    });
    it("GET /pracenje/predmeti/7602/izvestaj?rootRn=1.5 → 400", async () => {
      await get(
        "/pracenje/predmeti/7602/izvestaj?rootRn=1.5",
        "admin",
      ).expect(400);
    });
    it("GET /pracenje/prijave?workOrder=1.5&op=2 → 400; ?op=2.5 → 400", async () => {
      await get("/pracenje/prijave?workOrder=1.5&op=2", "admin").expect(400);
      await get("/pracenje/prijave?workOrder=1&op=2.5", "admin").expect(400);
    });
    it("GET /pracenje/prijave?workOrder=40681&op=2 → 200 (validno)", async () => {
      await get("/pracenje/prijave?workOrder=40681&op=2", "admin").expect(200);
    });
  });

  // ==========================================================================
  // R2 — MUTACIONA permission matrica (rola × endpoint × 200/403, AUTHZ_ENFORCE=true)
  // ==========================================================================

  const MONTAZA_EDIT = rolesWith(PERMISSIONS.MONTAZA_EDIT);
  const MONTAZA_NO_EDIT = rolesWithout(PERMISSIONS.MONTAZA_EDIT);
  const MONTAZA_IZV = rolesWith(PERMISSIONS.MONTAZA_IZVESTAJI);
  const MONTAZA_NO_IZV = rolesWithout(PERMISSIONS.MONTAZA_IZVESTAJI);
  const MONTAZA_AI = rolesWith(PERMISSIONS.MONTAZA_AI_ADMIN);
  const MONTAZA_NO_AI = rolesWithout(PERMISSIONS.MONTAZA_AI_ADMIN);
  const PP_EDIT = rolesWith(PERMISSIONS.PLAN_PROIZVODNJE_EDIT);
  const PP_NO_EDIT = rolesWithout(PERMISSIONS.PLAN_PROIZVODNJE_EDIT);
  const PP_KOOP = rolesWith(PERMISSIONS.PLAN_PROIZVODNJE_KOOP_ADMIN);
  const PP_NO_KOOP = rolesWithout(PERMISSIONS.PLAN_PROIZVODNJE_KOOP_ADMIN);
  const PR_EDIT = rolesWith(PERMISSIONS.PRACENJE_EDIT);
  const PR_NO_EDIT = rolesWithout(PERMISSIONS.PRACENJE_EDIT);
  const PR_MANAGE = rolesWith(PERMISSIONS.PRACENJE_MANAGE);
  const PR_NO_MANAGE = rolesWithout(PERMISSIONS.PRACENJE_MANAGE);
  const PR_PRIO = rolesWith(PERMISSIONS.PRACENJE_PRIORITET);
  const PR_NO_PRIO = rolesWithout(PERMISSIONS.PRACENJE_PRIORITET);

  describe("Plan montaže PM CRUD — montaza.edit (C1 tim_lider; C2 hr/poslovni_admin NEMAJU)", () => {
    const body = { projectCode: "X", projectName: "Y" };
    it.each(MONTAZA_EDIT)("POST /montaza/projects → 200 za %s", async (role) => {
      await send("post", "/montaza/projects", role, body).expect(201);
    });
    it.each(MONTAZA_NO_EDIT)(
      "POST /montaza/projects → 403 za %s",
      async (role) => {
        await send("post", "/montaza/projects", role, body).expect(403);
      },
    );
    it("C1: tim_lider IMA edit (POST projects 201); C2: hr/poslovni_admin/viewer 403", async () => {
      await send("post", "/montaza/projects", "tim_lider", body).expect(201);
      await send("post", "/montaza/projects", "hr", body).expect(403);
      await send("post", "/montaza/projects", "poslovni_admin", body).expect(403);
      await send("post", "/montaza/projects", "viewer", body).expect(403);
    });
    it("PATCH/DELETE projects + work-packages + phases → montaza.edit (tim_lider 200, viewer 403)", async () => {
      await send("patch", `/montaza/projects/${UUID}`, "tim_lider", {}).expect(200);
      await send("delete", `/montaza/projects/${UUID}`, "viewer").expect(403);
      await send("post", "/montaza/work-packages", "tim_lider", {
        projectId: UUID,
        name: "N",
      }).expect(201);
      await send("post", "/montaza/phases", "leadpm", {
        projectId: UUID,
        workPackageId: UUID,
        phaseName: "F",
      }).expect(201);
      await send("post", "/montaza/phases", "hr", {
        projectId: UUID,
        workPackageId: UUID,
        phaseName: "F",
      }).expect(403);
    });
  });

  describe("Izveštaji montera — montaza.izvestaji (kreiranje svima; ne-aktivne role 403)", () => {
    it.each(MONTAZA_IZV)("POST /montaza/reports → 201 za %s", async (role) => {
      await send("post", "/montaza/reports", role, { id: UUID }).expect(201);
    });
    it.each(MONTAZA_NO_IZV)(
      "POST /montaza/reports → 403 za %s (deferred rola)",
      async (role) => {
        await send("post", "/montaza/reports", role, { id: UUID }).expect(403);
      },
    );
    it("monter (pogon) kreira izveštaj (201) i AI-generate (201); user 403", async () => {
      await send("post", "/montaza/reports", "monter", { id: UUID }).expect(201);
      await send("post", "/montaza/reports/ai-generate", "monter", {
        tekst: "x",
      }).expect(201);
      await send("post", "/montaza/reports/ai-generate", "user", {
        tekst: "x",
      }).expect(403);
    });
    it("PATCH /montaza/reports/:id/predmet → 200 monter (autor-scope u DB)", async () => {
      await send("patch", `/montaza/reports/${UUID}/predmet`, "monter", {}).expect(200);
    });
  });

  describe("AI model — montaza.ai_admin (SAMO admin)", () => {
    it.each(MONTAZA_AI)("PUT /montaza/ai-model → 200 za %s", async (role) => {
      await send("put", "/montaza/ai-model", role, {
        model: "claude-opus-4-8",
      }).expect(200);
    });
    it.each(MONTAZA_NO_AI)(
      "PUT /montaza/ai-model → 403 za %s",
      async (role) => {
        await send("put", "/montaza/ai-model", role, {
          model: "claude-opus-4-8",
        }).expect(403);
      },
    );
    it("menadzment ima izvestaji ali NE ai_admin → ai-model 403", async () => {
      await send("put", "/montaza/ai-model", "menadzment", {
        model: "claude-opus-4-8",
      }).expect(403);
    });
  });

  describe("Plan proizvodnje write — plan_proizvodnje.edit", () => {
    const ov = { workOrderId: "1", lineId: "1" };
    it.each(PP_EDIT)("POST /plan-proizvodnje/overlays → 201 za %s", async (role) => {
      await send("post", "/plan-proizvodnje/overlays", role, ov).expect(201);
    });
    it.each(PP_NO_EDIT)(
      "POST /plan-proizvodnje/overlays → 403 za %s",
      async (role) => {
        await send("post", "/plan-proizvodnje/overlays", role, ov).expect(403);
      },
    );
    it("urgency PUT/DELETE + drawings POST/DELETE + reorder → edit (pm 200, viewer 403)", async () => {
      await send("put", "/plan-proizvodnje/urgency/9400", "pm", {}).expect(200);
      await send("delete", "/plan-proizvodnje/urgency/9400", "viewer").expect(403);
      await send("post", "/plan-proizvodnje/overlays/reorder", "pm", {
        items: [{ workOrderId: "1", lineId: "1" }],
      }).expect(201);
      await send("delete", "/plan-proizvodnje/drawings/5", "viewer").expect(403);
    });
    it("overlays validacija: workOrderId '1.5' → 400 (digits), '1' → 201 (pm)", async () => {
      await send("post", "/plan-proizvodnje/overlays", "pm", {
        workOrderId: "1.5",
        lineId: "1",
      }).expect(400);
    });
  });

  describe("Reassign — edit; force → plan_proizvodnje.force", () => {
    it("reassign BEZ force → edit (pm 200); SA force → force (pm 403, menadzment 200, admin 200)", async () => {
      await send("post", "/plan-proizvodnje/reassign", "pm", {
        workOrderId: "1",
        lineId: "1",
      }).expect(201);
      await send("post", "/plan-proizvodnje/reassign", "pm", {
        workOrderId: "1",
        lineId: "1",
        force: true,
      }).expect(403);
      await send("post", "/plan-proizvodnje/reassign", "menadzment", {
        workOrderId: "1",
        lineId: "1",
        force: true,
      }).expect(201);
      await send("post", "/plan-proizvodnje/reassign/bulk", "admin", {
        pairs: [{ workOrderId: "1", lineId: "1" }],
        force: true,
      }).expect(201);
    });
    it("reassign viewer (nema edit) → 403 i bez force", async () => {
      await send("post", "/plan-proizvodnje/reassign", "viewer", {
        workOrderId: "1",
        lineId: "1",
      }).expect(403);
    });
  });

  describe("Auto-koop grupe — plan_proizvodnje.koop_admin (SAMO admin)", () => {
    const g = { rjGroupCode: "2.10", groupLabel: "L" };
    it.each(PP_KOOP)(
      "POST /plan-proizvodnje/cooperation/groups → 201 za %s",
      async (role) => {
        await send("post", "/plan-proizvodnje/cooperation/groups", role, g).expect(201);
      },
    );
    it.each(PP_NO_KOOP)(
      "POST /plan-proizvodnje/cooperation/groups → 403 za %s",
      async (role) => {
        await send("post", "/plan-proizvodnje/cooperation/groups", role, g).expect(403);
      },
    );
    it("pm/menadzment imaju edit ali NE koop_admin → grupe 403", async () => {
      await send("post", "/plan-proizvodnje/cooperation/groups", "pm", g).expect(403);
      await send("post", "/plan-proizvodnje/cooperation/groups", "menadzment", g).expect(403);
    });
  });

  describe("Praćenje operativni plan — pracenje.edit", () => {
    // 2.0: odeljenjeId je Int (odeljenja.id), NE uuid; aktivnost :id je Int.
    const akt = { odeljenjeId: 1, nazivAktivnosti: "A" };
    it.each(PR_EDIT)("POST /pracenje/aktivnosti → 201 za %s", async (role) => {
      await send("post", "/pracenje/aktivnosti", role, akt).expect(201);
    });
    it.each(PR_NO_EDIT)(
      "POST /pracenje/aktivnosti → 403 za %s",
      async (role) => {
        await send("post", "/pracenje/aktivnosti", role, akt).expect(403);
      },
    );
    it("blokiraj (razlog obavezan): validan 201, prazan razlog 400 (pm)", async () => {
      await send("post", "/pracenje/aktivnosti/123/blokiraj", "pm", {
        razlog: "kvar",
      }).expect(201);
      await send("post", "/pracenje/aktivnosti/123/blokiraj", "pm", {
        razlog: "",
      }).expect(400);
    });
    it("promote (edit) + ensure-from-bigtehn (read) route ordering", async () => {
      await send("post", "/pracenje/aktivnosti/promote", "pm", {
        akcioniPlanId: UUID,
        odeljenjeId: UUID,
        rnId: UUID,
      }).expect(201);
      await send("post", "/pracenje/rn/ensure-from-bigtehn", "viewer", {
        workOrderId: "9400",
      }).expect(201);
    });
  });

  describe("Praćenje napomene/override — pracenje.manage (admin/menadzment, NE pm)", () => {
    const ov = { bigtehnRnId: "9400" };
    it.each(PR_MANAGE)(
      "PUT /pracenje/predmeti/:id/override → 200 za %s",
      async (role) => {
        await send("put", "/pracenje/predmeti/7602/override", role, ov).expect(200);
      },
    );
    it.each(PR_NO_MANAGE)(
      "PUT /pracenje/predmeti/:id/override → 403 za %s",
      async (role) => {
        await send("put", "/pracenje/predmeti/7602/override", role, ov).expect(403);
      },
    );
    it("pm ima pracenje.edit ali NE manage → override 403, aktivnost 201", async () => {
      await send("put", "/pracenje/predmeti/7602/napomena", "pm", {
        bigtehnRnId: "9400",
        note: "x",
      }).expect(403);
      await send("post", "/pracenje/aktivnosti", "pm", {
        odeljenjeId: 1,
        nazivAktivnosti: "A",
      }).expect(201);
    });
  });

  describe("Praćenje ↑↓ prioritet — pracenje.prioritet (SAMO admin)", () => {
    it.each(PR_PRIO)(
      "PUT /pracenje/predmeti/:id/prioritet → 200 za %s",
      async (role) => {
        await send("put", "/pracenje/predmeti/7602/prioritet", role, {
          direction: "up",
        }).expect(200);
      },
    );
    it.each(PR_NO_PRIO)(
      "PUT /pracenje/predmeti/:id/prioritet → 403 za %s",
      async (role) => {
        await send("put", "/pracenje/predmeti/7602/prioritet", role, {
          direction: "up",
        }).expect(403);
      },
    );
    it("menadzment ima manage ali NE prioritet → 403; invalid direction → 400 (admin)", async () => {
      await send("put", "/pracenje/predmeti/7602/prioritet", "menadzment", {
        direction: "up",
      }).expect(403);
      await send("put", "/pracenje/predmeti/7602/prioritet", "admin", {
        direction: "sideways",
      }).expect(400);
    });
  });

  describe("Route ordering + validacija (R2 literali)", () => {
    it("GET /plan-proizvodnje/drawings/bigtehn/sign?code=X → 200 (NIJE drawings/:id/sign)", async () => {
      await get("/plan-proizvodnje/drawings/bigtehn/sign?code=1061228", "admin").expect(200);
    });
    it("GET /plan-proizvodnje/drawings/5/sign → 200 (ParseIntPipe), /abc/sign → 400", async () => {
      await get("/plan-proizvodnje/drawings/5/sign", "viewer").expect(200);
      await get("/plan-proizvodnje/drawings/abc/sign", "viewer").expect(400);
    });
    it("GET /pracenje/crtez/sign?code=X → 200 (read); export-log POST → 200 (read)", async () => {
      await get("/pracenje/crtez/sign?code=1061228", "cnc_operater").expect(200);
      await send("post", "/pracenje/export-log", "viewer", {
        tab: "operativni_plan",
      }).expect(201);
    });
    it("GET /montaza/reports/photo/:photoId/sign → 200 uuid, 400 ne-uuid (NIJE reports/:id)", async () => {
      await get(`/montaza/reports/photo/${UUID}/sign`, "monter").expect(200);
      await get("/montaza/reports/photo/nije-uuid/sign", "monter").expect(400);
    });
  });

  // ==========================================================================
  // Popravni krug F1 — DTO Int coercion (@Type(() => Number))
  // ==========================================================================
  // FE (aktivnost-modal.tsx / HTML <select>.value) šalje Int polja kao STRINGOVE ("5").
  // Globalni ValidationPipe je transform:true ali BEZ enableImplicitConversion, pa je
  // @IsInt bez @Type(() => Number) odbijao string → 400 na svakom POST-u. @Type coerce-uje
  // string→broj u transform koraku (null/undefined ostaju netaknuti). Ovaj pipe je
  // konfigurisan identično prod-u (main.ts), pa je test veran regresiji.
  describe("Popravni F1 — aktivnosti/override/export Int coercion (FE stringovi)", () => {
    it("POST /pracenje/aktivnosti sa string Int-ovima ('5') → 201 (pm)", async () => {
      await send("post", "/pracenje/aktivnosti", "pm", {
        odeljenjeId: "5",
        nazivAktivnosti: "A",
        radniNalogId: "40681",
        projekatId: "7602",
        odgovoranRadnikId: "12",
        rb: "3",
        zavisiOdAktivnostId: "9",
        izvorPozicijaId: "1",
      }).expect(201);
    });
    it("POST /pracenje/aktivnosti odeljenjeId 'abc' → 400 (NaN nije Int)", async () => {
      await send("post", "/pracenje/aktivnosti", "pm", {
        odeljenjeId: "abc",
        nazivAktivnosti: "A",
      }).expect(400);
    });
    it("POST /pracenje/aktivnosti bez odeljenjeId → 400 (obavezan)", async () => {
      await send("post", "/pracenje/aktivnosti", "pm", {
        nazivAktivnosti: "A",
      }).expect(400);
    });
    it("null/izostavljeni opcioni Int ne pucaju (ne postaju 0) → 201", async () => {
      // @IsOptional() kratko-spaja pre @IsInt; @Type(() => Number) NE pretvara null u 0.
      await send("post", "/pracenje/aktivnosti", "pm", {
        odeljenjeId: 1,
        nazivAktivnosti: "A",
        radniNalogId: null,
        odgovoranRadnikId: null,
      }).expect(201);
    });
    it("PUT override manualQty string '3' → 200 (admin); 'abc' → 400", async () => {
      await send("put", "/pracenje/predmeti/7602/override", "admin", {
        bigtehnRnId: "9400",
        manualQty: "3",
      }).expect(200);
      await send("put", "/pracenje/predmeti/7602/override", "admin", {
        bigtehnRnId: "9400",
        manualQty: "abc",
      }).expect(400);
    });
    it("POST /pracenje/export-log predmetItemId string '7' → 201 (viewer)", async () => {
      await send("post", "/pracenje/export-log", "viewer", {
        tab: "operativni_plan",
        predmetItemId: "7",
      }).expect(201);
    });
  });
});
