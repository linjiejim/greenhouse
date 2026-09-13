/**
 * Home 工作台求值内核 —— 「按当前用户身份执行一条存下来的只读查询」的唯一实现。
 *
 * 两个消费者共用它：批量求值端点（routes/workbench.ts，一次刷十张卡）与
 * workbench 工具对（模型建卡后立刻试算一次，看得见数据才算建成）。权限链因此
 * 只有一份——resolveUserTools ∩ WORKBENCH_READ_TOOL_IDS——不会一边收紧一边漏。
 *
 * 刻意**不**经 /api/agent/tools/:id/call：那条面的限流按单次工具调用设计（30rpm），
 * 一页十张卡刷新两次就穿了；也**不做** profile 交集——工作台是用户身份的数据视图，
 * 不是某个聊天 profile 的会话。
 */

import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import {
  expandDateTokens,
  navEntitySource,
  readPath,
  type NavTarget,
  type ToolSource,
  type WorkbenchNavResolution,
  type WorkbenchQueryFailure,
} from '@greenhouse/types/workbench';
import type { ToolRegistry } from '../agent.js';
import { executeProxyTool, ProxyToolError } from '../agent-runtime/tool-proxy.js';

export type SourceOutcome = { ok: true; data: unknown } | { ok: false; error: WorkbenchQueryFailure; message?: string };

/**
 * A tool answering `{ error }` did not fail the request — it refused the call.
 * Surfacing that as a card-level failure keeps a stale saved query from
 * rendering as an empty-but-fine card.
 */
function toolRefusal(value: unknown): string | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const error = (value as Record<string, unknown>).error;
    if (typeof error === 'string' && error.trim()) return error;
  }
  return null;
}

/**
 * First readable name across the shapes the nav resolver tools return.
 *
 * Each tool wraps its record differently (`{company:{name}}`, `{project:{name}}`,
 * a bare document…), and none of them is going to converge on one envelope for
 * this feature's benefit — so the reader knows all of them and the card falls
 * back to its own title when none match.
 */
function pickTitle(data: unknown): string | undefined {
  for (const path of [
    'title',
    'name',
    'company_name',
    'company.name',
    'project.name',
    'lead.company_name',
    'document.title',
    'doc.title',
    'record.name',
  ]) {
    const value = readPath(data, path);
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

export interface WorkbenchEvaluator {
  /** Read-only tools this user may bind a card to, right now. */
  readonly readableToolIds: string[];
  evaluateSource(source: ToolSource): Promise<SourceOutcome>;
  evaluateNavTarget(target: NavTarget): Promise<WorkbenchNavResolution>;
}

export interface WorkbenchEvaluatorParams {
  userId: string;
  /** Static registry merged with this user's lazy server tools. */
  registry: ToolRegistry;
  /** Already narrowed to `allowedTools ∩ WORKBENCH_READ_TOOL_IDS` by the caller. */
  readableToolIds: string[];
  /** Shared by every card in one refresh so relative windows agree. */
  today?: Date;
}

export function createWorkbenchEvaluator({
  registry,
  readableToolIds,
  today = new Date(),
}: WorkbenchEvaluatorParams): WorkbenchEvaluator {
  const readable = new Set(readableToolIds);
  // Identical cards in one batch share the same in-flight promise. The map is
  // request/evaluator scoped: it removes duplicate upstream work without ever
  // carrying a result across a refresh or an ACL change.
  const outcomes = new Map<string, Promise<SourceOutcome>>();

  async function evaluateSource(source: ToolSource): Promise<SourceOutcome> {
    if (!readable.has(source.toolId)) return { ok: false, error: 'forbidden' };
    const input = expandDateTokens(source.input, today);
    const key = `${source.toolId}::${JSON.stringify(input)}`;
    const existing = outcomes.get(key);
    if (existing) return existing;
    const outcome = (async (): Promise<SourceOutcome> => {
      try {
        const data = await executeProxyTool(registry, source.toolId, readableToolIds, input);
        const refusal = toolRefusal(data);
        if (refusal) return { ok: false, error: 'failed', message: refusal };
        return { ok: true, data };
      } catch (err) {
        if (err instanceof ProxyToolError) {
          return {
            ok: false,
            error: err.status === 403 ? 'forbidden' : err.status === 404 ? 'not_found' : 'invalid',
            message: err.message,
          };
        }
        logger.warn('[workbench] source evaluation failed', { toolId: source.toolId, error: toErrorMessage(err) });
        return { ok: false, error: 'failed', message: toErrorMessage(err) };
      }
    })();
    outcomes.set(key, outcome);
    return outcome;
  }

  /**
   * Navigation cards resolve through the same tool surface as data cards, so
   * "may this user still open it" has exactly one implementation. App targets
   * need no round trip — the catalog the browser already holds is
   * authoritative — so they resolve as allowed and the client greys out any app
   * missing from it.
   */
  async function evaluateNavTarget(target: NavTarget): Promise<WorkbenchNavResolution> {
    if (target.type === 'app') return { exists: true, allowed: true };
    const source = navEntitySource(target.ref);
    if (!source) return { exists: false, allowed: false };
    const outcome = await evaluateSource(source);
    if (!outcome.ok) {
      // Forbidden means the record may well exist — say nothing about it.
      // Anything else is treated as "gone" so the card greys out rather than
      // linking somewhere that will 404.
      return outcome.error === 'forbidden' ? { exists: true, allowed: false } : { exists: false, allowed: true };
    }
    const title = pickTitle(outcome.data);
    return { exists: true, allowed: true, ...(title ? { title } : {}) };
  }

  return { readableToolIds, evaluateSource, evaluateNavTarget };
}
