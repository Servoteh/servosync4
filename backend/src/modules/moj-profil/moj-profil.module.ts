import { Module } from "@nestjs/common";
import { MojProfilController } from "./moj-profil.controller";
import { MojProfilService } from "./moj-profil.service";
import { SchedulerModule } from "../scheduler/scheduler.module";

/** Moj profil — 3.0 TALAS D, agregator kroz GUC (podaci u sy15 bazi — Sy15Module, globalan).
 *  SchedulerModule → NotifyDispatchService: puls outboxa posle mutacije ide kroz
 *  3.0 dispečer, ne kroz 1.0 edge (AUDIT-K3). */
@Module({
  imports: [SchedulerModule],
  controllers: [MojProfilController],
  providers: [MojProfilService],
})
export class MojProfilModule {}
