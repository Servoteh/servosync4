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
import { OdrzavanjeController } from "../src/modules/odrzavanje/odrzavanje.controller";
import { OdrzavanjeService } from "../src/modules/odrzavanje/odrzavanje.service";
import { ALL_ROLE_KEYS } from "../src/common/authz/roles";
import { roleHasPermission } from "../src/common/authz/role-permissions";
import {
  PERMISSIONS,
  type PermissionKey,
} from "../src/common/authz/permissions";

/**
 * e2e PERMISSION MATRICA — Održavanje (MODULE_SPEC_odrzavanje_30.md §5 t.46),
 * rola × endpoint × 200/403 sa AUTHZ_ENFORCE=true (realno V2 ponašanje).
 * JwtAuthGuard je stub (identitet iz `x-test-role`); servis je mokovan (bez sy15 baze).
 * R1 = SAMO read sloj → sve rute su `odrzavanje.read` (F8: read+report = opšte pravo).
 * Row-scope (operator machine-scope, chief-bez-role, magacioner krug, WO dodeljeni…)
 * sprovodi DB RLS kroz GUC — to je R2 živi smoke, ne ovaj rola-sloj test.
 */
describe("Održavanje permission matrica (e2e, AUTHZ_ENFORCE=true)", () => {
  let app: INestApplication;
  const VALID_UUID = "3b241101-e2bb-4255-8caf-4136c566a962";

  const svcMock: Record<string, jest.Mock> = {};
  for (const m of [
    "me",
    "dashboard",
    "facilityTypes",
    "listMachines",
    "importableMachines",
    "deletionLog",
    "findMachine",
    "machineStatusOverride",
    "machineNotes",
    "machineFiles",
    "listTasks",
    "findTask",
    "tasksDue",
    "listChecks",
    "listIncidents",
    "findIncident",
    "incidentEvents",
    "listWorkOrders",
    "assignableUsers",
    "findWorkOrder",
    "woEvents",
    "woParts",
    "woLabor",
    "listVehicles",
    "vehicleServicePlanDue",
    "findVehicle",
    "vehicleTires",
    "vehicleServicePlan",
    "vehicleParts",
    "vehicleBookings",
    "vehicleOwners",
    "listDrivers",
    "findDriver",
    "listItAssets",
    "findItAsset",
    "listFacilities",
    "findFacility",
    "listAssets",
    "assetServicePlanDue",
    "assetServicePlan",
    "calendarDeadlines",
    "listParts",
    "findPart",
    "partStockMovements",
    "listSuppliers",
    "listLocations",
    "listDocuments",
    "findDocument",
    "settings",
    "notificationRules",
    "notifications",
    "reportIncidents",
    "reportWorkOrderCosts",
    "reportAttention",
  ]) {
    svcMock[m] = jest.fn().mockResolvedValue({ data: { ok: true } });
  }
  svcMock.facilityTypes.mockReturnValue({ data: [] });

  beforeAll(async () => {
    process.env.AUTHZ_ENFORCE = "true"; // pre instanciranja PermissionsGuard-a
    const moduleRef = await Test.createTestingModule({
      controllers: [OdrzavanjeController],
      providers: [{ provide: OdrzavanjeService, useValue: svcMock }],
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

  // Test-hardening: liste se IZVODE iz ALL_ROLE_KEYS umesto ručno → svaka uloga dobija
  // 200/403 assertion; nova/pogrešno-grantovana uloga se NE može provući. Tačnost skupova
  // pinuje unit `role-permissions.odrzavanje.spec`.
  const rolesWith = (perm: PermissionKey) =>
    ALL_ROLE_KEYS.filter((r) => roleHasPermission(r, perm));
  const rolesWithout = (perm: PermissionKey) =>
    ALL_ROLE_KEYS.filter((r) => !roleHasPermission(r, perm));

  const READ_ROLES = rolesWith(PERMISSIONS.ODRZAVANJE_READ);
  const NO_READ = rolesWithout(PERMISSIONS.ODRZAVANJE_READ);

  describe("Read guard (odrzavanje.read — F8 opšte pravo)", () => {
    it.each(READ_ROLES)(
      "GET /maintenance/machines → 200 za %s",
      async (role) => {
        await get("/maintenance/machines", role).expect(200);
      },
    );
    it.each(NO_READ)(
      "GET /maintenance/machines → 403 za %s (neaktivna/deferred)",
      async (role) => {
        await get("/maintenance/machines", role).expect(403);
      },
    );
    it.each(["user", "nepoznata_rola"])(
      "GET /maintenance/dashboard → 403 za %s (default deny)",
      async (role) => {
        await get("/maintenance/dashboard", role).expect(403);
      },
    );
    it("bez identiteta → 403 (JwtAuthGuard stub)", async () => {
      await get("/maintenance/machines").expect(403);
    });
  });

  describe("Read širina (reprezentativni endpointi) — 200 za read-role, 403 za neaktivnu", () => {
    const paths = [
      "/maintenance/me",
      "/maintenance/dashboard",
      "/maintenance/work-orders",
      "/maintenance/incidents",
      "/maintenance/vehicles",
      "/maintenance/drivers",
      "/maintenance/it-assets",
      "/maintenance/facilities",
      "/maintenance/parts",
      "/maintenance/documents",
      "/maintenance/settings",
      "/maintenance/notifications",
      "/maintenance/calendar/deadlines",
      "/maintenance/reports/incidents",
    ];
    it.each(paths)(
      "GET %s → 200 za tehnicar_odrzavanja i viewer, 403 za nabavka",
      async (path) => {
        await get(path, "tehnicar_odrzavanja").expect(200);
        await get(path, "viewer").expect(200);
        await get(path, "nabavka").expect(403);
      },
    );
  });

  describe("Route ordering (literali pre :code/:id)", () => {
    it("GET /maintenance/machines/importable → 200 (ne uhvaćeno kao :code)", async () => {
      await get("/maintenance/machines/importable", "admin").expect(200);
      expect(svcMock.importableMachines).toHaveBeenCalled();
    });
    it("GET /maintenance/machines/deletion-log → 200 (ne :code)", async () => {
      await get("/maintenance/machines/deletion-log", "admin").expect(200);
      expect(svcMock.deletionLog).toHaveBeenCalled();
    });
    it("GET /maintenance/work-orders/assignable → 200 (ne :id)", async () => {
      await get("/maintenance/work-orders/assignable", "menadzment").expect(
        200,
      );
      expect(svcMock.assignableUsers).toHaveBeenCalled();
    });
    it("GET /maintenance/tasks/due → 200 (ne :id)", async () => {
      await get("/maintenance/tasks/due", "sef").expect(200);
      expect(svcMock.tasksDue).toHaveBeenCalled();
    });
    it("GET /maintenance/vehicles/service-plan-due → 200 (ne :id)", async () => {
      await get("/maintenance/vehicles/service-plan-due", "magacioner").expect(
        200,
      );
      expect(svcMock.vehicleServicePlanDue).toHaveBeenCalled();
    });
    it("GET /maintenance/assets/service-plan-due → 200 (ne :id/service-plan)", async () => {
      await get("/maintenance/assets/service-plan-due", "hr").expect(200);
      expect(svcMock.assetServicePlanDue).toHaveBeenCalled();
    });
  });

  describe("Param validacija (:id uuid vs :code text)", () => {
    it("GET /maintenance/work-orders/:id → 200 uuid, 400 ne-uuid (pm)", async () => {
      await get(`/maintenance/work-orders/${VALID_UUID}`, "pm").expect(200);
      await get("/maintenance/work-orders/nije-uuid", "pm").expect(400);
    });
    it("GET /maintenance/incidents/:id/events → 200 uuid, 400 ne-uuid", async () => {
      await get(`/maintenance/incidents/${VALID_UUID}/events`, "monter").expect(
        200,
      );
      await get("/maintenance/incidents/xxx/events", "monter").expect(400);
    });
    it("GET /maintenance/machines/:code (TEXT PK) → 200 za bilo koji string", async () => {
      await get("/maintenance/machines/M-01", "proizvodni_radnik").expect(200);
      await get("/maintenance/machines/BIGTEHN%2F9400", "viewer").expect(200);
    });
    it("GET /maintenance/drivers/:id (PII) → 200 uuid, 400 ne-uuid; 403 nabavka", async () => {
      await get(`/maintenance/drivers/${VALID_UUID}`, "magacioner").expect(200);
      await get("/maintenance/drivers/nije-uuid", "magacioner").expect(400);
      await get(`/maintenance/drivers/${VALID_UUID}`, "nabavka").expect(403);
    });
  });

  describe("F5 — facility-types fallback ([])", () => {
    it("GET /maintenance/facility-types → 200 (paritet FE fallback)", async () => {
      await get("/maintenance/facility-types", "viewer").expect(200);
    });
  });
});
