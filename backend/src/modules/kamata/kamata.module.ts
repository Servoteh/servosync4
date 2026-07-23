import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { KamataController } from "./kamata.controller";
import { KamataService } from "./kamata.service";

/**
 * Kamata (obračun zatezne kamate) — XL modul. Registar stopa + obračun nad
 * otvorenim dospelim stavkama. PrismaModule je @Global.
 */
@Module({
  imports: [PrismaModule],
  controllers: [KamataController],
  providers: [KamataService],
  exports: [KamataService],
})
export class KamataModule {}
