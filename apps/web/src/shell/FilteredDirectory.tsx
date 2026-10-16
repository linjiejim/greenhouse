import { useQuery } from '@tanstack/react-query';
import { useAgents } from '../data/agents';
import { useSkills, scopeQuery } from '../data/skills';
import { useRuns } from '../data/runs';
import { useSchedules } from '../data/schedules';
import { useNotify } from '../app/notify';
import { errorText } from '../lib/errors';
import { api } from '../lib/api';
import { useT } from '../lib/i18n';
import { href, navigate, type Route } from '../lib/router';
import { DirectoryRow } from './DirectoryRow';

export const matchesDirectory = (query: string, ...names: string[]) =>
  names.some((name) => name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));

function Results({ items }: { items: { id: string; name: string; href?: string; open?: () => void }[] }) {
  const t = useT();
  return items.length ? (
    <>
      {items.map((item) => (
        <DirectoryRow key={item.id} title={item.name} href={item.href} onClick={item.open} />
      ))}
    </>
  ) : (
    <p className="app-muted app-directory-note" role="status">
      {t('directory.noMatch')}
    </p>
  );
}

export function FilteredAgents({ route, query }: { route: Route; query: string }) {
  const notify = useNotify();
  const t = useT();
  const scope = route.page === 'agents' ? route.scope : 'mine';
  const mine = useAgents(scope === 'archived' ? 'archived' : 'mine');
  const shared = useQuery({
    queryKey: ['agents', 'list', 'public'],
    queryFn: () => api.publication.shared(),
    enabled: scope === 'public',
  });
  const items = scope === 'public' ? (shared.data?.items ?? []) : mine.items;
  return (
    <Results
      items={items
        .filter((agent) => matchesDirectory(query, agent.name, agent.role))
        .map((agent) => ({
          id: agent.id,
          name: agent.name,
          ...(scope === 'public'
            ? {
                open: () =>
                  void api.conversations
                    .create({ kind: 'direct', agent_id: agent.id })
                    .then((conversation) => navigate({ page: 'conversation', id: conversation.id }))
                    .catch((error: unknown) => notify(errorText(error, t))),
              }
            : { href: href({ page: 'agent', id: agent.id, tab: 'profile' }) }),
        }))}
    />
  );
}

export function FilteredSkills({ route, query }: { route: Route; query: string }) {
  const skills = useSkills(scopeQuery(route.page === 'skills' ? route.scope : 'all'));
  return (
    <Results
      items={skills.items
        .filter((skill) => matchesDirectory(query, skill.name, skill.display_name || ''))
        .map((skill) => ({
          id: skill.id,
          name: skill.display_name || skill.name,
          href: href({ page: 'skill', id: skill.id }),
        }))}
    />
  );
}

export function FilteredRuns({ route, query }: { route: Route; query: string }) {
  const view = route.page === 'runs' ? route.view : 'active';
  const runs = useRuns(view === 'done' ? 'done' : 'active');
  const schedules = useSchedules();
  const items =
    view === 'scheduled'
      ? schedules.items.map((item) => ({
          id: item.id,
          name: item.name,
          href: href({ page: 'agent', id: item.agent_id, tab: 'schedules' }),
        }))
      : runs.items.map((item) => ({ id: item.id, name: item.title, href: href({ page: 'run', id: item.id }) }));
  return <Results items={items.filter((item) => matchesDirectory(query, item.name))} />;
}
