import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { jsonSafe } from "../../common/json-safe";
import { sanitizeDrawingNo } from "../../common/drawings";
import { resolvePermissionDecision } from "../../common/authz/effective-permission";
import { PERMISSIONS } from "../../common/authz/permissions";
import { ROLES } from "../../common/authz/roles";
import type {
  IzvestajQueryDto,
  OperativniPlanQueryDto,
  PortfolioQueryDto,
  PrijaveQueryDto,
} from "./dto/pracenje-query.dto";

/**
 * Praćenje proizvodnje — READ sloj nad ORIGINALNIM 2.0 tabelama (F1, plan
 * docs/PLAN_PRACENJE_PROIZVODNJE_2026-07.md §3.3). Zamena za sy15 DEFINER RPC-ove
 * (get_pracenje_portfolio / get_predmet_pracenje_izvestaj / get_pracenje_rn / …):
 * ista semantika, ali direktno nad `work_orders` / `work_order_operations` /
 * `tech_processes` / `operations` / `drawing_pdfs` + nove app-owned tabele
 * (`predmet_aktivacije`, `pracenje_overrides`, `pracenje_notes`,
 * `pracenje_structure_overrides`, `operativne_aktivnosti`).
 *
 * Ključno mapiranje (inverzija `locations/loc-tp-feed.service.ts` koji je hranio
 * sy15 bigtehn keš iz 2.0):
 *   bigtehn_work_orders_cache      ← work_orders            (predmet = project_id, O1)
 *   bigtehn_work_order_lines_cache ← work_order_operations  (routing)
 *   bigtehn_tech_routing_cache     ← tech_processes         (kucanja / prijave)
 *   bigtehn_machines_cache         ← operations             (rj_code=work_center_code,
 *                                                            name=work_center_name,
 *                                                            no_procedure=without_process)
 *   v_bigtehn_rn_struktura         ← WITH RECURSIVE work_order_components (anti-ciklus guard!)
 *
 * 2.0 ima SAMO „bigtehn" granu (nema Faza-2 `radni_nalog_pozicija`/`tp_operacija`),
 * pa je local/bigtehn fallback iz 1.0 sklopljen u jedan izvor (plan §3.3).
 * RN id je Int (`work_orders.id`) — NE uuid kao u sy15. Envelope `{ data, meta }`;
 * količine su komadi (Int), pa nema Decimal-as-string problema u ovom sloju.
 */

/**
 * Kanon kvaliteta delova (ogledalo tech-processes `PART_QUALITY`,
 * tech-processes.service.ts §1): 0=dobar, 1=dorada, 2=škart. Gotovost („urađeno" / završna
 * kontrola) broji SAMO dobar (GOOD). Škart je otpad. Dorada NIJE još ispravan deo — kontrola
 * dorade automatski otvara child -D RN (tech-processes A3); kad se dorada ispravi, vraća se
 * SVEŽIM GOOD kucanjem koje se tek onda broji. Zato ni škart ni dorada NE ulaze u gotovost
 * (odluka F1 popravni krug, finding #3: bolje „nedovršeno" nego lažno „završeno").
 */
const QUALITY_GOOD = 0;

/** Anti-ciklus dubina za WITH RECURSIVE po sastavnici (BACKEND_RULES §11.4: PG visi na ciklusu). */
const MAX_DEPTH = 20;

/** Lot clamp — paritet 1.0 (1..100000, default 12). */
function clampLot(raw?: string): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 100000) : 12;
}

/** Date → 'YYYY-MM-DD' (paritet jsonb `date` izlaza sy15 RPC-ova). */
function toDateStr(d: Date | null | undefined): string | null {
  if (!d) return null;
  const t = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(t.getTime())) return null;
  return t.toISOString().slice(0, 10);
}

/**
 * Lokalni „danas" (YYYY-MM-DD) u zoni Europe/Belgrade za poređenje rokova (kasni).
 * NE `new Date().toISOString()` (UTC, finding #4): posle ponoći po CET-u UTC još pokazuje
 * jučerašnji datum, pa bi rok koji ističe danas lažno ispao „kasni" (ili obrnuto uveče).
 * `sv-SE` locale formatira baš kao `YYYY-MM-DD`; `Intl` je ugrađen (bez nove zavisnosti).
 */
function todayStr(): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Belgrade",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/**
 * Efektivna „završena količina" pozicije = override > auto (plan §4.6/§4.7, odluka O5),
 * uz klamp na lansirano (finding #1b/#2). Bez ovoga: neklampovani zbir završne kontrole ume
 * da premaši lansirano → kk_pct > 100 i pozicija prevremeno „završena"; a ručni override-i se
 * nigde nisu primenjivali. Precedenca:
 *   1) `manual_status='kompletirano'` → 100% (= lansirano); najjači „ručno završeno" signal;
 *   2) `manual_qty` postavljen        → zamenjuje izračunatu količinu (klamp na lansirano);
 *   3) inače                          → auto završna kontrola (dobar, klampovana).
 * `auto` (klampovani ZK) se uvek vraća posebno da JSON razlikuje auto od override vrednosti.
 * `effective` ostaje `null` kad nema ni ZK-linije ni količinskog override-a (čuva
 * `nema_zavrsnu_kontrolu` semantiku). Statusi `u_radu`/`nije_zapoceto` menjaju samo labelu
 * (FE), NE količinu — da se ne bi sakrila stvarna kucanja.
 */
export function effectiveCompleted(
  lansirano: number | null,
  autoDone: number | null,
  manualStatus: string | null,
  manualQty: number | null,
): { auto: number | null; effective: number | null; overridden: boolean } {
  const auto =
    autoDone == null
      ? null
      : lansirano != null
        ? Math.min(autoDone, lansirano)
        : autoDone;
  if (manualStatus === "kompletirano" && lansirano != null) {
    return { auto, effective: lansirano, overridden: true };
  }
  if (manualQty != null) {
    const q = Math.max(manualQty, 0);
    return {
      auto,
      effective: lansirano != null ? Math.min(q, lansirano) : q,
      overridden: true,
    };
  }
  return { auto, effective: auto, overridden: false };
}

/** Node reda struktura upita (RN + wo atributi + override-i/napomene). */
export interface ProjectNodeRow {
  rn_id: number;
  parent_rn_id: number | null;
  root_rn_id: number;
  nivo: number;
  broj_komada: number;
  path_idrn: number[];
  ident_broj: string | null;
  broj_crteza: string | null;
  naziv_dela: string | null;
  materijal: string | null;
  dimenzija: string | null;
  komada: number | null;
  rok_izrade: Date | null;
  status_rn: boolean | null;
  datum_unosa: Date | null;
  wo_napomena: string | null;
  parent_broj_crteza: string | null;
  has_crtez_file: boolean;
  /** Da li roditeljski (sklopni) crtež ima PDF — izveden iz parent čvora `has_crtez_file`
   *  (pravi EXISTS(drawing_pdfs)); postavlja ga `reparentNodes` (finding #6/#7). */
  has_parent_crtez_file: boolean;
  korisnicka_napomena: string | null;
  status_override: string | null;
  masinska_done_ovr: boolean | null;
  povrsinska_done_ovr: boolean | null;
  manual_qty: number | null;
  has_parent_override: boolean;
  parent_override_rn_id: number | null;
  sort_order: number;
}

interface RnNodeRow {
  rn_id: number;
  parent_rn_id: number | null;
  nivo: number;
  path_idrn: number[];
  ident_broj: string | null;
  naziv_dela: string | null;
  komada: number | null;
  drawing_no: string | null;
  has_crtez_file: boolean;
}

/** Per-node metrika za portfolio rollup. */
interface MetricRow {
  rn_id: number;
  komada: number | null;
  broj_crteza: string | null;
  rok_izrade: Date | null;
  has_crtez: boolean;
  has_final: boolean | null;
  zavrsena: number | null;
  op_ratio_sum: number | null;
  op_count: number | null;
  status_override: string | null;
  manual_qty: number | null;
}

/** Operacija (routing) sa agregatom kucanja (tech_processes). */
interface OpRow {
  work_order_id: number;
  op_id: number;
  operation_number: number;
  work_center_code: string;
  work_description: string | null;
  tools_fixtures: string | null;
  priority: number;
  work_center_name: string | null;
  without_process: boolean | null;
  is_final_control: boolean;
  done: number;
  done_completed: number;
  last_at: Date | null;
  last_completed_at: Date | null;
}

