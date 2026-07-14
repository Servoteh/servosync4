import { PlanMontazeService } from "./plan-montaze.service";
import type { Sy15Service } from "../../common/sy15/sy15.service";
import type { Sy15StorageService } from "../../common/sy15/sy15-storage.service";
import type { AiProviderService } from "../../common/ai/ai-provider.service";
import type { CreateReportDto } from "./dto/plan-montaze-mutation.dto";

/**
 * Idempotency + payload paritet — izveštaji montera (MODULE_SPEC §3, doktrina A4).
 * Kreiranje izveštaja koristi klijentski UUID `id` kao idempotency ključ preko
 * `runIdempotentRls` (postojeći mehanizam 1.0), a payload prati 1.0 sacuvajIzvestaj.
 */
describe("PlanMontazeService.createReport (idempotency + payload)", () => {
  const email = "monter@servoteh.com";
  const REPORT_ID = "3b241101-e2bb-4255-8caf-4136c566a962";

  const makeService = () => {
    const create = jest.fn(
      async ({ data }: { data: Record<string, unknown> }) => ({
        id: data.id,
        broj_izvestaja: "IZV-2026-0001",
        status: data.status,
      }),
    );
    const runIdempotentRls = jest.fn(
      async (
        _email: string,
        _key: string,
        _action: string,
        fn: (tx: unknown) => Promise<unknown>,
      ) => ({ idempotent: false, result: await fn({ pmIzvestaj: { create } }) }),
    );
    const sy15 = { runIdempotentRls } as unknown as Sy15Service;
    const storage = {} as Sy15StorageService;
    const ai = {} as AiProviderService;
    const svc = new PlanMontazeService(sy15, storage, ai);
    return { svc, runIdempotentRls, create };
  };

  it("koristi dto.id kao idempotency ključ + akciju 'montaza.create-izvestaj'", async () => {
    const { svc, runIdempotentRls } = makeService();
    const dto: CreateReportDto = { id: REPORT_ID, opisRadova: "radi" };
    const res = await svc.createReport(email, dto);
    expect(runIdempotentRls).toHaveBeenCalledWith(
      email,
      REPORT_ID,
      "montaza.create-izvestaj",
      expect.any(Function),
    );
    expect(res.meta).toEqual({ idempotent: false });
  });

  it("payload paritet: default status 'u_toku', dodatni_clanovi [], BEZ autor_user_id (DB default auth.uid())", async () => {
    const { svc, create } = makeService();
    await svc.createReport(email, {
      id: REPORT_ID,
      datum: "2026-07-13",
      predmet: "9400/2",
    });
    const data = create.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.id).toBe(REPORT_ID);
    expect(data.status).toBe("u_toku");
    expect(data.dodatniClanovi).toEqual([]);
    expect(data.predmetBroj).toBe("9400/2");
    expect(data.datumRada).toBeInstanceOf(Date);
    expect(data.finalizedAt).toBeInstanceOf(Date);
    // autor_user_id NE sme biti u payload-u (WITH CHECK autor_user_id=auth.uid()).
    expect(data).not.toHaveProperty("autorUserId");
  });

  it("prosleđen status se poštuje (nije forsiran u_toku)", async () => {
    const { svc, create } = makeService();
    await svc.createReport(email, { id: REPORT_ID, status: "zavrseno" });
    const data = create.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.status).toBe("zavrseno");
  });
});
