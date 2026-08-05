/**
 * DOKAZ — ČETIRI OBRASCA IZLAZNE FAKTURE IZ NAŠEG KODA.
 * ============================================================================
 * Vlasnik je doneo pet BigBit papira (`docs/zahtevi/fakture-obrasci-2026-08/`) i
 * pita da li naša štampa liči na njih. Ovo je odgovor koji se GLEDA, a ne čita:
 * za svaki od četiri obrasca napravi se STVARAN PDF kroz `InvoicePdfService`, sa
 * podacima DOSLOVNO prepisanim sa papira, pa se dva fajla otvore jedan pored drugog.
 *
 * ⚠️ NIŠTA SE NE POPRAVLJA DA BI SE POKLOPILO. Ako se naš izlaz razlikuje od papira,
 * to je NALAZ (v. spisak razlika ispod), a ne razlog da se šablon krpi. Šabloni su
 * izvor istine o tome šta kod danas radi; ovaj fajl samo pokazuje šta iz njih izađe.
 *
 * BEZ BAZE I BEZ MREŽE: `PrismaService` je lažni objekat sa tačno onim metodama koje
 * štampa zove (isti obrazac kao `invoice-pdf.service.spec.ts`, `makePrisma`), pa se
 * skripta pokreće bilo gde, bez `DATABASE_URL`:
 *
 *   npx ts-node -T scripts/proof-obrasci-faktura.ts
 *
 * ⚠️ BEZ `--compiler-options '{"module":"commonjs"}'`: `tsconfig.json` ovog backend-a je
 * `module`/`moduleResolution` = `nodenext` uz `resolvePackageJsonExports`, pa svako
 * ručno spuštanje na `commonjs` obara `tsc` (TS5110, pa TS5098). Zadati tsconfig već
 * emituje CJS — isti poziv koriste i ostale `proof-*` skripte.
 *
 * Izlaz: `backend/reports/obrasci-2026-08/` (gitignored) — četiri PDF-a plus ispis
 * broja strana i bajtova, da se prazan papir ne provuče kao „radi".
 *
 * ── ODAKLE PODACI ───────────────────────────────────────────────────────────
 * Sve vrednosti su prepisane sa donetih papira (brojevi računa, kupci, datumi,
 * stavke, iznosi), pa se svaki broj na našem PDF-u može tražiti na originalu i
 * obrnuto. Firma i memorandum su NAŠI STVARNI podaci sa istog papira, ne izmišljeni:
 * pogrešan PIB ili adresa u dokazu bi značili da se poređenje ne može verovati.
 *
 * ── ŠTA SE NAMERNO RAZLIKUJE OD PAPIRA (odluke O-F1…O-F10 + zakonski nalazi) ──
 *  • `Br. l.k.` sa IFUSL-a se NE štampa (O-F3) — ni broj ni prazna linija sa natpisom;
 *  • matični broj u bloku „Preuzeo za prevoz" je NAŠ `17400169`; BigBit tu štampa
 *    KUPČEV `20748346` (odluka O-F8, 03.08.2026 — presuđeno, više nije otvoreno);
 *  • ime firme je JEDAN oblik iz baze, `Servoteh d.o.o.`; papir u potpisnom bloku piše
 *    „SERVOTEH doo", a u memorandumu „Servoteh d.o.o. Dobanovci" (O-F9);
 *  • kolona `C E N A` / `Price` nosi cenu PRE rabata (na donetim papirima je rabat 0,
 *    pa se razlika ne vidi — struktura je ipak drugačija);
 *  • ino roba dobija red `Date of delivery:` kog na 228/25 nema (datum prometa je
 *    obavezan element računa);
 *  • blok „reklamacije/sud/kamata" se na 228/25 štampa DVAPUT — mi ga štampamo jednom;
 *  • `www.BigBit.rs` iz podnožja ino usluge se ne prepisuje (tuđ vodeni žig).
 */
