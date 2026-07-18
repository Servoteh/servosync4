-- AUTHZ/RPC SNAPSHOT: Lokacije delova (loc_*) — snimljeno 2026-07-12
-- Izvor: zamrznuti cloud = restore-izvor sy15. Re-verifikovati na zivoj sy15 pre R1.
-- 36 funkcija. Front-facing (~12) + bridge/worker/cron (ostatak — NE migrira se, ostaje u sy15/bridge).

-- ============ loc_after_movement_insert ============
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

  /* Sync outbound event — Faza 2B addition: SKIP ako je source='bigtehn'.
   * Signal je već došao iz MSSQL-a, vraćanje bi pravilo sync loop. */
  IF COALESCE(NEW.source, 'manual') <> 'bigtehn' THEN
    INSERT INTO public.loc_sync_outbound_events (
      id, source_table, source_record_id, target_procedure, payload, status
    ) VALUES (
      NEW.id,
      'loc_location_movements',
      NEW.id,
      'dbo.sp_ApplyLocationEvent',
      jsonb_build_object(
        'event_uuid', NEW.id::text,
        'item_ref_table', NEW.item_ref_table,
        'item_ref_id', NEW.item_ref_id,
        'order_no', COALESCE(NEW.order_no, ''),
        'drawing_no', COALESCE(v_drawing, ''),
        'from_location_code', (SELECT llfc.location_code FROM public.loc_locations AS llfc WHERE llfc.id = NEW.from_location_id),
        'to_location_code',   (SELECT lltc.location_code FROM public.loc_locations AS lltc WHERE lltc.id = NEW.to_location_id),
        'movement_type', NEW.movement_type::text,
        'quantity', NEW.quantity,
        'moved_at', to_jsonb(NEW.moved_at),
        'moved_by', NEW.moved_by::text,
        'note', NEW.note
      ),
      'PENDING'::public.loc_sync_status_enum
    );
  END IF;

  RETURN NEW;
END;
$function$
;

-- ============ loc_auth_roles ============
CREATE OR REPLACE FUNCTION public.loc_auth_roles()
 RETURNS text[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT coalesce(
    array_agg(DISTINCT lower(ur.role::text)) FILTER (WHERE ur.role IS NOT NULL),
    ARRAY[]::text[]
  )
  FROM public.user_roles ur
  WHERE ur.is_active = true
    AND lower(ur.email) = lower(coalesce(auth.jwt()->>'email', ''));
$function$
;

-- ============ loc_bigtehn_ingest_arm ============
CREATE OR REPLACE FUNCTION public.loc_bigtehn_ingest_arm(p_armed boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'not_authenticated');
  END IF;
  IF NOT public.loc_is_admin() THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'not_admin');
  END IF;
  IF p_armed IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'bad_arg');
  END IF;

  UPDATE public.loc_bigtehn_ingest_state
     SET armed = p_armed,
         updated_at = now()
   WHERE worker_id = 'loc-bigtehn-ingest';

  RETURN jsonb_build_object('ok', TRUE, 'armed', p_armed);
END;
$function$
;

-- ============ loc_bigtehn_ingest_run ============
CREATE OR REPLACE FUNCTION public.loc_bigtehn_ingest_run(p_max_signals integer DEFAULT 200, p_max_age_days integer DEFAULT 30)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_system_user_id        CONSTANT UUID := '00000000-0000-0000-0000-000000000099';
  v_armed                 BOOLEAN;
  v_watermark             BIGINT;
  v_new_watermark         BIGINT;
  v_signal                RECORD;
  v_count_total           INT := 0;
  v_count_too_old         INT := 0;
  v_count_no_machine_loc  INT := 0;
  v_count_no_rn_in_cache  INT := 0;
  v_count_skip_already    INT := 0;
  v_count_skip_zero_qty   INT := 0;
  v_count_skip_bad_ident  INT := 0;
  v_count_chain_transfer  INT := 0;
  v_count_shelf_transfer  INT := 0;
  v_count_initial         INT := 0;
  v_count_armed_executed  INT := 0;
  v_count_armed_errors    INT := 0;
  v_count_fallback_parser INT := 0;
  v_action_samples        JSONB := '[]'::jsonb;
  v_max_samples           CONSTANT INT := 25;
  v_started_at            TIMESTAMPTZ := now();
  v_min_age               TIMESTAMPTZ;

  /* per-signal */
  v_parsed                JSONB;
  v_order_no              TEXT;
  v_tp_no                 TEXT;
  v_parser_fallback       BOOLEAN;
  v_machine_loc_id        UUID;
  v_current_loc_id        UUID;
  v_current_loc_code      TEXT;
  v_current_loc_type      TEXT;
  v_current_qty           NUMERIC;
  v_rn_total              NUMERIC;
  v_rn_drawing            TEXT;
  v_action                TEXT;
  v_transfer_qty          NUMERIC;
  v_movement_id           UUID;
  v_movement_type         public.loc_movement_type_enum;
  v_armed_error           TEXT;
  v_sample                JSONB;
