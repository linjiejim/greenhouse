/**
 * Body artifacts — rich tool outputs that render inline in the message body
 * instead of as rows inside the collapsible "N tool calls" trace block.
 *
 * This module is the single source of truth for which tool calls become body
 * artifacts (eval cards, the ask_user form, generated images) and how they render:
 *   - <ToolCallRenderer> consults `isArtifactCall` to KEEP these out of the trace
 *     block (so a message with only an eval call shows no trace block at all).
 *   - The message bubbles render <BodyArtifacts> above the prose — except the
 *     confirm-gate cards in `BELOW_PROSE_TOOLS`, which the prose leads up to
 *     ("I drafted this task, launch it?") and therefore render after it
 *     (`splitArtifactsByPlacement`).
 *
 * Mirrors the backend `presentation: 'artifact'` flag (apps/api/src/tools/define.ts);
 * output-shape matchers (ask_user forms, file artifacts) work for any producing tool,
 * so THIS registry — not the flag — is the complete list.
 */

import React from 'react';
import { AlertTriangle, GitBranch, Image } from '../../lib/icons';
import { Skeleton, Spinner } from '../ui';
import { useT } from '../../lib/i18n';
import { EvalResultCard } from './eval-result-card';
import { AskUserCard, type AskUserData } from '../chat/ask-user-card';
import { WorkflowCard } from '../workflow/workflow-card';
import type { WorkflowPlanArtifact } from '@greenhouse/types/workflow';
import { MissionDispatchCard, type MissionDispatchArtifact } from '../cloud-agent/mission-dispatch-card';
import { SchemaPlanCard, type TablesSchemaPlanArtifact } from '../tables/schema-plan-card';
import { TaskCaptureCard, type TaskCaptureData } from '../chat/task-capture-card';
import { FileAttachmentCard } from '../files/file-attachment-card';
import { downloadAuthenticatedFile } from '../../lib/file-download';
import { toast } from '../ui';
import { MediaPreviewDialog } from '../media-preview-dialog';
import { useAuthStore } from '../../stores';

// ─── Types ───────────────────────────────────────────────

/** Minimal call shape this module needs. `ToolCall` (from ./index) is structurally
 *  assignable to this, so callers pass their normalized arrays directly. Defined
 *  locally to keep the dependency one-directional (index → body-artifacts). */
export interface ArtifactCall {
  name: string;
  input?: unknown;
  output?: unknown;
  status?: 'calling' | 'done';
  durationMs?: number;
  step?: number;
  /** Stable position in the persisted pipeline, used by legacy artifact receipts. */
  artifactIndex?: number;
}

export interface ArtifactCtx {
  /** Callback when an ask_user form is submitted (sends the formatted message). */
  onAskUserSubmit?: (message: string) => void;
  /** Whether the ask_user form was already submitted (a follow-up user message exists). */
  askUserSubmitted?: boolean;
  /** Persisted follow-up message used to rebuild the submitted answer summary. */
  askUserSubmittedMessage?: string;
  /** The producing turn is still streaming. The interactive ask_user form is then
   *  skipped entirely (deferred to the committed bubble): the streaming overlay is torn
   *  down + remounted as the committed MessageBubble when the turn ends, which would wipe
   *  any selection made mid-stream. Non-interactive artifacts (eval/image/diff) still show. */
  streaming?: boolean;
  /** Message body text — used to skip a generated image already embedded in the markdown. */
  content?: string;
  /** Open a session by id (spawn_session card → jump to the spawned child). */
  onOpenSession?: (sessionId: string) => void;
  /** The conversation this message belongs to — the mission dispatch card
   *  launches into it and re-discovers its run from its run lineage. */
  sessionId?: string | null;
  messageId?: string;
  /** Whether this transcript may mutate through its action cards. Shared/read-only
   *  sessions keep the artifact visible but never expose a live mutation handle. */
  canAct?: boolean;
}

// ─── Matcher ─────────────────────────────────────────────

/**
 * Whether this specific call renders as a body artifact (vs. a trace-block row).
 * Keyed per-call on the output, not just the tool name, so that:
 *  - the ask_user FORM shape (returned by ask_user or another tool) always
 *    surfaces as a form regardless of which tool produced it;
 *  - a failed eval / in-flight generate_image fall back to the trace block
 *    instead of vanishing.
 */
