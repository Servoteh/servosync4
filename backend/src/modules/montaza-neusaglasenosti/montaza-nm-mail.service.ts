import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { MailService } from "../../common/mail/mail.service";
import { resolveManagementRecipients } from "../../common/workers/management-criteria";

const SEVERITY_LABEL: Record<string, string> = {
  MALA: "Mala",
  SREDNJA: "Srednja",
  VISOKA: "Visoka",
};
const LOCATION_LABEL: Record<string, string> = {
  SERVOTEH: "Servoteh (hala)",
  TEREN: "Teren",
};

/**
 * Mail obaveštenja za neusaglašenosti na montaži (MODULE_SPEC §2) — obrazac
 * `zahtevi-mail.service.ts`. Env `MONTAZA_NM_MAIL_NOTIFY` default TRUE; bez RESEND
 * ključa MailService je DRY-RUN (loguje, ne šalje). DOKTRINA §6: slanje NIKAD ne
 * obara prijavu — cela metoda je best-effort (try/catch, ne baca; vraća boolean).
 *   • nova prijava → mail SVIM aktivnim `menadzment` korisnicima sa email-om (COO krug).
 *   • ZAVRSENO   → mail podnosiocu prijave.
 */
@Injectable()
export class MontazaNmMailService {
  private readonly logger = new Logger(MontazaNmMailService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
  ) {}

  /** Uključeno? default TRUE; isključi samo eksplicitnim "false"/"0"/"off"/"no". */
  private get enabled(): boolean {
    const v = (process.env.MONTAZA_NM_MAIL_NOTIFY ?? "true")
      .trim()
      .toLowerCase();
    return v !== "false" && v !== "0" && v !== "off" && v !== "no";
  }

  /** Prod link ka detalju (statička ruta `?id=` — DESIGN §8). Baza iz SY15_APP_URL. */
  private detailLink(id: number): string {
    const base = (
      process.env.SY15_APP_URL || "https://servosync.servoteh.com"
    ).replace(/\/+$/, "");
    return `${base}/montaza?view=neusaglasenosti&id=${id}`;
  }

