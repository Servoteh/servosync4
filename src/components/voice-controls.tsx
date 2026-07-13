'use client';

import { useRef, useState } from 'react';
import { Mic, Sparkles, Square } from 'lucide-react';
import { cn } from '@/lib/cn';
import { refineText, transcribeAudio, type RefineProfil } from '@/api/ai';

// 🎤 diktiranje (STT /ai/stt Whisper) + ✨ doterivanje (/ai/refine). Presečna infra
// (MODULE_SPEC §7 P4) — koristi je zapisnik, priprema i AI chat. Bez živog backenda
// dugmad su prisutna ali poziv pada uredno (poruka greške u title/alert).

/** Snima mikrofon → /ai/stt; rezultat prosleđuje kroz onText (dopisati/ubaciti). */
export function DictateButton({
  onText,
  context = 'chat',
  className,
  title = 'Diktiraj (govor u tekst)',
}: {
  onText: (text: string) => void;
  context?: 'chat' | 'zapisnik';
  className?: string;
  title?: string;
}) {
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  async function start() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' });
        if (blob.size < 200) return;
        setBusy(true);
        try {
          const res = await transcribeAudio(blob, { context, lang: 'sr' });
          const text = res.data.text?.trim();
          if (text) onText(text);
        } catch (e) {
          alert(e instanceof Error ? e.message : 'Diktiranje trenutno nije dostupno.');
        } finally {
          setBusy(false);
        }
      };
      rec.start();
      recRef.current = rec;
      setRecording(true);
    } catch {
      alert('Mikrofon nije dostupan (dozvola odbijena ili nema uređaja).');
    }
  }

  function stop() {
    recRef.current?.stop();
    recRef.current = null;
    setRecording(false);
  }

  return (
    <button
      type="button"
      title={title}
      disabled={busy}
      onClick={() => (recording ? stop() : void start())}
      className={cn(
        'inline-flex h-7 w-7 items-center justify-center rounded-control border border-line text-ink-secondary hover:bg-surface-2 disabled:opacity-50',
        recording && 'border-status-danger/50 bg-status-danger-bg text-status-danger',
        className,
      )}
      aria-pressed={recording}
      aria-label={title}
    >
      {recording ? <Square className="h-3.5 w-3.5" aria-hidden /> : <Mic className="h-3.5 w-3.5" aria-hidden />}
    </button>
  );
}

/** ✨ Doteruje trenutni tekst po profilu dokumenta; rezultat kroz onText (zameni). */
export function RefineButton({
  getText,
  onText,
  profil,
  className,
  title = 'Doteraj tekst (AI)',
}: {
  getText: () => string;
  onText: (text: string) => void;
  profil?: RefineProfil;
  className?: string;
  title?: string;
}) {
  const [busy, setBusy] = useState(false);
  async function run() {
    const tekst = getText().trim();
    if (!tekst) return;
    setBusy(true);
    try {
      const res = await refineText(tekst, profil);
      if (res.data.text) onText(res.data.text);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Doterivanje trenutno nije dostupno.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <button
      type="button"
      title={title}
      disabled={busy}
      onClick={() => void run()}
      className={cn(
        'inline-flex h-7 w-7 items-center justify-center rounded-control border border-line text-ink-secondary hover:bg-surface-2 disabled:opacity-50',
        className,
      )}
      aria-label={title}
    >
      <Sparkles className="h-3.5 w-3.5" aria-hidden />
    </button>
  );
}
