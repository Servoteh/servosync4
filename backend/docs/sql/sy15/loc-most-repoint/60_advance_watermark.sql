-- B1 loc-most repoint — KORAK 6: ODLUKA O BACKLOG-u (sy15). OPCIONO.
--
-- ⚠️ POSLOVNA ODLUKA (Nenad), ne tehnička. Izvršiti SAMO ako je izbor „start od sada".
-- Mora se doneti PRE ARM-a (korak 7) — ingest watermark ide samo NAPRED.
--
-- KONTEKST: između cutover-a (14.07, tTehPostupak frozen) i dana prelaza, 2.0 je
-- napravio N novih tech_processes redova koje legacy lanac nikad nije video. Kad se
-- ingest ARM-uje, on ih obrađuje kao svež signal.
--
--  (A) BACKFILL (ne izvršavati ovu skriptu): ingest svari zaostatak tempom
--      p_max_signals=200 po ciklusu. Auto-pokreti nastaju sa moved_at U PROŠLOSTI
--      (started_at signala). RIZIK: placements su u međuvremenu ručno održavani —
--      backfill može praviti transfere koji su već ručno izvedeni. `skip_already_there`
--      štiti samo kad je deo VEĆ na toj mašini. Prednost: lanci mašina se poravnaju
--      sa stvarnim prijavama. Ako se bira A → NAJAVITI korisnicima Lokacija (videće
--      talas promena) i pratiti prvih nekoliko ciklusa.
--
--  (B) START „OD SADA" (ova skripta): watermark skače na trenutni max, backlog se
--      trajno preskače. Placements ostaju kakvi jesu (ručno stanje = istina), auto
--      pokreti kreću od prve nove prijave. Preporučeno ako je ručno održavanje bilo
--      aktivno. Preduslov: feed je već napunio cache (korak 4), inače „max" nije pun.

\set ON_ERROR_STOP on

-- Pre: zabeleži zatečeno stanje i obim koji se preskače.
SELECT last_processed_signal_id AS watermark_before,
       (SELECT max(id) FROM bigtehn_tech_routing_cache) AS cache_max_id,
       (SELECT count(*) FROM bigtehn_tech_routing_cache c
         WHERE c.id > s.last_processed_signal_id)       AS signals_to_be_skipped
  FROM loc_bigtehn_ingest_state s
 WHERE s.worker_id = 'loc-bigtehn-ingest';

UPDATE loc_bigtehn_ingest_state
   SET last_processed_signal_id = COALESCE(
         (SELECT max(id) FROM bigtehn_tech_routing_cache),
         last_processed_signal_id),
       updated_at = now()
 WHERE worker_id = 'loc-bigtehn-ingest';

-- Posle:
SELECT worker_id, armed, last_processed_signal_id, last_run_at
  FROM loc_bigtehn_ingest_state;

-- ROLLBACK: watermark se NE vraća unazad kroz redovan tok. Ako se posle odluke ipak
-- traži backfill, to je svesna intervencija (UPDATE na niži id) — pre nje proveriti
-- da re-obrada ne duplira placements (initial → skip_already_there / chain grana).
