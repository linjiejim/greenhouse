/**
 * useMissionSession — Cloud Agent run state for ANY conversation that has one.
 *
 * Two paths land here: the `sprouty-mission` preset (the whole conversation is
 * a mission) and the `mission_dispatch` tool launching a run from an ordinary
 * chat. Both bind the run to a session, so the source is the same: the run
 * lineage (GET /runs?session_id=, oldest first) plus that run's incremental
 * event replay (events?after=<lastSeq>).
 *
 * Freshness comes from the server's `mission:run` WS push — the controller
 * emits one on every status transition it wins. Two timers back it up, both at
 * low frequency like use-workflow-run: the event replay keeps the dock moving
 * mid-run, and a bounded lineage poll covers the settle edge, which replay
 * cannot see (see `shouldPollForSettlement`). Step-level content is
 * deliberately NOT pushed over WS (session-modes D7): the event table stays the
 * single replay path, and content-level streaming is the cloud-agent spec's P2.
 *
 * Outcome messages are server-written (integration spec D2) — this hook never
 * persists messages; it only observes runs.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  isCloudAgentRunActive,
  listCloudAgentRunEvents,
  listCloudAgentRunsBySession,
  mergeCloudAgentEvents,
  type CloudAgentEvent,
  type CloudAgentRun,
  type CloudAgentRunStatus,
} from '../../lib/api/cloud-agent';
import { wsClient } from '../../lib/ws';

/** Safety-net poll — WS pushes carry the real-time status updates. */
const FALLBACK_POLL_MS = 15_000;

/**
 * How long to keep asking for the lineage after a run goes terminal without a
 * `settled_at`. Settlement normally lands 2–3s later; this only has to outlast
 * a slow artifact sweep, not a broken server.
 */
const SETTLEMENT_POLL_MS = 5_000;
const SETTLEMENT_POLL_ATTEMPTS = 12;

interface SettlementCursor {
  sessionId: string | null;
  runId: string | null;
}

/** Return the newly-durable run without treating session navigation as settlement. */
export function newlySettledMissionRun(previous: SettlementCursor, current: SettlementCursor): string | null {
  if (previous.sessionId !== current.sessionId || !current.runId || previous.runId === current.runId) return null;
  return current.runId;
}

/**
 * True while the displayed run is terminal but has not reported `settled_at`.
 *
 * The event-replay tick carries `run_status` and nothing else, so it can move a
 * run to terminal but can never surface settlement; and once terminal it stops
 * ticking. Settlement therefore arrives on exactly one channel — the `mission:run`
 * WS push that triggers a lineage refetch — and a socket dropped across that
 * moment used to freeze the dock on the last running frame with the delivered
 * outcome sitting unread in the DB (2026-08-13). Polling the lineage for a
 * bounded window makes the documented reconnect safety net cover the edge it
 * claimed to.
 */
export function shouldPollForSettlement(
  run: { status: CloudAgentRunStatus; settled_at?: string | null } | null,
): boolean {
  if (!run || run.settled_at) return false;
  return !isCloudAgentRunActive(run.status);
}

export interface MissionSessionState {
  /** Full run lineage, used to associate durable outcomes with dispatch cards. */
  runs: CloudAgentRun[];
  /** Latest run of this conversation, whatever its status (the dock row). */
  latestRun: CloudAgentRun | null;
  /** The same run while it is still non-terminal; null once it settles. */
  activeRun: CloudAgentRun | null;
  /** Replayed events of `latestRun` (empty while waiting for the sandbox). */
  events: CloudAgentEvent[];
  /** True once the lineage fetch settled (successfully or not). */
  loaded: boolean;
  /** Adopt a run this client just enqueued, without waiting for the refetch. */
  trackRun: (run: CloudAgentRun) => void;
  /** Re-read the lineage — used after launching a follow-up from the dock. */
  refresh: () => Promise<void>;
}

