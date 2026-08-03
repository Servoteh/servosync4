'use client';

import { useRef, useState } from 'react';
import { Camera, FileAudio, FileText, Image as ImageIcon, Paperclip, Trash2 } from 'lucide-react';
import { cn } from '@/lib/cn';
import { MIME_BY_FORMAT, prepareImageForUpload, sniffFormat } from '@/lib/image-resize';

/**
 * `attachment-input` (DESIGN_SYSTEM §10 kit; MODULE_SPEC_zahtevi §5) — dashed
 * dropzone + native kamera (`accept="image/*" capture="environment"`) + audio/pdf,
 * lista pending fajlova sa uklanjanjem, klijentska validacija tipa/veličine.
 * Generalizacija ponovljenog obrasca (odrzavanje/kvalitet/kadrovska): slike se
 * pripremaju kroz `prepareImageForUpload` PRE dodavanja (JPEG ≤1568px, EXIF
 * rotacija poštovana — štedi prenos), audio ≤15 MB, pdf ≤25 MB, ukupno ≤ `max`
 * (default 10).
 *
 * 🔴 Slika koja ne može da se pretvori u JPEG se ODBIJA sa uputstvom, nikad se ne
 * šalje original „za svaki slučaj": backend prilog presuđuje po magic bytes i prima
 * samo JPG/PNG/PDF, a upis je all-or-nothing — jedan HEIC sa iPhone-a bi oborio celu
 * otpremu i fotografija neusaglašenosti sa montaže bi nestala bez poruke.
 * Zato i `accept` liste NE nude `image/heic` (iOS pri izboru iz Galerije sam pretvara
 * u JPEG; „Slikaj / kamera" putanja na telefonu takođe daje JPEG).
 *
 * Kontrolisan: `value` = trenutni pending fajlovi, `onChange(next)` emituje novu
 * listu. Odbačene fajlove prijavljuje kroz `onReject(poruka)` (poziva toast/error
 * u roditelju) — komponenta sama ne prikazuje toast (kit je bez zavisnosti na njega).
 * Poruka odbijanja UVEK kaže šta korisnik dalje da uradi.
 */

