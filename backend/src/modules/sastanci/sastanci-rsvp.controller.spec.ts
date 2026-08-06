import { Logger } from "@nestjs/common";
import type { Response } from "express";
import { SastanciRsvpController } from "./sastanci-rsvp.controller";
import { SastanciSourceService } from "../../common/sy15/sastanci-source.service";
import type { PrismaService } from "../../prisma/prisma.service";

/**
 * Javni magic-link RSVP — 3.0 parnjak sy15 edge fn `sastanci-rsvp`.
 *
 * Testovi pinuju TRI stvari koje su u sy15 bile u telu edge funkcije, a sad su u
 * kodu, i svaka je već jednom bila izvor bag-a u ovom domenu:
 *   1) upis SAMO na potvrđen klik (`c=1`) — bez toga skener mejla potvrđuje
 *      dolazak umesto čoveka,
 *   2) nepoznat/loš token ne otkriva ništa i ne piše ništa,
 *   3) pod `SASTANCI_IZVOR=sy15` ruta NE SME da piše u 3.0 bazu (vlasnik je
 *      tada sy15; upis bi tiho razišao dve baze).
 * Uz to: `rsvp_token` nikad ne sme u log.
 */

const TOKEN = "3f1c0b7e-8a2d-4d1e-9b6a-0c5e7d2f4a11";
const FN_BASE = "https://api.servosync.servoteh.com/functions/v1";

function resMock() {
  const seen = {
    status: 0,
    headers: {} as Record<string, string>,
    body: "",
    redirect: null as string | null,
    ended: false,
  };
  const res = {
    status: jest.fn((s: number) => {
      seen.status = s;
      return res;
    }),
    setHeader: jest.fn((k: string, v: string) => {
      seen.headers[k] = v;
      return res;
    }),
    send: jest.fn((b: string) => {
      seen.body = b;
      return res;
    }),
    end: jest.fn(() => {
      seen.ended = true;
      return res;
    }),
    redirect: jest.fn((s: number, u: string) => {
      seen.status = s;
      seen.redirect = u;
      return res;
    }),
  } as unknown as Response;
  return { res, seen };
}

function make(izvor: "sy15" | "3.0", count = 1) {
  process.env.SASTANCI_IZVOR = izvor;
  const updateMany = jest.fn().mockResolvedValue({ count });
  const prisma = {
    sastanakUcesnik: { updateMany },
  } as unknown as PrismaService;
  const ctrl = new SastanciRsvpController(prisma, new SastanciSourceService());
  return { ctrl, updateMany };
}

const OLD_ENV = { ...process.env };
beforeEach(() => {
  process.env.SY15_FUNCTIONS_URL = FN_BASE;
  delete process.env.SASTANCI_IZVOR;
});
afterEach(() => {
  process.env = { ...OLD_ENV };
  jest.restoreAllMocks();
});

// ── 3.0: upis ───────────────────────────────────────────────────────────────

