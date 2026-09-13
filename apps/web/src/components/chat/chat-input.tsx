/**
 * Chat input area — textarea + image upload + send button.
 *
 * Composer enhancements:
 *  - `@`  → select an agent profile (switches the active profile; shows a pill)
 *  - `/`  → select a Task (attaches structured instructions + variable fields)
 * Explicit profile and Task selections render as removable structured context.
 *
 * Extracted from chat.tsx for reusability and maintainability.
 */

import React, { useRef, useEffect, useCallback, useState } from 'react';
import { Button, Spinner } from '../ui';
import { ArrowUp, Paperclip, Square } from '../../lib/icons';
import { useTriggerPopup } from './use-trigger-popup';
import { CommandMenuPopover } from './command-menu-popover';
import type { SlashSkill, UserPrompt } from './command-menu-popover';
import { parseTaskVariables } from '@greenhouse/types/tasks';
import { MentionPopover } from './mention-popover';
import { ComposerChips } from './composer-chips';
import { TaskVariableForm } from './task-variable-form';
import { AttachmentChips } from '../conversation/attachments';
import type { PendingAttachment } from '../conversation/attachments';
import type { Profile } from '../../lib/api';
import type { MissionRuntimeAvailability } from '../../lib/api/cloud-agent';
import { AnnotationList } from './annotation-list';
import type { Annotation } from './annotation-list';
import { useT } from '../../lib/i18n';

/**
 * Composer height, in px. One line at rest, growing to roughly four before it
 * scrolls internally.
 *
 * Global rather than per-surface on purpose: a taller composer only for the
 * empty state would jump the instant the first message is sent, and the overlay
 * shares this component. The empty state is now the personal workbench, so the
 * vertical space a permanently three-line composer used to hold belongs to the
 * cards above it.
 *
 * The floor is 56 and not lower because the mobile send button is anchored to
 * the textarea's own bottom-right (`absolute bottom-2`) and is a 44px touch
 * target: below 52 it overflows into the toolbar row underneath.
 */
const COMPOSER_MIN_HEIGHT = 56;
const COMPOSER_MAX_HEIGHT = 112;

export interface PendingImage {
  file: File;
  preview: string;
  uploading: boolean;
  uploaded?: { id: string; url: string };
  error?: string;
}

interface ChatInputProps {
  input: string;
  setInput: (v: string) => void;
  isStreaming: boolean;
  pendingImages: PendingImage[];
  onSend: () => void;
  onStop: () => void;
  onImageSelect: (files: FileList | File[]) => void;
  onRemoveImage: (index: number) => void;
  maxImages?: number;
  /** Slot rendered at the start of the left toolbar (thinking mode, etc.) */
  topSlot?: React.ReactNode;
  /** Slot rendered ABOVE the composer box (workflow run dock, etc.) */
  aboveSlot?: React.ReactNode;
  /** Slot rendered after the attachment control in the left toolbar */
  feedbackSlot?: React.ReactNode;
  /** Slot rendered in the bottom-right toolbar (before send button) */
  rightSlot?: React.ReactNode;
  /** Auto-focus textarea on mount */
  autoFocus?: boolean;
  /**
   * Disable the send buttons while the composer stays editable (mission run
   * in flight). Distinct from isStreaming: no stop button, drafts keep
   * working. Enter still calls onSend so the host can explain the block.
   */
  sendDisabled?: boolean;
  /**
   * A send was accepted but is waiting for in-flight image uploads. The send
   * button shows a spinner (still no stop button — nothing is streaming yet)
   * and the host sends automatically once the uploads settle.
   */
  sendWaiting?: boolean;
  /** Hide the image-attachment affordance (mission composers use file attachments instead). */
  attachmentsDisabled?: boolean;
  /** Replace the standard localized placeholder for special composer states. */
  placeholder?: string;
  /** Hide the arrow/stop control when the rightSlot owns the primary action. */
  hideSendButton?: boolean;

