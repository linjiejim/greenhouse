/**
 * Composer for a Bots conversation — Chat's ChatInput with the Bots rules:
 * - It never locks. While Bots work the member can keep talking; the message
 *   is delivered and read between Bot turns (202 queued), and Stop sits next
 *   to Send instead of replacing it (kept apart from it, so a hurried click
 *   does not hit the wrong one).
 * - Stop works in two steps: the first press lets the current step finish
 *   (its tool calls complete and are kept) and reads "Stopping…"; a second
 *   press in the same run stops at once.
 * - `@` lists this conversation's Bots (plus "Invite another Bot"), and a
 *   leading "Name," / "Name:" addresses a Bot too.
 * - Files go in the same way as Chat: images inline (the model sees them),
 *   anything else as attachment chips uploaded on send to `/api/chat-files`
 *   against this conversation and appended as the ```attachments fence — the
 *   fence renders as chips and gives the Bot the ids `read_attachment` takes.
 *   An image or a file needs no words to go with it.
 * - Drafts survive switching conversations.
 *
 * Sending reports its own failures through `onSend` (the host owns the
 * message, so every send path — composer, retry, an ask_user form — explains
 * a failure the same way); the composer only gives the draft back.
 */

import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from 'react';
import type { BotView } from '@greenhouse/types/bots';
import { ChatInput, type PendingImage } from '../chat/chat-input';
import { useTriggerPopup } from '../chat/use-trigger-popup';
import {
  acceptAttachments,
  MAX_ATTACHMENTS,
  uploadPendingAttachments,
  type PendingAttachment,
} from '../conversation/attachments';
import { Button, IconButton, Spinner, toast } from '../ui';
import { Square } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import * as api from '../../lib/api';
import { uploadChatFile, type ChatFileRef } from '../../lib/api/chat-files';
import { BotMentionPopover } from './bot-mention-popover';
import { mentionToken, parseMentions } from './mentions';
import type { StopPhase } from './use-bot-conversation';

const MAX_IMAGES = 3;

/** Append the ```attachments fence Chat uses: chips for the member, file ids for `read_attachment`. */
export function withAttachmentsFence(text: string, refs: readonly ChatFileRef[]): string {
  if (refs.length === 0) return text;
  const chips = refs.map((ref) => ({ id: ref.id, name: ref.name, size_bytes: ref.size }));
  const fence = `\`\`\`attachments\n${JSON.stringify(chips)}\n\`\`\``;
  return text ? `${text}\n\n${fence}` : fence;
}

/** Lets the conversation view hand over files dropped anywhere on it. */
export interface BotsComposerHandle {
  addFiles: (files: FileList | File[]) => void;
}

export interface BotsComposerProps {
  /** The conversation's session — attachments are uploaded against it. */
  sessionId: string;
  members: BotView[];
  placeholder: string;
  /** A run is streaming — show Stop beside Send (sending stays allowed). */
  busy: boolean;
  /** Where a stop stands (`soft`: after this step — pressing again stops at once; `hard`: stopping now). */
  stopPhase?: StopPhase;
  input: string;
  setInput: (value: string) => void;
  /** Rejects when nothing was delivered (the host has already said why). */
  onSend: (text: string, images: Array<{ id: string; url: string }>, mentions: string[]) => Promise<void>;
  onStop: () => void;
  onInvite: () => void;
  canInvite: boolean;
  aboveSlot?: ReactNode;
  inputRef: React.MutableRefObject<HTMLTextAreaElement | null>;
}

