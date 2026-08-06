import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { PlanProizvodnjeService } from "./plan-proizvodnje.service";
import type { IdempotencyService } from "../../common/idempotency/idempotency.service";
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
 * Lažni registar idempotencije (075/26): prosto izvrši akciju u datom `tx`. Pravi
 * registar (`api_idempotency`) ima svoj test (`idempotency.service.spec.ts`); ovde se
 * meri SAMO da li ga servis zove i sa kojim ključem/akcijom.
 */
function makeIdem(tx: unknown) {
  return {
    run: jest.fn(
      async (
        _e: string,
        _k: string,
        _a: string,
        fn: (t: unknown) => Promise<unknown>,
      ) => ({ idempotent: false, result: await fn(tx) }),
    ),
  };
}

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
    /** Tekst SVAKOG izvršenog `$queryRaw` iskaza, redom (075/26 kanon brave). */
    queries: string[];
  } = { execs: [], queries: [] };
  let qi = 0;
  const tx = {
    $queryRaw: jest.fn(async (sql: unknown) => {
      captured.queries.push(sqlText(sql));
      return queryReturns[qi++] ?? [];
    }),
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
    $queryRaw: tx.$queryRaw,
    planProizvodnjeUrgency: tx.planProizvodnjeUrgency,
  } as unknown as PrismaService;
  const idem = makeIdem(tx);
  const svc = new PlanProizvodnjeService(
    prisma,
    idem as unknown as IdempotencyService,
  );
  return { svc, captured, tx, idem };
}

