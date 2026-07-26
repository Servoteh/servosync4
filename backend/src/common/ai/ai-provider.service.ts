import {
  BadGatewayException,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { CHAT_TITLE_SYSTEM_PROMPT, whisperSerbianPrompt } from "./ai-prompts";
import { fenceUserInput } from "./injection-fence";
import {
  AiUsageService,
  type AiCallContext,
  type AiOutcome,
} from "./ai-usage.service";

/**
 * Zajednički AI provider (Talas B; C/D/G reuse) — port 1.0 edge logike
 * (`ai-chat`, `sastanci-ai-summary`, `stt-transcribe`, `ai-refine`) u NestJS.
 * Ključevi su u BE env (boot-safe: bez ključa → engine `not_configured`/503).
 * Jedini izlaz ka OpenAI/Anthropic; NE dira sy15 (RPC alate izvršava pozivalac
 * kroz `execTool` — GUC most sa identitetom korisnika, doktrina A.2a).
 *
 * ── TALAS AI-0 ──────────────────────────────────────────────────────────────
 * Gateway ostaje jedina tačka izlaza, ali dobija četiri stvari (plan §5 AI-0):
 *  1. `max_tokens` računa i razmišljanje (thinking troši ISTI budžet) — vidi
 *     `maxTokensFor()`; `thinking:{type:"adaptive"}` se šalje SAMO modelima koji
 *     ga podržavaju (haiku-4-5 vraća 400 → ranije latentan 502).
 *  2. `cache_control` breakpoint na definicijama alata i na system promptu.
 *  3. Retry (429/5xx/mreža) + fallback na jeftiniji model iste porodice.
 *  4. Svaki poziv se meri u `ai_usage_log` (AiUsageService, best-effort).
 * Promptovi više NISU ovde — `ai-prompts.ts` (transport ostaje čist).
 */

export type Engine = "openai" | "claude" | "gemini" | "kimi";
export const ENGINES: Engine[] = ["openai", "claude", "gemini", "kimi"];
export const ENGINE_LABEL: Record<Engine, string> = {
  openai: "ChatGPT",
  claude: "Claude",
  gemini: "Gemini",
  kimi: "Kimi",
};

export interface EngineCfg {
  engine: Engine;
  kind: "openai" | "anthropic";
  url: string;
  key: string;
  model: string;
}

export interface ToolDef {
  name: string;
  description: string;
  input: Record<string, unknown>;
}

export type ExecTool = (
  name: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

export interface ChatImage {
  mime: string;
  b64: string;
}

export interface ChatResult {
  reply: string;
  model: string;
  tokensIn: number | null;
  tokensOut: number | null;
}

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const OPENAI_TRANSCRIBE_URL = "https://api.openai.com/v1/audio/transcriptions";
const OPENAI_EMBED_URL = "https://api.openai.com/v1/embeddings";
const EMBED_MODEL = "text-embedding-3-small";
const TITLE_MODEL = "gpt-4o-mini";

/** Budžet SAMO za tekst odgovora. Razmišljanje se dodaje preko `maxTokensFor()`. */
const MAX_OUTPUT_TOKENS = 1200;
const MAX_TOOL_ROUNDS = 6;

/**
 * Claude modeli koji PRIHVATAJU `thinking:{type:"adaptive"}` (generacija 4.6 i
 * novija). Sve ostalo — haiku-4-5, *-4-5, 3.x — vraća 400 na taj parametar;
 * `budget_tokens` je na 4.7+ uklonjen, pa je jedina kontrola `max_tokens`.
 */
const ADAPTIVE_THINKING_MODELS = [
  "claude-fable-5",
  "claude-mythos-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
];

/**
 * Modeli koji razmišljaju i kad `thinking` UOPŠTE nije poslat (Claude 5
 * generacija). Zbog njih je `MAX_OUTPUT_TOKENS=1200` tiho sekao odgovore:
 * razmišljanje i tekst dele isti `max_tokens`.
 */
const THINKS_BY_DEFAULT_MODELS = [
  "claude-fable-5",
  "claude-mythos-5",
  "claude-opus-5",
  "claude-sonnet-5",
];

/** HTTP statusi vredni jednog ponavljanja (ostalo je greška zahteva). */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

const startsWithAny = (model: string, list: string[]): boolean =>
  list.some((m) => model.startsWith(m));

export const supportsAdaptiveThinking = (model: string): boolean =>
  startsWithAny(model, ADAPTIVE_THINKING_MODELS);

export const thinksByDefault = (model: string): boolean =>
  startsWithAny(model, THINKS_BY_DEFAULT_MODELS);

/** Rezerva tokena za razmišljanje PORED traženog budžeta odgovora. */
function thinkingHeadroom(): number {
  const n = Number(process.env.AI_THINKING_HEADROOM_TOKENS);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 8000;
}

/**
 * `max_tokens` je tvrd plafon na RAZMIŠLJANJE + TEKST. Da bi odgovor uvek imao
 * `answerTokens` na raspolaganju, modelima koji razmišljaju dodajemo rezervu.
 * `explicitThinking` = pozivalac šalje `thinking:{type:"adaptive"}` sam.
 */
export function maxTokensFor(
  model: string,
  answerTokens: number,
  explicitThinking = false,
): number {
  const thinks = explicitThinking
    ? supportsAdaptiveThinking(model)
    : thinksByDefault(model);
  return thinks ? answerTokens + thinkingHeadroom() : answerTokens;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `claude-haiku-4-5-20251001` → `claude-haiku-4-5` (datirani snapshot = isti model). */
export const canonicalModel = (model: string): string =>
  model.replace(/-\d{8}$/, "");

/** Razlaganje tokena jednog poziva za `ai_usage_log`. */
export interface AiTokenBreakdown {
  tokensIn: number | null;
  tokensOut: number | null;
  tokensCacheRead?: number | null;
  tokensCacheWrite?: number | null;
}

/**
 * Audio tokeni iz STT odgovora (`gpt-4o-transcribe` vraća
 * `usage.input_token_details.audio_tokens`). Iz njih AiLimitsService izvodi
 * STVARNO trajanje snimka, umesto grube procene „poziv = prosečnih N sekundi".
 * `whisper-1` ne vraća `usage` — tada je null i pada se na procenu.
 */
export function sttAudioTokens(data: unknown): number | null {
  const u = (
    data as { usage?: { input_token_details?: { audio_tokens?: unknown } } }
  )?.usage;
  const n = Number(u?.input_token_details?.audio_tokens);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/* Provider barata dinamičnim JSON-om OpenAI/Anthropic API-ja — `any` je inherentan. */
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument */

interface JsonCallOptions {
  url: string;
  headers: Record<string, string>;
  /** Telo BEZ `max_tokens`/`thinking` kad je dat `answerTokens` — izvode se po pokušaju. */
  body: Record<string, unknown>;
  provider: "openai" | "anthropic";
  ctx?: AiCallContext;
  /** Model iste porodice na koji se pada posle iscrpljenog retry-ja. */
  fallbackModel?: string | null;
  /**
   * Budžet SAMO za tekst odgovora. Kad je dat, `max_tokens` (i `thinking`) se
   * računaju ZA SVAKI POKUŠAJ POSEBNO — inače bi primarni model diktirao
   * parametre fallback modelu (haiku bi dobio `thinking:adaptive` → 400, a
   * model koji razmišlja bi nasledio mali `max_tokens` → odsečen odgovor).
   */
  answerTokens?: number;
  /** Pozivalac TRAŽI adaptivno razmišljanje (šalje se samo modelima koji ga primaju). */
  explicitThinking?: boolean;
  /** Izvuci tokene iz odgovora radi `ai_usage_log`. */
  usageOf: (data: any) => AiTokenBreakdown;
}

@Injectable()
export class AiProviderService {
  private readonly logger = new Logger(AiProviderService.name);

  /**
   * `@Optional()` namerno: postojeći unit testovi prave `new AiProviderService()`
   * bez DI, a merenje je best-effort — bez ledger-a gateway i dalje radi.
   */
  constructor(@Optional() private readonly usage?: AiUsageService) {}

  private env(name: string): string {
    return process.env[name] ?? "";
  }

  /** Konfiguracija engine-a ili null ako ključ nije postavljen (→ not_configured/503). */
  engineConfig(engine: Engine): EngineCfg | null {
    const openaiKey = this.env("OPENAI_API_KEY");
    const anthropicKey = this.env("ANTHROPIC_API_KEY");
    const geminiKey = this.env("GEMINI_API_KEY");
    const moonshotKey = this.env("MOONSHOT_API_KEY");
    const geminiUrl =
      (this.env("GEMINI_BASE_URL") ||
        "https://generativelanguage.googleapis.com/v1beta/openai") +
      "/chat/completions";
    const moonshotUrl =
      (this.env("MOONSHOT_BASE_URL") || "https://api.moonshot.ai/v1") +
      "/chat/completions";
    switch (engine) {
      case "openai":
        return openaiKey
          ? {
              engine,
              kind: "openai",
              url: OPENAI_URL,
              key: openaiKey,
              model: this.env("AI_CHAT_MODEL") || "gpt-4o-mini",
            }
          : null;
      case "claude":
        return anthropicKey
          ? {
              engine,
              kind: "anthropic",
              url: ANTHROPIC_URL,
              key: anthropicKey,
              model: this.env("AI_CHAT_CLAUDE_MODEL") || "claude-sonnet-5",
            }
          : null;
      case "gemini":
        return geminiKey
          ? {
              engine,
              kind: "openai",
              url: geminiUrl,
              key: geminiKey,
              model: this.env("AI_CHAT_GEMINI_MODEL") || "gemini-2.0-flash",
            }
          : null;
      case "kimi":
        return moonshotKey
          ? {
              engine,
              kind: "openai",
              url: moonshotUrl,
              key: moonshotKey,
              model: this.env("AI_CHAT_KIMI_MODEL") || "kimi-latest",
            }
          : null;
      default:
        return null;
    }
  }

  /**
   * Engine-i koji STVARNO imaju ključ (Talas AI-0, stavka 7a). FE nudi samo njih —
   * Gemini/Kimi dugmad su do sada garantovano vraćala 503.
   */
  configuredEngines(): Engine[] {
    return ENGINES.filter((e) => this.engineConfig(e) !== null);
  }

  /**
   * Rezervni model iste porodice (fallback posle iscrpljenog retry-ja). Poređenje
   * ide nad KANONSKIM imenom (bez datiranog sufiksa) — trijaža koristi
   * `claude-haiku-4-5-20251001`, pa bi bez ovoga „fallback" bio isti model pod
   * drugim ID-em, tj. drugi uzaludan par pokušaja.
   */
  private fallbackFor(
    kind: "openai" | "anthropic",
    model: string,
  ): string | null {
    const fb =
      kind === "anthropic"
        ? this.env("AI_FALLBACK_CLAUDE_MODEL") || "claude-haiku-4-5"
        : this.env("AI_FALLBACK_OPENAI_MODEL") || "gpt-4o-mini";
    if (!fb) return null;
    return canonicalModel(fb) === canonicalModel(model) ? null : fb;
  }

  /** Telo zahteva ZA JEDAN POKUŠAJ — `max_tokens`/`thinking` po ciljnom modelu. */
  private bodyForAttempt(o: JsonCallOptions, model: string): string {
    const body: Record<string, unknown> = { ...o.body, model };
    if (o.answerTokens != null) {
      const wantsThinking = o.explicitThinking === true;
      body.max_tokens = maxTokensFor(model, o.answerTokens, wantsThinking);
      if (wantsThinking && supportsAdaptiveThinking(model)) {
        body.thinking = { type: "adaptive" };
      } else {
        delete body.thinking;
      }
    }
    return JSON.stringify(body);
  }

  /**
   * Jedina tačka HTTP poziva ka LLM-u: 1 retry na 429/5xx/mrežni pad, pa fallback
   * na rezervni model iste porodice, pa 502. Svaki pokušaj se meri u `ai_usage_log`.
   * NE koristi se za STT ni embeddings (nemaju parnjaka — plan §5 AI-0.3).
   */
  private async callJson(o: JsonCallOptions): Promise<any> {
    const primary =
      typeof o.body.model === "string" ? o.body.model : String(o.body.model);
    const attempts: { model: string; isFallback: boolean }[] = [
      { model: primary, isFallback: false },
    ];
    if (
      o.fallbackModel &&
      canonicalModel(o.fallbackModel) !== canonicalModel(primary)
    ) {
      attempts.push({ model: o.fallbackModel, isFallback: true });
    }
    const module = o.ctx?.module ?? "unknown";
    let lastRetryable = false;

    for (const attempt of attempts) {
      // Fallback se pokreće SAMO posle prolazne greške; 400/401/422 bi pao isto.
      if (attempt.isFallback && !lastRetryable) break;
      if (attempt.isFallback) {
        this.logger.warn(
          `AI fallback [${module}]: ${primary} → ${attempt.model} (posle retry-ja).`,
        );
      }
      // Telo se gradi PO POKUŠAJU: fallback model dobija svoj `max_tokens` i
      // svoje `thinking` (v. `bodyForAttempt`), ne primarne parametre.
      const payload = this.bodyForAttempt(o, attempt.model);

      for (let tryNo = 0; tryNo <= 1; tryNo++) {
        const t0 = Date.now();
        let res: Response;
        try {
          res = await fetch(o.url, {
            method: "POST",
            headers: o.headers,
            body: payload,
          });
        } catch (err) {
          lastRetryable = true;
          this.log(o, attempt.model, t0, "error", null, null);
          this.logger.warn(
            `AI mrežni pad [${module}/${attempt.model}] pokušaj ${tryNo + 1}: ${(err as Error).message}`,
          );
          if (tryNo === 0) {
            await sleep(this.backoffMs(tryNo));
            continue;
          }
          break;
        }

        if (res.ok) {
          let data: any;
          try {
            data = await res.json();
          } catch (err) {
            // Prekinut/neispravan JSON je prolazna greška kao i mrežni pad —
            // 200 sa polovičnim telom ne sme da prođe kao uspeh.
            lastRetryable = true;
            this.log(o, attempt.model, t0, "error", null, null);
            this.logger.warn(
              `AI telo odgovora nečitljivo [${module}/${attempt.model}] pokušaj ${tryNo + 1}: ${(err as Error).message}`,
            );
            if (tryNo === 0) {
              await sleep(this.backoffMs(tryNo));
              continue;
            }
            break;
          }
          const u = o.usageOf(data);
          this.log(
            o,
            attempt.model,
            t0,
            attempt.isFallback ? "fallback" : "ok",
            u.tokensIn,
            u.tokensOut,
            u.tokensCacheRead,
            u.tokensCacheWrite,
          );
          return data;
        }

        lastRetryable = RETRYABLE_STATUS.has(res.status);
        this.log(o, attempt.model, t0, "error", null, null);
        this.logger.warn(
          `AI upstream ${res.status} [${module}/${attempt.model}] pokušaj ${tryNo + 1}${
            lastRetryable ? "" : " (nije za ponavljanje)"
          }.`,
        );
        if (lastRetryable && tryNo === 0) {
          await sleep(this.backoffMs(tryNo, res));
          continue;
        }
        break;
      }
    }
    throw new BadGatewayException("upstream_error");
  }

  /** Kratak backoff; poštuje `Retry-After` ako ga provajder pošalje (max 4 s). */
  private backoffMs(tryNo: number, res?: Response): number {
    const hdr = Number(res?.headers?.get?.("retry-after"));
    if (Number.isFinite(hdr) && hdr > 0) return Math.min(hdr * 1000, 4000);
    return 400 * (tryNo + 1) + Math.floor(Math.random() * 200);
  }

  private log(
    o: Pick<JsonCallOptions, "provider" | "ctx">,
    model: string,
    startedAt: number,
    outcome: AiOutcome,
    tokensIn: number | null,
    tokensOut: number | null,
    tokensCacheRead: number | null = null,
    tokensCacheWrite: number | null = null,
  ): void {
    this.logUsage(
      o.ctx,
      o.provider,
      model,
      startedAt,
      outcome,
      tokensIn,
      tokensOut,
      tokensCacheRead,
      tokensCacheWrite,
    );
  }

  private logUsage(
    ctx: AiCallContext | undefined,
    provider: "openai" | "anthropic",
    model: string,
    startedAt: number,
    outcome: AiOutcome,
    tokensIn: number | null,
    tokensOut: number | null,
    tokensCacheRead: number | null = null,
    tokensCacheWrite: number | null = null,
  ): void {
    // Merenje je best-effort i NIKAD ne sme da obori AI poziv — `record` već ima
    // svoj try/catch, ali `catch` ovde štiti i od neuhvaćenog odbijanja obećanja.
    void this.usage
      ?.record({
        module: ctx?.module ?? "unknown",
        userId: ctx?.userId ?? null,
        provider,
        model,
        tokensIn,
        tokensOut,
        tokensCacheRead,
        tokensCacheWrite,
        durationMs: Date.now() - startedAt,
        outcome,
      })
      ?.catch(() => {
        /* ledger ne obara gateway */
      });
  }

  private anthropicHeaders(key: string): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    };
  }

  /**
   * System prompt kao blok sa `cache_control` breakpoint-om (Talas AI-0, stavka 2).
   * Redosled renderovanja je `tools` → `system` → `messages`, pa breakpoint na
   * system-u kešira i alate i prompt; alati dodatno nose svoj (stabilan) breakpoint.
   * Sadržaj prompta je nepromenjen — marker ne menja ponašanje modela.
   */
  private cachedSystem(system: string): unknown[] {
    return [
      { type: "text", text: system, cache_control: { type: "ephemeral" } },
    ];
  }

  /** Poslednja definicija alata nosi breakpoint → ceo blok šema se kešira. */
  private cachedTools(tools: unknown[]): unknown[] {
    if (!tools.length) return tools;
    const out = tools.slice();
    out[out.length - 1] = {
      ...(out[out.length - 1] as Record<string, unknown>),
      cache_control: { type: "ephemeral" },
    };
    return out;
  }

  /**
   * Anthropic usage → razložen ulaz. `tokensIn` je PUN zbir (svež + keš-čitanje +
   * keš-upis) jer dnevni budžet NAMERNO broji sirovi kontekst koji je model video:
   * keširanje snižava CENU, ali ne i količinu konteksta koju korisnik troši, pa
   * budžet ne sme da se „resetuje" samo zato što je prompt keširan. Razložene
   * kolone služe za tačnu procenu cene (keš-čitanje ×0,1; keš-upis ×1,25).
   */
  private anthropicUsage(d: any): AiTokenBreakdown {
    const cacheRead: number = d?.usage?.cache_read_input_tokens ?? 0;
    const cacheWrite: number = d?.usage?.cache_creation_input_tokens ?? 0;
    return {
      tokensIn: (d?.usage?.input_tokens ?? 0) + cacheRead + cacheWrite,
      tokensOut: d?.usage?.output_tokens ?? 0,
      tokensCacheRead: cacheRead,
      tokensCacheWrite: cacheWrite,
    };
  }

  /** Embedding upita/sadržaja (text-embedding-3-small); null ako padne → pretraga svede na FTS. */
  async embed(text: string, ctx?: AiCallContext): Promise<string | null> {
    const key = this.env("OPENAI_API_KEY");
    if (!key) return null;
    const t0 = Date.now();
    try {
      const res = await fetch(OPENAI_EMBED_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: EMBED_MODEL,
          input: text.slice(0, 8000),
        }),
      });
      if (!res.ok) {
        this.logUsage(ctx, "openai", EMBED_MODEL, t0, "error", null, null);
        return null;
      }
      const data: any = await res.json();
      this.logUsage(
        ctx,
        "openai",
        EMBED_MODEL,
        t0,
        "ok",
        data?.usage?.prompt_tokens ?? null,
        null,
      );
      const v = data?.data?.[0]?.embedding;
      return Array.isArray(v) ? JSON.stringify(v) : null;
    } catch {
      this.logUsage(ctx, "openai", EMBED_MODEL, t0, "error", null, null);
      return null;
    }
  }

  /** Kratak naslov nove lične niti (gpt-4o-mini; pad ne ruši slanje). */
  async generateTitle(
    message: string,
    reply: string,
    ctx?: AiCallContext,
  ): Promise<string | null> {
    const key = this.env("OPENAI_API_KEY");
    if (!key) return null;
    const t0 = Date.now();
    try {
      const res = await fetch(OPENAI_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: TITLE_MODEL,
          temperature: 0.2,
          max_tokens: 24,
          messages: [
            { role: "system", content: CHAT_TITLE_SYSTEM_PROMPT },
            {
              role: "user",
              content: `Pitanje: ${message.slice(0, 400)}\nOdgovor: ${reply.slice(0, 400)}`,
            },
          ],
        }),
      });
      if (!res.ok) {
        this.logUsage(ctx, "openai", TITLE_MODEL, t0, "error", null, null);
        return null;
      }
      const data: any = await res.json();
      this.logUsage(
        ctx,
        "openai",
        TITLE_MODEL,
        t0,
        "ok",
        data?.usage?.prompt_tokens ?? null,
        data?.usage?.completion_tokens ?? null,
      );
      const t = String(data?.choices?.[0]?.message?.content || "")
        .trim()
        .replace(/^["„]|["“”]$/g, "");
      return t && t.length <= 80 ? t : null;
    } catch {
      this.logUsage(ctx, "openai", TITLE_MODEL, t0, "error", null, null);
      return null;
    }
  }

  /**
   * Tool-use petlja (port edge `callEngine`) — 2 puta: anthropic-kind i openai-kind
   * (gemini/kimi su OpenAI-kompatibilni). `execTool` izvršava alat kod pozivaoca
   * (sy15 RPC kroz GUC + identitet korisnika); provider ne zna za bazu. Baca 502
   * (upstream) / 503 (engine nije konfigurisan) preko `run` ulaza.
   */
  async chatWithTools(
    cfg: EngineCfg,
    history: Array<{ role: string; content: string }>,
    message: string,
    tools: ToolDef[],
    system: string,
    image: ChatImage | null,
    execTool: ExecTool,
    ctx?: AiCallContext,
  ): Promise<ChatResult> {
    const historyTurns: any[] = history.map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content,
    }));
    let tokensIn = 0;
    let tokensOut = 0;
    const fallbackModel = this.fallbackFor(cfg.kind, cfg.model);

    if (cfg.kind === "anthropic") {
      const userContent: any = image
        ? [
            { type: "text", text: message },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: image.mime,
                data: image.b64,
              },
            },
          ]
        : message;
      const anthropicTools = this.cachedTools(
        tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.input,
        })),
      );
      const msgs: any[] = [
        ...historyTurns,
        { role: "user", content: userContent },
      ];
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        const useTools = round < MAX_TOOL_ROUNDS;
        const data: any = await this.callJson({
          url: cfg.url,
          headers: this.anthropicHeaders(cfg.key),
          provider: "anthropic",
          ctx,
          fallbackModel,
          usageOf: (d) => this.anthropicUsage(d),
          // Razmišljanje i tekst dele budžet — odgovoru mora ostati 1200 tokena;
          // `max_tokens` se računa po modelu koji stvarno izvršava pokušaj.
          answerTokens: MAX_OUTPUT_TOKENS,
          body: {
            model: cfg.model,
            system: this.cachedSystem(system),
            messages: msgs,
            ...(useTools ? { tools: anthropicTools } : {}),
          },
        });
        if (data?.stop_reason === "refusal") {
          throw new UnprocessableEntityException(
            "Model je odbio da odgovori na ovo pitanje. Preformuliši ga ili probaj drugi engine.",
          );
        }
        if (data?.stop_reason === "max_tokens") {
          throw new UnprocessableEntityException(
            "Odgovor je predugačak i prekinut je. Postavi uže pitanje ili ga podeli na dva.",
          );
        }
        const u = this.anthropicUsage(data);
        tokensIn += u.tokensIn ?? 0;
        tokensOut += u.tokensOut ?? 0;
        if (data?.stop_reason === "tool_use") {
          msgs.push({ role: "assistant", content: data.content });
          const results: any[] = [];
          for (const block of data.content || []) {
            if (block?.type !== "tool_use") continue;
            const out = await execTool(block.name, block.input);
            results.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: this.toolResultString(out),
            });
          }
          msgs.push({ role: "user", content: results });
          continue;
        }
        const reply = (data?.content || [])
          .filter((b: any) => b?.type === "text")
          .map((b: any) => b.text)
          .join("")
          .trim();
        return { reply, model: cfg.model, tokensIn, tokensOut };
      }
      throw new BadGatewayException("upstream_error");
    }

    // OpenAI-kompatibilni put: openai, gemini, kimi.
    const userContent: any = image
      ? [
          { type: "text", text: message },
          {
            type: "image_url",
            image_url: { url: `data:${image.mime};base64,${image.b64}` },
          },
        ]
      : message;
    const openaiTools = tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input,
      },
    }));
    const msgs: any[] = [
      { role: "system", content: system },
      ...historyTurns,
      { role: "user", content: userContent },
    ];
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const useTools = round < MAX_TOOL_ROUNDS;
      const data: any = await this.callJson({
        url: cfg.url,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.key}`,
        },
        provider: "openai",
        ctx,
        // Gemini/Kimi su OpenAI-kompatibilni, ali tuđi hostovi — bez fallback modela.
        fallbackModel: cfg.engine === "openai" ? fallbackModel : null,
        usageOf: (d: any) => ({
          tokensIn: d?.usage?.prompt_tokens ?? 0,
          tokensOut: d?.usage?.completion_tokens ?? 0,
        }),
        body: {
          model: cfg.model,
          temperature: 0.5,
          max_tokens: MAX_OUTPUT_TOKENS,
          messages: msgs,
          ...(useTools ? { tools: openaiTools } : {}),
        },
      });
      tokensIn += data?.usage?.prompt_tokens ?? 0;
      tokensOut += data?.usage?.completion_tokens ?? 0;
      const msg = data?.choices?.[0]?.message;
      if (msg?.tool_calls?.length) {
        msgs.push(msg);
        for (const tc of msg.tool_calls) {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc?.function?.arguments || "{}");
          } catch {
            /* prazno */
          }
          const out = await execTool(tc?.function?.name, args);
          msgs.push({
            role: "tool",
            tool_call_id: tc.id,
            content: this.toolResultString(out),
          });
        }
        continue;
      }
      return {
        reply: String(msg?.content || "").trim(),
        model: cfg.model,
        tokensIn,
        tokensOut,
      };
    }
    throw new BadGatewayException("upstream_error");
  }

  /**
   * Anthropic one-shot sa OBAVEZNIM alatom (port edge `montaza-izvestaj-ai` — TALAS C).
   * `tool_choice: {type:'tool', name}` forsira strukturisan izlaz; vraćamo `input`
   * bloka `tool_use`. Vision blokovi (base64 slike) idu u `content`. Identičan model/
   * limiti/schema kao 1.0 edge — pozivalac (PlanMontazeService) validira limite i
   * allowlist PRE poziva. Greške mapirane kao edge: refusal/max_tokens → 422,
   * parse_failed/upstream → 502, bez ključa → 503.
   */
  async extractWithTool(opts: {
    model: string;
    system: string;
    tool: {
      name: string;
      description: string;
      input_schema: Record<string, unknown>;
    };
    content: unknown[];
    maxTokens?: number;
    ctx?: AiCallContext;
  }): Promise<{
    toolInput: Record<string, unknown>;
    model: string;
    usage: unknown;
  }> {
    const key = this.env("ANTHROPIC_API_KEY");
    if (!key) {
      throw new ServiceUnavailableException(
        "ANTHROPIC_API_KEY nije postavljen na serveru.",
      );
    }
    const data: any = await this.callJson({
      url: ANTHROPIC_URL,
      headers: this.anthropicHeaders(key),
      provider: "anthropic",
      ctx: opts.ctx,
      fallbackModel: this.fallbackFor("anthropic", opts.model),
      usageOf: (d) => this.anthropicUsage(d),
      // Modeli 5. generacije razmišljaju i bez `thinking` — bez rezerve bi
      // strukturisan izlaz padao na `max_tokens` (422 „Odgovor je predugačak").
      answerTokens: opts.maxTokens ?? 4000,
      body: {
        model: opts.model,
        system: this.cachedSystem(opts.system),
        tools: this.cachedTools([opts.tool]),
        tool_choice: { type: "tool", name: opts.tool.name },
        messages: [{ role: "user", content: opts.content }],
      },
    });
    if (data?.stop_reason === "refusal") {
      throw new UnprocessableEntityException("Model je odbio zahtev.");
    }
    if (data?.stop_reason === "max_tokens") {
      throw new UnprocessableEntityException(
        "Odgovor je predugačak (max_tokens) — suzi tekst/broj fotki.",
      );
    }
    const block = Array.isArray(data?.content)
      ? data.content.find(
          (b: any) => b?.type === "tool_use" && b?.name === opts.tool.name,
        )
      : null;
    if (!block || typeof block.input !== "object") {
      throw new BadGatewayException("parse_failed");
    }
    return {
      toolInput: block.input as Record<string, unknown>,
      model: data?.model || opts.model,
      usage: data?.usage ?? null,
    };
  }

  /** Anthropic one-shot rezime (port `sastanci-ai-summary`). */
  async summarize(
    model: string,
    system: string,
    userContent: string,
    ctx?: AiCallContext,
  ): Promise<{ summary: string; model: string; usage: unknown }> {
    const key = this.env("ANTHROPIC_API_KEY");
    if (!key) {
      throw new ServiceUnavailableException(
        "ANTHROPIC_API_KEY nije postavljen na serveru.",
      );
    }
    // `thinking:{type:"adaptive"}` je 400 na haiku-4-5 (a on JE u allowlist-i) —
    // do sada latentan 502 na ovom putu. `callJson` ga uključuje/izbacuje PO
    // POKUŠAJU, pa i fallback model dobija parametre koje sam prima.
    const data: any = await this.callJson({
      url: ANTHROPIC_URL,
      headers: this.anthropicHeaders(key),
      provider: "anthropic",
      ctx,
      fallbackModel: this.fallbackFor("anthropic", model),
      usageOf: (d) => this.anthropicUsage(d),
      answerTokens: 4000,
      explicitThinking: true,
      body: {
        model,
        system: this.cachedSystem(system),
        messages: [{ role: "user", content: userContent }],
      },
    });
    if (data?.stop_reason === "refusal") {
      throw new UnprocessableEntityException("Model je odbio zahtev.");
    }
    const summary = Array.isArray(data?.content)
      ? data.content
          .filter((b: any) => b?.type === "text")
          .map((b: any) => b.text)
          .join("\n")
          .trim()
      : "";
    if (!summary) throw new BadGatewayException("empty_summary");
    return { summary, model: data?.model || model, usage: data?.usage ?? null };
  }

  /**
   * OpenAI Whisper STT (port `stt-transcribe`). BEZ fallback modela — STT nema
   * parnjaka u drugoj porodici (plan §5 AI-0.3); jedan retry na prolaznu grešku ima.
   */
  async transcribe(input: {
    bytes: Uint8Array;
    mime: string;
    lang?: string;
    context?: string;
    ctx?: AiCallContext;
  }): Promise<{ text: string; model: string }> {
    const key = this.env("OPENAI_API_KEY");
    if (!key) {
      throw new ServiceUnavailableException(
        "OPENAI_API_KEY nije postavljen na serveru.",
      );
    }
    const model = this.env("STT_MODEL") || "gpt-4o-transcribe";
    const extByMime: Record<string, string> = {
      "audio/mp4": "mp4",
      "audio/aac": "aac",
      "audio/mpeg": "mp3",
      "audio/webm": "webm",
      "audio/ogg": "ogg",
      "audio/wav": "wav",
      "audio/x-wav": "wav",
    };
    const mime = input.mime.split(";")[0].toLowerCase();
    const ext = extByMime[mime] || "webm";
    const lang = /^[a-z]{2}$/.test(input.lang || "") ? input.lang! : "sr";

    const buildForm = () => {
      const form = new FormData();
      form.append(
        "file",
        new Blob([new Uint8Array(input.bytes)], { type: mime }),
        `snimak.${ext}`,
      );
      form.append("model", model);
      form.append("language", lang);
      form.append("response_format", "json");
      if (lang === "sr") {
        form.append("prompt", whisperSerbianPrompt(input.context));
      }
      return form;
    };

    let data: any = null;
    let networkFail = false;
    for (let tryNo = 0; tryNo <= 1; tryNo++) {
      const t0 = Date.now();
      let res: Response;
      try {
        res = await fetch(OPENAI_TRANSCRIBE_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}` },
          body: buildForm(),
        });
      } catch (err) {
        networkFail = true;
        this.logUsage(input.ctx, "openai", model, t0, "error", null, null);
        this.logger.warn(
          `STT mrežni pad pokušaj ${tryNo + 1}: ${(err as Error).message}`,
        );
        if (tryNo === 0) {
          await sleep(this.backoffMs(tryNo));
          continue;
        }
        break;
      }
      if (res.ok) {
        try {
          data = await res.json();
        } catch (err) {
          networkFail = true;
          this.logUsage(input.ctx, "openai", model, t0, "error", null, null);
          this.logger.warn(
            `STT telo odgovora nečitljivo pokušaj ${tryNo + 1}: ${(err as Error).message}`,
          );
          if (tryNo === 0) {
            await sleep(this.backoffMs(tryNo));
            continue;
          }
          break;
        }
        // `tokens_in` za STT nosi AUDIO tokene iz odgovora — iz njih se izvodi
        // stvarno trajanje snimka za dnevni budžet (v. AiLimitsService).
        this.logUsage(
          input.ctx,
          "openai",
          model,
          t0,
          "ok",
          sttAudioTokens(data),
          null,
        );
        networkFail = false;
        break;
      }
      this.logUsage(input.ctx, "openai", model, t0, "error", null, null);
      this.logger.warn(`STT upstream ${res.status} pokušaj ${tryNo + 1}.`);
      if (RETRYABLE_STATUS.has(res.status) && tryNo === 0) {
        await sleep(this.backoffMs(tryNo, res));
        continue;
      }
      break;
    }
    if (!data) {
      throw new BadGatewayException(
        networkFail ? "upstream_unreachable" : "upstream_error",
      );
    }
    const text = String(data?.text || "").trim();
    if (!text) {
      throw new UnprocessableEntityException("Nije prepoznat govor u snimku.");
    }
    return { text, model };
  }

  /** OpenAI „✨ Dotera tekst" (port `ai-refine`). */
  async refine(
    tekst: string,
    system: string,
    ctx?: AiCallContext,
  ): Promise<{ text: string; model: string }> {
    const key = this.env("OPENAI_API_KEY");
    if (!key) {
      throw new ServiceUnavailableException("OPENAI_API_KEY nije postavljen.");
    }
    const model = this.env("AI_REFINE_MODEL") || "gpt-4o-mini";
    const data: any = await this.callJson({
      url: OPENAI_URL,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      provider: "openai",
      ctx,
      fallbackModel: this.fallbackFor("openai", model),
      usageOf: (d: any) => ({
        tokensIn: d?.usage?.prompt_tokens ?? null,
        tokensOut: d?.usage?.completion_tokens ?? null,
      }),
      body: {
        model,
        temperature: 0.3,
        max_tokens: Math.min(2000, Math.ceil(tekst.length / 2) + 300),
        messages: [
          { role: "system", content: system },
          { role: "user", content: tekst },
        ],
      },
    });
    const out = String(data?.choices?.[0]?.message?.content || "").trim();
    if (!out) throw new BadGatewayException("empty_output");
    return { text: out, model };
  }

  /**
   * Skrati preduge JSON rezultate alata da ne raznesu kontekst (port) i obmotaj ih
   * ogradom (Talas AI-0, stavka 6): alati vraćaju slobodan tekst iz baze — uputstva,
   * beleške, prijave kvarova — što je kanal za uskladištenu injekciju.
   */
  private toolResultString(out: unknown): string {
    const s = JSON.stringify(out);
    const trimmed =
      s.length > 15000 ? s.slice(0, 15000) + "…[skraćeno — suzi upit]" : s;
    return fenceUserInput(trimmed);
  }
}
