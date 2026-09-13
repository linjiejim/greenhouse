/**
 * Mission Dispatch tool — the model drafts a Sandbox Runner task in chat.
 *
 * Session-scoped and DRAFT-ONLY, exactly like `workflow_plan`: it creates NO
 * run and writes NO table. It validates the brief and returns a
 * `mission_dispatch` artifact the web renders as a task card; the run starts
 * only when the user presses Launch on that card (POST /api/missions/runs).
 *
 * The confirm gate is not ceremony. A mission occupies the user's single
 * concurrent sandbox slot for up to a couple of hours of wall budget, so a
 * misrouted dispatch is expensive in a way an ordinary tool call is not — the
 * model's autonomy stops at drafting (session-modes spec D2).
 */

import { tool } from 'ai';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { toErrorMessage } from '@greenhouse/utils/error';
import type { DatabaseProvider } from '@greenhouse/db';
import { getModelEntry } from '@greenhouse/agent-core';
import { isMissionEnabled } from '../cloud-agent/config.js';
import { getMissionRuntimeStatus } from '../cloud-agent/index.js';
import { isSlashSelectableSkill } from '../skills/mission-ready.js';
import { defineTool, type ToolMeta } from './define.js';

/** Mirrors the route's MAX_PROMPT_BYTES so the card can never be launch-rejected. */
const MAX_PROMPT_BYTES = 32 * 1024;
/** Mirrors MAX_ATTACHMENTS_PER_RUN on the cloud-agent route. */
const MAX_ATTACHMENTS = 10;

const meta: ToolMeta = {
  id: 'mission_dispatch',
  name: 'Mission Dispatch',
  brief: 'Draft a cloud sandbox task (Mission) for the user to launch',
  description: `Draft a Mission: a long-running task executed by an agent inside a disposable cloud sandbox with a file system, a shell and a persistent workspace.

WHEN TO USE — only when ALL of these hold:
- the work needs to run for many minutes (or an hour+) and produce FILES — a written report, a converted dataset, a repo change, a generated document;
- it needs a real file system / shell rather than the tools you already have here;
- the user has agreed to run it in the sandbox (they asked for it, or accepted your offer).
Otherwise answer here — a mission takes the user's single concurrent sandbox slot for hours.

WHAT IT DOES: returns a task card. NOTHING starts until the user presses Launch — never say the mission is running or report results in the same turn.

PROMPT: write the complete task brief for the sandbox agent, self-contained. It cannot see this conversation. Include the goal, the inputs and where they come from, the expected deliverable files (names and formats), and the constraints. Write it in the user's language. Also pass a short \`title\` for the task card. Hard limit 32 KB — it is instructions, not a payload.

SKILL: if a Skill Center skill covers this task, pass its name as \`skill\` (find them with \`skill_query\`) — the sandbox mounts it and reads its SKILL.md itself. NEVER copy a skill's steps into the prompt. With \`skill\` set the prompt is optional: give only what the skill cannot know, such as which file to work on.

ATTACHMENTS: if the task needs files the user attached here — including ones \`read_attachment\` refused — pass their ids in \`attachment_ids\`; they land under \`./inputs/<name>\`, so refer to them by that path. The sandbox receives NO file it was not handed, so a prompt mentioning \`./inputs/\` with no \`attachment_ids\` is rejected.`,
  category: 'team',
  is_global: false,
  icon: 'Cloud',
  sort_order: 34,
  presentation: 'artifact',
};

const dispatchSchema = z.object({
  prompt: z
    .string()
    .max(MAX_PROMPT_BYTES)
    .describe('The complete, self-contained task brief handed to the sandbox agent. Optional when `skill` is set.'),
  skill: z
    .string()
    .optional()
    .describe(
      'Name of a Skill Center skill to run. Reference it by name — never paste its instructions into `prompt`.',
    ),
  title: z
    .string()
    .max(120)
    .optional()
    .describe('Short human-readable task title shown on the card and the task dock.'),
  model: z
    .string()
    .optional()
    .describe('Optional model registry id. Omit to use the deployment default — prefer omitting.'),
  attachment_ids: z
    .array(z.string())
    .max(MAX_ATTACHMENTS)
    .optional()
    .describe(
      'Ids of files ALREADY attached to this conversation that the task needs. They are placed in the sandbox under ./inputs/.',
    ),
});

type DispatchInput = z.infer<typeof dispatchSchema>;

/** Artifact payload consumed by the web MissionDispatchCard. */
export interface MissionDispatchArtifact {
  type: 'mission_dispatch';
  /** Stable client→run idempotency key; creating the card itself still writes no DB row. */
  dispatch_id: string;
  prompt: string;
  /** Short display title; the run row and dock fall back to the first prompt line without it. */
  title?: string;
  /** Mission-ready skill the sandbox will mount and follow; re-validated at Launch. */
  skill?: { name: string; display_name: string };
  model?: string;
  /**
   * The workspace of this conversation's previous mission, if any. Launching
   * with it reuses the same working directory and Pi session, so the sandbox
   * agent keeps the earlier rounds' files and context.
   */
  workspace_id?: number;
  /**
   * Conversation attachments to place in the sandbox's `./inputs/`. Resolved
   * server-side from ids the model supplied, so the card can only ever show
   * files that really belong to this conversation.
   */
  attachments?: Array<{ file_id: string; name: string }>;
}

