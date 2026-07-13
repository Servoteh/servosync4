-- AUTHZ POLICY SNAPSHOT: TALAS G — Kadrovska (HR) — RLS politike — snimljeno 2026-07-13
-- Izvor: zamrznuti cloud (restore-izvor sy15) kroz Management API (pg_policies, READ-ONLY).
-- Re-verifikovati na zivoj sy15 pre R1 (doktrina A5). Prati fn-defs snapshot istog talasa.
-- Obuhvat: 141 RLS politika na 49 G-tabela (public) + 4 storage politike (bucket employee-docs).
-- NAPOMENA: departments/sub_departments/job_positions/company_profile/competence_* su Talas D vlasnistvo — NISU ovde.
-- NAPOMENA: kadr_grid_editor_allowlist / kadr_vacation_editor_allowlist su DB allowliste iza
--   can_edit_kadrovska_grid() / can_edit_vacation_balance(); grid allowlist ekran je Talas D (Podesavanja),
--   ali politike KONZUMIRA Kadrovska grid → ovde ukljucene radi paritet-mape.
-- RLS OFF: kadr_vacation_editor_allowlist (relrowsecurity=false; cista lookup tabela, bez politika).

-- ============================================================
-- TABELA: absences  (4 politika)
-- ============================================================
CREATE POLICY absences_delete ON public.absences
  AS PERMISSIVE FOR DELETE TO authenticated
  USING ((current_user_is_admin() OR current_user_is_hr() OR (has_edit_role() AND current_user_manages_employee(employee_id))));

CREATE POLICY absences_insert ON public.absences
  AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (((current_user_is_admin() OR current_user_is_hr() OR (has_edit_role() AND current_user_manages_employee(employee_id))) AND ((type IS DISTINCT FROM 'neplaceno'::text) OR current_user_is_admin())));

CREATE POLICY absences_select ON public.absences
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((current_user_manages_employee(employee_id) OR (employee_id IN ( SELECT e.id
   FROM employees e
  WHERE ((lower(COALESCE(e.email, ''::text)) = lower(COALESCE((auth.jwt() ->> 'email'::text), ''::text))) AND (COALESCE(e.email, ''::text) <> ''::text))))));

CREATE POLICY absences_update ON public.absences
  AS PERMISSIVE FOR UPDATE TO public
  USING ((current_user_is_admin() OR current_user_is_hr() OR (has_edit_role() AND current_user_manages_employee(employee_id))))
  WITH CHECK (((current_user_is_admin() OR current_user_is_hr() OR (has_edit_role() AND current_user_manages_employee(employee_id))) AND ((type IS DISTINCT FROM 'neplaceno'::text) OR current_user_is_admin())));

-- ============================================================
-- TABELA: assessment_answers  (2 politika)
-- ============================================================
CREATE POLICY aa_write ON public.assessment_answers
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((EXISTS ( SELECT 1
   FROM (assessment_raters r
     JOIN assessments a ON ((a.id = r.assessment_id)))
  WHERE ((r.id = assessment_answers.rater_id) AND ((lower(r.rater_email) = lower((auth.jwt() ->> 'email'::text))) OR (r.rater_employee_id = current_user_employee_id())) AND (a.status = 'collecting'::text)))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM (assessment_raters r
     JOIN assessments a ON ((a.id = r.assessment_id)))
  WHERE ((r.id = assessment_answers.rater_id) AND ((lower(r.rater_email) = lower((auth.jwt() ->> 'email'::text))) OR (r.rater_employee_id = current_user_employee_id())) AND (a.status = 'collecting'::text)))));

CREATE POLICY aa_select ON public.assessment_answers
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((EXISTS ( SELECT 1
   FROM (assessment_raters r
     JOIN assessments a ON ((a.id = r.assessment_id)))
  WHERE ((r.id = assessment_answers.rater_id) AND ((lower(r.rater_email) = lower((auth.jwt() ->> 'email'::text))) OR (r.rater_employee_id = current_user_employee_id()) OR (current_user_is_admin() AND (a.employee_id IS DISTINCT FROM current_user_employee_id())))))));

-- ============================================================
-- TABELA: assessment_cycles  (2 politika)
-- ============================================================
CREATE POLICY ac_write ON public.assessment_cycles
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((current_user_can_manage_org_profile() OR current_user_is_admin()))
  WITH CHECK ((current_user_can_manage_org_profile() OR current_user_is_admin()));

CREATE POLICY ac_select ON public.assessment_cycles
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((current_user_can_manage_org_profile() OR current_user_is_admin()));

-- ============================================================
-- TABELA: assessment_raters  (2 politika)
-- ============================================================
CREATE POLICY ar_write ON public.assessment_raters
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((EXISTS ( SELECT 1
   FROM assessments a
  WHERE ((a.id = assessment_raters.assessment_id) AND current_user_can_manage_assessment(a.employee_id)))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM assessments a
  WHERE ((a.id = assessment_raters.assessment_id) AND current_user_can_manage_assessment(a.employee_id)))));

