import {
  ConflictException,
  ForbiddenException,
  Injectable,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma-sy15/client";
import { Prisma as Prisma30 } from "@prisma/client";
import { Sy15Service, type Sy15Tx } from "../../common/sy15/sy15.service";
import { ScadaSourceService } from "../../common/sy15/scada-source.service";
import { PrismaService } from "../../prisma/prisma.service";
import type { SendCommandDto } from "./dto/send-command.dto";

/**
 * Energetika / SCADA — 3.0 TALAS E, R1 read sloj (MODULE_SPEC_scada_30.md §3).
 *
 * IZVOR PODATAKA JE NA PREKIDAČU `SCADA_IZVOR` (v. `ScadaSourceService`):
 *   sy15 (podrazumevano) — 6 `scada_*` tabela u sy15 (1.0) bazi, kroz `withUserRls`.
 *   3.0                  — iste tabele u glavnoj (3.0) bazi, kroz `PrismaService`.
 * Seoba: docs/SEOBA_SCADA_2026-08-07.md; plan gašenja sy15 korak 5.
 *
 * ── ZAŠTO 3.0 PUTANJA NEMA `withUserRls` ─────────────────────────────────────
 * Pod sy15 SVE ide kroz `Sy15Service.withUserRls` (doktrina A.2a): `scada_*` politike
 * su `scada_is_admin_or_management()`-scope, a rola `servosync2_app` ima BYPASSRLS —
 * bez `SET LOCAL ROLE authenticated` RLS se NE bi evaluirao. 3.0 baza NEMA RLS uopšte
 * (BACKEND_RULES §11), pa tamo drugog sloja ni nema šta da se evaluira: pravo presuđuje
 * ISKLJUČIVO `energetika.read` / `energetika.control` na HTTP sloju (isti guard, ista
 * dodela, ista dva ključa). Dakle nije „ispao gejt" — ispao je DRUGI, DB-nivo gejt koji
 * u 3.0 bazi ne postoji ni za jedan modul.
 *
 * ── ŠTA JE NAMERNO OSTALO ZAJEDNIČKO ─────────────────────────────────────────
 * Sve ODLUKE (koje metrike po sistemu, klampovanje limita, oblik odgovora, mapiranje
 * grešaka u HTTP) su JEDNOM napisane i dele ih obe putanje. Po izvoru se razlikuje
 * SAMO poziv baze. To je namerno: dve kopije odluka bi se razišle, a razlaz se ne bi
 * video dok neko ne uporedi ekrane pre i posle preklopa.
 *
 * KOMANDE (POST insert + cancel) su R2 (control) — semantika je ZAMRZNUTA
 * (cancel-on-timeout 15 s, claimed recovery, E-stop van allowlista); R1 je NE dira.
 */

/** long-format red istorije (paritet 1.0 `scada_history?select=metric,ts,value`). */
export interface HistoryRow {
  metric: string;
  ts: Date;
  value: number | null;
}

/** Definicija trend-metrike koju history vraća FE-u (`metrics` lista, spec §3 PIN). */
export interface TrendMetric {
  key: string; // ime metrike u `scada_history` (= `metric`)
  label: string; // prikazna oznaka (iz tag definicija sajta)
  kind: string; // temp | setpoint | series (za dinamičke sisteme)
}

/** Tačka serije po ključu (paritet 1.0 `buildHistory` `series`): t = epoch ms, v = vrednost. */
export interface SeriesPoint {
  t: number;
  v: number | null;
}

/**
 * KOT1 trend metrike = temp + setpoint tagovi (paritet 1.0 `buildHistory('kot1')`
 * koji filtrira `kind === 'temp' || 'setpoint'` iz `kot1-tags.json`).
 * IZVOR ISTINE = 1.0 repo `public/scada-hmi/kot1-tags.json` (spec §7 P1: HMI statika
 * se KOPIRA, izvor u 1.0). Ovde su preslikane DEFINICIJE trend-tagova (key/label/kind)
 * da history može dinamički da vrati `metrics` listu (FE ne hardkoduje spisak). Ako se
 * tagovi u 1.0 promene (retko — ekrani stabilni od 07/2026), ažurirati ovu tabelu.
 */
const KOT1_TREND_TAGS: TrendMetric[] = [
  { key: "T_SPOLJA", label: "Spolja", kind: "temp" },
  { key: "T_SUDA", label: "Sud", kind: "temp" },
  { key: "T_CNC", label: "CNC radionica", kind: "temp" },
  { key: "T_ZAVAR", label: "Zavarivanje", kind: "temp" },
  { key: "T_MONTAZA1", label: "Montaza 1", kind: "temp" },
  { key: "T_MONTAZA2", label: "Montaza 2", kind: "temp" },
  { key: "T_HIDRAULIKA", label: "Hidraulika", kind: "temp" },
  { key: "SP_SPOLJA", label: "Zadata spolja", kind: "setpoint" },
  { key: "SP_SUDA_H", label: "Zadata sud H", kind: "setpoint" },
  { key: "SP_SUDA_L", label: "Zadata sud L", kind: "setpoint" },
  { key: "SP_MONTAZA", label: "Zadata montaza", kind: "setpoint" },
  { key: "SP_CNC", label: "Zadata CNC", kind: "setpoint" },
  { key: "SP_HIDRAULIKA", label: "Zadata hidraulika", kind: "setpoint" },
  { key: "SP_ZAVAR", label: "Zadata zavarivanje", kind: "setpoint" },
];

/** KOT2 trend = 6 fiksnih metrika (paritet 1.0 `buildHistory('kot2')`). */
const KOT2_TREND_TAGS: TrendMetric[] = [
  { key: "Temp_suda", label: "Sud", kind: "temp" },
  { key: "Temp_Hala_3", label: "Hala 3", kind: "temp" },
  { key: "Temp_Hala_4", label: "Hala 4", kind: "temp" },
  { key: "Temp_Hala_5", label: "Hala 5", kind: "temp" },
  { key: "Temp_spoljasnja", label: "Spoljašnja", kind: "temp" },
  { key: "setpoint", label: "Zadata", kind: "setpoint" },
];

/** Imena metrika (za `metric IN (...)` predikat) — izvedena iz tag definicija (bez drifta). */
const KOT1_TREND_METRICS = KOT1_TREND_TAGS.map((t) => t.key);
const KOT2_TREND_METRICS = KOT2_TREND_TAGS.map((t) => t.key);

/** Zaštitni okviri (bridge/PostgREST paritet): istorija do 7 dana, alarmi/komande limiti. */
const HISTORY_MAX_HOURS = 168;
const HISTORY_ROW_LIMIT = 12000; // B2: DESC + LIMIT pa reverse (bez limita kot1 premaši)
const ALARM_LIMIT_MAX = 500;
const COMMANDS_LIMIT_MAX = 200;

/**
 * Koje metrike ulaze u trend jednog sistema — ODLUKA, odvojena od gradnje SQL-a.
 * `in` = tačna imena, `like` = LIKE obrasci; rezultat je njihov OR.
 * (Ranije je ovo vraćalo gotov `Prisma.Sql`, pa se nije moglo deliti između dva
 * klijenta. Odluka je ista, samo je odvojena od dijalekta.)
 */
interface MetricFilter {
  in?: string[];
  like?: string[];
}

@Injectable()
export class EnergetikaService {
  constructor(
    private readonly sy15: Sy15Service,
    private readonly prisma: PrismaService,
    private readonly izvor: ScadaSourceService,
  ) {}

  // ---------- Sistemi + snapshotovi ----------

  /** Svih 5 sistema sa online/last_seen heartbeat-om (paritet fetchScadaSites, sort_order). */
  sites(email: string) {
    return this.read(async () => {
      const data = this.izvor.isThreeZero
        ? await this.prisma.scadaSite.findMany({ orderBy: { sortOrder: "asc" } })
        : await this.sy15.withUserRls(email, (tx) =>
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
   *
   * 🔴 `serverNow` MORA doći iz iste baze koja je upisala `updated_at` — zato se pod
   * `3.0` čita `now()` iz 3.0, a ne iz sy15. Da je ostao sy15 `now()`, razlika satova
   * dve mašine bi se prikazala kao lažna (ne)svežina sistema.
   */
  snapshots(email: string) {
    return this.read(async () => {
      if (this.izvor.isThreeZero) {
        const data = await this.prisma.scadaSnapshot.findMany({
          orderBy: { siteKey: "asc" },
        });
        return { data, meta: { serverNow: await this.dbNow30() } };
      }
      return this.sy15.withUserRls(email, async (tx) => {
        const data = await tx.scadaSnapshot.findMany({
          orderBy: { siteKey: "asc" },
        });
        const serverNow = await this.dbNow(tx);
        return { data, meta: { serverNow } };
      });
    });
  }

  /** Snapshot jednog sistema (paritet fetchSnapshotRow) + serverNow (E4). */
  snapshotRow(email: string, siteKey: string) {
    return this.read(async () => {
      if (this.izvor.isThreeZero) {
        const row = await this.prisma.scadaSnapshot.findUnique({
          where: { siteKey },
        });
        return { data: row ?? null, meta: { serverNow: await this.dbNow30() } };
      }
      return this.sy15.withUserRls(email, async (tx) => {
        const row = await tx.scadaSnapshot.findUnique({ where: { siteKey } });
        const serverNow = await this.dbNow(tx);
        return { data: row ?? null, meta: { serverNow } };
      });
    });
  }

  // ---------- Istorija (BE preseti po sistemu — spec §3) ----------

  /**
   * Trend jednog sistema. BE bira metrike po sistemu (preset) umesto sirovih
   * PostgREST filtera; interno čita **DESC + LIMIT 12000 pa reverse** (nalaz B2 —
   * bez toga kot1: 14 metrika × 1440 min premaši limit i ASC bi odsekao NAJNOVIJE sate).
   * Vraća long-format redove rastuće po ts (isti oblik kao 1.0 `fetchSiteHistory`);
   * shaping u {samples}/{series} ostaje FE briga (shim `buildHistory`, R3).
   *
   * 🔴 POD `3.0` JE OVO PRAZNO NA STARTU — istorija se NE prenosi (odluka vlasnika
   * 07.08.2026). Prozor se puni od trenutka preklopa releja; posle ~24 h ekran je
   * pun kao i pre. To je očekivano stanje, ne kvar.
   */
  history(email: string, siteKey: string, hoursRaw?: string, system?: string) {
    return this.read(async () => {
      const hours = clampInt(hoursRaw, 1, HISTORY_MAX_HOURS, 24);
      const filter = this.metricFilter(siteKey, system);
      if (!filter)
        return {
          data: [] as HistoryRow[],
          meta: { siteKey, hours, metrics: [] as TrendMetric[], series: {} },
        };
      const since = new Date(Date.now() - hours * 3600_000);
      // Predikat se gradi JEDNOM (tipovima 3.0 klijenta) i koristi na obe putanje —
      // v. `buildMetricPredicate` za razlog zašto je to bezbedno.
      const pred = buildMetricPredicate(filter);
      // `AND (...)`: predikat sme da bude OR-lista (kot3), pa zagrade NISU kozmetika —
      // bez njih bi `AND a OR b` značilo `(AND a) OR b` i vratilo tuđe metrike.
      const sql = Prisma30.sql`
          SELECT metric, ts, value
          FROM scada_history
          WHERE site_key = ${siteKey} AND ts >= ${since} AND (${pred})
          ORDER BY ts DESC
          LIMIT ${HISTORY_ROW_LIMIT}`;
      const rows = this.izvor.isThreeZero
        ? await this.prisma.$queryRaw<HistoryRow[]>(sql)
        : await this.sy15.withUserRls(email, (tx) =>
            tx.$queryRaw<HistoryRow[]>(sql as unknown as Prisma.Sql),
          );
      const data = rows.reverse();
      // Aditivno (zero-loss): `data` = postojeći long-format redovi; `meta.metrics` +
      // `meta.series` = FE-spremna forma (paritet 1.0 `buildHistory` {tags, series}).
      return {
        data,
        meta: {
          siteKey,
          hours,
          metrics: this.trendMetrics(siteKey, data),
          series: buildSeries(data),
        },
      };
    });
  }

  /**
   * Trend-metrike (key/label/kind) sistema. Fiksni sistemi (kot1/kot2) → definicije iz
   * tagova (uvek pun spisak, i kad neka metrika trenutno nema uzoraka — paritet 1.0
   * koji vraća sve tagove). Pattern sistemi (kot3/solar-*) su već dinamički (LIKE
   * filteri) → metrike se izvode iz stvarno vraćenih redova (nema hardkoda).
   */
  private trendMetrics(siteKey: string, rows: HistoryRow[]): TrendMetric[] {
    if (siteKey === "kot1") return KOT1_TREND_TAGS;
    if (siteKey === "kot2") return KOT2_TREND_TAGS;
    const seen = new Map<string, TrendMetric>();
    for (const r of rows) {
      if (r.metric && !seen.has(r.metric))
        seen.set(r.metric, {
          key: r.metric,
          label: r.metric,
          kind: inferKind(r.metric),
        });
    }
    return [...seen.values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  /**
   * Metrika-filter po sistemu (paritet 1.0 `buildHistory`). null = nepoznat sistem → prazno.
   * Semantika je NEPROMENJENA u odnosu na raniji `Prisma.Sql` oblik:
   *   kot3 je bio `(LIKE 'mix:%' OR LIKE 'analog:%' OR = 'rooms_avg')` — sada
   *   `{ in: ['rooms_avg'], like: ['mix:%','analog:%'] }`, što je isti OR.
   */
  private metricFilter(siteKey: string, system?: string): MetricFilter | null {
    switch (siteKey) {
      case "kot1":
        return { in: KOT1_TREND_METRICS };
      case "kot2":
        return { in: KOT2_TREND_METRICS };
      case "kot3":
        // paritet orFilter '(metric.like.mix:*,metric.like.analog:*,metric.eq.rooms_avg)'
        return { in: ["rooms_avg"], like: ["mix:%", "analog:%"] };
      case "solar-sigen": {
        // paritet metricLike `${sys}:*` — sistem stiže kroz ?system= (bez njega prazan prefiks).
        const sys = (system ?? "").trim();
        return { like: [sys + ":%"] };
      }
      case "solar-kaco":
        return { in: ["pv", "grid"] };
      default:
        return null;
    }
  }

  // ---------- Alarmi ----------

  /** Aktivni alarmi svih sistema, najnoviji prvi (paritet fetchActiveAlarms, limit 100). */
  activeAlarms(email: string, activeOnly = true) {
    return this.read(async () => {
      const args = {
        where: activeOnly ? { active: true } : {},
        orderBy: { raisedAt: "desc" as const },
        take: 100,
      };
      const rows = this.izvor.isThreeZero
        ? await this.prisma.scadaAlarm.findMany(args)
        : await this.sy15.withUserRls(email, (tx) =>
            tx.scadaAlarm.findMany(args),
          );
      return { data: rows.map(serializeAlarm) };
    });
  }

  /** Istorija alarma jednog sistema, aktivni + očišćeni (paritet fetchAlarmHistory). */
  alarmHistory(email: string, siteKey: string, limitRaw?: string) {
    return this.read(async () => {
      const take = clampInt(limitRaw, 1, ALARM_LIMIT_MAX, 100);
      const args = {
        where: { siteKey },
        orderBy: { raisedAt: "desc" as const },
        take,
      };
      const rows = this.izvor.isThreeZero
        ? await this.prisma.scadaAlarm.findMany(args)
        : await this.sy15.withUserRls(email, (tx) =>
            tx.scadaAlarm.findMany(args),
          );
      return { data: rows.map(serializeAlarm) };
    });
  }

  // ---------- Komande (R1: SAMO čitanje — audit tab + poll statusa) ----------

  /** Poslednje komande (audit tab), najnovije prve (paritet fetchRecentCommands). */
  recentCommands(email: string, limitRaw?: string) {
    return this.read(async () => {
      const take = clampInt(limitRaw, 1, COMMANDS_LIMIT_MAX, 40);
      const args = { orderBy: { requestedAt: "desc" as const }, take };
      const data = this.izvor.isThreeZero
        ? await this.prisma.scadaCommand.findMany(args)
        : await this.sy15.withUserRls(email, (tx) =>
            tx.scadaCommand.findMany(args),
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
      const data = this.izvor.isThreeZero
        ? await this.prisma.scadaCommand.findUnique({ where: { id } })
        : await this.sy15.withUserRls(email, (tx) =>
            tx.scadaCommand.findUnique({ where: { id } }),
          );
      return { data: data ?? null };
    });
  }

  // ---------- Komande (R2: control — semantika ZAMRZNUTA) ----------

  /**
   * Pošalji komandu = INSERT `scada_commands` (`status='pending'`).
   *
   * Pod `sy15` ide kroz **withUserRls** (paritet 1.0 `insertCommand`): SET LOCAL ROLE
   * authenticated → RLS INSERT politika (`scada_cmd_insert`) forsira `requested_by =
   * lower(jwt email)`, `status='pending'`, `result/claimed_at/applied_at` NULL.
   * Pod `3.0` te politike nema, pa ISTA PRAVILA drži ovaj kod: `requestedBy` se uvek
   * postavlja iz claims-a (ne iz DTO-a — klijent ga ne može podmetnuti), a
   * `status`/`result`/`claimed_at`/`applied_at` se ne šalju (Prisma `@default`).
   * Zato je `data` objekat ZAJEDNIČKI za obe putanje: pravila su ista, samo ih pod
   * sy15 dodatno potvrđuje i baza.
   *
   * **BE NE dira PLC i NE validira allowlist** — bridge (systemd na ubuntusrv) poluje
   * `pending`, validira protiv allowlist-a i izvršava/odbija (spec §2 t.6; van-allowlist
   * target → `rejected` bez dodira PLC-a).
   *
   * Idempotencija = NATIVNI `idempotency_key` (`clientEventId` ili generisan
   * `ui-<ts>-<rand>`, partial unique u bazi); ponovljen ključ → 23505/P2002 → 409.
   * NE koristi rev_api_idempotency (doktrina A4 — modul ima svoj mehanizam).
   */
  create(email: string, dto: SendCommandDto) {
    return this.read(async () => {
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
      if (this.izvor.isThreeZero) {
        return this.prisma.scadaCommand.create({
          data: data as Prisma30.ScadaCommandUncheckedCreateInput,
        });
      }
      return this.sy15.withUserRls(email, (tx) =>
        tx.scadaCommand.create({ data }),
      );
    });
  }

  /**
   * Otkaži SVOJU pending komandu na timeout čekanja (paritet 1.0 `cancelScadaCommand`).
   * Semantika ZAMRZNUTA (spec §7 P3, appendix): menja SAMO SVOJU `pending` → `expired`;
   * ako je bridge već stigao, vraća STVARNI status (`applied`/`claimed`/…), a stale
   * `claimed` je već `failed` (nikad nazad u pending — to radi relej, ne dira se).
   * Vraća `{ status }`; `'missing'` ako red ne postoji (1.0 RPC vraća taj tekst —
   * NE 404, nije greška toka).
   *
   * Pod `sy15`: DEFINER RPC `scada_cancel_command(uuid)` kroz withUserRls.
   * Pod `3.0`: PREPIS TE ISTE funkcije (izvučene sa žive sy15 `pg_get_functiondef`
   * 07.08.2026) — 3.0 baza nema `auth.jwt()` ni DEFINER funkcije. Uslov
   * `requested_by = lower(email)` je prenet DOSLOVNO: bez njega bi svaki menadžer
   * mogao da otkaže TUĐU komandu, što RPC nikad nije dozvoljavao. `updateMany` +
   * `findUnique` idu u JEDNOJ transakciji da pročitan status bude onaj posle izmene.
   */
  cancel(email: string, id: string) {
    return this.read(async () => {
      if (this.izvor.isThreeZero) {
        return this.prisma.$transaction(async (tx) => {
          await tx.scadaCommand.updateMany({
            where: {
              id,
              status: "pending",
              requestedBy: email.toLowerCase(),
            },
            data: {
              status: "expired",
              result: {
                error: "otkazano iz aplikacije (bridge se nije javio na vreme)",
              },
            },
          });
          const row = await tx.scadaCommand.findUnique({
            where: { id },
            select: { status: true },
          });
          return { status: row?.status ?? "missing" };
        });
      }
      return this.sy15.withUserRls(email, async (tx) => {
        const rows = await tx.$queryRaw<{ status: string }[]>(
          Prisma.sql`SELECT public.scada_cancel_command(${id}::uuid) AS status`,
        );
        return { status: rows[0]?.status ?? "missing" };
      });
    });
  }

  // ---------- infrastruktura ----------

  /** `now()` iste baze koja piše `updated_at` — referenca za serverNow (E4), sy15 putanja. */
  private async dbNow(tx: Sy15Tx): Promise<Date> {
    const rows = await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
    return rows[0]?.now ?? new Date();
  }

  /** Isto, ali iz 3.0 baze (v. komentar na `snapshots`). */
  private async dbNow30(): Promise<Date> {
    const rows = await this.prisma.$queryRaw<
      { now: Date }[]
    >`SELECT now() AS now`;
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

  /**
   * SQLSTATE iz DB → HTTP semantika (spec §5 paritet Reversi).
   * Važi za OBE baze: kodovi su Postgres-ovi, ne sy15-specifični. Pod `3.0` grane
   * 42501/P0001 praktično ne mogu da se dese (nema RLS ni DEFINER `raise`), ali
   * ostaju — jeftine su, a mapiranje 23505/P2002 → 409 je zajedničko i nužno.
   */
  private rethrowSy15(e: unknown): never {
    const meta = (e as { meta?: { code?: string; message?: string } }).meta;
    const code = (e as { code?: string }).code;
    const message = meta?.message ?? (e as Error).message;
    if (meta?.code === "42501") throw new ForbiddenException(message);
    if (meta?.code === "P0001" || meta?.code === "P0002")
      throw new UnprocessableEntityException(message);
    // Konflikt (409) stiže u DVA oblika: raw put ($queryRaw/RPC) daje P2010 sa
    // `meta.code='23505'`, a TYPED Prisma create (`scadaCommand.create` — dupli
    // `idempotency_key` na partial unique `scada_commands_idem`) baca
    // PrismaClientKnownRequestError sa **top-level `.code='P2002'`** (BEZ meta.code).
    // Oba → 409 (paritet 1.0 PostgREST; bez ove grane typed create bi pao na 500).
    if (code === "P2002" || meta?.code === "23505")
      throw new ConflictException(message);
    if (meta?.code === "23514") throw new UnprocessableEntityException(message);
    throw e;
  }
}

/**
 * `MetricFilter` → SQL predikat (`metric IN (...) OR metric LIKE ...`).
 *
 * Gradi se tipovima **3.0** klijenta, a koristi i na sy15 putanji uz jedan cast.
 * Zašto je to bezbedno: `Prisma.sql`/`Prisma.join` iz oba generisana klijenta su ISTA
 * runtime implementacija (`@prisma/client/runtime`) — rezultat je običan `Sql` objekat
 * sa `strings`/`values`, bez ikakve veze sa šemom. Razlikuju se samo NOMINALNO (dva
 * generisana paketa), pa je cast na šavu tačno jedno mesto umesto dve kopije istog SQL-a.
 */
function buildMetricPredicate(f: MetricFilter): Prisma30.Sql {
  const parts: Prisma30.Sql[] = [];
  if (f.in?.length)
    parts.push(Prisma30.sql`metric IN (${Prisma30.join(f.in)})`);
  for (const p of f.like ?? []) parts.push(Prisma30.sql`metric LIKE ${p}`);
  // `metricFilter` nikad ne vraća prazan filter (samo `null` za nepoznat sistem,
  // koji pozivalac odseca ranije) — `FALSE` je samo zaštita od budućeg praznog slučaja.
  if (parts.length === 0) return Prisma30.sql`FALSE`;
  return Prisma30.join(parts, " OR ");
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
 * long-format redovi → serije po metric ključu (paritet 1.0 `buildHistory` `series`):
 * `{ [metric]: [{ t: epoch ms, v }] }`. Redovi su već rastući po ts (posle `reverse`),
 * pa su i tačke serije rastuće — FE crta bez dodatnog sortiranja.
 */
function buildSeries(rows: HistoryRow[]): Record<string, SeriesPoint[]> {
  const out: Record<string, SeriesPoint[]> = {};
  for (const r of rows) {
    if (!r.metric) continue;
    (out[r.metric] ??= []).push({ t: new Date(r.ts).getTime(), v: r.value });
  }
  return out;
}

/** Gruba klasifikacija metrike za dinamičke sisteme (kot3/solar-*) — best-effort `kind`. */
function inferKind(metric: string): string {
  const m = metric.toLowerCase();
  if (m.includes("setpoint") || m.startsWith("sp")) return "setpoint";
  if (m.includes("temp") || m.startsWith("t_")) return "temp";
  return "series";
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
