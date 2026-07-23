import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { PostingModule } from "../gl/posting/posting.module";
import { BlagajnaController } from "./blagajna.controller";
import { BlagajnaService } from "./blagajna.service";

/**
 * Blagajna (gotovinski dnevnik) — XL modul. Auto-knjiženje uplatnica/isplatnica
 * kroz PostingEngine (blagajna ↔ protivkonto). PrismaModule je @Global.
 */
@Module({
  imports: [PrismaModule, PostingModule],
  controllers: [BlagajnaController],
  providers: [BlagajnaService],
  exports: [BlagajnaService],
})
export class BlagajnaModule {}
