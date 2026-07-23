import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { MailService } from "../../common/mail/mail.service";

/** Ishodi koji generišu mejl podnosiocu (MODULE_SPEC §9). */
export type ZahteviMailOutcome =
  | "approve"
  | "reject"
  | "needs-info"
  | "done";

const OUTCOME_META: Record<
  ZahteviMailOutcome,
  { label: string; verb: string }
> = {
  approve: {
    label: "odobren za realizaciju",
    verb: "Vaš zahtev je odobren za realizaciju",
  },
  reject: { label: "odbijen", verb: "Vaš zahtev je odbijen" },
  "needs-info": {
    label: "vraćen na dopunu",
    verb: "Vaš zahtev je vraćen na dopunu",
  },
  done: { label: "završen", verb: "Vaš zahtev je završen" },
};

/**
 * Obaveštenja podnosiocu (MODULE_SPEC §9) — mejl na odluku (approve/reject/needs-info)
 * i na završetak (DONE). Env `ZAHTEVI_MAIL_NOTIFY` default `true` (presuda §13.4);
 * bez RESEND ključa MailService je u DRY-RUN (loguje, ne šalje). DOKTRINA §10.4:
 * slanje NIKAD ne obara radnju — cela metoda je best-effort, pozivalac je ne await-uje
 * kritično (i sam servis ne baca — sve u try/catch).
 */
@Injectable()
export class ZahteviMailService {
  private readonly logger = new Logger(ZahteviMailService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
  ) {}

  /** Da li je obaveštavanje uključeno (default TRUE; isključi samo eksplicitnim "false"/"0"). */
  private get enabled(): boolean {
    const v = (process.env.ZAHTEVI_MAIL_NOTIFY ?? "true")
      .trim()
      .toLowerCase();
    return v !== "false" && v !== "0" && v !== "off" && v !== "no";
  }

  /**
   * Pošalji obaveštenje podnosiocu za dati ishod. Vraća boolean uspeha (nikad ne baca).
   * `note` je obrazloženje (razlog odbijanja / pitanja / napomena) — prikazuje se u telu.
   */
  async notifySubmitter(params: {
    requestId: number;
    outcome: ZahteviMailOutcome;
    note?: string | null;
  }): Promise<boolean> {
    if (!this.enabled) return false;
    try {
      const req = await this.prisma.changeRequest.findUnique({
        where: { id: params.requestId },
        select: {
          reqNo: true,
          title: true,
          createdByUserId: true,
        },
      });
      if (!req) return false;
      const user = await this.prisma.user.findUnique({
        where: { id: req.createdByUserId },
        select: { email: true, fullName: true },
      });
      if (!user?.email) {
        this.logger.warn(
          `Zahtev ${req.reqNo}: podnosilac #${req.createdByUserId} nema email — mejl preskočen.`,
        );
        return false;
      }

      const meta = OUTCOME_META[params.outcome];
      const subject = `Zahtev ${req.reqNo} — ${meta.label}`;
      const html = this.buildHtml({
        greeting: user.fullName || "poštovani",
        reqNo: req.reqNo,
        title: req.title,
        verb: meta.verb,
        note: params.note ?? null,
      });
      return await this.mail.send({ to: user.email, subject, html });
    } catch (err) {
      this.logger.warn(
        `Obaveštenje za zahtev ${params.requestId} (${params.outcome}) nije poslato: ${
          (err as Error).message
        }`,
      );
      return false;
    }
  }

