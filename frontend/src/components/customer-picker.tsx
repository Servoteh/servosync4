'use client';

import { useState } from 'react';
import { ComboBox } from '@/components/ui-kit/combo-box';
import { useCustomersLookup, type CustomerLookup } from '@/api/lookups';

/**
 * CustomerPicker — reusable biranje komitenta sa pretragom (Talas 2 §A1).
 * Tanak omotač oko `ComboBox` nad postojećim `useCustomersLookup` hook-om
 * (isti izvor kao 1C link-dialog). Kucaš naziv ili PIB → server vrati do 25 →
 * dropdown prikazuje naziv (glavno), PIB i mesto (podnaslov) → izbor zove
 * `onSelect(id, naziv)`; brisanje izbora zove `onSelect(null, null)`.
 *
 * Sam drži izabranog komitenta (nekontrolisano) — parent samo prima `onSelect`
 * i njime povlači podatke vezane za komitenta (npr. kartica komitenta). Ne zove
 * API direktno — samo kroz `useCustomersLookup` (frontend/CLAUDE.md §8).
 */
export interface CustomerPickerProps {
  /** Izbor komitenta (id, naziv) ili brisanje izbora (null, null). */
  onSelect: (id: number | null, name: string | null) => void;
  placeholder?: string;
}

export function CustomerPicker({ onSelect, placeholder }: CustomerPickerProps) {
  const [picked, setPicked] = useState<CustomerLookup | null>(null);

  return (
    <ComboBox<CustomerLookup>
      value={picked}
      onChange={(c) => {
        setPicked(c);
        onSelect(c?.id ?? null, c?.name ?? null);
      }}
      useSearch={useCustomersLookup}
      getKey={(c) => c.id}
      getLabel={(c) => c.name}
      getSublabel={(c) =>
        [c.taxId ? `PIB ${c.taxId}` : null, c.city].filter(Boolean).join(' · ')
      }
      placeholder={placeholder ?? 'Kucaj naziv ili PIB komitenta…'}
    />
  );
}
