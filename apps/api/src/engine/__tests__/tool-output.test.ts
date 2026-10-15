import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import type { FilesService } from '../../modules/files/service.js';
import { boundedMessages } from '../steps.js';
import { TOOL_OUTPUT_CHARS, toolOutputReadTool } from '../tools/output.js';
import type { ToolContext } from '../tools/define.js';

type Window = {
  file_id: string;
  offset: number;
  length: number;
  read_length: number;
  content: string;
  next_offset: number | null;
};

const context = { memberId: 'member' } as ToolContext;

function reader(text: string) {
  const row = { id: 'fil_output', purpose: 'tool_output', meta: { tool_output: { private: false } } };
  return toolOutputReadTool({
    get: async () => row,
    bytes: async () => ({ row, bytes: Buffer.from(text) }),
  } as unknown as FilesService);
}

describe('stored tool output windows', () => {
  it.each(['ordinary text', 'JSON escapes'])('pages 25k characters to the end without elision: %s', async (kind) => {
    const text = (kind === 'JSON escapes' ? '\u0001\t"\\\n😀' : 'abcdefghij').repeat(4000).slice(0, 25_000);
    const tool = reader(text);
    let offset: number | null = 0;
    let collected = '';
    while (offset !== null) {
      const args = tool.input.parse({ file_id: 'fil_output', offset });
      const result = (await tool.execute(args, context)) as Window;
      expect(result.offset).toBe(offset);
      expect(result.read_length).toBeGreaterThan(0);
      expect(result.length).toBe(25_000);
      expect(result.content).not.toContain('[cut:');
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(TOOL_OUTPUT_CHARS);
      // Check the actual persisted model boundary, including the tool call and JSON escapes.
      const messages: ModelMessage[] = [
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'read', toolName: tool.name, input: args }] },
        {
          role: 'tool',
          content: [
            { type: 'tool-result', toolCallId: 'read', toolName: tool.name, output: { type: 'json', value: result } },
          ],
        },
      ];
      expect(boundedMessages(messages)).toEqual(messages);
      collected += result.content;
      offset = result.next_offset;
    }
    expect(collected).toBe(text);
  });

  it('returns an empty terminal window when the offset exceeds the output', async () => {
    const tool = reader('tail');
    expect(await tool.execute(tool.input.parse({ file_id: 'fil_output', offset: 100 }), context)).toMatchObject({
      offset: 4,
      length: 4,
      read_length: 0,
      content: '',
      next_offset: null,
    });
  });
});
