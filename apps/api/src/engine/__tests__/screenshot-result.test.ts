import { expect, it, vi } from 'vitest';
import { browserTool } from '../tools/browser.js';
import type { BrowserService } from '../../modules/computers/browser.js';
import type { ToolContext } from '../tools/define.js';

it('keeps the attachment id server-side and gives the model its display name', async () => {
  const act = vi.fn().mockResolvedValue({
    url: 'https://example.com',
    file_id: 'fil_private',
    note: 'The member can see the screenshot attached to your reply.',
  });
  const tool = browserTool({ act } as unknown as BrowserService, {} as never);
  const result = await tool.execute({ action: 'screenshot' }, {
    locale: 'zh',
    agent: { id: 'agt_test' },
  } as ToolContext);
  expect(result).toEqual({
    url: 'https://example.com',
    file_name: '截图.jpg',
    note: expect.stringContaining('member can see'),
  });
  expect(JSON.stringify(result)).not.toContain('fil_');
  act.mockResolvedValueOnce({ text: 'Some page', url: 'https://example.com' });
  expect(await tool.execute({ action: 'read' }, { agent: { id: 'agt_test' } } as ToolContext)).toEqual({
    text: 'Some page',
    url: 'https://example.com',
  });
});
