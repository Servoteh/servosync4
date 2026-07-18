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
import { PdmController } from "../src/modules/pdm/pdm.controller";
import { PdmService } from "../src/modules/pdm/pdm.service";
import { PdmImportService } from "../src/modules/pdm/pdm-import.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { ALL_ROLE_KEYS } from "../src/common/authz/roles";
import { roleHasPermission } from "../src/common/authz/role-permissions";
import {
  PERMISSIONS,
  type PermissionKey,
} from "../src/common/authz/permissions";

/**
 * e2e PERMISSION MATRICA — PDM (crteži + nativni XML/PDF intake), rola × endpoint ×
 * 200/403 sa AUTHZ_ENFORCE=true (realno V2 ponašanje aktivacije, ŽIVO na prod-u).
 * JwtAuthGuard je stub (identitet iz `x-test-role`); PdmService/PdmImportService su
 * mokovani (bez PG baze i bez fajl-sistema uvoza). Dva permisiona sloja:
 *   - klasni guard `pdm.read`  → SVE read rute (drawings/bom/where-used/pdf/import-log/lookups)
 *   - metod guard  `pdm.import` → POST /import i POST /pdf-import (getAllAndOverride: metoda > klasa)
 * ID-jevi crteža su NUMERIČKI (legacy Int, ParseIntPipe) — nevalidan tip → 400 (posle guarda).
 * Skupovi rola se IZVODE iz ROLE_PERMISSIONS (roleHasPermission) nad ALL_ROLE_KEYS →
 * nova/pogrešno-grantovana uloga se ne može provući; tačnost mape pinuje authz unit.
 */
