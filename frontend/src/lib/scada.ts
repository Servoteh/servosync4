// Energetika / SCADA — deljeni tipovi, čitači payload-a i clock-safe staleness.
// 3.0 TALAS E (backend docs/design/MODULE_SPEC_scada_30.md). Podaci žive u sy15
// (1.0) bazi; 2.0 BE ih čita (GET) i R2 upisuje komande. FE sloj (ovaj fajl) je
// ČISTA logika — bez React-a — pa je dele desktop (/energetika) i touch (/m/energetika).
//
// Oblik `payload` (jsonb) se NAMERNO NE normalizuje: kopirani HP-HMI ekrani ga čitaju
// 1:1, a touch čita iste ključeve (paritet 1.0 myEnergetika.js). Zato su čitači ispod
// tolerantni na `unknown` i vraćaju uske primitivce (number|null, boolean).

// ─────────────────────────────────────────────────────────────────────────────
// KOMANDNI PREKIDAČ (R3 stub → R2/R4 wiring)
//
// Komandni tok (POST /energetika/commands + /:id/cancel) je backend R2 — na grani
// `wave-e/energetika` JOŠ U TOKU i NIJE deploy-ovan. Dok ne sleti i ne prođe živi
// smoke (R4), komande su ISKLJUČENE: `canControl()` vraća false (desktop HMI ide
// read-only, touch krije kontrole), a `sendScadaCommandFlow` kratko spaja sa jasnom
// porukom. Ceo tok (insert → poll → cancel-on-timeout 15 s) je IMPLEMENTIRAN po
// spec §3 i 1.0 semantici (ZAMRZNUTA — FE samo šalje, ne menja tok). Aktivacija =
// PROMENA OVE JEDNE KONSTANTE na `true` kad E R2 bude živ (i verifikovan).
// AKTIVIRANO 15.07.2026: BE POST /commands živ na main; on-prem bridge
// (servoteh-bridge-scada.service, SCADA_CONTROL=true) aktivno poluje i izvršava
// (scada_commands: 13 applied / 5 rejected); DC2 ugašen — ubuntu je jedini kontroler.
export const COMMANDS_ENABLED = true;

// ─────────────────────────────────────────────────────────────────────────────
// Tipovi (API vraća camelCase — Prisma modeli scada_*; vidi backend sy15.prisma).

export interface ScadaSite {
  key: string;
  name: string;
  kind: string;
  protocol: string | null;
  online: boolean;
  lastSeen: string | null;
  sortOrder: number;
  meta: Record<string, unknown>;
}

/** Jedan red scada_snapshots. `payload` = sirovi /api/* JSON sa SCADA app-a. */
export interface ScadaSnapshotRow {
  siteKey: string;
  payload: ScadaPayload;
  online: boolean;
  updatedAt: string;
}

export type ScadaPayload = Record<string, unknown>;

export interface ScadaAlarm {
  id: number;
  siteKey: string;
  code: string;
  severity: number;
  text: string | null;
  active: boolean;
  raisedAt: string;
  clearedAt: string | null;
}

export type ScadaCommandStatus =
  | 'pending'
  | 'claimed'
  | 'applied'
  | 'failed'
  | 'rejected'
  | 'expired';

export interface ScadaCommand {
  id: string;
  siteKey: string;
  target: string;
  op: string;
  value: Record<string, unknown> | null;
  status: ScadaCommandStatus | string;
  requestedBy: string;
  requestedAt: string;
  claimedAt: string | null;
  appliedAt: string | null;
  expiresAt: string;
  idempotencyKey: string | null;
  // Ishod od bridge-a (FE čita samo `.error`; ostala polja se ignorišu).
  result: { error?: string } | null;
}

