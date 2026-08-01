// ===== Servoteh HMI — deljeni premium SVG elementi (tank, sunce, gradijenti) =====
// Uključuje se PRE strane (kot1/kot2/kot3/solar-*). Globalne funkcije: hmiDefs, tankSVG, sunSVG.

// Gradijenti — ubaciti JEDNOM na početak svakog <svg> koji koristi tank/sunce.
function hmiDefs() {
  return `<defs>
    <linearGradient id="tkSteel" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#22303f"/><stop offset=".5" stop-color="#3d5269"/>
      <stop offset="1" stop-color="#1c2735"/>
    </linearGradient>
    <linearGradient id="tkTop" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#3d5269"/><stop offset=".5" stop-color="#5b748e"/>
      <stop offset="1" stop-color="#2a3a4d"/>
    </linearGradient>
    <linearGradient id="tkLiq" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FFB257"/><stop offset=".42" stop-color="#E8523A"/>
      <stop offset="1" stop-color="#2F6FB0"/>
    </linearGradient>
    <radialGradient id="sunGlow" cx=".5" cy=".5" r=".5">
      <stop offset="0" stop-color="#F2994A" stop-opacity=".75"/>
      <stop offset="1" stop-color="#F2994A" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="sunCore" cx=".42" cy=".40" r=".7">
      <stop offset="0" stop-color="#FFE3A6"/><stop offset=".55" stop-color="#F7A23B"/>
      <stop offset="1" stop-color="#E8523A"/>
    </radialGradient>
    <marker id="flowArrow" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="5.5" markerHeight="5.5" orient="auto-start-reverse">
      <path class="flow-arrow" d="M0,0 L10,5 L0,10 z"/>
    </marker>
  </defs>`;
}

// Premium rezervoar (cilindar sa slojevitom tečnošću + očitanje temperature).
// x,y = gornji-levi okvir; w,h = širina/visina; o = {label, attr, val}
//   attr/val: data-atribut za vezivanje temperature (npr attr:'data-val', val:'T_SUDA')
function tankSVG(x, y, w, h, o) {
  o = o || {};
  const cx = x + w / 2, ry = Math.max(8, w * 0.16);
  const top = y + ry, bot = y + h - ry;
  const liqTop = y + h * 0.24;                 // ~76% napunjeno
  const attr = o.attr || 'data-val', val = o.val || '';
  const cid = 'tkc_' + String(val).replace(/[^a-z0-9]/gi, '') + Math.round(x + y);
  const bodyD = `M${x},${top} V${bot} A${w / 2},${ry} 0 0 0 ${x + w},${bot} V${top}`;
  return `<g class="tk">
    ${o.label ? `<text class="tk-lbl" x="${cx}" y="${y - 9}" text-anchor="middle">${o.label}</text>` : ''}
    <!-- prirubnice (gore/dole) -->
    <rect class="tk-port" x="${cx - 5}" y="${y - 7}" width="10" height="9" rx="2"/>
    <rect class="tk-port" x="${cx - 5}" y="${y + h - 2}" width="10" height="9" rx="2"/>
    <!-- telo (čelik) -->
    <path class="tk-shell" d="${bodyD}"/>
    <!-- tečnost (sečena na telo) -->
    <clipPath id="${cid}"><path d="${bodyD} A${w / 2},${ry} 0 0 0 ${x},${top} Z"/></clipPath>
    <g clip-path="url(#${cid})">
      <rect class="tk-liq" x="${x}" y="${liqTop}" width="${w}" height="${bot + ry - liqTop}"/>
      <ellipse class="tk-wave" cx="${cx}" cy="${liqTop}" rx="${w / 2}" ry="${ry * 0.85}"/>
      <rect class="tk-glass" x="${x + w * 0.12}" y="${top - ry}" width="${w * 0.18}" height="${h}" rx="${w * 0.09}"/>
    </g>
    <!-- gornji poklopac + obris -->
    <ellipse class="tk-top" cx="${cx}" cy="${top}" rx="${w / 2}" ry="${ry}"/>
    <path class="tk-shell" style="fill:none" d="${bodyD}"/>
    <!-- skala nivoa -->
    ${[0.35, 0.5, 0.65, 0.8].map(p => `<line class="tk-tick" x1="${x + w - 11}" y1="${y + h * p}" x2="${x + w - 3}" y2="${y + h * p}"/>`).join('')}
    <!-- očitanje -->
    <text class="tk-temp" x="${cx}" y="${y + h * 0.55}" text-anchor="middle" ${attr}="${val}">—</text>
    <text class="tk-lbl" x="${cx}" y="${y + h * 0.55 + 17}" text-anchor="middle" style="fill:#fff;opacity:.85">°C</text>
  </g>`;
}

