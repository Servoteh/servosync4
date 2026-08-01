import { ConflictException, NotFoundException } from "@nestjs/common";
import { CustomerRfqService } from "./customer-rfq.service";
import type { PrismaService } from "../../prisma/prisma.service";
import type { AuthUser } from "../auth/jwt.strategy";

/**
 * Zamena za ugašeni tok „Napravi predmet iz zahteva" (odluka 26.07.2026):
 * zahtev se vezuje za POSTOJEĆI predmet uvezen iz BigBit-a. Servis predmet samo ČITA.
 */
describe("CustomerRfqService — vezivanje predmeta bez kreiranja", () => {
  const actor = { userId: 3 } as AuthUser;

  /** Prvi argument `prisma.customerRfq.update` poziva, tipiziran (izbegava `any` u assert-ima). */
  function updateArgs(mock: jest.Mock): {
    where: { id: number };
    data: { projectId?: number | null };
  } {
    const calls = mock.mock.calls as unknown[][];
    return calls[0][0] as {
      where: { id: number };
      data: { projectId?: number | null };
    };
  }

  function setup(opts: {
    project?: { id: number } | null;
    takenByRfqId?: number | null;
  }) {
    const projectCreate = jest.fn();
    const rfqUpdate = jest.fn().mockResolvedValue({ id: 1 });
    const prisma = {
      customerRfq: {
        findUnique: jest.fn().mockResolvedValue({ id: 1, customerId: 5 }),
        findFirst: jest
          .fn()
          .mockResolvedValue(
            opts.takenByRfqId ? { id: opts.takenByRfqId } : null,
          ),
        update: rfqUpdate,
        create: jest.fn(),
        count: jest.fn(),
        findMany: jest.fn(),
      },
      project: {
        findUnique: jest.fn().mockResolvedValue(opts.project ?? null),
        create: projectCreate,
        update: jest.fn(),
      },
      customer: {
        findUnique: jest.fn().mockResolvedValue({ id: 5 }),
        create: jest.fn(),
        update: jest.fn(),
      },
      $transaction: jest.fn(),
    } as unknown as PrismaService;

    return {
      prisma,
      projectCreate,
      rfqUpdate,
      service: new CustomerRfqService(prisma),
    };
  }

  it("veže postojeći predmet i NIKAD ga ne kreira", async () => {
    const { service, projectCreate, rfqUpdate, prisma } = setup({
      project: { id: 42 },
    });

    await service.update(1, { projectId: 42 }, actor);

    expect(projectCreate).not.toHaveBeenCalled();
    expect(
      (prisma as unknown as { project: { update: jest.Mock } }).project.update,
    ).not.toHaveBeenCalled();
    const call = updateArgs(rfqUpdate);
    expect(call.where).toEqual({ id: 1 });
    expect(call.data.projectId).toBe(42);
  });

  it("nepostojeći predmet → 404 sa uputstvom da se otvori u BigBit-u", async () => {
    const { service, projectCreate } = setup({ project: null });

    await expect(service.update(1, { projectId: 99 }, actor)).rejects.toThrow(
      NotFoundException,
    );
    await expect(service.update(1, { projectId: 99 }, actor)).rejects.toThrow(
      /Otvorite ga u BigBit-u/,
    );
    expect(projectCreate).not.toHaveBeenCalled();
  });

  it("predmet već vezan za drugi zahtev → 409 (uq_customer_rfqs_project je 1:1)", async () => {
    const { service } = setup({ project: { id: 42 }, takenByRfqId: 8 });

    await expect(service.update(1, { projectId: 42 }, actor)).rejects.toThrow(
      ConflictException,
    );
  });

  it("odvezivanje (projectId: null) ne traži postojanje predmeta", async () => {
    const { service, prisma, rfqUpdate } = setup({ project: null });

    await service.update(1, { projectId: null }, actor);

    expect(
      (prisma as unknown as { project: { findUnique: jest.Mock } }).project
        .findUnique,
    ).not.toHaveBeenCalled();
    expect(updateArgs(rfqUpdate).data.projectId).toBeNull();
  });

  it("kreiranje zahteva ne kreira komitenta (samo ga proverava)", async () => {
    const { service, prisma } = setup({ project: null });
    const customer = (
      prisma as unknown as {
        customer: { create: jest.Mock; findUnique: jest.Mock };
      }
    ).customer;

    await service.create({ customerId: 5 }, actor);

    expect(customer.findUnique).toHaveBeenCalled();
    expect(customer.create).not.toHaveBeenCalled();
  });
});
