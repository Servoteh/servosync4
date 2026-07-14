import { ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma-sy15/client";
import {
  EnergetikaService,
  genIdempotencyKey,
} from "./energetika.service";
import type { Sy15Service } from "../../common/sy15/sy15.service";
import type { SendCommandDto } from "./dto/send-command.dto";

/**
 * Unit — R2 komandni sloj (MODULE_SPEC_scada_30.md §3, komandna semantika ZAMRZNUTA).
 * Fokus: NATIVNI `idempotency_key` mehanizam + `requested_by` iz claims (RLS WITH CHECK
 * paritet). Sy15Service je mokovan (bez sy15 baze) — presrećemo `withUserRls` da uhvatimo
 * tačan `data` koji ide u `scadaCommand.create` (odnosno RPC argument za cancel).
 */
describe("EnergetikaService — komande (R2)", () => {
  /** Mok koji hvata create `data`; withUserRls prosleđuje fake tx i beleži email. */
  function makeCreateHarness() {
    const created: Record<string, unknown>[] = [];
    const calls: { email: string }[] = [];
    const tx = {
      scadaCommand: {
        create: jest.fn(
          async ({ data }: { data: Record<string, unknown> }) => {
            created.push(data);
            return { id: "row-uuid", status: "pending", ...data };
          },
        ),
      },
    };
    const sy15 = {
      withUserRls: jest.fn(
        (email: string, fn: (t: typeof tx) => Promise<unknown>) => {
          calls.push({ email });
          return fn(tx);
        },
      ),
    } as unknown as Sy15Service;
    return { service: new EnergetikaService(sy15), created, calls, tx, sy15 };
  }

  const baseDto = (over: Partial<SendCommandDto> = {}): SendCommandDto => ({
    siteKey: "kot1",
    target: "SP_CNC",
    value: { v: 22 },
    ...over,
  });

  describe("create — requested_by + idempotency_key", () => {
    it("requested_by = lowercased email iz claims (RLS WITH CHECK paritet, NE sub/uid)", async () => {
      const h = makeCreateHarness();
      await h.service.create("Nenad.Jarakovic@Servoteh.com", baseDto());
      expect(h.created[0].requestedBy).toBe("nenad.jarakovic@servoteh.com");
      // withUserRls dobija ORIGINALNI email (setClaims traži auth.users po lower(email)).
      expect(h.calls[0].email).toBe("Nenad.Jarakovic@Servoteh.com");
    });

    it("bez clientEventId → generisan `ui-<ts>-<rand>` idempotency_key", async () => {
      const h = makeCreateHarness();
      await h.service.create("a@b.com", baseDto());
      expect(String(h.created[0].idempotencyKey)).toMatch(
        /^ui-\d+-[a-z0-9]{1,8}$/,
      );
    });

    it("clientEventId prosleđen → koristi se kao idempotency_key (nema regeneracije)", async () => {
      const h = makeCreateHarness();
      await h.service.create(
        "a@b.com",
        baseDto({ clientEventId: "ui-1751800000000-abc123" }),
      );
      expect(h.created[0].idempotencyKey).toBe("ui-1751800000000-abc123");
    });

    it("prazan/space clientEventId → padne na generisan ključ (trim)", async () => {
      const h = makeCreateHarness();
      await h.service.create("a@b.com", baseDto({ clientEventId: "   " }));
      expect(String(h.created[0].idempotencyKey)).toMatch(/^ui-\d+-/);
    });

    it("op default 'set' kad se izostavi (1.0 paritet)", async () => {
      const h = makeCreateHarness();
      await h.service.create(
        "a@b.com",
        baseDto({ target: "RESET_VFD", op: undefined }),
      );
      expect(h.created[0].op).toBe("set");
    });

    it("status/result/claimed_at/applied_at se NE šalju (Prisma @default + WITH CHECK NULL-ovi)", async () => {
      const h = makeCreateHarness();
      await h.service.create("a@b.com", baseDto());
      const d = h.created[0];
      expect(d.status).toBeUndefined();
      expect(d.result).toBeUndefined();
      expect(d.claimedAt).toBeUndefined();
      expect(d.appliedAt).toBeUndefined();
    });

    it("van-allowlist target (Web_Estop) NIJE blokiran na BE — ulazi kao value pass-through (bridge odbija)", async () => {
      const h = makeCreateHarness();
      await h.service.create(
        "a@b.com",
        baseDto({ siteKey: "kot2", target: "Web_Estop", value: { v: 1 } }),
      );
      // BE samo upiše red; NE presuđuje allowlist (spec §2 t.6 — bridge je autoritet).
      expect(h.created[0].target).toBe("Web_Estop");
      expect(h.created[0].value).toEqual({ v: 1 });
    });

    it("izostavljen value → nije u `data` (kolona ostaje SQL NULL — paritet reset targeta)", async () => {
      const h = makeCreateHarness();
      await h.service.create(
        "a@b.com",
        baseDto({ target: "RESET_VFD", value: undefined }),
      );
      expect("value" in h.created[0]).toBe(false);
    });
  });

  describe("create — Prisma/SQLSTATE greška → HTTP semantika", () => {
    /** Servis čiji `scadaCommand.create` odbija zadatom greškom (kroz withUserRls). */
    function makeThrowingService(err: unknown): EnergetikaService {
      const tx = {
        scadaCommand: {
          create: jest.fn(async () => {
            throw err;
          }),
        },
      };
      const sy15 = {
        withUserRls: jest.fn(
          (email: string, fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
        ),
      } as unknown as Sy15Service;
      return new EnergetikaService(sy15);
    }

    it("dupli idempotency_key (TYPED create → P2002 top-level, BEZ meta.code) → 409 ConflictException, NE 500", async () => {
      // Prisma za TYPED operaciju (tx.scadaCommand.create) baca ovaj oblik: `.code`
      // je TOP-LEVEL, ne `meta.code` (za razliku od raw $queryRaw/RPC = P2010 sa
      // meta.code='23505'). Bez P2002 grane u rethrowSy15 → sirov 500 (regresija).
      const p2002 = new Prisma.PrismaClientKnownRequestError(
        "Unique constraint failed on the fields: (`idempotency_key`)",
        { code: "P2002", clientVersion: "6" },
      );
      const service = makeThrowingService(p2002);
      await expect(
        service.create("a@b.com", baseDto({ clientEventId: "ui-dup-123" })),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it("raw put (P2010 sa meta.code='23505') → i dalje 409 (ne regresirati postojeći oblik)", async () => {
      const raw = Object.assign(new Error("duplicate key value"), {
        meta: { code: "23505", message: "duplicate key value" },
      });
      const service = makeThrowingService(raw);
      await expect(
        service.create("a@b.com", baseDto()),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe("cancel — scada_cancel_command kroz withUserRls", () => {
    it("vraća STVARNI status koji RPC vrati (paritet: applied ako je bridge stigao)", async () => {
      const queryRaw = jest.fn(async () => [{ status: "applied" }]);
      const tx = { $queryRaw: queryRaw };
      const sy15 = {
        withUserRls: jest.fn(
          (email: string, fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
        ),
      } as unknown as Sy15Service;
      const service = new EnergetikaService(sy15);
      const out = await service.cancel(
        "a@b.com",
        "3b241101-e2bb-4255-8caf-4136c566a962",
      );
      expect(out).toEqual({ status: "applied" });
      expect(sy15.withUserRls).toHaveBeenCalledWith(
        "a@b.com",
        expect.any(Function),
      );
      expect(queryRaw).toHaveBeenCalledTimes(1);
    });

    it("nepostojeći red → RPC vrati 'missing' (NE 404 — nije greška toka)", async () => {
      const tx = { $queryRaw: jest.fn(async () => [] as { status: string }[]) };
      const sy15 = {
        withUserRls: jest.fn(
          (email: string, fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
        ),
      } as unknown as Sy15Service;
      const out = await new EnergetikaService(sy15).cancel(
        "a@b.com",
        "3b241101-e2bb-4255-8caf-4136c566a962",
      );
      expect(out).toEqual({ status: "missing" });
    });
  });

  describe("genIdempotencyKey", () => {
    it("format `ui-<ts>-<rand>` i praktično jedinstven po pozivu", () => {
      const a = genIdempotencyKey();
      const b = genIdempotencyKey();
      expect(a).toMatch(/^ui-\d+-[a-z0-9]{1,8}$/);
      expect(a).not.toBe(b);
    });
  });
});
