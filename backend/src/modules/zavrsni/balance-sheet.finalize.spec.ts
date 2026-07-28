/**
 * FINALIZACIJA OBRAČUNA — testovi kapije i traga forsiranja.
 * =========================================================================
 * ZAŠTO POSTOJI OVAJ FAJL: drugi krug nezavisnog pregleda (28.07.2026) je mutacionim
 * testom pokazao da za `finalizeStatement` NIJE postojao nijedan test — obe mutacije
 * su preživele pun paket od 2.644 testa:
 *   • M4  — `controls.filter(isBlockingFailure)` vraćeno na `filter(c => !c.passed)`,
 *           tj. ukinuta cela semantika „upozorenje ne blokira": 57/57 prošlo;
 *   • M4b — `if (forced)` zamenjeno sa `if (false)`, tj. trag forsiranja se NIKAD ne
 *           upisuje: 57/57 prošlo.
 * Paket je i nastao zato što `force=true` nije ostavljao trag — pa taj trag mora imati
 * test, inače ga sledeći refaktor tiho izgubi.
 */

import { Prisma } from "@prisma/client";
import {
  BalanceSheetService,
  StatementControlsFailedException,
  StatementAlreadyFinalizedException,
} from "./balance-sheet.service";
import type { ControlResult } from "./control-rules.service";
import { STATEMENT_TYPE } from "./statement-type";

/** Kontrolni rezultat sa podrazumevanim poljima — test menja samo ono što meri. */
function control(
  over: Partial<ControlResult> & { code: string },
): ControlResult {
  const status = over.status ?? "PROLAZI";
  return {
    name: over.name ?? over.code,
    kind: over.kind ?? "UKRSNA",
    valueKind: over.valueKind ?? "IZNOS",
    left: over.left ?? "0.0000",
    right: over.right ?? "0.0000",
    diff: over.diff ?? "0.0000",
    blocking: over.blocking ?? true,
    message: over.message ?? null,
    details: over.details ?? [],
    ...over,
    status,
    passed: status === "PROLAZI",
  };
}

interface Created {
  statementId: number;
  forcedByUserId: number | null;
  forcedByEmail: string | null;
  failedRules: Array<{ code: string }>;
  reason: string | null;
}

/** Prisma dovoljna za `finalizeStatement`: nalaz obračuna, CAS update, upis traga. */
function harness(opts: {
  controls: ControlResult[];
  status?: string;
  updateCount?: number;
  userEmail?: string | null;
}) {
  const created: Created[] = [];
  const updates: Array<Record<string, unknown>> = [];
  const tx = {
    financialStatement: {
      // eslint-disable-next-line @typescript-eslint/require-await
      updateMany: async (args: { data: Record<string, unknown> }) => {
        updates.push(args.data);
        return { count: opts.updateCount ?? 1 };
      },
    },
    statementControlOverride: {
      // eslint-disable-next-line @typescript-eslint/require-await
      create: async (args: { data: Created }) => {
        created.push(args.data);
        return args.data;
      },
    },
  };
  const prisma = {
    financialStatement: {
      // eslint-disable-next-line @typescript-eslint/require-await
      findUnique: async () => ({
        id: 10,
        statementType: STATEMENT_TYPE.BALANCE_SHEET,
        periodYear: 2026,
        status: opts.status ?? "DRAFT",
      }),
    },
    user: {
      // eslint-disable-next-line @typescript-eslint/require-await
      findUnique: async () => ({
        email: opts.userEmail ?? "nesa@servoteh.com",
      }),
    },
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  };
  const controlRules = {
    // eslint-disable-next-line @typescript-eslint/require-await
    evaluateControls: async () => opts.controls,
  };
  const service = new BalanceSheetService(
    prisma as never,
    {} as never,
    controlRules as never,
  );
  return { service, created, updates };
}

