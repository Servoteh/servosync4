import { forwardRef, type SelectHTMLAttributes } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/cn';

export interface SelectOption {
  value: string;
  label: string;
  /** Prikazano ali neizborno (npr. ukinuta šifra koja se još vidi u starim zapisima). */
  disabled?: boolean;
}

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  /** Fiksna lista opcija. Za velike šifarnike sa pretragom koristi `ComboBox`. */
  options: SelectOption[];
  /** Tekst prazne opcije (`value=""`). Bez njega nema prazne opcije. */
  placeholder?: string;
}

/**
 * Biranje iz kratke fiksne liste (DESIGN_SYSTEM.md §10). Omotava **native
 * `<select>`** — tastatura, touch i čitači ekrana rade bez našeg koda, a na
 * telefonu se dobija sistemski točkić. Isti tokeni kao `Input`; strelica je
 * `ChevronDown` (kao kod `ComboBox`-a) preko `appearance-none`, da izgled bude
 * isti na svim platformama. Tamnu temu pokrivaju tokeni + `color-scheme`.
 *
 * Kad lista ima ~15+ stavki ili dolazi sa servera — `ComboBox`, ne ovo.
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { options, placeholder, className, ...props },
  ref,
) {
  return (
    <div className="relative w-full">
      <select
        ref={ref}
        className={cn(
          'h-9 w-full appearance-none rounded-control border border-line bg-surface pl-3 pr-9 text-base text-ink',
          'focus-visible:outline-none focus-visible:border-accent focus-visible:shadow-[var(--focus-ring)]',
          'disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-ink-secondary',
          className,
        )}
        {...props}
      >
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-disabled"
        aria-hidden
      />
    </div>
  );
});
