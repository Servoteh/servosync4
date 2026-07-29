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
import { MasterCustomersService } from "./customers.service";
import type { AuthUser } from "../auth/jwt.strategy";
import type { ListCustomersQuery } from "./dto/list-customers.dto";

/**
 * Matični podaci — Komitenti (read-only pregled BigBit cache tabele `customers`).
 *   GET /api/v1/komitenti      — lista (q po nazivu/PIB-u/mestu; codeTypeCode)
 *   GET /api/v1/komitenti/:id  — pun slog + vrsta šifre / prodavac / uplatni račun
 *
 * NEMA mutacija (BACKEND_RULES §3 — tabelu piše samo `customer.syncer.ts`), pa nema
 * ni `TODO(auth)` markera (§8 važi za mutirajuće rute).
 *
 * PERMISIJE — dvoslojno (odluka Nenad 29.07.2026; ranije je ceo karton stajao samo
 * na `directory.read`, što je bilo šire od `directory` pregleda):
 *   kapija rute  = `directory.read` — isti ključ kao `DirectoryController` (isti domen
 *                  podataka); u `VIEWER_READ_BASELINE`, dakle svaka SSO uloga;
 *   sloj kolona  = `masters.read` — žiro/uplatni računi, rabati, provizija, marža,
 *                  kreditni limit, cenovnik, uslovi plaćanja i audit izlaze SAMO uz
 *                  ovaj ključ. Bez njega karton vraća isti bezbedan podskup koji
 *                  `directory.service.ts` (CUSTOMER_BUSINESS_SELECT) ionako prikazuje.
 * Kontroler zato prosleđuje `req.user` servisu; odluku donosi `masters-access.ts`
 * kroz isti `resolvePermissionDecision` koji koristi i `PermissionsGuard`.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.DIRECTORY_READ)
@Controller({ path: "komitenti", version: "1" })
export class MasterCustomersController {
  constructor(private readonly customers: MasterCustomersService) {}

  @Get()
  list(@Query() query: ListCustomersQuery, @Req() req: { user?: AuthUser }) {
    return this.customers.list(query, req.user);
  }

  @Get(":id")
  findOne(
    @Param("id", ParseIntPipe) id: number,
    @Req() req: { user?: AuthUser },
  ) {
    return this.customers.findOne(id, req.user);
  }
}
