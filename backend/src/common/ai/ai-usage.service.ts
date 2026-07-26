import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";

/**
 * AI usage ledger (Talas AI-0, item 4) — one row per LLM call, written by the
 * gateway and nobody else. It is both the audit trail ("who spent what") and the
 * source of truth for the daily budgets in `AiLimitsService`.
 *
 * Writing NEVER fails a request: a broken ledger must not take the AI layer down,
 * so every write is best-effort and only logged on failure.
 */

/** Caller-supplied context. Optional everywhere so existing call sites keep working. */
export interface AiCallContext {
  /** Logical consumer: chat | stt | refine | embed | title | zahtevi-triage | … */
  module: string;
  /** Numeric app user id; null/undefined for system calls (scheduler, fire-and-forget). */
  userId?: number | null;
}

export type AiOutcome = "ok" | "error" | "fallback";

export interface AiUsageRecord extends AiCallContext {
  provider: "openai" | "anthropic";
  model: string;
  tokensIn?: number | null;
  tokensOut?: number | null;
  durationMs: number;
  outcome: AiOutcome;
}

/**
 * USD per 1M tokens [input, output]. Anthropic figures are the published list
 * prices; OpenAI figures are approximations (hence the `est_` column name).
 * Override without a deploy via `AI_PRICE_TABLE_JSON`
 * (e.g. `{"gpt-4o-mini":[0.15,0.6]}`). Unknown model → cost stays null.
 */
const BASE_PRICE_PER_MTOK: Record<string, [number, number]> = {
  "claude-fable-5": [10, 50],
  "claude-mythos-5": [10, 50],
  "claude-opus-5": [5, 25],
  "claude-opus-4-8": [5, 25],
  "claude-opus-4-7": [5, 25],
  "claude-opus-4-6": [5, 25],
  "claude-sonnet-5": [3, 15],
  "claude-sonnet-4-6": [3, 15],
  "claude-haiku-4-5": [1, 5],
  "gpt-4o-mini": [0.15, 0.6],
  "gpt-4o": [2.5, 10],
  "text-embedding-3-small": [0.02, 0],
};

@Injectable()
export class AiUsageService {
  private readonly logger = new Logger(AiUsageService.name);
  private priceTable: Record<string, [number, number]> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /** Best-effort ledger write. Returns nothing and never throws. */
  async record(rec: AiUsageRecord): Promise<void> {
    try {
      await this.prisma.aiUsageLog.create({
        data: {
          userId: rec.userId ?? null,
          module: (rec.module || "unknown").slice(0, 40),
          provider: rec.provider,
          model: (rec.model || "unknown").slice(0, 80),
          tokensIn: rec.tokensIn ?? null,
          tokensOut: rec.tokensOut ?? null,
          durationMs: Math.max(0, Math.round(rec.durationMs)),
          outcome: rec.outcome,
          estCostUsd: this.estimateCost(rec.model, rec.tokensIn, rec.tokensOut),
        },
      });
    } catch (err) {
      // A failing ledger must never take the AI layer down (doktrina §10.4).
      this.logger.warn(
        `ai_usage_log upis pao (${rec.module}/${rec.model}): ${(err as Error).message}`,
      );
    }
  }

  /** Sum of input tokens for one user + module since UTC midnight. */
  async dailyInputTokens(userId: number, module: string): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ n: bigint | null }[]>(
      Prisma.sql`SELECT COALESCE(SUM(tokens_in), 0)::bigint AS n
                 FROM ai_usage_log
                 WHERE user_id = ${userId}
                   AND module = ${module}
                   AND outcome <> 'error'
                   AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
    );
    return Number(rows[0]?.n ?? 0);
  }

  /** Number of calls for one user + module since UTC midnight. */
  async dailyCalls(userId: number, module: string): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ n: bigint | null }[]>(
      Prisma.sql`SELECT count(*)::bigint AS n
                 FROM ai_usage_log
                 WHERE user_id = ${userId}
                   AND module = ${module}
                   AND outcome <> 'error'
                   AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
    );
    return Number(rows[0]?.n ?? 0);
  }

  /** `Decimal` cost estimate, or null when the model has no known price. */
  private estimateCost(
    model: string,
    tokensIn?: number | null,
    tokensOut?: number | null,
  ): Prisma.Decimal | null {
    if (tokensIn == null && tokensOut == null) return null;
    const price = this.priceFor(model);
    if (!price) return null;
    const usd =
      ((tokensIn ?? 0) * price[0] + (tokensOut ?? 0) * price[1]) / 1_000_000;
    if (!Number.isFinite(usd)) return null;
    return new Prisma.Decimal(usd.toFixed(6));
  }

  /** Longest-prefix match so dated snapshots (`claude-haiku-4-5-20251001`) resolve. */
  private priceFor(model: string): [number, number] | undefined {
    const table = this.table();
    if (table[model]) return table[model];
    let best: [number, number] | undefined;
    let bestLen = 0;
    for (const [key, val] of Object.entries(table)) {
      if (model.startsWith(key) && key.length > bestLen) {
        best = val;
        bestLen = key.length;
      }
    }
    return best;
  }

  private table(): Record<string, [number, number]> {
    if (this.priceTable) return this.priceTable;
    let merged = { ...BASE_PRICE_PER_MTOK };
    const raw = process.env.AI_PRICE_TABLE_JSON;
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Record<string, [number, number]>;
        merged = { ...merged, ...parsed };
      } catch {
        this.logger.warn("AI_PRICE_TABLE_JSON nije validan JSON — ignorisan.");
      }
    }
    this.priceTable = merged;
    return merged;
  }
}
