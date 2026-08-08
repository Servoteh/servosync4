-- VISAR se vraća na šemu 46 (odluka Nenad, 08.08.2026) — pošto je popravljen uzrok.
--
-- Gašen je 08.08. jer bi prvi popis sa viškom bio ODBIJEN: motor je računao pretporez na
-- dokumentu kod kog PDV ne postoji, a šema 46 (1320 / 6740) nema PDV red.
--
-- Uzrok je sada popravljen i ŽIV na produkciji: `pdv-po-vrsti-dokumenta.ts` — PDV se ne
-- računa za vrste kod kojih ne postoji; stavka sa stopom ostavlja trag u logu umesto da
-- obori knjiženje. Manjak, otpis i donacija NAMERNO ostaju poreski (zakon), pa nisu dirani.
--
-- Dokaz pred vraćanje (probno knjiženje na serveru, 08.08., EXIT 0):
--   VISAR → 1320 duguje 6.000,00 / 6740 potražuje 6.000,00 — poklapa se sa jedinim stvarnim
--   BigBit nalogom viška iz 2026, bez ijednog PDV reda.
-- Provereno i da šema 46 nosi `order_type='VISAK'`, koji POSTOJI u registru od 117 vrsta.
BEGIN;

UPDATE document_types
   SET posting_template = 46
 WHERE code = 'VISAR'
   AND COALESCE(posting_template, 0) = 0;

SELECT d.code, COALESCE(d.posting_template,0) AS sema, s.order_type,
       CASE WHEN d.code='MANJR' THEN 'namerno ugašen' ELSE 'upaljen' END AS napomena
  FROM document_types d
  LEFT JOIN accounting_schemes s ON s.id = NULLIF(d.posting_template,0)
 WHERE d.code IN ('IFR','IFGP','IZVRO','IZVGP','VISAR','MANJR')
 ORDER BY d.code;

COMMIT;
