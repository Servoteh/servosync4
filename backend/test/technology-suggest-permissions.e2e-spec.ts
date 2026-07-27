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
import { TechnologySuggestController } from "../src/modules/work-orders/technology-suggest.controller";
import { TechnologySuggestService } from "../src/modules/work-orders/technology-suggest.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { ALL_ROLE_KEYS } from "../src/common/authz/roles";
import { roleHasPermission } from "../src/common/authz/role-permissions";
import { PERMISSIONS, type PermissionKey } from "../src/common/authz/permissions";

/**
 * TALAS AI-6 (review [13]) — RUNTIME permisija matrica za predlog tehnologije.
 * Glavna baza NEMA RLS → `tehnologija.read` je JEDINA brana; mora se pinovati na
 * 200/403 sa AUTHZ_ENFORCE=true, ne samo statičkom coverage-om. JwtAuthGuard je
 * stub (identitet iz `x-test-role`); servis je mokovan (bez proizvodne baze).
 */
describe("Predlog tehnologije permission matrica (e2e, AUTHZ_ENFORCE=true)", () => {
  let app: INestApplication;

  const suggestMock = {
    forDrawing: jest.fn().mockResolvedValue({ data: { ima_istoriju: false } }),
  };
  // Guard čita userPermissionOverride (override sloj).
  const prismaMock = { userPermissionOverride: { findUnique: async () => null } };

  beforeAll(async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test-not-real-secret";
    process.env.AUTHZ_ENFORCE = "true"; // pre instanciranja PermissionsGuard-a
    const moduleRef = await Test.createTestingModule({
      controllers: [TechnologySuggestController],
      providers: [
        { provide: PrismaService, useValue: prismaMock },
        { provide: TechnologySuggestService, useValue: suggestMock },
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
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.AUTHZ_ENFORCE;
  });

  const url = "/api/v1/tehnologija/suggest/drawing?crtez=1052059";
  const get = (role?: string) => {
    const r = request(app.getHttpServer()).get(url);
    return role ? r.set("x-test-role", role) : r;
  };

  // Rola-skupovi se IZVODE iz izvora istine (ALL_ROLE_KEYS × roleHasPermission).
  const rolesWith = (perm: PermissionKey) =>
    ALL_ROLE_KEYS.filter((r) => roleHasPermission(r, perm));
  const rolesWithout = (perm: PermissionKey) =>
    ALL_ROLE_KEYS.filter((r) => !roleHasPermission(r, perm));

  const READ_ROLES = rolesWith(PERMISSIONS.TEHNOLOGIJA_READ);
  const NO_READ = rolesWithout(PERMISSIONS.TEHNOLOGIJA_READ);

  it.each(READ_ROLES)(
    "GET /suggest/drawing → 200 za %s (ima tehnologija.read)",
    async (role) => {
      await get(role).expect(200);
    },
  );
  it.each(NO_READ)(
    "GET /suggest/drawing → 403 za %s (nema tehnologija.read — default deny)",
    async (role) => {
      await get(role).expect(403);
    },
  );
  it.each(["user", "nepoznata_rola"])(
    "GET /suggest/drawing → 403 za %s (ne-tautološki default deny)",
    async (role) => {
      await get(role).expect(403);
    },
  );
  it("bez identiteta → 403 (JwtAuthGuard stub odbija bez x-test-role)", async () => {
    await get().expect(403);
  });
});
