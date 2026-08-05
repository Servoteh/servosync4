import { BadRequestException } from "@nestjs/common";
import type { Response } from "express";
import type { MailService } from "../../common/mail/mail.service";
import type { CollectionDashboardService } from "./collection-dashboard.service";
import type { CompensationPdfService } from "./compensation-pdf.service";
import type { CompensationService } from "./compensation.service";
import type { DunningPdfService } from "./dunning-pdf.service";
import type { DunningService } from "./dunning.service";
import type { FxRevaluationService } from "./fx-revaluation.service";
import type { IosPdfService } from "./ios-pdf.service";
import type { OpenItemsService } from "./open-items.service";
import type { PartnerCardService } from "./partner-card.service";
import type { ReconciliationService } from "./reconciliation.service";
import { SaldakontiController } from "./saldakonti.controller";

/**
 * NEVALIDAN DATUM = 400, NIKAD TIHO „DANAS" (D2, 04.08.2026).
 * ============================================================================
 * ŠTA SE DEŠAVALO PRE POPRAVKE: lokalni `parseOptionalDate` je na nevalidan unos
 * vraćao `undefined` — isto kao na prazan — pa je pozivalac padao na podrazumevano
 * „danas" BEZ IJEDNE PORUKE. `?asOf=31.12.2025` (domaći zapis datuma) tako je davao
 * IOS obrazac sa saldom na današnji dan, a taj obrazac se POTPISUJE i vraća overen.
 * Sada ide `parseDateParam` iz `src/common/date-params.ts`: prazno = danas (namerno,
 * to je podrazumevani presek), nevalidno = 400 sa imenom parametra.
 */

function makeController() {
  const openItems = {
    listOpenItems: jest.fn().mockResolvedValue([]),
    agingByPartner: jest.fn().mockResolvedValue([]),
  };
  const iosPdf = {
    buildIosPdf: jest
      .fn()
      .mockResolvedValue({ buffer: Buffer.from("%PDF"), fileName: "IOS.pdf" }),
  };
  const partnerCard = {
    getPartnerCard: jest.fn().mockResolvedValue({}),
    buildPartnerCardPdf: jest
      .fn()
      .mockResolvedValue({ buffer: Buffer.from("%PDF"), fileName: "K.pdf" }),
  };
  const collectionDashboard = { build: jest.fn().mockResolvedValue({}) };
  const dunning = {
    candidates: jest.fn().mockResolvedValue([]),
    sendBatch: jest.fn().mockResolvedValue({ sent: 0, skipped: 0, failed: 0 }),
  };
  const dunningPdf = {
    buildDunningPdf: jest
      .fn()
      .mockResolvedValue({ buffer: Buffer.from("%PDF"), fileName: "O.pdf" }),
  };
  const mail = { send: jest.fn().mockResolvedValue(true) };

  const controller = new SaldakontiController(
    openItems as unknown as OpenItemsService,
    {} as unknown as ReconciliationService,
    {} as unknown as CompensationService,
    {} as unknown as CompensationPdfService,
    dunningPdf as unknown as DunningPdfService,
    iosPdf as unknown as IosPdfService,
    partnerCard as unknown as PartnerCardService,
    mail as unknown as MailService,
    collectionDashboard as unknown as CollectionDashboardService,
    dunning as unknown as DunningService,
    {} as unknown as FxRevaluationService,
  );

  return {
    controller,
    openItems,
    iosPdf,
    partnerCard,
    collectionDashboard,
    dunning,
    dunningPdf,
    mail,
  };
}

const RES = {
  setHeader: jest.fn(),
  send: jest.fn(),
} as unknown as Response;

describe("SaldakontiController — nevalidan datum daje 400", () => {
  it("GET open-items ?asOf=blabla → 400, a ne stanje na današnji dan", async () => {
    const { controller, openItems } = makeController();

    await expect(controller.listOpenItems({ asOf: "blabla" })).rejects.toThrow(
      BadRequestException,
    );
    await expect(controller.listOpenItems({ asOf: "blabla" })).rejects.toThrow(
      /asOf/,
    );
    // Ključno: upit se NIJE ni izvršio sa podrazumevanim „danas".
    expect(openItems.listOpenItems).not.toHaveBeenCalled();
  });

  it("IOS obrazac (potpisuje se) ne prihvata domaći zapis datuma", async () => {
    const { controller, iosPdf } = makeController();

    await expect(
      controller.iosPdfObrazac("5", "31.12.2025", RES),
    ).rejects.toThrow(BadRequestException);
    expect(iosPdf.buildIosPdf).not.toHaveBeenCalled();
  });

  it("prazan asOf i dalje znači danas (podrazumevani presek ostaje)", async () => {
    const { controller, openItems } = makeController();

    await controller.listOpenItems({});
    await controller.listOpenItems({ asOf: "" });

    expect(openItems.listOpenItems).toHaveBeenCalledTimes(2);
    for (const call of openItems.listOpenItems.mock.calls) {
      expect(call[2]).toBeUndefined();
    }
  });

  it("ispravan ISO datum prolazi nepromenjen", async () => {
    const { controller, openItems } = makeController();

    await controller.listOpenItems({ asOf: "2026-06-30" });

    expect(openItems.listOpenItems.mock.calls[0][2]).toEqual(
      new Date("2026-06-30"),
    );
  });

  it("greška imenuje TAČAN parametar (from/to na kartici komitenta)", async () => {
    const { controller, partnerCard } = makeController();

    await expect(
      controller.partnerCardData("5", undefined, "blabla", "2026-06-30"),
    ).rejects.toThrow(/'from'/);
    await expect(
      controller.partnerCardData("5", undefined, "2026-01-01", "blabla"),
    ).rejects.toThrow(/'to'/);
    expect(partnerCard.getPartnerCard).not.toHaveBeenCalled();
  });

  it("sve ostale rute sa datumom takođe padaju na 400 (nijedna ne ćuti)", async () => {
    const {
      controller,
      openItems,
      collectionDashboard,
      dunning,
      dunningPdf,
      mail,
    } = makeController();

    await expect(controller.aging({ asOf: "blabla" })).rejects.toThrow(
      BadRequestException,
    );
    await expect(
      controller.sendIosPdfMail({
        partnerId: 5,
        to: "kupac@example.com",
        asOf: "blabla",
      }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      controller.partnerCardPdf("5", undefined, "blabla", undefined, RES),
    ).rejects.toThrow(BadRequestException);
    await expect(controller.collectionDashboardData("blabla")).rejects.toThrow(
      BadRequestException,
    );
    await expect(controller.dunningCandidates("blabla")).rejects.toThrow(
      BadRequestException,
    );
    await expect(
      controller.dunningPdfObrazac("5", "1", "blabla", RES),
    ).rejects.toThrow(BadRequestException);
    await expect(
      controller.dunningSendBatch(
        { asOf: "blabla" },
        { user: { userId: 1 } as never },
      ),
    ).rejects.toThrow(BadRequestException);

    expect(openItems.agingByPartner).not.toHaveBeenCalled();
    expect(collectionDashboard.build).not.toHaveBeenCalled();
    expect(dunning.candidates).not.toHaveBeenCalled();
    expect(dunning.sendBatch).not.toHaveBeenCalled();
    expect(dunningPdf.buildDunningPdf).not.toHaveBeenCalled();
    expect(mail.send).not.toHaveBeenCalled();
  });
});
