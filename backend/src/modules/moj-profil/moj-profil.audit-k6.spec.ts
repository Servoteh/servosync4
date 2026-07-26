import { ForbiddenException, UnprocessableEntityException } from "@nestjs/common";
import { MojProfilService } from "./moj-profil.service";

/**
 * AUDIT-K6 (26.07) — nativni 360° tok za OCENJIVAČA (peer/leader).
 *
 * Zamenjuje 1.0 `ocena.html?token=` (404 u 3.0) i njegov
 * `assessment_submit_by_token` — DEFINER fn koja traži SAMO token, pa ko ga
 * dobije predaje ocenu u tuđe ime. Ovi testovi pinuju da nova površina NE
 * ponavlja tu grešku: vlasništvo reda ocenjivača proverava se u KODU, ne samo
 * kroz RLS (lekcija iz AUDIT-K2).
 */
describe("Moj profil AUDIT-K6 — 360° ocenjivač", () => {
  const EMAIL = "kolega@servoteh.com";
  const RATER = "33333333-3333-4333-8333-333333333333";
  const ASSESSMENT = "44444444-4444-4444-8444-444444444444";

  type SqlLike = { strings?: readonly string[]; values?: unknown[] };
  const txt = (s: SqlLike) =>
    Array.isArray(s?.strings) ? s.strings.join("?") : String(s);

  /** `owned=false` → red ocenjivača nije moj; `status` → status procene. */
  const mkSvc = (opts: { owned: boolean; status?: string }) => {
    const calls: SqlLike[] = [];
    const tx = {
      $queryRaw: jest.fn(async (sql: SqlLike) => {
        calls.push(sql);
        const t = txt(sql);
        if (t.includes("FROM assessment_raters r")) {
          return opts.owned
            ? [
                {
                  assessment_id: ASSESSMENT,
                  rater_kind: "peer",
                  a_status: opts.status ?? "collecting",
                },
              ]
            : [];
        }
        return [];
      }),
      $executeRaw: jest.fn().mockResolvedValue(1),
    };
    const sy15 = {
      withUserRls: jest.fn(async (_e: string, fn: (t: unknown) => unknown) => fn(tx)),
      runIdempotentRls: jest.fn(),
    };
    const svc = new MojProfilService(sy15 as never, {
      enabled: false,
      dispatchKadr: jest.fn(),
    } as never);
    return { svc, tx, calls };
  };

  const items = [{ competenceId: 1, level: 4 }];

  it("čitanje TUĐE procene pada na 403", async () => {
    const { svc } = mkSvc({ owned: false });
    await expect(svc.raterRead(EMAIL, RATER)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("upis ocena u TUĐE ime pada na 403 (nema INSERT-a)", async () => {
    const { svc, tx } = mkSvc({ owned: false });
    await expect(
      svc.saveRaterScores(EMAIL, RATER, { raterId: RATER, items } as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it("predaja u TUĐE ime pada na 403 (bez UPDATE-a i bez preračuna)", async () => {
    const { svc, tx } = mkSvc({ owned: false });
    await expect(svc.submitRater(EMAIL, RATER)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it("ZATVORENA procena se ne može menjati (422)", async () => {
    const { svc } = mkSvc({ owned: true, status: "closed" });
    await expect(
      svc.saveRaterScores(EMAIL, RATER, { raterId: RATER, items } as never),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it("sopstvena procena u statusu collecting: upis prolazi", async () => {
    const { svc, tx } = mkSvc({ owned: true });
    const out = await svc.saveRaterScores(EMAIL, RATER, {
      raterId: RATER,
      items,
    } as never);
    expect(out).toEqual({ data: { saved: 1 } });
    expect(tx.$executeRaw).toHaveBeenCalled();
  });

  it("predaja radi isto što i token tok: status=submitted + preračun agregata", async () => {
    const { svc, tx } = mkSvc({ owned: true });
    const out = await svc.submitRater(EMAIL, RATER);
    expect(out).toEqual({ data: { ok: true, assessmentId: ASSESSMENT } });
    const executed = tx.$executeRaw.mock.calls
      .map((c) => txt(c[0] as SqlLike))
      .join(" | ");
    expect(executed).toContain("UPDATE assessment_raters");
    expect(executed).toContain("submitted");
    expect(executed).toContain("assessment_compute_results");
  });
});
