import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import { CncProgramsService } from "./cnc-programs.service";
import type { ListCncProgramsQuery } from "./cnc-programs.service";
import type { SetCncProgramDoneDto } from "./dto/set-cnc-program-done.dto";
import type { MoveCncQueueDto } from "./dto/move-cnc-queue.dto";
import type { AuthUser } from "../auth/jwt.strategy";

/**
 * CAM / CNC programiranje (Miljan t.7, ODLUKE #8 + #35).
 *   GET   /api/v1/cnc-programs               — pozicije koje zahtevaju CAM
 *         (RN sa operacijom `usesPriority=true`, nezavršen) + CAM status;
 *         filteri q, onlyPending; paginacija.
 *   PATCH /api/v1/cnc-programs/:workOrderId  { isDone, note? } — čekiraj „CAM
 *         završen" (upis audita ko/kada iz JWT-a), idempotentno.
 *
 * Read=tehnologija.read, write=tehnologija.write (rola `cnc_programer` ih ima;
 * NE dira RN pa ne traži `rn.write` — isti princip kao CAM prioritet operacije).
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.TEHNOLOGIJA_READ)
@Controller({ path: "cnc-programs", version: "1" })
export class CncProgramsController {
  constructor(private readonly cncPrograms: CncProgramsService) {}

  @Get()
  list(@Query() query: ListCncProgramsQuery) {
    return this.cncPrograms.list(query);
  }

  /**
   * Redosled CAM reda (prevlačenje). Statičniji segment `:workOrderId/queue`
   * MORA biti iznad `:workOrderId` da Nest ruter ne bi „posenčio" ovu rutu.
   * Gate: NOVA permisija `tehnologija.cam_prioritet` (imenovani tehnolozi preko
   * grant-a; `tehnologija.write` je preširok — ima ga i cnc_programer).
   */
  @Patch(":workOrderId/queue")
  @RequirePermission(PERMISSIONS.CAM_PRIORITET)
  moveInQueue(
    @Param("workOrderId", ParseIntPipe) workOrderId: number,
    @Body() dto: MoveCncQueueDto,
    @Req() req: { user: AuthUser },
  ) {
    return this.cncPrograms.moveInQueue(workOrderId, dto, req.user);
  }

  @Patch(":workOrderId")
  @RequirePermission(PERMISSIONS.TEHNOLOGIJA_WRITE)
  setDone(
    @Param("workOrderId", ParseIntPipe) workOrderId: number,
    @Body() dto: SetCncProgramDoneDto,
    @Req() req: { user: AuthUser },
  ) {
    return this.cncPrograms.setDone(workOrderId, dto, req.user);
  }
}
