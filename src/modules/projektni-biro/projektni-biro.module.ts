import { Module } from "@nestjs/common";
import { ProjektniBiroController } from "./projektni-biro.controller";
import { ProjektniBiroService } from "./projektni-biro.service";

/** Projektni biro — 3.0 TALAS D (podaci u sy15 bazi — Sy15Module, globalan). */
@Module({
  controllers: [ProjektniBiroController],
  providers: [ProjektniBiroService],
})
export class ProjektniBiroModule {}