import { Prisma } from "@prisma/client";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PDFDocument } from "pdf-lib";
import { BarcodeService } from "../src/modules/documents/barcode.service";
import { PdfService } from "../src/modules/documents/pdf.service";
import { InvoicePdfService } from "../src/modules/sales/print/invoice-pdf.service";
import type { PrismaService } from "../src/prisma/prisma.service";

/*
 * Lažni redovi baze su namerno `any`: oni oponašaju Prisma modele sa desetinama kolona
 * koje štampa i ne čita, pa bi puni tipovi tražili izmišljanje podataka kojih na papiru
 * nema. Provera je u tome što skripta prolazi kroz PRAVI servis — ne u tipovima ovde.
 */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-argument */

const OUT_DIR = process.env.PROOF_OUT ?? "reports/obrasci-2026-08";

/** Kratko ime za `Prisma.Decimal` — novac i količine nikad ne prolaze kroz `number`. */
const D = (v: string | number): Prisma.Decimal => new Prisma.Decimal(v);

// ─────────────────────────────────────────────────── FIRMA (memorandum sa papira)

/**
 * Naši stvarni podaci, prepisani sa memoranduma donetih faktura.
 *
 * ⚠️ TRI ZASEBNA PODATKA, NE JEDAN STRING (odluke O-F9 i O-F10, 03.08.2026):
 * `companyName` je goli naziv „Servoteh d.o.o.", `city` je „Dobanovci", `postalCode` je
 * „11272". Gornju traku papira („Servoteh d.o.o. Dobanovci  Ugrinovačka 163, 11272
 * Dobanovci") memorandum slaže sam, a potpisni blok i adresa magacina uzimaju samo ono
 * što im na papiru i stoji — bez poštanskog broja. Dok je sve bilo u dva polja, papir je
 * nosio DVA oblika istog imena („Servoteh d.o.o. Dobanovci" i „SERVOTEH doo") i poštanski
 * broj na mestima na kojima ga original nema.
 */
const COMPANY = {
  companyName: "Servoteh d.o.o.",
  address: "Ugrinovačka 163",
  city: "Dobanovci",
  postalCode: "11272",
  taxId: "101017443",
  registrationNumber: "17400169",
  bankAccount: "160-110610-83",
  // Dva broja u jednom polju — na papiru stoji „tel: +381 11 31 41 564; 373 29 59;".
  phone: "+381 11 31 41 564; 373 29 59",
  fax: "+381 11 2399 265",
  email: "office@servoteh.rs",
  webAddress: "www.servoteh.rs",
  invoiceIssuingPlace: "Beograd",
  registryNumber: "01117400169",
  businessActivityCode: "3320",
  aprText:
    '"Servoteh" d.o.o. je jednočlano privredno društvo upisano u Agenciji za privredne registre pod brojem BD. 222785/2006',
  // Rezervni izvor bankarskih instrukcija; ovde je prazan jer devizni račun postoji.
  iban: null,
  swift: null,
};

/** Devizni račun sa bloka banke ino faktura (228/25, strana 3 od 060/26). */
const EUR_ACCOUNT = {
  iban: "RS35160005010003501186",
  swift: "DBDBRSBG",
  bankName: "Banca Intesa a.d.",
  bankAddress: "Milentija Popovića 7b, 11070 New Belgrade\nRepublic of Serbia",
  currency: "EUR",
  isDefault: true,
  sortOrder: 0,
};

// ───────────────────────────────────────────────────────────────────── KUPCI

/** IFR 657/25 i IFUSL 653/25 — isti kupac. */
const HAP_FLUID = {
  name: "HAP FLUID D.O.O.",
  address: "Ugrinovačka 163",
  city: "Dobanovci",
  postalCode: "11272",
  country: "Srbija",
  taxId: "107136558",
  registrationNumber: "20748346",
};

/** IZVGP 228/25 — „Podgradačka broj 11 - Bratunac 75420". */
const TEHNICKI_REMONT = {
  name: "TEHNIČKI REMONT a.d. Bratunac",
  address: "Podgradačka broj 11",
  city: "Bratunac",
  postalCode: "75420",
  country: "Bosna i Hercegovina",
  taxId: null,
  registrationNumber: null,
};

