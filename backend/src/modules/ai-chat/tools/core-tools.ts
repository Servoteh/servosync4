import { Prisma } from "@prisma/client";
import { PERMISSIONS } from "../../../common/authz/permissions";
import type { AiTool, ToolScope } from "./tool-registry";

/**
 * TALAS AI-1, tačka 3 — alati nad GLAVNOM bazom (proizvodno jezgro).
 *
 * Do sada je asistent imao 20 alata koji SVI čitaju legacy sy15 — o 40.860
 * radnih naloga, 99.063 prijave rada, 216k redova rutinga i 92k artikala nije
 * znao ništa. Ovih šest alata su ta slepa mrlja.
 *
 * ── TRI PRAVILA KOJA VAŽE ZA SVAKI ALAT OVDE ───────────────────────────────
 * 1. SVI su `kind: "read"`. Glavna baza NEMA RLS (0 politika na 176 tabela), pa
 *    je `requiredPermission` JEDINA brana — proverava se i pri nuđenju modelu i
 *    pri izvršenju (`AiChatService.execTool` → `isToolAllowed`).
 * 2. Rezultat je KOMPAKTAN: LIMIT 10–20 i agregati umesto sirovih redova.
 *    Svaki red ide u kontekst modela i plaća se tokenima; „vrati sve" je ovde
 *    skuplje nego u HTTP odgovoru.
 * 3. Pretraga IDE KROZ `public.immutable_unaccent(lower(...))` — isti izraz kao
 *    u trigram indeksima iz migracije 20260726160000. Ako se izraz ovde ikad
 *    razlikuje (npr. izostane `lower`), indeks tiho prestaje da se koristi i
 *    upit se vraća na Seq Scan. Uz to SVAKI upit ima `ORDER BY` pre `LIMIT`-a:
 *    bez sortiranja planer na mali LIMIT bira Seq Scan „jer će brzo naći 15
 *    redova" (mereno na 30k redova: 159 ms Seq Scan vs 1,9 ms Bitmap Index).
 *
 * Poslovna logika se NE duplira (plan §2.4): `prisustvo_danas` zove postojeći
 * `KadrovskaService.attendanceNow`, a jedinice vremena (Tpz/Tk u SATIMA) prate
 * `kvalitet/nonconformity-calc.ts` — odluku vlasnika Q6.
 */

/** Proizvodni alati NISU u deljenoj projektnoj niti — vidi `ai-tools.ts` §scope. */
const LICNI: readonly ToolScope[] = ["personal"];

/** LIKE '%pojam%' nad indeksiranim izrazom (dijakritika i velika slova nebitni). */
function unaccentLike(column: Prisma.Sql, term: string): Prisma.Sql {
  return Prisma.sql`public.immutable_unaccent(lower(${column})) LIKE '%' || public.immutable_unaccent(lower(${term})) || '%'`;
}

/**
 * TAČNO poklapanje ident broja — ali INDEKSIRANO. Gola jednakost nad izrazom
 * (`immutable_unaccent(lower(btrim(col))) = …`) NE koristi trigram indeks (GIN
 * `gin_trgm_ops` podržava LIKE/sličnost, ne `=`) → Seq Scan 40.860 redova
 * (mereno 160 ms na 30k). Zato prvo suzimo trigram LIKE-om (Bitmap Index Scan),
 * pa tek onda REČEKUJEMO tačnu jednakost — rezultat je identičan, cena nije.
 */
function identMatch(column: Prisma.Sql, term: string): Prisma.Sql {
  return Prisma.sql`(${unaccentLike(column, term)}
        AND public.immutable_unaccent(lower(btrim(${column}))) = public.immutable_unaccent(lower(btrim(${term}))))`;
}

/**
 * Poklapanje BROJA CRTEŽA — namerno samo `lower()`, bez unaccent-a: brojevi
 * crteža su ASCII šifre, a `idx_work_orders_drawing_number_lower` (postojeći
 * btree iz PDM paketa) pokriva baš taj izraz. Isti izraz koristi i
 * `work-orders.service.ts` (`resolveDrawingIdByNumber`) — jedno pravilo za
 * poklapanje crteža u celoj aplikaciji.
 */