CREATE POLICY ar_select ON public.assessment_raters
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (((lower(rater_email) = lower((auth.jwt() ->> 'email'::text))) OR (rater_employee_id = current_user_employee_id()) OR (EXISTS ( SELECT 1
   FROM assessments a
  WHERE ((a.id = assessment_raters.assessment_id) AND current_user_can_manage_assessment(a.employee_id))))));

-- ============================================================
-- TABELA: assessment_results  (2 politika)
-- ============================================================
CREATE POLICY ares_write ON public.assessment_results
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((EXISTS ( SELECT 1
   FROM assessments a
  WHERE ((a.id = assessment_results.assessment_id) AND current_user_can_manage_assessment(a.employee_id)))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM assessments a
  WHERE ((a.id = assessment_results.assessment_id) AND current_user_can_manage_assessment(a.employee_id)))));

CREATE POLICY ares_select ON public.assessment_results
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((EXISTS ( SELECT 1
   FROM assessments a
  WHERE ((a.id = assessment_results.assessment_id) AND (current_user_can_manage_assessment(a.employee_id) OR ((a.employee_id = current_user_employee_id()) AND a.visible_to_employee))))));

-- ============================================================
-- TABELA: assessment_scores  (2 politika)
-- ============================================================
CREATE POLICY asc_write ON public.assessment_scores
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((EXISTS ( SELECT 1
   FROM (assessment_raters r
     JOIN assessments a ON ((a.id = r.assessment_id)))
  WHERE ((r.id = assessment_scores.rater_id) AND ((lower(r.rater_email) = lower((auth.jwt() ->> 'email'::text))) OR (r.rater_employee_id = current_user_employee_id())) AND (a.status = 'collecting'::text)))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM (assessment_raters r
     JOIN assessments a ON ((a.id = r.assessment_id)))
  WHERE ((r.id = assessment_scores.rater_id) AND ((lower(r.rater_email) = lower((auth.jwt() ->> 'email'::text))) OR (r.rater_employee_id = current_user_employee_id())) AND (a.status = 'collecting'::text)))));

CREATE POLICY asc_select ON public.assessment_scores
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((EXISTS ( SELECT 1
   FROM (assessment_raters r
     JOIN assessments a ON ((a.id = r.assessment_id)))
  WHERE ((r.id = assessment_scores.rater_id) AND ((lower(r.rater_email) = lower((auth.jwt() ->> 'email'::text))) OR (r.rater_employee_id = current_user_employee_id()) OR (current_user_is_admin() AND (a.employee_id IS DISTINCT FROM current_user_employee_id())))))));

-- ============================================================
-- TABELA: assessment_targets  (2 politika)
-- ============================================================
CREATE POLICY at_write ON public.assessment_targets
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((EXISTS ( SELECT 1
   FROM assessments a
  WHERE ((a.id = assessment_targets.assessment_id) AND current_user_can_manage_assessment(a.employee_id)))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM assessments a
  WHERE ((a.id = assessment_targets.assessment_id) AND current_user_can_manage_assessment(a.employee_id)))));

CREATE POLICY at_select ON public.assessment_targets
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((EXISTS ( SELECT 1
   FROM assessments a
  WHERE ((a.id = assessment_targets.assessment_id) AND (current_user_can_manage_assessment(a.employee_id) OR ((a.employee_id = current_user_employee_id()) AND a.visible_to_employee))))));

-- ============================================================
-- TABELA: assessments  (4 politika)
-- ============================================================
CREATE POLICY as_delete ON public.assessments
  AS PERMISSIVE FOR DELETE TO authenticated
  USING (current_user_is_admin());

CREATE POLICY as_insert ON public.assessments
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((current_user_can_manage_assessment(employee_id) AND (lower(opened_by) = lower((auth.jwt() ->> 'email'::text)))));

CREATE POLICY as_select ON public.assessments
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (((employee_id = current_user_employee_id()) OR current_user_manages_dev_plan(employee_id)));

CREATE POLICY as_update_mgr ON public.assessments
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING (current_user_can_manage_assessment(employee_id))
  WITH CHECK (current_user_can_manage_assessment(employee_id));

-- ============================================================
-- TABELA: attendance_corrections  (1 politika)
-- ============================================================
CREATE POLICY attendance_corrections_read ON public.attendance_corrections
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (((employee_id IN ( SELECT e.id
   FROM employees e
  WHERE ((lower(COALESCE(e.email, ''::text)) = lower(COALESCE((auth.jwt() ->> 'email'::text), ''::text))) AND (COALESCE(e.email, ''::text) <> ''::text)))) OR current_user_manages_employee(employee_id) OR current_user_is_hr_or_admin()));

-- ============================================================
-- TABELA: attendance_events  (2 politika)
-- ============================================================
CREATE POLICY attendance_events_read ON public.attendance_events
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((current_user_is_hr_or_admin() OR can_edit_kadrovska_grid()));

CREATE POLICY attendance_events_read_own ON public.attendance_events
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (((employee_id IN ( SELECT e.id
   FROM employees e
  WHERE ((lower(COALESCE(e.email, ''::text)) = lower(COALESCE((auth.jwt() ->> 'email'::text), ''::text))) AND (COALESCE(e.email, ''::text) <> ''::text)))) OR current_user_manages_employee(employee_id)));

