import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import { ItemsService } from "./items.service";
import type { AuthUser } from "../auth/jwt.strategy";
import type { ListItemsQuery } from "./dto/list-items.dto";

/**
 * Matični podaci — Artikli (read-only pregled BigBit cache tabele `items`).
 *   GET /api/v1/artikli      — lista (q po nazivu/kat. broju/barkodu; groupCode, active)
 *   GET /api/v1/artikli/:id  — pun slog + razrešeni nazivi grupe/podgrupe/porekla
 *
 * `items` ima ~91k redova → paginacija je OBAVEZNA (`parsePagination`: default
 * pageSize 50, tvrdi max 200). Sort po kataloškom broju (ljudski ključ artikla).
 *
 * NEMA mutacija (BACKEND_RULES §3 — tabelu piše samo bigbit-sync), pa nema ni
 * `TODO(auth)` markera (§8 važi za mutirajuće rute).
 *
 * PERMISIJE — dvoslojno (odluka Nenad 29.07.2026):
 *   kapija rute  = `directory.read` (ISTI ključ kao `DirectoryController`/`LookupsController`
 *                  — isti domen podataka; širok read, praktično svaka SSO uloga);
 *   sloj kolona  = `masters.read` — komercijalne kolone (cene, marže, rabati, GK konta,
 *                  dobavljač, carine) vraća SAMO servis akteru koji taj ključ ima.
 * Kontroler zato prosleđuje `req.user` servisu; odluku donosi `masters-access.ts`
 * kroz isti `resolvePermissionDecision` koji koristi i `PermissionsGuard`.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.DIRECTORY_READ)
@Controller({ path: "artikli", version: "1" })
export class ItemsController {
  constructor(private readonly items: ItemsService) {}

  @Get()
  list(@Query() query: ListItemsQuery, @Req() req: { user?: AuthUser }) {
    return this.items.list(query, req.user);
  }

  @Get(":id")
  findOne(
    @Param("id", ParseIntPipe) id: number,
    @Req() req: { user?: AuthUser },
  ) {
    return this.items.findOne(id, req.user);
  }
}
