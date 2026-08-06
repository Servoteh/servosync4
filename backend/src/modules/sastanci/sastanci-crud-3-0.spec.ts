import { ForbiddenException } from "@nestjs/common";
import { SastanciService } from "./sastanci.service";
import { SastanciSourceService } from "../../common/sy15/sastanci-source.service";
import type { Sy15Service } from "../../common/sy15/sy15.service";
import type { AiModelPolicyService } from "../../common/ai/ai-model-policy.service";

/**
 * Blokade 2+3 iz runbook-a: tabelarni CRUD pod `SASTANCI_IZVOR=3.0`.
 *
 * 🔴 ŠTA OVI TESTOVI ČUVAJU — sve četiri stvari su NEVIDLJIVE bez njih:
 *
 *  1. **Da nijedna prevedena ruta ne dira sy15.** Upis koji bi ipak otišao u
 *     sy15 razišao bi dve baze, a to se ne vidi odmah — otkrilo bi se tek kad
 *     se brojevi ne poklope.
 *  2. **Da nijedan CRUD put ne zaobilazi trigere koje migracija NAMERNO ne
 *     prenosi.** U sy15 ih je okidala baza; u 3.0 ih moraju zvati servisi. Bez
 *     poziva: učesnik ne dobije pozivnicu, izmena akcije ne ostavi trag,
 *     zaključan sastanak se tiho menja.
 *  3. **Da write-scope stoji.** RLS-a u 3.0 nema — olabavljen gejt daje pravo
 *     nad TUĐIM redom, a nijedan drugi test to ne bi primetio.
 *  4. **Da predmet (`projekat_id`) preživi prevod uuid -> Int** i da izlaz i
 *     dalje nosi ime `projekatId` (ne `projectId`).
 */

const ID = "11111111-2222-3333-4444-555555555555";
const ID2 = "22222222-3333-4444-5555-666666666666";
const CID = "3b241101-e2bb-4255-8caf-4136c566a962";
const JA = "ja@servoteh.com";
/** Predmet 10349 (šifra 9400/2) — jedan od 22 živa, uuid je IZVEDEN. */
const PRED_ID = 10349;
const PRED_UUID = "de6e7d4d-c208-5d8f-819b-4e3f9a3c5d7d";

const aiPolicyStub = (): AiModelPolicyService =>
  ({
    resolve: jest
      .fn()
      .mockImplementation((_t: string, fb: string) =>
        Promise.resolve({ model: fb, effort: null }),
      ),
  }) as unknown as AiModelPolicyService;

/** Prazan model-stub: svaka metoda vraća bezopasnu vrednost. */
function modelStub(over: Record<string, unknown> = {}) {
  return {
    findMany: jest.fn().mockResolvedValue([]),
    findFirst: jest.fn().mockResolvedValue(null),
    findUnique: jest.fn().mockResolvedValue(null),
    count: jest.fn().mockResolvedValue(0),
    aggregate: jest.fn().mockResolvedValue({ _max: { rb: null } }),
    create: jest.fn().mockResolvedValue({ id: ID }),
    createMany: jest.fn().mockResolvedValue({ count: 0 }),
    update: jest.fn().mockResolvedValue({ id: ID }),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    delete: jest.fn().mockResolvedValue({ id: ID }),
    deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    ...over,
  };
}

