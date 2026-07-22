'use client';

import { useEffect, useRef, useState } from 'react';
import { Mic, Square, Trash2 } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * `audio-recorder` (DESIGN_SYSTEM §10 kit; MODULE_SPEC_zahtevi §5) — snimanje
 * glasovne poruke kao PRILOGA (razlika od `DictateButton` iz voice-controls, koji
 * diktira u polje i ne čuva audio). MediaRecorder → `Blob` (webm), preview kroz
 * `<audio controls>`, prikaz trajanja. Graceful kad `getUserMedia` nije dostupan
 * (nema mikrofona / odbijena dozvola / nesiguran kontekst): dugme se onemogući uz
 * poruku, nikad ne baca.
 *
 * Kontrolisan: `value` je snimljeni Blob (ili null), `onChange` emituje promenu.
 * Snimanje ZAMENJUJE prethodni snimak (jedan recorder = jedan snimak); više audio
 * poruka = više instanci ili upload kroz `attachment-input`.
 */
export function AudioRecorder({
  value,
  onChange,
  disabled,
  className,
}: {
  value: Blob | null;
  onChange: (blob: Blob | null) => void;
  disabled?: boolean;
  className?: string;
}) {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Preview URL prati `value` (revoke na promenu/unmount da ne curi memorija).
  useEffect(() => {
    if (!value) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(value);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [value]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      recRef.current?.stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const supported =
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== 'undefined';

  async function start() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        if (timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }
        setRecording(false);
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' });
        if (blob.size < 200) {
          onChange(null);
          return;
        }
        onChange(blob);
      };
      rec.start();
      recRef.current = rec;
      setRecording(true);
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);
    } catch {
      setError('Mikrofon nije dostupan (dozvola odbijena ili nema uređaja).');
    }
  }

  function stop() {
    recRef.current?.stop();
    recRef.current = null;
  }

  function clear() {
    onChange(null);
    setElapsed(0);
  }

  function fmt(sec: number): string {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  if (!supported) {
    return (
      <p className={cn('text-xs text-ink-secondary', className)}>
        Snimanje glasa nije dostupno na ovom uređaju/pregledaču. Koristite dugme
        „Dodaj prilog" za audio fajl.
      </p>
    );
  }

  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex items-center gap-3">
        {recording ? (
          <button
            type="button"
            onClick={stop}
            className="inline-flex h-9 items-center gap-2 rounded-control border border-status-danger/50 bg-status-danger-bg px-3 text-sm font-medium text-status-danger"
            aria-label="Zaustavi snimanje"
          >
            <Square className="h-4 w-4" aria-hidden />
            Zaustavi
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void start()}
            disabled={disabled}
            className="inline-flex h-9 items-center gap-2 rounded-control border border-line bg-surface px-3 text-sm font-medium text-ink hover:bg-surface-2 disabled:opacity-50"
            aria-label={value ? 'Snimi ponovo' : 'Snimi glasovnu poruku'}
          >
            <Mic className="h-4 w-4" aria-hidden />
            {value ? 'Snimi ponovo' : 'Snimi glas'}
          </button>
        )}

        {recording && (
          <span className="tnums inline-flex items-center gap-1.5 text-sm text-status-danger">
            <span className="h-2 w-2 animate-pulse rounded-full bg-status-danger" aria-hidden />
            {fmt(elapsed)}
          </span>
        )}

        {!recording && value && (
          <button
            type="button"
            onClick={clear}
            className="inline-flex h-9 w-9 items-center justify-center rounded-control border border-line text-ink-secondary hover:bg-surface-2"
            aria-label="Ukloni snimak"
            title="Ukloni snimak"
          >
            <Trash2 className="h-4 w-4" aria-hidden />
          </button>
        )}
      </div>

      {error && <p className="text-xs text-status-danger">{error}</p>}

      {!recording && previewUrl && (
        <audio controls src={previewUrl} className="w-full max-w-sm">
          Vaš pregledač ne podržava reprodukciju audia.
        </audio>
      )}
    </div>
  );
}
