import { Prisma, PrismaClient } from "@prisma/client";
import { unaccentLike } from "../src/modules/ai-chat/tools/core-tools";

/**
 * e2e — PIN IZRAZA: kod ↔ trigram indeks (review nalaz 15).
 *
 * Trigram indeksi iz migracije 20260726160000 su na IZRAZU
 * `public.immutable_unaccent(lower(kolona))`. PostgreSQL koristi takav indeks
 * SAMO ako upit sadrži bajt-identičan izraz. Ako neko ikad „počisti" kod (izbaci
 * `lower`, doda `btrim`, pređe na `ILIKE`), ništa ne pukne — pretraga tiho
 * postane Seq Scan preko 92k redova i to niko ne primeti dok korisnici ne počnu
 * da se žale na sporost.
 *
 * Ovaj test to hvata: gradi WHERE granu ISTOM funkcijom koju koriste alati
 * (`unaccentLike`), pusti `EXPLAIN` na živoj bazi i traži trigram indeks u planu.
 *
 * Zahteva bazu sa primenjenom migracijom i DOVOLJNO redova da planer uopšte
 * bira indeks. Bez `AI_TRIGRAM_E2E_URL` test se PRESKAČE (CI nema bazu) — nije
 * tiho zeleno: `describe.skip` se vidi u izlazu, a lokalno se pokreće sa
 *   AI_TRIGRAM_E2E_URL=postgresql://… npx jest --config test/jest-e2e.json ai-tools-trigram
 */

const URL = process.env.AI_TRIGRAM_E2E_URL;
const opisi: [string, Prisma.Sql, string][] = [
  [
    "items.name → idx_items_name_trgm",
    Prisma.sql`i.name`,
    "idx_items_name_trgm",
  ],
  [
    "items.catalog_number → idx_items_catalog_number_trgm",
    Prisma.sql`i.catalog_number`,
    "idx_items_catalog_number_trgm",
  ],
];

(URL ? describe : describe.skip)(
  "trigram indeksi — izraz iz koda pogađa indeks (EXPLAIN)",
  () => {
    let prisma: PrismaClient;

    beforeAll(async () => {
      prisma = new PrismaClient({ datasources: { db: { url: URL } } });
      await prisma.$connect();
    });

    afterAll(async () => {
      await prisma.$disconnect();
    });

    it.each(opisi)("%s", async (_naziv, kolona, indeks) => {
      // ORDER BY je deo ugovora: bez njega planer na mali LIMIT bira Seq Scan
      // („brzo ću naći 15 redova"), pa bi test padao iz pogrešnog razloga.
      const plan = await prisma.$queryRaw<{ "QUERY PLAN": string }[]>(
        Prisma.sql`EXPLAIN SELECT i.id FROM items i
                    WHERE ${unaccentLike(kolona, "prirubnica ceona")}
                    ORDER BY i.name LIMIT 15`,
      );
      const tekst = plan.map((r) => r["QUERY PLAN"]).join("\n");
      expect(tekst).toContain(indeks);
      expect(tekst).not.toContain("Seq Scan");
    });

    it("work_orders: ident + naziv dela idu preko oba trigram indeksa", async () => {
      const plan = await prisma.$queryRaw<{ "QUERY PLAN": string }[]>(
        Prisma.sql`EXPLAIN SELECT wo.id FROM work_orders wo
                    WHERE ${unaccentLike(Prisma.sql`wo.ident_number`, "9425000")}
                       OR ${unaccentLike(Prisma.sql`wo.part_name`, "9425000")}
                    ORDER BY wo.entered_at DESC LIMIT 15`,
      );
      const tekst = plan.map((r) => r["QUERY PLAN"]).join("\n");
      expect(tekst).toContain("idx_work_orders_ident_number_trgm");
      expect(tekst).toContain("idx_work_orders_part_name_trgm");
      expect(tekst).not.toContain("Seq Scan");
    });

    it("work_time_entries po nalogu ide preko idx_work_time_entries_work_order", async () => {
      const plan = await prisma.$queryRaw<{ "QUERY PLAN": string }[]>(
        Prisma.sql`EXPLAIN SELECT SUM(w.piece_count) FROM work_time_entries w
                    WHERE w.work_order_id = 101 AND w.operation_number = 10`,
      );
      const tekst = plan.map((r) => r["QUERY PLAN"]).join("\n");
      expect(tekst).toContain("idx_work_time_entries_work_order");
    });

    it("immutable_unaccent postoji i normalizuje srpsku dijakritiku", async () => {
      const rows = await prisma.$queryRaw<{ norm: string }[]>(
        Prisma.sql`SELECT public.immutable_unaccent(lower('ĐŠŽČĆ')) AS norm`,
      );
      expect(rows[0]?.norm).toBe("dszcc");
    });
  },
);
