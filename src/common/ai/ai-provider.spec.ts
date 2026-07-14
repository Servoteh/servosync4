import { AiProviderService, type EngineCfg } from "./ai-provider.service";

/**
 * Tool-loop skeleton sa MOKOVANIM engine-om (bez živih AI API-ja): pinuje da
 * chatWithTools dispatch-uje alat (execTool) na oba puta (OpenAI-kompatibilan i
 * Anthropic) i vrati finalni tekst. Ne dira sy15 ni mrežu.
 */
describe("AiProviderService.chatWithTools (mocked engine)", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  const svc = new AiProviderService();
  const okJson = (body: unknown) =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve(body),
    } as Response);

  it("OpenAI-put: tool_call → execTool → drugi krug vraća tekst", async () => {
    const fetchMock = jest
      .fn()
      .mockReturnValueOnce(
        okJson({
          choices: [
            {
              message: {
                tool_calls: [
                  { id: "c1", function: { name: "go_saldo", arguments: "{}" } },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      )
      .mockReturnValueOnce(
        okJson({
          choices: [{ message: { content: "Preostalo: 12 dana" } }],
          usage: { prompt_tokens: 4, completion_tokens: 6 },
        }),
      );
    global.fetch = fetchMock;

    const execTool = jest.fn().mockResolvedValue({ preostalo: 12 });
    const cfg: EngineCfg = {
      engine: "openai",
      kind: "openai",
      url: "https://x/chat",
      key: "k",
      model: "gpt-4o-mini",
    };
    const out = await svc.chatWithTools(
      cfg,
      [],
      "koliko GO",
      [
        {
          name: "go_saldo",
          description: "d",
          input: { type: "object", properties: {} },
        },
      ],
      "sys",
      null,
      execTool,
    );
    expect(execTool).toHaveBeenCalledWith("go_saldo", {});
    expect(out.reply).toBe("Preostalo: 12 dana");
    expect(out.tokensIn).toBe(14);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("Anthropic-put: stop_reason=tool_use → execTool → tekst blok", async () => {
    const fetchMock = jest
      .fn()
      .mockReturnValueOnce(
        okJson({
          stop_reason: "tool_use",
          content: [{ type: "tool_use", id: "t1", name: "moj_tim", input: {} }],
          usage: { input_tokens: 8, output_tokens: 3 },
        }),
      )
      .mockReturnValueOnce(
        okJson({
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Tvoj tim ima 5 ljudi." }],
          usage: { input_tokens: 2, output_tokens: 4 },
        }),
      );
    global.fetch = fetchMock;

    const execTool = jest.fn().mockResolvedValue({ tim: [] });
    const cfg: EngineCfg = {
      engine: "claude",
      kind: "anthropic",
      url: "https://a/messages",
      key: "k",
      model: "claude-sonnet-5",
    };
    const out = await svc.chatWithTools(
      cfg,
      [],
      "ko je u mom timu",
      [{ name: "moj_tim", description: "d", input: { type: "object" } }],
      "sys",
      null,
      execTool,
    );
    expect(execTool).toHaveBeenCalledWith("moj_tim", {});
    expect(out.reply).toBe("Tvoj tim ima 5 ljudi.");
  });

  it("upstream !ok → BadGateway (502)", async () => {
    global.fetch = jest.fn().mockReturnValue(
      Promise.resolve({
        ok: false,
        status: 500,
        text: () => Promise.resolve("x"),
      } as Response),
    );
    const cfg: EngineCfg = {
      engine: "openai",
      kind: "openai",
      url: "https://x",
      key: "k",
      model: "m",
    };
    await expect(
      svc.chatWithTools(cfg, [], "hi", [], "sys", null, jest.fn()),
    ).rejects.toMatchObject({ status: 502 });
  });

  it("engineConfig: bez ključa → null (boot-safe 503)", () => {
    const old = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    expect(svc.engineConfig("openai")).toBeNull();
    if (old !== undefined) process.env.OPENAI_API_KEY = old;
  });
});
