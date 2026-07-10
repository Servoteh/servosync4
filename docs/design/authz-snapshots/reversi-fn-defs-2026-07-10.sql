-- AUTHZ/RPC SNAPSHOT: Reversi (rev_*) — snimljeno 2026-07-10
-- Izvor: zamrznuti Supabase cloud (read-only) = restore-izvor sy15 baze (cutover 1.5, noc 09->10.07).
-- Pre implementacije RE-VERIFIKOVATI na zivoj sy15 bazi (ssh ubuntusrv je bio nedostupan 10.07).
-- Sadrzaj: pune definicije svih 23 rev_* funkcija (pg_get_functiondef).

-- ============ rev_add_inventory_subgroup ============
CREATE OR REPLACE FUNCTION public.rev_add_inventory_subgroup(p_group_code text, p_label text, p_napomena text DEFAULT NULL::text)
 RETURNS rev_inventory_subgroups
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_group_id uuid; v_code text; v_row public.rev_inventory_subgroups;
BEGIN
  IF NOT public.rev_can_manage() THEN RAISE EXCEPTION 'Nemate pravo da dodajete podgrupe.' USING ERRCODE = '42501'; END IF;
  IF coalesce(btrim(p_group_code), '') = '' OR coalesce(btrim(p_label), '') = '' THEN RAISE EXCEPTION 'Grupa i naziv podgrupe su obavezni.' USING ERRCODE = '22023'; END IF;
  SELECT id INTO v_group_id FROM public.rev_inventory_groups WHERE code = upper(btrim(p_group_code));
  IF v_group_id IS NULL THEN RAISE EXCEPTION 'Grupa % ne postoji.', p_group_code USING ERRCODE = '23503'; END IF;
  v_code := upper(regexp_replace(translate(btrim(p_label), 'čćđšžČĆĐŠŽáéíóúýÁÉÍÓÚÝàèìòùÀÈÌÒÙâêîôûÂÊÎÔÛäëïöüÄËÏÖÜñÑ', 'cdsZZCDSZAEIOUYAEIOUYAEIOUAEIOUAEIOUAEIOUAEIOUAEIOUAEIOUnN'), '[^A-Za-z0-9]+', '_', 'g'));
  v_code := btrim(v_code, '_');
  IF v_code = '' THEN v_code := 'PODGRUPA_' || extract(epoch FROM now())::bigint; END IF;
  INSERT INTO public.rev_inventory_subgroups (group_id, code, label, display_order, is_seeded, napomena)
  VALUES (v_group_id, v_code, btrim(p_label), (SELECT coalesce(max(display_order), 100) + 10 FROM public.rev_inventory_subgroups WHERE group_id = v_group_id), false, nullif(btrim(coalesce(p_napomena, '')), ''))
  ON CONFLICT (group_id, code) DO UPDATE SET label = EXCLUDED.label, updated_at = now()
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$function$
;

-- ============ rev_add_inventory_subsubgroup ============
CREATE OR REPLACE FUNCTION public.rev_add_inventory_subsubgroup(p_subgroup_id uuid, p_label text, p_napomena text DEFAULT NULL::text)
 RETURNS rev_inventory_subsubgroups
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_code text;
  v_row  public.rev_inventory_subsubgroups;
BEGIN
  IF NOT public.rev_can_manage() THEN
    RAISE EXCEPTION 'Nemate pravo da dodajete podpodgrupe.' USING ERRCODE = '42501';
  END IF;
  IF p_subgroup_id IS NULL OR coalesce(btrim(p_label), '') = '' THEN
    RAISE EXCEPTION 'Podgrupa i naziv podpodgrupe su obavezni.' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.rev_inventory_subgroups WHERE id = p_subgroup_id) THEN
    RAISE EXCEPTION 'Podgrupa ne postoji.' USING ERRCODE = '23503';
  END IF;

  v_code := upper(regexp_replace(
              translate(btrim(p_label),
                'čćđšžČĆĐŠŽáéíóúýÁÉÍÓÚÝàèìòùÀÈÌÒÙâêîôûÂÊÎÔÛäëïöüÄËÏÖÜñÑ',
                'cdsZZCDSZAEIOUYAEIOUYAEIOUAEIOUAEIOUAEIOUAEIOUAEIOUAEIOUnN'),
              '[^A-Za-z0-9]+', '_', 'g'));
  v_code := btrim(v_code, '_');
  IF v_code = '' THEN v_code := 'PPG_' || extract(epoch FROM now())::bigint; END IF;

  INSERT INTO public.rev_inventory_subsubgroups (subgroup_id, code, label, display_order, is_seeded, napomena)
  VALUES (
    p_subgroup_id, v_code, btrim(p_label),
    (SELECT coalesce(max(display_order), 100) + 10 FROM public.rev_inventory_subsubgroups WHERE subgroup_id = p_subgroup_id),
    false,
    nullif(btrim(coalesce(p_napomena, '')), '')
  )
  ON CONFLICT (subgroup_id, code) DO UPDATE SET label = EXCLUDED.label, updated_at = now()
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$function$
;

-- ============ rev_can_manage ============
CREATE OR REPLACE FUNCTION public.rev_can_manage()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM user_roles
    WHERE lower(email) = lower(auth.jwt() ->> 'email')
      AND role IN ('admin', 'menadzment', 'pm', 'leadpm', 'magacioner')
      AND (is_active IS NULL OR is_active = true)
  );
$function$
;

-- ============ rev_check_cutting_subgroup_group ============
CREATE OR REPLACE FUNCTION public.rev_check_cutting_subgroup_group()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_code text;
BEGIN
  IF NEW.subgroup_id IS NULL THEN RETURN NEW; END IF;
  SELECT g.code INTO v_code FROM public.rev_inventory_subgroups s JOIN public.rev_inventory_groups g ON g.id = s.group_id WHERE s.id = NEW.subgroup_id;
  IF v_code IS DISTINCT FROM 'REZNI' THEN
    RAISE EXCEPTION 'rev_cutting_tool_catalog mora imati podgrupu iz grupe REZNI (dobio: %).', v_code USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$
