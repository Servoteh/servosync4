import {
  POSITION_SECTIONS,
  buildOrgTree,
  hasText,
  mdToBlocks,
  positionHasContent,
} from './position-sections';
import type { JobPosition, OrgStructure } from '@/api/kadrovska';

// Word izvoz „Sistematizacija radnih mesta" — ISTA struktura kao PDF
// (`sistematizacija.ts`), samo drugi izlaz: Word-kompatibilan HTML snimljen kao
// `.doc` (MIME `application/msword`, UTF-8 sa BOM-om). Word ga otvara i normalno
// edituje/prelama.
//
// ⚠️ KOMPROMIS: ovo NIJE pravi `.docx` (OOXML), nego `.doc` (HTML) — svesna odluka
// da se izbegne nova zavisnost (frontend/CLAUDE.md pravilo 9). Word prikazuje
// „Zaštićeni prikaz"/upozorenje o formatu pri otvaranju kod nekih podešavanja;
// „Sačuvaj kao → .docx" iz Word-a daje pravi docx. Pravi `.docx` bi tražio ručno
// sklapanje OOXML paketa (jszip JESTE već zavisnost) ili `docx` biblioteku.

const DOC_TITLE = 'Sistematizacija radnih mesta';

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}.`;
}

function fileStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function pluralMesta(n: number): string {
  const d1 = n % 10;
  const d2 = n % 100;
  if (d1 === 1 && d2 !== 11) return `${n} radno mesto`;
  if (d1 >= 2 && d1 <= 4 && (d2 < 12 || d2 > 14)) return `${n} radna mesta`;
  return `${n} radnih mesta`;
}

/** Blokovi markdowna → HTML; uzastopne stavke liste se spajaju u jedan <ul>. */
function blocksToHtml(md: string): string {
  const out: string[] = [];
  let inList = false;
  const closeList = () => {
    if (inList) { out.push('</ul>'); inList = false; }
  };
  for (const b of mdToBlocks(md)) {
    if (b.kind === 'li') {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${esc(b.text)}</li>`);
      continue;
    }
    closeList();
    if (b.kind === 'gap') continue;
    if (b.kind === 'h') out.push(`<p class=mdh>${esc(b.text)}</p>`);
    else out.push(`<p class=body>${esc(b.text)}</p>`);
  }
  closeList();
  return out.join('\n');
}

function positionHtml(p: JobPosition): string {
  const out: string[] = [`<p class=pos>${esc(String(p.name || '—').trim())}</p>`];

  if (hasText(p.reportsToLine)) {
    out.push(`<p class=reports><b>Linijski odgovara:</b> ${esc(p.reportsToLine.trim())}</p>`);
  }

  if (!positionHasContent(p)) {
    out.push('<p class=empty>Opis ovog radnog mesta još nije unet u sistematizaciju.</p>');
    return out.join('\n');
  }

  for (const [field, secTitle] of POSITION_SECTIONS) {
    const val = p[field];
    if (!hasText(val)) continue;
    out.push(`<p class=sec>${esc(secTitle)}</p>`);
    out.push(blocksToHtml(val));
  }
  return out.join('\n');
}

const CSS = `
@page WordSection1 { size: 21cm 29.7cm; margin: 2cm 2cm 2cm 2cm; }
div.WordSection1 { page: WordSection1; }
body { font-family: Calibri, Arial, sans-serif; font-size: 11.0pt; color: #1f2937; }
p { margin: 0 0 6pt 0; }
p.cover-company { font-size: 14.0pt; font-weight: bold; color: #141414; margin-bottom: 2pt; }
p.cover-addr { font-size: 9.5pt; color: #6e6e6e; margin-bottom: 24pt; }
p.cover-title { font-size: 28.0pt; font-weight: bold; color: #111827; text-align: center; margin: 60pt 0 6pt 0; }
p.cover-sub { font-size: 12.0pt; color: #6b7280; text-align: center; margin-bottom: 24pt; }
p.cover-meta { font-size: 10.5pt; color: #374151; text-align: center; margin: 0 0 4pt 0; }
p.toc-h { font-size: 13.0pt; font-weight: bold; color: #111827; margin: 28pt 0 8pt 0; }
p.toc { font-size: 10.5pt; color: #374151; margin: 0 0 3pt 0; }
p.dept { font-size: 15.0pt; font-weight: bold; color: #ffffff; background: #111827;
         padding: 7pt 8pt; margin: 0 0 12pt 0; }
p.sub { font-size: 12.5pt; font-weight: bold; color: #374151;
        border-bottom: 1pt solid #d1d5db; padding-bottom: 3pt; margin: 16pt 0 8pt 0; }
p.pos { font-size: 13.0pt; font-weight: bold; color: #111827;
        border-bottom: 1pt solid #2563eb; padding-bottom: 3pt; margin: 16pt 0 6pt 0; }
p.reports { font-size: 10.0pt; color: #2563eb; background: #f3f5fa; padding: 5pt 7pt; margin: 0 0 8pt 0; }
p.sec { font-size: 11.0pt; font-weight: bold; color: #2563eb; margin: 10pt 0 3pt 0; }
p.mdh { font-size: 10.5pt; font-weight: bold; color: #1f2937; margin: 6pt 0 3pt 0; }
p.body { font-size: 10.5pt; color: #1f2937; margin: 0 0 4pt 0; }
p.empty { font-size: 10.5pt; color: #6b7280; font-style: italic; margin: 0 0 6pt 0; }
ul { margin: 0 0 6pt 0; padding-left: 18pt; }
li { font-size: 10.5pt; color: #1f2937; margin-bottom: 2pt; }
p.footnote { font-size: 8.5pt; color: #9ca3af; margin-top: 24pt; }
`;

