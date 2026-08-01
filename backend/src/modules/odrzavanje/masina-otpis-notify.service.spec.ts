import { Test, TestingModule } from "@nestjs/testing";
import { MailService } from "../../common/mail/mail.service";
import { PrismaService } from "../../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import {
  MasinaOtpisNotifyService,
  type OtpisNotifyInput,
} from "./masina-otpis-notify.service";

/**
 * Primaoci obaveštenja o otpisu mašine (zahtev 037/26, dopuna — presuda 28.07):
 * IMENOVANA lista iz `masina_otpis_primaoci`, ne rola `sef`. Testovi drže tri stvari
 * koje su i bile uzrok dopune: (1) rola se više NE pita, (2) primalac bez vezanog
 * radnika svejedno dobija mejl, (3) prazna lista se vidi kao warn, a ne kao tiho slanje
 * nekom drugom. Slanje ostaje best-effort — nikad ne obara otpis (doktrina D8).
 */
function prismaMock() {
  return {
    masinaOtpisPrimalac: { findMany: jest.fn().mockResolvedValue([]) },
    user: { findMany: jest.fn().mockResolvedValue([]) },
  };
}

const INPUT: OtpisNotifyInput = {
  machineCode: "M-01",
  machineName: "Strug CNC",
  reason: "rashodovana 2026",
  openWorkOrders: [
    { woNumber: "RN-5", title: "Zamena ležaja", status: "u_radu" },
  ],
};

/** Presuđena petorka (28.07) — Luka i Ivan na produ NEMAJU `worker_id`. */
const PETORKA = [
  { email: "luka.petrovic@servoteh.com", fullName: "Luka Petrović" },
  { email: "ivan.umicevic@servoteh.com", fullName: "Ivan Umičević" },
  { email: "zoran.jarakovic@servoteh.com", fullName: "Zoran Jaraković" },
  { email: "nikola.ninkovic@servoteh.com", fullName: "Nikola Ninković" },
  { email: "miljan.nikodijevic@servoteh.com", fullName: "Miljan Nikodijević" },
];

const NALOZI = [
  {
    email: "luka.petrovic@servoteh.com",
    fullName: "Luka Petrovic",
    workerId: null,
    active: true,
  },
  {
    email: "ivan.umicevic@servoteh.com",
    fullName: "Ivan Umicevic",
    workerId: null,
    active: true,
  },
  {
    email: "zoran.jarakovic@servoteh.com",
    fullName: "Zoran Jarakovic",
    workerId: 1203,
    active: true,
  },
  {
    email: "nikola.ninkovic@servoteh.com",
    fullName: "Nikola Ninkovic",
    workerId: 43,
    active: true,
  },
  {
    email: "miljan.nikodijevic@servoteh.com",
    fullName: "Miljan Nikodijević",
    workerId: 13,
    active: true,
  },
];