  /**
   * Obaveštenje administratorima (MODULE_SPEC §9) — na svaki submit (submitInternal,
   * posle commita, fire-and-forget). `isResubmit` (dopuna vraćena) menja subject/telo:
   * „Dopunjen zahtev Z-…" (podnosilac odgovorio na dopunu) umesto „Nova ideja Z-…".
   * Primaoci: korisnici sa rolom `admin` (users.role='admin', aktivni); fallback env
   * `ZAHTEVI_ADMIN_MAILS` (CSV) kad u bazi nema admina sa email-om. Poštuje
   * `ZAHTEVI_MAIL_NOTIFY`; nikad ne baca.
   */
  async notifyAdminsNewRequest(
    requestId: number,
    isResubmit = false,
  ): Promise<boolean> {
    if (!this.enabled) return false;
    try {
      const req = await this.prisma.changeRequest.findUnique({
        where: { id: requestId },
        select: {
          reqNo: true,
          title: true,
          description: true,
          createdByUserId: true,
        },
      });
      if (!req) return false;

      const recipients = await this.adminEmails();
      if (recipients.length === 0) {
        this.logger.warn(
          `Zahtev ${req.reqNo}: nema administratorskih email-ova — obaveštenje preskočeno.`,
        );
        return false;
      }

      const submitter = await this.prisma.user.findUnique({
        where: { id: req.createdByUserId },
        select: { fullName: true, email: true },
      });
      const submitterName =
        submitter?.fullName ||
        submitter?.email ||
        `korisnik #${req.createdByUserId}`;

      const subject = isResubmit
        ? `Dopunjen zahtev Z-${req.reqNo}: ${req.title}`
        : `Nova ideja Z-${req.reqNo}: ${req.title}`;
      const html = this.buildAdminHtml({
        reqNo: req.reqNo,
        title: req.title,
        description: req.description,
        submitterName,
        link: this.detailLink(requestId),
        isResubmit,
      });
      return await this.mail.send({ to: recipients, subject, html });
    } catch (err) {
      this.logger.warn(
        `Obaveštenje administratorima za zahtev ${requestId} nije poslato: ${
          (err as Error).message
        }`,
      );
      return false;
    }
  }

  /** Email-ovi administratora: users.role='admin' (aktivni) + fallback ZAHTEVI_ADMIN_MAILS. */
  private async adminEmails(): Promise<string[]> {
    const admins = await this.prisma.user.findMany({
      where: { role: "admin", active: true, email: { not: "" } },
      select: { email: true },
    });
    const fromDb = admins
      .map((a) => a.email)
      .filter((e): e is string => !!e && e.includes("@"));
    if (fromDb.length > 0) return Array.from(new Set(fromDb));
    // Fallback: CSV iz env-a (kad u bazi nema admina sa email-om — npr. dev/seed baza).
    const csv = (process.env.ZAHTEVI_ADMIN_MAILS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.includes("@"));
    return Array.from(new Set(csv));
  }

  /** Prod link ka detalju zahteva (statička ruta `?id=` — §8). Baza iz SY15_APP_URL. */
  private detailLink(requestId: number): string {
    const base = (
      process.env.SY15_APP_URL || "https://servosync.servoteh.com"
    ).replace(/\/+$/, "");
    return `${base}/zahtevi/detalj?id=${requestId}`;
  }

  private buildAdminHtml(p: {
    reqNo: string;
    title: string;
    description: string;
    submitterName: string;
    link: string;
    isResubmit: boolean;
  }): string {
    const esc = (s: string) =>
      s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    const desc = p.description.slice(0, 600);
    const truncated = p.description.length > 600 ? "…" : "";
    const lead = p.isResubmit
      ? "Podnosilac je odgovorio na dopunu — zahtev je ponovo podnet. Odgovori su u tabu Pitanja:"
      : "Nova ideja / zahtev je podnet u modulu Zahtevi:";
    return `
      <p>${esc(lead)}</p>
      <p style="margin:12px 0"><strong>Z-${esc(p.reqNo)}</strong> — ${esc(
        p.title,
      )}</p>
      <p style="margin:8px 0;color:#444"><strong>Podnosilac:</strong> ${esc(
        p.submitterName,
      )}</p>
      <p style="margin:12px 0;white-space:pre-wrap">${esc(desc)}${truncated}</p>
      <p style="margin:16px 0"><a href="${esc(
        p.link,
      )}">Otvori zahtev u aplikaciji</a></p>
      <p style="color:#666;font-size:13px;margin-top:16px">Ovo je automatska poruka sistema ServoSync (modul Zahtevi).</p>`;
  }

  private buildHtml(p: {
    greeting: string;
    reqNo: string;
    title: string;
    verb: string;
    note: string | null;
  }): string {
    const esc = (s: string) =>
      s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    const noteBlock = p.note
      ? `<p style="margin:12px 0"><strong>Napomena:</strong><br/>${esc(
          p.note,
        ).replace(/\n/g, "<br/>")}</p>`
      : "";
    return `
      <p>Poštovani ${esc(p.greeting)},</p>
      <p>${esc(p.verb)}:</p>
      <p style="margin:12px 0"><strong>${esc(p.reqNo)}</strong> — ${esc(
        p.title,
      )}</p>
      ${noteBlock}
      <p style="color:#666;font-size:13px;margin-top:16px">Ovo je automatska poruka sistema ServoSync (modul Zahtevi).</p>`;
  }
}
