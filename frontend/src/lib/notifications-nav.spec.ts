import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  NOTIFICATION_BADGE,
  NOTIFICATION_ROUTE,
  notificationBadge,
  resolveNotificationRoute,
} from './notifications-nav';

/**
 * Ogledalo backenda. Kad neko doda nov upis u `app_notifications`, ovaj test pada i
 * tera da se dopuni mapa — bez toga klik na obaveštenje tiho ne radi ništa (C20).
 * Izvor: `git grep -n "refTable" backend/src` (bez .spec) — 10 mesta upisa.
 */
const BACKEND_REF_TABLES = [
  'work_orders',
  'handover_drafts',
  'drawing_handovers',
  'montage_nonconformities',
  'maint_machines',
  'quality_events',
  'app_switches',
] as const;

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

test('svaki ref_table koji backend upisuje ima rutu', () => {
  for (const t of BACKEND_REF_TABLES) {
    assert.ok(NOTIFICATION_ROUTE[t], `nema rute za ref_table "${t}"`);
    assert.ok(resolveNotificationRoute(t, 1), `resolve vraća null za "${t}"`);
  }
});

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
