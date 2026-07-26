import {
  BadGatewayException,
  BadRequestException,
  HttpException,
} from "@nestjs/common";
import { AiChatService } from "./ai-chat.service";
import type { Sy15Service } from "../../common/sy15/sy15.service";
import type { AiProviderService } from "../../common/ai/ai-provider.service";
import type { AiLimitsService } from "../../common/ai/ai-limits.service";
import type { AiModelPolicyService } from "../../common/ai/ai-model-policy.service";
import type { PrismaService } from "../../prisma/prisma.service";
import type { KadrovskaService } from "../kadrovska/kadrovska.service";

/**
 * Talas AI-0 (stavka 5): dnevni limit je sada budžet ULAZNIH tokena iz
 * `ai_usage_log`, a ne brojanje poruka u sy15. Testovi koriste ovaj mok —
 * 200k tokena, 0 potrošeno (assert prolazi, chat teče).
 */
function limitsMock(used = 0, limit = 200_000): AiLimitsService {
  const budget = {
    used,
    limit,
    remaining: Math.max(0, limit - used),
    unit: "tokens" as const,
  };
  return {
    chatBudget: jest.fn().mockResolvedValue(budget),
    assertChat: jest.fn().mockResolvedValue(budget),
  } as unknown as AiLimitsService;
}

/**
 * Talas AI-1: servis dobija glavnu bazu (proizvodni alati + `audit_log` poziva
 * alata) i postojeći `KadrovskaService` (alat `prisustvo_danas`). Podrazumevani
 * mok NEMA nijednu permisiju u `user_permission_overrides` i `audit_log` upis
 * mu je no-op — tj. ponašanje 20 sy15 alata ostaje bit-identično.
 */
function prismaMock(overrides: { key: string; allow: boolean }[] = []) {
  return {
    userPermissionOverride: {
      findMany: jest.fn().mockResolvedValue(overrides),
    },
    auditLog: { create: jest.fn().mockResolvedValue({ id: 1 }) },
  } as unknown as PrismaService;
}

function kadrovskaMock(rows: unknown[] = []) {
  return {
    attendanceNow: jest.fn().mockResolvedValue({ data: rows }),
  } as unknown as KadrovskaService;
}

/**
 * Registar modela (Talas AI-0, stavka 7c). Podrazumevano je PRAZAN — `resolve`
 * vraća prosleđen fallback, pa chat koristi model iz env-a kao i pre.
 */
function policyMock(model?: string): AiModelPolicyService {
  return {
    resolve: jest
      .fn()
      .mockImplementation((_task: string, fallback: string) =>
        Promise.resolve({ model: model ?? fallback, effort: null }),
      ),
  } as unknown as AiModelPolicyService;
}

/** Admin: bez limita (`limit: -1`) — FE tada ne prikazuje brojač. */
function unlimitedLimitsMock(): AiLimitsService {
  const budget = { used: 0, limit: -1, remaining: -1, unit: "tokens" as const };
  return {
    chatBudget: jest.fn().mockResolvedValue(budget),
    assertChat: jest.fn().mockResolvedValue(budget),
  } as unknown as AiLimitsService;
}

/** Potrošen budžet → assertChat baca 429 (isti oblik kao AiLimitsService). */
function exhaustedLimitsMock(): AiLimitsService {
  const err = new HttpException(
    { error: "chat_token_limit", limit: 200_000, used: 200_000 },
    429,
  );
  return {
    chatBudget: jest.fn().mockResolvedValue({
      used: 200_000,
      limit: 200_000,
      remaining: 0,
      unit: "tokens" as const,
    }),
    assertChat: jest.fn().mockRejectedValue(err),
  } as unknown as AiLimitsService;
}

/**
 * RLS most (review 12.07, CRITICAL leak): ai_chat_conversations/messages RLS
 * (own auth.uid() + project-scope) važi SAMO pod `authenticated` — konekciona
 * rola je BYPASSRLS. Ovaj spec pinuje da SVI read-ovi idu kroz `withUserRls`,
 * nikad kroz `withUser` (koji bi vraćao TUĐE LIČNE NITI).
 */
