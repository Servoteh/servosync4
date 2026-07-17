'use client';

import { useState } from 'react';
import * as XLSX from 'xlsx';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { cn } from '@/lib/cn';
import {
  useBulkImportTools,
  useInventoryTree,
  useBulkImportCuttingTools,
  useAnalyzeReversals,
  useExecuteReversals,
  type BulkImportResult,
  type BulkToolRow,
  type BulkImportCuttingResult,
  type BulkCuttingRow,
  type ReversalRow,
  type ReversalAnalysis,
  type ExecuteReversalsResult,
} from '@/api/reversi';
import {
  IMPORT_TYPES,
  colsFor,
  mapRow,
  validateRow,
  downloadTemplate,
  parseCsvToObjects,
  parseList,
  type ImportType,
  type ImportRow,
} from './bulk-import-utils';
import { pushSession, newSessionId } from './import-sessions';

// Kolone se auto-mapiraju po nazivu zaglavlja (aliasi, paritet 1.0 bulkImportModal /
// runToolCsvImport). Klasifikacija (subgroup) i datum se mapiraju posebno (RA-24).
const ALIASES: Record<string, string[]> = {
  oznaka: ['oznaka', 'sifra', 'šifra', 'kod', 'code'],
  naziv: ['naziv', 'name', 'opis'],
  serijskiBroj: ['serijski', 'serijski broj', 'serijski_broj', 'serial', 's/n', 'sn'],
  isQuantity: ['kolicinski', 'količinski', 'quantity', 'na komad'],
  isConsumable: ['potrosni', 'potrošni', 'consumable'],
  totalQty: ['kolicina', 'količina', 'pocetna kolicina', 'početna količina', 'stanje', 'qty'],
  napomena: ['napomena', 'note', 'komentar'],
  subgroupCode: ['subgroup_code', 'subgroup', 'podgrupa', 'podgrupa_code', 'klasa', 'kategorija', 'category', 'vrsta'],
  datumKupovine: ['datum_kupovine', 'datum kupovine', 'nabavljen', 'datum nabavke'],
};

function truthy(v: unknown): boolean {
  const s = String(v ?? '').trim().toLowerCase();
  return s === 'da' || s === 'true' || s === '1' || s === 'x' || s === 'yes';
}

/** Datum → ISO (yyyy-mm-dd) ako je prepoznat; inače undefined (BE prima IsDateString). */
function toIsoDate(v: unknown): string | undefined {
  const s = String(v ?? '').trim();
  if (!s) return undefined;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return undefined;
}

function mapRows(
  raw: Record<string, unknown>[],
  subgroupByCode: Map<string, string>,
): { rows: BulkToolRow[]; ignored: number } {
  let ignored = 0;
  const rows: BulkToolRow[] = [];
  for (const r of raw) {
    // normalizuj ključeve zaglavlja
    const lower: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) lower[k.trim().toLowerCase()] = v;
    const pick = (key: string): unknown => {
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
    const subRaw = String(pick('subgroupCode') ?? '').trim().toLowerCase();
    rows.push({
      oznaka,
      naziv,
      serijskiBroj: pick('serijskiBroj') ? String(pick('serijskiBroj')).trim() : undefined,
      isQuantity: pick('isQuantity') !== undefined ? truthy(pick('isQuantity')) : undefined,
      isConsumable: pick('isConsumable') !== undefined ? truthy(pick('isConsumable')) : undefined,
      totalQty: qtyRaw !== undefined && qtyRaw !== '' ? Math.max(0, Math.round(Number(qtyRaw)) || 0) : undefined,
      napomena: pick('napomena') ? String(pick('napomena')).trim() : undefined,
      // RA-24 — subgroup_code → id (iz stabla klasifikacije); datum kupovine → ISO.
      subgroupId: subRaw ? subgroupByCode.get(subRaw) : undefined,
      datumKupovine: toIsoDate(pick('datumKupovine')),
    });
  }
  return { rows, ignored };
}

