-- PDV konto→uloga mapiranje (koren KIF/KUF/POPDV izvođenja).
-- Bez ovoga KIF/KUF/POPDV vraćaju NULU (vat-ledger puni knjige iz ledger_entries
-- preko ovog registra po direction + rate).
--
--   • 27xx = pretporez (ulazni PDV)   → direction='input'   (raste dugovanjem)
--   • 47xx = obaveza za PDV (izlazni) → direction='output'  (raste potraživanjem)
--   • rate = nominalna stopa (20/10); role = standard | avans | carinski
--   • osnovica se UVEK izvodi iz stope: base = PDV/(rate/100). Nema konta koje
--     nosi porez a nema osnovicu — kolona has_base je UKINUTA (migracija
--     20260727090000): naduvavala je osnovicu za stotine miliona dinara.
--
-- SKUP KONTA JE ODREĐEN BIGBITOM, ne pretpostavkom: mesečni nalog vrste `PDV`
-- zatvara tačno sva PDV konta u transitno konto 2790/4790, pa je to merilo koje
-- konto pripada registru. Kontrola: (pretporez − obaveza) po ovom skupu se
-- poklapa sa saldom 2790/4790 iz tog naloga za svih 6 zatvorenih meseci 2026
-- (razlike 0,20–1,11 RSD = zaokruženje obaveze na ceo dinar, knjiženo na 6799).
--
-- NAMERNO VAN REGISTRA (vidi migraciju 20260727090000_pdv_registar_ispravka):
--   • 2790 / 4790  — transitna konta prema PU: rezultat obračuna, ne porez;
--                    služe kao kontrolna tačka u `vat-sanity.ts`.
--   • 2704 / 2714 / 2721 — „PDV koji se ne može koristiti / nepriznat": nalog
--                    vrste `PDV` ih ne zatvara; preknjižava ih nalog `BPDV` na
--                    trošak. Mapiranje bi uvuklo stotine BPDV stavki u KIF/KUF.
--   • 2050 / 4331 / 2780 — NISU PDV konta u Servotehovom kontnom planu
--                    (potraživanje od kupaca u inostranstvu / dobavljači za
--                    nefakturisane obaveze / potraživanje za više plaćen PDV).
--                    Promet oslobođen PDV-a se u POPDV izvodi iz PROMETNIH konta
--                    preko `popdv_account_map`, ne iz PDV konta.
--
-- `name` prati KONTNI PLAN (`accounts.name`) — nesklad imena je bio jedini
-- vidljiv trag pogrešnih mapiranja i mora ostati proverljiv. Idempotentan seed.
TRUNCATE vat_account_map;

INSERT INTO public.vat_account_map (account, name, direction, rate, role) VALUES
  -- ── PRETPOREZ (ulazni PDV) — 27xx, duguje ─────────────────────────────────
  ('2700',  'PDV u primljenim fakturama 20%',                                'input',  20, 'standard'),
  ('27001', '20% Povećanje osnovice - KZ',                                   'input',  20, 'standard'),
  ('27002', '20% Smanjenje osnovice - KO',                                   'input',  20, 'standard'),
  ('2701',  'PDV 20% - INTERNI RACUN LICENCE',                'input',  20, 'standard'),
  ('2705',  'PDV 20% - INTERNI RACUN GRADJEVINARSTVO',        'input',  20, 'standard'),
  ('2710',  'PDV u primljenim fakturama 10%',                                'input',  10, 'standard'),
  ('27102', '10% Smanjenje osnovice - KO',                                   'input',  10, 'standard'),
  ('2720',  'PDV u datim avansima 20%',                                      'input',  20, 'avans'),
  ('27200', 'PDV u datim avansima 20% - ZATVARANJE AVANSA IZ PRETH.PERIODA', 'input',  20, 'avans'),
  ('27250', 'PDV 20% - INTERNI RACUN Avansi GRADJEVINARSTVO', 'input',  20, 'avans'),
  ('2730',  'PDV u datim avansima 10%',                                      'input',  10, 'avans'),
  ('2740',  'PDV plaćen pri uvozu dobara 20%',                               'input',  20, 'carinski'),
  ('2750',  'PDV plaćen pri uvozu dobara 10%',                               'input',  10, 'carinski'),
  ('2760',  'PDV obračunat na usluge inostranih lica 20%',                   'input',  20, 'standard'),
  -- ── OBAVEZA ZA PDV (izlazni PDV) — 47xx, potražuje ────────────────────────
  ('4700',  'PDV po izdatim fakturama 20%',                                  'output', 20, 'standard'),
  ('4701',  'PDV 20% na Prodate proizvode na domaćem tržištu',               'output', 20, 'standard'),
  ('4702',  'PDV 20% na Prodate robe na domaćem tržištu',                    'output', 20, 'standard'),
  ('4703',  'Obaveze za PDV - USLUGE 20%',                                   'output', 20, 'standard'),
  ('4705',  'PDV 20% INTERNI RACUN GRADJEVIN.',               'output', 20, 'standard'),
  ('4710',  'PDV po izdatim fakturama 10%',                                  'output', 10, 'standard'),
  ('4720',  'PDV po primljenim avansima 20%',                                'output', 20, 'avans'),
  ('47200', 'PDV po primljenim avansima 20% - POKRIVANJE AVANSA',            'output', 20, 'avans'),
  ('47250', 'PDV 20% - INTERNI RACUN Avansi GRADJEVINARSTVO', 'output', 20, 'avans'),
  ('4730',  'PDV po primljenim avansima 10%',                                'output', 10, 'avans'),
  ('4760',  'PDV 20% po osnovu prodaje za gotovinu',                         'output', 20, 'standard'),
  ('4761',  'PDV 10% za gotovinu',                                           'output', 10, 'standard');
