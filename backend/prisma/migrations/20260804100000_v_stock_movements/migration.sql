-- ============================================================================
-- v_stock_movements — JEDAN IZVOR ISTINE O KRETANJU ZALIHA
-- ============================================================================
--
-- ZAŠTO POSTOJI
-- Predikat „šta se uopšte računa kao kretanje zalihe" (KODJ izuzet + affects_stock
-- + meko obrisana stavka izuzeta) i pravilo znaka (`is_inbound` → ±) bili su
-- PREPISANI u 10 raw-SQL upita u 5 fajlova:
--
--   costing.service.ts        stateAsOf, averageAsOf, lastPrice
--   robno.service.ts          listLager (agregat + count), getItemCard
--   reservation.service.ts    computeOnHand (raspoloživo)
--   inventory.service.ts      candidateItemIds (predpunjenje popisa)
--   transfer.service.ts       averageCosts (vrednovanje prenosa)
--
-- Doslednost među njima držali su SAMO komentari („filter VERBATIM iz
-- CostingService.stateAsOf") i jedan smoke test. Svaki novi izuzetak (nova vrsta
-- dokumenta, storno flag, filter po statusu) morao je da se doda na svih 10 mesta.
-- Propušteno mesto NE PUCA — nema greške ni loga; lager, kartica artikla i guard
-- dovoljnog stanja jednostavno počnu da tvrde tri različita broja o istoj robi,
-- i to otkrije magacioner na popisu.
--
-- OD SADA: svi ti upiti čitaju OVAJ pogled. Novo pravilo se dodaje OVDE, jednom,
-- i baza ga nameće svim potrošačima — uključujući i one van NestJS-a (psql
-- izveštaji, bridge, buduće BI čitanje).
--
-- PERFORMANSE
-- Ovo je obična (ne materijalizovana) projekcija — planer je inline-uje u upit
-- pozivaoca, pa postojeći indeksi rade nepromenjeno:
--   idx_stock_document_items_item_wh  (item_id, warehouse_id)  — as-of ključ
--   idx_stock_documents_date_wh       (document_date, warehouse_id, document_type_code)
--   uq_document_types_code            (code)
--
-- SEMANTIKA KOLONA
--   signed_quantity   ±Kol — jedini dozvoljen način da se sabira stanje.
--                     Stanje na dan = SUM(signed_quantity) WHERE document_date <= :dan
--   unit_purchase_net A+B+C (nabavna neto + zavisni troškovi sopstveni + dobavljača),
--                     doc 39 §C. Ponder: SUM(signed_quantity * unit_purchase_net)
--   unit_wholesale    KalkVP  — ponderisana prosečna VP
--   unit_retail       KalkMP sa fallback-om na stvarnu MP (KEPU se vodi po MP vrednosti,
--                     v. kepu-book.util.unitMpValue)
--   document_status   NAMERNO izložen, ali costing ga NE filtrira: prosek i stanje broje
--                     sva kretanja bez obzira na DRAFT/CALCULATED/POSTED (doc 39 §C).
--                     Ako neki izveštaj ipak traži samo proknjižena — filtrira ga sam.
-- ============================================================================

CREATE OR REPLACE VIEW v_stock_movements AS
SELECT
  sdi.id                    AS item_line_id,
  sdi.document_id           AS document_id,
  sd.document_number        AS document_number,
  sd.kind                   AS kind,
  sd.document_type_code     AS document_type_code,
  sd.document_date          AS document_date,
  sd.status                 AS document_status,
  sd.warehouse_id           AS header_warehouse_id,
  sdi.item_id               AS item_id,
  sdi.warehouse_id          AS warehouse_id,
  dt.is_inbound             AS is_inbound,
  sdi.quantity              AS quantity,
  CASE WHEN dt.is_inbound THEN sdi.quantity ELSE -sdi.quantity END
                            AS signed_quantity,
  (sdi.purchase_price_net + sdi.dependent_cost_own + sdi.dependent_cost_supplier)
                            AS unit_purchase_net,
  sdi.calculated_wholesale_price
                            AS unit_wholesale,
  COALESCE(NULLIF(sdi.calculated_retail_price, 0), sdi.actual_retail_price)
                            AS unit_retail
FROM stock_document_items sdi
JOIN stock_documents  sd ON sd.id   = sdi.document_id
JOIN document_types   dt ON dt.code = sd.document_type_code
WHERE sd.document_type_code <> 'KODJ'
  AND COALESCE(dt.affects_stock, TRUE) = TRUE
  AND sdi.deleted_at IS NULL;

-- NAPOMENA: u tekstu komentara NEMA tačke-zapete namerno. Naivni delioci SQL-a
-- (uključujući skriptu kojom je ova migracija proveravana) seku fajl na `;` i time bi
-- presekli string na pola. Prisma primenjuje ceo fajl odjednom pa njoj ne smeta, ali
-- nema razloga ostaviti minu za sledeći alat.
COMMENT ON VIEW v_stock_movements IS
  'Jedan izvor istine o kretanju zaliha (doc 39 §C). KODJ izuzet, affects_stock i '
  'soft-delete primenjeni, signed_quantity nosi znak iz document_types.is_inbound. '
  'Svaki upit o stanju/proseku/kartici MORA čitati odavde — ne prepisivati predikat.';
