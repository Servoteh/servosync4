import pg from 'pg';

import { config } from '../config.js';
import { logJob } from '../logger.js';
import { getSupabase } from './supabase.js';

const log = logJob('scada_store');

/**
 * SLOJ UPISA SCADA PODATAKA — jedan ugovor, dva izvora (seoba sy15 -> 3.0, 07.08.2026).
 * Runbook: docs/SEOBA_SCADA_2026-08-07.md.
 *
 * ── ZAŠTO DIREKTAN POSTGRES ZA 3.0, A NE NEŠTO DRUGO ─────────────────────────
 * Do sada je relej pisao ISKLJUČIVO kroz PostgREST (`SUPABASE_URL` -> kontejner
 * `sy15-gateway`). 3.0 baza NEMA PostgREST — dakle kanal se mora promeniti, nema
 * varijante „ostavi kako jeste". Razmotrena su tri puta i izabran je direktan
 * Postgres; obrazloženje stoji ovde jer je ovo mesto koje se menja:
 *
 *  1. DIREKTAN POSTGRES (izabrano)
 *     + Trust se NE menja: relej već nosi `service_role` ključ koji zaobilazi RLS
 *       nad celom sy15 bazom — dakle već je potpuno poverljiv pisac. Konekcioni
 *       string je isti nivo poverenja, ne veći.
 *     + Svaki upis je upsert sa izričitim conflict target-om — tačno ono što je
 *       PostgREST i emulirao, samo bez HTTP/JSON sloja i bez deljenja na 500-redne
 *       komade. `scada_history` ide ~3.540 redova/sat; sada je to jedan `INSERT`.
 *     + `claim` komandi traži `FOR UPDATE SKIP LOCKED` — transakcioni obrazac koji
 *       je preko PostgREST-a MORAO da bude `SECURITY DEFINER` RPC. 3.0 nema RPC
 *       sloj da ga ugosti; direktno je to jedan običan upit.
 *     − Nova zavisnost (`pg`) i konekcioni string u `.env` releja.
 *
 *  2. HTTP ingest endpoint na 3.0 backendu — ODBIJENO. Dodao bi novu rutu, DTO
 *     validaciju i serijalizaciju svih uzoraka, a nadzor kotlarnica bi postao
 *     zavisan od toga da backend radi. Backend se redeployuje na svaki push na
 *     `main`; SCADA nadzor ne sme da stane zbog deploy-a.
 *
 *  3. Preseliti relej u 3.0 scheduler — ODBIJENO. ERP backend bi počeo da poluje
 *     uređaje, sa istim deploy problemom, a CLAUDE.md relej namerno drži kao
 *     zaseban stabilan proces (SCADA gateway drži JEDNU konekciju ka Unitronics
 *     PLC-u i ume da se blokira — taj sloj se ne dira olako).
 *
 * ── ŠTA OVAJ PREKIDAČ NE POKRIVA ────────────────────────────────────────────
 * `bridge_sync_log` (dnevnik prolaza releja, `syncLog.js`) OSTAJE U sy15 i pod
 * `3.0`. To nije SCADA domen nego operativni dnevnik samog releja, koji deli i
 * druga instanca bridge-a (`servoteh-bridge` za BigTehn). Da je i on prešao,
 * dnevnik bi se raspolovio na dve baze bez ikakve koristi. Isto važi i za alerte.
 */

let _pool = null;