/** IZVUS 060/26 — „Jovana Cvijića 3 - Laktaši,Bosna i Hercegovina 78250". */
const HIDRAULIKA_FLEX = {
  name: "Hidraulika Flex d.o.o.",
  address: "Jovana Cvijića 3",
  city: "Laktaši",
  postalCode: "78250",
  country: "Bosna i Hercegovina",
  taxId: null,
  registrationNumber: null,
};

// ─────────────────────────────────────────────────────────── ARTIKLI I MAGACINI

/**
 * Šifarnik artikala — samo redovi koje doneti papiri pominju.
 * `customsTariff` je svuda `null`: kolona `Stat. goods No.` je na 228/25 prazna.
 */
const ITEM_MASTERS: Record<number, any> = {
  100: {
    id: 100,
    name: "INSERT HME 212",
    foreignName: null,
    unit: "Kom",
    catalogNumber: "TO.44140391",
    customsTariff: null,
  },
  101: {
    id: 101,
    name: "TO.4407009",
    foreignName: null,
    unit: "Kom",
    catalogNumber: "TO.44070090",
    customsTariff: null,
  },
  200: {
    id: 200,
    name: "5326557 LL3-TV77",
    foreignName: null,
    unit: "Kom",
    catalogNumber: "5326557-",
    customsTariff: null,
  },
  201: {
    id: 201,
    name: "6063335 Sick GLL170-P334",
    foreignName: null,
    unit: "Kom",
    catalogNumber: "6063335-",
    customsTariff: null,
  },
};

const WAREHOUSES: Record<number, string> = { 3: "Magacin robe" };

/** Podrazumevani magacin po vrsti dokumenta — traži se kad račun nema svoj. */
const DEFAULT_WAREHOUSE_BY_TYPE: Record<string, number> = { IFR: 3, IFGP: 5 };

/** Komercijalisti sa papira (odluka O-F2: ime prati dokument, ne firmu). */
const SALESPERSONS: Record<number, { name: string; firstName: string }> = {
  7: { name: "Korkut", firstName: "Dragana" },
  8: { name: "Golubović", firstName: "Ana" },
};

// ──────────────────────────────────────────────────────────── LAŽNI PRISMA KLIJENT

/** Podaci jednog dokaza; sve što lažni klijent ume da vrati. */
interface ProofCase {
  /** Ime izlaznog fajla, npr. `IFR-657-25.pdf`. */
  fileName: string;
  /** Original sa kojim se poredi — samo za ispis u konzoli. */
  original: string;
  invoice: any;
  customer: any;
  /** Devizni računi firme; domaći dokumenti ih ne koriste. */
  paymentAccounts: any[];
}

/**
 * Lažni Prisma klijent — TAČNO one metode koje štampa zove, ništa više.
 *
 * ⚠️ `taxRate` NAMERNO NEDOSTAJE: stopa PDV-a se od nalaza S2 čita iz mape u kodu
 * (`VAT_RATE_BY_CODE`), a ne iz tabele `tax_rates` (koja na produkciji ima 0 redova).
 * Ako bilo ko vrati čitanje iz baze, dokaz pukne umesto da tiho odštampa „0%".
 */
function makePrisma(c: ProofCase) {
  return {
    invoice: {
      findUnique: (args: { where: { id: number } }) =>
        Promise.resolve(args.where.id === c.invoice.id ? c.invoice : null),
    },
    // Nijedan doneti papir nema odbijen avans, pa je spojna tabela prazna.
    invoiceAdvanceApplication: { findMany: () => Promise.resolve([]) },
    customer: { findUnique: () => Promise.resolve(c.customer) },
    company: { findUnique: () => Promise.resolve(COMPANY) },
    paymentAccount: { findMany: () => Promise.resolve(c.paymentAccounts) },
    item: {
      findMany: (args: { where: { id: { in: number[] } } }) =>
        Promise.resolve(
          args.where.id.in.map((id) => ITEM_MASTERS[id]).filter(Boolean),
        ),
    },
    salesperson: {
      findUnique: (args: { where: { id: number } }) =>
        Promise.resolve(SALESPERSONS[args.where.id] ?? null),
    },
    documentType: {
      findUnique: (args: { where: { code: string } }) =>
        Promise.resolve({
          defaultWarehouseId: DEFAULT_WAREHOUSE_BY_TYPE[args.where.code] ?? 0,
        }),
    },
    warehouse: {
      findUnique: (args: { where: { id: number } }) =>
        Promise.resolve(
          WAREHOUSES[args.where.id]
            ? { name: WAREHOUSES[args.where.id] }
            : null,
        ),
    },
  };
}

