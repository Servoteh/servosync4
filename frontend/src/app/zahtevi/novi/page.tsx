'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { Button } from '@/components/ui-kit/button';
import { Input, FormField } from '@/components/ui-kit/form-field';
import { Textarea } from '@/components/ui-kit/textarea';
import { Select } from '@/components/ui-kit/select';
import { AttachmentInput } from '@/components/ui-kit/attachment-input';
import { AudioRecorder } from '@/components/ui-kit/audio-recorder';
import { DictateButton, RefineButton } from '@/components/voice-controls';
import { toast } from '@/lib/toast';
import {
  useCreateZahtev,
  useUploadAttachments,
  fetchSlicni,
  type SimilarRequest,
} from '@/api/zahtevi';
import { statusMeta } from '../_lib/status';
import {
  zahtevFormSchema,
  kindOptions,
  priorityOptions,
  moduleOptions,
  type ZahtevFormValues,
} from '../_lib/form';

const SLICNI_DEBOUNCE_MS = 400;

/**
 * Nova forma zahteva (MODULE_SPEC §8) — obrazac „Forma kao stranica sa sekcijama"
 * (DESIGN_SYSTEM §4). Primarni MOBILNI scenario (kamera + diktat), zato responsive
 * do 360px. Diktat u polje (DictateButton, audio se NE čuva) + glasovna poruka kao
 * prilog (AudioRecorder → upload). Prilozi/audio se otpremaju POSLE create-a (BE
 * traži postojeći requestId za /attachments). Zod poruke srpski; Ctrl+S = podnesi.
 */
