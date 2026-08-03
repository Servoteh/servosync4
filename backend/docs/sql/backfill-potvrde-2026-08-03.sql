-- ============================================================================
-- BACKFILL: zatvaranje zahteva koje su podnosioci VEĆ potvrdili komentarom
-- Datum: 2026-08-03 · Baza: GLAVNA (servosync-pg, app baza — NE sy15)
-- Grana: feat/zahtevi-potvrda-podnosioca
-- ============================================================================
--
-- ZAŠTO: do 03.08.2026 jedini prelaz statusa je bio admin-only `POST :id/status`.
-- Korisnik koji je probao isporuku mogao je SAMO da napiše komentar („RADI") — i da
-- misli da je time potvrdio. Nije bio. Zahtevi su ostajali u READY_FOR_TEST (40 na
-- dan uvođenja). Novi tok (`POST :id/confirm`) to rešava UNAPRED; ovaj skript zatvara
-- četiri NEDVOSMISLENE potvrde koje su se već dogodile, sa istom semantikom.
--
-- OBUHVAT (samo nedvosmislene potvrde — „radi/gotovo je", ne pitanja):
--   045/26  Milan Stojadinović  „RADI"                                 03.08. 08:38
--   049/26  Milan Stojadinović  „RADI"                                 03.08. 08:38
--   052/26  Đorđe Arsić         „To je to, sve smo se razumeli. Hvala." 31.07. 15:24
--   011/26  Duško Kostić        „Zadatak je uspešno obavljen."          03.08. 00:05
--
-- NAMERNO IZOSTAVLJENI (ljudska trijaža — to su prijave problema/pitanja, NE potvrde):
--   036/26, 012/26, 046/26, 009/26
--
-- ŠTA RADI (po zahtevu):
--   change_requests:        status='DONE', decided_at = VREME KOMENTARA,
--                           decided_by_user_id = autor komentara,
--                           decision_note = 'Potvrdio podnosilac komentarom DD.MM.'
--   change_request_events:  jedan red type='USER_CONFIRMED' (isti oblik kao writeEvent)
--
-- ŠTA NE DIRA: reward_status / reward_amount / final_score / ai_score — nagrada ostaje
-- admin odluka u tabu Nagrade (§12). Komentari se NE menjaju (već postoje).
--
-- SIGURNOST:
--   • IDEMPOTENTNO — menja SAMO redove koji su još u 'READY_FOR_TEST' i koji još
--     nemaju USER_CONFIRMED event. Drugo pokretanje ne radi ništa (0 redova).
--   • Vremena i autori se ČITAJU IZ PODATAKA (join na stvarni komentar), ništa nije
--     ukucano — ako komentar ne postoji tačno kako je opisan, red se preskače.
--   • Sve je u jednoj transakciji.
--
-- UPUTSTVO: prvo pusti KORAK 1 (pregled) i uporedi sa spiskom gore. Ako se poklapa,
-- pusti KORAK 2. Zatim KORAK 3 (provera).
--
-- KO GA PUŠTA: nalog koji ima INSERT na `change_request_events` I `USAGE, UPDATE` na
-- sekvenci `change_request_events_id_seq` (kolona `id` je SERIAL). Podsetnik na incident
-- 27.07.2026: USAGE bez UPDATE je oborio produkciju — ako pukne „permission denied for
-- sequence", to je uzrok, ne ovaj skript.
--
-- Oblik tabele je provaljen iz migracije 20260721220000_zahtevi_ai_pm_f1:
--   change_request_events(id SERIAL, request_id INT, type VARCHAR(30), actor_user_id INT,
--                         data JSONB, created_at TIMESTAMPTZ(6) DEFAULT now())
-- ('USER_CONFIRMED' = 14 znakova, staje u VARCHAR(30).)
-- ============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- KORAK 0 (jednom, informativno): kako izgleda postojeći event red — potvrdi da se
-- oblik koji upisujemo poklapa sa onim što aplikacija piše (kolone i `data`).
-- ─────────────────────────────────────────────────────────────────────────────
-- SELECT id, request_id, type, actor_user_id, data, created_at
--   FROM change_request_events
--  WHERE type IN ('STATUS_CHANGED','COMMENT')
--  ORDER BY id DESC LIMIT 5;


-- ═════════════════════════════════════════════════════════════════════════════
-- KORAK 1 — PREGLED (ništa ne menja). Očekivano: 4 reda.
-- ═════════════════════════════════════════════════════════════════════════════
WITH target(req_no, body_match) AS (
  VALUES ('045/26', 'RADI'),
         ('049/26', 'RADI'),
         ('052/26', 'To je to, sve smo se razumeli. Hvala.'),
         ('011/26', 'Zadatak je uspešno obavljen.')
),
pick AS (
  SELECT DISTINCT ON (r.id)
         r.id            AS request_id,
         r.req_no,
         r.title,
         c.author_user_id,
         c.created_at    AS confirmed_at,
         c.body
    FROM change_requests r
    JOIN target t                  ON t.req_no = r.req_no
    JOIN change_request_comments c ON c.request_id = r.id
                                  AND c.is_question = false
                                  AND upper(btrim(c.body)) = upper(t.body_match)
   WHERE r.status = 'READY_FOR_TEST'                    -- guard: samo još otvoreni
     AND NOT EXISTS (SELECT 1 FROM change_request_events e
                      WHERE e.request_id = r.id AND e.type = 'USER_CONFIRMED')
   ORDER BY r.id, c.created_at DESC                     -- poslednji takav komentar
)
SELECT p.req_no,
       p.title,
       u.full_name                                        AS potvrdio,
       p.confirmed_at AT TIME ZONE 'Europe/Belgrade'      AS vreme_potvrde,
       'Potvrdio podnosilac komentarom '
         || to_char(p.confirmed_at AT TIME ZONE 'Europe/Belgrade', 'DD.MM.')
                                                          AS decision_note_koji_ce_biti,
       p.body                                             AS komentar
  FROM pick p
  LEFT JOIN users u ON u.id = p.author_user_id
 ORDER BY p.req_no;


-- ═════════════════════════════════════════════════════════════════════════════
-- KORAK 2 — UPIS. Jedna transakcija; UPDATE + event u istom iskazu (data-modifying CTE),
-- pa event nikad ne može ostati bez prelaza statusa ni obrnuto.
-- ═════════════════════════════════════════════════════════════════════════════
BEGIN;

WITH target(req_no, body_match) AS (
  VALUES ('045/26', 'RADI'),
         ('049/26', 'RADI'),
         ('052/26', 'To je to, sve smo se razumeli. Hvala.'),
         ('011/26', 'Zadatak je uspešno obavljen.')
),
pick AS (
  SELECT DISTINCT ON (r.id)
         r.id         AS request_id,
         c.author_user_id,
         c.created_at AS confirmed_at,
         c.body
    FROM change_requests r
    JOIN target t                  ON t.req_no = r.req_no
    JOIN change_request_comments c ON c.request_id = r.id
                                  AND c.is_question = false
                                  AND upper(btrim(c.body)) = upper(t.body_match)
   WHERE r.status = 'READY_FOR_TEST'
     AND NOT EXISTS (SELECT 1 FROM change_request_events e
                      WHERE e.request_id = r.id AND e.type = 'USER_CONFIRMED')
   ORDER BY r.id, c.created_at DESC
),
upd AS (
  UPDATE change_requests r
     SET status             = 'DONE',
         decided_at         = p.confirmed_at,
         decided_by_user_id = p.author_user_id,
         decision_note      = 'Potvrdio podnosilac komentarom '
                              || to_char(p.confirmed_at AT TIME ZONE 'Europe/Belgrade', 'DD.MM.'),
         updated_at         = now()
    FROM pick p
   WHERE r.id = p.request_id
     AND r.status = 'READY_FOR_TEST'          -- ponovljen guard (CAS na samom UPDATE-u)
  RETURNING r.id AS request_id, p.author_user_id, p.confirmed_at, p.body
)
INSERT INTO change_request_events (request_id, type, actor_user_id, data, created_at)
SELECT u.request_id,
       'USER_CONFIRMED',
       u.author_user_id,
       -- Isti oblik kao živi tok (writeEvent: {from,to,comment}) + `backfill` marker,
       -- da se u istoriji vidi da je red nastao skriptom, a ne klikom u aplikaciji.
       jsonb_build_object(
         'from',     'READY_FOR_TEST',
         'to',       'DONE',
         'comment',  u.body,
         'backfill', true,
         'note',     'Retroaktivno zatvoreno po komentaru podnosioca (backfill 03.08.2026).'
       ),
       u.confirmed_at                          -- event nosi vreme POTVRDE, ne vreme skripte
  FROM upd u;

-- Očekivano: INSERT 0 4 (i 4 ažurirana zahteva). Ako je broj MANJI, neki zahtev je
-- već zatvoren ili komentar ne izgleda kako je opisano — pusti KORAK 1 pa proveri.
-- Ako broj ne odgovara očekivanju: ROLLBACK;

COMMIT;


-- ═════════════════════════════════════════════════════════════════════════════
-- KORAK 3 — PROVERA POSLE UPISA. Očekivano: 4 reda, svi status='DONE',
-- decided_at = vreme komentara, i tačno jedan USER_CONFIRMED event po zahtevu.
-- ═════════════════════════════════════════════════════════════════════════════
SELECT r.req_no,
       r.status,
       r.decided_at AT TIME ZONE 'Europe/Belgrade' AS decided_at_lokalno,
       u.full_name                                 AS decided_by,
       r.decision_note,
       r.reward_status,                            -- mora ostati NEPROMENJEN
       (SELECT count(*) FROM change_request_events e
         WHERE e.request_id = r.id AND e.type = 'USER_CONFIRMED') AS user_confirmed_events
  FROM change_requests r
  LEFT JOIN users u ON u.id = r.decided_by_user_id
 WHERE r.req_no IN ('045/26', '049/26', '052/26', '011/26')
 ORDER BY r.req_no;

-- Kontrola preostalih (koliko je još zahteva zaglavljeno u proveri):
-- SELECT req_no, title, status FROM change_requests
--  WHERE status = 'READY_FOR_TEST' ORDER BY req_no;
