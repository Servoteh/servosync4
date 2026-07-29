'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Check,
  Copy,
  Loader2,
  Mic,
  RotateCcw,
  Send,
  Sparkles,
  Square,
} from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { Button } from '@/components/ui-kit/button';
import { Textarea } from '@/components/ui-kit/textarea';
import { toast } from '@/lib/toast';
import { refineText, sendDictation, transcribeAudio } from '@/api/ai';

/**
 * „Diktiraj za Claude" (scenario B) — telefon-first alat: monter/inženjer u pogonu
 * diktira srpski, tekst se prepiše (STT `/ai/stt`) i doteri (`/ai/refine`, profil
 * „napomena" = minimalne izmene), pa se JEDNIM dugmetom pošalje u „sanduče"
 * (`POST /v1/dictation-inbox`). Claude Code na Windows radnoj stanici ga potom
 * povuče iz baze — poslednji korak NIJE klipbord (telefon i Cursor su različiti
 * uređaji), ali „Kopiraj" ostaje kao bonus za isti-uređaj slučaj.
 *
 * Capture je preslikan sa `voice-controls` DictateButton obrasca (MediaRecorder →
 * Blob → transcribe → refine), a NE sa `audio-recorder` kit komponente: potreban je
 * VELIKI mikrofon za prst (44px+), eksplicitno stanje „Snima…" (kit ne javlja start)
 * i jednokratni tok bez preview/čuvanja — snimak se posle transkripcije ODBACUJE
 * (nikad se ne šalje ni čuva). Van AppShell-a, full-screen (isti obrazac kao ostale
 * `/mob/*` rute); static export: čista statička ruta, bez `[id]` / `useSearchParams`.
 */

const FOCUS = 'focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]';

/** Serverski limit (DictationInboxService.MAX_TEXT_LEN) — guard pre round-tripa. */
const MAX_TEXT_LEN = 10_000;

/** Best-effort kopija: Clipboard API (siguran kontekst) → legacy execCommand fallback. */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* padni na legacy (nesiguran kontekst ili blokirano bez gesta) */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function humanMsg(e: unknown, fallback: string): string {
  const m = e instanceof Error ? e.message : '';
  return m && m.trim() ? m : fallback;
}

type Busy = null | 'stt' | 'refine' | 'send';
type ErrKind = null | 'stt' | 'refine' | 'send';