/** Tekst `Prisma.Sql` iskaza (za provere kanona brave / TZ izraza nad `captured`). */
function sqlText(sql: unknown): string {
  const s = sql as { sql?: string; text?: string } | null;
  return String(s?.sql ?? s?.text ?? sql ?? "");
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

/**
 * Gant (zahtev 046/26 F0+F1) — termini/uslov/završenost na overlay-u + šifrarnik hala.
 * Ključna invarijanta: gant NE dira `shiftSortOrder` (ručni redosled ostaje master).
 */
describe("gant: termini, uslov i završenost (046/26)", () => {
  it("upisuje planirane termine i override trajanja, BEZ diranja shiftSortOrder", async () => {
    const { svc, captured } = makeService();
    await svc.upsertOverlay(email, {
      workOrderId: "9400",
      lineId: "12",
      plannedStartAt: "2026-08-03T05:00:00.000Z",
      plannedEndAt: "2026-08-05T05:00:00.000Z",
      plannedDurationMinutes: 480,
    });
    const c = captured.overlay!.create;
    expect(c.plannedStartAt).toBeInstanceOf(Date);
    expect(c.plannedEndAt).toBeInstanceOf(Date);
    expect(c.plannedDurationMinutes).toBe(480);
    expect(c.shiftSortOrder).toBeUndefined();
  });

  it("null skida stavku sa ose (planned_start_at → NULL)", async () => {
    const { svc, captured } = makeService();
    await svc.upsertOverlay(email, {
      workOrderId: "9400",
      lineId: "12",
      plannedStartAt: null,
      plannedEndAt: null,
    });
    expect(captured.overlay!.update.plannedStartAt).toBeNull();
    expect(captured.overlay!.update.plannedEndAt).toBeNull();
  });

  it("kraj pre početka → 422 (plan se ne upisuje naopako)", async () => {
    const { svc } = makeService();
    await expect(
      svc.upsertOverlay(email, {
        workOrderId: "9400",
        lineId: "12",
        plannedStartAt: "2026-08-10T05:00:00.000Z",
        plannedEndAt: "2026-08-03T05:00:00.000Z",
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it("uslov na samog sebe → 422", async () => {
    const { svc } = makeService();
    await expect(
      svc.upsertOverlay(email, {
        workOrderId: "9400",
        lineId: "12",
        predecessorWorkOrderId: "9400",
        predecessorLine: "12",
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it("brisanje uslova nosi i liniju prethodnika", async () => {
    const { svc, captured } = makeService();
    await svc.upsertOverlay(email, {
      workOrderId: "9400",
      lineId: "12",
      predecessorWorkOrderId: null,
    });
    expect(captured.overlay!.update.predecessorWorkOrderId).toBeNull();
    expect(captured.overlay!.update.predecessorLine).toBeNull();
  });

  it("plannedDone: true stampuje audit, null vraća na automatski", async () => {
    const on = makeService();
    await on.svc.upsertOverlay(email, { workOrderId: "1", lineId: "1", plannedDone: true });
    expect(on.captured.overlay!.create.plannedDone).toBe(true);
    expect(on.captured.overlay!.create.plannedDoneBy).toBe(email);

    const off = makeService();
    await off.svc.upsertOverlay(email, { workOrderId: "1", lineId: "1", plannedDone: null });
    expect(off.captured.overlay!.update.plannedDone).toBeNull();
    expect(off.captured.overlay!.update.plannedDoneAt).toBeNull();
    expect(off.captured.overlay!.update.plannedDoneBy).toBeNull();
  });

  it("neispravan timestamp → 422 (a ne Invalid Date u bazi)", async () => {
    const { svc } = makeService();
    await expect(
      svc.upsertOverlay(email, { workOrderId: "1", lineId: "1", plannedStartAt: "juce" }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  // Paket B: termini su na MINUT (datetime-local u dijalogu) — BE ne sme da ih
  // zaokružuje/kanonizuje na dan; timestamptz prima tačno poslato vreme.
  it("termini čuvaju minutnu preciznost (nema dan-kanonizacije na BE)", async () => {
    const { svc, captured } = makeService();
    await svc.upsertOverlay(email, {
      workOrderId: "9400",
      lineId: "12",
      plannedStartAt: "2026-08-03T06:30:00.000Z",
      plannedEndAt: "2026-08-04T06:30:00.000Z",
    });
    const c = captured.overlay!.create;
    expect((c.plannedStartAt as Date).toISOString()).toBe("2026-08-03T06:30:00.000Z");
    expect((c.plannedEndAt as Date).toISOString()).toBe("2026-08-04T06:30:00.000Z");
  });

  /**
   * Paket B (Strahinjin komentar): ručni override spremnosti iz gant dijaloga ide kroz
   * POSTOJEĆI `ready_override` mehanizam („SPREMNO (override)" sa taba „Po mašini") —
   * server pečatira ko/kada; skidanje briše pečat i vraća izračunatu spremnost
   * (`is_ready_for_machine = override OR is_ready_rb` u read sloju).
   */
  it("readyOverride: true pečatira at/by; false ih briše (vraća izračunato)", async () => {
    const on = makeService();
    await on.svc.upsertOverlay(email, { workOrderId: "9400", lineId: "12", readyOverride: true });
    expect(on.captured.overlay!.create.readyOverride).toBe(true);
    expect(on.captured.overlay!.create.readyOverrideBy).toBe(email);
    expect(on.captured.overlay!.create.readyOverrideAt).toBeInstanceOf(Date);

    const off = makeService();
    await off.svc.upsertOverlay(email, { workOrderId: "9400", lineId: "12", readyOverride: false });
    expect(off.captured.overlay!.update.readyOverride).toBe(false);
    expect(off.captured.overlay!.update.readyOverrideAt).toBeNull();
    expect(off.captured.overlay!.update.readyOverrideBy).toBeNull();
  });
});

/**
 * Validacija nad SPOJENIM stanjem (postojeći red ⊕ patch) — API je merge-patch, pa FE
 * resize bara i Shift+←/→ nose SAMO `plannedEndAt`, a uslov ume da stigne u dva poziva.
 * Provera nad samim patch-om je propuštala oba slučaja (review 046/26).
 */
describe("gant: parcijalni patch se validira nad spojenim stanjem (046/26)", () => {
  /** Zatečen red kakav vraća `SELECT ... FOR UPDATE` u `assertPlanConsistent`. */
  const existing = (o: Record<string, unknown>) => [
    {
      planned_start_at: null,
      planned_end_at: null,
      predecessor_work_order_id: null,
      predecessor_line: null,
      ...o,
    },
  ];

  it("samo kraj, a u bazi KASNIJI početak → 422 (nema invertovanog intervala)", async () => {
    const { svc, captured } = makeService([
      existing({ planned_start_at: new Date("2026-08-10T05:00:00.000Z") }),
    ]);
    await expect(
      svc.upsertOverlay(email, {
        workOrderId: "9400",
        lineId: "12",
        plannedEndAt: "2026-08-05T05:00:00.000Z",
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(captured.overlay).toBeUndefined();
  });

  it("samo kraj POSLE postojećeg početka prolazi (resize bara ostaje moguć)", async () => {
    const { svc, captured } = makeService([
      existing({ planned_start_at: new Date("2026-08-10T05:00:00.000Z") }),
    ]);
    await svc.upsertOverlay(email, {
      workOrderId: "9400",
      lineId: "12",
      plannedEndAt: "2026-08-12T05:00:00.000Z",
      plannedDurationMinutes: 2880,
    });
    expect(captured.overlay!.update.plannedEndAt).toBeInstanceOf(Date);
    expect(captured.overlay!.update.plannedStartAt).toBeUndefined();
  });

  it("samo početak POSLE postojećeg kraja → 422", async () => {
    const { svc } = makeService([
      existing({ planned_end_at: new Date("2026-08-05T05:00:00.000Z") }),
    ]);
    await expect(
      svc.upsertOverlay(email, {
        workOrderId: "9400",
        lineId: "12",
        plannedStartAt: "2026-08-10T05:00:00.000Z",
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it("linija uslova bez RN-a (u bazi NULL) → 422 predecessor_pair_incomplete", async () => {
    const { svc, captured } = makeService([existing({})]);
    await expect(
      svc.upsertOverlay(email, { workOrderId: "9400", lineId: "12", predecessorLine: "77" }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(captured.overlay).toBeUndefined();
  });

  it("promena SAMO linije uz postojeći RN prolazi (par ostaje kompletan)", async () => {
    const { svc, captured } = makeService([existing({ predecessor_work_order_id: 99 })]);
    await svc.upsertOverlay(email, { workOrderId: "9400", lineId: "12", predecessorLine: "77" });
    expect(captured.overlay!.update.predecessorLine).toBe(77);
  });

  it("samo-referenca sklopljena iz DVA poziva → 422 (ciklus dužine 1)", async () => {
    // U bazi već stoji uslov (tuđi RN, SOPSTVENA linija); drugi poziv menja samo RN u svoj.
    const { svc, captured } = makeService([
      existing({ predecessor_work_order_id: 99, predecessor_line: 12 }),
    ]);
    await expect(
      svc.upsertOverlay(email, {
        workOrderId: "9400",
        lineId: "12",
        predecessorWorkOrderId: "9400",
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(captured.overlay).toBeUndefined();
  });

  it("patch koji ne dira termine/uslov NE čita red (nema suvišnog SELECT-a)", async () => {
    const { svc, tx } = makeService();
    await svc.upsertOverlay(email, { workOrderId: "9400", lineId: "12", shiftNote: "hitno" });
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
});

describe("šifrarnik hala (046/26 F0)", () => {
  /** Hall CRUD ide van transakcije → mock na `prisma` nivou, ne na `tx`. */
  function makeHallService(machineExists: boolean) {
    const captured: { upsert?: { where: unknown; create: Record<string, unknown>; update: Record<string, unknown> }; deleted?: unknown } = {};
    const prisma = {
      $queryRaw: jest.fn(async () => [{ ok: machineExists }]),
      planProizvodnjeMachineHall: {
        upsert: jest.fn(async (a: typeof captured.upsert) => {
          captured.upsert = a;
          return { machineCode: "G01", hall: "Hala 1" };
        }),
        deleteMany: jest.fn(async (a: unknown) => {
          captured.deleted = a;
          return { count: 1 };
        }),
      },
    } as unknown as PrismaService;
    const idem = makeIdem(prisma);
    return {
      svc: new PlanProizvodnjeService(
        prisma,
        idem as unknown as IdempotencyService,
      ),
      captured,
    };
  }

  it("dodela hale postojećoj mašini (upsert po machine_code)", async () => {
    const { svc, captured } = makeHallService(true);
    await svc.upsertMachineHall(email, " G01 ", { hall: " Hala 1 " });
    expect(captured.upsert!.where).toEqual({ machineCode: "G01" });
    expect(captured.upsert!.create.hall).toBe("Hala 1");
    expect(captured.upsert!.update.updatedBy).toBe(email);
  });

  it("nepoznata mašina → 422 machine_not_found", async () => {
    const { svc } = makeHallService(false);
    await expect(svc.upsertMachineHall(email, "XXX", { hall: "Hala 1" })).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });

  it("prazna hala → 422 (uklanjanje ide kroz DELETE)", async () => {
    const { svc } = makeHallService(true);
    await expect(svc.upsertMachineHall(email, "G01", { hall: "   " })).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });

  it("skidanje dodele je idempotentno (deleteMany)", async () => {
    const { svc, captured } = makeHallService(true);
    await svc.deleteMachineHall(email, "G01");
    expect(captured.deleted).toEqual({ where: { machineCode: "G01" } });
  });
});

/**
 * ZAHTEV 075/26 (F2 iz 046/26) — kaskadno pomeranje vezanih pozicija na gantu.
 *
 * Pokriveno je tačno ono što ovakvu funkciju obara u praksi:
 *  • razlika HODA i PRESKOKA (rekurzija prolazi kroz svaki čvor, upis preskače) —
 *    testovi „bez termina" / „završen sledbenik" su najvažniji u fajlu;
 *  • sidro se pomera UVEK, i kad je završeno (koren izmerenog lanca 3.40 JESTE završen);
 *  • ciklus se prijavljuje kao 422 sa putanjom, nikad se ne vrti;
 *  • KANON BRAVE (`ORDER BY work_order_id, line_id … FOR UPDATE` u ZASEBNOM iskazu) —
 *    `FOR UPDATE` nad rekurzivnim CTE-om tiho ne zaključava ništa;
 *  • JSON-stabilnost odgovora (registar idempotencije vraća ISO stringove na retry).
 */
describe("gant kaskada — 075/26", () => {
  /** Pravi UPDATE lanca — `FOR UPDATE` iz iskaza brave NIJE upis (lako se pobrka). */
  const jeUpdate = (q: string) => q.includes("UPDATE plan_proizvodnje_overlays o");

  const START = new Date("2026-08-10T06:00:00.000Z");
  const END = new Date("2026-08-10T14:00:00.000Z");
  const NOV_START = new Date("2026-08-15T06:00:00.000Z");
  const NOV_END = new Date("2026-08-15T14:00:00.000Z");

  /** Jedan red kakav vraća `collectChain` SQL. */
  const cvor = (wo: string, line: string, o: Record<string, unknown> = {}) => ({
    work_order_id: wo,
    line_id: line,
    dubina: 0,
    ciklus: false,
    putanja_txt: [wo + ":" + line],
    planned_start_at: START,
    planned_end_at: END,
    novi_start: NOV_START,
    novi_end: NOV_END,
    orfan: false,
    arhivirano: false,
    rn_ident_broj: "RN-" + wo,
    operacija: 10,
    broj_crteza: "C-1",
    effective_machine_code: "3.40",
    zavrseno: false,
    ...o,
  });

  /** RETURNING red UPDATE-a (novo stanje). */
  const vracen = (wo: string, line: string) => ({
    work_order_id: wo,
    line_id: line,
    planned_start_at: NOV_START,
    planned_end_at: NOV_END,
  });

  /** Zatečen lanac: sidro (dubina 0) + sledbenik (dubina 1). */
  const lanac2 = () => [cvor("1", "10"), cvor("2", "20", { dubina: 1 })];

  const upis = (extra: Record<string, unknown> = {}) => ({
    workOrderId: "1",
    lineId: "10",
    deltaDays: 5,
    clientEventId: UUID,
    ...extra,
  });

  it("dryRun: ništa se ne upisuje, ključ se NE troši", async () => {
    const { svc, captured, idem } = makeService([lanac2()]);
    const res = (await svc.shiftChain(email, {
      workOrderId: "1",
      lineId: "10",
      deltaDays: 5,
      dryRun: true,
    })) as { data: Record<string, unknown>; meta: Record<string, unknown> };
    expect(res.meta.dry_run).toBe(true);
    expect(idem.run).not.toHaveBeenCalled();
    // Jedini izvršen iskaz je rekurzivni CTE — nema ni brave ni UPDATE-a.
    expect(captured.queries).toHaveLength(1);
    expect(captured.queries[0]).not.toContain("UPDATE");
    // Pregled nosi STARO stanje u planned_*, a NOVO u new_*.
    const st = (res.data.stavke as Record<string, unknown>[])[0];
    expect(st.planned_start_at).toBe(START.toISOString());
    expect(st.new_start).toBe(NOV_START.toISOString());
    expect(res.data.hash_after).toBeNull();
  });

  it("deltaDays = 0 pri upisu → 422 delta_zero, BEZ ijednog dodira baze", async () => {
    const { svc, captured, idem } = makeService();
    await expect(
      svc.shiftChain(email, upis({ deltaDays: 0 })),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(captured.queries).toHaveLength(0);
    expect(idem.run).not.toHaveBeenCalled();
  });

  it("upis bez clientEventId → 400 (delta NIJE idempotentna sama po sebi)", async () => {
    const { svc, idem } = makeService();
    await expect(
      svc.shiftChain(email, { workOrderId: "1", lineId: "10", deltaDays: 5 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(idem.run).not.toHaveBeenCalled();
  });

  it("sidro bez overlay reda → 404 overlay_not_found", async () => {
    const { svc } = makeService([[]]);
    await expect(svc.shiftChain(email, upis())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("sidro bez planiranog termina → 422 anchor_without_terms", async () => {
    const { svc } = makeService([[cvor("1", "10", { planned_start_at: null })]]);
    await expect(svc.shiftChain(email, upis())).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });

  it("ciklus u zatvorenju (A→B→A) → 422 sa putanjom i ivicom, BEZ UPDATE-a", async () => {
    const ciklican = [
      cvor("1", "10", { ciklus: true, putanja_txt: ["1:10", "2:20", "1:10"] }),
      cvor("2", "20", { dubina: 1, putanja_txt: ["1:10", "2:20"] }),
    ];
    const { svc, captured } = makeService([ciklican]);
    // Jedan poziv, pa provera tela — FIFO mock se troši, drugi poziv bi vratio prazno.
    const greska = await svc.shiftChain(email, upis()).catch((e: unknown) => e);
    expect(greska).toBeInstanceOf(UnprocessableEntityException);
    const body = (greska as UnprocessableEntityException).getResponse() as {
      code: string;
      cycle: { putanja: string[]; ivica: string };
    };
    expect(body.code).toBe("predecessor_cycle");
    expect(body.cycle.putanja).toEqual(["1:10", "2:20", "1:10"]);
    expect(body.cycle.ivica).toBe("2:20 -> 1:10");
    expect(captured.queries.some((q) => jeUpdate(q))).toBe(false);
  });

  it("zatvorenje veće od kape → 422 cascade_too_large, bez upisa", async () => {
    const preveliko = Array.from({ length: 501 }, (_, i) =>
      cvor(String(i + 1), String((i + 1) * 10), { dubina: i }),
    );
    const { svc, captured } = makeService([preveliko]);
    await expect(svc.shiftChain(email, upis())).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(captured.queries.some((q) => jeUpdate(q))).toBe(false);
  });

  it("🔴 ZAVRŠENO SIDRO se IPAK pomera (brana nad sidrom bi gest učinila nevidljivim)", async () => {
    const redovi = [cvor("1", "10", { zavrseno: true })];
    const { svc } = makeService([redovi, [], redovi, [vracen("1", "10")]]);
    const res = (await svc.shiftChain(email, upis())) as {
      data: { stavke: { work_order_id: string }[]; preskoceno: unknown[] };
    };
    expect(res.data.stavke.map((s) => s.work_order_id)).toEqual(["1"]);
    expect(res.data.preskoceno).toHaveLength(0);
  });

  it("🔴 sledbenik BEZ termina je preskočen, ali je NJEGOV sledbenik pomeren (hod ≠ preskok)", async () => {
    const redovi = [
      cvor("1", "10"),
      cvor("2", "20", { dubina: 1, planned_start_at: null, planned_end_at: null }),
      cvor("3", "30", { dubina: 2 }),
    ];
    const { svc } = makeService([
      redovi,
      [],
      redovi,
      [vracen("1", "10"), vracen("3", "30")],
    ]);
    const res = (await svc.shiftChain(email, upis())) as {
      data: {
        stavke: { work_order_id: string }[];
        preskoceno: { work_order_id: string; razlog_kod: string }[];
      };
    };
    expect(res.data.stavke.map((s) => s.work_order_id)).toEqual(["1", "3"]);
    expect(res.data.preskoceno).toEqual([
      expect.objectContaining({ work_order_id: "2", razlog_kod: "bez_termina" }),
    ]);
  });

  it("🔴 ZAVRŠEN sledbenik je preskočen, a rep ISPOD njega se pomera", async () => {
    const redovi = [
      cvor("1", "10"),
      cvor("2", "20", { dubina: 1, zavrseno: true }),
      cvor("3", "30", { dubina: 2 }),
    ];
    const { svc } = makeService([
      redovi,
      [],
      redovi,
      [vracen("1", "10"), vracen("3", "30")],
    ]);
    const res = (await svc.shiftChain(email, upis())) as {
      data: {
        stavke: { work_order_id: string }[];
        preskoceno: { razlog_kod: string }[];
        totals: { pomereno: number; preskoceno_zavrsenih: number };
        needs_confirm: boolean;
      };
    };
    expect(res.data.stavke.map((s) => s.work_order_id)).toEqual(["1", "3"]);
    expect(res.data.preskoceno[0].razlog_kod).toBe("zavrseno");
    expect(res.data.totals.preskoceno_zavrsenih).toBe(1);
    // Preskočena ZAVRŠENA pozicija traži potvrdu i kad je lanac kratak.
    expect(res.data.needs_confirm).toBe(true);
  });

  it("grananje: svaki red se pojavljuje TAČNO JEDNOM u stavkama", async () => {
    const redovi = [
      cvor("1", "10"),
      cvor("2", "20", { dubina: 1 }),
      cvor("3", "30", { dubina: 1 }),
    ];
    const { svc } = makeService([
      redovi,
      [],
      redovi,
      [vracen("1", "10"), vracen("2", "20"), vracen("3", "30")],
    ]);
    const res = (await svc.shiftChain(email, upis())) as {
      data: { stavke: { work_order_id: string }[] };
    };
    const kljucevi = res.data.stavke.map((s) => s.work_order_id);
    expect(kljucevi).toEqual(["1", "2", "3"]);
    expect(new Set(kljucevi).size).toBe(kljucevi.length);
  });

  it("orfan overlay (bez work_order_operations reda) → preskočen, hod se nastavlja", async () => {
    const redovi = [
      cvor("1", "10"),
      cvor("2", "20", { dubina: 1, orfan: true }),
      cvor("3", "30", { dubina: 2 }),
    ];
    const { svc } = makeService([
      redovi,
      [],
      redovi,
      [vracen("1", "10"), vracen("3", "30")],
    ]);
    const res = (await svc.shiftChain(email, upis())) as {
      data: {
        stavke: { work_order_id: string }[];
        preskoceno: { razlog_kod: string }[];
      };
    };
    expect(res.data.stavke.map((s) => s.work_order_id)).toEqual(["1", "3"]);
    expect(res.data.preskoceno[0].razlog_kod).toBe("orfan");
  });

  it("arhiviran overlay → preskočen (kod `arhivirano`)", async () => {
    const redovi = [cvor("1", "10"), cvor("2", "20", { dubina: 1, arhivirano: true })];
    const { svc } = makeService([redovi, [], redovi, [vracen("1", "10")]]);
    const res = (await svc.shiftChain(email, upis())) as {
      data: { preskoceno: { razlog_kod: string }[] };
    };
    expect(res.data.preskoceno[0].razlog_kod).toBe("arhivirano");
  });

  it("🔴 KANON BRAVE: brave su ZASEBAN iskaz sa ORDER BY (wo, line) + FOR UPDATE", async () => {
    const redovi = lanac2();
    const { svc, captured } = makeService([
      redovi,
      [],
      redovi,
      [vracen("1", "10"), vracen("2", "20")],
    ]);
    await svc.shiftChain(email, upis());
    // [0] rekurzivni CTE — `FOR UPDATE` nad njim TIHO ne zaključava ništa, pa ga NEMA.
    expect(captured.queries[0]).toContain("WITH RECURSIVE");
    expect(captured.queries[0]).not.toContain("FOR UPDATE");
    // [1] zaseban iskaz brave u kanonskom redosledu.
    expect(captured.queries[1]).toContain("FOR UPDATE");
    expect(captured.queries[1]).toContain("ORDER BY work_order_id, line_id");
  });

  it("plan se promenio POD BRAVOM → 409 chain_changed sa svežim planom, bez UPDATE-a", async () => {
    const pre = lanac2();
    // Pod bravom je sledbenik u međuvremenu dobio DRUGI termin.
    const posle = [
      cvor("1", "10"),
      cvor("2", "20", {
        dubina: 1,
        planned_start_at: new Date("2026-08-11T06:00:00.000Z"),
      }),
    ];
    const { svc, captured } = makeService([pre, [], posle]);
    const greska = await svc.shiftChain(email, upis()).catch((e: unknown) => e);
    expect(greska).toBeInstanceOf(ConflictException);
    const body = (greska as ConflictException).getResponse() as {
      code: string;
      plan: { stavke: unknown[] };
    };
    expect(body.code).toBe("chain_changed");
    expect(body.plan.stavke).toHaveLength(2);
    expect(captured.queries.some((q) => jeUpdate(q))).toBe(false);
  });

  it("expectedHash se ne poklapa → 409 chain_changed, bez UPDATE-a", async () => {
    const redovi = lanac2();
    const { svc, captured } = makeService([redovi, [], redovi]);
    await expect(
      svc.shiftChain(email, upis({ expectedHash: "deadbeefdeadbeef" })),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(captured.queries.some((q) => jeUpdate(q))).toBe(false);
  });

  it("🔴 UPDATE nosi zonu plana, ceo dan, i RUČNO stampan updated_at/by", async () => {
    const redovi = [cvor("1", "10")];
    const { svc, captured } = makeService([redovi, [], redovi, [vracen("1", "10")]]);
    await svc.shiftChain(email, upis());
    const sql = captured.queries.find((q) => jeUpdate(q)) ?? "";
    expect(sql).toContain("AT TIME ZONE 'Europe/Belgrade'");
    expect(sql).toContain("make_interval(days =>");
    expect(sql).toContain("updated_at = now()");
    expect(sql).toContain("updated_by");
    // `plan_proizvodnje_overlays` nema nijedan triger, a `updatedAt` je @default(now()),
    // NE @updatedAt — bez ručnog pečata bi rupa u auditu bila odmah vidljiva.
  });

  it("🔴 odgovor je JSON-stabilan: termini su ISO STRINGOVI, ne Date", async () => {
    const redovi = [cvor("1", "10")];
    const { svc } = makeService([redovi, [], redovi, [vracen("1", "10")]]);
    const res = (await svc.shiftChain(email, upis())) as {
      data: { stavke: { planned_start_at: unknown; new_start: unknown }[] };
    };
    const st = res.data.stavke[0];
    expect(typeof st.planned_start_at).toBe("string");
    expect(st.planned_start_at).toBe(NOV_START.toISOString());
    // Pri UPISU su `new_*` null (staro stanje se ne vraća duplo).
    expect(st.new_start).toBeNull();
  });

  it("isti clientEventId dvaput → drugi poziv NE izvršava akciju (idempotent)", async () => {
    const redovi = lanac2();
    const { svc, captured, tx } = makeService([
      redovi,
      [],
      redovi,
      [vracen("1", "10"), vracen("2", "20")],
    ]);
    // Registar koji stvarno pamti ishod po ključu (kao `api_idempotency`).
    const memo = new Map<string, unknown>();
    (svc as unknown as { idem: unknown }).idem = {
      run: jest.fn(
        async (
          _e: string,
          k: string,
          _a: string,
          fn: (t: unknown) => Promise<unknown>,
        ) => {
          if (memo.has(k)) return { idempotent: true, result: memo.get(k) };
          const result = await fn(tx);
          memo.set(k, result);
          return { idempotent: false, result };
        },
      ),
    };
    const prvi = (await svc.shiftChain(email, upis())) as {
      meta: { idempotent: boolean };
    };
    const brojUpita = captured.queries.length;
    const drugi = (await svc.shiftChain(email, upis())) as {
      meta: { idempotent: boolean };
    };
    expect(prvi.meta.idempotent).toBe(false);
    expect(drugi.meta.idempotent).toBe(true);
    expect(captured.queries).toHaveLength(brojUpita); // nijedan nov upit
  });
});

/**
 * 075/26 — dve male popravke u istoj grani: anti-ciklus PRI KREIRANJU veze i kanonski
 * pre-lock u `reorderOverlays` (bez njega se zastoj sa kaskadom prihvata SLUČAJNO).
 */
describe("075/26 — anti-ciklus na vezi i kanon brave u reorder-u", () => {
  /** Zatečen red stavke bez ijednog termina/uslova (kakav vraća `assertPlanConsistent`). */
  const prazan = () => [
    {
      planned_start_at: null,
      planned_end_at: null,
      predecessor_work_order_id: null,
      predecessor_line: null,
    },
  ];

  it("veza koja zatvara A→B→A → 422 predecessor_cycle (do sada je PROLAZILA)", async () => {
    // [0] zatečen red stavke A; [1] hod naviše: predloženi prethodnik B ima uslov = A.
    const { svc, captured } = makeService([
      prazan(),
      [{ predecessor_work_order_id: 9400, predecessor_line: 12 }],
    ]);
    await expect(
      svc.upsertOverlay(email, {
        workOrderId: "9400",
        lineId: "12",
        predecessorWorkOrderId: "5500",
        predecessorLine: "77",
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(captured.overlay).toBeUndefined();
  });

  it("veza bez petlje prolazi (hod naviše stane na korenu)", async () => {
    const { svc, captured } = makeService([
      prazan(),
      [{ predecessor_work_order_id: null, predecessor_line: null }],
    ]);
    await svc.upsertOverlay(email, {
      workOrderId: "9400",
      lineId: "12",
      predecessorWorkOrderId: "5500",
      predecessorLine: "77",
    });
    expect(captured.overlay!.update.predecessorWorkOrderId).toBe(5500);
  });

  it("reorderOverlays: PRVI iskaz je kanonski pre-lock (ORDER BY wo, line + FOR UPDATE)", async () => {
    const { svc, captured } = makeService();
    await svc.reorderOverlays(email, {
      items: [
        { workOrderId: "2", lineId: "20" },
        { workOrderId: "1", lineId: "10" },
      ],
    });
    expect(captured.queries[0]).toContain("FOR UPDATE");
    expect(captured.queries[0]).toContain("ORDER BY work_order_id, line_id");
  });
});