;

-- ============ rev_check_tools_subgroup_group ============
CREATE OR REPLACE FUNCTION public.rev_check_tools_subgroup_group()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_code text;
BEGIN
  IF NEW.subgroup_id IS NULL THEN RETURN NEW; END IF;
  SELECT g.code INTO v_code FROM public.rev_inventory_subgroups s JOIN public.rev_inventory_groups g ON g.id = s.group_id WHERE s.id = NEW.subgroup_id;
  IF v_code = 'REZNI' THEN
    RAISE EXCEPTION 'rev_tools ne sme imati podgrupu iz grupe REZNI (rezni alat ide u rev_cutting_tool_catalog).' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$
;

-- ============ rev_check_tools_subsubgroup ============
CREATE OR REPLACE FUNCTION public.rev_check_tools_subsubgroup()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_sg uuid;
BEGIN
  IF NEW.subsubgroup_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.subgroup_id IS NULL THEN
    RAISE EXCEPTION 'Podpodgrupa zahteva izabranu podgrupu.' USING ERRCODE = 'check_violation';
  END IF;
  SELECT subgroup_id INTO v_sg FROM public.rev_inventory_subsubgroups WHERE id = NEW.subsubgroup_id;
  IF v_sg IS DISTINCT FROM NEW.subgroup_id THEN
    RAISE EXCEPTION 'Podpodgrupa ne pripada izabranoj podgrupi.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$
;

