import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { TechProcessesController } from "./tech-processes.controller";
import { TechProcessesService } from "./tech-processes.service";

@Module({
  imports: [PrismaModule],
  controllers: [TechProcessesController],
  providers: [TechProcessesService],
})
export class TechProcessesModule {}
