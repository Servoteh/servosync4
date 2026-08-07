import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TEKST_GOTOVOST,
  oblikPitanja,
  planZaPitanje,
  trebaPitatiZaGotovost,
} from './gotovost-pitanje';

// ─────────────────────────────────────────────── GEJT (kad se pitanje postavlja)
// Ponašanje se NE menja odlukom od 07.08. — dijalog i dalje iskače pod istim
// uslovom, samo menja lice kad je kumulativ nula.

test('gejt: ispod plana se pita, plan dostignut se ne pita', () => {
  assert.equal(trebaPitatiZaGotovost(false, 200, 21), true);
  assert.equal(trebaPitatiZaGotovost(false, 200, 199), true);
  assert.equal(trebaPitatiZaGotovost(false, 200, 200), false);
  assert.equal(trebaPitatiZaGotovost(false, 200, 205), false); // preko plana
});

test('gejt: plan nije poznat (null ili 0) → pita se', () => {
  // 18 RN na produ ima plan 0; da se tu ne pita, operacija se sa kioska ne bi
  // mogla proglasiti gotovom.
  assert.equal(trebaPitatiZaGotovost(false, null, 5), true);
  assert.equal(trebaPitatiZaGotovost(false, 0, 5), true);
  assert.equal(planZaPitanje(0), null);
  assert.equal(planZaPitanje(null), null);
  assert.equal(planZaPitanje(200), 200);
});

test('gejt: OPŠTI NALOG se nikad ne pita (plan je plan celog RN-a)', () => {
  // 4521/0000.0 nosi plan 100.000 — pitanje bi iskakalo na svaki „Kraj rada".
  assert.equal(trebaPitatiZaGotovost(true, 100_000, 0), false);
  assert.equal(trebaPitatiZaGotovost(true, null, 0), false);
  assert.equal(trebaPitatiZaGotovost(true, 4, 1), false);
});

// ─────────────────────────────────────────── OBLIK (odluka Nenad 07.08.2026)

test('oblik: kumulativ nula → nula-oblik (bez „Da — gotova je")', () => {
  assert.equal(oblikPitanja(0), 'nula');
  // Slika sa pogona: „Otkucao si 0 od 1 kom." uz ponuđeno „Da — gotova je".
  assert.equal(trebaPitatiZaGotovost(false, 1, 0), true);
  assert.equal(oblikPitanja(0), 'nula');
});

test('oblik: negativan kumulativ (storno) je isto nula-oblik — `<= 0`, ne `=== 0`', () => {
  // Storno upisuje kontra-red sa negativnim brojem komada; `=== 0` bi propustio
  // operaciju sa kumulativom -1 nazad na „Da — gotova je".
  assert.equal(oblikPitanja(-1), 'nula');
  assert.equal(oblikPitanja(-3), 'nula');
});

test('oblik: makar jedan komad → normalno pitanje sa „Da — gotova je"', () => {
  assert.equal(oblikPitanja(1), 'ispod-plana');
  assert.equal(oblikPitanja(21), 'ispod-plana');
});

test('oblik: „sve je škart" NIJE nula-slučaj (kumulativ broji sve kvalitete)', () => {
  // Mereno: od 05.08. su dve operacije zatvorene sa kumulativom > 0 a nula
  // DOBRIH komada. Kumulativ na kiosku je zbir svih kvaliteta (dobar + dorada +
  // škart), pa te operacije i dalje moraju dobijati „Da — gotova je".
  assert.equal(oblikPitanja(2), 'ispod-plana');
});

// ───────────────────────────────────────────────────────────── TEKST DUGMADI

test('tekst: nula-oblik ne nudi „Da — gotova je" ni na jednom dugmetu', () => {
  const nula: readonly string[] = [TEKST_GOTOVOST.nula.levo, TEKST_GOTOVOST.nula.desno];
  assert.equal(
    nula.some((t) => t.includes('gotova')),
    false,
  );
  assert.equal(TEKST_GOTOVOST.nula.naslov, 'Nisi otkucao nijedan komad');
  assert.equal(TEKST_GOTOVOST.nula.desno, 'Upiši samo vreme');
  assert.match(TEKST_GOTOVOST.nula.objasnjenje, /OSTAJE OTVORENA/);
  assert.match(TEKST_GOTOVOST.nula.odustani, /Odustani/);
});

test('tekst: normalan oblik i dalje nudi „Da — gotova je" levo', () => {
  assert.equal(TEKST_GOTOVOST['ispod-plana'].levo, 'Da — gotova je');
  assert.equal(TEKST_GOTOVOST['ispod-plana'].desno, 'Ne — nastavlja se');
});