-- ============ rev_confirm_cutting_return ============
CREATE OR REPLACE FUNCTION public.rev_confirm_cutting_return(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_doc_id        uuid;
  v_doc           rev_documents%ROWTYPE;
  v_return_loc    uuid;
  v_line          jsonb;
  v_line_row      rev_document_lines%ROWTYPE;
  v_qty           numeric;
  v_move_res      jsonb;
  v_movement_id   uuid;
  v_all_returned  boolean;
BEGIN
  IF NOT rev_can_manage() THEN
    RAISE EXCEPTION 'Nemate pravo da potvrdite povraćaj reznog alata.'
      USING ERRCODE = '42501';
  END IF;

  v_doc_id := (p_payload->>'doc_id')::uuid;

  SELECT * INTO v_doc FROM rev_documents WHERE id = v_doc_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Dokument nije pronadjen: %', v_doc_id USING ERRCODE = 'P0002';
  END IF;
  IF v_doc.doc_type <> 'CUTTING_TOOL' THEN
    RAISE EXCEPTION 'rev_confirm_cutting_return je samo za doc_type=CUTTING_TOOL (dobijeno: %).', v_doc.doc_type;
  END IF;
  IF v_doc.status IN ('RETURNED', 'CANCELLED') THEN
    RAISE EXCEPTION 'Dokument je već zatvoren (status: %).', v_doc.status USING ERRCODE = 'P0001';
  END IF;

  v_return_loc := nullif(p_payload->>'return_to_location_id', '')::uuid;
  IF v_return_loc IS NULL THEN
    SELECT id INTO v_return_loc FROM loc_locations WHERE location_code = 'ALAT-MAG-01' LIMIT 1;
  END IF;
  IF v_return_loc IS NULL THEN
    RAISE EXCEPTION 'Nedostaje return_to_location_id (ni ALAT-MAG-01).';
  END IF;

  FOR v_line IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload->'returned_lines', '[]'::jsonb)) LOOP
    SELECT * INTO v_line_row FROM rev_document_lines
      WHERE id = nullif(v_line->>'line_id','')::uuid AND document_id = v_doc_id;
    IF NOT FOUND THEN CONTINUE; END IF;
    IF v_line_row.line_status = 'RETURNED' THEN CONTINUE; END IF;
    IF v_line_row.cutting_tool_catalog_id IS NULL THEN CONTINUE; END IF;

    v_qty := COALESCE((v_line->>'returned_quantity')::numeric, 0);
    IF v_qty <= 0 THEN CONTINUE; END IF;
    IF v_line_row.returned_quantity + v_qty > v_line_row.quantity THEN
      RAISE EXCEPTION 'Vraćena količina premašuje izdato (linija %, izdato=%, već vraćeno=%, novo=%).',
        v_line_row.id, v_line_row.quantity, v_line_row.returned_quantity, v_qty;
    END IF;

    PERFORM rev_cts_apply_delta(v_line_row.cutting_tool_catalog_id, v_doc.recipient_loc_id, -v_qty);
    PERFORM rev_cts_apply_delta(v_line_row.cutting_tool_catalog_id, v_return_loc,            v_qty);

    v_move_res := loc_create_movement(jsonb_build_object(
      'item_ref_table',   'rev_cutting_tool_catalog',
      'item_ref_id',      (SELECT barcode FROM rev_cutting_tool_catalog WHERE id = v_line_row.cutting_tool_catalog_id),
      'from_location_id', v_doc.recipient_loc_id,
      'to_location_id',   v_return_loc,
      'movement_type',    'REVERSAL_RETURN',
      'movement_reason',  'Povratak rezni alat: ' || v_doc.doc_number,
      'note',             COALESCE(p_payload->>'return_notes', ''),
      'quantity',         v_qty,
      'order_no',         '',
      'drawing_no',       ''
    ));

    IF COALESCE((v_move_res->>'ok')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'loc_create_movement neuspesan: %', v_move_res->>'error'
        USING DETAIL = v_move_res::text;
    END IF;

    v_movement_id := (v_move_res->>'id')::uuid;

    UPDATE rev_document_lines SET
      returned_quantity  = v_line_row.returned_quantity + v_qty,
      return_movement_id = v_movement_id,
      line_status        = CASE
        WHEN v_line_row.returned_quantity + v_qty >= v_line_row.quantity THEN 'RETURNED'
        ELSE 'ISSUED'
      END
    WHERE id = v_line_row.id;
  END LOOP;

  SELECT NOT EXISTS (
    SELECT 1 FROM rev_document_lines
    WHERE document_id = v_doc_id AND line_status = 'ISSUED'
  ) INTO v_all_returned;

  UPDATE rev_documents SET
    status              = CASE WHEN v_all_returned THEN 'RETURNED' ELSE 'PARTIALLY_RETURNED' END,
    return_confirmed_by = auth.uid(),
    return_confirmed_at = now(),
    return_notes        = p_payload->>'return_notes'
  WHERE id = v_doc_id;

  RETURN jsonb_build_object(
    'success',      true,
    'all_returned', v_all_returned,
    'doc_id',       v_doc_id
  );
END;
$function$
;

-- ============ rev_confirm_return ============
CREATE OR REPLACE FUNCTION public.rev_confirm_return(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_doc_id uuid; v_doc rev_documents%ROWTYPE; v_line jsonb; v_line_row rev_document_lines%ROWTYPE;
  v_move_res jsonb; v_movement_id uuid; v_item_ref_table text; v_item_ref_id text;
  v_drawing_no text; v_order_no text; v_ret_qty numeric(12,3); v_all_returned boolean; v_is_quantity boolean;
BEGIN
  IF NOT rev_can_manage() THEN RAISE EXCEPTION 'Nemate pravo da potvrdite povracaj.' USING ERRCODE='42501'; END IF;
  v_doc_id := (p_payload->>'doc_id')::uuid;
  SELECT * INTO v_doc FROM rev_documents WHERE id=v_doc_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Dokument nije pronadjen: %', v_doc_id USING ERRCODE='P0002'; END IF;
  IF v_doc.status IN ('RETURNED','CANCELLED') THEN RAISE EXCEPTION 'Dokument je vec zatvoren (status: %).', v_doc.status USING ERRCODE='P0001'; END IF;
  FOR v_line IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload->'returned_lines','[]'::jsonb)) LOOP
    SELECT * INTO v_line_row FROM rev_document_lines WHERE id=(v_line->>'line_id')::uuid AND document_id=v_doc_id;
    IF NOT FOUND THEN CONTINUE; END IF;
    -- Samo ISSUED se vraca; CONSUMED (potrosno), RETURNED, LOST, SCRAPPED se preskacu.
    IF v_line_row.line_status <> 'ISSUED' THEN CONTINUE; END IF;
    v_ret_qty := COALESCE((v_line->>'returned_quantity')::numeric,0);
    IF v_ret_qty <= 0 THEN CONTINUE; END IF;
    v_is_quantity := false;
    IF v_line_row.tool_id IS NOT NULL THEN
      SELECT loc_item_ref_id, is_quantity INTO v_item_ref_id, v_is_quantity FROM rev_tools WHERE id=v_line_row.tool_id;
      IF v_is_quantity THEN
        UPDATE rev_document_lines SET returned_quantity=v_line_row.returned_quantity+v_ret_qty, line_status=CASE WHEN v_line_row.returned_quantity+v_ret_qty >= v_line_row.quantity THEN 'RETURNED' ELSE 'ISSUED' END WHERE id=v_line_row.id;
        CONTINUE;
      END IF;
      IF v_item_ref_id IS NULL THEN RAISE EXCEPTION 'Alat nema loc_item_ref_id: %', v_line_row.tool_id; END IF;
      v_item_ref_table := 'rev_tools'; v_drawing_no := ''; v_order_no := '';
    ELSE
      v_item_ref_table := 'bigtehn_drawings_cache'; v_item_ref_id := COALESCE(v_line_row.drawing_no,'UNKNOWN'); v_drawing_no := COALESCE(v_line_row.drawing_no,''); v_order_no := COALESCE(v_line_row.work_order_id::text,'');
    END IF;
    v_move_res := loc_create_movement(jsonb_build_object('item_ref_table',v_item_ref_table,'item_ref_id',v_item_ref_id,'from_location_id',v_doc.recipient_loc_id,'to_location_id',(p_payload->>'return_to_location_id')::uuid,'movement_type','REVERSAL_RETURN','movement_reason','Povracaj: '||v_doc.doc_number,'note',COALESCE(p_payload->>'return_notes',''),'quantity',v_ret_qty,'drawing_no',v_drawing_no,'order_no',v_order_no));
    IF COALESCE((v_move_res->>'ok')::boolean,false) IS NOT TRUE THEN RAISE EXCEPTION 'loc_create_movement neuspesan: %', v_move_res->>'error' USING DETAIL=v_move_res::text; END IF;
    v_movement_id := (v_move_res->>'id')::uuid;
    UPDATE rev_document_lines SET returned_quantity=v_line_row.returned_quantity+v_ret_qty, return_movement_id=v_movement_id, line_status=CASE WHEN v_line_row.returned_quantity+v_ret_qty >= v_line_row.quantity THEN 'RETURNED' ELSE 'ISSUED' END WHERE id=v_line_row.id;
  END LOOP;
  SELECT NOT EXISTS (SELECT 1 FROM rev_document_lines WHERE document_id=v_doc_id AND line_status='ISSUED') INTO v_all_returned;
  UPDATE rev_documents SET status=CASE WHEN v_all_returned THEN 'RETURNED' ELSE 'PARTIALLY_RETURNED' END, return_confirmed_by=auth.uid(), return_confirmed_at=now(), return_notes=p_payload->>'return_notes' WHERE id=v_doc_id;
  RETURN jsonb_build_object('success',true,'all_returned',v_all_returned,'doc_id',v_doc_id);
END; $function$
;

