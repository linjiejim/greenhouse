/**
 * MissionDispatchCard — the body artifact behind the `mission_dispatch` tool.
 *
 * The card IS the confirm gate: the tool wrote nothing, so until the user
 * presses Launch there is no run, no container and no queue slot taken. Before
 * Launch the user can still pick the model — defaulting to the conversation's
 * current chat model, falling back to the deployment default. After Launch the
 * card flips to a dispatched state and the live progress belongs to the Task
 * Dock above the composer (session-modes spec D2/D6).
 *
 * Once the run settles the card collapses to a one-line receipt (the brief is
 * stale reading by then); expanding it shows the prompt plus the run's outcome
 * — result summary and downloadable artifacts — next to what was asked.
 *
 * On reload the static tool artifact re-discovers its run by dispatch_id. Old
 * cards created before that field existed retain the prompt fallback.
 *
 * Split as container (lineage discovery + launch + model choice) over a pure
 * view so the settled/expanded states are testable without effects.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Cloud, ChevronDown, FileText } from '../../lib/icons';
import { Markdown } from '../markdown';
import { Button, Select, Spinner, toast } from '../ui';
import { useT } from '../../lib/i18n';
import {
  CloudAgentDisabledError,
  createCloudAgentRun,
  getCloudAgentRun,
  isCloudAgentRunActive,
  listCloudAgentRunsBySession,
  type CloudAgentArtifact,
  type CloudAgentRun,
} from '../../lib/api/cloud-agent';
import type { ChatModel } from '../../lib/api/profiles';
import { getLastModel } from '../../lib/profile-preferences';
import { useAuthStore } from '../../stores';
import { MissionArtifactsBlock } from '../blocks/mission-artifacts-block';
import { formatRunDuration, missionModelName, useMissionModels } from './shared';
import { ArtifactCard, ArtifactCardActions } from '../chat/artifact-card';

/** Mirror of the server artifact payload (apps/api/src/tools/mission-dispatch.ts). */
export interface MissionDispatchArtifact {
  type: 'mission_dispatch';
  dispatch_id?: string;
  prompt: string;
  /** Short display title; without it the card header falls back to the generic label. */
  title?: string;
  /** Skill the sandbox will mount and follow; the server re-validates it at Launch. */
  skill?: { name: string; display_name: string };
  model?: string;
  workspace_id?: number;
  /** Conversation attachments the sandbox will find under ./inputs/. */
  attachments?: Array<{ file_id: string; name: string }>;
}

/** Prompts are Markdown briefs — collapse by height (never mid-syntax truncation). */
const PROMPT_COLLAPSED_CHARS = 600;
const PROMPT_COLLAPSED_LINES = 8;

/**
 * The model a card offers to launch with, before the user touches the picker:
 * the dispatch's explicit choice wins, else the conversation's current chat
 * model (missions speak the same model vocabulary as chat), else '' meaning
 * the deployment default.
 */
export function resolveMissionModelDefault(
  artifactModel: string | undefined,
  lastModel: string | null,
  models: ChatModel[],
): string {
  if (artifactModel) return artifactModel;
  if (lastModel && models.some((m) => m.id === lastModel)) return lastModel;
  return '';
}

/**
 * agent_runs.prompt currently contains the runner-only ./inputs annotation
 * after an attachment launch. Treat that exact suffix as transport metadata so
 * a reloaded dispatch card still discovers the run it launched.
 */
export function dispatchPromptMatchesRun(runPrompt: string, dispatchPrompt: string): boolean {
  return runPrompt === dispatchPrompt || runPrompt.startsWith(`${dispatchPrompt}\n\n[The user attached `);
}