describe("AiChatService — withUserRls most (leak guard)", () => {
  function makeSvc() {
    const tx = {
      aiChatConversation: { findMany: jest.fn().mockResolvedValue([]) },
      aiChatMessage: { findMany: jest.fn().mockResolvedValue([]) },
      $queryRaw: jest.fn().mockResolvedValue([]),
      $executeRaw: jest.fn().mockResolvedValue(0),
    };
    const sy15 = {
      withUser: jest.fn(),
      withUserRls: jest.fn(
        (_email: string, fn: (t: unknown) => Promise<unknown>) => fn(tx),
      ),
    };
    const svc = new AiChatService(
      sy15 as unknown as Sy15Service,
      {} as never,
      {} as never,
      limitsMock(),
      policyMock(),
      prismaMock(),
      kadrovskaMock(),
    );
    return { svc, sy15, tx };
  }

  it("conversations ide kroz withUserRls, NIKAD withUser", async () => {
    const { svc, sy15 } = makeSvc();
    await svc.conversations("test@servoteh.com");
    expect(sy15.withUserRls).toHaveBeenCalledTimes(1);
    expect(sy15.withUser).not.toHaveBeenCalled();
  });

  it("messages ide kroz withUserRls, NIKAD withUser", async () => {
    const { svc, sy15 } = makeSvc();
    await svc.messages(
      "test@servoteh.com",
      "3b241101-e2bb-4255-8caf-4136c566a962",
    );
    expect(sy15.withUserRls).toHaveBeenCalledTimes(1);
    expect(sy15.withUser).not.toHaveBeenCalled();
  });

  it("me ide kroz withUserRls (auth.uid() iz GUC claims)", async () => {
    const { svc, sy15 } = makeSvc();
    await svc.me("test@servoteh.com");
    expect(sy15.withUserRls).toHaveBeenCalledTimes(1);
    expect(sy15.withUser).not.toHaveBeenCalled();
  });

  it("limit više NE dira sy15 — budžet dolazi iz ai_usage_log (glavna baza)", async () => {
    const { svc, sy15 } = makeSvc();
    const out = await svc.limit({ userId: 7, role: "sef" });
    expect(out.data).toEqual({
      used: 0,
      limit: 200_000,
      remaining: 200_000,
      unit: "tokens",
    });
    expect(sy15.withUserRls).not.toHaveBeenCalled();
    expect(sy15.withUser).not.toHaveBeenCalled();
  });

  it("deleteConversation: RLS delete_own (0 redova → 404, bez ownership WHERE)", async () => {
    const { svc, tx } = makeSvc();
    tx.$executeRaw = jest.fn().mockResolvedValue(0);
    await expect(
      svc.deleteConversation(
        "test@servoteh.com",
        "3b241101-e2bb-4255-8caf-4136c566a962",
      ),
    ).rejects.toThrow(/ne postoji/);
  });
});

/**
 * signImage — path-traversal hardening (review nalaz #2): pošto potpisujemo
 * servisnim ključem, putanja MORA biti striktno `{convId-uuid}/{ime}`; `..`,
 * apsolutna putanja i dodatni `/` segmenti se odbijaju PRE potpisivanja.
 */
describe("AiChatService.signImage (path traversal)", () => {
  const CONV = "3b241101-e2bb-4255-8caf-4136c566a962";
  function make(convVisible = true) {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue(convVisible ? [{ id: CONV }] : []),
    };
    const sy15 = {
      withUser: jest.fn(),
      withUserRls: jest.fn((_e: string, fn: (t: unknown) => Promise<unknown>) =>
        fn(tx),
      ),
    };
    const storage = {
      signUrl: jest.fn().mockResolvedValue({ url: "u", expiresIn: 3600 }),
    };
    const svc = new AiChatService(
      sy15 as unknown as Sy15Service,
      {} as never,
      storage as never,
      limitsMock(),
      policyMock(),
      prismaMock(),
      kadrovskaMock(),
    );
    return { svc, storage };
  }

  it.each([
    `${CONV}/../${CONV}/x.png`,
    `${CONV}/a/b.png`,
    `../${CONV}/x.png`,
    `/etc/passwd`,
    `${CONV}/..`,
    `${CONV}/`,
    `not-a-uuid/x.png`,
    `${CONV}/x;y.png`,
  ])("odbija %s → 400, BEZ potpisivanja", async (bad) => {
    const { svc, storage } = make();
    await expect(svc.signImage("u@servoteh.com", bad)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(storage.signUrl).not.toHaveBeenCalled();
  });

  it("validan `{convId}/{uuid}.jpg` → potpisuje REKONSTRUISANU putanju", async () => {
    const { svc, storage } = make();
    const name = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jpg";
    await svc.signImage("u@servoteh.com", `${CONV}/${name}`);
    expect(storage.signUrl).toHaveBeenCalledWith(
      "ai-chat-images",
      `${CONV}/${name}`,
      3600,
    );
  });

  it("nit nevidljiva (RLS 0 redova) → 403, BEZ potpisivanja", async () => {
    const { svc, storage } = make(false);
    await expect(
      svc.signImage("u@servoteh.com", `${CONV}/x.jpg`),
    ).rejects.toThrow(/pristup/);
    expect(storage.signUrl).not.toHaveBeenCalled();
  });
});

