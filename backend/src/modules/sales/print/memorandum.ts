import type { Column, Content } from "pdfmake/interfaces";
import { SERVOTEH_LOGO_DATA_URL } from "../../documents/servoteh-logo";
import {
  PARTNER_STRIP_ASPECT,
  PARTNER_STRIP_DATA_URL,
  TUV_ISO_LOGO_ASPECT,
  TUV_ISO_LOGO_DATA_URL,
} from "./assets/memorandum-assets";

/**
 * Memorandum izlazne fakture — zaglavlje i podnožje STRANE, zajednički za sva četiri
 * šablona (IFR/IFGP · IFUSL · IZVRO/IZVGP · IZVUS).
 * Izvor: STAMPA_IZLAZNIH_FAKTURA.md §1, korak 1 iz STAMPA_FAKTURA_GAP.md §4.
 *
 * ZAŠTO ZASEBAN FAJL: memorandum je jedini deo papira koji je na svih pet obrazaca
 * identičan, a menja se retko i iz sasvim drugog razloga (rebrending, nov partner,
 * nova adresa) nego sadržaj fakture. Držati ga u `invoice-pdf.service.ts` značilo bi
 * da svaka od četiri šablonske grane ima svoju kopiju — i da se razidu.
 *
 * ZAŠTO OBIČNE FUNKCIJE A NE NEST SERVIS: ovde nema ni baze ni konfiguracije — samo
 * podaci koje pozivalac već ima. Tako je i testabilno bez Nest konteksta. Jedina
 * spoljna stvar, QR kod, ulazi kao gotov SVG (v. `MemorandumFooterOptions.qrSvg`),
 * pa `BarcodeService` ostaje briga pozivaoca.
 *
 * ⚠️ `www.BigBit.rs` iz podnožja ino usluge se NE prepisuje — to je vodeni žig tuđeg
 * programa, ne deo Servotehovog memoranduma.
 */

/**
 * Podaci firme izdavaoca koje memorandum ume da odštampa. Sva polja su neobavezna:
 * kad kolona u `companies` nije popunjena, taj se segment jednostavno izostavi umesto
 * da se odštampa prazna labela. Vrednosti se NE prepisuju u kod — memorandum mora da
 * prati bazu, inače bi promena adrese tražila deploy.
 */
export interface MemorandumIssuer {
  companyName: string;
  address?: string | null;
  city?: string | null;
  phone?: string | null;
  fax?: string | null;
  email?: string | null;
  webAddress?: string | null;
  /** PIB. */
  taxId?: string | null;
  /** Matični broj. */
  registrationNumber?: string | null;
  /** Registarski broj (APR). */
  registryNumber?: string | null;
  /** Šifra delatnosti. */
  businessActivityCode?: string | null;
  /** Rečenica o upisu u APR — cela, kako stoji u `companies.apr_text`. */
  aprText?: string | null;
}

export interface MemorandumFooterOptions {
  /**
   * QR kod kao SVG string (`BarcodeService.qrcodeSvg`). Kad se ne prosledi, blok
   * „google mapa" se izostavlja — podnožje ostaje ispravno, samo bez koda.
   */
  qrSvg?: string | null;
  /** „Strana 1 od 3" — ino usluga ga traži dole desno; ostali obrasci ga ne prikazuju. */
  pageText?: string | null;
}

/**
 * Ciljni URL QR koda („google mapa") iz podnožja donetih faktura.
 *
 * NIJE pogođen: dekodovan je iz same slike QR koda u `InoFaktura GP 228-25.pdf`
 * (verzija 2, nivo ispravke M, maska 2). Dekoder je pre toga proveren tako što je
 * pročitao tri kontrolna koda koje je napravio `bwip-js` — sva tri tačno.
 *
 * Time je odgovoren i deo pitanja STAMPA_FAKTURA_GAP.md §5 t.13 („ciljni URL QR koda"):
 * link jeste ovaj, ostaje samo da vlasnik potvrdi da i dalje pokazuje na pravo mesto —
 * `goo.gl` skraćivač Google je ugasio, pa stari linkovi umeju da prestanu da rade.
 */
export const MEMORANDUM_MAP_QR_URL = "https://goo.gl/w9bnHq";

/** Natpis iznad QR koda, doslovno sa obrasca (malim slovima, bez navodnika). */
const MAP_QR_CAPTION = "google mapa";

/** Spaja delove reda i preskače prazne, da nigde ne ostane visoki separator. */
function join(parts: (string | null | undefined)[], sep: string): string {
  return parts
    .map((p) => p?.trim())
    .filter((p): p is string => !!p)
    .join(sep);
}

/** Skida završni „;" iz baze da se ne udvoji sa onim koji obrazac sam piše. */
function trimSemicolon(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/;+$/, "");
}

/**
 * Zaglavlje strane: logo SERVOTEH levo, TÜV Rheinland / ISO 9001:2008 znak desno,
 * puna linija, pa dva centrirana reda sa podacima firme.
 *
 * Tekst redova je prepisan sa papira — uključujući `web::` sa DVE dvotačke. To nije
 * previd nego original; ispravka je otvoreno pitanje za vlasnika
 * (STAMPA_FAKTURA_GAP.md §5 t.9), a do odluke se papir prati doslovno.
 *
 * @param issuer podaci firme (iz `companies`)
 * @param contentWidth širina sadržaja strane u pt (A4 minus margine) — za liniju
 */
