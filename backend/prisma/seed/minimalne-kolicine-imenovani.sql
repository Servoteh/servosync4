-- ─────────────────────────────────────────────────────────────────────────────
-- MINIMALNE KOLIČINE ARTIKALA — POJEDINAČNO PRAVO ZA TRI IMENOVANA MAGACIONERA
-- Odluka vlasnika, 06.08.2026. Primenjuje se PRE (ili odmah posle) deploy-a koda
-- koji uvodi pravo `masters.min_quantity` — redosled ovde nije kritičan, jer se
-- nijedno postojeće pravo ne oduzima (v. napomenu o redosledu na dnu).
-- ─────────────────────────────────────────────────────────────────────────────
--
-- ZAHTEV (doslovno): „ISPOD MINIMALNE KOLIČINE UNOSE MAGACIONERI, za sada korisnici
-- sa mejlom dusko.kostic, radisav.radevic, nikola.savic."
--
-- ŠTA OVO OTVARA: isključivo kolonu `items.min_quantity`, kroz
-- `PATCH /api/v1/artikli/:id/minimalna-kolicina` i polje „Min. kol." na lager listi
-- (`/artikli/lager`). NIŠTA drugo sa kartice artikla — pun unos artikala ostaje
-- zatvoren branom `assertItemWritesAllowed()` (409), jer čeka razrešenje 4.298
-- duplih kataloških brojeva.
--
-- ⚠️ PREDUSLOV KOJI JE VEĆ ISPUNJEN U KODU: kolona `Minimalna kolicina` je izbačena
-- iz sync mape (`src/modules/sync/sync-map.generated.ts`), pa je noćni .mdb uvoz u
-- 03:45 više NE prepisuje. Bez tog koraka bi ovaj GRANT bio obećanje koje sistem
-- gazi svake noći: izmereno 06.08.2026 nad poslednjim drop-om (id 7), uvoz je
-- držao kolonu u koraku sa BigBitom — 0 razlika na 92.623 uparena reda.
--
-- ZAŠTO POJEDINAČNO PRAVO, A NE ROLA (mereno na produkciji 06.08.2026):
--   rola `magacioner` = 8 aktivnih ljudi, rola `menadzment` = 19.
--   Trojica imenovanih sede u obe (42 menadzment, 51 i 52 magacioner), pa bi
--   najuža rolna dodela koja ih sve pokriva otvorila kolonu 27 ljudima umesto 3.
--   Pojedinačno pravo je uže i PREŽIVLJAVA sinhronizaciju rola: vezano je za ČOVEKA
--   (`user_id`), ne za rolu, pa ga prijava preko starog sistema ne dira.
--   Redosled odlučivanja (`common/authz/effective-permission.ts`): zabrana > rola > dozvola.
--
-- KLJUČ JE E-MAIL, NE `id`: id-jevi u ovom komentaru (42/51/52, izmereni 06.08.2026)
-- su samo za proveru — `WHERE u.email IN (...)` je ono što bira redove, pa skript
-- radi ispravno i ako se id-jevi ikad promene, a ne pogađa pogrešnog čoveka ako se
-- ne poklope.
--
-- IDEMPOTENTNO: `ON CONFLICT (user_id, key) DO UPDATE`. Ponovno pokretanje ne duplira
-- i ne menja ništa osim `allow = TRUE`.

-- ── MINIMALNA KOLIČINA — Duško Kostić (42), Radisav Radević (51), Nikola Savić (52) ──
INSERT INTO user_permission_overrides (user_id, key, allow)
SELECT u.id, 'masters.min_quantity', TRUE
FROM users u
WHERE u.email IN (
  'dusko.kostic@servoteh.com',
  'radisav.radevic@servoteh.com',
  'nikola.savic@servoteh.com'
)
ON CONFLICT (user_id, key) DO UPDATE SET allow = TRUE;

-- ── PROVERA (pokrenuti posle upisa — mora vratiti TAČNO 3 reda) ──────────────
-- SELECT u.id, u.email, u.role, o.key, o.allow
-- FROM user_permission_overrides o
-- JOIN users u ON u.id = o.user_id
-- WHERE o.key = 'masters.min_quantity'
-- ORDER BY u.id;
--
-- Očekivano (izmereno 06.08.2026):
--   42 | dusko.kostic@servoteh.com    | menadzment | masters.min_quantity | t
--   51 | radisav.radevic@servoteh.com | magacioner | masters.min_quantity | t
--   52 | nikola.savic@servoteh.com    | magacioner | masters.min_quantity | t

-- ── NAPOMENA O REDOSLEDU ─────────────────────────────────────────────────────
-- Za razliku od `erp-knjige-imenovani.sql` (gde je skript MORAO da ide PRE deploy-a,
-- jer je deploy oduzimao prava roli `menadzment`), ovde se nikome ništa ne oduzima:
-- pravo je NOVO i do ovog upisa ga nema niko osim admina. Pušten pre deploy-a stoji
-- neaktivan (nijedna ruta ga ne traži), pušten posle deploy-a odmah radi — bez
-- prozora u kome je neko ostao bez pristupa.
