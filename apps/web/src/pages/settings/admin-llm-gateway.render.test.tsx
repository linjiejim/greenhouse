import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../../lib/i18n';
import { LlmGatewayAdminPanel } from './admin-llm-gateway';

describe('LlmGatewayAdminPanel', () => {
  it('separates models and gateway keys while presenting the model catalog as a table', () => {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <LlmGatewayAdminPanel />
      </I18nProvider>,
    );

    expect(html).toContain('aria-label="AI Gateway sections"');
    expect(html.match(/role="tab"/g)).toHaveLength(2);
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('>Model</button>');
    expect(html).toContain('>Gateway Keys</button>');
    expect(html).toContain('role="tabpanel"');
    expect(html).toContain('<table');
    expect(html).toContain('>Flags</th>');
    expect(html).toContain('>Providers</th>');
    expect(html).toContain('>Status</th>');
  });
});