export function useMissionSession({
  sessionId,
  enabled,
  onRunSettled,
}: {
  sessionId: string | null;
  enabled: boolean;
  /** Fired with the id of the run that just reached a terminal state. */
  onRunSettled: (settledRunId: string) => void;
}): MissionSessionState {
  const [runs, setRuns] = useState<CloudAgentRun[]>([]);
  const [events, setEvents] = useState<CloudAgentEvent[]>([]);
  const [loaded, setLoaded] = useState(false);

  // Keep the settle callback fresh without restarting the effects.
  const onRunSettledRef = useRef(onRunSettled);
  onRunSettledRef.current = onRunSettled;

  const latestRun = useMemo(() => (runs.length > 0 ? runs[runs.length - 1] : null), [runs]);
  const activeRun = latestRun && isCloudAgentRunActive(latestRun.status) ? latestRun : null;

  const refresh = useCallback(async () => {
    if (!enabled || !sessionId) return;
    try {
      const lineage = await listCloudAgentRunsBySession(sessionId);
      // Merge instead of replace: a run enqueued by this client (trackRun) may
      // not be visible to a fetch that raced the POST.
      setRuns((prev) => mergeRuns(prev, lineage));
    } catch {
      // Degraded: no lineage. The server keeps authority either way.
    }
  }, [enabled, sessionId]);

  // ── Lineage: load on entering a conversation ─────────────
  useEffect(() => {
    setRuns([]);
    setEvents([]);
    setLoaded(false);
    if (!enabled || !sessionId) return;
    let disposed = false;
    void (async () => {
      try {
        const lineage = await listCloudAgentRunsBySession(sessionId);
        if (!disposed) setRuns((prev) => mergeRuns(prev, lineage));
      } catch {
        // Degraded: no lineage. Sends still work; the server keeps authority.
      } finally {
        if (!disposed) setLoaded(true);
      }
    })();
    return () => {
      disposed = true;
    };
  }, [enabled, sessionId]);

  // ── Server push: this user's run changed state ───────────
  // A run started in ANOTHER tab (or by the Launch button inside a message
  // card, which cannot reach this hook) shows up through here too.
  useEffect(() => {
    if (!enabled || !sessionId) return;
    return wsClient.onEvent((event) => {
      if (event.type !== 'mission:run') return;
      if (event.sessionId && event.sessionId !== sessionId) return;
      void refresh();
    });
  }, [enabled, sessionId, refresh]);

  // ── Event replay for the displayed run ───────────────────
  const shownRunId = latestRun?.id ?? null;
  const shownActive = !!activeRun;
  useEffect(() => {
    if (!shownRunId) return;
    let disposed = false;
    let inFlight = false;
    let lastSeq = 0;
    setEvents([]);

    const tick = async () => {
      if (inFlight || disposed) return;
      inFlight = true;
      try {
        const res = await listCloudAgentRunEvents(shownRunId, lastSeq);
        if (disposed) return;
        setEvents((prev) => {
          const next = mergeCloudAgentEvents(prev, res.events);
          lastSeq = next.length > 0 ? next[next.length - 1].seq : lastSeq;
          return next;
        });
        // The status can settle between WS pushes (a dropped socket); the
        // replay response carries it, so treat it as authoritative.
        setRuns((prev) => prev.map((r) => (r.id === shownRunId ? { ...r, status: res.run_status } : r)));
      } catch {
        // Transient failure — the next tick retries.
      } finally {
        inFlight = false;
      }
    };

    void tick();
    if (!shownActive) return; // terminal run: one replay, then leave it be
    const timer = window.setInterval(() => void tick(), FALLBACK_POLL_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [shownRunId, shownActive]);

  // ── Settlement safety net: terminal, but no durable cursor yet ──
  // Bounded on purpose. A server that never settles (an outcome that genuinely
  // failed to deliver) is not something the client can fix by asking forever;
  // the boot sweep retries that, and this poll would just spin every 5s for the
  // life of the tab.
  const awaitingSettlement = shouldPollForSettlement(latestRun);
  useEffect(() => {
    if (!awaitingSettlement) return;
    let attempts = 0;
    const timer = window.setInterval(() => {
      attempts += 1;
      if (attempts > SETTLEMENT_POLL_ATTEMPTS) {
        window.clearInterval(timer);
        return;
      }
      void refresh();
    }, SETTLEMENT_POLL_MS);
    return () => window.clearInterval(timer);
  }, [awaitingSettlement, refresh]);

  // ── Settle: durable terminal reconciliation completed ──
  // `status=completed|failed|canceled` is committed and pushed BEFORE artifact
  // recovery + outcome outbox delivery. Reloading on the active→terminal edge
  // races that outbox and can permanently miss the assistant outcome. The
  // controller emits again after `settled_at`, which is the durable boundary.
  const prevSettledRef = useRef<SettlementCursor>({
    sessionId: null,
    runId: null,
  });
  useEffect(() => {
    const prev = prevSettledRef.current;
    const settledRunId = latestRun?.settled_at ? latestRun.id : null;
    prevSettledRef.current = { sessionId, runId: settledRunId };
    // Only a transition WITHIN the same conversation is a settle — entering a
    // different historical session already loads its transcript normally.
    const newlySettled = newlySettledMissionRun(prev, prevSettledRef.current);
    if (newlySettled) onRunSettledRef.current(newlySettled);
  }, [latestRun?.id, latestRun?.settled_at, sessionId]);

  const trackRun = useCallback((run: CloudAgentRun) => {
    setRuns((prev) => mergeRuns(prev, [run]));
    setEvents([]);
  }, []);

  return { runs, latestRun, activeRun, events, loaded, trackRun, refresh };
}

/** Union by id (fresh rows win), ordered oldest-first by created_at. */
function mergeRuns(prev: CloudAgentRun[], incoming: CloudAgentRun[]): CloudAgentRun[] {
  const byId = new Map<string, CloudAgentRun>();
  for (const run of prev) byId.set(run.id, run);
  for (const run of incoming) byId.set(run.id, run);
  return [...byId.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
}
