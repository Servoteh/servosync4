import { AiChatService } from "./ai-chat.service";
import type { Sy15Service } from "../../common/sy15/sy15.service";

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
 * R2.3 execTool dispatch — „18 alata → ai_chat_* RPC imena" (§0). Mokujemo sy15 da
 * uhvati SQL i AiProviderService.embed; NE zovemo živu bazu ni AI API.
 */
describe("AiChatService.execTool dispatch (alat → RPC ime)", () => {
  function make() {
    const captured: string[] = [];
    const tx = {
      $queryRaw: jest.fn((sql: { strings?: string[] }) => {
        captured.push((sql.strings ?? []).join("?"));
        return Promise.resolve([{ result: { ok: true } }]);
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
});