BEGIN
  v_min_age := now() - make_interval(days => GREATEST(1, COALESCE(p_max_age_days, 30)));

  SELECT armed, last_processed_signal_id
    INTO v_armed, v_watermark
    FROM public.loc_bigtehn_ingest_state
   WHERE worker_id = 'loc-bigtehn-ingest'
   FOR UPDATE;

  IF v_armed IS NULL THEN
    INSERT INTO public.loc_bigtehn_ingest_state (worker_id, last_processed_signal_id, armed)
    VALUES ('loc-bigtehn-ingest', 0, FALSE)
    ON CONFLICT (worker_id) DO NOTHING;
    v_armed := FALSE;
    v_watermark := 0;
  END IF;

  v_new_watermark := v_watermark;

  FOR v_signal IN
    SELECT tr.id, tr.work_order_id, tr.ident_broj, tr.operacija, tr.machine_code,
           tr.komada, tr.started_at, tr.finished_at, tr.is_completed,
           NULLIF(trim(tr.potpis), '') AS potpis
      FROM public.bigtehn_tech_routing_cache tr
     WHERE tr.id > v_watermark
       AND tr.started_at IS NOT NULL
       AND tr.machine_code IS NOT NULL
       AND tr.ident_broj IS NOT NULL
     ORDER BY tr.id ASC
     LIMIT GREATEST(1, LEAST(p_max_signals, 1000))
  LOOP
    v_count_total := v_count_total + 1;
    v_new_watermark := GREATEST(v_new_watermark, v_signal.id);
    v_action := NULL;
    v_armed_error := NULL;
    v_current_loc_id := NULL;
    v_current_loc_code := NULL;
    v_current_loc_type := NULL;
    v_current_qty := NULL;
    v_rn_total := NULL;
    v_rn_drawing := NULL;
    v_transfer_qty := NULL;
    v_parser_fallback := FALSE;
    v_order_no := NULL;
    v_tp_no := NULL;

    <<signal_inner>>
    LOOP
      IF v_signal.started_at < v_min_age THEN
        v_action := 'too_old';
        v_count_too_old := v_count_too_old + 1;
        EXIT signal_inner;
      END IF;

      /* SMART parser: longest active predmet prefix match. */
      v_parsed := public.loc_bigtehn_parse_ident(v_signal.ident_broj);
      v_order_no := v_parsed->>'predmet';
      v_tp_no    := v_parsed->>'tp';
      v_parser_fallback := COALESCE((v_parsed->>'fallback')::BOOLEAN, FALSE);
      IF v_parser_fallback THEN
        v_count_fallback_parser := v_count_fallback_parser + 1;
      END IF;

      IF v_order_no IS NULL OR v_tp_no IS NULL THEN
        v_action := 'skip_bad_ident';
        v_count_skip_bad_ident := v_count_skip_bad_ident + 1;
        EXIT signal_inner;
      END IF;

      SELECT ll.id INTO v_machine_loc_id
        FROM public.loc_locations ll
       WHERE ll.location_code = v_signal.machine_code
         AND ll.location_type = 'MACHINE'
         AND ll.is_active = TRUE
       LIMIT 1;

      IF v_machine_loc_id IS NULL THEN
        v_action := 'no_machine_loc';
        v_count_no_machine_loc := v_count_no_machine_loc + 1;
        EXIT signal_inner;
      END IF;

      SELECT lp.location_id, ll.location_code, ll.location_type::TEXT, lp.quantity
        INTO v_current_loc_id, v_current_loc_code, v_current_loc_type, v_current_qty
        FROM public.loc_item_placements lp
        LEFT JOIN public.loc_locations ll ON ll.id = lp.location_id
       WHERE lp.item_ref_table = 'bigtehn_rn'
         AND lp.item_ref_id    = v_tp_no
         AND lp.order_no       = v_order_no
         AND lp.quantity > 0
       ORDER BY lp.quantity DESC NULLS LAST, lp.updated_at DESC
       LIMIT 1;

      IF v_current_loc_id IS NULL THEN
        v_action := 'initial_placement';
      ELSIF v_current_loc_id = v_machine_loc_id THEN
        v_action := 'skip_already_there';
        v_count_skip_already := v_count_skip_already + 1;
        EXIT signal_inner;
      ELSIF v_current_loc_type = 'MACHINE' THEN
        v_action := 'chain_transfer';
      ELSE
        v_action := 'shelf_transfer';
      END IF;

      IF v_action = 'initial_placement' THEN
        SELECT wo.komada, NULLIF(trim(wo.broj_crteza), '')
          INTO v_rn_total, v_rn_drawing
          FROM public.bigtehn_work_orders_cache wo
         WHERE wo.id = v_signal.work_order_id
         LIMIT 1;

        IF v_rn_total IS NULL OR v_rn_total <= 0 THEN
          v_action := 'no_rn_in_cache';
          v_count_no_rn_in_cache := v_count_no_rn_in_cache + 1;
          EXIT signal_inner;
        END IF;

        v_transfer_qty := v_rn_total;
        v_movement_type := 'INITIAL_PLACEMENT'::public.loc_movement_type_enum;
        v_count_initial := v_count_initial + 1;

      ELSE
        IF COALESCE(v_signal.komada, 0) = 0 THEN
          v_action := 'skip_zero_qty';
          v_count_skip_zero_qty := v_count_skip_zero_qty + 1;
          EXIT signal_inner;
        END IF;

        v_transfer_qty := v_current_qty;
        v_movement_type := 'TRANSFER'::public.loc_movement_type_enum;

        IF v_action = 'chain_transfer' THEN
          v_count_chain_transfer := v_count_chain_transfer + 1;
        ELSE
          v_count_shelf_transfer := v_count_shelf_transfer + 1;
        END IF;
      END IF;

      IF v_armed THEN
        BEGIN
          v_movement_id := gen_random_uuid();
          INSERT INTO public.loc_location_movements (
            id,
            item_ref_table, item_ref_id, order_no, drawing_no,
            from_location_id, to_location_id,
            movement_type, movement_reason,
            quantity, note,
            moved_at, moved_by,
            source
          ) VALUES (
            v_movement_id,
            'bigtehn_rn', v_tp_no, v_order_no,
            COALESCE(v_rn_drawing, ''),
            v_current_loc_id,
            v_machine_loc_id,
            v_movement_type,
            format('Auto iz BigTehn prijave #%s (%s)', v_signal.id, v_signal.operacija),
            v_transfer_qty,
            format('signal=%s op=%s mach=%s qty=%s pot=%s',
                   v_signal.id, v_signal.operacija, v_signal.machine_code,
                   v_signal.komada, COALESCE(v_signal.potpis, '?')),
            v_signal.started_at,
            v_system_user_id,
            'bigtehn'
          );
          v_count_armed_executed := v_count_armed_executed + 1;
        EXCEPTION WHEN others THEN
          v_armed_error := SQLERRM;
          v_count_armed_errors := v_count_armed_errors + 1;
        END;
      END IF;

      EXIT signal_inner;
    END LOOP;

    IF v_count_total <= v_max_samples THEN
      v_sample := jsonb_build_object(
        'signal_id',      v_signal.id,
        'work_order_id',  v_signal.work_order_id,
        'ident',          v_signal.ident_broj,
        'predmet',        v_order_no,
        'tp',             v_tp_no,
        'parser_fallback', v_parser_fallback,
        'op',             v_signal.operacija,
        'machine',        v_signal.machine_code,
        'prijava_qty',    v_signal.komada,
        'action',         v_action,
        'from_loc',       v_current_loc_code,
        'from_type',      v_current_loc_type,
        'to_machine',     v_signal.machine_code,
        'transfer_qty',   v_transfer_qty,
        'rn_total',       v_rn_total,
        'started_at',     v_signal.started_at,
        'armed_executed', (v_armed AND v_armed_error IS NULL AND v_action IN ('initial_placement','chain_transfer','shelf_transfer')),
        'armed_error',    v_armed_error
      );
      v_action_samples := v_action_samples || jsonb_build_array(v_sample);
    END IF;
  END LOOP;

  UPDATE public.loc_bigtehn_ingest_state
     SET last_processed_signal_id = v_new_watermark,
         last_run_at = now(),
         last_run_summary = jsonb_build_object(
           'started_at',       v_started_at,
           'finished_at',      now(),
           'duration_seconds', EXTRACT(EPOCH FROM (now() - v_started_at))::numeric(10,3),
           'armed',            v_armed,
           'max_age_days',     p_max_age_days,
           'watermark_before', v_watermark,
           'watermark_after',  v_new_watermark,
           'processed_total',  v_count_total,
           'by_action', jsonb_build_object(
             'too_old',          v_count_too_old,
             'no_machine_loc',   v_count_no_machine_loc,
             'no_rn_in_cache',   v_count_no_rn_in_cache,
             'skip_already',     v_count_skip_already,
             'skip_zero_qty',    v_count_skip_zero_qty,
             'skip_bad_ident',   v_count_skip_bad_ident,
             'chain_transfer',   v_count_chain_transfer,
             'shelf_transfer',   v_count_shelf_transfer,
             'initial_placement', v_count_initial,
             'armed_executed',   v_count_armed_executed,
             'armed_errors',     v_count_armed_errors,
             'parser_fallback',  v_count_fallback_parser
           ),
           'samples', v_action_samples
         )
   WHERE worker_id = 'loc-bigtehn-ingest';

  PERFORM public.loc_sync_worker_heartbeat_upsert(
    'loc-bigtehn-ingest',
    jsonb_build_object(
      'mode',           CASE WHEN v_armed THEN 'armed' ELSE 'dry-run' END,
      'last_processed', v_count_total,
      'armed_executed', v_count_armed_executed,
      'armed_errors',   v_count_armed_errors,
      'parser_fallback', v_count_fallback_parser,
      'watermark',      v_new_watermark
    )
  );

  RETURN jsonb_build_object(
    'ok',             TRUE,
    'armed',          v_armed,
    'mode',           CASE WHEN v_armed THEN 'armed' ELSE 'dry-run' END,
    'processed',      v_count_total,
    'watermark',      v_new_watermark,
    'by_action', jsonb_build_object(
      'too_old',          v_count_too_old,
      'no_machine_loc',   v_count_no_machine_loc,
      'no_rn_in_cache',   v_count_no_rn_in_cache,
      'skip_already',     v_count_skip_already,
      'skip_zero_qty',    v_count_skip_zero_qty,
      'skip_bad_ident',   v_count_skip_bad_ident,
      'chain_transfer',   v_count_chain_transfer,
      'shelf_transfer',   v_count_shelf_transfer,
      'initial_placement', v_count_initial,
      'armed_executed',   v_count_armed_executed,
      'armed_errors',     v_count_armed_errors,
      'parser_fallback',  v_count_fallback_parser
    )
  );
EXCEPTION
  WHEN others THEN
    PERFORM public.loc_sync_worker_heartbeat_upsert(
      'loc-bigtehn-ingest',
      jsonb_build_object('mode','error','error', SQLERRM, 'sqlstate', SQLSTATE)
    );
    RETURN jsonb_build_object('ok', FALSE, 'error', SQLERRM, 'sqlstate', SQLSTATE);
END;
$function$
;

-- ============ loc_bigtehn_ingest_run_now ============
CREATE OR REPLACE FUNCTION public.loc_bigtehn_ingest_run_now()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'not_authenticated');
  END IF;
  IF NOT public.loc_is_admin() THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'not_admin');
  END IF;

  /* Default-i kao u pg_cron pozivu — 200 signala, 30 dana safety net. */
  v_result := public.loc_bigtehn_ingest_run();
  RETURN v_result;
EXCEPTION WHEN others THEN
  RETURN jsonb_build_object('ok', FALSE, 'error', 'exception', 'detail', SQLERRM);
END;
$function$
;

-- ============ loc_bigtehn_parse_ident ============
CREATE OR REPLACE FUNCTION public.loc_bigtehn_parse_ident(p_ident text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_ident        TEXT;
  v_parts        TEXT[];
  v_count        INT;
  v_idx          INT;
  v_predmet      TEXT;
  v_tp           TEXT;
  /* Pass 2 helpers */
  v_dash_pos     INT;
  v_base         TEXT;
  v_dash_suffix  TEXT;
  v_rest         TEXT;
BEGIN
  v_ident := NULLIF(trim(COALESCE(p_ident, '')), '');
  IF v_ident IS NULL THEN
    RETURN jsonb_build_object('predmet', NULL, 'tp', NULL);
  END IF;

  v_parts := string_to_array(v_ident, '/');
  v_count := COALESCE(array_length(v_parts, 1), 0);

  /* Single-segment ident (npr. „0000.0") — bad. */
  IF v_count < 2 THEN
    RETURN jsonb_build_object('predmet', NULL, 'tp', NULL);
  END IF;

  /* ── Pass 1: longest direct prefix match (hijerarhija „9400/1/165" itd.) */
  FOR v_idx IN REVERSE (v_count - 1)..1 LOOP
    v_predmet := array_to_string(v_parts[1:v_idx], '/');

    IF EXISTS (
      SELECT 1 FROM public.bigtehn_items_cache b
       WHERE b.broj_predmeta = v_predmet
         AND b.status = 'U TOKU'
         AND b.datum_zakljucenja IS NULL
       LIMIT 1
    ) THEN
      v_tp := array_to_string(v_parts[(v_idx + 1):v_count], '/');
      v_tp := NULLIF(trim(v_tp), '');
      IF v_tp IS NULL THEN
        CONTINUE;
      END IF;
      RETURN jsonb_build_object('predmet', v_predmet, 'tp', v_tp);
    END IF;
  END LOOP;

  /* ── Pass 2: dash u prvom segmentu (BigTehn revizija/sub-batch konvencija)
   * „9400-1/430" → base=„9400" (predmet ako aktivan), dash_suffix=„1",
   *                rest=„430" → tp=„1/430". */
  IF position('-' IN v_parts[1]) > 0 THEN
    v_dash_pos := position('-' IN v_parts[1]);
    v_base := substring(v_parts[1], 1, v_dash_pos - 1);
    v_dash_suffix := substring(v_parts[1], v_dash_pos + 1);

    IF length(trim(v_base)) > 0
       AND length(trim(v_dash_suffix)) > 0
       AND EXISTS (
         SELECT 1 FROM public.bigtehn_items_cache b
          WHERE b.broj_predmeta = v_base
            AND b.status = 'U TOKU'
            AND b.datum_zakljucenja IS NULL
          LIMIT 1
       )
    THEN
      /* Spoji dash_suffix sa ostatkom kao kosa-crta path. */
      v_rest := array_to_string(v_parts[2:v_count], '/');
      IF length(COALESCE(v_rest, '')) > 0 THEN
        v_tp := v_dash_suffix || '/' || v_rest;
      ELSE
        v_tp := v_dash_suffix;
      END IF;
      RETURN jsonb_build_object('predmet', v_base, 'tp', v_tp);
    END IF;
  END IF;

  /* ── Fallback: predmet = parts[1], tp = parts[2]. Ne čak ni „active" check
   * — to znači da je ident u sistemu ali predmet nije u kešu. Naša UI još
   * uvek može da matchuje placement na ovaj ključ. */
  v_predmet := v_parts[1];
  v_tp := NULLIF(trim(v_parts[2]), '');
  IF v_predmet IS NULL OR length(trim(v_predmet)) = 0 OR v_tp IS NULL THEN
    RETURN jsonb_build_object('predmet', NULL, 'tp', NULL);
  END IF;
  RETURN jsonb_build_object('predmet', v_predmet, 'tp', v_tp, 'fallback', TRUE);
END;
$function$
;

-- ============ loc_can_create_movement ============
CREATE OR REPLACE FUNCTION public.loc_can_create_movement()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_email TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN false;
  END IF;

  IF public.loc_auth_roles() && ARRAY[
    'admin', 'leadpm', 'pm', 'menadzment', 'magacioner'
  ]::text[] THEN
    RETURN true;
  END IF;

  v_email := lower(trim(coalesce(auth.jwt()->>'email', '')));
  IF v_email = '' THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
      FROM public.employees e
      LEFT JOIN public.sub_departments sd ON sd.id = e.sub_department_id
     WHERE e.is_active
       AND lower(coalesce(e.email, '')) = v_email
       AND (
         e.department_id IN (2, 3)
         OR sd.name = 'Magacin i logistika'
       )
  );
