'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronRight } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { MobShell } from '../_components/mob-shell';
import { visibleMobModules, type MobLink } from '../_components/mob-modules';
import { MobPermissionsError } from '../_components/mob-refresh';

/**
 * Mobilno „Više" (/mob/vise) — PLAN_MOB_IZGLED_1.0_PARITET, F1 (paritet 1.0 taba
 * „Više" iz `src/ui/mobile/mobileAppShell.js` → `viseHtml()`).
 *
 * Svi moduli u jednoj koloni, jedan po redu: ikona · naziv · kratak opis · chevron.
 * Izvor je ISTI kao za hub kartice (`_components/mob-modules.ts`) — lista se ne
 * duplira. Stavke bez prava se NE prikazuju (1.0 ih prikazuje sa 🔒; 3.0 hub ih
 * krije, pa „Više" prati 3.0 pravilo da dva ekrana ne bi govorila različito).
 *
 * Static export: čista statička ruta, bez `[id]` i bez `useSearchParams`.
 */

/** Vidljiv fokus na svakoj kontroli (DS §11) — nikad `outline:none` bez zamene. */
const FOCUS = 'focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]';

export default function MobVisePage() {
  const { user, isLoading, can, permissionsPending, permissionsError } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  // Isti gate kao hub: can() je fail-closed dok dozvole ne stignu → bez čekanja bi
  // ovlašćen korisnik na svež login video praznu listu.
  if (isLoading || !user || permissionsPending) {
    return (
      <main className="grid min-h-dvh place-items-center bg-app text-sm text-ink-secondary">
        Učitavanje…
      </main>
    );
  }
  if (permissionsError) {
    return <MobPermissionsError />;
  }

  const visible = visibleMobModules(can);

  return (
    <MobShell title="Više" subtitle="Svi moduli" active="vise">
      {visible.length === 0 ? (
        <EmptyState
          title="Nema dostupnih modula"
          hint="Vaša uloga nema pristup nijednom mobilnom ekranu — javite se administratoru."
        />
      ) : (
        <ul className="space-y-2">
          {visible.map((m) => {
            const subs = m.children ?? [];

            // Grupa: glavni ulaz je NASLOV grupe (akcentna ikona, polu-bold), a
            // pod-ulazi su uvučeni redovi u istom panelu — isti jezik kao na hub-u.
            if (subs.length > 0) {
              return (
                <li key={m.href} className="rounded-panel border border-line bg-surface">
                  <ModuleRow item={m} variant="group" />
                  {subs.map((s, i) => (
                    <ModuleRow
                      key={s.href}
                      item={s}
                      variant="child"
                      last={i === subs.length - 1}
                    />
                  ))}
                </li>
              );
            }

            return (
              <li key={m.href} className="rounded-panel border border-line bg-surface">
                <ModuleRow item={m} variant="single" />
              </li>
            );
          })}
        </ul>
      )}

      {/* Identitet aplikacije — mesto gde ljudi traže „koja je ovo verzija".
          Bez build hash-a (to je tehnički podatak iz version.json, za UpdateNotifier). */}
      <p className="mt-4 text-center text-xs text-ink-disabled">ServoSync 3.0 · Servoteh</p>
    </MobShell>
  );
}

/** Red liste: ikona · naziv · kratak opis · chevron (touch meta ≥44px, DS §11). */
function ModuleRow({
  item,
  variant,
  last,
}: {
  item: MobLink;
  variant: 'single' | 'group' | 'child';
  last?: boolean;
}) {
  const Icon = item.icon;
  const isChild = variant === 'child';

  // Uglovi se zaokružuju po redu (a ne `overflow-hidden` na panelu) — fokus prsten
  // je spoljna senka i bio bi odsečen.
  const corners =
    variant === 'single'
      ? 'rounded-panel'
      : variant === 'group'
        ? 'rounded-t-panel'
        : last
          ? 'rounded-b-panel'
          : '';

  return (
    <Link
      href={item.href}
      className={`flex items-center gap-3 active:bg-surface-2 ${corners} ${FOCUS} ${
        isChild ? 'min-h-11 border-t border-line py-2.5 pl-6 pr-4' : 'min-h-14 p-4'
      }`}
    >
      <Icon
        className={
          isChild ? 'h-5 w-5 shrink-0 text-ink-secondary' : 'h-7 w-7 shrink-0 text-accent'
        }
        aria-hidden
      />
      <span className="min-w-0 flex-1">
        <span className={`block text-sm text-ink ${isChild ? 'font-medium' : 'font-semibold'}`}>
          {item.label}
        </span>
        <span className="block text-xs text-ink-secondary">{item.hint}</span>
      </span>
      <ChevronRight
        className={`shrink-0 text-ink-disabled ${isChild ? 'h-4 w-4' : 'h-5 w-5'}`}
        aria-hidden
      />
    </Link>
  );
}