function makeSvc(
  opts: {
    izvor?: string;
    sme?: boolean;
    /** Nadjačavanja pojedinih modela u 3.0 tx-u. */
    tx?: Record<string, unknown>;
  } = {},
) {
  process.env.SASTANCI_IZVOR = opts.izvor ?? "3.0";
  const sme = opts.sme !== false;

  const tx: Record<string, unknown> = {
    sastanak: modelStub(),
    sastanakUcesnik: modelStub(),
    sastanakOdluka: modelStub(),
    sastanakArhiva: modelStub(),
    presekAktivnost: modelStub(),
    presekSlika: modelStub(),
    akcionaTacka: modelStub(),
    akcionaTackaIstorija: modelStub(),
    pmTema: modelStub(),
    sastanciTemplate: modelStub(),
    sastanciTemplateUcesnik: modelStub(),
    sastanciNotificationLog: modelStub(),
    sastanciNotificationPrefs: modelStub(),
    sastanciAiSettings: modelStub(),
    project: modelStub(),
    $queryRaw: jest.fn().mockResolvedValue([]),
    $executeRaw: jest.fn().mockResolvedValue(0),
    ...(opts.tx ?? {}),
  };
  const prisma = {
    ...tx,
    $transaction: jest.fn((fn: (t: unknown) => Promise<unknown>) => fn(tx)),
  };

  // 🔴 sy15 mora ostati NEDOTAKNUT: svaki poziv je greška u dizajnu, ne u testu.
  const sy15 = {
    withUserRls: jest.fn(() => {
      throw new Error("sy15.withUserRls pozvan pod prekidačem 3.0");
    }),
    runIdempotentRls: jest.fn(() => {
      throw new Error("sy15.runIdempotentRls pozvan pod prekidačem 3.0");
    }),
    db: { kadrHoliday: { findMany: jest.fn().mockResolvedValue([]) } },
  };

  const odbij = async () => {
    if (!sme) throw new ForbiddenException("nema prava");
  };
  const authz = {
    isManagement: jest.fn().mockResolvedValue(sme),
    isAdmin: jest.fn().mockResolvedValue(sme),
    hasEditRole: jest.fn().mockResolvedValue(sme),
    isUcesnik: jest.fn().mockResolvedValue(sme),
    canCreateSastanak: jest.fn().mockResolvedValue(sme),
    canWriteSastanakChild: jest.fn().mockResolvedValue(sme),
    canWriteTema: jest.fn().mockResolvedValue(sme),
    canInsertDraftTema: jest.fn().mockResolvedValue(sme),
    canDraftReview: jest.fn().mockResolvedValue(sme),
    isOrganizatorTrio: jest.fn().mockResolvedValue(sme),
    assertCanWriteSastanakChild: jest.fn(odbij),
    assertCanInsertTema: jest.fn(odbij),
    assertCanUpdateTema: jest.fn(odbij),
    assertCanDeleteTema: jest.fn(odbij),
    assertCanWriteOdluka: jest.fn(odbij),
    assertCanWriteTemplate: jest.fn(odbij),
    assertCanWritePrefs: jest.fn(odbij),
    scopeTemeWhere: jest.fn().mockResolvedValue({ status: "scoped" }),
    scopeTemeSql: jest.fn().mockResolvedValue({ sql: "TRUE", values: [] }),
    scopeNotifLogWhere: jest.fn().mockResolvedValue({}),
  };
  const fn = {
    ucesnikInviteTrigger: jest.fn().mockResolvedValue(1),
    ucesnikInviteCleanup: jest.fn().mockResolvedValue(undefined),
    assertNotLocked: jest.fn().mockResolvedValue(undefined),
    assertDraftStatusPrelaz: jest.fn(),
    akcijaIstorija: jest.fn().mockResolvedValue(1),
    enqueueCancel: jest.fn().mockResolvedValue(0),
  };
  const idem = {
    run: jest.fn(
      async (
        _e: string,
        _c: string,
        _a: string,
        f: (t: unknown) => Promise<unknown>,
      ) => ({ idempotent: false, result: await f(tx) }),
    ),
  };
  const predmet = {
    razresi: jest.fn(async (v: unknown) => {
      if (v === undefined) return undefined;
      if (v === null || v === "") return null;
      return PRED_ID;
    }),
    razresiFilter: jest.fn(async (v: unknown) =>
      v === undefined || v === null || v === "" ? undefined : PRED_ID,
    ),
  };
  const storage = {
    upload: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn().mockResolvedValue(undefined),
    signUrl: jest.fn().mockResolvedValue("https://sign/url"),
  };

  const svc = new SastanciService(
    sy15 as unknown as Sy15Service,
    storage as never,
    {} as never,
    aiPolicyStub(),
    new SastanciSourceService(),
    {} as never,
    prisma as never,
    fn as never,
    authz as never,
    idem as never,
    predmet as never,
  );
  return { svc, tx, prisma, sy15, authz, fn, idem, predmet, storage };
}

const orig = process.env.SASTANCI_IZVOR;
afterEach(() => {
  if (orig === undefined) delete process.env.SASTANCI_IZVOR;
  else process.env.SASTANCI_IZVOR = orig;
});

// ============================================================================
// 1. NIJEDNA prevedena ruta ne dira sy15 (i nijedna ne pada na 503)
// ============================================================================

