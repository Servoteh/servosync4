import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";

/**
 * ŠIFARNIK VRSTA USLUGE — čitanje za ekran (05.08.2026).
 *
 * Ovaj servis danas SAMO ČITA. Uređivanje (dodavanje vrste, izmena konta, gašenje) je
 * posao knjigovođe i ide kroz ekran u Podešavanjima, koji još nije napravljen — v.
 * `docs/OTVORENI_POSLOVI.md`, odeljak P. Do tada se šifarnik menja u bazi, a četiri
 * potvrđene vrste su ušle seed-om migracije `20260805190000_sifarnik_vrsta_usluge`.
 *
 * Zašto zaseban servis, a ne metod na `SalesService`: `SalesService` je o IZMENI jednog
 * nacrta (brave, CAS, preračun zbirova), a ovo je šifarnik koji čitaju i račun i (sutra)
 * Podešavanja. Kad ekran za uređivanje stigne, dopisuje se ovde i ne dira tok fakture.
 */
@Injectable()
export class ServiceRevenueTypeService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Vrste za padajuću listu na uslužnom računu.
   *
   * ⚠️ SAMO AKTIVNE, i to namerno: ugašena vrsta se ne sme ponuditi jer je knjigovođa
   * povukao njeno konto iz upotrebe (`SalesService.assertServiceRevenueTypeAllowed` je
   * i odbija). Račun koji je ugašenu vrstu već poneo je i dalje čita preko relacije, pa
   * mu papir i knjiženje ostaju tačni — gašenje deluje unapred, ne unazad.
   *
   * Redosled je `sortOrder` pa `code`: knjigovođa određuje šta je na vrhu liste
   * (podrazumevano `USL`, izmereno 45 od 57 stavki), a `code` je samo stabilna rezerva
   * da se dve vrste sa istim `sortOrder` ne premeštaju od poziva do poziva.
   */
  async listActive() {
    return this.prisma.serviceRevenueType.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
      select: {
        id: true,
        code: true,
        name: true,
        revenueAccountCode: true,
        vatTreatment: true,
        paperNote: true,
        sortOrder: true,
      },
    });
  }
}
