import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { MrpController } from "./mrp.controller";
import { MrpService } from "./mrp.service";

/**
 * MRP / Nabavka (MODULE_SPEC_mrp.md) — READ-ONLY uvid u v1.
 * BOM eksplozija i planiranje (mrp_plans/_items, purchase_requests) čekaju
 * BACKEND_RULES §11.3 (BOM/MRP logika u dizajnu, nije reverse-eng iz legacy-ja).
 *
 * Registracija u `app.module.ts` je posao integratora (dodati `MrpModule` u `imports`).
 */
@Module({
  imports: [PrismaModule],
  controllers: [MrpController],
  providers: [MrpService],
})
export class MrpModule {}