  private esc(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /**
   * Obaveštenje MENADŽMENTU na SVAKU novu prijavu. Vraća boolean uspeha (nikad ne baca).
   */
  async notifyManagementNewReport(nonconformityId: number): Promise<boolean> {
    if (!this.enabled) return false;
    try {
      const nc = await this.prisma.montageNonconformity.findUnique({
        where: { id: nonconformityId },
        select: {
          reportNumber: true,
          projectNumber: true,
          description: true,
          severity: true,
          locationKind: true,
          locationNote: true,
          reportedByUserId: true,
        },
      });
      if (!nc) return false;

      const recipients = await resolveManagementRecipients(this.prisma);
      if (recipients.length === 0) {
        this.logger.warn(
          `Neusaglašenost ${nc.reportNumber}: nema menadžment email-ova — obaveštenje preskočeno.`,
        );
        return false;
      }

      const reporter = await this.prisma.user.findUnique({
        where: { id: nc.reportedByUserId },
        select: { fullName: true, email: true },
      });
      const reporterName =
        reporter?.fullName ||
        reporter?.email ||
        `korisnik #${nc.reportedByUserId}`;

      const subject = `Nova neusaglašenost na montaži ${nc.reportNumber} (predmet ${nc.projectNumber ?? "—"})`;
      const html = this.buildNewReportHtml({
        reportNumber: nc.reportNumber,
        projectNumber: nc.projectNumber,
        description: nc.description,
        severity: nc.severity,
        locationKind: nc.locationKind,
        locationNote: nc.locationNote,
        reporterName,
        link: this.detailLink(nonconformityId),
      });
      return await this.mail.send({
        to: recipients.map((r) => r.email),
        subject,
        html,
      });
    } catch (err) {
      this.logger.warn(
        `Obaveštenje menadžmentu za neusaglašenost ${nonconformityId} nije poslato: ${
          (err as Error).message
        }`,
      );
      return false;
    }
  }

  /** Obaveštenje PODNOSIOCU na ZAVRSENO. Vraća boolean uspeha (nikad ne baca). */
  async notifyReporterClosed(nonconformityId: number): Promise<boolean> {
    if (!this.enabled) return false;
    try {
      const nc = await this.prisma.montageNonconformity.findUnique({
        where: { id: nonconformityId },
        select: {
          reportNumber: true,
          projectNumber: true,
          investigationReport: true,
          reportedByUserId: true,
        },
      });
      if (!nc) return false;
      const reporter = await this.prisma.user.findUnique({
        where: { id: nc.reportedByUserId },
        select: { email: true, fullName: true },
      });
      if (!reporter?.email || !reporter.email.includes("@")) {
        this.logger.warn(
          `Neusaglašenost ${nc.reportNumber}: podnosilac #${nc.reportedByUserId} nema email — mejl preskočen.`,
        );
        return false;
      }
      const subject = `Neusaglašenost ${nc.reportNumber} — završeno`;
      const html = this.buildClosedHtml({
        greeting: reporter.fullName || "poštovani",
        reportNumber: nc.reportNumber,
        projectNumber: nc.projectNumber,
        investigationReport: nc.investigationReport,
        link: this.detailLink(nonconformityId),
      });
      return await this.mail.send({ to: reporter.email, subject, html });
    } catch (err) {
      this.logger.warn(
        `Obaveštenje podnosiocu za neusaglašenost ${nonconformityId} (ZAVRSENO) nije poslato: ${
          (err as Error).message
        }`,
      );
      return false;
    }
  }

  private buildNewReportHtml(p: {
    reportNumber: string;
    projectNumber: string | null;
    description: string;
    severity: string;
    locationKind: string;
    locationNote: string | null;
    reporterName: string;
    link: string;
  }): string {
    const desc = this.esc(p.description.slice(0, 800)).replace(/\n/g, "<br/>");
    const loc =
      (LOCATION_LABEL[p.locationKind] ?? p.locationKind) +
      (p.locationNote ? ` — ${this.esc(p.locationNote)}` : "");
    return `
      <p>Prijavljena je nova neusaglašenost na montaži:</p>
      <p style="margin:12px 0"><strong>${this.esc(p.reportNumber)}</strong> · predmet ${this.esc(
        p.projectNumber ?? "—",
      )}</p>
      <p style="margin:8px 0;color:#444"><strong>Ozbiljnost:</strong> ${this.esc(
        SEVERITY_LABEL[p.severity] ?? p.severity,
      )} &nbsp;·&nbsp; <strong>Lokacija:</strong> ${loc}</p>
      <p style="margin:8px 0;color:#444"><strong>Prijavio:</strong> ${this.esc(p.reporterName)}</p>
      <p style="margin:12px 0;white-space:pre-wrap">${desc}</p>
      <p style="margin:16px 0"><a href="${this.esc(p.link)}">Otvori neusaglašenost u aplikaciji</a></p>
      <p style="color:#666;font-size:13px;margin-top:16px">Ovo je automatska poruka sistema ServoSync (modul Montaža — neusaglašenosti).</p>`;
  }

  private buildClosedHtml(p: {
    greeting: string;
    reportNumber: string;
    projectNumber: string | null;
    investigationReport: string | null;
    link: string;
  }): string {
    const report = p.investigationReport
      ? `<p style="margin:12px 0"><strong>Nalaz istrage:</strong><br/>${this.esc(
          p.investigationReport,
        ).replace(/\n/g, "<br/>")}</p>`
      : "";
    return `
      <p>Poštovani ${this.esc(p.greeting)},</p>
      <p>Neusaglašenost koju ste prijavili je obrađena i zatvorena:</p>
      <p style="margin:12px 0"><strong>${this.esc(p.reportNumber)}</strong> · predmet ${this.esc(
        p.projectNumber ?? "—",
      )}</p>
      ${report}
      <p style="margin:16px 0"><a href="${this.esc(p.link)}">Otvori u aplikaciji</a></p>
      <p style="color:#666;font-size:13px;margin-top:16px">Ovo je automatska poruka sistema ServoSync (modul Montaža — neusaglašenosti).</p>`;
  }
}
