import { Module } from "@nestjs/common";
import { MojProfilController } from "./moj-profil.controller";
import { MojProfilService } from "./moj-profil.service";

/** Moj profil — 3.0 TALAS D, agregator kroz GUC (podaci u sy15 bazi — Sy15Module, globalan). */
@Module({
  controllers: [MojProfilController],
  providers: [MojProfilService],
})
export class MojProfilModule {}
