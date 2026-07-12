import {
  Body,
  Controller,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import { MediaAiService } from "./media-ai.service";
import { RefineDto, SttMetaDto } from "./dto/media-ai.dto";

/**
 * Zajednički media/AI endpointi (presuda B4/H3): `/ai/stt` (Whisper diktiranje) +
 * `/ai/refine` (✨ doterivanje). Guard = `ai.chat` (bilo koji ulogovan) — koristi ih
 * zapisnik, chat i ~10 modula; C/D/G reuse. Distinktne rute pod `/ai` (bez sudara
 * sa AiChatController).
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.AI_CHAT)
@Controller({ path: "ai", version: "1" })
export class MediaAiController {
  constructor(private readonly media: MediaAiService) {}

  @Post("stt")
  // Hard DoS cap ~25MB (Whisper limit); servis dodatno primenjuje 15MB pravilo 1.0.
  @UseInterceptors(
    FileInterceptor("audio", { limits: { fileSize: 25 * 1024 * 1024 } }),
  )
  stt(@Body() dto: SttMetaDto, @UploadedFile() audio?: Express.Multer.File) {
    return this.media.transcribe(dto, audio);
  }

  @Post("refine")
  refine(@Body() dto: RefineDto) {
    return this.media.refine(dto);
  }
}
