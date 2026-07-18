import {
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { PodesavanjaService } from "./podesavanja.service";
import type { Sy15Service } from "../../common/sy15/sy15.service";

/**
 * P12a (AI modeli u Sistem) + P7 (grid urednici write). Pinuje: (1) GET ai-models vraća oba
 * potrošača (sastanci ∪ montaza), (2) PUT ai-models zove tačan RPC po target-u + allowlist 422,
 * (3) addGridEditor duplikat → 409 (provera pre inserta), (4) removeGridEditor 0 redova → 404.
 */
type SqlLike = { strings: string[]; values: unknown[] };
const qText = (m: jest.Mock, n = 0): string =>
  (m.mock.calls[n]?.[0] as SqlLike).strings.join("?");

function makeSvc() {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    kadrGridEditorAllowlist: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ email: "x@y.com", note: "" }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const sy15 = {
    withUserRls: jest.fn((_e: string, fn: (t: unknown) => Promise<unknown>) =>
      fn(tx),
    ),
  };
  const svc = new PodesavanjaService(sy15 as unknown as Sy15Service);
  return { svc, sy15, tx };
}

describe("PodesavanjaService — AI modeli + grid urednici (P12a/P7)", () => {
  // ---------- P12a: AI modeli ----------

  it("aiModels: vraća sastanci + montaza (oba singleton id=1)", async () => {
    const { svc, tx } = makeSvc();
    tx.$queryRaw.mockImplementation((sql: unknown) => {
      const text = (sql as SqlLike).strings.join("?");
      if (text.includes("sastanci_ai_settings"))
        return Promise.resolve([{ id: 1, model: "claude-opus-4-8" }]);
      if (text.includes("montaza_ai_settings"))
        return Promise.resolve([{ id: 1, model: "claude-sonnet-4-6" }]);
      return Promise.resolve([]);
    });
    const out = await svc.aiModels("admin@x");
    const d = out.data as {
      sastanci: { model: string } | null;
      montaza: { model: string } | null;
    };
    expect(d.sastanci?.model).toBe("claude-opus-4-8");
    expect(d.montaza?.model).toBe("claude-sonnet-4-6");
  });

  it("setAiModel(sastanci): zove set_sastanci_ai_model", async () => {
    const { svc, tx } = makeSvc();
    tx.$queryRaw.mockResolvedValue([{ model: "claude-haiku-4-5" }]);
    const out = await svc.setAiModel("admin@x", "sastanci", "claude-haiku-4-5");
    expect(qText(tx.$queryRaw)).toContain("set_sastanci_ai_model(");
    expect((out.data as { target: string; model: string }).target).toBe(
      "sastanci",
    );
  });

  it("setAiModel(montaza): zove set_montaza_ai_model", async () => {
    const { svc, tx } = makeSvc();
    tx.$queryRaw.mockResolvedValue([{ model: "claude-opus-4-8" }]);
    await svc.setAiModel("admin@x", "montaza", "claude-opus-4-8");
    expect(qText(tx.$queryRaw)).toContain("set_montaza_ai_model(");
  });

  it("setAiModel: model van allowliste → 422 (pre RPC-a, sinhrono)", () => {
    const { svc, tx } = makeSvc();
    expect(() => svc.setAiModel("admin@x", "sastanci", "gpt-4o")).toThrow(
      UnprocessableEntityException,
    );
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  // ---------- P7: grid urednici ----------

  it("addGridEditor: nov email → create (normalizovan trim+lower)", async () => {
    const { svc, tx } = makeSvc();
    tx.kadrGridEditorAllowlist.findUnique.mockResolvedValue(null);
    await svc.addGridEditor("admin@x", "  Novi@Y.COM ", "beleska");
    expect(tx.kadrGridEditorAllowlist.findUnique).toHaveBeenCalledWith({
      where: { email: "novi@y.com" },
    });
    expect(tx.kadrGridEditorAllowlist.create).toHaveBeenCalledWith({
      data: { email: "novi@y.com", note: "beleska" },
    });
  });

  it("addGridEditor: duplikat → 409 (provera pre inserta)", async () => {
    const { svc, tx } = makeSvc();
    tx.kadrGridEditorAllowlist.findUnique.mockResolvedValue({
      email: "x@y.com",
      note: "",
    });
    await expect(
      svc.addGridEditor("admin@x", "x@y.com"),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.kadrGridEditorAllowlist.create).not.toHaveBeenCalled();
  });

  it("removeGridEditor: obriše po email-u; 0 redova → 404", async () => {
    const { svc, tx } = makeSvc();
    tx.kadrGridEditorAllowlist.deleteMany.mockResolvedValue({ count: 1 });
    const out = await svc.removeGridEditor("admin@x", "X@Y.com");
    expect(tx.kadrGridEditorAllowlist.deleteMany).toHaveBeenCalledWith({
      where: { email: "x@y.com" },
    });
    expect((out.data as { deleted: boolean }).deleted).toBe(true);

    const s2 = makeSvc();
    s2.tx.kadrGridEditorAllowlist.deleteMany.mockResolvedValue({ count: 0 });
    await expect(
      s2.svc.removeGridEditor("admin@x", "nema@y.com"),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
