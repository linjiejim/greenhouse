import { lazy, Suspense } from 'react';
import { Skeleton } from '@greenhouse/ui/kit';
import { useT } from '../lib/i18n';
import { ExtensionPage } from '../extensions/host';
import { MODULES, moduleOf } from './modules';
import { Page, PageHeader } from './Page';
import { useSession } from '../app/session';
import type { Route } from '../lib/router';
import { NotFoundPage } from '../pages/NotFoundPage';

const AppsHome = lazy(() => import('../pages/apps/AppsHome').then((module) => ({ default: module.AppsHome })));
const AppBuilder = lazy(() => import('../pages/apps/AppBuilder').then((module) => ({ default: module.AppBuilder })));
const AppRuntime = lazy(() => import('../pages/apps/AppRuntime').then((module) => ({ default: module.AppRuntime })));
const AdminPage = lazy(() => import('../pages/admin/AdminPage').then((module) => ({ default: module.AdminPage })));
const AgentPage = lazy(() => import('../pages/agents/AgentPage').then((module) => ({ default: module.AgentPage })));
const AgentsPage = lazy(() => import('../pages/agents/AgentsPage').then((module) => ({ default: module.AgentsPage })));
const ConversationPage = lazy(() =>
  import('../pages/conversation/ConversationPage').then((module) => ({ default: module.ConversationPage })),
);
const ArchivedPage = lazy(() =>
  import('../pages/knowledge/ArchivedPage').then((module) => ({ default: module.ArchivedPage })),
);
const DocPage = lazy(() => import('../pages/knowledge/DocPage').then((module) => ({ default: module.DocPage })));
const FolderPage = lazy(() =>
  import('../pages/knowledge/FolderPage').then((module) => ({ default: module.FolderPage })),
);
const KnowledgeHome = lazy(() =>
  import('../pages/knowledge/KnowledgeHome').then((module) => ({ default: module.KnowledgeHome })),
);
const NotificationsPage = lazy(() =>
  import('../pages/notifications/NotificationsPage').then((module) => ({ default: module.NotificationsPage })),
);
const RunPage = lazy(() => import('../pages/runs/RunPage').then((module) => ({ default: module.RunPage })));
const RunsPage = lazy(() => import('../pages/runs/RunsPage').then((module) => ({ default: module.RunsPage })));
const SettingsPage = lazy(() =>
  import('../pages/settings/SettingsPage').then((module) => ({ default: module.SettingsPage })),
);
const SkillPage = lazy(() => import('../pages/skills/SkillPage').then((module) => ({ default: module.SkillPage })));
const SkillsPage = lazy(() => import('../pages/skills/SkillsPage').then((module) => ({ default: module.SkillsPage })));
const BasePage = lazy(() => import('../pages/tables/BasePage').then((module) => ({ default: module.BasePage })));
const FormPage = lazy(() => import('../pages/tables/forms/FormPage').then((module) => ({ default: module.FormPage })));
const TablesHome = lazy(() => import('../pages/tables/TablesHome').then((module) => ({ default: module.TablesHome })));

function LoadingPage({ route }: { route: Route }) {
  const t = useT();
  return (
    <Page
      header={<PageHeader title={t(MODULES[moduleOf(route)].label)} />}
      width={route.page === 'doc' ? 'reading' : 'list'}
    >
      <div role="status" aria-label={t('common.loading')}>
        <Skeleton lines={8} />
      </div>
    </Page>
  );
}

export function Workspace({ route }: { route: Route }) {
  return (
    <Suspense fallback={<LoadingPage route={route} />}>
      <WorkspacePage route={route} />
    </Suspense>
  );
}

/** The page for the route. Admin pages need an admin; the knowledge base needs its module. */
function WorkspacePage({ route }: { route: Route }) {
  const { me } = useSession();
  const knowledge = !!me?.modules.knowledge;
  switch (route.page) {
    case 'extension':
    case 'extension-section':
      return <ExtensionPage route={route} />;
    case 'knowledge':
      if (!knowledge) return <NotFoundPage />;
      if (route.space && route.archived && route.space !== 'shared') return <ArchivedPage space={route.space} />;
      if (route.space) return <FolderPage key={route.space} folderId={null} space={route.space} file={route.file} />;
      return <KnowledgeHome />;
    case 'folder':
      return knowledge ? <FolderPage key={route.id} folderId={route.id} file={route.file} /> : <NotFoundPage />;
    case 'doc':
      return knowledge ? <DocPage key={route.id} id={route.id} edit={!!route.edit} /> : <NotFoundPage />;
    case 'conversation':
      return (
        <ConversationPage
          key={route.id}
          id={route.id}
          agent={route.agent}
          skill={route.skill}
          request={route.request}
        />
      );
    case 'agents':
      return <AgentsPage scope={route.scope} />;
    case 'agent':
      return <AgentPage key={route.id} id={route.id} tab={route.tab} />;
    case 'skills':
      return <SkillsPage scope={route.scope} />;
    case 'skill':
      return <SkillPage key={route.id} id={route.id} />;
    case 'apps':
      return me?.modules.apps ? <AppsHome newApp={route.newApp} /> : <NotFoundPage />;
    case 'app':
      return me?.modules.apps ? <AppRuntime id={route.id} pageId={route.appPage} /> : <NotFoundPage />;
    case 'app-edit':
      return me?.modules.apps ? <AppBuilder id={route.id} /> : <NotFoundPage />;
    case 'tables':
      return me?.modules.tables ? <TablesHome /> : <NotFoundPage />;
    case 'base':
      return me?.modules.tables ? (
        <BasePage
          key={route.id}
          id={route.id}
          table={route.table}
          view={route.view}
          record={route.record}
          dashboard={route.dashboard}
        />
      ) : (
        <NotFoundPage />
      );
    case 'form':
      return <FormPage key={route.id} id={route.id} />;
    case 'runs':
      return <RunsPage view={route.view} />;
    case 'run':
      return <RunPage key={route.id} id={route.id} />;
    case 'notifications':
      return <NotificationsPage />;
    case 'settings':
      return <SettingsPage section={route.section} />;
    case 'admin':
      return me?.role === 'admin' ? <AdminPage section={route.section} /> : <NotFoundPage />;
    case 'activate':
    case 'consent':
    case 'not-found':
      return <NotFoundPage />;
  }
}