export function isArtifactCall(call: { name: string; output?: unknown }): boolean {
  const out = call.output as Record<string, unknown> | undefined;

  if (
    out?.type === 'file' &&
    typeof out.file_id === 'string' &&
    typeof out.name === 'string' &&
    typeof out.download_url === 'string'
  ) {
    return true;
  }

  // Interactive form — any tool may return this shape.
  if (out?.type === 'ask_user' && out?.questions) return true;

  switch (call.name) {
    case 'eval_message':
      // Loading (no output yet) or a successful result; an errored eval falls back to trace.
      return !out || !out.error;
    case 'generate_image':
      // An output-less call is the expensive generation wait itself. Surface a
      // stable image-shaped placeholder instead of making the transcript look
      // idle for up to a minute. Errors still fall back to the trace row.
      return !out || (!!out.success && !!out.url);
    case 'spawn_session':
      // Card while in-flight (no output yet) and once a child exists (incl. a
      // failed/timed-out child, so its error is openable). Pre-creation
      // rejections (depth/confirm/profile — error but no child) fall to trace.
      return !out || !!out.child_session_id;
    case 'workflow_plan':
      // Only a persisted plan renders the confirm/run card; validation errors
      // fall back to the trace block so the planner's retry stays readable.
      return out?.type === 'workflow_plan';
    case 'mission_dispatch':
      // Same rule: a validated draft becomes the Launch card, a refusal
      // (runtime off, unknown model) stays a readable trace row.
      return out?.type === 'mission_dispatch';
    case 'tables_schema_plan':
      // Same rule again: only a validated plan becomes the Confirm card. A
      // rejected draft (bad ref, missing builder role) stays a trace row so the
      // model's next attempt reads as one conversation, not a broken card.
      return out?.type === 'tables_schema_plan';
    case 'task_capture':
      // Same rule: a rejected draft (a variable with no placeholder) stays a
      // trace row, so the model's corrected retry reads as one conversation.
      return out?.type === 'task_capture';
    default:
      return false;
  }
}

/**
 * Whether the body artifact fully replaces this call's trace row, so listing it in
 * both places would just be noise.
 *
 * True for the cards that restate the whole call (eval scores, the ask_user form,
 * a spawned session). NOT true for generate_image: its "card" is
 * only the picture, and it renders nothing at all once the URL is already embedded
 * in the prose — which used to erase the call from the UI completely, hiding both
 * that it happened and the fact that it was the slowest, costliest step of the turn.
 */
export function replacesTraceRow(call: { name: string; output?: unknown }): boolean {
  return isArtifactCall(call) && call.name !== 'generate_image';
}

/** Split calls into trace-block rows vs. body artifacts. Lets callers gate each
 *  container's margins (so an artifact-only message shows no empty trace wrapper).
 *  A call can legitimately appear in BOTH lists — see `replacesTraceRow`. */
export function partitionCalls<T extends { name: string; output?: unknown }>(
  calls: T[],
): { trace: T[]; artifacts: T[] } {
  const trace: T[] = [];
  const artifacts: T[] = [];
  for (const c of calls) {
    if (isArtifactCall(c)) artifacts.push(c);
    if (!replacesTraceRow(c)) trace.push(c);
  }
  return { trace, artifacts };
}

/** Confirm-gate cards the message text introduces — reading order is prose first,
 *  then the card with its action button. */
const BELOW_PROSE_TOOLS = new Set(['workflow_plan', 'mission_dispatch', 'tables_schema_plan', 'task_capture']);

/** Split body artifacts by where they sit relative to the prose. */
export function splitArtifactsByPlacement<T extends { name: string }>(calls: T[]): { above: T[]; below: T[] } {
  const above: T[] = [];
  const below: T[] = [];
  for (const c of calls) (BELOW_PROSE_TOOLS.has(c.name) ? below : above).push(c);
  return { above, below };
}

// ─── Renderer ────────────────────────────────────────────

export function BodyArtifacts({
  calls,
  ctx,
  position = 'above',
}: {
  calls: ArtifactCall[];
  ctx: ArtifactCtx;
  /** Which side of the prose this group sits on — controls the outer margin only. */
  position?: 'above' | 'below';
}) {
  const canUseWorkflow = useAuthStore((state) => state.currentUser?.role === 'super');
  const artifacts = calls.filter((c) => {
    if (!isArtifactCall(c)) return false;
    if (c.name === 'workflow_plan' && !canUseWorkflow) return false;
    // Defer the interactive ask_user form until the turn is committed (see `streaming`).
    if (ctx.streaming && (c.output as Record<string, unknown> | undefined)?.type === 'ask_user') {
      return false;
    }
    return true;
  });
  if (artifacts.length === 0) return null;

  return (
    <div className={`space-y-2 ${position === 'below' ? 'mt-3' : 'mb-3'}`}>
      {artifacts.map((call, i) => (
        <BodyArtifactItem key={i} call={call} ctx={ctx} />
      ))}
    </div>
  );
}

