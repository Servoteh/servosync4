import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hrefWithoutParam, parseIdParam } from './deep-link';

test('parseIdParam prima samo dekadni pozitivan ceo broj', () => {
  assert.equal(parseIdParam('12'), 12);
  assert.equal(parseIdParam(' 7 '), 7);
  assert.equal(parseIdParam('000123'), 123);
});

test('parseIdParam odbija zapise koje bi goli Number() propustio', () => {
  // Ovo je jezgro nalaza: prelomljen link iz mejla je otvarao TUĐI dokument.
  assert.equal(Number('0x10'), 16); // dokaz da bi goli Number() propustio
  assert.equal(parseIdParam('0x10'), null);
  assert.equal(parseIdParam('1e3'), null);
  assert.equal(parseIdParam('+5'), null);
  assert.equal(parseIdParam('12abc'), null); // `parseInt` bi dao 12
  assert.equal(parseIdParam('-5'), null);
  assert.equal(parseIdParam('1.5'), null);
});

test('parseIdParam odbija prazno, null i undefined', () => {
  assert.equal(parseIdParam(null), null);
  assert.equal(parseIdParam(undefined), null);
  assert.equal(parseIdParam(''), null);
  assert.equal(parseIdParam('   '), null);
});

test('parseIdParam odbija broj van bezbednog opsega', () => {
  assert.equal(parseIdParam('99999999999999999999'), null);
  assert.equal(parseIdParam(String(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
});

test('parseIdParam: nula prolazi samo uz allowZero (komitent 0 = Servoteh)', () => {
  assert.equal(parseIdParam('0'), null);
  assert.equal(parseIdParam('0', { allowZero: true }), 0);
  assert.equal(parseIdParam('00', { allowZero: true }), 0);
  assert.equal(parseIdParam('abc', { allowZero: true }), null);
});

test('hrefWithoutParam skida samo traženi parametar', () => {
  assert.equal(
    hrefWithoutParam('https://app.test/montaza?view=neusaglasenosti&id=12', 'id'),
    'https://app.test/montaza?view=neusaglasenosti',
  );
  assert.equal(
    hrefWithoutParam('https://app.test/work-orders?open=5', 'open'),
    'https://app.test/work-orders',
  );
});

test('hrefWithoutParam vraća null kad nema šta da se menja', () => {
  // Bez ovoga bi „trošenje" pozivalo replaceState i kad parametra nema — nepotrebno
  // diranje istorije na svakom renderu.
  assert.equal(hrefWithoutParam('https://app.test/montaza?view=gantt', 'id'), null);
  assert.equal(hrefWithoutParam('https://app.test/nacrti', 'open'), null);
  assert.equal(hrefWithoutParam('/relativan?open=1', 'open'), null); // neispravan href
});

test('hrefWithoutParam čuva hash i ostale parametre', () => {
  assert.equal(
    hrefWithoutParam('https://app.test/pracenje-proizvodnje?predmet=9&root=RN-1#tab=predmeti', 'predmet'),
    'https://app.test/pracenje-proizvodnje?root=RN-1#tab=predmeti',
  );
});