-- ============ rev_cts_apply_delta ============
CREATE OR REPLACE FUNCTION public.rev_cts_apply_delta(p_catalog_id uuid, p_location_id uuid, p_delta numeric)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_new numeric;
BEGIN
  IF p_catalog_id IS NULL OR p_location_id IS NULL THEN
    RAISE EXCEPTION 'rev_cts_apply_delta: catalog_id i location_id su obavezni.';
  END IF;
  IF p_delta = 0 THEN
    SELECT on_hand_qty INTO v_new FROM rev_cutting_tool_stock
    WHERE catalog_id = p_catalog_id AND location_id = p_location_id;
    RETURN COALESCE(v_new, 0);
  END IF;

  INSERT INTO rev_cutting_tool_stock (catalog_id, location_id, on_hand_qty, updated_at)
  VALUES (p_catalog_id, p_location_id, p_delta, now())
  ON CONFLICT (catalog_id, location_id) DO UPDATE
    SET on_hand_qty = rev_cutting_tool_stock.on_hand_qty + EXCLUDED.on_hand_qty,
        updated_at  = now()
  RETURNING on_hand_qty INTO v_new;

  IF v_new < 0 THEN
    RAISE EXCEPTION 'Nedovoljna količina reznog alata na lokaciji % (catalog=%, rezultujuće stanje=%).',
      p_location_id, p_catalog_id, v_new
      USING ERRCODE = 'P0001';
  END IF;

  RETURN v_new;
END;
$function$
;

-- ============ rev_current_employee_id ============
CREATE OR REPLACE FUNCTION public.rev_current_employee_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT id
  FROM public.employees
  WHERE lower(email) = lower(auth.jwt() ->> 'email')
    AND is_active IS TRUE
  LIMIT 1;
$function$
;

