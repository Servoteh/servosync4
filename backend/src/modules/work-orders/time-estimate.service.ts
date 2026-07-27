import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";

/**
 * TALAS AI-5 — statistička procena vremena operacija po radnom mestu.
 *
 * NIJE LLM: čista statistika/SQL nad proizvodnim jezgrom. Tehnologu koji gleda
 * operaciju (ili planira nalog) pokazuje KOLIKO SLIČNI POSLOVI STVARNO TRAJU na
 * tom radnom mestu — kao interval sa uzorkom („2,1–3,4 h/kom, n=412, med 2,6") —
 * plus lookup „ovaj isti crtež je ranije rađen: N naloga". BEZ automatske izmene
 * normativa: samo prikaz/predlog (plan §2.2, nivo 2 autonomije, human-in-the-loop).
 *
 * ── IZVOR STVARNOG VREMENA: `tech_processes`, NE `work_time_entries` ──────────
 * Alat `istorija_crteza` (Talas AI-1, `ai-chat/tools/core-tools.ts`) je uspostavio
 * ISPRAVAN SPOJ plan-vs-stvarno: obe strane se agregiraju SIMETRIČNO — prvo zbir
 * PO NALOGU I RADNOM MESTU, pa tek onda raspon po radnom mestu (review nalaz 19),
 * uz filter šuma <1 min. TU LOGIKU ovde ponavljamo verbatim.
 *
 * Menjamo SAMO tabelu iz koje dolazi stvarno vreme. `work_time_entries` je NOVI
 * 2.0 „dva skena" ledger i na produkciji ima ~950 redova (kiosk je tek zaživeo) —
 * na njemu bi procena bila prazna. Istorijskih ~99.000 prijava rada (2016→danas)
 * živi u legacy `tech_processes` (`entered_at` = početak, `finished_at` = kraj),
 * odakle i dolaze brojke iz plana §2.2 (22k+ opservacija, 47% prijava <1 min).
 * `tech_processes` k tome i dalje puni živi kiosk (finished_at se upisuje), pa je
 * jedini POTPUN izvor. Filter `is_process_finished` je legacy analogon za
 * `auto_closed` iz `work_time_entries` (isključuje nedovršene/prekinute prijave).
 *
 * ── JEDINICE ────────────────────────────────────────────────────────────────
 * Sve u SATIMA. Plan reda = Tpz (setup, PO NALOGU) + Tk (cycle, PO KOMADU) ×
 * količina. Procena po radnom mestu je normalizovana na H/KOM (stvarni sati po
 * nalogu+RM / količina naloga) da bi bila uporediva preko naloga različitih
 * količina. Istorija crteža je po NALOGU (isti deo, direktno uporedivi sati).
 *
 * ── ZAŠTO KVANTILI, NE PROSEK ────────────────────────────────────────────────
 * Raspored h/kom je jako iskošen (setup se amortizuje na male serije; poneka
 * prijava ostane otvorena danima → ekstremni max). Zato izlaz nosi p25/median/p75
 * (percentile_cont, robusno na repove) i UVEK `n`; prosek/max se NE prikazuju kao
 * tačka. Mali `n` (< MALO_N) se izričito označava kao nepouzdan.
 */

/**
 * Prijava rada koja ULAZI u računicu — legacy pandan `PRIJAVA_VALIDNA` iz
 * `core-tools.ts`. Dva filtera šuma: (1) 47% prijava je zatvoreno za < 1 min
 * (knjiženja/ispravke, ne rad → medijana bi pala na nulu); (2) `is_process_finished`
 * = prijava je stvarno završena (nedovršene nemaju upotrebljivo trajanje).
 * Alias `tp` je OBAVEZAN u upitu koji ovo koristi.
 */
const TP_VALIDNA = Prisma.sql`tp.finished_at IS NOT NULL
       AND tp.finished_at >= tp.entered_at + interval '1 minute'
       AND COALESCE(tp.is_process_finished, false)`;

