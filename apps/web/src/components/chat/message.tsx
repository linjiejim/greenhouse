/**
 * Chat message display components with cost estimation and clickable sources.
 */

import React, { useState, useMemo, useRef, useEffect } from 'react';
import { Badge, Dialog } from '../ui';
import { RichMarkdown } from '../rich-markdown';
import { MessageActions } from './message-actions';
import { ExportPdfButton } from '../pdf-export';
import { ToolCallRenderer } from '../tool-call/index';
import { BodyArtifacts, MessageAttachments, partitionCalls } from '../tool-call/body-artifacts';
import { PipelineStageChart } from './pipeline-stage-chart';
import type { PipelineStep } from './pipeline-viewer';
import { estimateCost } from '../../lib/api';
import {
  getCategoryIcon,
  BookOpen,
  MessageSquare,
  Image as ImageIcon,
  Pencil,
  Clock,
  DollarSign,
  CheckCircle,
  AlertTriangle,
  Globe,
  ChevronDown,
  Maximize2,
} from '../../lib/icons';
import { marked } from 'marked';
import { useTextSelection } from './use-text-selection';
import { SelectionPopover } from './selection-popover';
import { NoteInputDialog } from './note-input-dialog';
import { UserMessageContent } from './user-message-content';
import { ReasoningPanel } from './reasoning-panel';
import { SproutyFace } from '../sprouty/index.js';
import type { SproutyVariant } from '../sprouty/index.js';
import { dedupe } from './annotations';
export { StreamingMessageBubble } from './streaming-message-bubble';
import { useT } from '../../lib/i18n';

// ─── Types ───────────────────────────────────────────────

// Client-side reference shape — `type` stays a loose string until validated
// (the canonical @greenhouse/types Reference narrows it to 'wiki', i.e. a
// knowledge-base doc citation keyed by doc_id).
interface Reference {
  slug: string;
  title: string;
  type: string;
  category?: string;
  page_type?: string;
  relevance?: number;
  doc_id?: string;
}

/** Open a knowledge-base doc detail by its doc_id (= slug). */
function openKnowledgeDoc(docId: string) {
  window.location.hash = `#/knowledge/${encodeURIComponent(docId)}`;
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
  confidence?: number | null;
  grounded?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedTokens?: number | null;
  reasoningTokens?: number | null;
  durationMs?: number | null;
  createdAt?: string;
  isLastUser?: boolean;
  isStreaming?: boolean;
  /** Compact mode for Agent Panel — hides fullscreen, translate, pipeline chart */
  compact?: boolean;
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
  /** Agent avatar (from profileToSprouty) — a small "done" Sprouty on the completed bubble. */
  agentAvatar?: { variant?: SproutyVariant; color?: string; accessories?: string[]; leafStyle?: string };
}

