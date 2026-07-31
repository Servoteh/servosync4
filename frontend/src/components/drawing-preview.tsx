'use client';

/**
 * „Pregled crteža" — plutajuća kartica sa prvom stranom PDF-a, na prelaz mišem
 * (zahtev 052/26, Đorđe Arsić, modul „Nacrti"). Projektant pri sastavljanju
 * nacrta bira stavke po oznaci crteža; naziv pomaže, ali sliku vidi tek kad
 * otvori pun PDF u novom tabu i vrati se nazad.
 *
 * Namerno ODVOJENO dugme od „Otvori PDF": klik na ono zadržava zatečeno
 * ponašanje (pun PDF, novi tab). Ovo dugme radi na prelaz mišem, na fokus
 * (tastatura) i na klik (tableti — tap „prikači" karticu dok se ne zatvori).
 *
 * Zaštite (crteži znaju biti ogromni — zatečeni maksimum je 16 MB):
 *  • odlaganje pre povlačenja — prelaz preko liste od 200 stavki ne lupa API;
 *  • prekid (`AbortController`) čim miš ode pre nego što fetch završi;
 *  • keš po crtežu (ograničen) — isti crtež se povlači jednom;
 *  • prag veličine: preko njega se PDF ne parsira, nego se nudi novi tab;
 *  • `pdfjs-dist` se učitava lenjo (`next/dynamic`, `ssr:false`) — ne ulazi u
 *    bundle ekrana koji pregled nikad ne otvore.
 */

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Eye, X } from 'lucide-react';
import { apiBlob } from '@/api/client';
import { formatNumber } from '@/lib/format';

/** Širina renderovane strane (CSS px) — čitljivo, a ne pokriva pola ekrana. */
const PREVIEW_WIDTH = 420;
/** Odlaganje od prelaza mišem do povlačenja PDF-a. */
const HOVER_DELAY_MS = 400;
/** Preko ovoga se PDF ne renderuje (parsiranje 16 MB crteža blokira tab). */
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
/** Najviše keširanih crteža — ~2 MB po ulazu, pa se najstariji izbacuje. */
const MAX_CACHED = 12;
/** Razmak kartice od dugmeta i od ivica ekrana. */
const GAP = 8;
/** Unutrašnji padding kartice (levo+desno) + okvir — za širinu i za poziciju. */
const CARD_CHROME = 18;

const DrawingPreviewCanvas = dynamic(() => import('./drawing-preview-canvas'), {
  ssr: false,
  loading: () => (
    <p className="py-6 text-center text-xs text-ink-secondary" role="status">
      Učitavanje pregleda…
    </p>
  ),
});

/** Rezultat povlačenja PDF-a; `loading` je prelazno stanje, ne kešira se. */
type Loaded =
  | { kind: 'ok'; bytes: ArrayBuffer }
  | { kind: 'too-large'; sizeKb: number };
type PreviewState = Loaded | { kind: 'loading' } | { kind: 'error' };

/**
 * Keš po `drawingId` — deljen za sve instance dugmeta na ekranu (ista lista
 * stavki se skroluje gore-dole). Greške se NE keširaju (mrežni prekid sme da
 * se ponovi), a kad pređe `MAX_CACHED` izbacuje se najstariji ulaz.
 */
const previewCache = new Map<number, Loaded>();

function rememberPreview(drawingId: number, value: Loaded): void {
  previewCache.set(drawingId, value);
  while (previewCache.size > MAX_CACHED) {
    const oldest = previewCache.keys().next();
    if (oldest.done) break;
    previewCache.delete(oldest.value);
  }
}

interface Anchor {
  top: number;
  left: number;
}

/**
 * Kartica ide desno od dugmeta; ako tamo nema mesta — levo. Vertikalno se
 * centrira na dugme i ograniči na ekran. Pozicija je `fixed`, pa je skrol
 * kontejner dijaloga ne seče (nijedan predak nema `transform`).
 */
function computeAnchor(el: HTMLElement, cardWidth: number): Anchor {
  const r = el.getBoundingClientRect();
  const spaceRight = window.innerWidth - r.right;
  const left =
    spaceRight >= cardWidth + GAP
      ? r.right + GAP
      : Math.max(GAP, r.left - cardWidth - GAP);
  // Visina kartice se zna tek posle rendera — koristi se procena (isti gornji
  // limit kao `max-h` na kartici) samo da prikaz ne iscuri ispod ekrana.
  const approxHeight = Math.min(window.innerHeight * 0.7, 520);
  const top = Math.min(
    Math.max(GAP, r.top + r.height / 2 - approxHeight / 2),
    Math.max(GAP, window.innerHeight - approxHeight - GAP),
  );
  return { top, left };
}

