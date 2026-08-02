import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { ProjectsWriteController } from "./projects-write.controller";
import { CustomerRfqService } from "./customer-rfq.service";

/**
 * Zahtevi kupaca za ponudu (CustomerRfq) + ugašene write rute nad predmetima.
 *
 * ODLUKA VLASNIKA 26.07.2026: predmeti se otvaraju samo u BigBit-u, pa su
 * `ProjectsWriteService` i `ProjectNumberingService` OBRISANI (nema više 3.0
 * numeracije predmeta). Ime modula je zadržano jer i dalje drži `/api/v1/projects`
 * write rute — one sada samo odbijaju zahtev sa uputstvom (`directory/bigbit-owned.ts`).
 */
@Module({
  imports: [PrismaModule],
  controllers: [ProjectsWriteController],
  providers: [CustomerRfqService],
})
export class ProjectsWriteModule {}
