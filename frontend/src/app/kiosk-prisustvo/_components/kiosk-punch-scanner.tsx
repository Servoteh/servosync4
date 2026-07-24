'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { kioskPunch, isKioskPunchConfigured, type KioskPunchResult } from '@/lib/kiosk-punch';
import {
  attachVideoDecoder,
  buildVideoConstraints,
  isCameraDecodeSupported,
  isIOSWebKit,
  type VideoDecoderHandle,
} from '@/lib/barcode-decoder';

const LS_KEY = 'servosync_kiosk_key';

const ERR_LABELS: Record<string, string> = {
  nepoznat_qr: 'QR kôd nije prepoznat',
  neaktivan_zaposleni: 'Zaposleni nije aktivan',
  unauthorized: 'Uređaj nije autorizovan (pogrešan ključ)',
  kiosk_key_not_set: 'Kiosk nije podešen na serveru',
  not_configured: 'Kiosk-punch adresa nije podešena (config.js)',
  mreza: 'Nema veze sa serverom',
  bad_token: 'Neispravan kôd',
  bad_response: 'Neispravan odgovor servera',
  rpc_failed: 'Greška servera, pokušajte ponovo',
};

export function KioskPunchScanner() {
  const [deviceKey, setDeviceKey] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      setDeviceKey(localStorage.getItem(LS_KEY));
    } catch {
      setDeviceKey(null);
    }
    setReady(true);
  }, []);

  if (!ready) return <div className="fixed inset-0 bg-[#0b0f17]" />;
  if (!deviceKey) return <SetupScreen onSaved={setDeviceKey} />;
  return <Scanner deviceKey={deviceKey} onReset={() => setDeviceKey(null)} />;
}

/* ------------------------- SETUP (unos device key) ------------------------- */
function SetupScreen({ onSaved }: { onSaved: (key: string) => void }) {
  const [value, setValue] = useState('');
  const [err, setErr] = useState('');

  function save() {
    const v = value.trim();
    if (v.length < 6) {
      setErr('Ključ je prekratak.');
      return;
    }
    try {
      localStorage.setItem(LS_KEY, v);
    } catch {
      /* ignore */
    }
    onSaved(v);
  }

  return (
    <div className="fixed inset-0 grid place-items-center bg-[#0b0f17] p-4 text-white">
      <div className="w-full max-w-md rounded-2xl border border-[#263149] bg-[#131a26] p-8 text-center">
        <div className="mb-4 text-xs tracking-[0.2em] text-white/50">SERVOSYNC · KIOSK PRISUSTVA</div>
        <h2 className="mb-2 text-xl font-semibold">Podešavanje uređaja</h2>
        <p className="mb-5 text-sm text-white/60">
          Unesite ključ kioska (dobijate ga od administratora). Čuva se samo na ovom tabletu.
        </p>
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && save()}
          placeholder="Ključ kioska"
          autoComplete="off"
          autoFocus
          className="mb-3 w-full rounded-lg border border-[#33405c] bg-[#0b0f17] px-4 py-3 text-white outline-none focus:border-[#2f6bff]"
        />
        <button onClick={save} className="w-full rounded-lg bg-[#2f6bff] px-4 py-3 font-semibold text-white">
          Sačuvaj i pokreni
        </button>
        {err && <div className="mt-3 text-sm text-[#ff8a8a]">{err}</div>}
        {!isKioskPunchConfigured() && (
          <div className="mt-4 text-xs text-[#ffcf8a]">
            Napomena: kiosk-punch adresa nije podešena — postavi <code>__SERVOSYNC_KIOSK_PUNCH_URL__</code> u config.js.
          </div>
        )}
      </div>
    </div>
  );
}

