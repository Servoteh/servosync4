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
import { TechProcessesController } from "../src/modules/tech-processes/tech-processes.controller";
import { TechProcessesService } from "../src/modules/tech-processes/tech-processes.service";
import { SessionAutoCloseService } from "../src/modules/tech-processes/session-auto-close.service";
import { PdmService } from "../src/modules/pdm/pdm.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { ALL_ROLE_KEYS } from "../src/common/authz/roles";
import { roleHasPermission } from "../src/common/authz/role-permissions";
import {
  PERMISSIONS,
  type PermissionKey,
} from "../src/common/authz/permissions";

/**
 * e2e PERMISSION MATRICA — Tehnološki postupci (TP / kiosk pogon), rola × endpoint ×
 * 200/403 sa AUTHZ_ENFORCE=true (realno V2 ponašanje). JwtAuthGuard je stub (identitet
 * iz `x-test-role`); servisi su mokovani (bez proizvodne baze). Row-scope
 * (proizvodni_radnik → svoje mašine kroz ScopeService, worker-flag definesLaunch/Approval)
 * NIJE ovde — to je servis/DB sloj; ovaj test pinuje GRUBU rola-kapiju guarda.
 *
 * Kontroler ima 4 tier-a permisija (route-permission-coverage.txt):
 *   tehnologija.read        — listinzi/kartice/sesije/label/worker + barcode/decode + PDF crteža
 *   tehnologija.report_work — kiosk unos rada (scan/finish/start/stop/dismiss/labels/print/work·worker/open)
 *   tehnologija.approve     — završna kontrola (POST /control)
 *   tehnologija.write       — storno/reopen/delete/auto-close
 * Method-level @RequirePermission override-uje class-level READ (Reflector.getAllAndOverride).
 *
 * ID-jevi su NUMERIČKI (legacy Int, ParseIntPipe) — ne UUID. Guard teče PRE ParseIntPipe,
 * pa ne-int `:id` → 400 SAMO za nosioca; ne-nosilac dobije 403 pre pipe-a.
 */