-- ============================================================
-- TABELA: attendance_notify_extra  (1 politika)
-- ============================================================
CREATE POLICY attendance_notify_extra_read ON public.attendance_notify_extra
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (current_user_is_hr_or_admin());

-- ============================================================
-- TABELA: contracts  (4 politika)
-- ============================================================
CREATE POLICY contracts_delete ON public.contracts
  AS PERMISSIVE FOR DELETE TO authenticated
  USING ((current_user_is_admin() OR current_user_is_hr() OR (has_edit_role() AND current_user_manages_employee(employee_id))));

CREATE POLICY contracts_insert ON public.contracts
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((current_user_is_admin() OR current_user_is_hr() OR (has_edit_role() AND current_user_manages_employee(employee_id))));

CREATE POLICY contracts_select ON public.contracts
  AS PERMISSIVE FOR SELECT TO public
  USING ((current_user_manages_employee(employee_id) OR (employee_id IN ( SELECT e.id
   FROM employees e
  WHERE ((lower(COALESCE(e.email, ''::text)) = lower(COALESCE((auth.jwt() ->> 'email'::text), ''::text))) AND (COALESCE(e.email, ''::text) <> ''::text))))));

CREATE POLICY contracts_update ON public.contracts
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((current_user_is_admin() OR current_user_is_hr() OR (has_edit_role() AND current_user_manages_employee(employee_id))))
  WITH CHECK ((current_user_is_admin() OR current_user_is_hr() OR (has_edit_role() AND current_user_manages_employee(employee_id))));

-- ============================================================
-- TABELA: corrective_measures  (2 politika)
-- ============================================================
CREATE POLICY cmeas_write ON public.corrective_measures
  AS PERMISSIVE FOR ALL TO public
  USING ((EXISTS ( SELECT 1
   FROM corrective_plans p
  WHERE ((p.id = corrective_measures.plan_id) AND current_user_can_manage_talk(p.employee_id)))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM corrective_plans p
  WHERE ((p.id = corrective_measures.plan_id) AND current_user_can_manage_talk(p.employee_id)))));

CREATE POLICY cmeas_select ON public.corrective_measures
  AS PERMISSIVE FOR SELECT TO public
  USING ((EXISTS ( SELECT 1
   FROM corrective_plans p
  WHERE ((p.id = corrective_measures.plan_id) AND (((p.employee_id = current_user_employee_id()) AND p.visible_to_employee) OR current_user_can_manage_talk(p.employee_id))))));

-- ============================================================
-- TABELA: corrective_plans  (4 politika)
-- ============================================================
CREATE POLICY cplans_delete ON public.corrective_plans
  AS PERMISSIVE FOR DELETE TO public
  USING (current_user_is_admin());

CREATE POLICY cplans_write ON public.corrective_plans
  AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (current_user_can_manage_talk(employee_id));

CREATE POLICY cplans_select ON public.corrective_plans
  AS PERMISSIVE FOR SELECT TO public
  USING ((((employee_id = current_user_employee_id()) AND visible_to_employee) OR current_user_can_manage_talk(employee_id)));

CREATE POLICY cplans_update ON public.corrective_plans
  AS PERMISSIVE FOR UPDATE TO public
  USING (current_user_can_manage_talk(employee_id));

-- ============================================================
-- TABELA: development_checkins  (4 politika)
-- ============================================================
CREATE POLICY dc_delete ON public.development_checkins
  AS PERMISSIVE FOR DELETE TO authenticated
  USING (((lower(author_email) = lower((auth.jwt() ->> 'email'::text))) OR current_user_manages_dev_plan(employee_id)));

CREATE POLICY dc_insert ON public.development_checkins
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (((lower(author_email) = lower((auth.jwt() ->> 'email'::text))) AND (((author_kind = 'upravljac'::text) AND current_user_manages_dev_plan(employee_id)) OR ((author_kind = 'zaposleni'::text) AND (employee_id IN ( SELECT employees.id
   FROM employees
  WHERE (lower(employees.email) = lower((auth.jwt() ->> 'email'::text)))))))));

CREATE POLICY dc_select ON public.development_checkins
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (((employee_id IN ( SELECT employees.id
   FROM employees
  WHERE (lower(employees.email) = lower((auth.jwt() ->> 'email'::text))))) OR current_user_manages_dev_plan(employee_id)));

CREATE POLICY dc_update ON public.development_checkins
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING (((lower(author_email) = lower((auth.jwt() ->> 'email'::text))) OR current_user_manages_dev_plan(employee_id)))
  WITH CHECK (((lower(author_email) = lower((auth.jwt() ->> 'email'::text))) OR current_user_manages_dev_plan(employee_id)));

-- ============================================================
-- TABELA: development_plans  (5 politika)
-- ============================================================
CREATE POLICY dp_delete ON public.development_plans
  AS PERMISSIVE FOR DELETE TO authenticated
  USING (current_user_is_admin());

CREATE POLICY dp_insert ON public.development_plans
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((current_user_manages_dev_plan(employee_id) AND (lower(created_by) = lower((auth.jwt() ->> 'email'::text)))));

