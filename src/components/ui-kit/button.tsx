import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/cn';

type Variant = 'primary' | 'secondary' | 'ghost';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  loading?: boolean;
}

const variants: Record<Variant, string> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-hover active:bg-accent-active',
  secondary: 'border border-line bg-surface text-ink hover:bg-surface-2',
  ghost: 'text-ink-secondary hover:bg-surface-2 hover:text-ink',
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
        'inline-flex h-9 items-center justify-center gap-2 rounded-control px-4 text-base font-medium',
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
