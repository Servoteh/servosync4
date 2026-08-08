-- Seoba sy15 -> 3.0, KORAK 2c: PREVOD IDENTITETA (`users.sy15_user_id`).
-- Runbook: docs/SEOBA_ODRZAVANJA_2026-08-06.md (§7, poslednja blokada koraka 2).
--
-- ══════════════════════════════════════════════════════════════════════════════
-- ZAŠTO OVA KOLONA POSTOJI
-- ══════════════════════════════════════════════════════════════════════════════
-- Sve sy15 kolone koje nose ČOVEKA su `uuid` (`auth.users.id`):
--   maint_work_orders.assigned_to · maint_incidents.assigned_to
--   maint_machines.responsible_user_id · maint_assets.responsible_user_id
--   maint_drivers.auth_user_id · maint_user_profiles.user_id · loc_*.moved_by
-- U 3.0 je isti pojam `users.id` (INTEGER — BACKEND_RULES §2.1: ID-jevi NISU uuid),
-- a `users` do sada NIJE imao NIJEDNU kolonu sa sy15 uuid-om (izmereno
-- 08.08.2026 kroz `information_schema.columns`: id, email, password_hash,
-- full_name, role, active, email_verified_at, last_login_at, created_at,
-- updated_at, worker_id, must_change_password).
--
-- Posledica te praznine: `OdrzavanjeService.id30` pod `ODRZAVANJE_IZVOR=3.0` NIJE
-- IMAO ČIME da prevede uuid, pa je GLASNO padao sa 422 na 5 mesta (createMachine,
-- updateMachine, updateIncident, updateWorkOrder). Prevod je tiho odbacivanje
-- namerno izbegavao („nalog sačuvan, dodela nestala"), ali je time obarao stvaran
-- radni tok: dodela radnog naloga čoveku i postavljanje odgovornog za mašinu.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- ZAŠTO JE NULL DOZVOLJEN (i zašto to NIJE kvar)
-- ══════════════════════════════════════════════════════════════════════════════
-- IZMERENO na produkciji 08.08.2026 (`ANALYZE` pa `count(*)`, ne `n_live_tup` —
-- `pg_stat` NIJE broj redova):
--   * 3.0  `public.users` : 71 naloga, 71 aktivnih, 71 različitih mejlova
--   * sy15 `auth.users`   : 62 naloga, 62 sa mejlom, 62 različita mejla
--   * poklapanje po `lower(btrim(email))`: 61 od 62 (98%)
--   * jedini sy15 nalog BEZ 3.0 parnjaka: `bigtehn-worker@system.local`
--     (uuid `00000000-0000-0000-0000-000000000099`)
-- Dakle 10 od 71 3.0 naloga nikad nije imalo sy15 parnjaka — to je ispravno
-- stanje (nalozi napravljeni posle seobe sy15 identiteta), ne kvar. NOT NULL bi
-- ovde bio laž o podatku.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- ODLUKA O `bigtehn-worker@system.local`: OSTAJE BEZ PARNJAKA
-- ══════════════════════════════════════════════════════════════════════════════
-- To je sistemski nalog BIGTEHN mosta, a most je UGAŠEN 07.08.2026 (4669 prolaza
-- / 0 izmena; QBigTehn MSSQL `192.168.64.25` ne odgovara). Pravljenje 3.0 naloga
-- za mrtav sistem uvelo bi novo stanje koje niko nije tražio — a nalog bez ijedne
-- dodele ionako nema šta da prevede. Ako ikad zatreba, to je nova odluka.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- ZAŠTO SU 61 PAR UPISANI DOSLOVNO, A NE SPOJENI UPITOM
-- ══════════════════════════════════════════════════════════════════════════════
-- Migracija se izvršava kao JEDAN skript nad 3.0 bazom; sy15 je DRUGA baza
-- (docker `sy15-db`) i iz ovog konteksta se ne može čitati (nema dblink/FDW, i
-- ne uvodi se zbog jednog backfill-a). Alternativa — „popuni ručno posle
-- deploy-a" — ostavlja prozor u kome je prekidač na `3.0` a kolona prazna, tj.
-- baš 422 koji ovaj PR uklanja. Zato parovi idu u migraciju.
--
-- Parovi su IZVOZ sa ŽIVE sy15 (`select id, lower(btrim(email)) from auth.users`,
-- 08.08.2026), a spajanje se svakako obavlja NA CILJU po `lower(btrim(email))`:
-- ako je nekom u međuvremenu promenjen mejl u 3.0, njegov red se NE poklopi i
-- migracija ga PRIJAVI (`RAISE WARNING`), ne prećuti.
--
-- Održavanje posle ove migracije (novi nalozi, promene mejla) radi
-- `scripts/povezi-identitet-sy15.ts` — čita OBE baze uživo (kroz isti
-- `scripts/lib/sy15-identity.ts` koji su koristile prenosne skripte koraka 1 i 2),
-- idempotentan je i prijavljuje svaki nalog bez parnjaka.

-- ── 1. DDL ────────────────────────────────────────────────────────────────────
-- (Generisano `prisma migrate diff` datamodel->datamodel; BACKEND_RULES v0.7 §12
--  odobreno odstupanje od `migrate:dev` za prod-only okruženje.)

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "sy15_user_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "uq_users_sy15_user_id" ON "users"("sy15_user_id");

-- ── 2. POPUNA PO MEJLU + IZVEŠTAJ ─────────────────────────────────────────────
DO $$
DECLARE
  v_povezano  integer;
  v_bez_par   integer;
  v_prazni    integer;
  r           record;
BEGIN
  -- Temp tabela se briše EKSPLICITNO na kraju bloka (ne `ON COMMIT DROP`):
  -- `ON COMMIT` zavisi od toga da li skript ide u jednoj transakciji, a to je
  -- pretpostavka o pokretaču, ne o skriptu.
  DROP TABLE IF EXISTS _sy15_nalozi;
  CREATE TEMP TABLE _sy15_nalozi (sy15_id uuid PRIMARY KEY, email text NOT NULL);

  -- Svih 62 sy15 naloga, uključujući `bigtehn-worker@system.local` — on je TU
  -- NAMERNO iako je odluka „ostaje bez parnjaka": tako ga popuna ne prećuti nego
  -- ga PRIJAVI kao nalog bez 3.0 parnjaka (`RAISE WARNING` ispod). Odsustvo iz
  -- liste bilo bi tiho preskakanje, a to je upravo ono što se ne sme.
  INSERT INTO _sy15_nalozi (sy15_id, email) VALUES
  ('10d7d881-c998-4f4a-bc58-30b89abf2d44'::uuid, 'ai-maint-test@servoteh.local'),
  ('00000000-0000-0000-0000-000000000099'::uuid, 'bigtehn-worker@system.local'),
  ('407edc6b-bbaa-4171-8cb8-df923c7248f9'::uuid, 'aleksandar.stanic@servoteh.com'),
  ('b235e222-d4c1-48d8-9d1b-2fcdbbaef867'::uuid, 'bojana.trifunovic@hapfluid.rs'),
  ('3e36d1f3-c195-426c-b92e-56ef3deec458'::uuid, 'branislav.stanojevic@servoteh.com'),
  ('583ee2c1-eaf3-4d06-b64d-68bc66c5df36'::uuid, 'branislava.pavlovic@servoteh.com'),
  ('c0ca92f2-cd67-4d36-80cc-b020ad3b2190'::uuid, 'cveticmarko47@gmail.com'),
  ('0e4e9313-86d2-493e-8203-76063c53fc4c'::uuid, 'dijana.kastratovic@servoteh.com'),
  ('de4c6def-48c2-4fe8-9421-f4670cf94a73'::uuid, 'djordje.arsic@servoteh.com'),
  ('d6602b03-ed84-490d-99d4-609aa4d2d477'::uuid, 'djurotrkulja@gmail.com'),
  ('7551960e-5694-449b-b3e3-e7a2e447e7aa'::uuid, 'dragan.dobromirovic@servoteh.com'),
  ('70ebeb6e-f82c-41a0-bb48-fe6e125ba3bb'::uuid, 'dragan.ristanic@servoteh.com'),
  ('36132901-726e-4c2d-9ef3-a96da05df934'::uuid, 'dragana.madjercic@servoteh.com'),
  ('434475f1-7762-444f-b9e8-e010dd6d8fef'::uuid, 'dusko.kostic@servoteh.com'),
  ('af5e3b2f-2be5-4f78-a6a7-ddd8fd50a5f4'::uuid, 'igor.vostic@servoteh.com'),
  ('a9c79464-9de6-44a5-bd0e-02ff0dd3189f'::uuid, 'iliczaleksandar@gmail.com'),
  ('eee489f0-c7f8-4635-9b2b-7ef0da12a873'::uuid, 'ivan.umicevic@servoteh.com'),
  ('6eb16989-1a0c-4058-8c6b-ba6a06cae7f0'::uuid, 'jarakovic@gmail.com'),
  ('207738f3-c929-4b31-8f0e-910f52485a63'::uuid, 'jelena.stanisic@servoteh.com'),
  ('b02bcd96-e8b9-4090-a2c3-7a8fb59b12a6'::uuid, 'jovan.matic@servoteh.com'),
  ('cf751885-2dc6-4e73-bef4-9d53f3a63ca5'::uuid, 'jovan.papic@servoteh.com'),
  ('3c66131a-fe78-461a-84a2-86cbbf38deed'::uuid, 'jovica.milosevic@servoteh.com'),
  ('d3e7ce69-cea8-4956-89a4-46407960fe45'::uuid, 'kontrola@servoteh.com'),
  ('bb943992-9fd7-4c54-b0f3-649a655d1441'::uuid, 'ljubisa.simovic@servoteh.com'),
  ('037a66a0-2345-43a5-99a6-168fe3dece38'::uuid, 'luka.petrovic@servoteh.com'),
  ('6a0347d2-e3f6-458e-90f1-1a0f6a0bdae8'::uuid, 'luka.tadic@servoteh.com'),
  ('a3e9b3fa-0ce9-4225-adaf-da2430faaf78'::uuid, 'luka.talovic@servoteh.com'),
  ('06827516-30fc-43f7-b57f-6027cb7f2d59'::uuid, 'marija.samardzic@servoteh.com'),
  ('d9111ceb-7c87-4db3-ac33-d004facb4569'::uuid, 'marijana.manojlovic@servoteh.com'),
  ('a4913a06-35f5-4108-9602-0173dfa7285d'::uuid, 'marko.stojanovic@servoteh.com'),
  ('e8666bbc-862c-4ea7-9d1c-078a9503e726'::uuid, 'miladinovicnenad628@gmail.com'),
  ('928f961e-d265-476e-89bd-86e4d16a04a4'::uuid, 'milan.milovanovic@servoteh.com'),
  ('77ebe11b-6cff-4512-ab39-e01b1ccfb026'::uuid, 'milan.stojadinovic@servoteh.com'),
  ('75a1329f-8840-488d-a324-69d1966dfa9e'::uuid, 'miljan.nikodijevic@servoteh.com'),
  ('eb10a139-ae72-48cd-88c7-a15c595a9436'::uuid, 'milorad.jerotic@servoteh.com'),
  ('7025eb48-6b74-4f00-8e51-bfedd4c7558f'::uuid, 'mladenandjic02@gmail.com'),
  ('b4ff5146-1022-4d1c-881f-62b0257c7f32'::uuid, 'nebojsa.milosevic@servoteh.com'),
  ('8b19eb49-d03a-4817-88f2-57fb1ea47369'::uuid, 'nebojsajancic747@gmail.com'),
  ('90d00c13-85dd-4229-ab29-091b3341196f'::uuid, 'nenad.jarakovic@servoteh.com'),
  ('8277f104-ea76-491d-8f05-687edaaa66a7'::uuid, 'nenad.nikolic@servoteh.com'),
  ('0b113f31-1908-4859-8ca9-a75b226a6589'::uuid, 'nevena.knezevic@servoteh.com'),
  ('f0a8ba8c-9073-4428-a9d9-d214a42a1bab'::uuid, 'nikola.aksentijevic@servoteh.com'),
  ('71069da0-952f-46b4-a5e3-d90a87342159'::uuid, 'nikola.mrkajic@servoteh.com'),
  ('89a84bec-04c0-44cb-807e-f5f805aa1d6b'::uuid, 'nikola.ninkovic@servoteh.com'),
  ('d3c8cd9c-77ed-4d33-853c-d7934905406d'::uuid, 'nikola.savic@servoteh.com'),
  ('1f7f4130-0104-4478-be1c-8f4a87422967'::uuid, 'pavle.ilic@servoteh.com'),
  ('9fe3a719-276c-4a5f-bfd4-50f855a5420b'::uuid, 'radisav.radevic@servoteh.com'),
  ('626cf2e9-940e-42a4-acc5-5455083e105d'::uuid, 'slavisa.radosavljevic@servoteh.com'),
  ('129f4807-9da4-4b61-a1ca-160a397d7328'::uuid, 'sofija.deheljan@servoteh.com'),
  ('5c9d2cd6-00cf-4ae0-9477-302a0e885058'::uuid, 'stamenic4@gmail.com'),
  ('cc738be1-92ed-47b1-a4b3-fa24ac05d07e'::uuid, 'stefan.danicic@servoteh.com'),
  ('6ba4e3d6-4a81-4389-b26d-ee8ba63e3b27'::uuid, 'stevan.birovljev@servoteh.com'),
  ('8b94cb8d-9560-46b2-86fb-51eb6b5b8ddc'::uuid, 'strahinja.petrovic@servoteh.com'),
  ('510b0a45-3179-4c8d-93b6-9772ce5db345'::uuid, 'tasicluka123@gmail.com'),
  ('864dfd9e-ce5e-44bd-9990-97d761d2c233'::uuid, 'tatjana.gnjidic@servoteh.com'),
  ('975d763f-f4aa-42cf-abf4-34d0e2571dbc'::uuid, 'test@servoteh.com'),
  ('9782c7fa-2965-4db4-b870-d838aefd4d9a'::uuid, 'veljko.mijajlovic@servoteh.com'),
  ('0cc3b6ec-0f0e-4b88-87e3-c967f94ddb4b'::uuid, 'vladan.pavlovic@servoteh.com'),
  ('4bc74b16-fcf9-42b5-ba1f-b3eefc4120f6'::uuid, 'vladan.radivojevic@servoteh.com'),
  ('9e564ed2-cd8c-4215-a5d9-11d8d8d4eed2'::uuid, 'vuk.radojevic@servoteh.com'),
  ('7ae9a682-1a58-433e-9c6d-a008f5f7a7ce'::uuid, 'zelimir.jovasevic@servoteh.com'),
  ('97fcb595-855f-4547-ad79-0e198b96b691'::uuid, 'zoran.jarakovic@servoteh.com');

  -- Popuna. `sy15_user_id IS NULL` čini korak idempotentnim (ponovno pokretanje
  -- ne pregazi vezu koju je u međuvremenu popravila skripta ili čovek).
  UPDATE users u
     SET sy15_user_id = s.sy15_id
    FROM _sy15_nalozi s
   WHERE lower(btrim(u.email)) = s.email
     AND u.sy15_user_id IS NULL;
  GET DIAGNOSTICS v_povezano = ROW_COUNT;

  SELECT count(*) INTO v_bez_par
    FROM _sy15_nalozi s
   WHERE NOT EXISTS (
           SELECT 1 FROM users u WHERE lower(btrim(u.email)) = s.email);

  SELECT count(*) INTO v_prazni FROM users WHERE sy15_user_id IS NULL;

  -- 🔴 Nalog bez parnjaka se PRIJAVLJUJE, ne preskače tiho: tišina bi značila da
  -- se prevod identiteta „završio uspešno" a da neko i dalje ne može biti dodeljen.
  FOR r IN
    SELECT s.sy15_id, s.email
      FROM _sy15_nalozi s
     WHERE NOT EXISTS (
             SELECT 1 FROM users u WHERE lower(btrim(u.email)) = s.email)
     ORDER BY s.email
  LOOP
    RAISE WARNING
      'PREVOD IDENTITETA: sy15 nalog % (%) NEMA 3.0 parnjaka po mejlu — dodela na taj nalog pada sa 422 dok se ne poveže.',
      r.email, r.sy15_id;
  END LOOP;

  -- Očekivano po merenju 08.08.2026: povezano 61, bez 3.0 parnjaka 1
  -- (`bigtehn-worker@system.local`), 3.0 naloga bez sy15 parnjaka 10.
  RAISE NOTICE
    'PREVOD IDENTITETA: povezano % naloga; sy15 naloga bez 3.0 parnjaka: %; 3.0 naloga bez sy15 parnjaka: %.',
    v_povezano, v_bez_par, v_prazni;

  -- Očekivanje iz merenja 08.08.2026: 61 par. Manje od 55 znači da se `users`
  -- razišao od merenja u meri koja traži ljudsku odluku — ali NE obara deploy
  -- (kolona je nullable, prevod za povezane naloge radi, ostatak je prijavljen).
  IF v_povezano < 55 AND v_povezano > 0 THEN
    RAISE WARNING
      'PREVOD IDENTITETA: povezano samo % od 61 očekivanog para — proveri mejlove u `users` i pokreni scripts/povezi-identitet-sy15.ts.',
      v_povezano;
  END IF;

  DROP TABLE _sy15_nalozi;
END $$;
