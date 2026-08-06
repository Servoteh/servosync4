import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma-sy15/client";
import { Sy15Service, type Sy15Tx } from "../../common/sy15/sy15.service";
import { Sy15StorageService } from "../../common/sy15/sy15-storage.service";
import { OdrzavanjeSourceService } from "../../common/sy15/odrzavanje-source.service";
import {
  AiProviderService,
  ENGINES,
  ENGINE_LABEL,
  type ChatImage,
  type Engine,
} from "../../common/ai/ai-provider.service";
import { AI_MODULE, AiLimitsService } from "../../common/ai/ai-limits.service";
import {
  AI_TASK,
  AiModelPolicyService,
} from "../../common/ai/ai-model-policy.service";
import type { AiCallContext } from "../../common/ai/ai-usage.service";
import {
  CHAT_INJECTION_FENCE,
  fenceUserInput,
} from "../../common/ai/injection-fence";
import { DATE_LINE, SYSTEM_PROMPT } from "./ai-tools";
import {
  findTool,
  isToolAllowed,
  toolsForScope,
  type PermissionSet,
  type ToolDeps,
  type ToolScope,
} from "./tools";
import { PrismaService } from "../../prisma/prisma.service";
import { KadrovskaService } from "../kadrovska/kadrovska.service";
import { applyOverrides } from "../../common/authz/effective-permission";
import { permissionsForRoles } from "../../common/authz/role-permissions";
import type { ChatDto } from "./dto/ai-chat.dto";

/** Ko zove — potreban za merenje (`ai_usage_log.user_id`) i dnevni budžet. */
export interface ChatActor {
  userId: number;
  role?: string | null;
}

/**
 * Talas AI-1 — brana alata: nit (scope) + efektivne permisije korisnika.
 * `permissions: undefined` = nepoznato → alat sa `requiredPermission` se NE
 * nudi i NE izvršava (fail-closed; glavna baza nema RLS da to nadomesti).
 */
interface ToolGate {
  scope: ToolScope;
  permissions: PermissionSet;
  /** `true` = permisije se NISU mogle pročitati (kvar), nije „nema prava". */
  degraded: boolean;
}

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
 *   * 20 alata → `ai_chat_*`/`go_ledger` RPC-i se NE prepisuju; zovu se kroz withUserRls SA
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

/**
 * Talas AI-0 (stavka 5): dnevni limit više NIJE „50 poruka" iz `ai_chat_messages`
 * nego budžet ULAZNIH tokena iz `ai_usage_log` (AiLimitsService). Time se broje i
 * alati, istorija i slike — tj. ono što stvarno košta — i nema duplog brojanja.
 */

