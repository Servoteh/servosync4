import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";

/**
 * ŠIFARNIK OSNOVA PORESKOG OSLOBOĐENJA — čitanje za dokument.
 *
 * Zašto zaseban servis, a ne metod na `SalesService`: `SalesService` je o IZMENI jednog
 * nacrta (brave, CAS, preračun zbirova), a ovo je šifarnik koji čita i račun i ekran.
 * Isti raspored kao `ServiceRevenueTypeService`.
 *
 * ⚠️ UREĐIVANJE ŠIFARNIKA (dodavanje osnova, izmena teksta za papir, gašenje) JOŠ NEMA
 * SVOJ EKRAN — do njega se menja SQL-om nad produkcijom. To je isti nalaz koji je za
 * vrste usluge vođen kao P10 u `docs/OTVORENI_POSLOVI.md`; ovde je hitniji, jer tekst na
 * papiru čeka potvrdu knjigovođe za dva reda (24.1.7 i domaći 24.1.5).
 */
@Injectable()
export class VatExemptionBasisService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Osnovi za padajuću listu na dokumentu.
   *
   * ⚠️ SAMO AKTIVNI, i to namerno: ugašen osnov se ne sme ponuditi jer ga je knjigovođa
   * povukao iz upotrebe. Dokument koji ga je već poneo i dalje ga čita preko relacije, pa
   * mu papir i e-faktura ostaju tačni — gašenje deluje unapred, ne unazad.
   *
   * `goesToSef` ide na ekran namerno: to je jedina razlika između izvoza (24.1.2) i
   * slobodne zone (24.1.5) koju korisnik može da vidi pre nego što izabere, a bira se baš
   * po njoj (odgovor 8: „takva faktura ne ide na sef" / „takva faktura se šalje na SEF").
   */
  async listActive() {
    return this.prisma.vatExemptionBasis.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
      select: {
        id: true,
        code: true,
        name: true,
        paperText: true,
        sefCode: true,
        goesToSef: true,
        sortOrder: true,
      },
    });
  }
}
