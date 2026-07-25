import { Logger } from "@nestjs/common";
import { NotifyDispatchService } from "./notify-dispatch.service";
import type { MailService } from "../../../common/mail/mail.service";
import type { Sy15Service } from "../../../common/sy15/sy15.service";
import type { Sy15StorageService } from "../../../common/sy15/sy15-storage.service";

/*
 * Talas A-2a — dispatch worker. Testiramo PARITET sa 1.0 edge fn:
 * per-row mark_sent odmah, tačan backoff, oblik WA poziva, DRY-RUN kanali,
 * maint fanout stub, pb digest grupisanje i gate (DISPATCH_ENABLED).
 */

type MailParams = Parameters<MailService["send"]>[0];

/** Oblik Meta Graph tela — da assert-i ne rade nad `any`. */
interface WaBody {
  messaging_product: string;
  to: string;
  type: string;
  template: {
    name: string;
    language: { code: string };
    components: Array<{
      type: string;
      parameters: Array<{ type: string; text: string }>;
    }>;
  };
}

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
    .mockResolvedValue(bytes ?? new Uint8Array([1, 2, 3]));
  return { storage: { download } as unknown as Sy15StorageService, download };
}

type FetchSpy = jest.SpyInstance<Promise<Response>, Parameters<typeof fetch>>;

function waBodyOf(spy: FetchSpy, i = 0): WaBody {
  const init = spy.mock.calls[i][1] as RequestInit;
  return JSON.parse(init.body as string) as WaBody;
}

/** URL poziva kao string (prvi arg fetch-a je RequestInfo | URL). */
function fetchUrlOf(spy: FetchSpy, i = 0): string {
  return spy.mock.calls[i][0] as string;
}

const ID_A = "11111111-1111-1111-1111-111111111111";
const ID_B = "22222222-2222-2222-2222-222222222222";
const ID_C = "33333333-3333-3333-3333-333333333333";

const OLD_ENV = { ...process.env };
beforeEach(() => {
  process.env.DISPATCH_ENABLED = "true";
  delete process.env.WA_ACCESS_TOKEN;
  delete process.env.WA_PHONE_NUMBER_ID;
  delete process.env.WA_TEMPLATE_NAME;
  delete process.env.WA_TEMPLATE_LANG;
});
afterEach(() => {
  process.env = { ...OLD_ENV };
  jest.restoreAllMocks();
});