/** Lenji singleton pool ka 3.0 bazi (pravi se tek ako je izvor stvarno `3.0`). */
function getPool() {
  if (_pool) return _pool;
  _pool = new pg.Pool({
    connectionString: config.scada.pgUrl,
    max: config.scada.pgPoolMax,
    // Relej radi u petlji od 5 s — konekcija se drži, ne otvara se po prolazu.
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  // Bez ovoga bi pad konekcije u pozadini (restart baze) srušio ceo proces:
  // `pg` emituje 'error' na idle klijentu, a neuhvaćen 'error' je fatalan.
  _pool.on('error', (err) => log.error({ err }, 'pg pool idle greška (nastavljamo)'));
  return _pool;
}

/* ========================================================================== */
/* sy15 (PostgREST) — postojeće ponašanje, nepromenjeno                        */
/* ========================================================================== */

const sy15Store = {
  izvor: 'sy15',

  async listActiveAlarms(siteKey) {
    const supa = getSupabase();
    const { data, error } = await supa
      .from('scada_alarms')
      .select('id, code, severity, text')
      .eq('site_key', siteKey)
      .eq('active', true);
    if (error) throw new Error(`[scada] alarms select ${siteKey}: ${error.message}`);
    return data || [];
  },

  async updateAlarm(id, patch) {
    const supa = getSupabase();
    const { error } = await supa.from('scada_alarms').update(patch).eq('id', id);
    if (error) throw new Error(`[scada] alarms update: ${error.message}`);
  },

  async insertAlarms(rows) {
    if (!rows.length) return;
    const supa = getSupabase();
    const { error } = await supa.from('scada_alarms').insert(rows);
    if (error) throw new Error(`[scada] alarms insert: ${error.message}`);
  },

  async clearAlarms(ids) {
    if (!ids.length) return;
    const supa = getSupabase();
    const { error } = await supa
      .from('scada_alarms')
      .update({ active: false, cleared_at: new Date().toISOString() })
      .in('id', ids);
    if (error) throw new Error(`[scada] alarms clear: ${error.message}`);
  },

  async upsertSnapshot(row) {
    const supa = getSupabase();
    const { error } = await supa
      .from('scada_snapshots')
      .upsert(row, { onConflict: 'site_key' });
    if (error) throw new Error(`[scada] snapshot upsert ${row.site_key}: ${error.message}`);
  },

  async updateSite(siteKey, patch) {
    const supa = getSupabase();
    const { error } = await supa.from('scada_sites').update(patch).eq('key', siteKey);
    if (error) throw new Error(`[scada] site update ${siteKey}: ${error.message}`);
  },

  async upsertHistory(rows) {
    if (!rows.length) return;
    const supa = getSupabase();
    const { error } = await supa
      .from('scada_history')
      .upsert(rows, { onConflict: 'site_key,metric,ts' });
    if (error) throw new Error(`[scada] history upsert: ${error.message}`);
  },

  async deleteHistoryBefore(cutoffIso) {
    const supa = getSupabase();
    const { error } = await supa.from('scada_history').delete().lt('ts', cutoffIso);
    if (error) throw new Error(`[scada] history cleanup: ${error.message}`);
  },

  async claimCommands(limit) {
    const supa = getSupabase();
    const { data, error } = await supa.rpc('scada_claim_commands', { p_limit: limit });
    if (error) throw new Error(`[scada] claim_commands RPC: ${error.message}`);
    return data || [];
  },

  async setCommandOutcome(id, status, result) {
    const supa = getSupabase();
    const patch = { status, result };
    if (status === 'applied' || status === 'failed') patch.applied_at = new Date().toISOString();
    const { error } = await supa.from('scada_commands').update(patch).eq('id', id);
    if (error) throw new Error(`[scada] command outcome: ${error.message}`);
  },
};

/* ========================================================================== */
/* 3.0 (direktan Postgres)                                                     */
/* ========================================================================== */

const pg30Store = {
  izvor: '3.0',

  async listActiveAlarms(siteKey) {
    const { rows } = await getPool().query(
      'SELECT id, code, severity, text FROM scada_alarms WHERE site_key = $1 AND active',
      [siteKey],
    );
    // `id` je bigint — `pg` ga vraća kao STRING (da ne izgubi preciznost). Job ga
    // koristi samo kao neproziran ključ (poređenje/`IN`), pa string radi isto.
    return rows;
  },

  async updateAlarm(id, patch) {
    await getPool().query(
      'UPDATE scada_alarms SET text = $2, severity = $3 WHERE id = $1',
      [id, patch.text ?? null, patch.severity],
    );
  },

  async insertAlarms(rows) {
    if (!rows.length) return;
    // `ON CONFLICT DO NOTHING` prati parcijalni UNIQUE `scada_alarms_one_active`:
    // ponovljen prolaz ne sme da udvoji isti AKTIVAN alarm (isto kao watchdog).
    await getPool().query(
      `INSERT INTO scada_alarms (site_key, code, severity, text)
       SELECT * FROM UNNEST($1::text[], $2::text[], $3::smallint[], $4::text[])
       ON CONFLICT DO NOTHING`,
      [
        rows.map((r) => r.site_key),
        rows.map((r) => r.code),
        rows.map((r) => r.severity),
        rows.map((r) => r.text ?? null),
      ],
    );
  },

  async clearAlarms(ids) {
    if (!ids.length) return;
    await getPool().query(
      'UPDATE scada_alarms SET active = false, cleared_at = now() WHERE id = ANY($1::bigint[])',
      [ids],
    );
  },

  async upsertSnapshot(row) {
    await getPool().query(
      `INSERT INTO scada_snapshots (site_key, payload, online, updated_at)
       VALUES ($1, $2::jsonb, $3, $4)
       ON CONFLICT (site_key) DO UPDATE
          SET payload = EXCLUDED.payload,
              online = EXCLUDED.online,
              updated_at = EXCLUDED.updated_at`,
      [row.site_key, JSON.stringify(row.payload), row.online, row.updated_at],
    );
  },

  async updateSite(siteKey, patch) {
    await getPool().query('UPDATE scada_sites SET online = $2, last_seen = $3 WHERE key = $1', [
      siteKey,
      patch.online,
      patch.last_seen,
    ]);
  },

  async upsertHistory(rows) {
    if (!rows.length) return;
    // Jedan izraz za ceo prolaz (do ~60 redova): UNNEST paralelnih nizova umesto
    // N pojedinačnih INSERT-a. `DO UPDATE` jer relej sme da prepiše isti minutni
    // bucket svežijom vrednošću (PK = site_key+metric+ts, ts poravnat na minut).
    await getPool().query(
      `INSERT INTO scada_history (site_key, metric, ts, value)
       SELECT * FROM UNNEST($1::text[], $2::text[], $3::timestamptz[], $4::double precision[])
       ON CONFLICT (site_key, metric, ts) DO UPDATE SET value = EXCLUDED.value`,
      [
        rows.map((r) => r.site_key),
        rows.map((r) => r.metric),
        rows.map((r) => r.ts),
        rows.map((r) => (r.value == null ? null : Number(r.value))),
      ],
    );
  },

  async deleteHistoryBefore(cutoffIso) {
    await getPool().query('DELETE FROM scada_history WHERE ts < $1', [cutoffIso]);
  },

  /**
   * PREPIS sy15 `scada_claim_commands(p_limit)` (izvučen `pg_get_functiondef`
   * 07.08.2026) — 3.0 nema DEFINER RPC sloj, pa ista tri koraka idu kao tri izraza
   * u JEDNOJ transakciji:
   *   1. istekle `pending` -> `expired` (audit ostaje),
   *   2. zaglavljene `claimed` starije od 2 min -> `failed` (relej pao pre ishoda;
   *      NIKAD se ne vraćaju u pending — komanda se ne sme izvršiti dvaput),
   *   3. preuzmi do `limit` svežih `pending` sa `FOR UPDATE SKIP LOCKED`.
   * Transakcija je bitna: bez nje bi dva prolaza mogla da preuzmu istu komandu.
   */
  async claimCommands(limit) {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE scada_commands
            SET status = 'expired',
                result = COALESCE(result, jsonb_build_object('error', 'expired before claim'))
          WHERE status = 'pending' AND expires_at < now()`,
      );
      await client.query(
        `UPDATE scada_commands
            SET status = 'failed',
                applied_at = now(),
                result = COALESCE(result, jsonb_build_object(
                  'error', 'bridge prekinut pre potvrde — ishod nepoznat (NIJE ponovo izvršeno)'))
          WHERE status = 'claimed' AND claimed_at < now() - interval '2 minutes'`,
      );
      const { rows } = await client.query(
        `WITH picked AS (
           SELECT c.id FROM scada_commands c
            WHERE c.status = 'pending' AND c.expires_at >= now()
            ORDER BY c.requested_at
            LIMIT GREATEST(1, LEAST($1::int, 50))
            FOR UPDATE SKIP LOCKED
         )
         UPDATE scada_commands c
            SET status = 'claimed', claimed_at = now()
           FROM picked
          WHERE c.id = picked.id
        RETURNING c.*`,
        [limit],
      );
      await client.query('COMMIT');
      return rows;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw new Error(`[scada] claim_commands: ${err.message}`);
    } finally {
      client.release();
    }
  },

  async setCommandOutcome(id, status, result) {
    // `applied_at` se postavlja SAMO za applied/failed (paritet sy15 `setOutcome`):
    // rejected komanda nikad nije stigla do uređaja, pa nema „vreme primene".
    const setApplied = status === 'applied' || status === 'failed';
    await getPool().query(
      `UPDATE scada_commands
          SET status = $2,
              result = $3::jsonb,
              applied_at = CASE WHEN $4 THEN now() ELSE applied_at END
        WHERE id = $1::uuid`,
      [id, status, JSON.stringify(result ?? null), setApplied],
    );
  },
};

/**
 * Aktivan store po prekidaču `SCADA_IZVOR`. Bira se JEDNOM (config je zamrznut),
 * pa se izvor ne može promeniti bez restarta — namerno: promena izvora usred rada
 * bi razdvojila snapshot i istoriju istog prolaza na dve baze.
 */
export function getScadaStore() {
  return config.scada.izvor === '3.0' ? pg30Store : sy15Store;
}

/** Uredno zatvaranje pool-a (SIGTERM) — bez ovoga systemd čeka na otvorene konekcije. */
export async function closeScadaStore() {
  if (_pool) {
    await _pool.end().catch(() => {});
    _pool = null;
  }
}
