-- ============================================================================
-- TALAS B — R0 GRANTS (DRAFT) — Sastanci + AI asistent → rola `servosync2_app`
-- ----------------------------------------------------------------------------
-- Izvor obima:  MODULE_SPEC_sastanci_ai_30.md §0/§1/§2/§6 + authz snapshot
--               (authz-snapshots/talasB-fn-defs-2026-07-12.sql, 62 fn + 2 view-a).
-- Uzor:         talas A (Lokacije) grants + Reversi pilot obrazac.
-- NAMENA:       ovo je NACRT. Glavna sesija ga primenjuje na ŽIVOJ sy15 bazi
--               ISKLJUČIVO kao `supabase_admin` (doktrina §A.6 — sy15 `postgres`
--               NIJE superuser → GRANT kao postgres je tihi no-op uz WARNING),
--               i to TEK posle re-verifikacije snapshot-a na sy15 (R0 korak).
--
-- PREDUSLOV (uspostavljeno u talasu A, ne pravi ga ovaj fajl):
--   * rola `servosync2_app` postoji i JESTE član role `authenticated`
--     (`GRANT authenticated TO servosync2_app`) — inače RLS politike `TO authenticated`
--     ne bi važile za konekciju 2.0 backenda i default-deny bi blokirao SVE.
--   * 2.0 backend se konektuje kao `servosync2_app`, a identitet korisnika stiže
--     kroz GUC most (`request.jwt.claims` sa `sub`+`email`) → RLS presuđuje red
--     (Sy15Service.withUser). GRANT otvara PRIVILEGIJU tabele/fn; RLS ostaje drugi gate.
--
-- DOKTRINA §C: NE dira se RLS/politike, semantika, imena. Ovde su SAMO grants.
-- Idempotentno: GRANT je no-op pri ponavljanju; ceo blok je uslovljen postojanjem role.
-- ============================================================================

do $$
declare
  v_tbl  text;
  v_fn   record;

  -- (1) READ-ONLY front tabele — SELECT (pozadina/DEFINER RPC/trigeri ih pišu):
  --   akcioni_plan_istorija  → piše ga akcioni_plan_trg_istorija (DEFINER)
  --   sastanci_notification_log → OUTBOX; enqueue kroz DEFINER RPC/trigere (§2 obrazac, §7 P10: NE izlagati INSERT)
  --   sast_weekly_movers / sast_weekly_skip → pišu ih DEFINER sast_weekly_* RPC-ovi
  --   sastanci_ai_settings → singleton; upis SAMO kroz set_sastanci_ai_model RPC
  read_tables text[] := array[
    'akcioni_plan_istorija',
    'sastanci_notification_log',
    'sast_weekly_movers',
    'sast_weekly_skip',
    'sastanci_ai_settings'
  ];

  -- (2) WRITE-scope front tabele — SELECT+INSERT+UPDATE+DELETE (RLS kroz GUC presuđuje RED;
  --   grant samo otvara privilegiju tabele). Paritet žive politike §2:
  --   standardni write-scope = has_edit_role() AND (is_sastanak_ucesnik(id) OR mgmt OR organizator-trio).
  --   Ukupno 16 sast tabela = 11 write (ovde) + 5 read (gore).
  write_tables text[] := array[
    'sastanci',
    'sastanak_ucesnici',
    'presek_aktivnosti',
    'presek_slike',
    'sastanak_arhiva',
    'sastanak_odluke',
    'akcioni_plan',
    'pm_teme',
    'sastanci_templates',
    'sastanci_template_ucesnici',
    'sastanci_notification_prefs'
  ];

  -- (3) Funkcije — EXECUTE. Signature se razrešavaju sa žive baze (pg_get_function_identity_arguments)
  --   pa overload-i i default-argumenti ne prave grešku. Kategorije:
  --   * 13 FRONT RPC (zove 2.0 servis kroz GUC)         — sast_weekly_*, sast_zakljucaj_*, sastanci_*, get_sastanci_*, set_sastanci_ai_model, ai_chat_ja
  --   * 22 AI-TOOL RPC (zove /ai/chat petlja kroz GUC)   — ai_chat_*
  --   * predikati u RLS politikama (izvršavaju se u kontekstu POZIVAOCA → treba EXECUTE)
  --     + read-endpoint helperi (sast_dashboard_stats se zove direktno).
  exec_fns text[] := array[
    -- 13 front RPC
    'sast_weekly_status','sast_weekly_pomeri','sast_weekly_odlozi','sast_weekly_vrati',
    'sast_zakljucaj_sastanak','sastanci_send_invites','sastanci_remind_unprepared',
    'sastanci_resend_meeting_locked','sastanci_set_my_rsvp','sastanci_get_or_create_my_prefs',
    'get_sastanci_user_directory','set_sastanci_ai_model','ai_chat_ja',
    -- 22 ai-tool RPC
    'ai_chat_can_view_employee','ai_chat_dodaj_belesku','ai_chat_dodaj_uputstvo',
    'ai_chat_employee_lookup','ai_chat_go_pregled','ai_chat_go_saldo','ai_chat_go_zahtevi',
    'ai_chat_inzenjering','ai_chat_kvar_istorija','ai_chat_maint_resolve','ai_chat_masina_info',
    'ai_chat_masina_uputstvo','ai_chat_moj_tim','ai_chat_norm_name','ai_chat_odsustva',
    'ai_chat_opis_pozicije','ai_chat_pretrazi_uputstva','ai_chat_pretrazi_znanje',
    'ai_chat_prijavi_kvar','ai_chat_projekat_info','ai_chat_sati','ai_chat_sql',
    -- RLS predikati + read-endpoint helperi
    'is_sastanak_ucesnik','has_edit_role','current_user_is_management',
    'current_user_is_hr_or_admin','sast_user_can_move_weekly','sast_dashboard_stats'
  ];
