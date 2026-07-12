import {
  ForbiddenException,
  Injectable,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma-sy15/client";
import { Sy15Service, type Sy15Tx } from "../../common/sy15/sy15.service";

/**
 * AI asistent — 3.0 TALAS B, R1 READ sloj (MODULE_SPEC_sastanci_ai_30.md §3).
 * R1 = SAMO čitanje istorije + limit + „ja" kartica. SVE ide kroz
 * `Sy15Service.withUserRls` (GUC claims + SET LOCAL ROLE authenticated — review 12.07:
 * konekciona rola je BYPASSRLS pa RLS važi tek pod authenticated):
 *   - conversations SELECT = own (auth.uid()) + project-scope SVIMA (RLS),
 *   - messages SELECT = own + project (RLS),
 *   - dnevni limit broji `role='user'` poruke od UTC ponoći (§2 pravilo 10).
 *
 * ── R2 (NIJE ovde) ────────────────────────────────────────────────────────
 * Port edge `ai-chat` u NestJS (§7 P1): POST `/ai/chat` sa tool-use petljom.
 *   * 4 engine-a (ChatGPT/Claude/Gemini/Kimi) — ključevi u BE env.
 *   * 18 alata → 22 `ai_chat_*` RPC-a se NE prepisuju; zovu se kroz withUserRls SA
 *     identitetom korisnika (auth.uid()+email) — scope presuđuje baza (Kadrovska/
 *     Održavanje/PB/Plan), a SECURITY INVOKER alati (ai_chat_sql, ai_chat_prijavi_kvar)
 *     rade kao u 1.0 jer se izvršavaju kao authenticated. U DELJENOJ projektnoj niti
 *     LIČNI alati (GO/sati/zaposleni/SQL) su ISKLJUČENI; poruke se modelu prefiksuju
 *     imenom autora (§2 pravilo 11).
 *   * vision: max ~6MB base64, JPG/PNG/WEBP/GIF, resize 1568px; upload → `ai-chat-images`.
 *   * limit 50/dan UTC (COUNT role='user'); pad auto-naslova (gpt-4o-mini) ne ruši slanje.
 *   * upis istorije SERVER-SIDE (RLS INSERT/UPDATE = „NIKO"; R2 bira mehanizam:
 *     upis BEZ SET ROLE (BYPASSRLS konekcija = ekvivalent service role) ili DEFINER RPC).
 * Ostali R2: DELETE `/ai/conversations/:id` (samo svoje lične niti), `/ai/projects`,
 *   `/ai/images/sign`, `/ai/stt` + `/ai/refine` (P4 presečna infra), `/ai/chat`.
 * ──────────────────────────────────────────────────────────────────────────
 */

/** 1.0 kanon (§2 pravilo 10): dnevni limit poruka po korisniku, broji se od UTC ponoći. */
export const AI_DAILY_LIMIT = 50;

@Injectable()
export class AiChatService {
  constructor(private readonly sy15: Sy15Service) {}

  /** Liste niti: lične (own, auth.uid()) + projektne (scope='project', vide svi) — RLS scoping. */
  async conversations(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.aiChatConversation.findMany({
        orderBy: [{ updatedAt: "desc" }],
        take: 200,
      });
      return { data };
    });
  }

  /** Poruke jedne niti (RLS: own + project). Vraća hronološki (paritet fetchAiMessages). */
  async messages(email: string, conversationId: string) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.aiChatMessage.findMany({
        where: { conversationId },
        orderBy: [{ createdAt: "asc" }],
        take: 500,
      });
      return { data };
    });
  }

  /** „Ja" kartica za vokativ pozdrav (ai_chat_ja RPC — ime/pozicija/odeljenje). */
  async me(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<{ ai_chat_ja: unknown }[]>(
        Prisma.sql`SELECT ai_chat_ja() AS ai_chat_ja`,
      );
      return { data: rows[0]?.ai_chat_ja ?? null };
    });
  }

  /** Dnevni limit: iskorišćeno (role='user' od UTC ponoći) + preostalo (paritet 1.0). */
  async limit(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<{ used: number }[]>(
        Prisma.sql`SELECT count(*)::int AS used
                   FROM ai_chat_messages
                   WHERE user_id = auth.uid()
                     AND role = 'user'
                     AND created_at >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`,
      );
      const used = rows[0]?.used ?? 0;
      return {
        data: {
          used,
          limit: AI_DAILY_LIMIT,
          remaining: Math.max(0, AI_DAILY_LIMIT - used),
        },
      };
    });
  }

  // ---------- interno ----------

  /**
   * Sav pristup ide kroz `withUserRls` (GUC + SET LOCAL ROLE authenticated) —
   * KRITIČNO za ai_chat_* (review 12.07): konekciona rola je BYPASSRLS, pa bi
   * čitanje bez SET ROLE vraćalo TUĐE LIČNE NITI. Pod `authenticated` RLS
   * (own auth.uid() + project-scope) presuđuje red kao u 1.0 PostgREST-u.
   */
  private async withUserMapped<T>(
    email: string,
    fn: (tx: Sy15Tx) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.sy15.withUserRls(email, fn);
    } catch (e) {
      this.rethrowSy15(e);
    }
  }

  /** SQLSTATE → HTTP (paritet Reversi §5): 42501→403, P0001/P0002→422. */
  private rethrowSy15(e: unknown): never {
    if (
      e instanceof ForbiddenException ||
      e instanceof UnprocessableEntityException
    ) {
      throw e;
    }
    const meta = (e as { meta?: { code?: string; message?: string } }).meta;
    const message = meta?.message ?? (e as Error).message;
    if (meta?.code === "42501") throw new ForbiddenException(message);
    if (meta?.code === "P0001" || meta?.code === "P0002")
      throw new UnprocessableEntityException(message);
    throw e;
  }
}