CREATE POLICY dp_select ON public.development_plans
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (((employee_id IN ( SELECT employees.id
   FROM employees
  WHERE (lower(employees.email) = lower((auth.jwt() ->> 'email'::text))))) OR current_user_manages_dev_plan(employee_id)));

CREATE POLICY dp_update_mgr ON public.development_plans
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING (current_user_manages_dev_plan(employee_id))
  WITH CHECK (current_user_manages_dev_plan(employee_id));

CREATE POLICY dp_update_self ON public.development_plans
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((employee_id IN ( SELECT employees.id
   FROM employees
  WHERE (lower(employees.email) = lower((auth.jwt() ->> 'email'::text))))))
  WITH CHECK ((employee_id IN ( SELECT employees.id
   FROM employees
  WHERE (lower(employees.email) = lower((auth.jwt() ->> 'email'::text))))));

-- ============================================================
-- TABELA: device_push_tokens  (4 politika)
-- ============================================================
CREATE POLICY dpt_delete_own ON public.device_push_tokens
  AS PERMISSIVE FOR DELETE TO public
  USING ((user_id = auth.uid()));

CREATE POLICY dpt_insert_own ON public.device_push_tokens
  AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((user_id = auth.uid()));

CREATE POLICY dpt_select_own ON public.device_push_tokens
  AS PERMISSIVE FOR SELECT TO public
  USING ((user_id = auth.uid()));

CREATE POLICY dpt_update_own ON public.device_push_tokens
  AS PERMISSIVE FOR UPDATE TO public
  USING ((user_id = auth.uid()))
  WITH CHECK ((user_id = auth.uid()));

-- ============================================================
-- TABELA: employee_badges  (2 politika)
-- ============================================================
CREATE POLICY employee_badges_write ON public.employee_badges
  AS PERMISSIVE FOR ALL TO authenticated
  USING (current_user_is_hr_or_admin())
  WITH CHECK (current_user_is_hr_or_admin());

CREATE POLICY employee_badges_read ON public.employee_badges
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((current_user_is_hr_or_admin() OR can_edit_kadrovska_grid()));

-- ============================================================
-- TABELA: employee_bank_cards  (1 politika)
-- ============================================================
CREATE POLICY bank_cards_pii_all ON public.employee_bank_cards
  AS PERMISSIVE FOR ALL TO public
  USING (current_user_can_manage_employee_pii())
  WITH CHECK (current_user_can_manage_employee_pii());

-- ============================================================
-- TABELA: employee_children  (4 politika)
-- ============================================================
CREATE POLICY employee_children_delete ON public.employee_children
  AS PERMISSIVE FOR DELETE TO authenticated
  USING (current_user_can_manage_employee_pii());

CREATE POLICY employee_children_insert ON public.employee_children
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (current_user_can_manage_employee_pii());

CREATE POLICY employee_children_select ON public.employee_children
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (current_user_can_manage_employee_pii());

CREATE POLICY employee_children_update ON public.employee_children
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING (current_user_can_manage_employee_pii())
  WITH CHECK (current_user_can_manage_employee_pii());

-- ============================================================
-- TABELA: employee_documents  (4 politika)
-- ============================================================
CREATE POLICY employee_documents_delete ON public.employee_documents
  AS PERMISSIVE FOR DELETE TO authenticated
  USING (current_user_can_manage_employee_pii());

CREATE POLICY employee_documents_insert ON public.employee_documents
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (((uploaded_by = auth.uid()) AND current_user_can_manage_employee_pii()));

CREATE POLICY employee_documents_select ON public.employee_documents
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (current_user_can_manage_employee_pii());

CREATE POLICY employee_documents_update ON public.employee_documents
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING (current_user_can_manage_employee_pii())
  WITH CHECK (current_user_can_manage_employee_pii());

-- ============================================================
-- TABELA: employee_expectations  (5 politika)
-- ============================================================
CREATE POLICY ee_delete ON public.employee_expectations
  AS PERMISSIVE FOR DELETE TO authenticated
  USING (current_user_is_admin());

CREATE POLICY ee_insert ON public.employee_expectations
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((current_user_manages_dev_plan(employee_id) AND (lower(created_by) = lower((auth.jwt() ->> 'email'::text)))));

CREATE POLICY ee_select ON public.employee_expectations
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (((employee_id IN ( SELECT employees.id
   FROM employees
  WHERE (lower(employees.email) = lower((auth.jwt() ->> 'email'::text))))) OR current_user_manages_dev_plan(employee_id)));

CREATE POLICY ee_update_mgr ON public.employee_expectations
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING (current_user_manages_dev_plan(employee_id))
  WITH CHECK (current_user_manages_dev_plan(employee_id));

CREATE POLICY ee_update_self ON public.employee_expectations
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((employee_id IN ( SELECT employees.id
   FROM employees
  WHERE (lower(employees.email) = lower((auth.jwt() ->> 'email'::text))))))
  WITH CHECK (((employee_id IN ( SELECT employees.id
   FROM employees
  WHERE (lower(employees.email) = lower((auth.jwt() ->> 'email'::text))))) AND (status = ANY (ARRAY['u_toku'::text, 'ispunjeno'::text]))));