export const BotsComposer = forwardRef<BotsComposerHandle, BotsComposerProps>(function BotsComposer(
  {
    sessionId,
    members,
    placeholder,
    busy,
    stopPhase = null,
    input,
    setInput,
    onSend,
    onStop,
    onInvite,
    canInvite,
    aboveSlot,
    inputRef,
  },
  ref,
) {
  const t = useT();
  const [images, setImages] = useState<PendingImage[]>([]);
  const [attachments, setAttachments] = useState<PendingAttachment<ChatFileRef>[]>([]);
  const [sending, setSending] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const mention = useTriggerPopup({
    triggerChar: '@',
    textareaRef: inputRef,
    value: input,
    enabled: members.length > 0,
  });
  const uploading = images.some((image) => image.uploading) || attachments.some((item) => item.uploading);
  const uploaded = useMemo(() => images.flatMap((image) => (image.uploaded ? [image.uploaded] : [])), [images]);

  const selectImages = useCallback(
    (files: FileList | File[]) => {
      const picked = Array.from(files)
        .filter((file) => file.type.startsWith('image/'))
        .slice(0, Math.max(0, MAX_IMAGES - images.length));
      for (const file of picked) {
        const preview = URL.createObjectURL(file);
        setImages((current) => [...current, { file, preview, uploading: true }]);
        void api
          .uploadImage(file)
          .then((result) =>
            setImages((current) =>
              current.map((image) =>
                image.preview === preview
                  ? { ...image, uploading: false, uploaded: { id: result.id, url: result.url } }
                  : image,
              ),
            ),
          )
          .catch((err: unknown) => {
            toast(t('bots.composer.uploadFailed'), 'error');
            setImages((current) =>
              current.map((image) =>
                image.preview === preview
                  ? { ...image, uploading: false, error: err instanceof Error ? err.message : String(err) }
                  : image,
              ),
            );
          });
      }
    },
    [images.length, t],
  );

  /**
   * The single entry point for the picker, paste and drop: images stay on the
   * inline path, everything else becomes an attachment chip (uploaded on send).
   */
  const selectFiles = useCallback(
    (files: FileList | File[]) => {
      const picked = Array.from(files);
      const inline = picked.filter((file) => file.type.startsWith('image/'));
      const others = picked.filter((file) => !file.type.startsWith('image/'));
      if (inline.length > 0) selectImages(inline);
      if (others.length === 0) return;
      const { next, tooLarge, overflow } = acceptAttachments(attachments, others);
      if (tooLarge.length > 0) toast(t('cloudAgent.attachmentTooLarge', { name: tooLarge[0].name }), 'error');
      if (overflow > 0) toast(t('bots.composer.attachmentLimit', { count: MAX_ATTACHMENTS }), 'info');
      if (next !== attachments) setAttachments(next);
    },
    [attachments, selectImages, t],
  );

  useImperativeHandle(ref, () => ({ addFiles: selectFiles }), [selectFiles]);

  const removeImage = useCallback((index: number) => {
    setImages((current) => {
      const target = current[index];
      if (target) URL.revokeObjectURL(target.preview);
      return current.filter((_, i) => i !== index);
    });
  }, []);

  const removeAttachment = useCallback((index: number) => {
    setAttachments((current) => current.filter((_, i) => i !== index));
  }, []);

  const send = useCallback(async () => {
    const text = input.trim();
    if (uploading || sending) return;
    // A pasted screenshot or a file on its own is a message too (the API takes
    // an image-only turn, and an attachment-only one carries the fence); with
    // nobody @-mentioned it goes to whoever answers by default.
    if (!text && uploaded.length === 0 && attachments.length === 0) return;
    setSending(true);
    try {
      let content = text;
      let sentAttachments = attachments;
      if (attachments.length > 0) {
        // Chips already uploaded by an earlier, failed send are reused, not re-sent.
        const refs = await uploadPendingAttachments(attachments, setAttachments, (file) =>
          uploadChatFile(sessionId, file),
        );
        if (!refs) {
          toast(t('cloudAgent.attachmentUploadFailed'), 'error');
          return;
        }
        content = withAttachmentsFence(text, refs);
        sentAttachments = attachments.map((item, index) => ({
          file: item.file,
          uploading: false,
          uploaded: refs[index],
        }));
      }
      const mentions = parseMentions(text, members);
      const sentImages = uploaded;
      const previousImages = images;
      setInput('');
      setImages([]);
      setAttachments([]);
      try {
        await onSend(content, sentImages, mentions);
        previousImages.forEach((image) => URL.revokeObjectURL(image.preview));
      } catch {
        // Nothing was delivered — give the draft back exactly as it was (the
        // host already explained why), uploaded chips included.
        setInput(input);
        setImages(previousImages);
        setAttachments((current) => [...sentAttachments, ...current]);
      }
    } finally {
      setSending(false);
    }
  }, [attachments, images, input, members, onSend, sending, sessionId, setInput, t, uploaded, uploading]);

  const pickMember = useCallback(
    (bot: BotView) => {
      const at = mention.triggerIndex;
      const next = mention.insertSelection(mentionToken(bot.name));
      setInput(next);
      setTimeout(() => {
        const el = inputRef.current;
        if (!el) return;
        const caret = at + mentionToken(bot.name).length;
        el.focus();
        el.setSelectionRange(caret, caret);
      }, 0);
    },
    [inputRef, mention, setInput],
  );

  const invite = useCallback(() => {
    // A bare "@" was only ever the way into the picker — drop it. Anything
    // typed after it ("@jim") is the member's words and stays.
    if (mention.query === '') setInput(mention.insertSelection(''));
    else mention.dismiss();
    onInvite();
  }, [mention, onInvite, setInput]);

  return (
    <div ref={anchorRef}>
      <ChatInput
        input={input}
        setInput={setInput}
        // Bots never lock the composer: Enter sends (queued while busy).
        isStreaming={false}
        pendingImages={images}
        onSend={() => void send()}
        onStop={onStop}
        onImageSelect={selectImages}
        onRemoveImage={removeImage}
        maxImages={MAX_IMAGES}
        pendingAttachments={attachments}
        onAttachmentSelect={selectFiles}
        onRemoveAttachment={removeAttachment}
        maxAttachments={MAX_ATTACHMENTS}
        sendDisabled={uploading || sending}
        sendWithoutText
        placeholder={placeholder}
        inputRef={inputRef}
        aboveSlot={
          <>
            {aboveSlot}
            {mention.isActive && (
              <BotMentionPopover
                query={mention.query}
                members={members}
                canInvite={canInvite}
                onSelect={pickMember}
                onInvite={invite}
                onDismiss={mention.dismiss}
                anchorRef={anchorRef}
              />
            )}
          </>
        }
        rightSlot={busy ? <StopControl phase={stopPhase} onStop={onStop} /> : null}
      />
    </div>
  );
});

/**
 * Stop, kept a clear step away from Send. First press: "stop after this
 * step"; while that is under way it reads "Stopping…" and a second press stops
 * at once; once that is asked for there is nothing left to press.
 */
function StopControl({ phase, onStop }: { phase: StopPhase; onStop: () => void }) {
  const t = useT();
  return (
    <span
      className="mr-1.5 flex items-center md:mr-3"
      data-testid="bots-stop-control"
      data-stop-phase={phase ?? 'none'}
    >
      {phase === null ? (
        <IconButton
          label={t('bots.composer.stopAfterStep')}
          onClick={onStop}
          className="rounded-full border border-danger text-danger hover:bg-danger-subtle"
          tooltip="top"
          data-testid="bots-stop"
        >
          <Square size={13} />
        </IconButton>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          onClick={onStop}
          disabled={phase === 'hard'}
          title={phase === 'soft' ? t('bots.composer.stopNow') : undefined}
          className="h-11 rounded-full border border-danger text-danger hover:bg-danger-subtle sm:h-8"
          data-testid="bots-stop"
        >
          <Spinner className="mr-1.5 h-3 w-3" />
          {t('bots.composer.stopping')}
        </Button>
      )}
    </span>
  );
}
