import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import { LookupsService } from "./lookups.service";

/**
 * Lookup-ovi za biranje iz liste:
 *   GET /api/v1/lookups/projects?q=   — predmeti (id, broj, naziv, komitent id + `customer {id, name}`)
 *   GET /api/v1/lookups/customers?q=  — komitenti (id, naziv, mesto, PIB)
 *
 * Permisija `directory.read` — ISTI ključ kao `DirectoryController`, jer je ovo ISTI
 * podatak (šifarnici Komitenti + Predmeti), samo u „lakom" obliku za ComboBox.
 *
 * ⚠️ Zašto je guard dodat (bezbednosni dug zatvoren 26.07, nalaz AI-1 review-a):
 * rute su tražile SAMO JWT, pa su bile ZAOBILAZNICA za `directory.read`. Najkonkretnije:
 * `proizvodni_radnik` NAMERNO nema `directory.read` (role-permissions.ts: „BEZ
 * directory.read — matrica §3: RADNIK nema komitente/predmete"), pa mu je
 * `GET /v1/directory/customers` vraćao 403 — ali mu je `GET /v1/lookups/customers`
 * uredno vraćao naziv/mesto/PIB komitenata. Ista rupa važila je i za `tehnicar_odrzavanja`
 * i za svaki `user_permission_overrides` deny na `directory.read`.
 *
 * Posledica po UI (svesna): filter „Za komitenta" na ekranu Radnih naloga sada je
 * skriven rolama bez `directory.read` (FE `can(...)` u `work-orders/page.tsx`) —
 * lista RN-ova ostaje puna, jer ona ide pod `rn.read`.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.DIRECTORY_READ)
@Controller({ path: "lookups", version: "1" })
export class LookupsController {
  constructor(private readonly lookups: LookupsService) {}

  @Get("projects")
  projects(@Query("q") q?: string) {
    return this.lookups.projects(q);
  }

  @Get("customers")
  customers(@Query("q") q?: string) {
    return this.lookups.customers(q);
  }
}
