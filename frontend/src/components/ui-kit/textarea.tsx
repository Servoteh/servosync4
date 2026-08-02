import { forwardRef, type TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

/**
 * Višelinijsko tekstualno polje (DESIGN_SYSTEM.md §10). Isti tokeni kao `Input`,
 * ali Enter pravi novi red (native ponašanje). `rows` podrazumevano 3.
 */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, rows = 3, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        rows={rows}
        className={cn(
          // Telefon (< sm): 16px tekst — ispod toga iOS zumira stranu na fokus i
          // ne vraća zum na blur (DS §11). Visina je već preko 44px (`min-h-20`).
          'min-h-20 w-full rounded-control border border-line bg-surface px-3 py-2 text-md text-ink sm:text-base',
          'placeholder:text-ink-disabled',
          'focus-visible:outline-none focus-visible:border-accent focus-visible:shadow-[var(--focus-ring)]',
          className,
        )}
        {...props}
      />
    );
  },
);
