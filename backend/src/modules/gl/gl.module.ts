import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { GlController } from "./gl.controller";
import { GlReadService } from "./gl-read.service";

/**
 * Glavna knjiga (Faza 2) — READ sloj: dnevnik naloga + kartica konta.
 * Knjiženje je u PostingModule (gl/posting); ovaj modul samo čita ledger_entries.
 */
@Module({
  imports: [PrismaModule],
  controllers: [GlController],
  providers: [GlReadService],
  exports: [GlReadService],
})
export class GlModule {}
