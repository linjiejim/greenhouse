/**
 * Body artifacts — rich tool outputs that render inline in the message body
 * instead of as rows inside the collapsible "N tool calls" trace block.
 *
 * This module is the single source of truth for which tool calls become body
 * artifacts (the ask_user form, page-update diffs, generated images)
 * and how they render:
 *   - <ToolCallRenderer> consults `isArtifactCall` to KEEP these out of the trace
 *     block (so a message with only an artifact call shows no trace block at all).
 *   - The message bubbles render <BodyArtifacts> just above the prose.
 *
 * Mirrors the backend `presentation: 'artifact'` flag (apps/api/src/tools/define.ts).
 * Client-only tools (e.g. update_page) have no backend ToolMeta, so THIS registry —
 * not the flag — is the complete list.
 */

import React from 'react';
import { GitBranch } from 'lucide-react';
import { Spinner } from '../ui';
import { useT } from '../../lib/i18n';
import { UpdatePageResultCard } from './update-page-card';
import { AskUserCard, type AskUserData } from '../chat/ask-user-card';
import { findArtifactRenderer } from './artifact-renderers';

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
}

export interface ArtifactCtx {
  onViewWiki?: (slug: string) => void;
  onViewSource?: (id: string, category?: string) => void;
  /** Callback when an ask_user form is submitted (sends the formatted message). */
  onAskUserSubmit?: (message: string) => void;
  /** Whether the ask_user form was already submitted (a follow-up user message exists). */
  askUserSubmitted?: boolean;
  /** The producing turn is still streaming. The interactive ask_user form is then
   *  skipped entirely (deferred to the committed bubble): the streaming overlay is torn
   *  down + remounted as the committed MessageBubble when the turn ends, which would wipe
   *  any selection made mid-stream. Non-interactive artifacts (image/diff) still show. */
  streaming?: boolean;
  /** Message body text — used to skip a generated image already embedded in the markdown. */
  content?: string;
  /** Open a session by id (spawn_session card → jump to the spawned child). */
  onOpenSession?: (sessionId: string) => void;
}

// ─── Matcher ─────────────────────────────────────────────

/**
 * Whether this specific call renders as a body artifact (vs. a trace-block row).
 * Keyed per-call on the output, not just the tool name, so that:
 *  - the ask_user FORM shape (returned by ask_user AND email_manager, etc.) always
 *    surfaces as a form regardless of which tool produced it;
 *  - a non-success update_page / in-flight generate_image fall back to
 *    the trace block instead of vanishing.
 */
export function isArtifactCall(call: { name: string; output?: unknown }): boolean {
  const out = call.output as Record<string, unknown> | undefined;

  // Interactive form — any tool may return this shape.
  if (out?.type === 'ask_user' && out?.questions) return true;

  switch (call.name) {
    case 'update_page':
      return !!out?.success;
    case 'generate_image':
      return !!out?.success && !!out?.url;
    case 'spawn_session':
      // Card while in-flight (no output yet) and once a child exists (incl. a
      // failed/timed-out child, so its error is openable). Pre-creation
      // rejections (depth/confirm/profile — error but no child) fall to trace.
      return !out || !!out.child_session_id;
    default:
      // Fork-contributed renderers (empty upstream) — see artifact-renderers.ts.
      return !!findArtifactRenderer(call as ArtifactCall);
  }
}

/** Split calls into trace-block rows vs. body artifacts. Lets callers gate each
 *  container's margins (so an artifact-only message shows no empty trace wrapper). */
export function partitionCalls<T extends { name: string; output?: unknown }>(
  calls: T[],
): { trace: T[]; artifacts: T[] } {
  const trace: T[] = [];
  const artifacts: T[] = [];
  for (const c of calls) (isArtifactCall(c) ? artifacts : trace).push(c);
  return { trace, artifacts };
}

// ─── Renderer ────────────────────────────────────────────

export function BodyArtifacts({ calls, ctx }: { calls: ArtifactCall[]; ctx: ArtifactCtx }) {
  const artifacts = calls.filter((c) => {
    if (!isArtifactCall(c)) return false;
    // Defer the interactive ask_user form until the turn is committed (see `streaming`).
    if (ctx.streaming && (c.output as Record<string, unknown> | undefined)?.type === 'ask_user') {
      return false;
    }
    return true;
  });
  if (artifacts.length === 0) return null;

  return (
    <div className="space-y-2 mb-3">
      {artifacts.map((call, i) => (
        <BodyArtifactItem key={i} call={call} ctx={ctx} />
      ))}
    </div>
  );
}

function BodyArtifactItem({ call, ctx }: { call: ArtifactCall; ctx: ArtifactCtx }) {
  const out = call.output as Record<string, unknown> | undefined;

  // Interactive form — checked first since any tool can emit it.
  if (out?.type === 'ask_user' && out?.questions) {
    return (
      <AskUserCard
        data={out as unknown as AskUserData}
        onSubmit={ctx.onAskUserSubmit || (() => {})}
        submitted={ctx.askUserSubmitted}
      />
    );
  }

  switch (call.name) {
    case 'update_page':
      return out?.success ? <UpdatePageResultCard output={out} /> : null;

    case 'generate_image': {
      const url = out?.url as string | undefined;
      if (!url) return null;
      // Already embedded in the prose (RichMarkdown will render it) — don't double-render.
      if (ctx.content && ctx.content.includes(url)) return null;
      return <GeneratedImageCard url={url} prompt={(out?.prompt as string) || ''} />;
    }

    case 'spawn_session':
      return <SpawnSessionCard call={call} ctx={ctx} />;

    default: {
      // Fork-contributed renderers (empty upstream) — see artifact-renderers.ts.
      const renderer = findArtifactRenderer(call);
      return renderer ? renderer.render(call, ctx) : null;
    }
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
        <span className="flex-shrink-0 text-sm leading-none">⚠️</span>
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

// ─── Generated image ─────────────────────────────────────

function GeneratedImageCard({ url, prompt }: { url: string; prompt: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="block rounded-lg overflow-hidden border border-edge hover:border-primary-400 transition-colors shadow-sm w-fit"
      title={prompt}
    >
      <img
        src={url}
        alt={prompt || 'Generated image'}
        className="max-w-full max-h-80 object-contain"
        loading="lazy"
        onError={(e) => {
          (e.target as HTMLImageElement).style.display = 'none';
        }}
      />
    </a>
  );
}