function BodyArtifactItem({ call, ctx }: { call: ArtifactCall; ctx: ArtifactCtx }) {
  const t = useT();
  const out = call.output as Record<string, unknown> | undefined;
  const actionId =
    ctx.canAct !== false && ctx.messageId && call.name
      ? `artifact:${ctx.messageId}:${call.step ?? call.artifactIndex ?? 0}:${call.name}`
      : undefined;
  const writableSessionId = ctx.canAct === false ? undefined : (ctx.sessionId ?? undefined);

  if (out?.type === 'file') {
    const name = out.name as string;
    const size = typeof out.size === 'number' ? out.size : undefined;
    const rowCount = typeof out.row_count === 'number' ? out.row_count : undefined;
    const downloadUrl = out.download_url as string;
    return (
      <FileAttachmentCard
        name={name}
        size={size}
        detail={rowCount == null ? undefined : t('fileArtifact.rows', { rows: rowCount })}
        downloadLabel={t('fileArtifact.download')}
        onDownload={async () => {
          if (!downloadUrl.startsWith('/api/chat-files/')) throw new Error('Invalid chat file URL');
          await downloadAuthenticatedFile(downloadUrl, name);
        }}
        downloadError={() => toast(t('fileArtifact.downloadFailed'), 'error')}
      />
    );
  }

  // Interactive form — checked first since any tool can emit it.
  if (out?.type === 'ask_user' && out?.questions) {
    return (
      <AskUserCard
        data={out as unknown as AskUserData}
        onSubmit={ctx.onAskUserSubmit || (() => {})}
        submitted={ctx.askUserSubmitted}
        submittedMessage={ctx.askUserSubmittedMessage}
      />
    );
  }

  switch (call.name) {
    case 'eval_message':
      return out ? <EvalResultCard output={out} /> : <EvalLoadingCard />;

    case 'generate_image': {
      const url = out?.url as string | undefined;
      if (!url) return <GeneratedImageLoadingCard />;
      // Already embedded in the prose (RichMarkdown will render it) — don't double-render.
      if (ctx.content && ctx.content.includes(url)) return null;
      return (
        <GeneratedImageCard
          url={url}
          imageId={typeof out?.filename === 'string' ? out.filename : undefined}
          prompt={(out?.prompt as string) || ''}
        />
      );
    }

    case 'spawn_session':
      return <SpawnSessionCard call={call} ctx={ctx} />;

    case 'workflow_plan':
      return out?.type === 'workflow_plan' ? <WorkflowCard artifact={out as unknown as WorkflowPlanArtifact} /> : null;

    case 'mission_dispatch':
      return out?.type === 'mission_dispatch' ? (
        <MissionDispatchCard artifact={out as unknown as MissionDispatchArtifact} sessionId={writableSessionId} />
      ) : null;

    case 'tables_schema_plan':
      return out?.type === 'tables_schema_plan' ? (
        <SchemaPlanCard
          artifact={out as unknown as TablesSchemaPlanArtifact}
          actionId={actionId}
          sessionId={writableSessionId}
        />
      ) : null;

    case 'task_capture':
      return out?.type === 'task_capture' ? (
        <TaskCaptureCard data={out as unknown as TaskCaptureData} actionId={actionId} sessionId={writableSessionId} />
      ) : null;

    default:
      return null;
  }
}

// ─── Spawn-session card ──────────────────────────────────

/** Pull a display title from the (possibly partial/streaming) tool input. */
function readSpawnTitle(input: unknown): string | undefined {
  let obj: unknown = input;
  if (typeof input === 'string') {
    try {
      obj = JSON.parse(input);
    } catch {
      return undefined;
    }
  }
  if (obj && typeof obj === 'object') {
    const o = obj as Record<string, unknown>;
    return (o.title as string) || (o.prompt as string) || undefined;
  }
  return undefined;
}

