import { companyAddressLine, companyPlace } from "./company-address";

/**
 * Odluka O-F10: mesto i poštanski broj su DVA podatka. Ovo je brana nad oblikom u kom
 * se ponovo spajaju — da se deset štampi ne raziđe u „11272, Dobanovci" i „Dobanovci 11272".
 */
describe("adresa firme-izdavaoca (O-F10)", () => {
  it("spaja poštanski broj i mesto kako stoji na memorandumu", () => {
    expect(companyPlace("11272", "Dobanovci")).toBe("11272 Dobanovci");
    expect(companyAddressLine("Ugrinovačka 163", "11272", "Dobanovci")).toBe(
      "Ugrinovačka 163, 11272 Dobanovci",
    );
  });

  it("prazno polje se izostavlja — nikad red koji počinje zarezom ili visi razmak", () => {
    expect(companyAddressLine(null, "11272", "Dobanovci")).toBe(
      "11272 Dobanovci",
    );
    expect(companyAddressLine("Ugrinovačka 163", null, "Dobanovci")).toBe(
      "Ugrinovačka 163, Dobanovci",
    );
    expect(companyAddressLine("Ugrinovačka 163", "11272", null)).toBe(
      "Ugrinovačka 163, 11272",
    );
    expect(companyAddressLine(null, null, null)).toBe("");
  });

  /**
   * Produkcijski zapis firme je do 03.08.2026. bio gotovo prazan (`address=''`,
   * `city=''`) — sami razmaci i prazni stringovi ne smeju da proizvedu red od zareza.
   */
  it("sami razmaci se ponašaju kao prazno polje", () => {
    expect(companyAddressLine("  ", "  ", "  ")).toBe("");
    expect(companyPlace("  ", "Dobanovci")).toBe("Dobanovci");
  });
});
