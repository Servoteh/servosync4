import {
  Injectable,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";

/**
 * Proxy ka sy15 storage-api (Reversi obrazac — `reversi.service.uploadSignaturePdf`).
 * 2.0 backend nosi `SY15_SERVICE_KEY` (service role) i radi upload/sign/delete u ime
 * korisnika — PRAVO se proverava PRE poziva kroz `Sy15Service.withUserRls` nad meta-redom
 * (bucket RLS politike se zaobilaze service ključem, pa proveru radimo mi, paritet).
 *
 * Boot-safe: bez `SY15_STORAGE_URL`/`SY15_SERVICE_KEY` → 503 (aplikacija se diže normalno).
 * Putanje/format IDENTIČNI 1.0 (paralelni rad; NE menjati — doktrina §C).
 */
@Injectable()
export class Sy15StorageService {
  private cfg() {
    const base = process.env.SY15_STORAGE_URL?.replace(/\/$/, "");
    const key = process.env.SY15_SERVICE_KEY;
    if (!base || !key) {
      throw new ServiceUnavailableException(
        "sy15 storage nije konfigurisan (SY15_STORAGE_URL / SY15_SERVICE_KEY)",
      );
    }
    return { base, key };
  }

  /** Upload bajtova u bucket na tačnu putanju (upsert opciono). */
  async upload(
    bucket: string,
    path: string,
    bytes: Uint8Array,
    contentType: string,
    upsert = true,
  ): Promise<void> {
    const { base, key } = this.cfg();
    const res = await fetch(
      `${base}/object/${bucket}/${this.encodePath(path)}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": contentType,
          "x-upsert": String(upsert),
        },
        // Uint8Array<ArrayBufferLike> nije BodyInit u DOM lib tipovima; kopija u
        // Uint8Array<ArrayBuffer> (isti obrazac kao Reversi uploadSignaturePdf).
        body: new Uint8Array(bytes),
      },
    );
    if (!res.ok) {
      throw new UnprocessableEntityException(
        `Upload nije uspeo (storage ${res.status}: ${(await res.text()).slice(0, 200)})`,
      );
    }
  }

  /** Presigned GET URL (pun URL kroz gateway). */
  async signUrl(
    bucket: string,
    path: string,
    expiresIn = 3600,
  ): Promise<{ url: string; expiresIn: number }> {
    const { base, key } = this.cfg();
    const res = await fetch(
      `${base}/object/sign/${bucket}/${this.encodePath(path)}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ expiresIn }),
      },
    );
    if (!res.ok) {
      throw new UnprocessableEntityException(
        `Potpisivanje URL-a nije uspelo (storage ${res.status})`,
      );
    }
    const body = (await res.json()) as { signedURL?: string };
    if (!body.signedURL) {
      throw new UnprocessableEntityException(
        "storage-api nije vratio signedURL",
      );
    }
    // signedURL je oblika `/object/sign/...` ili `/<bucket>/...`; složimo pun URL.
    const rel = body.signedURL.startsWith("/")
      ? body.signedURL
      : `/${body.signedURL}`;
    return { url: `${base}${rel}`, expiresIn };
  }

  /**
   * Preuzmi bajtove objekta (service-key GET; pravo se proverava PRE poziva nad
   * meta-redom, kao upload/sign). Vraća sirove bajtove — koristi ih npr. STT retry
   * (F3): dohvati audio iz bucket-a, pošalji transcribe. Baca 422 na storage grešku.
   */
  async download(bucket: string, path: string): Promise<Uint8Array> {
    const { base, key } = this.cfg();
    const res = await fetch(
      `${base}/object/${bucket}/${this.encodePath(path)}`,
      {
        method: "GET",
        headers: { authorization: `Bearer ${key}` },
      },
    );
    if (!res.ok) {
      throw new UnprocessableEntityException(
        `Preuzimanje nije uspelo (storage ${res.status})`,
      );
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  /** Best-effort brisanje objekta (meta-red je izvor istine; fajl je propratni). */
  async remove(bucket: string, path: string): Promise<void> {
    const { base, key } = this.cfg();
    await fetch(`${base}/object/${bucket}/${this.encodePath(path)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${key}` },
    }).catch(() => {
      /* best-effort — meta-red se svakako briše */
    });
  }

  /** Enkodiraj svaki segment putanje, zadrži `/` razdelnike. */
  private encodePath(path: string): string {
    return path
      .split("/")
      .map((s) => encodeURIComponent(s))
      .join("/");
  }
}