export interface SistematizacijaDocOptions {
  /** Datum generisanja (dd.MM.yyyy.); podrazumevano danas. */
  generatedDate?: string;
}

/**
 * Sklapa Word-kompatibilan HTML i vraća ga kao `.doc` Blob
 * (`application/msword`, UTF-8 + BOM — bez BOM-a Word ume da pogrešno pročita
 * srpsku latinicu č/ć/š/ž/đ).
 */
export function generateSistematizacijaDoc(
  org: OrgStructure,
  opts: SistematizacijaDocOptions = {},
): { blob: Blob; fileName: string } {
  const tree = buildOrgTree(org);
  const datum = opts.generatedDate || today();

  const body: string[] = [];

  // Naslovna
  body.push('<p class=cover-company>SERVOTEH d.o.o.</p>');
  body.push('<p class=cover-addr>Ugrinovačka 163, Dobanovci</p>');
  body.push(`<p class=cover-title>${esc(DOC_TITLE)}</p>`);
  body.push('<p class=cover-sub>Opisi radnih mesta po organizacionoj strukturi</p>');
  body.push(`<p class=cover-meta>Datum generisanja: ${esc(datum)}</p>`);
  body.push(
    `<p class=cover-meta>Ukupno: ${esc(pluralMesta(tree.positionCount))} u ${tree.depts.length} org. celina</p>`,
  );
  body.push(
    `<p class=cover-meta>Sa unetim opisom: ${tree.describedCount} od ${tree.positionCount}</p>`,
  );

  // Sadržaj
  if (tree.depts.length) {
    body.push('<p class=toc-h>Sadržaj</p>');
    tree.depts.forEach((d, i) => {
      body.push(
        `<p class=toc>${i + 1}. ${esc(d.department.name)} — ${esc(pluralMesta(d.positionCount))}</p>`,
      );
    });
  }

  // Odeljenja (svako na novoj strani)
  tree.depts.forEach((d, di) => {
    body.push('<br clear=all style="page-break-before:always">');
    body.push(`<p class=dept>${di + 1}. ${esc(d.department.name)}</p>`);
    d.subs.forEach((sub) => {
      if (sub.subDepartment) body.push(`<p class=sub>${esc(sub.subDepartment.name)}</p>`);
      sub.positions.forEach((p) => body.push(positionHtml(p)));
    });
  });

  if (!tree.depts.length) {
    body.push('<p class=empty>Organizaciona struktura još nije uneta.</p>');
  }

  body.push(
    `<p class=footnote>Generisano iz ServoSync — SERVOTEH d.o.o., ${esc(datum)}.</p>`,
  );

  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="utf-8">
<title>${esc(DOC_TITLE)} — SERVOTEH d.o.o.</title>
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument></xml><![endif]-->
<style>${CSS}</style>
</head>
<body>
<div class=WordSection1>
${body.join('\n')}
</div>
</body>
</html>`;

  // BOM: Word bez njega ume da pročita fajl kao Windows-1252 i pokvari č/ć/š/ž/đ.
  const blob = new Blob(['﻿', html], { type: 'application/msword;charset=utf-8' });
  return { blob, fileName: `Sistematizacija_radnih_mesta_${fileStamp()}.doc` };
}