describe("🔴 pod 3.0 nijedan CRUD ne ulazi u sy15 i nijedan ne vraća 503", () => {
  /**
   * Poziva SVE prevedene rute. Brana `assertPorted` pod `3.0` baca 503, a sy15
   * stub baca na svaki dotik — svaka nedovršena grana pada ovde, ne u proizvodnji.
   */
  it("sve prevedene rute prolaze bez 503 i bez dotika sy15", async () => {
    const { svc, sy15 } = makeSvc({
      tx: {
        sastanak: modelStub({
          findUnique: jest.fn().mockResolvedValue({
            id: ID,
            tip: "sedmicni",
            status: "planiran",
            datum: new Date("2026-08-10"),
            vreme: null,
            naslov: "S",
            intervalDays: null,
            projectId: PRED_ID,
            vodioEmail: JA,
            zapisnicarEmail: null,
            createdByEmail: JA,
            zakljucanAt: null,
          }),
        }),
        // Učesnik POSTOJI — inače `updateUcesnik` legitimno vraća 404.
        sastanakUcesnik: modelStub({ count: jest.fn().mockResolvedValue(1) }),
        presekAktivnost: modelStub({
          findUnique: jest.fn().mockResolvedValue({ id: ID, sastanakId: ID }),
        }),
        presekSlika: modelStub({
          findUnique: jest
            .fn()
            .mockResolvedValue({ id: ID, sastanakId: ID, storagePath: "p", sizeBytes: null }),
          create: jest
            .fn()
            .mockResolvedValue({ id: ID, sastanakId: ID, sizeBytes: null }),
          update: jest.fn().mockResolvedValue({ id: ID, sizeBytes: null }),
        }),
        sastanakOdluka: modelStub({
          findUnique: jest.fn().mockResolvedValue({ id: ID, sastanakId: ID }),
        }),
        sastanakArhiva: modelStub({
          findUnique: jest.fn().mockResolvedValue({
            sastanakId: ID,
            zapisnikStoragePath: "p.pdf",
            zapisnikSizeBytes: null,
          }),
        }),
        akcionaTacka: modelStub({
          findUnique: jest
            .fn()
            .mockResolvedValue({ id: ID, sastanakId: ID, projectId: PRED_ID }),
          update: jest
            .fn()
            .mockResolvedValue({ id: ID, sastanakId: ID, projectId: PRED_ID }),
          create: jest
            .fn()
            .mockResolvedValue({ id: ID, sastanakId: ID, projectId: PRED_ID }),
        }),
        pmTema: modelStub({
          findUnique: jest.fn().mockResolvedValue({
            id: ID,
            status: "usvojeno",
            sastanakId: ID,
            projectId: PRED_ID,
            resioEmail: null,
            resioLabel: null,
            resioAt: null,
            resioNapomena: null,
          }),
          create: jest.fn().mockResolvedValue({ id: ID, projectId: PRED_ID }),
          update: jest.fn().mockResolvedValue({ id: ID, projectId: PRED_ID }),
        }),
        sastanciTemplate: modelStub({
          findUnique: jest.fn().mockResolvedValue({
            id: ID,
            naziv: "Kolegijum",
            cadence: "none",
            cadenceDow: null,
            cadenceDom: null,
            createdAt: new Date("2026-08-01"),
            isActive: true,
          }),
          count: jest.fn().mockResolvedValue(1),
        }),
      },
    });

    const pozivi: [string, () => Promise<unknown>][] = [
      ["list", () => svc.list(JA, {})],
      ["myMeetings", () => svc.myMeetings(JA)],
      ["nextWeekly", () => svc.nextWeekly(JA)],
      ["search", () => svc.search(JA, "abc")],
      ["findFull", () => svc.findFull(JA, ID)],
      ["findOne", () => svc.findOne(JA, ID)],
      ["ucesnici", () => svc.ucesnici(JA, ID)],
      ["aktivnosti", () => svc.aktivnosti(JA, ID)],
      ["slike", () => svc.slike(JA, ID)],
      ["odluke", () => svc.odluke(JA, ID)],
      ["listAkcije", () => svc.listAkcije(JA, {})],
      ["akcijaIstorija", () => svc.akcijaIstorija(JA, ID)],
      ["akcijeWeeklyDiff", () => svc.akcijeWeeklyDiff(JA, {})],
      ["sastanakWeeklyDiff", () => svc.sastanakWeeklyDiff(JA, ID)],
      ["listProjekti", () => svc.listProjekti(JA)],
      ["listTeme", () => svc.listTeme(JA, {})],
      ["listTemplates", () => svc.listTemplates(JA)],
      ["findTemplate", () => svc.findTemplate(JA, ID)],
      ["listArhive", () => svc.listArhive(JA)],
      ["findArhiva", () => svc.findArhiva(JA, ID)],
      ["updateSastanak", () => svc.updateSastanak(JA, ID, { naslov: "X" })],
      ["addUcesnik", () => svc.addUcesnik(JA, ID, { email: "a@b.com" })],
      [
        "updateUcesnik",
        () => svc.updateUcesnik(JA, ID, "a@b.com", { prisutan: true }),
      ],
      ["removeUcesnik", () => svc.removeUcesnik(JA, ID, "a@b.com")],
      ["markPrisutni", () => svc.markPrisutni(JA, ID)],
      [
        "createAktivnost",
        () => svc.createAktivnost(JA, ID, { clientEventId: CID }),
      ],
      ["updateAktivnost", () => svc.updateAktivnost(JA, ID, { naslov: "T" })],
      ["deleteAktivnost", () => svc.deleteAktivnost(JA, ID)],
      ["reorderAktivnosti", () => svc.reorderAktivnosti(JA, ID, { ids: [ID] })],
      ["seedFromTeme", () => svc.seedFromTeme(JA, ID)],
      [
        "createOdluka",
        () => svc.createOdluka(JA, ID, { clientEventId: CID, naslov: "O" }),
      ],
      ["updateOdluka", () => svc.updateOdluka(JA, ID, { naslov: "O2" })],
      ["deleteOdluka", () => svc.deleteOdluka(JA, ID)],
      [
        "createAkcija",
        () => svc.createAkcija(JA, { clientEventId: CID, naslov: "A" }),
      ],
      ["patchAkcija", () => svc.patchAkcija(JA, ID, { naslov: "A2" })],
      ["deleteAkcija", () => svc.deleteAkcija(JA, ID)],
      ["bulkStatus", () => svc.bulkStatus(JA, { ids: [ID], status: "zavrsen" })],
      [
        "createTema",
        () => svc.createTema(JA, { clientEventId: CID, naslov: "T" }),
      ],
      ["updateTema", () => svc.updateTema(JA, ID, { naslov: "T2" })],
      ["deleteTema", () => svc.deleteTema(JA, ID)],
      ["setTemaHitno", () => svc.setTemaHitno(JA, ID, { hitno: true })],
      [
        "setTemaRazmatranje",
        () => svc.setTemaRazmatranje(JA, ID, { zaRazmatranje: true }),
      ],
      ["setTemaAdminRang", () => svc.setTemaAdminRang(JA, ID, { rang: 1 })],
      ["dodeliTemu", () => svc.dodeliTemu(JA, ID, { sastanakId: ID })],
      [
        "reorderRang",
        () => svc.reorderRang(JA, { items: [{ id: ID, rang: 1 }] }),
      ],
      [
        "createDraftTema",
        () =>
          svc.createDraftTema(JA, {
            clientEventId: CID,
            projektId: PRED_UUID,
            naslov: "D",
          }),
      ],
      ["draftTeme", () => svc.draftTeme(JA, PRED_UUID)],
      ["draftUvedi", () => svc.draftUvedi(JA, ID, { sastanakId: ID })],
      [
        "createTemplate",
        () => svc.createTemplate(JA, { clientEventId: CID, naziv: "K" }),
      ],
      ["updateTemplate", () => svc.updateTemplate(JA, ID, { naziv: "K2" })],
      ["deleteTemplate", () => svc.deleteTemplate(JA, ID)],
      ["updateSlika", () => svc.updateSlika(JA, ID, { caption: "c" })],
      ["deleteSlika", () => svc.deleteSlika(JA, ID)],
      ["getSlikaUrl", () => svc.getSlikaUrl(JA, ID)],
      ["getArhivaPdfUrl", () => svc.getArhivaPdfUrl(JA, ID)],
    ];

    const pukli: string[] = [];
    for (const [ime, poziv] of pozivi) {
      try {
        await poziv();
      } catch (e) {
        pukli.push(`${ime}: ${(e as Error).message}`);
      }
    }
    expect(pukli).toEqual([]);
    expect(sy15.withUserRls).not.toHaveBeenCalled();
    expect(sy15.runIdempotentRls).not.toHaveBeenCalled();
  });

  it("⭐ lista prioritetnih predmeta OSTAJE iza 503 (nije domen sastanaka)", async () => {
    // `get_predmet_plan_prioritet_ids` čita `production.predmet_plan_prioritet`
    // u sy15. Tiho vraćanje prazne liste izgledalo bi kao „nema prioritetnih".
    const { svc } = makeSvc();
    await expect(svc.predmetPrioritet(JA)).rejects.toMatchObject({
      status: 503,
    });
  });
});