END;
$function$
;

-- ============ loc_can_manage_locations ============
CREATE OR REPLACE FUNCTION public.loc_can_manage_locations()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT public.loc_auth_roles() && ARRAY['admin', 'leadpm', 'pm', 'menadzment']::text[];
$function$
;

-- ============ loc_claim_sync_events ============
CREATE OR REPLACE FUNCTION public.loc_claim_sync_events(p_worker_id text, p_batch_size integer DEFAULT 10)
 RETURNS SETOF loc_sync_outbound_events
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_batch integer := GREATEST(1, LEAST(COALESCE(p_batch_size, 10), 100));
BEGIN
  IF p_worker_id IS NULL OR length(p_worker_id) = 0 THEN
    RAISE EXCEPTION 'worker_id is required';
  END IF;

  RETURN QUERY
  WITH candidate AS (
    SELECT id
      FROM public.loc_sync_outbound_events
     WHERE status IN ('PENDING', 'FAILED')
       AND (next_retry_at IS NULL OR next_retry_at <= now())
     ORDER BY created_at ASC
     LIMIT v_batch
     FOR UPDATE SKIP LOCKED
  ),
  claimed AS (
    UPDATE public.loc_sync_outbound_events e
       SET status           = 'IN_PROGRESS',
           locked_by_worker = p_worker_id,
           locked_at        = now(),
           attempts         = e.attempts + 1
      FROM candidate c
     WHERE e.id = c.id
     RETURNING e.*
  )
  SELECT * FROM claimed;
END;
$function$
;

-- ============ loc_create_movement ============
CREATE OR REPLACE FUNCTION public.loc_create_movement(payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid                uuid;
  v_client_event_uuid  uuid;
  v_existing_id        uuid;
  v_item_table         text;
  v_item_id            text;
  v_order              text;
  v_drawing            text;
  v_to                 uuid;
  v_from               uuid;
  v_mtype              public.loc_movement_type_enum;
  v_qty                numeric(12,3);
  v_avail              numeric(12,3);
  v_new_id             uuid;
  v_lock_key           bigint;
  v_return_unplaced    boolean;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated');
  END IF;

  IF NOT public.loc_can_create_movement() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authorized');
  END IF;

  BEGIN
    v_client_event_uuid := nullif(trim(payload->>'client_event_uuid'), '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_client_event_uuid');
  END;

  IF v_client_event_uuid IS NOT NULL THEN
    SELECT mv.id INTO v_existing_id
      FROM public.loc_location_movements mv
     WHERE mv.client_event_uuid = v_client_event_uuid
     LIMIT 1;

    IF v_existing_id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'ok', true,
        'id', v_existing_id,
        'idempotent', true
      );
    END IF;
  ELSE
    v_client_event_uuid := gen_random_uuid();
  END IF;

  v_item_table := nullif(trim(payload->>'item_ref_table'), '');
  v_item_id    := nullif(trim(payload->>'item_ref_id'), '');
  v_order      := COALESCE(trim(payload->>'order_no'), '');
  v_drawing    := COALESCE(trim(payload->>'drawing_no'), '');
  v_mtype      := (payload->>'movement_type')::public.loc_movement_type_enum;

  v_qty := coalesce((payload->>'quantity')::numeric, 1);
  IF v_qty IS NULL OR v_qty <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_quantity');
  END IF;

  IF char_length(v_order) > 40 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_order_no');
  END IF;
  IF char_length(v_drawing) > 40 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_drawing_no');
  END IF;

  IF payload ? 'to_location_id' AND nullif(trim(payload->>'to_location_id'), '') IS NOT NULL THEN
    v_to := (payload->>'to_location_id')::uuid;
  END IF;
  IF payload ? 'from_location_id' AND nullif(trim(payload->>'from_location_id'), '') IS NOT NULL THEN
    v_from := (payload->>'from_location_id')::uuid;
  END IF;

  v_return_unplaced := (v_mtype = 'CORRECTION' AND v_to IS NULL);

  IF v_item_table IS NULL OR v_item_id IS NULL OR v_mtype IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_fields');
  END IF;

  IF v_return_unplaced THEN
    IF v_from IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'error', 'missing_from_for_unplaced');
    END IF;
  ELSIF v_to IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_fields');
  ELSE
    IF NOT EXISTS (
      SELECT 1 FROM public.loc_locations loc_chk
      WHERE loc_chk.id = v_to AND loc_chk.is_active
    ) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'bad_to_location');
    END IF;

    IF EXISTS (
      WITH RECURSIVE anc(id, parent_id, is_active, depth) AS (
        SELECT l.id, l.parent_id, l.is_active, 0
          FROM public.loc_locations l
         WHERE l.id = v_to
        UNION ALL
        SELECT p.id, p.parent_id, p.is_active, a.depth + 1
          FROM public.loc_locations p
          JOIN anc a ON a.parent_id = p.id
         WHERE a.depth < 200
      )
      SELECT 1 FROM anc WHERE NOT is_active AND id <> v_to LIMIT 1
    ) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'parent_inactive');
    END IF;
  END IF;

  v_lock_key := hashtextextended(
    v_item_table || ':' || v_item_id || ':' || v_order,
    0
  );
  PERFORM pg_advisory_xact_lock(v_lock_key);

  IF v_mtype = 'INITIAL_PLACEMENT' THEN
    v_from := NULL;
  ELSIF v_mtype = 'INVENTORY_ADJUSTMENT' THEN
    v_from := NULL;
  ELSE
    IF v_from IS NULL AND NOT v_return_unplaced THEN
      DECLARE
        v_cnt integer;
      BEGIN
        v_cnt := (
          SELECT count(*)::int
            FROM public.loc_item_placements lp
           WHERE lp.item_ref_table = v_item_table
             AND lp.item_ref_id    = v_item_id
             AND lp.order_no       = v_order
        );
        IF v_cnt = 0 THEN
          RETURN jsonb_build_object('ok', false, 'error', 'no_current_placement');
        ELSIF v_cnt > 1 THEN
          RETURN jsonb_build_object('ok', false, 'error', 'from_ambiguous');
        END IF;
        v_from := (
          SELECT lp.location_id
            FROM public.loc_item_placements lp
           WHERE lp.item_ref_table = v_item_table
             AND lp.item_ref_id    = v_item_id
             AND lp.order_no       = v_order
           LIMIT 1
        );
      END;
    END IF;

    v_avail := (
      SELECT lp.quantity
        FROM public.loc_item_placements lp
       WHERE lp.item_ref_table = v_item_table
         AND lp.item_ref_id    = v_item_id
         AND lp.order_no       = v_order
         AND lp.location_id    = v_from
       LIMIT 1
    );

    IF v_avail IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'error', 'from_has_no_placement');
    END IF;
    IF v_qty > v_avail THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error', 'insufficient_quantity',
        'available', v_avail,
        'requested', v_qty
      );
    END IF;
  END IF;

  v_new_id := gen_random_uuid();

  BEGIN
    INSERT INTO public.loc_location_movements (
      id, item_ref_table, item_ref_id, order_no, drawing_no,
      from_location_id, to_location_id,
      movement_type, movement_reason, quantity, note,
      moved_at, moved_by, client_event_uuid
    ) VALUES (
      v_new_id,
      v_item_table,
      v_item_id,
      v_order,
      v_drawing,
      v_from,
      v_to,
      v_mtype,
      nullif(trim(payload->>'movement_reason'), ''),
      v_qty,
      nullif(trim(payload->>'note'), ''),
      coalesce((payload->>'moved_at')::timestamptz, now()),
      v_uid,
      v_client_event_uuid
    );
  EXCEPTION
    WHEN unique_violation THEN
      SELECT mv.id INTO v_existing_id
        FROM public.loc_location_movements mv
       WHERE mv.client_event_uuid = v_client_event_uuid
       LIMIT 1;
      IF v_existing_id IS NOT NULL THEN
        RETURN jsonb_build_object('ok', true, 'id', v_existing_id, 'idempotent', true);
      END IF;
      RETURN jsonb_build_object(
        'ok', false,
        'error', 'constraint_violation',
        'detail', SQLERRM
      );
    WHEN check_violation THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error', 'constraint_violation',
        'detail', SQLERRM
      );
    WHEN others THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error', 'exception',
        'detail', SQLERRM
      );
  END;

  RETURN jsonb_build_object('ok', true, 'id', v_new_id);
END;
$function$
;

