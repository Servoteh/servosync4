'use client';

import { Download } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { exportTableToCsv, type CsvColumn } from '@/lib/table-csv';

/**
 * Platformsko dugme „Izvezi CSV" (Talas 3 A6) — klijentski izvoz DataTable liste.
 * Sekundarni stil (pored ostalih akcija tabele), ikonica Download. Onemogućeno kad
 * nema redova. `columns.value(row)` daje čistu vrednost (ne markap ćelije), pa CSV
 * odgovara podacima; izvoz ide preko `exportTableToCsv` (BOM + `;` za Excel sr).
 *
 * Bez novih zavisnosti; koristi postojeći `Button` kit (bez size prop-a).
 */
export function ExportCsvButton<T>({
  columns,
  rows,
  filename,
  label = 'Izvezi CSV',
  title,
  disabled,
}: {
  columns: CsvColumn<T>[];
  rows: T[];
  /** Naziv fajla bez ekstenzije (dodaje se `.csv`). */
  filename: string;
  label?: string;
  title?: string;
  disabled?: boolean;
}) {
  const empty = rows.length === 0;
  return (
    <Button
      type="button"
      variant="secondary"
      disabled={disabled || empty}
      title={title ?? (empty ? 'Nema redova za izvoz' : 'Izvezi prikazanu tabelu kao CSV')}
      onClick={() => exportTableToCsv(columns, rows, filename)}
    >
      <Download className="h-4 w-4" aria-hidden />
      {label}
    </Button>
  );
}
