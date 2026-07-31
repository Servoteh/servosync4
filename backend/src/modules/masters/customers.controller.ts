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
 * Permisije: čitanje = `directory.read` (klasna) — isti ključ kao `DirectoryController`
 * (isti domen podataka); upis = `masters.write` (method-level, v. dole).
 * ⚠️ SVESNO ODSTUPANJE od `directory`: matični karton vraća i komercijalne
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

  /**
   * TRAJAN SPISAK DUPLIH PIB-ova (odluka vlasnika O-7, 30.07.2026).
   *
   * BigBit dupli PIB TOLERIŠE (ima samo izveštaj, ne branu), pa ga toleriše i
   * uvoz — tvrda zabrana bi odbijala redove. Ali „rešićemo kasnije" bez spiska
   * ostane zauvek: ovaj izveštaj drži duplikate pred očima da broj PADA, i tek
   * kad padne na nulu sme se uvesti tvrda brana bez rizika po uvoz.
   *
   * Izmereno 31.07.2026 na svežoj BigBit kopiji: 12 grupa, sve parovi — tipično
   * ISTA firma uneta dvaput pod starim i novim imenom (EPS → Elektrodistribucija,
   * Trelleborg → Yokohama, PPT…). Rešava se u BigBitu (on je vlasnik do prelaza).
   *
   * MORA PRE `:id` rute — inače bi `dupli-pib` bio progutan kao ParseInt greška.
   */
  @Get("dupli-pib")
  duplicateTaxIds() {
    return this.customers.duplicateTaxIds();
  }

  @Get(":id")
  findOne(@Param("id", ParseIntPipe) id: number) {
    return this.customers.findOne(id);
  }

  // ── UNOS / IZMENA ───────────────────────────────────────────────────────────
  // Permisija je METHOD-LEVEL `masters.write` i nadjačava klasnu `directory.read`
  // (`getAllAndOverride` uzima handler pre klase). Do 28.07.2026 su ove dve rute
  // nasleđivale klasni READ ključ — a `directory.read` je u `VIEWER_READ_BASELINE`,
  // tj. ima ga skoro svaka rola. Presedan `DirectoryController`-a (POST iza `read`
  // ključa jer „ne piše, nego objašnjava") OVDE NE VAŽI: tamo je telo metode gola
  // `rejectCustomerWrite()` koja nikad ne dodirne bazu, a ovde iza brane stoji pun
  // upis. Kad se `CUSTOMERS_WRITE_OPEN` preklopi, ključ je već na mestu.
  //
  // Objašnjavajuću ulogu ruta ZADRŽAVA za svog nosioca: `masters.write` ga pušta
  // kroz guard do 409 `BIGBIT_OWNED_READ_ONLY` sa uputstvom, umesto do „nemate pravo".

  @Post()
  @RequirePermission(PERMISSIONS.MASTERS_WRITE)
  create(@Body() body: unknown, @Req() req: { user?: AuthUser }) {
    return this.customers.create(body, req.user);
  }

  @Patch(":id")
  @RequirePermission(PERMISSIONS.MASTERS_WRITE)
  update(
    @Param("id", ParseIntPipe) id: number,
    @Body() body: unknown,
    @Req() req: { user?: AuthUser },
  ) {
    return this.customers.update(id, body, req.user);
  }
}
