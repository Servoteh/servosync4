import { businessYear } from "../../common/business-date";
import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { PostingEngineService } from "../gl/posting/posting.service";
// Zaokruživanje linije, odbacivanje nula-redova i polja otvorene stavke — JEDNO mesto za
// ručnu i robnu granu knjiženja (do 05.08.2026. su bila dva primerka i razišla su se).
import {
  finalizeLedgerLines,
  ledgerDescription,
  openItemFields,
} from "../gl/posting/ledger-line";
import { GlWriteService } from "../gl/gl-write.service";
import { SefService } from "./sef/sef.service";
import { ReservationService } from "../robno/reservation.service";
import { DocumentNumberSequenceService } from "./numbering.service";
import { PricingService } from "./pricing.service";
import { documentVatTotals } from "./vat-totals";
import {
  SERVICE_DOCUMENT_TYPES,
  SERVICE_REVENUE_TYPE_SELECT,
  type ServiceRevenueTypeRef,
  taxTreatmentOf,
} from "./service-revenue-type";
import type { AuthUser } from "../auth/jwt.strategy";
import {
  type CreateProformaDto,
  validateCreateProforma,
} from "./dto/create-proforma.dto";
import { type ListInvoicesQuery } from "./dto/list-invoices.dto";
import {
  // Advisory brave se UVOZE, ne prepisuju: storno mora da uzme BAŠ one koje drži
  // `applyAdvance` (namespace 4003 = račun, 4004 = avans). Prepisana konstanta bi se
  // razišla tiho — obe sesije bi „uzimale bravu", a nikad istu.
  ADVISORY_NS_APPLY_OF_ADVANCE,
  ADVISORY_NS_APPLY_ON_INVOICE,
  computePayableAmount,
} from "./advance-invoice.service";
import {
  APPLICATION_ACTIVE,
  APPLICATION_REVERSED,
  computeAdvanceDeductions,
  computeAdvanceUsage,
  loadAdvanceLinkedInvoices,
} from "./advance-deduction";

/**
 * FakturisanjeService — izlazni računi (PLAN_FAZA_5 §A).
 *
 * Životni ciklus:
 *   createProforma  → PON/PROF (level 250, DRAFT, cene iz PricingService)
 *   from-proforma   → carry-over PROF → IFR/… (DocumentCarryOverService, van ovog servisa)
 *   postInvoice     → level-0 knjiženje: rezerviši broj (DocumentNumberSequence) +
 *                     nalog GK. Dva puta:
 *                       (a) AUTO-ROBNO (IFR/IFGP sa stockDocumentId) → PostingEngineService
 *                           po šemi 33/36 (auto-robno razduženje + prihod + PDV),
 *                       (b) RUČNI nalog (IFUSL/uslužni, ili kad nema robnog izlaza) →
 *                           JournalEntry + LedgerEntry direktno sa BALANS-kontrolom:
 *                             kupac 2040 (2050 izvoz) DUG  = O + P + Q
 *                             prihod 6040 (6140 usluga)    POT = O
 *                             PDV 4702 (20%) / 4710 (10%)  POT = P / Q
 *                           Izvoz: kupac 2050, bez PDV (kategorija Z / čl.24).
 *
 * Novac je Prisma.Decimal svuda. Poslovne greške = ugrađeni NestJS exception-i.
 */

const D = Prisma.Decimal;
const ZERO = new D(0);

/** Konta ručnog knjiženja (doc 43 / PLAN_FAZA_5 §A). */
const ACC_CUSTOMER_DOMESTIC = "2040"; // kupci u zemlji
const ACC_CUSTOMER_EXPORT = "2050"; // kupci u inostranstvu
const ACC_REVENUE_GOODS = "6040"; // prihod od prodaje robe
/**
 * REZERVNI konto prihoda od usluga — koristi se SAMO kad na uslužnom računu vrsta usluge
 * nije izabrana. Stvarni konto dolazi iz šifarnika (`ServiceRevenueType.revenueAccountCode`).
 * Izmereno nad knjigom 2026: `6140` pokriva 45 od 57 uslužnih stavki, pa je to najmanje
 * pogrešna vrednost za dokument bez izbora — ali nije pretpostavka koja se ćutke širi:
 * ekran nudi padajuću listu sa predlogom `USL`.
 */
const ACC_REVENUE_SERVICE = "6140";
const ACC_VAT_OUT_20 = "4702"; // obaveza za izlazni PDV 20% (VISA)
const ACC_VAT_OUT_10 = "4710"; // obaveza za izlazni PDV 10% (NIZA)

/**
 * KONTO IZLAZNOG PDV-a PO STOPI — po PROCENTU, ne po šifri.
 *
 * ⚠️ IZMEREN KVAR (02.08.2026): ovde je stajalo `ako je šifra "2" → 4710, INAČE → 4702`.
 * Stopa koja nije 20 % padala je u „inače", pa se knjižila na konto
 * `4702 — PDV 20 % na prodate robe`. GK bi balansirala (iznos je isti sa obe strane), ali
 * bi POPDV polje 3.2 iz tog konta izvodilo osnovicu deljenjem sa 0,2 — osnovica prometa po
 * nižoj stopi bi ušla u obrazac umanjena.
 *
 * ⚠️ ISPRAVKA OPISA (02.08.2026, drugi krug): ovde je do sada pisalo da je „šifra 4
 * POSEBNA stopa (8 %, POLJO)". TO JE NETAČNO — po stvarnim redovima `R_Tarife`
 * (`_legacy/…/rule_tables/BB_T_26/R_Tarife.csv`, v. `gl/posting/vat-rates.ts`) šifra „4"
 * je **NIZA, 10 %**, a POSEBNA/POLJO 8 % je šifra „5". Zabuna dolazi od kolone `Opis`
 * tarife 4 koja je ostala na „Roba i usluge 8%" iako numeričke kolone daju 10.
 * Posledica za ovu mapu: šifra „4" od sada pogađa `4710` (10 %) i NE pada u branu ispod;
 * na branu za 8 % se sada stiže samo šifrom „5" (POLJO), koju na produkciji ne nosi
 * nijedan artikal (izmereno: 0).
 *
 * ⚠️ KONTA ZA IZLAZNI PDV 8 % U KONTNOM PLANU NEMA (proveren
 * `20260723155000_seed_chart_of_accounts` i `prisma/seed/vat-account-map.sql`: postoji samo
 * `4750 — PDV po osnovu SOPSTVENE POTROŠNJE 8 %`, što nije promet po izdatoj fakturi).
 * Konto se NE IZMIŠLJA — stopa bez konta se odbija sa objašnjenjem (isti obrazac kao
 * `AdvanceInvoiceService`, nalaz Batch C R5), a pitanje je zapisano u
 * `docs/PREOSTALE_FAZE.md` § „OTVORENO NA DAN 01.08.2026" i čeka knjigovođu.
 * Brana ostaje po PROCENTU (a ne po šifri) baš zato što je preživela ovu ispravku
 * mapiranja bez izmene: menja se koja šifra daje koji procenat, ne pravilo.
 */
const VAT_OUT_ACCOUNT_BY_PERCENT: Readonly<Record<string, string>> = {
  "20": ACC_VAT_OUT_20,
  "10": ACC_VAT_OUT_10,
};

/**
 * KONTO IZLAZNOG PDV-a ZA USLUGE — `4703`, ne `4702`.
 *
 * ⚠️ IZMEREN KVAR (05.08.2026, potvrđen odgovorom knjigovođe na pitanje 2):
 * ručna grana je za SVAKU stopu od 20 % knjižila na `4702 — PDV 20 % na prodate ROBE`,
 * jer se konto birao ISKLJUČIVO po procentu. A ručnom granom idu baš uslužni računi
 * (`IFUSL`, `IZVUS`) — robni tipovi imaju svoje šeme.
 *
 * Knjigovođa koristi TRI konta izlaznog PDV-a po tome šta se prodaje (izmereno nad
 * uvezenom knjigom 2026):
 *   `4701` PDV 20 % na prodate PROIZVODE  — 33 stavke (ide kroz šemu 36, ne ovuda)
 *   `4702` PDV 20 % na prodate ROBE       — 170 stavki (šema 33, ne ovuda)
 *   `4703` Obaveze za PDV — USLUGE 20 %   — 49 stavki / 3.654.711,50 RSD
 * Na `4702` nema NIJEDNE IFUSL stavke, a `4700`/`4710` imaju nulu — dakle konto za
 * usluge se u praksi koristi dosledno, a mi smo pisali na tuđi.
 *
 * Zašto je kvar tih: nalog balansira (isti iznos s obe strane), pa nijedna kontrola ne
 * reaguje — ali POPDV osnovicu izvodi IZ TIH KONTA, pa bi promet usluga završio u kofi
 * za robu.
 *
 * ⚠️ Konto PRIHODA za usluge više NIJE konstanta (05.08.2026): dolazi iz šifarnika
 * vrsta usluge (`service_revenue_types`, v. `service-revenue-type.ts`). `6140` ispod
 * ostaje samo kao vrednost za račun kod kog vrsta usluge nije izabrana — izmereno je
 * tačna za 45 od 57 stavki knjige 2026.
 */
const ACC_VAT_OUT_20_SERVICE = "4703";

/** Vrsta naloga za ručno knjiženje računa prodaje. */
const ORDER_TYPE_SALES = "IF";

/**
 * Uslužne vrste dokumenta. Spisak je od 05.08.2026. u `service-revenue-type.ts`, jer ga
 * uz knjiženje pita i poreski tretman i validacija izbora vrste usluge — v. tamo.
 */
const SERVICE_TYPES = SERVICE_DOCUMENT_TYPES;
const AUTO_STOCK_TYPES = new Set(["IFR", "IFGP", "IZVRO", "IZVGP"]);

interface LedgerLineDraft {
  accountCode: string;
  analyticalCode: number | null;
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
  description: string | null;
}

/**
 * KONTO PRIHODA ZA JEDAN DOKUMENT — roba, ili usluga po izabranoj vrsti.
 *
 * Redosled je namerno strog:
 *   1. dokument nije uslužan → `6040` (roba), bez obzira šta piše u zaglavlju;
 *   2. uslužan sa izabranom vrstom → konto IZ ŠIFARNIKA (`6140`/`6151`/`6796`/`6501`…);
 *   3. uslužan bez izbora → `6140`, tj. zatečeno ponašanje.
 *
 * Prvi korak nije formalnost: vrsta usluge sme da stoji i na predračunu koji se tek
 * prepisuje u račun, pa bi predračun prepisan u `IFR` inače odneo uslužni konto na
 * robnu fakturu. Isti uslov drži i `taxTreatmentOf`, pa konto i porez ne mogu da se
 * raziđu ni u jednoj kombinaciji.
 *
 * Konto se NE proverava prema kontnom planu: sva četiri seed konta postoje (izmereno
 * 05.08.2026 nad `accounts`, 1397 redova), a knjigovođa koji doda petu vrstu sme da je
 * unese i pre nego što otvori konto. Nepostojeće konto obara upis naloga u GK sa jasnom
 * porukom baze, na mestu gde se i vidi.
 */
function revenueAccountFor(invoice: {
  documentType: string;
  serviceRevenueType?: ServiceRevenueTypeRef | null;
}): string {
  if (!SERVICE_TYPES.has((invoice.documentType ?? "").trim().toUpperCase()))
    return ACC_REVENUE_GOODS;
  const fromCodebook = invoice.serviceRevenueType?.revenueAccountCode?.trim();
  return fromCodebook && fromCodebook.length > 0
    ? fromCodebook
    : ACC_REVENUE_SERVICE;
}

