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
  /** `work_orders.id` lansiranog RN-a — izvor predmeta za rutiranje. */
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

/** RN podaci koje obaveštenje koristi (dočitavaju se pri flush-u, iz baze). */
interface WorkOrderRef {
  identNumber: string;
  variant: number;
  projectId: number;
  drawingNumber: string | null;
  pieceCount: number | null;
}

/** Sweeper tik — dovoljno čest da kašnjenje obaveštenja bude ±30 s. */
const SWEEP_INTERVAL_MS = 30_000;
/**
 * Prozor tišine pre slanja. Od ČETVRTOG kruga ovo više nije mehanizam
 * agregacije (to radi dedup po nacrtu), nego samo kratka pauza koja spaja
 * istovremene klikove u jedan prolaz.
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
 * istom zahtevu): „…da stigne za celu primopredaju, tj NACRT primopredaje da je
 * puštena, a ne za svaku pojedinačnu poziciju u toj primopredaji". Jedinica
 * obaveštenja je `handover_drafts` (nacrt); ekran sa kog je kliknuto je nebitan
 * (izmereno: 181/181 lansiranja došlo je sa ekrana „Radni nalozi", nijedno sa
 * ekrana „Primopredaje" — gašenje tog puta bilo bi nula obaveštenja).
 *
 * ═══ DEDUP SAMO NA SIGURNOM (review-bloker, isti dan) ═══
 * Veza crtež→nacrt NEMA FK i IZMERENO je dvosmislena: 358 od 3.658 crteža
 * (9,8%) pripada više nacrta. Dok je ta veza bila kozmetička etiketa, pogrešan
 * pogodak je bio bezopasan; kao ključ garancije „tačno jednom zauvek" pogrešan
 * pogodak TRAJNO ućutkuje tuđi nacrt (izmereno: 4 nacrta bi zanemela odmah po
 * deploy-u — npr. G-260724-004 → G-260724-009, a G-260724-008 razrešava u
 * G-260724-010 unutar ISTOG predmeta, pa ni provera predmeta to ne bi uhvatila).
 * Zato:
 *   • nacrt se koristi kao ključ SAMO kad crtež pripada TAČNO JEDNOM
 *     ne-isključenom nacrtu I kad je predmet tog nacrta ISTI kao predmet RN-a;
 *   • u svakom drugom slučaju NEMA dedupa — obaveštenje ide po poziciji, tačno
 *     kao pre ovog paketa. Bolje da 9,8% dvosmislenih crteža i dalje šalje
 *     pojedinačno nego da ijedan nacrt trajno zanemi.
 * Rutiranje primalaca IDE UVEK PO `work_orders.project_id`, nikad po predmetu
 * razrešenog nacrta (izmereno: 280 pozicija u 33 nacrta razrešava u nacrt
 * DRUGOG predmeta — mejl bi otišao tuđim planerima sa tuđim predmetom u tekstu).
 *
 * ═══ „OBRAĐENO" NIJE „ISPORUČENO" ═══
 * `notified_at` = red obrađen u nekom prolazu; `sent_at` = bar jedan mejl/zvonce
 * stvarno uspeo. Dedup broji ISKLJUČIVO `sent_at` — inače bi SMTP ispad u
 * trenutku prvog lansiranja nacrt zapečatio zauvek. Pad isporuke uz postojeće
 * primaoce NE markira redove: ostaju pending i sledeći tik pokušava ponovo.
 *
 * MEHANIKA: `notifyLaunch` samo upiše claim red (sa nacrtom kad je siguran);
 * slanje radi SWEEPER (in-process tik 30 s, obrazac SchedulerService — bez novih
 * zavisnosti, §10) koji grupiše pending redove po nacrtu.
 *
 * IDEMPOTENCIJA: (1) claim po primopredaji (UNIQUE `drawing_handover_id`,
 * INSERT … ON CONFLICT DO NOTHING preko `createMany skipDuplicates`) hvata dupli
 * klik/retry/oba ekrana; (2) dedup po nacrtu (kad je siguran) hvata ostale
 * pozicije istog nacrta, i danima kasnije.
 *
 * RESTART ništa ne gubi: redovi su u bazi, sweeper posle boot-a nastavlja.
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
   * Zabeleži lansiranje pozicije. NE šalje odmah — upiše claim red (sa nacrtom
   * kad je veza sigurna) i pusti sweeper da pošalje. Nikad ne baca.
   */
  async notifyLaunch(input: LaunchNotifyInput): Promise<void> {
    const { workOrderId, handoverId, actorWorkerId } = input;
    try {
      const draftId = await this.resolveDraft(handoverId, workOrderId).catch(
        () => null,
      );
      const claim = await this.claim(input, draftId);
      if (claim === "queued" || claim === "already") return;
      // Claim upis PUKAO (ne konflikt!) — red čekanja ne postoji, pa bi čekanje
      // sweepera obaveštenje tiho izgubilo. Fail-open: pošalji ODMAH.
      await this.flush(draftId, [
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
   * Nacrt iz kog je pozicija potekla — ali SAMO kad je veza SIGURNA (vidi blok
   * „DEDUP SAMO NA SIGURNOM" iznad). Dva uslova, oba obavezna:
   *   1. crtež pripada TAČNO JEDNOM ne-isključenom nacrtu (nema pogađanja
   *      „najskorijeg" — baš to bi ućutkalo tuđi nacrt);
   *   2. predmet tog nacrta = predmet RN-a (inače bi mejl otišao tuđim
   *      planerima sa tuđim predmetom u tekstu).
   * Kad bilo koji uslov padne → `null` = nema dedupa, obaveštenje ide po
   * poziciji (staro ponašanje). Warn u logu da se vidi koliko je toga u praksi.
   */
  private async resolveDraft(
    handoverId: number,
    workOrderId: number,
  ): Promise<number | null> {
    const handover = await this.prisma.drawingHandover.findUnique({
      where: { id: handoverId },
      select: { drawingId: true },
    });
    if (!handover) return null;

    // NAMERNO bez `take`: Prisma primenjuje `take` u SQL-u, a `distinct` tek u
    // query engine-u — `take: 2` bi moglo da povuče DVA reda ISTOG nacrta (isti
    // crtež ume da bude više stavki jednog nacrta), distinct bi ih sveo na jedan
    // i dvosmislen crtež bi PROŠAO kao jednoznačan. Skup po crtežu je mali.
    const items = await this.prisma.handoverDraftItem.findMany({
      where: { drawingId: handover.drawingId, excludeFromHandover: false },
      select: { draftId: true },
      distinct: ["draftId"],
    });
    const draftIds = [...new Set(items.map((i) => i.draftId))];
    if (draftIds.length !== 1) {
      this.logger.warn(
        `Nacrt za primopredaju ${handoverId} (crtež ${handover.drawingId}) NIJE jednoznačan (kandidata: ${draftIds.length === 0 ? "0" : "2+"}) — obaveštenje ide po poziciji, bez dedupa po nacrtu.`,
      );
      return null;
    }

    const [draft, workOrder] = await Promise.all([
      this.prisma.handoverDraft.findUnique({
        where: { id: draftIds[0] },
        select: { projectId: true },
      }),
      this.prisma.workOrder.findUnique({
        where: { id: workOrderId },
        select: { projectId: true },
      }),
    ]);
    if (!draft || !workOrder || draft.projectId !== workOrder.projectId) {
      this.logger.warn(
        `Nacrt ${draftIds[0]} ima predmet ${draft?.projectId ?? "—"}, a RN ${workOrderId} predmet ${workOrder?.projectId ?? "—"} — ne poklapa se, obaveštenje ide po poziciji.`,
      );
      return null;
    }
    return draftIds[0];
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
      // Bez sigurnog nacrta redovi su međusobno NEPOVEZANI (razne primopredaje,
      // razni predmeti) — svaki ide kao zasebno obaveštenje po poziciji.
      for (const row of rows) await this.flush(null, [row]);
      return;
    }
    await this.flush(handoverDraftId, rows);
  }

  // ---------------------------------------------------------------- flush/slanje

  /**
   * Sastavi i pošalji obaveštenje za dati skup pending redova. `handoverDraftId`
   * != null → jedno obaveštenje o NACRTU (Strahinjin šablon); null → obaveštenje
   * po POZICIJI u dosadašnjem formatu (`rows` tada ima tačno jedan red).
   * Nikad ne baca.
   */
  private async flush(
    handoverDraftId: number | null,
    rows: PendingRow[],
  ): Promise<void> {
    try {
      // DEDUP PO NACRTU — broji SAMO stvarno isporučene redove (`sent_at`), pa
      // pad slanja ne pečati nacrt.
      if (handoverDraftId != null) {
        const alreadySent = await this.prisma.workOrderLaunchNotification.count(
          { where: { handoverDraftId, sentAt: { not: null } } },
        );
        if (alreadySent > 0) {
          this.logger.log(
            `Nacrt ${handoverDraftId}: obaveštenje je već isporučeno — ${rows.length} novih pozicija samo markirano (016/26: jedno obaveštenje po nacrtu).`,
          );
          await this.stamp(rows, false);
          return;
        }
      }

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
      const live = rows.filter((r) => woMap.has(r.workOrderId));
      if (!live.length) {
        // RN obrisan između lansiranja i flush-a — nema šta da se javi.
        this.logger.warn(
          `Obaveštenje o lansiranju: nijedan RN više ne postoji (${rows
            .map((r) => r.workOrderId)
            .join(", ")}) — ${rows.length} redova markirano bez slanja.`,
        );
        await this.stamp(rows, false);
        return;
      }

      // RUTIRANJE PO RN-u (nikad po predmetu razrešenog nacrta) — vidi blok gore.
      const projectIds = uniqueIds(
        live.map((r) => woMap.get(r.workOrderId)!.projectId),
      );
      const routed = await this.prisma.predmetPlaner.findMany({
        where: { OR: [{ projectId: { in: projectIds } }, { projectId: null }] },
        select: { plannerUserId: true },
      });
      const planners = routed.length
        ? await this.prisma.user.findMany({
            where: {
              id: { in: [...new Set(routed.map((r) => r.plannerUserId))] },
              active: true,
            },
            select: { id: true, email: true, fullName: true, workerId: true },
          })
        : [];
      if (!planners.length) {
        // Nema kome — red je OBRAĐEN, ali NIJE isporučen (nacrt ostaje otvoren).
        await this.stamp(rows, false);
        return;
      }

      const content = await this.compose(handoverDraftId, live, woMap);

      let delivered = false;
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
            delivered = true;
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
              // POSTOJEĆI FE obrazac skoka na modul (app-shell NOTIFICATION_ROUTE).
              refTable: "work_orders",
              refId: live[0].workOrderId,
            });
            delivered = true;
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

      if (!delivered) {
        // Primaoci POSTOJE, ali nijedan kanal nije prošao (SMTP/DB ispad). NE
        // markiramo: redovi ostaju pending i sledeći tik pokušava ponovo —
        // inače bi nacrt ostao trajno nem zbog trenutnog ispada.
        this.logger.error(
          `Obaveštenje o lansiranju NIJE isporučeno nijednom od ${planners.length} planera — ${rows.length} redova ostaje na čekanju za sledeći pokušaj.`,
        );
        return;
      }

      await this.stamp(rows, true);
      this.logger.log(
        `Obaveštenje o lansiranju isporučeno (${handoverDraftId != null ? `nacrt ${handoverDraftId}` : `pozicija/RN ${live[0].workOrderId}`}): ${planners.length} planera, ${rows.length} pozicija.`,
      );
    } catch (e) {
      // Redovi OSTAJU pending — sledeći sweep pokušava opet; vidljiva rupa
      // umesto tihe.
      this.logger.error(
        `Obaveštenje o lansiranju FAIL (${rows.length} redova): ${msg(e)}`,
      );
    }
  }

  /**
   * Tekst obaveštenja. Dva režima:
   *   • NACRT (siguran) — doslovan šablon iz Strahinjinog komentara 27.07:
   *     nacrt, predmet, komitent, ko je lansirao i kada. Bez RN-ova i pozicija.
   *   • POZICIJA (nacrt dvosmislen/nerazrešen) — dosadašnji format, poznat
   *     korisnicima. NIKAD „Nacrt primopredaje: —": kad nacrt nije siguran, o
   *     nacrtu se i ne govori.
   * Predmet/komitent UVEK iz RN-a (rutiranje i tekst moraju da se poklapaju).
   */
  private async compose(
    handoverDraftId: number | null,
    live: PendingRow[],
    woMap: Map<number, WorkOrderRef>,
  ): Promise<{ subject: string; html: string; bell: string }> {
    const first = woMap.get(live[0].workOrderId)!;
    const project = await this.prisma.project
      .findUnique({
        where: { id: first.projectId },
        select: { projectNumber: true, description: true, customerId: true },
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
    const actorName = await this.resolveActorName(live[0].actorWorkerId).catch(
      () => "korisnik aplikacije",
    );
    // Vreme PRVOG lansiranja (ne trenutak slanja — mejl kasni do 3 min).
    // Kontejner radi u UTC; bez zone bi sat bio drugačiji nego u aplikaciji.
    const launchedAt = live[0].createdAt.toLocaleString("sr-RS", {
      timeZone: "Europe/Belgrade",
    });
    const projectNumber = project?.projectNumber ?? `#${first.projectId}`;
    const signature = `<p>— ServoSync</p>`;
    const intro = `<p>Primopredaja je lansirana u proizvodnju:</p>`;

    if (handoverDraftId != null) {
      const draft = await this.prisma.handoverDraft
        .findUnique({
          where: { id: handoverDraftId },
          select: { draftNumber: true },
        })
        .catch(() => null);
      const draftLabel = draft?.draftNumber || `#${handoverDraftId}`;
      const items = [
        `<li><strong>Nacrt primopredaje:</strong> ${esc(draftLabel)}</li>`,
        `<li><strong>Predmet:</strong> ${esc(projectNumber)}</li>`,
        customer?.name
          ? `<li><strong>Komitent:</strong> ${esc(customer.name)}</li>`
          : "",
        `<li><strong>Lansirao:</strong> ${esc(actorName)}, ${esc(launchedAt)}</li>`,
      ].filter(Boolean);
      return {
        subject: `Lansirana primopredaja — nacrt ${draftLabel}, predmet ${projectNumber}`,
        html: intro + `<ul>${items.join("")}</ul>` + signature,
        bell: [
          `Lansirana primopredaja — nacrt ${draftLabel}`,
          `predmet ${projectNumber}`,
          customer?.name ? `komitent ${customer.name}` : "",
          `lansirao ${actorName}, ${launchedAt}`,
        ]
          .filter(Boolean)
          .join(" — "),
      };
    }

    // ── Režim POZICIJE (dosadašnji format) ──────────────────────────────────
    const drawing = await this.resolveDrawing(live[0].drawingHandoverId);
    const rnLabel =
      first.variant > 0
        ? `${first.identNumber}-${first.variant}`
        : first.identNumber;
    const predmetLabel = [project?.projectNumber, project?.description]
      .filter(Boolean)
      .join(" — ");
    const partLabel = [
      drawing?.name,
      first.drawingNumber ?? drawing?.drawingNumber,
    ]
      .filter(Boolean)
      .join(", ");
    const items = [
      `<li><strong>Radni nalog:</strong> ${esc(rnLabel)}</li>`,
      predmetLabel
        ? `<li><strong>Predmet:</strong> ${esc(predmetLabel)}</li>`
        : "",
      customer?.name
        ? `<li><strong>Komitent:</strong> ${esc(customer.name)}</li>`
        : "",
      partLabel ? `<li><strong>Pozicija:</strong> ${esc(partLabel)}</li>` : "",
      first.pieceCount != null
        ? `<li><strong>Količina:</strong> ${first.pieceCount} kom</li>`
        : "",
      `<li><strong>Lansirao:</strong> ${esc(actorName)}, ${esc(launchedAt)}</li>`,
    ].filter(Boolean);
    return {
      subject: `Lansiran RN ${rnLabel}${
        project?.projectNumber ? ` — predmet ${project.projectNumber}` : ""
      }`,
      html: intro + `<ul>${items.join("")}</ul>` + signature,
      bell: [
        `Lansiran RN ${rnLabel}`,
        predmetLabel ? `predmet ${predmetLabel}` : "",
        partLabel ? `pozicija ${partLabel}` : "",
        first.pieceCount != null ? `${first.pieceCount} kom` : "",
        `lansirao ${actorName}, ${launchedAt}`,
      ]
        .filter(Boolean)
        .join(" — "),
    };
  }

  /** Crtež primopredaje (samo režim pozicije; pad = mejl bez naziva pozicije). */
  private async resolveDrawing(
    handoverId: number,
  ): Promise<{ name: string | null; drawingNumber: string | null } | null> {
    try {
      const handover = await this.prisma.drawingHandover.findUnique({
        where: { id: handoverId },
        select: { drawingId: true },
      });
      if (!handover) return null;
      return await this.prisma.drawing.findUnique({
        where: { id: handover.drawingId },
        select: { name: true, drawingNumber: true },
      });
    } catch {
      return null;
    }
  }

  /**
   * Markiraj redove kao obrađene. `sent` = da li je isporuka STVARNO uspela —
   * samo tada se upisuje `sent_at` (jedini osnov dedupa po nacrtu). Fail-open
   * red (id null) nema šta da markira; uslov `notifiedAt: null` čuva stariji
   * timestamp ako je neko već markirao.
   */
  private async stamp(rows: PendingRow[], sent: boolean): Promise<void> {
    const ids = rows.map((r) => r.id).filter((id): id is number => id != null);
    if (!ids.length) return;
    const now = new Date();
    try {
      await this.prisma.workOrderLaunchNotification.updateMany({
        where: { id: { in: ids }, notifiedAt: null },
        data: sent ? { notifiedAt: now, sentAt: now } : { notifiedAt: now },
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
