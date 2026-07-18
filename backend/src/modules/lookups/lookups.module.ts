import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { LookupsController } from "./lookups.controller";
import { LookupsService } from "./lookups.service";

@Module({
  imports: [PrismaModule],
  controllers: [LookupsController],
  providers: [LookupsService],
})
export class LookupsModule {}
