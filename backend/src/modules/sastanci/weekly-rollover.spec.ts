import {
  SEDMICNI_PODRAZUMEVANO_VREME,
  sledeciSedmicniTermin,
  type SedmicniRed,
} from "./weekly-rollover";

/**
 * Zahtev 024/26 (a) — posle zatvaranja sedmičnog sastanka pregled je pokazivao
 * poslednji (zatvoreni) termin, jer sledeći red nastaje TEK petkom u 08h
 * (`sast_auto_create_weekly`). Ovi testovi pinuju da najava odgovara onome što će
 * baza stvarno napraviti.
 */
describe("sledeciSedmicniTermin — najava sedmičnog (paritet sast_auto_create_weekly)", () => {
  const prazno = { sedmicni: [] as SedmicniRed[], praznici: [] as string[] };

  it("scenario 024/26: ponedeljak 27.07, zatvoren stari sedmični → najava 03.08 (kreira se u petak 31.07)", () => {
    const r = sledeciSedmicniTermin({
      danas: "2026-07-27",
      sat: 10,
      // Zatvoren 20.07 je PROŠAO — u ulazu (datum >= danas) ga i nema.
      sedmicni: [],
      praznici: [],
    });
    expect(r).toEqual({
      datum: "2026-08-03",
      vreme: SEDMICNI_PODRAZUMEVANO_VREME,
      sastanakId: null,
      kreiraSeDatum: "2026-07-31",
    });
  });

  it("već kreiran predstojeći sedmični je sam po sebi sledeći termin (bez najave)", () => {
    const r = sledeciSedmicniTermin({
      ...prazno,
      danas: "2026-08-01",
      sat: 9,
      sedmicni: [
        { id: "a", datum: "2026-08-03", vreme: "09:00", status: "planiran" },
      ],
    });
    expect(r).toEqual({
      datum: "2026-08-03",
      vreme: "09:00",
      sastanakId: "a",
      kreiraSeDatum: null,
    });
  });

  it("zaključan termin u budućnosti zauzima nedelju — najava ide na sledeću slobodnu", () => {
    // 03.08 je zaključan (status <> 'otkazan') → automatika tu nedelju preskače.
    const r = sledeciSedmicniTermin({
      ...prazno,
      danas: "2026-07-27",
      sat: 10,
      sedmicni: [
        { id: "a", datum: "2026-08-03", vreme: "09:00", status: "zakljucan" },
      ],
    });
    expect(r?.datum).toBe("2026-08-10");
    expect(r?.kreiraSeDatum).toBe("2026-08-07");
    expect(r?.sastanakId).toBeNull();
  });

  it("OTKAZAN sedmični ne blokira nedelju (fn gleda `status <> otkazan`)", () => {
    const r = sledeciSedmicniTermin({
      ...prazno,
      danas: "2026-07-27",
      sat: 10,
      sedmicni: [
        { id: "a", datum: "2026-08-03", vreme: "09:00", status: "otkazan" },
      ],
    });
    expect(r?.datum).toBe("2026-08-03");
    expect(r?.kreiraSeDatum).toBe("2026-07-31");
  });

  it("petak PRE 08h → posao je još pred nama (kreira danas); posle 08h → tek sledeći petak", () => {
    const pre = sledeciSedmicniTermin({
      ...prazno,
      danas: "2026-07-31",
      sat: 7,
    });
    expect(pre).toMatchObject({
      datum: "2026-08-03",
      kreiraSeDatum: "2026-07-31",
    });
    const posle = sledeciSedmicniTermin({
      ...prazno,
      danas: "2026-07-31",
      sat: 8,
    });
    expect(posle).toMatchObject({
      datum: "2026-08-10",
      kreiraSeDatum: "2026-08-07",
    });
  });

  it("vikend posle petka gleda naredni petak (posao te nedelje je prošao)", () => {
    expect(
      sledeciSedmicniTermin({ ...prazno, danas: "2026-08-01", sat: 12 }),
    ).toMatchObject({ datum: "2026-08-10", kreiraSeDatum: "2026-08-07" });
  });

  it("neradni praznik u ponedeljak pomera termin na prvi radni dan (paritet sast_adjust_for_holiday)", () => {
    const r = sledeciSedmicniTermin({
      danas: "2026-07-27",
      sat: 10,
      sedmicni: [],
      praznici: ["2026-08-03", "2026-08-04"],
    });
    expect(r?.datum).toBe("2026-08-05");
    expect(r?.kreiraSeDatum).toBe("2026-07-31");
  });

  it("`u_toku` sedmični se računa kao predstojeći, a najstariji predstojeći pobeđuje", () => {
    const r = sledeciSedmicniTermin({
      ...prazno,
      danas: "2026-07-27",
      sat: 10,
      sedmicni: [
        { id: "b", datum: "2026-08-10", vreme: "09:00", status: "planiran" },
        { id: "a", datum: "2026-08-03", vreme: "10:30", status: "u_toku" },
      ],
    });
    expect(r).toMatchObject({ sastanakId: "a", datum: "2026-08-03", vreme: "10:30" });
  });

  it("svaka nedelja u horizontu popunjena → nema šta da se najavi (null)", () => {
    const sedmicni: SedmicniRed[] = [];
    for (let i = 0; i < 10; i++) {
      const d = new Date(Date.UTC(2026, 7, 3) + i * 7 * 86_400_000);
      sedmicni.push({
        id: `x${i}`,
        datum: d.toISOString().slice(0, 10),
        vreme: "09:00",
        status: "zakljucan",
      });
    }
    expect(
      sledeciSedmicniTermin({ danas: "2026-07-27", sat: 10, sedmicni, praznici: [] }),
    ).toBeNull();
  });
});