// `image/heic` ostaje PREPOZNAT (da bi HEIC dobio poruku „šta da uradiš" umesto
// generičkog „nepodržan tip"), ali se NE nudi u `accept` atributu birača fajlova.
const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/avif'];
const AUDIO_MIMES = ['audio/webm', 'audio/mp4', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/x-wav'];
const DOC_MIMES = ['application/pdf'];

const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB (BE hard cap/fajl)
const MAX_AUDIO_BYTES = 15 * 1024 * 1024; // 15 MB (STT limit)

export type AttachmentKind = 'IMAGE' | 'AUDIO' | 'FILE';

const ALL_KINDS: AttachmentKind[] = ['IMAGE', 'AUDIO', 'FILE'];

/**
 * `accept` atribut file-input-a po dozvoljenim vrstama (kamera koristi zaseban input).
 * Bez `image/heic` NAMERNO: iOS birač („Photo Library") tada pri izboru sam pretvori
 * fotografiju u JPEG, a u „Browse"/Files listi HEIC fajlovi ostaju neizbirljivi — čime
 * se problem sprečava pre nego što nastane, umesto da se rešava porukom o grešci.
 */
const ACCEPT_ATTR: Record<AttachmentKind, string> = {
  IMAGE: 'image/jpeg,image/png,image/webp',
  AUDIO: 'audio/*',
  FILE: 'application/pdf',
};
const KIND_LABEL: Record<AttachmentKind, string> = {
  IMAGE: 'slike',
  AUDIO: 'audio',
  FILE: 'PDF',
};

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
  accept = ALL_KINDS,
  maxBytes = MAX_FILE_BYTES,
}: {
  value: File[];
  onChange: (next: File[]) => void;
  onReject?: (message: string) => void;
  /** Ukupan broj priloga (uklj. već otpremljene — prosledi `max - postojeći`). */
  max?: number;
  disabled?: boolean;
  className?: string;
  /** Dozvoljene vrste priloga. Default sve (slike/audio/PDF) — kontekst sme da suzi (npr. samo slike/PDF). */
  accept?: AttachmentKind[];
  /** Gornja granica veličine po fajlu (bajtovi). Default 25 MB; audio dodatno kapiran na 15 MB. */
  maxBytes?: number;
}) {
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const cameraRef = useRef<HTMLInputElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  /**
   * MIME na koji se oslanjamo. Android/Files ume da preda fajl sa PRAZNIM `file.type`
   * (a `.heic` zna da stigne etiketiran kao `image/jpeg`), pa tada odlučuju magic bytes —
   * inače bi savršeno ispravna fotografija završila kao „nepodržan tip".
   */
  async function effectiveMime(f: File): Promise<string> {
    const declared = (f.type || '').split(';')[0].toLowerCase();
    if (declared) return declared;
    return MIME_BY_FORMAT[await sniffFormat(f)] ?? '';
  }

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
      const allowedLabel = accept.map((k) => KIND_LABEL[k]).join(', ');
      const kind = classify(await effectiveMime(f));
      if (!kind || !accept.includes(kind)) {
        onReject?.(
          `„${f.name}": nepodržan tip. Dozvoljeno: ${allowedLabel}. Pretvorite fajl u dozvoljen format (slike u JPG/PNG, dokumenta u PDF) pa pokušajte ponovo.`,
        );
        continue;
      }
      const perFileCap = kind === 'AUDIO' ? Math.min(maxBytes, MAX_AUDIO_BYTES) : maxBytes;
      if (f.size > perFileCap) {
        onReject?.(
          kind === 'IMAGE'
            ? `„${f.name}": prelazi ${humanSize(perFileCap)}. Slikajte dugmetom „Slikaj / kamera" — takva slika se automatski smanji.`
            : `„${f.name}": prelazi ${humanSize(perFileCap)}.`,
        );
        continue;
      }
      // Slike: JPEG ≤1568px sa poštovanom EXIF rotacijom (paritet 1.0 prepareImageForUpload).
      // Pad pretvaranja NE prosleđuje original tiho — korisnik dobija uputstvo (v. image-resize.ts).
      if (kind === 'IMAGE') {
        let ready: File;
        try {
          ready = await prepareImageForUpload(f);
        } catch (e) {
          onReject?.((e as Error).message);
          continue;
        }
        // Original koji je prošao pretvaranje bez smanjenja (JPG/PNG kad canvas ne radi)
        // može i dalje biti preko granice — bolje odbiti ovde nego dobiti 413 sa servera.
        if (ready.size > perFileCap) {
          onReject?.(`„${f.name}": i posle smanjenja prelazi ${humanSize(perFileCap)}. Slikajte je ponovo dugmetom „Slikaj / kamera".`);
          continue;
        }
        accepted.push(ready);
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
          {accept.includes('IMAGE') && (
            <button
              type="button"
              disabled={disabled || full || busy}
              onClick={() => cameraRef.current?.click()}
              className="inline-flex h-9 items-center gap-2 rounded-control border border-line bg-surface px-3 text-sm font-medium text-ink hover:bg-surface-2 active:bg-surface-2 disabled:opacity-50"
            >
              <Camera className="h-4 w-4" aria-hidden />
              Slikaj / kamera
            </button>
          )}
          <button
            type="button"
            disabled={disabled || full || busy}
            onClick={() => fileRef.current?.click()}
            className="inline-flex h-9 items-center gap-2 rounded-control border border-line bg-surface px-3 text-sm font-medium text-ink hover:bg-surface-2 active:bg-surface-2 disabled:opacity-50"
          >
            <Paperclip className="h-4 w-4" aria-hidden />
            Dodaj prilog
          </button>
        </div>
        <p className="mt-2 text-2xs text-ink-secondary" aria-live="polite">
          {busy
            ? 'Pripremam slike…'
            : `${accept.map((k) => KIND_LABEL[k]).join(', ')} (≤ ${humanSize(maxBytes)}). Do ${max} priloga · ${value.length}/${max}.`}
        </p>

        {/*
          Native kamera na telefonu (kanonski obrazac prijava-kvara-dialog).
          `accept="image/*"` ostaje NAMERNO širok: sužavanje ume da spreči otvaranje
          kamere na delu Android uređaja, a snimak sa kamere i tako stiže kao JPEG
          (iOS) ili prolazi kroz `prepareImageForUpload` gejt (Android „high efficiency").
        */}
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
          accept={accept.map((k) => ACCEPT_ATTR[k]).join(',')}
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
