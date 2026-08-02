// Klijentska priprema slika za otpremanje (paritet 1.0 prepareImageForUpload):
// najduža stranica ≤ 1568px, bela pozadina, JPEG q0.82. GIF prolazi bez obrade
// (animacija). Koristi ga `ui-kit/attachment-input` (prilozi) i `ai-chat` (vision).
//
// 🔴 HEIC (podrazumevani format iPhone kamere, i „High efficiency" na Androidu):
// dekodiranje u pregledaču radi SAMO u Safariju/WebKit-u. Chrome, Firefox i Android
// WebView vraćaju grešku pri dekodiranju, pa se slika NE MOŽE pretvoriti u JPEG.
// Ranije se u tom slučaju tiho slao original — a backend prilog presuđuje po MAGIC
// BYTES i prima samo JPG/PNG/PDF (`montaza-neusaglasenosti.service.ts:104-122`,
// `kvalitet.service.ts`), pri čemu je upis fotografija all-or-nothing: jedan HEIC
// obori CELU otpremu. Fotografija neusaglašenosti sa montaže bi se tako izgubila
// bez ijedne poruke. Zato: pretvaranje koje padne NIKAD ne prosleđuje original u
// formatu koji sistem ne ume da prikaže — pozivalac dobija poruku šta da uradi.
//
// Bez nove zavisnosti: `heic2any`/libheif nose ~1.5 MB wasm-a, a /mob se otvara na
// telefonu na slaboj mreži — cena je veća od dobiti. Prevencija je u `accept` listi
// (bez `image/heic`) i u putanji „Slikaj / kamera" koja na telefonu daje JPEG.

const MAX_DIM = 1568;
const JPEG_QUALITY = 0.82;

/** Format priloga prepoznat iz MAGIC BYTES (`file.type` ume da bude prazan/lažan). */
export type SniffedFormat =
  | 'jpeg'
  | 'png'
  | 'webp'
  | 'gif'
  | 'heic'
  | 'avif'
  | 'pdf'
  | 'unknown';

/** ISO-BMFF `ftyp` brendovi HEIF porodice (iPhone/Android „high efficiency"). */
const HEIF_BRANDS = new Set([
  'heic',
  'heix',
  'heim',
  'heis',
  'hevc',
  'hevx',
  'hevm',
  'hevs',
  'mif1',
  'msf1',
]);
const AVIF_BRANDS = new Set(['avif', 'avis']);

/** MIME koji odgovara prepoznatom formatu (za dopunu praznog `file.type`). */
export const MIME_BY_FORMAT: Partial<Record<SniffedFormat, string>> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  heic: 'image/heic',
  avif: 'image/avif',
  pdf: 'application/pdf',
};

function ascii(bytes: Uint8Array, from: number, len: number): string {
  let s = '';
  for (let i = from; i < from + len && i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/**
 * Format iz prvih 32 bajta. Android/Files ume da pošalje fajl sa PRAZNIM `file.type`,
 * a `.heic` sa `image/jpeg` etiketom nije redak — zato se odlučuje po sadržaju.
 */
export async function sniffFormat(file: Blob): Promise<SniffedFormat> {
  let head: Uint8Array;
  try {
    head = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  } catch {
    return 'unknown';
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  if (
    head.length >= 8 &&
    head[0] === 0x89 &&
    head[1] === 0x50 &&
    head[2] === 0x4e &&
    head[3] === 0x47 &&
    head[4] === 0x0d &&
    head[5] === 0x0a &&
    head[6] === 0x1a &&
    head[7] === 0x0a
  )
    return 'png';
  if (head.length >= 5 && ascii(head, 0, 5) === '%PDF-') return 'pdf';
  if (head.length >= 6 && ascii(head, 0, 6).startsWith('GIF8')) return 'gif';
  if (head.length >= 12 && ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'WEBP')
    return 'webp';
  // ISO-BMFF: [4B veličina]['ftyp'][4B major brand][4B verzija][kompatibilni brendovi…]
  if (head.length >= 12 && ascii(head, 4, 4) === 'ftyp') {
    const major = ascii(head, 8, 4).toLowerCase();
    if (HEIF_BRANDS.has(major)) return 'heic';
    if (AVIF_BRANDS.has(major)) return 'avif';
    for (let i = 16; i + 4 <= head.length; i += 4) {
      const brand = ascii(head, i, 4).toLowerCase();
      if (HEIF_BRANDS.has(brand)) return 'heic';
      if (AVIF_BRANDS.has(brand)) return 'avif';
    }
  }
  return 'unknown';
}

/** Dekodirana slika + čišćenje (objectURL / ImageBitmap). */
interface Decoded {
  source: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
}

/**
 * Dekodiranje uz POŠTOVANJE EXIF rotacije — bez toga se portretne fotografije sa
 * telefona posle canvasa okrenu naopačke (telefon rotaciju nosi samo u EXIF-u, a
 * `drawImage` crta sirove piksele).
 *   • `<img>`: `image-orientation: from-image` postavljamo IZRIČITO (u Chrome-u < 81
 *     podrazumevano je bilo `none`, pa je canvas gubio rotaciju);
 *   • rezerva `createImageBitmap(..., { imageOrientation: 'from-image' })` — bez te
 *     opcije bitmap EXIF IGNORIŠE, pa se opcija nikad ne sme izostaviti.
 */
async function decodeOriented(file: Blob): Promise<Decoded> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const im = new Image();
      im.style.imageOrientation = 'from-image';
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('Slika nije učitana.'));
      im.src = url;
    });
    return {
      source: img,
      width: img.naturalWidth || img.width,
      height: img.naturalHeight || img.height,
      release: () => URL.revokeObjectURL(url),
    };
  } catch (e) {
    URL.revokeObjectURL(url);
    if (typeof createImageBitmap !== 'function') throw e;
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    return {
      source: bmp,
      width: bmp.width,
      height: bmp.height,
      release: () => bmp.close?.(),
    };
  }
}

