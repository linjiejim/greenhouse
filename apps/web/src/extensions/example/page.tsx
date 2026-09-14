/** `#/example` — the example extension's page: list, add and delete personal notes. */
import React, { useCallback, useEffect, useState } from 'react';
import { Button, Input, Spinner, toast } from '../../components/ui';
import { StickyNote, Trash2 } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { authFetch } from '../../lib/auth';
import type { ExtensionPageProps } from '../define';

interface Note {
  id: number;
  body: string;
  created_at: string;
}

export function ExampleNotesPage(_props: ExtensionPageProps) {
  const t = useT();
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await authFetch('/api/ext/example/notes');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setNotes(((await res.json()) as { notes: Note[] }).notes);
    } catch {
      setNotes([]);
      toast(t('ext.example.loadFailed'), 'error');
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async () => {
    const body = draft.trim();
    if (!body) return;
    setSaving(true);
    try {
      const res = await authFetch('/api/ext/example/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setDraft('');
      await load();
    } catch {
      toast(t('ext.example.saveFailed'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: number) => {
    await authFetch(`/api/ext/example/notes/${id}`, { method: 'DELETE' });
    await load();
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-6 py-8" data-testid="example-notes-page">
        <div className="mb-6 flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-primary-subtle text-primary-fg-strong">
            <StickyNote size={20} />
          </span>
          <div>
            <h1 className="text-xl font-semibold text-fg">{t('ext.example.title')}</h1>
            <p className="text-sm text-fg-muted">{t('ext.example.intro')}</p>
          </div>
        </div>

        <form
          className="mb-6 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t('ext.example.placeholder')}
            maxLength={500}
            data-testid="example-note-input"
          />
          <Button type="submit" disabled={saving || !draft.trim()} data-testid="example-note-submit">
            {t('ext.example.add')}
          </Button>
        </form>

        {notes === null ? (
          <div className="flex justify-center py-10">
            <Spinner className="h-5 w-5 text-fg-faint" />
          </div>
        ) : notes.length === 0 ? (
          <p className="rounded-xl border border-dashed border-edge px-4 py-8 text-center text-sm text-fg-faint">
            {t('ext.example.empty')}
          </p>
        ) : (
          <ul className="space-y-2" data-testid="example-note-list">
            {notes.map((note) => (
              <li
                key={note.id}
                className="flex items-start gap-3 rounded-xl border border-edge bg-surface-raised px-4 py-3"
              >
                <p className="min-w-0 flex-1 whitespace-pre-wrap text-sm text-fg">{note.body}</p>
                <button
                  type="button"
                  onClick={() => void remove(note.id)}
                  className="rounded-md p-1 text-fg-faint transition-colors hover:bg-surface-muted hover:text-fg"
                  aria-label={t('ext.example.delete')}
                  title={t('ext.example.delete')}
                >
                  <Trash2 size={15} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Settings → Example notes: a module contributed by the extension. */
export function ExampleSettingsModule() {
  const t = useT();
  return (
    <div className="max-w-2xl space-y-3 p-6">
      <h2 className="text-lg font-semibold text-fg">{t('ext.example.settings.title')}</h2>
      <p className="text-sm text-fg-muted">{t('ext.example.settings.body')}</p>
    </div>
  );
}

/** Peek body for `ext:example:note` — what a `#/example/notes/42` link opens inline. */
export function ExampleNotePeek({ id }: { id: string }) {
  const t = useT();
  const [note, setNote] = useState<Note | null | undefined>(undefined);

  useEffect(() => {
    authFetch(`/api/ext/example/notes/${id}`)
      .then((res) => (res.ok ? (res.json() as Promise<{ note: Note }>) : null))
      .then((data) => setNote(data?.note ?? null))
      .catch(() => setNote(null));
  }, [id]);

  if (note === undefined) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="h-5 w-5 text-fg-faint" />
      </div>
    );
  }
  if (note === null) {
    return <p className="p-6 text-sm text-fg-faint">{t('ext.example.loadFailed')}</p>;
  }
  return (
    <div className="p-6" data-testid="example-note-peek">
      <p className="whitespace-pre-wrap text-sm text-fg">{note.body}</p>
    </div>
  );
}

/** A section every knowledge document gets while this extension is active. */
export function ExampleDocPanel(_props: { docId: number }) {
  const t = useT();
  return (
    <section className="mt-6 rounded-xl border border-dashed border-edge px-4 py-3">
      <p className="text-xs text-fg-muted">{t('ext.example.docPanel')}</p>
    </section>
  );
}
