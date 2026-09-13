/**
 * Chat message display components with operational metrics and clickable sources.
 */

import React, { useState, useMemo, useRef, useEffect } from 'react';
import { Dialog } from '../ui';
import { RichMarkdown } from '../rich-markdown';
import { MessageActions } from './message-actions';
import { ToolCallRenderer } from '../tool-call/index';
import { BodyArtifacts, partitionCalls, splitArtifactsByPlacement } from '../tool-call/body-artifacts';
import { PipelineStageChart } from './pipeline-stage-chart';
import type { PipelineStep } from '@greenhouse/types/session';
import { dedupe } from './annotations';
import { Search, BookOpen, Pencil, Clock, Globe, ChevronDown, Cloud } from '../../lib/icons';
import { marked } from 'marked';
import { useTextSelection } from './use-text-selection';
import { SelectionPopover } from './selection-popover';
import { NoteInputDialog } from './note-input-dialog';
import { UserMessageContent } from './user-message-content';
import { splitAttachments } from '../blocks';
import { AttachmentsBlock } from '../blocks/attachments-block';
import { ReasoningPanel, ReasoningToggle } from './reasoning-panel';
export { StreamingMessageBubble } from './streaming-message-bubble';
import { useT } from '../../lib/i18n';
import { MediaPreviewDialog } from '../media-preview-dialog';

// Temporarily hidden while the message-level evaluation flow is being revised.
const SHOW_MESSAGE_EVAL = false;

// ─── Types ───────────────────────────────────────────────

// Client-side reference shape — `type` stays a loose string until validated
// (the canonical @greenhouse/types Reference narrows it to 'wiki' | 'source').
interface Reference {
  slug: string;
  title: string;
  type: string;
  url?: string;
  category?: string;
  page_type?: string;
  relevance?: number;
  source_id?: string;
  ref_docs?: Array<{ source_id: string; category: string; title: string }>;
}

interface MessageProps {
  role: string;
  content: string;
  messageId?: string;
  sessionId?: string | null;
  reasoning?: string | null;
  pipeline?: PipelineStep[];
  references?: Reference[];
  images?: Array<{ id: string; url: string }>;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedTokens?: number | null;
  reasoningTokens?: number | null;
  durationMs?: number | null;
  /** Registry model id that produced this turn — visible now that it varies per turn. */
  model?: string | null;
  createdAt?: string;
  isLastUser?: boolean;
  isStreaming?: boolean;
  /** Compact mode for Agent Panel — hides eval, fullscreen, translate, pipeline chart */
  compact?: boolean;
  onEval?: (messageId: string) => void;
  /**
   * Existing eval for this message, if it was already evaluated. Present → the eval
   * button shows the verdict and "view" affordance instead of "Eval"; clicking still
   * routes through onEval, which restores the prior eval session.
   */
  evalState?: { verdict: string | null; score_final: number | null } | null;
  onEdit?: (messageId: string, content: string) => void;
  onTranslate?: (messageId: string, targetLang: 'en' | 'zh') => void;
  onRegenerate?: (messageId: string) => void;
  onQuote?: (text: string, note: string) => void;
  /** Callback for ask_user form submission (sends formatted message) */
  onAskUserSubmit?: (message: string) => void;
  /** Callback for a confirm-block button click (sends the picked value as a follow-up message) */
  onConfirmAction?: (value: string) => void;
  /** Whether the message after this one is a user response (ask_user submitted) */
  hasFollowUpUserMessage?: boolean;
  /** Previous user message content — used as fullscreen dialog title */
  previousUserMessage?: string;
  /** Persisted follow-up content used to summarize a submitted ask_user form. */
  submittedUserMessage?: string;
  /** Persisted next user message used to restore confirm-block selection. */
  confirmedActionValue?: string;
  /** Fork the parent conversation through this Agent reply. */
  onFork?: (messageId: string) => Promise<void> | void;
  /** Usage, timing and cost are an operational surface restricted to super users. */
  canViewMetrics?: boolean;
  /** False for shared/read-only transcripts: action artifacts stay reviewable but inert. */
  canActOnArtifacts?: boolean;
  /** Durable Mission outcome rendered as a continuation of its dispatch turn. */
  missionOutcome?: { messageId: string; content: string; createdAt: string };
}

