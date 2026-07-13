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
          'min-h-20 w-full rounded-control border border-line bg-surface px-3 py-2 text-base text-ink',
          'placeholder:text-ink-disabled',
          'focus-visible:outline-none focus-visible:border-accent focus-visible:shadow-[var(--focus-ring)]',
          className,
        )}
        {...props}
      />
    );
  },
);
