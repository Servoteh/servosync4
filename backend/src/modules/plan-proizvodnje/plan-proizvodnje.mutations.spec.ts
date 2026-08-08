import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import {
  CASCADE_MAX_DEPTH,
  PlanProizvodnjeService,
} from "./plan-proizvodnje.service";
import type { IdempotencyService } from "../../common/idempotency/idempotency.service";
import { Prisma } from "@prisma/client";
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
/**
 * @param zatecen ZATEČENO stanje overlay reda pre upisa (078/26). Prisma `upsert` vraća
 *   CEO red iz baze, ne samo poslata polja — a merge-patch (resize bara, Shift+←/→)
 *   po definiciji radi nad redom koji već ima termin. Bez ovoga mock ne ume da razlikuje
 *   „nikad nije bio na gantu" od „jeste, menja mu se samo kraj", pa se dvostruki upis
 *   ne može ni testirati.
 */
function makeService(
  queryReturns: QReturn[] = [],
  zatecen: { plannedStartAt?: Date | null; terminPostoji?: boolean } = {},
) {
  const captured: {
    overlay?: { where: unknown; create: Record<string, unknown>; update: Record<string, unknown> };
    /**
     * SVI `upsert`-i redom (075/26 treći krug): kanon brave nad tabelom u kojoj 217.490
     * od 217.732 parova NEMA red se poštuje samo REDOSLEDOM UPISA — `FOR UPDATE` nad
     * nepostojećim redom ne uzima ništa. Bez ove liste se to ne može ni izmeriti.
     */
    overlays: { where: unknown; create: Record<string, unknown>; update: Record<string, unknown> }[];
    urgency?: { where: unknown; create: Record<string, unknown>; update: Record<string, unknown> };
    exec?: { values: unknown[] };
    execs: { values: unknown[] }[];
    /** Tekst SVAKOG izvršenog `$queryRaw` iskaza, redom (075/26 kanon brave). */
    queries: string[];
    /** 078/26: svaki upis u tabelu termina (dvostruki upis Faze A). */
    termini: { where: unknown; create: Record<string, unknown>; update: Record<string, unknown> }[];
    /** 078/26: brisanja termina (pozicija skinuta sa ganta). */
    terminBrisanja: { where: { overlayId: number } }[];
  } = { execs: [], overlays: [], queries: [], termini: [], terminBrisanja: [] };
  let qi = 0;
  // 078/26 FAZA A: kaskada posle UPDATE-a nad overlay-ima pušta još jedan iskaz koji
  // isti pomak preslikava u `plan_proizvodnje_termini`, i poredi brojeve. Da se ne dira
  // FIFO red u svakom postojećem testu, mock taj iskaz PREPOZNAJE po tekstu i vraća
  // tačno onoliko redova koliko je overlay UPDATE vratio — što je i stvarno ponašanje
  // (1:1 je u Fazi A garantovano jedinstvenim indeksom). Test koji hoće da proveri
  // branu namerno vraća drugi broj kroz `queryReturns`.
  let poslednjiOverlayUpdate = 0;
  const tx = {
    $queryRaw: jest.fn(async (sql: unknown) => {
      const tekst = sqlText(sql);
      captured.queries.push(tekst);
      if (tekst.includes("UPDATE plan_proizvodnje_termini t")) {
        const zadat = queryReturns[qi];
        if (Array.isArray(zadat)) {
          qi++;
          return zadat;
        }
        return Array.from({ length: poslednjiOverlayUpdate }, (_, i) => ({
          id: String(i + 1),
        }));
      }
      const out = queryReturns[qi++] ?? [];
      if (tekst.includes("UPDATE plan_proizvodnje_overlays o") && Array.isArray(out)) {
        poslednjiOverlayUpdate = out.length;
      }
      return out;
    }),
    $executeRaw: jest.fn(async (sql: { values: unknown[] }) => {
      captured.exec = sql;
      captured.execs.push(sql);
      return 1;
    }),
    planProizvodnjeOverlay: {
      upsert: jest.fn(async (a: typeof captured.overlay) => {
        captured.overlay = a;
        captured.overlays.push(a!);
        // Prisma vraća CEO red: zatečena polja pa preko njih ono što je upisano.
        return {
          plannedStartAt: zatecen.plannedStartAt ?? null,
          plannedEndAt: null,
          plannedDurationMinutes: null,
          plannedDone: null,
          plannedDoneAt: null,
          plannedDoneBy: null,
          id: 1,
          ...a!.create,
        };
      }),
    },
    planProizvodnjeUrgency: {
      upsert: jest.fn(async (a: typeof captured.urgency) => {
        captured.urgency = a;
        return { workOrderId: 9400, isUrgent: false };
      }),
    },
    // 078/26 FAZA A — dvostruki upis termina. Hvata se SVAKI poziv, jer se baš na
    // ovome meri da preslikač uzima ZAVRŠNO stanje overlay reda, a ne patch.
    planProizvodnjeTermin: {
      // 078/26: kaskada PREBROJI termine pogođenih parova, pa proveri da je pomerila
      // tačno toliko. Mock vraća „jedan termin po operaciji" — današnje stvarno stanje.
      count: jest.fn(async () => poslednjiOverlayUpdate),
      /**
       * Preslikač od 08.08. koristi `findFirst` + `create`/`update` umesto `upsert`,
       * da ne bi zavisio od privremenog jedinstvenog indeksa. `zatecenTermin`
       * bira koju granu test vežba: `null` = red tek nastaje.
       */
      findFirst: jest.fn(async () =>
        zatecen.terminPostoji === true ? { id: 42 } : null,
      ),
      create: jest.fn(async (a: { data: Record<string, unknown> }) => {
        captured.termini.push({ where: {}, create: a.data, update: {} });
        return { id: 1, ...a.data };
      }),
      update: jest.fn(async (a: { data: Record<string, unknown> }) => {
        captured.termini.push({ where: {}, create: {}, update: a.data });
        return { id: 42, ...a.data };
      }),
      upsert: jest.fn(async (a: (typeof captured.termini)[number]) => {
        captured.termini.push(a);
        return { id: 1, ...a.create };
      }),
      deleteMany: jest.fn(async (a: { where: { overlayId: number } }) => {
        captured.terminBrisanja.push(a);
        return { count: 1 };
      }),
    },
    // Količina termina se čita odavde (pun plan operacije u Fazi A).
    workOrder: {
      findUnique: jest.fn(async () => ({ pieceCount: 7 })),
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
    // [0] kanonski pre-lock; pa 2 para, ista grupa (3.1→3.9), bez force →
    // 2 machine-lookup + 2 target-exists.
    const { svc } = makeService([
      [],
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

  /**
   * 🔴 NALAZ 3 (ABBA): pre 075/26 su i `reorderOverlays` i `bulkReassign` uzimali brave
   * PRIKAZNIM redosledom, pa para nije bilo. Kanonski pre-lock u reorder-u NOVO uvodi par
   * (reorder ↔ bulkReassign) — oba gesta žive na ISTOM ekranu („Po mašini": prevlačenje
   * redosleda + „Premesti" nad izborom), pa bulk mora na ISTI kanon.
   */
  it("🔴 PRVI iskaz je kanonski pre-lock (ORDER BY wo, line + FOR UPDATE), PRE petlje", async () => {
    const { svc, captured } = makeService([
      [],
      machine("3.1"),
      targetExists(true),
      machine("3.1"),
      targetExists(true),
    ]);
    await svc.bulkReassign(
      email,
      {
        // Prikazni redosled je OBRNUT od kanonskog — brava ga mora poravnati.
        pairs: [
          { workOrderId: "11", lineId: "3" },
          { workOrderId: "10", lineId: "2" },
        ],
        targetMachine: "3.9",
        clientEventId: UUID,
      },
      true,
    );
    expect(captured.queries[0]).toContain("FOR UPDATE");
    expect(captured.queries[0]).toContain("ORDER BY work_order_id, line_id");
    // Brava ide PRE ijednog reassign upita (machine lookup je prvi u `reassignOne`).
    expect(captured.queries[0]).not.toContain("work_order_operations");
    // Oba para su u JEDNOM iskazu brave (jedna VALUES lista, ne dve brave).
    expect(captured.queries.filter((q) => q.includes("FOR UPDATE"))).toHaveLength(1);
  });

  /**
   * 🔴 NALAZ S1 (treći krug): brava sama NE zatvara par (reorder ↔ bulkReassign), jer
   * `FOR UPDATE` hvata samo POSTOJEĆE redove, a `upsert` je ovde najčešće INSERT
   * (izmereno: 217.490 od 217.732 parova nema overlay red). Ovde brava NAMERNO vraća
   * prazan skup i meri se redosled UPISA — to je jedino što na INSERT putu i postoji.
   */
  it("🔴 bulkReassign: i kad brava vrati PRAZNO (INSERT put), upisi idu kanonskim redom", async () => {
    const { svc, captured } = makeService([
      [], // brava: nijedan par nema overlay red
      machine("3.1"),
      targetExists(true),
      machine("3.1"),
      targetExists(true),
      machine("3.1"),
      targetExists(true),
    ]);
    await svc.bulkReassign(
      email,
      {
        // Prikazni redosled je OBRNUT od kanonskog.
        pairs: [
          { workOrderId: "11", lineId: "3" },
          { workOrderId: "10", lineId: "9" },
          { workOrderId: "10", lineId: "2" },
        ],
        targetMachine: "3.9",
        clientEventId: UUID,
      },
      true,
    );
    expect(
      captured.overlays.map((o) => (o.where as { workOrderId_lineId: unknown }).workOrderId_lineId),
    ).toEqual([
      { workOrderId: 10, lineId: 2 },
      { workOrderId: 10, lineId: 9 },
      { workOrderId: 11, lineId: 3 },
    ]);
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

// ── 078/26: kaskada pomera SVE termine pozicije (odluka Nenad 08.08.2026) ────
  //
  // „Uslov" je osobina POZICIJE, ne pojedinačnog termina: pozicija u celini kasni
  // ili rani, pa se pomeraju SVI njeni termini istim pomakom. Selektivno pomeranje
  // bi razbilo redosled unutar same operacije („5 pa 3 pa 2" prestalo bi da bude to).

  it("🔴 termini pomeraju SVOJU vrednost — NE prepisuju se sa overlay-a", async () => {
    // Prepis sa overlay-a bi sve termine pozicije slepio na ISTI datum, jer overlay
    // nosi samo jednu vrednost. Zato UPDATE mora da računa iz t.planned_start_at.
    const l = lanac2();
    const { svc, captured } = makeService([l, [], l, l.map((r) => vracen(r.work_order_id, r.line_id))]);
    await svc.shiftChain(email, upis());
    const upit = captured.queries.find((q) => q.includes("UPDATE plan_proizvodnje_termini t"));
    expect(upit).toBeDefined();
    expect(upit).toContain("t.planned_start_at");
    expect(upit).not.toContain("o.planned_start_at");
    // Filter je po paru (RN, linija) — dakle hvata SVE termine te pozicije.
    expect(upit).toContain("(t.work_order_id, t.line_id) IN");
  });

  it("brana broji TERMINE, ne overlay redove", async () => {
    const l = lanac2();
    const { svc, captured } = makeService([l, [], l, l.map((r) => vracen(r.work_order_id, r.line_id))]);
    await svc.shiftChain(email, upis());
    // Poruka mora da govori o terminima — inače se pri kvaru gleda pogrešna tabela.
    expect(captured.queries.some((q) => q.includes("UPDATE plan_proizvodnje_termini t"))).toBe(true);
  });

  it("lečenje NE koristi ON CONFLICT (posle Faze B jedinstvenog indeksa nema)", async () => {
    const l = lanac2();
    const { svc, captured } = makeService([l, [], l, l.map((r) => vracen(r.work_order_id, r.line_id))]);
    await svc.shiftChain(email, upis());
    const svi = captured.queries.concat(
      captured.execs.map((e) => String((e as unknown as { sql?: string }).sql ?? "")),
    );
    expect(svi.some((q) => q.includes("ON CONFLICT (overlay_id)"))).toBe(false);
    // Ali lečenje POSTOJI — pozicija bez ijednog termina dobija red.
    expect(svi.some((q) => q.includes("NOT EXISTS") && q.includes("plan_proizvodnje_termini"))).toBe(true);
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

  /**
   * 🔴 NALAZ 4 — KAPA DUBINE MORA DA SE ČUJE.
   *
   * Sa `WHERE s.dubina < CASCADE_MAX_DEPTH` je lanac dublji od kape bio TIHO prepolovljen:
   * `rows.length` = 51 (ispod kape čvorova 500), nema ciklusa, server mirno pomeri 51
   * poziciju i javi „Pomereno 51" — a rep ostane na starim terminima, čime se trajno
   * pokvare baš oni razmaci koje funkcija obećava da čuva. Rekurzija zato ide JEDAN nivo
   * preko kape (`<=`), pa se dodir kape prijavljuje kao 422.
   */
  it("🔴 lanac dublji od kape → 422 cascade_too_deep (ne tiho odsečen rep), bez upisa", async () => {
    // 52 čvora, dubine 0..51 — dubina 51 je JEDAN nivo preko kape (50).
    const predubok = Array.from({ length: CASCADE_MAX_DEPTH + 2 }, (_, i) =>
      cvor(String(i + 1), String((i + 1) * 10), { dubina: i }),
    );
    const { svc, captured } = makeService([predubok]);
    const greska = await svc.shiftChain(email, upis()).catch((e: unknown) => e);
    expect(greska).toBeInstanceOf(UnprocessableEntityException);
    const body = (greska as UnprocessableEntityException).getResponse() as {
      code: string;
      dubina: number;
      cap: number;
    };
    expect(body.code).toBe("cascade_too_deep");
    expect(body.dubina).toBe(CASCADE_MAX_DEPTH + 1);
    expect(body.cap).toBe(CASCADE_MAX_DEPTH);
    expect(captured.queries.some((q) => jeUpdate(q))).toBe(false);
  });

  it("lanac TAČNO na kapi (dubina = cap) prolazi — kapa je granica, ne strah", async () => {
    const naKapi = Array.from({ length: CASCADE_MAX_DEPTH + 1 }, (_, i) =>
      cvor(String(i + 1), String((i + 1) * 10), { dubina: i }),
    );
    const vraceni = naKapi.map((r) => vracen(r.work_order_id, r.line_id));
    const { svc } = makeService([naKapi, [], naKapi, vraceni]);
    const res = (await svc.shiftChain(email, upis())) as {
      data: { totals: { pomereno: number }; dubina_max: number };
    };
    expect(res.data.totals.pomereno).toBe(CASCADE_MAX_DEPTH + 1);
    expect(res.data.dubina_max).toBe(CASCADE_MAX_DEPTH);
  });

  it("🔴 rekurzija ide JEDAN nivo PREKO kape (`<=`) — inače se dodir kape ne vidi", async () => {
    const { svc, captured } = makeService([lanac2()]);
    await svc.shiftChain(email, {
      workOrderId: "1",
      lineId: "10",
      deltaDays: 5,
      dryRun: true,
    });
    expect(captured.queries[0]).toMatch(/s\.dubina <= /);
    // Ni jednog `<` bez `=` — stara kapa (`<`) je tiho sekla rep.
    expect(captured.queries[0]).not.toMatch(/s\.dubina <[^=]/);
  });

  /**
   * 🔴 NALAZ S4 (treći krug): ovaj test je bio PRAZAN. Fikstura je pravila 501 čvor sa
   * `dubina: i` (0…500), a od popravke `cascade_too_deep` ide PRE provere skupa — pucao je
   * dakle na dubini, ne na veličini, a test je i dalje prolazio jer je proveravao samo
   * KLASU izuzetka. `CASCADE_MAX_NODES` time nije imao NIJEDAN test.
   *
   * Zato je fikstura sada u ŠIRINU (jedno sidro + 500 sledbenika na dubini 1) i asertuje
   * se KOD, ne klasa. To je i jedini oblik u kom kapa čvorova uopšte može da okine na
   * pravom podatku: granat lanac, a ne nizanje.
   */
  it("🔴 zatvorenje veće od kape čvorova (ŠIRINA, ne dubina) → 422 cascade_too_large, bez upisa", async () => {
    const preveliko = Array.from({ length: 501 }, (_, i) =>
      cvor(String(i + 1), String((i + 1) * 10), { dubina: i === 0 ? 0 : 1 }),
    );
    const { svc, captured } = makeService([preveliko]);
    const greska = await svc.shiftChain(email, upis()).catch((e: unknown) => e);
    expect(greska).toBeInstanceOf(UnprocessableEntityException);
    const body = (greska as UnprocessableEntityException).getResponse() as {
      code: string;
      zahvat: number;
      cap: number;
    };
    expect(body.code).toBe("cascade_too_large");
    expect(body.zahvat).toBe(501);
    expect(body.cap).toBe(500);
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

  /**
   * 🔴 NALAZ 10 — SIDRO JE IZUZETO SAMO OD `zavrseno`.
   *
   * Arhivirana pozicija se crta na gantu i može da se prevuče; ista ta pozicija kao TUĐ
   * sledbenik biva preskočena uz obrazloženje „pozicija je arhivirana". Dve suprotne
   * presude o istom redu — sada se sudi jednako, uz zaseban 422 nad sidrom.
   */
  it("🔴 ARHIVIRANO SIDRO → 422 anchor_archived (isti red se ne sudi dvojako)", async () => {
    const { svc, captured } = makeService([[cvor("1", "10", { arhivirano: true })]]);
    const greska = await svc.shiftChain(email, upis()).catch((e: unknown) => e);
    expect(greska).toBeInstanceOf(UnprocessableEntityException);
    expect(
      ((greska as UnprocessableEntityException).getResponse() as { code: string }).code,
    ).toBe("anchor_archived");
    expect(captured.queries.some((q) => jeUpdate(q))).toBe(false);
  });

  it("🔴 ORFAN SIDRO (veza na obrisanu operaciju) → 422 anchor_orphan", async () => {
    const { svc, captured } = makeService([[cvor("1", "10", { orfan: true })]]);
    const greska = await svc.shiftChain(email, upis()).catch((e: unknown) => e);
    expect(greska).toBeInstanceOf(UnprocessableEntityException);
    expect(
      ((greska as UnprocessableEntityException).getResponse() as { code: string }).code,
    ).toBe("anchor_orphan");
    expect(captured.queries.some((q) => jeUpdate(q))).toBe(false);
  });

  it("ZAVRŠENO sidro i dalje PROLAZI — jedini izuzetak koji sidro ima", async () => {
    const redovi = [cvor("1", "10", { zavrseno: true })];
    const { svc } = makeService([redovi, [], redovi, [vracen("1", "10")]]);
    const res = (await svc.shiftChain(email, upis())) as {
      data: { totals: { pomereno: number } };
    };
    expect(res.data.totals.pomereno).toBe(1);
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

  /**
   * 🔴 NALAZ 8 — CIKLUS NASTAO IZMEĐU DVA ČITANJA JE 422, NE 409.
   *
   * Bez ove grane bi razlika hash-eva dala `chain_changed` sa PRAZNIM stavkama: dijalog
   * prikaže praznu tabelu sa aktivnim dugmetom „Pomeri", nikad ne pročita `plan.ciklus`,
   * a ciklus je TRAJNO stanje → planer klikće u beskonačnoj petlji.
   */
  it("🔴 ciklus nastao POD BRAVOM → 422 predecessor_cycle sa ivicom (ne 409 sa praznom tabelom)", async () => {
    const pre = lanac2();
    const posle = [
      cvor("1", "10", { ciklus: true, putanja_txt: ["1:10", "2:20", "1:10"] }),
      cvor("2", "20", { dubina: 1, putanja_txt: ["1:10", "2:20"] }),
    ];
    const { svc, captured } = makeService([pre, [], posle]);
    const greska = await svc.shiftChain(email, upis()).catch((e: unknown) => e);
    expect(greska).toBeInstanceOf(UnprocessableEntityException);
    expect(greska).not.toBeInstanceOf(ConflictException);
    const body = (greska as UnprocessableEntityException).getResponse() as {
      code: string;
      cycle: { ivica: string };
    };
    expect(body.code).toBe("predecessor_cycle");
    expect(body.cycle.ivica).toBe("2:20 -> 1:10"); // koju vezu razvezati
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

  /**
   * 🔴 NALAZ 7 — PRELAZ NA LETNJE VREME PRAVI KRAJ PRE POČETKA.
   *
   * Pozicija `02:30 → 03:00` pomerena NA dan prelaska (lokalnog sata 02:30 tada nema)
   * dobija početak koji „preskoči" u 03:30, a kraj ostane 03:00. Redovan upis to odbija
   * sa 422 (`planned_end_before_start`), a kaskada `assertPlanConsistent` ne zove.
   */
  it("🔴 kraj se KLAMPUJE na novi početak (GREATEST) — prelaz na letnje vreme", async () => {
    const redovi = [cvor("1", "10")];
    const { svc, captured } = makeService([redovi, [], redovi, [vracen("1", "10")]]);
    await svc.shiftChain(email, upis());
    const sql = captured.queries.find((q) => jeUpdate(q)) ?? "";
    expect(sql).toContain("GREATEST");
    // Spoljni `CASE` je uslov: `GREATEST` IGNORIŠE NULL, pa bi red bez `planned_end_at`
    // (izveden kraj iz tehnologije) dobio kraj = novi početak i „auto" bi se tiho ugasilo.
    expect(sql).toMatch(/planned_end_at\s+=\s+CASE WHEN o\.planned_end_at IS NULL THEN NULL/);
  });

  it("🔴 PREGLED koristi ISTI klamp kao UPIS (inače se `new_end` razilazi sa upisanim)", async () => {
    const { svc, captured } = makeService([lanac2()]);
    await svc.shiftChain(email, {
      workOrderId: "1",
      lineId: "10",
      deltaDays: 5,
      dryRun: true,
    });
    expect(captured.queries[0]).toContain("GREATEST");
  });

  /**
   * NALAZ 13 — `ORDER BY … dubina ASC` u `cvor` CTE-u je bio MRTAV: golo ime se u
   * `ORDER BY` prvo razrešava kao IZLAZNI alias, a izlaz je bio `min(dubina) OVER (…)`,
   * tj. konstanta unutar particije. Sa aliasom `dubina_min` se `dubina` razrešava kao
   * ULAZNA kolona i izbor najplićeg reda (putanje) je stvaran.
   */
  it("izlazni alias prozorskog min-a je `dubina_min` — `ORDER BY dubina` gađa ULAZNU kolonu", async () => {
    const { svc, captured } = makeService([lanac2()]);
    await svc.shiftChain(email, {
      workOrderId: "1",
      lineId: "10",
      deltaDays: 5,
      dryRun: true,
    });
    const sql = captured.queries[0];
    expect(sql).toMatch(
      /min\(dubina\)\s+OVER \(PARTITION BY work_order_id, line_id\) AS dubina_min/,
    );
    expect(sql).toContain("ORDER BY work_order_id, line_id, je_ciklus DESC, dubina ASC");
    // Nijedan izlazni alias se ne zove `dubina` — inače `ORDER BY dubina` opet umire.
    expect(sql).not.toMatch(/OVER \([^)]*\) AS dubina[,\s]/);
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

  /**
   * 🔴 NALAZ 4 (isti pojas slepila, drugi kraj): hod NAVIŠE je ranije posle 50 koraka
   * ćutke izlazio iz petlje i vezu PUŠTAO. Sada ide do `CASCADE_MAX_DEPTH + 1` i, ako se
   * ni tada nije zaustavio, odbija vezu — jer je to tačno onaj lanac koji kaskada posle
   * ne ume da pomeri celog.
   */
  it("🔴 hod naviše duži od kape → 422 cascade_too_deep (veza se NE upisuje)", async () => {
    // [0] zatečen red stavke; pa 60 hopova, svaki sa NOVIM (nikad ponovljenim) prethodnikom.
    const hopovi = Array.from({ length: 60 }, (_, i) => [
      { predecessor_work_order_id: 100000 + i, predecessor_line: 1 },
    ]);
    const { svc, captured } = makeService([prazan(), ...hopovi]);
    const greska = await svc
      .upsertOverlay(email, {
        workOrderId: "9400",
        lineId: "12",
        predecessorWorkOrderId: "5500",
        predecessorLine: "77",
      })
      .catch((e: unknown) => e);
    expect(greska).toBeInstanceOf(UnprocessableEntityException);
    const body = (greska as UnprocessableEntityException).getResponse() as {
      code: string;
      cap: number;
    };
    expect(body.code).toBe("cascade_too_deep");
    expect(body.cap).toBe(CASCADE_MAX_DEPTH);
    expect(captured.overlay).toBeUndefined();
  });

  /**
   * 🔴 NALAZ N2 (treći krug): čuvar je bio za TAČNO 1 labaviji od kape koju brani.
   *
   * Sa `dubina <= CASCADE_MAX_DEPTH` je hod posećivao 51 pretka i vezu PUŠTAO, a
   * `collectChain` nad korenom je toj istoj poziciji davao `dubina 51 > 50` →
   * `cascade_too_deep`. Ishod: veza se upiše, a lanac postane NEPOMERLJIV — najgori
   * mogući, jer greška stiže tek na potez koji sa vezom nema veze.
   *
   * Račun: hod poseti pretke `P0…Pk`, nova pozicija sedi na dubini `k + 1`. Prolazi
   * dakle najviše `CASCADE_MAX_DEPTH` predaka; `CASCADE_MAX_DEPTH + 1` mora da padne.
   */
  it("hod naviše sa TAČNO `cap` predaka prolazi (nova pozicija sedne na `cap`)", async () => {
    // 49 hopova sa prethodnikom + 50-ti bez njega = 50 posećenih predaka (P0…P49).
    const hopovi = Array.from({ length: CASCADE_MAX_DEPTH - 1 }, (_, i) => [
      { predecessor_work_order_id: 100000 + i, predecessor_line: 1 },
    ]);
    const { svc, captured } = makeService([
      prazan(),
      ...hopovi,
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

  it("🔴 hod naviše sa `cap + 1` predaka PADA — inače bi lanac ostao nepomerljiv", async () => {
    // 50 hopova sa prethodnikom + koren = 51 predak → nova pozicija bi bila na dubini 51,
    // a kaskada odbija sve preko 50. Veza se zato ne upisuje uopšte.
    const hopovi = Array.from({ length: CASCADE_MAX_DEPTH }, (_, i) => [
      { predecessor_work_order_id: 100000 + i, predecessor_line: 1 },
    ]);
    const { svc, captured } = makeService([
      prazan(),
      ...hopovi,
      [{ predecessor_work_order_id: null, predecessor_line: null }],
    ]);
    const greska = await svc
      .upsertOverlay(email, {
        workOrderId: "9400",
        lineId: "12",
        predecessorWorkOrderId: "5500",
        predecessorLine: "77",
      })
      .catch((e: unknown) => e);
    expect(greska).toBeInstanceOf(UnprocessableEntityException);
    expect(
      ((greska as UnprocessableEntityException).getResponse() as { code: string }).code,
    ).toBe("cascade_too_deep");
    expect(captured.overlay).toBeUndefined();
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

  /**
   * 🔴 NALAZ S1 (treći krug): pre-lock JE BIO NO-OP ZA SKORO SVE. `SELECT … FOR UPDATE`
   * zaključava samo redove KOJI POSTOJE, a oba potrošača rade `upsert` — dakle najčešće
   * INSERT. Izmereno na produkciji:
   *
   *     operacija_ukupno | ima_overlay | bez_overlaya
   *               217732 |         242 |       217490
   *
   * Za par bez overlay reda brava ne uzme ništa i INSERT ide na unique indeks
   * `uq_…_wo_line` PRIKAZNIM redosledom — dakle ABBA sa kaskadom je ostao živ tačno kao
   * pre popravke. Zato oba testa ispod puštaju bravu da vrati PRAZAN skup (INSERT put,
   * podrazumevano ponašanje mocka) i mere REDOSLED UPISA, ne tekst brave.
   */
  it("🔴 reorderOverlays: i kad brava vrati PRAZNO (INSERT put), upisi idu kanonskim redom", async () => {
    // Brava vraća `[]` → nijedan par nema overlay red, kao za 217.490 od 217.732 parova.
    const { svc, captured } = makeService([[]]);
    await svc.reorderOverlays(email, {
      // Prikazni redosled (hala/mašina/`shift_sort_order`) je OBRNUT od kanonskog.
      items: [
        { workOrderId: "2", lineId: "20" },
        { workOrderId: "2", lineId: "5" },
        { workOrderId: "1", lineId: "10" },
      ],
    });
    expect(
      captured.overlays.map((o) => (o.where as { workOrderId_lineId: unknown }).workOrderId_lineId),
    ).toEqual([
      { workOrderId: 1, lineId: 10 },
      { workOrderId: 2, lineId: 5 },
      { workOrderId: 2, lineId: 20 },
    ]);
    // 🔴 Sortira se REDOSLED UPISA, ne značenje: redni broj ostaje vezan za PRIKAZNI
    // položaj stavke (inače bi sortiranje tiho prevrnulo ručni redosled smene).
    expect(captured.overlays.map((o) => o.create.shiftSortOrder)).toEqual([3, 2, 1]);
  });
});

/**
 * 078/26 FAZA A — dvostruki upis u `plan_proizvodnje_termini`.
 *
 * Ova faza NE menja nijedan ekran: čitanje i dalje ide sa overlay-a, a tabela termina
 * se samo puni. Zato je jedino što ovde ima smisla zaključati baš ono što će biti mera
 * pred prelazak čitanja: da se dve tabele NE MOGU razići.
 */
describe("078/26 Faza A — dvostruki upis termina", () => {
  it("🔴 preslikava ZAVRŠNO stanje overlay reda, ne patch (merge-patch zamka)", async () => {
    // FE resize bara i Shift+←/→ šalju SAMO `plannedEndAt`. Da se preslikavao patch,
    // termin bi dobio `plannedStartAt = undefined/NULL` iako ga korisnik nije dirao,
    // a overlay bi zadržao staru vrednost — tiho razilaženje koje se nigde ne prijavljuje.
    // Bar VEĆ stoji na gantu (inače se ne bi ni mogao resize-ovati) — zato zatečen start.
    const zatecenStart = new Date("2026-08-03T05:00:00.000Z");
    // Bar već ima termin (resize po definiciji radi nad postojećim), pa preslikač ide
    // u granu IZMENE — od 08.08. to je `update`, ne `upsert` (v. zašto u servisu).
    const { svc, captured } = makeService([], {
      plannedStartAt: zatecenStart,
      terminPostoji: true,
    });
    await svc.upsertOverlay(email, {
      workOrderId: "9400",
      lineId: "12",
      plannedEndAt: "2026-08-05T05:00:00.000Z",
    });

    expect(captured.termini).toHaveLength(1);
    const t = captured.termini[0];
    // Mock `planProizvodnjeOverlay.upsert` vraća ceo red, pa je ovo doslovno ono što
    // je overlay imao POSLE upisa.
    expect(t.update.plannedEndAt).toBeInstanceOf(Date);
    // 🔴 SRŽ: početak koji patch NIJE nosio mora ostati zatečena vrednost, a ne NULL.
    // Da se preslikavao patch, ovde bi stajalo undefined i termin bi se razišao sa
    // overlay-om na prvom resize-u bara.
    expect(t.update.plannedStartAt).toEqual(zatecenStart);
  });

  it("kad termina JOŠ nema, preslikač ga PRAVI (grana `create`)", async () => {
    const zatecenStart = new Date("2026-08-03T05:00:00.000Z");
    const { svc, captured } = makeService([], { plannedStartAt: zatecenStart });
    await svc.upsertOverlay(email, {
      workOrderId: "9400",
      lineId: "12",
      plannedEndAt: "2026-08-05T05:00:00.000Z",
    });
    expect(captured.termini).toHaveLength(1);
    expect(captured.termini[0].create.plannedStartAt).toEqual(zatecenStart);
    // Nov termin nosi PUN plan operacije (u Fazi A se količina ne deli).
    expect(captured.termini[0].create.kolicina).toBe(7);
  });

  it("termin je LENJ — nastaje tek kad pozicija dobije termin", async () => {
    // Dva mesta prave overlay BEZ termina (`reorderOverlays`, `bulkReassign`). Da je
    // termin obavezan, oba bi morala u dvostruki upis i ušla bi u budžet svoje
    // transakcije (2000 stavki / 5 s). Jedinstveni indeks dozvoljava NULA redova.
    const { svc, captured } = makeService();
    await svc.upsertOverlay(email, {
      workOrderId: "9400",
      lineId: "12",
      shiftNote: "samo beleška",
    });
    // Ono što je bitno: NIJEDAN termin nije nastao.
    expect(captured.termini).toHaveLength(0);
    // 🔴 Prati se i `deleteMany`, jer je baš ovde nađena greška: provera je bila
    // `=== null`, pa je red koji nikad nije bio na gantu (polje odsutno, dakle
    // `undefined`) padao u granu koja PRAVI termin — sa praznim početkom, a kolona je
    // NOT NULL. To bi u pogonu bilo 500 na običnoj izmeni beleške. Sada je `== null`,
    // pa takav red ide u čišćenje: bezopasno brisanje nepostojećeg reda.
    expect(captured.terminBrisanja).toHaveLength(1);
  });

  it("skidanje sa ganta briše termin (deleteMany, ne delete — reda ne mora biti)", async () => {
    const { svc, captured } = makeService();
    await svc.upsertOverlay(email, {
      workOrderId: "9400",
      lineId: "12",
      plannedStartAt: null,
      plannedEndAt: null,
    });
    expect(captured.termini).toHaveLength(0);
    expect(captured.terminBrisanja).toHaveLength(1);
  });

  it("količina termina je PUN plan operacije (u Fazi A se ne deli)", async () => {
    const { svc, captured } = makeService();
    await svc.upsertOverlay(email, {
      workOrderId: "9400",
      lineId: "12",
      plannedStartAt: "2026-08-03T05:00:00.000Z",
    });
    expect(captured.termini[0].create.kolicina).toBe(7); // mock `workOrder.pieceCount`
  });

  it("izmena NE dira `kolicina` ni mašinu termina (to je Faza B, planerova odluka)", async () => {
    const { svc, captured } = makeService();
    await svc.upsertOverlay(email, {
      workOrderId: "9400",
      lineId: "12",
      plannedStartAt: "2026-08-03T05:00:00.000Z",
    });
    const u = captured.termini[0].update;
    expect(Object.keys(u)).not.toContain("kolicina");
    expect(Object.keys(u)).not.toContain("assignedMachineCode");
  });
});

/**
 * 078/26 Faza B — rute za pojedinačan TERMIN.
 *
 * Rute postoje i pre nego što se skine privremeni jedinstveni indeks: dok on stoji,
 * drugi termin pada na P2002 i to se PREVODI u razumljiv 409 umesto sirovog 500.
 */
describe("078/26 Faza B — termini", () => {
  function terminSvc(opts: {
    postojeci?: Record<string, unknown> | null;
    createThrows?: unknown;
  } = {}) {
    const captured: {
      create?: Record<string, unknown>;
      update?: Record<string, unknown>;
      overlayUpsert?: unknown;
    } = {};
    const tx = {
      planProizvodnjeOverlay: {
        upsert: jest.fn(async (a: unknown) => {
          captured.overlayUpsert = a;
          return { id: 77 };
        }),
        // 078/26: brisanje POSLEDNJEG termina čisti i overlay (duh-bar).
        update: jest.fn(async () => ({ id: 77 })),
      },
      workOrder: { findUnique: jest.fn(async () => ({ pieceCount: 10 })) },
      planProizvodnjeTermin: {
        create: jest.fn(async (a: { data: Record<string, unknown> }) => {
          if (opts.createThrows) throw opts.createThrows;
          captured.create = a.data;
          return { id: 5, ...a.data };
        }),
        findUnique: jest.fn(async () => opts.postojeci ?? null),
        update: jest.fn(async (a: { data: Record<string, unknown> }) => {
          captured.update = a.data;
          return { id: 5, ...a.data };
        }),
        delete: jest.fn(async () => ({ id: 5 })),
      },
    };
    const prisma = {
      $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
      planProizvodnjeTermin: tx.planProizvodnjeTermin,
    } as unknown as PrismaService;
    const svc = new PlanProizvodnjeService(
      prisma,
      makeIdem(tx) as unknown as IdempotencyService,
    );
    return { svc, captured, tx };
  }

  it("izostavljena količina = PUN plan operacije (ponašanje pre 078/26)", async () => {
    const { svc, captured } = terminSvc();
    await svc.createTermin(email, {
      workOrderId: "9400",
      lineId: "12",
      plannedStartAt: "2026-08-10T06:00:00.000Z",
    });
    expect(captured.create!.kolicina).toBe(10);
  });

  it("zadata količina se poštuje (deo serije)", async () => {
    const { svc, captured } = terminSvc();
    await svc.createTermin(email, {
      workOrderId: "9400",
      lineId: "12",
      plannedStartAt: "2026-08-10T06:00:00.000Z",
      kolicina: 3,
    });
    expect(captured.create!.kolicina).toBe(3);
  });

  it("🔴 prazna mašina se upisuje kao NULL, ne kao prazan string", async () => {
    // COALESCE u čitanju uzima i '' kao vrednost, pa bi prazan string značio
    // „termin nema mašinu" umesto „nasledi sa operacije".
    const { svc, captured } = terminSvc();
    await svc.createTermin(email, {
      workOrderId: "9400",
      lineId: "12",
      plannedStartAt: "2026-08-10T06:00:00.000Z",
      assignedMachineCode: "   ",
    });
    expect(captured.create!.assignedMachineCode).toBeNull();
  });

  it("kraj pre početka → 422 (naopak interval se NE upisuje)", async () => {
    const { svc } = terminSvc();
    await expect(
      svc.createTermin(email, {
        workOrderId: "9400",
        lineId: "12",
        plannedStartAt: "2026-08-10T10:00:00.000Z",
        plannedEndAt: "2026-08-10T06:00:00.000Z",
      }),
    ).rejects.toThrow(/planned_end_before_start/);
  });

  it("🔴 drugi termin dok indeks stoji → 409 sa objašnjenjem, ne sirov 500", async () => {
    // Ne pravi se pravi Prisma izuzetak (klasa se ne uvozi u ovaj spec) — servis
    // gleda `instanceof`, pa se koristi minimalan dvojnik sa istim oblikom.
    const p2002 = Object.assign(
      Object.create(Prisma.PrismaClientKnownRequestError.prototype) as object,
      { code: "P2002", clientVersion: "6", message: "dup" },
    );
    const { svc } = terminSvc({ createThrows: p2002 });
    await expect(
      svc.createTermin(email, {
        workOrderId: "9400",
        lineId: "12",
        plannedStartAt: "2026-08-10T06:00:00.000Z",
      }),
    ).rejects.toThrow(/već ima termin/);
  });

  it("🔴 izmena se validira nad SPOJENIM stanjem (resize šalje samo kraj)", async () => {
    const { svc } = terminSvc({
      postojeci: {
        id: 5,
        plannedStartAt: new Date("2026-08-10T10:00:00.000Z"),
        plannedEndAt: new Date("2026-08-10T14:00:00.000Z"),
      },
    });
    // Patch nosi SAMO kraj, i to pre zatečenog početka — mora pasti.
    await expect(
      svc.patchTermin(email, 5, { plannedEndAt: "2026-08-10T06:00:00.000Z" }),
    ).rejects.toThrow(/planned_end_before_start/);
  });

  it("izmena koja ne dira vremena prolazi (količina)", async () => {
    const { svc, captured } = terminSvc({
      postojeci: {
        id: 5,
        plannedStartAt: new Date("2026-08-10T10:00:00.000Z"),
        plannedEndAt: null,
      },
    });
    await svc.patchTermin(email, 5, { kolicina: 4 });
    expect(captured.update!.kolicina).toBe(4);
    expect(Object.keys(captured.update!)).not.toContain("plannedStartAt");
  });

it("🔴 brisanje POSLEDNJEG termina čisti i overlay (inače ostaje duh-bar)", async () => {
    // Čitanje ima rezervu COALESCE(termin, overlay). Bez čišćenja bi se bar vratio
    // na stari datum, i planer bi video bar koji je upravo obrisao.
    const { svc, tx } = terminSvc({ postojeci: { id: 5, overlayId: 77 } });
    (tx.planProizvodnjeTermin as unknown as { count: jest.Mock }).count = jest.fn(async () => 0);
    const res = (await svc.deleteTermin(email, 5)) as { data: { poslednji: boolean } };
    expect(res.data.poslednji).toBe(true);
    const upd = (tx.planProizvodnjeOverlay as unknown as { update: jest.Mock }).update;
    expect(upd).toHaveBeenCalled();
    const arg = upd.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(arg.data.plannedStartAt).toBeNull();
    expect(arg.data.plannedEndAt).toBeNull();
    // Override trajanja se NE dira — podešavanje pozicije, ne termina (pouka 07.08.).
    expect(Object.keys(arg.data)).not.toContain("plannedDurationMinutes");
  });

  it("brisanje NIJE poslednjeg termina ne dira overlay", async () => {
    const { svc, tx } = terminSvc({ postojeci: { id: 5, overlayId: 77 } });
    (tx.planProizvodnjeTermin as unknown as { count: jest.Mock }).count = jest.fn(async () => 2);
    const res = (await svc.deleteTermin(email, 5)) as { data: { poslednji: boolean } };
    expect(res.data.poslednji).toBe(false);
    expect((tx.planProizvodnjeOverlay as unknown as { update: jest.Mock }).update).not.toHaveBeenCalled();
  });

  it("izmena nepostojećeg termina → 404", async () => {
    const { svc } = terminSvc({ postojeci: null });
    await expect(svc.patchTermin(email, 999, { kolicina: 1 })).rejects.toThrow(
      /ne postoji/,
    );
  });
});
