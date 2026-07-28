import { Injectable, Logger } from "@nestjs/common";
import { MailService } from "../../common/mail/mail.service";
import { resolveManagementRecipients } from "../../common/workers/management-criteria";

const TYPE_LABEL: Record<string, string> = {
  SKART: "Škart",
  DORADA: "Dorada",
};

/**
 * Mail obaveštenja za evidenciju škarta/dorade iznad praga
 * (MODULE_SPEC_kvalitet_skart_dorada §4) — obrazac `montaza-nm-mail.service.ts`.
 * Env `KVALITET_EVENT_MAIL_NOTIFY` default TRUE; bez RESEND ključa MailService je
 * DRY-RUN (loguje, ne šalje). DOKTRINA: slanje NIKAD ne obara unos — cela metoda
 * je best-effort (try/catch, ne baca; vraća boolean). Prima menadžment krug
 * (aktivni korisnici sa email-om) kada POTVRDJEN događaj pređe prag (velika
 * količina ILI ponovljen razlog u prozoru od 7 dana).
 */
@Injectable()
export class QualityEventsMailService {
  private readonly logger = new Logger(QualityEventsMailService.name);

  constructor(private readonly mail: MailService) {}

  /** Uključeno? default TRUE; isključi samo eksplicitnim "false"/"0"/"off"/"no". */
  private get enabled(): boolean {
    const v = (process.env.KVALITET_EVENT_MAIL_NOTIFY ?? "true")
      .trim()
      .toLowerCase();
    return v !== "false" && v !== "0" && v !== "off" && v !== "no";
  }

  /** Prod link ka tabu (statička ruta `?tab=` — DESIGN §8). Bez `&id=` (stranica ga ne
   *  otvara po događaju — ne obećavaj metu koju ne ispuniš, review [2]). Baza iz SY15_APP_URL. */
  private tabLink(): string {
    const base = (
      process.env.SY15_APP_URL || "https://servosync.servoteh.com"
    ).replace(/\/+$/, "");
    return `${base}/kvalitet?tab=skart-dorada`;
  }

  private esc(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /**
   * Obaveštenje MENADŽMENTU o prekoračenju praga. `db` je PrismaService (za
   * razrešavanje primalaca). Vraća boolean uspeha (nikad ne baca).
   */
  async notifyManagementThreshold(
    db: Parameters<typeof resolveManagementRecipients>[0],
    event: {
      id: number;
      type: string;
      qty: string;
      unit: string;
      reasonLabel: string | null;
      workOrderId: number;
      workUnitCode: string | null;
    },
    reason: string,
  ): Promise<boolean> {
    if (!this.enabled) return false;
    try {
      const recipients = await resolveManagementRecipients(db);
      if (recipients.length === 0) {
        this.logger.warn(
          `Prag škart/dorada (događaj ${event.id}): nema menadžment email-ova — obaveštenje preskočeno.`,
        );
        return false;
      }
      const typeLabel = TYPE_LABEL[event.type] ?? event.type;
      const subject = `Kvalitet — ${typeLabel.toLowerCase()} iznad praga (RN ${event.workOrderId})`;
      const html = this.buildHtml({
        typeLabel,
        qty: event.qty,
        unit: event.unit,
        reasonLabel: event.reasonLabel,
        workOrderId: event.workOrderId,
        workUnitCode: event.workUnitCode,
        thresholdReason: reason,
        link: this.tabLink(),
      });
      return await this.mail.send({
        to: recipients.map((r) => r.email),
        subject,
        html,
      });
    } catch (err) {
      this.logger.warn(
        `Obaveštenje menadžmentu za događaj kvaliteta ${event.id} nije poslato: ${
          (err as Error).message
        }`,
      );
      return false;
    }
  }

  private buildHtml(p: {
    typeLabel: string;
    qty: string;
    unit: string;
    reasonLabel: string | null;
    workOrderId: number;
    workUnitCode: string | null;
    thresholdReason: string;
    link: string;
  }): string {
    return `
      <p>Potvrđen je događaj kvaliteta iznad praga za obaveštavanje:</p>
      <p style="margin:12px 0"><strong>${this.esc(p.typeLabel)}</strong> · ${this.esc(
        p.qty,
      )} ${this.esc(p.unit)} · RN ${p.workOrderId}${
        p.workUnitCode ? ` · RJ ${this.esc(p.workUnitCode)}` : ""
      }</p>
      <p style="margin:8px 0;color:#444"><strong>Razlog:</strong> ${this.esc(
        p.reasonLabel ?? "—",
      )}</p>
      <p style="margin:8px 0;color:#444"><strong>Prag:</strong> ${this.esc(p.thresholdReason)}</p>
      <p style="margin:16px 0"><a href="${this.esc(p.link)}">Otvori evidenciju u aplikaciji</a></p>
      <p style="color:#666;font-size:13px;margin-top:16px">Ovo je automatska poruka sistema ServoSync (Kontrola kvaliteta — škart i dorada).</p>`;
  }
}