/** long-format red istorije (BE preset filtrira metrike po sistemu — spec §3). */
export interface HistoryRow {
  metric: string;
  ts: string;
  value: number | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Metapodaci sistema (redosled tabova + ikone; imena stižu iz scada_sites/API).

export type SiteKey = 'kot1' | 'kot2' | 'kot3' | 'solar-kaco' | 'solar-sigen';

/** Redosled sistema + HMI ekran (paritet 1.0 SITE_SCREEN / TAB_LABELS). */
export const SITE_META: Record<
  SiteKey,
  { name: string; ico: string; screen: string; tabLabel: string }
> = {
  kot1: { name: 'Kotlarnica 1', ico: '🔥', screen: 'kot1.html', tabLabel: 'Kotlarnica 1' },
  kot2: { name: 'Kotlarnica 2', ico: '🔥', screen: 'kot2.html', tabLabel: 'Kotlarnica 2' },
  kot3: { name: 'Kotlarnica 3', ico: '🔥', screen: 'kot3.html', tabLabel: 'Kotlarnica 3' },
  'solar-kaco': { name: 'FNE KACO', ico: '☀️', screen: 'solar-kaco.html', tabLabel: 'FNE KACO' },
  'solar-sigen': { name: 'Sigenergy', ico: '☀️', screen: 'solar-sigen.html', tabLabel: 'Sigenergy' },
};

export const SITE_ORDER: SiteKey[] = ['kot1', 'kot2', 'kot3', 'solar-kaco', 'solar-sigen'];

export function siteName(key: string, sites?: ScadaSite[]): string {
  const row = sites?.find((s) => s.key === key);
  return row?.name || SITE_META[key as SiteKey]?.name || key;
}
export function siteIco(key: string): string {
  return SITE_META[key as SiteKey]?.ico || '⚡';
}

// ─────────────────────────────────────────────────────────────────────────────
// Clock-safe staleness (pravilo firme — spec §0). Svežina NE sme da zavisi od
// apsolutnog sata uređaja (domenske mašine/telefoni odlutaju → sve lažno „offline").
// Referenca = najsvežije viđeno server-vreme (E4 `serverNow` iz meta, ili max
// `updatedAt`) + PROTEKLO klijentsko vreme (razlika Date.now() je pouzdana i kad je
// apsolutni sat pomeren): estServerNow ≈ ref + (Date.now() − seenAt). Prag 60 s.

export const STALE_MS = 60_000;

const _clock = { ts: 0, seenAt: 0 };

function toMs(iso: string | Date | null | undefined): number {
  if (!iso) return NaN;
  const ms = iso instanceof Date ? iso.getTime() : new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : NaN;
}

/**
 * Zabeleži server-vremensku referencu. Zovi sa `meta.serverNow` (najtačnije, E4)
 * i sa svakim `updatedAt` (fallback). Uzima najveću vrednost — serverNow ≥ svaki
 * updatedAt, pa kad je bridge živ ref prati realno server-vreme; kad stane, ref
 * i dalje raste kroz serverNow svakog poll-a → stari snapshotovi postaju stale.
 */
export function noteServerTime(iso: string | Date | null | undefined): void {
  const ms = toMs(iso);
  if (Number.isFinite(ms) && ms > _clock.ts) {
    _clock.ts = ms;
    _clock.seenAt = Date.now();
  }
}

export function estServerNow(): number {
  return _clock.ts ? _clock.ts + (Date.now() - _clock.seenAt) : Date.now();
}

export function ageMs(iso: string | Date | null | undefined): number {
  const ms = toMs(iso);
  return Number.isFinite(ms) ? Math.max(0, estServerNow() - ms) : Infinity;
}

export function isStale(iso: string | Date | null | undefined): boolean {
  return ageMs(iso) > STALE_MS;
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatiranje (srpski; datum dd.MM, decimalni broj sa jednom cifrom).

export function f1(v: unknown): string {
  const n = Number(v);
  return v == null || v === '' || !Number.isFinite(n) ? '—' : n.toFixed(1);
}
export function f0(v: unknown): string {
  const n = Number(v);
  return v == null || v === '' || !Number.isFinite(n) ? '—' : String(Math.round(n));
}

export function fmtAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const s = Math.round(ageMs(iso) / 1000);
  if (!Number.isFinite(s)) return '—';
  if (s < 120) return `pre ${s}s`;
  if (s < 7200) return `pre ${Math.round(s / 60)}min`;
  return `pre ${Math.round(s / 3600)}h`;
}

export function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('sr-RS', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '—';
  }
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleTimeString('sr-RS');
  } catch {
    return '—';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Status sistema (svežina relativna na server, ne na sat uređaja).

export type SiteStatusTone = 'on' | 'off' | 'stale';

/** [labela, ton] — 'stale' kad ne javlja > 60 s (paritet 1.0 siteStatus). */
export function siteStatus(snap: ScadaSnapshotRow | null | undefined): [string, SiteStatusTone] {
  if (!snap || !snap.updatedAt) return ['NE JAVLJA', 'stale'];
  if (isStale(snap.updatedAt)) return ['NE JAVLJA', 'stale'];
  return snap.online ? ['ONLINE', 'on'] : ['OFFLINE', 'off'];
}

export function isLiveOnline(snap: ScadaSnapshotRow | null | undefined): boolean {
  return siteStatus(snap)[0] === 'ONLINE';
}

// ─────────────────────────────────────────────────────────────────────────────
// Čitači payload-a (oblik identičan lokalnom SCADA API-ju — docs/scada §2.1).
// Cast na indeksabilni lokal je nameran: jsonb je dinamičan (spoljni izvor).

type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});
const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** kot1 (Unitronics): values[tag].value */
export function k1Val(p: ScadaPayload | null, tag: string): number | null {
  const values = asObj(asObj(p).values);
  return num(asObj(values[tag]).value);
}