/** Sirovi redovi iz fajla (.csv preko file.text() radi UTF-8; ostalo preko XLSX). */
async function readRaw(file: File): Promise<Record<string, unknown>[]> {
  if (/\.csv$/i.test(file.name)) {
    const text = await file.text();
    return parseCsvToObjects(text);
  }
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array', cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new Error('Fajl je prazan.');
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: '',
    raw: false,
    dateNF: 'yyyy-mm-dd',
  });
}

function apiStatus(e: unknown): number | undefined {
  if (typeof e !== 'object' || e === null) return undefined;
  const s = (e as { status?: unknown }).status;
  return typeof s === 'number' ? s : undefined;
}

/**
 * Bulk-import u 3 tipa (RC-43): Ručni alat/oprema (rev_tools), Rezni alat (katalog)
 * i Reversi (već izdati). `initialType` bira početni tab; hostovi koji ga ne šalju
 * (alat-oprema-tab, magacin-tab) dobijaju `hand` — potpuno kompatibilno sa 1.0.
 */
export function BulkImportDialog({
  open,
  onClose,
  initialType = 'hand',
}: {
  open: boolean;
  onClose: () => void;
  initialType?: ImportType;
}) {
  const [type, setType] = useState<ImportType>(initialType);

  // Hand (postojeći tok — rev_tools)
  const handImporter = useBulkImportTools();
  const tree = useInventoryTree();
  const [handRows, setHandRows] = useState<BulkToolRow[]>([]);
  const [handIgnored, setHandIgnored] = useState(0);
  const [handResult, setHandResult] = useState<BulkImportResult | null>(null);

  // Cutting (RC-50 — rezni katalog)
  const cutImporter = useBulkImportCuttingTools();
  const [cutResult, setCutResult] = useState<BulkImportCuttingResult | null>(null);

  // Revers (RC-51/53/54)
  const analyzer = useAnalyzeReversals();
  const executor = useExecuteReversals();
  const [analysis, setAnalysis] = useState<ReversalAnalysis | null>(null);
  const [forceConfirmed, setForceConfirmed] = useState(false);
  const [execResult, setExecResult] = useState<ExecuteReversalsResult | null>(null);

  // Deljeno stanje generičkog toka (cutting/revers)
  const [genRows, setGenRows] = useState<ImportRow[]>([]);
  const [fileName, setFileName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const isImporting = handImporter.isPending || cutImporter.isPending || executor.isPending;
  const isAnalyzing = analyzer.isPending;
  const cols = colsFor(type);
  // Validni redovi generičkog toka (cutting/revers) — uvozi se samo ovo.
  const validGen = genRows.filter((r) => validateRow(r, type).length === 0);

  // subgroup_code → id (bez REZNI grupe — rev_tools su HAND/LZO), paritet 1.0.
  function subgroupMap(): Map<string, string> {
    const g = tree.data?.data.groups ?? [];
    const s = tree.data?.data.subgroups ?? [];
    const rezni = g.find((x) => x.code === 'REZNI')?.id ?? null;
    const m = new Map<string, string>();
    for (const sg of s) if (sg.groupId !== rezni) m.set(sg.code.toLowerCase(), sg.id);
    return m;
  }

  function resetData() {
    setHandRows([]);
    setHandIgnored(0);
    setHandResult(null);
    setCutResult(null);
    setAnalysis(null);
    setForceConfirmed(false);
    setExecResult(null);
    setGenRows([]);
    setFileName('');
    setError(null);
    setDragging(false);
  }

  function switchType(next: ImportType) {
    if (isImporting || next === type) return; // RC-43 — ne menjaj tip dok uvoz traje
    setType(next);
    resetData();
  }

  function closeAll() {
    if (isImporting) return; // ne zatvaraj dok uvoz traje
    resetData();
    setType(initialType);
    onClose();
  }

  async function onFile(file: File) {
    setError(null);
    setFileName(file.name);
    try {
      const raw = await readRaw(file);
      if (type === 'hand') {
        const mapped = mapRows(raw, subgroupMap());
        setHandRows(mapped.rows);
        setHandIgnored(mapped.ignored);
        setHandResult(null);
        if (mapped.rows.length === 0) setError('Nijedan red nema kolone „oznaka" i „naziv".');
        return;
      }
      const rows = mapRow(raw, cols);
      setGenRows(rows);
      setCutResult(null);
      setAnalysis(null);
      setForceConfirmed(false);
      setExecResult(null);
      if (rows.length === 0) {
        setError('Nijedan red nije prepoznat (proveri zaglavlja).');
        return;
      }
      // RC-51 — revers: automatska analiza posle učitavanja (samo validni redovi).
      if (type === 'revers') {
        const validRows = rows.filter((r) => validateRow(r, 'revers').length === 0);
        if (validRows.length > 0) {
          try {
            const res = await analyzer.mutateAsync({
              rows: validRows.map(toReversalRow),
              sourceFileName: file.name,
            });
            setAnalysis(res.data);
          } catch (e) {
            setError(e instanceof Error ? e.message : 'Analiza uvoza nije uspela.');
          }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Fajl nije moguće pročitati.');
    }
  }

  async function submit() {
    setError(null);
    try {
      if (type === 'hand') {
        const res = await handImporter.mutateAsync(handRows);
        setHandResult(res.data);
      } else if (type === 'cutting') {
        const rows = validGen.map(toCuttingRow);
        const res = await cutImporter.mutateAsync(rows);
        setCutResult(res.data);
      } else {
        const res = await executor.mutateAsync({
          rows: validGen.map(toReversalRow),
          sourceFileName: fileName,
          force: forceConfirmed,
        });
        setExecResult(res.data);
        // RC-54 — zapamti sesiju za storno ako je bar jedan dokument kreiran.
        if (res.data.session.docIds.length > 0) {
          pushSession({
            id: newSessionId(),
            finishedAt: new Date().toISOString(),
            docIds: res.data.session.docIds,
            newCatalogIds: res.data.session.newCatalogIds,
            ok: res.data.progress.ok,
            fail: res.data.progress.fail,
          });
        }
      }
    } catch (e) {
      // 409 = duplikati bez force → ponudi „⚠ Ipak nastavi" (backup za analizu).
      if (type === 'revers' && apiStatus(e) === 409) {
        setError('Otkriveni su duplikati. Klikni „⚠ Ipak nastavi" da svejedno kreiraš dokumente.');
      } else {
        setError(e instanceof Error ? e.message : 'Uvoz nije uspeo.');
      }
    }
  }

  // ── izvedene vrednosti za render ──
  const hasResult = handResult !== null || cutResult !== null || execResult !== null;

  const reversSoftBlocked =
    type === 'revers' &&
    !!analysis &&
    !analysis.blocking &&
    analysis.hasDuplicates &&
    !forceConfirmed;
  const reversHardBlocked = type === 'revers' && (!analysis || analysis.blocking || isAnalyzing);

  const canRun =
    !isImporting &&
    !hasResult &&
    (type === 'hand'
      ? handRows.length > 0
      : type === 'cutting'
        ? validGen.length > 0
        : validGen.length > 0 && !reversHardBlocked && !reversSoftBlocked);

  const runCount = type === 'hand' ? handRows.length : validGen.length;

  return (
    <Dialog
      open={open}
      onClose={closeAll}
      title="Bulk import (XLSX / CSV)"
      size="2xl"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={closeAll} disabled={isImporting}>
            {hasResult ? 'Zatvori' : 'Otkaži'}
          </Button>
          {!hasResult && (
            <Button
              loading={isImporting || isAnalyzing}
              disabled={!canRun}
              onClick={() => void submit()}
            >
              {isAnalyzing ? 'Analiziram…' : `Uvezi ${runCount ? `(${runCount})` : ''}`}
            </Button>
          )}
        </div>
      }
    >
      <div className="space-y-4">
        {/* RC-43 — segmentni prekidač 3 tipa */}
        <div className="inline-flex rounded-control border border-line bg-surface-2 p-0.5" role="group">
          {IMPORT_TYPES.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => switchType(t.id)}
              disabled={isImporting}
              className={cn(
                'rounded-control px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50',
                type === t.id ? 'bg-surface text-ink shadow-sm' : 'text-ink-secondary hover:text-ink',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        {!hasResult && (
          <>
            {/* Očekivane kolone + template */}
            <div className="rounded-control border border-line p-3">
              <p className="mb-1.5 text-xs text-ink-secondary">
                Prvi red = zaglavlje (dijakritici i veličina slova nisu bitni). Obavezne kolone su
                označene sa <span className="text-status-danger">*</span>.
              </p>
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
                {cols.map((c) => (
                  <span key={c.key} className="text-ink-secondary">
                    <strong className="text-ink">{c.label}</strong>
                    {c.required && <span className="text-status-danger">*</span>}
                  </span>
                ))}
              </div>
              <div className="mt-2">
                <Button variant="secondary" onClick={() => downloadTemplate(type)}>
                  Preuzmi template (CSV)
                </Button>
              </div>
            </div>

            {/* RC-46 — drag-drop zona + file picker */}
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                const f = e.dataTransfer.files?.[0];
                if (f) void onFile(f);
              }}
              className={cn(
                'rounded-control border-2 border-dashed p-4 text-center transition-colors',
                dragging ? 'border-accent bg-surface-2' : 'border-line',
              )}
            >
              <p className="text-sm text-ink-secondary">
                Prevuci Excel/CSV fajl ovde ili izaberi. Podržano: .xlsx, .xls, .csv
              </p>
              <input
                id="rev-bulk-file"
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (f) void onFile(f);
                }}
                className="mt-2 block w-full text-sm text-ink file:mr-3 file:rounded-control file:border file:border-line file:bg-surface-2 file:px-3 file:py-1.5 file:text-sm"
              />
            </div>

            {/* HAND — sažetak (postojeći paritet 1.0) */}
            {type === 'hand' && fileName && (
              <div className="rounded-control border border-line p-2 text-sm">
                <div className="font-medium">{fileName}</div>
                <div className="text-ink-secondary">
                  {handRows.length} za uvoz
                  {handIgnored > 0 ? ` · ${handIgnored} preskočeno (bez oznake/naziva)` : ''}
                </div>
                {handRows.slice(0, 5).map((r, i) => (
                  <div key={i} className="mt-1 flex gap-2 text-xs text-ink-secondary">
                    <span className="font-medium text-ink">{r.oznaka}</span>
                    <span>{r.naziv}</span>
                    {r.serijskiBroj && <span>· {r.serijskiBroj}</span>}
                  </div>
                ))}
                {handRows.length > 5 && (
                  <div className="mt-1 text-xs text-ink-secondary">… i još {handRows.length - 5}</div>
                )}
              </div>
            )}

            {/* REVERS — sažetak pre-import analize */}
            {type === 'revers' && (isAnalyzing || analysis) && (
              <ReversAnalysisCard
                analysis={analysis}
                analyzing={isAnalyzing}
                forceConfirmed={forceConfirmed}
                onForce={() => setForceConfirmed(true)}
              />
            )}

            {/* RC-47 — preview tabela (cutting/revers) */}
            {type !== 'hand' && genRows.length > 0 && <PreviewTable rows={genRows} type={type} />}
          </>
        )}

        {/* Rezultati */}
        {handResult && (
          <div className="space-y-1 rounded-control border border-line p-3 text-sm">
            <div>Kreirano: <strong>{handResult.created}</strong></div>
            <div>Preskočeno (već postoji): <strong>{handResult.skipped}</strong></div>
            {handResult.errors.length > 0 && (
              <div className="pt-1 text-status-danger">
                Greške ({handResult.errors.length}):
                {handResult.errors.slice(0, 5).map((er, i) => (
                  <div key={i} className="text-xs">{er.oznaka}: {er.error}</div>
                ))}
              </div>
            )}
          </div>
        )}

        {cutResult && (
          <div className="space-y-1 rounded-control border border-line p-3 text-sm">
            <div>Kreirano: <strong>{cutResult.created}</strong></div>
            <div>Preskočeno (već postoji): <strong>{cutResult.skipped}</strong></div>
            <div>Seedovano početno stanje: <strong>{cutResult.seeded}</strong></div>
            {cutResult.errors.length > 0 && (
              <div className="pt-1 text-status-danger">
                Greške ({cutResult.errors.length}):
                {cutResult.errors.slice(0, 5).map((er, i) => (
                  <div key={i} className="text-xs">{er.oznaka}: {er.error}</div>
                ))}
              </div>
            )}
          </div>
        )}

        {execResult && (
          <div className="space-y-1 rounded-control border border-line p-3 text-sm">
            <div><span className="text-status-success">Uvezeno stavki: <strong>{execResult.progress.ok}</strong></span></div>
            {execResult.progress.skipped > 0 && (
              <div>Preskočeno (isti uvoz): <strong>{execResult.progress.skipped}</strong></div>
            )}
            {execResult.progress.fail > 0 && (
              <div className="text-status-danger">Neuspešno: <strong>{execResult.progress.fail}</strong></div>
            )}
            <div className="text-xs text-ink-secondary">
              Kreirano dokumenata: {execResult.session.docIds.length} · novih šifri:{' '}
              {execResult.session.newCatalogIds.length}. Storno je moguć iz „Storno bulk importa".
            </div>
          </div>
        )}

        {error && <p className="text-sm text-status-danger" role="alert">{error}</p>}
      </div>
    </Dialog>
  );
}

