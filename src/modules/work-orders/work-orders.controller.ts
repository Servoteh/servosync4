import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import type { AuthUser } from "../auth/jwt.strategy";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import { WorkOrdersService } from "./work-orders.service";
import type {
  ListWorkOrdersQuery,
  ListOperationQueueQuery,
} from "./work-orders.service";
import { WorkOrderPrintService } from "./work-order-print.service";
import type { RnPrintVariant } from "./work-order-print.service";
import type { CreateWorkOrderDto } from "./dto/create-work-order.dto";
import type { ReworkWorkOrderDto } from "./dto/rework-work-order.dto";
import type { BulkCloneWorkOrdersDto } from "./dto/bulk-clone-work-orders.dto";
import type { UpdateWorkOrderDto } from "./dto/update-work-order.dto";
import type {
  CreateWorkOrderOperationDto,
  UpdateWorkOrderOperationDto,
} from "./dto/work-order-operation.dto";

/**
 * API za radne naloge (Radni nalozi / RN).
 *   GET  /api/v1/work-orders            — lista (filteri: q, statusId, projectId, workerId, customerId, from, to)
 *   GET  /api/v1/work-orders/:id        — detalj (operacije, sve stavke, odobravanja, lansiranja)
 *   POST /api/v1/work-orders            — kreiranje (ručno; server generiše broj)
 *   POST /api/v1/work-orders/:id/approve  { approve?: boolean }  — odobri/odbij
 *   POST /api/v1/work-orders/:id/launch                          — lansiraj (mora biti saglasan)
 *   POST /api/v1/work-orders/:id/lock     { locked?: boolean }   — zaključaj/otključaj
 *   POST /api/v1/work-orders/:id/copy-from/:sourceId             — kopiraj stavke u prazan cilj (RN_WRITE)
 *   POST /api/v1/work-orders/:id/clone-variant                   — „Prepiši isti postupak": klon kao sledeća varijanta (RN_WRITE)
 *   POST /api/v1/work-orders/:id/rework   { pieceCount, qualityTypeId, note? } — dorada/škart child (RN_WRITE)
 *   POST /api/v1/work-orders/projects/:projectId/bulk-clone { targetProjectId, coefficient, workOrderIds? } — bulk-clone (RN_WRITE)
 *   PATCH /api/v1/work-orders/operations/:opId/priority { priority } — CAM prioritet (TEHNOLOGIJA_WRITE)
 *
 * Traži JWT. Mutacije nose `@RequirePermission`: create/lock/copy/clone/rework = `rn.write`,
 * approve = `rn.approve`, launch = `rn.launch`, prioritet operacije = `tehnologija.write`
 * (CNC programer nema `rn.write`). Guard je shadow-mode (V1). Drugi gate za
 * approve/launch (`Worker.definesApproval`/`definesLaunch`) je V2 u servisu — TODO(auth) u servisu.
 */
@UseGuards(JwtAuthGuard)
@Controller({ path: "work-orders", version: "1" })
export class WorkOrdersController {
  constructor(
    private readonly workOrders: WorkOrdersService,
    private readonly printService: WorkOrderPrintService,
  ) {}

  @Get()
  list(@Query() query: ListWorkOrdersQuery) {
    return this.workOrders.list(query);
  }

  /** Planska tabla operacija po prioritetu (QBigTehn „Prioritet"). Mora pre `:id`. */
  @Get("operations/queue")
  operationQueue(@Query() query: ListOperationQueueQuery) {
    return this.workOrders.operationQueue(query);
  }

  @Get(":id")
  findOne(@Param("id", ParseIntPipe) id: number) {
    return this.workOrders.findOne(id);
  }

