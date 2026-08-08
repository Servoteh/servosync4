-- ─────────────────────────────────────────────────────────────────────────────
-- VISAR SE VRAĆA NA NULU (odluka Nenad, 08.08.2026) — privremeno
-- ─────────────────────────────────────────────────────────────────────────────
--
-- POVOD: probno knjiženje 08.08. je pokazalo da bi PRVI popis sa viškom bio ODBIJEN.
-- Poruka koju motor vraća:
--
--   „Robni dokument (vrsta VISAR) ima stavku oporezovanu opštom stopom (20 %), a šema za
--    kontiranje 46 (VISAR) NEMA red za tu stopu. Pretporez od 1200.00 ne bi legao ni na
--    jedan konto — tiho bi ispao iz glavne knjige i iz PDV prijave…"
--
-- ZAŠTO JE TO POGREŠNO PONAŠANJE, a ne ispravna brana:
--   • Šema 46 ima TAČNO DVA reda — `1320` (duguje A) i `6740` (potražuje A). Nijedan za PDV,
--     i to je VERNO BigBitu: višak sa popisa NIJE poreski događaj. Ništa nije kupljeno —
--     zatečena je roba koja je već bila u imovini.
--   • Motor mu ipak računa pretporez, jer artikal nosi tarifu 20 % (tarifa artikla je
--     svojstvo ROBE, ne ovog dokumenta).
--   • Poruka bi korisnika uputila da „ispravi poresku tarifu na stavkama" — pogrešan savet:
--     tarifa artikla nema veze sa tim što je magacioner zatekao komad viška.
--
-- Dakle koren nije ni u šemi ni u brani, nego u tome što motor RAČUNA PDV na vrsti
-- dokumenta kod koje PDV ne postoji. To se rešava u motoru, ne ovde.
--
-- ZAŠTO SE GASI, IAKO JE KVAR „BEZBEDAN": odbijanje je vidljivo i ništa se ne knjiži
-- pogrešno, ali ostavlja zamku prvom čoveku koji zaključi popis sa viškom — dobio bi grešku
-- i savet koji ga vodi na pogrešnu stranu. Jeftinije je ugasiti prekidač nego objašnjavati.
--
-- OBIM: gasi se ISKLJUČIVO `VISAR`. IFR, IFGP, IZVRO i IZVGP OSTAJU upaljeni — njih ovo ne
-- dodiruje (sve četiri su prošle probno knjiženje, IFR i IFGP protiv BigBit etalona).
--
-- BEZBEDNO: na produkciji su `stock_documents = 0` i `inventory_counts = 0` — nijedan popis
-- nije ni započet, pa se ništa ne poništava. Povratak je isti upis sa `46`.

BEGIN;

UPDATE document_types
   SET posting_template = 0
 WHERE code = 'VISAR'
   AND posting_template = 46;

-- PROVERA — VISAR mora biti 0, ostale četiri netaknute, MANJR i dalje 0.
SELECT code,
       COALESCE(posting_template, 0) AS sema,
       CASE
         WHEN code = 'VISAR' AND COALESCE(posting_template,0) = 0 THEN 'ugašen (ovom izmenom)'
         WHEN code = 'MANJR' AND COALESCE(posting_template,0) = 0 THEN 'ugašen (ranije, namerno)'
         WHEN COALESCE(posting_template,0) <> 0                   THEN 'upaljen'
         ELSE '⚠️ NEOČEKIVANO'
       END AS stanje
  FROM document_types
 WHERE code IN ('IFR','IFGP','IZVRO','IZVGP','VISAR','MANJR')
 ORDER BY code;

COMMIT;