/* ─── Mapiranja generičkih redova → payload hookova ────────────────────── */

function toCuttingRow(r: ImportRow): BulkCuttingRow {
  const machines = parseList(r.kompatibilne_masine);
  const minRaw = String(r.minimalna_zaliha ?? '').trim();
  const minQty = minRaw ? Math.max(0, Math.floor(Number(minRaw.replace(/\s/g, '').replace(',', '.')) || 0)) : 0;
  const initQty = Math.max(0, Math.floor(Number(r.pocetna_kolicina) || 0));
  return {
    oznaka: String(r.oznaka ?? '').trim(),
    naziv: String(r.naziv ?? '').trim(),
    compatibleMachineCodes: machines.length > 0 ? machines : undefined,
    unit: String(r.jedinica ?? '').trim() || undefined,
    minStockQty: minQty,
    napomena: String(r.napomena ?? '').trim() || undefined,
    initialQty: initQty > 0 ? initQty : undefined,
  };
}

function toReversalRow(r: ImportRow): ReversalRow {
  const kol = Number(r.kolicina);
  return {
    tip: String(r.tip ?? '').trim(),
    datum: String(r.datum ?? '').trim() || undefined,
    primalacTip: String(r.primalac_tip ?? '').trim(),
    primalac: String(r.primalac ?? '').trim(),
    masina: String(r.masina ?? '').trim() || undefined,
    alat: String(r.alat_oznaka_ili_barkod ?? '').trim(),
    kolicina: Number.isFinite(kol) && kol > 0 ? kol : undefined,
    rokPovracaja: String(r.rok_povracaja ?? '').trim() || undefined,
    napomena: String(r.napomena ?? '').trim() || undefined,
  };
}

