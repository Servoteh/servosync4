import {
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
    const claims = JSON.stringify({ email, role: "authenticated" });
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('request.jwt.claims', ${claims}, true)`;
      return fn(tx);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.$disconnect();
  }
}
