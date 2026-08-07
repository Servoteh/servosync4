import { ServiceUnavailableException } from "@nestjs/common";
import { SY15_TOOLS } from "./sy15-tools";
import type { ToolCtx, ToolDeps } from "./tool-registry";
import type { OdrzavanjeFnService } from "../../odrzavanje/odrzavanje-fn.service";
import type { OdrzavanjeSourceService } from "../../../common/sy15/odrzavanje-source.service";

/**
 * 🔴 ŠAV AI-ASISTENT -> ODRŽAVANJE (`ai_chat_prijavi_kvar`).
 *
 * Ovo je JEDINI upis AI-chata u tuđi domen (`INSERT INTO maint_incidents`).
 * Da je ostao u sy15 dok modul piše u 3.0, nastale bi DVE ISTINE O KVAROVIMA —
 * i to se ne bi videlo dok se brojevi ne raziđu, jer bi oba puta „radila".
 * Zato je ovde pinovano da izvor upisa prati `ODRZAVANJE_IZVOR`.
 */

const alat = SY15_TOOLS.find((t) => t.name === "prijavi_kvar")!;

function ctx(over: Partial<ToolDeps> = {}, email = "n@x"): ToolCtx {
  const deps = {
    sy15: {
      withUserRls: jest.fn(async (_e: string, fn: (tx: unknown) => unknown) =>
        fn({ $queryRaw: async () => [{ result: { ok: true, izvor: "sy15" } }] }),
      ),
    },
    ai: {},
    prisma: { user: { findFirst: async () => ({ id: 42 }) } },
    kadrovska: {},
    ...over,
  } as unknown as ToolDeps;
  return { email, permissions: new Set() as never, deps };
}

/** Stub prekidača — `assertPorted` se ponaša tačno kao `IzvorPrekidac`. */
function prekidac(tri: boolean): OdrzavanjeSourceService {
  return {
    isThreeZero: tri,
    assertPorted(feature: string) {
      if (tri) throw new ServiceUnavailableException(feature);
    },
  } as unknown as OdrzavanjeSourceService;
}

const NA_3_0 = prekidac(true);
const NA_SY15 = prekidac(false);

const ARG = {
  masina: "3.12",
  naslov: "Ne pali",
  opis: "Od jutros",
  ozbiljnost: "critical",
  bezbednosni_rizik: true,
};

describe("prijavi_kvar — izvor upisa prati ODRZAVANJE_IZVOR", () => {
  it("pod `sy15` ide kroz `ai_chat_prijavi_kvar` RPC (nepromenjeno)", async () => {
    const c = ctx({ odrzavanjeIzvor: NA_SY15 });
    const out = await alat.execute(ARG, c);
    expect(out).toEqual({ ok: true, izvor: "sy15" });
    expect(c.deps.sy15.withUserRls).toHaveBeenCalled();
  });

  it("🔴 pod `3.0` upisuje u 3.0 bazu i NE dodiruje sy15", async () => {
    const fn = {
      aiPrijaviKvar: jest.fn().mockResolvedValue({ ok: true, incident_id: "I1" }),
    } as unknown as OdrzavanjeFnService;
    const c = ctx({ odrzavanjeIzvor: NA_3_0, odrzavanjeFn: fn });
    const out = await alat.execute(ARG, c);
    expect(out).toEqual({ ok: true, incident_id: "I1" });
    expect(c.deps.sy15.withUserRls).not.toHaveBeenCalled();
    expect(fn.aiPrijaviKvar).toHaveBeenCalledWith(42, {
      masina: "3.12",
      naslov: "Ne pali",
      opis: "Od jutros",
      ozbiljnost: "critical",
      bezbednosniRizik: true,
    });
  });

  it("🔴 bez prepisa (nema servisa) pada na 503 — NE piše u sy15 „za svaki slučaj”", async () => {
    const c = ctx({ odrzavanjeIzvor: NA_3_0 });
    await expect(alat.execute(ARG, c)).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(c.deps.sy15.withUserRls).not.toHaveBeenCalled();
  });

  it("nalog bez parnjaka u 3.0 `users` daje `nema_prava`, a ne 500", async () => {
    const fn = {
      aiPrijaviKvar: jest.fn(),
    } as unknown as OdrzavanjeFnService;
    const c = ctx({
      odrzavanjeIzvor: NA_3_0,
      odrzavanjeFn: fn,
      prisma: { user: { findFirst: async () => null } } as never,
    });
    const out = (await alat.execute(ARG, c)) as { error: string };
    expect(out.error).toBe("nema_prava");
    expect(fn.aiPrijaviKvar).not.toHaveBeenCalled();
  });

  it("bez prekidača ostaje na sy15 (bezbedan smer)", async () => {
    const c = ctx();
    const out = await alat.execute(ARG, c);
    expect(out).toEqual({ ok: true, izvor: "sy15" });
  });
});

describe("ostala 4 maint alata i dalje padaju na 503 pod `3.0` (blokada 8)", () => {
  it.each(["masina_info", "kvar_istorija", "trosak_sredstva"])(
    "%s",
    async (ime) => {
      const t = SY15_TOOLS.find((x) => x.name === ime)!;
      // Neki alati bacaju sinhrono (brana je prva linija), neki kroz `async`.
      // Omotač hvata oba, a `rejects` ne ostavlja neuhvaćeno odbijanje.
      await expect(
        (async () =>
          t.execute(
            { masina: "3.12", sredstvo: "3.12" },
            ctx({ odrzavanjeIzvor: NA_3_0 }),
          ))(),
      ).rejects.toThrow(ServiceUnavailableException);
    },
  );
});
