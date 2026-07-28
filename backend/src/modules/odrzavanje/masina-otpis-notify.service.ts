import { Injectable, Logger } from "@nestjs/common";
import { MailService } from "../../common/mail/mail.service";
import {
  resolveOtpisPrimaoci,
  type OtpisPrimalac,
} from "../../common/workers/otpis-primaoci";
import { PrismaService } from "../../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";

/** Otvoreni radni nalog zatečen na mašini u trenutku otpisa (za telo poruke). */
export interface OtpisOpenWorkOrder {
  woNumber: string | null;
  title: string;
  status: string;
}

export interface OtpisNotifyInput {
  machineCode: string;
  machineName: string;
  reason: string;
  openWorkOrders: OtpisOpenWorkOrder[];
}

/**
 * Obaveštenje o otpisu mašine (zahtev 037/26): „Mašina X je otpisana —
 * preraspodeli poslove predviđene za nju."
 *
 * KO GA DOBIJA (dopuna, presuda Nenada 28.07): imenovana lista iz tabele
 * `masina_otpis_primaoci`, a NE rola `sef` — ta rola na produ nema nijednog čoveka
 * (jedini nosilac je servisni nalog PDM Bridge), pa je obaveštenje završavalo kao
 * warn u logu. Lista je podešavanje i menja se SQL-om bez deploy-a; obrazloženje i
 * recept za izmenu stoje u `common/workers/otpis-primaoci.ts` i u migraciji.
 *
 * ZAŠTO GLAVNA BAZA, A NE CMMS OUTBOX (`maint_notification_log`): sy15 outbox je
 * za mejl MRTAV PO DIZAJNU — `maint_dispatch_fanout` upisuje `recipient` =
 * `maint_user_profiles.phone` i za `channel='email'`, pa edge dispečer te redove
 * NAMERNO DRY-RUN-uje (notify-dispatch.service.ts, „Dispatch OSTAJE MRTAV,
 * presuda F1"). Enqueue je uz to DENY-ALL iz aplikacije. Slanje tim kanalom ne bi
 * stiglo ni do koga, a zahtev traži da šef BUDE obavešten — zato ide dokazanim
 * „mejl + zvonce" obrascem glavne baze (016/26 `launch-notify`, 004/26 kvalitet):
 * `NotificationsService.notifyWorkers` + `MailService.send`.
 *
 * DOKTRINA (PLAN_dorade §D8): slanje NIKAD ne obara poslovnu radnju — cela metoda
 * je best-effort (try/catch, ne baca). Otpis je već iskomitovan kad se ovo zove.
 */
@Injectable()
export class MasinaOtpisNotifyService {
  private readonly logger = new Logger(MasinaOtpisNotifyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly mail: MailService,
  ) {}

  /** Uključeno? default TRUE; isključi samo eksplicitnim "false"/"0"/"off"/"no". */
  private get mailEnabled(): boolean {
    const v = (process.env.ODRZAVANJE_OTPIS_MAIL_NOTIFY ?? "true")
      .trim()
      .toLowerCase();
    return v !== "false" && v !== "0" && v !== "off" && v !== "no";
  }

  private get appBase(): string {
    return (
      process.env.SY15_APP_URL || "https://servosync.servoteh.com"
    ).replace(/\/+$/, "");
  }

  /** Deep-link na karton otpisane mašine (statička ruta `?code=` — DESIGN §8). */
  private machineLink(code: string): string {
    return `${this.appBase}/odrzavanje/masine?code=${encodeURIComponent(code)}`;
  }

