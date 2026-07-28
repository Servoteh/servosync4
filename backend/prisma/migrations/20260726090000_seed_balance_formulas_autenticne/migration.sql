-- ============================================================================
-- SEED: balance_formula_definitions — AUTENTIČNE AOP formule (Pravilnik 89/2020)
-- ============================================================================
-- ODAKLE FORMULE DOLAZE
--   Izvor NIJE rekonstrukcija „po pameti", nego PREDATI obrasci Servoteha za 2023.
--   godinu (Bilans stanja i Bilans uspeha, obrazac po Pravilniku 89/2020), izvučeni
--   u tekst u:
--     backend/reports/zr/bs.txt   (Bilans stanja, 117 AOP pozicija)
--     backend/reports/zr/bu.txt   (Bilans uspeha,  62 AOP pozicije)
--   Sam obrazac NOSI formulu: kolona 1 („Група рачуна, рачун") daje masku konta za
--   LISTOVE, a naziv pozicije u zagradi daje AOP-aritmetiku za ZBIRNE pozicije
--   (npr. AOP 1001 = „А. ПОСЛОВНИ ПРИХОДИ (1002 + 1005 + 1008 + 1009 - 1010 +
--   1011 + 1012)"). Maske su zatim mapirane na STVARNI kontni plan Servoteha
--   (migracija 20260723155000_seed_chart_of_accounts, 1398 konta), koji je po
--   STAROM kontnom okviru — vidi §„ODSTUPANJA OD OBRASCA" niže.
--
-- ZA KOJU GODINU VAŽE
--   Formule su verifikovane na predatim iznosima za 2023. (kolona 5), 2022. (kolona 6)
--   i 2021. (kolona 7 BS-a). Nisu vezane za godinu — važe za svaku godinu dok se ne
--   promeni obrazac ili kontni plan.
--
-- ŠTA JE PROVERENO (i prošlo)
--   * POTPUNOST: 117/117 AOP pozicija BS-a (0001–0060 + 0401–0457) i 62/62 pozicije
--     BU-a (1001–1062). Nijedna ne fali, nijedna nije višak.
--   * ARITMETIKA ZBIRNIH: BS 22 zbirne × 3 kolone = 66 provera, 66/66 tačno.
--     BU 19 zbirnih × 2 kolone = 38 provera, 38/38 tačno.
--   * BILANS ZATVARA: A0059 = A0456 = 868.293 (2023) / 638.633 (2022) / 447.059 (2021).
--   * BU REZULTAT: A1055 = 34.636 (2023) / 41.817 (2022).
--   * NEZAVISNA KONTROLA BU: zbir 14 prihodnih listova = 653.419 = A1043; zbir 17
--     rashodnih listova = 617.063 = A1044; razlika = 36.356 = A1045.
--   * STRANA (D/P): svih 154 lista prošlo ručnu proveru; aktiva/rashodi = D−P,
--     pasiva/prihodi = P−D, uz izuzetke koje obrazac izričito traži (0407, 0413,
--     0414, 1010, 1052, 1047/1048).
--   * PREKLAPANJE MASKI: nema nijednog duplog brojanja unutar istog zbira; sve
--     „осим" konstrukcije oduzete su na OBE strane (…-DY*+PY*).
--
-- ŠTA NIJE PROVERENO (iskreno)
--   * Formule NISU pokrenute nad podacima — u 4.0 glavnoj knjizi NEMA GL istorije za
--     2021–2023, a bruto stanje iz BigBit-a nije izvezeno. Verifikacija je urađena
--     ARITMETIČKI (nad predatim iznosima) i STRUKTURNO (maske nad kontnim planom),
--     ne izvršavanjem motora. Regresioni brojevi su gore — pusti ih čim bruto stanje
--     bude dostupno.
--   * 23 konta iz kontnog plana ne hvata nijedna maska (sintetičke „glave" klasa,
--     plus 290 i 2990). Vidi backend/docs/migration/ZR_AOP_FORMULE_AUTENTICNE.md §6.
--   * 14 pozicija je MANUAL (7 BS + 7 BU) — podela „(део)" nije izvodiva iz kontnog
--     plana, odnosno pozicija po prirodi nije izvodiva iz glavne knjige (konsolidacija,
--     zarada po akciji). MANUAL danas znači TRAJNA NULA — nema rute za ručni unos.
--
-- ⚠️ PREDUSLOV U KODU — BEZ NJEGA OVAJ SEED DAJE POGREŠAN BILANS
--   BalanceSheetService NEMA clamp ≥ 0, a BigBit klampuje SVAKI upis. Bez clampa:
--   BS 0455 = −167.829 → 0456 = 1.036.122 umesto 868.293; BU 1055 = 143.604 umesto
--   34.636. Takođe: zaključni nalog „ZAK" (year-open.service.ts) knjiži kontra-stavku
--   NAZAD NA ISTO konto klase 5/6, pa svaka BU maska daje egzaktnu nulu za godinu za
--   koju je prenos urađen. Tačan spisak izmena: backend/docs/migration/ZR_ISPRAVKE_MOTORA.md
--
-- ODSTUPANJA OD DOSLOVNOG OBRASCA (svaka je obrazložena u docs §5)
--   0017/0019  bioločka sredstva su kod Servoteha pod sintetikama 030/031/032
--   0039–0042  podela kupci vs povezana lica po ANALITICI (2020/2030), ne po sintetici
--   0443–0446  dobavljači: 4330/4340 su povezana lica, ostatak 433/434 su obični
--   0406       samo konto 330 (bez 331–337) — inače se dugovni saldo broji dvaput
--   1054       MANUAL, jer Servotehov 723 = „Prenos dobitka ili gubitka", ne „Isplaćena
--              lična primanja poslodavca"
--
-- DSL (verbatim iz GkEvalService)
--   D<maska>*  / P<maska>*   = Σ Duguje / Potražuje (LIKE nad account_code)
--   PSD/PSP                  = isto, ali samo nalozi vrste PS — NE KORISTI SE OVDE
--                              (D/P već sadrže PS naloge; „PSD01*+D01*" iz starog seed-a
--                              je brojao početno stanje DVAPUT)
--   A<aop>                   = vrednost druge AOP pozicije, kolona 1
--   MANUAL                   = ručna pozicija (BalanceSheetService je upisuje kao 0)
--   + - ( )                  = jedini operatori; `*` je WILDCARD, ne množenje
--
-- IDEMPOTENCIJA / ZAMENA STAROG SEED-a
--   Stari rekonstrukcioni seed (20260723150000) koristi ON CONFLICT DO NOTHING, a
--   ~25 njegovih AOP oznaka se POKLAPA sa zvaničnim ali sa DRUGIM ZNAČENJEM (stari
--   0001 = „UKUPNA AKTIVA", zvanični 0001 = „Uписани а неуплаћени капитал"; stari
--   1010 = „POSLOVNI RASHODI", zvanični 1010 = „Смањење вредности залиха"). Zato ovde
--   PRVO BRIŠEMO sve redove ta dva obrasca pa upisujemo nove — čist INSERT bi tiho
--   zadržao stare pogrešne definicije. POPDV_ANNUAL (SI) se NE dira.
--   Uz definicije brišemo i IZRAČUNATE linije BS/BU i vraćamo zaglavlja u DRAFT, jer
--   loadPriorYearAmounts() mapira kolone 2/3 po SIROVOM `aop` stringu — stari red
--   aop='0001' sa vrednošću ukupne aktive bi zatrovao kolonu „prethodna godina".
--
-- BRANA I ARHIVA (dopuna 28.07.2026 — stavka D nezavisnog pregleda, nalaz V2)
--   Prva verzija ovog fajla je gornja tri naloga izvršavala BEZUSLOVNO. Na produ
--   `/zavrsni-racun` živi za pilot krug od 22.07., pa bi isti `DELETE` pogodio i
--   VEĆ PREDAT (FINALIZED) obrazac — bez arhive, bez `down` puta, bez ijedne
--   poruke. Revizor je to i izveo nad prod-slikom: dva `FINAL` obračuna → oba
--   `DRAFT`, `finalized_at = NULL`, 0 linija.
--   Sada:
--     (a) sve što se briše PRVO ide u `arch_*` tabele (staro stanje je vraćivo);
--     (b) ako postoji ijedan BS/BU obračun u statusu različitom od `DRAFT`,
--         migracija PADA sa razumljivom porukom umesto da ga prepiše.
--   Zašto PAD a ne „preskoči predate": preskakanje ostavlja predat obrazac sa
--   linijama po STAROM AOP rečniku dok registar definicija nosi NOVI — a baš to
--   trovanje `loadPriorYearAmounts()` je razlog zbog kog se linije i brišu. Dva
--   nespojiva rečnika u istoj tabeli su gora tišina od zaustavljenog deploy-a.
--   IZLAZ ZA OPERATERA (svesna, zapisana odluka — nikad automatski):
--     Prekidač se postavlja NA NIVOU BAZE, pa migracija prolazi kroz REDOVAN
--     `prisma migrate deploy` i UREDNO UĐE U `_prisma_migrations`:
--       ALTER DATABASE <baza> SET servosync.dozvoli_prepis_bilansa = 'on';
--       npx prisma migrate resolve --rolled-back 20260726090000_seed_balance_formulas_autenticne
--         (samo ako je prethodni deploy već pao na ovoj brani)
--       npx prisma migrate deploy
--       ALTER DATABASE <baza> RESET servosync.dozvoli_prepis_bilansa;
--     ⚠️ NE puštati fajl ručno kroz psql/`prisma db execute` (`\i migration.sql`):
--     tako se efekat upiše u bazu a evidencija ga ne zna — to je TAČNO nalaz V2
--     zbog kog je ceo ovaj paket i nastao, i sledeći `migrate deploy` bi migraciju
--     izvršio DRUGI PUT (arhiva se udvostruči).
--   PRE MERGE-a NA MAIN proveri na produ:
--     SELECT id, statement_type, period_year, status FROM financial_statements
--      WHERE statement_type IN ('BALANCE_SHEET','INCOME_STATEMENT') AND status <> 'DRAFT';
--   Prazan rezultat = deploy prolazi bez ijedne ručne radnje.
-- ============================================================================

-- ── 0a. Arhiva (jedan red = jedan obrisan red, uz ime migracije koja ga je uzela)
CREATE TABLE IF NOT EXISTS "arch_balance_formula_definitions" (
  "arch_id"        BIGSERIAL PRIMARY KEY,
  "arch_migration" TEXT NOT NULL,
  "arch_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "id"             INTEGER,
  "statement_type" TEXT,
  "aop"            TEXT,
  "label"          TEXT,
  "formula"        TEXT,
  "ordinal"        INTEGER
);

CREATE TABLE IF NOT EXISTS "arch_financial_statement_lines" (
  "arch_id"          BIGSERIAL PRIMARY KEY,
  "arch_migration"   TEXT NOT NULL,
  "arch_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "id"               INTEGER,
  "statement_id"     INTEGER,
  "statement_type"   TEXT,
  "period_year"      INTEGER,
  "statement_status" TEXT,
  "aop"              TEXT,
  "label"            TEXT,
  "amount"           NUMERIC(19,4),
  "amount_2"         NUMERIC(19,4),
  "amount_3"         NUMERIC(19,4),
  "formula"          TEXT,
  "ordinal"          INTEGER
);

-- DATUM ZAKLJUČENJA je deo onoga što se briše (`finalized_at = NULL` niže), pa mora
-- u arhivu — inače „sve što se briše je vraćivo" ne bi bilo tačno, a Servoteh je
-- obveznik revizije kojoj taj datum treba. `ADD COLUMN IF NOT EXISTS` je zbog baza
-- na kojima je arhivska tabela već napravljena prethodnom verzijom ovog fajla.
ALTER TABLE "arch_financial_statement_lines"
  ADD COLUMN IF NOT EXISTS "statement_finalized_at" TIMESTAMPTZ(6);

-- ── 0b. BRANA: predat obračun se ne prepisuje ───────────────────────────────
DO $stavka_d$
DECLARE
  predati TEXT;
BEGIN
  SELECT string_agg(
           format('%s %s (status %s)', statement_type, period_year, status),
           ', ' ORDER BY statement_type, period_year)
    INTO predati
    FROM financial_statements
   WHERE statement_type IN ('BALANCE_SHEET', 'INCOME_STATEMENT')
     AND status <> 'DRAFT';

  IF predati IS NOT NULL
     AND coalesce(current_setting('servosync.dozvoli_prepis_bilansa', true), 'off') <> 'on' THEN
    RAISE EXCEPTION
      'ZAVRSNI_RACUN_PREDAT: u bazi postoji predat (zaključen) obrazac — %. '
      'Ova migracija menja rečnik AOP pozicija i morala bi da obriše njegove izračunate '
      'linije, pa je zaustavljena da predat obrazac ne bi tiho promenio sadržaj. '
      'POSTUPAK IMA TRI KORAKA, I DRUGI SE NE SME PRESKOČITI: '
      '(1) sačuvajte predat obrazac izvan aplikacije i vratite ga u status DRAFT '
      '(ili, ako je prepis svesna odluka, postavite ALTER DATABASE <baza> SET '
      'servosync.dozvoli_prepis_bilansa = ''on''); '
      '(2) OBAVEZNO odmrznite neuspelu migraciju: npx prisma migrate resolve '
      '--rolled-back 20260726090000_seed_balance_formulas_autenticne — bez ovoga svaki '
      'sledeći deploy pada sa P3009 („failed migrations in the target database"), '
      'uključujući i deploy-e drugih modula, jer je ovaj pokušaj ostao zapisan kao '
      'nezavršen (finished_at IS NULL); '
      '(3) ponovite deploy. '
      '[tehnički: financial_statements.status <> ''DRAFT''; stare linije se u svakom '
      'slučaju arhiviraju u arch_financial_statement_lines]',
      predati;
  END IF;
END
$stavka_d$;

-- ── 0c. Arhiviraj pa ukloni stare (rekonstrukcione) definicije i izračune BS/BU
INSERT INTO "arch_balance_formula_definitions"
  (arch_migration, id, statement_type, aop, label, formula, ordinal)
SELECT '20260726090000_seed_balance_formulas_autenticne',
       id, statement_type, aop, label, formula, ordinal
  FROM balance_formula_definitions
 WHERE statement_type IN ('BALANCE_SHEET', 'INCOME_STATEMENT');

DELETE FROM balance_formula_definitions
 WHERE statement_type IN ('BALANCE_SHEET', 'INCOME_STATEMENT');

INSERT INTO "arch_financial_statement_lines"
  (arch_migration, id, statement_id, statement_type, period_year, statement_status,
   statement_finalized_at,
   aop, label, amount, amount_2, amount_3, formula, ordinal)
SELECT '20260726090000_seed_balance_formulas_autenticne',
       l.id, l.statement_id, s.statement_type, s.period_year, s.status,
       s.finalized_at,
       l.aop, l.label, l.amount, l.amount_2, l.amount_3, l.formula, l.ordinal
  FROM financial_statement_lines l
  JOIN financial_statements s ON s.id = l.statement_id
 WHERE s.statement_type IN ('BALANCE_SHEET', 'INCOME_STATEMENT');

DELETE FROM financial_statement_lines
 WHERE statement_id IN (
   SELECT id FROM financial_statements
    WHERE statement_type IN ('BALANCE_SHEET', 'INCOME_STATEMENT')
 );

-- Posle brane ovde po pravilu stoje samo DRAFT zaglavlja (osim uz svestan
-- `dozvoli_prepis_bilansa`), pa je ovo mreža a ne rutinsko vraćanje statusa.
UPDATE financial_statements
   SET status = 'DRAFT', finalized_at = NULL
 WHERE statement_type IN ('BALANCE_SHEET', 'INCOME_STATEMENT')
   AND (status <> 'DRAFT' OR finalized_at IS NOT NULL);

-- ============================================================================
-- 1. BILANS STANJA (BALANCE_SHEET) — 117 pozicija
--    Kolone obrasca: 5 = tekuća godina, 6 = prethodna (krajnje stanje),
--    7 = prethodna (početno stanje 01.01.) → StartnaKolona=5, BrojKolona=3.
--    Kolona 4 = „Напомена број" (tekstualna, prazna u XML-u).
-- ============================================================================

-- ── AKTIVA ─────────────────────────────────────────────────────────────────
INSERT INTO balance_formula_definitions (statement_type, aop, label, formula, ordinal) VALUES
  ('BALANCE_SHEET','0001','A. UPISANI A NEUPLAĆENI KAPITAL','D00*-P00*',10),
  ('BALANCE_SHEET','0002','B. STALNA IMOVINA','A0003+A0009+A0017+A0018+A0028',20),
  ('BALANCE_SHEET','0003','I. NEMATERIJALNA IMOVINA','A0004+A0005+A0006+A0007+A0008',30),
  ('BALANCE_SHEET','0004','1. Ulaganja u razvoj','D010*-P010*',40),
  ('BALANCE_SHEET','0005','2. Koncesije, patenti, licence, robne i uslužne marke, softver i ostala nematerijalna imovina','D011*-P011*+D012*-P012*+D014*-P014*',50),
  ('BALANCE_SHEET','0006','3. Gudvil','D013*-P013*',60),
  ('BALANCE_SHEET','0007','4. Nematerijalna imovina uzeta u lizing i nematerijalna imovina u pripremi','D015*-P015*',70),
  ('BALANCE_SHEET','0008','5. Avansi za nematerijalnu imovinu','D016*-P016*',80),
  ('BALANCE_SHEET','0009','II. NEKRETNINE, POSTROJENJA I OPREMA','A0010+A0011+A0012+A0013+A0014+A0015+A0016',90),
  ('BALANCE_SHEET','0010','1. Zemljište i građevinski objekti','D020*-P020*+D021*-P021*+D022*-P022*',100),
  ('BALANCE_SHEET','0011','2. Postrojenja i oprema','D023*-P023*',110),
  ('BALANCE_SHEET','0012','3. Investicione nekretnine','D024*-P024*',120),
  ('BALANCE_SHEET','0013','4. Nekretnine, postrojenja i oprema uzeti u lizing i nekretnine, postrojenja i oprema u pripremi','D025*-P025*+D027*-P027*',130),
  ('BALANCE_SHEET','0014','5. Ostale nekretnine, postrojenja i oprema i ulaganja na tuđim nekretninama, postrojenjima i opremi','D026*-P026*+D028*-P028*',140),
  ('BALANCE_SHEET','0015','6. Avansi za nekretnine, postrojenja i opremu u zemlji','D029*-P029*',150),
  -- 0016: ista maska „029 (део)" kao 0015; ceo 029 (Servoteh: 0290–0292, sve domaće)
  -- pripisan je 0015 da se ne broji dvaput. Predato 0/0/0.
  ('BALANCE_SHEET','0016','7. Avansi za nekretnine, postrojenja i opremu u inostranstvu','MANUAL',160),
  -- 0017: obrazac traži klasu 03, ali kod Servoteha je 03 = dugoročni finansijski
  -- plasmani (stari okvir). Prava biološka sredstva su analitike 0302 (mešovite šume),
  -- 0310/0311/0312 (višegodišnji zasadi), 0320 (osnovno stado) — one se ovde i hvataju,
  -- a iz 0019 su izuzete.
  ('BALANCE_SHEET','0017','III. BIOLOŠKA SREDSTVA','D0302*-P0302*+D0310*-P0310*+D0311*-P0311*+D0312*-P0312*+D0320*-P0320*',170),
  ('BALANCE_SHEET','0018','IV. DUGOROČNI FINANSIJSKI PLASMANI I DUGOROČNA POTRAŽIVANJA','A0019+A0020+A0021+A0022+A0023+A0024+A0025+A0026+A0027',180),
  ('BALANCE_SHEET','0019','1. Učešća u kapitalu pravnih lica (osim učešća u kapitalu koja se vrednuju metodom učešća)','D030*-P030*-D0302*+P0302*+D031*-P031*-D0310*+P0310*-D0311*+P0311*-D0312*+P0312*+D032*-P032*-D0320*+P0320*+D040*-P040*+D041*-P041*+D042*-P042*',190),
  ('BALANCE_SHEET','0020','2. Učešća u kapitalu koja se vrednuju metodom učešća','MANUAL',200),
  ('BALANCE_SHEET','0021','3. Dugoročni plasmani matičnom, zavisnim i ostalim povezanim licima i dugoročna potraživanja od tih lica u zemlji','D033*-P033*+D043*-P043*+D050*-P050*+D051*-P051*',210),
  ('BALANCE_SHEET','0022','4. Dugoročni plasmani matičnom, zavisnim i ostalim povezanim licima i dugoročna potraživanja od tih lica u inostranstvu','D044*-P044*',220),
  ('BALANCE_SHEET','0023','5. Dugoročni plasmani (dati krediti i zajmovi) u zemlji','D034*-P034*+D045*-P045*+D053*-P053*',230),
  ('BALANCE_SHEET','0024','6. Dugoročni plasmani (dati krediti i zajmovi) u inostranstvu','D035*-P035*',240),
  ('BALANCE_SHEET','0025','7. Dugoročna finansijska ulaganja (hartije od vrednosti koje se vrednuju po amortizovanoj vrednosti)','D036*-P036*+D046*-P046*',250),
  ('BALANCE_SHEET','0026','8. Otkupljene sopstvene akcije i otkupljeni sopstveni udeli','D037*-P037*+D047*-P047*',260),
  -- 0027: uključen i konto 039 (ispravka vrednosti dugoročnih plasmana), koji u novom
  -- okviru ne postoji kao poseban AOP — potražni je pa automatski umanjuje poziciju.
  ('BALANCE_SHEET','0027','9. Ostali dugoročni finansijski plasmani i ostala dugoročna potraživanja','D038*-P038*+D039*-P039*+D048*-P048*+D052*-P052*+D054*-P054*+D055*-P055*+D056*-P056*',270),
  -- 0028: „28 (део), осим 288" — identična maska kao 0058; ceo 28 osim 288 pripisan 0058.
  ('BALANCE_SHEET','0028','V. DUGOROČNA AKTIVNA VREMENSKA RAZGRANIČENJA','MANUAL',280),
  ('BALANCE_SHEET','0029','V. ODLOŽENA PORESKA SREDSTVA','D288*-P288*',290),
  ('BALANCE_SHEET','0030','G. OBRTNA IMOVINA','A0031+A0037+A0038+A0044+A0048+A0057+A0058',300),
  ('BALANCE_SHEET','0031','I. ZALIHE','A0032+A0033+A0034+A0035+A0036',310),
  ('BALANCE_SHEET','0032','1. Materijal, rezervni delovi, alat i sitan inventar','D10*-P10*',320),
  ('BALANCE_SHEET','0033','2. Nedovršena proizvodnja i gotovi proizvodi','D11*-P11*+D12*-P12*',330),
  ('BALANCE_SHEET','0034','3. Roba','D13*-P13*',340),
  ('BALANCE_SHEET','0035','4. Plaćeni avansi za zalihe i usluge u zemlji','D150*-P150*+D152*-P152*+D154*-P154*',350),
  ('BALANCE_SHEET','0036','5. Plaćeni avansi za zalihe i usluge u inostranstvu','D151*-P151*+D153*-P153*+D155*-P155*',360),
  ('BALANCE_SHEET','0037','II. STALNA IMOVINA KOJA SE DRŽI ZA PRODAJU I PRESTANAK POSLOVANJA','D14*-P14*',370),
  ('BALANCE_SHEET','0038','III. POTRAŽIVANJA PO OSNOVU PRODAJE','A0039+A0040+A0041+A0042+A0043',380),
  -- 0039–0042: obrazac deli po SINTETICI (0039=204, 0041=„200 и 202"), ali Servoteh
  -- ima dupli sloj — 202/203 (stari okvir) drže i obične kupce (2021/2023/2031/2039)
  -- i povezana lica (2020/2030). Podela je zato po ANALITICI. Konto 2090 (ispravka
  -- vrednosti potraživanja od kupaca) nema svoju poziciju u obrascu — privremeno je
  -- u 0039 (potražni je pa umanjuje); ČEKA POTVRDU KNJIGOVOĐE.
  ('BALANCE_SHEET','0039','1. Potraživanja od kupaca u zemlji','D204*-P204*+D202*-P202*-D2020*+P2020*+D20200*-P20200*+D2090*-P2090*',390),
  ('BALANCE_SHEET','0040','2. Potraživanja od kupaca u inostranstvu','D205*-P205*+D203*-P203*-D2030*+P2030*',400),
  ('BALANCE_SHEET','0041','3. Potraživanja od matičnog, zavisnih i ostalih povezanih lica u zemlji','D200*-P200*+D2020*-P2020*-D20200*+P20200*',410),
  ('BALANCE_SHEET','0042','4. Potraživanja od matičnog, zavisnih i ostalih povezanih lica u inostranstvu','D201*-P201*+D2030*-P2030*',420),
  ('BALANCE_SHEET','0043','5. Ostala potraživanja po osnovu prodaje','D206*-P206*',430),
  ('BALANCE_SHEET','0044','IV. OSTALA KRATKOROČNA POTRAŽIVANJA','A0045+A0046+A0047',440),
  ('BALANCE_SHEET','0045','1. Ostala potraživanja','D21*-P21*+D22*-P22*-D223*+P223*-D224*+P224*+D27*-P27*',450),
  ('BALANCE_SHEET','0046','2. Potraživanja za više plaćen porez na dobitak','D223*-P223*',460),
  ('BALANCE_SHEET','0047','3. Potraživanja po osnovu preplaćenih ostalih poreza i doprinosa','D224*-P224*',470),
  ('BALANCE_SHEET','0048','V. KRATKOROČNI FINANSIJSKI PLASMANI','A0049+A0050+A0051+A0052+A0053+A0054+A0055+A0056',480),
  ('BALANCE_SHEET','0049','1. Kratkoročni krediti i plasmani - matično i zavisna pravna lica','D230*-P230*',490),
  ('BALANCE_SHEET','0050','2. Kratkoročni krediti i plasmani - ostala povezana lica','D231*-P231*',500),
  ('BALANCE_SHEET','0051','3. Kratkoročni krediti, zajmovi i plasmani u zemlji','D232*-P232*+D234*-P234*',510),
  ('BALANCE_SHEET','0052','4. Kratkoročni krediti, zajmovi i plasmani u inostranstvu','D233*-P233*',520),
  ('BALANCE_SHEET','0053','5. Hartije od vrednosti koje se vrednuju po amortizovanoj vrednosti','D235*-P235*',530),
  -- 0054: „236 (део)" — nerazdvojivo od 0056; cela grupa 236 pripisana je 0056.
  ('BALANCE_SHEET','0054','6. Finansijska sredstva koja se vrednuju po fer vrednosti kroz Bilans uspeha','MANUAL',540),
  ('BALANCE_SHEET','0055','7. Otkupljene sopstvene akcije i otkupljeni sopstveni udeli','D237*-P237*',550),
  ('BALANCE_SHEET','0056','8. Ostali kratkoročni finansijski plasmani','D236*-P236*+D238*-P238*+D239*-P239*',560),
  ('BALANCE_SHEET','0057','VI. GOTOVINA I GOTOVINSKI EKVIVALENTI','D24*-P24*',570),
  ('BALANCE_SHEET','0058','VII. KRATKOROČNA AKTIVNA VREMENSKA RAZGRANIČENJA','D28*-P28*-D288*+P288*',580),
  ('BALANCE_SHEET','0059','D. UKUPNA AKTIVA = POSLOVNA IMOVINA','A0001+A0002+A0029+A0030',590),
  ('BALANCE_SHEET','0060','Đ. VANBILANSNA AKTIVA','D88*-P88*',600),

-- ── PASIVA ─────────────────────────────────────────────────────────────────
  ('BALANCE_SHEET','0401','A. KAPITAL','A0402+A0403+A0404+A0405+A0406-A0407+A0408+A0411-A0412',610),
  ('BALANCE_SHEET','0402','I. OSNOVNI KAPITAL','P30*-D30*-P306*+D306*',620),
  ('BALANCE_SHEET','0403','II. UPISANI A NEUPLAĆENI KAPITAL','P31*-D31*',630),
  ('BALANCE_SHEET','0404','III. EMISIONA PREMIJA','P306*-D306*',640),
  ('BALANCE_SHEET','0405','IV. REZERVE','P32*-D32*',650),
  -- 0406/0407: obrazac traži saldo PO POJEDINAČNOM KONTU (331…337 zasebno), što DSL
  -- ne ume (nema IIf). 0406 zato uzima SAMO konto 330; potražni saldi 331–337 se gube,
  -- ali se izbegava dvostruko brojanje dugovnog salda (koje bi nastalo da 0406 uzme
  -- neto 331–337, a 0407 isti iznos oduzme u 0401). Kod Servoteha su obe 0/0/0.
  ('BALANCE_SHEET','0406','V. POZITIVNE REVALORIZACIONE REZERVE I NEREALIZOVANI DOBICI PO OSNOVU FINANSIJSKIH SREDSTAVA I DRUGIH KOMPONENTI OSTALOG SVEOBUHVATNOG REZULTATA','P330*-D330*',660),
  ('BALANCE_SHEET','0407','VI. NEREALIZOVANI GUBICI PO OSNOVU FINANSIJSKIH SREDSTAVA I DRUGIH KOMPONENTI OSTALOG SVEOBUHVATNOG REZULTATA','D331*-P331*+D332*-P332*+D333*-P333*+D334*-P334*+D335*-P335*+D336*-P336*+D337*-P337*',670),
  ('BALANCE_SHEET','0408','VII. NERASPOREĐENI DOBITAK','A0409+A0410',680),
  ('BALANCE_SHEET','0409','1. Neraspoređeni dobitak ranijih godina','P340*-D340*',690),
  ('BALANCE_SHEET','0410','2. Neraspoređeni dobitak tekuće godine','P341*-D341*',700),
  ('BALANCE_SHEET','0411','VIII. UČEŠĆE BEZ PRAVA KONTROLE','MANUAL',710),
  ('BALANCE_SHEET','0412','IX. GUBITAK','A0413+A0414',720),
  ('BALANCE_SHEET','0413','1. Gubitak ranijih godina','D350*-P350*',730),
  ('BALANCE_SHEET','0414','2. Gubitak tekuće godine','D351*-P351*',740),
  ('BALANCE_SHEET','0415','B. DUGOROČNA REZERVISANJA I DUGOROČNE OBAVEZE','A0416+A0420+A0428',750),
  ('BALANCE_SHEET','0416','I. DUGOROČNA REZERVISANJA','A0417+A0418+A0419',760),
  ('BALANCE_SHEET','0417','1. Rezervisanja za naknade i druge beneficije zaposlenih','P404*-D404*',770),
  ('BALANCE_SHEET','0418','2. Rezervisanja za troškove u garantnom roku','P400*-D400*',780),
  ('BALANCE_SHEET','0419','3. Ostala dugoročna rezervisanja','P40*-D40*-P400*+D400*-P404*+D404*',790),
  ('BALANCE_SHEET','0420','II. DUGOROČNE OBAVEZE','A0421+A0422+A0423+A0424+A0425+A0426+A0427',800),
  ('BALANCE_SHEET','0421','1. Obaveze koje se mogu konvertovati u kapital','P410*-D410*',810),
  -- 0422/0423: „411 (део) и 412 (део)". Analitike 4110/4120 su „u zemlji", 4111/4121
  -- „u inostranstvu". Sintetike 411/412 (na koje se takođe može knjižiti) pripisane su
  -- domaćoj strani da ne bi ispale iz pasive.
  ('BALANCE_SHEET','0422','2. Dugoročni krediti i ostale dugoročne obaveze prema matičnom, zavisnim i ostalim povezanim licima u zemlji','P411*-D411*-P4111*+D4111*+P412*-D412*-P4121*+D4121*',820),
  ('BALANCE_SHEET','0423','3. Dugoročni krediti i ostale dugoročne obaveze prema matičnom, zavisnim i ostalim povezanim licima u inostranstvu','P4111*-D4111*+P4121*-D4121*',830),
  ('BALANCE_SHEET','0424','4. Dugoročni krediti, zajmovi i obaveze po osnovu lizinga u zemlji','P414*-D414*+P416*-D416*',840),
  ('BALANCE_SHEET','0425','5. Dugoročni krediti, zajmovi i obaveze po osnovu lizinga u inostranstvu','P415*-D415*',850),
  ('BALANCE_SHEET','0426','6. Obaveze po emitovanim hartijama od vrednosti','P413*-D413*',860),
  ('BALANCE_SHEET','0427','7. Ostale dugoročne obaveze','P419*-D419*',870),
  -- 0428: „49 (део), осим 498 и 495 (део)" — nerazdvojivo od 0454; sve PVR osim 498
  -- i 495 pripisano je 0454. Predato 0/0/0.
  ('BALANCE_SHEET','0428','III. DUGOROČNA PASIVNA VREMENSKA RAZGRANIČENJA','MANUAL',880),
  ('BALANCE_SHEET','0429','V. ODLOŽENE PORESKE OBAVEZE','P498*-D498*',890),
  ('BALANCE_SHEET','0430','G. DUGOROČNI ODLOŽENI PRIHODI I PRIMLJENE DONACIJE','P495*-D495*',900),
  ('BALANCE_SHEET','0431','D. KRATKOROČNA REZERVISANJA I KRATKOROČNE OBAVEZE','A0432+A0433+A0441+A0442+A0449+A0453+A0454',910),
  ('BALANCE_SHEET','0432','I. KRATKOROČNA REZERVISANJA','P467*-D467*',920),
  ('BALANCE_SHEET','0433','II. KRATKOROČNE FINANSIJSKE OBAVEZE','A0434+A0435+A0436+A0437+A0438+A0439+A0440',930),
  ('BALANCE_SHEET','0434','1. Obaveze po osnovu kredita prema matičnom, zavisnim i ostalim povezanim licima u zemlji','P420*-D420*+P421*-D421*-P4201*+D4201*',940),
  ('BALANCE_SHEET','0435','2. Obaveze po osnovu kredita prema matičnom, zavisnim i ostalim povezanim licima u inostranstvu','P4201*-D4201*',950),
  -- 0436: podela „domaće banke vs ostali" nije izvodiva iz kontnog plana; ceo „(део)"
  -- pripisan je 0437 da ništa ne ispadne iz pasive. U 2022. je 0436 imao 9.400 —
  -- za reprodukciju te godine po podpozicijama potreban je kriterijum knjigovođe.
  ('BALANCE_SHEET','0436','3. Obaveze po osnovu kredita i zajmova od lica koja nisu domaće banke','MANUAL',960),
  ('BALANCE_SHEET','0437','4. Obaveze po osnovu kredita od domaćih banaka','P422*-D422*+P424*-D424*+P425*-D425*+P429*-D429*',970),
  ('BALANCE_SHEET','0438','5. Krediti, zajmovi i obaveze iz inostranstva','P423*-D423*',980),
  ('BALANCE_SHEET','0439','6. Obaveze po kratkoročnim hartijama od vrednosti','P426*-D426*',990),
  ('BALANCE_SHEET','0440','7. Obaveze po osnovu finansijskih derivata','P428*-D428*',1000),
  ('BALANCE_SHEET','0441','III. PRIMLJENI AVANSI, DEPOZITI I KAUCIJE','P430*-D430*',1010),
  ('BALANCE_SHEET','0442','IV. OBAVEZE IZ POSLOVANJA','A0443+A0444+A0445+A0446+A0447+A0448',1020),
  -- 0443–0446: Servotehove grupe 433/434 nose i povezana lica (4330/4340) i obične
  -- dobavljače (43301, 4331, 4341) — podela je po analitici, ne po sintetici.
  ('BALANCE_SHEET','0443','1. Obaveze prema dobavljačima - matična, zavisna pravna lica i ostala povezana lica u zemlji','P431*-D431*+P4330*-D4330*',1030),
  ('BALANCE_SHEET','0444','2. Obaveze prema dobavljačima - matična, zavisna pravna lica i ostala povezana lica u inostranstvu','P432*-D432*+P4340*-D4340*',1040),
  ('BALANCE_SHEET','0445','3. Obaveze prema dobavljačima u zemlji','P435*-D435*+P433*-D433*-P4330*+D4330*',1050),
  ('BALANCE_SHEET','0446','4. Obaveze prema dobavljačima u inostranstvu','P436*-D436*+P434*-D434*-P4340*+D4340*',1060),
  ('BALANCE_SHEET','0447','5. Obaveze po menicama','P4391*-D4391*+P4392*-D4392*',1070),
  ('BALANCE_SHEET','0448','6. Ostale obaveze iz poslovanja','P439*-D439*-P4391*+D4391*-P4392*+D4392*',1080),
  ('BALANCE_SHEET','0449','V. OSTALE KRATKOROČNE OBAVEZE','A0450+A0451+A0452',1090),
  ('BALANCE_SHEET','0450','1. Ostale kratkoročne obaveze','P44*-D44*+P45*-D45*+P46*-D46*-P467*+D467*',1100),
  ('BALANCE_SHEET','0451','2. Obaveze po osnovu poreza na dodatu vrednost i ostalih javnih prihoda','P47*-D47*+P48*-D48*-P481*+D481*',1110),
  ('BALANCE_SHEET','0452','3. Obaveze po osnovu poreza na dobitak','P481*-D481*',1120),
  ('BALANCE_SHEET','0453','VI. OBAVEZE PO OSNOVU SREDSTAVA NAMENJENIH PRODAJI I SREDSTAVA POSLOVANJA KOJE JE OBUSTAVLJENO','P427*-D427*',1130),
  ('BALANCE_SHEET','0454','VII. KRATKOROČNA PASIVNA VREMENSKA RAZGRANIČENJA','P49*-D49*-P498*+D498*-P495*+D495*',1140),
  -- 0455: mora se klampovati na 0 — za Servoteha 2023 sirovi izraz daje −167.829.
  ('BALANCE_SHEET','0455','Đ. GUBITAK IZNAD VISINE KAPITALA','A0415+A0429+A0430+A0431-A0059',1150),
  ('BALANCE_SHEET','0456','E. UKUPNA PASIVA','A0401+A0415+A0429+A0430+A0431-A0455',1160),
  ('BALANCE_SHEET','0457','Ž. VANBILANSNA PASIVA','P89*-D89*',1170);

-- ============================================================================
-- 2. BILANS USPEHA (INCOME_STATEMENT) — 62 pozicije
--    Kolone obrasca: 5 = tekuća godina, 6 = prethodna → StartnaKolona=5, BrojKolona=2.
-- ============================================================================
INSERT INTO balance_formula_definitions (statement_type, aop, label, formula, ordinal) VALUES
  ('INCOME_STATEMENT','1001','A. POSLOVNI PRIHODI','A1002+A1005+A1008+A1009-A1010+A1011+A1012',10),
  ('INCOME_STATEMENT','1002','I. PRIHODI OD PRODAJE ROBE','A1003+A1004',20),
  ('INCOME_STATEMENT','1003','1. Prihodi od prodaje robe na domaćem tržištu','P600*+P602*+P604*-D600*-D602*-D604*',30),
  ('INCOME_STATEMENT','1004','2. Prihodi od prodaje roba na inostranom tržištu','P601*+P603*+P605*-D601*-D603*-D605*',40),
  ('INCOME_STATEMENT','1005','II. PRIHODI OD PRODAJE PROIZVODA I USLUGA','A1006+A1007',50),
  ('INCOME_STATEMENT','1006','1. Prihodi od prodaje proizvoda i usluga na domaćem tržištu','P610*+P612*+P614*-D610*-D612*-D614*',60),
  ('INCOME_STATEMENT','1007','2. Prihodi od prodaje proizvoda i usluga na inostranom tržištu','P611*+P613*+P615*-D611*-D613*-D615*',70),
  ('INCOME_STATEMENT','1008','III. PRIHODI OD AKTIVIRANJA UČINAKA I ROBE','P62*-D62*',80),
  ('INCOME_STATEMENT','1009','IV. POVEĆANJE VREDNOSTI ZALIHA NEDOVRŠENIH I GOTOVIH PROIZVODA','P630*-D630*',90),
  -- 1010: izuzetak — dugovni saldo unutar klase prihoda; u 1001 ulazi sa MINUSOM.
  ('INCOME_STATEMENT','1010','V. SMANJENJE VREDNOSTI ZALIHA NEDOVRŠENIH I GOTOVIH PROIZVODA','D631*-P631*',100),
  ('INCOME_STATEMENT','1011','VI. OSTALI POSLOVNI PRIHODI','P64*-D64*+P65*-D65*',110),
  ('INCOME_STATEMENT','1012','VII. PRIHODI OD USKLAĐIVANJA VREDNOSTI IMOVINE (OSIM FINANSIJSKE)','P68*-D68*-P683*+D683*-P685*+D685*-P686*+D686*',120),
  ('INCOME_STATEMENT','1013','B. POSLOVNI RASHODI','A1014+A1015+A1016+A1020+A1021+A1022+A1023+A1024',130),
  ('INCOME_STATEMENT','1014','I. NABAVNA VREDNOST PRODATE ROBE','D50*-P50*',140),
  ('INCOME_STATEMENT','1015','II. TROŠKOVI MATERIJALA, GORIVA I ENERGIJE','D51*-P51*',150),
  ('INCOME_STATEMENT','1016','III. TROŠKOVI ZARADA, NAKNADA ZARADA I OSTALI LIČNI RASHODI','A1017+A1018+A1019',160),
  ('INCOME_STATEMENT','1017','1. Troškovi zarada i naknada zarada','D520*-P520*',170),
  ('INCOME_STATEMENT','1018','2. Troškovi poreza i doprinosa na zarade i naknade zarada','D521*-P521*',180),
  ('INCOME_STATEMENT','1019','3. Ostali lični rashodi i naknade','D52*-P52*-D520*+P520*-D521*+P521*',190),
  ('INCOME_STATEMENT','1020','IV. TROŠKOVI AMORTIZACIJE','D540*-P540*',200),
  ('INCOME_STATEMENT','1021','V. RASHODI OD USKLAĐIVANJA VREDNOSTI IMOVINE (OSIM FINANSIJSKE)','D58*-P58*-D583*+P583*-D585*+P585*-D586*+P586*',210),
  ('INCOME_STATEMENT','1022','VI. TROŠKOVI PROIZVODNIH USLUGA','D53*-P53*',220),
  ('INCOME_STATEMENT','1023','VII. TROŠKOVI REZERVISANJA','D54*-P54*-D540*+P540*',230),
  ('INCOME_STATEMENT','1024','VIII. NEMATERIJALNI TROŠKOVI','D55*-P55*',240),
  ('INCOME_STATEMENT','1025','V. POSLOVNI DOBITAK','A1001-A1013',250),
  ('INCOME_STATEMENT','1026','G. POSLOVNI GUBITAK','A1013-A1001',260),
  ('INCOME_STATEMENT','1027','D. FINANSIJSKI PRIHODI','A1028+A1029+A1030+A1031',270),
  ('INCOME_STATEMENT','1028','I. FINANSIJSKI PRIHODI IZ ODNOSA SA MATIČNIM, ZAVISNIM I OSTALIM POVEZANIM LICIMA','P660*+P661*-D660*-D661*',280),
  ('INCOME_STATEMENT','1029','II. PRIHODI OD KAMATA','P662*-D662*',290),
  ('INCOME_STATEMENT','1030','III. POZITIVNE KURSNE RAZLIKE I POZITIVNI EFEKTI VALUTNE KLAUZULE','P663*+P664*-D663*-D664*',300),
  ('INCOME_STATEMENT','1031','IV. OSTALI FINANSIJSKI PRIHODI','P665*+P669*-D665*-D669*',310),
  ('INCOME_STATEMENT','1032','Đ. FINANSIJSKI RASHODI','A1033+A1034+A1035+A1036',320),
  ('INCOME_STATEMENT','1033','I. FINANSIJSKI RASHODI IZ ODNOSA SA MATIČNIM, ZAVISNIM I OSTALIM POVEZANIM LICIMA','D560*+D561*-P560*-P561*',330),
  ('INCOME_STATEMENT','1034','II. RASHODI KAMATA','D562*-P562*',340),
  ('INCOME_STATEMENT','1035','III. NEGATIVNE KURSNE RAZLIKE I NEGATIVNI EFEKTI VALUTNE KLAUZULE','D563*+D564*-P563*-P564*',350),
  ('INCOME_STATEMENT','1036','IV. OSTALI FINANSIJSKI RASHODI','D565*+D569*-P565*-P569*',360),
  ('INCOME_STATEMENT','1037','E. DOBITAK IZ FINANSIRANJA','A1027-A1032',370),
  ('INCOME_STATEMENT','1038','Ž. GUBITAK IZ FINANSIRANJA','A1032-A1027',380),
  ('INCOME_STATEMENT','1039','Z. PRIHODI OD USKLAĐIVANJA VREDNOSTI FINANSIJSKE IMOVINE KOJA SE ISKAZUJE PO FER VREDNOSTI KROZ BILANS USPEHA','P683*+P685*+P686*-D683*-D685*-D686*',390),
  ('INCOME_STATEMENT','1040','I. RASHODI OD USKLAĐIVANJA VREDNOSTI FINANSIJSKE IMOVINE KOJA SE ISKAZUJE PO FER VREDNOSTI KROZ BILANS USPEHA','D583*+D585*+D586*-P583*-P585*-P586*',400),
  ('INCOME_STATEMENT','1041','J. OSTALI PRIHODI','P67*-D67*',410),
  ('INCOME_STATEMENT','1042','K. OSTALI RASHODI','D57*-P57*',420),
  ('INCOME_STATEMENT','1043','L. UKUPNI PRIHODI','A1001+A1027+A1039+A1041',430),
  ('INCOME_STATEMENT','1044','LJ. UKUPNI RASHODI','A1013+A1032+A1040+A1042',440),
  ('INCOME_STATEMENT','1045','M. DOBITAK IZ REDOVNOG POSLOVANJA PRE OPOREZIVANJA','A1043-A1044',450),
  ('INCOME_STATEMENT','1046','N. GUBITAK IZ REDOVNOG POSLOVANJA PRE OPOREZIVANJA','A1044-A1043',460),
  -- 1047/1048: obrazac piše „69-59" odnosno „59-69" (razlika grupa, ne lista grupa).
  -- Konta prenosa 599 i 699 su IZUZETA — ako glavna knjiga sadrži zaključna knjiženja,
  -- ona bi ih inače pokupila i pozicija bi eksplodirala.
  ('INCOME_STATEMENT','1047','NJ. POZITIVAN NETO EFEKAT NA REZULTAT PO OSNOVU DOBITKA POSLOVANJA KOJE SE OBUSTAVLJA, PROMENA RAČUNOVODSTVENIH POLITIKA I ISPRAVKI GREŠAKA IZ RANIJIH PERIODA','P69*-D69*-P699*+D699*-D59*+P59*+D599*-P599*',470),
  ('INCOME_STATEMENT','1048','O. NEGATIVAN NETO EFEKAT NA REZULTAT PO OSNOVU GUBITKA POSLOVANJA KOJE SE OBUSTAVLJA, PROMENA RAČUNOVODSTVENIH POLITIKA I ISPRAVKI GREŠAKA IZ RANIJIH PERIODA','D59*-P59*-D599*+P599*-P69*+D69*+P699*-D699*',480),
  ('INCOME_STATEMENT','1049','P. DOBITAK PRE OPOREZIVANJA','A1045-A1046+A1047-A1048',490),
  ('INCOME_STATEMENT','1050','R. GUBITAK PRE OPOREZIVANJA','A1046-A1045+A1048-A1047',500),
  ('INCOME_STATEMENT','1051','I. PORESKI RASHOD PERIODA','D721*-P721*',510),
  -- 1052/1053: „722 дуг. салдо" / „722 пот. салдо" — obrnuti par nad ISTIM kontom;
  -- klamp odseca pogrešan smer (DSL nema IIf).
  ('INCOME_STATEMENT','1052','II. ODLOŽENI PORESKI RASHODI PERIODA','D722*-P722*',520),
  ('INCOME_STATEMENT','1053','III. ODLOŽENI PORESKI PRIHODI PERIODA','P722*-D722*',530),
  -- 1054: obrazac traži grupu 723 = „Исплаћена лична примања послодавца", ali kod
  -- Servoteha je 723 = „Prenos dobitka ili gubitka" (7230/7231). Maska bi pokupila
  -- prenos rezultata i uništila 1055. MANUAL do potvrde knjigovođe.
  ('INCOME_STATEMENT','1054','T. ISPLAĆENA LIČNA PRIMANJA POSLODAVCA','MANUAL',540),
  ('INCOME_STATEMENT','1055','Ć. NETO DOBITAK','A1049-A1050-A1051-A1052+A1053-A1054',550),
  ('INCOME_STATEMENT','1056','U. NETO GUBITAK','A1050-A1049+A1051+A1052-A1053+A1054',560),
  ('INCOME_STATEMENT','1057','I. NETO DOBITAK KOJI PRIPADA UČEŠĆIMA BEZ PRAVA KONTROLE','MANUAL',570),
  ('INCOME_STATEMENT','1058','II. NETO DOBITAK KOJI PRIPADA MATIČNOM PRAVNOM LICU','MANUAL',580),
  ('INCOME_STATEMENT','1059','III. NETO GUBITAK KOJI PRIPADA UČEŠĆIMA BEZ PRAVA KONTROLE','MANUAL',590),
  ('INCOME_STATEMENT','1060','IV. NETO GUBITAK KOJI PRIPADA MATIČNOM PRAVNOM LICU','MANUAL',600),
  ('INCOME_STATEMENT','1061','1. Osnovna zarada po akciji','MANUAL',610),
  ('INCOME_STATEMENT','1062','2. Umanjena (razvodnjena) zarada po akciji','MANUAL',620);

-- ============================================================================
-- STATUS: BALANCE_SHEET 117 redova (110 formula + 7 MANUAL),
--         INCOME_STATEMENT 62 reda (55 formula + 7 MANUAL). Ukupno 179.
-- MANUAL BS: 0016, 0020, 0028, 0054, 0411, 0428, 0436
-- MANUAL BU: 1054, 1057, 1058, 1059, 1060, 1061, 1062
-- Labele su transliterovane sa ćirilice obrasca u srpsku latinicu (mehanički);
-- APR FiForma XML nosi samo AOP + iznos, pa transliteracija ne utiče na predaju.
-- Detaljno obrazloženje svake odluke, prihvaćeni i odbačeni nalazi provere i
-- otvorena pitanja: backend/docs/migration/ZR_AOP_FORMULE_AUTENTICNE.md
-- ============================================================================
