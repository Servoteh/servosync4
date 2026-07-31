-- =============================================================================
-- sy15 hardening — TALAS 3: `anon` gubi sva prava na tabelama u `public`
-- Primenjeno 31.07.2026 po odluci vlasnika („zatvori"). Fajl je trag i recept.
--
-- OVO NIJE BILA POPRAVKA CURENJA — ovo je druga brava.
-- Mereno pre izmene, nad SVIH 177 tabela na kojima je `anon` imao pravo čitanja:
--   • sve 177 su imale UKLJUČEN RLS,
--   • nijedna politika nije puštala anon (provereno: nema SELECT/ALL politike sa
--     `USING (true)` za anon/public),
--   • živ test pravim anonimnim HTTP zahtevima na svih 177: **0 vraćenih redova**
--     (159 → prazan niz, 18 → greška 42501 jer im RLS predikat-funkcije više nisu
--      izvršive za anon posle talasa 2).
--
-- Razlog za izmenu: zaštita je zavisila ISKLJUČIVO od toga da RLS ostane ispravan
-- na svakoj od 177 tabela zauvek. Ta pretpostavka je 31.07. pukla dva puta
-- (`kadr_vacation_editor_allowlist` bez RLS-a i javno upisiva; 24 pogleda bez
-- `security_invoker` koja RLS zaobilaze po prirodi). Uz to je stanje bilo
-- nedosledno: NOVE tabele brana (`sec_guard_revoke_anon`) automatski zaključava,
-- a zatečenih 177 je stajalo otključano.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) SNIMAK ZA POVRATAK (177 tabela / 1239 zapisa o pravima)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public._anon_grants_backup_20260731 (
  table_name text, privilege_type text, snimljeno timestamptz DEFAULT now()
);
TRUNCATE public._anon_grants_backup_20260731;
INSERT INTO public._anon_grants_backup_20260731 (table_name, privilege_type)
SELECT g.table_name, g.privilege_type
  FROM information_schema.role_table_grants g
  JOIN pg_class c ON c.relname = g.table_name
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public' AND c.relkind = 'r'
 WHERE g.table_schema = 'public' AND g.grantee = 'anon';

-- -----------------------------------------------------------------------------
-- 2) OPOZIV (authenticated i service_role se NE diraju — backend se povezuje kao
--    `servosync2_app` koji je ČLAN role `authenticated` i time nasleđuje prava)
-- -----------------------------------------------------------------------------
DO $$
DECLARE r record; n int := 0;
BEGIN
  FOR r IN
    SELECT DISTINCT c.relname
      FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = 'public' AND c.relkind = 'r'
       AND EXISTS (SELECT 1 FROM information_schema.role_table_grants g
                    WHERE g.table_schema='public' AND g.table_name=c.relname AND g.grantee='anon')
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon', r.relname);
    n := n + 1;
  END LOOP;
  RAISE NOTICE 'Oduzeta sva prava roli anon na % tabela', n;   -- izvršeno: 177
END $$;

-- =============================================================================
-- PROVERE POSLE PRIMENE (31.07.2026, sve zeleno)
--   anon → 401: employees, maint_machines, vacation_requests, work_hours_remarks,
--               nop_requests, sastanci
--   namerni anonimni tokovi i dalje rade:
--     rpc/kiosk_record_punch       → 200 {"ok":false,"error":"nepoznat_qr"}
--     rpc/assessment_token_context → 200 {"ok":false,"error":"Neispravan link."}
--   prijavljen korisnik netaknut (SET LOCAL ROLE authenticated):
--     employees 157 · maint_machines 87 · vacation_requests 119
--   backend log: 0 grešaka dozvola · post-deploy-verify.sh 🟢 EXIT 0
--
-- NADZOR (jedini način da se otkrije nepoznat anonimni potrošač — gateway beleži
-- samo greške, a PostgREST uopšte ne beleži zahteve; baza BELEŽI svako odbijanje):
--   ssh ubuntusrv "docker logs --since 24h sy15-db 2>&1 \
--     | grep 'permission denied' | grep -oE 'for (table|function) [a-z0-9_]+' \
--     | sort | uniq -c | sort -rn"
--
-- POVRATAK ZA JEDNU TABELU (ako se pokaže da je stvarno treba anonimno):
--   DO $$ DECLARE p record; BEGIN
--     FOR p IN SELECT privilege_type FROM public._anon_grants_backup_20260731
--               WHERE table_name = 'IME_TABELE'
--     LOOP EXECUTE format('GRANT %s ON TABLE public.%I TO anon', p.privilege_type, 'IME_TABELE');
--     END LOOP;
--   END $$;
--   Uz obaveznu belešku ZAŠTO je izuzetak — inače se tiho vraća stara postavka.
-- =============================================================================
