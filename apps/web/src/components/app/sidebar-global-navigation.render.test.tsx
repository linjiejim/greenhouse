import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { MessageCircle } from '../../lib/icons';
import { I18nProvider } from '../../lib/i18n';
import type { PrimaryNavigation } from '../../platform/navigation';
import { SidebarGlobalNavigation } from './sidebar-global-navigation';

const navigation: PrimaryNavigation = {
  primary: [
    { key: 'chat', label: 'Chat', icon: MessageCircle, href: '#/chat' },
    { key: 'knowledge', label: 'Knowledge', icon: MessageCircle, href: '#/knowledge' },
    { key: 'projects', label: 'Projects', icon: MessageCircle, href: '#/projects' },
    { key: 'crm', label: 'CRM', icon: MessageCircle, href: '#/crm' },
  ],
  overflow: [
    { key: 'skillhub', label: 'SkillHub', icon: MessageCircle, href: '#/skillhub' },
    { key: 'tables', label: 'Tables', icon: MessageCircle, href: '#/tables' },
  ],
};

function render(route = 'chat') {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <SidebarGlobalNavigation
        navigation={navigation}
        route={route}
        chatWorkspaceView="conversation"
        onSelectChatWorkspace={vi.fn()}
        defaultMoreOpen
      />
    </I18nProvider>,
  );
}

describe('SidebarGlobalNavigation', () => {
  it('keeps primary destinations visible before More', () => {
    const html = render();

    expect(html.indexOf('Chat')).toBeLessThan(html.indexOf('Knowledge'));
    expect(html.indexOf('Knowledge')).toBeLessThan(html.indexOf('Projects'));
    expect(html.indexOf('Projects')).toBeLessThan(html.indexOf('CRM'));
    expect(html.indexOf('CRM')).toBeLessThan(html.indexOf('More'));
    expect(html).toContain('md:min-h-8');
    expect(html).toMatch(/href="#\/chat"[^>]*aria-current="page"[^>]*class="[^"]*sidebar-active-item/);
    expect(html).toMatch(/href="#\/chat"[^>]*class="[^"]*font-semibold/);
  });

  it('keeps only overflow applications under More — automations, prompts and run profiles live elsewhere', () => {
    const html = render('tables');

    expect(html.indexOf('More')).toBeLessThan(html.indexOf('SkillHub'));
    expect(html).toContain('Tables');
    expect(html).not.toContain('href="#/automations"');
    expect(html).not.toContain('href="#/tasks"');
    expect(html).not.toContain('href="#/agents"');
    expect(html).toMatch(/aria-haspopup="menu"[^>]*aria-expanded="true"[^>]*aria-current="page"/);
    expect(html).toMatch(/href="#\/tables"[^>]*aria-current="page"/);
    expect(html).toMatch(/role="menu"[^>]*class="[^"]*pl-1/);
  });

  it('draws no More at all when nothing would be in it', () => {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <SidebarGlobalNavigation
          navigation={{ primary: navigation.primary, overflow: [] }}
          route="chat"
          chatWorkspaceView="conversation"
          onSelectChatWorkspace={vi.fn()}
        />
      </I18nProvider>,
    );
    expect(html).not.toContain('aria-haspopup="menu"');
  });
});
