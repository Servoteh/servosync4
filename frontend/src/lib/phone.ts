// Telefon helperi — normalizacija u srpski međunarodni format, wa.me / tel:
// linkovi, vCard. Port 1.0 `src/lib/phone.js` (ista logika kao edge
// hr-notify-dispatch normalizeWaPhone). Koristi Imenik: pozivi/WhatsApp/vCard.

/**
 * „0637774847" → „381637774847"; „+381 64 123 4567" → „381641234567";
 * „00381…" → „381…"; već „381…" prolazi. '' ako nema dovoljno cifara.
 */
export function normalizeSrPhone(raw: string | null | undefined): string {
  let d = String(raw ?? '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('381')) {
    /* već međunarodni */
  } else if (d.startsWith('0')) d = '381' + d.slice(1);
  else if (d.length >= 8 && d.length <= 9) d = '381' + d;
  return d.length >= 11 ? d : '';
}

/** wa.me link (otvara WhatsApp ka tom broju). '' ako broj nije validan. */
export function waLink(raw: string | null | undefined, text = ''): string {
  const n = normalizeSrPhone(raw);
  if (!n) return '';
  return `https://wa.me/${n}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
}

/** tel: link za poziv (zadrži + i cifre). '' ako prazno. */
export function telLink(raw: string | null | undefined): string {
  const d = String(raw ?? '').replace(/[^\d+]/g, '');
  return d ? `tel:${d}` : '';
}

/** „+381 63 777 4847" za prikaz, iz proizvoljnog ulaza. Fallback = original. */
export function prettyPhone(raw: string | null | undefined): string {
  const n = normalizeSrPhone(raw);
  if (!n) return String(raw ?? '').trim();
  const rest = n.slice(3); // posle 381
  /* Grupiši samo očekivani 8–9 cifreni nacionalni broj; nestandardno ostaje as-is. */
  const groups = /^\d{8,9}$/.test(rest)
    ? rest.replace(/^(\d{2,3})(\d{3})(\d{2,4})$/, '$1 $2 $3')
    : rest;
  return `+381 ${groups}`;
}

/** Da li je broj srpski mobilni (lokalno 06x → međunarodno 3816x). */
export function isSrMobile(raw: string | null | undefined): boolean {
  const n = normalizeSrPhone(raw);
  return !!n && n.slice(3).startsWith('6');
}

export interface VCardEmployee {
  firstName?: string | null;
  lastName?: string | null;
  fullName?: string | null;
  position?: string | null;
  phonePrivate?: string | null;
  phoneWork?: string | null;
  phone?: string | null;
  email?: string | null;
}

/** vCard 3.0 blok za jednog zaposlenog. Telefoni: mobilni (CELL) + poslovni (WORK). */
export function employeeVCard(e: VCardEmployee): string {
  const last = (e.lastName || '').trim();
  const first = (e.firstName || '').trim();
  const fn = first || last ? `${first} ${last}`.trim() : (e.fullName || 'Zaposleni').trim();
  const esc = (s: unknown) =>
    String(s ?? '')
      .replace(/[\\;,]/g, (m) => '\\' + m)
      .replace(/\r\n|\r|\n/g, '\\n');
  const lines = ['BEGIN:VCARD', 'VERSION:3.0', `N:${esc(last)};${esc(first)};;;`, `FN:${esc(fn)}`, 'ORG:SERVOTEH d.o.o.'];
  if (e.position) lines.push(`TITLE:${esc(e.position)}`);
  const mob = String(e.phonePrivate || '').trim();
  const work = String(e.phoneWork || e.phone || '').trim();
  if (mob) lines.push(`TEL;TYPE=CELL:${esc(prettyPhone(mob))}`);
  if (work && work !== mob) lines.push(`TEL;TYPE=WORK:${esc(prettyPhone(work))}`);
  if (e.email) lines.push(`EMAIL:${esc(e.email)}`);
  lines.push('END:VCARD');
  return lines.join('\r\n');
}