-- ============================================================
-- TABELA: employee_foreign_docs  (1 politika)
-- ============================================================
CREATE POLICY foreign_docs_pii_all ON public.employee_foreign_docs
  AS PERMISSIVE FOR ALL TO public
  USING (current_user_can_manage_employee_pii())
  WITH CHECK (current_user_can_manage_employee_pii());

-- ============================================================
-- TABELA: employee_personal_docs  (1 politika)
-- ============================================================
CREATE POLICY personal_docs_pii_all ON public.employee_personal_docs
  AS PERMISSIVE FOR ALL TO public
  USING (current_user_can_manage_employee_pii())
  WITH CHECK (current_user_can_manage_employee_pii());

-- ============================================================
-- TABELA: employee_talks  (4 politika)
-- ============================================================
CREATE POLICY talks_delete ON public.employee_talks
  AS PERMISSIVE FOR DELETE TO public
  USING ((current_user_is_admin() OR (current_user_can_manage_talk(employee_id) AND (status = 'nacrt'::text))));

CREATE POLICY talks_insert ON public.employee_talks
  AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (current_user_can_manage_talk(employee_id));

CREATE POLICY talks_select ON public.employee_talks
  AS PERMISSIVE FOR SELECT TO public
  USING ((((employee_id = current_user_employee_id()) AND (status = ANY (ARRAY['podeljen'::text, 'potvrdjen'::text]))) OR current_user_can_manage_talk(employee_id)));

CREATE POLICY talks_update ON public.employee_talks
  AS PERMISSIVE FOR UPDATE TO public
  USING (current_user_can_manage_talk(employee_id));

-- ============================================================
-- TABELA: employees  (4 politika)
-- ============================================================
CREATE POLICY employees_delete ON public.employees
  AS PERMISSIVE FOR DELETE TO authenticated
  USING ((current_user_is_admin() OR current_user_is_hr()));

CREATE POLICY employees_insert ON public.employees
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((current_user_is_admin() OR current_user_is_hr() OR current_user_is_poslovni_admin()));

CREATE POLICY employees_select ON public.employees
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((current_user_manages_employee(id) OR ((lower(COALESCE(email, ''::text)) = lower(COALESCE((auth.jwt() ->> 'email'::text), ''::text))) AND (COALESCE(email, ''::text) <> ''::text))));

CREATE POLICY employees_update ON public.employees
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((current_user_is_admin() OR current_user_is_hr() OR current_user_is_poslovni_admin() OR (has_edit_role() AND current_user_manages_employee(id))))
  WITH CHECK ((current_user_is_admin() OR current_user_is_hr() OR current_user_is_poslovni_admin() OR (has_edit_role() AND current_user_manages_employee(id))));

-- ============================================================
-- TABELA: kadr_audit_log  (1 politika)
-- ============================================================
CREATE POLICY kadr_audit_log_select ON public.kadr_audit_log
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (current_user_is_admin());

-- ============================================================
-- TABELA: kadr_certificates  (4 politika)
-- ============================================================
CREATE POLICY kadr_certificates_delete ON public.kadr_certificates
  AS PERMISSIVE FOR DELETE TO authenticated
  USING ((current_user_is_hr_or_admin() OR current_user_is_poslovni_admin()));

CREATE POLICY kadr_certificates_insert ON public.kadr_certificates
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((current_user_is_hr_or_admin() OR current_user_is_poslovni_admin()));

CREATE POLICY kadr_certificates_select ON public.kadr_certificates
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((current_user_is_hr_or_admin() OR current_user_is_poslovni_admin()));

CREATE POLICY kadr_certificates_update ON public.kadr_certificates
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((current_user_is_hr_or_admin() OR current_user_is_poslovni_admin()))
  WITH CHECK ((current_user_is_hr_or_admin() OR current_user_is_poslovni_admin()));

-- ============================================================
-- TABELA: kadr_document_ack  (2 politika)
-- ============================================================
CREATE POLICY p_doc_ack_insert_own ON public.kadr_document_ack
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((employee_id = rev_current_employee_id()));

CREATE POLICY p_doc_ack_read ON public.kadr_document_ack
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((kadr_can_manage_hr() OR (employee_id = rev_current_employee_id())));

-- ============================================================
-- TABELA: kadr_grid_editor_allowlist  (4 politika)
-- ============================================================
CREATE POLICY kadr_grid_editor_allowlist_delete ON public.kadr_grid_editor_allowlist
  AS PERMISSIVE FOR DELETE TO authenticated
  USING (current_user_is_admin());

CREATE POLICY kadr_grid_editor_allowlist_insert ON public.kadr_grid_editor_allowlist
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (current_user_is_admin());

CREATE POLICY kadr_grid_editor_allowlist_select ON public.kadr_grid_editor_allowlist
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (true);

CREATE POLICY kadr_grid_editor_allowlist_update ON public.kadr_grid_editor_allowlist
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING (current_user_is_admin())
  WITH CHECK (current_user_is_admin());

-- ============================================================
-- TABELA: kadr_holidays  (4 politika)
-- ============================================================
CREATE POLICY kadr_holidays_delete_admin ON public.kadr_holidays
  AS PERMISSIVE FOR DELETE TO authenticated
  USING (current_user_is_admin());

