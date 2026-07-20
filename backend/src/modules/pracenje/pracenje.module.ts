import { Module } from "@nestjs/common";
import { PdmModule } from "../pdm/pdm.module";
import { PracenjeController } from "./pracenje.controller";
import { PracenjeService } from "./pracenje.service";
import { PracenjeReadService } from "./pracenje-read.service";
import { PracenjeAkcijeSy15Service } from "./pracenje-akcije-sy15.service";
import { PracenjePdfService } from "./pracenje-pdf.service";

/**
 * Praćenje proizvodnje (F1, docs/PLAN_PRACENJE_PROIZVODNJE_2026-07.md). Reads
 * (`PracenjeReadService`) and mutations (`PracenjeService`) now sit entirely on the
 * ORIGINAL 2.0 tables via `PrismaService` (PrismaModule is global) — no sy15.
 *
 * The ONE remaining sy15 touch — the `akcione-tacke` lookup — is quarantined in
 * `PracenjeAkcijeSy15Service` (Sy15Module is global) and disappears once the
 * akcioni-plan/sastanci module ports to 2.0.
 *
 * PdmModule (exports `PdmService`): `PracenjePdfService` reuses `getPdfContent`
 * to stream drawing PDFs under `pracenje.read` alone (odluka O7 — no PDM_READ).
 */
@Module({
  imports: [PdmModule],
  controllers: [PracenjeController],
  providers: [
    PracenjeService,
    PracenjeReadService,
    PracenjeAkcijeSy15Service,
    PracenjePdfService,
  ],
})
export class PracenjeModule {}
