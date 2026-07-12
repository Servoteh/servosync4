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
import { ALL_ROLE_KEYS } from "../src/common/authz/roles";
import { EnergetikaController } from "../src/modules/energetika/energetika.controller";
import { EnergetikaService } from "../src/modules/energetika/energetika.service";

/**
 * e2e PERMISSION MATRICA — Energetika/SCADA (MODULE_SPEC_scada_30.md §5 stavka 16),
 * rola × endpoint × 200/403. Guard sloj se testira SA AUTHZ_ENFORCE=true (realno
 * ponašanje V2 aktivacije); JwtAuthGuard je stub koji identitet čita iz `x-test-role`.
 * EnergetikaService je mokovan (bez sy15 baze) — RLS/withUserRls (DB-nivo scope) je
 * verifikovan živim smoke-om, ne ovde: ovde je JEDINO rola-sloj (guard) matrica.
 *
 * Paritet 1.0: SCADA je SAMO admin+menadzment (scada_is_admin_or_management). NEMA
 * viewer read-baseline — sve ostale uloge dobijaju 403 na CEO modul.
 */
describe("Energetika permission matrica (e2e, AUTHZ_ENFORCE=true)", () => {
  let app: INestApplication;
  const VALID_UUID = "3b241101-e2bb-4255-8caf-4136c566a962";

  const serviceMock: Record<string, jest.Mock> = {};
  for (const m of [
    "sites",
    "snapshots",
    "snapshotRow",
    "history",
    "activeAlarms",
    "alarmHistory",
    "recentCommands",
    "command",
  ]) {
    serviceMock[m] = jest.fn().mockResolvedValue({ data: [] });
  }

  beforeAll(async () => {
    process.env.AUTHZ_ENFORCE = "true"; // pre instanciranja PermissionsGuard-a
    const moduleRef = await Test.createTestingModule({
      controllers: [EnergetikaController],
      providers: [{ provide: EnergetikaService, useValue: serviceMock }],
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
      .get(`/api/v1/energetika${path}`)
      .set("x-test-role", role);

  // read = SAMO admin + menadzment (paritet scada_is_admin_or_management).
  const READ_ROLES = ["admin", "menadzment"];
  // SVE ostale katalogisane uloge (izvedeno iz ALL_ROLE_KEYS — review nalaz 12.07:
  // ručna lista je izostavljala 5 rezervisanih rola) + degenerisani slučajevi.
  const DENIED_ROLES = [
    ...ALL_ROLE_KEYS.filter((r) => !READ_ROLES.includes(r)),
    "user",
    "nepoznata_rola",
  ];

  // (endpoint, primer putanje) — sve GET rute klase su energetika.read.
  const ENDPOINTS: [string, string][] = [
    ["GET /sites", "/sites"],
    ["GET /snapshots", "/snapshots"],
    ["GET /snapshots/:siteKey", "/snapshots/kot1"],
    ["GET /history/:siteKey", "/history/kot1?hours=24"],
    ["GET /alarms", "/alarms?active=true"],
    ["GET /alarms/:siteKey", "/alarms/kot2?limit=50"],
    ["GET /commands", "/commands?limit=40"],
    ["GET /commands/:id", `/commands/${VALID_UUID}`],
  ];

  describe("read endpointi — energetika.read (admin + menadzment)", () => {
    for (const [label, path] of ENDPOINTS) {
      it.each(READ_ROLES)(`${label} → 200 za %s`, async (role) => {
        await get(path, role).expect(200);
      });
      it.each(DENIED_ROLES)(`${label} → 403 za %s`, async (role) => {
        await get(path, role).expect(403);
      });
    }
  });

  describe("granični slučajevi", () => {
    it("bez identiteta → 403 (JwtAuthGuard stub)", async () => {
      await request(app.getHttpServer())
        .get("/api/v1/energetika/snapshots")
        .expect(403);
    });

    it("GET /commands/:id sa nevalidnim UUID → 400 (ParseUUIDPipe) za admin", async () => {
      await get("/commands/nije-uuid", "admin").expect(400);
    });

    it("R2 komande NISU izložene u R1: POST /commands → 404 (ruta ne postoji)", async () => {
      await request(app.getHttpServer())
        .post("/api/v1/energetika/commands")
        .set("x-test-role", "admin")
        .send({ siteKey: "kot1", target: "X", value: {} })
        .expect(404);
    });
  });
});
