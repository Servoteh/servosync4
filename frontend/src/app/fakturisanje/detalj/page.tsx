'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Ban, Coins, Mail, Printer, Send } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { useIdParam, listHref } from '@/lib/use-id-param';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { Button } from '@/components/ui-kit/button';
import { Select } from '@/components/ui-kit/select';
import { Dialog } from '@/components/ui-kit/dialog';
import { Textarea } from '@/components/ui-kit/textarea';
import { FormField, Input } from '@/components/ui-kit/form-field';
import { SendMailDialog } from '@/components/send-mail-dialog';
import { PERMISSIONS } from '@/lib/permissions';
import { formatDate, formatDecimal } from '@/lib/format';
import {
  useInvoice,
  useInvoicePdf,
  openPdf,
  useCreateInvoiceFromProforma,
  usePostInvoice,
  useSendInvoiceMail,
  useStornoInvoice,
  SALES_STATUS,
  SALES_DOCUMENT_TYPE,
  INVOICE_PRINT_VARIANT,
  type InvoicePrintVariant,
  type InvoiceDetail,
  type InvoiceItem,
} from '@/api/sales';
import {
  useEnqueue,
  useSefOutboxForInvoice,
  SEF_STATUS,
  type SefStatus,
} from '@/api/sef';
import {
  useCreateAdvanceFromProforma,
  type InvoiceAdvanceFields,
} from '@/api/avansi';
import { ApiError } from '@/api/client';
import { salesStatusMeta, DOCUMENT_TYPE_LABEL } from '../page';

/**
 * Fakturisanje — detalj računa (DESIGN_SYSTEM §4 obrazac „Master–detalj"): zaglavlje
 * (label–vrednost) + tabela stavki sa cenama i PDV-om. Status-uslovljena dugmad:
 * „Napravi račun iz predračuna" (from-proforma; DRAFT predračun PON/PROF), „Knjiži"
 * (post; DRAFT račun) i „Pošalji na SEF" (enqueue; knjižena domaća faktura koja još
 * nije u SEF redu). Postojeći SEF status fakture (outbox) se prikazuje kao badge sa
 * skokom na /sef. Data isključivo kroz `@/api/sales` i `@/api/sef` hook-ove; sve od
 * kit komponenti i tokena.
 *
 * TASTATURA: Ctrl+S = primarna akcija tekućeg statusa (prepiši/knjiži), Esc = nazad.
 */

/** Draft predračun/ponuda (PON/PROF) → nudi prepis (carry-over) u level-0 račun. */
const PROFORMA_TYPES = new Set<string>([
  SALES_DOCUMENT_TYPE.PON,
  SALES_DOCUMENT_TYPE.PROF,
]);

/**
 * Vrste štampe jednog dokumenta (BigBit paritet). Motor za sve postoji na backendu
 * (`?variant=…`); bez ovog izbora korisnik je mogao da odštampa SAMO račun — otpremnica,
 * knjižno odobrenje i knjižno zaduženje su bili nedostupni iako servis radi.
 */
const PRINT_VARIANT_OPTIONS: { value: InvoicePrintVariant; label: string }[] = [
  { value: INVOICE_PRINT_VARIANT.STANDARD, label: 'Račun' },
  { value: INVOICE_PRINT_VARIANT.DELIVERY, label: 'Otpremnica (bez cena)' },
  { value: INVOICE_PRINT_VARIANT.EXPORT, label: 'Ino faktura (engleski)' },
  { value: INVOICE_PRINT_VARIANT.ADVANCE, label: 'Avansni račun' },
  { value: INVOICE_PRINT_VARIANT.CREDIT_NOTE, label: 'Knjižno odobrenje' },
  { value: INVOICE_PRINT_VARIANT.DEBIT_NOTE, label: 'Knjižno zaduženje' },
];

/** Ciljne level-0 vrste za prepis predračuna → račun (backend carry-over). */
const TARGET_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: SALES_DOCUMENT_TYPE.IFR, label: 'Račun — roba (IFR)' },
  { value: SALES_DOCUMENT_TYPE.IFGP, label: 'Račun — gotov proizvod (IFGP)' },
  { value: SALES_DOCUMENT_TYPE.IFUSL, label: 'Račun — usluga (IFUSL)' },
  { value: SALES_DOCUMENT_TYPE.IZVRO, label: 'Izvoz — roba (IZVRO)' },
  { value: SALES_DOCUMENT_TYPE.IZVGP, label: 'Izvoz — gotov proizvod (IZVGP)' },
  { value: SALES_DOCUMENT_TYPE.IZVUS, label: 'Izvoz — usluga (IZVUS)' },
];

