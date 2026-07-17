import { StreamableFile } from "@nestjs/common";
import type { Response } from "express";
import { PdmController } from "./pdm.controller";
import { PdmService } from "./pdm.service";
import { PdmImportService } from "./pdm-import.service";
import { PrismaService } from "../../prisma/prisma.service";
import type { AuthUser } from "../auth/jwt.strategy";

/**
 * SEC-02 — audit pristupa PDF-u crteža (PDM ruta, PDM_READ).
 * Pinuje: (1) pdfContent upisuje audit_log red action='DRAWING-PDF-ACCESS'
 * (metadata.route='pdm') i vraća StreamableFile; (2) BEST-EFFORT — pad
 * auditLog.create NE obara strim PDF-a.
 */

function resMock(): Response {
  return { set: jest.fn() } as unknown as Response;
}

const user: AuthUser = {
  userId: 7,
  email: "tehnolog@servoteh.com",
  role: "tehnolog",
  workerId: 77,
};

function makeController(opts: { createImpl?: () => Promise<unknown> }) {
  const create = jest.fn(
    opts.createImpl ?? (() => Promise.resolve({ id: 1 })),
  );
  const getPdfContent = jest
    .fn()
    .mockResolvedValue({ buffer: Buffer.from("%PDF-1.4"), fileName: "crtez.pdf" });
  const prisma = { auditLog: { create } } as unknown as PrismaService;
  const pdm = { getPdfContent } as unknown as PdmService;
  const pdmImport = {} as unknown as PdmImportService;
  const controller = new PdmController(pdm, pdmImport, prisma);
  return { controller, create, getPdfContent };
}

describe("PdmController — pdfContent SEC-02 audit", () => {
  it("upisuje audit_log (action, entityId, route='pdm', actor) i vraća StreamableFile", async () => {
    const { controller, create, getPdfContent } = makeController({});
    const res = resMock();

    const out = await controller.pdfContent(1134219, undefined, res, {
      user,
    });

    expect(out).toBeInstanceOf(StreamableFile);
    expect(getPdfContent).toHaveBeenCalledWith(1134219);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      data: {
        action: "DRAWING-PDF-ACCESS",
        entityType: "drawing",
        entityId: "1134219",
        actorUserId: 7,
        actorUsername: "tehnolog@servoteh.com",
        metadata: { route: "pdm", download: false },
      },
    });
  });

  it("BEST-EFFORT: pad auditLog.create NE obara strim — PDF se svejedno vrati", async () => {
    const { controller, getPdfContent } = makeController({
      createImpl: () => Promise.reject(new Error("audit_log nedostupan")),
    });

    const out = await controller.pdfContent(10, "true", resMock(), {
      user,
    });

    expect(out).toBeInstanceOf(StreamableFile);
    expect(getPdfContent).toHaveBeenCalledWith(10);
  });
});
