import { readFileSync } from "node:fs";
import { join } from "node:path";
import { keysetSql } from "../../../scripts/lib/keyset-checksum";

/**
 * 🔴 PROVERA PRENOSA reversa i lokacija (protivnička provera 08.08.2026, NALAZ 4).
 *
 * Dva nalaza koja ovaj fajl pinuje:
 *
 *  1. `--verify-only` je poredio SAMO `count(*)`. Skripta je čist UPSERT (nikad ne
 *     briše), a `loc_item_placements` se u sy15 BRIŠE kad količina padne na 0. Jedno
 *     premeštanje između dva `--apply` ostavlja fantomski red, brojevi se poklope, i
 *     verify javi 🟢 — a runbook §6 na taj 🟢 naslanja odluku o preklopu.
 *  2. `--apply` je bio prvi upis: BLOKADE su se otkrivale TOKOM pisanja, pa je
 *     blokiran `rev_documents` red obarao sledeći batch na FK i ostavljao delimično
 *     popunjenu bazu.
 *
 * `keysetSql` je izdvojen u `scripts/lib/` baš da bi (1) mogao da se testira stvarno,
 * a ne samo pročita — `backend/scripts/**` je van `jest rootDir: src`. (2) se pinuje
 * statički nad izvorom skripte, obrazac iz `odrzavanje.set-role-discipline.spec.ts`.
 */

describe("keysetSql — otisak skupa ključeva", () => {
  it("prost ključ: broji redove i md5-uje sortirane ključeve", () => {
    const sql = keysetSql({ table: "rev_tools", key: ["id"] }, "public.");
    expect(sql).toContain(`count(*)::bigint AS n`);
    expect(sql).toContain(`md5(string_agg(k, ',' ORDER BY k))`);
    expect(sql).toContain(`SELECT "id"::text AS k FROM public."rev_tools"`);
  });

  it("🔴 složen ključ ide kroz concat_ws — bez razdvajača bi se (ab,c) i (a,bc) lažno poklopili", () => {
    const sql = keysetSql(
      { table: "rev_cutting_tool_stock", key: ["catalog_id", "location_id"] },
      "",
    );
    expect(sql).toContain(
      `concat_ws('|', "catalog_id"::text, "location_id"::text)`,
    );
    // Bez `public.` prefiksa na odredištu (search_path 3.0 baze).
    expect(sql).toContain(`FROM "rev_cutting_tool_stock"`);
    expect(sql).not.toContain("public.");
  });

  it("prazna tabela daje '-' umesto NULL — dve prazne tabele moraju biti 🟢", () => {
    // `string_agg` nad nula redova vraća NULL; `NULL !== NULL` bi lažno javio 🔴.
    expect(keysetSql({ table: "t", key: ["id"] }, "")).toContain(
      `coalesce(md5(string_agg(k, ',' ORDER BY k)), '-')`,
    );
  });

  it("ključ MORA postojati — otisak bez ključa nema smisla i pada glasno", () => {
    expect(() => keysetSql({ table: "t", key: [] }, "")).toThrow(/bez ključa/);
  });

  it("🔴 ORDER BY je deo ugovora: bez njega otisak zavisi od redosleda čitanja", () => {
    // Postgres ne garantuje redosled bez ORDER BY, pa bi ista baza umela da da
    // dva različita otiska i verify bi lažno prijavio neslaganje.
    expect(keysetSql({ table: "t", key: ["id"] }, "")).toMatch(/ORDER BY k/);
  });
});

describe("migrate-reversi-lokacije-sy15.ts — brane u `--apply`", () => {
  const SRC = readFileSync(
    join(
      __dirname,
      "..",
      "..",
      "..",
      "scripts",
      "migrate-reversi-lokacije-sy15.ts",
    ),
    "utf8",
  );

  it("🔴 `--apply` odbija upis kad postoji blokada", () => {
    expect(SRC).toContain("if (blockers.length > 0)");
    // Odbijanje mora biti VIDLJIVO pozivaocu, ne samo u tekstu na ekranu.
    expect(SRC).toMatch(
      /blockers\.length > 0[\s\S]{0,600}process\.exitCode = 1/,
    );
  });

  it("🔴 plan prolaz (bez upisa) ide PRE upisnog prolaza", () => {
    const plan = SRC.indexOf("transferTable(prisma, sy15, spec, maps, false)");
    const upis = SRC.indexOf("transferTable(prisma, sy15, spec, maps, true)");
    expect(plan).toBeGreaterThan(-1);
    expect(upis).toBeGreaterThan(-1);
    expect(plan).toBeLessThan(upis);
  });

  it("izveštaj se briše između prolaza — inače bi se brojevi udvostručili", () => {
    expect(SRC).toContain("resetReport();");
  });

  it("`--verify-only` vraća izlazni kod 1 na neslaganje", () => {
    expect(SRC).toMatch(
      /VERIFY_ONLY[\s\S]{0,400}mismatch > 0[\s\S]{0,120}process\.exitCode = 1/,
    );
  });

  it("provera koristi otisak ključeva, ne samo count(*)", () => {
    expect(SRC).toContain("keysetSql(spec,");
  });
});
