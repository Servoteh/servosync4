/**
 * SMOKE: N:M avansi KROZ UI PUT (stavka C nezavisnog pregleda 27.07, nalaz K2).
 * =============================================================================
 * Ovaj smoke NE zove servise direktno — vozi TAČNO one HTTP rute i TAČNO ona
 * tela zahteva koja gradе hook-ovi ekrana `frontend/src/app/fakturisanje/avansi`:
 *
 *   useAdvances            → GET  /api/v1/pdv/advances
 *   useCreateAdvanceFrom…  → POST /api/v1/sales/advance-invoices
 *   useMarkAdvancePaid     → POST /api/v1/sales/advance-invoices/:id/paid
 *   useLinkAdvanceToFinal  → POST /api/v1/sales/invoices/:id/apply-advance
 *
 * Razlog: defekt NIJE bio samo u uslovu prikaza dugmeta. `sales.controller.ts` je
 * telo rute tipizirao samo sa `advanceInvoiceId`, pa je `amount` (iznos jedne
 * primene) tiho otpadao — delimično odbijanje je kroz rutu bilo NEMOGUĆE i test
 * koji zove servis direktno to ne bi video.
 *
 * Scenario je iz stvarnih podataka (BigBit `AVR-00013/2025`):
 *   avans 37.902 → 20.802 na prvi račun + 17.100 na drugi.
 *
 * Pokretanje (dev baza, NIKAD prod):
 *   npx ts-node -T scripts/smoke-avansi-nm.ts
 */
import { NestFactory } from "@nestjs/core";
import {
  ValidationPipe,
  VERSION_NEUTRAL,
  VersioningType,
} from "@nestjs/common";
import * as jwt from "jsonwebtoken";
// CJS izvoz — `import * as request` bi dao namespace objekat, ne pozivnu funkciju.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const request = require("supertest");

/* eslint-disable @typescript-eslint/no-explicit-any */

// Dev baza (192.168.64.28:5437) — postavlja se PRE boot-a, jer ConfigModule ne
// gazi već postojeće promenljive okruženja. `AppModule` se zato učitava tek
// `require`-om u `main()`: `auth.module.ts` traži JWT_SECRET već pri IMPORTU, a
// import-i se izvršavaju pre tela modula.
process.env.DATABASE_URL =
  process.env.SMOKE_DATABASE_URL ??
  "postgresql://servosync:servosync_dev@192.168.64.28:5437/servosync";
process.env.JWT_SECRET =
  process.env.JWT_SECRET && process.env.JWT_SECRET.length > 12
    ? process.env.JWT_SECRET
    : "smoke_avansi_nm_secret_2026";
process.env.NODE_ENV = "development";

let pass = 0;
let fail = 0;
const results: string[] = [];

function ok(name: string, detail = "") {
  pass += 1;
  results.push(`  OK   ${name}${detail ? " — " + detail : ""}`);
}
function bad(name: string, err: unknown) {
  fail += 1;
  results.push(`  FAIL ${name} — ${String(err)}`);
}
async function step(name: string, fn: () => Promise<string | void>) {
  try {
    const d = await fn();
    ok(name, typeof d === "string" ? d : "");
  } catch (e: any) {
    bad(name, e?.message ?? e);
  }
}

/** Iznos iz JSON-a (Decimal-as-string) u pare — poređenja bez Float repova. */
function cents(v: unknown): number {
  return Math.round(Number(v) * 100);
}
function eq(actual: unknown, expected: number, label: string) {
  if (cents(actual) !== Math.round(expected * 100)) {
    throw new Error(`${label} = ${String(actual)}, očekivano ${expected}`);
  }
}