-- ============ loc_get_bigtehn_ingest_status ============
CREATE OR REPLACE FUNCTION public.loc_get_bigtehn_ingest_status()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_state     RECORD;
  v_hb        RECORD;
  v_age_sec   NUMERIC;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'not_authenticated');
  END IF;
  IF NOT public.loc_is_admin() THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'not_admin');
  END IF;

  SELECT worker_id, last_processed_signal_id, armed, last_run_at,
         last_run_summary, created_at, updated_at
    INTO v_state
    FROM public.loc_bigtehn_ingest_state
   WHERE worker_id = 'loc-bigtehn-ingest'
   LIMIT 1;

  IF v_state.worker_id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', 'state_missing',
      'detail', 'loc_bigtehn_ingest_state nije seedovan — pokreni Faza 2A migraciju.'
    );
  END IF;

  /* Heartbeat row (opciono — može da nedostaje ako worker nikad nije pokrenut). */
  SELECT worker_id, last_seen, details
    INTO v_hb
    FROM public.loc_sync_worker_heartbeat
   WHERE worker_id = 'loc-bigtehn-ingest'
   LIMIT 1;

  IF v_hb.worker_id IS NOT NULL THEN
    v_age_sec := EXTRACT(EPOCH FROM (now() - v_hb.last_seen))::numeric(12,1);
  END IF;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'state', jsonb_build_object(
      'worker_id',              v_state.worker_id,
      'armed',                  v_state.armed,
      'watermark',              v_state.last_processed_signal_id,
      'last_run_at',            v_state.last_run_at,
      'last_run_summary',       v_state.last_run_summary,
      'updated_at',             v_state.updated_at
    ),
    'heartbeat', CASE
      WHEN v_hb.worker_id IS NULL THEN NULL
      ELSE jsonb_build_object(
        'last_seen',        v_hb.last_seen,
        'age_seconds',      v_age_sec,
        'is_alive',         (v_age_sec IS NOT NULL AND v_age_sec < 600),
        'details',          v_hb.details
      )
    END,
    'server_now', now()
  );
EXCEPTION WHEN others THEN
  RETURN jsonb_build_object('ok', FALSE, 'error', 'exception', 'detail', SQLERRM);
END;
$function$
;

-- ============ loc_get_bigtehn_op_status ============
CREATE OR REPLACE FUNCTION public.loc_get_bigtehn_op_status(p_work_order_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_wo jsonb;
  v_ops jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated');
  END IF;
  /* Isti role-check kao u ostalim Lokacije RPC-ima (loc_auth_roles vraća
   * lower-case array uloga; cardinality=0 znači da korisnik nema nijednu). */
  IF cardinality(public.loc_auth_roles()) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_role');
  END IF;
  IF p_work_order_id IS NULL OR p_work_order_id <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_work_order_id');
  END IF;

  /* Header iz bigtehn_work_orders_cache — koristi se za prikaz „TP 755, crtež
   * 1091063, 1500 kom" u modal headeru. */
  SELECT to_jsonb(wo) INTO v_wo
  FROM (
    SELECT
      id, ident_broj, broj_crteza, naziv_dela,
      materijal, dimenzija_materijala,
      komada AS komada_total, rok_izrade, status_rn
    FROM public.bigtehn_work_orders_cache
    WHERE id = p_work_order_id
  ) wo;

  IF v_wo IS NULL THEN
    /* RN ne postoji u keš-u (možda obrisan u BigTehn-u između sync-eva). */
    RETURN jsonb_build_object('ok', false, 'error', 'work_order_not_found');
  END IF;

  /* Lista operacija — sortirano po operacija (TEXT comparison, ali kako
   * BigTehn šalje cifre kao stringove tipa „010", „020", lex sort radi
   * očekivano u 95% slučajeva. Ako se kasnije ispostavi da neki klijent
   * koristi „10" / „2" / „100" → razmotri natural sort na klijentu). */
  SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.operation_code), '[]'::jsonb)
    INTO v_ops
  FROM (
    SELECT
      operation_code, operation_name, alat_pribor,
      original_machine_code, machine_code, machine_name, is_non_machining,
      tpz_min, tk_min,
      qty_finished, qty_in_process,
      real_seconds,
      first_started_at, last_started_at, last_finished_at,
      any_completed, prijava_count, operators, status
    FROM public.v_loc_tp_operation_slots
    WHERE work_order_id = p_work_order_id
  ) t;

  RETURN jsonb_build_object(
    'ok', true,
    'work_order', v_wo,
    'operations', COALESCE(v_ops, '[]'::jsonb)
  );
EXCEPTION
  WHEN others THEN
    RETURN jsonb_build_object('ok', false, 'error', 'exception', 'detail', SQLERRM);
END;
$function$
;

-- ============ loc_is_admin ============
CREATE OR REPLACE FUNCTION public.loc_is_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT public.loc_auth_roles() && ARRAY['admin']::text[];
$function$
;

-- ============ loc_locations_after_path_change ============
CREATE OR REPLACE FUNCTION public.loc_locations_after_path_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'auth', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.parent_id IS DISTINCT FROM OLD.parent_id OR NEW.name IS DISTINCT FROM OLD.name
  ) THEN
    PERFORM public.loc_recompute_descendants(NEW.id);
  END IF;
  RETURN NEW;
END;
$function$
;

-- ============ loc_locations_audit ============
CREATE OR REPLACE FUNCTION public.loc_locations_audit(p_limit integer DEFAULT 100)
 RETURNS TABLE(id bigint, record_id text, action text, actor_email text, actor_uid uuid, changed_at timestamp with time zone, old_data jsonb, new_data jsonb, diff_keys text[])
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    al.id,
    al.record_id,
    al.action,
    al.actor_email,
    al.actor_uid,
    al.changed_at,
    al.old_data,
    al.new_data,
    al.diff_keys
  FROM public.audit_log AS al
  WHERE al.table_name = 'loc_locations'
    AND public.loc_can_manage_locations()
  ORDER BY al.changed_at DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 300);
$function$
;

-- ============ loc_locations_enforce_business_hierarchy ============
CREATE OR REPLACE FUNCTION public.loc_locations_enforce_business_hierarchy()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_parent_type public.loc_type_enum;
BEGIN
  IF NEW.location_type = ANY (ARRAY['WAREHOUSE','PRODUCTION','ASSEMBLY','FIELD','TEMP']::public.loc_type_enum[]) THEN
    IF NEW.parent_id IS NOT NULL THEN
      RAISE EXCEPTION 'Hala (%) ne sme imati nadređenu lokaciju (parent_id mora biti NULL).', NEW.location_code
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.location_type = 'CAGE'::public.loc_type_enum THEN
    IF NEW.parent_id IS NULL THEN
      RETURN NEW;
    END IF;
    SELECT location_type INTO v_parent_type FROM public.loc_locations WHERE id = NEW.parent_id;
    IF v_parent_type IS NULL THEN
      RAISE EXCEPTION 'Roditeljska lokacija (%) ne postoji.', NEW.parent_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF NOT (v_parent_type = ANY (ARRAY['WAREHOUSE','PRODUCTION','ASSEMBLY','FIELD','TEMP']::public.loc_type_enum[])) THEN
      RAISE EXCEPTION 'Kavez (%) mora imati halu kao nadređenu lokaciju (dobijeno %).', NEW.location_code, v_parent_type
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.location_type = ANY (ARRAY['SHELF','RACK','BIN']::public.loc_type_enum[]) THEN
    IF NEW.parent_id IS NULL THEN
      RAISE EXCEPTION 'Polica (%) mora imati nadređenu halu (parent_id NOT NULL).', NEW.location_code
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT location_type INTO v_parent_type FROM public.loc_locations WHERE id = NEW.parent_id;
    IF v_parent_type IS NULL THEN
      RAISE EXCEPTION 'Roditeljska lokacija (%) ne postoji.', NEW.parent_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF NOT (v_parent_type = ANY (ARRAY['WAREHOUSE','PRODUCTION','ASSEMBLY','FIELD','TEMP']::public.loc_type_enum[])) THEN
      RAISE EXCEPTION 'Polica (%) mora imati halu kao nadređenu lokaciju (dobijeno %).', NEW.location_code, v_parent_type
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$function$
;

-- ============ loc_locations_guard_and_path ============
CREATE OR REPLACE FUNCTION public.loc_locations_guard_and_path()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'auth', 'pg_temp'
AS $function$
BEGIN
  IF NEW.parent_id IS NOT NULL THEN
    IF NEW.parent_id = NEW.id THEN
      RAISE EXCEPTION 'loc_locations: parent_id ne može biti isti kao id';
    END IF;
    IF EXISTS (
      WITH RECURSIVE ancestor_chain AS (
        SELECT loc_locations.id, loc_locations.parent_id, 1 AS lvl
        FROM public.loc_locations
        WHERE loc_locations.id = NEW.parent_id
        UNION ALL
        SELECT l.id, l.parent_id, ac.lvl + 1
        FROM public.loc_locations l
        INNER JOIN ancestor_chain ac ON l.id = ac.parent_id
        WHERE ac.lvl < 200
      )
      SELECT 1 FROM ancestor_chain WHERE ancestor_chain.id = NEW.id LIMIT 1
    ) THEN
      RAISE EXCEPTION 'loc_locations: ciklus u hijerarhiji';
    END IF;
  END IF;

  IF NEW.parent_id IS NULL THEN
    NEW.depth := 0;
    NEW.path_cached := NEW.name;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM public.loc_locations llx WHERE llx.id = NEW.parent_id) THEN
      RAISE EXCEPTION 'loc_locations: parent ne postoji';
    END IF;
    NEW.depth := (
      SELECT ll.depth + 1 FROM public.loc_locations AS ll WHERE ll.id = NEW.parent_id
    );
    NEW.path_cached := (
      SELECT ll.path_cached || ' ' || chr(8250) || ' ' || NEW.name
      FROM public.loc_locations AS ll WHERE ll.id = NEW.parent_id
    );
  END IF;
  RETURN NEW;
END;
$function$
;

