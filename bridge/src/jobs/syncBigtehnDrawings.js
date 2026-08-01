import { promises as fs } from 'node:fs';
import path from 'node:path';

import { config } from '../config.js';
import { getSupabase, upsertChunked } from '../db/supabase.js';
import { logJob } from '../logger.js';
import { failRun, finishRun, startRun } from './syncLog.js';

const log = logJob('syncBigtehnDrawings');
const JOB_NAME = 'production_bigtehn_drawings';
const BUCKET = 'bigtehn-drawings';
const TABLE = 'bigtehn_drawings_cache';

/**
 * Sinhronizuje PDF crteže iz lokalnog Win folder-a na BigBit serveru
 * (default: C:\PDMExport\PDFImportovano) u Supabase Storage bucket
 * `bigtehn-drawings` + metapodatke u tabelu `bigtehn_drawings_cache`.
 *
 * Strategija:
 *   1) Listaj sve PDF fajlove u BIGTEHN_DRAWINGS_DIR.
 *   2) Za svaki fajl uradi `stat` (mtime, size).
 *   3) Učitaj postojeće zapise iz `bigtehn_drawings_cache` (Map po drawing_no).
 *   4) Razdvoj u 3 kategorije:
 *        - NEW          — fajl postoji na disku, NEMA u cache-u → upload + insert
 *        - CHANGED      — fajl ima noviji mtime nego u cache-u → upload + update
 *        - REMOVED      — postoji u cache-u (removed_at IS NULL), NEMA na disku → soft-delete
 *      Ostale (UNCHANGED) preskačemo.
 *   5) Sequential upload (Storage je network-bound; paralelizam ne pomaže za velike fajlove
 *      i lakše je za logging).
 *
 * Konvencije:
 *   - drawing_no = naziv fajla BEZ ekstenzije (npr. "12345.pdf" → "12345")
 *   - storage_path = ime fajla unutar bucket-a (root, npr. "12345.pdf")
 *   - Idempotentno: ponovni run ne radi ništa novo ako se ništa nije promenilo.
 *
 * Env var BIGTEHN_DRAWINGS_DIR mora biti postavljena (videti config.js).
 * Ako je prazna, job se preskoči sa upozorenjem (ne fail).
 */
