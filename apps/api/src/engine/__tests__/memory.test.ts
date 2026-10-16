import { describe, expect, it, vi } from 'vitest';
import type { AgentsService } from '../../modules/agents/service.js';
import type { ToolContext } from '../tools/define.js';
import { memoryTool } from '../tools/memory.js';
import { failureSummary } from '../tools/presentation.js';

describe('memory write protection', () => {
  const writes = [
    { action: 'remember', title: 'Outside instructions' },
    { action: 'update', id: 'memory', content: 'Outside instructions' },
    { action: 'forget', id: 'memory' },
  ] as const;

  it.each(writes)('refuses $action with an actionable stable error before any service write', async (args) => {
    const agents = { remember: vi.fn(), updateMemory: vi.fn(), forget: vi.fn() };
    const tool = memoryTool(agents as unknown as AgentsService);
    for (const surface of ['turn', 'background'] as const) {
      const ctx = { surface, tainted: () => true, locale: 'en', conversation: null } as unknown as ToolContext;
      const code = surface === 'background' ? 'memory_background_read_only' : 'memory_untrusted_content';
      const error = await tool.execute(tool.input.parse(args), ctx).catch((error: unknown) => error);
      expect(error).toMatchObject({ status: 403, code, message: expect.stringContaining('Do not retry') });
      for (const locale of ['zh', 'en'] as const) {
        const summary = failureSummary(tool, args, error, { locale, conversation: null });
        expect(summary).toContain(locale === 'zh' ? '请勿重试' : 'Do not retry');
        expect(summary).toContain(
          surface === 'background'
            ? locale === 'zh'
              ? '后台运行'
              : 'Background runs'
            : locale === 'zh'
              ? '外部内容'
              : 'outside content',
        );
        expect(summary).not.toContain('try again later');
      }
    }
    for (const write of Object.values(agents)) expect(write).not.toHaveBeenCalled();
  });

  it('still allows recall in tainted background runs within the member and Agent partition', async () => {
    const agents = {
      memories: vi.fn(async () => [{ id: 'memory', title: 'Preference', content: 'Tea', category: 'fact' }]),
    };
    const tool = memoryTool(agents as unknown as AgentsService);
    const ctx = {
      surface: 'background',
      tainted: () => true,
      memberId: 'member',
      agent: { id: 'agent' },
    } as unknown as ToolContext;
    expect(await tool.execute(tool.input.parse({ action: 'recall', id: 'memory' }), ctx)).toMatchObject({
      results: [{ id: 'memory', content: 'Tea' }],
    });
    expect(agents.memories).toHaveBeenCalledWith('member', 'agent', 'active');
  });
});
