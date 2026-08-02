import { ConflictException } from "@nestjs/common";
import { ProjectsWriteController } from "./projects-write.controller";
import type { CustomerRfqService } from "./customer-rfq.service";
import type { AuthUser } from "../auth/jwt.strategy";

/**
 * ODLUKA VLASNIKA 26.07.2026 — predmeti se otvaraju samo u BigBit-u.
 *
 * Dokazuje da su sve tri ranije write putanje nad predmetima zatvorene (uključujući
 * „Napravi predmet iz zahteva"), a da zahtevi za ponudu — koji su 4.0-native — rade.
 */
describe("ProjectsWriteController — upis u predmete je zatvoren", () => {
  const actor = { userId: 7 } as AuthUser;

  function setup() {
    const rfqs = {
      list: jest.fn().mockResolvedValue({ data: [], meta: { total: 0 } }),
      get: jest.fn().mockResolvedValue({ id: 1 }),
      create: jest.fn().mockResolvedValue({ id: 1 }),
      update: jest.fn().mockResolvedValue({ id: 1 }),
    } as unknown as CustomerRfqService;
    return { rfqs, controller: new ProjectsWriteController(rfqs) };
  }

  const closed: Array<[string, (c: ProjectsWriteController) => unknown]> = [
    ["POST /projects", (c) => c.createProject()],
    ["PATCH /projects/:id", (c) => c.updateProject()],
    ["POST /rfqs/:id/create-project", (c) => c.createProjectFromRfq()],
  ];

  it.each(closed)("%s odbija zahtev sa uputstvom za BigBit", (_name, call) => {
    const { controller } = setup();
    let body: Record<string, unknown> | null = null;
    try {
      call(controller);
    } catch (e) {
      expect(e).toBeInstanceOf(ConflictException);
      body = (e as ConflictException).getResponse() as Record<string, unknown>;
    }
    expect(body).not.toBeNull();
    expect(body!.code).toBe("BIGBIT_OWNED_READ_ONLY");
    expect(String(body!.message)).toMatch(/Otvorite predmet u BigBit-u/);
  });

  it("zahtevi za ponudu (RFQ) i dalje rade", async () => {
    const { controller, rfqs } = setup();
    const mocks = rfqs as unknown as Record<string, jest.Mock>;

    await controller.listRfqs("OPEN");
    await controller.getRfq(1);
    await controller.createRfq({ customerId: 5 }, { user: actor });
    await controller.updateRfq(1, { status: "QUOTED" }, { user: actor });

    expect(mocks.list).toHaveBeenCalled();
    expect(mocks.get).toHaveBeenCalledWith(1);
    expect(mocks.create).toHaveBeenCalledWith({ customerId: 5 }, actor);
    expect(mocks.update).toHaveBeenCalledWith(1, { status: "QUOTED" }, actor);
  });
});
