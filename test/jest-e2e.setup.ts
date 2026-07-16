// e2e setup — postavlja test-only JWT_SECRET pre nego što se AppModule (→ AuthModule
// → requireJwtSecret, SEC-01 fail-closed) instancira. Bez ovoga e2e bi pao pri
// compile() u okruženju bez JWT_SECRET. Ovo je ISKLJUČIVO test tajna, ne dira prod.
process.env.JWT_SECRET =
  process.env.JWT_SECRET || "e2e-test-secret-not-for-production";
