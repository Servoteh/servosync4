import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { App } from "supertest/types";
import { AppController } from "./../src/app.controller";
import { AppService } from "./../src/app.service";
import { PrismaService } from "./../src/prisma/prisma.service";

/**
 * Nest boilerplate smoke za korenske rute (`/api`, `/api/health`).
 *
 * 🔴 NE UVOZI `AppModule` (F8, 05.08.2026). Ranije je uvozio, pa je
 * `PrismaService.onModuleInit → $connect()` tražio ŽIVU bazu: bez `DATABASE_URL`
 * test pada sa `PrismaClientInitializationError`, a sa dummy URL-om na „Can't
 * reach database server". Zato je stajao crven u punom e2e prolazu (4595/4596),
 * a CI ga nije hvatao — `ci-backend.yml` vozi samo obrazac
 * `permissions|coverage|command-safety`. Sada se instanciraju samo kontroler i
 * servis, sa mokovanim Prisma klijentom: testu ne treba baza, pa može da vozi u
 * svakom gejtu i stvarno nešto tvrdi.
 */
describe("AppController (e2e)", () => {
  let app: INestApplication<App>;
  // `health` ruta je jedini potrošač Prisme ovde: `$queryRaw` → { database: 'up' }.
  const prismaMock = {
    $queryRaw: jest.fn().mockResolvedValue([{ "?column?": 1 }]),
  };

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService, { provide: PrismaService, useValue: prismaMock }],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix("api");
    await app.init();
  });

  it("/api (GET)", () => {
    return request(app.getHttpServer())
      .get("/api")
      .expect(200)
      .expect("Hello World!");
  });

  it("/api/health (GET) — baza dostupna", () => {
    return request(app.getHttpServer())
      .get("/api/health")
      .expect(200)
      .expect({ ok: true, database: "up" });
  });

  it("/api/health (GET) — pad baze je database:'down', ne 500", async () => {
    prismaMock.$queryRaw.mockRejectedValueOnce(new Error("db down"));
    await request(app.getHttpServer())
      .get("/api/health")
      .expect(200)
      .expect({ ok: true, database: "down" });
  });

  afterEach(async () => {
    await app.close();
  });
});