begin
  if not exists (select 1 from pg_roles where rolname = 'servosync2_app') then
    raise notice 'rola servosync2_app ne postoji — grants preskočeni (uspostaviti pre R0)';
    return;
  end if;

  -- (1) read-only tabele
  foreach v_tbl in array read_tables loop
    execute format('grant select on public.%I to servosync2_app', v_tbl);
  end loop;

  -- (2) write-scope tabele
  foreach v_tbl in array write_tables loop
    execute format('grant select, insert, update, delete on public.%I to servosync2_app', v_tbl);
  end loop;

  -- (3) view-ovi — v_akcioni_plan i v_pm_teme_pregled su security_invoker → osnovne
  --   tabele (akcioni_plan, pm_teme) su već gore pokrivene; SELECT na view je dovoljan.
  execute 'grant select on public.v_akcioni_plan to servosync2_app';
  execute 'grant select on public.v_pm_teme_pregled to servosync2_app';

  -- (4) AI chat istorija:
  --   * SELECT — RLS: svoje (auth.uid()) + project-scope svima (§2)
  --   * DELETE — RLS: brisanje SAMO svoje lične niti (deleteAiConversation paritet)
  execute 'grant select, delete on public.ai_chat_conversations to servosync2_app';
  execute 'grant select on public.ai_chat_messages to servosync2_app';
  --   * INSERT/UPDATE (upis istorije) = R2. Živa RLS: INSERT/UPDATE „NIKO" (samo service role).
  --     U 1.0 edge `ai-chat` piše service_role-om. U 2.0 (§7 P1) chat servis piše
  --     „BE rolom = ekvivalent service role". Grant je OTVOREN (spec §6), ali BEZ RLS
  --     INSERT/UPDATE politike (koju doktrina §C zabranjuje da menjamo tokom seobe) neće
  --     imati efekta dok R2 ne odluči mehanizam upisa (service-role-ekvivalent konekcija
  --     ILI novi SECURITY DEFINER RPC). Ostavljeno aktivno da nacrt bude talas-kompletan.
  execute 'grant insert, update on public.ai_chat_conversations to servosync2_app';
  execute 'grant insert, update on public.ai_chat_messages to servosync2_app';

  -- (5) funkcije — EXECUTE po živoj signaturi
  for v_fn in
    select 'public.' || quote_ident(p.proname) || '(' ||
           pg_get_function_identity_arguments(p.oid) || ')' as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = any(exec_fns)
  loop
    execute format('grant execute on function %s to servosync2_app', v_fn.sig);
  end loop;
end $$;

-- ============================================================================
-- STORAGE (napomena, NE grant): bucketi `sastanci-arhiva`, `sastanak-slike`,
-- `ai-chat-images` — 2.0 im pristupa kroz storage-api presigned URL-ovima sa
-- SY15_SERVICE_KEY (Reversi obrazac), NE kao servosync2_app; RLS na storage.objects
-- ostaje netaknut (§2). Zato ovde nema grant-a na storage.
--
-- NE seli se (grant SAMO service_role, izmereno §0) — NE dodavati servosync2_app:
--   sastanci_dispatch_dequeue/mark_sent/mark_failed, sastanci_enqueue_*,
--   sast_auto_create_weekly, sast_create_weekly_at, sast_enqueue_cancel,
--   sastanci_pulse_notify_dispatch  (pozadina: pg_cron / edge dispatch).
-- ============================================================================

notify pgrst, 'reload schema';
