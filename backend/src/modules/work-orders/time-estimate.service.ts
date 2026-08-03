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
 * Alat `istorija_crteza` (Talas AI-1) je uspostavio ISPRAVAN SPOJ plan-vs-stvarno:
 * obe strane se agregiraju SIMETRIČNO — prvo zbir PO NALOGU I RADNOM MESTU, pa tek
 * onda raspon po radnom mestu (review nalaz 19). TU LOGIKU ovde ponavljamo; od
 * review-a AI-5 i sam `istorija_crteza` DELEGIRA na `estimateForDrawing` odavde,
 * pa dva alata više ne daju kontradiktoran odgovor na isto pitanje.
 *
 * Izvor je `tech_processes` (`entered_at`→`finished_at`), NE `work_time_entries`:
 * ovaj drugi je novi 2.0 „dva skena" ledger i na produ ima ~950 redova; procena bi
 * bila prazna. Istorijskih ~99.000 prijava (2016→danas) živi u `tech_processes`,
 * odakle dolaze i brojke iz plana §2.2 (22k+ opservacija, 47% prijava <1 min);
 * tabelu i dalje puni živi kiosk (`finished_at`).
 *
 * ── JEDINICE ────────────────────────────────────────────────────────────────
 * Sve u SATIMA. Plan reda = Tpz (setup, PO NALOGU) + Tk (cycle, PO KOMADU) ×
 * količina. Procena po radnom mestu je normalizovana na H/KOM (stvarni sati po
 * nalogu+RM / količina naloga) da bi bila uporediva preko naloga različitih
 * količina. Istorija crteža je po NALOGU (isti deo, direktno uporedivi sati).
 * PAŽNJA: h/kom UKLJUČUJE amortizovan Tpz i ZAVISI od veličine serije (dekompozicija
 * setup/cycle iz `tech_processes` nije moguća — nema flag) → interval, ne tačka.
 *
 * ── ZAŠTO KVANTILI, NE PROSEK/MAX ────────────────────────────────────────────
 * Raspored h/kom je jako iskošen. Izlaz nosi p25/median/p75 (percentile_cont,
 * robusno na repove) i UVEK `n`; prosek se ne prikazuje kao tačka, a `max` se
 * UOPŠTE NE vraća u payload (jedna zaboravljena, danima otvorena prijava daje
 * apsurdan max — review [6][7]). Mali `n` (< MALO_N) se izričito označava.
 */

/**
 * Prijava rada koja ULAZI u računicu (row-nivo). Tri filtera:
 *  1. DONJA granica < 1 min: 47% prijava je zatvoreno za < minut (knjiženja, ne rad).
 *  2. GORNJA granica > 720 h (30 dana): `tech_processes` NEMA `auto_closed` iz
 *     `work_time_entries`; zaboravljena prijava ostaje otvorena mesecima (na produ
 *     max ≈ 27.590 h ≈ 3 godine → apsurdan h/kom). 720 h je gornja granica realne
 *     jedne operacije; izbacuje 133 od 52.406 redova. OVA granica (ne
 *     `is_process_finished`) je pravi analogon za `auto_closed`.
 *  3. `is_process_finished`: uslov UKLJUČIVANJA (operacija je markirana kao gotova) —
 *     NIJE isključivanje zaboravljenih (to radi granica 2).
 *
 * Filter je NA NIVOU REDA namerno: opservacija = SUM po (nalog, RM), pa red-nivo
 * izbacuje POJEDINAČNE booking-redove iz sume (tačnije nego prag na zbiru, koji bi
 * booking-red zadržao unutar opservacije sa realnim radom). Opservaciju-nivo
 * validnost obezbeđuje dodatni `prijavljeno_kom > 0` (vidi `wcQuantiles`).
 * Alias `tp` je OBAVEZAN u upitu koji ovo koristi.
 */
