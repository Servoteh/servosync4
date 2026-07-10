/**
 * TSPL2 raw proxy za TSC ML340P (i kompatibilne).
 *
 * Sluzi: prima POST {payload:{tspl2:"..."}} sa frontenda,
 *        otvara TCP socket ka stampacu (default 192.168.70.20:9100)
 *        i salje raw TSPL2 program direktno - zaobilazi Chrome i Windows driver.
 *
 * Pokretanje:
 *   node label-proxy.mjs
 *
 * ENV varijable (opciono):
 *   PRINTER_HOST  default 192.168.70.20
 *   PRINTER_PORT  default 9100
 *   PROXY_PORT    default 8765
 *   ALLOW_ORIGIN  default *  (CORS)
 *
 * Posle pokretanja, u root projekta servoteh-plan-montaze napravi .env.local sa:
 *   VITE_LABEL_PRINTER_PROXY_URL=http://localhost:8765/print
 * i restartuj Vite dev server (npm run dev).
 *
 * Health check:
 *   curl http://localhost:8765/health
 *
 * Test print iz CLI-a (treba da odmah izadje nalepnica):
 *   curl -X POST http://localhost:8765/print -H "Content-Type: application/json" \
 *     -d "{\"payload\":{\"tspl2\":\"CLS\\r\\nTEXT 30,30,\\\"3\\\",0,1,1,\\\"PROXY OK\\\"\\r\\nPRINT 1,1\\r\\n\"}}"
 */

import http from 'node:http';
import net from 'node:net';

const PRINTER_HOST = process.env.PRINTER_HOST || '192.168.70.20';
const PRINTER_PORT = Number(process.env.PRINTER_PORT) || 9100;
const PROXY_PORT = Number(process.env.PROXY_PORT) || 8765;
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';
const MAX_BODY = 1024 * 1024; /* 1 MB hard cap */

/**
 * Salje raw bytes na TCP port stampaca. Resolve-uje sa { ok, bytes } ili reject-uje.
 * @param {string} tspl2
 */
function sendToPrinter(tspl2) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: PRINTER_HOST, port: PRINTER_PORT });
    let settled = false;
    const finish = (err, res) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch (_) {}
      err ? reject(err) : resolve(res);
    };
    sock.setTimeout(10_000); /* 10s connect+write timeout */
    sock.on('timeout', () => finish(new Error('printer timeout')));
    sock.on('error', e => finish(e));
    sock.on('connect', () => {
      sock.write(tspl2, 'binary', () => {
        sock.end();
      });
    });
    sock.on('close', () => finish(null, { ok: true, bytes: Buffer.byteLength(tspl2) }));
  });
}

function readBody(req, max = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', c => {
      total += c.length;
      if (total > max) {
        reject(new Error('body too large'));
        try { req.destroy(); } catch (_) {}
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(Buffer.concat(chunks).toString('utf8')); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOW_ORIGIN);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '86400');
}

const server = http.createServer(async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  /* Health check */
  if (req.method === 'GET' && url.pathname === '/health') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      ok: true,
      printer: `${PRINTER_HOST}:${PRINTER_PORT}`,
      port: PROXY_PORT,
      uptime: process.uptime(),
    }));
    return;
  }

  /* Test connectivity (probace samo TCP konekciju, ne salje sadrzaj) */
  if (req.method === 'GET' && url.pathname === '/probe') {
    const t = Date.now();
    const sock = net.createConnection({ host: PRINTER_HOST, port: PRINTER_PORT });
    let done = false;
    const finish = (ok, err) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch (_) {}
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok, ms: Date.now() - t, error: err ? String(err) : undefined }));
    };
    sock.setTimeout(5000);
    sock.on('connect', () => finish(true));
    sock.on('error', e => finish(false, e));
    sock.on('timeout', () => finish(false, new Error('timeout')));
    return;
  }

  /* Main print endpoint */
  if (req.method === 'POST' && url.pathname === '/print') {
    try {
      const raw = await readBody(req);
      let body;
      try { body = JSON.parse(raw); } catch { throw new Error('invalid JSON'); }
      const tspl2 = body?.payload?.tspl2;
      if (typeof tspl2 !== 'string' || !tspl2.trim()) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: false, error: 'missing payload.tspl2' }));
        return;
      }
      /* Sanity guard: ako payload sadrzi SIZE/GAP/DENSITY komande - odbij.
       * Te komande mogu blokirati stampac (vidi docs/labels/02-visual-spec.md).
       * Frontend je vec u encode-only mode-u, ali bolje paranoja na proxyju. */
      const upper = tspl2.toUpperCase();
      const forbidden = ['SIZE ', 'GAP ', 'DENSITY ', 'SPEED ', 'CODEPAGE ', 'SET TEAR', 'REFERENCE ', 'OFFSET '];
      const hit = forbidden.find(k => upper.includes(k));
      if (hit) {
        res.statusCode = 422;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: false, error: `forbidden TSPL2 command: ${hit.trim()} (printer config je read-only iz klijenta)` }));
        console.warn(`[reject] forbidden command "${hit.trim()}" - did NOT send to printer`);
        return;
      }
      const result = await sendToPrinter(tspl2);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(result));
      console.log(`[print] ok bytes=${result.bytes} from ${req.socket.remoteAddress}`);
    } catch (e) {
      console.error('[print] error:', e?.message || e);
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
    }
    return;
  }

  res.statusCode = 404;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ ok: false, error: 'not found' }));
});

server.listen(PROXY_PORT, '0.0.0.0', () => {
  console.log('==============================================================');
  console.log(`TSPL2 raw proxy listening on http://0.0.0.0:${PROXY_PORT}`);
  console.log(`Forwarding to printer ${PRINTER_HOST}:${PRINTER_PORT}`);
  console.log('Endpoints:');
  console.log(`   GET  /health   -> service status`);
  console.log(`   GET  /probe    -> TCP connectivity check ka stampacu`);
  console.log(`   POST /print    -> body: {payload:{tspl2:"..."}}`);
  console.log('==============================================================');
});

process.on('SIGINT', () => { console.log('\nstopping...'); server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
