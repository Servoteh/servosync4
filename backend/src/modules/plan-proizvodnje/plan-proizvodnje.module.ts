import { Module } from "@nestjs/common";
import { PdmModule } from "../pdm/pdm.module";
import { PlanProizvodnjeController } from "./plan-proizvodnje.controller";
import { PlanProizvodnjeService } from "./plan-proizvodnje.service";
import { PlanProizvodnjeReadService } from "./plan-proizvodnje-read.service";

/**
 * Plan proizvodnje — 3.0 TALAS C, F5b: sve na glavnoj bazi (PrismaModule je globalan),
 * bez sy15 mosta. Read (`PlanProizvodnjeReadService`) reimplementira sy15 view lanac;
 * write (`PlanProizvodnjeService`) piše app-owned `plan_proizvodnje_*` tabele.
 *
 * PdmModule (exports `PdmService`): read servis reuse-uje `getPdfContent` za strim
 * bigtehn (PDM) crteža pod `plan_proizvodnje.read` (skice su bytea u sopstvenoj tabeli).
 */
@Module({
  imports: [PdmModule],
  controllers: [PlanProizvodnjeController],
  providers: [PlanProizvodnjeService, PlanProizvodnjeReadService],
})
export class PlanProizvodnjeModule {}
