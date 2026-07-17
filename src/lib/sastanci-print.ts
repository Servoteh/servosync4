'use client';

// Štampa (print prozor) za modul Sastanci — S-P1 paket B, port 1.0:
//  • printZapisnik — services/sastanciArhiva.js buildZapisnikHtml/printZapisnik:
//    HTML šablon zapisnika iz `sastanak_arhiva.snapshot` + window.print() posle
//    800ms (slike stignu da se učitaju).
//  • printAkcije — sastanakDetalj/akcijeTab.js printAkcije: akcioni plan
//    grupisan po RN-u ⭐ redosledom. GRUPISANJE radi POZIVALAC kroz
//    groupAkcijeByRn iz _components/common (rowSort:'rb' = 1.0 orderedForOutput);
//    ovde samo render + print (auto-print kroz window.onload skript, 1.0 obrazac).
//
// Snapshot u `sastanak_arhiva` istorijski ima DVA oblika ključeva: camelCase
// (1.0 FE saveSnapshot — vodioLabel, sadrzajHtml…) i snake_case (DB RPC
// to_jsonb(s) — vodio_label…). Čitamo tolerantno preko `pick(camel, snake)`.

import { sanitizeHtml } from './sastanci-html';
import { toast } from './toast';

type Dict = Record<string, unknown>;

const ESC_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ESC_MAP[c]);
}

/**
 * 'YYYY-MM-DD…' → 'dd.MM.yyyy.' (1.0 formatDate; string-slice bez `new Date`
 * da ne bude TZ pomaka — memorija „ofset za 1 dan").
 */
export function fmtDmy(v: unknown): string {
  if (!v) return '';
  const p = String(v).slice(0, 10).split('-');
  return p.length === 3 && p[0].length === 4 ? `${p[2]}.${p[1]}.${p[0]}.` : String(v);
}