/**
 * Primeni ručne structure-override-e U OBILASKU STABLA (finding #7). Auto-sastavnica
 * (`work_order_components`) daje `parent_rn_id`, ali `pracenje_structure_overrides` sme da
 * re-parentuje čvor (novi roditelj ili koren). Ranije se override samo LEFT JOIN-ovao kao
 * kolona za prikaz, a rekurzija ga je ignorisala — sad se roditelj menja PRE računanja
 * nivoa/korena/rollup-a, pa se `nivo`/`root_rn_id`/`path_idrn`/`sort_order` i sklopni-crtež
 * polja preračunavaju nad EFEKTIVNIM roditeljima. Bez override-a je no-op (reprodukuje SQL
 * stablo). Portfolio rollup je ravan zbir nad istim skupom čvorova, pa re-parent tamo ne menja
 * total — zato se metrika ne dira ovde (dokumentovano u pozivaocu).
 *
 * Defanziva (BACKEND_RULES §11.4, paritet SQL path-array guarda):
 *  - override čiji ciljni roditelj nije u učitanom skupu čvorova → ignoriše se (ostaje auto);
 *  - override koji bi napravio ciklus (čvor postao svoj predak) → preskače se (ostaje auto);
 *    hod naviše ionako lomi na prvom ponovljenom čvoru + `MAX_DEPTH` kapa (nikad beskonačno).
 * Re-parent NE redefiniše `broj_komada` (override nosi hijerarhiju, ne količinu-po-sklopu).
 */
export function reparentNodes(nodes: ProjectNodeRow[]): ProjectNodeRow[] {
  if (nodes.length === 0) return nodes;
  const byId = new Map<number, ProjectNodeRow>();
  for (const n of nodes) byId.set(n.rn_id, n);

  // 1) Efektivni roditelj: override (ako je razrešiv) inače auto parent_rn_id.
  const effParent = new Map<number, number | null>();
  for (const n of nodes) {
    let parent = n.parent_rn_id;
    if (n.has_parent_override) {
      const target = n.parent_override_rn_id;
      if (target == null) {
        parent = null; // odlepi na koren
      } else if (target !== n.rn_id && byId.has(target)) {
        parent = target;
      }
      // target van skupa ili self-ref → ignoriši override (ostaje auto)
    }
    effParent.set(n.rn_id, parent);
  }

  // 2) Ciklus-guard: ako override čini čvor sopstvenim pretkom, vrati ga na auto roditelja.
  const wouldCycle = (startId: number): boolean => {
    const seen = new Set<number>();
    let cur: number | null = startId;
    let depth = 0;
    while (cur != null && depth <= MAX_DEPTH) {
      if (seen.has(cur)) return true;
      seen.add(cur);
      cur = effParent.get(cur) ?? null;
      depth += 1;
    }
    return false;
  };
  for (const n of nodes) {
    if (n.has_parent_override && wouldCycle(n.rn_id)) {
      effParent.set(n.rn_id, n.parent_rn_id); // revert override (defanzivno)
    }
  }

  // 3) Preračunaj koren/nivo/path hodom naviše (memoizovano), sa lomom na ponovljenom čvoru.
  const chain = new Map<
    number,
    { root: number; nivo: number; path: number[] }
  >();
  const resolve = (
    id: number,
  ): { root: number; nivo: number; path: number[] } => {
    const cached = chain.get(id);
    if (cached) return cached;
    const path: number[] = [];
    const seen = new Set<number>();
    let cur: number | null = id;
    while (cur != null && path.length <= MAX_DEPTH) {
      if (seen.has(cur)) break; // path-array guard: preskoči ivicu koja ponavlja čvor
      seen.add(cur);
      path.unshift(cur);
      const parent: number | null = effParent.get(cur) ?? null;
      if (parent == null || !byId.has(parent)) break; // koren / roditelj van skupa
      cur = parent;
    }
    const res = { root: path[0], nivo: path.length - 1, path };
    chain.set(id, res);
    return res;
  };

  // 4) sort_order = row_number unutar (efektivni roditelj) grupe po ident_broj ASC NULLS LAST.
  const groups = new Map<string, ProjectNodeRow[]>();
  for (const n of nodes) {
    const key = String(effParent.get(n.rn_id) ?? "root");
    const arr = groups.get(key);
    if (arr) arr.push(n);
    else groups.set(key, [n]);
  }
  const sortOrderById = new Map<number, number>();
  for (const arr of groups.values()) {
    arr.sort((a, b) => {
      const ai = a.ident_broj ?? "";
      const bi = b.ident_broj ?? "";
      if (ai === "" && bi !== "") return 1; // NULLS LAST
      if (bi === "" && ai !== "") return -1;
      // Code-point poređenje (locale-nezavisno) — poklapa se sa SQL `ident_number ASC`
      // za ASCII idente i deterministično je (za razliku od localeCompare po ICU zoni).
      return ai < bi ? -1 : ai > bi ? 1 : 0;
    });
    arr.forEach((n, i) => sortOrderById.set(n.rn_id, i + 1));
  }

  // 5) Emit re-parented čvorove; sklopni-crtež polja iz NOVOG roditelja (parent.has_crtez_file
  //    je pravi EXISTS(drawing_pdfs), finding #6). Poređaj po (root, path) za stabilan pre-order.
  const out = nodes.map((n) => {
    const c = resolve(n.rn_id);
    const newParent = effParent.get(n.rn_id) ?? null;
    const parentNode = newParent != null ? byId.get(newParent) : undefined;
    return {
      ...n,
      parent_rn_id: newParent,
      parent_broj_crteza: parentNode?.broj_crteza ?? null,
      has_parent_crtez_file: parentNode?.has_crtez_file ?? false,
      root_rn_id: c.root,
      nivo: c.nivo,
      path_idrn: c.path,
      sort_order: sortOrderById.get(n.rn_id) ?? n.sort_order,
    };
  });
  out.sort((a, b) => {
    if (a.root_rn_id !== b.root_rn_id) return a.root_rn_id - b.root_rn_id;
    const len = Math.min(a.path_idrn.length, b.path_idrn.length);
    for (let i = 0; i < len; i++) {
      if (a.path_idrn[i] !== b.path_idrn[i])
        return a.path_idrn[i] - b.path_idrn[i];
    }
    return a.path_idrn.length - b.path_idrn.length;
  });
  return out;
}

@Injectable()
export class PracenjeReadService {
  constructor(private readonly prisma: PrismaService) {}

  // ==========================================================================
  // Portfolio / predmeti
  // ==========================================================================

