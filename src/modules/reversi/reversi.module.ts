import { Module } from "@nestjs/common";
import { ReversiController } from "./reversi.controller";
import { ReversiService } from "./reversi.service";

/** Reversi — prvi 3.0 pilot modul na 2.0 stacku (podaci u sy15 bazi — Sy15Module). */
@Module({
  controllers: [ReversiController],
  providers: [ReversiService],
})
export class ReversiModule {}
