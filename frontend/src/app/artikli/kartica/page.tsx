'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, FileText, Printer } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { Button } from '@/components/ui-kit/button';
import { Select } from '@/components/ui-kit/select';
import { Input } from '@/components/ui-kit/form-field';
import { toast } from '@/lib/toast';
import { listHref, useIdParam } from '@/lib/use-id-param';
import { formatDate, formatDecimal } from '@/lib/format';
import { useArtikal } from '@/api/masters';
import { useWarehousesLookup } from '@/api/lookups';
import {
  useItemCard,
  useItemCardPdf,
  openPdf,
  ROBNO_KIND,
  type ItemCardLine,
  type RobnoKind,
} from '@/api/robno';

/**
 * KARTICA ARTIKLA — hronološko kretanje jednog artikla po magacinu sa running
 * stanjem (BigBit dugme „Kartica artikla" iz pregleda artikala).
 *
 * Ekran je most između DVA modula i to mu određuje ceo oblik:
 *  • identitet artikla čita iz matičnih podataka (`/artikli/:id`, pravo
 *    `directory.read`) — kat. broj, naziv, jedinicu mere;
 *  • kretanja čita iz robnog (`/robno/item-card`, pravo `robno.read`), koje danas
 *    imaju samo nabavka i menadžment.
 *
 * 🔴 Zato je pravo `robno.read` USLOV ZA CEO EKRAN, a ne samo za tabelu: lista
 * artikala stavku „Kartica artikla" nekome bez tog prava uopšte ne nudi, a ko ovde
 * dođe preko linka dobija objašnjenje šta mu fali — nikad go 403 iz mreže.
 *
 * ⚠️ STATIČKA RUTA `?id=N`, ne `[id]` segment: dinamički segmenti NE rade na static
 * exportu (`output: "export"`) — klijentska navigacija traži neizvezen prerender pa
 * hard-404 (incident 22.07). Id se čita kroz `useIdParam()` iz `window.location`,
 * NIKAD kroz `useSearchParams` (on bi tražio Suspense oko cele strane).
 *
 * NAPOMENA O PODACIMA (mereno 04.08.2026): `stock_levels` i `stock_reservations` u
 * 4.0 su prazni — dok se roba ne knjiži ovde, kartica legitimno nema nijedan red.
 * Prazno stanje to KAŽE, umesto da izgleda kao kvar.
 */

const KIND_LABEL: Record<RobnoKind, string> = {
  [ROBNO_KIND.UL]: 'Ulaz',
  [ROBNO_KIND.IZ]: 'Izlaz',
  [ROBNO_KIND.NIV]: 'Nivelacija',
  [ROBNO_KIND.PRENOS]: 'Prenos',
  [ROBNO_KIND.VISAK]: 'Višak',
  [ROBNO_KIND.MANJAK]: 'Manjak',
};

const columns: Column<ItemCardLine>[] = [
  {
    key: 'documentDate',
    header: 'Datum',
    render: (r) => <span className="whitespace-nowrap text-ink-secondary">{formatDate(r.documentDate)}</span>,
  },
  {
    key: 'documentNumber',
    header: 'Dokument',
    render: (r) => <span className="tnums font-semibold text-ink">{r.documentNumber}</span>,
  },
  {
    key: 'kind',
    header: 'Vrsta',
    render: (r) => (
      <span className="whitespace-nowrap text-ink">
        {KIND_LABEL[r.kind] ?? r.kind}{' '}
        <span className="tnums text-2xs text-ink-secondary">{r.documentTypeCode}</span>
      </span>
    ),
  },
  {
    key: 'in',
    header: 'Ulaz',
    align: 'right',
    numeric: true,
    render: (r) =>
      r.direction === 'IN' ? (
        <span className="tnums text-ink">{formatDecimal(r.in, 3)}</span>
      ) : (
        <span className="text-ink-disabled">—</span>
      ),
  },
  {
    key: 'out',
    header: 'Izlaz',
    align: 'right',
    numeric: true,
    render: (r) =>
      r.direction === 'OUT' ? (
        <span className="tnums text-ink">{formatDecimal(r.out, 3)}</span>
      ) : (
        <span className="text-ink-disabled">—</span>
      ),
  },
  {
    key: 'balance',
    header: 'Stanje',
    align: 'right',
    numeric: true,
    render: (r) => (
      <span className="tnums font-semibold text-ink">{formatDecimal(r.balance, 3)}</span>
    ),
  },
];