  /** Kontrolna tabla — rollup po aktivnom predmetu (paritet get_pracenje_portfolio). */
  async portfolio(_email: string, q: PortfolioQueryDto) {
    const lot = clampLot(q.lotQty);
    const generatedAt = new Date().toISOString();

    // Aktivni predmeti (predmet_aktivacije ⋈ projects ⋈ customers).
    const active = await this.prisma.$queryRaw<
      {
        project_id: number;
        sort_priority: number | null;
        broj_predmeta: string | null;
        naziv_predmeta: string | null;
        komitent: string;
        rok_zavrsetka: Date | null;
      }[]
    >(Prisma.sql`
      SELECT pa.project_id::int AS project_id,
             pa.sort_priority::int AS sort_priority,
             NULLIF(BTRIM(p.project_number), '') AS broj_predmeta,
             COALESCE(NULLIF(BTRIM(p.project_name), ''), NULLIF(BTRIM(p.description), ''), '') AS naziv_predmeta,
             COALESCE(NULLIF(BTRIM(c.name), ''), NULLIF(BTRIM(c.short_name), ''), '') AS komitent,
             p.deadline AS rok_zavrsetka
        FROM predmet_aktivacije pa
        JOIN projects p ON p.id = pa.project_id
        LEFT JOIN customers c ON c.id = p.customer_id
       WHERE pa.is_active IS TRUE`);

    const items: Record<string, unknown>[] = [];
    const kpiTally = {
      ukupno: 0,
      u_toku: 0,
      kasni: 0,
      zavrseno: 0,
      na_cekanju: 0,
      bez_podataka: 0,
      problemi_total: 0,
      predmeti_sa_problemima: 0,
      op_pct_sum: 0,
      op_pct_n: 0,
    };
    const today = todayStr();

    for (const a of active) {
      const nodes = await this.projectNodeMetrics(a.project_id);
      const total_rows = nodes.length;
      let lans = 0;
      let zav = 0;
      let kasni = 0;
      let nije_kompletirano = 0;
      let nema_tp = 0;
      let nema_crtez = 0;
      let nema_kk = 0;
      let opRatioSum = 0;
      let opCount = 0;
      for (const n of nodes) {
        const komada = n.komada ?? 0;
        // Override > auto, klampovano na lansirano PRE agregacije naviše (finding #1b/#2) —
        // isto pravilo kao izvestaj; Math.min štiti i kad je piece_count null/0 (zav ≤ lans).
        const eff = effectiveCompleted(
          n.komada ?? null,
          n.zavrsena,
          n.status_override,
          n.manual_qty,
        );
        const zavrsena = Math.min(eff.effective ?? 0, komada);
        lans += komada;
        zav += zavrsena;
        const rok = toDateStr(n.rok_izrade);
        if (rok && rok < today && zavrsena < komada) kasni += 1;
        if (n.komada != null && zavrsena < komada) nije_kompletirano += 1;
        if (!n.broj_crteza) nema_tp += 1;
        if (!n.has_crtez) nema_crtez += 1;
        if (!n.has_final) nema_kk += 1;
        opRatioSum += Number(n.op_ratio_sum ?? 0);
        opCount += Number(n.op_count ?? 0);
      }
      const problemi = nema_tp + nema_crtez + nema_kk;
      const op_pct =
        opCount > 0 ? Math.round((opRatioSum / opCount) * 100) : null;
      const kk_pct = lans > 0 ? Math.round((zav / lans) * 100) : null;
      const rokStr = toDateStr(a.rok_zavrsetka);
      const daniDoRoka =
        rokStr == null
          ? null
          : Math.round(
              (new Date(rokStr + "T00:00:00Z").getTime() -
                new Date(today + "T00:00:00Z").getTime()) /
                86400000,
            );
      let status: string;
      if (total_rows === 0) status = "bez_podataka";
      else if (kasni > 0) status = "kasni";
      else if (lans > 0 && zav >= lans) status = "zavrseno";
      else if ((op_pct ?? 0) === 0) status = "na_cekanju";
      else status = "u_toku";

      items.push({
        item_id: a.project_id,
        broj_predmeta: a.broj_predmeta ?? "",
        naziv_predmeta: a.naziv_predmeta ?? "",
        komitent: a.komitent,
        rok_zavrsetka: toDateStr(a.rok_zavrsetka),
        sort_priority: a.sort_priority,
        total_rows,
        total_lansirano: lans,
        total_zavrseno: zav,
        count_kasni: kasni,
        count_nije_kompletirano: nije_kompletirano,
        count_nema_tp: nema_tp,
        count_nema_crtez: nema_crtez,
        count_nema_zavrsnu_kontrolu: nema_kk,
        problemi,
        kk_pct,
        op_pct,
        // docx §4.8 / plan §3.3: kolona „usko grlo" se izbacuje — polje ostaje null.
        usko_grlo: null,
        dani_do_roka: daniDoRoka,
        status,
      });

      kpiTally.ukupno += 1;
      if (status === "u_toku") kpiTally.u_toku += 1;
      if (status === "kasni") kpiTally.kasni += 1;
      if (status === "zavrseno") kpiTally.zavrseno += 1;
      if (status === "na_cekanju") kpiTally.na_cekanju += 1;
      if (status === "bez_podataka") kpiTally.bez_podataka += 1;
      kpiTally.problemi_total += problemi;
      if (problemi > 0) kpiTally.predmeti_sa_problemima += 1;
      if (op_pct != null) {
        kpiTally.op_pct_sum += op_pct;
        kpiTally.op_pct_n += 1;
      }
    }

    items.sort((x, y) => {
      const sx = (x.sort_priority as number | null) ?? Number.MAX_SAFE_INTEGER;
      const sy = (y.sort_priority as number | null) ?? Number.MAX_SAFE_INTEGER;
      if (sx !== sy) return sx - sy;
      return String(x.broj_predmeta).localeCompare(String(y.broj_predmeta));
    });

    const kpi = {
      ukupno_predmeta: kpiTally.ukupno,
      u_toku: kpiTally.u_toku,
      kasni: kpiTally.kasni,
      zavrseno: kpiTally.zavrseno,
      na_cekanju: kpiTally.na_cekanju,
      bez_podataka: kpiTally.bez_podataka,
      problemi_total: kpiTally.problemi_total,
      predmeti_sa_problemima: kpiTally.predmeti_sa_problemima,
      prosecan_op_napredak:
        kpiTally.op_pct_n > 0
          ? Math.round(kpiTally.op_pct_sum / kpiTally.op_pct_n)
          : 0,
    };

    return {
      data: { lot_qty: lot, generated_at: generatedAt, kpi, items },
    };
  }

  /** Aktivni predmeti (ekran 1) — paritet get_aktivni_predmeti. */
  async predmeti(_email: string) {
    const rows = await this.prisma.$queryRaw<
      {
        item_id: number;
        broj_predmeta: string | null;
        naziv_predmeta: string | null;
        customer_name: string;
        rok_zavrsetka: Date | null;
        sort_priority: number | null;
      }[]
    >(Prisma.sql`
      SELECT pa.project_id::int AS item_id,
             NULLIF(BTRIM(p.project_number), '') AS broj_predmeta,
             COALESCE(NULLIF(BTRIM(p.project_name), ''), NULLIF(BTRIM(p.description), ''), '') AS naziv_predmeta,
             COALESCE(NULLIF(BTRIM(c.name), ''), NULLIF(BTRIM(c.short_name), ''), '') AS customer_name,
             p.deadline AS rok_zavrsetka,
             pa.sort_priority::int AS sort_priority
        FROM predmet_aktivacije pa
        JOIN projects p ON p.id = pa.project_id
        LEFT JOIN customers c ON c.id = p.customer_id
       WHERE pa.is_active IS TRUE
       ORDER BY pa.sort_priority ASC NULLS LAST, p.project_number ASC NULLS LAST`);

    const data = rows.map((r, i) => ({
      item_id: r.item_id,
      broj_predmeta: r.broj_predmeta ?? "",
      naziv_predmeta: r.naziv_predmeta ?? "",
      customer_name: r.customer_name,
      rok_zavrsetka: toDateStr(r.rok_zavrsetka),
      sort_priority: r.sort_priority,
      redni_broj: i + 1,
    }));
    return { data };
  }

  /** Stablo podsklopova predmeta (paritet get_podsklopovi_predmeta) — ravna lista. */
  async podsklopovi(_email: string, projectId: number) {
    // reparentNodes: primeni ručne structure-override-e u stablu (finding #7).
    const nodes = reparentNodes(await this.projectNodes(projectId, null));
    const data = nodes.map((n) => ({
      rn_id: n.rn_id,
      legacy_idrn: n.rn_id,
      root_rn_id: n.root_rn_id,
      ident_broj: n.ident_broj ?? "",
      naziv_dela: n.naziv_dela ?? "",
      status_rn: n.status_rn,
      nivo: n.nivo,
      parent_rn_id: n.parent_rn_id,
      broj_komada: n.broj_komada,
      // is_mes_aktivan: 2.0 RN je aktivan dok status (=završen) nije TRUE (uprošćeno
      // u odnosu na 1.0 v_active_bigtehn_work_orders koji je zavisio od plana proizvodnje).
      is_mes_aktivan: n.status_rn !== true,
      path_idrn: n.path_idrn,
    }));
    return { data };
  }

