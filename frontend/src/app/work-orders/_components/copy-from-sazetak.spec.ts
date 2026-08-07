import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mnozina,
  natpisIzbora,
  natpisNaloga,
  recenicaPotvrde,
  ukupnoStavki,
} from './copy-from-sazetak';

// Stvarni podaci iz incidenta 07.08.2026 — dva susedna naloga istog projekta
// koja se u biraču razlikuju SAMO u poslednjem znaku identa.
const IZVOR = {
  identNumber: '9811-2/122',
  partName: 'Vrata grejne komore SQF17-zavarivanje',
  drawingNumber: '1141064',
};
const CILJ = {
  identNumber: '9811-2/120',
  partName: 'Vrata grejne komore SQF17-obrada',
  drawingNumber: '1141072',
};

// ─────────────────────────────────────────────────────────────── NATPISI

test('🔴 natpis razlikuje dva naloga koja se u identu razlikuju u jednom znaku', () => {
  // Ovo je cela poenta popravke: „9811-2/122" i „9811-2/120" jedan pored drugog
  // izgledaju isto, a „zavarivanje" i „obrada" ne izgledaju.
  const a = natpisNaloga(IZVOR);
  const b = natpisNaloga(CILJ);
  assert.notEqual(a, b);
  assert.match(a, /zavarivanje/);
  assert.match(b, /obrada/);
});

test('natpis: ident je uvek prvi, crtež poslednji', () => {
  assert.equal(
    natpisNaloga(IZVOR),
    '9811-2/122 · Vrata grejne komore SQF17-zavarivanje · crtež 1141064',
  );
});

test('natpis podnosi nalog bez naziva i bez crteža (ne pravi prazne separatore)', () => {
  assert.equal(natpisNaloga({ identNumber: '9400/7/150' }), '9400/7/150');
  assert.equal(
    natpisNaloga({ identNumber: '9400/7/150', partName: '  ', drawingNumber: null }),
    '9400/7/150',
  );
});

test('natpis praznog izbora je prazan string, ne „undefined"', () => {
  assert.equal(natpisNaloga(null), '');
  assert.equal(natpisIzbora(undefined), '');
});

test('natpis izbora nema crtež — dugme je usko i seklo bi baš naziv', () => {
  assert.equal(
    natpisIzbora(IZVOR),
    '9811-2/122 · Vrata grejne komore SQF17-zavarivanje',
  );
});

// ─────────────────────────────────────────────────────────── REČENICA POTVRDE

test('🔴 rečenica potvrde imenuje OBE strane i broj operacija', () => {
  const r = recenicaPotvrde(IZVOR, CILJ, {
    operacije: 6,
    obradjeniDelovi: 0,
    nestandardniDelovi: 0,
    pripremci: 0,
  });
  assert.match(r, /6 operacija/);
  assert.match(r, /9811-2\/122/);
  assert.match(r, /9811-2\/120/);
  assert.match(r, /zavarivanje/);
  assert.match(r, /obrada/);
  // Bez pratećih stavki se taj deo rečenice uopšte ne pojavljuje.
  assert.equal(/stavk/.test(r), false);
});

test('prateće stavke se broje odvojeno od operacija', () => {
  const r = recenicaPotvrde(IZVOR, CILJ, {
    operacije: 6,
    obradjeniDelovi: 2,
    nestandardniDelovi: 1,
    pripremci: 0,
  });
  assert.match(r, /6 operacija/);
  assert.match(r, /još 3 stavke/);
});

test('ukupno broji sve četiri tabele koje cloneItems stvarno prepisuje', () => {
  assert.equal(
    ukupnoStavki({
      operacije: 6,
      obradjeniDelovi: 2,
      nestandardniDelovi: 1,
      pripremci: 4,
    }),
    13,
  );
});

// ───────────────────────────────────────────────────────────────── MNOŽINA

test('srpska množina: 1 / 2–4 / 5+', () => {
  assert.equal(mnozina(1, 'operacija', 'operacije', 'operacija'), '1 operacija');
  assert.equal(mnozina(3, 'operacija', 'operacije', 'operacija'), '3 operacije');
  assert.equal(mnozina(6, 'operacija', 'operacije', 'operacija'), '6 operacija');
  assert.equal(mnozina(21, 'operacija', 'operacije', 'operacija'), '21 operacija');
  assert.equal(mnozina(22, 'operacija', 'operacije', 'operacija'), '22 operacije');
});

test('🔴 množina: 11–14 idu u veliku uprkos poslednjoj cifri', () => {
  // 11 se završava na 1, ali nije „11 operacija" u smislu jednine — ovo je
  // najčešća greška u ovakvim pomoćnicima.
  assert.equal(mnozina(11, 'stavka', 'stavke', 'stavki'), '11 stavki');
  assert.equal(mnozina(12, 'stavka', 'stavke', 'stavki'), '12 stavki');
  assert.equal(mnozina(14, 'stavka', 'stavke', 'stavki'), '14 stavki');
  assert.equal(mnozina(15, 'stavka', 'stavke', 'stavki'), '15 stavki');
});
