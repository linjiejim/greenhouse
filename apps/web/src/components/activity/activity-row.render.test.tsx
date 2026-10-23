import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ActivityItem } from '@greenhouse/types/activity';
import { I18nProvider } from '../../lib/i18n';
import { ActivityRow } from './activity-row';

function item(over: Partial<ActivityItem> = {}): ActivityItem {
  return {
    id: 'a:1',
    source: 'person',
    at: new Date().toISOString(),
    actor: { id: 'u1', name: 'Alice' },
    agent: null,
    module: 'projects',
    verb: 'update',
    entity: 'project',
    action: 'updateProject',
    action_title: 'Update project',
    target: { id: '7', label: 'Launch', url: '#/projects/7' },
    status: null,
    run: null,
    detail: null,
    ...over,
  };
}

function render(value: ActivityItem, locale: 'en' | 'zh' = 'en') {
  return renderToStaticMarkup(
    createElement(I18nProvider, { initialLocale: locale, children: createElement(ActivityRow, { item: value }) }),
  );
}

describe('ActivityRow', () => {
  it('says who did what to which object, in both languages, and links to it', () => {
    const en = render(item());
    expect(en).toContain('Alice');
    expect(en).toContain('updated project');
    expect(en).toContain('Launch');
    expect(en).toContain('href="#/projects/7"');
    expect(render(item(), 'zh')).toContain('更新了项目');
  });

  it('names the agent and opens the run behind an agent write', () => {
    const html = render(
      item({
        source: 'agent',
        agent: { client_id: 'c1', client_name: 'Claude Code' },
        module: 'files',
        verb: 'delete',
        entity: null,
        action: 'files.delete',
        target: null,
        status: 'outcome_unknown',
        run: { id: 'rtr_9', kind: 'agent_write' },
      }),
    );
    expect(html).toContain('via Claude Code');
    expect(html).toContain('deleted Files');
    expect(html).toContain('href="#/activity/agent_write/rtr_9"');
    expect(html).toContain('Outcome unknown');
  });

  it('phrases an agent write by what it did to which object, the same way Home phrases the change', () => {
    const write = item({
      source: 'agent',
      agent: { client_id: 'c1', client_name: 'Codex' },
      module: 'knowledge',
      verb: 'update',
      entity: 'document',
      action: 'knowledge.update_doc',
      action_title: null,
      target: { id: '5', label: 'Product Roadmap 2026', url: '#/knowledge/doc/5' },
      run: { id: 'rtr_1', kind: 'agent_write' },
    });
    const home = item({
      id: 'kb:9',
      source: 'agent',
      agent: { client_id: null, client_name: 'Codex' },
      module: 'knowledge',
      verb: 'update',
      entity: 'document',
      action: 'updateDocument',
      action_title: null,
      target: { id: '5', label: 'Product Roadmap 2026', url: '#/knowledge/doc/5' },
    });
    for (const value of [write, home]) {
      const html = render(value);
      expect(html).toContain('updated document');
      expect(html).not.toContain('Knowledge Product');
      expect(render(value, 'zh')).toContain('更新了文档');
    }
  });

  it('uses an action’s own phrase where verb and object would misdescribe it', () => {
    const html = render(
      item({
        module: 'mcp',
        verb: 'share',
        entity: 'oauthGrant',
        action: 'authorizeOAuthClient',
        target: { id: null, label: 'Claude Code', url: null },
      }),
    );
    expect(html).toContain('connected agent');
    expect(html).not.toContain('shared');
    expect(html).toContain('Claude Code');
  });

  it('falls back to the server title for an action without a known verb', () => {
    expect(render(item({ verb: 'other', action: 'syncThing', action_title: 'Sync thing' }))).toContain('Sync thing');
  });
});
