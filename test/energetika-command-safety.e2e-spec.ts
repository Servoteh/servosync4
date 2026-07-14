import {
  ExecutionContext,
  ValidationPipe,
  VERSION_NEUTRAL,
  VersioningType,
} from "@nestjs/common";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { Prisma } from "@prisma-sy15/client";
import { JwtAuthGuard } from "../src/modules/auth/jwt-auth.guard";
import { EnergetikaController } from "../src/modules/energetika/energetika.controller";
import { EnergetikaService } from "../src/modules/energetika/energetika.service";
import { Sy15Service } from "../src/common/sy15/sy15.service";

/**
 * SAFETY e2e — komandni lanac BEZ DODIRA PLC-a (MODULE_SPEC_scada_30.md §5 stavka 17, R2).
 *
 * Vežba CEO lanac za van-allowlist target: HTTP POST → DTO → guard(energetika.control) →
 * `withUserRls` INSERT (`pending`) → **(neportovani) bridge preuzme i ODBIJE bez ijednog
 * PLC upisa**. Dokazuje bezbednosnu invarijantu firme (živi kotlovi): 2.0 BE NIKAD ne piše
 * na PLC — jedina komandna akcija je INSERT `pending`; izvršenje/odbijanje je 100% bridge.
 *
 * ⚠️ Bridge OSTAJE na ubuntusrv (systemd), NIJE portovan (semantika ZAMRZNUTA, doktrina §C).
 * Ovde je `bridgeStub` TEST DOUBLE koji verno ogleda 1.0 `bridge/src/scada/allowlist.js`
 * (validateCommand: kot2 `Web_Estop` van allowlist-a, setpoint 10–30) + `scadaCommands.js`
 * (claim → validate → exec|reject). `plcWrite` je jedini „dodir PLC-a" — spy dokazuje da za
 * van-allowlist targete NIJE pozvan nijednom.
 */

// ---- In-memory sy15 (scada_commands) sa RLS WITH CHECK paritetom ----
interface CmdRow {
  id: string;
  siteKey: string;
  target: string;
  op: string;
  value: Record<string, unknown> | null;
  status: string;
  requestedBy: string;
  idempotencyKey: string | null;
  claimedAt: Date | null;
  appliedAt: Date | null;
  result: Record<string, unknown> | null;
}

class FakeSy15 {
  rows: CmdRow[] = [];
  reset() {
    this.rows.length = 0;
  }
  // Ogledalo Sy15Service.withUserRls: SET LOCAL ROLE authenticated → RLS se evaluira.
  async withUserRls<T>(
    email: string,
    fn: (tx: unknown) => Promise<T>,
  ): Promise<T> {
    const tx = {
      scadaCommand: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          // scada_cmd_insert WITH CHECK: svoje ime + pending + null-ovi.
          if (data.requestedBy !== email.toLowerCase()) {
            throw sqlErr(
              "42501",
              "new row violates row-level security policy",
            );
          }
          // scada_commands_idem: partial unique na idempotency_key. TYPED Prisma
          // create baca PrismaClientKnownRequestError sa TOP-LEVEL `.code='P2002'`
          // (NE `meta.code='23505'` kao raw $queryRaw) — verni oblik da e2e dokaže
          // da rethrowSy15 mapira P2002 → 409 (a ne sirov 500).
          const key = data.idempotencyKey as string | undefined;
          if (key && this.rows.some((r) => r.idempotencyKey === key)) {
            throw new Prisma.PrismaClientKnownRequestError(
              "Unique constraint failed on the fields: (`idempotency_key`)",
              { code: "P2002", clientVersion: "6" },
            );
          }
          const row: CmdRow = {
            id: `cmd-${this.rows.length + 1}`,
            status: "pending", // DB @default (BE ga ne šalje)
            claimedAt: null,
            appliedAt: null,
            result: null,
            value: null,
            op: "set",
            idempotencyKey: null,
            requestedBy: "",
            siteKey: "",
            target: "",
            ...(data as Partial<CmdRow>),
          };
          this.rows.push(row);
          return row;
        },
      },
    };
    return fn(tx);
  }
}

