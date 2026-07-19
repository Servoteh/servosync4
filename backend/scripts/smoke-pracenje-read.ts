/**
 * TEMP smoke (delete after run): executes every PracenjeReadService read path
 * against a live PG (empty 4.0 dev sandbox on 5437) to validate the raw SQL —
 * recursive CTEs, LATERAL aggregates — which static review could not execute.
 * Expected on an empty DB: empty payloads or 4xx domain exceptions; any
 * P20xx/42xxx SQL error = real defect.
 *
 * Run from backend/: DATABASE_URL=<dev> npx ts-node --transpile-only scripts/tmp-smoke-pracenje-read.ts
 */
import { PrismaClient } from "@prisma/client";
import { PracenjeReadService } from "../src/modules/pracenje/pracenje-read.service";

const prisma = new PrismaClient();
// Runtime stand-in: PracenjeReadService only uses PrismaService's PrismaClient surface.
const svc = new PracenjeReadService(prisma as never);

type Check = { name: string; run: () => Promise<unknown> };

const E = "smoke@test";
const checks: Check[] = [
  { name: "portfolio", run: () => svc.portfolio(E, { lotQty: "12" } as never) },
  { name: "predmeti", run: () => svc.predmeti(E) },
  { name: "podsklopovi", run: () => svc.podsklopovi(E, 9400) },
  { name: "izvestaj", run: () => svc.izvestaj(E, 9400, { lotQty: "12" } as never) },
  { name: "rnResolve", run: () => svc.rnResolve(E, "9400") },
  { name: "rn", run: () => svc.rn(E, 1) },
  { name: "operativniPlan", run: () => svc.operativniPlan(E, 1, {} as never) },
  { name: "canEdit", run: () => svc.canEdit({ userId: 1, role: "admin" }, 1) },
  { name: "aktivnostIstorija", run: () => svc.aktivnostIstorija({ role: "admin" }, 1) },
  { name: "prijave (wo+op)", run: () => svc.prijave(E, { workOrder: "1", op: "10" } as never) },
  { name: "prijave (prazno)", run: () => svc.prijave(E, {} as never) },
  { name: "odeljenja", run: () => svc.odeljenja(E) },
  { name: "radnici", run: () => svc.radnici(E) },
  { name: "searchDelovi", run: () => svc.searchDelovi(E, "test") },
  { name: "planPrioritet", run: () => svc.planPrioritet(E) },
  { name: "crtezSignUrl", run: () => svc.crtezSignUrl(E, "1130568") },
  { name: "ensureRnFromBigtehn", run: () => svc.ensureRnFromBigtehn("1") },
];

async function main() {
  let sqlErrors = 0;
  for (const c of checks) {
    try {
      const r = await c.run();
      const s = JSON.stringify(r);
      console.log(`OK    ${c.name}: ${s.length > 140 ? s.slice(0, 140) + "…" : s}`);
    } catch (e) {
      const err = e as { name?: string; message?: string; code?: string; status?: number };
      const httpish =
        typeof (err as { getStatus?: () => number }).getStatus === "function";
      if (httpish) {
        console.log(
          `4XX   ${c.name}: ${(err as { getStatus: () => number }).getStatus()} ${err.message} (očekivano na praznoj bazi)`,
        );
      } else {
        sqlErrors += 1;
        console.log(`SQLERR ${c.name}: [${err.code ?? err.name}] ${err.message?.split("\n").slice(0, 4).join(" | ")}`);
      }
    }
  }
  console.log(sqlErrors === 0 ? "\nSMOKE PASS — nijedna SQL greška." : `\nSMOKE FAIL — ${sqlErrors} SQL grešaka.`);
  process.exitCode = sqlErrors === 0 ? 0 : 1;
}

main().finally(() => prisma.$disconnect());