// ───────────────────────────────────────────────────────── pomoćnici za podatke

/** Zajedničko jezgro računa; svaki dokaz ga dopunjava svojim poljima. */
function invoiceBase(over: Record<string, unknown>): any {
  return {
    id: 1,
    level: 0,
    companyId: 1,
    status: "POSTED",
    currency: "RSD",
    isExport: false,
    note: null,
    salespersonId: null,
    warehouseId: null,
    priceCoefficient: D(1),
    advanceInvoiceId: null,
    advanceAppliedAmount: D(0),
    fco: null,
    paymentMethod: null,
    shipmentMethod: null,
    customsDeclarationNo: null,
    deliveryTerm: null,
    packageDescription: null,
    packageDimensions: null,
    grossWeightKg: null,
    netWeightKg: null,
    unloadingPlace: null,
    forwarderContact: null,
    copiedFromDocId: null,
    linkedInvoiceDocId: null,
    ...over,
  };
}

/**
 * Jedna stavka računa.
 *
 * ⚠️ `vatBase` (bez PDV-a) je ono što ide u kolonu VREDNOST / I Z N O S / Total, dok
 * `lineTotal` u bazi nosi osnovicu + PDV (`pricing.service.ts`). Oba se ovde upisuju
 * tačno tako, da se zamena vidi ako je neko ikad napravi.
 */
function makeItem(
  lineNo: number,
  over: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: lineNo,
    invoiceId: 1,
    lineNo,
    itemId: null,
    description: null,
    unit: null,
    discountPercent: D(0),
    cashDiscountPercent: D(0),
    vatRateCode: "3",
    copiedFromItemId: null,
    ...over,
  };
}

/** Domaća stavka: osnovica i PDV se izvode iz količine i cene, kao u knjiženju. */
function domesticLine(
  lineNo: number,
  o: {
    itemId?: number | null;
    description?: string | null;
    unit?: string | null;
    quantity: string;
    unitPrice: string;
    vatBase: string;
    vatAmount: string;
  },
): Record<string, unknown> {
  return makeItem(lineNo, {
    itemId: o.itemId ?? null,
    description: o.description ?? null,
    unit: o.unit ?? null,
    quantity: D(o.quantity),
    unitPrice: D(o.unitPrice),
    // Bez rabata je puna cena ista kao cena stavke — kolona `R%` na papiru je svuda 0.
    unitPriceBeforeDiscount: D(o.unitPrice),
    vatRateCode: "3",
    vatBase: D(o.vatBase),
    vatAmount: D(o.vatAmount),
    lineTotal: D(o.vatBase).add(D(o.vatAmount)),
  });
}

/** Izvozna stavka: poreska šifra „0" (van PDV-a), porez svuda nula. */
function exportLine(
  lineNo: number,
  o: {
    itemId?: number | null;
    description?: string | null;
    unit: string;
    quantity: string;
    unitPrice: string;
    total: string;
  },
): Record<string, unknown> {
  return makeItem(lineNo, {
    itemId: o.itemId ?? null,
    description: o.description ?? null,
    unit: o.unit,
    quantity: D(o.quantity),
    unitPrice: D(o.unitPrice),
    unitPriceBeforeDiscount: D(o.unitPrice),
    vatRateCode: "0",
    vatBase: D(o.total),
    vatAmount: D(0),
    lineTotal: D(o.total),
  });
}

