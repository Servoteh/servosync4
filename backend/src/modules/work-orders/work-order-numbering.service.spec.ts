import { NotFoundException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { WorkOrderNumberingService } from "./work-order-numbering.service";

/**
 * Bug 030/26: legacy typo ident bez kose crte ('770171831') je preko
 * split('/').pop() hranio brojač sa stotinama miliona. Parser sada broji samo
 * ident sa `<projectNumber>/` prefiksom + sanity-cap na ordinal.
 */
describe("WorkOrderNumberingService.next", () => {
  const svc = new WorkOrderNumberingService();

  function txWith(
    projectNumber: string | null,
    idents: string[],
  ): Prisma.TransactionClient {
    return {
      $executeRaw: jest.fn().mockResolvedValue(0),
      project: {
        findUnique: jest
          .fn()
          .mockResolvedValue(projectNumber === null ? null : { projectNumber }),
      },
      workOrder: {
        findMany: jest
          .fn()
          .mockResolvedValue(idents.map((identNumber) => ({ identNumber }))),
      },
    } as unknown as Prisma.TransactionClient;
  }

  it("redovan niz: MAX+1", async () => {
    const r = await svc.next(txWith("7701", ["7701/2272", "7701/2273"]), 9068);
    expect(r).toEqual({ identNumber: "7701/2274", variant: 0 });
  });

  it("prazan predmet: kreće od 1", async () => {
    const r = await svc.next(txWith("7701", []), 9068);
    expect(r.identNumber).toBe("7701/1");
  });

  it("legacy typo bez kose crte se ignoriše (koren baga 030/26)", async () => {
    const r = await svc.next(
      txWith("7701", ["7701/1830", "770171831"]),
      9068,
    );
    expect(r.identNumber).toBe("7701/1831");
  });

  it("apsurdan ordinal sa ispravnim prefiksom se ignoriše (sanity-cap — zatečeni 7701/770171832…34)", async () => {
    const r = await svc.next(
      txWith("7701", ["7701/2273", "7701/770171832", "7701/770171834"]),
      9068,
    );
    expect(r.identNumber).toBe("7701/2274");
  });

  it("predmet sa kosom crtom u broju ('9400/7'): prefiks je ceo broj predmeta", async () => {
    const r = await svc.next(
      txWith("9400/7", ["9400/7/39", "9400/7/72"]),
      9400,
    );
    expect(r.identNumber).toBe("9400/7/73");
  });

  it("nepostojeći predmet: NotFoundException", async () => {
    await expect(svc.next(txWith(null, []), 1)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