  /** Tabela praćenja predmeta — stablo + % gotovosti (paritet get_predmet_pracenje_izvestaj). */
  async izvestaj(_email: string, projectId: number, q: IzvestajQueryDto) {
    const lot = clampLot(q.lotQty);
    const rootRn = q.rootRn ? Number(q.rootRn) : null;
    const generatedAt = new Date().toISOString();

    const project = await this.prisma.$queryRaw<
      {
        item_id: number;
        broj_predmeta: string | null;
        naziv_predmeta: string | null;
        komitent: string;
        rok_zavrsetka: Date | null;
      }[]
    >(Prisma.sql`
      SELECT p.id::int AS item_id,
             NULLIF(BTRIM(p.project_number), '') AS broj_predmeta,
             COALESCE(NULLIF(BTRIM(p.project_name), ''), NULLIF(BTRIM(p.description), ''), '') AS naziv_predmeta,
             COALESCE(NULLIF(BTRIM(c.name), ''), NULLIF(BTRIM(c.short_name), ''), '') AS komitent,
             p.deadline AS rok_zavrsetka
        FROM projects p
        LEFT JOIN customers c ON c.id = p.customer_id
       WHERE p.id = ${projectId}`);
    if (project.length === 0) {
      throw new NotFoundException(`Predmet ${projectId} ne postoji.`);
    }
    const p = project[0];

    let root: Record<string, unknown> | null = null;
    if (rootRn != null) {
      const r = await this.prisma.$queryRaw<
        {
          node_id: number;
          naziv: string | null;
          broj_crteza: string | null;
          nivo: number;
        }[]
      >(Prisma.sql`
        SELECT w.id::int AS node_id,
               COALESCE(NULLIF(BTRIM(w.part_name), ''), w.ident_number) AS naziv,
               COALESCE(NULLIF(BTRIM(w.drawing_number), ''), '') AS broj_crteza,
               0 AS nivo
          FROM work_orders w
         WHERE w.id = ${rootRn} AND w.project_id = ${projectId}`);
      if (r.length === 0) {
        throw new NotFoundException(
          `Koren RN ${rootRn} nije u strukturi predmeta ${projectId}.`,
        );
      }
      root = {
        node_id: r[0].node_id,
        naziv: r[0].naziv,
        broj_crteza: r[0].broj_crteza,
        tip: "sklop",
      };
    }

    // reparentNodes: primeni ručne structure-override-e u stablu (finding #7).
    const nodes = reparentNodes(await this.projectNodes(projectId, rootRn));
    const opsByWo = await this.fetchOperations(nodes.map((n) => n.rn_id));
    const today = todayStr();

    const rows = nodes.map((n) => {
      const ops = opsByWo.get(n.rn_id) ?? [];
      const finalOps = ops.filter((o) => o.is_final_control);
      const hasFinalLine = finalOps.length > 0;
      const komada = n.komada ?? null;
      // Auto završna kontrola = zbir dobrih (GOOD) otkucanih na ZAVRŠNIM operacijama.
      const zavrsenaAuto = hasFinalLine
        ? finalOps.reduce((s, o) => s + o.done_completed, 0)
        : null;
      // Override > auto (kompletirano→100%, manual_qty→zameni), klampovano na lansirano.
      const eff = effectiveCompleted(
        komada,
        zavrsenaAuto,
        n.status_override,
        n.manual_qty,
      );
      const zavrsena = eff.effective;
      // Efektivna mašinska/površinska: „kompletirano" implicira DA (docx §4.7), inače ručni
      // override ako je zadat, inače null (auto se prikazuje kroz *_status tekst polja).
      const masinskaDoneEff =
        n.masinska_done_ovr ??
        (n.status_override === "kompletirano" ? true : null);
      const povrsinskaDoneEff =
        n.povrsinska_done_ovr ??
        (n.status_override === "kompletirano" ? true : null);
      const requiredForLot =
        n.broj_komada != null && n.broj_komada > 0 ? n.broj_komada * lot : null;
      const rok = toDateStr(n.rok_izrade);
      const baseCrtez = n.broj_crteza
        ? n.broj_crteza.split("_")[0].trim() || null
        : null;
      const baseSklop = n.parent_broj_crteza
        ? n.parent_broj_crteza.split("_")[0].trim() || null
        : null;

      const machining = ops
        .filter((o) => o.without_process !== true)
        .slice(0, 4)
        .map(
          (o) =>
            `${o.work_center_name ?? o.work_center_code}: ${
              o.done > 0 ? "urađeno" : "otvoreno"
            }`,
        )
        .join("; ");
      const surface = ops
        .filter((o) => o.without_process === true && !o.is_final_control)
        .slice(0, 4)
        .map(
          (o) =>
            `${o.work_center_name ?? o.work_center_code}: ${
              o.done > 0 ? "urađeno" : "otvoreno"
            }`,
        )
        .join("; ");

      return {
        row_id: `${projectId}:${n.rn_id}`,
        node_id: n.rn_id,
        parent_node_id: n.parent_rn_id,
        level: n.nivo,
        sort_order: n.sort_order,
        tip_reda: "rn",
        naziv_pozicije: n.naziv_dela ?? n.ident_broj ?? "",
        broj_crteza: n.broj_crteza ?? "",
        broj_sklopnog_crteza: n.parent_broj_crteza ?? "",
        crtez_url: null,
        sklop_url: null,
        crtez_drawing_no: baseCrtez,
        sklop_drawing_no: baseSklop,
        has_crtez_file: n.has_crtez_file,
        // Pravi EXISTS(drawing_pdfs) preko roditeljskog čvora (finding #6), a ne truthiness
        // broja crteža; ostaje tačan i posle re-parenta (has_parent_crtez_file iz #7).
        has_skop_crtez_file: n.has_parent_crtez_file,
        rn_id: n.rn_id,
        rn_broj: n.ident_broj ?? "",
        qty_per_assembly:
          n.broj_komada != null && n.broj_komada > 0 ? n.broj_komada : null,
        lansirana_kolicina: komada,
        required_for_lot: requiredForLot,
        // zavrsena_kolicina = EFEKTIVNO (override>auto, klampovano); *_auto = sirovi ZK (dobar),
        // da JSON razlikuje auto od override (finding #2). null = nema ni ZK ni količ. override.
        zavrsena_kolicina: zavrsena,
        zavrsena_kolicina_auto: eff.auto,
        is_override_applied: eff.overridden,
        raspolozivo_za_montazu: zavrsena,
        kompletirano_za_lot:
          requiredForLot == null || zavrsena == null
            ? null
            : Math.min(zavrsena, requiredForLot),
        datum_lansiranja_tp: toDateStr(n.datum_unosa),
        datum_izrade: rok,
        masinska_obrada_status: machining || null,
        povrsinska_zastita_status: surface || null,
        materijal: n.materijal ?? "",
        dimenzije: n.dimenzija ?? "",
        sistemska_napomena: n.wo_napomena ?? "",
        korisnicka_napomena: n.korisnicka_napomena ?? "",
        status_override: n.status_override,
        masinska_done_override: n.masinska_done_ovr,
        povrsinska_done_override: n.povrsinska_done_ovr,
        // Efektivna mašinska/površinska (override ili „kompletirano"→DA; docx §4.7) — auto ostaje
        // vidljiv kroz *_status tekst, override kroz *_override; ovo je razrešena vrednost.
        masinska_done_efektivno: masinskaDoneEff,
        povrsinska_done_efektivno: povrsinskaDoneEff,
        // docx §4.6 (nova kolona 2.0): ručno „fizički urađeno a nije otkucano".
        manual_qty: n.manual_qty,
        has_parent_override: n.has_parent_override,
        parent_override_rn_id: n.parent_override_rn_id,
        statusi: {
          kasni: rok != null && rok < today && (zavrsena ?? 0) < (komada ?? 0),
          nema_tp: !n.broj_crteza,
          nema_crtez: !n.has_crtez_file,
          nema_zavrsnu_kontrolu: !hasFinalLine,
          nije_kompletirano: komada != null && (zavrsena ?? 0) < komada,
          nema_rn: false,
        },
        operations: ops.map((o) => this.izvestajOp(o, komada)),
      };
    });

    const summary = {
      total_rows: rows.length,
      total_lansirano: rows.reduce(
        (s, r) => s + Number(r.lansirana_kolicina ?? 0),
        0,
      ),
      total_zavrseno: rows.reduce(
        (s, r) => s + (r.zavrsena_kolicina == null ? 0 : r.zavrsena_kolicina),
        0,
      ),
      count_nije_kompletirano: rows.filter((r) => r.statusi.nije_kompletirano)
        .length,
      count_nema_tp: rows.filter((r) => r.statusi.nema_tp).length,
      count_nema_crtez: rows.filter((r) => r.statusi.nema_crtez).length,
      count_nema_zavrsnu_kontrolu: rows.filter(
        (r) => r.statusi.nema_zavrsnu_kontrolu,
      ).length,
      count_kasni: rows.filter((r) => r.statusi.kasni).length,
    };

    return {
      data: {
        predmet: {
          item_id: p.item_id,
          broj_predmeta: p.broj_predmeta ?? "",
          naziv_predmeta: p.naziv_predmeta ?? "",
          komitent: p.komitent,
          rok_zavrsetka: toDateStr(p.rok_zavrsetka),
        },
        root,
        lot_qty: lot,
        generated_at: generatedAt,
        rows,
        summary,
      },
    };
  }

  // ==========================================================================
  // RN
  // ==========================================================================

  /**
   * Razrešavanje RN reference → 2.0 `work_orders.id` (Int). uuid (legacy 1.0) se
   * prihvata graciozno: nema mapiranja u 2.0, vraća se 422-semantika (BadRequest),
   * ne 500. Numerički ref = id ili ident_number; tekst = ident_number ILIKE.
   */
  async rnResolve(_email: string, ref: string) {
    const qv = (ref ?? "").trim();
    if (!qv) throw new BadRequestException("Unesi RN broj ili RN id.");
    if (
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(qv)
    ) {
      throw new BadRequestException(
        `Legacy UUID RN reference "${qv}" nije podržan u 2.0 — koristi RN broj (ident) ili numerički id.`,
      );
    }
    const like = `%${qv}%`;
    const numeric = /^\d+$/.test(qv) && Number(qv) <= 2147483647;
    const rows = await this.prisma.$queryRaw<{ id: number }[]>(Prisma.sql`
      SELECT id::int AS id FROM work_orders
       WHERE ident_number = ${qv} OR ident_number ILIKE ${like}
         ${numeric ? Prisma.sql`OR id = ${Number(qv)}` : Prisma.empty}
       ORDER BY ident_number ASC, variant ASC LIMIT 5`);
    if (rows.length === 1) return { data: { id: rows[0].id } };
    if (rows.length > 1) {
      throw new BadRequestException(
        `Nađeno je više RN-ova za "${qv}". Unesi tačan RN broj ili id.`,
      );
    }
    throw new BadRequestException(
      `RN "${qv}" nije pronađen u proizvodnji. Proveri RN broj/id.`,
    );
  }

