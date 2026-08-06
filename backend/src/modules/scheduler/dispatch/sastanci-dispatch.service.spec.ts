import { Logger } from "@nestjs/common";
import { SastanciDispatchService as RealSastanciDispatchService } from "./sastanci-dispatch.service";
import type { MailService } from "../../../common/mail/mail.service";
import type { Sy15Service } from "../../../common/sy15/sy15.service";
import type { Sy15StorageService } from "../../../common/sy15/sy15-storage.service";
import { SastanciSourceService } from "../../../common/sy15/sastanci-source.service";
import type { PrismaService } from "../../../prisma/prisma.service";
import type { SastanciFnService } from "../../sastanci/sastanci-fn.service";

/*
 * Talas A-2b — sastanci dispatch worker. Testiramo PARITET sa 1.0 edge fn
 * (sastanci-notify-dispatch): routing svih 8 kind-ova + fallback, živi upiti,
 * prilozi (.ics / PDF zapisnik), defer grana dok se PDF generiše, per-row
 * mark_sent ODMAH, tačan backoff, DRY-RUN grane i gate.
 *
 * Uz to čuvamo NAMERNO ODSTUPANJE: deep-linkovi su 3.0 oblika (`?open=` /
 * `?tab=`), jer je stari `sastanci/<uuid>` oblik 404 na današnjem domenu.
 *
 * Seoba 05.08 — servis je dobio tri nove zavisnosti (prekidač `SASTANCI_IZVOR`,
 * 3.0 Prisma i `SastanciFnService`). Postojeći testovi pinuju `sy15` put i grade
 * servis sa tri argumenta, pa se ostatak dodaje kao PODRAZUMEVAN (vidi wrapper
 * ispod); testovi 3.0 puta prosleđuju svoje mock-ove.
 */

type MailParams = Parameters<MailService["send"]>[0];

/** Hvata sve `$queryRaw` pozive kao spojen SQL + prosleđene vrednosti. */
function sy15Mock() {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const queue: unknown[][] = [];
  const $queryRaw = jest.fn(
    (strings: TemplateStringsArray | string, ...values: unknown[]) => {
      const sql = Array.isArray(strings)
        ? (strings as unknown as string[]).join("?")
        : String(strings);
      calls.push({ sql, values });
      return Promise.resolve(queue.length ? queue.shift() : []);
    },
  );
  const sy15 = { db: { $queryRaw } } as unknown as Sy15Service;
  return {
    sy15,
    calls,
    /** Redom: rezultati koje `$queryRaw` vraća (FIFO). */
    pushResult: (rows: unknown[]) => queue.push(rows),
    sqlOf: (i: number) => calls[i]?.sql ?? "",
    find: (needle: string) => calls.filter((c) => c.sql.includes(needle)),
  };
}

function mailMock(configured = true, ok = true) {
  const sent: MailParams[] = [];
  const send = jest.fn((p: MailParams) => {
    sent.push(p);
    return Promise.resolve(ok);
  });
  const mail = { configured, send } as unknown as MailService;
  return { mail, send, sent };
}

function storageMock(bytes?: Uint8Array) {
  const download = jest
    .fn()
    .mockResolvedValue(bytes ?? new Uint8Array([37, 80, 68, 70])); // %PDF
  return { storage: { download } as unknown as Sy15StorageService, download };
}

/** 3.0 Prisma mock: `$transaction(cb)` samo izvrši callback (bez prave tx). */
function prismaMock(rsvpToken: string | null = null) {
  const tx = {};
  const $transaction = jest.fn((cb: (t: unknown) => unknown) =>
    Promise.resolve(cb(tx)),
  );
  // Pod izvorom 3.0 se RSVP token magic-linka čita iz 3.0 baze (ne sa sy15).
  const findFirst = jest
    .fn()
    .mockResolvedValue(rsvpToken ? { rsvpToken } : null);
  return {
    prisma: {
      $transaction,
      sastanakUcesnik: { findFirst },
    } as unknown as PrismaService,
    $transaction,
    findFirst,
  };
}

/** `SastanciFnService` mock — samo tri metode kojima dispečer dodiruje red. */
function sastFnMock(rows: Array<Record<string, unknown>> = []) {
  const dispatchDequeue = jest.fn().mockResolvedValue(rows);
  const dispatchMarkSent = jest.fn().mockResolvedValue(1);
  const dispatchMarkFailed = jest.fn().mockResolvedValue(undefined);
  return {
    sastFn: {
      dispatchDequeue,
      dispatchMarkSent,
      dispatchMarkFailed,
    } as unknown as SastanciFnService,
    dispatchDequeue,
    dispatchMarkSent,
    dispatchMarkFailed,
  };
}

/**
 * Testni omotač: postojeći testovi grade servis sa TRI argumenta (sy15 put).
 * Prekidač čita `process.env` po konstrukciji, pa 3.0 test samo postavi env i
 * prosledi svoje `prisma`/`sastFn` mock-ove.
 */
class SastanciDispatchService extends RealSastanciDispatchService {
  constructor(
    sy15: Sy15Service,
    mail: MailService,
    storage: Sy15StorageService,
    izvor: SastanciSourceService = new SastanciSourceService(),
    prisma: PrismaService = prismaMock().prisma,
    sastFn: SastanciFnService = sastFnMock().sastFn,
  ) {
    super(sy15, mail, storage, izvor, prisma, sastFn);
  }
}

const ID_A = "11111111-1111-1111-1111-111111111111";
const ID_B = "22222222-2222-2222-2222-222222222222";
const SAST_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const APP = "https://test.servoteh.com/";
/** JAVNI gateway — RSVP dugmad se klikću iz mejla, često sa telefona van firme. */
const FN_BASE = "https://api.servosync.servoteh.com/functions/v1";

/** Minimalan red iz `sastanci_dispatch_dequeue` (sva polja koja servis čita). */
function row(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: ID_A,
    kind: "akcija_new",
    channel: "email",
    recipient_email: "pera@servoteh.com",
    recipient_label: "Pera",
    subject: "fallback subject",
    body_html: "<p>fallback</p>",
    body_text: "fallback",
    related_sastanak_id: null,
    related_akcija_id: null,
    attempts: 0,
    payload: { naslov: "Test naslov" },
    ...over,
  };
}

