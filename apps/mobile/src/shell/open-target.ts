/**
 * Opening an `AppTarget` (src/lib/deep-links.ts): documents, files, projects and tasks, tables and
 * records, conversations and My Agents on their native screens; any other station page in the
 * in-app Safari view at the active station, another site in Safari.
 */

import { useCallback } from 'react';
import { useRouter } from 'expo-router';
import { linkTarget, webUrl, type AppTarget } from '../lib/deep-links';
import { openLink } from '../lib/links';
import { getApiBase } from '../store/stations';
import { useTheme } from '../theme';

type Router = ReturnType<typeof useRouter>;

export function openTarget(router: Router, target: AppTarget, accent?: string): void {
  switch (target.kind) {
    case 'doc':
      router.push({ pathname: '/knowledge/doc', params: { id: String(target.id) } });
      return;
    case 'files':
      router.push({
        pathname: '/files',
        params: {
          shelf: target.shelf,
          ...(target.folderId ? { folder: String(target.folderId) } : {}),
          ...(target.fileId ? { file: String(target.fileId) } : {}),
        },
      });
      return;
    case 'project':
      if (target.id && target.taskId) {
        router.push({ pathname: '/projects/task', params: { project: String(target.id), task: String(target.taskId) } });
      } else if (target.id) router.push({ pathname: '/projects/detail', params: { id: String(target.id) } });
      else router.push('/projects');
      return;
    case 'tables':
      if (target.tableId && target.recordId) {
        router.push({
          pathname: '/tables/record',
          params: { base: String(target.baseId ?? ''), table: String(target.tableId), id: String(target.recordId) },
        });
      } else if (target.tableId) {
        router.push({ pathname: '/tables/table', params: { base: String(target.baseId ?? ''), id: String(target.tableId) } });
      } else if (target.baseId) router.push({ pathname: '/tables/base', params: { id: String(target.baseId) } });
      else router.push('/tables');
      return;
    case 'chat':
      if (target.sessionId) router.push({ pathname: '/assistant/chat', params: { session: target.sessionId } });
      else router.push('/assistant');
      return;
    case 'agent':
      router.push('/agent');
      return;
    case 'web':
      void openLink(webUrl(getApiBase(), target.hash), accent);
      return;
    case 'external':
      void openLink(target.url, accent);
  }
}

/** A link as written in content; false when it goes nowhere the app can open. */
export function useOpenHref(): (href: string) => boolean {
  const router = useRouter();
  const { hex } = useTheme();
  return useCallback(
    (href: string) => {
      if (/^(mailto|tel):/i.test(href.trim())) {
        void openLink(href.trim());
        return true;
      }
      const target = linkTarget(href, getApiBase());
      if (!target) return false;
      openTarget(router, target, hex.accent);
      return true;
    },
    [router, hex.accent],
  );
}
