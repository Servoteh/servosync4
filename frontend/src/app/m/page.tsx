'use client';

import { useEffect } from 'react';

const STARA_MOBILNA = 'https://servoteh-plan-montaze.pages.dev/m';

/*
 * Kapija za instalirani mobilni APK: Capacitor ljuska učitava
 * https://servosync.servoteh.com/m, a stara 1.0 mobilna aplikacija posle
 * hard-flipa domena živi na pages.dev. Query i hash se prenose netaknuti
 * (QR `?code=` deep-linkovi, recovery tokeni u hash-u). Mora klijentski:
 * uz output:'export' server redirect() ne postoji, a searchParams prop je
 * prazan u build-time prerenderu.
 */
export default function MRedirectPage() {
  useEffect(() => {
    window.location.replace(STARA_MOBILNA + window.location.search + window.location.hash);
  }, []);

  return (
    <main
      style={{
        minHeight: '100dvh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        textAlign: 'center',
      }}
    >
      <p>
        Otvaranje stare mobilne aplikacije…{' '}
        <a href={STARA_MOBILNA}>Nastavi ručno</a>
      </p>
    </main>
  );
}
