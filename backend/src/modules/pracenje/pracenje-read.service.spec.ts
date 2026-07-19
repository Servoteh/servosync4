import {
  effectiveCompleted,
  reparentNodes,
  type ProjectNodeRow,
} from "./pracenje-read.service";

/**
 * Unit pokrivenost čistih helpera READ sloja praćenja (bez baze):
 *  - `effectiveCompleted` — klamp na lansirano + override>auto precedenca (finding #1b/#2);
 *  - `reparentNodes` — primena structure-override-a u stablu + anti-ciklus (finding #7),
 *    uz izvedeni `has_parent_crtez_file` iz roditeljskog čvora (finding #6).
 */

/** Fabrika ProjectNodeRow-a sa razumnim default-ima; test prepisuje samo relevantna polja. */
function node(p: Partial<ProjectNodeRow> & { rn_id: number }): ProjectNodeRow {
  return {
    rn_id: p.rn_id,
    parent_rn_id: p.parent_rn_id ?? null,
    root_rn_id: p.root_rn_id ?? p.rn_id,
    nivo: p.nivo ?? 0,
    broj_komada: p.broj_komada ?? 1,
    path_idrn: p.path_idrn ?? [p.rn_id],
    // Poštuj eksplicitno prosleđen null (test NULLS-LAST ga koristi); default samo ako je izostavljen.
    ident_broj: "ident_broj" in p ? (p.ident_broj ?? null) : String(p.rn_id),
    broj_crteza: p.broj_crteza ?? null,
    naziv_dela: p.naziv_dela ?? null,
    materijal: p.materijal ?? null,
    dimenzija: p.dimenzija ?? null,
    komada: p.komada ?? 1,
    rok_izrade: p.rok_izrade ?? null,
    status_rn: p.status_rn ?? null,
    datum_unosa: p.datum_unosa ?? null,
    wo_napomena: p.wo_napomena ?? null,
    parent_broj_crteza: p.parent_broj_crteza ?? null,
    has_crtez_file: p.has_crtez_file ?? false,
    has_parent_crtez_file: p.has_parent_crtez_file ?? false,
    korisnicka_napomena: p.korisnicka_napomena ?? null,
    status_override: p.status_override ?? null,
    masinska_done_ovr: p.masinska_done_ovr ?? null,
    povrsinska_done_ovr: p.povrsinska_done_ovr ?? null,
    manual_qty: p.manual_qty ?? null,
    has_parent_override: p.has_parent_override ?? false,
    parent_override_rn_id: p.parent_override_rn_id ?? null,
    drawing_handover_id: p.drawing_handover_id ?? null,
    handover_status_id: p.handover_status_id ?? null,
    handover_status_name: p.handover_status_name ?? null,
    handover_oznaka: p.handover_oznaka ?? null,
    sort_order: p.sort_order ?? 1,
  };
}

