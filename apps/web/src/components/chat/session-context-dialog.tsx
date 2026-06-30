/**
 * SessionContextDialog — editor for the structured session context
 * (role, locale, timezone, attributes, note) injected into the system prompt.
 *
 * Only offered for the public profile: it simulates what an external app
 * caller would send via /api/v1 `context`. All fields are optional —
 * an empty field simply means that piece of context is absent.
 * English-only by design (internal testing tool, like the dashboard CRUD modules).
 */

import React, { useState, useEffect } from 'react';
import { Dialog, Button, Input, Textarea, toast } from '../ui';
import * as api from '../../lib/api';
import type { SessionContextData } from '../../lib/api';

interface SessionContextDialogProps {
  open: boolean;
  onClose: () => void;
  /** null = draft mode (no session yet): edits are kept client-side and applied at session creation. */
  sessionId: string | null;
  /** Initial values for draft mode (ignored when sessionId is set — server is the source). */
  draft?: SessionContextData | null;
  /** Called after save/clear so the parent can refresh the trigger chip / draft state. */
  onChanged?: (ctx: SessionContextData | null) => void;
}

type Draft = {
  role: string;
  locale: string;
  timezone: string;
  attributes: string; // free-form "key=value" lines
  notes: string;
};

const EMPTY_DRAFT: Draft = {
  role: '',
  locale: '',
  timezone: '',
  attributes: '',
  notes: '',
};

/** Render an attributes map as "key=value" lines for the textarea. */
function attributesToText(attrs: Record<string, string> | undefined): string {
  if (!attrs) return '';
  return Object.entries(attrs)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

/** Parse "key=value" lines back into an attributes map (blank/invalid lines skipped). */
function textToAttributes(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key && value) out[key] = value;
  }
  return out;
}

function toDraft(ctx: SessionContextData | null): Draft {
  if (!ctx) return EMPTY_DRAFT;
  return {
    role: ctx.role ?? '',
    locale: ctx.locale ?? '',
    timezone: ctx.timezone ?? '',
    attributes: attributesToText(ctx.attributes),
    notes: ctx.notes ?? '',
  };
}

function toContext(d: Draft): SessionContextData {
  const ctx: SessionContextData = {};
  const set = (key: 'role' | 'locale' | 'timezone' | 'notes', v: string) => {
    const trimmed = v.trim();
    if (trimmed) ctx[key] = trimmed;
  };
  set('role', d.role);
  set('locale', d.locale);
  set('timezone', d.timezone);
  set('notes', d.notes);
  const attrs = textToAttributes(d.attributes);
  if (Object.keys(attrs).length > 0) ctx.attributes = attrs;
  return ctx;
}

export function SessionContextDialog({
  open,
  onClose,
  sessionId,
  draft: draftCtx,
  onChanged,
}: SessionContextDialogProps) {
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [meta, setMeta] = useState<SessionContextData['_meta']>();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (!sessionId) {
      // Draft mode — no server round-trip
      setDraft(toDraft(draftCtx ?? null));
      setMeta(undefined);
      return;
    }
    setLoading(true);
    api
      .getSessionContext(sessionId)
      .then((ctx) => {
        setDraft(toDraft(ctx));
        setMeta(ctx?._meta);
      })
      .catch(() => toast('Failed to load session context', 'error'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sessionId]);

  const update =
    (key: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setDraft((d) => ({ ...d, [key]: e.target.value }));

  const handleSave = async () => {
    const ctx = toContext(draft);
    if (!sessionId) {
      // Draft mode: hand the context to the parent; it is sent with session creation.
      const next = Object.keys(ctx).length === 0 ? null : ctx;
      onChanged?.(next);
      toast(next ? 'Context staged — applied when the conversation starts' : 'Context draft cleared', 'success');
      onClose();
      return;
    }
    setSaving(true);
    try {
      if (Object.keys(ctx).length === 0) {
        const cleared = await api.putSessionContext(sessionId, null);
        onChanged?.(cleared);
        toast('Session context cleared', 'success');
      } else {
        const saved = await api.putSessionContext(sessionId, ctx);
        onChanged?.(saved);
        toast('Session context saved — applies from the next message', 'success');
      }
      onClose();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    if (!sessionId) {
      setDraft(EMPTY_DRAFT);
      onChanged?.(null);
      toast('Context draft cleared', 'success');
      onClose();
      return;
    }
    setSaving(true);
    try {
      await api.putSessionContext(sessionId, null);
      setDraft(EMPTY_DRAFT);
      setMeta(undefined);
      onChanged?.(null);
      toast('Session context cleared', 'success');
      onClose();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Clear failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  const field = (label: string, input: React.ReactNode) => (
    <label className="flex flex-col gap-1 text-xs text-fg-muted">
      <span>{label}</span>
      {input}
    </label>
  );

  return (
    <Dialog open={open} onClose={onClose} title="Session Context" size="sm">
      <div className="space-y-4">
        <p className="text-xs text-fg-faint">
          Simulates the context an external app sends when calling the public API — injected into the system prompt. All
          fields are optional; an empty field means no such context. Applies from the next message.
          {meta && (
            <span className="block mt-1">
              Last set by <b>{meta.source}</b> at {new Date(meta.updated_at).toLocaleString()}
            </span>
          )}
        </p>

        {loading ? (
          <div className="py-8 text-center text-sm text-fg-faint">Loading…</div>
        ) : (
          <>
            <div className="flex flex-col gap-3">
              {field('Role', <Input value={draft.role} onChange={update('role')} placeholder="support agent" />)}
              {field('Locale', <Input value={draft.locale} onChange={update('locale')} placeholder="en-US" />)}
              {field('Timezone', <Input value={draft.timezone} onChange={update('timezone')} placeholder="UTC" />)}
              {field(
                'Attributes (one key=value per line)',
                <Textarea value={draft.attributes} onChange={update('attributes')} rows={3} placeholder="plan=pro" />,
              )}
              {field(
                'Note (free-form, treated as untrusted caller data)',
                <Textarea value={draft.notes} onChange={update('notes')} rows={2} />,
              )}
            </div>

            <div className="flex justify-between pt-2">
              <Button variant="ghost" onClick={handleClear} disabled={saving}>
                Clear
              </Button>
              <div className="flex gap-2">
                <Button variant="secondary" onClick={onClose} disabled={saving}>
                  Cancel
                </Button>
                <Button onClick={handleSave} disabled={saving || loading}>
                  {saving ? 'Saving…' : 'Save'}
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