/** SEF outbox status → StatusBadge meta (kanonska mapa §7, SEF domen — 1:1 sa /sef). */
function sefStatusMeta(status: SefStatus): { tone: Tone; label: string } {
  switch (status) {
    case SEF_STATUS.PENDING:
      return { tone: 'warn', label: 'U redu' };
    case SEF_STATUS.SENT:
      return { tone: 'info', label: 'Poslato' };
    case SEF_STATUS.DELIVERED:
      return { tone: 'success', label: 'Isporučeno' };
    case SEF_STATUS.REJECTED:
      return { tone: 'danger', label: 'Odbijeno' };
    case SEF_STATUS.CANCELLED:
      return { tone: 'neutral', label: 'Stornirano' };
    default:
      return { tone: 'neutral', label: status };
  }
}

/** SEF statusi u kojima je faktura već „u toku" — ne nudi ponovni enqueue (izbegni duplikat). */
const IN_FLIGHT_SEF = new Set<SefStatus>([
  SEF_STATUS.PENDING,
  SEF_STATUS.SENT,
  SEF_STATUS.DELIVERED,
]);

/** Token klase feedback bannera za SEF akcije (uspeh / upozorenje / greška). */
const SEF_BANNER_TONE: Record<'success' | 'warn' | 'danger', string> = {
  success: 'border-status-success/40 bg-status-success-bg text-status-success',
  warn: 'border-status-warn/40 bg-status-warn-bg text-status-warn',
  danger: 'border-status-danger/40 bg-status-danger-bg text-status-danger',
};

const itemColumns: Column<InvoiceItem>[] = [
  {
    key: 'lineNo',
    header: 'R.br.',
    align: 'right',
    numeric: true,
    render: (it) => <span className="tnums text-ink-secondary">{it.lineNo}</span>,
  },
  {
    key: 'description',
    header: 'Artikal / opis',
    render: (it) => (
      <span className="text-ink">
        {it.description ?? (it.itemId != null ? `#${it.itemId}` : '—')}
      </span>
    ),
  },
  {
    key: 'quantity',
    header: 'Količina',
    align: 'right',
    numeric: true,
    render: (it) => <span className="tnums text-ink">{formatDecimal(it.quantity, 4)}</span>,
  },
  {
    key: 'unitPrice',
    header: 'Cena',
    align: 'right',
    numeric: true,
    render: (it) => <span className="tnums text-ink">{formatDecimal(it.unitPrice)}</span>,
  },
  {
    key: 'discountPercent',
    header: 'Rabat %',
    align: 'right',
    numeric: true,
    render: (it) => <span className="tnums text-ink-secondary">{formatDecimal(it.discountPercent)}</span>,
  },
  /**
   * OSNOVICA JE JEDINI NOVAC PO STAVCI KOJI SE SABIRA U ZAGLAVLJE.
   *
   * ⚠️ ZAŠTO SU KOLONE „PDV" I „UKUPNO" SKINUTE (02.08.2026, šesti krug provere):
   * PDV je obaveza po PROMETU I STOPI, ne po redu u tabeli — porez dokumenta se računa
   * kao `round2(osnovica_stope × stopa)` nad ZBIROM osnovica te stope
   * (`backend/src/modules/sales/vat-totals.ts`). `InvoiceItem.vatAmount` je zato IZVEDEN
   * podatak i njegov zbir NE MORA da bude PDV računa:
   *
   *     5 stavki × 100,01 din uz 20 %
   *       kolona „PDV" (zbir po stavci)   5 × 20,00 = 100,00
   *       PDV računa (zaglavlje, papir, e-faktura)  = 100,01     ← razlika 0,01
   *
   * Ekran je time tvrdio dva različita PDV-a za isti račun — jedan u koloni, drugi u
   * zbirnom bloku odmah ispod. Isto važi i za „Ukupno" (`vatBase + vatAmount`), pa je i
   * ono skinuto: zbir te kolone bi davao 600,05 uz „Za plaćanje 600,06".
   *
   * Ni jedan od ČETIRI donesena BigBit obrasca po stavci ne štampa iznos poreza — kolona
   * „PDV" je tamo STOPA (`domaca-roba.ts`, `domaca-usluga.ts`), a UBL na stavci uopšte
   * nema element za iznos poreza (EN 16931: stavka nosi samo `LineExtensionAmount`).
   * Ovde se stopa ne prikazuje jer bi tražila ČETVRTI primerak mape stopa na frontendu;
   * dok `GET /sales/invoices/:id` ne vrati razrešen procenat po stavci, kolona bi bila
   * pogađanje. Porez računa je u zbirnom bloku (`InvoiceTotals`) — jedno mesto, jedan broj.
   */
  {
    key: 'vatBase',
    header: 'Osnovica',
    align: 'right',
    numeric: true,
    render: (it) => (
      <span className="tnums font-semibold text-ink">{formatDecimal(it.vatBase)}</span>
    ),
  },
];

