import {
  BadRequestException,
  PayloadTooLargeException,
  UnprocessableEntityException,
} from "@nestjs/common";
import {
  assertAttachment,
  assertAttachments,
  attachmentRejectionMessage,
  detectAttachmentContentType,
  IMAGE_ATTACHMENT_FORMATS,
  sniffAttachmentFormat,
  type AttachmentFileLike,
} from "./attachment-format.util";

/**
 * Prijem priloga — jedno mesto istine (`attachment-format.util`).
 * Fokus: presuđuje SADRŽAJ (magic bytes), HEIC se odbija svuda, lažiran `mimetype`
 * ne pomaže, prazan fajl puca, i cela serija pada PRE ijednog upisa.
 */

const jpegBytes = (extra = 0) =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(extra)]);
const pngBytes = () =>
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const pdfBytes = () => Buffer.from("%PDF-1.7\n%âãÏÓ", "latin1");

/** ISO-BMFF zaglavlje: [4B veličina]['ftyp'][glavni brend][verzija][kompatibilni…]. */
const isoBmff = (major: string, compatible: string[] = []) =>
  Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from("ftyp", "latin1"),
    Buffer.from(major, "latin1"),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
    Buffer.from(compatible.join(""), "latin1"),
  ]);

const heicBytes = () => isoBmff("heic", ["mif1", "heic"]);
const webpBytes = () =>
  Buffer.concat([
    Buffer.from("RIFF", "latin1"),
    Buffer.from([0x1a, 0x00, 0x00, 0x00]),
    Buffer.from("WEBPVP8 ", "latin1"),
  ]);

const file = (over: Partial<AttachmentFileLike> = {}): AttachmentFileLike => ({
  originalname: "slika.jpg",
  mimetype: "image/jpeg",
  buffer: jpegBytes(),
  ...over,
});

describe("sniffAttachmentFormat", () => {
  it("prepoznaje JPEG / PNG / PDF po magic bytes", () => {
    expect(sniffAttachmentFormat(jpegBytes())).toBe("jpeg");
    expect(sniffAttachmentFormat(pngBytes())).toBe("png");
    expect(sniffAttachmentFormat(pdfBytes())).toBe("pdf");
  });

  it("prepoznaje HEIC — i po glavnom brendu i po listi kompatibilnih", () => {
    expect(sniffAttachmentFormat(heicBytes())).toBe("heic");
    // iPhone ume da upiše `mif1` kao glavni brend, a `heic` tek među kompatibilnima.
    expect(sniffAttachmentFormat(isoBmff("mp42", ["isom", "heic"]))).toBe(
      "heic",
    );
  });

  it("prepoznaje AVIF, GIF i WEBP (prepoznati, ali neprihvatljivi formati)", () => {
    expect(sniffAttachmentFormat(isoBmff("avif"))).toBe("avif");
    expect(sniffAttachmentFormat(Buffer.from("GIF89a", "latin1"))).toBe("gif");
    expect(sniffAttachmentFormat(webpBytes())).toBe("webp");
  });

  it("prazan/nedostajući buffer → `empty`, smeće → `unknown`", () => {
    expect(sniffAttachmentFormat(Buffer.alloc(0))).toBe("empty");
    expect(sniffAttachmentFormat(null)).toBe("empty");
    expect(sniffAttachmentFormat(undefined)).toBe("empty");
    expect(sniffAttachmentFormat(Buffer.from([0x00, 0x01, 0x02, 0x03]))).toBe(
      "unknown",
    );
  });

  it("radi i nad `Uint8Array` (ne samo `Buffer`)", () => {
    expect(sniffAttachmentFormat(new Uint8Array(jpegBytes()))).toBe("jpeg");
  });

  it("ne pravi lažan pogodak na kratkom bufferu (prefiks JPEG-a bez trećeg bajta)", () => {
    expect(sniffAttachmentFormat(Buffer.from([0xff, 0xd8]))).toBe("unknown");
  });
});

describe("detectAttachmentContentType", () => {
  it("vraća KANONSKI content_type, ne klijentov mimetype", () => {
    expect(detectAttachmentContentType(pngBytes())).toBe("image/png");
    expect(detectAttachmentContentType(pdfBytes())).toBe("application/pdf");
    expect(detectAttachmentContentType(jpegBytes())).toBe("image/jpeg");
  });

  it("HEIC → null (nijedan ekran ne ume da ga prikaže)", () => {
    expect(detectAttachmentContentType(heicBytes())).toBeNull();
  });

  it("PDF nije prihvaćen kad kontekst traži samo sliku", () => {
    expect(
      detectAttachmentContentType(pdfBytes(), IMAGE_ATTACHMENT_FORMATS),
    ).toBeNull();
    expect(
      detectAttachmentContentType(jpegBytes(), IMAGE_ATTACHMENT_FORMATS),
    ).toBe("image/jpeg");
  });
});

