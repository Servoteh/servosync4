'use client';

import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { newClientEventId, useCreateEmployee } from '@/api/kadrovska';
import { isValidJmbgFormat, parseJmbg } from '@/lib/jmbg';
import { cn } from '@/lib/cn';

// ⚡ Brzi / bulk unos zaposlenih — port 1.0 employeesBulkModal.js.
// Dva moda: (1) „Brzi unos" inline grid (Tab/Enter navigacija, auto novi red,
// live validacija, JMBG → auto pol+datum rođenja), (2) „Import iz Excel/CSV"
// (SheetJS parse, mapiranje kolona po aliasima, preview sa validacijom).
// PII kolone (JMBG, adresa, banka…) vidi samo kadrovska.pii.
// Snimanje = POST /employees red-po-red (1.0 saveEmployeeToDb paritet).

interface ColDef {
  key: string;
  label: string;
  type: 'text' | 'date' | 'email' | 'tel' | 'bool' | 'jmbg' | 'gender';
  width?: number;
  required?: boolean;
  sensitive?: boolean;
  default?: boolean;
  aliases?: string[];
}

const COLUMNS: ColDef[] = [
  { key: 'firstName', label: 'Ime', type: 'text', width: 130, required: true, aliases: ['ime', 'firstname', 'first name'] },
  { key: 'lastName', label: 'Prezime', type: 'text', width: 140, required: true, aliases: ['prezime', 'lastname', 'last name', 'surname'] },
  { key: 'position', label: 'Pozicija', type: 'text', width: 150, aliases: ['pozicija', 'position', 'radno mesto'] },
  { key: 'department', label: 'Odeljenje', type: 'text', width: 140, aliases: ['odeljenje', 'department', 'sektor'] },
  { key: 'team', label: 'Tim', type: 'text', width: 110, aliases: ['tim', 'team'] },
  { key: 'hireDate', label: 'Zaposlen od', type: 'date', width: 140, required: true, aliases: ['zaposlen od', 'hire date', 'datum zaposlenja', 'hiredate'] },
  { key: 'email', label: 'Email', type: 'email', width: 180, aliases: ['email', 'e-mail', 'mail'] },
  { key: 'phoneWork', label: 'Telefon (posao)', type: 'tel', width: 130, aliases: ['telefon', 'telefon posao', 'phone', 'phone work', 'tel'] },
  { key: 'isActive', label: 'Aktivan', type: 'bool', width: 70, default: true, aliases: ['aktivan', 'active', 'status'] },
  { key: 'personalId', label: 'JMBG', type: 'jmbg', width: 140, sensitive: true, aliases: ['jmbg', 'personal id', 'pib'] },
  { key: 'gender', label: 'Pol (M/Z)', type: 'gender', width: 80, sensitive: true, aliases: ['pol', 'gender'] },
  { key: 'birthDate', label: 'Datum rođenja', type: 'date', width: 140, sensitive: true, aliases: ['datum rodjenja', 'datum rođenja', 'birth date', 'birthdate'] },
  { key: 'address', label: 'Adresa', type: 'text', width: 180, sensitive: true, aliases: ['adresa', 'address'] },
  { key: 'city', label: 'Mesto', type: 'text', width: 130, sensitive: true, aliases: ['mesto', 'grad', 'city'] },
  { key: 'postalCode', label: 'Poštanski br.', type: 'text', width: 100, sensitive: true, aliases: ['postanski', 'poštanski', 'postal code', 'zip'] },
  { key: 'bankName', label: 'Banka', type: 'text', width: 140, sensitive: true, aliases: ['banka', 'bank', 'bank name'] },
  { key: 'bankAccount', label: 'Broj računa', type: 'text', width: 160, sensitive: true, aliases: ['broj racuna', 'broj računa', 'racun', 'bank account', 'iban'] },
];

type Row = Record<string, string | boolean>;

function makeEmptyRow(cols: ColDef[]): Row {
  const r: Row = {};
  for (const c of cols) r[c.key] = c.default !== undefined ? c.default : '';
  return r;
}

function isRowEmpty(r: Row, cols: ColDef[]): boolean {
  return cols.every((c) => {
    const v = r[c.key];
    return !v || (c.type === 'bool' && v === (c.default ?? false));
  });
}

