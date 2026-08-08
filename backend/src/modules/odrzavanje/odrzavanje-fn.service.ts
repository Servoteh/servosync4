import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { OdrzavanjeAuthzService, type MaintScope } from "./odrzavanje-authz.service";

/**
 * Prepis sy15 `SECURITY DEFINER` funkcija i LOGIČKIH trigera održavanja (CMMS)
 * u NestJS, nad 3.0 bazom — korak 2 seobe, docs/SEOBA_ODRZAVANJA_2026-08-06.md.
 *
 * ── ŠTA JE OVDE, A ŠTA NIJE ─────────────────────────────────────────────────
 * Domen ima 59 funkcija (43 sa prefiksom `maint_` + 16 bez njega). Prepisane su
 * ISKLJUČIVO one koje 3.0 backend STVARNO zove — izmereno `grep`-om nad `src/`
 * (06.08.2026), ne po katalogu. Ostale umiru sa sy15.
 *
 * Uz njih je prepisano i 11 trigera koji NISU mehanika nego poslovna logika
 * (migracija `20260806140000_odrzavanje_seoba_sy15` ih namerno NE prenosi;
 * prenosi 23 mehanička: 18 × `touch_updated_at`, dodela broja naloga i 4 guarda
 * tipa sredstva). Mereno `pg_trigger` nad živom sy15: 34 = 23 + 11.
 *
 *   maint_incidents_set_asset_fields           -> incidentSetAssetFields   (BEFORE IU)
 *   maint_incidents_log_changes                -> incidentLogChanges       (AFTER IU)
 *   maint_incidents_autocreate_work_order      -> incidentAutocreateWorkOrder (AFTER I)
 *   maint_incidents_enqueue_notify             -> incidentEnqueueNotify    (AFTER I)
 *   maint_machines_ensure_asset                -> machineEnsureAsset       (BEFORE I)
 *   maint_machines_sync_to_loc                 -> `OdrzavanjeLokacijeMostService` (AFTER IU)
 *   maint_apply_part_stock_movement            -> applyPartStockMovement   (AFTER I)
 *   maint_profiles_guard_role                  -> assertProfileRoleChange  (BEFORE U)
 *   maint_wo_log_field_changes                 -> woLogFieldChanges        (BEFORE U)
 *   maint_wo_service_plan_completion           -> woVehicleServicePlanCompletion (AFTER U)
 *   trg_maint_wo_asset_service_plan_completion -> woAssetServicePlanCompletion   (AFTER U)
 *
 * 🔴 OBAVEZA CRUD FAZE: nijedan upisni put NE SME da zaobiđe ove pozive.
 * Najskuplji primer je brojač: `maint_work_orders_assign_wo_number` JESTE
 * prenet u bazu kao trigger (`trg_maint_wo_assign_number`), pa nalog napravljen
 * mimo njega ne bi dobio broj — ali `maint_wo_events` trag, auto-nalog iz
 * incidenta i `current_stock` NEMAJU trigger u 3.0 i postoje SAMO ovde.
 *
 * ── IZVOR I ODSTUPANJA ──────────────────────────────────────────────────────
 * Sva tela su izvučena sa ŽIVE sy15 (`pg_get_functiondef`, 06.08.2026), ne iz
 * dokumentacije. Odstupanja su samo tri i sva su posledica seobe:
 *   1. `auth.uid()` ne postoji -> id pozivaoca je EKSPLICITAN argument
 *      (`MaintScope.userId`, Int u 3.0 umesto uuid u sy15);
 *   2. `auth.jwt() ->> 'email'` -> eksplicitan argument (samo `machineDeleteHard`);
 *   3. gejtovi prava (`maint_is_erp_admin`…) -> `OdrzavanjeAuthzService`
 *      (3.0 `users.role` ∪ `user_roles.role`, v. zaglavlje tog servisa).
 * PG enumi su u 3.0 String + CHECK, pa svi `::maint_*` castovi otpadaju — skup
 * dozvoljenih vrednosti je nepromenjen (CHECK ga i dalje brani).
 *
 * Sve metode primaju `tx` da bi ušle u transakciju pozivaoca: u sy15 su bile
 * DEFINER funkcije pozvane IZ iste transakcije, pa atomičnost mora ostati
 * (npr. „obriši mašinu + upiši trag brisanja" je jedan potez ili nijedan).
 */

/** Prisma klijent ILI transakcioni klijent — sve metode rade sa oba. */
export type OdrzavanjeTx = Prisma.TransactionClient;

/** Statusi naloga koji znače „zatvoren" (paritet `<> ALL (…)` iz view-ova). */
const WO_ZATVOREN = ["zavrsen", "otkazan"];

/** Podrazumevana podešavanja kad `maint_settings` reda nema (`IF NOT FOUND`). */
const SETTINGS_FALLBACK = {
  autoCreateWoMajor: true,
  autoCreateWoCritical: true,
  safetyMarkerRequiresWo: true,
  defaultWoPriority: "p4_planirano",
  majorWoDueHours: 48,
  criticalWoDueHours: 8,
  preventiveDueWarningDays: 7,
  notificationEnabled: true,
  notifyOnMajorIncident: true,
  notifyOnCriticalIncident: true,
  notificationChannels: null as string[] | null,
};

type SettingsLike = typeof SETTINGS_FALLBACK;

/** Argumenti `maint_enqueue_notification` (10 pozicionih parametara u sy15). */
export interface EnqueueNotifArgs {
  channel: string;
  recipient?: string | null;
  recipientUserId?: number | null;
  subject: string | null;
  body: string;
  relatedEntityType: string | null;
  relatedEntityId: string | null;
  machineCode?: string | null;
  escalationLevel?: number | null;
  payload?: Prisma.InputJsonValue | null;
}

/**
 * Odmak do sledećeg pokušaja kad fanout ne nađe NIJEDNOG primaoca (1 sat).
 *
 * Sa `MAINT_MAX_ATTEMPTS = 8` u radniku to daje ~8 sati ponovnih pokušaja — taman
 * da preklop koji je pušten pre nego što je prenos podataka gotov ipak isporuči
 * obaveštenje čim se `maint_user_profiles` napuni — a posle toga red trajno
 * ispada iz reda čekanja i ostaje kao VIDLJIV `failed`, ne kao lažni `sent`.
 */
const FANOUT_NO_RECIPIENTS_BACKOFF_SEC = 3600;

/** Rezultat `maint_check_*_deadlines` (RETURNS TABLE(enqueued, skipped)). */
export interface DeadlineResult {
  enqueued: number;
  skipped: number;
}

@Injectable()
export class OdrzavanjeFnService {
  private readonly log = new Logger(OdrzavanjeFnService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: OdrzavanjeAuthzService,
  ) {}

  /** Klijent koji se koristi kad pozivalac nije dao svoj `tx`. */
  private db(tx?: OdrzavanjeTx): OdrzavanjeTx {
    return tx ?? (this.prisma as unknown as OdrzavanjeTx);
  }

  // =========================================================================
  // Zajednički helper — `maint_settings` sa fallback-om (sy15 `IF NOT FOUND`)
  // =========================================================================

  /**
   * `SELECT * INTO v_settings FROM maint_settings WHERE id = 1` + `IF NOT FOUND`.
   * 🔴 Vrednosti fallback-a su prepisane iz `maint_incidents_autocreate_work_order`
   * (jedina funkcija koja ih izričito nabraja) — ne iz `@default` u schema.prisma.
   */
  async settings(tx?: OdrzavanjeTx): Promise<SettingsLike> {
    const row = await this.db(tx).maintSettings.findUnique({ where: { id: 1 } });
    if (!row) return { ...SETTINGS_FALLBACK };
    return {
      autoCreateWoMajor: row.autoCreateWoMajor,
      autoCreateWoCritical: row.autoCreateWoCritical,
      safetyMarkerRequiresWo: row.safetyMarkerRequiresWo,
      defaultWoPriority: row.defaultWoPriority,
      majorWoDueHours: row.majorWoDueHours,
      criticalWoDueHours: row.criticalWoDueHours,
      preventiveDueWarningDays: row.preventiveDueWarningDays,
      notificationEnabled: row.notificationEnabled,
      notifyOnMajorIncident: row.notifyOnMajorIncident,
      notifyOnCriticalIncident: row.notifyOnCriticalIncident,
      notificationChannels: row.notificationChannels ?? null,
    };
  }

  // =========================================================================
  // `maint_enqueue_notification` — jezgro outbox-a (dosegnuto kroz 3 pozivaoca)
  // =========================================================================

  /**
   * Prepis `maint_enqueue_notification(...)`. Upisuje red u outbox i vraća `id`.
   *
   * ⚠️ `coalesce(p_recipient, 'pending')` je deo izvora: outbox red SME da nastane
   * bez poznatog primaoca — primaoca kasnije razrešava `maint_dispatch_fanout`
   * (kopira telefon iz `maint_user_profiles`). Zato `recipient` NIJE obavezan.
   */
  async enqueueNotification(
    tx: OdrzavanjeTx | undefined,
    a: EnqueueNotifArgs,
  ): Promise<string> {
    const row = await this.db(tx).maintNotificationLog.create({
      data: {
        channel: a.channel,
        recipient: a.recipient ?? "pending",
        recipientUserId: a.recipientUserId ?? null,
        subject: a.subject,
        body: a.body,
        relatedEntityType: a.relatedEntityType,
        relatedEntityId: a.relatedEntityId,
        machineCode: a.machineCode ?? null,
        escalationLevel: a.escalationLevel ?? 0,
        status: "queued",
        // `scheduled_at`/`next_attempt_at` = now() (DB default) — kašnjenje po
        // pravilu dodaje pozivalac (v. `incidentEnqueueNotify`).
        payload: a.payload ?? Prisma.JsonNull,
      },
      select: { id: true },
    });
    return row.id;
  }

  // =========================================================================
  // TRIGERI NAD `maint_incidents` (4)
  // =========================================================================

