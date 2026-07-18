// ============================================================================
// Sastanci — HTML sanitizacija zapisnika (S-P1, port 1.0):
//   • sanitizeHtml/htmlToText  ← 1.0 src/lib/htmlSanitize.js (VERBATIM whitelist)
//   • sanitizeZapisnikPasteHtml ← 1.0 src/lib/sastanciPasteSanitize.js
// Svesne izmene vs 1.0 (whitelist je identičan):
//  1. kod NEDOZVOLJENOG taga prvo se sanitizuje njegovo podstablo pa se tag
//     strip-uje — 1.0 je podizao decu bez obilaska (snapshot childNodes), pa
//     ugnježdeni element u disallowed omotaču nije bio čišćen
//     (npr. <div><img onerror=…></div> bi preživeo).
//  2. htmlToText ČUVA prelome redova (<br>/blok granice → \n) — 1.0 textContent
//     ih gubi pa je sadrzajText (i PDF iz njega) bio slepljen u jedan red.
//
// Radi ISKLJUČIVO u browseru (DOMParser); poziva se iz client komponenti tek
// posle učitavanja podataka. SSR guard defanzivno vraća '' (nikad sirov HTML).
//
// Ne proširivati whitelist bez analize XSS vektora (1.0 napomena važi i ovde).
// ============================================================================

/** Whitelist za ČUVANJE/RENDER sadržaja tačke (1.0 htmlSanitize.js). */
const ALLOWED_TAGS = new Set(['b', 'i', 'u', 'strong', 'em', 'br', 'p', 'ul', 'ol', 'li', 'a']);

/** Href kriterijum save-whitelist-e; exportovan da ga toolbar „Link" komanda
 *  proveri PRE execCommand createLink (inače bi npr. javascript: link živeo u
 *  DOM-u do prvog save-a). */
export function isSafeHref(href: string): boolean {
  const h = String(href || '').trim().toLowerCase();
  return h.startsWith('http://') || h.startsWith('https://') || h.startsWith('mailto:');
}

/**
 * Sanitizuj HTML string pre čuvanja ili prikaza (dozvoljeni tagovi: b, i, u,
 * strong, em, br, p, ul, ol, li, a; jedini atribut: bezbedan href na <a>).
 * Nedozvoljeni tagovi se strip-uju, sadržaj (očišćen) ostaje.
 */
export function sanitizeHtml(html: string | null | undefined): string {
  if (!html || typeof html !== 'string') return '';
  if (typeof DOMParser === 'undefined') return ''; // SSR guard
  const doc = new DOMParser().parseFromString(html, 'text/html');
  sanitizeNode(doc.body);
  return doc.body.innerHTML;
}

function sanitizeNode(node: Element): void {
  const children = [...node.childNodes];
  for (const child of children) {
    if (child.nodeType === Node.TEXT_NODE) continue;
    if (!(child instanceof Element)) {
      child.remove();
      continue;
    }
    const tag = child.tagName.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) {
      /* Prvo očisti podstablo (vidi header — 1.0 rupa), pa strip tag uz podizanje dece. */
      sanitizeNode(child);
      while (child.firstChild) node.insertBefore(child.firstChild, child);
      child.remove();
    } else {
      /* Ukloni sve atribute osim bezbednog href na <a>. */
      for (const attr of [...child.attributes]) {
        if (tag === 'a' && attr.name === 'href') {
          if (!isSafeHref(attr.value)) child.removeAttribute('href');
        } else {
          child.removeAttribute(attr.name);
        }
      }
      /* Bezbedan target/rel na linkovima. */
      if (tag === 'a' && child.hasAttribute('href')) {
        child.setAttribute('target', '_blank');
        child.setAttribute('rel', 'noopener noreferrer');
      }
      sanitizeNode(child);
    }
  }
}

/**
 * Strip sve HTML tagove, vrati čist tekst SA prelomima redova.
 *
 * Svesna izmena vs 1.0 (vidi header #2): 1.0 vraća goli textContent koji gubi
 * SVE prelome ("<p>a</p><p>b</p>" → "ab"), pa je PDF štampao slepljen tekst.
 * Ovde se blok granice konvertuju u \n na parsiranom DOM-u pre čitanja:
 * <br> → '\n' tekst čvor; iza zatvaranja p/li/div/h1–h6 dodaje se '\n';
 * 3+ uzastopna \n kolabiraju u 2; rezultat se trim-uje.
 */
