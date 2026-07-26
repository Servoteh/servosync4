import { KadrovskaMutationsService } from "./kadrovska-mutations.service";

/**
 * AUDIT-K1 (26.07) — regresioni testovi za nalaze „gubitak podataka i novca".
 * Svaki test pada na zatečenom kodu i prolazi tek posle ispravke:
 *  1) grid/batch delimičan red je GAZIO absence_code, field_hours, field_subtype
 *     i two_machine_hours (tab „Sati” šalje 6 od 11 polja) → brisanje GO iz grida
 *     = vraćen godišnji, jer je saldo GO po kanonu izveden IZ GRIDA;
 *  2) praznik sa is_workday=true bio je tretiran kao neradni (fond i praznični sati);
 *  3) „Obračunaj iz grida" nije upisivao domestic_days/foreign_days/per_diem_*
 *     → trigger salary_payroll_compute_totals računao total_eur iz nedirnutih
 *     kolona → DEVIZNE dnevnice montažera ispadale 0;
 *  4) upload dokumenta nije postavljao uploaded_by → INSERT politika
 *     (uploaded_by = auth.uid()) obarala je SVAKI upload.
 */
describe("Kadrovska AUDIT-K1 — gubitak podataka i novca", () => {
  const EMAIL = "test@servoteh.com";
  const EMP = "3b241101-e2bb-4255-8caf-4136c566a962";

  type SqlLike = { strings?: readonly string[]; values?: unknown[] };
  const sqlText = (s: SqlLike) =>
    Array.isArray(s?.strings) ? s.strings.join("?") : String(s);

  /** Payload poslat RPC-u hr_upsert_work_hours_batch / hr_upsert_salary_payroll. */
  const rpcPayload = (calls: SqlLike[], fn: string): Record<string, unknown>[] => {
    const hit = calls.find((c) => sqlText(c).includes(fn));
    if (!hit) throw new Error(`RPC ${fn} nije pozvan`);
    const raw = hit.values?.[0];
    const parsed = JSON.parse(String(raw));
    return Array.isArray(parsed) ? parsed : [parsed];
  };

  const mkService = (tx: Record<string, unknown>) => {
    const sy15 = {
      withUserRls: jest.fn(async (_e: string, fn: (t: unknown) => unknown) =>
        fn(tx),
      ),
      runIdempotentRls: jest.fn(
        async (_e: unknown, _c: unknown, _a: unknown, fn: (t: unknown) => unknown) => ({
          idempotent: false,
          result: await fn(tx),
        }),
      ),
      withUser: jest.fn(),
      runIdempotent: jest.fn(),
    };
    return new KadrovskaMutationsService(
      sy15 as never,
      { upload: jest.fn(), signUrl: jest.fn(), remove: jest.fn() } as never,
      { configured: true, send: jest.fn().mockResolvedValue(true) } as never,
      { enabled: false, dispatchKadr: jest.fn() } as never,
    );
  };

  // ── 1) grid/batch: delimičan red NE sme da obriše odsustvo/teren/2-mašine ──

  const gridTx = (existing: Record<string, unknown> | null) => {
    const calls: SqlLike[] = [];
    return {
      calls,
      tx: {
        $queryRaw: jest.fn(async (sql: SqlLike) => {
          calls.push(sql);
          return [{ v: { applied: 1 } }];
        }),
        $executeRaw: jest.fn(),
        workHours: {
          findMany: jest.fn().mockResolvedValue(existing ? [existing] : []),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      },
    };
  };

  const POSTOJECI_DAN = {
    employeeId: EMP,
    workDate: new Date("2026-07-15T00:00:00Z"),
    hours: 0,
    overtimeHours: 0,
    fieldHours: 8,
    fieldSubtype: "foreign",
    twoMachineHours: 4,
    absenceCode: "go",
    absenceSubtype: null,
    note: "beleska",
    projectRef: "PR-1",
  };

  it("tab „Sati” (6 polja) čuva absence_code, teren i 2-mašine postojećeg dana", async () => {
    const { tx, calls } = gridTx(POSTOJECI_DAN);
    // Tačno ono što šalje work-hours-tab.tsx: bez field_*/absence_*/two_machine.
    await mkService(tx).gridBatch(EMAIL, {
      rows: [
        {
          employeeId: EMP,
          workDate: "2026-07-15",
          hours: 8,
          overtimeHours: 2,
          projectRef: "PR-1",
          note: "beleska",
        },
      ],
    } as never);

    const [row] = rpcPayload(calls, "hr_upsert_work_hours_batch");
    expect(row.hours).toBe(8); // poslato = primenjeno
    expect(row.overtime_hours).toBe(2);
    expect(row.absence_code).toBe("go"); // NIJE obrisano
    expect(row.field_hours).toBe(8);
    expect(row.field_subtype).toBe("foreign");
    expect(row.two_machine_hours).toBe(4);
  });

  it("eksplicitna prazna vrednost i dalje BRIŠE (1.0 semantika: '' = clear)", async () => {
    const { tx, calls } = gridTx(POSTOJECI_DAN);
    await mkService(tx).gridBatch(EMAIL, {
      rows: [
        {
          employeeId: EMP,
          workDate: "2026-07-15",
          hours: 8,
          absenceCode: "",
          fieldHours: 0,
          twoMachineHours: 0,
        },
      ],
    } as never);

    const [row] = rpcPayload(calls, "hr_upsert_work_hours_batch");
    expect(row.absence_code).toBe(""); // RPC radi NULLIF('','') → NULL
    expect(row.field_hours).toBe(0);
    expect(row.two_machine_hours).toBe(0);
  });

  it("nov dan (bez postojećeg reda) dobija neutralne vrednosti, ne undefined", async () => {
    const { tx, calls } = gridTx(null);
    await mkService(tx).gridBatch(EMAIL, {
      rows: [{ employeeId: EMP, workDate: "2026-07-16", hours: 8 }],
    } as never);

    const [row] = rpcPayload(calls, "hr_upsert_work_hours_batch");
    expect(row.hours).toBe(8);
    expect(row.absence_code).toBeNull();
    expect(row.field_subtype).toBeNull();
    expect(row.two_machine_hours).toBe(0);
    expect(row.note).toBe("");
  });

  // ── 2) + 3) payroll recompute: praznici i devizne dnevnice ────────────────

  const payrollTx = () => {
    const calls: SqlLike[] = [];
    const holidayFindMany = jest.fn().mockResolvedValue([]);
    return {
      calls,
      holidayFindMany,
      tx: {
        $queryRaw: jest.fn(async (sql: SqlLike) => {
          calls.push(sql);
          const t = sqlText(sql);
          if (t.includes("FROM salary_payroll")) {
            // Postojeći red sa init-snapshot stopama dnevnica.
            return [
              {
                id: "row-1",
                status: "draft",
                advance_amount: 0,
                domestic_days: 0,
                foreign_days: 0,
                per_diem_rsd: 2000,
                per_diem_eur: 30,
                apo: null,
                fpo: null,
                u: "2026-07-01 00:00:00.000001+00",
              },
            ];
          }
          if (t.includes("FROM salary_terms")) {
            return [
              {
                salary_type: "fiksno",
                fixed_amount: 100000,
                compensation_model: "fiksno",
                terrain_domestic_rate: 2000,
                terrain_foreign_rate: 30,
              },
            ];
          }
          return [{ v: { applied: true } }];
        }),
        $executeRaw: jest.fn(),
        kadrHoliday: { findMany: holidayFindMany },
        employee: {
          findMany: jest.fn().mockResolvedValue([
            { id: EMP, workType: "ugovor", hireDate: null, fullName: "Test Radnik" },
          ]),
          findFirst: jest.fn().mockResolvedValue({ workType: "ugovor", hireDate: null }),
        },
        workHours: {
          findMany: jest.fn().mockResolvedValue([
            // 3 dana inostranog terena
            ...[10, 11, 12].map((d) => ({
              workDate: new Date(`2026-07-${d}T00:00:00Z`),
              hours: 8,
              overtimeHours: 0,
              twoMachineHours: 0,
              absenceCode: null,
              absenceSubtype: null,
              fieldHours: 8,
              fieldSubtype: "foreign",
            })),
          ]),
        },
      },
    };
  };

  it("praznik sa is_workday=true se NE broji kao neradni (filter u upitu)", async () => {
    const { tx, holidayFindMany } = payrollTx();
    await mkService(tx).payrollRecompute(EMAIL, {
      year: 2026,
      month: 7,
      persist: false,
    } as never);

    expect(holidayFindMany).toHaveBeenCalled();
    const where = holidayFindMany.mock.calls[0][0].where;
    expect(where.isWorkday).toBe(false);
  });

  it("„Obračunaj iz grida” upisuje foreign_days i per_diem_eur (devizne dnevnice)", async () => {
    const { tx, calls } = payrollTx();
    await mkService(tx).payrollRecompute(EMAIL, {
      year: 2026,
      month: 7,
      persist: true,
    } as never);

    const [row] = rpcPayload(calls, "hr_upsert_salary_payroll");
    // Bez ovih kolona trigger računa total_eur iz nedirnutih vrednosti → 0.
    expect(row.foreign_days).toBe(3);
    expect(row.domestic_days).toBe(0);
    expect(row.per_diem_eur).toBe(30); // 3 × 30 = 90 EUR (trigger)
    expect(row.per_diem_rsd).toBe(2000);
    // 1.0 paritet: hours_worked = REDOVNI sati (payslip satničara).
    expect(row).toHaveProperty("hours_worked");
    // Datumi isplate i optimistic token se i dalje prenose (CRITICAL #2).
    expect(row.id).toBe("row-1");
  });

  // ── 4) upload dokumenta: uploaded_by mora biti postavljen ─────────────────

  it("upload dokumenta postavlja uploaded_by iz auth.uid() (INSERT politika)", async () => {
    const create = jest.fn().mockResolvedValue({
      id: "doc-1",
      employeeId: EMP,
      docType: "ugovor",
      fileName: "a.pdf",
      storagePath: "p",
      mimeType: "application/pdf",
      sizeBytes: BigInt(10),
      description: null,
      uploadedAt: new Date(),
    });
    const tx = {
      $queryRaw: jest.fn(async () => [{ v: "auth-uid-1" }]),
      $executeRaw: jest.fn(),
      employeeDocument: { create },
    };
    await mkService(tx).uploadEmployeeDocument(
      EMAIL,
      EMP,
      { docType: "ugovor" } as never,
      {
        originalname: "a.pdf",
        mimetype: "application/pdf",
        size: 10,
        buffer: Buffer.from("x"),
      } as never,
    );

    expect(create).toHaveBeenCalled();
    expect(create.mock.calls[0][0].data.uploadedBy).toBe("auth-uid-1");
  });
});
