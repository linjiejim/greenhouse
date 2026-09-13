/**
 * Task routes — /api/prompts
 *
 * GET    /api/prompts          — 当前用户可用的任务列表；scope=mine|shared|team
 * POST   /api/prompts          — 创建任务；聊天卡片可带 action/session id 获取 exactly-once 回执
 * PATCH  /api/prompts/:id      — 更新任务
 * DELETE /api/prompts/:id      — 删除任务
 *
 * 路径保持 `/api/prompts`：用户面改叫 Tasks，但一个没有变量、没有工具的
 * 任务与原来的快捷指令逐字段相同，改路径只会让所有既有客户端一起返工。
 */

import { Hono } from 'hono';
import { getDb } from '@greenhouse/db';
import {
  isTaskVariable,
  parseTaskVariables,
  placeholdersIn,
  TASK_VARIABLE_LIMITS,
  type TaskVariable,
} from '@greenhouse/types/tasks';
import { getAuthUser } from '../auth/middleware.js';
import type { AppEnv } from '../app-env.js';
import { artifactReceiptResult, claimArtifactAction } from '../chat-artifact-actions.js';
import { toErrorMessage } from '@greenhouse/utils/error';
import type { UserPromptRow } from '@greenhouse/db';
import { PROMPT_SCOPES, type PromptScope } from '@greenhouse/types/api';
import { withOwnerNicknames } from '../user-display.js';

/**
 * Validate the variable list against the body it belongs to.
 *
 * The cross-check matters more than the shape check: a declared variable with
 * no `{{placeholder}}` produces a form field that changes nothing, and the
 * user has no way to tell. Extra placeholders are fine — the profile prompt
 * tells the model to ask about anything still unfilled.
 */
function validateVariables(raw: unknown, body: string): { ok: true; json: string } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, json: '[]' };
  if (!Array.isArray(raw)) return { ok: false, error: 'variables must be an array' };
  if (raw.length > TASK_VARIABLE_LIMITS.maxVariables) {
    return { ok: false, error: `at most ${TASK_VARIABLE_LIMITS.maxVariables} variables` };
  }
  const variables: TaskVariable[] = [];
  for (const item of raw) {
    if (!isTaskVariable(item)) return { ok: false, error: `invalid variable: ${JSON.stringify(item).slice(0, 80)}` };
    if (variables.some((v) => v.key === item.key)) return { ok: false, error: `duplicate variable key: ${item.key}` };
    variables.push(item);
  }
  const present = placeholdersIn(body);
  const orphan = variables.find((v) => !present.includes(v.key));
  if (orphan) return { ok: false, error: `variable "${orphan.key}" has no {{${orphan.key}}} in the body` };
  return { ok: true, json: JSON.stringify(variables) };
}

function validateExpectedTools(raw: unknown): { ok: true; json: string } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, json: '[]' };
  if (!Array.isArray(raw) || raw.some((tool) => typeof tool !== 'string')) {
    return { ok: false, error: 'expected_tools must be an array of strings' };
  }
  // Not checked against the tool catalog on purpose: this list is a record of
  // what the captured run used, and a tool retired later should still show as
  // "this task used to need it" rather than blocking the save.
  return { ok: true, json: JSON.stringify([...new Set(raw as string[])].slice(0, 40)) };
}

function parsePromptScope(raw: string | undefined): PromptScope | undefined | null {
  if (raw === undefined) return undefined;
  return (PROMPT_SCOPES as readonly string[]).includes(raw) ? (raw as PromptScope) : null;
}

