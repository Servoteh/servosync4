import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { MailService } from "../../common/mail/mail.service";
import { NotificationsService } from "../notifications/notifications.service";
import { byId } from "../../common/relations";

export interface LaunchNotifyInput {
  /**
   * `work_orders.id` lansiranog RN-a. Čuva se radi audita i skoka sa zvonca;
   * u tekst obaveštenja NE ulazi (016/26 četvrti krug — poruka je o NACRTU).
   */
  workOrderId: number;
  /** `drawing_handovers.id` iz koje je RN nastao — ključ claim-a po poziciji. */
  handoverId: number;
  /**
   * `work_order_launches.id` reda kreiranog u upravo komitovanoj transakciji —
   * čist audit u claim redu (SERIAL se reciklira, pa NE nosi idempotenciju).
   */
  launchId: number | null;
  actorWorkerId: number | null;
  /** Ekran sa kog je lansirano — samo za audit u claim redu. */
  source: "handover" | "work_order";
}

/** Pending red iz `work_order_launch_notifications` (id null = fail-open bez claim reda). */
interface PendingRow {
  id: number | null;
  drawingHandoverId: number;
  workOrderId: number;
  actorWorkerId: number | null;
  createdAt: Date;
}

/** Sweeper tik — dovoljno čest da kašnjenje obaveštenja bude ±30 s. */
const SWEEP_INTERVAL_MS = 30_000;
/**
 * Prozor tišine pre slanja. Od ČETVRTOG kruga ovo više nije mehanizam
 * agregacije (to radi dedup po nacrtu), nego samo kratka pauza koja spaja
 * istovremene klikove u jedan prolaz i daje sweeperu da vidi ceo prvi nalet.
 */
const DEFAULT_SILENCE_MS = 180_000;
/** Kapa: i uz neprekidan rad, najstariji pending red čeka najviše ovoliko. */
const DEFAULT_MAX_WAIT_MS = 900_000;

/**
 * Obaveštenje planerima da je NACRT PRIMOPREDAJE lansiran u proizvodnju
 * (zahtev 016/26, ČETVRTI krug — Strahinja Petrović 04.08.2026: „Ukinuti da
 * stižu obaveštenja kad se lansira tehnologija u proizvodnju. Nek stiže
 * obaveštenje na mejl samo kad se lansira primopredaja i to je to. Ništa
 * drugo.").
 *
 * ŠTA JE „LANSIRANJE PRIMOPREDAJE" (Strahinjina definicija, komentar 27.07 na
 * istom zahtevu — ne naša interpretacija): „…da stigne za celu primopredaju, tj
 * NACRT primopredaje da je puštena, a ne za svaku pojedinačnu poziciju u toj
 * primopredaji". Jedinica obaveštenja je dakle `handover_drafts` (nacrt), a
 * ekran sa kog je kliknuto je nebitan.
 *
 * ZAŠTO NE PO EKRANU (`source`): izmereno 04.08 — svih 181/181 dosadašnjih
 * lansiranja došlo je sa ekrana „Radni nalozi" (`source='work_order'`),
 * NIJEDNO sa ekrana „Primopredaje". Gašenje tog puta = nula obaveštenja, pa se
 * gasi PO-POZICIJI granularnost, ne ulazna tačka.
 *
 * ZAŠTO NE PO AKTERU (kako je bilo u trećem krugu): nacrt se ne lansira u
 * jednom talasu — od 349 ikad lansiranih nacrta samo 95 (27%) je celo stalo u
 * 3 minuta, a 113 (32%) se lansira duže od dana; baš nacrt iz Strahinjinog
 * primera (G-260724-010, predmet 9400/7) razvučen je na 3 dana i 34 poziva.
 * Prozor tišine zato ne može da svede nacrt na jedan mejl.
 *
 * ZAŠTO NA PRVO LANSIRANJE, A NE „KAD JE NACRT 100% LANSIRAN": izmereno — 27
 * nacrta je trajno delimično lansirano, 16 nema nijedno lansiranje (npr.
 * G-260801-002: 4 od 139 pozicija). Čekanje na potpunost bi tim nacrtima
 * obaveštenje tiho pojelo zauvek.
 *
 * MEHANIKA: `notifyLaunch` SAMO upiše claim red (`work_order_launch_notifications`,
 * `notified_at IS NULL` = na čekanju) sa razrešenim `handover_draft_id`. Slanje
 * radi SWEEPER: in-process tik (30 s, obrazac SchedulerService — bez novih
 * zavisnosti, §10) grupiše pending redove PO NACRTU i za svaki nacrt pošalje
 * TAČNO JEDNO obaveštenje — pre slanja proverava da li za taj nacrt već postoji
 * obrađen red, pa ako postoji samo markira nove redove bez slanja.
 *
 * IDEMPOTENCIJA: dvoslojna — (1) claim po primopredaji (UNIQUE
 * `drawing_handover_id`, INSERT … ON CONFLICT DO NOTHING preko `createMany
 * skipDuplicates`) hvata dupli klik/retry/oba ekrana; (2) dedup po nacrtu hvata
 * sve ostale pozicije istog nacrta, i danima kasnije.
 *
 * RESTART ništa ne gubi: redovi su u bazi, sweeper posle boot-a nastavlja.
 * Restart IZMEĐU slanja i upisa `notified_at` može dati dupli mejl — svesno:
 * duplikat je jeftiniji od tihe rupe.
 *
 * Primaoci: planeri predmeta nacrta (`predmet_planeri` po `handover_drafts.project_id`)
 * ∪ globalni planeri (`project_id IS NULL`). Zvonce je worker-scoped — planer bez
 * `users.worker_id` dobija samo mejl (warn u logu).
 *
 * Best-effort (D8 obrazac): nijedna metoda ne baca — lansiranje je već komitovano.
 */
