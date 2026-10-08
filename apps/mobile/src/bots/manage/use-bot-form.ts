/**
 * The behaviour behind `/bots/bot-form` on every platform (the SwiftUI view is
 * app/bots/bot-form.tsx; an Android view would reuse all of this — spec
 * docs/specs/20261008-mobile-bots.md §2.9). The rules themselves are pure, in
 * ./bot-form-model.ts:
 *
 *  - `useBotFormSource(params)` — waits for what the form needs (the Bot list;
 *    for a proposal, one re-read of the pending cards) and resolves the mode
 *    and its pre-fill. The route mounts the form only once this is `ready`, so
 *    the (uncontrolled) native fields start from the right text.
 *  - `useBotForm(init)` — the values (initial frozen at mount), the live name
 *    check (the server's rules, vendored), plant / mood picks written through
 *    `withPlant` / `withMood`, dirty / ✓, and `save`:
 *      create → `POST /api/bots` (+ join `inviteTo`), then the new DM to open;
 *      edit → `PATCH /api/bots/:id` with only what changed, toast 已保存;
 *      proposal → `useBots.decide(approve + bot)`, so the card in the thread
 *      flips with it (a card settled elsewhere just closes the sheet).
 *    A refused name goes back under the name field, the 20-Bot limit and
 *    everything else are system alerts. The view navigates on `ok`.
 *
 *    One save at a time, and the form is *held* (`onHold`) from the moment ✓
 *    goes until the sheet is gone: accepting a proposal settles its card in
 *    the store before `save` resolves, so the source turns `missing` ("already
 *    decided") while the sheet is still up — without the hold the form would
 *    unmount and the "gone" state flash before the sheet closes. A save that
 *    doesn't go through (refused, invalid) releases it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { addConversationMember, createBot, updateBot } from '../../api/bots';
import { useT } from '../../lib/i18n';
import type { BotConversationDetail, BotView } from '../../shared/bots';
import { useAuth } from '../../store/auth';
import { usePrefs } from '../../store/prefs';
import { alertError } from '../../ui/dialogs';
import { notifySuccess } from '../../ui/haptics';
import {
  legacyToMood,
  legacyToPlant,
  withMood,
  withPlant,
  type PlantId,
  type PlantMood,
} from '../../ui/plant-avatar/plant-ids';
import { toast } from '../../ui/toast';
import { botsEnabledNow } from '../availability';
import { mergeRequests } from '../requests';
import { useBots } from '../store';
import { validateBotName, type BotNameIssue } from '../vendor/bot-name';
import { botsById, conversationTitle } from '../vendor/web-helpers';
import { useBotDirectory } from './use-bot-directory';
import {
  botFormCanSave,
  botFormDirty,
  botFormTitle,
  botSaveFailure,
  createInput,
  needsComputerWarning,
  proposalDecision,
  resolveBotForm,
  updatePatch,
  type BotFormInit,
  type BotFormParams,
  type BotFormSource,
  type BotFormValues,
} from './bot-form-model';

export type { BotFormInit, BotFormParams, BotFormValues } from './bot-form-model';

/** What the route renders while the form is not ready: a spinner, or a retry after a failed Bot list. */
export type BotFormGate = BotFormSource | { status: 'failed'; retry: () => void };

export function useBotFormSource(params: BotFormParams): BotFormGate {
  const bots = useBots((s) => s.bots);
  const byId = useBots((s) => s.byId);
  const pendingRequests = useBots((s) => s.pendingRequests);
  const requestOverrides = useBots((s) => s.requestOverrides);
  const loadPending = useBots((s) => s.loadPending);
  const lang = usePrefs((s) => s.lang);
  const directory = useBotDirectory();
  const [pendingChecked, setPendingChecked] = useState(false);
  const { requestId } = params;

  // A card can be newer than the pending list (it arrived in the stream): read the list once more.
  useEffect(() => {
    if (!requestId) return;
    let live = true;
    void loadPending().then(() => {
      if (live) setPendingChecked(true);
    });
    return () => {
      live = false;
    };
  }, [requestId, loadPending]);

  const requests = useMemo(
    () => mergeRequests({ rest: pendingRequests, live: [], overrides: requestOverrides }),
    [pendingRequests, requestOverrides],
  );
  if (directory.failed) return { status: 'failed', retry: directory.retry };
  return resolveBotForm(params, { bots, byId, botsLoaded: directory.loaded, requests, pendingChecked, lang });
}

