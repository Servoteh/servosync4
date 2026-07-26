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
  /** PUN ulaz (svež + keširan) — budžet namerno broji sirovi kontekst. */
  tokensIn?: number | null;
  tokensOut?: number | null;
  /** Deo `tokensIn` naplaćen po sniženoj keš-čitaj ceni (~0,1× ulazne). */
  tokensCacheRead?: number | null;
  /** Deo `tokensIn` naplaćen po keš-upis ceni (1,25× ulazne za 5-min TTL). */
  tokensCacheWrite?: number | null;
  durationMs: number;
  outcome: AiOutcome;
}

/** Množioci cene za keširan ulaz (Anthropic prompt caching, 5-minutni TTL). */
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

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
          tokensCacheRead: rec.tokensCacheRead ?? null,
          tokensCacheWrite: rec.tokensCacheWrite ?? null,
          durationMs: Math.max(0, Math.round(rec.durationMs)),
          outcome: rec.outcome,
          estCostUsd: this.estimateCost(rec),
        },
      });
    } catch (err) {
      // A failing ledger must never take the AI layer down (doktrina §10.4).
      this.logger.warn(
        `ai_usage_log upis pao (${rec.module}/${rec.model}): ${(err as Error).message}`,
      );
    }
  }

  /**
   * Sum of input tokens for one user + module since UTC midnight.
   *
   * FAIL-OPEN, deliberately: a ledger read that throws would otherwise 500 every
   * chat/STT/refine call, i.e. a broken bookkeeping table would take the whole AI
   * layer down. Writes are already fail-open; reads now match. Better to run
   * briefly without a budget than to be dead — the ERROR log is the alarm.
   */
  async dailyInputTokens(userId: number, module: string): Promise<number> {
    try {
      const rows = await this.prisma.$queryRaw<{ n: bigint | null }[]>(
        Prisma.sql`SELECT COALESCE(SUM(tokens_in), 0)::bigint AS n
                   FROM ai_usage_log
                   WHERE user_id = ${userId}
                     AND module = ${module}
                     AND outcome <> 'error'
                     AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
      );
      return Number(rows[0]?.n ?? 0);
    } catch (err) {
      this.logger.error(
        `ai_usage_log čitanje (tokeni, ${module}) palo — budžet se privremeno NE primenjuje: ${(err as Error).message}`,
      );
      return 0;
    }
  }

  /** Number of calls for one user + module since UTC midnight. Fail-open (see above). */
  async dailyCalls(userId: number, module: string): Promise<number> {
    try {
      const rows = await this.prisma.$queryRaw<{ n: bigint | null }[]>(
        Prisma.sql`SELECT count(*)::bigint AS n
                   FROM ai_usage_log
                   WHERE user_id = ${userId}
                     AND module = ${module}
                     AND outcome <> 'error'
                     AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
      );
      return Number(rows[0]?.n ?? 0);
    } catch (err) {
      this.logger.error(
        `ai_usage_log čitanje (pozivi, ${module}) palo — budžet se privremeno NE primenjuje: ${(err as Error).message}`,
      );
      return 0;
    }
  }

  /**
   * Potrošene sekunde audija danas. Redovi koji imaju `tokens_in` (audio tokene iz
   * STT odgovora) daju STVARNO trajanje; redovi bez njega (stariji model / izostao
   * `usage`) padaju na procenu `avgSeconds` po pozivu. Fail-open (v. gore).
   */
  async dailySttSeconds(
    userId: number,
    tokensPerSecond: number,
    avgSeconds: number,
  ): Promise<number> {
    try {
      const rows = await this.prisma.$queryRaw<
        { tok: bigint | null; unknown_calls: bigint | null }[]
      >(
        Prisma.sql`SELECT COALESCE(SUM(tokens_in), 0)::bigint AS tok,
                          count(*) FILTER (WHERE tokens_in IS NULL)::bigint AS unknown_calls
                   FROM ai_usage_log
                   WHERE user_id = ${userId}
                     AND module = 'stt'
                     AND outcome <> 'error'
                     AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
      );
      const tok = Number(rows[0]?.tok ?? 0);
      const unknownCalls = Number(rows[0]?.unknown_calls ?? 0);
      const ratio = tokensPerSecond > 0 ? tokensPerSecond : 1;
      return Math.round(tok / ratio + unknownCalls * avgSeconds);
    } catch (err) {
      this.logger.error(
        `ai_usage_log čitanje (STT sekunde) palo — budžet se privremeno NE primenjuje: ${(err as Error).message}`,
      );
      return 0;
    }
  }

  /**
   * `Decimal` cost estimate, or null when the model has no known price.
   *
   * `tokensIn` is the FULL input (fresh + cached), so the cached slices have to be
   * subtracted out before pricing the fresh remainder — otherwise a cache hit would
   * be billed at full rate plus the discounted rate on top.
   */
  private estimateCost(rec: AiUsageRecord): Prisma.Decimal | null {
    if (rec.tokensIn == null && rec.tokensOut == null) return null;
    const price = this.priceFor(rec.model);
    if (!price) return null;
    const cacheRead = Math.max(0, rec.tokensCacheRead ?? 0);
    const cacheWrite = Math.max(0, rec.tokensCacheWrite ?? 0);
    const fresh = Math.max(0, (rec.tokensIn ?? 0) - cacheRead - cacheWrite);
    const usd =
      (fresh * price[0] +
        cacheRead * price[0] * CACHE_READ_MULTIPLIER +
        cacheWrite * price[0] * CACHE_WRITE_MULTIPLIER +
        (rec.tokensOut ?? 0) * price[1]) /
      1_000_000;
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
