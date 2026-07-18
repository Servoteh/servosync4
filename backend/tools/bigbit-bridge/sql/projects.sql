-- Predmeti -> projects. UPSERT key = id (IDPredmet, BigBit AutoNumber PK).
-- Stage column order MUST match Predmeti storage order (\copy is positional), 38 columns.
-- FK hygiene (customer.syncer.ts pattern): IDKomitent -> customers.id, IDProdavac -> salespeople.id;
-- unresolvable refs fall back to sentinel 0 (both target columns are NOT NULL, so NULL is not an option;
-- salesperson_id has Prisma @default(0), customer_id gets the same "0 = none" convention).
-- projects has no DB-level FK constraints on these columns, so 0 cannot violate anything.
BEGIN;
CREATE TEMP TABLE bb_stage (
  idpredmet int, brojpredmeta varchar(20), opis varchar(50), datumotvaranja timestamp,
  idprodavac int, idkomitent int, nextaction varchar(50), datumzakljucenja timestamp,
  memo text, status varchar(20), nasaref varchar(20), naskontakt1 varchar(50),
  naskontakt2 varchar(50), nastel1 varchar(20), nastel2 varchar(20), vasaref varchar(20),
  vaskontakt1 varchar(50), vaskontakt2 varchar(50), vastel1 varchar(20), vastel2 varchar(20),
  nabavnavrednost numeric(19,4), carina numeric(19,4), spedicija numeric(19,4),
  prevoz numeric(19,4), ostalo numeric(19,4), inodobavljac int, rj varchar(4),
  devvaluta varchar(3), kurs numeric(19,4), idvrstaposla int, nazivpredmeta varchar(250),
  rokzavrsetka timestamp, potpis varchar(50), datumivreme timestamp, brojugovora varchar(100),
  datumugovora timestamp, brojnarudzbenice varchar(100), datumnarudzbenice timestamp
) ON COMMIT DROP;
\copy bb_stage FROM '/tmp/bb/projects.csv' WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')
WITH upserted AS (
  INSERT INTO projects (id, project_number, description, opened_at, salesperson_id, customer_id,
                        next_action, closed_at, memo, status, our_ref, our_contact_1, our_contact_2,
                        our_phone_1, our_phone_2, their_ref, their_contact_1, their_contact_2,
                        their_phone_1, their_phone_2, procurement_value, customs, forwarding,
                        transport, other, foreign_supplier_id, work_unit_code, currency,
                        exchange_rate, work_type_id, project_name, deadline, signature, created_at,
                        contract_number, contract_date, order_number, order_date)
  SELECT idpredmet, COALESCE(brojpredmeta, ''), opis, datumotvaranja,
         CASE WHEN idprodavac IS NULL OR idprodavac = 0 THEN 0
              WHEN EXISTS (SELECT 1 FROM salespeople r WHERE r.id = idprodavac) THEN idprodavac
              ELSE 0 END,
         CASE WHEN idkomitent IS NULL OR idkomitent = 0 THEN 0
              WHEN EXISTS (SELECT 1 FROM customers r WHERE r.id = idkomitent) THEN idkomitent
              ELSE 0 END,
         nextaction, datumzakljucenja, memo, status, nasaref, naskontakt1, naskontakt2,
         nastel1, nastel2, vasaref, vaskontakt1, vaskontakt2, vastel1, vastel2,
         nabavnavrednost, carina, spedicija, prevoz, ostalo, inodobavljac, rj, devvaluta,
         kurs, idvrstaposla, nazivpredmeta, rokzavrsetka, potpis, datumivreme, brojugovora,
         datumugovora, brojnarudzbenice, datumnarudzbenice
  FROM bb_stage WHERE idpredmet IS NOT NULL
  ON CONFLICT (id) DO UPDATE SET
    project_number = EXCLUDED.project_number, description = EXCLUDED.description,
    opened_at = EXCLUDED.opened_at, salesperson_id = EXCLUDED.salesperson_id,
    customer_id = EXCLUDED.customer_id, next_action = EXCLUDED.next_action,
    closed_at = EXCLUDED.closed_at, memo = EXCLUDED.memo, status = EXCLUDED.status,
    our_ref = EXCLUDED.our_ref, our_contact_1 = EXCLUDED.our_contact_1,
    our_contact_2 = EXCLUDED.our_contact_2, our_phone_1 = EXCLUDED.our_phone_1,
    our_phone_2 = EXCLUDED.our_phone_2, their_ref = EXCLUDED.their_ref,
    their_contact_1 = EXCLUDED.their_contact_1, their_contact_2 = EXCLUDED.their_contact_2,
    their_phone_1 = EXCLUDED.their_phone_1, their_phone_2 = EXCLUDED.their_phone_2,
    procurement_value = EXCLUDED.procurement_value, customs = EXCLUDED.customs,
    forwarding = EXCLUDED.forwarding, transport = EXCLUDED.transport, other = EXCLUDED.other,
    foreign_supplier_id = EXCLUDED.foreign_supplier_id, work_unit_code = EXCLUDED.work_unit_code,
    currency = EXCLUDED.currency, exchange_rate = EXCLUDED.exchange_rate,
    work_type_id = EXCLUDED.work_type_id, project_name = EXCLUDED.project_name,
    deadline = EXCLUDED.deadline, signature = EXCLUDED.signature, created_at = EXCLUDED.created_at,
    contract_number = EXCLUDED.contract_number, contract_date = EXCLUDED.contract_date,
    order_number = EXCLUDED.order_number, order_date = EXCLUDED.order_date
    WHERE (projects.project_number, projects.description, projects.opened_at,
           projects.salesperson_id, projects.customer_id, projects.next_action,
           projects.closed_at, projects.memo, projects.status, projects.our_ref,
           projects.our_contact_1, projects.our_contact_2, projects.our_phone_1,
           projects.our_phone_2, projects.their_ref, projects.their_contact_1,
           projects.their_contact_2, projects.their_phone_1, projects.their_phone_2,
           projects.procurement_value, projects.customs, projects.forwarding,
           projects.transport, projects.other, projects.foreign_supplier_id,
           projects.work_unit_code, projects.currency, projects.exchange_rate,
           projects.work_type_id, projects.project_name, projects.deadline,
           projects.signature, projects.created_at, projects.contract_number,
           projects.contract_date, projects.order_number, projects.order_date)
      IS DISTINCT FROM
          (EXCLUDED.project_number, EXCLUDED.description, EXCLUDED.opened_at,
           EXCLUDED.salesperson_id, EXCLUDED.customer_id, EXCLUDED.next_action,
           EXCLUDED.closed_at, EXCLUDED.memo, EXCLUDED.status, EXCLUDED.our_ref,
           EXCLUDED.our_contact_1, EXCLUDED.our_contact_2, EXCLUDED.our_phone_1,
           EXCLUDED.our_phone_2, EXCLUDED.their_ref, EXCLUDED.their_contact_1,
           EXCLUDED.their_contact_2, EXCLUDED.their_phone_1, EXCLUDED.their_phone_2,
           EXCLUDED.procurement_value, EXCLUDED.customs, EXCLUDED.forwarding,
           EXCLUDED.transport, EXCLUDED.other, EXCLUDED.foreign_supplier_id,
           EXCLUDED.work_unit_code, EXCLUDED.currency, EXCLUDED.exchange_rate,
           EXCLUDED.work_type_id, EXCLUDED.project_name, EXCLUDED.deadline,
           EXCLUDED.signature, EXCLUDED.created_at, EXCLUDED.contract_number,
           EXCLUDED.contract_date, EXCLUDED.order_number, EXCLUDED.order_date)
  RETURNING (xmax = 0) AS was_insert
)
SELECT (SELECT count(*) FROM bb_stage WHERE idpredmet IS NOT NULL) || '|' ||
       count(*) FILTER (WHERE was_insert) || '|' ||
       count(*) FILTER (WHERE NOT was_insert) || '|' ||
       (SELECT count(*) FROM projects t WHERE NOT EXISTS (SELECT 1 FROM bb_stage s WHERE s.idpredmet = t.id))
FROM upserted;
-- keep the autoincrement sequence past the explicit ids we just inserted
SELECT setval(pg_get_serial_sequence('projects','id'),
              GREATEST((SELECT COALESCE(max(id),1) FROM projects), 1),
              EXISTS(SELECT 1 FROM projects));
COMMIT;
