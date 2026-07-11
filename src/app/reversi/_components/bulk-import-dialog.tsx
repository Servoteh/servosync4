'use client';

import { useState } from 'react';
import * as XLSX from 'xlsx';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { useBulkImportTools, type BulkImportResult, type BulkToolRow } from '@/api/reversi';

// Kolone se auto-mapiraju po nazivu zaglavlja (aliasi, paritet 1.0 bulkImportModal).
const ALIASES: Record<keyof BulkToolRow, string[]> = {
  oznaka: ['oznaka', 'sifra', 'šifra', 'kod', 'code'],
  naziv: ['naziv', 'name', 'opis'],
  serijskiBroj: ['serijski', 'serijski broj', 'serial', 's/n', 'sn'],
  isQuantity: ['kolicinski', 'količinski', 'quantity', 'na komad'],
  isConsumable: ['potrosni', 'potrošni', 'consumable'],
  totalQty: ['kolicina', 'količina', 'pocetna kolicina', 'početna količina', 'stanje', 'qty'],
  napomena: ['napomena', 'note', 'komentar'],
};

function truthy(v: unknown): boolean {
  const s = String(v ?? '').trim().toLowerCase();
  return s === 'da' || s === 'true' || s === '1' || s === 'x' || s === 'yes';
}

function mapRows(raw: Record<string, unknown>[]): { rows: BulkToolRow[]; ignored: number } {
  let ignored = 0;
  const rows: BulkToolRow[] = [];
  for (const r of raw) {
    // normalizuj ključeve zaglavlja
    const lower: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) lower[k.trim().toLowerCase()] = v;
    const pick = (key: keyof BulkToolRow): unknown => {
      for (const a of ALIASES[key]) if (a in lower && String(lower[a]).trim() !== '') return lower[a];
      return undefined;
    };
    const oznaka = String(pick('oznaka') ?? '').trim();
    const naziv = String(pick('naziv') ?? '').trim();
    if (!oznaka || !naziv) {
      ignored++;
      continue;
    }
    const qtyRaw = pick('totalQty');
    rows.push({
      oznaka,
      naziv,
      serijskiBroj: pick('serijskiBroj') ? String(pick('serijskiBroj')).trim() : undefined,
      isQuantity: pick('isQuantity') !== undefined ? truthy(pick('isQuantity')) : undefined,
      isConsumable: pick('isConsumable') !== undefined ? truthy(pick('isConsumable')) : undefined,
      totalQty: qtyRaw !== undefined && qtyRaw !== '' ? Math.max(0, Math.round(Number(qtyRaw)) || 0) : undefined,
      napomena: pick('napomena') ? String(pick('napomena')).trim() : undefined,
    });
  }
  return { rows, ignored };
}

/** Bulk-import inventara ručnog alata iz XLSX/CSV (paritet 1.0 bulkImportModal tip 1). */
export function BulkImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const importer = useBulkImportTools();
  const [rows, setRows] = useState<BulkToolRow[]>([]);
  const [ignored, setIgnored] = useState(0);
  const [fileName, setFileName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BulkImportResult | null>(null);

  async function onFile(file: File) {
    setError(null);
    setResult(null);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      if (!sheet) throw new Error('Fajl je prazan.');
      const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });
      const mapped = mapRows(raw);
      setRows(mapped.rows);
      setIgnored(mapped.ignored);
      setFileName(file.name);
      if (mapped.rows.length === 0) setError('Nijedan red nema kolone „oznaka" i „naziv".');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Fajl nije moguće pročitati.');
    }
  }

  async function submit() {
    setError(null);
    try {
      const res = await importer.mutateAsync(rows);
      setResult(res.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Uvoz nije uspeo.');
    }
  }

  function reset() {
    setRows([]);
    setIgnored(0);
    setFileName('');
    setResult(null);
    setError(null);
  }

  return (
    <Dialog
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="Uvoz alata (XLSX / CSV)"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={() => { reset(); onClose(); }}>
            {result ? 'Zatvori' : 'Otkaži'}
          </Button>
          {!result && (
            <Button loading={importer.isPending} disabled={rows.length === 0} onClick={() => void submit()}>
              Uvezi {rows.length ? `(${rows.length})` : ''}
            </Button>
          )}
        </div>
      }
    >
      <div className="space-y-3">
        {!result && (
          <>
            <p className="text-sm text-ink-secondary">
              Prvi red = zaglavlje. Obavezne kolone: <strong>oznaka</strong>, <strong>naziv</strong>. Opcione:
              serijski broj, količinski/potrošni, količina, napomena. Postojeći alat (ista oznaka) se preskače.
            </p>
            <input
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={(e) => {
                const f = e.target.files?.[0];
                // Očisti value da izbor ISTOG fajla drugi put (npr. posle ispravke
                // u Excelu) ponovo okine onChange.
                e.target.value = '';
                if (f) void onFile(f);
              }}
              className="block w-full text-sm text-ink file:mr-3 file:rounded-control file:border file:border-line file:bg-surface-2 file:px-3 file:py-1.5 file:text-sm"
            />
            {fileName && (
              <div className="rounded-control border border-line p-2 text-sm">
                <div className="font-medium">{fileName}</div>
                <div className="text-ink-secondary">
                  {rows.length} za uvoz{ignored > 0 ? ` · ${ignored} preskočeno (bez oznake/naziva)` : ''}
                </div>
                {rows.slice(0, 5).map((r, i) => (
                  <div key={i} className="mt-1 flex gap-2 text-xs text-ink-secondary">
                    <span className="font-medium text-ink">{r.oznaka}</span>
                    <span>{r.naziv}</span>
                    {r.serijskiBroj && <span>· {r.serijskiBroj}</span>}
                  </div>
                ))}
                {rows.length > 5 && <div className="mt-1 text-xs text-ink-secondary">… i još {rows.length - 5}</div>}
              </div>
            )}
          </>
        )}

        {result && (
          <div className="space-y-1 rounded-control border border-line p-3 text-sm">
            <div>✅ Kreirano: <strong>{result.created}</strong></div>
            <div>↷ Preskočeno (već postoji): <strong>{result.skipped}</strong></div>
            {result.errors.length > 0 && (
              <div className="pt-1 text-status-danger">
                Greške ({result.errors.length}):
                {result.errors.slice(0, 5).map((er, i) => (
                  <div key={i} className="text-xs">{er.oznaka}: {er.error}</div>
                ))}
              </div>
            )}
          </div>
        )}

        {error && <p className="text-sm text-status-danger" role="alert">{error}</p>}
      </div>
    </Dialog>
  );
}
