import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma-sy15/client";
import { Sy15Service, type Sy15Tx } from "../../common/sy15/sy15.service";
import { Sy15StorageService } from "../../common/sy15/sy15-storage.service";
import {
  AiProviderService,
  ENGINES,
  ENGINE_LABEL,
  type ChatImage,
  type Engine,
} from "../../common/ai/ai-provider.service";
import { DATE_LINE, SYSTEM_PROMPT, toolsForScope } from "./ai-tools";
import type { ChatDto } from "./dto/ai-chat.dto";

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

/** Vision: max ~6MB sirovih bajtova, JPG/PNG/WEBP/GIF (§2 pravilo 17). */
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const IMAGE_MIME_RE = /^image\/(jpeg|png|webp|gif)$/;
const HISTORY_LIMIT = 20;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class AiChatService {
  constructor(
    private readonly sy15: Sy15Service,
    private readonly ai: AiProviderService,
    private readonly storage: Sy15StorageService,
  ) {}

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

  // ==========================================================================
  // R2.3 — /ai/chat port (edge `ai-chat`): 4 engine-a, tool-use petlja, vision,
  // limit 50/dan UTC, auto-naslov, projektne niti. Alati zovu ai_chat_* RPC-ove
  // kroz withUserRls (identitet korisnika — scope u bazi). UPIS istorije ide kroz
  // withUser (BYPASSRLS = ekvivalent service role; RLS INSERT politika = „samo
  // service role") sa EKSPLICITNIM user_id = auth.uid() iz GUC claims.
  // ==========================================================================

  async chat(email: string, dto: ChatDto, imageFile?: Express.Multer.File) {
    const engine: Engine = ENGINES.includes(dto.engine as Engine)
      ? (dto.engine as Engine)
      : "openai";
    const cfg = this.ai.engineConfig(engine);
    if (!cfg) {
      throw new ServiceUnavailableException(
        `${ENGINE_LABEL[engine]} nije konfigurisan na serveru.`,
      );
    }
    const message = String(dto.message ?? "").trim();
    const image = this.parseImage(imageFile);
    if (!message && !image) {
      throw new BadRequestException("Poruka je prazna.");
    }

    // ── tx1: uid + limit + konverzacija + istorija + autor (BYPASSRLS = service role)
    const setup = await this.sy15.withUser(email, async (tx) => {
      const uid = await this.currentUid(tx);
      const used = await this.assertUnderDailyLimit(tx);
      const conv = await this.resolveConversation(tx, uid, dto, message);
      const history = conv.isNew ? [] : await this.loadHistory(tx, conv.convId);
      const author = await this.resolveAuthor(tx, email);
      return { uid, ...conv, history, author, used };
    });

    // ── slika u bucket (van tx; putanja `{convId}/{uuid}.{ext}`)
    let imagePath: string | null = null;
    if (image) imagePath = await this.uploadImage(setup.convId, image);

    // ── tx2: upiši korisnikovu poruku (user_id = auth.uid())
    await this.sy15.withUser(email, (tx) =>
      tx.$executeRaw(
        Prisma.sql`INSERT INTO ai_chat_messages
          (conversation_id, user_id, role, content, author_name, image_path)
          VALUES (${setup.convId}::uuid, auth.uid(), 'user', ${message},
                  ${setup.author.name}, ${imagePath})`,
      ),
    );

    // ── engine (tool-use petlja); alati kroz withUserRls (identitet korisnika)
    const histForModel = setup.history.map((m) => ({
      role: m.role,
      content:
        setup.scope === "project" && m.role === "user" && m.author_name
          ? `${m.author_name}: ${m.content}`
          : m.content,
    }));
    const effectiveMessage =
      message ||
      (image ? "Analiziraj priloženu sliku i odgovori na srpskom." : "");
    const msgForModel =
      setup.scope === "project"
        ? `${setup.author.name}: ${effectiveMessage}`
        : effectiveMessage;
    // VERBATIM index.ts:848-849 (spisak alata + „belešku ISKLJUČIVO na izričit zahtev").
    const extraSystem =
      setup.scope === "project"
        ? `\n\nDELJENA PROJEKTNA NIT — projekat ${setup.convRef}. Ovo je timski razgovor: poruke vide SVI prijavljeni korisnici, a učesnici su označeni imenom na početku poruke (obraćaj im se po imenu). Ovde NEMAŠ lične alate (GO, sati, zaposleni, SQL) — dostupni su samo projekat_info, pretrazi_znanje i dodaj_belesku. Za pitanja o projektu prvo pozovi projekat_info("${setup.convRef}"). Belešku dodaj ISKLJUČIVO kad neko izričito traži da se nešto zapiše.`
        : `\n\nKORISNIK U OVOM RAZGOVORU: ${setup.author.name}${setup.author.position ? " — " + setup.author.position : ""}. Znaš ko je bez pitanja; oslovljavaj ga po imenu, prirodno i bez preteranog ponavljanja.`;
    const system = SYSTEM_PROMPT + DATE_LINE() + extraSystem;

    // Engine se poziva POSLE kreiranja niti/upisa user-poruke → greška MORA nositi
    // conversationId (paritet edge index.ts:853-859): retry ne pravi orphan niti.
    let out;
    try {
      out = await this.ai.chatWithTools(
        cfg,
        histForModel,
        msgForModel,
        toolsForScope(setup.scope),
        system,
        image,
        (name, args) => this.execTool(email, name, args),
      );
    } catch (e) {
      throw this.upstreamError(e, setup.convId);
    }
    if (!out.reply) {
      throw new HttpException(
        { error: "empty_output", conversationId: setup.convId },
        HttpStatus.BAD_GATEWAY,
      );
    }

    // ── tx3: upiši odgovor + osveži nit
    await this.sy15.withUser(email, async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`INSERT INTO ai_chat_messages
          (conversation_id, user_id, role, content, tokens_in, tokens_out, model)
          VALUES (${setup.convId}::uuid, auth.uid(), 'assistant', ${out.reply},
                  ${out.tokensIn}, ${out.tokensOut}, ${out.model})`,
      );
      await tx.$executeRaw(
        Prisma.sql`UPDATE ai_chat_conversations SET updated_at = now() WHERE id = ${setup.convId}::uuid`,
      );
    });

    // ── auto-naslov nove lične niti (pad ne ruši slanje)
    let newTitle: string | null = null;
    if (setup.isNew && setup.scope === "personal") {
      newTitle = await this.ai.generateTitle(message, out.reply);
      if (newTitle) {
        await this.sy15
          .withUser(email, (tx) =>
            tx.$executeRaw(
              Prisma.sql`UPDATE ai_chat_conversations SET title = ${newTitle} WHERE id = ${setup.convId}::uuid`,
            ),
          )
          .catch(() => {
            /* naslov je best-effort */
          });
      }
    }

    return {
      data: {
        ok: true,
        conversationId: setup.convId,
        reply: out.reply,
        model: out.model,
        scope: setup.scope,
        projectRef: setup.convRef,
        authorName: setup.author.name,
        title: newTitle ?? undefined,
        imagePath: imagePath ?? undefined,
        // 1.0 UI čita za upozorenje „još X poruka danas" (index.ts:890-891).
        remaining: Math.max(0, AI_DAILY_LIMIT - setup.used - 1),
        limit: AI_DAILY_LIMIT,
      },
    };
  }

  /**
   * Greška engine-a → 502 sa conversationId (paritet edge index.ts:853-859):
   * upstream_error (HTTP ne-2xx = BadGatewayException iz chatWithTools) vs
   * upstream_unreachable (mrežni throw/fetch fail). Bez ovoga retry pravi orphan
   * niti koje troše dnevni limit.
   */
  private upstreamError(e: unknown, conversationId: string): HttpException {
    // chatWithTools baca BadGatewayException za HTTP ne-2xx; mrežni fetch-throw je
    // generički Error → upstream_unreachable (paritet edge).
    const isUpstream = e instanceof BadGatewayException;
    return new HttpException(
      {
        error: isUpstream ? "upstream_error" : "upstream_unreachable",
        conversationId,
      },
      HttpStatus.BAD_GATEWAY,
    );
  }

  /** Brisanje svoje LIČNE niti (RLS delete_own presuđuje — bez ownership WHERE). */
  async deleteConversation(email: string, id: string) {
    return this.withUserMapped(email, async (tx) => {
      const affected = await tx.$executeRaw(
        Prisma.sql`DELETE FROM ai_chat_conversations WHERE id = ${id}::uuid`,
      );
      if (affected === 0) {
        // Nevidljiva ili tuđa → RLS je odbio (0 redova). Ne otkrivamo postojanje.
        throw new NotFoundException("Razgovor ne postoji.");
      }
      return { data: { ok: true } };
    });
  }

  /**
   * Presigned URL priloga (ai-chat-images). BEZBEDNOST: pošto potpisujemo servisnim
   * ključem (zaobilazi bucket RLS), putanja MORA biti striktno `{convId-uuid}/{ime}`
   * (bez `..`, bez apsolutne putanje, bez dodatnih `/`) — inače bi `<conv>/../<tuđi
   * conv>/x` pobegao iz niti. Rekonstruišemo putanju server-side i potpisujemo NJU,
   * ne sirovi klijentski string. Vidljivost niti presuđuje RLS (withUserRls).
   */
  async signImage(email: string, path: string) {
    const segs = String(path ?? "").split("/");
    const convId = segs[0];
    const name = segs[1];
    const safeName = /^[A-Za-z0-9._-]+$/;
    if (
      segs.length !== 2 ||
      !UUID_RE.test(convId) ||
      !name ||
      name === "." ||
      name === ".." ||
      !safeName.test(name)
    ) {
      throw new BadRequestException("Neispravna putanja slike.");
    }
    await this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT id FROM ai_chat_conversations WHERE id = ${convId}::uuid LIMIT 1`,
      );
      if (!rows.length) {
        throw new ForbiddenException("Nemate pristup ovom prilogu.");
      }
    });
    // Potpiši REKONSTRUISANU putanju (sanitizovani segmenti), ne sirovi string.
    return {
      data: await this.storage.signUrl(
        "ai-chat-images",
        `${convId}/${name}`,
        3600,
      ),
    };
  }

  /** Projekti za picker projektne niti (fetchAiProjects; RLS pozivaoca). */
  async projects(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.$queryRaw(
        Prisma.sql`SELECT project_code, project_name FROM projects
          WHERE COALESCE(project_code, '') <> '' ORDER BY project_code`,
      );
      return { data };
    });
  }

  // ---------- interno: chat ----------

  private parseImage(file?: Express.Multer.File): ChatImage | null {
    if (!file?.buffer?.length) return null;
    const mime = (file.mimetype || "").toLowerCase();
    if (!IMAGE_MIME_RE.test(mime)) {
      throw new BadRequestException(
        "Nepodržan format slike (JPG, PNG, WEBP, GIF).",
      );
    }
    if (file.buffer.length > MAX_IMAGE_BYTES) {
      throw new BadRequestException("Slika je prevelika (max ~6 MB).");
    }
    return { mime, b64: file.buffer.toString("base64") };
  }

  private async uploadImage(
    convId: string,
    image: ChatImage,
  ): Promise<string | null> {
    const ext =
      image.mime === "image/png"
        ? "png"
        : image.mime === "image/webp"
          ? "webp"
          : image.mime === "image/gif"
            ? "gif"
            : "jpg";
    const path = `${convId}/${randomUUID()}.${ext}`;
    try {
      await this.storage.upload(
        "ai-chat-images",
        path,
        Buffer.from(image.b64, "base64"),
        image.mime,
        false,
      );
      return path;
    } catch {
      // Paritet edge: pad upload-a ne ruši chat (slika je opciona) → bez image_path.
      return null;
    }
  }

  /** `sub` iz GUC claims (auth.uid()); bez naloga → 401 (paritet edge getUser). */
  private async currentUid(tx: Sy15Tx): Promise<string> {
    const rows = await tx.$queryRaw<{ uid: string | null }[]>(
      Prisma.sql`SELECT auth.uid() AS uid`,
    );
    const uid = rows[0]?.uid;
    if (!uid) throw new UnauthorizedException("Potrebna je prijava.");
    return uid;
  }

  /** Dnevni limit (COUNT role='user' od UTC ponoći; §2 pravilo 10) → 429; vraća `used`. */
  private async assertUnderDailyLimit(tx: Sy15Tx): Promise<number> {
    const rows = await tx.$queryRaw<{ used: number }[]>(
      Prisma.sql`SELECT count(*)::int AS used FROM ai_chat_messages
        WHERE user_id = auth.uid() AND role = 'user'
          AND created_at >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`,
    );
    const used = rows[0]?.used ?? 0;
    if (used >= AI_DAILY_LIMIT) {
      throw new HttpException(
        {
          error: "daily_limit",
          limit: AI_DAILY_LIMIT,
          message: `Dnevni limit od ${AI_DAILY_LIMIT} poruka je potrošen — nastavi sutra.`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return used;
  }

  /**
   * Razreši nit: postojeća (lična → mora biti korisnikova; projektna → svi),
   * nova PROJEKTNA (reuse najstarije po projektu) ili nova lična. BYPASSRLS
   * konekcija (withUser) — ownership/postojanje projekta proveravamo eksplicitno
   * (paritet edge service-role logike).
   */
  private async resolveConversation(
    tx: Sy15Tx,
    uid: string,
    dto: ChatDto,
    message: string,
  ): Promise<{
    convId: string;
    scope: "personal" | "project";
    convRef: string | null;
    isNew: boolean;
  }> {
    const projectRef = String(dto.projectRef ?? "").trim();
    const convId = String(dto.conversationId ?? "").trim();

    if (convId) {
      const rows = await tx.$queryRaw<
        {
          id: string;
          user_id: string | null;
          scope: string;
          project_ref: string | null;
        }[]
      >(
        Prisma.sql`SELECT id, user_id, scope, project_ref
          FROM ai_chat_conversations WHERE id = ${convId}::uuid LIMIT 1`,
      );
      const conv = rows[0];
      if (!conv) throw new NotFoundException("Razgovor ne postoji.");
      if (conv.scope === "project") {
        return {
          convId,
          scope: "project",
          convRef: conv.project_ref,
          isNew: false,
        };
      }
      if (conv.user_id !== uid) {
        throw new NotFoundException("Razgovor ne postoji.");
      }
      return { convId, scope: "personal", convRef: null, isNew: false };
    }

    if (projectRef) {
      const existing = await tx.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT id FROM ai_chat_conversations
          WHERE scope = 'project' AND project_ref = ${projectRef}
          ORDER BY created_at ASC LIMIT 1`,
      );
      if (existing[0]) {
        return {
          convId: existing[0].id,
          scope: "project",
          convRef: projectRef,
          isNew: false,
        };
      }
      const proj = await tx.$queryRaw<
        { project_code: string; project_name: string | null }[]
      >(
        Prisma.sql`SELECT project_code, project_name FROM projects
          WHERE project_code = ${projectRef} LIMIT 1`,
      );
      if (!proj[0]) {
        throw new NotFoundException(
          `Projekat ${projectRef} ne postoji u planu montaže.`,
        );
      }
      const title =
        `${proj[0].project_code} — ${proj[0].project_name ?? ""}`.slice(0, 120);
      const created = await tx.$queryRaw<{ id: string }[]>(
        Prisma.sql`INSERT INTO ai_chat_conversations (user_id, scope, project_ref, title)
          VALUES (auth.uid(), 'project', ${projectRef}, ${title}) RETURNING id`,
      );
      return {
        convId: created[0].id,
        scope: "project",
        convRef: projectRef,
        isNew: true,
      };
    }

    const created = await tx.$queryRaw<{ id: string }[]>(
      Prisma.sql`INSERT INTO ai_chat_conversations (user_id, title)
        VALUES (auth.uid(), ${message.slice(0, 80)}) RETURNING id`,
    );
    return {
      convId: created[0].id,
      scope: "personal",
      convRef: null,
      isNew: true,
    };
  }

  private async loadHistory(tx: Sy15Tx, convId: string) {
    const rows = await tx.$queryRaw<
      { role: string; content: string; author_name: string | null }[]
    >(
      Prisma.sql`SELECT role, content, author_name FROM ai_chat_messages
        WHERE conversation_id = ${convId}::uuid
        ORDER BY created_at DESC LIMIT ${HISTORY_LIMIT}`,
    );
    return rows.reverse();
  }

  private async resolveAuthor(
    tx: Sy15Tx,
    email: string,
  ): Promise<{ name: string; position: string }> {
    if (!email) return { name: "Nepoznat", position: "" };
    try {
      const rows = await tx.$queryRaw<
        { full_name: string | null; position: string | null }[]
      >(
        Prisma.sql`SELECT full_name, "position" FROM employees
          WHERE email ILIKE ${email} LIMIT 1`,
      );
      if (rows[0]?.full_name) {
        return {
          name: String(rows[0].full_name),
          position: String(rows[0].position ?? ""),
        };
      }
    } catch {
      /* fallback ispod */
    }
    return { name: email.split("@")[0], position: "" };
  }

  /**
   * Izvrši alat kroz withUserRls (SET LOCAL ROLE authenticated + GUC) — SECURITY
   * INVOKER fn (ai_chat_sql, ai_chat_prijavi_kvar) rade tačno kao 1.0, DEFINER fn
   * čitaju identitet iz auth.jwt(). Greška se VRAĆA modelu (ne baca) da petlja
   * nastavi — paritet edge rpcAsUser. pretrazi_uputstva/masina_uputstvo dobijaju
   * embedding; dodaj_uputstvo/dodaj_belesku rade backfill embedinga (best-effort).
   */
  private async execTool(
    email: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    try {
      if (name === "pretrazi_uputstva") {
        const upit = this.str(args.upit);
        const emb = await this.ai.embed(upit);
        return await this.rpc(
          email,
          Prisma.sql`SELECT ai_chat_pretrazi_uputstva(${upit}, ${emb}) AS result`,
        );
      }
      if (name === "masina_uputstvo") {
        const pitanje = this.str(args.pitanje);
        const emb = await this.ai.embed(pitanje);
        return await this.rpc(
          email,
          Prisma.sql`SELECT ai_chat_masina_uputstvo(${this.str(args.masina)}, ${pitanje}, ${emb}) AS result`,
        );
      }
      if (name === "dodaj_uputstvo") {
        const out = await this.rpc(
          email,
          Prisma.sql`SELECT ai_chat_dodaj_uputstvo(${this.str(args.naslov)}, ${this.str(args.sadrzaj)},
            ${this.strOrNull(args.modul)}, ${this.strOrNull(args.kljucne_reci)},
            ${args.vidljivost === "admin_hr" ? "admin_hr" : null}) AS result`,
        );
        await this.backfill(
          email,
          "ai_uputstva",
          out,
          `${this.str(args.naslov)}\n${this.str(args.kljucne_reci)}\n${this.str(args.sadrzaj)}`,
        );
        return out;
      }
      if (name === "dodaj_belesku") {
        const out = await this.rpc(
          email,
          Prisma.sql`SELECT ai_chat_dodaj_belesku(${this.str(args.projekat)},
            ${this.strOrNull(args.naslov)}, ${this.str(args.tekst)}) AS result`,
        );
        await this.backfill(
          email,
          "ai_project_notes",
          out,
          `${this.str(args.naslov)}\n${this.str(args.tekst)}`,
        );
        return out;
      }
      const sql = this.rpcSql(name, args);
      if (!sql) return { error: "nepoznat_alat" };
      return await this.rpc(email, sql);
    } catch {
      // Paritet edge: greška alata se vraća modelu (petlja nastavlja), ne 500.
      return { error: "alat_neuspesan" };
    }
  }

  /** SQL po alatu (tipizovani pozicioni parametri) — zatvoren skup imena. */
  private rpcSql(name: string, a: Record<string, unknown>): Prisma.Sql | null {
    switch (name) {
      case "trazi_zaposlenog":
        return Prisma.sql`SELECT ai_chat_employee_lookup(${this.strOrNull(a.ime)}) AS result`;
      case "go_saldo":
        return Prisma.sql`SELECT ai_chat_go_saldo(${this.uuidOrNull(a.employee_id)}::uuid) AS result`;
      case "sati_mesec":
        return Prisma.sql`SELECT ai_chat_sati(${this.uuidOrNull(a.employee_id)}::uuid, ${this.intOrNull(a.godina)}::int, ${this.intOrNull(a.mesec)}::int) AS result`;
      case "moj_tim":
        return Prisma.sql`SELECT ai_chat_moj_tim() AS result`;
      case "odsustva_lista":
        return Prisma.sql`SELECT ai_chat_odsustva(${this.uuidOrNull(a.employee_id)}::uuid, ${this.intOrNull(a.godina)}::int, ${this.strOrNull(a.tip)}) AS result`;
      case "go_zahtevi":
        return Prisma.sql`SELECT ai_chat_go_zahtevi(${this.uuidOrNull(a.employee_id)}::uuid, ${this.intOrNull(a.godina)}::int) AS result`;
      case "go_pregled":
        return Prisma.sql`SELECT ai_chat_go_pregled(${this.uuidOrNull(a.employee_id)}::uuid) AS result`;
      case "sql_upit":
        return Prisma.sql`SELECT ai_chat_sql(${this.str(a.upit)}) AS result`;
      case "opis_pozicije":
        return Prisma.sql`SELECT ai_chat_opis_pozicije(${this.strOrNull(a.pozicija)}) AS result`;
      case "inzenjering_pretraga":
        return Prisma.sql`SELECT ai_chat_inzenjering(${this.str(a.upit)}, ${this.strOrNull(a.projekat)}) AS result`;
      case "projekat_info":
        return Prisma.sql`SELECT ai_chat_projekat_info(${this.str(a.projekat)}) AS result`;
      case "pretrazi_znanje":
        return Prisma.sql`SELECT ai_chat_pretrazi_znanje(${this.strOrNull(a.projekat)}, ${this.str(a.upit)}) AS result`;
      case "masina_info":
        return Prisma.sql`SELECT ai_chat_masina_info(${this.str(a.masina)}) AS result`;
      case "kvar_istorija":
        return Prisma.sql`SELECT ai_chat_kvar_istorija(${this.strOrNull(a.masina)}, ${this.strOrNull(a.upit)}) AS result`;
      case "prijavi_kvar":
        return Prisma.sql`SELECT ai_chat_prijavi_kvar(${this.str(a.masina)}, ${this.str(a.naslov)},
          ${this.strOrNull(a.opis)}, ${a.ozbiljnost ? this.str(a.ozbiljnost) : "minor"},
          ${a.bezbednosni_rizik === true}) AS result`;
      default:
        return null;
    }
  }

  /** Izvrši ai_chat_* RPC kroz withUserRls; vrati `result` polje. */
  private async rpc(email: string, sql: Prisma.Sql): Promise<unknown> {
    return this.sy15.withUserRls(email, async (tx) => {
      const rows = await tx.$queryRaw<{ result: unknown }[]>(sql);
      return rows[0]?.result ?? null;
    });
  }

  /** Backfill embedinga posle dodaj_uputstvo/belesku (BYPASSRLS = service role; best-effort). */
  private async backfill(
    email: string,
    table: "ai_uputstva" | "ai_project_notes",
    out: unknown,
    text: string,
  ): Promise<void> {
    const o = out as { ok?: boolean; id?: string | number } | null;
    if (!o?.ok || !o.id) return;
    const emb = await this.ai.embed(text);
    if (!emb) return;
    const id = String(o.id);
    const tableSql =
      table === "ai_uputstva"
        ? Prisma.sql`ai_uputstva`
        : Prisma.sql`ai_project_notes`;
    await this.sy15
      .withUser(email, (tx) =>
        tx.$executeRaw(
          Prisma.sql`UPDATE ${tableSql} SET embedding = ${emb}::vector WHERE id = ${id}::uuid`,
        ),
      )
      .catch(() => {
        /* embedding je best-effort — bez njega radi FTS */
      });
  }

  /** Sigurna koercija args-a modela (string/broj/bool → tekst; objekat → JSON). */
  private str(v: unknown): string {
    if (v == null) return "";
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    return JSON.stringify(v);
  }
  private strOrNull(v: unknown): string | null {
    const s = this.str(v);
    return s ? s : null;
  }
  private uuidOrNull(v: unknown): string | null {
    return this.strOrNull(v);
  }
  private intOrNull(v: unknown): number | null {
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }
}