const prompts = new Hono<AppEnv>()
  /** GET /api/prompts — list available prompts for current user */
  .get('/', async (c) => {
    const user = getAuthUser(c);
    const scope = parsePromptScope(c.req.query('scope'));
    if (scope === null) return c.json({ error: `scope must be one of: ${PROMPT_SCOPES.join(', ')}` }, 400);
    if (scope === 'team' && user.role !== 'super') return c.json({ error: 'Team scope requires super role' }, 403);

    const db = getDb();
    const list = scope ? await db.userPrompts.listForScope(user.id, scope) : await db.userPrompts.listForUser(user.id);
    return c.json({ prompts: await withOwnerNicknames(db, list, user.id) });
  })
  /** POST /api/prompts — create a new prompt */
  .post('/', async (c) => {
    const user = getAuthUser(c);

    const body = (await c.req.json()) as {
      title?: string;
      content?: string;
      shortcut?: string;
      sort_order?: number;
      is_global?: boolean;
      description?: string;
      variables?: unknown;
      expected_tools?: unknown;
      source_session_id?: string;
      created_via?: string;
      artifact_action_id?: string;
      artifact_session_id?: string;
    };

    if (!body.title?.trim() || !body.content?.trim()) {
      return c.json({ error: 'title and content are required' }, 400);
    }

    // Only super can create global prompts
    if (body.is_global && user.role !== 'super') {
      return c.json({ error: 'Only super users can create global prompts' }, 403);
    }

    const content = body.content.trim();
    const variables = validateVariables(body.variables, content);
    if (!variables.ok) return c.json({ error: variables.error }, 400);
    const tools = validateExpectedTools(body.expected_tools);
    if (!tools.ok) return c.json({ error: tools.error }, 400);

    const captured = body.created_via === 'capture';
    const hasArtifactAction = !!body.artifact_action_id;
    const hasArtifactSession = !!body.artifact_session_id;
    if (hasArtifactAction !== hasArtifactSession) {
      return c.json({ error: 'artifact_action_id and artifact_session_id must be provided together' }, 400);
    }
    const withArtifactReceipt = captured && hasArtifactAction && hasArtifactSession;
    const normalized = {
      title: body.title.trim(),
      content,
      description: body.description?.trim() || null,
      variables: variables.json,
      expected_tools: tools.json,
      source_session_id: body.source_session_id ?? null,
    };
    if (withArtifactReceipt) {
      const claim = await claimArtifactAction({
        actionId: body.artifact_action_id!,
        sessionId: body.artifact_session_id!,
        user,
        kind: 'task_capture',
        payload: normalized,
      });
      if (!claim.ok) return c.json({ error: claim.error }, claim.status);
      if (!claim.claimed) {
        const prior = artifactReceiptResult<UserPromptRow>(claim.receipt);
        if (prior) return c.json(prior);
        const recovered = await getDb().userPrompts.getByArtifactActionId(body.artifact_action_id!);
        if (recovered?.user_id === user.id) {
          await getDb().chatArtifactReceipts.succeed(body.artifact_action_id!, user.id, recovered);
          return c.json(recovered);
        }
        return c.json(
          {
            error: claim.receipt.error ?? 'This Task capture is already being processed; refresh to check its receipt',
          },
          409,
        );
      }
    }

    try {
      const prompt = await getDb().userPrompts.create({
        user_id: user.id,
        title: normalized.title,
        content: normalized.content,
        shortcut: body.shortcut?.trim() || undefined,
        sort_order: body.sort_order,
        is_global: body.is_global,
        description: normalized.description,
        variables: normalized.variables,
        expected_tools: normalized.expected_tools,
        source_session_id: normalized.source_session_id,
        artifact_action_id: withArtifactReceipt ? body.artifact_action_id : null,
        created_via: captured ? 'capture' : 'manual',
      });
      if (withArtifactReceipt && body.artifact_action_id) {
        await getDb().chatArtifactReceipts.succeed(body.artifact_action_id, user.id, prompt);
      }
      return c.json(prompt, 201);
    } catch (error) {
      if (withArtifactReceipt && body.artifact_action_id) {
        const recovered = await getDb().userPrompts.getByArtifactActionId(body.artifact_action_id);
        if (recovered?.user_id === user.id) {
          await getDb().chatArtifactReceipts.succeed(body.artifact_action_id, user.id, recovered);
          return c.json(recovered);
        }
        await getDb().chatArtifactReceipts.fail(body.artifact_action_id, user.id, toErrorMessage(error));
      }
      throw error;
    }
  })
  /** PATCH /api/prompts/:id — update a prompt */
  .patch('/:id', async (c) => {
    const user = getAuthUser(c);

    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);

    const existing = await getDb().userPrompts.getById(id);
    if (!existing) return c.json({ error: 'Prompt not found' }, 404);

    // Owner can edit own; super can edit any (including global)
    if (existing.user_id !== user.id && user.role !== 'super') {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const body = (await c.req.json()) as {
      title?: string;
      content?: string;
      shortcut?: string | null;
      sort_order?: number;
      is_global?: boolean;
      description?: string | null;
      variables?: unknown;
      expected_tools?: unknown;
    };

    // Only super can set is_global
    if (body.is_global !== undefined && user.role !== 'super') {
      return c.json({ error: 'Only super users can set global flag' }, 403);
    }

    const updates: Record<string, unknown> = {};
    if (body.title !== undefined) updates.title = body.title.trim();
    if (body.content !== undefined) updates.content = body.content.trim();
    if (body.shortcut !== undefined) updates.shortcut = body.shortcut?.trim() || null;
    if (body.sort_order !== undefined) updates.sort_order = body.sort_order;
    if (body.is_global !== undefined) updates.is_global = body.is_global;
    if (body.description !== undefined) updates.description = body.description?.trim() || null;
    if (body.variables !== undefined) {
      // Validated against the body being saved, or the stored one when the
      // caller is only touching variables — otherwise a rename of a
      // placeholder and its variable in two requests can never both pass.
      const variables = validateVariables(body.variables, (updates.content as string) ?? existing.content);
      if (!variables.ok) return c.json({ error: variables.error }, 400);
      updates.variables = variables.json;
    } else if (body.content !== undefined) {
      // A content-only edit must not orphan the STORED variables either — this
      // is the same forbidden case validateVariables guards on create (a form
      // field whose value substitutes into nothing), it just used to slip past
      // because nobody re-checked the list the caller didn't send.
      const stored = parseTaskVariables(existing.variables);
      const present = placeholdersIn(updates.content as string);
      const orphan = stored.find((v) => !present.includes(v.key));
      if (orphan) {
        return c.json(
          {
            error: `variable "${orphan.key}" has no {{${orphan.key}}} in the new body — keep the placeholder, or send "variables" with the content change to remove or rename it`,
          },
          400,
        );
      }
    }
    if (body.expected_tools !== undefined) {
      const tools = validateExpectedTools(body.expected_tools);
      if (!tools.ok) return c.json({ error: tools.error }, 400);
      updates.expected_tools = tools.json;
    }

    const updated = await getDb().userPrompts.update(id, updates);
    if (!updated) return c.json({ error: 'Prompt not found' }, 404);
    return c.json(updated);
  })
  /** DELETE /api/prompts/:id — delete a prompt */
  .delete('/:id', async (c) => {
    const user = getAuthUser(c);

    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);

    const existing = await getDb().userPrompts.getById(id);
    if (!existing) return c.json({ error: 'Prompt not found' }, 404);

    // Owner can delete own; super can delete any
    if (existing.user_id !== user.id && user.role !== 'super') {
      return c.json({ error: 'Forbidden' }, 403);
    }

    await getDb().userPrompts.delete(id);
    return c.json({ ok: true });
  });

export default prompts;