export function MissionDispatchCard({
  artifact,
  sessionId,
}: {
  artifact: MissionDispatchArtifact;
  sessionId?: string | null;
}) {
  const t = useT();
  const currentUser = useAuthStore((s) => s.currentUser);
  const models = useMissionModels();
  const [launching, setLaunching] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [discovered, setDiscovered] = useState(false);
  /** This card's own run, once launched here or found in the lineage. */
  const [run, setRun] = useState<CloudAgentRun | null>(null);
  /** Someone else's run still occupying the user's single sandbox slot. */
  const [blockedBy, setBlockedBy] = useState<CloudAgentRun | null>(null);
  /** User's explicit pick in the card's model selector; null = untouched. */
  const [pickedModel, setPickedModel] = useState<string | null>(null);

  const modelId = pickedModel ?? resolveMissionModelDefault(artifact.model, getLastModel(currentUser?.id), models);

  const refreshLineage = useCallback(async () => {
    if (!sessionId) {
      setDiscovered(true);
      return;
    }
    try {
      const lineage = await listCloudAgentRunsBySession(sessionId);
      const mine =
        lineage
          .filter(
            (candidate) =>
              (artifact.dispatch_id !== undefined && candidate.dispatch_id === artifact.dispatch_id) ||
              (!candidate.dispatch_id && dispatchPromptMatchesRun(candidate.prompt, artifact.prompt)),
          )
          .at(-1) ?? null;
      setRun(mine);
      const active = lineage.filter((r) => isCloudAgentRunActive(r.status)).at(-1) ?? null;
      setBlockedBy(active && active.id !== mine?.id ? active : null);
    } catch {
      // Degraded: no lineage. Launch stays available; the server keeps authority
      // (one active run per user is enforced there, not here).
    } finally {
      setDiscovered(true);
    }
  }, [artifact.dispatch_id, artifact.prompt, sessionId]);

  useEffect(() => {
    void refreshLineage();
  }, [refreshLineage]);

  // A launched run settles minutes later while this card sits in the DOM — the
  // WS-driven mission hook reloads the transcript, but a card that launched in
  // THIS mount keeps its local `run` until told otherwise. Poll cheaply while
  // our run is active so the card flips to its settled/collapsed state.
  const activeRunId = run && isCloudAgentRunActive(run.status) ? run.id : null;
  useEffect(() => {
    if (!activeRunId) return;
    const timer = window.setInterval(() => void refreshLineage(), 15_000);
    return () => window.clearInterval(timer);
  }, [activeRunId, refreshLineage]);

  const handleLaunch = useCallback(async () => {
    if (launching || !sessionId) return;
    setLaunching(true);
    try {
      const started = await createCloudAgentRun({
        prompt: artifact.prompt,
        dispatch_id: artifact.dispatch_id,
        session_id: sessionId,
        ...(artifact.title ? { title: artifact.title } : {}),
        ...(artifact.skill ? { skill: artifact.skill.name } : {}),
        ...(modelId ? { model: modelId } : {}),
        ...(artifact.workspace_id !== undefined ? { workspace_id: artifact.workspace_id } : {}),
        ...(artifact.attachments?.length ? { chat_file_ids: artifact.attachments.map((a) => a.file_id) } : {}),
      });
      setRun(started);
      toast(t('cloudAgent.taskStarted'), 'success');
    } catch (err) {
      if (err instanceof CloudAgentDisabledError) toast(t('cloudAgent.runtimeDisabled'), 'error');
      else toast(err instanceof Error ? err.message : t('cloudAgent.createFailed'), 'error');
    } finally {
      setLaunching(false);
    }
  }, [artifact, launching, modelId, sessionId, t]);

  return (
    <MissionDispatchCardView
      artifact={artifact}
      sessionId={sessionId}
      run={run}
      blockedBy={blockedBy}
      discovered={discovered}
      dismissed={dismissed}
      launching={launching}
      models={models}
      modelId={modelId}
      onModelChange={setPickedModel}
      onLaunch={() => void handleLaunch()}
      onDismiss={() => setDismissed(true)}
      loadArtifacts={() => getCloudAgentRun(run!.id).then((r) => r.artifacts)}
    />
  );
}

// ─── Pure view ───────────────────────────────────────────

