'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { cn } from '@/lib/cn';
import { useEscapeLayer } from './escape-layer';

/**
 * CONTEXT MENU — plutajući meni akcija (desni klik ili dugme „…").
 * ===========================================================================
 * Poreklo: `app/kadrovska/_components/grid/cell-context-menu.tsx` (dokazan u
 * kadrovskom gridu). Ovde je promovisan u kit, uz tri razlike koje su bile
 * uslov za deljenu upotrebu:
 *
 * 1. **Klampovanje se MERI, ne pretpostavlja.** Original je računao poziciju iz
 *    pretpostavljenih dimenzija (`- 220`, `- 40 - items.length * 32`) — čim meni
 *    dobije duže labele ili naslov, brojevi lažu i meni izađe iz ekrana. Ovde se
 *    stvarni `getBoundingClientRect()` meri u `useLayoutEffect` (pre iscrtavanja),
 *    pa se meni po potrebi **prevrne** iznad/levo od tačke otvaranja i tek onda
 *    pritegne uz ivicu.
 * 2. **Esc ide kroz `escape-layer`**, ne kroz sopstveni `keydown` na `window`.
 *    Meni se otvara i iznad dijaloga; sopstveni slušalac bi zatvorio i meni i
 *    dijalog ispod njega (regresija V11, v. `escape-layer.ts`).
 * 3. **Onemogućena stavka nosi razlog.** `onemoguceno` je TEKST razloga i stavka
 *    ostaje u tabu/čitaču ekrana (`aria-disabled`, ne `disabled`) — pravi
 *    `disabled` element u Firefox-u ne prima pokazivač, pa se `title` nikad ne
 *    prikaže i korisnik ne sazna ZAŠTO akcija ne radi.
 *
 * Tastatura: ↑/↓ kruže kroz stavke, Home/End na krajeve, Enter/Space biraju,
 * Esc i Tab zatvaraju. Fokus na otvaranju ide na prvu dostupnu stavku.
 */

/**
 * Stavka menija. Ista struktura je i `RowAction` u `DataTable` — jedan oblik,
 * dva imena, da ekran koji zadaje `rowActions` ne mora da zna za ovaj modul.
 */
export interface ContextMenuItem {
  /** Stabilan ključ stavke (React key + test hook). */
  kljuc: string;
  /** Vidljivi tekst stavke. */
  labela: string;
  /** Poziva se na izbor; meni se zatvara pre poziva. */
  onSelect: () => void;
  /** Razlog zašto stavka ne radi. Postavljen = stavka je siva + tooltip. */
  onemoguceno?: string;
  /** Destruktivna akcija (brisanje/storno) — crvena. */
  opasno?: boolean;
}

/** Tačka otvaranja u KLIJENTSKIM koordinatama (`clientX/Y` ili `getBoundingClientRect()`). */
export interface ContextMenuOrigin {
  x: number;
  y: number;
}

interface ContextMenuProps {
  /** `null` = zatvoreno. Promena koordinata premešta otvoren meni. */
  origin: ContextMenuOrigin | null;
  items: ContextMenuItem[];
  /** Sitan naslov iznad stavki — kontekst na koji se odnose (šifra, naziv reda). */
  header?: ReactNode;
  onClose: () => void;
  /** Pristupačno ime menija za čitač ekrana. */
  ariaLabel?: string;
}

/**
 * Razmak od ivice ekrana pri klampovanju. Dva koraka 4px mreže (§3) — dovoljno
 * da se senka menija vidi, a da meni ne „lebdi" odvojen od ivice.
 */
const IVICA = 8;

/**
 * `useLayoutEffect` na serveru ne radi ništa i React na to upozorava pri
 * prerenderu — a meni je montiran (zatvoren) na svakoj strani sa `rowActions`.
 * Grana je konstanta po okruženju, pa je redosled hukova stabilan.
 */
const useLayoutEffectIsomorphic = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

