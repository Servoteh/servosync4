import { VERSION_NEUTRAL, VersioningType } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { NextFunction, Request, Response } from "express";
import { existsSync } from "node:fs";
import { extname, join } from "node:path";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.enableCors({ origin: true, credentials: true });
  app.setGlobalPrefix("api");
  // URI versioning: domain modules are `version: '1'` → /api/v1/...
  // Existing routes (health, sync) have no version → stay at /api/... (VERSION_NEUTRAL).
  // Moving sync/health under v1 is a separate coordinated change (touches FE + tunnel health).
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: VERSION_NEUTRAL,
  });

  // Optional same-origin frontend: serve the Next static export (`out/`) so the app
  // is reachable directly on the LAN (http://<host>:3000) without internet, Cloudflare,
  // CORS, or a second container. The API stays under /api; every other path falls
  // through to the static files. Enabled only when FRONTEND_STATIC_DIR points at an
  // existing dir (see .env.example) — unset in dev / API-only deploys → pure API.
  const frontendDir = process.env.FRONTEND_STATIC_DIR;
  if (frontendDir && existsSync(frontendDir)) {
    // Clean-URL rewrite (what Cloudflare does via html_handling): /login → /login.html,
    // / → /index.html. The export ALSO emits a same-named dir per route (RSC payloads,
    // no index.html), so we must map to the .html file BEFORE static — otherwise
    // express.static redirects into that empty dir and 404s. Registered before
    // useStaticAssets (which applies express.static immediately) so it runs first.
    app.use((req: Request, _res: Response, next: NextFunction) => {
      const p = req.path;
      const skip = p.startsWith("/api") || p.startsWith("/_next") || p.includes("..");
      if ((req.method === "GET" || req.method === "HEAD") && !skip && !extname(p)) {
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