/**
 * Smanji sliku na ≤1568px i vrati JPEG blob. Baca kad format nije dekodabilan u
 * ovom pregledaču (HEIC van Safarija) — pozivalac MORA da obradi grešku, jer je
 * original tada neupotrebljiv za sistem (v. `prepareImageForUpload`).
 */
export async function resizeImageFile(file: File | Blob): Promise<Blob> {
  if (file.type === 'image/gif') return file;
  const dec = await decodeOriented(file);
  try {
    let { width, height } = dec;
    if (!width || !height) throw new Error('Slika nema dimenzije.');
    if (width > MAX_DIM || height > MAX_DIM) {
      const scale = MAX_DIM / Math.max(width, height);
      width = Math.round(width * scale);
      height = Math.round(height * scale);
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(dec.source, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/jpeg', JPEG_QUALITY),
    );
    return blob ?? file;
  } finally {
    dec.release();
  }
}

/**
 * Poruka korisniku kad slika ne može da se pripremi — uvek kaže ŠTA DA URADI,
 * ne samo da nije uspelo (DESIGN_SYSTEM: greška bez sledećeg koraka nije greška
 * nego ćorsokak).
 */
export async function imageRejectionMessage(file: File): Promise<string> {
  const name = file.name || 'slika';
  const format = await sniffFormat(file);
  if (format === 'heic')
    return (
      `„${name}": fotografija je u HEIC formatu — ovaj pregledač ne ume da je pretvori, ` +
      'a aplikacija ne ume da je prikaže. Slikajte dugmetom „Slikaj / kamera" u aplikaciji, ' +
      'ili na iPhone-u uključite Podešavanja → Kamera → Formati → „Najkompatibilnije" (JPEG) ' +
      'i pošaljite ponovo.'
    );
  if (format === 'avif' || format === 'gif' || format === 'webp')
    return `„${name}": format ${format.toUpperCase()} nije podržan za priloge. Sačuvajte sliku kao JPG ili PNG pa je priložite ponovo.`;
  return (
    `„${name}": slika nije mogla da se pročita (oštećen ili nepodržan fajl). ` +
    'Priložite je kao JPG ili PNG — najsigurnije je slikati dugmetom „Slikaj / kamera".'
  );
}

/**
 * Slika spremna za otpremanje: uvek JPEG kad pretvaranje uspe. Kad padne:
 *   • JPG/PNG original prolazi (backend i pregled priloga ih razumeju — ništa se ne gubi);
 *   • sve ostalo (HEIC/AVIF/oštećeno) BACA `Error` sa uputstvom — nikad tiho slanje
 *     fajla koji posle niko u sistemu ne može da otvori.
 */
export async function prepareImageForUpload(file: File): Promise<File> {
  let blob: Blob | null = null;
  try {
    blob = await resizeImageFile(file);
  } catch {
    blob = null;
  }
  if (blob && blob !== file && (blob.type || 'image/jpeg') === 'image/jpeg') {
    const name = file.name.replace(/\.[^.]+$/i, '') || 'slika';
    return new File([blob], `${name}.jpg`, { type: 'image/jpeg', lastModified: Date.now() });
  }
  const format = await sniffFormat(file);
  if (format === 'jpeg' || format === 'png') return file;
  throw new Error(await imageRejectionMessage(file));
}
