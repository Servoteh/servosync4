import { ForbiddenException } from "@nestjs/common";
import { PlanMontazeService } from "./plan-montaze.service";
import type { Sy15Service } from "../../common/sy15/sy15.service";
import type { Sy15StorageService } from "../../common/sy15/sy15-storage.service";
import type { AiProviderService } from "../../common/ai/ai-provider.service";
import type { CreateReportDto } from "./dto/plan-montaze-mutation.dto";

/** Tekst kompozitnog Prisma.Sql (literal fragmenti, bez vrednosti) za asercije. */
const sqlText = (sql: unknown): string => {
  const s = sql as { strings?: string[]; sql?: string };
  if (Array.isArray(s?.strings)) return s.strings.join(" ");
  return typeof s?.sql === "string" ? s.sql : String(sql);
};

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

/**
 * R2 adversarni review nalazi (IDOR + paritet) — TALAS C.
 * #1 uploadPdf autorizuje PRE storage.upload (deterministička putanja + servisni ključ).
 * #2 lookupPredmeti default vraća i ZATVORENE (paritet 1.0 montaža picker onlyActive:false).
 * #3 AI enrichPredmet NE filtrira zatvorene (veran port edge-a).
 */
describe("PlanMontazeService — R2 review nalazi (IDOR + paritet)", () => {
  const email = "b@servoteh.com";
  const REPORT_ID = "3b241101-e2bb-4255-8caf-4136c566a962";

  // ── Nalaz #1 (HIGH IDOR) ──
  it("uploadPdf: ne-autor B → 403 BEZ poziva storage.upload (autorizacija PRE upload-a)", async () => {
    const upload = jest.fn(async () => {});
    const findUnique = jest.fn(async () => ({
      id: REPORT_ID,
      brojIzvestaja: "IZV-2026-0001",
    }));
    // EXISTS(autor∨mgmt∨admin) = false → B nema pravo na tuđi izveštaj.
    const queryRaw = jest.fn(async () => [{ allowed: false }]);
    const tx = { pmIzvestaj: { findUnique }, $queryRaw: queryRaw };
    const withUserRls = jest.fn(
      async (_e: string, fn: (t: unknown) => Promise<unknown>) => fn(tx),
    );
    const sy15 = { withUserRls } as unknown as Sy15Service;
    const storage = { upload } as unknown as Sy15StorageService;
    const svc = new PlanMontazeService(sy15, storage, {} as AiProviderService);
    const file = {
      buffer: Buffer.from("%PDF-1.4 fake"),
      mimetype: "application/pdf",
      size: 12,
    } as Express.Multer.File;

    await expect(svc.uploadPdf(email, REPORT_ID, file)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(upload).not.toHaveBeenCalled(); // KLJUČNO: nema prepisa tuđeg PDF-a
  });

  it("uploadPdf: autor (allowed) → storage.upload pozvan + PATCH pdf_path/naziv", async () => {
    const upload = jest.fn(async () => {});
    const tx = {
      pmIzvestaj: {
        findUnique: jest.fn(async () => ({
          id: REPORT_ID,
          brojIzvestaja: "IZV-2026-0001",
        })),
        count: jest.fn(async () => 1),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
      $queryRaw: jest.fn(async () => [{ allowed: true }]),
    };
    const withUserRls = jest.fn(
      async (_e: string, fn: (t: unknown) => Promise<unknown>) => fn(tx),
    );
    const sy15 = { withUserRls } as unknown as Sy15Service;
    const storage = { upload } as unknown as Sy15StorageService;
    const svc = new PlanMontazeService(sy15, storage, {} as AiProviderService);
    const file = {
      buffer: Buffer.from("%PDF-1.4"),
      mimetype: "application/pdf",
      size: 8,
    } as Express.Multer.File;

    const res = await svc.uploadPdf(email, REPORT_ID, file);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(res.data.pdfPath).toBe(`${REPORT_ID}/IZV-2026-0001.pdf`);
  });

  // ── Nalaz #2 (HIGH paritet) ──
  const makeLookup = () => {
    const captured: { itemsSql?: string } = {};
    const queryRaw = jest.fn(async (sql: unknown) => {
      const t = sqlText(sql);
      if (t.includes("bigtehn_items_cache")) {
        captured.itemsSql = t;
        return []; // items — sadržaj nebitan za ovaj test
      }
      return []; // customers
    });
    const withUserRls = jest.fn(
      async (_e: string, fn: (t: unknown) => Promise<unknown>) =>
        fn({ $queryRaw: queryRaw }),
    );
    const sy15 = { withUserRls } as unknown as Sy15Service;
    const svc = new PlanMontazeService(
      sy15,
      {} as Sy15StorageService,
      {} as AiProviderService,
    );
    return { svc, captured };
  };

  it("lookupPredmeti: DEFAULT (bez onlyActive) → SQL bez active-filtera (vraća i zatvorene)", async () => {
    const { svc, captured } = makeLookup();
    await svc.lookupPredmeti(email, "8500");
    expect(captured.itemsSql).toBeDefined();
    expect(captured.itemsSql).not.toContain("U TOKU");
    expect(captured.itemsSql).not.toContain("datum_zakljucenja IS NULL");
  });

  it("lookupPredmeti: onlyActive='1' → SQL sadrži active-filter (samo aktivni)", async () => {
    const { svc, captured } = makeLookup();
    await svc.lookupPredmeti(email, "8500", "1");
    expect(captured.itemsSql).toContain("U TOKU");
    expect(captured.itemsSql).toContain("datum_zakljucenja IS NULL");
  });

  // ── Nalaz #3 (MEDIUM paritet) ──
  it("aiGenerate/enrichPredmet: NE filtrira zatvorene → popuni predmet_item_id/naziv/klijent", async () => {
    let itemsSql = "";
    const queryRaw = jest.fn(async (sql: unknown) => {
      const t = sqlText(sql);
      if (t.includes("montaza_ai_settings")) return [{ model: null }]; // → default model
      if (t.includes("bigtehn_items_cache")) {
        itemsSql = t;
        return [
          {
            id: 8500,
            broj_predmeta: "8500/1",
            naziv_predmeta: "Zatvoren projekat",
            customer_id: 42,
          },
        ];
      }
      if (t.includes("bigtehn_customers_cache"))
        return [{ name: "Klijent doo", short_name: "KL" }];
      return [];
    });
    const withUserRls = jest.fn(
      async (_e: string, fn: (t: unknown) => Promise<unknown>) =>
        fn({ $queryRaw: queryRaw }),
    );
    const extractWithTool = jest.fn(async () => ({
      toolInput: {
        predmet: "8500/1",
        status: "zavrseno",
        opis_radova: "servis",
      },
      model: "claude-sonnet-4-6",
      usage: null,
    }));
    const sy15 = { withUserRls } as unknown as Sy15Service;
    const ai = { extractWithTool } as unknown as AiProviderService;
    const svc = new PlanMontazeService(sy15, {} as Sy15StorageService, ai);

    const res = await svc.aiGenerate(email, { tekst: "bio na servisu za 8500/1" });
    expect(itemsSql).not.toContain("datum_zakljucenja IS NULL"); // ORDER BY sme, filter NE
    expect(res.data.predmet_item_id).toBe(8500);
    expect(res.data.naziv_projekta).toBe("Zatvoren projekat");
    expect(res.data.klijent).toBe("KL");
  });
});