  /** RN pregled (pozicije = RN + komponentni RN-ovi; paritet get_pracenje_rn). */
  async rn(_email: string, rnId: number) {
    const head = await this.prisma.$queryRaw<
      {
        radni_nalog_id: number;
        rn_broj: string | null;
        projekat_id: number | null;
        projekat_naziv: string | null;
        kupac: string | null;
        datum_isporuke: Date | null;
        napomena: string | null;
        naziv: string | null;
      }[]
    >(Prisma.sql`
      SELECT w.id::int AS radni_nalog_id,
             NULLIF(BTRIM(w.ident_number), '') AS rn_broj,
             NULLIF(w.project_id, 0)::int AS projekat_id,
             p.project_name AS projekat_naziv,
             COALESCE(NULLIF(BTRIM(c.name), ''), NULLIF(BTRIM(w.external_project_name), '')) AS kupac,
             w.production_deadline AS datum_isporuke,
             NULLIF(BTRIM(w.note), '') AS napomena,
             COALESCE(NULLIF(BTRIM(w.part_name), ''), w.ident_number) AS naziv
        FROM work_orders w
        LEFT JOIN projects p ON p.id = w.project_id
        LEFT JOIN customers c ON c.id = w.external_customer_id
       WHERE w.id = ${rnId}`);
    if (head.length === 0) {
      throw new NotFoundException(`Radni nalog ${rnId} ne postoji.`);
    }
    const h = head[0];

    const nodes = await this.prisma.$queryRaw<RnNodeRow[]>(Prisma.sql`
      WITH RECURSIVE struktura AS (
        SELECT wo.id AS rn_id, NULL::int AS parent_rn_id, 0 AS nivo, ARRAY[wo.id] AS path_idrn
          FROM work_orders wo WHERE wo.id = ${rnId}
        UNION ALL
        SELECT c.component_work_order_id, s.rn_id, s.nivo + 1, s.path_idrn || c.component_work_order_id
          FROM struktura s
          JOIN work_order_components c ON c.work_order_id = s.rn_id
         WHERE s.nivo < ${MAX_DEPTH}
           AND NOT (c.component_work_order_id = ANY (s.path_idrn))
      ),
      dedup AS (SELECT DISTINCT ON (rn_id) * FROM struktura ORDER BY rn_id, nivo)
      SELECT d.rn_id::int AS rn_id, d.parent_rn_id::int AS parent_rn_id,
             d.nivo::int AS nivo, d.path_idrn AS path_idrn,
             NULLIF(BTRIM(w.ident_number), '') AS ident_broj,
             NULLIF(BTRIM(w.part_name), '') AS naziv_dela,
             w.piece_count::int AS komada,
             NULLIF(BTRIM(split_part(w.drawing_number, '_', 1)), '') AS drawing_no,
             EXISTS (
               SELECT 1 FROM drawing_pdfs dp
               WHERE dp.drawing_number = NULLIF(BTRIM(split_part(w.drawing_number, '_', 1)), '')
             ) AS has_crtez_file
        FROM dedup d
        JOIN work_orders w ON w.id = d.rn_id
       ORDER BY d.nivo, w.ident_number ASC NULLS LAST`);

    const opsByWo = await this.fetchOperations(nodes.map((n) => n.rn_id));

    let opTotal = 0;
    let opNije = 0;
    let opTok = 0;
    let opZav = 0;
    const positions = nodes.map((n) => {
      const ops = (opsByWo.get(n.rn_id) ?? []).map((o) =>
        this.rnOp(o, n.komada, n.rn_id),
      );
      opTotal += ops.length;
      for (const o of ops) {
        if (o.status === "zavrseno") opZav += 1;
        else if (o.status === "u_toku") opTok += 1;
        else opNije += 1;
      }
      const pcts = ops.map((o) => o._pct);
      const progress =
        pcts.length > 0
          ? Math.round(pcts.reduce((s, v) => s + v, 0) / pcts.length)
          : 0;
      return {
        id: n.rn_id,
        parent_id: n.parent_rn_id,
        sifra_pozicije: n.ident_broj,
        naziv: n.naziv_dela ?? n.ident_broj,
        kolicina_plan: n.komada,
        progress_pct: progress,
        drawing_no: n.drawing_no,
        has_crtez_file: n.has_crtez_file,
        operations: ops.map(({ _pct, ...rest }) => rest),
        children: [] as unknown[],
      };
    });

    // Završna kontrola (KK) za KOREN RN — sum otkucanih završnih operacija,
    // clamped to the launched quantity (consistent with izvestaj/portfolio).
    const rootOps = opsByWo.get(rnId) ?? [];
    const rootFinal = rootOps.filter((o) => o.is_final_control);
    const rootNode = nodes.find((n) => n.rn_id === rnId);
    const zavrsenaKkRaw = rootFinal.length
      ? rootFinal.reduce((s, o) => s + o.done_completed, 0)
      : null;
    const zavrsenaKk =
      zavrsenaKkRaw != null && rootNode?.komada != null
        ? Math.min(zavrsenaKkRaw, rootNode.komada)
        : zavrsenaKkRaw;

    return {
      data: {
        header: {
          radni_nalog_id: h.radni_nalog_id,
          rn_broj: h.rn_broj,
          projekat_id: h.projekat_id,
          projekat_naziv: h.projekat_naziv,
          kupac: h.kupac,
          datum_isporuke: toDateStr(h.datum_isporuke),
          koordinator: null,
          napomena: h.napomena,
          masina_linija: h.naziv,
          radni_nalog_naziv: h.naziv,
        },
        source: "local",
        summary: {
          pozicija_total: nodes.length,
          operacija_total: opTotal,
          nije_krenulo: opNije,
          u_toku: opTok,
          zavrseno: opZav,
          blokirano: 0,
          lansirana_kolicina: rootNode?.komada ?? null,
          zavrsena_kolicina_kk: zavrsenaKk,
        },
        positions,
      },
    };
  }

  /**
   * Operativni plan RN-a (Tab2) — nad novom 2.0 tabelom `operativne_aktivnosti`
   * (prazna dok se ne migrira iz sy15). Mutacije aktivnosti su i dalje na sy15
   * (radi ih sledeći agent) — ovaj READ već čita 2.0 (plan §3.3).
   */
  async operativniPlan(
    _email: string,
    rnId: number,
    _q: OperativniPlanQueryDto,
  ) {
    const wo = await this.prisma.workOrder.findUnique({
      where: { id: rnId },
      select: {
        id: true,
        projectId: true,
        identNumber: true,
        partName: true,
        productionDeadline: true,
        note: true,
        externalProjectName: true,
      },
    });

    const acts = await this.prisma.operativnaAktivnost.findMany({
      where: { workOrderId: rnId },
      include: { odeljenje: true },
      orderBy: [{ odeljenje: { name: "asc" } }, { rb: "asc" }],
    });

    const today = todayStr();
    const activities = acts.map((a) => {
      const kasni =
        a.planiraniZavrsetak != null &&
        toDateStr(a.planiraniZavrsetak)! < today &&
        a.status !== "zavrseno";
      return {
        id: a.id,
        rb: a.rb,
        odeljenje: a.odeljenje?.name ?? null,
        naziv_aktivnosti: a.nazivAktivnosti,
        broj_tp: a.brojTp,
        kolicina_text: a.kolicinaText,
        planirani_pocetak: toDateStr(a.planiraniPocetak),
        planirani_zavrsetak: toDateStr(a.planiraniZavrsetak),
        odgovoran: a.odgovoranLabel,
        zavisi_od: a.zavisiOdText,
        efektivni_status: a.status,
        status_is_auto: a.statusMode !== "manual",
        status_detail: null,
        prioritet: a.prioritet,
        rizik_napomena: a.rizikNapomena,
        rezerva_dani: null,
        kasni,
      };
    });

    const count = (s: string) =>
      activities.filter((a) => a.efektivni_status === s).length;
    const byDept = new Map<
      string,
      {
        odeljenje: string;
        ukupno: number;
        zavrseno: number;
        u_toku: number;
        blokirano: number;
        nije_krenulo: number;
      }
    >();
    for (const a of activities) {
      const key = a.odeljenje ?? "—";
      const d = byDept.get(key) ?? {
        odeljenje: key,
        ukupno: 0,
        zavrseno: 0,
        u_toku: 0,
        blokirano: 0,
        nije_krenulo: 0,
      };
      d.ukupno += 1;
      if (a.efektivni_status === "zavrseno") d.zavrseno += 1;
      else if (a.efektivni_status === "u_toku") d.u_toku += 1;
      else if (a.efektivni_status === "blokirano") d.blokirano += 1;
      else d.nije_krenulo += 1;
      byDept.set(key, d);
    }

    return {
      data: {
        header: {
          radni_nalog_id: rnId,
          projekat_id: wo?.projectId ?? null,
          kupac: wo?.externalProjectName ?? null,
          rn_broj: wo?.identNumber ?? null,
          masina_linija: wo?.partName ?? null,
          datum_isporuke: toDateStr(wo?.productionDeadline ?? null),
          koordinator: null,
          napomena: wo?.note ?? null,
        },
        activities,
        dashboard: {
          total: {
            ukupno: activities.length,
            zavrseno: count("zavrseno"),
            u_toku: count("u_toku"),
            blokirano: count("blokirano"),
            nije_krenulo: count("nije_krenulo"),
          },
          po_odeljenjima: [...byDept.values()].sort((x, y) =>
            x.odeljenje.localeCompare(y.odeljenje),
          ),
        },
      },
    };
  }

