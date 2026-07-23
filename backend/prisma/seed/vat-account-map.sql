-- PDV konto→uloga mapiranje (Was: PDV_SemeKontaZaKnjizenje.csv, BB_T_26).
-- KOREN celog PDV modula: bez ovoga KIF/KUF/POPDV vraćaju NULU (vat-ledger puni
-- knjige iz ledger_entries preko ovog registra po direction+rate).
--   • 27xx = pretporez (ulazni PDV)  → direction='input'
--   • 47xx = obaveza za PDV (izlazni) → direction='output'
--   • 2050 = izvoz (0% izlazni promet)
--   • 4331 = PDV nadoknada poljoprivrednicima (8%)
-- rate: nominalna stopa (20/10/8/0). role: standard | avans | carinski | transit.
-- Izvor: _legacy/.../BB_T_26/PDV_SemeKontaZaKnjizenje.csv. Idempotentan seed (dev/prod).
TRUNCATE vat_account_map;

INSERT INTO public.vat_account_map (account, name, direction, rate, role) VALUES
  -- Pretporez (ulazni PDV) — 27xx
  ('2700', 'Pretporez po ulaznim fakturama (opšta 20%)',        'input',  20, 'standard'),
  ('2701', 'Pretporez po ulaznim fakturama (opšta 20%)',        'input',  20, 'standard'),
  ('2705', 'Pretporez interni obračun (opšta 20%)',             'input',  20, 'standard'),
  ('2710', 'Pretporez po ulaznim fakturama (posebna 10%)',      'input',  10, 'standard'),
  ('2720', 'Pretporez interni obračun DATAVAN (20%)',           'input',  20, 'standard'),
  ('2730', 'Pretporez interni obračun DATAVAN (10%)',           'input',  10, 'standard'),
  ('2740', 'Pretporez pri uvozu (20%)',                         'input',  20, 'carinski'),
  ('2750', 'Pretporez pri uvozu (10%)',                         'input',  10, 'carinski'),
  ('2760', 'Pretporez po ulaznim fakturama (20%)',              'input',  20, 'standard'),
  ('2780', 'Pretporez PDV nadoknada poljoprivrednicima (8%)',   'input',   8, 'standard'),
  -- Obaveza za PDV (izlazni PDV) — 47xx + izvoz + poljo
  ('2050', 'Kupci u inostranstvu (izvoz, 0%)',                  'output',  0, 'standard'),
  ('4331', 'PDV nadoknada poljoprivrednicima (8%)',             'output',  8, 'standard'),
  ('4700', 'Obaveza za PDV po izlaznim fakturama (opšta 20%)',  'output', 20, 'standard'),
  ('4701', 'Obaveza za PDV interni obračun (20%)',              'output', 20, 'standard'),
  ('4702', 'Obaveza za PDV interni obračun (20%)',              'output', 20, 'standard'),
  ('4710', 'Obaveza za PDV po izlaznim fakturama (posebna 10%)','output', 10, 'standard'),
  ('4720', 'Obaveza za PDV po avansima (opšta 20%)',            'output', 20, 'avans'),
  ('4730', 'Obaveza za PDV po avansima (posebna 10%)',          'output', 10, 'avans'),
  ('4760', 'Obaveza za PDV po izlaznim fakturama (20%)',        'output', 20, 'standard'),
  ('4761', 'Obaveza za PDV po izlaznim fakturama (10%)',        'output', 10, 'standard');
