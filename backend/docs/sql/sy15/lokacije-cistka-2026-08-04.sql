-- ============================================================================
-- DATA-FIX: čistka polica — deaktivacija mrtvih polica pod ugašenom halom MAG
-- Datum: 2026-08-04 · Baza: sy15 (ubuntusrv, docker sy15-db, user supabase_admin)
-- Grana: fix/lokacije-picker-zadu-i-audit
-- Izvršavanje: ssh ubuntusrv "docker exec -i sy15-db psql -U supabase_admin -d postgres" < ovaj_fajl
--   (ili korak po korak; KORAK 1 je čist SELECT — uvek prvo njega)
-- ============================================================================
--
-- ZAŠTO (prijava Nenada 04.08: „neka pregleda SVE police — neke se ponavljaju,
-- neke nisu po redu"): hala `MAG` („Centralni magacin", WAREHOUSE) je DEAKTIVIRANA,
-- ali je pod njom ostalo 9 AKTIVNIH polica: K-A6, K-B6, K-C6, K-D, K-MG, K-MG3,
-- K-MG4, K-MG8, K-S. Pošto pickeri učitavaju samo aktivne lokacije, te police se
-- prikazuju BEZ svoje hale (grupa „Ostalo"), a path im počinje na „Centralni…"
-- pa se sortiraju PRE svih „Hala …" grupa — magacioneru izgledaju kao višak
-- polica van reda, a duplraju i zone drugih hala (K-A6 „FARBANJE" uz K-A1–K-A5
-- „FARBANJE" u Hali 2A; K-MG3/K-MG4/K-MG8 „MAGACIN_H3/H4/H8" uz prave hale).
--
-- IZMERENO NA PRODU 04.08.2026 (podloga):
--   • hala MAG: id 1faff509-21df-40e8-92e5-85022bc005f0, is_active = false;
--   • njenih 9 aktivnih polica: 8 ima NULA uloga (loc_item_placements qty>0)
--     i NULA pokreta IKAD (loc_location_movements, from ili to);
--   • IZUZETAK K-D („DORADA"): 1 ulog (1 kom) + 1 pokret (2026-05-10) —
--     NIJE u ovom skriptu, čeka Nenadovu odluku (v. tabelu odluka u izveštaju);
--   • nijedna DB funkcija (pg_proc.prosrc) ne referencira K-MG/MAGACIN_H*/
--     „Centralni magacin" — deaktivacija ne dira ingest/sync tokove;
--   • neaktivnih lokacija sa ulozima qty>0 NEMA (kontrola posle izvršenja mora
--     tako i ostati); duplikata (parent_id, location_code) među aktivnima NEMA.
--
-- ŠTA RADI: deaktivira TAČNO 8 pobrojanih polica pod halom MAG, i to samo ako
-- SU I DALJE bez uloga i bez pokreta (tvrdi NOT EXISTS uslovi u WHERE — skript
-- je bezbedan i ako se stanje promeni između čitanja i izvršavanja).
-- Obrazac = jučerašnja deaktivacija duplikata „KAVEZ 1" (SHELF bez uloga).
--
-- ŠTA NE RADI (Nenadove odluke, popisane u izveštaju):
--   • K-D (1 kom na stanju) — deaktivacija bi sakrila živ ulog;
--   • HALA 1 polica B1 „delovi bezveze" (preimenovanje u „Magacin" vraća je u
--     redosled — prazna je i bez istorije, ali je preimenovanje odluka);
--   • ALAT-MAG-01 polica D3 „Gotovi delovi za montazu" (naziv/šifra odudaraju);
--   • ZADU-O-* ružne šifre (reversi vlasništvo, kozmetika).
--
-- SIGURNOST / IDEMPOTENTNOST: ponovni prolaz nalazi 0 kandidata (is_active
-- uslov); UPDATE vraća pogođene redove (RETURNING) radi zapisnika.
-- ============================================================================

-- ── KORAK 1 — PREVIEW: šta bi bilo deaktivirano (čist SELECT, bez izmena) ────
-- Očekivano: 8 redova (K-A6, K-B6, K-C6, K-MG, K-MG3, K-MG4, K-MG8, K-S),
-- svaki sa ulozi=0 i pokreti=0. K-D se NE SME pojaviti.
SELECT s.location_code,
       s.name,
       s.location_type,
       s.is_active,
       (SELECT count(*) FROM loc_item_placements pl
         WHERE pl.location_id = s.id AND pl.quantity > 0)             AS ulozi_qty_gt_0,
       (SELECT count(*) FROM loc_location_movements m
         WHERE m.to_location_id = s.id OR m.from_location_id = s.id)  AS pokreti_ikad
  FROM loc_locations s
 WHERE s.parent_id = '1faff509-21df-40e8-92e5-85022bc005f0'  -- hala MAG (ugašena)
   AND s.location_type = 'SHELF'
   AND s.is_active
   AND s.location_code IN ('K-A6','K-B6','K-C6','K-MG','K-MG3','K-MG4','K-MG8','K-S')
   AND NOT EXISTS (SELECT 1 FROM loc_item_placements pl
                    WHERE pl.location_id = s.id AND pl.quantity > 0)
   AND NOT EXISTS (SELECT 1 FROM loc_location_movements m
                    WHERE m.to_location_id = s.id OR m.from_location_id = s.id)
 ORDER BY s.location_code;

-- ── KORAK 2 — DEAKTIVACIJA (pokrenuti TEK po pregledanom KORAKU 1) ───────────
BEGIN;

UPDATE loc_locations s
   SET is_active  = false,
       notes      = coalesce(nullif(btrim(coalesce(s.notes, '')), '') || E'\n', '')
                    || 'Deaktivirano 2026-08-04: mrtva polica pod ugašenom halom MAG '
                    || '(0 uloga, 0 pokreta ikad) — čistka po prijavi 04.08.',
       updated_at = now()
 WHERE s.parent_id = '1faff509-21df-40e8-92e5-85022bc005f0'  -- hala MAG (ugašena)
   AND s.location_type = 'SHELF'
   AND s.is_active
   AND s.location_code IN ('K-A6','K-B6','K-C6','K-MG','K-MG3','K-MG4','K-MG8','K-S')
   AND NOT EXISTS (SELECT 1 FROM loc_item_placements pl
                    WHERE pl.location_id = s.id AND pl.quantity > 0)
   AND NOT EXISTS (SELECT 1 FROM loc_location_movements m
                    WHERE m.to_location_id = s.id OR m.from_location_id = s.id)
RETURNING s.location_code, s.name, s.is_active;

-- Očekivano: UPDATE 8 (na prvom prolazu; kasniji prolazi: UPDATE 0).
-- Ako je broj drugačiji od 8 ili je K-D u RETURNING listi → ROLLBACK; i stani.

COMMIT;

-- ── KORAK 3 — VERIFIKACIJA ───────────────────────────────────────────────────
-- 3a: pod halom MAG sme da ostane aktivna JEDINO K-D (do Nenadove odluke).
SELECT s.location_code, s.name, s.is_active
  FROM loc_locations s
 WHERE s.parent_id = '1faff509-21df-40e8-92e5-85022bc005f0'
 ORDER BY s.is_active DESC, s.location_code;
-- Očekivano: K-D | DORADA | t  — i svih 8 ostalih sa is_active = f.

-- 3b: invarijanta cele baze — nijedna NEAKTIVNA lokacija ne drži ulog qty>0.
SELECT count(*) AS neaktivne_sa_ulozima   -- očekivano: 0
  FROM loc_item_placements pl
  JOIN loc_locations l ON l.id = pl.location_id
 WHERE NOT l.is_active AND pl.quantity > 0;
