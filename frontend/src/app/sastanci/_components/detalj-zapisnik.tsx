'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Check, Download, Paperclip, Plus, Sparkles, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { Dialog } from '@/components/ui-kit/dialog';
import { DictateButton, RefineButton } from '@/components/voice-controls';
import {
  aiSummary,
  fetchSlikaUrl,
  newClientEventId,
  useCreateAktivnost,
  useDeleteAktivnost,
  useDeleteSlika,
  useReorderAktivnosti,
  useSeedFromTeme,
  useUpdateAktivnost,
  useUploadSlika,
  type Aktivnost,
  type AktivnostInput,
  type SastanakFull,
  type Slika,
  type WeeklyDiff,
} from '@/api/sastanci';
import {
  htmlToText,
  isSafeHref,
  sanitizeHtml,
  sanitizeZapisnikPasteHtml,
  textToHtml,
} from '@/lib/sastanci-html';
import { toast } from '@/lib/toast';
import { DirectoryPicker } from './directory-picker';
import { formatDatum, formatVreme, INPUT_CLS } from './common';

/** Zapisnik tab — tačke (CRUD + reorder + rich-text + meta polja + slike +
 *  STT/refine + obrađeno) + Uvezi teme + AI rezime. Rich-text = S-P1 port 1.0
 *  zapisnikTab.js (contenteditable + sanitizeHtml na render i na save). */
export function DetaljZapisnik({
  sast,
  canEdit,
  weeklyDiff,
}: {
  sast: SastanakFull;
  canEdit: boolean;
  weeklyDiff?: WeeklyDiff | null;
}) {
  const seed = useSeedFromTeme();
  const create = useCreateAktivnost();
  const reorder = useReorderAktivnosti();
  const [summary, setSummary] = useState<string | null>(null);
  const [summBusy, setSummBusy] = useState(false);

  const tacke = sast.aktivnosti;
  const locked = sast.status === 'zakljucan' || sast.status === 'otkazan';
  const editable = canEdit && !locked;

  // Enter u contenteditable po defaultu pravi <div> (Chrome) koji save-whitelist
  // strip-uje pa bi se redovi slepili; <p> JESTE u whitelisti i preživljava.
  useEffect(() => {
    try {
      document.execCommand('defaultParagraphSeparator', false, 'p');
    } catch {
      /* stariji browseri — ignoriši */
    }
  }, []);

  /** Slike grupisane po tački (presek_slike.aktivnost_id — 1.0 slikeMap paritet). */
  const slikeByAkt = useMemo(() => {
    const m = new Map<string, Slika[]>();
    for (const s of sast.slike) {
      if (!s.aktivnostId) continue;
      const arr = m.get(s.aktivnostId);
      if (arr) arr.push(s);
      else m.set(s.aktivnostId, [s]);
    }
    for (const arr of m.values()) {
      arr.sort(
        (a, b) => a.redosled - b.redosled || String(a.uploadedAt).localeCompare(String(b.uploadedAt)),
      );
    }
    return m;
  }, [sast.slike]);

  function move(idx: number, dir: -1 | 1) {
    const next = [...tacke];
    const j = idx + dir;
    if (j < 0 || j >= next.length) return;
    [next[idx], next[j]] = [next[j], next[idx]];
    reorder.mutate({ id: sast.id, ids: next.map((t) => t.id) });
  }

  async function runSummary() {
    setSummBusy(true);
    try {
      // Payload MORA pratiti backend buildSummaryContent (§sastanci-summary):
      // {naslov,datum,vreme,mesto,ucesnici[],diff,grupe[{code,naziv,akcije[…]}]}.
      // Ranije poslati {aktivnosti,akcije} bili su ignorisani → „(nema zadataka)"
      // (review nalaz #2). Grupe = paritet 1.0 buildPayload/packAkcija.
      const grupe = sast.akcije.length
        ? [
            {
              code: '',
              naziv: 'Akcioni plan',
              akcije: sast.akcije.map((a, i) => ({
                rb: a.rb ?? i + 1,
                naslov: a.naslov,
                opis: a.opis ?? '',
                odgovoran: a.odgovoran_label || a.odgovoran_text || a.odgovoran_email || '',
                rok: a.rok_text || (a.rok ? formatDatum(a.rok) : ''),
                status: a.status,
              })),
            },
          ]
        : [];
      const diff = weeklyDiff
        ? { dodato: weeklyDiff.novo, zavrseno: weeklyDiff.zavrsenoOveNedelje, kasni: weeklyDiff.kasni }
        : null;
      const res = await aiSummary(sast.id, {
        naslov: sast.naslov,
        datum: formatDatum(sast.datum),
        vreme: sast.vreme ? formatVreme(sast.vreme) : '',
        mesto: sast.mesto ?? '',
        ucesnici: sast.ucesnici.map((u) => u.label || u.email),
        diff,
        grupe,
      });
      setSummary(res.data.summary);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Sažimanje trenutno nije dostupno.');
    } finally {
      setSummBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {editable && (
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => create.mutate({ id: sast.id, clientEventId: newClientEventId(), naslov: 'Nova tačka' })}>
            <Plus className="h-4 w-4" aria-hidden /> Dodaj tačku
          </Button>
          <Button variant="secondary" loading={seed.isPending} onClick={() => seed.mutate({ id: sast.id })}>
            Uvezi teme sa dnevnog reda
          </Button>
          <Button variant="ghost" loading={summBusy} onClick={() => void runSummary()}>
            <Sparkles className="h-4 w-4" aria-hidden /> Sažmi zapisnik (AI)
          </Button>
        </div>
      )}

      {tacke.length === 0 ? (
        <p className="rounded-panel border border-line bg-surface p-6 text-center text-sm text-ink-secondary">
          Nema tačaka zapisnika. {editable ? 'Dodaj tačku ili uvezi teme.' : ''}
        </p>
      ) : (
        <div className="space-y-3">
          {tacke.map((t, idx) => (
            <TackaCard
              key={t.id}
              tacka={t}
              idx={idx}
              editable={editable}
              onMove={(d) => move(idx, d)}
              sastanakId={sast.id}
              slike={slikeByAkt.get(t.id) ?? []}
            />
          ))}
        </div>
      )}

      {summary !== null && (
        <Dialog open onClose={() => setSummary(null)} title="AI rezime zapisnika">
          <p className="whitespace-pre-wrap text-sm text-ink">{summary}</p>
        </Dialog>
      )}
    </div>
  );
}

