import { Module } from "@nestjs/common";
import { SalesModule } from "./sales.module";
import { PricingController } from "./pricing.controller";

/**
 * Ruta cenovnog motora — `POST /api/v1/sales/price-preview` (§5.7).
 *
 * Zaseban modul, a ne novi kontroler u `SalesModule`, da ovaj paket ne dira tuđe fajlove
 * (`sales.module.ts` / `sales.controller.ts`). `PricingService` se NE provajduje ponovo —
 * uzima se iz `SalesModule` (koji ga izvozi), pa u aplikaciji ostaje JEDNA instanca.
 * Jednosmerno Pricing→Sales, bez ciklusa.
 *
 * Ako vlasnik `sales` paketa više voli jedan modul: dovoljno je dodati `PricingController`
 * u `SalesModule.controllers` i obrisati ovaj fajl — kontroler se ne menja.
 */
@Module({
  imports: [SalesModule],
  controllers: [PricingController],
})
export class PricingModule {}
