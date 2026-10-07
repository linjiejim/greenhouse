/**
 * Behaviour behind the card sheets (app/bots/login.tsx, app/bots/request.tsx),
 * kept out of the views so an Android view can reuse it later (spec §2.9):
 *
 * - `useRequestLookup(id, c)` — the card a sheet was opened for, by id: this
 *   device's decision, else the pending list, else the conversation's own
 *   recent cards (a settled one, or one the pending list has not caught up with).
 * - `useLoginForm` — the secure sign-in (spec §2.5.5, D11). The values go once,
 *   straight to `POST /api/bots/requests/:id`; the server fills them into the
 *   page on the computer and keeps them out of the transcript and away from the
 *   model. Here they live only in the native fields: the hook keeps whether a
 *   field is filled, never what is in it; the password and code are cleared
 *   before the request is awaited (nothing secret outlives it; on a refusal the
 *   member retypes on purpose); no store, handoff, cache or log ever sees them.
 * - `useLoginRefusals` — the one result a sheet hands back to the card under
 *   it (results travel through zustand, never callbacks — apps/mobile/AGENTS.md):
 *   a sign-in refused because the page moved on, so the card can offer a fresh
 *   ask. Only the code, never a value.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import { getConversation } from '../../api/bots';
import type { BotLoginPayload, BotRequestView } from '../../shared/bots';
import { notifySuccess } from '../../ui/haptics';
import type { DecideOutcome } from '../contract';
import { mergeRequests } from '../requests';
import { useBots } from '../store';
import { loginValues } from '../vendor/web-helpers';
import { LOGIN_PAGE_MOVED, hostOf } from './decision';

// ─── Finding the card a sheet was opened for ─────────────

export type RequestLookup =
  | { state: 'loading'; request: null }
  | { state: 'ready'; request: BotRequestView }
  /** Not this member's card any more, or never was (settled long ago, a stale link). */
  | { state: 'missing'; request: null }
  /** No answer from the server: `retry`. */
  | { state: 'error'; request: null };

/**
 * The latest copy of request `id` (in conversation `c`), merged forward only
 * (`mergeRequests`): a decision this device made wins over the lists. Reads the
 * pending list on open; when the card is not there, the conversation's own
 * recent cards (`GET /api/bots/conversations/:c` carries them).
 */
export function useRequestLookup(id: string | undefined, c: string | undefined): RequestLookup & { retry: () => void } {
  const override = useBots((s) => (id ? s.requestOverrides[id] : undefined));
  const listed = useBots((s) => (id ? s.pendingRequests.find((request) => request.id === id) : undefined));
  const loadPending = useBots((s) => s.loadPending);
  const [fetched, setFetched] = useState<BotRequestView | null>(null);
  const [outcome, setOutcome] = useState<'pending' | 'done' | 'failed'>('pending');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!id) return undefined;
    let live = true;
    setOutcome('pending');
    void (async () => {
      await loadPending();
      if (!live) return;
      if (useBots.getState().pendingRequests.some((request) => request.id === id) || !c) {
        setOutcome('done');
        return;
      }
      const page = await getConversation(c, { limit: 1 });
      if (!live) return;
      if (page.ok) setFetched(page.value.conversation.requests.find((request) => request.id === id) ?? null);
      setOutcome(page.ok || page.status === 404 || page.status === 403 ? 'done' : 'failed');
    })();
    return () => {
      live = false;
    };
  }, [id, c, loadPending, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return useMemo(() => {
    const merged = id
      ? mergeRequests({
          rest: [...(fetched ? [fetched] : []), ...(listed ? [listed] : [])],
          live: [],
          overrides: override ? { [id]: override } : {},
        }).get(id)
      : undefined;
    if (merged) return { state: 'ready', request: merged, retry };
    if (!id || outcome === 'done') return { state: 'missing', request: null, retry };
    return { state: outcome === 'failed' ? 'error' : 'loading', request: null, retry };
  }, [id, fetched, listed, override, outcome, retry]);
}

// ─── Refusals handed back to the card ────────────────────

interface LoginRefusalsState {
  /** Request id → the code of a sign-in refused because the page moved on. */
  byId: Record<string, string>;
  note(requestId: string, code: string): void;
  clear(requestId: string): void;
}

