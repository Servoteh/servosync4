'use client';

import { useRef, useState } from 'react';
import { Camera, FileAudio, FileText, Image as ImageIcon, Paperclip, Trash2 } from 'lucide-react';
import { cn } from '@/lib/cn';
import { resizeImageFile } from '@/lib/image-resize';

/**
 * `attachment-input` (DESIGN_SYSTEM §10 kit; MODULE_SPEC_zahtevi §5) — dashed
 * dropzone + native kamera (`accept="image/*" capture="environment"`) + audio/pdf,
 * lista pending fajlova sa uklanjanjem, klijentska validacija tipa/veličine.
 * Generalizacija ponovljenog obrasca (odrzavanje/kvalitet/kadrovska): slike se
 * resize-uju kroz `resizeImageFile` PRE dodavanja (štedi prenos), audio ≤15 MB,
 * pdf ≤25 MB, ukupno ≤ `max` (default 10).
 *
 * Kontrolisan: `value` = trenutni pending fajlovi, `onChange(next)` emituje novu
 * listu. Odbačene fajlove prijavljuje kroz `onReject(poruka)` (poziva toast/error
 * u roditelju) — komponenta sama ne prikazuje toast (kit je bez zavisnosti na njega).
 */

const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];
const AUDIO_MIMES = ['audio/webm', 'audio/mp4', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/x-wav'];
const DOC_MIMES = ['application/pdf'];

const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB (BE hard cap/fajl)
const MAX_AUDIO_BYTES = 15 * 1024 * 1024; // 15 MB (STT limit)

export type AttachmentKind = 'IMAGE' | 'AUDIO' | 'FILE';

function classify(mime: string): AttachmentKind | null {
  const m = mime.split(';')[0].toLowerCase();
  if (IMAGE_MIMES.includes(m)) return 'IMAGE';
  if (AUDIO_MIMES.includes(m)) return 'AUDIO';
  if (DOC_MIMES.includes(m)) return 'FILE';
  return null;
}

/** Prijatno „12,3 MB" / „512 KB" (bez zavisnosti na format.ts brojeve). */
function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
}

function kindIcon(kind: AttachmentKind) {
  if (kind === 'IMAGE') return ImageIcon;
  if (kind === 'AUDIO') return FileAudio;
  return FileText;
}

export function AttachmentInput({
  value,
  onChange,
  onReject,
  max = 10,
  disabled,
  className,
}: {
  value: File[];
  onChange: (next: File[]) => void;
  onReject?: (message: string) => void;
  /** Ukupan broj priloga (uklj. već otpremljene — prosledi `max - postojeći`). */
  max?: number;
  disabled?: boolean;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const cameraRef = useRef<HTMLInputElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  async function ingest(list: FileList | File[] | null) {
    if (!list) return;
    const incoming = Array.from(list);
    if (incoming.length === 0) return;
    setBusy(true);
    const accepted: File[] = [];
    let free = max - value.length;
    for (const f of incoming) {
      if (free <= 0) {
        onReject?.(`Najviše ${max} priloga po zahtevu.`);
        break;
      }
      const kind = classify(f.type);
      if (!kind) {
        onReject?.(`„${f.name}": nepodržan tip. Dozvoljeno: slike, audio, PDF.`);
        continue;
      }
      if (kind === 'AUDIO' && f.size > MAX_AUDIO_BYTES) {
        onReject?.(`„${f.name}": audio prelazi 15 MB.`);
        continue;
      }
      if (f.size > MAX_FILE_BYTES) {
        onReject?.(`„${f.name}": prelazi 25 MB.`);
        continue;
      }
      // Slike resize-ujemo pre dodavanja (paritet 1.0 prepareImageForUpload).
      if (kind === 'IMAGE') {
        try {
          const blob = await resizeImageFile(f);
          const resized = new File([blob], f.name.replace(/\.(heic|png|webp)$/i, '.jpg'), {
            type: blob.type || 'image/jpeg',
          });
          accepted.push(resized);
        } catch {
          accepted.push(f); // resize pao → pošalji original (BE i dalje validira)
        }
      } else {
        accepted.push(f);
      }
      free -= 1;
    }
    setBusy(false);
    if (accepted.length) onChange([...value, ...accepted]);
  }

  function removeAt(idx: number) {
    onChange(value.filter((_, i) => i !== idx));
  }

  const full = value.length >= max;

  return (
    <div className={cn('space-y-2', className)}>
      <div
        onDragOver={(e) => {
          if (disabled) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (!disabled) void ingest(e.dataTransfer.files);
        }}
        className={cn(
          'rounded-panel border border-dashed px-4 py-4 text-center transition-colors',
          dragging ? 'border-accent bg-accent-subtle' : 'border-line bg-surface-2',
          disabled && 'opacity-50',
        )}
      >
        <p className="text-sm text-ink-secondary">
          Prevucite fajlove ovde ili
        </p>
        <div className="mt-2 flex flex-wrap justify-center gap-2">
          <button
            type="button"
            disabled={disabled || full || busy}
            onClick={() => cameraRef.current?.click()}
            className="inline-flex h-9 items-center gap-2 rounded-control border border-line bg-surface px-3 text-sm font-medium text-ink hover:bg-surface-2 disabled:opacity-50"
          >
            <Camera className="h-4 w-4" aria-hidden />
            Slikaj / kamera
          </button>
          <button
            type="button"
            disabled={disabled || full || busy}
            onClick={() => fileRef.current?.click()}
            className="inline-flex h-9 items-center gap-2 rounded-control border border-line bg-surface px-3 text-sm font-medium text-ink hover:bg-surface-2 disabled:opacity-50"
          >
            <Paperclip className="h-4 w-4" aria-hidden />
            Dodaj prilog
          </button>
        </div>
        <p className="mt-2 text-2xs text-ink-secondary">
          Slike, audio (≤ 15 MB) i PDF. Do {max} priloga · {value.length}/{max}.
        </p>

        {/* Native kamera na telefonu (kanonski obrazac prijava-kvara-dialog). */}
        <input
          ref={cameraRef}
          type="file"
          accept="image/*"
          capture="environment"
          multiple
          className="hidden"
          onChange={(e) => {
            void ingest(e.target.files);
            e.target.value = '';
          }}
        />
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic,audio/*,application/pdf"
          multiple
          className="hidden"
          onChange={(e) => {
            void ingest(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      {value.length > 0 && (
        <ul className="space-y-1.5">
          {value.map((f, idx) => {
            const kind = classify(f.type) ?? 'FILE';
            const Icon = kindIcon(kind);
            return (
              <li
                key={`${f.name}-${idx}`}
                className="flex items-center gap-3 rounded-control border border-line bg-surface px-3 py-2"
              >
                <Icon className="h-4 w-4 shrink-0 text-ink-secondary" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-sm text-ink" title={f.name}>
                  {f.name}
                </span>
                <span className="tnums shrink-0 text-2xs text-ink-secondary">{humanSize(f.size)}</span>
                <button
                  type="button"
                  onClick={() => removeAt(idx)}
                  disabled={disabled}
                  className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-control text-ink-secondary hover:bg-surface-2 disabled:opacity-50"
                  aria-label={`Ukloni ${f.name}`}
                  title="Ukloni"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