export function htmlToText(html: string | null | undefined): string {
  if (!html || typeof html !== 'string') return '';
  if (typeof DOMParser === 'undefined') return ''; // SSR guard
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const br of [...doc.body.querySelectorAll('br')]) {
    br.replaceWith(doc.createTextNode('\n'));
  }
  for (const el of [...doc.body.querySelectorAll('p, li, div, h1, h2, h3, h4, h5, h6')]) {
    el.after(doc.createTextNode('\n'));
  }
  return (doc.body.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
}

/* ── Paste sanitizacija (Word / Google Docs / Slack đubre) ─────────────────── */

/** Širi whitelist za PASTE (1.0 sastanciPasteSanitize.js) — h1–h3/img prežive
 *  paste, ali ih sanitizeHtml na SAVE svejedno strip-uje (1.0 paritet). */
const PASTE_ALLOWED_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'ul', 'ol', 'li', 'b', 'strong', 'i', 'em', 'u', 'a', 'br', 'img',
]);

const PASTE_STRIP_ATTRS = new Set([
  'style', 'class', 'id', 'color', 'face', 'font-family', 'font-size', 'background',
]);

function isSafeImgSrc(src: string): boolean {
  const s = String(src || '').trim().toLowerCase();
  return s.startsWith('http://') || s.startsWith('https://') || s.startsWith('data:image/');
}

function sanitizePasteNode(node: Element): void {
  const children = [...node.childNodes];
  for (const child of children) {
    if (child.nodeType === Node.TEXT_NODE) continue;
    if (!(child instanceof Element)) {
      child.remove();
      continue;
    }
    const tag = child.tagName.toLowerCase();
    if (!PASTE_ALLOWED_TAGS.has(tag)) {
      sanitizePasteNode(child);
      while (child.firstChild) node.insertBefore(child.firstChild, child);
      child.remove();
      continue;
    }
    for (const attr of [...child.attributes]) {
      const name = attr.name.toLowerCase();
      if (PASTE_STRIP_ATTRS.has(name)) {
        child.removeAttribute(attr.name);
        continue;
      }
      if (tag === 'a' && name === 'href') {
        if (!isSafeHref(attr.value)) child.removeAttribute('href');
        continue;
      }
      if (tag === 'img' && name === 'src') {
        if (!isSafeImgSrc(attr.value)) child.removeAttribute('src');
        continue;
      }
      if (name !== 'href' && name !== 'src' && name !== 'alt' && name !== 'title') {
        child.removeAttribute(attr.name);
      }
    }
    if (tag === 'a' && child.hasAttribute('href')) {
      child.setAttribute('target', '_blank');
      child.setAttribute('rel', 'noopener noreferrer');
    }
    sanitizePasteNode(child);
  }
}

/** Sanitizuje HTML iz clipboard-a pre insertHTML u editor. */
export function sanitizeZapisnikPasteHtml(html: string | null | undefined): string {
  if (!html || typeof html !== 'string') return '';
  if (typeof DOMParser === 'undefined') return ''; // SSR guard
  const doc = new DOMParser().parseFromString(html, 'text/html');
  sanitizePasteNode(doc.body);
  return doc.body.innerHTML;
}

/* ── Plain tekst → bezbedan HTML ───────────────────────────────────────────── */

const ESC: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Plain tekst → escapovan HTML sa <br> prelomima. Koristi se za fallback
 * prikaza tačaka koje imaju samo sadrzajText (stare 2.0 izmene su pisale samo
 * tekst!) i za ubacivanje AI-doteranog teksta nazad u editor.
 */
export function textToHtml(text: string | null | undefined): string {
  if (!text) return '';
  return String(text)
    .replace(/[&<>"']/g, (c) => ESC[c] ?? c)
    .replace(/\r?\n/g, '<br>');
}
