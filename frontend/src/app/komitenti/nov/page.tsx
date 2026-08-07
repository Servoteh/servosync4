'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { listHref } from '@/lib/use-id-param';
import { MaticniEkran } from '@/app/artikli/_forma/polja';
import { BRANA_KOMITENT } from '@/app/artikli/_forma/pravila';
import {
  NEPOKRIVENO_KOMITENT,
  SEKCIJE_KOMITENT,
  prazanKomitent,
} from '../_forma/komitent-polja';

/**
 * NOV KOMITENT — pun ekran (dijalog nije mesto unosa).
 *
 * ⚠️ STATIČKA ruta `/komitenti/nov`, bez `[id]` segmenta (static export).
 *
 * Upis je ZATVOREN po ODLUCI VLASNIKA od 26.07.2026: `customers` i `projects` su
 * read-only za celu aplikaciju, jedini pisac je sync. Backend to i sprovodi —
 * `POST /api/v1/directory/customers` vraća 409 `BIGBIT_OWNED_READ_ONLY`. Ekran zato
 * ne sme ni da pokuša upis; prikazuje istu poruku i uputstvo (unesi u BigBit → traži
 * od administratora da pokrene uvoz), a „Proba unosa“ služi samo da se tok kucanja i
 * provera PIB-a mogu isprobati pre nego što odluka eventualno padne.
 */
export default function NovKomitentPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const [vrednosti, setVrednosti] = useState<Record<string, string>>(() => prazanKomitent());

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
      naslov="Nov komitent"
      brana={BRANA_KOMITENT}
      rezim="unos"
      sekcije={SEKCIJE_KOMITENT}
      nepokriveno={NEPOKRIVENO_KOMITENT}
      vrednosti={vrednosti}
      onPromena={setVrednosti}
      // „Odustani" vraća listu TAČNO kakva je bila — `listHref` čita zapamćenu pretragu i
      // stranu, pa se ne gubi mesto sa kog je korisnik pritisnuo Alt+N (isto kao
      // `/artikli/nov`). Iz Podešavanja se ovde ne dolazi — „Nov komitent" postoji samo
      // na listi komitenata.
      onIzlaz={() => router.push(listHref('/komitenti'))}
    />
  );
}