/** Live mm:ss timer counting up from when the card mounts (≈ spawn start). */
function ElapsedTime() {
  const [secs, setSecs] = React.useState(0);
  React.useEffect(() => {
    const start = Date.now();
    const id = setInterval(() => setSecs(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  const mm = Math.floor(secs / 60);
  const ss = secs % 60;
  return (
    <span className="tabular-nums">
      {mm}:{ss.toString().padStart(2, '0')}
    </span>
  );
}

/**
 * A spawned child session. Shows live progress (spinner + elapsed time) while the
 * sub-session is still running, then flips to a done/failed state with a link to
 * open the child.
 */
function SpawnSessionCard({ call, ctx }: { call: ArtifactCall; ctx: ArtifactCtx }) {
  const t = useT();
  const out = call.output as Record<string, unknown> | undefined;
  const childId = out?.child_session_id as string | undefined;
  const failed = !!out?.error;
  const inFlight = !out; // tool hasn't returned yet
  const title = (out?.title as string) || readSpawnTitle(call.input) || t('toolSpawn.subSession');

  return (
    <div className="flex items-center gap-2 rounded-lg border border-edge bg-surface-sunken px-3 py-2">
      {inFlight ? (
        <Spinner className="h-4 w-4 flex-shrink-0 text-fg-faint" />
      ) : failed ? (
        <AlertTriangle className="h-4 w-4 flex-shrink-0 text-danger" aria-hidden="true" />
      ) : (
        <GitBranch className="h-4 w-4 flex-shrink-0 text-fg-faint" />
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium text-fg">{title}</div>
        <div className="flex items-center gap-1.5 text-[10px] text-fg-faint">
          <span>{t('toolSpawn.subSession')}</span>
          <span>·</span>
          {inFlight ? (
            <>
              <span>{t('toolSpawn.running')}</span>
              <ElapsedTime />
            </>
          ) : failed ? (
            <span className="text-danger">{(out?.error as string) || t('toolSpawn.done')}</span>
          ) : out?.status === 'started' ? (
            <span>{t('toolSpawn.running')}</span>
          ) : (
            <span>{t('toolSpawn.done')}</span>
          )}
        </div>
      </div>
      {childId && ctx.onOpenSession && (
        <button
          onClick={() => ctx.onOpenSession!(childId)}
          className="flex-shrink-0 rounded-md border border-edge px-2 py-1 text-[11px] font-medium text-fg-secondary transition-colors hover:bg-surface-muted hover:text-fg"
        >
          {t('toolSpawn.open')} →
        </button>
      )}
    </div>
  );
}

// ─── Eval loading state ──────────────────────────────────

/** Animated placeholder shown while eval_message is still running. */
function EvalLoadingCard() {
  const t = useT();
  return (
    <div className="bg-info-subtle rounded-lg border border-info/30 px-3 py-2.5">
      <div className="flex items-center gap-2 mb-2">
        <Spinner className="h-3.5 w-3.5 text-info" />
        <span className="text-xs text-info-fg font-medium">{t('toolEval.evaluatingQuality')}</span>
      </div>
      <div className="grid grid-cols-2 gap-1">
        {[
          t('toolEval.dimConsistency'),
          t('toolEval.dimCitation'),
          t('toolEval.dimBoundary'),
          t('toolEval.dimSafety'),
        ].map((dim, i) => (
          <div
            key={dim}
            className="flex items-center gap-1.5 text-xs text-info animate-pulse"
            style={{ animationDelay: `${i * 200}ms` }}
          >
            <span className="w-3 h-3 rounded-full border border-info/40 flex items-center justify-center">
              <Spinner className="h-2 w-2 text-info" />
            </span>
            {dim}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Generated image ─────────────────────────────────────

function GeneratedImageLoadingCard() {
  const t = useT();
  return (
    <div
      className="relative h-[260px] w-[260px] max-w-full overflow-hidden rounded-lg border border-edge bg-surface-sunken"
      role="status"
      aria-label={t('chat.generatingImage')}
    >
      <Skeleton className="absolute inset-0 h-full w-full rounded-none" />
      <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-surface-raised/40 text-fg-muted">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-edge bg-surface-raised shadow-sm">
          <Image size={18} className="animate-pulse text-primary-500" />
        </div>
        <span className="text-xs font-medium">{t('chat.generatingImage')}</span>
      </div>
    </div>
  );
}

/** Fallback for a generated image the message text never embedded. Width matches the
 *  in-prose thumbnail (`.md-image-row img`) so both paths look the same in a thread. */
function GeneratedImageCard({ url, imageId, prompt }: { url: string; imageId?: string; prompt: string }) {
  const [previewOpen, setPreviewOpen] = React.useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setPreviewOpen(true)}
        className="block w-[260px] max-w-full overflow-hidden rounded-lg border border-edge shadow-sm transition-colors hover:border-primary-400"
        title={prompt}
      >
        <img
          src={url}
          alt={prompt || 'Generated image'}
          className="w-full object-contain"
          loading="lazy"
          onError={(e) => {
            (e.target as HTMLImageElement).style.display = 'none';
          }}
        />
      </button>
      <MediaPreviewDialog
        open={previewOpen}
        files={[{ ...(imageId ? { id: imageId } : {}), src: url, type: 'image', ...(prompt ? { name: prompt } : {}) }]}
        onClose={() => setPreviewOpen(false)}
      />
    </>
  );
}
