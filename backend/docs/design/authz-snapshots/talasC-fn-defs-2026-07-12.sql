-- AUTHZ/RPC SNAPSHOT: Talas C — Plan montaže + Plan proizvodnje + Praćenje proizvodnje — snimljeno 2026-07-12
-- Izvor: ŽIVA baza kroz Management API (cloud = restore-izvor sy15). Re-verifikovati na živoj sy15 pre R1.
-- Sadržaj: (A) RLS politike 131 kom (production/core/pdm + public talas-C tabele),
--          (B) 77 funkcija (pune definicije; production.* DEFINER jezgro + public wrapperi + authz helperi),
--          (C) 13 view definicija (public bridge view-ovi nad production šemom + v_production_operations lanac).
-- ⚠️ pg_get_functiondef filter prokind='f' (agregati bacaju). Politike su snimljene kao KOMENTAR (referenca, ne DDL).

-- ============================================================================
-- (A) RLS POLITIKE — pg_policies snapshot 2026-07-12
-- ============================================================================
-- core.odeljenje :: pracenje_delete [DELETE] roles={authenticated}
--   USING: production.can_edit_pracenje(NULL::uuid, NULL::uuid)
-- core.odeljenje :: pracenje_insert [INSERT] roles={authenticated}
--   CHECK: production.can_edit_pracenje(NULL::uuid, NULL::uuid)
-- core.odeljenje :: pracenje_select [SELECT] roles={authenticated}
--   USING: true
-- core.odeljenje :: pracenje_update [UPDATE] roles={authenticated}
--   USING: production.can_edit_pracenje(NULL::uuid, NULL::uuid)
--   CHECK: production.can_edit_pracenje(NULL::uuid, NULL::uuid)
-- core.radnik :: pracenje_delete [DELETE] roles={authenticated}
--   USING: production.can_edit_pracenje(NULL::uuid, NULL::uuid)
-- core.radnik :: pracenje_insert [INSERT] roles={authenticated}
--   CHECK: production.can_edit_pracenje(NULL::uuid, NULL::uuid)
-- core.radnik :: pracenje_select [SELECT] roles={authenticated}
--   USING: true
-- core.radnik :: pracenje_update [UPDATE] roles={authenticated}
--   USING: production.can_edit_pracenje(NULL::uuid, NULL::uuid)
--   CHECK: production.can_edit_pracenje(NULL::uuid, NULL::uuid)
-- core.radnik_alias :: pracenje_delete [DELETE] roles={authenticated}
--   USING: production.can_edit_pracenje(NULL::uuid, NULL::uuid)
-- core.radnik_alias :: pracenje_insert [INSERT] roles={authenticated}
--   CHECK: production.can_edit_pracenje(NULL::uuid, NULL::uuid)
-- core.radnik_alias :: pracenje_select [SELECT] roles={authenticated}
--   USING: true
-- core.radnik_alias :: pracenje_update [UPDATE] roles={authenticated}
--   USING: production.can_edit_pracenje(NULL::uuid, NULL::uuid)
--   CHECK: production.can_edit_pracenje(NULL::uuid, NULL::uuid)
-- core.work_center :: pracenje_delete [DELETE] roles={authenticated}
--   USING: production.can_edit_pracenje(NULL::uuid, NULL::uuid)
-- core.work_center :: pracenje_insert [INSERT] roles={authenticated}
--   CHECK: production.can_edit_pracenje(NULL::uuid, NULL::uuid)
-- core.work_center :: pracenje_select [SELECT] roles={authenticated}
--   USING: true
-- core.work_center :: pracenje_update [UPDATE] roles={authenticated}
--   USING: production.can_edit_pracenje(NULL::uuid, NULL::uuid)
--   CHECK: production.can_edit_pracenje(NULL::uuid, NULL::uuid)
-- pdm.drawing :: pracenje_delete [DELETE] roles={authenticated}
--   USING: production.can_edit_pracenje(NULL::uuid, NULL::uuid)
-- pdm.drawing :: pracenje_insert [INSERT] roles={authenticated}
--   CHECK: production.can_edit_pracenje(NULL::uuid, NULL::uuid)
-- pdm.drawing :: pracenje_select [SELECT] roles={authenticated}
--   USING: true
-- pdm.drawing :: pracenje_update [UPDATE] roles={authenticated}
--   USING: production.can_edit_pracenje(NULL::uuid, NULL::uuid)
--   CHECK: production.can_edit_pracenje(NULL::uuid, NULL::uuid)
-- production.operativna_aktivnost :: pracenje_delete [DELETE] roles={authenticated}
--   USING: production.can_edit_pracenje(projekat_id, radni_nalog_id)
-- production.operativna_aktivnost :: pracenje_insert [INSERT] roles={authenticated}
--   CHECK: production.can_edit_pracenje(projekat_id, radni_nalog_id)
-- production.operativna_aktivnost :: pracenje_select [SELECT] roles={authenticated}
--   USING: true
-- production.operativna_aktivnost :: pracenje_update [UPDATE] roles={authenticated}
--   USING: production.can_edit_pracenje(projekat_id, radni_nalog_id)
--   CHECK: production.can_edit_pracenje(projekat_id, radni_nalog_id)
-- production.operativna_aktivnost_blok_istorija :: pracenje_delete [DELETE] roles={authenticated}
--   USING: (EXISTS ( SELECT 1 FROM production.operativna_aktivnost oa WHERE ((oa.id = operativna_aktivnost_blok_istorija.aktivnost_id) AND production.can_edit_pracenje(oa.projekat_id, oa.radni_nalog_id))))
-- production.operativna_aktivnost_blok_istorija :: pracenje_insert [INSERT] roles={authenticated}
--   CHECK: (EXISTS ( SELECT 1 FROM production.operativna_aktivnost oa WHERE ((oa.id = operativna_aktivnost_blok_istorija.aktivnost_id) AND production.can_edit_pracenje(oa.projekat_id, oa.radni_nalog_id))))
-- production.operativna_aktivnost_blok_istorija :: pracenje_select [SELECT] roles={authenticated}
--   USING: true
-- production.operativna_aktivnost_blok_istorija :: pracenje_update [UPDATE] roles={authenticated}
--   USING: (EXISTS ( SELECT 1 FROM production.operativna_aktivnost oa WHERE ((oa.id = operativna_aktivnost_blok_istorija.aktivnost_id) AND production.can_edit_pracenje(oa.projekat_id, oa.radni_nalog_id))))
--   CHECK: (EXISTS ( SELECT 1 FROM production.operativna_aktivnost oa WHERE ((oa.id = operativna_aktivnost_blok_istorija.aktivnost_id) AND production.can_edit_pracenje(oa.projekat_id, oa.radni_nalog_id))))
-- production.operativna_aktivnost_pozicija :: pracenje_delete [DELETE] roles={authenticated}
--   USING: (EXISTS ( SELECT 1 FROM production.operativna_aktivnost oa WHERE ((oa.id = operativna_aktivnost_pozicija.aktivnost_id) AND production.can_edit_pracenje(oa.projekat_id, oa.radni_nalog_id))))
-- production.operativna_aktivnost_pozicija :: pracenje_insert [INSERT] roles={authenticated}
--   CHECK: (EXISTS ( SELECT 1 FROM production.operativna_aktivnost oa WHERE ((oa.id = operativna_aktivnost_pozicija.aktivnost_id) AND production.can_edit_pracenje(oa.projekat_id, oa.radni_nalog_id))))
-- production.operativna_aktivnost_pozicija :: pracenje_select [SELECT] roles={authenticated}
--   USING: true
-- production.operativna_aktivnost_pozicija :: pracenje_update [UPDATE] roles={authenticated}
--   USING: (EXISTS ( SELECT 1 FROM production.operativna_aktivnost oa WHERE ((oa.id = operativna_aktivnost_pozicija.aktivnost_id) AND production.can_edit_pracenje(oa.projekat_id, oa.radni_nalog_id))))
--   CHECK: (EXISTS ( SELECT 1 FROM production.operativna_aktivnost oa WHERE ((oa.id = operativna_aktivnost_pozicija.aktivnost_id) AND production.can_edit_pracenje(oa.projekat_id, oa.radni_nalog_id))))
-- production.pracenje_manual_overrides :: pracenje_ovr_delete_managers [DELETE] roles={authenticated}
--   USING: can_manage_predmet_aktivacija()
-- production.pracenje_manual_overrides :: pracenje_ovr_insert_managers [INSERT] roles={authenticated}
--   CHECK: can_manage_predmet_aktivacija()
-- production.pracenje_manual_overrides :: pracenje_ovr_select_auth [SELECT] roles={authenticated}
--   USING: true
-- production.pracenje_manual_overrides :: pracenje_ovr_update_managers [UPDATE] roles={authenticated}
--   USING: can_manage_predmet_aktivacija()
--   CHECK: can_manage_predmet_aktivacija()
-- production.pracenje_parent_override :: pracenje_par_del_mgr [DELETE] roles={authenticated}
--   USING: can_manage_predmet_aktivacija()
-- production.pracenje_parent_override :: pracenje_par_ins_mgr [INSERT] roles={authenticated}
--   CHECK: can_manage_predmet_aktivacija()
-- production.pracenje_parent_override :: pracenje_par_select_auth [SELECT] roles={authenticated}
--   USING: true
-- production.pracenje_parent_override :: pracenje_par_upd_mgr [UPDATE] roles={authenticated}
--   USING: can_manage_predmet_aktivacija()
--   CHECK: can_manage_predmet_aktivacija()
-- production.pracenje_proizvodnje_napomene :: pracenje_nap_delete_managers [DELETE] roles={authenticated}
--   USING: can_manage_predmet_aktivacija()
-- production.pracenje_proizvodnje_napomene :: pracenje_nap_insert_managers [INSERT] roles={authenticated}
--   CHECK: can_manage_predmet_aktivacija()
-- production.pracenje_proizvodnje_napomene :: pracenje_nap_select_auth [SELECT] roles={authenticated}
--   USING: true
-- production.pracenje_proizvodnje_napomene :: pracenje_nap_update_managers [UPDATE] roles={authenticated}
--   USING: can_manage_predmet_aktivacija()
--   CHECK: can_manage_predmet_aktivacija()
-- production.predmet_aktivacija :: predmet_aktivacija_delete_managers [DELETE] roles={authenticated}
--   USING: can_manage_predmet_aktivacija()
-- production.predmet_aktivacija :: predmet_aktivacija_insert_managers [INSERT] roles={authenticated}
--   CHECK: can_manage_predmet_aktivacija()
-- production.predmet_aktivacija :: predmet_aktivacija_select_auth [SELECT] roles={authenticated}
--   USING: true
-- production.predmet_aktivacija :: predmet_aktivacija_update_managers [UPDATE] roles={authenticated}
--   USING: can_manage_predmet_aktivacija()
--   CHECK: can_manage_predmet_aktivacija()
-- production.predmet_plan_prioritet :: predmet_plan_prioritet_select_authenticated [SELECT] roles={authenticated}
--   USING: true
-- production.predmet_plan_prioritet_audit :: ppp_audit_read [SELECT] roles={authenticated}
--   USING: true
-- production.predmet_prioritet :: predmet_prioritet_delete_admin [DELETE] roles={authenticated}
--   USING: current_user_is_admin()
-- production.predmet_prioritet :: predmet_prioritet_insert_admin [INSERT] roles={authenticated}
--   CHECK: current_user_is_admin()
-- production.predmet_prioritet :: predmet_prioritet_select_authenticated [SELECT] roles={authenticated}
--   USING: true
-- production.predmet_prioritet :: predmet_prioritet_update_admin [UPDATE] roles={authenticated}
--   USING: current_user_is_admin()
--   CHECK: current_user_is_admin()
-- production.prijava_rada :: pracenje_delete [DELETE] roles={authenticated}
--   USING: (EXISTS ( SELECT 1 FROM production.radni_nalog rn WHERE ((rn.id = prijava_rada.radni_nalog_id) AND production.can_edit_pracenje(rn.projekat_id, rn.id))))
-- production.prijava_rada :: pracenje_insert [INSERT] roles={authenticated}
--   CHECK: (EXISTS ( SELECT 1 FROM production.radni_nalog rn WHERE ((rn.id = prijava_rada.radni_nalog_id) AND production.can_edit_pracenje(rn.projekat_id, rn.id))))
-- production.prijava_rada :: pracenje_select [SELECT] roles={authenticated}
--   USING: true
-- production.prijava_rada :: pracenje_update [UPDATE] roles={authenticated}
--   USING: (EXISTS ( SELECT 1 FROM production.radni_nalog rn WHERE ((rn.id = prijava_rada.radni_nalog_id) AND production.can_edit_pracenje(rn.projekat_id, rn.id))))
--   CHECK: (EXISTS ( SELECT 1 FROM production.radni_nalog rn WHERE ((rn.id = prijava_rada.radni_nalog_id) AND production.can_edit_pracenje(rn.projekat_id, rn.id))))
-- production.radni_nalog :: pracenje_delete [DELETE] roles={authenticated}
--   USING: production.can_edit_pracenje(projekat_id, id)
-- production.radni_nalog :: pracenje_insert [INSERT] roles={authenticated}
--   CHECK: production.can_edit_pracenje(projekat_id, id)
-- production.radni_nalog :: pracenje_select [SELECT] roles={authenticated}
--   USING: true
-- production.radni_nalog :: pracenje_update [UPDATE] roles={authenticated}
--   USING: production.can_edit_pracenje(projekat_id, id)
--   CHECK: production.can_edit_pracenje(projekat_id, id)
-- production.radni_nalog_lansiranje :: pracenje_delete [DELETE] roles={authenticated}
--   USING: (EXISTS ( SELECT 1 FROM production.radni_nalog rn WHERE ((rn.id = radni_nalog_lansiranje.radni_nalog_id) AND production.can_edit_pracenje(rn.projekat_id, rn.id))))
-- production.radni_nalog_lansiranje :: pracenje_insert [INSERT] roles={authenticated}
--   CHECK: (EXISTS ( SELECT 1 FROM production.radni_nalog rn WHERE ((rn.id = radni_nalog_lansiranje.radni_nalog_id) AND production.can_edit_pracenje(rn.projekat_id, rn.id))))
-- production.radni_nalog_lansiranje :: pracenje_select [SELECT] roles={authenticated}
--   USING: true
-- production.radni_nalog_lansiranje :: pracenje_update [UPDATE] roles={authenticated}
--   USING: (EXISTS ( SELECT 1 FROM production.radni_nalog rn WHERE ((rn.id = radni_nalog_lansiranje.radni_nalog_id) AND production.can_edit_pracenje(rn.projekat_id, rn.id))))
--   CHECK: (EXISTS ( SELECT 1 FROM production.radni_nalog rn WHERE ((rn.id = radni_nalog_lansiranje.radni_nalog_id) AND production.can_edit_pracenje(rn.projekat_id, rn.id))))
-- production.radni_nalog_pozicija :: pracenje_delete [DELETE] roles={authenticated}
--   USING: (EXISTS ( SELECT 1 FROM production.radni_nalog rn WHERE ((rn.id = radni_nalog_pozicija.radni_nalog_id) AND production.can_edit_pracenje(rn.projekat_id, rn.id))))
-- production.radni_nalog_pozicija :: pracenje_insert [INSERT] roles={authenticated}
--   CHECK: (EXISTS ( SELECT 1 FROM production.radni_nalog rn WHERE ((rn.id = radni_nalog_pozicija.radni_nalog_id) AND production.can_edit_pracenje(rn.projekat_id, rn.id))))
-- production.radni_nalog_pozicija :: pracenje_select [SELECT] roles={authenticated}
--   USING: true
-- production.radni_nalog_pozicija :: pracenje_update [UPDATE] roles={authenticated}
--   USING: (EXISTS ( SELECT 1 FROM production.radni_nalog rn WHERE ((rn.id = radni_nalog_pozicija.radni_nalog_id) AND production.can_edit_pracenje(rn.projekat_id, rn.id))))
--   CHECK: (EXISTS ( SELECT 1 FROM production.radni_nalog rn WHERE ((rn.id = radni_nalog_pozicija.radni_nalog_id) AND production.can_edit_pracenje(rn.projekat_id, rn.id))))
-- production.radni_nalog_saglasnost :: pracenje_delete [DELETE] roles={authenticated}
--   USING: (EXISTS ( SELECT 1 FROM production.radni_nalog rn WHERE ((rn.id = radni_nalog_saglasnost.radni_nalog_id) AND production.can_edit_pracenje(rn.projekat_id, rn.id))))
-- production.radni_nalog_saglasnost :: pracenje_insert [INSERT] roles={authenticated}
--   CHECK: (EXISTS ( SELECT 1 FROM production.radni_nalog rn WHERE ((rn.id = radni_nalog_saglasnost.radni_nalog_id) AND production.can_edit_pracenje(rn.projekat_id, rn.id))))
-- production.radni_nalog_saglasnost :: pracenje_select [SELECT] roles={authenticated}
--   USING: true
-- production.radni_nalog_saglasnost :: pracenje_update [UPDATE] roles={authenticated}
--   USING: (EXISTS ( SELECT 1 FROM production.radni_nalog rn WHERE ((rn.id = radni_nalog_saglasnost.radni_nalog_id) AND production.can_edit_pracenje(rn.projekat_id, rn.id))))
--   CHECK: (EXISTS ( SELECT 1 FROM production.radni_nalog rn WHERE ((rn.id = radni_nalog_saglasnost.radni_nalog_id) AND production.can_edit_pracenje(rn.projekat_id, rn.id))))
-- production.tp_operacija :: pracenje_delete [DELETE] roles={authenticated}
--   USING: (EXISTS ( SELECT 1 FROM production.radni_nalog rn WHERE ((rn.id = tp_operacija.radni_nalog_id) AND production.can_edit_pracenje(rn.projekat_id, rn.id))))
-- production.tp_operacija :: pracenje_insert [INSERT] roles={authenticated}
--   CHECK: (EXISTS ( SELECT 1 FROM production.radni_nalog rn WHERE ((rn.id = tp_operacija.radni_nalog_id) AND production.can_edit_pracenje(rn.projekat_id, rn.id))))
-- production.tp_operacija :: pracenje_select [SELECT] roles={authenticated}
--   USING: true
-- production.tp_operacija :: pracenje_update [UPDATE] roles={authenticated}
--   USING: (EXISTS ( SELECT 1 FROM production.radni_nalog rn WHERE ((rn.id = tp_operacija.radni_nalog_id) AND production.can_edit_pracenje(rn.projekat_id, rn.id))))
--   CHECK: (EXISTS ( SELECT 1 FROM production.radni_nalog rn WHERE ((rn.id = tp_operacija.radni_nalog_id) AND production.can_edit_pracenje(rn.projekat_id, rn.id))))
--
-- public.montaza_ai_settings :: montaza_ai_settings_select [SELECT] roles={authenticated}
--   USING: true
-- public.montaza_izvestaj_fotke :: montaza_izv_fotke_delete [DELETE] roles={authenticated}
--   USING: (EXISTS ( SELECT 1 FROM montaza_izvestaji i WHERE ((i.id = montaza_izvestaj_fotke.izvestaj_id) AND ((i.autor_user_id = auth.uid()) OR current_user_is_management() OR current_user_is_admin()))))
-- public.montaza_izvestaj_fotke :: montaza_izv_fotke_insert [INSERT] roles={authenticated}
--   CHECK: (EXISTS ( SELECT 1 FROM montaza_izvestaji i WHERE ((i.id = montaza_izvestaj_fotke.izvestaj_id) AND ((i.autor_user_id = auth.uid()) OR current_user_is_management() OR current_user_is_admin()))))
-- public.montaza_izvestaj_fotke :: montaza_izv_fotke_select [SELECT] roles={authenticated}
--   USING: true
-- public.montaza_izvestaji :: montaza_izv_delete [DELETE] roles={authenticated}
--   USING: ((autor_user_id = auth.uid()) OR current_user_is_management() OR current_user_is_admin())
-- public.montaza_izvestaji :: montaza_izv_insert [INSERT] roles={authenticated}
--   CHECK: (autor_user_id = auth.uid())
-- public.montaza_izvestaji :: montaza_izv_select [SELECT] roles={authenticated}
--   USING: true
-- public.montaza_izvestaji :: montaza_izv_update [UPDATE] roles={authenticated}
--   USING: ((autor_user_id = auth.uid()) OR current_user_is_management() OR current_user_is_admin())
--   CHECK: ((autor_user_id = auth.uid()) OR current_user_is_management() OR current_user_is_admin())
-- public.phases :: phases_delete [DELETE] roles={authenticated}
--   USING: has_edit_role(project_id)
-- public.phases :: phases_insert [INSERT] roles={authenticated}
--   CHECK: has_edit_role(project_id)
-- public.phases :: phases_modify_pm_only [ALL] roles={authenticated}
--   USING: current_user_can_edit()
--   CHECK: current_user_can_edit()
-- public.phases :: phases_select [SELECT] roles={authenticated}
--   USING: true
-- public.phases :: phases_select_all_auth [SELECT] roles={authenticated}
--   USING: true
-- public.phases :: phases_update [UPDATE] roles={authenticated}
--   USING: has_edit_role(project_id)
--   CHECK: has_edit_role(project_id)
-- public.production_active_work_orders :: production active wo: read for authenticated [SELECT] roles={authenticated}
--   USING: true
-- public.production_active_work_orders :: production active wo: write for plan editors [ALL] roles={authenticated}
--   USING: can_edit_plan_proizvodnje()
--   CHECK: can_edit_plan_proizvodnje()
-- public.production_auto_cooperation_groups :: pacg_delete_never [DELETE] roles={authenticated}
--   USING: false
-- public.production_auto_cooperation_groups :: pacg_insert_admin [INSERT] roles={authenticated}
--   CHECK: current_user_is_admin()
-- public.production_auto_cooperation_groups :: pacg_read_authenticated [SELECT] roles={authenticated}
--   USING: true
-- public.production_auto_cooperation_groups :: pacg_update_admin [UPDATE] roles={authenticated}
--   USING: current_user_is_admin()
--   CHECK: current_user_is_admin()
-- public.production_drawings :: pd_delete_admin_pm [DELETE] roles={authenticated}
--   USING: can_edit_plan_proizvodnje()
-- public.production_drawings :: pd_insert_admin_pm [INSERT] roles={authenticated}
--   CHECK: can_edit_plan_proizvodnje()
-- public.production_drawings :: pd_read_authenticated [SELECT] roles={authenticated}
--   USING: true
-- public.production_drawings :: pd_update_admin_pm [UPDATE] roles={authenticated}
--   USING: can_edit_plan_proizvodnje()
--   CHECK: can_edit_plan_proizvodnje()
-- public.production_overlays :: po_delete_admin_pm [DELETE] roles={authenticated}
--   USING: can_edit_plan_proizvodnje()
-- public.production_overlays :: po_insert_admin_pm [INSERT] roles={authenticated}
--   CHECK: can_edit_plan_proizvodnje()
-- public.production_overlays :: po_read_authenticated [SELECT] roles={authenticated}
--   USING: true
-- public.production_overlays :: po_update_admin_pm [UPDATE] roles={authenticated}
--   USING: can_edit_plan_proizvodnje()
--   CHECK: can_edit_plan_proizvodnje()
-- public.production_overlays_history :: poh_no_client_delete [DELETE] roles={authenticated}
--   USING: false
-- public.production_overlays_history :: poh_no_client_update [UPDATE] roles={authenticated}
--   USING: false
--   CHECK: false
-- public.production_overlays_history :: poh_no_client_write [INSERT] roles={authenticated}
--   CHECK: false
-- public.production_overlays_history :: poh_select_authenticated [SELECT] roles={authenticated}
--   USING: true
-- public.production_reassign_audit :: pra_no_client_delete [DELETE] roles={authenticated}
--   USING: false
-- public.production_reassign_audit :: pra_no_client_update [UPDATE] roles={authenticated}
--   USING: false
--   CHECK: false
-- public.production_reassign_audit :: pra_no_client_write [INSERT] roles={authenticated}
--   CHECK: false
-- public.production_reassign_audit :: pra_select_force_users [SELECT] roles={authenticated}
--   USING: can_force_plan_reassign()
-- public.production_urgency_overrides :: puo_delete_never [DELETE] roles={authenticated}
--   USING: false
-- public.production_urgency_overrides :: puo_insert_plan_edit [INSERT] roles={authenticated}
--   CHECK: can_edit_plan_proizvodnje()
-- public.production_urgency_overrides :: puo_read_authenticated [SELECT] roles={authenticated}
--   USING: true
-- public.production_urgency_overrides :: puo_update_plan_edit [UPDATE] roles={authenticated}
--   USING: can_edit_plan_proizvodnje()
--   CHECK: can_edit_plan_proizvodnje()
-- public.projects :: projects_delete [DELETE] roles={authenticated}
--   USING: has_edit_role(id)
-- public.projects :: projects_insert [INSERT] roles={authenticated}
--   CHECK: has_edit_role()
-- public.projects :: projects_modify_pm_only [ALL] roles={authenticated}
--   USING: current_user_can_edit()
--   CHECK: current_user_can_edit()
-- public.projects :: projects_select [SELECT] roles={authenticated}
--   USING: true
-- public.projects :: projects_select_all_auth [SELECT] roles={authenticated}
--   USING: true
-- public.projects :: projects_update [UPDATE] roles={authenticated}
--   USING: has_edit_role(id)
--   CHECK: has_edit_role(id)
-- public.projekt_bigtehn_rn :: pbr_select [SELECT] roles={authenticated}
--   USING: true
-- public.projekt_bigtehn_rn :: pbr_write [ALL] roles={authenticated}
--   USING: has_edit_role()
--   CHECK: has_edit_role()
-- public.work_packages :: wp_delete [DELETE] roles={authenticated}
--   USING: has_edit_role(project_id)
-- public.work_packages :: wp_insert [INSERT] roles={authenticated}
--   CHECK: has_edit_role(project_id)
-- public.work_packages :: wp_modify_pm_only [ALL] roles={authenticated}
--   USING: current_user_can_edit()
--   CHECK: current_user_can_edit()
-- public.work_packages :: wp_select [SELECT] roles={authenticated}
--   USING: true
-- public.work_packages :: wp_update [UPDATE] roles={authenticated}
--   USING: has_edit_role(project_id)
--   CHECK: has_edit_role(project_id)

