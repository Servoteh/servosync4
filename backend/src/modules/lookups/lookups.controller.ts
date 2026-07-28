import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { ItemLookupService } from "./item-lookup.service";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import { LookupsService } from "./lookups.service";

/**
 * Lookup-ovi za biranje iz liste:
 *   GET /api/v1/lookups/projects?q=   — predmeti (id, broj, naziv, komitent id + `customer {id, name}`)
 *   GET /api/v1/lookups/customers?q=  — komitenti (id, naziv, mesto, PIB)
 *   GET /api/v1/lookups/warehouses?q= — magacini (id, naziv, mesto, vrsta)
 *   GET /api/v1/lookups/items?q=&key= — artikli (+ zalihe ako se da `warehouseId`)
 *
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
 *
 * ⚠️ ARTIKLI DELE ISTI GUARD, A NISU ISTI PODATAK (spajanje 28.07.2026).
 * Ruta `items` je pisana pre nego što je guard stigao, uz obrazloženje „isto kao
 * tri postojeće rute" — a te tri su u međuvremenu zaključane. Guard ostaje na CELOM
 * kontroleru: uže pravo se uvek sme dodati kasnije, a propuštena provera se primeti
 * tek kad neko vidi tuđe podatke. Posledica koju treba imati na umu: uloga bez
 * `directory.read` (magacioner, proizvodni radnik) ne može da pretražuje šifarnik
 * artikala, pa robni unos za magacionera ostaje otvoren dok se ne odluči da li
 * artiklima treba sopstveni ključ.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.DIRECTORY_READ)
@Controller({ path: "lookups", version: "1" })
export class LookupsController {
  constructor(
    private readonly lookups: LookupsService,
    private readonly itemLookup: ItemLookupService,
  ) {}

  @Get("projects")
  projects(@Query("q") q?: string) {
    return this.lookups.projects(q);
  }

  @Get("customers")
  customers(@Query("q") q?: string) {
    return this.lookups.customers(q);
  }

  @Get("warehouses")
  warehouses(@Query("q") q?: string) {
    return this.lookups.warehouses(q);
  }

  /**
   * Pretraga artikala za `CodeCombo` (PLAN_UNOS_DOKUMENATA.md §2.4/§5.7).
   *
   * @param q      tekst pretrage; ispod 2 znaka vraća praznu listu (ne šifarnik)
   * @param key    `CATALOG | BARCODE | EXT | NAME | PLU` (podrazumevano CATALOG)
   * @param warehouseId  ako se da — uz svaki artikal ide i raspoloživa količina
   * @param limit  podrazumevano 20, najviše 50
   * @param includeInactive `"true"` = i neaktivni artikli (obrisani nikad)
   */
  @Get("items")
  items(
    @Query("q") q?: string,
    @Query("key") key?: string,
    @Query("warehouseId") warehouseId?: string,
    @Query("limit") limit?: string,
    @Query("includeInactive") includeInactive?: string,
  ) {
    return this.itemLookup.search({
      q,
      key,
      warehouseId,
      limit,
      includeInactive,
    });
  }
}
