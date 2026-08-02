-- ============================================================================
-- SEED: saldakonto_accounts (9, + kolona partner_scope) + accounting_schemes 19 šema (+67 linija)
-- ============================================================================
-- SVRHA: dva registra su na produkciji PRAZNA i zbog toga pola finansijskog modula
-- radi „tiho pogrešno":
--   • saldakonto_accounts = 0 redova → otvorene stavke / aging / IOS / opomene /
--     priprema plaćanja / kartica komitenta / revalorizacija vraćaju PRAZNO bez ijedne
--     poruke o grešci (INNER JOIN na prazan registar), a assertCreditLimit vidi saldo 0
--     pa kreditni limit kupca de facto NE POSTOJI (tiho propušta svaku fakturu).
--   • accounting_schemes = 2 od 25 aktivnih → postFromStockDocument pada
--     (findUniqueOrThrow) za većinu vrsta robnih dokumenata.
--
-- IZVOR ISTINE: backend/docs/migration/BIGBIT_KONTA_I_SEME_KNJIZENJA.md
--   §5.1  `PSF_AnalitickaKonta_T` — ceo BigBit registar saldakonta (9 redova)
--   §3.4  svih 30 BigBit šema sa linijama; §7.2 (S1–S10), §7.3 (SK1–SK3) — akcije
-- Primarni podaci: _legacy/.../BB_T_26.mdb ("Sema za kontiranje", "Stavke seme za
-- kontiranje", "PSF_AnalitickaKonta_T"), snimak 11.07.2026.
--
-- OBRAZAC: identičan migraciji 20260723160000_seed_accounting_schemes_33_36
--   (a) eksplicitan legacy id šeme (posting engine je traži po fiksnom broju
--       = DocumentType.postingTemplate = legacy IDSeme),
--   (b) ON CONFLICT DO NOTHING na zaglavljima,
--   (c) linije bez uq(scheme_id, line_no) → guard `NOT EXISTS (linije te šeme)`,
--       ovde korelisan po v.scheme_id (isti guard, samo za 19 šema odjednom),
--   (d) setval sekvence na kraju.
--
-- ADITIVNA I IDEMPOTENTNA: ne briše i ne menja nijedan postojeći red (33/36 ostaju
-- netaknute), ponovno izvršavanje ne duplira ništa.
--
-- FK: accounting_scheme_lines.account_code → accounts.code (NoAction). Svih 32 konta
--   koja ove linije koriste provereno postoje u `accounts` (seed 20260723155000,
--   1398 konta) — provereno na DEV-u pre primene. saldakonto_accounts.account →
--   accounts.code (Cascade) — svih 9 konta postoji.
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 1) SALDAKONTO REGISTAR — 9 konta iz `PSF_AnalitickaKonta_T` (doc §5.1)
-- ────────────────────────────────────────────────────────────────────────────
-- BigBit kolone → naše: OTST → tracks_open_items, DinSaldo → holds_din_balance,
-- DevSaldo → holds_fx_balance. U BigBit-u je na svih 9 redova OTST=1, DinSaldo=1,
-- DevSaldo=0 — prepisano doslovno.
--
-- ⚠️ `tracks_open_items` je kolona OD KOJE SVE ZAVISI: svi čitaoci otvorenih stavki
--    (open-items.service listOpenItems/agingByPartner/listMixedFxCurrencyGroups,
--    partner-card, kamata, fakturisanje.assertCreditLimit) filtriraju
--    `sa.tracks_open_items = TRUE`. Zato je TRUE na svih 9 (paritet sa OTST=1).
--
-- `side` = prirodna strana salda ('receivable' | 'payable'), jer po njoj filtriraju
--    payment-preparation.selectDue (side='payable') i kamata (side='receivable').
--    Dati avansi (1520/1521/1530) su POTRAŽIVANJA i idu kao 'receivable'; primljeni
--    avansi (4300/4302) su OBAVEZE i idu kao 'payable'.
--
-- `partner_scope` = VRSTA PARTNERA ('customer' | 'supplier') — NOVA kolona, uvedena
--    ovom migracijom (remedijacija po reviziji, v. REMEDIJACIJA_PO_BIGBIT_STUDIJI.md).
--    Bez nje `side` nosi DVA značenja („strana salda" i „vrsta partnera") i to daje
--    dva dokazana defekta:
--      • 4300/4302 (primljeni avansi KUPACA) su po saldu 'payable', pa ih je
--        payment-preparation.selectDue uzimao kao DOSPELE OBAVEZE → kupčev avans
--        završava u nalogu za prenos i e-banking izvozu (novac se vraća kupcu);
--      • 1520/1521/1530 (dati avansi DOBAVLJAČIMA) su po saldu 'receivable', pa su
--        ulazili u kreditni limit KUPCA i u osnovicu zatezne kamate.
--    Zato: 2040/2050/4300/4302 → 'customer', 1520/1521/1530/4350/4360 → 'supplier'.
--    Čitaoci koji biraju partnera (selectDue, assertCreditLimit, kamata, aging bez
--    konta) filtriraju po `partner_scope`, a NE po `side`. NULL = nepoznato → takav
--    konto se NE uzima ni u plaćanja ni u kreditni limit (strogo, jer je u pitanju
--    izlaz novca).
--
-- `control_account` = sintetika (3 cifre) — NEMA je u BigBit-u, naše je proširenje
--    (schema.prisma:2833). Koristi je SAMO reconciliation.assertSamePartnerScope, i to
--    poređenjem na jednakost → bitno je da grupisanje bude smisleno, ne sam broj.
--    Zato: 2040→204 i 2050→205 su RAZLIČITI (domaći kupac se ne upari sa inostranim),
--    isto 4350→435 vs 4360→436. Napomena: komentar u schema.prisma pominje „2040->202"
--    — to je omaška u komentaru, sintetika konta 2040 je 204 (BigBit nema tu kolonu
--    pa nema ni izvora za „202"). Ovde je dosledno korišćen 3-cifreni prefiks.
--
-- `holds_fx_balance` = FALSE na svih 9 (BigBit DevSaldo=0, i za 2050/4360 — doc §5.1
--    i §7.3/SK3). Kolonu trenutno NE ČITA nijedan deo koda (provereno grep-om), pa je
--    vrednost čisto dokumentaciona; devizni saldo u 4.0 (fx_revaluation) radi preko
--    ledger_entries.fx_* i ne zavisi od nje. ⏳ Kad se devizni saldakonto svesno uvede,
--    kandidati su 1530 / 2050 / 4302 / 4360 (konta „inostranstvo") — to je NOVO, nije
--    paritet, i traži odluku (doc §7.3 SK3).
ALTER TABLE saldakonto_accounts
  ADD COLUMN IF NOT EXISTS partner_scope VARCHAR(10);
COMMENT ON COLUMN saldakonto_accounts.partner_scope IS
  'customer | supplier — vrsta partnera na kontu (NE strana salda). Po njoj biraju priprema placanja, kreditni limit, kamata i aging.';

INSERT INTO saldakonto_accounts
  (account, side, partner_scope, control_account, tracks_open_items, holds_din_balance, holds_fx_balance)
VALUES
  ('1520', 'receivable', 'supplier', '152', true, true, false), -- Placeni avansi za robu u zemlji
  ('1521', 'receivable', 'supplier', '152', true, true, false), -- Placeni avansi (ostalo)
  ('1530', 'receivable', 'supplier', '153', true, true, false), -- Placeni avansi za robu u inostranstvu
  ('2040', 'receivable', 'customer', '204', true, true, false), -- Kupci u zemlji
  ('2050', 'receivable', 'customer', '205', true, true, false), -- Kupci u inostranstvu
  ('4300', 'payable',    'customer', '430', true, true, false), -- Primljeni avansi, depoziti i kaucije
  ('4302', 'payable',    'customer', '430', true, true, false), -- Primljeni avansi od inostranih pravnih lica
  ('4350', 'payable',    'supplier', '435', true, true, false), -- Dobavljaci u zemlji
  ('4360', 'payable',    'supplier', '436', true, true, false)  -- Dobavljaci u inostranstvu
ON CONFLICT (account) DO NOTHING;

-- Dopuni scope i na redovima koji su vec postojali (rucni unos pre ove migracije).
UPDATE saldakonto_accounts SET partner_scope = 'customer'
  WHERE partner_scope IS NULL AND account IN ('2040', '2050', '4300', '4302');
UPDATE saldakonto_accounts SET partner_scope = 'supplier'
  WHERE partner_scope IS NULL AND account IN ('1520', '1521', '1530', '4350', '4360');


-- ────────────────────────────────────────────────────────────────────────────
-- 2) ŠEME KONTIRANJA — 19 novih šema (33 i 36 su već seedovane 20260723160000)
-- ────────────────────────────────────────────────────────────────────────────
-- Od 30 BigBit šema seedujemo 21 (19 ovde + 33/36 ranije) = svih 25 aktivnih minus 4
-- koje se svesno izostavljaju (30/31 i 37/38, obrazloženje ispod).
--
-- NE SEEDUJE SE (9 šema):
--   • 21 VPTR, 28 KNZ, 29 VPSIR, 32 UVOZ, 39 AVR — MRTVE u BigBit-u: nijedna vrsta
--     dokumenta ne pokazuje na njih (doc §3.4 „Sumarno" + §7.2/S3). Uz to gađaju
--     konta bez ijedne stavke u GK (13600, 20200, 47000, 47100, 50140, 60240, 67300).
--     Poseban razlog za 28 (KNZ): DefDug je `0+P+Q` — vodeći znak je CIFRA nula
--     umesto slova O (doc §7.2/S4), tj. osnovica bi ispala iz naloga. Pokvarena
--     definicija se NE prepisuje; šema je ionako mrtva.
--     Napomena za 39 (AVR): avansi u 4.0 idu kroz advance-invoice.service (konta
--     2040/2050, 4300, 4720/4730), ne kroz robnu šemu — seedovanje bi napravilo
--     drugi, konkurentski put knjiženja avansa.
--   • 37 MMPM i 38 MMPR — AKTIVNE ali JEDNOSTRANE: svaka ima tačno jednu liniju
--     (37: `1010` duguje A; 38: `1320` duguje A) → nalog NE BALANSIRA (doc §7.2/S5).
--     Kod nas bi LedgerNotBalancedException odbio svako knjiženje, pa bi seed dao
--     šemu koja NE MOŽE da proknjiži ništa. Protivstavka je u BigBit-u trebalo da
--     dođe iz sentinela `Konto="MAG"` → `Magacini.KontoMag` (doc §3.7, §7.2/S7), što
--     naš posting engine još ne podržava. Dopuna protivstavke = poslovna odluka
--     (koji je konto odredišnog magacina) → traži potvrdu knjigovođe. Do tada se
--     šema NE seeduje, umesto da se izmisli protivstavka.
--
--   • 30 IFUSL i 31 KNO — AKTIVNE, ali obe knjiže kupca na konto `2020` („Kupci u
--     zemlji — ostala povezana lica", 0 stavki u GK 2025 i 2026), a `2020` NIJE u
--     saldakonto registru (registar ima 9 konta, doc §5.1). Posledica bi bila tiho
--     pogrešno: uslužna faktura i knjižno odobrenje NE BI postojali u otvorenim
--     stavkama, aging-u, IOS-u, opomenama, kartici komitenta ni u kreditnom limitu
--     (svi ti čitaoci rade INNER JOIN na `saldakonto_accounts`), a knjižno odobrenje
--     (2020) ne bi umanjivalo dug kupca sa fakture (2040). Uz to šema 31 gađa konta
--     `470`/`471` kojih nema u BigBit kontnom planu.
--     Doc §7.2/S6 traži ispravku na `4700`/`4710` I `2040`/`6040` UZ POTVRDU
--     KNJIGOVOĐE — a §6.6 pokazuje da stvarni prihod od usluga ide na `6140`, ne na
--     `6121` iz šeme 30. Pošto je izbor konta poslovna odluka (i mora obuhvatiti obe
--     šeme zajedno), ove dve šeme se NE SEEDUJU — isti postupak kao za 37/38.
--     Efekat je nula: nijedan 4.0 tok danas ne knjiži kroz njih (izlazne fakture i
--     odobrenja knjiži `sales/fakturisanje.service` sopstvenim kontima 2040/4700),
--     a `document_types.posting_template` je 0. ⏳ ČEKA ODLUKU KNJIGOVOĐE.
--
-- NORMALIZOVANO (oblik, ne sadržaj) — negativni izrazi prebačeni na suprotnu stranu:
--   BigBit dozvoljava negativan iznos na strani duguje/potražuje (šeme 31, 44, 45,
--   48, 54 imaju `-A`, `-O-P-Q`, `-P`, `-Q`, `-O`). Kod nas to NE prolazi: constraint
--   `chk_ledger_entries_nonnegative` (migracija 20260725200000) traži
--   `debit >= 0 AND credit >= 0`, pa bi svako takvo knjiženje puklo sirovom greškom
--   baze. „−X duguje" je u dvojnom knjigovodstvu identično sa „+X potražuje", pa je
--   svaki takav izraz prebačen na suprotnu stranu bez znaka. Sadržaj naloga je
--   nepromenjen; usput šeme 44/45/48/54 tek sada i BALANSIRAJU (ranije 0=0 uz dve
--   linije na istoj strani). Original je naveden uz svaku izmenjenu liniju.
--
-- PRESLIKANO DOSLOVNO: `posts_analytics` (Analitika) = true, `origin` (Poreklo) = 'X',
--   `item_codebook` (KngSifra_2) = '0' — takve su sve 105 linije u BigBit-u; grananje
--   po Poreklu/KngSifra_2 se ne koristi i ne implementira (doc §7.2/S9).
--
-- ⚠️ ŠEME OSTAJU NEAKTIVNE dok se ne popuni `document_types.posting_template`
--   (= legacy IDSeme). To je zasebna stavka i NIJE deo ove migracije — dok je
--   postingTemplate 0, posting engine baci NoPostingSchemeException pre nego što
--   uopšte pogleda registar šema.

-- ── 2a) Zaglavlja šema (eksplicitan legacy id = IDSeme) ─────────────────────
INSERT INTO accounting_schemes (id, order_type, description) VALUES
  ( 3, 'UFROB', 'Ulaz robe'),
  (24, 'IZVRO', 'IZVOZ ROBE'),
  (26, 'TREB',  'Trebovanje'),
  (34, 'UFMAT', 'UFMAT'),
  (35, 'ULGP',  'ULGP'),
  (40, 'REPRE', 'REPREZENTACIJA'),
  (41, 'VISAM', 'VISAK MATERIJALA'),
  (42, 'DONAC', 'DONACIJA'),
  (43, 'TREB1', 'TREBOVANJE ROBE'),
  (44, 'REZM',  'Materijal na rezervaciji'),
  (45, 'REZR',  'Roba na rezervaciji'),
  (46, 'VISAR', 'VISAK ROBE'),
  (47, 'IZVGP', 'IZVOZ GOTOVIH PROIZVODA'),
  (48, 'USLMA', 'USLMA'),
  (49, 'MANJM', 'MANJAK MATERIJALA'),
  (50, 'MANJR', 'MANJAK ROBE'),
  (52, 'OTPIM', 'OTPIS MATERIJALA'),
  (53, 'OTPIR', 'OTPIS ROBE'),
  (54, 'ZEMLJ', 'UTROSAK ROBE ZA POPRAVKE')
ON CONFLICT (id) DO NOTHING;

-- ── 2b) Linije šema ─────────────────────────────────────────────────────────
-- DefDug/DefPot = izrazi nad slovima A–Z (safe parser, NE eval). Prazno/„0" u
-- BigBit CSV-u = strana se ne knjiži → NULL. Slova (doc §3.2):
--   A = nabavna neto vrednost (ulaz)   B/C = zavisni troškovi   D = ulazni PDV 20%
--   E = ulazni PDV 10%                 O = osnovica (izlaz)     P = izlazni PDV 20%
--   Q = izlazni PDV 10%
-- Guard je korelisan po šemi (v.scheme_id): šema koja VEĆ ima linije se preskače,
-- ostale se pune — isto pravilo kao u 20260723160000, samo za 19 šema odjednom.
INSERT INTO accounting_scheme_lines
  (scheme_id, account_code, description, def_debit, def_credit, posts_analytics, origin, item_codebook, line_no)
SELECT v.scheme_id::int, v.account_code::varchar, v.description::varchar,
       v.def_debit::varchar, v.def_credit::varchar, v.posts_analytics::boolean,
       v.origin::varchar, v.item_codebook::varchar, v.line_no::int
FROM (VALUES
  -- ── 3 UFROB (ulaz robe): zaduži zalihu i pretporez, odobri dobavljača ──────
  ( 3, '1320', NULL,                  'A+B+C',   NULL,        true, 'X', '0', 0),
  ( 3, '2700', NULL,                  'D',       NULL,        true, 'X', '0', 1),
  ( 3, '4350', NULL,                  NULL,      'A+B+C+D+E', true, 'X', '0', 2),
  ( 3, '2710', NULL,                  'E',       NULL,        true, 'X', '0', 3),
  -- ── 24 IZVRO (izvoz robe): kupac u inostranstvu, prihod, razduženje zalihe ─
  (24, '2050', NULL,                  'O',       NULL,        true, 'X', '0', 0),
  (24, '6050', NULL,                  NULL,      'O',         true, 'X', '0', 1),
  (24, '1320', NULL,                  NULL,      'A',         true, 'X', '0', 2),
  (24, '5013', NULL,                  'A',       NULL,        true, 'X', '0', 3),
  -- ── 26 TREB (trebovanje materijala) ───────────────────────────────────────
  (26, '5110', NULL,                  'A',       NULL,        true, 'X', '0', 0),
  (26, '1010', NULL,                  NULL,      'A',         true, 'X', '0', 1),
  -- (30 IFUSL i 31 KNO se NE seeduju — v. obrazloženje u zaglavlju)
  -- ── 34 UFMAT (ulazna faktura materijala) ──────────────────────────────────
  (34, '4350', NULL,                  NULL,      'A+D+E',     true, 'X', '0', 0),
  (34, '2700', NULL,                  'D',       NULL,        true, 'X', '0', 1),
  (34, '1010', NULL,                  'A',       NULL,        true, 'X', '0', 2),
  (34, '2710', NULL,                  'E',       NULL,        true, 'X', '0', 3),
  -- ── 35 ULGP (ulaz gotovih proizvoda; klasa 9 = interni obračun) ───────────
  (35, '1200', NULL,                  'A',       NULL,        true, 'X', '0', 0),
  (35, '9020', NULL,                  NULL,      'A',         true, 'X', '0', 1),
  (35, '9600', NULL,                  'A',       NULL,        true, 'X', '0', 2),
  (35, '1200', NULL,                  NULL,      'A',         true, 'X', '0', 3),
  -- ── 40 REPRE (reprezentacija) ─────────────────────────────────────────────
  (40, '1320', NULL,                  NULL,      'A',         true, 'X', '0', 0),
  (40, '5010', NULL,                  'A',       NULL,        true, 'X', '0', 1),
  (40, '6040', NULL,                  NULL,      'A',         true, 'X', '0', 2),
  (40, '5510', NULL,                  'A+P+Q',   NULL,        true, 'X', '0', 3),
  (40, '4700', NULL,                  NULL,      'P',         true, 'X', '0', 4),
  (40, '4710', NULL,                  NULL,      'Q',         true, 'X', '0', 5),
  -- ── 41 VISAM (višak materijala) — opis 'MATERIIJAL' je legacy tipfeler ─────
  (41, '1010', 'MATERIIJAL',          'A',       NULL,        true, 'X', '0', 0),
  (41, '6740', NULL,                  NULL,      'A',         true, 'X', '0', 1),
  -- ── 42 DONAC (donacija) ───────────────────────────────────────────────────
  (42, '1320', NULL,                  NULL,      'A',         true, 'X', '0', 0),
  (42, '5010', NULL,                  'A',       NULL,        true, 'X', '0', 1),
  (42, '6040', NULL,                  NULL,      'A',         true, 'X', '0', 2),
  (42, '4700', NULL,                  NULL,      'P',         true, 'X', '0', 3),
  (42, '5793', NULL,                  'A+P',     NULL,        true, 'X', '0', 4),
  -- ── 43 TREB1 (trebovanje robe) ────────────────────────────────────────────
  (43, '1320', NULL,                  NULL,      'A',         true, 'X', '0', 0),
  (43, '51100', NULL,                 'A',       NULL,        true, 'X', '0', 1),
  -- ── 44 REZM (materijal na rezervaciji) — NORMALIZOVANO ────────────────────
  --    legacy: 1010 DefDug '-A' → ovde potražuje 'A'
  (44, '1010', NULL,                  NULL,      'A',         true, 'X', '0', 0),
  (44, '1011', NULL,                  'A',       NULL,        true, 'X', '0', 1),
  -- ── 45 REZR (roba na rezervaciji) — NORMALIZOVANO ─────────────────────────
  --    legacy: 1320 DefDug '-A' → ovde potražuje 'A'
  (45, '1320', NULL,                  NULL,      'A',         true, 'X', '0', 0),
  (45, '1321', NULL,                  'A',       NULL,        true, 'X', '0', 1),
  -- ── 46 VISAR (višak robe) ─────────────────────────────────────────────────
  (46, '1320', NULL,                  'A',       NULL,        true, 'X', '0', 0),
  (46, '6740', NULL,                  NULL,      'A',         true, 'X', '0', 1),
  -- ── 47 IZVGP (izvoz gotovih proizvoda) ────────────────────────────────────
  (47, '2050', NULL,                  'O',       NULL,        true, 'X', '0', 0),
  (47, '6150', NULL,                  NULL,      'O',         true, 'X', '0', 1),
  (47, '9800', NULL,                  'A',       NULL,        true, 'X', '0', 2),
  (47, '9600', NULL,                  NULL,      'A',         true, 'X', '0', 3),
  -- ── 48 USLMA (materijal utrošen na uslugu) — NORMALIZOVANO ────────────────
  --    legacy: 1010 DefDug '-A' → ovde potražuje 'A'
  (48, '1010', NULL,                  NULL,      'A',         true, 'X', '0', 0),
  (48, '5110', NULL,                  'A',       NULL,        true, 'X', '0', 1),
  -- ── 49 MANJM (manjak materijala) ──────────────────────────────────────────
  (49, '1010', NULL,                  NULL,      'A',         true, 'X', '0', 0),
  (49, '4700', NULL,                  NULL,      'P',         true, 'X', '0', 1),
  (49, '6040', NULL,                  NULL,      'A',         true, 'X', '0', 2),
  (49, '5110', NULL,                  'A',       NULL,        true, 'X', '0', 3),
  (49, '5740', NULL,                  'A+P',     NULL,        true, 'X', '0', 4),
  -- ── 50 MANJR (manjak robe) ────────────────────────────────────────────────
  (50, '1320', NULL,                  NULL,      'A',         true, 'X', '0', 0),
  (50, '4700', NULL,                  NULL,      'P',         true, 'X', '0', 1),
  (50, '6040', NULL,                  NULL,      'A',         true, 'X', '0', 2),
  (50, '5010', NULL,                  'A',       NULL,        true, 'X', '0', 3),
  (50, '5741', NULL,                  'A+P',     NULL,        true, 'X', '0', 4),
  -- ── 52 OTPIM (otpis materijala) ───────────────────────────────────────────
  (52, '1010', NULL,                  NULL,      'A',         true, 'X', '0', 0),
  (52, '4700', NULL,                  NULL,      'P',         true, 'X', '0', 1),
  (52, '6040', NULL,                  NULL,      'A',         true, 'X', '0', 2),
  (52, '5110', NULL,                  'A',       NULL,        true, 'X', '0', 3),
  (52, '5795', NULL,                  'A+P',     NULL,        true, 'X', '0', 4),
  -- ── 53 OTPIR (otpis robe) ─────────────────────────────────────────────────
  (53, '1320', NULL,                  NULL,      'A',         true, 'X', '0', 0),
  (53, '4700', NULL,                  NULL,      'P',         true, 'X', '0', 1),
  (53, '6040', NULL,                  NULL,      'A',         true, 'X', '0', 2),
  (53, '5010', NULL,                  'A',       NULL,        true, 'X', '0', 3),
  (53, '5796', NULL,                  'A+P',     NULL,        true, 'X', '0', 4),
  -- ── 54 ZEMLJ (utrošak robe za popravke) — NORMALIZOVANO ───────────────────
  --    legacy: 1320 DefDug '-A' → ovde potražuje 'A'
  (54, '1320', NULL,                  NULL,      'A',         true, 'X', '0', 0),
  (54, '5012', NULL,                  'A',       NULL,        true, 'X', '0', 1)
) AS v(scheme_id, account_code, description, def_debit, def_credit, posts_analytics, origin, item_codebook, line_no)
WHERE NOT EXISTS (
  SELECT 1 FROM accounting_scheme_lines l WHERE l.scheme_id = v.scheme_id
);

-- ── 2c) Pomeri id-sekvencu iznad ubačenih fiksnih legacy id-eva ─────────────
SELECT setval(pg_get_serial_sequence('accounting_schemes', 'id'),
              (SELECT MAX(id) FROM accounting_schemes));
