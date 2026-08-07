-- ─────────────────────────────────────────────────────────────────────────────
-- UKLJUČENJE AUTOMATSKOG KNJIŽENJA ROBNIH DOKUMENATA (odluka Nenad, 07.08.2026)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- ŠTA OVO RADI: postavlja `document_types.posting_template` — vezu vrste dokumenta
-- na BigBit šemu kontiranja. Dok je 0, motor odbija knjiženje sa `GL_NO_SCHEME`.
--
-- ZAŠTO JE BEZBEDNO RETROAKTIVNO (izmereno na produkciji neposredno pre primene):
--   stock_documents = 0 · invoices = 0
-- Dakle NEMA nijednog dokumenta koji bi se ovim proknjižio. Prekidač važi samo za
-- ono što nastane ubuduće. Povratak je isti upis sa 0 i ništa se ne gubi.
--
-- NA ČEMU POČIVA POVERENJE: probno knjiženje na zasebnoj bazi `servosync_probno`
-- (skript `backend/scripts/proof-knjizenje-po-semama.ts`, ponovljivo) provuklo je svih
-- 6 vrsta kroz STVARNI motor, pa je nalog čitan IZ BAZE:
--   • IFR   — poklapa se sa BigBitom, etalon 167 dokumenata u 2026 (konto po konto)
--   • IFGP  — poklapa se sa BigBitom, etalon 26 dokumenata
--   • VISAR — poklapa se sa jedinim viškom iz 2026 (nalog 260119, 19.01.2026)
--   • IZVRO / IZVGP — poklapaju se sa šemom (u 2026 nema etalona, izvoza nije bilo)
-- Uz to su probom nađena i popravljena tri kvara u motoru (broj dokumenta i dospeće
-- na redovima, prazan dokument koji se tiho zaključavao, zaokruživanje pre upisa).
--
-- ⚠️ MANJR (šema 50) NAMERNO OSTAJE ISKLJUČEN — v. odeljak 2 na dnu.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) ŠEMA 46 SE PREVEZUJE SA `VISAR` NA `VISAK`
-- ─────────────────────────────────────────────────────────────────────────────
-- Izmereno: `order_types` ima 117 vrsta i `VISAR` NIJE među njima; postoji `VISAK`.
-- Nalog sa nepostojećom šifrom ne bi pukao — tiho bi ostao u dnevniku pod vrstom
-- koje nema u šifarniku.
--
-- Knjigovođa, 07.08.2026, doslovno: „u programu imamo vrste dokumenta visar i visam
-- ali su oba pod nalogom VISAK. S obzirom da se pri pravljenju robnog dokumenta
-- opredeljujemo koja će vrsta dokumenta biti a kasnije i koji magacin, na osnovu tih
-- parametara se formira šema za knjiženje 1320 ili 1010."
--
-- Dakle VRSTA DOKUMENTA ostaje VISAR/VISAM (bira je magacioner), a VRSTA NALOGA je
-- za oba VISAK. Konto sledi iz izabranog magacina, što motor već radi.
UPDATE accounting_schemes
   SET order_type = 'VISAK'
 WHERE id = 46
   AND order_type = 'VISAR';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) PREKIDAČ — PET VRSTA SE PALI, MANJAK NE
-- ─────────────────────────────────────────────────────────────────────────────
UPDATE document_types SET posting_template = 33 WHERE code = 'IFR'   AND COALESCE(posting_template,0) = 0;
UPDATE document_types SET posting_template = 36 WHERE code = 'IFGP'  AND COALESCE(posting_template,0) = 0;
UPDATE document_types SET posting_template = 24 WHERE code = 'IZVRO' AND COALESCE(posting_template,0) = 0;
UPDATE document_types SET posting_template = 47 WHERE code = 'IZVGP' AND COALESCE(posting_template,0) = 0;
UPDATE document_types SET posting_template = 46 WHERE code = 'VISAR' AND COALESCE(posting_template,0) = 0;

-- 🔴 MANJR (šema 50) NAMERNO NIJE UKLJUČEN. Tri razloga, svaki dovoljan sam za sebe:
--
--   a) Popis od 07.08.2026 VIŠE I NE PRAVI taj dokument — zaključenje sa manjkom se
--      odbija, a roba se razdužuje TREBOVANJEM na radni nalog (vlasnik: „mi
--      istrebujemo na neki nalog tu robu i zato ne radimo [manjak]"). Uključivanje bi
--      palilo put kojim se više ne ide.
--   b) Šema 50 knjiži izlazni PDV na konto `4700`, koji u CELOJ uvezenoj knjizi 2026
--      ima NULA stavki — stvarni izlazni PDV ide na 4702 (170) i 4701 (33). Pitanje je
--      postavljeno knjigovođi i ostalo je bez odgovora (postalo je bespredmetno kad je
--      rekao da dokument ne koristi).
--   c) Ista šema računa PDV iz VELEPRODAJNE cene sa popisnog dokumenta, a ne iz
--      nabavne vrednosti — probom: 2.000 umesto 1.200. Ni to nije razrešeno.
--
-- Kad/ako manjak ikad zatreba, pali se istim upisom (`posting_template = 50`), ali TEK
-- pošto knjigovođa odgovori na (b) i (c).

-- ─────────────────────────────────────────────────────────────────────────────
-- PROVERA — mora vratiti tačno 5 upaljenih, MANJR na nuli, i šemu 46 na VISAK
-- ─────────────────────────────────────────────────────────────────────────────
SELECT d.code,
       COALESCE(d.posting_template, 0) AS sema,
       s.order_type                    AS vrsta_naloga,
       CASE WHEN o.code IS NULL THEN '🔴 VRSTE NALOGA NEMA U REGISTRU' ELSE 'ok' END AS registar
  FROM document_types d
  LEFT JOIN accounting_schemes s ON s.id = NULLIF(d.posting_template, 0)
  LEFT JOIN order_types       o ON o.code = s.order_type
 WHERE d.code IN ('IFR','IFGP','IZVRO','IZVGP','VISAR','MANJR')
 ORDER BY d.code;

COMMIT;