function sqlErr(code: string, message: string): Error & { meta: object } {
  const e = new Error(message) as Error & { meta: { code: string; message: string } };
  e.meta = { code, message };
  return e;
}

// ---- Bridge TEST DOUBLE (ogledalo 1.0 allowlist.js — NE portuje se) ----
type PlcWrite = jest.Mock<Promise<unknown>, [string, string, unknown]>;

/** validateCommand ogledalo: samo pravila potrebna za safety dokaz (kot2). */
function validate(
  cmd: CmdRow,
): { ok: true } | { ok: false; reason: string } {
  const v = (cmd.value ?? {}) as { v?: unknown };
  if (cmd.siteKey === "kot2") {
    if (cmd.target === "Zeljena_temperatura") {
      const n = Number(v.v);
      return n >= 10 && n <= 30
        ? { ok: true }
        : { ok: false, reason: "Zeljena_temperatura mora 10–30 °C" };
    }
    if (cmd.target === "Web_Estop") {
      // NAMERNO van allowlist-a (bezbednost) — nikad iz clouda.
      return {
        ok: false,
        reason: "Daljinski E-stop nije dozvoljen iz clouda (samo lokalno)",
      };
    }
    return { ok: false, reason: `kot2: tag '${cmd.target}' nije u allowlist-u` };
  }
  if (cmd.siteKey === "solar-kaco") {
    // read-only (blue'Log nema kontrolni API) → nema validatora → odbij.
    return { ok: false, reason: "solar-kaco: read-only sistem" };
  }
  return { ok: false, reason: `sistem '${cmd.siteKey}' nema dozvoljene komande` };
}

/** scadaCommandsOnce ogledalo: claim → validate → exec(plcWrite)|reject. */
async function bridgeStubCycle(
  store: FakeSy15,
  plcWrite: PlcWrite,
): Promise<{ applied: number; rejected: number }> {
  let applied = 0;
  let rejected = 0;
  for (const cmd of store.rows) {
    if (cmd.status !== "pending") continue;
    cmd.status = "claimed"; // scada_claim_commands: pending → claimed
    cmd.claimedAt = new Date();
    const check = validate(cmd);
    if (!check.ok) {
      cmd.status = "rejected";
      cmd.result = { error: check.reason };
      rejected += 1;
      continue; // ⚠️ NIJEDAN PLC upis za van-allowlist
    }
    await plcWrite(cmd.siteKey, cmd.target, cmd.value); // JEDINI dodir PLC-a
    cmd.status = "applied";
    cmd.appliedAt = new Date();
    cmd.result = { ok: true };
    applied += 1;
  }
  return { applied, rejected };
}

