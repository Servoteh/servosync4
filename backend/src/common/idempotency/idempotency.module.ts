import { Global, Module } from "@nestjs/common";
import { IdempotencyService } from "./idempotency.service";

/**
 * Registar idempotencije je infrastruktura cele aplikacije (kao `PrismaModule`), ne
 * deo jednog modula — zato `@Global()`. Prvi potrošač su sastanci pod prekidačem
 * `SASTANCI_PB_IZVOR=3.0`; sledeći su koraci 2–5 gašenja sy15 (održavanje, reversi).
 */
@Global()
@Module({
  providers: [IdempotencyService],
  exports: [IdempotencyService],
})
export class IdempotencyModule {}
