import { Body, Controller, Get, Post, Req, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import type { AuthUser } from "../auth/jwt.strategy";
import { DictationInboxService } from "./dictation-inbox.service";
import { CreateDictationDto } from "./dto/create-dictation.dto";

/**
 * Diktafon „sanduče" (scenario B):
 *   POST /api/v1/dictation-inbox        — upiši sređen diktat za korisnika iz JWT-a
 *   GET  /api/v1/dictation-inbox/latest — poslednji NEISPORUČEN red tog korisnika
 *
 * Guard = `ai.chat` (kao STT/refine `MediaAiController`): diktafon JESTE AI alat
 * (telefon već koristi `/ai/stt` + `/ai/refine`), pa isti ključ zaključava i slanje;
 * praktično „svaki prijavljen sa aktivnom ulogom" (1.0 „/ai za sve"). Mutacija tako
 * nosi permisiju i prolazi route-permission-coverage gejt bez allowlist-a.
 *
 * Claude čita „sanduče" DIREKTNO iz baze (infra SSH/psql, read-only) i markira
 * `delivered_at` — ovi HTTP endpointi su za samu aplikaciju, ne za Claude-a.
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
}
