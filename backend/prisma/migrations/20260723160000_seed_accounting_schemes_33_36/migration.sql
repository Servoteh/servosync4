-- ============================================================================
-- SEED: accounting_schemes 33 (IFR) + 36 (IFGP) i njihove linije
-- ============================================================================
-- SVRHA (defekt B6 / C13, doc PLAN_TALAS_1C-1E §2): šeme kontiranja 33/36 (auto-robno
-- GL — "Knjiži" na robnom dokumentu / izlaznoj fakturi, doc PLAN §1 stavka #44) su
-- do sada živele SAMO u backend/prisma/_nacrt-4.0-faza2-seme-seed.ts, koji NIJE
-- povezan ni u jedan runner. Na bazi bez tih šema posting.service.ts padne
-- (findUniqueOrThrow { id: 33|36 }) čim neko klikne "Knjiži". Ova migracija ih
-- pretvara u ADITIVNU, IDEMPOTENTNU data-migraciju koju migrate deploy sam primeni.
--
-- OBUHVAT: SAMO šeme 33/36 (ne svih 30 iz _nacrt-a). Razlog: ostale šeme koriste 8
--   analitičkih konta (13600, 20200, 470, 471, 47100, 50140, 60240, 67300) koja NE
--   postoje u `accounts` → FK fk_scheme_lines_account bi pao. Šeme 33/36 koriste
--   samo postojeća konta (2040, 4702, 4710, 6040, 1320, 5010 / 2040, 6141, 4701,
--   9600, 9800 — provereno na dev). Pun 30-šema seed čeka proširenje accounts seed-a
--   za tih 8 konta (Talas 2). IZVOR podataka: _nacrt-4.0-faza2-seme-seed.ts (BB_T_26
--   "Sema za kontiranje.csv" + "Stavke seme za kontiranje.csv").
--
-- IDEMPOTENTNOST:
--   • Šeme: posting engine ih traži po FIKSNOM id-u (= legacy IDSeme = DocumentType.
--     postingTemplate), pa ubacujemo eksplicitan id 33/36 uz ON CONFLICT (id) DO NOTHING.
--   • Linije: nema uq (scheme_id, line_no) u šemi → guard `WHERE NOT EXISTS (linije te
--     šeme)`; re-run ne duplira. Guard je po-šemi (33 i 36 nezavisno).
--   • Sekvenca: posle eksplicitnih id-eva pomeri accounting_schemes.id sekvencu na
--     MAX(id) da budući autoincrement ne kolidira sa fiksnim legacy id-evima.
--
-- ⚠️ FK: accounting_scheme_lines.account_code → accounts.code (NoAction). Sva konta
--   koja linije 33/36 koriste MORAJU postojati u accounts pre ove migracije. Na dev
--   provereno (svih 10 postoji). Ako na prod nedostaju → seed kontnog plana ide PRE.
-- ============================================================================

-- ── 1) Zaglavlja šema (eksplicitan legacy id) ───────────────────────────────
INSERT INTO accounting_schemes (id, order_type, description) VALUES
  (33, 'IFR', 'IFR'),
  (36, 'IFGP', 'IZLAZ GOT.PROIZVODA')
ON CONFLICT (id) DO NOTHING;

-- ── 2) Linije šeme 33 (IFR) ─────────────────────────────────────────────────
-- DefDug/DefPot = izrazi nad slovima A-Z (safe parser, NE eval). Prazno u CSV = null.
INSERT INTO accounting_scheme_lines
  (scheme_id, account_code, description, def_debit, def_credit, posts_analytics, origin, item_codebook, line_no)
SELECT v.scheme_id::int, v.account_code::varchar, v.description::varchar,
       v.def_debit::varchar, v.def_credit::varchar, v.posts_analytics::boolean,
       v.origin::varchar, v.item_codebook::varchar, v.line_no::int
FROM (VALUES
  (33, '2040', NULL, 'O+P+Q', NULL, true, 'X', '0', 0),
  (33, '4702', NULL, NULL,    'P',  true, 'X', '0', 1),
  (33, '4710', NULL, NULL,    'Q',  true, 'X', '0', 2),
  (33, '6040', NULL, NULL,    'O',  true, 'X', '0', 3),
  (33, '1320', NULL, NULL,    'A',  true, 'X', '0', 4),
  (33, '5010', NULL, 'A',     NULL, true, 'X', '0', 5)
) AS v(scheme_id, account_code, description, def_debit, def_credit, posts_analytics, origin, item_codebook, line_no)
WHERE NOT EXISTS (SELECT 1 FROM accounting_scheme_lines l WHERE l.scheme_id = 33);

-- ── 3) Linije šeme 36 (IFGP) ────────────────────────────────────────────────
INSERT INTO accounting_scheme_lines
  (scheme_id, account_code, description, def_debit, def_credit, posts_analytics, origin, item_codebook, line_no)
SELECT v.scheme_id::int, v.account_code::varchar, v.description::varchar,
       v.def_debit::varchar, v.def_credit::varchar, v.posts_analytics::boolean,
       v.origin::varchar, v.item_codebook::varchar, v.line_no::int
FROM (VALUES
  (36, '2040', '0',  'O+P', NULL, true, 'X', '0', 0),
  (36, '6141', NULL, NULL,  'O',  true, 'X', '0', 1),
  (36, '4701', NULL, NULL,  'P',  true, 'X', '0', 2),
  (36, '9600', NULL, NULL,  'A',  true, 'X', '0', 3),
  (36, '9800', NULL, 'A',   NULL, true, 'X', '0', 4)
) AS v(scheme_id, account_code, description, def_debit, def_credit, posts_analytics, origin, item_codebook, line_no)
WHERE NOT EXISTS (SELECT 1 FROM accounting_scheme_lines l WHERE l.scheme_id = 36);

-- ── 4) Pomeri id-sekvencu iznad ubačenih fiksnih legacy id-eva ──────────────
SELECT setval(pg_get_serial_sequence('accounting_schemes', 'id'),
              (SELECT MAX(id) FROM accounting_schemes));