/**
 * Poklapanje BROJA CRTEŽA — samo `lower()` (bez unaccent-a): brojevi crteža su
 * ASCII šifre, a postojeći `idx_work_orders_drawing_number_lower` pokriva baš taj
 * izraz (potvrđen Bitmap Index Scan na produ). Isti izraz koriste `core-tools.ts`
 * i `work-orders.service.ts` — jedno pravilo za poklapanje crteža u aplikaciji.
 */
function drawingMatch(column: Prisma.Sql, term: string): Prisma.Sql {
  return Prisma.sql`lower(${column}) = lower(${term})`;
}

/**
 * Prag ispod kog je uzorak „mali" i procena se označava kao nepouzdana. Izabran
 * prema stvarnoj raspodeli na produ (35 od 70 radnih mesta ima ≥ 30 opservacija,
 * 25 ima ≥ 100) — ispod 30 kvantili su nestabilni.
 */
export const MALO_N = 30;

/** Minimalni klijent koji pure-funkcije koriste (PrismaService ga zadovoljava). */
export type RawSqlClient = Pick<PrismaService, "$queryRaw">;

/** h/kom kvantili za jedno radno mesto (bez naziva/šuma — to dodaju pozivaoci). */
export interface WcQuantileRow {
  radno_mesto: string;
  n: number;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  h_min: number | null;
  h_max: number | null;
}

/** Puna procena po radnom mestu — izlaz endpointa/alata. */
export interface WorkCenterEstimate extends WcQuantileRow {
  naziv_radnog_mesta: string | null;
  jedinica: "h/kom";
  malo_podataka: boolean;
  prijava_ukupno: number;
  prijava_izbaceno: number;
  napomena: string;
}

/** Istorija istog crteža na jednom radnom mestu (sati PO NALOGU). */
export interface DrawingWcRow {
  radno_mesto: string;
  naziv_radnog_mesta: string | null;
  naloga_sa_planom: number | null;
  plan_h_min: number | null;
  plan_h_max: number | null;
  plan_h_prosek: number | null;
  naloga_sa_prijavom: number | null;
  stvarno_h_min: number | null;
  stvarno_h_p50: number | null;
  stvarno_h_max: number | null;
}

const PRAZAN_UPIT = {
  greska: "prazan_upit" as const,
  poruka: "Navedi radno mesto ili broj crteža.",
};

/**
 * H/KOM KVANTILI PO RADNOM MESTU za dati skup šifri, U JEDNOM UPITU.
 *
 * Opservacija = jedan (nalog, radno mesto): stvarni sati (zbir validnih prijava
 * tog naloga na tom RM) / količina naloga. Time je grana simetrična planu
 * (Tpz+Tk×kom je isto po nalogu+RM). Nalozi bez količine se izostavljaju.
 */
export async function wcQuantiles(
  prisma: RawSqlClient,
  codes: readonly string[],
): Promise<WcQuantileRow[]> {
  if (!codes.length) return [];
  return prisma.$queryRaw<WcQuantileRow[]>(Prisma.sql`
    WITH stvarno_po_nalogu AS (
      SELECT tp.work_order_id, tp.work_center_code AS rm,
             SUM(EXTRACT(EPOCH FROM (tp.finished_at - tp.entered_at))) / 3600.0 AS real_h
        FROM tech_processes tp
       WHERE ${TP_VALIDNA}
         AND tp.work_center_code IN (${Prisma.join([...codes])})
       GROUP BY 1, 2
    ),
    obs AS (
      SELECT s.rm, s.real_h / wo.piece_count AS hpp
        FROM stvarno_po_nalogu s
        JOIN work_orders wo ON wo.id = s.work_order_id
       WHERE wo.piece_count > 0
    )
    SELECT rm AS radno_mesto,
           count(*)::int AS n,
           percentile_cont(0.25) WITHIN GROUP (ORDER BY hpp)::float8 AS p25,
           percentile_cont(0.50) WITHIN GROUP (ORDER BY hpp)::float8 AS p50,
           percentile_cont(0.75) WITHIN GROUP (ORDER BY hpp)::float8 AS p75,
           min(hpp)::float8 AS h_min,
           max(hpp)::float8 AS h_max
      FROM obs
     GROUP BY rm`);
}

