-- ============================================================================
-- UKLANJANJE KONTA 1329 („NIV protivstavka") — naša izmišljotina bez BigBit porekla
-- ============================================================================
-- SVRHA: konto `1329` je uveden u `20260723155000_seed_chart_of_accounts` kao PREDLOG
-- protivstavke za knjiženje nivelacije (`PostingEngineService.postNivLeveling`), uz izričitu
-- napomenu „⏳ potvrda Nesa/Negovan". Studija BigBit-a nad produkcijskom bazom
-- (`backend/docs/migration/BIGBIT_KONTA_I_SEME_KNJIZENJA.md` §6.9) presudila je da potvrde
-- neće biti — knjiženja nivelacije uopšte nema. Dokazi (reprodukovani direktno nad
-- `_legacy/BigbitRaznoNenad/BB_T_25.MDB` prilikom pisanja ove migracije):
--
--   1) `R_Vrste dokumenata` za vrstu `NIV`:
--      Sema za kontiranje = 0, Knjiziti sintetiku = 0, Knjiziti analitiku = 0,
--      KnjizitiUPDVEvidenciju = 0, UticeNaZalihe = 1  → NIV je čisto ROBNI događaj.
--   2) `Sema za kontiranje`: 30 šema, NIJEDNA nema `Vrsta naloga = 'NIV'`.
--   3) `Kontni plan`: cela grupa 132 ima samo `132`, `1320`, `1321` (Rezervisana roba) —
--      `1329` NE POSTOJI, niti ima ijednu stavku u glavnoj knjizi 2025/2026.
--      („Ukalkulisana razlika u ceni" u BigBit-u postoji samo za MALOPRODAJU: `1341`/`13411`.)
--   4) `Magacini`: sva tri magacina imaju `ProsecneCene = 1` → zalihe po PROSEČNIM nabavnim
--      cenama, bez ukalkulisane razlike u ceni → RUC konto grupe 132x ovde nema smisla.
--
-- Uz paritet, knjiženje je bilo i suštinski netačno: `valueAdjustment` (revalorizacija
-- ZATEČENOG stanja) poništava se suprotnim prilagođenjem na NOVOPRIMLJENOJ količini, pa je
-- neto efekat na vrednost zaliha nula. Primer: stanje 10×100 = 1.000 + ulaz 10×200 = 2.000
-- (već proknjižen svojom šemom) → GK zaliha 3.000; novaVP = 150; valueAdjustment = +500;
-- knjiženjem bi GK zaliha postala 3.500, a stvarna vrednost magacina je 20×150 = 3.000.
--
-- POSLEDICA U KODU (isti paket): `postNivLeveling` više ne pravi nalog — NIV dokument se samo
-- zatvara (`status = 'POSTED'`, `journal_entry_id` ostaje NULL, stavke `is_posted = true`).
--
-- BEZBEDNOST: konto se briše SAMO ako nema nikakvog traga. Ako ima stavku u glavnoj knjizi
-- (ili ga referiše šema/saldakonto registar) — NE briše se, nego se OZNAČAVA u nazivu, da
-- postojeći podaci i FK-ovi ostanu netaknuti (`fk_ledger_entries_account` je ON DELETE NO ACTION,
-- a `fk_saldakonto_account` je CASCADE — brisanje bi tiho pojelo red u registru).
--
-- STANJE PRI PISANJU (provereno na dev 192.168.64.28:5437 i na produ, 25.07.2026):
--   accounts '1329' = 1 red, ledger_entries na 1329 = 0, stock_documents kind='NIV' = 0,
--   stock_leveling_items = 0, i nijedna meka referenca (popdv_account_map, vat_account_map,
--   warehouses.account, cash_journals.account_code, document_types.analytical_account).
--
-- IDEMPOTENTNOST: ponovno pokretanje je no-op (konto više ne postoji, odnosno već je označen).
-- ============================================================================

DO $$
DECLARE
  ledger_cnt  INTEGER;
  scheme_cnt  INTEGER;
  saldak_cnt  INTEGER;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM accounts WHERE code = '1329') THEN
    RAISE NOTICE 'Konto 1329 ne postoji — nema šta da se ukloni.';
    RETURN;
  END IF;

  SELECT count(*) INTO ledger_cnt FROM ledger_entries          WHERE account_code = '1329';
  SELECT count(*) INTO scheme_cnt FROM accounting_scheme_lines WHERE account_code = '1329';
  SELECT count(*) INTO saldak_cnt FROM saldakonto_accounts     WHERE account      = '1329';

  IF ledger_cnt = 0 AND scheme_cnt = 0 AND saldak_cnt = 0 THEN
    DELETE FROM accounts WHERE code = '1329';
    RAISE NOTICE 'Konto 1329 obrisan iz kontnog plana (bez prometa i referenci).';
  ELSE
    -- Ima traga → ne diramo podatke, samo jasno označimo konto kao napušten.
    UPDATE accounts
       SET name = 'NE KORISTITI — napušten konto (nivelacija se ne knjiži u GK)',
           long_description =
             'Uveden 23.07.2026 kao predlog protivstavke za NIV knjiženje. Nema poreklo u BigBit '
             || 'kontnom planu (v. BIGBIT_KONTA_I_SEME_KNJIZENJA.md §6.9). Zadržan jer postoji '
             || 'zatečen trag: stavki u glavnoj knjizi ' || ledger_cnt
             || ', linija šema kontiranja ' || scheme_cnt
             || ', redova u saldakonto registru ' || saldak_cnt
             || '. Ne knjižiti na njega; ukloniti tek kad trag bude raščišćen.',
           updated_at = now()
     WHERE code = '1329';
    RAISE NOTICE 'Konto 1329 NIJE obrisan (ledger=%, seme=%, saldakonto=%) — označen kao napušten.',
      ledger_cnt, scheme_cnt, saldak_cnt;
  END IF;
END
$$;
