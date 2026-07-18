'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { KioskScanner } from './_components/kiosk-scanner';

/**
 * Barkod kiosk — prijava rada u pogonu (touch panel, full-screen).
 * NAMERNO bez AppShell sidebar-a: ovo je poseban obrazac ekrana (kiosk),
 * odvojen od tri standardna (Lista / Master–detalj / Forma). Radnik skenira
 * NALOG pa OPERACIJU barkod i evidentira/zatvara operaciju. Rute u
 * backend/src/modules/tech-processes (decode/scan/:id/finish).
 *
 * Redirekt na /login ako nije ulogovan (isto kao ostale stranice).
 * Static export: statička ruta /kiosk, bez [id] segmenata.
 */
export default function KioskPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  if (isLoading || !user) {
    return (
      <main className="grid flex-1 place-items-center text-xl text-ink-secondary">
        Učitavanje…
      </main>
    );
  }

  return <KioskScanner />;
}