/**
 * R2.3 execTool dispatch — „20 alata → RPC imena" (§0). Mokujemo sy15 da
 * uhvati SQL i AiProviderService.embed; NE zovemo živu bazu ni AI API.
 */
describe("AiChatService.execTool dispatch (alat → RPC ime)", () => {
  function make(result: unknown = { ok: true }) {
    const captured: string[] = [];
    const tx = {
      $queryRaw: jest.fn((sql: { strings?: string[] }) => {
        captured.push((sql.strings ?? []).join("?"));
        return Promise.resolve([{ result }]);
      }),
    };
    const sy15 = {
      withUser: jest.fn(),
      withUserRls: jest.fn((_e: string, fn: (t: unknown) => Promise<unknown>) =>
        fn(tx),
      ),
    };
    const ai = { embed: jest.fn().mockResolvedValue("[0.1]") };
    const storage = {};
    const svc = new AiChatService(
      sy15 as unknown as Sy15Service,
      ai as never,
      storage as never,
      limitsMock(),
      policyMock(),
      prismaMock(),
      kadrovskaMock(),
    );
    // `gate` je obavezan (review nalaz 4): lična nit, BEZ ijedne permisije —
    // dokaz da 20 sy15 alata i dalje radi bez app-permisije, kao i pre AI-1.
    const exec = (name: string, args: Record<string, unknown>) =>
      (
        svc as unknown as {
          execTool: (
            e: string,
            n: string,
            a: Record<string, unknown>,
            c: unknown,
            g: unknown,
          ) => Promise<unknown>;
        }
      ).execTool("u@servoteh.com", name, args, undefined, {
        scope: "personal",
        permissions: undefined,
        degraded: false,
      });
    return { exec, captured, ai };
  }

  it.each([
    ["go_saldo", "ai_chat_go_saldo"],
    ["sati_mesec", "ai_chat_sati"],
    ["moj_tim", "ai_chat_moj_tim"],
    ["sql_upit", "ai_chat_sql"],
    ["projekat_info", "ai_chat_projekat_info"],
    ["prijavi_kvar", "ai_chat_prijavi_kvar"],
    ["trazi_zaposlenog", "ai_chat_employee_lookup"],
  ])("%s → %s", async (tool, fn) => {
    const { exec, captured } = make();
    await exec(tool, {});
    expect(captured.join(" ")).toContain(fn);
  });

  it("pretrazi_uputstva: računa embedding pa zove ai_chat_pretrazi_uputstva", async () => {
    const { exec, captured, ai } = make();
    await exec("pretrazi_uputstva", { upit: "kako GO" });
    // Talas AI-0: embedding nosi merni kontekst (modul `embed` + korisnik).
    expect(ai.embed).toHaveBeenCalledWith("kako GO", {
      module: "embed",
      userId: null,
    });
    expect(captured.join(" ")).toContain("ai_chat_pretrazi_uputstva");
  });

  it("nepoznat alat → {error:'nepoznat_alat'} (ne baca)", async () => {
    const { exec } = make();
    await expect(exec("nema_me", {})).resolves.toEqual({
      error: "nepoznat_alat",
    });
  });

  // ── S-P0 paket 5: go_istorija (20. alat) ──

  it("go_istorija → go_ledger RPC + reshape u kompaktan DD.MM.YYYY oblik", async () => {
    const { exec, captured } = make([
      {
        godina: 2026,
        pravo: 20,
        iskorisceno: 6,
        planirano: 3,
        preostalo: 11,
        preneto: 2,
        iskorisceno_periodi: [
          { od: "2026-03-02", do: "2026-03-06", dana: 5 },
          { od: "2026-04-10", do: "2026-04-10", dana: 1 },
        ],
        planirano_periodi: [{ od: "2026-08-03", do: "2026-08-05", dana: 3 }],
        istorija_unosi: [
          { days: 4, kind: "go", dates: "01.07.-04.07.2024", comment: "" },
          { days: 2, kind: "go", dates: null }, // bez dates → otpada (1.0 filter)
        ],
      },
    ]);
    const out = (await exec("go_istorija", {})) as Record<string, unknown>[];
    expect(captured.join(" ")).toContain("go_ledger");
    expect(out[0]).toMatchObject({
      godina: 2026,
      pravo: 20,
      preostalo: 11,
      preneto: 2,
      iskorisceni_dani: [
        "02.03.2026.–06.03.2026. (5 d)",
        "10.04.2026. (1 d)", // od==do → jedan dan, bez opsega
      ],
      planirani_odobreni_dani: ["03.08.2026.–05.08.2026. (3 d)"],
    });
    expect(out[0].stara_evidencija).toEqual([
      { dana: 4, tip: "go", datumi: "01.07.-04.07.2024", napomena: undefined },
    ]);
  });

  it("go_istorija: ne-niz izlaz (npr. {error}) prolazi netaknut (reshape ne baca)", async () => {
    const { exec } = make({ error: "nema_prava" });
    await expect(exec("go_istorija", {})).resolves.toEqual({
      error: "nema_prava",
    });
  });
});

