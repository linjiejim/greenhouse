import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PlantWork } from '@greenhouse/ui/components/plant-avatar';
import { I18nProvider } from '../../lib/i18n';
import { AssistantPresence } from './assistant-presence';

const render = (work: PlantWork, showThinkingLabel = false) =>
  renderToStaticMarkup(
    createElement(I18nProvider, {
      initialLocale: 'en',
      children: createElement(AssistantPresence, { avatar: null, stableId: 'sprouty', work, showThinkingLabel }),
    }),
  );

describe('AssistantPresence', () => {
  it('renders nothing while the conversation is idle', () => {
    expect(render({})).toBe('');
  });

  it('follows the turn: thinking, speaking, waiting, error', () => {
    expect(render({ streaming: true })).toContain('data-state="thinking"');
    expect(render({ streaming: true, hasText: true })).toContain('data-state="speaking"');
    expect(render({ streaming: true, hasText: true, toolRunning: true })).toContain('data-state="thinking"');
    expect(render({ waiting: true })).toContain('data-state="waiting"');
    expect(render({ failed: true })).toContain('data-state="error"');
  });

  it('captions only the empty thinking phase', () => {
    expect(render({ streaming: true }, true)).toContain('Thinking');
    expect(render({ streaming: true, hasText: true }, true)).not.toContain('Thinking');
  });
});