  /**
   * `maint_incidents_set_asset_fields` (BEFORE INSERT OR UPDATE) — denormalizacija.
   *
   * Vraća polja koja se UPISUJU uz incident. Poziva se PRE `create`/`update`,
   * kao BEFORE trigger: ako se sredstvo nađe, `asset_id` i `asset_type` se
   * postavljaju, a `machine_code` se dopunjava šifrom sredstva ako je prazan.
   * Ako se ne nađe — polja ostaju kakva su došla (izvor tada ne dira NEW).
   */
  async incidentSetAssetFields(
    tx: OdrzavanjeTx | undefined,
    input: { machineCode: string | null; assetId: string | null },
  ): Promise<{
    machineCode: string | null;
    assetId: string | null;
    assetType: string | null;
  }> {
    const db = this.db(tx);
    let asset: { assetId: string; assetType: string; assetCode: string } | null =
      null;
    if (input.assetId == null) {
      const m = await db.maintMachine.findFirst({
        where: { machineCode: input.machineCode ?? "" },
        select: {
          asset: { select: { assetId: true, assetType: true, assetCode: true } },
        },
      });
      asset = m?.asset ?? null;
    } else {
      asset = await db.maintAsset.findUnique({
        where: { assetId: input.assetId },
        select: { assetId: true, assetType: true, assetCode: true },
      });
    }
    if (!asset) {
      return {
        machineCode: input.machineCode,
        assetId: input.assetId,
        assetType: null,
      };
    }
    const prazna =
      input.machineCode == null || input.machineCode.trim().length === 0;
    return {
      machineCode: prazna ? asset.assetCode : input.machineCode,
      assetId: asset.assetId,
      assetType: asset.assetType,
    };
  }

  /**
   * `maint_incidents_log_changes` (AFTER INSERT OR UPDATE) — revizioni trag.
   *
   * 🔴 Na INSERT upisuje TAČNO JEDAN red (`created`) i NE upisuje ni
   * `status_change` ni `assigned` — izvor tu radi `RETURN NEW` odmah. Prepis koji
   * bi obe grane pustio duplirao bi trag na svakoj prijavi kvara.
   */
  async incidentLogChanges(
    tx: OdrzavanjeTx | undefined,
    args: {
      incidentId: string;
      actor: number | null;
      op: "INSERT" | "UPDATE";
      old?: { status: string; assignedTo: number | null };
      neu: { status: string; assignedTo: number | null };
    },
  ): Promise<void> {
    const db = this.db(tx);
    if (args.op === "INSERT") {
      await db.maintIncidentEvent.create({
        data: {
          incidentId: args.incidentId,
          actor: args.actor,
          eventType: "created",
          fromValue: null,
          toValue: args.neu.status,
          comment: null,
        },
      });
      return;
    }
    const old = args.old;
    if (!old) return;
    if (old.status !== args.neu.status) {
      await db.maintIncidentEvent.create({
        data: {
          incidentId: args.incidentId,
          actor: args.actor,
          eventType: "status_change",
          fromValue: old.status,
          toValue: args.neu.status,
          comment: null,
        },
      });
    }
    if (old.assignedTo !== args.neu.assignedTo) {
      await db.maintIncidentEvent.create({
        data: {
          incidentId: args.incidentId,
          actor: args.actor,
          eventType: "assigned",
          fromValue: old.assignedTo == null ? null : String(old.assignedTo),
          toValue:
            args.neu.assignedTo == null ? null : String(args.neu.assignedTo),
          comment: null,
        },
      });
    }
  }

  /**
   * `maint_incidents_autocreate_work_order` (AFTER INSERT) — auto radni nalog.
   *
   * Vraća `wo_id` ako je nalog otvoren, inače `null`. Sam upisuje i povratnu vezu
   * `maint_incidents.work_order_id` (kao izvor).
   *
   * 🔴 Tri tiha izlaza koja se moraju zadržati: nalog već postoji · ozbiljnost i
   * podešavanja ne traže nalog · sredstvo se ne može razrešiti. Ni u jednom
   * izvor NE baca grešku — prijava kvara ostaje sačuvana i bez naloga.
   */
  async incidentAutocreateWorkOrder(
    tx: OdrzavanjeTx | undefined,
    inc: {
      id: string;
      machineCode: string | null;
      assetId: string | null;
      severity: string;
      safetyMarker: boolean | null;
      title: string;
      description: string | null;
      reportedBy: number;
      assignedTo: number | null;
      workOrderId: string | null;
    },
  ): Promise<string | null> {
    const db = this.db(tx);
    if (inc.workOrderId != null) return null;
    const s = await this.settings(tx);
    const safety = inc.safetyMarker === true;
    const traziNalog =
      (inc.severity === "critical" && s.autoCreateWoCritical) ||
      (inc.severity === "major" && s.autoCreateWoMajor) ||
      (safety && s.safetyMarkerRequiresWo);
    if (!traziNalog) return null;

    let asset: { assetId: string; assetType: string } | null = null;
    if (inc.assetId != null) {
      asset = await db.maintAsset.findUnique({
        where: { assetId: inc.assetId },
        select: { assetId: true, assetType: true },
      });
    } else {
      const m = await db.maintMachine.findFirst({
        where: { machineCode: inc.machineCode ?? "" },
        select: { assetId: true },
      });
      asset = m ? { assetId: m.assetId, assetType: "machine" } : null;
    }
    if (!asset) return null;

    const priority =
      inc.severity === "critical" || safety
        ? "p1_zastoj"
        : inc.severity === "major"
          ? (s.defaultWoPriority ?? "p2_smetnja")
          : (s.defaultWoPriority ?? "p4_planirano");
    const status = inc.severity === "critical" ? "potvrden" : "novi";
    const dueHours =
      inc.severity === "critical" || safety
        ? s.criticalWoDueHours
        : s.majorWoDueHours;

    const wo = await db.maintWorkOrder.create({
      data: {
        type: "incident",
        assetId: asset.assetId,
        assetType: asset.assetType,
        sourceIncidentId: inc.id,
        title: inc.title,
        description: inc.description,
        priority,
        status,
        reportedBy: inc.reportedBy,
        assignedTo: inc.assignedTo,
        safetyMarker: safety,
        dueAt: new Date(Date.now() + dueHours * 3_600_000),
      },
      select: { woId: true },
    });
    await db.maintIncident.update({
      where: { id: inc.id },
      data: { workOrderId: wo.woId },
    });
    return wo.woId;
  }

  /**
   * `maint_incidents_enqueue_notify` (AFTER INSERT) — obaveštenja o kvaru.
   *
   * 🔴 `IF v_count = 0` grana: kad nijedno pravilo ne odgovara, ipak se upisuje
   * JEDAN `in_app` red. Bez toga bi major/critical kvar prošao NEMO na svakoj
   * instalaciji koja nema definisana pravila (u sy15 ih je 3).
   */
  async incidentEnqueueNotify(
    tx: OdrzavanjeTx | undefined,
    inc: {
      id: string;
      machineCode: string | null;
      assetId: string | null;
      assetType: string | null;
      severity: string;
      status: string;
      title: string;
      reportedBy: number;
      assignedTo: number | null;
    },
  ): Promise<number> {
    const db = this.db(tx);
    const s = await this.settings(tx);
    if (!s.notificationEnabled) return 0;
    if (inc.severity === "major" && !s.notifyOnMajorIncident) return 0;
    if (inc.severity === "critical" && !s.notifyOnCriticalIncident) return 0;
    if (inc.severity !== "major" && inc.severity !== "critical") return 0;

    const subject = `[Održavanje] ${inc.severity.toUpperCase()} incident: ${inc.title}`;
    const body = `Sredstvo ${inc.machineCode ?? inc.assetId ?? "—"} — ${inc.title} (${inc.severity}). Status: ${inc.status}.`;

    const rules = await db.maintNotificationRule.findMany({
      where: {
        enabled: true,
        eventType: "incident_created",
        OR: [{ severity: null }, { severity: inc.severity }],
        AND: [
          { OR: [{ assetType: null }, { assetType: inc.assetType }] },
          s.notificationChannels && s.notificationChannels.length > 0
            ? { channel: { in: s.notificationChannels } }
            : {},
        ],
      },
      orderBy: [{ escalationLevel: "asc" }, { delayMinutes: "asc" }],
    });

    let count = 0;
    for (const r of rules) {
      const id = await this.enqueueNotification(tx, {
        channel: r.channel,
        recipient: null,
        recipientUserId: null,
        subject,
        body,
        relatedEntityType: "maint_incident",
        relatedEntityId: inc.id,
        machineCode: inc.machineCode,
        escalationLevel: r.escalationLevel,
        payload: {
          severity: inc.severity,
          reported_by: inc.reportedBy,
          assigned_to: inc.assignedTo,
          target_role: r.targetRole,
          rule_id: r.ruleId,
        } as Prisma.InputJsonValue,
      });
      // Kašnjenje po pravilu — izvor to radi zasebnim UPDATE-om posle upisa.
      const delay = (r.delayMinutes ?? 0) * 60_000;
      if (delay > 0) {
        const kada = new Date(Date.now() + delay);
        await db.maintNotificationLog.update({
          where: { id },
          data: { scheduledAt: kada, nextAttemptAt: kada },
        });
      }
      count += 1;
    }

    if (count === 0) {
      await this.enqueueNotification(tx, {
        channel: "in_app",
        recipient: null,
        recipientUserId: null,
        subject,
        body,
        relatedEntityType: "maint_incident",
        relatedEntityId: inc.id,
        machineCode: inc.machineCode,
        escalationLevel: 0,
        payload: {
          severity: inc.severity,
          reported_by: inc.reportedBy,
          assigned_to: inc.assignedTo,
        } as Prisma.InputJsonValue,
      });
    }
    return count;
  }

  // =========================================================================
  // TRIGERI NAD `maint_machines` (2) i `maint_user_profiles` (1)
  // =========================================================================

  /**
   * `maint_machines_ensure_asset` (BEFORE INSERT) — mašina uvek ima sredstvo.
   *
   * Vraća `asset_id` koji treba upisati uz mašinu: postojeći (poklapanje po
   * `lower(asset_code)` i tipu `machine`) ili NOVOSTVOREN.
   *
   * 🔴 Poštuje već popunjen `assetId` i vraća ga netaknutog (`IF NEW.asset_id IS
   * NOT NULL THEN RETURN NEW`). O tome visi `machineRename`: kopija mašine MORA
   * da ponese `asset_id`, inače bi ovde nastalo PRAZNO novo sredstvo i mašina bi
   * izgubila naloge, kvarove i dokumenta (zahtev 047/26).
   */
  async machineEnsureAsset(
    tx: OdrzavanjeTx | undefined,
    m: {
      assetId: string | null;
      machineCode: string;
      name: string;
      responsibleUserId: number | null;
      manufacturer: string | null;
      model: string | null;
      serialNumber: string | null;
      notes: string | null;
      archivedAt: Date | null;
      createdAt?: Date | null;
      updatedAt?: Date | null;
    },
  ): Promise<string> {
    const db = this.db(tx);
    if (m.assetId != null) return m.assetId;
    const postojece = await db.maintAsset.findFirst({
      where: {
        assetType: "machine",
        assetCode: { equals: m.machineCode, mode: "insensitive" },
      },
      select: { assetId: true },
    });
    if (postojece) return postojece.assetId;
    const now = new Date();
    const kreiran = await db.maintAsset.create({
      data: {
        assetCode: m.machineCode,
        assetType: "machine",
        name: m.name,
        status: "running",
        responsibleUserId: m.responsibleUserId,
        manufacturer: m.manufacturer,
        model: m.model,
        serialNumber: m.serialNumber,
        notes: m.notes,
        active: m.archivedAt == null,
        archivedAt: m.archivedAt,
        createdAt: m.createdAt ?? now,
        updatedAt: m.updatedAt ?? now,
      },
      select: { assetId: true },
    });
    return kreiran.assetId;
  }