// ─── Message Bubble (completed message) ──────────────────

// Memoized: during streaming the parent re-renders on every token, but the
// already-rendered messages don't change. Shallow-comparing props lets those
// bubbles skip re-render entirely (callers pass stable callbacks + message refs).
export const MessageBubble = React.memo(MessageBubbleImpl);

function MessageBubbleImpl(props: MessageProps) {
  const t = useT();
  const {
    role,
    content,
    messageId,
    sessionId,
    reasoning,
    pipeline,
    references,
    images,
    inputTokens,
    outputTokens,
    cachedTokens,
    reasoningTokens,
    durationMs,
    model,
    createdAt,
    isLastUser,
    isStreaming,
    compact,
    onEval,
    evalState,
    onEdit,
    onTranslate,
    onRegenerate,
    onQuote,
    onAskUserSubmit,
    onConfirmAction,
    hasFollowUpUserMessage,
    previousUserMessage,
    submittedUserMessage,
    confirmedActionValue,
    onFork,
    canViewMetrics = false,
    canActOnArtifacts = true,
    missionOutcome,
  } = props;

  const [showReasoning, setShowReasoning] = useState(false);
  const [showMetrics, setShowMetrics] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState(content);
  const editInputRef = useRef<HTMLTextAreaElement>(null);
  const [showFullscreen, setShowFullscreen] = useState(false);
  const [previewImageIndex, setPreviewImageIndex] = useState<number | null>(null);
  const [isForking, setIsForking] = useState(false);

  // Text selection for "quote & follow up"
  const contentRef = useRef<HTMLDivElement>(null);
  const { selection, clear: clearSelection } = useTextSelection(contentRef);

  // Note input dialog: shown after clicking the selection icon
  const [noteDialog, setNoteDialog] = useState<{ text: string; rect: DOMRect } | null>(null);

  // Active selection popover state — survives selection clearing
  const [activePopover, setActivePopover] = useState<{ text: string; rect: DOMRect } | null>(null);

  // Update active popover from selection (only when there's a real selection)
  useEffect(() => {
    if (selection.text && selection.rect && !noteDialog) {
      setActivePopover({ text: selection.text, rect: selection.rect });
    } else if (!selection.text && !noteDialog) {
      // Delay clearing to allow the click event to fire on the button
      const timer = setTimeout(() => setActivePopover(null), 200);
      return () => clearTimeout(timer);
    }
  }, [selection.text, selection.rect, noteDialog]);

  // Normalize pipeline steps into the shared ToolCall shape, then split into
  // trace-block rows vs. body artifacts (eval cards, the ask_user form, page-update
  // diffs, generated images). Generated-image dedup against embedded markdown lives
  // in <BodyArtifacts> (it receives `content`). Confirm-gate cards (mission
  // dispatch) render below the prose that introduces them.
  const {
    trace: traceCalls,
    artifactsAbove,
    artifactsBelow,
  } = useMemo(() => {
    const calls = (pipeline ?? []).map((s, artifactIndex) => ({
      name: s.tool,
      input: s.input,
      output: s.output,
      status: 'done' as const,
      durationMs: s.duration_ms,
      step: s.step,
      artifactIndex,
    }));
    const { trace, artifacts } = partitionCalls(calls);
    const { above, below } = splitArtifactsByPlacement(artifacts);
    return { trace, artifactsAbove: above, artifactsBelow: below };
  }, [pipeline]);

  // Extract external search sources from pipeline
  const externalSources = useMemo(() => {
    if (!pipeline?.length) return [];
    const sources: Array<{ title: string; url: string }> = [];
    const seen = new Set<string>();
    for (const step of pipeline) {
      if (step.tool === 'external_search' && step.output) {
        const output = step.output as { results?: Array<{ title: string; url: string }> };
        if (output.results) {
          for (const r of output.results) {
            if (!seen.has(r.url)) {
              seen.add(r.url);
              sources.push({ title: r.title, url: r.url });
            }
          }
        }
      }
    }
    return sources;
  }, [pipeline]);

  // Rendered HTML for copy-as-HTML
  const actionContent = missionOutcome ? `${content}\n\n${missionOutcome.content}` : content;
  const renderedHtml = useMemo(() => {
    try {
      const result = marked.parse(actionContent);
      return typeof result === 'string' ? result : '';
    } catch (_err) {
      return '';
    }
  }, [actionContent]);
  const [showReferences, setShowReferences] = useState(false);

  useEffect(() => {
    if (!isEditing || !editInputRef.current) return;
    const input = editInputRef.current;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 240)}px`;
  }, [isEditing, editText]);

  // Mission turns carry their inputs as a server-written fence; lift it out so
  // the bubble shows the prompt as text and the files as chips.
  const { text: userText, attachments } = useMemo(() => splitAttachments(content), [content]);

  if (role === 'user') {
    const hasImages = images && images.length > 0;
    return (
      <>
        <div className="flex justify-end animate-fade-in">
          <div
            className={`group relative max-w-[80%] rounded-2xl rounded-br-md border border-edge bg-surface-muted px-4 py-3 shadow-sm shadow-primary-900/5 ${
              isEditing ? 'w-[min(28rem,80vw)]' : ''
            }`}
          >
            {/* Image thumbnails stay inside the app instead of navigating a
                mobile WebView to a raw image with no visible way back. */}
            {hasImages && (
              <div className="mb-2 flex flex-wrap gap-2">
                {images.map((img, imageIndex) => (
                  <button
                    type="button"
                    key={img.id}
                    onClick={() => setPreviewImageIndex(imageIndex)}
                    aria-label={t('media.viewAttachment', { current: imageIndex + 1, total: images.length })}
                    className="block h-20 w-20 flex-shrink-0 overflow-hidden rounded-lg border border-edge-strong transition-colors hover:border-primary-400"
                  >
                    <img src={img.url} alt="" className="h-full w-full object-cover" loading="lazy" />
                  </button>
                ))}
              </div>
            )}
            {isEditing ? (
              <div className="space-y-2">
                <textarea
                  ref={editInputRef}
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  className="max-h-60 w-full resize-none overflow-y-auto border-0 bg-transparent p-0 text-sm leading-relaxed text-fg outline-none focus:ring-0"
                  rows={1}
                  autoFocus
                />
                <div className="flex gap-1.5 justify-end">
                  <button
                    onClick={() => {
                      setIsEditing(false);
                      setEditText(content);
                    }}
                    className="px-2.5 py-1 text-xs text-fg-muted hover:text-fg-secondary rounded border border-edge-strong hover:bg-surface-sunken"
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    onClick={() => {
                      if (editText.trim() && editText.trim() !== content && onEdit && messageId) {
                        onEdit(messageId, editText.trim());
                        setIsEditing(false);
                      }
                    }}
                    disabled={!editText.trim() || editText.trim() === content}
                    className="px-2.5 py-1 text-xs text-white bg-primary-600 hover:bg-primary-700 rounded disabled:opacity-40"
                  >
                    {t('chat.saveAndResend')}
                  </button>
                </div>
              </div>
            ) : (
              <UserMessageContent content={userText} />
            )}
            {/* Mission inputs: pills between the text and the timestamp row. */}
            {attachments.length > 0 && !isEditing && (
              <div className="mt-2">
                <AttachmentsBlock data={attachments} />
              </div>
            )}
            <div className="flex items-center justify-between mt-1.5">
              {createdAt && <p className="text-[10px] text-fg-faint">{new Date(createdAt).toLocaleTimeString()}</p>}
              {isLastUser && !isEditing && onEdit && (
                <button
                  onClick={() => setIsEditing(true)}
                  className="text-[10px] text-fg-faint hover:text-primary-fg opacity-0 group-hover:opacity-100 touch-visible transition-opacity ml-2"
                  title={t('chat.editMessage')}
                >
                  <Pencil size={10} className="inline mr-0.5" />
                  {t('common.edit')}
                </button>
              )}
            </div>
          </div>
        </div>
        <MediaPreviewDialog
          open={previewImageIndex !== null}
          files={(images ?? []).map((image) => ({ id: image.id, src: image.url, type: 'image' }))}
          initialIndex={previewImageIndex ?? 0}
          onClose={() => setPreviewImageIndex(null)}
        />
      </>
    );
  }

  // Assistant message
  const hasPipeline = pipeline && pipeline.length > 0;
  // Fail closed: non-super users do not get either the expanded values or the
  // disclosure button that hints this operational data exists.
  const hasMetrics = canViewMetrics && !!(inputTokens || outputTokens || durationMs || model);

  const hasExternalSources = externalSources.length > 0;
  const knowledgeRefs = dedupe(references ?? [], (r) => r.slug);
  const hasRefs = knowledgeRefs.length > 0;

  return (
    <div className="animate-fade-in space-y-2">
      <div className="message-actions-host max-w-[90%] min-w-0 group/actions">
        {/* Action bar */}
        {reasoning && (
          <div className="mb-1.5 flex items-center gap-3">
            <ReasoningToggle
              reasoning={reasoning}
              expanded={showReasoning}
              onToggle={() => setShowReasoning(!showReasoning)}
            />
          </div>
        )}

        {/* Reasoning panel */}
        {showReasoning && reasoning && <ReasoningPanel reasoning={reasoning} />}

        {/* Pipeline tool calls (trace block) */}
        {traceCalls.length > 0 && (
          <div className="mb-3">
            <ToolCallRenderer calls={traceCalls} variant="full" defaultCollapsed />
          </div>
        )}

        {/* Body artifacts — eval cards, the ask_user form, page-update diffs, generated images. */}
        {artifactsAbove.length > 0 && (
          <BodyArtifacts
            calls={artifactsAbove}
            ctx={{
              content,
              sessionId,
              messageId,
              canAct: canActOnArtifacts,
              onAskUserSubmit,
              askUserSubmitted: hasFollowUpUserMessage,
              askUserSubmittedMessage: submittedUserMessage,
              onOpenSession: (id) => {
                window.location.hash = `#/chat?session=${id}`;
              },
            }}
          />
        )}

        {/* Main content — flush, no bubble */}
        <div className="relative">
          <div ref={contentRef}>
            <RichMarkdown
              content={content}
              compact
              onConfirmAction={onConfirmAction}
              resolvedConfirmValue={confirmedActionValue}
              linkTarget="new-window"
            />
          </div>
          {/* Selection follow-up: icon button on text selection */}
          {activePopover && onQuote && !noteDialog && (
            <SelectionPopover
              rect={activePopover.rect}
              text={activePopover.text}
              onActivate={(text, rect) => {
                setNoteDialog({ text, rect });
                setActivePopover(null);
                clearSelection();
              }}
            />
          )}
          {/* Note input dialog: independent of selection state */}
          {noteDialog && onQuote && (
            <NoteInputDialog
              quote={noteDialog.text}
              anchorRect={noteDialog.rect}
              onSubmit={(note) => {
                onQuote(noteDialog.text, note);
                setNoteDialog(null);
              }}
              onDismiss={() => setNoteDialog(null)}
            />
          )}
        </div>

        {/* Confirm-gate cards (mission dispatch) — the prose above introduces them,
            so review-then-launch reads top to bottom. */}
        {artifactsBelow.length > 0 && (
          <BodyArtifacts
            position="below"
            calls={artifactsBelow}
            ctx={{
              content,
              sessionId,
              messageId,
              canAct: canActOnArtifacts,
              onAskUserSubmit,
              askUserSubmitted: hasFollowUpUserMessage,
              askUserSubmittedMessage: submittedUserMessage,
              onOpenSession: (id) => {
                window.location.hash = `#/chat?session=${id}`;
              },
            }}
          />
        )}

        {missionOutcome && (
          <div className="mt-3 border-t border-edge/60 pt-3" data-mission-outcome-continuation>
            <div className="mb-2 flex items-center gap-1.5 text-[10px] font-medium text-fg-muted">
              <Cloud size={12} className="text-primary-fg" />
              <span>{t('cloudAgent.resultLabel')}</span>
            </div>
            <RichMarkdown content={missionOutcome.content} compact linkTarget="new-window" />
          </div>
        )}

        {/* References (clickable) — single-line, collapsible */}
        {(hasRefs || hasExternalSources) &&
          (() => {
            const totalRefCount = knowledgeRefs.length + externalSources.length;

            return (
              <div className="mt-2 space-y-1">
                <button
                  onClick={() => setShowReferences(!showReferences)}
                  className="flex items-center gap-1 text-[10px] text-primary-fg transition-colors hover:text-primary-fg-strong"
                >
                  <BookOpen size={11} />
                  {showReferences ? t('common.collapse') : t('chat.showAllReferences', { count: totalRefCount })}
                  <ChevronDown size={10} className={`transition-transform ${showReferences ? 'rotate-180' : ''}`} />
                </button>

                {showReferences && (
                  <div className="space-y-1 animate-fade-in">
                    {/* Knowledge documents the agent actually read */}
                    {hasRefs && (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="flex flex-shrink-0 items-center gap-1 text-[11px] text-fg-faint">
                          <BookOpen size={11} /> {t('chat.sources')}:
                        </span>
                        {knowledgeRefs.map((ref) =>
                          ref.url ? (
                            <a
                              key={ref.slug}
                              href={ref.url}
                              className="inline-flex flex-shrink-0 cursor-pointer items-center gap-1 rounded-full border border-primary-edge bg-primary-subtle px-2 py-0.5 text-xs font-medium text-primary-fg-strong transition-colors hover:bg-primary-subtle-hover"
                              title={ref.title}
                            >
                              <span className="max-w-[120px] truncate">{ref.title}</span>
                            </a>
                          ) : (
                            <span
                              key={ref.slug}
                              className="inline-flex flex-shrink-0 items-center gap-1 rounded-full border border-primary-edge bg-primary-subtle px-2 py-0.5 text-xs font-medium text-primary-fg-strong"
                              title={ref.title}
                            >
                              <span className="max-w-[120px] truncate">{ref.title}</span>
                            </span>
                          ),
                        )}
                      </div>
                    )}

                    {/* External search sources */}
                    {hasExternalSources && (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="flex flex-shrink-0 items-center gap-1 text-[10px] text-fg-faint">
                          <Globe size={10} /> {t('chat.web')}:
                        </span>
                        {externalSources.map((es, i) => (
                          <a
                            key={i}
                            href={es.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex flex-shrink-0 items-center gap-1 rounded border border-info/30 bg-info-subtle px-1.5 py-0.5 text-[10px] font-medium text-info-fg transition-colors hover:border-info/60"
                            title={es.url}
                          >
                            <Globe size={9} />
                            <span className="max-w-[140px] truncate">{es.title}</span>
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })()}

        {/* Single-line footer: elapsed time on the left, all message actions on the right.
            The exact model stays inside the super-only expanded diagnostics —
            it is operational metadata, not part of the answer's primary reading flow. */}
        <div className="message-hover-actions mt-1.5 flex min-h-7 items-center justify-between gap-2 pt-1 transition-opacity">
          <div className="min-w-0">
            {hasMetrics && (
              <button
                onClick={() => setShowMetrics(!showMetrics)}
                className="flex items-center gap-1 text-[11px] text-fg-faint transition-colors hover:text-fg-secondary"
              >
                {durationMs != null && (
                  <span className="flex items-center gap-0.5">
                    <Clock size={10} /> {(durationMs / 1000).toFixed(2)}s
                  </span>
                )}
                {durationMs == null && <span>{t('common.details')}</span>}
                <ChevronDown size={11} className={`transition-transform ${showMetrics ? 'rotate-180' : ''}`} />
              </button>
            )}
          </div>
          <div className="ml-auto flex items-center">
            {SHOW_MESSAGE_EVAL && !compact && messageId && onEval && (
              <button
                onClick={() => onEval(messageId)}
                className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] text-fg-faint transition-colors hover:bg-surface-muted hover:text-primary-fg"
                title={evalState ? t('chat.viewEvaluation') : t('chat.evaluateResponse')}
              >
                <Search size={12} />
                {evalState?.verdict || t('eval.title')}
              </button>
            )}
            <MessageActions
              content={actionContent}
              renderedHtml={renderedHtml}
              onTranslate={!compact && onTranslate && messageId ? (lang) => onTranslate(messageId, lang) : undefined}
              onRegenerate={onRegenerate && messageId ? () => onRegenerate(messageId) : undefined}
              onFullscreen={!compact ? () => setShowFullscreen(true) : undefined}
              onFork={
                !compact && onFork && messageId
                  ? async () => {
                      setIsForking(true);
                      try {
                        await onFork(messageId);
                      } finally {
                        setIsForking(false);
                      }
                    }
                  : undefined
              }
              isForking={isForking}
              isStreaming={isStreaming}
            />
          </div>
        </div>

        {/* Expanded timing/cost details stay on their own row below the footer. */}
        {hasMetrics && showMetrics && (
          <div className="mt-1 space-y-2">
            {/* Per-step timing breakdown — hidden in compact mode */}
            {!compact && hasPipeline && pipeline!.length > 0 && (
              <PipelineStageChart steps={pipeline!} totalDurationMs={durationMs} />
            )}
            <div className="flex flex-wrap gap-3 text-[11px] text-fg-muted bg-surface-sunken border border-edge rounded-md px-3 py-2">
              {model && <span className="font-mono">{model}</span>}
              {inputTokens != null && (
                <span>{t('chat.inputTokensShort', { count: inputTokens.toLocaleString() })}</span>
              )}
              {outputTokens != null && (
                <span>{t('chat.outputTokensShort', { count: outputTokens.toLocaleString() })}</span>
              )}
              {cachedTokens ? (
                <span>{t('chat.cachedTokensShort', { count: cachedTokens.toLocaleString() })}</span>
              ) : null}
              {reasoningTokens ? (
                <span>{t('chat.reasoningTokensShort', { count: reasoningTokens.toLocaleString() })}</span>
              ) : null}
              {durationMs != null && (
                <span>
                  <Clock size={10} className="inline" /> {(durationMs / 1000).toFixed(2)}s
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Fullscreen message dialog — hidden in compact mode */}
      {!compact && (
        <Dialog
          open={showFullscreen}
          onClose={() => setShowFullscreen(false)}
          title={
            previousUserMessage
              ? previousUserMessage.length > 80
                ? previousUserMessage.slice(0, 80) + '…'
                : previousUserMessage
              : ''
          }
          size="full"
          noPadding
        >
          <div className="px-6 pb-6">
            <RichMarkdown content={actionContent} linkTarget="new-window" />
          </div>
        </Dialog>
      )}
    </div>
  );
}