/** Jedna vrednost u zaglavlju kartice (labela 10.5px uppercase iznad vrednosti). */
function Podatak({ labela, children }: { labela: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
        {labela}
      </dt>
      <dd className="mt-1 text-sm">{children}</dd>
    </div>
  );
}

/** Dugme „Nazad" — isto na kapiji i na samoj kartici. */
function DugmeNazad({ onNazad }: { onNazad: () => void }) {
  return (
    <Button variant="secondary" onClick={onNazad} title="Nazad na listu artikala (Esc)">
      <ArrowLeft className="h-4 w-4" aria-hidden />
      Nazad
    </Button>
  );
}

/**
 * KAPIJA: prijava, pravo `robno.read` i `?id=N`. Sadržaj kartice je zaseban
 * komponent i montira se TEK kad sva tri uslova stoje — tako nijedan upit
 * (`/artikli/:id`, `/lookups/warehouses`, `/robno/item-card`) ne krene za korisnika
 * koji pravo nema, umesto da tri zahteva vrate 403 iza ekrana sa objašnjenjem.
 */
export default function KarticaArtiklaPage() {
  const { user, isLoading, can, permissionsPending } = useAuth();
  const router = useRouter();
  const { id, resolved } = useIdParam();

  const nazadNaListu = useCallback(() => router.push(listHref('/artikli')), [router]);

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  // Esc = nazad na listu (DESIGN_SYSTEM §8 — Esc zatvara najviši sloj).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') nazadNaListu();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [nazadNaListu]);

  // Čeka i `permissionsPending`: `/auth/me` i `/auth/me/permissions` su dva paralelna
  // upita, a `can()` je dotle fail-closed — bez ovoga bi svakom korisniku na tren
  // bljesnula poruka „nemate pristup".
  if (isLoading || permissionsPending || !user) {
    return (
      <main className="grid flex-1 place-items-center text-sm text-ink-secondary">
        Učitavanje…
      </main>
    );
  }

  if (!can(PERMISSIONS.ROBNO_READ)) {
    return (
      <AppShell>
        <PageHeader title="Kartica artikla" actions={<DugmeNazad onNazad={nazadNaListu} />} />
        <div className="grid flex-1 place-items-center p-6">
          <EmptyState
            title="Nemate pristup kartici artikla"
            hint={
              <>
                Kartica prikazuje kretanje robe po magacinu, pa traži pravo pristupa modulu
                Robno / magacin (<span className="tnums">robno.read</span>) — danas ga imaju
                nabavka i menadžment. Matični podaci artikla su vam i dalje dostupni preko
                dugmeta „Detaljno artikal" u listi; za pristup kartici se javi administratoru
                (Podešavanja → Korisnici).
              </>
            }
          />
        </div>
      </AppShell>
    );
  }

  if (id === null) {
    return (
      <AppShell>
        <PageHeader title="Kartica artikla" actions={<DugmeNazad onNazad={nazadNaListu} />} />
        <div className="grid flex-1 place-items-center p-6">
          {/* Dok se `?id=` ne pročita iz adrese (prvi render) ne tvrdimo da fali —
              inače bi svaka kartica na tren pisala „nedostaje šifra artikla". */}
          {resolved && (
            <EmptyState
              title="Nedostaje šifra artikla"
              hint={
                'Otvori karticu iz liste artikala (dugme „Kartica artikla“ ili desni klik na red).'
              }
            />
          )}
        </div>
      </AppShell>
    );
  }

  return <Kartica id={id} onNazad={nazadNaListu} />;
}

