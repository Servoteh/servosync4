import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { DirectoryController } from "./directory.controller";
import { DirectoryService } from "./directory.service";

@Module({
  imports: [PrismaModule],
  controllers: [DirectoryController],
  providers: [DirectoryService],
})
export class DirectoryModule {}
