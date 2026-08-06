import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSuccessorIndex,
  chainFrom,
  hoursInputFromMinutes,
  hoursLabel,
  minutesFromHoursInput,
  overlayErrorMessage,
  parseDecimalCommaInput,
  shiftPreview,
} from './gant-utils';
import type { GanttRow } from '@/api/plan-proizvodnje';

/**
 * Zahtev 076/26 — trajanje operacije se KUCA u satima, ČUVA u minutima.
 * Pokriveno je tačno ono što obara ovakvo polje u praksi: srpski decimalni zarez
 * (`Number("1,5")` je `NaN`), zaokruživanje na CELE minute (DTO je `@IsInt`),
 * razlika između praznog polja i neispravnog unosa, i povratak minuta u polje bez
 * gubitka (zatečeni podaci ostaju u minutima — ne smeju da odlutaju kroz otvaranje
 * kartice). Isti stil kao `artikli/_forma/pravila.spec.ts` (node:test, bez runnera).
 */

test('parseDecimalCommaInput: prazno je null, neispravno je NaN', () => {
  assert.equal(parseDecimalCommaInput(''), null);
  assert.equal(parseDecimalCommaInput('   '), null);
  assert.equal(parseDecimalCommaInput('abc'), null); // ostane prazan string posle čišćenja
  assert.ok(Number.isNaN(parseDecimalCommaInput('1,2,3') as number));
});

test('parseDecimalCommaInput: prima i zarez i tačku kao decimalni znak', () => {
  assert.equal(parseDecimalCommaInput('1,5'), 1.5);
  assert.equal(parseDecimalCommaInput('1.5'), 1.5);
  assert.equal(parseDecimalCommaInput('2'), 2);
  // Zarez postoji → tačke su hiljade (isti obrazac kao parsePrice u održavanju).
  assert.equal(parseDecimalCommaInput('1.234,5'), 1234.5);
});

test('minutesFromHoursInput: ceo sat i decimale (Strahinjin primer 2 → 120)', () => {
  assert.equal(minutesFromHoursInput('2'), 120);
  assert.equal(minutesFromHoursInput('1,5'), 90);
  assert.equal(minutesFromHoursInput('1.5'), 90);
  assert.equal(minutesFromHoursInput('8'), 480);
  // Najveći zatečeni override na produ (10.100 min = 168,33 h).
  assert.equal(minutesFromHoursInput('168,33'), 10100);
});

test('minutesFromHoursInput: prazno = null („vrati na tehnologiju"), ne 0', () => {
  assert.equal(minutesFromHoursInput(''), null);
  assert.equal(minutesFromHoursInput('   '), null);
});

test('minutesFromHoursInput: nula i negativno su NEISPRAVNI (NaN), ne prazno', () => {
  assert.ok(Number.isNaN(minutesFromHoursInput('0') as number));
  assert.ok(Number.isNaN(minutesFromHoursInput('0,0') as number));
  assert.ok(Number.isNaN(minutesFromHoursInput('-2') as number));
  assert.ok(Number.isNaN(minutesFromHoursInput('-1,5') as number));
});

test('minutesFromHoursInput: decimale koje ne daju cele minute se ZAOKRUŽUJU (DTO je @IsInt)', () => {
  assert.equal(minutesFromHoursInput('2,51'), 151); // 150,6 min
  assert.equal(minutesFromHoursInput('0,26'), 16); // 15,6 min
  assert.equal(minutesFromHoursInput('1,004'), 60); // 60,24 min
  // Sitno ali pozitivno je namera da nešto traje → pod je 1 minut, nikad 0.
  assert.equal(minutesFromHoursInput('0,001'), 1);
});

test('hoursInputFromMinutes: minuti → sati bez suvišnih nula', () => {
  assert.equal(hoursInputFromMinutes(120), '2');
  assert.equal(hoursInputFromMinutes(90), '1,5');
  assert.equal(hoursInputFromMinutes(60), '1');
  assert.equal(hoursInputFromMinutes(3), '0,05');
  assert.equal(hoursInputFromMinutes(10100), '168,33');
  assert.equal(hoursInputFromMinutes(null), '');
  assert.equal(hoursInputFromMinutes(undefined), '');
});

test('povratak minuta kroz polje je TAČAN (kartica ne sme da pomeri zatečen podatak)', () => {
  // Dve decimale greše najviše 0,3 min < pola minuta, pa zaokruživanje uvek vrati
  // identičan broj minuta. Provera nad svim minutima do 3 dana + zatečenim maksimumom.
  for (let m = 1; m <= 4320; m++) {
    assert.equal(minutesFromHoursInput(hoursInputFromMinutes(m)), m, `minut ${m}`);
  }
  assert.equal(minutesFromHoursInput(hoursInputFromMinutes(10100)), 10100);
});

test('hoursLabel: pomoćni tekst ide sa decimalnim zarezom (kanon dizajn sistema)', () => {
  assert.equal(hoursLabel(5), '0,1 h');
  assert.equal(hoursLabel(120), '2,0 h');
  assert.equal(hoursLabel(10100), '168,3 h');
});