export interface MissionDispatchContext {
  userId: string;
  sessionId: string;
}

export function createMissionDispatchTool(db: DatabaseProvider, ctx: MissionDispatchContext) {
  return tool({
    description: meta.description,
    inputSchema: dispatchSchema,
    execute: async (input: DispatchInput) => {
      try {
        // Fail loudly rather than handing the user a card whose Launch 503s.
        if (!isMissionEnabled() || getMissionRuntimeStatus().state !== 'ready') {
          return { error: 'Missions are not available in this environment' };
        }
        const prompt = input.prompt?.trim() ?? '';

        // Validated here so the card cannot promise a skill Launch will reject —
        // which means using the SAME predicate Launch does. `isMissionReadySkill`
        // is wider (it answers "may the sandbox mount this"), and drafting
        // against it would hand the user a card guaranteed to fail, defeating the
        // only reason this parameter is validated at all.
        //
        // This is still not the security boundary: POST /runs re-checks, because
        // a skill can be quarantined between drafting and Launch.
        let skill: { name: string; display_name: string } | undefined;
        if (input.skill?.trim()) {
          const wanted = input.skill.trim();
          const row = await db.skills.getByName(wanted);
          if (!row || !isSlashSelectableSkill(row)) {
            return {
              error: `skill "${wanted}" is not available for missions — use skill_query action "find" to list the skills that are, or drop the skill and write the steps into the prompt`,
            };
          }
          skill = { name: row.name, display_name: row.display_name };
        }

        if (!prompt && !skill) return { error: 'prompt is required (or name a skill to run)' };
        if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) {
          return {
            error: `prompt exceeds ${MAX_PROMPT_BYTES} bytes — keep the prompt to instructions and pass bulk material (documents, data, long excerpts) as attachment_ids instead of pasting it in. If you are reproducing a skill's steps, pass the skill name as "skill" instead and let the sandbox read it`,
          };
        }
        if (input.model && !getModelEntry(input.model)) {
          return { error: `unknown model: ${input.model} (omit it to use the deployment default)` };
        }

        // Follow-ups continue in the same workspace — the conversation's own
        // lineage decides that, never the model.
        const lineage = await db.agentRuns.listRunsBySession(ctx.sessionId);
        const mine = lineage.filter((r) => r.user_id === ctx.userId);
        const workspaceId = mine.at(-1)?.workspace_id;

        // Resolve the model's ids against THIS conversation — an id it copied
        // from elsewhere (or invented) must not put someone else's file into a
        // sandbox. Unresolvable ids are reported, not silently dropped.
        let attachments: Array<{ file_id: string; name: string }> = [];
        if (input.attachment_ids?.length) {
          const rows = await db.chatFiles.listBySessionAndIds(ctx.sessionId, input.attachment_ids);
          const missing = input.attachment_ids.filter((id) => !rows.some((r) => r.id === id));
          if (missing.length > 0) {
            return { error: `no such attachment in this conversation: ${missing.join(', ')}` };
          }
          attachments = rows.map((r) => ({ file_id: r.id, name: r.name }));
        }

        // A prompt promising mounted inputs with nothing attached ships a doomed
        // card: the sandbox agent spends its budget hunting for a file that was
        // never materialized (observed 2026-08-03 — a 5-minute run of `find /`).
        // Reject with the conversation's real files so the retry can self-heal.
        if (attachments.length === 0 && /\binputs\//i.test(prompt)) {
          const available = await db.chatFiles.listBySession(ctx.sessionId);
          const listing = available.map((f) => `${f.id} (${f.name})`).join(', ');
          return {
            error:
              available.length > 0
                ? `the prompt references ./inputs/ but attachment_ids is empty — the sandbox only receives files listed there. Files in this conversation: ${listing}`
                : 'the prompt references ./inputs/ but this conversation has no attached files — rewrite the prompt without assuming mounted inputs',
          };
        }

        const artifact: MissionDispatchArtifact = {
          type: 'mission_dispatch',
          dispatch_id: `cad_${randomBytes(8).toString('hex')}`,
          prompt,
          ...(input.title?.trim() ? { title: input.title.trim() } : {}),
          ...(skill ? { skill } : {}),
          ...(input.model ? { model: input.model } : {}),
          ...(workspaceId !== undefined ? { workspace_id: workspaceId } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
        };
        return artifact;
      } catch (err) {
        return { error: toErrorMessage(err) };
      }
    },
  });
}

export const missionDispatchTool = defineTool({ meta, kind: 'lazy' });
