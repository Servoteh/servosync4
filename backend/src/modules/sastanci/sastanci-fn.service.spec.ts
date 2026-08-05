import {
  ForbiddenException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { SastanciFnService } from "./sastanci-fn.service";
import type { SastanciAuthzService } from "./sastanci-authz.service";
import type { PrismaService } from "../../prisma/prisma.service";

/**
 * Paritet-testovi za prepis sy15 `SECURITY DEFINER` funkcija i logičkih trigera.
 *
 * ŠTA OVI TESTOVI ČUVAJU: ne „da kod radi" nego da PONAŠANJE ostane isto kao u
 * PL/pgSQL izvoru (izvučenom sa žive sy15 `pg_get_functiondef`, 06.08.2026).
 * Zato svaki test imenuje pravilo koje pinuje, a ne metodu koju zove — kad
 * neko sutra „pojednostavi" kod, test mora da kaže ŠTA je izgubljeno.
 *
 * Tri pravila su izdvojena kao obavezna (zadatak seobe):
 *   1. zaključavanje sastanka (`sast_zakljucaj_sastanak`),
 *   2. TZ pravilo podsetnika (`sastanci_enqueue_meeting_reminders`),
 *   3. istorija akcija (`akcioni_plan_trg_istorija`).
 */

/** Minimalni „tx" — svaki test puni samo ono što njegova grana dodiruje. */
type Tx = Record<string, Record<string, jest.Mock>> & {
  $queryRaw?: jest.Mock;
};

function authzStub(over: Partial<Record<string, boolean>> = {}) {
  return {
    isManagement: jest.fn().mockResolvedValue(over.isManagement ?? false),
    isAdmin: jest.fn().mockResolvedValue(over.isAdmin ?? false),
    hasEditRole: jest.fn().mockResolvedValue(over.hasEditRole ?? false),
    isUcesnik: jest.fn().mockResolvedValue(over.isUcesnik ?? false),
    canMoveWeekly: jest.fn().mockResolvedValue(over.canMoveWeekly ?? false),
    // Read-scope (blokada 4). Prepoznatljiva vrednost umesto pravog `where`-a —
    // testu je bitno SAMO da je scope stigao do upita, ne kako izgleda; njegov
    // sadržaj pokriva `sastanci-authz.service.spec.ts`.
    scopeTemeWhere: jest.fn().mockResolvedValue({ __scope: "teme" }),
    scopeNotifLogWhere: jest.fn().mockResolvedValue({ __scope: "notif" }),
    scopeNotifPrefsWhere: jest.fn().mockResolvedValue({ __scope: "prefs" }),
  } as unknown as SastanciAuthzService;
}

function svc(authz = authzStub(), prisma: unknown = {}) {
  return new SastanciFnService(prisma as PrismaService, authz);
}

/** `sastanci_notification_log` mock koji beleži sve upisane redove. */
function notifLogMock() {
  const created: Record<string, unknown>[] = [];
  return {
    created,
    model: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: `id-${created.length}` };
      }),
      count: jest.fn().mockResolvedValue(0),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };
}

const SASTANAK = {
  id: "s-1",
  tip: "sedmicni",
  naslov: "Sedmični",
  datum: new Date("2026-08-10T00:00:00Z"),
  vreme: new Date("1970-01-01T09:30:00Z"),
  mesto: "Sala",
  status: "planiran",
  zapisnikDatum: null as Date | null,
  zakljucanAt: null as Date | null,
  zakljucanByEmail: null as string | null,
  vodioEmail: "vodja@servoteh.com",
  zapisnicarEmail: null as string | null,
  createdByEmail: "autor@servoteh.com",
};

// ══════════════════════════════════════════════════════════════════════════════
// sastanci_enqueue_notification — jezgro (opt-out semantika)
// ══════════════════════════════════════════════════════════════════════════════

