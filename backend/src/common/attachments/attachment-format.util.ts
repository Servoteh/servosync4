import {
  BadRequestException,
  PayloadTooLargeException,
  UnprocessableEntityException,
} from "@nestjs/common";

/**
 * Prilozi — JEDNO MESTO ISTINE za prijem fajlova (formati, prepoznavanje, poruke).
 * =========================================================================
 * Do 08.2026. je svaki modul imao svoju kopiju ove logike i one se NISU slagale:
 * `montaza-neusaglasenosti` i `kvalitet` su presuđivali po magic bytes (PDF/PNG/JPG),
 * `odrzavanje.attachIncidentFiles` nije validirao ništa (sirov HEIC je odlazio u
 * bucket), a `zahtevi` i `plan-proizvodnje` su IZRIČITO primali `image/heic` — koji
 * nijedan ekran ne ume da prikaže (svuda `<img>`: PhotoTile, galerija skica,
 * vozilo-karton). Posledica: fotografija sa montaže je ili padala celu otpremu ili
 * se tiho upisivala kao večno nevidljiv dokaz.
 *
 * Pravila koja ovaj modul sprovodi:
 *   1. **Presuđuje SADRŽAJ, ne `mimetype` iz zahteva** — klijent ga laže (Android/Files
 *      ume da pošalje prazan tip, a `.heic` zna da stigne etiketiran kao `image/jpeg`).
 *   2. **Prima se samo ono što sistem ume da PRIKAŽE**: JPG, PNG, PDF. HEIC/HEIF se
 *      odbija svuda dosledno (ne postoji ekran koji bi ga otvorio), uz poruku koja
 *      kaže ŠTA da se uradi — ne samo da nije uspelo.
 *   3. **Validacija cele serije ide PRE ijednog upisa/upload-a** (`assertAttachments`)
 *      — dokaz se ne sme izgubiti tako što pola serije prođe pa transakcija pukne.
 *
 * Klijentska strana istog ugovora je `frontend/src/lib/image-resize.ts` (`sniffFormat`
 * + `imageRejectionMessage`) — formati i tekstovi poruka se drže usklađeni.
 */

/** Format priloga prepoznat iz MAGIC BYTES (`mimetype` iz zahteva se ignoriše). */
export type SniffedAttachmentFormat =
  | "jpeg"
  | "png"
  | "pdf"
  | "webp"
  | "gif"
  | "heic"
  | "avif"
  | "empty"
  | "unknown";

/** Formati koje sistem ume da prikaže → jedini koji se primaju. */
export const ACCEPTED_ATTACHMENT_FORMATS = ["jpeg", "png", "pdf"] as const;
export type AcceptedAttachmentFormat =
  (typeof ACCEPTED_ATTACHMENT_FORMATS)[number];

/** Samo slike (konteksti u kojima PDF nema smisla — npr. glavna fotografija vozila). */
export const IMAGE_ATTACHMENT_FORMATS = ["jpeg", "png"] as const;

/** Kanonski `content_type` za prihvaćen format (upisuje se u bazu, ne klijentov mimetype). */
export const ATTACHMENT_CONTENT_TYPE: Record<AcceptedAttachmentFormat, string> =
  {
    jpeg: "image/jpeg",
    png: "image/png",
    pdf: "application/pdf",
  };

/** Kratka labela za poruke („JPG", „PNG", „PDF"). */
const FORMAT_LABEL: Record<AcceptedAttachmentFormat, string> = {
  jpeg: "JPG",
  png: "PNG",
  pdf: "PDF",
};

/** ISO-BMFF `ftyp` brendovi HEIF porodice (iPhone kamera, Android „high efficiency"). */
const HEIF_BRANDS = new Set([
  "heic",
  "heix",
  "heim",
  "heis",
  "hevc",
  "hevx",
  "hevm",
  "hevs",
  "mif1",
  "msf1",
]);
const AVIF_BRANDS = new Set(["avif", "avis"]);

