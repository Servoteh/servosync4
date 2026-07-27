-- =============================================================================
-- ISPRAVKA REGISTRA PDV KONTA (`vat_account_map`)
-- =============================================================================
-- Nad UVEZENIM BigBit podacima (dev baza) PDV evidencija je davala besmislene
-- iznose za SVAKI zatvoren mesec 2026. Tri uzroka, dva su ovde (treći — tehnički
-- nalog zatvaranja — rešen je u kodu, vidi VAT_SETTLEMENT_ORDER_TYPE):
--
--   A) POGREŠNO MAPIRANA KONTA. `2050` je u registru vođen kao izlazni PDV po
--      stopi 0 („Kupci u inostranstvu (izvoz, 0%)"), a u kontnom planu je
--      POTRAŽIVANJE od kupaca u inostranstvu. Cela vrednost izvozne fakture je
--      zato ulazila u KIF kao NEGATIVAN PDV (03/2026: −1.236.156,30 uz osnovicu
--      0), pa je PP-PDV prijavio povraćaj 1.236.156,30 umesto 21.602.291,00.
--      Isti obrazac (mina koja još nije opalila) kod `4331` — u registru „PDV
--      nadoknada poljoprivrednicima (8%)", u kontnom planu „Dobavljači u zemlji
--      za nefakturisane obaveze" — i kod `2780` („Potraživanja za više plaćen
--      PDV po drugim osnovama"). Sva tri se BRIŠU iz registra:
--        • nijedno nije PDV konto u Servotehovom kontnom planu;
--        • BigBit-ova POPDV mapa (`popdv_account_map`, 103 mapiranja iz
--          POPDV_SemeKontaZaKnjizenje) ih NE koristi ni jednim redom;
--        • promet oslobođen PDV-a (izvoz, 0%) i nadoknada poljoprivrednicima se
--          u POPDV izvode iz PROMETNIH konta preko `popdv_account_map`, ne iz
--          PDV konta;
--        • 2050 je uz to konto potraživanja: njegov mesečni neto je „fakture
--          minus naplate", a ne promet — i u mesecu sa naplatom bi dao negativan
--          „promet". 2780/4331 nemaju promet u 2026, 2050 ima samo dugovnu stranu.
--
--   B) REGISTAR NE POKRIVA STVARNO KORIŠĆENA KONTA. BigBit koristi i podanalitike
--      promenljive dužine (27200, 47200, 4703…), a JOIN je egzaktan
--      (`vam.account = le.account_code`), pa su tiho ispadale iz knjiga — za 2026
--      npr. `27200` sa −24.791.455,02 i `47200` sa 26 stavki.
--      MERILO KOJA KONTA DODATI JE BIGBIT SAM: mesečni nalog vrste `PDV` zatvara
--      TAČNO sva PDV konta u transitno konto 2790/4790. Skup dodatih konta =
--      konta koja taj nalog zatvara (bez transitnih i bez zaokruženja 6799/5799).
--      Provera: (pretporez − obaveza) po tom skupu se poklapa sa BigBit-ovim
--      saldom 2790/4790 za svih 6 zatvorenih meseci 2026 u granici zaokruženja
--      (0,20–1,11 RSD; BigBit zaokružuje obavezu na ceo dinar i razliku knjiži
--      na 6799/5799).
--
--   C) OSNOVICA SE IZVODI ZA SVAKO PDV KONTO. Raniji nacrt ove migracije uveo je
--      zastavicu `has_base` (konto koji „nema osnovicu"), posejanu po tome da li
--      BigBit-ova POPDV mapa za taj konto ima kolonu tipa `D/0.2`. To je bio
--      POGREŠAN zaključak i naduvavao je osnovicu za stotine miliona: konto je
--      skidao PDV a nije skidao osnovicu. Izmereno na dev bazi (KIF, implicitna
--      stopa Σ PDV / Σ osnovica, mora biti između 10% i 20%):
--        02/2026 KIF  6,99%  (osnovica 308.851.171,00 uz PDV 21.575.667,23)
--        06/2026 KIF  8,57%   ·  07/2026 KIF  8,97%  ·  05/2026 KIF 14,26%
--        03/2026 KUF 13,79%   ·  04/2026 KUF 16,03%
--      Uzrok: 27200/47200 („zatvaranje/pokrivanje avansa") i 2701/2705/4705/
--      27250/47250 („interni račun") su STVARNE korekcije PDV-a po poznatoj stopi
--      20% — storniranje avansa i interni obračun (obrnuto zaduženje) imaju svoju
--      osnovicu, samo je sa suprotnim znakom odn. na obe strane. Kolona se UKIDA;
--      posle toga je implicitna stopa 19,92–20,00% u svih 14 knjiga 2026. Nova
--      provera `P5` u `vat-sanity.ts` čuva da se greška ne vrati.
--
-- NAMERNO NIJE DODATO:
--   • 2790 / 4790 (transitna konta prema PU) — nisu ni pretporez ni obaveza nego
--     REZULTAT obračuna; ostaju van registra jer su kontrolna tačka provere
--     ispravnosti (`vat-sanity.ts`).
--   • 2704 / 2714 / 2721 („PDV prethodni koji se ne može koristiti", „nepriznat")
--     — nalog vrste `PDV` ih NE zatvara, dakle BigBit ih ne broji u pretporez.
--     Njih preknjižava nalog vrste `BPDV` (183–267 stavki mesečno) na trošak.
--     Da su u registru, BPDV bi počeo da uvlači stotine stavki u KIF/KUF i
--     tražio bi isti tretman kao nalog `PDV` — nova varijanta iste greške u
--     modulu koji je tek popravljen. Vidljivi su preko `popdv_account_map`
--     (oznake 8а.2NE / 8а.7NE = „ne priznaje se").
--
-- Idempotentno (dev + prod). PAZI PRE PRODA: izmena registra retroaktivno menja
-- svaki VEĆ izračunat period — proveri da nema `vat_returns` u statusu POSTED.
-- =============================================================================

-- ── 1) ukloni zastavicu „konto bez osnovice" (uzrok C) ───────────────────────
-- IF EXISTS: na produ kolone nema (ova migracija se tamo pušta prvi put), na dev
-- bazi je nastala ranijim ručnim prolazom istog fajla i mora da nestane.
ALTER TABLE "vat_account_map" DROP COLUMN IF EXISTS "has_base";

-- ── 2) izbaci konta koja NISU PDV konta ──────────────────────────────────────
DELETE FROM "vat_account_map" WHERE "account" IN ('2050', '4331', '2780');

-- ── 3) upiši/ispravi PDV konta ───────────────────────────────────────────────
-- `name` se usklađuje sa KONTNIM PLANOM (`accounts.name`) — nesklad imena je bio
-- jedini vidljiv trag oba pogrešna mapiranja, pa mora ostati proverljiv.
INSERT INTO "vat_account_map" (account, name, direction, rate, role) VALUES
  -- ── PRETPOREZ (ulazni PDV) — 27xx, duguje ─────────────────────────────────
  ('2700',  'PDV u primljenim fakturama 20%',                                        'input',  20, 'standard'),
  ('27001', '20% Povećanje osnovice - KZ',                                           'input',  20, 'standard'),
  ('27002', '20% Smanjenje osnovice - KO',                                           'input',  20, 'standard'),
  ('2701',  'PDV 20% - INTERNI RACUN LICENCE',                        'input',  20, 'standard'),
  ('2705',  'PDV 20% - INTERNI RACUN GRADJEVINARSTVO',                'input',  20, 'standard'),
  ('2710',  'PDV u primljenim fakturama 10%',                                        'input',  10, 'standard'),
  ('27102', '10% Smanjenje osnovice - KO',                                           'input',  10, 'standard'),
  ('2720',  'PDV u datim avansima 20%',                                              'input',  20, 'avans'),
  ('27200', 'PDV u datim avansima 20% - ZATVARANJE AVANSA IZ PRETH.PERIODA',         'input',  20, 'avans'),
  ('27250', 'PDV 20% - INTERNI RACUN Avansi GRADJEVINARSTVO',         'input',  20, 'avans'),
  ('2730',  'PDV u datim avansima 10%',                                              'input',  10, 'avans'),
  ('2740',  'PDV plaćen pri uvozu dobara 20%',                                       'input',  20, 'carinski'),
  ('2750',  'PDV plaćen pri uvozu dobara 10%',                                       'input',  10, 'carinski'),
  ('2760',  'PDV obračunat na usluge inostranih lica 20%',                           'input',  20, 'standard'),
  -- ── OBAVEZA ZA PDV (izlazni PDV) — 47xx, potražuje ────────────────────────
  ('4700',  'PDV po izdatim fakturama 20%',                                          'output', 20, 'standard'),
  ('4701',  'PDV 20% na Prodate proizvode na domaćem tržištu',                       'output', 20, 'standard'),
  ('4702',  'PDV 20% na Prodate robe na domaćem tržištu',                            'output', 20, 'standard'),
  ('4703',  'Obaveze za PDV - USLUGE 20%',                                           'output', 20, 'standard'),
  ('4705',  'PDV 20% INTERNI RACUN GRADJEVIN.',                       'output', 20, 'standard'),
  ('4710',  'PDV po izdatim fakturama 10%',                                          'output', 10, 'standard'),
  ('4720',  'PDV po primljenim avansima 20%',                                        'output', 20, 'avans'),
  ('47200', 'PDV po primljenim avansima 20% - POKRIVANJE AVANSA',                    'output', 20, 'avans'),
  ('47250', 'PDV 20% - INTERNI RACUN Avansi GRADJEVINARSTVO',         'output', 20, 'avans'),
  ('4730',  'PDV po primljenim avansima 10%',                                        'output', 10, 'avans'),
  ('4760',  'PDV 20% po osnovu prodaje za gotovinu',                                 'output', 20, 'standard'),
  ('4761',  'PDV 10% za gotovinu',                                                   'output', 10, 'standard')
ON CONFLICT (account) DO UPDATE SET
  name      = EXCLUDED.name,
  direction = EXCLUDED.direction,
  rate      = EXCLUDED.rate,
  role      = EXCLUDED.role;