/**
 * REDOVI RUČNOG NALOGA GK ZA IZLAZNI RAČUN — čist račun, bez baze.
 *
 *   kupac (2040 / 2050 izvoz)         DUG = osnovica + Σ PDV po stopama
 *   prihod (6040 roba / 6140 usluga)  POT = osnovica
 *   PDV po stopi (4702 / 4710)        POT = `round2(osnovica_stope × stopa)`
 *
 * ⚠️ PDV PO STOPI, NE PO STAVCI (ispravka 02.08.2026): iznosi dolaze iz istog računara
 * koji puni `netTotal`/`vatTotal` na zaglavlju (`vat-totals.ts`). Do tada je knjižen
 * `Σ vatAmount` po stavkama, pa je GK umela da nosi PDV koji se od `invoice.vatTotal`
 * razlikuje za paru (izmereno: 5 stavki × 100,01 din uz 20 % → GK 100,00, faktura 100,01;
 * na 20 stavki do 0,05). Nalog bi i tada balansirao — ista pogrešna suma stoji i na
 * dugovnoj strani — ali bi kupčev dug u saldakontima odstupao od bruto iznosa fakture,
 * a POPDV osnovica (izvedena iz PDV konta deljenjem stopom) od osnovice na papiru.
 *
 * IZVUČENO IZ SERVISA da bi moglo da se meri bez transakcije, numeracije naloga i mock-a
 * cele Prisme: ovde je jedina aritmetika, a `postManualLedger` ostaje upis.
 */
export function buildSalesLedgerLines(
  invoice: {
    documentType: string;
    documentNumber: string;
    customerId: number | null;
    isExport: boolean;
    /**
     * Izabrana vrsta usluge (šifarnik `service_revenue_types`) — `null`/izostavljeno na
     * robi i na uslužnom računu bez izbora. Nosi KONTO PRIHODA i PORESKI TRETMAN; oba
     * dolaze iz istog reda, pa se ne mogu razići (v. `service-revenue-type.ts`).
     */
    serviceRevenueType?: ServiceRevenueTypeRef | null;
    /**
     * Naziv kupca (`customers.name`) za OPIS reda naloga. Opciono: `postManualLedger` ga
     * dovlači, a pred-provera na `postInvoice` (koja ovu funkciju zove samo da bi uhvatila
     * stopu bez konta) ne mora — opis tada nije ni bitan, jer se ništa ne upisuje.
     */
    customerName?: string | null;
    /**
     * Broj predmeta za opis. Danas UVEK prazno: `invoices` nema `project_id` (izmereno u
     * `information_schema.columns`), a `invoices.work_order_id` nijedan kod ne upisuje.
     * Parametar stoji da obe grane knjiženja imaju ISTI oblik opisa čim veza postane
     * stvarna — ne da bi se veza pretpostavljala.
     */
    projectNumber?: string | null;
  },
  items: ReadonlyArray<{ vatRateCode: string; vatBase: Prisma.Decimal }>,
): LedgerLineDraft[] {
  // Poreski tretman spaja vrstu dokumenta i šifarnik — `taxTreatmentOf` je jedino mesto
  // gde se to spaja, pa vrsta usluge sa predračuna ne može da deluje na robnu fakturu.
  const totals = documentVatTotals(items, {
    isExport: invoice.isExport,
    taxTreatment: taxTreatmentOf(invoice),
  });

  /**
   * OPIS — ISTI NA SVIM REDOVIMA JEDNOG RAČUNA (07.08.2026).
   *
   * ⚠️ ŠTA JE BILO: `Kupac 243/26` / `Prihod 243/26` / `PDV 20% 243/26` — opis PO KONTU.
   * To se razilazilo sa robnom granom u dva pravca odjednom: ona je (do iste ispravke)
   * pisala prazno, a BigBit je pisao ISTI tekst na svim kontima jednog dokumenta
   * (izmereno: 131 od 132 grupe „nalog + dokument"). Uz to nijedan od ta tri teksta nije
   * nosio novu informaciju — broj računa već stoji u `document_number` na istom redu, a
   * ulogu konta govori samo konto. Pravilo drži `ledgerDescription` (`ledger-line.ts`),
   * jedno mesto za obe grane.
   */
  const description = ledgerDescription({
    documentTypeCode: invoice.documentType,
    documentNumber: invoice.documentNumber,
    projectNumber: invoice.projectNumber ?? null,
    partnerName: invoice.customerName ?? null,
  });

  const lines: LedgerLineDraft[] = [
    {
      accountCode: invoice.isExport
        ? ACC_CUSTOMER_EXPORT
        : ACC_CUSTOMER_DOMESTIC,
      analyticalCode: invoice.customerId,
      // Kupac duguje BAŠ bruto iznos fakture (`netTotal + vatTotal`) — isti broj koji
      // stoji u zaglavlju, na papiru i u saldakontima.
      //
      // ⚠️ TO JE TVRDNJA KOJU NEKO MORA DA DRŽI: ovde se bruto RAČUNA IZ STAVKI, a
      // zaglavlje nosi svoj upisan broj. Do 02.08.2026. su ta dva broja mogla da se
      // raziđu (izvozni račun iz domaćeg predračuna — izmereno −19.872,73 na kupčevom
      // kontu). Od tada `assertTotalsMatchItems` odbija knjiženje dok se ne slože, pa je
      // rečenica iznad zaista tačna, a ne samo željena.
      debit: totals.grossTotal,
      credit: ZERO,
      description,
    },
    {
      // ⚠️ KONTO PRIHODA USLUGE DOLAZI IZ ŠIFARNIKA (05.08.2026). Do tada je ovde bio
      // izraz `usluga ? 6140 : 6040`, tj. konstanta — izmereno tačna za 45 od 57 stavki
      // uslužnog prometa u knjizi 2026, a pogrešna za preostalih 12 (`6151` izvozna
      // usluga 2 stavke / 2.490.465,79, `6796` otpad 10 / 1.222.645,05). Komercijala i
      // dalje ne bira konto — bira ŠTA PRODAJE, a konto stiže uz taj izbor.
      accountCode: revenueAccountFor(invoice),
      analyticalCode: null,
      debit: ZERO,
      credit: totals.netTotal,
      description,
    },
  ];

  if (invoice.isExport) return lines; // kategorija Z / čl. 24 — bez PDV linije

  for (const group of totals.groups) {
    if (group.vat.isZero()) continue;
    const percent = group.ratePercent.toFixed(0);
    // Usluga po opštoj stopi ide na SVOJ konto (`4703`); sve ostalo po procentu.
    // Grananje je isto kao kod prihoda dva reda iznad — porez prati vrstu prometa,
    // ne samo stopu.
    const account =
      percent === "20" && SERVICE_TYPES.has(invoice.documentType)
        ? ACC_VAT_OUT_20_SERVICE
        : VAT_OUT_ACCOUNT_BY_PERCENT[percent];
    // Stopa bez konta izlaznog PDV-a se do 02.08.2026. TIHO knjižila na konto stope od
    // 20 % (v. `VAT_OUT_ACCOUNT_BY_PERCENT`). Bolje odbiti sa objašnjenjem nego
    // proknjižiti porez na tuđe konto i time pokvariti POPDV.
    if (!account) {
      throw new UnprocessableEntityException(
        `Za PDV stopu ${percent}% ne postoji konto izlaznog PDV-a u kontnom planu — ` +
          `račun ${invoice.documentNumber} se ne može proknjižiti. ` +
          `Konto mora da odredi knjigovođa (v. docs/PREOSTALE_FAZE.md).`,
      );
    }
    lines.push({
      accountCode: account,
      analyticalCode: null,
      debit: ZERO,
      credit: group.vat,
      description,
    });
  }

  return lines;
}

/**
 * BRANA PRI KNJIŽENJU: ZAGLAVLJE MORA DA SE SLAŽE SA STAVKAMA.
 * =============================================================================
 *
 * Invarijanta: `documentVatTotals(stavke, {isExport})` mora da da BAŠ ono što piše u
 * zaglavlju (`netTotal`/`vatTotal`/`grossTotal`). To je jedina provera koja istovremeno
 * čuva sva tri čitaoca istog broja — papir čita zaglavlje, saldakonti i kreditni limit
 * čitaju zaglavlje, a glavna knjiga se gradi iz STAVKI (`buildSalesLedgerLines`).
 *
 * ⚠️ ZAŠTO POSTOJI (izmereno 02.08.2026): izvozni račun nastao prepisom domaćeg
 * predračuna nosio je `isExport=true`, ali stavke sa domaćom poreskom šifrom „3" i
 * zaglavlje sa PDV-om:
 *
 *   zaglavlje / saldakonti / kreditni limit  → gross 119.236,37
 *   GK (kupac 2050, isExport)                → dug    99.363,64
 *   razlika na kupčevom kontu                        −19.872,73  (ceo PDV)
 *
 * Otvorena stavka je izveden pogled nad `ledger_entries`, pa bi kupac trajno dugovao
 * manje nego što faktura glasi. ŠTAMPA takav dokument obara sa 400
 * (`print/totals.ts:assertExportWithoutVat`), ali KNJIŽENJE ga je propuštalo — redosled
 * brana je bio obrnut od korisnog: greška bi ušla u knjige i PDV prijavu, a otkrila se
 * tek kad kupac zatraži papir (izvozni račun ne ide ni na SEF, pa druge kontrole nema).
 *
 * ZAŠTO OPŠTA PROVERA (zaglavlje ⟷ stavke), A NE „izvoz nema PDV": izvoz je bio samo
 * jedan način da se to dvoje raziđu. Isto radi i svaka izmena stavki mimo
 * `SalesService.recalcTotals` (uvoz, ručna ispravka u bazi, budući BigBit uvoz) — a
 * posledica je uvek ista: kupčev dug u saldakontima ≠ iznos fakture. Provera hvata sve
 * te slučajeve jednim pravilom, i zato komentar uz `buildSalesLedgerLines` („kupac
 * duguje BAŠ bruto iznos fakture") od sada JESTE tačan: bez ovog slaganja se ne knjiži.
 *
 * ZAŠTO PRE `assertCreditLimit`: limit se meri `invoice.grossTotal`-om. Ako je zaglavlje
 * pogrešno, pogrešna je i procena duga — nema smisla trošiti proveru limita na broj koji
 * upravo obaramo.
 *
 * Poruka namerno nudi LEK („otvori pa sačuvaj"), jer `recalcTotals` pri svakoj izmeni
 * prepisuje zaglavlje iz stavki i time sam popravlja dokument.
 */
export function assertTotalsMatchItems(invoice: {
  documentType?: string | null;
  documentNumber: string;
  isExport: boolean;
  netTotal: Prisma.Decimal;
  vatTotal: Prisma.Decimal;
  grossTotal: Prisma.Decimal;
  serviceRevenueType?: ServiceRevenueTypeRef | null;
  items: ReadonlyArray<{ vatRateCode: string; vatBase: Prisma.Decimal }>;
}): void {
  // Tretman ulazi i OVDE, ne samo u knjiženje: ovo je jedina brana koja hvata slučaj da
  // je neko promenio vrstu usluge a zaglavlje ostalo sa starim porezom (npr. izmena u
  // bazi mimo `recalcTotals`). Bez toga bi račun za otpad mogao da se proknjiži sa
  // `vat_total` iz vremena kad je bio obična usluga.
  const totals = documentVatTotals(invoice.items, {
    isExport: invoice.isExport,
    taxTreatment: taxTreatmentOf(invoice),
  });
  const drift =
    !totals.netTotal.equals(invoice.netTotal) ||
    !totals.vatTotal.equals(invoice.vatTotal) ||
    !totals.grossTotal.equals(invoice.grossTotal);
  if (!drift) return;

  // Izvoz je najčešći uzrok i ima svoje objašnjenje — bez njega poruka kaže ŠTA ne
  // valja, ali ne i ZAŠTO (operater na izvoznom računu poresku stopu i ne vidi).
  const razlog = invoice.isExport
    ? " Dokument je izvozni (bez PDV-a, čl. 24), a stavke nose domaću poresku šifru — " +
      "verovatno je nastao prepisom domaćeg predračuna."
    : "";
  throw new UnprocessableEntityException(
    `Zbirovi računa ${invoice.documentNumber} ne slažu se sa stavkama, pa se ne može ` +
      `proknjižiti: zaglavlje ${invoice.netTotal.toFixed(2)} + ` +
      `${invoice.vatTotal.toFixed(2)} = ${invoice.grossTotal.toFixed(2)}, ` +
      `a stavke daju ${totals.netTotal.toFixed(2)} + ${totals.vatTotal.toFixed(2)} = ` +
      `${totals.grossTotal.toFixed(2)}.${razlog} ` +
      `Otvori dokument i sačuvaj ga (zbirovi se tada preračunaju iz stavki), pa ponovi knjiženje.`,
  );
}

