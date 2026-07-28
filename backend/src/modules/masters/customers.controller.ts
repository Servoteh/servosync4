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
import { MasterCustomersService } from "./customers.service";
import type { AuthUser } from "../auth/jwt.strategy";
import type { ListCustomersQuery } from "./dto/list-customers.dto";

/**
 * Matični podaci — Komitenti (read-only pregled BigBit cache tabele `customers`).
 *   GET /api/v1/komitenti      — lista (q po nazivu/PIB-u/mestu; codeTypeCode)
 *   GET /api/v1/komitenti/:id  — pun slog + vrsta šifre / prodavac / uplatni račun
 *
 *   POST  /api/v1/komitenti      — unos (port forme „Unos komitenata")
 *   PATCH /api/v1/komitenti/:id  — izmena
 *
 * ⚠️ OBE MUTIRAJUĆE RUTE DANAS VRAĆAJU 409 `BIGBIT_OWNED_READ_ONLY` — `customers` je
 * read-only za celu aplikaciju (odluka vlasnika 26.07.2026). Validacija i mapiranje su
 * kompletni i izvršavaju se PRE brane, pa klijent dobija tačnu grešku o svom podatku
 * (npr. `PIB_NIJE_DOBAR`) pre nego što ga uputimo u BigBit. Uslovi za otvaranje su
 * popisani uz `CUSTOMERS_WRITE_OPEN` u `customers.service.ts`.
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

  // ── UNOS / IZMENA ───────────────────────────────────────────────────────────
  // Permisija je nasleđena klasna `directory.read` — isti presedan kao kod
  // `DirectoryController`, gde POST/PATCH nad komitentom takođe stoje iza `read`
  // ključa jer NE PIŠU, nego objašnjavaju („svako ko sme da gleda šifarnik dobija
  // objašnjenje, a ne ,nemate pravo'").
  // TODO(auth): pre nego što se `CUSTOMERS_WRITE_OPEN` prebaci na `true`, ove dve
  // rute MORAJU dobiti sopstveni ključ za upis (`masters.write` / `komitenti.write`)
  // u `common/authz/permissions.ts` — taj fajl je van granica ovog modula, pa je
  // ključ prijavljen, ne dodat.

  @Post()
  create(@Body() body: unknown, @Req() req: { user?: AuthUser }) {
    return this.customers.create(body, req.user);
  }

  @Patch(":id")
  update(
    @Param("id", ParseIntPipe) id: number,
    @Body() body: unknown,
    @Req() req: { user?: AuthUser },
  ) {
    return this.customers.update(id, body, req.user);
  }
}
