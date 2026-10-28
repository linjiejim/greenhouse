/**
 * Opening a project's members: on the phone a sheet stacked on the project's
 * (app/project-members.tsx); the browser opens a dialog instead (members-entry.web.tsx).
 */
import type React from 'react';
import { useRouter } from 'expo-router';

export function useMembersEntry(): { open: (projectId: string) => void; dialog: React.ReactNode } {
  const router = useRouter();
  return { open: (id) => router.push({ pathname: '/project-members', params: { id } }), dialog: null };
}
