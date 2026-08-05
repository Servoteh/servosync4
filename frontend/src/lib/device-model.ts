/**
 * Model uređaja — razrešavanje i keš. **Bez ijednog importa iz drugih modula**:
 * i `barcode-decoder` (nišan-gejt po profilu) i `camera-controls` (dijagnostika,
 * auto-zoom) treba da ga čitaju, pa bi svaka zavisnost napravila ciklus.
 *
 * ZAŠTO POSTOJI: **Chrome na Androidu od v110 šalje redukovan UA**
 * (`Linux; Android 10; K`) — model se NE VIDI, pa svaki gejt po imenu modela
 * tamo tiho ne radi (registar `docs/OTVORENI_POSLOVI.md` C1; baš zato se nišan
 * gejt na A16 u Chrome-u nikad nije ni upalio). Pravi model daje asinhroni
 * `navigator.userAgentData.getHighEntropyValues(['model'])`. Rezultat se kešira
 * u modulu i greje ČIM se skener otvori, da bude spreman pre `attach`-a dekodera
 * (getUserMedia ionako traje stotinama ms).
 *
 * Samsung Internet zadržava model u UA — tamo radi i sinhroni put.
 */

let modelHint = '';
let modelHintState: 'idle' | 'pending' | 'done' = 'idle';

interface UADataLike {
  getHighEntropyValues?: (hints: string[]) => Promise<{ model?: string }>;
}

function modelFromUaString(): string {
  if (typeof navigator === 'undefined') return '';
  const u = navigator.userAgent || '';
  // Samsung Internet / stariji Chrome: `... ; SM-A165F Build/...`
  const m = /;\s*([A-Za-z0-9_.\-+ ]{2,40}?)\s*(?:Build\/|\))/.exec(u);
  const raw = (m?.[1] ?? '').trim();
  // `K` je Chrome-ov zamenski model posle UA-redukcije — nije informacija.
  if (!raw || raw === 'K' || /^Android/i.test(raw)) return '';
  return raw;
}

/** Pokreni razrešavanje modela (fire-and-forget). Zvati na otvaranju skenera. */
export function primeDeviceModelHint(): void {
  if (modelHintState !== 'idle') return;
  modelHintState = 'pending';
  const fromUa = modelFromUaString();
  if (fromUa) modelHint = fromUa;
  try {
    const uad = (navigator as unknown as { userAgentData?: UADataLike }).userAgentData;
    if (!uad?.getHighEntropyValues) {
      modelHintState = 'done';
      return;
    }
    void uad
      .getHighEntropyValues(['model'])
      .then((v) => {
        const m = String(v?.model ?? '').trim();
        if (m && m !== 'K') modelHint = m;
      })
      .catch(() => {
        /* best-effort — ostaje UA fallback */
      })
      .finally(() => {
        modelHintState = 'done';
      });
  } catch {
    modelHintState = 'done';
  }
}

/** Model uređaja ako je poznat (npr. `SM-A165F`), inače `''`. */
export function getDeviceModelHint(): string {
  return modelHint;
}
