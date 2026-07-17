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
import { ReversiController } from "../src/modules/reversi/reversi.controller";
import { ReversiService } from "../src/modules/reversi/reversi.service";
import { PrismaService } from "../src/prisma/prisma.service";

/**
 * e2e PERMISSION MATRICA — Reversi (MODULE_SPEC_reversi.md §8), rola × endpoint × 200/403.
 * Guard sloj se testira SA AUTHZ_ENFORCE=true (realno ponašanje V2 aktivacije);
 * JwtAuthGuard je zamenjen stubom koji identitet čita iz `x-test-role` header-a.
 * ReversiService je mokovan (bez sy15 baze) — row-scope („moji"/„tim" redovi) NIJE
 * ovde: njega sprovode DB funkcije, verifikovane smoke testom na živoj sy15 10.07.
 */
describe("Reversi permission matrica (e2e, AUTHZ_ENFORCE=true)", () => {
  let app: INestApplication;
  const VALID_UUID = "3b241101-e2bb-4255-8caf-4136c566a962";

  const serviceMock: Record<string, jest.Mock> = {};
  for (const m of [
    "listDocuments",
    "recipientCardinality",
    "openHandLineByBarcode",
    "findOneDocument",
    "listTools",
    "findOneTool",
    "inventoryTree",
    "listLedger",
    "reportMyIssued",
    "reportMyConsumed",
    "reportMyMachinesCutting",
    "reportTeamIssued",
    "reportWarehouse",
    "reportConsumption",
    "reportScrapped",
    "reportMachines",
    "issue",
    "confirmReturn",
    "cuttingIssue",
    "cuttingReturn",
    "stockDelta",
    "seedStock",
    "writeOff",
    "restore",
    "uploadSignaturePdf",
    "getSignaturePdfUrl",
    "lookupEmployees",
    "lookupLocations",
    "lookupBarcode",
    "bulkImportTools",
    "listCuttingTools",
    "cuttingOpenLines",
    "getCuttingTool",
    "createCuttingTool",
    "updateCuttingTool",
    "cuttingByMachine",
    "cuttingByEmployee",
    "machineHeads",
    // R5d — bulk import reznog kataloga + reversa
    "resolveEmployees",
    "bulkImportCuttingTools",
    "analyzeReversals",
    "executeReversals",
    "rollbackReversals",
    // R1 — Alat i oprema (inventar) + Grupe
    "listInventoryUnits",
    "inventoryClassificationUsage",
    "createTool",
    "updateTool",
    "addInventorySubgroup",
    "addInventorySubsubgroup",
    "renameClassification",
    "deleteInventorySubgroup",
    "deleteInventorySubsubgroup",
    "printLabel",
  ]) {
    serviceMock[m] = jest.fn().mockResolvedValue({ data: [] });
  }

  beforeAll(async () => {
    process.env.AUTHZ_ENFORCE = "true"; // pre instanciranja PermissionsGuard-a
    const moduleRef = await Test.createTestingModule({
      controllers: [ReversiController],
      providers: [
        {
          provide: PrismaService,
          useValue: {
            userPermissionOverride: { findUnique: async () => null },
          },
        },
        { provide: ReversiService, useValue: serviceMock },
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
    // Ogledalo main.ts konfiguracije (prefiks + versioning + validacija).
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

  const get = (path: string, role: string) =>
    request(app.getHttpServer())
      .get(`/api/v1/reversi${path}`)
      .set("x-test-role", role);
  const post = (path: string, role: string, body: object) =>
    request(app.getHttpServer())
      .post(`/api/v1/reversi${path}`)
      .set("x-test-role", role)
      .send(body);
  const patch = (path: string, role: string, body: object) =>
    request(app.getHttpServer())
      .patch(`/api/v1/reversi${path}`)
      .set("x-test-role", role)
      .send(body);
  const del = (path: string, role: string) =>
    request(app.getHttpServer())
      .delete(`/api/v1/reversi${path}`)
      .set("x-test-role", role);

  // Paritet žive politike: SELECT za sve prijavljene → sve aktivne uloge.
  const ALL_READ_ROLES = [
    "admin",
    "menadzment",
    "sef",
    "tehnolog",
    "cnc_programer",
    "kontrolor",
    "magacioner",
    "proizvodni_radnik",
    "nabavka_view",
    "viewer",
    "pm",
    "leadpm",
    "tim_lider",
  ];
  const MANAGE_ROLES = ["admin", "menadzment", "pm", "leadpm", "magacioner"];
  const NOT_MANAGE = [
    "sef",
    "tehnolog",
    "cnc_programer",
    "kontrolor",
    "proizvodni_radnik",
    "nabavka_view",
    "viewer",
    "tim_lider",
  ];
  const TEAM_ROLES = ["admin", "menadzment", "sef", "tim_lider"];
  const NOT_TEAM = [
    "magacioner",
    "proizvodni_radnik",
    "viewer",
    "pm",
    "leadpm",
  ];

  describe("read endpoints — reversi.read", () => {
    it.each(ALL_READ_ROLES)("GET /documents → 200 za %s", async (role) => {
      await get("/documents", role).expect(200);
    });
    it.each(["user", "nepoznata_rola"])(
      "GET /documents → 403 za %s (default deny)",
      async (role) => {
        await get("/documents", role).expect(403);
      },
    );
    it("GET /reports/warehouse → 200 za viewer", async () => {
      await get("/reports/warehouse", "viewer").expect(200);
    });
    it("GET /lookups/barcode → 200 za magacioner (skener resolver = reversi.read)", async () => {
      await get("/lookups/barcode?code=ALAT-000057", "magacioner").expect(200);
    });
    it("GET /cutting-tools/open-lines → 200 za proizvodni_radnik (povraćaj NIJE role-gated)", async () => {
      await get(
        "/cutting-tools/open-lines?barcode=RZN-000123",
        "proizvodni_radnik",
      ).expect(200);
    });
    it("GET /cutting-tools/open-lines → 403 za user (default deny)", async () => {
      await get("/cutting-tools/open-lines", "user").expect(403);
    });
    it("GET /documents/recipient-cardinality → 200 magacioner, 403 user (RB-16 KPI)", async () => {
      await get("/documents/recipient-cardinality", "magacioner").expect(200);
      await get("/documents/recipient-cardinality", "user").expect(403);
    });
    it("GET /documents/open-hand-line → 200 proizvodni_radnik (Quick Return NIJE role-gated), 403 user", async () => {
      await get(
        "/documents/open-hand-line?barcode=ALAT-000057",
        "proizvodni_radnik",
      ).expect(200);
      await get("/documents/open-hand-line", "user").expect(403);
    });
    it("GET /lookups/locations → 200 magacioner (dropdown povraćaja RB-45), 403 user", async () => {
      await get("/lookups/locations", "magacioner").expect(200);
      await get("/lookups/locations", "user").expect(403);
    });
    it("bez identiteta → 403 (JwtAuthGuard stub)", async () => {
      await request(app.getHttpServer())
        .get("/api/v1/reversi/documents")
        .expect(403);
    });
  });

  describe("ledger — JEDINI ne-javni read (reversi.manage)", () => {
    it.each(MANAGE_ROLES)("GET /ledger → 200 za %s", async (role) => {
      await get("/ledger", role).expect(200);
    });
    it.each(NOT_MANAGE)("GET /ledger → 403 za %s", async (role) => {
      await get("/ledger", role).expect(403);
    });
  });

  // R2 — izveštaj potrošnje (RA-39/40/41): manage-gated kao /ledger.
  describe("reports/consumption — izveštaj potrošnje (reversi.manage)", () => {
    it.each(MANAGE_ROLES)(
      "GET /reports/consumption → 200 za %s",
      async (role) => {
        await get("/reports/consumption", role).expect(200);
      },
    );
    it.each(NOT_MANAGE)(
      "GET /reports/consumption → 403 za %s",
      async (role) => {
        await get("/reports/consumption", role).expect(403);
      },
    );
    it("GET /reports/warehouse ostaje reversi.read (200 za viewer) — kontrast", async () => {
      await get("/reports/warehouse", "viewer").expect(200);
    });
  });

  describe("team-issued — reversi.team_read", () => {
    it.each(TEAM_ROLES)(
      "GET /reports/team-issued → 200 za %s",
      async (role) => {
        await get("/reports/team-issued", role).expect(200);
      },
    );
    it.each(NOT_TEAM)("GET /reports/team-issued → 403 za %s", async (role) => {
      await get("/reports/team-issued", role).expect(403);
    });
  });

  describe("mutacije — reversi.manage (rev_can_manage paritet)", () => {
    const issueBody = {
      clientEventId: VALID_UUID,
      payload: { docType: "TOOL" },
    };

    it.each(MANAGE_ROLES)("POST /issue → 201 za %s", async (role) => {
      await post("/issue", role, issueBody).expect(201);
    });
    it.each(NOT_MANAGE)("POST /issue → 403 za %s", async (role) => {
      await post("/issue", role, issueBody).expect(403);
    });

    // R4-GATE-01 — Quick Return mutacije (POST /return, /cutting-return) su prvi put
    // povezane iz Quick Return UI koji NIJE manage-gated (open-line lookup je read);
    // sam povraćaj MORA ostati `reversi.manage`. Pinujemo gating testom.
    const returnBody = { clientEventId: VALID_UUID, payload: {} };
    it.each(MANAGE_ROLES)("POST /return → 201 za %s", async (role) => {
      await post("/return", role, returnBody).expect(201);
    });
    it.each(NOT_MANAGE)("POST /return → 403 za %s", async (role) => {
      await post("/return", role, returnBody).expect(403);
    });
    it.each(MANAGE_ROLES)("POST /cutting-return → 201 za %s", async (role) => {
      await post("/cutting-return", role, returnBody).expect(201);
    });
    it.each(NOT_MANAGE)("POST /cutting-return → 403 za %s", async (role) => {
      await post("/cutting-return", role, returnBody).expect(403);
    });
    it("POST /tools/:id/write-off → 403 za sef, 201 za magacioner", async () => {
      await post(`/tools/${VALID_UUID}/write-off`, "sef", {
        clientEventId: VALID_UUID,
      }).expect(403);
      await post(`/tools/${VALID_UUID}/write-off`, "magacioner", {
        clientEventId: VALID_UUID,
      }).expect(201);
    });
    it("POST /bulk-import/tools → 403 za viewer, 201 za magacioner", async () => {
      const body = { rows: [{ oznaka: "T1", naziv: "Test alat" }] };
      await post("/bulk-import/tools", "viewer", body).expect(403);
      await post("/bulk-import/tools", "magacioner", body).expect(201);
    });
    it("GET /cutting-tools → 200 za viewer (read); POST → 403 viewer, 201 magacioner", async () => {
      await get("/cutting-tools", "viewer").expect(200);
      const body = { oznaka: "RZN-1", naziv: "Glodalo" };
      await post("/cutting-tools", "viewer", body).expect(403);
      await post("/cutting-tools", "magacioner", body).expect(201);
    });
    it("POST /issue bez validnog clientEventId → 400 (ValidationPipe)", async () => {
      await post("/issue", "admin", {
        clientEventId: "nije-uuid",
        payload: {},
      }).expect(400);
    });
    it("POST /tools/:id/stock-delta sa delta=0 → 400", async () => {
      await post(`/tools/${VALID_UUID}/stock-delta`, "admin", {
        clientEventId: VALID_UUID,
        delta: 0,
        reason: "ADJUST",
      }).expect(400);
    });
  });

  // ---------- R1 — Alat i oprema (inventar) + Grupe ----------
  describe("R1 inventar + grupe", () => {
    it("GET /inventory-units → 200 read-role; 403 default-deny", async () => {
      await get("/inventory-units", "magacioner").expect(200);
      await get("/inventory-units", "viewer").expect(200);
      await get("/inventory-units", "user").expect(403);
    });
    it("GET /inventory-classification-usage → 200 read-role", async () => {
      await get("/inventory-classification-usage", "kontrolor").expect(200);
    });

    it.each(MANAGE_ROLES)("POST /tools → 201 za %s", async (role) => {
      await post("/tools", role, { oznaka: "ALAT-1", naziv: "Ključ" }).expect(
        201,
      );
    });
    it.each(NOT_MANAGE)("POST /tools → 403 za %s", async (role) => {
      await post("/tools", role, { oznaka: "ALAT-1", naziv: "Ključ" }).expect(
        403,
      );
    });

    it("PATCH /tools/:id → 403 sef, 200 magacioner", async () => {
      await patch(`/tools/${VALID_UUID}`, "sef", { naziv: "X" }).expect(403);
      await patch(`/tools/${VALID_UUID}`, "magacioner", {
        naziv: "X",
      }).expect(200);
    });

    it("POST /inventory-subgroups → 403 viewer, 201 admin", async () => {
      const body = { groupCode: "AKU", label: "Nova" };
      await post("/inventory-subgroups", "viewer", body).expect(403);
      await post("/inventory-subgroups", "admin", body).expect(201);
    });
    it("POST /inventory-subsubgroups → 201 magacioner", async () => {
      await post("/inventory-subsubgroups", "magacioner", {
        subgroupId: VALID_UUID,
        label: "Nova",
      }).expect(201);
    });

    it("PATCH /inventory-classification/:kind/:id → 403 tehnolog, 200 admin", async () => {
      await patch(
        `/inventory-classification/subgroup/${VALID_UUID}`,
        "tehnolog",
        {
          label: "X",
        },
      ).expect(403);
      await patch(`/inventory-classification/subgroup/${VALID_UUID}`, "admin", {
        label: "X",
      }).expect(200);
    });

    it("DELETE /inventory-subgroups/:id → 403 viewer, 200 magacioner", async () => {
      await del(`/inventory-subgroups/${VALID_UUID}`, "viewer").expect(403);
      await del(`/inventory-subgroups/${VALID_UUID}`, "magacioner").expect(200);
    });
    it("DELETE /inventory-subsubgroups/:id → 200 admin", async () => {
      await del(`/inventory-subsubgroups/${VALID_UUID}`, "admin").expect(200);
    });

    it("POST /labels/print → 403 viewer, 201 magacioner (RA-22/RB-47)", async () => {
      const body = { tspl2: "CLS\nPRINT 1,1\n" };
      await post("/labels/print", "viewer", body).expect(403);
      await post("/labels/print", "magacioner", body).expect(201);
    });
  });

  // ---------- R5 — rezni alat (katalog / pod-tabovi / bulk import) ----------
  describe("R5 rezni alat", () => {
    it("GET /cutting-tools/:id → 200 read-role, 403 default-deny (RC-25)", async () => {
      await get(`/cutting-tools/${VALID_UUID}`, "viewer").expect(200);
      await get(`/cutting-tools/${VALID_UUID}`, "user").expect(403);
    });
    it("GET /cutting-tools/:id sa nevalidnim UUID → 400 (ParseUUIDPipe)", async () => {
      await get("/cutting-tools/nije-uuid", "magacioner").expect(400);
    });
    it("GET /reports/cutting-by-employee → 200 read-role (RC-36/37)", async () => {
      await get("/reports/cutting-by-employee", "kontrolor").expect(200);
      await get("/reports/cutting-by-employee", "user").expect(403);
    });
    it("POST /lookups/employees/resolve → 200 read-role, 403 default-deny (RC-52)", async () => {
      const body = { names: ["Petar Petrović"] };
      await post(
        "/lookups/employees/resolve",
        "proizvodni_radnik",
        body,
      ).expect(201);
      await post("/lookups/employees/resolve", "user", body).expect(403);
    });

    it("POST /bulk-import/cutting-tools → 403 viewer, 201 magacioner (RC-50)", async () => {
      const body = { rows: [{ oznaka: "RZN-1", naziv: "Glodalo" }] };
      await post("/bulk-import/cutting-tools", "viewer", body).expect(403);
      await post("/bulk-import/cutting-tools", "magacioner", body).expect(201);
    });
    it("POST /bulk-import/reversals/analyze → 403 sef, 201 magacioner (RC-51)", async () => {
      const body = {
        rows: [
          {
            tip: "TOOL",
            primalacTip: "EMPLOYEE",
            primalac: "Petar",
            alat: "AL-1",
          },
        ],
      };
      await post("/bulk-import/reversals/analyze", "sef", body).expect(403);
      await post("/bulk-import/reversals/analyze", "magacioner", body).expect(
        201,
      );
    });
    it("POST /bulk-import/reversals → 403 viewer, 201 admin (RC-54)", async () => {
      const body = {
        rows: [
          {
            tip: "TOOL",
            primalacTip: "EMPLOYEE",
            primalac: "Petar",
            alat: "AL-1",
          },
        ],
      };
      await post("/bulk-import/reversals", "viewer", body).expect(403);
      await post("/bulk-import/reversals", "admin", body).expect(201);
    });
    it("POST /bulk-import/reversals/rollback → 403 tehnolog, 201 magacioner (RC-55)", async () => {
      const body = { documentIds: [VALID_UUID] };
      await post("/bulk-import/reversals/rollback", "tehnolog", body).expect(
        403,
      );
      await post("/bulk-import/reversals/rollback", "magacioner", body).expect(
        201,
      );
    });
    it("POST /bulk-import/reversals sa praznim rows → 201 (validacija dopušta [])", async () => {
      // Guard/DTO granica; poslovnu logiku (blokade) pokriva unit spec.
      await post("/bulk-import/reversals", "admin", { rows: [] }).expect(201);
    });
    it("POST /bulk-import/reversals/rollback sa ne-UUID id → 400 (validacija)", async () => {
      await post("/bulk-import/reversals/rollback", "admin", {
        documentIds: ["nije-uuid"],
      }).expect(400);
    });
  });
});
