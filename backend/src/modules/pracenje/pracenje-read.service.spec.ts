import {
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import {
  PracenjeReadService,
  compareIdent,
  effectiveCompleted,
  reparentNodes,
  type ProjectNodeRow,
} from "./pracenje-read.service";
import type { PrismaService } from "../../prisma/prisma.service";
import { isVirtualNode, virtualDbId, virtualNodeId } from "./virtual-node";

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
    is_virtual: p.is_virtual,
    tip_sklopa: p.tip_sklopa,
    sort_order: p.sort_order ?? 1,
  };
}

/**
 * Sintetički čvor VIRTUELNOG (ručno napravljenog) sklopa — onako kako ga pravi
 * `PracenjeReadService.virtualToNode`: negativan id, bez identa/crteža/količina, roditelj
 * ISKLJUČIVO iz structure-override-a (nema sastavnice).
 */
function vnode(
  dbId: number,
  naziv: string,
  parentNodeId?: number | null,
): ProjectNodeRow {
  return node({
    rn_id: virtualNodeId(dbId),
    parent_rn_id: null,
    ident_broj: null,
    naziv_dela: naziv,
    komada: null,
    is_virtual: true,
    tip_sklopa: "pod",
    ...(parentNodeId !== undefined
      ? { has_parent_override: true, parent_override_rn_id: parentNodeId }
      : {}),
  });
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
      const desc = out.filter(
        (d) => d.path_idrn.includes(n.rn_id) && d.rn_id !== n.rn_id,
      );
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

/**
 * VIRTUELNI (ručno napravljen) sklop — zahtev 053/26 paket 2. Sklop koji NEMA radni nalog
 * ni tehnologiju živi u `pracenje_virtuelni_sklopovi`, a u stablu se pojavljuje kao čvor sa
 * NEGATIVNIM id-jem (-id). Ovde se pini da isti `reparentNodes` (jedan numerički prostor
 * ključeva) nosi i takve čvorove: nivo/putanja/poredak/ciklus-guard bez posebne grane.
 */
describe("reparentNodes — virtuelni sklop (zahtev 053/26 paket 2)", () => {
  it("kodiranje id-ja: -id je virtuelni čvor, RN id nikad nije", () => {
    expect(isVirtualNode(virtualNodeId(7))).toBe(true);
    expect(virtualDbId(virtualNodeId(7))).toBe(7);
    expect(isVirtualNode(40681)).toBe(false);
    expect(isVirtualNode(null)).toBe(false);
  });

  it("sklop bez roditelja i BEZ DECE i dalje izlazi kao koren (puni se posle kreiranja)", () => {
    const out = reparentNodes([
      node({ rn_id: 1, parent_rn_id: null, ident_broj: "9400/1" }),
      vnode(7, "Ručni sklop"),
    ]);
    const v = out.find((n) => n.rn_id === -7)!;
    expect(v).toBeDefined();
    expect(v.nivo).toBe(0);
    expect(v.parent_rn_id).toBeNull();
    expect(v.path_idrn).toEqual([-7]);
    expect(v.is_virtual).toBe(true);
  });

  it("POZICIJA se premešta POD virtuelni sklop (nivo/putanja preko negativnog čvora)", () => {
    const out = reparentNodes([
      vnode(7, "Ručni sklop"),
      node({
        rn_id: 100,
        parent_rn_id: null,
        ident_broj: "9400/5",
        has_parent_override: true,
        parent_override_rn_id: -7,
      }),
    ]);
    const poz = out.find((n) => n.rn_id === 100)!;
    expect(poz.parent_rn_id).toBe(-7);
    expect(poz.nivo).toBe(1);
    expect(poz.path_idrn).toEqual([-7, 100]);
    expect(poz.root_rn_id).toBe(-7);
    expect(poz.has_parent_override).toBe(true);
    expect(poz.override_ignored).toBe(false);
    expect(out.map((n) => n.rn_id)).toEqual([-7, 100]); // sklop PRE deteta (pre-order)
  });

  it("virtuelni sklop se premešta POD pravi RN (obrnut smer — sklop u sklopu)", () => {
    const out = reparentNodes([
      node({ rn_id: 1, parent_rn_id: null, ident_broj: "9400/1" }),
      vnode(7, "Ručni sklop", 1),
    ]);
    const v = out.find((n) => n.rn_id === -7)!;
    expect(v.parent_rn_id).toBe(1);
    expect(v.nivo).toBe(1);
    expect(v.path_idrn).toEqual([1, -7]);
    expect(v.has_parent_override).toBe(true);
  });

  it("virtuelni POD virtuelnim (dva nivoa ručnih sklopova) + pozicija u dubljem", () => {
    const out = reparentNodes([
      vnode(1, "Glavni ručni"),
      vnode(2, "Ugnežđeni ručni", -1),
      node({
        rn_id: 500,
        parent_rn_id: null,
        ident_broj: "9400/9",
        has_parent_override: true,
        parent_override_rn_id: -2,
      }),
    ]);
    const byId = new Map(out.map((n) => [n.rn_id, n]));
    expect(byId.get(-2)!.nivo).toBe(1);
    expect(byId.get(-2)!.parent_rn_id).toBe(-1);
    expect(byId.get(500)!.nivo).toBe(2);
    expect(byId.get(500)!.path_idrn).toEqual([-1, -2, 500]);
    expect(out.map((n) => n.rn_id)).toEqual([-1, -2, 500]);
  });

  it("ciklus virtuelni→virtuelni (A pod B, B pod A) → override se odbija, bez petlje", () => {
    const out = reparentNodes([vnode(1, "A", -2), vnode(2, "B", -1)]);
    const a = out.find((n) => n.rn_id === -1)!;
    const b = out.find((n) => n.rn_id === -2)!;
    // Bar jedan override MORA pasti — inače je stablo petlja.
    expect(a.has_parent_override && b.has_parent_override).toBe(false);
    expect(out).toHaveLength(2); // ništa se ne gubi
    // Nijedan čvor nije sam sebi predak (putanja ga sadrži tačno jednom, kao poslednjeg).
    for (const n of out) {
      expect(n.path_idrn.filter((id) => id === n.rn_id)).toHaveLength(1);
      expect(n.path_idrn[n.path_idrn.length - 1]).toBe(n.rn_id);
    }
  });

  it("self-parent virtuelnog sklopa → odbijeno (ostaje koren)", () => {
    const v = reparentNodes([vnode(7, "A", -7)]).find((n) => n.rn_id === -7)!;
    expect(v.has_parent_override).toBe(false);
    expect(v.override_ignored).toBe(true);
    expect(v.nivo).toBe(0);
  });

  it("braća: virtuelni sklop se poredi po NAZIVU (nema ident), ne pada na dno kao NULL", () => {
    const out = reparentNodes([
      node({ rn_id: 1, parent_rn_id: null, ident_broj: "A" }),
      node({ rn_id: 2, parent_rn_id: 1, ident_broj: "M-poz" }),
      vnode(7, "B-ručni", 1),
      vnode(8, "Z-ručni", 1),
    ]);
    // B-ručni < M-poz < Z-ručni (isti prirodan komparator, ključ = naziv za virtuelne).
    expect(out.map((n) => n.rn_id)).toEqual([1, -7, 2, -8]);
    const so = new Map(out.map((n) => [n.rn_id, n.sort_order]));
    expect(so.get(-7)).toBe(1);
    expect(so.get(2)).toBe(2);
    expect(so.get(-8)).toBe(3);
  });

  it("cilj override-a van učitanog opsega → sklop ostaje koren, `override_ignored`", () => {
    const v = reparentNodes([vnode(7, "A", -999)]).find((n) => n.rn_id === -7)!;
    expect(v.has_parent_override).toBe(false);
    expect(v.override_ignored).toBe(true);
    expect(v.parent_override_rn_id).toBe(-999); // sirov cilj ostaje (dijalog ga pokazuje)
  });
});

// ============================================================================
// READ sloj nad MOKOVANOM bazom — virtuelni sklop u `izvestaj` / `podsklopovi`
// ============================================================================

/** Redovi koje mokovana baza vraća po tipu upita (prepoznaje se po tekstu SQL-a). */
interface DbFixture {
  project?: Record<string, unknown>[];
  struktura?: Record<string, unknown>[];
  virtuelni?: Record<string, unknown>[];
  operations?: Record<string, unknown>[];
}

/**
 * Minimalan Prisma mock: `$queryRaw` grana po TEKSTU upita (`Prisma.sql` nosi `strings`),
 * pa test ne zavisi od redosleda poziva. Pokriva tačno upite koje `izvestaj`/`podsklopovi`
 * izvršavaju u ovim scenarijima.
 */
function makeReadPrisma(fx: DbFixture) {
  const virtuelni = fx.virtuelni ?? [];
  const struktura = fx.struktura ?? [];
  return {
    $queryRaw: jest.fn(
      async (q: { strings?: string[]; values?: unknown[] }) => {
        const sql = (q.strings ?? []).join(" ");
        if (sql.includes("pracenje_virtuelni_sklopovi")) return virtuelni;
        if (sql.includes("FROM projects p")) return fx.project ?? [];
        if (sql.includes("WITH RECURSIVE struktura")) return struktura;
        if (sql.includes("FROM work_order_operations op"))
          return fx.operations ?? [];
        // Zaglavlje opsega po REALNOM RN-u (`SELECT w.id::int AS node_id … WHERE w.id = $1`):
        // postoji ako je taj RN u strukturi predmeta.
        if (sql.includes("AS node_id")) {
          const rootRn = Number((q.values ?? [])[0]);
          const hit = struktura.find((n) => n.rn_id === rootRn);
          return hit
            ? [
                {
                  node_id: rootRn,
                  naziv: hit.naziv_dela,
                  broj_crteza: "",
                  nivo: 0,
                },
              ]
            : [];
        }
        return [];
      },
    ),
    pracenjeVirtuelniSklop: {
      findFirst: jest.fn(async (args: { where: { id: number } }) => {
        const row = virtuelni.find((v) => v.id === args.where.id);
        return row ? { naziv: row.naziv, tip: row.tip } : null;
      }),
    },
  };
}

/** Sirov red `struktura` upita (SQL kolone) sa razumnim default-ima. */
function dbNode(p: { rn_id: number } & Record<string, unknown>) {
  return {
    parent_rn_id: null,
    root_rn_id: p.rn_id,
    nivo: 0,
    broj_komada: 1,
    path_idrn: [p.rn_id],
    ident_broj: `9400/${p.rn_id}`,
    broj_crteza: null,
    naziv_dela: `Pozicija ${p.rn_id}`,
    materijal: null,
    dimenzija: null,
    komada: 10,
    rok_izrade: null,
    status_rn: null,
    datum_unosa: null,
    wo_napomena: null,
    parent_broj_crteza: null,
    has_crtez_file: false,
    korisnicka_napomena: null,
    status_override: null,
    masinska_done_ovr: null,
    povrsinska_done_ovr: null,
    manual_qty: null,
    has_parent_override: false,
    parent_override_rn_id: null,
    drawing_handover_id: null,
    handover_status_id: null,
    handover_status_name: null,
    handover_oznaka: null,
    sort_order: 1,
    ...p,
  };
}

const PROJECT_FX = [
  {
    item_id: 7602,
    broj_predmeta: "9400",
    naziv_predmeta: "Perun",
    komitent: "X",
    rok_zavrsetka: null,
  },
];

const VS_FX = (over: Record<string, unknown> = {}) => ({
  id: 7,
  naziv: "Ručni sklop",
  tip: "pod",
  has_parent_override: false,
  parent_override_rn_id: null,
  korisnicka_napomena: null,
  ...over,
});

describe("PracenjeReadService — virtuelni sklop u izveštaju (053/26 paket 2)", () => {
  const svc = (fx: DbFixture) =>
    new PracenjeReadService(makeReadPrisma(fx) as unknown as PrismaService);

  it("izvestaj: PRAZAN ručni sklop se emituje (korisnik ga tek posle puni)", async () => {
    const res = await svc({
      project: PROJECT_FX,
      struktura: [dbNode({ rn_id: 1 })],
      virtuelni: [VS_FX({ tip: "glavni" })],
    }).izvestaj("a@b.c", 7602, {});
    const rows = res.data.rows;
    const v = rows.find((r) => r.node_id === -7)!;
    expect(v).toBeDefined();
    expect(v.tip_reda).toBe("virtuelni_sklop");
    expect(v.is_virtual).toBe(true);
    expect(v.tip_sklopa).toBe("glavni");
    expect(v.naziv_pozicije).toBe("Ručni sklop");
    // Nijedno RN polje ne sme da „procuri" (FE po njima crta akcije).
    expect(v.rn_id).toBeNull();
    expect(v.rn_broj).toBe("");
    expect(v.broj_crteza).toBe("");
    expect(v.lansirana_kolicina).toBeNull();
    expect(v.zavrsena_kolicina).toBeNull();
    expect(v.masinska_total).toBeNull();
    expect(v.operations).toEqual([]);
    // …i ne sme da se broji kao problem (crven red / brojači u sumaru).
    expect(v.statusi).toEqual({
      kasni: false,
      nema_tp: false,
      nema_crtez: false,
      nema_zavrsnu_kontrolu: false,
      nije_kompletirano: false,
      nema_rn: false,
    });
    expect(res.data.summary.count_nema_tp).toBe(1); // samo prava pozicija
    expect(res.data.summary.count_nema_crtez).toBe(1);
  });

  it("izvestaj: pozicija premeštena POD ručni sklop dobija nivo 1 i tog roditelja", async () => {
    const res = await svc({
      project: PROJECT_FX,
      struktura: [
        dbNode({ rn_id: 1 }),
        dbNode({
          rn_id: 2,
          has_parent_override: true,
          parent_override_rn_id: -7,
        }),
      ],
      virtuelni: [VS_FX({ korisnicka_napomena: "beleška" })],
    }).izvestaj("a@b.c", 7602, {});
    const rows = res.data.rows;
    const poz = rows.find((r) => r.node_id === 2)!;
    expect(poz.parent_node_id).toBe(-7);
    expect(poz.level).toBe(1);
    // Napomena se vodi i na ručnom sklopu (isti meki ključ u `pracenje_notes`).
    expect(rows.find((r) => r.node_id === -7)!.korisnicka_napomena).toBe(
      "beleška",
    );
  });

  it("izvestaj sa opsegom po RUČNOM sklopu (rootRn = -7): koren + samo njegova deca", async () => {
    const res = await svc({
      project: PROJECT_FX,
      struktura: [
        dbNode({
          rn_id: 2,
          has_parent_override: true,
          parent_override_rn_id: -7,
        }),
      ],
      virtuelni: [VS_FX({ tip: "zav" })],
    }).izvestaj("a@b.c", 7602, { rootRn: "-7" });
    expect(res.data.root).toMatchObject({
      node_id: -7,
      naziv: "Ručni sklop",
      is_virtual: true,
      tip_sklopa: "zav",
    });
    expect(res.data.rows.map((r) => r.node_id)).toEqual([-7, 2]);
  });

  it("izvestaj: nepostojeći ručni sklop kao opseg → 404 (ne tiho prazna tabela)", async () => {
    await expect(
      svc({ project: PROJECT_FX, virtuelni: [] }).izvestaj("a@b.c", 7602, {
        rootRn: "-99",
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("podsklopovi: ručni sklopovi su u listi (Opseg/drill-down) sa negativnim rn_id", async () => {
    const res = await svc({
      struktura: [dbNode({ rn_id: 1 })],
      virtuelni: [VS_FX()],
    }).podsklopovi("a@b.c", 7602);
    const v = res.data.find((r) => r.rn_id === -7)!;
    expect(v).toBeDefined();
    expect(v.is_virtual).toBe(true);
    expect(v.tip_sklopa).toBe("pod");
    expect(v.naziv_dela).toBe("Ručni sklop");
    expect(v.ident_broj).toBe("");
    // Prava pozicija nosi is_virtual=false (FE ne pogađa po predznaku id-ja).
    expect(res.data.find((r) => r.rn_id === 1)!.is_virtual).toBe(false);
  });

  it("RN rute odbijaju negativan (virtuelni) id jasnom porukom, ne 404/500", async () => {
    const s = svc({});
    await expect(s.rn("a@b.c", -7)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    await expect(s.operativniPlan("a@b.c", -7, {})).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });
});

/**
 * POPRAVNI KRUG (adversarni nalaz #1/#2/#3): OPSEG MORA BITI PODSKUP PUNOG PRIKAZA.
 *
 * Raniji drill je stablo gradio suženim SQL anchor-om (`WHERE wo.id IN (...)`), pa je
 * pod-stablo bilo DRUGO stablo, ne isečak istog:
 *   #1 deca koja u sklop stižu ručnim OVERRIDE-om (a ne sastavnicom) nisu se ni učitavala
 *      → ručni sklop u drill-u prazan, „lansirano" manje nego u punom prikazu;
 *   #2 ugnežđen lanac (ručni sklop → RN → ručni sklop → RN) se prekidao na prvom RN-u;
 *   #3 `1 AS broj_komada` na anker-redu je gazio `work_order_components.quantity`, pa je
 *      „Za lot" u drill-u bio manji (izmereno: 12 umesto 48).
 * Sada se učitava ceo predmet, `reparentNodes` se pusti JEDNOM, pa se seče po efektivnom
 * `path_idrn`. Testovi porede DRILL sa PUNIM prikazom nad ISTIM podacima.
 */
describe("Opseg (drill) = isečak punog stabla — popravni krug 053/26", () => {
  const svc = (fx: DbFixture) =>
    new PracenjeReadService(makeReadPrisma(fx) as unknown as PrismaService);

  type Row = {
    node_id: number;
    level: number;
    lansirana_kolicina: number | null;
  };
  const shape = (rows: readonly Row[]) =>
    rows.map((r) => `${r.node_id}@${r.level}`);

  /**
   * Nalaz #1: sklop A = RN 1 (BOM dete RN 2); virtuelni V(-7) premešten pod A; pozicija
   * P = RN 100 (sopstveni koren predmeta) premeštena u V.
   */
  const scenaVirtUnderReal: DbFixture = {
    project: PROJECT_FX,
    struktura: [
      dbNode({ rn_id: 1, ident_broj: "9400/1", komada: 10 }),
      dbNode({
        rn_id: 2,
        parent_rn_id: 1,
        root_rn_id: 1,
        nivo: 1,
        path_idrn: [1, 2],
        ident_broj: "9400/1.1",
        komada: 10,
      }),
      dbNode({
        rn_id: 100,
        ident_broj: "9400/9",
        komada: 10,
        has_parent_override: true,
        parent_override_rn_id: -7,
      }),
    ],
    virtuelni: [
      VS_FX({ id: 7, has_parent_override: true, parent_override_rn_id: 1 }),
    ],
  };

  it("#1 drill na REALNI sklop vuče i ručni sklop I njegove override-pozicije", async () => {
    const pun = await svc(scenaVirtUnderReal).izvestaj("a@b.c", 7602, {});
    expect(shape(pun.data.rows as Row[])).toEqual([
      "1@0",
      "2@1",
      "-7@1",
      "100@2",
    ]);
    expect(pun.data.summary.total_lansirano).toBe(30);

    const drill = await svc(scenaVirtUnderReal).izvestaj("a@b.c", 7602, {
      rootRn: "1",
    });
    // RN 100 je ranije NESTAJAO (stigao je override-om, ne sastavnicom).
    expect(shape(drill.data.rows as Row[])).toEqual([
      "1@0",
      "2@1",
      "-7@1",
      "100@2",
    ]);
    // Isti čvorovi ⇒ ista suma; ranije je padala na 20.
    expect(drill.data.summary.total_lansirano).toBe(
      pun.data.summary.total_lansirano,
    );
    // Koren isečka nema roditelja u prikazu; ostali zadržavaju svog.
    const byId = new Map(
      (
        drill.data.rows as { node_id: number; parent_node_id: number | null }[]
      ).map((r) => [r.node_id, r.parent_node_id]),
    );
    expect(byId.get(1)).toBeNull();
    expect(byId.get(-7)).toBe(1);
    expect(byId.get(100)).toBe(-7);
  });

  /** Nalaz #2: ugnežđen lanac V(-7) → RN 500 → W(-8) → RN 600. */
  const scenaUgnezdjeno: DbFixture = {
    project: PROJECT_FX,
    struktura: [
      dbNode({
        rn_id: 500,
        ident_broj: "9400/5",
        komada: 10,
        has_parent_override: true,
        parent_override_rn_id: -7,
      }),
      dbNode({
        rn_id: 600,
        ident_broj: "9400/6",
        komada: 10,
        has_parent_override: true,
        parent_override_rn_id: -8,
      }),
    ],
    virtuelni: [
      VS_FX({ id: 7, naziv: "Ručni A" }),
      VS_FX({
        id: 8,
        naziv: "Ručni B",
        has_parent_override: true,
        parent_override_rn_id: 500,
      }),
    ],
  };

  it("#2 drill na ručni sklop ide kroz CEO lanac V→RN→W→RN (sva 4 čvora)", async () => {
    const drill = await svc(scenaUgnezdjeno).izvestaj("a@b.c", 7602, {
      rootRn: "-7",
    });
    // Ranije je vraćalo samo [-7, 500] — lanac se prekidao na prvom RN-u.
    expect(shape(drill.data.rows as Row[])).toEqual([
      "-7@0",
      "500@1",
      "-8@2",
      "600@3",
    ]);
    const pun = await svc(scenaUgnezdjeno).izvestaj("a@b.c", 7602, {});
    expect(drill.data.summary.total_lansirano).toBe(
      pun.data.summary.total_lansirano,
    );
  });

  /** Nalaz #3: „Za lot" mora doći iz sastavnice (quantity), ne iz anker-a. */
  const scenaKolicina: DbFixture = {
    project: PROJECT_FX,
    struktura: [
      dbNode({
        rn_id: 500,
        ident_broj: "9400/5",
        komada: 10,
        broj_komada: 4, // work_order_components.quantity
        has_parent_override: true,
        parent_override_rn_id: -7,
      }),
    ],
    virtuelni: [VS_FX({ id: 7 })],
  };

  it("#3 `required_for_lot` premeštene pozicije je ISTI u punom i suženom prikazu", async () => {
    const reqOf = (res: { data: { rows: unknown[] } }) =>
      (
        res.data.rows as { node_id: number; required_for_lot: number | null }[]
      ).find((r) => r.node_id === 500)!.required_for_lot;

    const pun = await svc(scenaKolicina).izvestaj("a@b.c", 7602, {
      lotQty: "12",
    });
    const drill = await svc(scenaKolicina).izvestaj("a@b.c", 7602, {
      rootRn: "-7",
      lotQty: "12",
    });
    expect(reqOf(pun)).toBe(48); // 4 kom/sklop × lot 12
    expect(reqOf(drill)).toBe(48); // ranije 12 (anker je gazio quantity na 1)
  });

  it("drill NE menja podatke pozicije — samo nivo/koren (isečak je podskup punog)", async () => {
    const pun = await svc(scenaVirtUnderReal).izvestaj("a@b.c", 7602, {});
    const drill = await svc(scenaVirtUnderReal).izvestaj("a@b.c", 7602, {
      rootRn: "1",
    });
    // Jedina polja koja opseg SME da promeni: nivo (rebazira se na koren isečka) i veza
    // korena naviše (roditelj mu je van isečka → i sklopni crtež otpada). Sve ostalo —
    // količine, datumi, statusi, operacije, `sort_order` — mora biti IDENTIČNO punom prikazu.
    const SCOPE_FIELDS = [
      "level",
      "parent_node_id",
      "broj_sklopnog_crteza",
      "sklop_drawing_no",
      "has_skop_crtez_file",
    ];
    const strip = (r: Record<string, unknown>) => {
      const out = { ...r };
      for (const k of SCOPE_FIELDS) delete out[k];
      return out;
    };
    const byIdPun = new Map(
      (pun.data.rows as Record<string, unknown>[]).map((r) => [
        r.node_id,
        strip(r),
      ]),
    );
    for (const r of drill.data.rows as Record<string, unknown>[]) {
      expect(strip(r)).toEqual(byIdPun.get(r.node_id));
    }
  });
});