/**
 * Minimalni oblik multipart fajla. `@types/multer` namerno NE postoji u repou, pa
 * svaki modul ima svoj lokalni interfejs (`UploadedPhotoFile`, `UploadedMultipartFile`,
 * `Express.Multer.File`) — svi zadovoljavaju OVAJ oblik, pa helper radi sa svima.
 */
export interface AttachmentFileLike {
  originalname?: string;
  mimetype?: string;
  size?: number;
  buffer: Buffer | Uint8Array;
}

/** ASCII isečak (bez `Buffer.toString` — radi i nad `Uint8Array`). */
function ascii(bytes: Uint8Array, from: number, len: number): string {
  let s = "";
  for (let i = from; i < from + len && i < bytes.length; i++)
    s += String.fromCharCode(bytes[i]);
  return s;
}

/**
 * Format iz prvih 32 bajta. Isti redosled provera kao u frontend `sniffFormat`
 * (`frontend/src/lib/image-resize.ts`) — dve strane moraju da vide isti format da
 * bi poruke o grešci bile iste.
 */
export function sniffAttachmentFormat(
  buffer: Buffer | Uint8Array | null | undefined,
): SniffedAttachmentFormat {
  if (!buffer || buffer.length === 0) return "empty";
  const head = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);

  if (
    head.length >= 3 &&
    head[0] === 0xff &&
    head[1] === 0xd8 &&
    head[2] === 0xff
  )
    return "jpeg";
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
    return "png";
  if (head.length >= 5 && ascii(head, 0, 5) === "%PDF-") return "pdf";
  if (head.length >= 6 && ascii(head, 0, 4) === "GIF8") return "gif";
  if (
    head.length >= 12 &&
    ascii(head, 0, 4) === "RIFF" &&
    ascii(head, 8, 4) === "WEBP"
  )
    return "webp";
  // ISO-BMFF: [4B veličina]['ftyp'][4B glavni brend][4B verzija][kompatibilni brendovi…]
  if (head.length >= 12 && ascii(head, 4, 4) === "ftyp") {
    const major = ascii(head, 8, 4).toLowerCase();
    if (HEIF_BRANDS.has(major)) return "heic";
    if (AVIF_BRANDS.has(major)) return "avif";
    for (let i = 16; i + 4 <= head.length; i += 4) {
      const brand = ascii(head, i, 4).toLowerCase();
      if (HEIF_BRANDS.has(brand)) return "heic";
      if (AVIF_BRANDS.has(brand)) return "avif";
    }
  }
  return "unknown";
}

/**
 * Kanonski `content_type` ako je sadržaj među dozvoljenim formatima, inače `null`.
 * Zamenjuje ranije kopije `detectPhotoContentType` / `detectDocContentType`.
 */
export function detectAttachmentContentType(
  buffer: Buffer | Uint8Array | null | undefined,
  allow: readonly AcceptedAttachmentFormat[] = ACCEPTED_ATTACHMENT_FORMATS,
): string | null {
  const format = sniffAttachmentFormat(buffer);
  return (allow as readonly SniffedAttachmentFormat[]).includes(format)
    ? ATTACHMENT_CONTENT_TYPE[format as AcceptedAttachmentFormat]
    : null;
}

/** „12,3 MB" / „512 KB" — za poruke o veličini. */
function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
}

