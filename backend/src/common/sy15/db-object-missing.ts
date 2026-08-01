/**
 * „Objekat u bazi još ne postoji" — SAMO to, ništa drugo.
 *
 * ⚠️ REVIEW 31.07 (zahtev 026/26): moduli koji čekaju ručnu primenu sy15 skripte
 * gutali su SVAKU grešku kao „SQL nije primenjen" (prazan `catch {}` → prazna lista
 * + `meta.pending_sql`). Posle stvarne primene skripte, bilo koji realan kvar
 * (RLS/GRANT regresija, pad konekcije, drift kolona) prikazivao bi HR-u obmanjujući
 * baner, a molbe zaposlenih bi tiho nestale sa ekrana — bez ijednog signala.
 *
 * Prisma raw upit grešku iz Postgresa isporučuje kao `P2010` sa `meta.code` =
 * originalnim SQLSTATE-om. Nas zanimaju samo dva:
 *   • `42883` undefined_function — RPC još nije kreiran
 *   • `42P01` undefined_table    — tabela/view još ne postoji
 * (plus Prisma `P2021` = „table does not exist" za ne-raw putanje).
 *
 * Sve ostalo MORA da propadne dalje kroz `rethrowSy15` kao prava greška.
 */
export function isMissingDbObject(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const meta = (e as { meta?: { code?: string } }).meta;
  const code = meta?.code ?? (e as { code?: string }).code;
  return code === "42883" || code === "42P01" || code === "P2021";
}
