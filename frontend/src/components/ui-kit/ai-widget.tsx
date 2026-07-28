'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import dynamic from 'next/dynamic';
import { Bot } from 'lucide-react';
import { cn } from '@/lib/cn';

// Plutajući AI asistent (zahtev 003/26, Zoran): okruglo dugme dole desno → kompaktni
// chat panel koji NE tera korisnika da napusti trenutnu formu. Non-modal (bez scrim-a
// koji blokira stranu), minimizacija (X/Esc) vraća na dugme.
//
// Stanje (otvorenost + aktivna nit + projekat) živi u MODUL-scope store-u, NE u
// komponenti: AppShell se montira per-page, pa bi lokalno stanje nestalo na svakoj
// navigaciji. Modul se ne uvozi ponovo pri klijentskoj navigaciji → store preživi
// remount i panel ostaje otvoren na istoj niti dok je aplikacija otvorena. BEZ
// localStorage (Zoran: nema pamćenja sesija) — zatvaranje taba resetuje sve. Poruke
// istorije čuva TanStack Query keš (app-nivo, van AppShell-a), pa se nit vraća netaknuta.
interface WidgetState {
  open: boolean;
  conversationId: string | null;
  projectRef: string | null;
}
let state: WidgetState = { open: false, conversationId: null, projectRef: null };
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
function getSnapshot(): WidgetState {
  return state;
}
function setOpen(v: boolean) {
  if (state.open === v) return;
  state = { ...state, open: v };
  emit();
}
// Stabilna referenca (module-scope) — bezbedno kao dep AiChat efekta i, ključno, RADI
// I POSLE UNMOUNT-a (AiChat je zove direktno iz send() da nit preživi navigaciju u letu).
function setConversation(id: string | null, projectRef: string | null) {
  if (state.conversationId === id && state.projectRef === projectRef) return;
  state = { ...state, conversationId: id, projectRef };
  emit();
}

/** Getter aktivne niti — /ai pun prikaz ga čita da nastavi istu nit (static-export bezbedno). */
export function getWidgetConversationId(): string | null {
  return state.conversationId;
}

// Lenja montaža (chunk se skida tek pri prvom otvaranju) + ssr:false (static export ne
// prerenderuje težak chat u panel). Kratak spinner dok se učitava.
const AiChat = dynamic(() => import('@/components/ai-chat').then((m) => m.AiChat), {
  ssr: false,
  loading: () => (
    <div className="grid h-full place-items-center text-sm text-ink-secondary">Učitavanje…</div>
  ),
});

/**
 * Plutajuće AI dugme + panel. Mount-uje ga AppShell SAMO korisnicima sa AI permisijom
 * i van /ai strane (tamo je redundantno). z-40: iznad sadržaja i sticky traka, ISPOD
 * modala/dijaloga i mobilnog nav scrima (z-45+) — asistent nikad ne prekriva njih.
 * Podiže se iznad „nova verzija" trake preko `--update-banner-h`.
 */
export function AiWidget({ screenContext }: { screenContext?: string }) {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const { open, conversationId, projectRef } = snap;

  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Guard: init na tekuće `open` da (re)mount posle navigacije NE otme fokus — efekat
  // deluje samo na stvarnu tranziciju otvoreno↔zatvoreno.
  const prevOpen = useRef(open);

  // Lenja montaža: AiChat se montira tek pri prvom otvaranju, pa ostaje montiran
  // (sakriven CSS-om) da minimizacija sačuva ceo razgovor. Ako je panel već otvoren pri
  // (re)mount-u posle navigacije — odmah.
  const [everOpened, setEverOpened] = useState(open);
  useEffect(() => {
    if (open) setEverOpened(true);
  }, [open]);

  // Fokus menadžment: open → fokus u panel (input, ili panel kao fallback dok se lazy
  // chunk ne učita); close → fokus nazad na dugme. Samo na stvarnoj tranziciji.
  useEffect(() => {
    if (prevOpen.current === open) return;
    prevOpen.current = open;
    if (open) {
      const input = panelRef.current?.querySelector<HTMLTextAreaElement>('textarea');
      (input ?? panelRef.current)?.focus();
    } else {
      btnRef.current?.focus();
    }
  }, [open]);

  return (
    <>
      {/* Plutajuće dugme (dole desno) — sakriveno dok je panel otvoren. Podiže se iznad
          „nova verzija" trake.
          Zahtev 025/26: `bottom` je 5rem (80px), ne 1rem — na 1rem je krug (h-14 = 56px,
          zona 16–72px od dna) padao tačno preko `Pager` strelice „sledeća strana", koja
          na dnu `p-6` skrol-kontejnera zauzima ~24–54px od dna, pa je bio neklikabilan
          (dugme je fixed z-40, pager je običan sadržaj). 80px diže krug u zonu 80–136px
          → čist razmak iznad pagera na SVIM listama (radni nalozi, primopredaje, …).
          Panel dole zadržava svoj 1rem anker: dugme je sakriveno dok je panel otvoren,
          panel ionako prekriva pager, a njegov `max-h` računa 1rem. */}
      {!open && (
        <button
          ref={btnRef}
          type="button"
          onClick={() => setOpen(true)}
          title="AI asistent"
          aria-label="Otvori AI asistenta"
          className={cn(
            'fixed bottom-[calc(5rem+var(--update-banner-h,0px))] right-4 z-40 grid h-14 w-14 place-items-center rounded-full',
            'bg-accent text-accent-fg shadow-lg transition-colors hover:bg-accent-hover',
            'focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]',
          )}
        >
          <Bot className="h-6 w-6" aria-hidden />
        </button>
      )}

      {/* Panel — montiran čim je jednom otvoren; sakriven CSS-om kad je minimizovan
          (razgovor ostaje živ). Desktop: kartica dole desno; < lg: donji sheet. Esc na
          panelu minimizuje (samo kad je fokus u widgetu — ne otima Esc stranici; DS §8). */}
      {(everOpened || open) && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="AI asistent"
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
            }
          }}
          className={cn(
            'fixed z-40 flex-col overflow-hidden border border-line bg-surface shadow-2xl outline-none',
            'bottom-[calc(1rem+var(--update-banner-h,0px))] right-4 h-[65vh] max-h-[calc(100vh-2rem)] w-96 max-w-[calc(100vw-2rem)] rounded-panel',
            'max-lg:bottom-[var(--update-banner-h,0px)] max-lg:left-0 max-lg:right-0 max-lg:h-[85vh] max-lg:w-auto max-lg:max-w-none max-lg:rounded-b-none',
            open ? 'flex' : 'hidden',
          )}
        >
          <AiChat
            variant="widget"
            screenContext={screenContext}
            onMinimize={() => setOpen(false)}
            initialConversationId={conversationId}
            initialProjectRef={projectRef}
            onConversationChange={setConversation}
          />
        </div>
      )}
    </>
  );
}
