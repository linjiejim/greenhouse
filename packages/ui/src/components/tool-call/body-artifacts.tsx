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
import { GitBranch, FileSpreadsheet, Download } from '../../lib/icons';
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
    case 'export_table':
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

/**
 * File/media artifacts (downloadable exports, generated images) — rendered as
 * attachments at the BOTTOM of the message (via <MessageAttachments>), kept out of
 * the top <BodyArtifacts> block.
 */
export function isMediaArtifact(call: { name: string }): boolean {
  return call.name === 'export_table' || call.name === 'generate_image';
}

// ─── Renderer ────────────────────────────────────────────

export function BodyArtifacts({ calls, ctx }: { calls: ArtifactCall[]; ctx: ArtifactCtx }) {
  const artifacts = calls.filter((c) => {
    if (!isArtifactCall(c)) return false;
    // Defer ONLY the interactive ask_user form while the turn streams: the streaming
    // overlay is torn down + remounted as the committed bubble when the turn ends, which
    // would wipe any selection made mid-stream (see `streaming`).
    if (ctx.streaming && (c.output as Record<string, unknown> | undefined)?.type === 'ask_user') {
      return false;
    }
    // File/media artifacts (generated images, exports) normally render at the BOTTOM of the
    // committed message via <MessageAttachments>, so skip them here — EXCEPT while streaming,
    // when no attachments block is mounted, so surface them here to still appear mid-turn.
    if (isMediaArtifact(c) && !ctx.streaming) return false;
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

/**
 * File/media attachments — download cards and generated files — rendered at the
 * BOTTOM of an assistant message (below the prose). A generated image already
 * embedded in the prose renders inline there, so it is skipped here.
 */
export function MessageAttachments({ calls, ctx }: { calls: ArtifactCall[]; ctx: ArtifactCtx }) {
  const items = calls.filter((c) => {
    if (!isArtifactCall(c) || !isMediaArtifact(c)) return false;
    if (c.name === 'generate_image') {
      const url = (c.output as Record<string, unknown> | undefined)?.url as string | undefined;
      if (url && ctx.content?.includes(url)) return false; // already inline in the prose
    }
    return true;
  });
  if (items.length === 0) return null;

  return (
    <div className="mt-3 space-y-2">
      {items.map((call, i) => (
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

    case 'export_table':
      return out?.url ? <ExportFileCard out={out} /> : null;

    case 'spawn_session':
      return <SpawnSessionCard call={call} ctx={ctx} />;

    default: {
      // Fork-contributed renderers (empty upstream) — see artifact-renderers.ts.
      const renderer = findArtifactRenderer(call);
      return renderer ? renderer.render(call, ctx) : null;
    }
  }
}

// ─── Shared compact-chip styles ──────────────────────────
// Reused by the compact result cards (spawn session, exported file) so they stay
// visually in sync: a sunken bordered shell + a small pill action button.

/** Sunken chip container. ExportFileCard appends `w-fit` to hug its content. */
const CARD_SHELL = 'flex items-center gap-2 rounded-lg border border-edge bg-surface-sunken px-3 py-2';
/** Small pill action button (open / download). */
const CARD_ACTION_BTN =
  'flex-shrink-0 rounded-md border border-edge px-2 py-1 text-[11px] font-medium text-fg-secondary transition-colors hover:bg-surface-muted hover:text-fg';

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
    <div className={CARD_SHELL}>
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
        <button onClick={() => ctx.onOpenSession!(childId)} className={CARD_ACTION_BTN}>
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

// ─── Generated file (CSV / Excel) ─────────────────────────

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Download card for a generated export (export_table). Renders an "expired" state
 * once the link's deadline (expires_at) has passed; the server also 410s past it,
 * so a stale-clock click still fails closed. The friendly (Unicode) filename rides
 * on the <a download> attribute — honored for same-origin proxy links; for a
 * cross-origin presigned link the object store's own Content-Disposition applies.
 */
function ExportFileCard({ out }: { out: Record<string, unknown> }) {
  const t = useT();
  const url = out.url as string;
  const filename = (out.filename as string) || 'export';
  const format = ((out.format as string) || '').toUpperCase();
  const size = typeof out.size_bytes === 'number' ? formatBytes(out.size_bytes) : null;
  const sheetCount = typeof out.sheet_count === 'number' ? out.sheet_count : null;
  const expiresAt = typeof out.expires_at === 'string' ? Date.parse(out.expires_at) : NaN;
  const expired = !Number.isNaN(expiresAt) && Date.now() > expiresAt;

  const subtitle = [format, size, sheetCount && sheetCount > 1 ? `${sheetCount} sheets` : null]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className={`${CARD_SHELL} w-fit max-w-full`}>
      <FileSpreadsheet className={`h-4 w-4 flex-shrink-0 ${expired ? 'text-fg-faint' : 'text-success'}`} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium text-fg">{filename}</div>
        {subtitle && <div className="text-[10px] text-fg-faint">{subtitle}</div>}
      </div>
      {expired ? (
        <span
          className="flex-shrink-0 rounded-md bg-surface-muted px-2 py-1 text-[11px] font-medium text-fg-faint"
          title={t('exportFile.expiredHint')}
        >
          {t('exportFile.expired')}
        </span>
      ) : (
        <a
          href={url}
          download={filename}
          target="_blank"
          rel="noopener noreferrer"
          title={t('exportFile.download')}
          aria-label={t('exportFile.download')}
          className="flex-shrink-0 inline-flex items-center justify-center rounded-md border border-edge p-1.5 text-fg-secondary transition-colors hover:bg-surface-muted hover:text-fg"
        >
          <Download className="h-4 w-4" />
        </a>
      )}
    </div>
  );
}
