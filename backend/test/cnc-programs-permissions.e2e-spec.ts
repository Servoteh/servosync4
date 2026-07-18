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
import { CncProgramsController } from "../src/modules/cnc-programs/cnc-programs.controller";
import { CncProgramsService } from "../src/modules/cnc-programs/cnc-programs.service";
import { ALL_ROLE_KEYS } from "../src/common/authz/roles";
import { roleHasPermission } from "../src/common/authz/role-permissions";
import { PrismaService } from "../src/prisma/prisma.service";
import {
  PERMISSIONS,
  type PermissionKey,
} from "../src/common/authz/permissions";

/**
 * e2e PERMISSION MATRICA — CAM / CNC programiranje (cnc-programs.controller),
 * rola × endpoint × 2xx/403 sa AUTHZ_ENFORCE=true (realno V2 ponašanje).
 * JwtAuthGuard je stub (identitet iz `x-test-role`); servis je mokovan.
 *
 * Tri rute, tri različite permisije (izvor: reports/route-permission-coverage.txt):
 *   GET   /cnc-programs               → tehnologija.read   (class default)
 *   PATCH /cnc-programs/:workOrderId  → tehnologija.write
 *   PATCH /cnc-programs/:workOrderId/queue → tehnologija.cam_prioritet
 *
 * Ključna modul-specifična razlika (permissions.ts §CAM_PRIORITET): `cam_prioritet`
 * se NE dodeljuje nijednoj roli — imenovani tehnolozi (miljan/nikola/jovica) je
 * dobijaju kroz `user_permission_overrides` grant; admin je nasleđuje kroz ALL. Zato
 * cnc_programer/tehnolog SMEJU write, ali NE mogu prevlačiti CAM red na rola-sloju.
 *
 * ID-jevi su NUMERIČKI (legacy Int) → `:workOrderId` ide kroz ParseIntPipe (ne-broj = 400).
 * Guard (403) prethodi ParseIntPipe (400) — dokazano ispod.
 *
 * Liste rola se IZVODE iz ALL_ROLE_KEYS + roleHasPermission (izvor istine
 * ROLE_PERMISSIONS) → nova/pogrešno-grantovana uloga se NE može provući, a asercije
 * nisu tautološke (dokaz enforcement-a, ne prepis konstante).
 */