  /**
   * `maint_profiles_guard_role` (BEFORE UPDATE) — brana od samododele role.
   *
   * 🔴 RLS `maint_profiles_update` dozvoljava korisniku da menja SVOJ red
   * (`uid() = user_id`). Bez ovog guarda bi svako sebi postavio `role='admin'`
   * ili `active=true` i time otvorio ceo modul. Menjati `role`/`active` sme
   * ISKLJUČIVO ERP admin — i to je jedini razlog zašto profil uopšte ima trigger.
   */
  assertProfileRoleChange(
    scope: MaintScope,
    old: { role: string; active: boolean },
    neu: { role?: string; active?: boolean },
  ): void {
    const menjaRolu = neu.role !== undefined && neu.role !== old.role;
    const menjaAktivnost =
      neu.active !== undefined && neu.active !== old.active;
    if (!menjaRolu && !menjaAktivnost) return;
    if (this.authz.canChangeProfileRole(scope)) return;
    throw new ForbiddenException(
      "Samo ERP admin sme da menja role/active u maint_user_profiles.",
    );
  }

  // =========================================================================
  // TRIGER NAD `maint_part_stock_movements` (1)
  // =========================================================================

  /**
   * `maint_apply_part_stock_movement` (AFTER INSERT) — `current_stock += delta`.
   *
   * 🔴 `adjustment` DODAJE količinu (ne postavlja je), a `return` je isto što i
   * `in`. To je prepis, ne izbor: izvor ima CASE sa četiri grane od kojih tri
   * daju `+quantity`, a samo `out` daje `-quantity`.
   */
  async applyPartStockMovement(
    tx: OdrzavanjeTx | undefined,
    mv: { partId: string; movementType: string; quantity: Prisma.Decimal | number },
  ): Promise<void> {
    const q = new Prisma.Decimal(mv.quantity as never);
    const delta =
      mv.movementType === "out" ? q.negated() : mv.movementType === "in" || mv.movementType === "return" || mv.movementType === "adjustment" ? q : null;
    // Nepoznat tip -> `CASE` bez `ELSE` daje NULL, a `stock + NULL` je NULL.
    // U 3.0 CHECK brani nepoznat tip, pa je ovo mrtva grana — ali tiho NE menja stanje.
    if (delta === null) return;
    await this.db(tx).maintPart.update({
      where: { partId: mv.partId },
      data: { currentStock: { increment: delta } },
    });
  }

  // =========================================================================
  // TRIGERI NAD `maint_work_orders` (3)
  // =========================================================================

  /**
   * `maint_wo_log_field_changes` (BEFORE UPDATE) — trag izmena naloga.
   * Beleži TRI polja: status, dodela, prioritet. Ostala se ne prate.
   */
  async woLogFieldChanges(
    tx: OdrzavanjeTx | undefined,
    args: {
      woId: string;
      actor: number | null;
      old: { status: string; assignedTo: number | null; priority: string };
      neu: {
        status?: string;
        assignedTo?: number | null;
        priority?: string;
      };
    },
  ): Promise<void> {
    const db = this.db(tx);
    const upisi = async (
      eventType: string,
      from: string | null,
      to: string | null,
    ) =>
      db.maintWoEvent.create({
        data: {
          woId: args.woId,
          actor: args.actor,
          eventType,
          fromValue: from,
          toValue: to,
          comment: null,
        },
      });
    if (args.neu.status !== undefined && args.neu.status !== args.old.status) {
      await upisi("status_change", args.old.status, args.neu.status);
    }
    if (
      args.neu.assignedTo !== undefined &&
      args.neu.assignedTo !== args.old.assignedTo
    ) {
      await upisi(
        "assigned_change",
        args.old.assignedTo == null ? null : String(args.old.assignedTo),
        args.neu.assignedTo == null ? null : String(args.neu.assignedTo),
      );
    }
    if (
      args.neu.priority !== undefined &&
      args.neu.priority !== args.old.priority
    ) {
      await upisi("priority_change", args.old.priority, args.neu.priority);
    }
  }

  /**
   * `maint_wo_service_plan_completion` (AFTER UPDATE) — zatvaranje roka plana
   * servisa VOZILA. Okida se samo na PRELAZ statusa u `zavrsen`.
   */
  async woVehicleServicePlanCompletion(
    tx: OdrzavanjeTx | undefined,
    wo: {
      servicePlanId: string | null;
      status: string;
      oldStatus: string;
      completedAt: Date | null;
      odometerKmAtService: number | null;
      updatedBy: number | null;
    },
  ): Promise<void> {
    if (wo.servicePlanId == null) return;
    if (wo.status !== "zavrsen" || wo.oldStatus === wo.status) return;
    const plan = await this.db(tx).maintVehicleServicePlan.findUnique({
      where: { planId: wo.servicePlanId },
      select: { lastDoneKm: true },
    });
    if (!plan) return;
    await this.db(tx).maintVehicleServicePlan.update({
      where: { planId: wo.servicePlanId },
      data: {
        lastDoneAt: danOd(wo.completedAt),
        // `COALESCE(NEW.odometer_km_at_service, last_done_km)` — zadrži staro
        // stanje km kad nalog nije uneo novo.
        lastDoneKm: wo.odometerKmAtService ?? plan.lastDoneKm,
        updatedAt: new Date(),
        updatedBy: wo.updatedBy,
      },
    });
  }

  /**
   * `trg_maint_wo_asset_service_plan_completion` (AFTER UPDATE) — isto za plan
   * SREDSTVA. ⚠️ Ovaj NE dira km (plan sredstva ih nema) i `updated_by` uzima od
   * pozivaoca (`auth.uid()`), a ne iz `NEW.updated_by` kao vozilski parnjak.
   */
  async woAssetServicePlanCompletion(
    tx: OdrzavanjeTx | undefined,
    wo: {
      assetServicePlanId: string | null;
      status: string;
      oldStatus: string;
      completedAt: Date | null;
    },
    actorUserId: number | null,
  ): Promise<void> {
    if (wo.assetServicePlanId == null) return;
    if (wo.status !== "zavrsen" || wo.oldStatus === wo.status) return;
    await this.db(tx).maintAssetServicePlan.updateMany({
      where: { planId: wo.assetServicePlanId },
      data: {
        lastDoneAt: danOd(wo.completedAt),
        updatedAt: new Date(),
        updatedBy: actorUserId,
      },
    });
  }

  // =========================================================================
  // DEFINER FUNKCIJE — katalog mašina
  // =========================================================================

  /**
   * `maint_machine_rename(old, new)` — preimenovanje mašine (šifra je PK).
   *
   * 🔴 Redosled je deo pravila i ne sme se „pojednostaviti" u `UPDATE PK`:
   * pravi se KOPIJA reda pod novom šifrom, pa se prebacuje 7 tabela dece, pa se
   * (uslovno) preimenuje sredstvo, pa se briše stari red. Direktan `UPDATE`
   * ključa bi ostavio decu bez roditelja — u sy15 između njih NEMA FK-a.
   *
   * 🔴 Kopija MORA da ponese `asset_id` (zahtev 047/26). Bez toga bi ovde u 3.0
   * `machineEnsureAsset` napravio prazno novo sredstvo i mašina bi izgubila
   * naloge/kvarove/dokumenta (sve visi o `asset_id`).
   */
  async machineRename(
    tx: OdrzavanjeTx | undefined,
    scope: MaintScope,
    oldCode: string,
    newCode: string,
  ): Promise<Record<string, unknown>> {
    const db = this.db(tx);
    // Gejt: `maint_is_erp_admin() OR maint_profile_role() IN ('chief','admin')`
    // — 🔴 UŽE od `machineDeleteHard` (nema `erp_admin_or_management`).
    if (
      !this.authz.isErpAdmin(scope) &&
      scope.profileRole !== "chief" &&
      scope.profileRole !== "admin"
    ) {
      throw new ForbiddenException("maint_machine_rename: not authorized");
    }
    if (!oldCode || oldCode.trim() === "") {
      throw new UnprocessableEntityException("maint_machine_rename: old code is required");
    }
    if (!newCode || newCode.trim() === "") {
      throw new UnprocessableEntityException("maint_machine_rename: new code is required");
    }
    if (oldCode === newCode) {
      throw new UnprocessableEntityException(
        "maint_machine_rename: old and new codes are the same",
      );
    }
    const stara = await db.maintMachine.findUnique({
      where: { machineCode: oldCode },
    });
    if (!stara) {
      throw new NotFoundException(
        `maint_machine_rename: machine "${oldCode}" does not exist`,
      );
    }
    const zauzeta = await db.maintMachine.findUnique({
      where: { machineCode: newCode },
      select: { machineCode: true },
    });
    if (zauzeta) {
      throw new UnprocessableEntityException(
        `maint_machine_rename: machine "${newCode}" already exists`,
      );
    }

    // 1) Kopija pod novom šifrom — sa `assetId` (v. gore).
    await db.maintMachine.create({
      data: {
        machineCode: newCode,
        name: stara.name,
        type: stara.type,
        manufacturer: stara.manufacturer,
        model: stara.model,
        serialNumber: stara.serialNumber,
        yearOfManufacture: stara.yearOfManufacture,
        yearCommissioned: stara.yearCommissioned,
        location: stara.location,
        departmentId: stara.departmentId,
        powerKw: stara.powerKw,
        weightKg: stara.weightKg,
        notes: stara.notes,
        tracked: stara.tracked,
        archivedAt: stara.archivedAt,
        source: stara.source,
        responsibleUserId: stara.responsibleUserId,
        assetId: stara.assetId,
        createdAt: stara.createdAt,
        updatedAt: new Date(),
        updatedBy: scope.userId,
      },
    });

    // 2) Sedam tabela dece — sve vise ISKLJUČIVO o `machine_code`.
    const gde = { machineCode: oldCode };
    const na = { machineCode: newCode };
    const tasks = await db.maintTask.updateMany({ where: gde, data: na });
    const checks = await db.maintCheck.updateMany({ where: gde, data: na });
    const incidents = await db.maintIncident.updateMany({ where: gde, data: na });
    const notes = await db.maintMachineNote.updateMany({ where: gde, data: na });
    const overrides = await db.maintMachineStatusOverride.updateMany({
      where: gde,
      data: na,
    });
    const notif = await db.maintNotificationLog.updateMany({
      where: gde,
      data: na,
    });
    // 2b) 047/26 — bez ovog koraka fajlovi ostaju na staroj šifri i pripadnu
    // prvoj sledećoj mašini koja je zauzme.
    const files = await db.maintMachineFile.updateMany({ where: gde, data: na });

    // 3) Ogledalo u `maint_assets` — samo ako je šifra sredstva bila ODRAZ stare.
    let assetRenamed = false;
    const asset = await db.maintAsset.findUnique({
      where: { assetId: stara.assetId },
      select: { assetCode: true },
    });
    if (asset && asset.assetCode.toLowerCase() === oldCode.toLowerCase()) {
      const sudar = await db.maintAsset.findFirst({
        where: {
          assetId: { not: stara.assetId },
          assetType: "machine",
          assetCode: { equals: newCode, mode: "insensitive" },
        },
        select: { assetId: true },
      });
      if (sudar) {
        throw new UnprocessableEntityException(
          `maint_machine_rename: šifru sredstva "${newCode}" već koristi drugo sredstvo — očisti maint_assets pa ponovi`,
        );
      }
      await db.maintAsset.update({
        where: { assetId: stara.assetId },
        data: { assetCode: newCode, updatedBy: scope.userId },
      });
      assetRenamed = true;
    }

    // 4) Brisanje starog reda.
    await db.maintMachine.delete({ where: { machineCode: oldCode } });

    return {
      old_code: oldCode,
      new_code: newCode,
      tasks: tasks.count,
      checks: checks.count,
      incidents: incidents.count,
      notes: notes.count,
      overrides: overrides.count,
      notifications: notif.count,
      files: files.count,
      asset_id: stara.assetId,
      asset_code_renamed: assetRenamed,
    };
  }