export type BotFormSaveResult = { ok: true; openThread?: { c: string; title: string } } | { ok: false };

export function useBotForm(
  initProp: BotFormInit,
  {
    onHold,
  }: {
    /**
     * Keep showing this form (its init) while its own save is out or went through, whatever the
     * source says by then; `null` lets it go (the save didn't go through). See the file header.
     */
    onHold?: (init: BotFormInit | null) => void;
  } = {},
) {
  // Frozen at mount: a Bot list refresh must not re-dress the draft mid-edit.
  const [init] = useState(initProp);
  const t = useT();
  const lang = usePrefs((s) => s.lang);
  const bots = useBots((s) => s.bots);
  const computer = useBots((s) => s.computer);
  const nickname = useAuth((s) => s.user?.nickname ?? null);

  const [values, setValues] = useState<BotFormValues>(init.values);
  const [serverIssue, setServerIssue] = useState<BotNameIssue | null>(null);
  const [saving, setSaving] = useState(false);

  const editingId = init.bot?.id ?? null;
  const otherNames = useMemo(
    () => bots.filter((bot) => bot.id !== editingId).map((bot) => bot.name),
    [bots, editingId],
  );
  const issueOf = useCallback(
    (name: string) => validateBotName(name, { otherNames, nickname }),
    [otherNames, nickname],
  );
  // A refusal from the server stands until the name changes (the list may not know that Bot yet).
  const nameIssue = issueOf(values.name) ?? serverIssue;

  const set = useCallback(<K extends keyof BotFormValues>(key: K, value: BotFormValues[K]) => {
    setValues((current) => (current[key] === value ? current : { ...current, [key]: value }));
    if (key === 'name') setServerIssue(null);
  }, []);
  const setPlant = useCallback(
    (plant: PlantId) => setValues((v) => ({ ...v, avatar: withPlant(v.avatar, plant) })),
    [],
  );
  const setMood = useCallback((mood: PlantMood) => setValues((v) => ({ ...v, avatar: withMood(v.avatar, mood) })), []);

  /** Resolves a legacy avatar exactly as the Bot shows everywhere else. */
  const stableId = init.bot?.id ?? '';
  const plant = legacyToPlant(values.avatar, init.templateKey, stableId);
  const mood = legacyToMood(values.avatar);

  const dirty = botFormDirty(init.values, values);
  const canSave = !saving && botFormCanSave({ mode: init.mode, initial: init.values, values, nameIssue });
  const title = botFormTitle(init, lang);
  const computerWarning = needsComputerWarning(init, computer);

  /** A refused save: the name line, the limit alert, or the server's own words. */
  const refused = useCallback(
    (code: string | null, message: string, failedKey: 'bots.manage.createFailed' | 'bots.manage.saveFailed') => {
      const failure = botSaveFailure(code, message, failedKey);
      if (failure.kind === 'alert') {
        alertError(t(failure.key), failure.message);
        return;
      }
      setServerIssue(failure.issue);
      // A Bot made elsewhere: let the live check know it too.
      void useBots.getState().loadBots();
    },
    [t],
  );

  /** Send the values: the decision, the PATCH or the create (see the file header). */
  const commit = useCallback(
    async (next: BotFormValues): Promise<BotFormSaveResult> => {
      if (init.mode === 'proposal' && init.request) {
        const outcome = await useBots.getState().decide(init.request, proposalDecision(next));
        if (outcome.kind === 'refused') {
          refused(outcome.code, outcome.message, 'bots.manage.createFailed');
          return { ok: false };
        }
        // `stale`: settled elsewhere — the card flips by itself; nothing to explain.
        if (outcome.kind === 'ok') notifySuccess();
        return { ok: true };
      }

      if (init.mode === 'edit' && init.bot) {
        const patch = updatePatch(init.bot, next);
        if (Object.keys(patch).length === 0) return { ok: true };
        const result = await updateBot(init.bot.id, patch);
        if (!result.ok) {
          refused(result.code, result.message, 'bots.manage.saveFailed');
          return { ok: false };
        }
        // The profile under this sheet reads the directory: refresh it before closing.
        await useBots.getState().loadBots();
        toast(t('bots.manage.saved'), 'check');
        return { ok: true };
      }

      const result = await createBot(createInput(init, next));
      if (!result.ok) {
        refused(result.code, result.message, 'bots.manage.createFailed');
        return { ok: false };
      }
      return await afterCreate(result.value.bot, result.value.dm_session_id, init.inviteTo, t);
    },
    [init, refused, t],
  );

  // One save at a time: a second ✓ before the first one re-rendered must neither send twice nor
  // release the first one's hold. A save that went through keeps it (the sheet is going).
  const inFlight = useRef(false);

  /**
   * `latest`: the native fields' text, read at the moment ✓ is pressed (their
   * change events arrive asynchronously, so the last keystroke may not be in
   * `values` yet).
   */
  const save = useCallback(
    async (latest: Partial<BotFormValues> = {}): Promise<BotFormSaveResult> => {
      if (inFlight.current) return { ok: false };
      const next = { ...values, ...latest };
      setValues(next);
      if (!botFormCanSave({ mode: init.mode, initial: init.values, values: next, nameIssue: issueOf(next.name) })) {
        return { ok: false };
      }
      inFlight.current = true;
      setSaving(true);
      // Before the request goes: the card settles (and the source reads `missing`) once the server answered.
      onHold?.(init);
      let through = false;
      try {
        const result = await commit(next);
        through = result.ok;
        return result;
      } finally {
        setSaving(false);
        if (!through) {
          inFlight.current = false;
          onHold?.(null);
        }
      }
    },
    [values, init, issueOf, commit, onHold],
  );

  return {
    mode: init.mode,
    init,
    values,
    set,
    plant,
    mood,
    setPlant,
    setMood,
    stableId,
    nameIssue,
    dirty,
    canSave,
    saving,
    computerWarning,
    title,
    save,
  };
}

