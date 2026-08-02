import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { ItemsController } from "./items.controller";
import { ItemsService } from "./items.service";
import { MasterCustomersController } from "./customers.controller";
import { MasterCustomersService } from "./customers.service";

/**
 * Matični podaci 4.0 (`masters`) — pregled BigBit cache tabela:
 *   Artikli   → `items`     (`GET /api/v1/artikli`)
 *   Komitenti → `customers` (`GET /api/v1/komitenti`)
 *
 * BigBit ostaje vlasnik matičnih podataka do cutover-a (BACKEND_RULES §3 „BigBit
 * matični podaci su read-only cache" + §11.1), a prelazni režim unosa je presuđen —
 * unos ide u BigBit. Jedina zavisnost je Prisma.
 *
 * ⚠️ Modul OD SADA ima i mutacije (`POST`/`PATCH` nad oba resursa), ali su SVE ČETIRI
 * zatvorene branom i vraćaju `409 BIGBIT_OWNED_READ_ONLY` pre ijednog dodira baze:
 *   • artikli   → `assertItemWritesAllowed()` (`items.write-policy.ts`) — brana je
 *     DINAMIČKA: čita `sync/table-ownership.ts`, pa se sama otvori onog dana kad
 *     `items` uđe u zaštićeni skup;
 *   • komitenti → `assertCustomerWriteAllowed()` (`customers.service.ts`) — prekidač
 *     `CUSTOMERS_WRITE_OPEN`, drži ga odluka vlasnika od 26.07.2026.
 * Kod upisa postoji i testiran je da bi dan otvaranja bio izmena jedne odluke, a ne
 * pisanje modula ispočetka. Pre otvaranja bilo koje brane traži se zaseban permisijski
 * ključ (`masters.write`) — danas obe mutacije vise na `sync.run`/`directory.read`.
 */
@Module({
  imports: [PrismaModule],
  controllers: [ItemsController, MasterCustomersController],
  providers: [ItemsService, MasterCustomersService],
})
export class MastersModule {}
