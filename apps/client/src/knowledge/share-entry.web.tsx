/** Opening a document's sharing in the browser: the dialog, rendered where `dialog` is placed. */
import React, { useState } from 'react';
import { DocShareDialog } from './share-dialog.web';

export function useShareEntry(): { open: (docId: string) => void; dialog: React.ReactNode } {
  const [shown, setShown] = useState<string | null>(null);
  return {
    open: setShown,
    dialog: shown ? <DocShareDialog docId={shown} close={() => setShown(null)} /> : null,
  };
}
