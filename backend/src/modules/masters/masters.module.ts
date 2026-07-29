import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { ItemsController } from "./items.controller";
import { ItemsService } from "./items.service";
import { MasterCustomersController } from "./customers.controller";
import { MasterCustomersService } from "./customers.service";

/**
 * Matični podaci 4.0 (`masters`) — READ-ONLY pregled BigBit cache tabela:
 *   Artikli   → `items`     (`GET /api/v1/artikli`)
 *   Komitenti → `customers` (`GET /api/v1/komitenti`)
 *
 * Modul namerno NEMA nijednu mutaciju: BigBit ostaje vlasnik matičnih podataka do
 * cutover-a (BACKEND_RULES §3 „BigBit matični podaci su read-only cache" + §11.1),
 * a prelazni režim unosa je presuđen — unos ide u BigBit. Jedina zavisnost je Prisma.
 */
@Module({
  imports: [PrismaModule],
  controllers: [ItemsController, MasterCustomersController],
  providers: [ItemsService, MasterCustomersService],
})
export class MastersModule {}