// ============================================================================
// 2. Trigeri koje migracija NAMERNO ne prenosi — nijedan put ih ne zaobilazi
// ============================================================================

describe("🔴 logički trigeri se pozivaju iz KODA (u sy15 ih je okidala baza)", () => {
  it("addUcesnik enqueue-uje pozivnicu (sast_trg_ucesnik_invite)", async () => {
    const { svc, fn } = makeSvc();
    await svc.addUcesnik(JA, ID, { email: "Novi@Servoteh.com", label: "N" });
    // Bez ovog poziva bi novi učesnik tiho ostao BEZ pozivnice.
    expect(fn.ucesnikInviteTrigger).toHaveBeenCalledWith(expect.anything(), ID, [
      { email: "novi@servoteh.com", label: "N" },
    ]);
  });

  it("removeUcesnik briše nepokupljenu pozivnicu (…_invite_cleanup)", async () => {
    const { svc, fn } = makeSvc();
    await svc.removeUcesnik(JA, ID, "Stari@Servoteh.com");
    // Bez ovoga bi skinutom učesniku mejl STIGAO za sastanak sa kog je uklonjen.
    expect(fn.ucesnikInviteCleanup).toHaveBeenCalledWith(expect.anything(), ID, [
      "stari@servoteh.com",
    ]);
  });

  it("patchAkcija upisuje revizioni trag (akcioni_plan_trg_istorija)", async () => {
    const { svc, fn } = makeSvc({
      tx: {
        akcionaTacka: modelStub({
          findUnique: jest.fn().mockResolvedValue({
            id: ID,
            sastanakId: ID,
            projectId: PRED_ID,
            status: "otvoren",
          }),
          update: jest.fn().mockResolvedValue({
            id: ID,
            sastanakId: ID,
            projectId: PRED_ID,
            status: "zavrsen",
          }),
        }),
      },
    });
    await svc.patchAkcija(JA, ID, { status: "zavrsen" });
    expect(fn.akcijaIstorija).toHaveBeenCalledTimes(1);
    const [, stara, nova, mejl] = fn.akcijaIstorija.mock.calls[0];
    // `akcijaIstorija` očekuje `projekatId` (Int) — 3.0 model ga zove `projectId`.
    expect(stara).toMatchObject({ status: "otvoren", projekatId: PRED_ID });
    expect(nova).toMatchObject({ status: "zavrsen", projekatId: PRED_ID });
    expect(mejl).toBe(JA);
  });

  it("🔴 bulkStatus upisuje trag PO REDU (u sy15 je triger okidao za svaki red)", async () => {
    const { svc, fn } = makeSvc({
      tx: {
        akcionaTacka: modelStub({
          findMany: jest.fn().mockResolvedValue([
            { id: "a1", sastanakId: ID, projectId: null, status: "otvoren" },
            { id: "a2", sastanakId: ID, projectId: null, status: "u_toku" },
            { id: "a3", sastanakId: ID, projectId: null, status: "otvoren" },
          ]),
          update: jest
            .fn()
            .mockImplementation(({ where }: { where: { id: string } }) =>
              Promise.resolve({
                id: where.id,
                sastanakId: ID,
                projectId: null,
                status: "zavrsen",
              }),
            ),
        }),
      },
    });
    const out = await svc.bulkStatus(JA, {
      ids: ["a1", "a2", "a3"],
      status: "zavrsen",
    });
    expect(out).toEqual({ data: { updated: 3 } });
    // Jedan trag po redu — ne jedan za ceo batch.
    expect(fn.akcijaIstorija).toHaveBeenCalledTimes(3);
  });

  it("draft status guard se zove PRE upisa (sast_pm_teme_draft_status_guard)", async () => {
    const { svc, fn } = makeSvc({
      tx: {
        pmTema: modelStub({
          findUnique: jest.fn().mockResolvedValue({
            id: ID,
            status: "draft",
            sastanakId: null,
            projectId: null,
            resioEmail: null,
            resioLabel: null,
            resioAt: null,
            resioNapomena: null,
          }),
          update: jest.fn().mockResolvedValue({ id: ID, projectId: null }),
        }),
      },
    });
    await svc.updateTema(JA, ID, { status: "usvojeno" });
    expect(fn.assertDraftStatusPrelaz).toHaveBeenCalledWith("draft", "usvojeno");
  });

  it("guard zaključanog sastanka pokriva SVE tabele-decu", async () => {
    // U sy15 `sast_check_not_locked` stoji na 8 tabela (mereno `pg_trigger`);
    // ako ijedna grana ostane bez `assertNotLocked`, zaključan sastanak se tiho
    // menja.
    const scenarija: [string, (s: SastanciService) => Promise<unknown>][] = [
      ["ucesnici", (s) => s.addUcesnik(JA, ID, { email: "a@b.com" })],
      ["tačke", (s) => s.reorderAktivnosti(JA, ID, { ids: [ID] })],
      [
        "odluke",
        (s) => s.createOdluka(JA, ID, { clientEventId: CID, naslov: "O" }),
      ],
      [
        "akcije",
        (s) => s.createAkcija(JA, { clientEventId: CID, naslov: "A", sastanakId: ID }),
      ],
      ["teme", (s) => s.createTema(JA, { clientEventId: CID, naslov: "T", sastanakId: ID })],
      [
        "slike",
        (s) =>
          s.uploadSlika(JA, ID, {}, {
            buffer: Buffer.from("x"),
            originalname: "a.jpg",
            mimetype: "image/jpeg",
          } as never),
      ],
    ];
    for (const [ime, poziv] of scenarija) {
      const { svc, fn } = makeSvc();
      await poziv(svc).catch(() => {});
      expect(fn.assertNotLocked.mock.calls.length).toBeGreaterThan(0);
      expect(ime).toBeTruthy();
    }
  });

  it("🔴 reopen traži RUKOVODSTVO (guard je u sy15 puštao samo mgmt)", async () => {
    const nemgmt = makeSvc({
      tx: {
        sastanak: modelStub({
          findUnique: jest.fn().mockResolvedValue({
            vodioEmail: JA,
            zapisnicarEmail: null,
            createdByEmail: JA,
          }),
        }),
      },
    });
    // Organizator (trio) prolazi `assertMozeMenjatiSastanak`, ali NE i guard.
    nemgmt.authz.isManagement.mockResolvedValue(false);
    await expect(nemgmt.svc.reopen(JA, ID)).rejects.toMatchObject({
      status: 422,
    });
  });

  it("reopen briše datum zapisnika (review D7 — grana iz sast_check_not_locked)", async () => {
    const { svc, tx } = makeSvc({
      tx: {
        sastanak: modelStub({
          findUnique: jest.fn().mockResolvedValue({
            vodioEmail: JA,
            zapisnicarEmail: null,
            createdByEmail: JA,
          }),
          update: jest.fn().mockResolvedValue({ id: ID, projectId: null }),
        }),
      },
    });
    await svc.reopen(JA, ID);
    const arg = (tx.sastanak as { update: jest.Mock }).update.mock.calls[0][0];
    expect(arg.data).toMatchObject({
      status: "u_toku",
      zakljucanAt: null,
      zakljucanByEmail: null,
      zapisnikDatum: null,
    });
  });
});