  // ── Generic file attachments (every conversation) ──
  // Providing onAttachmentSelect switches the paperclip to an any-file-type
  // picker; files render as chips and upload on send (host-owned flow).
  /** Pending attachment chips (name + size + upload state). */
  pendingAttachments?: Array<PendingAttachment<unknown>>;
  /** Called with picked/pasted files — enables the generic attach button. */
  onAttachmentSelect?: (files: FileList | File[]) => void;
  /** Remove a pending attachment chip by index. */
  onRemoveAttachment?: (index: number) => void;
  /** Cap for the generic attach button's disabled state. */
  maxAttachments?: number;
  /** Optional external ref to the textarea (e.g. to focus after quoting) */
  inputRef?: React.MutableRefObject<HTMLTextAreaElement | null>;
  /** Tasks available from the slash picker. */
  slashPrompts?: UserPrompt[];
  /** Mission-ready skills for the slash picker (empty when the user can't launch missions). */
  slashSkills?: SlashSkill[];
  /** Mission admission posture; omitted when the user lacks the feature. */
  missionAvailability?: MissionRuntimeAvailability;
  /** Task attached to this draft; its body is expanded only when sending. */
  selectedPrompt?: UserPrompt | null;
  /** Skill attached to this draft; sending launches a Cloud Agent mission. */
  selectedSkill?: SlashSkill | null;
  /** Explicit route for the next send to continue a Mission. */
  missionInstruction?: boolean;
  /** Values typed into the selected task's `{{variables}}` form. */
  taskValues?: Record<string, string>;
  onTaskValueChange?: (key: string, value: string) => void;
  onSelectPrompt?: (prompt: UserPrompt) => void;
  onRemovePrompt?: () => void;
  onSelectSkill?: (skill: SlashSkill) => void;
  onRemoveSkill?: () => void;
  onRemoveMissionInstruction?: () => void;
  /** Annotations from selection follow-up */
  annotations?: Annotation[];
  /** Update an annotation's note */
  onUpdateAnnotation?: (id: string, note: string) => void;
  /** Delete an annotation */
  onDeleteAnnotation?: (id: string) => void;
  /** Clear all annotations */
  onClearAnnotations?: () => void;

  // ── @ Agent Profile picker ──
  /** Profiles available from the @ picker. */
  profiles?: Profile[];
  /** Currently-active profile id (shown with a check in the menu). */
  selectedProfileId?: string;
  /** Enable the @ trigger (e.g. only for new chats with >1 profile). */
  mentionEnabled?: boolean;
  /** Called when a profile is selected from the @ picker. */
  onMentionProfile?: (profileId: string) => void;
  /** Profile to surface as a pill (null = none). */
  profileChip?: Profile | null;
  /** Remove the profile pill (revert to default). */
  onRemoveProfileChip?: () => void;
}

