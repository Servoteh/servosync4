import { NotFoundException } from "@nestjs/common";
import { SastanciService } from "./sastanci.service";
import type { Sy15Service } from "../../common/sy15/sy15.service";

/**
 * RLS most + serializacija (review 12.07): pinuje da row-scoped read-ovi idu kroz
 * `withUserRls` (NE `withUser` — BYPASSRLS leak) i da BigInt kolone izlaze kao Number.
 * Row-ishod (koji red RLS vraća) dokazuje živi smoke u R2 — ovde samo ruta mosta.
 */
describe("SastanciService — withUserRls most + BigInt out", () => {
  function makeSvc() {
    const tx = {
      sastanak: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
      },
      sastanciNotificationLog: { findMany: jest.fn().mockResolvedValue([]) },
      presekSlika: { findMany: jest.fn().mockResolvedValue([]) },
      sastanakArhiva: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      sastanciTemplate: { findMany: jest.fn().mockResolvedValue([]) },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const sy15 = {
      withUser: jest.fn(),
      withUserRls: jest.fn(
        (_email: string, fn: (t: unknown) => Promise<unknown>) => fn(tx),
      ),
    };
    const svc = new SastanciService(
      sy15 as unknown as Sy15Service,
      {} as never,
      {} as never,
    );
    return { svc, sy15, tx };
  }

  it("notifications (RLS: svoje∨mgmt) ide kroz withUserRls, NIKAD withUser", async () => {
    const { svc, sy15 } = makeSvc();
    await svc.notifications("test@servoteh.com", {});
    expect(sy15.withUserRls).toHaveBeenCalledTimes(1);
    expect(sy15.withUser).not.toHaveBeenCalled();
  });

  it("listTeme (RLS: pm_teme vidljivost) ide kroz withUserRls", async () => {
    const { svc, sy15 } = makeSvc();
    await svc.listTeme("test@servoteh.com", {});
    expect(sy15.withUserRls).toHaveBeenCalledTimes(1);
    expect(sy15.withUser).not.toHaveBeenCalled();
  });

  it("list (SELECT true politika) TAKOĐE ide kroz withUserRls (jednoobrazan most)", async () => {
    const { svc, sy15 } = makeSvc();
    await svc.list("test@servoteh.com", {});
    expect(sy15.withUserRls).toHaveBeenCalled();
    expect(sy15.withUser).not.toHaveBeenCalled();
  });

  it("akcijeWeeklyDiff — paritet loadWeeklyDiffStats: {novo, zavrsenoOveNedelje, kasni, aktivnih}", async () => {
    const { svc, tx } = makeSvc();
    tx.$queryRaw.mockResolvedValueOnce([
      {
        novo: BigInt(2),
        zavrseno: BigInt(1),
        kasni: BigInt(3),
        aktivnih: BigInt(7),
      },
    ]);
    const out = await svc.akcijeWeeklyDiff("test@servoteh.com", {
      since: "2026-07-01T00:00:00Z",
    });
    expect(out.data).toEqual({
      novo: 2,
      zavrsenoOveNedelje: 1,
      kasni: 3,
      aktivnih: 7,
    });
  });

  // ── S-P0 paket 2: projekat polja na akcijama + ⭐ predmet-prioritet ──

  it("listAkcije: SELECT nosi LEFT JOIN projects + projekatNaziv/projekatCode/bigtehnItemId", async () => {
    const { svc, tx } = makeSvc();
    await svc.listAkcije("test@servoteh.com", {});
    const sql = (
      tx.$queryRaw.mock.calls[0] as unknown as { strings: string[] }[]
    )[0].strings.join("?");
    expect(sql).toContain("LEFT JOIN projects");
    expect(sql).toContain(`"projekatNaziv"`);
    expect(sql).toContain(`"projekatCode"`);
    expect(sql).toContain(`"bigtehnItemId"`);
    // bigtehn_item_id je integer u bazi — ugovor kaže string|null.
    expect(sql).toContain("bigtehn_item_id::text");
  });

  it("predmetPrioritet: get_predmet_plan_prioritet_ids → uređen string[] (normalizacija 1.0)", async () => {
    const { svc, tx } = makeSvc();
    tx.$queryRaw.mockResolvedValueOnce([{ ids: [9400, 8069, 0, null] }]);
    const out = await svc.predmetPrioritet("test@servoteh.com");
    expect(out.data).toEqual(["9400", "8069"]); // 0/null otpadaju kao u 1.0 normalizeIds
  });

  it("predmetPrioritet: prazna lista → data: []", async () => {
    const { svc, tx } = makeSvc();
    tx.$queryRaw.mockResolvedValueOnce([{ ids: [] }]);
    const out = await svc.predmetPrioritet("test@servoteh.com");
    expect(out.data).toEqual([]);
  });

  // ── S-P0 paket 3: weekly-diff sa pravim sidrom ──

  it("sastanakWeeklyDiff: bez prethodnog zaključanog → data:null (1.0 red se izostavlja)", async () => {
    const { svc, tx } = makeSvc();
    tx.sastanak.findUnique.mockResolvedValueOnce({
      datum: new Date("2026-07-13"),
    });
    tx.sastanak.findFirst.mockResolvedValueOnce(null);
    const out = await svc.sastanakWeeklyDiff(
      "test@servoteh.com",
      "3b241101-e2bb-4255-8caf-4136c566a962",
    );
    expect(out.data).toBeNull();
  });

  it("sastanakWeeklyDiff: prethodni postoji ali zakljucan_at prazan → data:null", async () => {
    const { svc, tx } = makeSvc();
    tx.sastanak.findUnique.mockResolvedValueOnce({
      datum: new Date("2026-07-13"),
    });
    tx.sastanak.findFirst.mockResolvedValueOnce({ zakljucanAt: null });
    const out = await svc.sastanakWeeklyDiff(
      "test@servoteh.com",
      "3b241101-e2bb-4255-8caf-4136c566a962",
    );
    expect(out.data).toBeNull();
  });

  it("sastanakWeeklyDiff: sidro = prethodni ZAKLJUČANI pre datuma (bez :id) → diff sa since", async () => {
    const ID = "3b241101-e2bb-4255-8caf-4136c566a962";
    const { svc, tx } = makeSvc();
    tx.sastanak.findUnique.mockResolvedValueOnce({
      datum: new Date("2026-07-13"),
    });
    const zakljucanAt = new Date("2026-07-06T10:00:00Z");
    tx.sastanak.findFirst.mockResolvedValueOnce({ zakljucanAt });
    tx.$queryRaw.mockResolvedValueOnce([
      {
        novo: BigInt(2),
        zavrseno: BigInt(1),
        kasni: BigInt(3),
        aktivnih: BigInt(7),
      },
    ]);
    const out = await svc.sastanakWeeklyDiff("test@servoteh.com", ID);
    // Isti ključevi kao sestrinski akcijeWeeklyDiff (1.0 kanon: zavrsenoOveNedelje).
    expect(out.data).toEqual({
      since: zakljucanAt.toISOString(),
      novo: 2,
      zavrsenoOveNedelje: 1,
      kasni: 3,
      aktivnih: 7,
    });
    // Paritet loadPrethodniZakljucanPre: status='zakljucan', datum < datum, id != :id.
    const arg = (
      tx.sastanak.findFirst.mock.calls[0] as unknown as {
        where: { status: string; id: { not: string }; datum: { lt: Date } };
      }[]
    )[0];
    expect(arg.where.status).toBe("zakljucan");
    expect(arg.where.id).toEqual({ not: ID });
    expect(arg.where.datum).toEqual({ lt: new Date("2026-07-13") });
  });

  it("sastanakWeeklyDiff: sastanak ne postoji → 404", async () => {
    const { svc, tx } = makeSvc();
    tx.sastanak.findUnique.mockResolvedValueOnce(null);
    await expect(
      svc.sastanakWeeklyDiff(
        "test@servoteh.com",
        "3b241101-e2bb-4255-8caf-4136c566a962",
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  // ── GET /prefs — camelCase ugovor (FE tip Prefs; PATCH vraća camelCase Prisma model) ──

  it("myPrefs: aliasuje snake_case kolone RPC-a u camelCase (paritet FE tipa Prefs)", async () => {
    const { svc, sy15, tx } = makeSvc();
    const row = {
      email: "test@servoteh.com",
      onNewAkcija: true,
      onChangeAkcija: false,
      onMeetingInvite: true,
      onMeetingLocked: true,
      onActionReminder: false,
      onMeetingReminder: true,
    };
    tx.$queryRaw.mockResolvedValueOnce([row]);
    const out = await svc.myPrefs("test@servoteh.com");
    expect(sy15.withUserRls).toHaveBeenCalledTimes(1);
    expect(out.data).toEqual(row);
    const sql = (
      tx.$queryRaw.mock.calls[0] as unknown as { strings: string[] }[]
    )[0].strings.join("?");
    expect(sql).toContain("sastanci_get_or_create_my_prefs()");
    // Tačne kolone fn-a (sastanci_notification_prefs) → tačni FE ključevi.
    for (const [col, alias] of [
      ["on_new_akcija", "onNewAkcija"],
      ["on_change_akcija", "onChangeAkcija"],
      ["on_meeting_invite", "onMeetingInvite"],
      ["on_meeting_locked", "onMeetingLocked"],
      ["on_action_reminder", "onActionReminder"],
      ["on_meeting_reminder", "onMeetingReminder"],
    ]) {
      expect(sql).toMatch(new RegExp(`${col}\\s+AS "${alias}"`));
    }
  });

  it("myPrefs: prazan rezultat → data:null", async () => {
    const { svc, tx } = makeSvc();
    tx.$queryRaw.mockResolvedValueOnce([]);
    const out = await svc.myPrefs("test@servoteh.com");
    expect(out.data).toBeNull();
  });

  it("search ispod 2 karaktera → prazno BEZ upita (paritet searchSastanciGlobal)", async () => {
    const { svc, sy15 } = makeSvc();
    const out = await svc.search("test@servoteh.com", "a");
    expect(out.data).toEqual({ akcije: [], sastanci: [] });
    expect(sy15.withUserRls).not.toHaveBeenCalled();
  });

  it("slike: sizeBytes BigInt → Number (res.json ne ume BigInt)", async () => {
    const { svc, tx } = makeSvc();
    tx.presekSlika.findMany.mockResolvedValueOnce([
      { id: "s1", sizeBytes: BigInt(123456) },
      { id: "s2", sizeBytes: null },
    ]);
    const out = await svc.slike(
      "test@servoteh.com",
      "3b241101-e2bb-4255-8caf-4136c566a962",
    );
    expect(out.data[0].sizeBytes).toBe(123456);
    expect(out.data[1].sizeBytes).toBeNull();
  });

  // ── S5: izvedene kolone „Sledeći termin" / „Poslednji sastanak" u listTemplates ──

  const TPL = {
    id: "t1",
    naziv: "Sedmični pregled",
    tip: "sedmicni",
    cadence: "weekly",
    cadenceDow: 1,
    cadenceDom: null,
    isActive: true,
    createdAt: new Date("2026-01-05T08:00:00Z"),
  };

  it("listTemplates: sledeciTermin = nextOccurrence (isti datum koji dodeljuje instantiate)", async () => {
    const { svc, tx } = makeSvc();
    tx.sastanciTemplate.findMany.mockResolvedValueOnce([TPL]);
    const out = (await svc.listTemplates("test@servoteh.com")) as {
      data: { sledeciTermin: string | null }[];
    };
    // weekly + dow=1 → prvi ponedeljak od danas (lokalni kalendar, bez TZ drift-a).
    const d = out.data[0].sledeciTermin as string;
    expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Date(`${d}T00:00:00`).getDay()).toBe(1);
  });

  it("listTemplates: neaktivan šablon i cadence='none' nemaju sledeći termin", async () => {
    const { svc, tx } = makeSvc();
    tx.sastanciTemplate.findMany.mockResolvedValueOnce([
      { ...TPL, id: "t2", naziv: "Neaktivan", isActive: false },
      { ...TPL, id: "t3", naziv: "Bez ritma", cadence: "none" },
    ]);
    const out = (await svc.listTemplates("test@servoteh.com")) as {
      data: { sledeciTermin: string | null }[];
    };
    expect(out.data.map((t) => t.sledeciTermin)).toEqual([null, null]);
  });

  it("listTemplates: poslednji sastanak = JEDAN batch upit za sve šablone (bez N+1)", async () => {
    const { svc, tx } = makeSvc();
    tx.sastanciTemplate.findMany.mockResolvedValueOnce([
      TPL,
      { ...TPL, id: "t2", naziv: "  Kolegijum  " },
      { ...TPL, id: "t3", naziv: "Bez instanci" },
    ]);
    tx.$queryRaw.mockResolvedValueOnce([
      {
        key: "sedmični pregled",
        id: "s1",
        datum: new Date("2026-07-13T00:00:00Z"),
        status: "zakljucan",
      },
      {
        key: "kolegijum",
        id: "s2",
        datum: new Date("2026-07-10T00:00:00Z"),
        status: "zavrsen",
      },
    ]);
    const out = (await svc.listTemplates("test@servoteh.com")) as {
      data: {
        poslednjiSastanak: string | null;
        poslednjiSastanakId: string | null;
      }[];
    };
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(out.data.map((t) => t.poslednjiSastanak)).toEqual([
      "2026-07-13",
      "2026-07-10",
      null,
    ]);
    // Naziv se normalizuje (trim + lower) na obe strane poklapanja.
    expect(out.data[1].poslednjiSastanakId).toBe("s2");
    expect(out.data[2].poslednjiSastanakId).toBeNull();

    const sql = (
      tx.$queryRaw.mock.calls[0] as unknown as { strings: string[] }[]
    )[0].strings.join("?");
    // Heuristika po naslovu + „već održan": otkazani i budući termini otpadaju.
    expect(sql).toContain("lower(btrim(naslov))");
    expect(sql).toContain("status <> 'otkazan'");
    expect(sql).toContain("datum <= CURRENT_DATE");
  });

  it("listTemplates: bez šablona → nema upita za poslednji sastanak", async () => {
    const { svc, tx } = makeSvc();
    tx.sastanciTemplate.findMany.mockResolvedValueOnce([]);
    const out = (await svc.listTemplates("test@servoteh.com")) as {
      data: unknown[];
    };
    expect(out.data).toEqual([]);
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it("listArhive: zapisnikSizeBytes BigInt → Number", async () => {
    const { svc, tx } = makeSvc();
    tx.sastanakArhiva.findMany.mockResolvedValueOnce([
      { id: "a1", zapisnikSizeBytes: BigInt(987654321) },
    ]);
    const out = await svc.listArhive("test@servoteh.com");
    expect(out.data[0].zapisnikSizeBytes).toBe(987654321);
  });
});
