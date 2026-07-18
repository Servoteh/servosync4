import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { WorkersController } from "./workers.controller";
import { WorkersService } from "./workers.service";
import { WorkUnitsController } from "./work-units.controller";
import { WorkUnitsService } from "./work-units.service";
import { OperationsController } from "./operations.controller";
import { OperationsService } from "./operations.service";
import { WorkerTypesController } from "./worker-types.controller";
import { WorkerTypesService } from "./worker-types.service";
import { MachineAccessController } from "./machine-access.controller";
import { MachineAccessService } from "./machine-access.service";

/**
 * Proizvodne strukture (MODULE_SPEC_structures) — CRUD za 5 šifarnika:
 * radnici, radne jedinice, operacije, vrste poslova, matrica radnik × mašina.
 *
 * Registracija u `app.module.ts` je posao integratora (dodati `StructuresModule`
 * u `imports`). Nije uključen user-link ni signature-upload (traže šemu/storage
 * koje nemamo u ovom talasu).
 */
@Module({
  imports: [PrismaModule],
  controllers: [
    WorkersController,
    WorkUnitsController,
    OperationsController,
    WorkerTypesController,
    MachineAccessController,
  ],
  providers: [
    WorkersService,
    WorkUnitsService,
    OperationsService,
    WorkerTypesService,
    MachineAccessService,
  ],
})
export class StructuresModule {}
