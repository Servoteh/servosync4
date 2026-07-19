-- ============================================================================
-- seed_bilans.sql — balance_formula_definitions (bilansne AOP GKEval formule)
-- ============================================================================
-- IZVOR / STATUS:
--   Prave BigBit formule (ZR_AOP_Modla.Definicija + T_GK_IZV_Stavke.Formula) NISU
--   izvučene u CSV — u .MDB su BINARNE (doc 37 §F). Nijedan _extracted fajl ne sadrži
--   tekst tih formula (queries referišu kolonu ZR_Stavke.Definicija, ali ne i vrednosti).
--   => Ovo je MINIMALNI RADNI SEED sastavljen iz DOKUMENTOVANE logike (doc 37 §C/§F) i
--      kontnog plana Servoteha (BB_T_26/"Kontni plan.csv", klase 0–7).
--   GKEval DSL sintaksa (doc 37 §F):
--     D<konto>* / P<konto>*      = Σ dugovni / potražni promet (wildcard * = Like)
--     PSD<konto>* / PSP<konto>*  = početno stanje dug. / potr.
--     A<aop>                     = vrednost druge AOP pozicije (referenca)
--     + - ( )                    = operatori (bez aritmetike unutar atoma)
--   AOP oznake i nazivi = standardni srpski APR obrasci (BS = bilans stanja,
--   BU = bilans uspeha). Redosled AOP-a i tačan skup pozicija po veličini firme
--   (ZR_AOP_Modla, mikro/malo/srednje) NIJE u izvoru → ovde je jezgro pozicija.
--   ⚠️ PRE PRODUKCIJE: zameniti pravim ZR_AOP_Modla dumpom iz .MDB (mdb-export /
--      Access) — formule ispod su REKONSTRUKCIJA, ne verbatim BigBit.
--
--   Ključna mapiranja preuzeta doslovno iz doc 37 §C/§D:
--     Objekti (neto):   PSD022* + D022* - PSD0229* - D0229*   (bruto - ispravka)
--     Zemljište:        PSD021* + D021*                       (nema ispravke)
--     Oprema (neto):    PSD023* + D023* - PSD0239* - D0239*
--     Rashodi (BU):     D5*     Prihodi (BU): P6*     Amortizacija: D540*
--   statement_type: BALANCE_SHEET | INCOME_STATEMENT (schema enum; POPDV_ANNUAL van ovog seed-a)
--   UNIQUE (statement_type, aop) → svaki AOP jednom po obrascu.
-- ============================================================================
BEGIN;
TRUNCATE TABLE balance_formula_definitions RESTART IDENTITY CASCADE;

