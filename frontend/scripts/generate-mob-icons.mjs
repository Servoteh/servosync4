/**
 * Generator PWA ikona za `/mob` („Dodaj na početni ekran").
 *
 * POKREĆE SE RUČNO, NIJE deo build-a:
 *     node scripts/generate-mob-icons.mjs
 * Rezultat (`public/mob-icons/*.png`) je KOMITOVAN — build i deploy ga samo kopiraju.
 * Zato skript sme da koristi `sharp`, koji je u `node_modules` kao tranzitivna
 * zavisnost `next`-a i `wrangler`-a, a NIJE (i ne treba da bude) u `package.json`:
 * ako jednog dana nestane, ikone i dalje rade — samo se ne mogu regenerisati dok se
 * ne pozove `npx sharp-cli` ili se sharp privremeno instalira.
 *
 * ⚠ PUTANJA `public/mob-icons/`, NE `public/icons/`:
 * `worker/index.ts` (Cloudflare, `run_worker_first: true`) proksira na staru 1.0
 * (`servoteh-plan-montaze.pages.dev`) SVE što padne u:
 *     `/m`, `/m/*`, `/assets/*`, `/icons/*`, `/manifest.webmanifest`
 * Worker odlučuje PRE ASSETS bindinga, pa bi ikona na `/icons/icon-192.png`
 * vratila 1.0 ikonu (ili 404), ma šta stajalo u `out/`. `/mob-icons/...` ne pada ni
 * u jedno pravilo (`startsWith('/m/')` je „/m" + kosa crta — `/mob-icons` nije to),
 * pa ga servira 3.0 statika. Iz istog razloga manifest živi na `/mob.webmanifest`.
 *
 * IZVOR: `public/logo-servoteh.jpg` (971×207, bela pozadina, bez alfe).
 * Izmereno nad izvorom (prag „ne-belo" < 230):
 *   • gornja linija „SERVOTEH"        → x 11..952, y 18..130
 *   • donja linija „COMPLETE AUTOMATION" → y 156..186  (NE koristi se: na 192 px
 *     ikoni bi bila ~3 px visoka mrlja)
 *   • narandžasti prsten „O"          → x 492..599, y 19..130  (boja #F14E2B)
 *   • slova su siva #4C555C → NE mogu na tamnu pozadinu (kontrast 2.4:1), zato je
 *     platno belo (matična pozadina logotipa; token `--bg` #f7f9f9 se od bele
 *     razlikuje za 3/255 = nevidljivo, a bela garantuje da iOS nema šta da pocrni).
 *
 * KOMPOZICIJA:
 *   • „any" ikone (192/512) i apple-touch (180): prsten gore + wordmark dole.
 *     Wordmark sam bi na 60pt ekranskoj veličini bio nečitljiv, prsten sam ne nosi
 *     ime — zajedno daju i prepoznatljivost i identitet.
 *   • maskable 512: SAMO prsten. Maskable safe zone je krug poluprečnika 2/5 širine
 *     (204.8 px na 512); wordmark širine 74% platna bi mu izašao iz kruga i Android
 *     bi ga odsekao. Prsten prečnika 56% ima poluprečnik 149 px < 204.8 px ✓
 *
 * Sve ikone su FLATTEN-ovane na belo i pišu se bez alfa kanala — iOS providne
 * piksele apple-touch ikone crta kao CRNE.
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'public', 'logo-servoteh.jpg');
const OUT_DIR = path.join(ROOT, 'public', 'mob-icons');

/** Tesni isečci iz izvora (vidi merenja u zaglavlju). */
const WORDMARK = { left: 11, top: 18, width: 942, height: 113 };
const RING = { left: 492, top: 19, width: 108, height: 112 };

/** Belo platno bez providnosti. */
const BELA = { r: 255, g: 255, b: 255, alpha: 1 };

/** Udeli platna — vertikalni centar sadržaja je na 48% (optičko, ne geometrijsko). */
const RING_W = 0.42; // širina prstena u „any" ikoni
const RING_TOP = 0.175;
const GAP = 0.08; // razmak prsten → wordmark
const WM_W = 0.74; // širina wordmark-a
const MASK_RING_W = 0.56; // prsten u maskable ikoni

async function upisi(platno, ime) {
  const cilj = path.join(OUT_DIR, ime);
  await platno
    .flatten({ background: BELA }) // spusti sve na belo…
    .removeAlpha() // …i stvarno izbaci alfa kanal (flatten sam ga zadrži kad platno
    // dolazi iz `create` sa channels: 4) — iOS providne piksele crta kao CRNE
    .png({ compressionLevel: 9, palette: false })
    .toFile(cilj);
  const m = await sharp(cilj).metadata();
  console.log(`  ${ime.padEnd(28)} ${m.width}×${m.height}  kanala: ${m.channels}  alfa: ${m.hasAlpha}`);
}

/** Prsten + wordmark — „any" ikone i apple-touch. */
async function lockup(S, ime) {
  const ringW = Math.round(S * RING_W);
  const ringH = Math.round((ringW * RING.height) / RING.width);
  const wmW = Math.round(S * WM_W);
  const wmH = Math.round((wmW * WORDMARK.height) / WORDMARK.width);
  const ringTop = Math.round(S * RING_TOP);
  const wmTop = ringTop + ringH + Math.round(S * GAP);

  const prsten = await sharp(SRC).extract(RING).resize(ringW, ringH).png().toBuffer();
  const wordmark = await sharp(SRC).extract(WORDMARK).resize(wmW, wmH).png().toBuffer();

  await upisi(
    sharp({ create: { width: S, height: S, channels: 4, background: BELA } }).composite([
      { input: prsten, top: ringTop, left: Math.round((S - ringW) / 2) },
      { input: wordmark, top: wmTop, left: Math.round((S - wmW) / 2) },
    ]),
    ime,
  );
}

/** Samo prsten, centriran — maskable (mora stati u krug r = 2/5 S). */
async function maskable(S, ime) {
  const ringW = Math.round(S * MASK_RING_W);
  const ringH = Math.round((ringW * RING.height) / RING.width);
  const r = Math.round(Math.max(ringW, ringH) / 2);
  const safe = Math.round((2 / 5) * S);
  if (r > safe) throw new Error(`prsten izlazi iz safe zone: r=${r} > ${safe}`);
  console.log(`  (maskable safe zone: poluprečnik sadržaja ${r} px < dozvoljenih ${safe} px)`);

  const prsten = await sharp(SRC).extract(RING).resize(ringW, ringH).png().toBuffer();
  await upisi(
    sharp({ create: { width: S, height: S, channels: 4, background: BELA } }).composite([
      { input: prsten, top: Math.round((S - ringH) / 2), left: Math.round((S - ringW) / 2) },
    ]),
    ime,
  );
}

await mkdir(OUT_DIR, { recursive: true });
console.log(`izvor: ${path.relative(ROOT, SRC)}`);
await lockup(192, 'icon-192.png');
await lockup(512, 'icon-512.png');
await lockup(180, 'apple-touch-icon-180.png');
await maskable(512, 'icon-maskable-512.png');
console.log('gotovo → public/mob-icons/');