export default function FakturisanjeDetailPage() {
  const { user, isLoading, can } = useAuth();
  const router = useRouter();
  // Statička ruta `/fakturisanje/detalj?id=N` (static export — vidi use-id-param).
  // `goToInvoice` je detalj→detalj skok (prepis predračuna u račun): menja se SAMO
  // query, Next ne remontira stranicu, pa helper sam pomera state na novi id.
  const { id: validId, resolved: idResolved, go: goToInvoice } = useIdParam();

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  const query = useInvoice(validId);
  const doc = query.data ?? null;
  const error = query.error as Error | null;
  // „Nema id-a u URL-u" je isto što i „nije pronađen" — ali tek pošto se URL pročita.
  const notFound =
    (idResolved && validId == null) ||
    (validId != null && !query.isLoading && !query.error && query.data == null);

  const fromProforma = useCreateInvoiceFromProforma();
  const createAdvance = useCreateAdvanceFromProforma();
  const post = usePostInvoice();
  const pdf = useInvoicePdf();
  const enqueue = useEnqueue();
  const sendMail = useSendInvoiceMail();
  const storno = useStornoInvoice();

  const canWrite = can(PERMISSIONS.SALES_WRITE);
  const canPost = can(PERMISSIONS.SALES_POST);
  const canSefSend = can(PERMISSIONS.SEF_SEND);
  const canSefRead = can(PERMISSIONS.SEF_READ);

  // Ciljna vrsta prepisa (predračun → račun). Default IFR (roba u zemlji).
  const [targetType, setTargetType] = useState<string>(SALES_DOCUMENT_TYPE.IFR);
  // Vrsta štampe (račun / otpremnica / KO / KZ / …). Prazno = backend bira po vrsti
  // dokumenta (AVR → avansni obrazac, izvoz → ino faktura).
  const [printVariant, setPrintVariant] = useState<InvoicePrintVariant>(
    INVOICE_PRINT_VARIANT.STANDARD,
  );
  // SEF feedback (enqueue uspeh/upozorenje/greška) — nezavisan od carry-over/knjiži bannera.
  const [sefBanner, setSefBanner] = useState<{
    tone: 'success' | 'warn' | 'danger';
    msg: string;
  } | null>(null);
  // „Pošalji na mail" dijalog + feedback banner (nezavisan od SEF-a).
  const [mailOpen, setMailOpen] = useState(false);
  const [mailBanner, setMailBanner] = useState<{
    tone: 'success' | 'warn' | 'danger';
    msg: string;
  } | null>(null);
  // Storno dijalog (razlog obavezan) + feedback banner (A5).
  const [stornoOpen, setStornoOpen] = useState(false);
  const [stornoBanner, setStornoBanner] = useState<{
    tone: 'success' | 'warn' | 'danger';
    msg: string;
  } | null>(null);
  // Dijalog „Napravi avansni račun" (C1b) + feedback banner.
  const [advanceOpen, setAdvanceOpen] = useState(false);
  const [advanceBanner, setAdvanceBanner] = useState<{
    tone: 'success' | 'warn' | 'danger';
    msg: string;
  } | null>(null);

  // SKOK DETALJ → DETALJ (`goToInvoice`, prepis predračuna u račun) menja samo
  // query, pa Next NE remontira stranicu i sav lokalni state preživi zamenu
  // dokumenta. Bez ovog čišćenja je zelena potvrda o AVANSNOM RAČUNU jednog
  // dokumenta ostajala na vrhu SLEDEĆEG — pogrešna potvrda nad finansijskim
  // dokumentom — a otvoren dijalog bi slao iznos starog predračuna pod novim id-em.
  useEffect(() => {
    setSefBanner(null);
    setMailBanner(null);
    setStornoBanner(null);
    setAdvanceBanner(null);
    setMailOpen(false);
    setStornoOpen(false);
    setAdvanceOpen(false);
    setTargetType(SALES_DOCUMENT_TYPE.IFR);
    setPrintVariant(INVOICE_PRINT_VARIANT.STANDARD);
  }, [validId]);

  // D8: zaključan (proknjižen) dokument ne nudi izmene (prepis/knjiženje) — samo storno-put.
  const isProformaDraft =
    !!doc &&
    !doc.isLocked &&
    doc.status === SALES_STATUS.DRAFT &&
    PROFORMA_TYPES.has(doc.documentType);
  const isPostableInvoice =
    !!doc &&
    !doc.isLocked &&
    doc.status === SALES_STATUS.DRAFT &&
    !PROFORMA_TYPES.has(doc.documentType);

  // SEF izlaz (backend enqueue guard): samo knjižena (level 0), domaća (ne izvoz),
  // ni draft ni stornirana faktura sme na SEF.
  const isSefEligible =
    !!doc &&
    doc.level === 0 &&
    !doc.isExport &&
    doc.status !== SALES_STATUS.DRAFT &&
    doc.status !== SALES_STATUS.CANCELLED;

  // Storno (D8): samo zaključan (proknjižen) dokument koji još nije storniran. Backend
  // guard je merodavan; ovde afordansa dugmeta.
  const isStornoable =
    !!doc &&
    doc.isLocked &&
    doc.status !== SALES_STATUS.DRAFT &&
    doc.status !== SALES_STATUS.CANCELLED;

  // Postojeći outbox red(ovi) za ovu fakturu — status prikaz + guard protiv duplog enqueue-a.
  const sefOutbox = useSefOutboxForInvoice(validId, canSefRead && isSefEligible);
  const sefRows = sefOutbox.data?.data ?? [];
  const latestSefRow = sefRows[0] ?? null;
  const activeSefRow = sefRows.find((r) => IN_FLIGHT_SEF.has(r.status)) ?? null;

  // Povratak na listu VRAĆA I FILTERE (`listHref` čita poslednje stanje
  // liste) — bez toga se posle svakog otvorenog dokumenta gubio filter i strana.
  const goBack = useCallback(() => router.push(listHref('/fakturisanje')), [router]);

  const doFromProforma = useCallback(() => {
    // Guard protiv duplog okidanja (Ctrl+S dok mutacija još traje) — inače bi dva
    // brza triggera poslala dva carry-over zahteva (review 1D FE hardening).
    if (!doc || !canWrite || !isProformaDraft || fromProforma.isPending) return;
    fromProforma.mutate(
      { id: doc.id, targetType },
      { onSuccess: (created) => goToInvoice(created.id) },
    );
  }, [doc, canWrite, isProformaDraft, fromProforma, targetType, goToInvoice]);

  const doPost = useCallback(
    (force = false) => {
      // Guard protiv duplog knjiženja: Ctrl+S dok post traje ne sme okinuti drugi post
      // (backend CAS claim ionako odbija duplikat 409, ovo je UX-fast-fail) — review 1D.
      // force=true (T3/A8) preskače kreditni-limit guard (dugme „Proknjiži uprkos limitu").
      if (!doc || !canPost || !isPostableInvoice || post.isPending) return;
      post.mutate({ id: doc.id, force });
    },
    [doc, canPost, isPostableInvoice, post],
  );

  const doEnqueue = useCallback(() => {
    if (!doc || !canSefSend || !isSefEligible) return;
    setSefBanner(null);
    enqueue.mutate(doc.id, {
      onSuccess: (res) =>
        setSefBanner(
          res.warning
            ? {
                tone: 'warn',
                msg: `Faktura je stavljena u SEF red. Upozorenje: ${res.warning}`,
              }
            : {
                tone: 'success',
                msg: 'Faktura je stavljena u SEF red (status U redu). Slanje se pokreće na stranici SEF e-fakture.',
              },
        ),
      onError: (e) =>
        setSefBanner({
          tone: 'danger',
          msg: e instanceof Error ? e.message : 'Slanje na SEF nije uspelo — pokušaj ponovo.',
        }),
    });
  }, [doc, canSefSend, isSefEligible, enqueue]);

  // Ctrl+S = primarna akcija zavisna od statusa; Esc = nazad na listu.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Dok je dijalog otvoren prečice ekrana MIRUJU: bez ovoga je Esc zatvarao
      // dijalog I usput odnosio korisnika na listu (uneseni tekst nestaje), a
      // Ctrl+S je istovremeno slao obrazac dijaloga I okidao radnju ekrana.
      if (mailOpen || stornoOpen || advanceOpen) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        goBack();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (isProformaDraft) doFromProforma();
        else if (isPostableInvoice) doPost();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goBack, isProformaDraft, isPostableInvoice, doFromProforma, doPost, mailOpen, stornoOpen, advanceOpen]);

  if (isLoading || !user) {
    return (
      <main className="grid flex-1 place-items-center text-sm text-ink-secondary">
        Učitavanje…
      </main>
    );
  }

  // T3/A8: kreditni-limit 422 (CREDIT_LIMIT_EXCEEDED) NE ide u generički danger banner —
  // prikazuje se poseban warn banner sa dugmetom za svesno knjiženje uprkos limitu.
  const isCreditLimitError =
    post.error instanceof ApiError &&
    post.error.status === 422 &&
    (post.error.body as { code?: string } | null)?.code === 'CREDIT_LIMIT_EXCEEDED';

  const actionError =
    (fromProforma.error as Error | null)?.message ??
    (isCreditLimitError ? null : (post.error as Error | null)?.message) ??
    null;

  return (
    <AppShell>
      <PageHeader
        title={doc ? `Račun ${doc.documentNumber}` : 'Račun'}
        count={doc ? salesStatusMeta(doc.status).label : undefined}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={goBack}>
              <ArrowLeft className="h-4 w-4" aria-hidden />
              Nazad
            </Button>

            {doc && (
              <div className="flex items-center gap-2">
                <div className="w-52">
                  <Select
                    value={printVariant}
                    onChange={(e) =>
                      setPrintVariant(e.target.value as InvoicePrintVariant)
                    }
                    options={PRINT_VARIANT_OPTIONS}
                    aria-label="Vrsta štampe"
                  />
                </div>
                <Button
                  variant="secondary"
                  loading={pdf.isPending}
                  onClick={() =>
                    pdf.mutate(
                      { id: doc.id, variant: printVariant || undefined },
                      { onSuccess: (blob) => openPdf(blob) },
                    )
                  }
                >
                  <Printer className="h-4 w-4" aria-hidden />
                  Štampaj
                </Button>
              </div>
            )}

            {doc && canWrite && (
              <Button
                variant="secondary"
                onClick={() => {
                  setMailBanner(null);
                  setMailOpen(true);
                }}
              >
                <Mail className="h-4 w-4" aria-hidden />
                Pošalji na mail
              </Button>
            )}

            {isProformaDraft && canWrite && (
              <div className="flex items-center gap-2">
                <div className="w-56">
                  <Select
                    value={targetType}
                    onChange={(e) => setTargetType(e.target.value)}
                    options={TARGET_TYPE_OPTIONS}
                    aria-label="Ciljna vrsta računa"
                  />
                </div>
                <Button onClick={doFromProforma} loading={fromProforma.isPending}>
                  Napravi račun iz predračuna
                </Button>
                {/* C1b: avans se uzima PO PREDRAČUNU — PDV obaveza nastaje tek naplatom. */}
                <Button
                  variant="secondary"
                  onClick={() => {
                    setAdvanceBanner(null);
                    setAdvanceOpen(true);
                  }}
                >
                  <Coins className="h-4 w-4" aria-hidden />
                  Napravi avansni račun
                </Button>
              </div>
            )}

            {isPostableInvoice && canPost && (
              <Button onClick={() => doPost()} loading={post.isPending}>
                Knjiži
              </Button>
            )}

            {doc && isSefEligible && canSefRead && latestSefRow && (
              <div className="flex items-center gap-2">
                <span className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
                  SEF
                </span>
                <StatusBadge
                  tone={sefStatusMeta(latestSefRow.status).tone}
                  label={sefStatusMeta(latestSefRow.status).label}
                />
                <Button
                  variant="ghost"
                  onClick={() => router.push('/sef')}
                  title="Otvori SEF e-fakture"
                >
                  Prikaži na SEF-u
                </Button>
              </div>
            )}

            {doc && isSefEligible && canSefSend && !activeSefRow && !sefOutbox.isLoading && (
              <Button onClick={doEnqueue} loading={enqueue.isPending}>
                <Send className="h-4 w-4" aria-hidden />
                Pošalji na SEF
              </Button>
            )}

            {isStornoable && canPost && (
              <Button
                variant="danger"
                onClick={() => {
                  setStornoBanner(null);
                  setStornoOpen(true);
                }}
              >
                <Ban className="h-4 w-4" aria-hidden />
                Storno
              </Button>
            )}
          </div>
        }
      />

      <div className="flex-1 space-y-4 overflow-auto p-6">
        {error && (
          <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
            {error.message}
          </div>
        )}
        {actionError && (
          <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
            {actionError}
          </div>
        )}
        {isCreditLimitError && (
          <div
            className={`flex flex-col gap-2 rounded-panel border px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between ${SEF_BANNER_TONE.warn}`}
          >
            <span>{(post.error as Error).message}</span>
            <Button
              variant="secondary"
              onClick={() => doPost(true)}
              loading={post.isPending}
            >
              Proknjiži uprkos limitu
            </Button>
          </div>
        )}
        {sefBanner && (
          <div className={`rounded-panel border px-4 py-3 text-sm ${SEF_BANNER_TONE[sefBanner.tone]}`}>
            {sefBanner.msg}
          </div>
        )}
        {mailBanner && (
          <div className={`rounded-panel border px-4 py-3 text-sm ${SEF_BANNER_TONE[mailBanner.tone]}`}>
            {mailBanner.msg}
          </div>
        )}
        {stornoBanner && (
          <div className={`rounded-panel border px-4 py-3 text-sm ${SEF_BANNER_TONE[stornoBanner.tone]}`}>
            {stornoBanner.msg}
          </div>
        )}
        {advanceBanner && (
          <div className={`rounded-panel border px-4 py-3 text-sm ${SEF_BANNER_TONE[advanceBanner.tone]}`}>
            {advanceBanner.msg}
          </div>
        )}

        {!idResolved || (validId != null && query.isLoading) ? (
          <div className="grid place-items-center py-16 text-sm text-ink-secondary">
            Učitavanje…
          </div>
        ) : error ? (
          // Greška servera NIJE „dokument ne postoji". Ranije se uz crveni baner
          // palila i poruka „možda je obrisan", pa je knjigovođa posle restarta
          // backenda tražio proknjižen dokument koji nikad nije nestao.
          <EmptyState
            title="Podatak nije učitan"
            hint="Veza sa serverom je prekinuta ili je zahtev odbijen. Osveži stranicu; ako se ponovi, javi administratoru."
          />
        ) : notFound || !doc ? (
          <EmptyState
            title="Račun nije pronađen"
            hint={
              validId == null
                ? 'Adresa nema ispravan broj računa (?id=). Vrati se na radnu listu i otvori račun iz liste.'
                : 'Račun je možda obrisan ili nemaš pristup. Vrati se na radnu listu.'
            }
          />
        ) : (
          <>
            <InvoiceHeader doc={doc} />

            <section className="space-y-2">
              <h2 className="text-md font-semibold text-ink">Stavke</h2>
              {/* Zašto tabela nema kolone „PDV" i „Ukupno" — v. `itemColumns`. */}
              <p className="text-sm text-ink-secondary">
                Iznosi su bez PDV-a. PDV se obračunava na nivou računa, po stopi — vidi zbir ispod.
              </p>
              <DataTable
                columns={itemColumns}
                rows={doc.items}
                rowKey={(it) => it.id}
                empty={
                  <EmptyState
                    title="Račun nema stavki"
                    hint="Stavke se dodaju pri kreiranju predračuna."
                  />
                }
              />
              <InvoiceTotals doc={doc} />
            </section>
          </>
        )}
      </div>

      {mailOpen && doc && (
        <SendMailDialog
          title={`Pošalji račun ${doc.documentNumber}`}
          intro="Račun se šalje kao PDF prilog. Ostavi email prazan da se pošalje na adresu komitenta sa računa."
          toRequired={false}
          toHint="Ostavi prazno za email komitenta sa računa."
          withNote
          sending={sendMail.isPending}
          error={(sendMail.error as Error | null)?.message ?? null}
          onClose={() => setMailOpen(false)}
          onSend={({ to, note }) =>
            sendMail.mutate(
              { id: doc.id, to, note },
              {
                onSuccess: (res) => {
                  setMailOpen(false);
                  setMailBanner(
                    res.data.sent
                      ? { tone: 'success', msg: `Račun poslat na ${res.data.to}.` }
                      : {
                          tone: 'warn',
                          msg: `PDF je generisan, ali slanje nije izvršeno (sistem za slanje nije konfigurisan ili je adresa ${res.data.to} nedostupna).`,
                        },
                  );
                },
              },
            )
          }
        />
      )}

      {doc && (
        <StornoDialog
          open={stornoOpen}
          onClose={() => setStornoOpen(false)}
          invoiceId={doc.id}
          documentNumber={doc.documentNumber}
          storno={storno}
          onDone={(banner) => setStornoBanner(banner)}
        />
      )}

      {doc && advanceOpen && (
        <NewAdvanceDialog
          proforma={doc}
          createAdvance={createAdvance}
          onClose={() => setAdvanceOpen(false)}
          onDone={(banner) => setAdvanceBanner(banner)}
          onOpenAdvances={() => router.push('/fakturisanje/avansi')}
        />
      )}
    </AppShell>
  );
}

