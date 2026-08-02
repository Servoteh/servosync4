'use client';

/**
 * Isporuka generisanog fajla (PDF) korisniku — JEDAN put za ceo frontend.
 *
 * Do 02.08.2026. je postojao samo `URL.createObjectURL` + `<a download>` + `click()`
 * (+ `window.open` za „otvori/štampaj"). Na RAČUNARU to radi i ljudi su navikli, pa se
 * tamo ništa ne menja. Na telefonu, otkad je `/mob` instalabilna PWA (`display:
 * standalone`, scope `/mob` — v. frontend/CLAUDE.md §11), oba puta pucaju:
 *
 *  • **iOS Safari** — `<a download>` nad `blob:` URL-om je nepouzdan (ume da OTVORI PDF
 *    umesto da ga sačuva, ili da ne uradi ništa), a u standalone režimu nema adresne
 *    trake ni tabova pa `window.open` nema gde da otvori: korisnik dobije prazan ekran
 *    ili ga izbaci u Safari — a Safari od 16.4 ima ODVOJEN storage od instalirane app,
 *    pa se tamo pojavljuje ekran prijave.
 *  • **Android Chrome (WebAPK)** — `<a download>` radi, ali instalirana app nema traku
 *    preuzimanja, pa radnik ne vidi da se išta desilo i tapne dugme još jednom.
 *
 * Zato na DODIRNIM uređajima prvo idemo na **Web Share API sa fajlom**: sistemski list
 * nudi „Sačuvaj u Fajlove / Pošalji", radi i u standalone PWA (i na iOS-u i na
 * Androidu), i korisnik VIDI šta se desilo. Sve ostalo — miš (`pointer: fine`),
 * pregledač bez `canShare({ files })`, ili deljenje koje sistem odbije — pada na stari
 * `<a download>`. Uslov je `pointer: coarse`, NIKAD prelomna tačka po širini
 * (DESIGN_SYSTEM §11.3: Android telefon u pejzažu ima 800 CSS px).
 *
 * ⚠️ `navigator.share` traži svežu korisničku akciju (transient activation, ~5 s). PDF
 * se generiše posle tapa (prvo generisanje povlači i dva TTF fonta), pa na sporoj mreži
 * aktivacija ume da istekne → `NotAllowedError`. To NIJE greška korisniku: hvatamo je i
 * tiho padamo na preuzimanje, a poruka („preuzet") kaže istinu o tome šta se desilo.
 */

/** Šta se STVARNO desilo sa fajlom — poziv na osnovu ovoga bira poruku korisniku. */
export type DeliveryOutcome = 'shared' | 'downloaded' | 'cancelled';

/**
 * Koliko `blob:` URL ostaje živ. Staro `downloadBlob` ga je opozivalo posle 1 s — ako
 * pregledač lenjo otvori prikazivač (iOS ume da PDF pročita tek kad korisnik izabere
 * aplikaciju), URL je već mrtav i fajl je prazan. 60 s + opoziv na napuštanju strane.
 */
const REVOKE_AFTER_MS = 60_000;

function revokeLater(url: string): void {
  if (typeof window === 'undefined') return;
  let done = false;
  const revoke = () => {
    if (done) return;
    done = true;
    window.removeEventListener('pagehide', revoke);
    URL.revokeObjectURL(url);
  };
  window.addEventListener('pagehide', revoke);
  window.setTimeout(revoke, REVOKE_AFTER_MS);
}

/** Preuzmi Blob kao fajl (bez servera) — put za miš/desktop i rezerva na telefonu. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  revokeLater(url);
}

/** Otvori Blob u novom tabu (štampa PDF-a na računaru). Ne koristiti pod `/mob`. */
export function openBlob(blob: Blob): void {
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank');
  revokeLater(url);
}

/** Primarni pokazivač je prst (telefon/tablet) — ne prelomna tačka po širini (DS §11.3). */
function isCoarsePointer(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(pointer: coarse)').matches;
}

/** Uzak tip — `canShare` još nije u svim verzijama lib.dom, a ni u svim pregledačima. */
type ShareNavigator = Navigator & {
  share?: (data: ShareData) => Promise<void>;
  canShare?: (data?: ShareData) => boolean;
};

/**
 * Isporuči PDF korisniku najpouzdanijim putem za njegov uređaj.
 *
 * Vraća šta se desilo, da bi pozivalac mogao da kaže istinu u `toast`-u
 * (v. `deliveryMessage`). Nikad ne baca zbog same isporuke — greška u deljenju je
 * uvek pad na preuzimanje.
 */
export async function deliverPdf(blob: Blob, fileName: string): Promise<DeliveryOutcome> {
  const nav = typeof navigator === 'undefined' ? null : (navigator as ShareNavigator);
  if (nav && isCoarsePointer() && typeof File === 'function') {
    let file: File | null = null;
    try {
      file = new File([blob], fileName, { type: blob.type || 'application/pdf' });
    } catch {
      file = null; // stariji WebView bez File konstruktora
    }
    const data: ShareData = { files: file ? [file] : [], title: fileName };
    if (file && typeof nav.share === 'function' && nav.canShare?.(data) === true) {
      try {
        await nav.share(data);
        return 'shared';
      } catch (e) {
        // Korisnik zatvorio sistemski list = svesna odluka, ne greška → ne preuzimaj
        // mu fajl iza leđa. Sve ostalo (istekla aktivacija, sistem odbio) → rezerva.
        if (e instanceof DOMException && e.name === 'AbortError') return 'cancelled';
      }
    }
  }
  downloadBlob(blob, fileName);
  return 'downloaded';
}

/**
 * Poruka korisniku posle isporuke — jedan rečnik za sve ekrane, da „gde mi je fajl"
 * svuda glasi isto. `label` je naziv dokumenta u NOMINATIVU („Karnet", „Rešenje o
 * godišnjem odmoru"); rečenica je građena tako da rod ne mora da se slaže.
 */
export function deliveryMessage(outcome: DeliveryOutcome, label: string): string {
  switch (outcome) {
    case 'shared':
      return `${label} — prosleđeno aplikaciji koju si izabrao (npr. „Fajlovi").`;
    case 'cancelled':
      return `${label} — deljenje otkazano, fajl nije sačuvan.`;
    default:
      return `${label} — preuzeto. Fajl je u „Preuzimanja / Downloads".`;
  }
}
