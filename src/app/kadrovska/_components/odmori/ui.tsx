'use client';

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { cn } from '@/lib/cn';

// Lagani toast + promise-confirm za GO modul (paritet 1.0 showToast/askConfirm).
// Nema globalne toast infrastrukture u 3.0 → lokalni provider oko OdmoriTab-a.

interface ConfirmOpts {
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

interface UiCtx {
  showToast: (msg: string) => void;
  confirm: (opts: ConfirmOpts) => Promise<boolean>;
}

const Ctx = createContext<UiCtx | null>(null);

interface ToastItem { id: number; msg: string }

export function OdmoriUiProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const showToast = useCallback((msg: string) => {
    const id = ++seq.current;
    setToasts((t) => [...t, { id, msg }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);

  const [confirmState, setConfirmState] = useState<
    (ConfirmOpts & { resolve: (v: boolean) => void }) | null
  >(null);

  const confirm = useCallback((opts: ConfirmOpts) => {
    return new Promise<boolean>((resolve) => setConfirmState({ ...opts, resolve }));
  }, []);

  const closeConfirm = (v: boolean) => {
    setConfirmState((s) => {
      s?.resolve(v);
      return null;
    });
  };

  const value = useMemo<UiCtx>(() => ({ showToast, confirm }), [showToast, confirm]);

  return (
    <Ctx.Provider value={value}>
      {children}
      {/* Toast stack */}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="pointer-events-auto max-w-sm rounded-panel border border-line bg-surface px-4 py-2.5 text-sm text-ink shadow-lg"
          >
            {t.msg}
          </div>
        ))}
      </div>
      {/* Confirm dialog */}
      {confirmState && (
        <Dialog
          open
          onClose={() => closeConfirm(false)}
          title={confirmState.title}
          footer={
            <>
              <Button variant="secondary" onClick={() => closeConfirm(false)}>
                {confirmState.cancelLabel || 'Otkaži'}
              </Button>
              <Button
                variant={confirmState.danger ? 'danger' : 'primary'}
                onClick={() => closeConfirm(true)}
              >
                {confirmState.confirmLabel || 'Potvrdi'}
              </Button>
            </>
          }
        >
          <div className={cn('whitespace-pre-line text-sm text-ink-secondary')}>{confirmState.body}</div>
        </Dialog>
      )}
    </Ctx.Provider>
  );
}

export function useOdmoriUi(): UiCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useOdmoriUi must be used within OdmoriUiProvider');
  return ctx;
}