// Premium sunce (jezgro + animirani zraci + sjaj). cx,cy = centar; r = poluprečnik jezgra.
function sunSVG(cx, cy, r, o) {
  o = o || {};
  let rays = '';
  for (let i = 0; i < 12; i++) {
    const a = i * 30 * Math.PI / 180;
    const x1 = cx + Math.cos(a) * (r * 1.3), y1 = cy + Math.sin(a) * (r * 1.3);
    const x2 = cx + Math.cos(a) * (r * 1.72), y2 = cy + Math.sin(a) * (r * 1.72);
    rays += `<line class="sun-ray" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
  }
  return `<g class="sun">
    <circle class="sun-glow" cx="${cx}" cy="${cy}" r="${r * 2.5}"/>
    <g class="sun-rays">${rays}</g>
    <g class="sun-core-grp"><circle class="sun-core" cx="${cx}" cy="${cy}" r="${r}"/></g>
    ${o.label ? `<text class="tk-lbl" x="${cx}" y="${cy + r * 2.4 + 8}" text-anchor="middle">${o.label}</text>` : ''}
  </g>`;
}

// Centrifugalna pumpa (P&ID): kućište + rotor (vrti kad radi) + LED + naziv.
// data-run="${name}" na grupi (refresh dodaje .run → boja + rotacija); LED ima data-led="${name}".
function pumpSym(cx, cy, r, name, label) {
  r = r || 16;
  let bl = '';
  for (let i = 0; i < 5; i++) bl += `<path class="bl" transform="rotate(${i * 72})" d="M0,0 Q${(r * 0.5).toFixed(1)},${(-r * 0.22).toFixed(1)} ${(r * 0.82).toFixed(1)},${(r * 0.06).toFixed(1)}"/>`;
  return `<g class="sy-pump" data-run="${name}" transform="translate(${cx},${cy})">
    <rect class="sy-volute" x="${(r * 0.48).toFixed(1)}" y="${(-r - 7).toFixed(1)}" width="${(r * 0.95).toFixed(1)}" height="9" rx="2"/>
    <circle class="sy-pcase" r="${r}"/>
    <g class="sy-imp">${bl}</g>
    <circle class="sy-hub" r="${(r * 0.17).toFixed(1)}"/>
    <circle class="sy-led off" cx="${(r * 0.98).toFixed(1)}" cy="${(-r - 1).toFixed(1)}" r="4.5" data-led="${name}"/>
    ${label ? `<text class="sy-sub" y="${(r + 17).toFixed(1)}" text-anchor="middle">${label}</text>` : ''}
  </g>`;
}

// Ventil (leptir-mašna): obojen kad je otvoren/aktivan. name => data-led (refresh dodaje .run).
function valveSym(cx, cy, s, name, label) {
  s = s || 12;
  return `<g class="sy-valve" ${name ? `data-led="${name}"` : ''} transform="translate(${cx},${cy})">
    <path d="M${-s},${(-s * 0.8).toFixed(1)} L0,0 L${-s},${(s * 0.8).toFixed(1)} Z"/>
    <path d="M${s},${(-s * 0.8).toFixed(1)} L0,0 L${s},${(s * 0.8).toFixed(1)} Z"/>
    ${label ? `<text class="sy-sub" y="${s + 15}" text-anchor="middle">${label}</text>` : ''}
  </g>`;
}

// Vrednost protoka na cevi (čip vezan na data-atribut; refresh upisuje broj).
function flowChip(x, y, attr, val, unit) {
  return `<g class="flow-chip">
    <text class="flow-val" x="${x}" y="${y}" text-anchor="middle" ${attr}="${val}">—</text>
    ${unit ? `<text class="flow-unit" x="${x}" y="${y + 12}" text-anchor="middle">${unit}</text>` : ''}
  </g>`;
}

// Generički "Power Metrics" area-grafik na <canvas>. Vraća true ako je iscrtano.
//   cv = canvas element; samples = [{t, ...vrednosti}]; series = [{k,label,color}]; enabled = {k:bool}
function hmiChart(cv, samples, series, enabled) {
  if (!cv) return false;
  const wrap = cv.parentElement, W = wrap.clientWidth, H = wrap.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
  const en = series.filter(s => enabled[s.k]);
  if (samples.length < 2 || !en.length) return false;
  const css = getComputedStyle(document.documentElement);
  const muted = css.getPropertyValue('--muted').trim() || '#888';
  const border = css.getPropertyValue('--border').trim() || '#333';
  const padL = 42, padR = 12, padT = 12, padB = 22;
  const t0 = samples[0].t, t1 = samples[samples.length - 1].t, tSpan = Math.max(1, t1 - t0);
  let mn = 0, mx = 0;
  samples.forEach(d => en.forEach(s => { const v = d[s.k]; if (v != null && !isNaN(v)) { mn = Math.min(mn, v); mx = Math.max(mx, v); } }));
  if (mx - mn < 1) mx = mn + 1;
  const pad = (mx - mn) * 0.08; mn -= pad; mx += pad;
  const X = t => padL + (t - t0) / tSpan * (W - padL - padR);
  const Y = v => padT + (mx - v) / (mx - mn) * (H - padT - padB);
  ctx.font = '10px "IBM Plex Mono",monospace'; ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const v = mn + (mx - mn) * i / 4, y = Y(v), zero = Math.abs(v) < (mx - mn) * 0.02;
    ctx.strokeStyle = zero ? muted : border; ctx.globalAlpha = zero ? .55 : .22;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke(); ctx.globalAlpha = 1;
    ctx.fillStyle = muted; ctx.textAlign = 'right'; ctx.fillText(v.toFixed(0), padL - 6, y);
  }
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  [0, .5, 1].forEach(p => { const t = t0 + tSpan * p; ctx.fillStyle = muted;
    ctx.fillText(new Date(t).toLocaleTimeString('sr-RS', { hour: '2-digit', minute: '2-digit' }), X(t), H - padB + 5); });
  en.forEach(s => {
    const pts = samples.map(d => ({ x: X(d.t), v: d[s.k] })).filter(p => p.v != null && !isNaN(p.v));
    if (pts.length < 2) return;
    const y0 = Y(0);
    ctx.beginPath(); ctx.moveTo(pts[0].x, y0); pts.forEach(p => ctx.lineTo(p.x, Y(p.v)));
    ctx.lineTo(pts[pts.length - 1].x, y0); ctx.closePath();
    ctx.fillStyle = s.color; ctx.globalAlpha = .14; ctx.fill(); ctx.globalAlpha = 1;
    ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p.x, Y(p.v)) : ctx.moveTo(p.x, Y(p.v)));
    ctx.strokeStyle = s.color; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
  });
  return true;
}
