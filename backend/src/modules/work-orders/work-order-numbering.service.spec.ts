import { NotFoundException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import {
  SANITY_MAX_ORDINAL,
  WorkOrderNumberingService,
} from "./work-order-numbering.service";

/**
 * Bug 030/26 (dva talasa — 21.01/23.07. i 03.08.2026): legacy typo ident bez
 * kose crte ('770171831') je preko split('/').pop() hranio brojač sa stotinama
 * miliona, a jednom nastali kaskadni redovi (7701/770171832…844) su i sami
 * postajali otrov. Parser broji SAMO ident sa `<projectNumber>/` prefiksom +
 * sanity prag na ordinal (izmereno 03.08.2026: najveći legitiman ordinal
 * igde = 2.273, opseg 10.000–99.999 prazan — vidi SANITY_MAX_ORDINAL).
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

  it("apsurdan ordinal sa ispravnim prefiksom se ignoriše (kaskada 7701/770171832…844)", async () => {
    const r = await svc.next(
      txWith("7701", ["7701/2273", "7701/770171832", "7701/770171844"]),
      9068,
    );
    expect(r.identNumber).toBe("7701/2274");
  });

  it("prag je uključiv: ordinal tačno na SANITY_MAX_ORDINAL se ignoriše", async () => {
    const r = await svc.next(
      txWith("7701", ["7701/12", `7701/${SANITY_MAX_ORDINAL}`]),
      9068,
    );
    expect(r.identNumber).toBe("7701/13");
  });

  it("SVI redovi otrovni: kreće od 1 (bolje /1 nego nastavak kaskade; uq trojka hvata eventualnu koliziju)", async () => {
    // Realan scenario 03.08: predmet u kom postoje samo typo red i kaskada.
    // /1 je namerno — nastavak kaskade (…845) bi svaki novi RN činio otrovom,
    // a kolizija sa postojećim identom nije tiha: obara je uq
    // (projectId, identNumber, variant) pa transakcija pukne.
    const r = await svc.next(
      txWith("7701", ["770171831", "7701/770171832", "7701/770171844"]),
      9068,
    );
    expect(r.identNumber).toBe("7701/1");
  });

  it("predmet sa kosom crtom u broju ('9400/7'): prefiks je ceo broj predmeta", async () => {
    const r = await svc.next(
      txWith("9400/7", ["9400/7/39", "9400/7/72"]),
      9400,
    );
    expect(r.identNumber).toBe("9400/7/73");
  });

  it("neparsiv rep ('7918/', '6118/X') se ignoriše, rework sufiks ('191-27') broji vodeće cifre", async () => {
    const r = await svc.next(
      txWith("7701", ["7701/", "7701/X", "7701/191-27", "7701/190"]),
      9068,
    );
    // parseInt('191-27') = 191 → max(190, 191) = 191.
    expect(r.identNumber).toBe("7701/192");
  });

  it("nepostojeći predmet: NotFoundException", async () => {
    await expect(svc.next(txWith(null, []), 1)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
