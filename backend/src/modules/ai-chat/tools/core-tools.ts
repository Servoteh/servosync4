import { Prisma } from "@prisma/client";
import { PERMISSIONS } from "../../../common/authz/permissions";
import type { AiTool, ToolScope } from "./tool-registry";
import {
  estimateByWorkCenter,
  estimateForDrawing,
} from "../../work-orders/time-estimate.service";
import { suggestForDrawing } from "../../work-orders/technology-suggest.service";

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

/**
 * Najkraći pojam koji sme u trigram pretragu. NIJE proizvoljno: `pg_trgm` gradi
 * trigrame (3 znaka), pa za pojam kraći od 3 znaka indeks NE MOŽE da se koristi
 * i upit pada na Seq Scan preko cele tabele. Model ume da pozove alat sa „a" —
 * to je Seq Scan nad 92k redova za rezultat koji ionako nije upotrebljiv.
 */
const MIN_POJAM = 3;

/**
 * LIKE '%pojam%' nad INDEKSIRANIM izrazom (dijakritika i velika slova nebitni).
 *
 * EXPORTOVANO NAMERNO: `test/ai-tools-trigram.e2e-spec.ts` gradi upit baš ovom
 * funkcijom i EXPLAIN-om proverava da plan koristi trigram indeks. Ako se izraz
 * ovde ikada raziđe sa migracijom 20260726160000 (npr. nestane `lower`), test
 * pada — umesto da pretraga tiho postane Seq Scan koji niko ne primeti.
 *
 * `%`, `_` i `\` u pojmu se ESKEJPUJU: bez toga „50%" znači „50 + bilo šta",
 * a „a_b" poklapa „axb" — korisnik dobija tuđe redove. Escape ide PRE unaccent-a
 * (obrnutu kosu crtu unaccent ne dira), a `LIKE` u PostgreSQL-u podrazumevano
 * tumači `\` kao escape.
 */
