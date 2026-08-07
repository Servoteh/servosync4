'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * `/customers` — UGAŠEN EKRAN, ostala je samo preusmera na `/komitenti`.
 *
 * ODLUKA VLASNIKA 07.08.2026: u sidebaru su stajala DVA menija imena „Komitenti" —
 * ovaj (stariji, suženi pregled iz 2.0: 6 kolona + razvučen red) i `/komitenti`
 * (pun matični karton, 57 BigBit polja). Iz imena se nije videlo koja je koja, pa je
 * stari ugašen. Sve što je ovaj ekran prikazivao postoji na `/komitenti` — matični
 * broj, telefon i e-pošta su tamo na kartici komitenta umesto u koloni liste.
 *
 * ZAŠTO RUTA I DALJE POSTOJI. Frontend je static export: obrisan folder znači 404, a
 * `/customers` je bio u meniju mesecima — ljudi ga imaju u obeleživačima pregledača i
 * u starim mejlovima. Zato ovde stoji `router.replace` (bez upisa u istoriju: „nazad"
 * vodi odakle je korisnik došao, ne nazad na preusmeru).
 *
 * KADA SE BRIŠE: kad se potvrdi da niko više ne dolazi na ovu adresu (server log /
 * analitika). Tek tada ukloniti `app/customers/`.
 */
export default function CustomersRedirectPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/komitenti');
  }, [router]);

  return (
    <main className="grid flex-1 place-items-center p-6 text-center text-sm text-ink-secondary">
      <p>
        Preusmeravanje…
        <br />
        <span className="text-ink-disabled">
          Komitenti su se preselili na{' '}
          <a className="underline" href="/komitenti">
            /komitenti
          </a>
          .
        </span>
      </p>
    </main>
  );
}