describe("CNC programi (CAM) permission matrica (e2e, AUTHZ_ENFORCE=true)", () => {
  let app: INestApplication;

  // Kontroler zove tačno tri servis-metode.
  const svcMock: Record<string, jest.Mock> = {
    list: jest.fn().mockResolvedValue({ data: [], meta: {} }),
    setDone: jest
      .fn()
      .mockResolvedValue({ data: { workOrderId: 1, isDone: true } }),
    moveInQueue: jest
      .fn()
      .mockResolvedValue({ data: { workOrderId: 1, queueOrder: 1 } }),
  };

  beforeAll(async () => {
    // SEC-01: import kontrolera/servisa povlači auth stack — postavi JWT_SECRET
    // (test-only) da modul ne padne pri instanciranju.
    process.env.JWT_SECRET ??= "test-not-real-secret";
    process.env.AUTHZ_ENFORCE = "true"; // pre instanciranja PermissionsGuard-a
    const moduleRef = await Test.createTestingModule({
      controllers: [CncProgramsController],
      providers: [
        {
          provide: PrismaService,
          useValue: {
            userPermissionOverride: { findUnique: async () => null },
          },
        },
        { provide: CncProgramsService, useValue: svcMock },
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

  const get = (path: string, role?: string) => {
    const r = request(app.getHttpServer()).get(`/api/v1/cnc-programs${path}`);
    return role ? r.set("x-test-role", role) : r;
  };
  const patch = (path: string, role: string, body: object = {}) =>
    request(app.getHttpServer())
      .patch(`/api/v1/cnc-programs${path}`)
      .set("x-test-role", role)
      .send(body);

  // Izvedene liste iz izvora istine (ROLE_PERMISSIONS) — ne ručno.
  const rolesWith = (perm: PermissionKey) =>
    ALL_ROLE_KEYS.filter((r) => roleHasPermission(r, perm));
  const rolesWithout = (perm: PermissionKey) =>
    ALL_ROLE_KEYS.filter((r) => !roleHasPermission(r, perm));

  const READ_ROLES = rolesWith(PERMISSIONS.TEHNOLOGIJA_READ);
  const NO_READ = rolesWithout(PERMISSIONS.TEHNOLOGIJA_READ);
  const WRITE_ROLES = rolesWith(PERMISSIONS.TEHNOLOGIJA_WRITE);
  const NO_WRITE = rolesWithout(PERMISSIONS.TEHNOLOGIJA_WRITE);
  const CAM_ROLES = rolesWith(PERMISSIONS.CAM_PRIORITET);
  const NO_CAM = rolesWithout(PERMISSIONS.CAM_PRIORITET);

  const doneBody = { isDone: true };
  const queueBody = { afterWorkOrderId: null };

  // ----------------------------------------------------------------------
  // GET /cnc-programs — tehnologija.read (class default)
  // ----------------------------------------------------------------------
  describe("GET /cnc-programs (list) — tehnologija.read", () => {
    it.each(READ_ROLES)("→ 200 za %s (holder)", async (role) => {
      await get("", role).expect(200);
    });
    it.each(NO_READ)("→ 403 za %s (non-holder)", async (role) => {
      await get("", role).expect(403);
    });
    it.each(["user", "nepoznata_rola"])(
      "→ 403 za %s (default deny)",
      async (role) => {
        await get("", role).expect(403);
      },
    );
    it("bez identiteta → 403 (JwtAuthGuard stub)", async () => {
      await get("").expect(403);
    });
    it("prolaz filtera (q/onlyPending) NE menja gate: 200 za tehnolog", async () => {
      await get("?q=abc&onlyPending=1", "tehnolog").expect(200);
    });
  });

  // ----------------------------------------------------------------------
  // PATCH /cnc-programs/:workOrderId — tehnologija.write
  // ----------------------------------------------------------------------
  describe("PATCH /cnc-programs/:workOrderId (setDone) — tehnologija.write", () => {
    it.each(WRITE_ROLES)("→ 200 za %s (holder)", async (role) => {
      await patch("/1", role, doneBody).expect(200);
    });
    it.each(NO_WRITE)("→ 403 za %s (non-holder)", async (role) => {
      await patch("/1", role, doneBody).expect(403);
    });
    it("modul-razlika: menadzment/kontrolor ČITAJU (read) ali NE PIŠU (write) → 403", async () => {
      // menadzment i kontrolor imaju tehnologija.read + approve, ali NE write.
      await get("", "menadzment").expect(200);
      await patch("/1", "menadzment", doneBody).expect(403);
      await get("", "kontrolor").expect(200);
      await patch("/1", "kontrolor", doneBody).expect(403);
    });
    it("ParseIntPipe: ne-broj :workOrderId → 400 za holder (admin)", async () => {
      await patch("/nije-broj", "admin", doneBody).expect(400);
    });
    it("guard PRE ParseIntPipe: ne-broj :workOrderId → 403 za non-holder (user)", async () => {
      await patch("/nije-broj", "user", doneBody).expect(403);
    });
  });

  // ----------------------------------------------------------------------
  // PATCH /cnc-programs/:workOrderId/queue — tehnologija.cam_prioritet
  // ----------------------------------------------------------------------
  describe("PATCH /cnc-programs/:workOrderId/queue (moveInQueue) — tehnologija.cam_prioritet", () => {
    it("CAM_ROLES = samo admin (paritet: perm se ne dodeljuje nijednoj roli, admin kroz ALL)", () => {
      expect(CAM_ROLES).toEqual(["admin"]);
    });
    it.each(CAM_ROLES)("→ 200 za %s (holder)", async (role) => {
      svcMock.moveInQueue.mockClear();
      await patch("/1/queue", role, queueBody).expect(200);
      // Dokaz da statičniji segment NIJE zasenčen `:workOrderId` rutom.
      expect(svcMock.moveInQueue).toHaveBeenCalled();
    });
    it.each(NO_CAM)("→ 403 za %s (non-holder)", async (role) => {
      await patch("/1/queue", role, queueBody).expect(403);
    });
    it("modul-razlika: cnc_programer/tehnolog SMEJU write ali NE cam_prioritet → 403 na queue", async () => {
      await patch("/1", "cnc_programer", doneBody).expect(200); // write prolazi
      await patch("/1/queue", "cnc_programer", queueBody).expect(403); // cam_prioritet ne
      await patch("/1", "tehnolog", doneBody).expect(200);
      await patch("/1/queue", "tehnolog", queueBody).expect(403);
    });
    it("route ordering: /:id/queue se NE hvata kao setDone (admin → moveInQueue, ne setDone)", async () => {
      svcMock.moveInQueue.mockClear();
      svcMock.setDone.mockClear();
      await patch("/1/queue", "admin", queueBody).expect(200);
      expect(svcMock.moveInQueue).toHaveBeenCalled();
      expect(svcMock.setDone).not.toHaveBeenCalled();
    });
    it("ParseIntPipe: ne-broj :workOrderId → 400 za holder (admin)", async () => {
      await patch("/nije-broj/queue", "admin", queueBody).expect(400);
    });
    it("guard PRE ParseIntPipe: ne-broj :workOrderId → 403 za non-holder (user)", async () => {
      await patch("/nije-broj/queue", "user", queueBody).expect(403);
    });
    it("bez identiteta → 403 (JwtAuthGuard stub)", async () => {
      await request(app.getHttpServer())
        .patch("/api/v1/cnc-programs/1/queue")
        .send(queueBody)
        .expect(403);
    });
  });
});
