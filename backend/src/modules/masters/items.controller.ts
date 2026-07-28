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
 *   GET   /api/v1/artikli      — lista (q po nazivu/kat. broju/barkodu; groupCode, active)
 *   GET   /api/v1/artikli/:id  — pun slog + razrešeni nazivi grupe/podgrupe/porekla
 *   POST  /api/v1/artikli      — nov artikal (pun skup polja BigBit forme „Unos artikala")
 *   PATCH /api/v1/artikli/:id  — izmena artikla (samo 4.0-native red)
 *
 * `items` ima ~91k redova → paginacija je OBAVEZNA (`parsePagination`: default
 * pageSize 50, tvrdi max 200). Sort po kataloškom broju (ljudski ključ artikla).
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
 *   • čitanje = `directory.read` (isti ključ kao `DirectoryController` — isti domen);
 *   • upis    = `sync.run` (administrator matičnih podataka). NAMERNO se ne uvodi nov
 *     ključ `masters.write`: katalog permisija (`common/authz/permissions.ts`) i mapa
 *     rola su van granice ovog posla, a nov ključ koji nijedna rola nema dao bi 403
 *     umesto poruke koja objašnjava stanje. Pre puštanja unosa u rad TREBA uvesti
 *     zaseban ključ — prijavljeno u izveštaju.
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

  @Get(":id")
  findOne(@Param("id", ParseIntPipe) id: number) {
    return this.items.findOne(id);
  }

  @Post()
  @RequirePermission(PERMISSIONS.SYNC_RUN)
  create(@Body() dto: CreateItemDto, @Req() req: { user: AuthUser }) {
    return this.items.create(dto, req.user);
  }

  @Patch(":id")
  @RequirePermission(PERMISSIONS.SYNC_RUN)
  update(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateItemDto,
    @Req() req: { user: AuthUser },
  ) {
    return this.items.update(id, dto, req.user);
  }
}