-- ============ loc_mark_sync_failed ============
CREATE OR REPLACE FUNCTION public.loc_mark_sync_failed(p_event_id uuid, p_error text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_attempts integer;
  v_delay_min integer;
  v_final boolean;
  v_count integer;
BEGIN
  /* Napomena: umesto `SELECT ... INTO v_attempts` koristimo skalarni
   * subquery sa dodelom da izbegnemo SQL Editor parsere koji pogrešno
   * prepoznaju SELECT INTO kao DDL (u tom slučaju Postgres pokušava da
   * tretira v_attempts kao novu tabelu, što baca 42P01). */
  v_attempts := (
    SELECT attempts
      FROM public.loc_sync_outbound_events
     WHERE id = p_event_id
     LIMIT 1
  );

  IF v_attempts IS NULL THEN
    RETURN FALSE;
  END IF;

  /* Exponential backoff: 2, 4, 8, 16, 32, 64, 128, ... min (cap 360 = 6h).
   * Posle 10 pokusaja ide u DEAD_LETTER (rucna inspekcija). */
  v_delay_min := LEAST(360, POWER(2, LEAST(v_attempts, 8))::int);
  v_final := v_attempts >= 10;

  UPDATE public.loc_sync_outbound_events
     SET status           = CASE WHEN v_final THEN 'DEAD_LETTER' ELSE 'FAILED' END,
         last_error       = LEFT(COALESCE(p_error, ''), 4000),
         next_retry_at    = CASE WHEN v_final THEN NULL ELSE now() + make_interval(mins => v_delay_min) END,
         locked_by_worker = NULL,
         locked_at        = NULL
   WHERE id = p_event_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END;
$function$
;

-- ============ loc_mark_sync_synced ============
CREATE OR REPLACE FUNCTION public.loc_mark_sync_synced(p_event_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_count integer;
BEGIN
  UPDATE public.loc_sync_outbound_events
     SET status        = 'SYNCED',
         synced_at     = now(),
         last_error    = NULL,
         next_retry_at = NULL
   WHERE id = p_event_id
     AND status = 'IN_PROGRESS';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END;
$function$
;

-- ============ loc_move_cage ============
CREATE OR REPLACE FUNCTION public.loc_move_cage(p_cage_id uuid, p_new_hall_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_cage public.loc_locations;
  v_hall public.loc_locations;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated');
  END IF;

  IF NOT public.loc_can_manage_locations() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authorized');
  END IF;

  IF p_cage_id IS NULL OR p_new_hall_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_fields');
  END IF;

  SELECT * INTO v_cage FROM public.loc_locations WHERE id = p_cage_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'cage_not_found');
  END IF;
  IF v_cage.location_type <> 'CAGE'::public.loc_type_enum THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_a_cage');
  END IF;
  IF v_cage.is_active = false THEN
    RETURN jsonb_build_object('ok', false, 'error', 'cage_inactive');
  END IF;

  SELECT * INTO v_hall FROM public.loc_locations WHERE id = p_new_hall_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'hall_not_found');
  END IF;
  IF v_hall.location_type NOT IN ('WAREHOUSE'::public.loc_type_enum,'PRODUCTION'::public.loc_type_enum,
                                  'ASSEMBLY'::public.loc_type_enum,'FIELD'::public.loc_type_enum,
                                  'TEMP'::public.loc_type_enum) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'destination_not_hall');
  END IF;
  IF v_hall.is_active = false THEN
    RETURN jsonb_build_object('ok', false, 'error', 'hall_inactive');
  END IF;

  IF v_cage.parent_id = p_new_hall_id THEN
    RETURN jsonb_build_object('ok', true, 'unchanged', true, 'id', v_cage.id);
  END IF;

  IF p_reason IS NOT NULL THEN
    PERFORM set_config('app.audit_reason', p_reason, true);
  END IF;

  UPDATE public.loc_locations
     SET parent_id = p_new_hall_id,
         updated_at = NOW()
   WHERE id = p_cage_id;

  RETURN jsonb_build_object(
    'ok', true,
    'id', v_cage.id,
    'old_hall_id', v_cage.parent_id,
    'new_hall_id', p_new_hall_id
  );
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', 'exception', 'detail', SQLERRM);
END;
$function$
;

-- ============ loc_normalize_loc_movement_keys ============
CREATE OR REPLACE FUNCTION public.loc_normalize_loc_movement_keys(p_order text, p_item_ref text)
 RETURNS TABLE(out_order text, out_item_ref text)
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
DECLARE
  o text := nullif(trim(both FROM coalesce(p_order, '')), '');
  r text := nullif(trim(both FROM coalesce(p_item_ref, '')), '');
BEGIN
  IF o IS NULL THEN
    o := '';
  END IF;
  IF r IS NULL THEN
    r := '';
  END IF;
  IF o = '' OR r = '' THEN
    out_order := o;
    out_item_ref := r;
    RETURN NEXT;
    RETURN;
  END IF;

  IF o ~ '^9400-[0-9]+$' AND r ~ '^[0-9]+$' THEN
    out_order := '9400';
    out_item_ref := substring(o FROM '^9400-([0-9]+)$') || '/' || r;
    RETURN NEXT;
    RETURN;
  END IF;

  IF o = '9400' AND r ~ '^-?[0-9]+/[0-9]+$' THEN
    out_order := '9400';
    out_item_ref := regexp_replace(r, '^-', '');
    RETURN NEXT;
    RETURN;
  END IF;

  out_order := o;
  out_item_ref := r;
  RETURN NEXT;
END;
$function$
;

-- ============ loc_order_no_in_active_proj_mont ============
CREATE OR REPLACE FUNCTION public.loc_order_no_in_active_proj_mont(p_order_no text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'production', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM (
      SELECT NULLIF(trim(both ' ' FROM p_order_no), '') AS broj
      UNION ALL
      SELECT split_part(trim(both ' ' FROM p_order_no), '-', 1)
      WHERE trim(both ' ' FROM p_order_no) ~ '^[0-9]+-[0-9]+$'
    ) c
    INNER JOIN public.bigtehn_items_cache i ON i.broj_predmeta = c.broj
    INNER JOIN production.predmet_aktivacija pa ON pa.predmet_item_id = i.id
    WHERE c.broj IS NOT NULL
      AND pa.je_aktivan IS TRUE
      AND pa.je_projektovanje_montaza IS TRUE
  );
$function$
;

-- ============ loc_purge_synced_events ============
CREATE OR REPLACE FUNCTION public.loc_purge_synced_events(p_retention_days integer DEFAULT 90)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_deleted integer;
BEGIN
  IF NOT public.loc_is_admin() THEN
    RAISE EXCEPTION 'forbidden: only admin can purge sync events';
  END IF;

  IF p_retention_days IS NULL OR p_retention_days < 1 THEN
    RAISE EXCEPTION 'retention_days must be >= 1';
  END IF;

  v_deleted := (
    WITH d AS (
      DELETE FROM public.loc_sync_outbound_events
      WHERE status = 'SYNCED'
        AND synced_at IS NOT NULL
        AND synced_at < now() - make_interval(days => p_retention_days)
      RETURNING 1
    )
    SELECT COUNT(*) FROM d
  );

  RETURN v_deleted;
END;
$function$
;

