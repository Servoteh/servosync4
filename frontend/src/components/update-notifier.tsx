'use client';

import { useEffect, useRef, useState } from 'react';
import { UpdateBanner } from '@/components/ui-kit/update-banner';

/**
 * Detekcija zastarelog klijenta. Build zapeče NEXT_PUBLIC_BUILD_ID u bundle i istu
 * vrednost u /version.json (vidi next.config.ts). Ovde periodično čitamo version.json
 * sa SOPSTVENOG origina (radi i za Cloudflare i za LAN :3000) i, kad se deployovana
 * verzija razlikuje od učitane, prikažemo UpdateBanner sa uputstvom za refresh.
 * Nema service worker-a ni push-a: LAN je http (nije secure context), a baner pokriva
 * jedini slučaj koji postoji — otvoren tab na staroj verziji.
 */

const LOADED_VERSION = process.env.NEXT_PUBLIC_BUILD_ID;
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // redovna provera u pozadini
const MIN_GAP_MS = 60 * 1000; // throttle za focus/visibility okidače
const SNOOZE_MS = 30 * 60 * 1000; // "Kasnije" — baner se vraća posle pauze

export function UpdateNotifier() {
  const [deployed, setDeployed] = useState<{ version: string; builtAt?: string } | null>(null);
  const [snoozedUntil, setSnoozedUntil] = useState(0);
  const lastCheckRef = useRef(0);

  useEffect(() => {
    if (!LOADED_VERSION) return;
    let cancelled = false;

    const check = async (force = false) => {
      const now = Date.now();
      if (!force && now - lastCheckRef.current < MIN_GAP_MS) return;
      lastCheckRef.current = now;
      try {
        // Query parametar obilazi browser keš i kad server ne pošalje no-store.
        const res = await fetch(`/version.json?_=${now}`, { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as { version?: string; builtAt?: string };
        if (!cancelled && data.version && data.version !== LOADED_VERSION) {
          setDeployed({ version: data.version, builtAt: data.builtAt });
        }
      } catch {
        /* offline/mrežni prekid — sledeća provera će uspeti */
      }
    };

    const intervalId = setInterval(() => void check(), CHECK_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check();
    };
    // Posle deploy-a stari lazy chunk-ovi više ne postoje na serveru — navigacija
    // pukne (ChunkLoadError / failed dynamic import). Tada odmah proveri verziju.
    const onRejection = (e: PromiseRejectionEvent) => {
      const reason = e.reason as { name?: string; message?: string } | undefined;
      const text = `${reason?.name ?? ''} ${reason?.message ?? String(e.reason ?? '')}`;
      if (/ChunkLoadError|Loading chunk|dynamically imported module/i.test(text)) {
        void check(true);
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);

  // Svaka naredna provera dok smo zastareli pravi nov state objekat → re-render,
  // pa isteklo "Kasnije" automatski vraća baner bez posebnog tajmera.
  if (!deployed || Date.now() < snoozedUntil) return null;

  return (
    <UpdateBanner
      builtAt={deployed.builtAt}
      onReload={() => window.location.reload()}
      onLater={() => setSnoozedUntil(Date.now() + SNOOZE_MS)}
    />
  );
}
