import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { CncProgramsController } from "./cnc-programs.controller";
import { CncProgramsService } from "./cnc-programs.service";

/**
 * CAM / CNC programiranje (Miljan t.7, ODLUKE #8). Pregled pozicija koje
 * zahtevaju CAM (ruting sa `operations.usesPriority=true`) + čekiranje „CAM
 * završen" sa auditom. Registrovan u `app.module.ts` (imports).
 */
@Module({
  imports: [PrismaModule],
  controllers: [CncProgramsController],
  providers: [CncProgramsService],
})
export class CncProgramsModule {}
