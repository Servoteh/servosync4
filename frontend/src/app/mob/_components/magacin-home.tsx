'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ChevronRight,
  History,
  Hourglass,
  Keyboard,
  Layers,
  MoreHorizontal,
  Repeat,
  ScanLine,
  Search,
  type LucideIcon,
} from 'lucide-react';
import type { Permission } from '@/lib/permissions';
import {
  countPendingMovements,
  installAutoFlush,
  subscribeQueue,
} from '@/lib/offlineQueue';
import { visibleMobHrefs } from './mob-modules';

/**
 * „Magacinska" početna `/mob` — PLAN_MOB_IZGLED_1.0_PARITET §3.2 A (F2).
 *
 * Odluka Nenada 01.08.2026: magacinska ekipa ne treba mrežu od 18 kartica u kojoj
 * je „Magacin" jedna među njima — njen posao je sken → premesti → zaduži, pa je to
 * i raspored ekrana: jedna velika akcija, četiri prečice, reversi, pa „Svi moduli".
 * Ništa se ne gubi — sve ostalo je jedan tap dalje (`/mob/vise`).
 *
 * Ko ovo vidi presuđuje `useMagacinskiKrug` (radno mesto iz sistematizacije).
 * Šta sme da otvori i dalje presuđuju permisije — stavke se gase kroz
 * `visibleMobHrefs`, ISTIM gate-om kao hub i „Više" (bez lokalne kopije pravila).
 */

/** Vidljiv fokus na svakoj kontroli (DS §11) — nikad `outline:none` bez zamene. */
const FOCUS = 'focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]';

/** Red pune širine (reversi, „Svi moduli") — meta ≥44px, isti jezik kao hub grupe. */
const ROW = `flex min-h-14 items-center gap-3 rounded-panel border border-line bg-surface p-4 active:bg-surface-2 ${FOCUS}`;

export function MagacinHome({ can }: { can: (permission: Permission) => boolean }) {
  const hrefs = visibleMobHrefs(can);

  // Neposlata premeštanja (offline queue) — ISTI obraz kao `/mob/lokacije`:
  // brojač iz localStorage se čita tek u efektu (server ga nema → hidratacija bi
  // pukla), a `subscribeQueue` ga održava bez pollinga.
  const [pending, setPending] = useState(0);
  useEffect(() => {
    installAutoFlush();
    setPending(countPendingMovements());
    return subscribeQueue(() => setPending(countPendingMovements()));
  }, []);

  const canLokacije = hrefs.has('/mob/lokacije');

  return (
    <div className="space-y-3">
      {/* Pozdrav (paritet 1.0 „Zdravo 👋" + jedna linija konteksta). Emoji je ovde
          deo POZDRAVA, ne ikona — ikone su svuda lucide (DS §2). */}
      <div className="px-1">
        <p className="text-lg font-bold text-ink">Zdravo 👋</p>
        <p className="text-sm text-ink-secondary">Skeniraj, premesti, zaduži.</p>
      </div>

      {canLokacije && (
        <>
          {/* Glavni posao — jedina naglašena (akcentna) meta na ekranu. */}
          <Link
            href="/mob/lokacije"
            className={`flex min-h-20 items-center gap-4 rounded-panel bg-accent p-4 text-accent-fg active:bg-accent-active ${FOCUS}`}
          >
            <ScanLine className="h-9 w-9 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block text-lg font-bold">SKENIRAJ DEO</span>
              <span className="block text-sm text-accent-fg/85">
                nalepnica → stanje → polica
              </span>
            </span>
            <ChevronRight className="h-6 w-6 shrink-0 text-accent-fg/70" aria-hidden />
          </Link>

          <div className="grid grid-cols-2 gap-3">
            <Tile
              href="/mob/lokacije/pretraga"
              icon={Search}
              label="Gde je deo?"
              hint="po broju crteža"
            />
            {/* Ručni unos NEMA svoju rutu — to je dugme NA ekranu `/mob/lokacije`
                (lokalno stanje, bez deep-linka). Vodimo na taj ekran i u hint-u
                kažemo da tamo ide i sken i kucanje; nova ruta se ne izmišlja. */}
            <Tile
              href="/mob/lokacije"
              icon={Keyboard}
              label="Ručni unos"
              hint="skeniraj ili ukucaj"
            />
            <Tile
              href="/mob/lokacije/batch"
              icon={Layers}
              label="Batch"
              hint="jedna polica, više delova"
            />
            <Tile
              href="/mob/lokacije/istorija"
              icon={History}
              label="Istorija"
              hint="moja premeštanja"
            />
          </div>
        </>
      )}

      {hrefs.has('/mob/reversi') && (
        <Link href="/mob/reversi" className={ROW}>
          <Repeat className="h-7 w-7 shrink-0 text-accent" aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-ink">
              REVERSI — moja zaduženja
            </span>
            <span className="block text-xs text-ink-secondary">
              zaduženi alat, LZO, rezni, potrošeno
            </span>
          </span>
          <ChevronRight className="h-5 w-5 shrink-0 text-ink-disabled" aria-hidden />
        </Link>
      )}

      {/* Neposlato — red postoji SAMO kad ima čega. Vodi na `/mob/lokacije`, gde
          je dugme za ručno slanje (ovde bi drugo mesto za flush zbunjivalo). */}
      {canLokacije && pending > 0 && (
        <Link
          href="/mob/lokacije"
          className={`flex min-h-14 items-center gap-3 rounded-panel border border-status-warn/40 bg-status-warn-bg p-4 active:opacity-90 ${FOCUS}`}
        >
          <Hourglass className="h-6 w-6 shrink-0 text-status-warn" aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-status-warn">
              {pending} {pending === 1 ? 'sken čeka' : 'skena čeka'} slanje
            </span>
            <span className="block text-xs text-ink-secondary">
              šalju se sami čim se veza vrati — ili tapni da pošalješ odmah
            </span>
          </span>
          <ChevronRight className="h-5 w-5 shrink-0 text-status-warn" aria-hidden />
        </Link>
      )}

      <Link href="/mob/vise" className={ROW}>
        <MoreHorizontal className="h-7 w-7 shrink-0 text-accent" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-ink">Svi moduli</span>
          <span className="block text-xs text-ink-secondary">
            odsustva, sati, profil, sastanci…
          </span>
        </span>
        <ChevronRight className="h-5 w-5 shrink-0 text-ink-disabled" aria-hidden />
      </Link>
    </div>
  );
}

/** Pločica prečice (2 u redu) — meta ≥44px, ikona + naziv + kratak hint. */
function Tile({
  href,
  icon: Icon,
  label,
  hint,
}: {
  href: string;
  icon: LucideIcon;
  label: string;
  hint: string;
}) {
  return (
    <Link
      href={href}
      className={`flex min-h-24 flex-col gap-1.5 rounded-panel border border-line bg-surface p-4 active:bg-surface-2 ${FOCUS}`}
    >
      <Icon className="h-7 w-7 shrink-0 text-accent" aria-hidden />
      <span className="text-sm font-semibold text-ink">{label}</span>
      <span className="text-xs text-ink-secondary">{hint}</span>
    </Link>
  );
}
