/**
 * Engine dependency contracts — structural, so tests run on an in-memory fake
 * (see __tests__/fake-db.ts) and production wires the real DatabaseProvider,
 * profile loader and tool resolution without the engine importing them.
 */

import type { ModelConfig } from '@greenhouse/agent-core';
import type { WorkflowService } from '@greenhouse/db';
import type { ToolRegistry } from '../agent.js';

export type { WorkflowNode, WorkflowGraph } from '@greenhouse/types/workflow';

/** The run-row fields the engine actually reads (structural on purpose). */
export interface WorkflowRunRow {
  id: string;
  workflow_id: number;
  workflow_version: number;
  user_id: string;
  status: string;
  task_input: string;
  /** Graph frozen at confirm time; null for runs predating the snapshot column. */
  graph?: string | null;
  budget: string;
  total: number;
  completed: number;
  tokens_used: number;
}

/** Minimal profile surface a node execution needs. */
export interface EngineProfile {
  id: string;
  model: ModelConfig;
  system_prompt: string;
  max_steps?: number;
}

export type EngineProfileResolver = (profileId: string) => Promise<EngineProfile>;

export type EngineToolAssembler = (args: {
  sessionId: string;
  profile: EngineProfile;
  userId: string;
  allowMutations: boolean;
  /** Durable parent Run for nested Subagent lineage, when already mirrored. */
  runtimeRunId?: string | null;
}) => Promise<ToolRegistry | undefined>;

/** The db slice the engine touches: the workflow service + a session subset. */
export interface EngineDb {
  workflows: WorkflowService;
  sessions: {
    create(
      title?: string,
      profileId?: string,
      userId?: string,
      appId?: string,
      channel?: string,
      parentSessionId?: string,
    ): Promise<{ id: string }>;
    addMessage(input: { session_id: string; role: 'user' | 'assistant'; content: string }): Promise<unknown>;
    touch(id: string): Promise<unknown>;
  };
}

/** Progress events pushed to the owning user over WS (fire-and-forget). */
export interface EngineEmitter {
  (event: {
    type: 'workflow:progress';
    runId: string;
    runStatus: string;
    nodeId?: string;
    nodeStatus?: string;
    userId: string;
  }): void;
}