/** DANAS kao 'YYYY-MM-DD' u LOKALNOJ zoni (NE toISOString — UTC vraća juče posle ponoći). */
export function localTodayIso(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function pick(o: Dict | null | undefined, camel: string, snake?: string): unknown {
  if (!o) return undefined;
  const v = o[camel];
  if (v !== undefined && v !== null && v !== '') return v;
  return snake ? o[snake] : undefined;
}

function pstr(o: Dict | null | undefined, camel: string, snake?: string): string {
  const v = pick(o, camel, snake);
  return v === undefined || v === null ? '' : String(v);
}

function parr(o: Dict | null | undefined, key: string): Dict[] {
  const v = o?.[key];
  return Array.isArray(v) ? (v as Dict[]) : [];
}

/**
 * Otvori novi prozor sa HTML-om za štampu. `autoPrintDelayMs` → setTimeout
 * window.print (zapisnik, 1.0 = 800ms); bez njega se očekuje da sam HTML nosi
 * window.onload print skript (akcije, 1.0 obrazac).
 */
function openPrintWindow(html: string, autoPrintDelayMs?: number): boolean {
  const w = window.open('', '_blank');
  if (!w) {
    toast('Dozvoli pop-up prozore za štampu.');
    return false;
  }
  // Preseci reverse-link ka aplikaciji (defense-in-depth uz sanitizeHtml).
  w.opener = null;
  w.document.write(html);
  w.document.close();
  if (autoPrintDelayMs !== undefined) {
    window.setTimeout(() => {
      try {
        w.print();
      } catch {
        /* korisnik štampa ručno */
      }
    }, autoPrintDelayMs);
  }
  return true;
}

// ── Zapisnik (arhiva snapshot) ────────────────────────────────────────────────

/** 1.0 buildZapisnikHtml — verni port šablona i stilova. */
function buildZapisnikHtml(snapshot: Dict | null | undefined): string {
  const s = (snapshot?.sastanak ?? null) as Dict | null;
  if (!snapshot || !s) return '<p>Nema podataka za zapisnik.</p>';

  const ucesniciHtml =
    parr(snapshot, 'ucesnici')
      .filter((u) => !!u.prisutan)
      .map((u) => esc(pstr(u, 'label') || pstr(u, 'email')))
      .join(', ') || '—';

  const pmTeme = parr(snapshot, 'pmTeme');
  const temeHtml =
    pmTeme.length === 0
      ? ''
      : `
    <h2>Dnevni red</h2>
    <ol>
      ${pmTeme
        .map(
          (t) => `
        <li><strong>${esc(pstr(t, 'naslov'))}</strong>${t.opis ? ` — ${esc(pstr(t, 'opis'))}` : ''}</li>
      `,
        )
        .join('')}
    </ol>
  `;

  const akcije = parr(snapshot, 'akcije');
  const akcijeHtml =
    akcije.length === 0
      ? ''
      : `
    <h2>Akcioni plan</h2>
    <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%">
      <thead><tr><th>RB</th><th>Zadatak</th><th>Odgovoran</th><th>Rok</th><th>Status</th></tr></thead>
      <tbody>
        ${akcije
          .map(
            (a, i) => `
          <tr>
            <td>${i + 1}</td>
            <td><strong>${esc(pstr(a, 'naslov'))}</strong>${a.opis ? `<br><small>${esc(pstr(a, 'opis'))}</small>` : ''}</td>
            <td>${esc(
              pstr(a, 'odgovoranLabel', 'odgovoran_label') ||
                pstr(a, 'odgovoranText', 'odgovoran_text') ||
                pstr(a, 'odgovoranEmail', 'odgovoran_email') ||
                '—',
            )}</td>
            <td>${esc(pstr(a, 'rokText', 'rok_text') || fmtDmy(pick(a, 'rok')) || '—')}</td>
            <td>${esc(pstr(a, 'status'))}</td>
          </tr>
        `,
          )
          .join('')}
      </tbody>
    </table>
  `;

  const aktivnosti = parr(snapshot, 'aktivnosti');
  const aktivnostiHtml =
    aktivnosti.length === 0
      ? ''
      : `
    <h2>Pregled stanja po podstavkama</h2>
    <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%">
      <thead><tr><th>RB</th><th>Aktivnosti</th><th>Odgovoran</th><th>Rok</th></tr></thead>
      <tbody>
        ${aktivnosti
          .map(
            (a) => `
          <tr>
            <td>${esc(pstr(a, 'rb'))}</td>
            <td><strong>${esc(pstr(a, 'naslov'))}</strong><div>${sanitizeHtml(pstr(a, 'sadrzajHtml', 'sadrzaj_html'))}</div></td>
            <td>${esc(
              pstr(a, 'odgovoranLabel', 'odgovoran_label') || pstr(a, 'odgovoranText', 'odgovoran_text') || '—',
            )}</td>
            <td>${esc(pstr(a, 'rokText', 'rok_text') || fmtDmy(pick(a, 'rok')) || '—')}</td>
          </tr>
        `,
          )
          .join('')}
      </tbody>
    </table>
  `;

  const slike = parr(snapshot, 'slike');
  const slikeHtml =
    slike.length === 0
      ? ''
      : `
    <h2>Foto dokumentacija (${slike.length})</h2>
    <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:12px">
      ${slike
        .map(
          (sl) => `
        <figure style="margin:0">
          <img src="${esc(pstr(sl, 'signedUrl', 'signed_url'))}" style="max-width:100%;border:1px solid #ccc">
          ${sl.caption ? `<figcaption style="font-size:11px;color:#666">${esc(pstr(sl, 'caption'))}</figcaption>` : ''}
        </figure>
      `,
        )
        .join('')}
    </div>
  `;

  const mesto = pstr(s, 'mesto');
  const metaMesto = mesto ? `<div><strong>Mesto:</strong> ${esc(mesto)}</div>` : '';
  const zapisnicar = pstr(s, 'zapisnicarLabel', 'zapisnicar_label') || pstr(s, 'zapisnicarEmail', 'zapisnicar_email');
  const metaZapis = zapisnicar ? `<div><strong>Zapisničar:</strong> ${esc(zapisnicar)}</div>` : '';
  const napomena = pstr(s, 'napomena');
  const vreme = pstr(s, 'vreme');

  return `<!DOCTYPE html>
<html lang="sr">
<head>
  <meta charset="utf-8">
  <title>Zapisnik — ${esc(pstr(s, 'naslov'))}</title>
  <style>
    body { font-family: 'Segoe UI', Arial, sans-serif; padding: 24px; color: #1a1a1a; }
    h1 { border-bottom: 2px solid #333; padding-bottom: 8px; }
    h2 { margin-top: 24px; color: #333; }
    table { font-size: 12px; }
    th { background: #f0f0f0; text-align: left; }
    .meta { background: #f6f6f6; padding: 12px; border-left: 4px solid #2563eb; margin: 12px 0; }
    .meta div { margin: 4px 0; }
  </style>
</head>
<body>
  <h1>${esc(pstr(s, 'naslov'))}</h1>
  <div class="meta">
    <div><strong>Datum:</strong> ${fmtDmy(pick(s, 'datum'))}${vreme ? ' u ' + esc(vreme) : ''}</div>
    ${metaMesto}
    <div><strong>Vodio sastanak:</strong> ${esc(
      pstr(s, 'vodioLabel', 'vodio_label') || pstr(s, 'vodioEmail', 'vodio_email') || '—',
    )}</div>
    ${metaZapis}
    <div><strong>Učesnici:</strong> ${ucesniciHtml}</div>
  </div>
  ${temeHtml}
  ${aktivnostiHtml}
  ${akcijeHtml}
  ${slikeHtml}
  ${napomena ? `<h2>Napomena</h2><p>${esc(napomena)}</p>` : ''}
  <hr style="margin-top:32px">
  <small style="color:#888">Generisano: ${new Date().toLocaleString('sr-RS')} · Servoteh interni sistem · Sastanci modul</small>
</body>
</html>`;
}

/** Štampaj zapisnik iz arhiva snapshot-a (1.0 printZapisnik paritet). */
export function printZapisnik(snapshot: Dict | null | undefined): boolean {
  return openPrintWindow(buildZapisnikHtml(snapshot), 800);
}

// ── Akcioni plan (grupisan po RN-u) ──────────────────────────────────────────

/** Minimalni strukturni tip reda — `AkcijaRow` (v_akcioni_plan) mu odgovara. */
export interface PrintAkcijaRow {
  naslov: string;
  status: string;
  effective_status?: string | null;
  odgovoran_label?: string | null;
  odgovoran_text?: string | null;
  odgovoran_email?: string | null;
  rok?: string | null;
  rok_text?: string | null;
}

/** RN grupa — `RnGroup` iz _components/common (groupAkcijeByRn) mu odgovara. */
export interface PrintAkcijeGroup {
  code: string;
  naziv: string;
  rows: PrintAkcijaRow[];
}

/** Lokalna kopija AKCIJA_STATUS_LABEL (lib ne uvozi app komponente). */
const STATUS_LABEL: Record<string, string> = {
  otvoren: 'Otvoren',
  u_toku: 'U toku',
  zavrsen: 'Završen',
  kasni: 'Kasni',
  odlozen: 'Odložen',
  otkazan: 'Otkazan',
};

/** 1.0 akcijeTab `odgOf` — tekst pa labela pa email. */
export function akcijaOdgovoran(r: PrintAkcijaRow): string {
  return r.odgovoran_text || r.odgovoran_label || r.odgovoran_email || '';
}

/** 1.0 `AKCIJA_STATUSI[effectiveStatus] || status`. */
export function akcijaStatusLabela(r: PrintAkcijaRow): string {
  return STATUS_LABEL[r.effective_status ?? r.status] ?? r.status;
}

/**
 * Štampaj akcioni plan grupisan po RN-u (1.0 akcijeTab printAkcije paritet).
 * `groups` = groupAkcijeByRn(rows, prioritet, { rowSort: 'rb' }) — ⭐ redosled.
 * `naslov`/`datum` su opcioni (globalni Akcioni plan tab nema sastanak-kontekst;
 * detalj prosleđuje naslov+datum sastanka kao 1.0).
 */
export function printAkcije(
  groups: PrintAkcijeGroup[],
  opts: { naslov?: string | null; datum?: string | null } = {},
): boolean {
  const ukupno = groups.reduce((n, g) => n + g.rows.length, 0);
  let bodyHtml = '';
  for (const g of groups) {
    bodyHtml += `<h2>${esc(g.code ? `${g.code} — ` : '')}${esc(g.naziv)}</h2>
      <table><thead><tr><th>Status</th><th>Zadatak</th><th>Odgovoran</th><th>Rok</th></tr></thead><tbody>
      ${g.rows
        .map(
          (r) =>
            `<tr><td>${esc(akcijaStatusLabela(r))}</td><td>${esc(r.naslov)}</td><td>${esc(
              akcijaOdgovoran(r) || '—',
            )}</td><td>${esc(r.rok_text || fmtDmy(r.rok) || '—')}</td></tr>`,
        )
        .join('')}
      </tbody></table>`;
  }
  const naslov = `Akcioni plan${opts.naslov ? ` — ${opts.naslov}` : ''}`;
  const datum = fmtDmy(opts.datum ?? localTodayIso());
  const html = `<!DOCTYPE html><html lang="sr"><head><meta charset="utf-8"><title>${esc(naslov)}</title>
    <style>body{font-family:'Segoe UI',Arial,sans-serif;padding:20px;color:#1a1a1a}h1{border-bottom:2px solid #333;padding-bottom:6px}
    h2{margin:18px 0 6px;font-size:15px}table{width:100%;border-collapse:collapse;font-size:12px;margin-bottom:8px}
    th,td{border:1px solid #bbb;padding:5px 7px;text-align:left;vertical-align:top}th{background:#eee}
    td:first-child,th:first-child{width:90px}td:nth-child(3),th:nth-child(3){width:130px}td:nth-child(4),th:nth-child(4){width:90px}</style>
    </head><body>
    <h1>${esc(naslov)}</h1>
    <p>Datum: ${esc(datum)} · ukupno ${ukupno} zadataka · redosled po prioritetu predmeta</p>
    ${bodyHtml}
    <script>window.onload=function(){window.print()}</${'script'}>
    </body></html>`;
  return openPrintWindow(html);
}