/**
 * Dijalog „Napravi avansni račun" (C1b) — avans se uzima PO PREDRAČUNU. Iznos je
 * podrazumevano ceo predračun (delimičan avans se upiše ručno). PDV obaveza po
 * avansu nastaje TEK NAPLATOM — to se radi na ekranu Avansni računi.
 * TASTATURA: Ctrl+S potvrdi, Esc otkaži.
 */
function NewAdvanceDialog({
  proforma,
  createAdvance,
  onClose,
  onDone,
  onOpenAdvances,
}: {
  proforma: InvoiceDetail;
  createAdvance: ReturnType<typeof useCreateAdvanceFromProforma>;
  onClose: () => void;
  onDone: (banner: { tone: 'success' | 'warn' | 'danger'; msg: string }) => void;
  onOpenAdvances: () => void;
}) {
  const [amount, setAmount] = useState(() => String(Number(proforma.grossTotal)));
  const [documentDate, setDocumentDate] = useState(() =>
    new Date().toISOString().slice(0, 10),
  );

  const parsed = Number(amount);
  const valid = Number.isFinite(parsed) && parsed > 0 && documentDate !== '';
  const err = (createAdvance.error as Error | null)?.message ?? null;

  const submit = () => {
    if (!valid || createAdvance.isPending) return;
    createAdvance.mutate(
      { proformaId: proforma.id, amount: parsed, documentDate },
      {
        onSuccess: (res) => {
          onDone({
            tone: 'success',
            msg:
              `Avansni račun ${res.data.documentNumber} je napravljen (bruto ` +
              `${formatDecimal(res.data.grossTotal)} ${res.data.currency}). PDV obaveza nastaje ` +
              `tek naplatom — označi je na ekranu Avansni računi.`,
          });
          onClose();
          onOpenAdvances();
        },
      },
    );
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Napravi avansni račun"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={createAdvance.isPending}>
            Otkaži
          </Button>
          <Button onClick={submit} loading={createAdvance.isPending} disabled={!valid}>
            Napravi
          </Button>
        </div>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
            e.preventDefault();
            submit();
          }
        }}
      >
        <p className="text-sm text-ink-secondary">
          Avansni račun se pravi po predračunu {proforma.documentNumber} (bruto{' '}
          {formatDecimal(proforma.grossTotal)} {proforma.currency}). PDV obaveza po avansu
          nastaje NAPLATOM, ne izdavanjem — naplata se označava na ekranu Avansni računi.
        </p>

        {err && (
          <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-3 py-2 text-sm text-status-danger">
            {err}
          </div>
        )}

        <div className="flex gap-3">
          <div className="w-44">
            <FormField label="Iznos avansa" required hint="Bruto; može i delimičan.">
              <Input
                type="number"
                step="0.01"
                min="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                autoFocus
              />
            </FormField>
          </div>
          <div className="w-44">
            <FormField label="Datum" required>
              <Input
                type="date"
                value={documentDate}
                onChange={(e) => setDocumentDate(e.target.value)}
              />
            </FormField>
          </div>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * Dijalog storna (A5) — razlog OBAVEZAN. Storno je konačan: status → Stornirano,
 * nalog GK se obrće, poslata SEF e-faktura se otkazuje. Deli `storno` mutaciju sa
 * roditeljem (jedan izvor stanja/greške). TASTATURA: Ctrl+S potvrdi, Esc otkaži.
 */
