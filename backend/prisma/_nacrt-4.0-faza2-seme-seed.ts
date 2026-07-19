// ─────────────────────────────────────────────────────────────────────────────
// NACRT — Faza 2 (4.0): seed za GL kontiranje (AccountingScheme + AccountingSchemeLine)
// ─────────────────────────────────────────────────────────────────────────────
// STATUS: PRIPREMLJEN PODATAK — deterministički izvučen iz BigBit rule tabela.
// IZVOR (fajl:red verifikovano):
//   • _legacy/BigbitRaznoNenad/_extracted/rule_tables/BB_T_26/Sema za kontiranje.csv      (30 šema)
//   • _legacy/BigbitRaznoNenad/_extracted/rule_tables/BB_T_26/Stavke seme za kontiranje.csv (105 linija)
//   • R_Vrste dokumenata.csv (58 vrsta dok → IDSeme) — vezuje vrstu dokumenta na šemu (nije u ovom seed-u)
//   • Doc: backend/docs/migration/43-gl-posting-formule-A-Z-iz-koda.md (A-Z tabela + mehanizam)
// DATUM: 2026-07-19.
//
// Ide u prisma/seed KAD SE POTVRDI (baza + modeli AccountingScheme/AccountingSchemeLine
// već postoje u schema.prisma). Ovaj fajl NE dira schema.prisma ni bazu.
//
// ⚠️ DefDug (defDebit) / DefPot (defCredit) su IZRAZI nad slovima A-Z (A=1. … Z=26.
//    poziciona vrednost, vidi doc §1). NE INTERPRETIRATI — kopirano TAČNO iz CSV-a.
//    Evaluacija ide kroz "safe parser" (živ, ne VBA Eval). Prazno / "0" u CSV-u = strana
//    se NE knjiži → ovde mapirano na `null`.
//    NAPOMENA: red IDSeme=28 (konto 20200) ima DefDug "0+P+Q" — vodeći znak je CIFRA nula
//    (ne slovo O). Zadržano doslovno; to je legacy artefakt (slovo O bi bilo StvarnaVP).
//
// ⚠️ FK OBAVEZA (fk_scheme_lines_account): AccountingSchemeLine.accountCode → Account.code.
//    SVA konta koja linije koriste MORAJU postojati u `accounts` tabeli PRE učitavanja ovog
//    seed-a. Kontni (accounts) seed se proširuje sledećim JEDINSTVENIM kontima (49 kom.):
//      1010, 1011, 1200, 1320, 1321, 13600, 2020, 20200, 2040, 2050, 2700, 2710, 2740,
//      4300, 4350, 4360, 470, 4700, 47000, 4701, 4702, 471, 4710, 47100, 4720, 5010, 5012,
//      5013, 50140, 5110, 51100, 5510, 5740, 5741, 5793, 5795, 5796, 60240, 6040, 6050,
//      6120, 6121, 6141, 6150, 67300, 6740, 9020, 9600, 9800
//    OD TIH 49: 8 konta NE postoji u _legacy/.../Kontni plan.csv kao tačan kod i mora se
//    dodati ručno/kao analitika pre seed-a (inače FK padne):
//      13600, 20200, 470, 471, 47100, 50140, 60240, 67300
//    (20200/47000/47100/50140/60240/67300 su 5-cifrene analitike sintetika 2020/4700/4710/
//     5014/6024/6730; 470/471 su 3-cifreni sintetici — legacy KNO/knjižno odobrenje šema.)
// ─────────────────────────────────────────────────────────────────────────────

export interface AccountingSchemeSeed {
  id: number; // IDSeme
  orderType: string; // Vrsta naloga (npr. UFROB, IFR, IFUSL)
  description: string | null; // Opis
}

