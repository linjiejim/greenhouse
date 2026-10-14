import { AppsHome } from '../pages/apps/AppsHome';
import { AppBuilder } from '../pages/apps/AppBuilder';
import { AppRuntime } from '../pages/apps/AppRuntime';
import { useSession } from '../app/session';
import type { Route } from '../lib/router';
import { AdminPage } from '../pages/admin/AdminPage';
import { AgentPage } from '../pages/agents/AgentPage';
import { AgentsPage } from '../pages/agents/AgentsPage';
import { ConversationPage } from '../pages/conversation/ConversationPage';
import { ArchivedPage } from '../pages/knowledge/ArchivedPage';
import { DocPage } from '../pages/knowledge/DocPage';
import { FolderPage } from '../pages/knowledge/FolderPage';
import { KnowledgeHome } from '../pages/knowledge/KnowledgeHome';
import { NotFoundPage } from '../pages/NotFoundPage';
import { NotificationsPage } from '../pages/notifications/NotificationsPage';
import { RunPage } from '../pages/runs/RunPage';
import { RunsPage } from '../pages/runs/RunsPage';
import { SettingsPage } from '../pages/settings/SettingsPage';
import { SkillPage } from '../pages/skills/SkillPage';
import { SkillsPage } from '../pages/skills/SkillsPage';
import { BasePage } from '../pages/tables/BasePage';
import { FormPage } from '../pages/tables/forms/FormPage';
import { TablesHome } from '../pages/tables/TablesHome';

/** The page for the route. Admin pages need an admin; the knowledge base needs its module. */
export function Workspace({ route }: { route: Route }) {
  const { me } = useSession();
  const knowledge = !!me?.modules.knowledge;
  switch (route.page) {
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
      return <ConversationPage key={route.id} id={route.id} agent={route.agent} skill={route.skill} />;
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
      return <NotificationsPage view={route.view} />;
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
