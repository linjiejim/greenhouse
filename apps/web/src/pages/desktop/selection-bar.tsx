/** Selection assistant: tiny trigger → optional Agent choices → composer. */

import type { Profile } from '@greenhouse/types/api';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, IconButton } from '../../components/ui';
import { Bot, Send, Sparkles, X } from '../../lib/icons';
import { fetchProfilesStrict } from '../../lib/api/profiles';
import { getStoredUser } from '../../lib/auth';
import { invokeDesktop, onDesktopEvent } from '../../lib/desktop/bridge';
import { handOffToMain } from '../../lib/desktop/handoff';
import { composeSelectionMessage } from '../../lib/desktop/surface-actions';
import {
  getDesktopSurfacePreferences,
  resolveDirectSurfaceProfile,
  resolveSurfaceProfiles,
  subscribeDesktopSurfacePreferences,
} from '../../lib/desktop/surface-preferences';
import { DESKTOP_EVENT, type Selection } from '../../lib/desktop/types';
import { getLastProfile } from '../../lib/profile-preferences';
import { useLocalized, useT } from '../../lib/i18n';

type Stage = 'icon' | 'profiles' | 'compose';
type SurfaceProfile = Pick<Profile, 'id' | 'name' | 'name_i18n'>;

export function DesktopSelectionBarPage() {
  const localized = useLocalized();
  const t = useT();
  const userId = getStoredUser()?.id;
  const [selection, setSelection] = useState<Selection | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selectionProfileIds, setSelectionProfileIds] = useState(
    () => getDesktopSurfacePreferences(userId).selectionProfileIds,
  );
  const [stage, setStage] = useState<Stage>('icon');
  const [selectedProfile, setSelectedProfile] = useState<SurfaceProfile | null>(null);
  const [instruction, setInstruction] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const instructionRef = useRef<HTMLTextAreaElement>(null);
  const stageRef = useRef<Stage>('icon');

  useEffect(() => {
    void fetchProfilesStrict()
      .then(setProfiles)
      .catch(() => setProfiles([]));
    return subscribeDesktopSurfacePreferences(userId, (next) => setSelectionProfileIds(next.selectionProfileIds));
  }, [userId]);

  const availableProfiles = useMemo(
    () => resolveSurfaceProfiles(profiles, selectionProfileIds, getLastProfile(userId)),
    [profiles, selectionProfileIds, userId],
  );
  const shownProfiles = useMemo<SurfaceProfile[]>(
    () => (availableProfiles.length > 0 ? availableProfiles : [{ id: 'team', name: t('desktop.defaultAgent') }]),
    [availableProfiles, t],
  );

  const dismiss = useCallback(() => {
    void invokeDesktop('desktop_hide_selection_bar');
  }, []);

  const resetForSelection = useCallback((next: Selection) => {
    setSelection(next);
    stageRef.current = 'icon';
    setStage('icon');
    setSelectedProfile(null);
    setInstruction('');
    setSending(false);
    setError(null);
    void invokeDesktop('desktop_set_selection_surface_mode', { mode: 'icon' });
  }, []);

  useEffect(() => {
    void invokeDesktop('desktop_take_pending_selection')
      .then((pending) => (pending ? resetForSelection(pending) : dismiss()))
      .catch(() => {});
    const unlistenSelection = onDesktopEvent<Selection>(DESKTOP_EVENT.selection, resetForSelection);
    const unlistenCleared = onDesktopEvent<void>(DESKTOP_EVENT.selectionCleared, () => {
      // Clicking the icon itself collapses the source app's selection. Once the user
      // has engaged with the assistant, keep the cached text and continue the flow.
      if (stageRef.current === 'icon') dismiss();
    });
    return () => {
      void unlistenSelection.then((off) => off());
      void unlistenCleared.then((off) => off());
    };
  }, [dismiss, resetForSelection]);

  const openComposer = useCallback((profile: SurfaceProfile) => {
    setSelectedProfile(profile);
    stageRef.current = 'compose';
    setStage('compose');
    void invokeDesktop('desktop_set_selection_surface_mode', { mode: 'composer' }).then(() => {
      window.requestAnimationFrame(() => instructionRef.current?.focus());
    });
  }, []);

  const openSelectionFlow = useCallback(() => {
    const directProfile = resolveDirectSurfaceProfile(shownProfiles);
    if (directProfile) {
      openComposer(directProfile);
      return;
    }
    stageRef.current = 'profiles';
    setStage('profiles');
    void invokeDesktop('desktop_set_selection_surface_mode', { mode: 'profiles' });
  }, [openComposer, shownProfiles]);

  const message = useCallback(
    () => composeSelectionMessage(selection?.text ?? '', instruction),
    [instruction, selection?.text],
  );

  const openAndSend = useCallback(async () => {
    if (!selection?.text || sending) return;
    setSending(true);
    setError(null);
    try {
      await handOffToMain({
        target: 'chat',
        draft: message(),
        autoSend: true,
        newConversation: true,
        profileId: selectedProfile?.id,
      });
      dismiss();
    } catch (cause) {
      setSending(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [dismiss, message, selectedProfile?.id, selection?.text, sending]);

  const preview = (selection?.text ?? '').replace(/\s+/g, ' ').trim();

  if (stage === 'icon') {
    return (
      <div className="h-screen w-screen p-1">
        <button
          type="button"
          aria-label={t('desktop.openSelectionAssistant')}
          title={t('desktop.openSelectionAssistant')}
          onClick={openSelectionFlow}
          className="flex h-full w-full items-center justify-center rounded-full bg-surface-raised/70 text-primary-fg shadow-[0_8px_28px_rgb(0_0_0/0.18)] backdrop-blur-2xl transition-transform hover:scale-105 hover:bg-surface-raised/85 active:scale-95"
        >
          <Sparkles size={17} />
        </button>
      </div>
    );
  }

  if (stage === 'profiles') {
    return (
      <div className="h-screen w-screen p-1">
        <div className="flex h-full items-center gap-1 overflow-hidden rounded-xl bg-surface-raised/72 px-1.5 shadow-[0_10px_32px_rgb(0_0_0/0.18)] backdrop-blur-2xl">
          <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto scrollbar-hide">
            {shownProfiles.map((profile) => (
              <button
                key={profile.id}
                type="button"
                onClick={() => openComposer(profile)}
                className="flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-fg-secondary transition-colors hover:bg-primary-subtle hover:text-primary-fg-strong"
              >
                <Bot size={13} />
                {localized(profile.name_i18n, profile.name)}
              </button>
            ))}
          </div>
          <IconButton label={t('common.close')} onClick={dismiss}>
            <X size={14} />
          </IconButton>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen w-screen p-1.5">
      <div className="flex h-full flex-col overflow-hidden rounded-2xl bg-surface-raised/82 shadow-[0_16px_48px_rgb(0_0_0/0.2)] backdrop-blur-2xl">
        <div className="flex items-center gap-2 border-b border-edge/70 px-3 py-2" data-tauri-drag-region>
          <Bot size={14} className="shrink-0 text-primary-fg" />
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-fg-secondary">
            {selectedProfile ? localized(selectedProfile.name_i18n, selectedProfile.name) : t('desktop.defaultAgent')}
          </span>
          <IconButton label={t('common.close')} onClick={dismiss}>
            <X size={14} />
          </IconButton>
        </div>

        <div className="border-b border-edge/70 px-3 py-2">
          <p className="truncate text-xs text-fg-faint" title={preview}>
            {preview || t('desktop.noSelection')}
          </p>
        </div>

        <textarea
          ref={instructionRef}
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
          placeholder={t('desktop.selectionInstructionPlaceholder')}
          className="h-20 shrink-0 resize-none bg-transparent px-3 py-2.5 text-sm text-fg outline-none placeholder:text-fg-faint"
        />

        {error && <p className="px-3 pb-2 text-xs text-danger-fg">{error}</p>}

        <div className="mt-auto shrink-0 border-t border-edge/70 p-2">
          <Button
            size="sm"
            className="w-full justify-center"
            disabled={!selection?.text || sending}
            onClick={() => void openAndSend()}
          >
            <Send size={13} />
            <span className="ml-1 truncate">
              {sending ? t('desktop.selectionSending') : t('desktop.selectionSendAndOpen')}
            </span>
          </Button>
        </div>
      </div>
    </div>
  );
}
