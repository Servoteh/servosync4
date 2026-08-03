-- POŠTANSKI BROJ FIRME DOBIJA SVOJU KOLONU (odluka O-F10, 03.08.2026).
-- Povod: backend/docs/STAMPA_FAKTURA_ODLUKE.md, odluka O-F10.
--
-- ZATEČENO STANJE: `companies.city` je držao DVA podatka u jednom stringu
-- („11272 Dobanovci"), pa se poštanski broj provlačio i tamo gde mu na papiru nije
-- mesto. Izmereno nad donetim BigBit obrascima (docs/zahtevi/fakture-obrasci-2026-08/):
--   • memorandum strane                → „Ugrinovačka 163, 11272 Dobanovci"  (broj TREBA)
--   • potpisni blok „Preuzeo za prevoz" → „Dobanovci, Ugrinovačka 163"        (broj NE)
--   • adresa magacina „Robu izdao"      → „Ugrinovačka 163, Dobanovci"        (broj NE)
-- Dok je poštanski broj deo mesta, druga dva bloka ga ne mogu izbaciti — pa je papir
-- odstupao od originala na svakoj fakturi za robu. Kupci (`customers.postal_code`) tu
-- kolonu imaju od početka; firma-izdavalac je jedina bila bez nje.
--
-- ⚠️ BEZ PL/pgSQL BLOKA I BEZ IJEDNOG `IF EXISTS ... AND ...` NAD SAMOM KOLONOM.
-- Dan ranije je takav uslov (`20260802120000_datum_prometa_znacenje`) oborio SVE backend
-- deploy-e sa `42703`: PL/pgSQL ceo `IF` sprema kao jedan upit, pa nema kratkog spoja.
-- Ovde toga nema — `ADD COLUMN IF NOT EXISTS` je idempotentan sam po sebi, a `UPDATE`
-- se izvršava tek POSLE njega, kada kolona sigurno postoji.

ALTER TABLE "companies"
  ADD COLUMN IF NOT EXISTS "postal_code" VARCHAR(10);

-- ── Prenos zatečenog podatka iz `city` — NAMERNO PLAŠLJIV ────────────────────
-- Hvata se ISKLJUČIVO oblik „5 cifara + razmak + ostatak" („11272 Dobanovci"), jer je
-- to jedini oblik za koji se sa sigurnošću zna šta je poštanski broj a šta mesto.
-- Sve ostalo (samo mesto, „Beograd 11000", strani formati, prazno) ostaje NETAKNUTO:
-- pogrešno rastavljeno mesto štampa se na svakom papiru i niko ga ne bi primetio.
--
-- Idempotentno bez dodatnih provera: posle jednog prolaza `city` više ne počinje
-- poštanskim brojem, pa uslov `WHERE` nikad ne uhvati isti red dvaput. Uslov
-- `postal_code IS NULL` uz to čuva ručno unetu vrednost — nikad je ne prepisuje.
-- Na praznoj tabeli (svež slog) `UPDATE` prosto ne pogodi nijedan red.
UPDATE "companies"
   SET "postal_code" = substring("city" from '^([0-9]{5})'),
       "city"        = btrim(substring("city" from '^[0-9]{5}[[:space:]]+(.*)$'))
 WHERE "postal_code" IS NULL
   AND "city" ~ '^[0-9]{5}[[:space:]]+[^[:space:]]';
