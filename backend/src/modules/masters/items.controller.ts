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
import { LagerService } from "./lager.service";
import type { ListItemsQuery } from "./dto/list-items.dto";
import type {
  GoodsCardQuery,
  ListLagerQuery,
  OrdersCardQuery,
  ProformaCardQuery,
} from "./dto/list-lager.dto";
import type { CreateItemDto, UpdateItemDto } from "./dto/upsert-item.dto";
import type { AuthUser } from "../auth/jwt.strategy";

/**
 * Matični podaci — Artikli (BigBit cache tabela `items`).
 *   GET   /api/v1/artikli          — lista, kolone i filteri BigBit pregleda
 *   GET   /api/v1/artikli/lookups  — šifarnici za padajuće liste (grupe, podgrupe,
 *                                    PodPodgrupe, kvaliteti, dimenzije, tarife, JM,
 *                                    proizvođači, zemlje porekla)
 *   GET   /api/v1/artikli/lager    — LAGER LISTA („drugi pregled artikala"):
 *                                    STANJE / REZERVISANO / SLOBODNO po magacinu
 *   GET   /api/v1/artikli/:id      — pun slog + nazivi grupe/podgrupe/porekla,
 *                                    dimenzije, kvaliteta i zbirne PDV stope
 *   GET   /api/v1/artikli/:id/kartica-robno       — robno kretanje + tekuće stanje
 *   GET   /api/v1/artikli/:id/kartica-narudzbine  — trebovanja sa artiklom
 *   GET   /api/v1/artikli/:id/kartica-profakture  — dokumenti `Level >= 250`
 *   POST  /api/v1/artikli          — nov artikal (pun skup polja forme „Unos artikala")
 *   PATCH /api/v1/artikli/:id      — izmena artikla (samo 4.0-native red)
 *
 * Lager i tri kartice su READ-ONLY OGLEDALO BigBit robnog (`*_mirror` tabele koje
 * puni noćni `.mdb` uvoz) — 4.0 native robne tabele su na produkciji prazne, a
 * MSSQL kanal koji ih je punio mrtav je od 22.07.2026. Formula, sečenje po
 * poslovnoj godini i domet rezervacija: `lager.service.ts`.
 *
 * Filteri liste (svi kombinuju logičkim I): `q`, `groupCode`, `subgroupCode`,
 * `originCode`, `catalogNumber` (prefiks), `name`, `shelf` (prefiks),
 * `shelfPresence` (`with`/`without`), `unit`, `rasterId`, `qualityTypeId`,
 * `duplicateCatalogNumbers`, `active` — v. `dto/list-items.dto.ts`.
 *
 * `items` ima ~92k redova → paginacija je OBAVEZNA (`parsePagination`: default
 * pageSize 50, tvrdi max 200; ekran skroluje tako što nadovezuje strane).
 *
 * Sort: `?sort=<kolona>&dir=asc|desc` nad CELIM skupom, kolona iz zatvorenog spiska
 * `ITEM_SORT_COLUMNS` (van njega → 400 sa spiskom dozvoljenih). Bez `sort`-a važi
 * BigBit redosled pregleda: grupa → kataloški broj → naziv. Iza svakog sorta stoji
 * `id` kao tie-break — bez njega skrol duplira i preskače redove (kataloški broj
 * nije jedinstven).
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
 *     TO VAŽI I ZA LAGER I ZA KARTICE, i to je odluka, ne previd: ovo je read-only
 *     ogledalo BigBit-a, isti podatak koji svaki magacioner ionako vidi u BigBit-u,
 *     pa mora da ga vidi svako ko vidi artikle. Zaseban `robno.*` ključ bi značio da
 *     „drugi pregled artikala" nestane polovini kruga koji vidi prvi pregled — a
 *     nijedno pravo se ne dodaje da bi se sakrio podatak koji je već dostupan.
 *     Kad robno pređe u 4.0 kao izvor istine (cutover april 2027), UPIS će tražiti
 *     svoj ključ; čitanje ostaje ovde.
 *   • upis    = `masters.write` (METHOD-LEVEL, nadjačava klasnu — `getAllAndOverride`
 *     uzima handler pre klase). Do 28.07.2026 je upis visio na `sync.run`, što je
 *     semantički pogrešno (to je „pokreni sinhronizaciju", admin-only) — v. obrazloženje
 *     uz `PERMISSIONS.MASTERS_WRITE`. Krug: admin (ALL) + menadzment + nabavka_view.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.DIRECTORY_READ)
@Controller({ path: "artikli", version: "1" })
export class ItemsController {
  constructor(
    private readonly items: ItemsService,
    private readonly lagerService: LagerService,
  ) {}

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

  /**
   * LAGER LISTA — „drugi pregled artikala".
   *
   * ⚠️ ISTO PRAVILO KAO ZA `lookups`: MORA STAJATI PRE `@Get(":id")`. Ispod bi
   * „lager" upalo u `findOne`, a `ParseIntPipe` bi vratio 400 „numeric string is
   * expected" — ekran zaliha bi bio mrtav, uz poruku koja ne pominje rutu.
   */
  @Get("lager")
  lager(@Query() query: ListLagerQuery) {
    return this.lagerService.lager(query);
  }

  @Get(":id")
  findOne(@Param("id", ParseIntPipe) id: number) {
    return this.items.findOne(id);
  }

  /** Kartica robnog kretanja: hronologija `Level 0` + tekuće stanje po redu. */
  @Get(":id/kartica-robno")
  goodsCard(
    @Param("id", ParseIntPipe) id: number,
    @Query() query: GoodsCardQuery,
  ) {
    return this.lagerService.goodsCard(id, query);
  }

  /** Kartica narudžbina: BigBit trebovanja (`T_Trebovanja`) koja sadrže artikal. */
  @Get(":id/kartica-narudzbine")
  ordersCard(
    @Param("id", ParseIntPipe) id: number,
    @Query() query: OrdersCardQuery,
  ) {
    return this.lagerService.ordersCard(id, query);
  }

  /** Kartica profaktura: dokumenti `Level >= 250` (ponude/predračuni/rezervacije/otpremnice). */
  @Get(":id/kartica-profakture")
  proformaCard(
    @Param("id", ParseIntPipe) id: number,
    @Query() query: ProformaCardQuery,
  ) {
    return this.lagerService.proformaCard(id, query);
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