  /**
   * `maint_machine_delete_hard(code, reason)` — trajno brisanje mašine.
   *
   * 🔴 Trag brisanja (`maint_machines_deletion_log`) se upisuje PRE brisanja i
   * nosi CEO red mašine (`to_jsonb(v_row)`) plus brojače dece. To je jedini
   * zapis koji o mašini ostaje — RLS na toj tabeli zabranjuje bilo kakav upis
   * (`false`), pa ga sme napraviti SAMO ova funkcija.
   */
  async machineDeleteHard(
    tx: OdrzavanjeTx | undefined,
    scope: MaintScope,
    email: string,
    code: string,
    reason: string,
  ): Promise<Record<string, unknown>> {
    const db = this.db(tx);
    const kod = (code ?? "").trim();
    const razlog = (reason ?? "").trim();
    // Gejt je ŠIRI od `machineRename` — uključuje `erp_admin_or_management`.
    // Izraz živi u `canDeleteMachineHard` jer ga traži i BE korak 1 (brisanje
    // bajtova iz skladišta) — jedan izvor, da se dva prepisa ne raziđu.
    if (!this.authz.canDeleteMachineHard(scope)) {
      throw new ForbiddenException("maint_machine_delete_hard: not authorized");
    }
    if (kod === "") {
      throw new UnprocessableEntityException(
        "maint_machine_delete_hard: machine_code je obavezan",
      );
    }
    if (razlog.length < 5) {
      throw new UnprocessableEntityException(
        "maint_machine_delete_hard: razlog je obavezan (min 5 karaktera)",
      );
    }
    const row = await db.maintMachine.findUnique({ where: { machineCode: kod } });
    if (!row) {
      throw new NotFoundException(
        `maint_machine_delete_hard: masina ${kod} ne postoji u katalogu`,
      );
    }

    const [tasks, checks, incidents, notes, files, override] = await Promise.all([
      db.maintTask.count({ where: { machineCode: kod } }),
      db.maintCheck.count({ where: { machineCode: kod } }),
      db.maintIncident.count({ where: { machineCode: kod } }),
      db.maintMachineNote.count({ where: { machineCode: kod } }),
      // ⚠️ Jedini brojač koji gleda `deleted_at IS NULL` — prepis, ne previd.
      db.maintMachineFile.count({ where: { machineCode: kod, deletedAt: null } }),
      db.maintMachineStatusOverride.count({ where: { machineCode: kod } }),
    ]);
    const counts = { tasks, checks, incidents, notes, files, override };

    await db.maintMachineDeletionLog.create({
      data: {
        machineCode: kod,
        machineName: row.name,
        snapshot: JSON.parse(
          JSON.stringify(row, (_k, v) =>
            typeof v === "bigint" ? v.toString() : v,
          ),
        ) as Prisma.InputJsonValue,
        relatedCounts: counts as unknown as Prisma.InputJsonValue,
        reason: razlog,
        deletedBy: scope.userId,
        deletedByEmail: email ?? "",
      },
    });

    // Redosled brisanja je prepis: prvo tragovi kvarova, pa kvarovi, pa ostalo.
    const incIds = await db.maintIncident.findMany({
      where: { machineCode: kod },
      select: { id: true },
    });
    if (incIds.length > 0) {
      await db.maintIncidentEvent.deleteMany({
        where: { incidentId: { in: incIds.map((i) => i.id) } },
      });
    }
    await db.maintIncident.deleteMany({ where: { machineCode: kod } });
    await db.maintCheck.deleteMany({ where: { machineCode: kod } });
    await db.maintTask.deleteMany({ where: { machineCode: kod } });
    await db.maintMachineNote.deleteMany({ where: { machineCode: kod } });
    await db.maintMachineFile.deleteMany({ where: { machineCode: kod } });
    await db.maintMachineStatusOverride.deleteMany({
      where: { machineCode: kod },
    });
    await db.maintMachine.delete({ where: { machineCode: kod } });

    return {
      ok: true,
      machine_code: kod,
      machine_name: row.name,
      related: counts,
      deleted_at: new Date(),
    };
  }

  /**
   * `maint_machines_import_from_cache(codes[])` — uvoz mašina iz BigTehn kataloga.
   *
   * 🔴 NIJE PREPISANA, i to je merenje a ne propust: izvor čita
   * `public.bigtehn_machines_cache` (90 redova), tabelu koja **nije `maint_*`** i
   * koju 3.0 baza NEMA (blokada 9 runbook-a — stiže sa svojim domenom). Prepis
   * bi tražio da se taj katalog preseli usput, van obima ovog koraka.
   * Zato ova putanja pod `3.0` GLASNO pada, umesto da tiho uveze nula mašina.
   */
  importFromCacheNijePreneto(): never {
    throw new UnprocessableEntityException(
      "Uvoz mašina iz BigTehn kataloga još nije prenet na 3.0: tabela " +
        "`bigtehn_machines_cache` je u sy15 i seli se sa svojim domenom " +
        "(v. docs/SEOBA_ODRZAVANJA_2026-08-06.md, blokada 9). Do tada uvoz radi " +
        "samo sa ODRZAVANJE_IZVOR=sy15.",
    );
  }

  // =========================================================================
  // DEFINER FUNKCIJE — nalozi, incidenti, obaveštenja
  // =========================================================================

  /**
   * `maint_create_preventive_work_order(task_id)` — nalog iz preventivnog zadatka.
   *
   * 🔴 IDEMPOTENCIJA JE U SAMOJ FUNKCIJI: ako za zadatak već postoji nalog koji
   * NIJE `otkazan`, vraća se POSTOJEĆI `wo_id` i ne pravi se novi. Prepis bez
   * te provere pravio bi nov nalog na svaki klik.
   */
  async createPreventiveWorkOrder(
    tx: OdrzavanjeTx | undefined,
    scope: MaintScope,
    taskId: string,
  ): Promise<string> {
    const db = this.db(tx);
    if (
      !this.authz.isErpAdminOrManagement(scope) &&
      scope.profileRole !== "technician" &&
      scope.profileRole !== "chief" &&
      scope.profileRole !== "admin"
    ) {
      throw new ForbiddenException(
        "maint_create_preventive_work_order: not authorized",
      );
    }
    const task = await db.maintTask.findFirst({
      where: { id: taskId, active: true },
    });
    if (!task) throw new NotFoundException("Preventive task not found");

    let asset: { assetId: string; assetType: string } | null = null;
    if (task.assetId != null) {
      asset = await db.maintAsset.findUnique({
        where: { assetId: task.assetId },
        select: { assetId: true, assetType: true },
      });
    } else {
      const m = await db.maintMachine.findFirst({
        where: { machineCode: task.machineCode },
        select: { assetId: true },
      });
      asset = m ? { assetId: m.assetId, assetType: "machine" } : null;
    }
    if (!asset) {
      throw new UnprocessableEntityException("Preventive task has no CMMS asset");
    }

    const postojeci = await db.maintWorkOrder.findFirst({
      where: { sourcePreventiveTaskId: taskId, status: { not: "otkazan" } },
      orderBy: { createdAt: "desc" },
      select: { woId: true },
    });
    if (postojeci) return postojeci.woId;

    const s = await this.settings(tx);
    const wo = await db.maintWorkOrder.create({
      data: {
        type: "preventive",
        assetId: asset.assetId,
        assetType: asset.assetType,
        sourcePreventiveTaskId: taskId,
        title: `Preventiva: ${task.title}`,
        description: task.instructions,
        priority: s.defaultWoPriority ?? "p4_planirano",
        status: "novi",
        reportedBy: scope.userId,
        safetyMarker: false,
        dueAt: new Date(
          Date.now() + (s.preventiveDueWarningDays ?? 7) * 86_400_000,
        ),
      },
      select: { woId: true },
    });
    await db.maintWoEvent.create({
      data: {
        woId: wo.woId,
        actor: scope.userId,
        eventType: "preventive_auto_wo",
        comment: "Radni nalog kreiran iz preventivnog roka.",
      },
    });
    return wo.woId;
  }

  /**
   * `maint_attach_incident_files(incident_id, urls[])` — prilozi uz prijavu kvara.
   *
   * 🔴 NAJSKRIVENIJE PRAVILO MODULA: funkcija nema role-gate, nego JEDINO
   * `WHERE i.reported_by = auth.uid()`. Dakle fajlove kači SAMO prijavilac —
   * ni šef, ni admin. Vraća `false` (ne grešku) kad red ne odgovara.
   */
  async attachIncidentFiles(
    tx: OdrzavanjeTx | undefined,
    scope: MaintScope,
    incidentId: string | null,
    urls: string[] | null,
  ): Promise<boolean> {
    if (incidentId == null || urls == null || urls.length === 0) return false;
    const db = this.db(tx);
    const inc = await db.maintIncident.findFirst({
      where: { id: incidentId, reportedBy: scope.userId },
      select: { id: true, attachmentUrls: true },
    });
    if (!inc) return false;
    // `array_agg(distinct u)` nad `coalesce(stari,'{}') || novi`.
    const spojeno = Array.from(
      new Set([...(inc.attachmentUrls ?? []), ...urls]),
    );
    await db.maintIncident.update({
      where: { id: incidentId },
      data: { attachmentUrls: spojeno, updatedAt: new Date() },
    });
    return true;
  }

