/**
 * Shared notes — the conversation's whiteboard: facts and open items every
 * Bot here reads (as untrusted data) on every turn. Bots add and resolve
 * them through the `conversation` tool; the member edits the same list here.
 */

import { useEffect, useState } from 'react';
import type { BotSharedNoteView } from '@greenhouse/types/bots';
import { Button, IconButton, Input, Textarea, toast } from '../ui';
import { CheckCircle2, Circle, Pin, PinOff, Plus, Trash2 } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import * as botsApi from '../../lib/api/bots';
import type { BotLookup } from './transcript-rows';

export function SharedNotes({
  sessionId,
  initial,
  lookup,
}: {
  sessionId: string;
  initial: BotSharedNoteView[];
  lookup: BotLookup;
}) {
  const t = useT();
  const [notes, setNotes] = useState<BotSharedNoteView[]>(initial);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => setNotes(initial), [initial]);

  const sorted = [...notes].sort(
    (a, b) =>
      Number(a.status === 'done') - Number(b.status === 'done') ||
      Number(b.pinned) - Number(a.pinned) ||
      b.updated_at.localeCompare(a.updated_at),
  );

  const replace = (note: BotSharedNoteView) =>
    setNotes((current) => current.map((candidate) => (candidate.id === note.id ? note : candidate)));

  const add = async () => {
    if (!title.trim()) return;
    setBusy(true);
    try {
      const { note } = await botsApi.createNote(sessionId, { title: title.trim(), body: body.trim() || undefined });
      setNotes((current) => [note, ...current]);
      setTitle('');
      setBody('');
      setAdding(false);
    } catch (err) {
      toast(err instanceof Error ? err.message : t('bots.info.saveFailed'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const patch = async (note: BotSharedNoteView, change: { status?: 'open' | 'done'; pinned?: boolean }) => {
    replace({ ...note, ...change });
    try {
      const { note: saved } = await botsApi.updateNote(sessionId, note.id, change);
      replace(saved);
    } catch {
      replace(note);
      toast(t('bots.info.saveFailed'), 'error');
    }
  };

  const remove = async (note: BotSharedNoteView) => {
    setNotes((current) => current.filter((candidate) => candidate.id !== note.id));
    try {
      await botsApi.deleteNote(sessionId, note.id);
    } catch {
      setNotes((current) => [...current, note]);
      toast(t('bots.info.saveFailed'), 'error');
    }
  };

  return (
    <div className="space-y-2">
      {sorted.length === 0 && !adding && <p className="text-xs text-fg-faint">{t('bots.info.notesEmpty')}</p>}
      <ul className="space-y-1">
        {sorted.map((note) => {
          const author = note.author_bot_id ? lookup(note.author_bot_id) : undefined;
          const done = note.status === 'done';
          return (
            <li key={note.id} className="group flex items-start gap-1.5 rounded-md px-1 py-1 hover:bg-surface-muted">
              <IconButton
                size="compact"
                label={done ? t('bots.info.reopen') : t('bots.info.markDone')}
                onClick={() => void patch(note, { status: done ? 'open' : 'done' })}
              >
                {done ? <CheckCircle2 size={14} className="text-success" /> : <Circle size={14} />}
              </IconButton>
              <div className="min-w-0 flex-1 pt-1">
                <p className={`text-xs ${done ? 'text-fg-faint line-through' : 'font-medium text-fg'}`}>{note.title}</p>
                {note.body && <p className="mt-0.5 whitespace-pre-wrap text-[11px] text-fg-muted">{note.body}</p>}
                {author && (
                  <p className="mt-0.5 text-[10px] text-fg-faint">{t('bots.info.byBot', { name: author.name })}</p>
                )}
              </div>
              <div className="flex flex-shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-within:opacity-100 touch-visible">
                <IconButton
                  size="compact"
                  label={note.pinned ? t('bots.info.unpin') : t('bots.info.pin')}
                  onClick={() => void patch(note, { pinned: !note.pinned })}
                >
                  {note.pinned ? <PinOff size={13} /> : <Pin size={13} />}
                </IconButton>
                <IconButton
                  size="compact"
                  variant="destructive"
                  label={t('bots.info.deleteNote')}
                  onClick={() => void remove(note)}
                >
                  <Trash2 size={13} />
                </IconButton>
              </div>
            </li>
          );
        })}
      </ul>
      {adding ? (
        <div className="space-y-2 rounded-lg border border-edge bg-surface-sunken p-2">
          <Input
            size="sm"
            value={title}
            maxLength={80}
            autoFocus
            placeholder={t('bots.info.noteTitle')}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) void add();
            }}
          />
          <Textarea
            value={body}
            maxLength={2000}
            rows={2}
            placeholder={t('bots.info.noteBody')}
            onChange={(event) => setBody(event.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" disabled={busy || !title.trim()} onClick={() => void add()}>
              {t('bots.info.addNote')}
            </Button>
          </div>
        </div>
      ) : (
        <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
          <Plus size={13} className="mr-1" />
          {t('bots.info.addNote')}
        </Button>
      )}
    </div>
  );
}
