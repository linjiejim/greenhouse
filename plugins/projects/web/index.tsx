import React, { lazy } from 'react';
import manifest from '../manifest.js';
import {
  defineWebExtension,
  FolderKanban,
  Edit3,
  usePlatformCatalog,
  useT,
  Spinner,
} from '@greenhouse/web/extension-kit';
import en from './messages/en.js';
import zh from './messages/zh.js';
import { ProjectsListPanel } from './sidebar.js';
import listContext from './context/project-list.js';
import detailContext from './context/project-detail.js';
const ProjectsPage = lazy(() => import('./pages/projects.js').then((m) => ({ default: m.ProjectsPage })));
const ProjectDetailPage = lazy(() =>
  import('./pages/project-detail.js').then((m) => ({ default: m.ProjectDetailPage })),
);
function Page({ subPath, params }: { subPath: string; params: URLSearchParams }) {
  const { hasApplication, loading } = usePlatformCatalog();
  const t = useT();
  if (loading) return <Spinner />;
  if (!hasApplication('projects')) return <div>{t('app.noPermission')}</div>;
  return subPath ? (
    <ProjectDetailPage projectId={subPath} initialTaskId={params.get('task') || undefined} />
  ) : (
    <ProjectsPage />
  );
}
export default defineWebExtension({
  ...manifest,
  messages: { en, zh },
  pages: [
    {
      route: 'projects',
      applicationId: 'projects',
      navigationOrder: 40,
      component: Page,
      titleKey: 'ext.projects.projects.title',
      sidebarPanel: () => <ProjectsListPanel />,
      modules: [
        {
          key: '',
          labelKey: 'ext.projects.projects.title',
          descriptionKey: 'ext.projects.navigation.projectsDesc',
          icon: FolderKanban,
        },
      ],
    },
  ],
  entitySync: { project_mutation: 'project' },
  entityKinds: [
    {
      kind: 'project',
      icon: FolderKanban,
      fallbackTitleKey: 'ext.projects.entityPeek.project',
      render: (ref) => <ProjectDetailPage projectId={String(ref.id)} />,
    },
  ],
  toolIcons: { project_query: FolderKanban, project_mutation: Edit3 },
  resolveContext: (_route, subPath) =>
    subPath ? { type: 'project-detail', projectId: subPath.split('/')[0] } : { type: 'project-list' },
  contextProviders: [listContext, detailContext],
  mcpGroups: [
    {
      id: 'projects',
      labelKey: 'ext.projects.mcpGroups.projects.label',
      descriptionKey: 'ext.projects.mcpGroups.projects.description',
    },
  ],
});
