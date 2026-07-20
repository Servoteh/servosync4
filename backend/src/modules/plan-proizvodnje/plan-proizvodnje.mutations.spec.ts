import { ForbiddenException, UnprocessableEntityException } from "@nestjs/common";
import { PlanProizvodnjeService } from "./plan-proizvodnje.service";
import type { PrismaService } from "../../prisma/prisma.service";

/**
 * Native mutacije (F5b) — reassign port sy15 RPC-a (force gate + idempotencija),
 * overlay merge-upsert, pin-to-top, urgency. Mock PrismaService: `$transaction(fn)`
 * poziva fn(tx); tx nosi `$queryRaw`/`$executeRaw` + native modele. BE je KONAČNI gate.
 */
const UUID = "3b241101-e2bb-4255-8caf-4136c566a962";
const email = "pm@servoteh.com";

type QReturn = unknown[];

/**
 * @param queryReturns FIFO red odgovora za `tx.$queryRaw` (svaki poziv uzima sledeći).
 *   reassignOne redosled: [0] machine lookup, [1] target-exists (samo ako target!=null).
 */
function makeService(queryReturns: QReturn[] = []) {
  const captured: {
    overlay?: { where: unknown; create: Record<string, unknown>; update: Record<string, unknown> };
    urgency?: { where: unknown; create: Record<string, unknown>; update: Record<string, unknown> };
    exec?: { values: unknown[] };
    execs: { values: unknown[] }[];
  } = { execs: [] };
  let qi = 0;
  const tx = {
    $queryRaw: jest.fn(async () => queryReturns[qi++] ?? []),
    $executeRaw: jest.fn(async (sql: { values: unknown[] }) => {
      captured.exec = sql;
      captured.execs.push(sql);
      return 1;
    }),
    planProizvodnjeOverlay: {
      upsert: jest.fn(async (a: typeof captured.overlay) => {
        captured.overlay = a;
        return { id: 1, ...a!.create };
      }),
    },
    planProizvodnjeUrgency: {
      upsert: jest.fn(async (a: typeof captured.urgency) => {
        captured.urgency = a;
        return { workOrderId: 9400, isUrgent: false };
      }),
    },
  };
  const prisma = {
    $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
    planProizvodnjeUrgency: tx.planProizvodnjeUrgency,
  } as unknown as PrismaService;
  const svc = new PlanProizvodnjeService(prisma);
  return { svc, captured, tx };
}

const machine = (original: string, source = original) => [
  { original_machine: original, source_machine: source },
];
const targetExists = (ok = true) => [{ ok }];

