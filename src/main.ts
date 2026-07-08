import { VERSION_NEUTRAL, VersioningType } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({ origin: true, credentials: true });
  app.setGlobalPrefix("api");
  // URI versioning: domain modules are `version: '1'` → /api/v1/...
  // Existing routes (health, sync) have no version → stay at /api/... (VERSION_NEUTRAL).
  // Moving sync/health under v1 is a separate coordinated change (touches FE + tunnel health).
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: VERSION_NEUTRAL,
  });
  const port = Number(process.env.PORT) || 3000;
  await app.listen(port);
}
bootstrap();