describe("effectiveCompleted (finding #1b/#2)", () => {
  it("clamps auto completed to lansirano (kk_pct nikad > 100)", () => {
    // Neklampovana završna kontrola (npr. dupli unosi / overshoot) 14 na planu 10.
    const r = effectiveCompleted(10, 14, null, null);
    expect(r.auto).toBe(10);
    expect(r.effective).toBe(10);
    expect(r.overridden).toBe(false);
  });

  it("passes auto through when below lansirano", () => {
    const r = effectiveCompleted(10, 4, null, null);
    expect(r).toEqual({ auto: 4, effective: 4, overridden: false });
  });

  it("status 'kompletirano' → 100% (= lansirano) i overridden", () => {
    const r = effectiveCompleted(10, 3, "kompletirano", null);
    expect(r.auto).toBe(3); // auto ostaje vidljiv posebno
    expect(r.effective).toBe(10);
    expect(r.overridden).toBe(true);
  });

  it("manual_qty zamenjuje izračunatu količinu, klampovano na lansirano", () => {
    expect(effectiveCompleted(10, 2, null, 6)).toEqual({
      auto: 2,
      effective: 6,
      overridden: true,
    });
    // manual_qty preko plana se klampuje
    expect(effectiveCompleted(10, 2, null, 99).effective).toBe(10);
    // negativan manual_qty se ne uzima kao negativan
    expect(effectiveCompleted(10, 2, null, -5).effective).toBe(0);
  });

  it("'kompletirano' ima prednost nad manual_qty", () => {
    expect(effectiveCompleted(10, 0, "kompletirano", 3).effective).toBe(10);
  });

  it("bez ZK-linije i bez količ. override-a → effective null (čuva nema_zavrsnu_kontrolu)", () => {
    expect(effectiveCompleted(10, null, null, null)).toEqual({
      auto: null,
      effective: null,
      overridden: false,
    });
    // status 'u_radu'/'nije_zapoceto' menja labelu, ne količinu → i dalje null
    expect(effectiveCompleted(10, null, "u_radu", null).effective).toBeNull();
    expect(
      effectiveCompleted(10, null, "nije_zapoceto", null).effective,
    ).toBeNull();
  });

  it("null lansirano: 'kompletirano' ne može na 100% (nepoznat plan) → ostaje auto", () => {
    const r = effectiveCompleted(null, 5, "kompletirano", null);
    expect(r.effective).toBe(5);
    expect(r.overridden).toBe(false);
  });
});