// ═══════════════════════════════════════════════════ ČETIRI DOKAZA (sa papira)

/**
 * 1) IFR 657/25 — domaća faktura za ROBU (`docs/zahtevi/…/IFR.pdf`).
 *
 * Zbir sa papira: 99.363,64 + 20 % = 19.872,73 → za uplatu 119.236,37.
 * Osnovice stavki (80.497,70 + 18.865,94) daju baš 99.363,64, pa se kontrolni red
 * „NEUSKLAĐENO" ne pali — zaglavlje i stavke govore isto.
 */
const IFR: ProofCase = {
  fileName: "IFR-657-25.pdf",
  original: "IFR.pdf",
  customer: HAP_FLUID,
  paymentAccounts: [],
  invoice: invoiceBase({
    documentType: "IFR",
    documentNumber: "657/25",
    customerId: 10,
    salespersonId: 7, // Dragana Korkut
    warehouseId: 3, // Magacin robe
    documentDate: new Date(2025, 11, 25),
    dueDate: new Date(2025, 11, 25), // „Valuta za plaćanje: 25-12-25"
    supplyDate: new Date(2025, 11, 25), // „Datum prometa dobara"
    // Traka uslova, doslovno sa papira.
    fco: "magacin kupca",
    paymentMethod: "virmanom",
    shipmentMethod: "lično",
    netTotal: D("99363.64"),
    vatTotal: D("19872.73"),
    grossTotal: D("119236.37"),
    items: [
      domesticLine(1, {
        itemId: 100, // TO.44140391 · INSERT HME 212
        quantity: "5",
        unitPrice: "16099.54",
        vatBase: "80497.70",
        vatAmount: "16099.54",
      }),
      domesticLine(2, {
        itemId: 101, // TO.44070090 · TO.4407009
        quantity: "2",
        unitPrice: "9432.97",
        vatBase: "18865.94",
        vatAmount: "3773.19",
      }),
    ],
  }),
};

/**
 * 2) IFUSL 653/25 — domaća faktura za USLUGU (`docs/zahtevi/…/IFUSL.pdf`).
 *
 * Stavka je SLOBODNA (bez artikla): zakup poslovnog prostora nema red u šifarniku,
 * pa opis i j.m. dolaze sa same stavke — obrazac usluge kolonu „Kat. br." ni nema.
 */
const IFUSL: ProofCase = {
  fileName: "IFUSL-653-25.pdf",
  original: "IFUSL.pdf",
  customer: HAP_FLUID,
  paymentAccounts: [],
  invoice: invoiceBase({
    documentType: "IFUSL",
    documentNumber: "653/25",
    customerId: 10,
    salespersonId: 8, // Ana Golubović
    documentDate: new Date(2025, 11, 24),
    dueDate: new Date(2025, 11, 24), // „Rok za plaćanje: 24-12-25"
    supplyDate: new Date(2025, 11, 24), // „Datum prometa: 24-12-25"
    netTotal: D("16000.00"),
    vatTotal: D("3200.00"),
    grossTotal: D("19200.00"),
    items: [
      domesticLine(1, {
        description: "Zakup poslovnog prostora za Decembar 2025.",
        unit: "kom",
        quantity: "1",
        unitPrice: "16000.00",
        vatBase: "16000.00",
        vatAmount: "3200.00",
      }),
    ],
  }),
};

/**
 * 3) IZVGP 228/25 — izvozna faktura za ROBU, EUR (`docs/zahtevi/…/InoFaktura GP 228-25.pdf`).
 *
 * `note` nosi poziv na ponudu (namenskog polja nema — GAP §3 t.14), a
 * `customsDeclarationNo` broj izvozne deklaracije; oba izlaze ispod zbira.
 *
 * ⚠️ `supplyDate` je popunjen iako ga papir NEMA: datum prometa je obavezan element
 * računa i naš obrazac ga štampa kao `Date of delivery:`. To je svesno odstupanje.
 *
 * ⚠️ Red „Način plaćanja: avansno" sa papira se NE može proizvesti: BigBit je imao
 * dve kolone (`payment_terms` „virmanom" + `payment_method` „avansno"), 4.0 ima jedno
 * polje, a odluka je da ostaje samo gornji `Payment terms:`.
 */