/** Dopiši storno-razlog u napomenu fakture (čuva postojeći tekst, audit trag). */
function appendStornoNote(existing: string | null, reason: string): string {
  const stamp = `STORNO: ${reason}`;
  return existing && existing.trim().length > 0
    ? `${existing}\n${stamp}`
    : stamp;
}

@Injectable()
export class FakturisanjeService {
  private readonly logger = new Logger(FakturisanjeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pricing: PricingService,
    private readonly numbering: DocumentNumberSequenceService,
    private readonly posting: PostingEngineService,
    private readonly glWrite: GlWriteService,
    private readonly sef: SefService,
    private readonly reservation: ReservationService,
  ) {}

  // ── PREDRAČUN / PONUDA ──────────────────────────────────────────────────────

  /**
   * Kreiraj predračun/ponudu (PON/PROF, level 250, DRAFT). Cene iz PricingService.
   */
  async createProforma(dto: CreateProformaDto, actor: AuthUser) {
    validateCreateProforma(dto);

    const documentType = dto.documentType ?? "PROF";
    const companyId = dto.companyId ?? 0;
    const isExport = dto.isExport ?? false;
    const currency = dto.currency ?? (isExport ? "EUR" : "RSD");

    // Uz postojanje kupca uzimamo i dva podatka koja traži štampa (STAMPA_FAKTURA_GAP.md §3):
    //   • salespersonId → „Odgovorno lice" u potpisnom bloku (polje na Invoice je postojalo,
    //     ali ga niko nije punio, pa je ime na papiru bilo nemoguće);
    //   • paymentMethod → „Način plaćanja" u traci uslova / `Payment terms:` na ino fakturi.
    // Podrazumevaju se sa kupca; kad se napravi ekran za unos dokumenta, moći će da se pregaze
    // po dokumentu (isto kao u legacy GoodsDocument-u, koji oba nosi na zaglavlju dokumenta).
    const customer = await this.prisma.customer.findUnique({
      where: { id: dto.customerId },
      select: { id: true, salespersonId: true, paymentMethod: true },
    });
    if (!customer)
      throw new NotFoundException(`Kupac ${dto.customerId} ne postoji.`);

    // Legacy „nema komercijalistu" se piše kao 0, a ne NULL — 0 nije ID nijednog prodavca.
    const salespersonId =
      customer.salespersonId != null && customer.salespersonId > 0
        ? customer.salespersonId
        : null;
    const paymentMethod = customer.paymentMethod?.trim() || null;

    // Cena svake stavke (PricingService) — pre transakcije (čist read).
    const priced = [];
    for (const it of dto.items) {
      const p = await this.pricing.priceItem({
        customerId: dto.customerId,
        itemId: it.itemId ?? null,
        quantity: it.quantity,
        documentType,
        requestedDiscountPercent: it.discountPercent,
        cashDiscountPercent: it.cashDiscountPercent,
        overrideUnitPrice: it.unitPrice,
        vatRateCode: it.vatRateCode,
      });
      priced.push({ input: it, priced: p });
    }

    // Za izvoz PDV se ne obračunava (kategorija Z) — nula PDV bez obzira na šifru.
    const itemsData = priced.map((row, idx) => {
      const p = row.priced;
      const vatBase = p.vatBase;
      // PDV STAVKE je izvedena informacija (kolona „PDV" na papiru); porez dokumenta se
      // NE dobija njegovim sabiranjem — v. `vat-totals.ts` i `documentVatTotals` ispod.
      const vatAmount = isExport ? ZERO : p.vatAmount;
      const lineTotal = vatBase.add(vatAmount);
      return {
        lineNo: idx + 1,
        itemId: row.input.itemId ?? null,
        description: row.input.description ?? null,
        // j.m. za štampu; za artikal ostaje prazno i štampa je uzima iz Item.unit.
        unit: row.input.unit?.trim() || null,
        quantity: p.quantity,
        unitPrice: p.unitPrice,
        // Osnovica za koeficijent (§8/O1). Dokument se pravi sa koeficijentom 1,
        // pa je bazna cena jednaka cenovnoj. Bez ovog upisa kolona ostaje na
        // `DEFAULT 0`, a prvi dodir stavke bi cenu izveo iz nule.
        baseUnitPrice: p.unitPrice,
        // Cena PRE rabata — jedini trag pune cene za red „Rabat" na štampi. `baseUnitPrice`
        // to NIJE: ona je već posle rabata i kase (v. `schema.prisma`), pa se iz nje rabat
        // od 100 % ne može izvesti — cena posle takvog rabata je nula.
        unitPriceBeforeDiscount: p.unitPriceBeforeDiscount,
        discountPercent: p.discountPercent,
        cashDiscountPercent: p.cashDiscountPercent,
        vatRateCode: isExport ? "0" : p.vatRateCode,
        vatBase,
        vatAmount,
        lineTotal,
      };
    });

    // ZBIROVI DOKUMENTA — osnovica je zbir stavki, PDV je `round2(osnovica_stope × stopa)`
    // (ispravka 02.08.2026; do tada `Σ vatAmount` po stavkama, v. `vat-totals.ts`).
    // Stavke već nose šifru "0" na izvozu, ali se `isExport` prosleđuje i eksplicitno:
    // ovaj put pravi dokument iz spoljnog tela i ne sme da zavisi od tuđeg upisa.
    const { netTotal, vatTotal, grossTotal } = documentVatTotals(itemsData, {
      isExport,
    });

    // T3/A8: kreditni limit kupca — 422 i pri kreiranju predračuna/ponude ako bi
    // projektovani dug prešao limit, osim uz force (telo { force: true }).
    const force =
      (dto as CreateProformaDto & { force?: boolean }).force === true;
    await this.assertCreditLimit(dto.customerId, grossTotal, force);

    const year = (
      dto.documentDate ? new Date(dto.documentDate) : new Date()
    ).getFullYear();
    // Draft broj (predračun) — dodeljuje se odmah po godišnjem nizu predračuna.
    const invoice = await this.prisma.$transaction(async (tx) => {
      const documentNumber = await this.numbering.next(
        tx,
        documentType,
        year,
        companyId,
      );
      return tx.invoice.create({
        data: {
          documentType,
          documentNumber,
          level: 250,
          companyId,
          customerId: dto.customerId,
          documentDate: dto.documentDate
            ? new Date(dto.documentDate)
            : new Date(),
          dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
          // DATUM PROMETA (obavezan element računa po Zakonu o PDV — nalaz N1/M1 iz
          // docs/FAKTURE_ZAKONSKA_USKLADJENOST.md): do sada ga nijedna ruta nije upisivala,
          // pa je kolona uvek bila NULL i obrasci su štampali praznu ćeliju.
          // Na PREDRAČUNU ostaje `null` kad ga korisnik ne pošalje — predračun se izdaje pre
          // prometa, pa ovde nemamo šta da podrazumevamo; podrazumevanu vrednost postavlja
          // `postInvoice` u trenutku knjiženja (vidljivo, uz WARN u logu).
          supplyDate: dto.supplyDate ? new Date(dto.supplyDate) : null,
          currency,
          isExport,
          netTotal,
          vatTotal,
          grossTotal,
          status: "DRAFT",
          poNumber: dto.poNumber?.trim() || null,
          salespersonId,
          paymentMethod,
          note: dto.note ?? null,
          createdByUserId: actor.userId,
          updatedByUserId: actor.userId,
          items: { create: itemsData },
        },
        include: {
          items: { orderBy: { lineNo: "asc" } },
          serviceRevenueType: SERVICE_REVENUE_TYPE_SELECT,
        },
      });
    });

    return invoice;
  }

  // ── LISTA / DETALJ ──────────────────────────────────────────────────────────