/** kot2 (Siemens): temps[].value po key */
export function k2Temp(p: ScadaPayload | null, key: string): number | null {
  const temps = Array.isArray(asObj(p).temps) ? (asObj(p).temps as Obj[]) : [];
  const row = temps.find((t) => asObj(t).key === key);
  return row ? num(asObj(row).value) : null;
}

/** kot3 (Loxone): prosek merenih temp soba (kind='room', states.tempActual). */
export function kot3RoomAvg(p: ScadaPayload | null): number | null {
  const live = asObj(asObj(p).live);
  const tags = Array.isArray(asObj(p).tags) ? (asObj(p).tags as Obj[]) : [];
  let sum = 0;
  let cnt = 0;
  for (const t of tags) {
    const states = asObj(asObj(t).states);
    if (asObj(t).kind === 'room' && states.tempActual) {
      const v = num(live[String(states.tempActual)]);
      if (v != null) {
        sum += v;
        cnt += 1;
      }
    }
  }
  return cnt ? sum / cnt : null;
}
export function kot3Rooms(p: ScadaPayload | null): Obj[] {
  const tags = Array.isArray(asObj(p).tags) ? (asObj(p).tags as Obj[]) : [];
  return tags.filter((t) => asObj(t).kind === 'room');
}
export function kot3Live(p: ScadaPayload | null, uuid: unknown): number | null {
  if (!uuid) return null;
  const live = asObj(asObj(p).live);
  return num(live[String(uuid)]);
}

/** sigen (Sigenergy): zbir/prosek polja preko svih sistema u values{}. */
export function sigenSum(p: ScadaPayload | null, field: string): number | null {
  const values = asObj(asObj(p).values);
  let total: number | null = null;
  for (const vals of Object.values(values)) {
    const v = num(asObj(asObj(vals)[field]).value);
    if (v != null) total = (total || 0) + v;
  }
  return total;
}
export function sigenSocAvg(p: ScadaPayload | null): number | null {
  const values = asObj(asObj(p).values);
  let sum = 0;
  let cnt = 0;
  for (const vals of Object.values(values)) {
    const v = num(asObj(asObj(vals).batterySoc).value);
    if (v != null) {
      sum += v;
      cnt += 1;
    }
  }
  return cnt ? sum / cnt : null;
}
export function sigenVal(p: ScadaPayload | null, sysId: string, field: string): number | null {
  const values = asObj(asObj(p).values);
  return num(asObj(asObj(values[sysId])[field]).value);
}

// ─────────────────────────────────────────────────────────────────────────────
// M1 pregled: hero cifra + dva reda po sistemu (paritet 1.0 heroFor/rowsFor).

/** [broj (string), jedinica, labela]. */
export function heroFor(key: string, p: ScadaPayload | null): [string, string, string] {
  if (key === 'kot1') return [f1(k1Val(p, 'T_SUDA')), '°C', 'temperatura suda'];
  if (key === 'kot2') return [f1(k2Temp(p, 'Temp_suda')), '°C', 'temperatura suda'];
  if (key === 'kot3') return [f1(kot3RoomAvg(p)), '°C', 'prosek soba'];
  if (key === 'solar-kaco') return [f1(num(asObj(asObj(p).plant).kw)), 'kW', 'trenutna snaga'];
  if (key === 'solar-sigen') return [f1(sigenSum(p, 'pvPower')), 'kW', 'PV proizvodnja'];
  return ['—', '', ''];
}

