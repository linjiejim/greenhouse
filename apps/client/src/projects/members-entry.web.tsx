/** Opening a project's members in the browser: the dialog, rendered where `dialog` is placed. */
import React, { useState } from 'react';
import { ProjectMembersDialog } from './members-dialog.web';

export function useMembersEntry(): { open: (projectId: string) => void; dialog: React.ReactNode } {
  const [shown, setShown] = useState<string | null>(null);
  return {
    open: setShown,
    dialog: shown ? <ProjectMembersDialog projectId={shown} close={() => setShown(null)} /> : null,
  };
}