/* --------------------------- SKENER + POTVRDA ------------------------------ */
function Scanner({ deviceKey, onReset }: { deviceKey: string; onReset: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const busyRef = useRef(false);
  const lastRef = useRef<{ token: string; at: number }>({ token: '', at: 0 });
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [hint, setHint] = useState('Prislonite svoj QR kôd na kameru');
  const [manual, setManual] = useState('');
  const [result, setResult] = useState<{ status: number; data: KioskPunchResult } | null>(null);
  const [clock, setClock] = useState('');

  // Veliki sat.
  useEffect(() => {
    const tick = () => {
      const d = new Date();
      const p = (n: number) => String(n).padStart(2, '0');
      setClock(`${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  const showResult = useCallback((data: KioskPunchResult) => {
    setResult({ status: data.ok ? 200 : 0, data });
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setResult(null), 3200);
  }, []);

  const onScan = useCallback(
    async (raw: string) => {
      const token = (raw || '').replace(/[\r\n\t*]/g, '').trim();
      if (!token) return;
      const now = Date.now();
      // Klijentski dedup: isti kôd u <4 s = isti scan (DB ima svoj 30 s dedup).
      if (token === lastRef.current.token && now - lastRef.current.at < 4000) return;
      if (busyRef.current) return;
      lastRef.current = { token, at: now };
      busyRef.current = true;
      try {
        const data = await kioskPunch(token, deviceKey);
        navigator.vibrate?.(data.ok ? 80 : [60, 40, 60]);
        showResult(data);
      } finally {
        busyRef.current = false;
      }
    },
    [deviceKey, showResult],
  );

  // Kamera + detekcija — decode-engine (BarcodeDetector/ZXing/jsQR; radi i na
  // iPhone/iPad kiosku). Gejt je getUserMedia, ne BarcodeDetector (1.0 lekcija).
  useEffect(() => {
    if (!isCameraDecodeSupported()) {
      setHint('Kamera nije dostupna u ovom pregledaču (getUserMedia/HTTPS) — koristi ručni/HID unos ispod.');
      return;
    }
    let stopped = false;
    let decoder: VideoDecoderHandle | null = null;
    (async () => {
      try {
        // Rezolucija (1.0 lekcija): default preset ume da bude 640×480 — QR radi
        // tesno; 1080p daje jsQR/detektoru marginu i na iPad kiosku.
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { ...buildVideoConstraints('mixed'), facingMode: 'user' },
        });
        if (stopped) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const v = videoRef.current;
        if (!v) return;
        v.srcObject = stream;
        await v.play();
        const handle = await attachVideoDecoder({
          video: v,
          formats: ['qr_code'],
          onRaw: (raw) => void onScan(raw),
          isStopped: () => stopped,
        });
        if (stopped) handle.stop();
        else decoder = handle;
      } catch {
        setHint('Kamera nije dostupna — dozvoli pristup ili koristi ručni/HID unos ispod.');
      }
    })();
    return () => {
      stopped = true;
      try {
        decoder?.stop();
      } catch {
        /* ignore */
      }
      // iOS release higijena (1.0): pause → stop → srcObject null.
      if (isIOSWebKit()) {
        try {
          videoRef.current?.pause();
        } catch {
          /* ignore */
        }
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      try {
        if (videoRef.current) {
          videoRef.current.srcObject = null;
          videoRef.current.load();
        }
      } catch {
        /* ignore */
      }
    };
  }, [onScan]);

  useEffect(() => {
    return () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    };
  }, []);

  function handleReset() {
    if (!confirm('Otvoriti podešavanja kioska? (potreban ključ)')) return;
    try {
      localStorage.removeItem(LS_KEY);
    } catch {
      /* ignore */
    }
    onReset();
  }

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#0b0f17] text-white">
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video ref={videoRef} playsInline autoPlay muted className="absolute inset-0 h-full w-full object-cover" />

      {/* Reticle + sat + hint. */}
      <div className="pointer-events-none absolute inset-0">
        <div
          className="absolute left-1/2 top-[44%] -translate-x-1/2 -translate-y-1/2 rounded-[28px] border-[3px] border-white/85"
          style={{ width: 'min(56vw,56vh)', height: 'min(56vw,56vh)', boxShadow: '0 0 0 4000px rgba(0,0,0,.35)' }}
        />
        <div className="absolute left-0 right-0 top-6 text-center text-4xl font-bold tabular-nums tracking-widest drop-shadow-lg sm:text-6xl">
          {clock}
        </div>
        <div className="absolute inset-x-0 bottom-[7%] text-center text-lg drop-shadow-lg sm:text-2xl">{hint}</div>
      </div>

      {/* Ručni/HID unos (fallback). */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (manual.trim()) {
            void onScan(manual);
            setManual('');
          }
        }}
        className="absolute bottom-4 left-1/2 flex w-[min(92vw,520px)] -translate-x-1/2 gap-2"
      >
        <input
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          placeholder="Ručni unos / HID čitač → Enter"
          className="flex-1 rounded-lg border border-white/25 bg-black/50 px-3 py-2 text-sm text-white outline-none placeholder:text-white/40 focus:border-white"
        />
        <button type="submit" className="rounded-lg bg-[#2f6bff] px-4 py-2 text-sm font-medium text-white">
          Pošalji
        </button>
      </form>

      <button
        onClick={handleReset}
        title="Podešavanja"
        className="absolute right-3 top-3 grid h-11 w-11 place-items-center rounded-full bg-white/10 text-xl text-white"
      >
        ⚙
      </button>

      {result && <ResultOverlay result={result.data} />}
    </div>
  );
}

/* --------------------------- POTVRDA (overlay) ----------------------------- */
function ResultOverlay({ result }: { result: KioskPunchResult }) {
  if (result.ok) {
    const dirIn = result.direction === 'in';
    return (
      <div
        className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 text-center"
        style={{ background: dirIn ? 'rgba(22,120,60,.94)' : 'rgba(30,64,140,.94)' }}
      >
        <div className="text-[clamp(90px,22vw,220px)] font-extrabold leading-none">{dirIn ? '→' : '←'}</div>
        <div className="px-4 text-[clamp(28px,6vw,64px)] font-bold">{result.employee_name || ''}</div>
        <div className="text-[clamp(20px,4vw,40px)] tracking-widest opacity-95">
          {dirIn ? 'ULAZ' : 'IZLAZ'} · {result.time || ''}
        </div>
        {result.duplicate && <div className="text-[clamp(14px,2.5vw,22px)] opacity-80">već zabeleženo</div>}
      </div>
    );
  }
  return (
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 text-center" style={{ background: 'rgba(150,30,30,.95)' }}>
      <div className="text-[clamp(90px,22vw,220px)] font-extrabold leading-none">✕</div>
      <div className="text-[clamp(20px,4vw,40px)] tracking-wide">{ERR_LABELS[result.error ?? ''] || 'Greška, pokušajte ponovo'}</div>
    </div>
  );
}
