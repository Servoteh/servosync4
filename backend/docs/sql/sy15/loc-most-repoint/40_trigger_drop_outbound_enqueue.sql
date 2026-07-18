-- B1 loc-most repoint — KORAK 8: gašenje OUTBOUND enqueue grane (sy15).
--
-- ⚠️ PREDUSLOV (verify B1-OPS-5): preflight (C2) MORA biti prazan (nijedan SYNCED/
-- IN_PROGRESS red, nijedan attempts>0) I bridge VM 192.168.64.24 proveren da nema
-- živ loc-sync-mssql proces. Ako bilo šta od toga ne važi → NE primenjivati; prvo
-- koordinacija sa Negovanom (target je bio ServoTehERP MSSQL, ne QBigTehn).
--
-- ŠTA RADI: `loc_after_movement_insert` gubi SAMO poslednju granu (INSERT u
-- loc_sync_outbound_events). Placement logika — drawing_no normalizacija, TO upsert,
-- FROM oduzimanje — je BAJT-IDENTIČNA zatečenoj (izvor: authz snapshot 12.07,
-- linije 5–123; verifikovati diff protiv 01_originals_LIVE_<datum>.sql pre primene).
--
-- ŠTA SE NE RADI: postojećih ~1274 PENDING redova se NE dira (ni brisanje ni lažni
-- SYNCED) — ostaju zamrznuta istorija do B3 seobe. PENDING ne okida alerte
-- (loc_sync_health_check broji samo DEAD_LETTER).

\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION public.loc_after_movement_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  pl_status    public.loc_placement_status_enum;
  v_remain     NUMERIC(12,3);
  v_drawing    TEXT;
BEGIN
  IF NEW.movement_type IN ('SEND_TO_SERVICE', 'SEND_TO_FIELD') THEN
    pl_status := 'IN_TRANSIT'::public.loc_placement_status_enum;
  ELSE
    pl_status := 'ACTIVE'::public.loc_placement_status_enum;
  END IF;

  /* Drawing normalization (v4 logika): ako NEW.drawing_no nije poslat,
   * pokušaj da ga izvučeš iz note (RNZ format „Crtež:NNN | …"). */
  v_drawing := COALESCE(NULLIF(trim(NEW.drawing_no), ''), '');
  IF v_drawing = '' AND NEW.note IS NOT NULL AND NEW.note ~ 'Crte[žz]:[^\s|]+' THEN
    v_drawing := substring(NEW.note FROM 'Crte[žz]:([^\s|]+)');
  END IF;

  IF v_drawing <> '' AND (NEW.drawing_no IS NULL OR NEW.drawing_no = '') THEN
    UPDATE public.loc_location_movements
       SET drawing_no = v_drawing
     WHERE id = NEW.id;
  END IF;

  /* TO lokacija upsert — placement state. */
  IF NEW.to_location_id IS NOT NULL THEN
    INSERT INTO public.loc_item_placements (
      item_ref_table, item_ref_id, order_no, drawing_no, location_id, placement_status,
      quantity, last_movement_id, placed_at, placed_by, notes
    ) VALUES (
      NEW.item_ref_table, NEW.item_ref_id, COALESCE(NEW.order_no, ''),
      v_drawing,
      NEW.to_location_id, pl_status,
      NEW.quantity, NEW.id, NEW.moved_at, NEW.moved_by, NULL
    )
    ON CONFLICT (item_ref_table, item_ref_id, order_no, location_id) DO UPDATE SET
      quantity = public.loc_item_placements.quantity + EXCLUDED.quantity,
      placement_status = EXCLUDED.placement_status,
      last_movement_id = EXCLUDED.last_movement_id,
      placed_at = EXCLUDED.placed_at,
      placed_by = EXCLUDED.placed_by,
      drawing_no = CASE
        WHEN EXCLUDED.drawing_no <> '' THEN EXCLUDED.drawing_no
        ELSE public.loc_item_placements.drawing_no
      END,
      updated_at = now();
  END IF;

  /* FROM lokacija: oduzmi qty. */
  IF NEW.from_location_id IS NOT NULL THEN
    v_remain := (
      SELECT lp.quantity - NEW.quantity
        FROM public.loc_item_placements lp
       WHERE lp.item_ref_table = NEW.item_ref_table
         AND lp.item_ref_id    = NEW.item_ref_id
         AND lp.order_no       = COALESCE(NEW.order_no, '')
         AND lp.location_id    = NEW.from_location_id
    );

    IF v_remain IS NULL THEN
      RAISE EXCEPTION 'loc_after_movement_insert: missing placement on from_location (item=%/%, order=%, loc=%)',
        NEW.item_ref_table, NEW.item_ref_id, COALESCE(NEW.order_no, ''), NEW.from_location_id;
    ELSIF v_remain <= 0 THEN
      DELETE FROM public.loc_item_placements
       WHERE item_ref_table = NEW.item_ref_table
         AND item_ref_id    = NEW.item_ref_id
         AND order_no       = COALESCE(NEW.order_no, '')
         AND location_id    = NEW.from_location_id;
    ELSE
      UPDATE public.loc_item_placements
         SET quantity = v_remain,
             last_movement_id = NEW.id,
             updated_at = now()
       WHERE item_ref_table = NEW.item_ref_table
         AND item_ref_id    = NEW.item_ref_id
         AND order_no       = COALESCE(NEW.order_no, '')
         AND location_id    = NEW.from_location_id;
    END IF;
  END IF;

  /* B1 loc-most repoint (2026-07-18): OUTBOUND ENQUEUE UKLONJEN.
   * Ranije je ova grana punila loc_sync_outbound_events za MSSQL
   * dbo.sp_ApplyLocationEvent (ServoTehERP). Worker nikad nije radio (1274 PENDING,
   * attempts=0 od 28.04), a QBigTehn/MSSQL se dekomisira — write target ne postoji.
   * Postojeći PENDING redovi ostaju kao istorija do B3 konsolidacije.
   * Rollback: 01_originals_LIVE_<datum>.sql. */

  RETURN NEW;
END;
$function$;

-- Kontrola: fn više ne pominje outbound tabelu, a trigger je i dalje zakačen.
SELECT pg_get_functiondef(p.oid) LIKE '%loc_sync_outbound_events%' AS still_enqueues
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname='public' AND p.proname='loc_after_movement_insert';
SELECT tgname, tgenabled FROM pg_trigger
 WHERE tgrelid = 'public.loc_location_movements'::regclass AND NOT tgisinternal;
SELECT status, count(*) FROM loc_sync_outbound_events GROUP BY status;  -- zamrznut count