function StornoDialog({
  open,
  onClose,
  invoiceId,
  documentNumber,
  storno,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  invoiceId: number;
  documentNumber: string;
  storno: ReturnType<typeof useStornoInvoice>;
  onDone: (banner: { tone: 'success' | 'warn' | 'danger'; msg: string }) => void;
}) {
  const [reason, setReason] = useState('');
  const trimmed = reason.trim();
  const err = (storno.error as Error | null)?.message ?? null;

  const submit = () => {
    if (trimmed.length === 0 || storno.isPending) return;
    storno.mutate(
      { id: invoiceId, reason: trimmed },
      {
        onSuccess: (res) => {
          const sefNote =
            res.sefCancelledOutboxIds.length > 0
              ? ` Otkazano SEF redova: ${res.sefCancelledOutboxIds.length}.`
              : '';
          onDone({ tone: 'success', msg: `Račun ${documentNumber} je storniran.${sefNote}` });
          setReason('');
          onClose();
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Storno računa"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={storno.isPending}>
            Odustani
          </Button>
          <Button
            variant="danger"
            onClick={submit}
            loading={storno.isPending}
            disabled={trimmed.length === 0}
          >
            Storniraj
          </Button>
        </div>
      }
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
            e.preventDefault();
            submit();
          }
        }}
      >
        <p className="text-sm text-ink-secondary">
          Storno je konačan: status prelazi u Stornirano, nalog glavne knjige se obrće, a
          poslata SEF e-faktura se otkazuje. Razlog je obavezan.
        </p>
        {err && (
          <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-3 py-2 text-sm text-status-danger">
            {err}
          </div>
        )}
        <FormField label="Razlog storna" required>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            placeholder="npr. pogrešan kupac ili iznos"
            autoFocus
          />
        </FormField>
      </form>
    </Dialog>
  );
}

