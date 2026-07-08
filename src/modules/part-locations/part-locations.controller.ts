import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import { PartLocationsService } from "./part-locations.service";
import type { ListPartLocationsQuery } from "./part-locations.service";
import type {
  CreatePartLocationDto,
  RequisitionPartLocationDto,
  TransferPartLocationDto,
} from "./dto/part-location.dto";

/**
 * Lokacije napravljenih delova (MODULE_SPEC_lokacije §1/§5, Was: tLokacijeDelova) —
 * READ + ledger-WRITE. `part_locations` je LEDGER sa PREDZNAKOM (postavljanje=+qty,
 * uklanjanje=−qty; neto stanje = SUM(quantity)).
 *   GET  /api/v1/part-locations                    — pregled/pretraga
 *        (q — RN/predmet/pozicija; workOrderId, projectId, positionId, workerId,
 *         qualityTypeId — tačni filteri; paginacija)
 *   GET  /api/v1/part-locations/card/:workOrderId  — kartica RN: ledger istorija
 *        + NETO stanje po poziciji i ukupno (konvencija predznaka u meta.note)
 *   POST /api/v1/part-locations                    — unos lokacije (+qty)
 *   POST /api/v1/part-locations/transfer           — prenos (−qty izvor / +qty cilj, transakcija)
 *   POST /api/v1/part-locations/requisition        — trebovanje (−qty, transakcija)
 *
 * Eksplicitan `part_location_movements` (movement_type) i dvosmerni sync ka
 * QBigTehn-u (§8) su i dalje van obima — čekaju §11.
 * Traži JWT; read=LOKACIJE_READ, mutacije=LOKACIJE_WRITE (V1 no-op guard, V2 aktivacija).
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

  @Post()
  @RequirePermission(PERMISSIONS.LOKACIJE_WRITE)
  create(@Body() dto: CreatePartLocationDto) {
    return this.partLocations.create(dto);
  }

  @Post("transfer")
  @RequirePermission(PERMISSIONS.LOKACIJE_WRITE)
  transfer(@Body() dto: TransferPartLocationDto) {
    return this.partLocations.transfer(dto);
  }

  @Post("requisition")
  @RequirePermission(PERMISSIONS.LOKACIJE_WRITE)
  requisition(@Body() dto: RequisitionPartLocationDto) {
    return this.partLocations.requisition(dto);
  }
}
