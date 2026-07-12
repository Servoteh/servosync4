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
    };
    const sy15 = {
      withUser: jest.fn(),
      withUserRls: jest.fn(
        (_email: string, fn: (t: unknown) => Promise<unknown>) => fn(tx),
      ),
    };
    const svc = new AiChatService(sy15 as unknown as Sy15Service);
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
});
