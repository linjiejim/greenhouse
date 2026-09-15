import { describe, expect, it } from 'vitest';
import { composeSelectionMessage } from './surface-actions';

describe('composeSelectionMessage', () => {
  it('uses the selected text directly when there is no extra instruction', () => {
    expect(composeSelectionMessage('  selected text  ', '  ')).toBe('selected text');
  });

  it('keeps selected content and the user instruction structurally separate', () => {
    expect(composeSelectionMessage('selected text', 'summarize it')).toBe(
      '选中内容：\nselected text\n\n用户指示：\nsummarize it',
    );
  });
});
