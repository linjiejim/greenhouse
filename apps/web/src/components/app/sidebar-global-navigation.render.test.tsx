import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { MessageCircle } from '../../lib/icons';
import { I18nProvider } from '../../lib/i18n';
import type { PrimaryNavigation } from '../../platform/navigation';
import { SidebarGlobalNavigation } from './sidebar-global-navigation';

const navigation: PrimaryNavigation = {
  primary: [
    { key: 'chat', label: 'Chat', icon: MessageCircle, href: '#/chat' },
    { key: 'bots', label: 'Bots', icon: MessageCircle, href: '#/bots', badge: 2 },
    { key: 'knowledge', label: 'Knowledge', icon: MessageCircle, href: '#/knowledge' },
    { key: 'projects', label: 'Projects', icon: MessageCircle, href: '#/projects' },
    { key: 'crm', label: 'CRM', icon: MessageCircle, href: '#/crm' },
  ],
  overflow: [
    { key: 'skillhub', label: 'SkillHub', icon: MessageCircle, href: '#/skillhub' },
    { key: 'tables', label: 'Tables', icon: MessageCircle, href: '#/tables' },
  ],
};

function render(route = 'chat', compact = false) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <SidebarGlobalNavigation
        navigation={navigation}
        route={route}
        chatWorkspaceView="conversation"
        onSelectChatWorkspace={vi.fn()}
        defaultMoreOpen
        compact={compact}
      />
    </I18nProvider>,
  );
}

describe('SidebarGlobalNavigation', () => {
  it('keeps primary destinations visible before More', () => {
    const html = render();

    expect(html.indexOf('Chat')).toBeLessThan(html.indexOf('Bots'));
    expect(html.indexOf('Bots')).toBeLessThan(html.indexOf('Knowledge'));
    expect(html.indexOf('Knowledge')).toBeLessThan(html.indexOf('Projects'));
    expect(html.indexOf('Projects')).toBeLessThan(html.indexOf('CRM'));
    expect(html.indexOf('CRM')).toBeLessThan(html.indexOf('More'));
    expect(html).toContain('md:min-h-8');
    expect(html).toMatch(/href="#\/chat"[^>]*aria-current="page"[^>]*class="[^"]*sidebar-active-item/);
    expect(html).toMatch(/href="#\/chat"[^>]*class="[^"]*font-semibold/);
  });

  it('marks Bots active on its own route and shows the pending "needs you" badge', () => {
    const html = render('bots');

    expect(html).toMatch(/href="#\/bots"[^>]*aria-current="page"[^>]*class="[^"]*sidebar-active-item/);
    expect(html).not.toMatch(/href="#\/chat"[^>]*aria-current="page"/);
    expect(html).toMatch(/href="#\/bots"[\s\S]*?>2<\/span>/);
  });

  it('names the collapsed Bots link with what its badge counts, not just the number', () => {
    const html = render('chat', true);
    expect(html).toMatch(/href="#\/bots"[^>]*aria-label="Bots, 2 waiting for you"/);
    // The visual number is hidden from assistive tech (the name already carries it).
    expect(html).toMatch(/<span aria-hidden="true"[^>]*>2<\/span>/);
  });

  it('moves Automation, Tasks, and My Agents into More with overflow applications', () => {
    const html = render('tasks');

    expect(html.indexOf('More')).toBeLessThan(html.indexOf('Automation'));
    expect(html.indexOf('Tasks')).toBeLessThan(html.indexOf('Automation'));
    expect(html.indexOf('Automation')).toBeLessThan(html.indexOf('My Agents'));
    expect(html).toContain('SkillHub');
    expect(html).toContain('Tables');
    expect(html).toContain('href="#/automations"');
    expect(html).toContain('href="#/tasks"');
    expect(html).toContain('href="#/agents"');
    expect(html).toMatch(/aria-haspopup="menu"[^>]*aria-expanded="true"[^>]*aria-current="page"/);
    expect(html).toMatch(/href="#\/tasks"[^>]*aria-current="page"/);
    expect(html).toMatch(/role="menu"[^>]*class="[^"]*pl-1/);
  });
});