export interface AccountingSchemeLineSeed {
  schemeId: number; // IDSeme (FK AccountingScheme.id)
  accountCode: string; // Konto (FK Account.code)
  description: string | null; // Opis stavke
  defDebit: string | null; // DefDug — izraz nad A-Z (null = strana se ne knjiži)
  defCredit: string | null; // DefPot — izraz nad A-Z (null = strana se ne knjiži)
  postsAnalytics: boolean; // Analitika (nosi li šifru komitenta) — u CSV-u SVE True
  origin: string | null; // Poreklo — u CSV-u SVE "X"
  itemCodebook: string | null; // KngSifra_2 — u CSV-u SVE "0"
  lineNo: number; // redni broj stavke unutar šeme (0-baziran)
}

// ── 30 šema (Sema za kontiranje.csv) ────────────────────────────────────────
export const accountingSchemeSeed: AccountingSchemeSeed[] = [
  { id: 3, orderType: 'UFROB', description: 'Ulaz robe' },
  { id: 21, orderType: 'VPTR', description: 'PRODAJA ROBE U TRANZITU' },
  { id: 24, orderType: 'IZVRO', description: 'IZVOZ ROBE' },
  { id: 26, orderType: 'TREB', description: 'Trebovanje' },
  { id: 28, orderType: 'KNZ', description: 'Knjižno zaduženje' },
  { id: 29, orderType: 'VPSIR', description: 'PRODAJA SIROVINA I NEPOVRATNE AMBALAZE' },
  { id: 30, orderType: 'IFUSL', description: 'Usluge izlaz' },
  { id: 31, orderType: 'KNO', description: 'Knjizno odobrenje' },
  { id: 32, orderType: 'UVOZ', description: 'UVOZ' },
  { id: 33, orderType: 'IFR', description: 'IFR' },
  { id: 34, orderType: 'UFMAT', description: 'UFMAT' },
  { id: 35, orderType: 'ULGP', description: 'ULGP' },
  { id: 36, orderType: 'IFGP', description: 'IZLAZ GOT.PROIZVODA' },
  { id: 37, orderType: 'MMPM', description: 'PRENOS MAG. REPRO MATERIJALA' },
  { id: 38, orderType: 'MMPR', description: 'PRENOS MAGACIN ROBE' },
  { id: 39, orderType: 'AVR', description: 'AVANSNI RACUN' },
  { id: 40, orderType: 'REPRE', description: 'REPREZENTACIJA' },
  { id: 41, orderType: 'VISAM', description: 'VISAK MATERIJALA' },
  { id: 42, orderType: 'DONAC', description: 'DONACIJA' },
  { id: 43, orderType: 'TREB1', description: 'TREBOVANJE ROBE' },
  { id: 44, orderType: 'REZM', description: 'Materijal na rezervaciji' },
  { id: 45, orderType: 'REZR', description: 'Roba na rezervaciji' },
  { id: 46, orderType: 'VISAR', description: 'VISAK ROBE' },
  { id: 47, orderType: 'IZVGP', description: 'IZVOZ GOTOVIH PROIZVODA' },
  { id: 48, orderType: 'USLMA', description: 'USLMA' },
  { id: 49, orderType: 'MANJM', description: 'MANJAK MATERIJALA' },
  { id: 50, orderType: 'MANJR', description: 'MANJAK ROBE' },
  { id: 52, orderType: 'OTPIM', description: 'OTPIS MATERIJALA' },
  { id: 53, orderType: 'OTPIR', description: 'OTPIS ROBE' },
  { id: 54, orderType: 'ZEMLJ', description: 'UTROSAK ROBE ZA POPRAVKE' },
];

