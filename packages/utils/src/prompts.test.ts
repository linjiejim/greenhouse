import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CLIENT_BLOCKS, MODEL_FENCES } from '@greenhouse/types/rich-output';
import { RICH_BLOCK_GUIDES, composeRichOutput } from './prompts.js';

const LEGACY_GUIDE = readFileSync(resolve(__dirname, '__fixtures__/rich-output-guide.default.txt'), 'utf8');

describe('composeRichOutput', () => {
  it('reproduces the pre-capability guide byte for byte for the default set', () => {
    // A request that declares nothing must not see the model's instructions
    // change under it — the refactor to per-block sections is behaviour-neutral.
    expect(composeRichOutput({ blocks: DEFAULT_CLIENT_BLOCKS })).toBe(LEGACY_GUIDE);
  });

  it('has a section for every model-authored block', () => {
    for (const fence of MODEL_FENCES) expect(RICH_BLOCK_GUIDES[fence], fence).toBeTruthy();
  });

  it('teaches only the declared blocks', () => {
    const guide = composeRichOutput({ blocks: ['chart', 'datatable', 'confirm'] });
    expect(guide).toContain('```chart');
    expect(guide).toContain('```confirm');
    expect(guide).not.toContain('```mermaid');
    expect(guide).not.toContain('html-preview');
    expect(guide).toMatch(/数据没齐就不要开 fence/);
  });

  it('teaches the business blocks and their buttons only when declared', () => {
    const guide = composeRichOutput({ blocks: ['datatable', 'stats', 'cards', 'steps'] });
    expect(guide).toContain('```stats');
    expect(guide).toContain('```cards');
    expect(guide).toContain('```steps');
    expect(guide).toContain('块按钮（actions）');
    expect(guide.indexOf('```datatable')).toBeLessThan(guide.indexOf('```stats'));
    expect(composeRichOutput({ blocks: DEFAULT_CLIENT_BLOCKS })).not.toContain('块按钮');
  });

  it('teaches the html-preview reply channel only with html-preview and the declared bridge', () => {
    expect(composeRichOutput({ blocks: ['html-preview', 'html-preview-bridge'] })).toContain(
      'window.greenhouse?.sendPrompt',
    );
    expect(composeRichOutput({ blocks: ['html-preview'] })).not.toContain('sendPrompt');
    expect(composeRichOutput({ blocks: ['html-preview-bridge'] })).not.toContain('sendPrompt');
  });

  it('keeps the always-on rules and drops the JSON discipline when no JSON block is taught', () => {
    const guide = composeRichOutput({ blocks: ['mermaid'] });
    expect(guide).toContain('站内实体引用');
    expect(guide).toContain('未填的任务变量');
    expect(guide).not.toMatch(/数据没齐就不要开 fence/);
    expect(composeRichOutput({ blocks: [] })).not.toContain('```');
  });

  it('names only what the screen can draw in its opening line', () => {
    const legacy = '渲染图表和数据表格';
    expect(composeRichOutput({ blocks: ['chart', 'datatable'] })).toContain(legacy);
    expect(composeRichOutput({ blocks: ['mermaid'] })).not.toContain(legacy);
    expect(composeRichOutput({ blocks: ['mermaid'] })).toContain('下列特殊 code block');
    expect(composeRichOutput({ blocks: ['chart'] })).not.toContain(legacy);
    const none = composeRichOutput({ blocks: [] });
    expect(none).toContain('## 富文本输出格式');
    expect(none).not.toContain('code block');
  });
});