const IZVGP: ProofCase = {
  fileName: "IZVGP-228-25.pdf",
  original: "InoFaktura GP 228-25.pdf",
  customer: TEHNICKI_REMONT,
  paymentAccounts: [EUR_ACCOUNT],
  invoice: invoiceBase({
    documentType: "IZVGP",
    documentNumber: "228/25",
    customerId: 20,
    isExport: true,
    currency: "EUR",
    documentDate: new Date(2025, 3, 25), // „Date: 25.04.2025."
    dueDate: new Date(2025, 3, 25),
    supplyDate: new Date(2025, 3, 25),
    fco: "magacin kupca", // → „Delivery term:"
    paymentMethod: "virmanom", // → „Payment terms:"
    note: "Fakturisanje je izvršeno na osnovu ponude 0206-25",
    customsDeclarationNo: "25-0401-000005",
    netTotal: D("500.00"),
    vatTotal: D("0"),
    grossTotal: D("500.00"),
    items: [
      exportLine(1, {
        itemId: 200, // 5326557- · 5326557 LL3-TV77
        unit: "Kom",
        quantity: "2",
        unitPrice: "125.00",
        total: "250.00",
      }),
      exportLine(2, {
        itemId: 201, // 6063335- · 6063335 Sick GLL170-P334
        unit: "Kom",
        quantity: "2",
        unitPrice: "125.00",
        total: "250.00",
      }),
    ],
  }),
};

/**
 * 4) IZVUS 060/26 — izvozna faktura za USLUGU, EUR, TRI STRANE
 * (`docs/zahtevi/…/INOUslugaFaktura 060-26.pdf`).
 *
 * Sve stavke su slobodne (bez artikla) i dvorede — prelom reda u opisu je sa papira.
 * Otpremni blok (paritet, kolete, dimenzije, kilaža, mesto istovara, špediter) je
 * prepisan sa DRUGE strane originala.
 *
 * ⚠️ Stavka 4: 19,6 × 30,10 = 589,96, a papir u koloni `Total` piše 590,00. Iznos je
 * prepisan KAKAV JESTE (590,00) — tako se i zbir 10.530,75 poklapa sa originalom.
 * Sama nesaglasnost je nalaz o BigBitu, ne o nama.
 */
const IZVUS: ProofCase = {
  fileName: "IZVUS-060-26.pdf",
  original: "INOUslugaFaktura 060-26.pdf",
  customer: HIDRAULIKA_FLEX,
  paymentAccounts: [EUR_ACCOUNT],
  invoice: invoiceBase({
    documentType: "IZVUS",
    documentNumber: "060/26",
    customerId: 30,
    isExport: true,
    currency: "EUR",
    documentDate: new Date(2026, 2, 6), // „Date: 06.03.2026."
    supplyDate: new Date(2026, 2, 6), // „Date of delivery: 06-03-26 ,  Beograd"
    dueDate: new Date(2026, 2, 6), // „Payment terms: 06.03.2026."
    netTotal: D("10530.75"),
    vatTotal: D("0"),
    grossTotal: D("10530.75"),
    // Otpremni blok — strana 2 originala.
    deliveryTerm: "FCA Dobanovci-Beograd",
    packageDescription: "1 paleta",
    packageDimensions: "400 x 800 x 2400 mm",
    grossWeightKg: D("1720"),
    netWeightKg: D("1700"),
    unloadingPlace:
      "Hidraulika Flex d.o.o.\nJovana Cvijića 3\n78250 Laktaši, Bosna i Hercegovina",
    forwarderContact:
      "Evrounija d.o.o., CI Banja Luka\nTelefon: +387 51 490 727 / +387 65 768 476",
    items: [
      exportLine(1, {
        description:
          "520000 Bronza CuSn12 flah 62x12mm ; L=810mm x 7kom\nBronza-flah",
        unit: "kg",
        quantity: "40.8",
        unitPrice: "27.45",
        total: "1119.96",
      }),
      exportLine(2, {
        description: "520000 Bronza CuSn12 flah\n62x12mm kg",
        unit: "kg",
        quantity: "28.8",
        unitPrice: "28.47",
        total: "819.94",
      }),
      exportLine(3, {
        description: "520000 Bronza CuSn12 flah\n42x12mm kg",
        unit: "kg",
        quantity: "27.8",
        unitPrice: "24.28",
        total: "674.98",
      }),
      exportLine(4, {
        description: "520000 Bronza CuSn12 flah\nL=445mm x 9kom Bronza-flah",
        unit: "kg",
        quantity: "19.6",
        unitPrice: "30.10",
        total: "590.00",
      }),
      exportLine(5, {
        description: "PS 670 2400/100/2312 Specijalna\nploča",
        unit: "kom",
        quantity: "1",
        unitPrice: "4683.37",
        total: "4683.37",
      }),
      exportLine(6, {
        description: "PS 270 650/75/2312 Specijalna ploča",
        unit: "kom",
        quantity: "2",
        unitPrice: "1321.25",
        total: "2642.50",
      }),
    ],
  }),
};