  /**
   * `maint_notification_retry(id)` — ponovi slanje reda iz outbox-a.
   * ⚠️ `LEAST(attempts, 7)` je namerno: red koji je udario plafon (8) spušta se
   * na 7 da bi ga `maint_dispatch_dequeue` (`attempts < p_max_attempts`) opet uzeo.
   */
  async notificationRetry(
    tx: OdrzavanjeTx | undefined,
    scope: MaintScope,
    id: string,
  ): Promise<boolean> {
    if (
      !this.authz.isErpAdmin(scope) &&
      scope.profileRole !== "chief" &&
      scope.profileRole !== "admin"
    ) {
      throw new ForbiddenException("maint_notification_retry: not authorized");
    }
    const db = this.db(tx);
    const red = await db.maintNotificationLog.findUnique({
      where: { id },
      select: { attempts: true },
    });
    if (!red) return false;
    await db.maintNotificationLog.update({
      where: { id },
      data: {
        status: "queued",
        error: null,
        nextAttemptAt: new Date(),
        attempts: Math.min(red.attempts, 7),
      },
    });
    return true;
  }

  /**
   * `maint_assignable_users()` — spisak kome se sme dodeliti nalog.
   * ⚠️ `management` NIJE u spisku (rukovodstvo ne izvršava naloge) — prepis.
   */
  async assignableUsers(
    tx?: OdrzavanjeTx,
  ): Promise<{ user_id: number; full_name: string; maint_role: string }[]> {
    const rows = await this.db(tx).maintUserProfile.findMany({
      where: {
        active: true,
        role: { in: ["operator", "technician", "chief", "admin"] },
      },
      orderBy: { fullName: "asc" },
      select: { userId: true, fullName: true, role: true },
    });
    return rows.map((r) => ({
      user_id: r.userId,
      full_name: r.fullName,
      maint_role: r.role,
    }));
  }

  /**
   * `maint_dispatch_fanout(parent_id)` — razgranavanje outbox reda na primaoce.
   *
   * Roditeljski red nema primaoca (`recipient = 'pending'`); ova funkcija pravi
   * po jedno DETE za svakog `maint_user_profiles` sa telefonom i odgovarajućom
   * rolom, pa roditelja obeleži kao `sent` sa `FANOUT_DONE: N recipients`.
   *
   * 🔴 Kod `critical` ciljaju se `chief` I `management`, inače samo `chief`.
   * ⚠️ Poznat defekt 1.0 koji se prenosi kakav jeste: dete kanala `email` u
   * `recipient` dobija TELEFON (izvor kopira `p.phone` bez obzira na kanal).
   *
   * ── 🔴 JEDINO SVESNO ODSTUPANJE OD IZVORA (08.08.2026) ──────────────────────
   * sy15 original zatvara roditelja kao `sent` I KAD NEMA NIJEDNOG PRIMAOCA
   * (`FANOUT_DONE: 0 recipients`). To znači da se GUBITAK obaveštenja u bazu
   * upisuje kao USPEH: poruka o kvaru ne ode nikome, a dnevnik kaže „poslato".
   *
   * Zašto to više nije akademsko: 08.08.2026 je IZMERENO da su 3.0 `maint_*`
   * tabele PRAZNE (`maint_user_profiles` = 0, prenos podataka još nije pušten).
   * Pod `ODRZAVANJE_IZVOR=3.0` bi, dakle, SVAKI fanout pogodio nula primalaca —
   * i svaki bi se zapisao kao uspešno poslat. Do ovog PR-a je jedini signal bila
   * brana koja je taj položaj prekidača obarala sa 503; kad brana pada, mora je
   * zameniti nešto što se i dalje VIDI.
   *
   * Zato: nula primalaca → `status='failed'` sa `FANOUT_NO_RECIPIENTS` u `error`
   * (statusi ostaju u postojećem CHECK-u `('queued','sent','failed')`, pa nema
   * migracije), plus ERROR u dnevnik. Roditelj se i dalje NE ZAGLAVLJUJE večno:
   * `dispatchDequeue` uzima `status IN ('queued','failed')` samo dok je
   * `attempts < p_max_attempts` (radnik šalje 8), a svaki claim diže `attempts`.
   * Posle 8 prolaza red trajno ispada iz reda čekanja i ostaje kao VIDLJIV
   * neuspeh. Usput to daje i besplatnu korist: ako se prenos podataka pusti
   * unutar prozora ponovnih pokušaja, obaveštenje stvarno ode.
   */
  async dispatchFanout(
    tx: OdrzavanjeTx | undefined,
    parentId: string,
  ): Promise<number> {
    const db = this.db(tx);
    const parent = await db.maintNotificationLog.findUnique({
      where: { id: parentId },
    });
    if (!parent) return 0;
    const payload = (parent.payload ?? {}) as Record<string, unknown>;
    const role =
      payload["severity"] === "critical" ? ["chief", "management"] : ["chief"];
    const targets = await db.maintUserProfile.findMany({
      where: {
        active: true,
        role: { in: role },
        phone: { not: null },
        NOT: { phone: "" },
      },
      select: { userId: true, fullName: true, phone: true },
    });
    if (targets.length === 0) {
      // 🔴 NULA PRIMALACA NIJE USPEH — v. odstupanje u zaglavlju metode.
      const razlog =
        `FANOUT_NO_RECIPIENTS: nijedan aktivan profil (${role.join("/")}) ` +
        "sa telefonom u maint_user_profiles";
      this.log.error(
        `maint fanout ${parentId}: ${razlog} — obaveštenje NIJE otišlo nikome; ` +
          `red ostaje 'failed' (ponovni pokušaj, pa trajno vidljiv neuspeh).`,
      );
      await this.markFailedRaw(
        db,
        parentId,
        razlog,
        FANOUT_NO_RECIPIENTS_BACKOFF_SEC,
      );
      return 0;
    }
    await db.maintNotificationLog.createMany({
      data: targets.map((t) => ({
        channel: parent.channel,
        recipient: t.phone as string,
        recipientUserId: t.userId,
        subject: parent.subject,
        body: parent.body,
        relatedEntityType: parent.relatedEntityType,
        relatedEntityId: parent.relatedEntityId,
        machineCode: parent.machineCode,
        escalationLevel: parent.escalationLevel,
        status: "queued",
        payload: {
          ...payload,
          fanout_parent: parent.id,
          to_name: t.fullName,
        } as Prisma.InputJsonValue,
      })),
    });
    // Deca su upisana — TEK SADA roditelj sme da bude `sent`. Ovaj `update` više
    // NE pokriva slučaj „nula primalaca": on je iznad, i završava kao `failed`.
    await db.maintNotificationLog.update({
      where: { id: parentId },
      data: {
        status: "sent",
        sentAt: new Date(),
        error: `FANOUT_DONE: ${targets.length} recipients`,
      },
    });
    return targets.length;
  }

  // =========================================================================
  // DEFINER FUNKCIJE — planovi servisa (auto-nalozi)
  // =========================================================================

  /**
   * `ensure_vehicle_service_wos(asset_id?)` — auto-nalozi iz Plana servisa vozila.
   * Uzima redove `v_maint_vehicle_service_plan_due` koji su `overdue`/`due_soon`,
   * nemaju otvoren nalog i sredstvo im nije arhivirano.
   */
  async ensureVehicleServiceWos(
    tx: OdrzavanjeTx | undefined,
    scope: MaintScope,
    assetId?: string | null,
  ): Promise<number> {
    this.assertMozeAutoWo(scope, "Nemaš ovlašćenje za generisanje WO iz plana servisa");
    const db = this.db(tx);
    const rows = await db.$queryRaw<
      {
        plan_id: string;
        asset_id: string;
        name: string;
        notes: string | null;
        priority: string;
        next_due_at: Date | null;
        next_due_km: number | null;
      }[]
    >(Prisma.sql`
      SELECT pl.plan_id, pl.asset_id, pl.name, pl.notes, pl.priority,
             pl.next_due_at, pl.next_due_km
        FROM v_maint_vehicle_service_plan_due pl
        JOIN maint_assets a ON a.asset_id = pl.asset_id
       WHERE pl.active = TRUE
         AND pl.due_status IN ('overdue', 'due_soon')
         AND pl.has_open_wo = FALSE
         AND a.archived_at IS NULL
         AND (${assetId ?? null}::uuid IS NULL OR pl.asset_id = ${assetId ?? null}::uuid)`);

    for (const r of rows) {
      await db.maintWorkOrder.create({
        data: {
          type: "servis",
          assetId: r.asset_id,
          assetType: "vehicle",
          title: r.name,
          description:
            "Auto-generisan iz Plana servisa." +
            (r.next_due_at ? `\nRok: ${srpskiDatum(r.next_due_at)}` : "") +
            (r.next_due_km != null ? `\nPrag km: ${r.next_due_km}` : "") +
            (r.notes && r.notes.trim().length > 0 ? `\n\n${r.notes}` : ""),
          priority: r.priority,
          status: "novi",
          reportedBy: scope.userId,
          dueAt: r.next_due_at ?? null,
          servicePlanId: r.plan_id,
          triggerOdometerKm: r.next_due_km,
        },
      });
    }
    return rows.length;
  }

  /**
   * `ensure_asset_service_wos(asset_id?)` — auto-nalozi iz plana održavanja
   * sredstva. ⚠️ Tip naloga je `inspekcija` za objekte, `preventiva` za ostalo.
   */
  async ensureAssetServiceWos(
    tx: OdrzavanjeTx | undefined,
    scope: MaintScope,
    assetId?: string | null,
  ): Promise<number> {
    this.assertMozeAutoWo(scope, "Nemaš ovlašćenje za generisanje WO iz plana");
    const db = this.db(tx);
    const rows = await db.$queryRaw<
      {
        plan_id: string;
        asset_id: string;
        asset_type: string;
        name: string;
        interval_months: number;
        priority: string;
        next_due_at: Date | null;
      }[]
    >(Prisma.sql`
      SELECT v.plan_id, v.asset_id, v.asset_type, v.name, v.interval_months,
             v.priority, v.next_due_at
        FROM v_maint_asset_service_plan_due v
        JOIN maint_assets a ON a.asset_id = v.asset_id
       WHERE v.active
         AND v.due_status IN ('overdue', 'due_soon')
         AND v.has_open_wo = FALSE
         AND a.archived_at IS NULL
         AND (${assetId ?? null}::uuid IS NULL OR v.asset_id = ${assetId ?? null}::uuid)`);

    for (const r of rows) {
      await db.maintWorkOrder.create({
        data: {
          type: r.asset_type === "facility" ? "inspekcija" : "preventiva",
          assetId: r.asset_id,
          assetType: r.asset_type,
          title: r.name,
          description: `Auto-generisan iz plana održavanja (${r.interval_months} mes).`,
          priority: r.priority,
          status: "novi",
          reportedBy: scope.userId,
          dueAt: r.next_due_at ?? null,
          assetServicePlanId: r.plan_id,
        },
      });
    }
    return rows.length;
  }