/** Zaglavlje računa — label/vrednost mreža (DESIGN_SYSTEM §5). */
function InvoiceHeader({ doc }: { doc: InvoiceDetail }) {
  const s = salesStatusMeta(doc.status);
  return (
    <section className="rounded-panel border border-line bg-surface p-5">
      <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Broj">
          <span className="tnums font-semibold text-ink">{doc.documentNumber}</span>
        </Field>
        <Field label="Tip">
          <span className="text-ink">{DOCUMENT_TYPE_LABEL[doc.documentType] ?? doc.documentType}</span>
        </Field>
        <Field label="Status">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge tone={s.tone} label={s.label} />
            {doc.isLocked && <StatusBadge tone="neutral" label="Zaključano" />}
          </div>
        </Field>
        <Field label="Nivo">
          <span className="tnums text-ink">{doc.level === 250 ? 'Predračun (250)' : 'Knjižen (0)'}</span>
        </Field>
        <Field label="Kupac">
          <span className="tnums text-ink">{doc.customerId ?? '—'}</span>
        </Field>
        <Field label="Broj narudžbenice">
          <span className="tnums text-ink">{doc.poNumber ?? '—'}</span>
        </Field>
        <Field label="Datum izdavanja">
          <span className="text-ink">{formatDate(doc.documentDate)}</span>
        </Field>
        <Field label="Valuta (rok)">
          <span className="text-ink">{formatDate(doc.dueDate)}</span>
        </Field>
        <Field label="Valuta">
          <span className="text-ink">{doc.currency}</span>
        </Field>
        <Field label="Izvoz">
          {doc.isExport ? (
            <StatusBadge tone="info" label="Da" />
          ) : (
            <span className="text-ink-disabled">Ne</span>
          )}
        </Field>
        <Field label="Nalog GK">
          <span className="tnums text-ink">{doc.journalEntryId ?? '—'}</span>
        </Field>
        <Field label="Robni dokument">
          <span className="tnums text-ink">{doc.stockDocumentId ?? '—'}</span>
        </Field>
        <Field label="Broj stavki">
          <span className="tnums text-ink">{doc.items.length}</span>
        </Field>
      </dl>
      {doc.note && (
        <div className="mt-4 border-t border-line-soft pt-4">
          <dt className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
            Napomena
          </dt>
          <dd className="mt-1 whitespace-pre-wrap text-sm text-ink">{doc.note}</dd>
        </div>
      )}
    </section>
  );
}