  /**
   * FE gate — da li korisnik sme da edituje praćenje. 2.0 nema sy15
   * `can_edit_pracenje` (row-RLS); odluka je permisija `pracenje.edit`
   * (row-scope po projektu je izostavljen — svesno uprošćeno u odnosu na 1.0).
   */
  async canEdit(user: { userId: number; role: string }, _rnId: number) {
    const decision = await resolvePermissionDecision(
      this.prisma,
      user.userId,
      user.role,
      PERMISSIONS.PRACENJE_EDIT,
    );
    return { data: { canEdit: decision === "allow" } };
  }

  /**
   * Istorija aktivnosti — blokade (2.0 `operativne_aktivnosti_blokade`) za sve; audit
   * deo (`audit_log`) je ADMIN-only (paritet dosadašnje sy15 RLS vidljivosti izvoza/
   * izmena — task F1). Nedovoljna rola dobija prazan `audit: []` (blokade i dalje vidi).
   */
  async aktivnostIstorija(user: { role: string }, id: number) {
    const blokade = await this.prisma.operativnaAktivnostBlokada.findMany({
      where: { aktivnostId: id },
      orderBy: { blockedAt: "desc" },
    });
    const audit =
      user.role === ROLES.ADMIN
        ? await this.prisma.auditLog.findMany({
            where: { entityType: "operativna_aktivnost", entityId: String(id) },
            orderBy: { createdAt: "desc" },
            take: 500,
          })
        : [];
    return { data: { blokade: jsonSafe(blokade), audit: jsonSafe(audit) } };
  }

  // ==========================================================================
  // Prijave rada / lookups / pretraga
  // ==========================================================================

  /**
   * Prijave rada za operaciju (RN side-panel) — 2.0 `work_time_entries` po
   * RN + operaciji (plan §3.1; START/STOP sesije). Query po workOrder+op(+machine).
   */
  async prijave(_email: string, q: PrijaveQueryDto) {
    // Mrtva grana „samo-pozicija" (finding #5): 1.0 je prijave zvao i bez operacije; 2.0 prijave
    // sede na work_time_entries po RN+operaciji, pa bez oba parametra nema šta da se vrati. FE i
    // dalje okida taj poziv → vrati prazan skup umesto 400 (da ne prijavljuje lažnu grešku).
    if (!q.workOrder || !q.op) {
      return { data: [], meta: { source: "local" } };
    }
    const wo = Number(q.workOrder);
    const op = Number(q.op);
    const machine = q.machine ?? null;
    const rows = await this.prisma.workTimeEntry.findMany({
      where: {
        workOrderId: wo,
        operationNumber: op,
        ...(machine ? { workCenterCode: machine } : {}),
      },
      include: { worker: true },
      orderBy: { startedAt: "asc" },
    });
    const data = rows.map((r) => ({
      id: r.id,
      datum: r.stoppedAt ?? r.startedAt,
      radnik:
        r.worker?.fullName?.trim() ||
        r.worker?.username?.trim() ||
        String(r.workerId),
      kolicina: r.pieceCount,
      is_completed: r.stoppedAt != null,
      napomena: r.note ?? "",
    }));
    return { data, meta: { source: "work_time_entries" } };
  }

  /** Šifarnik odeljenja (nova 2.0 tabela `odeljenja`). */
  async odeljenja(_email: string) {
    const rows = await this.prisma.odeljenje.findMany({
      where: { active: true },
      orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
    });
    const data = rows.map((o) => ({
      id: o.id,
      kod: o.code,
      naziv: o.name,
      boja: o.color,
      sort_order: o.sortOrder,
      aktivan: o.active,
      vodja_user_id: o.leadUserId,
      vodja_radnik_id: o.leadWorkerId,
    }));
    return { data };
  }

  /**
   * Šifarnik radnika — 2.0 `workers`. Mapiranje na 1.0 oblik je približno
   * (workers nema odeljenje/employee_id/email posebno): ime/puno_ime=full_name,
   * sifra_radnika=id_number, email=login_account, odeljenje_id=null.
   */
  async radnici(_email: string) {
    const rows = await this.prisma.worker.findMany({
      where: { active: true },
      orderBy: [{ fullName: "asc" }, { username: "asc" }],
      select: {
        id: true,
        fullName: true,
        idNumber: true,
        loginAccount: true,
        active: true,
      },
    });
    const data = rows.map((w) => ({
      id: w.id,
      employee_id: null,
      odeljenje_id: null,
      sifra_radnika: w.idNumber,
      ime: w.fullName,
      puno_ime: w.fullName,
      email: w.loginAccount,
      aktivan: w.active,
    }));
    return { data };
  }

  /** Pretraga delova/pozicija (paritet search_proizvodnja_delovi) — min 2 znaka, nad 2.0. */
  async searchDelovi(_email: string, q?: string) {
    const query = (q ?? "").trim();
    if (query.length < 2) return { data: [] };
    const like = `%${query.replace(/[%_\\]/g, (m) => "\\" + m)}%`;
    const rows = await this.prisma.$queryRaw<
      {
        rn_id: number;
        bigtehn_work_order_id: number;
        rn_broj: string | null;
        rn_status: string;
        lansiran: boolean;
        datum_isporuke: Date | null;
        naziv: string | null;
        drawing_no: string | null;
        revision: string | null;
        tp: string | null;
      }[]
    >(Prisma.sql`
      SELECT w.id::int AS rn_id,
             w.id::int AS bigtehn_work_order_id,
             NULLIF(BTRIM(w.ident_number), '') AS rn_broj,
             CASE WHEN w.status IS TRUE THEN 'zavrsen' ELSE 'aktivan' END AS rn_status,
             true AS lansiran,
             w.production_deadline AS datum_isporuke,
             COALESCE(NULLIF(BTRIM(w.part_name), ''), BTRIM(w.ident_number)) AS naziv,
             NULLIF(BTRIM(w.drawing_number), '') AS drawing_no,
             NULLIF(BTRIM(w.revision), '') AS revision,
             (
               SELECT string_agg(DISTINCT (op.operation_number::text || ' ' || COALESCE(NULLIF(BTRIM(op.work_description), ''), '')), ', ')
                 FROM work_order_operations op WHERE op.work_order_id = w.id
             ) AS tp
        FROM work_orders w
       WHERE w.ident_number ILIKE ${like}
          OR w.drawing_number ILIKE ${like}
          OR w.part_name ILIKE ${like}
          OR EXISTS (
               SELECT 1 FROM work_order_operations op
                WHERE op.work_order_id = w.id
                  AND (op.work_description ILIKE ${like} OR op.operation_number::text ILIKE ${like})
             )
       ORDER BY w.production_deadline ASC NULLS LAST, w.ident_number ASC
       LIMIT 100`);
    const data = rows.map((r) => ({
      rn_id: r.rn_id,
      bigtehn_work_order_id: r.bigtehn_work_order_id,
      source: "mes",
      rn_broj: r.rn_broj,
      rn_status: r.rn_status,
      lansiran: r.lansiran,
      datum_isporuke: toDateStr(r.datum_isporuke),
      koordinator: null,
      pozicija_id: null,
      sifra_pozicije: null,
      naziv: r.naziv,
      drawing_no: r.drawing_no,
      revision: r.revision,
      tp: r.tp,
    }));
    return { data };
  }

