import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { ItemLookupService } from "./item-lookup.service";
import { LookupsController } from "./lookups.controller";
import { LookupsService } from "./lookups.service";

@Module({
  imports: [PrismaModule],
  controllers: [LookupsController],
  // `ItemLookupService` je izvezen jer isti račun treba i ekranu unosa i budućem
  // `POST /sales/price-preview` (§5.7) — da se pretraga artikala ne piše dvaput.
  providers: [LookupsService, ItemLookupService],
  exports: [ItemLookupService],
})
export class LookupsModule {}
