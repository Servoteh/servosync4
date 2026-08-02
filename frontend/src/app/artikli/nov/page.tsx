'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { MaticniEkran } from '../_forma/polja';
import { BRANA_ARTIKAL } from '../_forma/pravila';
import { NEPOKRIVENO_ARTIKAL, SEKCIJE_ARTIKAL, praznArtikal } from '../_forma/artikal-polja';

/**
 * NOV ARTIKAL — pun ekran (odluka vlasnika: dijalog nije mesto unosa).
 *
 * ⚠️ STATIČKA ruta `/artikli/nov`, bez ijednog `[id]` segmenta: frontend je
 * `output: "export"`, pa dinamički segment izveze samo placeholder i na produkciji
 * vraća 404 (incident 22.07). Nov zapis nema id pa mu ruta i ne treba; izmena
 * postojećeg ide na `/artikli/detalj?id=N` (isti ekran, drugi režim).
 *
 * Upis je ZATVOREN (v. `BRANA_ARTIKAL`): `items` ide kroz full refresh sa
 * `deleteMany({})`, pa bi 4.0-native artikal nestao na prvom sledećem sync-u, a deca
 * u `price_list_entries` / `work_order_item_components` ostala kao siročad. Ekran zato
 * stoji zaključan i kaže šta da se uradi umesto toga; „Proba unosa“ otključava polja
 * radi provere toka kucanja, ali ništa ne šalje.
 */
export default function NovArtikalPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const [vrednosti, setVrednosti] = useState<Record<string, string>>(() => praznArtikal());

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  if (isLoading || !user) {
    return (
      <main className="grid flex-1 place-items-center text-sm text-ink-secondary">
        Učitavanje…
      </main>
    );
  }

  return (
    <MaticniEkran
      naslov="Nov artikal"
      brana={BRANA_ARTIKAL}
      rezim="unos"
      sekcije={SEKCIJE_ARTIKAL}
      nepokriveno={NEPOKRIVENO_ARTIKAL}
      vrednosti={vrednosti}
      onPromena={setVrednosti}
      onIzlaz={() => router.push('/artikli')}
    />
  );
}
