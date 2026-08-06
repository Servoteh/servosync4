import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  hoursInputFromMinutes,
  hoursLabel,
  minutesFromHoursInput,
  parseDecimalCommaInput,
} from './gant-utils';

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
