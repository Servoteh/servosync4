import { BadRequestException } from "@nestjs/common";
import { MediaAiService } from "./media-ai.service";
import type { AiProviderService } from "../../common/ai/ai-provider.service";

/**
 * Media/AI (B4) — jedinični (bez živih AI API-ja): refine bira system po profilu,
 * STT prosleđuje bajtove/mime, prazan ulaz → 400.
 */
describe("MediaAiService", () => {
  function make() {
    const ai = {
      refine: jest.fn().mockResolvedValue({ text: "sredjeno", model: "m" }),
      transcribe: jest.fn().mockResolvedValue({ text: "cao", model: "w" }),
    };
    const svc = new MediaAiService(ai as unknown as AiProviderService);
    return { svc, ai };
  }
  /** N-ti argument prvog poziva mocka (izbegava no-unsafe-member-access). */
  const callArg = (m: jest.Mock, arg: number): unknown =>
    (m.mock.calls as unknown as unknown[][])[0][arg];

  it("refine: profil 'zapisnik' → system sadrži pravila zapisnika + BASE_RULES", async () => {
    const { svc, ai } = make();
    await svc.refine({ tekst: "sirov tekst", profil: "zapisnik" });
    const system = callArg(ai.refine, 1) as string;
    expect(system).toContain("ZAPISNIK");
    expect(system).toContain("LATINICOM");
  });

  it("refine: nepoznat/izostavljen profil → default prompt", async () => {
    const { svc, ai } = make();
    await svc.refine({ tekst: "x" });
    const system = callArg(ai.refine, 1) as string;
    expect(system).toContain("Doteraj tekst");
  });

  it("refine: prazan tekst → 400", async () => {
    const { svc } = make();
    await expect(svc.refine({ tekst: "   " })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("stt: prosleđuje bajtove + mime AiProvider-u", async () => {
    const { svc, ai } = make();
    const buf = Buffer.alloc(500, 1);
    await svc.transcribe({ lang: "sr", context: "chat" }, {
      buffer: buf,
      mimetype: "audio/webm",
    } as unknown as Express.Multer.File);
    const arg = callArg(ai.transcribe, 0) as {
      mime: string;
      context?: string;
    };
    expect(arg.mime).toBe("audio/webm");
    expect(arg.context).toBe("chat");
  });

  it("stt: bez fajla → 400", async () => {
    const { svc } = make();
    await expect(svc.transcribe({})).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("stt: prekratak snimak (<200B) → 400", async () => {
    const { svc } = make();
    await expect(
      svc.transcribe({}, {
        buffer: Buffer.alloc(10),
        mimetype: "audio/webm",
      } as unknown as Express.Multer.File),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
