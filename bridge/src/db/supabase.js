import { createClient } from '@supabase/supabase-js';

import { config } from '../config.js';

let _client = null;

/**
 * Singleton Supabase klijent sa SERVICE ROLE key-em.
 * VAŽNO: service role bypassuje RLS — nikad ne expose-uj u browseru.
 * autoRefreshToken/persistSession isključeni jer je ovo backend.
 */
export function getSupabase() {
  if (_client) return _client;
  _client = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { 'x-client-info': `servoteh-bridge/${config.instanceName}` } },
  });
  return _client;
}

/**
 * Batch upsert helper.
 * Deli rows u chunk-ove (default 500) da izbegne payload limite Supabase REST-a.
 * Vraća { inserted, updated, total } — pošto PostgREST ne razlikuje insert/update,
 * vraćamo ukupno upsertovano + insert/update razdvajamo na osnovu vremena
 * (ako se promenilo `synced_at` i postoje stari redovi, ne razlikujemo).
 * Za našu metriku `bridge_sync_log` dovoljno je `total`.
 */
export async function upsertChunked(table, rows, conflictColumn = 'id', chunkSize = 500) {
  const supa = getSupabase();
  if (!Array.isArray(rows) || rows.length === 0) {
    return { total: 0, chunks: 0 };
  }
  let total = 0;
  let chunks = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const { error, count } = await supa
      .from(table)
      .upsert(chunk, { onConflict: conflictColumn, count: 'exact' });
    if (error) {
      const err = new Error(
        `[supabase] upsert ${table} chunk ${chunks + 1} failed: ${error.message}`,
      );
      err.cause = error;
      err.chunkSize = chunk.length;
      throw err;
    }
    total += count ?? chunk.length;
    chunks += 1;
  }
  return { total, chunks };
}