export default function MobDiktafonPage() {
  const { user, isLoading, can, permissionsPending, permissionsError } = useAuth();
  const router = useRouter();

  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [busy, setBusy] = useState<Busy>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [errKind, setErrKind] = useState<ErrKind>(null);
  const [sent, setSent] = useState(false);
  const [copied, setCopied] = useState(false);
  // Dedup: tačan tekst poslednjeg uspešnog slanja — isti nepromenjen tekst se ne
  // može poslati opet (stari duplikat = mina za sledeći Claude pull; review [8]).
  const [lastSentText, setLastSentText] = useState('');
  // „Kopiraj" nema smisla na telefonu (klipbord ne prelazi na Cursor — cela poenta
  // scenarija B); prikazuje se samo na fine-pointer (desktop) uređajima (review [9]).
  const [coarsePointer, setCoarsePointer] = useState(false);

  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  // Čišćenje: zaustavi tajmer i mikrofon na unmount-u (ne curi stream/track).
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      recRef.current?.stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // Touch (coarse pointer) → sakrij „Kopiraj". Medijaupit, NE `navigator.clipboard`
  // (Clipboard API postoji i na telefonu, pa nije dobar signal — review [9]).
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(pointer: coarse)');
    const update = () => setCoarsePointer(mq.matches);
    update();
    mq.addEventListener?.('change', update);
    return () => mq.removeEventListener?.('change', update);
  }, []);

  const supported =
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== 'undefined';

  // Čekaj i dozvole (permissionsPending): can() je fail-closed dok permsQuery ne
  // stigne, pa bi ovlašćen korisnik na svež login video lažni „Nemate pristup".
  if (isLoading || !user || permissionsPending) {
    return (
      <main className="grid min-h-screen place-items-center bg-app text-sm text-ink-secondary">
        Učitavanje…
      </main>
    );
  }
  if (permissionsError) {
    return (
      <main className="grid min-h-screen place-items-center bg-app p-6 text-center text-sm text-ink-secondary">
        Ne mogu da učitam tvoja prava (mreža?). Proveri vezu pa osveži stranicu.
      </main>
    );
  }
  if (!can(PERMISSIONS.AI_CHAT)) {
    return (
      <main className="grid min-h-screen place-items-center bg-app p-6 text-center text-sm text-ink-secondary">
        Nemate pristup diktafonu — potrebno je pravo za AI (`ai.chat`). Javite se administratoru.
      </main>
    );
  }

  function fmt(sec: number): string {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  async function start() {
    setError(null);
    setErrKind(null);
    setSent(false);
    setCopied(false);
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
        // Snimak se ODMAH transkribuje pa odbacuje — nikad se ne čuva ni šalje.
        if (blob.size < 200) {
          setError('Snimak je prekratak — drži dugme dok govoriš, pa zaustavi.');
          setErrKind('stt');
          return;
        }
        void transcribeThenRefine(blob);
      };
      rec.start();
      recRef.current = rec;
      setRecording(true);
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);
    } catch {
      setError('Mikrofon nije dostupan (dozvola odbijena ili nema uređaja). Dozvoli mikrofon u pregledaču pa pokušaj ponovo.');
      setErrKind('stt');
    }
  }

  function stop() {
    recRef.current?.stop();
    recRef.current = null;
  }

  /** STT → automatski refine (profil „napomena"). Sirov prepis je fallback ako refine padne. */
  async function transcribeThenRefine(blob: Blob) {
    setBusy('stt');
    setError(null);
    setErrKind(null);
    try {
      const stt = await transcribeAudio(blob, { context: 'chat', lang: 'sr' });
      const raw = stt.data.text?.trim() ?? '';
      if (!raw) {
        setBusy(null);
        setError('Nisam razaznao govor — probaj ponovo, bliže mikrofonu i bez buke.');
        setErrKind('stt');
        return;
      }
      setText(raw); // pokaži sirov prepis odmah (doterivanje ga zamenjuje ako uspe)
      setBusy('refine');
      try {
        const ref = await refineText(raw, 'napomena');
        const doter = ref.data.text?.trim();
        if (doter) setText(doter);
        setBusy(null);
      } catch (e) {
        // Refine je „lepše, ne obavezno": zadrži sirov prepis, javi mekim tonom.
        setBusy(null);
        setError(humanMsg(e, 'Doterivanje nije uspelo — možeš poslati sirov prepis ili doterati ponovo.'));
        setErrKind('refine');
      }
    } catch (e) {
      // NE brisati postojeći tekst: ponovno snimanje pri grešci ne sme progutati
      // ono što je već prepisano/dotereno (review MEDIUM [7]).
      setBusy(null);
      setError(humanMsg(e, 'Prepisivanje nije uspelo. Pokušaj ponovo.'));
      setErrKind('stt');
    }
  }

  async function refineAgain() {
    const t = text.trim();
    if (!t || busy) return;
    setBusy('refine');
    setError(null);
    setErrKind(null);
    try {
      const ref = await refineText(t, 'napomena');
      const doter = ref.data.text?.trim();
      if (doter) setText(doter);
      setBusy(null);
    } catch (e) {
      setBusy(null);
      setError(humanMsg(e, 'Doterivanje nije uspelo — pošalji sirov prepis.'));
      setErrKind('refine');
    }
  }

  async function send() {
    const t = text.trim();
    if (!t || busy) return;
    // Klijentski guard dužine — javi pre round-tripa umesto da server vrati 422.
    if (t.length > MAX_TEXT_LEN) {
      setError(`Tekst je predugačak (${t.length}/${MAX_TEXT_LEN} znakova). Skrati pa pošalji.`);
      setErrKind('send');
      return;
    }
    // Dedup: isti nepromenjen tekst se ne šalje dvaput (review [8]).
    if (sent && t === lastSentText) return;
    setBusy('send');
    setError(null);
    setErrKind(null);
    try {
      await sendDictation(t);
      setLastSentText(t);
      setSent(true);
    } catch (e) {
      setError(humanMsg(e, 'Slanje nije uspelo — proveri vezu i pokušaj ponovo.'));
      setErrKind('send');
    } finally {
      setBusy(null);
    }
  }

  async function copy() {
    const ok = await copyToClipboard(text);
    setCopied(ok);
    if (ok) toast('Kopirano ✓');
    else toast('Kopiranje nije uspelo na ovom uređaju.');
  }

  function reset() {
    setText('');
    setBusy(null);
    setError(null);
    setErrKind(null);
    setSent(false);
    setCopied(false);
    setLastSentText('');
    setElapsed(0);
  }

  const status =
    busy === 'stt'
      ? 'Prepisujem govor…'
      : busy === 'refine'
        ? 'Doterujem tekst…'
        : busy === 'send'
          ? 'Šaljem…'
          : recording
            ? 'Snima… govori, pa zaustavi'
            : sent
              ? 'Poslato ✓ — reci Claude-u: „diktat"'
              : text
                ? 'Proveri tekst pa pošalji'
                : 'Pritisni mikrofon i govori';

  // Dedup ugrađen u gejt: isti nepromenjen tekst kao poslednji poslati → onemogućeno.
  const canSend = !!text.trim() && !busy && text.trim() !== lastSentText;

  return (
    <div className="min-h-screen bg-app pb-24">
      <header className="sticky top-0 z-10 border-b border-line bg-surface px-4 py-3">
        <div className="flex items-center gap-3">
          <a
            href="/mob"
            className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-control border border-line bg-surface-2 text-ink active:bg-surface ${FOCUS}`}
            aria-label="Nazad"
          >
            <ArrowLeft className="h-5 w-5" aria-hidden />
          </a>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-bold text-ink">Diktiraj za Claude</h1>
            <p className="truncate text-xs text-ink-secondary">{user.fullName ?? user.email}</p>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-2xl space-y-4 p-4">
        {/* Status linija — jasno stanje toka (snimanje/prepis/doterivanje/slanje).
            role=status + aria-live: čitač ekrana najavljuje promene i „Poslato ✓". */}
        <div
          role="status"
          aria-live="polite"
          className="flex items-center justify-center gap-2 text-center text-sm font-medium text-ink-secondary"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin text-accent" aria-hidden />}
          {recording && (
            <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-status-danger" aria-hidden />
          )}
          <span>{status}</span>
          {recording && <span className="tnums text-status-danger">{fmt(elapsed)}</span>}
        </div>

        {/* VELIKI mikrofon (snimaj / zaustavi). 44px+ za prst; onemogućen dok traje obrada. */}
        {supported ? (
          <button
            type="button"
            onClick={() => (recording ? stop() : void start())}
            disabled={!!busy}
            aria-pressed={recording}
            aria-label={recording ? 'Zaustavi snimanje' : 'Snimaj glas'}
            className={`flex min-h-24 w-full items-center justify-center gap-3 rounded-panel border-2 text-xl font-semibold transition-colors disabled:opacity-50 ${FOCUS} ${
              recording
                ? 'border-status-danger/60 bg-status-danger-bg text-status-danger active:bg-status-danger/15'
                : 'border-accent/50 bg-accent text-accent-fg active:bg-accent-active'
            }`}
          >
            {recording ? (
              <>
                <Square className="h-7 w-7" aria-hidden />
                Zaustavi
              </>
            ) : (
              <>
                <Mic className="h-7 w-7" aria-hidden />
                Snimaj
              </>
            )}
          </button>
        ) : (
          <p className="rounded-panel border border-line bg-surface px-4 py-4 text-center text-sm text-ink-secondary">
            Snimanje glasa nije dostupno na ovom uređaju/pregledaču. Otvori stranicu u
            novijem pregledaču (Chrome/Safari) uz dozvolu za mikrofon.
          </p>
        )}

        {/* Greška prepisa (nema teksta) — mikrofon iznad je „pokušaj ponovo". */}
        {errKind === 'stt' && error && (
          <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
            {error}
          </div>
        )}

        {/* Tekst — editabilan pre slanja (Enter = novi red, ovo nije ćaskanje). */}
        {text && (
          <div className="space-y-3">
            <Textarea
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setSent(false);
                setCopied(false);
              }}
              rows={9}
              className="min-h-44 text-base"
              aria-label="Tekst za slanje"
              placeholder="Ovde se pojavljuje prepisan i doteran tekst…"
            />

            {/* Brojač se pojavljuje tek pri dužini blizu limita (review [11]). */}
            {text.length > 8000 && (
              <p
                className={`-mt-1 text-right text-xs tnums ${
                  text.length > MAX_TEXT_LEN ? 'text-status-danger' : 'text-ink-secondary'
                }`}
              >
                {text.length} / {MAX_TEXT_LEN}
              </p>
            )}

            {/* Refine je pao — sirov prepis je tu; ponudi ponovni pokušaj (nije blokada). */}
            {errKind === 'refine' && error && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-status-warn/40 bg-status-warn-bg px-3 py-2 text-sm text-status-warn">
                <span className="min-w-0">{error}</span>
                <button
                  type="button"
                  onClick={() => void refineAgain()}
                  disabled={!!busy}
                  className={`inline-flex h-9 shrink-0 items-center gap-1.5 rounded-control border border-line bg-surface px-3 text-sm font-medium text-ink active:bg-surface-2 disabled:opacity-50 ${FOCUS}`}
                >
                  <Sparkles className="h-4 w-4" aria-hidden />
                  Doteraj ponovo
                </button>
              </div>
            )}

            {/* Slanje palo — dugme „Pošalji" ispod je ponovni pokušaj; poruka ovde. */}
            {errKind === 'send' && error && (
              <div className="rounded-control border border-status-danger/40 bg-status-danger-bg px-3 py-2 text-sm text-status-danger">
                {error}
              </div>
            )}

            {/* Potvrda slanja — poenta scenarija B: Claude to povlači iz baze. */}
            {sent && (
              <div className="flex items-center gap-2 rounded-control border border-status-success/40 bg-status-success-bg px-3 py-2.5 text-sm font-medium text-status-success">
                <Check className="h-5 w-5 shrink-0" aria-hidden />
                Poslato ✓ — reci Claude-u: „diktat" (povuče tekst na računaru).
              </div>
            )}

            <div className="grid grid-cols-1 gap-2">
              {/* PRIMARNO: pošalji u sanduče (44px+). Onemogućeno dok je isti tekst već poslat. */}
              <Button
                onClick={() => void send()}
                loading={busy === 'send'}
                disabled={!canSend}
                className="h-14 text-lg"
              >
                <Send className="h-5 w-5" aria-hidden />
                Pošalji Claude-u
              </Button>

              {coarsePointer ? (
                // Telefon (touch): klipbord ne prelazi na Cursor → „Novo" u punu širinu.
                <Button variant="ghost" onClick={reset} disabled={!!busy} className="h-12">
                  <RotateCcw className="h-5 w-5" aria-hidden />
                  Novo
                </Button>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  {/* BONUS: kopija za isti-uređaj (desktop, best-effort). */}
                  <Button
                    variant="secondary"
                    onClick={() => void copy()}
                    disabled={!text.trim()}
                    className="h-12"
                  >
                    {copied ? <Check className="h-5 w-5 text-status-success" aria-hidden /> : <Copy className="h-5 w-5" aria-hidden />}
                    {copied ? 'Kopirano' : 'Kopiraj'}
                  </Button>
                  <Button variant="ghost" onClick={reset} disabled={!!busy} className="h-12">
                    <RotateCcw className="h-5 w-5" aria-hidden />
                    Novo
                  </Button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Prazno stanje — kratko uputstvo (bez teksta i bez snimanja). */}
        {!text && !recording && !busy && errKind !== 'stt' && (
          <p className="px-2 text-center text-sm text-ink-secondary">
            Govori srpski normalnim tempom. Kad zaustaviš, tekst se prepiše i doteri, pa ga
            jednim dugmetom pošalješ Claude-u na računar.
          </p>
        )}
      </main>
    </div>
  );
}