describe("MasinaOtpisNotifyService — primaoci (037/26 dopuna)", () => {
  let service: MasinaOtpisNotifyService;
  let prisma: ReturnType<typeof prismaMock>;
  let mail: { send: jest.Mock };
  let notifications: { notifyWorkers: jest.Mock };
  let warn: jest.SpyInstance;

  beforeEach(async () => {
    prisma = prismaMock();
    mail = { send: jest.fn().mockResolvedValue(true) };
    notifications = { notifyWorkers: jest.fn().mockResolvedValue(3) };
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        MasinaOtpisNotifyService,
        { provide: PrismaService, useValue: prisma },
        { provide: MailService, useValue: mail },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();
    service = mod.get(MasinaOtpisNotifyService);
    warn = jest
      .spyOn(service["logger"], "warn")
      .mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  /** `void sendMail(...)` je fire-and-forget — pusti mikro-taskove da se isprazne. */
  const flush = () => new Promise((r) => setImmediate(r));

  function mockPetorka() {
    prisma.masinaOtpisPrimalac.findMany.mockResolvedValue(PETORKA);
    prisma.user.findMany.mockResolvedValue(NALOZI);
  }

  it("mejl ide SVOJ PETORICI, zvonce samo trojici sa vezanim radnikom", async () => {
    mockPetorka();

    await service.notifyOtpis(INPUT);
    await flush();

    expect(mail.send).toHaveBeenCalledTimes(1);
    expect(mail.send.mock.calls[0][0].to).toEqual([
      "luka.petrovic@servoteh.com",
      "ivan.umicevic@servoteh.com",
      "zoran.jarakovic@servoteh.com",
      "nikola.ninkovic@servoteh.com",
      "miljan.nikodijevic@servoteh.com",
    ]);
    // Luka i Ivan nemaju `worker_id` → nema inbox reda, ali mejl su dobili (gore).
    expect(notifications.notifyWorkers).toHaveBeenCalledTimes(1);
    expect(notifications.notifyWorkers.mock.calls[0][0]).toEqual([
      1203, 43, 13,
    ]);
    expect(notifications.notifyWorkers.mock.calls[0][1]).toMatchObject({
      type: "odrzavanje.masina-otpis",
      refTable: "maint_machines",
      refId: null,
    });
  });

  it("čita SAMO aktivne redove liste i NIKAD ne pita rolu `sef`", async () => {
    mockPetorka();

    await service.notifyOtpis(INPUT);
    await flush();

    expect(prisma.masinaOtpisPrimalac.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { active: true } }),
    );
    // Regresiona brana za presudu: nijedan upit ne sme da filtrira po roli — jedini
    // nosilac role `sef` na produ je servisni nalog PDM Bridge.
    const userQueries = JSON.stringify(prisma.user.findMany.mock.calls);
    expect(userQueries).not.toContain("role");
    expect(userQueries).not.toContain("sef");
  });

  it("poruka nosi mašinu i broj otvorenih naloga (sadržaj nepromenjen)", async () => {
    mockPetorka();

    await service.notifyOtpis(INPUT);
    await flush();

    const msg = notifications.notifyWorkers.mock.calls[0][1].message as string;
    expect(msg).toContain("M-01 · Strug CNC");
    expect(msg).toContain("Otvorenih radnih naloga: 1");
    const html = mail.send.mock.calls[0][0].html as string;
    expect(html).toContain("Strug CNC");
    expect(html).toContain("rashodovana 2026");
    expect(html).toContain("RN-5");
  });

  it("primalac bez naloga u aplikaciji svejedno dobija mejl", async () => {
    prisma.masinaOtpisPrimalac.findMany.mockResolvedValue([
      { email: "spoljni.saradnik@servoteh.com", fullName: "Spoljni saradnik" },
    ]);
    prisma.user.findMany.mockResolvedValue([]);

    await service.notifyOtpis(INPUT);
    await flush();

    expect(mail.send.mock.calls[0][0].to).toEqual([
      "spoljni.saradnik@servoteh.com",
    ]);
    expect(notifications.notifyWorkers).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("nijedan primalac nema vezanog radnika"),
    );
  });

  it("deaktiviran nalog ne dobija zvonce, ali mejl ide (red je ručna odluka)", async () => {
    prisma.masinaOtpisPrimalac.findMany.mockResolvedValue([
      { email: "bivsi.radnik@servoteh.com", fullName: null },
    ]);
    prisma.user.findMany.mockResolvedValue([
      {
        email: "bivsi.radnik@servoteh.com",
        fullName: "Bivši Radnik",
        workerId: 99,
        active: false,
      },
    ]);

    await service.notifyOtpis(INPUT);
    await flush();

    expect(mail.send.mock.calls[0][0].to).toEqual([
      "bivsi.radnik@servoteh.com",
    ]);
    expect(notifications.notifyWorkers).not.toHaveBeenCalled();
  });

  it("isti mejl u dva zapisa (različita velika slova) šalje se JEDNOM", async () => {
    prisma.masinaOtpisPrimalac.findMany.mockResolvedValue([
      { email: "luka.petrovic@servoteh.com", fullName: "Luka Petrović" },
      { email: "Luka.Petrovic@servoteh.com", fullName: "Luka duplikat" },
    ]);
    prisma.user.findMany.mockResolvedValue([
      {
        email: "luka.petrovic@servoteh.com",
        fullName: "Luka Petrovic",
        workerId: 500,
        active: true,
      },
    ]);

    await service.notifyOtpis(INPUT);
    await flush();

    expect(mail.send.mock.calls[0][0].to).toEqual([
      "luka.petrovic@servoteh.com",
    ]);
    expect(notifications.notifyWorkers.mock.calls[0][0]).toEqual([500]);
  });

  it("prazna lista = warn, bez slanja i bez tihog fallback-a na rolu", async () => {
    prisma.masinaOtpisPrimalac.findMany.mockResolvedValue([]);

    await service.notifyOtpis(INPUT);
    await flush();

    expect(mail.send).not.toHaveBeenCalled();
    expect(notifications.notifyWorkers).not.toHaveBeenCalled();
    expect(prisma.user.findMany).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("nema aktivnih primalaca"),
    );
  });

  it("pad baze/mejla/zvonca NE obara otpis (best-effort, D8)", async () => {
    prisma.masinaOtpisPrimalac.findMany.mockRejectedValue(new Error("DB pao"));
    await expect(service.notifyOtpis(INPUT)).resolves.toBeUndefined();
    expect(mail.send).not.toHaveBeenCalled();

    mockPetorka();
    notifications.notifyWorkers.mockRejectedValue(new Error("inbox pao"));
    mail.send.mockRejectedValue(new Error("Resend pao"));
    await expect(service.notifyOtpis(INPUT)).resolves.toBeUndefined();
    await flush();
    // Zvonce je palo, ali je mejl svejedno pokušan — kanali su nezavisni.
    expect(mail.send).toHaveBeenCalledTimes(1);
  });

  it("ODRZAVANJE_OTPIS_MAIL_NOTIFY=false gasi samo mejl, zvonce ostaje", async () => {
    const prev = process.env.ODRZAVANJE_OTPIS_MAIL_NOTIFY;
    process.env.ODRZAVANJE_OTPIS_MAIL_NOTIFY = "false";
    try {
      mockPetorka();
      await service.notifyOtpis(INPUT);
      await flush();
      expect(mail.send).not.toHaveBeenCalled();
      expect(notifications.notifyWorkers).toHaveBeenCalledTimes(1);
    } finally {
      if (prev === undefined) delete process.env.ODRZAVANJE_OTPIS_MAIL_NOTIFY;
      else process.env.ODRZAVANJE_OTPIS_MAIL_NOTIFY = prev;
    }
  });
});
