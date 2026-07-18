import { Module } from "@nestjs/common";
import { PracenjeController } from "./pracenje.controller";
import { PracenjeService } from "./pracenje.service";

/** Praćenje proizvodnje — 3.0 TALAS C (podaci u sy15 bazi — Sy15Module, globalan). */
@Module({
  controllers: [PracenjeController],
  providers: [PracenjeService],
})
export class PracenjeModule {}