describe("PDM permission matrica (e2e, AUTHZ_ENFORCE=true)", () => {
  let app: INestApplication;

  const pdmMock: Record<string, jest.Mock> = {};
  for (const m of [
    "listDrawings",
    "findDrawing",
    "bom",
    "whereUsed",
    "importLog",
    "lookups",
  ]) {
    pdmMock[m] = jest.fn().mockResolvedValue({ data: [] });
  }
  // pdfContent handler destrukturira { buffer, fileName } iz getPdfContent → mora vratiti Buffer.
  pdmMock.getPdfContent = jest
    .fn()
    .mockResolvedValue({ buffer: Buffer.from("%PDF-1.4"), fileName: "crtez.pdf" });

  const importMock: Record<string, jest.Mock> = {
    importXml: jest.fn().mockResolvedValue({ success: true }),
    importPdf: jest.fn().mockResolvedValue({ success: true }),
  };

  // Guard čita userPermissionOverride.findUnique (deny>grant>rola); pdfContent ruta
  // best-effort upisuje auditLog.create (pad NE sme oboriti strim) — oba mokovana.
  const prismaMock = {
    userPermissionOverride: { findUnique: async () => null },
    auditLog: { create: jest.fn().mockResolvedValue({ id: 1 }) },
  };

  beforeAll(async () => {
    // SEC-01: import lanca guarda može tražiti JWT_SECRET; postavi pre svega.
    process.env.JWT_SECRET = "test-not-real-secret";
    process.env.AUTHZ_ENFORCE = "true"; // pre instanciranja PermissionsGuard-a
    const moduleRef = await Test.createTestingModule({
      controllers: [PdmController],
      providers: [
        { provide: PrismaService, useValue: prismaMock },
        { provide: PdmService, useValue: pdmMock },
        { provide: PdmImportService, useValue: importMock },
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
    const r = request(app.getHttpServer()).get(`/api/v1/pdm${path}`);
    return role ? r.set("x-test-role", role) : r;
  };
  const post = (path: string, role?: string, payload?: object) => {
    const r = request(app.getHttpServer()).post(`/api/v1/pdm${path}`);
    if (role) r.set("x-test-role", role);
    return payload === undefined ? r : r.send(payload);
  };

  // Skupovi rola iz žive mape (default-deny za nepoznate) — ne hardkoduju se.
  const rolesWith = (perm: PermissionKey) =>
    ALL_ROLE_KEYS.filter((r) => roleHasPermission(r, perm));
  const rolesWithout = (perm: PermissionKey) =>
    ALL_ROLE_KEYS.filter((r) => !roleHasPermission(r, perm));

  const READ_ROLES = rolesWith(PERMISSIONS.PDM_READ);
  const NO_READ = rolesWithout(PERMISSIONS.PDM_READ);
  const IMPORT_ROLES = rolesWith(PERMISSIONS.PDM_IMPORT);
  const NO_IMPORT = rolesWithout(PERMISSIONS.PDM_IMPORT);

  // Reprezentativne read rute (sve iza klasnog pdm.read).
  const READ_PATHS = [
    "/drawings",
    "/drawings/1",
    "/drawings/1/bom",
    "/drawings/1/where-used",
    "/drawings/1/pdf/content",
    "/import-log",
    "/lookups",
  ];

  describe("Read guard (pdm.read) — GET /drawings", () => {
    it.each(READ_ROLES)("GET /drawings → 200 za %s", async (role) => {
      await get("/drawings", role).expect(200);
    });
    it.each(NO_READ)(
      "GET /drawings → 403 za %s (nema pdm.read)",
      async (role) => {
        await get("/drawings", role).expect(403);
      },
    );
    it.each(["user", "nepoznata_rola"])(
      "GET /drawings → 403 za %s (default deny, ne-tautološki dokaz enforce-a)",
      async (role) => {
        await get("/drawings", role).expect(403);
      },
    );
    it("bez identiteta → 403 (JwtAuthGuard stub odbija bez x-test-role)", async () => {
      await get("/drawings").expect(403);
    });
  });

  describe("Read širina — svaka read ruta: 200 za holder, 403 za non-holder", () => {
    // magacioner ima pdm.read (nosilac lokacija, ali čita crteže); proizvodni_radnik
    // NEMA pdm.read (aktivna rola bez permisije) → dokaz metod-nezavisnog gate-a.
    it.each(READ_PATHS)(
      "GET %s → 200 magacioner (holder), 403 proizvodni_radnik (non-holder)",
      async (path) => {
        await get(path, "magacioner").expect(200);
        await get(path, "proizvodni_radnik").expect(403);
      },
    );
    it.each(READ_PATHS)("GET %s → 403 user (default deny)", async (path) => {
      await get(path, "user").expect(403);
    });
  });

  describe("Param validacija (:id = Int, ParseIntPipe) — guard prošao, tip nevalidan", () => {
    it("GET /drawings/:id → 200 za broj, 400 za ne-broj (admin)", async () => {
      await get("/drawings/1", "admin").expect(200);
      await get("/drawings/nije-broj", "admin").expect(400);
    });
    it("GET /drawings/:id/bom → 400 za ne-broj (admin)", async () => {
      await get("/drawings/abc/bom", "admin").expect(400);
    });
    it("GET /drawings/:id/pdf/content → 400 za ne-broj (admin)", async () => {
      await get("/drawings/abc/pdf/content", "admin").expect(400);
    });
    it("GET /drawings/:id/pdf/content → 200 + audit upis za magacioner (SEC-02)", async () => {
      prismaMock.auditLog.create.mockClear();
      await get("/drawings/1/pdf/content", "magacioner").expect(200);
      expect(prismaMock.auditLog.create).toHaveBeenCalledTimes(1);
    });
  });

  // ======================================================================
  // Metod guard — pdm.import (getAllAndOverride: metoda pobeđuje klasu).
  // Živo: import ima SAMO admin (ALL) + sef + menadzment (ručni „Uvoz PDF/XML",
  // Nenad 15.07). FileInterceptor prima jedan fajl; UI/bridge šalju sekvencijalno.
  // Bez fajla → file=undefined, servis mokovan → 201 (guard je jedina granica ovde).
  // ======================================================================
  describe("Import guard (pdm.import) — POST /import (XML)", () => {
    it.each(IMPORT_ROLES)("POST /import → 201 za %s", async (role) => {
      await post("/import", role, {}).expect(201);
    });
    it.each(NO_IMPORT)(
      "POST /import → 403 za %s (nema pdm.import)",
      async (role) => {
        await post("/import", role, {}).expect(403);
      },
    );
    it.each(["user", "nepoznata_rola"])(
      "POST /import → 403 za %s (default deny)",
      async (role) => {
        await post("/import", role, {}).expect(403);
      },
    );
  });

  describe("Import guard (pdm.import) — POST /pdf-import (PDF)", () => {
    it.each(IMPORT_ROLES)("POST /pdf-import → 201 za %s", async (role) => {
      await post("/pdf-import", role, {}).expect(201);
    });
    it.each(NO_IMPORT)(
      "POST /pdf-import → 403 za %s (nema pdm.import)",
      async (role) => {
        await post("/pdf-import", role, {}).expect(403);
      },
    );
  });

  describe("Read≠Import asimetrija (modul-specifična razlika)", () => {
    // tehnolog/kontrolor/cnc_programer ČITAJU crteže ali NE uvoze (import je uži gate).
    it.each(["tehnolog", "kontrolor", "cnc_programer", "nabavka_view", "viewer"])(
      "%s: GET /drawings 200 (read), POST /import 403 (bez import)",
      async (role) => {
        await get("/drawings", role).expect(200);
        await post("/import", role, {}).expect(403);
      },
    );
    // sef ČITA i UVOZI (jedina ne-mgmt/ne-admin rola sa pdm.import).
    it("sef: GET /drawings 200 (read) I POST /import 201 (import)", async () => {
      await get("/drawings", "sef").expect(200);
      await post("/import", "sef", {}).expect(201);
    });
    it("import krug je uži podskup read kruga (svaka import-rola ima i read)", () => {
      for (const r of IMPORT_ROLES) {
        expect(READ_ROLES).toContain(r);
      }
      expect(IMPORT_ROLES.length).toBeLessThan(READ_ROLES.length);
    });
  });
});
