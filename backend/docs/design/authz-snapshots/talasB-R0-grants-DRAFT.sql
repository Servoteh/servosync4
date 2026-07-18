-- ============================================================================
-- TALAS B — R0 GRANTS v2 (DRAFT, MINIMALAN) — Sastanci + AI asistent
-- ----------------------------------------------------------------------------
-- ISTORIJA: v1 (12.07) je nabrajao direktne table/fn grantove za `servosync2_app`
-- pod pretpostavkom „RLS presuđuje red kroz GUC". Adversarni review (12.07) je
-- IZMERIO na živoj sy15 da rola `servosync2_app` ima **rolbypassrls = TRUE** i
-- **nije član nijedne role** — dakle konekcija 2.0 backenda ZAOBILAZI RLS, a
-- direktni I/U/D grantovi bi pod BYPASSRLS bili opasni i nepotrebni. v1 je
-- POVUČEN u celosti.
--
-- ARHITEKTURA (v2): 2.0 backend za Talas B koristi `Sy15Service.withUserRls`:
--   1) GUC claims (`request.jwt.claims` sa sub+email) — kao do sada,
--   2) `SET LOCAL ROLE authenticated` u ISTOJ transakciji.
-- Time se ceo upit izvršava kao `authenticated` (rolbypassrls = f) → važe SVE
-- 1.0 RLS politike + table/fn privilegije IDENTIČNO kao kroz PostgREST =
-- paritet po konstrukciji. Nikakvi novi grantovi na tabele/funkcije nisu
-- potrebni: SET ROLE nasleđuje privilegije koje `authenticated` VEĆ ima
-- (SELECT/I/U/D po RLS-u na 16 sast + ai_chat tabela, EXECUTE na svih 13 front
-- RPC + 22 ai_chat_* alata — to je tačno površina koju 1.0 front već koristi).
--
-- SECURITY INVOKER funkcije (`ai_chat_sql`, `ai_chat_prijavi_kvar`) se pod
-- SET ROLE authenticated izvršavaju TAČNO kao u 1.0 — RLS pozivaoca važi
-- (ai_chat_sql SELECT-i idu pod RLS; prijavi_kvar insufficient_privilege →
-- uredan `nema_prava` tok). SECURITY DEFINER funkcije rade kao i do sada.
--
-- JEDINI R0 DB korak = članstvo (ispod). Primena: glavna sesija, na ŽIVOJ sy15,
-- ISKLJUČIVO kao `supabase_admin` (doktrina §A.6 — sy15 `postgres` nije superuser;
-- grant kao postgres je tihi no-op uz WARNING).
--
-- NAPOMENA (withUser bez SET ROLE): Reversi/Lokacije i dalje koriste `withUser`
-- (BYPASSRLS) — njihovo ponašanje se u ovom talasu NE dira. Upis AI istorije
-- (R2) će ili namerno koristiti BYPASSRLS konekciju (ekvivalent service role,
-- kako edge `ai-chat` piše danas; RLS INSERT/UPDATE na ai_chat_* = „NIKO")
-- ili novi DEFINER RPC — odluka u R2.
--
-- STORAGE (bez grant-a): bucketi `sastanci-arhiva`, `sastanak-slike`,
-- `ai-chat-images` idu kroz sy15 storage-api presigned sa SY15_SERVICE_KEY
-- (Reversi obrazac); RLS na storage.objects netaknut (spec §2).
--
-- NE DIRA SE (pozadina, grant SAMO service_role — izmereno, spec §0):
--   sastanci_dispatch_dequeue/mark_sent/mark_failed, sastanci_enqueue_*,
--   sast_auto_create_weekly, sast_create_weekly_at, sast_enqueue_cancel,
--   sastanci_pulse_notify_dispatch (pg_cron / edge dispatch).
-- ============================================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'servosync2_app') then
    raise notice 'rola servosync2_app ne postoji — preskočeno (uspostaviti pre R0)';
    return;
  end if;

  -- Članstvo = most za SET LOCAL ROLE authenticated (Sy15Service.withUserRls).
  -- Bez ovoga SET ROLE pada sa 42501 i Talas B endpointi vraćaju 403 na sve.
  if not exists (
    select 1
    from pg_auth_members m
    join pg_roles grp on grp.oid = m.roleid
    join pg_roles mem on mem.oid = m.member
    where grp.rolname = 'authenticated'
      and mem.rolname = 'servosync2_app'
  ) then
    grant authenticated to servosync2_app;
    raise notice 'GRANT authenticated TO servosync2_app — izvršeno';
  else
    raise notice 'servosync2_app je već član authenticated — no-op';
  end if;
end $$;

notify pgrst, 'reload schema';