describe("reparentNodes (finding #6/#7)", () => {
  it("no-op bez override-a: reprodukuje nivo/koren/path", () => {
    const nodes = [
      node({
        rn_id: 1,
        parent_rn_id: null,
        root_rn_id: 1,
        nivo: 0,
        path_idrn: [1],
      }),
      node({
        rn_id: 2,
        parent_rn_id: 1,
        root_rn_id: 1,
        nivo: 1,
        path_idrn: [1, 2],
      }),
      node({
        rn_id: 3,
        parent_rn_id: 2,
        root_rn_id: 1,
        nivo: 2,
        path_idrn: [1, 2, 3],
      }),
    ];
    const out = reparentNodes(nodes);
    const byId = new Map(out.map((n) => [n.rn_id, n]));
    expect(byId.get(1)!.nivo).toBe(0);
    expect(byId.get(2)!.nivo).toBe(1);
    expect(byId.get(3)!.nivo).toBe(2);
    expect(byId.get(3)!.root_rn_id).toBe(1);
    expect(byId.get(3)!.path_idrn).toEqual([1, 2, 3]);
    expect(byId.get(3)!.parent_rn_id).toBe(2);
  });

  it("re-parent: pozicija se premešta pod drugi sklop, nivo/path se preračunavaju", () => {
    // Auto: 3 je dete od 2. Override: 3 → dete od 1.
    const nodes = [
      node({
        rn_id: 1,
        parent_rn_id: null,
        root_rn_id: 1,
        nivo: 0,
        path_idrn: [1],
      }),
      node({
        rn_id: 2,
        parent_rn_id: 1,
        root_rn_id: 1,
        nivo: 1,
        path_idrn: [1, 2],
      }),
      node({
        rn_id: 3,
        parent_rn_id: 2,
        root_rn_id: 1,
        nivo: 2,
        path_idrn: [1, 2, 3],
        has_parent_override: true,
        parent_override_rn_id: 1,
      }),
    ];
    const three = reparentNodes(nodes).find((n) => n.rn_id === 3)!;
    expect(three.parent_rn_id).toBe(1);
    expect(three.nivo).toBe(1);
    expect(three.path_idrn).toEqual([1, 3]);
    expect(three.root_rn_id).toBe(1);
  });

  it("override parent NULL → čvor postaje koren", () => {
    const nodes = [
      node({
        rn_id: 1,
        parent_rn_id: null,
        root_rn_id: 1,
        nivo: 0,
        path_idrn: [1],
      }),
      node({
        rn_id: 2,
        parent_rn_id: 1,
        root_rn_id: 1,
        nivo: 1,
        path_idrn: [1, 2],
        has_parent_override: true,
        parent_override_rn_id: null,
      }),
    ];
    const two = reparentNodes(nodes).find((n) => n.rn_id === 2)!;
    expect(two.parent_rn_id).toBeNull();
    expect(two.nivo).toBe(0);
    expect(two.root_rn_id).toBe(2);
    expect(two.path_idrn).toEqual([2]);
  });

  it("override ka čvoru van skupa → ignoriše se (ostaje auto)", () => {
    const nodes = [
      node({
        rn_id: 1,
        parent_rn_id: null,
        root_rn_id: 1,
        nivo: 0,
        path_idrn: [1],
      }),
      node({
        rn_id: 2,
        parent_rn_id: 1,
        root_rn_id: 1,
        nivo: 1,
        path_idrn: [1, 2],
        has_parent_override: true,
        parent_override_rn_id: 999, // nije u skupu
      }),
    ];
    const two = reparentNodes(nodes).find((n) => n.rn_id === 2)!;
    expect(two.parent_rn_id).toBe(1); // auto zadržan
    expect(two.nivo).toBe(1);
  });

  it("override koji bi napravio ciklus → preskače se, bez beskonačne petlje", () => {
    // 1 ← 2 (auto). Override: 1 → dete od 2 (napravio bi ciklus 1↔2).
    const nodes = [
      node({
        rn_id: 1,
        parent_rn_id: null,
        root_rn_id: 1,
        nivo: 0,
        path_idrn: [1],
        has_parent_override: true,
        parent_override_rn_id: 2,
      }),
      node({
        rn_id: 2,
        parent_rn_id: 1,
        root_rn_id: 1,
        nivo: 1,
        path_idrn: [1, 2],
      }),
    ];
    const out = reparentNodes(nodes);
    const one = out.find((n) => n.rn_id === 1)!;
    // override odbačen → 1 ostaje koren (auto parent null)
    expect(one.parent_rn_id).toBeNull();
    expect(one.nivo).toBe(0);
    expect(out.find((n) => n.rn_id === 2)!.nivo).toBe(1);
  });

  it("has_parent_crtez_file izveden iz roditeljskog has_crtez_file (pravi EXISTS, finding #6)", () => {
    const nodes = [
      node({
        rn_id: 1,
        parent_rn_id: null,
        broj_crteza: "SKLOP-1",
        has_crtez_file: true,
      }),
      node({
        rn_id: 2,
        parent_rn_id: 1,
        broj_crteza: "POZ-2",
        has_crtez_file: false,
      }),
    ];
    const two = reparentNodes(nodes).find((n) => n.rn_id === 2)!;
    expect(two.has_parent_crtez_file).toBe(true); // roditelj ima PDF
    expect(two.parent_broj_crteza).toBe("SKLOP-1");
    // koren nema roditelja → false
    expect(
      reparentNodes(nodes).find((n) => n.rn_id === 1)!.has_parent_crtez_file,
    ).toBe(false);
  });

  it("sort_order = row_number unutar grupe roditelja po ident_broj (NULLS LAST)", () => {
    const nodes = [
      node({ rn_id: 1, parent_rn_id: null, ident_broj: "A" }),
      node({ rn_id: 2, parent_rn_id: 1, ident_broj: "9400/2" }),
      node({ rn_id: 3, parent_rn_id: 1, ident_broj: "9400/1" }),
      node({ rn_id: 4, parent_rn_id: 1, ident_broj: null }),
    ];
    const out = reparentNodes(nodes);
    const so = new Map(out.map((n) => [n.rn_id, n.sort_order]));
    expect(so.get(3)).toBe(1); // 9400/1 prvi
    expect(so.get(2)).toBe(2); // 9400/2 drugi
    expect(so.get(4)).toBe(3); // null poslednji
  });

  it("prazan ulaz → prazan izlaz", () => {
    expect(reparentNodes([])).toEqual([]);
  });
});
