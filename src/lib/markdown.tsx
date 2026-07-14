// Minimalni, bezbedan markdown → HTML (paritet 1.0 `markdownToHtml` obima:
// naslovi, **bold**, *italic*, liste, linkovi, prelomi). HTML se PRVO escape-uje,
// pa se primenjuju transformacije nad escaped tekstom → nema XSS-a iz sadržaja.
// Namena: opisi pozicija / vrednosti firme / telo saveta / očekivanja (md kolone).

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Inline: **bold**, *italic*, `code`, [tekst](http…) — nad VEĆ escaped stringom. */
function inline(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code class="rounded bg-surface-2 px-1 text-sm">$1</code>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$1" target="_blank" rel="noopener noreferrer" class="text-accent underline">$1</a>');
}

/** Blokovski markdown → HTML string (sanitizovan). */
export function markdownToHtml(src: string | null | undefined): string {
  if (!src) return '';
  const lines = escapeHtml(String(src)).split(/\r?\n/);
  const out: string[] = [];
  let listType: 'ul' | 'ol' | null = null;
  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (h) {
      closeList();
      const level = h[1].length + 2; // # → h3
      out.push(`<h${level} class="mt-3 mb-1 font-semibold text-ink">${inline(h[2])}</h${level}>`);
    } else if (ul) {
      if (listType !== 'ul') {
        closeList();
        out.push('<ul class="ml-5 list-disc space-y-0.5">');
        listType = 'ul';
      }
      out.push(`<li>${inline(ul[1])}</li>`);
    } else if (ol) {
      if (listType !== 'ol') {
        closeList();
        out.push('<ol class="ml-5 list-decimal space-y-0.5">');
        listType = 'ol';
      }
      out.push(`<li>${inline(ol[1])}</li>`);
    } else if (line.trim() === '') {
      closeList();
    } else {
      closeList();
      out.push(`<p class="my-1">${inline(line)}</p>`);
    }
  }
  closeList();
  return out.join('\n');
}

/** React komponenta: render markdown-a (bez dodatnih zavisnosti). */
export function Markdown({ source, className }: { source: string | null | undefined; className?: string }) {
  const html = markdownToHtml(source);
  if (!html) return null;
  return <div className={className ?? 'text-sm leading-relaxed text-ink'} dangerouslySetInnerHTML={{ __html: html }} />;
}