export function memorandumHeader(
  issuer: MemorandumIssuer,
  contentWidth = 531,
): Content {
  const logoWidth = 132;
  const tuvHeight = 30;
  const tuvWidth = Math.round(tuvHeight * TUV_ISO_LOGO_ASPECT);

  // Red 1: naziv · adresa, mesto · tel · fax — separator su dva razmaka, kao na papiru.
  const phone = trimSemicolon(issuer.phone);
  const fax = trimSemicolon(issuer.fax);
  const line1 = join(
    [
      issuer.companyName,
      join([issuer.address, issuer.city], ", "),
      phone ? `tel: ${phone};` : "",
      fax ? `fax: ${fax};` : "",
    ],
    "  ",
  );
  // Red 2: e-mail i web. `web::` je doslovno sa obrasca (v. gore).
  const line2 = join(
    [
      issuer.email ? `e-mail: ${issuer.email}` : "",
      issuer.webAddress ? `web:: ${issuer.webAddress}` : "",
    ],
    "   ",
  );

  return {
    stack: [
      {
        columns: [
          { image: SERVOTEH_LOGO_DATA_URL, width: logoWidth },
          { width: "*", text: "" },
          {
            image: TUV_ISO_LOGO_DATA_URL,
            width: tuvWidth,
            height: tuvHeight,
          },
        ],
        columnGap: 8,
      },
      {
        canvas: [
          {
            type: "line",
            x1: 0,
            y1: 0,
            x2: contentWidth,
            y2: 0,
            lineWidth: 1,
            lineColor: "#000000",
          },
        ],
        margin: [0, 4, 0, 0],
      },
      { text: line1, style: "memoLine", margin: [0, 3, 0, 0] },
      { text: line2, style: "memoLine" },
    ],
  };
}

/**
 * Podnožje strane: traka partnerskih logotipa, registarski red, APR rečenica, a desno
 * „google mapa" sa QR kodom.
 *
 * Partnerska traka je JEDNA slika sa svih šest logotipa (tako je i u originalu) — nije
 * šest zasebnih asseta, pa se ne može ni prelomiti ni razići po redosledu.
 *
 * @param issuer podaci firme (iz `companies`)
 * @param opts QR kod i, po potrebi, „Strana X od Y"
 * @param contentWidth širina sadržaja strane u pt (A4 minus margine)
 */
export function memorandumFooter(
  issuer: MemorandumIssuer,
  opts: MemorandumFooterOptions = {},
  contentWidth = 531,
): Content {
  const qrSide = 34;
  // Traka ide preko cele širine sadržaja; visina je posledica odnosa strana slike.
  const stripHeight =
    Math.round((contentWidth / PARTNER_STRIP_ASPECT) * 10) / 10;

  const registryLine = join(
    [
      issuer.registrationNumber
        ? `Matični broj: ${issuer.registrationNumber}`
        : "",
      issuer.registryNumber ? `Registarski broj: ${issuer.registryNumber}` : "",
      issuer.businessActivityCode
        ? `Šifra delatnosti: ${issuer.businessActivityCode}`
        : "",
      issuer.taxId ? `PIB: ${issuer.taxId}` : "",
    ],
    "   ",
  );

  const textStack: Content[] = [];
  if (registryLine)
    textStack.push({ text: registryLine, style: "memoFootLine" });
  if (issuer.aprText?.trim())
    textStack.push({ text: issuer.aprText.trim(), style: "memoFootLine" });

  // QR blok desno; bez `qrSvg` se cela kolona izostavlja (podnožje i dalje ispravno).
  const qrColumn: Column[] = opts.qrSvg
    ? [
        {
          width: qrSide + 6,
          stack: [
            {
              text: MAP_QR_CAPTION,
              style: "memoFootLine",
              alignment: "center",
            },
            {
              svg: opts.qrSvg,
              width: qrSide,
              height: qrSide,
              alignment: "center",
            },
          ],
        },
      ]
    : [];

  const stack: Content[] = [
    {
      image: PARTNER_STRIP_DATA_URL,
      width: contentWidth,
      height: stripHeight,
      margin: [0, 0, 0, 3],
    },
    {
      columns: [{ width: "*", stack: textStack }, ...qrColumn],
      columnGap: 8,
    },
  ];

  // „Strana X od Y" ide ISPOD memoranduma i desno (ino usluga, 060/26).
  if (opts.pageText?.trim())
    stack.push({
      text: opts.pageText.trim(),
      style: "memoFootLine",
      alignment: "right",
      margin: [0, 2, 0, 0],
    });

  return { stack };
}

/**
 * Stilovi koje memorandum koristi — spajaju se u `styles` definicije dokumenta.
 * Drže se uz funkcije da šablon ne mora da pogađa veličine slova.
 */
export const MEMORANDUM_STYLES = {
  memoLine: { fontSize: 7, alignment: "center" as const, color: "#000000" },
  memoFootLine: { fontSize: 6, color: "#000000" },
};
