/**
 * Shared run-state hook for the workflow card and the run dock.
 *
 * Source is either an explicit `runId` (the plan card, which discovers its run
 * from the workflow) or a `sessionId` (the dock, which asks "does this chat
 * have a run?").
 *
 * Freshness comes from the server's `workflow:progress` WS push — the engine
 * emits one on every node/run transition. The timer is only a reconnect safety
 * net (a dropped socket would otherwise freeze the UI mid-run), so it runs at a
 * low frequency and stops the moment the run is terminal.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkflowRunView } from '@greenhouse/types/workflow';
import * as api from '../../lib/api';
import { wsClient } from '../../lib/ws';
import { ACTIVE_RUN_STATUSES } from '../../lib/workflow-constants';

/** Safety-net poll — WS pushes carry the real-time updates. */
const FALLBACK_POLL_MS = 15_000;

/** How recently a run must have finished to count as "settled while I watched". */
const RECENT_TERMINAL_MS = 60_000;

export interface WorkflowRunSource {
  runId?: string | null;
  sessionId?: string | null;
  /** False for users outside the current super-only workflow rollout. */
  enabled?: boolean;
  /**
   * Fired once when a run this hook was watching reaches a terminal state.
   * The engine writes the outcome assistant message beside that same
   * transition, so the caller reloads the transcript to show it — without
   * this, a delivery that landed while the conversation was open only
   * appeared after a manual refresh.
   */
  onSettled?: () => void;
}

export function useWorkflowRun({ runId, sessionId, enabled = true, onSettled }: WorkflowRunSource): {
  run: WorkflowRunView | null;
  refresh: () => Promise<void>;
} {
  const [run, setRun] = useState<WorkflowRunView | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Read inside the WS handler without re-subscribing on every state change.
  const runIdRef = useRef<string | null>(null);
  runIdRef.current = run?.id ?? runId ?? null;

  const refresh = useCallback(async () => {
    if (!enabled) return;
    if (runId) {
      const view = await api.getWorkflowRun(runId);
      if (view) setRun(view);
      return;
    }
    if (sessionId) {
      setRun(await api.getLatestRunForSession(sessionId));
    }
  }, [enabled, runId, sessionId]);

  // Reset immediately when the source changes so a stale run never bleeds
  // across sessions while the first fetch is in flight.
  useEffect(() => {
    setRun(null);
  }, [enabled, runId, sessionId]);

  useEffect(() => {
    if (!enabled || (!runId && !sessionId)) return;
    void refresh();
    timerRef.current = setInterval(() => void refresh(), FALLBACK_POLL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, [enabled, runId, sessionId, refresh]);

  // Server push: refresh on this run's progress, or on any progress while we
  // still have no run (a run may have just started in this session).
  useEffect(() => {
    if (!enabled || (!runId && !sessionId)) return;
    return wsClient.onEvent((event) => {
      if (event.type !== 'workflow:progress') return;
      if (runIdRef.current && event.runId !== runIdRef.current) return;
      void refresh();
    });
  }, [enabled, runId, sessionId, refresh]);

  // Terminal run → stop the safety net (the dock stays mounted showing results)
  // and tell the caller once, so it can pick up the outcome message.
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;
  const wasActiveRef = useRef(false);
  const reportedRunIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!run) return;
    const active = ACTIVE_RUN_STATUSES.has(run.status);
    if (!active && timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    // "Saw it running" is not enough on its own: a short run can start AND
    // finish between two observations, so the client only ever sees it
    // terminal — that is exactly a run the open conversation must reload for.
    // A run that finished long ago needs no reload; its outcome message
    // already came with the transcript.
    const justFinished =
      !!run.finished_at &&
      Date.now() - Date.parse(run.finished_at) < RECENT_TERMINAL_MS &&
      !Number.isNaN(Date.parse(run.finished_at));
    if (!active && reportedRunIdRef.current !== run.id && (wasActiveRef.current || justFinished)) {
      reportedRunIdRef.current = run.id;
      onSettledRef.current?.();
    }
    wasActiveRef.current = active;
  }, [run]);

  return { run, refresh };
}