export const TP_VALIDNA = Prisma.sql`tp.finished_at IS NOT NULL
       AND tp.finished_at >= tp.entered_at + interval '1 minute'
       AND tp.finished_at <= tp.entered_at + interval '720 hours'
       AND COALESCE(tp.is_process_finished, false)`;

/**
 * ── PRIJAVA KOJA ULAZI U PRIKAZ UTROŠENOG VREMENA (zahtev 036/26) ────────────
 * Druga definicija „validne prijave", NAMERNO odvojena od `TP_VALIDNA` iznad, i
 * namerno stoji uz nju da se dve granice ne bi razišle u dva fajla.
 *
 * Razlike prema procenjivačkoj definiciji i ZAŠTO:
 *  • GORNJA granica je 24 h, ne 720 h. Procena traži da uzorak ostane REPREZENTATIVAN
 *    (radije zadrži dugu ali moguću operaciju nego da iseče realan rep), pa seče tek
 *    apsurd. PRIKAZ na kartici RN-a traži da broj bude ISTINIT ZA TAJ NALOG: čovek
 *    gleda „UKUPNO VREME" i čita ga kao „koliko je na ovom delu radeno". Jedna
 *    zaboravljena prijava (crtež 1138882, tech_processes.id 117936: OP 40 otvorena
 *    20.07, zatvorena 31.07 = 270,9 h) pravi 275 h od stvarnih ~4 h 50 min — dakle
 *    82% prikazanog vremena je bio zaborav. Nijedna smena ne traje duže od 24 h, pa
 *    je sve preko toga zaboravljena prijava, ne rad.
 *  • NEMA `is_process_finished` uslova: prikaz sabira SVAKO zatvoreno kucanje
 *    (i ono koje nije markirano kao gotova operacija) — kartica prikazuje evidenciju,
 *    ne uzorak za statistiku.
 *  • DONJA granica je ista (< 1 min = knjiženje, ne rad — 47% redova na produ).
 *
 * Izuzeti redovi se NE gutaju: pozivalac uz zbir vraća i broj izuzetih prijava, koji
 * UI prikazuje ispod pločice.
 *
 * Alias `tp` je OBAVEZAN u upitu koji ovo koristi (kao i kod `TP_VALIDNA`).
 */
export const TP_PRIKAZ_MIN_SEC = 60;
/** Gornja granica prikaza = 24 h. Vidi `TP_PRIKAZ_VALIDNA` zašto nije 720 h. */
export const TP_PRIKAZ_MAX_SEC = 24 * 60 * 60;
export const TP_PRIKAZ_VALIDNA = Prisma.sql`tp.finished_at IS NOT NULL
       AND tp.finished_at >= tp.entered_at + interval '1 minute'
       AND tp.finished_at <= tp.entered_at + interval '24 hours'`;

/**
 * Poklapanje BROJA CRTEŽA — samo `lower()` (bez unaccent-a): brojevi crteža su
 * ASCII šifre, a postojeći `idx_work_orders_drawing_number_lower` pokriva baš taj
 * izraz (potvrđen Bitmap Index Scan na produ). Isti izraz koriste `core-tools.ts`
 * i `work-orders.service.ts` — jedno pravilo za poklapanje crteža u aplikaciji.
 */
export function drawingMatch(column: Prisma.Sql, term: string): Prisma.Sql {
  return Prisma.sql`lower(${column}) = lower(${term})`;
}

/**
 * „Generički" broj crteža (opšti nalog i sl.) — string sa < 3 alfanumerička znaka,
 * npr. „..", „.", „…". Takvih je na produ 2.049 naloga preko 57 šifri; jedna od
 * njih („..") nosi 1.513 nepovezanih naloga. Agregirati ih kao jedan „crtež" bi
 * spojilo nespojiv rad (review [9]) → za njih se istorija NE računa.
 */