/* ─── Preview tabela (RC-47) ───────────────────────────────────────────── */

function PreviewTable({ rows, type }: { rows: ImportRow[]; type: ImportType }) {
  const cols = colsFor(type);
  const shown = rows.slice(0, 200);
  return (
    <div>
      <div className="mb-1 text-sm text-ink-secondary">
        Preview: <strong className="text-ink">{rows.length}</strong> redova
      </div>
      <div className="max-h-[300px] overflow-auto rounded-control border border-line">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-surface-2">
            <tr>
              {cols.map((c) => (
                <th key={c.key} className="whitespace-nowrap px-2 py-1.5 text-left font-medium text-ink-secondary">
                  {c.label}
                  {c.required && <span className="text-status-danger">*</span>}
                </th>
              ))}
              <th className="px-2 py-1.5 text-left font-medium text-ink-secondary">Validno?</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r, idx) => {
              const errs = validateRow(r, type);
              const valid = errs.length === 0;
              return (
                <tr key={idx} className={cn('border-t border-line', !valid && 'bg-status-danger-bg')}>
                  {cols.map((c) => (
                    <td key={c.key} className="whitespace-nowrap px-2 py-1 text-ink">
                      {String(r[c.key] ?? '')}
                    </td>
                  ))}
                  <td className="px-2 py-1">
                    {valid ? (
                      <span className="text-status-success">✓</span>
                    ) : (
                      <span className="text-status-danger" title={errs.join(', ')}>
                        ⚠ {errs.length}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.length > 200 && (
        <p className="mt-1 text-xs text-ink-secondary">
          Prikazano prvih 200; biće uvezeno svih {rows.length}.
        </p>
      )}
    </div>
  );
}

/* ─── Pre-import analiza reversa (RC-51/53) ────────────────────────────── */

function ReversAnalysisCard({
  analysis,
  analyzing,
  forceConfirmed,
  onForce,
}: {
  analysis: ReversalAnalysis | null;
  analyzing: boolean;
  forceConfirmed: boolean;
  onForce: () => void;
}) {
  if (analyzing) {
    return (
      <div className="rounded-control border border-line bg-surface-2 p-3 text-sm text-ink-secondary">
        Analiza u toku — razrešavamo radnike i šifre alata. Ne stiskaj „Uvezi" još.
      </div>
    );
  }
  if (!analysis) return null;
  const a = analysis;
  const showForce = !a.blocking && a.hasDuplicates && !forceConfirmed;
  return (
    <div className={cn('rounded-control border p-3 text-sm', a.blocking ? 'border-status-danger/50 bg-status-danger-bg' : 'border-line')}>
      <div className="mb-1 font-medium text-ink">Pre-import analiza</div>
      <ul className="space-y-0.5 text-xs text-ink-secondary">
        <li>Reversi dokumenata: <strong className="text-ink">{a.docCount}</strong> ({a.lineCount} stavki)</li>
        <li>Mašine prepoznate: {a.machineCodes.length}</li>
        <li>Šifre reznog alata postojeće: {a.existingCatalog.length}</li>
        <li>
          Šifre koje će biti auto-kreirane: {a.newCatalog.length}
          {a.newCatalog.length > 0 && (
            <span> ({a.newCatalog.slice(0, 6).map((x) => x.oznaka).join(', ')}{a.newCatalog.length > 6 ? '…' : ''})</span>
          )}
        </li>
        <li>Radnici razrešeni: {Object.keys(a.resolvedEmployees).length}</li>
        <li>
          Magacin (ALAT-MAG-01):{' '}
          {a.magacinExists ? (
            <span className="text-status-success">postoji</span>
          ) : (
            <span className="text-status-danger">NE POSTOJI</span>
          )}
        </li>
        {a.missingToolOznaka.length > 0 && (
          <li className="text-status-danger">
            Nema aktivnog ručnog alata ({a.missingToolOznaka.length}): prvo uvezi „Ručni alat" ·{' '}
            {a.missingToolOznaka.slice(0, 24).join(', ')}
            {a.missingToolOznaka.length > 24 ? '…' : ''}
          </li>
        )}
        {a.missingEmployees.length > 0 && (
          <li className="text-status-danger">
            Nedostaju u Kadrovskoj ({a.missingEmployees.length}): {a.missingEmployees.slice(0, 20).join(', ')}
            {a.missingEmployees.length > 20 ? '…' : ''}
          </li>
        )}
        {a.duplicateDocs.length > 0 && (
          <li className="text-status-warn">
            Duplikat importa: {a.duplicateDocs.length} aktivan(ih) reverz dokument(a) već postoji za ove mašine
            {a.duplicateDocs.slice(0, 6).map((d, i) => (
              <div key={i} className="text-ink-secondary">
                • {d.machine ?? '?'} — {d.docNumber} ({String(d.issuedAt).slice(0, 10)}, {d.employee ?? '?'})
              </div>
            ))}
          </li>
        )}
      </ul>

      {a.blocking && a.blockers.length > 0 && (
        <p className="mt-2 text-xs font-medium text-status-danger">
          Uvoz je blokiran: {a.blockers.join('; ')}.
        </p>
      )}

      {showForce && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button variant="danger" onClick={onForce}>
            ⚠ Ipak nastavi (kreiraj duplikat)
          </Button>
          <span className="text-xs text-ink-secondary">
            Dodaje još jedan dokument — dvostruki obrt u magacin/mašinu.
          </span>
        </div>
      )}
      {forceConfirmed && a.hasDuplicates && (
        <p className="mt-2 text-xs text-status-warn">Potvrđeno: duplikati će biti kreirani pri uvozu.</p>
      )}
    </div>
  );
}