-- ── BILANS STANJA (BALANCE_SHEET) ───────────────────────────────────────────
-- AKTIVA (klase 0–3) + PASIVA (klasa 4). Neto vrednosti = bruto - ispravka.
INSERT INTO balance_formula_definitions (statement_type, aop, label, formula, ordinal) VALUES
  -- --- STALNA IMOVINA (klasa 0) ---
  ('BALANCE_SHEET', '0001', 'UKUPNA AKTIVA', 'A0002+A0044', 10),
  ('BALANCE_SHEET', '0002', 'STALNA IMOVINA', 'A0003+A0009+A0010+A0019+A0024', 20),
  ('BALANCE_SHEET', '0003', 'Nematerijalna imovina', 'PSD01*+D01*-PSD019*-D019*', 30),
  ('BALANCE_SHEET', '0009', 'Nekretnine, postrojenja i oprema', 'A0011+A0012+A0013+A0014', 40),
  ('BALANCE_SHEET', '0011', 'Zemljište', 'PSD021*+D021*', 50),
  ('BALANCE_SHEET', '0012', 'Građevinski objekti', 'PSD022*+D022*-PSD0229*-D0229*', 60),
  ('BALANCE_SHEET', '0013', 'Postrojenja i oprema', 'PSD023*+D023*-PSD0239*-D0239*', 70),
  ('BALANCE_SHEET', '0014', 'Nekretnine, postrojenja i oprema u pripremi', 'PSD027*+D027*', 80),
  ('BALANCE_SHEET', '0016', 'Investicione nekretnine', 'PSD024*+D024*-PSD0249*-D0249*', 90),
  ('BALANCE_SHEET', '0019', 'Dugoročni finansijski plasmani', 'PSD03*+D03*-PSD039*-D039*', 100),
  -- --- OBRTNA IMOVINA (klase 1, 2) ---
  ('BALANCE_SHEET', '0044', 'OBRTNA IMOVINA', 'A0045+A0051+A0059+A0068', 110),
  ('BALANCE_SHEET', '0045', 'Zalihe', 'PSD10*+D10*-P10*+PSD11*+D11*-P11*+PSD12*+D12*-P12*+PSD13*+D13*-P13*+PSD14*+D14*-P14*', 120),
  ('BALANCE_SHEET', '0051', 'Potraživanja po osnovu prodaje', 'PSD20*+D20*-P20*', 130),
  ('BALANCE_SHEET', '0055', 'Druga potraživanja', 'PSD21*+D21*-P21*+PSD22*+D22*-P22*', 140),
  ('BALANCE_SHEET', '0059', 'Kratkoročni finansijski plasmani', 'PSD23*+D23*-P23*', 150),
  ('BALANCE_SHEET', '0068', 'Gotovinski ekvivalenti i gotovina', 'PSD24*+D24*-P24*', 160),
  ('BALANCE_SHEET', '0069', 'Porez na dodatu vrednost (pretporez)', 'PSD27*+D27*-P27*', 170),
  ('BALANCE_SHEET', '0070', 'Aktivna vremenska razgraničenja', 'PSD28*+D28*-P28*', 180),
  -- --- PASIVA: KAPITAL (klasa 3) ---
  ('BALANCE_SHEET', '0401', 'UKUPNA PASIVA', 'A0402+A0432+A0447', 200),
  ('BALANCE_SHEET', '0402', 'KAPITAL', 'A0403+A0411+A0412+A0420-A0425', 210),
  ('BALANCE_SHEET', '0403', 'Osnovni kapital', 'PSP30*+P30*-D30*', 220),
  ('BALANCE_SHEET', '0411', 'Rezerve', 'PSP32*+P32*-D32*', 230),
  ('BALANCE_SHEET', '0412', 'Revalorizacione rezerve i nerealizovani dobici/gubici', 'PSP33*+P33*-D33*', 240),
  ('BALANCE_SHEET', '0420', 'Neraspoređeni dobitak', 'PSP34*+P34*-D34*', 250),
  ('BALANCE_SHEET', '0425', 'Gubitak', 'PSD35*+D35*-P35*', 260),
  -- --- PASIVA: OBAVEZE (klasa 4) ---
  ('BALANCE_SHEET', '0432', 'DUGOROČNA REZERVISANJA I OBAVEZE', 'PSP40*+P40*-D40*+PSP41*+P41*-D41*', 270),
  ('BALANCE_SHEET', '0447', 'KRATKOROČNE OBAVEZE', 'A0448+A0454+A0459+A0464', 280),
  ('BALANCE_SHEET', '0448', 'Kratkoročne finansijske obaveze', 'PSP42*+P42*-D42*', 290),
  ('BALANCE_SHEET', '0454', 'Obaveze iz poslovanja (dobavljači)', 'PSP43*+P43*-D43*', 300),
  ('BALANCE_SHEET', '0459', 'Ostale kratkoročne obaveze', 'PSP44*+P44*-D44*+PSP45*+P45*-D45*+PSP46*+P46*-D46*', 310),
  ('BALANCE_SHEET', '0464', 'Obaveze po osnovu PDV i ostalih javnih prihoda', 'PSP47*+P47*-D47*+PSP48*+P48*-D48*', 320),
  ('BALANCE_SHEET', '0470', 'Pasivna vremenska razgraničenja', 'PSP49*+P49*-D49*', 330);