export function isGenericDrawing(crtez: string): boolean {
  return crtez.replace(/[^A-Za-z0-9]/g, "").length < 3;
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
  /** Donja granica uzorka (h/kom). `max` se NAMERNO ne vraća (review [6][7]). */
  h_min: number | null;
}

/** Puna procena po radnom mestu — izlaz endpointa/alata. */
export interface WorkCenterEstimate extends WcQuantileRow {
  naziv_radnog_mesta: string | null;
  jedinica: "h/kom";
  malo_podataka: boolean;
  /** Broj OPSERVACIJA (nalog×RM) u uzorku = `n` (ovde radi eksplicitnosti). */
  opservacija: number;
  /** Broj POJEDINAČNIH prijava (redova) van filtera — DRUGA granularnost od `n`. */
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
  plan_h_prosek: number | null;
  naloga_sa_prijavom: number | null;
  stvarno_h_min: number | null;
  stvarno_h_p50: number | null;
}

/** Jedan raniji nalog istog crteža (dokazi za drill-down). */
export interface DrawingOrderRow {
  ident: string;
  varijanta: number;
  kolicina: number;
  naziv_dela: string | null;
  otvoren: string | null;
  predmet: string | null;
}

export interface DrawingEstimate {
  crtez: string;
  broj_naloga: number;
  prijava_ukupno: number;
  prijava_izbaceno: number;
  napomena: string;
  po_radnom_mestu: DrawingWcRow[];
  poslednji_nalozi: DrawingOrderRow[];
  /** true = „opšti"/generički broj crteža — istorija se NE agregira (review [9]). */
  genericki?: boolean;
  predlog?: string;
}

const PRAZAN_UPIT = {
  greska: "prazan_upit" as const,
  poruka: "Navedi radno mesto ili broj crteža.",
};

/**
 * H/KOM KVANTILI PO RADNOM MESTU za dati skup šifri, U JEDNOM UPITU.
 *
 * Opservacija = jedan (nalog, radno mesto): stvarni sati (zbir VALIDNIH prijava tog
 * naloga na tom RM) / KOLIČINA NALOGA. Denominator je order-qty (ne SUM prijava):
 * `tech_processes.piece_count` je AKUMULIRAN (na produ 669 grupa ima SUM > količine),
 * pa bi deljenje njime duplo brojalo. Umesto toga se zero-piece opservacije (nijedan
 * komad prijavljen — čist booking; 2.615/25.716 ≈ 10% na produ) IZBACUJU
 * (`prijavljeno_kom > 0`), a količina naloga ostaje denominator (review [0]).
 */
export async function wcQuantiles(
  prisma: RawSqlClient,
  codes: readonly string[],
): Promise<WcQuantileRow[]> {
  if (!codes.length) return [];
  return prisma.$queryRaw<WcQuantileRow[]>(Prisma.sql`
    WITH stvarno_po_nalogu AS (
      SELECT tp.work_order_id, tp.work_center_code AS rm,
             SUM(EXTRACT(EPOCH FROM (tp.finished_at - tp.entered_at))) / 3600.0 AS real_h,
             SUM(tp.piece_count) AS prijavljeno_kom
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
         AND s.prijavljeno_kom > 0
    )
    SELECT rm AS radno_mesto,
           count(*)::int AS n,
           percentile_cont(0.25) WITHIN GROUP (ORDER BY hpp)::float8 AS p25,
           percentile_cont(0.50) WITHIN GROUP (ORDER BY hpp)::float8 AS p50,
           percentile_cont(0.75) WITHIN GROUP (ORDER BY hpp)::float8 AS p75,
           min(hpp)::float8 AS h_min
      FROM obs
     GROUP BY rm`);
}

function malo(n: number): boolean {
  return n < MALO_N;
}

