import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Invarijante navigacije koje se NE MOGU proveriti pozivom funkcije.
 *
 * Frontend testove pokreće goli `node --test` (bez jsdom-a i bez React renderera — v.
 * `test/alias-hook.mjs`), pa ponašanje kao „ctrl-klik ne sme da pomeri tekuću stranu" ili
 * „skok na drugu rutu ide `router.push`-om" nema izvršnu površinu koju bi test mogao da
 * pozove. Umesto da nalazi ostanu bez ijedne brane, ovde se proverava OBLIK izvora: svaka
 * tvrdnja je jedna rečenica o kodu koju je lako pročitati i, kad se namerno menja, lako
 * ispraviti. Test koji padne posle svesnog refaktora treba ispraviti — ali tek pošto se
 * proveri da invarijanta i dalje važi u novom obliku.
 *
 * Nalazi koje ovaj fajl drži zatvorenim: B1 (ctrl-klik), B2 (skok na Sastanke),
 * B3 (deep-link se troši samo uz svoj pogled), B4 (stanje vezano za zapis).
 */

const SRC = path.resolve(import.meta.dirname, '..');

/** Izvor bez razmaka — poređenje oblika otporno na prelome redova i `prettier`. */
function squeezed(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\s+/g, '');
}

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) tsxFiles(full, out);
    else if (e.name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/* ───────────────────────────────────────────────────────────────────────── B1 */

test('B1: svaki <Link> koji emituje nav event prolazi kroz gard modifikovanog klika', () => {
  // Premisa je namerno široka: dovoljno je da fajl renderuje <Link> I pominje `emitNavEvent`
  // (bilo direktno, bilo kroz `NavigateHandler`) — takav fajl MORA da pominje i gard. Fajlovi
  // koji emituju iz <button>-a (paleta, panel prenosa, /sastanci) nemaju <Link> i ne padaju
  // pod pravilo: srednji/ctrl klik na dugme ne otvara nov tab.
  const offenders = tsxFiles(SRC).filter((f) => {
    const src = fs.readFileSync(f, 'utf8');
    if (!src.includes('<Link')) return false;
    if (!src.includes('emitNavEvent') && !src.includes('NavigateHandler')) return false;
    // Traži se POZIV, ne pomen: gard pominjan samo u komentaru ne brani ništa.
    return !src.includes('isModifiedNavClick(');
  });
  assert.deepEqual(
    offenders.map((f) => path.relative(SRC, f)),
    [],
    'ovi fajlovi emituju `servosync:nav` iz <Link> onClick-a bez garda — ctrl/⌘-klik bi ' +
      'otvorio nov tab I prebacio tekući (v. lib/nav-click.ts)',
  );
});

test('B1: NavigateHandler prima događaj klika kao prvi argument (gard se ne može zaboraviti)', () => {
  // Tip je ovde brana: nov <Link> u sidebaru koji ne prosledi događaj ne prolazi `tsc`.
  const shell = squeezed('components/ui-kit/app-shell.tsx');
  assert.ok(
    shell.includes('typeNavigateHandler=(e:NavClickLike,mruHref:string,navHref?:string)=>void'),
    'NavigateHandler mora da prima događaj klika — bez toga gard zavisi od pamćenja',
  );
  assert.ok(
    shell.includes('constonNavigate:NavigateHandler=(e,href,navHref)=>{if(isModifiedNavClick(e))return;'),
    'centralni onNavigate mora da odustane od SVEGA na modifikovan klik (i od MRU i od ' +
      'zatvaranja sidebara), ne samo od emitovanja',
  );
});

/* ───────────────────────────────────────────────────────────────────────── B2 */

test('B2: skok na Akcioni plan je klijentska navigacija, ne sintetički popstate', () => {
  const rn = squeezed('app/pracenje-proizvodnje/_components/rn-view.tsx');
  assert.ok(
    rn.includes(
      'constgoToSastanak=(akcijaId:string)=>{consthref=sastanakAkcijaHref(akcijaId);emitNavEvent(href);router.push(href);};',
    ),
    'prelaz na /sastanci mora da ide `router.push` (uz `emitNavEvent` pre njega). ' +
      '`history.pushState` + ručni PopStateEvent menja adresu a ne renderuje /sastanci, i ' +
      'usput obara stanje TEKUĆE strane (useQueryTab/useIdParam slušaju popstate).',
  );
  // Ostali pushState+popstate u ovom fajlu su legitimni: oni ostaju NA ISTOJ ruti
  // (`/pracenje-proizvodnje?predmet=…`, koju sama strana i presreće).
  assert.ok(
    !rn.includes("pushState(null,'','/sastanci") && !rn.includes('pushState(null,`/sastanci'),
    'druga ruta se nikad ne otvara kroz pushState',
  );
});

test('B2: akcija id ostaje u adresi (izmena je aditivna u odnosu na 1.0)', () => {
  const rn = squeezed('app/pracenje-proizvodnje/_components/rn-view.tsx');
  assert.ok(
    rn.includes('return`/sastanci?tab=akcioni&akcija=${encodeURIComponent(akcijaId)}`;'),
    'href mora da nosi I tab (da se sleti na Akcioni plan) I akcija id (da čitač, kad ga ' +
      'AkcioniPlanTab dobije, ima šta da otvori — 1.0 ga je imao)',
  );
  assert.ok(
    rn.includes('onClick={()=>goToSastanak(String(a.izvor_akcioni_plan_id))}'),
    'dugme mora da prosledi id akcione tačke — bez toga je href bez sadržaja',
  );
});

/* ───────────────────────────────────────────────────────────────────────── B3 */

test('B3: čitač deep-linka na Montaži se montira samo uz svoj pogled', () => {
  const page = squeezed('app/montaza/page.tsx');
  assert.ok(
    page.includes("{view==='neusaglasenosti'&&(<Suspensefallback={null}><DeepLinkNcParam"),
    '`?id=` je jednokratan deep-link i sme da se „potroši" samo kad ima ko da ga primi; ' +
      'bezuslovno montiran čitač pojede `/montaza?id=5` na hubu i zapamti ga za kasnije',
  );
  // Gard NE SME da bude efekat koji briše zapamćen id kad pogled nije taj: efekti deteta
  // (čitač) idu PRE efekata roditelja, a `useQueryTab` pogled razrešava tek u svom efektu,
  // pa bi takav gard u prvom komitu obrisao tek pročitan deep-link.
  assert.ok(
    !page.includes("if(view!=='neusaglasenosti')setDeepLinkNcId(null)"),
    'reset kroz efekat bi obrisao deep-link pre nego što se pogled razreši',
  );
});

/* ───────────────────────────────────────────────────────────────────────── B4 */

test('B4: undo prozor pripada dokumentu u kome je stavka obrisana', () => {
  const page = squeezed('app/robno/detalj/page.tsx');
  assert.ok(
    page.includes('constactivePending=pending&&pending.docId===validId?pending:null;'),
    'toast „Poništi" mora da bude vezan za identitet dokumenta — inače posle skoka na drugu ' +
      'stranu prenosa vraća stavku na POGREŠNOM dokumentu',
  );
  assert.ok(
    page.includes('{docId:activePending.docId,itemLineId:activePending.itemLineId}'),
    'restore mora da ide na dokument iz `pending`, nikad na tekući `doc.id`',
  );
});

test('B4: paneli detalja se resetuju kad se dokument promeni u mestu', () => {
  const page = squeezed('app/robno/detalj/page.tsx');
  assert.ok(page.includes('<TransferPanelkey={doc.id}'), 'panel prenosa mora da nosi key={doc.id}');
  assert.ok(
    page.includes('<ShippingPanelkey={doc.id}'),
    'panel otpreme mora da nosi key={doc.id} — bez toga zatečen režim izmene nosi polja ' +
      'PRETHODNOG dokumenta u „Snimi", tj. upisuje ih na tuđi dokument',
  );
});
