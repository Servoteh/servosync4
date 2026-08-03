import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  loading?: boolean;
}

/**
 * Svaka varijanta MORA imati `active:` stanje, ne samo `hover:`.
 * Tailwind v4 kompajlira `hover:` u `@media (hover: hover)` → na uređaju sa
 * prstom (telefon/tablet u pogonu) se NIKAD ne okine, pa je dugme bez `active:`
 * potpuno nemo na dodir: radnik ne vidi da je pritisak primljen i tapne drugi put.
 * Pritisnuto stanje ide TON DALJE od hover-a (`line-soft`, ne `surface-2`) — u
 * svetloj temi je `surface-2` (#fbfcfc) praktično nerazlučiv od `surface`.
 */
const variants: Record<Variant, string> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-hover active:bg-accent-active',
  secondary: 'border border-line bg-surface text-ink hover:bg-surface-2 active:bg-line-soft',
  ghost: 'text-ink-secondary hover:bg-surface-2 hover:text-ink active:bg-line-soft active:text-ink',
  danger:
    'border border-status-danger/40 bg-status-danger-bg text-status-danger hover:bg-status-danger/15 active:bg-status-danger/25',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', loading, disabled, className, children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        // Osnovna visina je DESKTOP ritam (36px), a touch meta se dodaje kao
        // `min-height` — NIKAD kao `sm:h-*`.
        //
        // Zašto: `cn()` je twMerge, a twMerge poredi samo klase u ISTOJ variant
        // grupi. `twMerge('h-11 sm:h-9', 'h-14')` zadržava i `sm:h-9`, pa je
        // pozivaočeva visina od 640px naviše tiho padala na 36px — pogođeni su
        // telefon U PEJZAŽU (360×800dp = 800 CSS px) i svaki tablet u pogonu, a
        // na desktopu su sve guste akcije po tabelama (`h-6`/`h-7`/`h-8`) bile
        // naduvane na 36px. Meta se zato zadaje kao POD (`min-h-11`): `h-14`
        // ostaje 56px, a `min-height` samo diže ono što je manje od 44px.
        //
        // Uslov je PRST, ne širina: `pointer-coarse` hvata tablet i telefon u
        // pejzažu (koje `max-width` propušta), a `max-sm` zadržava staro pravilo
        // za uzak prozor na desktopu i zatvara mrtvu zonu koju je imao
        // `max-width: 39.99rem` (639.84–640px).
        'inline-flex h-9 items-center justify-center gap-2 rounded-control px-4 text-base font-medium',
        'max-sm:min-h-11 pointer-coarse:min-h-11',
        'transition-colors focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]',
        'disabled:opacity-50 disabled:pointer-events-none',
        variants[variant],
        className,
      )}
      {...props}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
});