// ============================================================================
// 3. Write-scope — „sme svoje" vs „NE sme tuđe"
// ============================================================================

describe("🔴 write-scope pod 3.0 (RLS-a nema, gejt je jedina brana)", () => {
  const rute: [string, (s: SastanciService) => Promise<unknown>][] = [
    ["addUcesnik", (s) => s.addUcesnik(JA, ID, { email: "a@b.com" })],
    [
      "updateUcesnik",
      (s) => s.updateUcesnik(JA, ID, "a@b.com", { prisutan: true }),
    ],
    ["removeUcesnik", (s) => s.removeUcesnik(JA, ID, "a@b.com")],
    ["markPrisutni", (s) => s.markPrisutni(JA, ID)],
    [
      "createAktivnost",
      (s) => s.createAktivnost(JA, ID, { clientEventId: CID }),
    ],
    ["updateAktivnost", (s) => s.updateAktivnost(JA, ID, { naslov: "T" })],
    ["deleteAktivnost", (s) => s.deleteAktivnost(JA, ID)],
    ["reorderAktivnosti", (s) => s.reorderAktivnosti(JA, ID, { ids: [ID] })],
    ["seedFromTeme", (s) => s.seedFromTeme(JA, ID)],
    [
      "createOdluka",
      (s) => s.createOdluka(JA, ID, { clientEventId: CID, naslov: "O" }),
    ],
    ["updateOdluka", (s) => s.updateOdluka(JA, ID, { naslov: "O" })],
    ["deleteOdluka", (s) => s.deleteOdluka(JA, ID)],
    ["createAkcija", (s) => s.createAkcija(JA, { clientEventId: CID, naslov: "A" })],
    ["patchAkcija", (s) => s.patchAkcija(JA, ID, { naslov: "A" })],
    ["deleteAkcija", (s) => s.deleteAkcija(JA, ID)],
    ["createTema", (s) => s.createTema(JA, { clientEventId: CID, naslov: "T" })],
    ["updateTema", (s) => s.updateTema(JA, ID, { naslov: "T" })],
    ["deleteTema", (s) => s.deleteTema(JA, ID)],
    ["setTemaHitno", (s) => s.setTemaHitno(JA, ID, { hitno: true })],
    ["dodeliTemu", (s) => s.dodeliTemu(JA, ID, { sastanakId: ID })],
    [
      "createDraftTema",
      (s) =>
        s.createDraftTema(JA, {
          clientEventId: CID,
          projektId: PRED_UUID,
          naslov: "D",
        }),
    ],
    ["draftUvedi", (s) => s.draftUvedi(JA, ID, { sastanakId: ID })],
    [
      "createTemplate",
      (s) => s.createTemplate(JA, { clientEventId: CID, naziv: "K" }),
    ],
    ["updateTemplate", (s) => s.updateTemplate(JA, ID, { naziv: "K" })],
    ["deleteTemplate", (s) => s.deleteTemplate(JA, ID)],
    ["updateSlika", (s) => s.updateSlika(JA, ID, { caption: "c" })],
    ["deleteSlika", (s) => s.deleteSlika(JA, ID)],
  ];

  const punTx = {
    sastanak: modelStub({
      findUnique: jest.fn().mockResolvedValue({
        id: ID,
        status: "planiran",
        tip: "sedmicni",
        intervalDays: null,
        vodioEmail: JA,
        zapisnicarEmail: null,
        createdByEmail: JA,
        projectId: null,
      }),
    }),
    sastanakUcesnik: modelStub({ count: jest.fn().mockResolvedValue(1) }),
    presekAktivnost: modelStub({
      findUnique: jest.fn().mockResolvedValue({ id: ID, sastanakId: ID }),
    }),
    presekSlika: modelStub({
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: ID, sastanakId: ID, storagePath: "p", sizeBytes: null }),
      update: jest.fn().mockResolvedValue({ id: ID, sizeBytes: null }),
    }),
    sastanakOdluka: modelStub({
      findUnique: jest.fn().mockResolvedValue({ id: ID, sastanakId: ID }),
    }),
    akcionaTacka: modelStub({
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: ID, sastanakId: ID, projectId: null }),
      update: jest
        .fn()
        .mockResolvedValue({ id: ID, sastanakId: ID, projectId: null }),
    }),
    pmTema: modelStub({
      findUnique: jest.fn().mockResolvedValue({
        id: ID,
        status: "usvojeno",
        sastanakId: ID,
        projectId: null,
        resioEmail: null,
        resioLabel: null,
        resioAt: null,
        resioNapomena: null,
      }),
      update: jest.fn().mockResolvedValue({ id: ID, projectId: null }),
    }),
    sastanciTemplate: modelStub({
      count: jest.fn().mockResolvedValue(1),
      findUnique: jest.fn().mockResolvedValue({ id: ID, naziv: "K" }),
    }),
  };

  it("sme svoje: sa pravom sve prolazi", async () => {
    const pukli: string[] = [];
    for (const [ime, poziv] of rute) {
      const { svc } = makeSvc({ sme: true, tx: punTx });
      try {
        await poziv(svc);
      } catch (e) {
        pukli.push(`${ime}: ${(e as Error).message}`);
      }
    }
    expect(pukli).toEqual([]);
  });

  it("🔴 NE sme tuđe: bez prava SVAKA ruta daje 403 (ni jedna ne prođe)", async () => {
    const propustile: string[] = [];
    for (const [ime, poziv] of rute) {
      const { svc } = makeSvc({ sme: false, tx: punTx });
      try {
        await poziv(svc);
        propustile.push(ime);
      } catch (e) {
        const st = (e as { status?: number }).status;
        if (st !== 403) propustile.push(`${ime} (status ${String(st)})`);
      }
    }
    expect(propustile).toEqual([]);
  });

  it("gejt stoji PRE registra idempotencije (ne troši clientEventId)", async () => {
    for (const ruta of [
      (s: SastanciService) => s.createAktivnost(JA, ID, { clientEventId: CID }),
      (s: SastanciService) =>
        s.createOdluka(JA, ID, { clientEventId: CID, naslov: "O" }),
      (s: SastanciService) =>
        s.createAkcija(JA, { clientEventId: CID, naslov: "A" }),
      (s: SastanciService) =>
        s.createTema(JA, { clientEventId: CID, naslov: "T" }),
      (s: SastanciService) =>
        s.createTemplate(JA, { clientEventId: CID, naziv: "K" }),
    ]) {
      const { svc, idem } = makeSvc({ sme: false, tx: punTx });
      await expect(ruta(svc)).rejects.toMatchObject({ status: 403 });
      expect(idem.run).not.toHaveBeenCalled();
    }
  });

  it("🔴 getArhivaPdfUrl: ni mgmt ni učesnik → 403, PDF se ne potpisuje", async () => {
    const { svc, authz, storage } = makeSvc({ tx: punTx });
    authz.isManagement.mockResolvedValue(false);
    authz.isUcesnik.mockResolvedValue(false);
    await expect(svc.getArhivaPdfUrl(JA, ID)).rejects.toMatchObject({
      status: 403,
    });
    expect(storage.signUrl).not.toHaveBeenCalled();
  });

  it("bulkStatus PRESKAČE red bez prava (paritet RLS updateMany), ne pada", async () => {
    // U sy15 je RLS filtrirao redove, pa je odgovor nosio STVARNO izmenjen broj.
    const { svc, authz } = makeSvc({
      tx: {
        akcionaTacka: modelStub({
          findMany: jest.fn().mockResolvedValue([
            { id: "a1", sastanakId: ID, projectId: null, status: "otvoren" },
            { id: "a2", sastanakId: ID2, projectId: null, status: "otvoren" },
          ]),
          update: jest
            .fn()
            .mockResolvedValue({ id: "a1", sastanakId: ID, projectId: null }),
        }),
      },
    });
    authz.canWriteSastanakChild.mockImplementation(
      async (_e: string, sid: string | null) => sid === ID,
    );
    const out = await svc.bulkStatus(JA, {
      ids: ["a1", "a2"],
      status: "zavrsen",
    });
    expect(out).toEqual({ data: { updated: 1 } });
  });
});

