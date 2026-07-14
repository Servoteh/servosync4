import {
  ConflictException,
  ForbiddenException,
  Injectable,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma-sy15/client";
import { Sy15Service, type Sy15Tx } from "../../common/sy15/sy15.service";
import type { SendCommandDto } from "./dto/send-command.dto";

/**
 * Energetika / SCADA — 3.0 TALAS E, R1 read sloj (MODULE_SPEC_scada_30.md §3).
 * Podaci žive u sy15 (1.0) bazi (spec §0); ovaj servis samo ČITA 5 scada_* tabela.
 *
 * SVE kroz `Sy15Service.withUserRls` (doktrina A.2a): scada_* politike su
 * `scada_is_admin_or_management()`-scope, a rola `servosync2_app` ima BYPASSRLS —
 * bez `SET LOCAL ROLE authenticated` RLS se NE bi evaluirao (paritet po konstrukciji).
 * HTTP sloj već gate-uje `energetika.read` (admin+menadzment); withUserRls je drugi,
 * DB-nivo sloj — identično kao 1.0 PostgREST (RLS vraća prazno ostalima).
 *
 * KOMANDE (POST insert + scada_cancel_command RPC) su R2 (control) — semantika je
 * ZAMRZNUTA (cancel-on-timeout 15 s, claimed recovery, E-stop van allowlista); R1 je NE dira.
 */

/** long-format red istorije (paritet 1.0 `scada_history?select=metric,ts,value`). */
export interface HistoryRow {
  metric: string;
  ts: Date;
  value: number | null;
}

/**
 * KOT1 trend metrike = temp + setpoint tagovi (paritet 1.0 `buildHistory('kot1')`
 * koji filtrira `kind === 'temp' || 'setpoint'` iz `kot1-tags.json`).
 * IZVOR ISTINE = 1.0 repo `public/scada-hmi/kot1-tags.json` (spec §7 P1: HMI statika
 * se KOPIRA, izvor u 1.0). Ovde su preslikana samo IMENA metrika za BE preset — labele/
 * zone/scale ostaju FE briga (shim ih čita iz kot1-tags.json u R3). Ako se tagovi u 1.0
 * promene (retko — ekrani stabilni od 07/2026), ažurirati ovu listu.
 */
const KOT1_TREND_METRICS = [
  // kind: temp
  "T_SPOLJA",
  "T_SUDA",
  "T_CNC",
  "T_ZAVAR",
  "T_MONTAZA1",
  "T_MONTAZA2",
  "T_HIDRAULIKA",
  // kind: setpoint
  "SP_SPOLJA",
  "SP_SUDA_H",
  "SP_SUDA_L",
  "SP_MONTAZA",
  "SP_CNC",
  "SP_HIDRAULIKA",
  "SP_ZAVAR",
];

/** KOT2 trend = 6 fiksnih metrika (paritet 1.0 `buildHistory('kot2')`). */
const KOT2_TREND_METRICS = [
  "Temp_suda",
  "Temp_Hala_3",
  "Temp_Hala_4",
  "Temp_Hala_5",
  "Temp_spoljasnja",
  "setpoint",
];

/** Zaštitni okviri (bridge/PostgREST paritet): istorija do 7 dana, alarmi/komande limiti. */
const HISTORY_MAX_HOURS = 168;
const HISTORY_ROW_LIMIT = 12000; // B2: DESC + LIMIT pa reverse (bez limita kot1 premaši)
const ALARM_LIMIT_MAX = 500;
const COMMANDS_LIMIT_MAX = 200;

@Injectable()
export class EnergetikaService {
  constructor(private readonly sy15: Sy15Service) {}

  // ---------- Sistemi + snapshotovi ----------

  /** Svih 5 sistema sa online/last_seen heartbeat-om (paritet fetchScadaSites, sort_order). */
  sites(email: string) {
    return this.read(async () => {
      const data = await this.sy15.withUserRls(email, (tx) =>
        tx.scadaSite.findMany({ orderBy: { sortOrder: "asc" } }),
      );
      return { data };
    });
  }

  /**
   * Najnovija stanja svih sistema (paritet fetchScadaSnapshots) + **`serverNow`**
   * (presuda E4, aditivno): BE `now()` iz ISTE baze koja piše `updated_at` — front
   * može da meri svežinu bez oslanjanja na klijentski sat (1.0 clock-safe algoritam
   * ostaje fallback; semantika `online`/`updated_at` polja se NE menja).
   */
  snapshots(email: string) {
    return this.read(async () =>
      this.sy15.withUserRls(email, async (tx) => {
        const data = await tx.scadaSnapshot.findMany({
          orderBy: { siteKey: "asc" },
        });
        const serverNow = await this.dbNow(tx);
        return { data, meta: { serverNow } };
      }),
    );
  }

  /** Snapshot jednog sistema (paritet fetchSnapshotRow) + serverNow (E4). */
  snapshotRow(email: string, siteKey: string) {
    return this.read(async () =>
      this.sy15.withUserRls(email, async (tx) => {
        const row = await tx.scadaSnapshot.findUnique({ where: { siteKey } });
        const serverNow = await this.dbNow(tx);
        return { data: row ?? null, meta: { serverNow } };
      }),
    );
  }

  // ---------- Istorija (BE preseti po sistemu — spec §3) ----------

  /**
   * Trend jednog sistema. BE bira metrike po sistemu (preset) umesto sirovih
   * PostgREST filtera; interno čita **DESC + LIMIT 12000 pa reverse** (nalaz B2 —
   * bez toga kot1: 14 metrika × 1440 min premaši limit i ASC bi odsekao NAJNOVIJE sate).
   * Vraća long-format redove rastuće po ts (isti oblik kao 1.0 `fetchSiteHistory`);
   * shaping u {samples}/{series} ostaje FE briga (shim `buildHistory`, R3).
   */
  history(email: string, siteKey: string, hoursRaw?: string, system?: string) {
    return this.read(async () => {
      const hours = clampInt(hoursRaw, 1, HISTORY_MAX_HOURS, 24);
      const pred = this.metricPredicate(siteKey, system);
      if (!pred) return { data: [] as HistoryRow[], meta: { siteKey, hours } };
      const since = new Date(Date.now() - hours * 3600_000);
      const rows = await this.sy15.withUserRls(email, (tx) =>
        tx.$queryRaw<HistoryRow[]>(Prisma.sql`
          SELECT metric, ts, value
          FROM scada_history
          WHERE site_key = ${siteKey} AND ts >= ${since} AND ${pred}
          ORDER BY ts DESC
          LIMIT ${HISTORY_ROW_LIMIT}`),
      );
      return { data: rows.reverse(), meta: { siteKey, hours } };
    });
  }

  /** Metrika-filter po sistemu (paritet 1.0 `buildHistory`). null = nepoznat sistem → prazno. */
  private metricPredicate(siteKey: string, system?: string): Prisma.Sql | null {
    switch (siteKey) {
      case "kot1":
        return Prisma.sql`metric IN (${Prisma.join(KOT1_TREND_METRICS)})`;
      case "kot2":
        return Prisma.sql`metric IN (${Prisma.join(KOT2_TREND_METRICS)})`;
      case "kot3":
        // paritet orFilter '(metric.like.mix:*,metric.like.analog:*,metric.eq.rooms_avg)'
        return Prisma.sql`(metric LIKE 'mix:%' OR metric LIKE 'analog:%' OR metric = 'rooms_avg')`;
      case "solar-sigen": {
        // paritet metricLike `${sys}:*` — sistem stiže kroz ?system= (bez njega prazan prefiks).
        const sys = (system ?? "").trim();
        return Prisma.sql`metric LIKE ${sys + ":%"}`;
      }
      case "solar-kaco":
        return Prisma.sql`metric IN (${Prisma.join(["pv", "grid"])})`;
      default:
        return null;
    }
  }

  // ---------- Alarmi ----------

  /** Aktivni alarmi svih sistema, najnoviji prvi (paritet fetchActiveAlarms, limit 100). */
  activeAlarms(email: string, activeOnly = true) {
    return this.read(async () => {
      const rows = await this.sy15.withUserRls(email, (tx) =>
        tx.scadaAlarm.findMany({
          where: activeOnly ? { active: true } : {},
          orderBy: { raisedAt: "desc" },
          take: 100,
        }),
      );
      return { data: rows.map(serializeAlarm) };
    });
  }

  /** Istorija alarma jednog sistema, aktivni + očišćeni (paritet fetchAlarmHistory). */
  alarmHistory(email: string, siteKey: string, limitRaw?: string) {
    return this.read(async () => {
      const take = clampInt(limitRaw, 1, ALARM_LIMIT_MAX, 100);
      const rows = await this.sy15.withUserRls(email, (tx) =>
        tx.scadaAlarm.findMany({
          where: { siteKey },
          orderBy: { raisedAt: "desc" },
          take,
        }),
      );
      return { data: rows.map(serializeAlarm) };
    });
  }

  // ---------- Komande (R1: SAMO čitanje — audit tab + poll statusa) ----------

  /** Poslednje komande (audit tab), najnovije prve (paritet fetchRecentCommands). */
  recentCommands(email: string, limitRaw?: string) {
    return this.read(async () => {
      const take = clampInt(limitRaw, 1, COMMANDS_LIMIT_MAX, 40);
      const data = await this.sy15.withUserRls(email, (tx) =>
        tx.scadaCommand.findMany({ orderBy: { requestedAt: "desc" }, take }),
      );
      return { data };
    });
  }

  /**
   * Status jedne komande (poll posle slanja — paritet fetchCommand). Vraća `null`
   * ako ne postoji (1.0 poller očekuje null i ponavlja; NE 404 — nije greška toka).
   */
  command(email: string, id: string) {
    return this.read(async () => {
      const data = await this.sy15.withUserRls(email, (tx) =>
        tx.scadaCommand.findUnique({ where: { id } }),
      );
      return { data: data ?? null };
    });
  }

  // ---------- Komande (R2: control — semantika ZAMRZNUTA) ----------

  /**
   * Pošalji komandu = INSERT `scada_commands` (`status='pending'`) kroz **withUserRls**
   * (paritet 1.0 `insertCommand`). SET LOCAL ROLE authenticated → RLS INSERT politika
   * (`scada_cmd_insert`) forsira: `requested_by = lower(jwt email)`, `status='pending'`,
   * `result/claimed_at/applied_at` NULL. **BE NE dira PLC i NE validira allowlist** —
   * bridge (neportovan, systemd na ubuntusrv) poluje `pending`, validira protiv allowlist-a
   * i izvršava/odbija (spec §2 t.6; van-allowlist target → `rejected` bez dodira PLC-a).
   *
   * `requested_by` = lowercased email iz claims (NE `sub`/uid — scada politike i 1.0
   * upisuju EMAIL; WITH CHECK poredi `auth.jwt()->>'email'`). Idempotencija = NATIVNI
   * `idempotency_key` (`clientEventId` ili generisan `ui-<ts>-<rand>`, partial unique u
   * bazi); ponovljen ključ → 23505 → 409 (rethrowSy15). NE koristi rev_api_idempotency
   * (doktrina A4 — modul ima svoj mehanizam). `status` se NE šalje (Prisma @default
   * 'pending'), izostavljeni NULL-ovi zadovoljavaju WITH CHECK.
   */
  create(email: string, dto: SendCommandDto) {
    return this.read(async () =>
      this.sy15.withUserRls(email, (tx) => {
        const data: Prisma.ScadaCommandUncheckedCreateInput = {
          siteKey: dto.siteKey,
          target: dto.target,
          op: dto.op?.trim() || "set",
          requestedBy: email.toLowerCase(),
          idempotencyKey: dto.clientEventId?.trim() || genIdempotencyKey(),
        };
        // value je nullable (kolona) — izostavljen ostaje SQL NULL (paritet reset targeta).
        if (dto.value !== undefined)
          data.value = dto.value as Prisma.InputJsonValue;
        return tx.scadaCommand.create({ data });
      }),
    );
  }

  /**
   * Otkaži SVOJU pending komandu na timeout čekanja (paritet 1.0 `cancelScadaCommand`):
   * DEFINER RPC `scada_cancel_command(uuid)` kroz withUserRls (RPC gate-uje
   * `scada_is_admin_or_management()`; `energetika.control` guard je HTTP sloj). Semantika
   * ZAMRZNUTA (spec §7 P3, appendix): menja SAMO svoju `pending` → `expired`; ako je bridge
   * već stigao, vraća STVARNI status (`applied`/`claimed`/…), a stale `claimed` je već
   * `failed` (nikad nazad u pending — to radi DB/bridge, ne dira se). Vraća `{ status }`;
   * `'missing'` ako red ne postoji (1.0 RPC vraća taj tekst — NE 404, nije greška toka).
   */
  cancel(email: string, id: string) {
    return this.read(async () =>
      this.sy15.withUserRls(email, async (tx) => {
        const rows = await tx.$queryRaw<{ status: string }[]>(
          Prisma.sql`SELECT public.scada_cancel_command(${id}::uuid) AS status`,
        );
        return { status: rows[0]?.status ?? "missing" };
      }),
    );
  }

  // ---------- infrastruktura ----------

  /** `now()` iste baze koja piše `updated_at` — referenca za serverNow (E4). */
  private async dbNow(tx: Sy15Tx): Promise<Date> {
    const rows = await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
    return rows[0]?.now ?? new Date();
  }

  /** Jedinstven put za read metode + SQLSTATE mapiranje (paritet Reversi). */
  private async read<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      this.rethrowSy15(e);
    }
  }

  /** SQLSTATE iz DB (RLS/politike/RPC) → HTTP semantika (spec §5 paritet Reversi). */
  private rethrowSy15(e: unknown): never {
    const meta = (e as { meta?: { code?: string; message?: string } }).meta;
    const message = meta?.message ?? (e as Error).message;
    if (meta?.code === "42501") throw new ForbiddenException(message);
    if (meta?.code === "P0001" || meta?.code === "P0002")
      throw new UnprocessableEntityException(message);
    if (meta?.code === "23505") throw new ConflictException(message);
    if (meta?.code === "23514") throw new UnprocessableEntityException(message);
    throw e;
  }
}

/**
 * NATIVNI idempotency_key (paritet 1.0 `insertCommand`: `ui-${Date.now()}-<rand>`).
 * NIJE uuid (partial unique u bazi). Praktično uvek jedinstven — postoji da dupli
 * klik/retry sa ISTIM `clientEventom` udari 23505 → 409, ne dupli upis na PLC.
 */
export function genIdempotencyKey(): string {
  return `ui-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Zaštitno parsiranje/klampovanje query brojeva (string → int u [min,max], inače def). */
function clampInt(
  raw: string | undefined,
  min: number,
  max: number,
  def: number,
): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

/**
 * scada_alarms.id je bigint → Prisma vraća JS BigInt (nije JSON-serializabilan;
 * `JSON.stringify` baca). Preslikaj u Number (id-jevi ~10k, daleko ispod
 * MAX_SAFE_INTEGER; 1.0 front ga tretira kao broj — paritet).
 */
function serializeAlarm<T extends { id: bigint }>(
  a: T,
): Omit<T, "id"> & {
  id: number;
} {
  return { ...a, id: Number(a.id) };
}