-- ============ rev_current_machine_codes ============
CREATE OR REPLACE FUNCTION public.rev_current_machine_codes()
 RETURNS text[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'core', 'production', 'pg_temp'
AS $function$
  SELECT COALESCE(array_agg(DISTINCT wc.kod), ARRAY[]::text[])
  FROM production.prijava_rada pr
  JOIN core.radnik r        ON r.id = pr.radnik_id
  JOIN core.work_center wc  ON wc.id = pr.work_center_id
  WHERE pr.finished_at IS NULL
    AND r.aktivan IS TRUE
    AND r.employee_id = public.rev_current_employee_id();
$function$
;

-- ============ rev_cutting_tool_seed_stock ============
CREATE OR REPLACE FUNCTION public.rev_cutting_tool_seed_stock(p_catalog_id uuid, p_location_id uuid, p_qty numeric)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_new numeric;
BEGIN
  IF NOT rev_can_manage() THEN
    RAISE EXCEPTION 'Nemate pravo da menjate stanje reznog alata.' USING ERRCODE = '42501';
  END IF;
  IF p_catalog_id IS NULL OR p_location_id IS NULL THEN
    RAISE EXCEPTION 'catalog_id i location_id su obavezni.';
  END IF;
  IF COALESCE(p_qty, 0) <= 0 THEN
    RAISE EXCEPTION 'Količina za seed mora biti > 0 (dobijeno: %).', p_qty;
  END IF;
  v_new := public.rev_cts_apply_delta(p_catalog_id, p_location_id, p_qty);
  RETURN v_new;
END;
$function$
;

-- ============ rev_cutting_tool_set_barcode ============
CREATE OR REPLACE FUNCTION public.rev_cutting_tool_set_barcode()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.barcode IS NULL OR btrim(NEW.barcode) = '' THEN
    NEW.barcode := 'RZN-' || lpad(nextval('public.rev_cutting_tool_barcode_seq')::text, 6, '0');
  END IF;
  RETURN NEW;
END;
$function$
;

-- ============ rev_get_or_create_recipient_location ============
CREATE OR REPLACE FUNCTION public.rev_get_or_create_recipient_location(p_recipient_type text, p_recipient_key text, p_recipient_label text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_loc_id   uuid;
  v_loc_code text;
  v_loc_type public.loc_type_enum;
BEGIN
  SELECT loc_location_id INTO v_loc_id
  FROM public.rev_recipient_locations
  WHERE recipient_type = p_recipient_type
    AND recipient_key = p_recipient_key;

  IF v_loc_id IS NOT NULL THEN
    RETURN v_loc_id;
  END IF;

  CASE p_recipient_type
    WHEN 'EMPLOYEE' THEN
      v_loc_type := 'FIELD';
      v_loc_code := 'ZADU-R-' || substr(p_recipient_key, 1, 8);
    WHEN 'DEPARTMENT' THEN
      v_loc_type := 'FIELD';
      v_loc_code := 'ZADU-O-' || p_recipient_key;
    WHEN 'EXTERNAL_COMPANY' THEN
      v_loc_type := 'SERVICE';
      v_loc_code := 'ZADU-K-' || p_recipient_key;
    WHEN 'MACHINE' THEN
      v_loc_type := 'PRODUCTION';
      v_loc_code := 'ZADU-M-' || regexp_replace(p_recipient_key, '[^A-Za-z0-9._-]', '_', 'g');
    ELSE
      RAISE EXCEPTION 'Nepoznat tip primaoca: %', p_recipient_type;
  END CASE;

  INSERT INTO public.loc_locations (
    location_code,
    name,
    location_type,
    is_active,
    notes
  )
  VALUES (
    v_loc_code,
    'Zaduzeno: ' || p_recipient_label,
    v_loc_type,
    true,
    'Automatski kreirana virtuelna lokacija za reversal primalac'
  )
  ON CONFLICT (
    COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid),
    lower(location_code)
  )
    DO UPDATE SET
      name = EXCLUDED.name,
      is_active = true
  RETURNING id INTO v_loc_id;

  INSERT INTO public.rev_recipient_locations (
    recipient_type,
    recipient_key,
    recipient_label,
    loc_location_id
  )
  VALUES (p_recipient_type, p_recipient_key, p_recipient_label, v_loc_id)
  ON CONFLICT (recipient_type, recipient_key)
    DO UPDATE SET recipient_label = EXCLUDED.recipient_label;

  RETURN v_loc_id;
END;
$function$
;

-- ============ rev_hand_tool_apply_delta ============
CREATE OR REPLACE FUNCTION public.rev_hand_tool_apply_delta(p_tool_id uuid, p_delta integer, p_reason text, p_note text DEFAULT NULL::text, p_ref_doc_id uuid DEFAULT NULL::uuid, p_ref_line_id uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tool rev_tools%ROWTYPE;
  v_new  integer;
BEGIN
  IF NOT rev_can_manage() THEN
    RAISE EXCEPTION 'Nemate pravo da menjate stanje alata.' USING ERRCODE = '42501';
  END IF;
  IF p_tool_id IS NULL THEN RAISE EXCEPTION 'tool_id je obavezan.'; END IF;
  IF p_delta = 0 THEN RAISE EXCEPTION 'delta ne sme biti 0.'; END IF;
  IF p_reason NOT IN ('RECEIPT', 'ISSUE', 'RETURN', 'ADJUST', 'WRITE_OFF') THEN
    RAISE EXCEPTION 'Nepoznat reason: %', p_reason;
  END IF;
  SELECT * INTO v_tool FROM rev_tools WHERE id = p_tool_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Alat nije pronadjen: %', p_tool_id USING ERRCODE = 'P0002';
  END IF;
  IF NOT v_tool.is_quantity THEN
    RAISE EXCEPTION 'Stavka % nije kolicinska (is_quantity=false) — zaliha se ne vodi kroz ledger.',
      v_tool.oznaka USING ERRCODE = 'P0001';
  END IF;
  v_new := v_tool.total_qty + p_delta;
  IF v_new < 0 AND NOT v_tool.is_consumable THEN
    RAISE EXCEPTION 'Nedovoljno na stanju za % (trenutno %, traceno oduzimanje %).',
      v_tool.oznaka, v_tool.total_qty, -p_delta USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO rev_tool_stock_ledger (
    tool_id, delta, reason, balance_after, ref_doc_id, ref_line_id, note
  ) VALUES (
    p_tool_id, p_delta, p_reason, v_new, p_ref_doc_id, p_ref_line_id, p_note
  );
  UPDATE rev_tools SET total_qty = v_new WHERE id = p_tool_id;
  RETURN v_new;
END;
$function$
;

-- ============ rev_issue_cutting_reversal ============
CREATE OR REPLACE FUNCTION public.rev_issue_cutting_reversal(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_doc_id          uuid;
  v_doc_number      text;
  v_recipient_loc   uuid;
  v_machine_code    text;
  v_employee_id     uuid;
  v_employee_name   text;
  v_source_loc      uuid;
  v_line            jsonb;
  v_catalog         rev_cutting_tool_catalog%ROWTYPE;
  v_qty             numeric;
  v_line_id         uuid;
  v_move_res        jsonb;
  v_movement_id     uuid;
  v_legacy_skip     boolean;
  v_bulk_key        text;
  v_existing_id     uuid;
  v_existing_no     text;
  v_assignee        jsonb;
BEGIN
  IF NOT rev_can_manage() THEN
    RAISE EXCEPTION 'Nemate pravo da kreirate revers reznog alata.'
      USING ERRCODE = '42501';
  END IF;

  v_legacy_skip := COALESCE((p_payload->>'legacy_skip_source_decrement')::boolean, false);

  v_bulk_key := nullif(btrim(COALESCE(p_payload->>'bulk_import_legacy_key', '')), '');
  IF v_bulk_key IS NOT NULL THEN
    SELECT d.id, d.doc_number INTO v_existing_id, v_existing_no
    FROM public.rev_documents d
    WHERE d.bulk_import_legacy_key = v_bulk_key
    LIMIT 1;
    IF v_existing_id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'success', true,
        'doc_id', v_existing_id,
        'doc_number', v_existing_no,
        'idempotent', true
      );
    END IF;
  END IF;

  v_machine_code := nullif(btrim(p_payload->>'recipient_machine_code'), '');
  IF v_machine_code IS NULL THEN
    RAISE EXCEPTION 'recipient_machine_code je obavezan za revers reznog alata.';
  END IF;

  v_employee_id := nullif(p_payload->>'issued_to_employee_id', '')::uuid;
  IF v_employee_id IS NULL THEN
    RAISE EXCEPTION 'issued_to_employee_id (potpisnik preuzimanja) je obavezan.';
  END IF;
  v_employee_name := COALESCE(p_payload->>'issued_to_employee_name', '');

  v_source_loc := nullif(p_payload->>'source_location_id', '')::uuid;
  IF v_source_loc IS NULL THEN
    SELECT id INTO v_source_loc FROM loc_locations WHERE location_code = 'ALAT-MAG-01' LIMIT 1;
  END IF;
  IF v_source_loc IS NULL AND NOT v_legacy_skip THEN
    RAISE EXCEPTION 'Nije moguće odrediti izvornu lokaciju (source_location_id ili ALAT-MAG-01).';
  END IF;

  IF jsonb_array_length(COALESCE(p_payload->'lines', '[]'::jsonb)) = 0 THEN
    RAISE EXCEPTION 'Dokument mora imati najmanje jednu stavku.';
  END IF;

  IF jsonb_array_length(COALESCE(p_payload->'assignees', '[]'::jsonb)) > 0 THEN
    IF (
      SELECT COUNT(*) FROM jsonb_array_elements(p_payload->'assignees') a
      WHERE upper(btrim(COALESCE(a->>'role', ''))) = 'PRIMARY'
    ) <> 1 THEN
      RAISE EXCEPTION 'assignees mora da sadrži tačno jednog PRIMARY operatera (role=PRIMARY).';
    END IF;
  END IF;

  v_doc_number    := rev_next_doc_number('CUTTING_TOOL');
  v_recipient_loc := rev_get_or_create_recipient_location(
    'MACHINE',
    v_machine_code,
    'Mašina ' || v_machine_code
  );

  INSERT INTO rev_documents (
    doc_number,
    doc_type,
    recipient_type,
    recipient_machine_code,
    recipient_loc_id,
    issued_to_employee_id,
    issued_to_employee_name,
    expected_return_date,
    issued_by,
    napomena,
    bulk_import_legacy_key
  ) VALUES (
    v_doc_number,
    'CUTTING_TOOL',
    'MACHINE',
    v_machine_code,
    v_recipient_loc,
    v_employee_id,
    v_employee_name,
    nullif(p_payload->>'expected_return_date','')::date,
    auth.uid(),
    p_payload->>'napomena',
    v_bulk_key
  ) RETURNING id INTO v_doc_id;

  IF jsonb_array_length(COALESCE(p_payload->'assignees', '[]'::jsonb)) > 0 THEN
    FOR v_assignee IN SELECT * FROM jsonb_array_elements(p_payload->'assignees') LOOP
      INSERT INTO public.rev_document_cutting_assignees (document_id, employee_id, role)
      VALUES (
        v_doc_id,
        (v_assignee->>'employee_id')::uuid,
        CASE upper(btrim(COALESCE(v_assignee->>'role', 'SECONDARY')))
          WHEN 'PRIMARY' THEN 'PRIMARY'
          ELSE 'SECONDARY'
        END
      )
      ON CONFLICT (document_id, employee_id) DO UPDATE
        SET role = EXCLUDED.role;
    END LOOP;
  ELSE
    INSERT INTO public.rev_document_cutting_assignees (document_id, employee_id, role)
    VALUES (v_doc_id, v_employee_id, 'PRIMARY')
    ON CONFLICT (document_id, employee_id) DO NOTHING;
  END IF;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_payload->'lines') LOOP
    SELECT * INTO v_catalog FROM rev_cutting_tool_catalog
      WHERE id = nullif(v_line->>'catalog_id','')::uuid;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Šifra reznog alata nije pronađena: %', v_line->>'catalog_id';
    END IF;

    v_qty := COALESCE((v_line->>'quantity')::numeric, 0);
    IF v_qty <= 0 THEN
      RAISE EXCEPTION 'Količina mora biti > 0 (catalog=%).', v_catalog.id;
    END IF;

    IF v_legacy_skip THEN
      PERFORM rev_cts_apply_delta(v_catalog.id, v_recipient_loc, v_qty);
    ELSE
      PERFORM rev_cts_apply_delta(v_catalog.id, v_source_loc,    -v_qty);
      PERFORM rev_cts_apply_delta(v_catalog.id, v_recipient_loc,  v_qty);
    END IF;

    INSERT INTO rev_document_lines (
      document_id,
      sort_order,
      line_type,
      cutting_tool_catalog_id,
      part_name,
      quantity,
      unit,
      napomena
    ) VALUES (
      v_doc_id,
      COALESCE((v_line->>'sort_order')::int, 0),
      'CUTTING_TOOL',
      v_catalog.id,
      v_catalog.naziv,
      v_qty,
      v_catalog.unit,
      v_line->>'napomena'
    ) RETURNING id INTO v_line_id;

    IF NOT v_legacy_skip THEN
      v_move_res := loc_create_movement(jsonb_build_object(
        'item_ref_table',   'rev_cutting_tool_catalog',
        'item_ref_id',      v_catalog.barcode,
        'from_location_id', v_source_loc,
        'to_location_id',   v_recipient_loc,
        'movement_type',    'REVERSAL_ISSUE',
        'movement_reason',  'Rezni alat: ' || v_doc_number,
        'note',             COALESCE(v_line->>'napomena', ''),
        'quantity',         v_qty,
        'order_no',         '',
        'drawing_no',       ''
      ));

      IF COALESCE((v_move_res->>'ok')::boolean, false) IS NOT TRUE THEN
        RAISE EXCEPTION 'loc_create_movement neuspesan: %', v_move_res->>'error'
          USING DETAIL = v_move_res::text;
      END IF;

      v_movement_id := (v_move_res->>'id')::uuid;
      UPDATE rev_document_lines SET issue_movement_id = v_movement_id WHERE id = v_line_id;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'success',    true,
    'doc_id',     v_doc_id,
    'doc_number', v_doc_number
  );