  async listInvoices(query: ListInvoicesQuery) {
    const where: Prisma.InvoiceWhereInput = {};
    if (query.documentType) where.documentType = query.documentType;
    if (query.status) where.status = query.status;
    if (query.level !== undefined) where.level = query.level;
    if (query.customerId !== undefined) where.customerId = query.customerId;
    if (query.companyId !== undefined) where.companyId = query.companyId;
    if (query.isExport !== undefined) where.isExport = query.isExport;

    const take = query.take && query.take > 0 ? Math.min(query.take, 200) : 50;
    const skip = query.skip && query.skip > 0 ? query.skip : 0;

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.invoice.findMany({
        where,
        orderBy: { documentDate: "desc" },
        skip,
        take,
      }),
      this.prisma.invoice.count({ where }),
    ]);

    return { data: rows, meta: { total, skip, take } };
  }

  /**
   * Detalj računa. Batch C §C1a: uz dokument se vraća i IZRAČUNATO
   * `payableAmount = grossTotal − Σ AKTIVNIH primena avansa` (avans umanjuje samo
   * iznos za plaćanje — `grossTotal` se NE menja), plus broj avansnog računa
   * (`advanceInvoiceNumber`) kad je avans odbijen, da FE/štampa ne moraju
   * dodatni upit.
   *
   * Od migracije 20260726120000 veza avans↔račun je N:M
   * (`invoice_advance_applications`), pa se vraća i pun spisak primena
   * (`advanceApplications`) — jedan račun sme zatvarati više avansa.
   *
   * ⚠️ „ODBIJENO" IDE KROZ `./advance-deduction` (ispravka 02.08.2026). Ovaj ekran je
   * do tada radio po „ILI-ILI": zbir primena, a na kolonu `advance_applied_amount` je
   * padao SAMO kad primena nema nijedne. Za račun sa zatečenom 1:1 vezom (upisuje je
   * pdv modul rutom `link-final`) I novom N:M primenom to je značilo da ekran vidi
   * SAMO N:M deo — papir je govorio „za uplatu 5.000", a ekran „8.000". Sada oba
   * računaju isto: UNIJA primena i zatečene veze (obrazloženje u `advance-deduction.ts`).
   */
  async getInvoice(id: number) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id },
      include: {
        items: { orderBy: { lineNo: "asc" } },
        serviceRevenueType: SERVICE_REVENUE_TYPE_SELECT,
      },
    });
    if (!invoice) throw new NotFoundException(`Račun ${id} ne postoji.`);

    const applications = await this.prisma.invoiceAdvanceApplication.findMany({
      where: { invoiceId: id, status: APPLICATION_ACTIVE },
      orderBy: { id: "asc" },
      select: {
        id: true,
        advanceInvoiceId: true,
        appliedAmount: true,
        appliedNet: true,
        appliedVat: true,
        closingEntryId: true,
        createdAt: true,
        advance: { select: { documentNumber: true, advancePaidAt: true } },
      },
    });

    const advance =
      invoice.advanceInvoiceId != null
        ? await this.prisma.invoice.findUnique({
            where: { id: invoice.advanceInvoiceId },
            select: { documentNumber: true, advancePaidAt: true },
          })
        : null;

    const deductions = computeAdvanceDeductions({
      invoice,
      applications: applications.map((a) => ({
        advanceInvoiceId: a.advanceInvoiceId,
        appliedAmount: a.appliedAmount,
        advanceDocumentNumber: a.advance.documentNumber,
      })),
      legacyAdvanceDocumentNumber: advance?.documentNumber ?? null,
    });
    const appliedTotal = deductions.total;

    /**
     * KOMPATIBILNA POLJA „prvi avans" (`advanceInvoiceNumber` / `advanceInvoicePaidAt`)
     * SMEJU da imenuju samo avans koji je STVARNO u spisku umanjenja.
     *
     * Do 02.08.2026. su se čitala pravo iz kolone-pokazivača `advance_invoice_id`, pa
     * su bila DRUGI izvor za isti pojam. Kad je `advance_applied_amount ≤ Σ aktivnih
     * primena` (zatečena 1:1 veza pokrivena N:M primenama, storno primene, ručna
     * ispravka kolone u bazi), pravilo taj avans ne daje u `advanceDeductions` — a
     * ekran je i dalje pisao „Avans: A-1/26", dokument kojeg u spisku umanjenja nema
     * i čiji iznos nigde ne stoji. Knjigovođa tada traži 3.000 koje ne postoje.
     *
     * Sada oba polja opisuju PRVI red spiska (`deductions.lines[0]`): nema reda →
     * nema ni imena. Broj se uzima iz samog reda, a datum naplate iz izvora tog reda
     * (zatečena veza = učitan AVR iz kolone; N:M primena = AVR te primene).
     */
    const firstDeduction = deductions.lines[0] ?? null;
    const firstAdvance =
      firstDeduction == null
        ? null
        : firstDeduction.fromLegacyLink
          ? advance
          : (applications.find(
              (a) => a.advanceInvoiceId === firstDeduction.advanceInvoiceId,
            )?.advance ?? null);

    return {
      ...invoice,
      payableAmount: computePayableAmount({
        grossTotal: invoice.grossTotal,
        advanceAppliedAmount: appliedTotal,
      }),
      advanceAppliedAmount: appliedTotal,
      advanceInvoiceNumber: firstAdvance?.documentNumber ?? null,
      // Datum naplate ODBIJENOG avansa (polje `advancePaidAt` na SAMOM dokumentu
      // ostaje netaknuto — ono važi samo za AVR, ne za konačni račun).
      advanceInvoicePaidAt: firstAdvance?.advancePaidAt ?? null,
      /**
       * ODBIJENI AVANSI — isti spisak koji ide i na papir i na e-fakturu: po jedan
       * unos PO AVANSU, sa iznosom BAŠ TOG avansa. Zbir mu je uvek `advanceAppliedAmount`.
       *
       * Razlikuje se od `advanceApplications` ispod: ovde je i zatečena 1:1 veza koja
       * nema svoj red u spojnoj tabeli (`fromLegacyLink`), pa ekran ne može da prikaže
       * spisak koji ne sabira u prikazan iznos.
       */
      advanceDeductions: deductions.lines.map((l) => ({
        advanceInvoiceId: l.advanceInvoiceId,
        advanceDocumentNumber: l.advanceDocumentNumber,
        amount: l.amount,
        fromLegacyLink: l.fromLegacyLink,
      })),
      /**
       * Sve aktivne primene avansa na ovom računu (N:M, redom nastanka) — TEHNIČKI
       * spisak redova spojne tabele (id primene, razbijena osnovica/PDV, nalog
       * zatvaranja). Zatečena 1:1 veza ovde NEMA šta da traži: ona nema ni red ni
       * nalog. Za prikaz „šta je sve odbijeno" koristi `advanceDeductions`.
       */
      advanceApplications: applications.map((a) => ({
        id: a.id,
        advanceInvoiceId: a.advanceInvoiceId,
        advanceDocumentNumber: a.advance.documentNumber,
        advancePaidAt: a.advance.advancePaidAt,
        appliedAmount: a.appliedAmount,
        appliedNet: a.appliedNet,
        appliedVat: a.appliedVat,
        closingEntryId: a.closingEntryId,
        appliedAt: a.createdAt,
      })),
    };
  }

  // ── KNJIŽENJE (level 0) ──────────────────────────────────────────────────────

  /**
   * Proknjiži račun: rezerviši definitivan broj + kreiraj nalog GK. Idempotentno
   * (već-knjižen račun status ≠ DRAFT → ConflictException).
   */
  async postInvoice(id: number, actor: AuthUser, force = false) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id },
      include: {
        items: { orderBy: { lineNo: "asc" } },
        serviceRevenueType: SERVICE_REVENUE_TYPE_SELECT,
      },
    });
    if (!invoice) throw new NotFoundException(`Račun ${id} ne postoji.`);

    // D8: zaključan (proknjižen) dokument se ne knjiži ponovo / ne menja bez storna.
    if (invoice.isLocked) {
      throw new ConflictException("Dokument je zaključan (proknjižen).");
    }
    if (invoice.status !== "DRAFT") {
      throw new ConflictException(
        `Račun ${id} je već proknjižen (status ${invoice.status}).`,
      );
    }
    if (invoice.customerId == null) {
      throw new UnprocessableEntityException(
        `Račun ${id} nema kupca — ne može se proknjižiti.`,
      );
    }
    if (invoice.items.length === 0) {
      throw new UnprocessableEntityException(
        `Račun ${id} nema stavke — ne može se proknjižiti.`,
      );
    }

    // Zaglavlje mora da se slaže sa stavkama PRE svega ostalog — v. `assertTotalsMatchItems`.
    assertTotalsMatchItems(invoice);

    // T3/A8: kreditni limit kupca (Customer.creditLimit sync polje) — 422 PRE claim-a
    // ako bi projektovani dug prešao limit, osim uz force (svesno knjiženje uprkos
    // limitu; FAKTURISANJE post permisija je dovoljno ovlašćenje).
    await this.assertCreditLimit(invoice.customerId, invoice.grossTotal, force);

    const year = businessYear(invoice.documentDate);

    // Grana knjiženja zavisi SAMO od snapshot-a, pa se odlučuje pre transakcije.
    const isAutoStock =
      AUTO_STOCK_TYPES.has(invoice.documentType) &&
      invoice.stockDocumentId != null;

    /**
     * PRED-PROVERA RUČNOG NALOGA DOK DOKUMENT JOŠ NOSI NACRT-BROJ (03.08.2026).
     *
     * `buildSalesLedgerLines` baca tačno jednu grešku — „za stopu X% nema konta
     * izlaznog PDV-a" — i u njoj IMENUJE dokument. Od ispravke N1 (ispod) ručni nalog
     * se gradi nad snapshot-om sa IZDATIM brojem, pa bi ta poruka, da je prvi susret
     * sa njom unutar transakcije, glasila „račun 657/26 se ne može proknjižiti" —
     * broju koji posle rollback-a ne postoji nigde (numeracija se vraća zajedno sa
     * transakcijom, v. `numbering.service.ts`), dok na ekranu stoji `DRAFT-300`.
     * Ovde se ista provera izvrši nad brojem koji operater VIDI, i to pre nego što se
     * uzme ijedna brava. Račun je čist (bez baze) i nad istim stavkama, pa drugi
     * prolaz unutar transakcije ne može da da drugačiji ishod.
     */
    if (!isAutoStock) buildSalesLedgerLines(invoice, invoice.items);

    return this.prisma.$transaction(async (tx) => {
      // 0) ATOMSKI CLAIM (review 1D nalaz): invoice se čita findUnique VAN tx, pa su
      //    rani guardovi (isLocked/status DRAFT) nad snapshot-om — dva paralelna posta
      //    bi oba prošla i ručna grana (postManualLedger) bi kreirala DVA posted naloga
      //    (dupli prihod+PDV). CAS updateMany je JEDINI izvor ekskluzivnosti: samo jedna
      //    tx prelama DRAFT & !isLocked → POSTED & locked; ostale dobiju count 0 → 409.
      //    Rani guardovi ostaju kao fast-fail sa specifičnijim porukama (customer/stavke).
      const claimed = await tx.invoice.updateMany({
        where: { id, status: "DRAFT", isLocked: false },
        data: { status: "POSTED", isLocked: true },
      });
      if (claimed.count !== 1) {
        throw new ConflictException("Račun je već proknjižen ili zaključan.");
      }

      // 1) Rezerviši definitivan broj (level 0). Rollback numeracije ide sa tx.
      const documentNumber = await this.numbering.next(
        tx,
        invoice.documentType,
        year,
        invoice.companyId,
      );

      /**
       * SNAPSHOT SA IZDATIM BROJEM — sve što nastaje POSLE ovog reda mora da vidi
       * `documentNumber`, a ne nacrt-broj sa kojim je dokument ušao u knjiženje.
       * =========================================================================
       *
       * ⚠️ IZMEREN KVAR (02.08.2026): `invoice` je pročitan na početku metode, broj se
       * izdaje TEK OVDE, a u red fakture se upisuje na kraju (`tx.invoice.update`) —
       * ali je `postManualLedger` do sada dobijao NEDIRNUT snapshot. Predračun #300 →
       * IFUSL (carry-over upisuje privremeni `DRAFT-300`) → knjiženje izdaje `657/26`,
       * a sve tri linije naloga
       *
       *     2040 DUG 120.000 / 6140 POT 100.000 / 4702 POT 20.000
       *
       * nose `document_number = 'DRAFT-300'`, uključujući i opise („Kupac DRAFT-300").
       * Ništa nizvodno to ne prepravlja.
       *
       * ZAŠTO JE TO SKUPO: saldakonti grupišu otvorene stavke ISKLJUČIVO po
       * `(account_code, analytical_code, document_number)` (`open-items.service.ts`), a
       * uparivanje uplate ide po pozivu na broj. Kupčeva otvorena stavka bi glasila na
       * broj koji ne postoji ni na jednom papiru, KIF red isto, a uplata sa pozivom na
       * `657/26` ne bi našla ništa da zatvori.
       *
       * ŠIRE NEGO ŠTO IZGLEDA: `carry-over` nikad ne upisuje `stockDocumentId`, pa
       * SVIH SEDAM ciljnih vrsta (ne samo IFUSL) ide ručnom granom — dakle ovaj put je
       * pravilo, a ne izuzetak.
       *
       * `postManualLedger` je jedini potrošač snapshot-a posle izdavanja broja
       * (provereno grep-om po `postManualLedger` i po korišćenjima `invoice` ispod):
       * ostali čitaju `documentType`/`stockDocumentId`/`supplyDate`/`documentDate`,
       * koje izdavanje broja ne dira.
       *
       * ⚠️ SNAPSHOT SE PONOVO ČITA UNUTAR TRANSAKCIJE — ispravka regresije, 03.08.2026.
       *
       * Prva verzija ove ispravke je uz broj prosleđivala i `invoice.items` iz snapshot-a,
       * uz obrazloženje „isti ulaz kao u pred-proveri, pa se dva prolaza ne mogu razići".
       * Obrazloženje je bilo pogrešno: pred-provera je radila nad ISTIM zastarelim
       * podatkom. `invoice` se čita PRE transakcije, a CAS claim je tek ovde; u tom
       * prozoru (dve provere + agregat nad `ledger_entries` + otvaranje transakcije)
       * drugi operater sme da izmeni isti nacrt — `SalesService.updateItems` radi svoj
       * CAS nad `DRAFT & !isLocked`, koji tada još prolazi, i preračuna zaglavlje.
       *
       * IZMERENO: stavke u bazi 2 × 100.000, snapshot nosi 1 × 100.000 →
       * faktura `gross = 240.000`, a nalog `2040 DUG 120.000 / 6140 POT 100.000 /
       * 4702 POT 20.000`. Nalog BALANSIRA (ista pogrešna suma s obe strane), pa
       * balans-kontrola ćuti; kupčev dug u saldakontima je pola fakture, a POPDV
       * osnovica i KIF (izvedeni iz `ledger_entries`) su na pogrešan iznos.
       *
       * `assertTotalsMatchItems` to ne hvata: poredi snapshot-zaglavlje sa
       * snapshot-stavkama — par koji je međusobno dosledan, samo zastareo.
       *
       * Lek: posle CAS-a je dokument ZAKLJUČAN (`POSTED & isLocked`), pa ga niko više ne
       * može izmeniti — sveže čitanje ODAVDE je jedino koje je i tačno i stabilno.
       */
      const fresh = await tx.invoice.findUniqueOrThrow({
        where: { id },
        include: {
          items: { orderBy: { lineNo: "asc" } },
          serviceRevenueType: SERVICE_REVENUE_TYPE_SELECT,
        },
      });
      // Zbirovi i stavke moraju da se slažu i na SVEŽEM redu — ista brana kao pre
      // transakcije, samo nad podatkom koji je stvarno proknjižen. Ako je tuđa izmena
      // stigla u međuvremenu, ovde se vidi i knjiženje pada umesto da upiše pogrešan iznos.
      assertTotalsMatchItems(fresh);
      const issued = { ...fresh, documentNumber };

      // 2) Auto-robno (IFR/IFGP/IZVRO/IZVGP) sa vezanim robnim izlazom → PostingEngine.
      let journalEntryId: number | null = null;

      if (isAutoStock && invoice.stockDocumentId != null) {
        // Auto-robno knjiženje (razduženje + prihod + PDV) po šemi 33/36/24/47.
        // PostingEngine sam otvara $transaction; pozivamo ga van tx-a NAKON commit-a
        // ovog bloka nije moguće (broj mora biti u istoj tx). Zato: kreiramo broj,
        // pa unutar iste logičke celine markiramo — ali PostingEngine ima svoju tx.
        // Rešenje: prvo posting (svoja tx), pa tek onda rezervacija broja ovde bi
        // razbila atomiku. Zadržavamo redosled: broj u ovoj tx, posting posle commit-a.
        // (Za auto-robno, robni dokument je već proknjižen kroz Fazu 3 tok — ovde
        // preuzimamo journalEntryId ako postoji, inače ostaje null.)
        const existing = await tx.journalEntry.findFirst({
          where: { sourceGoodsDocId: invoice.stockDocumentId },
          select: { id: true, status: true },
        });
        /**
         * ROBNI IZLAZ BEZ NALOGA → 422, NIKAD TIHI `null`.
         * =====================================================================
         *
         * ⚠️ IZMEREN KVAR (02.08.2026): za IFR sa `stockDocumentId = 55` čija je
         * izdatnica još DRAFT, `findFirst` vraća `null` i grana je TIHO upisivala
         * `journalEntryId = null` — bez greške i bez WARN-a. Ishod: broj `657/26`
         * potrošen, dokument POSTED i LOCKED, a u glavnoj knjizi NULA redova. Takav
         * račun se štampa i sme na SEF, a nema ga ni u saldakontima, ni u KIF-u, ni u
         * POPDV-u; ponovno knjiženje pada na 409 (`isLocked`), a storno nema šta da
         * reverzira. Put je jedan klik: PROF → IFR →
         * `POST /robno/documents/from-invoice` (izdatnica nastaje kao DRAFT) →
         * `POST /sales/invoices/:id/post`.
         *
         * ZAŠTO 422, A NE PAD NA RUČNI NALOG: ručni nalog knjiži prihod i PDV, a šema
         * robnog izlaza (33/36) knjiži i razduženje zaliha — pa bi kasnije knjiženje
         * izdatnice udvostručilo prihod i porez. Račun bez naloga se ne izdaje; broj
         * se ne troši (rollback vraća i numeraciju).
         *
         * ⚠️ ZA OPERATERA JE OVO NOVA PREPREKA NA PUTU KOJI JE DO SADA VRAĆAO 200:
         * poruka zato imenuje OBA uzroka (neproknjižena izdatnica / vrsta dokumenta
         * bez šeme kontiranja) i oba leka. Na produkciji danas nijedan
         * `document_types.posting_template` nije popunjen, pa se ovom granom ne može
         * proknjižiti NIJEDAN račun sa vezanom izdatnicom — do sada su svi prolazili
         * bez ijednog reda u GK. Zapisano u `docs/PREOSTALE_FAZE.md`.
         */
        if (!existing) {
          throw new UnprocessableEntityException(
            `Račun ${invoice.documentNumber} je vezan za robni izlaz (izdatnicu) ` +
              `#${invoice.stockDocumentId} koji još nije proknjižen u glavnu knjigu — ` +
              `račun se ne može proknjižiti, jer bi ostao bez naloga GK (nevidljiv u ` +
              `saldakontima, KIF-u i POPDV-u). Prvo proknjiži izdatnicu (Robno → ` +
              `dokument → Knjiži), pa ponovi knjiženje računa. Ako izdatnica ne može da ` +
              `se proknjiži jer njena vrsta dokumenta nema šemu kontiranja ` +
              `(posting_template), šemu mora da postavi knjigovođa.`,
          );
        }
        journalEntryId = existing.id;
        // Robni auto-nalog nastaje kao `draft` (posting.service.ts:358), a kartica
        // konta / saldakonti / bilans čitaju SAMO status IN ('POSTED','LOCKED') —
        // draft nalog je nevidljiv. Zato preuzeti nalog promovišemo u `posted` u istoj
        // tx (odluka O4 default, kao izvod u PR #8). markPosted idiom = status guard:
        // CAS `where status='DRAFT'` menja SAMO draft; posted/locked ostaje netaknut
        // (idempotentno — račun čiji je robni nalog već proknjižen/zaključan se ne dira).
        if (existing.status === "DRAFT") {
          await tx.journalEntry.updateMany({
            where: { id: existing.id, status: "DRAFT" },
            data: { status: "POSTED" },
          });
        }
      } else {
        // 3) RUČNI nalog (IFUSL/uslužni ili račun bez robnog izlaza) — direktan GL.
        //    Ide `issued` (snapshot sa IZDATIM brojem), ne `invoice` — v. N1 iznad.
        //    Stavke dolaze iz SVEŽEG čitanja unutar transakcije (`fresh`), ne iz
        //    snapshot-a pročitanog pre nje — v. obrazloženje uz `fresh` iznad.
        journalEntryId = await this.postManualLedger(
          tx,
          issued,
          year,
          actor,
          fresh.items,
        );
      }

      // 3b) DATUM PROMETA — podrazumevana vrednost, i to SAMO ovde (mera M1).
      //     Zašto uopšte podrazumevati: datum prometa je obavezan element računa po
      //     Zakonu o PDV, a knjiženje je trenutak u kome nacrt postaje izdat račun —
      //     posle njega je dokument zaključan (D8) i podatak se više ne može dodati bez
      //     storna. Proknjižen račun bez datuma prometa je zato neispravan papir.
      //     Zašto BAŠ datum izdavanja: kod prodaje robe „preko pulta"/iz magacina promet
      //     i izdavanje računa padaju na isti dan, i to je jedini datum koji sistem u tom
      //     trenutku pouzdano zna. Ostale kandidate nemamo: robni izlaz (stockDocumentId)
      //     ne mora postojati (IFUSL), a datum otpreme se nigde ne vodi.
      //     Zašto NIJE tiho: upisuje se WARN sa brojem računa, pa se u logu vidi na kojim
      //     je dokumentima datum izveden umesto unet.
      //     🔴 ZA POTVRDU KNJIGOVOĐI (§7 t.3): sme li se datum prometa uopšte izjednačiti
      //     sa datumom izdavanja i šta je datum prometa kod usluge koja traje mesecima
      //     (zakup, montaža) — dok se ne odgovori, ovo je najmanje pogrešna pretpostavka,
      //     a ne konačno pravilo.
      const supplyDate = invoice.supplyDate ?? invoice.documentDate;
      if (invoice.supplyDate == null) {
        this.logger.warn(
          `Račun ${id} (${invoice.documentType}) nema unet datum prometa — ` +
            `pri knjiženju je postavljen na datum izdavanja ` +
            `(${invoice.documentDate.toISOString().slice(0, 10)}).`,
        );
      }

      // 4) Ažuriraj račun: definitivan broj, level 0, veza na nalog. `where {id}` je
      //    bezbedan jer je CLAIM (korak 0) već obezbedio ekskluzivnost i postavio
      //    status=POSTED & isLocked=true; ovde ih samo re-afirmišemo (D8: proknjižen
      //    dokument je tehnički zaključan — mutacije/storno idu odvojenim putem).
      const posted = await tx.invoice.update({
        where: { id },
        data: {
          documentNumber,
          level: 0,
          status: "POSTED",
          journalEntryId,
          isLocked: true,
          supplyDate,
          updatedByUserId: actor.userId,
        },
        include: {
          items: { orderBy: { lineNo: "asc" } },
          serviceRevenueType: SERVICE_REVENUE_TYPE_SELECT,
        },
      });

      return posted;
    });
  }

  // ── STORNO (D8: jedini dozvoljeni put za zaključan dokument) ─────────────────

  /**
   * Storno proknjižene fakture (BigBit ER paritet). Guard: dokument mora biti
   * zaključan (isLocked) i proknjižen (status ≠ DRAFT), i još ne storniran
   * (status ≠ CANCELLED). D8: storno je JEDINI put koji sme da dira zaključan
   * dokument (postInvoice/mutacije ga odbijaju).
   *
   * ═════════════════════════════════════════════════════════════════════════════
   * SVE ŠTO DIRA BAZU JE U JEDNOJ TRANSAKCIJI (ispravka 03.08.2026)
   * ═════════════════════════════════════════════════════════════════════════════
   *
   * ⚠️ ZATEČENO STANJE (izmereno, pravi `GlWriteService`): CAS `status → CANCELLED` se
   * COMMIT-ovao prvi, pa je niz koraka išao nad `this.prisma`, van transakcije i bez
   * ijedne brave. Faktura 101, nalog 500 zaključan („zaključaj period" —
   * `POST /gl/journal/lock-older`), primena avansa #55 ACTIVE, SEF red SENT: CAS prođe →
   * `gl-write.reverse` baci 409 „Nalog 500 je zaključan" → i tu se sve zaustavi. Primena
   * #55 ostaje ACTIVE, kolone (`advance_invoice_id = 9`, 30.000) neočišćene, `sef.cancel`
   * i `reservation.release` nepozvani. Drugi pokušaj → 409 „već storniran".
   *
   * 🔴 ZAŠTO JE BAŠ PRIMENA AVANSA NEPOPRAVLJIVA: GK, SEF i rezervacije imaju ručne rute
   * sanacije, a primena avansa NEMA — jedini pisač statusa `REVERSED` je baš ovaj storno.
   * `applyAdvance` pri tom sabira ACTIVE primene BEZ obzira na status računa, pa naplaćen
   * avans ostaje trajno potrošen: svaki sledeći pokušaj dobija 422 „već iskorišćen u
   * celosti". Zato „sanira se ručno" ovde nije bio trade-off nego ćorsokak.
   *
   * TOK SADA:
   *   0) fast-fail čitanja van transakcije (404 / već storniran / nije proknjižen);
   *   1) TRANSAKCIJA:
   *      a) advisory brave ISTE koje drži `applyAdvance` — račun (4003) pa avans (4004),
   *         uvek tim redom (obrnut redosled u dve sesije = mrtva petlja);
   *      b) svež snapshot pod bravom + AVR guard;
   *      c) PROVERA REVERZIBILNOSTI SVIH naloga PRE CAS-a (izvorni + nalozi zatvaranja
   *         avansa) — zaključan nalog obara storno dok ništa nije promenjeno;
   *      d) CAS status → CANCELLED (ekskluzivnost) + razlog u napomenu;
   *      e) reverzija naloga (`glWrite.reverseWithin`, ISTA tx), primene → REVERSED,
   *         čišćenje kompatibilnih kolona.
   *   2) posle commit-a, spoljni sistemi koji u transakciju ne mogu: rezervacije i SEF.
   *
   * Vraća storniranu fakturu + id storno-naloga + spiskove otkazanih SEF redova
   * (sefCancelledOutboxIds = SEF cancel; sefCancelledPendingIds = lokalno otkazani PENDING).
   */
  async stornoInvoice(id: number, reason: string, actor: AuthUser) {
    const snapshot = await this.prisma.invoice.findUnique({
      where: { id },
      select: { id: true, status: true, isLocked: true, documentNumber: true },
    });
    if (!snapshot) throw new NotFoundException(`Račun ${id} ne postoji.`);
    if (snapshot.status === "CANCELLED") {
      throw new ConflictException(`Račun ${id} je već storniran.`);
    }
    // D8: samo zaključan (proknjižen) dokument se stornira; draft se menja/briše normalno.
    if (!snapshot.isLocked || snapshot.status === "DRAFT") {
      throw new ConflictException(
        `Račun ${id} nije proknjižen (zaključan) — storno nije moguć.`,
      );
    }

    // Prošireni rokovi transakcije (isti obrazac kao `robno.service.ts` / `reservation`):
    // storno sada ČEKA advisory brave koje drži `applyAdvance`, pa bi Prisma default
    // (maxWait 2 s) pod kontencijom vratio P2028 „transaction not found" umesto da
    // sačeka svoj red. 20 s je gornja granica rada koji je ionako samo nekoliko upisa.
    const result = await this.prisma.$transaction(
      async (tx) => this.stornoWithin(tx, id, reason, actor),
      { maxWait: 10_000, timeout: 20_000 },
    );

    // ── POSLE COMMIT-a: spoljni sistemi ─────────────────────────────────────────
    // Ovo su jedini koraci koji u transakciju NE MOGU (rezervacije imaju svoju, SEF je
    // mrežni poziv). Zato su i jedini koji smeju da se dese posle nepovratnog storna —
    // i zato oba imaju svoju rutu sanacije, za razliku od primene avansa.
    await this.releaseReservations(id, result.documentNumber, reason, actor);
    const sef = await this.cancelSefOutbox(id, reason, actor);

    const stornoed = await this.prisma.invoice.findUnique({
      where: { id },
      include: {
        items: { orderBy: { lineNo: "asc" } },
        serviceRevenueType: SERVICE_REVENUE_TYPE_SELECT,
      },
    });
    if (!stornoed) throw new NotFoundException(`Račun ${id} ne postoji.`);
    return {
      ...stornoed,
      stornoEntryId: result.stornoEntryId,
      /** Prvi storno-nalog primene avansa (kompatibilnost sa 1:1 odgovorom). */
      advanceStornoEntryId: result.advanceStornoEntryId,
      /** Svi storno-nalozi primena avansa ovog računa (N:M). */
      advanceStornoEntryIds: result.advanceStornoEntryIds,
      sefCancelledOutboxIds: sef.cancelledOutboxIds,
      sefCancelledPendingIds: sef.cancelledPendingIds,
    };
  }

  /**
   * Baza-deo storna — CEO u pozivaočevoj transakciji (v. obrazloženje uz `stornoInvoice`).
   * Svaki `throw` odavde vraća dokument u proknjiženo stanje: nema polustorniranog računa.
   */
  private async stornoWithin(
    tx: Prisma.TransactionClient,
    id: number,
    reason: string,
    actor: AuthUser,
  ) {
    /**
     * BRAVE PRE ČITANJA — ISTE KOJE DRŽI `applyAdvance`.
     * =========================================================================
     *
     * ⚠️ IZMERENA TRKA (dev baza): dok sesija B drži otvorenu transakciju sa INSERT-om
     * primene avansa, `UPDATE invoices SET status='CANCELLED'` sesije A prolazi za
     * **93 ms** — `FOR NO KEY UPDATE` (Prisma update) se ne sudara sa `FOR KEY SHARE`
     * (FK provera INSERT-a). A zato vidi 0 primena, B posle komituje, i ostaje
     * stornirana faktura sa ACTIVE primenom od 3.000 i NEREVERZIRANIM nalogom
     * zatvaranja — izlazni PDV umanjen 500 din bez osnova.
     *
     * Redosled je OBAVEZNO račun (4003) → avans (4004), isti kao u `applyAdvance`:
     * obrnut redosled u dve sesije daje mrtvu petlju. Avansi se zaključavaju rastuće
     * po id-u, da se ni dva paralelna storna ne ukrste.
     */
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADVISORY_NS_APPLY_ON_INVOICE}::int, ${id}::int)`;

    const invoice = await tx.invoice.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        isLocked: true,
        journalEntryId: true,
        note: true,
        documentNumber: true,
        documentType: true,
        advanceClosingEntryId: true,
        // Zatečena 1:1 veza nema ni red u spojnoj tabeli ni nalog zatvaranja —
        // jedini trag joj je ova kolona, pa se mora pročitati da bi se očistila.
        advanceInvoiceId: true,
      },
    });
    if (!invoice) throw new NotFoundException(`Račun ${id} ne postoji.`);
    if (invoice.status === "CANCELLED") {
      throw new ConflictException(`Račun ${id} je već storniran.`);
    }
    // D8: samo zaključan (proknjižen) dokument se stornira; draft se menja/briše normalno.
    if (!invoice.isLocked || invoice.status === "DRAFT") {
      throw new ConflictException(
        `Račun ${id} nije proknjižen (zaključan) — storno nije moguć.`,
      );
    }

    // ── PRIMENE AVANSA (N:M od migracije 20260726120000) ───────────────────────
    //     `applyAdvance` po SVAKOJ primeni knjiži zaseban nalog (4300 DUG / PDV DUG /
    //     kupac POT) koji NIJE `invoice.journalEntryId`. Bez njihovog storna
    //     poništenje računa ostavlja obavezu po primljenom avansu i PDV po avansu
    //     zatvorene — iako je avans naplaćen i novac je u kasi.
    //
    //     Čita se ODMAH (pre svake 4004 brave) jer se iz njega izvodi SPISAK avansa koje
    //     treba zaključati — a brave 4004 moraju sve da se uzmu odjednom, rastuće. Za
    //     ovaj upit je dovoljna brava 4003 koju već držimo: `applyAdvance` je uzima prvu,
    //     pa nova primena na OVOM računu ne može da nastane dok smo mi unutra.
    const applications = await tx.invoiceAdvanceApplication.findMany({
      where: { invoiceId: id, status: APPLICATION_ACTIVE },
      orderBy: { id: "asc" },
      select: { id: true, advanceInvoiceId: true, closingEntryId: true },
    });

    /**
     * BRAVE STRANE AVANSA (4004) — SVE ODJEDNOM, RASTUĆE PO ID-u.
     *
     * Zaključava se svaki avans koji ovaj storno dodiruje:
     *   • sam dokument, kad je on AVR (inače `applyAdvance` može da ubaci primenu baš
     *     njega dok guard ispod broji primene, pa bi storno prošao „bez primena");
     *   • avans svake aktivne primene (nalog zatvaranja se reverzira);
     *   • avans ZATEČENE 1:1 veze (`advance_invoice_id`) — kolonu čistimo, a
     *     `applyAdvance` za DRUGI račun tu istu kolonu čita kroz
     *     `loadAdvanceLinkedInvoices` da bi izračunao preostatak avansa.
     *
     * Rastući redosled je obavezan da se dva paralelna storna ne ukrste, a 4003 pre
     * 4004 da se ne ukrste storno i `applyAdvance`.
     */
    const advanceLockIds = [
      ...new Set(
        [
          invoice.documentType === "AVR" ? id : null,
          ...applications.map((a) => a.advanceInvoiceId),
          invoice.advanceInvoiceId,
        ].filter((advId): advId is number => advId != null),
      ),
    ].sort((a, b) => a - b);
    for (const advanceId of advanceLockIds) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADVISORY_NS_APPLY_OF_ADVANCE}::int, ${advanceId}::int)`;
    }

    // AVANS koji je već odbijen na nestorniranom računu se NE stornira: njegov
    // nalog naplate je već zatvoren nalogom odbijanja, pa bi drugi storno umanjio
    // PDV obavezu drugi put, a konačni račun bi i dalje prikazivao umanjenje za
    // storniran avans (review Batch C, nalaz 2). Prvo se stornira konačni račun.
    if (invoice.documentType === "AVR") {
      // N:M: avans može biti primenjen na VIŠE računa — svaki od njih blokira storno.
      const appliedOn = await tx.invoiceAdvanceApplication.findMany({
        where: { advanceInvoiceId: id, status: APPLICATION_ACTIVE },
        select: { invoice: { select: { documentNumber: true, status: true } } },
      });
      const blocking = appliedOn
        .filter((a) => a.invoice.status !== "CANCELLED")
        .map((a) => a.invoice.documentNumber);

      // ⚠️ ZATEČENA 1:1 VEZA BLOKIRA ISTO KAO PRIMENA (ispravka 02.08.2026).
      // Gornji upit vidi SAMO redove spojne tabele, a odbitak može da živi i u
      // kolonama `invoices.advance_invoice_id` + `advance_applied_amount` BEZ svog
      // reda (dokumenti knjiženi pre migracije 20260726120000, uvoz BigBit istorije,
      // ručna ispravka u bazi; ruta `POST /pdv/advances/link-final` je od Batch C
      // revizije zatvorena, pa nove ne pravi). Za takav račun je gornji spisak prazan, pa
      // je storno AVR-a prolazio — a konačni račun je i dalje ŠTAMPAO „Umanjenje za
      // primljeni avans (br. A-1/26): −3.000", slao `PrepaidAmount` 3.000 i
      // `BillingReference` na STORNIRAN poreski dokument, i kupcu prikazivao 3.000
      // manje za uplatu. Komentar iznad („prvo se stornira konačni račun") je taj
      // scenario opisivao, ali ga brana nije pokrivala.
      //
      // Meri se ISTIM pravilom kojim se iznos ispisuje na papir („kolona − Σ primena
      // tog računa", `./advance-deduction`): blokira tačno ono što se negde odbija.
      // Račun kome primene pokriju celu kolonu ovde ne daje red — njega već blokira
      // gornji spisak. Stornirani računi otpadaju u `loadAdvanceLinkedInvoices`.
      const legacyUsage = computeAdvanceUsage({
        advanceInvoiceId: id,
        // Primene su gore već obrađene; ovde se traže SAMO zatečene veze.
        applicationsOfAdvance: [],
        linkedInvoices: await loadAdvanceLinkedInvoices(tx, [id]),
      });
      for (const line of legacyUsage.lines) {
        blocking.push(line.invoiceDocumentNumber ?? `#${line.invoiceId}`);
      }

      if (blocking.length) {
        throw new ConflictException(
          `Avansni račun ${invoice.documentNumber} je odbijen na računu/ima primene na: ` +
            `${blocking.join(", ")} — prvo storniraj te račune, pa onda avans.`,
        );
      }
    }

    // Rezerva za dokumente knjižene pre N:M migracije (veza samo u koloni).
    const toReverse: Array<{
      id: number | null;
      closingEntryId: number | null;
    }> =
      applications.length === 0 && invoice.advanceClosingEntryId != null
        ? [{ id: null, closingEntryId: invoice.advanceClosingEntryId }]
        : applications;

    /**
     * REVERZIBILNOST SVIH NALOGA — PRE CAS-a, ODJEDNOM.
     * =========================================================================
     *
     * Transakcija bi i bez ove provere sve vratila (svaki `throw` ispod ruši i CAS), pa
     * ovo NIJE brana atomičnosti nego brana ISKORISTIVOSTI: zaključan nalog je jedini
     * čest uzrok pada, a operater mora da vidi SVE naloge koje treba da otključa — ne
     * prvi pa opet prvi. Bez ovoga se storno računa sa tri primene odbija tri puta
     * zaredom, svaki put uz jedno ime.
     *
     * DRAFT i već storniran nalog se preskaču (isto pravilo kao dosad): nacrt se ne
     * stornira nego briše, a već reverziran nalog nema šta da doda.
     */
    const candidateEntryIds = [
      invoice.journalEntryId,
      ...toReverse.map((a) => a.closingEntryId),
    ].filter((entryId): entryId is number => entryId != null);
    const entries =
      candidateEntryIds.length === 0
        ? []
        : await tx.journalEntry.findMany({
            where: { id: { in: candidateEntryIds } },
            select: {
              id: true,
              number: true,
              status: true,
              reversedByEntryId: true,
            },
          });
    const locked = entries.filter((e) => e.status === "LOCKED");
    if (locked.length > 0) {
      throw new ConflictException(
        `Račun ${invoice.documentNumber} se ne može stornirati: ` +
          `${locked.length === 1 ? "nalog" : "nalozi"} glavne knjige ` +
          `${locked.map((e) => `${e.number} (#${e.id})`).join(", ")} ` +
          `${locked.length === 1 ? "je zaključan" : "su zaključani"} — storno mimo ` +
          `otključavanja bi zaobišao kontrolu zaključanog perioda. Otključaj ` +
          `${locked.length === 1 ? "ga" : "ih"} u Glavnoj knjizi (nalog → Otključaj), ` +
          `pa ponovi storno.`,
      );
    }
    const reversible = new Map(entries.map((e) => [e.id, e]));

    // CAS claim — snapshot status + isLocked → CANCELLED (ekskluzivno). Dopiši razlog.
    // Isti obrazac kao postInvoice: updateMany je JEDINI izvor ekskluzivnosti; dva
    // paralelna storna → samo jedan dobije count 1, drugi 409. (Brava iznad ih ionako
    // serijalizuje; CAS ostaje kao brana i za pisače koji bravu ne uzimaju.)
    const claimed = await tx.invoice.updateMany({
      where: { id, status: invoice.status, isLocked: true },
      data: {
        status: "CANCELLED",
        note: appendStornoNote(invoice.note, reason),
        updatedByUserId: actor.userId,
      },
    });
    if (claimed.count !== 1) {
      throw new ConflictException(
        `Račun ${id} je već storniran ili se trenutno stornira.`,
      );
    }

    // Reverzija izvornog naloga (ako postoji i nije nacrt / već storniran).
    let stornoEntryId: number | null = null;
    if (invoice.journalEntryId != null) {
      const entry = reversible.get(invoice.journalEntryId);
      if (
        entry &&
        entry.status !== "DRAFT" &&
        entry.reversedByEntryId == null
      ) {
        const rev = await this.glWrite.reverseWithin(
          tx,
          entry.id,
          actor.userId,
        );
        stornoEntryId = rev.stornoEntryId;
      }
    }

    // Reverzija naloga zatvaranja avansa + primene → REVERSED (time se iznosi
    // OSLOBAĐAJU: avans se odmah može ponovo iskoristiti).
    const advanceStornoEntryIds: number[] = [];
    let advanceStornoEntryId: number | null = null;
    for (const application of toReverse) {
      let reversalEntryId: number | null = null;
      if (application.closingEntryId != null) {
        const advEntry = reversible.get(application.closingEntryId);
        if (
          advEntry &&
          advEntry.status !== "DRAFT" &&
          advEntry.reversedByEntryId == null
        ) {
          const rev = await this.glWrite.reverseWithin(
            tx,
            advEntry.id,
            actor.userId,
          );
          reversalEntryId = rev.stornoEntryId;
          advanceStornoEntryIds.push(rev.stornoEntryId);
          advanceStornoEntryId ??= rev.stornoEntryId;
        }
      }
      if (application.id != null) {
        await tx.invoiceAdvanceApplication.update({
          where: { id: application.id },
          data: {
            status: APPLICATION_REVERSED,
            reversalEntryId,
            reversedAt: new Date(),
          },
        });
      }
    }

    // Kolone se čiste i kad NEMA šta da se reverzira: zatečena 1:1 veza nema ni red u
    // spojnoj tabeli ni nalog zatvaranja, pa je `toReverse` za nju prazan i kolone su
    // ostajale na storniranom računu ZAUVEK. Posledica nije kozmetička: `link-final`
    // (i budući uvoznik) po toj koloni zaključuju „avans je već iskorišćen", pa se AVR
    // posle storna svog jedinog računa nije mogao odbiti nigde — ćorsokak bez izlaza
    // kroz aplikaciju. Storniran račun ništa ne duguje i ništa ne odbija.
    if (toReverse.length > 0 || invoice.advanceInvoiceId != null) {
      await tx.invoice.update({
        where: { id },
        data: {
          advanceInvoiceId: null,
          advanceAppliedAmount: new D(0),
          advanceClosingEntryId: null,
        },
      });
    }

    return {
      documentNumber: invoice.documentNumber,
      stornoEntryId,
      advanceStornoEntryId,
      advanceStornoEntryIds,
    };
  }

  /**
   * REZERVACIJE ZALIHA (Batch C). Storniran dokument više ništa ne obećava kupcu —
   * rezervacije registrovane na NJEGA se oslobađaju i roba se vraća u raspoloživo. Bez
   * ovoga bi rezervacija storniranog predračuna večno držala zalihu (nema FK ka
   * `invoices`, pa ni kaskade).
   *
   * Van transakcije storna je NAMERNO: `ReservationService.release` otvara svoju, a
   * neuspeh ne sme da obori već izvršen (commit-ovan) storno — loguje se, dokument
   * ostaje CANCELLED, sanacija ide kroz /robno/rezervacije.
   */
  private async releaseReservations(
    id: number,
    documentNumber: string,
    reason: string,
    actor: AuthUser,
  ): Promise<void> {
    await this.reservation
      .release(
        {
          sourceType: "invoice",
          sourceId: id,
          reason: `storno dokumenta ${documentNumber}`,
        },
        actor.userId,
      )
      .catch((err: unknown) => {
        this.logger.warn(
          `Dokument ${documentNumber} je storniran, ali oslobađanje rezervacija ` +
            `nije uspelo — proveri /robno/rezervacije. Uzrok: ${String(err)}`,
        );
      });
  }

  /**
   * SEF OUTBOX POSLE STORNA — i sanacija reda koji je otišao U MEĐUVREMENU.
   * =============================================================================
   *
   *   (a) PENDING (kreiran ali NIKAD poslat) → lokalno CANCELLED, bez SEF poziva.
   *       PRVI je, jer je čist upis u bazu: posle njega red više nije „u redu za
   *       slanje". (Do 03.08.2026. je bio poslednji, pa bi pad mrežnog `cancel`-a
   *       ispod ostavio PENDING redove nedirnute.)
   *   (b) SENT/DELIVERED → SEF cancel API (guard MozeDaSeStornira, DRY-RUN bezbedno).
   *   (c) DRUGI PROLAZ — v. ispod.
   *
   * ⚠️ IZMEREN KVAR (02.08.2026, klijent kasni 300 ms): `send()` proveri da faktura nije
   * stornirana, pa ode na mrežu; storno se u međuvremenu ceo izvrši; `send()` se vrati i
   * upiše `SENT` + `sefInvoiceId` + `sentAt`. Ishod: faktura CANCELLED, outbox red #5
   * SENT, log „CANCELLED"→„SENT", a **SEF cancel nije poslat** — jer je petlja (b) videla
   * samo redove koji su SENT/DELIVERED U TRENUTKU storna. Kupac na portalu ima važeću
   * e-fakturu za dokument koji kod nas ne postoji.
   *
   * ZATO DRUGI PROLAZ: outbox se čita PONOVO, i svaki red koji je u međuvremenu postao
   * SENT/DELIVERED se otkazuje na SEF-u, uz ERROR u logu (to je stanje koje ne bi smelo
   * da nastane, pa mora da se vidi).
   *
   * 🔴 ŠTA OVO NE REŠAVA — i gde je pravi lek: prozor se sužava sa „trajanje mrežnog
   * poziva" na „razmak između našeg poslednjeg čitanja i tuđeg upisa", ali se ne zatvara.
   * Deterministički lek je USLOVAN upis u `send()` (`updateMany where { id, status:
   * 'PENDING' }` umesto bezuslovnog `update` — `sef.service.ts`, upis statusa SENT):
   * red koji je storno već prebacio u CANCELLED tada se ne može vratiti u SENT, pa se
   * pouzdano zna da dokument treba otkazati na portalu. Ta izmena je u `sales/sef/**`,
   * koji u ovom paketu menja drugi agent — zapisana je u
   * `backend/docs/PREOSTALE_FAZE.md`, odeljak „🔶 OTVORENO NA DAN 01.08.2026".
   *
   * ── SVAKI RED SE POKUŠA, PA SE GREŠKA PRIJAVI (nalaz N2-SEF, 03.08.2026) ──────
   * Od istog dana `SefService.cancel` BACA kad SEF ne potvrdi otkazivanje (red pada u
   * `CANCEL_PENDING`). Sa golim `await` u petlji to znači da prvi neuspeli red obara
   * ceo metod i ostali redovi TOG dokumenta se ne obrade — a faktura je već stornirana,
   * pa drugog prolaza kroz ovu putanju nema. Zato se svaki red pokušava zasebno, a
   * neuspesi se skupljaju i prijavljuju ZAJEDNO, na kraju: pozivalac i dalje vidi grešku
   * (semantika se ne menja), ali je poruka tačna — kaže da je račun storniran i imenuje
   * redove koje treba otkazati na portalu.
   */
  private async cancelSefOutbox(
    id: number,
    reason: string,
    actor: AuthUser,
  ): Promise<{ cancelledOutboxIds: number[]; cancelledPendingIds: number[] }> {
    const cancelledPendingIds = await this.sef.cancelPendingLocally(
      id,
      reason,
      actor.userId,
    );

    const cancelledOutboxIds: number[] = [];
    const failedOutboxIds: number[] = [];
    const isSent = (status: string) =>
      status === "SENT" || status === "DELIVERED";
    /** Već obrađen (uspešno ili ne) — drugi prolaz ga ne dira ponovo. */
    const handled = (rowId: number) =>
      cancelledOutboxIds.includes(rowId) || failedOutboxIds.includes(rowId);

    const cancelOne = async (rowId: number) => {
      try {
        await this.sef.cancel(rowId, reason);
        cancelledOutboxIds.push(rowId);
      } catch (err) {
        failedOutboxIds.push(rowId);
        this.logger.error(
          `STORNO: faktura ${id} je stornirana, ali otkazivanje SEF reda ${rowId} nije ` +
            `potvrđeno — e-faktura je kod kupca i dalje važeća dok se ne otkaže na ` +
            `portalu. Uzrok: ${err instanceof Error ? err.message : String(err)}`,
          err instanceof Error ? err.stack : undefined,
        );
      }
    };

    const outboxRows = await this.sef.listOutbox({ invoiceId: id, take: 200 });
    for (const row of outboxRows) {
      if (isSent(row.status)) await cancelOne(row.id);
    }

    // (c) DRUGI PROLAZ — red koji je otišao na SEF DOK je storno trajao.
    const afterRows = await this.sef.listOutbox({ invoiceId: id, take: 200 });
    for (const row of afterRows) {
      if (!isSent(row.status) || handled(row.id)) continue;
      this.logger.error(
        `SEF TRKA: outbox red ${row.id} fakture ${id} je postao ${row.status} DOK je ` +
          `storno trajao (slanje je počelo pre storna i završilo se posle njega) — ` +
          `otkazujem ga na SEF-u. Ako otkazivanje padne, dokument mora ručno da se ` +
          `stornira na portalu.`,
      );
      await cancelOne(row.id);
    }

    if (failedOutboxIds.length > 0) {
      throw new ConflictException(
        `Račun je storniran u knjigama, ali otkazivanje na SEF-u nije potvrđeno za ` +
          `${failedOutboxIds.length === 1 ? "red" : "redove"} ` +
          `${failedOutboxIds.join(", ")} — e-faktura je kod kupca i dalje važeća. ` +
          `Ponovi otkazivanje sa /sef ili je storniraj na portalu; sam račun se NE ` +
          `stornira ponovo (već jeste).`,
      );
    }

    return { cancelledOutboxIds, cancelledPendingIds };
  }

  /**
   * Kreditni limit kupca (BigBit paritet — Customer.creditLimit je sync polje).
   * Ako je limit > 0 i projektovani dug (otvorene receivable stavke partnera +
   * bruto ovog dokumenta) prelazi limit → UnprocessableEntity (422), OSIM ako je
   * pozvano sa force=true (svesno prekoračenje). Saldo = Σ(dug − potr) otvorenih
   * (posted, nereconciled) stavki na receivable saldakonto kontima za tog partnera
   * (isti izveden pogled kao OpenItemsService, direktan agregat da se izbegne
   * cross-modul import). Telo greške nosi structured polja (code/balance/limit) za FE.
   */
  private async assertCreditLimit(
    customerId: number,
    grossTotal: Prisma.Decimal,
    force: boolean,
  ): Promise<void> {
    if (force) return;

    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { creditLimit: true },
    });
    const limit = customer?.creditLimit ?? null;
    // Limit 0 / null = bez kontrole (kupac bez postavljenog kreditnog limita).
    if (limit == null || new D(limit).lessThanOrEqualTo(ZERO)) return;

    const rows = await this.prisma.$queryRaw<
      { balance: Prisma.Decimal | null }[]
    >(
      Prisma.sql`
        SELECT COALESCE(SUM(le.debit) - SUM(le.credit), 0) AS balance
        FROM ledger_entries le
        JOIN journal_entries je ON je.id = le.journal_entry_id
        JOIN saldakonto_accounts sa ON sa.account = le.account_code
        -- 'LOCKED' MORA biti uključen (smoke Batch A nalaz): auto-lock starih naloga bi
        -- inače IZBRISAO dug iz obračuna limita — kupac sa zaključanim dugovanjima bi
        -- prošao guard kao da duga nema.
        WHERE je.status IN ('POSTED', 'LOCKED')
          AND le.reconciled_at IS NULL
          AND sa.tracks_open_items = TRUE
          AND sa.side = 'receivable'
          -- Vrsta partnera, ne samo strana salda: dati avansi DOBAVLJAČIMA (1520/1521/1530)
          -- su takođe 'receivable'. Bez ovog filtera bi kooperantu koji je i kupac i
          -- dobavljač plaćen avans sužavao kreditni limit i obarao legitimnu fakturu
          -- sa CREDIT_LIMIT_EXCEEDED (revizija).
          AND sa.partner_scope = 'customer'
          AND le.analytical_code = ${customerId}
      `,
    );

    const balance = new D(rows[0]?.balance ?? 0);
    const projected = balance.add(grossTotal);
    const limitD = new D(limit);
    if (projected.greaterThan(limitD)) {
      throw new UnprocessableEntityException({
        code: "CREDIT_LIMIT_EXCEEDED",
        message:
          `Kreditni limit kupca je prekoračen: dug bi bio ${projected.toFixed(2)} ` +
          `(trenutni saldo ${balance.toFixed(2)} + dokument ${grossTotal.toFixed(2)}), ` +
          `a limit je ${limitD.toFixed(2)}. Za knjiženje uprkos limitu koristi opciju ` +
          `Proknjiži uprkos limitu.`,
        balance: balance.toFixed(2),
        amount: grossTotal.toFixed(2),
        projected: projected.toFixed(2),
        limit: limitD.toFixed(2),
      });
    }
  }

  /**
   * Ručni nalog GK za račun (IFUSL/uslužni ili bez robnog izlaza). Balans-kontrola.
   *   kupac (2040 / 2050 izvoz) DUG  = osnovica + Σ PDV po stopama
   *   prihod (6040 roba / 6140 usluga) POT = osnovica
   *   PDV 4702 (20%) / 4710 (10%) POT = PDV te stope   (izvoz: bez PDV)
   *
   * ⚠️ PDV PO STOPI, NE PO STAVCI (ispravka 02.08.2026): iznosi dolaze iz
   * `documentVatTotals` — `round2(osnovica_stope × stopa)` — istog računara koji puni
   * `netTotal`/`vatTotal` na zaglavlju. Do tada je knjižen `Σ vatAmount` po stavkama, pa
   * je GK umela da nosi PDV koji se od `invoice.vatTotal` razlikuje za paru (na 20 stavki
   * i do 0,05 din). Nalog bi i tada balansirao — jer se ista pogrešna suma pojavljuje i
   * na dugovnoj strani — ali bi kupčev dug odstupao od bruto iznosa fakture, a POPDV
   * osnovica izvedena iz PDV konta od osnovice na papiru.
   */
  private async postManualLedger(
    tx: Prisma.TransactionClient,
    invoice: {
      id: number;
      documentType: string;
      documentNumber: string;
      companyId: number;
      customerId: number | null;
      documentDate: Date;
      dueDate: Date | null;
      currency: string;
      isExport: boolean;
      workOrderId: number | null;
      /**
       * ⚠️ MORA DA STOJI U OVOM TIPU, iako ga pozivalac uvek prosleđuje kroz `issued`
       * (`{ ...fresh, documentNumber }`). Da ovde nije naveden, `buildSalesLedgerLines`
       * bi ga po tipu video kao `undefined` — pa bi TypeScript ćutao, a račun za otpad
       * dobio konto `6140` i obračunat PDV, iako je vrsta usluge izabrana i iako je
       * podatak u objektu stvarno prisutan. Tip je ovde jedina kontrola koja to hvata.
       */
      serviceRevenueType?: ServiceRevenueTypeRef | null;
    },
    year: number,
    actor: AuthUser,
    items?: Array<{
      vatRateCode: string;
      vatBase: Prisma.Decimal;
    }>,
  ): Promise<number> {
    const lines =
      items ??
      (await tx.invoiceItem.findMany({
        where: { invoiceId: invoice.id },
        select: { vatRateCode: true, vatBase: true },
      }));

    /**
     * NAZIV KUPCA ZA OPIS REDA — jedan `findUnique` po knjiženju (ne po redu).
     * Kupca koga u šifarniku nema (ili računa bez kupca) opis prosto ne pominje; knjiženje
     * se zbog toga NE obara — `ledgerDescription` tada vrati „vrsta + broj".
     */
    const customer =
      invoice.customerId != null
        ? await tx.customer.findUnique({
            where: { id: invoice.customerId },
            select: { name: true },
          })
        : null;

    const draftLines = buildSalesLedgerLines(
      { ...invoice, customerName: customer?.name ?? null },
      lines,
    );

    // Polja otvorene stavke (broj/dospeće/valuta) — jedno pravilo za obe grane knjiženja.
    const openItem = openItemFields(invoice);

    // Zaokruži liniju na skalu kolone `numeric(19,4)`, pa odbaci nula-redove — isti računar
    // kao robna grana (`finalizeLedgerLines`), da se dve grane ne raziđu. Balans se meri nad
    // ONIM ŠTO SE UPISUJE, ne nad punim Decimal vrednostima.
    const prepared = finalizeLedgerLines(draftLines, { dropZeroRows: true });

    // BALANS-KONTROLA: ΣDug == ΣPot.
    if (!prepared.balanced) {
      throw new UnprocessableEntityException(
        `Nalog ne balansira: ΣDug=${prepared.totalDebit.toFixed(4)} ≠ ΣPot=${prepared.totalCredit.toFixed(4)}.`,
      );
    }
    // Nalog bez ijedne stavke se ne upisuje (isti kvar kao na robnoj grani, v.
    // `posting.service.ts`): račun na nula dinara bi dobio broj, prešao u POSTED & LOCKED i
    // ostao bez ijednog reda u glavnoj knjizi — nevidljiv saldakontima, KIF-u i POPDV-u, a
    // nepromenjiv. `postInvoice` već odbija račun bez stavki; ovo hvata račun sa stavkama
    // čiji su svi iznosi nula.
    if (prepared.lines.length === 0) {
      throw new UnprocessableEntityException(
        `Račun ${invoice.documentNumber} ne daje nijednu stavku naloga (svi iznosi su nula), ` +
          `pa se ne može proknjižiti. Ispravi stavke računa, pa ponovi knjiženje.`,
      );
    }

    const number = await this.nextJournalNumber(
      tx,
      invoice.companyId,
      ORDER_TYPE_SALES,
      year,
    );

    const entry = await tx.journalEntry.create({
      data: {
        number,
        orderTypeCode: ORDER_TYPE_SALES,
        year,
        companyId: invoice.companyId,
        documentDate: invoice.documentDate,
        postingDate: new Date(),
        // POSTED (ne draft): proknjižena faktura MORA odmah biti vidljiva saldakontima /
        // kartici konta / bilansu / open-items, koji čitaju SAMO status IN ('POSTED','LOCKED').
        // Draft nalog = proknjižen račun bez ijedne
        // otvorene stavke (kupac tiho van saldakonta). Isti obrazac kao izvod (PR #8) i
        // PostingEngine.postManualEntry (posting.service.ts:229). Odluka O4 default.
        status: "POSTED",
        createdByUserId: actor.userId,
        lines: {
          create: prepared.lines.map((l) => ({
            accountCode: l.accountCode,
            analyticalCode: l.analyticalCode,
            debit: l.debit,
            credit: l.credit,
            description: l.description,
            // Broj / dospeće / valuta na SVAKI red — pravilo i podrazumevane vrednosti drži
            // `openItemFields` (deljeno sa robnom granom; v. §3.6a).
            ...openItem,
            sourceWorkOrderId: invoice.workOrderId ?? null,
          })),
        },
      },
      select: { id: true },
    });

    return entry.id;
  }

  /**
   * Numeracija naloga: 1 + MAX po (company, vrsta, godina), zero-pad 4.
   * pg_advisory_xact_lock da paralelni post ne dobiju isti broj (obrazac iz posting.service).
   */
  private async nextJournalNumber(
    tx: Prisma.TransactionClient,
    companyId: number,
    orderType: string,
    year: number,
  ): Promise<string> {
    const lockKey = `${companyId}:${orderType}:${year}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
    // Numerički MAX u JS-u (obrazac stock-document-numbering) — string orderBy je
    // leksikografski pa je '10000' < '9999' i brojač bi se zaglavio posle 9999.
    const rows = await tx.journalEntry.findMany({
      where: { companyId, orderTypeCode: orderType, year },
      select: { number: true },
    });
    let maxSeq = 0;
    for (const r of rows) {
      const n = Number.parseInt(r.number, 10);
      if (!Number.isNaN(n) && n > maxSeq) maxSeq = n;
    }
    return String(maxSeq + 1).padStart(4, "0");
  }
}
