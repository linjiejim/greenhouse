/**
 * Chat input area — textarea + image upload + send button.
 *
 * Composer enhancements:
 *  - `@`  → mention an agent profile (switches the active profile; shows a pill)
 *  - `/`  → quick-prompt command menu (commands expand into editable text)
 * The selected profile renders as a removable pill via <ComposerChips>.
 *
 * Extracted from chat.tsx for reusability and maintainability.
 */

import React, { useRef, useEffect, useCallback } from 'react';
import { Button, Spinner } from '../ui';
import { ArrowUp, Paperclip, Square } from '../../lib/icons';
import { useTriggerPopup } from './use-trigger-popup';
import { CommandMenuPopover } from './command-menu-popover';
import type { UserPrompt } from './command-menu-popover';
import { MentionPopover } from './mention-popover';
import { ComposerChips } from './composer-chips';
import type { Profile } from '../../lib/api';
import { AnnotationList } from './annotation-list';
import type { Annotation } from './annotation-list';
import { useT } from '../../lib/i18n';

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
  /** Slot rendered after attachment and voice controls in the left toolbar */
  feedbackSlot?: React.ReactNode;
  /** Slot rendered in the bottom-right toolbar (before send button) */
  rightSlot?: React.ReactNode;
  /** Auto-focus textarea on mount */
  autoFocus?: boolean;
  /** Optional external ref to the textarea (e.g. to focus after quoting) */
  inputRef?: React.MutableRefObject<HTMLTextAreaElement | null>;
  /** Available slash command prompts */
  slashPrompts?: UserPrompt[];
  /** Annotations from selection follow-up */
  annotations?: Annotation[];
  /** Update an annotation's note */
  onUpdateAnnotation?: (id: string, note: string) => void;
  /** Delete an annotation */
  onDeleteAnnotation?: (id: string) => void;
  /** Clear all annotations */
  onClearAnnotations?: () => void;

  // ── @-mention (agent profile) ──
  /** Profiles available for @-mention. */
  profiles?: Profile[];
  /** Currently-active profile id (shown with a check in the menu). */
  selectedProfileId?: string;
  /** Enable the @ trigger (e.g. only for new chats with >1 profile). */
  mentionEnabled?: boolean;
  /** Called when a profile is @-mentioned. */
  onMentionProfile?: (profileId: string) => void;
  /** Profile to surface as a pill (null = none). */
  profileChip?: Profile | null;
  /** Remove the profile pill (revert to default). */
  onRemoveProfileChip?: () => void;
  /** Extra chips rendered in the pill bar after the profile pill (e.g. session-context trigger). */
  chipsExtra?: React.ReactNode;
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
  feedbackSlot,
  rightSlot,
  autoFocus,
  inputRef,
  slashPrompts = [],
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
  chipsExtra,
}: ChatInputProps) {
  const t = useT();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputAreaRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Track IME composition manually — the Electron renderer doesn't reliably set
  // KeyboardEvent.isComposing, so a bare isComposing check would send the
  // message on the Enter that merely confirms the IME candidate.
  const isComposingRef = useRef(false);

  // ── /slash command trigger ──
  const slashEnabled = !isStreaming && slashPrompts.length > 0;
  const slash = useTriggerPopup({ triggerChar: '/', textareaRef, value: input, enabled: slashEnabled });

  // ── @mention trigger (agent profile) ──
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
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = Math.max(72, Math.min(textareaRef.current.scrollHeight, 160)) + 'px';
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

  // Handle /command selections — prompts expand into editable text.
  const handleSelectPrompt = useCallback(
    (prompt: UserPrompt) => {
      const at = slash.triggerIndex;
      setInput(slash.insertSelection(prompt.content));
      refocusAt(at + prompt.content.length);
    },
    [slash, setInput, refocusAt],
  );

  // Handle @mention selection — strip the `@query` token, switch profile.
  const handleSelectMention = useCallback(
    (profileId: string) => {
      const at = mention.triggerIndex;
      setInput(mention.insertSelection(''));
      onMentionProfile?.(profileId);
      refocusAt(at);
    },
    [mention, setInput, onMentionProfile, refocusAt],
  );

  // Send handler
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
      // and our manual ref covers the Electron renderer where neither is reliable. The
      // Enter that confirms an IME candidate must select, not send.
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

  return (
    <div className="px-3 md:px-4 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:pb-0 bg-gradient-to-t from-surface-sunken via-surface-sunken/95 to-surface-sunken/0 flex-shrink-0">
      <div ref={containerRef} className="relative mx-auto w-full max-w-5xl">
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

        <div className="rounded-2xl border border-edge bg-surface-raised shadow-xl overflow-visible">
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

          {/* Selected profile pill */}
          <ComposerChips profile={profileChip} onRemoveProfile={onRemoveProfileChip} extra={chipsExtra} />

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
            <textarea
              ref={(el) => {
                textareaRef.current = el;
                if (inputRef) inputRef.current = el;
              }}
              data-testid="chat-input"
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
                const files = Array.from(e.clipboardData.items)
                  .filter((item) => item.type.startsWith('image/'))
                  .map((item) => item.getAsFile())
                  .filter(Boolean) as File[];
                if (files.length) {
                  e.preventDefault();
                  onImageSelect(files);
                }
              }}
              placeholder={t('chat.askPlaceholderFull')}
              rows={2}
              className="block w-full bg-transparent border-0 px-4 pt-4 pb-2 text-sm text-fg placeholder-fg-faint focus:outline-none focus:ring-0 resize-none disabled:opacity-60"
              style={{ minHeight: '72px', maxHeight: '160px' }}
            />
          </div>

          {/* Bottom toolbar */}
          <div className="flex items-center justify-between gap-2 px-3 pb-3 pt-1 flex-wrap">
            {/* Left: controls + attach */}
            <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
              {topSlot}
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={isStreaming || pendingImages.length >= maxImages}
                className="h-8 w-8 inline-flex items-center justify-center rounded-lg text-fg-muted hover:text-fg-secondary hover:bg-surface-muted disabled:opacity-40 transition-colors"
                title={`Upload image (max ${maxImages})`}
              >
                <Paperclip size={15} />
              </button>
              {feedbackSlot && <div className="flex items-center sm:ml-1">{feedbackSlot}</div>}
            </div>

            {/* Right: profile selector + send/stop */}
            <div className="flex items-center gap-1.5 min-w-0 ml-auto">
              {rightSlot}
              {isStreaming ? (
                <Button
                  onClick={onStop}
                  data-testid="chat-stop"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 rounded-full p-0 text-danger hover:bg-danger-subtle border border-danger"
                  title="Stop generating"
                  aria-label="Stop generating"
                >
                  <Square size={13} />
                </Button>
              ) : (
                <Button
                  onClick={handleSend}
                  data-testid="chat-send"
                  disabled={!input.trim()}
                  size="icon"
                  className="h-8 w-8 rounded-full p-0"
                  title={t('common.send')}
                  aria-label={t('common.send')}
                >
                  <ArrowUp size={15} />
                </Button>
              )}
            </div>
          </div>
        </div>

        {/* /command menu */}
        {showSlash && (
          <CommandMenuPopover
            query={slash.query}
            prompts={slashPrompts}
            onSelectPrompt={handleSelectPrompt}
            onDismiss={slash.dismiss}
            anchorRef={containerRef}
          />
        )}

        {/* @mention menu */}
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
