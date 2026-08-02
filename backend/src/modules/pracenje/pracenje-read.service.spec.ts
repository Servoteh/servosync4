import {
  compareIdent,
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

describe("compareIdent — prirodan red RN identa (zahtev 053/26 §2)", () => {
  const sorted = (a: string[]) => a.slice().sort(compareIdent);

  it("numerički sufiks ide prirodno (9000/2 pre 9000/10), ne po code-pointu", () => {
    // Živi predmet 9000 („Perun") ima 607 korena ovog oblika — čisto tekstualno poređenje
    // bi dalo 9000/1, 9000/10, 9000/100, …, 9000/2 (gore nego danas na ekranu).
    expect(sorted(["9000/10", "9000/100", "9000/2", "9000/1"])).toEqual([
      "9000/1",
      "9000/2",
      "9000/10",
      "9000/100",
    ]);
  });

  it("više numeričkih blokova + tačkasta numeracija", () => {
    expect(sorted(["9400/2.10", "9400/2.2", "9400/10.1", "9400/2.1"])).toEqual([
      "9400/2.1",
      "9400/2.2",
      "9400/2.10",
      "9400/10.1",
    ]);
  });

  it("vodeće nule ne prave razliku u vrednosti, ali red je stabilan", () => {
    expect(compareIdent("9000/007", "9000/7")).toBe(0);
    expect(sorted(["9000/010", "9000/9"])).toEqual(["9000/9", "9000/010"]);
  });

  it("dugi nizovi cifara bez gubitka preciznosti (bez Number)", () => {
    expect(
      compareIdent("RN/99999999999999999998", "RN/99999999999999999999"),
    ).toBeLessThan(0);
  });

  it("slovni delovi po code-pointu; prefiks pre dužeg identa", () => {
    expect(sorted(["9400-2/1", "8400-2/1"])).toEqual(["8400-2/1", "9400-2/1"]);
    expect(compareIdent("9400/1", "9400/1-A")).toBeLessThan(0);
    expect(compareIdent("A", "A")).toBe(0);
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

  it("odbijen override se NE emituje kao primenjen (zahtev 053/26 §2)", () => {
    // Opseg po sklopu: cilj override-a (999) nije učitan → BE ostaje na auto roditelju,
    // ali je ranije i dalje emitovao has_parent_override=true + sirov cilj, pa je FE red
    // vezivao za 999, nije ga našao među čvorovima i crtao ga kao koren (nivo 0).
    const out = reparentNodes([
      node({ rn_id: 1, parent_rn_id: null }),
      node({
        rn_id: 2,
        parent_rn_id: 1,
        has_parent_override: true,
        parent_override_rn_id: 999,
      }),
    ]);
    const two = out.find((n) => n.rn_id === 2)!;
    expect(two.has_parent_override).toBe(false); // NIJE primenjen
    expect(two.override_ignored).toBe(true);
    expect(two.parent_override_rn_id).toBe(999); // sirov cilj ostaje (dijalog)
    expect(two.parent_rn_id).toBe(1); // efektivni roditelj = auto

    // Isto važi za odbijen override zbog ciklusa…
    const cyc = reparentNodes([
      node({
        rn_id: 1,
        parent_rn_id: null,
        has_parent_override: true,
        parent_override_rn_id: 2,
      }),
      node({ rn_id: 2, parent_rn_id: 1 }),
    ]).find((n) => n.rn_id === 1)!;
    expect(cyc.has_parent_override).toBe(false);
    expect(cyc.override_ignored).toBe(true);

    // …i za self-referencu.
    const self = reparentNodes([
      node({ rn_id: 1, parent_rn_id: null }),
      node({
        rn_id: 2,
        parent_rn_id: 1,
        has_parent_override: true,
        parent_override_rn_id: 2,
      }),
    ]).find((n) => n.rn_id === 2)!;
    expect(self.has_parent_override).toBe(false);
    expect(self.override_ignored).toBe(true);
    expect(self.parent_rn_id).toBe(1);
  });

  it("PRIMENJEN override izlazi kao has_parent_override=true, override_ignored=false", () => {
    const out = reparentNodes([
      node({ rn_id: 1, parent_rn_id: null }),
      node({ rn_id: 2, parent_rn_id: 1 }),
      node({
        rn_id: 3,
        parent_rn_id: 2,
        has_parent_override: true,
        parent_override_rn_id: 1,
      }),
    ]);
    const three = out.find((n) => n.rn_id === 3)!;
    expect(three.has_parent_override).toBe(true);
    expect(three.override_ignored).toBe(false);
    expect(three.parent_rn_id).toBe(1);

    // Čvor bez override-a nikad ne dobija nijednu od te dve zastavice.
    const one = out.find((n) => n.rn_id === 1)!;
    expect(one.has_parent_override).toBe(false);
    expect(one.override_ignored).toBe(false);
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

/**
 * Redosled redova (zahtev 053/26 §2 — „deca se odvajaju od sklopa"). Raniji sort je poredio
 * SIROVE `root_rn_id`/`path_idrn` = `work_orders.id` = redosled unosa u bazu, pa je i poredak
 * korena i poredak braće bio nasumičan u odnosu na ident numeraciju, a pozicija bez sastavnice
 * (sopstveni koren) upadala IZMEĐU sklopova. Sada je pre-order po lancu `sort_order`-a.
 */
describe("reparentNodes — poredak redova (zahtev 053/26 §2)", () => {
  /** Svako dete mora doći odmah unutar neprekidnog bloka svog roditelja (pre-order). */
  function assertContiguous(out: ProjectNodeRow[]): void {
    const pos = new Map(out.map((n, i) => [n.rn_id, i] as const));
    for (const n of out) {
      // Roditelj mora biti PRE deteta…
      if (n.parent_rn_id != null && pos.has(n.parent_rn_id)) {
        expect(pos.get(n.parent_rn_id)!).toBeLessThan(pos.get(n.rn_id)!);
      }
      // …a ceo blok potomaka je neprekidan: svi redovi između čvora i njegovog poslednjeg
      // potomka moraju biti potomci tog čvora (niko tuđi se ne uvlači u sredinu).
      const desc = out.filter((d) => d.path_idrn.includes(n.rn_id) && d.rn_id !== n.rn_id);
      if (desc.length === 0) continue;
      const idxs = desc.map((d) => pos.get(d.rn_id)!);
      const lo = Math.min(...idxs);
      const hi = Math.max(...idxs);
      expect(lo).toBe(pos.get(n.rn_id)! + 1);
      expect(hi - lo + 1).toBe(desc.length);
    }
  }

  /**
   * Slučaj sa slike (predmet 9400): dva sklopa + pozicija BEZ sastavnice (sopstveni koren),
   * čiji `work_orders.id` pada IZMEĐU id-jeva ta dva sklopa. Po starom sortu (root id) red je
   * bio sklop-A · POZICIJA · sklop-B — pozicija se ubacila između sklopova, a sklop sa manjim
   * ident brojem („9400/1") bio je ISPOD sklopa „9400/2".
   */
  const scena = () => [
    node({ rn_id: 100, parent_rn_id: null, ident_broj: "9400/2" }),
    node({ rn_id: 101, parent_rn_id: 100, ident_broj: "9400/2.2" }),
    node({ rn_id: 102, parent_rn_id: 100, ident_broj: "9400/2.1" }),
    node({ rn_id: 150, parent_rn_id: null, ident_broj: "9400/3" }), // bez sastavnice
    node({ rn_id: 200, parent_rn_id: null, ident_broj: "9400/1" }),
    node({ rn_id: 201, parent_rn_id: 200, ident_broj: "9400/1.1" }),
  ];

  it("koreni idu po ident broju — pozicija bez sastavnice se više ne uvlači između sklopova", () => {
    const out = reparentNodes(scena());
    expect(out.map((n) => n.rn_id)).toEqual([200, 201, 100, 102, 101, 150]);
    expect(out.map((n) => n.ident_broj)).toEqual([
      "9400/1",
      "9400/1.1",
      "9400/2",
      "9400/2.1",
      "9400/2.2",
      "9400/3",
    ]);
    assertContiguous(out);
  });

  it("deca su uvek neprekidna ispod svog sklopa (i posle re-parenta)", () => {
    assertContiguous(reparentNodes(scena()));
    // Premesti 150 pod sklop 200 → mora da uđe u blok tog sklopa, ne da ostane koren.
    const nodes = scena();
    nodes[3] = node({
      rn_id: 150,
      parent_rn_id: null,
      ident_broj: "9400/3",
      has_parent_override: true,
      parent_override_rn_id: 200,
    });
    const out = reparentNodes(nodes);
    expect(out.map((n) => n.rn_id)).toEqual([200, 201, 150, 100, 102, 101]);
    assertContiguous(out);
  });

  it("braća idu PRIRODNIM ident redom (NULLS LAST), ne po id-ju iz baze", () => {
    const out = reparentNodes([
      node({ rn_id: 10, parent_rn_id: null, ident_broj: "A" }),
      node({ rn_id: 11, parent_rn_id: 10, ident_broj: "9400/10" }),
      node({ rn_id: 12, parent_rn_id: 10, ident_broj: null }), // bez identa → poslednji
      node({ rn_id: 13, parent_rn_id: 10, ident_broj: "9400/2" }),
    ]);
    // „9400/2" pre „9400/10" (numerički blok), pa tek onda ident-less.
    expect(out.map((n) => n.rn_id)).toEqual([10, 13, 11, 12]);
    expect(out.map((n) => n.sort_order)).toEqual([1, 1, 2, 3]);
  });

  it("determinističan tie-break: isti ident → po rn_id (ne po redosledu unosa)", () => {
    const a = reparentNodes([
      node({ rn_id: 5, parent_rn_id: null, ident_broj: "X" }),
      node({ rn_id: 3, parent_rn_id: null, ident_broj: "X" }),
    ]).map((n) => n.rn_id);
    const b = reparentNodes([
      node({ rn_id: 3, parent_rn_id: null, ident_broj: "X" }),
      node({ rn_id: 5, parent_rn_id: null, ident_broj: "X" }),
    ]).map((n) => n.rn_id);
    expect(a).toEqual([3, 5]);
    expect(b).toEqual([3, 5]);
  });

  it("duboko stablo (3 nivoa) ostaje pre-order po ident lancu", () => {
    const out = reparentNodes([
      node({ rn_id: 1, parent_rn_id: null, ident_broj: "S" }),
      node({ rn_id: 2, parent_rn_id: 1, ident_broj: "S/2" }),
      node({ rn_id: 3, parent_rn_id: 1, ident_broj: "S/1" }),
      node({ rn_id: 4, parent_rn_id: 3, ident_broj: "S/1/b" }),
      node({ rn_id: 5, parent_rn_id: 3, ident_broj: "S/1/a" }),
    ]);
    expect(out.map((n) => n.ident_broj)).toEqual([
      "S",
      "S/1",
      "S/1/a",
      "S/1/b",
      "S/2",
    ]);
    expect(out.map((n) => n.nivo)).toEqual([0, 1, 2, 2, 1]);
    assertContiguous(out);
  });
});