/**
 * A Bot exists now. Learn it (so the thread it opens has its name and face),
 * then: join the conversation it was made for, or open its new DM. Joining is
 * a separate step — if it fails, say exactly that (never "create failed",
 * which would invite a second Create that can only hit "name taken").
 */
async function afterCreate(
  bot: BotView,
  dmSessionId: string | null,
  inviteTo: string | null,
  t: ReturnType<typeof useT>,
): Promise<BotFormSaveResult> {
  const store = useBots.getState();
  await store.loadBots();
  void store.loadConversations();
  if (inviteTo) {
    const joined = await addConversationMember(inviteTo, bot.id);
    if (joined.ok) return { ok: true, openThread: { c: inviteTo, title: threadTitle(joined.value, t) } };
    if (joined.code === 'already_member') return { ok: true, openThread: { c: inviteTo, title: '' } };
    alertError(t('bots.manage.createdNotInvited', { name: bot.name }), joined.message || undefined);
    return { ok: true };
  }
  // No DM while the Bots threads are off: the identity is still usable from Chat.
  if (dmSessionId && botsEnabledNow()) return { ok: true, openThread: { c: dmSessionId, title: bot.name } };
  toast(t('bots.manage.createdToast'), 'check');
  return { ok: true };
}

/** The thread's placeholder title while it loads (a DM is named after its Bot, a group after its title or roster). */
function threadTitle(conversation: BotConversationDetail, t: ReturnType<typeof useT>): string {
  return conversationTitle(conversation, botsById([...useBots.getState().archived, ...useBots.getState().bots]), {
    unknownBot: '',
    group: '',
    archived: (name) => `${name} ${t('bots.common.archivedSuffix')}`,
  });
}
