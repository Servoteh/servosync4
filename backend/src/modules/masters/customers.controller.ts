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
import { MasterCustomersService } from "./customers.service";
import type { ListCustomersQuery } from "./dto/list-customers.dto";

/**
 * Matični podaci — Komitenti (read-only pregled BigBit cache tabele `customers`).
 *   GET /api/v1/komitenti      — lista (q po nazivu/PIB-u/mestu; codeTypeCode)
 *   GET /api/v1/komitenti/:id  — pun slog + vrsta šifre / prodavac / uplatni račun
 *
 * NEMA mutacija (BACKEND_RULES §3 — tabelu piše samo `customer.syncer.ts`), pa nema
 * ni `TODO(auth)` markera (§8 važi za mutirajuće rute).
 *
 * Permisija: `directory.read` — isti ključ kao `DirectoryController` (isti domen
 * podataka). ⚠️ SVESNO ODSTUPANJE od `directory`: matični karton vraća i komercijalne
 * kolone koje `directory` NAMERNO izostavlja (žiro računi, rabati, kreditni limit,
 * provizija, marža). `directory.read` je u `VIEWER_READ_BASELINE` (svaka SSO uloga
 * osim onih kojima je namerno uskraćen) — ako se te kolone budu smatrale užim
 * podatkom, uvodi se zaseban `masters.read` ključ i dodeljuje kuriranim ulogama
 * (odluka za Nenada/Nesu, nije stvar implementacije).
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.DIRECTORY_READ)
@Controller({ path: "komitenti", version: "1" })
export class MasterCustomersController {
  constructor(private readonly customers: MasterCustomersService) {}

  @Get()
  list(@Query() query: ListCustomersQuery) {
    return this.customers.list(query);
  }

  @Get(":id")
  findOne(@Param("id", ParseIntPipe) id: number) {
    return this.customers.findOne(id);
  }
}
