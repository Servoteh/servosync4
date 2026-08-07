import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isModifiedNavClick } from './nav-click';

/**
 * B1: ctrl/⌘-klik na link duplikata prebacivao je TEKUĆI tab na tuđi zahtev.
 *
 * Tablica ispod je cela logika popravke — gard mora da uhvati SVAKI način na koji korisnik
 * kaže „otvori drugde": Ctrl (Windows/Linux), ⌘ (Mac), Shift (nov prozor), Alt (preuzimanje)
 * i srednji taster. Jedan zaboravljen modifikator = kvar se vraća samo za tu naviku.
 */
test('običan levi klik je jedini koji vodi TEKUĆU stranu', () => {
  assert.equal(isModifiedNavClick({ button: 0 }), false);
  assert.equal(isModifiedNavClick({}), false); // bez `button` = levi (nativni default)
  assert.equal(
    isModifiedNavClick({ ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, button: 0 }),
    false,
  );
});

test('ctrl/⌘/shift/alt klik NE dira tekuću stranu', () => {
  assert.equal(isModifiedNavClick({ ctrlKey: true }), true, 'Ctrl+klik (Windows/Linux, nov tab)');
  assert.equal(isModifiedNavClick({ metaKey: true }), true, '⌘+klik (Mac, nov tab)');
  assert.equal(isModifiedNavClick({ shiftKey: true }), true, 'Shift+klik (nov prozor)');
  assert.equal(isModifiedNavClick({ altKey: true }), true, 'Alt+klik (preuzimanje)');
});

test('srednji i desni taster nisu navigacija tekuće strane', () => {
  assert.equal(isModifiedNavClick({ button: 1 }), true, 'srednji taster = nov tab');
  assert.equal(isModifiedNavClick({ button: 2 }), true, 'desni taster = kontekstni meni');
});

test('gard radi i nad pravim React/DOM događajem (strukturno poklapanje)', () => {
  // Dokaz da tip `NavClickLike` prima ono što <Link onClick> zaista dobija: nativni
  // MouseEvent ima sva četiri modifikatora i `button`.
  const nativeLike = {
    ctrlKey: false,
    metaKey: true,
    shiftKey: false,
    altKey: false,
    button: 0,
    type: 'click',
    bubbles: true,
  };
  assert.equal(isModifiedNavClick(nativeLike), true);
});