/** Greške jednog reda (prazan niz = validan) — 1.0 validateRow paritet. */
function validateRow(r: Row, cols: ColDef[]): string[] {
  const errs: string[] = [];
  for (const c of cols) {
    const v = r[c.key];
    if (c.required && !v) {
      errs.push(`${c.label} je obavezno`);
      continue;
    }
    if (!v || typeof v !== 'string') continue;
    if (c.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) errs.push(`${c.label}: očekujem YYYY-MM-DD`);
    if (c.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) errs.push(`${c.label}: neispravan email`);
    if (c.type === 'jmbg' && !isValidJmbgFormat(v)) errs.push(`${c.label}: mora imati 13 cifara`);
    if (c.type === 'gender' && !/^(M|Z)$/i.test(v)) errs.push(`${c.label}: M ili Z`);
  }
  return errs;
}

/** Excel vrednost → ISO YYYY-MM-DD (serial / Date / DD.MM.YYYY / ISO). */
function normalizeDate(val: unknown): string {
  if (!val && val !== 0) return '';
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  if (typeof val === 'number') {
    const ms = Math.round((val - 25569) * 86400 * 1000);
    const d = new Date(ms);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  const s = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})\.?$/);
  if (m) {
    let y = +m[3];
    if (y < 100) y += y < 50 ? 2000 : 1900;
    return `${y}-${String(+m[2]).padStart(2, '0')}-${String(+m[1]).padStart(2, '0')}`;
  }
  return s;
}

function normalizeBool(val: unknown): boolean {
  if (val === true || val === false) return val;
  const s = String(val ?? '').trim().toLowerCase();
  if (['1', 'true', 'da', 'yes', 'y', 'aktivan'].includes(s)) return true;
  if (['0', 'false', 'ne', 'no', 'n', 'neaktivan'].includes(s)) return false;
  return true;
}