describe("finalizeStatement — šta blokira, a šta samo upozorava", () => {
  it("sve prolazi → finalizuje bez force i BEZ traga", async () => {
    const { service, created, updates } = harness({
      controls: [control({ code: "BS_GK_SAGLASNOST" })],
    });
    const res = await service.finalizeStatement(10);
    expect(res.status).toBe("FINALIZED");
    expect(res.forced).toBe(false);
    expect(created).toHaveLength(0);
    expect(updates[0].status).toBe("FINALIZED");
  });

  it("UPOZORENJE (neuravnotežen izvor, odsecanje) NE blokira i NE traži force", async () => {
    // Ovo je stvarno stanje na uvezenoj BigBit knjizi: dva pravila sa passed=false
    // a blocking=false. Ranije je ekran zbog njih slao force=true na SVAKU
    // finalizaciju, a mutacija koja bi ih vratila u „blokira" nije padala nigde.
    const { service, created } = harness({
      controls: [
        control({
          code: "GK_URAVNOTEZENA",
          status: "UPOZORENJE",
          blocking: false,
        }),
        control({
          code: "ODSECANJE_NA_NULU",
          status: "UPOZORENJE",
          blocking: false,
        }),
        control({ code: "BS_GK_SAGLASNOST" }),
      ],
    });
    const res = await service.finalizeStatement(10);
    expect(res.forced).toBe(false);
    expect(res.warnings).toEqual(["GK_URAVNOTEZENA", "ODSECANJE_NA_NULU"]);
    expect(created).toHaveLength(0);
  });

  it("NEPRIMENLJIVO koje ne blokira (pre zaključnog naloga) ne traži force", async () => {
    const { service, created } = harness({
      controls: [
        control({
          code: "BS_AKTIVA_PASIVA",
          status: "NEPRIMENLJIVO",
          blocking: false,
        }),
      ],
    });
    const res = await service.finalizeStatement(10);
    expect(res.forced).toBe(false);
    expect(created).toHaveLength(0);
  });

  it("PADA blokirajućeg pravila bez force → odbijena finalizacija", async () => {
    const { service, updates } = harness({
      controls: [
        control({ code: "BS_GK_SAGLASNOST", status: "PADA", blocking: true }),
      ],
    });
    await expect(service.finalizeStatement(10)).rejects.toBeInstanceOf(
      StatementControlsFailedException,
    );
    expect(updates).toHaveLength(0); // status se NIJE promenio
  });

  it("blokirajuće NEPRIMENLJIVO (nedostaje AOP) takođe odbija finalizaciju", async () => {
    const { service } = harness({
      controls: [
        control({
          code: "BS_GK_SAGLASNOST",
          status: "NEPRIMENLJIVO",
          blocking: true,
        }),
      ],
    });
    await expect(service.finalizeStatement(10)).rejects.toBeInstanceOf(
      StatementControlsFailedException,
    );
  });
});

describe("finalizeStatement — trag forsiranja", () => {
  it("force upisuje KO, KADA, ŠTA je palo i ZAŠTO — u istoj transakciji", async () => {
    const { service, created, updates } = harness({
      controls: [
        control({
          code: "BS_GK_SAGLASNOST",
          status: "PADA",
          blocking: true,
          left: "100.0000",
          right: "40.0000",
        }),
        control({
          code: "GK_URAVNOTEZENA",
          status: "UPOZORENJE",
          blocking: false,
        }),
      ],
    });
    const res = await service.finalizeStatement(10, {
      force: true,
      userId: 7,
      reason: "predaja APR-u istog dana",
    });
    expect(res.forced).toBe(true);
    expect(res.forcedRules).toEqual(["BS_GK_SAGLASNOST"]);
    expect(updates[0].status).toBe("FINALIZED");
    expect(created).toHaveLength(1);
    expect(created[0].statementId).toBe(10);
    expect(created[0].forcedByUserId).toBe(7);
    expect(created[0].forcedByEmail).toBe("nesa@servoteh.com");
    expect(created[0].reason).toBe("predaja APR-u istog dana");
    expect(created[0].failedRules.map((f) => f.code)).toEqual([
      "BS_GK_SAGLASNOST",
    ]);
  });

  it("force kad ništa ne blokira NE upisuje trag (nije bilo šta da se pregazi)", async () => {
    const { service, created } = harness({
      controls: [
        control({
          code: "GK_URAVNOTEZENA",
          status: "UPOZORENJE",
          blocking: false,
        }),
      ],
    });
    const res = await service.finalizeStatement(10, { force: true, userId: 7 });
    expect(res.forced).toBe(false);
    expect(created).toHaveLength(0);
  });

  it("trka na finalizaciji (CAS count=0) baca Conflict i ne ostavlja trag", async () => {
    const { service, created } = harness({
      controls: [
        control({ code: "BS_GK_SAGLASNOST", status: "PADA", blocking: true }),
      ],
      updateCount: 0,
    });
    await expect(
      service.finalizeStatement(10, { force: true, userId: 7 }),
    ).rejects.toBeInstanceOf(StatementAlreadyFinalizedException);
    expect(created).toHaveLength(0);
  });

  it("već finalizovan obračun se ne finalizuje ponovo", async () => {
    const { service } = harness({
      controls: [control({ code: "BS_GK_SAGLASNOST" })],
      status: "FINALIZED",
    });
    await expect(service.finalizeStatement(10)).rejects.toBeInstanceOf(
      StatementAlreadyFinalizedException,
    );
  });
});

/** Decimal se ovde ne koristi, ali uvoz drži pravilo „novac je Decimal" vidljivim. */
void Prisma;
