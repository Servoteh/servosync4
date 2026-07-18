'use client';

// Lagani imperativni toast (paritet 1.0 `showToast`) — bez provider-a: jedan fiksni
// kontejner se leno montira na <body>, poruke se dodaju kao pilule i same nestaju.
// Namena: povratna informacija posle mutacija (podeljeno/potvrđeno/obrisano/pozivnice).

let container: HTMLDivElement | null = null;

function ensureContainer(): HTMLDivElement | null {
  if (typeof document === 'undefined') return null;
  if (container && document.body.contains(container)) return container;
  const el = document.createElement('div');
  el.setAttribute('data-toast-root', '');
  el.style.cssText =
    'position:fixed;z-index:9999;bottom:16px;left:50%;transform:translateX(-50%);display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none;';
  document.body.appendChild(el);
  container = el;
  return el;
}

/** Prikaži kratku poruku (nestaje za ~3.2s). */
export function toast(message: string): void {
  const root = ensureContainer();
  if (!root) return;
  const pill = document.createElement('div');
  pill.textContent = message;
  pill.style.cssText =
    'pointer-events:auto;max-width:min(92vw,520px);padding:9px 16px;border-radius:9999px;' +
    'background:rgba(23,23,23,.94);color:#fff;font-size:13px;font-weight:500;box-shadow:0 6px 24px rgba(0,0,0,.28);' +
    'opacity:0;transition:opacity .18s ease, transform .18s ease;transform:translateY(6px);white-space:pre-line;text-align:center;';
  root.appendChild(pill);
  requestAnimationFrame(() => {
    pill.style.opacity = '1';
    pill.style.transform = 'translateY(0)';
  });
  window.setTimeout(() => {
    pill.style.opacity = '0';
    pill.style.transform = 'translateY(6px)';
    window.setTimeout(() => pill.remove(), 220);
  }, 3200);
}
