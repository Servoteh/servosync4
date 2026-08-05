-- ─────────────────────────────────────────────────────────────────────────────
-- KNJIGE I ROBA — POJEDINAČNA PRAVA ZA IMENOVANE LJUDE
-- Odluka Nenad, 05.08.2026. Primenjuje se PRE deploy-a koda koji skida knjige sa role.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- POVOD (izmereno nad produkcijom 05.08.2026): pun finansijski paket je stajao na
-- roli `menadzment`, koju nosi 19 AKTIVNIH ljudi — pa je glavnu knjigu, saldakonta,
-- izvode, plaćanja, kamatu, blagajnu, PDV evidencije i završni račun videlo
-- 24 čoveka (19 + 5 admina), bez veze sa tim da li im je to deo posla.
--
-- Zahtev vlasnika: knjige vide SAMO administratori i imenovani ljudi —
-- Jelena Stanišić i Duško Kostić. Radisav Radević dobija robu i artikle, BEZ knjiga.
--
-- ⚠️ REDOSLED JE OBAVEZAN:
--    1) OVAJ SKRIPT (dodaje prava imenovanima),
--    2) pa deploy koda koji skida knjige sa role `menadzment`.
--    Obrnuto bi Jelena i Duško između dva koraka ostali bez pristupa.
--
-- ZAŠTO POJEDINAČNO PRAVO, A NE NOVA ROLA: sistem priznaje jednu rolu po čoveku, pa
-- bi rola „finansije" morala da bude NADSKUP menadžmenta da im ne oduzme sastanke,
-- kadrovsku i plan proizvodnje. Probano je i ODBAČENO 05.08.2026: postojeće brane
-- parieta (`role-permissions.energetika.spec.ts` i još 7 fajlova, 34 testa) odmah su
-- pokazale da bi takav nadskup uz knjige tiho dao i upravljanje SCADA-om, forsiranje
-- plana proizvodnje i izmenu montaže — dakle više nego što je traženo.
--
-- Pojedinačno pravo je uže i preživljava sinhronizaciju rola: vezano je za ČOVEKA
-- (`user_id`), ne za rolu, pa ga prijava preko starog sistema ne dira.
-- Redosled odlučivanja (`common/authz/effective-permission.ts`): zabrana > rola > dozvola.
--
-- IDEMPOTENTNO: `ON CONFLICT (user_id, key) DO UPDATE`. Ponovno pokretanje ne duplira.

-- ── 1) KNJIGE — Jelena Stanišić (65) i Duško Kostić (42) ─────────────────────
INSERT INTO user_permission_overrides (user_id, key, allow)
SELECT u.id, k.key, TRUE
FROM users u
CROSS JOIN (VALUES
  ('gl.read'), ('gl.write'),
  ('saldakonti.read'), ('saldakonti.reconcile'),
  ('placanja.read'), ('placanja.prepare'), ('placanja.export'),
  ('izvodi.read'), ('izvodi.import'), ('izvodi.post'),
  ('kamata.read'), ('kamata.write'),
  ('blagajna.read'), ('blagajna.write'),
  ('pdv.read'), ('pdv.compute'),
  ('zr.read'), ('zr.compute')
) AS k(key)
WHERE u.email IN ('jelena.stanisic@servoteh.com', 'dusko.kostic@servoteh.com')
ON CONFLICT (user_id, key) DO UPDATE SET allow = TRUE;

-- ── 2) ROBA — Radisav Radević (51) ───────────────────────────────────────────
-- Artikle i lager listu već vidi (rola `magacioner` nosi `directory.read`).
-- Ovde dobija robno kretanje: prijemnice, izdatnice, kalkulacije, popis.
-- ⚠️ NAMERNO BEZ `robno.write`/`robno.post` i BEZ ijednog prava nad knjigama —
--    vlasnik: „njemu ne treba Glavna knjiga već samo sve o robi i artiklima".
INSERT INTO user_permission_overrides (user_id, key, allow)
SELECT u.id, 'robno.read', TRUE
FROM users u
WHERE u.email = 'radisav.radevic@servoteh.com'
ON CONFLICT (user_id, key) DO UPDATE SET allow = TRUE;

-- ── PROVERA (pokrenuti posle upisa) ──────────────────────────────────────────
-- SELECT u.email, o.key, o.allow
-- FROM user_permission_overrides o JOIN users u ON u.id = o.user_id
-- WHERE u.email IN ('jelena.stanisic@servoteh.com','dusko.kostic@servoteh.com',
--                   'radisav.radevic@servoteh.com')
-- ORDER BY u.email, o.key;