export async function syncBigtehnDrawings() {
  const drawingsDir = config.bigtehnDrawingsDir;
  if (!drawingsDir) {
    log.warn(
      'BIGTEHN_DRAWINGS_DIR nije postavljena u .env — preskačem job (nema greške).',
    );
    return { skipped: true };
  }

  const run = await startRun(JOB_NAME);
  log.info({ dir: drawingsDir }, 'start');

  try {
    /* 1) Listaj fajlove na disku */
    let entries;
    try {
      entries = await fs.readdir(drawingsDir);
    } catch (err) {
      throw new Error(
        `Ne mogu da pročitam BIGTEHN_DRAWINGS_DIR (${drawingsDir}): ${err.message}`,
      );
    }
    const pdfFiles = entries.filter((f) => /\.pdf$/i.test(f));
    log.info({ totalFiles: entries.length, pdfFiles: pdfFiles.length }, 'listed dir');

    /* 2) Stat svakog fajla → mapa po drawing_no */
    const onDisk = new Map(); /* drawing_no → { fileName, fullPath, mtime, size } */
    for (const fileName of pdfFiles) {
      const fullPath = path.join(drawingsDir, fileName);
      try {
        const st = await fs.stat(fullPath);
        if (!st.isFile()) continue;
        const drawingNo = path.basename(fileName, path.extname(fileName));
        onDisk.set(drawingNo, {
          fileName,
          fullPath,
          mtime: st.mtime,
          size: st.size,
        });
      } catch (err) {
        log.warn({ fileName, err: err.message }, 'stat failed; skip');
      }
    }

    /* 3) Učitaj cache (samo aktivne) */
    const cache = await loadCacheMap();
    log.info({ inCache: cache.size, onDisk: onDisk.size }, 'compared');

    /* 4) Klasifikacija */
    const toUpload = []; /* { drawingNo, fileName, fullPath, mtime, size, isNew } */
    const toRemove = []; /* { id, drawing_no, storage_path } */

    for (const [drawingNo, fileInfo] of onDisk) {
      const cached = cache.get(drawingNo);
      if (!cached) {
        toUpload.push({ ...fileInfo, drawingNo, isNew: true });
      } else {
        const cachedMtime = cached.mtime ? new Date(cached.mtime).getTime() : 0;
        const diskMtime = fileInfo.mtime.getTime();
        /* Tolerancija ±2s — Supabase pamti TIMESTAMPTZ ms precizno, NTFS ima 100ns,
           ali sata na različitim mašinama mogu biti malo razmaknuta. */
        if (Math.abs(diskMtime - cachedMtime) > 2000) {
          toUpload.push({ ...fileInfo, drawingNo, isNew: false });
        }
      }
    }

    for (const [drawingNo, cached] of cache) {
      if (!onDisk.has(drawingNo)) {
        toRemove.push({
          id: cached.id,
          drawing_no: drawingNo,
          storage_path: cached.storage_path,
        });
      }
    }

    log.info(
      {
        toUpload: toUpload.length,
        newCount: toUpload.filter((x) => x.isNew).length,
        changedCount: toUpload.filter((x) => !x.isNew).length,
        toRemove: toRemove.length,
      },
      'classified',
    );

    /* 5) Upload (sequential) */
    const uploadedRows = [];
    const supa = getSupabase();
    let uploadOk = 0;
    let uploadErr = 0;
    let uploadedBytes = 0;

    for (let i = 0; i < toUpload.length; i++) {
      const item = toUpload[i];
      const storagePath = `${item.drawingNo}.pdf`; /* normalizovano: lowercase ext */
      try {
        const buf = await fs.readFile(item.fullPath);
        const { error } = await supa.storage.from(BUCKET).upload(storagePath, buf, {
          contentType: 'application/pdf',
          upsert: true,
          cacheControl: '3600',
        });
        if (error) {
          throw new Error(error.message);
        }
        uploadOk += 1;
        uploadedBytes += item.size;
        uploadedRows.push({
          drawing_no: item.drawingNo,
          storage_path: storagePath,
          original_path: item.fullPath,
          file_name: item.fileName,
          mime_type: 'application/pdf',
          size_bytes: item.size,
          mtime: item.mtime.toISOString(),
          synced_at: new Date().toISOString(),
          removed_at: null,
        });
        if ((i + 1) % 25 === 0 || i === toUpload.length - 1) {
          log.info(
            {
              progress: `${i + 1}/${toUpload.length}`,
              uploadedMB: Math.round((uploadedBytes / 1024 / 1024) * 10) / 10,
              ok: uploadOk,
              err: uploadErr,
            },
            'upload progress',
          );
        }
      } catch (err) {
        uploadErr += 1;
        log.warn(
          { drawingNo: item.drawingNo, fileName: item.fileName, err: err.message },
          'upload failed',
        );
      }
    }

    /* 6) UPSERT metapodataka */
    let upsertedTotal = 0;
    if (uploadedRows.length) {
      const { total } = await upsertChunked(TABLE, uploadedRows, 'drawing_no', 200);
      upsertedTotal = total;
    }

    /* 7) Soft-delete removed (set removed_at, ostavi storage objekat — periodični cleanup
          se može dodati kasnije; za sad ne brišemo iz Storage-a da imamo "rollback") */
    let softDeleted = 0;
    if (toRemove.length) {
      const nowIso = new Date().toISOString();
      const ids = toRemove.map((x) => x.id);
      const { error, count } = await supa
        .from(TABLE)
        .update({ removed_at: nowIso })
        .in('id', ids)
        .select('id', { count: 'exact', head: true });
      if (error) {
        log.warn({ err: error.message }, 'soft-delete failed');
      } else {
        softDeleted = count ?? ids.length;
      }
    }

    const stats = {
      totalOnDisk: onDisk.size,
      totalInCache: cache.size,
      uploaded: uploadOk,
      uploadFailed: uploadErr,
      upserted: upsertedTotal,
      softDeleted,
      uploadedMB: Math.round((uploadedBytes / 1024 / 1024) * 10) / 10,
    };
    log.info(stats, 'done');

    await finishRun(run, { rowsUpdated: upsertedTotal + softDeleted });
    return stats;
  } catch (err) {
    log.error({ err: err?.message || err }, 'failed');
    await failRun(run, err);
    throw err;
  }
}

/**
 * Učitaj sve aktivne (removed_at IS NULL) zapise u Map po drawing_no.
 */
async function loadCacheMap() {
  const supa = getSupabase();
  const out = new Map();
  let from = 0;
  const PAGE = 1000;
  /* Paginate u slučaju >1000 (default Supabase limit) */
  while (true) {
    const { data, error } = await supa
      .from(TABLE)
      .select('id, drawing_no, storage_path, mtime, size_bytes')
      .is('removed_at', null)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      throw new Error(`[bigtehnDrawings] cache fetch failed: ${error.message}`);
    }
    if (!data || data.length === 0) break;
    for (const row of data) {
      out.set(row.drawing_no, row);
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return out;
}