// ============================================================================
// 4. Read-scope se spaja tamo gde ga je nosio RLS
// ============================================================================

describe("🔴 read-scope pm_teme (view je u sy15 security_invoker)", () => {
  it("listTeme spaja scopeTemeSql", async () => {
    const { svc, authz } = makeSvc();
    await svc.listTeme(JA, {});
    expect(authz.scopeTemeSql).toHaveBeenCalledWith(JA, "v");
  });

  it("draftTeme spaja scopeTemeWhere (inače bi pokazao tuđe predloge)", async () => {
    const { svc, authz, tx } = makeSvc();
    await svc.draftTeme(JA, PRED_UUID);
    expect(authz.scopeTemeWhere).toHaveBeenCalledWith(JA);
    const where = (tx.pmTema as { findMany: jest.Mock }).findMany.mock
      .calls[0][0].where;
    expect(where.AND).toContainEqual({ status: "scoped" });
  });

  it("seedFromTeme spaja scopeTemeWhere (ne uvlači tuđu temu u zapisnik)", async () => {
    const { svc, authz } = makeSvc();
    await svc.seedFromTeme(JA, ID);
    expect(authz.scopeTemeWhere).toHaveBeenCalledWith(JA);
  });
});

// ============================================================================
// 5. Predmet (blokada 5) — ulaz u oba oblika, izlaz nosi oba
// ============================================================================

