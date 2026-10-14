import { useSession } from '../app/session';
import type { Route } from '../lib/router';
import { AdminPage } from '../pages/admin/AdminPage';
import { AgentPage } from '../pages/agents/AgentPage';
import { AgentsPage } from '../pages/agents/AgentsPage';
import { ConversationPage } from '../pages/conversation/ConversationPage';
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

/** The page for the route. Admin pages need an admin. */
export function Workspace({ route }: { route: Route }) {
  const { me } = useSession();
  switch (route.page) {
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