async function main() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { AppModule } = require("../src/app.module");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PrismaService } = require("../src/prisma/prisma.service");

  const app = await NestFactory.create(AppModule, { logger: ["error"] });
  // Isti pipeline kao `main.ts` — prefiks, verzionisanje i globalni ValidationPipe.
  app.setGlobalPrefix("api");
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: VERSION_NEUTRAL,
  });
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
  await app.init();

  const prisma: any = app.get(PrismaService);
  const server = app.getHttpServer();
  const token = jwt.sign(
    { sub: 1, email: "smoke@servoteh.com", role: "ADMIN" },
    process.env.JWT_SECRET as string,
    { expiresIn: "1h" },
  );
  const auth = (r: any) => r.set("Authorization", `Bearer ${token}`);
  const post = (url: string, body: unknown) =>
    auth(request(server).post(url).send(body as object));
  const get = (url: string) => auth(request(server).get(url));

  const stamp = Date.now();
  const today = new Date().toISOString().slice(0, 10);

  let customerId = 0;
  let avrId = 0;
  let invoiceA = 0; // 20.802
  let invoiceB = 0; // 17.100
  let invoiceC = 0; // kontrolni, za „avans potrošen"

  /** Red iz liste avansa — isti oblik koji ekran dobija. */
  const rowOf = async (id: number) => {
    const res = await get("/api/v1/pdv/advances?pageSize=200");
    if (res.status !== 200) throw new Error(`GET /pdv/advances → ${res.status}`);
    const row = (res.body.data as any[]).find((r) => r.id === id);
    if (!row) throw new Error(`avans ${id} nije u listi`);
    return row;
  };

  // ── priprema ───────────────────────────────────────────────────────────────
  await step("priprema: kupac", async () => {
    const c = await prisma.customer.findFirst({ select: { id: true } });
    if (!c) throw new Error("nema nijednog kupca na dev bazi");
    customerId = c.id;
    return `customerId=${customerId}`;
  });

  const makeFinal = async (label: string, gross: number) => {
    const net = gross / 1.2;
    const inv = await prisma.invoice.create({
      data: {
        documentType: "IFR",
        documentNumber: `SMOKE-K2-${label}-${stamp}`,
        level: 0,
        companyId: 0,
        customerId,
        documentDate: new Date(),
        currency: "RSD",
        netTotal: net.toFixed(4),
        vatTotal: (gross - net).toFixed(4),
        grossTotal: gross.toFixed(4),
        status: "POSTED",
      },
      select: { id: true },
    });
    return inv.id;
  };

  await step("priprema: dva konačna računa (20.802 i 17.100)", async () => {
    invoiceA = await makeFinal("A", 20802);
    invoiceB = await makeFinal("B", 17100);
    invoiceC = await makeFinal("C", 5000);
    return `A=${invoiceA} B=${invoiceB} C=${invoiceC}`;
  });

  // ── 1) avans 37.902 kroz rutu ekrana ───────────────────────────────────────
  await step("POST /sales/advance-invoices → AVR 37.902 (po ugovoru)", async () => {
    const res = await post("/api/v1/sales/advance-invoices", {
      customerId,
      amount: "37902",
      basis: `Ugovor SMOKE-K2-${stamp}`,
      vatRateCode: "3",
      isExport: false,
      documentDate: today,
    });
    if (res.status >= 400) throw new Error(`${res.status}: ${JSON.stringify(res.body)}`);
    avrId = res.body.data.id;
    eq(res.body.data.grossTotal, 37902, "bruto AVR");
    return `${res.body.data.documentNumber} id=${avrId} bruto=37902`;
  });

  await step("POST /sales/advance-invoices/:id/paid → naplata 37.902", async () => {
    const res = await post(`/api/v1/sales/advance-invoices/${avrId}/paid`, {
      paidAt: today,
      amount: "37902.00",
    });
    if (res.status >= 400) throw new Error(`${res.status}: ${JSON.stringify(res.body)}`);
    return `nalog ${res.body.data.journalEntryNumber}`;
  });

  await step('GET /pdv/advances → ostatak 37.902, dugme „Veži" se NUDI', async () => {
    const r = await rowOf(avrId);
    eq(r.paidAmount, 37902, "naplaćeno");
    eq(r.appliedAmount, 0, "iskorišćeno");
    eq(r.remainingAmount, 37902, "ostatak");
    if (r.applications.length !== 0) throw new Error("primene nisu prazne");
    if (!(cents(r.remainingAmount) > 0)) throw new Error("uslov dugmeta je false");
    return "naplaćeno=37902 iskorišćeno=0 ostatak=37902";
  });

  // ── 2) DOKAZ STAROG DEFEKTA: telo bez `amount` (kako je ruta radila) ───────
  await step(
    "STARO PONAŠANJE: apply-advance BEZ amount na račun od 20.802 → 422",
    async () => {
      const res = await post(`/api/v1/sales/invoices/${invoiceA}/apply-advance`, {
        advanceInvoiceId: avrId,
      });
      if (res.status !== 422) {
        throw new Error(`očekivan 422, dobijen ${res.status}: ${JSON.stringify(res.body)}`);
      }
      return String(res.body.message ?? "").slice(0, 120);
    },
  );

  // ── 3) prva primena 20.802 (telo koje šalje `useLinkAdvanceToFinal`) ──────
  await step("apply-advance amount=20802 → primena prolazi", async () => {
    const res = await post(`/api/v1/sales/invoices/${invoiceA}/apply-advance`, {
      advanceInvoiceId: avrId,
      amount: "20802.00",
    });
    if (res.status >= 400) throw new Error(`${res.status}: ${JSON.stringify(res.body)}`);
    eq(res.body.data.appliedAmount, 20802, "iznos primene");
    eq(res.body.data.advanceRemainingAmount, 17100, "ostatak posle primene");
    eq(res.body.data.payableAmount, 0, "za uplatu na računu A");
    return "primenjeno 20.802, ostatak 17.100, za uplatu 0";
  });

  await step("REGRESIJA K2: posle prve primene dugme MORA i dalje da se nudi", async () => {
    const r = await rowOf(avrId);
    eq(r.appliedAmount, 20802, "iskorišćeno");
    eq(r.remainingAmount, 17100, "ostatak");
    if (r.applications.length !== 1) throw new Error("očekivana 1 primena");
    // Stari uslov ekrana je bio `linkedFinalInvoiceId == null` — ovo je tačka na
    // kojoj je dugme nestajalo iako je 17.100 ostalo neiskorišćeno.
    if (r.linkedFinalInvoiceId == null) {
      throw new Error("linkedFinalInvoiceId je null — test ne meri ono što treba");
    }
    if (!(cents(r.remainingAmount) > 0)) {
      throw new Error("novi uslov dugmeta je false, a ostatak postoji");
    }
    return `stari uslov bi SAKRIO dugme (linked=${r.linkedFinalInvoiceId}), novi ga NUDI (ostatak 17.100)`;
  });

  // ── 4) prekoračenje ostatka → 422 sa jasnom porukom ───────────────────────
  await step("apply-advance amount=30000 (> ostatak 17.100) → 422", async () => {
    const res = await post(`/api/v1/sales/invoices/${invoiceB}/apply-advance`, {
      advanceInvoiceId: avrId,
      amount: "30000.00",
    });
    if (res.status !== 422) throw new Error(`očekivan 422, dobijen ${res.status}`);
    return String(res.body.message ?? "").slice(0, 140);
  });

  // ── 5) druga primena 17.100 → avans potrošen ──────────────────────────────
  await step("apply-advance amount=17100 na drugi račun → avans potrošen", async () => {
    const res = await post(`/api/v1/sales/invoices/${invoiceB}/apply-advance`, {
      advanceInvoiceId: avrId,
      amount: "17100.00",
    });
    if (res.status >= 400) throw new Error(`${res.status}: ${JSON.stringify(res.body)}`);
    eq(res.body.data.appliedAmount, 17100, "iznos druge primene");
    eq(res.body.data.advanceRemainingAmount, 0, "ostatak posle druge primene");
    return "20.802 + 17.100 = 37.902 ✔";
  });

  await step("GET /pdv/advances → ostatak 0, dugme se SKRIVA, obe veze vidljive", async () => {
    const r = await rowOf(avrId);
    eq(r.appliedAmount, 37902, "iskorišćeno");
    eq(r.remainingAmount, 0, "ostatak");
    if (r.applications.length !== 2) {
      throw new Error(`očekivane 2 primene, ima ${r.applications.length}`);
    }
    if (cents(r.remainingAmount) > 0) throw new Error("dugme bi i dalje bilo prikazano");
    const list = r.applications
      .map((a: any) => `${a.documentNumber}:${a.appliedAmount}`)
      .join(" · ");
    return `iskorišćeno=37902 ostatak=0 · ${list}`;
  });

  await step("apply-advance na trećem računu posle potrošenog avansa → 422", async () => {
    const res = await post(`/api/v1/sales/invoices/${invoiceC}/apply-advance`, {
      advanceInvoiceId: avrId,
      amount: "0.01",
    });
    if (res.status !== 422) throw new Error(`očekivan 422, dobijen ${res.status}`);
    return String(res.body.message ?? "").slice(0, 120);
  });

  // ── 6) drugi nalaz: naplata u RATAMA je takođe bila nedostupna ─────────────
  let rateAvrId = 0;
  await step("RATE: AVR 12.000, prva rata 10.000 → nenaplaćeno 2.000", async () => {
    const created = await post("/api/v1/sales/advance-invoices", {
      customerId,
      amount: "12000",
      basis: `Ugovor SMOKE-RATE-${stamp}`,
      vatRateCode: "3",
      documentDate: today,
    });
    if (created.status >= 400) throw new Error(JSON.stringify(created.body));
    rateAvrId = created.body.data.id;
    const paid = await post(`/api/v1/sales/advance-invoices/${rateAvrId}/paid`, {
      paidAt: today,
      amount: "10000.00",
    });
    if (paid.status >= 400) throw new Error(JSON.stringify(paid.body));
    const r = await rowOf(rateAvrId);
    eq(r.paidAmount, 10000, "naplaćeno");
    eq(r.unpaidAmount, 2000, "nenaplaćeno");
    // Stari uslov ekrana je bio `!a.paidAt` — posle prve rate dugme „Označi
    // naplatu" je nestajalo i preostalih 2.000 PDV-a nije imalo gde da se knjiži.
    if (r.paidAt == null) throw new Error("paidAt je null — test ne meri ono što treba");
    return `stari uslov bi SAKRIO „Označi naplatu" (paidAt=${String(r.paidAt).slice(0, 10)}), nenaplaćeno 2.000`;
  });

  await step("RATE: druga rata 2.000 → avans naplaćen u celosti", async () => {
    const res = await post(`/api/v1/sales/advance-invoices/${rateAvrId}/paid`, {
      paidAt: today,
      amount: "2000.00",
    });
    if (res.status >= 400) throw new Error(`${res.status}: ${JSON.stringify(res.body)}`);
    const r = await rowOf(rateAvrId);
    eq(r.paidAmount, 12000, "naplaćeno");
    eq(r.unpaidAmount, 0, "nenaplaćeno");
    eq(r.remainingAmount, 12000, "ostatak za odbijanje");
    return "naplaćeno 12.000, nenaplaćeno 0, ostatak za odbijanje 12.000";
  });

  await app.close();

  console.log("\n── SMOKE: N:M avansi kroz UI put ──────────────────────────────");
  for (const line of results) console.log(line);
  console.log(`\n  ukupno: ${pass} OK, ${fail} FAIL\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
