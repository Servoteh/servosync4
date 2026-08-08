/**
 * PREVOD IDENTITETA — popuna/održavanje `users.sy15_user_id` (3.0) po mejlu.
 *
 * Migracija `20260808100000_users_sy15_user_id_prevod_identiteta` je uvela kolonu
 * i popunila 61 par izmeren 08.08.2026. Ovaj skript radi ISTI posao UŽIVO, nad
 * obe baze — za sve što se u međuvremenu promenilo: nov nalog u sy15, promenjen
 * mejl u 3.0, nalog koji je tek dobio parnjaka.
 *
 * ZAŠTO POSTOJI I POSLE MIGRACIJE: migracija se izvršava jednom i NE MOŽE da čita
 * sy15 (druga baza, nema dblink/FDW), pa su parovi u njoj snimak jednog trenutka.
 * Sve posle toga traži merenje uživo. A merenje mora da PRIJAVI nalog bez
 * parnjaka: bez veze u ovoj koloni, dodela tog čoveka pod `ODRZAVANJE_IZVOR=3.0`
 * pada sa 422 (v. `src/common/identity/sy15-user-id.ts`).
 *
 * 🔴 UPARIVANJE NIJE PREPISANO NEGO POZAJMLJENO: `scripts/lib/sy15-identity.ts`
 * (`buildUserMaps`) je isti helper koji su koristile prenosne skripte koraka 1 i 2.
 * Druga kopija pravila „po `lower(trim(email))`" značila bi dva izvora istine o
 * tome ko je ko — tačno klasa greške zbog koje je isti radni nalog dvaput
 * prijavljen (duplirana logika numeracije RN-a).
 *
 * 🔴 SUHO POKRETANJE JE PODRAZUMEVANO — bez `--apply` ništa se ne piše.
 * Postojeća veza se NIKAD ne pregazi (`sy15_user_id IS NULL` uslov i u upitu):
 * ako je nekome veza ručno ispravljena, skript je ne dira nego prijavi razliku.
 *
 * KONEKCIJE (iz backend/.env, kao migrate-odrzavanje-sy15.ts):
 *   - izvor sy15  : SY15_DATABASE_URL  (@prisma-sy15/client, sirovi SELECT)
 *   - odredište   : DATABASE_URL       (@prisma/client)
 *
 * POKRETANJE:
 *   npx ts-node --transpile-only backend/scripts/povezi-identitet-sy15.ts           # dry-run
 *   npx ts-node --transpile-only backend/scripts/povezi-identitet-sy15.ts --apply   # upis
 *
 * Izlazni kod: 0 = sve povezano · 1 = ima naloga bez parnjaka / razlika · 2 = greška.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { PrismaClient as Sy15PrismaClient } from "@prisma-sy15/client";
import { buildUserMaps, normEmail } from "./lib/sy15-identity";

/** Env bootstrap bez dotenv zavisnosti — isti obrazac kao ostale seoba-skripte. */
function loadEnv(): void {
  const envPath = resolve(__dirname, "..", ".env");
  if (!existsSync(envPath)) return;
  for (const rawLine of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

const APPLY = process.argv.includes("--apply");

/**
 * Sistemski nalog UGAŠENOG BIGTEHN mosta (07.08.2026, 4669 prolaza / 0 izmena).
 * NAMERNO nema 3.0 parnjaka: pravljenje naloga za mrtav sistem uvelo bi novo
 * stanje koje niko nije tražio, a nalog bez ijedne dodele nema šta da prevede.
 * Ostaje na spisku (ne briše se iz merenja) — samo se ne broji kao blokada.
 */
const NAMERNO_BEZ_PARNJAKA = new Set(["bigtehn-worker@system.local"]);

async function main(): Promise<void> {
  loadEnv();
  for (const key of ["DATABASE_URL", "SY15_DATABASE_URL"]) {
    if (!process.env[key]) {
      console.error(`Nedostaje env ${key}.`);
      process.exitCode = 2;
      return;
    }
  }

  // 🔴 DVA KLIJENTA — isti rizik kao u `odrzavanje.service.ts`: zamena jednog
  // drugim ne pada nego tiho čita/piše POGREŠNU bazu.
  const prisma = new PrismaClient();
  const sy15 = new Sy15PrismaClient();

  try {
    // 🔴 `ANALYZE` pa `count(*)`: `pg_stat_*.n_live_tup` NIJE broj redova
    // (zamalo brisanje 186k živih redova, jul 2026).
    await prisma.$executeRawUnsafe("ANALYZE users");
    await sy15.$executeRawUnsafe("ANALYZE auth.users");

    const mape = await buildUserMaps(prisma, sy15);

    const trenutne = await prisma.user.findMany({
      select: { id: true, email: true, sy15UserId: true },
    });
    const poId = new Map(trenutne.map((u) => [u.id, u]));

    const zaUpis: { id: number; email: string; sy15Id: string }[] = [];
    const razlike: { id: number; email: string; imao: string; sy15: string }[] =
      [];
    let vecPovezano = 0;

    for (const [uuid, userId] of mape.byAuthUuid) {
      const u = poId.get(userId);
      if (!u) continue;
      const mejl = normEmail(u.email) ?? String(u.id);
      if (u.sy15UserId === null) {
        zaUpis.push({ id: u.id, email: mejl, sy15Id: uuid });
      } else if (u.sy15UserId.toLowerCase() !== uuid) {
        razlike.push({
          id: u.id,
          email: mejl,
          imao: u.sy15UserId,
          sy15: uuid,
        });
      } else {
        vecPovezano += 1;
      }
    }

    const bezSy15 = trenutne.filter((u) => u.sy15UserId === null).length;

    console.log("PREVOD IDENTITETA sy15 -> 3.0");
    console.log(`  3.0  users        : ${trenutne.length}`);
    console.log(
      `  sy15 auth.users   : ${mape.byAuthUuid.size + mape.unmatchedAuthUuids.length}`,
    );
    console.log(`  već povezano      : ${vecPovezano}`);
    console.log(`  za povezivanje    : ${zaUpis.length}`);
    console.log(`  3.0 bez sy15 veze : ${bezSy15}`);

    // 🔴 Nalog bez parnjaka se PRIJAVLJUJE, ne preskače tiho: tišina bi značila
    // „prevod uspešan", a dodela tog čoveka bi i dalje padala sa 422.
    let blokade = 0;
    for (const s of mape.unmatchedAuthUuids) {
      const namerno = s.email !== null && NAMERNO_BEZ_PARNJAKA.has(s.email);
      if (!namerno) blokade += 1;
      console.log(
        namerno
          ? `  NAPOMENA: sy15 ${s.email} (${s.id}) — sistemski nalog ugašenog BIGTEHN mosta, NAMERNO bez 3.0 naloga`
          : `  BEZ PARNJAKA: sy15 ${s.email ?? "(bez mejla)"} (${s.id}) — nema 3.0 naloga sa tim mejlom; dodela na njega pada sa 422`,
      );
    }

    for (const r of razlike) {
      console.log(
        `  RAZLIKA: users.id=${r.id} (${r.email}) ima sy15_user_id=${r.imao}, a sy15 kaže ${r.sy15} — NE diram, presudi ručno`,
      );
    }

    if (!APPLY) {
      console.log(
        zaUpis.length
          ? `\nSUHO POKRETANJE — ${zaUpis.length} veza NIJE upisano. Ponovi sa --apply.`
          : "\nSUHO POKRETANJE — nema šta da se upiše.",
      );
    } else {
      for (const v of zaUpis) {
        // `sy15_user_id IS NULL` i u upitu: štiti od promene između merenja i upisa.
        const n = await prisma.$executeRaw`
          UPDATE users SET sy15_user_id = ${v.sy15Id}::uuid
           WHERE id = ${v.id} AND sy15_user_id IS NULL`;
        console.log(
          n
            ? `  + povezan users.id=${v.id} (${v.email}) -> ${v.sy15Id}`
            : `  ! users.id=${v.id} (${v.email}) je u međuvremenu već povezan — preskočen`,
        );
      }
      console.log(`\nUpisano veza: ${zaUpis.length}`);
    }

    process.exitCode = blokade > 0 || razlike.length > 0 ? 1 : 0;
  } finally {
    await prisma.$disconnect();
    await sy15.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
