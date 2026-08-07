import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  NOTIFICATION_BADGE,
  NOTIFICATION_ROUTE,
  notificationBadge,
  resolveNotificationRoute,
} from './notifications-nav';

/**
 * Ogledalo backenda — ČITANO IZ BACKENDA, ne prepisano.
 *
 * Prva verzija ovog testa držala je ručno prepisan spisak `ref_table` vrednosti. Takav test
 * ne može da uhvati baš ono zbog čega postoji: kad backend uvede nov kanal obaveštenja, spisak
 * u testu ostaje isti, testovi prođu, a klik na novo obaveštenje opet ne radi ništa (C20 se
 * tiho vraća). Zato se spisak IZVODI iz izvora — monorepo je jedan repo i putanja
 * `backend/src` je stabilna (v. CLAUDE.md, koren repoa).
 *
 * Izvode se samo `refTable` vrednosti: one su na svim mestima upisa string-literali. Tipovi
 * (`type:`) se mestimično sklapaju u runtime-u (npr. `kvalitet.${event.type.toLowerCase()}`),
 * pa se iz izvora ne mogu pouzdano pročitati i ostaju nabrojani ručno — labela koja fali je
 * uz to kozmetički kvar (neutralan bedž), ne mrtav klik.
 */
const BACKEND_SRC = path.resolve(import.meta.dirname, '..', '..', '..', 'backend', 'src');

/** Sva `refTable: "…"` mesta u backendu (bez testova) — jedan po jedan literal. */
function backendRefTables(dir: string, found = new Set<string>()): Set<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      backendRefTables(full, found);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
      // `latin1`, ne `utf8`: `handover-drafts.service.ts` nosi NUL bajt (git ga zato drži za
      // binarni fajl, `grep` ga preskače kao „Binary file … matches"). Traženi obrazac je čist
      // ASCII, pa čitanje bajt-po-bajt uklanja svako pitanje dekodiranja.
      const src = fs.readFileSync(full, 'latin1');
      for (const m of src.matchAll(/refTable:\s*["']([a-z0-9_]+)["']/g)) found.add(m[1]);
    }
  }
  return found;
}

test('spisak kanala se izvodi iz backenda, ne prepisuje', () => {
  // Ako ovo padne, promenio se raspored monorepoa — popravi putanju, NEMOJ preskočiti test:
  // test koji ume tiho da se isključi je upravo kvar koji ovde popravljamo.
  assert.ok(
    fs.existsSync(BACKEND_SRC),
    `nema backend/src na očekivanoj putanji (${BACKEND_SRC}) — proveri raspored monorepoa`,
  );
  const tables = backendRefTables(BACKEND_SRC);
  // Donja granica je brana od „regex više ništa ne hvata pa test prolazi prazan".
  assert.ok(tables.size >= 7, `nađeno samo ${tables.size} ref_table vrednosti — regex je zastareo`);
});

test('svaki ref_table koji backend upisuje ima rutu (izvedeno iz backenda)', () => {
  for (const t of backendRefTables(BACKEND_SRC)) {
    assert.ok(
      NOTIFICATION_ROUTE[t],
      `backend upisuje ref_table "${t}", a frontend nema rutu za njega — klik na to ` +
        'obaveštenje ne vodi nigde (dopuni NOTIFICATION_ROUTE u lib/notifications-nav.ts)',
    );
    assert.ok(resolveNotificationRoute(t, 1), `resolve vraća null za "${t}"`);
  }
});

const BACKEND_TYPES = [
  'kontrola.skart',
  'kontrola.dorada',
  'nacrt.kreiran',
  'primopredaja.nova',
  'primopredaja.preuzeta',
  'primopredaja.odbijena',
  'primopredaja.lansirana',
  'montaza.neusaglasenost.nova',
  'odrzavanje.masina-otpis',
  'kvalitet.skart',
  'kvalitet.dorada',
  'bigbit.sync.alarm',
] as const;

test('svaki tip koji backend šalje ima srpsku labelu (ne mašinski ključ)', () => {
  for (const t of BACKEND_TYPES) {
    assert.ok(NOTIFICATION_BADGE[t], `nema bedža za tip "${t}"`);
    assert.notEqual(notificationBadge(t).label, t);
  }
});

test('nepoznat tip pada na neutralan bedž, nikad na mašinski ključ', () => {
  assert.deepEqual(notificationBadge('nesto.novo'), { tone: 'neutral', label: 'Obaveštenje' });
  assert.deepEqual(notificationBadge(null), { tone: 'neutral', label: 'Obaveštenje' });
  assert.deepEqual(notificationBadge(''), { tone: 'neutral', label: 'Obaveštenje' });
});

test('C20: dva ref_table-a koja su do sada vodila u prazno sada imaju odredište', () => {
  // `ref_id` se u oba slučaja ne koristi: SkartDoradaTab ne čita URL parametar, a
  // watchdog BigBita upisuje `refId: null` tvrdo.
  assert.equal(resolveNotificationRoute('quality_events', 41), '/kvalitet?tab=skart-dorada');
  assert.equal(resolveNotificationRoute('app_switches', null), '/podesavanja?tab=integracije');
});

test('work_orders i montage_nonconformities nose ref_id u deep-link', () => {
  assert.equal(resolveNotificationRoute('work_orders', 6938), '/work-orders?open=6938');
  assert.equal(
    resolveNotificationRoute('montage_nonconformities', 12),
    '/montaza?view=neusaglasenosti&id=12',
  );
});

test('bez ref_id ruta ostaje modul, bez visećeg parametra', () => {
  assert.equal(resolveNotificationRoute('work_orders', null), '/work-orders');
  assert.equal(
    resolveNotificationRoute('montage_nonconformities', null),
    '/montaza?view=neusaglasenosti',
  );
  assert.equal(resolveNotificationRoute('maint_machines', null), '/odrzavanje?tab=masine');
});

test('nepoznat ili prazan ref_table vraća null (pozivalac mora da javi korisniku)', () => {
  assert.equal(resolveNotificationRoute(null, 1), null);
  assert.equal(resolveNotificationRoute('', 1), null);
  assert.equal(resolveNotificationRoute('nepoznata_tabela', 1), null);
});