  /** ⭐ plan-prioritet (nova 2.0 tabela `predmet_aktivacije.plan_priority`). */
  async planPrioritet(_email: string) {
    const rows = await this.prisma.$queryRaw<
      { ids: number[] | null; max: number | null }[]
    >(Prisma.sql`
      SELECT array_agg(project_id ORDER BY plan_priority) FILTER (WHERE plan_priority IS NOT NULL) AS ids,
             max(plan_priority)::int AS max
        FROM predmet_aktivacije
       WHERE is_active IS TRUE`);
    const r = rows[0];
    return {
      data: {
        ids: (r?.ids ?? []).map((x) => Number(x)),
        max: r?.max ?? null,
        // 2.0 nema snapshot prethodne top-liste (sy15 predmet_plan_prioritet_prev) — TODO F-migracija.
        prev: null,
      },
    };
  }

  /**
   * Crtež PDF za RN side-panel — 2.0 `drawings`/`drawing_pdfs` (po broju crteža).
   * Odluka O7: SVI prijavljeni vide crtež u praćenju (bez PDM_READ gate-a). Vraća URL ka
   * PRAĆENJE-scoped content ruti `GET /api/v1/pracenje/crtez/:drawingId/pdf/content`
   * (gate `pracenje.read`, streamuje PDF) — NE ka PDM ruti (`/api/v1/pdm/drawings/...`,
   * koja nosi PDM_READ i prekršila bi O7; pogon bez PDM_READ bi dobio 403). Finding #8:
   * ruta je ugovorena sa agentom koji je pravi. Oblik `{ url, expiresIn }`; `expiresIn: 0`
   * = ruta je auth-gated (nema potpisa/TTL-a, autorizacija ide kroz JWT + `pracenje.read`).
   */
  async crtezSignUrl(_email: string, code: string) {
    const clean = sanitizeDrawingNo(code);
    if (!clean) throw new BadRequestException("Neispravan broj crteža.");
    const base = clean.split("_")[0].trim() || clean;
    const d = await this.prisma.drawing.findFirst({
      where: { OR: [{ drawingNumber: clean }, { drawingNumber: base }] },
      orderBy: [{ drawingNumber: "desc" }, { revision: "desc" }],
      select: { id: true },
    });
    if (!d) throw new NotFoundException(`Crtež ${clean} nije pronađen.`);
    return {
      data: {
        url: `/api/v1/pracenje/crtez/${d.id}/pdf/content`,
        expiresIn: 0,
      },
    };
  }

