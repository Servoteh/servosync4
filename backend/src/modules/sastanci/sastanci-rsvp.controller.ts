import { Controller, Get, Head, Logger, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { PrismaService } from "../../prisma/prisma.service";
import { SastanciPbSourceService } from "../../common/sy15/sastanci-pb-source.service";
import { sy15FunctionsBase } from "../../common/sy15/sy15-functions-base";

/**
 * RSVP magic-link iz pozivnice na sastanak — 3.0 parnjak sy15 edge funkcije
 * `sastanci-rsvp` (poslednja edge fn u toku sastanaka; korak 1 seobe,
 * docs/SEOBA_SASTANCI_PB_2026-08-05.md).
 *
 * ══ ZAŠTO JE RUTA JAVNA (bez JWT-a) ═══════════════════════════════════════════
 * Primalac klikće „✅ Dolazim" / „❌ Ne dolazim" direktno iz mejla, obično sa
 * telefona i bez prijave — na sastanak se poziva i neko ko NEMA nalog u 3.0
 * (`sastanak_ucesnici` ima PK po MEJLU, ne po nalogu). Magic-link JE
 * autentikacija: `rsvp_token` je uuid v4, UNIQUE po učesniku i jedina tajna.
 * U ovom repou nema globalnog `APP_GUARD` (app.module.ts registruje samo
 * APP_INTERCEPTOR-e), pa je „javno" = kontroler BEZ `@UseGuards(JwtAuthGuard)`.
 * Zato ovaj kontroler namerno stoji odvojeno od `SastanciController`, koji na
 * nivou klase nosi `@UseGuards(JwtAuthGuard, PermissionsGuard)`.
 *
 * ⚠️ `rsvp_token` JE TAJNA: ne loguje se (ni maskiran), ne vraća se u telu
 * odgovora niti u poruci greške, i ne stiže u `audit_log` (AuditInterceptor
 * upisuje samo POST/PUT/PATCH/DELETE, a ovo je GET).
 *
 * ══ PUTANJA ═══════════════════════════════════════════════════════════════════
 * `/api/v1/sastanci-rsvp?t=<token>&r=dolazim|ne_dolazim[&c=1]` — namerno crticom,
 * a ne `sastanci/rsvp`: `SastanciController` ima `@Get(":id")` sa `ParseUUIDPipe`,
 * pa bi `sastanci/rsvp` prvo pao na tu rutu i vratio 400. Uz to je oblik upita
 * IDENTIČAN sy15 edge-u (`…/functions/v1/sastanci-rsvp?t=…&r=…`), pa se stari
 * link razlikuje samo po hostu i prefiksu.
 *
 * ══ PARITET SA EDGE FUNKCIJOM (mereno 05.08.2026 sa sy15-functions kontejnera) ═
 *   1. `HEAD` → prazan 200, BEZ ijedne izmene.
 *   2. `t` prazan ILI `r` van {dolazim, ne_dolazim} → strana greške, 400.
 *   3. BEZ `c=1` → samo strana potvrde, BEZ UPISA. Ovo NIJE ukras: prvi GET iz
 *      mejla radi i svaki mašinski skener (Microsoft SafeLinks, antivirus,
 *      link-preview bot), pa bi upis na prvi GET beležio lažno „Dolazim" za
 *      ljude koji link nisu ni otvorili. Upis ide tek na klik dugmeta (`c=1`).
 *   4. `c=1` → upis `rsvp_status` + `rsvp_at`; 0 pogođenih redova → 404 sa
 *      NEUTRALNOM porukom; inače „Hvala" strana sa linkom da se predomisliš.
 *   5. Svaka greška se mirno hvata i vraća kao HTML (nikad JSON, nikad stack).
 *
 * ══ NEPOZNAT TOKEN → 404, NEUTRALNA PORUKA ════════════════════════════════════
 * Odgovor ne otkriva NIŠTA o sastanku (ni da postoji, ni naslov, ni mejl) — samo
 * „Ova potvrda više nije važeća". 404 (a ne 200) je zadržan zbog pariteta sa
 * edge-om i zato što status kod ovde ništa ne odaje: isti je za token koji nikad
 * nije postojao i za povučenu pozivnicu, a uuid v4 se ne može nabrajati.
 */

/** Dozvoljeni odgovori — isti skup kao sy15 `sastanci_set_my_rsvp`. */
type Rsvp = "dolazim" | "ne_dolazim";

function isValidRsvp(v: unknown): v is Rsvp {
  return v === "dolazim" || v === "ne_dolazim";
}

/**
 * `rsvp_token` je `uuid` kolona. Bez ove provere bi svaki nasumičan `t` oborio
 * Prisma upit (P2023 „Error creating UUID") i vratio 500 — što bi razlikovalo
 * „loš oblik" od „nepostojeći token". Ovako oba završe na istoj neutralnoj 404.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ACCENT = "#E8523A";
const GREEN = "#15803d";
const RED = "#dc2626";

/** HTML-escape — stranica je javna, sve dinamičko mora proći ovuda. */
function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Mobilno-first omotač (max-width ~480px, veliki dugmići) — prepis edge `page()`. */
function page(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="sr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)} — Servoteh</title>
<style>
  *{box-sizing:border-box;}
  body{margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,Helvetica,sans-serif;color:#111827;-webkit-text-size-adjust:100%;}
  .wrap{min-height:100vh;display:flex;align-items:flex-start;justify-content:center;padding:32px 16px;}
  .card{width:100%;max-width:480px;background:#fff;border-radius:14px;box-shadow:0 1px 3px rgba(0,0,0,.08),0 8px 24px rgba(0,0,0,.06);overflow:hidden;}
  .head{background:${ACCENT};padding:20px 24px;}
  .brand{color:#fff;font-size:18px;font-weight:700;letter-spacing:.5px;}
  .sub{color:#ffe2db;font-size:13px;margin-top:2px;}
  .body{padding:28px 24px 30px;}
  h1{margin:0 0 6px;font-size:22px;line-height:1.25;}
  p{margin:0 0 14px;font-size:15px;line-height:1.55;color:#374151;}
  .status{display:block;margin:18px 0 22px;padding:16px 18px;border-radius:10px;font-size:18px;font-weight:700;text-align:center;}
  .status.yes{background:#dcfce7;color:${GREEN};border:1px solid #bbf7d0;}
  .status.no{background:#fee2e2;color:${RED};border:1px solid #fecaca;}
  .btn{display:block;width:100%;text-align:center;text-decoration:none;padding:15px 18px;border-radius:10px;font-size:16px;font-weight:700;margin:10px 0;}
  .btn-yes{background:${GREEN};color:#fff;}
  .btn-no{background:${RED};color:#fff;}
  .muted{font-size:13px;color:#6b7280;margin-top:18px;}
  .err{font-size:42px;line-height:1;margin:0 0 8px;}
</style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="head">
        <div class="brand">SERVOTEH d.o.o.</div>
        <div class="sub">Potvrda dolaska na sastanak</div>
      </div>
      <div class="body">
        ${bodyHtml}
        <p class="muted">Ovo je automatska potvrda iz Servoteh sistema.</p>
      </div>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Link na SAMU SEBE sa drugim upitom. Namerno RELATIVAN (`?t=…`): stranicu je
 * poslužila ova ruta, pa se relativni upit razrešava na istu putanju i isti host.
 * Time RSVP strana nema NIJEDNU zavisnost od env-a za bazni URL — a to je baš
 * greška koju je edge imao (gradio je apsolutni link iz internog `SUPABASE_URL`).
 */
function selfLink(token: string, answer: Rsvp): string {
  return `?t=${encodeURIComponent(token)}&r=${answer}&c=1`;
}

export const RSVP_INVALID_HTML_MARKER = "Ova potvrda više nije važeća";

@Controller({ path: "sastanci-rsvp", version: "1" })
export class SastanciRsvpController {
  private readonly logger = new Logger(SastanciRsvpController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly izvor: SastanciPbSourceService,
  ) {}

  /**
   * HEAD MORA imati svoj handler i MORA biti deklarisan PRE `@Get()`: Express
   * ruter `router.get()` hvata i HEAD zahteve, pa bi bez ovoga skener koji radi
   * HEAD na link sa `c=1` prošao kroz celu GET granu i UPISAO RSVP.
   */
  @Head()
  head(@Res() res: Response): void {
    res.status(200);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end();
  }

  @Get()
  async rsvp(
    @Query("t") t: string | undefined,
    @Query("r") r: string | undefined,
    @Query("c") c: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    try {
      const token = (t ?? "").trim();

      // (1) Nepotpun/neispravan upit — isti tekst i status kao edge.
      // `r` sme da izostane samo u smislu „nema šta da se zabeleži": edge i tada
      // vraća 400, jer link iz pozivnice UVEK nosi `r`. Bez `r` nema ni prikaza
      // (nemamo šta da prikažemo bez otkrivanja podataka o sastanku).
      if (!token || !isValidRsvp(r)) {
        this.send(
          res,
          400,
          errorPage(
            "Link je nepotpun ili neispravan. Proveri da si otvorio/la ceo link iz pozivnice.",
          ),
        );
        return;
      }

      // (2) Vlasnik podatka je sy15 → ova ruta NE SME da piše u 3.0 bazu.
      // Upis bi otišao u bazu koja u tom režimu nije izvor istine, pa bi se dve
      // baze tiho razišle (isti razlog zbog kog `assertPorted` pada sa 503).
      // Umesto poruke o grešci radimo 302 na sy15 edge sa NEPROMENJENIM upitom:
      // korisnikov klik se i dalje zabeleži, i to u bazi koja je tada vlasnik.
      if (!this.izvor.isThreeZero) {
        const url = `${sy15FunctionsBase()}/sastanci-rsvp?t=${encodeURIComponent(
          token,
        )}&r=${r}${c === "1" ? "&c=1" : ""}`;
        // Bez logovanja URL-a — nosi token.
        res.redirect(302, url);
        return;
      }

      // (3) Prvi GET (i svaki mašinski skener mejla) → samo strana potvrde, BEZ
      // upisa. Upis tek kad korisnik klikne dugme na NAŠOJ stranici (`c=1`).
      if (c !== "1") {
        this.send(res, 200, confirmPage(r, token));
        return;
      }

      // (4) Upis. `updateMany` (a ne `update`) namerno: nepostojeći token vraća
      // count 0 umesto izuzetka — isto kao PostgREST PATCH koji vrati prazan niz.
      let count = 0;
      if (UUID_RE.test(token)) {
        const upd = await this.prisma.sastanakUcesnik.updateMany({
          where: { rsvpToken: token },
          data: { rsvpStatus: r, rsvpAt: new Date() },
        });
        count = upd.count;
      }

      if (count === 0) {
        this.send(
          res,
          404,
          errorPage(
            `${RSVP_INVALID_HTML_MARKER}. Moguće je da je pozivnica povučena.`,
          ),
        );
        return;
      }

      this.send(res, 200, thanksPage(r, token));
    } catch (e) {
      // Mirno: nikad ne curi token ni stack — ni u odgovor ni u log.
      this.logger.warn(
        `sastanci-rsvp: upis nije uspeo (${e instanceof Error ? e.name : "greška"})`,
      );
      this.send(
        res,
        500,
        errorPage(
          "Došlo je do greške pri beleženju odgovora. Pokušaj ponovo za par trenutaka.",
        ),
      );
    }
  }

  /**
   * Jedno mesto za slanje HTML-a. `no-store` je SVESNO ODSTUPANJE od edge-a
   * (poboljšanje): URL nosi tajnu, pa stranica ne sme da završi u deljenom kešu
   * ili u istoriji proxy-ja.
   */
  private send(res: Response, status: number, html: string): void {
    // Bez ulančavanja: `ServerResponse.setHeader` je tek novije počeo da vraća
    // `this`, pa lanac ume da pukne na starijem runtime-u.
    res.status(status);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.send(html);
  }
}

/** Strana greške (loš parametar / nevažeći token / interna greška). */
function errorPage(message: string): string {
  return page(
    "Greška",
    `
    <p class="err">⚠️</p>
    <h1>Nešto nije u redu</h1>
    <p>${esc(message)}</p>
    <p class="muted">Ako si dobio/la ovu poruku iz email pozivnice, otvori link ponovo
    ili se javi organizatoru sastanka.</p>`,
  );
}

/** Strana potvrde (BEZ upisa) — prvi GET iz pozivnice. */
function confirmPage(answer: Rsvp, token: string): string {
  const dolazi = answer === "dolazim";
  return page(
    "Potvrda",
    `
    <h1>Potvrda dolaska</h1>
    <p>Još jedan klik da potvrdiš svoj odgovor na sastanak:</p>
    <a class="btn ${dolazi ? "btn-yes" : "btn-no"}" href="${esc(
      selfLink(token, answer),
    )}">${dolazi ? "✅ Da, dolazim" : "❌ Da, ne dolazim"}</a>
    <p class="muted">Dodatni klik je tu da budemo sigurni da potvrdu šalješ ti, a ne automatski skener email-a.</p>`,
  );
}

/** „Hvala" strana sa potvrdom + link da se odgovor promeni (isti t, drugi r). */
function thanksPage(answer: Rsvp, token: string): string {
  const dolazi = answer === "dolazim";
  const other: Rsvp = dolazi ? "ne_dolazim" : "dolazim";
  return page(
    "Hvala",
    `
    <h1>Hvala!</h1>
    <p>Tvoj odgovor je sačuvan. Organizator vidi tvoju potvrdu u sastanku.</p>
    <span class="status ${dolazi ? "yes" : "no"}">${
      dolazi ? "✅ Zabeleženo: Dolazim" : "❌ Zabeleženo: Ne dolazim"
    }</span>
    <p>Predomislio/la si se? Možeš promeniti odgovor:</p>
    <a class="btn ${dolazi ? "btn-no" : "btn-yes"}" href="${esc(
      selfLink(token, other),
    )}">${dolazi ? "❌ Ipak ne dolazim" : "✅ Ipak dolazim"}</a>`,
  );
}
