/**
 * Projects API — typed RPC for the project calls that moved off raw authFetch.
 * (The project pages still read and write tasks through `authFetch`; new calls
 * start here.)
 */

import { rpc } from './client';

/** A failed project call: the HTTP status (403 = Agents are off for this account, 404 = not found / not yours). */
export class ProjectsApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ProjectsApiError';
    this.status = status;
  }
}

export interface HandToAgentResult {
  /** The task chat the Agent works in (`#/bots?c=<id>`), its first message the task. */
  session_id: string;
  task: { id: number; agent_id: string | null; agent_session_id: string | null };
}

/**
 * Hand a project task to one of the member's Agents (spec 20261011-agent-first-class P3e): the
 * server opens a task chat answered by that Agent with the task as its first message, and records
 * the Agent and chat on the task. The assignee stays the person responsible.
 */
export async function handTaskToAgent(taskId: number, botId: string): Promise<HandToAgentResult> {
  const args = { param: { taskId: String(taskId) }, json: { bot_id: botId } };
  const res = await rpc.api.projects.tasks[':taskId'].agent.$post(args);
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null);
    const message =
      body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
        ? body.error
        : `Request failed (${res.status})`;
    throw new ProjectsApiError(message, res.status);
  }
  const data = await res.json();
  return {
    session_id: data.session_id,
    task: { id: data.task.id, agent_id: data.task.agent_id, agent_session_id: data.task.agent_session_id },
  };
}
