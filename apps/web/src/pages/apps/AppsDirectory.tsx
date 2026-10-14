import { LayoutGrid } from 'lucide-react';
import { Button } from '@greenhouse/ui/kit';
import { useApps } from '../../data/apps';
import { useT } from '../../lib/i18n';
import { href, type Route } from '../../lib/router';
import { DirectoryRow } from '../../shell/DirectoryRow';
export function AppsDirectory({ route, query }: { route: Route; query: string }) {
  const t = useT();
  const apps = useApps();
  return (
    <>
      <DirectoryRow title={t('apps.all')} href="#/apps" active={route.page === 'apps'} />
      {apps.items
        .filter((a) => a.name.toLowerCase().includes(query.toLowerCase()))
        .map((app) => (
          <DirectoryRow
            key={app.id}
            title={app.name}
            leading={<LayoutGrid size={20} />}
            href={href(app.status === 'draft' ? { page: 'app-edit', id: app.id } : { page: 'app', id: app.id })}
            active={'id' in route && route.id === app.id}
          />
        ))}
      {apps.hasNextPage && (
        <Button size="sm" onClick={() => void apps.fetchNextPage()}>
          {t('knowledge.showMore')}
        </Button>
      )}
    </>
  );
}