// ── 105 linija (Stavke seme za kontiranje.csv) ──────────────────────────────
// Prazno/"0" u DefDug/DefPot → null (strana se ne knjiži). lineNo = redni broj u okviru šeme.
export const accountingSchemeLineSeed: AccountingSchemeLineSeed[] = [
  // IDSeme 3 — UFROB (Ulaz robe)
  { schemeId: 3, accountCode: '1320', description: null, defDebit: 'A+B+C', defCredit: null, postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 0 },
  { schemeId: 3, accountCode: '2700', description: null, defDebit: 'D', defCredit: null, postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 1 },
  { schemeId: 3, accountCode: '4350', description: null, defDebit: null, defCredit: 'A+B+C+D+E', postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 2 },
  { schemeId: 3, accountCode: '2710', description: null, defDebit: 'E', defCredit: null, postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 3 },
  // IDSeme 21 — VPTR (Prodaja robe u tranzitu)
  { schemeId: 21, accountCode: '20200', description: null, defDebit: 'O+P+Q', defCredit: null, postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 0 },
  { schemeId: 21, accountCode: '60240', description: null, defDebit: null, defCredit: 'O', postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 1 },
  { schemeId: 21, accountCode: '47000', description: null, defDebit: null, defCredit: 'P', postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 2 },
  { schemeId: 21, accountCode: '47100', description: null, defDebit: null, defCredit: 'Q', postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 3 },
  { schemeId: 21, accountCode: '50140', description: null, defDebit: 'A', defCredit: null, postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 4 },
  { schemeId: 21, accountCode: '13600', description: null, defDebit: null, defCredit: 'A', postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 5 },
  // IDSeme 24 — IZVRO (Izvoz robe)
  { schemeId: 24, accountCode: '2050', description: null, defDebit: 'O', defCredit: null, postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 0 },
  { schemeId: 24, accountCode: '6050', description: null, defDebit: null, defCredit: 'O', postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 1 },
  { schemeId: 24, accountCode: '1320', description: null, defDebit: null, defCredit: 'A', postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 2 },
  { schemeId: 24, accountCode: '5013', description: null, defDebit: 'A', defCredit: null, postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 3 },
  // IDSeme 26 — TREB (Trebovanje materijala)
  { schemeId: 26, accountCode: '5110', description: null, defDebit: 'A', defCredit: null, postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 0 },
  { schemeId: 26, accountCode: '1010', description: null, defDebit: null, defCredit: 'A', postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 1 },
  // IDSeme 28 — KNZ (Knjižno zaduženje) — NB: DefDug "0+P+Q" vodeća CIFRA nula (legacy artefakt)
  { schemeId: 28, accountCode: '20200', description: null, defDebit: '0+P+Q', defCredit: null, postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 0 },
  // IDSeme 29 — VPSIR (Prodaja sirovina i nepovratne ambalaže)
  { schemeId: 29, accountCode: '20200', description: null, defDebit: 'O+P+Q+R+S', defCredit: null, postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 0 },
  { schemeId: 29, accountCode: '67300', description: null, defDebit: null, defCredit: 'O', postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 1 },
  { schemeId: 29, accountCode: '47000', description: null, defDebit: null, defCredit: 'P', postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 2 },
  { schemeId: 29, accountCode: '47100', description: null, defDebit: null, defCredit: 'Q', postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 3 },
  // IDSeme 30 — IFUSL (Usluge izlaz)
  { schemeId: 30, accountCode: '2020', description: 'Kupac', defDebit: 'O+P+Q', defCredit: null, postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 0 },
  { schemeId: 30, accountCode: '4700', description: 'PDV 18%', defDebit: null, defCredit: 'P', postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 1 },
  { schemeId: 30, accountCode: '4710', description: 'PDV 8%', defDebit: null, defCredit: 'Q', postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 2 },
  { schemeId: 30, accountCode: '6121', description: 'Prihod od usluga', defDebit: null, defCredit: 'O', postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 3 },
  // IDSeme 31 — KNO (Knjižno odobrenje) — umanjenje (negativni izrazi)
  { schemeId: 31, accountCode: '2020', description: 'Kupac', defDebit: '-O-P-Q', defCredit: null, postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 0 },
  { schemeId: 31, accountCode: '470', description: 'PDV 18%', defDebit: null, defCredit: '-P', postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 1 },
  { schemeId: 31, accountCode: '471', description: 'PDV 8%', defDebit: null, defCredit: '-Q', postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 2 },
  { schemeId: 31, accountCode: '6120', description: 'Prihodi od prodaje', defDebit: null, defCredit: '-O', postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 3 },
  // IDSeme 32 — UVOZ
  { schemeId: 32, accountCode: '4360', description: null, defDebit: null, defCredit: 'A', postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 0 },
  { schemeId: 32, accountCode: '2740', description: null, defDebit: 'D', defCredit: null, postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 1 },
  { schemeId: 32, accountCode: '1320', description: null, defDebit: 'A', defCredit: null, postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 2 },
  // IDSeme 33 — IFR (Izlaz robe)
  { schemeId: 33, accountCode: '2040', description: null, defDebit: 'O+P+Q', defCredit: null, postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 0 },
  { schemeId: 33, accountCode: '4702', description: null, defDebit: null, defCredit: 'P', postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 1 },
  { schemeId: 33, accountCode: '4710', description: null, defDebit: null, defCredit: 'Q', postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 2 },
  { schemeId: 33, accountCode: '6040', description: null, defDebit: null, defCredit: 'O', postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 3 },
  { schemeId: 33, accountCode: '1320', description: null, defDebit: null, defCredit: 'A', postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 4 },
  { schemeId: 33, accountCode: '5010', description: null, defDebit: 'A', defCredit: null, postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 5 },
  // IDSeme 34 — UFMAT (Ulaz materijala)
  { schemeId: 34, accountCode: '4350', description: null, defDebit: null, defCredit: 'A+D+E', postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 0 },
  { schemeId: 34, accountCode: '2700', description: null, defDebit: 'D', defCredit: null, postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 1 },
  { schemeId: 34, accountCode: '1010', description: null, defDebit: 'A', defCredit: null, postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 2 },
  { schemeId: 34, accountCode: '2710', description: null, defDebit: 'E', defCredit: null, postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 3 },
  // IDSeme 35 — ULGP (Ulaz gotovih proizvoda)
  { schemeId: 35, accountCode: '1200', description: null, defDebit: 'A', defCredit: null, postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 0 },
  { schemeId: 35, accountCode: '9020', description: null, defDebit: null, defCredit: 'A', postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 1 },
  { schemeId: 35, accountCode: '9600', description: null, defDebit: 'A', defCredit: null, postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 2 },
  { schemeId: 35, accountCode: '1200', description: null, defDebit: null, defCredit: 'A', postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 3 },
  // IDSeme 36 — IFGP (Izlaz gotovih proizvoda)
  { schemeId: 36, accountCode: '2040', description: '0', defDebit: 'O+P', defCredit: null, postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 0 },
  { schemeId: 36, accountCode: '6141', description: null, defDebit: null, defCredit: 'O', postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 1 },
  { schemeId: 36, accountCode: '4701', description: null, defDebit: null, defCredit: 'P', postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 2 },
  { schemeId: 36, accountCode: '9600', description: null, defDebit: null, defCredit: 'A', postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 3 },
  { schemeId: 36, accountCode: '9800', description: null, defDebit: 'A', defCredit: null, postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 4 },
  // IDSeme 37 — MMPM (Prenos magacin repro materijala)
  { schemeId: 37, accountCode: '1010', description: null, defDebit: 'A', defCredit: null, postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 0 },
  // IDSeme 38 — MMPR (Prenos magacin robe)
  { schemeId: 38, accountCode: '1320', description: null, defDebit: 'A', defCredit: null, postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 0 },
  // IDSeme 39 — AVR (Avansni račun)
  { schemeId: 39, accountCode: '4300', description: null, defDebit: null, defCredit: 'O+P', postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 0 },
  { schemeId: 39, accountCode: '4720', description: null, defDebit: null, defCredit: 'P', postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 1 },
  { schemeId: 39, accountCode: '4300', description: null, defDebit: 'P', defCredit: null, postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 2 },
  // IDSeme 40 — REPRE (Reprezentacija)
  { schemeId: 40, accountCode: '1320', description: null, defDebit: null, defCredit: 'A', postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 0 },
  { schemeId: 40, accountCode: '5010', description: null, defDebit: 'A', defCredit: null, postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 1 },
  { schemeId: 40, accountCode: '6040', description: null, defDebit: null, defCredit: 'A', postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 2 },
  { schemeId: 40, accountCode: '5510', description: null, defDebit: 'A+P+Q', defCredit: null, postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 3 },
  { schemeId: 40, accountCode: '4700', description: null, defDebit: null, defCredit: 'P', postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 4 },
  { schemeId: 40, accountCode: '4710', description: null, defDebit: null, defCredit: 'Q', postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 5 },
  // IDSeme 41 — VISAM (Višak materijala)
  { schemeId: 41, accountCode: '1010', description: 'MATERIIJAL', defDebit: 'A', defCredit: null, postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 0 },
  { schemeId: 41, accountCode: '6740', description: null, defDebit: null, defCredit: 'A', postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 1 },
  // IDSeme 42 — DONAC (Donacija)
  { schemeId: 42, accountCode: '1320', description: null, defDebit: null, defCredit: 'A', postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 0 },
  { schemeId: 42, accountCode: '5010', description: null, defDebit: 'A', defCredit: null, postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 1 },
  { schemeId: 42, accountCode: '6040', description: null, defDebit: null, defCredit: 'A', postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 2 },
  { schemeId: 42, accountCode: '4700', description: null, defDebit: null, defCredit: 'P', postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 3 },
  { schemeId: 42, accountCode: '5793', description: null, defDebit: 'A+P', defCredit: null, postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 4 },
  // IDSeme 43 — TREB1 (Trebovanje robe)
  { schemeId: 43, accountCode: '1320', description: null, defDebit: null, defCredit: 'A', postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 0 },
  { schemeId: 43, accountCode: '51100', description: null, defDebit: 'A', defCredit: null, postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 1 },
  // IDSeme 44 — REZM (Materijal na rezervaciji)
  { schemeId: 44, accountCode: '1010', description: null, defDebit: '-A', defCredit: null, postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 0 },
  { schemeId: 44, accountCode: '1011', description: null, defDebit: 'A', defCredit: null, postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 1 },
  // IDSeme 45 — REZR (Roba na rezervaciji)
  { schemeId: 45, accountCode: '1320', description: null, defDebit: '-A', defCredit: null, postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 0 },
  { schemeId: 45, accountCode: '1321', description: null, defDebit: 'A', defCredit: null, postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 1 },
  // IDSeme 46 — VISAR (Višak robe)
  { schemeId: 46, accountCode: '1320', description: null, defDebit: 'A', defCredit: null, postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 0 },
  { schemeId: 46, accountCode: '6740', description: null, defDebit: null, defCredit: 'A', postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 1 },
  // IDSeme 47 — IZVGP (Izvoz gotovih proizvoda)
  { schemeId: 47, accountCode: '2050', description: null, defDebit: 'O', defCredit: null, postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 0 },
  { schemeId: 47, accountCode: '6150', description: null, defDebit: null, defCredit: 'O', postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 1 },
  { schemeId: 47, accountCode: '9800', description: null, defDebit: 'A', defCredit: null, postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 2 },
  { schemeId: 47, accountCode: '9600', description: null, defDebit: null, defCredit: 'A', postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 3 },
  // IDSeme 48 — USLMA (Materijal za popravku)
  { schemeId: 48, accountCode: '1010', description: null, defDebit: '-A', defCredit: null, postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 0 },
  { schemeId: 48, accountCode: '5110', description: null, defDebit: 'A', defCredit: null, postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 1 },
  // IDSeme 49 — MANJM (Manjak materijala)
  { schemeId: 49, accountCode: '1010', description: null, defDebit: null, defCredit: 'A', postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 0 },
  { schemeId: 49, accountCode: '4700', description: null, defDebit: null, defCredit: 'P', postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 1 },
  { schemeId: 49, accountCode: '6040', description: null, defDebit: null, defCredit: 'A', postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 2 },
  { schemeId: 49, accountCode: '5110', description: null, defDebit: 'A', defCredit: null, postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 3 },
  { schemeId: 49, accountCode: '5740', description: null, defDebit: 'A+P', defCredit: null, postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 4 },
  // IDSeme 50 — MANJR (Manjak robe)
  { schemeId: 50, accountCode: '1320', description: null, defDebit: null, defCredit: 'A', postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 0 },
  { schemeId: 50, accountCode: '4700', description: null, defDebit: null, defCredit: 'P', postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 1 },
  { schemeId: 50, accountCode: '6040', description: null, defDebit: null, defCredit: 'A', postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 2 },
  { schemeId: 50, accountCode: '5010', description: null, defDebit: 'A', defCredit: null, postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 3 },
  { schemeId: 50, accountCode: '5741', description: null, defDebit: 'A+P', defCredit: null, postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 4 },
  // IDSeme 52 — OTPIM (Otpis materijala)
  { schemeId: 52, accountCode: '1010', description: null, defDebit: null, defCredit: 'A', postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 0 },
  { schemeId: 52, accountCode: '4700', description: null, defDebit: null, defCredit: 'P', postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 1 },
  { schemeId: 52, accountCode: '6040', description: null, defDebit: null, defCredit: 'A', postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 2 },
  { schemeId: 52, accountCode: '5110', description: null, defDebit: 'A', defCredit: null, postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 3 },
  { schemeId: 52, accountCode: '5795', description: null, defDebit: 'A+P', defCredit: null, postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 4 },
  // IDSeme 53 — OTPIR (Otpis robe)
  { schemeId: 53, accountCode: '1320', description: null, defDebit: null, defCredit: 'A', postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 0 },
  { schemeId: 53, accountCode: '4700', description: null, defDebit: null, defCredit: 'P', postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 1 },
  { schemeId: 53, accountCode: '6040', description: null, defDebit: null, defCredit: 'A', postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 2 },
  { schemeId: 53, accountCode: '5010', description: null, defDebit: 'A', defCredit: null, postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 3 },
  { schemeId: 53, accountCode: '5796', description: null, defDebit: 'A+P', defCredit: null, postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 4 },
  // IDSeme 54 — ZEMLJ (Utrošak robe za popravke)
  { schemeId: 54, accountCode: '1320', description: null, defDebit: '-A', defCredit: null, postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 0 },
  { schemeId: 54, accountCode: '5012', description: null, defDebit: 'A', defCredit: null, postsAnalytics: true, origin: 'X', itemCodebook: '0', lineNo: 1 },
];

// ── JEDINSTVENA konta koja linije koriste (49) — za proširenje accounts seed-a pre FK ──
// (izvedeno iz accountingSchemeLineSeed[].accountCode; ovde eksplicitno radi provere)
export const schemeUsedAccountCodes: string[] = [
  '1010', '1011', '1200', '1320', '1321', '13600', '2020', '20200', '2040', '2050',
  '2700', '2710', '2740', '4300', '4350', '4360', '470', '4700', '47000', '4701',
  '4702', '471', '4710', '47100', '4720', '5010', '5012', '5013', '50140', '5110',
  '51100', '5510', '5740', '5741', '5793', '5795', '5796', '60240', '6040', '6050',
  '6120', '6121', '6141', '6150', '67300', '6740', '9020', '9600', '9800',
];
