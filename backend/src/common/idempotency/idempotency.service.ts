import { ConflictException, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";

/** Transakcioni klijent 3.0 baze — potpis akcije koja se izvršava idempotentno. */
export type IdempotencyTx = Prisma.TransactionClient;

export interface IdempotentOutcome<T> {
  /** `true` = vraćen SAČUVAN rezultat, akcija NIJE ponovo izvršena. */
  idempotent: boolean;
  result: T;
}

/**
 * Registar idempotencije 3.0 aplikacije — 3.0 parnjak sy15 `Sy15Service.runIdempotent`
 * nad tabelom `api_idempotency` (v. `prisma/migrations/20260806120000_api_idempotency`).
 *
 * ČEMU SLUŽI: dupli POST (dupli klik, retry posle mrežnog prekida, „nije se učitalo pa
 * sam kliknuo opet") ne sme da napravi drugi sastanak, drugi talas mejlova ili drugi
 * revers. Klijent uz mutaciju šalje `clientEventId` (uuid); PRVI zahtev ga zauzme,
 * izvrši akciju i sačuva odgovor — SVAKI sledeći sa istim ključem dobija taj sačuvan
 * odgovor BEZ izvršavanja.
 *
 * ⚠️ GENERIČKI SERVIS, NE „sastanci": sy15 registar je uprkos `rev_` prefiksu bio
 * registar CELE aplikacije (izmereno 05.08.2026: 643 reda, 35 `action` vrednosti —
 * kadrovska 368, sastanci 56, PB 31, održavanje 16, reversi 2). Koristiće ga i
 * preostali koraci gašenja sy15 (docs/PLAN_GASENJA_SY15_2026-08-03.md).
 *
 * 🔴 TRI SVOJSTVA KOJA SE NE SMEJU IZGUBITI (sva tri su razlog zašto registar radi):
 *
 *  1. **Ključ i akcija idu u ISTOJ transakciji.** Rollback akcije briše i ključ, pa
 *     neuspeo pokušaj sme da se ponovi. Da se ključ upisivao zasebno (npr. „prvo
 *     rezerviši pa radi"), pad akcije bi TRAJNO zaključao taj ključ i korisnik više
 *     nikad ne bi mogao da pošalje isti zahtev — video bi sačuvan „rezultat" nečega
 *     što se nikad nije desilo.
 *
 *  2. **Konkurentan isti ključ ČEKA, ne prolazi.** `INSERT … ON CONFLICT DO NOTHING`
 *     nad PK-om uzima speculative-insert bravu: druga transakcija sa istim ključem
 *     blokira dok prva ne završi, pa tek onda vidi ishod. Bez toga bi dva klika u
 *     istoj sekundi oba prošla proveru „ključ ne postoji" i oba izvršila akciju.
 *
 *     IZMERENO, ne pretpostavljeno (probna baza `idem_proba`, PostgreSQL 17.6):
 *     sesija A zauzme ključ i drži transakciju 3 s; sesija B sa ISTIM ključem kreće
 *     1 s kasnije i njen INSERT **blokira 1.981 s** (tačno do A-inog COMMIT-a), vrati
 *     `INSERT 0 0`, pa pročita `result={"id": 1}` — dakle GOTOV rezultat, nikad
 *     poluupisan red. To je jedini razlog zašto je `ON CONFLICT DO NOTHING`
 *     dovoljno i zašto nije potrebno nikakvo dodatno zaključavanje.
 *
 *  3. **Ključ upotrebljen za DRUGU akciju → 409**, nikad tiho izvršavanje. Klijent
 *     koji reciklira uuid ima bug; tihi prolaz bi ga sakrio.
 *
 * ⚠️ RAZLIKA OD sy15 IZVORA (namerna, jedina): proverava se i `actor_email`. sy15
 * registar nema kolonu aktera, pa ponovljen zahtev vraća sačuvan odgovor BILO KOME ko
 * zna ključ — a odgovor ume da nosi tuđe podatke (id i naslov tuđeg sastanka, broj
 * prenetih akcija…). Ključ je nasumičan uuid pa je to praktično neiskoristivo, ali
 * provera ne košta ništa. Legitiman slučaj (isti korisnik ponavlja svoj zahtev) je
 * netaknut; tuđi ključ dobija isti 409 kao pogrešna akcija.
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Izvrši `fn` najviše JEDNOM po `clientEventId`.
   *
   * Vraća `{ idempotent: false, result }` za prvo izvršenje i
   * `{ idempotent: true, result }` za svako ponavljanje (sačuvan odgovor).
   *
   * Baca `ConflictException` (409) kad je ključ već potrošen za drugu akciju ili od
   * strane drugog korisnika.
   *
   * `opts.timeoutMs` prosleđuje se Prisma transakciji — za akcije koje rade više od
   * podrazumevanih 5 s (npr. bulk zamena učesnika sa mejlovima).
   */
  async run<T>(
    actorEmail: string,
    clientEventId: string,
    action: string,
    fn: (tx: IdempotencyTx) => Promise<T>,
    opts?: { timeoutMs?: number },
  ): Promise<IdempotentOutcome<T>> {
    const actor = (actorEmail ?? "").trim().toLowerCase();
    return this.prisma.$transaction(
      async (tx) => {
        // Zauzimanje ključa. `DO NOTHING` vraća 0 kad ključ već postoji — i, bitno,
        // ČEKA ako ga upravo upisuje druga (još nezavršena) transakcija.
        const inserted = await tx.$executeRaw`
          INSERT INTO api_idempotency (client_event_id, action, actor_email)
          VALUES (${clientEventId}::uuid, ${action}, ${actor})
          ON CONFLICT (client_event_id) DO NOTHING`;

        if (inserted === 0) {
          const rows = await tx.$queryRaw<
            { action: string; actor_email: string; result: T }[]
          >`
            SELECT action, actor_email, result FROM api_idempotency
            WHERE client_event_id = ${clientEventId}::uuid`;
          const stored = rows[0];
          if (!stored || stored.action !== action) {
            throw new ConflictException(
              `clientEventId ${clientEventId} je već upotrebljen za akciju ` +
                `"${stored?.action ?? "?"}"`,
            );
          }
          if ((stored.actor_email ?? "").toLowerCase() !== actor) {
            // Isti ključ, druga osoba: NE vraćaj sačuvan odgovor (nosi tuđe podatke).
            throw new ConflictException(
              `clientEventId ${clientEventId} je već upotrebljen (drugi korisnik)`,
            );
          }
          return { idempotent: true, result: stored.result };
        }

        const result = await fn(tx);
        // Rezultat se upisuje POSLE akcije — do tada red stoji sa `result IS NULL`,
        // što je tačan opis stanja („ključ zauzet, ishod još nepoznat").
        await tx.$executeRaw`
          UPDATE api_idempotency
          SET result = ${JSON.stringify(result ?? null)}::jsonb
          WHERE client_event_id = ${clientEventId}::uuid`;
        return { idempotent: false, result };
      },
      opts?.timeoutMs != null ? { timeout: opts.timeoutMs } : undefined,
    );
  }
}