/** [[labela, vrednost], …] — dva manja reda po sistemu. */
export function rowsFor(key: string, p: ScadaPayload | null): [string, string][] {
  if (key === 'kot1') {
    const cool = k1Val(p, 'GREJ_HLAD') === 1;
    const auto = (k1Val(p, 'AUTO_MAN') ?? 0) > 0;
    const rezim = p ? `${cool ? '❄ hlađenje' : '🔥 grejanje'} · ${auto ? 'AUTO' : 'RUČNO'}` : '—';
    return [['Spolja', `${f1(k1Val(p, 'T_SPOLJA'))} °C`], ['Režim', rezim]];
  }
  if (key === 'kot2') {
    const pumps = Array.isArray(asObj(p).pumps) ? (asObj(p).pumps as Obj[]) : [];
    const kal = Array.isArray(asObj(p).kaloriferi) ? (asObj(p).kaloriferi as Obj[]) : [];
    const pOn = pumps.filter((x) => asObj(x).on).length;
    const kOn = kal.filter((x) => asObj(x).on).length;
    return [
      ['Zadata', `${f1(asObj(p).setpoint)} °C`],
      ['Oprema', p ? `pumpe ${pOn}/${pumps.length} · kaloriferi ${kOn}/${kal.length}` : '—'],
    ];
  }
  if (key === 'kot3') {
    const tags = Array.isArray(asObj(p).tags) ? (asObj(p).tags as Obj[]) : [];
    const buf = tags.find(
      (t) => asObj(t).type === 'InfoOnlyAnalog' && /BUFFER/i.test(String(asObj(t).name || '')),
    );
    return [
      ['Sobe', String(kot3Rooms(p).length || '—')],
      ['Buffer tank', `${f1(kot3Live(p, asObj(asObj(buf).states).value))} °C`],
    ];
  }
  if (key === 'solar-kaco') {
    const plant = asObj(asObj(p).plant);
    const rep = plant.reportingInverters;
    const cnt = plant.count;
    return [
      ['Danas', `${f1(plant.kwhDay)} kWh`],
      ['Invertori javljaju', rep != null && cnt != null ? `${rep}/${cnt}` : '—'],
    ];
  }
  if (key === 'solar-sigen') {
    return [
      ['Potrošnja', `${f1(sigenSum(p, 'loadPower'))} kW`],
      ['Baterija', `${f0(sigenSocAvg(p))} %`],
    ];
  }
  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Statusi komandi (audit tab + touch) — paritet 1.0 CMD_STATUS/commandStatusBadge.

import type { Tone } from '@/components/ui-kit/status-badge';

export const CMD_STATUS: Record<string, { label: string; tone: Tone }> = {
  pending: { label: '⏳ čeka', tone: 'neutral' },
  claimed: { label: '🔄 u obradi', tone: 'info' },
  applied: { label: '✅ primenjeno', tone: 'success' },
  failed: { label: '❌ greška', tone: 'danger' },
  rejected: { label: '🚫 odbijeno', tone: 'danger' },
  expired: { label: '⌛ isteklo', tone: 'warn' },
};

export function cmdStatusLabel(status: string): { label: string; tone: Tone } {
  return CMD_STATUS[status] || { label: status || '—', tone: 'neutral' };
}

// ─────────────────────────────────────────────────────────────────────────────
// kot1 touch konstante (paritet 1.0 myEnergetika.js).

/** kot1 zone: naziv + merena temperatura + setpoint tag (allowlist bridge-a). */
export const K1_ZONES: { l: string; t: string; sp: string }[] = [
  { l: 'Spolja', t: 'T_SPOLJA', sp: 'SP_SPOLJA' },
  { l: 'Sud — gornji prag', t: 'T_SUDA', sp: 'SP_SUDA_H' },
  { l: 'Sud — donji prag', t: 'T_SUDA', sp: 'SP_SUDA_L' },
  { l: 'CNC radionica', t: 'T_CNC', sp: 'SP_CNC' },
  { l: 'Zavarivanje', t: 'T_ZAVAR', sp: 'SP_ZAVAR' },
  { l: 'Montaža', t: 'T_MONTAZA1', sp: 'SP_MONTAZA' },
  { l: 'Hidraulika', t: 'T_HIDRAULIKA', sp: 'SP_HIDRAULIKA' },
];

/** kot1 uređaji: status lampica (K1…P4) + „Ručno" toggle (RK_K1…RK_P4). */
export const K1_DEVICES = ['K1', 'K2', 'K3', 'K4', 'K5', 'P1', 'P2', 'P3', 'P4'];

/**
 * kot1 setpoint opsezi [min, max] °C — OGLEDALO bridge allowlist-a. Klijentski
 * clamp je samo UX; bridge ostaje krajnji autoritet šta sme da se piše.
 */
export const K1_SP_RANGES: Record<string, [number, number]> = {
  SP_SPOLJA: [-10, 30],
  SP_SUDA_H: [20, 90],
  SP_SUDA_L: [20, 90],
  SP_MONTAZA: [5, 35],
  SP_CNC: [5, 35],
  SP_HIDRAULIKA: [5, 35],
  SP_ZAVAR: [5, 35],
};