/**
 * Zbirni iznosi računa (osnovica / PDV / za plaćanje).
 *
 * C1b: kad je na račun vezan avans (`advanceAppliedAmount > 0`), ispod „Za plaćanje"
 * ide red „Umanjenje za primljeni avans" i konačno „ZA UPLATU" = bruto − avans.
 * Avans NE umanjuje osnovicu prihoda ni PDV — samo iznos koji kupac još duguje.
 */
function InvoiceTotals({ doc }: { doc: InvoiceDetail }) {
  // `advance_*` kolone nisu u `@/api/sales` tipu (granica paketa) — vidi InvoiceAdvanceFields.
  const adv = doc as InvoiceDetail & InvoiceAdvanceFields;
  const applied = Number(adv.advanceAppliedAmount ?? 0);
  const hasAdvance = Number.isFinite(applied) && applied > 0;
  // „Za uplatu" računa BACKEND (Decimal) i vraća ga kao `payableAmount` — koristi
  // njega, a Float razliku samo kao rezervu za starije odgovore. Dva izvora istine
  // za isti novčani iznos su se ranije mogla raziću u zadnjoj pari.
  const toPay = adv.payableAmount ?? String(Number(doc.grossTotal) - (hasAdvance ? applied : 0));

  return (
    <div className="flex justify-end">
      <dl className="w-full max-w-xs space-y-1 rounded-panel border border-line bg-surface-2 p-4 text-sm">
        <TotalRow label="Osnovica" value={`${formatDecimal(doc.netTotal)} ${doc.currency}`} />
        <TotalRow label="PDV" value={`${formatDecimal(doc.vatTotal)} ${doc.currency}`} />
        <div className="mt-1 border-t border-line pt-1">
          <TotalRow
            label="Za plaćanje"
            value={`${formatDecimal(doc.grossTotal)} ${doc.currency}`}
            strong={!hasAdvance}
          />
        </div>
        {hasAdvance && (
          <>
            <TotalRow
              label="Umanjenje za primljeni avans"
              value={`− ${formatDecimal(applied)} ${doc.currency}`}
            />
            <div className="mt-1 border-t border-line pt-1">
              <TotalRow
                label="Za uplatu"
                value={`${formatDecimal(toPay)} ${doc.currency}`}
                strong
              />
            </div>
          </>
        )}
      </dl>
    </div>
  );
}

function TotalRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-ink-secondary">{label}</dt>
      <dd className={strong ? 'tnums font-semibold text-ink' : 'tnums text-ink'}>{value}</dd>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
        {label}
      </dt>
      <dd className="mt-1 text-sm">{children}</dd>
    </div>
  );
}
