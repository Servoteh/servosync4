'use client';

// Mobilna „Prijava neusaglašenosti" (/mob/neusaglasenosti) — direktan ulaz sa `/mob` huba
// (pod-red grupe Montaža). Tanak omotač oko istog dijaloga koji koristi /mob/montaza
// (in-context prečica tamo ostaje); po zatvaranju/prijavi nazad na hub.
// Vidljivost = montaza.neusaglasenosti.write (ogledalo gate-a pod-reda na hubu).
// Static export: čista statička ruta, bez `[id]` i bez `useSearchParams`.

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { PrijavaNeusaglasenostiDialog } from '../../montaza/_components/prijava-neusaglasenosti-dialog';
import { MobPermissionsError } from '../_components/mob-refresh';

/** Vidljiv fokus na svakoj kontroli (DS §11) — nikad `outline:none` bez zamene. */
const FOCUS = 'focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]';

export default function MobileNeusaglasenostiPage() {
  const { user, isLoading, can, permissionsPending, permissionsError } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!isLoading && !user) router.replace('/mob/prijava');
  }, [user, isLoading, router]);

  // Čekaj i dozvole: can() je fail-closed dok permsQuery ne stigne, pa bi ovlašćen
  // monter na svež login video lažno „Nemate pravo".
  if (isLoading || !user || permissionsPending) {
    return (
      <main className="grid min-h-dvh place-items-center bg-app text-sm text-ink-secondary">
        Učitavanje…
      </main>
    );
  }

  // Pad učitavanja dozvola (retry:false — ostaje za sesiju) ≠ stvarna zabrana.
  if (permissionsError) {
    return <MobPermissionsError />;
  }

  if (!can(PERMISSIONS.MONTAZA_NEUSAGLASENOSTI_WRITE)) {
    return (
      <main className="grid min-h-dvh place-items-center bg-app p-6">
        <div className="grid justify-items-center gap-3 text-center">
          <p className="text-sm text-ink-secondary">
            Nemate pravo prijave neusaglašenosti — javite se administratoru (potrebno
            `montaza.neusaglasenosti.write`).
          </p>
          <Link
            href="/mob"
            className={`inline-flex h-11 items-center rounded-control border border-line bg-surface px-4 text-sm font-semibold text-ink active:bg-surface-2 ${FOCUS}`}
          >
            Nazad na početnu
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-dvh bg-app p-3">
      <PrijavaNeusaglasenostiDialog onClose={() => router.push('/mob')} />
    </main>
  );
}
