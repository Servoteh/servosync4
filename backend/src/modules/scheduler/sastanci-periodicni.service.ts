import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma-sy15/client";
import { Sy15Service } from "../../common/sy15/sy15.service";
import {
  bazaLancaUpit,
  periodicniNaslov,
  sledeciPeriodicniTermin,
} from "../sastanci/periodicni-rollover";
import type { ScheduledJob } from "./scheduler.types";

/*
 * Periodični sastanci — automatika serije (zahtev 024/26, predlog d1 potvrđen
 * 28.07.2026: „bira se interval ponavljanja … Automatika (ista koja sada kreira
 * sedmični petkom) kreira sledeći termin po intervalu, sa pomeranjem za praznik").
 *
 * ZAŠTO U 3.0 TS, A NE NOVA sy15 FN: doktrina „na sy15 se više ništa ne gradi"
 * (odluka cutover april 2027). Sedmični kolegijum OSTAJE na postojećoj sy15
 * `sast_auto_create_weekly` (uslov predloga: bez promene za kolegijum); periodične
 * serije vozi ovaj posao — ista pravila (praznik, prenos akcija, kopija učesnika),
 * napisana ovde i ogledana u čistoj fn `sastanci/periodicni-rollover.ts` koju
 * koristi i najava u listi (da UI ne laže).
 *
 * KADA SE PRAVI SLEDEĆI TERMIN: dnevno u 08:00 (isti sat kao sedmična automatika),
 * za svaki periodični sastanak koji je REP SVOJE SERIJE (nema reda koji na njega
 * pokazuje kroz `prethodni_sastanak_id`) i koji je ZAVRŠEN (zavrsen/zakljucan/
 * otkazan) ILI mu je datum prošao (zaboravljen otvoren sastanak ne sme da uguši
 * seriju). Otkazan termin NE prekida seriju — on je rep i iz njega niče sledeći.
 *
 * IDEMPOTENTNOST: `prethodni_sastanak_id` je ključ — INSERT ide kroz
 * `WHERE NOT EXISTS (naslednik)` u ISTOJ naredbi, a parcijalni UNIQUE indeks
 * na koloni (skripta 10_, review Minor-1) je TVRDA brana: paralelni run koji
 * NOT EXISTS proklizne pada na 23505 → uhvaćen per-kandidat catch-om.
 *
 * RITAM (review MAJOR-2): sledeći termin se NE računa od upisanog datuma repa
 * (taj je mogao biti pomeren za praznik — ritam bi trajno „otplivao"), nego od
 * BAZNOG ritma lanca (`bazaLancaUpit`: koren + k·interval); pomeranje za
 * praznik se primenjuje tek na izračunati termin, a `posle` čuva da naslednik
 * ne padne pre pomerenog repa.
 *
 * VEZA SMEROM DETE→RODITELJ NAMERNO: prethodnik je tipično ZAKLJUČAN, a guard
 * triger `sast_check_not_locked` obara UPDATE zaključanog reda — zato se
 * prethodnik nikad ne dira, samo se umeće novi red koji pokazuje na njega.
 *
 * NUS-EFEKTI (paritet `sast_create_weekly_at`): kopija učesnika (pozvan=true,
 * prisutan=false) okida sy15 DEFINER triger `sast_trg_ucesnik_invite` →
 * 'meeting_invite' mejlovi (B10: BE ne piše u notification_log — triger to radi);
 * otvorene akcije (otvoren/u_toku) se PREMEŠTAJU na novi termin.
 *
 * DOK sy15 SKRIPTA NIJE PRIMENJENA (backend/docs/sql/sy15/
 * sastanci-024-periodicni-2026-08-04/10_…): kolona `prethodni_sastanak_id` ne
 * postoji → posao je no-op sa jasnim summary-jem (deploy sme pre skripte).
 * Provera kolona se NE kešira (za razliku od servisa liste) — posao ide jednom
 * dnevno pa je upit u katalog besplatan, a automatika proradi ODMAH po primeni
 * skripte, bez restarta.
 */

/** Najviše serija po jednom prolazu (brana od pomahnitalog kataloga). */
const MAX_PO_PROLAZU = 25;

/** Red-kandidat (rep serije kome treba naslednik). */
interface Kandidat {
  id: string;
  naslov: string;
  datum: string;
  vreme: string | null;
  interval_days: number;
}

@Injectable()
export class SastanciPeriodicniService {
  private readonly logger = new Logger(SastanciPeriodicniService.name);

  constructor(private readonly sy15: Sy15Service) {}

  buildJobs(): ScheduledJob[] {
    return [
      {
        key: "sast-periodicni-auto",
        description:
          "Periodični sastanci: auto-kreiranje sledećeg termina serije " +
          "(datum + interval_days, praznik pomera; prenos otvorenih akcija + " +
          "kopija učesnika → pozivnice) — 024/26",
        schedule: { kind: "daily", at: "08:00" },
        run: () => this.kreirajDospele(),
      },
    ];
  }

