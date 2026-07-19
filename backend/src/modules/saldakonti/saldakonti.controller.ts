import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import type { AuthUser } from "../auth/jwt.strategy";
import { OpenItemsService } from "./open-items.service";
import { ReconciliationService } from "./reconciliation.service";
import { CompensationService } from "./compensation.service";
import {
  type ListOpenItemsQuery,
  type AgingQuery,
  type ReconcileDto,
  type UnreconcileDto,
  type CreateCompensationDto,
  validateReconcileDto,
  validateUnreconcileDto,
} from "./dto/saldakonti.dto";

/**
 * Saldakonti — otvorene stavke / aging / uparivanje / kompenzacija (Faza 4 §A).
 *   GET  /api/v1/saldakonti/open-items        — otvorene stavke (accountCode?, partnerId?, asOf?)
 *   GET  /api/v1/saldakonti/aging             — aging po komitentu (accountCode?, asOf?)
 *   POST /api/v1/saldakonti/reconcile         — uparivanje (auto|manual) datih stavki
 *   POST /api/v1/saldakonti/reconcile/unreconcile — razveži grupu (role-gated)
 *   POST /api/v1/saldakonti/compensation      — kreiranje kompenzacije (bilateralni bilans)
 *   GET  /api/v1/saldakonti/compensation/proposal — predlog kompenzacije iz otvorenih stavki
 *
 * JWT + PermissionsGuard. read = SALDAKONTI_READ; sve mutacije (uparivanje,
 * razvezivanje, kompenzacija) = SALDAKONTI_RECONCILE (write nad zatvaranjem GK).
 * Manual reconcile i unreconcile su namerno pod istim RECONCILE ključem — to je
 * write-težina; finija podela (npr. poseban ključ za unreconcile) je stvar
 * role-permissions dodele pri aktivaciji, ne novog ključa.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.SALDAKONTI_READ)
@Controller({ path: "saldakonti", version: "1" })
export class SaldakontiController {
  constructor(
    private readonly openItems: OpenItemsService,
    private readonly reconciliation: ReconciliationService,
    private readonly compensation: CompensationService,
  ) {}

  @Get("open-items")
  async listOpenItems(@Query() query: ListOpenItemsQuery) {
    const partnerId = parseOptionalInt(query.partnerId);
    const asOf = parseOptionalDate(query.asOf);
    const data = await this.openItems.listOpenItems(
      query.accountCode,
      partnerId,
      asOf,
    );
    return { data, meta: { count: data.length } };
  }

  @Get("aging")
  async aging(@Query() query: AgingQuery) {
    const asOf = parseOptionalDate(query.asOf);
    const data = await this.openItems.agingByPartner(query.accountCode, asOf);
    return { data, meta: { count: data.length } };
  }

  @Post("reconcile")
  @RequirePermission(PERMISSIONS.SALDAKONTI_RECONCILE)
  async reconcile(
    @Body() dto: ReconcileDto,
    @Req() req: { user: AuthUser },
  ) {
    validateReconcileDto(dto);
    const data =
      dto.mode === "manual"
        ? await this.reconciliation.manualReconcile(
            dto.entryIds,
            req.user.userId,
            dto.note,
          )
        : await this.reconciliation.autoReconcile(
            dto.entryIds,
            req.user.userId,
            dto.note,
          );
    return { data };
  }

  @Post("reconcile/unreconcile")
  @RequirePermission(PERMISSIONS.SALDAKONTI_RECONCILE)
  async unreconcile(@Body() dto: UnreconcileDto) {
    validateUnreconcileDto(dto);
    const data = await this.reconciliation.unreconcile(dto.groupId);
    return { data };
  }

  @Get("compensation/proposal")
  async compensationProposal(@Query("partnerId") partnerId?: string) {
    const id = parseOptionalInt(partnerId);
    if (id == null) {
      return { data: null, meta: { error: "partnerId je obavezan." } };
    }
    const data = await this.compensation.buildFromOpenItems(id);
    return { data };
  }

  @Post("compensation")
  @RequirePermission(PERMISSIONS.SALDAKONTI_RECONCILE)
  async createCompensation(
    @Body() dto: CreateCompensationDto,
    @Req() req: { user: AuthUser },
  ) {
    const data = await this.compensation.create(dto, req.user.userId);
    return { data };
  }
}

function parseOptionalInt(v?: string): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function parseOptionalDate(v?: string): Date | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}