function malo(n: number): boolean {
  return n < MALO_N;
}

function wcNapomena(n: number, izbaceno: number, ukupno: number): string {
  const baza =
    "Vremena su u SATIMA PO KOMADU (stvarni sati po nalogu+RM / količina). " +
    "Prikaži interval p25–p75 sa medijanom i n, ne prosek.";
  const filter =
    ukupno > 0
      ? ` Iz uzorka je izbačeno ${izbaceno} od ${ukupno} prijava (< 1 min = knjiženje, ili nedovršene).`
      : "";
  const nizak = malo(n)
    ? ` Uzorak je MALI (n=${n} < ${MALO_N}) — procena je orijentaciona, ne pouzdana.`
    : "";
  return baza + filter + nizak;
}

/**
 * PROCENA PO RADNOM MESTU (jedno RM) — za endpoint i alat asistenta.
 * Uz kvantile vraća i naziv RM i koliko je prijava izbačeno (transparentnost šuma).
 */
export async function estimateByWorkCenter(
  prisma: RawSqlClient,
  codeRaw: string,
): Promise<WorkCenterEstimate | typeof PRAZAN_UPIT> {
  const code = (codeRaw ?? "").trim();
  if (!code) return PRAZAN_UPIT;

  const [q] = await wcQuantiles(prisma, [code]);
  const meta = await prisma.$queryRaw<
    {
      naziv: string | null;
      prijava_ukupno: number;
      prijava_izbaceno: number;
    }[]
  >(Prisma.sql`
    SELECT (SELECT o.work_center_name FROM operations o
             WHERE o.work_center_code = ${code}) AS naziv,
           count(*)::int AS prijava_ukupno,
           count(*) FILTER (WHERE NOT (${TP_VALIDNA}))::int AS prijava_izbaceno
      FROM tech_processes tp
     WHERE tp.work_center_code = ${code}`);

  const n = q?.n ?? 0;
  const izbaceno = meta[0]?.prijava_izbaceno ?? 0;
  const ukupno = meta[0]?.prijava_ukupno ?? 0;
  return {
    radno_mesto: code,
    naziv_radnog_mesta: meta[0]?.naziv ?? null,
    jedinica: "h/kom",
    n,
    p25: q?.p25 ?? null,
    p50: q?.p50 ?? null,
    p75: q?.p75 ?? null,
    h_min: q?.h_min ?? null,
    h_max: q?.h_max ?? null,
    malo_podataka: malo(n),
    prijava_ukupno: ukupno,
    prijava_izbaceno: izbaceno,
    napomena: wcNapomena(n, izbaceno, ukupno),
  };
}

/**
 * ISTORIJA JEDNOG CRTEŽA — svi raniji nalozi istog crteža, plan vs stvarno po
 * radnom mestu (sati PO NALOGU). Ista simetrična agregacija kao `istorija_crteza`
 * (plan_po_nalogu / stvarno_po_nalogu → raspon po RM), samo je stvarni izvor
 * `tech_processes`, a real strana dobija i median (p50). Prima broj crteža ILI
 * ident broj RN-a (tada nađe crtež tog naloga tačnim poklapanjem).
 */
export async function estimateForDrawing(
  prisma: RawSqlClient,
  crtezRaw: string,
): Promise<
  | typeof PRAZAN_UPIT
  | {
      crtez: string;
      broj_naloga: number;
      prijava_ukupno: number;
      prijava_izbaceno: number;
      napomena: string;
      po_radnom_mestu: DrawingWcRow[];
      poslednji_nalozi: unknown[];
      predlog?: string;
    }