@Injectable()
export class LaunchNotifyService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LaunchNotifyService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweepBusy = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Tik kreće odmah po podizanju DI grafa — posle restarta pokupi i zatečene pending redove. */
  onModuleInit(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    // Ne drži proces u životu (boot-smoke, testovi, graceful shutdown).
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Zabeleži lansiranje pozicije. NE šalje odmah — upiše claim red sa razrešenim
   * nacrtom i pusti sweeper da pošalje JEDNO obaveštenje po nacrtu. Nikad ne baca.
   */
  async notifyLaunch(input: LaunchNotifyInput): Promise<void> {
    const { workOrderId, handoverId, actorWorkerId } = input;
    try {
      const draftId = await this.resolveDraftId(handoverId).catch(() => null);
      const claim = await this.claim(input, draftId);
      if (claim === "queued" || claim === "already") return;
      // Claim upis PUKAO (ne konflikt!) — red čekanja ne postoji, pa bi čekanje
      // sweepera obaveštenje tiho izgubilo. Fail-open: pošalji ODMAH, samo za
      // ovu poziciju (najgore dupli mejl, ne izgubljen).
      await this.flushDraft(draftId, [
        {
          id: null,
          drawingHandoverId: handoverId,
          workOrderId,
          actorWorkerId,
          createdAt: new Date(),
        },
      ]);
    } catch (e) {
      this.logger.error(
        `Notifikacija primopredaja.lansirana FAIL (RN ${workOrderId}): ${msg(e)}`,
      );
    }
  }

  /**
   * Jedan prolaz: grupiši pending redove PO NACRTU i pošalji grupe kojima je
   * prozor istekao. Javna radi testova; u pogonu je zove tajmer. Nikad ne baca;
   * overlap tikova brani `sweepBusy`.
   */
  async sweep(now: number = Date.now()): Promise<void> {
    if (this.sweepBusy) return;
    this.sweepBusy = true;
    try {
      const groups = await this.prisma.workOrderLaunchNotification.groupBy({
        by: ["handoverDraftId"],
        where: { notifiedAt: null },
        _min: { createdAt: true },
        _max: { createdAt: true },
      });
      if (!groups.length) return;

      const silence = envMs("LAUNCH_NOTIFY_SILENCE_MS", DEFAULT_SILENCE_MS);
      const maxWait = envMs("LAUNCH_NOTIFY_MAX_WAIT_MS", DEFAULT_MAX_WAIT_MS);
      for (const g of groups) {
        const newest = g._max.createdAt?.getTime() ?? 0;
        const oldest = g._min.createdAt?.getTime() ?? 0;
        if (now - newest < silence && now - oldest < maxWait) continue;
        await this.flushGroup(g.handoverDraftId);
      }
    } catch (e) {
      this.logger.warn(`Sweep obaveštenja o lansiranju nije prošao: ${msg(e)}`);
    } finally {
      this.sweepBusy = false;
    }
  }

  // ---------------------------------------------------------------- claim/queue

  /**
   * Nacrt iz kog je pozicija potekla. `drawing_handovers` NEMA FK ka nacrtu —
   * ista best-effort veza koju koristi ceo modul (`HandoversService.resolveDraftContext`):
   * crtež → najskorija NE-isključena stavka nacrta. NULL kad veza ne postoji
   * (legacy red); tada obaveštenje ide pojedinačno, da se ne izgubi tiho.
   */
  private async resolveDraftId(handoverId: number): Promise<number | null> {
    const handover = await this.prisma.drawingHandover.findUnique({
      where: { id: handoverId },
      select: { drawingId: true },
    });
    if (!handover) return null;
    const item = await this.prisma.handoverDraftItem.findFirst({
      where: { drawingId: handover.drawingId, excludeFromHandover: false },
      orderBy: [{ draftId: "desc" }, { id: "desc" }],
      select: { draftId: true },
    });
    return item?.draftId ?? null;
  }

  /**
   * Claim po PRIMOPREDAJI (`createMany` + `skipDuplicates` = PG `ON CONFLICT DO
   * NOTHING`; nikad `ON CONFLICT ON CONSTRAINT <ime>` — prod incident pravilo).
   * count 0 → red već postoji (poslato ili na čekanju).
   */
  private async claim(
    input: LaunchNotifyInput,
    handoverDraftId: number | null,
  ): Promise<"queued" | "already" | "failed"> {
    const { handoverId, launchId, workOrderId, actorWorkerId, source } = input;
    try {
      const claimed = await this.prisma.workOrderLaunchNotification.createMany({
        data: [
          {
            drawingHandoverId: handoverId,
            workOrderLaunchId: launchId,
            workOrderId,
            source,
            actorWorkerId,
            handoverDraftId,
          },
        ],
        skipDuplicates: true,
      });
      if (claimed.count === 0) {
        this.logger.log(
          `Obaveštenje o lansiranju (primopredaja ${handoverId}, RN ${workOrderId}) je već upisano — preskočeno.`,
        );
        return "already";
      }
      return "queued";
    } catch (e) {
      this.logger.warn(
        `Claim obaveštenja (primopredaja ${handoverId}, RN ${workOrderId}) nije upisan: ${msg(e)} — šaljem odmah pojedinačno.`,
      );
      return "failed";
    }
  }

  /** Pošalji pending redove jednog NACRTA kao jedno obaveštenje. */
  private async flushGroup(handoverDraftId: number | null): Promise<void> {
    const rows = await this.prisma.workOrderLaunchNotification.findMany({
      where: { notifiedAt: null, handoverDraftId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        drawingHandoverId: true,
        workOrderId: true,
        actorWorkerId: true,
        createdAt: true,
      },
    });
    if (!rows.length) return;
    if (handoverDraftId == null) {
      // Nerazrešen nacrt: redovi su međusobno NEPOVEZANI (razne primopredaje),
      // pa ne smeju u jedan mejl — degradacija na staro „jedno po poziciji".
      for (const row of rows) await this.flushDraft(null, [row]);
      return;
    }
    await this.flushDraft(handoverDraftId, rows);
  }

  // ---------------------------------------------------------------- flush/slanje

  /**
   * Pošalji obaveštenje „nacrt primopredaje je lansiran" za dati nacrt i markiraj
   * redove (`notified_at`). Podaci se dočitavaju IZ BAZE (redovi mogu biti
   * minutima stari, i iz života pre restarta). Nikad ne baca.
   */
  private async flushDraft(
    handoverDraftId: number | null,
    rows: PendingRow[],
  ): Promise<void> {
    try {
      // DEDUP PO NACRTU (jezgro četvrtog kruga): ako je za ovaj nacrt bilo koji
      // red već obrađen, obaveštenje je poslato — nove pozicije se samo markiraju.
      if (handoverDraftId != null) {
        const alreadySent = await this.prisma.workOrderLaunchNotification.count(
          {
            where: { handoverDraftId, notifiedAt: { not: null } },
          },
        );
        if (alreadySent > 0) {
          this.logger.log(
            `Nacrt ${handoverDraftId}: obaveštenje je već poslato — ${rows.length} novih pozicija samo markirano (016/26: jedno obaveštenje po nacrtu).`,
          );
          await this.stamp(rows);
          return;
        }
      }

      const ctx = await this.resolveContext(handoverDraftId, rows);
      if (!ctx) {
        // Bez predmeta nema kome da se ruta — markiraj (claim je potrošen) i izađi.
        this.logger.warn(
          `Obaveštenje o lansiranju: nacrt ${handoverDraftId ?? "—"} nema razrešiv predmet — ${rows.length} redova markirano bez slanja.`,
        );
        await this.stamp(rows);
        return;
      }

      const routed = await this.prisma.predmetPlaner.findMany({
        where: { OR: [{ projectId: ctx.projectId }, { projectId: null }] },
        select: { plannerUserId: true },
      });
      if (!routed.length) {
        await this.stamp(rows);
        return;
      }
      const planners = await this.prisma.user.findMany({
        where: {
          id: { in: [...new Set(routed.map((r) => r.plannerUserId))] },
          active: true,
        },
        select: { id: true, email: true, fullName: true, workerId: true },
      });
      if (!planners.length) {
        await this.stamp(rows);
        return;
      }

      const content = this.compose(ctx);
      const withoutWorker: string[] = [];
      for (const planner of planners) {
        if (planner.email?.includes("@")) {
          try {
            await this.mail.send({
              to: planner.email,
              subject: content.subject,
              html:
                `<p>${planner.fullName ? `Poštovani ${esc(planner.fullName)},` : "Poštovani,"}</p>` +
                content.html,
            });
          } catch (e) {
            this.logger.error(
              `Mejl primopredaja.lansirana planeru ${planner.id} FAIL: ${msg(e)}`,
            );
          }
        }
        if (planner.workerId) {
          try {
            await this.notifications.notifyWorkers([planner.workerId], {
              type: "primopredaja.lansirana",
              message: content.bell,
              // POSTOJEĆI FE obrazac skoka na modul (app-shell
              // NOTIFICATION_ROUTE); ref = prva lansirana pozicija nacrta.
              refTable: "work_orders",
              refId: rows[0].workOrderId,
            });
          } catch (e) {
            this.logger.error(
              `Zvonce primopredaja.lansirana FAIL (planer ${planner.id}): ${msg(e)}`,
            );
          }
        } else {
          withoutWorker.push(planner.fullName || `#${planner.id}`);
        }
      }
      if (withoutWorker.length)
        this.logger.warn(
          `Zvonce o lansiranju preskočeno za ${withoutWorker.length} planera bez vezanog radnika (users.worker_id): ${withoutWorker.join(", ")} — mejl je poslat.`,
        );

      await this.stamp(rows);
      this.logger.log(
        `Obaveštenje „nacrt lansiran" poslato: nacrt ${ctx.draftNumber || handoverDraftId || "—"}, predmet ${ctx.projectNumber ?? ctx.projectId}, ${planners.length} planera (${rows.length} pozicija u naletu).`,
      );
    } catch (e) {
      // Redovi OSTAJU pending (notified_at NULL) — sledeći sweep pokušava opet;
      // vidljiva rupa umesto tihe.
      this.logger.error(
        `Obaveštenje o lansiranju nacrta FAIL (${rows.length} redova): ${msg(e)}`,
      );
    }
  }

  /**
   * Nacrt + predmet + komitent + ko je lansirao i kada — jedini podaci koje
   * obaveštenje nosi (Strahinjin doslovan šablon). Kad nacrt nije razrešen,
   * predmet se vadi iz RN-a pozicije, a broj nacrta ostaje prazan.
   */
  private async resolveContext(
    handoverDraftId: number | null,
    rows: PendingRow[],
  ): Promise<{
    draftNumber: string;
    projectId: number;
    projectNumber: string | null;
    customerName: string | null;
    actorName: string;
    launchedAt: string;
  } | null> {
    const draft = handoverDraftId
      ? await this.prisma.handoverDraft
          .findUnique({
            where: { id: handoverDraftId },
            select: { draftNumber: true, projectId: true },
          })
          .catch(() => null)
      : null;

    let projectId = draft?.projectId ?? null;
    if (projectId == null) {
      const wo = await this.prisma.workOrder
        .findUnique({
          where: { id: rows[0].workOrderId },
          select: { projectId: true },
        })
        .catch(() => null);
      projectId = wo?.projectId ?? null;
    }
    if (projectId == null) return null;

    const project = await this.prisma.project
      .findUnique({
        where: { id: projectId },
        select: { projectNumber: true, customerId: true },
      })
      .catch(() => null);
    const customer = project?.customerId
      ? await this.prisma.customer
          .findUnique({
            where: { id: project.customerId },
            select: { name: true },
          })
          .catch(() => null)
      : null;

    return {
      draftNumber: draft?.draftNumber ?? "",
      projectId,
      projectNumber: project?.projectNumber ?? null,
      customerName: customer?.name ?? null,
      actorName: await this.resolveActorName(rows[0].actorWorkerId).catch(
        () => "korisnik aplikacije",
      ),
      // Vreme PRVOG lansiranja nacrta (ne trenutak slanja — mejl kasni do 3 min).
      // Kontejner radi u UTC; bez zone bi sat bio drugačiji nego svuda u aplikaciji.
      launchedAt: rows[0].createdAt.toLocaleString("sr-RS", {
        timeZone: "Europe/Belgrade",
      }),
    };
  }

  /**
   * DOSLOVAN šablon iz Strahinjinog komentara 27.07 na zahtevu 016/26 — nacrt,
   * predmet, komitent, ko je lansirao i kada. Pozicije/RN-ovi/količine se NE
   * navode („Ništa drugo", 04.08); planer detalje vidi u aplikaciji.
   */
  private compose(ctx: {
    draftNumber: string;
    projectId: number;
    projectNumber: string | null;
    customerName: string | null;
    actorName: string;
    launchedAt: string;
  }): { subject: string; html: string; bell: string } {
    const draftLabel = ctx.draftNumber || "—";
    const projectLabel = ctx.projectNumber ?? `#${ctx.projectId}`;
    const rows = [
      `<li><strong>Nacrt primopredaje:</strong> ${esc(draftLabel)}</li>`,
      `<li><strong>Predmet:</strong> ${esc(projectLabel)}</li>`,
      ctx.customerName
        ? `<li><strong>Komitent:</strong> ${esc(ctx.customerName)}</li>`
        : "",
      `<li><strong>Lansirao:</strong> ${esc(ctx.actorName)}, ${esc(ctx.launchedAt)}</li>`,
    ].filter(Boolean);

    return {
      subject: `Lansirana primopredaja — nacrt ${draftLabel}, predmet ${projectLabel}`,
      html:
        `<p>Primopredaja je lansirana u proizvodnju:</p>` +
        `<ul>${rows.join("")}</ul>` +
        `<p>— ServoSync</p>`,
      bell: [
        `Lansirana primopredaja — nacrt ${draftLabel}`,
        `predmet ${projectLabel}`,
        ctx.customerName ? `komitent ${ctx.customerName}` : "",
        `lansirao ${ctx.actorName}, ${ctx.launchedAt}`,
      ]
        .filter(Boolean)
        .join(" — "),
    };
  }

  /**
   * Markiraj redove kao obrađene. Fail-open red (id null) nema šta da markira;
   * uslov `notifiedAt: null` čuva stariji timestamp ako je neko već markirao.
   */
  private async stamp(rows: PendingRow[]): Promise<void> {
    const ids = rows.map((r) => r.id).filter((id): id is number => id != null);
    if (!ids.length) return;
    try {
      await this.prisma.workOrderLaunchNotification.updateMany({
        where: { id: { in: ids }, notifiedAt: null },
        data: { notifiedAt: new Date() },
      });
    } catch (e) {
      this.logger.warn(
        `notified_at nije upisan (${ids.length} redova): ${msg(e)} — sledeći sweep može poslati duplikat.`,
      );
    }
  }

  /** Ime radnika koji je lansirao (isti fallback kao ostali handovers emit-ovi). */
  private async resolveActorName(
    actorWorkerId: number | null,
  ): Promise<string> {
    if (!actorWorkerId) return "korisnik aplikacije";
    const workers = byId(
      await this.prisma.worker.findMany({
        where: { id: { in: [actorWorkerId] } },
        select: { id: true, fullName: true, username: true },
      }),
    );
    const actor = workers.get(actorWorkerId);
    return actor?.fullName || actor?.username || "korisnik aplikacije";
  }
}

/** Env broj u ms; prazan/nevalidan → default (0 je legitimno: šalji na prvi tik). */
function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Nazivi predmeta/komitenata su slobodan unos — ne smeju da razbiju HTML mejla. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