function wcNapomena(n: number, izbaceno: number, ukupno: number): string {
  const baza =
    "Vremena su u SATIMA PO KOMADU (stvarni sati po nalogu+RM / količina naloga); " +
    "UKLJUČUJE amortizovanu pripremu (Tpz) i zavisi od veličine serije. " +
    "Prikaži interval p25–p75 sa medijanom, ne prosek; „max“ se ne daje. ";
  const gran =
    `n=${n} je broj OPSERVACIJA (nalog×radno mesto). ` +
    (ukupno > 0
      ? `Zasebno, ${izbaceno} od ${ukupno} POJEDINAČNIH prijava (redova) je van filtera (< 1 min = knjiženje, > 720 h = zaboravljeno, ili nedovršeno) — druga granularnost od n.`
      : "");
  const nizak = malo(n)
    ? ` Uzorak je MALI (n < ${MALO_N}) — procena je orijentaciona, ne pouzdana.`
    : "";
  return baza + gran + nizak;
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
    opservacija: n,
    p25: q?.p25 ?? null,
    p50: q?.p50 ?? null,
    p75: q?.p75 ?? null,
    h_min: q?.h_min ?? null,
    malo_podataka: malo(n),
    prijava_ukupno: ukupno,
    prijava_izbaceno: izbaceno,
    napomena: wcNapomena(n, izbaceno, ukupno),
  };
}

/**
 * ISTORIJA JEDNOG CRTEŽA — svi raniji nalozi istog crteža, plan vs stvarno po
 * radnom mestu (sati PO NALOGU). Ista simetrična agregacija (plan_po_nalogu /
 * stvarno_po_nalogu → raspon po RM), stvarni izvor `tech_processes`, real strana
 * daje median (p50), NE max. Prima broj crteža ILI ident broj RN-a.
 *
 * `skipIdentResolve` (review [11]): kad pozivalac VEĆ zna broj crteža (npr.
 * `estimateForWorkOrder` iz `wo.drawing_number`), preskače se ~100 ms Seq Scan
 * `poIdentu` lookup-a koji nikad ne pogađa.
 */