/**
 * chat() ugovor odgovora + greške (review #7/#8): odgovor nosi remaining/limit
 * (1.0 UI upozorenje), a greška engine-a NOSI conversationId (retry ne pravi
 * orphan nit koja troši dnevni limit).
 */
describe("AiChatService.chat (remaining/limit + upstream conversationId)", () => {
  const CONV = "3b241101-e2bb-4255-8caf-4136c566a962";
  function make(
    chatWithTools: jest.Mock,
    limits: AiLimitsService = limitsMock(),
    policy: AiModelPolicyService = policyMock(),
  ) {
    const tx = {
      // tx1 redosled: currentUid, resolveConversation(new), resolveAuthor.
      // Talas AI-0: brojanje dnevnog limita više NIJE u tx1 (izvor je
      // `ai_usage_log` u glavnoj bazi, kroz AiLimitsService).
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([{ uid: "U1" }]) // auth.uid()
        .mockResolvedValueOnce([{ id: CONV }]) // INSERT conversation RETURNING id
        .mockResolvedValueOnce([
          { full_name: "Pera Perić", position: "Monter" },
        ]),
      $executeRaw: jest.fn().mockResolvedValue(1),
    };
    const sy15 = {
      withUser: jest.fn((_e: string, fn: (t: unknown) => Promise<unknown>) =>
        fn(tx),
      ),
      withUserRls: jest.fn(),
    };
    const ai = {
      engineConfig: jest.fn().mockReturnValue({
        engine: "openai",
        kind: "openai",
        url: "u",
        key: "k",
        model: "m",
      }),
      chatWithTools,
      generateTitle: jest.fn().mockResolvedValue("Naslov"),
    };
    const svc = new AiChatService(
      sy15 as unknown as Sy15Service,
      ai as unknown as AiProviderService,
      {} as never,
      limits,
      policy,
      prismaMock(),
      kadrovskaMock(),
    );
    return { svc, ai, sy15 };
  }

  it("uspeh: odgovor nosi preostali TOKEN budžet i limit", async () => {
    const chatWithTools = jest.fn().mockResolvedValue({
      reply: "Zdravo!",
      model: "m",
      tokensIn: 1200,
      tokensOut: 40,
    });
    const { svc } = make(chatWithTools);
    const out = await svc.chat(
      "u@servoteh.com",
      { message: "cao" },
      undefined,
      {
        userId: 7,
        role: "sef",
      },
    );
    expect(out.data.conversationId).toBe(CONV);
    // mok budžeta: 200000 limit, 0 potrošeno → posle ovog kruga 200000 - 1200.
    expect(out.data.remaining).toBe(198_800);
    expect(out.data.limit).toBe(200_000);
    expect(out.data.unit).toBe("tokens");
  });

  it("Claude engine uzima model iz registra `ai_model_policy` (ne iz env-a)", async () => {
    const chatWithTools = jest.fn().mockResolvedValue({
      reply: "ok",
      model: "claude-opus-5",
      tokensIn: 10,
      tokensOut: 2,
    });
    // Registar vraća opus-5; engineConfig (mok) nudi „m" iz env-a.
    const { svc } = make(
      chatWithTools,
      limitsMock(),
      policyMock("claude-opus-5"),
    );
    await svc.chat("u@servoteh.com", { message: "cao", engine: "claude" });
    // 1. argument chatWithTools je EngineCfg — model MORA biti iz registra,
    // inače je izbor u Podešavanjima mrtvo slovo.
    const cfgArg = chatWithTools.mock.calls[0][0] as { model: string };
    expect(cfgArg.model).toBe("claude-opus-5");
  });

  it("prazan registar → Claude engine ostaje na env/default modelu", async () => {
    const chatWithTools = jest.fn().mockResolvedValue({
      reply: "ok",
      model: "m",
      tokensIn: 1,
      tokensOut: 1,
    });
    const { svc } = make(chatWithTools);
    await svc.chat("u@servoteh.com", { message: "cao", engine: "claude" });
    const cfgArg = chatWithTools.mock.calls[0][0] as { model: string };
    expect(cfgArg.model).toBe("m");
  });

  it("admin (limit -1) → nema brojača; remaining ostaje -1", async () => {
    const chatWithTools = jest.fn().mockResolvedValue({
      reply: "Zdravo!",
      model: "m",
      tokensIn: 5000,
      tokensOut: 10,
    });
    const { svc } = make(chatWithTools, unlimitedLimitsMock());
    const out = await svc.chat(
      "a@servoteh.com",
      { message: "cao" },
      undefined,
      {
        userId: 1,
        role: "admin",
      },
    );
    expect(out.data.limit).toBe(-1);
    expect(out.data.remaining).toBe(-1);
  });

  it("potrošen budžet → 429 PRE nego što se napravi nit (bez orphan konverzacije)", async () => {
    const chatWithTools = jest.fn();
    const { svc, sy15 } = make(chatWithTools, exhaustedLimitsMock());
    let err!: HttpException;
    try {
      await svc.chat("u@servoteh.com", { message: "cao" }, undefined, {
        userId: 7,
        role: "sef",
      });
    } catch (e) {
      err = e as HttpException;
    }
    expect(err.getStatus()).toBe(429);
    expect(sy15.withUser).not.toHaveBeenCalled();
    expect(chatWithTools).not.toHaveBeenCalled();
  });

  it("engine HTTP greška → 502 sa conversationId (upstream_error)", async () => {
    const chatWithTools = jest
      .fn()
      .mockRejectedValue(new BadGatewayException("upstream_error"));
    const { svc } = make(chatWithTools);
    let err!: HttpException;
    try {
      await svc.chat("u@servoteh.com", { message: "cao" });
    } catch (e) {
      err = e as HttpException;
    }
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(502);
    expect(err.getResponse()).toEqual({
      error: "upstream_error",
      conversationId: CONV,
    });
  });

  it("mrežni throw → 502 upstream_unreachable sa conversationId", async () => {
    const chatWithTools = jest
      .fn()
      .mockRejectedValue(new Error("ECONNREFUSED"));
    const { svc } = make(chatWithTools);
    let err!: HttpException;
    try {
      await svc.chat("u@servoteh.com", { message: "cao" });
    } catch (e) {
      err = e as HttpException;
    }
    expect(err.getStatus()).toBe(502);
    expect(err.getResponse()).toEqual({
      error: "upstream_unreachable",
      conversationId: CONV,
    });
  });
});