// ── Zahtev 075/26 — kaskadno pomeranje vezanih pozicija ──────────────────────
//
// Pokriveno je ono što ovakvu logiku obara u praksi: petlja u render putu
// (`A→B→A` je do 075/26 bio upisiv!), razlika HODA i PRESKOKA, i pravilo da se
// SIDRO pomera i kad je završeno. Sve nad ČISTIM funkcijama — crtanje se ne testira.

/** Minimalan gant red (samo polja koja ove funkcije čitaju). */
function red(
  wo: string,
  line: string,
  o: Partial<GanttRow> = {},
): GanttRow {
  return {
    work_order_id: wo,
    line_id: line,
    planned_start_at: '2026-08-10T06:00:00.000Z',
    planned_end_at: '2026-08-10T14:00:00.000Z',
    predecessor_work_order_id: null,
    predecessor_line: null,
    is_completed_effective: false,
    ...o,
  } as unknown as GanttRow;
}

/** A(1:10) → B(2:20) → C(3:30) */
const lanac = () => [
  red('1', '10'),
  red('2', '20', { predecessor_work_order_id: '1', predecessor_line: '10' }),
  red('3', '30', { predecessor_work_order_id: '2', predecessor_line: '20' }),
];

test('buildSuccessorIndex se gradi nad PUNIM feed-om, ne nad iscrtanim isečkom', () => {
  const rows = lanac();
  // „Iscrtano" je samo prvih 1 — lanac nad isečkom bi bio prazan, nad punim je pun.
  const isecak = buildSuccessorIndex(rows.slice(0, 1));
  const pun = buildSuccessorIndex(rows);
  assert.equal(chainFrom('1:10', isecak).length, 0);
  assert.deepEqual(chainFrom('1:10', pun), ['2:20', '3:30']);
});

test('chainFrom se NE ZAVRTI nad ciklusom A→B→A (do 075/26 upisiv podatak)', () => {
  const rows = [
    red('1', '10', { predecessor_work_order_id: '2', predecessor_line: '20' }),
    red('2', '20', { predecessor_work_order_id: '1', predecessor_line: '10' }),
  ];
  const out = chainFrom('1:10', buildSuccessorIndex(rows));
  // Konačan skup, bez polaznog čvora i bez ponavljanja.
  assert.deepEqual(out, ['2:20']);
});

test('chainFrom: grananje vraća OBE grane', () => {
  const rows = [
    red('1', '10'),
    red('2', '20', { predecessor_work_order_id: '1', predecessor_line: '10' }),
    red('3', '30', { predecessor_work_order_id: '1', predecessor_line: '10' }),
  ];
  const out = chainFrom('1:10', buildSuccessorIndex(rows));
  assert.deepEqual([...out].sort(), ['2:20', '3:30']);
});

test('chainFrom: čvor se pojavljuje TAČNO JEDNOM (dijamant se ne duplira)', () => {
  // Model dozvoljava samo JEDNOG prethodnika po redu, pa pravi dijamant ne može da
  // nastane — ali `visited` mora da drži i kad podatak stigne izokrenut.
  const rows = [
    red('1', '10'),
    red('2', '20', { predecessor_work_order_id: '1', predecessor_line: '10' }),
    red('3', '30', { predecessor_work_order_id: '1', predecessor_line: '10' }),
    red('4', '40', { predecessor_work_order_id: '2', predecessor_line: '20' }),
  ];
  const out = chainFrom('1:10', buildSuccessorIndex(rows));
  assert.equal(new Set(out).size, out.length);
  assert.equal(out.length, 3);
});

test('🔴 čvor BEZ termina se NE pomera, ali hod ide KROZ njega (rep se pomera)', () => {
  const rows = [
    red('1', '10'),
    red('2', '20', {
      predecessor_work_order_id: '1',
      predecessor_line: '10',
      planned_start_at: null,
      planned_end_at: null,
    }),
    red('3', '30', { predecessor_work_order_id: '2', predecessor_line: '20' }),
  ];
  const kljucevi = chainFrom('1:10', buildSuccessorIndex(rows));
  assert.deepEqual(kljucevi, ['2:20', '3:30']); // hod prolazi kroz bezterminski čvor
  const pregled = shiftPreview(rows, '1:10', ['1:10', ...kljucevi], 5);
  assert.equal(pregled.has('2:20'), false); // ali se NE pomera
  assert.equal(pregled.has('3:30'), true); // rep se pomera
});

test('🔴 shiftPreview ne dira ZAVRŠENE sledbenike, ali SIDRO pomera i kad je završeno', () => {
  const rows = [
    red('1', '10', { is_completed_effective: true }),
    red('2', '20', {
      predecessor_work_order_id: '1',
      predecessor_line: '10',
      is_completed_effective: true,
    }),
    red('3', '30', { predecessor_work_order_id: '2', predecessor_line: '20' }),
  ];
  const kljucevi = ['1:10', ...chainFrom('1:10', buildSuccessorIndex(rows))];
  const pregled = shiftPreview(rows, '1:10', kljucevi, 5);
  assert.equal(pregled.has('1:10'), true); // sidro UVEK
  assert.equal(pregled.has('2:20'), false); // završen sledbenik NE
  assert.equal(pregled.has('3:30'), true); // rep ispod njega DA
});

