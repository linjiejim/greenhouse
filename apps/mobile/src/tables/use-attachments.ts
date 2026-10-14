import { useRef, useState } from 'react';
import { captureIdentity } from '../data/identity';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { request } from '../api/client';
import { useT } from '../lib/i18n';
import { alertError } from '../ui/dialogs';
export function useAttachments(path?: string) {
  const [files, setFiles] = useState<Record<string, { name: string; url?: string }>>({});
  const [busy, setBusy] = useState(false);
  const t = useT();
  const active = useRef(false);
  const add = async () => {
    if (!path || active.current) return null;
    active.current = true;
    const current = captureIdentity();
    let local: File | null = null;
    setBusy(true);
    try {
      const picked = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
      if (picked.canceled || !current()) return null;
      const asset = picked.assets[0];
      local = new File(asset.uri);
      if (local.size > 50 * 1024 * 1024) {
        alertError(t('work.saveFailed'));
        return null;
      }
      const body = new FormData();
      body.append('file', local);
      const result = await request<{ id: string; name: string; url?: string }>('POST', path, { body });
      if (!current()) return null;
      if (!result.ok) {
        alertError(t('work.saveFailed'), undefined, result.message);
        return null;
      }
      setFiles((old) => ({ ...old, [result.data.id]: result.data }));
      return result.data.id;
    } catch (error) {
      if (current()) alertError(t('work.saveFailed'), undefined, error instanceof Error ? error.message : undefined);
      return null;
    } finally {
      if (local?.exists) local.delete();
      active.current = false;
      if (current()) setBusy(false);
    }
  };
  return { files, busy, add };
}
