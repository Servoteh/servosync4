'use client';

import { useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useEscapeLayer } from './escape-layer';

const SIZE_CLASS = {
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-3xl',
  // xl2 = namerno širi (896px) za guste tabele (Istorija zarada); ne preklapa deljeni `xl`.
  xl2: 'max-w-4xl',
  '2xl': 'max-w-6xl',
} as const;

/**
 * Gde panel sedi: `center` = klasičan centrirani modal · `sheet` = donji sheet
 * (fioka uz donju ivicu) · `auto` (podrazumevano) = sheet na telefonu, centriran
 * od `sm` naviše — DESIGN_SYSTEM §11 („Dijalozi/forme: na telefonu full-screen
 * sheet"). Centrirani modal je na iPhone-u lomio unos: sa otvorenom tastaturom
 * footer sa „Sačuvaj" ode ispod nje, a iOS ne skroluje fiksirane elemente.
 */
const VARIANT = {
  auto: {
    scrim: 'items-end p-0 sm:items-center sm:p-4',
    panel: 'rounded-t-panel sm:rounded-panel',
    // Home-indicator zona (env(...) je živ tek uz viewport-fit=cover — app/layout.tsx).
    // `safeFooter` ide na footer (py-3), `safeBody` na telo kad footera nema (py-4).
    safeFooter: 'pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))] sm:pb-3',
    safeBody: 'pb-[calc(1rem+env(safe-area-inset-bottom,0px))] sm:pb-4',
  },
  sheet: {
    scrim: 'items-end p-0',
    panel: 'rounded-t-panel',
    safeFooter: 'pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))]',
    safeBody: 'pb-[calc(1rem+env(safe-area-inset-bottom,0px))]',
  },
  center: {
    scrim: 'items-center p-4',
    panel: 'rounded-panel',
    safeFooter: 'pb-3',
    safeBody: 'pb-4',
  },
} as const;

/** Modalni dijalog (DESIGN_SYSTEM.md §4/§10). Esc zatvara; klik na pozadinu zatvara. */
export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  size = 'md',
  variant = 'auto',
  dismissable = true,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  /** Širina modala: md (≈ obrazac), lg/xl/2xl (šire tabele/zarade). */
  size?: keyof typeof SIZE_CLASS;
  /** Položaj: `auto` (sheet na telefonu, centriran na desktopu) · `sheet` · `center`. */
  variant?: keyof typeof VARIANT;
  /** false = zatvara samo eksplicitno (X / Otkaži); Esc i klik na pozadinu ne zatvaraju (obrasci sa unosom). */
  dismissable?: boolean;
}) {
  // Press-origin dismissal: pozadina zatvara samo ako su i mousedown i mouseup na
  // scrim-u. Drag-selekcija teksta iz polja koja se otpusti van panela NE sme da
  // zatvori dijalog (inače bi se click dispatch-ovao na scrim kao zajedničkog pretka).
  const downOnBackdrop = useRef(false);

  // Esc PRIPADA OTVORENOM DIJALOGU, i kad dijalog nije `dismissable`.
  // Ekran ispod takođe sluša `window` za Esc („Nazad na listu"), pa su se ranije
  // okidala OBA — dijalog bi se zatvorio, uneseni tekst nestao, a korisnik bi
  // usput bio izbačen na listu (dokazano na 4 od 5 ekrana detalja; samo je
  // nabavka imala ručni `&& !rfqOpen` guard). Umesto da se to pravilo ponavlja
  // na svakom ekranu, drži se ovde — na jedinom mestu koje zna da je modalni
  // sloj otvoren.
  //
  // Sloj se prijavljuje `useEscapeLayer`-u umesto da sam kači capture-slušalac
  // na `window`. Sopstveni slušalac je rešavao sukob sa ekranom ispod, ali je
  // stvarao gori: `stopPropagation` ne zaustavlja druge slušaoce na ISTOM čvoru,
  // pa su se kod ugnežđenih slojeva okidali svi odjednom i Esc nad karticom
  // potvrde zatvarao ceo tok (regresija V11 — v. `escape-layer.ts`).
  //
  // Sloj se drži i kad `dismissable` nije uključen: tada Esc ne zatvara ništa,
  // ali ga dijalog i dalje MORA progutati, da ne procuri na ekran ispod.
  useEscapeLayer(open, () => {
    if (dismissable) onClose();
  });

  if (!open) return null;
  const v = VARIANT[variant];
  return (
    <div
      className={`fixed inset-0 z-50 flex justify-center bg-black/40 ${v.scrim}`}
      onMouseDown={(e) => { downOnBackdrop.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (dismissable && downOnBackdrop.current && e.target === e.currentTarget) onClose(); }}
      role="presentation"
    >
      {/* Panel je flex kolona sa `max-h-[90dvh]`: zaglavlje i footer ostaju
          vidljivi, a skroluje se samo telo. `dvh` (ne `vh`) jer je `100vh` na
          iOS-u veliki viewport — sa izvučenom adresnom trakom bi footer sa
          „Sačuvaj" ostao ispod donje ivice ekrana. */}
      <div
        className={`flex max-h-[90dvh] w-full flex-col ${SIZE_CLASS[size]} border border-line bg-surface shadow-xl ${v.panel}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-line px-5 py-3">
          <h2 className="text-md font-semibold text-ink">{title}</h2>
          <button
            onClick={onClose}
            // Meta ≥ 44px na telefonu (DS §11); na desktopu ostaje diskretna ikona.
            className="grid min-h-11 min-w-11 place-items-center rounded-control p-1 text-ink-secondary hover:bg-surface-2 sm:min-h-0 sm:min-w-0"
            aria-label="Zatvori"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        {/* `overscroll-contain`: skrol na kraju liste u dijalogu ne sme da
            „procuri" na stranu ispod (iOS je zna i da povuče u pull-to-refresh). */}
        <div
          className={`min-h-0 max-h-[70dvh] flex-1 overflow-auto overscroll-contain px-5 pt-4 ${footer ? 'pb-4' : v.safeBody}`}
        >
          {children}
        </div>
        {footer && (
          <div className={`flex shrink-0 justify-end gap-2 border-t border-line px-5 pt-3 ${v.safeFooter}`}>
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