test('shiftPreview pomera SVE za ISTU deltu — razmaci ostaju nepromenjeni', () => {
  const rows = [
    red('1', '10', {
      planned_start_at: '2026-08-10T06:00:00.000Z',
      planned_end_at: '2026-08-10T14:00:00.000Z',
    }),
    red('2', '20', {
      predecessor_work_order_id: '1',
      predecessor_line: '10',
      // Namerna rezerva 24 h — lepljenje za kraj prethodnika bi je uništilo.
      planned_start_at: '2026-08-11T14:00:00.000Z',
      planned_end_at: '2026-08-11T18:00:00.000Z',
    }),
  ];
  const pregled = shiftPreview(rows, '1:10', ['1:10', '2:20'], 5);
  const a = pregled.get('1:10')!;
  const b = pregled.get('2:20')!;
  const razmakPre =
    new Date('2026-08-11T14:00:00.000Z').getTime() -
    new Date('2026-08-10T14:00:00.000Z').getTime();
  const razmakPosle = new Date(b.start).getTime() - new Date(a.end as string).getTime();
  assert.equal(razmakPosle, razmakPre);
});

test('shiftPreview čuva `end: null` za red bez planiranog kraja (izveden ostaje izveden)', () => {
  const rows = [red('1', '10', { planned_end_at: null })];
  const pregled = shiftPreview(rows, '1:10', ['1:10'], 3);
  assert.equal(pregled.get('1:10')!.end, null);
  assert.ok(typeof pregled.get('1:10')!.start === 'string');
});

test('shiftPreview: negativna delta pomera unazad, red bez termina se preskače', () => {
  const rows = [red('1', '10'), red('2', '20', { planned_start_at: null })];
  const pregled = shiftPreview(rows, '1:10', ['1:10', '2:20'], -2);
  assert.equal(pregled.size, 1);
  const pomeren = new Date(pregled.get('1:10')!.start);
  assert.equal(pomeren.getTime() < new Date('2026-08-10T06:00:00.000Z').getTime(), true);
});

test('overlayErrorMessage prevodi kodove kaskade (planer ne sme da vidi engleski kod)', () => {
  const kao = (kod: string) => overlayErrorMessage(new Error(`... ${kod} ...`));
  assert.ok(kao('predecessor_cycle')?.includes('petlju'));
  assert.ok(kao('chain_changed')?.includes('promenio'));
  assert.ok(kao('cascade_too_large')?.includes('predugačak'));
  assert.ok(kao('anchor_without_terms')?.includes('termin'));
  // Nepoznat kod → undefined (hook tada javlja svoju podrazumevanu poruku).
  assert.equal(overlayErrorMessage(new Error('nesto_deseto')), undefined);
});

/**
 * FE gejt za potvrdu — ogledalo `pomeriLanac` iz `gantt-tab.tsx`. Testira se PRAVILO,
 * ne komponenta: gejt sme da greši SAMO u bezbednom smeru (kad FE ne vidi ceo lanac,
 * NE upisuje naslepo nego pita server).
 */
function trebaPitatiServer(u: {
  duzinaLanca: number;
  zavrsenSledbenik: boolean;
  filterHale: boolean;
  pretraga: boolean;
  odsecenFeed: boolean;
  svakiCvorIscrtan: boolean;
}): boolean {
  const neizvesno = u.filterHale || u.pretraga || u.odsecenFeed || !u.svakiCvorIscrtan;
  return u.duzinaLanca > 8 || u.zavrsenSledbenik || neizvesno;
}

test('gejt potvrde: sve što FE ne vidi pouzdano ide PRVO na server', () => {
  const osnovno = {
    duzinaLanca: 2,
    zavrsenSledbenik: false,
    filterHale: false,
    pretraga: false,
    odsecenFeed: false,
    svakiCvorIscrtan: true,
  };
  // Mali, potpuno vidljiv lanac → brzi put (bez ijednog klika).
  assert.equal(trebaPitatiServer(osnovno), false);
  // Svaki oblik neizvesnosti obara u „pitaj pa upiši".
  assert.equal(trebaPitatiServer({ ...osnovno, duzinaLanca: 9 }), true);
  assert.equal(trebaPitatiServer({ ...osnovno, zavrsenSledbenik: true }), true);
  assert.equal(trebaPitatiServer({ ...osnovno, filterHale: true }), true);
  assert.equal(trebaPitatiServer({ ...osnovno, pretraga: true }), true);
  assert.equal(trebaPitatiServer({ ...osnovno, odsecenFeed: true }), true);
  assert.equal(trebaPitatiServer({ ...osnovno, svakiCvorIscrtan: false }), true);
});
