import {
  ValidationPipe,
  VERSION_NEUTRAL,
  VersioningType,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { NextFunction, Request, Response } from "express";
import { existsSync } from "node:fs";
import { extname, join } from "node:path";
import { AppModule } from "./app.module";
import { AllExceptionsFilter } from "./common/http-exception.filter";

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // CORS (review Opus 5): `origin: true` je reflektovao BILO KOJI Origin uz
  // credentials — svaki sajt je mogao da šalje autentikovane zahteve ka API-ju.
  // Sada: allowlist domena (env CORS_ORIGINS, zarezom razdvojeno) + lokalni dev.
  // Prazan/izostavljen env u NE-produkciji = dozvoli sve (lokalni rad nesmetan).
  const allowedOrigins = (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  const isProd = process.env.NODE_ENV === "production";
  app.enableCors({
    credentials: true,
    origin: (origin, cb) => {
      // Same-origin / server-to-server (bez Origin headera) — uvek prolazi.
      if (!origin) return cb(null, true);
      if (allowedOrigins.length > 0) return cb(null, allowedOrigins.includes(origin));
      // Bez konfiguracije: prod dozvoljava samo servoteh.com domene, dev sve.
      if (!isProd) return cb(null, true);
      return cb(null, /^https:\/\/([a-z0-9-]+\.)*servoteh\.com$/i.test(origin));
    },
  });

  // Bezbednosni headeri (review Opus 5) — bez nove zavisnosti (nema helmet-a).
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "SAMEORIGIN"); // clickjacking (app se služi same-origin)
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("X-DNS-Prefetch-Control", "off");
    if (isProd) {
      res.setHeader(
        "Strict-Transport-Security",
        "max-age=31536000; includeSubDomains",
      );
    }
    next();
  });

  // Neuhvaćene greške → generička 500 + traceId (Prisma poruke su otkrivale šemu).
  app.useGlobalFilters(new AllExceptionsFilter());

  app.setGlobalPrefix("api");
  // URI versioning: domain modules are `version: '1'` → /api/v1/...
  // Existing routes (health, sync) have no version → stay at /api/... (VERSION_NEUTRAL).
  // Moving sync/health under v1 is a separate coordinated change (touches FE + tunnel health).
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: VERSION_NEUTRAL,
  });
  // Globalni ValidationPipe (BACKEND_RULES §8) — uveden uz prve mutacione DTO
  // klase (Reversi R2). Handleri sa interface tipovima (postojeći read moduli)
  // nemaju metatype-klasu → pipe ih preskače (bez promene ponašanja).
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));

  // Optional same-origin frontend: serve the Next static export (`out/`) so the app
  // is reachable directly on the LAN (http://<host>:3000) without internet, Cloudflare,
  // CORS, or a second container. The API stays under /api; every other path falls
  // through to the static files. Enabled only when FRONTEND_STATIC_DIR points at an
  // existing dir (see .env.example) — unset in dev / API-only deploys → pure API.
  // NOTE: 3.0 MOBILE routes live under /mob/* (e.g. /mob/lokacije — warehouse
  // phones on LAN Wi-Fi; /mob/prisustvo — live attendance, zahtev 019/26), NOT
  // under /m/* which the Cloudflare worker proxies to the 1.0 app. The
  // extensionless rewrite below covers them (mob/lokacije.html, mob/prisustvo.html);
  // a frontend-only push does NOT refresh this bake — trigger deploy-backend
  // (or push a backend change) so new /mob pages exist on the LAN copy too.
  const frontendDir = process.env.FRONTEND_STATIC_DIR;
  if (frontendDir && existsSync(frontendDir)) {
    // Clean-URL rewrite (what Cloudflare does via html_handling): /login → /login.html,
    // / → /index.html. The export ALSO emits a same-named dir per route (RSC payloads,
    // no index.html), so we must map to the .html file BEFORE static — otherwise
    // express.static redirects into that empty dir and 404s. Registered before
    // useStaticAssets (which applies express.static immediately) so it runs first.
    app.use((req: Request, _res: Response, next: NextFunction) => {
      const p = req.path;
      const skip =
        p.startsWith("/api") || p.startsWith("/_next") || p.includes("..");
      if (
        (req.method === "GET" || req.method === "HEAD") &&
        !skip &&
        !extname(p)
      ) {
        const rel = p === "/" ? "/index.html" : `${p.replace(/\/+$/, "")}.html`;
        if (existsSync(join(frontendDir, rel))) {
          req.url = rel + req.url.slice(p.length); // rewrite path, keep querystring
        }
      }
      next();
    });
    app.useStaticAssets(frontendDir, { extensions: ["html"] });
  }

  const port = Number(process.env.PORT) || 3000;
  await app.listen(port);
}
bootstrap();
