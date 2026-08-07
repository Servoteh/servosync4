import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NAV_DOMAINS, allModules, type NavModule } from '@/lib/navigation';

/**
 * Invarijante SAMOG nav modela (za razliku od `nav-invariants.spec.ts`, koji proverava
 * oblik izvornog koda) — ovde se model uveze i izmeri kao podatak.
 */

/** Sve stavke sidebara, sa domenom iz kog dolaze (direktne + one iz pod-grupa). */
function sveStavke(): { domen: string; modul: NavModule }[] {
  return NAV_DOMAINS.flatMap((d) => allModules(d).map((modul) => ({ domen: d.id, modul })));
}

/* ────────────────────────────────────────────────────────── dva ista imena u meniju */

test('nijedno ime u meniju ne vodi na dve različite rute', () => {
  // POVOD (07.08.2026): sidebar je imao DVE stavke „Komitenti" — `/komitenti` (pun matični
  // modul, „Matični podaci") i `/customers` (stariji, suženi pregled, domen „Sistem").
  // Korisnik iz imena nije mogao da zna koja je koja, pa je pola ljudi radilo na starom
  // ekranu. Vlasnik je stari ugasio; ovaj test brani da se duplikat vrati.
  //
  // Pravilo NIJE „ime se ne sme ponoviti": isti modul SME da bude naveden u više domena
  // (`crosslisted`, npr. „Lokacije delova" u Proizvodnji i Logistici) — tada su dve stavke
  // dva ulaza u ISTU rutu i korisnik ne može da pogreši. Kvar je kad isto ime vodi na
  // RAZLIČITE rute.
  const poImenu = new Map<string, Set<string>>();
  for (const { modul } of sveStavke()) {
    const rute = poImenu.get(modul.label) ?? new Set<string>();
    rute.add(modul.href);
    poImenu.set(modul.label, rute);
  }

  const sudari = [...poImenu.entries()]
    .filter(([, rute]) => rute.size > 1)
    .map(([label, rute]) => `„${label}" → ${[...rute].sort().join(' + ')}`);

  assert.deepEqual(
    sudari,
    [],
    'dve stavke sidebara nose isto ime a vode na različite ekrane — korisnik iz menija ne ' +
      'može da zna koja mu treba. Ili preimenuj jednu, ili ugasi stariji ekran (i ostavi ' +
      'preusmeru sa njegove rute).',
  );
});

/* ─────────────────────────────────────────────── ista ruta = ista stavka, svesno */

test('ista ruta navedena više puta nosi isto ime i oznaku `crosslisted`', () => {
  // Druga strana istog novčića: ako se ISTA ruta pojavi dvaput, to mora biti svesno
  // unakrsno listanje (dedup u Ctrl+K paleti i „↗" u sidebaru zavise od te oznake),
  // a ne slučajno kopiran red pod drugim imenom.
  const poRuti = new Map<string, { domen: string; modul: NavModule }[]>();
  for (const s of sveStavke()) {
    poRuti.set(s.modul.href, [...(poRuti.get(s.modul.href) ?? []), s]);
  }

  const problemi: string[] = [];
  for (const [href, stavke] of poRuti) {
    if (stavke.length < 2) continue;
    const imena = new Set(stavke.map((s) => s.modul.label));
    if (imena.size > 1) problemi.push(`${href} se zove ${[...imena].map((i) => `„${i}"`).join(' i ')}`);
    const bezOznake = stavke.filter((s) => !s.modul.crosslisted).map((s) => s.domen);
    if (bezOznake.length > 0) problemi.push(`${href} u domenu ${bezOznake.join(', ')} nema \`crosslisted: true\``);
  }

  assert.deepEqual(problemi, [], 'ponovljena ruta u nav modelu mora biti svesno unakrsna');
});