> {
  const q = (crtezRaw ?? "").trim();
  if (!q) return PRAZAN_UPIT;

  // Ako je dat IDENT RN-a, razreši crtež tog naloga (tačno poklapanje — indeksni
  // izraz nije bitan, jednokratni lookup). Ako ništa ne nađe, tretiraj ulaz kao crtež.
  const poIdentu = await prisma.$queryRaw<{ crtez: string }[]>(Prisma.sql`
    SELECT wo.drawing_number AS crtez FROM work_orders wo
     WHERE lower(btrim(wo.ident_number)) = lower(btrim(${q}))
       AND COALESCE(btrim(wo.drawing_number), '') <> ''
     ORDER BY wo.entered_at DESC LIMIT 1`);
  const crtez = poIdentu[0]?.crtez ?? q;

  const nalozi = await prisma.$queryRaw<{ ident: string }[]>(Prisma.sql`
    SELECT wo.ident_number AS ident, wo.variant AS varijanta,
           wo.piece_count AS kolicina, wo.part_name AS naziv_dela,
           to_char(wo.entered_at, 'DD.MM.YYYY') AS otvoren,
           NULLIF(btrim(p.project_number), '') AS predmet
      FROM work_orders wo
      LEFT JOIN projects p ON p.id = wo.project_id
     WHERE ${drawingMatch(Prisma.sql`wo.drawing_number`, crtez)}
     ORDER BY wo.entered_at DESC
     LIMIT 10`);
  if (!nalozi.length) {
    return {
      crtez,
      broj_naloga: 0,
      prijava_ukupno: 0,
      prijava_izbaceno: 0,
      napomena: "Nijedan nalog nema tačno taj broj crteža.",
      po_radnom_mestu: [],
      poslednji_nalozi: [],
      predlog: `Nijedan nalog nema tačno taj broj crteža. Ako je dat deo naziva ili nepotpun broj, prvo nađi tačan broj crteža pa probaj ponovo.`,
    };
  }

  const poRadnomMestu = await prisma.$queryRaw<DrawingWcRow[]>(Prisma.sql`
    WITH nalozi AS (
      SELECT wo.id, wo.piece_count FROM work_orders wo
       WHERE ${drawingMatch(Prisma.sql`wo.drawing_number`, crtez)}
    ),
    plan_po_nalogu AS (
      SELECT woo.work_order_id, woo.work_center_code AS rm,
             SUM(COALESCE(woo.setup_time, 0)
                 + COALESCE(woo.cycle_time, 0) * n.piece_count) AS h
        FROM work_order_operations woo
        JOIN nalozi n ON n.id = woo.work_order_id
       GROUP BY 1, 2
    ),
    plan AS (
      SELECT rm, count(*)::int AS naloga_sa_planom,
             min(h)::float8 AS plan_h_min,
             max(h)::float8 AS plan_h_max,
             avg(h)::float8 AS plan_h_prosek
        FROM plan_po_nalogu GROUP BY 1
    ),
    stvarno_po_nalogu AS (
      SELECT tp.work_order_id, tp.work_center_code AS rm,
             SUM(EXTRACT(EPOCH FROM (tp.finished_at - tp.entered_at))) / 3600.0 AS h
        FROM tech_processes tp
        JOIN nalozi n ON n.id = tp.work_order_id
       WHERE ${TP_VALIDNA}
       GROUP BY 1, 2
    ),
    stvarno AS (
      SELECT rm, count(*)::int AS naloga_sa_prijavom,
             min(h)::float8 AS stvarno_h_min,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY h)::float8 AS stvarno_h_p50,
             max(h)::float8 AS stvarno_h_max
        FROM stvarno_po_nalogu GROUP BY 1
    )
    SELECT COALESCE(plan.rm, stvarno.rm) AS radno_mesto,
           o.work_center_name AS naziv_radnog_mesta,
           plan.naloga_sa_planom, plan.plan_h_min, plan.plan_h_max, plan.plan_h_prosek,
           stvarno.naloga_sa_prijavom, stvarno.stvarno_h_min,
           stvarno.stvarno_h_p50, stvarno.stvarno_h_max
      FROM plan FULL JOIN stvarno ON stvarno.rm = plan.rm
      LEFT JOIN operations o ON o.work_center_code = COALESCE(plan.rm, stvarno.rm)
     ORDER BY 1
     LIMIT 25`);

  const zbir = await prisma.$queryRaw<
    { broj_naloga: number; prijava_ukupno: number; prijava_izbaceno: number }[]
  >(Prisma.sql`
    WITH nalozi AS (
      SELECT wo.id FROM work_orders wo
       WHERE ${drawingMatch(Prisma.sql`wo.drawing_number`, crtez)}
    )
    SELECT (SELECT count(*)::int FROM nalozi) AS broj_naloga,
           count(tp.id)::int AS prijava_ukupno,
           count(tp.id) FILTER (WHERE NOT (${TP_VALIDNA}))::int AS prijava_izbaceno
      FROM nalozi n
      LEFT JOIN tech_processes tp ON tp.work_order_id = n.id`);

  const izbaceno = zbir[0]?.prijava_izbaceno ?? 0;
  const ukupno = zbir[0]?.prijava_ukupno ?? 0;
  return {
    crtez,
    broj_naloga: zbir[0]?.broj_naloga ?? nalozi.length,
    prijava_ukupno: ukupno,
    prijava_izbaceno: izbaceno,
    napomena:
      `Vremena su u SATIMA PO NALOGU. Plan i stvarno se računaju ISTO — prvo zbir po nalogu i radnom mestu, pa raspon po radnom mestu. ` +
      `Plan = Tpz + Tk × komada. Iz stvarnog je izbačeno ${izbaceno} od ${ukupno} prijava (< 1 min = knjiženje, ili nedovršene)` +
      (izbaceno > 0 ? `. Reci da je uzorak filtriran ako navodiš brojeve.` : `.`),
    po_radnom_mestu: poRadnomMestu,
    poslednji_nalozi: nalozi,
  };
}