/**
 * Floating AI widget (request 003/26): when the client sends `screenContext`,
 * the system prompt (chatWithTools arg #4) gains a "TRENUTNI EKRAN KORISNIKA"
 * branch so the assistant helps with the current form first; without it, the
 * branch is absent (ordering SYSTEM_PROMPT/DATE_LINE/scope-note preserved).
 */
describe("AiChatService.chat (screenContext u system prompt)", () => {
  const CONV = "3b241101-e2bb-4255-8caf-4136c566a962";
  function make() {
    const tx = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([{ uid: "U1" }]) // auth.uid()
        .mockResolvedValueOnce([{ used: 3 }]) // dnevni limit
        .mockResolvedValueOnce([{ id: CONV }]) // INSERT conversation RETURNING id
        .mockResolvedValueOnce([
          { full_name: "Pera Perić", position: "Monter" },
        ]),
      $executeRaw: jest.fn().mockResolvedValue(1),
    };
    const sy15 = {
      withUser: jest.fn((_e: string, fn: (t: unknown) => Promise<unknown>) =>
        fn(tx),
      ),
      withUserRls: jest.fn(),
    };
    const chatWithTools = jest.fn().mockResolvedValue({
      reply: "ok",
      model: "m",
      tokensIn: 1,
      tokensOut: 1,
    });
    const ai = {
      engineConfig: jest.fn().mockReturnValue({
        engine: "openai",
        kind: "openai",
        url: "u",
        key: "k",
        model: "m",
      }),
      chatWithTools,
      generateTitle: jest.fn().mockResolvedValue("Naslov"),
    };
    const svc = new AiChatService(
      sy15 as unknown as Sy15Service,
      ai as unknown as AiProviderService,
      {} as never,
      limitsMock(),
      policyMock(),
      prismaMock(),
      kadrovskaMock(),
    );
    // system prompt = 5. argument chatWithTools (cfg, hist, msg, tools, system, ...)
    const systemArg = () => chatWithTools.mock.calls[0][4] as string;
    return { svc, systemArg };
  }

  it("prosleđen screenContext → grana 'TRENUTNI EKRAN KORISNIKA' u system prompt-u", async () => {
    const { svc, systemArg } = make();
    await svc.chat("u@servoteh.com", {
      message: "cao",
      screenContext: "Sastanci (/sastanci)",
    });
    expect(systemArg()).toContain(
      "TRENUTNI EKRAN KORISNIKA: Sastanci (/sastanci)",
    );
  });

  it("bez screenContext-a → nema te grane u system prompt-u", async () => {
    const { svc, systemArg } = make();
    await svc.chat("u@servoteh.com", { message: "cao" });
    expect(systemArg()).not.toContain("TRENUTNI EKRAN KORISNIKA");
  });

  // Deljena projektna nit ima svoj timski kontekst — per-korisnik hint o ekranu se
  // NE dodaje (review 003/26): system prompt ne sme sadržati „TRENUTNI EKRAN".
  it("project scope: screenContext se IGNORIŠE (nema grane)", async () => {
    const tx = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([{ uid: "U1" }]) // auth.uid()
        .mockResolvedValueOnce([{ used: 3 }]) // dnevni limit
        .mockResolvedValueOnce([{ id: CONV }]) // postojeća projektna nit
        .mockResolvedValueOnce([]) // loadHistory (nit nije nova)
        .mockResolvedValueOnce([
          { full_name: "Pera Perić", position: "Monter" },
        ]),
      $executeRaw: jest.fn().mockResolvedValue(1),
    };
    const sy15 = {
      withUser: jest.fn((_e: string, fn: (t: unknown) => Promise<unknown>) =>
        fn(tx),
      ),
      withUserRls: jest.fn(),
    };
    const chatWithTools = jest.fn().mockResolvedValue({
      reply: "ok",
      model: "m",
      tokensIn: 1,
      tokensOut: 1,
    });
    const ai = {
      engineConfig: jest.fn().mockReturnValue({
        engine: "openai",
        kind: "openai",
        url: "u",
        key: "k",
        model: "m",
      }),
      chatWithTools,
      generateTitle: jest.fn().mockResolvedValue("Naslov"),
    };
    const svc = new AiChatService(
      sy15 as unknown as Sy15Service,
      ai as unknown as AiProviderService,
      {} as never,
      limitsMock(),
      policyMock(),
      prismaMock(),
      kadrovskaMock(),
    );
    await svc.chat("u@servoteh.com", {
      message: "cao",
      projectRef: "9400/7",
      screenContext: "Sastanci (/sastanci)",
    });
    expect(chatWithTools.mock.calls[0][4] as string).not.toContain(
      "TRENUTNI EKRAN KORISNIKA",
    );
  });
});