export async function estimateForDrawing(
  prisma: RawSqlClient,
  crtezRaw: string,
  opts: { skipIdentResolve?: boolean } = {},
): Promise<DrawingEstimate | typeof PRAZAN_UPIT> {
  const qraw = (crtezRaw ?? "").trim();
  if (!qraw) return PRAZAN_UPIT;

  // Generički/„opšti" broj crteža → istorija se ne agregira (spojio bi nespojiv rad).
  if (isGenericDrawing(qraw)) {
    return {
      crtez: qraw,
      broj_naloga: 0,
      prijava_ukupno: 0,
      prijava_izbaceno: 0,
      genericki: true,
      napomena:
        "Broj crteža je generički/„opšti“ (premalo znakova) — istorija se ne agregira jer bi spojila nepovezane naloge.",
      po_radnom_mestu: [],
      poslednji_nalozi: [],
    };
  }

  // Ako je dat IDENT RN-a, razreši crtež tog naloga (tačno poklapanje). Preskače se
  // kad pozivalac već ima broj crteža (skipIdentResolve).
  let crtez = qraw;
  if (!opts.skipIdentResolve) {
    const poIdentu = await prisma.$queryRaw<{ crtez: string }[]>(Prisma.sql`
      SELECT wo.drawing_number AS crtez FROM work_orders wo
       WHERE lower(btrim(wo.ident_number)) = lower(btrim(${qraw}))
         AND COALESCE(btrim(wo.drawing_number), '') <> ''
       ORDER BY wo.entered_at DESC LIMIT 1`);
    crtez = poIdentu[0]?.crtez ?? qraw;
    if (crtez !== qraw && isGenericDrawing(crtez)) {
      return {
        crtez,
        broj_naloga: 0,
        prijava_ukupno: 0,
        prijava_izbaceno: 0,
        genericki: true,
        napomena:
          "Crtež tog naloga je generički/„opšti“ — istorija se ne agregira.",
        po_radnom_mestu: [],
        poslednji_nalozi: [],
      };
    }
  }

  const nalozi = await prisma.$queryRaw<DrawingOrderRow[]>(Prisma.sql`
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
             avg(h)::float8 AS plan_h_prosek
        FROM plan_po_nalogu GROUP BY 1
    ),
    stvarno_po_nalogu AS (
      SELECT tp.work_order_id, tp.work_center_code AS rm,
             SUM(EXTRACT(EPOCH FROM (tp.finished_at - tp.entered_at))) / 3600.0 AS h,
             SUM(tp.piece_count) AS prijavljeno_kom
        FROM tech_processes tp
        JOIN nalozi n ON n.id = tp.work_order_id
       WHERE ${TP_VALIDNA}
       GROUP BY 1, 2
    ),
    stvarno AS (
      SELECT rm, count(*)::int AS naloga_sa_prijavom,
             min(h)::float8 AS stvarno_h_min,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY h)::float8 AS stvarno_h_p50
        FROM stvarno_po_nalogu
       WHERE prijavljeno_kom > 0
       GROUP BY 1
    )
    SELECT COALESCE(plan.rm, stvarno.rm) AS radno_mesto,
           o.work_center_name AS naziv_radnog_mesta,
           plan.naloga_sa_planom, plan.plan_h_min, plan.plan_h_prosek,
           stvarno.naloga_sa_prijavom, stvarno.stvarno_h_min, stvarno.stvarno_h_p50
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
      `Plan = Tpz + Tk × komada. Iz stvarnog je izbačeno ${izbaceno} od ${ukupno} prijava (< 1 min, > 720 h ili nedovršene)` +
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
  /**
   * `broj_naloga` = svi nalozi tog crteža (uklj. ovaj), `drugi_nalozi` = raniji.
   * `genericki` = „opšti"/generički crtež. `null` kad nalog nema broj crteža.
   * `drugi_nalozi === 0` = NOV crtež bez istorije (review [14]).
   */
  crtez_istorija: {
    broj_naloga: number;
    drugi_nalozi: number;
    genericki: boolean;
  } | null;
  /** Nalozi koji čine uzorak istorije crteža — dokazi za drill-down (review [13]). */
  crtez_nalozi: DrawingOrderRow[];
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

  // Istorija baš ovog crteža po radnom mestu (sati po nalogu) — median. Crtež je
  // već poznat (skipIdentResolve → bez suvišnog Seq Scan-a, review [11]); generički
  // crtež estimateForDrawing sam odbija.
  let crtezMap = new Map<string, DrawingWcRow>();
  let brojNaloga = 0;
  let genericki = false;
  let crtezNalozi: DrawingOrderRow[] = [];
  if (wo.crtez) {
    const draw = await estimateForDrawing(prisma, wo.crtez, {
      skipIdentResolve: true,
    });
    if ("po_radnom_mestu" in draw) {
      crtezMap = new Map(draw.po_radnom_mestu.map((r) => [r.radno_mesto, r]));
      brojNaloga = draw.broj_naloga;
      genericki = draw.genericki === true;
      crtezNalozi = draw.poslednji_nalozi;
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
            }
          : null,
    };
  });

  return {
    nalog: wo,
    crtez_istorija: wo.crtez
      ? {
          broj_naloga: brojNaloga,
          drugi_nalozi: Math.max(0, brojNaloga - 1),
          genericki,
        }
      : null,
    crtez_nalozi: crtezNalozi,
    jedinica: "h",
    operacije: operacijeOut,
    napomena:
      `„rm_procena“ = h/kom iz cele istorije tog radnog mesta (interval p25–p75, median p50; UKLJUČUJE pripremu, zavisi od veličine serije). ` +
      `„crtez_procena“ = sati PO NALOGU baš ovog crteža na tom RM. „plan_h“ = Tpz + Tk × kom (po nalogu — ne meša se sa h/kom). ` +
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
