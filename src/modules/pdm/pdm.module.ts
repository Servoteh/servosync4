import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { PdmController } from "./pdm.controller";
import { PdmImportService } from "./pdm-import.service";
import { PdmService } from "./pdm.service";

@Module({
  imports: [PrismaModule],
  controllers: [PdmController],
  providers: [PdmService, PdmImportService],
})
export class PdmModule {}
