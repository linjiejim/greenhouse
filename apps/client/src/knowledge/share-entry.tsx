/**
 * Opening a document's sharing: on the phone a sheet stacked on the document's
 * (app/doc-share.tsx); the browser opens a dialog instead (share-entry.web.tsx).
 */
import type React from 'react';
import { useRouter } from 'expo-router';

export function useShareEntry(): { open: (docId: string) => void; dialog: React.ReactNode } {
  const router = useRouter();
  return { open: (id) => router.push({ pathname: '/doc-share', params: { id } }), dialog: null };
}
