import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { MailService } from "../../common/mail/mail.service";
import { NotificationsService } from "../notifications/notifications.service";
import { uniqueIds } from "../../common/relations";

/** RN podaci koje obaveštenje o lansiranju prikazuje (isti podskup u oba toka). */
export interface LaunchNotifyWorkOrder {
  id: number;
  identNumber: string;
  variant: number;
  projectId: number;
  drawingNumber: string | null;
  pieceCount: number | null;
}

export interface LaunchNotifyInput {
  workOrder: LaunchNotifyWorkOrder;
  /** `drawing_handovers.id` iz koje je RN nastao. */
  handoverId: number;
  /** Crtež primopredaje kad ga pozivalac već ima; inače se dočitava iz baze. */
  drawingId?: number | null;
  /**
   * `work_order_launches.id` reda kreiranog u upravo komitovanoj transakciji —
   * ključ idempotencije. `null` = pozivalac ga nema (nikad u prod toku); tada se
   * šalje bez claim-a uz warn, jer je izgubljeno obaveštenje gore od duplog.
   */
  launchId: number | null;
  actorWorkerId: number | null;
  /** Ekran sa kog je lansirano — samo za audit u claim redu. */
  source: "handover" | "work_order";
}

/**
 * Obaveštenje planerima da je primopredaja lansirana u proizvodnju (zahtev 016/26
 * + dopuna): mejl (osnovni kanal) + in-app zvonce (Strahinja: „ako je moguće da").
 *
 * Izdvojeno iz `HandoversService.notifyLaunchPlanners` jer lansiranje ima DVA
 * ulaza — ekran „Primopredaje" (`handovers.launch`) i ekran „Radni nalozi"
 * (`work-orders.launch` nad RN-om sa `drawing_handover_id > 0`). Za planera je to
 * isti događaj, pa oba toka zovu isti servis; zaseban modul (`LaunchNotifyModule`)
 * drži zavisnost jednosmernom (work-orders ne uvlači ceo HandoversModule).
 *
 * Primaoci: planeri predmeta (`predmet_planeri` po `projects.id`) ∪ globalni
 * planeri (`project_id IS NULL`). Mejl ide na `users.email`; zvonce je
 * worker-scoped (`app_notifications.recipient_worker_id`), pa planer bez
 * `users.worker_id` dobija SAMO mejl — izostanak zvonca se loguje kao warn.
 *
 * Idempotencija: pre slanja se „claim-uje" red u `work_order_launch_notifications`
 * (UNIQUE po `work_order_launch_id`, insert sa ON CONFLICT DO NOTHING preko
 * `createMany skipDuplicates`). Ko upiše red — taj šalje; svaki sledeći poziv za
 * ISTI launch red (drugi ulaz, retry, dupli klik) tiho izlazi.
 *
 * Best-effort (D8 obrazac): metoda NIKAD ne baca — lansiranje je već komitovano.
 */
