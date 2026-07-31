# Analiza: zašto 3.0 skener ne radi na Samsungu (Chrome/Firefox) — i popravka

**Datum:** 31.07.2026 · **Analiza:** Fable · **Izmene:** Opus (grana `fix/skener-android`)
**Simptom (Nenad):** na Samsung telefonu u Chrome/Firefox 3.0 sken ne radi ili retko radi,
dok 1.0 radi pouzdano.

## 1. Dijagnoza — tri uzroka, po težini

### 1.1 GLAVNI: 3.0 je verovao `BarcodeDetector`-u na Androidu, 1.0 namerno NE

- 3.0 engine (`frontend/src/lib/barcode-decoder.ts`) je birao **BarcodeDetector-first svuda
  gde API postoji** (ceo Chromium, dakle i Android Chrome i Samsung Internet).
- `BarcodeDetector` na Androidu **delegira na Google Play Services barcode modul**. Na mnogim
  uređajima (posebno Samsung) taj modul fali ili ne radi → API postoji, konstruktor uspe, a
  `detect()` **zauvek vraća prazno ili baca** („Barcode detection service unavailable").
  3.0 je tu grešku gutao u `catch {}` kao „prazan frejm" → kamera radi, sken nikad.
- **1.0 je ovo naučio na terenu**: commit `3cffea5` — na Android web-u **default je ZXing**,
  BarcodeDetector je samo eksplicitni opt-in (koristi ga jedino 1.0 Reversi ekran).
  Odluka je izdvojena u čistu funkciju `shouldUseBarcodeDetector()` (barcode.js:415-428).
- Zašto je 1.0 „radio na Samsungu": u APK-u koristi **native MLKit** (nema veze sa BD API-jem),
  a u browseru **ZXing** — nikad pokvareni BD put.

### 1.2 Firefox: ZXing bez Android štelovanja

Firefox nema `BarcodeDetector`, pa je 3.0 tu već išao na ZXing — ali bez dela 1.0 recepta
u prostijim ljuskama (bez pauza/retry-ja za kameru, bez anti-glare/AF podešavanja), i uz
kašnjenje ZXing chunk-a (~250KB) koji se učitavao tek posle starta kamere.

### 1.3 Pogrešno sočivo na multi-lens Samsungima

`facingMode:'environment'` na Samsung A-seriji vraća **bilo koji** od 2–4 zadnja objektiva —
često macro sa fiksnim fokusom ~3cm („preview radi, kod se nikad ne dekodira"). 1.0 ima
`cameraPicker.js`: capability-probe svih zadnjih kamera + skoring (torch +3, continuous/auto
fokus +2, focusDistance>5 +2, macro/kvadratni-2MP −2…) + 30-dnevni keš + ručni override.
3.0 glavna ljuska je imala samo REAKTIVNU heuristiku (beg sa očigledno lošeg sočiva),
bez proaktivnog izbora najboljeg.

## 2. Šta je 3.0 VEĆ imao dobro (gap-scan svih ljuski, 31.07)

Glavna ljuska (`lokacije/_components/scan-overlay.tsx`) je solidan port 1.0: rezolucija
1080p Android / 2880×1620 iOS-item ✓, anti-glare −0.45 + AF logika ✓, `safeApplyFlat`
Android redosled ✓, visualViewport rebind ✓, tap-to-focus sa object-fit kompenzacijom ✓,
SI/iOS pauze ✓, minify-safe miss klasifikacija ✓, dedup (dizajnski drugačiji, svesno) ✓.
Prostije ljuske (maint, reversi) — samo osnovni put, bez Android štelovanja.

## 3. Popravka (sve SAMO u 3.0; 1.0 netaknut)

### 3.1 Engine `barcode-decoder.ts`

1. **`shouldUseNativeDetector()`** — 1.0 kanon: Android web → **ZXing default**;
   BarcodeDetector ostaje na desktop Chromium-u + debug override.
2. **BD sanity + watchdog** (rupa i u 1.0): `getSupportedFormats()` prazan → preskoči BD;
   u petlji `detect()` greške se BROJE (nisu „prazan kadar") → posle 10 uzastopnih vrući
   prelaz na ZXing bez restarta kamere/ljuske.
3. **Debug prekidač** `sessionStorage.ss3_scan_decode_mode` ∈ auto|zxing|native
   (port 1.0 terenske alatke `loc_scan_decode_mode`).
4. Novi exporti za ljuske: `applyAndroidPostStartTuning` (anti-glare + AF, NE dira Samsung
   smart AF — 1.0 revert `e126868`), `safeApplyFlatCompat` (Android-first `{advanced:[…]}`),
   `cameraCooldownMs` (SI 450ms / iOS 180ms), `preloadVideoDecoder` (greje ZXing chunk pre
   otvaranja overlay-a — bitno sad kad Android ide na ZXing).
5. iPhone putevi (24.07 fix) — **netaknuti**.

### 3.2 Nov `camera-picker.ts` (port 1.0 `cameraPicker.js`)

Proaktivni izbor GLAVNE zadnje kamere: probe+skoring svih zadnjih sočiva, keš 30 dana
(`ss3_scan_camera_v1`), manual override nadjačava auto. Samo Android web; 1 zadnja kamera →
`facingMode` je dovoljan.

### 3.3 Ljuske

- **lokacije scan-overlay** (koristi i mob/lokacije + batch): picker za prvi izbor sočiva
  (lokalni keš/ručni cycle zadržavaju prednost), 700ms retry na `NotReadableError`/`AbortError`
  (2× na SI), dupli-rAF posle release-a, refocus posle zoom-a (Android Chrome), webkit-playsinline,
  preload dekodera.
- **maint-scan-overlay** (mob/održavanje) i **reversi scan-overlay**: cooldown pauza + retry,
  picker, `applyAndroidPostStartTuning`, JS asercija video atributa, pagehide/visibility cleanup,
  preload.
- **kiosk-punch-scanner**: NAMERNO netaknut (fiksni tablet, front kamera, kritičan za prisustvo).

## 4. Šta NIJE preneto (svesno)

- 1.0 fiksni dedup prozor (3.0 ima bolji „kod napustio kadar" re-arm dizajn).
- Tajmirane hint poruke (8s saveti) — nice-to-have, van obima.
- ROI/downscale za živi ZXing — ni 1.0 ga nema (dekodira pun frejm); ne izmišljamo.
- 1.0 „mrtve" grane (`getScanDecodeMode` mode promenljiva).

## 4a. Adversarialna revizija (3 sočiva, 31.07) — nalazi i presude

Paket je pre slanja oboren kroz 3 nezavisna skeptika (iOS regresija · Android korektnost
vs 1.0 izvor · React/TS higijena). **iPhone putevi od 24.07: potvrđeno netaknuti** (refaktor
ZXing puta bit-po-bit identičan, hibrid/konstraints/picker-gejt čisti). Ispravljeno pre
merge-a (krug F1–F7):

1. **F1 VISOKO**: novi `visibility→release()` u maint/reversi bez resume-a — svaki
   app-switch (na reversi čak i „Slikaj barkod" file picker!) ostavljao trajno crn skener.
   → restart na povratak u 'visible' + generation guard (obara i start-u-letu rupu).
2. **F2**: lokacije retry „krao generaciju" (`startSeq = decoderSeq` bezuslovno) — stariji
   prekinuti start mogao da otme kameru novijem (📷 cikl). → aborted() discipline.
3. **F3**: BD watchdog swap bez re-provere posle await-a → orphan ZXing petlja. → re-check + stop.
4. **F4**: Android je prelaskom na ZXing gubio 30.07 N3 fix (naslagani `S:` barkodovi na
   štampanom RN-u). → `preferMatching` kao meki filter na ZXing putu (400ms held+fallback).
5. **F5**: picker hardening — SI cooldown između probe-ova, retry na tranzijentnu grešku,
   bez keša na nepotpun uzorak (rizik: pogrešno sočivo keširano 30 dana!), `settings.torch`
   signal, diskvalifikacija front kamere bez labele, negativan keš (bez pun-probe na svako
   otvaranje), most sa zatečenim ručnim izborom.
6. **F6**: 1.0 kanon je PER-PROFIL — 1.0 Reversi eksplicitno bira BarcodeDetector za gust 1D
   (scanOverlay.js:431). → `preferNative` flag; sada bezbedan jer sanity+watchdog pokrivaju
   mrtav GmsCore.
7. **F7**: refocus i posle POČETNOG auto-zoom 2× (ne samo ručnog).

**Svesno prihvaćeno (bez izmene):** item suženje formata na CODE_128+39 (1.0 kanon; „Iz
slike" čita pun set); „večno prazan detect()" watchdog ne pokriva (nerazlučivo od praznog
kadra — native je sada samo desktop/debug); tajmirane hint poruke (van obima).

## 5. Test lista (Nenad — Samsung)

1. Chrome na Samsungu: `/mob/lokacije` → SKENIRAJ DEO → Code128 nalepnica (folija!) —
   mora da dekodira u par sekundi; proba i „Gde je deo?".
2. Firefox na Samsungu: isto.
3. Samsung Internet (ako se koristi): isto + drugi sken u istoj sesiji (cooldown/retry).
4. `/mob/odrzavanje` QR kartona; `/mob/lokacije/batch` kontinuirani sken 3+ dela.
5. Više-sočivni telefon: prvi start može ~1-2s duže (probe sočiva — jednom, pa keš 30d);
   proveri da je izabran glavni objektiv (slika oštra na 10-20cm). 📷 cikl i dalje radi.
6. iPhone kontrola (regresija): sken mora raditi kao pre (putevi netaknuti).
7. Teren debug: u konzoli `sessionStorage.setItem('ss3_scan_decode_mode','native')` vraća
   staro ponašanje za poređenje; `'zxing'` forsira novi put i na desktopu.