describe("3.0 — potvrđen klik upisuje odgovor", () => {
  it("važeći token + r=dolazim + c=1 upisuje rsvp_status i rsvp_at", async () => {
    const { ctrl, updateMany } = make("3.0");
    const { res, seen } = resMock();
    await ctrl.rsvp(TOKEN, "dolazim", "1", res);

    expect(updateMany).toHaveBeenCalledTimes(1);
    const arg = updateMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(arg.where).toEqual({ rsvpToken: TOKEN });
    expect(arg.data.rsvpStatus).toBe("dolazim");
    expect(arg.data.rsvpAt).toBeInstanceOf(Date);

    expect(seen.status).toBe(200);
    expect(seen.headers["Content-Type"]).toBe("text/html; charset=utf-8");
    expect(seen.body).toContain("Zabeleženo: Dolazim");
  });

  it("r=ne_dolazim upisuje 'ne_dolazim' i nudi obrnuti link", async () => {
    const { ctrl, updateMany } = make("3.0");
    const { res, seen } = resMock();
    await ctrl.rsvp(TOKEN, "ne_dolazim", "1", res);

    expect(
      (updateMany.mock.calls[0][0] as { data: { rsvpStatus: string } }).data
        .rsvpStatus,
    ).toBe("ne_dolazim");
    expect(seen.body).toContain("Zabeleženo: Ne dolazim");
    // „Predomislio si se" vodi na SUPROTAN odgovor, i to odmah potvrđen (c=1).
    expect(seen.body).toContain(`r=dolazim&amp;c=1`);
  });

  it("odgovor je HTML stranica za čoveka, ne JSON", async () => {
    const { ctrl } = make("3.0");
    const { res, seen } = resMock();
    await ctrl.rsvp(TOKEN, "dolazim", "1", res);
    expect(seen.body.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(seen.headers["Cache-Control"]).toBe("no-store");
  });
});

// ── 3.0: brana od skenera mejla ─────────────────────────────────────────────

describe("3.0 — bez c=1 nema upisa (skener mejla ne potvrđuje umesto čoveka)", () => {
  it("prvi GET iz pozivnice prikazuje stranu potvrde, BEZ upisa", async () => {
    const { ctrl, updateMany } = make("3.0");
    const { res, seen } = resMock();
    await ctrl.rsvp(TOKEN, "dolazim", undefined, res);

    expect(updateMany).not.toHaveBeenCalled();
    expect(seen.status).toBe(200);
    expect(seen.body).toContain("Potvrda dolaska");
    expect(seen.body).toContain("r=dolazim&amp;c=1");
  });

  it("HEAD (link-preview/antivirus) ne dira bazu i vraća prazan 200", () => {
    const { ctrl, updateMany } = make("3.0");
    const { res, seen } = resMock();
    ctrl.head(res);
    expect(updateMany).not.toHaveBeenCalled();
    expect(seen.status).toBe(200);
    expect(seen.ended).toBe(true);
    expect(seen.body).toBe("");
  });
});

// ── 3.0: nevažeći ulaz ──────────────────────────────────────────────────────

describe("3.0 — nevažeći ulaz ne otkriva ništa i ne piše ništa", () => {
  it("nepoznat token → neutralna poruka, 404, bez podataka o sastanku", async () => {
    const { ctrl, updateMany } = make("3.0", 0);
    const { res, seen } = resMock();
    await ctrl.rsvp(TOKEN, "dolazim", "1", res);

    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(seen.status).toBe(404);
    expect(seen.body).toContain("Ova potvrda više nije važeća");
    // Ništa o sastanku, učesniku ni o tome da li je token ikad postojao.
    expect(seen.body).not.toContain(TOKEN);
    expect(seen.body).not.toContain("@");
    expect(seen.body.toLowerCase()).not.toContain("sastanak_ucesnici");
  });

  it("token koji nije uuid ne stiže ni do baze (inače P2023 → 500)", async () => {
    const { ctrl, updateMany } = make("3.0");
    const { res, seen } = resMock();
    await ctrl.rsvp("nije-uuid", "dolazim", "1", res);

    expect(updateMany).not.toHaveBeenCalled();
    expect(seen.status).toBe(404);
    expect(seen.body).toContain("Ova potvrda više nije važeća");
  });

  it("nedozvoljena vrednost `r` se odbija pre ijednog upisa", async () => {
    for (const r of ["mozda", "maybe", "otkazano", "DOLAZIM", ""]) {
      const { ctrl, updateMany } = make("3.0");
      const { res, seen } = resMock();
      await ctrl.rsvp(TOKEN, r, "1", res);
      expect(updateMany).not.toHaveBeenCalled();
      expect(seen.status).toBe(400);
    }
  });

  it("`r` sme da izostane, ali tada nema ni upisa ni prikaza sastanka", async () => {
    const { ctrl, updateMany } = make("3.0");
    const { res, seen } = resMock();
    await ctrl.rsvp(TOKEN, undefined, "1", res);
    expect(updateMany).not.toHaveBeenCalled();
    expect(seen.status).toBe(400);
    expect(seen.body).toContain("Link je nepotpun");
  });

  it("bez tokena → 400, bez upisa", async () => {
    const { ctrl, updateMany } = make("3.0");
    const { res, seen } = resMock();
    await ctrl.rsvp("   ", "dolazim", "1", res);
    expect(updateMany).not.toHaveBeenCalled();
    expect(seen.status).toBe(400);
  });
});

// ── prekidač: pod sy15 se NE piše u 3.0 ─────────────────────────────────────

describe("prekidač SASTANCI_IZVOR — vlasnik podatka presuđuje", () => {
  it("🔴 pod `sy15` ruta NE PIŠE u 3.0 bazu", async () => {
    const { ctrl, updateMany } = make("sy15");
    const { res } = resMock();
    await ctrl.rsvp(TOKEN, "dolazim", "1", res);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("pod `sy15` klik ide na sy15 edge (vlasnik), sa NEPROMENJENIM upitom", async () => {
    const { ctrl } = make("sy15");
    const { res, seen } = resMock();
    await ctrl.rsvp(TOKEN, "ne_dolazim", "1", res);
    expect(seen.status).toBe(302);
    expect(seen.redirect).toBe(
      `${FN_BASE}/sastanci-rsvp?t=${TOKEN}&r=ne_dolazim&c=1`,
    );
  });

  it("pod `sy15` bez c=1 se `c` ne izmišlja (edge sam pokazuje stranu potvrde)", async () => {
    const { ctrl } = make("sy15");
    const { res, seen } = resMock();
    await ctrl.rsvp(TOKEN, "dolazim", undefined, res);
    expect(seen.redirect).toBe(
      `${FN_BASE}/sastanci-rsvp?t=${TOKEN}&r=dolazim`,
    );
  });

  it("neprepoznata vrednost prekidača pada na `sy15` (ne piše u 3.0)", async () => {
    const { ctrl, updateMany } = make("30" as "sy15");
    const { res, seen } = resMock();
    await ctrl.rsvp(TOKEN, "dolazim", "1", res);
    expect(updateMany).not.toHaveBeenCalled();
    expect(seen.status).toBe(302);
  });
});

// ── tajna ───────────────────────────────────────────────────────────────────

describe("privatnost: rsvp_token je tajna", () => {
  it("🔴 token se NE loguje ni kad upis padne, i ne curi u odgovor", async () => {
    const warn = jest
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => undefined);
    const { ctrl, updateMany } = make("3.0");
    updateMany.mockRejectedValue(new Error(`veza pala za ${TOKEN}`));

    const { res, seen } = resMock();
    await ctrl.rsvp(TOKEN, "dolazim", "1", res);

    expect(seen.status).toBe(500);
    expect(seen.body).not.toContain(TOKEN);
    // Ni stack ni poruka iz baze ne idu korisniku.
    expect(seen.body).not.toContain("veza pala");
    for (const call of warn.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(TOKEN);
    }
  });

  it("token se pojavljuje SAMO u linku stranice ka samoj sebi (relativan, bez hosta)", async () => {
    const { ctrl } = make("3.0");
    const { res, seen } = resMock();
    await ctrl.rsvp(TOKEN, "dolazim", "1", res);
    // Jedini pomen tokena je `href="?t=…"` — bez apsolutnog URL-a, pa link ne
    // može da odleti na pogrešan host (bag koji je edge imao).
    expect(seen.body).toContain(`href="?t=${TOKEN}`);
    expect(seen.body).not.toContain("functions/v1");
  });
});