/** Jedna operacija naloga sa procenom (plan + RM + istorija crteža). */
export interface OperationEstimate {
  rb: number;
  radno_mesto: string;
  naziv_radnog_mesta: string | null;
  opis: string | null;
  plan_h: number | null;
  rm_procena: {
    n: number;
    p25: number | null;
    p50: number | null;
    p75: number | null;
    malo_podataka: boolean;
  } | null;
  crtez_procena: {
    n_naloga: number;
    stvarno_h_p50: number | null;
    stvarno_h_min: number | null;
    stvarno_h_max: number | null;
  } | null;
}

export interface WorkOrderEstimate {
  nalog: {
    id: number;
    ident: string;
    varijanta: number;
    crtez: string | null;
    kolicina: number;
    naziv_dela: string | null;
  };
  crtez_istorija: { broj_naloga: number; drugi_nalozi: number } | null;
  jedinica: "h";
  operacije: OperationEstimate[];
  napomena: string;
}

/**
 * PROCENA ZA KONKRETAN NALOG (`estimateForOperation` na nivou celog naloga) —
 * za svaki red rutinga vraća (a) plan (Tpz + Tk × kom), (b) procenu po radnom
 * mestu tog reda (h/kom, iz cele istorije), (c) istoriju baš tog crteža na tom
 * radnom mestu ako je nalog vezan za crtež sa više naloga. Sve u JEDNOM pozivu
 * (batch upiti), za nenametljiv panel u tehnološkom postupku.
 */