export function unaccentLike(column: Prisma.Sql, term: string): Prisma.Sql {
  const escaped = term.replace(/[\\%_]/g, "\\$&");
  return Prisma.sql`public.immutable_unaccent(lower(${column})) LIKE '%' || public.immutable_unaccent(lower(${escaped})) || '%'`;
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

/** Prekratak pojam — vidi `MIN_POJAM` (bez 3 znaka nema trigram indeksa). */
const PREKRATAK_UPIT = {
  greska: "prekratak_upit",
  poruka: `Pojam mora imati bar ${MIN_POJAM} znaka — sa kraćim pojmom pretraga nije upotrebljiva. Pitaj korisnika za precizniji pojam.`,
};

/** `null` = pojam je u redu; inače gotov odgovor za model. */
function proveriPojam(q: string): typeof PRAZAN_UPIT | null {
  if (!q) return PRAZAN_UPIT;
  if (q.length < MIN_POJAM) return PREKRATAK_UPIT;
  return null;
}

/**
 * LIMIT+1 SENTINEL. Bez njega model dobija „nadjeno: 15" na kapi od 15 i to
 * saopšti kao UKUPAN broj („ima 15 naloga") — a stvarno ih može biti 400.
 * Namerno NE koristimo `count(*) OVER ()`: prozorska funkcija mora da prebroji
 * SVE poklapajuće redove i time ubija top-N plan (LIMIT prestaje da štedi rad).
 * Umesto toga tražimo jedan red viška: ako stigne, znamo da ima još — a ne
 * koliko, što je tačno ono što se sme reći.
 */
function odseci<T>(
  rows: T[],
  limit: number,
): { redovi: T[]; nadjeno: string | number; ima_jos: boolean } {
  const ima_jos = rows.length > limit;
  const redovi = ima_jos ? rows.slice(0, limit) : rows;
  return { redovi, nadjeno: ima_jos ? `>= ${limit}` : redovi.length, ima_jos };
}

const LIMIT_NALOZI = 15;
const LIMIT_ARTIKLI = 15;
const LIMIT_PREDMETI = 5;

/**
 * Prijava rada koja ULAZI u računicu stvarnog vremena. Dva filtera šuma
 * (izmereno, plan §2.2): 47% prijava je zatvoreno za manje od minuta — to su
 * knjiženja/ispravke, ne rad — a `auto_closed` sesije je zatvorio sistem (radnik
 * je zaboravio izlaz), pa im je trajanje izmišljeno. Bez ovoga „stvarno vreme"
 * ima medijanu blizu nule i poređenje sa planom je besmisleno.
 */
const PRIJAVA_VALIDNA = Prisma.sql`w.stopped_at IS NOT NULL
       AND w.stopped_at >= w.started_at + interval '1 minute'
       AND NOT COALESCE(w.auto_closed, false)`;

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
      const lose = proveriPojam(q);
      if (lose) return lose;
      const redovi = await ctx.deps.prisma.$queryRaw<unknown[]>(Prisma.sql`
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
         LIMIT ${LIMIT_NALOZI + 1}`);
      const { redovi: nalozi, nadjeno, ima_jos } = odseci(redovi, LIMIT_NALOZI);
      return {
        pojam: q,
        nadjeno,
        ima_jos,
        ...(ima_jos
          ? {
              napomena: `Prikazano je prvih ${LIMIT_NALOZI} (najnovijih) — ima ih JOŠ. Ne navodi ukupan broj; traži uži pojam.`,
            }
          : {}),
        nalozi,
      };
    },
  },
  {
    name: "istorija_crteza",
    description: `ISTORIJA JEDNOG CRTEŽA — svi raniji radni nalozi za isti broj crteža, sa PLANIRANIM (Tpz + Tk × komada, u satima) i STVARNIM vremenom po RADNOM MESTU (median i donji raspon PO NALOGU, iz prijava rada). Odgovara na „koliko je puta rađen ovaj crtež i koliko je trajalo". Prima broj crteža ILI ident broj RN-a (tada sam nađe crtež tog naloga). Vraća agregat po radnom mestu + poslednjih 10 naloga.`,
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
      const lose = proveriPojam(q);
      if (lose) return lose;
      const prisma = ctx.deps.prisma;

      // IDENT RN-a → crtež (trigram identMatch — delimičan ident radi), pa DELEGIRAJ
      // na deljeni `estimateForDrawing` (review [5]): isti izvor (`tech_processes`) i
      // isti filter (`TP_VALIDNA`: <1 min, >720 h, zero-piece) kao alat
      // `procena_vremena` i REST `/tehnologija/time-estimate` — dva alata više ne
      // daju kontradiktoran odgovor na isto pitanje. RANIJE je ovaj čitao
      // `work_time_entries` (na produ ~950 redova → skoro prazna istorija).
      const poIdentu = await prisma.$queryRaw<{ crtez: string }[]>(Prisma.sql`
        SELECT wo.drawing_number AS crtez FROM work_orders wo
         WHERE ${identMatch(Prisma.sql`wo.ident_number`, q)}
           AND COALESCE(btrim(wo.drawing_number), '') <> ''
         ORDER BY wo.entered_at DESC LIMIT 1`);
      const crtez = poIdentu[0]?.crtez ?? q;
      return estimateForDrawing(prisma, crtez, { skipIdentResolve: true });
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
      const lose = proveriPojam(q);
      if (lose) return lose;
      const redovi = await ctx.deps.prisma.$queryRaw<unknown[]>(Prisma.sql`
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
         LIMIT ${LIMIT_ARTIKLI + 1}`);
      const {
        redovi: artikli,
        nadjeno,
        ima_jos,
      } = odseci(redovi, LIMIT_ARTIKLI);
      return {
        pojam: q,
        nadjeno,
        ima_jos,
        napomena:
          `„stanje_mrp"/„stanje_magacini" prazno = zaliha se za taj artikal ne vodi u 3.0 (BigBit je i dalje izvor).` +
          (ima_jos
            ? ` Prikazano je prvih ${LIMIT_ARTIKLI} po nazivu — ima ih JOŠ; ne navodi ukupan broj, traži uži pojam.`
            : ``),
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
      // Kratak pojam (npr. „7") NIJE odbijen kao kod ostalih alata — broj
      // predmeta sme biti kratak, a ta grana je tačno poklapanje (bez trigrama).
      // Odbija se samo trigram grana po opisu, koja bi na <3 znaka bila Seq Scan.
      const poOpisu = q.length >= MIN_POJAM;
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
            ${poOpisu ? Prisma.sql`OR ${unaccentLike(Prisma.sql`p.description`, q)}` : Prisma.empty}
         ORDER BY p.project_number
         LIMIT ${LIMIT_PREDMETI + 1}`);
      const {
        redovi: predmetiPrikaz,
        nadjeno,
        ima_jos,
      } = odseci(predmeti, LIMIT_PREDMETI);
      if (!predmetiPrikaz.length) {
        return {
          pojam: q,
          nadjeno: 0,
          predmeti: [],
          predlog: `Nema predmeta sa tačno tim brojem${poOpisu ? " ni sa tim pojmom u opisu" : ""}. Ako korisnik traži nalog a ne predmet, pozovi nadji_radni_nalog sa istim pojmom.`,
        };
      }

      // PER-SEKCIJA PERMISIJA (review nalaz 0): ulazna permisija ovog alata je
      // `directory.read` (predmeti), ali lista radnih naloga je RN domen. Bez
      // ove provere alat bi bio zaobilaznica — korisnik kome je `rn.read`
      // izričito ODUZET dobio bi naloge kroz „šta je sa predmetom X".
      if (!ctx.permissions?.has(PERMISSIONS.RN_READ)) {
        return {
          pojam: q,
          nadjeno,
          ima_jos,
          predmeti: predmetiPrikaz,
          napomena: `Nalozi izostavljeni — korisnik nema pravo na radne naloge. Prikaži samo podatke o predmetu i reci da spisak naloga ne možeš da daš.`,
        };
      }

      const ids = predmetiPrikaz.map((p) => p.id);
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
         LIMIT 11`);
      const { redovi: otvoreniPrikaz, ima_jos: jos_naloga } = odseci(
        otvoreni,
        10,
      );
      return {
        pojam: q,
        nadjeno,
        ima_jos,
        predmeti: predmetiPrikaz,
        // `nalozi_zbir` je pun COUNT (bez LIMIT-a) — to je jedini tačan ukupan
        // broj koji model sme da izgovori; `otvoreni_nalozi` je isečak.
        nalozi_zbir: zbir,
        otvoreni_nalozi: otvoreniPrikaz,
        ima_jos_otvorenih: jos_naloga,
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
      const lose = proveriPojam(q);
      if (lose) return lose;
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
      if (!nalog.length) {
        return {
          ident: q,
          nadjeno: 0,
          operacije: [],
          predlog: `Nijedan nalog nema tačno taj ident broj. Pozovi nadji_radni_nalog sa istim pojmom (delimična pretraga po identu i nazivu dela), pa ponovi sa tačnim identom iz rezultata.`,
        };
      }

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
               wt.kom_prijavljeno, wt.prijava_izbaceno
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
            -- Isti filter šuma kao u istorija_crteza: prijave kraće od minuta su
            -- knjiženja, a auto_closed je sistem zatvorio umesto radnika. Broj
            -- izbačenih ide U REZULTAT (prijava_izbaceno) — model mora znati da
            -- je uzorak filtriran. Indeks: idx_work_time_entries_work_order.
            SELECT SUM(EXTRACT(EPOCH FROM (w.stopped_at - w.started_at)))
                     FILTER (WHERE ${PRIJAVA_VALIDNA}) / 3600.0 AS stvarno_h,
                   SUM(w.piece_count) FILTER (WHERE ${PRIJAVA_VALIDNA})::int AS kom_prijavljeno,
                   count(*) FILTER (WHERE NOT (${PRIJAVA_VALIDNA}))::int AS prijava_izbaceno
              FROM work_time_entries w
             WHERE w.work_order_id = ${wo.id}
               AND w.operation_number = woo.operation_number
          ) wt ON TRUE
         WHERE woo.work_order_id = ${wo.id}
         ORDER BY woo.operation_number
         LIMIT 40`);
      return {
        nalog: wo,
        napomena: `Vremena su u SATIMA (plan_h = Tpz + Tk × komada). „zavrsena" dolazi iz prijava rada, ne iz statusa naloga. „stvarno_h" ne uključuje prijave kraće od minuta (knjiženja) ni automatski zatvorene sesije — koliko ih je izbačeno po operaciji piše u „prijava_izbaceno"; ako je taj broj veći od nule, reci da je uzorak filtriran.`,
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
  {
    // TALAS AI-5 — statistička (NE LLM) procena vremena. Deli tačno istu SQL
    // logiku kao endpoint `/tehnologija/time-estimate/*` (pure funkcije iz
    // work-orders/time-estimate.service). Filter šuma i simetrična agregacija
    // (po nalogu+radnom mestu) su isti kao u `istorija_crteza`.
    name: "procena_vremena",
    description: `PROCENA STVARNOG VREMENA iz istorije proizvodnje (statistika, ne norma). Dva režima: (1) po RADNOM MESTU (šifra RC, npr. „3.18") → koliko slični poslovi STVARNO traju po komadu na tom radnom mestu, kao interval p25–p75 h/kom sa medijanom i brojem opservacija (n); (2) po BROJU CRTEŽA (ili ident broju RN-a) → koliko je puta taj crtež rađen i koliko je trajao po radnom mestu (sati po nalogu, plan vs stvarno). Vremena u SATIMA; mali n je označen kao nepouzdan; ne menja normativ. Koristi za „koliko traje glodanje po komadu", „koliko je trajao ovaj crtež ranije".`,
    schema: {
      type: "object",
      properties: {
        radno_mesto: {
          type: "string",
          description: `šifra radnog mesta (RC), npr. „3.18" ili „2.1"`,
        },
        crtez: {
          type: "string",
          description: `broj crteža ili ident broj RN-a (za istoriju istog crteža)`,
        },
      },
      required: [],
    },
    kind: "read",
    requiredPermission: PERMISSIONS.TEHNOLOGIJA_READ,
    scopes: LICNI,
    execute: async (a, ctx) => {
      const crtez = term(a.crtez);
      const rm = term(a.radno_mesto);
      if (crtez) return estimateForDrawing(ctx.deps.prisma, crtez);
      if (rm) return estimateByWorkCenter(ctx.deps.prisma, rm);
      return {
        greska: "prazan_upit",
        poruka: "Navedi radno mesto (RC šifra) ili broj crteža.",
      };
    },
  },
  {
    // TALAS AI-6 — predlog tehnologije iz istorije crteža (statistika + reuse
    // AI-5). Deli pure funkciju `suggestForDrawing` sa endpointom
    // `/tehnologija/suggest/drawing`. Read-only: NE upisuje tehnologiju.
    name: "predlozi_tehnologiju",
    description: `PREDLOG TEHNOLOŠKOG POSTUPKA za crtež koji je VEĆ RAĐEN — iz prošlih naloga istog crteža sklopi reprezentativan ruting: redosled operacija (redni broj, radno mesto, opis), plan (Tpz priprema po nalogu + Tk ciklus po komadu, u satima) i STVARNU procenu vremena po radnom mestu (interval h/kom sa uzorkom n). Prima broj crteža ILI ident broj RN-a. Ako se rutinzi između naloga razlikuju, prijavljuje to (npr. „2 različita postupka") i predlaže najčešći. Ako crtež nema istoriju, kaže to jasno. Koristi za „kako se pravio ovaj crtež", „predloži tehnologiju za crtež X". PREDLOG je informativan — ne upisuje tehnologiju.`,
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
      const lose = proveriPojam(q);
      if (lose) return lose;
      const res = await suggestForDrawing(ctx.deps.prisma, q);
      if (!("ima_istoriju" in res) || res.ima_istoriju === false) return res;
      // KOMPAKCIJA za model (svaki red se plaća tokenima): operacije se svode na
      // rb/RM/opis/plan + median stvarnog h/kom sa n; pun payload (kvantili, dokazi)
      // živi na REST endpointu za FE panel.
      return {
        ima_istoriju: true,
        crtez: res.crtez,
        osnov_naloga: res.osnov_naloga,
        konzistentno: res.konzistentno,
        broj_varijanti: res.broj_varijanti,
        reprezentativan_nalog: res.reprezentativan_nalog,
        operacije: res.operacije.map((op) => ({
          rb: op.rb,
          radno_mesto: op.radno_mesto,
          naziv_radnog_mesta: op.naziv_radnog_mesta,
          opis: op.opis,
          plan_tpz: op.plan_tpz,
          plan_tk: op.plan_tk,
          stvarno_h_kom_med: op.rm_procena?.p50 ?? null,
          n: op.rm_procena?.n ?? 0,
          malo_podataka: op.rm_procena?.malo_podataka ?? true,
        })),
        napomena: res.napomena,
      };
    },
  },
];