describe("🔴 predmet: create-sastanak ga VIŠE NE ISPUŠTA (rep zatvoren)", () => {
  it("uuid iz DTO-a se upisuje kao Int, ne ćutke ispušta", async () => {
    const { svc, tx, predmet } = makeSvc({
      tx: {
        sastanak: modelStub({
          create: jest
            .fn()
            .mockResolvedValue({ id: ID, projectId: PRED_ID, status: "planiran" }),
        }),
      },
    });
    const out = await svc.createSastanak(JA, {
      clientEventId: CID,
      naslov: "S",
      datum: "2026-08-10",
      projekatId: PRED_UUID,
    });
    expect(predmet.razresi).toHaveBeenCalledWith(PRED_UUID);
    const data = (tx.sastanak as { create: jest.Mock }).create.mock.calls[0][0]
      .data;
    expect(data.projectId).toBe(PRED_ID);
    // Odgovor nosi OBA oblika — stari FE poredi po uuid-u, novi po Int-u.
    expect(out.data).toMatchObject({
      projekatId: PRED_ID,
      projekatUuid: PRED_UUID,
    });
    expect("projectId" in (out.data as object)).toBe(false);
  });

  it("čist Int iz DTO-a prolazi isto", async () => {
    const { svc, predmet } = makeSvc({
      tx: {
        sastanak: modelStub({
          create: jest
            .fn()
            .mockResolvedValue({ id: ID, projectId: PRED_ID, status: "planiran" }),
        }),
      },
    });
    await svc.createSastanak(JA, {
      clientEventId: CID,
      naslov: "S",
      datum: "2026-08-10",
      projekatId: PRED_ID,
    });
    expect(predmet.razresi).toHaveBeenCalledWith(PRED_ID);
  });

  it("bez predmeta ostaje null (ne izmišlja vezu)", async () => {
    const { svc, tx } = makeSvc({
      tx: {
        sastanak: modelStub({
          create: jest
            .fn()
            .mockResolvedValue({ id: ID, projectId: null, status: "planiran" }),
        }),
      },
    });
    const out = await svc.createSastanak(JA, {
      clientEventId: CID,
      naslov: "S",
      datum: "2026-08-10",
    });
    const data = (tx.sastanak as { create: jest.Mock }).create.mock.calls[0][0]
      .data;
    expect(data.projectId).toBeNull();
    expect(out.data).toMatchObject({ projekatId: null, projekatUuid: null });
  });

  it("filter po predmetu se razrešava PRE upita (list/akcije/teme)", async () => {
    const { svc, predmet } = makeSvc();
    await svc.list(JA, { projekatId: PRED_UUID });
    await svc.listAkcije(JA, { projekatId: PRED_UUID });
    await svc.listTeme(JA, { projekatId: PRED_UUID });
    await svc.akcijeWeeklyDiff(JA, { projekatId: PRED_UUID });
    expect(predmet.razresiFilter).toHaveBeenCalledTimes(4);
  });

  it("listProjekti pod 3.0 vraća Int id + uuid (picker prelazno čita oba)", async () => {
    const { svc, tx } = makeSvc();
    (tx.$queryRaw as jest.Mock).mockResolvedValue([
      { id: PRED_ID, code: "9400/2", naziv: "Predmet" },
    ]);
    const out = await svc.listProjekti(JA);
    expect(out.data).toEqual([
      { id: PRED_ID, code: "9400/2", naziv: "Predmet", uuid: PRED_UUID },
    ]);
  });
});

