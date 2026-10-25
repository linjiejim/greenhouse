import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { MessageCircle } from '../../lib/icons';
import { I18nProvider } from '../../lib/i18n';
import type { PrimaryNavigation } from '../../platform/navigation';
import { SidebarGlobalNavigation } from './sidebar-global-navigation';

const navigation: PrimaryNavigation = {
  primary: [
    { key: 'files', label: 'Files', icon: MessageCircle, href: '#/files' },
    { key: 'knowledge', label: 'Knowledge', icon: MessageCircle, href: '#/knowledge' },
    { key: 'projects', label: 'Projects', icon: MessageCircle, href: '#/projects' },
    { key: 'crm', label: 'CRM', icon: MessageCircle, href: '#/crm' },
  ],
  overflow: [
    { key: 'skillhub', label: 'SkillHub', icon: MessageCircle, href: '#/skillhub' },
    { key: 'tables', label: 'Tables', icon: MessageCircle, href: '#/tables' },
  ],
};

function render(route = 'files') {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <SidebarGlobalNavigation navigation={navigation} route={route} defaultMoreOpen />
    </I18nProvider>,
  );
}

describe('SidebarGlobalNavigation', () => {
  it('keeps primary destinations visible before More', () => {
    const html = render();

    expect(html.indexOf('Files')).toBeLessThan(html.indexOf('Knowledge'));
    expect(html.indexOf('Knowledge')).toBeLessThan(html.indexOf('Projects'));
    expect(html.indexOf('Projects')).toBeLessThan(html.indexOf('CRM'));
    expect(html.indexOf('CRM')).toBeLessThan(html.indexOf('More'));
    expect(html).toContain('md:min-h-8');
    expect(html).toMatch(/href="#\/files"[^>]*aria-current="page"[^>]*class="[^"]*sidebar-active-item/);
    expect(html).toMatch(/href="#\/files"[^>]*class="[^"]*sidebar-active-item/);
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

  it('lights exactly the item of the current page, and none on the Activity log', () => {
    const full: PrimaryNavigation = {
      primary: ['knowledge', 'files', 'tables', 'projects', 'skillhub', 'automations'].map((key) => ({
        key,
        label: key,
        icon: MessageCircle,
        href: `#/${key}`,
      })),
      overflow: [],
    };
    const markup = (route: string) =>
      renderToStaticMarkup(
        <I18nProvider initialLocale="en">
          <SidebarGlobalNavigation navigation={full} route={route} />
        </I18nProvider>,
      );
    const current = (html: string) => [...html.matchAll(/href="#\/(\w+)"[^>]*aria-current="page"/g)].map((m) => m[1]);

    for (const item of full.primary) expect(current(markup(item.key))).toEqual([item.key]);
    // `#/agents` lands on `#/automations?tab=profiles`: the route is automations.
    expect(current(markup('automations'))).toEqual(['automations']);
    expect(current(markup('activity'))).toEqual([]);
    // Home and a conversation have no item of their own (New Chat is their way in)
    expect(current(markup('chat'))).toEqual([]);
    expect(current(markup('home'))).toEqual([]);
  });

  it('draws no More at all when nothing would be in it', () => {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <SidebarGlobalNavigation navigation={{ primary: navigation.primary, overflow: [] }} route="chat" />
      </I18nProvider>,
    );
    expect(html).not.toContain('aria-haspopup="menu"');
  });
});
