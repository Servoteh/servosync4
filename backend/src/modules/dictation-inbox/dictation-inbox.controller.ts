import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import type { AuthUser } from "../auth/jwt.strategy";
import { DictationInboxService } from "./dictation-inbox.service";
import { CreateDictationDto } from "./dto/create-dictation.dto";
import {
  ClaimDictationDto,
  LastClaimedQueryDto,
} from "./dto/claim-dictation.dto";

/**
 * Diktafon „sanduče" (scenario B):
 *   POST /api/v1/dictation-inbox              — upiši sređen diktat za korisnika iz JWT-a
 *   GET  /api/v1/dictation-inbox/latest       — POSLEDNJI nepreuzet red tog korisnika (samo čita)
 *   POST /api/v1/dictation-inbox/claim        — ATOMIČNO uzmi NAJSTARIJI nepreuzet i markiraj ga
 *   GET  /api/v1/dictation-inbox/last-claimed — ono što je OVAJ pozivalac preuzeo u zadnjih 15 min
 *
 * Redosled nije previd: `latest` je pregled („šta sam poslednje poslao"), `claim` je
 * obrada REDOM (višedelni diktat mora agentu stići hronološki, ne obrnuto).
 *
 * Guard = `ai.chat` (kao STT/refine `MediaAiController`): diktafon JESTE AI alat
 * (telefon već koristi `/ai/stt` + `/ai/refine`), pa isti ključ zaključava i slanje;
 * praktično „svaki prijavljen sa aktivnom ulogom" (1.0 „/ai za sve"). Mutacija tako
 * nosi permisiju i prolazi route-permission-coverage gejt bez allowlist-a.
 *
 * `claim` je dodat 2026-08-02 za AGENTA VAN LOKALNE MREŽE (Cursor/Claude u oblaku,
 * pokrenut sa telefona): on nema ni SSH ni `192.168.64.28`, pa dosadašnji put
 * (psql + ručni `UPDATE … delivered_at`) za njega ne postoji. Tuđe sanduče se
 * otvara SAMO uz red u `dictation_delegates` (admin ga dodeljuje — vidi
 * `DictationDelegatesController`), inače 403.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.AI_CHAT)
@Controller({ path: "dictation-inbox", version: "1" })
export class DictationInboxController {
  constructor(private readonly inbox: DictationInboxService) {}

  @Post()
  create(@Body() dto: CreateDictationDto, @Req() req: { user: AuthUser }) {
    return this.inbox.create(req.user.userId, dto.text ?? "");
  }

  @Get("latest")
  latest(@Req() req: { user: AuthUser }) {
    return this.inbox.latest(req.user.userId);
  }

  /**
   * 200 (ne 201): ovo ne kreira resurs nego TROŠI postojeći. Prazno sanduče je
   * uredan ishod (`{ data: null }`), ne 404 — agent ga poziva u petlji.
   */
  @Post("claim")
  @HttpCode(HttpStatus.OK)
  claim(@Body() dto: ClaimDictationDto, @Req() req: { user: AuthUser }) {
    return this.inbox.claim(
      { userId: req.user.userId, email: req.user.email },
      { ownerUserId: dto.ownerUserId, ownerEmail: dto.ownerEmail },
    );
  }

  /**
   * Oporavak: poslednji diktat koji je OVAJ pozivalac preuzeo u kratkom prozoru
   * (15 min). `claim` je destruktivan i neidempotentan — bez ove rute izgubljen
   * odgovor (prekid mreže) znači trajno izgubljenu instrukciju.
   *
   * GET, jer ništa ne menja: ne vraća diktat na „neposlato" i ne otvara tuđi plen
   * (filtrira po `claimed_by_user_id = pozivalac`). Van rate-limita `claim`-a.
   */
  @Get("last-claimed")
  lastClaimed(@Query() q: LastClaimedQueryDto, @Req() req: { user: AuthUser }) {
    return this.inbox.lastClaimed(
      { userId: req.user.userId, email: req.user.email },
      { ownerUserId: q.ownerUserId, ownerEmail: q.ownerEmail },
    );
  }
}