  /** Zajednički gejt oba `ensure_*_service_wos` (isti izraz u oba izvora). */
  private assertMozeAutoWo(scope: MaintScope, poruka: string): void {
    if (
      !this.authz.isErpAdminOrManagement(scope) &&
      scope.profileRole !== "chief" &&
      scope.profileRole !== "admin" &&
      scope.profileRole !== "technician"
    ) {
      throw new ForbiddenException(poruka);
    }
  }

  // =========================================================================
  // DEFINER FUNKCIJE — rokovi (posao `maint-deadlines`)
  // =========================================================================

  /**
   * `maint_check_all_deadlines(lookahead_days)` — pogon posla `maint-deadlines`.
   * Vraća po red za svaki izvor, kao `RETURN QUERY` u izvoru.
   */
  async checkAllDeadlines(
    tx: OdrzavanjeTx | undefined,
    lookaheadDays = 30,
  ): Promise<{ source: string; enqueued: number; skipped: number }[]> {
    const v = await this.checkVehicleDeadlines(tx, lookaheadDays);
    const itf = await this.checkItFacilityDeadlines(tx, lookaheadDays);
    return [
      { source: "vehicle", ...v },
      { source: "it_facility", ...itf },
    ];
  }

  /**
   * `maint_check_vehicle_deadlines(lookahead_days)` — najveća funkcija domena
   * (9.595 znakova, tri petlje). Redom: vozila (registracija / osiguranje /
   * prva pomoć), vozači (vozačka / lekarski / lična karta), dokumenta
   * (`valid_until`).
   *
   * 🔴 IDEMPOTENCIJA JE PO TROJCI (entitet, `deadline_kind`, `deadline_date`) u
   * `payload`-u, uz `status IN ('queued','sent')`. Bez nje bi posao svakog dana
   * ponovo slao isto obaveštenje. `skipped` broji baš te preskočene.
   *
   * ⚠️ Servis vozila (`service_due_at`) se u izvoru ČITA ali se za njega NE
   * upisuje obaveštenje — prazna grana, prenosi se kakva jeste.
   */
  async checkVehicleDeadlines(
    tx: OdrzavanjeTx | undefined,
    lookaheadDays = 30,
  ): Promise<DeadlineResult> {
    const db = this.db(tx);
    const granica = new Date();
    granica.setDate(granica.getDate() + lookaheadDays);
    let enq = 0;
    let skip = 0;

    const posalji = async (
      entityType: string,
      entityId: string,
      kind: string,
      date: Date,
      subject: string,
      body: string,
      extra: Record<string, unknown> = {},
    ) => {
      const postoji = await this.postojiRok(tx, entityType, entityId, kind, date);
      if (postoji) {
        skip += 1;
        return;
      }
      await this.enqueueNotification(tx, {
        channel: "email",
        recipient: "pending",
        recipientUserId: null,
        subject,
        body,
        relatedEntityType: entityType,
        relatedEntityId: entityId,
        machineCode: null,
        escalationLevel: 0,
        payload: {
          deadline_kind: kind,
          deadline_date: isoDan(date),
          ...extra,
        } as Prisma.InputJsonValue,
      });
      enq += 1;
    };

    // ── 1. Vozila ────────────────────────────────────────────────────────
    const vozila = await db.maintVehicleDetails.findMany({
      where: { asset: { assetType: "vehicle", archivedAt: null } },
      select: {
        assetId: true,
        registrationPlate: true,
        registrationExpiresAt: true,
        insuranceExpiresAt: true,
        firstAidKitExpiresAt: true,
        asset: { select: { assetCode: true, name: true } },
      },
    });
    for (const v of vozila) {
      const ime = v.asset.name ?? v.asset.assetCode;
      const tablice = v.registrationPlate ?? v.asset.assetCode;
      if (v.registrationExpiresAt && v.registrationExpiresAt <= granica) {
        await posalji(
          "asset",
          v.assetId,
          "registration",
          v.registrationExpiresAt,
          `Registracija ističe: ${ime}`,
          `Registracija za vozilo ${ime} (${tablice}) ističe ${srpskiDatum(v.registrationExpiresAt)}`,
          { asset_code: v.asset.assetCode },
        );
      }
      if (v.insuranceExpiresAt && v.insuranceExpiresAt <= granica) {
        await posalji(
          "asset",
          v.assetId,
          "insurance",
          v.insuranceExpiresAt,
          `Osiguranje ističe: ${ime}`,
          `Polisa osiguranja za ${ime} (${tablice}) ističe ${srpskiDatum(v.insuranceExpiresAt)}`,
          { asset_code: v.asset.assetCode },
        );
      }
      if (v.firstAidKitExpiresAt && v.firstAidKitExpiresAt <= granica) {
        await posalji(
          "asset",
          v.assetId,
          "first_aid",
          v.firstAidKitExpiresAt,
          `Prva pomoć ističe: ${ime}`,
          `Komplet prve pomoći u ${ime} (${tablice}) ističe ${srpskiDatum(v.firstAidKitExpiresAt)}`,
          { asset_code: v.asset.assetCode },
        );
      }
    }

    // ── 2. Vozači ────────────────────────────────────────────────────────
    const vozaci = await db.maintDriver.findMany({
      where: { archivedAt: null, active: true },
      select: {
        driverId: true,
        fullName: true,
        driversLicenseValidUntil: true,
        medicalCheckValidUntil: true,
        idCardValidUntil: true,
      },
    });
    for (const d of vozaci) {
      if (d.driversLicenseValidUntil && d.driversLicenseValidUntil <= granica) {
        await posalji(
          "driver",
          d.driverId,
          "drivers_license",
          d.driversLicenseValidUntil,
          `Vozačka ističe: ${d.fullName}`,
          `Vozačka dozvola za ${d.fullName} ističe ${srpskiDatum(d.driversLicenseValidUntil)}`,
        );
      }
      if (d.medicalCheckValidUntil && d.medicalCheckValidUntil <= granica) {
        await posalji(
          "driver",
          d.driverId,
          "medical",
          d.medicalCheckValidUntil,
          `Lekarski ističe: ${d.fullName}`,
          `Lekarski uput za ${d.fullName} ističe ${srpskiDatum(d.medicalCheckValidUntil)}`,
        );
      }
      if (d.idCardValidUntil && d.idCardValidUntil <= granica) {
        await posalji(
          "driver",
          d.driverId,
          "id_card",
          d.idCardValidUntil,
          `Lična karta ističe: ${d.fullName}`,
          `Lična karta za ${d.fullName} ističe ${srpskiDatum(d.idCardValidUntil)}`,
        );
      }
    }

    // ── 3. Dokumenta sa `valid_until` ────────────────────────────────────
    const dokumenta = await db.maintDocument.findMany({
      where: { deletedAt: null, validUntil: { not: null, lte: granica } },
      select: {
        documentId: true,
        entityType: true,
        fileName: true,
        category: true,
        validUntil: true,
      },
    });
    for (const doc of dokumenta) {
      if (!doc.validUntil) continue;
      await posalji(
        "document",
        doc.documentId,
        "document_validity",
        doc.validUntil,
        `Dokument ističe: ${doc.category ?? doc.fileName}`,
        `Dokument „${doc.fileName}"${doc.category ? ` (${doc.category})` : ""} ističe ${srpskiDatum(doc.validUntil)}`,
        { doc_entity_type: doc.entityType, doc_category: doc.category },
      );
    }

    return { enqueued: enq, skipped: skip };
  }

  /**
   * `maint_check_it_facility_deadlines(lookahead_days)` — IT licence/garancije/
   * backup + inspekcija i PP rok objekata. Čita `v_maint_it_overview` i
   * `v_maint_facility_overview` (oba su `security_invoker` u sy15, ali ovaj posao
   * ide iz schedulera bez korisnika — nema scope-a, kao ni u izvoru).
   *
   * ⚠️ `it_backup` ima DRUGAČIJU idempotenciju od ostalih: ključ je
   * (`backup_status`, poslednjih 7 dana), ne datum roka — jer backup nema rok.
   */
  async checkItFacilityDeadlines(
    tx: OdrzavanjeTx | undefined,
    lookaheadDays = 30,
  ): Promise<DeadlineResult> {
    const db = this.db(tx);
    const granica = new Date();
    granica.setDate(granica.getDate() + lookaheadDays);
    let enq = 0;
    let skip = 0;

    const posaljiRok = async (
      assetId: string,
      assetCode: string,
      kind: string,
      date: Date,
      subject: string,
      body: string,
    ) => {
      if (await this.postojiRok(tx, "asset", assetId, kind, date)) {
        skip += 1;
        return;
      }
      await this.enqueueNotification(tx, {
        channel: "email",
        recipient: "pending",
        subject,
        body,
        relatedEntityType: "asset",
        relatedEntityId: assetId,
        escalationLevel: 0,
        payload: {
          deadline_kind: kind,
          deadline_date: isoDan(date),
          asset_code: assetCode,
        } as Prisma.InputJsonValue,
      });
      enq += 1;
    };

    const it = await db.$queryRaw<
      {
        asset_id: string;
        asset_code: string;
        name: string;
        license_expires_at: Date | null;
        warranty_expires_at: Date | null;
        backup_status: string;
      }[]
    >(Prisma.sql`
      SELECT asset_id, asset_code, name, license_expires_at, warranty_expires_at,
             backup_status
        FROM v_maint_it_overview
       WHERE archived_at IS NULL`);

    for (const r of it) {
      const ime = r.name ?? r.asset_code;
      if (r.license_expires_at && r.license_expires_at <= granica) {
        await posaljiRok(
          r.asset_id,
          r.asset_code,
          "it_license",
          r.license_expires_at,
          `IT licenca ističe: ${ime}`,
          `Licenca za ${ime} ističe ${srpskiDatum(r.license_expires_at)}`,
        );
      }
      if (r.warranty_expires_at && r.warranty_expires_at <= granica) {
        await posaljiRok(
          r.asset_id,
          r.asset_code,
          "it_warranty",
          r.warranty_expires_at,
          `IT garancija ističe: ${ime}`,
          `Garancija za ${ime} ističe ${srpskiDatum(r.warranty_expires_at)}`,
        );
      }
      if (r.backup_status === "missing" || r.backup_status === "stale") {
        const nedeljaUnazad = new Date(Date.now() - 7 * 86_400_000);
        const postoji = await db.maintNotificationLog.findFirst({
          where: {
            relatedEntityType: "asset",
            relatedEntityId: r.asset_id,
            status: { in: ["queued", "sent"] },
            createdAt: { gte: nedeljaUnazad },
            AND: [
              { payload: { path: ["deadline_kind"], equals: "it_backup" } },
              {
                payload: {
                  path: ["backup_status"],
                  equals: r.backup_status,
                },
              },
            ],
          },
          select: { id: true },
        });
        if (postoji) {
          skip += 1;
        } else {
          await this.enqueueNotification(tx, {
            channel: "email",
            recipient: "pending",
            subject: `IT backup pažnja: ${ime}`,
            body: `Backup status za ${ime}: ${r.backup_status}`,
            relatedEntityType: "asset",
            relatedEntityId: r.asset_id,
            escalationLevel: 0,
            payload: {
              deadline_kind: "it_backup",
              backup_status: r.backup_status,
              asset_code: r.asset_code,
            } as Prisma.InputJsonValue,
          });
          enq += 1;
        }
      }
    }

    const objekti = await db.$queryRaw<
      {
        asset_id: string;
        asset_code: string;
        name: string;
        inspection_due_at: Date | null;
        fire_safety_due_at: Date | null;
      }[]
    >(Prisma.sql`
      SELECT asset_id, asset_code, name, inspection_due_at, fire_safety_due_at
        FROM v_maint_facility_overview
       WHERE archived_at IS NULL`);

    for (const r of objekti) {
      const ime = r.name ?? r.asset_code;
      if (r.inspection_due_at && r.inspection_due_at <= granica) {
        await posaljiRok(
          r.asset_id,
          r.asset_code,
          "facility_inspection",
          r.inspection_due_at,
          `Inspekcija objekta: ${ime}`,
          `Inspekcija za ${ime} dospeva ${srpskiDatum(r.inspection_due_at)}`,
        );
      }
      if (r.fire_safety_due_at && r.fire_safety_due_at <= granica) {
        await posaljiRok(
          r.asset_id,
          r.asset_code,
          "facility_fire_safety",
          r.fire_safety_due_at,
          `PP rok objekta: ${ime}`,
          `PP zaštita za ${ime} dospeva ${srpskiDatum(r.fire_safety_due_at)}`,
        );
      }
    }

    return { enqueued: enq, skipped: skip };
  }

