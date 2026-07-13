'use client';

// HMI iframe host (presuda E1/E2): kopirani HP-HMI ekran iz `public/scada-hmi/` na
// ISTOM originu (shim sinhrono čita `window.parent.__SCADA_BRIDGE__`). Ime ekrana je
// fiksno (bez hash-a) — `_headers` drži no-cache. `key={screen}` = reload na promenu
// sistema. Tema kroz `?theme=` (shim je preuzme pre ekranskih skripti).

interface HmiHostProps {
  screen: string;
  theme: 'light' | 'dark';
}

export function HmiHost({ screen, theme }: HmiHostProps) {
  return (
    <iframe
      key={screen}
      title="SCADA ekran"
      src={`/scada-hmi/${screen}?theme=${theme}`}
      referrerPolicy="no-referrer"
      className="h-full w-full border-0 bg-white"
    />
  );
}
