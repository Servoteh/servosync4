// Markdown-lite render (paritet 1.0 aiMdLite): escape HTML pa ```blok```→<pre>,
// `kod`→<code>, **bold**→<strong>. Novi red se čuva preko white-space:pre-wrap.

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function aiMdLite(raw: string): string {
  let s = escapeHtml(raw ?? '');
  s = s.replace(/```([\s\S]*?)```/g, (_m, code) => `<pre class="ai-pre">${code}</pre>`);
  s = s.replace(/`([^`]+)`/g, (_m, code) => `<code class="ai-code">${code}</code>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, (_m, b) => `<strong>${b}</strong>`);
  return s;
}
