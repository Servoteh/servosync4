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
    // ---- R2 mutacije (write=WRITE gate; report=REPORT gate) ----
    "createMachine",
    "importMachines",
    "updateMachine",
    "deleteMachineHard",
    "archiveMachine",
    "restoreMachine",
    "renameMachine",
    "setStatusOverride",
    "clearStatusOverride",
    "createNote",
    "updateNote",
    "uploadMachineFile",
    "updateMachineFile",
    "deleteMachineFile",
    "signMachineFile",
    "createTask",
    "updateTask",
    "deleteTask",
    "createPreventiveWorkOrder",
    "createCheck",
    "reportIncident",
    "updateIncident",
    "createIncidentEvent",
    "attachIncidentFiles",
    "createWorkOrder",
    "updateWorkOrder",
    "deleteWorkOrder",
    "createWoEvent",
    "createWoPart",
    "createWoLabor",
    "createVehicle",
    "vehicleDeadlineCheck",
    "archiveVehicle",
    "restoreVehicle",
    "upsertVehicleDetails",
    "patchVehicleTollTag",
    "patchVehicleShelf",
    "createTire",
    "updateTire",
    "deleteTire",
    "createVehicleServicePlan",
    "ensureVehicleServiceWos",
    "updateVehicleServicePlan",
    "deleteVehicleServicePlan",
    "linkPartToVehicle",
    "updatePartVehicleLink",
    "unlinkPartFromVehicle",
    "createBooking",
    "updateBooking",
    "deleteBooking",
    "createVehicleOwner",
    "createDriver",
    "updateDriver",
    "archiveDriver",
    "restoreDriver",
    "deleteDriver",
    "createItAsset",
    "upsertItDetails",
    "createFacility",
    "upsertFacilityDetails",
    "archiveAsset",
    "restoreAsset",
    "patchAssetCore",
    "createAssetServicePlan",
    "ensureAssetServiceWos",
    "updateAssetServicePlan",
    "deleteAssetServicePlan",
    "createPart",
    "updatePart",
    "createStockMovement",
    "createSupplier",
    "updateSupplier",
    "createLocation",
    "updateLocation",
    "uploadDocument",
    "updateDocument",
    "deleteDocument",
    "signDocument",
    "updateSettings",
    "createNotificationRule",
    "updateNotificationRule",
    "retryNotification",
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
  const body = (
    r: request.Test,
    role?: string,
    payload?: Record<string, unknown>,
  ) => {
    if (role) r.set("x-test-role", role);
    return payload === undefined ? r : r.send(payload);
  };
  const post = (
    path: string,
    role?: string,
    payload?: Record<string, unknown>,
  ) => body(request(app.getHttpServer()).post(`/api/v1${path}`), role, payload);
  const patch = (
    path: string,
    role?: string,
    payload?: Record<string, unknown>,
  ) =>
    body(request(app.getHttpServer()).patch(`/api/v1${path}`), role, payload);
  const put = (
    path: string,
    role?: string,
    payload?: Record<string, unknown>,
  ) => body(request(app.getHttpServer()).put(`/api/v1${path}`), role, payload);
  const del = (
    path: string,
    role?: string,
    payload?: Record<string, unknown>,
  ) =>
    body(request(app.getHttpServer()).delete(`/api/v1${path}`), role, payload);
  const incidentBody = () => ({
    clientEventId: VALID_UUID,
    machineCode: "M-01",
    title: "Kvar",
    severity: "major",
  });

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

  // ======================================================================
  // R2 — WRITE matrica (odrzavanje.write = maint chief/admin sloj coarse gate).
  // Row-nivo (maint profil operator/technician machine-scope, chief-bez-role,
  // magacioner, 24h, close-gate) presuđuje sy15 RLS/RPC kroz GUC — to je živi
  // smoke (R4). Sintetički operator/technician /me-gate derivacija (F7) je u
  // `odrzavanje.service.spec` (RLS ne može ERP-rola sloj izraziti).
  // POST → 201, PATCH/PUT/DELETE → 200; guard (403) prethodi ValidationPipe (400).
  // ======================================================================
  const WRITE_ROLES = rolesWith(PERMISSIONS.ODRZAVANJE_WRITE);
  const NO_WRITE = rolesWithout(PERMISSIONS.ODRZAVANJE_WRITE);
  const REPORT_ROLES = rolesWith(PERMISSIONS.ODRZAVANJE_REPORT);
  const NO_REPORT = rolesWithout(PERMISSIONS.ODRZAVANJE_REPORT);

  describe("Write guard — POST (201 za write-role, 403 za bez-write)", () => {
    it.each(WRITE_ROLES)(
      "POST /machines/:code/archive → 201 za %s",
      async (role) => {
        await post("/maintenance/machines/M-01/archive", role).expect(201);
      },
    );
    it.each(NO_WRITE)(
      "POST /machines/:code/archive → 403 za %s (nema write)",
      async (role) => {
        await post("/maintenance/machines/M-01/archive", role).expect(403);
      },
    );
    it.each(WRITE_ROLES)(
      "POST /notifications/:id/retry → 201 za %s (dispatch mrtav; retry=paritet)",
      async (role) => {
        await post(
          `/maintenance/notifications/${VALID_UUID}/retry`,
          role,
        ).expect(201);
      },
    );
  });

  describe("Write guard — PATCH/PUT/DELETE (200 za write-role, 403 za bez-write)", () => {
    it.each(WRITE_ROLES)("PATCH /settings → 200 za %s", async (role) => {
      await patch("/maintenance/settings", role, {}).expect(200);
    });
    it.each(NO_WRITE)("PATCH /settings → 403 za %s", async (role) => {
      await patch("/maintenance/settings", role, {}).expect(403);
    });
    it.each(WRITE_ROLES)(
      "PUT /vehicles/:id/details → 200 za %s",
      async (role) => {
        await put(`/maintenance/vehicles/${VALID_UUID}/details`, role, {
          details: {},
        }).expect(200);
      },
    );
    it.each(WRITE_ROLES)(
      "DELETE /work-orders/:id → 200 za %s",
      async (role) => {
        await del(`/maintenance/work-orders/${VALID_UUID}`, role).expect(200);
      },
    );
    it.each(NO_WRITE)("DELETE /work-orders/:id → 403 za %s", async (role) => {
      await del(`/maintenance/work-orders/${VALID_UUID}`, role).expect(403);
    });
  });

  describe("REPORT — prijava kvara = opšte pravo (F6); guard coarse, RLS presuđuje", () => {
    it.each(REPORT_ROLES)(
      "POST /incidents → 201 za %s (report; INSERT-bez-SELECT paritet)",
      async (role) => {
        await post("/maintenance/incidents", role, incidentBody()).expect(201);
      },
    );
    it.each(NO_REPORT)(
      "POST /incidents → 403 za %s (nema report)",
      async (role) => {
        await post("/maintenance/incidents", role, incidentBody()).expect(403);
      },
    );
    it.each(REPORT_ROLES)(
      "POST /incidents/:id/files → foto = report za %s (F3 RPC)",
      async (role) => {
        // FilesInterceptor prihvata prazan set; servis je mokovan → 201.
        await post(`/maintenance/incidents/${VALID_UUID}/files`, role).expect(
          201,
        );
      },
    );
    it("HIGH#1: read-only ERP rola (monter) prolazi guard za prijavu (report) I izmenu (write) — chief-profil kroz nju NE sme 403; RLS presuđuje red", async () => {
      // monter može nositi maint chief profil (auth.uid()) → guard NE sme 403.
      await post("/maintenance/incidents", "monter", incidentBody()).expect(
        201,
      );
      await patch(`/maintenance/incidents/${VALID_UUID}`, "monter", {
        status: "acknowledged",
      }).expect(200);
    });
  });

  describe("Write route ordering (novi literali pre :code/:id)", () => {
    it("POST /machines/import → 201 (literal, ne :code)", async () => {
      await post("/maintenance/machines/import", "admin", {
        codes: ["M-01"],
      }).expect(201);
      expect(svcMock.importMachines).toHaveBeenCalled();
    });
    it("POST /vehicles/deadline-check → 201 (literal, ne :id → ParseUUID 400)", async () => {
      await post("/maintenance/vehicles/deadline-check", "admin", {}).expect(
        201,
      );
      expect(svcMock.vehicleDeadlineCheck).toHaveBeenCalled();
    });
    it("POST /vehicles/:id/service-plan/generate-wos → 201 (literal end, ne :planId)", async () => {
      await post(
        `/maintenance/vehicles/${VALID_UUID}/service-plan/generate-wos`,
        "sef",
      ).expect(201);
      expect(svcMock.ensureVehicleServiceWos).toHaveBeenCalled();
    });
    it("POST /assets/:id/service-plan/generate-wos → 201 (literal end)", async () => {
      await post(
        `/maintenance/assets/${VALID_UUID}/service-plan/generate-wos`,
        "sef",
      ).expect(201);
      expect(svcMock.ensureAssetServiceWos).toHaveBeenCalled();
    });
  });

  describe("Mutacije: DTO/param 400 (guard prošao, telo/param nevalidno)", () => {
    it("PATCH /work-orders/:id → 400 ne-uuid param (admin)", async () => {
      await patch("/maintenance/work-orders/nije-uuid", "admin", {}).expect(
        400,
      );
    });
    it("POST /incidents → 400 kad fali clientEventId/severity (admin, DTO)", async () => {
      await post("/maintenance/incidents", "admin", {
        machineCode: "M-01",
        title: "x",
      }).expect(400);
    });
    it("POST /machines → 400 kad fali clientEventId/name (admin, DTO idempotency)", async () => {
      await post("/maintenance/machines", "admin", {
        machineCode: "M-99",
      }).expect(400);
    });
  });

  // ======================================================================
  // HIGH#1 — write guard je COARSE-SUPERSET: SVE aktivne role prolaze guard za
  // mutaciju (chief-profil kroz bilo koju ERP rolu ne sme 403 pre RLS). Row-odluka
  // (42501→403) = živi smoke (R4). Deferred/inactive role i dalje 403 (deny).
  // ======================================================================
  describe("HIGH#1 — write guard permisivan za sve aktivne role (RLS presuđuje red)", () => {
    it.each(READ_ROLES)(
      "PATCH /settings → prolazi guard (≠403) za %s (aktivna rola)",
      async (role) => {
        const res = await patch("/maintenance/settings", role, {});
        expect(res.status).not.toBe(403);
        expect(res.status).toBe(200);
      },
    );
    it("READ_ROLES i WRITE_ROLES su isti skup (coarse-superset)", () => {
      expect([...WRITE_ROLES].sort()).toEqual([...READ_ROLES].sort());
    });
    it.each(NO_WRITE)(
      "PATCH /settings → 403 za %s (deferred/inactive; deny ostaje)",
      async (role) => {
        await patch("/maintenance/settings", role, {}).expect(403);
      },
    );
  });

  // ======================================================================
  // HIGH#2 — PATCH core maint_assets (vozilo/IT/objekat): name/status/…/location_id/
  // responsible_user_id (create RPC ih NE prima → jedini put upisa). Guard=write,
  // RLS=asset_visible ∧ erp/chief/admin.
  // ======================================================================
  describe("HIGH#2 — PATCH core maint_assets (vozilo/IT/objekat)", () => {
    it.each(["vehicles", "it-assets", "facilities"])(
      "PATCH /%s/:id → 200 (write; core + responsibleUserId patch)",
      async (seg) => {
        svcMock.patchAssetCore.mockClear();
        await patch(`/maintenance/${seg}/${VALID_UUID}`, "sef", {
          name: "X",
          status: "degraded",
          responsibleUserId: VALID_UUID,
        }).expect(200);
        expect(svcMock.patchAssetCore).toHaveBeenCalled();
      },
    );
    it("PATCH /vehicles/:id → 200 uz null-clear location/responsible (unassign)", async () => {
      await patch(`/maintenance/vehicles/${VALID_UUID}`, "sef", {
        locationId: null,
        responsibleUserId: null,
      }).expect(200);
    });
    it("PATCH /vehicles/:id → 400 status van skupa (DTO)", async () => {
      await patch(`/maintenance/vehicles/${VALID_UUID}`, "sef", {
        status: "xxx",
      }).expect(400);
    });
    it("PATCH /vehicles/:id → 400 ne-uuid param", async () => {
      await patch("/maintenance/vehicles/nije-uuid", "sef", {}).expect(400);
    });
    it("PATCH /vehicles/:id → 403 za deferred rolu (nabavka)", async () => {
      await patch(`/maintenance/vehicles/${VALID_UUID}`, "nabavka", {}).expect(
        403,
      );
    });
    it("bare :id NE senči pod-rute: PATCH /vehicles/:id/toll-tag i /shelf i dalje rade", async () => {
      svcMock.patchVehicleTollTag.mockClear();
      svcMock.patchVehicleShelf.mockClear();
      svcMock.patchAssetCore.mockClear();
      await patch(
        `/maintenance/vehicles/${VALID_UUID}/toll-tag`,
        "sef",
        {},
      ).expect(200);
      await patch(
        `/maintenance/vehicles/${VALID_UUID}/shelf`,
        "sef",
        {},
      ).expect(200);
      expect(svcMock.patchVehicleTollTag).toHaveBeenCalled();
      expect(svcMock.patchVehicleShelf).toHaveBeenCalled();
      expect(svcMock.patchAssetCore).not.toHaveBeenCalled();
    });
  });
});