/* ── Toolbar (port 1.0 zapisnikToolbar.js) ──────────────────────────────────
   Komande koje PREŽIVLJAVAJU save-whitelist (b/i/u, liste, link). 1.0 toolbar
   je imao i H1–H3 (formatBlock) i „Slika (URL)" (insertImage), ali ih 1.0
   sanitizeHtml na save STRIP-uje (h1–h3 i img nisu u whitelisti → format/slika
   tiho nestaju posle debounce-a) — svesno NISU portovani. */

type TbButton = { cmd: string; label: string; title: string; cls?: string };
const TB_BUTTONS: (TbButton | 'sep')[] = [
  { cmd: 'undo', label: '↶', title: 'Undo' },
  { cmd: 'redo', label: '↷', title: 'Redo' },
  'sep',
  { cmd: 'bold', label: 'B', title: 'Bold (Ctrl+B)', cls: 'font-bold' },
  { cmd: 'italic', label: 'I', title: 'Italic (Ctrl+I)', cls: 'italic' },
  { cmd: 'underline', label: 'U', title: 'Underline (Ctrl+U)', cls: 'underline' },
  'sep',
  { cmd: 'insertUnorderedList', label: '•', title: 'Lista' },
  { cmd: 'insertOrderedList', label: '1.', title: 'Numerisana lista' },
  'sep',
  { cmd: 'createLink', label: '🔗', title: 'Link' },
  { cmd: 'removeFormat', label: '✕', title: 'Ukloni format' },
];

