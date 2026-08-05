import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";

/**
 * Minimal "task → model" registry (Talas AI-0, item 7c).
 *
 * Deliberately NOT a new parallel source of truth: an empty registry means every
 * consumer keeps resolving its model exactly as before (sy15 `sastanci_ai_settings`
 * / `montaza_ai_settings`, env for zahtevi and chat). A row only appears when an
 * admin sets one in Podešavanja → Sistem → AI modeli, and from then on the
 * registry wins. The two sy15 settings are written in parallel (dual write) until
 * they are switched off, so 1.0 keeps working.
 */

export const AI_TASK = {
  CHAT_CLAUDE: "chat-claude",
  SASTANCI_SUMMARY: "sastanci-summary",
  MONTAZA_REPORT: "montaza-izvestaj",
  ZAHTEVI_TRIAGE: "zahtevi-triage",
  ZAHTEVI_ANALYSIS: "zahtevi-analysis",
  ODRZAVANJE_RACUN: "odrzavanje-racun",
} as const;

export type AiTask = (typeof AI_TASK)[keyof typeof AI_TASK];

export interface AiPolicy {
  model: string;
  effort: string | null;
}

@Injectable()
export class AiModelPolicyService {
  private readonly logger = new Logger(AiModelPolicyService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Registry first, caller's existing resolution second. A DB failure must not
   * break an AI call, so it degrades to the fallback and only logs.
   */
  async resolve(task: AiTask, fallbackModel: string): Promise<AiPolicy> {
    try {
      const row = await this.prisma.aiModelPolicy.findUnique({
        where: { task },
      });
      if (row?.model) return { model: row.model, effort: row.effort };
    } catch (err) {
      this.logger.warn(
        `ai_model_policy čitanje palo (${task}): ${(err as Error).message} — fallback na postojeći izvor.`,
      );
    }
    return { model: fallbackModel, effort: null };
  }

  /** All registry rows (Podešavanja screen). */
  async list(): Promise<
    {
      task: string;
      model: string;
      effort: string | null;
      updatedBy: string | null;
      updatedAt: Date;
    }[]
  > {
    return this.prisma.aiModelPolicy.findMany({ orderBy: { task: "asc" } });
  }

  /** Upsert one task (admin). Model is normalised the same way the sy15 RPCs do. */
  async set(
    task: AiTask,
    model: string,
    effort: string | null,
    updatedBy: string | null,
  ) {
    const norm = model.trim().toLowerCase();
    return this.prisma.aiModelPolicy.upsert({
      where: { task },
      create: { task, model: norm, effort, updatedBy },
      update: { model: norm, effort, updatedBy },
    });
  }
}