/** Vision: max ~6MB sirovih bajtova, JPG/PNG/WEBP/GIF (§2 pravilo 17). */
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const IMAGE_MIME_RE = /^image\/(jpeg|png|webp|gif)$/;
const HISTORY_LIMIT = 20;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class AiChatService {
  private readonly logger = new Logger(AiChatService.name);

  constructor(
    private readonly sy15: Sy15Service,
    private readonly ai: AiProviderService,
    private readonly storage: Sy15StorageService,
    private readonly limits: AiLimitsService,
    private readonly policy: AiModelPolicyService,
    /** Glavna baza — proizvodni alati (Talas AI-1) + `audit_log` poziva alata. */
    private readonly prisma: PrismaService,
    /** Postojeći servis kadrovske — alat `prisustvo_danas` ne piše svoj upit. */
    private readonly kadrovska: KadrovskaService,
    /**
     * Prekidač izvora ODRŽAVANJA (`ODRZAVANJE_IZVOR`, korak 2 gašenja sy15).
     * Pet alata (`masina_info`, `kvar_istorija`, `masina_uputstvo`,
     * `prijavi_kvar`, `trosak_sredstva`) radi nad `maint_*` podacima, a
     * `prijavi_kvar` u njih i PIŠE — v. `assertMaintPorted` u `sy15-tools.ts`.
     * @Optional: bez njega brana ne radi ništa (ponašanje kao `sy15`).
     */
    @Optional() private readonly odrzavanjeIzvor?: OdrzavanjeSourceService,
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

  /**
   * Dnevni budžet chata u ULAZNIM tokenima (Talas AI-0, stavka 5) — izvor je
   * `ai_usage_log` u glavnoj bazi, ne više brojanje poruka u sy15. Admin nema
   * limit (`limit: -1`), pa FE u tom slučaju ne prikazuje brojač.
   */
  async limit(actor: ChatActor) {
    const budget = await this.limits.chatBudget(actor.userId, actor.role);
    return { data: budget };
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

  async chat(
    email: string,
    dto: ChatDto,
    imageFile?: Express.Multer.File,
    actor?: ChatActor,
  ) {
    const engine: Engine = ENGINES.includes(dto.engine as Engine)
      ? (dto.engine as Engine)
      : "openai";
    const baseCfg = this.ai.engineConfig(engine);
    if (!baseCfg) {
      throw new ServiceUnavailableException(
        `${ENGINE_LABEL[engine]} nije konfigurisan na serveru.`,
      );
    }
    // Talas AI-0 (stavka 7c): Claude engine PRVO čita registar `ai_model_policy`,
    // pa tek onda env/default — inače bi izbor u Podešavanjima bio mrtvo slovo.
    const cfg =
      engine === "claude"
        ? {
            ...baseCfg,
            model: (
              await this.policy.resolve(AI_TASK.CHAT_CLAUDE, baseCfg.model)
            ).model,
          }
        : baseCfg;
    const message = String(dto.message ?? "").trim();
    const image = this.parseImage(imageFile);
    if (!message && !image) {
      throw new BadRequestException("Poruka je prazna.");
    }

    // Dnevni budžet (ulazni tokeni iz `ai_usage_log`) — 429 PRE nego što se
    // napravi nit, da odbijeni pokušaj ne ostavi praznu konverzaciju.
    const ctx: AiCallContext = {
      module: AI_MODULE.CHAT,
      userId: actor?.userId ?? null,
    };
    const budget = actor
      ? await this.limits.assertChat(actor.userId, actor.role)
      : null;

    // ── tx1: uid + konverzacija + istorija + autor (BYPASSRLS = service role)
    const setup = await this.sy15.withUser(email, async (tx) => {
      const uid = await this.currentUid(tx);
      const conv = await this.resolveConversation(tx, uid, dto, message);
      const history = conv.isNew ? [] : await this.loadHistory(tx, conv.convId);
      const author = await this.resolveAuthor(tx, email);
      return { uid, ...conv, history, author };
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
    // Talas AI-0 (stavka 6): u DELJENOJ projektnoj niti tuđe poruke su nepouzdan
    // unos (kanal za injekciju) — idu obmotane ogradom. Sopstvena poruka korisnika
    // (ispod) ostaje van ograde jer JESTE instrukcija koju model treba da izvrši.
    const histForModel = setup.history.map((m) => ({
      role: m.role,
      content:
        setup.scope === "project" && m.role === "user" && m.author_name
          ? `${m.author_name}: ${fenceUserInput(m.content)}`
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
    // Floating AI widget (request 003/26): optional current-screen hint. Appended
    // AFTER extraSystem so the SYSTEM_PROMPT / DATE_LINE / scope-note ordering stays
    // intact. Only for personal scope: shared project threads already carry their own
    // team-context note, and a per-user screen hint would leak/confuse there. Whitespace
    // is collapsed so a noisy client string cannot bloat the prompt.
    const screenContext = String(dto.screenContext ?? "")
      .replace(/\s+/g, " ")
      .trim();
    const screenLine =
      screenContext && setup.scope !== "project"
        ? `\n\nTRENUTNI EKRAN KORISNIKA: ${screenContext}. Ako pitanje deluje vezano za ovaj ekran, prvo mu pomozi oko njega.`
        : "";
    // Ograda ide NA KRAJ (posle scope-note i screen-hint-a) da redosled
    // SYSTEM_PROMPT / DATE_LINE / scope-note ostane netaknut.
    const system =
      SYSTEM_PROMPT +
      DATE_LINE() +
      extraSystem +
      screenLine +
      `\n\n${CHAT_INJECTION_FENCE}`;

    // Engine se poziva POSLE kreiranja niti/upisa user-poruke → greška MORA nositi
    // conversationId (paritet edge index.ts:853-859): retry ne pravi orphan niti.
    // Talas AI-1: modelu se nude SAMO alati na koje pozivalac ima pravo. Za
    // sy15 alate (bez `requiredPermission`) ništa se ne menja — oni su i dalje
    // svi u ponudi, a pravo presuđuje RLS u bazi.
    const gate: ToolGate = {
      scope: setup.scope,
      ...(await this.effectivePermissions(email, actor)),
    };

    let out;
    try {
      out = await this.ai.chatWithTools(
        cfg,
        histForModel,
        msgForModel,
        toolsForScope(gate.scope, gate.permissions),
        system,
        image,
        (name, args) => this.execTool(email, name, args, ctx, gate),
        ctx,
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
      newTitle = await this.ai.generateTitle(message, out.reply, {
        module: AI_MODULE.TITLE,
        userId: actor?.userId ?? null,
      });
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
        // FE čita za upozorenje „još X tokena danas". Oduzimamo i ulazne tokene
        // ovog kruga (ledger je best-effort/async, pa ga ne čekamo ponovo).
        remaining:
          budget && budget.limit >= 0
            ? Math.max(0, budget.remaining - (out.tokensIn ?? 0))
            : -1,
        limit: budget?.limit ?? -1,
        unit: budget?.unit ?? "tokens",
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
    // Model je odbio / odgovor odsečen (422 iz chatWithTools) NIJE upstream kvar —
    // korisniku ide ljudska poruka, ali i dalje sa conversationId (nit već postoji).
    if (e instanceof UnprocessableEntityException) {
      const body = e.getResponse();
      const message =
        typeof body === "string"
          ? body
          : ((body as { message?: string }).message ?? "Zahtev nije obrađen.");
      return new HttpException(
        { error: "model_refused_or_truncated", message, conversationId },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
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
   * Efektivne permisije pozivaoca — ISTI izvor kao `GET /auth/me/permissions`
   * (rola-mapa + `user_permission_overrides` u redosledu deny > grant > rola,
   * plus tvrda brava na zarade).
   *
   * Šta je SVEŽE a šta nije (ista ograda kao u `auth.controller.ts`): override-i
   * se čitaju iz baze na svaki poziv, pa dodat/oduzet ključ važi već u sledećoj
   * poruci bez ponovne prijave. **Rola se čita iz JWT claim-a**, a token traje
   * do `JWT_EXPIRES_IN` (podrazumevano 7 dana) — promena role dakle NE dejstvuje
   * odmah, isto kao i na svakoj drugoj ruti. Ako nekome treba trenutno oduzeti
   * pristup alatu, put je deny override, ne promena role.
   *
   * Nepoznat pozivalac ili PAD čitanja → `undefined` = FAIL-CLOSED: alati koji
   * traže permisiju se ne nude i ne izvršavaju. Pad se dodatno označava
   * (`degraded`) da bi model razlikovao „nemaš pravo" od „ne mogu da proverim".
   * Za 20 sy15 alata ništa se ne menja (permisiju ne traže — presuđuje RLS).
   */
  private async effectivePermissions(
    email: string,
    actor?: ChatActor,
  ): Promise<{ permissions: PermissionSet; degraded: boolean }> {
    if (!actor?.role) return { permissions: undefined, degraded: false };
    try {
      const overrides = await this.prisma.userPermissionOverride.findMany({
        where: { userId: actor.userId },
        select: { key: true, allow: true },
      });
      return {
        permissions: new Set(
          applyOverrides(permissionsForRoles([actor.role]), overrides, email),
        ),
        degraded: false,
      };
    } catch (e) {
      this.logger.warn(
        `Permisije za alate nisu učitane (fail-closed): ${e instanceof Error ? e.message : String(e)}`,
      );
      return { permissions: undefined, degraded: true };
    }
  }

  /**
   * Izvrši alat iz KONSOLIDOVANOG registra (Talas AI-1, tačka 2). Ranije su
   * definicija i handler bili u dva fajla bez provere poklapanja; sada je alat
   * jedan objekat, pa „ime bez handlera" više nije moguće (pinuje
   * `tools/tool-registry.spec.ts`).
   *
   * Tri koraka pre izvršenja:
   *  1. registar zna li ime → inače `nepoznat_alat` (paritet sa ranijim putem),
   *  2. BRANA: `isToolAllowed` (scope niti + permisija) — ne oslanjamo se na to
   *     što alat nije PONUĐEN, jer model može da izmisli ime; za glavnu bazu
   *     (bez RLS) je ovo jedina odbrana,
   *  3. audit: svaki poziv ide u `audit_log` (AuditInterceptor vidi samo HTTP
   *     mutacije, a alati se izvršavaju unutar jednog POST /ai/chat).
   *
   * `gate` je OBAVEZAN i nema podrazumevanu vrednost: „zaboravljen gate" ne sme
   * da postane tiho `personal` + prazne permisije, jer bi se tako promašen
   * poziv predstavio kao uredna odbijenica umesto da padne na kompajliranju.
   *
   * sy15 alati i dalje idu kroz `withUserRls` (GUC identitet), a greška se
   * VRAĆA modelu (ne baca) da petlja nastavi — paritet edge `rpcAsUser`.
   */
  private async execTool(
    email: string,
    name: string,
    args: Record<string, unknown>,
    ctx: AiCallContext | undefined,
    gate: ToolGate,
  ): Promise<unknown> {
    const started = Date.now();
    const tool = findTool(name);
    if (!tool) {
      this.auditTool(email, ctx, name, args, started, "nepoznat_alat");
      return { error: "nepoznat_alat" };
    }
    if (!isToolAllowed(tool, gate.scope, gate.permissions)) {
      // Razlika je bitna za korisnika: „nemate pravo" je konačna odbijenica, a
      // pad čitanja permisija je PRIVREMEN kvar. Bez ovoga bi kratak ispad baze
      // korisniku stigao kao lažna tvrdnja da mu je pristup oduzet.
      if (gate.degraded && tool.requiredPermission) {
        this.auditTool(email, ctx, name, args, started, "degradirano");
        return {
          error: "provera_prava_nedostupna",
          poruka:
            "Trenutno ne mogu da proverim prava pristupa (privremen kvar). Reci korisniku da pokuša ponovo za koji minut — NE tvrdi da nema pravo.",
        };
      }
      this.auditTool(email, ctx, name, args, started, "nema_prava");
      return { error: "nema_prava" };
    }
    const deps: ToolDeps = {
      sy15: this.sy15,
      ai: this.ai,
      prisma: this.prisma,
      kadrovska: this.kadrovska,
      odrzavanjeIzvor: this.odrzavanjeIzvor,
    };
    try {
      const out = await tool.execute(args, {
        email,
        call: ctx,
        permissions: gate.permissions,
        deps,
      });
      this.auditTool(email, ctx, name, args, started, "ok");
      return out;
    } catch (e) {
      this.logger.warn(
        `Alat ${name} nije uspeo: ${e instanceof Error ? e.message : String(e)}`,
      );
      this.auditTool(email, ctx, name, args, started, "greska");
      // Paritet edge: greška alata se vraća modelu (petlja nastavlja), ne 500.
      return { error: "alat_neuspesan" };
    }
  }

  /**
   * Poziv alata → `audit_log` (Talas AI-1, tačka 4). Fire-and-forget, kao i
   * `AuditInterceptor`: audit NIKAD ne sme da obori alat, pa je i sinhroni pad
   * (npr. nedostupna glavna baza) progutan. Argumenti se skraćuju — `sql_upit`
   * ume da pošalje ceo SELECT, a `audit_log` nije mesto za to.
   *
   * ⚠️ OSETLJIVOST SADRŽAJA — za svakog ko kasnije pravi prikaz `audit_log`-a:
   * `afterData.argumenti` nosi DOSLOVNE argumente koje je model sastavio iz
   * korisnikove poruke. Za HR alate (`trazi_zaposlenog`, `go_saldo`,
   * `odsustva_lista`, `sql_upit`) to su imena zaposlenih, UUID-jevi kartona i
   * ceo tekst SQL upita. Ovaj red je dakle najmanje toliko poverljiv koliko i
   * sam alat: svaki ekran/izvoz nad `audit_log`-om MORA imati admin gate i ne
   * sme se prosleđivati rukovodiocima „radi uvida u korišćenje AI-ja".
   * Ako ikad zatreba slobodnija vidljivost — prvo se uvodi maskiranje polja,
   * pa tek onda ekran.
   */
  private auditTool(
    email: string,
    ctx: AiCallContext | undefined,
    name: string,
    args: Record<string, unknown>,
    startedAt: number,
    ishod: "ok" | "greska" | "nema_prava" | "nepoznat_alat" | "degradirano",
  ): void {
    try {
      void this.prisma.auditLog
        .create({
          data: {
            actorUserId: ctx?.userId ?? null,
            actorUsername: email || null,
            action: "AI_TOOL",
            entityType: "ai-tool",
            entityId: name.slice(0, 100),
            afterData: {
              argumenti: this.shortArgs(args),
              trajanje_ms: Date.now() - startedAt,
              ishod,
            },
          },
        })
        .catch((e: unknown) =>
          this.logger.warn(
            `Audit alata ${name} nije upisan: ${e instanceof Error ? e.message : String(e)}`,
          ),
        );
    } catch {
      /* audit ne sme da obori poziv alata */
    }
  }

  /** Argumenti alata za audit: JSON skraćen na 500 znakova. */
  private shortArgs(args: Record<string, unknown>): string {
    let json: string;
    try {
      json = JSON.stringify(args ?? {});
    } catch {
      json = "[nečitljivi argumenti]";
    }
    return json.length > 500 ? `${json.slice(0, 500)}…` : json;
  }
}
