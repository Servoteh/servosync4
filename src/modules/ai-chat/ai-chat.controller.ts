import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Req,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import { AiChatService } from "./ai-chat.service";

interface AuthedRequest {
  user: { userId: number; email: string; role: string };
}

/**
 * AI asistent — 3.0 TALAS B, R1 READ endpoints (MODULE_SPEC_sastanci_ai_30.md §3).
 * Klasa: `ai.chat` (1.0 „/ai za sve" → sve aktivne uloge). Sam chat (POST /ai/chat,
 * 4 engine-a + tool-use petlja) + DELETE niti + vision + STT/refine su R2 (vidi
 * AiChatService R2 TODO). Route ordering: literali pre `:id`.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.AI_CHAT)
@Controller({ path: "ai", version: "1" })
export class AiChatController {
  constructor(private readonly ai: AiChatService) {}

  @Get("me")
  me(@Req() req: AuthedRequest) {
    return this.ai.me(req.user.email);
  }

  @Get("limit")
  limit(@Req() req: AuthedRequest) {
    return this.ai.limit(req.user.email);
  }

  @Get("conversations")
  conversations(@Req() req: AuthedRequest) {
    return this.ai.conversations(req.user.email);
  }

  @Get("conversations/:id/messages")
  messages(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.ai.messages(req.user.email, id);
  }
}
