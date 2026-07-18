import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { PdmController } from "./pdm.controller";
import { PdmImportService } from "./pdm-import.service";
import { PdmService } from "./pdm.service";

@Module({
  imports: [PrismaModule],
  controllers: [PdmController],
  providers: [PdmService, PdmImportService],
  // PdmService se deli sa TechProcessesModule (kiosk PDF ruta pod TEHNOLOGIJA_READ).
  exports: [PdmService],
})
export class PdmModule {}