export const useLoginRefusals = create<LoginRefusalsState>()((set) => ({
  byId: {},
  note: (requestId, code) => set((s) => ({ byId: { ...s.byId, [requestId]: code } })),
  clear: (requestId) =>
    set((s) => {
      if (!(requestId in s.byId)) return s;
      const { [requestId]: _gone, ...rest } = s.byId;
      return { byId: rest };
    }),
}));

// ─── The sign-in form ────────────────────────────────────

export interface LoginFields {
  username: string;
  password: string;
  otp: string;
}

/** The view's native fields: they own the text (their change events are async). */
export interface LoginFieldsIO {
  /** What the fields hold right now. */
  read(): LoginFields;
  /** Empty the password and code (`secrets`) or every field. */
  clear(which: 'secrets' | 'all'): void;
}

type Filled = Record<keyof LoginFields, boolean>;
const EMPTY: Filled = { username: false, password: false, otp: false };

export function useLoginForm({ request, fields }: { request: BotRequestView; fields: LoginFieldsIO }) {
  const payload = request.payload as BotLoginPayload;
  const otpOnly = payload.kind === 'otp';
  const vaultOffered = useBots((s) => s.vaultAvailable) && !otpOnly;
  const [save, setSave] = useState(false);
  const [filled, setFilled] = useState<Filled>(EMPTY);
  const [busy, setBusy] = useState<'submit' | 'skip' | null>(null);
  const [refusal, setRefusal] = useState<Extract<DecideOutcome, { kind: 'refused' }> | null>(null);

  /** A field changed: only whether it now holds something is kept. */
  const noteInput = useCallback((field: keyof LoginFields, value: string) => {
    const has = field === 'password' ? value.length > 0 : value.trim().length > 0;
    setFilled((prev) => (prev[field] === has ? prev : { ...prev, [field]: has }));
    // Typing again retires the last refusal (not the fields emptying themselves after one).
    if (has) setRefusal(null);
  }, []);

  // `loginValues` sends whatever was filled: the code alone, or a user name / password.
  const canSubmit = otpOnly ? filled.otp : filled.username || filled.password || filled.otp;

  /** Sign in. Resolves to the outcome (the view closes on `ok` / `stale`), null when nothing was sent. */
  const submit = useCallback(async (): Promise<DecideOutcome['kind'] | null> => {
    if (busy) return null;
    const login = loginValues(fields.read(), { otpOnly, saveToVault: vaultOffered && save });
    if (!login) return null;
    // Before awaiting: the secrets must not outlive the request.
    fields.clear('secrets');
    setFilled((prev) => ({ ...prev, password: false, otp: false }));
    setRefusal(null);
    setBusy('submit');
    try {
      const outcome = await useBots.getState().decide(request, { decision: 'approve', login });
      if (outcome.kind === 'refused') {
        setRefusal(outcome);
        // Retyping will not help when the page moved on: the card under the sheet offers a fresh ask.
        const { code } = outcome;
        if (code && LOGIN_PAGE_MOVED.has(code)) {
          useLoginRefusals.getState().note(request.id, code);
        }
      } else {
        fields.clear('all');
        setFilled(EMPTY);
        useLoginRefusals.getState().clear(request.id);
        if (outcome.kind === 'ok') notifySuccess();
      }
      return outcome.kind;
    } finally {
      setBusy(null);
    }
  }, [busy, fields, otpOnly, request, save, vaultOffered]);

  /** "Not Now": the Bot is told the member skipped the sign-in. */
  const skip = useCallback(async (): Promise<DecideOutcome | null> => {
    if (busy) return null;
    fields.clear('all');
    setFilled(EMPTY);
    setBusy('skip');
    try {
      const outcome = await useBots.getState().decide(request, { decision: 'deny' });
      if (outcome.kind === 'ok') notifySuccess();
      return outcome;
    } finally {
      setBusy(null);
    }
  }, [busy, fields, request]);

  return {
    payload,
    otpOnly,
    /** The page's origin host, for the sheet's title ("Sign In to github.com"). */
    host: hostOf(payload.origin) ?? hostOf(payload.url) ?? '',
    /** The page address, when it says more than the origin. */
    page: payload.url && payload.url !== payload.origin ? payload.url : null,
    vaultOffered,
    save,
    setSave,
    noteInput,
    /** Anything typed — the discard check of ✕. */
    dirty: filled.username || filled.password || filled.otp,
    canSubmit,
    busy,
    /** Why the last attempt was refused (the fields are empty again by then). */
    refusal,
    submit,
    skip,
  };
}