export function ChatInput({
  input,
  setInput,
  isStreaming,
  pendingImages,
  onSend,
  onStop,
  onImageSelect,
  onRemoveImage,
  maxImages = 3,
  topSlot,
  aboveSlot,
  feedbackSlot,
  rightSlot,
  autoFocus,
  sendDisabled = false,
  sendWaiting = false,
  attachmentsDisabled = false,
  placeholder,
  hideSendButton = false,
  pendingAttachments = [],
  onAttachmentSelect,
  onRemoveAttachment,
  maxAttachments = 10,
  inputRef,
  slashPrompts = [],
  slashSkills = [],
  missionAvailability,
  selectedPrompt,
  selectedSkill,
  missionInstruction,
  taskValues,
  onTaskValueChange,
  onSelectPrompt,
  onRemovePrompt,
  onSelectSkill,
  onRemoveSkill,
  onRemoveMissionInstruction,
  annotations = [],
  onUpdateAnnotation,
  onDeleteAnnotation,
  onClearAnnotations,
  profiles = [],
  selectedProfileId = '',
  mentionEnabled = false,
  onMentionProfile,
  profileChip,
  onRemoveProfileChip,
}: ChatInputProps) {
  const t = useT();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const attachmentsUploading = pendingAttachments.some((a) => a.uploading);
  const inputAreaRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const pendingTaskFocusRef = useRef<{ promptId: number; fallbackCaret: number } | null>(null);
  const [isMobileComposer, setIsMobileComposer] = useState(false);
  // Track IME composition manually so Enter confirms a candidate instead of
  // accidentally sending the message.
  const isComposingRef = useRef(false);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const media = window.matchMedia('(max-width: 767px)');
    const sync = () => setIsMobileComposer(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  // ── / Task + Skill trigger ──
  const slashEnabled =
    !isStreaming && (slashPrompts.length > 0 || slashSkills.length > 0 || missionAvailability !== undefined);
  const slash = useTriggerPopup({ triggerChar: '/', textareaRef, value: input, enabled: slashEnabled });

  // ── @ Agent Profile trigger ──
  const mentionActiveEnabled = mentionEnabled && profiles.length > 0 && !isStreaming;
  const mention = useTriggerPopup({ triggerChar: '@', textareaRef, value: input, enabled: mentionActiveEnabled });

  // Only one popover at a time; if both triggers match, the one nearer the cursor
  // (larger triggerIndex) wins.
  const showSlash = slash.isActive && (!mention.isActive || slash.triggerIndex >= mention.triggerIndex);
  const showMention = mention.isActive && !showSlash;

  // Auto-focus on mount
  useEffect(() => {
    if (autoFocus && textareaRef.current) {
      const timer = setTimeout(() => textareaRef.current?.focus(), 100);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [autoFocus]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height =
        Math.max(COMPOSER_MIN_HEIGHT, Math.min(textareaRef.current.scrollHeight, COMPOSER_MAX_HEIGHT)) + 'px';
    }
  }, [input]);

  // Place the caret at `pos` after a programmatic input change.
  const refocusAt = useCallback((pos: number) => {
    setTimeout(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(pos, pos);
    }, 0);
  }, []);

  // Handle /Task selections — strip only the trigger token and attach the
  // Task as structured context. The rest of the draft stays editable.
  const handleSelectPrompt = useCallback(
    (prompt: UserPrompt) => {
      const at = slash.triggerIndex;
      pendingTaskFocusRef.current = { promptId: prompt.id, fallbackCaret: at };
      setInput(slash.insertSelection(''));
      onSelectPrompt?.(prompt);
    },
    [slash, setInput, onSelectPrompt],
  );
  // Handle /Skill selections — strip the trigger token and attach the skill
  // as a chip; the send launches a Cloud Agent mission with the typed brief.
  const handleSelectSkill = useCallback(
    (skill: SlashSkill) => {
      const at = slash.triggerIndex;
      setInput(slash.insertSelection(''));
      onSelectSkill?.(skill);
      refocusAt(at);
    },
    [slash, setInput, onSelectSkill, refocusAt],
  );
  // Handle @ Agent selection — strip the `@query` token, switch profile.
  const handleSelectMention = useCallback(
    (profileId: string) => {
      const at = mention.triggerIndex;
      setInput(mention.insertSelection(''));
      onMentionProfile?.(profileId);
      refocusAt(at);
    },
    [mention, setInput, onMentionProfile, refocusAt],
  );

  // A Task with variables starts in its first blank instead of bouncing the
  // user back to the message textarea. TaskVariableForm handles deterministic
  // Tab movement through the remaining variables and then calls back here.
  useEffect(() => {
    const request = pendingTaskFocusRef.current;
    if (!request || selectedPrompt?.id !== request.promptId) return;
    pendingTaskFocusRef.current = null;
    const firstVariable = containerRef.current?.querySelector<HTMLInputElement>('[data-task-variable-input]');
    if (firstVariable) {
      firstVariable.focus();
      return;
    }
    refocusAt(request.fallbackCaret);
  }, [refocusAt, selectedPrompt]);

  const focusMessageInput = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.focus();
    const end = textarea.value.length;
    textarea.setSelectionRange(end, end);
  }, []);

  // Send handler. `sendDisabled` only disables the buttons — Enter still
  // reaches onSend so the host can surface a hint for why sending is blocked.
  const handleSend = useCallback(() => {
    // Dismiss any open popover
    slash.dismiss();
    mention.dismiss();
    onSend();
  }, [slash, mention, onSend]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Don't handle Enter if a popover is open (popover handles it)
      if (slash.isActive || mention.isActive) return;
      // Guard against IME composition: `isComposing`/keyCode 229 cover browsers,
      // plus the manual ref cover browsers where composition state is delayed.
      const composing = e.nativeEvent.isComposing || e.keyCode === 229 || isComposingRef.current;
      if (e.key === 'Enter' && !e.shiftKey && !composing) {
        // While a response is generating the composer stays editable, but Enter
        // must not send — swallow it (no send, no stray newline). Shift+Enter
        // still inserts a newline so the user can draft a multi-line follow-up.
        e.preventDefault();
        if (!isStreaming) handleSend();
      }
    },
    [handleSend, slash.isActive, mention.isActive, isStreaming],
  );

  const defaultPlaceholder = isMobileComposer
    ? t('chat.askPlaceholderShort')
    : mentionActiveEnabled && slashEnabled
      ? t('chat.askPlaceholderFull')
      : mentionActiveEnabled
        ? t('chat.askPlaceholderAgent')
        : slashEnabled
          ? t('chat.askPlaceholderTask')
          : t('chat.askPlaceholderShort');

  return (
    <div className="mobile-keyboard-lift px-3 md:px-4 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:pb-4 bg-gradient-to-t from-surface-canvas via-surface-canvas/95 to-surface-canvas/0 flex-shrink-0">
      <div ref={containerRef} className="relative mx-auto w-full max-w-5xl">
        {/* Above-composer slot (workflow run dock) */}
        {aboveSlot}

        {/* Annotation list */}
        {annotations.length > 0 && onUpdateAnnotation && onDeleteAnnotation && onClearAnnotations && (
          <div className="mb-2">
            <AnnotationList
              annotations={annotations}
              onUpdate={onUpdateAnnotation}
              onDelete={onDeleteAnnotation}
              onClearAll={onClearAnnotations}
            />
          </div>
        )}

        <div className="relative z-10 overflow-visible rounded-2xl border border-edge bg-surface-chrome shadow-xl transition-[border-color,box-shadow] focus-within:border-primary-500 focus-within:ring-2 focus-within:ring-primary-500/30">
          {/* Image preview */}
          {pendingImages.length > 0 && (
            <div className="px-3 pt-3 pb-1 flex gap-2 flex-wrap">
              {pendingImages.map((img, i) => (
                <div
                  key={i}
                  className="relative group w-14 h-14 md:w-16 md:h-16 rounded-lg overflow-hidden border border-edge flex-shrink-0 bg-surface-muted"
                >
                  <img src={img.preview} alt="" className="w-full h-full object-cover" />
                  {img.uploading && (
                    <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                      <Spinner className="text-white w-4 h-4" />
                    </div>
                  )}
                  {img.error && (
                    <div className="absolute inset-0 bg-danger/60 flex items-center justify-center" title={img.error}>
                      <span className="text-white text-xs font-bold">!</span>
                    </div>
                  )}
                  {img.uploaded && (
                    <div className="absolute bottom-0 left-0 right-0 bg-success/80 text-white text-[9px] text-center">
                      ✓
                    </div>
                  )}
                  <button
                    onClick={() => onRemoveImage(i)}
                    className="absolute -top-1 -right-1 w-5 h-5 bg-fg text-surface rounded-full text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 touch-visible transition-opacity"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Mission file-attachment chips (name + size + upload state) */}
          {onAttachmentSelect && onRemoveAttachment && pendingAttachments.length > 0 && (
            <AttachmentChips attachments={pendingAttachments} onRemove={onRemoveAttachment} className="px-3 pt-3" />
          )}

          {/* Structured @ Agent + / Task + / Skill selections */}
          <ComposerChips
            profile={profileChip}
            onRemoveProfile={onRemoveProfileChip}
            prompt={selectedPrompt}
            onRemovePrompt={onRemovePrompt}
            skill={selectedSkill}
            onRemoveSkill={onRemoveSkill}
            missionInstruction={missionInstruction}
            onRemoveMissionInstruction={onRemoveMissionInstruction}
          />
          {selectedPrompt && onTaskValueChange && (
            <TaskVariableForm
              variables={parseTaskVariables(selectedPrompt.variables)}
              values={taskValues ?? {}}
              onChange={onTaskValueChange}
              onComplete={focusMessageInput}
            />
          )}

          {/* Textarea — visually part of the floating composer */}
          {/*
            No drop handler here: the host (ChatPage / AgentPanel) owns drag-drop so
            the image is added exactly once. A handler here would also bubble to the
            host's onDrop, adding the dropped image twice.
          */}
          <div ref={inputAreaRef} className="relative">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files) onImageSelect(e.target.files);
                e.target.value = '';
              }}
            />
            {/* Any-file-type picker — the host routes images back to the inline path */}
            {onAttachmentSelect && (
              <input
                ref={attachmentInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files) onAttachmentSelect(e.target.files);
                  e.target.value = '';
                }}
              />
            )}
            <textarea
              data-testid="chat-input"
              ref={(el) => {
                textareaRef.current = el;
                if (inputRef) inputRef.current = el;
              }}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              onCompositionStart={() => {
                isComposingRef.current = true;
              }}
              onCompositionEnd={() => {
                isComposingRef.current = false;
              }}
              onPaste={(e) => {
                // Hand every pasted file to the host, which routes by kind
                // (images inline, everything else an attachment) — the same
                // router the picker and drop-zone use.
                if (onAttachmentSelect) {
                  const pasted = Array.from(e.clipboardData.items)
                    .map((item) => item.getAsFile())
                    .filter((f): f is File => f !== null);
                  if (pasted.length) {
                    e.preventDefault();
                    onAttachmentSelect(pasted);
                  }
                  return;
                }
                if (attachmentsDisabled) return;
                const files = Array.from(e.clipboardData.items)
                  .filter((item) => item.type.startsWith('image/'))
                  .map((item) => item.getAsFile())
                  .filter(Boolean) as File[];
                if (files.length) {
                  e.preventDefault();
                  onImageSelect(files);
                }
              }}
              placeholder={placeholder ?? defaultPlaceholder}
              rows={1}
              className="chat-composer-textarea block w-full resize-none border-0 bg-transparent px-4 pb-2.5 pr-16 pt-3 text-sm text-fg placeholder-fg-faint focus:outline-none focus:ring-0 disabled:opacity-60 md:pr-4"
              style={{ minHeight: `${COMPOSER_MIN_HEIGHT}px`, maxHeight: `${COMPOSER_MAX_HEIGHT}px` }}
            />
            {!hideSendButton && (
              <div className="absolute bottom-2 right-3 md:hidden">
                {isStreaming ? (
                  <Button
                    onClick={onStop}
                    variant="ghost"
                    size="icon"
                    className="h-11 w-11 rounded-full border border-danger p-0 text-danger hover:bg-danger-subtle"
                    title={t('chat.stopGenerating')}
                    aria-label={t('chat.stopGenerating')}
                  >
                    <Square size={13} />
                  </Button>
                ) : (
                  <Button
                    onClick={handleSend}
                    data-testid="chat-send"
                    disabled={(!input.trim() && !selectedPrompt && !selectedSkill) || sendDisabled || sendWaiting}
                    size="icon"
                    className="h-11 w-11 rounded-full p-0"
                    title={sendWaiting ? t('chat.uploadingImages') : t('common.send')}
                    aria-label={sendWaiting ? t('chat.uploadingImages') : t('common.send')}
                  >
                    {sendWaiting ? <Spinner className="h-4 w-4" /> : <ArrowUp size={15} />}
                  </Button>
                )}
              </div>
            )}
          </div>

          {/* Bottom toolbar */}
          <div className="flex items-center justify-between gap-2 px-3 pb-3 pt-1 flex-wrap">
            {/* Left: controls + attachment */}
            <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
              {topSlot}
              {onAttachmentSelect ? (
                <button
                  onClick={() => attachmentInputRef.current?.click()}
                  disabled={attachmentsUploading || pendingAttachments.length >= maxAttachments}
                  className="h-11 w-11 sm:h-8 sm:w-8 inline-flex items-center justify-center rounded-lg text-fg-muted hover:text-fg-secondary hover:bg-surface-muted disabled:opacity-40 transition-colors"
                  title={t('cloudAgent.attach', { count: maxAttachments })}
                  aria-label={t('cloudAgent.attach', { count: maxAttachments })}
                >
                  <Paperclip size={15} />
                </button>
              ) : (
                !attachmentsDisabled && (
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isStreaming || pendingImages.length >= maxImages}
                    className="h-11 w-11 sm:h-8 sm:w-8 inline-flex items-center justify-center rounded-lg text-fg-muted hover:text-fg-secondary hover:bg-surface-muted disabled:opacity-40 transition-colors"
                    title={`Upload image (max ${maxImages})`}
                  >
                    <Paperclip size={15} />
                  </button>
                )
              )}
              {feedbackSlot && <div className="flex items-center sm:ml-1">{feedbackSlot}</div>}
            </div>

            {/* Right: profile selector + send/stop */}
            <div className="flex items-center gap-1.5 min-w-0 ml-auto">
              {rightSlot}
              {!hideSendButton && (
                <div className="hidden md:block">
                  {isStreaming ? (
                    <Button
                      onClick={onStop}
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 rounded-full border border-danger p-0 text-danger hover:bg-danger-subtle"
                      title={t('chat.stopGenerating')}
                      aria-label={t('chat.stopGenerating')}
                    >
                      <Square size={13} />
                    </Button>
                  ) : (
                    <Button
                      onClick={handleSend}
                      disabled={(!input.trim() && !selectedPrompt && !selectedSkill) || sendDisabled || sendWaiting}
                      size="icon"
                      className="h-8 w-8 rounded-full p-0"
                      title={sendWaiting ? t('chat.uploadingImages') : t('common.send')}
                      aria-label={sendWaiting ? t('chat.uploadingImages') : t('common.send')}
                    >
                      {sendWaiting ? <Spinner className="h-4 w-4" /> : <ArrowUp size={15} />}
                    </Button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* / Task + Skill menu */}
        {showSlash && (
          <CommandMenuPopover
            query={slash.query}
            prompts={slashPrompts}
            skills={slashSkills}
            missionAvailability={missionAvailability}
            onSelectPrompt={handleSelectPrompt}
            onSelectSkill={handleSelectSkill}
            onDismiss={slash.dismiss}
            anchorRef={containerRef}
          />
        )}

        {/* @ Agent Profile menu */}
        {showMention && (
          <MentionPopover
            query={mention.query}
            profiles={profiles}
            selectedProfileId={selectedProfileId}
            onSelect={handleSelectMention}
            onDismiss={mention.dismiss}
            anchorRef={containerRef}
          />
        )}
      </div>
    </div>
  );
}
