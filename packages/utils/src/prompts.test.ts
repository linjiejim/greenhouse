import { describe, expect, it } from 'vitest';
import { MODEL_FENCES } from '@greenhouse/types/rich-output';
import { RICH_BLOCK_GUIDES, RICH_OUTPUT_GUIDE } from './prompts.js';

describe('the rich-output guide', () => {
  it('has a section for every model-authored block, and teaches all of them in one fixed text', () => {
    for (const fence of MODEL_FENCES) {
      expect(RICH_BLOCK_GUIDES[fence], fence).toBeTruthy();
      expect(RICH_OUTPUT_GUIDE).toContain(RICH_BLOCK_GUIDES[fence]!);
    }
    expect(RICH_OUTPUT_GUIDE.indexOf('```datatable')).toBeLessThan(RICH_OUTPUT_GUIDE.indexOf('```stats'));
    expect(RICH_OUTPUT_GUIDE).toContain('块按钮（actions）');
    expect(RICH_OUTPUT_GUIDE).toContain('站内实体引用');
    expect(RICH_OUTPUT_GUIDE).toContain('未填的任务变量');
    expect(RICH_OUTPUT_GUIDE).toMatch(/数据没齐就不要开 fence/);
  });

  it('leaves which blocks a screen draws to the turn, and the preview bridge to a screen that lists it', () => {
    expect(RICH_OUTPUT_GUIDE).toContain('<turn_context> 会列出「这块屏幕能画的富块」');
    expect(RICH_OUTPUT_GUIDE).toContain('<turn_context> 列出 html-preview-bridge 时');
    expect(RICH_OUTPUT_GUIDE).toContain('window.greenhouse?.sendPrompt');
  });
});