-- ============================================================================
-- (B) FUNKCIJE — pg_get_functiondef, živa baza 2026-07-12
-- ============================================================================

-- ============ production._pracenje_line_is_final_control ============
CREATE OR REPLACE FUNCTION production._pracenje_line_is_final_control(p_machine_code text, p_machine_name text, p_no_procedure boolean)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'production', 'pg_temp'
AS $function$
  SELECT
    (p_machine_code IS NOT NULL AND p_machine_code ~ '^8\.3')
    OR (
      COALESCE(p_no_procedure, false)
      AND COALESCE(p_machine_name, '') ~* '(zavr|final|zav\.\s*kontr|zavrsna|kontrol)'
    );
$function$;

-- ============ production.can_edit_pracenje [SECURITY DEFINER] ============
CREATE OR REPLACE FUNCTION production.can_edit_pracenje(p_project_id uuid DEFAULT NULL::uuid, p_rn_id uuid DEFAULT NULL::uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'production', 'public', 'pg_temp'
AS $function$
  WITH ctx AS (
    SELECT COALESCE(
      p_project_id,
      (SELECT rn.projekat_id FROM production.radni_nalog rn WHERE rn.id = p_rn_id)
    ) AS project_id
  )
  SELECT
    public.has_edit_role((SELECT project_id FROM ctx))
    OR EXISTS (
      SELECT 1
      FROM public.user_roles ur
      WHERE lower(ur.email) = lower(COALESCE(auth.jwt() ->> 'email', ''))
        AND ur.is_active = true
        AND ur.role IN ('admin', 'pm', 'menadzment')
        AND (
          ur.project_id IS NULL
          OR ur.project_id = (SELECT project_id FROM ctx)
        )
    );
$function$;

-- ============ production.ensure_radni_nalog_iz_bigtehn [SECURITY DEFINER] ============
CREATE OR REPLACE FUNCTION production.ensure_radni_nalog_iz_bigtehn(p_work_order_id bigint)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'production', 'public', 'pg_temp'
AS $function$
DECLARE
  v_id uuid;
  v_old_legacy int;
  v_rn_broj text;
  v_naziv text;
  v_kupac text;
  v_item int;
  v_rok date;
  v_nap text;
  v_wo int;
BEGIN
  IF p_work_order_id IS NULL OR p_work_order_id <= 0 THEN
    RAISE EXCEPTION 'Neispravan BigTehn radni nalog id';
  END IF;
  IF p_work_order_id > 2147483647 THEN
    RAISE EXCEPTION 'BigTehn id je predugačak za legacy_idrn (int4)';
  END IF;
  v_wo := p_work_order_id::integer;
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Moraš biti ulogovan';
  END IF;

  SELECT id INTO v_id
  FROM production.radni_nalog
  WHERE legacy_idrn = v_wo
  LIMIT 1;
  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;

  SELECT
    btrim(w.ident_broj),
    coalesce(nullif(btrim(w.naziv_dela), ''), 'RN ' || btrim(w.ident_broj)),
    nullif(btrim(coalesce(c.name, c.short_name, '')), ''),
    w.item_id::integer,
    (w.rok_izrade AT TIME ZONE 'UTC')::date,
    nullif(btrim(w.napomena), '')
  INTO v_rn_broj, v_naziv, v_kupac, v_item, v_rok, v_nap
  FROM public.bigtehn_work_orders_cache w
  LEFT JOIN public.bigtehn_customers_cache c ON c.id = w.customer_id
  WHERE w.id = p_work_order_id;

  IF v_rn_broj IS NULL OR v_rn_broj = '' THEN
    RAISE EXCEPTION 'BigTehn radni nalog % nije u cache-u ili nema ident_broj', p_work_order_id;
  END IF;

  SELECT id, legacy_idrn
  INTO v_id, v_old_legacy
  FROM production.radni_nalog
  WHERE rn_broj = v_rn_broj
  LIMIT 1;

  PERFORM set_config('row_security', 'off', true);
  BEGIN
    IF v_id IS NOT NULL THEN
      IF v_old_legacy IS NOT NULL AND v_old_legacy <> v_wo THEN
        RAISE EXCEPTION 'RN % je već povezan sa drugim BigTehn nalogom (legacy_idrn=%)', v_rn_broj, v_old_legacy;
      END IF;
      UPDATE production.radni_nalog
         SET legacy_idrn = v_wo,
             naziv = coalesce(nullif(btrim(naziv), ''), v_naziv),
             kupac_text = coalesce(kupac_text, v_kupac),
             napomena = coalesce(napomena, v_nap),
             datum_isporuke = coalesce(datum_isporuke, v_rok),
             legacy_idpredmet = coalesce(legacy_idpredmet, v_item),
             updated_at = now(),
             updated_by = auth.uid()
       WHERE id = v_id;
    ELSE
      INSERT INTO production.radni_nalog (
        projekat_id,
        rn_broj,
        naziv,
        kupac_text,
        datum_isporuke,
        rok_izrade,
        legacy_idrn,
        legacy_idpredmet,
        napomena,
        status,
        created_by,
        updated_by
      )
      VALUES (
        NULL,
        v_rn_broj,
        v_naziv,
        v_kupac,
        v_rok,
        NULL,
        v_wo,
        v_item,
        v_nap,
        'aktivan'::production.rn_status,
        auth.uid(),
        auth.uid()
      )
      RETURNING id INTO v_id;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('row_security', 'on', true);
    RAISE;
  END;
  PERFORM set_config('row_security', 'on', true);
  RETURN v_id;
END;
$function$;

-- ============ production.get_aktivni_predmeti [SECURITY DEFINER] ============
CREATE OR REPLACE FUNCTION production.get_aktivni_predmeti()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'production', 'pg_temp'
AS $function$
  WITH filtered AS (
    SELECT pa.predmet_item_id AS item_id
    FROM production.predmet_aktivacija pa
    WHERE pa.je_aktivan IS TRUE
  ),
  joined AS (
    SELECT
      f.item_id,
      i.broj_predmeta,
      i.naziv_predmeta,
      i.rok_zavrsetka,
      COALESCE(
        NULLIF(trim(both ' ' FROM c.name), ''),
        NULLIF(trim(both ' ' FROM c.short_name), ''),
        ''
      ) AS customer_name,
      p.sort_priority
    FROM filtered f
    INNER JOIN public.bigtehn_items_cache i ON i.id = f.item_id
    LEFT JOIN public.bigtehn_customers_cache c ON c.id = i.customer_id
    LEFT JOIN production.predmet_prioritet p ON p.predmet_item_id = f.item_id
  ),
  ranked AS (
    SELECT
      j.*,
      row_number() OVER (
        ORDER BY j.sort_priority ASC NULLS LAST, j.broj_predmeta ASC NULLS LAST
      )::integer AS redni_broj
    FROM joined j
  )
  SELECT COALESCE(
    (
      SELECT jsonb_agg(
        jsonb_build_object(
          'item_id', r.item_id,
          'broj_predmeta', COALESCE(r.broj_predmeta, ''),
          'naziv_predmeta', COALESCE(r.naziv_predmeta, ''),
          'customer_name', COALESCE(r.customer_name, ''),
          'rok_zavrsetka', to_jsonb(r.rok_zavrsetka),
          'sort_priority', r.sort_priority,
          'redni_broj', r.redni_broj
        )
        ORDER BY r.sort_priority ASC NULLS LAST, r.broj_predmeta ASC NULLS LAST
      )
      FROM ranked r
    ),
    '[]'::jsonb
  );
$function$;

-- ============ production.get_bigtehn_prijave_za_operaciju [SECURITY DEFINER] ============
CREATE OR REPLACE FUNCTION production.get_bigtehn_prijave_za_operaciju(p_work_order_id bigint, p_operacija integer, p_machine_code text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'production', 'public', 'pg_temp'
AS $function$
  SELECT coalesce(jsonb_agg(
    jsonb_build_object(
      'id', t.id,
      'datum', coalesce(t.finished_at, t.started_at),
      'radnik', coalesce(
        nullif(btrim(w.full_name), ''),
        nullif(btrim(w.short_name), ''),
        CASE WHEN t.worker_id IS NULL THEN '' ELSE t.worker_id::text END
      ),
      'kolicina', t.komada,
      'is_completed', t.is_completed,
      'napomena', coalesce(t.napomena, '')
    )
    ORDER BY coalesce(t.finished_at, t.started_at) DESC NULLS LAST, t.id DESC
  ), '[]'::jsonb)
  FROM public.bigtehn_tech_routing_cache t
  LEFT JOIN public.bigtehn_workers_cache w ON w.id = t.worker_id
  WHERE t.work_order_id = p_work_order_id
    AND t.operacija = p_operacija
    AND t.machine_code IS NOT DISTINCT FROM p_machine_code;
$function$;

-- ============ production.get_operativni_plan [SECURITY DEFINER] ============
CREATE OR REPLACE FUNCTION production.get_operativni_plan(p_rn_id uuid DEFAULT NULL::uuid, p_projekat_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'production', 'core', 'public', 'pg_temp'
AS $function$
DECLARE
  v_payload jsonb;
BEGIN
  IF p_rn_id IS NULL AND p_projekat_id IS NULL THEN
    RAISE EXCEPTION 'get_operativni_plan: prosledi p_rn_id ili p_projekat_id';
  END IF;

  SELECT jsonb_build_object(
    'header', (
      SELECT jsonb_build_object(
        'radni_nalog_id', rn.id,
        'projekat_id', rn.projekat_id,
        'kupac', rn.kupac_text,
        'rn_broj', rn.rn_broj,
        'masina_linija', rn.naziv,
        'datum_isporuke', rn.datum_isporuke,
        'koordinator', cr.puno_ime,
        'napomena', rn.napomena
      )
      FROM production.radni_nalog rn
      LEFT JOIN core.radnik cr ON cr.id = rn.koordinator_radnik_id
      WHERE (p_rn_id IS NULL OR rn.id = p_rn_id)
        AND (p_projekat_id IS NULL OR rn.projekat_id = p_projekat_id)
      ORDER BY rn.created_at
      LIMIT 1
    ),
    'activities', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', v.id,
        'rb', v.rb,
        'odeljenje', v.odeljenje_naziv,
        'naziv_aktivnosti', v.naziv_aktivnosti,
        'broj_tp', v.broj_tp,
        'kolicina_text', v.kolicina_text,
        'planirani_pocetak', v.planirani_pocetak,
        'planirani_zavrsetak', v.planirani_zavrsetak,
        'odgovoran', COALESCE(v.odgovoran_label, r.puno_ime, r.ime),
        'zavisi_od', COALESCE(dep.naziv_aktivnosti, v.zavisi_od_text),
        'efektivni_status', v.efektivni_status,
        'status_is_auto', v.status_is_auto,
        'status_detail', v.status_detail,
        'prioritet', v.prioritet,
        'rizik_napomena', v.rizik_napomena,
        'rezerva_dani', v.rezerva_dani,
        'kasni', v.kasni
      ) ORDER BY v.odeljenje_naziv, v.rb)
      FROM production.v_operativna_aktivnost v
      LEFT JOIN core.radnik r ON r.id = v.odgovoran_radnik_id
      LEFT JOIN production.operativna_aktivnost dep ON dep.id = v.zavisi_od_aktivnost_id
      WHERE (p_rn_id IS NULL OR v.radni_nalog_id = p_rn_id)
        AND (p_projekat_id IS NULL OR v.projekat_id = p_projekat_id)
    ), '[]'::jsonb),
    'dashboard', jsonb_build_object(
      'total', (
        SELECT jsonb_build_object(
          'ukupno', count(*),
          'zavrseno', count(*) FILTER (WHERE v.efektivni_status = 'zavrseno'),
          'u_toku', count(*) FILTER (WHERE v.efektivni_status = 'u_toku'),
          'blokirano', count(*) FILTER (WHERE v.efektivni_status = 'blokirano'),
          'nije_krenulo', count(*) FILTER (WHERE v.efektivni_status = 'nije_krenulo'),
          'najkasniji_planirani_zavrsetak', max(v.planirani_zavrsetak)
        )
        FROM production.v_operativna_aktivnost v
        WHERE (p_rn_id IS NULL OR v.radni_nalog_id = p_rn_id)
          AND (p_projekat_id IS NULL OR v.projekat_id = p_projekat_id)
      ),
      'po_odeljenjima', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'odeljenje', x.odeljenje,
          'ukupno', x.ukupno,
          'zavrseno', x.zavrseno,
          'u_toku', x.u_toku,
          'blokirano', x.blokirano,
          'nije_krenulo', x.nije_krenulo,
          'najkasniji_planirani_zavrsetak', x.najkasniji_planirani_zavrsetak
        ) ORDER BY x.odeljenje)
        FROM (
          SELECT
            v.odeljenje_naziv AS odeljenje,
            count(*) AS ukupno,
            count(*) FILTER (WHERE v.efektivni_status = 'zavrseno') AS zavrseno,
            count(*) FILTER (WHERE v.efektivni_status = 'u_toku') AS u_toku,
            count(*) FILTER (WHERE v.efektivni_status = 'blokirano') AS blokirano,
            count(*) FILTER (WHERE v.efektivni_status = 'nije_krenulo') AS nije_krenulo,
            max(v.planirani_zavrsetak) AS najkasniji_planirani_zavrsetak
          FROM production.v_operativna_aktivnost v
          WHERE (p_rn_id IS NULL OR v.radni_nalog_id = p_rn_id)
            AND (p_projekat_id IS NULL OR v.projekat_id = p_projekat_id)
          GROUP BY v.odeljenje_naziv
        ) x
      ), '[]'::jsonb)
    )
  ) INTO v_payload;

  RETURN v_payload;
END;
$function$;

-- ============ production.get_podsklopovi_predmeta [SECURITY DEFINER] ============
CREATE OR REPLACE FUNCTION production.get_podsklopovi_predmeta(p_item_id integer)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'production', 'pg_temp'
AS $function$
  SELECT COALESCE(
    (
      SELECT jsonb_agg(x.row_obj ORDER BY x.root_rn_id, x.parent_rn_id NULLS FIRST, x.ident_broj ASC)
      FROM (
        SELECT
          jsonb_build_object(
            'rn_id', s.rn_id,
            'legacy_idrn', w.id,
            'root_rn_id', s.root_rn_id,
            'ident_broj', COALESCE(w.ident_broj, ''),
            'naziv_dela', COALESCE(w.naziv_dela, ''),
            'status_rn', w.status_rn,
            'nivo', s.nivo,
            'parent_rn_id', s.parent_rn_id,
            'broj_komada', s.broj_komada,
            'is_mes_aktivan', EXISTS (
              SELECT 1
              FROM public.v_active_bigtehn_work_orders a
              WHERE a.id = s.rn_id
            ),
            'path_idrn', to_jsonb(s.path_idrn)
          ) AS row_obj,
          s.root_rn_id,
          s.parent_rn_id,
          w.ident_broj
        FROM public.v_bigtehn_rn_struktura s
        INNER JOIN public.bigtehn_work_orders_cache w ON w.id = s.rn_id
        WHERE s.predmet_item_id = p_item_id::bigint
      ) x
    ),
    '[]'::jsonb
  );
$function$;

-- ============ production.get_pracenje_portfolio [SECURITY DEFINER] ============
CREATE OR REPLACE FUNCTION production.get_pracenje_portfolio(p_lot_qty integer DEFAULT 12)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'production', 'core', 'pg_temp'
AS $function$
DECLARE
  v_lot int := CASE WHEN p_lot_qty IS NULL OR p_lot_qty <= 0 THEN 12 ELSE least(greatest(p_lot_qty,1),100000) END;
  v_today date := (current_timestamp AT TIME ZONE 'Europe/Belgrade')::date;
  v_items jsonb := '[]'::jsonb;
  v_kpi jsonb;
  v_generated timestamptz := now();
BEGIN
  WITH active AS (
    SELECT pa.predmet_item_id AS item_id, p.sort_priority, i.broj_predmeta, i.naziv_predmeta, i.rok_zavrsetka,
      COALESCE(NULLIF(trim(both ' ' FROM c.name),''), NULLIF(trim(both ' ' FROM c.short_name),''),'') AS komitent
    FROM production.predmet_aktivacija pa
    LEFT JOIN production.predmet_prioritet p ON p.predmet_item_id=pa.predmet_item_id
    INNER JOIN public.bigtehn_items_cache i ON i.id=pa.predmet_item_id
    LEFT JOIN public.bigtehn_customers_cache c ON c.id=i.customer_id
    WHERE pa.je_aktivan IS TRUE
  ),
  nodes AS (
    SELECT DISTINCT ON (s.predmet_item_id, s.rn_id) s.predmet_item_id AS item_id, s.rn_id
    FROM public.v_bigtehn_rn_struktura s JOIN active a ON a.item_id=s.predmet_item_id
    ORDER BY s.predmet_item_id, s.rn_id
  ),
  wo AS (
    SELECT n.item_id, n.rn_id, w.komada, w.rok_izrade, w.broj_crteza,
      coalesce(nullif(trim(both ' ' FROM w.naziv_dela),''), w.ident_broj::text) AS naziv
    FROM nodes n JOIN public.bigtehn_work_orders_cache w ON w.id=n.rn_id
  ),
  wo_ids AS (SELECT DISTINCT rn_id FROM wo),
  rn_local AS (SELECT r.id AS rn_uuid, r.legacy_idrn::bigint AS bigtehn_id FROM production.radni_nalog r WHERE r.legacy_idrn IS NOT NULL),
  bt_lines AS (
    SELECT l.work_order_id AS rn_id, l.operacija, l.machine_code,
      production._pracenje_line_is_final_control(l.machine_code,m.name,m.no_procedure) AS is_final
    FROM public.bigtehn_work_order_lines_cache l
    JOIN wo_ids wi ON wi.rn_id=l.work_order_id
    LEFT JOIN public.bigtehn_machines_cache m ON m.rj_code=l.machine_code
  ),
  bt_final AS (
    SELECT bl.rn_id, sum(t.komada)::numeric AS zav
    FROM bt_lines bl JOIN public.bigtehn_tech_routing_cache t
      ON t.work_order_id=bl.rn_id AND t.operacija=bl.operacija AND t.machine_code IS NOT DISTINCT FROM bl.machine_code AND t.is_completed IS TRUE
    WHERE bl.is_final GROUP BY bl.rn_id
  ),
  bt_hasfinal AS (SELECT rn_id, bool_or(is_final) AS has_final FROM bt_lines GROUP BY rn_id),
  bt_op AS (
    SELECT bl.rn_id, bl.operacija, bl.machine_code, COALESCE(sum(t.komada),0)::numeric AS done_all
    FROM bt_lines bl LEFT JOIN public.bigtehn_tech_routing_cache t
      ON t.work_order_id=bl.rn_id AND t.operacija=bl.operacija AND t.machine_code IS NOT DISTINCT FROM bl.machine_code
    GROUP BY bl.rn_id, bl.operacija, bl.machine_code
  ),
  local_final AS (
    SELECT rl.bigtehn_id AS rn_id,
      (SELECT vpp.prijavljeno_komada FROM production.tp_operacija tp
       JOIN production.v_pozicija_progress vpp ON vpp.tp_operacija_id=tp.id
       LEFT JOIN core.work_center wc ON wc.id=tp.work_center_id
       LEFT JOIN core.odeljenje od ON od.id=wc.odeljenje_id
       WHERE tp.radni_nalog_id=rl.rn_uuid AND (od.kod='KK' OR tp.naziv ~* '(zavr|final|zav\.?\s*kontr|zavrsna|kontrol)')
       ORDER BY CASE WHEN od.kod='KK' THEN 0 ELSE 1 END, tp.prioritet ASC NULLS LAST LIMIT 1) AS zav
    FROM rn_local rl JOIN wo_ids wi ON wi.rn_id=rl.bigtehn_id
  ),
  local_hasfinal AS (
    SELECT rl.bigtehn_id AS rn_id,
      EXISTS(SELECT 1 FROM production.tp_operacija tp2
        LEFT JOIN core.work_center wc2 ON wc2.id=tp2.work_center_id
        LEFT JOIN core.odeljenje od2 ON od2.id=wc2.odeljenje_id
        WHERE tp2.radni_nalog_id=rl.rn_uuid AND (od2.kod='KK' OR tp2.naziv ~* '(zavr|final|zav\.?\s*kontr|zavrsna|kontrol)')) AS has_final
    FROM rn_local rl JOIN wo_ids wi ON wi.rn_id=rl.bigtehn_id
  ),
  drw AS (SELECT DISTINCT nullif(trim(both ' ' FROM d.drawing_no),'') AS dno FROM public.bigtehn_drawings_cache d WHERE d.removed_at IS NULL),
  node_calc AS (
    SELECT w.item_id, w.rn_id, w.komada, w.rok_izrade, w.broj_crteza, w.naziv, rl.rn_uuid,
      CASE WHEN rl.rn_uuid IS NOT NULL AND lf.zav IS NOT NULL THEN lf.zav WHEN bf.zav IS NOT NULL THEN bf.zav ELSE NULL END AS zavrsena,
      CASE WHEN rl.rn_uuid IS NOT NULL THEN COALESCE(lhf.has_final,false) ELSE COALESCE(bhf.has_final,false) END AS has_final,
      (dd.dno IS NOT NULL) AS has_crtez
    FROM wo w
    LEFT JOIN rn_local rl ON rl.bigtehn_id=w.rn_id
    LEFT JOIN bt_final bf ON bf.rn_id=w.rn_id
    LEFT JOIN bt_hasfinal bhf ON bhf.rn_id=w.rn_id
    LEFT JOIN local_final lf ON lf.rn_id=w.rn_id
    LEFT JOIN local_hasfinal lhf ON lhf.rn_id=w.rn_id
    LEFT JOIN drw dd ON dd.dno = nullif(trim(both ' ' FROM split_part(w.broj_crteza::text,'_',1)),'')
  ),
  op_agg AS (
    SELECT w.item_id, avg(LEAST(o.done_all / NULLIF(w.komada,0), 1)) AS op_ratio
    FROM bt_op o JOIN wo w ON w.rn_id=o.rn_id GROUP BY w.item_id
  ),
  bn AS (
    SELECT DISTINCT ON (nc.item_id) nc.item_id, nc.naziv,
      round((coalesce(nc.zavrsena,0)/nc.komada)*100)::int AS pct
    FROM node_calc nc
    WHERE nc.komada IS NOT NULL AND nc.komada>0 AND coalesce(nc.zavrsena,0) < nc.komada
    ORDER BY nc.item_id, (coalesce(nc.zavrsena,0)/nc.komada) ASC, nc.komada DESC
  ),
  agg AS (
    SELECT item_id,
      count(*) AS total_rows,
      COALESCE(sum(komada),0)::numeric AS lans,
      COALESCE(sum(zavrsena),0)::numeric AS zav,
      count(*) FILTER (WHERE rok_izrade IS NOT NULL AND (rok_izrade AT TIME ZONE 'UTC')::date < v_today AND coalesce(zavrsena,0) < coalesce(komada,0)) AS kasni,
      count(*) FILTER (WHERE komada IS NOT NULL AND coalesce(zavrsena,0) < komada) AS nije_kompletirano,
      count(*) FILTER (WHERE broj_crteza IS NULL OR trim(both ' ' FROM broj_crteza::text)='') AS nema_tp,
      count(*) FILTER (WHERE NOT has_crtez) AS nema_crtez,
      count(*) FILTER (WHERE NOT has_final) AS nema_kk
    FROM node_calc GROUP BY item_id
  ),
  items AS (
    SELECT a.item_id, a.sort_priority, a.broj_predmeta,
      jsonb_build_object(
        'item_id', a.item_id,
        'broj_predmeta', COALESCE(a.broj_predmeta,''),
        'naziv_predmeta', COALESCE(a.naziv_predmeta,''),
        'komitent', a.komitent,
        'rok_zavrsetka', to_jsonb(a.rok_zavrsetka),
        'sort_priority', a.sort_priority,
        'total_rows', COALESCE(g.total_rows,0),
        'total_lansirano', COALESCE(g.lans,0),
        'total_zavrseno', COALESCE(g.zav,0),
        'count_kasni', COALESCE(g.kasni,0),
        'count_nije_kompletirano', COALESCE(g.nije_kompletirano,0),
        'count_nema_tp', COALESCE(g.nema_tp,0),
        'count_nema_crtez', COALESCE(g.nema_crtez,0),
        'count_nema_zavrsnu_kontrolu', COALESCE(g.nema_kk,0),
        'problemi', COALESCE(g.nema_tp,0)+COALESCE(g.nema_crtez,0)+COALESCE(g.nema_kk,0),
        'kk_pct', CASE WHEN COALESCE(g.lans,0) > 0 THEN round((g.zav/g.lans)*100)::int ELSE NULL END,
        'op_pct', CASE WHEN op.op_ratio IS NULL THEN NULL ELSE round(op.op_ratio*100)::int END,
        'usko_grlo', CASE WHEN b.naziv IS NULL THEN NULL ELSE jsonb_build_object('naziv', b.naziv, 'pct', b.pct) END,
        'dani_do_roka', CASE WHEN a.rok_zavrsetka IS NULL THEN NULL ELSE (a.rok_zavrsetka::date - v_today) END,
        'status', CASE
          WHEN COALESCE(g.total_rows,0) = 0 THEN 'bez_podataka'
          WHEN COALESCE(g.kasni,0) > 0 THEN 'kasni'
          WHEN COALESCE(g.lans,0) > 0 AND COALESCE(g.zav,0) >= g.lans THEN 'zavrseno'
          WHEN COALESCE(op.op_ratio,0) = 0 THEN 'na_cekanju'
          ELSE 'u_toku'
        END
      ) AS obj
    FROM active a
    LEFT JOIN agg g ON g.item_id=a.item_id
    LEFT JOIN op_agg op ON op.item_id=a.item_id
    LEFT JOIN bn b ON b.item_id=a.item_id
  )
  SELECT
    COALESCE(jsonb_agg(i.obj ORDER BY i.sort_priority ASC NULLS LAST, i.broj_predmeta ASC NULLS LAST), '[]'::jsonb),
    jsonb_build_object(
      'ukupno_predmeta', count(*)::int,
      'u_toku', count(*) FILTER (WHERE i.obj->>'status'='u_toku')::int,
      'kasni', count(*) FILTER (WHERE i.obj->>'status'='kasni')::int,
      'zavrseno', count(*) FILTER (WHERE i.obj->>'status'='zavrseno')::int,
      'na_cekanju', count(*) FILTER (WHERE i.obj->>'status'='na_cekanju')::int,
      'bez_podataka', count(*) FILTER (WHERE i.obj->>'status'='bez_podataka')::int,
      'problemi_total', COALESCE(sum((i.obj->>'problemi')::int),0)::int,
      'predmeti_sa_problemima', count(*) FILTER (WHERE (i.obj->>'problemi')::int > 0)::int,
      'prosecan_op_napredak', COALESCE(round(avg((i.obj->>'op_pct')::numeric)),0)::int
    )
  INTO v_items, v_kpi
  FROM items i;

  RETURN jsonb_build_object('lot_qty', v_lot, 'generated_at', to_jsonb(v_generated), 'kpi', v_kpi, 'items', v_items);
