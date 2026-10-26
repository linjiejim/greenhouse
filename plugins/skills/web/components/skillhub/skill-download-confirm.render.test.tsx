import { registerExtensionMessages } from '../../../../../apps/web/src/lib/i18n/index.js';
import en from '../../messages/en.js';
import zh from '../../messages/zh.js';
registerExtensionMessages('skills', { en, zh });
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../../../../apps/web/src/lib/i18n/index.js';
import { SkillDownloadConfirm } from './skill-download-confirm.js';

describe('SkillDownloadConfirm', () => {
  it('explains that the complete versioned package will be downloaded as ZIP', () => {
    const html = renderToStaticMarkup(
      createElement(I18nProvider, {
        initialLocale: 'en',
        children: createElement(SkillDownloadConfirm, {
          target: { name: 'acme-example', displayName: 'Example Skill', version: '1.2.3' },
          onClose: vi.fn(),
        }),
      }),
    );

    expect(html).toContain('Download Example Skill?');
    expect(html).toContain('complete v1.2.3 skill package as a ZIP');
    expect(html).toContain('SKILL.md');
    expect(html).toContain('Download ZIP');
  });

  it('renders nothing without a selected skill', () => {
    const html = renderToStaticMarkup(
      createElement(I18nProvider, {
        initialLocale: 'en',
        children: createElement(SkillDownloadConfirm, { target: null, onClose: vi.fn() }),
      }),
    );
    expect(html).toBe('');
  });
});
