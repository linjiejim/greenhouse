/** Saved prompt instructions stay in core; plugin prompts come from agentContext. */
import type { DatabaseProvider, UserPromptRow } from '@greenhouse/db';
import type { TaskVariable } from '@greenhouse/types/tasks';
import { toRowId } from '@greenhouse/utils/id';
import { delegatedAgentActor } from '../plugin-host/actor.js';
import { listAgentPrompts, getAgentPrompt } from '../plugin-host/agent-context.js';
export interface TeamPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface TeamPromptDescriptor {
  name: string;
  title: string;
  description: string;
  arguments: TeamPromptArgument[];
}

export interface TeamPromptMessage {
  role: 'user';
  content: { type: 'text'; text: string };
}

export interface TeamPrompt {
  description: string;
  messages: TeamPromptMessage[];
}

const PROMPT_PREFIX = 'prompt-';
const PLACEHOLDER_RE = /\{\{\s*([A-Za-z_][\w-]*)\s*\}\}/g;
export function promptsReachable(reachable: ReadonlySet<string>): boolean {
  return reachable.has('session_query');
}
function taskArguments(row: UserPromptRow): TeamPromptArgument[] {
  const variables = row.variables as TaskVariable[];
  return (Array.isArray(variables) ? variables : [])
    .filter((variable) => variable && typeof variable.key === 'string')
    .map((variable) => ({
      name: variable.key,
      description: [variable.label, variable.description, variable.example ? `e.g. ${variable.example}` : '']
        .filter(Boolean)
        .join(' — '),
      ...(variable.required ? { required: true } : {}),
    }));
}

/** Replace filled placeholders; unfilled ones stay as `{{key}}` for the agent to ask about. */
export function fillPlaceholders(text: string, args: Readonly<Record<string, string>>): string {
  return text.replace(PLACEHOLDER_RE, (whole, key: string) => {
    const value = args[key];
    return typeof value === 'string' && value.length > 0 ? value : whole;
  });
}

type Actor = { userId: string; role: string };
function caller(db: DatabaseProvider, actor: Actor, reachable: ReadonlySet<string>) {
  return { db, ...actor, reachable, actor: delegatedAgentActor({ userId: actor.userId }) };
}
export async function listSavedPrompts(db: DatabaseProvider, actor: Actor): Promise<TeamPromptDescriptor[]> {
  const tasks = await db.userPrompts.listForUser(actor.userId);
  return tasks.map((row) => ({
    name: `${PROMPT_PREFIX}${row.id}`,
    title: row.title,
    description: row.description?.trim() || `Saved prompt "${row.title}"`,
    arguments: taskArguments(row),
  }));
}
export async function getSavedPrompt(
  db: DatabaseProvider,
  actor: Actor,
  name: string,
  args: Readonly<Record<string, string>>,
): Promise<TeamPrompt | null> {
  if (!name.startsWith(PROMPT_PREFIX)) return null;
  const id = toRowId(name.slice(PROMPT_PREFIX.length));
  if (!id) return null;
  const row = await db.userPrompts.getById(id);
  if (!row || (row.user_id !== actor.userId && !row.is_global)) return null;
  return {
    description: row.description?.trim() || row.title,
    messages: [{ role: 'user', content: { type: 'text', text: fillPlaceholders(row.content, args) } }],
  };
}
export async function listTeamPrompts(
  db: DatabaseProvider,
  actor: Actor,
  reachable: ReadonlySet<string>,
): Promise<TeamPromptDescriptor[]> {
  const contributed = await listAgentPrompts(caller(db, actor, reachable));
  const saved = promptsReachable(reachable) ? await listSavedPrompts(db, actor) : [];
  return [...new Map([...contributed, ...saved].map((prompt) => [prompt.name, prompt])).values()];
}
export async function getTeamPrompt(
  db: DatabaseProvider,
  actor: Actor,
  reachable: ReadonlySet<string>,
  name: string,
  args: Readonly<Record<string, string>>,
): Promise<TeamPrompt | null> {
  const contributed = await getAgentPrompt(caller(db, actor, reachable), name, args);
  return contributed ?? (promptsReachable(reachable) ? getSavedPrompt(db, actor, name, args) : null);
}
