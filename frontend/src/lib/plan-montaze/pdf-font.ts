// Deljeni Roboto (latin-ext: čćšžđ) VFS loader za jsPDF — font iz /public/fonts,
// isti origin (radi i na LAN-u). Koriste ga izvestaj-pdf i gantt-pdf.

import type { jsPDF } from 'jspdf';

async function fetchFontBase64(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Font ${url} nedostupan (${res.status})`);
  const buf = await res.arrayBuffer();
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** Registruj Roboto normal+bold u jsPDF instancu (nova instanca = uvek ponovo). */
export async function ensureRoboto(doc: jsPDF): Promise<void> {
  const [reg, bold] = await Promise.all([
    fetchFontBase64('/fonts/Roboto-Regular.ttf'),
    fetchFontBase64('/fonts/Roboto-Bold.ttf'),
  ]);
  doc.addFileToVFS('Roboto-Regular.ttf', reg);
  doc.addFont('Roboto-Regular.ttf', 'Roboto', 'normal');
  doc.addFileToVFS('Roboto-Bold.ttf', bold);
  doc.addFont('Roboto-Bold.ttf', 'Roboto', 'bold');
}

/** '#rrggbb' → [r,g,b]. */
export function hexToRgb(hex: string): [number, number, number] {
  const m = hex.replace('#', '');
  const n = m.length === 3 ? m.split('').map((c) => c + c).join('') : m;
  const int = parseInt(n, 16);
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
}