describe("reassign (port sy15 reassign_production_line)", () => {
  it("ista grupa: forced=false, overlay assigned=target, BEZ audita", async () => {
    // 3.1 (glodanje) → 3.9 (glodanje): ista grupa.
    const { svc, captured } = makeService([machine("3.1"), targetExists(true)]);
    const res = (await svc.reassign(
      email,
      { workOrderId: "40681", lineId: "5", targetMachine: "3.9" },
      true,
    )) as { data: Record<string, unknown> };
    expect(res.data.forced).toBe(false);
    expect(res.data.source_group).toBe("glodanje");
    expect(res.data.target_group).toBe("glodanje");
    expect(captured.overlay?.create.assignedMachineCode).toBe("3.9");
    expect(captured.overlay?.where).toEqual({
      workOrderId_lineId: { workOrderId: 40681, lineId: 5 },
    });
    expect(captured.execs).toHaveLength(0); // nema audit insert-a
  });

  it("target == original → NULL overlay (vrati na original), ista grupa", async () => {
    const { svc, captured } = makeService([machine("3.1")]);
    const res = (await svc.reassign(
      email,
      { workOrderId: "1", lineId: "1", targetMachine: "3.1" },
      true,
    )) as { data: Record<string, unknown> };
    expect(res.data.assigned_machine_code).toBeNull();
    expect(captured.overlay?.create.assignedMachineCode).toBeNull();
    expect(captured.execs).toHaveLength(0);
  });

  it("group-mismatch bez force → 422 (machine_group_mismatch)", async () => {
    // 3.1 (glodanje) → 2.1 (struganje): mismatch.
    const { svc } = makeService([machine("3.1"), targetExists(true)]);
    await expect(
      svc.reassign(email, { workOrderId: "1", lineId: "1", targetMachine: "2.1" }, true),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it("group-mismatch + force ali BEZ prava (canForce=false) → 403", async () => {
    const { svc } = makeService([machine("3.1"), targetExists(true)]);
    await expect(
      svc.reassign(
        email,
        { workOrderId: "1", lineId: "1", targetMachine: "2.1", force: true, reason: "razlog" },
        false,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("group-mismatch + force + reason<3 → 422 (force_reason_required)", async () => {
    const { svc } = makeService([machine("3.1"), targetExists(true)]);
    await expect(
      svc.reassign(
        email,
        { workOrderId: "1", lineId: "1", targetMachine: "2.1", force: true, reason: "ab" },
        true,
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it("group-mismatch + force + reason≥3 + canForce → forced=true + audit ON CONFLICT (cev)", async () => {
    const { svc, captured } = makeService([machine("3.1"), targetExists(true)]);
    const res = (await svc.reassign(
      email,
      {
        workOrderId: "40681",
        lineId: "5",
        targetMachine: "2.1",
        force: true,
        reason: "prebacujem",
        clientEventId: UUID,
      },
      true,
    )) as { data: Record<string, unknown> };
    expect(res.data.forced).toBe(true);
    expect(res.data.source_group).toBe("glodanje");
    expect(res.data.target_group).toBe("struganje");
    expect(captured.execs).toHaveLength(1); // audit insert
    expect(captured.exec?.values).toContain(UUID); // idempotency ključ
    expect(captured.exec?.values).toContain("prebacujem");
  });

  it("nepostojeća ciljna mašina → 422 (target_machine_not_found)", async () => {
    const { svc } = makeService([machine("3.1"), targetExists(false)]);
    await expect(
      svc.reassign(email, { workOrderId: "1", lineId: "1", targetMachine: "9.9" }, true),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it("operacija ne postoji → 422 (operation_not_found)", async () => {
    const { svc } = makeService([[]]); // machine lookup vraća prazno
    await expect(
      svc.reassign(email, { workOrderId: "1", lineId: "1", targetMachine: "3.9" }, true),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });
});

describe("bulkReassign", () => {
  it("JEDAN deljen client_event_uuid za ceo bulk; updated_count", async () => {
    // 2 para, ista grupa (3.1→3.9), bez force → 2 machine-lookup + 2 target-exists.
    const { svc } = makeService([
      machine("3.1"),
      targetExists(true),
      machine("3.1"),
      targetExists(true),
    ]);
    const res = (await svc.bulkReassign(
      email,
      {
        pairs: [
          { workOrderId: "10", lineId: "2" },
          { workOrderId: "11", lineId: "3" },
        ],
        targetMachine: "3.9",
        clientEventId: UUID,
      },
      true,
    )) as { data: { updated_count: number } };
    expect(res.data.updated_count).toBe(2);
  });
});

describe("overlay merge + pin-to-top + urgency", () => {
  it("overlay merge: create stampuje created_by+updated_by; update SAMO updated_by", async () => {
    const { svc, captured } = makeService();
    await svc.upsertOverlay(email, {
      workOrderId: "5",
      lineId: "7",
      localStatus: "blocked",
      camReady: true,
    });
    const a = captured.overlay!;
    expect(a.where).toEqual({ workOrderId_lineId: { workOrderId: 5, lineId: 7 } });
    expect(a.create.localStatus).toBe("blocked");
    expect(a.create.camReady).toBe(true);
    expect(a.create.camReadyBy).toBe(email);
    expect(a.create.camReadyAt).toBeInstanceOf(Date);
    expect(a.create.createdBy).toBe(email);
    expect(a.create.updatedBy).toBe(email);
    expect(a.update).not.toHaveProperty("createdBy"); // merge ne prepisuje autora
    expect(a.update.updatedBy).toBe(email);
    expect(a.update.camReadyBy).toBe(email);
  });

  it("pin-to-top: shiftSortOrder=-1 → MIN(ručnih)−1 (null → fallback 1)", async () => {
    // resolvePinOrder $queryRaw vraća min_order=null → 1.
    const s1 = makeService([[{ min_order: null }]]);
    await s1.svc.upsertOverlay(email, { workOrderId: "40681", lineId: "5", shiftSortOrder: -1 });
    expect(s1.captured.overlay!.create.shiftSortOrder).toBe(1);

    // min_order=-1 → novi pin = -2 (iznad prethodnog).
    const s2 = makeService([[{ min_order: -1 }]]);
    await s2.svc.upsertOverlay(email, { workOrderId: "40682", lineId: "9", shiftSortOrder: -1 });
    expect(s2.captured.overlay!.create.shiftSortOrder).toBe(-2);
  });

  it("pin: shiftSortOrder != -1 (drag / null unpin) prolazi DOSLOVNO", async () => {
    const s = makeService();
    await s.svc.upsertOverlay(email, { workOrderId: "1", lineId: "1", shiftSortOrder: 7 });
    expect(s.captured.overlay!.create.shiftSortOrder).toBe(7);
    const s2 = makeService();
    await s2.svc.upsertOverlay(email, { workOrderId: "1", lineId: "1", shiftSortOrder: null });
    expect(s2.captured.overlay!.create.shiftSortOrder).toBeNull();
  });

  it("clearUrgent: flag off + cleared_* (NIKAD ne briše red)", async () => {
    const { svc, captured } = makeService();
    await svc.clearUrgent(email, "9400");
    const u = captured.urgency!;
    expect(u.where).toEqual({ workOrderId: 9400 });
    expect(u.update.isUrgent).toBe(false);
    expect(u.update.clearedBy).toBe(email);
    expect(u.update.clearedAt).toBeInstanceOf(Date);
  });

  it("setUrgent: flag on + reason, reset cleared_*", async () => {
    const { svc, captured } = makeService();
    await svc.setUrgent(email, "9400", { reason: "  hitno  " });
    const u = captured.urgency!;
    expect(u.create.isUrgent).toBe(true);
    expect(u.create.reason).toBe("hitno"); // trimovano
    expect(u.update.clearedAt).toBeNull();
  });
});