/** „JPG, PNG i PDF" / „JPG i PNG" — nabrajanje dozvoljenog u poruci. */
function allowedLabel(allow: readonly AcceptedAttachmentFormat[]): string {
  const labels = allow.map((f) => FORMAT_LABEL[f]);
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} i ${labels[labels.length - 1]}`;
}

/** Ime fajla za poruku (multer ume da preda prazno). */
function displayName(file: AttachmentFileLike): string {
  return file.originalname?.trim() || "fajl";
}

/**
 * Poruka odbijanja — UVEK kaže šta korisnik dalje da uradi (greška bez sledećeg
 * koraka je ćorsokak). Tekstovi su usklađeni sa `imageRejectionMessage` na frontu.
 */
export function attachmentRejectionMessage(
  fileName: string,
  format: SniffedAttachmentFormat,
  allow: readonly AcceptedAttachmentFormat[] = ACCEPTED_ATTACHMENT_FORMATS,
): string {
  const name = fileName.trim() || "fajl";
  const dozvoljeno = allowedLabel(allow);
  if (format === "empty")
    return `„${name}": fajl je prazan (0 bajtova) — verovatno nije do kraja učitan. Priložite ga ponovo.`;
  if (format === "heic")
    return (
      `„${name}": fotografija je u HEIC formatu — aplikacija ne ume da ga prikaže, pa se ne prima. ` +
      'Slikajte dugmetom „Slikaj / kamera" u aplikaciji, ili na iPhone-u uključite ' +
      'Podešavanja → Kamera → Formati → „Najkompatibilnije" (JPEG) pa pošaljite ponovo.'
    );
  if (format === "avif" || format === "gif" || format === "webp")
    return `„${name}": format ${format.toUpperCase()} nije podržan za priloge. Sačuvajte sliku kao JPG ili PNG pa je priložite ponovo.`;
  if (format === "pdf")
    // Prepoznat PDF u kontekstu koji prima samo slike (npr. fotografija vozila).
    return `„${name}": ovde se prilaže fotografija, a fajl je PDF. Dozvoljeno: ${dozvoljeno}.`;
  if (format === "jpeg" || format === "png")
    return `„${name}": format ${FORMAT_LABEL[format]} nije dozvoljen ovde. Dozvoljeno: ${dozvoljeno}.`;
  return (
    `„${name}": sadržaj fajla ne odgovara nijednom dozvoljenom formatu (${dozvoljeno}). ` +
    'Priložite sliku kao JPG ili PNG, a dokument kao PDF — najsigurnije je slikati dugmetom „Slikaj / kamera".'
  );
}

/** Opcije prijema (dozvoljeni formati + kapa po fajlu). */
export interface AttachmentCheckOptions {
  /** Dozvoljeni formati; default JPG/PNG/PDF. */
  allow?: readonly AcceptedAttachmentFormat[];
  /** Gornja granica po fajlu u bajtovima; preko → 413. */
  maxBytes?: number;
  /**
   * Rečenica koja se dodaje na kraj poruke — modulu služi da kaže gde je posao
   * ostao (npr. „Prijava je sačuvana; fotografije dodajte iz njene kartice.").
   * Bez toga radnik ne zna da li da ponavlja ceo unos ili samo prilog.
   */
  hint?: string;
}

/** Rezultat provere jednog fajla — kanonski `content_type` iz SADRŽAJA. */
export interface CheckedAttachment<T extends AttachmentFileLike> {
  file: T;
  /** Ime za prikaz/upis (sirovo `originalname`; dekodiranje mojibake je na modulu). */
  fileName: string;
  /** `image/jpeg` | `image/png` | `application/pdf` — presuđeno po magic bytes. */
  contentType: string;
  format: AcceptedAttachmentFormat;
}

type Problem = { message: string; kind: "empty" | "too_large" | "format" };

function checkOne(
  file: AttachmentFileLike,
  allow: readonly AcceptedAttachmentFormat[],
  maxBytes: number | undefined,
): Problem | AcceptedAttachmentFormat {
  const name = displayName(file);
  const size = file.buffer?.length ?? 0;
  if (size === 0)
    return {
      kind: "empty",
      message: attachmentRejectionMessage(name, "empty", allow),
    };
  if (maxBytes !== undefined && size > maxBytes)
    return {
      kind: "too_large",
      message:
        `„${name}": fajl je ${humanSize(size)}, a najviše je dozvoljeno ${humanSize(maxBytes)}. ` +
        'Smanjite sliku (ili je slikajte dugmetom „Slikaj / kamera" u aplikaciji) pa je priložite ponovo.',
    };
  const format = sniffAttachmentFormat(file.buffer);
  if (!(allow as readonly SniffedAttachmentFormat[]).includes(format))
    return {
      kind: "format",
      message: attachmentRejectionMessage(name, format, allow),
    };
  return format as AcceptedAttachmentFormat;
}

