import {
  BadGatewayException,
  Injectable,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";

/**
 * Zajednički AI provider (Talas B; C/D/G reuse) — port 1.0 edge logike
 * (`ai-chat`, `sastanci-ai-summary`, `stt-transcribe`, `ai-refine`) u NestJS.
 * Ključevi su u BE env (boot-safe: bez ključa → engine `not_configured`/503).
 * Jedini izlaz ka OpenAI/Anthropic; NE dira sy15 (RPC alate izvršava pozivalac
 * kroz `execTool` — GUC most sa identitetom korisnika, doktrina A.2a).
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
const MAX_OUTPUT_TOKENS = 1200;
const MAX_TOOL_ROUNDS = 6;

/* Provider barata dinamičnim JSON-om OpenAI/Anthropic API-ja — `any` je inherentan. */
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument */

@Injectable()
export class AiProviderService {
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

  /** Embedding upita/sadržaja (text-embedding-3-small); null ako padne → pretraga svede na FTS. */
  async embed(text: string): Promise<string | null> {
    const key = this.env("OPENAI_API_KEY");
    if (!key) return null;
    try {
      const res = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: "text-embedding-3-small",
          input: text.slice(0, 8000),
        }),
      });
      if (!res.ok) return null;
      const data: any = await res.json();
      const v = data?.data?.[0]?.embedding;
      return Array.isArray(v) ? JSON.stringify(v) : null;
    } catch {
      return null;
    }
  }

  /** Kratak naslov nove lične niti (gpt-4o-mini; pad ne ruši slanje). */
  async generateTitle(message: string, reply: string): Promise<string | null> {
    const key = this.env("OPENAI_API_KEY");
    if (!key) return null;
    try {
      const res = await fetch(OPENAI_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          temperature: 0.2,
          max_tokens: 24,
          messages: [
            {
              role: "system",
              content:
                "Vrati SAMO kratak naslov razgovora (2–5 reči, srpski, latinica, bez navodnika i tačke).",
            },
            {
              role: "user",
              content: `Pitanje: ${message.slice(0, 400)}\nOdgovor: ${reply.slice(0, 400)}`,
            },
          ],
        }),
      });
      if (!res.ok) return null;
      const data: any = await res.json();
      const t = String(data?.choices?.[0]?.message?.content || "")
        .trim()
        .replace(/^["„]|["“”]$/g, "");
      return t && t.length <= 80 ? t : null;
    } catch {
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
  ): Promise<ChatResult> {
    const historyTurns: any[] = history.map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content,
    }));
    let tokensIn = 0;
    let tokensOut = 0;

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
      const anthropicTools = tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input,
      }));
      const msgs: any[] = [
        ...historyTurns,
        { role: "user", content: userContent },
      ];
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        const useTools = round < MAX_TOOL_ROUNDS;
        const res = await fetch(cfg.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": cfg.key,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: cfg.model,
            max_tokens: MAX_OUTPUT_TOKENS,
            system,
            messages: msgs,
            ...(useTools ? { tools: anthropicTools } : {}),
          }),
        });
        if (!res.ok) throw new BadGatewayException("upstream_error");
        const data: any = await res.json();
        tokensIn += data?.usage?.input_tokens ?? 0;
        tokensOut += data?.usage?.output_tokens ?? 0;
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
      const res = await fetch(cfg.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.key}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          temperature: 0.5,
          max_tokens: MAX_OUTPUT_TOKENS,
          messages: msgs,
          ...(useTools ? { tools: openaiTools } : {}),
        }),
      });
      if (!res.ok) throw new BadGatewayException("upstream_error");
      const data: any = await res.json();
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

  /** Anthropic one-shot rezime (port `sastanci-ai-summary`). */
  async summarize(
    model: string,
    system: string,
    userContent: string,
  ): Promise<{ summary: string; model: string; usage: unknown }> {
    const key = this.env("ANTHROPIC_API_KEY");
    if (!key) {
      throw new ServiceUnavailableException(
        "ANTHROPIC_API_KEY nije postavljen na serveru.",
      );
    }
    let res: Response;
    try {
      res = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 4000,
          thinking: { type: "adaptive" },
          system,
          messages: [{ role: "user", content: userContent }],
        }),
      });
    } catch {
      throw new BadGatewayException("upstream_unreachable");
    }
    if (!res.ok) throw new BadGatewayException("upstream_error");
    const data: any = await res.json();
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

  /** OpenAI Whisper STT (port `stt-transcribe`). */
  async transcribe(input: {
    bytes: Uint8Array;
    mime: string;
    lang?: string;
    context?: string;
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
      const ctx = input.context || "zapisnik";
      form.append(
        "prompt",
        ctx === "chat"
          ? "Neformalna poruka na srpskom jeziku, latinicom — svakodnevni razgovor, pitanja o poslu i aplikaciji."
          : "Servisni zapisnik na srpskom jeziku, latinicom. Radni nalozi i predmeti se pišu ciframa, npr. 9400/2, TP 1/430, presa 350t.",
      );
    }
    let res: Response;
    try {
      res = await fetch(OPENAI_TRANSCRIBE_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: form,
      });
    } catch {
      throw new BadGatewayException("upstream_unreachable");
    }
    if (!res.ok) throw new BadGatewayException("upstream_error");
    const data: any = await res.json();
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
  ): Promise<{ text: string; model: string }> {
    const key = this.env("OPENAI_API_KEY");
    if (!key) {
      throw new ServiceUnavailableException("OPENAI_API_KEY nije postavljen.");
    }
    const model = this.env("AI_REFINE_MODEL") || "gpt-4o-mini";
    let res: Response;
    try {
      res = await fetch(OPENAI_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model,
          temperature: 0.3,
          max_tokens: Math.min(2000, Math.ceil(tekst.length / 2) + 300),
          messages: [
            { role: "system", content: system },
            { role: "user", content: tekst },
          ],
        }),
      });
    } catch {
      throw new BadGatewayException("upstream_unreachable");
    }
    if (!res.ok) throw new BadGatewayException("upstream_error");
    const data: any = await res.json();
    const out = String(data?.choices?.[0]?.message?.content || "").trim();
    if (!out) throw new BadGatewayException("empty_output");
    return { text: out, model };
  }

  /** Skrati preduge JSON rezultate alata da ne raznesu kontekst (port). */
  private toolResultString(out: unknown): string {
    const s = JSON.stringify(out);
    return s.length > 15000 ? s.slice(0, 15000) + "…[skraćeno — suzi upit]" : s;
  }
}
