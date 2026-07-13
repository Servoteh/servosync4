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
import { ALL_ROLE_KEYS } from "../src/common/authz/roles";
import { roleHasPermission } from "../src/common/authz/role-permissions";
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
  ]);
  const pracenjeMock = mk([
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
    "akcioneTacke",
    "searchDelovi",
    "planPrioritet",
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
        { provide: PlanMontazeService, useValue: montazaMock },
        { provide: PlanProizvodnjeService, useValue: ppMock },
        { provide: PracenjeService, useValue: pracenjeMock },
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
    it("route ordering: /pracenje/rn/resolve literal (200) NIJE rn/:rnId uuid-pipe", async () => {
      await get("/pracenje/rn/resolve?ref=RN-1", "admin").expect(200);
      await get(`/pracenje/rn/${UUID}`, "admin").expect(200);
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
});