const CASES: ProofCase[] = [IFR, IFUSL, IZVGP, IZVUS];

// ───────────────────────────────────────────────────────────────────── izvođenje

async function main(): Promise<void> {
  const outDir = resolve(process.cwd(), OUT_DIR);
  mkdirSync(outDir, { recursive: true });

  // Jedan renderer za sve dokaze (učitavanje Roboto fontova je skupo, a idempotentno).
  const pdf = new PdfService();
  const barcode = new BarcodeService();

  const results: Array<{
    file: string;
    original: string;
    bytes: number;
    pages: number;
    warnings: string[];
  }> = [];

  for (const c of CASES) {
    const warnings: string[] = [];
    const service = new InvoicePdfService(
      makePrisma(c) as unknown as PrismaService,
      pdf,
      barcode,
    );
    // Upozorenja štampe (nepoznata vrsta, izvoz u dinarima, QR) su deo nalaza —
    // hvataju se umesto da nestanu u Nest logu.
    (service as any).logger.warn = (m: unknown) => warnings.push(String(m));

    const { buffer } = await service.buildInvoicePdf(c.invoice.id);
    const path = resolve(outDir, c.fileName);
    writeFileSync(path, buffer);

    const doc = await PDFDocument.load(buffer);
    results.push({
      file: path,
      original: c.original,
      bytes: buffer.length,
      pages: doc.getPageCount(),
      warnings,
    });
  }

  console.log("\n=== DOKAZ ŠTAMPE — ČETIRI OBRASCA IZLAZNE FAKTURE ===");
  for (const r of results) {
    console.log(
      `${String(r.bytes).padStart(8)} B  ${String(r.pages)} str.  ${r.file}\n` +
        `${" ".repeat(21)}original: docs/zahtevi/fakture-obrasci-2026-08/${r.original}`,
    );
    for (const w of r.warnings) console.log(`${" ".repeat(21)}⚠ ${w}`);
  }

  // Prazan obrazac je najtiši mogući kvar — PDF postoji, a na njemu nema ničega.
  const suspicious = results.filter((r) => r.bytes < 20000);
  console.log(
    suspicious.length
      ? `\nUPOZORENJE: ${suspicious.length} PDF-a ispod 20 KB (sumnja na prazan obrazac).`
      : "\nSvi PDF-ovi iznad 20 KB.",
  );
  // Ino usluga je jedini višestran obrazac; original 060/26 ima TRI strane.
  const inoUsluga = results.find((r) => r.file.endsWith("IZVUS-060-26.pdf"));
  if (inoUsluga && inoUsluga.pages !== 3)
    console.log(
      `UPOZORENJE: IZVUS ima ${inoUsluga.pages} strane, a original 060/26 ima 3.`,
    );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
