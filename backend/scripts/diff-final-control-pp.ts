/**
 * M6 DIFF ALAT (plan §4.1 / §8, F5b) — READ-ONLY.
 *
 * Uporedi, nad GLAVNOM bazom, dva kanona ZAVRŠNE KONTROLE za Plan proizvodnje:
 *   (A) STARA sy15 heuristika `production._pracenje_line_is_final_control` (kanon #4,
 *       prevedena na `operations` kolone):
 *         code ~ '^8\.3'  OR  (without_process AND name ~* '(zavr|final|zav\.\s*kontr|zavrsna|kontrol)')
 *   (B) NATIVE kanon (M6, presuđeno): `operations.significant_for_finishing`.
 *
 * Ispisuje šifre operacija (work_center_code) gde se (A) i (B) RAZLIKUJU — za RUČNI
 * pregled PRE preklopa (razlika u skupu menja koji RN „ispada" iz plana kroz
 * `plan_rn_final_control_done`). Uz svaku šifru: broj `work_order_operations` redova i
 * broj RAZLIČITIH RN-ova koji je koriste (procena uticaja).
 *
 * Pokretanje:  ts-node scripts/diff-final-control-pp.ts [DATABASE_URL]
 *   (DATABASE_URL iz argv[2] ili env). Ništa ne menja u bazi.
 */
import { PrismaClient } from "@prisma/client";

const HEURISTIC_SQL = `(
  o.work_center_code ~ '^8\\.3'
  OR (
    COALESCE(o.without_process, false)
    AND COALESCE(o.work_center_name, '') ~* '(zavr|final|zav\\.\\s*kontr|zavrsna|kontrol)'
  )
)`;

interface DiffRow {
  work_center_code: string;
  work_center_name: string | null;
  without_process: boolean | null;
  heuristic: boolean;
  native_flag: boolean;
  woo_count: number;
  rn_count: number;
}

async function main(): Promise<void> {
  const url = process.argv[2] || process.env.DATABASE_URL;
  if (!url) {
    console.error(
      "Nedostaje DATABASE_URL (argv[2] ili env). Pokreni: ts-node scripts/diff-final-control-pp.ts <DATABASE_URL>",
    );
    process.exit(2);
  }
  const prisma = new PrismaClient({ datasources: { db: { url } } });

  try {
    const rows = await prisma.$queryRawUnsafe<DiffRow[]>(`
      SELECT o.work_center_code,
             o.work_center_name,
             o.without_process,
             ${HEURISTIC_SQL} AS heuristic,
             COALESCE(o.significant_for_finishing, false) AS native_flag,
             COALESCE(w.woo_count, 0)::int AS woo_count,
             COALESCE(w.rn_count, 0)::int AS rn_count
        FROM operations o
        LEFT JOIN (
          SELECT work_center_code, count(*) AS woo_count,
                 count(DISTINCT work_order_id) AS rn_count
            FROM work_order_operations
           GROUP BY work_center_code
        ) w ON w.work_center_code = o.work_center_code
       WHERE ${HEURISTIC_SQL} <> COALESCE(o.significant_for_finishing, false)
       ORDER BY (COALESCE(w.woo_count, 0)) DESC, o.work_center_code ASC`);

    const total = await prisma.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM operations`,
    );

    // Sažetak po smeru razlike.
    const onlyHeuristic = rows.filter((r) => r.heuristic && !r.native_flag);
    const onlyNative = rows.filter((r) => !r.heuristic && r.native_flag);

    console.log("== M6 DIFF: završna kontrola (sy15 heuristika vs native significant_for_finishing) ==");
    console.log(`operations ukupno: ${total[0]?.n ?? 0}; razlika u ${rows.length} šifri(a).`);
    console.log(
      `  heuristika DA / native NE (ispale bi iz „završne" u native-u): ${onlyHeuristic.length}`,
    );
    console.log(
      `  heuristika NE / native DA (nove „završne" u native-u):          ${onlyNative.length}`,
    );
    console.log("");

    if (rows.length === 0) {
      console.log("Nema razlike — kanoni se poklapaju. Preklop bezbedan po M6.");
    } else {
      console.log(
        "code       | heur | nat  | woo    | rn     | name",
      );
      console.log(
        "-----------+------+------+--------+--------+---------------------------",
      );
      for (const r of rows) {
        console.log(
          `${r.work_center_code.padEnd(10)} | ${(r.heuristic ? "DA" : "ne").padEnd(4)} | ${(r.native_flag ? "DA" : "ne").padEnd(4)} | ${String(r.woo_count).padStart(6)} | ${String(r.rn_count).padStart(6)} | ${r.work_center_name ?? ""}`,
        );
      }
      console.log("");
      console.log(
        "Pregledaj rucno: sifre sa velikim woo/rn najvise menjaju koji RN-ovi ispadaju iz plana.",
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error("diff-final-control-pp GREŠKA:", e instanceof Error ? e.message : e);
  process.exit(1);
});
