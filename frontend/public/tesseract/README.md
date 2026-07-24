# Self-host tesseract.js asseti (OCR nalepnica)

Ovi fajlovi su **vendorovani** (kopije iz `node_modules` + tessdata), ne uređuju se ručno.
Služe OCR-u nalepnice u Lokacijama (`frontend/src/lib/label-ocr.ts` → `localTesseractOptions`,
dugme „OCR tekst" u skener overlay-u). Bez njih `tesseract.js@5` vuče ~11 MB sa
`cdn.jsdelivr.net` pri prvom OCR-u → **pada na LAN-u / offline i pod on-prem CSP-om**
(paritet-gap `LOKACIJE-01`).

Verzija: **tesseract.js 5.1.1** (i `tesseract.js-core` 5.1.1, povučen kao njegova zavisnost).

## Poreklo fajlova

| Fajl | Veličina | Poreklo |
|---|---|---|
| `worker.min.js` | 123.724 B | `node_modules/tesseract.js/dist/worker.min.js` |
| `tesseract-core-simd.wasm.js` | 4.735.153 B | `node_modules/tesseract.js-core/` — SIMD build; wasm je **embed-ovan** (base64), zaseban `.wasm` NIJE potreban |
| `tesseract-core.wasm.js` | 4.734.777 B | `node_modules/tesseract.js-core/` — ne-SIMD fallback (stariji uređaji) |
| `eng.traineddata.gz` | 1.976.293 B | `tessdata_fast` `eng.traineddata` (4.113.088 B) sa `tesseract-ocr/tessdata_fast@main`, pa `gzip -9 -n` |

`langPath` je **direktorijum** (`/tesseract`), a `gzip` je `true` po defaultu — zato fajl mora
da se zove tačno `eng.traineddata.gz`. SIMD vs ne-SIMD core bira se u runtime-u
(`wasmSimdSupported()` u `label-ocr.ts`).

## ⚠️ Asseti MORAJU pratiti verziju iz package.json

`frontend/package.json` drži **egzaktan pin** (`"tesseract.js": "5.1.1"`, bez `^`) baš zato što
worker/core moraju biti iz **iste** verzije kao biblioteka — nepodudarne verzije daju tihi pad
OCR-a u runtime-u (worker protokol i `TesseractCore` global se menjaju između major/minor izdanja).
**Kad god se `tesseract.js` u `package.json` podigne, OBAVEZNO re-vendoruj sve fajlove ispod**
(i ovde ažuriraj verziju + veličine).

## Re-vendorovanje (iz `frontend/`)

```bash
# 1) worker + oba core-a iz node_modules (posle npm ci sa novom verzijom)
cp node_modules/tesseract.js/dist/worker.min.js            public/tesseract/worker.min.js
cp node_modules/tesseract.js-core/tesseract-core-simd.wasm.js public/tesseract/tesseract-core-simd.wasm.js
cp node_modules/tesseract.js-core/tesseract-core.wasm.js      public/tesseract/tesseract-core.wasm.js

# 2) jezički model — tessdata_fast (NE „4.0.0" sa @tesseract.js-data: to je ~10,9 MB gz)
curl -fsSL -o /tmp/eng_fast.traineddata \
  "https://cdn.jsdelivr.net/gh/tesseract-ocr/tessdata_fast@main/eng.traineddata"
gzip -9 -n -c /tmp/eng_fast.traineddata > public/tesseract/eng.traineddata.gz

# 3) provera
gzip -t public/tesseract/eng.traineddata.gz && ls -l public/tesseract/
```

`-n` (bez imena/timestampa u gzip zaglavlju) drži artefakt determinističkim između re-vendorovanja.

## Ograničenja

- Svaki fajl mora ostati **< 25 MiB** (Cloudflare Pages limit po assetu).
- `public/` se kopira u `out/` pri `npm run build` (static export) — asseti se serviraju
  sa `/tesseract/...` na istom origin-u.
- `.gitattributes` u ovom folderu drži fajlove kao `binary` (bez EOL normalizacije i diff-a).
