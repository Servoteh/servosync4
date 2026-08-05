-- ─────────────────────────────────────────────────────────────────────────────
-- KNJIGOVODSTVENA PRAVILA — POJEDINAČNO PRAVO ZA IMENOVANE LJUDE
-- Odluka Nenad, 05.08.2026. Primenjuje se PRE deploy-a koda koji uvodi ekrane.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- ⚠️ OVAJ SKRIPT SE NE PRIMENJUJE AUTOMATSKI. Pokreće ga čovek, nad produkcijom,
--    svesno — kao i `erp-knjige-imenovani.sql` od istog dana.
--
-- ŠTA OTVARA: dva ekrana u Podešavanjima, oba iza prava `settings.accounting_rules`:
--   • „Brojači dokumenata" — startni broj po seriji i godini (odluka O-F11). Ko ga
--     podesi, određuje broj koji će nositi SLEDEĆA faktura — dakle broj po kom kupac
--     plaća, po kom se stavka vodi u saldakontima i po kom uplata zatvara obavezu.
--   • „Vrste usluge" — šifarnik `service_revenue_types` (nalaz P10). Jedan red nosi
--     konto prihoda I poreski tretman; izmena određuje da li se na promet obračunava PDV.
--
-- ZAHTEV VLASNIKA (05.08.2026): „Knjigovođa može ili admin sa svojom šifrom da dobije
-- pristup tom ekranu." Dakle: administratori (kroz rolu `admin`, koja ima sva prava) +
-- IMENOVANI knjigovođe — Jelena Stanišić i Duško Kostić, isti krug koji je istog dana
-- dobio knjige.
--
-- ZAŠTO POJEDINAČNO PRAVO, A NE NOVA ROLA: sistem priznaje jednu rolu po čoveku, pa bi
-- rola „finansije" morala da bude NADSKUP menadžmenta da im ne oduzme sastanke,
-- kadrovsku i plan proizvodnje. Probano je i ODBAČENO 05.08.2026: osam paritet-brana
-- (34 testa) odmah je pokazalo da bi takav nadskup tiho dao i upravljanje SCADA-om,
-- forsiranje plana proizvodnje i izmenu montaže — dakle više nego što je traženo.
-- Rola `finansije` zato ostaje u katalogu BEZ ijednog prava.
--
-- Pojedinačno pravo je uže i preživljava sinhronizaciju rola: vezano je za ČOVEKA
-- (`user_id`), ne za rolu, pa ga prijava preko starog sistema ne dira.
-- Redosled odlučivanja (`common/authz/effective-permission.ts`): zabrana > rola > dozvola.
--
-- ⚠️ REDOSLED JE OBAVEZAN:
--    1) OVAJ SKRIPT (dodaje pravo imenovanima),
--    2) pa deploy koda sa ekranima.
--    Obrnuto nije opasno (ekran bi im samo bio nevidljiv do upisa), ali ovako
--    knjigovođa zatekne ekran spreman prvog dana.
--
-- IDEMPOTENTNO: `ON CONFLICT (user_id, key) DO UPDATE`. Ponovno pokretanje ne duplira.
--
-- ⚠️ IMENA SE VEZUJU PO E-POŠTI, NE PO `id`-u. Isti obrazac kao `erp-knjige-imenovani.sql`:
--    `users.id` se razlikuje između baza i klonova, a e-pošta je stabilna. Ako čovek ne
--    postoji, `INSERT … SELECT` prosto ne pogodi nijedan red — nema greške ni tihog
--    dodeljivanja prava pogrešnoj osobi.

-- ── KNJIGOVODSTVENA PRAVILA — Jelena Stanišić i Duško Kostić ─────────────────
INSERT INTO user_permission_overrides (user_id, key, allow)
SELECT u.id, 'settings.accounting_rules', TRUE
FROM users u
WHERE u.email IN ('jelena.stanisic@servoteh.com', 'dusko.kostic@servoteh.com')
ON CONFLICT (user_id, key) DO UPDATE SET allow = TRUE;

-- ── PROVERA (pokrenuti posle upisa) ──────────────────────────────────────────
-- Očekivano: dva reda, oba `allow = t`.
--
-- SELECT u.email, o.key, o.allow
-- FROM user_permission_overrides o JOIN users u ON u.id = o.user_id
-- WHERE o.key = 'settings.accounting_rules'
-- ORDER BY u.email;
