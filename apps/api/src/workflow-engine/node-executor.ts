/**
 * Node executor — one node attempt, end to end.
 *
 * Owns the attempt's row lifecycle (create → running → terminal) and its
 * execution session (channel='workflow'): the brief goes in as the user turn,
 * the agent runs via the shared runAgentInSession loop, and the final fenced
 * JSON is parsed + type-checked against the node's simplified output schema
 * (one tool-less repair retry before failing). The reviewer (clean-context
 * verification) also lives here: it sees ONLY the brief + outputs, never the
 * producer's session — fresh reasoning catches what shared context can't.
 */

import { toErrorMessage } from '@greenhouse/utils/error';
import { WORKFLOW_NODE_POLICY_DEFAULTS } from '@greenhouse/types/workflow';
import { runAgentInSession, SessionTranscriptChangedError, type AgentGenerate } from '../agent-runtime/run-agent.js';
import type { EngineDb, EngineProfileResolver, EngineToolAssembler, WorkflowNode, WorkflowRunRow } from './deps.js';

export interface ExecuteNodeDeps {
  db: EngineDb;
  resolveProfile: EngineProfileResolver;
  assembleTools: EngineToolAssembler;
  /** Test seam; defaults to the real generateText loop inside runAgentInSession. */
  generate?: AgentGenerate;
  /** Production passes enrichSystemPrompt; defaults to the raw profile prompt. */
  enrichSystem?: (profile: { system_prompt: string }) => string;
  /**
   * The run owner's memory index. Production passes resolveMemoryContext; when
   * absent a node simply runs without memory.
   *
   * Producing nodes get it, the reviewer deliberately does not: the reviewer runs
   * with `toolChoice:'none'`, so the index's "call memory(recall…)" pointer would
   * be a button it cannot press.
   */
  resolveUserContext?: (userId: string) => Promise<string | null>;
}

export interface ExecuteNodeArgs {
  run: WorkflowRunRow;
  node: WorkflowNode;
  attempt: number;
  resolvedInputs: Record<string, unknown>;
  /** The orchestrating chat session (workflows.created_from_session_id). */
  parentSessionId: string | null;
  /** Reviewer / human feedback when re-running a returned node. */
  feedback?: string;
  /** Reuse a pre-created row (before-gate release, escalation retry). */
  existingRowId?: number;
  abortSignal?: AbortSignal;
  /** Only the deliverable node gets mutation tools. */
  allowMutations?: boolean;
  /** Durable workflow envelope used as parent lineage for spawn_session. */
  runtimeRunId?: string | null;
}

export interface ExecuteNodeResult {
  rowId: number;
  status: 'passed' | 'failed';
  outputs: Record<string, unknown> | null;
  error: string | null;
  tokens: number;
  sessionId: string | null;
}