/** Dopiši uputstvo modula („gde je posao ostao") na kraj poruke. */
function withHint(message: string, hint?: string): string {
  const h = hint?.trim();
  return h ? `${message} ${h}` : message;
}

/** Problem → tipizirana Nest greška (400 prazan / 413 prevelik / 422 format). */
function toException(kind: Problem["kind"], message: string): Error {
  if (kind === "empty") return new BadRequestException(message);
  if (kind === "too_large") return new PayloadTooLargeException(message);
  return new UnprocessableEntityException(message);
}

/**
 * Provera JEDNOG fajla — vraća kanonski `content_type` ili baca (400/413/422).
 * Poruka uvek imenuje fajl i kaže šta dalje.
 */
export function assertAttachment<T extends AttachmentFileLike>(
  file: T,
  options: AttachmentCheckOptions = {},
): CheckedAttachment<T> {
  const allow = options.allow ?? ACCEPTED_ATTACHMENT_FORMATS;
  const res = checkOne(file, allow, options.maxBytes);
  if (typeof res !== "string")
    throw toException(res.kind, withHint(res.message, options.hint));
  return {
    file,
    fileName: displayName(file),
    contentType: ATTACHMENT_CONTENT_TYPE[res],
    format: res,
  };
}

/**
 * PDF-only prijem (zapisnik sastanka, potpisnica reversa, crtež RN-a, izveštaj
 * montaže). Presuđuje `%PDF-` zaglavlje — ranije su ta mesta gledala
 * `file.mimetype !== "application/pdf"`, a taj podatak dolazi od klijenta.
 */
export function assertPdfAttachment(
  file?: AttachmentFileLike | null,
  options: Omit<AttachmentCheckOptions, "allow"> = {},
): asserts file is AttachmentFileLike {
  if (!file?.buffer?.length)
    throw new UnprocessableEntityException(
      withHint("Očekivan PDF fajl (multipart polje `file`).", options.hint),
    );
  assertAttachment(file, { ...options, allow: ["pdf"] });
}

/**
 * Provera CELE serije PRE ijednog upisa/upload-a (fail fast, atomski prijem).
 * Prolazi kroz sve fajlove i skuplja SVE probleme — radnik ih ispravi u jednom
 * prolazu umesto da posle svakog pokušaja otkrije sledeći. HTTP status nosi prvi
 * problem po redosledu fajlova (400 prazan / 413 prevelik / 422 format).
 *
 * ⚠️ Poziva se PRE `prisma.$transaction` / `storage.upload` — inače se dobija
 * upravo ono što se popravlja: pola serije upisano, pa greška, pa dokaz nestao.
 */
export function assertAttachments<T extends AttachmentFileLike>(
  files: readonly T[],
  options: AttachmentCheckOptions = {},
): CheckedAttachment<T>[] {
  const allow = options.allow ?? ACCEPTED_ATTACHMENT_FORMATS;
  const ok: CheckedAttachment<T>[] = [];
  const problems: Problem[] = [];
  for (const file of files) {
    const res = checkOne(file, allow, options.maxBytes);
    if (typeof res === "string")
      ok.push({
        file,
        fileName: displayName(file),
        contentType: ATTACHMENT_CONTENT_TYPE[res],
        format: res,
      });
    else problems.push(res);
  }
  if (problems.length) {
    const detail = problems.map((p) => p.message).join(" ");
    const message =
      problems.length === 1 && files.length === 1
        ? detail
        : `Nije prihvaćeno ${problems.length} od ${files.length} priloga — ništa nije sačuvano. ${detail}`;
    throw toException(problems[0].kind, withHint(message, options.hint));
  }
  return ok;
}