describe("NotifyDispatchService — gate (DISPATCH_ENABLED)", () => {
  it("bez DISPATCH_ENABLED: posao je no-op — NIJEDAN sy15 poziv, nijedan mejl", async () => {
    delete process.env.DISPATCH_ENABLED;
    const m = sy15Mock();
    const { mail, send } = mailMock();
    const svc = new NotifyDispatchService(m.sy15, mail, storageMock().storage);

    const jobs = svc.buildJobs();
    expect(jobs.map((j) => j.key)).toEqual([
      "kadr-notify-dispatch",
      "maint-notify-dispatch",
      "pb-notify-dispatch",
    ]);
    for (const j of jobs) {
      const summary = await j.run({ scheduledFor: new Date() });
      expect(String(summary)).toContain("dispatch OFF");
    }
    expect(m.calls).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("sva tri posla su na */5 min (everyMinutes 5)", () => {
    const svc = new NotifyDispatchService(
      sy15Mock().sy15,
      mailMock().mail,
      storageMock().storage,
    );
    for (const j of svc.buildJobs()) {
      expect(j.schedule).toEqual({ kind: "everyMinutes", minutes: 5 });
    }
  });
});

describe("dispatchKadr", () => {
  it("email happy put: šalje preko MailService i markira sent PER-ROW odmah", async () => {
    const m = sy15Mock();
    m.pushResult([
      {
        id: ID_A,
        channel: "email",
        recipient: "pera@servoteh.com",
        subject: "Lekarski ističe",
        body: "<p>telo</p>",
        attempts: 0,
        payload: null,
      },
      {
        id: ID_B,
        channel: "email",
        recipient: "mika@servoteh.com",
        subject: "Ugovor",
        body: "<p>drugo</p>",
        attempts: 0,
        payload: null,
      },
    ]);
    const { mail, send, sent } = mailMock();
    const svc = new NotifyDispatchService(m.sy15, mail, storageMock().storage);

    const r = await svc.dispatchKadr();
    expect(r).toEqual({ processed: 2, sent: 2, failed: 0, skipped: 0 });

    expect(send).toHaveBeenCalledTimes(2);
    expect(sent[0]).toMatchObject({
      to: "pera@servoteh.com",
      subject: "Lekarski ističe",
      html: "<p>telo</p>", // kadr telo je već gotov html — ne prepakuje se
    });
    // Dequeue → mark_sent(A) → mark_sent(B): markiranje ide ODMAH po redu.
    expect(m.sqlOf(0)).toContain("kadr_dispatch_dequeue");
    expect(m.sqlOf(1)).toContain("kadr_dispatch_mark_sent");
    expect(m.calls[1].values).toEqual([ID_A]);
    expect(m.sqlOf(2)).toContain("kadr_dispatch_mark_sent");
    expect(m.calls[2].values).toEqual([ID_B]);
    expect(m.find("kadr_dispatch_mark_failed")).toHaveLength(0);
  });

  it("mejl padne (Resend false) → mark_failed sa backoff-om 300s za attempts=0", async () => {
    const m = sy15Mock();
    m.pushResult([
      {
        id: ID_A,
        channel: "email",
        recipient: "pera@servoteh.com",
        subject: "s",
        body: "b",
        attempts: 0,
        payload: null,
      },
    ]);
    const svc = new NotifyDispatchService(
      m.sy15,
      mailMock(true, false).mail,
      storageMock().storage,
    );

    const r = await svc.dispatchKadr();
    expect(r).toMatchObject({ processed: 1, sent: 0, failed: 1 });

    const failed = m.find("kadr_dispatch_mark_failed");
    expect(failed).toHaveLength(1);
    // 300 * 2^(1-1) = 300 (prvi pokušaj)
    expect(failed[0].values).toEqual([ID_A, "resend send failed", 300]);
  });

  it("backoff raste 300→600→1200 i staje na 6h (21600)", async () => {
    const run = async (attempts: number) => {
      const m = sy15Mock();
      m.pushResult([
        {
          id: ID_A,
          channel: "email",
          recipient: "p@x.rs",
          subject: "s",
          body: "b",
          attempts,
          payload: null,
        },
      ]);
      const svc = new NotifyDispatchService(
        m.sy15,
        mailMock(true, false).mail,
        storageMock().storage,
      );
      await svc.dispatchKadr();
      return m.find("kadr_dispatch_mark_failed")[0].values[2];
    };
    expect(await run(0)).toBe(300);
    expect(await run(1)).toBe(600);
    expect(await run(2)).toBe(1200);
    expect(await run(10)).toBe(21600); // cap 6h
  });

  it("bez RESEND ključa (nekonfigurisan mejler) → DRY-RUN mark_sent, ne mark_failed", async () => {
    const m = sy15Mock();
    m.pushResult([
      {
        id: ID_A,
        channel: "email",
        recipient: "p@x.rs",
        subject: "s",
        body: "b",
        attempts: 0,
        payload: null,
      },
    ]);
    const { mail, send } = mailMock(false);
    const svc = new NotifyDispatchService(m.sy15, mail, storageMock().storage);

    const r = await svc.dispatchKadr();
    expect(r).toMatchObject({ sent: 1, failed: 0 });
    expect(send).not.toHaveBeenCalled();
    expect(m.find("kadr_dispatch_mark_sent")).toHaveLength(1);
    expect(m.find("kadr_dispatch_mark_failed")).toHaveLength(0);
  });

  it("email sa payload.attachment_path → prilog iz sy15 Storage-a (bucket/filename default)", async () => {
    const m = sy15Mock();
    m.pushResult([
      {
        id: ID_A,
        channel: "email",
        recipient: "p@x.rs",
        subject: "Ugovor",
        body: "<p>b</p>",
        attempts: 0,
        payload: { attachment_path: "2026/ugovor.pdf" },
      },
    ]);
    const { mail, sent } = mailMock();
    const { storage, download } = storageMock(new Uint8Array([9, 9]));
    const svc = new NotifyDispatchService(m.sy15, mail, storage);

    await svc.dispatchKadr();
    expect(download).toHaveBeenCalledWith("employee-docs", "2026/ugovor.pdf");
    const att = sent[0].attachments;
    expect(att).toHaveLength(1);
    expect(att?.[0].filename).toBe("dokument.pdf");
    expect(Buffer.isBuffer(att?.[0].content)).toBe(true);
  });

  it("payload.attachment_bucket/_filename se poštuju kad su zadati", async () => {
    const m = sy15Mock();
    m.pushResult([
      {
        id: ID_A,
        channel: "email",
        recipient: "p@x.rs",
        subject: "s",
        body: "b",
        attempts: 0,
        payload: {
          attachment_path: "a/b.pdf",
          attachment_bucket: "hr-docs",
          attachment_filename: "ugovor-2026.pdf",
        },
      },
    ]);
    const { mail, sent } = mailMock();
    const { storage, download } = storageMock();
    const svc = new NotifyDispatchService(m.sy15, mail, storage);

    await svc.dispatchKadr();
    expect(download).toHaveBeenCalledWith("hr-docs", "a/b.pdf");
    expect(sent[0].attachments?.[0].filename).toBe("ugovor-2026.pdf");
  });

  it("prilog ne uspe → mejl IPAK ide, bez priloga (ne obara slanje)", async () => {
    const m = sy15Mock();
    m.pushResult([
      {
        id: ID_A,
        channel: "email",
        recipient: "p@x.rs",
        subject: "s",
        body: "b",
        attempts: 0,
        payload: { attachment_path: "x.pdf", attachment_bucket: "kes" },
      },
    ]);
    const { mail, sent } = mailMock();
    const storage = {
      download: jest.fn().mockRejectedValue(new Error("404")),
    } as unknown as Sy15StorageService;
    const svc = new NotifyDispatchService(m.sy15, mail, storage);

    const r = await svc.dispatchKadr();
    expect(r).toMatchObject({ sent: 1, failed: 0 });
    expect(sent[0].attachments).toBeUndefined();
  });

  it("whatsapp red: Meta Graph v20 poziv sa template-om i NORMALIZOVANIM brojem", async () => {
    process.env.WA_ACCESS_TOKEN = "tok";
    process.env.WA_PHONE_NUMBER_ID = "555";
    process.env.WA_TEMPLATE_NAME = "hr_alert_sr";
    const m = sy15Mock();
    m.pushResult([
      {
        id: ID_A,
        channel: "whatsapp",
        recipient: "0637774847",
        subject: "Naslov",
        body: "Telo",
        attempts: 0,
        payload: null,
      },
    ]);
    const fetchSpy = jest
      .spyOn(global, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const svc = new NotifyDispatchService(
      m.sy15,
      mailMock().mail,
      storageMock().storage,
    );

    const r = await svc.dispatchKadr();
    expect(r).toMatchObject({ sent: 1, failed: 0 });

    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(fetchUrlOf(fetchSpy)).toBe(
      "https://graph.facebook.com/v20.0/555/messages",
    );
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer tok",
    );
    const body = waBodyOf(fetchSpy);
    expect(body).toMatchObject({
      messaging_product: "whatsapp",
      to: "381637774847", // 063… → 381…
      type: "template",
    });
    expect(body.template.name).toBe("hr_alert_sr");
    expect(body.template.language.code).toBe("sr");
    expect(body.template.components[0].parameters).toEqual([
      { type: "text", text: "Naslov" },
      { type: "text", text: "Telo" },
    ]);
    expect(m.find("kadr_dispatch_mark_sent")).toHaveLength(1);
  });

  it("normalizacija broja: +381…, 00381…, 381… svi daju 381…", async () => {
    process.env.WA_ACCESS_TOKEN = "tok";
    process.env.WA_PHONE_NUMBER_ID = "555";
    process.env.WA_TEMPLATE_NAME = "t";
    const send = async (recipient: string) => {
      const m = sy15Mock();
      m.pushResult([
        {
          id: ID_A,
          channel: "whatsapp",
          recipient,
          subject: "s",
          body: "b",
          attempts: 0,
          payload: null,
        },
      ]);
      const spy = jest
        .spyOn(global, "fetch")
        .mockResolvedValue(new Response("{}", { status: 200 }));
      const svc = new NotifyDispatchService(
        m.sy15,
        mailMock().mail,
        storageMock().storage,
      );
      await svc.dispatchKadr();
      const to = waBodyOf(spy).to;
      spy.mockRestore();
      return to;
    };
    expect(await send("+381 64 123 4567")).toBe("381641234567");
    expect(await send("00381641234567")).toBe("381641234567");
    expect(await send("381641234567")).toBe("381641234567");
  });

  it("whatsapp poziv nosi AbortSignal (viseći Graph ne sme da zakuca tik)", async () => {
    process.env.WA_ACCESS_TOKEN = "tok";
    process.env.WA_PHONE_NUMBER_ID = "555";
    process.env.WA_TEMPLATE_NAME = "t";
    const m = sy15Mock();
    m.pushResult([
      {
        id: ID_A,
        channel: "whatsapp",
        recipient: "381641234567",
        subject: "s",
        body: "b",
        attempts: 0,
        payload: null,
      },
    ]);
    const fetchSpy = jest
      .spyOn(global, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const svc = new NotifyDispatchService(
      m.sy15,
      mailMock().mail,
      storageMock().storage,
    );

    await svc.dispatchKadr();
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("whatsapp: Graph vrati grešku → mark_failed (nema mark_sent)", async () => {
    process.env.WA_ACCESS_TOKEN = "tok";
    process.env.WA_PHONE_NUMBER_ID = "555";
    process.env.WA_TEMPLATE_NAME = "t";
    const m = sy15Mock();
    m.pushResult([
      {
        id: ID_A,
        channel: "whatsapp",
        recipient: "+381641234567",
        subject: "s",
        body: "b",
        attempts: 1,
        payload: null,
      },
    ]);
    jest
      .spyOn(global, "fetch")
      .mockResolvedValue(new Response("bad token", { status: 401 }));
    const svc = new NotifyDispatchService(
      m.sy15,
      mailMock().mail,
      storageMock().storage,
    );

    const r = await svc.dispatchKadr();
    expect(r).toMatchObject({ sent: 0, failed: 1 });
    const failed = m.find("kadr_dispatch_mark_failed")[0];
    expect(String(failed.values[1])).toContain("WA 401");
    expect(failed.values[2]).toBe(600); // attempts 1 → 300*2^1
    expect(m.find("kadr_dispatch_mark_sent")).toHaveLength(0);
  });

  it("whatsapp bez WA konfiguracije → DRY-RUN mark_sent (bez fetch-a)", async () => {
    const m = sy15Mock();
    m.pushResult([
      {
        id: ID_A,
        channel: "whatsapp",
        recipient: "0637774847",
        subject: "s",
        body: "b",
        attempts: 0,
        payload: null,
      },
    ]);
    const fetchSpy = jest.spyOn(global, "fetch");
    const svc = new NotifyDispatchService(
      m.sy15,
      mailMock().mail,
      storageMock().storage,
    );

    const r = await svc.dispatchKadr();
    expect(r).toMatchObject({ sent: 1, failed: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(m.find("kadr_dispatch_mark_sent")).toHaveLength(1);
  });

  it("whatsapp sa neispravnim brojem (premalo cifara) → mark_sent, bez retry-ja", async () => {
    process.env.WA_ACCESS_TOKEN = "tok";
    process.env.WA_PHONE_NUMBER_ID = "555";
    process.env.WA_TEMPLATE_NAME = "t";
    const m = sy15Mock();
    m.pushResult([
      {
        id: ID_A,
        channel: "whatsapp",
        recipient: "123",
        subject: "s",
        body: "b",
        attempts: 0,
        payload: null,
      },
    ]);
    const fetchSpy = jest.spyOn(global, "fetch");
    const svc = new NotifyDispatchService(
      m.sy15,
      mailMock().mail,
      storageMock().storage,
    );

    const r = await svc.dispatchKadr();
    expect(r).toMatchObject({ sent: 1, failed: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(m.find("kadr_dispatch_mark_sent")).toHaveLength(1);
  });

  it("nepodržan kanal (sms) → DRY-RUN mark_sent (ne blokira red), broji se u skipped", async () => {
    const m = sy15Mock();
    m.pushResult([
      {
        id: ID_A,
        channel: "sms",
        recipient: "0631112223",
        subject: "s",
        body: "b",
        attempts: 0,
        payload: null,
      },
    ]);
    const { mail, send } = mailMock();
    const svc = new NotifyDispatchService(m.sy15, mail, storageMock().storage);

    const r = await svc.dispatchKadr();
    expect(r).toEqual({ processed: 1, sent: 1, failed: 0, skipped: 1 });
    expect(send).not.toHaveBeenCalled();
    expect(m.find("kadr_dispatch_mark_sent")).toHaveLength(1);
  });

  it("izuzetak usred reda → mark_failed, ostali redovi se i dalje obrađuju", async () => {
    const m = sy15Mock();
    m.pushResult([
      {
        id: ID_A,
        channel: "email",
        recipient: "a@x.rs",
        subject: "s",
        body: "b",
        attempts: 0,
        payload: null,
      },
      {
        id: ID_B,
        channel: "email",
        recipient: "b@x.rs",
        subject: "s",
        body: "b",
        attempts: 0,
        payload: null,
      },
    ]);
    const sentOk: MailParams[] = [];
    const mail = {
      configured: true,
      send: jest.fn((p: MailParams) => {
        if (p.to === "a@x.rs") return Promise.reject(new Error("boom"));
        sentOk.push(p);
        return Promise.resolve(true);
      }),
    } as unknown as MailService;
    const svc = new NotifyDispatchService(m.sy15, mail, storageMock().storage);

    const r = await svc.dispatchKadr();
    expect(r).toMatchObject({ processed: 2, sent: 1, failed: 1 });
    expect(sentOk).toHaveLength(1);
    expect(String(m.find("kadr_dispatch_mark_failed")[0].values[1])).toContain(
      "boom",
    );
  });

  it("prazan red → nema poziva posle dequeue-a", async () => {
    const m = sy15Mock();
    m.pushResult([]);
    const svc = new NotifyDispatchService(
      m.sy15,
      mailMock().mail,
      storageMock().storage,
    );
    expect(await svc.dispatchKadr()).toEqual({
      processed: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
    });
    expect(m.calls).toHaveLength(1);
  });
});

describe("dispatchMaint", () => {
  it("stub red (recipient='pending', bez user_id) → fanout RPC, BEZ mark_sent (parent se markira u fn)", async () => {
    const m = sy15Mock();
    m.pushResult([
      {
        id: ID_A,
        channel: "email",
        recipient: "pending",
        recipient_user_id: null,
        subject: "Kvar",
        body: "b",
        attempts: 0,
      },
    ]);
    m.pushResult([{ children: 3 }]);
    const svc = new NotifyDispatchService(
      m.sy15,
      mailMock().mail,
      storageMock().storage,
    );

    const r = await svc.dispatchMaint();
    expect(r).toMatchObject({ processed: 1, sent: 0, failed: 0, fanouts: 1 });

    const fan = m.find("maint_dispatch_fanout");
    expect(fan).toHaveLength(1);
    expect(fan[0].values).toEqual([ID_A]);
    expect(m.find("maint_dispatch_mark_sent")).toHaveLength(0);
  });

  it("fanout padne → failed, parent NE ide u mark_sent (dequeue ga vraća)", async () => {
    // dequeue vrati stub, pa fanout baci — mark_* se NE sme pozvati.
    const $queryRaw = jest
      .fn()
      .mockResolvedValueOnce([
        {
          id: ID_A,
          channel: "email",
          recipient: "pending",
          recipient_user_id: null,
          subject: "s",
          body: "b",
          attempts: 0,
        },
      ])
      .mockRejectedValueOnce(new Error("fanout pao"));
    const sy15 = { db: { $queryRaw } } as unknown as Sy15Service;
    const svc = new NotifyDispatchService(
      sy15,
      mailMock().mail,
      storageMock().storage,
    );

    const r = await svc.dispatchMaint();
    expect(r).toMatchObject({ processed: 1, sent: 0, failed: 1, fanouts: 0 });
    expect($queryRaw).toHaveBeenCalledTimes(2); // dequeue + fanout, bez mark_*
  });

  it("whatsapp red: recipient ide DIREKTNO (bez normalizacije — maint paritet)", async () => {
    process.env.WA_ACCESS_TOKEN = "tok";
    process.env.WA_PHONE_NUMBER_ID = "777";
    process.env.WA_TEMPLATE_NAME = "incident_alert_sr";
    process.env.WA_TEMPLATE_LANG = "sr";
    const m = sy15Mock();
    m.pushResult([
      {
        id: ID_B,
        channel: "whatsapp",
        recipient: "381641234567",
        recipient_user_id: "u1",
        subject: "Kvar",
        body: "Masina stala",
        attempts: 0,
      },
    ]);
    const fetchSpy = jest
      .spyOn(global, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const svc = new NotifyDispatchService(
      m.sy15,
      mailMock().mail,
      storageMock().storage,
    );

    const r = await svc.dispatchMaint();
    expect(r).toMatchObject({ sent: 1, failed: 0, fanouts: 0 });

    const body = waBodyOf(fetchSpy);
    expect(body.to).toBe("381641234567");
    expect(body.template.name).toBe("incident_alert_sr");
    expect(m.find("maint_dispatch_mark_sent")[0].values).toEqual([ID_B]);
  });

  it("maint email red (recipient je TELEFON) → DRY-RUN mark_sent, NIKAD MailService", async () => {
    const m = sy15Mock();
    m.pushResult([
      {
        id: ID_A,
        channel: "email",
        recipient: "0641234567",
        recipient_user_id: "u1",
        subject: "s",
        body: "b",
        attempts: 0,
      },
    ]);
    const { mail, send } = mailMock();
    const svc = new NotifyDispatchService(m.sy15, mail, storageMock().storage);

    const r = await svc.dispatchMaint();
    expect(r).toMatchObject({ sent: 1, failed: 0, skipped: 1 });
    expect(send).not.toHaveBeenCalled();
    expect(m.find("maint_dispatch_mark_sent")).toHaveLength(1);
  });

  it("whatsapp greška → mark_failed sa maint backoff-om (30 → 60 → 120, cap 3600)", async () => {
    process.env.WA_ACCESS_TOKEN = "tok";
    process.env.WA_PHONE_NUMBER_ID = "777";
    process.env.WA_TEMPLATE_NAME = "t";
    const run = async (attempts: number) => {
      const m = sy15Mock();
      m.pushResult([
        {
          id: ID_A,
          channel: "whatsapp",
          recipient: "381641234567",
          recipient_user_id: "u1",
          subject: "s",
          body: "b",
          attempts,
        },
      ]);
      const spy = jest
        .spyOn(global, "fetch")
        .mockResolvedValue(new Response("err", { status: 500 }));
      const svc = new NotifyDispatchService(
        m.sy15,
        mailMock().mail,
        storageMock().storage,
      );
      await svc.dispatchMaint();
      spy.mockRestore();
      return m.find("maint_dispatch_mark_failed")[0].values[2];
    };
    expect(await run(0)).toBe(30);
    expect(await run(1)).toBe(60);
    expect(await run(2)).toBe(120);
    expect(await run(20)).toBe(3600); // cap 60min
  });
});

describe("dispatchPb", () => {
  const pbRow = (
    id: string,
    recipient: string,
    subject: string,
    body: string,
  ) => ({ id, channel: "email", recipient, subject, body, attempts: 0 });

  it("digest OFF: svaki red ide kao poseban mejl (text → <pre> html)", async () => {
    const m = sy15Mock();
    m.pushResult([{ digest_mode: false }]);
    m.pushResult([
      pbRow(ID_A, "pera@x.rs", "Rok", "Zadatak kasni"),
      pbRow(ID_B, "pera@x.rs", "Drugi", "I ovaj"),
    ]);
    const { mail, send, sent } = mailMock();
    const svc = new NotifyDispatchService(m.sy15, mail, storageMock().storage);

    const r = await svc.dispatchPb();
    expect(r).toMatchObject({ processed: 2, sent: 2, failed: 0, digest: false });
    expect(send).toHaveBeenCalledTimes(2);
    expect(sent[0].html).toContain("<pre");
    expect(sent[0].html).toContain("Zadatak kasni");
    expect(m.find("pb_dispatch_mark_sent")).toHaveLength(2);
  });

  it("digest ON: više poruka ISTOM primaocu → JEDAN mejl, ali svaki red mark_sent posebno", async () => {
    const m = sy15Mock();
    m.pushResult([{ digest_mode: true }]);
    m.pushResult([
      pbRow(ID_A, "pera@x.rs", "Prvi", "telo 1"),
      pbRow(ID_B, "pera@x.rs", "Drugi", "telo 2"),
      pbRow(ID_C, "mika@x.rs", "Sam", "telo 3"),
    ]);
    const { mail, send, sent } = mailMock();
    const svc = new NotifyDispatchService(m.sy15, mail, storageMock().storage);

    const r = await svc.dispatchPb();
    expect(r).toMatchObject({ processed: 3, sent: 3, failed: 0, digest: true });

    // Pera dobija 1 kombinovani mejl, Mika svoj → 2 slanja za 3 reda.
    expect(send).toHaveBeenCalledTimes(2);
    const combined = sent.find((p) => p.to === "pera@x.rs");
    expect(combined?.subject).toBe("Projektni biro — 2 obaveštenja");
    expect(combined?.html).toContain("Prvi");
    expect(combined?.html).toContain("Drugi");
    expect(combined?.html).toContain("telo 2");
    // Sva tri reda su markirana pojedinačno.
    expect(m.find("pb_dispatch_mark_sent")).toHaveLength(3);
  });

  it("digest ON + kombinovani mejl padne → SVI redovi grupe idu u mark_failed (bez backoff arg.)", async () => {
    const m = sy15Mock();
    m.pushResult([{ digest_mode: true }]);
    m.pushResult([
      pbRow(ID_A, "pera@x.rs", "Prvi", "t1"),
      pbRow(ID_B, "pera@x.rs", "Drugi", "t2"),
    ]);
    const svc = new NotifyDispatchService(
      m.sy15,
      mailMock(true, false).mail,
      storageMock().storage,
    );

    const r = await svc.dispatchPb();
    expect(r).toMatchObject({ sent: 0, failed: 2 });
    const failed = m.find("pb_dispatch_mark_failed");
    expect(failed).toHaveLength(2);
    // pb mark_failed prima SAMO (id, error) — backoff je unutar same fn.
    expect(failed[0].values).toHaveLength(2);
    expect(failed[0].values[0]).toBe(ID_A);
    expect(failed[1].values[0]).toBe(ID_B);
  });

  it("digest ON ali samo JEDAN email red → normalno pojedinačno slanje", async () => {
    const m = sy15Mock();
    m.pushResult([{ digest_mode: true }]);
    m.pushResult([pbRow(ID_A, "pera@x.rs", "Sam", "telo")]);
    const { mail, send, sent } = mailMock();
    const svc = new NotifyDispatchService(m.sy15, mail, storageMock().storage);

    const r = await svc.dispatchPb();
    expect(r).toMatchObject({ sent: 1, failed: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(sent[0].subject).toBe("Sam");
  });

  it("digest ON, dva primaoca sa po JEDNOM porukom → dva zasebna mejla", async () => {
    const m = sy15Mock();
    m.pushResult([{ digest_mode: true }]);
    m.pushResult([
      pbRow(ID_A, "pera@x.rs", "P", "t1"),
      pbRow(ID_B, "mika@x.rs", "M", "t2"),
    ]);
    const { mail, send, sent } = mailMock();
    const svc = new NotifyDispatchService(m.sy15, mail, storageMock().storage);

    const r = await svc.dispatchPb();
    expect(r).toMatchObject({ sent: 2, failed: 0 });
    expect(send).toHaveBeenCalledTimes(2);
    expect(sent.map((p) => p.subject).sort()).toEqual(["M", "P"]);
  });

  it("non-email kanal (whatsapp) → DRY-RUN mark_sent u skipped, bez mejla", async () => {
    const m = sy15Mock();
    m.pushResult([{ digest_mode: false }]);
    m.pushResult([
      { ...pbRow(ID_A, "0641112223", "s", "b"), channel: "whatsapp" },
    ]);
    const { mail, send } = mailMock();
    const svc = new NotifyDispatchService(m.sy15, mail, storageMock().storage);

    const r = await svc.dispatchPb();
    expect(r).toMatchObject({ processed: 1, sent: 0, failed: 0, skipped: 1 });
    expect(send).not.toHaveBeenCalled();
    expect(m.find("pb_dispatch_mark_sent")).toHaveLength(1);
  });

  it("html se escape-uje (telo sa < > & ne razbija mejl)", async () => {
    const m = sy15Mock();
    m.pushResult([{ digest_mode: false }]);
    m.pushResult([pbRow(ID_A, "p@x.rs", "s", "a < b & c > d")]);
    const { mail, sent } = mailMock();
    const svc = new NotifyDispatchService(m.sy15, mail, storageMock().storage);

    await svc.dispatchPb();
    expect(sent[0].html).toContain("a &lt; b &amp; c &gt; d");
  });

  it("bez RESEND ključa → DRY-RUN mark_sent (paritet edge, ne mark_failed)", async () => {
    const m = sy15Mock();
    m.pushResult([{ digest_mode: false }]);
    m.pushResult([pbRow(ID_A, "p@x.rs", "s", "b")]);
    const { mail, send } = mailMock(false);
    const svc = new NotifyDispatchService(m.sy15, mail, storageMock().storage);

    const r = await svc.dispatchPb();
    expect(r).toMatchObject({ sent: 1, failed: 0 });
    expect(send).not.toHaveBeenCalled();
    expect(m.find("pb_dispatch_mark_failed")).toHaveLength(0);
  });
});

describe("privatnost logova", () => {
  const EMAIL = "pera.detaljic@servoteh.com";
  const PHONE = "0637774847";

  /** Skupi SVE što servis loguje kroz NestJS Logger. */
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

  it("kadr/maint/pb: log NIKAD ne sadrži pun mejl ni pun telefon (samo mask)", async () => {
    const lines = captureLogs();

    // kadr: DRY-RUN email (nekonfigurisan mejler) + nepodržan kanal sa telefonom
    const k = sy15Mock();
    k.pushResult([
      {
        id: ID_A,
        channel: "email",
        recipient: EMAIL,
        subject: "s",
        body: "b",
        attempts: 0,
        payload: null,
      },
      {
        id: ID_B,
        channel: "sms",
        recipient: PHONE,
        subject: "s",
        body: "b",
        attempts: 0,
        payload: null,
      },
    ]);
    await new NotifyDispatchService(
      k.sy15,
      mailMock(false).mail,
      storageMock().storage,
    ).dispatchKadr();

    // maint: DRY-RUN email red (recipient je telefon)
    const mt = sy15Mock();
    mt.pushResult([
      {
        id: ID_A,
        channel: "email",
        recipient: PHONE,
        recipient_user_id: "u1",
        subject: "s",
        body: "b",
        attempts: 0,
      },
    ]);
    await new NotifyDispatchService(
      mt.sy15,
      mailMock(false).mail,
      storageMock().storage,
    ).dispatchMaint();

    // pb: DRY-RUN email + non-email kanal
    const p = sy15Mock();
    p.pushResult([{ digest_mode: false }]);
    p.pushResult([
      { id: ID_A, channel: "email", recipient: EMAIL, subject: "s", body: "b", attempts: 0 },
      { id: ID_B, channel: "whatsapp", recipient: PHONE, subject: "s", body: "b", attempts: 0 },
    ]);
    await new NotifyDispatchService(
      p.sy15,
      mailMock(false).mail,
      storageMock().storage,
    ).dispatchPb();

    const all = lines.join(" || ");
    expect(lines.length).toBeGreaterThan(0);
    expect(all).not.toContain(EMAIL);
    expect(all).not.toContain(PHONE);
    // Skraćeni prefiks je dozvoljen (i koristan za dijagnostiku).
    expect(all).toContain("per…");
    expect(all).toContain("063…");
  });

  it("neispravan WA broj se loguje maskirano (warn grana)", async () => {
    process.env.WA_ACCESS_TOKEN = "tok";
    process.env.WA_PHONE_NUMBER_ID = "555";
    process.env.WA_TEMPLATE_NAME = "t";
    const lines = captureLogs();
    const m = sy15Mock();
    m.pushResult([
      {
        id: ID_A,
        channel: "whatsapp",
        recipient: "06377", // prekratak → normalizacija vraća ''
        subject: "s",
        body: "b",
        attempts: 0,
        payload: null,
      },
    ]);
    await new NotifyDispatchService(
      m.sy15,
      mailMock().mail,
      storageMock().storage,
    ).dispatchKadr();

    const all = lines.join(" || ");
    expect(all).toContain("063…");
    expect(all).not.toContain("06377");
  });
});

describe("dispatchPb — dopuna", () => {
  const pbRow = (
    id: string,
    recipient: string,
    subject: string,
    body: string,
  ) => ({ id, channel: "email", recipient, subject, body, attempts: 0 });

  it("pb mark_failed se zove BEZ backoff argumenta (fn sama vodi 30min/dead_letter)", async () => {
    const m = sy15Mock();
    m.pushResult([{ digest_mode: false }]);
    m.pushResult([pbRow(ID_A, "p@x.rs", "s", "b")]);
    const svc = new NotifyDispatchService(
      m.sy15,
      mailMock(true, false).mail,
      storageMock().storage,
    );

    const r = await svc.dispatchPb();
    expect(r).toMatchObject({ sent: 0, failed: 1 });
    const failed = m.find("pb_dispatch_mark_failed");
    expect(failed).toHaveLength(1);
    // Tačno 2 vrednosti: (id, error). Treći (backoff) NE postoji u potpisu —
    // pb red posle ovoga ostaje 'failed'/'dead_letter', a dequeue bira samo
    // 'pending' → slepa ulica po dizajnu (zatečeno 1.0 ponašanje).
    expect(failed[0].values).toHaveLength(2);
    expect(failed[0].values[0]).toBe(ID_A);
  });
});
