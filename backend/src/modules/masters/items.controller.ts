import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import { ItemsService } from "./items.service";
import type { ListItemsQuery } from "./dto/list-items.dto";
import type { CreateItemDto, UpdateItemDto } from "./dto/upsert-item.dto";
import type { AuthUser } from "../auth/jwt.strategy";

/**
 * Matični podaci — Artikli (BigBit cache tabela `items`).
 *   GET   /api/v1/artikli          — lista, kolone i filteri BigBit pregleda
 *   GET   /api/v1/artikli/lookups  — šifarnici za padajuće liste (grupe, podgrupe,
 *                                    PodPodgrupe, kvaliteti, dimenzije, tarife, JM,
 *                                    proizvođači, zemlje porekla)
 *   GET   /api/v1/artikli/:id      — pun slog + nazivi grupe/podgrupe/porekla,
 *                                    dimenzije, kvaliteta i zbirne PDV stope
 *   POST  /api/v1/artikli          — nov artikal (pun skup polja forme „Unos artikala")
 *   PATCH /api/v1/artikli/:id      — izmena artikla (samo 4.0-native red)
 *
 * Filteri liste (svi kombinuju logičkim I): `q`, `groupCode`, `subgroupCode`,
 * `originCode`, `catalogNumber` (prefiks), `name`, `rasterId`, `qualityTypeId`,
 * `duplicateCatalogNumbers`, `active` — svaki ima blizanca na BigBit formi, v.
 * `dto/list-items.dto.ts`.
 *
 * `items` ima ~91k redova → paginacija je OBAVEZNA (`parsePagination`: default
 * pageSize 50, tvrdi max 200). Sort je BigBit sort pregleda: grupa → kataloški
 * broj → naziv.
 *
 * ⚠️ OBE MUTACIJE SU DANAS ZATVORENE BRANOM `assertItemWritesAllowed()` i vraćaju
 * 409 `BIGBIT_OWNED_READ_ONLY` sa uputstvom šta uraditi u BigBit-u. Razlog nije
 * odluka o vlasništvu nego tehnička činjenica: `items` se sinhronizuje kao full
 * refresh (`deleteMany({})` + `createMany`), pa bi upis odavde nestao pri prvom
 * uvozu i ostavio siročad u `price_list_entries`/`work_order_item_components`.
 * Brana se otključava sama kad `items` uđe u zaštićeni skup u
 * `sync/table-ownership.ts` — v. `items.write-policy.ts` (tamo su i uslovi).
 *
 * Permisije:
 *   • čitanje = `directory.read` (klasna, isti ključ kao `DirectoryController` — isti domen);
 *   • upis    = `masters.write` (METHOD-LEVEL, nadjačava klasnu — `getAllAndOverride`
 *     uzima handler pre klase). Do 28.07.2026 je upis visio na `sync.run`, što je
 *     semantički pogrešno (to je „pokreni sinhronizaciju", admin-only) — v. obrazloženje
 *     uz `PERMISSIONS.MASTERS_WRITE`. Krug: admin (ALL) + menadzment + nabavka_view.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.DIRECTORY_READ)
@Controller({ path: "artikli", version: "1" })
export class ItemsController {
  constructor(private readonly items: ItemsService) {}

  @Get()
  list(@Query() query: ListItemsQuery) {
    return this.items.list(query);
  }

  /**
   * ⚠️ MORA STAJATI PRE `@Get(":id")` — Nest bira prvu rutu koja se poklopi, redom
   * kojim su metode DEKLARISANE u klasi. Ispod `:id` bi `/artikli/lookups` upao u
   * `findOne`, a `ParseIntPipe` bi na „lookups" vratio 400 („Validation failed
   * (numeric string is expected)") — ekran bi ostao bez ijedne padajuće liste, uz
   * poruku koja ne kaže ništa o uzroku.
   */
  @Get("lookups")
  lookups() {
    return this.items.lookups();
  }

  @Get(":id")
  findOne(@Param("id", ParseIntPipe) id: number) {
    return this.items.findOne(id);
  }

  @Post()
  @RequirePermission(PERMISSIONS.MASTERS_WRITE)
  create(@Body() dto: CreateItemDto, @Req() req: { user: AuthUser }) {
    return this.items.create(dto, req.user);
  }

  @Patch(":id")
  @RequirePermission(PERMISSIONS.MASTERS_WRITE)
  update(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateItemDto,
    @Req() req: { user: AuthUser },
  ) {
    return this.items.update(id, dto, req.user);
  }
}
