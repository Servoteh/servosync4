import { HttpException, HttpStatus, Injectable } from "@nestjs/common";
import { ROLES } from "../authz/roles";
import { AiUsageService } from "./ai-usage.service";

/**
 * Daily AI budgets (Talas AI-0, item 5). Replaces the old "50 messages/day"
 * counter in `ai-chat.service.ts`: the single source is now `ai_usage_log`, so
 * STT / refine / triage are metered too and nothing is counted twice.
 *
 * Defaults come from the plan (§8.5, Nenad 26.07): 200k input tokens/day for
 * chat, 30 min of audio/day for STT, 100 refine calls/day. Admin has no limit.
 *
 * STT duration: the Whisper response carries no duration and decoding the audio
 * server-side would mean a new dependency (BACKEND_RULES §10 — not allowed here),
 * so the budget is enforced as calls × an assumed average clip length
 * (`AI_STT_AVG_SECONDS`, default 60 s). With the defaults that is 30 clips/day.
 * Documented deviation — swap for a real duration once one is available.
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
  constructor(private readonly usage: AiUsageService) {}

  static chatTokenLimit(): number {
    return envInt("AI_CHAT_DAILY_INPUT_TOKENS", 200_000);
  }
  static sttSecondsLimit(): number {
    return envInt("AI_STT_DAILY_SECONDS", 1800);
  }
  static sttAvgSeconds(): number {
    return envInt("AI_STT_AVG_SECONDS", 60);
  }
  static refineCallLimit(): number {
    return envInt("AI_REFINE_DAILY_CALLS", 100);
  }

  isUnlimited(role?: string | null): boolean {
    return (role ?? "").toLowerCase() === ROLES.ADMIN;
  }

  /** Chat budget in INPUT tokens (prompt + tools + history dominate the spend). */
  async chatBudget(userId: number, role?: string | null): Promise<AiBudget> {
    if (this.isUnlimited(role)) return { ...UNLIMITED };
    const limit = AiLimitsService.chatTokenLimit();
    const used = await this.usage.dailyInputTokens(userId, AI_MODULE.CHAT);
    return {
      used,
      limit,
      remaining: Math.max(0, limit - used),
      unit: "tokens",
    };
  }

  /** STT budget in seconds of audio (estimated — see class docblock). */
  async sttBudget(userId: number, role?: string | null): Promise<AiBudget> {
    if (this.isUnlimited(role)) return { ...UNLIMITED, unit: "sekunde" };
    const limit = AiLimitsService.sttSecondsLimit();
    const calls = await this.usage.dailyCalls(userId, AI_MODULE.STT);
    const used = calls * AiLimitsService.sttAvgSeconds();
    return {
      used,
      limit,
      remaining: Math.max(0, limit - used),
      unit: "sekunde",
    };
  }

  async refineBudget(userId: number, role?: string | null): Promise<AiBudget> {
    if (this.isUnlimited(role)) return { ...UNLIMITED, unit: "pozivi" };
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
