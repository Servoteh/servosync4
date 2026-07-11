import { Test, TestingModule } from "@nestjs/testing";
import { PrismaService } from "../../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { DraftNumberingService } from "./draft-numbering.service";
import { HandoverDraftsService } from "./handover-drafts.service";

/**
 * D8 emit 2 — `submit()` šalje „Kreirana nova primopredaja…" grupi TEHNOLOG.
 * Testira se emit helper (`notifySubmitted`) direktno: sam submit() tok
 * (advisory lock, kreiranje drawing_handovers…) je integraciona priča.
 */

/** Privatni emit helper — tipizirani pogled bez `any` (obrazac `as unknown as`). */
interface EmitView {
  notifySubmitted(
    draft: {
      id: number;
      draftNumber: string;
      designerId: number;
      designer: { fullName: string | null; username: string } | null;
    },
    itemCount: number,
  ): Promise<void>;
}

function notificationsMock() {
  return {
    notifyWorkers: jest.fn().mockResolvedValue(0),
    resolveTechnologistWorkerIds: jest.fn().mockResolvedValue([]),
  };
}

const DRAFT = {
  id: 15,
  draftNumber: "D-2026-15",
  designerId: 33,
  designer: { fullName: "Mika Projektant", username: "mika" },
};

describe("HandoverDraftsService — D8 emit notifikacija (submit)", () => {
  let emit: EmitView;
  let notifications: ReturnType<typeof notificationsMock>;

  beforeEach(async () => {
    notifications = notificationsMock();
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        HandoverDraftsService,
        { provide: PrismaService, useValue: {} },
        { provide: DraftNumberingService, useValue: {} },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();
    emit = mod.get(HandoverDraftsService);
  });

  it("šalje grupi TEHNOLOG: type primopredaja.nova + srpska poruka + ref na handover_drafts", async () => {
    notifications.resolveTechnologistWorkerIds.mockResolvedValue([7, 9]);

    await emit.notifySubmitted(DRAFT, 4);

    expect(notifications.notifyWorkers).toHaveBeenCalledWith([7, 9], {
      type: "primopredaja.nova",
      message:
        "Kreirana nova primopredaja D-2026-15 — 4 stavki (projektant Mika Projektant)",
      refTable: "handover_drafts",
      refId: 15,
    });
  });

  it("projektant bez fullName → username; bez reda radnika → #designerId", async () => {
    await emit.notifySubmitted(
      { ...DRAFT, designer: { fullName: null, username: "mika" } },
      1,
    );
    await emit.notifySubmitted({ ...DRAFT, designer: null }, 1);

    const calls = notifications.notifyWorkers.mock.calls as unknown as [
      number[],
      { message: string },
    ][];
    const messages = calls.map(([, payload]) => payload.message);
    expect(messages[0]).toContain("(projektant mika)");
    expect(messages[1]).toContain("(projektant #33)");
  });

  it("pad notifikacije se guta (best-effort) — predaja nacrta je već uspela", async () => {
    notifications.resolveTechnologistWorkerIds.mockRejectedValue(
      new Error("db down"),
    );

    await expect(emit.notifySubmitted(DRAFT, 2)).resolves.toBeUndefined();
    expect(notifications.notifyWorkers).not.toHaveBeenCalled();
  });
});
