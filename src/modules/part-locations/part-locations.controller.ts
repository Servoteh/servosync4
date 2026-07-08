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
import { PartLocationsService } from "./part-locations.service";
import type { ListPartLocationsQuery } from "./part-locations.service";

/**
 * Lokacije napravljenih delova (MODULE_SPEC_lokacije §1/§5, Was: tLokacijeDelova) —
 * READ-ONLY ovog talasa.
 *   GET /api/v1/part-locations                    — pregled/pretraga
 *       (q — RN/predmet/pozicija; workOrderId, projectId, positionId, workerId,
 *        qualityTypeId — tačni filteri; paginacija)
 *   GET /api/v1/part-locations/card/:workOrderId   — kartica RN: ledger istorija
 *       svih zapisa + zbir po poziciji + ukupno (napomena o smeru u meta.note)
 *
 * Transfer/trebovanje (ledger-WRITE, `part_location_movements`) je van ovog talasa —
 * MODULE_SPEC_lokacije §7.1/§11 + preklapanje sa ServoSync 1.0 (§8).
 * Traži JWT; permisija LOKACIJE_READ (V1 no-op guard, V2 aktivacija).
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.LOKACIJE_READ)
@Controller({ path: "part-locations", version: "1" })
export class PartLocationsController {
  constructor(private readonly partLocations: PartLocationsService) {}

  @Get()
  list(@Query() query: ListPartLocationsQuery) {
    return this.partLocations.list(query);
  }

  @Get("card/:workOrderId")
  card(@Param("workOrderId", ParseIntPipe) workOrderId: number) {
    return this.partLocations.card(workOrderId);
  }
}
