/**
 * Which of the member's Agents is acting right now (spec 20261011-agent-first-class P3b).
 *
 * An Agent turn (the Agents engine, a background task, a Chat / scheduled / Feishu turn that runs
 * as an Agent) runs inside `runInAgentScope`; everything it calls — tool executions, platform
 * actions, provider attempts — inherits the scope through async context, so the platform actor
 * (`delegatedAgentActor`) and the usage record name the Agent and the conversation without every
 * tool factory threading them through.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface AgentScope {
  /** The member's Agent (`bots.id`). */
  botId: string;
  /** The conversation it acts in (`sessions.id`), when there is one. */
  sessionId: string | null;
}

const storage = new AsyncLocalStorage<AgentScope>();

export function runInAgentScope<T>(scope: AgentScope, fn: () => T): T {
  return storage.run(scope, fn);
}

/** The Agent acting in this async context, if any. */
export function currentAgentScope(): AgentScope | undefined {
  return storage.getStore();
}
