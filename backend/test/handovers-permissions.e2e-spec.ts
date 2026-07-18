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
import { HandoversController } from "../src/modules/handovers/handovers.controller";
import { HandoversService } from "../src/modules/handovers/handovers.service";
import { HandoverDraftsController } from "../src/modules/handovers/handover-drafts.controller";
import { HandoverDraftsService } from "../src/modules/handovers/handover-drafts.service";
import { PrintBundleService } from "../src/modules/handovers/print-bundle.service";
import { PrismaService } from "../src/prisma/prisma.service";

/**
 * e2e PERMISSION MATRICA — Primopredaje + Nacrti primopredaje
 * (MODULE_SPEC_nacrti_primopredaje §6), rola × endpoint × 2xx/403.
 *
 * Guard sloj se testira SA AUTHZ_ENFORCE=true (realno ponašanje V2 aktivacije na
 * prod-u); JwtAuthGuard je zamenjen stubom koji identitet čita iz `x-test-role`
 * header-a. Servisi (HandoversService/HandoverDraftsService/PrintBundleService)
 * su mokovani — poslovna logika (status-mašina, worker-type gate, 409/422) NIJE
 * ovde; ovaj spec dokazuje ISKLJUČIVO RBAC kapiju (ROLE_PERMISSIONS izvor istine).
 *
 * Izvor intent-a (route-permission-coverage.txt + role-permissions.ts):
 *   read    = PRIMOPREDAJE_READ  → SVE role u mapi (Talas D loop dodaje svima)
 *   write   = PRIMOPREDAJE_WRITE → admin/sef/tehnolog/kontrolor/menadzment/projektant_vodja/inzenjer
 *   approve = PRIMOPREDAJE_APPROVE → admin/sef/tehnolog/menadzment
 *   rn.write (prepare-work-order) = RN_WRITE → admin/sef/tehnolog/menadzment
 *
 * KLJUČNA modul-specifična razlika (namerna, §6.4/§6.5 + controller komentari):
 *   KONTROLOR ima primopredaje.write ALI NE approve i NE rn.write → sme take-over,
 *   ne sme approve/reject/launch/return-to-pending ni prepare-work-order.
 */