function drawingMatch(column: Prisma.Sql, term: string): Prisma.Sql {
  return Prisma.sql`lower(${column}) = lower(${term})`;
}

/**
 * Poklapanje BROJA PREDMETA (npr. „9400/7"). `btrim` je obavezan — zato i
 * postoji parcijalni unique `uq_projects_project_number ... WHERE btrim(...) <> ''`,
 * tj. u podacima ima praznina. Time se gubi taj btree indeks (izraz se ne
 * poklapa) i ostaje Seq Scan, ali `projects` je najmanja od ovih tabela
 * (predmeti, ne nalozi) pa je cena zanemarljiva — tačnost je ovde preča.
 */
function projectMatch(column: Prisma.Sql, term: string): Prisma.Sql {
  return Prisma.sql`btrim(${column}) = btrim(${term})`;
}

/** Argument modela → pojam pretrage. Objekat/niz NIJE pojam → prazno (ne „[object Object]"). */
function term(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

/** Prazan upit ne sme da povuče celu tabelu — model dobija jasnu poruku. */
const PRAZAN_UPIT = { greska: "prazan_upit", poruka: "Navedi pojam pretrage." };

export const CORE_TOOLS: readonly AiTool[] = [
  {
    name: "nadji_radni_nalog",
    description: `Radni nalozi (RN) iz proizvodnje — pretraga po IDENT BROJU (i delimičan pogodak, npr. „9400") ili po NAZIVU DELA (dijakritici nebitni). Za svaki nalog vraća: ident + varijantu, naziv dela, broj crteža, količinu, materijal, status primopredaje, rok proizvodnje i predmet (broj + opis). Koristi za „gde je RN X", „ima li nalog za …", „koji je rok za …". Vraća najviše 15 najnovijih pogodaka.`,
    schema: {
      type: "object",
      properties: {
        upit: {
          type: "string",
          description: `ident broj RN-a ili deo naziva dela`,
        },
      },
      required: ["upit"],
    },
    kind: "read",
    requiredPermission: PERMISSIONS.RN_READ,
    scopes: LICNI,
    execute: async (a, ctx) => {
      const q = term(a.upit);
      if (!q) return PRAZAN_UPIT;
      const nalozi = await ctx.deps.prisma.$queryRaw<unknown[]>(Prisma.sql`
        SELECT wo.ident_number AS ident, wo.variant AS varijanta,
               wo.part_name AS naziv_dela, wo.drawing_number AS crtez,
               wo.piece_count AS kolicina, NULLIF(btrim(wo.material), '') AS materijal,
               hs.name AS status_primopredaje,
               CASE WHEN COALESCE(wo.status, false) THEN 'zavrsen' ELSE 'u radu' END AS status,
               to_char(wo.production_deadline, 'DD.MM.YYYY') AS rok,
               to_char(wo.entered_at, 'DD.MM.YYYY') AS otvoren,
               NULLIF(btrim(p.project_number), '') AS predmet,
               p.description AS predmet_opis
          FROM work_orders wo
          LEFT JOIN handover_statuses hs ON hs.id = wo.handover_status_id
          LEFT JOIN projects p ON p.id = wo.project_id
         WHERE ${unaccentLike(Prisma.sql`wo.ident_number`, q)}
            OR ${unaccentLike(Prisma.sql`wo.part_name`, q)}
         ORDER BY wo.entered_at DESC
         LIMIT 15`);
      return nalozi.length
        ? { pojam: q, nadjeno: nalozi.length, nalozi }
        : { pojam: q, nadjeno: 0, nalozi: [] };
    },
  },
  {
    name: "istorija_crteza",
    description: `ISTORIJA JEDNOG CRTEŽA — svi raniji radni nalozi za isti broj crteža, sa PLANIRANIM (Tpz + Tk × komada, u satima) i STVARNIM vremenom po RADNOM MESTU (raspon min–max i prosek iz prijava rada). Odgovara na „koliko je puta rađen ovaj crtež i koliko je trajalo". Prima broj crteža ILI ident broj RN-a (tada sam nađe crtež tog naloga). Vraća agregat po radnom mestu + poslednjih 10 naloga.`,
    schema: {
      type: "object",
      properties: {
        crtez: {
          type: "string",
          description: `broj crteža ili ident broj RN-a`,
        },
      },
      required: ["crtez"],
    },
    kind: "read",
    requiredPermission: PERMISSIONS.TEHNOLOGIJA_READ,
    scopes: LICNI,
    execute: async (a, ctx) => {
      const q = term(a.crtez);
      if (!q) return PRAZAN_UPIT;
      const prisma = ctx.deps.prisma;

      // Ako je korisnik dao IDENT RN-a, prvo izvuci crtež tog naloga.
      const poIdentu = await prisma.$queryRaw<{ crtez: string }[]>(Prisma.sql`
        SELECT wo.drawing_number AS crtez FROM work_orders wo
         WHERE ${identMatch(Prisma.sql`wo.ident_number`, q)}
           AND COALESCE(btrim(wo.drawing_number), '') <> ''
         ORDER BY wo.entered_at DESC LIMIT 1`);
      const crtez = poIdentu[0]?.crtez ?? q;

      const nalozi = await prisma.$queryRaw<
        { ident: string; ukupno: number }[]
      >(Prisma.sql`
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
        return { crtez, broj_naloga: 0, nalozi: [], po_radnom_mestu: [] };
      }

      // Agregat plan-vs-stvarno po radnom mestu nad SVIM nalozima istog crteža
      // (ne samo prikazanih 10) — zato zaseban upit sa svojim CTE-om.
      const poRadnomMestu = await prisma.$queryRaw<unknown[]>(Prisma.sql`
        WITH nalozi AS (
          SELECT wo.id, wo.piece_count
            FROM work_orders wo
           WHERE ${drawingMatch(Prisma.sql`wo.drawing_number`, crtez)}
        ),
        plan AS (
          SELECT woo.work_center_code AS rm,
                 count(*)::int AS naloga_sa_planom,
                 round(avg(COALESCE(woo.setup_time, 0)
                       + COALESCE(woo.cycle_time, 0) * n.piece_count)::numeric, 2) AS plan_h_prosek
            FROM work_order_operations woo
            JOIN nalozi n ON n.id = woo.work_order_id
           GROUP BY 1
        ),
        po_nalogu AS (
          SELECT wte.work_order_id, wte.work_center_code AS rm,
                 SUM(EXTRACT(EPOCH FROM (wte.stopped_at - wte.started_at))) / 3600.0 AS h
            FROM work_time_entries wte
            JOIN nalozi n ON n.id = wte.work_order_id
           WHERE wte.stopped_at IS NOT NULL
           GROUP BY 1, 2
        ),
        stvarno AS (
          SELECT rm, count(*)::int AS naloga_sa_prijavom,
                 round(min(h)::numeric, 2) AS stvarno_h_min,
                 round(max(h)::numeric, 2) AS stvarno_h_max,
                 round(avg(h)::numeric, 2) AS stvarno_h_prosek
            FROM po_nalogu GROUP BY 1
        )
        SELECT COALESCE(plan.rm, stvarno.rm) AS radno_mesto,
               o.work_center_name AS naziv_radnog_mesta,
               plan.naloga_sa_planom, plan.plan_h_prosek,
               stvarno.naloga_sa_prijavom, stvarno.stvarno_h_min,
               stvarno.stvarno_h_max, stvarno.stvarno_h_prosek
          FROM plan FULL JOIN stvarno ON stvarno.rm = plan.rm
          LEFT JOIN operations o ON o.work_center_code = COALESCE(plan.rm, stvarno.rm)
         ORDER BY 1
         LIMIT 20`);

      const ukupno = await prisma.$queryRaw<{ broj: number }[]>(Prisma.sql`
        SELECT count(*)::int AS broj FROM work_orders wo
         WHERE ${drawingMatch(Prisma.sql`wo.drawing_number`, crtez)}`);

      return {
        crtez,
        broj_naloga: ukupno[0]?.broj ?? nalozi.length,
        napomena: `Vremena su u SATIMA. Plan = Tpz + Tk × komada; stvarno = zbir prijava rada po nalogu.`,
        po_radnom_mestu: poRadnomMestu,
        poslednji_nalozi: nalozi,
      };
    },
  },
  {
    name: "nadji_artikal",
    description: `Artikli iz šifarnika robe — pretraga po NAZIVU ili KATALOŠKOM BROJU (dijakritici nebitni: „zaptivac" nalazi „zaptivač"). Vraća naziv, kataloški broj, jedinicu mere i stanje na zalihama ako postoji. Koristi za „imamo li artikal X", „koji je kataloški broj za …". Najviše 15 pogodaka.`,
    schema: {
      type: "object",
      properties: {
        upit: {
          type: "string",
          description: `deo naziva ili kataloški broj`,
        },
      },
      required: ["upit"],
    },
    kind: "read",
    requiredPermission: PERMISSIONS.ROBNO_READ,
    scopes: LICNI,
    execute: async (a, ctx) => {
      const q = term(a.upit);
      if (!q) return PRAZAN_UPIT;
      const artikli = await ctx.deps.prisma.$queryRaw<unknown[]>(Prisma.sql`
        SELECT i.id, i.name AS naziv,
               NULLIF(btrim(i.catalog_number), '-') AS kataloski_broj,
               i.unit AS jm, COALESCE(i.active, true) AS aktivan,
               m.in_stock::float8 AS stanje_mrp,
               m.reserved::float8 AS rezervisano_mrp,
               sl.on_hand::float8 AS stanje_magacini
          FROM items i
          LEFT JOIN mrp_item_stock m ON m.item_id = i.id
          LEFT JOIN (
            SELECT item_id, SUM(on_hand) AS on_hand
              FROM stock_levels GROUP BY item_id
          ) sl ON sl.item_id = i.id
         WHERE ${unaccentLike(Prisma.sql`i.name`, q)}
            OR ${unaccentLike(Prisma.sql`i.catalog_number`, q)}
         ORDER BY i.name
         LIMIT 15`);
      return {
        pojam: q,
        nadjeno: artikli.length,
        napomena: `„stanje_mrp"/„stanje_magacini" prazno = zaliha se za taj artikal ne vodi u 3.0 (BigBit je i dalje izvor).`,
        artikli,
      };
    },
  },
  {
    name: "stanje_predmeta",
    description: `Presek PREDMETA (posla) iz glavne baze po broju predmeta ili delu opisa: osnovni podaci (opis, kupac, rok, status, otvoren/zatvoren) + koliko radnih naloga ima, koliko je završeno, koliko u radu, i lista do 10 otvorenih naloga sa rokovima. Koristi za „šta je sa predmetom 9400/7", „koji nalozi su otvoreni na predmetu …".`,
    schema: {
      type: "object",
      properties: {
        broj_predmeta: {
          type: "string",
          description: `broj predmeta (npr. 9400/7) ili deo opisa`,
        },
      },
      required: ["broj_predmeta"],
    },
    kind: "read",
    requiredPermission: PERMISSIONS.DIRECTORY_READ,
    scopes: LICNI,
    execute: async (a, ctx) => {
      const q = term(a.broj_predmeta);
      if (!q) return PRAZAN_UPIT;
      const prisma = ctx.deps.prisma;
      const predmeti = await prisma.$queryRaw<
        { id: number; predmet: string | null }[]
      >(Prisma.sql`
        SELECT p.id, NULLIF(btrim(p.project_number), '') AS predmet,
               p.description AS opis, p.project_name AS naziv,
               p.status, c.name AS kupac,
               to_char(p.deadline, 'DD.MM.YYYY') AS rok,
               to_char(p.opened_at, 'DD.MM.YYYY') AS otvoren,
               to_char(p.closed_at, 'DD.MM.YYYY') AS zatvoren
          FROM projects p
          LEFT JOIN customers c ON c.id = p.customer_id
         WHERE ${projectMatch(Prisma.sql`p.project_number`, q)}
            OR ${unaccentLike(Prisma.sql`p.description`, q)}
         ORDER BY p.project_number
         LIMIT 5`);
      if (!predmeti.length) return { pojam: q, nadjeno: 0, predmeti: [] };

      const ids = predmeti.map((p) => p.id);
      const zbir = await prisma.$queryRaw<unknown[]>(Prisma.sql`
        SELECT wo.project_id,
               count(*)::int AS naloga_ukupno,
               count(*) FILTER (WHERE COALESCE(wo.status, false))::int AS zavrseno,
               count(*) FILTER (WHERE NOT COALESCE(wo.status, false))::int AS u_radu
          FROM work_orders wo
         WHERE wo.project_id IN (${Prisma.join(ids)})
         GROUP BY 1`);
      const otvoreni = await prisma.$queryRaw<unknown[]>(Prisma.sql`
        SELECT wo.project_id, wo.ident_number AS ident, wo.part_name AS naziv_dela,
               wo.piece_count AS kolicina,
               to_char(wo.production_deadline, 'DD.MM.YYYY') AS rok,
               hs.name AS status_primopredaje
          FROM work_orders wo
          LEFT JOIN handover_statuses hs ON hs.id = wo.handover_status_id
         WHERE wo.project_id IN (${Prisma.join(ids)})
           AND NOT COALESCE(wo.status, false)
         ORDER BY wo.production_deadline NULLS LAST, wo.ident_number
         LIMIT 10`);
      return {
        pojam: q,
        nadjeno: predmeti.length,
        predmeti,
        nalozi_zbir: zbir,
        otvoreni_nalozi: otvoreni,
      };
    },
  },
  {
    name: "tehnoloski_postupak_naloga",
    description: `TEHNOLOŠKI POSTUPAK jednog radnog naloga: sve operacije redom (redni broj, radno mesto, opis rada), planirano vreme (Tpz + Tk × komada, u satima), koliko je prijava rada evidentirano na operaciji, da li je operacija završena i koliko je STVARNO utrošeno sati. Prima ident broj RN-a. Koristi za „dokle je stigao nalog X", „koje operacije su ostale".`,
    schema: {
      type: "object",
      properties: {
        ident: { type: "string", description: `ident broj radnog naloga` },
      },
      required: ["ident"],
    },
    kind: "read",
    requiredPermission: PERMISSIONS.TEHNOLOGIJA_READ,
    scopes: LICNI,
    execute: async (a, ctx) => {
      const q = term(a.ident);
      if (!q) return PRAZAN_UPIT;
      const prisma = ctx.deps.prisma;
      const nalog = await prisma.$queryRaw<
        {
          id: number;
          ident: string;
          kolicina: number;
        }[]
      >(Prisma.sql`
        SELECT wo.id, wo.ident_number AS ident, wo.variant AS varijanta,
               wo.part_name AS naziv_dela, wo.drawing_number AS crtez,
               wo.piece_count AS kolicina,
               to_char(wo.production_deadline, 'DD.MM.YYYY') AS rok,
               CASE WHEN COALESCE(wo.status, false) THEN 'zavrsen' ELSE 'u radu' END AS status,
               NULLIF(btrim(p.project_number), '') AS predmet
          FROM work_orders wo
          LEFT JOIN projects p ON p.id = wo.project_id
         WHERE ${identMatch(Prisma.sql`wo.ident_number`, q)}
         ORDER BY wo.entered_at DESC
         LIMIT 1`);
      if (!nalog.length) return { ident: q, nadjeno: 0, operacije: [] };

      const wo = nalog[0];
      const operacije = await prisma.$queryRaw<unknown[]>(Prisma.sql`
        SELECT woo.operation_number AS rb, woo.work_center_code AS radno_mesto,
               o.work_center_name AS naziv_radnog_mesta,
               woo.work_description AS opis,
               round((COALESCE(woo.setup_time, 0)
                     + COALESCE(woo.cycle_time, 0) * ${wo.kolicina}::int)::numeric, 2) AS plan_h,
               COALESCE(tp.prijava, 0) AS prijava,
               COALESCE(tp.zavrsena, false) AS zavrsena,
               tp.poslednja_prijava,
               round(wt.stvarno_h::numeric, 2) AS stvarno_h,
               wt.kom_prijavljeno
          FROM work_order_operations woo
          LEFT JOIN operations o ON o.work_center_code = woo.work_center_code
          LEFT JOIN LATERAL (
            SELECT count(*)::int AS prijava,
                   bool_or(COALESCE(t.is_process_finished, false)) AS zavrsena,
                   to_char(max(t.entered_at), 'DD.MM.YYYY') AS poslednja_prijava
              FROM tech_processes t
             WHERE t.work_order_id = ${wo.id}
               AND t.operation_number = woo.operation_number
          ) tp ON TRUE
          LEFT JOIN LATERAL (
            SELECT SUM(EXTRACT(EPOCH FROM (w.stopped_at - w.started_at))) / 3600.0 AS stvarno_h,
                   SUM(w.piece_count)::int AS kom_prijavljeno
              FROM work_time_entries w
             WHERE w.work_order_id = ${wo.id}
               AND w.operation_number = woo.operation_number
               AND w.stopped_at IS NOT NULL
          ) wt ON TRUE
         WHERE woo.work_order_id = ${wo.id}
         ORDER BY woo.operation_number
         LIMIT 40`);
      return {
        nalog: wo,
        napomena: `Vremena su u SATIMA (plan_h = Tpz + Tk × komada). „zavrsena" dolazi iz prijava rada, ne iz statusa naloga.`,
        operacije,
      };
    },
  },
  {
    name: "prisustvo_danas",
    description: `PRISUSTVO UŽIVO sa kapije, sada: koliko je zaposlenih prisutno, koliko na pauzi i koliko odsutno, plus razrada po odeljenjima. Broji se poslednji prolaz svakog zaposlenog u zadnja 24 sata — ko nema nijedan prolaz u tom roku uopšte se ne pojavljuje. Koristi za „ko je danas u firmi", „koliko nas je na poslu".`,
    schema: { type: "object", properties: {}, required: [] },
    kind: "read",
    requiredPermission: PERMISSIONS.KADROVSKA_ATTENDANCE,
    scopes: LICNI,
    execute: async (_a, ctx) => {
      // POSTOJEĆI servis kadrovske (v_attendance_now kroz sy15 RLS pozivaoca) —
      // upit se ne prepisuje ovde (plan §2.4), samo se rezultat sažima u brojeve.
      const res = (await ctx.deps.kadrovska.attendanceNow(ctx.email)) as {
        data?: unknown;
      };
      const rows = Array.isArray(res?.data)
        ? (res.data as {
            status?: string | null;
            department?: string | null;
          }[])
        : [];
      const brojac = { prisutan: 0, pauza: 0, odsutan: 0 };
      const poOdeljenju = new Map<
        string,
        { odeljenje: string; prisutno: number; pauza: number; odsutno: number }
      >();
      for (const r of rows) {
        const status = String(r?.status ?? "odsutan");
        if (status === "prisutan") brojac.prisutan += 1;
        else if (status === "pauza") brojac.pauza += 1;
        else brojac.odsutan += 1;
        const odeljenje = String(r?.department ?? "—") || "—";
        const bucket = poOdeljenju.get(odeljenje) ?? {
          odeljenje,
          prisutno: 0,
          pauza: 0,
          odsutno: 0,
        };
        if (status === "prisutan") bucket.prisutno += 1;
        else if (status === "pauza") bucket.pauza += 1;
        else bucket.odsutno += 1;
        poOdeljenju.set(odeljenje, bucket);
      }
      return {
        prisutno: brojac.prisutan,
        pauza: brojac.pauza,
        odsutno: brojac.odsutan,
        ukupno_sa_prolazom_24h: rows.length,
        po_odeljenju: [...poOdeljenju.values()].sort((x, y) =>
          x.odeljenje.localeCompare(y.odeljenje),
        ),
        napomena: `Izvor je kapija (poslednji prolaz u 24 h). Ko nema prolaz — nije u brojkama.`,
      };
    },
  },
];