END;
$function$;

-- ============ production.get_pracenje_rn [SECURITY DEFINER] ============
CREATE OR REPLACE FUNCTION production.get_pracenje_rn(p_rn_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'production', 'core', 'pdm', 'public', 'pg_temp'
AS $function$
DECLARE
  v_payload jsonb;
  v_header jsonb;
  v_legacy integer;
  v_local_poz integer;
BEGIN
  SELECT
    jsonb_build_object(
      'radni_nalog_id', rn.id,
      'rn_broj', rn.rn_broj,
      'projekat_id', rn.projekat_id,
      'projekat_naziv', p.project_name,
      'kupac', rn.kupac_text,
      'datum_isporuke', rn.datum_isporuke,
      'koordinator', cr.puno_ime,
      'napomena', rn.napomena
    ),
    rn.legacy_idrn
  INTO v_header, v_legacy
  FROM production.radni_nalog rn
  LEFT JOIN public.projects p ON p.id = rn.projekat_id
  LEFT JOIN core.radnik cr ON cr.id = rn.koordinator_radnik_id
  WHERE rn.id = p_rn_id;

  IF v_header IS NULL THEN
    RAISE EXCEPTION 'Radni nalog % ne postoji', p_rn_id;
  END IF;

  SELECT count(*) INTO v_local_poz
  FROM production.radni_nalog_pozicija
  WHERE radni_nalog_id = p_rn_id;

  IF v_local_poz > 0 OR v_legacy IS NULL THEN
    SELECT jsonb_build_object(
      'header', v_header,
      'source', 'local',
      'summary', jsonb_build_object(
        'pozicija_total', v_local_poz,
        'operacija_total', (SELECT count(*) FROM production.tp_operacija WHERE radni_nalog_id = p_rn_id),
        'nije_krenulo', (SELECT count(*) FROM production.v_pozicija_progress WHERE radni_nalog_id = p_rn_id AND auto_status = 'nije_krenulo'),
        'u_toku', (SELECT count(*) FROM production.v_pozicija_progress WHERE radni_nalog_id = p_rn_id AND auto_status = 'u_toku'),
        'zavrseno', (SELECT count(*) FROM production.v_pozicija_progress WHERE radni_nalog_id = p_rn_id AND auto_status = 'zavrseno'),
        'blokirano', (SELECT count(*) FROM production.v_pozicija_progress WHERE radni_nalog_id = p_rn_id AND auto_status = 'blokirano'),
        'lansirana_kolicina', (
          SELECT sum(rnp.kolicina_plan)
          FROM production.radni_nalog_pozicija rnp
          WHERE rnp.radni_nalog_id = p_rn_id
            AND rnp.parent_id IS NULL
        ),
        'zavrsena_kolicina_kk', (
          SELECT vpp.prijavljeno_komada
          FROM production.tp_operacija tp
          INNER JOIN production.v_pozicija_progress vpp ON vpp.tp_operacija_id = tp.id
          LEFT JOIN core.work_center wc ON wc.id = tp.work_center_id
          LEFT JOIN core.odeljenje od ON od.id = wc.odeljenje_id
          WHERE tp.radni_nalog_id = p_rn_id
            AND (
              od.kod = 'KK'
              OR tp.naziv ~* '(zavr|final|zav\.?\s*kontr|zavrsna|kontrol)'
            )
          ORDER BY
            CASE WHEN od.kod = 'KK' THEN 0 ELSE 1 END,
            tp.prioritet ASC NULLS LAST
          LIMIT 1
        )
      ),
      'positions', COALESCE((
        SELECT jsonb_agg(pos.payload ORDER BY pos.sort_order, pos.naziv)
        FROM (
          SELECT
            rnp.sort_order,
            rnp.naziv,
            jsonb_build_object(
              'id', rnp.id,
              'parent_id', rnp.parent_id,
              'sifra_pozicije', rnp.sifra_pozicije,
              'naziv', rnp.naziv,
              'kolicina_plan', rnp.kolicina_plan,
              'progress_pct', COALESCE(ROUND(avg(vpp.progress_pct))::integer, 0),
              'operations', COALESCE(jsonb_agg(
                jsonb_build_object(
                  'tp_operacija_id', tp.id,
                  'operacija_kod', tp.operacija_kod,
                  'naziv', tp.naziv,
                  'work_center', wc.kod,
                  'planirano_komada', COALESCE(vpp.planirano_komada, rnp.kolicina_plan),
                  'prijavljeno_komada', COALESCE(vpp.prijavljeno_komada, 0),
                  'status', COALESCE(vpp.auto_status, 'nije_krenulo'::production.aktivnost_status),
                  'poslednja_prijava_at', vpp.poslednja_prijava_at
                )
                ORDER BY tp.prioritet, tp.operacija_kod
              ) FILTER (WHERE tp.id IS NOT NULL), '[]'::jsonb),
              'children', '[]'::jsonb
            ) AS payload
          FROM production.radni_nalog_pozicija rnp
          LEFT JOIN production.tp_operacija tp ON tp.radni_nalog_pozicija_id = rnp.id
          LEFT JOIN core.work_center wc ON wc.id = tp.work_center_id
          LEFT JOIN production.v_pozicija_progress vpp ON vpp.tp_operacija_id = tp.id
          WHERE rnp.radni_nalog_id = p_rn_id
          GROUP BY rnp.id, rnp.sort_order, rnp.naziv, rnp.parent_id, rnp.sifra_pozicije, rnp.kolicina_plan
        ) pos
      ), '[]'::jsonb)
    )
    INTO v_payload;
    RETURN v_payload;
  END IF;

  WITH RECURSIVE subtree(rn_id, parent_rn_id, nivo, path_idrn) AS (
    SELECT v_legacy::bigint, NULL::bigint, 0, ARRAY[v_legacy::bigint]
    UNION ALL
    SELECT c.child_rn_id::bigint, s.rn_id, s.nivo + 1, s.path_idrn || c.child_rn_id::bigint
    FROM subtree s
    INNER JOIN public.bigtehn_rn_components_cache c ON c.parent_rn_id = s.rn_id::integer
    WHERE s.nivo < 10
      AND NOT (c.child_rn_id::bigint = ANY (s.path_idrn))
  ),
  nodes AS (
    SELECT DISTINCT ON (s.rn_id)
      s.rn_id,
      s.parent_rn_id,
      s.nivo,
      btrim(w.ident_broj) AS ident_broj,
      w.naziv_dela,
      w.komada,
      nullif(btrim(split_part(w.broj_crteza::text, '_', 1), ' .'), '') AS drawing_code
    FROM subtree s
    INNER JOIN public.bigtehn_work_orders_cache w ON w.id = s.rn_id
    ORDER BY s.rn_id, s.nivo
  ),
  ops AS (
    SELECT
      l.work_order_id,
      l.id AS line_id,
      l.prioritet,
      l.operacija,
      l.machine_code,
      coalesce(m.name, l.machine_code, '') AS op_naziv,
      coalesce(l.machine_code, '') AS work_center,
      n.komada AS planirano,
      COALESCE(tr.sum_kom, 0) AS prijavljeno,
      COALESCE(tr.sum_kom_done, 0) AS prijavljeno_done,
      tr.last_at,
      production._pracenje_line_is_final_control(l.machine_code, m.name, m.no_procedure) AS is_fc
    FROM public.bigtehn_work_order_lines_cache l
    INNER JOIN nodes n ON n.rn_id = l.work_order_id
    LEFT JOIN public.bigtehn_machines_cache m ON m.rj_code = l.machine_code
    LEFT JOIN LATERAL (
      SELECT
        COALESCE(sum(t.komada), 0)::numeric AS sum_kom,
        COALESCE(sum(t.komada) FILTER (WHERE t.is_completed), 0)::numeric AS sum_kom_done,
        max(coalesce(t.finished_at, t.started_at)) AS last_at
      FROM public.bigtehn_tech_routing_cache t
      WHERE t.work_order_id = l.work_order_id
        AND t.operacija = l.operacija
        AND t.machine_code IS NOT DISTINCT FROM l.machine_code
    ) tr ON true
  ),
  ops_status AS (
    SELECT
      o.*,
      CASE
        WHEN o.planirano IS NOT NULL AND o.planirano > 0 AND o.prijavljeno_done >= o.planirano THEN 'zavrseno'
        WHEN o.prijavljeno > 0 THEN 'u_toku'
        ELSE 'nije_krenulo'
      END AS status,
      CASE
        WHEN o.planirano IS NOT NULL AND o.planirano > 0
          THEN least(100, round(100.0 * o.prijavljeno / o.planirano))::integer
        WHEN o.prijavljeno_done > 0 THEN 100
        ELSE 0
      END AS op_pct
    FROM ops o
  ),
  op_payload AS (
    SELECT
      o.work_order_id,
      jsonb_agg(
        jsonb_build_object(
          'tp_operacija_id', 'bt-' || o.line_id::text,
          'operacija_kod', o.operacija::text,
          'naziv', o.op_naziv,
          'work_center', o.work_center,
          'planirano_komada', o.planirano,
          'prijavljeno_komada', o.prijavljeno,
          'status', o.status,
          'poslednja_prijava_at', o.last_at,
          'is_final_control', o.is_fc,
          'source', 'bigtehn',
          'bigtehn_work_order_id', o.work_order_id,
          'operacija_broj', o.operacija,
          'machine_code', o.machine_code
        )
        ORDER BY o.prioritet NULLS LAST, o.line_id
      ) AS operations,
      ROUND(avg(o.op_pct))::integer AS progress_pct,
      count(*) AS op_total,
      count(*) FILTER (WHERE o.status = 'zavrseno') AS op_zavrseno,
      count(*) FILTER (WHERE o.status = 'u_toku') AS op_u_toku,
      count(*) FILTER (WHERE o.status = 'nije_krenulo') AS op_nije_krenulo
    FROM ops_status o
    GROUP BY o.work_order_id
  ),
  pos_payload AS (
    SELECT
      n.nivo,
      n.ident_broj,
      jsonb_build_object(
        'id', n.rn_id,
        'parent_id', n.parent_rn_id,
        'sifra_pozicije', n.ident_broj,
        'naziv', coalesce(nullif(btrim(n.naziv_dela), ''), n.ident_broj),
        'kolicina_plan', n.komada,
        'drawing_no', n.drawing_code,
        'has_crtez_file', n.drawing_code IS NOT NULL AND EXISTS (
          SELECT 1 FROM public.bigtehn_drawings_cache d
          WHERE d.removed_at IS NULL
            AND (d.drawing_no = n.drawing_code OR d.drawing_no LIKE n.drawing_code || '\_%')
        ),
        'progress_pct', coalesce(o.progress_pct, 0),
        'operations', coalesce(o.operations, '[]'::jsonb),
        'children', '[]'::jsonb
      ) AS payload
    FROM nodes n
    LEFT JOIN op_payload o ON o.work_order_id = n.rn_id
  ),
  root_qty AS (
    SELECT w.komada AS lansirana_kolicina
    FROM public.bigtehn_work_orders_cache w
    WHERE w.id = v_legacy
  ),
  final_kk_qty AS (
    SELECT
      CASE
        WHEN EXISTS (
          SELECT 1
          FROM public.bigtehn_work_order_lines_cache l
          LEFT JOIN public.bigtehn_machines_cache m ON m.rj_code = l.machine_code
          WHERE l.work_order_id = v_legacy
            AND production._pracenje_line_is_final_control(l.machine_code, m.name, m.no_procedure)
        ) THEN COALESCE((
          SELECT sum(t.komada)::numeric
          FROM public.bigtehn_work_order_lines_cache l
          LEFT JOIN public.bigtehn_machines_cache m ON m.rj_code = l.machine_code
          INNER JOIN public.bigtehn_tech_routing_cache t
            ON t.work_order_id = l.work_order_id
           AND t.operacija = l.operacija
           AND t.machine_code IS NOT DISTINCT FROM l.machine_code
           AND t.is_completed IS TRUE
          WHERE l.work_order_id = v_legacy
            AND production._pracenje_line_is_final_control(l.machine_code, m.name, m.no_procedure)
        ), 0)
        ELSE NULL
      END AS zavrsena_kolicina_kk
  )
  SELECT jsonb_build_object(
    'header', v_header,
    'source', 'bigtehn',
    'summary', jsonb_build_object(
      'pozicija_total', (SELECT count(*) FROM nodes),
      'operacija_total', coalesce((SELECT sum(op_total) FROM op_payload), 0),
      'nije_krenulo', coalesce((SELECT sum(op_nije_krenulo) FROM op_payload), 0),
      'u_toku', coalesce((SELECT sum(op_u_toku) FROM op_payload), 0),
      'zavrseno', coalesce((SELECT sum(op_zavrseno) FROM op_payload), 0),
      'blokirano', 0,
      'lansirana_kolicina', (SELECT lansirana_kolicina FROM root_qty),
      'zavrsena_kolicina_kk', (SELECT zavrsena_kolicina_kk FROM final_kk_qty)
    ),
    'positions', coalesce(
      (SELECT jsonb_agg(pp.payload ORDER BY pp.nivo, pp.ident_broj) FROM pos_payload pp),
      '[]'::jsonb
    )
  )
  INTO v_payload;

  RETURN v_payload;
END;
$function$;

-- ============ production.get_predmet_pracenje_izvestaj [SECURITY DEFINER] ============
CREATE OR REPLACE FUNCTION production.get_predmet_pracenje_izvestaj(p_predmet_item_id integer, p_root_rn_id bigint DEFAULT NULL::bigint, p_lot_qty integer DEFAULT 12)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'production', 'core', 'pg_temp'
AS $function$
DECLARE
  v_lot int := CASE
    WHEN p_lot_qty IS NULL OR p_lot_qty <= 0 THEN 12
    ELSE least(greatest(p_lot_qty, 1), 100000)
  END;
  v_item public.bigtehn_items_cache%ROWTYPE;
  v_customer_name text := '';
  v_root jsonb := NULL;
  v_rows jsonb := '[]'::jsonb;
  v_summary jsonb;
  v_generated timestamptz := now();
BEGIN
  IF p_predmet_item_id IS NULL OR p_predmet_item_id <= 0 THEN
    RAISE EXCEPTION 'Neispravan predmet_item_id' USING ERRCODE = '22000';
  END IF;

  SELECT * INTO v_item FROM public.bigtehn_items_cache i WHERE i.id = p_predmet_item_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Predmet % nije u kešu', p_predmet_item_id USING ERRCODE = 'P0002';
  END IF;

  SELECT COALESCE(
    nullif(trim(both ' ' FROM c.name), ''),
    nullif(trim(both ' ' FROM c.short_name), ''),
    ''
  )
  INTO v_customer_name
  FROM public.bigtehn_customers_cache c
  WHERE c.id = v_item.customer_id;

  IF p_root_rn_id IS NOT NULL THEN
    SELECT jsonb_build_object(
      'node_id', s.rn_id,
      'naziv', coalesce(nullif(trim(both ' ' FROM w.naziv_dela), ''), w.ident_broj::text),
      'broj_crteza', coalesce(nullif(trim(both ' ' FROM w.broj_crteza::text), ''), ''),
      'tip', CASE WHEN s.nivo <= 0 THEN 'sklop' ELSE 'podsklop' END
    )
    INTO v_root
    FROM public.v_bigtehn_rn_struktura s
    INNER JOIN public.bigtehn_work_orders_cache w ON w.id = s.rn_id
    WHERE s.predmet_item_id = p_predmet_item_id::bigint
      AND s.rn_id = p_root_rn_id
    LIMIT 1;
    IF v_root IS NULL THEN
      RAISE EXCEPTION 'Koren RN % nije u strukturi predmeta %', p_root_rn_id, p_predmet_item_id
        USING ERRCODE = 'P0002';
    END IF;
  END IF;

  WITH
  nodes AS (
    SELECT s.predmet_item_id, s.root_rn_id, s.rn_id, s.parent_rn_id, s.nivo, s.broj_komada, s.path_idrn
    FROM public.v_bigtehn_rn_struktura s
    WHERE s.predmet_item_id = p_predmet_item_id::bigint
      AND p_root_rn_id IS NULL

    UNION ALL

    SELECT d.predmet_item_id, d.root_rn_id, d.rn_id, d.parent_rn_id, d.nivo, d.broj_komada, d.path_idrn
    FROM (
      WITH RECURSIVE descendants AS (
        SELECT s0.predmet_item_id, s0.root_rn_id, s0.rn_id, s0.parent_rn_id, s0.nivo, s0.broj_komada, s0.path_idrn
        FROM public.v_bigtehn_rn_struktura s0
        WHERE s0.predmet_item_id = p_predmet_item_id::bigint
          AND s0.rn_id = p_root_rn_id
        UNION ALL
        SELECT s1.predmet_item_id, s1.root_rn_id, s1.rn_id, s1.parent_rn_id, s1.nivo, s1.broj_komada, s1.path_idrn
        FROM public.v_bigtehn_rn_struktura s1
        INNER JOIN descendants dx ON s1.parent_rn_id = dx.rn_id
          AND s1.predmet_item_id = dx.predmet_item_id
          AND s1.root_rn_id = dx.root_rn_id
      )
      SELECT * FROM descendants
    ) d
    WHERE p_root_rn_id IS NOT NULL
  ),
  nodes_dedup AS (
    SELECT DISTINCT ON (rn_id) *
    FROM nodes
    ORDER BY rn_id, nivo
  ),
  wo_join AS (
    SELECT
      n.*,
      w.ident_broj,
      w.broj_crteza,
      w.naziv_dela,
      w.materijal,
      w.dimenzija_materijala,
      w.komada,
      w.rok_izrade,
      w.status_rn,
      w.datum_unosa,
      w.napomena AS wo_napomena
    FROM nodes_dedup n
    INNER JOIN public.bigtehn_work_orders_cache w ON w.id = n.rn_id
  ),
  parent_wo AS (
    SELECT
      j.*,
      pw.broj_crteza AS parent_broj_crteza
    FROM wo_join j
    LEFT JOIN public.bigtehn_work_orders_cache pw ON pw.id = j.parent_rn_id
  ),
  rn_local AS (
    SELECT r.id AS rn_uuid, r.legacy_idrn::bigint AS bigtehn_id
    FROM production.radni_nalog r
    WHERE r.legacy_idrn IS NOT NULL
  ),
  line_agg AS (
    SELECT
      l.work_order_id,
      jsonb_agg(
        jsonb_build_object(
          'operation_id', l.id::text,
          'redosled', l.prioritet,
          'naziv', l.operacija::text,
          'masina', coalesce(m.name, l.machine_code, ''),
          'opis_rada', coalesce(l.opis_rada, ''),
          'alat_pribor', coalesce(l.alat_pribor, ''),
          'planned_qty', wc.komada,
          'completed_qty', COALESCE(tr.sum_kom, 0),
          'completed_at', tr.last_fin,
          'is_final_control', production._pracenje_line_is_final_control(
            l.machine_code, m.name, m.no_procedure
          ),
          'kontrola_status', CASE
            WHEN production._pracenje_line_is_final_control(l.machine_code, m.name, m.no_procedure)
            THEN CASE
              WHEN COALESCE(tr.sum_kom_done, 0) > 0 THEN 'urađeno'
              ELSE 'nije prijavljeno'
            END
            ELSE ''
          END
        )
        ORDER BY l.prioritet NULLS LAST, l.id
      ) AS operations,
      bool_or(production._pracenje_line_is_final_control(l.machine_code, m.name, m.no_procedure)) AS has_final_line
    FROM public.bigtehn_work_order_lines_cache l
    INNER JOIN nodes_dedup nd ON nd.rn_id = l.work_order_id
    INNER JOIN public.bigtehn_work_orders_cache wc ON wc.id = l.work_order_id
    LEFT JOIN public.bigtehn_machines_cache m ON m.rj_code = l.machine_code
    LEFT JOIN LATERAL (
      SELECT
        COALESCE(sum(t.komada) FILTER (WHERE t.is_completed), 0)::numeric AS sum_kom_done,
        COALESCE(sum(t.komada), 0)::numeric AS sum_kom,
        max(t.finished_at) FILTER (WHERE t.is_completed) AS last_fin
      FROM public.bigtehn_tech_routing_cache t
      WHERE t.work_order_id = l.work_order_id
        AND t.operacija = l.operacija
        AND t.machine_code IS NOT DISTINCT FROM l.machine_code
    ) tr ON true
    GROUP BY l.work_order_id
  ),
  final_qty_bt AS (
    SELECT
      pw3.rn_id,
      COALESCE((
        SELECT sum(t.komada)::numeric
        FROM public.bigtehn_work_order_lines_cache l
        INNER JOIN public.bigtehn_machines_cache m ON m.rj_code = l.machine_code
        INNER JOIN public.bigtehn_tech_routing_cache t
          ON t.work_order_id = l.work_order_id
         AND t.operacija = l.operacija
         AND t.machine_code IS NOT DISTINCT FROM l.machine_code
         AND t.is_completed IS TRUE
        WHERE l.work_order_id = pw3.rn_id
          AND production._pracenje_line_is_final_control(l.machine_code, m.name, m.no_procedure)
      ), NULL) AS zavrsena_bigtehn
    FROM parent_wo pw3
  ),
  final_qty_local AS (
    SELECT
      rl.bigtehn_id AS rn_id,
      (
        SELECT vpp.prijavljeno_komada
        FROM production.tp_operacija tp
        INNER JOIN production.v_pozicija_progress vpp ON vpp.tp_operacija_id = tp.id
        LEFT JOIN core.work_center wc ON wc.id = tp.work_center_id
        LEFT JOIN core.odeljenje od ON od.id = wc.odeljenje_id
        WHERE tp.radni_nalog_id = rl.rn_uuid
          AND (
            od.kod = 'KK'
            OR tp.naziv ~* '(zavr|final|zav\.?\s*kontr|zavrsna|kontrol)'
          )
        ORDER BY
          CASE WHEN od.kod = 'KK' THEN 0 ELSE 1 END,
          tp.prioritet ASC NULLS LAST
        LIMIT 1
      ) AS zavrsena_local
    FROM rn_local rl
  ),
  ops_local AS (
    SELECT
      rl.bigtehn_id AS rn_id,
      COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'operation_id', tp.id::text,
            'redosled', tp.prioritet,
            'naziv', tp.naziv,
            'masina', coalesce(wc.kod, ''),
            'opis_rada', coalesce(tp.opis_rada, ''),
            'alat_pribor', coalesce(tp.alat_pribor, ''),
            'planned_qty', coalesce(vpp.planirano_komada, rnp.kolicina_plan),
            'completed_qty', coalesce(vpp.prijavljeno_komada, 0),
            'completed_at', vpp.poslednja_prijava_at,
            'is_final_control',
              (od.kod = 'KK' OR tp.naziv ~* '(zavr|final|zav\.?\s*kontr|zavrsna|kontrol)'),
            'kontrola_status', vpp.auto_status::text
          )
          ORDER BY tp.prioritet NULLS LAST, tp.operacija_kod
        )
        FROM production.tp_operacija tp
        INNER JOIN production.radni_nalog_pozicija rnp ON rnp.id = tp.radni_nalog_pozicija_id
        LEFT JOIN production.v_pozicija_progress vpp ON vpp.tp_operacija_id = tp.id
        LEFT JOIN core.work_center wc ON wc.id = tp.work_center_id
        LEFT JOIN core.odeljenje od ON od.id = wc.odeljenje_id
        WHERE tp.radni_nalog_id = rl.rn_uuid
      ), '[]'::jsonb) AS operations,
      EXISTS (
        SELECT 1
        FROM production.tp_operacija tp2
        LEFT JOIN core.work_center wc2 ON wc2.id = tp2.work_center_id
        LEFT JOIN core.odeljenje od2 ON od2.id = wc2.odeljenje_id
        WHERE tp2.radni_nalog_id = rl.rn_uuid
          AND (
            od2.kod = 'KK'
            OR tp2.naziv ~* '(zavr|final|zav\.?\s*kontr|zavrsna|kontrol)'
          )
      ) AS has_final_line
    FROM rn_local rl
  ),
  merged AS (
    SELECT
      pw.rn_id,
      pw.root_rn_id,
      pw.parent_rn_id,
      pw.nivo,
      pw.broj_komada,
      pw.path_idrn,
      pw.ident_broj,
      pw.broj_crteza,
      pw.naziv_dela,
      pw.materijal,
      pw.dimenzija_materijala,
      pw.komada,
      pw.rok_izrade,
      pw.status_rn,
      pw.datum_unosa,
      pw.wo_napomena,
      pw.parent_broj_crteza,
      rl.rn_uuid,
      CASE
        WHEN rl.rn_uuid IS NOT NULL THEN coalesce(ol.operations, '[]'::jsonb)
        ELSE coalesce(la.operations, '[]'::jsonb)
      END AS operations,
      CASE
        WHEN rl.rn_uuid IS NOT NULL THEN coalesce(ol.has_final_line, false)
        ELSE coalesce(la.has_final_line, false)
      END AS has_final_line,
      CASE
        WHEN rl.rn_uuid IS NOT NULL AND fl.zavrsena_local IS NOT NULL THEN fl.zavrsena_local
        WHEN fb.zavrsena_bigtehn IS NOT NULL THEN fb.zavrsena_bigtehn
        ELSE NULL
      END AS zavrsena_kolicina,
      nap.note AS korisnicka_napomena,
      ovr.status_override AS status_override,
      ovr.masinska_done AS masinska_done_ovr,
      ovr.povrsinska_done AS povrsinska_done_ovr,
      (po.bigtehn_rn_id IS NOT NULL) AS has_parent_override,
      po.parent_override_rn_id AS parent_override_rn_id
    FROM parent_wo pw
    LEFT JOIN rn_local rl ON rl.bigtehn_id = pw.rn_id
    LEFT JOIN line_agg la ON la.work_order_id = pw.rn_id
    LEFT JOIN ops_local ol ON ol.rn_id = pw.rn_id
    LEFT JOIN final_qty_bt fb ON fb.rn_id = pw.rn_id
    LEFT JOIN final_qty_local fl ON fl.rn_id = pw.rn_id
    LEFT JOIN production.pracenje_proizvodnje_napomene nap
      ON nap.predmet_item_id = p_predmet_item_id
     AND nap.bigtehn_rn_id = pw.rn_id
    LEFT JOIN production.pracenje_manual_overrides ovr
      ON ovr.predmet_item_id = p_predmet_item_id
     AND ovr.bigtehn_rn_id = pw.rn_id
    LEFT JOIN production.pracenje_parent_override po
      ON po.predmet_item_id = p_predmet_item_id
     AND po.bigtehn_rn_id = pw.rn_id
  ),
  with_calc AS (
    SELECT
      m.*,
      CASE
        WHEN m.broj_komada IS NOT NULL AND m.broj_komada > 0 THEN m.broj_komada::numeric
        ELSE NULL
      END AS qty_per_assembly,
      CASE
        WHEN m.broj_komada IS NOT NULL AND m.broj_komada > 0
        THEN (m.broj_komada::numeric * v_lot)
        ELSE NULL
      END AS required_for_lot,
      EXISTS (
        SELECT 1
        FROM public.bigtehn_drawings_cache d
        WHERE d.removed_at IS NULL
          AND d.drawing_no = nullif(trim(both ' ' FROM split_part(m.broj_crteza::text, '_', 1)), '')
      ) AS has_crtez_file
    FROM merged m
  ),
  -- FIX: window funkcija izračunata ovde, pre agregacije u rows_json.
  -- row_number() OVER (...) unutar jsonb_agg() = greška 42803.
  with_sort AS (
    SELECT
      w.*,
      row_number() OVER (
        PARTITION BY w.parent_rn_id, w.root_rn_id
        ORDER BY w.ident_broj ASC NULLS LAST
      ) AS sort_order
    FROM with_calc w
  ),
  rows_json AS (
    SELECT jsonb_agg(
      jsonb_build_object(
        'row_id', p_predmet_item_id::text || ':' || w.rn_id::text,
        'node_id', w.rn_id,
        'parent_node_id', w.parent_rn_id,
        'level', w.nivo,
        'sort_order', w.sort_order,
        'tip_reda', 'rn',
        'naziv_pozicije', coalesce(nullif(trim(both ' ' FROM w.naziv_dela), ''), w.ident_broj::text),
        'broj_crteza', coalesce(nullif(trim(both ' ' FROM w.broj_crteza::text), ''), ''),
        'broj_sklopnog_crteza', coalesce(nullif(trim(both ' ' FROM w.parent_broj_crteza::text), ''), ''),
        'crtez_url', NULL,
        'sklop_url', NULL,
        'crtez_drawing_no', nullif(trim(both ' ' FROM split_part(w.broj_crteza::text, '_', 1)), ''),
        'sklop_drawing_no', nullif(trim(both ' ' FROM split_part(w.parent_broj_crteza::text, '_', 1)), ''),
        'has_crtez_file', w.has_crtez_file,
        'has_skop_crtez_file', EXISTS (
          SELECT 1 FROM public.bigtehn_drawings_cache d
          WHERE d.removed_at IS NULL
            AND w.parent_broj_crteza IS NOT NULL
            AND d.drawing_no = nullif(trim(both ' ' FROM split_part(w.parent_broj_crteza::text, '_', 1)), '')
        ),
        'rn_id', w.rn_uuid,
        'rn_broj', w.ident_broj::text,
        'qty_per_assembly', w.qty_per_assembly,
        'lansirana_kolicina', w.komada,
        'required_for_lot', w.required_for_lot,
        'zavrsena_kolicina', w.zavrsena_kolicina,
        'raspolozivo_za_montazu', w.zavrsena_kolicina,
        'kompletirano_za_lot', CASE
          WHEN w.required_for_lot IS NULL OR w.zavrsena_kolicina IS NULL THEN NULL
          ELSE least(w.zavrsena_kolicina, w.required_for_lot)
        END,
        'datum_lansiranja_tp', (w.datum_unosa AT TIME ZONE 'UTC')::date,
        'datum_izrade', (w.rok_izrade AT TIME ZONE 'UTC')::date,
        'masinska_obrada_status', (
          SELECT string_agg(
            coalesce(m.name, l.machine_code) || ': ' ||
            CASE WHEN COALESCE(tr.done, 0) > 0 THEN 'urađeno' ELSE 'otvoreno' END,
            '; ' ORDER BY l.prioritet NULLS LAST
          )
          FROM public.bigtehn_work_order_lines_cache l
          LEFT JOIN public.bigtehn_machines_cache m ON m.rj_code = l.machine_code
          LEFT JOIN LATERAL (
            SELECT COALESCE(sum(t.komada) FILTER (WHERE t.is_completed), 0)::numeric AS done
            FROM public.bigtehn_tech_routing_cache t
            WHERE t.work_order_id = l.work_order_id
              AND t.operacija = l.operacija
              AND t.machine_code IS NOT DISTINCT FROM l.machine_code
          ) tr ON true
          WHERE l.work_order_id = w.rn_id
            AND coalesce(m.no_procedure, false) IS FALSE
          LIMIT 4
        ),
        'povrsinska_zastita_status', (
          SELECT string_agg(
            coalesce(m.name, l.machine_code) || ': ' ||
            CASE WHEN COALESCE(tr.done, 0) > 0 THEN 'urađeno' ELSE 'otvoreno' END,
            '; ' ORDER BY l.prioritet NULLS LAST
          )
          FROM public.bigtehn_work_order_lines_cache l
          LEFT JOIN public.bigtehn_machines_cache m ON m.rj_code = l.machine_code
          LEFT JOIN LATERAL (
            SELECT COALESCE(sum(t.komada) FILTER (WHERE t.is_completed), 0)::numeric AS done
            FROM public.bigtehn_tech_routing_cache t
            WHERE t.work_order_id = l.work_order_id
              AND t.operacija = l.operacija
              AND t.machine_code IS NOT DISTINCT FROM l.machine_code
          ) tr ON true
          WHERE l.work_order_id = w.rn_id
            AND coalesce(m.no_procedure, false) IS TRUE
            AND NOT production._pracenje_line_is_final_control(l.machine_code, m.name, m.no_procedure)
          LIMIT 4
        ),
        'materijal', coalesce(w.materijal, ''),
        'dimenzije', coalesce(w.dimenzija_materijala, ''),
        'sistemska_napomena', coalesce(w.wo_napomena, ''),
        'korisnicka_napomena', coalesce(w.korisnicka_napomena, ''),
        'status_override', w.status_override,
        'masinska_done_override', w.masinska_done_ovr,
        'povrsinska_done_override', w.povrsinska_done_ovr,
        'has_parent_override', w.has_parent_override,
        'parent_override_rn_id', w.parent_override_rn_id,
        'statusi', jsonb_build_object(
          'kasni', CASE
            WHEN w.rok_izrade IS NULL THEN false
            WHEN (w.rok_izrade AT TIME ZONE 'UTC')::date < (current_timestamp AT TIME ZONE 'Europe/Belgrade')::date
              AND coalesce(w.zavrsena_kolicina, 0) < coalesce(w.komada, 0)
            THEN true
            ELSE false
          END,
          'nema_tp', CASE
            WHEN w.broj_crteza IS NULL OR trim(both ' ' FROM w.broj_crteza::text) = '' THEN true
            ELSE false
          END,
          'nema_crtez', NOT w.has_crtez_file,
          'nema_zavrsnu_kontrolu', NOT w.has_final_line,
          'nije_kompletirano', CASE
            WHEN w.komada IS NULL THEN false
            WHEN coalesce(w.zavrsena_kolicina, 0) < w.komada THEN true
            ELSE false
          END,
          'nema_rn', w.rn_uuid IS NULL
        ),
        'operations', w.operations
      )
      ORDER BY w.root_rn_id, w.path_idrn
    ) AS arr
    FROM with_sort w
  )
  SELECT coalesce(arr, '[]'::jsonb) INTO v_rows FROM rows_json;

  SELECT jsonb_build_object(
    'total_rows', (SELECT count(*)::int FROM jsonb_array_elements(v_rows)),
    'total_lansirano', (
      SELECT coalesce(sum((e->>'lansirana_kolicina')::numeric), 0) FROM jsonb_array_elements(v_rows) e
    ),
    'total_zavrseno', (
      SELECT coalesce(sum((e->>'zavrsena_kolicina')::numeric), 0) FROM jsonb_array_elements(v_rows) e
      WHERE e ? 'zavrsena_kolicina' AND e->>'zavrsena_kolicina' IS NOT NULL
    ),
    'count_nije_kompletirano', (
      SELECT count(*)::int FROM jsonb_array_elements(v_rows) e
      WHERE (e->'statusi'->>'nije_kompletirano')::boolean IS TRUE
    ),
    'count_nema_tp', (
      SELECT count(*)::int FROM jsonb_array_elements(v_rows) e
      WHERE (e->'statusi'->>'nema_tp')::boolean IS TRUE
    ),
    'count_nema_crtez', (
      SELECT count(*)::int FROM jsonb_array_elements(v_rows) e
      WHERE (e->'statusi'->>'nema_crtez')::boolean IS TRUE
    ),
    'count_nema_zavrsnu_kontrolu', (
      SELECT count(*)::int FROM jsonb_array_elements(v_rows) e
      WHERE (e->'statusi'->>'nema_zavrsnu_kontrolu')::boolean IS TRUE
    ),
    'count_kasni', (
      SELECT count(*)::int FROM jsonb_array_elements(v_rows) e
      WHERE (e->'statusi'->>'kasni')::boolean IS TRUE
    )
  ) INTO v_summary;

  RETURN jsonb_build_object(
    'predmet', jsonb_build_object(
      'item_id', v_item.id,
      'broj_predmeta', coalesce(v_item.broj_predmeta, ''),
      'naziv_predmeta', coalesce(v_item.naziv_predmeta, ''),
      'komitent', v_customer_name,
      'rok_zavrsetka', to_jsonb(v_item.rok_zavrsetka)
    ),
    'root', v_root,
    'lot_qty', v_lot,
    'generated_at', to_jsonb(v_generated),
    'rows', v_rows,
    'summary', v_summary
  );
