import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { MailService } from "../../common/mail/mail.service";
import { NotificationsService } from "../notifications/notifications.service";
import { byId, uniqueIds } from "../../common/relations";

export interface LaunchNotifyInput {
  /**
   * `work_orders.id` lansiranog RN-a. Podaci za mejl (ident, pozicija, količina,
   * predmet) se NE prosleđuju — dočitavaju se iz baze pri flush-u, jer slanje
   * može da se desi minutima kasnije (i posle restarta, kad memorija ne postoji).
   */
  workOrderId: number;
  /** `drawing_handovers.id` iz koje je RN nastao — ključ idempotencije claim-a. */
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
}

/** Jedna pozicija u zbirnom obaveštenju (RN + naziv + količina + predmet). */
interface FlushItem {
  workOrderId: number;
  rnLabel: string;
  partLabel: string;
  pieceCount: number | null;
  projectId: number;
}

/** Sweeper tik — dovoljno čest da kap na kašnjenje bude ±30 s. */
const SWEEP_INTERVAL_MS = 30_000;
/**
 * Prozor tišine pre slanja. IZMERENO na produ (27.07–03.08, 129 lansiranja):
 * medijan razmaka između uzastopnih lansiranja ISTOG radnika je 96 s (p75=230 s),
 * a unutar najvećih talasa (10–11 RN za ~11 min) max razmak je 139 s — prozor od
 * „par sekundi" ne bi grupisao skoro ništa (samo 3/67 razmaka ≤30 s). 180 s spaja
 * svaki izmereni veliki talas u JEDAN mejl, uz cenu da i usamljeno lansiranje
 * čeka ~3 min (mejl nije real-time kanal; bolje kasnije nego 30 mejlova).
 */
const DEFAULT_SILENCE_MS = 180_000;
/** Kapa: i uz neprekidan rad aktera, najstariji pending red čeka najviše ovoliko. */
const DEFAULT_MAX_WAIT_MS = 900_000;
/** Preko ovoliko redova mejl seče listu („… i još N pozicija"). */
const MAX_MAIL_ROWS = 30;