  // =========================================================================
  // 🔴 ŠAV KA AI-ASISTENTU — `ai_chat_prijavi_kvar` nad 3.0 bazom
  // =========================================================================

  /**
   * Prepis `ai_chat_prijavi_kvar(masina, naslov, opis, ozbiljnost, rizik)`.
   *
   * ZAŠTO OVDE, A NE U `ai-chat`: ovo je JEDINI upis AI-asistenta u tuđi domen
   * (`INSERT INTO maint_incidents`). Da je ostao u sy15 dok modul piše u 3.0,
   * nastale bi DVE ISTINE O KVAROVIMA — i to se ne bi videlo dok se brojevi ne
   * raziđu. Držanjem prepisa u domenu obezbeđeno je i da prijava kroz asistenta
   * prođe kroz ISTE trigere kao prijava kroz ekran (denormalizacija sredstva,
   * revizioni trag, auto-nalog, obaveštenja).
   *
   * Ugovor prema alatu je NEPROMENJEN: isti ključevi u odgovoru (`ok`,
   * `incident_id`, `sredstvo`, `tip_sredstva`, `masina`, `radni_nalog`,
   * `poruka`) i isti kodovi grešaka (`prazno`, `nema_sredstva`, `greska`).
   *
   * ⚠️ `nema_prava` se pod `3.0` NE MOŽE desiti i to je tačno: u sy15 ga je
   * proizvodio RLS (`insufficient_privilege`), a `maint_incidents_insert`
   * politika ima JEDINI uslov `reported_by = uid()` — koji je ovde zadovoljen
   * po konstrukciji. Prijava kvara je namerno otvorena celoj firmi.
   */
  async aiPrijaviKvar(
    reporterUserId: number,
    a: {
      masina: string;
      naslov: string;
      opis?: string | null;
      ozbiljnost?: string | null;
      bezbednosniRizik?: boolean;
    },
  ): Promise<Record<string, unknown>> {
    const naslov = (a.naslov ?? "").trim();
    if (naslov === "") {
      return {
        error: "prazno",
        poruka: "Naslov (kratak opis kvara) je obavezan.",
      };
    }
    const db = this.db();

    // 1) MAŠINA — isti redosled kao izvor (prvo katalog mašina).
    const pojam = (a.masina ?? "").trim();
    let sifra: string | null = null;
    let assetId: string | null = null;
    let assetType: string | null = null;
    let naziv: string | null = null;

    const masina = await this.resolveMasinu(pojam);
    if (masina) {
      sifra = masina.machineCode;
      assetId = masina.assetId;
      naziv = masina.name;
      assetType = "machine";
    } else {
      // 2) Bilo koje sredstvo — vozilo (i po tablicama), IT oprema, objekat.
      const sredstvo = await this.resolveSredstvo(pojam);
      if (sredstvo) {
        sifra = sredstvo.assetCode;
        assetId = sredstvo.assetId;
        assetType = sredstvo.assetType;
        naziv = sredstvo.name;
      }
    }
    if (sifra == null) {
      return {
        error: "nema_sredstva",
        poruka: `Sredstvo „${pojam}" nije nađeno — proveri šifru, naziv ili registarsku oznaku.`,
      };
    }

    // Nevalidna ozbiljnost pada na `minor` — u sy15 to radi neuspeo cast enuma.
    // ⚠️ Opis alata nudi i `normal`/`important`, kojih u skupu NEMA: oni su i u
    // sy15 tiho postajali `minor`. Prenosi se kakvo jeste.
    const sev = (a.ozbiljnost ?? "minor").trim().toLowerCase();
    const severity =
      sev === "major" || sev === "critical" || sev === "minor" ? sev : "minor";
    const safety = a.bezbednosniRizik === true;

    try {
      const id = await this.prisma.$transaction(async (tx) => {
        // BEFORE trigger.
        const polja = await this.incidentSetAssetFields(tx, {
          machineCode: sifra,
          assetId,
        });
        const inc = await tx.maintIncident.create({
          data: {
            machineCode: polja.machineCode ?? (sifra as string),
            assetId: polja.assetId,
            // Izvor: `case when v_aid is null then null else v_atype end`.
            assetType: polja.assetId == null ? null : (polja.assetType ?? assetType),
            reportedBy: reporterUserId,
            title: naslov,
            description:
              (a.opis ?? "").trim().length > 0 ? (a.opis as string).trim() : null,
            severity,
            status: "open",
            safetyMarker: safety,
          },
        });
        // AFTER trigeri, istim redosledom kojim ih baza okida (po imenu):
        // audit -> autocreate_wo -> enqueue_notify.
        await this.incidentLogChanges(tx, {
          incidentId: inc.id,
          actor: reporterUserId,
          op: "INSERT",
          neu: { status: inc.status, assignedTo: inc.assignedTo },
        });
        await this.incidentAutocreateWorkOrder(tx, {
          id: inc.id,
          machineCode: inc.machineCode,
          assetId: inc.assetId,
          severity: inc.severity,
          safetyMarker: inc.safetyMarker,
          title: inc.title,
          description: inc.description,
          reportedBy: inc.reportedBy,
          assignedTo: inc.assignedTo,
          workOrderId: inc.workOrderId,
        });
        await this.incidentEnqueueNotify(tx, {
          id: inc.id,
          machineCode: inc.machineCode,
          assetId: inc.assetId,
          assetType: inc.assetType,
          severity: inc.severity,
          status: inc.status,
          title: inc.title,
          reportedBy: inc.reportedBy,
          assignedTo: inc.assignedTo,
        });
        return inc.id;
      });

      // Nalog kreira AFTER-trigger, pa se broj čita POSLE upisa (kao u izvoru).
      const posle = await db.maintIncident.findUnique({
        where: { id },
        select: { workOrderId: true },
      });
      let woNumber: string | null = null;
      if (posle?.workOrderId) {
        const wo = await db.maintWorkOrder.findUnique({
          where: { woId: posle.workOrderId },
          select: { woNumber: true },
        });
        woNumber = wo?.woNumber ?? null;
      }

      // Poruka imenuje TIP sredstva. ⚠️ Vrednosti su machine|vehicle|it|facility;
      // nepostojeći literal je 03.08.2026 oborio CELU funkciju (i za mašine).
      const labela =
        (assetType === "vehicle"
          ? "vozilo "
          : assetType === "it"
            ? "IT opremu "
            : assetType === "facility"
              ? "objekat "
              : "mašinu ") +
        sifra +
        (naziv ? ` (${naziv})` : "");

      const dodatak = woNumber
        ? ` Automatski je otvoren radni nalog ${woNumber}.`
        : severity === "major" || severity === "critical" || safety
          ? " Održavanje je obavešteno o hitnom kvaru."
          : "";

      return {
        ok: true,
        incident_id: id,
        sredstvo: sifra,
        tip_sredstva: assetType,
        // `masina` se ZADRŽAVA radi kompatibilnosti sa promptom i pozivaocima.
        masina: sifra,
        radni_nalog: woNumber,
        poruka: `Kvar je prijavljen za ${labela}.${dodatak}`,
      };
    } catch (e) {
      return {
        error: "greska",
        poruka: `Prijava nije sačuvana: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  /** `ai_chat_maint_resolve(pojam)` — mašina po šifri ili delu naziva. */
  private async resolveMasinu(
    pojam: string,
  ): Promise<{ machineCode: string; assetId: string; name: string } | null> {
    const rows = await this.prisma.$queryRaw<
      { machine_code: string; asset_id: string; name: string }[]
    >(Prisma.sql`
      SELECT m.machine_code, m.asset_id, m.name
        FROM maint_machines m
       WHERE m.archived_at IS NULL
         AND (m.machine_code = ${pojam}
              OR translate(lower(coalesce(m.name,'')), 'ćčšžđ', 'ccszd')
                 LIKE '%' || translate(lower(${pojam}), 'ćčšžđ', 'ccszd') || '%')
       ORDER BY (m.machine_code = ${pojam}) DESC, m.name
       LIMIT 1`);
    const r = rows[0];
    return r
      ? { machineCode: r.machine_code, assetId: r.asset_id, name: r.name }
      : null;
  }

  /**
   * `ai_chat_asset_resolve(pojam)` — bilo koje sredstvo; vozila i po TABLICAMA.
   * ⚠️ Poređenje tablica briše razmake sa obe strane („BG 2884 XA" = „bg2884xa").
   */
  private async resolveSredstvo(pojam: string): Promise<{
    assetCode: string;
    assetId: string;
    assetType: string;
    name: string;
  } | null> {
    const rows = await this.prisma.$queryRaw<
      { asset_code: string; asset_id: string; asset_type: string; name: string }[]
    >(Prisma.sql`
      SELECT a.asset_code, a.asset_id, a.asset_type, a.name
        FROM maint_assets a
        LEFT JOIN maint_vehicle_details vd ON vd.asset_id = a.asset_id
       WHERE a.archived_at IS NULL
         AND (a.asset_code = ${pojam}
              OR translate(lower(coalesce(a.name,'')), 'ćčšžđ', 'ccszd')
                 LIKE '%' || translate(lower(${pojam}), 'ćčšžđ', 'ccszd') || '%'
              OR (vd.registration_plate IS NOT NULL
                  AND replace(upper(vd.registration_plate), ' ', '')
                      = replace(upper(${pojam}), ' ', '')))
       ORDER BY (a.asset_code = ${pojam}) DESC,
                (vd.registration_plate IS NOT NULL
                 AND replace(upper(vd.registration_plate), ' ', '')
                     = replace(upper(${pojam}), ' ', '')) DESC,
                a.name
       LIMIT 1`);
    const r = rows[0];
    return r
      ? {
          assetCode: r.asset_code,
          assetId: r.asset_id,
          assetType: r.asset_type,
          name: r.name,
        }
      : null;
  }

  /** Provera „obaveštenje za ovaj rok već stoji u redu ili je poslato". */
  private async postojiRok(
    tx: OdrzavanjeTx | undefined,
    entityType: string,
    entityId: string,
    kind: string,
    date: Date,
  ): Promise<boolean> {
    const red = await this.db(tx).maintNotificationLog.findFirst({
      where: {
        relatedEntityType: entityType,
        relatedEntityId: entityId,
        status: { in: ["queued", "sent"] },
        AND: [
          { payload: { path: ["deadline_kind"], equals: kind } },
          { payload: { path: ["deadline_date"], equals: isoDan(date) } },
        ],
      },
      select: { id: true },
    });
    return red != null;
  }

  // =========================================================================
  // DEFINER FUNKCIJE — outbox radnik (posao `maint-notify-dispatch`)
  // =========================================================================
  //
  // Tri funkcije koje prazne `maint_notification_log`. Izvučene sa ŽIVE sy15
  // (`pg_get_functiondef`, 07.08.2026) i prepisane istim obrascem kao ostatak
  // ovog fajla (`tx` prvi argument; `auth.uid()` ovde ni nema — radnik nema
  // korisnika, kao ni u izvoru).
  //
  // 🔴 ZAŠTO IDU U ISTOM KORAKU KAO `maint-deadlines`: outbox-a su DVA. Pod
  // `ODRZAVANJE_IZVOR=3.0` novi red nastaje u 3.0 `maint_notification_log`, a
  // stari radnik prazni sy15. Ako se preklopi samo jedno od to dvoje,
  // obaveštenja o kvarovima TIHO prestanu da stižu — nema greške, red samo
  // stoji. Zato cron i radnik moraju preći ZAJEDNO.
  //
  // ⚠️⚠️ SISTEMSKI ULAZ BEZ IJEDNE PROVERE PRAVA ⚠️⚠️
  // `dispatchDequeue` / `dispatchMarkSent` / `dispatchMarkFailed` (i
  // `dispatchFanout` gore) NEMAJU `MaintScope` argument i NE ZOVU `authz` —
  // isto kao sy15 originali, koji su `SECURITY DEFINER` bez ijednog gejta, jer
  // ih pokreće cron BEZ korisnika. Zato:
  //
  //   🔴 NIJEDNA HTTP putanja (kontroler, resolver, RPC) NE SME da ih pozove.
  //      Pozivalac im je ISKLJUČIVO `src/modules/scheduler/**`. TypeScript to ne
  //      može da spreči (Nest injektuje ceo servis), pa branu drži test
  //      `odrzavanje-fn.dispatch-pozivaoci.spec.ts` — on skenira `src/` i pada
  //      ako se pojavi pozivalac van scheduler-a.
  //   🔴 Ko im ipak zatreba izvan radnika: NE zovi ih direktno, nego dodaj
  //      metodu sa `MaintScope` koja prvo prođe kroz `OdrzavanjeAuthzService`.

  /**
   * `maint_dispatch_dequeue(p_batch_size, p_max_attempts)` — claim redova.
   *
   * 🔴 Prepis je NAMERNO sirov SQL, ne Prisma upit: izvor u JEDNOM iskazu bira
   * (`FOR UPDATE SKIP LOCKED`) i diže `attempts`, pa dva radnika nikad ne uzmu
   * isti red. Rastavljeno na `findMany` + `updateMany` ta garancija nestaje.
   *
   * ⚠️ `RETURNING n.*` u PostgreSQL-u vraća NOVE vrednosti, pa je `attempts`
   * VEĆ uvećan — isto kao na sy15. Pozivalac koji računa backoff mora to znati
   * (radnik i dalje računa `attempts + 1`, tačan paritet 1.0 edge-a).
   *
   * ⚠️ Prozor slanja je VAN brave: claim vraća `status='queued'` i ne pomera
   * `next_attempt_at`, pa red odmah opet zadovoljava uslov dequeue-a. To je
   * zatečeno 1.0 ponašanje (v. zaglavlje `notify-dispatch.service.ts`) — zato
   * aktivacija mora biti ATOMSKI PREKLOP, nikad paralelan rad dva dispečera.
   */
  async dispatchDequeue(
    tx: OdrzavanjeTx | undefined,
    batchSize = 25,
    maxAttempts = 8,
  ): Promise<MaintDispatchRow[]> {
    return this.db(tx).$queryRaw<MaintDispatchRow[]>(Prisma.sql`
      WITH picked AS (
        SELECT id
          FROM maint_notification_log
         WHERE status IN ('queued', 'failed')
           AND next_attempt_at <= now()
           AND attempts < ${maxAttempts}::int
         ORDER BY next_attempt_at ASC, created_at ASC
         LIMIT ${batchSize}::int
         FOR UPDATE SKIP LOCKED
      )
      UPDATE maint_notification_log n
         SET attempts        = n.attempts + 1,
             last_attempt_at = now(),
             status          = 'queued'
        FROM picked p
       WHERE n.id = p.id
      RETURNING n.id, n.channel, n.recipient, n.recipient_user_id,
                n.subject, n.body, n.attempts`);
  }

  /**
   * `maint_dispatch_mark_sent(p_ids uuid[])` — vraća broj stvarno pogođenih
   * redova (izvor: `count(*)` nad CTE-om `RETURNING 1`).
   *
   * 🔴 Radnik ovo NE SME da pozove za STUB roditelja (`recipient='pending'` bez
   * `recipient_user_id`) — njega zatvara `dispatchFanout` sam, pošto raspiše
   * decu. Prevremeni `markSent` prekida fanout i deca se nikad ne pošalju.
   */
  async dispatchMarkSent(
    tx: OdrzavanjeTx | undefined,
    ids: string[],
  ): Promise<number> {
    if (ids.length === 0) return 0;
    const r = await this.db(tx).maintNotificationLog.updateMany({
      where: { id: { in: ids } },
      data: { status: "sent", sentAt: new Date(), error: null },
    });
    return r.count;
  }

  /**
   * `maint_dispatch_mark_failed(p_id, p_error, p_backoff_sec)` — re-arm reda.
   * Paritet izvora: `left(error, 1000)`, `greatest(backoff, 5)` sekundi, i
   * `UPDATE … WHERE id = p_id` (nepostojeći id je no-op, ne izuzetak).
   */
  async dispatchMarkFailed(
    tx: OdrzavanjeTx | undefined,
    id: string,
    error: string,
    backoffSec = 60,
  ): Promise<void> {
    const sek = Math.max(backoffSec, 5);
    await this.markFailedRaw(this.db(tx), id, error ?? "", sek);
  }

  /**
   * Zatvaranje outbox reda kao NEUSPEH sa pomerenim `next_attempt_at`.
   * Deli ga `dispatchMarkFailed` sa fanout-om bez primalaca.
   *
   * 🔴 SIROV SQL JE ZBOG SATA, ne zbog stila. Izvor računa
   * `now() + make_interval(secs => …)` — SAT BAZE. `new Date(Date.now() + …)` je
   * sat APLIKACIJE, a `dispatchDequeue` poredi `next_attempt_at <= now()` — opet
   * sat baze. Dok su kontejner i Postgres na istom hostu razlike nema; čim API
   * ode na drugi host, skew bi red vraćao prerano ili ga držao predugo. Vreme se
   * zato računa TAMO GDE SE I POREDI.
   *
   * ⚠️ `error` se seče u SQL-u (`left(…, 1000)`), doslovno kao u izvoru — ne u
   * JS-u, da granica ostane ista i za višebajtne znakove.
   */
  private async markFailedRaw(
    db: OdrzavanjeTx,
    id: string,
    error: string,
    sek: number,
  ): Promise<void> {
    await db.$executeRaw(Prisma.sql`
      UPDATE maint_notification_log
         SET status          = 'failed',
             error           = left(${error}, 1000),
             next_attempt_at = now() + make_interval(secs => ${sek}::double precision)
       WHERE id = ${id}::uuid`);
  }
}

/**
 * Red koji `dispatchDequeue` vraća radniku — imena kolona su snake_case, kao
 * sa sy15 RPC-a, da ista petlja radnika radi nad oba izvora bez preslikavanja.
 * ⚠️ `recipient_user_id` je Int u 3.0 (uuid u sy15) — radnik ga koristi samo
 * kao „ima/nema", pa je tip namerno unija.
 */
export interface MaintDispatchRow {
  id: string;
  channel: string;
  recipient: string;
  recipient_user_id: string | number | null;
  subject: string | null;
  body: string;
  attempts: number;
}

/** `to_char(d, 'DD.MM.YYYY')` — format iz tela sy15 funkcija. */
function srpskiDatum(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
}

/** `d::TEXT` nad `date` kolonom u PostgreSQL-u = `YYYY-MM-DD`. */
function isoDan(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** `COALESCE(NEW.completed_at::DATE, CURRENT_DATE)`. */
function danOd(d: Date | null): Date {
  const izvor = d ?? new Date();
  return new Date(
    Date.UTC(izvor.getUTCFullYear(), izvor.getUTCMonth(), izvor.getUTCDate()),
  );
}

/** Statusi naloga koji znače „zatvoren" — izvoze se radi CRUD faze. */
export { WO_ZATVOREN };