function Kartica({ id, onNazad }: { id: number; onNazad: () => void }) {
  const router = useRouter();

  // Identitet artikla ide iz matičnih podataka (`directory.read`), kretanja iz robnog.
  const artikal = useArtikal(id);
  const a = artikal.data?.data;

  const magacini = useWarehousesLookup();
  const [magacin, setMagacin] = useState('');
  const [od, setOd] = useState('');
  const [doDatuma, setDoDatuma] = useState('');

  // Podrazumevani magacin = prvi iz šifarnika. Bez toga bi kartica čekala da
  // korisnik pogodi broj magacina, a u 99% slučajeva postoji samo jedan.
  const magacinOpcije = useMemo(
    () =>
      (magacini.data?.data ?? []).map((m) => ({
        value: String(m.id),
        label: m.city ? `${m.id} — ${m.name} (${m.city})` : `${m.id} — ${m.name}`,
      })),
    [magacini.data],
  );
  useEffect(() => {
    const prvi = magacinOpcije[0];
    if (magacin === '' && prvi) setMagacin(prvi.value);
  }, [magacin, magacinOpcije]);

  const filteri = useMemo(
    () => ({
      itemId: id,
      warehouseId: Number(magacin) || null,
      from: od || undefined,
      to: doDatuma || undefined,
    }),
    [id, magacin, od, doDatuma],
  );

  const kartica = useItemCard(filteri);
  const card = kartica.data?.data ?? null;
  const pdf = useItemCardPdf();

  const naslov = a ? a.name : 'Kartica artikla';
  const oznaka = a?.catalogNumber;

  return (
    <AppShell>
      <PageHeader
        title={naslov}
        count={oznaka ? `Kartica artikla · ${oznaka}` : 'Kartica artikla'}
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              onClick={() => router.push(`/artikli/detalj?id=${id}`)}
              title="Matični slog artikla (67 kolona)"
            >
              <FileText className="h-4 w-4" aria-hidden />
              <span className="max-sm:hidden">Detaljno artikal</span>
            </Button>
            {/* Štampa je moguća tek kad je kartica prikazana — inače nema šta da se štampa. */}
            <Button
              variant="secondary"
              disabled={card == null}
              loading={pdf.isPending}
              title="Kartica artikla u PDF-u (period, donos, ulaz/izlaz/stanje, kontrolno stanje)"
              onClick={() =>
                pdf.mutate(filteri, {
                  onSuccess: (blob) => openPdf(blob),
                  onError: (e) => toast(`Štampa nije uspela: ${(e as Error).message}`),
                })
              }
            >
              <Printer className="h-4 w-4" aria-hidden />
              <span className="max-sm:hidden">Štampaj</span>
            </Button>
            <DugmeNazad onNazad={onNazad} />
          </div>
        }
      />

      <div className="flex-1 space-y-4 overflow-auto p-6">
        {/* Filter traka — isti lagani idiom kao lista artikala. Magacin je obavezan:
            kartica je uvek PO MAGACINU (zbir preko svih magacina nije kartica). */}
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-ink-secondary">
            Magacin
            <div className="w-64">
              <Select
                placeholder={magacini.isLoading ? 'učitavanje…' : 'izaberi magacin'}
                value={magacin}
                onChange={(e) => setMagacin(e.target.value)}
                options={magacinOpcije}
              />
            </div>
          </label>

          <label className="flex flex-col gap-1 text-xs text-ink-secondary">
            Od datuma
            <div className="w-40">
              <Input type="date" value={od} onChange={(e) => setOd(e.target.value)} />
            </div>
          </label>

          <label className="flex flex-col gap-1 text-xs text-ink-secondary">
            Do datuma
            <div className="w-40">
              <Input
                type="date"
                value={doDatuma}
                onChange={(e) => setDoDatuma(e.target.value)}
              />
            </div>
          </label>

          {(od !== '' || doDatuma !== '') && (
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setOd('');
                setDoDatuma('');
              }}
            >
              Ceo period
            </Button>
          )}
        </div>

        {artikal.error && (
          <p className="text-sm text-ink-secondary">
            Matični podaci artikla nisu učitani — kartica kretanja radi normalno.
          </p>
        )}

        {magacini.error && (
          <p className="text-sm text-ink-secondary">
            Šifarnik magacina nije učitan — izaberi magacin kad lista stigne.
          </p>
        )}

        {kartica.error && (
          <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
            {(kartica.error as Error).message}
          </div>
        )}

        {/* Zaglavlje kartice: identitet iz matičnih + zbirovi iz robnog. „Krajnje
            stanje" je running saldo, a „Kontrolno stanje" nezavisno izračunato
            (costing) — kad se razilaze, kartica to POKAZUJE umesto da ćuti. */}
        <div className="rounded-panel border border-line bg-surface p-4">
          <dl className="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
            <Podatak labela="Kataloški broj">
              <span className="tnums font-semibold text-ink">{oznaka ?? '—'}</span>
            </Podatak>
            <Podatak labela="Naziv">
              <span className="block truncate text-ink" title={a?.name ?? undefined}>
                {a?.name ?? card?.item?.name ?? '—'}
              </span>
            </Podatak>
            <Podatak labela="Početno stanje">
              <span className="tnums text-ink">
                {card ? formatDecimal(card.openingBalance, 3) : '—'}
              </span>
            </Podatak>
            <Podatak labela="Ukupan ulaz">
              <span className="tnums text-ink">
                {card ? formatDecimal(card.totalIn, 3) : '—'}
              </span>
            </Podatak>
            <Podatak labela="Ukupan izlaz">
              <span className="tnums text-ink">
                {card ? formatDecimal(card.totalOut, 3) : '—'}
              </span>
            </Podatak>
            <Podatak labela="Krajnje stanje">
              <span className="tnums font-semibold text-ink">
                {card ? formatDecimal(card.closingBalance, 3) : '—'}{' '}
                {a?.unit ?? card?.item?.unit ?? ''}
              </span>
            </Podatak>
          </dl>

          {/* Poređenje po VREDNOSTI, ne po tekstu: obe veličine su Decimal-as-string
              (BACKEND_RULES §6), pa bi „10.000" i „10" kao stringovi lažno odudarali. */}
          {card && Number(card.closingBalance) !== Number(card.stateAsOf) && (
            <p className="mt-3 text-sm text-status-warn">
              Kontrolno stanje na dan {formatDate(card.to)} je{' '}
              <span className="tnums">{formatDecimal(card.stateAsOf, 3)}</span>, a zbir
              kretanja daje <span className="tnums">{formatDecimal(card.closingBalance, 3)}</span>{' '}
              — javi razliku knjigovodstvu pre nego što se kartica koristi kao dokaz.
            </p>
          )}
        </div>

        <DataTable
          columns={columns}
          rows={card?.lines ?? []}
          rowKey={(r) => r.itemLineId}
          loading={kartica.isLoading}
          onRowActivate={(r) => router.push(`/robno/detalj?id=${r.documentId}`)}
          stickyHeader
          maxHeight="calc(100dvh - 27rem)"
          empty={
            <EmptyState
              title="Nema kretanja"
              hint="Za ovaj artikal i magacin nema robnih dokumenata u izabranom periodu. Roba se u 4.0 tek počinje knjižiti — istorija iz BigBit-a nije preneta."
            />
          }
        />

        <p className="text-sm text-ink-disabled">
          Kretanja iz robnih dokumenata 4.0 (ulaz, izlaz, nivelacija, prenos, popis) — klik
          na red ili Enter otvara dokument.
        </p>
      </div>
    </AppShell>
  );
}