@Injectable()
export class LaunchNotifyService {
  private readonly logger = new Logger(LaunchNotifyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Pošalji „primopredaja lansirana" planerima predmeta (+ globalnima).
   * Nikad ne baca; svaki mejl ide u sopstvenom try/catch.
   */
  async notifyLaunch(input: LaunchNotifyInput): Promise<void> {
    const { workOrder, handoverId, launchId, actorWorkerId, source } = input;
    try {
      if (!(await this.claim(handoverId, launchId, workOrder.id, source)))
        return;

      const routed = await this.prisma.predmetPlaner.findMany({
        where: {
          OR: [{ projectId: workOrder.projectId }, { projectId: null }],
        },
        select: { plannerUserId: true },
      });
      const userIds = [...new Set(routed.map((r) => r.plannerUserId))];
      if (!userIds.length) return;

      // Cosmetic lookups must never sink the whole notification: the claim is
      // already spent, so a failed project/drawing/name read would silently cost
      // the planner their mail. Recipients are the only hard requirement.
      const [planners, project, drawingId, actorName] = await Promise.all([
        this.prisma.user.findMany({
          where: { id: { in: userIds }, active: true },
          select: { id: true, email: true, fullName: true, workerId: true },
        }),
        this.prisma.project
          .findUnique({
            where: { id: workOrder.projectId },
            select: { projectNumber: true, description: true, customerId: true },
          })
          .catch(() => null),
        this.resolveDrawingId(input).catch(() => null),
        this.resolveActorName(actorWorkerId).catch(() => "—"),
      ]);
      if (!planners.length) return;

      const drawing = drawingId
        ? await this.prisma.drawing
            .findUnique({
              where: { id: drawingId },
              select: { name: true, drawingNumber: true },
            })
            .catch(() => null)
        : null;
      const customer = project?.customerId
        ? await this.prisma.customer
            .findUnique({
              where: { id: project.customerId },
              select: { name: true },
            })
            .catch(() => null)
        : null;

      const rnLabel =
        workOrder.variant > 0
          ? `${workOrder.identNumber}-${workOrder.variant}`
          : workOrder.identNumber;
      const predmetLabel = [project?.projectNumber, project?.description]
        .filter(Boolean)
        .join(" — ");
      const partLabel = [
        drawing?.name,
        workOrder.drawingNumber ?? drawing?.drawingNumber,
      ]
        .filter(Boolean)
        .join(", ");
      // Container runs UTC — without the zone the bell and the mail would show a
      // different hour than the app does everywhere else.
      const launchedAt = new Date().toLocaleString("sr-RS", {
        timeZone: "Europe/Belgrade",
      });
      const subject = `Lansiran RN ${rnLabel}${
        predmetLabel ? ` — predmet ${project?.projectNumber ?? ""}` : ""
      }`.trim();

      const rows: string[] = [
        `<li><strong>Radni nalog:</strong> ${rnLabel}</li>`,
        predmetLabel
          ? `<li><strong>Predmet:</strong> ${predmetLabel}</li>`
          : "",
        customer?.name
          ? `<li><strong>Komitent:</strong> ${customer.name}</li>`
          : "",
        partLabel ? `<li><strong>Pozicija:</strong> ${partLabel}</li>` : "",
        workOrder.pieceCount != null
          ? `<li><strong>Količina:</strong> ${workOrder.pieceCount} kom</li>`
          : "",
        `<li><strong>Lansirao:</strong> ${actorName}, ${launchedAt}</li>`,
      ].filter(Boolean);

      await this.sendMails(planners, { subject, rows, handoverId });
      await this.ringBell(planners, {
        workOrderId: workOrder.id,
        message: [
          `Lansiran RN ${rnLabel}`,
          predmetLabel ? `predmet ${predmetLabel}` : "",
          partLabel ? `pozicija ${partLabel}` : "",
          workOrder.pieceCount != null ? `${workOrder.pieceCount} kom` : "",
          `lansirao ${actorName}, ${launchedAt}`,
        ]
          .filter(Boolean)
          .join(" — "),
      });
      await this.markNotified(handoverId);
    } catch (e) {
      // Lookups failed — log and swallow; the launch itself already committed.
      this.logger.error(
        `Notifikacija primopredaja.lansirana FAIL (RN ${workOrder.id}): ${msg(e)}`,
      );
    }
  }

  // ---------------------------------------------------------------- helpers

  /**
   * Claim the send for this HANDOVER (the stable identity of "documentation was
   * launched"). `createMany` + `skipDuplicates` = PG `ON CONFLICT DO NOTHING`
   * (never `ON CONFLICT ON CONSTRAINT <name>` — prod incident rule).
   * `count === 0` → someone already notified for this handover.
   *
   * The launch row id is stored for audit only: it is recycled (alignIdSequence
   * lowers the sequence when the newest launch row is deleted) and a re-launch
   * mints a new one, so it cannot carry idempotency (review 25.07).
   *
   * A claim write that itself fails must NOT swallow a launch that already
   * happened — we log and send anyway (worst case a duplicate mail, which beats
   * a silently missing one).
   */
  private async claim(
    handoverId: number,
    launchId: number | null,
    workOrderId: number,
    source: LaunchNotifyInput["source"],
  ): Promise<boolean> {
    try {
      const claimed = await this.prisma.workOrderLaunchNotification.createMany({
        data: [
          {
            drawingHandoverId: handoverId,
            workOrderLaunchId: launchId,
            workOrderId,
            source,
          },
        ],
        skipDuplicates: true,
      });
      if (claimed.count === 0) {
        this.logger.log(
          `Obaveštenje o lansiranju (primopredaja ${handoverId}, RN ${workOrderId}) je već poslato — preskočeno.`,
        );
        return false;
      }
      return true;
    } catch (e) {
      this.logger.warn(
        `Claim obaveštenja (primopredaja ${handoverId}, RN ${workOrderId}) nije upisan: ${msg(e)} — šaljem svejedno.`,
      );
      return true;
    }
  }

  /** Stamp delivery so a claimed-but-undelivered row stays visible (notified_at IS NULL). */
  private async markNotified(handoverId: number): Promise<void> {
    try {
      await this.prisma.workOrderLaunchNotification.updateMany({
        where: { drawingHandoverId: handoverId, notifiedAt: null },
        data: { notifiedAt: new Date() },
      });
    } catch (e) {
      this.logger.warn(
        `notified_at nije upisan (primopredaja ${handoverId}): ${msg(e)}`,
      );
    }
  }

  /** Crtež primopredaje: iz ulaza kad ga pozivalac ima, inače jedan lookup. */
  private async resolveDrawingId(
    input: LaunchNotifyInput,
  ): Promise<number | null> {
    if (input.drawingId != null) return input.drawingId;
    const handover = await this.prisma.drawingHandover.findUnique({
      where: { id: input.handoverId },
      select: { drawingId: true },
    });
    return handover?.drawingId ?? null;
  }

  /** Ime radnika koji je lansirao (isti fallback kao ostali handovers emit-ovi). */
  private async resolveActorName(
    actorWorkerId: number | null,
  ): Promise<string> {
    if (!actorWorkerId) return "korisnik aplikacije";
    const workers = await this.prisma.worker.findMany({
      where: { id: { in: [actorWorkerId] } },
      select: { id: true, fullName: true, username: true },
    });
    const actor = workers.find((w) => w.id === actorWorkerId);
    return actor?.fullName || actor?.username || "korisnik aplikacije";
  }

  /** Jedan mejl po planeru sa validnim `users.email`; pad jednog ne ruši ostale. */
  private async sendMails(
    planners: { id: number; email: string | null; fullName: string | null }[],
    ctx: { subject: string; rows: string[]; handoverId: number },
  ): Promise<void> {
    const recipients = planners.filter((p) => p.email?.includes("@"));
    for (const planner of recipients) {
      try {
        await this.mail.send({
          to: planner.email!,
          subject: ctx.subject,
          html:
            `<p>${planner.fullName ? `Poštovani ${planner.fullName},` : "Poštovani,"}</p>` +
            `<p>Primopredaja je lansirana u proizvodnju:</p>` +
            `<ul>${ctx.rows.join("")}</ul>` +
            `<p>— ServoSync</p>`,
        });
      } catch (e) {
        this.logger.error(
          `Mejl primopredaja.lansirana planeru ${planner.id} FAIL: ${msg(e)}`,
        );
      }
    }
  }

  /**
   * In-app zvonce (Strahinja, dopuna 016/26). Kanal je worker-scoped
   * (`app_notifications.recipient_worker_id`), pa planer bez `users.worker_id`
   * NE može dobiti zvonce — mejl mu je i dalje otišao, a izostanak se loguje kao
   * warn (da se vidi koga treba vezati za radnika). `refTable: 'work_orders'`
   * koristi POSTOJEĆI FE obrazac skoka na modul (app-shell NOTIFICATION_ROUTE).
   */
  private async ringBell(
    planners: {
      id: number;
      fullName: string | null;
      workerId: number | null;
    }[],
    ctx: { workOrderId: number; message: string },
  ): Promise<void> {
    const workerIds = uniqueIds(planners.map((p) => p.workerId));
    const without = planners.filter((p) => !p.workerId);
    if (without.length)
      this.logger.warn(
        `Zvonce o lansiranju preskočeno za ${without.length} planera bez vezanog radnika (users.worker_id): ${without
          .map((p) => p.fullName || `#${p.id}`)
          .join(", ")} — mejl je poslat.`,
      );
    if (!workerIds.length) return;

    try {
      const created = await this.notifications.notifyWorkers(workerIds, {
        type: "primopredaja.lansirana",
        message: ctx.message,
        refTable: "work_orders",
        refId: ctx.workOrderId,
      });
      this.logger.log(
        `Zvonce primopredaja.lansirana (RN ${ctx.workOrderId}): ${created} primalaca`,
      );
    } catch (e) {
      this.logger.error(
        `Zvonce primopredaja.lansirana FAIL (RN ${ctx.workOrderId}): ${msg(e)}`,
      );
    }
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
