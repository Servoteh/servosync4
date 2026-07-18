import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return (
      <input
        ref={ref}
        className={cn(
          'h-9 w-full rounded-control border border-line bg-surface px-3 text-base text-ink',
          'placeholder:text-ink-disabled',
          'focus-visible:outline-none focus-visible:border-accent focus-visible:shadow-[var(--focus-ring)]',
          className,
        )}
        {...props}
      />
    );
  },
);

interface FormFieldProps {
  label: string;
  required?: boolean;
  error?: string;
  hint?: string;
  children: ReactNode;
}

/** Label iznad polja, `*` za obavezno, greška ispod (DESIGN_SYSTEM.md §6). */
export function FormField({ label, required, error, hint, children }: FormFieldProps) {
  return (
    <div className="space-y-1.5">
      <label className="block text-base font-medium text-ink">
        {label}
        {required && <span className="text-status-danger"> *</span>}
      </label>
      {children}
      {error ? (
        <p className="text-xs text-status-danger" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-ink-secondary">{hint}</p>
      ) : null}
    </div>
  );
}
