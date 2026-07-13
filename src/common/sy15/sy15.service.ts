import {
  ConflictException,
  Injectable,
  Logger,
  OnModuleDestroy,
  ServiceUnavailableException,
} from "@nestjs/common";
import { PrismaClient as Sy15PrismaClient } from "@prisma-sy15/client";

/**
 * Transakcioni klijent sy15 baze (bez lifecycle metoda) — potpis za `withUser` callback.
 */
export type Sy15Tx = Omit<
  Sy15PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

/**
 * Drugi datasource: sy15 (1.0) PostgreSQL baza — MODULE_SPEC_reversi.md §0.
 * Tabele 1.0 modula u pilotu OSTAJU u sy15 bazi (atomarnost rev_* ↔ loc_*);
 * ovaj servis je jedini ulaz 2.0 backenda u nju (`prisma/sy15.prisma`).
 *
 * Boot-safe: bez `SY15_DATABASE_URL` aplikacija se diže normalno (glavna 2.0
 * baza ne zavisi od ovoga); tek korišćenje sy15 modula vraća 503.
 */
@Injectable()
export class Sy15Service implements OnModuleDestroy {
  private readonly logger = new Logger(Sy15Service.name);
  private readonly client: Sy15PrismaClient | null;

  constructor() {
    this.client = process.env.SY15_DATABASE_URL ? new Sy15PrismaClient() : null;
    if (!this.client) {
      this.logger.warn(
        "SY15_DATABASE_URL nije postavljen — sy15 moduli (Reversi pilot) će vraćati 503.",
      );
    }
  }

  get db(): Sy15PrismaClient {
    if (!this.client) {
      throw new ServiceUnavailableException(
        "sy15 baza nije konfigurisana (SY15_DATABASE_URL)",
      );
    }
    return this.client;
  }

  /**
   * GUC most (spec §3): sy15 DB funkcije i „moji/tim" view-ovi čitaju identitet iz
   * `auth.jwt()` = `current_setting('request.jwt.claims')`. Postavljamo claims
   * transakciono (`set_config(..., true)` = important: local na tx), pa postojeće
   * SECURITY DEFINER funkcije (rev_can_manage, rev_current_employee_id,
   * current_user_manages_employee…) rade netaknute — paritet po konstrukciji.
   * Isti obrazac kao 1.0 Management API skripte.
   */
  async withUser<T>(email: string, fn: (tx: Sy15Tx) => Promise<T>): Promise<T> {
    return this.db.$transaction(async (tx) => {
      await this.setClaims(tx as Sy15Tx, email);
      return fn(tx);
    });
  }

  /**
   * Kao `withUser`, ali NAKON claims-a prebacuje sesijsku rolu na `authenticated`
   * (`SET LOCAL ROLE`) — tako se ROW-SCOPED RLS politike STVARNO evaluiraju (npr.
   * `loc_placements_select` krije `item_ref_table='rev_tools'` redove od ne-manage
   * korisnika). Bez ovoga `servosync2_app` (BYPASSRLS) bi vratio i skrivene redove
   * → curenje (paritet 1.0 gde PostgREST radi kao `authenticated` sa aktivnim RLS).
   *
   * Redosled je OBAVEZAN: claims se čitaju iz `auth.users` kao `servosync2_app`
   * (rola `authenticated` NEMA SELECT na `auth.users`) PA se tek onda prebacuje rola.
   * Preduslov je članstvo `GRANT authenticated TO servosync2_app` (Talas B R0).
   * `withUser` OSTAJE za DEFINER/`SELECT true` putanje (ne menja se).
   */
  async withUserRls<T>(
    email: string,
    fn: (tx: Sy15Tx) => Promise<T>,
  ): Promise<T> {
    return this.db.$transaction(async (tx) => {
      await this.setClaims(tx, email);
      await tx.$executeRawUnsafe("SET LOCAL ROLE authenticated");
      return fn(tx);
    });
  }

  /**
   * Postavi GUC claims za transakciju. `sub` = sy15 `auth.users.id` po email-u —
   * OBAVEZAN za mutacije: rev_issue_reversal/confirm_return upisuju
   * `issued_by`/`return_confirmed_by` preko `auth.uid()` (= claims->>'sub');
   * bez sub-a INSERT pada na NOT NULL. Keširano po email-u (id se ne menja).
   */
  private async setClaims(tx: Sy15Tx, email: string): Promise<void> {
    let sub = this.subByEmail.get(email);
    if (sub === undefined) {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM auth.users
        WHERE lower(email) = lower(${email}) AND deleted_at IS NULL
        LIMIT 1`;
      sub = rows[0]?.id ?? null;
      this.subByEmail.set(email, sub);
    }
    const claims = JSON.stringify(
      sub ? { sub, email, role: "authenticated" } : { email, role: "authenticated" },
    );
    await tx.$queryRaw`SELECT set_config('request.jwt.claims', ${claims}, true)`;
  }

  private readonly subByEmail = new Map<string, string | null>();

  /**
   * Idempotentno izvršavanje transakcione akcije (spec §5). Registar =
   * `rev_api_idempotency` (sy15, RLS-zaključan — piše ga samo backend, u ISTOJ
   * transakciji sa akcijom, pa rollback akcije briše i ključ → retry dozvoljen).
   * Ponovljen `clientEventId`: vraća sačuvan rezultat BEZ izvršavanja (dupli
   * klik/retry ≠ dupli revers — 1.0 front ovo nema). Konkurentan isti ključ
   * čeka na PK unique dok prva tx ne završi. Ključ upotrebljen za DRUGU akciju → 409.
   */
  async runIdempotent<T>(
    email: string,
    clientEventId: string,
    action: string,
    fn: (tx: Sy15Tx) => Promise<T>,
  ): Promise<{ idempotent: boolean; result: T }> {
    return this.db.$transaction(async (tx) => {
      await this.setClaims(tx as Sy15Tx, email);
      const inserted = await tx.$executeRaw`
        INSERT INTO rev_api_idempotency (client_event_id, action)
        VALUES (${clientEventId}::uuid, ${action})
        ON CONFLICT (client_event_id) DO NOTHING`;
      if (inserted === 0) {
        const rows = await tx.$queryRaw<{ action: string; result: T }[]>`
          SELECT action, result FROM rev_api_idempotency
          WHERE client_event_id = ${clientEventId}::uuid`;
        const stored = rows[0];
        if (!stored || stored.action !== action) {
          throw new ConflictException(
            `clientEventId ${clientEventId} je već upotrebljen za akciju "${stored?.action ?? "?"}"`,
          );
        }
        return { idempotent: true, result: stored.result };
      }
      const result = await fn(tx);
      await tx.$executeRaw`
        UPDATE rev_api_idempotency SET result = ${JSON.stringify(result ?? null)}::jsonb
        WHERE client_event_id = ${clientEventId}::uuid`;
      return { idempotent: false, result };
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.$disconnect();
  }
}