END;
$function$;

-- ============ production.list_predmet_aktivacija_admin [SECURITY DEFINER] ============
CREATE OR REPLACE FUNCTION production.list_predmet_aktivacija_admin()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'production', 'pg_temp'
AS $function$
DECLARE
  out_json jsonb;
BEGIN
  IF NOT public.can_manage_predmet_aktivacija() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  WITH rows AS (
    SELECT
      i.id AS item_id,
      i.broj_predmeta,
      i.naziv_predmeta,
      COALESCE(
        NULLIF(trim(both ' ' FROM c.name), ''),
        NULLIF(trim(both ' ' FROM c.short_name), ''),
        ''
      ) AS customer_name,
      COALESCE(pa.je_aktivan, false) AS je_aktivan,
      COALESCE(pa.je_projektovanje_montaza, false) AS je_projektovanje_montaza,
      pa.napomena,
      u.email::text AS azurirao_email,
      pa.azurirano_at
    FROM public.bigtehn_items_cache i
    LEFT JOIN production.predmet_aktivacija pa ON pa.predmet_item_id = i.id
    LEFT JOIN public.bigtehn_customers_cache c ON c.id = i.customer_id
    LEFT JOIN auth.users u ON u.id = pa.azurirao_user_id
  )
  SELECT COALESCE(
    (
      SELECT jsonb_agg(
        jsonb_build_object(
          'item_id', r.item_id,
          'broj_predmeta', COALESCE(r.broj_predmeta, ''),
          'naziv_predmeta', COALESCE(r.naziv_predmeta, ''),
          'customer_name', r.customer_name,
          'je_aktivan', r.je_aktivan,
          'je_projektovanje_montaza', r.je_projektovanje_montaza,
          'napomena', r.napomena,
          'azurirao_email', r.azurirao_email,
          'azurirano_at', r.azurirano_at
        )
        ORDER BY r.je_aktivan DESC, r.broj_predmeta ASC NULLS LAST
      )
      FROM rows r
    ),
    '[]'::jsonb
  )
  INTO out_json;
  RETURN out_json;
END;
$function$;

-- ============ production.log_operativna_blok_promenu [SECURITY DEFINER] ============
CREATE OR REPLACE FUNCTION production.log_operativna_blok_promenu()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'production', 'public', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP = 'UPDATE'
     AND (
       OLD.manual_override_status IS DISTINCT FROM NEW.manual_override_status
       OR OLD.blokirano_razlog IS DISTINCT FROM NEW.blokirano_razlog
     ) THEN
    INSERT INTO production.operativna_aktivnost_blok_istorija (
      aktivnost_id,
      old_manual_override_status,
      new_manual_override_status,
      old_blokirano_razlog,
      new_blokirano_razlog,
      changed_by,
      changed_by_email
    )
    VALUES (
      NEW.id,
      OLD.manual_override_status,
      NEW.manual_override_status,
      OLD.blokirano_razlog,
      NEW.blokirano_razlog,
      auth.uid(),
      public.current_user_email()
    );
  END IF;
  RETURN NEW;
END;
$function$;