-- ── BILANS USPEHA (INCOME_STATEMENT) ────────────────────────────────────────
-- Prihodi = potražni promet klase 6 (P6*), rashodi = dugovni promet klase 5 (D5*).
INSERT INTO balance_formula_definitions (statement_type, aop, label, formula, ordinal) VALUES
  ('INCOME_STATEMENT', '1001', 'POSLOVNI PRIHODI', 'P60*+P61*+P62*+P64*+P65*', 10),
  ('INCOME_STATEMENT', '1002', 'Prihodi od prodaje robe', 'P60*', 20),
  ('INCOME_STATEMENT', '1005', 'Prihodi od prodaje proizvoda i usluga', 'P61*', 30),
  ('INCOME_STATEMENT', '1008', 'Prihodi od premija, subvencija, dotacija', 'P64*', 40),
  ('INCOME_STATEMENT', '1009', 'Drugi poslovni prihodi', 'P65*', 50),
  ('INCOME_STATEMENT', '1010', 'POSLOVNI RASHODI', 'A1011+A1012+A1016+A1017+A1020+A1021+A1024', 60),
  ('INCOME_STATEMENT', '1011', 'Nabavna vrednost prodate robe', 'D50*', 70),
  ('INCOME_STATEMENT', '1012', 'Troškovi materijala', 'D51*', 80),
  ('INCOME_STATEMENT', '1016', 'Troškovi goriva i energije', 'D513*', 90),
  ('INCOME_STATEMENT', '1017', 'Troškovi zarada, naknada i ostali lični rashodi', 'D52*', 100),
  ('INCOME_STATEMENT', '1020', 'Troškovi proizvodnih usluga', 'D53*', 110),
  ('INCOME_STATEMENT', '1021', 'Troškovi amortizacije', 'D540*', 120),
  ('INCOME_STATEMENT', '1022', 'Troškovi rezervisanja', 'D54*-D540*', 130),
  ('INCOME_STATEMENT', '1024', 'Nematerijalni troškovi', 'D55*', 140),
  ('INCOME_STATEMENT', '1025', 'POSLOVNI DOBITAK', 'A1001-A1010', 150),
  ('INCOME_STATEMENT', '1027', 'FINANSIJSKI PRIHODI', 'P66*', 160),
  ('INCOME_STATEMENT', '1032', 'FINANSIJSKI RASHODI', 'D56*', 170),
  ('INCOME_STATEMENT', '1037', 'PRIHODI OD USKLAĐIVANJA VREDNOSTI IMOVINE', 'P67*+P68*', 180),
  ('INCOME_STATEMENT', '1038', 'RASHODI OD USKLAĐIVANJA VREDNOSTI IMOVINE', 'D57*+D58*', 190),
  ('INCOME_STATEMENT', '1039', 'OSTALI PRIHODI', 'P67*', 200),
  ('INCOME_STATEMENT', '1040', 'OSTALI RASHODI', 'D57*', 210),
  ('INCOME_STATEMENT', '1044', 'DOBITAK IZ REDOVNOG POSLOVANJA PRE OPOREZIVANJA', 'A1025+A1027-A1032+A1037-A1038+A1039-A1040', 220),
  ('INCOME_STATEMENT', '1064', 'DOBITAK PRE OPOREZIVANJA', 'A1044', 230),
  ('INCOME_STATEMENT', '1066', 'Porez na dobitak', 'D721*', 240),
  ('INCOME_STATEMENT', '1068', 'NETO DOBITAK', 'A1064-A1066', 250);

COMMIT;

-- source: REKONSTRUKCIJA iz doc 37 §C/§F + Kontni plan (BB_T_26). Prave ZR_AOP_Modla
--         formule su binarne u .MDB i NISU izvučene → zameni pre produkcije.
-- BALANCE_SHEET redova: 32 ; INCOME_STATEMENT redova: 25
