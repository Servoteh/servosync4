import { StreamableFile } from "@nestjs/common";
import type { Response } from "express";
import { TechProcessesController } from "./tech-processes.controller";
import { TechProcessesService } from "./tech-processes.service";
import { PdmService } from "../pdm/pdm.service";
import { PrismaService } from "../../prisma/prisma.service";
import type { AuthUser } from "../auth/jwt.strategy";

/**
 * SEC-02 — audit pristupa PDF-u crteža (kiosk ruta, TEHNOLOGIJA_READ).
 * Pinuje: (1) svaki poziv pdfContent upisuje audit_log red action=
 * 'DRAWING-PDF-ACCESS' sa entityId=String(id) i actor iz req.user, i vraća
 * StreamableFile; (2) BEST-EFFORT — pad auditLog.create NE obara strim PDF-a.
 */

// Minimalni Express Response mock — controller zove samo res.set(...).
function resMock(): Response {
  return { set: jest.fn() } as unknown as Response;
}

const user: AuthUser = {
  userId: 42,
  email: "kiosk@servoteh.com",
  role: "proizvodni_radnik",
  workerId: null,
};

function makeController(opts: {
  createImpl?: () => Promise<unknown>;
  pdf?: { buffer: Buffer; fileName: string };
}) {
  const create = jest.fn<Promise<unknown>, [unknown]>(
    opts.createImpl ?? (() => Promise.resolve({ id: 1 })),
  );
  const getPdfContent = jest.fn().mockResolvedValue(
    opts.pdf ?? { buffer: Buffer.from("%PDF-1.4"), fileName: "crtez.pdf" },
  );
  const prisma = { auditLog: { create } } as unknown as PrismaService;
  const pdm = { getPdfContent } as unknown as PdmService;
  const techProcesses = {} as unknown as TechProcessesService;
  // Q11 servis je 2. parametar konstruktora (SEC-02 ruta ga ne koristi) — prazan mock.
  const sessionAutoClose = {} as unknown as import("./session-auto-close.service").SessionAutoCloseService;
  const controller = new TechProcessesController(
    techProcesses,
    sessionAutoClose,
    pdm,
    prisma,
  );
  return { controller, create, getPdfContent };
}

describe("TechProcessesController — pdfContent SEC-02 audit", () => {
  it("upisuje audit_log (action, entityId, actor iz req.user) i vraća StreamableFile", async () => {
    const { controller, create, getPdfContent } = makeController({});
    const res = resMock();

    const out = await controller.pdfContent(137, undefined, res, {
      user,
    });

    expect(out).toBeInstanceOf(StreamableFile);
    expect(getPdfContent).toHaveBeenCalledWith(137);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      data: {
        action: "DRAWING-PDF-ACCESS",
        entityType: "drawing",
        entityId: "137",
        actorUserId: 42,
        actorUsername: "kiosk@servoteh.com",
        metadata: { route: "kiosk", download: false },
      },
    });
  });

  it("download=true → metadata.download true (attachment putanja)", async () => {
    const { controller, create } = makeController({});
    await controller.pdfContent(9, "true", resMock(), { user });

    const arg = create.mock.calls[0][0] as {
      data: { metadata: { download: boolean } };
    };
    expect(arg.data.metadata.download).toBe(true);
  });

  it("BEST-EFFORT: pad auditLog.create NE obara strim — PDF se svejedno vrati", async () => {
    const { controller, getPdfContent } = makeController({
      createImpl: () => Promise.reject(new Error("audit_log nedostupan")),
    });

    const out = await controller.pdfContent(5, undefined, resMock(), {
      user,
    });

    // Iako audit padne, strim se vraća netaknut.
    expect(out).toBeInstanceOf(StreamableFile);
    expect(getPdfContent).toHaveBeenCalledWith(5);
  });
});
