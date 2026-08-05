import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import { DocumentSequencesService } from "./document-sequences.service";
import { ServiceRevenueTypeService } from "../sales/service-revenue-type.service";
import { SetLastNumberDto } from "./dto/podesavanja-brojaci.dto";
import {
  CreateServiceRevenueTypeDto,
  UpdateServiceRevenueTypeDto,
} from "./dto/podesavanja-vrste-usluge.dto";

interface AuthedRequest {
  user: { userId: number; email: string; role: string };
}

/**
 * PODEŠAVANJA → KNJIGOVODSTVENA PRAVILA (05.08.2026).
 * =============================================================================
 * Dva ekrana koja uređuje knjigovođa:
 *   • „Brojači dokumenata" — startni broj po seriji i godini (odluka O-F11);
 *   • „Vrste usluge" — šifarnik `service_revenue_types` (nalaz P10).
 *
 * ── ZAŠTO ZASEBAN KONTROLER, A NE JOŠ ŠEST RUTA NA `PodesavanjaController` ────
 * `PodesavanjaController` nosi KLASNU permisiju `settings.users` (admin konzola), pa bi
 * svaka ovdašnja ruta morala da je override-uje metod-dekoratorom. Jedna zaboravljena
 * ruta bi tiho pala na `settings.users` — što nije rupa (i to je admin), ali JESTE tiho
 * odstupanje od odluke „knjigovođa svojom šifrom": knjigovođa sa
 * `settings.accounting_rules` bi na toj ruti dobio 403, i to bez ijedne poruke o uzroku.
 * Ovako je klasna permisija SAMA po sebi tačna kapija za sve rute unutra, pa se ne može
 * zaboraviti.
 *
 * Uzgred: e2e kapija `route-permission-coverage` traži da svaka mutacija ima permisiju.
 * Klasni dekorator to zadovoljava po konstrukciji, a `podesavanja-write-permissions`
 * e2e (koji ručno nabraja provajdere `PodesavanjaController`-a) ostaje netaknut — dva
 * nova servisa ne ulaze u njegov DI spisak.
 *
 * ── PRAVO PRISTUPA ───────────────────────────────────────────────────────────
 * `settings.accounting_rules` ima SAMO rola `admin` (kroz ALL); knjigovođa (Jelena
 * Stanišić, Duško Kostić) ga dobija IMENOM kroz `user_permission_overrides` —
 * `prisma/seed/knjigovodstveni-sifarnici-imenovani.sql`. Brane su
 * `erp-knjige-samo-imenovanima.spec.ts` i `knjigovodstvena-pravila-imenovanima.spec.ts`.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.SETTINGS_ACCOUNTING_RULES)
@Controller({ path: "admin/knjigovodstvo", version: "1" })
export class KnjigovodstvoController {
  constructor(
    private readonly sequences: DocumentSequencesService,
    private readonly serviceRevenueTypes: ServiceRevenueTypeService,
  ) {}

  // ── Brojači dokumenata (O-F11) ─────────────────────────────────────────────

  /**
   * Pregled: serija × godina, sa poslednjim izdatim brojem, SLEDEĆIM brojem i stanjem
   * glavne knjige. Prikazuje i serije koje nemaju red u bazi („još nije izdat nijedan
   * broj") — na produkciji je `document_number_sequences` imala 0 redova, pa bi ekran
   * građen iz baze bio prazna strana baš tamo gde startni broj treba upisati.
   */
  @Get("brojaci")
  brojaci(
    @Query("companyId") companyId?: string,
    @Query("year") year?: string,
  ) {
    return this.sequences.overview(
      companyId != null && companyId !== "" ? Number(companyId) : null,
      year != null && year !== "" ? Number(year) : null,
    );
  }

  /**
   * Upis POSLEDNJEG IZDATOG broja („startni broj"; sledeći dokument dobija +1).
   * Brana: vrednost ne sme biti niža od najvećeg broja te serije koji je već u knjizi.
   */
  @Put("brojaci")
  setBrojac(@Req() req: AuthedRequest, @Body() dto: SetLastNumberDto) {
    return this.sequences.setLastNumber(
      { userId: req.user.userId, email: req.user.email },
      dto,
    );
  }

  // ── Šifarnik vrsta usluge (P10) ────────────────────────────────────────────

  /**
   * Ceo šifarnik — i ugašene vrste, sa nazivom konta i brojem računa koji ih koriste.
   * Uz spisak ide i dozvoljen skup poreskih tretmana (ekran ih nudi kao listu) i trag
   * izmene.
   */
  @Get("vrste-usluge")
  async vrsteUsluge() {
    const [data, trail] = await Promise.all([
      this.serviceRevenueTypes.listAll(),
      this.serviceRevenueTypes.trail(),
    ]);
    return {
      data,
      meta: { taxTreatments: this.serviceRevenueTypes.taxTreatments(), trail },
    };
  }

  @Post("vrste-usluge")
  async createVrstaUsluge(
    @Req() req: AuthedRequest,
    @Body() dto: CreateServiceRevenueTypeDto,
  ) {
    const data = await this.serviceRevenueTypes.create(
      { userId: req.user.userId, email: req.user.email },
      dto,
    );
    return { data };
  }

  @Patch("vrste-usluge/:id")
  async updateVrstaUsluge(
    @Req() req: AuthedRequest,
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateServiceRevenueTypeDto,
  ) {
    const data = await this.serviceRevenueTypes.update(
      { userId: req.user.userId, email: req.user.email },
      id,
      dto,
    );
    return { data };
  }
}