export default function NoviZahtevPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();

  const [values, setValues] = useState<ZahtevFormValues>({
    title: '',
    description: '',
    kind: '',
    module: '',
    priorityUser: '',
    expectedBehavior: '',
    currentBehavior: '',
  });
  const [errors, setErrors] = useState<Partial<Record<keyof ZahtevFormValues, string>>>({});
  const [files, setFiles] = useState<File[]>([]);
  const [audio, setAudio] = useState<Blob | null>(null);
  const [rejectMsg, setRejectMsg] = useState<string | null>(null);
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const [slicni, setSlicni] = useState<SimilarRequest[]>([]);

  const create = useCreateZahtev();
  const upload = useUploadAttachments();
  const busy = create.isPending || upload.isPending;

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  // Očekivano/trenutno ponašanje se prikazuje kad je tip BUG ili prazan (§8).
  const showBehaviorFields = values.kind === 'BUG' || values.kind === '';

  function set<K extends keyof ZahtevFormValues>(key: K, v: ZahtevFormValues[K]) {
    setValues((prev) => ({ ...prev, [key]: v }));
    if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }));
  }

  // Živa provera sličnih (§13.13) — debounce na naslov, BEZ AI.
  const debRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const term = values.title.trim();
    if (debRef.current) clearTimeout(debRef.current);
    if (term.length < 3) {
      setSlicni([]);
      return;
    }
    debRef.current = setTimeout(() => {
      fetchSlicni(term)
        .then((res) => setSlicni(res.data))
        .catch(() => setSlicni([]));
    }, SLICNI_DEBOUNCE_MS);
    return () => {
      if (debRef.current) clearTimeout(debRef.current);
    };
  }, [values.title]);

  function validate(): boolean {
    const parsed = zahtevFormSchema.safeParse(values);
    if (parsed.success) {
      setErrors({});
      return true;
    }
    const next: Partial<Record<keyof ZahtevFormValues, string>> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0] as keyof ZahtevFormValues;
      if (!next[key]) next[key] = issue.message;
    }
    setErrors(next);
    return false;
  }

  /** Zajednički tok create → (audio kao File) → upload priloga → detalj. */
  const save = useCallback(
    async (submit: boolean) => {
      setSubmitErr(null);
      if (!validate()) return;
      try {
        const res = await create.mutateAsync({
          title: values.title.trim(),
          description: values.description.trim(),
          kind: values.kind || undefined,
          module: values.module || undefined,
          priorityUser: values.priorityUser || undefined,
          expectedBehavior:
            showBehaviorFields && values.expectedBehavior?.trim()
              ? values.expectedBehavior.trim()
              : undefined,
          currentBehavior:
            showBehaviorFields && values.currentBehavior?.trim()
              ? values.currentBehavior.trim()
              : undefined,
          submit,
        });
        const id = res.data.id;

        // Prilozi + glasovna poruka se otpremaju POSLE create-a (BE traži requestId).
        const toUpload = [...files];
        if (audio) {
          toUpload.push(new File([audio], `glasovna-poruka.webm`, { type: audio.type || 'audio/webm' }));
        }
        if (toUpload.length) {
          try {
            await upload.mutateAsync({ id, files: toUpload });
          } catch (e) {
            // Ne obaramo tok, ali razlog MORA biti vidljiv (incident 22.07: nemi
            // toast je sakrio zašto glasovna poruka nije otpremljena).
            console.error('[zahtevi] upload priloga pao:', e);
            toast(
              `Zahtev je sačuvan, ali prilozi nisu otpremljeni: ${(e as Error).message}`,
            );
          }
        }
        toast(submit ? 'Zahtev je podnet.' : 'Nacrt je sačuvan.');
        router.push(`/zahtevi/detalj?id=${id}`);
      } catch (e) {
        setSubmitErr((e as Error).message);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [values, files, audio, showBehaviorFields, create, upload, router],
  );

  // Ctrl+S = Podnesi; Esc = nazad (bez potvrde — forma je nova, gubitak je očekivan uz upit toasta).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (!busy) void save(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        router.push('/zahtevi');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, save, router]);

  if (isLoading || !user) {
    return (
      <main className="grid flex-1 place-items-center text-sm text-ink-secondary">
        Učitavanje…
      </main>
    );
  }

  return (
    <AppShell>
      <PageHeader
        title="Novi zahtev"
        actions={
          <Button variant="ghost" onClick={() => router.push('/zahtevi')}>
            <ArrowLeft className="h-4 w-4" aria-hidden />
            Nazad
          </Button>
        }
      />

      <div className="flex-1 overflow-auto p-4 sm:p-6">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save(true);
          }}
          className="mx-auto max-w-2xl space-y-5"
        >
          {submitErr && (
            <p className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
              {submitErr}
            </p>
          )}

          {/* Naslov + živa provera sličnih */}
          <FormField label="Naslov" required error={errors.title}>
            <Input
              value={values.title}
              onChange={(e) => set('title', e.target.value)}
              placeholder="Kratko: šta ne radi ili šta treba dodati"
              autoFocus
              maxLength={200}
            />
          </FormField>

          {slicni.length > 0 && (
            <div className="rounded-panel border border-status-warn/40 bg-status-warn-bg px-4 py-3">
              <p className="text-sm font-medium text-ink">Ovo možda već postoji</p>
              <ul className="mt-2 space-y-1.5">
                {slicni.map((s) => (
                  <li key={s.id}>
                    <a
                      href={`/zahtevi/detalj?id=${s.id}`}
                      onClick={(e) => {
                        e.preventDefault();
                        router.push(`/zahtevi/detalj?id=${s.id}`);
                      }}
                      className="inline-flex items-center gap-1.5 text-sm text-accent hover:underline"
                    >
                      <span className="tnums font-semibold">{s.reqNo}</span>
                      <span className="text-ink">{s.title}</span>
                      <span className="text-2xs text-ink-secondary">
                        · {statusMeta(s.status).label}
                      </span>
                      <ExternalLink className="h-3 w-3 text-ink-secondary" aria-hidden />
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Opis + diktat + doterivanje */}
          <FormField label="Opis" required error={errors.description} hint="Diktirajte 🎤 ili doterajte tekst ✨ (dostupno pre podnošenja).">
            <div className="relative">
              <Textarea
                value={values.description}
                onChange={(e) => set('description', e.target.value)}
                rows={5}
                placeholder="Detaljno opišite problem ili ideju…"
              />
              <div className="absolute right-2 top-2 flex gap-1">
                <DictateButton
                  onText={(t) =>
                    set('description', values.description ? `${values.description} ${t}` : t)
                  }
                />
                <RefineButton
                  getText={() => values.description}
                  onText={(t) => set('description', t)}
                />
              </div>
            </div>
          </FormField>

          {/* Tip / modul / prioritet */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <FormField label="Tip" hint="AI će predložiti ako izostavite.">
              <Select
                placeholder="— AI predlaže —"
                value={values.kind ?? ''}
                onChange={(e) => set('kind', e.target.value)}
                options={kindOptions}
              />
            </FormField>
            <FormField label="Modul">
              <Select
                placeholder="—"
                value={values.module ?? ''}
                onChange={(e) => set('module', e.target.value)}
                options={moduleOptions()}
              />
            </FormField>
            <FormField label="Prioritet (vaše mišljenje)">
              <Select
                placeholder="—"
                value={values.priorityUser ?? ''}
                onChange={(e) => set('priorityUser', e.target.value)}
                options={priorityOptions}
              />
            </FormField>
          </div>

          {/* Očekivano / trenutno ponašanje (BUG ili prazno) */}
          {showBehaviorFields && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <FormField label="Očekivano ponašanje" hint="Šta bi trebalo da se desi.">
                <Textarea
                  value={values.expectedBehavior ?? ''}
                  onChange={(e) => set('expectedBehavior', e.target.value)}
                  rows={3}
                  placeholder="Očekujem da…"
                />
              </FormField>
              <FormField label="Trenutno ponašanje" hint="Šta se sada dešava.">
                <Textarea
                  value={values.currentBehavior ?? ''}
                  onChange={(e) => set('currentBehavior', e.target.value)}
                  rows={3}
                  placeholder="Umesto toga…"
                />
              </FormField>
            </div>
          )}

          {/* Prilozi */}
          <FormField label="Prilozi (slike, PDF)" hint="Slikajte ekran ili priložite fajl. Do 10 priloga.">
            <AttachmentInput
              value={files}
              onChange={setFiles}
              onReject={(m) => {
                setRejectMsg(m);
                toast(m);
              }}
              max={10}
            />
            {rejectMsg && <p className="mt-1 text-xs text-status-danger">{rejectMsg}</p>}
          </FormField>

          {/* Glasovna poruka */}
          <FormField label="Glasovna poruka" hint="Snimak se čuva uz zahtev i biće transkribovan (best-effort).">
            <AudioRecorder value={audio} onChange={setAudio} />
          </FormField>

          {/* Akcije */}
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <Button type="submit" loading={busy}>
              Podnesi
            </Button>
            <Button type="button" variant="secondary" onClick={() => void save(false)} disabled={busy}>
              Sačuvaj nacrt
            </Button>
            <span className="ml-auto text-2xs text-ink-secondary">Ctrl+S podnosi · Esc nazad</span>
          </div>
        </form>
      </div>
    </AppShell>
  );
}