  /**
   * Štampa RN dokumenta (PDF) — legacy `rRN`: RNZ zaglavlje + `S` barkod po operaciji,
   * sva polja nose `revision`. `?variant=bez-barkoda` izostavlja barkodove.
   */
  @Get(":id/print")
  async print(
    @Param("id", ParseIntPipe) id: number,
    @Query("variant") variant: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const v: RnPrintVariant = variant === "bez-barkoda" ? "bez-barkoda" : "std";
    const { buffer, fileName } = await this.printService.buildRnPdf(id, v);
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${fileName}"`,
    });
    return new StreamableFile(buffer);
  }

  @Post()
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(PERMISSIONS.RN_WRITE)
  create(@Body() dto: CreateWorkOrderDto, @Req() req: { user: AuthUser }) {
    return this.workOrders.create(dto, req.user);
  }

  /** Izmena zaglavlja RN-a (samo poslata polja; identitet se ne menja). */
  @Patch(":id")
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(PERMISSIONS.RN_WRITE)
  updateHeader(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateWorkOrderDto,
  ) {
    return this.workOrders.updateHeader(id, dto);
  }

  /** Dodaj operaciju TP na RN (RC + norme Tpz/Tk + opis + prioritet). Autor stavke = JWT radnik ako DTO ne kaže drugačije. */
  @Post(":id/operations")
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(PERMISSIONS.RN_WRITE)
  addOperation(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: CreateWorkOrderOperationDto,
    @Req() req: { user: AuthUser },
  ) {
    return this.workOrders.addOperation(id, dto, req.user);
  }

  /** Izmena operacije RN-a. */
  @Patch(":id/operations/:opId")
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(PERMISSIONS.RN_WRITE)
  updateOperation(
    @Param("id", ParseIntPipe) id: number,
    @Param("opId", ParseIntPipe) opId: number,
    @Body() dto: UpdateWorkOrderOperationDto,
  ) {
    return this.workOrders.updateOperation(id, opId, dto);
  }

  /**
   * CAM prioritet operacije (planska tabla „Operacije po prioritetu"). Namerno
   * iza `tehnologija.write` (ne `rn.write`) — CNC programer prioritizuje, a
   * nema pravo izmene RN-a. Dozvoljeno i na lansiranom RN-u; zaključan → 422.
   */
  @Patch("operations/:opId/priority")
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(PERMISSIONS.TEHNOLOGIJA_WRITE)
  setOperationPriority(
    @Param("opId", ParseIntPipe) opId: number,
    @Body() body: { priority?: number },
  ) {
    return this.workOrders.setOperationPriority(opId, body?.priority as number);
  }

  /** Brisanje operacije RN-a. */
  @Delete(":id/operations/:opId")
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(PERMISSIONS.RN_WRITE)
  deleteOperation(
    @Param("id", ParseIntPipe) id: number,
    @Param("opId", ParseIntPipe) opId: number,
  ) {
    return this.workOrders.deleteOperation(id, opId);
  }

  /** Brisanje kompletnog RN-a (cascade). Guard: zaključan / evidentiran rad. */
  @Delete(":id")
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(PERMISSIONS.RN_WRITE)
  remove(@Param("id", ParseIntPipe) id: number) {
    return this.workOrders.remove(id);
  }

  /**
   * „Prinudno obriši" RN — briše RN I evidenciju rada (prijave/kucanja) i
   * zaobilazi lock guard. Samo admin/šef (`rn.delete.force`).
   */
  @Delete(":id/force")
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(PERMISSIONS.RN_DELETE_FORCE)
  forceRemove(@Param("id", ParseIntPipe) id: number) {
    return this.workOrders.forceRemove(id);
  }

  /** Odobri/odbij RN. Permisija `rn.approve`; drugi gate (Worker.definesApproval) je V2 u servisu. */
  @Post(":id/approve")
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(PERMISSIONS.RN_APPROVE)
  approve(
    @Param("id", ParseIntPipe) id: number,
    @Body() body: { approve?: boolean },
    @Req() req: { user: AuthUser },
  ) {
    return this.workOrders.approve(id, body?.approve !== false, req.user);
  }

  /**
   * Lansiraj RN. Permisija `rn.launch`; drugi gate (Worker.definesLaunch) je V2 u servisu.
   * Ako je RN vezan za primopredaju, i ona ide na LANSIRAN (ista transakcija).
   */
  @Post(":id/launch")
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(PERMISSIONS.RN_LAUNCH)
  launch(
    @Param("id", ParseIntPipe) id: number,
    @Req() req: { user: AuthUser },
  ) {
    return this.workOrders.launch(id, req.user);
  }

  @Post(":id/lock")
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(PERMISSIONS.RN_WRITE)
  lock(
    @Param("id", ParseIntPipe) id: number,
    @Body() body: { locked?: boolean },
  ) {
    return this.workOrders.setLock(id, body?.locked !== false);
  }

  /** Kopiraj sve 4 vrste stavki iz `sourceId` u prazan `id` (cilj ne sme biti zaključan/lansiran). */
  @Post(":id/copy-from/:sourceId")
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(PERMISSIONS.RN_WRITE)
  copyFrom(
    @Param("id", ParseIntPipe) id: number,
    @Param("sourceId", ParseIntPipe) sourceId: number,
  ) {
    return this.workOrders.copyFrom(id, sourceId);
  }

  /**
   * „Prepiši isti postupak": klon RN-a kao NOVI red sa istim identom i
   * `variant = MAX+1` po (predmet, crtež, revizija). Vraća
   * `{ data: { workOrderId, identNumber, variant } }`.
   */
  @Post(":id/clone-variant")
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(PERMISSIONS.RN_WRITE)
  cloneVariant(@Param("id", ParseIntPipe) id: number) {
    return this.workOrders.cloneVariant(id);
  }

  /** DORADA/ŠKART: kreiraj child RN iz `id` (sufiks -D/-S, kopira zaglavlje + sve stavke). */
  @Post(":id/rework")
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(PERMISSIONS.RN_WRITE)
  rework(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: ReworkWorkOrderDto,
  ) {
    return this.workOrders.rework(id, dto);
  }

  /** Bulk-clone svih (ili izabranih) naloga predmeta `projectId` u nov prazan predmet. */
  @Post("projects/:projectId/bulk-clone")
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(PERMISSIONS.RN_WRITE)
  bulkClone(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() dto: BulkCloneWorkOrdersDto,
  ) {
    return this.workOrders.bulkClone(projectId, dto);
  }
}