export function MissionDispatchCardView({
  artifact,
  sessionId,
  run,
  blockedBy,
  discovered,
  dismissed,
  launching,
  models,
  modelId,
  onModelChange,
  onLaunch,
  onDismiss,
  loadArtifacts,
  defaultExpanded = false,
}: {
  artifact: MissionDispatchArtifact;
  sessionId?: string | null;
  run: CloudAgentRun | null;
  blockedBy: CloudAgentRun | null;
  discovered: boolean;
  dismissed: boolean;
  launching: boolean;
  models: ChatModel[];
  /** Effective model for Launch; '' = deployment default. */
  modelId: string;
  onModelChange: (id: string) => void;
  onLaunch: () => void;
  onDismiss: () => void;
  /** Fetches the settled run's deliverables on first expand. */
  loadArtifacts: () => Promise<CloudAgentArtifact[]>;
  /** Settled cards collapse to a one-line receipt; tests (or deep links) can start open. */
  defaultExpanded?: boolean;
}) {
  const t = useT();
  const [promptExpanded, setPromptExpanded] = useState(false);
  const settled = !!run && !isCloudAgentRunActive(run.status);
  const [open, setOpen] = useState(defaultExpanded);
  const [artifacts, setArtifacts] = useState<CloudAgentArtifact[] | null>(null);

  // Deliverables are fetched once, on the first expand of a settled card.
  useEffect(() => {
    if (!settled || !open || artifacts !== null) return;
    let disposed = false;
    loadArtifacts()
      .then((items) => {
        if (!disposed) setArtifacts(items);
      })
      .catch(() => {
        if (!disposed) setArtifacts([]);
      });
    return () => {
      disposed = true;
    };
  }, [settled, open, artifacts, loadArtifacts]);

  // A prompt is a Markdown brief; collapsing by height keeps the syntax intact
  // (a character cut used to split fences/lists and garble the preview).
  const promptCollapsible = useMemo(
    () =>
      artifact.prompt.length > PROMPT_COLLAPSED_CHARS ||
      (artifact.prompt.match(/\n/g)?.length ?? 0) > PROMPT_COLLAPSED_LINES,
    [artifact.prompt],
  );
  const promptCollapsed = promptCollapsible && !promptExpanded;

  const modelText = run
    ? missionModelName(run.model, models)
    : modelId
      ? missionModelName(modelId, models)
      : t('cloudAgent.dispatchDefaultModel');
  // The skill is named in the meta line because it, not the prompt, is most of
  // what the sandbox will actually do — launching without seeing it would be
  // confirming a task whose instructions are invisible.
  const meta = `${artifact.title ? `${t('cloudAgent.dispatchTitle')} · ` : ''}${modelText}${
    artifact.skill ? ` · ${t('cloudAgent.dispatchUsesSkill')} ${artifact.skill.display_name}` : ''
  }${!settled && artifact.workspace_id !== undefined ? ` · ${t('cloudAgent.dispatchReusesWorkspace')}` : ''}${
    settled && run ? ` · ${formatRunDuration(run)}` : ''
  }`;
  const status = run
    ? {
        label: run.status,
        tone:
          run.status === 'completed'
            ? ('success' as const)
            : run.status === 'failed'
              ? ('danger' as const)
              : run.status === 'queued' || run.status === 'canceled'
                ? ('neutral' as const)
                : ('info' as const),
        busy: run.status === 'starting' || run.status === 'running',
      }
    : dismissed
      ? { label: t('cloudAgent.dispatchDismiss'), tone: 'neutral' as const }
      : { label: t('workflow.reviewStatus'), tone: 'primary' as const, busy: launching };

  const footerHint = run
    ? t('cloudAgent.dispatchedHint')
    : dismissed
      ? t('cloudAgent.dispatchDismissedHint')
      : blockedBy
        ? t('cloudAgent.dispatchBlockedHint')
        : t('cloudAgent.dispatchHint');

  return (
    <ArtifactCard
      icon={<Cloud size={14} />}
      title={artifact.title || t('cloudAgent.dispatchTitle')}
      meta={meta}
      status={status}
      collapsed={settled && !open}
      onToggle={settled ? () => setOpen((value) => !value) : undefined}
      tone={run?.status === 'completed' ? 'success' : run?.status === 'failed' ? 'danger' : 'neutral'}
      footer={
        !settled ? (
          <ArtifactCardActions hint={footerHint}>
            {!run && !dismissed && models.length > 0 && (
              <Select
                size="sm"
                inline
                value={modelId}
                onChange={(e) => onModelChange(e.target.value)}
                disabled={launching}
                aria-label={t('cloudAgent.modelLabel')}
                className="flex-shrink-0"
              >
                <option value="">{t('cloudAgent.dispatchDefaultModel')}</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name || m.id}
                  </option>
                ))}
                {modelId && !models.some((m) => m.id === modelId) && <option value={modelId}>{modelId}</option>}
              </Select>
            )}
            {!run && !dismissed && (
              <Button size="sm" variant="ghost" onClick={onDismiss}>
                {t('cloudAgent.dispatchDismiss')}
              </Button>
            )}
            {!run && !dismissed && (
              <Button
                size="sm"
                onClick={onLaunch}
                disabled={launching || !discovered || !sessionId || !!blockedBy}
                title={blockedBy ? t('cloudAgent.dispatchBlockedHint') : undefined}
              >
                {launching && <Spinner className="h-3 w-3" />}
                {launching ? t('cloudAgent.creating') : t('cloudAgent.launch')}
              </Button>
            )}
          </ArtifactCardActions>
        ) : undefined
      }
    >
      <div className="space-y-2.5">
        <div>
          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-fg-faint">
            {t('cloudAgent.promptLabel')}
          </label>
          <div className={`relative overflow-hidden ${promptCollapsed ? 'max-h-44' : ''}`}>
            <Markdown content={artifact.prompt} compact />
            {promptCollapsed && (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-surface-sunken to-transparent" />
            )}
          </div>
          {promptCollapsible && (
            <button
              onClick={() => setPromptExpanded((v) => !v)}
              className="mt-1 flex items-center gap-1 text-[10px] text-fg-muted transition-colors hover:text-fg"
            >
              <ChevronDown size={11} className={`transition-transform ${promptExpanded ? 'rotate-180' : ''}`} />
              {promptExpanded ? t('common.collapse') : t('common.expand')}
            </button>
          )}
        </div>

        {artifact.attachments && artifact.attachments.length > 0 && (
          <div>
            <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-fg-faint">
              {t('cloudAgent.dispatchInputs')}
            </label>
            <div className="flex flex-wrap gap-1.5">
              {artifact.attachments.map((a) => (
                <span
                  key={a.file_id}
                  className="inline-flex max-w-[220px] items-center gap-1.5 rounded-full border border-edge bg-surface-raised px-2.5 py-1 text-xs text-fg-secondary"
                  title={a.name}
                >
                  <FileText size={12} className="flex-shrink-0 text-fg-muted" />
                  <span className="min-w-0 truncate">{a.name}</span>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Outcome of a settled run — the receipt the collapsed bar expands into.
              Its independently persisted outcome message is visually grouped
              under this dispatch turn; this remains the same data on demand. */}
        {settled && run && (
          <div>
            <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-fg-faint">
              {t('cloudAgent.resultLabel')}
            </label>
            {run.error && <p className="mb-1.5 whitespace-pre-wrap break-words text-xs text-danger">{run.error}</p>}
            {run.result_summary?.trim() ? (
              <Markdown content={run.result_summary} compact />
            ) : (
              !run.error && <p className="text-xs text-fg-faint">{t('cloudAgent.resultEmpty')}</p>
            )}
            {artifacts === null ? (
              <div className="mt-1.5 flex items-center gap-2 text-[10px] text-fg-faint">
                <Spinner className="h-3 w-3" />
              </div>
            ) : (
              artifacts.length > 0 && (
                <div className="mt-2">
                  <MissionArtifactsBlock
                    data={artifacts.map((a) => ({
                      id: a.id,
                      run_id: run.id,
                      path: a.path,
                      size_bytes: a.size_bytes,
                      content_type: a.content_type,
                    }))}
                  />
                </div>
              )
            )}
          </div>
        )}
      </div>
    </ArtifactCard>
  );
}
