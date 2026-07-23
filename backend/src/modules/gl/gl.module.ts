import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { PostingModule } from "./posting/posting.module";
import { GlController } from "./gl.controller";
import { GlReadService } from "./gl-read.service";
import { GlWriteService } from "./gl-write.service";

/**
 * Glavna knjiga (Faza 2) — READ (dnevnik/kartica konta/kontni plan) + WRITE
 * (ručni unos naloga/temeljnica, proknjiži/zaključaj/storno). Knjižni motor je
 * PostingModule (postManualEntry, numeracija); ovaj modul ga koristi za write.
 */
@Module({
  imports: [PrismaModule, PostingModule],
  controllers: [GlController],
  providers: [GlReadService, GlWriteService],
  exports: [GlReadService, GlWriteService],
})
export class GlModule {}