describe("Tehnološki postupci permission matrica (e2e, AUTHZ_ENFORCE=true)", () => {
  let app: INestApplication;
  const ID = 1; // legacy numerički id

  // --- Servis mokovi: SVE metode koje kontroler zove ---
  const techMock: Record<string, jest.Mock> = {};
  for (const m of [
    "list",
    "card",
    "critical",
    "workerPerformance",
    "rnProgress",
    "sessionsDaily",
    "sessionsSummary",
    "sessionsHourly",
    "sessionsPoorlyRecorded",
    "identifyWorker",
    "identifyWorkerFromUser",
    "openForWorker",
    "label",
    "printRawLabel",
    "openSession",
    "decodeBarcode",
    "scan",
    "finish",
    "stopWorkById",
    "dismissEntry",
    "control",
    "startWork",
    "stopWork",
    "storno",
    "reopen",
    "deleteEntry",
    "findOne",
  ]) {
    techMock[m] = jest.fn().mockResolvedValue({ data: [] });
  }
  const autoCloseMock = { run: jest.fn().mockResolvedValue({ data: { closed: 0 } }) };
  // PDF crteža ruta: PdmService.getPdfContent → { buffer, fileName } (StreamableFile).
  const pdmMock = {
    getPdfContent: jest
      .fn()
      .mockResolvedValue({ buffer: Buffer.from("%PDF-1.4"), fileName: "crtez.pdf" }),
  };
  // Prisma: guard čita userPermissionOverride (override sloj); PDF ruta piše auditLog (best-effort).
  const prismaMock = {
    userPermissionOverride: { findUnique: async () => null },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };

  beforeAll(async () => {
    // SEC-01 fail-closed (AuthModule requireJwtSecret) — setup ga već postavlja, ovde defanzivno.
    process.env.JWT_SECRET =
      process.env.JWT_SECRET || "test-not-real-secret";
    process.env.AUTHZ_ENFORCE = "true"; // pre instanciranja PermissionsGuard-a
    const moduleRef = await Test.createTestingModule({
      controllers: [TechProcessesController],
      providers: [
        { provide: PrismaService, useValue: prismaMock },
        { provide: TechProcessesService, useValue: techMock },
        { provide: SessionAutoCloseService, useValue: autoCloseMock },
        { provide: PdmService, useValue: pdmMock },
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

  const base = "/api/v1/tech-processes";
  const get = (path: string, role?: string) => {
    const r = request(app.getHttpServer()).get(`${base}${path}`);
    return role ? r.set("x-test-role", role) : r;
  };
  const post = (path: string, role: string, body: object = {}) =>
    request(app.getHttpServer())
      .post(`${base}${path}`)
      .set("x-test-role", role)
      .send(body);
  const del = (path: string, role: string, body: object = {}) =>
    request(app.getHttpServer())
      .delete(`${base}${path}`)
      .set("x-test-role", role)
      .send(body);

  // Test-hardening: rola-skupovi se IZVODE iz ALL_ROLE_KEYS + roleHasPermission (izvor istine),
  // ne ručno — nova/pogrešno-grantovana uloga NE može da se provuče (kao odrzavanje šablon).
  const rolesWith = (perm: PermissionKey) =>
    ALL_ROLE_KEYS.filter((r) => roleHasPermission(r, perm));
  const rolesWithout = (perm: PermissionKey) =>
    ALL_ROLE_KEYS.filter((r) => !roleHasPermission(r, perm));

  const READ_ROLES = rolesWith(PERMISSIONS.TEHNOLOGIJA_READ);
  const NO_READ = rolesWithout(PERMISSIONS.TEHNOLOGIJA_READ);
  const REPORT_ROLES = rolesWith(PERMISSIONS.TEHNOLOGIJA_REPORT_WORK);
  const NO_REPORT = rolesWithout(PERMISSIONS.TEHNOLOGIJA_REPORT_WORK);
  const APPROVE_ROLES = rolesWith(PERMISSIONS.TEHNOLOGIJA_APPROVE);
  const NO_APPROVE = rolesWithout(PERMISSIONS.TEHNOLOGIJA_APPROVE);
  const WRITE_ROLES = rolesWith(PERMISSIONS.TEHNOLOGIJA_WRITE);
  const NO_WRITE = rolesWithout(PERMISSIONS.TEHNOLOGIJA_WRITE);

  // ==================================================================
  // READ tier (tehnologija.read) — listinzi/kartice/sesije/worker/label
  // ==================================================================
  describe("READ (tehnologija.read) — pregledi + kiosk resolveri", () => {
    it.each(READ_ROLES)("GET / (lista) → 200 za %s", async (role) => {
      await get("/", role).expect(200);
    });
    it.each(NO_READ)(
      "GET / (lista) → 403 za %s (nema read — default deny)",
      async (role) => {
        await get("/", role).expect(403);
      },
    );
    it.each(["user", "nepoznata_rola"])(
      "GET / → 403 za %s (ne-tautološki default deny — dokaz enforcement-a)",
      async (role) => {
        await get("/", role).expect(403);
      },
    );
    it("bez identiteta → 403 (JwtAuthGuard stub odbija bez x-test-role)", async () => {
      await get("/").expect(403);
    });

    // Literali PRE `:id` — moraju se rutirati na svoj handler (ne ParseIntPipe 400).
    const readLiterals = [
      "/card",
      "/critical",
      "/rn-progress",
      "/worker-performance",
      "/label",
      "/worker",
      "/worker/me",
      "/sessions/daily",
      "/sessions/summary",
      "/sessions/hourly",
      "/sessions/poorly-recorded",
    ];
    it.each(readLiterals)(
      "GET %s → 200 za tehnolog (literal pre :id), 403 za user",
      async (path) => {
        await get(path, "tehnolog").expect(200);
        await get(path, "user").expect(403);
      },
    );

    it("GET /:id → 200 nosilac (tehnolog), 403 ne-nosilac (tehnicar_odrzavanja)", async () => {
      await get(`/${ID}`, "tehnolog").expect(200);
      await get(`/${ID}`, "tehnicar_odrzavanja").expect(403);
    });
    it("GET /:id ne-int → 400 za nosioca (ParseIntPipe), ali 403 za ne-nosioca (guard PRE pipe)", async () => {
      await get("/abc", "tehnolog").expect(400);
      await get("/abc", "user").expect(403);
    });

    it("POST /barcode/decode → 200 nosilac (HttpCode 200, read = parse bez upisa), 403 non-holder", async () => {
      // Kontrolor mora moći da dekodira (kiosk KONTROLA skenira pre `control`).
      await post("/barcode/decode", "kontrolor", { barcode: "RNZ:1:1:1:1" }).expect(
        200,
      );
      await post("/barcode/decode", "tehnicar_odrzavanja", {
        barcode: "RNZ:1:1:1:1",
      }).expect(403);
    });
    it("POST /barcode/decode bez 'barcode' → 400 (validateDecodeBarcode teče POSLE guarda)", async () => {
      await post("/barcode/decode", "admin", {}).expect(400);
    });

    it("GET /drawings/:id/pdf/content → 200 nosilac (kiosk PDF pod READ), 403 non-holder", async () => {
      await get(`/drawings/${ID}/pdf/content`, "proizvodni_radnik").expect(200);
      await get(`/drawings/${ID}/pdf/content`, "user").expect(403);
    });
    it("GET /drawings/:id/pdf/content ne-int → 400 nosilac (ParseIntPipe)", async () => {
      await get("/drawings/abc/pdf/content", "tehnolog").expect(400);
    });
  });

  // ==================================================================
  // REPORT_WORK tier (tehnologija.report_work) — kiosk unos rada
  // ==================================================================
  describe("REPORT_WORK (tehnologija.report_work) — kiosk prijava/zatvaranje rada", () => {
    it.each(REPORT_ROLES)("POST /scan → 201 za %s", async (role) => {
      await post("/scan", role).expect(201);
    });
    it.each(NO_REPORT)(
      "POST /scan → 403 za %s (nema report_work)",
      async (role) => {
        await post("/scan", role).expect(403);
      },
    );

    it.each(REPORT_ROLES)("POST /:id/finish → 201 za %s", async (role) => {
      await post(`/${ID}/finish`, role).expect(201);
    });
    it.each(NO_REPORT)("POST /:id/finish → 403 za %s", async (role) => {
      await post(`/${ID}/finish`, role).expect(403);
    });

    it.each(REPORT_ROLES)("POST /:id/stop-work → 201 za %s", async (role) => {
      await post(`/${ID}/stop-work`, role).expect(201);
    });
    it.each(REPORT_ROLES)("POST /:id/dismiss → 201 za %s", async (role) => {
      await post(`/${ID}/dismiss`, role).expect(201);
    });
    it.each(REPORT_ROLES)("POST /work/start → 201 za %s", async (role) => {
      await post("/work/start", role).expect(201);
    });
    it.each(REPORT_ROLES)("POST /work/stop → 201 za %s", async (role) => {
      await post("/work/stop", role).expect(201);
    });
    it.each(NO_REPORT)(
      "POST /work/start → 403 za %s (kiosk zatvoren bez report_work)",
      async (role) => {
        await post("/work/start", role).expect(403);
      },
    );

    it("POST /labels/print → 200 nosilac (HttpCode 200, bajtovi štampaču), 403 non-holder", async () => {
      await post("/labels/print", "proizvodni_radnik", {
        tspl2: "CLS\nPRINT 1,1\n",
      }).expect(200);
      await post("/labels/print", "viewer", { tspl2: "CLS\n" }).expect(403);
    });

    it("GET /work/open → 200 nosilac, 403 non-holder (report_work override class-READ)", async () => {
      await get("/work/open", "kontrolor").expect(200);
      await get("/work/open", "viewer").expect(403);
    });
    it("GET /worker/open → 200 nosilac, 403 non-holder (viewer ima READ ali NE report_work)", async () => {
      await get("/worker/open", "proizvodni_radnik").expect(200);
      await get("/worker/open", "viewer").expect(403);
    });
  });

  // ==================================================================
  // APPROVE tier (tehnologija.approve) — ZAVRŠNA KONTROLA
  // ==================================================================
  describe("APPROVE (tehnologija.approve) — POST /control (finalna kontrola)", () => {
    it.each(APPROVE_ROLES)("POST /control → 201 za %s", async (role) => {
      await post("/control", role).expect(201);
    });
    it.each(NO_APPROVE)(
      "POST /control → 403 za %s (nema approve)",
      async (role) => {
        await post("/control", role).expect(403);
      },
    );
  });

  // ==================================================================
  // WRITE tier (tehnologija.write) — storno/reopen/delete/auto-close
  // ==================================================================
  describe("WRITE (tehnologija.write) — korekcije + auto-close", () => {
    it.each(WRITE_ROLES)("DELETE /:id → 200 za %s", async (role) => {
      await del(`/${ID}`, role).expect(200);
    });
    it.each(NO_WRITE)("DELETE /:id → 403 za %s (nema write)", async (role) => {
      await del(`/${ID}`, role).expect(403);
    });

    it.each(WRITE_ROLES)("POST /:id/storno → 201 za %s", async (role) => {
      await post(`/${ID}/storno`, role).expect(201);
    });
    it.each(NO_WRITE)("POST /:id/storno → 403 za %s", async (role) => {
      await post(`/${ID}/storno`, role).expect(403);
    });

    it.each(WRITE_ROLES)("POST /:id/reopen → 201 za %s", async (role) => {
      await post(`/${ID}/reopen`, role).expect(201);
    });
    it.each(NO_WRITE)("POST /:id/reopen → 403 za %s", async (role) => {
      await post(`/${ID}/reopen`, role).expect(403);
    });

    it("POST /work/auto-close → 200 nosilac (HttpCode 200, cron), 403 non-holder", async () => {
      await post("/work/auto-close", "sef", { olderThanHours: 12 }).expect(200);
      await post("/work/auto-close", "kontrolor", {}).expect(403);
    });
  });

  // ==================================================================
  // MODUL-SPECIFIČNE razlike (unakrsni kontrast tier-ova na istoj roli)
  // ==================================================================
  describe("Modul-specifične granice (isti korisnik, različit tier)", () => {
    it("kontrolor: SME finalnu kontrolu (approve 201) ALI NE storno (write 403); scan (report_work 201)", async () => {
      await post("/control", "kontrolor").expect(201);
      await post(`/${ID}/storno`, "kontrolor").expect(403);
      await post("/scan", "kontrolor").expect(201);
    });
    it("proizvodni_radnik: kuca rad (scan 201) ALI NE kontrolu (approve 403) ni storno (write 403)", async () => {
      await post("/scan", "proizvodni_radnik").expect(201);
      await post("/control", "proizvodni_radnik").expect(403);
      await post(`/${ID}/storno`, "proizvodni_radnik").expect(403);
    });
    it("menadzment: čita (200) + odobrava kontrolu (approve 201) ALI NE kuca (report_work 403) ni piše (write 403)", async () => {
      await get("/", "menadzment").expect(200);
      await post("/control", "menadzment").expect(201);
      await post("/scan", "menadzment").expect(403);
      await post(`/${ID}/storno`, "menadzment").expect(403);
    });
    it("magacioner: čita TP (200) ALI je zaključan iz svih mutacija (report/approve/write 403)", async () => {
      await get("/", "magacioner").expect(200);
      await post("/scan", "magacioner").expect(403);
      await post("/control", "magacioner").expect(403);
      await post(`/${ID}/storno`, "magacioner").expect(403);
    });
  });
});
