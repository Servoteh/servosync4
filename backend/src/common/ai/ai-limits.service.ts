import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  Optional,
} from "@nestjs/common";
import { ROLES } from "../authz/roles";
import { PrismaService } from "../../prisma/prisma.service";
import { AiUsageService } from "./ai-usage.service";

/**
 * Daily AI budgets (Talas AI-0, item 5). Replaces the old "50 messages/day"
 * counter in `ai-chat.service.ts`: the single source is now `ai_usage_log`, so
 * STT / refine / triage are metered too and nothing is counted twice.
 *
 * Defaults come from the plan (§8.5, Nenad 26.07): 200k input tokens/day for
 * chat, 30 min of audio/day for STT, 100 refine calls/day. Admin has no limit.
 *
 * STT duration: `gpt-4o-transcribe` returns `usage.input_token_details.audio_tokens`,
 * which the gateway stores in `ai_usage_log.tokens_in`. Seconds are derived from it
 * via `AI_STT_AUDIO_TOKENS_PER_SECOND`. The default (10 tokens/s) matches OpenAI's
 * documented audio tokenisation rate for the gpt-4o audio family; it is env-tunable
 * precisely because it is a rate, not a wire field — calibrate by recording a clip
 * of known length and comparing `tokens_in` against it. Calls with no `usage`
 * (whisper-1, or an older response shape) fall back to `AI_STT_AVG_SECONDS` each.
 */

export const AI_MODULE = {
  CHAT: "chat",
  STT: "stt",
  REFINE: "refine",
  EMBED: "embed",
  TITLE: "title",
  ZAHTEVI_TRIAGE: "zahtevi-triage",
  ZAHTEVI_ANALYSIS: "zahtevi-analysis",
  SASTANCI_SUMMARY: "sastanci-summary",
  MONTAZA_REPORT: "montaza-izvestaj",
} as const;

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

export interface AiBudget {
  used: number;
  limit: number;
  remaining: number;
  /** `tokens` for chat, `sekunde` for STT, `pozivi` for refine. */
  unit: "tokens" | "sekunde" | "pozivi";
}

/** Unlimited budget marker for admins (limit -1 → FE hides the counter). */
const UNLIMITED: AiBudget = {
  used: 0,
  limit: -1,
  remaining: -1,
  unit: "tokens",
};

@Injectable()
export class AiLimitsService {
  private readonly logger = new Logger(AiLimitsService.name);

  /**
   * `@Optional()` na Prisma-i: postojeći unit testovi prave servis samo sa
   * ledger-om; bez klijenta se admin izuzeće oslanja na JWT tvrdnju.
   */
  constructor(
    private readonly usage: AiUsageService,
    @Optional() private readonly prisma?: PrismaService,
  ) {}

  static chatTokenLimit(): number {
    return envInt("AI_CHAT_DAILY_INPUT_TOKENS", 200_000);
  }
  static sttSecondsLimit(): number {
    return envInt("AI_STT_DAILY_SECONDS", 1800);
  }
  static sttAvgSeconds(): number {
    return envInt("AI_STT_AVG_SECONDS", 60);
  }
  /** Audio tokena po sekundi snimka (OpenAI gpt-4o audio familija). */
  static sttTokensPerSecond(): number {
    return envInt("AI_STT_AUDIO_TOKENS_PER_SECOND", 10);
  }
  static refineCallLimit(): number {
    return envInt("AI_REFINE_DAILY_CALLS", 100);
  }

  /**
   * Admin je izuzet od budžeta — ali JWT tvrdnja o roli živi do 7 dana, pa se
   * izuzeće POTVRĐUJE svežim čitanjem role iz glavne baze (SSO login je sinhronizuje
   * sa 1.0). Skidanje admin prava tako stupa na snagu odmah, a ne tek po isteku
   * tokena. Pad čitanja → ostaje pri JWT tvrdnji (fail-open, kao i ostatak sloja).
   */
  async isUnlimited(role?: string | null, userId?: number): Promise<boolean> {
    if ((role ?? "").toLowerCase() !== ROLES.ADMIN) return false;
    if (userId == null || !this.prisma) return true;
    try {
      const row = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { role: true },
      });
      // Nema reda → ne obaramo izuzeće (nalog može živeti samo u sy15).
      if (!row) return true;
      return row.role.toLowerCase() === ROLES.ADMIN;
    } catch (err) {
      this.logger.error(
        `Provera admin role (users.${userId}) pala — ostajem pri JWT tvrdnji: ${(err as Error).message}`,
      );
      return true;
    }
  }

  /** Chat budget in INPUT tokens (prompt + tools + history dominate the spend). */
  async chatBudget(userId: number, role?: string | null): Promise<AiBudget> {
    if (await this.isUnlimited(role, userId)) return { ...UNLIMITED };
    const limit = AiLimitsService.chatTokenLimit();
    const used = await this.usage.dailyInputTokens(userId, AI_MODULE.CHAT);
    return {
      used,
      limit,
      remaining: Math.max(0, limit - used),
      unit: "tokens",
    };
  }

  /** STT budget in seconds of audio (from the response's audio tokens — see docblock). */
  async sttBudget(userId: number, role?: string | null): Promise<AiBudget> {
    if (await this.isUnlimited(role, userId))
      return { ...UNLIMITED, unit: "sekunde" };
    const limit = AiLimitsService.sttSecondsLimit();
    const used = await this.usage.dailySttSeconds(
      userId,
      AiLimitsService.sttTokensPerSecond(),
      AiLimitsService.sttAvgSeconds(),
    );
    return {
      used,
      limit,
      remaining: Math.max(0, limit - used),
      unit: "sekunde",
    };
  }

  async refineBudget(userId: number, role?: string | null): Promise<AiBudget> {
    if (await this.isUnlimited(role, userId))
      return { ...UNLIMITED, unit: "pozivi" };
    const limit = AiLimitsService.refineCallLimit();
    const used = await this.usage.dailyCalls(userId, AI_MODULE.REFINE);
    return {
      used,
      limit,
      remaining: Math.max(0, limit - used),
      unit: "pozivi",
    };
  }

  /** 429 with a human Serbian message; returns the budget when still under it. */
  async assertChat(userId: number, role?: string | null): Promise<AiBudget> {
    const b = await this.chatBudget(userId, role);
    if (b.limit >= 0 && b.used >= b.limit) {
      throw this.tooMany(
        "chat_token_limit",
        b,
        `Potrošen je dnevni AI budžet (${b.limit.toLocaleString("sr-RS")} tokena). Nastavi sutra ili se javi administratoru.`,
      );
    }
    return b;
  }

  async assertStt(userId: number, role?: string | null): Promise<AiBudget> {
    const b = await this.sttBudget(userId, role);
    if (b.limit >= 0 && b.used >= b.limit) {
      throw this.tooMany(
        "stt_limit",
        b,
        `Potrošen je dnevni limit diktiranja (${Math.round(b.limit / 60)} minuta snimka). Nastavi sutra.`,
      );
    }
    return b;
  }

  async assertRefine(userId: number, role?: string | null): Promise<AiBudget> {
    const b = await this.refineBudget(userId, role);
    if (b.limit >= 0 && b.used >= b.limit) {
      throw this.tooMany(
        "refine_limit",
        b,
        `Potrošen je dnevni limit doterivanja teksta (${b.limit} poziva). Nastavi sutra.`,
      );
    }
    return b;
  }

  private tooMany(error: string, b: AiBudget, message: string): HttpException {
    return new HttpException(
      { error, limit: b.limit, used: b.used, unit: b.unit, message },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