function ZapisnikToolbar({ editorRef }: { editorRef: { current: HTMLDivElement | null } }) {
  function exec(cmd: string) {
    const ed = editorRef.current;
    if (!ed) return;
    ed.focus();
    if (cmd === 'createLink') {
      const url = window.prompt('URL linka (https://…)');
      if (!url) return;
      // Isti href kriterijum kao save-whitelist — bez provere bi npr.
      // javascript: link živeo u DOM-u (klikabilan) do prvog save-a.
      if (!isSafeHref(url)) {
        toast('URL mora počinjati sa http://, https:// ili mailto:.');
        return;
      }
      document.execCommand('createLink', false, url);
      return;
    }
    document.execCommand(cmd);
  }
  return (
    <div role="toolbar" aria-label="Formatiranje zapisnika" className="flex flex-wrap items-center gap-0.5 border-b border-line px-1.5 py-1">
      {TB_BUTTONS.map((b, i) =>
        b === 'sep' ? (
          <span key={`sep${i}`} className="mx-1 h-4 w-px bg-line" aria-hidden />
        ) : (
          <button
            key={b.cmd}
            type="button"
            title={b.title}
            // mousedown + preventDefault: ne gubi selekciju/fokus editora (1.0 paritet)
            onMouseDown={(e) => {
              e.preventDefault();
              exec(b.cmd);
            }}
            className={`min-w-6 rounded-control px-1.5 py-0.5 text-xs text-ink-secondary hover:bg-surface-2 hover:text-ink ${b.cls ?? ''}`}
          >
            {b.label}
          </button>
        ),
      )}
    </div>
  );
}

/* ── Kartica tačke ── */

const META_LABEL_CLS = 'mb-0.5 block text-2xs font-medium text-ink-secondary';