function normHeader(h: unknown): string {
  return String(h || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

/** JMBG → dopuni pol/datum rođenja ako fale. */
function jmbgAutofill(r: Row): void {
  const jmbg = String(r.personalId || '');
  const parsed = parseJmbg(jmbg);
  if (parsed) {
    if (!r.birthDate) r.birthDate = parsed.birthDate;
    if (!r.gender) r.gender = parsed.gender;
  }
}

export function EmpQuickEntryDialog({
  canPii,
  onClose,
  onDone,
}: {
  canPii: boolean;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const cols = useMemo(() => COLUMNS.filter((c) => canPii || !c.sensitive), [canPii]);
  const createMut = useCreateEmployee();

  const [mode, setMode] = useState<'grid' | 'import'>('grid');
  const [gridRows, setGridRows] = useState<Row[]>([makeEmptyRow(cols)]);
  const [importRows, setImportRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const rows = mode === 'grid' ? gridRows : importRows;
  const counted = rows.filter((r) => !isRowEmpty(r, cols));
  const okRows = counted.filter((r) => validateRow(r, cols).length === 0);
  const errCount = counted.length - okRows.length;

  function setCell(i: number, key: string, val: string | boolean) {
    setGridRows((prev) => {
      const next = prev.map((r, idx) => (idx === i ? { ...r, [key]: val } : r));
      if (key === 'personalId') jmbgAutofill(next[i]);
      // Auto novi red kad poslednji dobije bilo kakav sadržaj.
      if (i === next.length - 1 && !isRowEmpty(next[i], cols)) next.push(makeEmptyRow(cols));
      return next;
    });
  }

  /** Enter → isto polje u narednom redu (1.0 navigacija). */
  function onCellKeyDown(e: KeyboardEvent<HTMLElement>, i: number, key: string) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const next = gridRef.current?.querySelector<HTMLElement>(`[data-row="${i + 1}"][data-col="${key}"]`);
    next?.focus();
  }

  function delRow(i: number) {
    setGridRows((prev) => {
      const next = prev.filter((_, idx) => idx !== i);
      return next.length ? next : [makeEmptyRow(cols)];
    });
  }

  async function handleFile(file: File) {
    try {
      const XLSX = await import('xlsx');
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array', cellDates: true });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      if (!sheet) {
        onDone('⚠ Fajl je prazan');
        return;
      }
      const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '', raw: false, dateNF: 'yyyy-mm-dd' });
      const headerMap = new Map<string, ColDef>();
      if (raw.length > 0) {
        for (const hk of Object.keys(raw[0])) {
          const norm = normHeader(hk);
          const col = cols.find((c) => normHeader(c.label) === norm || (c.aliases || []).some((a) => normHeader(a) === norm));
          if (col) headerMap.set(hk, col);
        }
      }
      const mapped = raw
        .map((src) => {
          const r = makeEmptyRow(cols);
          for (const [hk, col] of headerMap.entries()) {
            let v: unknown = src[hk];
            if (v === undefined || v === null) continue;
            if (col.type === 'date') v = normalizeDate(v);
            else if (col.type === 'bool') v = normalizeBool(v);
            else if (col.type === 'jmbg') v = String(v).replace(/\D/g, '');
            else if (col.type === 'gender') v = String(v).trim().toUpperCase();
            else v = String(v).trim();
            r[col.key] = v as string | boolean;
          }
          jmbgAutofill(r);
          return r;
        })
        .filter((r) => !isRowEmpty(r, cols));
      setImportRows(mapped);
    } catch (e) {
      console.error('[bulk-import] parse fail', e);
      onDone('⚠ Ne mogu da pročitam fajl');
    }
  }

  async function downloadTemplate() {
    const XLSX = await import('xlsx');
    const header = cols.map((c) => c.label);
    const example = cols.map((c) => {
      switch (c.key) {
        case 'firstName': return 'Petar';
        case 'lastName': return 'Petrović';
        case 'position': return 'Monter';
        case 'department': return 'Montaža';
        case 'team': return 'Tim A';
        case 'hireDate': return '2025-01-15';
        case 'email': return 'petar@servoteh.com';
        case 'phoneWork': return '+381641234567';
        case 'isActive': return 'DA';
        case 'personalId': return '0101990710123';
        case 'gender': return 'M';
        case 'birthDate': return '1990-01-01';
        case 'address': return 'Knez Mihailova 1';
        case 'city': return 'Beograd';
        case 'postalCode': return '11000';
        case 'bankName': return 'Intesa';
        case 'bankAccount': return '160-0000000000000-00';
        default: return '';
      }
    });
    const ws = XLSX.utils.aoa_to_sheet([header, example]);
    ws['!cols'] = cols.map((c) => ({ wch: Math.max(c.label.length + 2, 14) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Zaposleni');
    const info = [
      ['Uputstvo za popunjavanje — Zaposleni'],
      [''],
      ['Obavezna polja: Ime, Prezime, „Zaposlen od" (datum)'],
      ['Datumi: YYYY-MM-DD (npr. 2025-03-14). Excel date ćelije se automatski konvertuju.'],
      ['Pol: M ili Z. JMBG mora imati 13 cifara. Iz JMBG-a se auto-popunjavaju pol i datum rođenja ako su prazni.'],
      ['„Aktivan": DA/NE (ili 1/0).'],
      [''],
      ['Osetljiva polja (JMBG, adresa, banka) unose admin i poslovni administrator.'],
    ];
    const wsInfo = XLSX.utils.aoa_to_sheet(info);
    wsInfo['!cols'] = [{ wch: 100 }];
    XLSX.utils.book_append_sheet(wb, wsInfo, 'Uputstvo');
    XLSX.writeFile(wb, `zaposleni-template-${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  async function saveAll() {
    if (!okRows.length) return;
    setBusy(true);
    let ok = 0;
    let fail = 0;
    for (const r of okRows) {
      const firstName = String(r.firstName || '').trim();
      const lastName = String(r.lastName || '').trim();
      try {
        await createMut.mutateAsync({
          clientEventId: newClientEventId(),
          firstName,
          lastName,
          fullName: [lastName, firstName].filter(Boolean).join(' '),
          workType: 'ugovor',
          position: String(r.position || '').trim() || null,
          department: String(r.department || '').trim() || null,
          team: String(r.team || '').trim() || null,
          hireDate: String(r.hireDate || '') || null,
          email: String(r.email || '').trim().toLowerCase(),
          phoneWork: String(r.phoneWork || '').trim(),
          isActive: r.isActive !== false,
          ...(canPii
            ? {
                personalId: String(r.personalId || '').trim() || null,
                gender: String(r.gender || '') || null,
                birthDate: String(r.birthDate || '') || null,
                address: String(r.address || '').trim() || null,
                city: String(r.city || '').trim() || null,
                postalCode: String(r.postalCode || '').trim() || null,
                bankName: String(r.bankName || '').trim() || null,
                bankAccount: String(r.bankAccount || '').trim() || null,
              }
            : {}),
        });
        ok++;
      } catch (e) {
        console.error('[bulk-save]', e);
        fail++;
      }
    }
    setBusy(false);
    onDone(fail === 0 ? `✔ Sačuvano ${ok} zaposlenih` : `✔ Sačuvano ${ok} · ⚠ ${fail} neuspešnih — proveri konzolu`);
    onClose();
  }

  const cellCls = 'h-8 w-full rounded-control border border-line bg-surface px-2 text-sm text-ink focus-visible:outline-none focus-visible:border-accent';
  const tabBtn = (m: 'grid' | 'import', label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={mode === m}
      onClick={() => setMode(m)}
      className={cn(
        'rounded-control px-3 py-1.5 text-sm font-medium',
        mode === m ? 'bg-accent-subtle text-accent' : 'text-ink-secondary hover:bg-surface-2',
      )}
    >
      {label}
    </button>
  );

  function statusCell(r: Row) {
    if (isRowEmpty(r, cols)) return <span className="text-xs text-ink-disabled">prazno</span>;
    const errs = validateRow(r, cols);
    if (errs.length === 0) return <span className="text-xs font-medium text-status-success">OK</span>;
    return (
      <span className="text-xs font-medium text-status-danger" title={errs.join('\n')}>
        {errs.length} {errs.length === 1 ? 'greška' : 'greške'}
      </span>
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      size="2xl"
      title="Brzi / bulk unos zaposlenih"
      footer={
        <div className="flex w-full flex-wrap items-center gap-3">
          <span className="text-sm text-ink-secondary">
            <strong className="text-ink">{counted.length}</strong> redova ·{' '}
            <span className="text-status-success">✔ {okRows.length} validno</span>
            {errCount > 0 && <span className="text-status-danger"> · ✖ {errCount} sa greškama</span>}
          </span>
          <span className="ml-auto" />
          <Button variant="secondary" onClick={onClose}>Otkaži</Button>
          <Button onClick={() => void saveAll()} disabled={okRows.length === 0} loading={busy}>
            💾 Sačuvaj {okRows.length} {okRows.length === 1 ? 'zaposlenog' : 'zaposlenih'}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="flex items-center gap-1 border-b border-line pb-2" role="tablist">
          {tabBtn('grid', '⚡ Brzi unos')}
          {tabBtn('import', '📥 Import iz Excel/CSV')}
          <span className="ml-auto" />
          <Button variant="ghost" onClick={() => void downloadTemplate()} title="Preuzmi Excel template">
            📄 Template
          </Button>
        </div>

        {mode === 'grid' ? (
          <>
            <p className="text-xs text-ink-secondary">
              Tab/Enter za sledeće polje. Novi red se dodaje automatski. Posle JMBG-a auto-popunjavaju se pol i datum rođenja.
            </p>
            <div ref={gridRef} className="overflow-x-auto rounded-panel border border-line">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line bg-surface-2 text-left">
                    <th className="h-8 px-2 text-2xs font-semibold uppercase tracking-wider text-ink-secondary">#</th>
                    {cols.map((c) => (
                      <th key={c.key} className="h-8 px-1 text-2xs font-semibold uppercase tracking-wider text-ink-secondary" style={{ minWidth: c.width || 120 }}>
                        {c.label}
                        {c.required ? ' *' : ''}
                      </th>
                    ))}
                    <th className="h-8 px-2 text-2xs font-semibold uppercase tracking-wider text-ink-secondary">Status</th>
                    <th className="h-8 px-1" />
                  </tr>
                </thead>
                <tbody>
                  {gridRows.map((r, i) => (
                    <tr key={i} className="border-b border-line-soft">
                      <td className="tnums px-2 text-xs text-ink-secondary">{i + 1}</td>
                      {cols.map((c) => (
                        <td key={c.key} className="p-1 align-middle">
                          {c.type === 'bool' ? (
                            <input
                              type="checkbox"
                              data-row={i}
                              data-col={c.key}
                              checked={r[c.key] === true}
                              onChange={(e) => setCell(i, c.key, e.target.checked)}
                              onKeyDown={(e) => onCellKeyDown(e, i, c.key)}
                              aria-label={c.label}
                            />
                          ) : c.type === 'gender' ? (
                            <select
                              data-row={i}
                              data-col={c.key}
                              className={cellCls}
                              value={String(r[c.key] || '')}
                              onChange={(e) => setCell(i, c.key, e.target.value)}
                              onKeyDown={(e) => onCellKeyDown(e, i, c.key)}
                              aria-label={c.label}
                            >
                              <option value="" />
                              <option value="M">M</option>
                              <option value="Z">Z</option>
                            </select>
                          ) : (
                            <input
                              data-row={i}
                              data-col={c.key}
                              type={c.type === 'jmbg' ? 'text' : c.type === 'date' ? 'date' : c.type}
                              className={cellCls}
                              value={String(r[c.key] ?? '')}
                              maxLength={c.type === 'jmbg' ? 13 : undefined}
                              onChange={(e) =>
                                setCell(i, c.key, c.type === 'jmbg' ? e.target.value.replace(/\D/g, '').slice(0, 13) : e.target.value)
                              }
                              onKeyDown={(e) => onCellKeyDown(e, i, c.key)}
                              aria-label={c.label}
                            />
                          )}
                        </td>
                      ))}
                      <td className="whitespace-nowrap px-2">{statusCell(r)}</td>
                      <td className="px-1">
                        <button
                          type="button"
                          className="rounded-control px-1.5 text-status-danger hover:bg-status-danger-bg"
                          title="Obriši red"
                          onClick={() => delRow(i)}
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setGridRows((p) => [...p, makeEmptyRow(cols)])}>+ Dodaj red</Button>
              <Button variant="ghost" onClick={() => setGridRows([makeEmptyRow(cols)])}>Obriši sve</Button>
            </div>
          </>
        ) : importRows.length === 0 ? (
          <>
            <div
              className={cn(
                'grid cursor-pointer place-items-center gap-1 rounded-panel border-2 border-dashed border-line px-4 py-10 text-center',
                dragOver && 'border-accent bg-accent-subtle',
              )}
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                const f = e.dataTransfer?.files?.[0];
                if (f) void handleFile(f);
              }}
            >
              <div className="text-2xl" aria-hidden>📂</div>
              <div className="text-sm text-ink">
                <strong>Prevuci Excel/CSV ovde</strong> ili klikni da izabereš fajl
              </div>
              <div className="text-xs text-ink-secondary">Podržani formati: .xlsx, .xls, .csv</div>
              <input
                ref={fileRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleFile(f);
                }}
              />
            </div>
            <p className="text-xs text-ink-secondary">
              Očekivana header polja (kao u Template-u): Ime, Prezime, Pozicija, Odeljenje, Tim, „Zaposlen od" (datum),
              Email, Telefon, Aktivan{canPii ? ', JMBG, Pol, „Datum rođenja", Adresa, Mesto, „Poštanski br.", Banka, „Broj računa"' : ''}.
            </p>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2 text-sm text-ink">
              <strong>{importRows.length} redova</strong> učitano ({okRows.length} validno, {errCount} sa greškama).
              <Button variant="ghost" onClick={() => setImportRows([])}>↺ Drugi fajl</Button>
            </div>
            <div className="max-h-[45vh] overflow-auto rounded-panel border border-line">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line bg-surface-2 text-left">
                    <th className="h-8 px-2 text-2xs font-semibold uppercase tracking-wider text-ink-secondary">#</th>
                    {cols.map((c) => (
                      <th key={c.key} className="h-8 px-2 text-2xs font-semibold uppercase tracking-wider text-ink-secondary">{c.label}</th>
                    ))}
                    <th className="h-8 px-2 text-2xs font-semibold uppercase tracking-wider text-ink-secondary">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {importRows.map((r, i) => (
                    <tr key={i} className={cn('border-b border-line-soft', validateRow(r, cols).length > 0 && 'bg-status-danger-bg/40')}>
                      <td className="tnums px-2 text-xs text-ink-secondary">{i + 1}</td>
                      {cols.map((c) => (
                        <td key={c.key} className="whitespace-nowrap px-2 text-ink">
                          {c.type === 'bool' ? (r[c.key] === false ? 'NE' : 'DA') : String(r[c.key] ?? '')}
                        </td>
                      ))}
                      <td className="whitespace-nowrap px-2">{statusCell(r)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