  /**
   * „Materijalizuj RN iz BigTehn-a" — u 2.0 je trivijalno: RN već postoji
   * (`work_orders.id` = prosleđeni id). Ruta se zadržava (FE ugovor), samo se
   * potvrdi postojanje i vrati id (bez ijednog sy15 poziva).
   */
  async ensureRnFromBigtehn(workOrderId: string) {
    const id = Number(workOrderId);
    const wo = await this.prisma.workOrder.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!wo) throw new NotFoundException(`Radni nalog ${id} ne postoji.`);
    return { data: { id: wo.id } };
  }

  // ==========================================================================
  // interni helperi
  // ==========================================================================

  /**
   * SQL fragment: da li je operacija ZAVRŠNA kontrola (finding #1a). Kanon iz tech-processes
   * (`control()` / `markWorkOrderIfComplete`): završna kontrola = `operations.significant_for_finishing`.
   * MEĐUFAZNA kontrola (npr. „8.4 Međufazna Kontrola", `significant_for_finishing=false`) NAMERNO
   * NE ulazi — ranija heuristika (`work_center_code LIKE '8.3%'` ili naziv ~ „kontrol") ju je hvatala,
   * pa su se njena kucanja sabirala u „završeno" (kk_pct > 100, prevremeno „zavrseno", lažno
   * `nema_zavrsnu_kontrolu=false`). `o` je LEFT JOIN operations; RC van kataloga → false.
   */
  private finalControlSql(): Prisma.Sql {
    return Prisma.sql`COALESCE(o.significant_for_finishing, false)`;
  }

  /**
   * Struktura predmeta (WITH RECURSIVE nad `work_order_components`) sa anti-ciklus
   * guardom (path array + depth cap). Anchor = koreni predmeta (RN-ovi koji nisu
   * komponenta drugog RN-a istog predmeta) ILI jedan RN (rootRn) za pod-stablo.
   */
  private projectNodes(
    projectId: number,
    rootRn: number | null,
  ): Promise<ProjectNodeRow[]> {
    const anchor =
      rootRn != null
        ? Prisma.sql`
            SELECT wo.id AS rn_id, NULL::int AS parent_rn_id, wo.id AS root_rn_id,
                   0 AS nivo, 1 AS broj_komada, ARRAY[wo.id] AS path_idrn
              FROM work_orders wo
             WHERE wo.id = ${rootRn} AND wo.project_id = ${projectId}`
        : Prisma.sql`
            SELECT wo.id AS rn_id, NULL::int AS parent_rn_id, wo.id AS root_rn_id,
                   0 AS nivo, 1 AS broj_komada, ARRAY[wo.id] AS path_idrn
              FROM work_orders wo
             WHERE wo.project_id = ${projectId}
               AND NOT EXISTS (
                 SELECT 1 FROM work_order_components c
                   JOIN work_orders pp ON pp.id = c.work_order_id
                  WHERE c.component_work_order_id = wo.id AND pp.project_id = ${projectId}
               )`;

    return this.prisma.$queryRaw<ProjectNodeRow[]>(Prisma.sql`
      WITH RECURSIVE struktura AS (
        ${anchor}
        UNION ALL
        SELECT c.component_work_order_id, s.rn_id, s.root_rn_id, s.nivo + 1,
               c.quantity, s.path_idrn || c.component_work_order_id
          FROM struktura s
          JOIN work_order_components c ON c.work_order_id = s.rn_id
         WHERE s.nivo < ${MAX_DEPTH}
           AND NOT (c.component_work_order_id = ANY (s.path_idrn))
      ),
      dedup AS (SELECT DISTINCT ON (rn_id) * FROM struktura ORDER BY rn_id, nivo)
      SELECT d.rn_id::int AS rn_id, d.parent_rn_id::int AS parent_rn_id,
             d.root_rn_id::int AS root_rn_id, d.nivo::int AS nivo,
             d.broj_komada::int AS broj_komada, d.path_idrn AS path_idrn,
             NULLIF(BTRIM(w.ident_number), '') AS ident_broj,
             NULLIF(BTRIM(w.drawing_number), '') AS broj_crteza,
             NULLIF(BTRIM(w.part_name), '') AS naziv_dela,
             NULLIF(BTRIM(w.material), '') AS materijal,
             NULLIF(BTRIM(w.material_dimension), '') AS dimenzija,
             w.piece_count::int AS komada,
             w.production_deadline AS rok_izrade,
             w.status AS status_rn,
             w.entered_at AS datum_unosa,
             NULLIF(BTRIM(w.note), '') AS wo_napomena,
             NULLIF(BTRIM(pw.drawing_number), '') AS parent_broj_crteza,
             EXISTS (
               SELECT 1 FROM drawing_pdfs dp
               WHERE dp.drawing_number = NULLIF(BTRIM(split_part(w.drawing_number, '_', 1)), '')
             ) AS has_crtez_file,
             nap.note AS korisnicka_napomena,
             ovr.manual_status AS status_override,
             ovr.manual_machining AS masinska_done_ovr,
             ovr.manual_surface AS povrsinska_done_ovr,
             ovr.manual_qty::int AS manual_qty,
             (po.work_order_id IS NOT NULL) AS has_parent_override,
             po.parent_work_order_id::int AS parent_override_rn_id,
             row_number() OVER (
               PARTITION BY d.parent_rn_id, d.root_rn_id
               ORDER BY w.ident_number ASC NULLS LAST
             )::int AS sort_order
        FROM dedup d
        JOIN work_orders w ON w.id = d.rn_id
        LEFT JOIN work_orders pw ON pw.id = d.parent_rn_id
        LEFT JOIN pracenje_notes nap ON nap.project_id = ${projectId} AND nap.work_order_id = d.rn_id
        LEFT JOIN pracenje_overrides ovr ON ovr.work_order_id = d.rn_id
        LEFT JOIN pracenje_structure_overrides po ON po.work_order_id = d.rn_id
       ORDER BY d.root_rn_id, d.path_idrn`);
  }

  /** Per-node metrika za portfolio rollup (komada, završeno KK, has_final/crtez, op ratio). */
  private projectNodeMetrics(projectId: number): Promise<MetricRow[]> {
    return this.prisma.$queryRaw<MetricRow[]>(Prisma.sql`
      WITH RECURSIVE struktura AS (
        SELECT wo.id AS rn_id, 0 AS nivo, ARRAY[wo.id] AS path_idrn
          FROM work_orders wo
         WHERE wo.project_id = ${projectId}
           AND NOT EXISTS (
             SELECT 1 FROM work_order_components c
               JOIN work_orders pp ON pp.id = c.work_order_id
              WHERE c.component_work_order_id = wo.id AND pp.project_id = ${projectId}
           )
        UNION ALL
        SELECT c.component_work_order_id, s.nivo + 1, s.path_idrn || c.component_work_order_id
          FROM struktura s
          JOIN work_order_components c ON c.work_order_id = s.rn_id
         WHERE s.nivo < ${MAX_DEPTH}
           AND NOT (c.component_work_order_id = ANY (s.path_idrn))
      ),
      dedup AS (SELECT DISTINCT ON (rn_id) rn_id FROM struktura ORDER BY rn_id, nivo)
      SELECT w.id::int AS rn_id,
             w.piece_count::int AS komada,
             NULLIF(BTRIM(w.drawing_number), '') AS broj_crteza,
             w.production_deadline AS rok_izrade,
             EXISTS (
               SELECT 1 FROM drawing_pdfs dp
               WHERE dp.drawing_number = NULLIF(BTRIM(split_part(w.drawing_number, '_', 1)), '')
             ) AS has_crtez,
             fc.has_final,
             fc.zavrsena::int AS zavrsena,
             opr.op_ratio_sum::float8 AS op_ratio_sum,
             opr.op_count::int AS op_count,
             ovr.manual_status AS status_override,
             ovr.manual_qty::int AS manual_qty
        FROM dedup d
        JOIN work_orders w ON w.id = d.rn_id
        LEFT JOIN pracenje_overrides ovr ON ovr.work_order_id = w.id
        LEFT JOIN LATERAL (
          SELECT bool_or(x.isf) AS has_final,
                 sum(x.done_completed) FILTER (WHERE x.isf) AS zavrsena
          FROM (
            SELECT ${this.finalControlSql()} AS isf,
                   -- Gotovost = DOBAR (GOOD) otkucano na završnoj kontroli (finding #3);
                   -- škart/dorada se NE broje. Klamp na lansirano radi se u JS (efektivno).
                   COALESCE((
                     SELECT sum(t.piece_count) FILTER (
                              WHERE t.is_process_finished AND t.quality_type_id = ${QUALITY_GOOD}
                            )
                       FROM tech_processes t
                      WHERE t.work_order_id = op.work_order_id
                        AND t.operation_number = op.operation_number
                        AND t.work_center_code IS NOT DISTINCT FROM op.work_center_code
                   ), 0) AS done_completed
              FROM work_order_operations op
              LEFT JOIN operations o ON o.work_center_code = op.work_center_code
             WHERE op.work_order_id = w.id
          ) x
        ) fc ON true
        LEFT JOIN LATERAL (
          -- op_pct = prosečan operativni napredak; piece_count=0 RN daje NULL imenilac
          -- (NULLIF) → izbaci ga i iz brojioca i iz imenioca (FILTER), inače razblažuje % (finding #3).
          SELECT sum(LEAST(d2.done::numeric / NULLIF(w.piece_count, 0), 1))
                   FILTER (WHERE w.piece_count > 0) AS op_ratio_sum,
                 count(*) FILTER (WHERE w.piece_count > 0) AS op_count
          FROM work_order_operations op2
          LEFT JOIN LATERAL (
            SELECT COALESCE(
                     sum(t.piece_count) FILTER (WHERE t.quality_type_id = ${QUALITY_GOOD}), 0
                   ) AS done
              FROM tech_processes t
             WHERE t.work_order_id = op2.work_order_id
               AND t.operation_number = op2.operation_number
               AND t.work_center_code IS NOT DISTINCT FROM op2.work_center_code
          ) d2 ON true
         WHERE op2.work_order_id = w.id
        ) opr ON true`);
  }

  /** Operacije (routing) + agregat kucanja za dati skup RN-ova → Map po work_order_id. */
  private async fetchOperations(ids: number[]): Promise<Map<number, OpRow[]>> {
    const map = new Map<number, OpRow[]>();
    if (ids.length === 0) return map;
    const rows = await this.prisma.$queryRaw<OpRow[]>(Prisma.sql`
      SELECT op.work_order_id::int AS work_order_id,
             op.id::int AS op_id,
             op.operation_number::int AS operation_number,
             op.work_center_code AS work_center_code,
             NULLIF(BTRIM(op.work_description), '') AS work_description,
             NULLIF(BTRIM(op.tools_fixtures), '') AS tools_fixtures,
             op.priority::int AS priority,
             o.work_center_name AS work_center_name,
             o.without_process AS without_process,
             ${this.finalControlSql()} AS is_final_control,
             COALESCE(tr.done, 0)::int AS done,
             COALESCE(tr.done_completed, 0)::int AS done_completed,
             tr.last_at AS last_at,
             tr.last_completed_at AS last_completed_at
        FROM work_order_operations op
        LEFT JOIN operations o ON o.work_center_code = op.work_center_code
        LEFT JOIN LATERAL (
          -- Gotovost broji SAMO DOBAR (GOOD) — škart/dorada se ne broje kao urađeno (finding #3,
          -- kanon tech-processes PART_QUALITY). done = dobar throughput, done_completed =
          -- dobar + završen (ZK). last_at = poslednja aktivnost bilo kog kvaliteta (informativno);
          -- last_completed_at = poslednji DOBAR završetak (datum završetka operacije, docx §4.9).
          SELECT sum(t.piece_count) FILTER (WHERE t.quality_type_id = ${QUALITY_GOOD}) AS done,
                 sum(t.piece_count) FILTER (
                   WHERE t.is_process_finished AND t.quality_type_id = ${QUALITY_GOOD}
                 ) AS done_completed,
                 max(COALESCE(t.finished_at, t.entered_at)) AS last_at,
                 max(t.finished_at) FILTER (
                   WHERE t.is_process_finished AND t.quality_type_id = ${QUALITY_GOOD}
                 ) AS last_completed_at
            FROM tech_processes t
           WHERE t.work_order_id = op.work_order_id
             AND t.operation_number = op.operation_number
             AND t.work_center_code IS NOT DISTINCT FROM op.work_center_code
        ) tr ON true
       WHERE op.work_order_id IN (${Prisma.join(ids)})
       ORDER BY op.work_order_id, op.priority ASC, op.id ASC`);
    for (const r of rows) {
      const arr = map.get(r.work_order_id);
      if (arr) arr.push(r);
      else map.set(r.work_order_id, [r]);
    }
    return map;
  }

  /** Operacija za izveštaj-tabelu (paritet line_agg operations[]). */
  private izvestajOp(o: OpRow, komada: number | null) {
    return {
      operation_id: String(o.op_id),
      redosled: o.priority,
      naziv: String(o.operation_number),
      masina: o.work_center_name ?? o.work_center_code,
      opis_rada: o.work_description ?? "",
      alat_pribor: o.tools_fixtures ?? "",
      planned_qty: komada,
      completed_qty: o.done,
      completed_at: o.last_completed_at,
      is_final_control: o.is_final_control,
      kontrola_status: o.is_final_control
        ? o.done_completed > 0
          ? "urađeno"
          : "nije prijavljeno"
        : "",
    };
  }

  /** Operacija za RN pregled (paritet get_pracenje_rn op_payload) + _pct za rollup. */
  private rnOp(o: OpRow, planned: number | null, woId: number) {
    const p = planned ?? 0;
    let status: string;
    if (p > 0 && o.done_completed >= p) status = "zavrseno";
    else if (o.done > 0) status = "u_toku";
    else status = "nije_krenulo";
    const pct =
      p > 0
        ? Math.min(100, Math.round((100 * o.done) / p))
        : o.done_completed > 0
          ? 100
          : 0;
    return {
      tp_operacija_id: `op-${o.op_id}`,
      operacija_kod: String(o.operation_number),
      naziv: o.work_center_name ?? o.work_center_code,
      work_center: o.work_center_code,
      planirano_komada: planned,
      prijavljeno_komada: o.done,
      status,
      poslednja_prijava_at: o.last_at,
      is_final_control: o.is_final_control,
      source: "mes",
      bigtehn_work_order_id: woId,
      operacija_broj: o.operation_number,
      machine_code: o.work_center_code,
      _pct: pct,
    };
  }
}