-- ============ production.promovisi_akcionu_tacku [SECURITY DEFINER] ============
CREATE OR REPLACE FUNCTION production.promovisi_akcionu_tacku(p_akcioni_plan_id uuid, p_odeljenje_id uuid, p_rn_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'production', 'public', 'pg_temp'
AS $function$
DECLARE
  v_ap public.akcioni_plan;
  v_rn production.radni_nalog;
  v_id uuid;
BEGIN
  SELECT * INTO v_ap FROM public.akcioni_plan WHERE id = p_akcioni_plan_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Akciona tačka % ne postoji', p_akcioni_plan_id; END IF;

  SELECT * INTO v_rn FROM production.radni_nalog WHERE id = p_rn_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Radni nalog % ne postoji', p_rn_id; END IF;

  IF NOT production.can_edit_pracenje(COALESCE(v_ap.projekat_id, v_rn.projekat_id), p_rn_id) THEN
    RAISE EXCEPTION 'Nemaš pravo promocije akcione tačke';
  END IF;

  INSERT INTO production.operativna_aktivnost (
    radni_nalog_id, projekat_id, odeljenje_id, naziv_aktivnosti, opis,
    planirani_zavrsetak, odgovoran_label, status, prioritet, izvor,
    izvor_akcioni_plan_id, created_by, updated_by
  )
  VALUES (
    p_rn_id,
    COALESCE(v_ap.projekat_id, v_rn.projekat_id),
    p_odeljenje_id,
    v_ap.naslov,
    v_ap.opis,
    v_ap.rok,
    COALESCE(v_ap.odgovoran_label, v_ap.odgovoran_text, v_ap.odgovoran_email),
    CASE WHEN v_ap.status = 'zavrsen' THEN 'zavrseno'::production.aktivnost_status ELSE 'nije_krenulo'::production.aktivnost_status END,
    CASE v_ap.prioritet WHEN 1 THEN 'visok'::production.aktivnost_prioritet WHEN 3 THEN 'nizak'::production.aktivnost_prioritet ELSE 'srednji'::production.aktivnost_prioritet END,
    'iz_sastanka',
    v_ap.id,
    auth.uid(),
    auth.uid()
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;

-- ============ production.search_proizvodnja_delovi [SECURITY DEFINER] ============
CREATE OR REPLACE FUNCTION production.search_proizvodnja_delovi(p_q text, p_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'production', 'pdm', 'core', 'pg_temp'
AS $function$
  WITH q AS (
    SELECT
      '%' || replace(replace(coalesce(trim(p_q), ''), '%', '\%'), '_', '\_') || '%' AS pat,
      char_length(coalesce(trim(p_q), ''))                                         AS qlen,
      least(greatest(coalesce(p_limit, 50), 1), 500)                               AS lim
  ),
  mes_hits AS (
    SELECT
      rn.id                        AS rn_id,
      rn.legacy_idrn               AS bigtehn_work_order_id,
      'mes'::text                  AS source,
      rn.rn_broj                   AS rn_broj,
      rn.status::text              AS rn_status,
      (rn.status = 'lansiran')     AS lansiran,
      rn.datum_isporuke            AS datum_isporuke,
      coalesce(r.puno_ime, r.ime)  AS koordinator,
      poz.id                       AS pozicija_id,
      poz.sifra_pozicije           AS sifra_pozicije,
      poz.naziv                    AS naziv,
      d.drawing_no                 AS drawing_no,
      d.revision                   AS revision,
      (
        SELECT string_agg(
                 DISTINCT (t.operacija_kod::text || ' ' || t.naziv),
                 ', ' ORDER BY (t.operacija_kod::text || ' ' || t.naziv)
               )
        FROM production.tp_operacija t
        WHERE t.radni_nalog_pozicija_id = poz.id
      )                            AS tp
    FROM production.radni_nalog_pozicija poz
    JOIN production.radni_nalog rn ON rn.id = poz.radni_nalog_id
    LEFT JOIN pdm.drawing d        ON d.id = poz.drawing_id
    LEFT JOIN core.radnik r        ON r.id = rn.koordinator_radnik_id
    CROSS JOIN q
    WHERE q.qlen >= 2
      AND (
        rn.rn_broj ILIKE q.pat
        OR d.drawing_no ILIKE q.pat
        OR poz.naziv ILIKE q.pat
        OR poz.sifra_pozicije ILIKE q.pat
        OR EXISTS (
          SELECT 1 FROM production.tp_operacija t
          WHERE t.radni_nalog_pozicija_id = poz.id
            AND (t.naziv ILIKE q.pat OR t.operacija_kod::text ILIKE q.pat)
        )
      )
  ),
  bigtehn_hits AS (
    SELECT
      rn.id                        AS rn_id,
      w.id                         AS bigtehn_work_order_id,
      'bigtehn'::text              AS source,
      btrim(w.ident_broj)          AS rn_broj,
      coalesce(rn.status::text, 'aktivan') AS rn_status,
      (rn.status = 'lansiran')     AS lansiran,
      coalesce(rn.datum_isporuke, (w.rok_izrade AT TIME ZONE 'UTC')::date) AS datum_isporuke,
      coalesce(rad.puno_ime, rad.ime) AS koordinator,
      NULL::uuid                   AS pozicija_id,
      NULL::text                   AS sifra_pozicije,
      coalesce(nullif(btrim(w.naziv_dela), ''), btrim(w.ident_broj)) AS naziv,
      nullif(btrim(w.broj_crteza), '') AS drawing_no,
      nullif(btrim(w.revizija), '') AS revision,
      (
        SELECT string_agg(
                 DISTINCT (l.operacija::text || ' ' || coalesce(nullif(btrim(l.opis_rada), ''), '')),
                 ', ' ORDER BY (l.operacija::text || ' ' || coalesce(nullif(btrim(l.opis_rada), ''), ''))
               )
        FROM public.bigtehn_work_order_lines_cache l
        WHERE l.work_order_id = w.id
      )                            AS tp
    FROM public.bigtehn_work_orders_cache w
    LEFT JOIN production.radni_nalog rn
      ON rn.legacy_idrn = w.id::integer
      OR rn.rn_broj = btrim(w.ident_broj)
    LEFT JOIN core.radnik rad ON rad.id = rn.koordinator_radnik_id
    CROSS JOIN q
    WHERE q.qlen >= 2
      AND (
        btrim(w.ident_broj) ILIKE q.pat
        OR nullif(btrim(w.broj_crteza), '') ILIKE q.pat
        OR coalesce(w.naziv_dela, '') ILIKE q.pat
        OR EXISTS (
          SELECT 1 FROM public.bigtehn_work_order_lines_cache l
          WHERE l.work_order_id = w.id
            AND (
              coalesce(l.opis_rada, '') ILIKE q.pat
              OR l.operacija::text ILIKE q.pat
            )
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM mes_hits m
        WHERE m.rn_broj = btrim(w.ident_broj)
          AND coalesce(m.drawing_no, '') IS NOT DISTINCT FROM coalesce(nullif(btrim(w.broj_crteza), ''), '')
      )
  ),
  combined AS (
    SELECT * FROM mes_hits
    UNION ALL
    SELECT * FROM bigtehn_hits
  ),
  ranked AS (
    SELECT *
    FROM combined
    ORDER BY lansiran DESC,
             datum_isporuke NULLS LAST,
             rn_broj,
             source
    LIMIT (SELECT lim FROM q)
  )
  SELECT coalesce(jsonb_agg(to_jsonb(ranked)), '[]'::jsonb) FROM ranked;
$function$;

-- ============ production.set_blokirano [SECURITY DEFINER] ============
CREATE OR REPLACE FUNCTION production.set_blokirano(p_id uuid, p_razlog text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'production', 'public', 'pg_temp'
AS $function$
DECLARE
  v_row production.operativna_aktivnost;
BEGIN
  IF nullif(trim(COALESCE(p_razlog, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Razlog blokade je obavezan';
  END IF;

  SELECT * INTO v_row FROM production.operativna_aktivnost WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Aktivnost % ne postoji', p_id; END IF;
  IF NOT production.can_edit_pracenje(v_row.projekat_id, v_row.radni_nalog_id) THEN
    RAISE EXCEPTION 'Nemaš pravo blokiranja aktivnosti';
  END IF;

  UPDATE production.operativna_aktivnost
     SET manual_override_status = 'blokirano',
         blokirano_razlog = p_razlog,
         updated_by = auth.uid()
   WHERE id = p_id;
END;
$function$;

-- ============ production.set_predmet_aktivacija [SECURITY DEFINER] ============
CREATE OR REPLACE FUNCTION production.set_predmet_aktivacija(p_item_id integer, p_aktivan boolean, p_napomena text DEFAULT NULL::text, p_projektovanje_montaza boolean DEFAULT NULL::boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'production', 'pg_temp'
AS $function$
BEGIN
  IF NOT public.can_manage_predmet_aktivacija() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_item_id IS NULL OR p_item_id <= 0 THEN
    RAISE EXCEPTION 'invalid p_item_id' USING ERRCODE = '22000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.bigtehn_items_cache i WHERE i.id = p_item_id) THEN
    RAISE EXCEPTION 'nepoznat predmet' USING ERRCODE = '22000';
  END IF;

  INSERT INTO production.predmet_aktivacija (
    predmet_item_id,
    je_aktivan,
    napomena,
    je_projektovanje_montaza,
    azurirao_user_id,
    azurirano_at
  )
  VALUES (
    p_item_id,
    p_aktivan,
    p_napomena,
    COALESCE(p_projektovanje_montaza, false),
    auth.uid(),
    now()
  )
  ON CONFLICT (predmet_item_id) DO UPDATE SET
    je_aktivan = EXCLUDED.je_aktivan,
    napomena = CASE
      WHEN p_napomena IS NULL THEN predmet_aktivacija.napomena
      ELSE EXCLUDED.napomena
    END,
    je_projektovanje_montaza = CASE
      WHEN p_projektovanje_montaza IS NULL THEN predmet_aktivacija.je_projektovanje_montaza
      ELSE EXCLUDED.je_projektovanje_montaza
    END,
    azurirao_user_id = auth.uid(),
    azurirano_at = now();
END;
$function$;

-- ============ production.set_predmet_prioritet [SECURITY DEFINER] ============
CREATE OR REPLACE FUNCTION production.set_predmet_prioritet(p_item_id integer, p_sort_priority integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'production', 'pg_temp'
AS $function$
BEGIN
  IF NOT public.current_user_is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_sort_priority < 0 THEN
    RAISE EXCEPTION 'sort_priority must be >= 0' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM production.predmet_aktivacija pa
    WHERE pa.predmet_item_id = p_item_id
      AND pa.je_aktivan IS TRUE
  ) THEN
    RAISE EXCEPTION 'predmet nije u aktiviranom skupu za praćenje' USING ERRCODE = '23514';
  END IF;
  INSERT INTO production.predmet_prioritet (predmet_item_id, sort_priority, updated_by, updated_at)
  VALUES (p_item_id, p_sort_priority, auth.uid(), now())
  ON CONFLICT (predmet_item_id) DO UPDATE SET
    sort_priority = EXCLUDED.sort_priority,
    updated_by = auth.uid(),
    updated_at = now();
END;
$function$;

-- ============ production.shift_predmet_prioritet [SECURITY DEFINER] ============
CREATE OR REPLACE FUNCTION production.shift_predmet_prioritet(p_item_id integer, p_direction text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'production', 'pg_temp'
AS $function$
DECLARE
  dir text := lower(trim(p_direction));
  items integer[];
  pos int;
  n int;
  neighbor_pos int;
  tmp int;
  i int;
BEGIN
  IF NOT public.current_user_is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF dir NOT IN ('up', 'down') THEN
    RAISE EXCEPTION 'invalid direction' USING ERRCODE = '22000';
  END IF;

  SELECT coalesce(array_agg(sub.item_id ORDER BY sub.sp NULLS LAST, sub.bp ASC NULLS LAST), ARRAY[]::integer[])
  INTO items
  FROM (
    SELECT
      v.item_id,
      p.sort_priority AS sp,
      i.broj_predmeta AS bp
    FROM (
      SELECT pa.predmet_item_id::integer AS item_id
      FROM production.predmet_aktivacija pa
      WHERE pa.je_aktivan IS TRUE
    ) v
    INNER JOIN public.bigtehn_items_cache i ON i.id = v.item_id
    LEFT JOIN production.predmet_prioritet p ON p.predmet_item_id = v.item_id
  ) sub;

  n := coalesce(array_length(items, 1), 0);
  IF n = 0 THEN
    RETURN;
  END IF;

  pos := array_position(items, p_item_id);
  IF pos IS NULL THEN
    RETURN;
  END IF;

  neighbor_pos := pos + CASE WHEN dir = 'up' THEN -1 ELSE 1 END;
  IF neighbor_pos < 1 OR neighbor_pos > n THEN
    RETURN;
  END IF;

  tmp := items[pos];
  items[pos] := items[neighbor_pos];
  items[neighbor_pos] := tmp;

  FOR i IN 1..n LOOP
    INSERT INTO production.predmet_prioritet (predmet_item_id, sort_priority, updated_by, updated_at)
    VALUES (items[i], i - 1, auth.uid(), now())
    ON CONFLICT (predmet_item_id) DO UPDATE SET
      sort_priority = EXCLUDED.sort_priority,
      updated_by = auth.uid(),
      updated_at = now();
  END LOOP;
END;
$function$;

-- ============ production.skini_blokadu [SECURITY DEFINER] ============
CREATE OR REPLACE FUNCTION production.skini_blokadu(p_id uuid, p_napomena text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'production', 'public', 'pg_temp'
AS $function$
DECLARE
  v_row production.operativna_aktivnost;
BEGIN
  SELECT * INTO v_row FROM production.operativna_aktivnost WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Aktivnost % ne postoji', p_id; END IF;
  IF NOT production.can_edit_pracenje(v_row.projekat_id, v_row.radni_nalog_id) THEN
    RAISE EXCEPTION 'Nemaš pravo skidanja blokade';
  END IF;

  UPDATE production.operativna_aktivnost
     SET manual_override_status = NULL,
         blokirano_razlog = NULL,
         updated_by = auth.uid()
   WHERE id = p_id;

  UPDATE production.operativna_aktivnost_blok_istorija
     SET napomena = COALESCE(p_napomena, napomena)
   WHERE id = (
     SELECT id
     FROM production.operativna_aktivnost_blok_istorija
     WHERE aktivnost_id = p_id
     ORDER BY created_at DESC
     LIMIT 1
   );
END;
$function$;

-- ============ production.sync_pb_project_from_predmet [SECURITY DEFINER] ============
CREATE OR REPLACE FUNCTION production.sync_pb_project_from_predmet(p_item_id integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'production', 'pg_temp'
AS $function$
DECLARE
  v_code text;
  v_name text;
  v_norm text;
  v_new_id uuid;
  v_legacy_id uuid;
BEGIN
  IF p_item_id IS NULL OR p_item_id <= 0 THEN
    RETURN;
  END IF;

  SELECT
    NULLIF(trim(COALESCE(i.broj_predmeta, '')), ''),
    COALESCE(NULLIF(trim(COALESCE(i.naziv_predmeta, '')), ''), '(bez naziva)')
  INTO v_code, v_name
  FROM public.bigtehn_items_cache i
  WHERE i.id = p_item_id;

  IF v_code IS NULL THEN
    RETURN;
  END IF;

  v_norm := public.pb_normalize_project_code(v_code);
  v_new_id := public.pb_predmet_project_uuid(p_item_id);

  SELECT p.id INTO v_legacy_id
  FROM public.projects p
  WHERE p.bigtehn_item_id IS NULL
    AND public.pb_normalize_project_code(p.project_code) = v_norm
  ORDER BY p.created_at ASC NULLS FIRST
  LIMIT 1;

  IF v_legacy_id IS NOT NULL THEN
    UPDATE public.projects
    SET
      bigtehn_item_id = p_item_id,
      project_code = v_code,
      project_name = v_name,
      status = 'active',
      updated_at = now()
    WHERE id = v_legacy_id;
    RETURN;
  END IF;

  BEGIN
    INSERT INTO public.projects (id, project_code, project_name, status, bigtehn_item_id)
    VALUES (v_new_id, v_code, v_name, 'active', p_item_id)
    ON CONFLICT (id) DO UPDATE SET
      project_code = EXCLUDED.project_code,
      project_name = EXCLUDED.project_name,
      bigtehn_item_id = EXCLUDED.bigtehn_item_id,
      status = 'active',
      updated_at = now();
  EXCEPTION
    WHEN unique_violation THEN
      UPDATE public.projects p
      SET
        bigtehn_item_id = p_item_id,
        project_name = v_name,
        status = 'active',
        updated_at = now()
      WHERE p.id = (
        SELECT p2.id
        FROM public.projects p2
        WHERE (
            p2.project_code = v_code
            OR (
              p2.bigtehn_item_id IS NULL
              AND public.pb_normalize_project_code(p2.project_code) = v_norm
            )
          )
          AND (p2.bigtehn_item_id IS NULL OR p2.bigtehn_item_id = p_item_id)
        ORDER BY CASE WHEN p2.project_code = v_code THEN 0 ELSE 1 END,
          p2.created_at ASC NULLS FIRST
        LIMIT 1
      );
  END;
END;
$function$;

-- ============ production.tg_predmet_aktivacija_default [SECURITY DEFINER] ============
CREATE OR REPLACE FUNCTION production.tg_predmet_aktivacija_default()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'production', 'pg_temp'
AS $function$
BEGIN
  INSERT INTO production.predmet_aktivacija (
    predmet_item_id,
    je_aktivan,
    je_projektovanje_montaza,
    azurirao_user_id,
    azurirano_at
  )
  VALUES (NEW.id, true, false, NULL, now())
  ON CONFLICT (predmet_item_id) DO NOTHING;
  RETURN NEW;
END;
$function$;

-- ============ production.tg_predmet_pb_project_sync [SECURITY DEFINER] ============
CREATE OR REPLACE FUNCTION production.tg_predmet_pb_project_sync()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'production', 'pg_temp'
AS $function$
BEGIN
  IF NEW.je_aktivan IS TRUE AND NEW.je_projektovanje_montaza IS TRUE THEN
    PERFORM production.sync_pb_project_from_predmet(NEW.predmet_item_id);
  END IF;
  RETURN NEW;
END;
$function$;

-- ============ production.touch_updated_at ============
CREATE OR REPLACE FUNCTION production.touch_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'production', 'pg_temp'
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$;

-- ============ production.trg_ppp_snapshot [SECURITY DEFINER] ============
CREATE OR REPLACE FUNCTION production.trg_ppp_snapshot()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'production', 'pg_temp'
AS $function$
DECLARE
  v_email TEXT;
  v_ids   INTEGER[];
  v_snap  JSONB;
BEGIN
  BEGIN
    v_email := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email';
  EXCEPTION WHEN others THEN v_email := NULL;
  END;

  SELECT COALESCE(array_agg(predmet_item_id ORDER BY slot), ARRAY[]::integer[]),
         COALESCE(jsonb_agg(jsonb_build_object('slot', slot, 'predmet_item_id', predmet_item_id) ORDER BY slot), '[]'::jsonb)
    INTO v_ids, v_snap
  FROM production.predmet_plan_prioritet;

  INSERT INTO production.predmet_plan_prioritet_audit (op, n, item_ids, snapshot, changed_by)
  VALUES (TG_OP, COALESCE(array_length(v_ids, 1), 0), v_ids, v_snap, v_email);

  RETURN NULL;
END;
$function$;

-- ============ production.upsert_operativna_aktivnost [SECURITY DEFINER] ============
CREATE OR REPLACE FUNCTION production.upsert_operativna_aktivnost(p_id uuid DEFAULT NULL::uuid, p_radni_nalog_id uuid DEFAULT NULL::uuid, p_projekat_id uuid DEFAULT NULL::uuid, p_odeljenje_id uuid DEFAULT NULL::uuid, p_naziv_aktivnosti text DEFAULT NULL::text, p_planirani_pocetak date DEFAULT NULL::date, p_planirani_zavrsetak date DEFAULT NULL::date, p_odgovoran_user_id uuid DEFAULT NULL::uuid, p_odgovoran_radnik_id uuid DEFAULT NULL::uuid, p_status production.aktivnost_status DEFAULT 'nije_krenulo'::production.aktivnost_status, p_prioritet production.aktivnost_prioritet DEFAULT 'srednji'::production.aktivnost_prioritet, p_rb integer DEFAULT 100, p_opis text DEFAULT NULL::text, p_broj_tp text DEFAULT NULL::text, p_kolicina_text text DEFAULT NULL::text, p_odgovoran_label text DEFAULT NULL::text, p_zavisi_od_aktivnost_id uuid DEFAULT NULL::uuid, p_zavisi_od_text text DEFAULT NULL::text, p_status_mode production.aktivnost_status_mode DEFAULT 'manual'::production.aktivnost_status_mode, p_rizik_napomena text DEFAULT NULL::text, p_izvor production.aktivnost_izvor DEFAULT 'rucno'::production.aktivnost_izvor, p_izvor_akcioni_plan_id uuid DEFAULT NULL::uuid, p_izvor_pozicija_id uuid DEFAULT NULL::uuid, p_izvor_tp_operacija_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'production', 'core', 'public', 'pg_temp'
AS $function$
DECLARE
  v_id uuid;
  v_project_id uuid;
BEGIN
  SELECT COALESCE(p_projekat_id, rn.projekat_id) INTO v_project_id
  FROM production.radni_nalog rn
  WHERE rn.id = p_radni_nalog_id;

  IF p_radni_nalog_id IS NULL OR p_odeljenje_id IS NULL OR nullif(trim(COALESCE(p_naziv_aktivnosti, '')), '') IS NULL THEN
    RAISE EXCEPTION 'upsert_operativna_aktivnost: radni nalog, odeljenje i naziv su obavezni';
  END IF;

  IF NOT production.can_edit_pracenje(v_project_id, p_radni_nalog_id) THEN
    RAISE EXCEPTION 'Nemaš pravo izmene operativnih aktivnosti';
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO production.operativna_aktivnost (
      radni_nalog_id, projekat_id, rb, odeljenje_id, naziv_aktivnosti, opis,
      broj_tp, kolicina_text, planirani_pocetak, planirani_zavrsetak,
      odgovoran_user_id, odgovoran_radnik_id, odgovoran_label,
      zavisi_od_aktivnost_id, zavisi_od_text, status, prioritet, status_mode,
      rizik_napomena, izvor, izvor_akcioni_plan_id, izvor_pozicija_id, izvor_tp_operacija_id,
      created_by, updated_by
    )
    VALUES (
      p_radni_nalog_id, v_project_id, p_rb, p_odeljenje_id, p_naziv_aktivnosti, p_opis,
      p_broj_tp, p_kolicina_text, p_planirani_pocetak, p_planirani_zavrsetak,
      p_odgovoran_user_id, p_odgovoran_radnik_id, p_odgovoran_label,
      p_zavisi_od_aktivnost_id, p_zavisi_od_text, p_status, p_prioritet, p_status_mode,
      p_rizik_napomena, p_izvor, p_izvor_akcioni_plan_id, p_izvor_pozicija_id, p_izvor_tp_operacija_id,
      auth.uid(), auth.uid()
    )
    RETURNING id INTO v_id;
  ELSE
    UPDATE production.operativna_aktivnost
       SET radni_nalog_id = p_radni_nalog_id,
           projekat_id = v_project_id,
           rb = p_rb,
           odeljenje_id = p_odeljenje_id,
           naziv_aktivnosti = p_naziv_aktivnosti,
           opis = p_opis,
           broj_tp = p_broj_tp,
           kolicina_text = p_kolicina_text,
           planirani_pocetak = p_planirani_pocetak,
           planirani_zavrsetak = p_planirani_zavrsetak,
           odgovoran_user_id = p_odgovoran_user_id,
           odgovoran_radnik_id = p_odgovoran_radnik_id,
           odgovoran_label = p_odgovoran_label,
           zavisi_od_aktivnost_id = p_zavisi_od_aktivnost_id,
           zavisi_od_text = p_zavisi_od_text,
           status = p_status,
           prioritet = p_prioritet,
           status_mode = p_status_mode,
           rizik_napomena = p_rizik_napomena,
           izvor = p_izvor,
           izvor_akcioni_plan_id = p_izvor_akcioni_plan_id,
           izvor_pozicija_id = p_izvor_pozicija_id,
           izvor_tp_operacija_id = p_izvor_tp_operacija_id,
           updated_by = auth.uid()
     WHERE id = p_id
     RETURNING id INTO v_id;
  END IF;

  RETURN v_id;
END;
$function$;

-- ============ production.upsert_pracenje_manual_override [SECURITY DEFINER] ============
CREATE OR REPLACE FUNCTION production.upsert_pracenje_manual_override(p_predmet_item_id integer, p_bigtehn_rn_id bigint, p_status text DEFAULT NULL::text, p_masinska boolean DEFAULT NULL::boolean, p_povrsinska boolean DEFAULT NULL::boolean, p_rn_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'production', 'pg_temp'
AS $function$
DECLARE
  v_id uuid;
  v_status text := nullif(trim(both ' ' FROM coalesce(p_status, '')), '');
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Moraš biti ulogovan' USING ERRCODE = '42501';
  END IF;
  IF NOT public.can_manage_predmet_aktivacija() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_predmet_item_id IS NULL OR p_predmet_item_id <= 0
     OR p_bigtehn_rn_id IS NULL OR p_bigtehn_rn_id <= 0 THEN
    RAISE EXCEPTION 'Neispravan predmet ili RN' USING ERRCODE = '22000';
  END IF;
  IF v_status IS NOT NULL AND v_status NOT IN ('u_radu', 'kompletirano', 'nije_zapoceto') THEN
    RAISE EXCEPTION 'Neispravan status: %', v_status USING ERRCODE = '22000';
  END IF;

  -- Ništa ručno → ukloni red (vrati na auto).
  IF v_status IS NULL AND p_masinska IS NULL AND p_povrsinska IS NULL THEN
    DELETE FROM production.pracenje_manual_overrides
     WHERE predmet_item_id = p_predmet_item_id
       AND bigtehn_rn_id = p_bigtehn_rn_id;
    RETURN NULL;
  END IF;

  INSERT INTO production.pracenje_manual_overrides (
    predmet_item_id, bigtehn_rn_id, rn_id,
    status_override, masinska_done, povrsinska_done,
    created_by, updated_by
  )
  VALUES (
    p_predmet_item_id, p_bigtehn_rn_id, p_rn_id,
    v_status, p_masinska, p_povrsinska,
    auth.uid(), auth.uid()
  )
  ON CONFLICT (predmet_item_id, bigtehn_rn_id) DO UPDATE SET
    status_override = EXCLUDED.status_override,
    masinska_done = EXCLUDED.masinska_done,
    povrsinska_done = EXCLUDED.povrsinska_done,
    rn_id = COALESCE(EXCLUDED.rn_id, production.pracenje_manual_overrides.rn_id),
    updated_by = auth.uid(),
    updated_at = now()
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;

-- ============ production.upsert_pracenje_parent_override [SECURITY DEFINER] ============
CREATE OR REPLACE FUNCTION production.upsert_pracenje_parent_override(p_predmet_item_id integer, p_bigtehn_rn_id bigint, p_parent_rn_id bigint DEFAULT NULL::bigint, p_clear boolean DEFAULT false)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'production', 'pg_temp'
AS $function$
DECLARE
  v_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Moraš biti ulogovan' USING ERRCODE = '42501';
  END IF;
  IF NOT public.can_manage_predmet_aktivacija() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_predmet_item_id IS NULL OR p_predmet_item_id <= 0
     OR p_bigtehn_rn_id IS NULL OR p_bigtehn_rn_id <= 0 THEN
    RAISE EXCEPTION 'Neispravan predmet ili RN' USING ERRCODE = '22000';
  END IF;
  IF p_parent_rn_id IS NOT NULL AND p_parent_rn_id = p_bigtehn_rn_id THEN
    RAISE EXCEPTION 'Pozicija ne može biti sama sebi sklop' USING ERRCODE = '22000';
  END IF;

  IF p_clear THEN
    DELETE FROM production.pracenje_parent_override
     WHERE predmet_item_id = p_predmet_item_id
       AND bigtehn_rn_id = p_bigtehn_rn_id;
    RETURN NULL;
  END IF;

  INSERT INTO production.pracenje_parent_override (
    predmet_item_id, bigtehn_rn_id, parent_override_rn_id, created_by, updated_by
  )
  VALUES (
    p_predmet_item_id, p_bigtehn_rn_id, p_parent_rn_id, auth.uid(), auth.uid()
  )
  ON CONFLICT (predmet_item_id, bigtehn_rn_id) DO UPDATE SET
    parent_override_rn_id = EXCLUDED.parent_override_rn_id,
    updated_by = auth.uid(),
    updated_at = now()
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;

-- ============ production.upsert_pracenje_proizvodnje_napomena [SECURITY DEFINER] ============
CREATE OR REPLACE FUNCTION production.upsert_pracenje_proizvodnje_napomena(p_predmet_item_id integer, p_bigtehn_rn_id bigint, p_note text, p_rn_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'production', 'pg_temp'
AS $function$
DECLARE
  v_id uuid;
  v_note text := coalesce(p_note, '');
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Moraš biti ulogovan' USING ERRCODE = '42501';
  END IF;
  IF NOT public.can_manage_predmet_aktivacija() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_predmet_item_id IS NULL OR p_predmet_item_id <= 0 OR p_bigtehn_rn_id IS NULL OR p_bigtehn_rn_id <= 0 THEN
    RAISE EXCEPTION 'Neispravan predmet ili RN' USING ERRCODE = '22000';
  END IF;

  INSERT INTO production.pracenje_proizvodnje_napomene (
    predmet_item_id, bigtehn_rn_id, rn_id, note, created_by, updated_by
  )
  VALUES (
    p_predmet_item_id, p_bigtehn_rn_id, p_rn_id, v_note, auth.uid(), auth.uid()
  )
  ON CONFLICT (predmet_item_id, bigtehn_rn_id) DO UPDATE SET
    note = EXCLUDED.note,
    rn_id = COALESCE(EXCLUDED.rn_id, production.pracenje_proizvodnje_napomene.rn_id),
    updated_by = auth.uid(),
    updated_at = now()
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;

-- ============ production.zatvori_aktivnost [SECURITY DEFINER] ============
CREATE OR REPLACE FUNCTION production.zatvori_aktivnost(p_id uuid, p_napomena text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'production', 'public', 'pg_temp'
AS $function$
DECLARE
  v_row production.operativna_aktivnost;
BEGIN
  SELECT * INTO v_row FROM production.operativna_aktivnost WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Aktivnost % ne postoji', p_id; END IF;
  IF NOT production.can_edit_pracenje(v_row.projekat_id, v_row.radni_nalog_id) THEN
    RAISE EXCEPTION 'Nemaš pravo zatvaranja aktivnosti';
  END IF;

  UPDATE production.operativna_aktivnost
     SET status = 'zavrseno',
         manual_override_status = NULL,
         blokirano_razlog = NULL,
         zatvoren_at = now(),
         zatvoren_by = auth.uid(),
         zatvoren_napomena = p_napomena,
         updated_by = auth.uid()
   WHERE id = p_id;
END;
$function$;

-- ============ public._po_cleanup_orphaned_machines_cron [SECURITY DEFINER] ============
CREATE OR REPLACE FUNCTION public._po_cleanup_orphaned_machines_cron()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_cleaned integer;
BEGIN
  UPDATE public.production_overlays po
     SET assigned_machine_code = NULL,
         updated_by            = 'system:cleanup:orphaned-machines'
   WHERE po.assigned_machine_code IS NOT NULL
     AND po.archived_at IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.bigtehn_machines_cache m
       WHERE m.rj_code = po.assigned_machine_code
     );
  GET DIAGNOSTICS v_cleaned = ROW_COUNT;

  /* Audit ide kroz production_overlays_history trigger (Sprint 1G).
     Cron metrika ostaje u cron.job_run_details. */
  RETURN v_cleaned;
END;
$function$;

-- ============ public.audit_row_change [SECURITY DEFINER] ============
CREATE OR REPLACE FUNCTION public.audit_row_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_action text := TG_OP;
  v_table  text := TG_TABLE_NAME;
  v_rec_id text;
  v_old    jsonb;
  v_new    jsonb;
  v_diff   text[] := '{}';
  v_key    text;
  v_email  text;
  v_uid    uuid;
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') THEN v_old := to_jsonb(OLD); END IF;
  IF TG_OP IN ('INSERT','UPDATE') THEN v_new := to_jsonb(NEW); END IF;

  IF TG_OP = 'DELETE' THEN
    v_rec_id := COALESCE(v_old ->> 'id', v_old ->> 'employee_id', v_old ->> 'pk');
  ELSE
    v_rec_id := COALESCE(v_new ->> 'id', v_new ->> 'employee_id', v_new ->> 'pk');
  END IF;

  IF TG_OP = 'UPDATE' AND v_old IS NOT NULL AND v_new IS NOT NULL THEN
    FOR v_key IN SELECT key FROM jsonb_each(v_new) LOOP
      IF (v_new -> v_key) IS DISTINCT FROM (v_old -> v_key) THEN
        v_diff := array_append(v_diff, v_key);
      END IF;
    END LOOP;
    IF array_length(v_diff, 1) IS NULL THEN RETURN NULL; END IF;
    IF array_length(v_diff, 1) = 1 AND v_diff[1] = 'updated_at' THEN RETURN NULL; END IF;
  END IF;

  BEGIN v_email := public.current_user_email(); EXCEPTION WHEN OTHERS THEN v_email := NULL; END;
  BEGIN v_uid := auth.uid(); EXCEPTION WHEN OTHERS THEN v_uid := NULL; END;

  INSERT INTO public.audit_log (table_name, record_id, action, actor_email, actor_uid, old_data, new_data, diff_keys)
  VALUES (v_table, v_rec_id, v_action, v_email, v_uid, v_old, v_new, v_diff);

  RETURN NULL;
END;
$function$;

-- ============ public.bulk_reassign_production_lines [SECURITY DEFINER] ============
CREATE OR REPLACE FUNCTION public.bulk_reassign_production_lines(p_pairs jsonb, p_target_machine text, p_force boolean DEFAULT false, p_force_reason text DEFAULT NULL::text, p_client_event_uuid uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth', 'pg_temp'
AS $function$
DECLARE
  v_pair   jsonb;
  v_count  integer := 0;
  v_result jsonb;
BEGIN
  IF NOT public.can_edit_plan_proizvodnje() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  IF jsonb_typeof(p_pairs) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'pairs_must_be_array' USING ERRCODE = '22023';
  END IF;

  FOR v_pair IN SELECT value FROM jsonb_array_elements(p_pairs) LOOP
    v_result := public.reassign_production_line(
      (v_pair ->> 'wo')::bigint,
      (v_pair ->> 'line')::bigint,
      p_target_machine,
      p_force,
      p_force_reason,
      p_client_event_uuid
    );
    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object('updated_count', v_count);
END;
$function$;

-- ============ public.bulk_reassign_production_lines [SECURITY DEFINER] ============
CREATE OR REPLACE FUNCTION public.bulk_reassign_production_lines(p_pairs jsonb, p_target_machine text, p_force boolean DEFAULT false, p_force_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth', 'pg_temp'
AS $function$
DECLARE
  v_pair   jsonb;
  v_count  integer := 0;
  v_result jsonb;
BEGIN
  IF NOT public.can_edit_plan_proizvodnje() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  IF jsonb_typeof(p_pairs) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'pairs_must_be_array' USING ERRCODE = '22023';
  END IF;

  FOR v_pair IN SELECT value FROM jsonb_array_elements(p_pairs) LOOP
    v_result := public.reassign_production_line(
      (v_pair ->> 'wo')::bigint,
      (v_pair ->> 'line')::bigint,
      p_target_machine,
      p_force,
      p_force_reason
    );
    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object('updated_count', v_count);
END;
$function$;

-- ============ public.can_edit_plan_proizvodnje [SECURITY DEFINER] ============
CREATE OR REPLACE FUNCTION public.can_edit_plan_proizvodnje()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    WHERE LOWER(ur.email) = LOWER(COALESCE(auth.jwt() ->> 'email', ''))
      AND ur.is_active = TRUE
      AND ur.role IN ('admin', 'pm', 'menadzment')
  );
$function$;

-- ============ public.can_edit_plan_proizvodnje_v2 [SECURITY DEFINER] ============
CREATE OR REPLACE FUNCTION public.can_edit_plan_proizvodnje_v2()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT public.current_user_role_v2() IN ('admin', 'pm', 'menadzment');
$function$;

-- ============ public.can_edit_pracenje ============
CREATE OR REPLACE FUNCTION public.can_edit_pracenje(p_project_id uuid DEFAULT NULL::uuid, p_rn_id uuid DEFAULT NULL::uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$ SELECT production.can_edit_pracenje(p_project_id, p_rn_id); $function$;

-- ============ public.can_force_plan_reassign [SECURITY DEFINER] ============
CREATE OR REPLACE FUNCTION public.can_force_plan_reassign()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    WHERE lower(ur.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
      AND ur.is_active IS TRUE
      AND ur.role IN ('admin', 'menadzment')
  );
$function$;

-- ============ public.can_manage_predmet_aktivacija [SECURITY DEFINER] ============
CREATE OR REPLACE FUNCTION public.can_manage_predmet_aktivacija()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT
    public.current_user_is_admin()
    OR EXISTS (
      SELECT 1
      FROM public.user_roles ur
      WHERE LOWER(ur.email) = LOWER(COALESCE((auth.jwt() ->> 'email'), ''))
        AND COALESCE(ur.is_active, true) IS TRUE
        AND ur.role = 'menadzment'
    );
$function$;

-- ============ public.can_read_production_drawings [SECURITY DEFINER] ============
CREATE OR REPLACE FUNCTION public.can_read_production_drawings()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select exists(
    select 1 from public.user_roles ur
    where lower(ur.email) = lower(coalesce(auth.jwt()->>'email',''))
      and ur.is_active
      and ur.role::text in ('admin','menadzment','pm','leadpm','inzenjer','projektant_vodja','magacioner','poslovni_admin')
  );
$function$;

-- ============ public.current_user_can_edit [SECURITY DEFINER] ============
CREATE OR REPLACE FUNCTION public.current_user_can_edit()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT public.current_user_role() IN ('pm','leadpm');
$function$;

-- ============ public.current_user_is_admin [SECURITY DEFINER] ============
CREATE OR REPLACE FUNCTION public.current_user_is_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM   public.user_roles
    WHERE  LOWER(email) = LOWER(COALESCE(auth.jwt() ->> 'email', ''))
      AND  role = 'admin'
      AND  is_active = TRUE
  );
$function$;

-- ============ public.current_user_is_management [SECURITY DEFINER] ============
CREATE OR REPLACE FUNCTION public.current_user_is_management()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM   public.user_roles
    WHERE  LOWER(email) = LOWER(COALESCE(auth.jwt() ->> 'email', ''))
      AND  role IN ('admin','menadzment')
      AND  project_id IS NULL
      AND  is_active = TRUE
  );
$function$;

-- ============ public.ensure_radni_nalog_iz_bigtehn ============
CREATE OR REPLACE FUNCTION public.ensure_radni_nalog_iz_bigtehn(p_work_order_id bigint)
 RETURNS uuid
 LANGUAGE sql
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT production.ensure_radni_nalog_iz_bigtehn(p_work_order_id);
$function$;

-- ============ public.get_aktivni_predmeti ============
CREATE OR REPLACE FUNCTION public.get_aktivni_predmeti()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT production.get_aktivni_predmeti();
$function$;

-- ============ public.get_bigtehn_prijave_za_operaciju ============
CREATE OR REPLACE FUNCTION public.get_bigtehn_prijave_za_operaciju(p_work_order_id bigint, p_operacija integer, p_machine_code text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT production.get_bigtehn_prijave_za_operaciju(p_work_order_id, p_operacija, p_machine_code);
$function$;

-- ============ public.get_operativni_plan ============
CREATE OR REPLACE FUNCTION public.get_operativni_plan(p_rn_id uuid DEFAULT NULL::uuid, p_projekat_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$ SELECT production.get_operativni_plan(p_rn_id, p_projekat_id); $function$;

-- ============ public.get_podsklopovi_predmeta ============
CREATE OR REPLACE FUNCTION public.get_podsklopovi_predmeta(p_item_id integer)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT production.get_podsklopovi_predmeta(p_item_id);
$function$;

-- ============ public.get_pracenje_portfolio ============
CREATE OR REPLACE FUNCTION public.get_pracenje_portfolio(p_lot_qty integer DEFAULT 12)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$ SELECT production.get_pracenje_portfolio(p_lot_qty); $function$;

-- ============ public.get_pracenje_rn ============
CREATE OR REPLACE FUNCTION public.get_pracenje_rn(p_rn_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$ SELECT production.get_pracenje_rn(p_rn_id); $function$;

-- ============ public.get_predmet_plan_prioritet_ids [SECURITY DEFINER] ============
CREATE OR REPLACE FUNCTION public.get_predmet_plan_prioritet_ids()
 RETURNS integer[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'production', 'pg_temp'
AS $function$
  SELECT COALESCE(
    array_agg(predmet_item_id ORDER BY slot ASC),
    ARRAY[]::integer[]
  )
  FROM production.predmet_plan_prioritet;
$function$;

-- ============ public.get_predmet_plan_prioritet_max [SECURITY DEFINER] ============
CREATE OR REPLACE FUNCTION public.get_predmet_plan_prioritet_max()
 RETURNS smallint
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(
    (SELECT max_count FROM public.predmet_plan_prioritet_settings WHERE id = 1),
    10::smallint
  );
$function$;

-- ============ public.get_predmet_plan_prioritet_prev [SECURITY DEFINER] ============
CREATE OR REPLACE FUNCTION public.get_predmet_plan_prioritet_prev()
 RETURNS integer[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'production', 'pg_temp'
AS $function$
  SELECT a.item_ids
  FROM production.predmet_plan_prioritet_audit a
  WHERE COALESCE(array_length(a.item_ids, 1), 0) > 0
    AND a.item_ids IS DISTINCT FROM (
      SELECT COALESCE(array_agg(predmet_item_id ORDER BY slot), ARRAY[]::integer[])
      FROM production.predmet_plan_prioritet
    )
  ORDER BY a.changed_at DESC
  LIMIT 1;
$function$;

-- ============ public.get_predmet_pracenje_izvestaj ============
CREATE OR REPLACE FUNCTION public.get_predmet_pracenje_izvestaj(p_predmet_item_id integer, p_root_rn_id bigint DEFAULT NULL::bigint, p_lot_qty integer DEFAULT 12)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT production.get_predmet_pracenje_izvestaj(p_predmet_item_id, p_root_rn_id, p_lot_qty);
$function$;

-- ============ public.has_edit_role [SECURITY DEFINER] ============
CREATE OR REPLACE FUNCTION public.has_edit_role(proj_id uuid DEFAULT NULL::uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  auth_email TEXT := lower(coalesce(auth.jwt()->>'email', ''));
BEGIN
  IF auth_email = '' THEN
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE lower(email) = auth_email
      AND project_id IS NULL
      AND role IN ('admin','hr','menadzment','pm','leadpm','poslovni_admin')
      AND is_active = true
  ) THEN
    RETURN true;
  END IF;

  IF proj_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE lower(email) = auth_email
      AND project_id = proj_id
      AND role IN ('pm','leadpm')
      AND is_active = true
  ) THEN
    RETURN true;
  END IF;

  RETURN false;
END;
$function$;

-- ============ public.list_predmet_aktivacija_admin [SECURITY DEFINER] ============
CREATE OR REPLACE FUNCTION public.list_predmet_aktivacija_admin()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'production', 'pg_temp'
AS $function$
  SELECT production.list_predmet_aktivacija_admin();
$function$;

-- ============ public.montaza_assign_izvestaj_broj [SECURITY DEFINER] ============
CREATE OR REPLACE FUNCTION public.montaza_assign_izvestaj_broj()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  g int := extract(year FROM now())::int;
  n int;
BEGIN
  IF NEW.broj_izvestaja IS NOT NULL AND btrim(NEW.broj_izvestaja) <> '' THEN
    RETURN NEW;  -- ručno dodeljen broj se poštuje
  END IF;

  INSERT INTO public.montaza_izvestaj_brojaci (godina, poslednji)
  VALUES (g, 1)
  ON CONFLICT (godina) DO UPDATE
    SET poslednji = public.montaza_izvestaj_brojaci.poslednji + 1
  RETURNING poslednji INTO n;

  NEW.broj_izvestaja := 'IZV-' || g::text || '-' || lpad(n::text, 4, '0');
  RETURN NEW;
END;
$function$;

-- ============ public.pb_list_projects [SECURITY DEFINER] ============
CREATE OR REPLACE FUNCTION public.pb_list_projects()
 RETURNS TABLE(id uuid, project_code text, project_name text, status text, predmet_item_id integer, projectm text, project_deadline date, pm_email text, leadpm_email text, reminder_enabled boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'production', 'pg_temp'
AS $function$
  SELECT
    p.id,
    p.project_code,
    p.project_name,
    p.status,
    p.bigtehn_item_id AS predmet_item_id,
    p.projectm,
    p.project_deadline,
    p.pm_email,
    p.leadpm_email,
    p.reminder_enabled
  FROM public.projects p
  INNER JOIN production.predmet_aktivacija pa ON pa.predmet_item_id = p.bigtehn_item_id
  WHERE p.bigtehn_item_id IS NOT NULL AND pa.je_aktivan IS TRUE AND pa.je_projektovanje_montaza IS TRUE
  ORDER BY p.project_code ASC NULLS LAST, p.project_name ASC;
$function$;

-- ============ public.plan_pp_open_ops_for_machine ============
CREATE OR REPLACE FUNCTION public.plan_pp_open_ops_for_machine(p_machine_code text, p_work_order_limit integer DEFAULT 100, p_work_order_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
 SET statement_timeout TO '180s'
AS $function$
DECLARE
  mc  text;
  lim int;
  off int;
BEGIN
  mc := btrim(p_machine_code);
  IF mc = '' THEN
    RETURN jsonb_build_object('rows', '[]'::jsonb, 'has_more', false, 'next_work_order_offset', 0);
  END IF;
  lim := GREATEST(LEAST(COALESCE(p_work_order_limit, 100), 250), 1);
  off := GREATEST(COALESCE(p_work_order_offset, 0), 0);
  RETURN (
    WITH filtered AS (
      SELECT e.* FROM public.v_production_operations_effective e
      WHERE e.effective_machine_code = mc
        AND e.is_done_in_bigtehn IS FALSE AND e.rn_zavrsen IS FALSE
        AND e.is_cooperation_effective IS FALSE
        AND (e.local_status IS NULL OR e.local_status <> 'completed')
        AND e.overlay_archived_at IS NULL
    ),
    ordered AS (
      SELECT f.*, ROW_NUMBER() OVER (
        ORDER BY f.shift_sort_order ASC NULLS LAST, f.auto_sort_bucket ASC,
          f.rok_izrade ASC NULLS LAST, f.prioritet_bigtehn ASC
      ) AS _sort_idx FROM filtered f
    ),
    wo_first AS (SELECT work_order_id, MIN(_sort_idx) AS first_sort FROM ordered GROUP BY work_order_id),
    wo_numbered AS (SELECT work_order_id, ROW_NUMBER() OVER (ORDER BY first_sort) AS wo_seq FROM wo_first),
    picked_wo AS (SELECT work_order_id FROM wo_numbered WHERE wo_seq > off AND wo_seq <= off + lim),
    row_json AS (
      SELECT COALESCE(jsonb_agg((to_jsonb(o) - '_sort_idx') ORDER BY o._sort_idx), '[]'::jsonb) AS ja
      FROM ordered o WHERE o.work_order_id IN (SELECT work_order_id FROM picked_wo)
    )
    SELECT jsonb_build_object(
      'rows', (SELECT ja FROM row_json),
      'has_more', EXISTS (SELECT 1 FROM wo_numbered w WHERE w.wo_seq > off + lim),
      'next_work_order_offset', off + (SELECT COUNT(*)::int FROM picked_wo)
    )
  );
END;
$function$;

-- ============ public.pp_force_audit_columns ============
CREATE OR REPLACE FUNCTION public.pp_force_audit_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_email text;
  v_uid_text text;
BEGIN
  v_email := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_uid_text := nullif(auth.uid()::text, '');
  IF v_email = '' THEN
    v_email := v_uid_text;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF TG_TABLE_NAME = 'production_drawings' THEN
      NEW.uploaded_by := COALESCE(v_uid_text::uuid, NEW.uploaded_by);
    ELSE
      NEW.created_by := v_email;
      NEW.updated_by := v_email;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF TG_TABLE_NAME = 'production_drawings' THEN
      IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at AND NEW.deleted_at IS NOT NULL THEN
        NEW.deleted_by := COALESCE(v_uid_text::uuid, NEW.deleted_by);
      END IF;
    ELSE
      NEW.updated_by := v_email;
      NEW.created_by := OLD.created_by;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

-- ============ public.production_overlays_audit_history [SECURITY DEFINER] ============
CREATE OR REPLACE FUNCTION public.production_overlays_audit_history()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_changed_by text;
BEGIN
  -- Primarni izvor: NEW.updated_by (ono što je RPC ili klijent eksplicitno
  -- postavio). Fallback: trenutni user email iz auth.jwt (npr. ako klijent
  -- ne postavi updated_by). Poslednji fallback: 'unknown'.
  v_changed_by := COALESCE(NEW.updated_by, public.current_user_email(), 'unknown');

  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.production_overlays_history (
      overlay_id, work_order_id, line_id, field_name, old_value, new_value, changed_by
    ) VALUES (
      NEW.id, NEW.work_order_id, NEW.line_id, '_created',
      NULL, NEW.local_status, COALESCE(NEW.created_by, v_changed_by)
    );
    RETURN NEW;
  END IF;

  -- UPDATE: po jedan INSERT za svaki tracked field koji se stvarno promenio

  IF NEW.local_status IS DISTINCT FROM OLD.local_status THEN
    INSERT INTO public.production_overlays_history (
      overlay_id, work_order_id, line_id, field_name, old_value, new_value, changed_by
    ) VALUES (
      NEW.id, NEW.work_order_id, NEW.line_id, 'local_status',
      OLD.local_status, NEW.local_status, v_changed_by
    );
  END IF;

  IF NEW.assigned_machine_code IS DISTINCT FROM OLD.assigned_machine_code THEN
    INSERT INTO public.production_overlays_history (
      overlay_id, work_order_id, line_id, field_name, old_value, new_value, changed_by
    ) VALUES (
      NEW.id, NEW.work_order_id, NEW.line_id, 'assigned_machine_code',
      OLD.assigned_machine_code, NEW.assigned_machine_code, v_changed_by
    );
  END IF;

  IF NEW.cam_ready IS DISTINCT FROM OLD.cam_ready THEN
    INSERT INTO public.production_overlays_history (
      overlay_id, work_order_id, line_id, field_name, old_value, new_value, changed_by
    ) VALUES (
      NEW.id, NEW.work_order_id, NEW.line_id, 'cam_ready',
      OLD.cam_ready::text, NEW.cam_ready::text, v_changed_by
    );
  END IF;

  IF NEW.shift_note IS DISTINCT FROM OLD.shift_note THEN
    INSERT INTO public.production_overlays_history (
      overlay_id, work_order_id, line_id, field_name, old_value, new_value, changed_by
    ) VALUES (
      NEW.id, NEW.work_order_id, NEW.line_id, 'shift_note',
      OLD.shift_note, NEW.shift_note, v_changed_by
    );
  END IF;

  IF NEW.cooperation_status IS DISTINCT FROM OLD.cooperation_status THEN
    INSERT INTO public.production_overlays_history (
      overlay_id, work_order_id, line_id, field_name, old_value, new_value, changed_by
    ) VALUES (
      NEW.id, NEW.work_order_id, NEW.line_id, 'cooperation_status',
      OLD.cooperation_status, NEW.cooperation_status, v_changed_by
    );
  END IF;

  IF NEW.archived_at IS DISTINCT FROM OLD.archived_at THEN
    INSERT INTO public.production_overlays_history (
      overlay_id, work_order_id, line_id, field_name, old_value, new_value, changed_by
    ) VALUES (
      NEW.id, NEW.work_order_id, NEW.line_id, 'archived_at',
      OLD.archived_at::text, NEW.archived_at::text, v_changed_by
    );
  END IF;

  RETURN NEW;
END;
$function$;

-- ============ public.promovisi_akcionu_tacku ============
CREATE OR REPLACE FUNCTION public.promovisi_akcionu_tacku(p_akcioni_plan_id uuid, p_odeljenje_id uuid, p_rn_id uuid)
 RETURNS uuid
 LANGUAGE sql
 SET search_path TO 'public', 'pg_temp'
AS $function$ SELECT production.promovisi_akcionu_tacku(p_akcioni_plan_id, p_odeljenje_id, p_rn_id); $function$;

-- ============ public.reassign_production_line [SECURITY DEFINER] ============
CREATE OR REPLACE FUNCTION public.reassign_production_line(p_work_order_id bigint, p_line_id bigint, p_target_machine text, p_force boolean DEFAULT false, p_force_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth', 'pg_temp'
AS $function$
DECLARE
  v_original_machine text;
  v_source_machine   text;
  v_target_machine   text := nullif(btrim(p_target_machine), '');
  v_source_group     text;
  v_target_group     text;
  v_actor            text;
  v_forced           boolean := false;
BEGIN
  IF NOT public.can_edit_plan_proizvodnje() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT
    l.machine_code,
    coalesce(o.assigned_machine_code, l.machine_code)
  INTO v_original_machine, v_source_machine
  FROM public.bigtehn_work_order_lines_cache l
  LEFT JOIN public.production_overlays o
    ON o.work_order_id = l.work_order_id
   AND o.line_id = l.id
  WHERE l.work_order_id = p_work_order_id
    AND l.id = p_line_id
  LIMIT 1;

  IF v_original_machine IS NULL THEN
    RAISE EXCEPTION 'operation_not_found' USING ERRCODE = '22023';
  END IF;

  -- Izbor originalne masine tretiramo kao "vrati na original", tj. NULL overlay.
  IF v_target_machine IS NOT NULL AND v_target_machine = v_original_machine THEN
    v_target_machine := NULL;
  END IF;

  IF v_target_machine IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.bigtehn_machines_cache m
      WHERE m.rj_code = v_target_machine
    ) THEN
      RAISE EXCEPTION 'target_machine_not_found' USING ERRCODE = '22023';
    END IF;

    v_source_group := public.production_machine_group_slug(v_source_machine);
    v_target_group := public.production_machine_group_slug(v_target_machine);

    IF v_source_group IS DISTINCT FROM v_target_group THEN
      IF NOT p_force THEN
        RAISE EXCEPTION 'machine_group_mismatch' USING ERRCODE = '22023';
      END IF;
      IF NOT public.can_force_plan_reassign() THEN
        RAISE EXCEPTION 'force_reassign_forbidden' USING ERRCODE = '42501';
      END IF;
      IF p_force_reason IS NULL OR length(btrim(p_force_reason)) < 3 THEN
        RAISE EXCEPTION 'force_reason_required' USING ERRCODE = '22023';
      END IF;
      v_forced := true;
    END IF;
  ELSE
    v_source_group := public.production_machine_group_slug(v_source_machine);
    v_target_group := public.production_machine_group_slug(v_original_machine);
  END IF;

  v_actor := coalesce(public.current_user_email(), auth.jwt() ->> 'email', 'unknown');

  INSERT INTO public.production_overlays (
    work_order_id,
    line_id,
    assigned_machine_code,
    created_by,
    updated_by
  ) VALUES (
    p_work_order_id,
    p_line_id,
    v_target_machine,
    v_actor,
    v_actor
  )
  ON CONFLICT (work_order_id, line_id) DO UPDATE SET
    assigned_machine_code = EXCLUDED.assigned_machine_code,
    updated_by = EXCLUDED.updated_by;

  IF v_forced THEN
    INSERT INTO public.production_reassign_audit (
      work_order_id,
      line_id,
      actor_email,
      source_machine,
      target_machine,
      source_group,
      target_group,
      force_reason
    ) VALUES (
      p_work_order_id,
      p_line_id,
      v_actor,
      v_source_machine,
      v_target_machine,
      v_source_group,
      v_target_group,
      btrim(p_force_reason)
    );
  END IF;

  RETURN jsonb_build_object(
    'work_order_id', p_work_order_id,
    'line_id', p_line_id,
    'assigned_machine_code', v_target_machine,
    'source_group', v_source_group,
    'target_group', v_target_group,
    'forced', v_forced
  );
END;
$function$;

-- ============ public.reassign_production_line [SECURITY DEFINER] ============
CREATE OR REPLACE FUNCTION public.reassign_production_line(p_work_order_id bigint, p_line_id bigint, p_target_machine text, p_force boolean DEFAULT false, p_force_reason text DEFAULT NULL::text, p_client_event_uuid uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth', 'pg_temp'
AS $function$
DECLARE
  v_original_machine text;
  v_source_machine   text;
  v_target_machine   text := nullif(btrim(p_target_machine), '');
  v_source_group     text;
  v_target_group     text;
  v_actor            text;
  v_forced           boolean := false;
BEGIN
  IF NOT public.can_edit_plan_proizvodnje() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT
    l.machine_code,
    coalesce(o.assigned_machine_code, l.machine_code)
  INTO v_original_machine, v_source_machine
  FROM public.bigtehn_work_order_lines_cache l
  LEFT JOIN public.production_overlays o
    ON o.work_order_id = l.work_order_id
   AND o.line_id = l.id
  WHERE l.work_order_id = p_work_order_id
    AND l.id = p_line_id
  LIMIT 1;

  IF v_original_machine IS NULL THEN
    RAISE EXCEPTION 'operation_not_found' USING ERRCODE = '22023';
  END IF;

  -- Izbor originalne mašine tretiramo kao "vrati na original", tj. NULL overlay.
  IF v_target_machine IS NOT NULL AND v_target_machine = v_original_machine THEN
    v_target_machine := NULL;
  END IF;

  IF v_target_machine IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.bigtehn_machines_cache m
      WHERE m.rj_code = v_target_machine
    ) THEN
      RAISE EXCEPTION 'target_machine_not_found' USING ERRCODE = '22023';
    END IF;

    v_source_group := public.production_machine_group_slug(v_source_machine);
    v_target_group := public.production_machine_group_slug(v_target_machine);

    IF v_source_group IS DISTINCT FROM v_target_group THEN
      IF NOT p_force THEN
        RAISE EXCEPTION 'machine_group_mismatch' USING ERRCODE = '22023';
      END IF;
      IF NOT public.can_force_plan_reassign() THEN
        RAISE EXCEPTION 'force_reassign_forbidden' USING ERRCODE = '42501';
      END IF;
      IF p_force_reason IS NULL OR length(btrim(p_force_reason)) < 3 THEN
        RAISE EXCEPTION 'force_reason_required' USING ERRCODE = '22023';
      END IF;
      v_forced := true;
    END IF;
  ELSE
    v_source_group := public.production_machine_group_slug(v_source_machine);
    v_target_group := public.production_machine_group_slug(v_original_machine);
  END IF;

  v_actor := coalesce(public.current_user_email(), auth.jwt() ->> 'email', 'unknown');

  -- Overlay UPSERT (idempotentno po (work_order_id, line_id))
  INSERT INTO public.production_overlays (
    work_order_id,
    line_id,
    assigned_machine_code,
    created_by,
    updated_by
  ) VALUES (
    p_work_order_id,
    p_line_id,
    v_target_machine,
    v_actor,
    v_actor
  )
  ON CONFLICT (work_order_id, line_id) DO UPDATE SET
    assigned_machine_code = EXCLUDED.assigned_machine_code,
    updated_by = EXCLUDED.updated_by;

  -- Audit INSERT (idempotentno po (client_event_uuid, line_id) ako je UUID poslat)
  IF v_forced THEN
    INSERT INTO public.production_reassign_audit (
      work_order_id,
      line_id,
      actor_email,
      source_machine,
      target_machine,
      source_group,
      target_group,
      force_reason,
      client_event_uuid
    ) VALUES (
      p_work_order_id,
      p_line_id,
      v_actor,
      v_source_machine,
      v_target_machine,
      v_source_group,
      v_target_group,
      btrim(p_force_reason),
      p_client_event_uuid
    )
    ON CONFLICT (client_event_uuid, line_id) DO NOTHING;
  END IF;

  RETURN jsonb_build_object(
    'work_order_id', p_work_order_id,
    'line_id', p_line_id,
    'assigned_machine_code', v_target_machine,
    'source_group', v_source_group,
    'target_group', v_target_group,
    'forced', v_forced
  );
END;
$function$;

-- ============ public.search_proizvodnja_delovi ============
CREATE OR REPLACE FUNCTION public.search_proizvodnja_delovi(p_q text, p_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT production.search_proizvodnja_delovi(p_q, p_limit);
$function$;

-- ============ public.set_blokirano ============
CREATE OR REPLACE FUNCTION public.set_blokirano(p_id uuid, p_razlog text)
 RETURNS void
 LANGUAGE sql
 SET search_path TO 'public', 'pg_temp'
AS $function$ SELECT production.set_blokirano(p_id, p_razlog); $function$;

-- ============ public.set_montaza_ai_model [SECURITY DEFINER] ============
CREATE OR REPLACE FUNCTION public.set_montaza_ai_model(p_model text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  m text := lower(trim(coalesce(p_model, '')));
BEGIN
  IF NOT public.current_user_is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  IF m NOT IN ('claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5') THEN
    RAISE EXCEPTION 'nepoznat model: %', p_model USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.montaza_ai_settings (id, model, updated_by, updated_at)
  VALUES (1, m, auth.uid(), now())
  ON CONFLICT (id) DO UPDATE
    SET model = EXCLUDED.model,
        updated_by = EXCLUDED.updated_by,
        updated_at = EXCLUDED.updated_at;

  RETURN m;
END;
$function$;

-- ============ public.set_predmet_aktivacija [SECURITY DEFINER] ============
CREATE OR REPLACE FUNCTION public.set_predmet_aktivacija(p_item_id integer, p_aktivan boolean, p_napomena text DEFAULT NULL::text, p_projektovanje_montaza boolean DEFAULT NULL::boolean)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'production', 'pg_temp'
AS $function$
  SELECT production.set_predmet_aktivacija(
    p_item_id,
    p_aktivan,
    p_napomena,
    p_projektovanje_montaza
  );
$function$;

-- ============ public.set_predmet_plan_prioritet [SECURITY DEFINER] ============
CREATE OR REPLACE FUNCTION public.set_predmet_plan_prioritet(p_item_ids integer[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'production', 'pg_temp'
AS $function$
DECLARE
  ids integer[];
  n int;
  i int;
  v_max int;
BEGIN
  IF NOT public.can_manage_predmet_aktivacija() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  v_max := public.get_predmet_plan_prioritet_max();

  ids := COALESCE(p_item_ids, ARRAY[]::integer[]);
  n := COALESCE(array_length(ids, 1), 0);

  IF n > v_max THEN
    RAISE EXCEPTION 'max % prioriteta', v_max USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1 FROM unnest(ids) u GROUP BY u HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplikat predmet_item_id' USING ERRCODE = '23514';
  END IF;

  FOR i IN 1..n LOOP
    IF ids[i] IS NULL OR ids[i] <= 0 THEN
      RAISE EXCEPTION 'neispravan predmet_item_id' USING ERRCODE = '23514';
    END IF;
  END LOOP;

  IF n > 0 AND EXISTS (
    SELECT 1
    FROM unnest(ids) AS u(item_id)
    LEFT JOIN public.bigtehn_items_cache b ON b.id = u.item_id
    WHERE b.id IS NULL
    LIMIT 1
  ) THEN
    RAISE EXCEPTION 'nepoznat predmet u cache-u' USING ERRCODE = '23514';
  END IF;

  -- WHERE true: zaobilazi pg_safeupdate (authenticator preload), briše sve redove.
  DELETE FROM production.predmet_plan_prioritet WHERE true;

  FOR i IN 1..n LOOP
    INSERT INTO production.predmet_plan_prioritet (predmet_item_id, slot, updated_by, updated_at)
    VALUES (ids[i], i - 1, auth.uid(), now());
  END LOOP;
END;
$function$;

-- ============ public.set_predmet_plan_prioritet_max [SECURITY DEFINER] ============
CREATE OR REPLACE FUNCTION public.set_predmet_plan_prioritet_max(p_max integer)
 RETURNS smallint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'production', 'pg_temp'
AS $function$
DECLARE
  v_cur int;
BEGIN
  IF NOT public.can_manage_predmet_aktivacija() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  IF p_max IS NULL OR p_max < 1 OR p_max > 50 THEN
    RAISE EXCEPTION 'broj mora biti 1..50' USING ERRCODE = '23514';
  END IF;

  -- Ne dozvoli smanjenje ispod trenutnog broja u listi (da ne ostane „višak").
  SELECT COUNT(*) INTO v_cur FROM production.predmet_plan_prioritet;
  IF p_max < v_cur THEN
    RAISE EXCEPTION 'trenutno ima % u listi prioriteta; ukloni neke pre smanjenja na %', v_cur, p_max
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.predmet_plan_prioritet_settings (id, max_count, updated_by, updated_at)
  VALUES (1, p_max::smallint, auth.uid(), now())
  ON CONFLICT (id) DO UPDATE
    SET max_count = EXCLUDED.max_count,
        updated_by = EXCLUDED.updated_by,
        updated_at = EXCLUDED.updated_at;

  RETURN p_max::smallint;
END;
$function$;

-- ============ public.set_predmet_prioritet ============
CREATE OR REPLACE FUNCTION public.set_predmet_prioritet(p_item_id integer, p_sort_priority integer)
 RETURNS void
 LANGUAGE sql
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT production.set_predmet_prioritet(p_item_id, p_sort_priority);
$function$;

-- ============ public.shift_predmet_prioritet ============
CREATE OR REPLACE FUNCTION public.shift_predmet_prioritet(p_item_id integer, p_direction text)
 RETURNS void
 LANGUAGE sql
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT production.shift_predmet_prioritet(p_item_id, p_direction);
$function$;

-- ============ public.skini_blokadu ============
CREATE OR REPLACE FUNCTION public.skini_blokadu(p_id uuid, p_napomena text)
 RETURNS void
 LANGUAGE sql
 SET search_path TO 'public', 'pg_temp'
AS $function$ SELECT production.skini_blokadu(p_id, p_napomena); $function$;

-- ============ public.upsert_operativna_aktivnost ============
CREATE OR REPLACE FUNCTION public.upsert_operativna_aktivnost(p_id uuid, p_radni_nalog_id uuid, p_projekat_id uuid, p_odeljenje_id uuid, p_naziv_aktivnosti text, p_planirani_pocetak date, p_planirani_zavrsetak date, p_odgovoran_user_id uuid, p_odgovoran_radnik_id uuid, p_status production.aktivnost_status, p_prioritet production.aktivnost_prioritet, p_rb integer, p_opis text, p_broj_tp text, p_kolicina_text text, p_odgovoran_label text, p_zavisi_od_aktivnost_id uuid, p_zavisi_od_text text, p_status_mode production.aktivnost_status_mode, p_rizik_napomena text, p_izvor production.aktivnost_izvor, p_izvor_akcioni_plan_id uuid, p_izvor_pozicija_id uuid, p_izvor_tp_operacija_id uuid)
 RETURNS uuid
 LANGUAGE sql
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT production.upsert_operativna_aktivnost(
    p_id, p_radni_nalog_id, p_projekat_id, p_odeljenje_id, p_naziv_aktivnosti,
    p_planirani_pocetak, p_planirani_zavrsetak, p_odgovoran_user_id, p_odgovoran_radnik_id,
    p_status, p_prioritet, p_rb, p_opis, p_broj_tp, p_kolicina_text, p_odgovoran_label,
    p_zavisi_od_aktivnost_id, p_zavisi_od_text, p_status_mode, p_rizik_napomena, p_izvor,
    p_izvor_akcioni_plan_id, p_izvor_pozicija_id, p_izvor_tp_operacija_id
  );
$function$;

-- ============ public.upsert_pracenje_manual_override ============
CREATE OR REPLACE FUNCTION public.upsert_pracenje_manual_override(p_predmet_item_id integer, p_bigtehn_rn_id bigint, p_status text DEFAULT NULL::text, p_masinska boolean DEFAULT NULL::boolean, p_povrsinska boolean DEFAULT NULL::boolean, p_rn_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE sql
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT production.upsert_pracenje_manual_override(
    p_predmet_item_id, p_bigtehn_rn_id, p_status, p_masinska, p_povrsinska, p_rn_id
  );
$function$;

-- ============ public.upsert_pracenje_parent_override ============
CREATE OR REPLACE FUNCTION public.upsert_pracenje_parent_override(p_predmet_item_id integer, p_bigtehn_rn_id bigint, p_parent_rn_id bigint DEFAULT NULL::bigint, p_clear boolean DEFAULT false)
 RETURNS uuid
 LANGUAGE sql
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT production.upsert_pracenje_parent_override(p_predmet_item_id, p_bigtehn_rn_id, p_parent_rn_id, p_clear);
$function$;

-- ============ public.upsert_pracenje_proizvodnje_napomena ============
CREATE OR REPLACE FUNCTION public.upsert_pracenje_proizvodnje_napomena(p_predmet_item_id integer, p_bigtehn_rn_id bigint, p_note text, p_rn_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE sql
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT production.upsert_pracenje_proizvodnje_napomena(
    p_predmet_item_id, p_bigtehn_rn_id, p_note, p_rn_id
  );
$function$;

-- ============ public.zatvori_aktivnost ============
CREATE OR REPLACE FUNCTION public.zatvori_aktivnost(p_id uuid, p_napomena text)
 RETURNS void
 LANGUAGE sql
 SET search_path TO 'public', 'pg_temp'
AS $function$ SELECT production.zatvori_aktivnost(p_id, p_napomena); $function$;

-- ============================================================================
-- (C) VIEW DEFINICIJE (public bridge + v_production_operations lanac; svi security_invoker=true)
-- ============================================================================

-- ============ VIEW production.v_operativna_aktivnost ============
CREATE OR REPLACE VIEW production.v_operativna_aktivnost AS
WITH linked AS (
         SELECT oa.id AS aktivnost_id,
            COALESCE(oap.radni_nalog_pozicija_id, oa.izvor_pozicija_id) AS radni_nalog_pozicija_id,
            COALESCE(oap.tp_operacija_id, oa.izvor_tp_operacija_id) AS tp_operacija_id
           FROM (production.operativna_aktivnost oa
             LEFT JOIN production.operativna_aktivnost_pozicija oap ON ((oap.aktivnost_id = oa.id)))
          WHERE ((oap.id IS NOT NULL) OR (oa.izvor_pozicija_id IS NOT NULL) OR (oa.izvor_tp_operacija_id IS NOT NULL))
        ), linked_progress AS (
         SELECT l.aktivnost_id,
            (count(*))::integer AS linked_count,
            (COALESCE(sum(vpp.planirano_komada), (0)::numeric))::numeric(12,3) AS planirano_komada,
            (COALESCE(sum(vpp.prijavljeno_komada), (0)::numeric))::numeric(12,3) AS prijavljeno_komada,
            bool_or((vpp.auto_status = 'blokirano'::production.aktivnost_status)) AS any_blocked,
            bool_or((vpp.prijavljeno_komada > (0)::numeric)) AS any_started,
            bool_and((vpp.auto_status = 'zavrseno'::production.aktivnost_status)) AS all_done
           FROM (linked l
             LEFT JOIN production.v_pozicija_progress vpp ON (((vpp.radni_nalog_pozicija_id = l.radni_nalog_pozicija_id) AND ((l.tp_operacija_id IS NULL) OR (vpp.tp_operacija_id = l.tp_operacija_id)))))
          GROUP BY l.aktivnost_id
        ), effective AS (
         SELECT oa.id,
            oa.radni_nalog_id,
            oa.projekat_id,
            oa.rb,
            oa.odeljenje_id,
            oa.naziv_aktivnosti,
            oa.opis,
            oa.broj_tp,
            oa.kolicina_text,
            oa.planirani_pocetak,
            oa.planirani_zavrsetak,
            oa.odgovoran_user_id,
            oa.odgovoran_radnik_id,
            oa.odgovoran_label,
            oa.zavisi_od_aktivnost_id,
            oa.zavisi_od_text,
            oa.status,
            oa.status_mode,
            oa.manual_override_status,
            oa.blokirano_razlog,
            oa.prioritet,
            oa.rizik_napomena,
            oa.izvor,
            oa.izvor_akcioni_plan_id,
            oa.izvor_pozicija_id,
            oa.izvor_tp_operacija_id,
            oa.zatvoren_at,
            oa.zatvoren_by,
            oa.zatvoren_napomena,
            oa.legacy_id,
            oa.created_at,
            oa.updated_at,
            oa.created_by,
            oa.updated_by,
            rn.datum_isporuke,
            rn.rn_broj,
            rn.naziv AS radni_nalog_naziv,
            od.kod AS odeljenje_kod,
            od.naziv AS odeljenje_naziv,
            COALESCE(lp.linked_count, 0) AS linked_count,
            COALESCE(lp.planirano_komada, (0)::numeric) AS planirano_komada,
            COALESCE(lp.prijavljeno_komada, (0)::numeric) AS prijavljeno_komada,
                CASE
                    WHEN ((lp.linked_count IS NULL) OR (lp.linked_count = 0)) THEN oa.status
                    WHEN lp.any_blocked THEN 'blokirano'::production.aktivnost_status
                    WHEN lp.all_done THEN 'zavrseno'::production.aktivnost_status
                    WHEN lp.any_started THEN 'u_toku'::production.aktivnost_status
                    ELSE 'nije_krenulo'::production.aktivnost_status
                END AS auto_status
           FROM (((production.operativna_aktivnost oa
             JOIN production.radni_nalog rn ON ((rn.id = oa.radni_nalog_id)))
             JOIN core.odeljenje od ON ((od.id = oa.odeljenje_id)))
             LEFT JOIN linked_progress lp ON ((lp.aktivnost_id = oa.id)))
        )
 SELECT id,
    radni_nalog_id,
    projekat_id,
    rb,
    odeljenje_id,
    naziv_aktivnosti,
    opis,
    broj_tp,
    kolicina_text,
    planirani_pocetak,
    planirani_zavrsetak,
    odgovoran_user_id,
    odgovoran_radnik_id,
    odgovoran_label,
    zavisi_od_aktivnost_id,
    zavisi_od_text,
    status,
    status_mode,
    manual_override_status,
    blokirano_razlog,
    prioritet,
    rizik_napomena,
    izvor,
    izvor_akcioni_plan_id,
    izvor_pozicija_id,
    izvor_tp_operacija_id,
    zatvoren_at,
    zatvoren_by,
    zatvoren_napomena,
    legacy_id,
    created_at,
    updated_at,
    created_by,
    updated_by,
    datum_isporuke,
    rn_broj,
    radni_nalog_naziv,
    odeljenje_kod,
    odeljenje_naziv,
    linked_count,
    planirano_komada,
    prijavljeno_komada,
    auto_status,
        CASE
            WHEN (manual_override_status = 'blokirano'::production.aktivnost_status) THEN 'blokirano'::production.aktivnost_status
            WHEN (status_mode = ANY (ARRAY['auto_from_pozicija'::production.aktivnost_status_mode, 'auto_from_operacije'::production.aktivnost_status_mode])) THEN auto_status
            ELSE status
        END AS efektivni_status,
    (status_mode = ANY (ARRAY['auto_from_pozicija'::production.aktivnost_status_mode, 'auto_from_operacije'::production.aktivnost_status_mode])) AS status_is_auto,
        CASE
            WHEN ((datum_isporuke IS NOT NULL) AND (planirani_zavrsetak IS NOT NULL)) THEN (datum_isporuke - planirani_zavrsetak)
            ELSE NULL::integer
        END AS rezerva_dani,
        CASE
            WHEN (planirani_zavrsetak IS NULL) THEN false
            ELSE ((CURRENT_DATE > planirani_zavrsetak) AND (
            CASE
                WHEN (manual_override_status = 'blokirano'::production.aktivnost_status) THEN 'blokirano'::production.aktivnost_status
                WHEN (status_mode = ANY (ARRAY['auto_from_pozicija'::production.aktivnost_status_mode, 'auto_from_operacije'::production.aktivnost_status_mode])) THEN auto_status
                ELSE status
            END <> 'zavrseno'::production.aktivnost_status))
        END AS kasni,
    odeljenje_naziv AS dashboard_odeljenje,
        CASE
            WHEN (status_mode = ANY (ARRAY['auto_from_pozicija'::production.aktivnost_status_mode, 'auto_from_operacije'::production.aktivnost_status_mode])) THEN format('prijavljeno %s/%s'::text, prijavljeno_komada, planirano_komada)
            ELSE NULL::text
        END AS status_detail
   FROM effective e;

-- ============ VIEW production.v_pozicija_progress ============
CREATE OR REPLACE VIEW production.v_pozicija_progress AS
SELECT rnp.id AS radni_nalog_pozicija_id,
    tp.id AS tp_operacija_id,
    rnp.radni_nalog_id,
    rnp.kolicina_plan AS planirano_komada,
    (COALESCE(sum(pr.kolicina), (0)::numeric))::numeric(12,3) AS prijavljeno_komada,
    (count(pr.id))::integer AS broj_prijava,
    max(pr.finished_at) AS poslednja_prijava_at,
        CASE
            WHEN (tp.status_override = 'blokirano'::production.tp_status) THEN 'blokirano'::production.aktivnost_status
            WHEN (COALESCE(sum(pr.kolicina), (0)::numeric) <= (0)::numeric) THEN 'nije_krenulo'::production.aktivnost_status
            WHEN (COALESCE(sum(pr.kolicina), (0)::numeric) < rnp.kolicina_plan) THEN 'u_toku'::production.aktivnost_status
            ELSE 'zavrseno'::production.aktivnost_status
        END AS auto_status,
        CASE
            WHEN (rnp.kolicina_plan > (0)::numeric) THEN (LEAST((100)::numeric, round(((COALESCE(sum(pr.kolicina), (0)::numeric) / rnp.kolicina_plan) * (100)::numeric))))::integer
            ELSE 0
        END AS progress_pct
   FROM ((production.radni_nalog_pozicija rnp
     JOIN production.tp_operacija tp ON ((tp.radni_nalog_pozicija_id = rnp.id)))
     LEFT JOIN production.prijava_rada pr ON ((pr.tp_operacija_id = tp.id)))
  GROUP BY rnp.id, tp.id, rnp.radni_nalog_id, rnp.kolicina_plan, tp.status_override;

-- ============ VIEW public.odeljenje ============
CREATE OR REPLACE VIEW public.odeljenje AS
SELECT id,
    kod,
    naziv,
    vodja_user_id,
    vodja_radnik_id,
    boja,
    sort_order,
    aktivan,
    legacy_department_id,
    created_at,
    updated_at
   FROM core.odeljenje;

-- ============ VIEW public.operativna_aktivnost_blok_istorija ============
CREATE OR REPLACE VIEW public.operativna_aktivnost_blok_istorija AS
SELECT id,
    aktivnost_id,
    old_manual_override_status,
    new_manual_override_status,
    old_blokirano_razlog,
    new_blokirano_razlog,
    napomena,
    changed_by,
    changed_by_email,
    created_at,
    updated_at
   FROM production.operativna_aktivnost_blok_istorija;

-- ============ VIEW public.prijava_rada ============
CREATE OR REPLACE VIEW public.prijava_rada AS
SELECT id,
    radni_nalog_id,
    radni_nalog_pozicija_id,
    tp_operacija_id,
    radnik_id,
    work_center_id,
    operacija_kod,
    kolicina,
    started_at,
    finished_at,
    is_completed,
    napomena,
    legacy_idpostupka,
    created_at,
    updated_at,
    created_by,
    updated_by
   FROM production.prijava_rada;

-- ============ VIEW public.radni_nalog ============
CREATE OR REPLACE VIEW public.radni_nalog AS
SELECT id,
    projekat_id,
    rn_broj,
    naziv,
    kupac_text,
    datum_isporuke,
    rok_izrade,
    status,
    koordinator_user_id,
    koordinator_radnik_id,
    napomena,
    legacy_idrn,
    legacy_idpredmet,
    legacy_idcrtez,
    created_at,
    updated_at,
    created_by,
    updated_by
   FROM production.radni_nalog;

-- ============ VIEW public.radnik ============
CREATE OR REPLACE VIEW public.radnik AS
SELECT id,
    employee_id,
    odeljenje_id,
    sifra_radnika,
    ime,
    puno_ime,
    email,
    kartica_id,
    aktivan,
    legacy_sifra_radnika,
    created_at,
    updated_at
   FROM core.radnik;

-- ============ VIEW public.v_active_bigtehn_work_orders ============
CREATE OR REPLACE VIEW public.v_active_bigtehn_work_orders AS
SELECT id,
    item_id,
    customer_id,
    ident_broj,
    varijanta,
    broj_crteza,
    naziv_dela,
    materijal,
    dimenzija_materijala,
    jedinica_mere,
    komada,
    tezina_neobr,
    tezina_obr,
    status_rn,
    zakljucano,
    revizija,
    quality_type_id,
    handover_status_id,
    napomena,
    rok_izrade,
    datum_unosa,
    created_at,
    modified_at,
    author_worker_id,
    synced_at,
    is_mes_active,
    mes_active_reason,
    mes_active_source,
    mes_active_updated_at,
    mes_active_updated_by
   FROM v_bigtehn_work_orders_with_mes_active
  WHERE (is_mes_active IS TRUE);

-- ============ VIEW public.v_akcioni_plan ============
CREATE OR REPLACE VIEW public.v_akcioni_plan AS
SELECT id,
    sastanak_id,
    tema_id,
    projekat_id,
    rb,
    naslov,
    opis,
    odgovoran_email,
    odgovoran_label,
    odgovoran_text,
    rok,
    rok_text,
    status,
    prioritet,
    zatvoren_at,
    zatvoren_by_email,
    zatvoren_napomena,
    created_at,
    created_by_email,
    updated_at,
        CASE
            WHEN (status = ANY (ARRAY['zavrsen'::text, 'odlozen'::text, 'otkazan'::text])) THEN status
            WHEN ((rok IS NOT NULL) AND (rok < CURRENT_DATE) AND (status = ANY (ARRAY['otvoren'::text, 'u_toku'::text]))) THEN 'kasni'::text
            ELSE status
        END AS effective_status,
        CASE
            WHEN (rok IS NULL) THEN NULL::integer
            ELSE (rok - CURRENT_DATE)
        END AS dana_do_roka
   FROM akcioni_plan ap;

-- ============ VIEW public.v_operativna_aktivnost ============
CREATE OR REPLACE VIEW public.v_operativna_aktivnost AS
SELECT id,
    radni_nalog_id,
    projekat_id,
    rb,
    odeljenje_id,
    naziv_aktivnosti,
    opis,
    broj_tp,
    kolicina_text,
    planirani_pocetak,
    planirani_zavrsetak,
    odgovoran_user_id,
    odgovoran_radnik_id,
    odgovoran_label,
    zavisi_od_aktivnost_id,
    zavisi_od_text,
    status,
    status_mode,
    manual_override_status,
    blokirano_razlog,
    prioritet,
    rizik_napomena,
    izvor,
    izvor_akcioni_plan_id,
    izvor_pozicija_id,
    izvor_tp_operacija_id,
    zatvoren_at,
    zatvoren_by,
    zatvoren_napomena,
    legacy_id,
    created_at,
    updated_at,
    created_by,
    updated_by,
    datum_isporuke,
    rn_broj,
    radni_nalog_naziv,
    odeljenje_kod,
    odeljenje_naziv,
    linked_count,
    planirano_komada,
    prijavljeno_komada,
    auto_status,
    efektivni_status,
    status_is_auto,
    rezerva_dani,
    kasni,
    dashboard_odeljenje,
    status_detail
   FROM production.v_operativna_aktivnost;

-- ============ VIEW public.v_production_operations ============
CREATE OR REPLACE VIEW public.v_production_operations AS
SELECT v.line_id,
    v.work_order_id,
    v.operacija,
    v.opis_rada,
    v.alat_pribor,
    v.original_machine_code,
    v.effective_machine_code,
    v.tpz_min,
    v.tk_min,
    v.prioritet_bigtehn,
    v.rn_ident_broj,
    v.broj_crteza,
    v.naziv_dela,
    v.materijal,
    v.dimenzija_materijala,
    v.komada_total,
    v.rok_izrade,
    v.rn_zavrsen,
    v.rn_zakljucano,
    v.rn_napomena,
    v.item_id,
    v.customer_id,
    v.customer_name,
    v.customer_short,
    v.original_machine_name,
    v.is_non_machining,
    v.overlay_id,
    v.shift_sort_order,
    v.local_status,
    v.shift_note,
    v.assigned_machine_code,
    v.overlay_archived_at,
    v.overlay_archived_reason,
    v.overlay_updated_at,
    v.overlay_updated_by,
    v.overlay_created_at,
    v.overlay_created_by,
    v.komada_done,
    v.real_seconds,
    v.is_done_in_bigtehn,
    v.last_finished_at,
    v.prijava_count,
    v.drawings_count,
    v.has_bigtehn_drawing,
    v.bigtehn_drawing_path,
    v.bigtehn_drawing_size,
    v.is_mes_active,
    v.cam_ready,
    v.cam_ready_at,
    v.cam_ready_by,
    v.rj_group_code,
    v.rj_group_label,
    v.cooperation_status,
    v.cooperation_partner,
    v.cooperation_set_by,
    v.cooperation_set_at,
    v.cooperation_expected_return,
    v.is_cooperation_auto,
    v.is_cooperation_manual,
    v.is_cooperation_effective,
    v.cooperation_source,
    v.is_ready_for_machine,
    v.is_ready_for_processing,
    v.is_ready_manual,
    v.ready_override_at,
    v.ready_override_by,
    v.previous_operation_status,
    v.previous_operation_operacija,
    v.previous_operation_machine_code,
    v.is_urgent,
    v.urgency_reason,
    v.auto_sort_bucket,
    COALESCE(g4.is_rework, false) AS is_rework,
    COALESCE(g4.is_scrap, false) AS is_scrap,
    COALESCE(g4.rework_pieces, (0)::numeric) AS rework_pieces,
    COALESCE(g4.scrap_pieces, (0)::numeric) AS scrap_pieces,
    COALESCE(g4.rework_scrap_count, (0)::bigint) AS rework_scrap_count,
    ((v.komada_total IS NOT NULL) AND (v.komada_total > 0) AND (COALESCE(fc.final_control_raw_sum, (0)::numeric) >= (v.komada_total)::numeric) AND (COALESCE(fc.final_control_raw_sum, (0)::numeric) <= ((v.komada_total)::numeric * 1.5))) AS plan_rn_final_control_done
   FROM ((v_production_operations_pre_g4 v
     LEFT JOIN LATERAL ( SELECT bool_or((c.quality_type_id = 1)) AS is_rework,
            bool_or((c.quality_type_id = 2)) AS is_scrap,
            COALESCE(sum(c.pieces) FILTER (WHERE (c.quality_type_id = 1)), (0)::numeric) AS rework_pieces,
            COALESCE(sum(c.pieces) FILTER (WHERE (c.quality_type_id = 2)), (0)::numeric) AS scrap_pieces,
            count(*) AS rework_scrap_count
           FROM bigtehn_rework_scrap_cache c
          WHERE ((c.work_order_id = v.work_order_id) AND (c.operacija = v.operacija))) g4 ON (true))
     LEFT JOIN LATERAL ( SELECT COALESCE(( SELECT (sum(t.komada))::numeric AS sum
                   FROM ((bigtehn_work_order_lines_cache l
                     JOIN bigtehn_machines_cache m ON ((m.rj_code = l.machine_code)))
                     JOIN bigtehn_tech_routing_cache t ON (((t.work_order_id = l.work_order_id) AND (t.operacija = l.operacija) AND (NOT (t.machine_code IS DISTINCT FROM l.machine_code)) AND (t.is_completed IS TRUE))))
                  WHERE ((l.work_order_id = v.work_order_id) AND production._pracenje_line_is_final_control(l.machine_code, m.name, COALESCE(m.no_procedure, false)))), (0)::numeric) AS final_control_raw_sum) fc ON (true));

-- ============ VIEW public.v_production_operations_effective ============
CREATE OR REPLACE VIEW public.v_production_operations_effective AS
SELECT line_id,
    work_order_id,
    operacija,
    opis_rada,
    alat_pribor,
    original_machine_code,
    effective_machine_code,
    tpz_min,
    tk_min,
    prioritet_bigtehn,
    rn_ident_broj,
    broj_crteza,
    naziv_dela,
    materijal,
    dimenzija_materijala,
    komada_total,
    rok_izrade,
    rn_zavrsen,
    rn_zakljucano,
    rn_napomena,
    item_id,
    customer_id,
    customer_name,
    customer_short,
    original_machine_name,
    is_non_machining,
    overlay_id,
    shift_sort_order,
    local_status,
    shift_note,
    assigned_machine_code,
    overlay_archived_at,
    overlay_archived_reason,
    overlay_updated_at,
    overlay_updated_by,
    overlay_created_at,
    overlay_created_by,
    komada_done,
    real_seconds,
    is_done_in_bigtehn,
    last_finished_at,
    prijava_count,
    drawings_count,
    has_bigtehn_drawing,
    bigtehn_drawing_path,
    bigtehn_drawing_size,
    is_mes_active,
    cam_ready,
    cam_ready_at,
    cam_ready_by,
    rj_group_code,
    rj_group_label,
    cooperation_status,
    cooperation_partner,
    cooperation_set_by,
    cooperation_set_at,
    cooperation_expected_return,
    is_cooperation_auto,
    is_cooperation_manual,
    is_cooperation_effective,
    cooperation_source,
    is_ready_for_machine,
    is_ready_for_processing,
    is_ready_manual,
    ready_override_at,
    ready_override_by,
    previous_operation_status,
    previous_operation_operacija,
    previous_operation_machine_code,
    is_urgent,
    urgency_reason,
    auto_sort_bucket,
    is_rework,
    is_scrap,
    rework_pieces,
    scrap_pieces,
    rework_scrap_count,
    plan_rn_final_control_done
   FROM v_production_operations ops
  WHERE ((EXISTS ( SELECT 1
           FROM production.predmet_aktivacija pa
          WHERE ((pa.predmet_item_id = ops.item_id) AND (pa.je_aktivan IS TRUE)))) AND (COALESCE(plan_rn_final_control_done, false) IS NOT TRUE));

-- ============ VIEW public.v_production_operations_pre_g4 ============
CREATE OR REPLACE VIEW public.v_production_operations_pre_g4 AS
SELECT l.id AS line_id,
    l.work_order_id,
    l.operacija,
    l.opis_rada,
    l.alat_pribor,
    l.machine_code AS original_machine_code,
    COALESCE(o.assigned_machine_code, l.machine_code) AS effective_machine_code,
    l.tpz AS tpz_min,
    l.tk AS tk_min,
    l.prioritet AS prioritet_bigtehn,
    wo.ident_broj AS rn_ident_broj,
    wo.broj_crteza,
    wo.naziv_dela,
    wo.materijal,
    wo.dimenzija_materijala,
    wo.komada AS komada_total,
    wo.rok_izrade,
    wo.status_rn AS rn_zavrsen,
    wo.zakljucano AS rn_zakljucano,
    wo.napomena AS rn_napomena,
    (wo.item_id)::integer AS item_id,
    c.id AS customer_id,
    c.name AS customer_name,
    c.short_name AS customer_short,
    m.name AS original_machine_name,
    COALESCE(m.no_procedure, false) AS is_non_machining,
    o.id AS overlay_id,
    o.shift_sort_order,
    o.local_status,
    o.shift_note,
    o.assigned_machine_code,
    o.archived_at AS overlay_archived_at,
    o.archived_reason AS overlay_archived_reason,
    o.updated_at AS overlay_updated_at,
    o.updated_by AS overlay_updated_by,
    o.created_at AS overlay_created_at,
    o.created_by AS overlay_created_by,
    COALESCE(tr.komada_done, (0)::bigint) AS komada_done,
    COALESCE(tr.real_seconds, (0)::bigint) AS real_seconds,
    COALESCE(tr.is_done, false) AS is_done_in_bigtehn,
    tr.last_finished_at,
    tr.prijava_count,
    COALESCE(d.drawings_count, (0)::bigint) AS drawings_count,
    (bd.drawing_no IS NOT NULL) AS has_bigtehn_drawing,
    bd.storage_path AS bigtehn_drawing_path,
    bd.size_bytes AS bigtehn_drawing_size,
    wo.is_mes_active,
    COALESCE(o.cam_ready, false) AS cam_ready,
    o.cam_ready_at,
    o.cam_ready_by,
    m.rj_code AS rj_group_code,
    m.name AS rj_group_label,
    COALESCE(o.cooperation_status, 'none'::text) AS cooperation_status,
    o.cooperation_partner,
    o.cooperation_set_by,
    o.cooperation_set_at,
    o.cooperation_expected_return,
    (g.rj_group_code IS NOT NULL) AS is_cooperation_auto,
    (COALESCE(o.cooperation_status, 'none'::text) <> 'none'::text) AS is_cooperation_manual,
    ((g.rj_group_code IS NOT NULL) OR (COALESCE(o.cooperation_status, 'none'::text) <> 'none'::text)) AS is_cooperation_effective,
        CASE
            WHEN ((g.rj_group_code IS NOT NULL) AND (COALESCE(o.cooperation_status, 'none'::text) <> 'none'::text)) THEN 'auto+manual'::text
            WHEN (g.rj_group_code IS NOT NULL) THEN 'auto'::text
            WHEN (COALESCE(o.cooperation_status, 'none'::text) <> 'none'::text) THEN 'manual'::text
            ELSE 'none'::text
        END AS cooperation_source,
    _eff.eff_ready AS is_ready_for_machine,
    _eff.eff_ready AS is_ready_for_processing,
    COALESCE(o.ready_override, false) AS is_ready_manual,
    o.ready_override_at,
    o.ready_override_by,
        CASE
            WHEN (prev_any.operacija IS NULL) THEN 'none'::text
            WHEN (prev_blk.operacija IS NULL) THEN 'completed'::text
            WHEN (COALESCE(prev_blk.komada_done, (0)::bigint) > 0) THEN 'in_progress'::text
            ELSE 'not_started'::text
        END AS previous_operation_status,
    COALESCE(prev_blk.operacija, prev_any.operacija) AS previous_operation_operacija,
    COALESCE(prev_blk.machine_code, prev_any.machine_code) AS previous_operation_machine_code,
    (u.work_order_id IS NOT NULL) AS is_urgent,
    u.reason AS urgency_reason,
        CASE
            WHEN (COALESCE(o.local_status, 'waiting'::text) = 'blocked'::text) THEN 7
            WHEN ((u.work_order_id IS NOT NULL) AND _eff.eff_ready AND (COALESCE(o.local_status, 'waiting'::text) = 'in_progress'::text)) THEN 1
            WHEN ((u.work_order_id IS NOT NULL) AND _eff.eff_ready AND (COALESCE(o.local_status, 'waiting'::text) = 'waiting'::text)) THEN 2
            WHEN ((u.work_order_id IS NOT NULL) AND (NOT _eff.eff_ready)) THEN 3
            WHEN ((u.work_order_id IS NULL) AND (COALESCE(o.local_status, 'waiting'::text) = 'in_progress'::text)) THEN 4
            WHEN ((u.work_order_id IS NULL) AND _eff.eff_ready AND (COALESCE(o.local_status, 'waiting'::text) = 'waiting'::text)) THEN 5
            WHEN ((u.work_order_id IS NULL) AND (NOT _eff.eff_ready) AND (COALESCE(o.local_status, 'waiting'::text) = 'waiting'::text)) THEN 6
            ELSE 8
        END AS auto_sort_bucket
   FROM (((((((((((((bigtehn_work_order_lines_cache l
     JOIN v_active_bigtehn_work_orders wo ON (((wo.id = l.work_order_id) AND (wo.is_mes_active IS TRUE))))
     LEFT JOIN bigtehn_customers_cache c ON ((c.id = wo.customer_id)))
     LEFT JOIN bigtehn_machines_cache m ON ((m.rj_code = l.machine_code)))
     LEFT JOIN production_auto_cooperation_groups g ON (((g.rj_group_code = m.rj_code) AND (g.removed_at IS NULL))))
     LEFT JOIN production_overlays o ON (((o.work_order_id = l.work_order_id) AND (o.line_id = l.id))))
     LEFT JOIN production_urgency_overrides u ON (((u.work_order_id = l.work_order_id) AND (u.is_urgent IS TRUE) AND (u.cleared_at IS NULL))))
     LEFT JOIN LATERAL ( SELECT (NOT (EXISTS ( SELECT 1
                   FROM (bigtehn_work_order_lines_cache l2
                     LEFT JOIN bigtehn_machines_cache m2 ON ((m2.rj_code = l2.machine_code)))
                  WHERE ((l2.work_order_id = l.work_order_id) AND (l2.operacija < l.operacija) AND (COALESCE(m2.no_procedure, false) = false) AND (NOT (EXISTS ( SELECT 1
                           FROM bigtehn_tech_routing_cache t
                          WHERE ((t.work_order_id = l2.work_order_id) AND (t.operacija = l2.operacija) AND (t.is_completed IS TRUE))))))))) AS is_ready_rb) _ready_chain ON (true))
     LEFT JOIN LATERAL ( SELECT (COALESCE(o.ready_override, false) OR COALESCE(_ready_chain.is_ready_rb, false)) AS eff_ready) _eff ON (true))
     LEFT JOIN LATERAL ( SELECT sum(t.komada) AS komada_done,
            plan_tech_routing_real_seconds(l.work_order_id, (l.operacija)::numeric) AS real_seconds,
            bool_or(t.is_completed) AS is_done,
            max(t.finished_at) AS last_finished_at,
            count(*) AS prijava_count
           FROM bigtehn_tech_routing_cache t
          WHERE ((t.work_order_id = l.work_order_id) AND (t.operacija = l.operacija))) tr ON (true))
     LEFT JOIN LATERAL ( SELECT count(*) AS drawings_count
           FROM production_drawings pd
          WHERE ((pd.work_order_id = l.work_order_id) AND (pd.line_id = l.id) AND (pd.deleted_at IS NULL))) d ON (true))
     LEFT JOIN LATERAL ( SELECT l2.operacija,
            l2.machine_code
           FROM bigtehn_work_order_lines_cache l2
          WHERE ((l2.work_order_id = l.work_order_id) AND (l2.operacija < l.operacija))
          ORDER BY l2.operacija DESC
         LIMIT 1) prev_any ON (true))
     LEFT JOIN LATERAL ( SELECT l2.operacija,
            l2.machine_code,
            COALESCE(t2.komada_done, (0)::bigint) AS komada_done
           FROM ((bigtehn_work_order_lines_cache l2
             LEFT JOIN bigtehn_machines_cache m2 ON ((m2.rj_code = l2.machine_code)))
             LEFT JOIN LATERAL ( SELECT sum(t.komada) AS komada_done,
                    bool_or(t.is_completed) AS is_done
                   FROM bigtehn_tech_routing_cache t
                  WHERE ((t.work_order_id = l2.work_order_id) AND (t.operacija = l2.operacija))) t2 ON (true))
          WHERE ((l2.work_order_id = l.work_order_id) AND (l2.operacija < l.operacija) AND (COALESCE(m2.no_procedure, false) = false) AND (COALESCE(t2.is_done, false) = false))
          ORDER BY l2.operacija DESC
         LIMIT 1) prev_blk ON (true))
     LEFT JOIN bigtehn_drawings_cache bd ON (((bd.drawing_no = wo.broj_crteza) AND (bd.removed_at IS NULL))));