export function ContextMenu({
  origin,
  items,
  header,
  onClose,
  ariaLabel = 'Meni akcija',
}: ContextMenuProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  /** Izmerena pozicija ZA ODREĐENU tačku otvaranja — dok se ne poklopi, meni je nevidljiv. */
  const [placed, setPlaced] = useState<{ x: number; y: number; left: number; top: number } | null>(
    null,
  );

  const open = origin != null;
  const x = origin?.x;
  const y = origin?.y;

  // Esc pripada NAJGORNJEM sloju. Meni otvoren nad dijalogom zatvara samo sebe.
  useEscapeLayer(open, onClose);

  useLayoutEffectIsomorphic(() => {
    if (x == null || y == null) return;
    const el = panelRef.current;
    if (!el) return;

    const { width, height } = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Prvo prevrtanje (meni se otvara „na drugu stranu" tačke), pa tek onda
    // pritezanje uz ivicu — obrnut redosled bi na dnu ekrana zalepio meni preko
    // reda na koji je korisnik kliknuo.
    const flippedTop = y + height + IVICA > vh ? y - height : y;
    const flippedLeft = x + width + IVICA > vw ? x - width : x;

    const left = Math.max(IVICA, Math.min(flippedLeft, vw - width - IVICA));
    const top = Math.max(IVICA, Math.min(flippedTop, vh - height - IVICA));

    // Identična pozicija se NE upisuje ponovo: `header` sme biti JSX koji
    // pozivalac gradi u svakom renderu, pa bi bezuslovan `setPlaced` (uvek nov
    // objekat) vrteo render → efekat → render u krug.
    setPlaced((prev) =>
      prev && prev.x === x && prev.y === y && prev.left === left && prev.top === top
        ? prev
        : { x, y, left, top },
    );
  }, [x, y, items.length, header]);

  // Fokus na prvu dostupnu stavku — meni se koristi i sa tastature (Shift+F10).
  //
  // Zavisnost je SAMO tačka otvaranja, ne i `items`: pozivalac gradi listu iz
  // `rowActions(row)` u svakom renderu, pa bi identitet niza vraćao fokus na
  // prvu stavku pri svakoj promeni stanja roditelja — korisnik ne bi mogao da
  // strelicama siđe do treće akcije.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    const prvi = items.findIndex((it) => !it.onemoguceno);
    itemRefs.current[prvi === -1 ? 0 : prvi]?.focus();
  }, [open, x, y]);

  // Zatvaranje na klik izvan / skrol / promenu veličine prozora.
  //
  // `setTimeout(0)`: slušaoci se kače tek posle tekućeg događaja. Bez toga isti
  // `mousedown` koji je otvorio meni (dugme „…") odmah bi ga i zatvorio.
  useEffect(() => {
    if (!open) return;
    const napolje = (e: Event) => {
      if (panelRef.current?.contains(e.target as Node)) return;
      onClose();
    };
    const zatvori = () => onClose();
    const t = setTimeout(() => {
      window.addEventListener('mousedown', napolje);
      window.addEventListener('touchstart', napolje);
      window.addEventListener('scroll', zatvori, true);
      window.addEventListener('resize', zatvori);
    }, 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener('mousedown', napolje);
      window.removeEventListener('touchstart', napolje);
      window.removeEventListener('scroll', zatvori, true);
      window.removeEventListener('resize', zatvori);
    };
  }, [open, onClose]);

  const pomeriFokus = useCallback(
    (od: number, korak: 1 | -1) => {
      const n = items.length;
      if (!n) return;
      for (let i = 1; i <= n; i++) {
        // `((v % n) + n) % n` — JS `%` čuva znak, pa gola `%` na ↑ vraća negativan indeks.
        const idx = (((od + korak * i) % n) + n) % n;
        if (!items[idx]?.onemoguceno) {
          itemRefs.current[idx]?.focus();
          return;
        }
      }
    },
    [items],
  );

  const izaberi = useCallback(
    (it: ContextMenuItem) => {
      if (it.onemoguceno) return;
      // Prvo zatvaranje, pa akcija: akcija sme da otvori dijalog ili da odvede
      // na drugu rutu, a meni tad više ne postoji da ga iko zatvori.
      onClose();
      it.onSelect();
    },
    [onClose],
  );

  function onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    const aktivni = itemRefs.current.findIndex((el) => el === document.activeElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      pomeriFokus(aktivni === -1 ? -1 : aktivni, 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      pomeriFokus(aktivni === -1 ? 0 : aktivni, -1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      pomeriFokus(-1, 1);
    } else if (e.key === 'End') {
      e.preventDefault();
      pomeriFokus(0, -1);
    } else if (e.key === 'Tab') {
      onClose();
    }
  }

  if (!open) return null;

  const izmereno = placed != null && placed.x === x && placed.y === y;

  return (
    <div
      ref={panelRef}
      role="menu"
      aria-label={ariaLabel}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
      className={cn(
        'fixed z-50 min-w-52 max-w-80 overflow-hidden',
        'rounded-panel border border-line bg-surface py-1 shadow-xl',
      )}
      style={{
        left: izmereno ? placed.left : (x ?? 0),
        top: izmereno ? placed.top : (y ?? 0),
        // Dok pozicija nije izmerena meni postoji (da se IZMERI), ali se ne vidi.
        // `useLayoutEffect` odradi merenje pre iscrtavanja, pa ovo nikad ne trepne.
        visibility: izmereno ? 'visible' : 'hidden',
      }}
    >
      {header && (
        <div className="truncate border-b border-line-soft px-3 py-1 text-2xs text-ink-secondary">
          {header}
        </div>
      )}
      {items.map((it, i) => {
        const zakljucano = !!it.onemoguceno;
        return (
          <button
            key={it.kljuc}
            ref={(el) => {
              itemRefs.current[i] = el;
            }}
            role="menuitem"
            type="button"
            tabIndex={-1}
            aria-disabled={zakljucano || undefined}
            title={it.onemoguceno}
            onClick={() => izaberi(it)}
            className={cn(
              'block w-full px-3 py-1.5 text-left text-sm',
              'max-sm:min-h-11 pointer-coarse:min-h-11',
              'focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]',
              zakljucano
                ? 'cursor-not-allowed text-ink-disabled'
                : cn(
                    'hover:bg-surface-2 active:bg-line-soft',
                    it.opasno ? 'text-status-danger' : 'text-ink',
                  ),
            )}
          >
            {it.labela}
          </button>
        );
      })}
    </div>
  );
}