  /** Jedan dnevni prolaz: za svaki rep serije napravi sledeći termin. */
  async kreirajDospele(): Promise<string> {
    const db = this.sy15.db;
    const kolone = await db.$queryRaw<{ n: number }[]>(
      Prisma.sql`SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'sastanci'
          AND column_name IN ('interval_days', 'prethodni_sastanak_id')`,
    );
    if (Number(kolone[0]?.n ?? 0) !== 2) {
      return (
        "preskočeno: kolone periodične serije ne postoje — primeniti " +
        "backend/docs/sql/sy15/sastanci-024-periodicni-2026-08-04/10_…"
      );
    }

    const [kandidati, prazniciRows, danasRow] = await Promise.all([
      db.$queryRaw<Kandidat[]>(
        Prisma.sql`SELECT s.id::text AS id, s.naslov, s.datum::text AS datum,
            left(s.vreme::text, 5) AS vreme, s.interval_days
          FROM sastanci s
          WHERE s.tip = 'periodicni' AND s.interval_days IS NOT NULL
            AND (s.status IN ('zavrsen','zakljucan','otkazan')
                 OR s.datum < (now() AT TIME ZONE 'Europe/Belgrade')::date)
            AND NOT EXISTS (SELECT 1 FROM sastanci n
                            WHERE n.prethodni_sastanak_id = s.id)
          ORDER BY s.datum ASC
          LIMIT ${MAX_PO_PROLAZU}`,
      ),
      // Prozor pokriva i najduži interval (365) + pomeranja za praznike.
      db.$queryRaw<{ d: string }[]>(
        Prisma.sql`SELECT holiday_date::text AS d FROM kadr_holidays
          WHERE COALESCE(is_workday, false) = false
            AND holiday_date BETWEEN
              (now() AT TIME ZONE 'Europe/Belgrade')::date - 1
              AND (now() AT TIME ZONE 'Europe/Belgrade')::date + 420`,
      ),
      db.$queryRaw<{ danas: string }[]>(
        Prisma.sql`SELECT ((now() AT TIME ZONE 'Europe/Belgrade')::date)::text AS danas`,
      ),
    ]);
    if (!kandidati.length) return "nema dospelih periodičnih serija";

    const praznici = prazniciRows.map((p) => p.d);
    const danas = danasRow[0]?.danas ?? new Date().toISOString().slice(0, 10);

    // BAZNI ritam po repu (MAJOR-2); rep bez dohvatljivog korena pada na
    // sopstveni upisani datum (bolje i to nego ugušena serija).
    const bazaRows = await db.$queryRaw<
      { id: string; baza: string; interval_days: number | null }[]
    >(bazaLancaUpit(kandidati.map((k) => k.id)));
    const bazaMapa = new Map(bazaRows.map((b) => [b.id, b.baza]));

    let kreirano = 0;
    const opisi: string[] = [];
    for (const k of kandidati) {
      const termin = sledeciPeriodicniTermin({
        datum: bazaMapa.get(k.id) ?? k.datum,
        intervalDays: k.interval_days,
        danas,
        praznici,
        posle: k.datum,
      });
      const naslov = periodicniNaslov(k.naslov, termin);
      try {
        // Svaka serija u SVOJOJ transakciji: pad jedne (npr. konkurentno obrisan
        // izvor) ne sme da obori ostale.
        const noviId = await db.$transaction(async (tx) => {
          const ins = await tx.$queryRaw<{ id: string }[]>(
            Prisma.sql`INSERT INTO sastanci
                (tip, naslov, datum, vreme, mesto, projekat_id,
                 vodio_email, vodio_label, zapisnicar_email, zapisnicar_label,
                 status, created_by_email, pozivnice_poslate_at,
                 interval_days, prethodni_sastanak_id)
              SELECT s.tip, ${naslov}, ${termin}::date,
                     COALESCE(s.vreme, '09:00'::time), s.mesto, s.projekat_id,
                     s.vodio_email, s.vodio_label, s.zapisnicar_email, s.zapisnicar_label,
                     'planiran', 'auto@sistem', now(),
                     s.interval_days, s.id
              FROM sastanci s
              WHERE s.id = ${k.id}::uuid
                AND NOT EXISTS (SELECT 1 FROM sastanci n
                                WHERE n.prethodni_sastanak_id = s.id)
              RETURNING id::text AS id`,
          );
          const id = ins[0]?.id;
          if (!id) return null; // naslednik u međuvremenu nastao — preskoči
          // Kopija učesnika → INSERT okida invite triger (pozivnice, B10).
          await tx.$executeRaw(
            Prisma.sql`INSERT INTO sastanak_ucesnici
                (sastanak_id, email, label, pozvan, prisutan)
              SELECT ${id}::uuid, email, label, true, false
              FROM sastanak_ucesnici WHERE sastanak_id = ${k.id}::uuid`,
          );
          // Prenos otvorenih akcija (isti filter kao sast_create_weekly_at/prenos).
          await tx.$executeRaw(
            Prisma.sql`UPDATE akcioni_plan
              SET sastanak_id = ${id}::uuid, updated_at = now()
              WHERE sastanak_id = ${k.id}::uuid
                AND status IN ('otvoren','u_toku')`,
          );
          return id;
        });
        if (noviId) {
          kreirano += 1;
          opisi.push(`${k.datum}→${termin}`);
        }
      } catch (e) {
        // Loguj i nastavi — sledeći dnevni prolaz pokušava ponovo (rep je ostao).
        this.logger.error(
          `Periodična serija ${k.id} (${k.datum}) nije produžena: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }
    return `kreirano ${kreirano}/${kandidati.length}: ${opisi.join(", ") || "—"}`;
  }
}
