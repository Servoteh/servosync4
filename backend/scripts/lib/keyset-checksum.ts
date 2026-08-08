/**
 * Otisak SKUPA KLJUČEVA jedne tabele — uz `count(*)` čini proveru prenosa (§5.1
 * runbook-a docs/SEOBA_REVERSI_LOKACIJE_2026-08-07.md).
 *
 * 🔴 ZAŠTO POSTOJI (protivnička provera 08.08.2026, NALAZ 4)
 * `migrate-reversi-lokacije-sy15.ts` je čist UPSERT — NIKAD ne briše. A
 * `loc_item_placements` se u sy15 BRIŠE kad količina padne na 0 (triger
 * `loc_after_movement_insert`). Znači: jedno premeštanje između dva `--apply`
 * (nestane red A, nastane red B) ostavlja u 3.0 fantomski red A — i `count(*)` se
 * SAVRŠENO POKLOPI, a baze se raziđu. Otisak nad skupom ključeva to hvata.
 *
 * Zašto samo ključevi, a ne ceo red: kolone identiteta se po definiciji razlikuju
 * između baza (`auth.users` uuid → `users.id` Int), pa otisak nad svim kolonama ne
 * bi mogao da se poklopi. Ključevi su uuid/text u obe baze, dakle `::text` je
 * deterministički — bez rizika od vremenske zone (`timestamptz`) ili skale (`numeric`).
 *
 * Izdvojeno iz skripte da bi moglo da se testira: `backend/scripts/**` je van
 * `jest rootDir: src`, pa se ono što ostane u samoj skripti ne može pokriti testom.
 */

/** Minimum koji je otisku potreban iz `TableSpec`-a prenosne skripte. */
export interface KeysetTarget {
  table: string;
  /** Kolone primarnog ključa; ista imena u sy15 i u 3.0 (v. `ON CONFLICT` u skripti). */
  key: string[];
}

/**
 * `SELECT count(*) AS n, md5(<sortirani ključevi>) AS ck FROM <schema><table>`.
 *
 * `schema` je `"public."` za sy15 izvor, `""` za 3.0 odredište (search_path).
 * Prazna tabela daje `ck = '-'` (a ne NULL), da poređenje dve prazne tabele bude 🟢.
 */
export function keysetSql(spec: KeysetTarget, schema: string): string {
  if (spec.key.length === 0) {
    throw new Error(`${spec.table}: otisak bez ključa nije moguć.`);
  }
  const kols = spec.key.map((c) => `"${c}"::text`).join(", ");
  // Složen ključ ide kroz `concat_ws('|', …)` — razdvojnik sprečava da se
  // ("ab","c") i ("a","bc") slepe u isti niz i lažno poklope.
  const kexpr = spec.key.length === 1 ? kols : `concat_ws('|', ${kols})`;
  return (
    `SELECT count(*)::bigint AS n, ` +
    `coalesce(md5(string_agg(k, ',' ORDER BY k)), '-') AS ck ` +
    `FROM (SELECT ${kexpr} AS k FROM ${schema}"${spec.table}") t`
  );
}