const OLD_ENV = { ...process.env };
beforeEach(() => {
  process.env.DISPATCH_SASTANCI_ENABLED = "true";
  // Podrazumevani izvor je sy15 — postojeći testovi pinuju STARI put.
  delete process.env.SASTANCI_IZVOR;
  process.env.PUBLIC_APP_URL = APP;
  process.env.SY15_FUNCTIONS_URL = FN_BASE;
  // Prod vrednost je LAN (192.168.64.28:8090) — RSVP link NIKAD ne sme odavde.
  process.env.SY15_REST_URL = "http://192.168.64.28:8090/rest/v1";
  delete process.env.SY15_STORAGE_URL;
});
afterEach(() => {
  process.env = { ...OLD_ENV };
  jest.restoreAllMocks();
});

describe("SastanciDispatchService — gate i registracija posla", () => {
  it("bez DISPATCH_SASTANCI_ENABLED: no-op — NIJEDAN sy15 poziv, nijedan mejl", async () => {
    delete process.env.DISPATCH_SASTANCI_ENABLED;
    const m = sy15Mock();
    const { mail, send } = mailMock();
    const svc = new SastanciDispatchService(
      m.sy15,
      mail,
      storageMock().storage,
    );

    const jobs = svc.buildJobs();
    expect(jobs.map((j) => j.key)).toEqual(["sastanci-notify-dispatch"]);
    const summary = await jobs[0].run({ scheduledFor: new Date() });
    expect(String(summary)).toContain("dispatch OFF");
    expect(String(summary)).toContain("DISPATCH_SASTANCI_ENABLED");
    expect(m.calls).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("DISPATCH_ENABLED (kadr/maint/pb prekidač) NE pali sastanke — prekidači su nezavisni", async () => {
    delete process.env.DISPATCH_SASTANCI_ENABLED;
    process.env.DISPATCH_ENABLED = "true";
    const m = sy15Mock();
    const svc = new SastanciDispatchService(
      m.sy15,
      mailMock().mail,
      storageMock().storage,
    );
    await svc.buildJobs()[0].run({ scheduledFor: new Date() });
    expect(m.calls).toHaveLength(0);
  });

  it("posao je na */2 min (paritet sy15 dispatch petlje)", () => {
    const svc = new SastanciDispatchService(
      sy15Mock().sy15,
      mailMock().mail,
      storageMock().storage,
    );
    expect(svc.buildJobs()[0].schedule).toEqual({
      kind: "everyMinutes",
      minutes: 2,
    });
  });

  it("upaljen posao vraća summary string sa brojačima", async () => {
    const m = sy15Mock();
    m.pushResult([row()]);
    const svc = new SastanciDispatchService(
      m.sy15,
      mailMock().mail,
      storageMock().storage,
    );
    const summary = await svc.buildJobs()[0].run({ scheduledFor: new Date() });
    expect(String(summary)).toBe("processed=1 sent=1 failed=0 skipped=0 wa=0");
  });
});

describe("routing kind → šablon (svih 8 + fallback)", () => {
  /** Jedan red kroz ceo tok; `extraResults` su rezultati živih upita (FIFO). */
  async function runOne(
    over: Partial<Record<string, unknown>>,
    extraResults: unknown[][] = [],
  ) {
    const m = sy15Mock();
    m.pushResult([row(over)]);
    for (const r of extraResults) m.pushResult(r);
    const { mail, sent } = mailMock();
    const svc = new SastanciDispatchService(
      m.sy15,
      mail,
      storageMock().storage,
    );
    const summary = await svc.dispatchSastanci();
    return { m, sent, summary };
  }

  it("akcija_new → 'Nova akcija: …'", async () => {
    const { sent } = await runOne({
      kind: "akcija_new",
      payload: { naslov: "Nabavi ležajeve", rok_text: "24.07.2026" },
    });
    expect(sent[0].subject).toBe("Nova akcija: Nabavi ležajeve");
    expect(sent[0].html).toContain("Nova akcija");
    expect(sent[0].text).toContain("Rok: 24.07.2026");
  });

  it("akcija_changed → 'Akcija ažurirana: …' + prikaz promene statusa", async () => {
    const { sent } = await runOne({
      kind: "akcija_changed",
      payload: {
        naslov: "Popravi presu",
        status_old: "otvoren",
        status_new: "u_toku",
      },
    });
    expect(sent[0].subject).toBe("Akcija ažurirana: Popravi presu");
    expect(sent[0].html).toContain("<s>otvoren</s>");
    expect(sent[0].html).toContain("<strong>u_toku</strong>");
  });

  it("meeting_invite → 'Pozivnica: … — DD.MM.YYYY'", async () => {
    const { sent } = await runOne(
      {
        kind: "meeting_invite",
        related_sastanak_id: SAST_ID,
        payload: {
          naslov: "Kolegijum",
          datum: "2026-07-24",
          vreme: "09:00",
          sastanak_id: SAST_ID,
        },
      },
      [[], []], // zaduženja (prazno) + rsvp token (nema)
    );
    expect(sent[0].subject).toBe("Pozivnica: Kolegijum — 24.07.2026");
    expect(sent[0].html).toContain("Pozivnica na sastanak");
  });

  it("meeting_locked → 'Zapisnik: …' (attempts≥3, bez priloga)", async () => {
    const { sent } = await runOne(
      {
        kind: "meeting_locked",
        attempts: 3,
        related_sastanak_id: SAST_ID,
        payload: { naslov: "Kolegijum", datum: "2026-07-24" },
      },
      [[], [], []], // prethodni sastanak, v_akcioni_plan, arhiva (prazna)
    );
    expect(sent[0].subject).toBe("Zapisnik: Kolegijum");
    expect(sent[0].html).toContain("Sastanak zaključan");
  });

  it("action_reminder → 'Rok sutra: …' kad rok nije prošao", async () => {
    const { sent } = await runOne({
      kind: "action_reminder",
      payload: { naslov: "Poslati ponudu" },
    });
    expect(sent[0].subject).toBe("Rok sutra: Poslati ponudu");
    expect(sent[0].html).toContain("Podsetnik za akciju");
  });

  it("action_reminder → 'Akcija kasni: …' kad je rok pre reminder_for", async () => {
    const { sent } = await runOne({
      kind: "action_reminder",
      payload: {
        naslov: "Poslati ponudu",
        rok: "2026-07-01",
        reminder_for: "2026-07-24",
      },
    });
    expect(sent[0].subject).toBe("Akcija kasni: Poslati ponudu");
    expect(sent[0].html).toContain("KASNI");
  });

  it("action_reminder → 'Rok danas: …' kad je rok == reminder_for", async () => {
    const { sent } = await runOne({
      kind: "action_reminder",
      payload: {
        naslov: "Poslati ponudu",
        rok: "2026-07-24",
        reminder_for: "2026-07-24",
      },
    });
    expect(sent[0].subject).toBe("Rok danas: Poslati ponudu");
  });

  it("meeting_reminder → 'Sutra: … u HH:MM'", async () => {
    const { sent } = await runOne({
      kind: "meeting_reminder",
      payload: {
        naslov: "Kolegijum",
        datum: "2026-07-24",
        vreme: "09:00",
        sastanak_id: SAST_ID,
      },
    });
    expect(sent[0].subject).toBe("Sutra: Kolegijum u 09:00");
    expect(sent[0].html).toContain("Podsetnik za sastanak");
  });

  it("meeting_prep_reminder → 'Podsetnik: pripremi se za …' + zaduženja iz v_akcioni_plan", async () => {
    const { sent, m } = await runOne(
      {
        kind: "meeting_prep_reminder",
        related_sastanak_id: SAST_ID,
        payload: {
          naslov: "Kolegijum",
          datum: "2026-07-24",
          sastanak_id: SAST_ID,
        },
      },
      [
        [
          {
            naslov: "Zatvoriti reklamaciju",
            rok: "2026-07-30",
            rok_text: null,
            effective_status: "kasni",
          },
        ],
      ],
    );
    expect(sent[0].subject).toBe('Podsetnik: pripremi se za „Kolegijum"');
    expect(sent[0].html).toContain("Zatvoriti reklamaciju");
    expect(sent[0].html).toContain("30.07.2026"); // rok::text → DD.MM.YYYY
    expect(sent[0].html).toContain("(kasni)");
    // prep podsetnik NE traži rsvp token (samo pozivnica).
    expect(m.find("sastanak_ucesnici")).toHaveLength(0);
  });

  it("meeting_cancel → 'Otkazano: …' (precrtan naslov, datum sa tačkom)", async () => {
    const { sent } = await runOne({
      kind: "meeting_cancel",
      payload: { naslov: "Kolegijum", datum: "2026-07-24", vreme: "09:00" },
    });
    expect(sent[0].subject).toBe("Otkazano: Kolegijum");
    expect(sent[0].html).toContain("line-through");
    expect(sent[0].html).toContain("24.07.2026.");
    // Paritet 1.0 (poznat gap): otkazivanje NEMA .ics CANCEL prilog.
    expect(sent[0].attachments).toBeUndefined();
  });

  it("nepoznat kind → fallback šablon 'Obaveštenje: <kind>'", async () => {
    const { sent } = await runOne({ kind: "nesto_novo", payload: {} });
    expect(sent[0].subject).toBe("Obaveštenje: nesto_novo");
    expect(sent[0].html).toContain("Obaveštenje iz Servoteh sistema");
  });

  it("HTML iz payload-a je escape-ovan (XSS u naslovu ne razbija mejl svim učesnicima)", async () => {
    const { sent } = await runOne({
      kind: "akcija_new",
      payload: { naslov: '<img src=x onerror="alert(1)">' },
    });
    expect(sent[0].html).not.toContain("<img src=x");
    expect(sent[0].html).toContain("&lt;img src=x");
  });
});

describe("deep-linkovi u mejlu (FIX mrtvih 404 linkova)", () => {
  async function htmlFor(over: Partial<Record<string, unknown>>) {
    const m = sy15Mock();
    m.pushResult([row(over)]);
    const { mail, sent } = mailMock();
    await new SastanciDispatchService(
      m.sy15,
      mail,
      storageMock().storage,
    ).dispatchSastanci();
    return sent[0];
  }

  it("CTA na detalj je `?open=<id>` — NIKAD stari `sastanci/<uuid>` (404)", async () => {
    const p = await htmlFor({
      kind: "meeting_reminder",
      payload: { naslov: "K", datum: "2026-07-24", sastanak_id: SAST_ID },
    });
    expect(p.html).toContain(`${APP}sastanci?open=${SAST_ID}`);
    expect(p.text).toContain(`${APP}sastanci?open=${SAST_ID}`);
    expect(p.html).not.toContain(`${APP}sastanci/${SAST_ID}`);
  });

  it("bez sastanak_id → link je lista `/sastanci` (bez repa)", async () => {
    const p = await htmlFor({
      kind: "meeting_reminder",
      payload: { naslov: "K", datum: "2026-07-24" },
    });
    expect(p.text).toContain(`${APP}sastanci\n`);
    expect(p.html).not.toContain("sastanci?open=");
  });

  it("footer 'Promeni podešavanja notifikacija' vodi na `?tab=podesavanja`", async () => {
    const p = await htmlFor({ kind: "akcija_new", payload: { naslov: "A" } });
    expect(p.html).toContain(`${APP}sastanci?tab=podesavanja`);
    expect(p.html).not.toContain("podesavanja-notifikacija");
    expect(p.text).toContain(`${APP}sastanci?tab=podesavanja`);
  });

  it("bez PUBLIC_APP_URL pada na SY15_APP_URL i uvek dodaje završni '/'", async () => {
    delete process.env.PUBLIC_APP_URL;
    process.env.SY15_APP_URL = "https://servosync.servoteh.com";
    const p = await htmlFor({ kind: "akcija_new", payload: { naslov: "A" } });
    expect(p.html).toContain(
      "https://servosync.servoteh.com/sastanci?tab=podesavanja",
    );
  });
});

describe("meeting_invite — RSVP linkovi i .ics", () => {
  async function invite(
    over: Partial<Record<string, unknown>>,
    results: unknown[][],
  ) {
    const m = sy15Mock();
    m.pushResult([
      row({
        kind: "meeting_invite",
        related_sastanak_id: SAST_ID,
        payload: {
          naslov: "Kolegijum",
          datum: "2026-07-24",
          vreme: "09:30",
          mesto: "Sala 1",
          organizator: "sef@servoteh.com",
          sastanak_id: SAST_ID,
        },
        ...over,
      }),
    ]);
    for (const r of results) m.pushResult(r);
    const { mail, sent } = mailMock();
    const svc = new SastanciDispatchService(
      m.sy15,
      mail,
      storageMock().storage,
    );
    await svc.dispatchSastanci();
    return { m, sent };
  }

  it("sa tokenom: RSVP dugmad nose TAČAN sy15 edge URL (RSVP tok ostaje na sy15)", async () => {
    const { sent, m } = await invite({}, [[], [{ rsvp_token: "tok-123" }]]);
    const base = `${FN_BASE}/sastanci-rsvp`;
    expect(sent[0].html).toContain(`${base}?t=tok-123&amp;r=dolazim`);
    expect(sent[0].html).toContain(`${base}?t=tok-123&amp;r=ne_dolazim`);
    expect(sent[0].text).toContain(`${base}?t=tok-123&r=dolazim`);
    expect(sent[0].html).toContain("Potvrda dolaska");

    // Token se traži u JEDNINSKOJ tabeli `sastanak_ucesnici`, mejl u lowercase.
    const q = m.find("sastanak_ucesnici");
    expect(q).toHaveLength(1);
    expect(q[0].values).toEqual([SAST_ID, "pera@servoteh.com"]);
  });

  it("token se URL-enkodira", async () => {
    const { sent } = await invite({}, [[], [{ rsvp_token: "a b/c" }]]);
    expect(sent[0].html).toContain("?t=a%20b%2Fc&amp;r=dolazim");
  });

  it("RSVP baza NIKAD ne dolazi iz SY15_REST_URL (prod je LAN → dugmad mrtva van firme)", async () => {
    const { sent } = await invite({}, [[], [{ rsvp_token: "tok-123" }]]);
    expect(sent[0].html).not.toContain("192.168.");
    expect(sent[0].html).not.toContain(":8090");
    expect(sent[0].text).not.toContain("192.168.");
  });

  it("bez SY15_FUNCTIONS_URL: baza se izvodi iz SY15_STORAGE_URL (/storage/v1 → /functions/v1)", async () => {
    delete process.env.SY15_FUNCTIONS_URL;
    process.env.SY15_STORAGE_URL =
      "https://api.servosync.servoteh.com/storage/v1";
    const { sent } = await invite({}, [[], [{ rsvp_token: "tok-123" }]]);
    expect(sent[0].html).toContain(`${FN_BASE}/sastanci-rsvp?t=tok-123`);
    expect(sent[0].html).not.toContain("storage/v1");
    expect(sent[0].html).not.toContain("192.168.");
  });

  it("bez oba: poslednja slamka je izvođenje iz SY15_REST_URL", async () => {
    delete process.env.SY15_FUNCTIONS_URL;
    process.env.SY15_REST_URL = "https://api.servosync.servoteh.com/rest/v1";
    const { sent } = await invite({}, [[], [{ rsvp_token: "tok-123" }]]);
    expect(sent[0].html).toContain(`${FN_BASE}/sastanci-rsvp?t=tok-123`);
  });

  it("SY15_FUNCTIONS_URL sa završnim '/' ne pravi dupli separator", async () => {
    process.env.SY15_FUNCTIONS_URL = `${FN_BASE}/`;
    const { sent } = await invite({}, [[], [{ rsvp_token: "tok-123" }]]);
    expect(sent[0].html).toContain(`${FN_BASE}/sastanci-rsvp?t=tok-123`);
    expect(sent[0].html).not.toContain("v1//sastanci-rsvp");
  });

  it("bez tokena: nema RSVP sekcije, pozivnica ide normalno", async () => {
    const { sent } = await invite({}, [[], []]);
    expect(sent[0].html).not.toContain("Potvrda dolaska");
    expect(sent[0].html).not.toContain("sastanci-rsvp");
    expect(sent[0].subject).toBe("Pozivnica: Kolegijum — 24.07.2026");
  });

  it(".ics prilog: VEVENT sa TZID Europe/Belgrade, +1h, ATTENDEE i `?open=` u opisu", async () => {
    const { sent } = await invite({}, [[], []]);
    const att = sent[0].attachments;
    expect(att).toHaveLength(1);
    expect(att?.[0].filename).toBe("sastanak.ics");
    const ics = att![0].content.toString("utf8");
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toContain("METHOD:REQUEST");
    expect(ics).toContain(`UID:${SAST_ID}@servosync.servoteh.com`);
    expect(ics).toContain("DTSTART;TZID=Europe/Belgrade:20260724T093000");
    expect(ics).toContain("DTEND;TZID=Europe/Belgrade:20260724T103000");
    expect(ics).toContain("ORGANIZER:mailto:sef@servoteh.com");
    expect(ics).toContain(
      "ATTENDEE;ROLE=REQ-PARTICIPANT;RSVP=TRUE:mailto:pera@servoteh.com",
    );
    expect(ics).toContain(`sastanci?open=${SAST_ID}`);
    expect(ics).not.toContain(`sastanci/${SAST_ID}`);
  });

  it("neispravan datum → nema .ics priloga (mejl ipak ide)", async () => {
    const { sent } = await invite({ payload: { naslov: "K", datum: "" } }, [
      [],
      [],
    ]);
    expect(sent[0].attachments).toBeUndefined();
    expect(sent[0].subject).toContain("Pozivnica");
  });

  it("replyTo = organizator (kad ima @); prosleđuje se MailService-u", async () => {
    const { sent } = await invite({}, [[], []]);
    expect(sent[0].replyTo).toBe("sef@servoteh.com");
    expect(sent[0].text).toBeTruthy(); // multipart: html + text
  });

  it("organizator bez @ → nema replyTo", async () => {
    const { sent } = await invite(
      { payload: { naslov: "K", datum: "2026-07-24", organizator: "sef" } },
      [[], []],
    );
    expect(sent[0].replyTo).toBeUndefined();
  });

  it("zaduženja se traže po odgovoran_email (lowercase) sa limitom 30", async () => {
    const { m } = await invite({}, [[], []]);
    const q = m.find("v_akcioni_plan");
    expect(q).toHaveLength(1);
    expect(q[0].sql).toContain("odgovoran_email");
    expect(q[0].sql).toContain("NULLS LAST");
    expect(q[0].sql).toContain("LIMIT 30");
    expect(q[0].values).toEqual(["pera@servoteh.com"]);
  });
});

describe("meeting_locked — PDF zapisnik, defer grana i diff", () => {
  function lockedMock(
    attempts: number,
    results: unknown[][],
    payload: Record<string, unknown> = {
      naslov: "Kolegijum",
      datum: "2026-07-24",
    },
  ) {
    const m = sy15Mock();
    m.pushResult([
      row({
        kind: "meeting_locked",
        attempts,
        related_sastanak_id: SAST_ID,
        payload,
      }),
    ]);
    for (const r of results) m.pushResult(r);
    return m;
  }

  it("PDF postoji → prilog `Zapisnik-DD-MM-YYYY.pdf` iz bucket-a 'sastanci-arhiva'", async () => {
    const m = lockedMock(0, [
      [],
      [],
      [{ zapisnik_storage_path: "2026/k.pdf" }],
    ]);
    const { mail, sent } = mailMock();
    const { storage, download } = storageMock(new Uint8Array([1, 2]));
    await new SastanciDispatchService(m.sy15, mail, storage).dispatchSastanci();

    expect(download).toHaveBeenCalledWith("sastanci-arhiva", "2026/k.pdf");
    expect(sent[0].attachments).toHaveLength(1);
    expect(sent[0].attachments?.[0].filename).toBe("Zapisnik-24-07-2026.pdf");
    expect(Buffer.isBuffer(sent[0].attachments?.[0].content)).toBe(true);
    expect(m.find("sastanci_dispatch_mark_sent")).toHaveLength(1);
  });

  it("PDF još nema, attempts=1 → NE šalje, mark_failed sa backoff-om 60s", async () => {
    const m = lockedMock(1, [[], [], []]); // arhiva prazna
    const { mail, send } = mailMock();
    const r = await new SastanciDispatchService(
      m.sy15,
      mail,
      storageMock().storage,
    ).dispatchSastanci();

    expect(r).toMatchObject({ processed: 1, sent: 0, failed: 1 });
    expect(send).not.toHaveBeenCalled();
    const failed = m.find("sastanci_dispatch_mark_failed");
    expect(failed).toHaveLength(1);
    expect(String(failed[0].values[1])).toContain(
      "PDF zapisnik još nije spreman",
    );
    expect(failed[0].values[2]).toBe(60); // kratak defer, ne eksponencijalni backoff
    expect(m.find("sastanci_dispatch_mark_sent")).toHaveLength(0);
  });

  it("PDF još nema, attempts=3 → ŠALJE bez priloga (samo-link verzija)", async () => {
    const m = lockedMock(3, [[], [], []]);
    const { mail, send, sent } = mailMock();
    const r = await new SastanciDispatchService(
      m.sy15,
      mail,
      storageMock().storage,
    ).dispatchSastanci();

    expect(r).toMatchObject({ processed: 1, sent: 1, failed: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(sent[0].attachments).toBeUndefined();
    expect(sent[0].html).toContain("Ako prilog nije vidljiv");
    expect(m.find("sastanci_dispatch_mark_sent")).toHaveLength(1);
  });

  it("Storage padne pri attempts=3 → prilog fail-soft, mejl IPAK ide", async () => {
    const m = lockedMock(3, [[], [], [{ zapisnik_storage_path: "a/b.pdf" }]]);
    const { mail, sent } = mailMock();
    const storage = {
      download: jest.fn().mockRejectedValue(new Error("storage 404")),
    } as unknown as Sy15StorageService;

    const r = await new SastanciDispatchService(
      m.sy15,
      mail,
      storage,
    ).dispatchSastanci();
    expect(r).toMatchObject({ sent: 1, failed: 0 });
    expect(sent[0].attachments).toBeUndefined();
  });

  it("diff rezime: prethodni zaključan sastanak + brojanje po v_akcioni_plan", async () => {
    const m = lockedMock(3, [
      [{ zakljucan_at: "2026-07-01T10:00:00.000Z" }],
      [
        {
          status: "otvoren",
          effective_status: "otvoren",
          created_at: "2026-07-10T08:00:00.000Z",
          zatvoren_at: null,
        },
        {
          status: "zavrsen",
          effective_status: "zavrsen",
          created_at: "2026-06-01T08:00:00.000Z",
          zatvoren_at: "2026-07-05T08:00:00.000Z",
        },
        {
          status: "u_toku",
          effective_status: "kasni",
          created_at: "2026-06-01T08:00:00.000Z",
          zatvoren_at: null,
        },
      ],
      [],
    ]);
    const { mail, sent } = mailMock();
    await new SastanciDispatchService(
      m.sy15,
      mail,
      storageMock().storage,
    ).dispatchSastanci();

    expect(sent[0].html).toContain("▲ 1 novo");
    expect(sent[0].html).toContain("✓ 1 završeno");
    expect(sent[0].html).toContain("⚠ 1 kasni");
    expect(sent[0].html).toContain("2 aktivnih");
    expect(sent[0].text).toContain(
      "Od prošlog sastanka: 1 novo, 1 završeno, 1 kasni, 2 aktivnih.",
    );
    // Bez `datum_termina` u payload-u sidro pada na `datum` (redovi ukvačeni
    // pre 014/26 izmene RPC-a) — grana `?? datum`.
    expect(m.calls[1].values).toEqual(["2026-07-24", SAST_ID]);

    // Prethodni sastanak: status='zakljucan', datum < tekući, id različit.
    const q = m.calls[1];
    expect(q.sql).toContain("public.sastanci");
    expect(q.sql).toContain("zakljucan");
    expect(q.values).toEqual(["2026-07-24", SAST_ID]);
  });

  it("sidro rezimea je `datum_termina` (ZAKAZANI termin), NE promenljiv datum zapisnika", async () => {
    // 014/26: rukovodstvo sme da ispravi `zapisnik_datum` → `payload.datum` klizi.
    // „Prethodni zaključan sastanak" se zato traži po `datum_termina`.
    const m = lockedMock(
      3,
      [[{ zakljucan_at: "2026-07-01T10:00:00.000Z" }], [], []],
      {
        naslov: "Kolegijum",
        datum: "2026-07-31", // ispravljen datum ZAPISNIKA (vidljiv korisniku)
        datum_termina: "2026-07-24", // stvaran termin — sidro
      },
    );
    const { mail, sent } = mailMock();
    await new SastanciDispatchService(
      m.sy15,
      mail,
      storageMock().storage,
    ).dispatchSastanci();

    // Upit za prethodni sastanak ide po TERMINU, ne po datumu zapisnika.
    expect(m.calls[1].values).toEqual(["2026-07-24", SAST_ID]);
    expect(m.calls[1].values).not.toContain("2026-07-31");
    // Telo mejla i dalje prikazuje datum ZAPISNIKA — to je i cilj 014/26.
    expect(sent[0].text).toContain("Datum: 31.07.2026");
  });

  it("naziv PDF priloga ide po datumu ZAPISNIKA, ne po `datum_termina`", async () => {
    const m = lockedMock(
      0,
      [[], [], [{ zapisnik_storage_path: "2026/k.pdf" }]],
      {
        naslov: "Kolegijum",
        datum: "2026-07-31",
        datum_termina: "2026-07-24",
      },
    );
    const { mail, sent } = mailMock();
    await new SastanciDispatchService(
      m.sy15,
      mail,
      storageMock().storage,
    ).dispatchSastanci();
    expect(sent[0].attachments?.[0].filename).toBe("Zapisnik-31-07-2026.pdf");
  });

  it("timestamp kao Date objekat (Prisma raw) daje isti diff kao ISO string", async () => {
    const m = lockedMock(3, [
      [{ zakljucan_at: new Date("2026-07-01T10:00:00.000Z") }],
      [
        {
          status: "otvoren",
          effective_status: "otvoren",
          created_at: new Date("2026-07-10T08:00:00.000Z"),
          zatvoren_at: null,
        },
      ],
      [],
    ]);
    const { mail, sent } = mailMock();
    await new SastanciDispatchService(
      m.sy15,
      mail,
      storageMock().storage,
    ).dispatchSastanci();
    expect(sent[0].html).toContain("▲ 1 novo");
    expect(sent[0].html).toContain("1 aktivnih");
  });

  it("bez prethodnog sastanka: novo/završeno ostaju 0, aktivni se i dalje broje", async () => {
    const m = lockedMock(3, [
      [],
      [
        {
          status: "otvoren",
          effective_status: "otvoren",
          created_at: "2026-07-10T08:00:00.000Z",
          zatvoren_at: null,
        },
      ],
      [],
    ]);
    const { mail, sent } = mailMock();
    await new SastanciDispatchService(
      m.sy15,
      mail,
      storageMock().storage,
    ).dispatchSastanci();
    expect(sent[0].text).toContain(
      "Od prošlog sastanka: 0 novo, 0 završeno, 0 kasni, 1 aktivnih.",
    );
  });
});

describe("kanali, DRY-RUN i greške", () => {
  it("whatsapp red → permanent fail (kanal nije implementiran), backoff ~godina", async () => {
    const m = sy15Mock();
    m.pushResult([row({ channel: "whatsapp" })]);
    const { mail, send } = mailMock();
    const r = await new SastanciDispatchService(
      m.sy15,
      mail,
      storageMock().storage,
    ).dispatchSastanci();

    expect(r).toEqual({
      processed: 1,
      sent: 0,
      failed: 1,
      skipped: 0,
      skippedWa: 1,
    });
    expect(send).not.toHaveBeenCalled();
    const failed = m.find("sastanci_dispatch_mark_failed");
    expect(String(failed[0].values[1])).toContain("WhatsApp not enabled");
    expect(failed[0].values[2]).toBe(365 * 24 * 3600);
    expect(m.find("sastanci_dispatch_mark_sent")).toHaveLength(0);
  });

  it("nepodržan kanal (sms) → DRY-RUN mark_sent, broji se u skipped", async () => {
    const m = sy15Mock();
    m.pushResult([row({ channel: "sms" })]);
    const { mail, send } = mailMock();
    const r = await new SastanciDispatchService(
      m.sy15,
      mail,
      storageMock().storage,
    ).dispatchSastanci();

    expect(r).toMatchObject({ processed: 1, sent: 1, failed: 0, skipped: 1 });
    expect(send).not.toHaveBeenCalled();
    expect(m.find("sastanci_dispatch_mark_sent")).toHaveLength(1);
  });

  it("nekonfigurisan mejler → DRY-RUN mark_sent (edge paritet), ne mark_failed", async () => {
    const m = sy15Mock();
    m.pushResult([row()]);
    const { mail, send } = mailMock(false);
    const r = await new SastanciDispatchService(
      m.sy15,
      mail,
      storageMock().storage,
    ).dispatchSastanci();

    expect(r).toMatchObject({ sent: 1, failed: 0, skipped: 0 });
    expect(send).not.toHaveBeenCalled();
    expect(m.find("sastanci_dispatch_mark_sent")).toHaveLength(1);
    expect(m.find("sastanci_dispatch_mark_failed")).toHaveLength(0);
  });

  it("Resend padne → mark_failed sa eksponencijalnim backoff-om", async () => {
    const m = sy15Mock();
    m.pushResult([row()]);
    const r = await new SastanciDispatchService(
      m.sy15,
      mailMock(true, false).mail,
      storageMock().storage,
    ).dispatchSastanci();

    expect(r).toMatchObject({ sent: 0, failed: 1 });
    const failed = m.find("sastanci_dispatch_mark_failed");
    expect(failed[0].values).toEqual([ID_A, "resend send failed", 300]);
  });

  it("backoff raste 300→600→1200 i staje na 6h (21600)", async () => {
    const run = async (attempts: number) => {
      const m = sy15Mock();
      m.pushResult([row({ attempts })]);
      await new SastanciDispatchService(
        m.sy15,
        mailMock(true, false).mail,
        storageMock().storage,
      ).dispatchSastanci();
      return m.find("sastanci_dispatch_mark_failed")[0].values[2];
    };
    expect(await run(0)).toBe(300);
    expect(await run(1)).toBe(600);
    expect(await run(2)).toBe(1200);
    expect(await run(10)).toBe(21600); // cap 6h
  });

  it("izuzetak usred reda → mark_failed, ostali redovi se i dalje obrađuju", async () => {
    const m = sy15Mock();
    m.pushResult([row({ id: ID_A }), row({ id: ID_B })]);
    const sentOk: MailParams[] = [];
    const mail = {
      configured: true,
      send: jest.fn((p: MailParams) => {
        if (sentOk.length === 0) {
          sentOk.push(p);
          return Promise.reject(new Error("boom"));
        }
        return Promise.resolve(true);
      }),
    } as unknown as MailService;

    const r = await new SastanciDispatchService(
      m.sy15,
      mail,
      storageMock().storage,
    ).dispatchSastanci();
    expect(r).toMatchObject({ processed: 2, sent: 1, failed: 1 });
    expect(
      String(m.find("sastanci_dispatch_mark_failed")[0].values[1]),
    ).toContain("boom");
    expect(m.find("sastanci_dispatch_mark_sent")[0].values).toEqual([ID_B]);
  });

  it("prazan red → nema poziva posle dequeue-a", async () => {
    const m = sy15Mock();
    m.pushResult([]);
    const r = await new SastanciDispatchService(
      m.sy15,
      mailMock().mail,
      storageMock().storage,
    ).dispatchSastanci();
    expect(r).toEqual({
      processed: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
      skippedWa: 0,
    });
    expect(m.calls).toHaveLength(1);
    expect(m.sqlOf(0)).toContain("sastanci_dispatch_dequeue");
  });
});

describe("sy15 RPC omotači i redosled", () => {
  it("dequeue nosi batch 25 / max_attempts 5 (edge default-i)", async () => {
    const m = sy15Mock();
    m.pushResult([]);
    await new SastanciDispatchService(
      m.sy15,
      mailMock().mail,
      storageMock().storage,
    ).dispatchSastanci();
    expect(m.calls[0].sql).toContain("sastanci_dispatch_dequeue");
    expect(m.calls[0].values).toEqual([25, 5]);
  });

  it("mark_sent ide PER-ROW i ODMAH (A → B), sa ARRAY[id] potpisom", async () => {
    const m = sy15Mock();
    m.pushResult([row({ id: ID_A }), row({ id: ID_B })]);
    await new SastanciDispatchService(
      m.sy15,
      mailMock().mail,
      storageMock().storage,
    ).dispatchSastanci();

    expect(m.sqlOf(0)).toContain("sastanci_dispatch_dequeue");
    expect(m.sqlOf(1)).toContain("sastanci_dispatch_mark_sent");
    expect(m.calls[1].sql).toContain("ARRAY[");
    expect(m.calls[1].values).toEqual([ID_A]);
    expect(m.sqlOf(2)).toContain("sastanci_dispatch_mark_sent");
    expect(m.calls[2].values).toEqual([ID_B]);
  });

  it("mark_failed je VOID fn → poziva se sa `::text` cast-om (Prisma pravilo)", async () => {
    const m = sy15Mock();
    m.pushResult([row()]);
    await new SastanciDispatchService(
      m.sy15,
      mailMock(true, false).mail,
      storageMock().storage,
    ).dispatchSastanci();
    expect(m.find("sastanci_dispatch_mark_failed")[0].sql).toContain("::text");
  });
});

describe("privatnost logova", () => {
  const EMAIL = "pera.detaljic@servoteh.com";

  function captureLogs(): string[] {
    const lines: string[] = [];
    for (const lvl of ["debug", "warn", "log", "error"] as const) {
      jest
        .spyOn(Logger.prototype, lvl)
        .mockImplementation((msg: unknown): void => {
          lines.push(String(msg));
        });
    }
    return lines;
  }

  it("log NIKAD ne sadrži pun mejl primaoca (samo maskiran prefiks)", async () => {
    const lines = captureLogs();
    const m = sy15Mock();
    m.pushResult([
      row({ id: ID_A, recipient_email: EMAIL }),
      row({ id: ID_B, channel: "sms", recipient_email: EMAIL }),
    ]);
    await new SastanciDispatchService(
      m.sy15,
      mailMock(false).mail,
      storageMock().storage,
    ).dispatchSastanci();

    const all = lines.join(" || ");
    expect(lines.length).toBeGreaterThan(0);
    expect(all).not.toContain(EMAIL);
    expect(all).toContain("per…");
  });
});

describe("prekidač SASTANCI_IZVOR — red outbox-a (seoba 05.08)", () => {
  /** Servis sa punim setom 3.0 mock-ova; `rows` je ono što dequeue vrati. */
  function make(rows: Array<Record<string, unknown>> = []) {
    const m = sy15Mock();
    const { mail, send, sent } = mailMock();
    const p = prismaMock();
    const fn = sastFnMock(rows);
    const svc = new SastanciDispatchService(
      m.sy15,
      mail,
      storageMock().storage,
      new SastanciSourceService(),
      p.prisma,
      fn.sastFn,
    );
    return { svc, m, send, sent, p, fn };
  }

  it("izvor=3.0: dequeue ide kroz SastanciFnService u 3.0 transakciji, NE na sy15", async () => {
    process.env.SASTANCI_IZVOR = "3.0";
    const { svc, m, fn, p } = make([]);

    const r = await svc.dispatchSastanci();
    expect(r).toMatchObject({ processed: 0 });
    expect(fn.dispatchDequeue).toHaveBeenCalledTimes(1);
    // Isti default-i kao sy15 fn (batch 25, max_attempts 5).
    expect(fn.dispatchDequeue.mock.calls[0].slice(1)).toEqual([25, 5]);
    expect(p.$transaction).toHaveBeenCalledTimes(1);
    // NIJEDAN sy15 upit — inače bi red bio čitan iz jedne, a pisan u drugu bazu.
    expect(m.calls).toHaveLength(0);
  });

  it("izvor=3.0: mark_sent ide kroz prepis (ARRAY potpis), a ne na sy15 RPC", async () => {
    process.env.SASTANCI_IZVOR = "3.0";
    const { svc, m, fn, sent } = make([row({ id: ID_A })]);

    const r = await svc.dispatchSastanci();
    expect(r).toMatchObject({ processed: 1, sent: 1, failed: 0 });
    expect(sent).toHaveLength(1);
    expect(fn.dispatchMarkSent).toHaveBeenCalledTimes(1);
    expect(fn.dispatchMarkSent.mock.calls[0][1]).toEqual([ID_A]);
    expect(m.find("sastanci_dispatch_mark_sent")).toHaveLength(0);
    expect(m.find("sastanci_dispatch_dequeue")).toHaveLength(0);
  });

  it("izvor=3.0: mark_failed ide kroz prepis, sa ISTIM backoff-om kao sy15 put", async () => {
    process.env.SASTANCI_IZVOR = "3.0";
    const m = sy15Mock();
    const p = prismaMock();
    const fn = sastFnMock([row({ id: ID_A, attempts: 1 })]);
    const svc = new SastanciDispatchService(
      m.sy15,
      mailMock(true, false).mail, // Resend pada
      storageMock().storage,
      new SastanciSourceService(),
      p.prisma,
      fn.sastFn,
    );

    const r = await svc.dispatchSastanci();
    expect(r).toMatchObject({ sent: 0, failed: 1 });
    expect(fn.dispatchMarkFailed).toHaveBeenCalledTimes(1);
    // (tx, id, error, backoffSec) — 300 * 2^(2-1) = 600 za attempts=1.
    expect(fn.dispatchMarkFailed.mock.calls[0].slice(1)).toEqual([
      ID_A,
      "resend send failed",
      600,
    ]);
    expect(m.find("sastanci_dispatch_mark_failed")).toHaveLength(0);
  });

  it("izvor=3.0: whatsapp red i dalje pada permanentno (backoff ~godina) — kroz prepis", async () => {
    process.env.SASTANCI_IZVOR = "3.0";
    const { svc, fn, send } = make([row({ channel: "whatsapp" })]);

    const r = await svc.dispatchSastanci();
    expect(r).toMatchObject({ failed: 1, skippedWa: 1 });
    expect(send).not.toHaveBeenCalled();
    expect(fn.dispatchMarkFailed.mock.calls[0][3]).toBe(365 * 24 * 3600);
  });

  it("izvor=sy15 (podrazumevano): sve tri tačke idu STARIM putem, prepis se ne dira", async () => {
    delete process.env.SASTANCI_IZVOR;
    const m = sy15Mock();
    m.pushResult([row({ id: ID_A })]);
    const p = prismaMock();
    const fn = sastFnMock();
    const svc = new SastanciDispatchService(
      m.sy15,
      mailMock().mail,
      storageMock().storage,
      new SastanciSourceService(),
      p.prisma,
      fn.sastFn,
    );

    const r = await svc.dispatchSastanci();
    expect(r).toMatchObject({ processed: 1, sent: 1 });
    expect(m.sqlOf(0)).toContain("sastanci_dispatch_dequeue");
    expect(m.find("sastanci_dispatch_mark_sent")).toHaveLength(1);
    expect(fn.dispatchDequeue).not.toHaveBeenCalled();
    expect(fn.dispatchMarkSent).not.toHaveBeenCalled();
    expect(p.$transaction).not.toHaveBeenCalled();
  });

  it("nepoznata vrednost prekidača NE pali 3.0 granu (pada na bezbedan sy15)", async () => {
    process.env.SASTANCI_IZVOR = "30";
    const m = sy15Mock();
    m.pushResult([]);
    const fn = sastFnMock();
    await new SastanciDispatchService(
      m.sy15,
      mailMock().mail,
      storageMock().storage,
      new SastanciSourceService(),
      prismaMock().prisma,
      fn.sastFn,
    ).dispatchSastanci();

    expect(m.sqlOf(0)).toContain("sastanci_dispatch_dequeue");
    expect(fn.dispatchDequeue).not.toHaveBeenCalled();
  });
});

/*
 * RSVP magic-link „Dolazim / Ne dolazim" mora da vodi u bazu koja je VLASNIK
 * `sastanak_ucesnici`, jer klik piše `rsvp_status`/`rsvp_at`. Tokeni su u seobi
 * preneti DOSLOVNO, pa isti `t` postoji u obe baze — i baš zato bi pogrešan host
 * u linku tiho pisao u bazu koja nije izvor istine. Ovi testovi to pinuju.
 */
describe("prekidač SASTANCI_IZVOR — RSVP link u pozivnici", () => {
  /** Podrazumevana javna baza 3.0 API-ja (prod; docs/infra/INFRASTRUKTURA.md §6). */
  const API_30 = "https://api.servosync2.servoteh.com/api/v1/sastanci-rsvp";

  async function invite30(rsvpToken: string | null) {
    const m = sy15Mock();
    const { mail, sent } = mailMock();
    const p = prismaMock(rsvpToken);
    const fn = sastFnMock([
      row({
        kind: "meeting_invite",
        related_sastanak_id: SAST_ID,
        payload: {
          naslov: "Kolegijum",
          datum: "2026-07-24",
          vreme: "09:30",
          sastanak_id: SAST_ID,
        },
      }),
    ]);
    const svc = new SastanciDispatchService(
      m.sy15,
      mail,
      storageMock().storage,
      new SastanciSourceService(),
      p.prisma,
      fn.sastFn,
    );
    await svc.dispatchSastanci();
    return { sent, m, p };
  }

  it("izvor=3.0: dugmad vode na 3.0 JAVNU rutu, ne na sy15 edge", async () => {
    process.env.SASTANCI_IZVOR = "3.0";
    const { sent } = await invite30("tok-123");

    expect(sent[0].html).toContain(`${API_30}?t=tok-123&amp;r=dolazim`);
    expect(sent[0].html).toContain(`${API_30}?t=tok-123&amp;r=ne_dolazim`);
    expect(sent[0].text).toContain(`${API_30}?t=tok-123&r=dolazim`);
    expect(sent[0].html).not.toContain("functions/v1");
  });

  it("izvor=3.0: PUBLIC_API_URL presuđuje bazu (i završna '/' ne pravi dupli separator)", async () => {
    process.env.SASTANCI_IZVOR = "3.0";
    process.env.PUBLIC_API_URL = "https://api.test.servoteh.com/api/";
    const { sent } = await invite30("tok-123");

    expect(sent[0].html).toContain(
      "https://api.test.servoteh.com/api/v1/sastanci-rsvp?t=tok-123&amp;r=dolazim",
    );
    expect(sent[0].html).not.toContain("api//v1");
  });

  it("🔴 izvor=3.0: RSVP link NE ide na front (worker ne proksira /api → 404, mrtva dugmad)", async () => {
    process.env.SASTANCI_IZVOR = "3.0";
    process.env.PUBLIC_APP_URL = "https://servosync2.servoteh.com/";
    const { sent } = await invite30("tok-123");

    expect(sent[0].html).not.toContain(
      "https://servosync2.servoteh.com/api/v1/sastanci-rsvp",
    );
    expect(sent[0].html).toContain(`${API_30}?t=tok-123`);
  });

  it("izvor=3.0: token se čita iz 3.0 baze, a NE sa sy15 (novi učesnik u sy15 ne postoji)", async () => {
    process.env.SASTANCI_IZVOR = "3.0";
    const { p, m } = await invite30("tok-123");

    expect(p.findFirst).toHaveBeenCalledWith({
      where: { sastanakId: SAST_ID, email: "pera@servoteh.com" },
      select: { rsvpToken: true },
    });
    expect(m.find("sastanak_ucesnici")).toHaveLength(0);
  });

  it("izvor=3.0 bez tokena: pozivnica ide bez RSVP sekcije (ne pada)", async () => {
    process.env.SASTANCI_IZVOR = "3.0";
    const { sent } = await invite30(null);

    expect(sent).toHaveLength(1);
    expect(sent[0].html).not.toContain("sastanci-rsvp");
  });

  it("izvor=sy15 (podrazumevano): link ostaje na sy15 edge fn", async () => {
    delete process.env.SASTANCI_IZVOR;
    const m = sy15Mock();
    m.pushResult([
      row({
        kind: "meeting_invite",
        related_sastanak_id: SAST_ID,
        payload: { naslov: "Kolegijum", datum: "2026-07-24", vreme: "09:30" },
      }),
    ]);
    m.pushResult([]); // zaduženja
    m.pushResult([{ rsvp_token: "tok-123" }]); // token sa sy15
    const { mail, sent } = mailMock();
    await new SastanciDispatchService(
      m.sy15,
      mail,
      storageMock().storage,
    ).dispatchSastanci();

    expect(sent[0].html).toContain(
      `${FN_BASE}/sastanci-rsvp?t=tok-123&amp;r=dolazim`,
    );
    expect(sent[0].html).not.toContain("servosync2.servoteh.com");
  });
});