  private esc(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /**
   * Zvonce + mail primaocima iz `masina_otpis_primaoci`. Nikad ne baca; greške se
   * samo loguju. Lista se razrešava JEDNOM i deli oba kanala — inače bi izmena
   * tabele između dva upita mogla da mejluje jedan skup, a zvonce drugom.
   */
  async notifyOtpis(input: OtpisNotifyInput): Promise<void> {
    const label = `${input.machineCode} · ${input.machineName}`;
    const openCount = input.openWorkOrders.length;

    let primaoci: OtpisPrimalac[];
    try {
      primaoci = await resolveOtpisPrimaoci(this.prisma);
    } catch (err) {
      this.logger.warn(
        `Otpis mašine ${label}: primaoci nisu razrešeni (${(err as Error).message}) — obaveštenje preskočeno.`,
      );
      return;
    }
    if (primaoci.length === 0) {
      // Namerno BEZ tihog fallback-a na rolu `sef`: prazna lista je greška u
      // podešavanju koja mora da se vidi, a ne da se maskira slanjem servisnom nalogu.
      this.logger.warn(
        `Otpis mašine ${label}: tabela masina_otpis_primaoci nema aktivnih primalaca — obaveštenje preskočeno.`,
      );
      return;
    }

    try {
      // In-app zvonce (worker-scoped). Primalac bez vezanog radnika nema inbox red —
      // to nije greška (deljeni terminali, nalozi bez radnika); mail ga svejedno pokriva.
      const workerIds = [
        ...new Set(
          primaoci
            .map((p) => p.workerId)
            .filter((id): id is number => id != null),
        ),
      ];
      if (workerIds.length) {
        // `ref_id` je Int, a mašina je ključana TEKSTOM (machine_code) — zato bez
        // deep-link id-ja: refTable vodi na registar mašina, šifra je u poruci.
        await this.notifications.notifyWorkers(workerIds, {
          type: "odrzavanje.masina-otpis",
          message:
            `Mašina ${label} je otpisana — preraspodeli poslove predviđene za nju.` +
            (openCount
              ? ` Otvorenih radnih naloga: ${openCount}.`
              : " Nema otvorenih radnih naloga."),
          refTable: "maint_machines",
          refId: null,
        });
      } else {
        this.logger.warn(
          `Otpis mašine ${label}: nijedan primalac nema vezanog radnika — zvonce preskočeno (mail ide).`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `Zvonce za otpis mašine ${label} nije upisano: ${(err as Error).message}`,
      );
    }

    // Mail je fire-and-forget (samostalno guarded, ne baca).
    void this.sendMail(input, label, primaoci).catch(() => undefined);
  }

  private async sendMail(
    input: OtpisNotifyInput,
    label: string,
    primaoci: OtpisPrimalac[],
  ): Promise<boolean> {
    if (!this.mailEnabled) return false;
    try {
      return await this.mail.send({
        to: primaoci.map((r) => r.email),
        subject: `Održavanje — otpisana mašina ${label}`,
        html: this.buildHtml(input, label),
      });
    } catch (err) {
      this.logger.warn(
        `Mail o otpisu mašine ${label} nije poslat: ${(err as Error).message}`,
      );
      return false;
    }
  }

  private buildHtml(input: OtpisNotifyInput, label: string): string {
    const open = input.openWorkOrders;
    const list = open.length
      ? `<p style="margin:12px 0 4px"><strong>Otvoreni radni nalozi na ovoj mašini (${open.length}):</strong></p>
      <ul style="margin:4px 0 0;padding-left:20px">${open
        .map(
          (w) =>
            `<li>${this.esc(w.woNumber ?? "—")} · ${this.esc(
              w.title,
            )} <span style="color:#666">(${this.esc(w.status)})</span></li>`,
        )
        .join("")}</ul>
      <p style="margin:12px 0;color:#b45309"><strong>Potrebno je preraspodeliti ove poslove na druge mašine.</strong></p>`
      : `<p style="margin:12px 0;color:#444">Na mašini nema otvorenih radnih naloga.</p>`;

    return `
      <p>Mašina je otpisana (izbačena iz upotrebe) u modulu Održavanje:</p>
      <p style="margin:12px 0"><strong>${this.esc(label)}</strong></p>
      <p style="margin:8px 0;color:#444"><strong>Razlog otpisa:</strong> ${this.esc(
        input.reason,
      )}</p>
      ${list}
      <p style="margin:8px 0;color:#444">Mašina NIJE obrisana — arhivirana je, pa karton i cela
      istorija (kontrole, kvarovi, nalozi, napomene, dokumenta) ostaju dostupni. Više se ne
      nudi pri otvaranju novih radnih naloga i prijava kvara.</p>
      <p style="margin:16px 0"><a href="${this.esc(
        this.machineLink(input.machineCode),
      )}">Otvori karton mašine</a></p>
      <p style="color:#666;font-size:13px;margin-top:16px">Ovo je automatska poruka sistema ServoSync (Održavanje — otpis mašine).</p>`;
  }
}