export async function executeNode(deps: ExecuteNodeDeps, args: ExecuteNodeArgs): Promise<ExecuteNodeResult> {
  const { db } = deps;
  const { run, node, attempt } = args;
  const policy = { ...WORKFLOW_NODE_POLICY_DEFAULTS, ...(node.policy ?? {}) };
  const startedAt = new Date().toISOString();
  const startTime = Date.now();

  const row =
    args.existingRowId != null
      ? await db.workflows.getNodeRun(args.existingRowId)
      : await db.workflows.createNodeRun({
          run_id: run.id,
          node_id: node.id,
          attempt,
          inputs: JSON.stringify(args.resolvedInputs),
        });
  if (!row) throw new Error(`workflow node run row not found (${args.existingRowId})`);
  const rowId = row.id;

  const fail = async (error: string, sessionId: string | null, tokens: number): Promise<ExecuteNodeResult> => {
    await db.workflows.updateNodeRun(rowId, {
      status: 'failed',
      error,
      tokens,
      duration_ms: Date.now() - startTime,
      finished_at: new Date().toISOString(),
    });
    return { rowId, status: 'failed', outputs: null, error, tokens, sessionId };
  };

  let sessionId: string | null = null;
  let tokens = 0;
  try {
    const profile = await deps.resolveProfile(node.agent);
    const session = await db.sessions.create(
      `[workflow] ${node.id} #${attempt}`,
      profile.id,
      run.user_id,
      undefined,
      'workflow',
      args.parentSessionId ?? undefined,
    );
    sessionId = session.id;
    await db.workflows.updateNodeRun(rowId, {
      status: 'running',
      session_id: sessionId,
      inputs: JSON.stringify(args.resolvedInputs),
      started_at: startedAt,
    });

    const baseSystem = deps.enrichSystem ? deps.enrichSystem(profile) : profile.system_prompt;
    // Owner memory sits between the profile identity and this node's brief, so
    // the node-specific requirement stays the last (most salient) instruction.
    const userContext = deps.resolveUserContext ? await deps.resolveUserContext(run.user_id) : null;
    const withContext = userContext ? `${baseSystem}\n\n## User Context\n${userContext}` : baseSystem;
    const system = node.role_addendum ? `${withContext}\n\n## 本节点附加要求\n${node.role_addendum}` : withContext;
    const tools = await deps.assembleTools({
      sessionId,
      profile,
      userId: run.user_id,
      allowMutations: args.allowMutations ?? false,
      runtimeRunId: args.runtimeRunId ?? null,
    });

    const timeoutSignal = AbortSignal.timeout(policy.timeout_ms);
    const signal = args.abortSignal ? AbortSignal.any([timeoutSignal, args.abortSignal]) : timeoutSignal;

    const prompt = buildNodePrompt(node, args.resolvedInputs, args.feedback);
    await db.sessions.addMessage({ session_id: sessionId, role: 'user', content: prompt });

    const runTurn = (turnPrompt: string) =>
      runAgentInSession({
        db: db as never,
        sessionId: sessionId!,
        system,
        prompt: turnPrompt,
        modelConfig: profile.model,
        tools,
        maxSteps: policy.max_steps ?? profile.max_steps ?? 20,
        abortSignal: signal,
        generate: deps.generate,
        usageContext: { profileId: profile.id, userId: run.user_id, caller: 'workflow' },
      });

    let result = await runTurn(prompt);
    tokens += (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0);

    let { outputs, problems } = extractOutputs(result.text, node);
    if (problems.length > 0) {
      // One tool-less repair pass: ask for the JSON again, nothing else.
      const repairPrompt = buildRepairPrompt(node, problems);
      await db.sessions.addMessage({ session_id: sessionId, role: 'user', content: repairPrompt });
      result = await runTurn(repairPrompt);
      tokens += (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0);
      ({ outputs, problems } = extractOutputs(result.text, node));
    }
    if (problems.length > 0 || outputs === null) {
      return await fail(`output failed schema check: ${problems.join('; ') || 'no JSON output'}`, sessionId, tokens);
    }

    await db.workflows.updateNodeRun(rowId, {
      status: 'passed',
      outputs: JSON.stringify(outputs),
      tokens,
      duration_ms: Date.now() - startTime,
      finished_at: new Date().toISOString(),
    });
    return { rowId, status: 'passed', outputs, error: null, tokens, sessionId };
  } catch (err) {
    const message = toErrorMessage(err);
    if (sessionId && !(err instanceof SessionTranscriptChangedError)) {
      // Never leave a blank node session — persist the failure notice.
      await db.sessions
        .addMessage({ session_id: sessionId, role: 'assistant', content: `节点执行失败：${message}` })
        .catch(() => {});
    }
    return await fail(message, sessionId, tokens);
  }
}

// ─── Reviewer (clean-context verification) ───────────────

export interface ReviewNodeArgs {
  run: WorkflowRunRow;
  node: WorkflowNode;
  outputs: Record<string, unknown>;
  criteria?: string;
  agent?: string;
  /** The orchestrating chat session — gives the review session a back link too. */
  parentSessionId?: string | null;
  abortSignal?: AbortSignal;
}

export interface ReviewNodeResult {
  pass: boolean;
  feedback?: string;
  tokens?: number;
}

export async function reviewNode(deps: ExecuteNodeDeps, args: ReviewNodeArgs): Promise<ReviewNodeResult> {
  const { db } = deps;
  const profile = await deps.resolveProfile(args.agent ?? 'team');
  const session = await db.sessions.create(
    `[workflow-review] ${args.node.id}`,
    profile.id,
    args.run.user_id,
    undefined,
    'workflow',
    args.parentSessionId ?? undefined,
  );

  const prompt = [
    '你是独立评审人，仅依据下面的信息评审一个任务节点的产出（你拿不到生产过程的上下文，这是有意为之）。',
    '',
    `## 节点目标\n${args.node.brief.objective}`,
    args.node.brief.end_on ? `## 完成判据\n${args.node.brief.end_on}` : '',
    args.criteria ? `## 评审标准\n${args.criteria}` : '',
    `## 待评审产出\n\`\`\`json\n${JSON.stringify(args.outputs, null, 2)}\n\`\`\``,
    '',
    '严格评审后，最后以 fenced JSON 输出：```json\n{"pass": true|false, "feedback": "不通过时给出具体、可执行的修改意见"}\n```',
  ]
    .filter(Boolean)
    .join('\n');

  await db.sessions.addMessage({ session_id: session.id, role: 'user', content: prompt });
  const result = await runAgentInSession({
    db: db as never,
    sessionId: session.id,
    system: deps.enrichSystem ? deps.enrichSystem(profile) : profile.system_prompt,
    prompt,
    modelConfig: profile.model,
    maxSteps: 3,
    toolChoice: 'none',
    abortSignal: args.abortSignal,
    generate: deps.generate,
    usageContext: { profileId: profile.id, userId: args.run.user_id, caller: 'workflow-review' },
  });

  const tokens = (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0);
  const verdict = parseNodeOutput(result.text);
  if (!verdict || typeof verdict.pass !== 'boolean') {
    // Unparseable verdict = do not block the run on a broken reviewer.
    return { pass: true, feedback: 'reviewer verdict unparseable — treated as pass', tokens };
  }
  return { pass: verdict.pass, feedback: typeof verdict.feedback === 'string' ? verdict.feedback : undefined, tokens };
}