function TackaCard({
  tacka,
  idx,
  editable,
  onMove,
  sastanakId,
  slike,
}: {
  tacka: Aktivnost;
  idx: number;
  editable: boolean;
  onMove: (dir: -1 | 1) => void;
  sastanakId: string;
  slike: Slika[];
}) {
  const update = useUpdateAktivnost();
  const del = useDeleteAktivnost();
  const upload = useUploadSlika();
  const [naslov, setNaslov] = useState(tacka.naslov);
  const obradjeno = tacka.status === 'zavrsen';

  /* Meta polja (BE UpdateAktivnostDto; PDF ih već štampa — fali samo unos). */
  const [podRn, setPodRn] = useState(tacka.podRn ?? '');
  const [odg, setOdg] = useState<{ email: string; label?: string } | null>(
    tacka.odgovoranEmail ? { email: tacka.odgovoranEmail, label: tacka.odgovoranLabel ?? undefined } : null,
  );
  const [odgText, setOdgText] = useState(tacka.odgovoranText ?? '');
  const [rok, setRok] = useState(tacka.rok ? String(tacka.rok).slice(0, 10) : '');
  const [rokText, setRokText] = useState(tacka.rokText ?? '');
  const [napomena, setNapomena] = useState(tacka.napomena ?? '');

  /* ── Rich-text editor (1.0 paritet): sanitizeHtml na render + na save;
     fallback na sadrzajText jer su stare 2.0 izmene pisale SAMO tekst. ── */
  const editorRef = useRef<HTMLDivElement>(null);
  const initialHtmlRef = useRef<string | null>(null);
  if (initialHtmlRef.current === null) {
    // Fallback lanac: stare 2.0 izmene su pisale SAMO sadrzajText, pa bi bajat
    // sadrzajHtml „pobedio" i pregazio noviji tekst. Heuristika: ako su i html
    // i text neprazni, a tekst-projekcija HTML-a se NE poklapa sa tekstom →
    // text je noviji izvor istine → prikaži textToHtml(text); inače html.
    // Poređenje briše SVE beline (ne samo collapse): legacy sadrzaj_text je
    // građen 1.0 textContent-om koji blokove lepi BEZ razmaka ("ab"), dok novi
    // htmlToText vraća "a\nb" — collapse bi svaki višepasusni red lažno
    // proglasio izmenjenim i time izgubio formatiranje.
    const normalize = (s: string) => s.replace(/\s+/g, '');
    const clean = sanitizeHtml(tacka.sadrzajHtml || '');
    const text = tacka.sadrzajText ?? '';
    if (clean && normalize(text) && normalize(htmlToText(clean)) !== normalize(text)) {
      initialHtmlRef.current = textToHtml(text);
    } else {
      initialHtmlRef.current = clean || textToHtml(text);
    }
  }
  const lastSavedHtml = useRef(initialHtmlRef.current);

  /** Sanitizuj + snimi sadržaj IZ PROSLEĐENOG čvora (unmount flush radi nad
   *  detached čvorom uhvaćenim na mount-u — vidi effect ispod). */
  function saveFromNode(ed: HTMLDivElement | null) {
    if (!ed) return;
    const raw = ed.innerHTML;
    const clean = sanitizeHtml(raw);
    // Dok je editor fokusiran NE prepisuj DOM (karet skače na početak + puca
    // undo stack) — PATCH nosi clean, a DOM se poravnava na blur/flush putanji.
    if (clean !== raw && document.activeElement !== ed) ed.innerHTML = clean;
    if (clean === lastSavedHtml.current) return;
    const prev = lastSavedHtml.current;
    // Optimistički odmah (guard protiv duplog PATCH-a dok je prvi u letu:
    // blur + unmount flush); pad se poništava u onError.
    lastSavedHtml.current = clean;
    update.mutate(
      { aktId: tacka.id, patch: { sadrzajHtml: clean, sadrzajText: htmlToText(clean) } },
      {
        onSuccess: () => {
          lastSavedHtml.current = clean;
        },
        onError: () => {
          // Pad PATCH-a ne sme da bude nevidljiv niti da „zaključa" sadržaj
          // (identičan se više nikad ne bi poslao) — vrati baseline pa sledeći
          // blur/Ctrl+S ponovo šalje.
          lastSavedHtml.current = prev;
          toast('Čuvanje nije uspelo — pokušaj ponovo.');
        },
      },
    );
  }

  function saveContent() {
    saveFromNode(editorRef.current);
  }

  /* Flush izmena van blur putanje: unmount (promena taba/navigacija), zatvaranje/
     refresh (beforeunload) i prelazak u pozadinu (visibilitychange→hidden) —
     1.0 flushAllPendingSaves paritet. React NULIRA editorRef.current PRE effect
     cleanup-a, pa se čvor hvata OVDE na mount-u — detached čvor i dalje nosi
     innerHTML za poslednji save. Bez izmena = no-op. */
  const saveFromNodeRef = useRef(saveFromNode);
  saveFromNodeRef.current = saveFromNode;
  useEffect(() => {
    const ed = editorRef.current;
    // Baseline = DOM-normalizovan HTML (innerHTML round-trip ume da normalizuje
    // entitete/atribute) — bez ovoga bi prvi blur okidao no-op PATCH.
    if (ed) lastSavedHtml.current = sanitizeHtml(ed.innerHTML);
    const flush = () => saveFromNodeRef.current(ed);
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('beforeunload', flush);
      document.removeEventListener('visibilitychange', onVisibility);
      flush();
    };
  }, []);

  function onEditorPaste(e: React.ClipboardEvent<HTMLDivElement>) {
    const html = e.clipboardData?.getData('text/html');
    if (html) {
      e.preventDefault();
      document.execCommand('insertHTML', false, sanitizeZapisnikPasteHtml(html));
    }
  }

  function onEditorDrop(e: React.DragEvent<HTMLDivElement>) {
    // Default drop ubacuje SIROV HTML mimo paste whitelist-e (XSS/đubre do
    // prvog save-a) — presretni i provuci kroz istu sanitizaciju kao paste.
    e.preventDefault();
    if (!editable) return;
    const dt = e.dataTransfer;
    const html = dt.getData('text/html');
    const ins = html ? sanitizeZapisnikPasteHtml(html) : textToHtml(dt.getData('text/plain'));
    if (!ins) return;
    const ed = editorRef.current;
    if (!ed) return;
    ed.focus();
    document.execCommand('insertHTML', false, ins);
  }

  function onEditorKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.currentTarget.blur(); // blur → save
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveContent();
    }
    // Ctrl+B/I/U: browser ih nativno mapira na execCommand u contenteditable.
  }

  /** Diktat: dopiši kao tekst na kraj editora pa odmah sačuvaj (1.0 attachDictation → input → save). */
  function insertDictation(txt: string) {
    const ed = editorRef.current;
    if (!ed) return;
    const sep = htmlToText(ed.innerHTML).trim() ? ' ' : '';
    ed.appendChild(document.createTextNode(sep + txt));
    saveContent();
  }

  function saveNaslov() {
    if (naslov !== tacka.naslov) update.mutate({ aktId: tacka.id, patch: { naslov } });
  }

  function saveMeta(patch: AktivnostInput, changed: boolean) {
    if (changed) update.mutate({ aktId: tacka.id, patch });
  }

  const roOdgovoran = tacka.odgovoranLabel || tacka.odgovoranText || tacka.odgovoranEmail || '';
  const roRok = tacka.rokText || (tacka.rok ? formatDatum(tacka.rok) : '');
  const hasRoMeta = !!(tacka.podRn || roOdgovoran || roRok || tacka.napomena);

  return (
    <div className="rounded-panel border border-line bg-surface p-3">
      <div className="mb-2 flex items-start gap-2">
        <span className="tnums mt-1.5 text-sm font-semibold text-ink-secondary">{idx + 1}.</span>
        <input
          className={`${INPUT_CLS} flex-1 font-medium`}
          value={naslov}
          disabled={!editable}
          onChange={(e) => setNaslov(e.target.value)}
          onBlur={saveNaslov}
        />
        {editable && (
          <div className="flex items-center gap-1">
            <button title="Gore" className="rounded-control border border-line p-1 text-ink-secondary hover:bg-surface-2" onClick={() => onMove(-1)}>
              <ArrowUp className="h-3.5 w-3.5" aria-hidden />
            </button>
            <button title="Dole" className="rounded-control border border-line p-1 text-ink-secondary hover:bg-surface-2" onClick={() => onMove(1)}>
              <ArrowDown className="h-3.5 w-3.5" aria-hidden />
            </button>
            <button
              title={obradjeno ? 'Vrati u obradu' : 'Označi obrađeno'}
              className={`rounded-control border p-1 ${obradjeno ? 'border-status-success/50 bg-status-success-bg text-status-success' : 'border-line text-ink-secondary'} hover:bg-surface-2`}
              onClick={() => update.mutate({ aktId: tacka.id, patch: { status: obradjeno ? 'u_toku' : 'zavrsen' } })}
            >
              <Check className="h-3.5 w-3.5" aria-hidden />
            </button>
            <button title="Obriši" className="rounded-control border border-line p-1 text-status-danger hover:bg-surface-2" onClick={() => { /* FK je SET NULL — slike NE nestaju, ostaju u foto dokumentaciji sastanka. */ if (confirm('Obrisati tačku? Njene slike ostaju u foto dokumentaciji sastanka.')) del.mutate({ aktId: tacka.id }); }}>
              <Trash2 className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
        )}
      </div>
      <div className="pl-6">
        <div className="rounded-control border border-line bg-surface-2 focus-within:border-accent">
          {editable && <ZapisnikToolbar editorRef={editorRef} />}
          <div
            ref={editorRef}
            contentEditable={editable}
            suppressContentEditableWarning
            role="textbox"
            aria-multiline="true"
            aria-label="Sadržaj tačke"
            data-placeholder="Sadržaj tačke…"
            className="min-h-20 px-2.5 py-1.5 text-sm text-ink outline-none [overflow-wrap:anywhere] [&_a]:text-accent [&_a]:underline [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5 empty:before:text-ink-disabled empty:before:content-[attr(data-placeholder)]"
            // Namerno se NE re-renderuje iz prop-a posle mount-a (caret bi skakao);
            // key={t.id} remount-uje karticu po tački.
            dangerouslySetInnerHTML={{ __html: initialHtmlRef.current }}
            onBlur={saveContent}
            onPaste={onEditorPaste}
            onDrop={onEditorDrop}
            onKeyDown={onEditorKeyDown}
          />
        </div>
        {editable && (
          <div className="mt-1 flex gap-1">
            <DictateButton context="zapisnik" onText={insertDictation} />
            <RefineButton
              profil="zapisnik"
              getText={() => (editorRef.current ? htmlToText(editorRef.current.innerHTML) : '')}
              onText={(txt) => {
                const ed = editorRef.current;
                if (!ed) return;
                ed.innerHTML = textToHtml(txt); // AI vraća plain tekst — escapuj + <br>
                saveContent();
              }}
            />
            <span className="self-center text-2xs text-ink-disabled">
              <Download className="mr-0.5 inline h-3 w-3 rotate-180" aria-hidden />diktiraj / doteraj
            </span>
          </div>
        )}

        {/* Meta red ispod sadržaja (1.0 raspored; odgovoran/rok/napomena = A-polja) */}
        {editable ? (
          <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            <label className="block">
              <span className={META_LABEL_CLS}>Pod RN</span>
              <input
                className={INPUT_CLS}
                value={podRn}
                onChange={(e) => setPodRn(e.target.value)}
                onBlur={() => saveMeta({ podRn }, podRn !== (tacka.podRn ?? ''))}
              />
            </label>
            <div>
              <span className={META_LABEL_CLS}>Odgovoran (iz direktorijuma)</span>
              <DirectoryPicker
                value={odg}
                onChange={(v) => {
                  setOdg(v);
                  // '' briše (BE piše string kakav stigne; 1.0 mapira null→'')
                  update.mutate({
                    aktId: tacka.id,
                    patch: { odgovoranEmail: v?.email ?? '', odgovoranLabel: v?.label ?? '' },
                  });
                }}
              />
            </div>
            <label className="block">
              <span className={META_LABEL_CLS}>Odgovoran (slobodno)</span>
              <input
                className={INPUT_CLS}
                value={odgText}
                placeholder="npr. kooperant"
                onChange={(e) => setOdgText(e.target.value)}
                onBlur={() => saveMeta({ odgovoranText: odgText }, odgText !== (tacka.odgovoranText ?? ''))}
              />
            </label>
            <label className="block">
              <span className={META_LABEL_CLS}>Rok (datum)</span>
              <input
                className={INPUT_CLS}
                type="date"
                value={rok}
                onChange={(e) => setRok(e.target.value)}
                onBlur={() =>
                  saveMeta(
                    // BE rok je @IsISO8601 pa '' pada — brisanje ide kao null (toDbDate: null→NULL).
                    { rok: (rok || null) as unknown as string },
                    rok !== (tacka.rok ? String(tacka.rok).slice(0, 10) : ''),
                  )
                }
              />
            </label>
            <label className="block">
              <span className={META_LABEL_CLS}>Rok (slobodno)</span>
              <input
                className={INPUT_CLS}
                value={rokText}
                placeholder="npr. do kraja meseca"
                onChange={(e) => setRokText(e.target.value)}
                onBlur={() => saveMeta({ rokText }, rokText !== (tacka.rokText ?? ''))}
              />
            </label>
            <label className="block">
              <span className={META_LABEL_CLS}>Napomena</span>
              <input
                className={INPUT_CLS}
                value={napomena}
                onChange={(e) => setNapomena(e.target.value)}
                onBlur={() => saveMeta({ napomena }, napomena !== (tacka.napomena ?? ''))}
              />
            </label>
          </div>
        ) : (
          hasRoMeta && (
            <p className="mt-2 text-xs text-ink-secondary">
              {tacka.podRn && <span className="mr-3">Pod RN: <span className="text-ink">{tacka.podRn}</span></span>}
              {roOdgovoran && <span className="mr-3">Odgovoran: <span className="text-ink">{roOdgovoran}</span></span>}
              {roRok && <span className="mr-3">Rok: <span className="text-ink">{roRok}</span></span>}
              {tacka.napomena && <span>Napomena: <span className="text-ink">{tacka.napomena}</span></span>}
            </p>
          )
        )}

        {/* Slike uz tačku (bucket sastanak-slike; zaključano → samo pregled) */}
        {(slike.length > 0 || editable) && (
          <div className="mt-2 flex flex-wrap gap-2">
            {slike.map((s) => (
              <SlikaThumb key={s.id} slika={s} editable={editable} />
            ))}
            {editable && (
              <label
                className={`flex h-16 w-24 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-control border border-dashed border-line text-2xs text-ink-secondary hover:border-accent hover:text-ink ${upload.isPending ? 'pointer-events-none opacity-60' : ''}`}
                title="Dodaj sliku uz tačku"
              >
                <Paperclip className="h-3.5 w-3.5" aria-hidden />
                {upload.isPending ? 'Otpremam…' : 'Dodaj sliku'}
                <input
                  type="file"
                  accept="image/*,application/pdf"
                  className="hidden"
                  onChange={(e) => {
                    const input = e.currentTarget;
                    const f = input.files?.[0];
                    input.value = '';
                    if (!f) return;
                    if (f.size > 20 * 1024 * 1024) {
                      alert('Fajl je veći od 20 MB.');
                      return;
                    }
                    upload.mutate(
                      { id: sastanakId, file: f, aktivnostId: tacka.id },
                      { onError: (err) => alert(err instanceof Error ? err.message : 'Upload nije uspeo.') },
                    );
                  }}
                />
              </label>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Thumbnail slike uz tačku: signed URL preview, klik = otvori u novom tabu,
 *  brisanje uz confirm (samo editable). PDF prilozi (1.0 accept ih dozvoljava)
 *  se prikazuju kao chip sa imenom fajla. */
function SlikaThumb({ slika, editable }: { slika: Slika; editable: boolean }) {
  const del = useDeleteSlika();
  const sign = useQuery({
    queryKey: ['sastanci', 'slika-sign', slika.id],
    queryFn: () => fetchSlikaUrl(slika.id),
    staleTime: 4 * 60_000,
  });
  const url = sign.data?.data.url;
  const isImage = (slika.mimeType ?? '').startsWith('image/');

  return (
    <div className="relative">
      <button
        type="button"
        title={slika.fileName || 'prilog'}
        disabled={!url}
        onClick={() => {
          if (url) window.open(url, '_blank', 'noopener');
        }}
        className="block overflow-hidden rounded-control border border-line bg-surface-2 hover:border-accent disabled:opacity-60"
      >
        {isImage && url ? (
          // eslint-disable-next-line @next/next/no-img-element -- signed URL van next/image domena
          <img src={url} alt={slika.fileName || 'slika'} className="h-16 w-16 object-cover" />
        ) : (
          <span className="flex h-16 w-24 items-center justify-center px-1 text-center text-2xs text-ink-secondary [overflow-wrap:anywhere]">
            {slika.fileName || 'prilog'}
          </span>
        )}
      </button>
      {editable && (
        <button
          type="button"
          aria-label="Obriši sliku"
          title="Obriši sliku"
          className="absolute -right-1.5 -top-1.5 rounded-full border border-line bg-surface p-0.5 text-status-danger shadow hover:bg-surface-2"
          onClick={() => {
            if (confirm('Obrisati sliku?')) del.mutate({ slikaId: slika.id });
          }}
        >
          <X className="h-3 w-3" aria-hidden />
        </button>
      )}
    </div>
  );
}
