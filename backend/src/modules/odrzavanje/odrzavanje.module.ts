import { Module } from "@nestjs/common";
import { OdrzavanjeController } from "./odrzavanje.controller";
import { OdrzavanjeService } from "./odrzavanje.service";

/** Održavanje (CMMS) — 3.0 TALAS F; podaci u sy15 (1.0) bazi (Sy15Module, doktrina §A.1). */
@Module({
  controllers: [OdrzavanjeController],
  providers: [OdrzavanjeService],
})
export class OdrzavanjeModule {}