-- ============ loc_recompute_descendants ============
CREATE OR REPLACE FUNCTION public.loc_recompute_descendants(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r RECORD;
BEGIN
  FOR r IN EXECUTE format(
    'SELECT id FROM public.loc_locations WHERE parent_id = %L::uuid',
    p_id
  ) LOOP
    UPDATE public.loc_locations AS l SET
      depth = (SELECT par.depth + 1 FROM public.loc_locations AS par WHERE par.id = l.parent_id),
      path_cached = (
        SELECT par.path_cached || ' ' || chr(8250) || ' ' || l.name
        FROM public.loc_locations AS par
        WHERE par.id = l.parent_id
      )
    WHERE l.id = r.id;
    PERFORM public.loc_recompute_descendants(r.id);
  END LOOP;
END;
$function$
;

-- ============ loc_report_parts_by_locations ============
CREATE OR REPLACE FUNCTION public.loc_report_parts_by_locations(p_drawing_no text DEFAULT NULL::text, p_order_no text DEFAULT NULL::text, p_tp_no text DEFAULT NULL::text, p_project_search text DEFAULT NULL::text, p_location_id uuid DEFAULT NULL::uuid, p_location_q text DEFAULT NULL::text, p_hall_id uuid DEFAULT NULL::uuid, p_location_kind text DEFAULT NULL::text, p_naziv_dela text DEFAULT NULL::text, p_sort text DEFAULT 'updated_at'::text, p_desc boolean DEFAULT true, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_lim int := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 500);
  v_off int := GREATEST(COALESCE(p_offset, 0), 0);
  v_sort text := lower(trim(COALESCE(p_sort, 'updated_at')));
  v_dir text := CASE WHEN COALESCE(p_desc, true) THEN 'DESC' ELSE 'ASC' END;
  v_kind text := lower(trim(COALESCE(p_location_kind, '')));
  res jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN '{"total":0,"rows":[]}'::jsonb;
  END IF;
  IF cardinality(public.loc_auth_roles()) = 0 THEN
    RETURN '{"total":0,"rows":[]}'::jsonb;
  END IF;

  IF v_kind NOT IN ('', 'shelf', 'cage') THEN
    v_kind := '';
  END IF;

  IF v_sort NOT IN (
    'updated_at',
    'drawing_no',
    'order_no',
    'location_code',
    'hall_code',
    'qty_on_location',
    'customer_name',
    'project_code',
    'item_ref_id',
    'rok_izrade'
  ) THEN
    v_sort := 'updated_at';
  END IF;

  EXECUTE format(
    $q$
    WITH base_placements AS (
      SELECT
        pl.id AS placement_id,
        pl.location_id,
        loc.location_code,
        loc.name AS location_name,
        loc.path_cached AS location_path,
        loc.capacity_note AS shelf_note,
        loc.location_type AS loc_type,
        loc.parent_id AS loc_parent_id,
        parent.location_code AS parent_code,
        parent.name AS parent_name,
        parent.location_type AS parent_type,
        pl.item_ref_table,
        pl.item_ref_id,
        pl.order_no,
        NULLIF(trim(pl.drawing_no), '') AS drawing_no,
        pl.quantity AS qty_on_location,
        pl.placement_status::text AS placement_status,
        pl.updated_at,
        lm.moved_at AS last_moved_at,
        NULLIF(trim(pl.order_no), '') AS ord_key,
        NULLIF(trim(pl.item_ref_id), '') AS tp_key,
        CASE
          WHEN loc.location_type::text IN ('WAREHOUSE', 'PRODUCTION', 'ASSEMBLY', 'FIELD', 'TEMP') THEN loc.id
          WHEN parent.location_type::text IN ('WAREHOUSE', 'PRODUCTION', 'ASSEMBLY', 'FIELD', 'TEMP') THEN parent.id
          ELSE NULL
        END AS hall_id,
        CASE
          WHEN loc.location_type::text IN ('WAREHOUSE', 'PRODUCTION', 'ASSEMBLY', 'FIELD', 'TEMP') THEN loc.location_code
          WHEN parent.location_type::text IN ('WAREHOUSE', 'PRODUCTION', 'ASSEMBLY', 'FIELD', 'TEMP') THEN parent.location_code
          ELSE NULL
        END AS hall_code,
        CASE
          WHEN loc.location_type::text IN ('WAREHOUSE', 'PRODUCTION', 'ASSEMBLY', 'FIELD', 'TEMP') THEN loc.name
          WHEN parent.location_type::text IN ('WAREHOUSE', 'PRODUCTION', 'ASSEMBLY', 'FIELD', 'TEMP') THEN parent.name
          ELSE NULL
        END AS hall_name,
        CASE
          WHEN loc.location_type::text IN ('SHELF', 'RACK', 'BIN')
               AND NOT (trim(loc.location_code) ~* '^KV [0-9]+$') THEN 'shelf'
          WHEN loc.location_type::text = 'CAGE'
               OR trim(loc.location_code) ~* '^KV [0-9]+$' THEN 'cage'
          WHEN loc.location_type::text IN ('WAREHOUSE', 'PRODUCTION', 'ASSEMBLY', 'FIELD', 'TEMP') THEN 'hall'
          WHEN loc.location_type::text = 'MACHINE' THEN 'machine'
          ELSE 'other'
        END AS location_kind
      FROM public.loc_item_placements pl
      INNER JOIN public.loc_locations loc ON loc.id = pl.location_id
      LEFT JOIN public.loc_locations parent ON parent.id = loc.parent_id
      LEFT JOIN public.loc_location_movements lm ON lm.id = pl.last_movement_id
      WHERE pl.quantity > 0
        AND pl.item_ref_table = 'bigtehn_rn'
    ),
    ident_candidates AS (
      SELECT bp.placement_id, bp.ord_key AS ident_cand, 0 AS match_rank
      FROM base_placements bp
      WHERE bp.ord_key IS NOT NULL AND bp.tp_key IS NULL
      UNION ALL
      SELECT bp.placement_id, bp.ord_key || '/' || bp.tp_key, 0
      FROM base_placements bp
      WHERE bp.ord_key IS NOT NULL AND bp.tp_key IS NOT NULL
      UNION ALL
      SELECT bp.placement_id, bp.ord_key || '-' || bp.tp_key, 0
      FROM base_placements bp
      WHERE bp.ord_key = '9400' AND bp.tp_key ~ '^[0-9]+/[0-9]+$'
      UNION ALL
      SELECT bp.placement_id, bp.ord_key || bp.tp_key, 0
      FROM base_placements bp
      WHERE bp.tp_key ~ '^-[0-9]+/[0-9]+$'
    ),
    exact_wo AS (
      SELECT DISTINCT ON (c.placement_id)
        c.placement_id,
        w.id,
        w.ident_broj,
        w.broj_crteza,
        w.naziv_dela,
        w.materijal,
        w.dimenzija_materijala,
        w.jedinica_mere,
        w.komada,
        w.tezina_neobr,
        w.tezina_obr,
        w.status_rn,
        w.revizija,
        w.rok_izrade,
        w.customer_id
      FROM ident_candidates c
      INNER JOIN public.bigtehn_work_orders_cache w ON w.ident_broj = c.ident_cand
      ORDER BY c.placement_id, c.match_rank, length(w.ident_broj), w.id
    ),
    need_fuzzy AS (
      SELECT bp.*
      FROM base_placements bp
      LEFT JOIN exact_wo e ON e.placement_id = bp.placement_id
      WHERE e.id IS NULL
        AND bp.ord_key IS NOT NULL
        AND bp.tp_key IS NOT NULL
    ),
    wo_parsed AS (
      SELECT
        w.id,
        w.ident_broj,
        w.broj_crteza,
        w.naziv_dela,
        w.materijal,
        w.dimenzija_materijala,
        w.jedinica_mere,
        w.komada,
        w.tezina_neobr,
        w.tezina_obr,
        w.status_rn,
        w.revizija,
        w.rok_izrade,
        w.customer_id,
        split_part(w.ident_broj, '/', 2) AS tp_part,
        split_part(split_part(w.ident_broj, '/', 1), '-', 1) AS ord_root
      FROM public.bigtehn_work_orders_cache w
      WHERE position('/' IN w.ident_broj) > 0
    ),
    fuzzy_ranked AS (
      SELECT
        nf.placement_id,
        wp.id,
        wp.ident_broj,
        wp.broj_crteza,
        wp.naziv_dela,
        wp.materijal,
        wp.dimenzija_materijala,
        wp.jedinica_mere,
        wp.komada,
        wp.tezina_neobr,
        wp.tezina_obr,
        wp.status_rn,
        wp.revizija,
        wp.rok_izrade,
        wp.customer_id,
        COUNT(*) OVER (PARTITION BY nf.placement_id) AS match_cnt,
        ROW_NUMBER() OVER (
          PARTITION BY nf.placement_id
          ORDER BY length(wp.ident_broj), wp.id
        ) AS pick_rn
      FROM need_fuzzy nf
      INNER JOIN wo_parsed wp
        ON wp.tp_part = nf.tp_key AND wp.ord_root = nf.ord_key
      WHERE NOT EXISTS (
        SELECT 1
        FROM public.bigtehn_work_orders_cache e
        WHERE e.ident_broj = nf.ord_key || '/' || nf.tp_key
           OR (
             nf.ord_key = '9400'
             AND nf.tp_key ~ '^[0-9]+/[0-9]+$'
             AND e.ident_broj = nf.ord_key || '-' || nf.tp_key
           )
           OR (
             nf.tp_key ~ '^-[0-9]+/[0-9]+$'
             AND e.ident_broj = nf.ord_key || nf.tp_key
           )
      )
    ),
    fuzzy_wo AS (
      SELECT
        placement_id,
        id,
        ident_broj,
        broj_crteza,
        naziv_dela,
        materijal,
        dimenzija_materijala,
        jedinica_mere,
        komada,
        tezina_neobr,
        tezina_obr,
        status_rn,
        revizija,
        rok_izrade,
        customer_id
      FROM fuzzy_ranked
      WHERE match_cnt = 1 AND pick_rn = 1
    ),
    wo_match AS (
      SELECT * FROM exact_wo
      UNION ALL
      SELECT * FROM fuzzy_wo
    ),
    placed AS (
      SELECT
        bp.placement_id,
        bp.location_id,
        bp.location_code,
        bp.location_name,
        bp.location_path,
        bp.shelf_note,
        bp.hall_id,
        bp.hall_code,
        bp.hall_name,
        bp.location_kind,
        bp.item_ref_table,
        bp.item_ref_id,
        bp.order_no,
        bp.drawing_no,
        bp.qty_on_location,
        bp.placement_status,
        bp.updated_at,
        bp.last_moved_at,
        wo.id AS work_order_id,
        wo.ident_broj AS wo_ident_broj,
        wo.broj_crteza AS wo_broj_crteza,
        wo.naziv_dela AS naziv_dela,
        wo.materijal AS materijal,
        wo.dimenzija_materijala AS dimenzija_materijala,
        wo.jedinica_mere AS jedinica_mere,
        wo.komada AS komada_rn,
        wo.tezina_neobr AS tezina_neobr,
        wo.tezina_obr AS tezina_obr,
        wo.status_rn AS status_rn,
        wo.revizija AS revizija,
        wo.rok_izrade AS rok_izrade,
        c.name AS customer_name,
        pr.project_code,
        pr.project_name,
        SUM(bp.qty_on_location) OVER (
          PARTITION BY bp.order_no,
            COALESCE(bp.drawing_no, NULLIF(trim(bp.item_ref_id), ''), '')
        ) AS qty_total_for_bucket
      FROM base_placements bp
      LEFT JOIN wo_match wo ON wo.placement_id = bp.placement_id
      LEFT JOIN public.bigtehn_customers_cache c ON c.id = wo.customer_id
      LEFT JOIN public.projekt_bigtehn_rn pbr
        ON wo.id IS NOT NULL AND pbr.bigtehn_rn_id = wo.id
      LEFT JOIN public.projects pr ON pr.id = pbr.projekat_id
    ),
    filt AS (
      SELECT * FROM placed p
      WHERE ($1 IS NULL OR trim($1) = '' OR COALESCE(p.drawing_no::text, '') ILIKE '%%' || trim($1) || '%%'
            OR p.item_ref_id ILIKE '%%' || trim($1) || '%%'
            OR COALESCE(p.wo_broj_crteza, '') ILIKE '%%' || trim($1) || '%%')
        AND ($2 IS NULL OR trim($2) = '' OR trim(COALESCE(p.order_no, '')) = trim($2)
            OR COALESCE(p.wo_ident_broj, '') ILIKE '%%' || trim($2) || '%%')
        AND ($3 IS NULL OR trim($3) = '' OR trim(COALESCE(p.item_ref_id, '')) = trim($3))
        AND ($4::uuid IS NULL OR p.location_id = $4::uuid)
        AND ($5 IS NULL OR trim($5) = '' OR p.location_code ILIKE '%%' || trim($5) || '%%'
            OR p.location_name ILIKE '%%' || trim($5) || '%%')
        AND (
          $6 IS NULL OR trim($6) = ''
          OR COALESCE(p.project_code, '') ILIKE '%%' || trim($6) || '%%'
          OR COALESCE(p.project_name, '') ILIKE '%%' || trim($6) || '%%'
        )
        AND ($7::uuid IS NULL OR p.hall_id = $7::uuid)
        AND ($8 IS NULL OR trim($8) = '' OR p.location_kind = trim($8))
        AND ($9 IS NULL OR trim($9) = '' OR COALESCE(p.naziv_dela, '') ILIKE '%%' || trim($9) || '%%')
    )
    SELECT jsonb_build_object(
      'total', (SELECT COUNT(*)::bigint FROM filt),
      'rows', COALESCE((
        SELECT jsonb_agg(to_jsonb(t))
        FROM (
          SELECT * FROM filt
          ORDER BY %I %s NULLS LAST, placement_id ASC
          LIMIT %s OFFSET %s
        ) t
      ), '[]'::jsonb)
    )
    $q$,
    v_sort,
    v_dir,
    v_lim,
    v_off
  )
  INTO res
  USING
    p_drawing_no,
    p_order_no,
    p_tp_no,
    p_location_id,
    p_location_q,
    p_project_search,
    p_hall_id,
    v_kind,
    p_naziv_dela;

  RETURN COALESCE(res, '{"total":0,"rows":[]}'::jsonb);
END;
$function$
;

-- ============ loc_report_suggest_naziv_dela ============
CREATE OR REPLACE FUNCTION public.loc_report_suggest_naziv_dela(p_q text DEFAULT NULL::text, p_limit integer DEFAULT 15)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_q text := trim(COALESCE(p_q, ''));
  v_lim int := LEAST(GREATEST(COALESCE(p_limit, 15), 1), 30);
  res jsonb;
BEGIN
  IF auth.uid() IS NULL OR cardinality(public.loc_auth_roles()) = 0 THEN
    RETURN '[]'::jsonb;
  END IF;
  IF length(v_q) < 2 THEN
    RETURN '[]'::jsonb;
  END IF;

  WITH base_placements AS (
    SELECT
      pl.id AS placement_id,
      NULLIF(trim(pl.order_no), '') AS ord_key,
      NULLIF(trim(pl.item_ref_id), '') AS tp_key
    FROM public.loc_item_placements pl
    WHERE pl.quantity > 0
      AND pl.item_ref_table = 'bigtehn_rn'
  ),
  ident_candidates AS (
    SELECT bp.placement_id, bp.ord_key AS ident_cand
    FROM base_placements bp
    WHERE bp.ord_key IS NOT NULL AND bp.tp_key IS NULL
    UNION ALL
    SELECT bp.placement_id, bp.ord_key || '/' || bp.tp_key
    FROM base_placements bp
    WHERE bp.ord_key IS NOT NULL AND bp.tp_key IS NOT NULL
    UNION ALL
    SELECT bp.placement_id, bp.ord_key || '-' || bp.tp_key
    FROM base_placements bp
    WHERE bp.ord_key = '9400' AND bp.tp_key ~ '^[0-9]+/[0-9]+$'
    UNION ALL
    SELECT bp.placement_id, bp.ord_key || bp.tp_key
    FROM base_placements bp
    WHERE bp.tp_key ~ '^-[0-9]+/[0-9]+$'
  ),
  wo_match AS (
    SELECT DISTINCT ON (c.placement_id)
      c.placement_id,
      NULLIF(trim(w.naziv_dela), '') AS naziv_dela,
      NULLIF(trim(w.broj_crteza), '') AS broj_crteza
    FROM ident_candidates c
    INNER JOIN public.bigtehn_work_orders_cache w ON w.ident_broj = c.ident_cand
    ORDER BY c.placement_id, length(w.ident_broj), w.id
  ),
  grouped AS (
    SELECT
      wm.naziv_dela,
      wm.broj_crteza,
      COUNT(*)::int AS placement_count
    FROM wo_match wm
    WHERE wm.naziv_dela IS NOT NULL
      AND wm.naziv_dela ILIKE '%' || v_q || '%'
    GROUP BY wm.naziv_dela, wm.broj_crteza
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
  INTO res
  FROM (
    SELECT naziv_dela, broj_crteza, placement_count
    FROM grouped
    ORDER BY placement_count DESC, naziv_dela ASC, broj_crteza ASC NULLS LAST
    LIMIT v_lim
  ) t;

  RETURN COALESCE(res, '[]'::jsonb);
END;
$function$
;

-- ============ loc_sync_admin_emails ============
CREATE OR REPLACE FUNCTION public.loc_sync_admin_emails()
 RETURNS text[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT coalesce(
    array_agg(DISTINCT lower(trim(ur.email))) FILTER (
      WHERE ur.email IS NOT NULL AND ur.email <> ''
    ),
    ARRAY[]::text[]
  )
  FROM public.user_roles ur
  WHERE ur.is_active = true
    AND lower(ur.role::text) IN ('admin', 'menadzment');
$function$
;

-- ============ loc_sync_dispatch_dequeue ============
CREATE OR REPLACE FUNCTION public.loc_sync_dispatch_dequeue(p_batch integer DEFAULT 25)
 RETURNS SETOF loc_sync_alerts_outbox
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_batch INT := GREATEST(1, LEAST(COALESCE(p_batch, 25), 100));
BEGIN
  RETURN QUERY
  WITH candidate AS (
    SELECT id
      FROM public.loc_sync_alerts_outbox
     WHERE status IN ('queued', 'failed')
       AND next_attempt_at <= now()
       AND attempts < max_attempts
     ORDER BY next_attempt_at ASC
     LIMIT v_batch
     FOR UPDATE SKIP LOCKED
  ),
  locked AS (
    UPDATE public.loc_sync_alerts_outbox o
       SET last_attempt_at = now(),
           attempts        = o.attempts + 1
      FROM candidate c
     WHERE o.id = c.id
     RETURNING o.*
  )
  SELECT * FROM locked;
END;
$function$
;

-- ============ loc_sync_dispatch_mark_failed ============
CREATE OR REPLACE FUNCTION public.loc_sync_dispatch_mark_failed(p_id uuid, p_error text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_attempts  INT;
  v_max       INT;
  v_count     INT;
  v_delay_min INT;
  v_final     BOOLEAN;
BEGIN
  SELECT attempts, max_attempts INTO v_attempts, v_max
    FROM public.loc_sync_alerts_outbox WHERE id = p_id;
  IF v_attempts IS NULL THEN RETURN false; END IF;

  v_delay_min := LEAST(360, POWER(2, LEAST(v_attempts, 8))::int);
  v_final := v_attempts >= COALESCE(v_max, 5);

  UPDATE public.loc_sync_alerts_outbox
     SET status        = CASE WHEN v_final THEN 'skipped' ELSE 'failed' END,
         error         = LEFT(COALESCE(p_error, ''), 4000),
         next_attempt_at = CASE WHEN v_final THEN now() ELSE now() + make_interval(mins => v_delay_min) END
   WHERE id = p_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END;
$function$
;

-- ============ loc_sync_dispatch_mark_sent ============
CREATE OR REPLACE FUNCTION public.loc_sync_dispatch_mark_sent(p_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_count INT;
BEGIN
  UPDATE public.loc_sync_alerts_outbox
     SET status = 'sent', sent_at = now(), error = NULL
   WHERE id = p_id AND status IN ('queued', 'failed');
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END;
$function$
;

-- ============ loc_sync_health_check_and_enqueue ============
CREATE OR REPLACE FUNCTION public.loc_sync_health_check_and_enqueue()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_admins        TEXT[];
  v_email         TEXT;
  v_today         TEXT := to_char(now(), 'YYYY-MM-DD');
  v_dead_count    BIGINT;
  v_dead_dedup    TEXT;
  v_inserted      INT := 0;
  v_worker        RECORD;
  v_w_dedup       TEXT;
BEGIN
  v_admins := public.loc_sync_admin_emails();
  IF cardinality(v_admins) = 0 THEN
    RETURN jsonb_build_object('skipped', 'no_admin_emails');
  END IF;

  /* (a) DEAD_LETTER digest — enqueue jednom dnevno ako ima stavki. */
  v_dead_count := (
    SELECT count(*) FROM public.loc_sync_outbound_events WHERE status = 'DEAD_LETTER'
  );

  IF v_dead_count > 0 THEN
    v_dead_dedup := 'dead_letter_digest:' || v_today;
    FOREACH v_email IN ARRAY v_admins LOOP
      INSERT INTO public.loc_sync_alerts_outbox (
        kind, dedup_key, recipient_email, subject, body_text, payload
      ) VALUES (
        'dead_letter_digest',
        v_dead_dedup,
        v_email,
        format('[Servoteh / Lokacije] %s sync događaja u DEAD_LETTER', v_dead_count),
        format(
          'U sync queue-u (loc_sync_outbound_events) trenutno ima %s događaja u stanju DEAD_LETTER. '
          'Ova premeštanja NISU stigla do MSSQL-a posle 10 pokušaja worker-a. '
          'Otvori Supabase Studio i pregledaj redove gde je status = DEAD_LETTER.',
          v_dead_count
        ),
        jsonb_build_object('dead_letter_count', v_dead_count, 'date', v_today)
      )
      ON CONFLICT (dedup_key, recipient_email) DO NOTHING;
      IF FOUND THEN v_inserted := v_inserted + 1; END IF;
    END LOOP;
  END IF;

  /* (b) Worker down — last_seen stariji od 10 min, enqueue jednom po danu po
   * worker_id, da admin ne bude spamovan svaki sat dok je worker stopiran. */
  FOR v_worker IN
    SELECT h.worker_id, h.last_seen
      FROM public.loc_sync_worker_heartbeat h
     WHERE (now() - h.last_seen) > interval '10 minutes'
  LOOP
    v_w_dedup := 'worker_down:' || v_worker.worker_id || ':' || v_today;
    FOREACH v_email IN ARRAY v_admins LOOP
      INSERT INTO public.loc_sync_alerts_outbox (
        kind, dedup_key, recipient_email, subject, body_text, payload
      ) VALUES (
        'worker_down',
        v_w_dedup,
        v_email,
        format('[Servoteh / Lokacije] Worker "%s" ne odgovara', v_worker.worker_id),
        format(
          'Worker "%s" nije poslao heartbeat od %s. '
          'Sve premeštanja se i dalje beleže u Supabase, ali NE idu MSSQL strani '
          'dok se worker ne restartuje.',
          v_worker.worker_id,
          to_char(v_worker.last_seen, 'YYYY-MM-DD HH24:MI:SS TZ')
        ),
        jsonb_build_object('worker_id', v_worker.worker_id, 'last_seen', v_worker.last_seen)
      )
      ON CONFLICT (dedup_key, recipient_email) DO NOTHING;
      IF FOUND THEN v_inserted := v_inserted + 1; END IF;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object(
    'dead_letter_count', v_dead_count,
    'alerts_enqueued', v_inserted,
    'admin_count', cardinality(v_admins)
  );
END;
$function$
;

-- ============ loc_sync_health_summary ============
CREATE OR REPLACE FUNCTION public.loc_sync_health_summary()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_dead_letter_count BIGINT;
  v_workers           JSONB;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('dead_letter_count', 0, 'workers', '[]'::jsonb);
  END IF;

  v_dead_letter_count := (
    SELECT count(*)
      FROM public.loc_sync_outbound_events
     WHERE status = 'DEAD_LETTER'
  );

  v_workers := coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'worker_id', h.worker_id,
      'last_seen', h.last_seen,
      'age_seconds', extract(epoch from (now() - h.last_seen))::int,
      'is_alive', (now() - h.last_seen) < interval '10 minutes',
      'details', h.details
    ) ORDER BY h.worker_id)
    FROM public.loc_sync_worker_heartbeat h
  ), '[]'::jsonb);

  RETURN jsonb_build_object(
    'dead_letter_count', v_dead_letter_count,
    'workers', v_workers
  );
END;
$function$
;

-- ============ loc_sync_pulse_monitor_dispatch ============
CREATE OR REPLACE FUNCTION public.loc_sync_pulse_monitor_dispatch()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'vault', 'net'
AS $function$
DECLARE
  v_url             TEXT;
  v_bearer          TEXT;
  v_headers         jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    RETURN;
  END IF;

  SELECT NULLIF(btrim(ds.decrypted_secret), '')
    INTO v_url
    FROM vault.decrypted_secrets ds
   WHERE ds.name = 'loc_sync_monitor_dispatch_url'
   LIMIT 1;

  IF v_url IS NULL THEN
    RETURN;
  END IF;

  SELECT btrim(ds.decrypted_secret)
    INTO v_bearer
    FROM vault.decrypted_secrets ds
   WHERE ds.name = 'loc_sync_monitor_dispatch_bearer'
   LIMIT 1;

  IF v_bearer IS NOT NULL AND length(v_bearer) > 0 THEN
    IF strpos(lower(v_bearer), 'bearer ') = 1 THEN
      v_headers := jsonb_build_object(
        'Authorization', v_bearer,
        'Content-Type', 'application/json'
      );
    ELSE
      v_headers := jsonb_build_object(
        'Authorization', 'Bearer ' || v_bearer,
        'Content-Type', 'application/json'
      );
    END IF;
  ELSE
    v_headers := jsonb_build_object('Content-Type', 'application/json');
  END IF;

  PERFORM net.http_post(
    url     := v_url,
    headers := v_headers,
    body    := '{}'::jsonb
  );
END;
$function$
;

-- ============ loc_sync_worker_heartbeat_upsert ============
CREATE OR REPLACE FUNCTION public.loc_sync_worker_heartbeat_upsert(p_worker_id text, p_details jsonb DEFAULT NULL::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF p_worker_id IS NULL OR length(trim(p_worker_id)) = 0 THEN
    RAISE EXCEPTION 'worker_id is required';
  END IF;

  INSERT INTO public.loc_sync_worker_heartbeat (worker_id, last_seen, details)
  VALUES (trim(p_worker_id), now(), p_details)
  ON CONFLICT (worker_id) DO UPDATE
     SET last_seen = excluded.last_seen,
         details   = excluded.details;
END;
$function$
;

-- ============ loc_touch_updated_at ============
CREATE OR REPLACE FUNCTION public.loc_touch_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'auth', 'pg_temp'
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$
;

-- ============ loc_tps_for_predmet ============
CREATE OR REPLACE FUNCTION public.loc_tps_for_predmet(p_item_id bigint, p_only_open boolean DEFAULT true, p_include_assembled boolean DEFAULT false, p_tp_no text DEFAULT NULL::text, p_drawing_no text DEFAULT NULL::text, p_location_filter text DEFAULT NULL::text, p_limit integer DEFAULT 200, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_lim int := LEAST(GREATEST(COALESCE(p_limit, 200), 1), 1000);
  v_off int := GREATEST(COALESCE(p_offset, 0), 0);
  v_loc_filter text := LOWER(NULLIF(TRIM(COALESCE(p_location_filter, '')), ''));
  v_tp text := NULLIF(TRIM(COALESCE(p_tp_no, '')), '');
  v_dr text := NULLIF(TRIM(COALESCE(p_drawing_no, '')), '');
  res jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN '{"total":0,"rows":[]}'::jsonb;
  END IF;
  IF cardinality(public.loc_auth_roles()) = 0 THEN
    RETURN '{"total":0,"rows":[]}'::jsonb;
  END IF;
  IF p_item_id IS NULL THEN
    RETURN '{"total":0,"rows":[]}'::jsonb;
  END IF;
  IF v_loc_filter IS NOT NULL AND v_loc_filter NOT IN ('all', 'with', 'without') THEN
    v_loc_filter := NULL;
  END IF;

  WITH wos AS (
    SELECT
      w.id            AS work_order_id,
      w.item_id       AS item_id,
      w.ident_broj    AS wo_ident_broj,
      w.broj_crteza   AS wo_broj_crteza,
      w.naziv_dela    AS naziv_dela,
      w.materijal     AS materijal,
      w.dimenzija_materijala AS dimenzija_materijala,
      w.jedinica_mere AS jedinica_mere,
      w.komada        AS komada_rn,
      w.tezina_neobr  AS tezina_neobr,
      w.tezina_obr    AS tezina_obr,
      w.status_rn     AS status_rn,
      w.is_mes_active AS is_mes_active,
      w.zakljucano    AS zakljucano,
      w.revizija      AS revizija,
      w.rok_izrade    AS rok_izrade,
      w.modified_at   AS wo_modified_at,
      split_part(w.ident_broj, '/', 1) AS predmet_no,
      NULLIF(split_part(w.ident_broj, '/', 2), '') AS tp_no
    FROM public.v_active_bigtehn_work_orders w
    WHERE w.item_id = p_item_id
      AND w.is_mes_active IS TRUE
      AND (v_tp IS NULL OR NULLIF(split_part(w.ident_broj, '/', 2), '') ILIKE v_tp || '%')
      AND (v_dr IS NULL OR w.broj_crteza ILIKE v_dr || '%')
  ),
  draw_idx AS (
    SELECT DISTINCT d.drawing_no
    FROM public.bigtehn_drawings_cache d
    WHERE d.removed_at IS NULL
      AND d.storage_path IS NOT NULL
      AND d.drawing_no IN (SELECT DISTINCT wo.wo_broj_crteza FROM wos wo WHERE wo.wo_broj_crteza IS NOT NULL)
  ),
  placements AS (
    SELECT
      wo.work_order_id,
      pl.id            AS placement_id,
      pl.location_id   AS location_id,
      loc.location_code AS location_code,
      loc.name         AS location_name,
      loc.path_cached  AS location_path,
      loc.location_type AS location_type,
      loc.capacity_note AS shelf_note,
      pl.quantity      AS qty_on_location,
      pl.placement_status::text AS placement_status,
      pl.updated_at    AS placement_updated_at,
      pl.order_no      AS placement_order_no,
      pl.item_ref_id   AS placement_item_ref_id,
      pl.drawing_no    AS placement_drawing_no
    FROM wos wo
    LEFT JOIN public.loc_item_placements pl
      ON pl.quantity > 0
     AND (
       (pl.order_no = wo.predmet_no AND pl.item_ref_id = wo.tp_no)
       OR (pl.drawing_no IS NOT NULL AND wo.wo_broj_crteza IS NOT NULL
           AND trim(pl.drawing_no) = trim(wo.wo_broj_crteza))
     )
    LEFT JOIN public.loc_locations loc ON loc.id = pl.location_id
  ),
  wo_state AS (
    SELECT
      wo.work_order_id,
      COUNT(p.placement_id) FILTER (WHERE p.placement_id IS NOT NULL) AS placements_total,
      COUNT(p.placement_id) FILTER (
        WHERE p.placement_id IS NOT NULL
          AND COALESCE(p.location_type, 'SHELF') NOT IN ('ASSEMBLY', 'SCRAPPED')
      ) AS placements_active
    FROM wos wo
    LEFT JOIN placements p ON p.work_order_id = wo.work_order_id
    GROUP BY wo.work_order_id
  ),
  joined AS (
    SELECT
      wo.work_order_id,
      wo.wo_ident_broj,
      wo.wo_broj_crteza,
      wo.naziv_dela,
      wo.materijal,
      wo.dimenzija_materijala,
      wo.jedinica_mere,
      wo.komada_rn,
      wo.tezina_neobr,
      wo.tezina_obr,
      wo.status_rn,
      wo.is_mes_active,
      wo.zakljucano,
      wo.revizija,
      wo.rok_izrade,
      wo.wo_modified_at,
      wo.predmet_no,
      wo.tp_no,
      (di.drawing_no IS NOT NULL) AS has_pdf,
      st.placements_total,
      st.placements_active,
      p.placement_id,
      p.location_id,
      p.location_code,
      p.location_name,
      p.location_path,
      p.location_type,
      p.shelf_note,
      p.qty_on_location,
      p.placement_status,
      p.placement_updated_at,
      SUM(COALESCE(p.qty_on_location, 0)) OVER (PARTITION BY wo.work_order_id) AS qty_total_placed
    FROM wos wo
    LEFT JOIN placements p ON p.work_order_id = wo.work_order_id
    LEFT JOIN wo_state st ON st.work_order_id = wo.work_order_id
    LEFT JOIN draw_idx di ON di.drawing_no = wo.wo_broj_crteza
  ),
  filt AS (
    SELECT *
    FROM joined j
    WHERE
      (
        p_include_assembled
        OR j.placements_total = 0
        OR j.placements_active > 0
      )
      AND (
        p_include_assembled
        OR j.placement_id IS NULL
        OR COALESCE(j.location_type, 'SHELF') NOT IN ('ASSEMBLY', 'SCRAPPED')
      )
      AND (
        v_loc_filter IS NULL OR v_loc_filter = 'all'
        OR (v_loc_filter = 'with'    AND j.placement_id IS NOT NULL)
        OR (v_loc_filter = 'without' AND j.placement_id IS NULL)
      )
  )
  SELECT jsonb_build_object(
    'total', (SELECT COUNT(*)::bigint FROM filt),
    'rows', COALESCE((
      SELECT jsonb_agg(to_jsonb(t))
      FROM (
        SELECT * FROM filt
        ORDER BY
          wo_ident_broj ASC,
          location_code NULLS LAST,
          placement_id NULLS FIRST
        LIMIT v_lim OFFSET v_off
      ) t
    ), '[]'::jsonb)
  )
  INTO res;

  RETURN COALESCE(res, '{"total":0,"rows":[]}'::jsonb);
END;
$function$
;