CREATE POLICY kadr_holidays_insert_admin ON public.kadr_holidays
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (current_user_is_admin());

CREATE POLICY kadr_holidays_select ON public.kadr_holidays
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (true);

CREATE POLICY kadr_holidays_update_admin ON public.kadr_holidays
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING (current_user_is_admin())
  WITH CHECK (current_user_is_admin());

-- ============================================================
-- TABELA: kadr_medical_exams  (4 politika)
-- ============================================================
CREATE POLICY kadr_medical_exams_delete ON public.kadr_medical_exams
  AS PERMISSIVE FOR DELETE TO authenticated
  USING ((current_user_is_hr_or_admin() OR current_user_is_poslovni_admin()));

CREATE POLICY kadr_medical_exams_insert ON public.kadr_medical_exams
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((current_user_is_hr_or_admin() OR current_user_is_poslovni_admin()));

CREATE POLICY kadr_medical_exams_select ON public.kadr_medical_exams
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((current_user_is_hr_or_admin() OR current_user_is_poslovni_admin()));

CREATE POLICY kadr_medical_exams_update ON public.kadr_medical_exams
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((current_user_is_hr_or_admin() OR current_user_is_poslovni_admin()))
  WITH CHECK ((current_user_is_hr_or_admin() OR current_user_is_poslovni_admin()));

-- ============================================================
-- TABELA: kadr_notification_config  (2 politika)
-- ============================================================
CREATE POLICY kadr_cfg_select_hr ON public.kadr_notification_config
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (current_user_is_hr_or_admin());

CREATE POLICY kadr_cfg_update_hr ON public.kadr_notification_config
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING (current_user_is_hr_or_admin())
  WITH CHECK (current_user_is_hr_or_admin());

-- ============================================================
-- TABELA: kadr_notification_log  (3 politika)
-- ============================================================
CREATE POLICY kadr_notif_delete_hr ON public.kadr_notification_log
  AS PERMISSIVE FOR DELETE TO authenticated
  USING (current_user_is_hr_or_admin());

CREATE POLICY kadr_notif_select_hr ON public.kadr_notification_log
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (current_user_is_hr_or_admin());

CREATE POLICY kadr_notif_update_hr ON public.kadr_notification_log
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING (current_user_is_hr_or_admin())
  WITH CHECK (current_user_is_hr_or_admin());

-- ============================================================
-- TABELA: kadr_onboarding_runs  (2 politika)
-- ============================================================
CREATE POLICY p_onb_runs_manage ON public.kadr_onboarding_runs
  AS PERMISSIVE FOR ALL TO authenticated
  USING (kadr_can_manage_hr())
  WITH CHECK (kadr_can_manage_hr());

CREATE POLICY p_onb_runs_own_read ON public.kadr_onboarding_runs
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((employee_id = rev_current_employee_id()));

-- ============================================================
-- TABELA: kadr_onboarding_tasks  (2 politika)
-- ============================================================
CREATE POLICY p_onb_tasks_manage ON public.kadr_onboarding_tasks
  AS PERMISSIVE FOR ALL TO authenticated
  USING (kadr_can_manage_hr())
  WITH CHECK (kadr_can_manage_hr());

CREATE POLICY p_onb_tasks_own_read ON public.kadr_onboarding_tasks
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((EXISTS ( SELECT 1
   FROM kadr_onboarding_runs r
  WHERE ((r.id = kadr_onboarding_tasks.run_id) AND (r.employee_id = rev_current_employee_id())))));

-- ============================================================
-- TABELA: kadr_onboarding_template_items  (1 politika)
-- ============================================================
CREATE POLICY p_onb_tmpl_items_all ON public.kadr_onboarding_template_items
  AS PERMISSIVE FOR ALL TO authenticated
  USING (kadr_can_manage_hr())
  WITH CHECK (kadr_can_manage_hr());

-- ============================================================
-- TABELA: kadr_onboarding_templates  (1 politika)
-- ============================================================
CREATE POLICY p_onb_tmpl_all ON public.kadr_onboarding_templates
  AS PERMISSIVE FOR ALL TO authenticated
  USING (kadr_can_manage_hr())
  WITH CHECK (kadr_can_manage_hr());

-- ============================================================
-- TABELA: makeup_requests  (4 politika)
-- ============================================================
CREATE POLICY mu_delete ON public.makeup_requests
  AS PERMISSIVE FOR DELETE TO authenticated
  USING (current_user_is_hr_or_admin());

CREATE POLICY mu_insert ON public.makeup_requests
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((lower(submitted_by) = lower((auth.jwt() ->> 'email'::text))));

CREATE POLICY mu_select ON public.makeup_requests
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (((lower(submitted_by) = lower((auth.jwt() ->> 'email'::text))) OR (employee_id IN ( SELECT employees.id
   FROM employees
  WHERE (lower(employees.email) = lower((auth.jwt() ->> 'email'::text))))) OR current_user_can_manage_vacreq()));

CREATE POLICY mu_update ON public.makeup_requests
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING (current_user_can_manage_vacreq())
  WITH CHECK (current_user_can_manage_vacreq());

