-- R_Artikli -> items. UPDATE-ONLY (plan 7.6 option A): while the MSSQL sync is live,
-- items.id belongs to the QBigTehn id space, so BigBit rows are matched SOLELY via
-- items.external_item_id = R_Artikli.[Sifra artikla] (the BigBit item code). No INSERTs:
-- BigBit rows without a linked items row are counted as "missing" (park list).
-- Never touched: items.id, items.external_item_id, items.created_at.
-- Stage column order MUST match R_Artikli storage order (67 cols; \copy is positional).
-- Item has no @relation FK columns in schema.prisma -> no FK NULL-ing needed here.
BEGIN;
CREATE TEMP TABLE bb_stage (
  sifra_artikla int, kataloski_broj varchar(20), barkod varchar(20), plu int, extsifra varchar(20),
  naziv varchar(50), jedinica_mere varchar(5), pakovanje varchar(10), inojm varchar(5),
  kutija double precision, transportno_pakovanje double precision, poreklo varchar(5),
  grupa varchar(10), podgrupa varchar(10), tarifa_robe varchar(5), tarifa_usluga varchar(5),
  uvek_porez_na_robu boolean, uvek_porez_na_usluge boolean, vp_cena double precision,
  mp_cena double precision, nabdevcena double precision, proddevcena double precision,
  minimalna_kolicina double precision, arttaksa double precision, odlozeno smallint,
  neoporezivi_deo double precision, maxrabatproc double precision, memo text,
  kngsifra varchar(10), artakciza double precision, kngsifra_2 varchar(10),
  zavtrosproiz double precision, carstopa double precision, idraster int, cartarifa varchar(20),
  zemljaporekla varchar(20), polica varchar(20), inonaziv varchar(50), sifdob int,
  webopis varchar(255), opisartikla varchar(50), tezina double precision, pdflink varchar(255),
  zabrisanje boolean, aktivan boolean, cenazaupisucen double precision, idmestoizdavanja int,
  proizvodjac varchar(50), hps varchar(50), potpisart varchar(50), datumivremeart timestamp,
  kolupak double precision, klrucproc numeric(19,4), osnjm varchar(5), slikasimbolalink varchar(250),
  mpkaloproc double precision, wordlokacija varchar(250), vpkaloproc double precision,
  nevodizalihe boolean, tezinakg double precision, zapremina double precision,
  povrsina double precision, rsort int, akcijskirabat double precision, napomena2 varchar(255),
  idkvalitetartikla int, debljina double precision
) ON COMMIT DROP;
\copy bb_stage FROM '/tmp/bb/items.csv' WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')
WITH src AS (
  SELECT sifra_artikla,
         COALESCE(kataloski_broj, '-') AS catalog_number,
         barkod AS bar_code, plu, extsifra AS external_code, naziv,
         jedinica_mere AS unit, pakovanje AS packaging, inojm AS foreign_unit, kutija AS box,
         transportno_pakovanje AS transport_packaging,
         COALESCE(poreklo, '0') AS origin_code, grupa,
         COALESCE(podgrupa, '0') AS subgroup_code,
         COALESCE(tarifa_robe, '3') AS goods_tax_rate_code,
         COALESCE(tarifa_usluga, '1') AS service_tax_rate_code,
         uvek_porez_na_robu AS always_tax_goods, uvek_porez_na_usluge AS always_tax_services,
         vp_cena AS wholesale_price, mp_cena AS retail_price,
         nabdevcena AS fx_purchase_price, proddevcena AS fx_sale_price,
         minimalna_kolicina AS min_quantity, arttaksa AS item_fee, odlozeno AS payment_term_days,
         neoporezivi_deo AS non_taxable_part, maxrabatproc AS max_discount_percent, memo,
         kngsifra AS accounting_code, artakciza AS item_excise, kngsifra_2 AS accounting_code_2,
         zavtrosproiz AS final_processing_cost, carstopa AS customs_rate, idraster AS raster_id,
         cartarifa AS customs_tariff, zemljaporekla AS origin_country,
         left(polica, 10) AS shelf, -- BigBit Polica is Text(20), items.shelf is varchar(10)
         inonaziv AS foreign_name, sifdob AS supplier_id, webopis AS web_description,
         opisartikla AS item_description, tezina AS weight, pdflink AS pdf_link,
         zabrisanje AS to_delete, aktivan AS active, cenazaupisucen AS price_to_write_pricelist,
         idmestoizdavanja AS issue_place_id, proizvodjac AS manufacturer, hps,
         potpisart AS signature, kolupak AS quantity_in_package,
         klrucproc AS manual_markup_percent, osnjm AS base_unit,
         slikasimbolalink AS symbol_image_link, mpkaloproc AS retail_loss_percent,
         wordlokacija AS word_location, vpkaloproc AS wholesale_loss_percent,
         nevodizalihe AS not_stock_tracked, tezinakg AS weight_kg, zapremina AS volume,
         povrsina AS area, rsort AS sort_order, akcijskirabat AS promotion_discount,
         napomena2 AS note_2, idkvalitetartikla AS quality_type_id, debljina AS thickness
  FROM bb_stage
  WHERE sifra_artikla IS NOT NULL
),
upd AS (
  UPDATE items i SET
    catalog_number = s.catalog_number, bar_code = s.bar_code, plu = s.plu,
    external_code = s.external_code, name = COALESCE(s.naziv, i.name), unit = s.unit,
    packaging = s.packaging, foreign_unit = s.foreign_unit, box = s.box,
    transport_packaging = s.transport_packaging, origin_code = s.origin_code,
    group_code = COALESCE(s.grupa, i.group_code), subgroup_code = s.subgroup_code,
    goods_tax_rate_code = s.goods_tax_rate_code, service_tax_rate_code = s.service_tax_rate_code,
    always_tax_goods = s.always_tax_goods, always_tax_services = s.always_tax_services,
    wholesale_price = s.wholesale_price, retail_price = s.retail_price,
    fx_purchase_price = s.fx_purchase_price, fx_sale_price = s.fx_sale_price,
    min_quantity = s.min_quantity, item_fee = s.item_fee, payment_term_days = s.payment_term_days,
    non_taxable_part = s.non_taxable_part, max_discount_percent = s.max_discount_percent,
    memo = s.memo, accounting_code = s.accounting_code, item_excise = s.item_excise,
    accounting_code_2 = s.accounting_code_2, final_processing_cost = s.final_processing_cost,
    customs_rate = s.customs_rate, raster_id = s.raster_id, customs_tariff = s.customs_tariff,
    origin_country = s.origin_country, shelf = s.shelf, foreign_name = s.foreign_name,
    supplier_id = s.supplier_id, web_description = s.web_description,
    item_description = s.item_description, weight = s.weight, pdf_link = s.pdf_link,
    to_delete = s.to_delete, active = s.active,
    price_to_write_pricelist = s.price_to_write_pricelist, issue_place_id = s.issue_place_id,
    manufacturer = s.manufacturer, hps = s.hps, signature = s.signature,
    quantity_in_package = s.quantity_in_package, manual_markup_percent = s.manual_markup_percent,
    base_unit = s.base_unit, symbol_image_link = s.symbol_image_link,
    retail_loss_percent = s.retail_loss_percent, word_location = s.word_location,
    wholesale_loss_percent = s.wholesale_loss_percent, not_stock_tracked = s.not_stock_tracked,
    weight_kg = s.weight_kg, volume = s.volume, area = s.area, sort_order = s.sort_order,
    promotion_discount = s.promotion_discount, note_2 = s.note_2,
    quality_type_id = s.quality_type_id, thickness = s.thickness
  FROM src s
  WHERE i.external_item_id = s.sifra_artikla
    AND i.external_item_id <> 0
    AND (i.catalog_number, i.bar_code, i.plu, i.external_code, i.name, i.unit, i.packaging,
         i.foreign_unit, i.box, i.transport_packaging, i.origin_code, i.group_code,
         i.subgroup_code, i.goods_tax_rate_code, i.service_tax_rate_code, i.always_tax_goods,
         i.always_tax_services, i.wholesale_price, i.retail_price, i.fx_purchase_price,
         i.fx_sale_price, i.min_quantity, i.item_fee, i.payment_term_days, i.non_taxable_part,
         i.max_discount_percent, i.memo, i.accounting_code, i.item_excise, i.accounting_code_2,
         i.final_processing_cost, i.customs_rate, i.raster_id, i.customs_tariff, i.origin_country,
         i.shelf, i.foreign_name, i.supplier_id, i.web_description, i.item_description, i.weight,
         i.pdf_link, i.to_delete, i.active, i.price_to_write_pricelist, i.issue_place_id,
         i.manufacturer, i.hps, i.signature, i.quantity_in_package, i.manual_markup_percent,
         i.base_unit, i.symbol_image_link, i.retail_loss_percent, i.word_location,
         i.wholesale_loss_percent, i.not_stock_tracked, i.weight_kg, i.volume, i.area,
         i.sort_order, i.promotion_discount, i.note_2, i.quality_type_id, i.thickness)
      IS DISTINCT FROM
        (s.catalog_number, s.bar_code, s.plu, s.external_code, COALESCE(s.naziv, i.name), s.unit,
         s.packaging, s.foreign_unit, s.box, s.transport_packaging, s.origin_code,
         COALESCE(s.grupa, i.group_code), s.subgroup_code, s.goods_tax_rate_code,
         s.service_tax_rate_code, s.always_tax_goods, s.always_tax_services, s.wholesale_price,
         s.retail_price, s.fx_purchase_price, s.fx_sale_price, s.min_quantity, s.item_fee,
         s.payment_term_days, s.non_taxable_part, s.max_discount_percent, s.memo,
         s.accounting_code, s.item_excise, s.accounting_code_2, s.final_processing_cost,
         s.customs_rate, s.raster_id, s.customs_tariff, s.origin_country, s.shelf, s.foreign_name,
         s.supplier_id, s.web_description, s.item_description, s.weight, s.pdf_link, s.to_delete,
         s.active, s.price_to_write_pricelist, s.issue_place_id, s.manufacturer, s.hps,
         s.signature, s.quantity_in_package, s.manual_markup_percent, s.base_unit,
         s.symbol_image_link, s.retail_loss_percent, s.word_location, s.wholesale_loss_percent,
         s.not_stock_tracked, s.weight_kg, s.volume, s.area, s.sort_order, s.promotion_discount,
         s.note_2, s.quality_type_id, s.thickness)
  RETURNING 1
)
SELECT (SELECT count(*) FROM bb_stage WHERE sifra_artikla IS NOT NULL) || '|' ||
       0 || '|' ||
       (SELECT count(*) FROM upd) || '|' ||
       (SELECT count(*) FROM bb_stage b WHERE b.sifra_artikla IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM items t
                          WHERE t.external_item_id = b.sifra_artikla
                            AND t.external_item_id <> 0));
COMMIT;
