/* =====================================================================
   SCADA bridge shim v2 — učitava se PRVI u svakom originalnom HMI ekranu.
   Originalni ekrani su portovani 1:1 iz Scada_PLC/app; jedina razlika je
   izvor podataka:
     GET  api-state/s7/...  -> scada_snapshots.payload iz Supabase (isti JSON)
     GET  api-history rute  -> scada_history (kroz roditeljski most)
     POST api-write rute    -> scada_commands (allowlist + audit) + cekanje ishoda
   Most: window.parent.__SCADA_BRIDGE__ (isti origin; auth/RLS u roditelju).
   v2: sinhronizacija teme (init + uzivo), read-only rezim bez prava
   kontrole, __scadaConfirm (es-modal u roditelju), s7/loxone history rute.
   ===================================================================== */
(function () {
  'use strict';
  if (window.__SCADA_SHIM__) return;   // guard od duplog ucitavanja
  window.__SCADA_SHIM__ = true;

  const origFetch = window.fetch.bind(window);
  const bridge = () => (window.parent && window.parent.__SCADA_BRIDGE__) || null;

  // --- TEMA: preuzmi od roditelja PRE ekranskih skripti -----------------
  // Ekrani rade applyTheme(localStorage['theme'] || 'dark'), pa je dovoljno
  // da shim (koji se izvrsava prvi, sinhrono) upise roditeljsku temu u
  // localStorage['theme'] + dataset. Uzivo: roditelj salje 'scada-theme'.
  function applyParentTheme(t) {
    if (t !== 'light' && t !== 'dark') return;
    try { localStorage.setItem('theme', t); } catch (_) {}
    document.documentElement.dataset.theme = t;
  }
  // Kanal = `?theme=` koji host (HmiHost) VEĆ prosleđuje u src iframe-a; roditeljski
  // `data-theme` se ne cita (2.0 ljuska ga ne postavlja → ekran bi ostao trajno dark).
  // Default light (2.0 je light-only). Uzivo promena: host reloaduje iframe (key) ILI
  // salje 'scada-theme' (listener nize).
  try {
    const q = new URLSearchParams(location.search).get('theme');
    applyParentTheme(q === 'dark' ? 'dark' : 'light');
  } catch (_) {}
  window.addEventListener('message', (e) => {
    const d = e && e.data;
    if (d && d.type === 'scada-theme') applyParentTheme(d.theme);
  });

  // --- sakrij originalni top-bar (roditelj ima svoje tabove) ------------
  const style = document.createElement('style');
  style.textContent = 'header.t-bar{display:none!important}';
  try { (document.head || document.documentElement).appendChild(style); } catch (_) {}

  // --- READ-ONLY rezim (korisnik bez prava kontrole) --------------------
  // 1) CSS sakrije komandnu dugmad; 2) capture-blocker preseca klik na
  // SVG komandne elemente (pumpe/kaloriferi/dani...) pre ekranskog handlera.
  const CMD_SELECTOR = '.cbtn,.cstep,[data-pump],[data-pumpbox],[data-kal],[data-lxfan],' +
    '[data-lxtgl],[data-lxsw],[data-lxset],[data-lxstep],[data-rt],[data-s7grej],[data-s7hlad],' +
    '[data-s7auto],[data-s7man],[data-s7sp],[data-s7boiler],[data-s7estop],[data-schedok],' +
    '[data-sched],[data-areset],[data-dev],[data-day],[data-sgmode]';
  let canControl = true;
  function applyReadOnly() {
    try { canControl = bridge()?.canControl ? !!bridge().canControl() : true; } catch (_) { canControl = true; }
    if (canControl) return;
    const ro = document.createElement('style');
    ro.textContent = '.cbtn,.cstep{display:none!important}';
    try { (document.head || document.documentElement).appendChild(ro); } catch (_) {}
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyReadOnly);
  } else { applyReadOnly(); }

  document.addEventListener('click', (e) => {
    // read-only blokada mora PRE ekranskog handlera (capture faza)
    if (!canControl && e.target.closest && e.target.closest(CMD_SELECTOR)) {
      e.stopImmediatePropagation();
      e.preventDefault();
      alert('Nemate pravo slanja komandi (samo pregled).');
      return;
    }
    // navigacija: klik na link ekrana -> prebaci tab u roditelju
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    const href = a.getAttribute('href') || '';
    if (href.endsWith('.html') || href === '/' || href === '') {
      e.preventDefault();
      const file = href.split('/').pop() || '';
      const map = {
        '': 'pregled', 'overview.html': 'pregled', 'index.html': 'pregled',
        'kot1.html': 'kot1', 'kot2.html': 'kot2', 'kot3.html': 'kot3',
        'solar-kaco.html': 'solar-kaco', 'solar-sigen.html': 'solar-sigen',
      };
      const tab = map[file] != null ? map[file] : 'pregled';
      try { window.parent.postMessage({ type: 'scada-nav', tab }, '*'); } catch (_) {}
    }
  }, true);

  // --- POTVRDA kroz roditeljski es-modal (zamena za window.confirm) -----
  let _confirmSeq = 0;
  const _confirmWaiters = new Map();
  window.addEventListener('message', (e) => {
    const d = e && e.data;
    if (d && d.type === 'scada-confirm-result' && _confirmWaiters.has(d.id)) {
      _confirmWaiters.get(d.id)(!!d.ok);
      _confirmWaiters.delete(d.id);
    }
  });
  window.__scadaConfirm = function (text) {
    return new Promise((resolve) => {
      const id = ++_confirmSeq;
      _confirmWaiters.set(id, resolve);
      try { window.parent.postMessage({ type: 'scada-confirm', id, text: String(text || '') }, '*'); }
      catch (_) { _confirmWaiters.delete(id); resolve(window.confirm(text)); }
      // fallback ako roditelj ne odgovori (nema modula?) — 15 s pa odbij
      setTimeout(() => {
        if (_confirmWaiters.has(id)) { _confirmWaiters.delete(id); resolve(false); }
      }, 15000);
    });
  };

  // --- onemoguci WS ka localhost-u (cloud mod nema WS; ekrani polluju) ---
  try {
    const NativeWS = window.WebSocket;
    window.WebSocket = function () {
      return {
        addEventListener() {}, removeEventListener() {}, send() {}, close() {},
        set onmessage(_) {}, set onopen(_) {}, set onclose(_) {}, set onerror(_) {},
        readyState: 3,
      };
    };
    window.WebSocket.OPEN = NativeWS ? NativeWS.OPEN : 1;
  } catch (_) {}

  function jsonResponse(obj, ok = true) {
    return new Response(JSON.stringify(obj), {
      status: ok ? 200 : 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const SNAP_MAP = {
    '/api/state': 'kot1',
    '/api/s7': 'kot2',
    '/api/loxone': 'kot3',
    '/api/bluelog': 'solar-kaco',
    '/api/sigen': 'solar-sigen',
  };

  async function handleApi(url, opts) {
    const b = bridge();
    if (!b) return jsonResponse({ error: 'bridge nije dostupan' }, false);
    const u = new URL(url, location.origin);
    const path = u.pathname;
    const method = (opts && opts.method ? opts.method : 'GET').toUpperCase();

    if (method === 'POST') {
      let body = {};
      try { body = opts && opts.body ? JSON.parse(opts.body) : {}; } catch (_) {}
      let siteKey = null; let target = null; let value = null;
      if (path === '/api/write') { siteKey = 'kot1'; target = body.name; value = { v: body.value }; }
      /* Loxone write pokriva i Switch (0/1) i ValueSelector (npr. ventilator
         0-3) — zato ide kao ':value' (numericki allowlist), ne ':switch'. */
      else if (path === '/api/s7/write') { siteKey = 'kot2'; target = body.tag; value = { v: body.value }; }
      else if (path === '/api/loxone/write') { siteKey = 'kot3'; target = body.key + ':value'; value = { v: body.value }; }
      else if (path === '/api/loxone/roomtemp') { siteKey = 'kot3'; target = 'room:' + body.key; value = { v: body.value, mode: body.mode }; }
      else if (path === '/api/sigen/write') { siteKey = 'solar-sigen'; target = 'operatingMode'; value = { systemId: body.systemId, mode: body.mode }; }
      else return jsonResponse({ error: 'nepoznata komanda' }, false);
      try {
        const res = await b.sendCommand({ siteKey, target, value });
        return jsonResponse(res.ok ? { ok: true } : { error: res.error || 'komanda odbijena' }, !!res.ok);
      } catch (err) {
        return jsonResponse({ error: String(err && err.message || err) }, false);
      }
    }

    if (SNAP_MAP[path]) {
      const payload = await b.getSnapshot(SNAP_MAP[path]);
      return jsonResponse(payload || { online: false });
    }

    if (path === '/api/history') return jsonResponse(await b.getHistory('kot1'));
    if (path === '/api/s7/history') return jsonResponse(await b.getHistory('kot2'));
    if (path === '/api/loxone/history') return jsonResponse(await b.getHistory('kot3'));
    if (path === '/api/sigen/history') {
      const sys = u.searchParams.get('system') || '';
      return jsonResponse(await b.getHistory('solar-sigen', { system: sys }));
    }
    if (path === '/api/bluelog/history') return jsonResponse(await b.getHistory('solar-kaco'));

    // meta o alarmima (raised_at itd. iz scada_alarms) — koriste ekrani za prava vremena
    if (path === '/api/alarmmeta') {
      const site = u.searchParams.get('site') || '';
      const alarms = b.getAlarms ? await b.getAlarms(site) : [];
      return jsonResponse({ alarms: alarms || [] });
    }

    if (path === '/api/tags') {
      const r = await origFetch('kot1-tags.json');
      const j = await r.json();
      return jsonResponse({ ...j, online: true, simulate: false });
    }

    return jsonResponse({ error: 'nepoznat endpoint: ' + path }, false);
  }

  window.fetch = function (input, opts) {
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.indexOf('/api/') !== -1) return handleApi(url, opts);
    } catch (_) { /* padni na original */ }
    return origFetch(input, opts);
  };
})();