END;
$function$
;

-- ============ rev_issue_reversal ============
CREATE OR REPLACE FUNCTION public.rev_issue_reversal(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_doc_id uuid; v_doc_number text; v_loc_id uuid; v_line jsonb; v_line_id uuid;
  v_move_res jsonb; v_movement_id uuid; v_recipient_key text; v_recipient_label text;
  v_item_ref_table text; v_item_ref_id text; v_drawing_no text; v_order_no text;
  v_from_loc uuid; v_tool_row rev_tools%ROWTYPE; v_req_qty numeric(12,3);
  v_legacy_key text;
BEGIN
  IF NOT rev_can_manage() THEN RAISE EXCEPTION 'Nemate pravo da kreirate reversal dokument.' USING ERRCODE='42501'; END IF;
  IF p_payload->>'doc_type' IS NULL THEN RAISE EXCEPTION 'doc_type je obavezan.'; END IF;
  IF p_payload->>'recipient_type' IS NULL THEN RAISE EXCEPTION 'recipient_type je obavezan.'; END IF;
  IF jsonb_array_length(COALESCE(p_payload->'lines','[]'::jsonb))=0 THEN RAISE EXCEPTION 'Dokument mora imati najmanje jednu stavku.'; END IF;

  -- Idempotency (bulk import): isti legacy ključ se ne uvozi dvaput.
  v_legacy_key := NULLIF(btrim(COALESCE(p_payload->>'bulk_import_legacy_key','')),'');
  IF v_legacy_key IS NOT NULL THEN
    SELECT id, doc_number INTO v_doc_id, v_doc_number
      FROM rev_documents WHERE bulk_import_legacy_key = v_legacy_key LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object('success',true,'idempotent',true,'doc_id',v_doc_id,'doc_number',v_doc_number);
    END IF;
  END IF;

  CASE p_payload->>'recipient_type'
    WHEN 'EMPLOYEE' THEN v_recipient_key := p_payload->>'recipient_employee_id'; v_recipient_label := COALESCE(p_payload->>'recipient_employee_name','Nepoznat radnik');
    WHEN 'DEPARTMENT' THEN v_recipient_key := lower(regexp_replace(COALESCE(p_payload->>'recipient_department','nepoznato'),'[^a-z0-9]','-','g')); v_recipient_label := COALESCE(p_payload->>'recipient_department','Nepoznato odeljenje');
    WHEN 'EXTERNAL_COMPANY' THEN v_recipient_key := lower(regexp_replace(COALESCE(p_payload->>'recipient_company_name','nepoznata'),'[^a-z0-9]','-','g')); v_recipient_label := COALESCE(p_payload->>'recipient_company_name','Nepoznata firma');
    ELSE RAISE EXCEPTION 'Nepoznat recipient_type: %', p_payload->>'recipient_type';
  END CASE;
  IF v_recipient_key IS NULL OR v_recipient_key='' THEN RAISE EXCEPTION 'Primalac nije ispravno definisan (recipient_key je prazan).'; END IF;
  v_doc_number := rev_next_doc_number(p_payload->>'doc_type');
  v_loc_id := rev_get_or_create_recipient_location(p_payload->>'recipient_type', v_recipient_key, v_recipient_label);
  INSERT INTO rev_documents (doc_number,doc_type,recipient_type,recipient_employee_id,recipient_employee_name,recipient_department,recipient_company_name,recipient_company_pib,recipient_loc_id,expected_return_date,issued_by,napomena,bulk_import_legacy_key)
  VALUES (v_doc_number,p_payload->>'doc_type',p_payload->>'recipient_type',NULLIF(p_payload->>'recipient_employee_id','')::uuid,p_payload->>'recipient_employee_name',p_payload->>'recipient_department',p_payload->>'recipient_company_name',p_payload->>'recipient_company_pib',v_loc_id,NULLIF(p_payload->>'expected_return_date','')::date,auth.uid(),p_payload->>'napomena',v_legacy_key)
  RETURNING id INTO v_doc_id;
  FOR v_line IN SELECT * FROM jsonb_array_elements(p_payload->'lines') LOOP
    IF (v_line->>'line_type')='TOOL' THEN
      IF NULLIF(trim(v_line->>'tool_id'),'') IS NULL THEN RAISE EXCEPTION 'TOOL stavka zahteva tool_id.'; END IF;
      SELECT * INTO v_tool_row FROM rev_tools WHERE id=(v_line->>'tool_id')::uuid;
      IF NOT FOUND THEN RAISE EXCEPTION 'Alat nije pronadjen: %', v_line->>'tool_id'; END IF;
      IF v_tool_row.is_quantity THEN
        v_req_qty := GREATEST(COALESCE((v_line->>'quantity')::numeric,1),1);
        IF v_tool_row.is_consumable THEN
          INSERT INTO rev_document_lines (document_id,sort_order,line_type,tool_id,quantity,unit,napomena,line_status)
          VALUES (v_doc_id,COALESCE((v_line->>'sort_order')::int,0),'TOOL',v_tool_row.id,v_req_qty,COALESCE(v_line->>'unit','kom'),v_line->>'napomena','CONSUMED')
          RETURNING id INTO v_line_id;
          PERFORM rev_hand_tool_apply_delta(v_tool_row.id, (-v_req_qty)::int, 'ISSUE', 'Reversal: '||v_doc_number, v_doc_id, v_line_id);
          CONTINUE;
        END IF;
        INSERT INTO rev_document_lines (document_id,sort_order,line_type,tool_id,quantity,unit,napomena) VALUES (v_doc_id,COALESCE((v_line->>'sort_order')::int,0),'TOOL',v_tool_row.id,v_req_qty,COALESCE(v_line->>'unit','kom'),v_line->>'napomena');
        CONTINUE;
      END IF;
      v_item_ref_table := 'rev_tools'; v_item_ref_id := v_tool_row.loc_item_ref_id; v_drawing_no := ''; v_order_no := '';
      SELECT lp.location_id INTO v_from_loc FROM loc_item_placements lp WHERE lp.item_ref_table='rev_tools' AND lp.item_ref_id=v_tool_row.loc_item_ref_id ORDER BY lp.placed_at DESC LIMIT 1;
    ELSE
      v_item_ref_table := 'bigtehn_drawings_cache'; v_item_ref_id := COALESCE(v_line->>'drawing_no',v_line->>'part_name','UNKNOWN'); v_drawing_no := COALESCE(v_line->>'drawing_no',''); v_order_no := COALESCE(v_line->>'work_order_id',''); v_from_loc := NULL;
    END IF;
    INSERT INTO rev_document_lines (document_id,sort_order,line_type,tool_id,drawing_no,work_order_id,part_name,quantity,unit,napomena)
    VALUES (v_doc_id,COALESCE((v_line->>'sort_order')::int,0),v_line->>'line_type',NULLIF(v_line->>'tool_id','')::uuid,v_line->>'drawing_no',NULLIF(v_line->>'work_order_id','')::uuid,v_line->>'part_name',COALESCE((v_line->>'quantity')::numeric,1),COALESCE(v_line->>'unit','kom'),v_line->>'napomena')
    RETURNING id INTO v_line_id;
    v_move_res := loc_create_movement(jsonb_build_object('item_ref_table',v_item_ref_table,'item_ref_id',v_item_ref_id,'from_location_id',v_from_loc,'to_location_id',v_loc_id,'movement_type','REVERSAL_ISSUE','movement_reason','Reversal: '||v_doc_number,'note',COALESCE(v_line->>'napomena',''),'quantity',COALESCE((v_line->>'quantity')::numeric,1),'order_no',v_order_no,'drawing_no',v_drawing_no));
    IF COALESCE((v_move_res->>'ok')::boolean,false) IS NOT TRUE THEN RAISE EXCEPTION 'loc_create_movement neuspesan: %', v_move_res->>'error' USING DETAIL=v_move_res::text; END IF;
    v_movement_id := (v_move_res->>'id')::uuid;
    UPDATE rev_document_lines SET issue_movement_id=v_movement_id WHERE id=v_line_id;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM rev_document_lines WHERE document_id=v_doc_id AND line_status='ISSUED') THEN
    UPDATE rev_documents SET status='RETURNED', return_confirmed_by=auth.uid(), return_confirmed_at=now() WHERE id=v_doc_id;
  END IF;
  RETURN jsonb_build_object('success',true,'doc_id',v_doc_id,'doc_number',v_doc_number);