// ─── Prompt assembly & output parsing (pure, unit-tested) ──

export function buildNodePrompt(
  node: WorkflowNode,
  resolvedInputs: Record<string, unknown>,
  feedback?: string,
): string {
  const parts: string[] = [`## 任务目标\n${node.brief.objective}`];

  const entries = Object.entries(resolvedInputs);
  if (entries.length > 0) {
    const lines = entries.map(([k, v]) => `- ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
    parts.push(`## 输入\n${lines.join('\n')}`);
  }
  if (node.brief.boundaries) parts.push(`## 边界与约束\n${node.brief.boundaries}`);
  if (node.brief.end_on) parts.push(`## 完成判据\n${node.brief.end_on}`);

  if (node.brief.output_schema) {
    const fields = Object.entries(node.brief.output_schema)
      .map(([k, t]) => `  "${k}": <${t}>`)
      .join(',\n');
    parts.push(
      `## 输出要求\n完成后必须在回答末尾输出一个 fenced JSON 代码块，且只含以下字段：\n\`\`\`json\n{\n${fields}\n}\n\`\`\``,
    );
  } else {
    parts.push('## 输出要求\n完成后给出结论文本；如有结构化结果，用 fenced JSON 代码块给出。');
  }

  if (feedback) parts.push(`## 上一轮评审反馈（必须逐条解决）\n${feedback}`);

  return parts.join('\n\n');
}

function buildRepairPrompt(node: WorkflowNode, problems: string[]): string {
  const fields = Object.entries(node.brief.output_schema ?? {})
    .map(([k, t]) => `"${k}": <${t}>`)
    .join(', ');
  return `你的上一条回答缺少合法的结构化输出（${problems.join('；')}）。请不要重复分析，直接只输出一个 fenced JSON 代码块：\`\`\`json\n{ ${fields} }\n\`\`\``;
}

/** Extract the LAST fenced JSON object (or a bare JSON body) from model text. */
export function parseNodeOutput(text: string): Record<string, unknown> | null {
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  const candidates = fences.length > 0 ? [fences[fences.length - 1]![1]!] : [text];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim());
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // fall through
    }
  }
  return null;
}

/** Type-check outputs against the simplified schema map; [] = ok. */
export function checkOutputSchema(
  outputs: Record<string, unknown>,
  schema: Record<string, 'string' | 'number' | 'boolean' | 'array' | 'object' | 'any'>,
): string[] {
  const errors: string[] = [];
  for (const [field, type] of Object.entries(schema)) {
    const value = outputs[field];
    if (value === undefined) {
      errors.push(`missing field ${field}`);
      continue;
    }
    const ok =
      type === 'any' ||
      (type === 'array' && Array.isArray(value)) ||
      (type === 'object' && typeof value === 'object' && value !== null && !Array.isArray(value)) ||
      (type !== 'array' && type !== 'object' && typeof value === type);
    if (!ok) errors.push(`field ${field} should be ${type}`);
  }
  return errors;
}

function extractOutputs(
  text: string,
  node: WorkflowNode,
): { outputs: Record<string, unknown> | null; problems: string[] } {
  const parsed = parseNodeOutput(text);
  if (!node.brief.output_schema) {
    return { outputs: parsed ?? { text }, problems: [] };
  }
  if (!parsed) return { outputs: null, problems: ['no fenced JSON found'] };
  const problems = checkOutputSchema(parsed, node.brief.output_schema);
  return problems.length > 0 ? { outputs: null, problems } : { outputs: parsed, problems: [] };
}