// ============================================================================
// 6. Pod `sy15` NIŠTA se nije promenilo
// ============================================================================

describe("pod sy15 sve i dalje ide kroz sy15 (bajt-za-bajt)", () => {
  it("liste i mutacije zovu withUserRls / runIdempotentRls, ne 3.0 Prismu", async () => {
    process.env.SASTANCI_IZVOR = "sy15";
    const tx = {
      sastanak: modelStub(),
      sastanakUcesnik: modelStub(),
      pmTema: modelStub(),
      akcioniPlan: modelStub(),
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const prisma = {
      $transaction: jest.fn(() => {
        throw new Error("3.0 Prisma pozvana pod prekidačem sy15");
      }),
    };
    const sy15 = {
      withUserRls: jest.fn(
        (_e: string, f: (t: unknown) => Promise<unknown>) => f(tx),
      ),
      runIdempotentRls: jest.fn(
        async (
          _e: string,
          _c: string,
          _a: string,
          f: (t: unknown) => Promise<unknown>,
        ) => ({ idempotent: false, result: await f(tx) }),
      ),
    };
    const svc = new SastanciService(
      sy15 as unknown as Sy15Service,
      {} as never,
      {} as never,
      aiPolicyStub(),
      new SastanciSourceService(),
      {} as never,
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await svc.list(JA, {});
    await svc.myMeetings(JA);
    await svc.deleteAkcija(JA, ID).catch(() => {});
    expect(sy15.withUserRls).toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("🔴 Int u DTO-u se pod sy15 prevodi u ZATEČENI uuid, ne u izmišljen", async () => {
    process.env.SASTANCI_IZVOR = "sy15";
    const tx = {
      sastanak: modelStub({
        create: jest.fn().mockResolvedValue({ id: ID }),
      }),
      sastanakUcesnik: modelStub(),
      $queryRaw: jest.fn().mockResolvedValue([{ n: 2 }]),
    };
    const sy15 = {
      withUserRls: jest.fn(
        (_e: string, f: (t: unknown) => Promise<unknown>) => f(tx),
      ),
      runIdempotentRls: jest.fn(
        async (
          _e: string,
          _c: string,
          _a: string,
          f: (t: unknown) => Promise<unknown>,
        ) => ({ idempotent: false, result: await f(tx) }),
      ),
    };
    const svc = new SastanciService(
      sy15 as unknown as Sy15Service,
      {} as never,
      {} as never,
      aiPolicyStub(),
      new SastanciSourceService(),
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await svc.createSastanak(JA, {
      clientEventId: CID,
      naslov: "S",
      datum: "2026-08-10",
      projekatId: PRED_ID,
    });
    const data = tx.sastanak.create.mock.calls[0][0].data;
    expect(data.projekatId).toBe(PRED_UUID);
  });
});