describe("assertAttachment (jedan fajl)", () => {
  it("validan JPEG → kanonski content_type", () => {
    const res = assertAttachment(file());
    expect(res.contentType).toBe("image/jpeg");
    expect(res.format).toBe("jpeg");
  });

  it("HEIC → 422 sa uputstvom šta da se uradi, ne samo da nije uspelo", () => {
    let msg = "";
    try {
      assertAttachment(
        file({ originalname: "IMG_4021.HEIC", buffer: heicBytes() }),
      );
    } catch (e) {
      expect(e).toBeInstanceOf(UnprocessableEntityException);
      msg = (e as Error).message;
    }
    expect(msg).toContain("IMG_4021.HEIC");
    expect(msg).toContain("HEIC");
    expect(msg).toMatch(/Najkompatibilnije|Slikaj \/ kamera/);
  });

  it("🔴 lažiran mimetype ne pomaže — presuđuje sadržaj", () => {
    // HEIC etiketiran kao `image/jpeg` (čest slučaj sa Android/Files birača).
    expect(() =>
      assertAttachment(
        file({
          originalname: "foto.jpg",
          mimetype: "image/jpeg",
          buffer: heicBytes(),
        }),
      ),
    ).toThrow(UnprocessableEntityException);
    // …i obrnuto: ispravan PNG etiketiran kao `application/octet-stream` PROLAZI.
    expect(
      assertAttachment(
        file({ mimetype: "application/octet-stream", buffer: pngBytes() }),
      ).contentType,
    ).toBe("image/png");
  });

  it("prazan fajl → 400 (ne 422) i poruka imenuje fajl", () => {
    let msg = "";
    try {
      assertAttachment(
        file({ originalname: "prazna.jpg", buffer: Buffer.alloc(0) }),
      );
    } catch (e) {
      expect(e).toBeInstanceOf(BadRequestException);
      msg = (e as Error).message;
    }
    expect(msg).toContain("prazna.jpg");
    expect(msg).toContain("prazan");
  });

  it("preko `maxBytes` → 413 sa veličinama u poruci", () => {
    let msg = "";
    try {
      assertAttachment(file({ buffer: jpegBytes(2 * 1024 * 1024) }), {
        maxBytes: 1024 * 1024,
      });
    } catch (e) {
      expect(e).toBeInstanceOf(PayloadTooLargeException);
      msg = (e as Error).message;
    }
    expect(msg).toContain("MB");
  });

  it("smeće (nije nijedan poznat format) → 422", () => {
    expect(() =>
      assertAttachment(
        file({ originalname: "x.txt", buffer: Buffer.from("zdravo") }),
      ),
    ).toThrow(UnprocessableEntityException);
  });

  it("PDF prolazi po difoltu, a pada kad kontekst prima samo slike", () => {
    expect(assertAttachment(file({ buffer: pdfBytes() })).contentType).toBe(
      "application/pdf",
    );
    expect(() =>
      assertAttachment(
        file({ originalname: "nalog.pdf", buffer: pdfBytes() }),
        {
          allow: IMAGE_ATTACHMENT_FORMATS,
        },
      ),
    ).toThrow(UnprocessableEntityException);
  });
});

describe("assertAttachments (cela serija — atomski prijem)", () => {
  it("sve validno → redosled i content_type-ovi se čuvaju", () => {
    const res = assertAttachments([
      file({ originalname: "a.jpg" }),
      file({ originalname: "b.png", buffer: pngBytes() }),
      file({ originalname: "c.pdf", buffer: pdfBytes() }),
    ]);
    expect(res.map((r) => r.contentType)).toEqual([
      "image/jpeg",
      "image/png",
      "application/pdf",
    ]);
    expect(res.map((r) => r.fileName)).toEqual(["a.jpg", "b.png", "c.pdf"]);
  });

  it("🔴 jedan loš u seriji obara CELU seriju, i poruka kaže da ništa nije sačuvano", () => {
    let msg = "";
    try {
      assertAttachments([
        file({ originalname: "dobra.jpg" }),
        file({ originalname: "sa-telefona.heic", buffer: heicBytes() }),
      ]);
    } catch (e) {
      expect(e).toBeInstanceOf(UnprocessableEntityException);
      msg = (e as Error).message;
    }
    expect(msg).toContain("sa-telefona.heic");
    expect(msg).toContain("ništa nije sačuvano");
    // Ispravna fotografija se NE imenuje kao problem.
    expect(msg).not.toContain("dobra.jpg");
  });

  it("imenuje SVE problematične fajlove (jedan prolaz ispravki, ne pokušaj-po-pokušaj)", () => {
    let msg = "";
    try {
      assertAttachments([
        file({ originalname: "a.heic", buffer: heicBytes() }),
        file({ originalname: "b.webp", buffer: webpBytes() }),
        file({ originalname: "c.jpg" }),
      ]);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("a.heic");
    expect(msg).toContain("b.webp");
    expect(msg).toContain("2 od 3");
  });

  it("HTTP status nosi PRVI problem po redosledu fajlova (413 pre 422)", () => {
    expect(() =>
      assertAttachments(
        [
          file({
            originalname: "velika.jpg",
            buffer: jpegBytes(2 * 1024 * 1024),
          }),
          file({ originalname: "lose.heic", buffer: heicBytes() }),
        ],
        { maxBytes: 1024 * 1024 },
      ),
    ).toThrow(PayloadTooLargeException);
  });

  it("prazna lista → prazan rezultat (pozivalac odlučuje da li je to greška)", () => {
    expect(assertAttachments([])).toEqual([]);
  });
});

describe("attachmentRejectionMessage", () => {
  it("svaka poruka nosi ime fajla i sledeći korak", () => {
    for (const fmt of [
      "heic",
      "avif",
      "gif",
      "webp",
      "unknown",
      "empty",
    ] as const) {
      const msg = attachmentRejectionMessage("dokaz.bin", fmt);
      expect(msg).toContain("dokaz.bin");
      expect(msg).toMatch(/ponovo|Priložite|Dozvoljeno/);
    }
  });

  it("nabraja dozvoljeno po kontekstu (JPG i PNG kad PDF nije dozvoljen)", () => {
    expect(
      attachmentRejectionMessage("x.bin", "unknown", IMAGE_ATTACHMENT_FORMATS),
    ).toContain("JPG i PNG");
    expect(attachmentRejectionMessage("x.bin", "unknown")).toContain(
      "JPG, PNG i PDF",
    );
  });
});
