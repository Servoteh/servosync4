import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { ItemLookupService } from "./item-lookup.service";
import { LookupsService } from "./lookups.service";

/**
 * Lookup-ovi za biranje iz liste:
 *   GET /api/v1/lookups/projects?q=   — predmeti (id, broj, naziv, komitent id + `customer {id, name}`)
 *   GET /api/v1/lookups/customers?q=  — komitenti (id, naziv, mesto, PIB)
 *   GET /api/v1/lookups/warehouses?q= — magacini (id, naziv, mesto, vrsta)
 *   GET /api/v1/lookups/items?q=&key= — artikli (+ zalihe ako se da `warehouseId`)
 *
 * Zaštita: `JwtAuthGuard` bez dodatnih permisija — isto kao tri postojeće rute.
 * Šifarnik artikala nije osetljiviji od šifarnika komitenata, a ekran unosa
 * dokumenata koriste i uloge bez `robno.read` (v. komentar uz `warehouses`).
 */
@UseGuards(JwtAuthGuard)
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