-- ============================================================
-- TABELA: nop_requests  (4 politika)
-- ============================================================
CREATE POLICY nopreq_delete ON public.nop_requests
  AS PERMISSIVE FOR DELETE TO public
  USING (current_user_is_admin());

CREATE POLICY nopreq_insert ON public.nop_requests
  AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((has_edit_role() AND current_user_manages_employee(employee_id)));

CREATE POLICY nopreq_select ON public.nop_requests
  AS PERMISSIVE FOR SELECT TO public
  USING ((current_user_manages_employee(employee_id) OR (employee_id IN ( SELECT e.id
   FROM employees e
  WHERE ((lower(COALESCE(e.email, ''::text)) = lower(COALESCE((auth.jwt() ->> 'email'::text), ''::text))) AND (COALESCE(e.email, ''::text) <> ''::text))))));

CREATE POLICY nopreq_update ON public.nop_requests
  AS PERMISSIVE FOR UPDATE TO public
  USING (current_user_is_admin())
  WITH CHECK (current_user_is_admin());

-- ============================================================
-- TABELA: paid_leave_requests  (4 politika)
-- ============================================================
CREATE POLICY pl_delete ON public.paid_leave_requests
  AS PERMISSIVE FOR DELETE TO authenticated
  USING (current_user_is_hr_or_admin());

CREATE POLICY pl_insert ON public.paid_leave_requests
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((lower(submitted_by) = lower((auth.jwt() ->> 'email'::text))));

CREATE POLICY pl_select ON public.paid_leave_requests
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (((lower(submitted_by) = lower((auth.jwt() ->> 'email'::text))) OR (employee_id IN ( SELECT employees.id
   FROM employees
  WHERE (lower(employees.email) = lower((auth.jwt() ->> 'email'::text))))) OR current_user_can_manage_vacreq()));

CREATE POLICY pl_update ON public.paid_leave_requests
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING (current_user_can_manage_vacreq())
  WITH CHECK (current_user_can_manage_vacreq());

-- ============================================================
-- TABELA: salary_payroll  (4 politika)
-- ============================================================
CREATE POLICY salary_payroll_delete_admin ON public.salary_payroll
  AS PERMISSIVE FOR DELETE TO authenticated
  USING (current_user_is_admin());

CREATE POLICY salary_payroll_insert_admin ON public.salary_payroll
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (current_user_is_admin());

CREATE POLICY salary_payroll_select_admin ON public.salary_payroll
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (current_user_is_admin());

CREATE POLICY salary_payroll_update_admin ON public.salary_payroll
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING (current_user_is_admin())
  WITH CHECK (current_user_is_admin());

-- ============================================================
-- TABELA: salary_terms  (4 politika)
-- ============================================================
CREATE POLICY salary_terms_delete_admin ON public.salary_terms
  AS PERMISSIVE FOR DELETE TO authenticated
  USING (current_user_is_admin());

CREATE POLICY salary_terms_insert_admin ON public.salary_terms
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (current_user_is_admin());

CREATE POLICY salary_terms_select_admin ON public.salary_terms
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (current_user_is_admin());

CREATE POLICY salary_terms_update_admin ON public.salary_terms
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING (current_user_is_admin())
  WITH CHECK (current_user_is_admin());

-- ============================================================
-- TABELA: vacation_bonus_days  (1 politika)
-- ============================================================
CREATE POLICY bonus_go_read ON public.vacation_bonus_days
  AS PERMISSIVE FOR SELECT TO public
  USING ((auth.role() = 'authenticated'::text));

-- ============================================================
-- TABELA: vacation_entitlements  (4 politika)
-- ============================================================
CREATE POLICY vac_ent_delete ON public.vacation_entitlements
  AS PERMISSIVE FOR DELETE TO authenticated
  USING (can_edit_vacation_balance());

CREATE POLICY vac_ent_insert ON public.vacation_entitlements
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (can_edit_vacation_balance());

CREATE POLICY vac_ent_select ON public.vacation_entitlements
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((current_user_manages_employee(employee_id) OR (employee_id IN ( SELECT e.id
   FROM employees e
  WHERE ((lower(COALESCE(e.email, ''::text)) = lower(COALESCE((auth.jwt() ->> 'email'::text), ''::text))) AND (COALESCE(e.email, ''::text) <> ''::text))))));

CREATE POLICY vac_ent_update ON public.vacation_entitlements
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING (can_edit_vacation_balance())
  WITH CHECK (can_edit_vacation_balance());

-- ============================================================
-- TABELA: vacation_history  (1 politika)
-- ============================================================
CREATE POLICY vacation_history_select ON public.vacation_history
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((current_user_manages_employee(employee_id) OR (employee_id IN ( SELECT e.id
   FROM employees e
  WHERE ((lower(COALESCE(e.email, ''::text)) = lower(COALESCE((auth.jwt() ->> 'email'::text), ''::text))) AND (COALESCE(e.email, ''::text) <> ''::text))))));

-- ============================================================
-- TABELA: vacation_requests  (4 politika)
-- ============================================================
CREATE POLICY vr_delete ON public.vacation_requests
  AS PERMISSIVE FOR DELETE TO authenticated
  USING (current_user_is_hr_or_admin());