describe("enqueueNotification — opt-out semantika iz PL/pgSQL izvora", () => {
  it("bez reda u prefs sve je uključeno (COALESCE(..., TRUE))", async () => {
    const log = notifLogMock();
    const tx = {
      sastanciNotificationPrefs: { findUnique: jest.fn().mockResolvedValue(null) },
      sastanciNotificationLog: log.model,
    } as unknown as Tx;
    await svc().enqueueNotification(tx as never, {
      kind: "meeting_invite",
      recipientEmail: "Neko@Servoteh.com",
      subject: "Pozivnica",
    });
    expect(log.created[0].status).toBe("queued");
    // Primalac se UVEK upisuje lower-ovan (ključ dedup-a i RLS poređenja).
    expect(log.created[0].recipientEmail).toBe("neko@servoteh.com");
  });

  it("opt-out NE briše red nego ga upisuje kao 'skipped' (revizioni trag)", async () => {
    const log = notifLogMock();
    const tx = {
      sastanciNotificationPrefs: {
        findUnique: jest.fn().mockResolvedValue({ onMeetingInvite: false }),
      },
      sastanciNotificationLog: log.model,
    } as unknown as Tx;
    await svc().enqueueNotification(tx as never, {
      kind: "meeting_invite",
      recipientEmail: "neko@servoteh.com",
      subject: "Pozivnica",
    });
    expect(log.created).toHaveLength(1);
    expect(log.created[0].status).toBe("skipped");
  });

  it("🔴 meeting_locked IGNORIŠE opt-out — zapisnik je obavezna distribucija", async () => {
    const log = notifLogMock();
    const tx = {
      sastanciNotificationPrefs: {
        findUnique: jest.fn().mockResolvedValue({ onMeetingLocked: false }),
      },
      sastanciNotificationLog: log.model,
    } as unknown as Tx;
    await svc().enqueueNotification(tx as never, {
      kind: "meeting_locked",
      recipientEmail: "neko@servoteh.com",
      subject: "Zapisnik",
    });
    expect(log.created[0].status).toBe("queued");
  });

  it("prazan mejl primaoca → nema reda (izvor vraća NULL, bez greške)", async () => {
    const log = notifLogMock();
    const tx = {
      sastanciNotificationPrefs: { findUnique: jest.fn() },
      sastanciNotificationLog: log.model,
    } as unknown as Tx;
    const id = await svc().enqueueNotification(tx as never, {
      kind: "meeting_invite",
      recipientEmail: "   ",
      subject: "Pozivnica",
    });
    expect(id).toBeNull();
    expect(log.created).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 1. ZAKLJUČAVANJE SASTANKA — sast_zakljucaj_sastanak
// ══════════════════════════════════════════════════════════════════════════════

describe("zakljucajSastanak — paritet sa sast_zakljucaj_sastanak", () => {
  function lockTx(over: Partial<typeof SASTANAK> = {}) {
    const log = notifLogMock();
    const s = { ...SASTANAK, ...over };
    const arhivaUpsert = jest.fn().mockResolvedValue({});
    const sastanakUpdate = jest
      .fn()
      .mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
        ...s,
        ...data,
      }));
    const tx = {
      sastanak: {
        findUnique: jest.fn().mockResolvedValue(s),
        update: sastanakUpdate,
      },
      sastanakUcesnik: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { email: "a@servoteh.com", label: "A", prisutan: true, pozvan: true, napomena: null },
          ]),
      },
      sastanakArhiva: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: arhivaUpsert,
      },
      sastanciNotificationPrefs: { findUnique: jest.fn().mockResolvedValue(null) },
      sastanciNotificationLog: log.model,
    } as unknown as Tx;
    return { tx, log, arhivaUpsert, sastanakUpdate };
  }

  it("pravo: mgmt ∨ vodio ∨ zapisnicar ∨ created_by — ostali dobijaju 403", async () => {
    const { tx } = lockTx();
    await expect(
      svc().zakljucajSastanak(tx as never, "niko@servoteh.com", "s-1", null, null),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("vodio_email prolazi i bez menadžmentske role (poređenje je lower)", async () => {
    const { tx, sastanakUpdate } = lockTx();
    const out = await svc().zakljucajSastanak(
      tx as never,
      "VODJA@Servoteh.com",
      "s-1",
      null,
      null,
    );
    expect(out.ok).toBe(true);
    expect(sastanakUpdate).toHaveBeenCalled();
  });

  it("🔴 već zaključan → meki already_locked, BEZ upisa arhive i BEZ mejlova", async () => {
    const { tx, log, arhivaUpsert, sastanakUpdate } = lockTx({ status: "zakljucan" });
    const out = await svc().zakljucajSastanak(
      tx as never,
      "vodja@servoteh.com",
      "s-1",
      null,
      null,
    );
    expect(out).toMatchObject({ ok: false, reason: "already_locked" });
    expect(arhivaUpsert).not.toHaveBeenCalled();
    expect(sastanakUpdate).not.toHaveBeenCalled();
    expect(log.created).toHaveLength(0);
  });

  it("🔴 prosleđen zapisnikDatum ima prednost i UŠIVA se u snapshot arhive", async () => {
    const { tx, arhivaUpsert } = lockTx({
      zapisnikDatum: new Date("2026-01-01T00:00:00Z"),
    });
    await svc().zakljucajSastanak(
      tx as never,
      "vodja@servoteh.com",
      "s-1",
      null,
      "2026-08-11",
    );
    const snap = arhivaUpsert.mock.calls[0][0].create.snapshot as {
      sastanak: { zapisnik_datum: string };
      schemaVersion: number;
    };
    // Bez ušivanja bi štampa iz arhive nosila STARI (pred-lock) datum.
    expect(snap.sastanak.zapisnik_datum).toBe("2026-08-11");
    expect(snap.schemaVersion).toBe(2);
  });

  it("bez prosleđenog datuma ostaje zatečeni (ponašanje pre zahteva 014/26)", async () => {
    const { tx, sastanakUpdate } = lockTx({
      zapisnikDatum: new Date("2026-01-01T00:00:00Z"),
    });
    await svc().zakljucajSastanak(tx as never, "vodja@servoteh.com", "s-1", null, null);
    expect(sastanakUpdate.mock.calls[0][0].data.zapisnikDatum).toEqual(
      new Date("2026-01-01T00:00:00Z"),
    );
  });

  it("🔴 zaključavanje šalje 'meeting_locked' SVIM učesnicima, sa oba datuma u payload-u", async () => {
    const { tx, log } = lockTx();
    await svc().zakljucajSastanak(
      tx as never,
      "vodja@servoteh.com",
      "s-1",
      null,
      "2026-08-11",
    );
    expect(log.created).toHaveLength(1);
    const p = log.created[0].payload as Record<string, unknown>;
    // `datum` = ono što korisnik vidi; `datum_termina` = sidro za „Od prošlog
    // sastanka". Spajanje ta dva je bio bug u 1.0 — ostaju razdvojeni.
    expect(p.datum).toBe("2026-08-11");
    expect(p.datum_termina).toBe("2026-08-10");
    expect(log.created[0].kind).toBe("meeting_locked");
  });

  it("prazan PDF path NE gazi postojeći u arhivi (COALESCE iz izvora)", async () => {
    const { tx, arhivaUpsert } = lockTx();
    (tx.sastanakArhiva.findUnique as jest.Mock).mockResolvedValue({
      zapisnikStoragePath: "s-1/stari.pdf",
      zapisnikGeneratedAt: new Date("2026-01-01T00:00:00Z"),
    });
    await svc().zakljucajSastanak(tx as never, "vodja@servoteh.com", "s-1", null, null);
    expect(arhivaUpsert.mock.calls[0][0].update.zapisnikStoragePath).toBe(
      "s-1/stari.pdf",
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. TZ PRAVILO PODSETNIKA — sastanci_enqueue_meeting_reminders
// ══════════════════════════════════════════════════════════════════════════════

describe("enqueueMeetingReminders — 🔴 TZ pravilo (bug: podsetnici nisu stizali pre sastanka)", () => {
  function remTx(datum: string, vreme: string) {
    const log = notifLogMock();
    const tx = {
      sastanak: {
        findMany: jest.fn().mockResolvedValue([
          {
            ...SASTANAK,
            datum: new Date(`${datum}T00:00:00Z`),
            vreme: new Date(`1970-01-01T${vreme}:00Z`),
          },
        ]),
      },
      sastanakUcesnik: {
        findMany: jest.fn().mockResolvedValue([{ email: "a@servoteh.com", label: "A" }]),
      },
      sastanciNotificationPrefs: { findUnique: jest.fn().mockResolvedValue(null) },
      sastanciNotificationLog: log.model,
    } as unknown as Tx;
    return { tx, log };
  }

  it("početak se tumači u Europe/Belgrade, NE u UTC-u (leti +02:00)", async () => {
    // 10.08.2026. u 09:30 po Beogradu = 07:30 UTC. „Sada" = 07:00 UTC → 30 min
    // pre početka, dakle unutar prozora 25–35 min.
    const { tx, log } = remTx("2026-08-10", "09:30");
    const n = await svc().enqueueMeetingReminders(
      tx as never,
      new Date("2026-08-10T07:00:00Z"),
    );
    expect(n).toBe(1);
    // Da se vreme tumačilo kao UTC, starts_at bi bio 09:30Z i podsetnik NIKAD
    // ne bi pao u prozor u 07:00Z — tačno kvar koji je popravljen na sy15.
    expect((log.created[0].payload as { starts_at: string }).starts_at).toBe(
      "2026-08-10T07:30:00.000Z",
    );
  });

  it("van prozora 25–35 min nema podsetnika (ni prerano ni prekasno)", async () => {
    for (const sada of ["2026-08-10T06:50:00Z", "2026-08-10T07:20:00Z"]) {
      const { tx, log } = remTx("2026-08-10", "09:30");
      const n = await svc().enqueueMeetingReminders(tx as never, new Date(sada));
      expect(n).toBe(0);
      expect(log.created).toHaveLength(0);
    }
  });

  it("zimi je ofset +01:00 — isti sastanak u januaru pada u prozor sat kasnije po UTC-u", async () => {
    const { tx } = remTx("2026-01-12", "09:30");
    const n = await svc().enqueueMeetingReminders(
      tx as never,
      new Date("2026-01-12T08:00:00Z"),
    );
    expect(n).toBe(1);
  });

  it("dedup 1 sat: postojeći queued/sent red preskače primaoca", async () => {
    const { tx, log } = remTx("2026-08-10", "09:30");
    (tx.sastanciNotificationLog.count as jest.Mock).mockResolvedValue(1);
    const n = await svc().enqueueMeetingReminders(
      tx as never,
      new Date("2026-08-10T07:00:00Z"),
    );
    expect(n).toBe(0);
    expect(log.created).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. ISTORIJA AKCIJA — akcioni_plan_trg_istorija
// ══════════════════════════════════════════════════════════════════════════════

describe("akcijaIstorija — paritet sa trigerom akcioni_plan_istorija_trg", () => {
  const BAZA = {
    status: "otvoren",
    rok: new Date("2026-08-10T00:00:00Z"),
    rokText: null,
    odgovoranLabel: "Marko",
    odgovoranText: null,
    odgovoranEmail: "marko@servoteh.com",
    naslov: "Nabaviti ležaj",
    projekatId: 9400,
  };

  function istTx() {
    const createMany = jest.fn().mockResolvedValue({ count: 0 });
    const tx = {
      akcionaTackaIstorija: { createMany },
    } as unknown as Tx;
    return { tx, createMany };
  }

  it("po JEDAN red za svako promenjeno polje", async () => {
    const { tx, createMany } = istTx();
    const n = await svc().akcijaIstorija(
      tx as never,
      BAZA,
      { ...BAZA, id: "a-1", status: "zavrsen", naslov: "Nabaviti ležaj 6204" },
      "nenad@servoteh.com",
    );
    expect(n).toBe(2);
    const polja = (createMany.mock.calls[0][0].data as { polje: string }[]).map(
      (r) => r.polje,
    );
    expect(polja.sort()).toEqual(["naslov", "status"]);
  });

  it("bez promene nema nijednog reda (i nema suvišnog upisa)", async () => {
    const { tx, createMany } = istTx();
    const n = await svc().akcijaIstorija(
      tx as never,
      BAZA,
      { ...BAZA, id: "a-1" },
      "nenad@servoteh.com",
    );
    expect(n).toBe(0);
    expect(createMany).not.toHaveBeenCalled();
  });

  it("🔴 'odgovoran' je IZVEDENO polje label→text→email, ne kolona", async () => {
    const { tx, createMany } = istTx();
    // Label se menja, mejl ostaje isti — izvor to i dalje beleži kao promenu
    // odgovornog, jer se u istoriji prikazuje label.
    await svc().akcijaIstorija(
      tx as never,
      BAZA,
      { ...BAZA, id: "a-1", odgovoranLabel: "Marko Marković" },
      "nenad@servoteh.com",
    );
    const red = (createMany.mock.calls[0][0].data as {
      polje: string;
      staro: string;
      novo: string;
    }[])[0];
    expect(red).toMatchObject({
      polje: "odgovoran",
      staro: "Marko",
      novo: "Marko Marković",
    });
  });

  it("NULL i prazan string su ISTA vrednost (COALESCE(x,'') iz izvora)", async () => {
    const { tx, createMany } = istTx();
    const n = await svc().akcijaIstorija(
      tx as never,
      { ...BAZA, rokText: null },
      { ...BAZA, id: "a-1", rokText: "" },
      "nenad@servoteh.com",
    );
    expect(n).toBe(0);
    expect(createMany).not.toHaveBeenCalled();
  });

  it("rok se poredi kao datum (YYYY-MM-DD), ne kao timestamp", async () => {
    const { tx, createMany } = istTx();
    await svc().akcijaIstorija(
      tx as never,
      BAZA,
      { ...BAZA, id: "a-1", rok: new Date("2026-08-17T00:00:00Z") },
      "nenad@servoteh.com",
    );
    expect(createMany.mock.calls[0][0].data[0]).toMatchObject({
      polje: "rok",
      staro: "2026-08-10",
      novo: "2026-08-17",
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Pozivnice / otkazi / podsetnici — gejtovi i delete-pa-enqueue semantika
// ══════════════════════════════════════════════════════════════════════════════

describe("sendInvites / remindUnprepared / resendMeetingLocked — mgmt gejt", () => {
  function inviteTx(ucesnici: Record<string, unknown>[], status = "planiran") {
    const log = notifLogMock();
    const tx = {
      sastanak: {
        findUnique: jest.fn().mockResolvedValue({ ...SASTANAK, status }),
      },
      sastanakUcesnik: { findMany: jest.fn().mockResolvedValue(ucesnici) },
      sastanciNotificationPrefs: { findUnique: jest.fn().mockResolvedValue(null) },
      sastanciNotificationLog: log.model,
    } as unknown as Tx;
    return { tx, log };
  }

  it("bez menadžmentske role → 403 (sy15 je dizao 42501)", async () => {
    const { tx } = inviteTx([]);
    await expect(
      svc().sendInvites(tx as never, "niko@servoteh.com", "s-1"),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("gejt pada PRE ijednog čitanja baze (ne curi ni postojanje sastanka)", async () => {
    const { tx } = inviteTx([]);
    await expect(
      svc().remindUnprepared(tx as never, "niko@servoteh.com", "s-1"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.sastanak.findUnique).not.toHaveBeenCalled();
  });

  it("🔴 resendMeetingLocked radi SAMO na zaključanom sastanku", async () => {
    const { tx, log } = inviteTx([{ email: "a@servoteh.com", label: "A" }], "planiran");
    const n = await svc(authzStub({ isManagement: true })).resendMeetingLocked(
      tx as never,
      "sef@servoteh.com",
      "s-1",
    );
    expect(n).toBe(0);
    expect(log.created).toHaveLength(0);
  });

  it("resendMeetingLocked na zaključanom šalje SVIMA (i nepozvanima)", async () => {
    const { tx, log } = inviteTx(
      [
        { email: "a@servoteh.com", label: "A" },
        { email: "b@servoteh.com", label: "B" },
      ],
      "zakljucan",
    );
    const n = await svc(authzStub({ isManagement: true })).resendMeetingLocked(
      tx as never,
      "sef@servoteh.com",
      "s-1",
    );
    expect(n).toBe(2);
    // Upit NEMA `pozvan: true` — zapisnik ide svim učesnicima, za razliku od pozivnice.
    expect(tx.sastanakUcesnik.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { sastanakId: "s-1" } }),
    );
    expect(log.created.every((r) => r.kind === "meeting_locked")).toBe(true);
  });
});

describe("sendInvites — sa mgmt pravom", () => {
  function tx0(ucesnici: Record<string, unknown>[]) {
    const log = notifLogMock();
    const tx = {
      sastanak: { findUnique: jest.fn().mockResolvedValue(SASTANAK) },
      sastanakUcesnik: { findMany: jest.fn().mockResolvedValue(ucesnici) },
      sastanciNotificationPrefs: { findUnique: jest.fn().mockResolvedValue(null) },
      sastanciNotificationLog: log.model,
    } as unknown as Tx;
    return { tx, log };
  }

  it("briše stare pozivnice pa upisuje nove — samo za pozvane", async () => {
    const { tx, log } = tx0([
      { email: "a@servoteh.com", label: "A" },
      { email: "b@servoteh.com", label: "B" },
    ]);
    const n = await svc(authzStub({ isManagement: true })).sendInvites(
      tx as never,
      "sef@servoteh.com",
      "s-1",
    );
    expect(n).toBe(2);
    expect(tx.sastanciNotificationLog.deleteMany).toHaveBeenCalledWith({
      where: {
        kind: "meeting_invite",
        relatedSastanakId: "s-1",
        relatedAkcijaId: null,
      },
    });
    // Filter „pozvan = true" mora ostati u upitu — bez njega bi mejl dobio i
    // neko ko je skinut sa poziva.
    expect(tx.sastanakUcesnik.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { sastanakId: "s-1", pozvan: true } }),
    );
    expect(log.created.every((r) => r.kind === "meeting_invite")).toBe(true);
  });
});

describe("enqueueCancel — otkazna obaveštenja", () => {
  it("NEMA gejta prava (kao ni izvor) i gađa samo pozvane", async () => {
    const log = notifLogMock();
    const tx = {
      sastanak: { findUnique: jest.fn().mockResolvedValue(SASTANAK) },
      sastanakUcesnik: {
        findMany: jest.fn().mockResolvedValue([{ email: "a@servoteh.com", label: "A" }]),
      },
      sastanciNotificationPrefs: { findUnique: jest.fn().mockResolvedValue(null) },
      sastanciNotificationLog: log.model,
    } as unknown as Tx;
    const n = await svc().enqueueCancel(tx as never, "s-1");
    expect(n).toBe(1);
    expect(log.created[0].kind).toBe("meeting_cancel");
    expect(tx.sastanakUcesnik.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { sastanakId: "s-1", pozvan: true } }),
    );
  });

  it("nepostojeći sastanak → 0, bez greške (paritet IF NOT FOUND RETURN 0)", async () => {
    const tx = {
      sastanak: { findUnique: jest.fn().mockResolvedValue(null) },
    } as unknown as Tx;
    expect(await svc().enqueueCancel(tx as never, "nema")).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Trigeri pozivnica
// ══════════════════════════════════════════════════════════════════════════════

describe("ucesnikInviteTrigger — paritet sa sast_notif_ucesnik_invite", () => {
  function trgTx(status: string, vecPoslato = 0) {
    const log = notifLogMock();
    log.model.count.mockResolvedValue(vecPoslato);
    const tx = {
      sastanak: { findUnique: jest.fn().mockResolvedValue({ ...SASTANAK, status }) },
      sastanciNotificationPrefs: { findUnique: jest.fn().mockResolvedValue(null) },
      sastanciNotificationLog: log.model,
    } as unknown as Tx;
    return { tx, log };
  }

  it("🔴 šalje SAMO za status='planiran' — na u_toku/zakljucan ćuti", async () => {
    for (const status of ["u_toku", "zakljucan", "otkazan", "zavrsen"]) {
      const { tx, log } = trgTx(status);
      const n = await svc().ucesnikInviteTrigger(tx as never, "s-1", [
        { email: "a@servoteh.com" },
      ]);
      expect(n).toBe(0);
      expect(log.created).toHaveLength(0);
    }
  });

  it("subject trigera nosi i DATUM (razlikuje se od sastanci_send_invites)", async () => {
    const { tx, log } = trgTx("planiran");
    await svc().ucesnikInviteTrigger(tx as never, "s-1", [{ email: "a@servoteh.com" }]);
    expect(log.created[0].subject).toBe("Pozivnica: Sedmični - 10.08.2026");
  });

  it("postojeći queued/sent red preskače primaoca (bez duplog mejla)", async () => {
    const { tx, log } = trgTx("planiran", 1);
    const n = await svc().ucesnikInviteTrigger(tx as never, "s-1", [
      { email: "a@servoteh.com" },
    ]);
    expect(n).toBe(0);
    expect(log.created).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Guard trigeri
// ══════════════════════════════════════════════════════════════════════════════

describe("assertNotLocked — paritet sa sast_check_not_locked", () => {
  const tx = (status: string) =>
    ({
      sastanak: { findUnique: jest.fn().mockResolvedValue({ status }) },
    }) as unknown as Tx;

  it("zaključan + ne-mgmt → 422 (sy15 ERRCODE 23514)", async () => {
    await expect(
      svc().assertNotLocked(tx("zakljucan") as never, "niko@servoteh.com", "s-1"),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it("zaključan + mgmt → prolazi", async () => {
    await expect(
      svc(authzStub({ isManagement: true })).assertNotLocked(
        tx("zakljucan") as never,
        "sef@servoteh.com",
        "s-1",
      ),
    ).resolves.toBeUndefined();
  });

  it("nezaključan prolazi svima; bez sastanka je no-op", async () => {
    await expect(
      svc().assertNotLocked(tx("planiran") as never, "niko@servoteh.com", "s-1"),
    ).resolves.toBeUndefined();
    await expect(
      svc().assertNotLocked({} as never, "niko@servoteh.com", null),
    ).resolves.toBeUndefined();
  });
});

describe("assertDraftStatusPrelaz — paritet sa sast_pm_teme_draft_status_guard", () => {
  it("draft sme SAMO u usvojeno/odbijeno", () => {
    const s = svc();
    expect(() => s.assertDraftStatusPrelaz("draft", "usvojeno")).not.toThrow();
    expect(() => s.assertDraftStatusPrelaz("draft", "odbijeno")).not.toThrow();
    expect(() => s.assertDraftStatusPrelaz("draft", "predlog")).toThrow(
      UnprocessableEntityException,
    );
  });

  it("ne-draft tema nije ograničena, i isti status nije prelaz", () => {
    const s = svc();
    expect(() => s.assertDraftStatusPrelaz("predlog", "resen")).not.toThrow();
    expect(() => s.assertDraftStatusPrelaz("draft", "draft")).not.toThrow();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Sedmični kolegijum
// ══════════════════════════════════════════════════════════════════════════════

describe("nextWeekMonday / adjustForHoliday — čist račun iz izvora", () => {
  const s = svc();

  it("nextWeekMonday = d + ((8 - isodow(d)) %% 7) — ponedeljak vraća SAM SEBE", () => {
    expect(s.nextWeekMonday("2026-08-07")).toBe("2026-08-10"); // petak → pon
    expect(s.nextWeekMonday("2026-08-09")).toBe("2026-08-10"); // nedelja → pon
    // 🔴 Ime funkcije vara: za ponedeljak je (8-1)%7 = 0, pa vraća TAJ ponedeljak,
    // ne sledeći. `sast_target_week_monday` na tome i gradi grananje (+7 samo kad
    // je sedmični te nedelje već zaključan/završen). Menjati ovo = pomeriti ceo
    // kolegijum za nedelju dana.
    expect(s.nextWeekMonday("2026-08-10")).toBe("2026-08-10");
  });

  it("adjustForHoliday pomera na prvi radni dan Pon..Pet", () => {
    expect(s.adjustForHoliday("2026-08-10", new Set(["2026-08-10"]))).toBe(
      "2026-08-11",
    );
    expect(
      s.adjustForHoliday("2026-08-10", new Set(["2026-08-10", "2026-08-11"])),
    ).toBe("2026-08-12");
  });

  it("cela radna nedelja praznik → vrati ponedeljak (izvor, nerealan slučaj)", () => {
    const svi = new Set([
      "2026-08-10",
      "2026-08-11",
      "2026-08-12",
      "2026-08-13",
      "2026-08-14",
    ]);
    expect(s.adjustForHoliday("2026-08-10", svi)).toBe("2026-08-10");
  });

  it("bez praznika (kadrovska još nije preseljena) vraća ponedeljak nepromenjen", () => {
    expect(s.adjustForHoliday("2026-08-10", new Set())).toBe("2026-08-10");
  });
});

describe("autoCreateWeekly — 🔴 vremenski guard petak 08h ostaje", () => {
  function autoTx(skip = 0, postoji = 0) {
    const tx = {
      sastWeeklySkip: { count: jest.fn().mockResolvedValue(skip) },
      sastanak: {
        count: jest.fn().mockResolvedValue(postoji),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: "novi" }),
      },
      sastanakUcesnik: { findMany: jest.fn().mockResolvedValue([]) },
      akcionaTacka: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    } as unknown as Tx;
    return tx;
  }

  it("van petka 08h (lokalno) ne radi ništa", async () => {
    // 2026-08-06 je četvrtak; 08:00 lokalno = 06:00 UTC leti.
    const out = await svc().autoCreateWeekly(
      autoTx() as never,
      new Set(),
      false,
      new Date("2026-08-06T06:00:00Z"),
    );
    expect(out).toBeNull();
  });

  it("petak 08h lokalno kreira termin", async () => {
    const tx = autoTx();
    const out = await svc().autoCreateWeekly(
      tx as never,
      new Set(),
      false,
      new Date("2026-08-07T06:00:00Z"),
    );
    expect(out).toBe("novi");
    expect(tx.sastanak.create).toHaveBeenCalled();
  });

  it("odložena nedelja i postojeći termin oba zaustavljaju automatiku", async () => {
    const petak = new Date("2026-08-07T06:00:00Z");
    expect(
      await svc().autoCreateWeekly(autoTx(1, 0) as never, new Set(), false, petak),
    ).toBeNull();
    expect(
      await svc().autoCreateWeekly(autoTx(0, 1) as never, new Set(), false, petak),
    ).toBeNull();
  });

  it("force preskače SAMO vremenski guard, ne i skip/duplikat provere", async () => {
    const tx = autoTx();
    const out = await svc().autoCreateWeekly(
      tx as never,
      new Set(),
      true,
      new Date("2026-08-06T06:00:00Z"),
    );
    expect(out).toBe("novi");
    expect(
      await svc().autoCreateWeekly(
        autoTx(1, 0) as never,
        new Set(),
        true,
        new Date("2026-08-06T06:00:00Z"),
      ),
    ).toBeNull();
  });
});

describe("weekly pomeri/odlozi/vrati — gejt je ALLOWLIST, ne rola", () => {
  const baseTx = () =>
    ({
      sastWeeklySkip: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        upsert: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      sastanak: {
        findFirst: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
        update: jest.fn().mockResolvedValue({}),
        create: jest.fn().mockResolvedValue({ id: "novi" }),
        findUnique: jest.fn().mockResolvedValue(SASTANAK),
      },
      sastanakUcesnik: { findMany: jest.fn().mockResolvedValue([]) },
      akcionaTacka: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      sastanciNotificationPrefs: { findUnique: jest.fn().mockResolvedValue(null) },
      sastanciNotificationLog: notifLogMock().model,
    }) as unknown as Tx;

  it("🔴 admin BEZ mesta u sast_weekly_movers ne sme da pomera", async () => {
    const s = svc(authzStub({ isManagement: true, isAdmin: true }));
    await expect(
      s.weeklyPomeri(baseTx() as never, "sef@servoteh.com", "2026-08-11"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      s.weeklyOdlozi(baseTx() as never, "sef@servoteh.com", "2026-08-10", null),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      s.weeklyVrati(baseTx() as never, "sef@servoteh.com", "2026-08-10"),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("pomeranje bez postojećeg termina kreira novi za taj datum", async () => {
    const tx = baseTx();
    const id = await svc(authzStub({ canMoveWeekly: true })).weeklyPomeri(
      tx as never,
      "mover@servoteh.com",
      "2026-08-11",
    );
    expect(id).toBe("novi");
    // Pomeranje uvek poništava odlaganje te nedelje.
    expect(tx.sastWeeklySkip.deleteMany).toHaveBeenCalled();
  });

  it("odlaganje otkazuje postojeći termin i tek onda šalje otkaze (redosled!)", async () => {
    const tx = baseTx();
    const redosled: string[] = [];
    (tx.sastanak.findFirst as jest.Mock).mockResolvedValue({ id: "s-1" });
    (tx.sastanak.update as jest.Mock).mockImplementation(async () => {
      redosled.push("status");
      return {};
    });
    (tx.sastanakUcesnik.findMany as jest.Mock).mockImplementation(async () => {
      redosled.push("enqueue");
      return [];
    });
    const out = await svc(authzStub({ canMoveWeekly: true })).weeklyOdlozi(
      tx as never,
      "mover@servoteh.com",
      "2026-08-10",
      "kolektivni godišnji",
    );
    expect(out).toMatchObject({ cancelled: true, sastanak_id: "s-1" });
    // Mejl mora da nosi VEĆ otkazano stanje — zato prvo status pa enqueue.
    expect(redosled).toEqual(["status", "enqueue"]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Dispatch + ostalo
// ══════════════════════════════════════════════════════════════════════════════

describe("dispatch mark_sent / mark_failed", () => {
  it("markFailed drži backoff na minimum 5 s (greatest iz izvora)", async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const tx = {
      sastanciNotificationLog: { updateMany },
    } as unknown as Tx;
    const pre = Date.now();
    await svc().dispatchMarkFailed(tx as never, "n-1", "boom", 1);
    const kada = (updateMany.mock.calls[0][0].data.nextAttemptAt as Date).getTime();
    expect(kada - pre).toBeGreaterThanOrEqual(4_900);
  });

  it("markFailed seče poruku greške na 1000 znakova", async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const tx = { sastanciNotificationLog: { updateMany } } as unknown as Tx;
    await svc().dispatchMarkFailed(tx as never, "n-1", "x".repeat(5000));
    expect((updateMany.mock.calls[0][0].data.error as string).length).toBe(1000);
  });

  it("markSent na praznom nizu ne dira bazu", async () => {
    const updateMany = jest.fn();
    const tx = { sastanciNotificationLog: { updateMany } } as unknown as Tx;
    expect(await svc().dispatchMarkSent(tx as never, [])).toBe(0);
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe("setAiModel — admin gejt i zatvoren spisak modela", () => {
  const tx = () =>
    ({ sastanciAiSettings: { upsert: jest.fn().mockResolvedValue({}) } }) as unknown as Tx;
  const prisma = { user: { findFirst: jest.fn().mockResolvedValue({ id: 2 }) } };

  it("ne-admin → 403 (i kad je menadžment)", async () => {
    await expect(
      svc(authzStub({ isManagement: true }), prisma).setAiModel(
        tx() as never,
        "sef@servoteh.com",
        "claude-opus-4-8",
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("nepoznat model → 422 (sy15 ERRCODE 23514)", async () => {
    await expect(
      svc(authzStub({ isAdmin: true }), prisma).setAiModel(
        tx() as never,
        "admin@servoteh.com",
        "gpt-9",
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it("admin upisuje model i svoj users.id (auth.uid() iz izvora)", async () => {
    const t = tx();
    const m = await svc(authzStub({ isAdmin: true }), prisma).setAiModel(
      t as never,
      "admin@servoteh.com",
      "  Claude-Opus-4-8 ",
    );
    expect(m).toBe("claude-opus-4-8");
    expect(t.sastanciAiSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: { id: 1, model: "claude-opus-4-8", updatedByUserId: 2 },
      }),
    );
  });
});

describe("userDirectory — has_edit_role gejt", () => {
  const prisma = {
    user: {
      findMany: jest.fn().mockResolvedValue([
        { email: "B@servoteh.com", fullName: "  ", role: "sef" },
        { email: "a@servoteh.com", fullName: "Ana", role: "admin" },
      ]),
    },
  };

  it("bez edit role → 403", async () => {
    await expect(
      svc(authzStub(), prisma).userDirectory("niko@servoteh.com"),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("prazan full_name pada na mejl, sort je po imenu pa mejlu", async () => {
    const out = await svc(authzStub({ hasEditRole: true }), prisma).userDirectory(
      "sef@servoteh.com",
    );
    expect(out).toEqual([
      { email: "a@servoteh.com", full_name: "Ana", role: "admin" },
      { email: "b@servoteh.com", full_name: "b@servoteh.com", role: "sef" },
    ]);
  });
});

describe("enqueueActionReminders — prozor roka i naslovi", () => {
  function actTx(rok: string) {
    const log = notifLogMock();
    const tx = {
      akcionaTacka: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "a-1",
            naslov: "Nabavka",
            rok: new Date(`${rok}T00:00:00Z`),
            rokText: null,
            prioritet: 2,
            sastanakId: "s-1",
            odgovoranEmail: "marko@servoteh.com",
            odgovoranLabel: "Marko",
            odgovoranText: null,
          },
        ]),
      },
      sastanciNotificationPrefs: { findUnique: jest.fn().mockResolvedValue(null) },
      sastanciNotificationLog: log.model,
    } as unknown as Tx;
    return { tx, log };
  }

  it("naslov zavisi od odnosa roka i danas (kasni / danas / sutra)", async () => {
    const sada = new Date("2026-08-10T09:00:00Z"); // 11h po Beogradu
    const kasni = actTx("2026-08-08");
    await svc().enqueueActionReminders(kasni.tx as never, sada);
    expect(kasni.log.created[0].subject).toBe(
      "Akcija kasni: Nabavka (rok bio 08.08.2026)",
    );

    const danas = actTx("2026-08-10");
    await svc().enqueueActionReminders(danas.tx as never, sada);
    expect(danas.log.created[0].subject).toBe("Rok danas: Nabavka");

    const sutra = actTx("2026-08-11");
    await svc().enqueueActionReminders(sutra.tx as never, sada);
    expect(sutra.log.created[0].subject).toBe("Rok sutra: Nabavka");
  });

  it("dedup 20 sati preskače akciju koja je već obaveštena", async () => {
    const { tx, log } = actTx("2026-08-10");
    (tx.sastanciNotificationLog.count as jest.Mock).mockResolvedValue(1);
    const n = await svc().enqueueActionReminders(
      tx as never,
      new Date("2026-08-10T09:00:00Z"),
    );
    expect(n).toBe(0);
    expect(log.created).toHaveLength(0);
  });
});

describe("dashboardStats — sast_dashboard_stats (JEDINA INVOKER fn domena)", () => {
  function statsTx() {
    return {
      sastanak: { count: jest.fn().mockResolvedValue(3) },
      pmTema: { count: jest.fn().mockResolvedValue(1) },
      $queryRaw: jest.fn().mockResolvedValue([{ otvoreno: 5n, kasni: 2n }]),
    } as unknown as Tx;
  }

  it("🔴 pm_teme brojka je SUŽENA read-scope-om, ostale nisu", async () => {
    // `sast_dashboard_stats` ima `prosecdef = f` (izmereno na živoj sy15), pa se
    // izvršava pod `SET LOCAL ROLE authenticated` i njen `count(*) FROM pm_teme`
    // PROLAZI kroz politiku `pmt_select`. Nesužen count bi odao koliko tuđih
    // (pa i tuđih draft) tema postoji.
    const authz = authzStub();
    const tx = statsTx();
    const out = await svc(authz).dashboardStats(tx as never, "ja@servoteh.com");

    expect(authz.scopeTemeWhere).toHaveBeenCalledWith("ja@servoteh.com");
    expect((tx as never as Tx).pmTema.count).toHaveBeenCalledWith({
      where: { AND: [{ status: "predlog" }, { __scope: "teme" }] },
    });
    // Sastanci i akcije imaju SELECT politiku `true` → ostaju nesuženi.
    expect(
      JSON.stringify((tx as never as Tx).sastanak.count.mock.calls),
    ).not.toContain("__scope");
    expect(out.pm_teme_na_cekanju).toBe(1);
    expect(out.akcije_otvoreno).toBe(5);
    expect(out.akcije_kasni).toBe(2);
  });
});