export function DrawingPreviewButton({
  drawingId,
  title,
}: {
  drawingId: number;
  /** Zaglavlje kartice (npr. „1141072 / A · Nosač"); opciono. */
  title?: string;
}) {
  const [state, setState] = useState<PreviewState | null>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  // „Prikačena" kartica (tap/klik) ostaje otvorena i kad miš ode — jedini
  // upotrebljiv režim na tabletu, gde `mouseenter` ne postoji.
  const [pinned, setPinned] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const aliveRef = useRef(true);

  const cardWidth = PREVIEW_WIDTH + CARD_CHROME;

  const cancelTimer = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const close = useCallback(() => {
    cancelTimer();
    // Prekid fetch-a u letu: miš je otišao pre nego što je PDF stigao.
    abortRef.current?.abort();
    abortRef.current = null;
    setState(null);
    setAnchor(null);
  }, [cancelTimer]);

  const openNow = useCallback(async () => {
    const el = btnRef.current;
    if (!el) return;
    setAnchor(computeAnchor(el, cardWidth));

    const cached = previewCache.get(drawingId);
    if (cached) {
      setState(cached);
      return;
    }

    const ctrl = new AbortController();
    abortRef.current?.abort();
    abortRef.current = ctrl;
    setState({ kind: 'loading' });
    try {
      const blob = await apiBlob(`/v1/pdm/drawings/${drawingId}/pdf/content`, {
        signal: ctrl.signal,
      });
      // Veličina se proverava TEK posle preuzimanja: endpoint vraća ceo fajl
      // (nema HEAD/Content-Length pre toga), ali se bar izbegne parsiranje —
      // ono je ono što obara tab, a ne sam prenos (p90 je ~290 KB).
      const next: Loaded =
        blob.size > MAX_PREVIEW_BYTES
          ? { kind: 'too-large', sizeKb: Math.round(blob.size / 1024) }
          : { kind: 'ok', bytes: await blob.arrayBuffer() };
      rememberPreview(drawingId, next);
      if (aliveRef.current && abortRef.current === ctrl) setState(next);
    } catch (err) {
      // Prekid nije greška — kartica je već zatvorena, bez poruke.
      if ((err as { name?: string } | null)?.name === 'AbortError') return;
      if (aliveRef.current && abortRef.current === ctrl) setState({ kind: 'error' });
    }
  }, [drawingId, cardWidth]);

  const scheduleOpen = useCallback(() => {
    if (state != null) return; // već otvoreno/učitava se
    cancelTimer();
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      void openNow();
    }, HOVER_DELAY_MS);
  }, [state, cancelTimer, openNow]);

  const leave = useCallback(() => {
    if (pinned) return;
    close();
  }, [pinned, close]);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      cancelTimer();
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [cancelTimer]);

  // Dok je kartica otvorena: Esc je zatvara, skrol/resize takođe (pozicija je
  // `fixed`, pa bi inače „visila" pored pomerenog dugmeta). Esc se hvata u
  // CAPTURE fazi i zaustavlja — inače bi ga uhvatio i Dialog („Novi nacrt") i
  // zatvorio celu formu ispod pregleda.
  useEffect(() => {
    if (state == null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setPinned(false);
      close();
    };
    const onMove = () => {
      setPinned(false);
      close();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [state, close]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onMouseEnter={scheduleOpen}
        onMouseLeave={leave}
        onFocus={scheduleOpen}
        onBlur={leave}
        onClick={() => {
          if (pinned) {
            setPinned(false);
            close();
            return;
          }
          setPinned(true);
          cancelTimer();
          void openNow();
        }}
        aria-expanded={state != null}
        aria-label="Pregled crteža (zadrži miš ili klikni)"
        // Namerno BEZ `title`: nativni tooltip iskoči ~1 s posle prelaza mišem,
        // tačno preko kartice koja se otvara na 400 ms. Opis nosi `aria-label`.
        className={`rounded-control border border-line p-1.5 hover:bg-surface-2 ${
          pinned ? 'bg-surface-2 text-ink' : 'text-ink-secondary'
        }`}
      >
        <Eye className="h-3.5 w-3.5" aria-hidden />
      </button>

      {state != null && anchor != null && (
        <div
          role="dialog"
          aria-label={title ? `Pregled crteža ${title}` : 'Pregled crteža'}
          style={{ top: anchor.top, left: anchor.left, width: cardWidth }}
          // Bez „prikačenosti" kartica ne prima klik — miš prelazi preko nje ka
          // sledećem redu bez treptanja (ponašanje tooltip-a).
          className={`fixed z-50 max-h-[70vh] overflow-auto rounded-panel border border-line bg-surface p-2 shadow-xl ${
            pinned ? '' : 'pointer-events-none'
          }`}
        >
          <div className="mb-1.5 flex items-start gap-2">
            <span className="tnums flex-1 truncate text-xs font-semibold text-ink" title={title}>
              {title ?? 'Crtež'}
            </span>
            {pinned && (
              <button
                type="button"
                onClick={() => {
                  setPinned(false);
                  close();
                }}
                aria-label="Zatvori pregled"
                className="rounded-control p-0.5 text-ink-secondary hover:bg-surface-2"
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </button>
            )}
          </div>
          {state.kind === 'loading' && (
            <p className="py-6 text-center text-xs text-ink-secondary" role="status">
              Učitavanje crteža…
            </p>
          )}
          {state.kind === 'error' && (
            <p className="py-6 text-center text-xs text-status-danger" role="status">
              Crtež se nije učitao — otvori PDF u novom tabu.
            </p>
          )}
          {state.kind === 'too-large' && (
            <p className="py-6 text-center text-xs text-ink-secondary" role="status">
              Crtež je prevelik za pregled ({formatNumber(state.sizeKb)} KB) — otvori ga u novom
              tabu.
            </p>
          )}
          {state.kind === 'ok' && (
            <DrawingPreviewCanvas bytes={state.bytes} width={PREVIEW_WIDTH} />
          )}
        </div>
      )}
    </>
  );
}