CREATE POLICY vr_insert ON public.vacation_requests
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (((lower(submitted_by) = lower(COALESCE((auth.jwt() ->> 'email'::text), ''::text))) OR current_user_is_admin() OR current_user_is_hr() OR (has_edit_role() AND current_user_manages_employee(employee_id)) OR current_user_is_vacreq_admin()));

CREATE POLICY vr_select ON public.vacation_requests
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (((lower(submitted_by) = lower(COALESCE((auth.jwt() ->> 'email'::text), ''::text))) OR (employee_id IN ( SELECT e.id
   FROM employees e
  WHERE (lower(e.email) = lower(COALESCE((auth.jwt() ->> 'email'::text), ''::text))))) OR current_user_manages_employee(employee_id) OR current_user_is_vacreq_admin()));

CREATE POLICY vr_update ON public.vacation_requests
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING (current_user_manages_employee(employee_id))
  WITH CHECK (current_user_manages_employee(employee_id));

-- ============================================================
-- TABELA: work_hours  (4 politika)
-- ============================================================
CREATE POLICY work_hours_delete ON public.work_hours
  AS PERMISSIVE FOR DELETE TO authenticated
  USING (can_edit_kadrovska_grid());

CREATE POLICY work_hours_insert ON public.work_hours
  AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((can_edit_kadrovska_grid() AND ((absence_code IS DISTINCT FROM 'nop'::text) OR current_user_is_admin())));

CREATE POLICY work_hours_select ON public.work_hours
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((current_user_manages_employee(employee_id) OR (employee_id IN ( SELECT e.id
   FROM employees e
  WHERE ((lower(COALESCE(e.email, ''::text)) = lower(COALESCE((auth.jwt() ->> 'email'::text), ''::text))) AND (COALESCE(e.email, ''::text) <> ''::text))))));

CREATE POLICY work_hours_update ON public.work_hours
  AS PERMISSIVE FOR UPDATE TO public
  USING (can_edit_kadrovska_grid())
  WITH CHECK ((can_edit_kadrovska_grid() AND ((absence_code IS DISTINCT FROM 'nop'::text) OR current_user_is_admin())));

-- ============================================================
-- TABELA: work_hours_remarks  (4 politika)
-- ============================================================
CREATE POLICY whr_delete ON public.work_hours_remarks
  AS PERMISSIVE FOR DELETE TO public
  USING (current_user_is_hr_or_admin());

CREATE POLICY whr_insert ON public.work_hours_remarks
  AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (((employee_id IN ( SELECT e.id
   FROM employees e
  WHERE ((lower(COALESCE(e.email, ''::text)) = lower(COALESCE((auth.jwt() ->> 'email'::text), ''::text))) AND (COALESCE(e.email, ''::text) <> ''::text)))) OR current_user_manages_employee(employee_id)));

CREATE POLICY whr_select ON public.work_hours_remarks
  AS PERMISSIVE FOR SELECT TO public
  USING (((employee_id IN ( SELECT e.id
   FROM employees e
  WHERE ((lower(COALESCE(e.email, ''::text)) = lower(COALESCE((auth.jwt() ->> 'email'::text), ''::text))) AND (COALESCE(e.email, ''::text) <> ''::text)))) OR current_user_manages_employee(employee_id)));

CREATE POLICY whr_update ON public.work_hours_remarks
  AS PERMISSIVE FOR UPDATE TO public
  USING (((employee_id IN ( SELECT e.id
   FROM employees e
  WHERE ((lower(COALESCE(e.email, ''::text)) = lower(COALESCE((auth.jwt() ->> 'email'::text), ''::text))) AND (COALESCE(e.email, ''::text) <> ''::text)))) OR current_user_manages_employee(employee_id)))
  WITH CHECK (((employee_id IN ( SELECT e.id
   FROM employees e
  WHERE ((lower(COALESCE(e.email, ''::text)) = lower(COALESCE((auth.jwt() ->> 'email'::text), ''::text))) AND (COALESCE(e.email, ''::text) <> ''::text)))) OR current_user_manages_employee(employee_id)));

-- ============================================================
-- STORAGE: bucket 'employee-docs' (private) — storage.objects politike
-- Sve 4 op zavise od current_user_can_manage_employee_pii() = admin ∨ poslovni_admin
-- ============================================================
CREATE POLICY empdoc_storage_read ON storage.objects
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((bucket_id = 'employee-docs' AND current_user_can_manage_employee_pii()));

CREATE POLICY empdoc_storage_insert ON storage.objects
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((bucket_id = 'employee-docs' AND current_user_can_manage_employee_pii()));

CREATE POLICY empdoc_storage_update ON storage.objects
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((bucket_id = 'employee-docs' AND current_user_can_manage_employee_pii()))
  WITH CHECK ((bucket_id = 'employee-docs' AND current_user_can_manage_employee_pii()));

CREATE POLICY empdoc_storage_delete ON storage.objects
  AS PERMISSIVE FOR DELETE TO authenticated
  USING ((bucket_id = 'employee-docs' AND current_user_can_manage_employee_pii()));

