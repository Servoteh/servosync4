import { Logger, Module, type OnModuleInit } from "@nestjs/common";
import { ReversiSourceService } from "./reversi-source.service";
import { LokacijeSourceService } from "./lokacije-source.service";
import { assertSpojeniIzvori } from "./spojeni-izvori";

/**
 * Prekidači izvora za SPOJENI par Reversi + Lokacije (`REVERSI_IZVOR`, `LOKACIJE_IZVOR`).
 *
 * Zašto zajednički modul, a ne dva nezavisna provajdera po modulu (kao
 * `ScadaSourceService` / `OdrzavanjeSourceService`): ta dva domena su transakciono
 * spojena i njihove vrednosti moraju biti iste. Da su provajdovani odvojeno, brana
 * `assertSpojeniIzvori()` ne bi imala mesto sa koga vidi OBA prekidača.
 *
 * Brana radi u `onModuleInit`, dakle pri podizanju aplikacije — pre nego što ijedan
 * zahtev stigne. Ako se vrednosti razlikuju, backend NE KREĆE. To je namerno:
 * pouka 07.08.2026 („docker restart ne čita env") je da tiho pogrešan prekidač ume
 * da radi neprimećeno, a ovde bi to značilo dokument u jednoj bazi i kretanje u drugoj.
 */
@Module({
  providers: [ReversiSourceService, LokacijeSourceService],
  exports: [ReversiSourceService, LokacijeSourceService],
})
export class ReversiLokacijeIzvorModule implements OnModuleInit {
  private readonly logger = new Logger(ReversiLokacijeIzvorModule.name);

  constructor(
    private readonly reversi: ReversiSourceService,
    private readonly lokacije: LokacijeSourceService,
  ) {}

  onModuleInit(): void {
    assertSpojeniIzvori(this.reversi, this.lokacije, this.logger);
  }
}
