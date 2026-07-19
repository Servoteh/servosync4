import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { ProjectsWriteController } from "./projects-write.controller";
import { ProjectsWriteService } from "./projects-write.service";
import { CustomerRfqService } from "./customer-rfq.service";
import { ProjectNumberingService } from "./project-numbering.service";

/**
 * NACRT — modul write-path predmeti + CustomerRfq (Traka B §A). ODVOJEN od
 * read-only `directory` modula (koji ostaje netaknut). Zavisnost: PrismaModule.
 *
 * Aktivacija (kad CustomerRfq model bude u schema.prisma i N3 potvrđeno):
 *   1) preimenuj sve `*.ts.nacrt` → `*.ts` (i README u `README.md`)
 *   2) dodaj `ProjectsWriteModule` u app.module.ts imports
 *   3) dodaj PROJECTS_WRITE / RFQ_READ / RFQ_WRITE u src/common/authz/permissions.ts
 *      + role mapiranje (role-permissions.ts) + mirror u frontend/src/lib/permissions.ts
 */
@Module({
  imports: [PrismaModule],
  controllers: [ProjectsWriteController],
  providers: [
    ProjectsWriteService,
    CustomerRfqService,
    ProjectNumberingService,
  ],
})
export class ProjectsWriteModule {}
