-- Sastanci 024/26 — KORAK 2: podsetnik učesnicima „pola sata pred sastanak".
--
-- ZAHTEV (Zoran, 29.07.2026): „Učesnicima predstojećeg sastanka treba da stigne
-- podsetnik pola sata pred sastanak."
--
-- ZATEČENO (živa baza, 04.08.2026): fn `sastanci_enqueue_meeting_reminders` ima
-- prozor 15–45 min pre početka, a 3.0 scheduler posao `sast-meeting-reminders`
-- kadencu 30 min → mejl stiže bilo kad između 15 i 45 min pre sastanka.
-- TZ deo je ISPRAVAN (starts_at se računa `AT TIME ZONE 'Europe/Belgrade'` —
-- fix od 27.07); sy15 pg_cron poslovi za sastanke su UGAŠENI (Talas A cutover
-- 25.07), pa je 3.0 scheduler jedini pozivalac ove fn.
--
-- IZMENA: prozor 25–35 min + 3.0 kadenca 5 min (grana fix/sastanci-dopune-024,
-- `sy15-cron-jobs.ts`) → prvi tik koji „vidi" sastanak upada 30–35 min pre
-- početka; dispatch (na 2 min) ga pošalje odmah → mejl stiže ~pola sata pre.
--
-- ⚠️ SPREGA PROZOR↔KADENCA (ne menjati jedno bez drugog):
--   * prozor MORA biti ŠIRI od kadence pozivaoca, inače tik preskoči sastanak
--     (stari par: prozor 30 min širine uz kadencu 30 — taman; novi: 10 uz 5);
--   * dedup guard (1 h po učesniku+sastanku u `sastanci_notification_log`)
--     garantuje da širi prozor NE šalje duplikate.
-- REDOSLED PRIMENE JE SLOBODAN: novi 3.0 kod (kadenca 5) uz STARI prozor 15–45
-- samo šalje ~40–45 min ranije (dedup i dalje 1×); stari kod (kadenca 30) uz
-- NOVI prozor 25–35 bi PRESKAKAO sastanke — zato NE primenjivati ovaj korak dok
-- grana nije na produ. Preporuka: deploy koda PA ovaj korak.
--
-- Jedina promena u telu fn: BETWEEN '15 minutes'/'45 minutes' → '25'/'35'.
-- Ostalo je doslovno živa definicija (00_preflight D) — uključujući TZ račun,
-- dedup i payload.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.sastanci_enqueue_meeting_reminders()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_rec RECORD; v_ucr RECORD; v_dupl BOOLEAN; v_cnt INT := 0;
BEGIN
  FOR v_rec IN
    SELECT s.id, s.naslov, s.datum, s.vreme, s.mesto, s.tip,
      COALESCE(s.vodio_email, s.created_by_email) AS organizator,
      ((s.datum + COALESCE(s.vreme, '09:00'::time)) AT TIME ZONE 'Europe/Belgrade') AS starts_at
    FROM public.sastanci s
    WHERE s.status = 'planiran' AND s.datum IS NOT NULL AND s.vreme IS NOT NULL
  LOOP
    -- 024/26: prozor 25–35 min (uz 3.0 kadencu 5 min → mejl ~30–35 min pre).
    IF v_rec.starts_at NOT BETWEEN (now() + interval '25 minutes') AND (now() + interval '35 minutes') THEN
      CONTINUE;
    END IF;
    FOR v_ucr IN SELECT email, label FROM public.sastanak_ucesnici WHERE sastanak_id = v_rec.id
    LOOP
      SELECT EXISTS (SELECT 1 FROM public.sastanci_notification_log
        WHERE kind = 'meeting_reminder' AND recipient_email = lower(v_ucr.email)
          AND related_sastanak_id = v_rec.id AND status IN ('queued','sent')
          AND created_at >= (now() - interval '1 hour')) INTO v_dupl;
      IF v_dupl THEN CONTINUE; END IF;
      PERFORM public.sastanci_enqueue_notification('meeting_reminder', 'email', v_ucr.email, v_ucr.label,
        format('Podsetnik: %s - %s u %s', v_rec.naslov, to_char(v_rec.datum,'DD.MM.YYYY'), left(v_rec.vreme::text,5)),
        NULL, NULL, v_rec.id, NULL,
        jsonb_build_object('sastanak_id',v_rec.id,'naslov',v_rec.naslov,'datum',v_rec.datum::text,
          'vreme',left(v_rec.vreme::text,5),'mesto',v_rec.mesto,'tip',v_rec.tip,'organizator',v_rec.organizator,'starts_at',v_rec.starts_at::text), NULL);
      v_cnt := v_cnt + 1;
    END LOOP;
  END LOOP;
  RETURN v_cnt;
END;
$function$;

-- Provera posle primene (očekivano: '25 minutes' i '35 minutes' u definiciji):
SELECT pg_get_functiondef('public.sastanci_enqueue_meeting_reminders()'::regprocedure);
