-- Prijava kvara kroz AI chat za SVA sredstva — mašine, vozila, IT, objekti (03.08.2026)
--
-- ZAŠTO: `ai_chat_prijavi_kvar` je razrešavala samo `maint_machines` i tvrdo upisivala
-- asset_type='machine'. Za „prijavi kvar na Caddyju BG2884XA" vraćala je „nema_masine",
-- iako put kroz UI dijalog za vozila radi. Na produ: 43 vozila, 0 prijavljenih kvarova.
--
-- PARITET: ponašanje za MAŠINE ostaje 1:1 — `ai_chat_maint_resolve` se i dalje zove PRVI
-- i ako nađe mašinu, ništa se ne menja (isti machine_code, isti asset_type). Novo
-- razrešenje je čist fallback za ono što je do sada bila greška.
--
-- machine_code je NOT NULL, pa za sredstva koja nisu mašine upisujemo `asset_code` —
-- isto što FE dijalog već radi (`prijava-kvara-dialog.tsx`: „asset_code u koloni
-- machine_code, §5.1 pravilo 24"), tako da su oba puta upisa identična.
--
-- Pokretanje: docker exec -i sy15-db psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -f -

BEGIN;

-- ── Razrešenje BILO KOG sredstva: šifra, naziv ili REGISTARSKA OZNAKA ──────────
-- SECURITY DEFINER kao i `ai_chat_maint_resolve`: katalog sredstava je svima čitljiv
-- za lookup, a sam upis kvara i dalje ide pod pozivaocem (RLS presuđuje).
-- NAMERNO bez `anon` granta (sanacija 31.07.2026 — `anon` ne sme u sy15 podatke).
CREATE OR REPLACE FUNCTION public.ai_chat_asset_resolve(p_pojam text)
 RETURNS TABLE(asset_code text, asset_id uuid, asset_type maint_asset_type, name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select a.asset_code, a.asset_id, a.asset_type, a.name
  from maint_assets a
  left join maint_vehicle_details vd on vd.asset_id = a.asset_id
  where a.archived_at is null
    and (
      a.asset_code = trim(p_pojam)
      or public.ai_chat_norm_name(a.name)
         like '%' || public.ai_chat_norm_name(trim(p_pojam)) || '%'
      -- tablice: „BG 2884 XA" i „bg2884xa" moraju da nađu isto vozilo
      or (vd.registration_plate is not null
          and replace(upper(vd.registration_plate), ' ', '')
              = replace(upper(trim(p_pojam)), ' ', ''))
    )
  order by
    (a.asset_code = trim(p_pojam)) desc,
    (vd.registration_plate is not null
     and replace(upper(vd.registration_plate), ' ', '')
         = replace(upper(trim(p_pojam)), ' ', '')) desc,
    a.name
  limit 1;
$function$;

REVOKE ALL ON FUNCTION public.ai_chat_asset_resolve(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ai_chat_asset_resolve(text) TO authenticated, service_role;

-- ── Prijava kvara: mašina (netaknuto) → fallback bilo koje sredstvo ────────────
CREATE OR REPLACE FUNCTION public.ai_chat_prijavi_kvar(
  p_masina text,
  p_naslov text,
  p_opis text DEFAULT NULL::text,
  p_ozbiljnost text DEFAULT 'minor'::text,
  p_bezbednosni_rizik boolean DEFAULT false
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_mc text; v_aid uuid;
  v_atype maint_asset_type;
  v_naziv text;
  v_sev maint_incident_severity;
  v_id uuid; v_wo uuid; v_wonum text;
  v_labela text;
begin
  if coalesce(trim(p_naslov),'') = '' then
    return jsonb_build_object('error', 'prazno', 'poruka', 'Naslov (kratak opis kvara) je obavezan.');
  end if;

  -- 1) MAŠINA — postojeći put, nepromenjen (DEFINER helper; katalog je čitljiv za lookup).
  select machine_code, asset_id, name into v_mc, v_aid, v_naziv
    from public.ai_chat_maint_resolve(p_masina);
  if v_mc is not null then
    v_atype := 'machine';
  else
    -- 2) NOVO: bilo koje sredstvo — vozilo (i po tablicama), IT oprema, objekat.
    select asset_code, asset_id, asset_type, name into v_mc, v_aid, v_atype, v_naziv
      from public.ai_chat_asset_resolve(p_masina);
  end if;

  if v_mc is null then
    return jsonb_build_object('error', 'nema_sredstva',
      'poruka', 'Sredstvo „' || coalesce(p_masina,'') || '" nije nađeno — proveri šifru, naziv ili registarsku oznaku.');
  end if;

  begin
    v_sev := lower(trim(coalesce(p_ozbiljnost,'minor')))::maint_incident_severity;
  exception when others then v_sev := 'minor';
  end;

  v_id := gen_random_uuid();
  begin
    -- id se generiše unapred (bez RETURNING) — RETURNING bi tražio SELECT-vidljivost
    -- reda, koju običan prijavilac nema (njegov kvar vidi održavanje).
    insert into maint_incidents (id, machine_code, asset_id, asset_type, reported_by, title, description, severity, status, safety_marker)
    values (v_id, v_mc, v_aid, case when v_aid is null then null else v_atype end, auth.uid(),
            trim(p_naslov), nullif(trim(coalesce(p_opis,'')),''), v_sev, 'open', coalesce(p_bezbednosni_rizik,false));
  exception
    when insufficient_privilege then
      return jsonb_build_object('error', 'nema_prava',
        'poruka', 'Nemaš pravo da prijaviš kvar kroz aplikaciju — obrati se održavanju ili administratoru.');
    when others then
      return jsonb_build_object('error', 'greska', 'poruka', 'Prijava nije sačuvana: ' || SQLERRM);
  end;

  -- WO kreira AFTER-trigger (major/critical/safety) → čitaj posle inserta, ne iz RETURNING
  select i.work_order_id into v_wo from maint_incidents i where i.id = v_id;
  if v_wo is not null then
    select wo_number into v_wonum from maint_work_orders where wo_id = v_wo;
  end if;

  -- Poruka imenuje TIP sredstva — „za mašinu 3.12" vs „za vozilo BG2884XA".
  -- ⚠️ Vrednosti enum-a `maint_asset_type` su: machine | vehicle | it | facility.
  -- Poređenje se radi nad TEKSTOM: nepostojeći literal (npr. 'it_asset') u CASE-u
  -- nad enum vrednošću obara CELU funkciju, i za mašine — uhvaćeno testom 03.08.2026.
  v_labela := case v_atype::text
                when 'vehicle'  then 'vozilo '
                when 'it'       then 'IT opremu '
                when 'facility' then 'objekat '
                else 'mašinu '
              end || v_mc || coalesce(' (' || v_naziv || ')', '');

  return jsonb_build_object('ok', true, 'incident_id', v_id,
    'sredstvo', v_mc, 'tip_sredstva', v_atype,
    -- `masina` se ZADRŽAVA radi kompatibilnosti sa postojećim pozivaocima/promptom
    'masina', v_mc,
    'radni_nalog', v_wonum,
    'poruka', 'Kvar je prijavljen za ' || v_labela || '.'
      || case when v_wonum is not null then ' Automatski je otvoren radni nalog ' || v_wonum || '.'
              when v_sev in ('major','critical') or coalesce(p_bezbednosni_rizik,false)
                then ' Održavanje je obavešteno o hitnom kvaru.'
              else '' end);
end;
$function$;

COMMIT;

-- ── Provera posle primene (ne upisuje ništa) ──────────────────────────────────
\echo '== Razresenje po TABLICAMA (mora naci vozilo) =='
SELECT * FROM public.ai_chat_asset_resolve('BG2884XA');
\echo '== Razresenje po NAZIVU vozila =='
SELECT * FROM public.ai_chat_asset_resolve('Caddy Beli');
\echo '== Masina i dalje ide starim putem (asset_type = machine) =='
SELECT * FROM public.ai_chat_asset_resolve('10.1');
\echo '== Grantovi: nova fn NEMA anon =='
SELECT proname, proacl::text FROM pg_proc WHERE proname = 'ai_chat_asset_resolve';
