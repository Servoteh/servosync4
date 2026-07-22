import { Sparkles } from 'lucide-react';

/**
 * Minimalni AI teaser — prikazuje se SAMO kad detalj već ima redove analize
 * (MODULE_SPEC §8: „ako postoje analize u odgovoru, prikaži minimalni placeholder").
 * Pun AI tab (trijaža/detaljna/duplikati/Claude paket) stiže u F3. Ovde bez sadržaja
 * analize — samo najava, da F2 ne prejudicira F3 UI.
 */
export function AiTeaser({ count }: { count: number }) {
  return (
    <div className="flex items-start gap-3 rounded-panel border border-status-info/30 bg-status-info-bg px-4 py-3">
      <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-status-info" aria-hidden />
      <div>
        <p className="text-sm font-medium text-ink">AI analiza stiže (F3)</p>
        <p className="text-2xs text-ink-secondary">
          Zabeleženo {count} AI {count === 1 ? 'prolaz' : 'prolaza'}. Prikaz trijaže,
          detaljne analize i Claude paketa uključuje se u sledećoj fazi.
        </p>
      </div>
    </div>
  );
}