/**
 * Obaveštenje planerima da je dokumentacija lansirana u proizvodnju (zahtev
 * 016/26; treći krug 03.08 — Strahinja: „Ne želimo obaveštenja za pojedinačne
 * pozicije… Samo za nacrt kad se lansira, ništa više.").
 *
 * Lansiranje NEMA bulk poziv: i ekran „Primopredaje" i ekran „Radni nalozi" šalju
 * jedan HTTP poziv PO POZICIJI, pa je svaki poziv slao svoj mejl + zvonce — nacrt
 * od 30 pozicija = 30 mejlova po planeru. Zato notifyLaunch od trećeg kruga SAMO
 * upisuje claim red (`work_order_launch_notifications`, `notified_at IS NULL` =
 * na čekanju), a slanje radi SWEEPER: in-process tik (30 s, obrazac
 * SchedulerService — bez novih zavisnosti, §10) grupiše pending redove PO AKTERU
 * i šalje JEDAN zbirni mejl/zvonce po planeru kad talas utihne
 * (`LAUNCH_NOTIFY_SILENCE_MS`, default 3 min — izmereno: medijan razmaka između
 * uzastopnih lansiranja je 96 s!) ili kad najstariji red čeka
 * `LAUNCH_NOTIFY_MAX_WAIT_MS` (default 15 min).
 *
 * Ključ agregacije je AKTER (jedna korisnikova akcija lansiranja), ne nacrt:
 * `drawing_handovers` nema FK ka nacrtu (veza je heuristika preko
 * `handover_draft_items.drawing_id`), a planer talas doživljava kao „X je
 * lansirao gomilu pozicija" — mejl pozicije grupiše po predmetu.
 *
 * IDEMPOTENCIJA (nepromenjena): claim po primopredaji (UNIQUE
 * `drawing_handover_id`, INSERT … ON CONFLICT DO NOTHING preko `createMany
 * skipDuplicates`) — dva ulaza (oba ekrana), retry i dupli klik i dalje daju
 * TAČNO jedan red = tačno jedno pojavljivanje u tačno jednom zbirnom mejlu.
 *
 * RESTART usred prozora ništa ne gubi: pending redovi su u bazi, sweeper posle
 * boot-a nastavlja gde je stao (najgore: talas presečen restartom stigne kao dva
 * mejla — dozvoljeno; izgubljen mejl nije). Restart IZMEĐU slanja i upisa
 * `notified_at` može dati dupli mejl — svesno: duplikat je jeftiniji od tihe rupe.
 *
 * Primaoci: planeri predmeta (`predmet_planeri` po `projects.id` pozicije) ∪
 * globalni planeri (`project_id IS NULL`); svaki planer u SVOM mejlu vidi samo
 * pozicije svojih predmeta (globalni sve). Zvonce je worker-scoped — planer bez
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
   * Zabeleži lansiranje za zbirno obaveštenje planerima. NE šalje odmah — upiše
   * claim red (idempotencija po primopredaji) i pusti sweeper da pošalje kad
   * talas utihne. Nikad ne baca.
   */
  async notifyLaunch(input: LaunchNotifyInput): Promise<void> {
    const { workOrderId, handoverId } = input;
    try {
      const claim = await this.claim(input);
      if (claim === "queued" || claim === "already") return;
      // Claim upis PUKAO (ne konflikt!) — red čekanja ne postoji, pa bi čekanje
      // sweepera obaveštenje tiho izgubilo. Fail-open kao i pre trećeg kruga:
      // pošalji ODMAH, samo ovu poziciju (najgore dupli mejl, ne izgubljen).
      await this.flushRows(
        [{ id: null, drawingHandoverId: handoverId, workOrderId }],
        input.actorWorkerId,
      );
    } catch (e) {
      this.logger.error(
        `Notifikacija primopredaja.lansirana FAIL (RN ${workOrderId}): ${msg(e)}`,
      );
    }
  }

  /**
   * Jedan prolaz agregacije: grupiši pending redove po akteru i pošalji grupe
   * kojima je talas utihnuo (ili kapa istekla). Javna radi testova; u pogonu je
   * zove tajmer. Nikad ne baca; overlap tikova brani `sweepBusy`.
   */
  async sweep(now: number = Date.now()): Promise<void> {
    if (this.sweepBusy) return;
    this.sweepBusy = true;
    try {
      const groups = await this.prisma.workOrderLaunchNotification.groupBy({
        by: ["actorWorkerId"],
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
        // Tišina od poslednjeg lansiranja ILI kapa od najstarijeg pending reda.
        if (now - newest < silence && now - oldest < maxWait) continue;
        await this.flushGroup(g.actorWorkerId);
      }
    } catch (e) {
      this.logger.warn(`Sweep obaveštenja o lansiranju nije prošao: ${msg(e)}`);
    } finally {
      this.sweepBusy = false;
    }
  }

  // ---------------------------------------------------------------- claim/queue

  /**
   * Claim po PRIMOPREDAJI (stabilan identitet „dokumentacija je lansirana").
   * `createMany` + `skipDuplicates` = PG `ON CONFLICT DO NOTHING` (nikad
   * `ON CONFLICT ON CONSTRAINT <ime>` — prod incident pravilo). count 0 → red
   * već postoji (poslato ili na čekanju). Launch id je samo audit — SERIAL se
   * reciklira (alignIdSequence), pa ne sme da nosi idempotenciju (review 25.07).
   */
  private async claim(
    input: LaunchNotifyInput,
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

  /** Pošalji SVE pending redove jednog aktera kao jedno zbirno obaveštenje. */
  private async flushGroup(actorWorkerId: number | null): Promise<void> {
    const rows = await this.prisma.workOrderLaunchNotification.findMany({
      where: { notifiedAt: null, actorWorkerId },
      orderBy: { createdAt: "asc" },
      select: { id: true, drawingHandoverId: true, workOrderId: true },
    });
    if (!rows.length) return;
    await this.flushRows(rows, actorWorkerId);
  }

  // ---------------------------------------------------------------- flush/slanje

  /**
   * Sastavi i pošalji zbirni mejl + zvonce za dati skup pending redova, pa ih
   * markiraj (`notified_at`). Podaci se dočitavaju IZ BAZE (redovi mogu biti
   * minutima stari, i iz života pre restarta). Nikad ne baca.
   */
  private async flushRows(
    rows: PendingRow[],
    actorWorkerId: number | null,
  ): Promise<void> {
    try {
      const workOrders = await this.prisma.workOrder.findMany({
        where: { id: { in: uniqueIds(rows.map((r) => r.workOrderId)) } },
        select: {
          id: true,
          identNumber: true,
          variant: true,
          projectId: true,
          drawingNumber: true,
          pieceCount: true,
        },
      });
      const woMap = byId(workOrders);
      const missing = rows.filter((r) => !woMap.has(r.workOrderId));
      if (missing.length)
        // RN obrisan između lansiranja i flush-a (redak, eksplicitan potez) —
        // markiraj da red ne zaglavi zauvek u pending skupu, izostavi iz mejla.
        this.logger.warn(
          `Zbirno obaveštenje: ${missing.length} RN više ne postoji (${missing
            .map((r) => r.workOrderId)
            .join(", ")}) — preskočeno u mejlu.`,
        );
      const live = rows.filter((r) => woMap.has(r.workOrderId));
      if (!live.length) {
        await this.stamp(rows);
        return;
      }

      // Primaoci su JEDINI tvrdi preduslov — bez planera nema kome da se šalje,
      // redovi se markiraju (claim je i do sada bio potrošen u tom slučaju).
      const projectIds = uniqueIds(
        live.map((r) => woMap.get(r.workOrderId)!.projectId),
      );
      const routed = await this.prisma.predmetPlaner.findMany({
        where: { OR: [{ projectId: { in: projectIds } }, { projectId: null }] },
        select: { plannerUserId: true, projectId: true },
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

      // Kozmetički lookup-ovi ne smeju da potope slanje (claim je već potrošen):
      // svaki pad daje prazan enrich, mejl ide sa onim što ima.
      const handoverIds = uniqueIds(live.map((r) => r.drawingHandoverId));
      const [handovers, projects, actorName] = await Promise.all([
        this.prisma.drawingHandover
          .findMany({
            where: { id: { in: handoverIds } },
            select: { id: true, drawingId: true },
          })
          .catch(() => []),
        this.prisma.project
          .findMany({
            where: { id: { in: projectIds } },
            select: {
              id: true,
              projectNumber: true,
              description: true,
              customerId: true,
            },
          })
          .catch(() => []),
        this.resolveActorName(actorWorkerId).catch(() => "korisnik aplikacije"),
      ]);
      const handoverMap = byId(handovers);
      const projectMap = byId(projects);
      const [drawings, customers] = await Promise.all([
        this.prisma.drawing
          .findMany({
            where: {
              id: { in: uniqueIds(handovers.map((h) => h.drawingId)) },
            },
            select: { id: true, name: true, drawingNumber: true },
          })
          .catch(() => []),
        this.prisma.customer
          .findMany({
            where: {
              id: { in: uniqueIds(projects.map((p) => p.customerId)) },
            },
            select: { id: true, name: true },
          })
          .catch(() => []),
      ]);
      const drawingMap = byId(drawings);
      const customerMap = byId(customers);

      const items: FlushItem[] = live.map((r) => {
        const wo = woMap.get(r.workOrderId)!;
        const drawingId = handoverMap.get(r.drawingHandoverId)?.drawingId;
        const drawing = drawingId ? drawingMap.get(drawingId) : undefined;
        return {
          workOrderId: wo.id,
          rnLabel:
            wo.variant > 0 ? `${wo.identNumber}-${wo.variant}` : wo.identNumber,
          partLabel: [drawing?.name, wo.drawingNumber ?? drawing?.drawingNumber]
            .filter(Boolean)
            .join(", "),
          pieceCount: wo.pieceCount,
          projectId: wo.projectId,
        };
      });

      // Kontejner radi u UTC — bez zone bi mejl/zvonce pokazivali drugi sat nego
      // aplikacija svuda inače.
      const launchedAt = new Date().toLocaleString("sr-RS", {
        timeZone: "Europe/Belgrade",
      });

      // Rutiranje po planeru: predmetni planer vidi SAMO pozicije svojih
      // predmeta, globalni (project_id IS NULL) sve.
      const globalPlannerIds = new Set(
        routed.filter((r) => r.projectId === null).map((r) => r.plannerUserId),
      );
      const projectsByPlanner = new Map<number, Set<number>>();
      for (const r of routed) {
        if (r.projectId === null) continue;
        const set = projectsByPlanner.get(r.plannerUserId) ?? new Set<number>();
        set.add(r.projectId);
        projectsByPlanner.set(r.plannerUserId, set);
      }

      const withoutWorker: string[] = [];
      for (const planner of planners) {
        const mine = globalPlannerIds.has(planner.id)
          ? items
          : items.filter((i) =>
              projectsByPlanner.get(planner.id)?.has(i.projectId),
            );
        if (!mine.length) continue;

        const content = this.compose(mine, {
          plannerName: planner.fullName,
          actorName,
          launchedAt,
          projectMap,
          customerMap,
        });

        if (planner.email?.includes("@")) {
          try {
            await this.mail.send({
              to: planner.email,
              subject: content.subject,
              html: content.html,
            });
          } catch (e) {
            this.logger.error(
              `Mejl primopredaja.lansirana planeru ${planner.id} FAIL: ${msg(e)}`,
            );
          }
        }
        if (planner.workerId) {
          try {
            const created = await this.notifications.notifyWorkers(
              [planner.workerId],
              {
                type: "primopredaja.lansirana",
                message: content.bell,
                // POSTOJEĆI FE obrazac skoka na modul (app-shell
                // NOTIFICATION_ROUTE); ref = prvi RN talasa.
                refTable: "work_orders",
                refId: mine[0].workOrderId,
              },
            );
            this.logger.log(
              `Zvonce primopredaja.lansirana (${mine.length} RN, planer ${planner.id}): ${created} primalaca`,
            );
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
        `Zbirno obaveštenje o lansiranju poslato: ${live.length} RN, akter ${actorWorkerId ?? "—"}, ${planners.length} planera.`,
      );
    } catch (e) {
      // Redovi OSTAJU pending (notified_at NULL) — sledeći sweep pokušava opet;
      // vidljiva rupa umesto tihe (isti princip kao do sada).
      this.logger.error(
        `Zbirno obaveštenje o lansiranju FAIL (${rows.length} redova): ${msg(e)}`,
      );
    }
  }

  /**
   * Sastavi subject + HTML mejla + tekst zvonca za JEDNOG planera.
   * 1 pozicija = dosadašnji format (poznat korisnicima); više = kompaktna lista
   * (RN, naziv pozicije, količina), preko MAX_MAIL_ROWS „… i još N".
   */
  private compose(
    items: FlushItem[],
    ctx: {
      plannerName: string | null;
      actorName: string;
      launchedAt: string;
      projectMap: Map<
        number,
        {
          projectNumber: string | null;
          description: string | null;
          customerId: number | null;
        }
      >;
      customerMap: Map<number, { name: string | null }>;
    },
  ): { subject: string; html: string; bell: string } {
    const { plannerName, actorName, launchedAt, projectMap, customerMap } = ctx;
    const greeting = `<p>${plannerName ? `Poštovani ${plannerName},` : "Poštovani,"}</p>`;
    const signature = `<p>— ServoSync</p>`;

    const myProjectIds = uniqueIds(items.map((i) => i.projectId));
    const projectLine = (projectId: number): string => {
      const p = projectMap.get(projectId);
      if (!p) return `#${projectId}`;
      const label = [p.projectNumber, p.description]
        .filter(Boolean)
        .join(" — ");
      const customer = p.customerId
        ? customerMap.get(p.customerId)?.name
        : null;
      return customer ? `${label} (${customer})` : label || `#${projectId}`;
    };
    const projectNumbers = myProjectIds
      .map((id) => projectMap.get(id)?.projectNumber)
      .filter((n): n is string => Boolean(n));
    const subjectProjects =
      projectNumbers.length === 0
        ? ""
        : projectNumbers.length === 1
          ? ` — predmet ${projectNumbers[0]}`
          : ` — predmeti ${projectNumbers.slice(0, 3).join(", ")}${projectNumbers.length > 3 ? "…" : ""}`;

    if (items.length === 1) {
      const it = items[0];
      const p = projectMap.get(it.projectId);
      const predmetLabel = [p?.projectNumber, p?.description]
        .filter(Boolean)
        .join(" — ");
      const customerName = p?.customerId
        ? customerMap.get(p.customerId)?.name
        : null;
      const rows: string[] = [
        `<li><strong>Radni nalog:</strong> ${it.rnLabel}</li>`,
        predmetLabel
          ? `<li><strong>Predmet:</strong> ${predmetLabel}</li>`
          : "",
        customerName
          ? `<li><strong>Komitent:</strong> ${customerName}</li>`
          : "",
        it.partLabel
          ? `<li><strong>Pozicija:</strong> ${it.partLabel}</li>`
          : "",
        it.pieceCount != null
          ? `<li><strong>Količina:</strong> ${it.pieceCount} kom</li>`
          : "",
        `<li><strong>Lansirao:</strong> ${actorName}, ${launchedAt}</li>`,
      ].filter(Boolean);
      return {
        subject: `Lansiran RN ${it.rnLabel}${
          p?.projectNumber ? ` — predmet ${p.projectNumber}` : ""
        }`,
        html:
          greeting +
          `<p>Primopredaja je lansirana u proizvodnju:</p>` +
          `<ul>${rows.join("")}</ul>` +
          signature,
        bell: [
          `Lansiran RN ${it.rnLabel}`,
          predmetLabel ? `predmet ${predmetLabel}` : "",
          it.partLabel ? `pozicija ${it.partLabel}` : "",
          it.pieceCount != null ? `${it.pieceCount} kom` : "",
          `lansirao ${actorName}, ${launchedAt}`,
        ]
          .filter(Boolean)
          .join(" — "),
      };
    }

    // Više pozicija = jedan talas (016/26 treći krug): kompaktna lista, pozicija
    // nosi predmet u zagradi samo kad ih je više (inače je red zaglavlja dovoljan).
    const multiProject = myProjectIds.length > 1;
    const shown = items.slice(0, MAX_MAIL_ROWS);
    const rest = items.length - shown.length;
    const list = shown
      .map((it) => {
        const bits = [
          `<strong>${it.rnLabel}</strong>`,
          it.partLabel || null,
          it.pieceCount != null ? `${it.pieceCount} kom` : null,
        ].filter(Boolean);
        const suffix = multiProject
          ? ` (predmet ${projectMap.get(it.projectId)?.projectNumber ?? `#${it.projectId}`})`
          : "";
        return `<li>${bits.join(" — ")}${suffix}</li>`;
      })
      .join("");
    const restRow = rest > 0 ? `<li>… i još ${rest} pozicija</li>` : "";
    const projectsBlock = `<p><strong>${multiProject ? "Predmeti" : "Predmet"}:</strong> ${myProjectIds
      .map(projectLine)
      .join("; ")}</p>`;

    return {
      subject: `Lansirano ${items.length} RN${subjectProjects}`,
      html:
        greeting +
        `<p>Lansirano je ${items.length} radnih naloga u proizvodnju:</p>` +
        `<ul>${list}${restRow}</ul>` +
        projectsBlock +
        `<p><strong>Lansirao:</strong> ${actorName}, ${launchedAt}</p>` +
        signature,
      bell: [
        `Lansirano ${items.length} RN`,
        projectNumbers.length
          ? `${multiProject ? "predmeti" : "predmet"} ${projectNumbers.slice(0, 3).join(", ")}${projectNumbers.length > 3 ? "…" : ""}`
          : "",
        `lansirao ${actorName}, ${launchedAt}`,
      ]
        .filter(Boolean)
        .join(" — "),
    };
  }

  /**
   * Markiraj redove kao poslate. Fail-open red (id null) nema šta da markira;
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
    const workers = await this.prisma.worker.findMany({
      where: { id: { in: [actorWorkerId] } },
      select: { id: true, fullName: true, username: true },
    });
    const actor = workers.find((w) => w.id === actorWorkerId);
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

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
