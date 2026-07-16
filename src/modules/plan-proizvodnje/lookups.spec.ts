import {
  buildIdentCandidates,
  parseOpRef,
  pickBestBigtehnWoRow,
  sanitizeDrawingNo,
  sortTpOptions,
  type BigtehnWoRow,
} from "./lookups";

/**
 * C2-P7 lookup kanonizacija (GAP-PM-26). Port 1.0 fetchBigtehnOpSnapshotByRnAndTp:
 * 9400 dash/slash redosled kandidata (kosa crta kanon, dash fallback),
 * pickBest izbor, placeholder-tacka sanitizacija.
 */
describe("plan-proizvodnje lookups — kanonizacija", () => {
  describe("buildIdentCandidates: 9400 dash/slash", () => {
    it("kosa crta prva, dash forma tek fallback (9400, TP -2/334)", () => {
      const { ident, opForIdent, opHy, opPairNoLead } = parseOpRef("9400", "-2/334");
      const cands = buildIdentCandidates(ident, opForIdent, opHy, opPairNoLead);
      // TP -2/334 (opHy) na 9400: preskace genericki 9400/-2/334,
      // dodaje samo legacy dash 9400-2/334.
      expect(cands).toEqual(["9400-2/334"]);
    });

    it("bez vodeceg minusa (9400, TP 2/334): kosa crta PRE dash", () => {
      const { ident, opForIdent, opHy, opPairNoLead } = parseOpRef("9400", "2/334");
      const cands = buildIdentCandidates(ident, opForIdent, opHy, opPairNoLead);
      expect(cands[0]).toBe("9400/2/334");
      expect(cands).toContain("9400-2/334");
      expect(cands.indexOf("9400/2/334")).toBeLessThan(
        cands.indexOf("9400-2/334"),
      );
    });

    it("obican RN (9000, TP 488): samo 9000/488, bez dash grananja", () => {
      const { ident, opForIdent, opHy, opPairNoLead } = parseOpRef("9000", "488");
      const cands = buildIdentCandidates(ident, opForIdent, opHy, opPairNoLead);
      expect(cands).toEqual(["9000/488"]);
    });

    it("bez TP ref-a: fallback na sam nalog", () => {
      const { ident, opForIdent, opHy, opPairNoLead } = parseOpRef("7351", "");
      const cands = buildIdentCandidates(ident, opForIdent, opHy, opPairNoLead);
      expect(cands).toEqual(["7351"]);
    });
  });

  describe("parseOpRef: opNumRoute za komada_done", () => {
    it("-2/415 → route operacija = 415", () => {
      expect(parseOpRef("9400", "-2/415").opNumRoute).toBe(415);
    });
    it("9400 2/415 (bez minusa) → route operacija = 415", () => {
      expect(parseOpRef("9400", "2/415").opNumRoute).toBe(415);
    });
    it("cist broj 522 → route = 522", () => {
      expect(parseOpRef("9000", "522").opNumRoute).toBe(522);
    });
    it("alfanumericki 7-5-S1 → route = null (nema komada_done)", () => {
      expect(parseOpRef("9400", "7-5-S1").opNumRoute).toBeNull();
    });
  });

  describe("pickBestBigtehnWoRow", () => {
    const rows: BigtehnWoRow[] = [
      { id: 1, ident_broj: "9400-2/334", broj_crteza: "1121888" }, // dash (star)
      { id: 2, ident_broj: "9400/2/334", broj_crteza: "1129456" }, // kosa (tekuci)
    ];
    it("tacan nalog/tp match pobedjuje (kosa crta)", () => {
      const best = pickBestBigtehnWoRow(rows, "9400", "2/334");
      expect(best?.id).toBe(2);
    });
    it("jedan red → taj red", () => {
      expect(pickBestBigtehnWoRow([rows[0]], "9400", "2/334")?.id).toBe(1);
    });
    it("prazan skup → null", () => {
      expect(pickBestBigtehnWoRow([], "9400", "2/334")).toBeNull();
    });
  });

  describe("sanitizeDrawingNo: placeholder tacke", () => {
    it("cisto-tacka placeholder → null", () => {
      expect(sanitizeDrawingNo(".")).toBeNull();
      expect(sanitizeDrawingNo("..")).toBeNull();
    });
    it("trailing tacka se skida", () => {
      expect(sanitizeDrawingNo("1129456.")).toBe("1129456");
    });
    it("prazan / whitespace → null", () => {
      expect(sanitizeDrawingNo("   ")).toBeNull();
    });
    it("cist broj prolazi", () => {
      expect(sanitizeDrawingNo("1129456")).toBe("1129456");
    });
  });

  describe("sortTpOptions", () => {
    it("numericki TP sortiran kao brojevi (2 pre 10)", () => {
      const out = sortTpOptions([{ tp: "10" }, { tp: "2" }, { tp: "1" }]);
      expect(out.map((o) => o.tp)).toEqual(["1", "2", "10"]);
    });
  });
});
