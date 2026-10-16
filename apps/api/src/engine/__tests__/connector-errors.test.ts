import { expect, it, vi } from 'vitest';
import { connectorTool } from '../tools/connectors.js';
import { failureSummary } from '../tools/presentation.js';
import type { ConnectorsService } from '../../modules/connectors/service.js';
import type { ToolContext } from '../tools/define.js';

it.each([
  ['403 forbidden secret-value', 'connector_permission_denied', '检查连接权限', 'connection permissions'],
  ['404 not found secret-value', 'connector_item_missing', '不存在', 'not found'],
  ['429 rate limited secret-value', 'connector_rate_limited', '过于频繁', 'rate limited'],
  ['request timed out secret-value', 'connector_timeout', '超时', 'timed out'],
  ['unrecognized secret-value', 'connector_action_failed', '检查输入', 'check the input'],
])('records a reported connector error as a failed step without echoing its body', async (text, code, zh, en) => {
  const connectors = {
    findTool: vi.fn(async () => ({
      connector: { id: 'cnr_sample', slug: 'sample', name: 'Sample' },
      tool: { name: 'read', readOnly: true },
    })),
    run: vi.fn(async () => ({ isError: true, text })),
  } as unknown as ConnectorsService;
  const tool = connectorTool(connectors);
  const args = tool.input.parse({ action: 'call', connector: 'sample', tool: 'read' });
  const ctx = {
    memberId: 'member',
    manifest: {},
    signal: AbortSignal.timeout(1000),
    approved: true,
  } as unknown as ToolContext;
  const error = await tool.execute(args, ctx).catch((error: unknown) => error);
  expect(error).toMatchObject({ code });
  for (const locale of ['zh', 'en'] as const) {
    const summary = failureSummary(tool, args, error, { locale, conversation: null });
    expect(summary).toContain(locale === 'zh' ? zh : en);
    expect(summary).not.toContain('secret-value');
  }
});