// ─── Grounding / confidence badges: DORMANT ──────────────
// The "NN% grounded" badge (Sources row) and the "grounded / ungrounded"
// chip (metrics row) were fed EXCLUSIVELY by the `checker` tool's output,
// persisted as message.confidence / message.grounded. The checker tool was
// removed on 2026-06-18, so for every new message these fields are always
// null and the badges carry no signal. Messages persisted before the removal
// may still hold stale values, so we suppress the badges outright instead of
// relying on the `!= null` guard alone. The DB columns + prop threading are
// kept (dormant) as message-quality-metadata infra in case a future signal
// (e.g. an eval-based grounding score) repopulates them — flip this to
// re-enable. See the session-storage notes in README.md.
const SHOW_GROUNDING_BADGES = false;

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
    sessionId: _sessionId,
    reasoning,
    pipeline,
    references,
    images,
    confidence,
    grounded,
    inputTokens,
    outputTokens,
    cachedTokens,
    reasoningTokens,
    durationMs,
    createdAt,
    isLastUser,
    isStreaming,
    compact,
    onEdit,
    onTranslate,
    onRegenerate,
    onQuote,
    onAskUserSubmit,
    onConfirmAction,
    hasFollowUpUserMessage,
    previousUserMessage,
    agentAvatar,
  } = props;

  const [showReasoning, setShowReasoning] = useState(false);
  const [showMetrics, setShowMetrics] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState(content);
  const [showFullscreen, setShowFullscreen] = useState(false);

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
  // trace-block rows vs. body artifacts (the ask_user form, page-update
  // diffs, generated images). Generated-image dedup against embedded markdown lives
  // in <BodyArtifacts> (it receives `content`).
  const { trace: traceCalls, artifacts: artifactCalls } = useMemo(() => {
    const calls = (pipeline ?? []).map((s) => ({
      name: s.tool,
      input: s.input,
      output: s.output,
      status: 'done' as const,
      durationMs: s.duration_ms,
      step: s.step,
    }));
    return partitionCalls(calls);
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
  const renderedHtml = useMemo(() => {
    try {
      const result = marked.parse(content);
      return typeof result === 'string' ? result : '';
    } catch (_err) {
      return '';
    }
  }, [content]);
  const [showAllRefs, setShowAllRefs] = useState(false);

  if (role === 'user') {
    const hasImages = images && images.length > 0;
    return (
      <div className="flex justify-end animate-fade-in">
        <div className="max-w-[80%] bg-primary-subtle border border-primary-edge rounded-xl rounded-br-md px-4 py-3 group relative">
          {/* Image thumbnails */}
          {hasImages && (
            <div className="mb-2 flex gap-2 flex-wrap">
              {images!.map((img) => (
                <a
                  key={img.id}
                  href={img.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block w-20 h-20 rounded-lg overflow-hidden border border-primary-edge hover:border-primary-400 transition-colors flex-shrink-0"
                >
                  <img src={img.url} alt="" className="w-full h-full object-cover" loading="lazy" />
                </a>
              ))}
            </div>
          )}
          {isEditing ? (
            <div className="space-y-2">
              <textarea
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                className="w-full bg-surface-raised border border-primary-300 rounded-lg px-3 py-2 text-sm text-fg focus:outline-none focus:ring-2 focus:ring-primary-500/40 resize-none"
                rows={3}
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
                  Cancel
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
                  Save & Resend
                </button>
              </div>
            </div>
          ) : (
            <UserMessageContent content={content} />
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
                Edit
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Assistant message
  const hasPipeline = pipeline && pipeline.length > 0;
  const hasRefs = references && references.length > 0;
  const hasMetrics = !!(inputTokens || outputTokens || durationMs);
  const analyzedImages = hasPipeline ? pipeline!.filter((s) => s.tool === 'analyze_image') : [];
  const hasAnalyzedImages = analyzedImages.length > 0;

  const hasExternalSources = externalSources.length > 0;

  // Cost estimation
  const cost = hasMetrics ? estimateCost({ inputTokens, outputTokens, cachedTokens }) : null;

  // Shared ctx for artifact cards — the inline block above the prose and the
  // file/media attachments rendered below it.
  const artifactCtx = {
    content,
    onViewWiki: openKnowledgeDoc,
    onViewSource: (id: string) => openKnowledgeDoc(id),
    onAskUserSubmit,
    askUserSubmitted: hasFollowUpUserMessage,
    onOpenSession: (id: string) => {
      window.location.hash = `#/chat?session=${id}`;
    },
  };

  return (
    <div className="animate-fade-in space-y-2">
      <div className="max-w-[90%] min-w-0 group/actions">
        {/* Action bar */}
        <div className="flex items-center gap-3 mb-1.5">
          <SproutyFace {...(agentAvatar ?? {})} state="done" size={20} animate={false} title="Agent" />
          {reasoning && (
            <button
              onClick={() => setShowReasoning(!showReasoning)}
              className="flex items-center gap-1 text-[11px] text-fg-faint hover:text-fg-secondary transition-colors"
            >
              <MessageSquare size={12} />
              <span>Thinking</span>
              <ChevronDown size={11} className={`transition-transform ${showReasoning ? 'rotate-180' : ''}`} />
            </button>
          )}
          {/* Pipeline toggle removed — ToolCallRenderer has its own collapse */}
          {hasAnalyzedImages && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] font-medium rounded-full bg-violet-50 text-violet-600 border border-violet-200">
              <ImageIcon size={11} />{' '}
              {analyzedImages.length === 1 ? t('chat.analyzedImage') : `Analyzed ${analyzedImages.length} images`}
            </span>
          )}
        </div>

        {/* Reasoning panel */}
        {showReasoning && reasoning && <ReasoningPanel reasoning={reasoning} />}

        {/* Pipeline tool calls (trace block) */}
        {traceCalls.length > 0 && (
          <div className="mb-3">
            <ToolCallRenderer
              calls={traceCalls}
              variant="full"
              defaultCollapsed
              onViewWiki={openKnowledgeDoc}
              onViewSource={(id) => openKnowledgeDoc(id)}
            />
          </div>
        )}

        {/* Body artifacts (above prose) — the ask_user form, page-update diffs. File/
            media artifacts render at the bottom via <MessageAttachments>. */}
        {artifactCalls.length > 0 && <BodyArtifacts calls={artifactCalls} ctx={artifactCtx} />}

        {/* Main content — flush, no bubble */}
        <div className="relative">
          <div ref={contentRef}>
            <RichMarkdown content={content} compact onConfirmAction={onConfirmAction} />
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
          {/* Message actions bar — revealed on hover */}
          <div className="mt-1.5 flex items-center justify-between opacity-0 group-hover/actions:opacity-100 focus-within:opacity-100 touch-visible transition-opacity">
            <div className="flex items-center gap-1.5">
              <ExportPdfButton markdown={content} isStreaming={isStreaming} />
              {!compact && (
                <button
                  onClick={() => setShowFullscreen(true)}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] text-fg-muted hover:text-primary-fg rounded-md border border-edge hover:border-primary-300 hover:bg-primary-subtle transition-colors"
                  title="Fullscreen"
                >
                  <Maximize2 size={12} />
                </button>
              )}
            </div>
            <MessageActions
              content={content}
              renderedHtml={renderedHtml}
              onTranslate={!compact && onTranslate && messageId ? (lang) => onTranslate(messageId, lang) : undefined}
              onRegenerate={onRegenerate && messageId ? () => onRegenerate(messageId) : undefined}
              isStreaming={isStreaming}
            />
          </div>
        </div>

        {/* File/media attachments — download cards & generated files — at the message bottom. */}
        {artifactCalls.length > 0 && <MessageAttachments calls={artifactCalls} ctx={artifactCtx} />}

        {/* References (clickable) — single-line, collapsible */}
        {(hasRefs || hasExternalSources) &&
          (() => {
            const sourceRefs = dedupe(references || [], (r) => r.doc_id || r.slug);
            const totalRefCount = sourceRefs.length + externalSources.length;
            const needsExpand = totalRefCount > 4;

            return (
              <div className="mt-2 space-y-1">
                {/* Internal Sources */}
                {sourceRefs.length > 0 && (
                  <div
                    className={`flex items-center gap-1.5 ${showAllRefs ? 'flex-wrap' : 'flex-nowrap overflow-hidden max-h-[26px]'}`}
                  >
                    <span className="text-[11px] text-fg-faint flex items-center gap-1 flex-shrink-0">
                      <BookOpen size={11} /> Sources:
                    </span>
                    {sourceRefs.map((ref) => (
                      <button
                        key={ref.doc_id || ref.slug}
                        onClick={() => openKnowledgeDoc(ref.doc_id || ref.slug)}
                        className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full border bg-primary-subtle text-primary-fg-strong border-primary-edge hover:bg-primary-subtle-hover transition-colors cursor-pointer flex-shrink-0"
                      >
                        {ref.category && (
                          <span className="text-[10px] text-primary-500">
                            {(() => {
                              const Icon = getCategoryIcon(ref.category!);
                              return <Icon size={10} />;
                            })()}
                          </span>
                        )}
                        <span className="truncate max-w-[120px]">{ref.title}</span>
                      </button>
                    ))}
                    {SHOW_GROUNDING_BADGES && confidence != null && (
                      <Badge variant={confidence >= 0.8 ? 'success' : confidence >= 0.5 ? 'warning' : 'destructive'}>
                        <CheckCircle size={11} className="inline" /> {(confidence * 100).toFixed(0)}% grounded
                      </Badge>
                    )}
                  </div>
                )}

                {/* External search sources */}
                {hasExternalSources && (
                  <div
                    className={`flex items-center gap-1.5 ${showAllRefs ? 'flex-wrap' : 'flex-nowrap overflow-hidden max-h-[26px]'}`}
                  >
                    <span className="text-[10px] text-fg-faint flex items-center gap-1 flex-shrink-0">
                      <Globe size={10} /> Web:
                    </span>
                    {externalSources.map((es, i) => (
                      <a
                        key={i}
                        href={es.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded border bg-violet-50 text-violet-700 border-violet-200 hover:bg-violet-100 transition-colors flex-shrink-0"
                        title={es.url}
                      >
                        <Globe size={9} />
                        <span className="truncate max-w-[140px]">{es.title}</span>
                      </a>
                    ))}
                  </div>
                )}

                {/* Expand/collapse toggle */}
                {needsExpand && (
                  <button
                    onClick={() => setShowAllRefs(!showAllRefs)}
                    className="text-[10px] text-primary-fg hover:text-primary-fg-strong transition-colors flex items-center gap-0.5"
                  >
                    {showAllRefs ? 'Collapse' : `Show all ${totalRefCount} references`}
                    <ChevronDown size={10} className={`transition-transform ${showAllRefs ? 'rotate-180' : ''}`} />
                  </button>
                )}
              </div>
            );
          })()}

        {/* Metrics + Cost — collapsed by default; cost, token breakdown and the
              per-step timing chart all live inside the expanded panel. */}
        {hasMetrics && (
          <>
            <button
              onClick={() => setShowMetrics(!showMetrics)}
              className="mt-1.5 flex items-center gap-3 text-[11px] text-fg-faint hover:text-fg-secondary transition-colors"
            >
              {durationMs != null && (
                <span className="flex items-center gap-0.5">
                  <Clock size={10} /> {(durationMs / 1000).toFixed(2)}s
                </span>
              )}
              {SHOW_GROUNDING_BADGES && grounded != null && (
                <span className="flex items-center gap-0.5">
                  {grounded ? (
                    <>
                      <CheckCircle size={10} /> grounded
                    </>
                  ) : (
                    <>
                      <AlertTriangle size={10} /> ungrounded
                    </>
                  )}
                </span>
              )}
              <ChevronDown size={11} className={`transition-transform ${showMetrics ? 'rotate-180' : ''}`} />
            </button>
            {showMetrics && (
              <div className="mt-1 space-y-2">
                {/* Per-step timing breakdown — hidden in compact mode */}
                {!compact && hasPipeline && pipeline!.length > 0 && (
                  <PipelineStageChart steps={pipeline!} totalDurationMs={durationMs} />
                )}
                <div className="flex flex-wrap gap-3 text-[11px] text-fg-muted bg-surface-sunken border border-edge rounded-md px-3 py-2">
                  {inputTokens != null && <span>In: {inputTokens.toLocaleString()}</span>}
                  {outputTokens != null && <span>Out: {outputTokens.toLocaleString()}</span>}
                  {cachedTokens ? <span>Cached: {cachedTokens.toLocaleString()}</span> : null}
                  {reasoningTokens ? <span>Reasoning: {reasoningTokens.toLocaleString()}</span> : null}
                  {durationMs != null && (
                    <span>
                      <Clock size={10} className="inline" /> {(durationMs / 1000).toFixed(2)}s
                    </span>
                  )}
                  {cost && (
                    <span>
                      <DollarSign size={10} className="inline" /> ${cost.usd.toFixed(6)} ≈ ¥{cost.cny.toFixed(4)}
                    </span>
                  )}
                </div>
              </div>
            )}
          </>
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
            <RichMarkdown content={content} />
          </div>
        </Dialog>
      )}
    </div>
  );
}
