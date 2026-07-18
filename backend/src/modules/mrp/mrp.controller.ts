import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import { MrpService } from "./mrp.service";
import type {
  ListDemandItemsQuery,
  ListDemandsQuery,
  ListStockQuery,
} from "./mrp.service";

/**
 * MRP / Nabavka — SAMO UVID (MODULE_SPEC_mrp.md).
 * BOM eksplozija i planiranje (POST/mutacije) su BLOKIRANI dok BACKEND_RULES §11.3
 * (BOM/MRP logika) ne bude dizajnirana i potvrđena — ovaj kontroler ima samo GET.
 *
 *   GET /api/v1/mrp/demands           — lista potreba (filteri: q, status, projectId, workerId, from, to)
 *   GET /api/v1/mrp/demands/:id       — detalj potrebe + stavke (rešene FK, slobodne zalihe po stavci)
 *   GET /api/v1/mrp/stock             — snapshot zaliha (mrp_item_stock; pretraga po artiklu)
 *   GET /api/v1/mrp/demand-items      — agregirani pregled stavki svih potreba (filteri: demandId, projectId, itemId, itemStatus, q)
 *
 * Traži JWT; permisija `mrp.read` (V1 no-op guard, V2 aktivacija).
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.MRP_READ)
@Controller({ path: "mrp", version: "1" })
export class MrpController {
  constructor(private readonly mrp: MrpService) {}

  @Get("demands")
  listDemands(@Query() query: ListDemandsQuery) {
    return this.mrp.listDemands(query);
  }

  @Get("demands/:id")
  findDemand(@Param("id", ParseIntPipe) id: number) {
    return this.mrp.findOneDemand(id);
  }

  @Get("stock")
  listStock(@Query() query: ListStockQuery) {
    return this.mrp.listStock(query);
  }

  @Get("demand-items")
  listDemandItems(@Query() query: ListDemandItemsQuery) {
    return this.mrp.listDemandItems(query);
  }
}