END; $function$
;

-- ============ rev_next_doc_number ============
CREATE OR REPLACE FUNCTION public.rev_next_doc_number(p_doc_type text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_prefix  text;
  v_year    text;
  v_max_seq int;
BEGIN
  v_prefix := CASE p_doc_type
    WHEN 'TOOL'              THEN 'REV-TOOL'
    WHEN 'COOPERATION_GOODS' THEN 'REV-KOOP'
    WHEN 'CUTTING_TOOL'      THEN 'REV-RZN'
    ELSE NULL
  END;

  IF v_prefix IS NULL THEN
    RAISE EXCEPTION 'Nepoznat tip dokumenta: %', p_doc_type;
  END IF;

  v_year := to_char(now(), 'YYYY');

  SELECT COALESCE(
    MAX((regexp_match(doc_number, '-(\d+)$'))[1]::int),
    0
  )
  INTO v_max_seq
  FROM rev_documents
  WHERE doc_number LIKE v_prefix || '-' || v_year || '-%';

  RETURN v_prefix || '-' || v_year || '-' || lpad((v_max_seq + 1)::text, 4, '0');
END;
$function$
;

-- ============ rev_restore_tool ============
CREATE OR REPLACE FUNCTION public.rev_restore_tool(p_tool_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tool     public.rev_tools%ROWTYPE;
  v_last     public.rev_tool_stock_ledger%ROWTYPE;
  v_restored integer := 0;
BEGIN
  IF NOT public.rev_can_manage() THEN
    RAISE EXCEPTION 'Nemate pravo.' USING ERRCODE='42501';
  END IF;

  SELECT * INTO v_tool FROM public.rev_tools WHERE id = p_tool_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Alat nije pronađen.' USING ERRCODE='P0002';
  END IF;
  IF v_tool.status = 'active' THEN
    RETURN jsonb_build_object('success', true, 'tool_id', p_tool_id,
                              'already_active', true, 'stock_restored', 0);
  END IF;

  UPDATE public.rev_tools
     SET status='active', otpis_datum=NULL, otpis_razlog=NULL, otpis_by=NULL, updated_at=now()
   WHERE id = p_tool_id;

  -- Količinski alat: otpis je spustio zalihu na 0 kroz ledger (WRITE_OFF).
  -- Vrati je samo ako je POSLEDNJI pokret zalihe upravo taj otpis — ako je
  -- bilo pokreta posle, ne diramo (ručna korekcija je tada svesna odluka).
  IF v_tool.is_quantity THEN
    SELECT * INTO v_last
      FROM public.rev_tool_stock_ledger
     WHERE tool_id = p_tool_id
     ORDER BY created_at DESC
     LIMIT 1;
    IF FOUND AND v_last.reason = 'WRITE_OFF' AND v_last.delta < 0 THEN
      v_restored := -v_last.delta;
      PERFORM public.rev_hand_tool_apply_delta(
        p_tool_id, v_restored, 'ADJUST', 'Poništen otpis — vraćena zaliha');
    END IF;
  END IF;

  RETURN jsonb_build_object('success', true, 'tool_id', p_tool_id, 'stock_restored', v_restored);
END;
$function$
;

-- ============ rev_tools_set_barcode ============
CREATE OR REPLACE FUNCTION public.rev_tools_set_barcode()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.barcode IS NULL OR btrim(NEW.barcode) = '' THEN
    NEW.barcode := 'ALAT-' || lpad(nextval('public.rev_tools_barcode_seq')::text, 6, '0');
  END IF;
  RETURN NEW;
END;
$function$
;

-- ============ rev_tools_set_item_ref ============
CREATE OR REPLACE FUNCTION public.rev_tools_set_item_ref()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  NEW.loc_item_ref_id := 'rev_tools:' || NEW.id::text;
  RETURN NEW;
END;
$function$
;

-- ============ rev_touch_updated_at ============
CREATE OR REPLACE FUNCTION public.rev_touch_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$ BEGIN NEW.updated_at := now(); RETURN NEW; END; $function$
;

-- ============ rev_write_off_tool ============
CREATE OR REPLACE FUNCTION public.rev_write_off_tool(p_tool_id uuid, p_razlog text DEFAULT NULL::text, p_datum date DEFAULT NULL::date, p_status text DEFAULT 'scrapped'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tool public.rev_tools%ROWTYPE;
  v_open int;
BEGIN
  IF NOT public.rev_can_manage() THEN
    RAISE EXCEPTION 'Nemate pravo za otpis alata.' USING ERRCODE='42501';
  END IF;
  IF p_status NOT IN ('scrapped','lost') THEN
    RAISE EXCEPTION 'Nedozvoljen status otpisa: %', p_status;
  END IF;
  SELECT * INTO v_tool FROM public.rev_tools WHERE id = p_tool_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Alat nije pronađen.'; END IF;

  SELECT count(*) INTO v_open
    FROM public.rev_document_lines dl
    JOIN public.rev_documents d ON d.id = dl.document_id
   WHERE dl.tool_id = p_tool_id
     AND dl.line_status = 'ISSUED'
     AND d.status IN ('OPEN','PARTIALLY_RETURNED');
  IF v_open > 0 THEN
    RAISE EXCEPTION 'Alat je trenutno zadužen (na reversu). Prvo evidentiraj povraćaj, pa otpiši.';
  END IF;

  UPDATE public.rev_tools
     SET status      = p_status,
         otpis_datum = COALESCE(p_datum, current_date),
         otpis_razlog= NULLIF(btrim(COALESCE(p_razlog,'')), ''),
         otpis_by    = auth.uid(),
         updated_at  = now()
   WHERE id = p_tool_id;

  -- količinski/potrošni alat: spusti zalihu na 0 kroz ledger
  IF v_tool.is_quantity AND COALESCE(v_tool.total_qty,0) <> 0 THEN
    PERFORM public.rev_hand_tool_apply_delta(p_tool_id, (-v_tool.total_qty)::int, 'WRITE_OFF', 'Otpis alata');
  END IF;

  RETURN jsonb_build_object('success', true, 'tool_id', p_tool_id, 'status', p_status);
END;
$function$
;