/**
 * TALAS AI-1 — brana alata nad GLAVNOM bazom + audit poziva alata.
 *
 * Glavna baza NEMA RLS (0 politika na 176 tabela), pa je permisija korisnika
 * JEDINA odbrana. Zato se proverava na DVA mesta i oba su ovde pinovana:
 *   • šta se NUDI modelu (`chatWithTools` 4. argument),
 *   • šta se sme IZVRŠITI (`execTool` — model ume da izmisli ime alata).
 * Treći deo: svaki poziv alata ide u `audit_log` (AuditInterceptor vidi samo
 * HTTP mutacije, a alati se izvršavaju unutar jednog POST /ai/chat).
 */
describe("AiChatService — permisijska brana alata + audit (Talas AI-1)", () => {
  const CONV = "3b241101-e2bb-4255-8caf-4136c566a962";

  /** `audit_log` upis iz moka — tipizovano, da assert ne radi nad `any`. */
  interface AuditRow {
    action: string;
    entityType: string;
    entityId: string;
    actorUserId: number | null;
    actorUsername: string | null;
    afterData: { argumenti: string; ishod: string; trajanje_ms: number };
  }
  const auditCreate = (prisma: PrismaService): jest.Mock =>
    (prisma as unknown as { auditLog: { create: jest.Mock } }).auditLog.create;
  const auditData = (prisma: PrismaService, call: number): AuditRow =>
    (auditCreate(prisma).mock.calls[call] as [{ data: AuditRow }])[0].data;

  function makeChat(overrides: { key: string; allow: boolean }[] = []) {
    const tx = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([{ uid: "U1" }])
        .mockResolvedValueOnce([{ id: CONV }])
        .mockResolvedValueOnce([
          { full_name: "Pera Perić", position: "Tehnolog" },
        ]),
      $executeRaw: jest.fn().mockResolvedValue(1),
    };
    const sy15 = {
      withUser: jest.fn((_e: string, fn: (t: unknown) => Promise<unknown>) =>
        fn(tx),
      ),
      withUserRls: jest.fn(),
    };
    const chatWithTools = jest.fn().mockResolvedValue({
      reply: "ok",
      model: "m",
      tokensIn: 10,
      tokensOut: 5,
    });
    const ai = {
      engineConfig: jest.fn().mockReturnValue({
        engine: "openai",
        kind: "openai",
        url: "u",
        key: "k",
        model: "m",
      }),
      chatWithTools,
      generateTitle: jest.fn().mockResolvedValue("Naslov"),
    };
    const prisma = prismaMock(overrides);
    const svc = new AiChatService(
      sy15 as unknown as Sy15Service,
      ai as unknown as AiProviderService,
      {} as never,
      limitsMock(),
      policyMock(),
      prisma,
      kadrovskaMock(),
    );
    /** 4. argument `chatWithTools` = šeme alata koje su STVARNO ponuđene modelu. */
    const ponudjeni = (): string[] => {
      const call = chatWithTools.mock.calls[0] as unknown[];
      return (call[3] as { name: string }[]).map((t) => t.name);
    };
    return { svc, prisma, ponudjeni, chatWithTools };
  }

  it("tehnolog (ima rn.read) DOBIJA proizvodne alate", async () => {
    const { svc, ponudjeni } = makeChat();
    await svc.chat("u@servoteh.com", { message: "gde je RN 9400" }, undefined, {
      userId: 7,
      role: "tehnolog",
    });
    expect(ponudjeni()).toContain("nadji_radni_nalog");
    expect(ponudjeni()).toContain("istorija_crteza");
    expect(ponudjeni()).toContain("go_saldo"); // sy15 alati nepromenjeni
  });

  it("deny override na rn.read SKIDA alat iz ponude (deny > rola)", async () => {
    const { svc, ponudjeni } = makeChat([{ key: "rn.read", allow: false }]);
    await svc.chat("u@servoteh.com", { message: "gde je RN 9400" }, undefined, {
      userId: 7,
      role: "tehnolog",
    });
    expect(ponudjeni()).not.toContain("nadji_radni_nalog");
    // …a alat koji zavisi od druge permisije ostaje.
    expect(ponudjeni()).toContain("istorija_crteza");
  });

  it("bez actor-a (nepoznat pozivalac) nudi se SAMO starih 20 — fail-closed", async () => {
    const { svc, ponudjeni } = makeChat();
    await svc.chat("u@servoteh.com", { message: "zdravo" });
    expect(ponudjeni()).toHaveLength(20);
    expect(ponudjeni()).not.toContain("nadji_radni_nalog");
  });

  it("izvršenje bez permisije → nema_prava, upit nad glavnom bazom se NE pokreće", async () => {
    const { svc, prisma } = makeChat();
    const out = await (
      svc as unknown as {
        execTool: (
          e: string,
          n: string,
          a: Record<string, unknown>,
          c?: unknown,
          g?: unknown,
        ) => Promise<unknown>;
      }
    ).execTool(
      "u@servoteh.com",
      "nadji_radni_nalog",
      { upit: "x" },
      undefined,
      {
        scope: "personal",
        permissions: new Set<string>(),
      },
    );
    expect(out).toEqual({ error: "nema_prava" });
    expect(
      (prisma as unknown as { $queryRaw?: jest.Mock }).$queryRaw,
    ).toBeUndefined();
  });

  it("svaki poziv alata se beleži u audit_log (ime, korisnik, trajanje, ishod)", async () => {
    const { svc, prisma } = makeChat();
    await (
      svc as unknown as {
        execTool: (
          e: string,
          n: string,
          a: Record<string, unknown>,
          c?: unknown,
          g?: unknown,
        ) => Promise<unknown>;
      }
    ).execTool(
      "u@servoteh.com",
      "nadji_radni_nalog",
      { upit: "tajna" },
      { module: "chat", userId: 7 },
      { scope: "personal", permissions: new Set<string>(), degraded: false },
    );
    const create = auditCreate(prisma);
    expect(create).toHaveBeenCalledTimes(1);
    const data = auditData(prisma, 0);
    expect(data).toMatchObject({
      action: "AI_TOOL",
      entityType: "ai-tool",
      entityId: "nadji_radni_nalog",
      actorUserId: 7,
      actorUsername: "u@servoteh.com",
    });
    expect(data.afterData.ishod).toBe("nema_prava");
    expect(data.afterData.argumenti).toContain("tajna");
    expect(typeof data.afterData.trajanje_ms).toBe("number");
  });

  it("nepoznato ime alata: nepoznat_alat + audit trag (halucinacija modela)", async () => {
    const { svc, prisma } = makeChat();
    const out = await (
      svc as unknown as {
        execTool: (
          e: string,
          n: string,
          a: Record<string, unknown>,
          c: unknown,
          g: unknown,
        ) => Promise<unknown>;
      }
    ).execTool("u@servoteh.com", "izmisljen_alat", {}, undefined, {
      scope: "personal",
      permissions: undefined,
      degraded: false,
    });
    expect(out).toEqual({ error: "nepoznat_alat" });
    expect(auditData(prisma, 0).afterData.ishod).toBe("nepoznat_alat");
  });

  /**
   * Nalaz 10 — „ne mogu da proverim" NIJE „nemaš pravo". Kratak ispad glavne baze
   * bi bez ovoga korisniku stigao kao tvrdnja da mu je pristup oduzet, pa bi
   * zvao administratora zbog kvara koji prođe sam.
   */
  it("pad citanja permisija → privremena greska, NE lazno nemate prava", async () => {
    const { svc, prisma } = makeChat();
    const out = (await (
      svc as unknown as {
        execTool: (
          e: string,
          n: string,
          a: Record<string, unknown>,
          c: unknown,
          g: unknown,
        ) => Promise<unknown>;
      }
    ).execTool(
      "u@servoteh.com",
      "nadji_radni_nalog",
      { upit: "x" },
      undefined,
      {
        scope: "personal",
        permissions: undefined,
        degraded: true,
      },
    )) as { error: string; poruka: string };
    expect(out.error).toBe("provera_prava_nedostupna");
    expect(out.poruka).toContain("pokuša ponovo");
    expect(auditData(prisma, 0).afterData.ishod).toBe("degradirano");
  });

  it("degraded NE utiče na sy15 alate (oni ne traže app-permisiju)", async () => {
    const { svc } = makeChat();
    const out = await (
      svc as unknown as {
        execTool: (
          e: string,
          n: string,
          a: Record<string, unknown>,
          c: unknown,
          g: unknown,
        ) => Promise<unknown>;
      }
    ).execTool("u@servoteh.com", "moj_tim", {}, undefined, {
      scope: "personal",
      permissions: undefined,
      degraded: true,
    });
    // sy15 mok nema withUserRls implementaciju → alat pukne i vrati
    // `alat_neuspesan`; bitno je da NIJE odbijen na brani.
    expect(out).not.toEqual({ error: "provera_prava_nedostupna" });
    expect(out).not.toEqual({ error: "nema_prava" });
  });
});