export async function estimateForWorkOrder(
  prisma: RawSqlClient,
  workOrderId: number,
): Promise<WorkOrderEstimate | { greska: "nema_naloga"; poruka: string }> {
  const nalog = await prisma.$queryRaw<
    {
      id: number;
      ident: string;
      varijanta: number;
      crtez: string | null;
      kolicina: number;
      naziv_dela: string | null;
    }[]
  >(Prisma.sql`
    SELECT wo.id, wo.ident_number AS ident, wo.variant AS varijanta,
           NULLIF(btrim(wo.drawing_number), '') AS crtez,
           wo.piece_count AS kolicina, wo.part_name AS naziv_dela
      FROM work_orders wo
     WHERE wo.id = ${workOrderId}
     LIMIT 1`);
  if (!nalog.length) {
    return { greska: "nema_naloga", poruka: `Nalog ${workOrderId} ne postoji.` };
  }
  const wo = nalog[0];

  const operacije = await prisma.$queryRaw<
    {
      rb: number;
      radno_mesto: string;
      naziv_radnog_mesta: string | null;
      opis: string | null;
      plan_h: number | null;
    }[]
  >(Prisma.sql`
    SELECT woo.operation_number AS rb, woo.work_center_code AS radno_mesto,
           o.work_center_name AS naziv_radnog_mesta,
           woo.work_description AS opis,
           (COALESCE(woo.setup_time, 0)
             + COALESCE(woo.cycle_time, 0) * ${wo.kolicina}::int)::float8 AS plan_h
      FROM work_order_operations woo
      LEFT JOIN operations o ON o.work_center_code = woo.work_center_code
     WHERE woo.work_order_id = ${wo.id}
     ORDER BY woo.operation_number
     LIMIT 60`);

  const codes = [...new Set(operacije.map((o) => o.radno_mesto))];
  const wcRows = await wcQuantiles(prisma, codes);
  const wcMap = new Map(wcRows.map((r) => [r.radno_mesto, r]));

  // Istorija baš ovog crteža po radnom mestu (sati po nalogu) — median + raspon.
  let crtezMap = new Map<string, DrawingWcRow>();
  let brojNaloga = 0;
  if (wo.crtez) {
    const draw = await estimateForDrawing(prisma, wo.crtez);
    if ("po_radnom_mestu" in draw) {
      crtezMap = new Map(draw.po_radnom_mestu.map((r) => [r.radno_mesto, r]));
      brojNaloga = draw.broj_naloga;
    }
  }

  const operacijeOut: OperationEstimate[] = operacije.map((op) => {
    const wc = wcMap.get(op.radno_mesto);
    const cr = crtezMap.get(op.radno_mesto);
    return {
      rb: op.rb,
      radno_mesto: op.radno_mesto,
      naziv_radnog_mesta: op.naziv_radnog_mesta,
      opis: op.opis,
      plan_h: op.plan_h,
      rm_procena:
        wc && wc.n > 0
          ? {
              n: wc.n,
              p25: wc.p25,
              p50: wc.p50,
              p75: wc.p75,
              malo_podataka: malo(wc.n),
            }
          : null,
      crtez_procena:
        cr && (cr.naloga_sa_prijavom ?? 0) > 0
          ? {
              n_naloga: cr.naloga_sa_prijavom ?? 0,
              stvarno_h_p50: cr.stvarno_h_p50,
              stvarno_h_min: cr.stvarno_h_min,
              stvarno_h_max: cr.stvarno_h_max,
            }
          : null,
    };
  });

  return {
    nalog: wo,
    crtez_istorija: wo.crtez
      ? { broj_naloga: brojNaloga, drugi_nalozi: Math.max(0, brojNaloga - 1) }
      : null,
    jedinica: "h",
    operacije: operacijeOut,
    napomena:
      `„rm_procena“ = h/kom iz cele istorije tog radnog mesta (interval p25–p75, median p50). ` +
      `„crtez_procena“ = sati PO NALOGU baš ovog crteža na tom RM. „plan_h“ = Tpz + Tk × kom. ` +
      `Mali n je označen (malo_podataka) — orijentaciono, ne menja normativ.`,
  };
}

/**
 * NestJS omotač — dodaje `{ data }` envelope (BACKEND_RULES §5) nad pure-funkcijama
 * (koje dele i alat asistenta). Sav rad je READ-ONLY nad glavnom bazom.
 */
@Injectable()
export class TimeEstimateService {
  constructor(private readonly prisma: PrismaService) {}

  async byWorkCenter(code: string) {
    return { data: await estimateByWorkCenter(this.prisma, code) };
  }

  async forDrawing(crtez: string) {
    return { data: await estimateForDrawing(this.prisma, crtez) };
  }

  async forWorkOrder(workOrderId: number) {
    return { data: await estimateForWorkOrder(this.prisma, workOrderId) };
  }
}