describe("Energetika SAFETY e2e — van-allowlist → rejected BEZ dodira PLC-a", () => {
  let app: INestApplication;
  const fake = new FakeSy15();

  const postCmd = (role: string, body: string | object) =>
    request(app.getHttpServer())
      .post("/api/v1/energetika/commands")
      .set("x-test-role", role)
      .send(body);

  beforeAll(async () => {
    process.env.AUTHZ_ENFORCE = "true";
    const moduleRef = await Test.createTestingModule({
      controllers: [EnergetikaController],
      providers: [
        EnergetikaService,
        { provide: Sy15Service, useValue: fake },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate(ctx: ExecutionContext) {
          const req = ctx.switchToHttp().getRequest<{
            headers: Record<string, string>;
            user?: unknown;
          }>();
          const role = req.headers["x-test-role"];
          if (!role) return false;
          req.user = { userId: 1, email: "sef.pogona@servoteh.com", role };
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("api");
    app.enableVersioning({
      type: VersioningType.URI,
      defaultVersion: VERSION_NEUTRAL,
    });
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.AUTHZ_ENFORCE;
  });

  beforeEach(() => fake.reset());

  it("kot2 `Web_Estop` (E-stop van allowlist-a): POST→pending, bridge→rejected, PLC NETAKNUT", async () => {
    const plcWrite: PlcWrite = jest.fn();

    // 1) HTTP POST (control rola) → BE upiše `pending` i NE presuđuje allowlist sam.
    const res = await postCmd("admin", {
      siteKey: "kot2",
      target: "Web_Estop",
      value: { v: 1 },
    }).expect(200);
    expect(res.body.status).toBe("pending");
    expect(fake.rows).toHaveLength(1);

    // 2) (neportovani) bridge preuzme → rejected, BEZ ijednog PLC upisa.
    const out = await bridgeStubCycle(fake, plcWrite);
    expect(out.applied).toBe(0);
    expect(out.rejected).toBe(1);
    expect(plcWrite).not.toHaveBeenCalled(); // ⚠️ ključna bezbednosna invarijanta
    expect(fake.rows[0].status).toBe("rejected");
    expect(String(fake.rows[0].result?.error)).toMatch(/E-stop/i);
  });

  it("kot2 nepoznat tag + solar-kaco (read-only): oba rejected, PLC NETAKNUT", async () => {
    const plcWrite: PlcWrite = jest.fn();
    await postCmd("menadzment", {
      siteKey: "kot2",
      target: "Web_Nuke",
      value: { v: 1 },
    }).expect(200);
    await postCmd("menadzment", {
      siteKey: "solar-kaco",
      target: "shutdown",
      value: { v: 1 },
    }).expect(200);

    const out = await bridgeStubCycle(fake, plcWrite);
    expect(out.applied).toBe(0);
    expect(out.rejected).toBe(2);
    expect(plcWrite).not.toHaveBeenCalled();
    expect(fake.rows.every((r) => r.status === "rejected")).toBe(true);
  });

  it("POZITIVNA KONTROLA: allowlisted setpoint (kot2 20 °C) → applied + PLC upis (spy je stvaran)", async () => {
    const plcWrite: PlcWrite = jest.fn().mockResolvedValue({ ok: true });
    await postCmd("admin", {
      siteKey: "kot2",
      target: "Zeljena_temperatura",
      value: { v: 20 },
    }).expect(200);

    const out = await bridgeStubCycle(fake, plcWrite);
    expect(out.applied).toBe(1);
    expect(plcWrite).toHaveBeenCalledTimes(1);
    expect(plcWrite).toHaveBeenCalledWith("kot2", "Zeljena_temperatura", {
      v: 20,
    });
    expect(fake.rows[0].status).toBe("applied");
  });

  it("dupli clientEventId (isti idempotency_key): prvi 200, drugi 409 — typed create P2002 → Conflict, NE 500", async () => {
    const body = {
      siteKey: "kot2",
      target: "Zeljena_temperatura",
      value: { v: 20 },
      clientEventId: "ui-1751800000000-dup",
    };
    await postCmd("admin", body).expect(200); // upisan `pending`
    await postCmd("admin", body).expect(409); // dupli ključ → ConflictException
    expect(fake.rows).toHaveLength(1); // drugi upis NIJE prošao (nema dvostrukog PLC toka)
  });

  it("requested_by = lowercased email iz claims (RLS WITH CHECK forsira svoje ime)", async () => {
    const plcWrite: PlcWrite = jest.fn();
    await postCmd("admin", {
      siteKey: "kot2",
      target: "Web_Estop",
      value: { v: 1 },
    }).expect(200);
    expect(fake.rows[0].requestedBy).toBe("sef.pogona@servoteh.com");
    expect(fake.rows[0].idempotencyKey).toMatch(/^ui-\d+-/);
    // safety: nijedan PLC dodir ni pri ovom scenariju (nije ni pokrenut ciklus izvršenja)
    expect(plcWrite).not.toHaveBeenCalled();
  });
});
