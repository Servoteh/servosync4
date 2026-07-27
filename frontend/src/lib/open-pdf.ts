import { toast } from '@/lib/toast';

/**
 * Otvaranje odštampanog PDF-a — JEDNO mesto za celu aplikaciju.
 *
 * Zašto ne prosto `window.open`: poziv ide POSLE `await`-a na preuzimanje
 * dokumenta, dakle van sinhronog konteksta korisničkog klika, pa ga Safari i
 * Firefox tretiraju kao iskačući prozor i tiho blokiraju — korisnik klikne
 * „Štampaj", ništa se ne desi i zaključi da aplikacija ne štampa.
 *
 * Zato: prvo pokušaj novog taba; kad ga blokator odbije, dokument se PREUZIMA
 * kroz skriveni `<a download>` i korisnik dobija poruku. `fileName` je i inače
 * potreban — `Content-Disposition` sa servera se gubi kad se odgovor čita kao
 * `Blob`, pa bi se svi dokumenti čuvali pod heks-imenom `blob:…`.
 */
export function openPdf(blob: Blob, fileName?: string): void {
  const url = URL.createObjectURL(blob);
  const revoke = () => setTimeout(() => URL.revokeObjectURL(url), 30_000);

  const win = window.open(url, '_blank', 'noopener');
  if (win) {
    revoke();
    return;
  }

  // Blokator je presekao novi tab — dokument se preuzima, pa ga korisnik otvara sam.
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName ?? 'dokument.pdf';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  revoke();
  toast(
    'Iskačući prozor je blokiran — dokument je preuzet. Dozvolite iskačuće prozore za pregled u novoj kartici.',
  );
}