describe("Primopredaje permission matrica (e2e, AUTHZ_ENFORCE=true)", () => {
  let app: INestApplication;

  // ---- servis mokovi (sve metode koje kontroleri zovu) ----
  const handoversServiceMock: Record<string, jest.Mock> = {};
  for (const m of [
    "lookups",
    "technologists",
    "engineers",
    "approvers",
    "pendingApproval",
    "writingStats",
    "list",
    "findOne",
    "approve",
    "reject",
    "approveBatch",
    "rejectBatch",
    "returnToPending",
    "takeOver",
    "prepareWorkOrder",
    "launch",
  ]) {
    handoversServiceMock[m] = jest.fn().mockResolvedValue({ data: [] });
  }

  const draftsServiceMock: Record<string, jest.Mock> = {};
  for (const m of [
    "list",
    "findOne",
    "listItems",
    "create",
    "appendItems",
    "update",
    "remove",
    "submit",
    "decideItem",
  ]) {
    draftsServiceMock[m] = jest.fn().mockResolvedValue({ data: [] });
  }

  // PDF handleri čitaju { buffer, fileName } → StreamableFile; ostali vraćaju objekat.
  const printBundleServiceMock: Record<string, jest.Mock> = {
    handoverBundle: jest.fn().mockResolvedValue({ data: [] }),
    draftBundle: jest.fn().mockResolvedValue({ data: [] }),
    handoverBundlePdf: jest
      .fn()
      .mockResolvedValue({ buffer: Buffer.from("%PDF-1.4"), fileName: "hp.pdf" }),
    draftBundlePdf: jest
      .fn()
      .mockResolvedValue({ buffer: Buffer.from("%PDF-1.4"), fileName: "dp.pdf" }),
  };

  beforeAll(async () => {
    process.env.JWT_SECRET = "test-not-real-secret"; // SEC-01 guard pri importu
    process.env.AUTHZ_ENFORCE = "true"; // pre instanciranja PermissionsGuard-a

    const moduleRef = await Test.createTestingModule({
      controllers: [HandoversController, HandoverDraftsController],
      providers: [
        {
          provide: PrismaService,
          useValue: {
            userPermissionOverride: { findUnique: async () => null },
          },
        },
        { provide: HandoversService, useValue: handoversServiceMock },
        { provide: HandoverDraftsService, useValue: draftsServiceMock },
        { provide: PrintBundleService, useValue: printBundleServiceMock },
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
    // Ogledalo main.ts (prefiks + versioning + validacija).
    app.setGlobalPrefix("api");
    app.enableVersioning({
      type: VersioningType.URI,
      defaultVersion: VERSION_NEUTRAL,
    });
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.AUTHZ_ENFORCE;
  });

  // ---- request helperi ----
  const get = (base: string, path: string, role: string) =>
    request(app.getHttpServer())
      .get(`/api/v1/${base}${path}`)
      .set("x-test-role", role);
  const post = (base: string, path: string, role: string, body: object) =>
    request(app.getHttpServer())
      .post(`/api/v1/${base}${path}`)
      .set("x-test-role", role)
      .send(body);
  const patch = (base: string, path: string, role: string, body: object) =>
    request(app.getHttpServer())
      .patch(`/api/v1/${base}${path}`)
      .set("x-test-role", role)
      .send(body);
  const del = (base: string, path: string, role: string) =>
    request(app.getHttpServer())
      .delete(`/api/v1/${base}${path}`)
      .set("x-test-role", role);

  // ---- role grupe (izvor: role-permissions.ts) ----
  // primopredaje.read = svi u mapi → uzorak holder-a (svi drže read):
  const READ_HOLDERS = [
    "admin",
    "sef",
    "tehnolog",
    "kontrolor",
    "magacioner",
    "proizvodni_radnik",
    "cnc_programer",
    "viewer",
  ];
  // Default-deny: NE-mapirane / prelazne role.
  const DEFAULT_DENY = ["user", "nepoznata_rola"];

  // primopredaje.write
  const WRITE_HOLDERS = [
    "admin",
    "sef",
    "tehnolog",
    "kontrolor",
    "menadzment",
    "projektant_vodja",
    "inzenjer",
  ];
  // Drže read (modul-vidljivost) ALI ne write → dokaz da je gate baš `write`.
  const WRITE_NON_HOLDERS = [
    "magacioner",
    "proizvodni_radnik",
    "viewer",
    "pm",
    "cnc_programer",
  ];

  // primopredaje.approve
  const APPROVE_HOLDERS = ["admin", "sef", "tehnolog", "menadzment"];
  // kontrolor/projektant_vodja/inzenjer imaju WRITE ali NE approve (namerno, §6.4/§6.5).
  const APPROVE_NON_HOLDERS = [
    "kontrolor",
    "projektant_vodja",
    "inzenjer",
    "magacioner",
    "viewer",
    "pm",
  ];

  // rn.write (prepare-work-order kreira work_orders red)
  const RN_WRITE_HOLDERS = ["admin", "sef", "tehnolog", "menadzment"];
  // kontrolor ima primopredaje.write ali NE rn.write → ne sme ovuda kreirati RN.
  const RN_WRITE_NON_HOLDERS = [
    "kontrolor",
    "magacioner",
    "viewer",
    "pm",
    "cnc_programer",
  ];

  // Validna minimalna tela (DTO su plain interface + servis-side validacija; servis
  // je mokovan pa telo ne mora proći class-validator — ali šaljemo smislena tela).
  const approveBody = { technologistId: 1 };
  const rejectBody = { reason: "duplikat" };
  const returnBody = { reason: "vrati" };
  const launchBody = { comment: "kreni" };
  const approveBatchBody = { handoverIds: [1], technologistId: 1 };
  const rejectBatchBody = { handoverIds: [1], reason: "grupno" };
  const createDraftBody = { projectId: 1, pieceCount: 1 };
  const updateDraftBody = { note: "izmena" };
  const appendItemsBody = { items: [{ drawingId: 1 }] };
  const decideBody = { action: 1 };

  // =====================================================================
  //  HANDOVERS controller  (/api/v1/handovers)
  // =====================================================================
  describe("handovers — READ (primopredaje.read)", () => {
    const READ_PATHS = [
      "/lookups",
      "/technologists",
      "/engineers",
      "/approvers",
      "/pending-approval",
      "/writing-stats",
      "", // GET /handovers (lista)
      "/1", // detalj
      "/1/print-bundle",
      "/1/print-bundle/pdf",
    ];

    it.each(READ_PATHS)("GET %s → 200 za read-holder (viewer)", async (p) => {
      await get("handovers", p, "viewer").expect(200);
    });

    it.each(READ_HOLDERS)("GET /pending-approval → 200 za %s", async (role) => {
      await get("handovers", "/pending-approval", role).expect(200);
    });

    it.each(DEFAULT_DENY)(
      "GET /handovers → 403 za %s (default deny)",
      async (role) => {
        await get("handovers", "", role).expect(403);
      },
    );
    it.each(DEFAULT_DENY)(
      "GET /handovers/1 → 403 za %s (default deny)",
      async (role) => {
        await get("handovers", "/1", role).expect(403);
      },
    );

    it("bez identiteta → 403 (JwtAuthGuard stub)", async () => {
      await request(app.getHttpServer())
        .get("/api/v1/handovers")
        .expect(403);
    });
    it("GET /handovers/abc → 400 za read-holder (ParseIntPipe)", async () => {
      await get("handovers", "/abc", "viewer").expect(400);
    });
  });

  describe("handovers — APPROVE (primopredaje.approve)", () => {
    it.each(APPROVE_HOLDERS)("POST /1/approve → 201 za %s", async (role) => {
      await post("handovers", "/1/approve", role, approveBody).expect(201);
    });
    it.each(APPROVE_NON_HOLDERS)(
      "POST /1/approve → 403 za %s (write/read nije dovoljno)",
      async (role) => {
        await post("handovers", "/1/approve", role, approveBody).expect(403);
      },
    );
    it.each(DEFAULT_DENY)("POST /1/approve → 403 za %s", async (role) => {
      await post("handovers", "/1/approve", role, approveBody).expect(403);
    });

    it.each(APPROVE_HOLDERS)("POST /1/reject → 201 za %s", async (role) => {
      await post("handovers", "/1/reject", role, rejectBody).expect(201);
    });
    it.each(APPROVE_NON_HOLDERS)(
      "POST /1/reject → 403 za %s",
      async (role) => {
        await post("handovers", "/1/reject", role, rejectBody).expect(403);
      },
    );

    it.each(APPROVE_HOLDERS)("POST /1/launch → 201 za %s", async (role) => {
      await post("handovers", "/1/launch", role, launchBody).expect(201);
    });
    it.each(APPROVE_NON_HOLDERS)(
      "POST /1/launch → 403 za %s",
      async (role) => {
        await post("handovers", "/1/launch", role, launchBody).expect(403);
      },
    );

    it.each(APPROVE_HOLDERS)(
      "POST /1/return-to-pending → 201 za %s",
      async (role) => {
        await post(
          "handovers",
          "/1/return-to-pending",
          role,
          returnBody,
        ).expect(201);
      },
    );
    it.each(APPROVE_NON_HOLDERS)(
      "POST /1/return-to-pending → 403 za %s (undo = ista težina kao approve)",
      async (role) => {
        await post(
          "handovers",
          "/1/return-to-pending",
          role,
          returnBody,
        ).expect(403);
      },
    );

    it.each(APPROVE_HOLDERS)(
      "POST /approve-batch → 201 za %s",
      async (role) => {
        await post("handovers", "/approve-batch", role, approveBatchBody).expect(
          201,
        );
      },
    );
    it.each(APPROVE_NON_HOLDERS)(
      "POST /approve-batch → 403 za %s",
      async (role) => {
        await post("handovers", "/approve-batch", role, approveBatchBody).expect(
          403,
        );
      },
    );
    it.each(APPROVE_HOLDERS)(
      "POST /reject-batch → 201 za %s",
      async (role) => {
        await post("handovers", "/reject-batch", role, rejectBatchBody).expect(
          201,
        );
      },
    );
    it.each(APPROVE_NON_HOLDERS)(
      "POST /reject-batch → 403 za %s",
      async (role) => {
        await post("handovers", "/reject-batch", role, rejectBatchBody).expect(
          403,
        );
      },
    );
  });

  describe("handovers — TAKE-OVER (primopredaje.write)", () => {
    it.each(WRITE_HOLDERS)("POST /1/take-over → 201 za %s", async (role) => {
      await post("handovers", "/1/take-over", role, {}).expect(201);
    });
    it.each(WRITE_NON_HOLDERS)(
      "POST /1/take-over → 403 za %s",
      async (role) => {
        await post("handovers", "/1/take-over", role, {}).expect(403);
      },
    );
    it("POST /1/take-over → 201 za kontrolor (write DA — kontrast sa approve)", async () => {
      await post("handovers", "/1/take-over", "kontrolor", {}).expect(201);
    });
  });

  describe("handovers — PREPARE-WORK-ORDER (rn.write)", () => {
    it.each(RN_WRITE_HOLDERS)(
      "POST /1/prepare-work-order → 201 za %s",
      async (role) => {
        await post("handovers", "/1/prepare-work-order", role, {}).expect(201);
      },
    );
    it.each(RN_WRITE_NON_HOLDERS)(
      "POST /1/prepare-work-order → 403 za %s",
      async (role) => {
        await post("handovers", "/1/prepare-work-order", role, {}).expect(403);
      },
    );
    it("POST /1/prepare-work-order → 403 za kontrolor (ima primopredaje.write ali NE rn.write)", async () => {
      await post("handovers", "/1/prepare-work-order", "kontrolor", {}).expect(
        403,
      );
    });
  });

  // =====================================================================
  //  HANDOVER-DRAFTS controller  (/api/v1/handover-drafts)
  // =====================================================================
  describe("handover-drafts — READ (primopredaje.read)", () => {
    const READ_PATHS = [
      "", // lista
      "/1", // detalj
      "/1/items",
      "/1/print-bundle",
      "/1/print-bundle/pdf",
    ];
    it.each(READ_PATHS)("GET %s → 200 za read-holder (viewer)", async (p) => {
      await get("handover-drafts", p, "viewer").expect(200);
    });
    it.each(READ_HOLDERS)("GET /handover-drafts → 200 za %s", async (role) => {
      await get("handover-drafts", "", role).expect(200);
    });
    it.each(DEFAULT_DENY)(
      "GET /handover-drafts → 403 za %s (default deny)",
      async (role) => {
        await get("handover-drafts", "", role).expect(403);
      },
    );
    it("GET /handover-drafts/abc → 400 (ParseIntPipe)", async () => {
      await get("handover-drafts", "/abc", "viewer").expect(400);
    });
  });

  describe("handover-drafts — WRITE (primopredaje.write)", () => {
    it.each(WRITE_HOLDERS)("POST /handover-drafts → 201 za %s", async (role) => {
      await post("handover-drafts", "", role, createDraftBody).expect(201);
    });
    it.each(WRITE_NON_HOLDERS)(
      "POST /handover-drafts → 403 za %s",
      async (role) => {
        await post("handover-drafts", "", role, createDraftBody).expect(403);
      },
    );
    it.each(DEFAULT_DENY)(
      "POST /handover-drafts → 403 za %s (default deny)",
      async (role) => {
        await post("handover-drafts", "", role, createDraftBody).expect(403);
      },
    );

    it.each(WRITE_HOLDERS)(
      "POST /1/items (append) → 201 za %s",
      async (role) => {
        await post("handover-drafts", "/1/items", role, appendItemsBody).expect(
          201,
        );
      },
    );
    it.each(WRITE_NON_HOLDERS)(
      "POST /1/items (append) → 403 za %s",
      async (role) => {
        await post("handover-drafts", "/1/items", role, appendItemsBody).expect(
          403,
        );
      },
    );

    it.each(WRITE_HOLDERS)("PATCH /1 → 200 za %s", async (role) => {
      await patch("handover-drafts", "/1", role, updateDraftBody).expect(200);
    });
    it.each(WRITE_NON_HOLDERS)("PATCH /1 → 403 za %s", async (role) => {
      await patch("handover-drafts", "/1", role, updateDraftBody).expect(403);
    });

    it.each(WRITE_HOLDERS)("DELETE /1 → 200 za %s", async (role) => {
      await del("handover-drafts", "/1", role).expect(200);
    });
    it.each(WRITE_NON_HOLDERS)("DELETE /1 → 403 za %s", async (role) => {
      await del("handover-drafts", "/1", role).expect(403);
    });

    it.each(WRITE_HOLDERS)("POST /1/submit → 201 za %s", async (role) => {
      await post("handover-drafts", "/1/submit", role, {}).expect(201);
    });
    it.each(WRITE_NON_HOLDERS)("POST /1/submit → 403 za %s", async (role) => {
      await post("handover-drafts", "/1/submit", role, {}).expect(403);
    });

    it.each(WRITE_HOLDERS)(
      "POST /1/items/1/decision → 201 za %s",
      async (role) => {
        await post(
          "handover-drafts",
          "/1/items/1/decision",
          role,
          decideBody,
        ).expect(201);
      },
    );
    it.each(WRITE_NON_HOLDERS)(
      "POST /1/items/1/decision → 403 za %s",
      async (role) => {
        await post(
          "handover-drafts",
          "/1/items/1/decision",
          role,
          decideBody,
        ).expect(403);
      },
    );
  });
});
