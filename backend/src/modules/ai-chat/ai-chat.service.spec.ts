import {
  BadGatewayException,
  BadRequestException,
  HttpException,
} from "@nestjs/common";
import { AiChatService } from "./ai-chat.service";
import type { Sy15Service } from "../../common/sy15/sy15.service";
import type { AiProviderService } from "../../common/ai/ai-provider.service";

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

  it("me + limit idu kroz withUserRls (auth.uid() iz GUC claims)", async () => {
    const { svc, sy15, tx } = makeSvc();
    await svc.me("test@servoteh.com");
    tx.$queryRaw.mockResolvedValueOnce([{ used: 12 }]);
    const out = await svc.limit("test@servoteh.com");
    expect(out.data).toEqual({ used: 12, limit: 50, remaining: 38 });
    expect(sy15.withUserRls).toHaveBeenCalledTimes(2);
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
    );
    const exec = (name: string, args: Record<string, unknown>) =>
      (
        svc as unknown as {
          execTool: (
            e: string,
            n: string,
            a: Record<string, unknown>,
          ) => Promise<unknown>;
        }
      ).execTool("u@servoteh.com", name, args);
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
    expect(ai.embed).toHaveBeenCalledWith("kako GO");
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
  function make(chatWithTools: jest.Mock) {
    const tx = {
      // tx1 redosled: currentUid, dailyUsed, resolveConversation(new), resolveAuthor
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
    );
    return { svc, ai };
  }

  it("uspeh: odgovor nosi remaining = limit-used-1 i limit", async () => {
    const chatWithTools = jest.fn().mockResolvedValue({
      reply: "Zdravo!",
      model: "m",
      tokensIn: 1,
      tokensOut: 1,
    });
    const { svc } = make(chatWithTools);
    const out = await svc.chat("u@servoteh.com", { message: "cao" });
    expect(out.data.conversationId).toBe(CONV);
    expect(out.data.remaining).toBe(46); // 50 - 3 - 1
    expect(out.data.limit).toBe(50);
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
